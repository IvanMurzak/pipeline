// `pipeline ci-wait` — the GitHub CI gate. All gh calls go through the
// injected GhRunner seam, so these tests script gh's outputs poll-by-poll and
// drive the whole wait state machine with a fake clock (each sleep() advances
// simulated time) — no network, no real waiting.

import { describe, expect, test } from 'bun:test';
import { runCiWait, parseCiWaitArgs, DEFAULT_GRACE_S, type CiWaitDeps, type CiWaitResult } from '../src/commands/ci-wait';
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

function makeDeps(opts: FakeGhOpts): { deps: CiWaitDeps; calls: string[][]; clock: { ms: number } } {
  const calls: string[][] = [];
  const clock = { ms: 0 };
  let poll = 0;
  const deps: CiWaitDeps = {
    git: () => ({ code: 0, stdout: '', stderr: '' }),
    gh: (args: string[]) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}') {
        return ok((opts.defaultBranch ?? 'main') + '\n');
      }
      if (args[0] === 'api' && /^repos\{?.*commits\/[^/]+$/.test(args[1]) && !args[1].endsWith('/check-runs')) {
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
  return { deps, calls, clock };
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
  test('gh not invokable ⇒ exit 2 with a clear message', () => {
    const { deps } = makeDeps({ checksSequence: [] });
    deps.ghOk = () => false;
    const r = capture(() => runCiWait(['--pr', '1'], deps));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('gh');
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
