// telemetry-history.ts — the day-one backfill half of `pipeline cloud connect`
// (ux-v2 `b13`, `03` F1, `08` J1).
//
// WHAT THIS IS. `b9`'s outbox (`telemetry-outbox.ts`) only ever learns about a
// run through `drainJournal()` — tailing the LIVE project journal from a
// cursor. A project that connects to the cloud today already has a history of
// finished runs sitting in `.pipeline/.stats/**/runs.jsonl` (`lib/stats.ts`),
// written by every `pipeline drive`/`pipeline next` invocation whether or not
// the project was ever connected. Without this module, a freshly-connected
// project's dashboard would stay empty until the NEXT run finishes — exactly
// the "empty on day one" experience `08` J1 exists to close.
//
// This module does two things, deliberately kept separate from `commands/
// cloud.ts`'s own orchestration (progress output, `--no-history`, the
// telemetry-enabled gate) so each half is independently testable:
//
//   1. ENUMERATE — `findHistoryRecords` walks every `runs.jsonl` under
//      `<project>/.pipeline/.stats` (via `lib/stats.ts`'s own
//      `findRunsFiles`/`parseRunRecords` — the SAME parse the `pipeline
//      stats` command already trusts) and returns every finished run record,
//      oldest-file-order.
//   2. ENQUEUE — `enqueueHistoryRecords` hands each one to an INJECTED
//      `enqueue` function (in production, `TelemetryOutbox.enqueueStats`
//      bound to the connecting org) tagged `origin: "local"` (protocol D18 —
//      `RunRecordStatsSchema.origin`, `RUN_RECORD_ORIGINS` in
//      `pipeline-protocol/src/records/run-record.ts` — absent defaults to
//      `"dispatched"`, so this tag is what tells the control plane these rows
//      started on a machine, not a cloud dispatch).
//
// WHY `enqueue` IS INJECTED RATHER THAN THIS MODULE CONSTRUCTING A
// `TelemetryOutbox` ITSELF: the mid-history-failure requirement (`b13` DoD —
// "a mid-history failure leaves records queued and still exits 0") needs a
// REAL, injectable failure partway through a 47-record pass, not just an
// exit-code assertion. A plain function seam lets a test throw on the Nth
// call directly, independent of `TelemetryOutbox`'s own (already-proven)
// internal robustness.
//
// NEVER THROWS PAST A SINGLE RECORD (D2). `enqueueHistoryRecords` catches
// each call independently: one record's failure (the injected fault, a
// disk-full `TelemetryOutbox.enqueueStats`, a malformed record the privacy
// filter chokes on) never aborts the rest of the pass and never propagates to
// the caller. The source files this module reads are NEVER mutated or
// deleted — enumeration is a pure re-scan every time it runs — so whatever a
// pass does not manage to enqueue is untouched on disk and is discovered
// again, byte-identical, on the next `pipeline cloud connect`. Re-enqueuing an
// already-shipped record is a harmless replay: the server's revision guard
// (`03` F3 — "(run_id, seq) dedup plus the revision guard make replay a
// no-op") no-ops an equal-or-older revision regardless of the fresh `seq`
// a second enqueue assigns it, and every history record ships at the implicit
// revision 1 (never set explicitly here).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRunsFiles, parseRunRecords, type RunRecord } from './stats';
import type { OutboxRecord } from './telemetry-outbox';

/** `RunRecordStatsSchema.origin`'s `"local"` value (protocol D18) — a run that
 *  started on THIS machine, as opposed to the absent-default `"dispatched"`
 *  (cloud-dispatched). Every record this module enqueues carries it. */
export const HISTORY_ORIGIN = 'local';

/** `<project>/.pipeline/.stats` — the tree `findHistoryRecords` walks. Mirrors
 *  `lib/stats.ts:statsLocation`'s own `.pipeline/.stats` anchor, but computed
 *  directly from the project root `cloud connect` already has in hand rather
 *  than re-deriving it from an arbitrary pipeline path — `connect` has no
 *  single "pipeline root" to resolve from, only the project directory itself. */
export function historyStatsBase(projectRoot: string): string {
  return join(projectRoot, '.pipeline', '.stats');
}

export interface HistoryRecordEntry {
  /** The `runs.jsonl` this record was read from — diagnostic only. */
  file: string;
  record: RunRecord;
}

/**
 * Every finished run record on disk for this project, oldest-file-order.
 * Read-only: never mutates or deletes anything under `.stats`. Missing tree
 * (never run a pipeline yet) and unreadable files both degrade to "found
 * nothing" rather than throwing — this is a best-effort enumeration, not a
 * validation pass.
 */
export function findHistoryRecords(projectRoot: string): HistoryRecordEntry[] {
  const base = historyStatsBase(projectRoot);
  if (!existsSync(base)) return [];
  const out: HistoryRecordEntry[] = [];
  for (const file of findRunsFiles(base)) {
    if (!existsSync(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch {
      continue; // unreadable this pass — picked up again next connect
    }
    for (const record of parseRunRecords(text)) out.push({ file, record });
  }
  return out;
}

export interface HistoryEnqueueResult {
  /** Total historical records `findHistoryRecords` discovered. */
  found: number;
  /** Records the injected `enqueue` accepted (returned a non-null record). */
  enqueued: number;
  /** `found - enqueued` — never queued THIS pass. Still on disk (the source
   *  `runs.jsonl` files are untouched), so a later `pipeline cloud connect`
   *  (or any retry) re-discovers and re-attempts every one of them. */
  skipped: number;
}

/**
 * Enqueue every entry, one call to `enqueue` per record, in order.
 *
 * `enqueue` is called with the record's fields plus `origin: "local"` — the
 * SAME shape `TelemetryOutbox.enqueueStats` expects (it is a finished
 * `RunRecord`, matching `04-subsystem-rules.md`'s "stats" kind). A `null`
 * return (telemetry disabled mid-loop, the drain lock could not be taken, no
 * usable `run_id`) or a THROWN exception both count as "not enqueued this
 * pass" — see this module's header for why a throw here can never escape to
 * the caller and never aborts the remaining records.
 */
export function enqueueHistoryRecords(
  entries: readonly HistoryRecordEntry[],
  enqueue: (payload: Record<string, unknown>) => OutboxRecord | null,
): HistoryEnqueueResult {
  let enqueued = 0;
  for (const entry of entries) {
    try {
      const rec = enqueue({ ...entry.record, origin: HISTORY_ORIGIN });
      if (rec) enqueued++;
    } catch {
      // One record's failure — real (a disk fault) or injected (a test) —
      // is independent of every other record. Never rethrown, never fatal
      // to the pass: the source file is untouched, so this record is
      // retried whole on the next enumeration.
    }
  }
  return { found: entries.length, enqueued, skipped: entries.length - enqueued };
}
