// `pipeline gc` — submodule scanning, report side + --no-submodules
// (shard 3/4; sandbox helpers + rationale in _gc-world.ts). Submodules are the
// production leak pattern: runs provision worktrees in every declared
// submodule; each crashed run leaks one worktree-* branch per repo.

import { test, expect, afterEach } from 'bun:test';
import { basename } from 'node:path';
import { byBase, callGc, callGcJson, cleanupCreated, mkSuperWithSub } from './_gc-world';

afterEach(cleanupCreated);

test('gc report scans submodules by default: per-submodule default branch, leaked worktrees/branches/prunables, skipped count, protected stale dirs', () => {
  const { root } = mkSuperWithSub();
  const { code, report } = callGcJson(['--project', root]);
  expect(code).toBe(0);
  expect(report.cleaned).toBeNull();

  // Superproject sections: unchanged shape — only its own orphan branch leaks,
  // and the live submodule worktree dir is PROTECTED, not a stale dir.
  expect(report.default_branch).toBe('main');
  expect(report.worktrees).toEqual([]);
  expect(report.stale_dirs).toEqual([]);
  expect(report.branches).toEqual([{ branch: 'worktree-super-u', merged: false }]);

  // Submodule scan: Sub scanned, Sub2 (uninitialized) skipped silently.
  expect(report.submodules_skipped).toBe(1);
  expect(report.submodules.length).toBe(1);
  const s = report.submodules[0]!;
  expect(s.path).toBe('Sub');
  expect(s.default_branch).toBe('origin/main'); // the submodule's OWN ladder

  // Leaked registered worktrees under the SUPERPROJECT's .claude/worktrees.
  expect(s.worktrees.length).toBe(2);
  const leakSub = byBase(s.worktrees, 'leak-sub')!;
  const leakGone = byBase(s.worktrees, 'leak-gone')!;
  expect(leakSub.branch).toBe('worktree-subm-wt');
  expect(leakSub.merged).toBe(true);
  expect(leakGone.branch).toBe('worktree-subm-gone');
  expect(leakGone.merged).toBe(true);
  expect(s.prunable.join('\n')).toContain('leak-gone');

  // Orphaned worktree-* branches with merged state vs the SUBMODULE default.
  expect(s.branches).toEqual([
    { branch: 'worktree-subm-merged', merged: true },
    { branch: 'worktree-subm-squash', merged: false }, // squash-merge reads unmerged
  ]);

  // Human mode: a section for the leaking submodule + the one-line total.
  const h = callGc(['--project', root]);
  expect(h.out).toContain('submodule Sub');
  expect(h.out).toContain('2 leaked branches across 1 submodule');
  expect(h.out).toContain('skipped 1 uninitialized');
  expect(h.out).not.toContain('no leaks detected');
}, 240000);

test('gc --no-submodules skips the submodule pass entirely (and stale-dir protection with it)', () => {
  const { root } = mkSuperWithSub();
  const { code, report } = callGcJson(['--project', root, '--no-submodules']);
  expect(code).toBe(0);
  expect(report.submodules).toEqual([]);
  expect(report.submodules_skipped).toBe(0);
  // Without the submodule scan the leaked submodule worktree dir is invisible
  // as a worktree — it degrades to a plain stale dir (the pre-submodule view).
  expect(report.stale_dirs.map((d) => basename(d))).toEqual(['leak-sub']);

  const h = callGc(['--project', root, '--no-submodules']);
  expect(h.out).not.toContain('submodule Sub');
  expect(h.out).not.toContain('leaked branches across');
}, 240000);
