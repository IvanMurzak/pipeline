// `pipeline ci-wait` — the GitHub CI gate. All gh calls go through the
// injected GhRunner seam, so these tests script gh's outputs poll-by-poll and
// drive the whole wait state machine with a fake clock (each sleep() advances
// simulated time) — no network, no real waiting.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  runCiWait,
  parseCiWaitArgs,
  resolveRepoTarget,
  DEFAULT_GRACE_S,
  type CiWaitDeps,
  type CiWaitResult,
} from '../src/commands/ci-wait';
import type { GitResult } from '../src/lib/git';

const SHA = 'a'.repeat(40);

function ok(stdout: string): GitResult {
  return { code: 0, stdout, stderr: '' };
}

function fail(code: number, stderr: string): GitResult {
  return { code, stdout: '', stderr };
}

/** gh fake: routes calls by shape; `checksSequence` yields one payload per
 *  status poll (the last entry repeats when polled again). */
interface FakeGhOpts {
  checksSequence: GitResult[];
  defaultBranch?: string;
  branchSha?: GitResult;
}

// `repos/{owner}/{repo}` (path form) or `repos/<owner>/<name>` (slug form).
const REPO_ROOT_RE = /^repos\/(?:\{owner\}\/\{repo\}|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/;

function makeDeps(opts: FakeGhOpts): {
  deps: CiWaitDeps;
  calls: string[][];
  cwds: string[];
  clock: { ms: number };
} {
  const calls: string[][] = [];
  const cwds: string[] = [];
  const clock = { ms: 0 };
  let poll = 0;
  const deps: CiWaitDeps = {
    git: () => ({ code: 0, stdout: '', stderr: '' }),
    gh: (args: string[], cwd: string) => {
      calls.push(args);
      cwds.push(cwd);
      const ep = args[1] ?? '';
      if (args[0] === 'api' && REPO_ROOT_RE.test(ep)) {
        return ok((opts.defaultBranch ?? 'main') + '\n');
      }
      if (args[0] === 'api' && /\/commits\/[^/]+$/.test(ep) && !ep.endsWith('/check-runs')) {
        return opts.branchSha ?? ok(SHA + '\n');
      }
      // status polls: `pr checks` or the check-runs api
      const r = opts.checksSequence[Math.min(poll, opts.checksSequence.length - 1)];
      poll++;
      return r;
    },
    now: () => clock.ms,
    sleep: (ms: number) => {
      clock.ms += ms;
    },
    ghOk: () => true,
  };
  return { deps, calls, cwds, clock };
}

function capture(fn: () => number): { code: number; stdout: string; stderr: string } {
  const outw = process.stdout.write.bind(process.stdout);
  const errw = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  // @ts-expect-error test-only monkeypatch
  process.stdout.write = (s: string) => ((stdout += s), true);
  // @ts-expect-error test-only monkeypatch
  process.stderr.write = (s: string) => ((stderr += s), true);
  try {
    const code = fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = outw;
    process.stderr.write = errw;
  }
}

function prChecks(rows: Array<{ name: string; bucket: string }>): GitResult {
  return ok(JSON.stringify(rows.map((r) => ({ name: r.name, state: '', bucket: r.bucket, link: null }))));
}

function checkRuns(rows: Array<{ name: string; status: string; conclusion: string | null }>): GitResult {
  return ok(JSON.stringify(rows.map((r) => ({ ...r, link: null }))));
}

describe('parseCiWaitArgs', () => {
  test('defaults', () => {
    const p = parseCiWaitArgs([]);
    expect('error' in p).toBe(false);
    if ('error' in p) return;
    expect(p.timeoutS).toBe(1800);
    expect(p.intervalS).toBe(15);
    expect(p.graceS).toBe(DEFAULT_GRACE_S);
    expect(p.failFast).toBe(true);
  });

  test('rejects two selectors', () => {
    const p = parseCiWaitArgs(['--pr', '12', '--branch', 'main']);
    expect('error' in p).toBe(true);
  });

  test('--fail-fast is accepted explicitly (it is also the default)', () => {
    const p = parseCiWaitArgs(['--fail-fast']);
    expect('error' in p).toBe(false);
    if ('error' in p) return;
    expect(p.failFast).toBe(true);
  });

  test('rejects unknown option and bad numbers', () => {
    expect('error' in parseCiWaitArgs(['--nope'])).toBe(true);
    expect('error' in parseCiWaitArgs(['--timeout', 'abc'])).toBe(true);
    expect('error' in parseCiWaitArgs(['--interval', '-5'])).toBe(true);
  });
});

describe('ci-wait PR mode', () => {
  test('pending → all pass ⇒ exit 0, success JSON', () => {
    const { deps } = makeDeps({
      checksSequence: [
        prChecks([
          { name: 'build', bucket: 'pending' },
          { name: 'test', bucket: 'pass' },
        ]),
        prChecks([
          { name: 'build', bucket: 'pass' },
          { name: 'test', bucket: 'pass' },
        ]),
      ],
    });
    const r = capture(() => runCiWait(['--pr', '42', '--json'], deps));
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.status).toBe('success');
    expect(res.mode).toBe('pr');
    expect(res.passed).toBe(2);
    expect(res.polls).toBe(2);
  });

  test('skipping buckets count as passing', () => {
    const { deps } = makeDeps({
      checksSequence: [prChecks([{ name: 'lint', bucket: 'skipping' }])],
    });
    const r = capture(() => runCiWait(['--pr', '42', '--json'], deps));
    expect(r.code).toBe(0);
  });

  test('fail-fast: a failed check ends the wait while others pend ⇒ exit 1', () => {
    const { deps } = makeDeps({
      checksSequence: [
        prChecks([
          { name: 'build', bucket: 'fail' },
          { name: 'test', bucket: 'pending' },
        ]),
      ],
    });
    const r = capture(() => runCiWait(['--pr', '42', '--json'], deps));
    expect(r.code).toBe(1);
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.status).toBe('failure');
    expect(res.failed_checks.map((c) => c.name)).toEqual(['build']);
    expect(res.detail).toContain('fail-fast');
    expect(res.polls).toBe(1);
  });

  test('--no-fail-fast waits out the pending checks before failing', () => {
    const { deps } = makeDeps({
      checksSequence: [
        prChecks([
          { name: 'build', bucket: 'fail' },
          { name: 'test', bucket: 'pending' },
        ]),
        prChecks([
          { name: 'build', bucket: 'fail' },
          { name: 'test', bucket: 'pass' },
        ]),
      ],
    });
    const r = capture(() => runCiWait(['--pr', '42', '--no-fail-fast', '--json'], deps));
    expect(r.code).toBe(1);
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.polls).toBe(2);
    expect(res.passed).toBe(1);
  });

  test('cancel bucket is a failure, never a pass', () => {
    const { deps } = makeDeps({
      checksSequence: [prChecks([{ name: 'build', bucket: 'cancel' }])],
    });
    const r = capture(() => runCiWait(['--pr', '42', '--json'], deps));
    expect(r.code).toBe(1);
  });

  test('timeout ⇒ exit 3 with the pending names listed', () => {
    const { deps } = makeDeps({
      checksSequence: [prChecks([{ name: 'slow-suite', bucket: 'pending' }])],
    });
    const r = capture(() => runCiWait(['--pr', '42', '--timeout', '60', '--interval', '30', '--json'], deps));
    expect(r.code).toBe(3);
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.status).toBe('timeout');
    expect(res.pending_checks).toEqual(['slow-suite']);
  });

  test('no checks ever appear ⇒ exit 4 (no-checks), NOT success', () => {
    const { deps } = makeDeps({
      checksSequence: [fail(8, 'no checks reported on the branch')],
    });
    const r = capture(() => runCiWait(['--pr', '42', '--grace', '30', '--interval', '30', '--json'], deps));
    expect(r.code).toBe(4);
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.status).toBe('no-checks');
    expect(res.detail).toContain('no checks reported');
  });

  test('an EMPTY check list is grace territory, not a green gate', () => {
    const { deps } = makeDeps({ checksSequence: [prChecks([])] });
    const r = capture(() => runCiWait(['--pr', '42', '--grace', '10', '--interval', '10', '--json'], deps));
    expect(r.code).toBe(4);
  });
});

describe('ci-wait commit mode', () => {
  test('--branch resolves the sha once, then polls check-runs to success', () => {
    const { deps, calls } = makeDeps({
      checksSequence: [
        checkRuns([{ name: 'CI', status: 'in_progress', conclusion: null }]),
        checkRuns([{ name: 'CI', status: 'completed', conclusion: 'success' }]),
      ],
    });
    const r = capture(() => runCiWait(['--branch', 'main', '--json'], deps));
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.mode).toBe('commit');
    expect(res.sha).toBe(SHA);
    const shaResolves = calls.filter((c) => c[1] === 'repos/{owner}/{repo}/commits/main');
    expect(shaResolves.length).toBe(1); // pinned once, not re-resolved per poll
  });

  test('no selector ⇒ resolves and waits on the DEFAULT branch', () => {
    const { deps, calls } = makeDeps({
      defaultBranch: 'develop',
      checksSequence: [checkRuns([{ name: 'CI', status: 'completed', conclusion: 'success' }])],
    });
    const r = capture(() => runCiWait(['--json'], deps));
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.ref).toBe('develop');
    expect(calls.some((c) => c[1] === 'repos/{owner}/{repo}/commits/develop')).toBe(true);
  });

  test('failing conclusion ⇒ exit 1; skipped/neutral pass', () => {
    const { deps } = makeDeps({
      checksSequence: [
        checkRuns([
          { name: 'build', status: 'completed', conclusion: 'failure' },
          { name: 'lint', status: 'completed', conclusion: 'skipped' },
          { name: 'docs', status: 'completed', conclusion: 'neutral' },
        ]),
      ],
    });
    const r = capture(() => runCiWait(['--sha', SHA, '--json'], deps));
    expect(r.code).toBe(1);
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.failed_checks.map((c) => c.name)).toEqual(['build']);
    expect(res.passed).toBe(2);
  });

  test('unknown terminal conclusion fails CLOSED', () => {
    const { deps } = makeDeps({
      checksSequence: [checkRuns([{ name: 'x', status: 'completed', conclusion: 'mystery_state' }])],
    });
    const r = capture(() => runCiWait(['--sha', SHA, '--json'], deps));
    expect(r.code).toBe(1);
  });

  test('paginated output (one array per line) is merged', () => {
    const page1 = JSON.stringify([{ name: 'a', status: 'completed', conclusion: 'success', link: null }]);
    const page2 = JSON.stringify([{ name: 'b', status: 'completed', conclusion: 'success', link: null }]);
    const { deps } = makeDeps({ checksSequence: [ok(page1 + '\n' + page2 + '\n')] });
    const r = capture(() => runCiWait(['--sha', SHA, '--json'], deps));
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.total).toBe(2);
  });

  test('unresolvable branch ⇒ exit 2 usage/env error', () => {
    const { deps } = makeDeps({
      checksSequence: [],
      branchSha: fail(1, 'HTTP 404: Not Found'),
    });
    const r = capture(() => runCiWait(['--branch', 'ghost', '--json'], deps));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ghost');
  });
});

describe('ci-wait environment', () => {
  // `ghOk` is wired to lib/git's `ghAvailable` in the production deps and is
  // consulted BEFORE the poll loop. The passing checksSequence is deliberate:
  // if the guard were dropped, this run would succeed (exit 0, one gh call),
  // so the exit-2 + empty-call-log assertions below cannot pass vacuously.
  test('gh not invokable ⇒ exit 2 up front, before any gh call or sleep', () => {
    const { deps, calls, clock } = makeDeps({
      checksSequence: [prChecks([{ name: 'build', bucket: 'pass' }])],
    });
    deps.ghOk = () => false;
    const r = capture(() => runCiWait(['--pr', '1', '--grace', '120', '--interval', '15'], deps));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('gh');
    expect(calls).toEqual([]);
    expect(clock.ms).toBe(0);
  });

  test('human (non-json) output is a single line', () => {
    const { deps } = makeDeps({
      checksSequence: [prChecks([{ name: 'build', bucket: 'pass' }])],
    });
    const r = capture(() => runCiWait(['--pr', '7'], deps));
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n').length).toBe(1);
    expect(r.stdout).toContain('success');
  });

  test('--verbose heartbeats go to stderr, result stays on stdout', () => {
    const { deps } = makeDeps({
      checksSequence: [
        prChecks([{ name: 'build', bucket: 'pending' }]),
        prChecks([{ name: 'build', bucket: 'pass' }]),
      ],
    });
    const r = capture(() => runCiWait(['--pr', '7', '--verbose', '--json'], deps));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('poll 1');
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// `--repo`: a local path OR a GitHub owner/name slug
//
// The defect this covers, as measured on 0.8.0: `--repo IvanMurzak/AI-Game-Dev-
// Server` (an owner/name slug, which is what `--repo` means in `gh` itself) was
// resolved as a local path and became the cwd of every gh subprocess. There was
// no existence check, so every spawn failed with ENOENT, the command polled the
// dead cwd for the FULL grace period and then reported `no-checks` / exit 4 —
// "CI never started", a completely different operator action from "bad flag",
// which the command's own contract puts at exit 2.
// ---------------------------------------------------------------------------

const SLUG = 'IvanMurzak/ai-pipeline-plugin';
const tmpRoot = mkdtempSync(join(tmpdir(), 'ci-wait-repo-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** Positive artifact per gh call: the slug is materialised IN THE ARGS — as the
 *  `-R <slug>` selector (`gh pr` has one) or inside the api endpoint path
 *  (`gh api` does NOT: gh 2.92 answers `-R` with "unknown shorthand flag: 'R'").
 *  Always paired with an exact expected call COUNT, so `.every()` can never
 *  pass vacuously on an empty call log. */
function aimsAtSlug(args: string[], slug: string): boolean {
  const i = args.indexOf('-R');
  if (i >= 0 && args[i + 1] === slug) return true;
  const ep = args[1] ?? '';
  return args[0] === 'api' && (ep === `repos/${slug}` || ep.startsWith(`repos/${slug}/`));
}

describe('resolveRepoTarget — the --repo disambiguation rule', () => {
  test('no --repo ⇒ the current directory, no slug', () => {
    expect(resolveRepoTarget(null, '/base')).toEqual({ cwd: '/base', slug: null });
  });

  test('an existing directory ⇒ a PATH (it becomes the gh cwd)', () => {
    const dir = mkdtempSync(join(tmpRoot, 'exists-'));
    expect(resolveRepoTarget(dir, tmpRoot)).toEqual({ cwd: resolve(dir), slug: null });
  });

  test('owner/name that is not a directory ⇒ a SLUG (cwd left alone)', () => {
    expect(resolveRepoTarget(SLUG, tmpRoot)).toEqual({ cwd: tmpRoot, slug: SLUG });
  });

  test('EXISTENCE WINS: a real directory literally named owner/name is a path, never a slug', () => {
    const withDir = mkdtempSync(join(tmpRoot, 'has-octocat-'));
    mkdirSync(join(withDir, 'octo', 'cat'), { recursive: true });
    expect(resolveRepoTarget('octo/cat', withDir)).toEqual({
      cwd: resolve(withDir, 'octo', 'cat'),
      slug: null,
    });
    // Control: the SAME value, from a base that does NOT contain that
    // directory, is a slug. Only the filesystem differs — so the assertion
    // above is decided by existence, not by the value's shape.
    const withoutDir = mkdtempSync(join(tmpRoot, 'no-octocat-'));
    expect(resolveRepoTarget('octo/cat', withoutDir)).toEqual({
      cwd: withoutDir,
      slug: 'octo/cat',
    });
  });

  test('an existing FILE is not a directory ⇒ error naming the value', () => {
    const f = join(tmpRoot, 'a-file.txt');
    writeFileSync(f, 'x');
    const t = resolveRepoTarget(f, tmpRoot);
    expect('error' in t).toBe(true);
    if (!('error' in t)) return;
    expect(t.error).toContain(f);
    expect(t.error).toContain('--repo');
  });

  test('neither a directory nor a slug ⇒ error naming the value', () => {
    const t = resolveRepoTarget('owner/name/extra', tmpRoot);
    expect('error' in t).toBe(true);
    if (!('error' in t)) return;
    expect(t.error).toContain('owner/name/extra');
  });
});

describe('ci-wait --repo', () => {
  test('a --repo that is neither a directory nor a slug ⇒ exit 2 BEFORE any gh call or sleep', () => {
    const absent = join(tmpRoot, 'no-such-checkout', 'nested'); // absolute ⇒ never slug-shaped
    const { deps, calls, clock } = makeDeps({
      checksSequence: [prChecks([{ name: 'build', bucket: 'pass' }])],
    });
    const r = capture(() =>
      runCiWait(['--pr', '42', '--repo', absent, '--grace', '120', '--interval', '15', '--json'], deps),
    );
    expect(r.code).toBe(2);
    expect(calls).toEqual([]); // never spawned gh against a cwd that cannot exist
    expect(clock.ms).toBe(0); // exact: not one interval, let alone the 120s grace
    expect(r.stdout).toBe(''); // no result object — this is a usage error, not a CI verdict
    expect(r.stderr).toContain(absent);
    expect(r.stderr).toContain('--repo');
  });

  test('CONTROL: the same dead-end gh WITH a valid --repo still burns the grace period (exit 4)', () => {
    // This is the pre-fix behaviour, reproduced exactly (9 polls / 120s /
    // `no-checks`) via a legitimately-unreachable gh. It proves the test above
    // measures the new fast-fail and not some unrelated short-circuit: same
    // flags, same clock, same grace — only --repo differs.
    const { deps, calls, clock } = makeDeps({
      checksSequence: [fail(127, "ENOENT: no such file or directory, uv_spawn 'gh'")],
    });
    const r = capture(() =>
      runCiWait(['--pr', '42', '--repo', tmpRoot, '--grace', '120', '--interval', '15', '--json'], deps),
    );
    expect(r.code).toBe(4);
    expect(clock.ms).toBe(120_000);
    expect(calls.length).toBe(9);
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.status).toBe('no-checks');
    expect(res.polls).toBe(9);
    expect(res.elapsed_s).toBe(120);
  });

  test('--repo <slug>: PR mode aims gh pr checks at the slug with -R, cwd untouched', () => {
    const { deps, calls, cwds } = makeDeps({
      checksSequence: [prChecks([{ name: 'build', bucket: 'pass' }])],
    });
    const r = capture(() => runCiWait(['--pr', '42', '--repo', SLUG, '--json'], deps));
    expect(r.code).toBe(0);
    expect(calls).toEqual([['pr', 'checks', '42', '--json', 'name,state,bucket,link', '-R', SLUG]]);
    expect(calls.length).toBe(1);
    expect(calls.every((c) => aimsAtSlug(c, SLUG))).toBe(true);
    expect(cwds).toEqual([process.cwd()]); // the slug never becomes a cwd
    // ...and the gate otherwise behaves exactly as it does without --repo.
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.status).toBe('success');
    expect(res.mode).toBe('pr');
    expect(res.passed).toBe(1);
  });

  test('--repo <slug>: EVERY gh api endpoint carries the slug — no {owner}/{repo} survives', () => {
    // No selector ⇒ all three api call sites run in one command:
    // resolveDefaultBranch → resolveBranchSha → snapshotCommit.
    const { deps, calls, cwds } = makeDeps({
      defaultBranch: 'develop',
      checksSequence: [checkRuns([{ name: 'CI', status: 'completed', conclusion: 'success' }])],
    });
    const r = capture(() => runCiWait(['--repo', SLUG, '--json'], deps));
    expect(r.code).toBe(0);
    expect(calls.map((c) => c[1])).toEqual([
      `repos/${SLUG}`,
      `repos/${SLUG}/commits/develop`,
      `repos/${SLUG}/commits/${SHA}/check-runs`,
    ]);
    expect(calls.length).toBe(3);
    expect(calls.every((c) => aimsAtSlug(c, SLUG))).toBe(true);
    // `gh api` has NO -R flag — sending one is `unknown shorthand flag: 'R'`.
    expect(calls.some((c) => c.includes('-R'))).toBe(false);
    expect(cwds).toEqual([process.cwd(), process.cwd(), process.cwd()]);
    const res = JSON.parse(r.stdout) as CiWaitResult;
    expect(res.ref).toBe('develop');
    expect(res.sha).toBe(SHA);
  });

  test('--repo <existing dir>: commit mode unchanged — dir is the cwd, placeholders intact, no -R', () => {
    const dir = mkdtempSync(join(tmpRoot, 'checkout-commit-'));
    const { deps, calls, cwds } = makeDeps({
      defaultBranch: 'develop',
      checksSequence: [checkRuns([{ name: 'CI', status: 'completed', conclusion: 'success' }])],
    });
    const r = capture(() => runCiWait(['--repo', dir, '--json'], deps));
    expect(r.code).toBe(0);
    expect(calls.map((c) => c[1])).toEqual([
      'repos/{owner}/{repo}',
      'repos/{owner}/{repo}/commits/develop',
      `repos/{owner}/{repo}/commits/${SHA}/check-runs`,
    ]);
    expect(cwds).toEqual([resolve(dir), resolve(dir), resolve(dir)]);
    expect(calls.some((c) => c.includes('-R'))).toBe(false);
  });

  test('--repo <existing dir>: PR mode unchanged — byte-identical args, dir is the cwd', () => {
    const dir = mkdtempSync(join(tmpRoot, 'checkout-pr-'));
    const { deps, calls, cwds } = makeDeps({
      checksSequence: [prChecks([{ name: 'build', bucket: 'pass' }])],
    });
    const r = capture(() => runCiWait(['--pr', '42', '--repo', dir, '--json'], deps));
    expect(r.code).toBe(0);
    expect(calls).toEqual([['pr', 'checks', '42', '--json', 'name,state,bucket,link']]);
    expect(cwds).toEqual([resolve(dir)]);
  });

  test('a genuine directory named like a slug is a PATH end-to-end (cwd = the dir, no -R)', () => {
    const base = mkdtempSync(join(tmpRoot, 'slugdir-'));
    mkdirSync(join(base, 'octo', 'cat'), { recursive: true });
    const prev = process.cwd();
    process.chdir(base);
    try {
      // Read cwd back AFTER chdir: on macOS the tmpdir is a symlink, so the
      // realpath the process reports is not the string passed to chdir.
      const here = process.cwd();
      const { deps, calls, cwds } = makeDeps({
        checksSequence: [prChecks([{ name: 'build', bucket: 'pass' }])],
      });
      const r = capture(() => runCiWait(['--pr', '42', '--repo', 'octo/cat', '--json'], deps));
      expect(r.code).toBe(0);
      expect(calls).toEqual([['pr', 'checks', '42', '--json', 'name,state,bucket,link']]);
      expect(cwds).toEqual([resolve(here, 'octo', 'cat')]); // the DIRECTORY became the cwd
    } finally {
      process.chdir(prev);
    }
  });

  test('--repo pointing at a FILE ⇒ exit 2, no gh call (a file is not a checkout)', () => {
    const f = join(tmpRoot, 'not-a-checkout.txt');
    writeFileSync(f, 'x');
    const { deps, calls, clock } = makeDeps({
      checksSequence: [prChecks([{ name: 'build', bucket: 'pass' }])],
    });
    const r = capture(() => runCiWait(['--pr', '42', '--repo', f, '--grace', '120', '--json'], deps));
    expect(r.code).toBe(2);
    expect(calls).toEqual([]);
    expect(clock.ms).toBe(0);
    expect(r.stderr).toContain(f);
  });
});
