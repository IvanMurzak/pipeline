// telemetry-daemon.test.ts — the detached uploader daemon's poll loop, its
// idle/wall-clock bounds, one real poll cycle, and the CLI wrapper
// (src/commands/telemetry-daemon.ts, ux-v2 b11).
//
// The lock ACQUIRE/reclaim scheme itself — the atomic `wx` race fix and its
// stale-lock reclamation — lives in `hooks/analytics_relay.ts`
// (`ensureTelemetryDaemonRunning` / `acquireTelemetryDaemonLock`), tested in
// `apps/pipeline-ui/tests/hook-telemetry-daemon-lock.test.ts` (that file also
// carries the mutation check for the race fix). This file covers everything
// downstream of "a daemon process now exists": the pure idle/wall-clock loop
// (`runTelemetryDaemonLoop`), one real poll cycle (`pollProjectOnce`), the
// lock-path formula + best-effort release, and `pipeline telemetry-daemon`.
//
// TWO KINDS OF CLOCK, DELIBERATELY BOTH PRESENT (matrix 22):
//   - Most `runTelemetryDaemonLoop` tests inject a FAKE now()/sleep() so the
//     idle and wall-clock bounds can be asserted to the exact millisecond,
//     instantly.
//   - The "REAL wall-clock" describe block below uses the REAL clock and REAL
//     `setTimeout` sleeps with tiny (tens-of-ms) bounds, because an injected
//     clock only proves the LOGIC picks the right exit reason — it cannot
//     prove the actual `for (;;)` loop genuinely returns control to the
//     process. Only that block can make that second claim.

import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFs } from '../src/lib/cloud-config';
import { telemetryDir, type OutboxRecord } from '../src/lib/telemetry-outbox';
import { uploadStatePath, type UploadFetch, type UploadRequest } from '../src/lib/telemetry-upload';
import {
  DEFAULT_IDLE_EXIT_MS,
  DEFAULT_MAX_WALL_CLOCK_MS,
  DEFAULT_POLL_INTERVAL_MS,
  LOCK_STALE_AGE_MS,
  parseTelemetryDaemonArgs,
  pollProjectOnce,
  releaseDaemonLock,
  runTelemetryDaemon,
  runTelemetryDaemonLoop,
  telemetryDaemonLockPath,
  type TelemetryDaemonCliDeps,
  type TelemetryDaemonPollDeps,
} from '../src/commands/telemetry-daemon';

// ---------------------------------------------------------------------------
// Scaffolding — mirrors tests/telemetry-upload.test.ts's helpers exactly, so
// a project set up here behaves identically to one `resolveUploadTarget`
// and `TelemetryOutbox` were already proven against.
// ---------------------------------------------------------------------------

const created: string[] = [];
afterAll(() => {
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function mkProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'td-proj-'));
  created.push(d);
  mkdirSync(join(d, '.pipeline', '.runtime'), { recursive: true });
  return d;
}

function writeBinding(root: string, binding: Record<string, unknown>): void {
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  writeFileSync(join(root, '.pipeline', 'cloud.json'), JSON.stringify(binding), 'utf-8');
}

function writeStore(root: string, cred: Record<string, unknown>, server = 'https://api.example.test'): void {
  mkdirSync(join(root, 'cfg'), { recursive: true });
  writeFileSync(
    join(root, 'cfg', 'credentials.json'),
    JSON.stringify({ version: 1, servers: { [server]: cred } }),
    'utf-8',
  );
}

function plantInQueue(root: string, records: OutboxRecord[]): void {
  const dir = telemetryDir(root);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'outbox.jsonl'), records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf-8');
}

function rec(over: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    org: 'acme',
    run_id: 'run-a',
    seq: 1,
    kind: 'event',
    payload: { schema: 5, ts: '2026-08-05T10:00:00.000Z', type: 'tool.called', run_id: 'run-a', data: { tool_name: 'Read' } },
    ...over,
  };
}

/** `homedir` doubles as the project root, exactly like telemetry-upload.test.ts's
 *  own `home()` helper — the credential store lives at `<root>/cfg`, the
 *  project binding at `<root>/.pipeline/cloud.json`. */
const home = (root: string) => ({ platform: 'linux', homedir: root, env: { PIPELINE_CLOUD_HOME: join(root, 'cfg') } });

function boundAndCredentialed(root: string, org = 'acme', server = 'https://api.example.test'): void {
  writeBinding(root, { server, org, project: 'p', connected_at: 'x' });
  // No expires_at ⇒ never expiring ⇒ ensureFreshCredential never attempts a
  // refresh call, so these tests need no refreshFetch injected.
  writeStore(root, { access_token: 'tok', token_type: 'bearer', org_slug: org }, server);
}

// ---------------------------------------------------------------------------
// telemetryDaemonLockPath / releaseDaemonLock
// ---------------------------------------------------------------------------

describe('telemetryDaemonLockPath', () => {
  test('is <project>/.pipeline/.runtime/telemetry/daemon.lock', () => {
    const root = mkProject();
    expect(telemetryDaemonLockPath(root)).toBe(join(telemetryDir(root), 'daemon.lock'));
  });
});

describe('releaseDaemonLock', () => {
  test('removes an existing lock file', () => {
    const root = mkProject();
    const lockPath = telemetryDaemonLockPath(root);
    mkdirSync(telemetryDir(root), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    expect(existsSync(lockPath)).toBe(true);
    releaseDaemonLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('is a no-op (never throws) when the lock is already gone', () => {
    const root = mkProject();
    expect(() => releaseDaemonLock(telemetryDaemonLockPath(root))).not.toThrow();
  });
});

describe('documented bounds', () => {
  test('the documented defaults are the documented defaults', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5_000);
    expect(DEFAULT_IDLE_EXIT_MS).toBe(2 * 60_000);
    expect(DEFAULT_MAX_WALL_CLOCK_MS).toBe(30 * 60_000);
    // The hook's stale-reclaim bound must sit comfortably above the
    // daemon's own wall-clock cap — see hooks/analytics_relay.ts and
    // tests/telemetry-daemon-lock-parity.test.ts.
    expect(LOCK_STALE_AGE_MS).toBe(DEFAULT_MAX_WALL_CLOCK_MS + 5 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// runTelemetryDaemonLoop — injected clock (exact-ms assertions)
// ---------------------------------------------------------------------------

describe('runTelemetryDaemonLoop — injected clock proves the exit-decision LOGIC', () => {
  test('idle exit fires once idleExitMs of consecutive idle polls has elapsed', async () => {
    let t = 0;
    let polls = 0;
    const sleeps: number[] = [];
    const exits: Array<{ reason: string; iterations: number }> = [];
    const reason = await runTelemetryDaemonLoop({
      pollIntervalMs: 1000,
      idleExitMs: 5000,
      maxWallClockMs: 10_000_000,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      poll: async () => {
        polls++;
        return 'idle';
      },
      onExit: (r, iterations) => exits.push({ reason: r, iterations }),
    });
    expect(reason).toBe('idle');
    expect(sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(polls).toBe(6);
    expect(exits).toEqual([{ reason: 'idle', iterations: 6 }]);
  });

  test('a non-idle outcome resets the idle clock — an always-active queue never idle-exits, it retires on wall-clock instead', async () => {
    let t = 0;
    let polls = 0;
    const sleeps: number[] = [];
    const reason = await runTelemetryDaemonLoop({
      pollIntervalMs: 1000,
      idleExitMs: 1_000_000, // would never fire on its own
      maxWallClockMs: 3500,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      poll: async () => {
        polls++;
        return 'active';
      },
    });
    expect(reason).toBe('wall-clock');
    expect(polls).toBe(5);
    expect(sleeps).toEqual([1000, 1000, 1000, 1000]);
  });

  test("'backoff'-shaped activity (mapped to 'active' by pollProjectOnce) also resets the idle clock", async () => {
    // Exercised at the runTelemetryDaemonLoop level with the literal outcome
    // the loop itself understands ('active') — pollProjectOnce's OWN mapping
    // of flushOnce's 'backoff' outcome to 'active' is covered separately
    // below, without a real HTTP call or a real backoff sleep.
    let t = 0;
    let idleThenActive = 0;
    const reason = await runTelemetryDaemonLoop({
      pollIntervalMs: 100,
      idleExitMs: 300,
      maxWallClockMs: 10_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      poll: async () => {
        idleThenActive++;
        // idle, idle, ACTIVE (resets the clock), idle, idle, idle -> exits idle
        return idleThenActive === 3 ? 'active' : 'idle';
      },
    });
    expect(reason).toBe('idle');
    // Without the reset at iteration 3, idle would have accumulated to 300ms
    // by iteration 4 (100+100+100) and exited there. The reset means the
    // clock restarts at iteration 3, so it takes 3 MORE idle iterations
    // (4, 5, 6) to reach 300ms again — proving the reset actually happened.
    expect(idleThenActive).toBe(6);
  });

  test("'disabled' exits immediately, bypassing both bounds (no sleep at all)", async () => {
    let t = 0;
    let polls = 0;
    const sleeps: number[] = [];
    const reason = await runTelemetryDaemonLoop({
      pollIntervalMs: 1000,
      idleExitMs: 5000,
      maxWallClockMs: 10_000,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      poll: async () => {
        polls++;
        return 'disabled';
      },
    });
    expect(reason).toBe('disabled');
    expect(polls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test('maxIterations (test-only) stops the loop before either real bound', async () => {
    let t = 0;
    let polls = 0;
    const reason = await runTelemetryDaemonLoop({
      pollIntervalMs: 1000,
      idleExitMs: 1_000_000,
      maxWallClockMs: 1_000_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      poll: async () => {
        polls++;
        return 'active';
      },
      maxIterations: 3,
    });
    expect(reason).toBe('max-iterations');
    expect(polls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// runTelemetryDaemonLoop — REAL wall-clock (proves the actual for(;;) exits)
// ---------------------------------------------------------------------------

describe('runTelemetryDaemonLoop — REAL clock, REAL setTimeout sleeps (not injected)', () => {
  test('idle-exits for real within a small, bounded window', async () => {
    const startedAt = Date.now();
    let polls = 0;
    const reason = await runTelemetryDaemonLoop({
      pollIntervalMs: 10,
      idleExitMs: 40,
      maxWallClockMs: 10_000,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      poll: async () => {
        polls++;
        return 'idle';
      },
    });
    const elapsed = Date.now() - startedAt;
    expect(reason).toBe('idle');
    // Real timers are never exact: it must take AT LEAST the idle bound (it
    // cannot exit before the bound elapses), and it must not run away — a
    // regression back to a bare `for (;;)` would hang this assertion instead
    // of merely running a little long.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(3000);
    expect(polls).toBeGreaterThan(1);
  }, 5000);

  test('max-wall-clock exits for real, even under continuous activity', async () => {
    const startedAt = Date.now();
    const reason = await runTelemetryDaemonLoop({
      pollIntervalMs: 10,
      idleExitMs: 10_000, // would not fire on its own within the window below
      maxWallClockMs: 50,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      poll: async () => 'active',
    });
    const elapsed = Date.now() - startedAt;
    expect(reason).toBe('wall-clock');
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(3000);
  }, 5000);
});

// ---------------------------------------------------------------------------
// pollProjectOnce — one real poll cycle, network mocked (never a real call)
// ---------------------------------------------------------------------------

describe('pollProjectOnce', () => {
  test("PIPELINE_SYNC_LOCAL_STATS=0 -> 'disabled'", async () => {
    const root = mkProject();
    const deps: TelemetryDaemonPollDeps = {
      fs: realFs,
      env: { PIPELINE_SYNC_LOCAL_STATS: '0' },
      platform: 'linux',
      homedir: root,
      now: () => Date.now(),
    };
    expect(await pollProjectOnce(deps, root)).toBe('disabled');
  });

  test("no cloud.json binding -> 'idle' (F7: no account, nothing to upload to)", async () => {
    const root = mkProject();
    const deps: TelemetryDaemonPollDeps = { ...home(root), fs: realFs, now: () => Date.now() };
    expect(await pollProjectOnce(deps, root)).toBe('idle');
  });

  test("bound + credentialed, empty queue -> 'idle', and no request is ever built", async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    const requests: UploadRequest[] = [];
    const fetchImpl: UploadFetch = async (req) => {
      requests.push(req);
      return { status: 200 };
    };
    const deps: TelemetryDaemonPollDeps = { ...home(root), fs: realFs, now: () => Date.now(), fetch: fetchImpl };
    expect(await pollProjectOnce(deps, root)).toBe('idle');
    expect(requests.length).toBe(0);
  });

  test("a queued record actually reaches flushOnce and is sent -> 'active' (no real network call made)", async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    plantInQueue(root, [rec()]);
    const requests: UploadRequest[] = [];
    const fetchImpl: UploadFetch = async (req) => {
      requests.push(req);
      return { status: 200 };
    };
    const deps: TelemetryDaemonPollDeps = { ...home(root), fs: realFs, now: () => Date.now(), fetch: fetchImpl };
    expect(await pollProjectOnce(deps, root)).toBe('active');
    expect(requests.length).toBe(1);
    expect(requests[0].url).toContain('/api/v1/ingest');
  });

  test("a scheduled backoff (flushOnce's own 'backoff' outcome) still maps to 'active' — there is a queue waiting, not nothing to do", async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    plantInQueue(root, [rec()]);
    mkdirSync(telemetryDir(root), { recursive: true });
    writeFileSync(
      uploadStatePath(root),
      JSON.stringify({ schema: 1, attempt: 2, next_attempt_at: Date.now() + 60_000 }),
    );
    const fetchImpl: UploadFetch = async () => {
      throw new Error('must not be called — the flush is backed off, not attempted');
    };
    const deps: TelemetryDaemonPollDeps = { ...home(root), fs: realFs, now: () => Date.now(), fetch: fetchImpl };
    expect(await pollProjectOnce(deps, root)).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// parseTelemetryDaemonArgs
// ---------------------------------------------------------------------------

describe('parseTelemetryDaemonArgs', () => {
  test('requires --project-root', () => {
    const r = parseTelemetryDaemonArgs([]);
    expect('error' in r).toBe(true);
  });

  test('applies the documented defaults', () => {
    const root = mkProject();
    const r = parseTelemetryDaemonArgs(['--project-root', root]);
    if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
    expect(r.projectRoot).toBe(root);
    expect(r.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(r.idleExitMs).toBe(DEFAULT_IDLE_EXIT_MS);
    expect(r.maxWallClockMs).toBe(DEFAULT_MAX_WALL_CLOCK_MS);
    expect(r.once).toBe(false);
  });

  test('--once and numeric overrides (both --flag value and --flag=value forms)', () => {
    const root = mkProject();
    const r = parseTelemetryDaemonArgs([
      '--project-root',
      root,
      '--once',
      '--poll-interval-ms',
      '1234',
      '--idle-exit-ms=5678',
      '--max-wall-clock-ms',
      '999',
    ]);
    if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
    expect(r.once).toBe(true);
    expect(r.pollIntervalMs).toBe(1234);
    expect(r.idleExitMs).toBe(5678);
    expect(r.maxWallClockMs).toBe(999);
  });

  test('rejects a non-positive numeric flag', () => {
    const root = mkProject();
    const r = parseTelemetryDaemonArgs(['--project-root', root, '--idle-exit-ms', '0']);
    expect('error' in r).toBe(true);
  });

  test('rejects an unknown argument', () => {
    const root = mkProject();
    const r = parseTelemetryDaemonArgs(['--project-root', root, '--bogus']);
    expect('error' in r).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runTelemetryDaemon — CLI wrapper
// ---------------------------------------------------------------------------

describe('runTelemetryDaemon — CLI wrapper', () => {
  function makeDeps(overrides: Partial<TelemetryDaemonCliDeps> = {}): {
    deps: TelemetryDaemonCliDeps;
    outLines: string[];
    errLines: string[];
  } {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const deps: TelemetryDaemonCliDeps = {
      fs: realFs,
      env: {},
      platform: 'linux',
      homedir: '/nonexistent-home',
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      out: (s) => outLines.push(s),
      err: (s) => errLines.push(s),
      ...overrides,
    };
    return { deps, outLines, errLines };
  }

  test('--help prints usage and exits 0', async () => {
    const { deps, outLines } = makeDeps();
    const code = await runTelemetryDaemon(['--help'], deps);
    expect(code).toBe(0);
    expect(outLines.join('')).toContain('Usage: pipeline telemetry-daemon');
  });

  test('missing --project-root -> exit 2, usage on stderr', async () => {
    const { deps, errLines } = makeDeps();
    const code = await runTelemetryDaemon([], deps);
    expect(code).toBe(2);
    expect(errLines.join('')).toContain('--project-root is required');
  });

  test('a --project-root that does not exist -> exit 2', async () => {
    const { deps, errLines } = makeDeps();
    const missing = join(tmpdir(), `td-does-not-exist-${Date.now()}`);
    const code = await runTelemetryDaemon(['--project-root', missing], deps);
    expect(code).toBe(2);
    expect(errLines.join('')).toContain('does not exist');
  });

  test('--once runs exactly one poll cycle and reports the outcome (no cloud account -> idle)', async () => {
    const root = mkProject();
    const { deps, outLines } = makeDeps({ homedir: root, env: { PIPELINE_CLOUD_HOME: join(root, 'cfg') } });
    const code = await runTelemetryDaemon(['--project-root', root, '--once'], deps);
    expect(code).toBe(0);
    expect(outLines.join('')).toContain('poll: idle');
  });

  test('--once with PIPELINE_SYNC_LOCAL_STATS=0 -> reports disabled', async () => {
    const root = mkProject();
    const { deps, outLines } = makeDeps({
      homedir: root,
      env: { PIPELINE_CLOUD_HOME: join(root, 'cfg'), PIPELINE_SYNC_LOCAL_STATS: '0' },
    });
    const code = await runTelemetryDaemon(['--project-root', root, '--once'], deps);
    expect(code).toBe(0);
    expect(outLines.join('')).toContain('poll: disabled');
  });
});
