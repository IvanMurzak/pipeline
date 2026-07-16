// `pipeline gc --clean` — the conservative reap over the leak zoo
// (shard 2/4; sandbox helpers + rationale in _gc-world.ts).

import { test, expect, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { callGc, callGcJson, cleanupCreated, mkRepo, scaffoldLeaks, sh } from './_gc-world';

afterEach(cleanupCreated);

test('gc --clean: prunes records, removes merged worktrees + stale dirs, safe-deletes merged branches, keeps everything else with reasons', () => {
  const root = mkRepo();
  const { wtDir } = scaffoldLeaks(root);
  const { code, report } = callGcJson(['--project', root, '--clean']);
  expect(code).toBe(0);
  const c = report.cleaned!;
  expect(c).not.toBeNull();

  // run-c's stale record was pruned.
  expect(c.pruned.join('\n')).toContain('run-c');

  // Merged run-a removed; unmerged run-b and detached run-d kept, with reasons.
  expect(c.removed_worktrees.map((p) => basename(p))).toEqual(['run-a']);
  const keptB = c.kept_worktrees.find((k) => basename(k.path) === 'run-b')!;
  const keptD = c.kept_worktrees.find((k) => basename(k.path) === 'run-d')!;
  expect(keptB.reason).toContain('not merged into main');
  expect(keptB.reason).toContain('squash-merged');
  expect(keptD.reason).toContain('detached');

  // Stale dir deleted.
  expect(c.removed_dirs.map((d) => basename(d))).toEqual(['stale-x']);

  // Branches: run-a's (just-removed worktree) + the merged orphan + run-c's
  // (orphaned by the prune) safe-deleted; the unmerged orphan kept with reason.
  expect(c.deleted_branches.sort()).toEqual(['worktree-orphan-m', 'worktree-run-a', 'worktree-run-c']);
  const keptU = c.kept_branches.find((k) => k.branch === 'worktree-orphan-u')!;
  expect(keptU.reason).toContain('not merged into main');

  // Filesystem + git agree.
  expect(existsSync(join(wtDir, 'run-a'))).toBe(false);
  expect(existsSync(join(wtDir, 'run-b'))).toBe(true);
  expect(existsSync(join(wtDir, 'run-d'))).toBe(true);
  expect(existsSync(join(wtDir, 'stale-x'))).toBe(false);
  const wtList = sh(['worktree', 'list', '--porcelain'], root);
  expect(wtList).not.toContain('run-a');
  expect(wtList).not.toContain('run-c');
  expect(wtList).toContain('run-b');
  const branches = sh(['branch', '--list', 'worktree-*'], root);
  expect(branches).not.toContain('worktree-run-a');
  expect(branches).not.toContain('worktree-run-c');
  expect(branches).not.toContain('worktree-orphan-m');
  expect(branches).toContain('worktree-run-b'); // attached to a kept worktree
  expect(branches).toContain('worktree-orphan-u'); // unmerged — never forced

  // The current checkout is untouched: still on main, main checkout intact.
  expect(sh(['symbolic-ref', '--short', 'HEAD'], root).trim()).toBe('main');
  expect(existsSync(join(root, 'README.md'))).toBe(true);

  // Human --clean output names what was kept and why.
  const root2 = mkRepo();
  scaffoldLeaks(root2);
  const h = callGc(['--project', root2, '--clean']);
  expect(h.out).toContain('kept worktrees');
  expect(h.out).toContain('kept branches');
  expect(h.out).toContain('worktree-orphan-u');

  // A second --clean pass finds only the deliberately-kept leftovers and is a
  // no-op on them (idempotent).
  const again = callGcJson(['--project', root, '--clean']);
  expect(again.code).toBe(0);
  expect(again.report.cleaned!.removed_worktrees).toEqual([]);
  expect(again.report.cleaned!.deleted_branches).toEqual([]);
  expect(again.report.worktrees.length).toBe(2); // run-b + run-d still reported
}, 240000);
