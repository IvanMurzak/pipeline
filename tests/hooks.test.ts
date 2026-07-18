// Command-level tests for the in-process worktree-hook execution + the
// auto-emitted per-iteration UI events in `pipeline next` (commands/next.ts +
// lib/hooks.ts).
//
// Each test builds a real temp consumer project (git repo, so the event writer
// resolves the project root to it) containing fake `worktree-create.js` /
// `worktree-destroy.js` hooks (plain JS, executed via process.execPath per the
// interpreter map — portable under bun), plus a temp pipeline root with
// `isolation: external`. runNext() is driven IN-PROCESS with cwd swapped to the
// temp project root and HOME/USERPROFILE pointed at a temp home (so daemon
// lock/mirror paths never touch the real ~/.claude) — mirroring the env/path
// patterns of tests/event.test.ts.

import { test, expect, afterEach } from 'bun:test';
import { runNext } from '../src/commands/next';
import { runHook, parseHookJson, resolveHookScript, extPreference, interpreterFor } from '../src/lib/hooks';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

/** A real git repo so the event writer's resolveProjectRoot lands on it. */
function mkGitRepo(): string {
  const root = mkTmp('hooksproj-');
  const r = spawnSync('git', ['init', '-q'], { cwd: root });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  return root;
}

// ---------------------------------------------------------------------------
// Fake hooks (plain JS — the interpreter map runs .js via process.execPath)
// ---------------------------------------------------------------------------

/** Happy-path create hook: dumps its PIPELINE_WT_* env to a file (contract
 *  assertion), logs to stderr, prints the contract JSON object on stdout. */
const CREATE_OK_HOOK = `
const fs = require('fs');
const path = require('path');
const env = {};
for (const k of Object.keys(process.env)) if (k.startsWith('PIPELINE_WT_')) env[k] = process.env[k];
fs.writeFileSync(path.join(process.cwd(), 'create-env-dump.json'), JSON.stringify(env));
process.stderr.write('provisioning (stderr noise)...\\n');
const wt = path.join(process.cwd(), '.claude', 'worktrees', process.env.PIPELINE_WT_NAME || 'unnamed');
process.stdout.write(JSON.stringify({
  worktree_path: wt,
  branch: 'worktree-' + (process.env.PIPELINE_WT_NAME || ''),
  env_file: path.join(wt, '.worktree.env'),
  port_base: 5100,
  ports: { BACKEND_PORT: 5103 },
}) + '\\n');
`;

/** Happy-path destroy hook: dumps env (marker that it ran), prints {"ok":true}. */
const DESTROY_OK_HOOK = `
const fs = require('fs');
const path = require('path');
const env = {};
for (const k of Object.keys(process.env)) if (k.startsWith('PIPELINE_WT_')) env[k] = process.env[k];
fs.writeFileSync(path.join(process.cwd(), 'destroy-env-dump.json'), JSON.stringify(env));
process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
`;

const CREATE_FAIL_HOOK = `
process.stderr.write('disk full: no space left on device\\n');
process.exit(3);
`;

const CREATE_GARBAGE_HOOK = `
process.stdout.write('this is not json at all\\n');
process.exit(0);
`;

const DESTROY_SOFTFAIL_HOOK = `
process.stdout.write(JSON.stringify({ ok: false, detail: 'registry row missing' }) + '\\n');
process.exit(0);
`;

/** Happy-path finalize hook: dumps env (contract assertion), prints {"ok":true}. */
const FINALIZE_OK_HOOK = `
const fs = require('fs');
const path = require('path');
const env = {};
for (const k of Object.keys(process.env)) if (k.startsWith('PIPELINE_WT_')) env[k] = process.env[k];
fs.writeFileSync(path.join(process.cwd(), 'finalize-env-dump.json'), JSON.stringify(env));
process.stderr.write('finalizing (stderr noise)...\\n');
process.stdout.write(JSON.stringify({ ok: true, detail: 'pushed 1 commit' }) + '\\n');
`;

/** Finalize hook that FAILS the must-succeed gate: {"ok":false} + exit 0. */
const FINALIZE_FAIL_HOOK = `
const fs = require('fs');
const path = require('path');
const env = {};
for (const k of Object.keys(process.env)) if (k.startsWith('PIPELINE_WT_')) env[k] = process.env[k];
fs.writeFileSync(path.join(process.cwd(), 'finalize-env-dump.json'), JSON.stringify(env));
process.stdout.write(JSON.stringify({ ok: false, detail: 'push rejected' }) + '\\n');
process.exit(0);
`;

// ---------------------------------------------------------------------------
// Scaffolding + drivers
// ---------------------------------------------------------------------------

interface Scaffold {
  project: string;
  home: string;
  pipelineRoot: string;
  hooksDir: string;
}

/** Temp consumer project (git repo) + external pipeline + hook scripts.
 *  Pass `createHook: null` / `destroyHook: null` to OMIT that hook file;
 *  undefined uses the happy-path fake. */
function scaffold(
  opts: {
    steps?: number;
    createHook?: string | null;
    destroyHook?: string | null;
    submodules?: string;
    /** When set, add `base_branch: <value>` to PIPELINE.md frontmatter (B1). */
    baseBranch?: string;
    /** When set, write `worktree-finalize.js` (hook-presence opt-in). Omit ⇒ no
     *  finalize hook (the default; a run without one is byte-for-byte unchanged). */
    finalizeHook?: string;
    /** When true, add `finalize: true` to PIPELINE.md frontmatter (the secondary
     *  opt-in trigger — used to prove the must-succeed gate fires even with no
     *  hook file present). */
    finalize?: boolean;
    /** When false, add `delete_branches: false` to PIPELINE.md frontmatter (the
     *  branch-reaping opt-out — a completed run then still gets DELETE_BRANCHES=0). */
    deleteBranches?: boolean;
  } = {},
): Scaffold {
  const project = mkGitRepo();
  const home = mkTmp('hookshome-');
  const pipelineRoot = join(project, '.claude', 'pipeline', 'demo');
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  const subs = opts.submodules ? `\nsubmodules: [${opts.submodules}]` : '';
  const fin = opts.finalize ? `\nfinalize: true` : '';
  const base = opts.baseBranch ? `\nbase_branch: ${opts.baseBranch}` : '';
  const del = opts.deleteBranches === false ? `\ndelete_branches: false` : '';
  writeFileSync(join(pipelineRoot, 'PIPELINE.md'), `---\nisolation: external${subs}${fin}${base}${del}\n---\n# P\n\n## End State\nx\n`);
  const n = opts.steps ?? 1;
  for (let i = 1; i <= n; i++) {
    writeFileSync(join(pipelineRoot, 'steps', `${String(i).padStart(2, '0')}-step.md`), `# step ${i}\n`);
  }
  const hooksDir = join(project, '.claude', 'pipeline', '.hooks');
  mkdirSync(hooksDir, { recursive: true });
  if (opts.createHook !== null) writeFileSync(join(hooksDir, 'worktree-create.js'), opts.createHook ?? CREATE_OK_HOOK);
  if (opts.destroyHook !== null) writeFileSync(join(hooksDir, 'worktree-destroy.js'), opts.destroyHook ?? DESTROY_OK_HOOK);
  if (opts.finalizeHook) writeFileSync(join(hooksDir, 'worktree-finalize.js'), opts.finalizeHook);
  return { project, home, pipelineRoot, hooksDir };
}

/** Swap cwd to the project + point HOME/USERPROFILE at a temp home + clear the
 *  writer's envelope env vars; restore everything after. `fn` receives the REAL
 *  cwd (post-chdir — differs from the input on symlinked temp dirs).
 *
 *  PIPELINE_WORKTREE_SCOPED is pinned to '0': this suite exercises the LEGACY
 *  main-scoped hook mechanics (its fake create hooks return worktree paths
 *  that contain no pipeline copy). The default-on worktree-scoped behavior
 *  (P2/b3) has its own suite: tests/worktree-scoped.test.ts. */
function inProject<T>(project: string, home: string, fn: (realProjectRoot: string) => T): T {
  const prevCwd = process.cwd();
  const keys = ['PIPELINE_UI_RUN_ID', 'PIPELINE_UI_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'PIPELINE_UI_DEBUG', 'USERPROFILE', 'HOME', 'PIPELINE_WORKTREE_SCOPED'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.chdir(project);
    delete process.env.PIPELINE_UI_RUN_ID;
    delete process.env.PIPELINE_UI_PARENT_RUN_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.PIPELINE_UI_DEBUG;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    process.env.PIPELINE_WORKTREE_SCOPED = '0';
    return fn(process.cwd());
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Run runNext() in-process, capturing the printed action JSON + exit code. */
function nextCall(pipelineRoot: string, runId: string, extra: string[] = []): { code: number; json: any } {
  let buf = '';
  const orig = process.stdout.write;
  (process.stdout as any).write = (chunk: unknown) => {
    buf += String(chunk);
    return true;
  };
  let code: number;
  try {
    code = runNext(['--root', pipelineRoot, '--run-id', runId, ...extra]);
  } finally {
    (process.stdout as any).write = orig;
  }
  return { code, json: buf.trim() ? JSON.parse(buf.trim()) : null };
}

function readEvents(projectRoot: string): any[] {
  const f = join(projectRoot, '.claude', 'pipeline', '.runtime', 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l: string) => JSON.parse(l));
}

const record = (r: object) => ['--record', JSON.stringify(r)];

// ---------------------------------------------------------------------------
// (a) init — provision executed in-process, PIPELINE_WT_* contract honored
// ---------------------------------------------------------------------------

test('external init: create hook runs in-process — run-step (not provision-worktree) with provisioned info + full env contract', () => {
  const s = scaffold({ steps: 2, submodules: 'AppX, McpY' });
  const runId = 'hookrun1';
  inProject(s.project, s.home, (root) => {
    const r = nextCall(s.pipelineRoot, runId);
    expect(r.code).toBe(0);
    expect(r.json.action).toBe('run-step');
    const wt = join(root, '.claude', 'worktrees', runId);
    expect(r.json.steps[0].external_worktree).toBe(true);
    expect(r.json.steps[0].worktree_path).toBe(wt);
    expect(r.json.steps[0].worktree_env_file).toBe(join(wt, '.worktree.env'));
    expect(r.json.steps[0].isolation).toBe(null);
    // Top-level provisioned info attached for the manager's progress output.
    expect(r.json.provisioned).toEqual({
      worktree_path: wt,
      branch: `worktree-${runId}`,
      env_file: join(wt, '.worktree.env'),
    });
    // Persisted state crossed await-provision into await-step.
    const st = JSON.parse(readFileSync(join(s.pipelineRoot, '.runtime', runId, 'next.json'), 'utf8'));
    expect(st.worktree_provisioned).toBe(true);
    expect(st.phase).toBe('await-step');
    // FROZEN env contract, as received by the hook.
    const env = JSON.parse(readFileSync(join(root, 'create-env-dump.json'), 'utf8'));
    expect(env.PIPELINE_WT_ACTION).toBe('create');
    expect(env.PIPELINE_WT_RUN_ID).toBe(runId);
    expect(env.PIPELINE_WT_NAME).toBe(runId);
    expect(env.PIPELINE_WT_PIPELINE_NAME).toBe('demo');
    expect(env.PIPELINE_WT_PIPELINE_ROOT).toBe(resolve(s.pipelineRoot));
    expect(env.PIPELINE_WT_PROJECT_ROOT).toBe(root);
    expect(env.PIPELINE_WT_BASE_BRANCH).toBe('main');
    expect(env.PIPELINE_WT_SUBMODULES).toBe('AppX,McpY');
    expect(env.PIPELINE_WT_DRY_RUN).toBe('0');
  });
}, 20000);

// ---------------------------------------------------------------------------
// (b) full run — teardown executed in-process + event journal assertions
// ---------------------------------------------------------------------------

test('external full run: terminal step → destroy hook runs in-process → done with teardown ok; events journaled in order', () => {
  const s = scaffold({ steps: 1 });
  const runId = 'hookrun2';
  inProject(s.project, s.home, (root) => {
    const r1 = nextCall(s.pipelineRoot, runId);
    expect(r1.json.action).toBe('run-step');

    const r2 = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    expect(r2.code).toBe(0);
    expect(r2.json.action).toBe('done');
    expect(r2.json.teardown).toEqual({ ok: true, detail: null });

    // Destroy hook really ran, with the FROZEN destroy env contract.
    const env = JSON.parse(readFileSync(join(root, 'destroy-env-dump.json'), 'utf8'));
    expect(env.PIPELINE_WT_ACTION).toBe('destroy');
    expect(env.PIPELINE_WT_RUN_ID).toBe(runId);
    expect(env.PIPELINE_WT_NAME).toBe(runId);
    expect(env.PIPELINE_WT_OUTCOME).toBe('completed');
    // Outcome-aware branch reaping: a COMPLETED run deletes its branch by default.
    expect(env.PIPELINE_WT_DELETE_BRANCHES).toBe('1');
    expect(env.PIPELINE_WT_DRY_RUN).toBe('0');
    expect(env.PIPELINE_WT_WORKTREE_PATH).toBe(join(root, '.claude', 'worktrees', runId));

    // Auto-emitted events, all stamped with the run id.
    const events = readEvents(root);
    const types = events.map((e) => e.type);
    expect(types).toContain('worktree.created');
    expect(types).toContain('iteration.started');
    expect(types).toContain('iteration.completed');
    expect(types).toContain('worktree.destroyed');
    for (const e of events) expect(e.run_id).toBe(runId);

    const createdEv = events.find((e) => e.type === 'worktree.created');
    expect(createdEv.data.ok).toBe(true);
    expect(createdEv.data.worktree_path).toBe(join(root, '.claude', 'worktrees', runId));
    expect(createdEv.data.hook_dir).toBe('.claude/pipeline/.hooks');

    const started = events.find((e) => e.type === 'iteration.started');
    expect(started.data.index).toBe(1);
    expect('step_id' in started.data).toBe(false); // sequential → no step_id
    expect(started.data.resolved_model).toBeNull();

    const completed = events.find((e) => e.type === 'iteration.completed');
    expect(completed.data.terminal).toBe(true);
    expect(completed.data.outcome).toBe('completed');
    expect(completed.data.next_iteration_path).toBe('PIPELINE_COMPLETE');

    const destroyed = events.find((e) => e.type === 'worktree.destroyed');
    expect(destroyed.data.ok).toBe(true);
    expect(destroyed.data.outcome).toBe('completed');

    // Journal order: created → started → completed → destroyed.
    expect(types.indexOf('worktree.created')).toBeLessThan(types.indexOf('iteration.started'));
    expect(types.indexOf('iteration.started')).toBeLessThan(types.indexOf('iteration.completed'));
    expect(types.indexOf('iteration.completed')).toBeLessThan(types.indexOf('worktree.destroyed'));
  });
}, 20000);

// ---------------------------------------------------------------------------
// (c) create hook non-zero exit → halt
// ---------------------------------------------------------------------------

test('external: create hook exits 3 → halt (exit 1) with exit code + stderr tail; nothing provisioned, no teardown', () => {
  const s = scaffold({ createHook: CREATE_FAIL_HOOK });
  const runId = 'hookrun3';
  inProject(s.project, s.home, (root) => {
    const r = nextCall(s.pipelineRoot, runId);
    expect(r.code).toBe(1);
    expect(r.json.action).toBe('halt');
    expect(r.json.status).toBe('halted');
    expect(r.json.reason).toContain('worktree-create hook failed');
    expect(r.json.reason).toContain('exited 3');
    expect(r.json.reason).toContain('disk full');
    expect(r.json.provisioned).toBeUndefined();
    expect(r.json.teardown).toBeUndefined(); // failed provision → teardown never fires
    const st = JSON.parse(readFileSync(join(s.pipelineRoot, '.runtime', runId, 'next.json'), 'utf8'));
    expect(st.worktree_provisioned).toBe(false);
    expect(st.phase).toBe('terminal');
    const events = readEvents(root);
    const createdEv = events.find((e) => e.type === 'worktree.created');
    expect(createdEv.data.ok).toBe(false);
    expect(createdEv.data.detail).toContain('disk full');
    // UPDATED for A3 (the old `worktree.destroyed`-never-emitted assertion pinned
    // the buggy no-cleanup behavior): the failed create now triggers ONE
    // best-effort destroy-hook cleanup with outcome=create-failed — a RUN
    // teardown still never fires (r.json.teardown stays undefined above).
    const destroyedEvs = events.filter((e) => e.type === 'worktree.destroyed');
    expect(destroyedEvs.length).toBe(1);
    expect(destroyedEvs[0].data.outcome).toBe('create-failed');
  });
}, 20000);

// ---------------------------------------------------------------------------
// (d) create hook garbage stdout → halt
// ---------------------------------------------------------------------------

test('external: create hook prints non-JSON stdout → halt with "stdout not JSON" detail', () => {
  const s = scaffold({ createHook: CREATE_GARBAGE_HOOK });
  const runId = 'hookrun4';
  inProject(s.project, s.home, () => {
    const r = nextCall(s.pipelineRoot, runId);
    expect(r.code).toBe(1);
    expect(r.json.action).toBe('halt');
    expect(r.json.reason).toContain('worktree-create hook failed');
    expect(r.json.reason).toContain('stdout not JSON');
  });
}, 20000);

// ---------------------------------------------------------------------------
// (e) missing create hook → halt
// ---------------------------------------------------------------------------

test('external: missing worktree-create.* hook → halt naming the missing hook', () => {
  const s = scaffold({ createHook: null });
  const runId = 'hookrun5';
  inProject(s.project, s.home, () => {
    const r = nextCall(s.pipelineRoot, runId);
    expect(r.code).toBe(1);
    expect(r.json.action).toBe('halt');
    expect(r.json.reason).toContain('worktree-create hook failed');
    expect(r.json.reason).toContain('no');
    expect(r.json.reason).toContain('worktree-create.*');
    const st = JSON.parse(readFileSync(join(s.pipelineRoot, '.runtime', runId, 'next.json'), 'utf8'));
    expect(st.worktree_provisioned).toBe(false);
  });
}, 20000);

// ---------------------------------------------------------------------------
// (f) --manual-hooks — legacy parity
// ---------------------------------------------------------------------------

test('--manual-hooks: raw provision-worktree action printed (legacy parity), hook NOT executed, no worktree.* auto-emitted', () => {
  const s = scaffold({});
  const runId = 'hookrun6';
  inProject(s.project, s.home, (root) => {
    const r = nextCall(s.pipelineRoot, runId, ['--manual-hooks']);
    expect(r.code).toBe(0);
    expect(r.json.action).toBe('provision-worktree');
    expect(r.json.run_id).toBe(runId);
    expect(r.json.name).toBe(runId);
    expect(r.json.base_branch).toBe('main');
    expect(r.json.hook_dir).toBe('.claude/pipeline/.hooks');
    expect(existsSync(join(root, 'create-env-dump.json'))).toBe(false); // hook untouched
    expect(readEvents(root).some((e) => e.type.startsWith('worktree.'))).toBe(false);

    // Backward compat: a legacy manager's manual worktree record still advances.
    const r2 = nextCall(
      s.pipelineRoot,
      runId,
      ['--manual-hooks', ...record({ kind: 'worktree', phase: 'provisioned', worktree_path: '/wt/x', branch: 'b', env_file: null })],
    );
    expect(r2.json.action).toBe('run-step');
    expect(r2.json.steps[0].worktree_path).toBe('/wt/x');
    expect(r2.json.provisioned).toBeUndefined(); // no in-process hook ran
  });
}, 20000);

// ---------------------------------------------------------------------------
// (g) destroy soft-fail → run still terminates
// ---------------------------------------------------------------------------

test('external: destroy hook {"ok":false,"detail"} → run still reaches done with teardown.ok=false (never strands)', () => {
  const s = scaffold({ steps: 1, destroyHook: DESTROY_SOFTFAIL_HOOK });
  const runId = 'hookrun7';
  inProject(s.project, s.home, (root) => {
    nextCall(s.pipelineRoot, runId); // init → step 1
    const r = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    expect(r.code).toBe(0);
    expect(r.json.action).toBe('done');
    expect(r.json.teardown).toEqual({ ok: false, detail: 'registry row missing' });
    const destroyed = readEvents(root).find((e) => e.type === 'worktree.destroyed');
    expect(destroyed.data.ok).toBe(false);
    expect(destroyed.data.detail).toBe('registry row missing');
  });
}, 20000);

test('external: MISSING destroy hook → run still reaches done with teardown.ok=false (never strands)', () => {
  const s = scaffold({ steps: 1, destroyHook: null });
  const runId = 'hookrun8';
  inProject(s.project, s.home, () => {
    nextCall(s.pipelineRoot, runId);
    const r = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    expect(r.code).toBe(0);
    expect(r.json.action).toBe('done');
    expect(r.json.teardown.ok).toBe(false);
    expect(r.json.teardown.detail).toContain('worktree-destroy');
  });
}, 20000);

// ---------------------------------------------------------------------------
// auto-resume re-runs the idempotent create hook in-process
// ---------------------------------------------------------------------------

test('external auto-resume (no record): create hook re-runs idempotently and the run re-enters at run-step', () => {
  const s = scaffold({ steps: 2 });
  const runId = 'hookrun9';
  inProject(s.project, s.home, (root) => {
    nextCall(s.pipelineRoot, runId); // init → step 1 (hook ran once)
    rmSync(join(root, 'create-env-dump.json'));
    const r = nextCall(s.pipelineRoot, runId); // no record → auto-resume
    expect(r.code).toBe(0);
    expect(r.json.action).toBe('run-step');
    expect(r.json.provisioned).toBeDefined();
    expect(existsSync(join(root, 'create-env-dump.json'))).toBe(true); // hook re-ran
  });
}, 20000);

// ---------------------------------------------------------------------------
// event auto-emission on a plain sequential (non-external) run
// ---------------------------------------------------------------------------

test('sequential (non-external) run: iteration/improver/script_creator events auto-emitted from records', () => {
  const project = mkGitRepo();
  const home = mkTmp('hookshome-');
  const pipelineRoot = join(project, '.claude', 'pipeline', 'plain');
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  writeFileSync(join(pipelineRoot, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  writeFileSync(join(pipelineRoot, 'steps', '01-step.md'), '# s1\n');
  const runId = 'seqevents1';
  inProject(project, home, (root) => {
    let r = nextCall(pipelineRoot, runId);
    expect(r.json.action).toBe('run-step');
    r = nextCall(pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE', has_improvement_brief: true }));
    expect(r.json.action).toBe('run-improver');
    r = nextCall(pipelineRoot, runId, record({ kind: 'improver', applied: true, script_briefs: 1 }));
    expect(r.json.action).toBe('run-script-creator');
    r = nextCall(pipelineRoot, runId, record({ kind: 'script', outcome: 'created', script_path: '/abs/scripts/x.py' }));
    expect(r.json.action).toBe('done');

    const events = readEvents(root);
    expect(events.map((e) => e.type)).toEqual([
      'iteration.started',
      'iteration.completed',
      'improver.started',
      'improver.completed',
      'script_creator.started',
      'script_creator.completed',
    ]);
    for (const e of events) expect(e.run_id).toBe(runId);

    const stepPath = join(pipelineRoot, 'steps', '01-step.md');
    const completed = events.find((e) => e.type === 'iteration.completed');
    expect(completed.data.iteration_path).toBe(stepPath);
    expect(completed.data.has_improvement_brief).toBe(true);
    expect(completed.data.has_blocker_delegation).toBe(false);
    expect(completed.data.terminal).toBe(true);
    expect(completed.data.next_iteration_path).toBe('PIPELINE_COMPLETE');
    expect(completed.data.halt_reason).toBeNull();

    const impStarted = events.find((e) => e.type === 'improver.started');
    expect(impStarted.data.iteration_path).toBe(stepPath);
    const impCompleted = events.find((e) => e.type === 'improver.completed');
    expect(impCompleted.data.applied).toBe(true);
    expect(impCompleted.data.has_script_brief).toBe(true);

    const scCompleted = events.find((e) => e.type === 'script_creator.completed');
    expect(scCompleted.data.script_path).toBe('/abs/scripts/x.py');
    expect(scCompleted.data.outcome).toBe('created');
  });
}, 20000);

// ---------------------------------------------------------------------------
// finalize stage — mandatory terminal hook executed in-process
// ---------------------------------------------------------------------------

test('external finalize (hook present ⇒ opted in): completed → finalize hook runs in-process → destroy → done; journal completed → finalized → destroyed', () => {
  // Opt-in is HOOK PRESENCE alone — no `finalize: true` frontmatter needed.
  const s = scaffold({ steps: 1, finalizeHook: FINALIZE_OK_HOOK });
  const runId = 'finhook1';
  inProject(s.project, s.home, (root) => {
    const r1 = nextCall(s.pipelineRoot, runId);
    expect(r1.json.action).toBe('run-step');
    const r2 = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    expect(r2.code).toBe(0);
    expect(r2.json.action).toBe('done');
    // Top-level finalize info attached alongside teardown.
    expect(r2.json.finalized).toEqual({ ok: true, detail: 'pushed 1 commit' });
    expect(r2.json.teardown).toEqual({ ok: true, detail: null });

    // Finalize hook really ran with the finalize env contract (ACTION=finalize +
    // the full PIPELINE_WT_* context).
    const env = JSON.parse(readFileSync(join(root, 'finalize-env-dump.json'), 'utf8'));
    expect(env.PIPELINE_WT_ACTION).toBe('finalize');
    expect(env.PIPELINE_WT_RUN_ID).toBe(runId);
    expect(env.PIPELINE_WT_NAME).toBe(runId);
    expect(env.PIPELINE_WT_PIPELINE_NAME).toBe('demo');
    expect(env.PIPELINE_WT_PIPELINE_ROOT).toBe(resolve(s.pipelineRoot));
    expect(env.PIPELINE_WT_PROJECT_ROOT).toBe(root);
    expect(env.PIPELINE_WT_OUTCOME).toBe('completed');
    expect(env.PIPELINE_WT_WORKTREE_PATH).toBe(join(root, '.claude', 'worktrees', runId));
    expect(env.PIPELINE_WT_DRY_RUN).toBe('0');

    const events = readEvents(root);
    const types = events.map((e) => e.type);
    expect(types).toContain('worktree.finalized');
    for (const e of events) expect(e.run_id).toBe(runId);
    const fin = events.find((e) => e.type === 'worktree.finalized');
    expect(fin.data.ok).toBe(true);
    expect(fin.data.outcome).toBe('completed');
    expect(fin.data.detail).toBe('pushed 1 commit');
    // Journal order: created → started → completed → finalized → destroyed.
    expect(types.indexOf('iteration.completed')).toBeLessThan(types.indexOf('worktree.finalized'));
    expect(types.indexOf('worktree.finalized')).toBeLessThan(types.indexOf('worktree.destroyed'));
  });
}, 20000);

test('external finalize FAILS ({ok:false}): run HALTS (not done); destroy still runs with outcome=halted so the consumer preserves the worktree', () => {
  const s = scaffold({ steps: 1, finalizeHook: FINALIZE_FAIL_HOOK });
  const runId = 'finhook2';
  inProject(s.project, s.home, (root) => {
    nextCall(s.pipelineRoot, runId); // init → step
    const r = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    // OPPOSITE terminal effect of the destroy-soft-fail test (which reaches done).
    expect(r.code).toBe(1);
    expect(r.json.action).toBe('halt');
    expect(r.json.status).toBe('halted');
    expect(r.json.reason).toContain('worktree-finalize hook failed');
    expect(r.json.reason).toContain('push rejected');
    expect(r.json.finalized).toEqual({ ok: false, detail: 'push rejected' });

    // The destroy hook STILL ran — but with outcome=halted, its cue to PRESERVE
    // (branch included: a failed finalize must never reap the finalize work).
    const denv = JSON.parse(readFileSync(join(root, 'destroy-env-dump.json'), 'utf8'));
    expect(denv.PIPELINE_WT_OUTCOME).toBe('halted');
    expect(denv.PIPELINE_WT_DELETE_BRANCHES).toBe('0');

    const events = readEvents(root);
    const fin = events.find((e) => e.type === 'worktree.finalized');
    expect(fin.data.ok).toBe(false);
    const destroyed = events.find((e) => e.type === 'worktree.destroyed');
    expect(destroyed.data.outcome).toBe('halted');
  });
}, 20000);

test('external finalize opt-in via frontmatter but MISSING worktree-finalize hook → halt (must-succeed fails loud)', () => {
  const s = scaffold({ steps: 1, finalize: true }); // frontmatter opt-in, NO finalize hook file
  const runId = 'finhook3';
  inProject(s.project, s.home, () => {
    nextCall(s.pipelineRoot, runId);
    const r = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    expect(r.code).toBe(1);
    expect(r.json.action).toBe('halt');
    expect(r.json.reason).toContain('worktree-finalize hook failed');
    expect(r.json.reason).toContain('no');
    expect(r.json.reason).toContain('worktree-finalize.*');
  });
}, 20000);

test('external default (no finalize hook, no frontmatter): finalize never fires — run byte-for-byte unchanged', () => {
  const s = scaffold({ steps: 1 });
  const runId = 'finhook4';
  inProject(s.project, s.home, (root) => {
    nextCall(s.pipelineRoot, runId);
    const r = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    expect(r.json.action).toBe('done');
    expect(r.json.finalized).toBeUndefined();
    expect(readEvents(root).some((e) => e.type === 'worktree.finalized')).toBe(false);
    expect(existsSync(join(root, 'finalize-env-dump.json'))).toBe(false); // no hook exists, none ran
  });
}, 20000);

// ---------------------------------------------------------------------------
// A1 — hook timeout kills the whole process tree, never hangs
// ---------------------------------------------------------------------------

/** Hook that spawns a grandchild (which writes a marker file ~2.5s later) and
 *  then hangs forever, ignoring SIGTERM. The tree-kill must reap BOTH. */
const TREE_HANG_HOOK = `
const { spawn } = require('child_process');
spawn(process.execPath, [process.env.HOOK_GRANDCHILD_JS, process.env.HOOK_MARKER_FILE], { stdio: 'ignore' });
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

const GRANDCHILD_JS = `
setTimeout(() => { require('fs').writeFileSync(process.argv[2], 'grandchild survived'); }, 2500);
`;

test('A1: runHook timeout kills the WHOLE hook process tree — the grandchild never lands its late side-effect', async () => {
  const dir = mkTmp('hookkill-');
  const marker = join(dir, 'late-marker.txt');
  writeFileSync(join(dir, 'grandchild.js'), GRANDCHILD_JS);
  writeFileSync(join(dir, 'tree-hook.js'), TREE_HANG_HOOK);
  const t0 = Date.now();
  const r = runHook(
    join(dir, 'tree-hook.js'),
    { HOOK_GRANDCHILD_JS: join(dir, 'grandchild.js'), HOOK_MARKER_FILE: marker },
    dir,
    1000,
  );
  const elapsed = Date.now() - t0;
  // Timeout failure shape: timedOut, no clean exit code, no spawn error — and
  // the call returned promptly (a SIGTERM-trapping hook must never hang us).
  expect(r.timedOut).toBe(true);
  expect(r.code).toBeNull();
  expect(r.error).toBeUndefined();
  expect(elapsed).toBeLessThan(10_000);
  // The grandchild would write its marker at ~2.5s if it survived the kill.
  // Wait well past that: the file must NEVER appear.
  await new Promise((res) => setTimeout(res, 4000));
  expect(existsSync(marker)).toBe(false);
}, 30000);

/** Create hook that hangs forever (SIGTERM-proof), producing no output. */
const CREATE_HANG_HOOK = `
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;

test('A1/command: hung create hook + env-injected budget (PIPELINE_HOOK_TIMEOUT_MS) → timed-out halt within budget; create-failed cleanup runs', () => {
  const s = scaffold({ createHook: CREATE_HANG_HOOK });
  const runId = 'hooktimeout1';
  process.env.PIPELINE_HOOK_TIMEOUT_MS = '2000';
  try {
    inProject(s.project, s.home, (root) => {
      const t0 = Date.now();
      const r = nextCall(s.pipelineRoot, runId);
      expect(Date.now() - t0).toBeLessThan(25_000);
      expect(r.code).toBe(1);
      expect(r.json.action).toBe('halt');
      expect(r.json.reason).toContain('worktree-create hook failed');
      expect(r.json.reason).toContain('timed out after 2s');
      // A3: the timed-out create still triggered the best-effort cleanup.
      const denv = JSON.parse(readFileSync(join(root, 'destroy-env-dump.json'), 'utf8'));
      expect(denv.PIPELINE_WT_OUTCOME).toBe('create-failed');
    });
  } finally {
    delete process.env.PIPELINE_HOOK_TIMEOUT_MS;
  }
}, 40000);

// ---------------------------------------------------------------------------
// A2 — mid-run plan errors no longer bypass teardown
// ---------------------------------------------------------------------------

test('A2: MID-RUN plan error on a provisioned external run → halt THROUGH teardown (destroy outcome=halted), state parked terminal', () => {
  const s = scaffold({ steps: 2 });
  const runId = 'planerr1';
  inProject(s.project, s.home, (root) => {
    const r1 = nextCall(s.pipelineRoot, runId);
    expect(r1.json.action).toBe('run-step'); // provisioned + step 1 dispatched
    // The plan acquires an error MID-RUN: every iteration file vanishes.
    rmSync(join(s.pipelineRoot, 'steps'), { recursive: true, force: true });
    const r2 = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    expect(r2.code).toBe(1);
    expect(r2.json.action).toBe('halt');
    expect(r2.json.status).toBe('halted');
    expect(r2.json.reason).toContain('plan errors');
    // The destroy hook ran with the halt outcome (preserve-on-halt cue) and the
    // real worktree path; its result is surfaced on the printed action.
    expect(r2.json.teardown).toEqual({ ok: true, detail: null });
    const denv = JSON.parse(readFileSync(join(root, 'destroy-env-dump.json'), 'utf8'));
    expect(denv.PIPELINE_WT_OUTCOME).toBe('halted');
    expect(denv.PIPELINE_WT_WORKTREE_PATH).toBe(join(root, '.claude', 'worktrees', runId));
    // State: terminal + halted with the plan-error reason (pre-fix it stayed
    // parked non-terminal forever and the worktree leaked).
    const st = JSON.parse(readFileSync(join(s.pipelineRoot, '.runtime', runId, 'next.json'), 'utf8'));
    expect(st.phase).toBe('terminal');
    expect(st.status).toBe('halted');
    expect(st.halt_reason).toContain('plan errors');
    const destroyed = readEvents(root).find((e) => e.type === 'worktree.destroyed');
    expect(destroyed.data.ok).toBe(true);
    expect(destroyed.data.outcome).toBe('halted');
    // Idempotent: once terminal, a re-probe keeps the stateless early-return —
    // the destroy hook is NOT re-run.
    rmSync(join(root, 'destroy-env-dump.json'));
    const r3 = nextCall(s.pipelineRoot, runId);
    expect(r3.code).toBe(1);
    expect(r3.json.action).toBe('halt');
    expect(existsSync(join(root, 'destroy-env-dump.json'))).toBe(false);
  });
}, 20000);

test('A2: a FRESH run (no persisted state) with plan errors keeps the stateless early-return — no state file, no hooks', () => {
  const s = scaffold({ steps: 0 }); // zero iteration files → plan error at init
  const runId = 'planerr2';
  inProject(s.project, s.home, (root) => {
    const r = nextCall(s.pipelineRoot, runId);
    expect(r.code).toBe(1);
    expect(r.json.action).toBe('halt');
    expect(r.json.reason).toContain('plan errors');
    expect(existsSync(join(s.pipelineRoot, '.runtime', runId, 'next.json'))).toBe(false);
    expect(existsSync(join(root, 'create-env-dump.json'))).toBe(false);
    expect(existsSync(join(root, 'destroy-env-dump.json'))).toBe(false);
  });
}, 20000);

// ---------------------------------------------------------------------------
// A3 — best-effort destroy-hook cleanup after a failed create (OUTCOME=create-failed)
// ---------------------------------------------------------------------------

test('A3: failed create → destroy hook invoked ONCE with PIPELINE_WT_OUTCOME=create-failed and NO worktree path; halt unchanged', () => {
  const s = scaffold({ createHook: CREATE_FAIL_HOOK }); // destroy = happy default
  const runId = 'createfail1';
  inProject(s.project, s.home, (root) => {
    const r = nextCall(s.pipelineRoot, runId);
    // The halt is byte-identical to the no-cleanup era: same action, exit, reason.
    expect(r.code).toBe(1);
    expect(r.json.action).toBe('halt');
    expect(r.json.reason).toContain('worktree-create hook failed');
    expect(r.json.reason).toContain('exited 3');
    expect(r.json.provisioned).toBeUndefined();
    expect(r.json.teardown).toBeUndefined(); // cleanup is NOT a run teardown
    // Full destroy-style env, with the additive outcome and NO WORKTREE_PATH
    // (the failed create yielded none).
    const denv = JSON.parse(readFileSync(join(root, 'destroy-env-dump.json'), 'utf8'));
    expect(denv.PIPELINE_WT_ACTION).toBe('destroy');
    expect(denv.PIPELINE_WT_OUTCOME).toBe('create-failed');
    expect(denv.PIPELINE_WT_RUN_ID).toBe(runId);
    expect(denv.PIPELINE_WT_NAME).toBe(runId);
    expect(denv.PIPELINE_WT_PIPELINE_ROOT).toBe(resolve(s.pipelineRoot));
    expect(denv.PIPELINE_WT_PROJECT_ROOT).toBe(root);
    expect(denv.PIPELINE_WT_DELETE_BRANCHES).toBe('0');
    expect('PIPELINE_WT_WORKTREE_PATH' in denv).toBe(false);
    // worktree.destroyed emitted (destroy reported ok) with the cleanup outcome.
    const destroyed = readEvents(root).filter((e) => e.type === 'worktree.destroyed');
    expect(destroyed.length).toBe(1);
    expect(destroyed[0].data.ok).toBe(true);
    expect(destroyed[0].data.outcome).toBe('create-failed');
    // Run state unchanged by the cleanup: nothing provisioned, terminal halt.
    const st = JSON.parse(readFileSync(join(s.pipelineRoot, '.runtime', runId, 'next.json'), 'utf8'));
    expect(st.worktree_provisioned).toBe(false);
    expect(st.phase).toBe('terminal');
  });
}, 20000);

/** Destroy hook that HARD-fails: non-zero exit + stderr noise, no JSON. */
const DESTROY_HARDFAIL_HOOK = `
process.stderr.write('rm failed: permission denied\\n');
process.exit(2);
`;

test('A3: the cleanup destroy itself failing never alters the halt — and no worktree.destroyed is emitted', () => {
  const s = scaffold({ createHook: CREATE_FAIL_HOOK, destroyHook: DESTROY_HARDFAIL_HOOK });
  const runId = 'createfail2';
  inProject(s.project, s.home, (root) => {
    const r = nextCall(s.pipelineRoot, runId);
    expect(r.code).toBe(1);
    expect(r.json.action).toBe('halt');
    expect(r.json.reason).toContain('worktree-create hook failed');
    expect(r.json.reason).toContain('disk full'); // the CREATE failure, not the destroy one
    expect(readEvents(root).some((e) => e.type === 'worktree.destroyed')).toBe(false);
  });
}, 20000);

// ---------------------------------------------------------------------------
// B5 — create output validation: worktree_path must be absolute
// ---------------------------------------------------------------------------

const CREATE_RELATIVE_HOOK = `
process.stdout.write(JSON.stringify({ worktree_path: '.claude/worktrees/rel', branch: 'b', env_file: null }) + '\\n');
`;

test('B5: a RELATIVE worktree_path from the create hook is a create-hook failure; the cleanup receives the path', () => {
  const s = scaffold({ createHook: CREATE_RELATIVE_HOOK });
  const runId = 'relpath1';
  inProject(s.project, s.home, (root) => {
    const r = nextCall(s.pipelineRoot, runId);
    expect(r.code).toBe(1);
    expect(r.json.action).toBe('halt');
    expect(r.json.reason).toContain('worktree-create hook failed');
    expect(r.json.reason).toContain('non-absolute');
    expect(r.json.reason).toContain('.claude/worktrees/rel');
    expect(r.json.provisioned).toBeUndefined();
    const st = JSON.parse(readFileSync(join(s.pipelineRoot, '.runtime', runId, 'next.json'), 'utf8'));
    expect(st.worktree_provisioned).toBe(false);
    // A3 cleanup fired AND received the relative path the failed create yielded.
    const denv = JSON.parse(readFileSync(join(root, 'destroy-env-dump.json'), 'utf8'));
    expect(denv.PIPELINE_WT_OUTCOME).toBe('create-failed');
    expect(denv.PIPELINE_WT_WORKTREE_PATH).toBe('.claude/worktrees/rel');
    const createdEv = readEvents(root).find((e) => e.type === 'worktree.created');
    expect(createdEv.data.ok).toBe(false);
  });
}, 20000);

// ---------------------------------------------------------------------------
// B1 — base_branch frontmatter reaches the hook env
// ---------------------------------------------------------------------------

test('B1: base_branch frontmatter flows into the create AND finalize hook env (PIPELINE_WT_BASE_BRANCH)', () => {
  const s = scaffold({ steps: 1, baseBranch: 'develop', finalizeHook: FINALIZE_OK_HOOK });
  const runId = 'basebr1';
  inProject(s.project, s.home, (root) => {
    const r1 = nextCall(s.pipelineRoot, runId);
    expect(r1.json.action).toBe('run-step');
    const cenv = JSON.parse(readFileSync(join(root, 'create-env-dump.json'), 'utf8'));
    expect(cenv.PIPELINE_WT_BASE_BRANCH).toBe('develop');
    const r2 = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    expect(r2.json.action).toBe('done');
    const fenv = JSON.parse(readFileSync(join(root, 'finalize-env-dump.json'), 'utf8'));
    expect(fenv.PIPELINE_WT_BASE_BRANCH).toBe('develop');
  });
}, 20000);

// ---------------------------------------------------------------------------
// outcome-aware PIPELINE_WT_DELETE_BRANCHES (leak policy)
// ---------------------------------------------------------------------------

test('delete-branches policy: HALTED run → destroy hook sees DELETE_BRANCHES=0 (preserve for debugging/resume)', () => {
  const s = scaffold({ steps: 2 });
  const runId = 'delbr-halted';
  inProject(s.project, s.home, (root) => {
    nextCall(s.pipelineRoot, runId); // init → step 1
    const r = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'halted', halt_reason: 'tests failed' }));
    expect(r.code).toBe(1);
    expect(r.json.action).toBe('halt');
    const denv = JSON.parse(readFileSync(join(root, 'destroy-env-dump.json'), 'utf8'));
    expect(denv.PIPELINE_WT_OUTCOME).toBe('halted');
    expect(denv.PIPELINE_WT_DELETE_BRANCHES).toBe('0');
  });
}, 20000);

test('delete-branches policy: COMPLETED run with delete_branches: false frontmatter → DELETE_BRANCHES=0 (opt-out wins)', () => {
  const s = scaffold({ steps: 1, deleteBranches: false });
  const runId = 'delbr-optout';
  inProject(s.project, s.home, (root) => {
    nextCall(s.pipelineRoot, runId); // init → step 1
    const r = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    expect(r.code).toBe(0);
    expect(r.json.action).toBe('done');
    const denv = JSON.parse(readFileSync(join(root, 'destroy-env-dump.json'), 'utf8'));
    expect(denv.PIPELINE_WT_OUTCOME).toBe('completed');
    expect(denv.PIPELINE_WT_DELETE_BRANCHES).toBe('0');
  });
}, 20000);

// ---------------------------------------------------------------------------
// destroy HARD-fail (non-zero exit) still proceeds to terminal
// ---------------------------------------------------------------------------

test('external: destroy hook HARD-fails (non-zero exit) → run STILL reaches done with teardown.ok=false naming the exit', () => {
  const s = scaffold({ steps: 1, destroyHook: DESTROY_HARDFAIL_HOOK });
  const runId = 'hardfail1';
  inProject(s.project, s.home, (root) => {
    nextCall(s.pipelineRoot, runId); // init → step 1
    const r = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    expect(r.code).toBe(0);
    expect(r.json.action).toBe('done'); // a leaked worktree never strands the run
    expect(r.json.teardown.ok).toBe(false);
    expect(r.json.teardown.detail).toContain('exited 2');
    expect(r.json.teardown.detail).toContain('permission denied');
    const destroyed = readEvents(root).find((e) => e.type === 'worktree.destroyed');
    expect(destroyed.data.ok).toBe(false);
    expect(destroyed.data.outcome).toBe('completed');
  });
}, 20000);

// ---------------------------------------------------------------------------
// parseHookJson unit edges
// ---------------------------------------------------------------------------

test('parseHookJson edges: BOM, CRLF, noisy multi-line stdout with trailing JSON line, arrays rejected', () => {
  expect(parseHookJson('\uFEFF{"ok":true}')).toEqual({ ok: true });
  expect(parseHookJson('{"ok":true,\r\n"detail":"x"}\r\n')).toEqual({ ok: true, detail: 'x' });
  expect(parseHookJson('provisioning...\r\nstill working\r\n{"worktree_path":"/wt/a"}\r\n')).toEqual({
    worktree_path: '/wt/a',
  });
  expect(parseHookJson('[1,2,3]')).toBeNull();
  expect(parseHookJson('noise\n[{"ok":true}]')).toBeNull(); // an ARRAY is not the contract object
  expect(parseHookJson('')).toBeNull();
  expect(parseHookJson('not json at all')).toBeNull();
});

// ---------------------------------------------------------------------------
// B4 — platform-aware hook resolution
// ---------------------------------------------------------------------------

test('B4: extPreference is platform-aware — win32 puts ps1/py/cmd/bat before sh; POSIX puts sh/py before ps1', () => {
  const win = extPreference('win32');
  const posix = extPreference('linux');
  for (const e of ['ps1', 'py', 'cmd', 'bat']) expect(win.indexOf(e)).toBeLessThan(win.indexOf('sh'));
  expect(win[0]).toBe('ps1');
  expect(posix[0]).toBe('sh');
  expect(posix.indexOf('sh')).toBeLessThan(posix.indexOf('ps1'));
  expect(posix.indexOf('py')).toBeLessThan(posix.indexOf('ps1'));
  // Same candidate SET on both platforms — only the order differs.
  expect([...win].sort()).toEqual([...posix].sort());
});

test('B4: resolveHookScript picks the platform-preferred variant; bare file is the last resort; absent → null', () => {
  const dir = mkTmp('hookres-');
  for (const ext of ['py', 'sh', 'ps1', 'js']) writeFileSync(join(dir, `worktree-create.${ext}`), '');
  const resolved = resolveHookScript(dir, 'worktree-create');
  expect(resolved).not.toBeNull();
  expect(basename(resolved!)).toBe(process.platform === 'win32' ? 'worktree-create.ps1' : 'worktree-create.sh');

  const dir2 = mkTmp('hookres-');
  writeFileSync(join(dir2, 'worktree-destroy'), '');
  expect(resolveHookScript(dir2, 'worktree-destroy')).toBe(join(dir2, 'worktree-destroy'));
  expect(resolveHookScript(dir2, 'worktree-finalize')).toBeNull();
});

test('B4: .ps1 hooks run under pwsh when available, falling back to powershell (flags preserved)', () => {
  const i = interpreterFor('C:/x/worktree-create.ps1');
  expect(['pwsh', 'powershell']).toContain(i.cmd);
  expect(i.args).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/x/worktree-create.ps1']);
});
