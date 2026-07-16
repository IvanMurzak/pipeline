// `pipeline gc --clean` over submodules — conservative reap + the
// --force-worktree-branches escape hatch (shard 4/4; sandbox helpers +
// rationale in _gc-world.ts).

import { test, expect, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { callGc, callGcJson, cleanupCreated, mkSuperWithSub, sh } from './_gc-world';

afterEach(cleanupCreated);

test('gc --clean reaps submodules conservatively: prunes, removes merged leaked worktrees, safe-deletes merged branches, keeps the squash-unmerged one', () => {
  const { root, subDir, wtDir } = mkSuperWithSub();
  const { code, report } = callGcJson(['--project', root, '--clean']);
  expect(code).toBe(0);
  const c = report.cleaned!;

  // Superproject clean unchanged: unmerged orphan kept, nothing force-deleted.
  expect(c.force_deleted_branches).toEqual([]);
  expect(c.kept_branches.map((k) => k.branch)).toEqual(['worktree-super-u']);
  expect(c.removed_dirs).toEqual([]); // leak-sub went via `worktree remove`, not the sweep

  // Submodule clean results.
  expect(c.submodules.length).toBe(1);
  const sc = c.submodules[0]!;
  expect(sc.path).toBe('Sub');
  expect(sc.pruned.join('\n')).toContain('leak-gone');
  expect(sc.removed_worktrees.map((p) => basename(p))).toEqual(['leak-sub']);
  expect(sc.deleted_branches.sort()).toEqual([
    'worktree-subm-gone',
    'worktree-subm-merged',
    'worktree-subm-wt',
  ]);
  expect(sc.force_deleted_branches).toEqual([]);
  const keptSquash = sc.kept_branches.find((k) => k.branch === 'worktree-subm-squash')!;
  expect(keptSquash.reason).toContain('not merged into origin/main');
  expect(keptSquash.reason).toContain('squash-merged');

  // Filesystem + git agree; the submodule checkout itself is untouched.
  expect(existsSync(join(wtDir, 'leak-sub'))).toBe(false);
  const subBranches = sh(['branch', '--list', 'worktree-*'], subDir);
  expect(subBranches).toContain('worktree-subm-squash');
  expect(subBranches).not.toContain('worktree-subm-merged');
  expect(subBranches).not.toContain('worktree-subm-wt');
  expect(subBranches).not.toContain('worktree-subm-gone');
  expect(sh(['symbolic-ref', '--short', 'HEAD'], subDir).trim()).toBe('main');
  expect(existsSync(join(subDir, 's.md'))).toBe(true);
  expect(sh(['branch', '--list', 'worktree-*'], root)).toContain('worktree-super-u');

  // Idempotent: a second --clean pass finds only the deliberately-kept ones.
  const again = callGcJson(['--project', root, '--clean']);
  expect(again.report.cleaned!.submodules[0]!.removed_worktrees).toEqual([]);
  expect(again.report.cleaned!.submodules[0]!.deleted_branches).toEqual([]);
  expect(again.report.submodules[0]!.branches).toEqual([
    { branch: 'worktree-subm-squash', merged: false },
  ]);
}, 240000);

test('gc --clean --force-worktree-branches: git branch -D reaps the unmerged worktree-* leftovers per repo, and the human output says how many', () => {
  const { root, subDir } = mkSuperWithSub();
  const { code, report } = callGcJson(['--project', root, '--clean', '--force-worktree-branches']);
  expect(code).toBe(0);
  const c = report.cleaned!;

  // Superproject: the unmerged orphan is now force-deleted (namespace-guarded).
  expect(c.force_deleted_branches).toEqual(['worktree-super-u']);
  expect(c.kept_branches).toEqual([]);

  // Submodule: the squash-merged (reads-unmerged) branch is force-deleted too.
  const sc = c.submodules[0]!;
  expect(sc.force_deleted_branches).toEqual(['worktree-subm-squash']);
  expect(sc.kept_branches).toEqual([]);

  // Nothing worktree-* survives anywhere; current branches untouched.
  expect(sh(['branch', '--list', 'worktree-*'], root).trim()).toBe('');
  expect(sh(['branch', '--list', 'worktree-*'], subDir).trim()).toBe('');
  expect(sh(['symbolic-ref', '--short', 'HEAD'], root).trim()).toBe('main');
  expect(sh(['symbolic-ref', '--short', 'HEAD'], subDir).trim()).toBe('main');

  // Human output states the per-repo force-deleted count whenever the flag is on.
  const h = callGc(['--project', root, '--clean', '--force-worktree-branches']);
  expect(h.out).toContain('force-deleted unmerged worktree-* branches (git branch -D): 0');
}, 240000);
