// telemetry-outbox-interleaving.test.ts — ux-v2 `b12`: proves how a
// long-lived `pipeline drive` process tailing a project's journal in-process
// coexists with a SEPARATE (real, detached) daemon process flushing the SAME
// project's outbox, both against the SAME `drain.lock`.
//
// THE BUG THIS GUARDS: before `b12`, `TelemetryOutbox.ack()` was the one
// read-modify-write of `outbox.jsonl` that did NOT take `drain.lock` — safe
// only because nothing but a single, self-serialized daemon ever called it.
// `b12` makes a SECOND caller (drive's own in-process tail, via
// `drainJournal()`) real, so an unlocked `ack()` could race a concurrent
// `enqueue`'s append: read an N-record snapshot, then a full-file `rewrite()`
// after a concurrent append landed, silently dropping it. `quarantine()`
// then compounded the fix trivially wrong the first time: it already held
// the SAME lock and called the (now-locked) `ack()` internally, which is a
// `wx`-exclusive-create RE-ENTRANCY deadlock (proven by regression test
// below) — fixed by giving `ack()` a lock-free `ackLocked` core that
// `quarantine()` calls directly.
//
// Two layers, matching this repo's own convention for `wx`-lock coverage
// (`telemetry-daemon-ensure.test.ts`, `credential-lock.test.ts`):
//   - direct proof against the REAL `drain.lock` file (held by literally
//     opening it, simulating a concurrent process mid-critical-section);
//   - a realistic SEQUENTIAL interleaving of two independent
//     `TelemetryOutbox` instances against the SAME project (exactly what
//     "drive's own instance" + "the daemon's own instance, rebuilt every
//     poll cycle" looks like on disk) proving no record is lost or
//     duplicated across the handoff.

import { afterEach, describe, expect, test } from 'bun:test';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryOutbox, journalPath, telemetryDir } from '../src/lib/telemetry-outbox';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function mkProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'tob-interleave-'));
  created.push(d);
  mkdirSync(join(d, '.pipeline', '.runtime'), { recursive: true });
  return d;
}

function evt(type: string, runId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...extra,
  };
}

function appendJournal(root: string, e: Record<string, unknown>): void {
  writeFileSync(journalPath(root), `${JSON.stringify(e)}\n`, { flag: 'a' });
}

function mkOutbox(root: string, org = 'acme'): TelemetryOutbox {
  return new TelemetryOutbox({
    projectRoot: root,
    org,
    env: {},
    fingerprintSalt: 'test-salt-interleaving-fixture', // b18: required, see telemetry-outbox.test.ts
    onDrop: () => {},
  });
}

/** Hold the outbox's `drain.lock` with a REAL `wx`-created fd, simulating a
 *  concurrent process mid-critical-section — the SAME primitive `enqueue`/
 *  `drainJournal`/`quarantine`/`ack` all contend for, so this is a faithful
 *  stand-in for "another process (the daemon) is in there right now". */
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

// ---------------------------------------------------------------------------
// ack() takes the lock: contention defers, never corrupts.
// ---------------------------------------------------------------------------

describe('ack() vs. a concurrently-held drain.lock', () => {
  test('a held lock defers ack — returns 0, the record stays queued, counted (never corrupted)', () => {
    const root = mkProject();
    const ob = mkOutbox(root);
    appendJournal(root, evt('tool.called', 'run-a'));
    ob.drainJournal();
    const before = ob.readAll();
    expect(before.length).toBe(1);

    const held = holdLock(root);
    try {
      const removed = ob.ack(before);
      expect(removed).toBe(0);
    } finally {
      held.release();
    }

    // Untouched — still queued, not corrupted, not duplicated.
    expect(ob.readAll()).toEqual(before);
    expect(ob.counters().dropped_lock_contention).toBeGreaterThan(0);
  });

  test('once the lock is free, ack succeeds normally', () => {
    const root = mkProject();
    const ob = mkOutbox(root);
    appendJournal(root, evt('tool.called', 'run-a'));
    ob.drainJournal();
    const recs = ob.readAll();

    expect(ob.ack(recs)).toBe(1);
    expect(ob.readAll()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression: quarantine() calling ack() internally would deadlock against
// its OWN already-held lock (a wx-exclusive-create is not reentrant). Fixed
// by ackLocked(). Timed so a reintroduced deadlock fails fast rather than
// hanging the suite for ENQUEUE_LOCK_WAIT_MS (2s).
// ---------------------------------------------------------------------------

describe('quarantine() does not deadlock against its own lock', () => {
  test('quarantine completes promptly (would time out if ack() re-acquired the lock)', () => {
    const root = mkProject();
    const ob = mkOutbox(root);
    appendJournal(root, evt('tool.called', 'run-a'));
    ob.drainJournal();
    const recs = ob.readAll();
    expect(recs.length).toBe(1);

    const started = Date.now();
    const removed = ob.quarantine(recs);
    const elapsed = Date.now() - started;

    expect(removed).toBe(1);
    expect(elapsed).toBeLessThan(500); // the reentrant-lock bug cost >=2000ms
    expect(ob.readAll()).toEqual([]);
    expect(ob.readQuarantine().length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A realistic sequential handoff between TWO independent TelemetryOutbox
// instances against the SAME project — exactly what "drive's own instance"
// (tails at step boundaries) and "the daemon's own instance" (rebuilt every
// poll cycle, see pollProjectOnce) look like on disk. No record is lost,
// duplicated, or mis-sequenced across the handoff.
// ---------------------------------------------------------------------------

describe('drive-tail instance <-> daemon-flush instance: sequential interleaving', () => {
  test('drain (drive) -> take+ack (daemon) -> more journal -> drain (drive) again: seq stays correct, nothing lost or duplicated', () => {
    const root = mkProject();
    const drive = mkOutbox(root); // drive's own in-process instance
    appendJournal(root, evt('iteration.started', 'run-x'));
    drive.drainJournal();
    expect(drive.readAll().map((r) => r.seq)).toEqual([1]);

    // The daemon rebuilds a FRESH TelemetryOutbox every poll cycle
    // (pollProjectOnce's own doc comment) — a second instance, same files.
    const daemon = mkOutbox(root);
    const { sendable } = daemon.takeBatch();
    expect(sendable.map((r) => r.seq)).toEqual([1]);
    expect(daemon.ack(sendable)).toBe(1);
    expect(daemon.readAll()).toEqual([]);

    // The run continues; drive tails again at the next step boundary.
    appendJournal(root, evt('iteration.completed', 'run-x'));
    drive.drainJournal();
    const after = drive.readAll();
    // seq continues from 2 — NOT re-issued as 1 (which would collide with the
    // already-acked (run_id=1, seq=1) on the wire's dedup key).
    expect(after.map((r) => r.seq)).toEqual([2]);
    expect(after[0].run_id).toBe('run-x');
    expect(after[0].org).toBe('acme');
  });

  test('daemon holding the lock mid-flush does not lose a concurrent drive drain — it is deferred, then succeeds on the next tail', () => {
    const root = mkProject();
    const drive = mkOutbox(root);
    appendJournal(root, evt('tool.called', 'run-y'));

    // Simulate the daemon being mid-critical-section (e.g. inside its own
    // ack()) exactly when drive's next step boundary fires.
    const held = holdLock(root);
    let result;
    try {
      result = drive.drainJournal();
    } finally {
      held.release();
    }
    expect(result.skipped_locked).toBe(true);
    expect(drive.readAll()).toEqual([]); // nothing enqueued yet — correctly deferred

    // The NEXT tail (next step boundary, or run-exit) picks it up — nothing
    // was lost, the journal cursor never advanced past the unread bytes.
    const retried = drive.drainJournal();
    expect(retried.enqueued).toBe(1);
    expect(drive.readAll().length).toBe(1);
  });
});
