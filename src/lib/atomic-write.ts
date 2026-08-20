// Atomic whole-file replacement: write a sibling temp file, then rename it
// over the target. The shared version of a primitive this repo had already
// grown FIVE private copies of — `cloud-config.ts#writeFileAtomic`,
// `render.ts#atomicReplace`, and the three near-identical
// `writeFileAtomic`/`writeJsonAtomic` bodies in `telemetry-outbox.ts`,
// `telemetry-status.ts` and `telemetry-upload.ts`. New callers import THIS
// one instead of copying a sixth; the existing five are left alone
// deliberately (they are already atomic — consolidating them is a separate,
// wider change than the one that introduced this module).
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
//                                                orphan temp left behind
//                                                (never read by anything), or
//   (c) completed the rename                   → new content fully in place.
// The target path is NEVER observed partially written.
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
// In practice the readers of these files (`renderSummary`, `pipeline stats`)
// use `readFileSync`, which opens and closes in well under a millisecond, so
// real overlap is brief. The rename is therefore retried a few times with a
// short synchronous backoff (~62 ms worst case — this runs on a hook path and
// must not stall a user's run) which comfortably covers a transient reader or
// a quick AV scan. A reader that holds its handle open for longer than the
// budget makes the write FAIL — loudly, with the original file intact. That
// is the deliberate trade: a skipped stats enrichment is recoverable, a
// corrupted runs.jsonl is not.
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

/** 6 attempts with a doubling 2 ms base ⇒ sleeps of 2+4+8+16+32 = 62 ms worst
 *  case. Sized against the measurement in the header: long enough to ride out
 *  a concurrent `readFileSync` or a quick AV touch, short enough that a hook
 *  path never visibly stalls. Zero delay on the normal path — the first
 *  attempt succeeds and nothing sleeps. */
const DEFAULT_RENAME_ATTEMPTS = 6;
const DEFAULT_RENAME_BACKOFF_MS = 2;

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
  /** Rename attempts before giving up (default 5, minimum 1). */
  renameAttempts?: number;
  /** Base backoff between rename attempts, doubling each time (default 1 ms). */
  renameBackoffMs?: number;
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
 * `writeFileSync` of the same string would have produced.
 *
 * Throws on failure, having already removed its temp file, and leaves
 * `filePath` untouched. Callers that must never throw wrap it — `stats.ts`
 * already does, and its best-effort contract is unchanged.
 */
export function writeFileAtomicSync(filePath: string, data: string, deps: AtomicWriteDeps = {}): void {
  const fs = deps.fs ?? realAtomicFs;
  const attempts = Math.max(1, deps.renameAttempts ?? DEFAULT_RENAME_ATTEMPTS);
  const backoffMs = Math.max(0, deps.renameBackoffMs ?? DEFAULT_RENAME_BACKOFF_MS);
  const tmp = atomicTempPath(filePath);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, filePath);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? '';
        if (attempt >= attempts || !RETRYABLE_RENAME_CODES.has(code)) throw e;
        sleepSync(backoffMs * 2 ** (attempt - 1));
      }
    }
  } catch (e) {
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
