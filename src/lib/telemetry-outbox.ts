// telemetry-outbox.ts — the durable, org-tagged telemetry queue (ux-v2 `b9`).
//
// WHAT THIS IS. One project writes ONE journal (`.pipeline/.runtime/
// events.jsonl`, see `event.ts:appendEventLine`), into which every concurrent
// run interleaves its events. This module is the seam between that journal and
// anything that ships telemetry off the machine: it tails the journal from a
// rotation-safe cursor, runs the privacy allowlist, demultiplexes the
// interleaved `run_id`s into per-run monotonic `seq` counters, tags every
// record with the org it was queued under, and appends the result to a bounded
// on-disk queue. Uploading is NOT here — `telemetry-upload.ts` (`b10`) reads
// this queue; the daemon that calls both is `b11`.
//
// The record shape is fixed by the design (`04-subsystem-rules.md` §4):
//
//     { org, run_id, seq, kind, payload }
//
// ── The four properties this file exists to guarantee ───────────────────────
//
// 1. THE PAYLOAD IS FILTERED BEFORE IT TOUCHES DISK. The filter runs inside
//    `enqueue`, not at flush time, because the queue FILE is itself a
//    disclosure surface: it sits inside the user's repository, survives
//    reboots, and is read by a detached daemon. "Filter at upload" would leave
//    prompts, absolute paths and error excerpts sitting in `.pipeline/` for as
//    long as the machine is offline. Filtering is therefore a precondition of
//    persistence, and `tests/telemetry-outbox.test.ts` proves it the only way
//    that means anything — by planting secrets, draining the real queue, and
//    scanning the queue file's BYTES off disk.
//
//    The filter used is the VENDORED copy (`src/lib/vendor/privacy.ts`),
//    byte-identical to `pipeline-runner/src/shipper/privacy.ts` and guarded in
//    the parent monorepo's CI by `scripts/check-privacy-filter-drift.mjs`
//    (wired by `a1`). Not the published `@baizor/pipeline-protocol`: this
//    package is invoked straight out of the plugin's cached git checkout,
//    which has no `package.json` and no install step, so any external import
//    reachable from `cli.ts` throws at import time for every plugin user (see
//    the vendored file's own header). The tier resolution is FAIL-CLOSED — an
//    unrecognized `PIPELINE_PRIVACY_TIER` degrades to `metadata`, never up.
//
// 2. THE CURSOR BINDS (FILE IDENTITY, OFFSET) — AND THE IDENTITY IS CONTENT,
//    NOT AN INODE. The journal rotates at 50 MB (`event.ts:364`
//    `ROTATE_BYTES`): the live file is RENAMED aside and a fresh
//    `events.jsonl` takes its place. A bare byte offset carried across that
//    rename silently skips (new file shorter than the offset) or garbles (new
//    file already longer). Re-reading is just as bad: the same logical event
//    would be handed a DIFFERENT `seq`, and `(run_id, seq)` is the dedup key
//    the whole ingest path rests on.
//
//    The identity is `sha256` of the journal's FIRST COMPLETE LINE (newline
//    included). Rationale, and why not the two obvious alternatives:
//
//      - `Stats.ino` is not usable as the decider. On Windows it is frequently
//        `0` or unstable across handles, and this project is developed on
//        Windows and CI-tested on Windows + Linux. An identity that is
//        constant-`0` on one platform mis-detects rotation there — and the
//        expensive direction is the FALSE mismatch, which re-reads a journal
//        we already shipped and re-sequences it.
//      - `birthtimeMs` is unreliable in the other direction: on Linux libuv
//        can only populate it via `statx` (kernel 4.11+ / supporting fs) and
//        otherwise leaves it zeroed or ctime-derived, so it can compare equal
//        across a genuine rotation.
//      - The first line is a GENERATION STAMP the writer already produces for
//        free. The journal is append-only, so once written the first line
//        never changes; rotation starts a new file whose first line is a
//        different event (its own `ts` at millisecond precision, plus
//        `run_id`/`session_id`/`type`). It is computed identically on every
//        platform and needs no change to the writer.
//
//    `ino` and `birthtimeMs` ARE recorded on the cursor — as diagnostics only.
//    They are never allowed to declare a mismatch, precisely because each is
//    unreliable on one of the two platforms this ships to.
//
//    Two corroborating checks close the residual gap where a rotated file
//    could somehow reproduce the first line byte-for-byte:
//      - `size < offset` ⇒ mismatch (an append-only file never shrinks);
//      - the byte at `offset - 1` MUST be `\n` (the cursor only ever advances
//        past a newline), which detects a differently-shaped file at the same
//        offset for one byte of I/O.
//
// 3. TORN TRAILING LINES ARE RETRIED, NEVER SKIPPED AND NEVER PARSED. Writer
//    and reader are separate processes; the reader routinely observes a final
//    line mid-append. The cursor advances only to just past the LAST newline
//    in the chunk, so an unterminated tail stays unread and is picked up whole
//    on the next drain. A line that IS newline-terminated but unparseable is a
//    different thing — genuinely malformed, not torn — and is counted and
//    stepped over, because retrying it forever would wedge the queue.
//
// 4. EVERY RECORD IS ORG-TAGGED AT ENQUEUE. This is the F4 control: a user who
//    queues telemetry offline under org A and then reconnects under org B must
//    not have A's telemetry land in B's dashboard, a leak no deletion window
//    repairs. `takeBatch()` partitions the queue against the outbox's own org
//    so the caller cannot flush across the boundary by accident; `b10` applies
//    the refusal at the wire.
//
// The queue is BOUNDED. At the bound the OLDEST records are dropped (a lost
// tail is recoverable; a run that cannot start is not), and every drop is
// counted durably in `state.json` and reported through `onDrop`. Silent loss
// is unacceptable — `pipeline stats telemetry` (`b13`) reads these counters.
//
// 5. A PERMANENTLY-REJECTED RECORD IS SET ASIDE, NOT DELETED (`b10`). The
//    uploader's 4xx rule is "quarantine — never hot-loop on a permanently
//    malformed record". Quarantining lives HERE rather than in the uploader
//    because the queue files and their accounting are this module's: a record
//    is appended to `quarantine.jsonl` FIRST and only then removed from
//    `outbox.jsonl`, so a crash mid-move duplicates (harmless — the wire is
//    idempotent on `(run_id, seq)` and quarantine is never re-sent) and never
//    loses. The count lands in the SAME `state.json` counters and is reported
//    through the SAME `onDrop` sink as every other loss, so there is one place
//    to look rather than two.
//
// 6. AN EXPECTED, DOCUMENTED EXCLUSION IS NOT A DROP (`b20`). `session.opened`
//    has no `run_id` BY DESIGN (point 2 above), not by malfunction, so a
//    "dropped … (no_run_id)" line on every healthy connected run told the
//    reader a correct run had lost data. `appendFiltered` now tells the two
//    apart via `isExpectedRunlessType`: a run_id-less record of a documented
//    type goes through `noteExclusion`/`excluded_not_applicable` and is
//    reported (if at all) as "excluded … not_applicable"; anything else
//    run_id-less is still genuine, unexpected loss on the ORIGINAL
//    `noteDrop`/`dropped_no_run_id` path, still counted, still visible. The
//    count is never silent either way — only the WORD and the LEDGER split.
//
// Everything lives under `ensureGeneratedDir`, so the tree carries its own
// `.gitignore` and a `git add -A` after a run cannot sweep the queue into a
// commit.

import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ensureGeneratedDir } from './generated-dir';
import {
  filterEventForTier,
  filterStatsRecordMetadata,
  resolvePrivacyTier,
  stripStatsFailureExcerpts,
  type PrivacyTier,
} from './vendor/privacy';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `state.json` schema. Bumped when the cursor or counter shape changes in a
 *  way that makes an OLD state file misread; an unrecognized version is
 *  treated as "no state" (start fresh), never guessed at — a mis-parsed cursor
 *  is exactly the stale-offset failure this file exists to prevent.
 *
 *  ADDITIVE counters do NOT bump it, and `b10`'s `quarantined` /
 *  `quarantine_depth` deliberately did not. `loadState` copies only keys the
 *  in-memory shape already has (`if (k in c)`), so an old file missing them
 *  reads as `0` and a new file is ignored field-by-field by an older binary —
 *  both directions are safe. Bumping would have been actively harmful: every
 *  existing state file would be discarded, the cursor with it, and the whole
 *  journal re-read and RE-SEQUENCED. */
export const OUTBOX_STATE_SCHEMA = 1;

/** Master telemetry opt-out (`03` F1). Same falsy parse as
 *  `PIPELINE_UI_ENABLED` in `event.ts`. */
export const TELEMETRY_ENV = 'PIPELINE_SYNC_LOCAL_STATS';

/** Default queue bound, in records. */
export const DEFAULT_MAX_RECORDS = 10_000;

/** Default cap on per-run `seq` counters retained. Runs are finite but a
 *  project accumulates them forever, so the map is an LRU. */
export const DEFAULT_MAX_TRACKED_RUNS = 512;

/** Drops are taken in batches rather than one-per-append so that the O(n)
 *  queue rewrite is amortized instead of running on every enqueue once full. */
const DROP_BATCH_FRACTION = 0.1;

/** How far into the journal we look for the first newline when computing the
 *  file-identity anchor. */
const ANCHOR_WINDOW_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

const OUTBOX_FILE = 'outbox.jsonl';
const STATE_FILE = 'state.json';
const LOCK_FILE = 'drain.lock';
/** Records the server permanently rejected (`b10`'s 4xx rule). Set aside for
 *  inspection by `pipeline stats telemetry`; never re-sent, never deleted by
 *  this module except at the bound. */
const QUARANTINE_FILE = 'quarantine.jsonl';

/** A drain that cannot take the lock is free to skip — the next poll picks the
 *  work up. An enqueue that cannot take it would LOSE a record, so it waits. */
const ENQUEUE_LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 15;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OutboxKind = 'event' | 'stats';

/** The on-disk record (`04` §4). `payload` is ALREADY filtered. */
export interface OutboxRecord {
  /** The org this was queued under — REQUIRED, and the F4 control. */
  org: string;
  run_id: string;
  /** Per-run monotonic, starting at 1. Half of the `(run_id, seq)` dedup key. */
  seq: number;
  kind: OutboxKind;
  payload: Record<string, unknown>;
}

/** (file identity, offset) — see this module's header for why the identity is
 *  content-derived rather than an inode. */
export interface JournalCursor {
  /** `sha256` of the journal's first complete line, newline included. */
  anchor: string;
  /** Byte offset of the first UNREAD byte. Always immediately after a `\n`. */
  offset: number;
  /** Diagnostics only — never permitted to declare a rotation. */
  ino: number | null;
  /** Diagnostics only — never permitted to declare a rotation. */
  birthtime_ms: number | null;
}

export interface OutboxCounters {
  /** Records that reached disk. */
  enqueued: number;
  /** Current queue depth. */
  queued: number;
  /** Dropped because the queue was at its bound (oldest-first). */
  dropped_bound: number;
  /** Journal lines with no usable `run_id` and NOT of a documented
   *  runless-by-design type — undedupable, so unshippable, AND genuinely
   *  unexpected. Narrower as of `b20`: a documented exclusion such as
   *  `session.opened` no longer lands here — see `excluded_not_applicable`
   *  — so this counter now means only real loss, not routine noise. */
  dropped_no_run_id: number;
  /** Newline-terminated lines that were not parseable JSON objects. */
  dropped_malformed: number;
  /** Enqueues abandoned because the drain lock could not be taken in time. */
  dropped_lock_contention: number;
  /** Drains that saw an unterminated tail and left it for the next poll. */
  torn_line_retries: number;
  /** Cursor identity mismatches — i.e. observed journal rotations. */
  rotations_detected: number;
  /** Per-run `seq` counters evicted by the LRU bound. */
  run_counters_evicted: number;
  /** Records moved to `quarantine.jsonl` after a permanent server rejection
   *  (`b10`, 4xx). NOT a loss — the records are still on disk — but counted
   *  here so one command reports every record that left the send path. */
  quarantined: number;
  /** Current depth of `quarantine.jsonl`. */
  quarantine_depth: number;
  last_drop_at: string | null;
  last_drop_reason: string | null;
  /** Records with no `run_id` whose event `type` is documented to
   *  legitimately lack one — `session.opened`, today, written when a Claude
   *  Code SESSION opens, often before any run exists to carry an id. NOT a
   *  loss and NOT folded into `dropped_no_run_id` / `totalDropped()`: the
   *  record was never shippable in the first place, by design (ux-v2
   *  `b20` — an expected, documented exclusion must not read as data
   *  loss). See `noteExclusion`. */
  excluded_not_applicable: number;
  /** Mirrors `last_drop_at` for the exclusion ledger — kept separate so a
   *  genuine drop's timestamp is never overwritten by a routine exclusion. */
  last_exclusion_at: string | null;
  last_exclusion_reason: string | null;
}

export interface DropInfo {
  reason: 'bound' | 'no_run_id' | 'malformed' | 'lock_contention' | 'quarantine';
  count: number;
  /** Human-readable, and deliberately CONTENT-FREE: never the payload. */
  detail: string;
}

/**
 * An EXPECTED exclusion — a record with no `run_id` whose event `type` is
 * documented to legitimately lack one (`session.opened`, today). Deliberately
 * NOT a `DropInfo`: nothing was lost, so it is never reported in "dropped"
 * vocabulary (ux-v2 `b20`). See `TelemetryOutbox`'s private `noteExclusion`.
 */
export interface ExclusionInfo {
  reason: 'not_applicable';
  count: number;
  /** Human-readable, and deliberately CONTENT-FREE: never the payload. */
  detail: string;
}

export interface DrainResult {
  /** Complete journal lines consumed this cycle. */
  lines_read: number;
  enqueued: number;
  /** Genuinely unexpected — not of a documented runless-by-design type. */
  skipped_no_run_id: number;
  /** Expected exclusions (`session.opened`, today) — not a loss, not part of
   *  `skipped_no_run_id` as of `b20`. */
  skipped_excluded: number;
  skipped_malformed: number;
  /** An unterminated final line was observed and left for the next drain. */
  torn_tail: boolean;
  /** The cursor's identity did not match — the journal rotated, so reading
   *  restarted from byte 0 of the new file rather than a stale offset. */
  restarted: boolean;
  bytes_consumed: number;
  /** Another process held the drain lock; nothing was read. */
  skipped_locked: boolean;
}

export interface TelemetryOutboxOptions {
  /** The project whose journal is tailed and whose `.pipeline/.runtime` holds
   *  the queue. */
  projectRoot: string;
  /** The org slug records are tagged with. Required, and non-empty: a record
   *  with no org cannot be flushed safely, so there is no such record. */
  org: string;
  /** Explicit privacy tier; falls back to `PIPELINE_PRIVACY_TIER`, then
   *  fail-closed to `metadata`. */
  tier?: string;
  /**
   * The salt hardening the deterministic path fingerprints (`b15`) that this
   * outbox's `filterEventForTier`/`filterStatsRecordMetadata` calls key their
   * HMACs with — REQUIRED, not optional (`b18`, 07-security.md T16/SG13).
   *
   * There is deliberately no default. `b15` shipped the per-install CSPRNG
   * salt but wired it only into `run-identity.ts`'s project fingerprint,
   * whose sole consumer is `commands/hash.ts` — nothing uploads it. Every
   * `TelemetryOutbox` construction site (the ones that actually filter and
   * ship telemetry) kept relying on this option's old `?? ''` default, so
   * every uploaded path fingerprint was an HMAC under an EMPTY key — weaker
   * than the public constant `b15` retired, since an attacker need not even
   * look the constant up. Making this field required, with the constructor
   * guard below refusing an empty value, is the fix: a default that cannot
   * fail is what created the defect, so there is no default left to fall
   * back to silently.
   *
   * Callers resolve this via `fingerprint-salt.ts#resolveOutboxFingerprintSalt`
   * — env override, else the per-install secret, else the documented public
   * `DEFAULT_FINGERPRINT_SALT` fallback (never a throw, per `b15`'s own
   * fallback contract: an install predating the salt, or one that could not
   * persist it, must not error).
   */
  fingerprintSalt: string;
  maxRecords?: number;
  maxTrackedRuns?: number;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Where drops are reported. Called at most ONCE PER REASON PER CYCLE with
   *  the aggregated count, never once per record; defaults to one stderr line.
   *  Counting is independent of this sink and is always durable. */
  onDrop?: (info: DropInfo) => void;
  /** Where EXPECTED exclusions are reported (e.g. `session.opened`'s null
   *  `run_id`) — a SEPARATE sink from `onDrop`, so an operator can never
   *  mistake routine, by-design exclusion for data loss (ux-v2 `b20`). Same
   *  cadence as `onDrop`: at most once per reason per cycle; defaults to one
   *  stderr line phrased as "excluded … not_applicable", never "dropped".
   *  Counting is independent of this sink and is always durable. */
  onExclude?: (info: ExclusionInfo) => void;
}

// ---------------------------------------------------------------------------
// Paths + the opt-out gate
// ---------------------------------------------------------------------------

/** `<project>/.pipeline/.runtime` — the generated tree the journal already
 *  lives in (`event.ts:ensureRuntimeDir`). */
export function runtimeDir(projectRoot: string): string {
  return join(projectRoot, '.pipeline', '.runtime');
}

/** The shared per-project journal this module tails.
 *
 *  DUPLICATED, not imported, from `event.ts:appendEventLine` — that function
 *  builds the path inline and exports no constant, and this package's house
 *  style is to copy rather than widen an unrelated module's API (see
 *  `event.ts`'s own "duplicated here, not imported" note). The duplication is
 *  not left to review discipline: `tests/telemetry-outbox.test.ts` drives the
 *  REAL writer (`emitEvent`) and asserts the outbox drains what it wrote, so a
 *  divergence fails the suite rather than silently tailing nothing. */
export function journalPath(projectRoot: string): string {
  return join(runtimeDir(projectRoot), 'events.jsonl');
}

/** `<project>/.pipeline/.runtime/telemetry` — queue, state and drain lock. */
export function telemetryDir(projectRoot: string): string {
  return join(runtimeDir(projectRoot), 'telemetry');
}

/**
 * Master telemetry opt-out (`03` F1: "`PIPELINE_SYNC_LOCAL_STATS=0` disables
 * telemetry outright"). Default ON; only an explicit falsy value disables,
 * matching `pipelineUiEnabled`'s parse in `event.ts`.
 *
 * Enforced at ENQUEUE, which is the strongest place: opted out means nothing
 * is queued at all, not that something queued is later declined.
 */
export function telemetrySyncEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = (env[TELEMETRY_ENV] ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface OutboxState {
  schema: number;
  cursor: JournalCursor | null;
  /** run_id → the NEXT `seq` to hand out. */
  seq: Record<string, number>;
  /** LRU order over the keys of `seq`, oldest first. */
  seq_order: string[];
  counters: OutboxCounters;
}

function emptyCounters(): OutboxCounters {
  return {
    enqueued: 0,
    queued: 0,
    dropped_bound: 0,
    dropped_no_run_id: 0,
    dropped_malformed: 0,
    dropped_lock_contention: 0,
    torn_line_retries: 0,
    rotations_detected: 0,
    run_counters_evicted: 0,
    quarantined: 0,
    quarantine_depth: 0,
    last_drop_at: null,
    last_drop_reason: null,
    excluded_not_applicable: 0,
    last_exclusion_at: null,
    last_exclusion_reason: null,
  };
}

function emptyState(): OutboxState {
  return { schema: OUTBOX_STATE_SCHEMA, cursor: null, seq: {}, seq_order: [], counters: emptyCounters() };
}

// ---------------------------------------------------------------------------
// Low-level fs helpers
// ---------------------------------------------------------------------------

function safeStat(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Read `[start, end)` from `path`. Returns fewer bytes if the file shrank
 *  under us (a rotation racing this read) — callers treat a short read as data
 *  they simply do not have yet. */
function readRange(path: string, start: number, end: number): Buffer {
  const len = Math.max(0, end - start);
  if (len === 0) return Buffer.alloc(0);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * The journal's file identity: `sha256` of its first COMPLETE line.
 *
 * Returns `null` when no complete first line exists yet (empty file, or a
 * first line still mid-append). That is deliberately not an error and not an
 * excuse to bind a provisional identity — with no anchor there is nothing to
 * compare a future drain against, so the drain simply waits.
 *
 * When the window fills with no newline at all, the whole window lies INSIDE
 * the unterminated first line, and an append-only file can never rewrite it —
 * so hashing the window is stable and the anchor is well defined.
 */
function journalAnchor(path: string, size: number): string | null {
  if (size <= 0) return null;
  const window = Math.min(size, ANCHOR_WINDOW_BYTES);
  const buf = readRange(path, 0, window);
  if (buf.length === 0) return null;
  const nl = buf.indexOf(NEWLINE);
  if (nl >= 0) return sha256(buf.subarray(0, nl + 1));
  if (buf.length >= ANCHOR_WINDOW_BYTES) return sha256(buf);
  return null;
}

/** The cursor only ever lands immediately after a `\n`, so the byte before it
 *  must be one. One byte of I/O that catches a file which reproduced the
 *  anchor but not the layout. */
function offsetFollowsNewline(path: string, offset: number): boolean {
  if (offset <= 0) return true;
  const b = readRange(path, offset - 1, offset);
  return b.length === 1 && b[0] === NEWLINE;
}

/** Replace `path`'s contents atomically (temp file + rename). `renameSync`
 *  replaces an existing destination on both NTFS and POSIX. */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, data, 'utf-8');
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

function countLines(path: string): number {
  try {
    const buf = readFileSync(path);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === NEWLINE) n++;
    return n;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// The drain lock
// ---------------------------------------------------------------------------

/**
 * A SYNCHRONOUS exclusive-create lock, same primitive and same stale-recovery
 * argument as `credential-lock.ts` (read that file's header — `open(O_CREAT |
 * O_EXCL)` is the one operation atomic on both NTFS and POSIX). Synchronous
 * because the whole drain path is synchronous: it runs inside a hook-adjacent
 * process where an `await` would mean restructuring every caller.
 *
 * What it protects is `seq` allocation. Two processes assigning `seq` from the
 * same counter concurrently would hand two DIFFERENT events the same
 * `(run_id, seq)`, which the ingest path dedups — silently discarding one.
 */
interface SyncLock {
  release(): void;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* fallback busy-wait: only reached where SharedArrayBuffer is unavailable */
    }
  }
}

function tryLockSync(lockPath: string, now: () => number, waitMs: number): SyncLock | null {
  const deadline = now() + waitMs;
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    if (fd !== null) {
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: now() }));
      } catch {
        /* diagnostic payload only — never load-bearing for exclusion */
      } finally {
        closeSync(fd);
      }
      return {
        release: () => {
          try {
            unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
        },
      };
    }
    // Held. Steal it if the holder is long gone, else wait a little.
    const st = safeStat(lockPath);
    if (st && now() - st.mtimeMs > LOCK_STALE_MS) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* lost the steal race — loop and try the create again */
      }
      continue;
    }
    if (now() >= deadline) return null;
    sleepSync(LOCK_POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------

export class TelemetryOutbox {
  /** The resolved, fail-closed privacy tier every payload is filtered at. */
  readonly tier: PrivacyTier;
  /** Non-null when the configured tier was unrecognized and degraded. */
  readonly tierWarning: string | null;
  readonly dir: string;
  readonly org: string;
  readonly projectRoot: string;

  /** The deterministic path-fingerprint salt this outbox filtered with (`b15`,
   *  required as of `b18` — see `TelemetryOutboxOptions.fingerprintSalt`).
   *  PUBLIC so `b10`'s wire-side re-filter uses the SAME salt — a different one
   *  would re-fingerprint an already-fingerprinted path into a value nothing
   *  else correlates with. Exposing it as a TypeScript property is not
   *  publication: it never becomes part of a payload (see the constructor
   *  guard and `filterPayload` — the salt only ever KEYS an HMAC, it is never
   *  a value copied into one). Not a secret in the sense `07` T16 discusses
   *  the default constant being public; the RESOLVED per-install secret this
   *  field usually holds still must never be uploaded, and no code path here
   *  does. */
  readonly fingerprintSalt: string;

  private readonly outboxPath: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly quarantinePath: string;
  private readonly journal: string;
  private readonly maxRecords: number;
  private readonly maxTrackedRuns: number;
  private readonly salt: string;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly onDrop: (info: DropInfo) => void;
  private readonly onExclude: (info: ExclusionInfo) => void;

  /** Queue depth and the file size it was derived from. A size that no longer
   *  matches means another process appended, so the depth is re-derived. */
  private queued = 0;
  private observedSize = -1;
  /** Drops seen this cycle, reported once each by `flushDropReports`. */
  private readonly dropAccum = new Map<DropInfo['reason'], { count: number; detail: string }>();
  /** Expected exclusions seen this cycle, reported once each by
   *  `flushExclusionReports` — a SEPARATE ledger from `dropAccum` so an
   *  exclusion can never be aggregated (or worded) as a drop (ux-v2 `b20`). */
  private readonly exclusionAccum = new Map<ExclusionInfo['reason'], { count: number; detail: string }>();

  constructor(opts: TelemetryOutboxOptions) {
    const org = (opts.org ?? '').trim();
    if (!org) {
      // A record with no org cannot be flushed without risking F4, so it is
      // never created. Callers gate on `cloud.json` first (F7: no account ⇒
      // the subsystem is absent, not merely inert).
      throw new TypeError('TelemetryOutbox requires a non-empty org — an untagged record can never be flushed safely');
    }
    this.org = org;
    this.projectRoot = opts.projectRoot;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => Date.now());

    // b18 — THE EMPTY-SALT GUARD. `fingerprintSalt` is a required option (see
    // its doc comment), but Bun's test/CLI runtime strips TypeScript types
    // before execution, so "required" alone is not a runtime backstop — a
    // caller that reverts to omitting it (exactly what every one of the five
    // pre-b18 construction sites did) would otherwise hand this an
    // `undefined`, and the OLD `?? ''` default would silently key every
    // uploaded HMAC with an empty string. That silent fallback is the T16/
    // SG13 defect this task exists to close, so there is no fallback left
    // here: an unresolved salt on a path that constructs this class is a
    // caller bug, surfaced immediately and loudly, never a quiet `''`.
    const salt = opts.fingerprintSalt;
    if (!salt || !salt.trim()) {
      throw new TypeError(
        'TelemetryOutbox requires a non-empty fingerprintSalt — resolve one via ' +
          "fingerprint-salt.ts#resolveOutboxFingerprintSalt before constructing. A silent '' " +
          'key is exactly the T16/SG13 defect this guard exists to catch (07-security.md, ux-v2 b18).',
      );
    }
    this.salt = salt;
    this.fingerprintSalt = this.salt;
    this.maxRecords = Math.max(1, opts.maxRecords ?? DEFAULT_MAX_RECORDS);
    this.maxTrackedRuns = Math.max(1, opts.maxTrackedRuns ?? DEFAULT_MAX_TRACKED_RUNS);

    const resolved = resolvePrivacyTier(opts.tier, this.env);
    this.tier = resolved.tier;
    this.tierWarning = resolved.warning;

    this.dir = telemetryDir(opts.projectRoot);
    this.outboxPath = join(this.dir, OUTBOX_FILE);
    this.statePath = join(this.dir, STATE_FILE);
    this.lockPath = join(this.dir, LOCK_FILE);
    this.quarantinePath = join(this.dir, QUARANTINE_FILE);
    this.journal = journalPath(opts.projectRoot);

    // The stub goes at the `.runtime` ROOT, not on this subfolder — `*` there
    // already covers everything beneath (see `generated-dir.ts`).
    ensureGeneratedDir(this.dir, runtimeDir(opts.projectRoot));

    this.onDrop =
      opts.onDrop ??
      ((info) => {
        try {
          process.stderr.write(
            `[pipeline-telemetry] dropped ${info.count} record(s) (${info.reason}): ${info.detail}\n`,
          );
        } catch {
          /* never fail a run over a log line */
        }
      });

    // ux-v2 `b20`: a SEPARATE sink and vocabulary from `onDrop`. `session.opened`
    // fires on every connected run — printing it as "dropped" told a clean
    // run's reader the run had lost data when it had not.
    this.onExclude =
      opts.onExclude ??
      ((info) => {
        try {
          process.stderr.write(
            `[pipeline-telemetry] excluded ${info.count} record(s) (${info.reason}): ${info.detail}\n`,
          );
        } catch {
          /* never fail a run over a log line */
        }
      });
  }

  // ── state io ──────────────────────────────────────────────────────────────

  private loadState(): OutboxState {
    let raw: string;
    try {
      raw = readFileSync(this.statePath, 'utf-8');
    } catch {
      return emptyState();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return emptyState();
    }
    if (!isRecord(parsed) || parsed.schema !== OUTBOX_STATE_SCHEMA) return emptyState();
    const state = emptyState();
    const cursor = parsed.cursor;
    if (
      isRecord(cursor) &&
      typeof cursor.anchor === 'string' &&
      cursor.anchor.length > 0 &&
      typeof cursor.offset === 'number' &&
      Number.isFinite(cursor.offset) &&
      cursor.offset >= 0
    ) {
      state.cursor = {
        anchor: cursor.anchor,
        offset: cursor.offset,
        ino: typeof cursor.ino === 'number' ? cursor.ino : null,
        birthtime_ms: typeof cursor.birthtime_ms === 'number' ? cursor.birthtime_ms : null,
      };
    }
    if (isRecord(parsed.seq)) {
      for (const [k, v] of Object.entries(parsed.seq)) {
        if (typeof v === 'number' && Number.isInteger(v) && v >= 1) state.seq[k] = v;
      }
    }
    if (Array.isArray(parsed.seq_order)) {
      state.seq_order = parsed.seq_order.filter(
        (k): k is string => typeof k === 'string' && k in state.seq,
      );
    }
    // Any run present in `seq` but missing from the order list (hand-edited or
    // truncated state) still needs a slot, else it would never be evicted.
    for (const k of Object.keys(state.seq)) {
      if (!state.seq_order.includes(k)) state.seq_order.push(k);
    }
    if (isRecord(parsed.counters)) {
      const c = state.counters as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed.counters)) {
        if (k in c && typeof v === 'number' && Number.isFinite(v)) c[k] = v;
      }
      if (typeof parsed.counters.last_drop_at === 'string') {
        state.counters.last_drop_at = parsed.counters.last_drop_at;
      }
      if (typeof parsed.counters.last_drop_reason === 'string') {
        state.counters.last_drop_reason = parsed.counters.last_drop_reason;
      }
      if (typeof parsed.counters.last_exclusion_at === 'string') {
        state.counters.last_exclusion_at = parsed.counters.last_exclusion_at;
      }
      if (typeof parsed.counters.last_exclusion_reason === 'string') {
        state.counters.last_exclusion_reason = parsed.counters.last_exclusion_reason;
      }
    }
    return state;
  }

  private saveState(state: OutboxState): void {
    state.schema = OUTBOX_STATE_SCHEMA;
    // Re-derive rather than trust an in-memory depth: some paths (a torn first
    // line, a nothing-new drain) return before ever touching the queue, and a
    // persisted `queued: 0` on a queue that is not empty would misreport
    // `pipeline stats telemetry`. One `statSync` in the common case.
    this.syncQueueDepth();
    state.counters.queued = this.queued;
    try {
      writeFileAtomic(this.statePath, `${JSON.stringify(state)}\n`);
    } catch {
      // Losing the state write degrades to "start fresh next time", which the
      // cursor contract already handles. It must never fail a run (D2).
    }
  }

  // ── queue io ──────────────────────────────────────────────────────────────

  private syncQueueDepth(): void {
    const st = safeStat(this.outboxPath);
    const size = st ? st.size : 0;
    if (size !== this.observedSize) {
      this.queued = countLines(this.outboxPath);
      this.observedSize = size;
    }
  }

  /** Every record currently queued, oldest first. Unparseable lines (a torn
   *  write from a killed process) are skipped rather than trusted. */
  readAll(): OutboxRecord[] {
    return readRecordFile(this.outboxPath);
  }

  /** Every record the server permanently rejected, oldest first. Read-only:
   *  quarantine is an inspection surface (`b13`), never a send queue. */
  readQuarantine(): OutboxRecord[] {
    return readRecordFile(this.quarantinePath);
  }

  /**
   * The next batch to flush, PARTITIONED BY ORG.
   *
   * `blocked` is the F4 guard made structural: records queued under a
   * different org are handed back separately so an uploader physically cannot
   * put them on the wire for the current credential by iterating the queue.
   * They are not deleted — reconnecting to the original org releases them.
   */
  takeBatch(limit = 100): { sendable: OutboxRecord[]; blocked: OutboxRecord[] } {
    const sendable: OutboxRecord[] = [];
    const blocked: OutboxRecord[] = [];
    for (const rec of this.readAll()) {
      if (rec.org === this.org) {
        if (sendable.length < limit) sendable.push(rec);
      } else {
        blocked.push(rec);
      }
    }
    return { sendable, blocked };
  }

  /**
   * Remove records by `(kind, run_id, seq)`. Returns how many were removed.
   *
   * Takes the drain lock (ux-v2 `b12`) — `enqueue`/`drainJournal`/`quarantine`
   * already did; `ack` was the one read-modify-write of `outbox.jsonl` that
   * did not, which was harmless only as long as nothing but the single,
   * self-serialized daemon ever called it. `b12` makes that assumption false:
   * a long-lived `pipeline drive` process now ALSO drains this project's
   * journal in-process, concurrently with whatever daemon may be flushing the
   * SAME project. An unlocked `ack()` could then race a concurrent
   * `enqueue`'s append: read an N-record snapshot before the append, then
   * `rewrite()` — a full-file replace — after it, silently dropping the
   * just-appended record. Losing the lock race here costs nothing, same as
   * every other locked path in this module: the records stay queued, this
   * flush under-reports `records_sent` for them, and the next flush re-sends
   * — a harmless duplicate the server's `(run_id, seq)` dedup absorbs.
   *
   * `quarantine()` below calls `ackLocked` (not this method) for its own
   * removal step — it already holds this SAME lock, and `wx`-exclusive-create
   * locks are not reentrant; a second acquisition attempt from within the
   * first would simply wait out `ENQUEUE_LOCK_WAIT_MS` and lose the race
   * against itself every time.
   */
  ack(records: OutboxRecord[]): number {
    if (records.length === 0) return 0;
    const lock = tryLockSync(this.lockPath, this.now, ENQUEUE_LOCK_WAIT_MS);
    if (!lock) {
      const state = this.loadState();
      state.counters.dropped_lock_contention += 1;
      this.noteDrop(state, {
        reason: 'lock_contention',
        count: 1,
        detail: `ack of ${records.length} record(s) deferred — the drain lock was held`,
      });
      this.saveState(state);
      this.flushDropReports();
      return 0;
    }
    try {
      return this.ackLocked(records);
    } finally {
      lock.release();
      this.flushDropReports();
    }
  }

  /** The read-filter-rewrite core of `ack()`, WITHOUT taking the lock —
   *  callable only by a caller that already holds `this.lockPath` (currently
   *  just `quarantine()`, whose write-then-remove sequence must be one
   *  atomic critical section, not two separately-locked halves). */
  private ackLocked(records: OutboxRecord[]): number {
    const keys = new Set(records.map(recordKey));
    const all = this.readAll();
    const kept = all.filter((r) => !keys.has(recordKey(r)));
    if (kept.length === all.length) return 0;
    this.rewrite(kept);
    return all.length - kept.length;
  }

  private rewrite(records: OutboxRecord[]): void {
    const body = records.map((r) => JSON.stringify(r)).join('\n');
    writeFileAtomic(this.outboxPath, records.length ? `${body}\n` : '');
    this.queued = records.length;
    const st = safeStat(this.outboxPath);
    this.observedSize = st ? st.size : 0;
  }

  /**
   * Move `records` out of the send queue and into `quarantine.jsonl` — `b10`'s
   * 4xx outcome. Returns how many were moved.
   *
   * WRITE-BEFORE-REMOVE, deliberately. The quarantine append is durable before
   * `ack` deletes anything, so the only crash window duplicates a record
   * (present in both files) instead of losing it. A duplicate costs nothing:
   * quarantine is never re-sent, and the wire is idempotent on `(run_id, seq)`
   * anyway. The reverse order would trade a guaranteed-safe duplicate for a
   * silent permanent loss, which `04` §4 forbids.
   *
   * Takes the drain lock so this read-modify-write of `outbox.jsonl` cannot
   * interleave with a concurrent `enqueue` and lose that process's append.
   * Failing to take it moves NOTHING and is counted — the records stay queued
   * and the next flush retries, which cannot hot-loop because the uploader's
   * own retry schedule is persistent.
   */
  quarantine(records: OutboxRecord[]): number {
    if (records.length === 0) return 0;
    const lock = tryLockSync(this.lockPath, this.now, ENQUEUE_LOCK_WAIT_MS);
    if (!lock) {
      const state = this.loadState();
      state.counters.dropped_lock_contention += 1;
      this.noteDrop(state, {
        reason: 'lock_contention',
        count: 1,
        detail: `quarantine of ${records.length} record(s) deferred — the drain lock was held`,
      });
      this.saveState(state);
      this.flushDropReports();
      return 0;
    }
    try {
      const state = this.loadState();
      // Only records actually still queued are moved — quarantining something
      // already gone would inflate the counter and write a phantom line.
      const queuedKeys = new Set(this.readAll().map(recordKey));
      const moving = records.filter((r) => queuedKeys.has(recordKey(r)));
      if (moving.length === 0) return 0;
      try {
        appendFileSync(this.quarantinePath, moving.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf-8');
      } catch {
        // The set-aside file could not be written (read-only checkout, disk
        // full). Removing the records now would lose them, so nothing moves.
        return 0;
      }
      const removed = this.ackLocked(moving);
      state.counters.quarantined += removed;
      this.noteDrop(state, {
        reason: 'quarantine',
        count: removed,
        detail: `${removed} record(s) permanently rejected by the server — set aside in ${QUARANTINE_FILE}, not deleted`,
      });
      this.enforceQuarantineBound(state);
      this.saveState(state);
      return removed;
    } catch {
      // D2: never throw into the run.
      return 0;
    } finally {
      lock.release();
      this.flushDropReports();
    }
  }

  /** The quarantine file is bounded by the same record bound as the queue, so
   *  a server rejecting everything cannot grow a file without limit. Oldest
   *  first, counted under `bound` like every other capacity drop. */
  private enforceQuarantineBound(state: OutboxState): void {
    const all = readRecordFile(this.quarantinePath);
    state.counters.quarantine_depth = all.length;
    if (all.length <= this.maxRecords) return;
    const dropCount = all.length - this.maxRecords;
    const kept = all.slice(dropCount);
    try {
      writeFileAtomic(this.quarantinePath, kept.length ? `${kept.map((r) => JSON.stringify(r)).join('\n')}\n` : '');
    } catch {
      return;
    }
    state.counters.quarantine_depth = kept.length;
    state.counters.dropped_bound += dropCount;
    this.noteDrop(state, {
      reason: 'bound',
      count: dropCount,
      detail: `${QUARANTINE_FILE} bound ${this.maxRecords} reached — dropped the ${dropCount} oldest quarantined record(s)`,
    });
  }

  // ── enqueue ───────────────────────────────────────────────────────────────

  /**
   * Filter one journal event, tag it, hand it a per-run `seq`, and append it.
   *
   * Returns the record, or `null` when telemetry is disabled, the event has no
   * usable `run_id`, or the lock could not be taken — every `null` path that
   * loses data is COUNTED.
   */
  enqueueEvent(event: Record<string, unknown>): OutboxRecord | null {
    return this.enqueue('event', event);
  }

  /** Same, for a finalized `.stats` run record (`runs.jsonl`). */
  enqueueStats(record: Record<string, unknown>): OutboxRecord | null {
    return this.enqueue('stats', record);
  }

  private enqueue(kind: OutboxKind, payload: Record<string, unknown>): OutboxRecord | null {
    if (!telemetrySyncEnabled(this.env)) return null;
    const lock = tryLockSync(this.lockPath, this.now, ENQUEUE_LOCK_WAIT_MS);
    if (!lock) {
      const state = this.loadState();
      state.counters.dropped_lock_contention += 1;
      this.noteDrop(state, { reason: 'lock_contention', count: 1, detail: `kind=${kind}` });
      this.saveState(state);
      this.flushDropReports();
      return null;
    }
    try {
      const state = this.loadState();
      this.syncQueueDepth();
      const rec = this.appendFiltered(state, kind, payload);
      this.saveState(state);
      return rec;
    } finally {
      lock.release();
      this.flushDropReports();
      this.flushExclusionReports();
    }
  }

  /** The single place a record is filtered, sequenced and written. Both the
   *  public `enqueue*` methods and `drainJournal` funnel through here, so the
   *  "filtered before it touches disk" property has exactly ONE code path. */
  private appendFiltered(
    state: OutboxState,
    kind: OutboxKind,
    payload: Record<string, unknown>,
  ): OutboxRecord | null {
    const runId = readRunId(payload);
    if (!runId) {
      // ux-v2 `b20`: an EXPECTED exclusion (`session.opened`, today) is not
      // loss — see `isExpectedRunlessType` and `noteExclusion` — so it gets
      // its own counter and its own vocabulary, never "dropped".
      if (isExpectedRunlessType(payload)) {
        state.counters.excluded_not_applicable += 1;
        this.noteExclusion(state, {
          reason: 'not_applicable',
          count: 1,
          detail: `kind=${kind} type=${typeof payload.type === 'string' ? payload.type : 'unknown'} — no run_id exists yet when this event is written, by design`,
        });
        return null;
      }
      state.counters.dropped_no_run_id += 1;
      this.noteDrop(state, {
        reason: 'no_run_id',
        count: 1,
        detail: `kind=${kind} — a record with no run_id cannot be dedup-keyed`,
      });
      return null;
    }
    const filtered = this.filterPayload(kind, payload);
    const seq = this.nextSeq(state, runId);
    const record: OutboxRecord = { org: this.org, run_id: runId, seq, kind, payload: filtered };
    const line = `${JSON.stringify(record)}\n`;
    try {
      appendFileSync(this.outboxPath, line, 'utf-8');
    } catch {
      // The append failed (read-only checkout, disk full). The seq is already
      // consumed — a GAP in the sequence, which is safe: `(run_id, seq)` is a
      // dedup key, never a completeness proof. Re-using it would not be.
      return null;
    }
    this.queued += 1;
    this.observedSize = this.observedSize < 0 ? -1 : this.observedSize + Buffer.byteLength(line);
    state.counters.enqueued += 1;
    this.enforceBound(state);
    return record;
  }

  /**
   * THE trust boundary. Runs before the record is serialized, so no
   * unfiltered byte ever reaches the queue file.
   *
   * - `event`: the whole envelope + per-type `data` allowlist
   *   (`filterEventForTier`). Unknown type ⇒ `data: {}`; unknown field within a
   *   known type ⇒ dropped; absolute paths ⇒ fingerprints.
   * - `stats`: `RunFailureDetail.error` excerpts are stripped at EVERY tier
   *   (design D16 / G-sec-2), then the nested metadata allowlist applies at
   *   the metadata tier.
   */
  private filterPayload(kind: OutboxKind, payload: Record<string, unknown>): Record<string, unknown> {
    if (kind === 'stats') {
      const stripped = stripStatsFailureExcerpts(payload);
      return this.tier === 'metadata'
        ? filterStatsRecordMetadata(stripped, { fingerprintSalt: this.salt })
        : stripped;
    }
    return filterEventForTier(payload, this.tier, { fingerprintSalt: this.salt });
  }

  /** Per-run monotonic `seq`, demultiplexed out of the interleaved journal and
   *  PERSISTED — a restart that reset a run's counter to 1 would re-issue
   *  `(run_id, seq)` pairs the cloud has already dedup'd against. */
  private nextSeq(state: OutboxState, runId: string): number {
    const next = state.seq[runId] ?? 1;
    state.seq[runId] = next + 1;
    const at = state.seq_order.indexOf(runId);
    if (at >= 0) state.seq_order.splice(at, 1);
    state.seq_order.push(runId);
    while (state.seq_order.length > this.maxTrackedRuns) {
      const evicted = state.seq_order.shift();
      if (evicted === undefined) break;
      delete state.seq[evicted];
      state.counters.run_counters_evicted += 1;
    }
    return next;
  }

  /** Enforce the bound by dropping the OLDEST records — a lost tail is
   *  recoverable, a wedged run is not (`03` F3). Drops are taken in batches so
   *  the rewrite is amortized, and are counted plus reported, never silent. */
  private enforceBound(state: OutboxState): void {
    this.syncQueueDepth();
    if (this.queued <= this.maxRecords) return;
    const headroom = Math.max(1, Math.floor(this.maxRecords * DROP_BATCH_FRACTION));
    const target = Math.max(0, this.maxRecords - headroom);
    const all = this.readAll();
    const dropCount = Math.max(0, all.length - target);
    if (dropCount === 0) return;
    this.rewrite(all.slice(dropCount));
    state.counters.dropped_bound += dropCount;
    this.noteDrop(state, {
      reason: 'bound',
      count: dropCount,
      detail: `outbox bound ${this.maxRecords} reached — dropped the ${dropCount} oldest record(s)`,
    });
  }

  /**
   * Record a drop: durably counted here, REPORTED once per cycle by
   * {@link flushDropReports}.
   *
   * Aggregated deliberately — a per-record report would turn a routine batch
   * (e.g. every record dropped together at the bound) into a stream of log
   * lines nobody reads. This ledger is reserved for GENUINE loss as of
   * `b20`: a `session.opened`-shaped exclusion never reaches here — see
   * {@link noteExclusion} — so the COUNT is what is never allowed to be
   * silent, and it is written to `state.json` on every path.
   */
  private noteDrop(state: OutboxState, info: DropInfo): void {
    state.counters.last_drop_at = new Date(this.now()).toISOString();
    state.counters.last_drop_reason = info.reason;
    const prior = this.dropAccum.get(info.reason);
    if (prior) {
      prior.count += info.count;
    } else {
      this.dropAccum.set(info.reason, { count: info.count, detail: info.detail });
    }
  }

  /** Emit at most one report per reason per enqueue/drain cycle. */
  private flushDropReports(): void {
    for (const [reason, acc] of this.dropAccum) {
      try {
        this.onDrop({ reason, count: acc.count, detail: acc.detail });
      } catch {
        /* a reporting sink must never fail the caller */
      }
    }
    this.dropAccum.clear();
  }

  /**
   * Record an EXPECTED exclusion: durably counted here, REPORTED once per
   * cycle by {@link flushExclusionReports}. Distinct from {@link noteDrop}
   * — this is not loss (ux-v2 `b20`).
   *
   * Aggregated for the same reason `noteDrop` is. `session.opened`
   * legitimately carries a null `run_id` and a project journal is full of
   * such lines, so a per-record report would turn a routine, expected
   * exclusion into a stream of log lines — the fastest way to make a report
   * something people stop reading. What `b20` changes is the WORD and the
   * LEDGER: this path is never phrased as "dropped", because the record was
   * never shippable in the first place, by design, not lost in flight. It
   * gets its own counter (`excluded_not_applicable`) and its own vocabulary
   * ("excluded … not_applicable"). The count is still never silent — it is
   * written to `state.json` on every path, exactly like a drop's.
   */
  private noteExclusion(state: OutboxState, info: ExclusionInfo): void {
    state.counters.last_exclusion_at = new Date(this.now()).toISOString();
    state.counters.last_exclusion_reason = info.reason;
    const prior = this.exclusionAccum.get(info.reason);
    if (prior) {
      prior.count += info.count;
    } else {
      this.exclusionAccum.set(info.reason, { count: info.count, detail: info.detail });
    }
  }

  /** Emit at most one report per reason per enqueue/drain cycle — same
   *  cadence as {@link flushDropReports}, kept on a separate ledger/sink so
   *  an expected exclusion can never be aggregated into, or worded as, a
   *  drop. */
  private flushExclusionReports(): void {
    for (const [reason, acc] of this.exclusionAccum) {
      try {
        this.onExclude({ reason, count: acc.count, detail: acc.detail });
      } catch {
        /* a reporting sink must never fail the caller */
      }
    }
    this.exclusionAccum.clear();
  }

  // ── drain ─────────────────────────────────────────────────────────────────

  /**
   * Tail the project journal from the cursor and enqueue everything new.
   *
   * The whole rotation/torn-line/demux contract lives here; see the module
   * header for why the identity is the first line's hash and not an inode.
   */
  drainJournal(): DrainResult {
    const result: DrainResult = {
      lines_read: 0,
      enqueued: 0,
      skipped_no_run_id: 0,
      skipped_excluded: 0,
      skipped_malformed: 0,
      torn_tail: false,
      restarted: false,
      bytes_consumed: 0,
      skipped_locked: false,
    };
    if (!telemetrySyncEnabled(this.env)) return result;
    if (!existsSync(this.journal)) return result;

    // waitMs 0: a drain that loses the lock has lost nothing — the next poll
    // reads the same bytes. Only enqueue, which would lose a record, waits.
    const lock = tryLockSync(this.lockPath, this.now, 0);
    if (!lock) {
      result.skipped_locked = true;
      return result;
    }
    // Hoisted so the catch below can still persist a cursor that advanced
    // part-way through the loop.
    let state: OutboxState | null = null;
    try {
      const st = safeStat(this.journal);
      if (!st || !st.isFile()) return result;
      state = this.loadState();

      const anchor = journalAnchor(this.journal, st.size);
      if (anchor === null) {
        // No complete first line yet — the file is empty or its very first
        // line is mid-append. Binding a provisional identity here would be a
        // guess; waiting costs one poll interval.
        result.torn_tail = st.size > 0;
        if (result.torn_tail) state.counters.torn_line_retries += 1;
        this.saveState(state);
        return result;
      }

      const prior = state.cursor;
      const mismatched =
        prior === null ||
        prior.anchor !== anchor ||
        st.size < prior.offset ||
        !offsetFollowsNewline(this.journal, prior.offset);
      let cursor: JournalCursor;
      if (mismatched) {
        if (prior !== null) {
          state.counters.rotations_detected += 1;
          result.restarted = true;
        }
        cursor = {
          anchor,
          offset: 0,
          ino: Number.isFinite(st.ino) && st.ino > 0 ? st.ino : null,
          birthtime_ms: Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : null,
        };
      } else {
        cursor = prior;
      }
      state.cursor = cursor;

      if (st.size <= cursor.offset) {
        this.saveState(state);
        return result;
      }

      const chunk = readRange(this.journal, cursor.offset, st.size);
      const lastNl = chunk.lastIndexOf(NEWLINE);
      if (lastNl < 0) {
        // Everything new is one unterminated line. Do not parse it, do not
        // skip it, do not advance — retry it whole next drain.
        result.torn_tail = true;
        state.counters.torn_line_retries += 1;
        this.saveState(state);
        return result;
      }
      const complete = chunk.subarray(0, lastNl + 1);
      if (lastNl + 1 < chunk.length) {
        result.torn_tail = true;
        state.counters.torn_line_retries += 1;
      }

      this.syncQueueDepth();
      // Line boundaries are found on the BUFFER, and the cursor advances by
      // the exact byte count of each line as it is consumed. Two reasons:
      // decoding first and measuring the decoded string would desync the
      // offset the moment a byte is not valid UTF-8 (one replacement char is
      // three bytes where the original was one), and a per-line advance means
      // an exception part-way through leaves the cursor at the last line
      // actually processed instead of re-reading — and re-SEQUENCING — the
      // ones already queued.
      let start = 0;
      for (;;) {
        const nl = complete.indexOf(NEWLINE, start);
        if (nl < 0) break;
        const lineBuf = complete.subarray(start, nl);
        const advance = nl + 1 - start;
        start = nl + 1;
        cursor.offset += advance;
        result.bytes_consumed += advance;

        const line = lineBuf.toString('utf-8');
        if (!line.trim()) continue;
        result.lines_read += 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = undefined;
        }
        if (!isRecord(parsed)) {
          // Newline-terminated but unparseable: genuinely malformed, not torn.
          // Counted and stepped over — retrying it forever would wedge the
          // queue behind one bad byte.
          result.skipped_malformed += 1;
          state.counters.dropped_malformed += 1;
          this.noteDrop(state, {
            reason: 'malformed',
            count: 1,
            detail: `${result.skipped_malformed} journal line(s) were not JSON objects`,
          });
          continue;
        }
        const beforeDropped = state.counters.dropped_no_run_id;
        const beforeExcluded = state.counters.excluded_not_applicable;
        const rec = this.appendFiltered(state, 'event', parsed);
        if (rec) result.enqueued += 1;
        else if (state.counters.dropped_no_run_id > beforeDropped) result.skipped_no_run_id += 1;
        else if (state.counters.excluded_not_applicable > beforeExcluded) result.skipped_excluded += 1;
      }

      this.saveState(state);
      return result;
    } catch {
      // D2: the telemetry path NEVER throws into the run. Persist whatever the
      // cursor reached so the lines already queued are not re-read (and so
      // re-sequenced) on the next poll; if even that fails, the identity check
      // makes a fresh start the worst case, never a stale seek.
      try {
        if (state) this.saveState(state);
      } catch {
        /* best effort */
      }
      return result;
    } finally {
      lock.release();
      this.flushDropReports();
      this.flushExclusionReports();
    }
  }

  // ── introspection ─────────────────────────────────────────────────────────

  /** Durable counters, read from disk so another process (`pipeline stats
   *  telemetry`) sees the same numbers the daemon wrote. */
  counters(): OutboxCounters {
    const state = this.loadState();
    this.syncQueueDepth();
    // Both depths are re-derived from the files rather than trusted from
    // `state.json` — another process may have moved records since it was
    // written, and a depth that disagrees with the file is a lie.
    return {
      ...state.counters,
      queued: this.queued,
      quarantine_depth: countLines(this.quarantinePath),
    };
  }

  /** The persisted cursor, or `null` before the first successful bind. */
  cursor(): JournalCursor | null {
    return this.loadState().cursor;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The envelope `run_id`, else a nested `data.run_id` (the `awaiting_input` /
 *  `manager.stopped` shapes carry it there too). Empty ⇒ unusable. */
function readRunId(payload: Record<string, unknown>): string | null {
  const top = payload.run_id;
  if (typeof top === 'string' && top.trim()) return top.trim();
  const data = payload.data;
  if (isRecord(data) && typeof data.run_id === 'string' && data.run_id.trim()) {
    return data.run_id.trim();
  }
  return null;
}

/**
 * Event `type`s whose journal envelope legitimately carries a null `run_id`
 * BY DESIGN, not by malfunction (ux-v2 `b20`).
 *
 * `session.opened` is written by `hooks/session_relay.ts` when a Claude
 * Code SESSION opens — frequently before any run exists yet to carry an id —
 * with `run_id: null` stamped explicitly at the write site, never omitted by
 * accident. It is therefore UNDEDUPABLE by construction, not lost telemetry:
 * see this module's `noteExclusion` and `04-subsystem-rules.md`.
 *
 * Anything else that reaches `appendFiltered` with no `run_id` is genuine,
 * unexpected loss and stays on the `dropped_no_run_id` / `noteDrop` path —
 * this set is intentionally small and reviewed on every addition, never
 * grown to quietly reclassify a real drop.
 */
const EXPECTED_RUNLESS_TYPES: ReadonlySet<string> = new Set(['session.opened']);

function isExpectedRunlessType(payload: Record<string, unknown>): boolean {
  return typeof payload.type === 'string' && EXPECTED_RUNLESS_TYPES.has(payload.type);
}

/**
 * A record's identity within the queue files.
 *
 * `org` is part of it, and that is load-bearing rather than tidy. Without it,
 * two records sharing `(kind, run_id, seq)` but queued under DIFFERENT orgs are
 * indistinguishable — so acking (or quarantining) the current org's record
 * would silently delete the other org's, which the flush had just correctly
 * refused to send. `b10`'s "the refusal survives a run_id collision" test is
 * exactly that case, and it fails with `org` removed from this key.
 *
 * The collision is reachable: `state.json` holds ONE `seq` map for the project,
 * not one per org, so a state file that is reset (schema mismatch, hand-delete,
 * fresh clone) while records from a previous org are still queued re-issues
 * `seq` from 1 under the new org.
 */
function recordKey(r: OutboxRecord): string {
  return JSON.stringify([r.org, r.kind, r.run_id, r.seq]);
}

/** Read a `.jsonl` record file, oldest first. Unparseable lines (a torn write
 *  from a killed process, or a hand-edit) are skipped rather than trusted. */
function readRecordFile(path: string): OutboxRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const out: OutboxRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const rec = parseRecord(line);
    if (rec) out.push(rec);
  }
  return out;
}

function parseRecord(line: string): OutboxRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { org, run_id, seq, kind, payload } = parsed;
  if (typeof org !== 'string' || !org) return null;
  if (typeof run_id !== 'string' || !run_id) return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq)) return null;
  if (kind !== 'event' && kind !== 'stats') return null;
  if (!isRecord(payload)) return null;
  return { org, run_id, seq, kind, payload };
}
