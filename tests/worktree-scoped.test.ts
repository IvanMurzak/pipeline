// Worktree-scoped pipeline I/O (P2/b3 — fix-fundamental-issues design 05.1;
// D3/D6/D14): command-level tests over REAL git worktrees.
//
// @serial: real git worktree/branch lifecycle suite — flaky under N-way
// parallel CPU contention (same class as event/submodule sandboxes); held out
// of the parallel pool and run one-at-a-time after it drains.
//
// Each test builds a real temp consumer git repo whose committed pipeline
// DIVERGES on a branch, with worktree hooks that do REAL `git worktree add` /
// `git add -A && git commit` / `git worktree remove`. The F5 regression drives
// a full external run end-to-end and proves the D3 kill: the run executes the
// BRANCH's pipeline definition from the run worktree, the improver edit lands
// in the worktree and rides the finalize commit, run artifacts never ride it
// (the .gitignore stubs), `git status --porcelain` on main stays EMPTY, and
// run bookkeeping (next.json/events/.stats) stays under the MAIN root with
// observability keyed on prefix-swapped MAIN paths.

import { test, expect, afterEach } from 'bun:test';
import { runNext } from '../src/commands/next';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { realGit } from '../src/lib/git';
// Shared real-git sandbox plumbing: PIPELINE_GIT_BIN pin (bypasses PATH git
// wrappers), core.hooksPath isolation (the host's identity-guard commit hooks
// must never fire in the sandboxes), realpath'd temp dirs, cleanup registry.
import { mkTmp, ident, cleanupCreated } from './_git-sandbox';

afterEach(cleanupCreated);

function git(cwd: string, ...args: string[]): string {
  const r = realGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// ---------------------------------------------------------------------------
// Real worktree hooks (plain JS — the interpreter map runs .js via bun)
// ---------------------------------------------------------------------------

/** Idempotent create hook: `git worktree add -B run-<name> <path> <base>`.
 *  Returns the EXISTING worktree on re-runs (the resume contract). */
const CREATE_HOOK = `
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const GIT = process.env.PIPELINE_GIT_BIN || 'git';
const proj = process.env.PIPELINE_WT_PROJECT_ROOT;
const name = process.env.PIPELINE_WT_NAME;
const wt = path.join(proj, '.claude', 'worktrees', name);
if (!fs.existsSync(wt)) {
  const r = spawnSync(GIT, ['worktree', 'add', '-B', 'run-' + name, wt, process.env.PIPELINE_WT_BASE_BRANCH], { cwd: proj, encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr || 'worktree add failed'); process.exit(1); }
}
process.stdout.write(JSON.stringify({ worktree_path: wt, branch: 'run-' + name, env_file: null }) + '\\n');
`;

/** Finalize hook: commit whatever the run left in the worktree. */
const FINALIZE_HOOK = `
const { spawnSync } = require('child_process');
const GIT = process.env.PIPELINE_GIT_BIN || 'git';
const wt = process.env.PIPELINE_WT_WORKTREE_PATH;
let r = spawnSync(GIT, ['add', '-A'], { cwd: wt, encoding: 'utf8' });
if (r.status === 0) r = spawnSync(GIT, ['commit', '--allow-empty', '-m', 'finalize ' + process.env.PIPELINE_WT_RUN_ID], { cwd: wt, encoding: 'utf8' });
if (r.status !== 0) { process.stderr.write(String(r.stderr)); process.stdout.write(JSON.stringify({ ok: false, detail: 'commit failed' }) + '\\n'); process.exit(0); }
process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
`;

/** Destroy hook: remove the worktree on EVERY outcome (so the
 *  plan-error-after-provision DoD — no leaked worktree — is observable). */
const DESTROY_HOOK = `
const { spawnSync } = require('child_process');
const GIT = process.env.PIPELINE_GIT_BIN || 'git';
const proj = process.env.PIPELINE_WT_PROJECT_ROOT;
const wt = process.env.PIPELINE_WT_WORKTREE_PATH;
if (wt) spawnSync(GIT, ['worktree', 'remove', '--force', wt], { cwd: proj, encoding: 'utf8' });
spawnSync(GIT, ['worktree', 'prune'], { cwd: proj, encoding: 'utf8' });
process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
`;

// ---------------------------------------------------------------------------
// Fixture: a git repo whose pipeline diverges on a branch
// ---------------------------------------------------------------------------

interface Fixture {
  project: string;
  home: string;
  pipelineRoot: string;
}

/**
 * main:   steps/01-step.md = "MAIN VERSION" (the only step)
 * wip:    steps/01-step.md = "BRANCH VERSION" + steps/02-extra.md (branch-only)
 * broken: steps/01-a.md + 02-b.md sharing one explicit step_id (plan error)
 * PIPELINE.md (main): isolation: external [+ base_branch: <opts.baseBranch>]
 */
function scaffold(opts: { baseBranch?: string } = {}): Fixture {
  const project = mkTmp('wtscope-');
  const home = mkTmp('wtscope-home-');
  git(project, 'init', '-q', '-b', 'main');
  ident(project); // sandbox identity + host-hook isolation (worktrees inherit)
  writeFileSync(
    join(project, '.gitignore'),
    ['.claude/worktrees/', '.claude/pipeline/.runtime/', '.claude/pipeline/.stats/', ''].join('\n'),
  );
  const pipelineRoot = join(project, '.claude', 'pipeline', 'demo');
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  const base = opts.baseBranch ? `\nbase_branch: ${opts.baseBranch}` : '';
  writeFileSync(join(pipelineRoot, 'PIPELINE.md'), `---\nisolation: external${base}\n---\n# P\n\n## End State\nx\n`);
  writeFileSync(join(pipelineRoot, 'steps', '01-step.md'), '# step 1\n\nMAIN VERSION\n');
  const hooksDir = join(project, '.claude', 'pipeline', '.hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'worktree-create.js'), CREATE_HOOK);
  writeFileSync(join(hooksDir, 'worktree-finalize.js'), FINALIZE_HOOK);
  writeFileSync(join(hooksDir, 'worktree-destroy.js'), DESTROY_HOOK);
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'main pipeline');
  // Branch with a DIVERGENT pipeline definition.
  git(project, 'checkout', '-q', '-b', 'wip');
  writeFileSync(join(pipelineRoot, 'steps', '01-step.md'), '# step 1\n\nBRANCH VERSION\n');
  writeFileSync(join(pipelineRoot, 'steps', '02-extra.md'), '# extra\n\nBRANCH-ONLY STEP\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'branch pipeline');
  // Branch with an INVALID pipeline definition (no iteration files at all —
  // the plan error the sequential mode lints unconditionally).
  git(project, 'checkout', '-q', '-b', 'broken', 'main');
  git(project, 'rm', '-q', '-r', '.claude/pipeline/demo/steps');
  git(project, 'commit', '-q', '-m', 'broken pipeline');
  git(project, 'checkout', '-q', 'main');
  return { project, home, pipelineRoot };
}

/** cwd → project, HOME/USERPROFILE → temp home, envelope vars cleared; the
 *  PIPELINE_WORKTREE_SCOPED env is left to each test (default = ON). */
function inProject<T>(f: Fixture, fn: (realProjectRoot: string) => T): T {
  const prevCwd = process.cwd();
  const keys = [
    'PIPELINE_UI_RUN_ID',
    'PIPELINE_UI_PARENT_RUN_ID',
    'CLAUDE_SESSION_ID',
    'PIPELINE_UI_DEBUG',
    'USERPROFILE',
    'HOME',
    'PIPELINE_WORKTREE_SCOPED',
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.chdir(f.project);
    delete process.env.PIPELINE_UI_RUN_ID;
    delete process.env.PIPELINE_UI_PARENT_RUN_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.PIPELINE_UI_DEBUG;
    delete process.env.PIPELINE_WORKTREE_SCOPED;
    process.env.USERPROFILE = f.home;
    process.env.HOME = f.home;
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
// F5 regression — the D3 kill, end to end
// ---------------------------------------------------------------------------

test('F5: branch-divergent pipeline — run executes the BRANCH definition from the worktree; improver edit rides finalize; main stays clean; bookkeeping stays main-scoped', () => {
  const f = scaffold({ baseBranch: 'wip' });
  const runId = 'wtscope1run1';
  inProject(f, (root) => {
    const mainRoot = join(root, '.claude', 'pipeline', 'demo');
    const wt = join(root, '.claude', 'worktrees', runId);
    const wtRoot = join(wt, '.claude', 'pipeline', 'demo');

    // ---- init: provision-at-init + worktree plan --------------------------
    const r1 = nextCall(f.pipelineRoot, runId);
    expect(r1.code).toBe(0);
    expect(r1.json.action).toBe('run-step');
    expect(r1.json.worktree_pipeline_root).toBe(wtRoot);
    expect(r1.json.provisioned.worktree_path).toBe(wt);
    // Dispatch path = the WORKTREE copy, and it is the BRANCH's definition.
    expect(r1.json.steps[0].path).toBe(join(wtRoot, 'steps', '01-step.md'));
    expect(readFileSync(r1.json.steps[0].path, 'utf8')).toContain('BRANCH VERSION');
    // source_path = the prefix-swapped MAIN author path (05.1.3).
    expect(r1.json.steps[0].source_path).toBe(join(mainRoot, 'steps', '01-step.md'));
    // External worktree context still threaded onto the step.
    expect(r1.json.steps[0].external_worktree).toBe(true);
    expect(r1.json.steps[0].worktree_path).toBe(wt);
    // .gitignore stubs written in the WORKTREE pipeline tree.
    expect(readFileSync(join(wtRoot, '.runtime', '.gitignore'), 'utf8')).toBe('*\n');
    expect(readFileSync(join(wtRoot, '.feedback', '.gitignore'), 'utf8')).toBe('*\n');
    // Bookkeeping stays MAIN-scoped: next.json under the main pipeline root,
    // carrying the frozen flag + the (worktree_prefix, main_prefix) pair.
    const st1 = JSON.parse(readFileSync(join(mainRoot, '.runtime', runId, 'next.json'), 'utf8'));
    expect(st1.worktree_scoped).toBe(true);
    expect(st1.worktree_pipeline_root).toBe(wtRoot);
    expect(st1.main_pipeline_root).toBe(mainRoot);
    expect(st1.current_path).toBe(join(wtRoot, 'steps', '01-step.md'));

    // ---- step 1 done with an improvement brief → improver targets the WT --
    const r2 = nextCall(
      f.pipelineRoot,
      runId,
      record({
        kind: 'step',
        outcome: 'completed',
        next_iteration: join(wtRoot, 'steps', '02-extra.md'),
        has_improvement_brief: true,
      }),
    );
    expect(r2.json.action).toBe('run-improver');
    expect(r2.json.iteration_path).toBe(join(wtRoot, 'steps', '01-step.md'));
    // Simulate the improver: edit the WORKTREE copy (its whole blast radius).
    appendFileSync(join(wtRoot, 'steps', '01-step.md'), '\nIMPROVED-BY-RUN\n');

    // ---- improver done → the BRANCH-ONLY step dispatches ------------------
    const r3 = nextCall(f.pipelineRoot, runId, record({ kind: 'improver', applied: true, script_briefs: 0 }));
    expect(r3.json.action).toBe('run-step');
    expect(r3.json.steps[0].path).toBe(join(wtRoot, 'steps', '02-extra.md'));
    expect(readFileSync(r3.json.steps[0].path, 'utf8')).toContain('BRANCH-ONLY STEP');
    expect(r3.json.steps[0].source_path).toBe(join(mainRoot, 'steps', '02-extra.md'));

    // Run artifacts + feedback land in the WORKTREE tree (stub coverage is
    // proven when finalize does NOT commit them).
    mkdirSync(join(wtRoot, '.runtime', runId), { recursive: true });
    writeFileSync(join(wtRoot, '.runtime', runId, 'junk.txt'), 'run artifact\n');
    writeFileSync(
      join(wtRoot, '.feedback', runId, '01-step-01.md'),
      '---\ncategory: doc-flaw\niteration: steps/01-step.md\nstep_id: 01-step\n---\n## Problem\nx\n',
    );

    // ---- last step done → retrospective gates on the WORKTREE feedback ----
    const r4 = nextCall(
      f.pipelineRoot,
      runId,
      record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }),
    );
    expect(r4.json.action).toBe('retrospective');

    // Snapshot the stats timeline BEFORE the terminal fold: step lines carry
    // MAIN paths and the buffer lives under the MAIN project's .stats tree.
    const statsBuf = join(root, '.claude', 'pipeline', '.stats', 'demo', 'runs', `${runId}.jsonl`);
    const statsLines = readFileSync(statsBuf, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const startedPaths = statsLines.filter((l) => l.k === 'step.started').map((l) => l.path);
    const completedPaths = statsLines.filter((l) => l.k === 'step.completed').map((l) => l.path);
    expect(startedPaths).toEqual([join(mainRoot, 'steps', '01-step.md'), join(mainRoot, 'steps', '02-extra.md')]);
    expect(completedPaths).toEqual(startedPaths);

    // ---- retro done → finalize commits the improver edit → teardown → done
    const r5 = nextCall(f.pipelineRoot, runId, record({ kind: 'retro', done: true }));
    expect(r5.code).toBe(0);
    expect(r5.json.action).toBe('done');
    expect(r5.json.finalized).toEqual({ ok: true, detail: null });
    expect(r5.json.teardown).toEqual({ ok: true, detail: null });

    // D3 DEAD: `git status --porcelain` on main is EMPTY after the run.
    expect(git(root, 'status', '--porcelain').trim()).toBe('');

    // The worktree was torn down; the run branch carries the finalize commit.
    expect(existsSync(wt)).toBe(false);
    const finalized = git(root, 'show', `run-${runId}:.claude/pipeline/demo/steps/01-step.md`);
    expect(finalized).toContain('BRANCH VERSION');
    expect(finalized).toContain('IMPROVED-BY-RUN');
    // The finalize commit contains ONLY the improver edit — run artifacts
    // (.runtime junk, .feedback problem file) never ride it (the stubs work).
    const names = git(root, 'show', '--name-only', '--format=', `run-${runId}`)
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(names).toEqual(['.claude/pipeline/demo/steps/01-step.md']);

    // Teardown survival: next.json remains under the MAIN root, terminal.
    const st2 = JSON.parse(readFileSync(join(mainRoot, '.runtime', runId, 'next.json'), 'utf8'));
    expect(st2.phase).toBe('terminal');
    expect(st2.status).toBe('completed');
    expect(st2.worktree_scoped).toBe(true);

    // Events (MAIN-rooted journal): started/completed pair on MAIN paths for
    // both steps; the improver pair is labeled with the MAIN path too.
    const events = readEvents(root);
    const iters = events.filter((e) => e.type === 'iteration.started' || e.type === 'iteration.completed');
    expect(iters.map((e) => [e.type, e.data.iteration_path])).toEqual([
      ['iteration.started', join(mainRoot, 'steps', '01-step.md')],
      ['iteration.completed', join(mainRoot, 'steps', '01-step.md')],
      ['iteration.started', join(mainRoot, 'steps', '02-extra.md')],
      ['iteration.completed', join(mainRoot, 'steps', '02-extra.md')],
    ]);
    const improverEvs = events.filter((e) => e.type.startsWith('improver.'));
    expect(improverEvs.map((e) => [e.type, e.data.iteration_path])).toEqual([
      ['improver.started', join(mainRoot, 'steps', '01-step.md')],
      ['improver.completed', join(mainRoot, 'steps', '01-step.md')],
    ]);
    // Terminal stats folded into the MAIN .stats tree.
    expect(existsSync(join(root, '.claude', 'pipeline', '.stats', 'demo', 'runs.jsonl'))).toBe(true);
  });
}, 120000);

// ---------------------------------------------------------------------------
// Flag freezing (D14 rollout flag semantics)
// ---------------------------------------------------------------------------

test('flag frozen per-run: a mid-run PIPELINE_WORKTREE_SCOPED=0 flip cannot switch a scoped run back to main paths', () => {
  const f = scaffold({ baseBranch: 'wip' });
  const runId = 'wtscope2run1';
  inProject(f, (root) => {
    const wtRoot = join(root, '.claude', 'worktrees', runId, '.claude', 'pipeline', 'demo');
    const r1 = nextCall(f.pipelineRoot, runId);
    expect(r1.json.steps[0].path).toBe(join(wtRoot, 'steps', '01-step.md'));
    // Mid-run flip OFF — the frozen value wins.
    process.env.PIPELINE_WORKTREE_SCOPED = '0';
    const r2 = nextCall(
      f.pipelineRoot,
      runId,
      record({ kind: 'step', outcome: 'completed', next_iteration: join(wtRoot, 'steps', '02-extra.md') }),
    );
    expect(r2.json.action).toBe('run-step');
    expect(r2.json.steps[0].path).toBe(join(wtRoot, 'steps', '02-extra.md'));
    expect(r2.json.worktree_pipeline_root).toBe(wtRoot);
  });
}, 120000);

test('flag-off run is legacy main-scoped and frozen: a mid-run flip ON cannot switch it to worktree paths', () => {
  const f = scaffold({ baseBranch: 'wip' });
  const runId = 'wtscope3run1';
  inProject(f, (root) => {
    const mainRoot = join(root, '.claude', 'pipeline', 'demo');
    process.env.PIPELINE_WORKTREE_SCOPED = '0';
    const r1 = nextCall(f.pipelineRoot, runId);
    expect(r1.json.action).toBe('run-step');
    // Legacy: dispatch on the MAIN tree (path === source_path), no scoped root.
    expect(r1.json.steps[0].path).toBe(join(mainRoot, 'steps', '01-step.md'));
    expect(r1.json.steps[0].source_path).toBe(r1.json.steps[0].path);
    expect(r1.json.worktree_pipeline_root).toBeUndefined();
    const st = JSON.parse(readFileSync(join(mainRoot, '.runtime', runId, 'next.json'), 'utf8'));
    expect(st.worktree_scoped).toBe(false);
    // Mid-run flip ON — the frozen (off) value wins: still main paths.
    delete process.env.PIPELINE_WORKTREE_SCOPED;
    const r2 = nextCall(
      f.pipelineRoot,
      runId,
      record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }),
    );
    expect(r2.json.action).toBe('done');
    const events = readEvents(root);
    const started = events.filter((e) => e.type === 'iteration.started');
    expect(started[0].data.iteration_path).toBe(join(mainRoot, 'steps', '01-step.md'));
  });
}, 120000);

// ---------------------------------------------------------------------------
// --start round trip: MAIN author paths map into the worktree
// ---------------------------------------------------------------------------

test('--start with a MAIN author path (the supervisor resume round trip) dispatches the WORKTREE copy — even for a branch-only step', () => {
  const f = scaffold({ baseBranch: 'wip' });
  const runId = 'wtscope6run1';
  inProject(f, (root) => {
    const mainRoot = join(root, '.claude', 'pipeline', 'demo');
    const wtRoot = join(root, '.claude', 'worktrees', runId, '.claude', 'pipeline', 'demo');
    // 02-extra exists ONLY on the branch: the supervisor's --start names it in
    // MAIN coordinates (source_path from a prior event) — the engine must
    // dispatch the WORKTREE copy.
    const r1 = nextCall(f.pipelineRoot, runId, ['--start', join(mainRoot, 'steps', '02-extra.md')]);
    expect(r1.code).toBe(0);
    expect(r1.json.action).toBe('run-step');
    expect(r1.json.steps[0].path).toBe(join(wtRoot, 'steps', '02-extra.md'));
    expect(r1.json.steps[0].source_path).toBe(join(mainRoot, 'steps', '02-extra.md'));
    // Finish cleanly.
    const r2 = nextCall(
      f.pipelineRoot,
      runId,
      record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }),
    );
    expect(r2.json.action).toBe('done');
  });
}, 120000);

// ---------------------------------------------------------------------------
// Init-failure teardown (05.1.1) — plan-error-after-provision leaves no worktree
// ---------------------------------------------------------------------------

test('plan-error-after-provision: destroy hook runs with outcome=halted, no worktree leaks, run parks terminal with the worktree plan errors', () => {
  const f = scaffold({ baseBranch: 'broken' });
  const runId = 'wtscope4run1';
  inProject(f, (root) => {
    const wt = join(root, '.claude', 'worktrees', runId);
    const r1 = nextCall(f.pipelineRoot, runId);
    expect(r1.code).toBe(1);
    expect(r1.json.action).toBe('halt');
    expect(r1.json.reason).toContain('worktree pipeline plan errors');
    expect(r1.json.reason).toContain('No iteration files found');
    // The provision happened — and the destroy hook reaped it (no leak).
    expect(r1.json.provisioned.worktree_path).toBe(wt);
    expect(existsSync(wt)).toBe(false);
    const destroyed = readEvents(root).find((e) => e.type === 'worktree.destroyed');
    expect(destroyed.data.ok).toBe(true);
    expect(destroyed.data.outcome).toBe('halted');
    // State parked terminal with the halt reason (crash-safe, resumable-not).
    const st = JSON.parse(
      readFileSync(join(root, '.claude', 'pipeline', 'demo', '.runtime', runId, 'next.json'), 'utf8'),
    );
    expect(st.phase).toBe('terminal');
    expect(st.status).toBe('halted');
  });
}, 120000);

// ---------------------------------------------------------------------------
// D14 committed-state caveat — dirty main pipeline dir preflight warning
// ---------------------------------------------------------------------------

test('dirty main pipeline dir: init warns (D14) and the run executes the COMMITTED state, not the dirty edit', () => {
  const f = scaffold(); // base_branch defaults to main
  const runId = 'wtscope5run1';
  inProject(f, (root) => {
    // Dirty the MAIN tree's pipeline dir (uncommitted edit).
    appendFileSync(join(f.pipelineRoot, 'steps', '01-step.md'), '\nUNCOMMITTED EDIT\n');
    const r1 = nextCall(f.pipelineRoot, runId);
    expect(r1.code).toBe(0);
    expect(r1.json.action).toBe('run-step');
    expect(Array.isArray(r1.json.warnings)).toBe(true);
    expect(r1.json.warnings.join(' ')).toContain('uncommitted change');
    // The worktree materializes COMMITTED state only.
    const dispatched = readFileSync(r1.json.steps[0].path, 'utf8');
    expect(dispatched).toContain('MAIN VERSION');
    expect(dispatched).not.toContain('UNCOMMITTED EDIT');
    // Finish the run so the fixture tears down cleanly.
    const r2 = nextCall(
      f.pipelineRoot,
      runId,
      record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }),
    );
    expect(r2.json.action).toBe('done');
  });
}, 120000);
