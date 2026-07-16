// `pipeline gc` — read-only report + default-branch ladder + usage errors
// (shard 1/4; sandbox helpers + rationale in _gc-world.ts).

import { test, expect, afterEach } from 'bun:test';
import { writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { byBase, callGc, callGcJson, cleanupCreated, ident, mkRepo, mkTmp, scaffoldLeaks, sh } from './_gc-world';

afterEach(cleanupCreated);

// ---------------------------------------------------------------------------
// report — clean repo
// ---------------------------------------------------------------------------

test('gc report on a leak-free repo: all sections empty, cleaned null, "no leaks detected"', () => {
  const root = mkRepo();
  const j = callGcJson(['--project', root]);
  expect(j.code).toBe(0);
  expect(j.report.default_branch).toBe('main');
  expect(j.report.worktrees).toEqual([]);
  expect(j.report.stale_dirs).toEqual([]);
  expect(j.report.prunable).toEqual([]);
  expect(j.report.branches).toEqual([]);
  expect(j.report.cleaned).toBeNull();

  const h = callGc(['--project', root]);
  expect(h.code).toBe(0);
  expect(h.out).toContain('no leaks detected');
}, 60000);

// ---------------------------------------------------------------------------
// report — the leak zoo
// ---------------------------------------------------------------------------

test('gc report: registered worktrees with merged flags, stale dirs, prunable records, orphaned worktree-* branches', () => {
  const root = mkRepo();
  const { wtDir } = scaffoldLeaks(root);
  const { code, report } = callGcJson(['--project', root]);
  expect(code).toBe(0);
  expect(report.cleaned).toBeNull();
  expect(report.default_branch).toBe('main');

  // Registered worktrees under .claude/worktrees (the main checkout is NOT one).
  const runA = byBase(report.worktrees, 'run-a')!;
  const runB = byBase(report.worktrees, 'run-b')!;
  const runC = byBase(report.worktrees, 'run-c')!;
  const runD = byBase(report.worktrees, 'run-d')!;
  expect(report.worktrees.length).toBe(4);
  expect(runA.branch).toBe('worktree-run-a');
  expect(runA.merged).toBe(true);
  expect(runB.branch).toBe('worktree-run-b');
  expect(runB.merged).toBe(false);
  expect(runC.branch).toBe('worktree-run-c'); // record survives the deleted dir
  expect(runC.merged).toBe(true);
  expect(runD.branch).toBeNull(); // detached
  expect(runD.merged).toBeNull();

  // Stale dirs: only the never-registered one (run-c's dir is GONE, not stale).
  expect(report.stale_dirs.map((d) => basename(d))).toEqual(['stale-x']);

  // Prunable: run-c's record shows up in `git worktree prune --dry-run -v`.
  expect(report.prunable.length).toBeGreaterThanOrEqual(1);
  expect(report.prunable.join('\n')).toContain('run-c');

  // Orphaned worktree-* branches: the two orphans (attached branches excluded).
  expect(report.branches.map((b) => b.branch).sort()).toEqual([
    'worktree-orphan-m',
    'worktree-orphan-u',
  ]);
  expect(report.branches.find((b) => b.branch === 'worktree-orphan-m')!.merged).toBe(true);
  expect(report.branches.find((b) => b.branch === 'worktree-orphan-u')!.merged).toBe(false);

  // Report is READ-ONLY: nothing was pruned, removed, or deleted.
  expect(existsSync(join(wtDir, 'run-a'))).toBe(true);
  expect(existsSync(join(wtDir, 'stale-x'))).toBe(true);
  expect(sh(['branch', '--list', 'worktree-*'], root)).toContain('worktree-orphan-m');

  // Human mode carries the squash-merge caveat on the branch section.
  const h = callGc(['--project', root]);
  expect(h.out).toContain('squash-merged');
  expect(h.out).not.toContain('no leaks detected');
}, 120000);

// ---------------------------------------------------------------------------
// default-branch resolution ladder
// ---------------------------------------------------------------------------

test('gc default branch: origin/HEAD symref wins when resolvable (local bare origin, no network)', () => {
  const root = mkRepo();
  const bare = mkTmp('gcbare-');
  sh(['init', '-q', '--bare'], bare);
  sh(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare); // the bare origin's default
  sh(['remote', 'add', 'origin', bare], root);
  sh(['push', '-q', '-u', 'origin', 'main'], root);
  sh(['remote', 'set-head', 'origin', '--auto'], root); // sets refs/remotes/origin/HEAD
  sh(['branch', 'worktree-z'], root); // merged orphan, judged against origin/main
  const { report } = callGcJson(['--project', root]);
  expect(report.default_branch).toBe('origin/main');
  expect(report.branches).toEqual([{ branch: 'worktree-z', merged: true }]);
}, 60000);

test('gc default branch: falls back to master when there is no origin/HEAD and no main', () => {
  const root = mkTmp('gcrepo-');
  sh(['init', '-q', '-b', 'master'], root);
  ident(root);
  writeFileSync(join(root, 'f.txt'), 'x\n');
  sh(['add', '.'], root);
  sh(['commit', '-q', '-m', 'init'], root);
  sh(['branch', 'worktree-old'], root);
  const { report } = callGcJson(['--project', root]);
  expect(report.default_branch).toBe('master');
  expect(report.branches).toEqual([{ branch: 'worktree-old', merged: true }]);
}, 60000);

// ---------------------------------------------------------------------------
// usage / non-repo
// ---------------------------------------------------------------------------

test('gc usage errors: unknown flag, a non-repo --project, and --force-worktree-branches without --clean all exit 2', () => {
  expect(callGc(['--bogus']).code).toBe(2);
  const notRepo = mkTmp('gcnotrepo-');
  expect(callGc(['--project', notRepo]).code).toBe(2);
  expect(callGc(['--force-worktree-branches']).code).toBe(2); // requires --clean
}, 60000);
