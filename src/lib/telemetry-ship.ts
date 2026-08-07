// telemetry-ship.ts — the RUN-EXIT half of the telemetry subsystem
// (ux-v2 `b21`, `06` P5, `03` F2's last two lines).
//
// WHAT THIS IS. `b9`'s outbox learns about a run two ways: `drainJournal()`
// tails the LIVE journal (wired into `pipeline drive`/`pipeline next` by `b12`
// via `telemetry-tail.ts`), and `enqueueStats()` takes a finished
// `.stats/**/runs.jsonl` record. Until `b21` the ONLY caller of the second was
// `pipeline cloud connect`'s day-one history scan (`b13`,
// `telemetry-history.ts`) — so a run that ended and was never followed by a
// `cloud connect` shipped no record at all.
//
// That mattered far more than "the dashboard is missing a number", because the
// run record is the ONLY thing that ends a local run server-side:
// `applyStatsRunRecord` (`cloud/apps/api/src/modules/runs/ingest.ts`) is what
// sets `status='ended'`, `ended_at`, `outcome` and every `stats_*` column. The
// journal's own events open steps and mark the run `running`; nothing in that
// stream closes it. Production evidence (i1, 2026-08-07): 4 of 4 runs stuck at
// `status=running` with `ended_at` and `outcome` NULL, two of them predating
// the harness.
//
// So `lib/stats.ts` calls in here at BOTH of the two moments a `runs.jsonl`
// record changes state, and nowhere else:
//
//   `statsFinalizeRun`  — the record is born (revision 1).
//   `statsEnrichTokens` — the transcript fold lands its tokens (revision 2).
//
// Placing it inside those two functions rather than at their call sites is
// deliberate: `commands/next.ts`'s terminal action, `commands/drive.ts`'s
// `enrichStats`, `lib/stats-backfill.ts`'s reconciliation pass and the
// `SubagentStop` stats relay all reach the record THROUGH them, so one seam
// covers every writer that exists and every writer added later.
//
// ── WHY A REVISION, AND WHY IT IS DERIVED FROM THE RECORD ───────────────────
//
// `applyRunStats` (`cloud/apps/api/src/modules/runs/store.ts`) is a COMPARE AND
// SWAP, not last-write-wins: `WHERE stats_revision IS NULL OR stats_revision <
// $incoming`. Ship both moments at the implicit revision 1 and the second is
// silently REFUSED — the run ends, but its tokens and cost never arrive. D13
// anticipates exactly this ("incremented each time the shipper re-ships a
// superseding record — late token enrichment").
//
// The counter is a pure function of the record's own completeness rather than
// a persisted ledger, and that is the safety property, not a shortcut: a
// re-ship of the SAME record always computes the SAME number, so an
// at-least-once replay is a no-op; and a STALE record can never out-rank a
// richer one, which a wall-clock or per-ship counter would let it do. The two
// levels are exhaustive because `tokens` goes `null → set` EXACTLY once —
// `rewriteRunTokens` only rewrites a line whose `tokens === null`, and
// `backfillProject` skips a record whose `tokens !== null`.
//
// ── D2 ─────────────────────────────────────────────────────────────────────
//
// LOCAL ONLY (an `existsSync`, a JSON read, one append) and NEVER throws. No
// network: the queued record is uploaded by the detached daemon, exactly like
// every other record. `03` F7's "absent, not merely inert" gate is the same
// one `telemetry-tail.ts` applies — telemetry off, or no `.pipeline/cloud.json`
// at all, and this function touches nothing beyond one `existsSync`.

import { existsSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { cloudJsonPath, readCloudBinding, realFs, type CloudFs } from './cloud-config';
import { telemetrySyncEnabled, TelemetryOutbox } from './telemetry-outbox';
import { resolveOutboxFingerprintSalt } from './fingerprint-salt';

/** `RunRecordStatsSchema.origin`'s `"local"` value (protocol D18) — a run that
 *  started on THIS machine, as opposed to the absent-default `"dispatched"`.
 *  Single source of truth: `telemetry-history.ts` re-exports it. */
export const RUN_RECORD_ORIGIN_LOCAL = 'local';

/** A record whose tokens have not been folded yet. */
export const REVISION_FINALIZED = 1;
/** The superseding snapshot carrying the transcript-folded tokens. */
export const REVISION_ENRICHED = 2;

/**
 * The `revision` (D13) a finished run record ships at — see this module's
 * header for why it is derived from the record rather than counted.
 *
 * A record finalized with explicit zero tokens (`llm_steps === 0`, `stats.ts`
 * §12) is already complete and correctly ships at {@link REVISION_ENRICHED} on
 * its first and only ship: no enrichment will ever come for it.
 */
export function runRecordRevision(record: Record<string, unknown>): number {
  return record.tokens === null || record.tokens === undefined
    ? REVISION_FINALIZED
    : REVISION_ENRICHED;
}

/** Injectable side effects — mirrors `telemetry-tail.ts`'s own deps object,
 *  and for the same reason: `resolveOutboxFingerprintSalt` (b18) must be able
 *  to locate the per-install salt file without a test writing into the
 *  developer's real config dir. Production callers pass nothing. */
export interface ShipRunRecordDeps {
  env: Record<string, string | undefined>;
  fs: CloudFs;
  platform: string;
  homedir: string;
}

export const realShipDeps: ShipRunRecordDeps = {
  env: process.env,
  fs: realFs,
  platform: process.platform,
  homedir: osHomedir(),
};

/**
 * Queue one finished run record for upload, tagged `origin: "local"` (D18) and
 * stamped with its {@link runRecordRevision}.
 *
 * Returns `true` when the record reached the queue. Every `false` is a
 * deliberate no-op — telemetry disabled, an unconnected project, an org-less
 * `cloud.json`, or the outbox's own counted refusal (bound reached, lock
 * contention, no `run_id`) — and NEVER an exception: D2 forbids telemetry from
 * affecting the run that triggered it, and this one is called from inside
 * `lib/stats.ts`, which the whole engine funnels through.
 */
export function shipFinishedRunRecord(
  projectRoot: string,
  record: Record<string, unknown>,
  deps: Partial<ShipRunRecordDeps> = {},
): boolean {
  const resolved: ShipRunRecordDeps = { ...realShipDeps, ...deps };
  try {
    if (!telemetrySyncEnabled(resolved.env)) return false;
    const bindingPath = cloudJsonPath(projectRoot);
    if (!existsSync(bindingPath)) return false;
    const binding = readCloudBinding(resolved.fs, bindingPath);
    const org = binding?.org?.trim();
    if (!org) return false;
    const outbox = new TelemetryOutbox({
      projectRoot,
      org,
      env: resolved.env,
      fingerprintSalt: resolveOutboxFingerprintSalt({
        fs: resolved.fs,
        platform: resolved.platform,
        env: resolved.env,
        homedir: resolved.homedir,
      }),
    });
    return (
      outbox.enqueueStats({
        ...record,
        origin: RUN_RECORD_ORIGIN_LOCAL,
        revision: runRecordRevision(record),
      }) !== null
    );
  } catch {
    /* best-effort — D2: telemetry never affects the run */
    return false;
  }
}
