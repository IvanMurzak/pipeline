// The SHARED worktree-hook module (lib/worktree-hooks.ts) — the anti-drift
// suite for a FROZEN contract.
//
// The `PIPELINE_WT_*` assembly used to be inlined in commands/next.ts, reachable
// only from the middle of a pipeline run. It now lives in lib/worktree-hooks.ts
// so a caller OUTSIDE a run drives the identical contract. The whole point of
// that move is defeated the moment a second copy appears, so the first test
// here compares the environment a hook receives ON THE RUN PATH against the one
// it receives from a DIRECT call to the shared module with the same inputs, and
// requires them to be byte-identical.
//
// The inputs for the direct call are derived from the scaffold — never read back
// out of the run path's own dump — so a divergence in either direction fails.
//
// Also covered:
//   - emitter isolation: the emitter is a PARAMETER, and the no-op writes no
//     run-scoped journal events (a run-less caller must not fabricate history
//     for a run that does not exist);
//   - the D9 regression guard: an isolated run (`isolation: external` today,
//     `isolation: run` in the v2 vocabulary) with no `worktree-create.*` still
//     halts, exactly as before the extraction. A later task adds a built-in
//     provisioner and must not change this.
//
// Same in-process driving pattern as tests/hooks.test.ts: a real temp git repo
// as the consumer project, plain-JS fake hooks (run via process.execPath per the
// interpreter map), cwd + HOME swapped for the duration.

import { test, expect, afterEach } from 'bun:test';
import { runNext } from '../src/commands/next';
import {
  runCreateHook,
  runFinalizeHook,
  runDestroyHook,
  noopEmitter,
  type WorktreeHookPaths,
} from '../src/lib/worktree-hooks';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  const root = mkTmp('wthookproj-');
  const r = spawnSync('git', ['init', '-q'], { cwd: root });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  return root;
}

// ---------------------------------------------------------------------------
// Fake hooks — each dumps the PIPELINE_WT_* env it received, then honors the
// contract on stdout. The dump is the observation point for the drift check.
// ---------------------------------------------------------------------------

const DUMP = (file: string): string => `
const fs = require('fs');
const path = require('path');
const env = {};
for (const k of Object.keys(process.env)) if (k.startsWith('PIPELINE_WT_')) env[k] = process.env[k];
fs.writeFileSync(path.join(process.cwd(), '${file}'), JSON.stringify(env));
`;

const CREATE_HOOK = `${DUMP('create-env-dump.json')}
const wt = path.join(process.cwd(), '.claude', 'worktrees', process.env.PIPELINE_WT_NAME || 'unnamed');
process.stdout.write(JSON.stringify({
  worktree_path: wt,
  branch: 'worktree-' + (process.env.PIPELINE_WT_NAME || ''),
  env_file: path.join(wt, '.worktree.env'),
}) + '\\n');
`;

const FINALIZE_HOOK = `${DUMP('finalize-env-dump.json')}
process.stdout.write(JSON.stringify({ ok: true, detail: 'pushed 1 commit' }) + '\\n');
`;

const DESTROY_HOOK = `${DUMP('destroy-env-dump.json')}
process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
`;

// ---------------------------------------------------------------------------
// Scaffolding + drivers
// ---------------------------------------------------------------------------

interface Scaffold {
  project: string;
  home: string;
  pipelineRoot: string;
}

/** Temp consumer project (git repo) + an `isolation: external` pipeline + hook
 *  scripts. `createHook: null` omits the create hook (the D9 guard). */
function scaffold(opts: { createHook?: string | null; submodules?: string } = {}): Scaffold {
  const project = mkGitRepo();
  const home = mkTmp('wthookhome-');
  const pipelineRoot = join(project, '.pipeline', 'demo');
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  const subs = opts.submodules ? `\nsubmodules: [${opts.submodules}]` : '';
  writeFileSync(join(pipelineRoot, 'PIPELINE.md'), `---\nisolation: external${subs}\n---\n# P\n\n## End State\nx\n`);
  writeFileSync(join(pipelineRoot, 'steps', '01-step.md'), '# step 1\n');
  const hooksDir = join(project, '.pipeline', '.hooks');
  mkdirSync(hooksDir, { recursive: true });
  if (opts.createHook !== null) writeFileSync(join(hooksDir, 'worktree-create.js'), opts.createHook ?? CREATE_HOOK);
  writeFileSync(join(hooksDir, 'worktree-finalize.js'), FINALIZE_HOOK);
  writeFileSync(join(hooksDir, 'worktree-destroy.js'), DESTROY_HOOK);
  return { project, home, pipelineRoot };
}

/** cwd → the project, HOME/USERPROFILE → a temp home, worktree scoping pinned
 *  off (these fake hooks return worktree paths with no pipeline copy in them —
 *  the same choice tests/hooks.test.ts makes). Restores everything after. */
function inProject<T>(project: string, home: string, fn: (realProjectRoot: string) => T): T {
  const prevCwd = process.cwd();
  const keys = ['PIPELINE_RUN_ID', 'PIPELINE_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'USERPROFILE', 'HOME', 'PIPELINE_WORKTREE_SCOPED'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.chdir(project);
    delete process.env.PIPELINE_RUN_ID;
    delete process.env.PIPELINE_PARENT_RUN_ID;
    delete process.env.CLAUDE_SESSION_ID;
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

/** The dumped environment as a deterministic byte string: every `PIPELINE_WT_*`
 *  key the hook saw, sorted, `KEY=value` per line. Sorted because a child's
 *  environment-block ORDER is the OS's business — the contract is the mapping,
 *  and this renders it so a mismatch prints as a readable diff. */
function canonicalWtEnv(projectRoot: string, file: string): string {
  const raw = JSON.parse(readFileSync(join(projectRoot, file), 'utf8')) as Record<string, string>;
  return Object.keys(raw)
    .filter((k) => k.startsWith('PIPELINE_WT_'))
    .sort()
    .map((k) => `${k}=${raw[k]}\n`)
    .join('');
}

const eventsFile = (projectRoot: string): string => join(projectRoot, '.pipeline', '.runtime', 'events.jsonl');

const record = (r: object) => ['--record', JSON.stringify(r)];

// ---------------------------------------------------------------------------
// (1) THE ANTI-DRIFT TEST
// ---------------------------------------------------------------------------

test('anti-drift: the run path and a direct shared-module call hand the hook byte-identical PIPELINE_WT_* environments (create · finalize · destroy)', () => {
  const s = scaffold({ submodules: 'AppX, McpY' });
  const runId = 'driftrun1';
  inProject(s.project, s.home, (root) => {
    // ---- the RUN path: init (create) → completion (finalize → destroy) -----
    const r1 = nextCall(s.pipelineRoot, runId);
    expect(r1.json.action).toBe('run-step');
    const r2 = nextCall(s.pipelineRoot, runId, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
    expect(r2.json.action).toBe('done');
    expect(r2.json.finalized).toEqual({ ok: true, detail: 'pushed 1 commit' });
    expect(r2.json.teardown).toEqual({ ok: true, detail: null });

    // Snapshot all three environments BEFORE the direct calls overwrite them.
    const viaRun = {
      create: canonicalWtEnv(root, 'create-env-dump.json'),
      finalize: canonicalWtEnv(root, 'finalize-env-dump.json'),
      destroy: canonicalWtEnv(root, 'destroy-env-dump.json'),
    };
    // Guard against a vacuous pass (two empty dumps would compare equal).
    expect(viaRun.create).toContain('PIPELINE_WT_ACTION=create\n');
    expect(viaRun.finalize).toContain('PIPELINE_WT_ACTION=finalize\n');
    expect(viaRun.destroy).toContain('PIPELINE_WT_ACTION=destroy\n');

    // ---- the DIRECT path: the same inputs, no run, no emitter --------------
    // Every value here comes from the scaffold, not from the dumps above.
    const paths: WorktreeHookPaths = {
      hookDirAbs: join(root, '.pipeline', '.hooks'),
      projectRoot: root,
      pipelineRootAbs: resolve(s.pipelineRoot),
    };
    const submodules = ['AppX', 'McpY'];
    const wt = join(root, '.claude', 'worktrees', runId);

    const provisioned = runCreateHook(
      { run_id: runId, name: runId, base_branch: 'main', submodules, hook_dir: '.pipeline/.hooks' },
      paths,
      noopEmitter,
    );
    expect(provisioned.ok).toBe(true);
    expect(provisioned.provisioned).toEqual({
      worktree_path: wt,
      branch: `worktree-${runId}`,
      env_file: join(wt, '.worktree.env'),
    });

    const finalized = runFinalizeHook(
      { run_id: runId, name: runId, base_branch: 'main', submodules, worktree_path: wt, outcome: 'completed' },
      paths,
      noopEmitter,
    );
    expect(finalized).toEqual({ ok: true, detail: 'pushed 1 commit' });

    const destroyed = runDestroyHook(
      { run_id: runId, name: runId, worktree_path: wt, outcome: 'completed', delete_branches: true },
      paths,
      noopEmitter,
    );
    expect(destroyed).toEqual({ ok: true, detail: null });

    // ---- the assertion this whole file exists for --------------------------
    expect(canonicalWtEnv(root, 'create-env-dump.json')).toBe(viaRun.create);
    expect(canonicalWtEnv(root, 'finalize-env-dump.json')).toBe(viaRun.finalize);
    expect(canonicalWtEnv(root, 'destroy-env-dump.json')).toBe(viaRun.destroy);
  });
}, 30000);

// ---------------------------------------------------------------------------
// (2) THE EMITTER IS A PARAMETER
// ---------------------------------------------------------------------------

test('emitter isolation: a direct call with the no-op emitter writes NO run-scoped journal events; an injected emitter receives them instead', () => {
  const s = scaffold({});
  const runId = 'driftrun2';
  inProject(s.project, s.home, (root) => {
    const paths: WorktreeHookPaths = {
      hookDirAbs: join(root, '.pipeline', '.hooks'),
      projectRoot: root,
      pipelineRootAbs: resolve(s.pipelineRoot),
    };
    const req = { run_id: runId, name: runId, base_branch: 'main', submodules: [], hook_dir: '.pipeline/.hooks' };

    // Default parameter == the no-op: nothing journalled at all.
    expect(runCreateHook(req, paths).ok).toBe(true);
    expect(runCreateHook(req, paths, noopEmitter).ok).toBe(true);
    runDestroyHook({ run_id: runId, name: runId, worktree_path: null, outcome: 'halted', delete_branches: false }, paths, noopEmitter);
    expect(existsSync(eventsFile(root))).toBe(false);

    // Same call with an INJECTED emitter: the events are produced, they just go
    // where the caller says — still not to the run journal.
    const seen: Array<{ type: string; fields: Record<string, unknown> }> = [];
    runCreateHook(req, paths, (type, fields) => {
      seen.push({ type, fields: Object.fromEntries(fields.map(([k, v]) => [k, v])) });
    });
    expect(seen.length).toBe(1);
    expect(seen[0].type).toBe('worktree.created');
    expect(seen[0].fields.ok).toBe(true);
    expect(seen[0].fields.run_id).toBe(runId);
    expect(seen[0].fields.worktree_path).toBe(join(root, '.claude', 'worktrees', runId));
    expect(seen[0].fields.hook_dir).toBe('.pipeline/.hooks');
    expect(existsSync(eventsFile(root))).toBe(false);

    // And the RUN path still journals — the emitter parameter did not silence it.
    nextCall(s.pipelineRoot, runId);
    const events = readFileSync(eventsFile(root), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l: string) => JSON.parse(l));
    const createdEv = events.find((e) => e.type === 'worktree.created');
    expect(createdEv.data.ok).toBe(true);
    expect(createdEv.run_id).toBe(runId);
  });
}, 30000);

// ---------------------------------------------------------------------------
// (3) D9 REGRESSION GUARD
// ---------------------------------------------------------------------------

test('D9: an isolated run with no worktree-create.* still HALTS after the extraction — nothing provisioned, no auto-provisioner', () => {
  const s = scaffold({ createHook: null });
  const runId = 'driftrun3';
  inProject(s.project, s.home, (root) => {
    const r = nextCall(s.pipelineRoot, runId);
    expect(r.code).toBe(1);
    expect(r.json.action).toBe('halt');
    expect(r.json.status).toBe('halted');
    expect(r.json.reason).toContain('worktree-create hook failed');
    expect(r.json.reason).toContain('worktree-create.*');
    expect(r.json.provisioned).toBeUndefined();
    const st = JSON.parse(readFileSync(join(s.pipelineRoot, '.runtime', runId, 'next.json'), 'utf8'));
    expect(st.worktree_provisioned).toBe(false);
    expect(st.phase).toBe('terminal');
    // No worktree was invented on the way to the halt.
    expect(existsSync(join(root, 'create-env-dump.json'))).toBe(false);
  });
}, 30000);
