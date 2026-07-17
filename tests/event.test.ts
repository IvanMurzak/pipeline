// Golden tests for the event writer (src/lib/event.ts), the runtime UI event
// emitter behind `pipeline event`.
//
// Pure-TS golden: envelope shape / kv coercion / worktree-detection assertions
// run in-process with cwd + env temporarily swapped to a per-test temp git repo
// and a per-test temp HOME, so the mirror-binding / liveness / daemon paths
// never touch the real ~/.claude/pipeline-ui/.
//
// HOME isolation: every case points USERPROFILE/HOME at a per-test temp dir so
// the lib resolves the home dir from process.env first (matching
// analytics_relay.ts).
//
// @serial: real git + temp-dir lifecycle suite — flaky under N-way parallel CPU
// contention; held out of the parallel pool and run in the serial phase
// (scripts/parallel-tests.ts).

import { test, expect, afterEach, describe } from 'bun:test';
import { emitEvent, parseKvArgs } from '../src/lib/event';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const created: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

/** Canonical git-reported top-level path for an existing worktree/repo dir —
 *  NOT realpathSync, which does not reliably expand Windows 8.3 short-name
 *  path segments (e.g. a CI runner whose profile resolves to `RUNNER~1` while
 *  git always reports the long `runneradmin` form via `--show-toplevel`, same
 *  as `worktree list --porcelain`). Use wherever a test-constructed path is
 *  compared against a value the library derived from git. */
function gitTopLevel(dir: string): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) {
    throw new Error(`git rev-parse --show-toplevel failed at ${dir}: ${r.stderr}`);
  }
  const tl = r.stdout.trim();
  return process.platform === 'win32' ? tl.replace(/\//g, '\\') : tl;
}

/** A real git repo so resolveProjectRoot resolves to it. */
function mkGitRepo(): string {
  const root = mkTmp('evt-');
  const r = spawnSync('git', ['init', '-q'], { cwd: root });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  return gitTopLevel(root);
}

afterEach(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EVENTS_REL = join('.claude', 'pipeline', '.runtime', 'events.jsonl');

/** A controlled env: clears the writer's envelope env vars + debug, points HOME
 *  at `home`, and keeps PATH so git/bun resolve. */
function controlledEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PIPELINE_UI_RUN_ID;
  delete env.PIPELINE_UI_PARENT_RUN_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.PIPELINE_UI_DEBUG;
  env.USERPROFILE = home;
  env.HOME = home;
  return { ...env, ...extra };
}

/** Run the TS lib in-process, but with cwd + env temporarily swapped to the
 *  controlled values. Restores both afterward. */
function runTs(fn: () => number, cwd: string, env: Record<string, string | undefined>): void {
  const prevCwd = process.cwd();
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  // Also save the keys we explicitly clear so they restore correctly.
  for (const k of ['PIPELINE_UI_RUN_ID', 'PIPELINE_UI_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'PIPELINE_UI_DEBUG', 'USERPROFILE', 'HOME']) {
    if (!(k in saved)) saved[k] = process.env[k];
  }
  try {
    process.chdir(cwd);
    // Clear the writer's envelope env vars, then apply overrides.
    delete process.env.PIPELINE_UI_RUN_ID;
    delete process.env.PIPELINE_UI_PARENT_RUN_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.PIPELINE_UI_DEBUG;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Golden tests — kv parsing
// ---------------------------------------------------------------------------

describe('golden — kv parsing', () => {
  test('coercion: null/bool/int/string + project-root override forms', () => {
    const a = parseKvArgs([
      '--project-root=/abs',
      'a=null',
      'b=true',
      'c=false',
      'd=3',
      'e=-7',
      'f=01',
      'g=1.5',
      'h=1e3',
      'i=hello',
      'j=claude-opus-4-8',
    ]);
    expect(a.projectRootOverride).toBe('/abs');
    expect(a.data).toEqual({
      a: null,
      b: true,
      c: false,
      d: 3,
      e: -7,
      f: 1, // Python int("01") == 1
      g: '1.5',
      h: '1e3',
      i: 'hello',
      j: 'claude-opus-4-8',
    });
  });

  test('--project-root space form', () => {
    const a = parseKvArgs(['--project-root', '/x/y', 'k=v']);
    expect(a.projectRootOverride).toBe('/x/y');
    expect(a.data).toEqual({ k: 'v' });
  });

  test('malformed arg without = is ignored', () => {
    const a = parseKvArgs(['noeq', 'k=v']);
    expect(a.data).toEqual({ k: 'v' });
  });

  test('value containing = keeps everything after the first =', () => {
    const a = parseKvArgs(['url=http://x/y?a=b']);
    expect(a.data).toEqual({ url: 'http://x/y?a=b' });
  });
});

describe('golden — envelope shape', () => {
  test('envelope key order, schema, compact data, worktree null', () => {
    const home = mkTmp('home-');
    const repo = mkGitRepo();
    runTs(
      () => emitEvent('iteration.started', ['index=3', 'run_id=abc', 'resolved_model=opus']),
      repo,
      controlledEnv(home),
    );
    const raw = readFileSync(join(repo, EVENTS_REL), 'utf-8').trim();
    // Compact: no ", " or ": " spacing anywhere.
    expect(raw.includes(', ')).toBe(false);
    expect(raw.includes('": ')).toBe(false);
    const ev = JSON.parse(raw);
    expect(Object.keys(ev)).toEqual([
      'schema',
      'ts',
      'type',
      'project_root',
      'worktree',
      'run_id',
      'parent_run_id',
      'session_id',
      'data',
    ]);
    expect(ev.schema).toBe(4);
    expect(ev.type).toBe('iteration.started');
    expect(ev.worktree).toBeNull();
    expect(ev.run_id).toBe('abc');
    expect(ev.parent_run_id).toBeNull();
    expect(ev.session_id).toBeNull();
    expect(ev.data).toEqual({ index: 3, resolved_model: 'opus' });
    // Trailing newline written.
    expect(readFileSync(join(repo, EVENTS_REL), 'utf-8').endsWith('\n')).toBe(true);
  });

  test('numeric run_id kv is stringified in the envelope', () => {
    const home = mkTmp('home-');
    const repo = mkGitRepo();
    runTs(() => emitEvent('iteration.started', ['run_id=123', 'index=1']), repo, controlledEnv(home));
    const ev = JSON.parse(readFileSync(join(repo, EVENTS_REL), 'utf-8').trim());
    expect(ev.run_id).toBe('123');
    expect(typeof ev.run_id).toBe('string');
    // run_id popped out of data.
    expect(ev.data).toEqual({ index: 1 });
  });

  test('always returns 0', () => {
    const home = mkTmp('home-');
    const repo = mkGitRepo();
    let rc = -1;
    runTs(() => (rc = emitEvent('x.y', ['a=b'])), repo, controlledEnv(home));
    expect(rc).toBe(0);
  });
});

describe('golden — additive worktree.* event types (no emitter change)', () => {
  // The two new event types for `isolation: external` are emitted through the
  // SAME generic `pipeline event` path as every other type — emitEvent takes a
  // plain string, so no emitter code change is needed. These tests prove the
  // envelope is a well-formed schema:4 record carrying the worktree data.
  test('worktree.created writes a well-formed schema:4 envelope', () => {
    const home = mkTmp('home-');
    const repo = mkGitRepo();
    runTs(
      () =>
        emitEvent('worktree.created', [
          'run_id=abc123def456',
          'worktree_path=/abs/wt/abc123def456',
          'branch=worktree-abc123def456',
          'env_file=/abs/wt/abc123def456/.worktree.env',
          'port_base=5100',
          'ok=true',
          'hook_dir=/abs/.claude/pipeline/.hooks',
        ]),
      repo,
      controlledEnv(home),
    );
    const ev = JSON.parse(readFileSync(join(repo, EVENTS_REL), 'utf-8').trim());
    expect(Object.keys(ev)).toEqual([
      'schema',
      'ts',
      'type',
      'project_root',
      'worktree',
      'run_id',
      'parent_run_id',
      'session_id',
      'data',
    ]);
    expect(ev.schema).toBe(4);
    expect(ev.type).toBe('worktree.created');
    expect(ev.run_id).toBe('abc123def456');
    // run_id popped out of data; everything else stays in data with coercion.
    expect(ev.data).toEqual({
      worktree_path: '/abs/wt/abc123def456',
      branch: 'worktree-abc123def456',
      env_file: '/abs/wt/abc123def456/.worktree.env',
      port_base: 5100,
      ok: true,
      hook_dir: '/abs/.claude/pipeline/.hooks',
    });
  });

  test('worktree.destroyed writes a well-formed schema:4 envelope (null + outcome)', () => {
    const home = mkTmp('home-');
    const repo = mkGitRepo();
    runTs(
      () =>
        emitEvent('worktree.destroyed', [
          'run_id=abc123def456',
          'worktree_path=null',
          'ok=false',
          'outcome=halted',
          'detail=lock held',
        ]),
      repo,
      controlledEnv(home),
    );
    const ev = JSON.parse(readFileSync(join(repo, EVENTS_REL), 'utf-8').trim());
    expect(ev.schema).toBe(4);
    expect(ev.type).toBe('worktree.destroyed');
    expect(ev.run_id).toBe('abc123def456');
    expect(ev.data).toEqual({
      worktree_path: null,
      ok: false,
      outcome: 'halted',
      detail: 'lock held',
    });
  });

  test('emitting worktree.* always returns 0 (no emitter change needed)', () => {
    const home = mkTmp('home-');
    const repo = mkGitRepo();
    let rc = -1;
    runTs(() => (rc = emitEvent('worktree.created', ['run_id=z', 'ok=true'])), repo, controlledEnv(home));
    expect(rc).toBe(0);
  });
});

describe('golden — worktree detection', () => {
  test('git worktree resolves to main repo + records worktree tag', () => {
    const home = mkTmp('home-');
    const main = mkGitRepo();
    // Create a commit so `git worktree add` has a base.
    spawnSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: main });
    const wtParent = mkTmp('wt-');
    const wtPath = join(wtParent, 'wt1');
    const add = spawnSync('git', ['worktree', 'add', '-q', '--detach', wtPath], { cwd: main });
    if (add.status !== 0) {
      // Some environments disallow worktrees in temp; skip the assertion.
      return;
    }
    created.push(wtPath);
    runTs(() => emitEvent('iteration.started', ['index=1', 'run_id=wt']), wtPath, controlledEnv(home));
    // Event lands in the MAIN repo's journal (worktree events route to main).
    const ev = JSON.parse(readFileSync(join(main, EVENTS_REL), 'utf-8').trim());
    // project_root is read back from git's own gitdir/commondir FILE CONTENT
    // (always git's long-canonical form) — compare against the git-resolved
    // `main`. worktree is `resolve(process.cwd())` verbatim inside the lib
    // (never touches git's own path resolution), so it stays in whatever form
    // the caller's cwd was (here, the raw un-canonicalized wtPath) — compare
    // against that directly rather than a git-canonicalized value.
    expect(resolve(ev.project_root as string)).toBe(resolve(main));
    expect(resolve(ev.worktree as string)).toBe(resolve(wtPath));
  });
});
