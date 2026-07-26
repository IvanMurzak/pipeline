// credential-lock.test.ts — the cross-process advisory lock (a5) that
// credential-refresh.ts wraps the whole read-refresh-write cycle in.
//
// These tests exercise the REAL filesystem (a tmpdir) — the exclusive-create
// primitive IS the mechanism, so mocking it would test nothing. Cross-PROCESS
// single-flight (two real `bun` processes) is proven separately in
// credential-refresh-cross-process.test.ts; this file proves the lock
// primitive itself: mutual exclusion, stale-holder theft (both by dead pid
// and by age), and that a genuinely live holder is never stolen from.

import { test, expect, afterEach, describe } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, LockTimeoutError, type LockDeps } from '../src/lib/credential-lock';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function mkDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pipeline-cred-lock-'));
  created.push(d);
  return d;
}

function fakeDeps(overrides: Partial<LockDeps> = {}): LockDeps {
  return {
    now: () => 1_000_000,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pid: process.pid,
    hostname: 'test-host',
    ...overrides,
  };
}

describe('acquireLock — mutual exclusion', () => {
  test('acquires an unheld lock immediately and writes a diagnostic payload', async () => {
    const dir = mkDir();
    const lockPath = join(dir, 'credentials.lock');
    const handle = await acquireLock(lockPath, fakeDeps());
    expect(existsSync(lockPath)).toBe(true);
    const payload = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(payload.pid).toBe(process.pid);
    expect(payload.host).toBe('test-host');
    handle.release();
  });

  test('release() removes the lock file, allowing the next acquire', async () => {
    const dir = mkDir();
    const lockPath = join(dir, 'credentials.lock');
    const first = await acquireLock(lockPath, fakeDeps());
    first.release();
    expect(existsSync(lockPath)).toBe(false);
    const second = await acquireLock(lockPath, fakeDeps());
    expect(existsSync(lockPath)).toBe(true);
    second.release();
  });

  test('release() is safe to call when the lock is already gone (no throw)', async () => {
    const dir = mkDir();
    const lockPath = join(dir, 'credentials.lock');
    const handle = await acquireLock(lockPath, fakeDeps());
    handle.release();
    expect(() => handle.release()).not.toThrow();
  });

  test('a second acquire on an ALREADY-HELD lock blocks until release, never granted twice concurrently', async () => {
    const dir = mkDir();
    const lockPath = join(dir, 'credentials.lock');
    const deps = fakeDeps({ now: () => Date.now() }); // real wall clock — this test uses real timers
    const first = await acquireLock(lockPath, deps, { pollIntervalMs: 10, timeoutMs: 5000 });

    let secondAcquiredAt = 0;
    const secondPromise = acquireLock(lockPath, deps, { pollIntervalMs: 10, timeoutMs: 5000 }).then((h) => {
      secondAcquiredAt = Date.now();
      return h;
    });

    // Give the second caller several poll cycles to (wrongly) succeed early.
    await new Promise((r) => setTimeout(r, 120));
    expect(secondAcquiredAt).toBe(0); // still blocked — first holder hasn't released

    const releasedAt = Date.now();
    first.release();
    const second = await secondPromise;
    expect(secondAcquiredAt).toBeGreaterThanOrEqual(releasedAt);
    second.release();
  });
});

describe('acquireLock — stale-holder recovery (DoD: "a lock nobody releases must not wedge the CLI forever")', () => {
  test('a lock recorded by a DEAD pid is stolen immediately, even though it is fresh by age', async () => {
    const dir = mkDir();
    const lockPath = join(dir, 'credentials.lock');
    const now = 1_000_000;
    // A pid far outside any real OS pid space — process.kill against it must
    // report "not alive" on both Windows and POSIX.
    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, host: 'test-host', acquiredAt: now }));

    const deps = fakeDeps({ now: () => now });
    const handle = await acquireLock(lockPath, deps, { pollIntervalMs: 5, timeoutMs: 2000, staleMs: 30_000 });
    // Stolen and re-created with THIS process's own pid.
    const payload = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(payload.pid).toBe(process.pid);
    handle.release();
  });

  test('a lock older than staleMs is stolen even though its recorded pid is genuinely alive (this process)', async () => {
    const dir = mkDir();
    const lockPath = join(dir, 'credentials.lock');
    const now = 1_000_000;
    const ancientAcquiredAt = now - 60_000; // far older than a 30s staleMs
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: 'test-host', acquiredAt: ancientAcquiredAt }));

    const deps = fakeDeps({ now: () => now });
    const handle = await acquireLock(lockPath, deps, { pollIntervalMs: 5, timeoutMs: 2000, staleMs: 30_000 });
    expect(existsSync(lockPath)).toBe(true);
    handle.release();
  });

  test('a FRESH lock with a genuinely alive pid is never stolen — the waiter times out instead', async () => {
    const dir = mkDir();
    const lockPath = join(dir, 'credentials.lock');
    const acquiredAt = Date.now();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: 'test-host', acquiredAt }));

    // NOTE: `now` here must be a REAL advancing clock (Date.now()), not a
    // frozen constant — acquireLock's own deadline check is `deps.now() >=
    // deadline`, computed from `deps.now()` at the START plus `timeoutMs`; a
    // clock that never advances makes that check permanently false and the
    // poll loop below runs forever. The lock file's OWN `acquiredAt` above is
    // still a fixed value — that one is fine frozen, since staleness is
    // judged against the moving `deps.now()`, not the other way around.
    const deps = fakeDeps({ now: () => Date.now(), hostname: 'test-host' });
    await expect(
      acquireLock(lockPath, deps, { pollIntervalMs: 5, timeoutMs: 50, staleMs: 30_000 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    // The original lock (NOT this process's) is still there — never stolen.
    const payload = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(payload.acquiredAt).toBe(acquiredAt);
  });

  test('a lock on a DIFFERENT host is judged by age alone (a local pid check is meaningless across hosts)', async () => {
    const dir = mkDir();
    const lockPath = join(dir, 'credentials.lock');
    const acquiredAt = Date.now();
    // Recorded pid equals THIS process's own pid (so a host-blind pid check
    // would wrongly call it "alive") but the host differs — must fall back
    // to age only, and age here is still within staleMs, so it must NOT be
    // stolen.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: 'some-other-host', acquiredAt }));
    // See the note in the previous test — `now` must be real-advancing here too.
    const deps = fakeDeps({ now: () => Date.now(), hostname: 'this-host' });
    await expect(
      acquireLock(lockPath, deps, { pollIntervalMs: 5, timeoutMs: 50, staleMs: 30_000 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
  });
});

describe('acquireLock — DoD box 5 ("the supervisor and the CLI can both hold the store without either being starved")', () => {
  test('two waiters racing for the same fresh lock BOTH eventually acquire it — neither starves', async () => {
    const dir = mkDir();
    const lockPath = join(dir, 'credentials.lock');
    const deps = fakeDeps({ now: () => Date.now() });
    const order: string[] = [];

    async function contender(name: string, holdMs: number): Promise<void> {
      const handle = await acquireLock(lockPath, deps, { pollIntervalMs: 8, timeoutMs: 5000 });
      order.push(name);
      await new Promise((r) => setTimeout(r, holdMs));
      handle.release();
    }

    await Promise.all([contender('supervisor', 60), contender('cli', 30)]);
    // Both ran (order has two distinct entries) and, because a lock is
    // exclusive, they cannot have been concurrent — the second entry only
    // appears after the first released.
    expect(order).toHaveLength(2);
    expect(new Set(order).size).toBe(2);
    expect(existsSync(lockPath)).toBe(false); // last holder released cleanly
  });
});
