// `pipeline stats [--project <path>] [--json]`
// `pipeline stats backfill [--project <path>] [--json]`
// `pipeline stats telemetry [--drain] [--json]`
//
// View (and regenerate) the per-run measurement files the stats system writes
// under `<project>/.pipeline/.stats/` (see lib/stats.ts — pure
// software, PIPELINE_STATS_ENABLED gated, default ON). The base command:
//   1. regenerates SUMMARY.md from every recorded run (so it is always
//      current even if a best-effort render was missed), then
//   2. prints it (or, with --json, prints every run record as a JSON array).
// The `backfill` verb (T5, gated by PIPELINE_STATS_ENABLED like every other
// trigger) runs the shared reconciliation core (lib/stats-backfill.ts) over
// the project's whole `.stats/` tree and prints the resulting BackfillReport
// — useful after a missed hook (crash, plugin disabled at the time) or a
// pruned-transcript pass that has since gained a snapshot.
// The `telemetry` verb (ux-v2 `b13`, `08` J6: "everything answered on one
// screen") answers seven questions about the b9/b10/b11 telemetry subsystem
// without a second command: on/off, account, streaming state, queue depth,
// drop count, last error, and where to look (the dashboard URL). `--drain`
// additionally attempts ONE bounded flush right now — see `runStatsTelemetry`
// below for why that inline network call is safe here, same reasoning as
// `commands/cloud.ts`'s own history-backfill flush.
// Read-only apart from the SUMMARY.md regeneration / backfill's writes /
// `--drain`'s send-and-remove.
// Exit 0; 2 on usage.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { findRunsFiles, parseRunRecords, renderSummary, statsEnabled } from '../lib/stats';
import { backfillProject } from '../lib/stats-backfill';
import { cloudJsonPath, readCloudBinding, realFs, type CloudFs } from '../lib/cloud-config';
import { appOriginFor } from '../lib/department-serve';
import { telemetrySyncEnabled, TelemetryOutbox } from '../lib/telemetry-outbox';
import { resolveOutboxFingerprintSalt } from '../lib/fingerprint-salt';
import {
  realUploadFetch,
  resolveUploadTarget,
  TelemetryUploader,
  type UploadFetch,
} from '../lib/telemetry-upload';
import type { FetchLike } from '../lib/credential-refresh';
import { daemonStatus, telemetryDaemonLockPath } from './telemetry-daemon';
import {
  recordLastFlush,
  recordTimestampIso,
  readLastFlush,
  renderTelemetryStatus,
  totalDropped,
  type TelemetryStatusReport,
} from '../lib/telemetry-status';

const USAGE =
  'usage: pipeline stats [--project <path>] [--json]\n' +
  '       pipeline stats backfill [--project <path>] [--json]\n' +
  '       pipeline stats telemetry [--drain] [--json]\n';

function parseFlags(args: string[]): { project: string | null; json: boolean } | number {
  let project: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--project') {
      const v = args[i + 1];
      if (!v) {
        process.stderr.write(`pipeline stats: --project requires a value\n${USAGE}`);
        return 2;
      }
      project = v;
      i++;
    } else if (a === '--json') {
      json = true;
    } else {
      process.stderr.write(`pipeline stats: unknown option '${a}'\n${USAGE}`);
      return 2;
    }
  }
  return { project, json };
}

function runBackfill(args: string[]): number {
  const parsed = parseFlags(args);
  if (typeof parsed === 'number') return parsed;
  const { project, json } = parsed;
  const root = resolve(project ?? process.cwd());

  if (!statsEnabled()) {
    process.stdout.write('stats are DISABLED via PIPELINE_STATS_ENABLED — unset it to measure runs\n');
    return 0;
  }

  const report = backfillProject(root);
  if (json) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return 0;
  }
  process.stdout.write(
    `backfill: scanned ${report.scanned} · enriched ${report.enriched.length} · ` +
      `already-enriched ${report.skipped_enriched} · out-of-window ${report.skipped_window} · ` +
      `pruned ${report.transcript_pruned.length} · zero-fold ${report.zero_fold.length}` +
      (report.errors.length ? ` · errors ${report.errors.length}` : '') +
      '\n',
  );
  if (report.enriched.length) process.stdout.write(`enriched run_ids: ${report.enriched.join(', ')}\n`);
  if (report.errors.length) process.stdout.write(`errors: ${report.errors.join('; ')}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// `pipeline stats telemetry` (ux-v2 b13)
// ---------------------------------------------------------------------------

/** Injected side effects, same shape/spirit as `commands/telemetry-daemon.ts`'s
 *  `TelemetryDaemonCliDeps` — `cwd` stands in for `--project` (the documented
 *  usage line is exactly `[--drain] [--json]`; a test points `cwd` at its own
 *  tmp project instead of adding an undocumented flag). Every field defaults
 *  to a real value in `realStatsTelemetryDeps`, so production callers never
 *  construct this themselves. */
export interface StatsTelemetryDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  platform: string;
  homedir: string;
  now: () => number;
  out: (s: string) => void;
  err: (s: string) => void;
  fs: CloudFs;
  /** `--drain`'s ingest POST transport. Defaults to the real, timeout-bounded
   *  transport; tests inject a scripted fake so no real network call happens. */
  fetch?: UploadFetch;
  /** `--drain`'s credential-refresh transport, used only when a stored
   *  credential is actually expiring. Left undefined by default. */
  refreshFetch?: FetchLike;
}

export const realStatsTelemetryDeps: StatsTelemetryDeps = {
  cwd: process.cwd(),
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  now: () => Date.now(),
  out: (s) => {
    process.stdout.write(s);
  },
  err: (s) => {
    process.stderr.write(s);
  },
  fs: realFs,
};

const TELEMETRY_USAGE =
  'usage: pipeline stats telemetry [--drain] [--json]\n' +
  '  Answers on one screen: on/off, account, streaming state, queue depth,\n' +
  '  drop count, last error, and where to look (08-user-workflows.md J6).\n' +
  '  --drain attempts one bounded flush of the queue right now.\n' +
  '  --json emits the same fields machine-readably.\n';

function parseTelemetryFlags(args: string[]): { drain: boolean; json: boolean } | { error: string } {
  let drain = false;
  let json = false;
  for (const a of args) {
    if (a === '--drain') drain = true;
    else if (a === '--json') json = true;
    else return { error: `unknown option '${a}'` };
  }
  return { drain, json };
}

/**
 * Assemble the seven-question report — pure reads, no network. Split out from
 * `runStatsTelemetry` so a `--drain` retry can re-read post-flush state with
 * the exact same logic that produced the pre-flush report.
 */
function buildTelemetryStatusReport(deps: StatsTelemetryDeps, projectRoot: string): TelemetryStatusReport {
  const enabled = telemetrySyncEnabled(deps.env);
  const binding = readCloudBinding(deps.fs, cloudJsonPath(projectRoot));
  const connected = binding !== null;
  const server = binding?.server ?? null;
  const org = binding?.org ?? null;
  const project = binding?.project ?? null;
  const dashboard_url = server && org ? `${appOriginFor(server)}/${org}/runs` : null;

  const streaming = daemonStatus(telemetryDaemonLockPath(projectRoot), deps.now());

  let queue: TelemetryStatusReport['queue'] = { sendable: 0, sendable_runs: 0, oldest_at: null, blocked: 0 };
  let dropped: TelemetryStatusReport['dropped'] = {
    total: 0,
    bound: 0,
    no_run_id: 0,
    malformed: 0,
    lock_contention: 0,
    quarantined: 0,
    quarantine_depth: 0,
    last_drop_at: null,
    last_drop_reason: null,
  };
  // Only meaningful once connected (F7: no account ⇒ nothing was ever
  // queued — `lib/telemetry-tail.ts` and every other entry point gate the
  // SAME way, so there is genuinely nothing to read here otherwise).
  if (connected && org) {
    const outbox = new TelemetryOutbox({
      projectRoot,
      org,
      env: deps.env,
      now: deps.now,
      // b18: the per-install salt (b15) — see fingerprint-salt.ts.
      fingerprintSalt: resolveOutboxFingerprintSalt({
        fs: deps.fs,
        platform: deps.platform,
        env: deps.env,
        homedir: deps.homedir,
      }),
    });
    const counters = outbox.counters();
    const { sendable, blocked } = outbox.takeBatch(Number.MAX_SAFE_INTEGER);
    const oldestRecord = sendable[0];
    queue = {
      sendable: sendable.length,
      sendable_runs: new Set(sendable.map((r) => r.run_id)).size,
      oldest_at: oldestRecord ? recordTimestampIso(oldestRecord) : null,
      blocked: blocked.length,
    };
    dropped = {
      total: totalDropped(counters),
      bound: counters.dropped_bound,
      no_run_id: counters.dropped_no_run_id,
      malformed: counters.dropped_malformed,
      lock_contention: counters.dropped_lock_contention,
      quarantined: counters.quarantined,
      quarantine_depth: counters.quarantine_depth,
      last_drop_at: counters.last_drop_at,
      last_drop_reason: counters.last_drop_reason,
    };
  }

  return {
    enabled,
    connected,
    server,
    org,
    project,
    dashboard_url,
    streaming,
    queue,
    dropped,
    last_error: readLastFlush(projectRoot),
  };
}

/**
 * `--drain`: attempt ONE bounded `flushOnce()` right now, same reasoning as
 * `commands/cloud.ts`'s `flushConnectHistory` for why an inline flush is safe
 * outside a run's critical path — this is an explicit, user-requested,
 * already-a-command action, not hidden cost on a hot path. Silent about
 * network specifics either way (`07` §4.6): the report re-read afterward is
 * the only thing printed, so a failed drain simply shows an unchanged queue
 * plus (if this attempt itself errored) a fresh "Last error" line.
 */
async function drainTelemetryQueue(deps: StatsTelemetryDeps, projectRoot: string): Promise<void> {
  try {
    const target = await resolveUploadTarget({
      cwd: projectRoot,
      platform: deps.platform,
      env: deps.env,
      homedir: deps.homedir,
      fs: deps.fs,
      now: deps.now,
      fetch: deps.refreshFetch,
    });
    if (!target) return; // F7: nothing to drain to — the report already says so
    const outbox = new TelemetryOutbox({
      projectRoot,
      org: target.org,
      env: deps.env,
      now: deps.now,
      // b18: the per-install salt (b15) — see fingerprint-salt.ts. Load-bearing
      // here too: flushOnce() reads `outbox.fingerprintSalt` back out to key
      // the wire-side re-filter (telemetry-upload.ts's `filterForWire`).
      fingerprintSalt: resolveOutboxFingerprintSalt({
        fs: deps.fs,
        platform: deps.platform,
        env: deps.env,
        homedir: deps.homedir,
      }),
    });
    const uploader = new TelemetryUploader({
      outbox,
      target,
      env: deps.env,
      now: deps.now,
      fetch: deps.fetch ?? realUploadFetch,
    });
    const result = await uploader.flushOnce();
    if (
      result.outcome === 'retry' ||
      result.outcome === 'quarantined' ||
      result.outcome === 'deadline' ||
      result.outcome === 'error'
    ) {
      recordLastFlush(projectRoot, result, deps.now());
    }
  } catch {
    /* D2 — the re-read below reports whatever state this left behind */
  }
}

export async function runStatsTelemetry(
  args: string[],
  deps: StatsTelemetryDeps = realStatsTelemetryDeps,
): Promise<number> {
  const parsed = parseTelemetryFlags(args);
  if ('error' in parsed) {
    deps.err(`pipeline stats telemetry: ${parsed.error}\n${TELEMETRY_USAGE}`);
    return 2;
  }
  const projectRoot = resolve(deps.cwd);
  if (parsed.drain) await drainTelemetryQueue(deps, projectRoot);

  const report = buildTelemetryStatusReport(deps, projectRoot);
  if (parsed.json) {
    deps.out(JSON.stringify(report) + '\n');
  } else {
    deps.out(renderTelemetryStatus(report, deps.now()));
  }
  return 0;
}

export async function runStats(args: string[]): Promise<number> {
  if (args[0] === 'backfill') return runBackfill(args.slice(1));
  if (args[0] === 'telemetry') return runStatsTelemetry(args.slice(1));

  const parsed = parseFlags(args);
  if (typeof parsed === 'number') return parsed;
  const { project, json } = parsed;

  const root = resolve(project ?? process.cwd());
  const base = join(root, '.pipeline', '.stats');
  if (!existsSync(base)) {
    process.stdout.write(
      `no measurements yet: ${base} does not exist` +
        (statsEnabled()
          ? ' (stats are ENABLED — it appears after the first pipeline run)\n'
          : ' (stats are DISABLED via PIPELINE_STATS_ENABLED — unset it to measure runs)\n'),
    );
    return 0;
  }

  renderSummary(base);

  if (json) {
    const records = findRunsFiles(base).flatMap((f) => (existsSync(f) ? parseRunRecords(readFileSync(f, 'utf8')) : []));
    process.stdout.write(JSON.stringify(records) + '\n');
    return 0;
  }
  const summary = join(base, 'SUMMARY.md');
  process.stdout.write(existsSync(summary) ? readFileSync(summary, 'utf8') : 'no SUMMARY.md rendered\n');
  return 0;
}
