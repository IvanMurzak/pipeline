// `pipeline submodule bump` — dry-run / noop / usage errors / CLI shell
// (shard 4/4; world helpers + rationale in _submodule-world.ts):
//   * dry-run stages + captures the diff but never pushes/PRs/merges;
//   * an in-sync submodule is a noop (no landing, gh never called);
//   * usage/env errors exit 2;
//   * the real runSubmoduleBump CLI shell end-to-end (in-sync dry-run JSON).
//
// @serial: real git sandbox suite — flaky under N-way parallel CPU contention;
// held out of the parallel pool and run in the serial phase (scripts/parallel-tests.ts).

import { test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { realGit } from '../src/lib/git';
import { bump, runSubmoduleBump } from '../src/commands/submodule';
import {
  cleanupCreated,
  fastReconcile,
  ghThatThrows,
  makeFakeGh,
  makeWorld,
  mkTmp,
  recordedGitlink,
  sh,
} from './_submodule-world';

afterEach(cleanupCreated);

// ===========================================================================
// (I) Dry-run — plan + diff, no push/PR/merge; origin untouched
// ===========================================================================

test('dry-run: stages + captures the diff but never pushes/PRs/merges; origin is untouched', () => {
  const w = makeWorld();
  sh(['checkout', '--detach', w.C2], w.subco);
  const { gh, calls } = makeFakeGh(w.superOrigin);
  const r = bump({
    projectRoot: w.superRoot,
    submodules: ['sub'],
    base: 'main',
    dryRun: true,
    json: false,
    noFetch: false,
    git: realGit,
    gh,
    worktreesDir: join(w.base, 'wt'),
    ...fastReconcile,
  });
  expect(r.code).toBe(0);
  expect(r.report.status).toBe('dry-run');
  expect(r.report.bumped).toEqual([{ path: 'sub', from: w.C1, to: w.C2 }]);
  expect(r.report.planned_actions && r.report.planned_actions.length).toBeGreaterThan(0);
  expect(r.report.diff).toContain('sub');
  expect(r.report.pr).toBeNull();
  expect(calls.length).toBe(0); // gh never called
  // Origin still records C1 — nothing landed.
  expect(recordedGitlink(w.superOrigin, 'main', 'sub')).toBe(w.C1);
}, 90000);

// ===========================================================================
// (J) Noop — nothing drifted
// ===========================================================================

test('noop: an in-sync submodule (checkout == recorded pointer) yields status=noop, no bumps, no landing', () => {
  const w = makeWorld(); // checkout left at C1 == recorded C1
  const r = bump({
    projectRoot: w.superRoot,
    submodules: ['sub'],
    base: 'main',
    dryRun: false,
    json: false,
    noFetch: false,
    git: realGit,
    gh: ghThatThrows,
    ...fastReconcile,
  });
  expect(r.code).toBe(0);
  expect(r.report.status).toBe('noop');
  expect(r.report.bumped).toEqual([]);
  expect(r.report.skipped).toEqual([]); // in-sync is not a reportable skip
}, 90000);

// ===========================================================================
// (K) Usage / env errors — exit 2
// ===========================================================================

test('usage: missing --project-root → exit 2', () => {
  expect(runSubmoduleBump([])).toBe(2);
});

test('usage: unknown argument → exit 2', () => {
  const w = makeWorld();
  expect(runSubmoduleBump(['--project-root', w.superRoot, '--frobnicate'])).toBe(2);
}, 90000);

test('env: --project-root that is not a git repo → exit 2', () => {
  const notARepo = mkTmp('notarepo-');
  expect(runSubmoduleBump(['--project-root', notARepo])).toBe(2);
});

test('env: --source-worktree that does not exist → exit 2', () => {
  const w = makeWorld();
  expect(runSubmoduleBump(['--project-root', w.superRoot, '--source-worktree', join(w.base, 'nope'), '--dry-run'])).toBe(2);
}, 90000);

test('CLI shell end-to-end (in-sync, --dry-run): prints noop JSON + exit 0 via the real runSubmoduleBump', () => {
  const w = makeWorld();
  let out = '';
  const orig = process.stdout.write;
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
    out += String(c);
    return true;
  };
  let code: number;
  try {
    // --dry-run skips the gh-availability env check, keeping the test hermetic.
    code = runSubmoduleBump(['--project-root', w.superRoot, '--submodules', 'sub', '--dry-run', '--json']);
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
  expect(code).toBe(0);
  const json = JSON.parse(out.trim());
  expect(json.status).toBe('noop');
  expect(json.bumped).toEqual([]);
}, 90000);
