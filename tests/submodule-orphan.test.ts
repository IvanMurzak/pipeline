// `pipeline submodule bump` — orphan recovery + shared-checkout isolation
// (shard 2/4; world helpers + rationale in _submodule-world.ts):
//   * a planted killed-run throwaway worktree + stale branch is reaped by the
//     pre-flight self-clean (dead owner-pid), then the bump succeeds;
//   * a LIVE-owner throwaway worktree is NOT reaped (concurrency safety);
//   * the shared checkout is only ever `fetch` + `merge --ff-only` — asserted
//     from the git call log; never checkout/reset/switch.
//
// @serial: real git sandbox suite — flaky under N-way parallel CPU contention;
// held out of the parallel pool and run in the serial phase (scripts/parallel-tests.ts).

import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { realGit } from '../src/lib/git';
import { bump } from '../src/commands/submodule';
import { cleanupCreated, fastReconcile, makeFakeGh, makeWorld, recordingGit, sh } from './_submodule-world';

afterEach(cleanupCreated);

// ===========================================================================
// (E) Orphan recovery — pre-flight self-clean reaps a killed-run orphan, then bumps
// ===========================================================================

test('orphan recovery: a planted dead-owner throwaway worktree + stale branch is reaped, then the bump succeeds', () => {
  const w = makeWorld();
  sh(['checkout', '--detach', w.C2], w.subco); // real drift to bump

  // Plant a killed-run orphan: a `land-*/wt` throwaway worktree registered in the
  // shared checkout with a DEAD owner-pid, plus a stale scratch branch.
  const orphanParent = mkdtempSync(join(w.base, 'land-'));
  const orphanWt = join(orphanParent, 'wt');
  sh(['worktree', 'add', '-b', 'chore/bump-submodule-deadbeef', orphanWt, 'origin/main'], w.superRoot);
  writeFileSync(join(orphanParent, '.land-owner.pid'), '0'); // pid 0 ⇒ dead owner
  // Sanity: the orphan is registered before the run.
  expect(sh(['worktree', 'list', '--porcelain'], w.superRoot).stdout).toContain('wt');

  const { gh } = makeFakeGh(w.superOrigin);
  const r = bump({
    projectRoot: w.superRoot,
    submodules: ['sub'],
    base: 'main',
    dryRun: false,
    json: false,
    noFetch: false,
    git: realGit,
    gh,
    worktreesDir: join(w.base, 'wt'),
    ...fastReconcile,
  });
  expect(r.code).toBe(0);
  expect(r.report.status).toBe('committed');

  // The orphan worktree + stale branch are gone (reaped by the pre-flight clean).
  const wts = sh(['worktree', 'list', '--porcelain'], w.superRoot).stdout;
  expect(wts).not.toContain(orphanWt.replace(/\\/g, '/'));
  expect(existsSync(orphanWt)).toBe(false);
  const branches = sh(['branch', '--list', 'chore/bump-submodule-*'], w.superRoot).stdout;
  expect(branches).toBe('');
}, 90000);

test('orphan recovery is concurrency-safe: a LIVE-owner throwaway worktree is NOT reaped', () => {
  const w = makeWorld();
  sh(['checkout', '--detach', w.C2], w.subco);
  const liveParent = mkdtempSync(join(w.base, 'land-'));
  const liveWt = join(liveParent, 'wt');
  sh(['worktree', 'add', '-b', 'chore/bump-submodule-livepid', liveWt, 'origin/main'], w.superRoot);
  writeFileSync(join(liveParent, '.land-owner.pid'), String(process.pid)); // ALIVE owner (this test process)

  const { gh } = makeFakeGh(w.superOrigin);
  const r = bump({
    projectRoot: w.superRoot,
    submodules: ['sub'],
    base: 'main',
    dryRun: false,
    json: false,
    noFetch: false,
    git: realGit,
    gh,
    worktreesDir: join(w.base, 'wt'),
    ...fastReconcile,
  });
  expect(r.code).toBe(0);
  expect(r.report.status).toBe('committed');
  // The live-owner worktree survives — never touched.
  expect(existsSync(liveWt)).toBe(true);
  sh(['worktree', 'remove', '--force', liveWt], w.superRoot); // cleanup
}, 90000);

// ===========================================================================
// (F) Isolation — the shared checkout is only ever fetch + merge --ff-only
// ===========================================================================

test('isolation: the shared checkout is never checkout/reset/switch — only fetch + merge --ff-only', () => {
  const w = makeWorld();
  sh(['checkout', '--detach', w.C2], w.subco);
  const SUPER = resolve(w.superRoot);
  const { git, calls } = recordingGit();
  const { gh } = makeFakeGh(w.superOrigin);
  const r = bump({
    projectRoot: w.superRoot,
    submodules: ['sub'],
    base: 'main',
    dryRun: false,
    json: false,
    noFetch: false,
    git,
    gh,
    worktreesDir: join(w.base, 'wt'),
    ...fastReconcile,
  });
  expect(r.report.status).toBe('committed');

  const sharedCalls = calls.filter((c) => c.cwd && resolve(c.cwd) === SUPER);
  expect(sharedCalls.length).toBeGreaterThan(0);
  for (const c of sharedCalls) {
    // NEVER a working-tree/branch switch of the shared checkout.
    expect(['checkout', 'reset', 'switch']).not.toContain(c.args[0]);
    // The ONLY merge permitted against the shared checkout is a fast-forward.
    if (c.args[0] === 'merge') expect(c.args).toContain('--ff-only');
  }
  // The reconcile genuinely happened via fetch + ff-only.
  expect(sharedCalls.some((c) => c.args[0] === 'fetch' && c.args.includes('origin'))).toBe(true);
  expect(sharedCalls.some((c) => c.args[0] === 'merge' && c.args.includes('--ff-only'))).toBe(true);
}, 90000);
