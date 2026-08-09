// `pipeline submodule bump --no-admin` — the elevation switch (taskflow-v2 a7).
//
// `landToMain` retries a refused `gh pr merge` with `--admin`, which BYPASSES
// BRANCH PROTECTION on the caller's repository, and that fallback defaults ON.
// `--no-admin` turns it off. The orchestrator's security contract says a merge
// GitHub refuses is REPORTED, never retried with elevation — these tests are the
// executable form of that sentence.
//
// The proof that no elevation occurs is deliberately doubled, because "we did
// not call it" is a negative and a single assertion over recorded calls only
// proves the recorder saw nothing:
//   (a) the fake gh THROWS on any invocation carrying `--admin`, so an elevated
//       call cannot complete — it would surface as a thrown error out of
//       `bump()`, not as a quietly-passing assertion; and
//   (b) the recorded calls are asserted `--admin`-free anyway, which is what
//       catches a future `bump()` that swallowed (a)'s exception.
//
// The inverted case (no flag) asserts the CURRENT default is untouched: the
// `--admin` retry still happens and `merged_via_admin: true` is still reported.
// This task does NOT flip the default.
//
// @serial: real git sandbox suite — flaky under N-way parallel CPU contention;
// held out of the parallel pool and run in the serial phase (scripts/parallel-tests.ts).

import { test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { realGit } from '../src/lib/git';
import { bump, runSubmodule, runSubmoduleBump, type BumpReport } from '../src/commands/submodule';
import {
  cleanupCreated,
  fastReconcile,
  makeFakeGh,
  makeWorld,
  recordedGitlink,
  sh,
  type World,
} from './_submodule-world';

afterEach(cleanupCreated);

/** Every `gh pr merge …` invocation the fake recorded, in order. */
function mergeCalls(calls: Array<{ args: string[] }>): string[][] {
  return calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge').map((c) => c.args);
}

/** A world whose single submodule has drifted C1 → C2, i.e. there IS a bump to
 *  land and therefore a PR to merge. */
function driftedWorld(): World {
  const w = makeWorld();
  sh(['checkout', '--detach', w.C2], w.subco);
  return w;
}

// ===========================================================================
// (A) --no-admin — a refused merge is REPORTED, never elevated
// ===========================================================================

test('--no-admin: GitHub refuses the plain merge → reported as halted, and gh is NEVER invoked with --admin', () => {
  const w = driftedWorld();
  // failFirstMerge refuses the plain merge exactly as branch protection would;
  // throwOnAdmin makes an elevated retry impossible to perform silently.
  const { gh, calls } = makeFakeGh(w.superOrigin, { failFirstMerge: true, throwOnAdmin: true });

  const r = bump({
    projectRoot: w.superRoot,
    submodules: ['sub'],
    base: 'main',
    dryRun: false,
    json: false,
    noFetch: false,
    noAdmin: true,
    git: realGit,
    gh,
    worktreesDir: join(w.base, 'wt'),
    ...fastReconcile,
  });

  // (a) No elevated invocation was made — had one been, the fake would have
  //     thrown out of bump() and this line would never be reached.
  // (b) …and nothing carrying --admin reached the recorder either.
  expect(calls.filter((c) => c.args.includes('--admin'))).toEqual([]);
  const merges = mergeCalls(calls);
  expect(merges.length).toBe(1); // ONE attempt: the plain one. No retry of any kind.
  expect(merges[0]).toEqual(['pr', 'merge', 'https://github.com/acme/repo/pull/1', '--squash', '--delete-branch']);

  // The refusal is REPORTED, not swallowed and not forced.
  expect(r.code).toBe(1);
  expect(r.report.status).toBe('halted');
  expect(r.report.merge_outcome).toBe('refused');
  expect(r.report.merged_via_admin).toBe(false);
  expect(r.report.pr).toBe('https://github.com/acme/repo/pull/1');
  expect(r.report.halt_reason).toContain('--admin fallback is disabled');
  expect(r.report.stderr).toContain('branch protection');

  // And the branch protection actually held: origin/main still records C1.
  expect(recordedGitlink(w.superOrigin, 'main', 'sub')).toBe(w.C1);
}, 120000);

// ===========================================================================
// (B) The inverted case — WITHOUT the flag, the existing default is unchanged
// ===========================================================================

test('no flag: the same refusal still retries with --admin and reports merged_via_admin: true (default NOT flipped)', () => {
  const w = driftedWorld();
  const { gh, calls } = makeFakeGh(w.superOrigin, { failFirstMerge: true });

  const r = bump({
    projectRoot: w.superRoot,
    submodules: ['sub'],
    base: 'main',
    dryRun: false,
    json: false,
    noFetch: false,
    noAdmin: false, // the CLI default
    git: realGit,
    gh,
    worktreesDir: join(w.base, 'wt'),
    ...fastReconcile,
  });

  const merges = mergeCalls(calls);
  expect(merges.length).toBe(2); // plain (refused) + the --admin retry
  expect(merges[1]).toContain('--admin');

  expect(r.code).toBe(0);
  expect(r.report.status).toBe('committed');
  expect(r.report.merged_via_admin).toBe(true);
  expect(r.report.merge_outcome).toBe('admin');
  expect(recordedGitlink(w.superOrigin, 'main', 'sub')).toBe(w.C2);
}, 120000);

// ===========================================================================
// (C) The three --json outcomes are distinguishable from each other
// ===========================================================================

// The other two values of `merge_outcome` are asserted by (A) — `"refused"`,
// with `merged_via_admin: false` and `status: "halted"` — and by (B) —
// `"admin"`, with `merged_via_admin: true` and `status: "committed"`. Together
// with this test the three outcomes are shown to be mutually distinguishable by
// `merge_outcome` alone, without reading `halt_reason` prose. They are three
// separate tests rather than one table because each needs its OWN real git
// world, and three lands in one test exceeds a sane per-test timeout.
test('--json: a merge nothing refused reports merge_outcome "plain" with merged_via_admin false', () => {
  const w = driftedWorld();
  const { gh, calls } = makeFakeGh(w.superOrigin); // never refuses

  const r = bump({
    projectRoot: w.superRoot,
    submodules: ['sub'],
    base: 'main',
    dryRun: false,
    json: false,
    noFetch: false,
    noAdmin: true, // the flag is inert when nothing is refused
    git: realGit,
    gh,
    worktreesDir: join(w.base, 'wt'),
    ...fastReconcile,
  });

  expect(mergeCalls(calls).length).toBe(1); // one attempt, no retry of any kind
  expect(r.code).toBe(0);
  expect(r.report.status).toBe('committed');
  expect(r.report.merge_outcome).toBe('plain');
  expect(r.report.merged_via_admin).toBe(false);
  expect(recordedGitlink(w.superOrigin, 'main', 'sub')).toBe(w.C2);
}, 120000);

// ===========================================================================
// (D) The CLI shell — the flag parses AND reaches landToMain's adminFallback
// ===========================================================================

/** Run the real `runSubmoduleBump` shell, capturing its stdout JSON. */
function cliJson(args: string[]): { code: number; json: BumpReport } {
  let out = '';
  const orig = process.stdout.write;
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
    out += String(c);
    return true;
  };
  let code: number;
  try {
    code = runSubmoduleBump(args);
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
  return { code, json: JSON.parse(out.trim()) as BumpReport };
}

test('CLI shell: --no-admin parses and reaches landToMain — the dry-run plan drops the --admin fallback', () => {
  const w = driftedWorld();
  // --dry-run keeps this hermetic (no gh binary needed, nothing pushed) while
  // still proving the flag arrived: land.ts renders the merge plan line from
  // the resolved `adminFallback`, so the plan text IS the observable.
  const withFlag = cliJson(['--project-root', w.superRoot, '--submodules', 'sub', '--dry-run', '--json', '--no-admin']);
  expect(withFlag.code).toBe(0);
  expect(withFlag.json.status).toBe('dry-run');
  const planned = withFlag.json.planned_actions ?? [];
  const mergeLine = planned.find((l) => l.includes('gh pr merge'));
  expect(mergeLine).toBeTruthy();
  expect(mergeLine).not.toContain('--admin');

  const withoutFlag = cliJson(['--project-root', w.superRoot, '--submodules', 'sub', '--dry-run', '--json']);
  expect(withoutFlag.code).toBe(0);
  const mergeLineDefault = (withoutFlag.json.planned_actions ?? []).find((l) => l.includes('gh pr merge'));
  expect(mergeLineDefault).toContain('--admin fallback');
}, 120000);

// ===========================================================================
// (E) Discoverability — `--help` names the flag
// ===========================================================================
//
// `pipeline submodule bump --help` did not exist before this change: `--help`
// fell through parseArgs as an unknown argument and exited 2. A flag that
// decides whether the command may bypass your branch protection has to be
// findable from the command itself.

/** Run a CLI shell entry point, capturing stdout. */
function cliStdout(run: () => number): { code: number; out: string } {
  let out = '';
  const orig = process.stdout.write;
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
    out += String(c);
    return true;
  };
  let code: number;
  try {
    code = run();
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
  return { code, out };
}

test('--help: `submodule bump --help` exits 0 and documents --no-admin (not "unknown argument")', () => {
  const { code, out } = cliStdout(() => runSubmoduleBump(['--help']));
  expect(code).toBe(0);
  expect(out).toContain('--no-admin');
  expect(out).toContain('REFUSE TO BYPASS BRANCH PROTECTION');
  expect(out).toContain('merge_outcome');
  expect(out).not.toContain('unknown argument');
});

test('--help: `submodule --help` (group level) prints the same reference and exits 0', () => {
  const { code, out } = cliStdout(() => runSubmodule(['--help']));
  expect(code).toBe(0);
  expect(out).toContain('--no-admin');
});

test('CLI shell: --no-admin is a known argument (not a usage error)', () => {
  const w = makeWorld();
  // An in-sync world resolves to a noop before any landing, so this isolates
  // argument parsing from everything downstream.
  const r = cliJson(['--project-root', w.superRoot, '--submodules', 'sub', '--json', '--no-admin', '--dry-run']);
  expect(r.code).toBe(0);
  expect(r.json.status).toBe('noop');
  expect(r.json.merge_outcome).toBeNull();
}, 120000);
