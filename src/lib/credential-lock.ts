// credential-lock.ts — cross-process advisory lock guarding the credential
// store's read-refresh-write cycle (a5, 04-cloud-auth.md §6: "an advisory
// lock around refresh, atomic write-then-rename... concurrent callers
// awaiting the one in-flight refresh").
//
// WHY A LOCKFILE, NOT flock(): Windows has no POSIX advisory-lock syscall
// Bun/Node exposes uniformly, and this store is read/written by processes on
// whichever platform the user is on. The one primitive that IS atomic on
// both NTFS and every POSIX filesystem with no extra syscalls is EXCLUSIVE
// FILE CREATION — `open(path, O_CREAT | O_EXCL)`, Node/Bun's `'wx'` flag,
// which either creates the file (this call is now the sole holder) or fails
// EEXIST (someone else holds it) — there is no window where two callers can
// both believe they created it. That single guarantee is the entire
// correctness argument below; the file's CONTENTS (pid/host/timestamp) are
// diagnostic only, never load-bearing for mutual exclusion itself.
//
// STALE-HOLDER RECOVERY: a holder that is SIGKILLed or crashes mid-refresh
// never runs its `finally` release, so a plain "wait forever for the file to
// disappear" design would wedge every future refresh on this machine the
// first time one is interrupted — unacceptable for a lock that gates
// ordinary token refresh (this is the "a lock nobody releases must not wedge
// the CLI forever" requirement). A waiter that fails to acquire may STEAL
// the lock (delete it, then retry its own exclusive create) when EITHER:
//   - the recorded pid is no longer alive on THIS host (a crashed holder), or
//   - the lock is older than `staleMs` regardless of pid (covers a holder
//     whose liveness this process cannot observe — e.g. the config dir is a
//     network mount shared across hosts — and covers a holder legitimately
//     alive but stuck far longer than any real refresh HTTP round trip
//     should ever take).
// Stealing is itself racy — two waiters can both decide to steal at once —
// but that race resolves through the SAME exclusive-create primitive: only
// one steal-then-create wins, the other observes EEXIST and loops again.
// Nothing here depends on absolute steal fairness for correctness; DoD box 5
// ("neither is starved") rests on bounded hold times (a single HTTP round
// trip) and the retry loop, not on lock-queue ordering.

import { openSync, closeSync, writeSync, unlinkSync, statSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';

export interface LockDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pid: number;
  hostname: string;
}

export const realLockDeps: LockDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pid: process.pid,
  hostname: safeHostname(),
};

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return 'unknown-host';
  }
}

export class LockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockTimeoutError';
  }
}

export interface LockHandle {
  release(): void;
}

export interface AcquireLockOptions {
  /** Total time willing to wait for the lock before giving up. */
  timeoutMs?: number;
  /** Delay between failed acquire attempts (not applied on a steal retry). */
  pollIntervalMs?: number;
  /** A lock older than this, or whose holder pid is dead, is stealable. */
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 40;
/** Generous relative to a single HTTP refresh round trip (seconds, not
 *  tens-of-seconds) — wide enough that a slow-but-alive holder is never
 *  mistaken for dead, tight enough that a crashed holder does not wedge the
 *  CLI for long. */
const DEFAULT_STALE_MS = 30_000;

interface LockPayload {
  pid: number;
  host: string;
  acquiredAt: number;
}

/**
 * Block (async-poll) until `lockPath` can be exclusively created, then
 * return a handle whose `release()` removes it. Never resolves with two live
 * handles outstanding for the same path at once — see the module doc for why
 * exclusive creation is the whole correctness argument. Throws
 * `LockTimeoutError` if `timeoutMs` elapses first (a stuck-forever holder
 * that is somehow still alive AND younger than `staleMs` — deliberately rare
 * — surfaces as a clean, catchable error, never an indefinite hang).
 */
export async function acquireLock(
  lockPath: string,
  deps: LockDeps = realLockDeps,
  opts: AcquireLockOptions = {},
): Promise<LockHandle> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const deadline = deps.now() + timeoutMs;

  for (;;) {
    if (tryCreate(lockPath, deps)) {
      return { release: () => releaseLock(lockPath) };
    }
    if (isStale(lockPath, deps, staleMs)) {
      tryUnlink(lockPath); // best-effort steal; a racing stealer may win instead — fine, loop again
      continue; // retry the exclusive create immediately, no sleep
    }
    if (deps.now() >= deadline) {
      throw new LockTimeoutError(
        `timed out after ${timeoutMs}ms waiting for the credential-store lock at ${lockPath} — ` +
          `another process may be stuck holding it`,
      );
    }
    await deps.sleep(pollMs);
  }
}

function tryCreate(lockPath: string, deps: LockDeps): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    const payload: LockPayload = { pid: deps.pid, host: deps.hostname, acquiredAt: deps.now() };
    writeSync(fd, JSON.stringify(payload));
  } finally {
    closeSync(fd);
  }
  return true;
}

function isStale(lockPath: string, deps: LockDeps, staleMs: number): boolean {
  let mtimeMs: number;
  let raw = '';
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
    raw = readFileSync(lockPath, 'utf-8');
  } catch {
    // Gone between the failed create and this check — a normal release
    // raced us; not stale, just already free (the next loop iteration's
    // create attempt will succeed on its own).
    return false;
  }
  let payload: Partial<LockPayload> = {};
  try {
    payload = JSON.parse(raw) as Partial<LockPayload>;
  } catch {
    // Unparseable contents (e.g. a partially-flushed write, vanishingly
    // unlikely for a payload this small) — fall back to file age alone.
  }
  const acquiredAt = typeof payload.acquiredAt === 'number' ? payload.acquiredAt : mtimeMs;
  if (deps.now() - acquiredAt > staleMs) return true;
  if (typeof payload.pid === 'number' && payload.host === deps.hostname && !isProcessAlive(payload.pid)) {
    return true;
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but this process lacks permission to
    // signal it — still alive. Anything else (ESRCH, or the Windows
    // equivalent Node's libuv shim throws) means it is gone.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

function tryUnlink(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Lost the steal race to someone else, or already gone — fine either way.
  }
}
