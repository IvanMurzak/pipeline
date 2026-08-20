// Atomic whole-file replacement: write a sibling temp file, then rename it
// over the target. A shared version of a primitive this repo had already grown
// FIVE private copies of — `cloud-config.ts#writeFileAtomic`,
// `render.ts#atomicReplace`, and the three near-identical
// `writeFileAtomic`/`writeJsonAtomic` bodies in `telemetry-outbox.ts`,
// `telemetry-status.ts` and `telemetry-upload.ts`. The existing five are left
// alone deliberately (they are already atomic).
//
// ⚠ THIS IS NOT A DROP-IN FOR ALL FIVE, AND ESPECIALLY NOT FOR THE CREDENTIAL
// STORE. It takes no file mode. `cloud-config.ts#writeFileAtomic` takes one
// and calls `chmodSync(tmp, mode)` BEFORE the rename, specifically to defeat
// umask, because it writes the credential store at 0600. Porting that caller
// onto this function as written would silently widen a private key to 0644 on
// POSIX. Adding `mode` here is a reasonable future change; until someone does
// it AND verifies the mode bits on a POSIX box, treat this primitive as being
// for files whose permissions do not matter.
//
// The same gap in miniature applies to every caller: because the destination
// inode is the TEMP file's, the result carries the umask default rather than
// any mode the destination previously had. A plain `writeFileSync` over an
// existing file preserved it. Only relevant to a user who deliberately
// tightened permissions on a stats file, but it is a real semantic change.
//
// ── WHAT THE PRIMITIVE BUYS ────────────────────────────────────────────────
// A plain `writeFileSync` truncates its target to zero bytes and then fills
// it. A process that dies between those two steps leaves the user holding a
// truncated or half-written file — and for an accumulating history file like
// `.stats/<pipeline>/runs.jsonl`, that is destroyed data, not a retryable
// operation. Temp-file-plus-rename removes the window entirely: a process
// killed at any instant either
//   (a) never created the temp file            → original untouched,
//   (b) created it but never renamed           → original untouched, one
//                                                orphan temp left behind, or
//   (c) completed the rename                   → new content fully in place.
// The target path is NEVER observed partially written.
//
// Case (b) is only safe because the orphan is INERT, and that rests on a
// property of the callers rather than of this file: every consumer of these
// files discovers them by EXACT FILENAME, never by suffix or glob —
// `stats.ts#findRunsFiles` matches `name === 'runs.jsonl'`, and
// `findRunsFilesWithDirs` constructs `join(dir, 'runs.jsonl')`. So a `.tmp-`
// orphan is never parsed, never counted into SUMMARY.md and never shipped.
// IF A FUTURE READER EVER MATCHES THESE FILES BY PATTERN, that stops being
// true and an abandoned temp becomes a phantom duplicate run record.
//
// Nothing removes orphans either, and each is a full-size copy of its target,
// so on a machine that kills processes routinely they accumulate. A stale
// sweep is deliberately NOT done here: deleting a `.tmp-` sibling risks
// destroying a CONCURRENT writer's in-flight temp, and pid-liveness checks
// cannot save it because pids are reused. An age-gated sweep (drop `.tmp-`
// siblings older than a day) would be safe in a way an unconditional one is
// not — a reasonable follow-up, not done here.
//
// ── SAME DIRECTORY IS LOAD-BEARING ─────────────────────────────────────────
// The temp file is created in `dirname(filePath)`, not in the OS temp dir.
// `rename` is only atomic WITHIN a filesystem; across filesystems it degrades
// to copy-then-delete, which reopens the exact half-written-file window this
// module exists to close. Same directory ⇒ same filesystem, always.
//
// The temp name is `.<basename>.tmp-<pid>-<seq>-<rand>`: leading dot so it is
// hidden on POSIX, and pid + sequence + random so two concurrent writers
// (two processes, or two calls in one process) can never pick the same temp
// path and clobber each other. A FIXED `.tmp` suffix would also risk
// colliding with a real sibling file legitimately named `<something>.tmp` —
// the bug `render.ts` documents having reasoned about.
//
// ── WINDOWS ────────────────────────────────────────────────────────────────
// Replacing an EXISTING destination via rename is fine on Windows: Node's
// `fs.renameSync` maps to `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`, and
// the swap is an atomic metadata operation on NTFS. (Measured on Windows 11 /
// Bun 1.3.14 — see tests/atomic-write.test.ts, which asserts replacement of a
// populated destination on whatever platform it runs on, so the Windows CI
// leg re-proves it every run.)
//
// What Windows adds that POSIX does not is the SHARING VIOLATION, and it is
// NOT the exotic case it is usually described as. MEASURED on Windows 11 with
// Bun 1.3.14: an ordinary open read handle — a plain `openSync(path, 'r')`,
// nothing unusual — makes the rename over that path fail with EPERM. Bun's
// file opens evidently do not pass FILE_SHARE_DELETE, so ANY concurrent
// reader of the destination, not just an antivirus scanner or an editor, can
// block the swap. POSIX has no equivalent: there `rename` ignores open
// handles entirely, and a reader holding the old fd keeps reading the old
// inode. tests/atomic-write.test.ts asserts BOTH behaviours, per platform.
//
// ── THE TRADE THIS MAKES ON WINDOWS — READ BEFORE "IMPROVING" IT ───────────
// State it plainly, because the first version of this file did not and that
// was the review's blocking finding: ON WINDOWS THIS PRIMITIVE CAN REFUSE A
// WRITE THAT A PLAIN `writeFileSync` WOULD HAVE COMPLETED. Measured end to
// end through `statsEnrichTokens`, Windows 11 / Bun 1.3.14, with ONE
// concurrent read handle held open:
//
//     plain writeFileSync : returns true,  tokens land,      ~17 ms
//     writeFileAtomicSync : returns false, tokens do NOT,   ~103 ms
//
// So this is not a free win, and "byte-identical" is only true of writes that
// SUCCEED. What changed is *whether* they succeed. The deliberate choice is
// to lose an enrichment rather than risk a torn file: a skipped fold is
// re-derivable by `stats-backfill.ts`, a truncated runs.jsonl is gone. That
// trade is only defensible while the loss is VISIBLE, which is why
// `stats.ts` reports it rather than swallowing it — see the call sites.
//
// ── SIZING THE RETRY BUDGET (measured, not rounded) ────────────────────────
// Retrying is worth it because the realistic contender is brief. Measured on
// the same box:
//
//   · a real reader — `readFileSync` of a 1.5 KB runs.jsonl — holds the
//     handle for a mean of 0.025 ms over 2000 iterations;
//   · 1000 uncontended writes with retries DISABLED produced 0 failures and a
//     2.11 ms slowest write, i.e. no ambient AV/indexer interference was
//     observable here at all. (This is why the earlier claim that the budget
//     "comfortably covers a quick AV scan" was removed rather than re-tuned:
//     it asserted something this box cannot demonstrate. Defender can hold a
//     freshly created file well past any budget we would want on a hook path;
//     if that happens the write fails visibly, which is the honest outcome.)
//   · against a REAL cross-process reader holding a handle, the budget below
//     measured: hold 0/25/100/200 ms → SUCCEEDED (in 4/15/109/217 ms, i.e.
//     the write lands right after the reader lets go); hold 400/1000 ms →
//     FAILED EPERM after all 14 attempts, original intact, zero orphan temps.
//     Note the failure costs ~325 ms of WALL time, not the 231 ms of sleeps —
//     each refused `MoveFileExW` itself costs ~6-7 ms.
//
// The budget is therefore ~10,000× the measured reader hold, which is margin
// for a loaded machine rather than a guess. It is capped rather than doubled
// forever because the happy path pays NOTHING (a first-attempt success sleeps
// zero) while the failure path is paid per call — and `stats-backfill.ts`
// calls this once PER RECORD, so an unbounded budget would multiply across a
// backfill of a large .stats tree.
//
// ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
// ATOMIC IS NOT CONCURRENCY-SAFE. This makes a single write indivisible; it
// does NOT make a read-modify-write serialisable. `statsEnrichTokens` reads
// runs.jsonl, folds, and writes it back, so a concurrent `appendFileSync` from
// `statsFinalizeRun` landing between the read and the rename is still lost.
// That is not a regression — the old truncate-then-fill lost the same append,
// and in fact lost it WORSE: it could interleave into a partially rewritten
// file and leave a torn line, whereas this loses the record cleanly. But
// nobody should read "atomic" here as "safe to run two of these at once".
//
// SYMLINKS ARE REPLACED, NOT FOLLOWED. If the destination is a symlink, a
// plain `writeFileSync` would write THROUGH it to the link target; the rename
// swaps the link itself for a regular file. Standard for this technique and
// fine for the stats files, but a real semantic change worth knowing about.
//
// A RETRY IS NOT A FALLBACK. Every attempt is the same atomic rename; there
// is no degraded path. If the retries are exhausted the temp file is removed
// and the ORIGINAL error is rethrown, leaving the target file exactly as it
// was. This module NEVER falls back to a non-atomic `writeFileSync` over the
// destination — silently or otherwise — because doing so would reintroduce
// precisely the truncation window it exists to remove.

import { renameSync as fsRenameSync, unlinkSync as fsUnlinkSync, writeFileSync as fsWriteFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * The three filesystem calls a temp-file-plus-rename replacement needs,
 * injectable so tests can fail one on purpose. This mirrors `CloudFs` in
 * `cloud-config.ts`, which exists for the same reason: a real child process
 * can wrap `renameSync` to stall INSIDE the vulnerable window and be killed
 * there, proving durability against a real kill instead of arguing for it.
 */
export interface AtomicFs {
  writeFileSync(path: string, data: string, encoding: 'utf8'): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

/** Production wiring: the real `node:fs`. */
export const realAtomicFs: AtomicFs = {
  writeFileSync: (path, data, encoding) => fsWriteFileSync(path, data, encoding),
  renameSync: (from, to) => fsRenameSync(from, to),
  unlinkSync: (path) => fsUnlinkSync(path),
};

/**
 * Errno codes a Windows sharing violation surfaces as. Retried; anything else
 * (ENOENT, ENOSPC, EROFS, EXDEV …) is a real fault and is rethrown at once —
 * retrying those would only delay the caller's failure.
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * 14 attempts, 1 ms base, doubling but CAPPED at 25 ms ⇒ sleeps of
 * 1+2+4+8+16+25×8 = 231 ms worst case. See the sizing section in the header
 * for the measurements behind these numbers.
 *
 * The cap is the point. Pure doubling reaches a long budget with very coarse
 * granularity at the tail — measured: with an uncapped 1022 ms budget, a
 * reader that released its handle at 600 ms was not retried until ~1022 ms,
 * so the call cost 1103 ms to do something it could have done at 600. Capping
 * the interval keeps the ceiling while retrying every 25 ms near it, so the
 * write lands shortly after the contender actually lets go.
 *
 * Zero delay on the normal path: the first attempt succeeds and nothing
 * sleeps at all (1000/1000 uncontended writes needed no retry).
 */
const DEFAULT_RENAME_ATTEMPTS = 14;
const DEFAULT_RENAME_BACKOFF_MS = 1;
const RENAME_BACKOFF_CAP_MS = 25;

/** Monotonic per-process counter — see the temp-name note in the header. */
let tmpSeq = 0;

/** Synchronous sleep (no-op for ms<=0). Local rather than imported from
 *  `lib/git.ts` so this leaf module stays dependency-free — the same call
 *  `telemetry-outbox.ts` makes, and for the same reason. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The temp path for `filePath` — always its sibling. Exported for tests that
 *  assert the same-directory invariant without reimplementing the format. */
export function atomicTempPath(filePath: string): string {
  const unique = `${process.pid}-${++tmpSeq}-${Math.random().toString(36).slice(2, 8)}`;
  return join(dirname(filePath), `.${basename(filePath)}.tmp-${unique}`);
}

export interface AtomicWriteDeps {
  /** Defaults to the real `node:fs`. */
  fs?: AtomicFs;
  /** Rename attempts before giving up (default 14, minimum 1). */
  renameAttempts?: number;
  /** Base backoff between rename attempts. Doubles each attempt, capped at
   *  25 ms (default 1 ms base ⇒ 231 ms total across the 14 attempts). */
  renameBackoffMs?: number;
}

/** The error a failed atomic write throws is the UNDERLYING fs error, rethrown
 *  unchanged (same object — cleanup never masks the real fault), with this one
 *  field added so a caller can report how hard it tried. `renameAttempts` is
 *  0 when the temp WRITE failed and the rename was never reached. */
export interface AtomicWriteError extends NodeJS.ErrnoException {
  renameAttempts?: number;
}

/**
 * Replace `filePath`'s entire contents with `data`, atomically.
 *
 * `data` is written verbatim as UTF-8 — this function does not transform,
 * scrub or re-encode it. REDACTION IS THE CALLER'S JOB and deliberately so:
 * scrubbing in here would double-scrub every caller that already redacts (and
 * so change the bytes), and would make this primitive unusable for the writers
 * whose whole purpose is to persist a secret verbatim — the credential store
 * being exactly such a writer. `tests/output-scrubber-sinks.test.ts` enforces
 * that split by treating a `writeFileAtomicSync` call as a file sink, so a
 * call site that forgets its own `scrub` is caught there.
 *
 * The bytes that land are therefore byte-for-byte the bytes a plain
 * `writeFileSync` of the same string would have produced — WHEN THE WRITE
 * SUCCEEDS. On Windows it can legitimately refuse where a plain write would
 * have succeeded; see the trade section in the header.
 *
 * Throws on failure, having already removed its temp file, and leaves
 * `filePath` untouched. The thrown error is the underlying fs error, annotated
 * with `renameAttempts` (see `AtomicWriteError`). Callers that must never
 * throw wrap it — but a caller that swallows this silently is hiding a lost
 * write, so `stats.ts` reports it before returning false.
 */
export function writeFileAtomicSync(filePath: string, data: string, deps: AtomicWriteDeps = {}): void {
  const fs = deps.fs ?? realAtomicFs;
  const attempts = Math.max(1, deps.renameAttempts ?? DEFAULT_RENAME_ATTEMPTS);
  const backoffMs = Math.max(0, deps.renameBackoffMs ?? DEFAULT_RENAME_BACKOFF_MS);
  const tmp = atomicTempPath(filePath);
  let renameAttempts = 0;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    for (let attempt = 1; ; attempt++) {
      renameAttempts = attempt;
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? '';
        if (attempt >= attempts || !RETRYABLE_RENAME_CODES.has(code)) throw e;
        sleepSync(Math.min(backoffMs * 2 ** (attempt - 1), RENAME_BACKOFF_CAP_MS));
      }
    }
  } catch (e) {
    // Record how many renames were tried, so the caller can tell "refused once
    // outright" from "retried to exhaustion and the contender never let go".
    // Annotating the SAME error object rather than wrapping it keeps the
    // rethrow-the-original-fault contract exactly as it was.
    if (e instanceof Error) (e as AtomicWriteError).renameAttempts = renameAttempts;
    // Cleanup is best-effort and must never mask the real fault: whatever
    // went wrong with the write or the rename is what the caller sees. (When
    // the temp file was never created, this unlink throws ENOENT and is
    // swallowed here — that is the intended path, not a leak.)
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}
