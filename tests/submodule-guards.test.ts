// `pipeline submodule bump` — the pointer-safety guards
// (shard of the drift suite; world helpers + rationale in _submodule-world.ts):
//   * #132 mass-revert guard — a pointer that differs only because base advanced
//     past the run's fork is NOT bumped/reverted;
//   * base-advanced conflict — base changed the pointer since the fork → skip;
//   * reachability — an unreachable target is skipped.

import { test, expect, afterEach } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realGit } from '../src/lib/git';
import { classifyDrift } from '../src/lib/drift';
import { bump } from '../src/commands/submodule';
import {
  advanceBase,
  cleanupCreated,
  fastReconcile,
  ghThatThrows,
  head,
  ident,
  makeWorld,
  recordedGitlink,
  sh,
} from './_submodule-world';

afterEach(cleanupCreated);

// ===========================================================================
// (B) #132 guard — a pointer that differs only because base advanced is NOT reverted
// ===========================================================================

test('#132 guard: run did not move the pointer (run==fork) → NOT bumped, even though base advanced', () => {
  const w = makeWorld();
  const wt = join(w.base, 'runwt');
  sh(['worktree', 'add', '--detach', wt, w.P0], w.superRoot); // run forked at P0 (records C1)
  advanceBase(w, w.C2); // base concurrently advanced the pointer C1→C2 (origin/main)

  // The run's worktree still records C1 (it never touched the submodule). Naively
  // landing the run's C1 would REVERT base's C2 — the #132 incident. It MUST skip.
  const cls = classifyDrift(realGit, w.superRoot, 'sub', { baseBranch: 'main', sourceWorktree: wt, doFetch: false });
  expect(cls.status).toBe('unchanged-by-run');

  const r = bump({
    projectRoot: w.superRoot,
    submodules: ['sub'],
    base: 'main',
    sourceWorktree: wt,
    dryRun: false,
    json: false,
    noFetch: true,
    git: realGit,
    gh: ghThatThrows, // asserts no landing happens
    ...fastReconcile,
  });
  expect(r.code).toBe(0);
  expect(r.report.status).toBe('noop');
  expect(r.report.bumped).toEqual([]);
  expect(r.report.skipped.find((s) => s.path === 'sub')?.status).toBe('unchanged-by-run');
  // Base's C2 is untouched — nothing was reverted.
  expect(recordedGitlink(w.superRoot, 'origin/main', 'sub')).toBe(w.C2);
}, 90000);

// ===========================================================================
// (C) Conflict guard — base changed the pointer since the fork → skip, don't clobber
// ===========================================================================

test('conflict guard: base advanced the pointer since the fork AND the run changed it → skip + surface', () => {
  const w = makeWorld();
  const wt = join(w.base, 'runwt');
  sh(['worktree', 'add', '--detach', wt, w.P0], w.superRoot);
  ident(wt);
  // Run's worktree bumps the pointer to C3.
  sh(['update-index', '--cacheinfo', `160000,${w.C3},sub`], wt);
  sh(['commit', '-m', 'run bumps sub to C3'], wt);
  // Base concurrently bumped the same pointer to C2.
  advanceBase(w, w.C2);

  const cls = classifyDrift(realGit, w.superRoot, 'sub', { baseBranch: 'main', sourceWorktree: wt, doFetch: false });
  expect(cls.status).toBe('base-advanced-conflict');

  const r = bump({
    projectRoot: w.superRoot,
    submodules: ['sub'],
    base: 'main',
    sourceWorktree: wt,
    dryRun: false,
    json: false,
    noFetch: true,
    git: realGit,
    gh: ghThatThrows,
    ...fastReconcile,
  });
  expect(r.code).toBe(0);
  expect(r.report.status).toBe('noop');
  expect(r.report.bumped).toEqual([]);
  const skip = r.report.skipped.find((s) => s.path === 'sub');
  expect(skip?.status).toBe('base-advanced-conflict');
  expect(skip?.reason).toContain('since the run');
}, 90000);

// ===========================================================================
// (D) Reachability guard — an unreachable target is skipped
// ===========================================================================

test('reachability guard: a checkout not reachable from the submodule origin/<default> is skipped', () => {
  const w = makeWorld();
  // Local-only commit on the submodule checkout (a sibling of C2/C3 → not on main).
  sh(['checkout', '--detach', w.C1], w.subco);
  writeFileSync(join(w.subco, 'a.txt'), 'local-wip');
  sh(['add', '.'], w.subco);
  sh(['commit', '-m', 'local WIP'], w.subco);
  const CL = head(w.subco);
  expect(CL).not.toBe(w.C2);

  const r = bump({
    projectRoot: w.superRoot,
    submodules: ['sub'],
    base: 'main',
    dryRun: false,
    json: false,
    noFetch: false, // fetch so reachability sees the real submodule origin tip
    git: realGit,
    gh: ghThatThrows,
    ...fastReconcile,
  });
  expect(r.code).toBe(0);
  expect(r.report.status).toBe('noop');
  expect(r.report.bumped).toEqual([]);
  expect(r.report.skipped.find((s) => s.path === 'sub')?.status).toBe('unreachable');
}, 90000);
