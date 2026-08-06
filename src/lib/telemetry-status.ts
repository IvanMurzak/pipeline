// telemetry-status.ts — the read model behind `pipeline stats telemetry`
// (ux-v2 `b13`, `08` J6: "everything answered on one screen").
//
// WHAT THIS OWNS. Three things, each independently testable:
//
//   1. THE REPORT SHAPE (`TelemetryStatusReport`) — the seven questions J6
//      names (on/off, account, streaming state, queue depth, drop count, last
//      error, where to look) reduced to plain data. Assembly (reading
//      `cloud.json`, constructing a `TelemetryOutbox`, checking the daemon
//      lock) happens in `commands/stats.ts`, which alone is allowed to import
//      both this lib/ module AND `commands/telemetry-daemon.ts` — this file
//      stays lib/-only (no commands/ dependency, same rule
//      `credential-refresh.ts`/`department-notify.ts` document for every
//      other lib/ module in this package).
//   2. THE DROP COUNT — `totalDropped` sums `b9`'s OWN `state.json` counters.
//      No second ledger: `b10`'s header is explicit that quarantine "counted
//      into `b9`'s own `state.json`, not a parallel ledger", so reading that
//      one object (`TelemetryOutbox.counters()`) is the complete, honest
//      answer — never a separate scan of `quarantine.jsonl`'s line count for
//      the total (the per-file depth is still exposed as a diagnostic, not
//      folded into the total twice).
//   3. THE LAST-ERROR LEDGER (`recordLastFlush`/`readLastFlush`) — a NEW,
//      SMALL, single-purpose file (`<telemetry>/last-flush.json`), because no
//      existing state captures it: `b10`'s own header is explicit that
//      `UploadResponse`/`FlushResult` carry no body and the default `log`
//      sink is a no-op — nothing before `b13` ever persisted a flush's
//      outcome anywhere. This is not a second DROP ledger (drops stay in
//      `b9`'s `state.json`, per point 2); it is the FIRST ledger for "what did
//      the last real network attempt see", content-free by construction (a
//      status code + a fixed-shape outcome, matching `07` §4.6 — never a
//      response body, never a payload). The daemon (`commands/
//      telemetry-daemon.ts`) is the sole writer, on a real error/quarantine
//      outcome only; `pipeline stats telemetry` is the sole reader.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { telemetryDir, type OutboxCounters, type OutboxRecord } from './telemetry-outbox';
import type { FlushResult } from './telemetry-upload';

// ---------------------------------------------------------------------------
// The report shape
// ---------------------------------------------------------------------------

export interface TelemetryStatusReport {
  /** `PIPELINE_SYNC_LOCAL_STATS` — the master switch (`03` F1). */
  enabled: boolean;
  /** Whether `.pipeline/cloud.json` exists — F7: absent, not merely inert. */
  connected: boolean;
  server: string | null;
  org: string | null;
  project: string | null;
  /** `${appOriginFor(server)}/${org}/runs` — where the "look here" answer
   *  points. `null` when not connected. */
  dashboard_url: string | null;
  streaming: {
    /** The detached uploader daemon's lock names a live, non-stale pid. */
    active: boolean;
    pid: number | null;
  };
  queue: {
    /** Records queued under the CURRENT org, ready to send. */
    sendable: number;
    /** Distinct `run_id`s among `sendable` — J6's "2 runs", not "2 records". */
    sendable_runs: number;
    /** Best-effort ISO timestamp of the oldest sendable record's own payload
     *  (`ts` for an event, `ended_at` for a stats record) — `null` when the
     *  queue is empty or the oldest record carries neither field. */
    oldest_at: string | null;
    /** Records queued under a DIFFERENT org than the current credential (F4)
     *  — never sent, never deleted; released by reconnecting to that org. */
    blocked: number;
  };
  dropped: {
    /** bound + no_run_id + malformed + lock_contention + quarantined — the
     *  complete "left the send path and is not coming back on its own"
     *  count, read from `b9`'s one ledger (see this module's header).
     *  `excluded.not_applicable` is deliberately NOT summed in here (ux-v2
     *  `b20`) — an expected exclusion never left the send path, because it
     *  was never eligible to enter it. */
    total: number;
    bound: number;
    /** Genuinely unexpected as of `b20` — a documented exclusion such as
     *  `session.opened` no longer counts here, see `excluded.not_applicable`. */
    no_run_id: number;
    malformed: number;
    lock_contention: number;
    /** NOT lost — still on disk in `quarantine.jsonl` — but counted into
     *  `total` because from the user's vantage it never reached the
     *  dashboard on its own either. */
    quarantined: number;
    quarantine_depth: number;
    last_drop_at: string | null;
    last_drop_reason: string | null;
  };
  /** EXPECTED exclusions — records with no `run_id` whose event type is
   *  documented to legitimately lack one (`session.opened`, today). Not a
   *  drop, not summed into `dropped.total`, and never rendered in "dropped"
   *  vocabulary — surfaced here (and via `--json`) so the number is still
   *  answerable, just not in loss language (ux-v2 `b20`). */
  excluded: {
    not_applicable: number;
  };
  last_error: LastFlushRecord | null;
}

// ---------------------------------------------------------------------------
// Drop count — reads b9's ledger, invents nothing
// ---------------------------------------------------------------------------

/** Sums every counter that means "left the send path" — see this module's
 *  header, point 2. Pure; takes the counters object `TelemetryOutbox.counters()`
 *  already returns. */
export function totalDropped(counters: OutboxCounters): number {
  return (
    counters.dropped_bound +
    counters.dropped_no_run_id +
    counters.dropped_malformed +
    counters.dropped_lock_contention +
    counters.quarantined
  );
}

// ---------------------------------------------------------------------------
// Oldest-queued-record timestamp
// ---------------------------------------------------------------------------

/** Best-effort ISO timestamp carried BY the record's own payload — an event
 *  envelope's `ts`, or a finalized stats record's `ended_at`. `null` when
 *  neither is present (never fabricated — `08`'s "Never" list: "a `0` where
 *  the honest answer is `—`" extends to timestamps). */
export function recordTimestampIso(rec: OutboxRecord): string | null {
  const payload = rec.payload;
  const ts = payload?.ts;
  if (typeof ts === 'string' && ts) return ts;
  const endedAt = payload?.ended_at;
  if (typeof endedAt === 'string' && endedAt) return endedAt;
  return null;
}

// ---------------------------------------------------------------------------
// Relative-time formatting
// ---------------------------------------------------------------------------

/** `"14 min ago"` / `"3h ago"` / `"2d ago"` / `"just now"`. Never throws; an
 *  unparseable timestamp reads as `"unknown time ago"` rather than `NaN`. */
export function formatRelativeAgo(atMs: number, nowMs: number): string {
  if (!Number.isFinite(atMs)) return 'unknown time ago';
  const diffMs = Math.max(0, nowMs - atMs);
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Upload-status → human text
// ---------------------------------------------------------------------------

/**
 * A short, honest description of an HTTP status observed by the uploader.
 * DELIBERATELY not a literal OS/network error string ("connection refused"):
 * `telemetry-upload.ts`'s own header states the response body is "never
 * decoded, never stringified" and a network failure collapses to `status: 0`
 * by design (`07` §4.6 — no payload content in logs) — there is no captured
 * string to relay here, only the status the outcome rules already act on.
 */
export function describeUploadStatus(status: number): string {
  switch (status) {
    case 0:
      return 'could not reach the server';
    case 401:
      return 'HTTP 401 — credential expired or rotated';
    case 403:
      return 'HTTP 403 — not authorized for this org';
    case 408:
      return 'HTTP 408 — server timeout';
    case 425:
      return 'HTTP 425 — too early, retrying';
    case 429:
      return 'HTTP 429 — rate limited';
    default:
      if (status >= 500 && status < 600) return `HTTP ${status} — server error`;
      if (status >= 400 && status < 500) return `HTTP ${status} — rejected, quarantined`;
      return `HTTP ${status}`;
  }
}

// ---------------------------------------------------------------------------
// The last-flush ledger — see this module's header, point 3
// ---------------------------------------------------------------------------

export const LAST_FLUSH_SCHEMA = 1;
const LAST_FLUSH_FILE = 'last-flush.json';

export interface LastFlushRecord {
  schema: 1;
  /** Epoch ms this ledger entry was written. */
  at: number;
  outcome: FlushResult['outcome'];
  /** The most recent HTTP status the triggering flush observed (0 = network
   *  error/timeout — same convention as `UploadResponse.status`). */
  status: number;
  requests: number;
  records_sent: number;
  records_quarantined: number;
}

/** `<project>/.pipeline/.runtime/telemetry/last-flush.json`. */
export function lastFlushPath(projectRoot: string): string {
  return join(telemetryDir(projectRoot), LAST_FLUSH_FILE);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf-8');
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

/**
 * Persist ONE flush's outcome — content-free by construction: a status code
 * and a fixed-shape outcome, nothing decoded from a response body, matching
 * `telemetry-upload.ts`'s own no-payload-in-logs invariant. Best-effort and
 * NEVER throws (D2): losing this write degrades `pipeline stats telemetry`'s
 * "Last error" line to stale/absent, never a daemon crash.
 *
 * Callers (only `commands/telemetry-daemon.ts`'s `pollProjectOnce`, today)
 * decide WHEN this is worth calling — this function does not gate on
 * `result.outcome` itself, so it stays a dumb, always-correct writer.
 */
export function recordLastFlush(projectRoot: string, result: FlushResult, now: number): void {
  try {
    const dir = telemetryDir(projectRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const status = result.statuses.length ? result.statuses[result.statuses.length - 1]! : 0;
    const rec: LastFlushRecord = {
      schema: LAST_FLUSH_SCHEMA,
      at: now,
      outcome: result.outcome,
      status,
      requests: result.requests,
      records_sent: result.records_sent,
      records_quarantined: result.records_quarantined,
    };
    writeJsonAtomic(lastFlushPath(projectRoot), rec);
  } catch {
    /* best-effort — never affect the daemon (D2) */
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read-only. Anything missing/corrupt/schema-mismatched reads as `null` —
 *  the permissive direction ("no known error" rather than a crash or a
 *  fabricated one). */
export function readLastFlush(projectRoot: string): LastFlushRecord | null {
  try {
    const path = lastFlushPath(projectRoot);
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (
      !isRecord(parsed) ||
      parsed.schema !== LAST_FLUSH_SCHEMA ||
      typeof parsed.at !== 'number' ||
      typeof parsed.outcome !== 'string' ||
      typeof parsed.status !== 'number'
    ) {
      return null;
    }
    return {
      schema: 1,
      at: parsed.at,
      outcome: parsed.outcome as FlushResult['outcome'],
      status: parsed.status,
      requests: typeof parsed.requests === 'number' ? parsed.requests : 0,
      records_sent: typeof parsed.records_sent === 'number' ? parsed.records_sent : 0,
      records_quarantined: typeof parsed.records_quarantined === 'number' ? parsed.records_quarantined : 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Human rendering — `08` J6's exact seven-line shape
// ---------------------------------------------------------------------------

function hostOnly(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

/** Fixed label column (11 chars) — the widest label, "Last error", is 10
 *  chars + 1 space; every shorter label pads out to the same width, which is
 *  what makes `08` J6's transcript line up. */
function line(label: string, value: string): string {
  return `${label.padEnd(11)}${value}`;
}

/** Render the one-screen answer `08` J6 asks for. Pure — takes the report
 *  and the clock sample used to compute every relative time in it, so the
 *  same report renders identically in a test as it does live. */
export function renderTelemetryStatus(report: TelemetryStatusReport, now: number): string {
  const L: string[] = [];
  L.push(line('Telemetry', report.enabled ? 'on' : 'off (PIPELINE_SYNC_LOCAL_STATS=0)'));
  L.push(
    line(
      'Account',
      report.connected && report.org && report.server
        ? `${report.org} @ ${hostOnly(report.server)}`
        : 'not connected — run `pipeline cloud connect`',
    ),
  );
  L.push(
    line(
      'Streaming',
      report.streaming.active
        ? `active — uploading (daemon pid ${report.streaming.pid})`
        : report.connected
          ? 'idle (no active run)'
          : 'idle (not connected)',
    ),
  );
  const oldest = report.queue.oldest_at ? Date.parse(report.queue.oldest_at) : null;
  L.push(
    line(
      'Queued',
      report.queue.sendable === 0
        ? '0'
        : `${report.queue.sendable_runs} run${report.queue.sendable_runs === 1 ? '' : 's'}` +
          (oldest !== null ? ` (oldest ${formatRelativeAgo(oldest, now)})` : ''),
    ),
  );
  L.push(line('Dropped', String(report.dropped.total)));
  L.push(
    line(
      'Last error',
      report.last_error
        ? `${describeUploadStatus(report.last_error.status)} — ${formatRelativeAgo(report.last_error.at, now)}`
        : 'none',
    ),
  );
  L.push(line('Dashboard', report.dashboard_url ?? '—'));
  if (report.queue.blocked > 0) {
    L.push('');
    L.push(
      `${report.queue.blocked} record${report.queue.blocked === 1 ? '' : 's'} queued under a different org — reconnect to that org to release ${
        report.queue.blocked === 1 ? 'it' : 'them'
      } (F4)`,
    );
  }
  if (report.queue.sendable > 0) {
    L.push('');
    L.push('Retry now: pipeline stats telemetry --drain');
  }
  return L.join('\n') + '\n';
}
