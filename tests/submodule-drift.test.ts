// `pipeline submodule bump` — happy-path drift detection
// (shard of the submodule suite; world helpers + rationale in
// _submodule-world.ts; the pointer-safety guards live in
// submodule-guards.test.ts):
//   * happy-path drift bump landed via PR + ff reconcile (explicit + auto-detect).

import { test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { realGit } from '../src/lib/git';
import { bump } from '../src/commands/submodule';
import { cleanupCreated, fastReconcile, makeFakeGh, makeWorld, recordedGitlink, sh } from './_submodule-world';

afterEach(cleanupCreated);

// ===========================================================================
// (A) Happy path — drift mode, no source worktree
// ===========================================================================

test('drift bump: checkout ahead of the recorded pointer is landed via a PR + ff reconcile', () => {
  const w = makeWorld();
  sh(['checkout', '--detach', w.C2], w.subco); // drift: checkout C2, recorded C1
  const { gh, calls } = makeFakeGh(w.superOrigin);
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
  expect(r.report.bumped).toEqual([{ path: 'sub', from: w.C1, to: w.C2 }]);
  expect(r.report.skipped).toEqual([]);
  expect(r.report.pr).toBe('https://github.com/acme/repo/pull/1');
  expect(r.report.reconcile_status).toBe('ff');
  expect(r.report.infra_sha).toBeTruthy();
  // The shared checkout's main now records C2 (ff-reconciled to the landed PR).
  expect(recordedGitlink(w.superRoot, 'HEAD', 'sub')).toBe(w.C2);
  expect(recordedGitlink(w.superOrigin, 'main', 'sub')).toBe(w.C2);
  expect(calls.length).toBeGreaterThan(0);
}, 90000);

test('auto-detect: with --submodules omitted, drifted pointers are found via .gitmodules', () => {
  const w = makeWorld();
  sh(['checkout', '--detach', w.C2], w.subco);
  const { gh } = makeFakeGh(w.superOrigin);
  const r = bump({
    projectRoot: w.superRoot,
    submodules: undefined, // ← auto-detect
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
  expect(r.report.bumped).toEqual([{ path: 'sub', from: w.C1, to: w.C2 }]);
}, 90000);
