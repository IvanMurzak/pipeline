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
// The SECOND caller is the standalone `pipeline worktree` command group
// (taskflow-v2 a2). It is compared against the run path here rather than in its
// own suite, on purpose: a frozen contract should have exactly ONE place that
// compares its callers, or the comparison itself forks. Two documented values
// differ — `PIPELINE_WT_PIPELINE_ROOT` and `PIPELINE_WT_PIPELINE_NAME` are the
// empty string outside a run — and that difference is asserted, not excused, so
// a THIRD divergence cannot hide behind it.
//
// Also covered:
//   - emitter isolation: the emitter is a PARAMETER, and the no-op writes no
//     run-scoped journal events (a run-less caller must not fabricate history
//     for a run that does not exist), for the direct module call AND for the
//     command, including in a project that has a real run journal;
//   - a slot name unrelated to any run id — the run path has always had
//     name === run_id, so the standalone combination needs its own test;
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
import { runWorktree } from '../src/commands/worktree';
import {
  runCreateHook,
  runFinalizeHook,
  runDestroyHook,
  noopEmitter,
  type WorktreeHookPaths,
} from '../src/lib/worktree-hooks';
import { realGit } from '../src/lib/git';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
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
 *  scripts. `createHook: null` omits the create hook and `destroyHook: null`
 *  the destroy hook (the two D9 guards — a3's provisioner and a5's teardown). */
function scaffold(
  opts: { createHook?: string | null; destroyHook?: string | null; submodules?: string } = {},
): Scaffold {
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
  if (opts.destroyHook !== null) writeFileSync(join(hooksDir, 'worktree-destroy.js'), opts.destroyHook ?? DESTROY_HOOK);
  return { project, home, pipelineRoot };
}

/** cwd → the project, HOME/USERPROFILE → a temp home, worktree scoping pinned
 *  off (these fake hooks return worktree paths with no pipeline copy in them —
 *  the same choice tests/hooks.test.ts makes). Restores everything after. */
function inProject<T>(project: string, home: string, fn: (realProjectRoot: string) => T): T {
  const prevCwd = process.cwd();
  const keys = ['PIPELINE_RUN_ID', 'PIPELINE_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'USERPROFILE', 'HOME', 'PIPELINE_WORKTREE_SCOPED', 'PIPELINE_WT_ROOT'];
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
    // Where the a3 provisioner WOULD put a slot if it were ever reached. Pinned
    // to a temp dir so the D9 guard below can assert that nothing appeared
    // there — and so a leak would be a visible file, not a write into the
    // developer's real slot root.
    process.env.PIPELINE_WT_ROOT = mkTmp('wtprovroot-');
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

/** Run the standalone command in-process, capturing stdout + its exit code.
 *  The SECOND caller of the shared module. */
function worktreeCall(args: string[]): { code: number; out: string } {
  let buf = '';
  const orig = process.stdout.write;
  (process.stdout as any).write = (chunk: unknown) => {
    buf += String(chunk);
    return true;
  };
  let code: number;
  try {
    code = runWorktree(args);
  } finally {
    (process.stdout as any).write = orig;
  }
  return { code, out: buf };
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
// (1b) THE SAME TEST, FOR THE STANDALONE COMMAND
// ---------------------------------------------------------------------------

/** The two variables a run-less caller cannot fill. Dropped from the byte
 *  comparison and asserted SEPARATELY below, so "the standalone context
 *  differs" can never grow to cover a third variable silently. */
const STANDALONE_EMPTY = ['PIPELINE_WT_PIPELINE_ROOT', 'PIPELINE_WT_PIPELINE_NAME'] as const;

function withoutPipelineIdentity(canonical: string): string {
  return canonical
    .split('\n')
    .filter((line) => !STANDALONE_EMPTY.some((k) => line.startsWith(`${k}=`)))
    .join('\n');
}

test('anti-drift: `pipeline worktree` hands the hook the run path\'s own PIPELINE_WT_* — every variable but the two documented standalone ones (create · finalize · destroy)', () => {
  const s = scaffold({ submodules: 'AppX, McpY' });
  const runId = 'driftrun4';
  inProject(s.project, s.home, (root) => {
    // ---- the RUN path: init (create) → completion (finalize → destroy) -----
    expect(nextCall(s.pipelineRoot, runId).json.action).toBe('run-step');
    const r2 = nextCall(
      s.pipelineRoot,
      runId,
      record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }),
    );
    expect(r2.json.action).toBe('done');

    const viaRun = {
      create: canonicalWtEnv(root, 'create-env-dump.json'),
      finalize: canonicalWtEnv(root, 'finalize-env-dump.json'),
      destroy: canonicalWtEnv(root, 'destroy-env-dump.json'),
    };
    // Not vacuous: on the run path these two variables carry real values.
    expect(viaRun.create).toContain(`PIPELINE_WT_PIPELINE_ROOT=${resolve(s.pipelineRoot)}\n`);
    expect(viaRun.create).toContain('PIPELINE_WT_PIPELINE_NAME=demo\n');

    // ---- the COMMAND: same inputs, no run, no emitter ----------------------
    // Everything comes from the scaffold + the documented flag surface.
    expect(worktreeCall(['create', '--name', runId, '--base', 'main', '--submodules', 'AppX,McpY']).code).toBe(0);
    expect(worktreeCall(['finalize', '--name', runId]).code).toBe(0);
    expect(worktreeCall(['destroy', '--name', runId, '--outcome', 'completed']).code).toBe(0);

    const viaCommand = {
      create: canonicalWtEnv(root, 'create-env-dump.json'),
      finalize: canonicalWtEnv(root, 'finalize-env-dump.json'),
      destroy: canonicalWtEnv(root, 'destroy-env-dump.json'),
    };

    // The assertion this extension exists for: identical everywhere else.
    for (const action of ['create', 'finalize', 'destroy'] as const) {
      expect(withoutPipelineIdentity(viaCommand[action])).toBe(withoutPipelineIdentity(viaRun[action]));
    }

    // And the documented difference, stated as an assertion rather than an
    // exclusion: wherever the RUN path carries one of these two variables, the
    // command carries it too (same key set — the destroy contract lists no
    // PIPELINE_NAME, and the command must not invent one) and its value is
    // EMPTY, never absent.
    for (const action of ['create', 'finalize', 'destroy'] as const) {
      for (const key of STANDALONE_EMPTY) {
        const onRunPath = viaRun[action].includes(`${key}=`);
        expect(`${action}/${key} present=${viaCommand[action].includes(`${key}=`)}`).toBe(
          `${action}/${key} present=${onRunPath}`,
        );
        if (onRunPath) {
          expect(`${action}/${key} empty=${viaCommand[action].includes(`${key}=\n`)}`).toBe(
            `${action}/${key} empty=true`,
          );
        }
      }
    }
    // PIPELINE_WT_NAME is NOT one of them — it is the slot identity the frozen
    // contract makes create idempotent per, so emptying it would collapse every
    // standalone slot onto one.
    const createEnv = JSON.parse(readFileSync(join(root, 'create-env-dump.json'), 'utf8')) as Record<string, string>;
    expect(createEnv.PIPELINE_WT_NAME).toBe(runId);
    expect(createEnv.PIPELINE_WT_RUN_ID).toBe(runId);
  });
}, 60000);

test('a --name unrelated to any run id: the command provisions its own slot in a project that HAS a run, and adds nothing to that run\'s journal', () => {
  const s = scaffold({});
  const runId = 'driftrun5';
  inProject(s.project, s.home, (root) => {
    // A real run first: it provisions slot `driftrun5` and journals it.
    expect(nextCall(s.pipelineRoot, runId).json.action).toBe('run-step');
    const journalBefore = readFileSync(eventsFile(root), 'utf8');
    expect(journalBefore).toContain('worktree.created');

    // Now a slot whose name is not any run id — a combination the run path has
    // never produced (name has always equalled run_id there).
    const name = 'a2-worktree-command-group';
    const created = JSON.parse(worktreeCall(['create', '--name', name, '--json']).out);
    expect(created.ok).toBe(true);
    expect(created.name).toBe(name);
    expect(created.worktree_path).toBe(join(root, '.claude', 'worktrees', name));
    expect(created.worktree_path).not.toBe(join(root, '.claude', 'worktrees', runId));

    const env = JSON.parse(readFileSync(join(root, 'create-env-dump.json'), 'utf8')) as Record<string, string>;
    expect(env.PIPELINE_WT_NAME).toBe(name);
    expect(env.PIPELINE_WT_RUN_ID).toBe(name); // no run id exists; the slot name stands in

    expect(worktreeCall(['finalize', '--name', name]).code).toBe(0);
    expect(worktreeCall(['destroy', '--name', name, '--outcome', 'halted']).code).toBe(0);

    // The run's journal is byte-for-byte what it was: no worktree.created for a
    // slot no run owns, no fabricated run_id.
    expect(readFileSync(eventsFile(root), 'utf8')).toBe(journalBefore);
  });
}, 60000);

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

    // ---- a3: the BUILT-IN PROVISIONER IS NOT REACHABLE FROM HERE ------------
    // The provisioner exists now (lib/worktree-provision.ts) and would have
    // provisioned this exact slot had the standalone command asked. The run
    // path must still halt instead, so: nothing under the slot root it would
    // have used, no `worktree-<run>` branch, and no second registered worktree.
    expect(readdirSync(process.env.PIPELINE_WT_ROOT!)).toEqual([]);
    expect(realGit(['branch', '--list', `worktree-${runId}`], root).stdout.trim()).toBe('');
    expect(realGit(['worktree', 'list', '--porcelain'], root).stdout.match(/^worktree /gm)?.length ?? 0).toBe(1);
  });
}, 30000);

test('D9: a run whose repository has no worktree-destroy.* still reports a FAILED teardown — teardown is not the back door either (a5)', () => {
  // a5 gave the standalone command a built-in TEARDOWN for a missing
  // `worktree-destroy.*`. D9 says the run path must not acquire it: a run that
  // silently reaped a slot the consumer meant to keep is the same class of
  // change as a run that silently provisions one.
  const s = scaffold({ destroyHook: null });
  const runId = 'driftrun6';
  inProject(s.project, s.home, (root) => {
    expect(nextCall(s.pipelineRoot, runId).json.action).toBe('run-step');
    const r2 = nextCall(
      s.pipelineRoot,
      runId,
      record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }),
    );
    expect(r2.json.action).toBe('done');
    // The run finalized (that hook exists) and then FAILED its teardown, with
    // the same message it printed before a5 existed.
    expect(r2.json.finalized).toEqual({ ok: true, detail: 'pushed 1 commit' });
    expect(r2.json.teardown.ok).toBe(false);
    expect(r2.json.teardown.detail).toContain('worktree-destroy.*');
    expect(r2.json.teardown.detail).toContain('no ');
    // And nothing of the built-in path ran on the way: the slot root it would
    // have used is empty, and no slot record was written for the run.
    expect(readdirSync(process.env.PIPELINE_WT_ROOT!)).toEqual([]);
    expect(existsSync(join(root, '.pipeline', '.runtime', 'worktrees'))).toBe(false);
  });
}, 60000);

test('D9, structurally: the run path does not IMPORT the provisioner OR the teardown — the standalone command is their only caller', () => {
  const src = (rel: string): string => readFileSync(join(import.meta.dir, '..', 'src', rel), 'utf8');
  // A runtime halt proves this run did not provision; the import graph proves
  // no run ever can. A future edit that wires either half into the engine fails
  // HERE, before anyone has to notice a silent provision — or a silent reap —
  // in production.
  for (const rel of ['commands/next.ts', 'lib/worktree-hooks.ts', 'lib/next.ts']) {
    expect(`${rel}: ${/from '.*worktree-provision'/.test(src(rel)) ? 'IMPORTS' : 'clean'}`).toBe(`${rel}: clean`);
    for (const fn of ['provisionSlot(', 'teardownSlot(']) {
      expect(`${rel} ${fn}: ${src(rel).includes(fn) ? 'CALLS' : 'clean'}`).toBe(`${rel} ${fn}: clean`);
    }
  }
  // Not vacuous, in BOTH directions: the standalone command really does import
  // the module and really does call each half, so a rename that silences the
  // checks above fails here instead — and a teardown that quietly moved to
  // another module (where the loop above would no longer see it) fails here too.
  const cmd = src('commands/worktree.ts');
  expect(/from '..\/lib\/worktree-provision'/.test(cmd)).toBe(true);
  expect(cmd.includes('provisionSlot(')).toBe(true);
  expect(cmd.includes('teardownSlot(')).toBe(true);
  // The teardown lives in the module the import check names — otherwise
  // "commands/next.ts does not import worktree-provision" would stop meaning
  // "commands/next.ts cannot reach the teardown".
  const provision = src('lib/worktree-provision.ts');
  expect(provision.includes('export function teardownSlot(')).toBe(true);
});
