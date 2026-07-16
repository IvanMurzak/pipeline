// `pipeline submodule bump` — post-merge reconcile + gh merge fallback
// (shard 3/4; world helpers + rationale in _submodule-world.ts):
//   * a transient failure on the first reconcile fetch is retried, then the ff
//     succeeds;
//   * origin never carrying the merge → halt (exit 1) with PR ref + manual
//     recovery surfaced — never forced;
//   * a protected-branch merge failure retries once with --admin.

import { test, expect, afterEach } from 'bun:test';
import { join, resolve } from 'node:path';
import { realGit, type GitRunner } from '../src/lib/git';
import { bump } from '../src/commands/submodule';
import { cleanupCreated, fastReconcile, makeFakeGh, makeWorld, sh } from './_submodule-world';

afterEach(cleanupCreated);

// ===========================================================================
// (G) Reconcile-retry — a transient fetch failure is retried then succeeds
// ===========================================================================

test('reconcile-retry: a transient failure on the first reconcile fetch is retried, then the ff succeeds', () => {
  const w = makeWorld();
  sh(['checkout', '--detach', w.C2], w.subco);
  const SUPER = resolve(w.superRoot);
  // Fail ONLY the first reconcile fetch (the 2nd `fetch origin main` at the shared
  // checkout; the 1st is the pre-worktree Step-1 fetch). Everything else is real.
  let sharedFetches = 0;
  let injectedFailures = 0;
  const git: GitRunner = (args, cwd) => {
    if (cwd && resolve(cwd) === SUPER && args[0] === 'fetch' && args[1] === 'origin') {
      sharedFetches++;
      if (sharedFetches >= 2 && injectedFailures < 1) {
        injectedFailures++;
        return { code: 1, stdout: '', stderr: 'transient: could not read from remote (index.lock held)' };
      }
    }
    return realGit(args, cwd);
  };
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
    reconcileSleepBaseMs: 0,
    reconcileAttempts: 5,
  });
  expect(r.code).toBe(0);
  expect(r.report.status).toBe('committed');
  expect(r.report.reconcile_status).toBe('ff');
  expect(injectedFailures).toBe(1); // the transient really fired
  expect(sharedFetches).toBeGreaterThanOrEqual(3); // step-1 + failed reconcile + retry
}, 90000);

// ===========================================================================
// (H) Reconcile permanent failure — halts (exit 1) with a manual-recovery reason
// ===========================================================================

test('reconcile permanent failure: origin never carries the merge → halt (exit 1); PR ref + manual recovery surfaced', () => {
  const w = makeWorld();
  sh(['checkout', '--detach', w.C2], w.subco);
  const { gh } = makeFakeGh(w.superOrigin, { advanceMode: 'never' }); // merge never propagates to origin
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
    reconcileSleepBaseMs: 0,
    reconcileAttempts: 2,
  });
  expect(r.code).toBe(1);
  expect(r.report.status).toBe('halted');
  expect(r.report.reconcile_status).toBe('failed');
  expect(r.report.pr).toBe('https://github.com/acme/repo/pull/1');
  expect(r.report.halt_reason).toContain('merge --ff-only');
  // The bump is still REPORTED (it landed on origin); the shared checkout just
  // couldn't fast-forward — no force, no corruption.
  expect(r.report.bumped).toEqual([{ path: 'sub', from: w.C1, to: w.C2 }]);
}, 90000);

test('admin fallback: a protected-branch merge failure retries once with --admin, then succeeds', () => {
  const w = makeWorld();
  sh(['checkout', '--detach', w.C2], w.subco);
  const { gh, calls } = makeFakeGh(w.superOrigin, { failFirstMerge: true });
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
  expect(r.report.merged_via_admin).toBe(true);
  // Two merge attempts: the plain one (failed) + the --admin retry.
  const merges = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
  expect(merges.length).toBe(2);
  expect(merges[1].args).toContain('--admin');
}, 90000);
