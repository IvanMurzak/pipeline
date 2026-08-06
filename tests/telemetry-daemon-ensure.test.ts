/**
 * `commands/telemetry-daemon.ts`'s own `ensureTelemetryDaemonRunning` /
 * `acquireDaemonLock` (ux-v2 b12) — the headless-`drive` counterpart of
 * `hooks/analytics_relay.ts`'s `ensureTelemetryDaemonRunning`, exercised the
 * same two-layer way `apps/pipeline-cli/tests/hook-telemetry-daemon-lock.test.ts`
 * exercises the hook's copy:
 *
 *   - `acquireDaemonLock` against a REAL filesystem (a tmpdir) — the
 *     exclusive-create primitive IS the mechanism, so mocking `fs` would test
 *     nothing. This is where the RACE and the STALE-LOCK RECLAMATION are
 *     proven.
 *   - `ensureTelemetryDaemonRunning`'s GATING (sync disabled / no cloud
 *     account / an already-live daemon) — never through the branch that would
 *     spawn a real detached `pipeline telemetry-daemon` process. Every
 *     scenario below either gates out before that branch, or pre-seeds a
 *     lock pointing at THIS test process's own pid (always alive) so the
 *     function takes the "already running" early return.
 *
 * `telemetryDaemonLockPath`/`LOCK_STALE_AGE_MS` are the SAME constants the
 * hook's own copy is pinned against in `telemetry-daemon-lock-parity.test.ts`
 * — this file does not re-prove that agreement, only that THIS module's own
 * acquire/gate logic behaves like the hook's.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  acquireDaemonLock,
  ensureTelemetryDaemonRunning,
  telemetryDaemonLockPath,
  LOCK_STALE_AGE_MS,
} from '../src/commands/telemetry-daemon';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function mkProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'telemetry-daemon-ensure-'));
  created.push(d);
  return d;
}

function lockDirFor(root: string): string {
  return join(root, '.pipeline', '.runtime', 'telemetry');
}

function seedLock(root: string, lock: { pid: number; started_at: string }): string {
  const dir = lockDirFor(root);
  mkdirSync(dir, { recursive: true });
  const lockPath = telemetryDaemonLockPath(root);
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  return lockPath;
}

/** A real, reliably-DEAD pid — see hook-telemetry-daemon-lock.test.ts's own
 *  identical helper for why this beats a hardcoded large number. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['--version']);
  const pid = r.pid;
  if (typeof pid !== 'number' || pid <= 0) throw new Error('spawnSync did not report a pid');
  return pid;
}

// ---------------------------------------------------------------------------
// acquireDaemonLock — mutual exclusion
// ---------------------------------------------------------------------------

describe('acquireDaemonLock — mutual exclusion', () => {
  test('an unheld lock is acquired, creating the file with the caller pid', () => {
    const root = mkProject();
    mkdirSync(lockDirFor(root), { recursive: true });
    const lockPath = telemetryDaemonLockPath(root);
    const now = 1_000_000;

    const result = acquireDaemonLock(lockPath, now, 4242);

    expect(result).toEqual({ action: 'acquired' });
    const written = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(written.pid).toBe(4242);
  });

  test('a lock already held by a LIVE pid is untouched, reports already-running', () => {
    const root = mkProject();
    const now = 1_000_000;
    const before = { pid: process.pid, started_at: new Date(now).toISOString() };
    const lockPath = seedLock(root, before);

    const result = acquireDaemonLock(lockPath, now, 9999);

    expect(result).toEqual({ action: 'already-running', pid: process.pid });
    expect(JSON.parse(readFileSync(lockPath, 'utf-8'))).toEqual(before);
  });

  test('TWO NEAR-SIMULTANEOUS acquires on the SAME fresh lock: exactly ONE acquired', () => {
    const root = mkProject();
    mkdirSync(lockDirFor(root), { recursive: true });
    const lockPath = telemetryDaemonLockPath(root);
    const now = 1_000_000;

    const first = acquireDaemonLock(lockPath, now, process.pid);
    const second = acquireDaemonLock(lockPath, now, process.pid);

    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.action === 'acquired')).toHaveLength(1);
    expect(outcomes.filter((o) => o.action === 'already-running')).toHaveLength(1);
    const onDisk = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(onDisk.pid).toBe(process.pid);
  });
});

// ---------------------------------------------------------------------------
// acquireDaemonLock — stale-lock reclamation
// ---------------------------------------------------------------------------

describe('acquireDaemonLock — stale-lock reclamation', () => {
  test('a lock recorded by a DEAD pid is reclaimed immediately, even though fresh by age', () => {
    const root = mkProject();
    const now = 1_000_000;
    const dead = deadPid();
    const lockPath = seedLock(root, { pid: dead, started_at: new Date(now).toISOString() });

    const result = acquireDaemonLock(lockPath, now, 5555);

    expect(result).toEqual({ action: 'acquired' });
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).pid).toBe(5555);
  });

  test('a lock older than LOCK_STALE_AGE_MS is reclaimed even though its pid is genuinely ALIVE', () => {
    const root = mkProject();
    const now = 1_000_000;
    const ancientStartedAt = now - (LOCK_STALE_AGE_MS + 1);
    const lockPath = seedLock(root, { pid: process.pid, started_at: new Date(ancientStartedAt).toISOString() });

    const result = acquireDaemonLock(lockPath, now, 6666);

    expect(result).toEqual({ action: 'acquired' });
  });

  test('a FRESH lock with a genuinely alive pid is NEVER reclaimed', () => {
    const root = mkProject();
    const now = 1_000_000;
    const lockPath = seedLock(root, { pid: process.pid, started_at: new Date(now).toISOString() });

    const result = acquireDaemonLock(lockPath, now, 7777);

    expect(result).toEqual({ action: 'already-running', pid: process.pid });
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
  });

  test('a corrupt/unreadable lock file is treated as absent and can be acquired outright', () => {
    const root = mkProject();
    mkdirSync(lockDirFor(root), { recursive: true });
    const lockPath = telemetryDaemonLockPath(root);
    writeFileSync(lockPath, '{ not json');

    const result = acquireDaemonLock(lockPath, 1_000_000, 8888);

    expect(result).toEqual({ action: 'acquired' });
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).pid).toBe(8888);
  });
});

// ---------------------------------------------------------------------------
// ensureTelemetryDaemonRunning — gating. Never exercises the real spawn
// branch (mirrors hook-telemetry-daemon-lock.test.ts's own reasoning: doing
// so for real would fork a genuine detached background process inside
// `bun test`, which must never happen).
// ---------------------------------------------------------------------------

describe('ensureTelemetryDaemonRunning — gating (no network work, no real spawn exercised here)', () => {
  const SYNC_KEY = 'PIPELINE_SYNC_LOCAL_STATS';
  const saved = process.env[SYNC_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[SYNC_KEY];
    else process.env[SYNC_KEY] = saved;
  });

  test('PIPELINE_SYNC_LOCAL_STATS=0 -> no telemetry dir is even created (gates before any lock I/O)', () => {
    process.env[SYNC_KEY] = '0';
    const root = mkProject();
    mkdirSync(join(root, '.pipeline'), { recursive: true });
    writeFileSync(join(root, '.pipeline', 'cloud.json'), JSON.stringify({ server: 'https://x', org: 'acme' }));

    ensureTelemetryDaemonRunning(root);

    expect(existsSync(lockDirFor(root))).toBe(false);
  });

  test('no .pipeline/cloud.json -> no telemetry dir is created (F7: no cloud account, nothing spawned)', () => {
    delete process.env[SYNC_KEY];
    const root = mkProject();
    mkdirSync(join(root, '.pipeline'), { recursive: true });

    ensureTelemetryDaemonRunning(root);

    expect(existsSync(lockDirFor(root))).toBe(false);
  });

  test('cloud.json present, an already-running (this process pid) lock exists -> left untouched, no spawn attempted', () => {
    delete process.env[SYNC_KEY];
    const root = mkProject();
    mkdirSync(join(root, '.pipeline'), { recursive: true });
    writeFileSync(join(root, '.pipeline', 'cloud.json'), JSON.stringify({ server: 'https://x', org: 'acme' }));
    const before = { pid: process.pid, started_at: new Date().toISOString() };
    const lockPath = seedLock(root, before);

    ensureTelemetryDaemonRunning(root);

    expect(JSON.parse(readFileSync(lockPath, 'utf-8'))).toEqual(before);
  });
});
