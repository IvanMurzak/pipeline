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
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFs, fingerprintSaltFilePath } from '../src/lib/cloud-config';
import { journalPath, telemetryDir, type OutboxRecord } from '../src/lib/telemetry-outbox';
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

// ---------------------------------------------------------------------------
// Journal helpers (ux-v2 b17) — a manager-driven run's ONLY telemetry path is
// the project journal (`.pipeline/.runtime/events.jsonl`), never
// `outbox.jsonl` directly (that is what `plantInQueue` simulates for the
// upload-path tests above). `pollProjectOnce` must drain the journal itself
// — see `src/commands/telemetry-daemon.ts`'s own doc comment on that call.
// ---------------------------------------------------------------------------

/** Shape mirrors `telemetry-outbox-interleaving.test.ts`'s own `evt()` — the
 *  minimum a real journal line needs to survive `drainJournal`'s parse and
 *  privacy filter and be enqueued under a real `run_id`. */
function journalEvent(runId: string, type = 'tool.called'): Record<string, unknown> {
  return {
    schema: 5,
    ts: new Date().toISOString(),
    type,
    project_root: 'C:/proj',
    worktree: null,
    run_id: runId,
    parent_run_id: null,
    session_id: 'sess-1',
    data: {},
  };
}

function appendJournal(root: string, e: Record<string, unknown>): void {
  writeFileSync(journalPath(root), `${JSON.stringify(e)}\n`, { flag: 'a' });
}

/** Hold the outbox's `drain.lock` with a REAL `wx`-created fd, simulating a
 *  concurrent `drive` process (or another daemon poll) mid-drain — the SAME
 *  primitive `drainJournal` itself contends for. Duplicated from
 *  `telemetry-outbox-interleaving.test.ts` rather than imported — this
 *  repo's house style for test-only fixtures, per that file's own header. */
function holdLock(root: string): { release: () => void } {
  const lockPath = join(telemetryDir(root), 'drain.lock');
  mkdirSync(telemetryDir(root), { recursive: true });
  const fd = openSync(lockPath, 'wx', 0o600);
  return {
    release: () => {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    },
  };
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
// pollProjectOnce — journal drain (ux-v2 b17)
//
// b12 wired `drainJournal()` into `drive` and into `next.ts`'s step-boundary
// flush, but never into the daemon's own poll — a manager-driven run
// (`/pipeline:run`, no `drive` process) has NO OTHER path to the outbox.
// Every test above this block plants records directly in `outbox.jsonl`
// (`plantInQueue`), which is exactly why the daemon's own suite never caught
// the gap: it never exercised the journal at all. These tests write to the
// project JOURNAL instead (`appendJournal`, the real intake for a
// manager-driven run) and prove `pollProjectOnce` itself drains it.
// ---------------------------------------------------------------------------

describe('pollProjectOnce — journal drain (ux-v2 b17)', () => {
  test("a manager-driven run's journal events reach the outbox and are sent — nothing pre-planted in outbox.jsonl", async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    // The ONLY telemetry surface a manager-driven run writes to. Before this
    // task's fix, pollProjectOnce never reads it: the outbox stays empty,
    // flushOnce finds nothing, and the poll reports 'idle' forever even
    // though the journal keeps growing.
    appendJournal(root, journalEvent('run-b17'));
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

  test('a project with no journal at all still reports idle (nothing regresses for the no-journal case)', async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    const fetchImpl: UploadFetch = async () => ({ status: 200 });
    const deps: TelemetryDaemonPollDeps = { ...home(root), fs: realFs, now: () => Date.now(), fetch: fetchImpl };
    expect(await pollProjectOnce(deps, root)).toBe('idle');
  });

  // ── the concurrency risk (task b17): deadlock vs. double-enqueue ─────────
  //
  // `drainJournal()`'s own lock attempt is a ZERO-wait `tryLockSync(..., 0)`
  // (telemetry-outbox.ts) — it was already built to coexist with a
  // concurrently-draining `drive` process before this daemon call existed
  // (see telemetry-outbox-interleaving.test.ts, b12). That makes DEADLOCK
  // structurally impossible here: a held lock is never waited on, so this
  // new caller cannot block the poll loop. The real risk this wiring could
  // still introduce is DOUBLE-ENQUEUE — draining the same journal bytes
  // twice into two different `seq` values. The test below proves neither:
  // the poll under lock contention returns promptly with nothing sent (the
  // drain was correctly deferred, not lost), and the very next poll drains
  // and sends the SAME event exactly once.
  test('a concurrently-held drain.lock does not stall the poll and does not lose or duplicate the event', async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    appendJournal(root, journalEvent('run-b17-locked'));
    const requests: UploadRequest[] = [];
    const fetchImpl: UploadFetch = async (req) => {
      requests.push(req);
      return { status: 200 };
    };
    const deps: TelemetryDaemonPollDeps = { ...home(root), fs: realFs, now: () => Date.now(), fetch: fetchImpl };

    const held = holdLock(root);
    let outcome: string;
    let elapsedMs: number;
    try {
      const startedAt = Date.now();
      outcome = await pollProjectOnce(deps, root);
      elapsedMs = Date.now() - startedAt;
    } finally {
      held.release();
    }
    // Deferred: the lock was held, so this cycle drained nothing and had
    // nothing to send.
    expect(outcome).toBe('idle');
    expect(requests.length).toBe(0);
    // Non-blocking: a regression to a WAITING lock acquisition (or, worse, a
    // genuine deadlock) would show up here as a multi-second — or infinite —
    // stall instead of an effectively immediate return.
    expect(elapsedMs!).toBeLessThan(500);

    // Lock free now. The next poll cycle drains the SAME journal bytes
    // (the cursor never advanced while the lock was held) and sends the
    // event exactly once — not duplicated, not lost.
    expect(await pollProjectOnce(deps, root)).toBe('active');
    expect(requests.length).toBe(1);
    expect(requests[0].url).toContain('/api/v1/ingest');

    // A third cycle proves it too: the cursor advanced past the one line
    // that existed, so there is nothing left to re-send.
    expect(await pollProjectOnce(deps, root)).toBe('idle');
    expect(requests.length).toBe(1);
  });

  // ── no stale lock on any exit path ────────────────────────────────────────
  test('drain.lock is never left behind after a normal poll cycle', async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    appendJournal(root, journalEvent('run-b17-clean'));
    const fetchImpl: UploadFetch = async () => ({ status: 200 });
    const deps: TelemetryDaemonPollDeps = { ...home(root), fs: realFs, now: () => Date.now(), fetch: fetchImpl };
    await pollProjectOnce(deps, root);
    expect(existsSync(join(telemetryDir(root), 'drain.lock'))).toBe(false);
  });

  test('drain.lock is never left behind even when the subsequent flush itself fails (5xx -> retry)', async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    appendJournal(root, journalEvent('run-b17-flusherr'));
    const fetchImpl: UploadFetch = async () => ({ status: 503 });
    const deps: TelemetryDaemonPollDeps = { ...home(root), fs: realFs, now: () => Date.now(), fetch: fetchImpl };
    const outcome = await pollProjectOnce(deps, root);
    // 'retry' maps to 'active' (there's a queue, the daemon is on it) — the
    // point of this test is the LOCK, not the outcome mapping (already
    // covered above).
    expect(outcome).toBe('active');
    expect(existsSync(join(telemetryDir(root), 'drain.lock'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pollProjectOnce — the fingerprint salt reaches the wire (ux-v2 b18,
// 07-security.md T16/SG13)
//
// `b15` shipped the per-install CSPRNG salt but wired it only into
// `run-identity.ts`'s project fingerprint (`commands/hash.ts`'s sole
// consumer) — nothing uploads that value. `pollProjectOnce` IS one of the
// paths that actually uploads: `drainJournal()` filters every journal event
// with the outbox's salt at enqueue time, and `flushOnce()` reuses the SAME
// `outbox.fingerprintSalt` for the wire-side re-filter. Before this task,
// `commands/telemetry-daemon.ts:529` (line numbers moved under `b17`) built
// its `TelemetryOutbox` with no `fingerprintSalt` at all, so every
// fingerprinted field on the wire — `project_root` included — was an HMAC
// under an EMPTY key. These tests go through the REAL entry point
// (`pollProjectOnce`), inspecting the captured wire body, not
// `resolveOutboxFingerprintSalt` internals.
// ---------------------------------------------------------------------------

describe('pollProjectOnce — the fingerprint salt reaches the wire (ux-v2 b18)', () => {
  test('WIRING PROOF: two different installs produce DIFFERENT wire fingerprints for the identical project_root', async () => {
    const rootA = mkProject();
    boundAndCredentialed(rootA);
    appendJournal(rootA, journalEvent('run-wire-a'));
    const requestsA: UploadRequest[] = [];
    const fetchA: UploadFetch = async (req) => {
      requestsA.push(req);
      return { status: 200 };
    };
    const depsA: TelemetryDaemonPollDeps = { ...home(rootA), fs: realFs, now: () => Date.now(), fetch: fetchA };
    expect(await pollProjectOnce(depsA, rootA)).toBe('active');
    expect(requestsA.length).toBe(1);
    const bodyA = JSON.parse(requestsA[0].body) as { events: Array<{ payload: { project_root?: string } }> };
    const fpA = bodyA.events[0].payload.project_root;
    // `journalEvent()` hard-codes `project_root: 'C:/proj'` — a well-formed
    // fingerprint proves the filter ran; the salt below proves WHICH key.
    expect(fpA).toMatch(/^fp:[0-9a-f]{16}$/);

    // A second, independent "install" — different homedir/PIPELINE_CLOUD_HOME
    // ⇒ its own generated per-install salt — fingerprinting the SAME
    // `project_root` value.
    const rootB = mkProject();
    boundAndCredentialed(rootB);
    appendJournal(rootB, journalEvent('run-wire-b'));
    const requestsB: UploadRequest[] = [];
    const fetchB: UploadFetch = async (req) => {
      requestsB.push(req);
      return { status: 200 };
    };
    const depsB: TelemetryDaemonPollDeps = { ...home(rootB), fs: realFs, now: () => Date.now(), fetch: fetchB };
    expect(await pollProjectOnce(depsB, rootB)).toBe('active');
    const bodyB = JSON.parse(requestsB[0].body) as { events: Array<{ payload: { project_root?: string } }> };
    const fpB = bodyB.events[0].payload.project_root;

    // MUTATION-PROVABLE: if pollProjectOnce stopped resolving/threading the
    // install salt (reverted to `new TelemetryOutbox({ projectRoot, org,
    // env, now })` with no `fingerprintSalt`), this outbox would either
    // throw (empty-salt guard) or — pre-b18 — both installs would silently
    // collapse to the SAME empty-string key, making fpA === fpB.
    expect(fpA).not.toBe(fpB);

    // NEVER UPLOADED: the raw per-install secret itself is not the wire
    // value — read it back off disk and confirm its absence from the body.
    const saltPathA = fingerprintSaltFilePath({ ...home(rootA) });
    const rawSaltA = (JSON.parse(readFileSync(saltPathA, 'utf-8')) as { salt: string }).salt;
    expect(requestsA[0].body).not.toContain(rawSaltA);
  });

  test('the SAME install (same homedir) reuses the SAME wire fingerprint across two poll cycles', async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    appendJournal(root, journalEvent('run-stable-1'));
    const requests: UploadRequest[] = [];
    const fetchImpl: UploadFetch = async (req) => {
      requests.push(req);
      return { status: 200 };
    };
    const deps: TelemetryDaemonPollDeps = { ...home(root), fs: realFs, now: () => Date.now(), fetch: fetchImpl };
    expect(await pollProjectOnce(deps, root)).toBe('active');
    expect(requests.length).toBe(1);

    // A second event, a second (fresh, per-cycle — see pollProjectOnce's own
    // doc comment) TelemetryOutbox instance, same project ⇒ same on-disk salt.
    appendJournal(root, journalEvent('run-stable-2'));
    expect(await pollProjectOnce(deps, root)).toBe('active');
    expect(requests.length).toBe(2);

    const fp1 = (JSON.parse(requests[0].body) as { events: Array<{ payload: { project_root?: string } }> }).events[0]
      .payload.project_root;
    const fp2 = (JSON.parse(requests[1].body) as { events: Array<{ payload: { project_root?: string } }> }).events[0]
      .payload.project_root;
    expect(fp1).toBe(fp2);
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
