// telemetry-status.test.ts — the read model behind `pipeline stats telemetry`
// (src/lib/telemetry-status.ts, ux-v2 b13).
//
// Covers, independent of any CLI wiring:
//   - totalDropped reads b9's OWN counters object (no second ledger)
//   - recordTimestampIso's event-ts / stats-ended_at preference, and its
//     honest `null` when neither is present
//   - formatRelativeAgo / describeUploadStatus's text
//   - the last-flush ledger round-trips (write -> read), and degrades to
//     `null` on anything missing/corrupt
//   - renderTelemetryStatus reproduces 08 J6's exact seven-line shape

import { describe, expect, test, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeUploadStatus,
  formatRelativeAgo,
  lastFlushPath,
  readLastFlush,
  recordLastFlush,
  recordTimestampIso,
  renderTelemetryStatus,
  totalDropped,
  type TelemetryStatusReport,
} from '../src/lib/telemetry-status';
import type { OutboxCounters, OutboxRecord } from '../src/lib/telemetry-outbox';
import type { FlushResult } from '../src/lib/telemetry-upload';

const created: string[] = [];
afterAll(() => {
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function mkProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'ts-status-'));
  created.push(d);
  return d;
}

function counters(over: Partial<OutboxCounters> = {}): OutboxCounters {
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
    ...over,
  };
}

// ---------------------------------------------------------------------------
// totalDropped — reads b9's ledger, no second count
// ---------------------------------------------------------------------------

describe('totalDropped', () => {
  test('sums every "left the send path" counter, quarantine included', () => {
    const c = counters({ dropped_bound: 3, dropped_no_run_id: 1, dropped_malformed: 2, dropped_lock_contention: 1, quarantined: 4 });
    expect(totalDropped(c)).toBe(11);
  });
  test('all zero -> 0', () => {
    expect(totalDropped(counters())).toBe(0);
  });
  test('quarantine_depth is NOT summed (it is a snapshot depth, not an event count)', () => {
    const c = counters({ quarantined: 2, quarantine_depth: 999 });
    expect(totalDropped(c)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// recordTimestampIso
// ---------------------------------------------------------------------------

describe('recordTimestampIso', () => {
  const base: OutboxRecord = { org: 'acme', run_id: 'r1', seq: 1, kind: 'event', payload: {} };
  test('prefers payload.ts for an event record', () => {
    const rec = { ...base, payload: { ts: '2026-08-05T10:00:00.000Z' } };
    expect(recordTimestampIso(rec)).toBe('2026-08-05T10:00:00.000Z');
  });
  test('falls back to payload.ended_at for a stats record', () => {
    const rec = { ...base, kind: 'stats' as const, payload: { ended_at: '2026-08-05T09:00:00.000Z' } };
    expect(recordTimestampIso(rec)).toBe('2026-08-05T09:00:00.000Z');
  });
  test('neither present -> null, never fabricated (08 "Never" list)', () => {
    expect(recordTimestampIso({ ...base, payload: {} })).toBeNull();
    expect(recordTimestampIso({ ...base, payload: { ts: 123 } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatRelativeAgo / describeUploadStatus
// ---------------------------------------------------------------------------

describe('formatRelativeAgo', () => {
  test('minutes, hours, days, and "just now"', () => {
    const now = 1_700_000_000_000;
    expect(formatRelativeAgo(now, now)).toBe('just now');
    expect(formatRelativeAgo(now - 14 * 60_000, now)).toBe('14 min ago');
    expect(formatRelativeAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelativeAgo(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
  test('unparseable -> "unknown time ago", never NaN', () => {
    expect(formatRelativeAgo(NaN, Date.now())).toBe('unknown time ago');
  });
});

describe('describeUploadStatus', () => {
  test('0 -> network-shaped text, no fabricated OS error string', () => {
    expect(describeUploadStatus(0)).toBe('could not reach the server');
  });
  test('the five KEEP-not-quarantine statuses each get distinct, honest text', () => {
    expect(describeUploadStatus(401)).toContain('401');
    expect(describeUploadStatus(403)).toContain('403');
    expect(describeUploadStatus(408)).toContain('408');
    expect(describeUploadStatus(425)).toContain('425');
    expect(describeUploadStatus(429)).toContain('429');
  });
  test('5xx and other 4xx fall back to a generic-but-honest bucket', () => {
    expect(describeUploadStatus(503)).toContain('503');
    expect(describeUploadStatus(422)).toContain('422');
  });
});

// ---------------------------------------------------------------------------
// The last-flush ledger — write/read round trip, single-purpose, content-free
// ---------------------------------------------------------------------------

describe('recordLastFlush / readLastFlush', () => {
  function flushResult(over: Partial<FlushResult> = {}): FlushResult {
    return {
      outcome: 'retry',
      requests: 1,
      records_sent: 0,
      records_kept: 3,
      records_quarantined: 0,
      records_refused_org: 0,
      statuses: [503],
      deadline_hit: false,
      duration_ms: 12,
      ...over,
    };
  }

  test('round-trips exactly what was recorded', () => {
    const root = mkProject();
    const now = 1_700_000_000_000;
    recordLastFlush(root, flushResult({ statuses: [500, 503], records_sent: 2, records_quarantined: 1 }), now);
    const read = readLastFlush(root);
    expect(read).not.toBeNull();
    expect(read!.at).toBe(now);
    expect(read!.outcome).toBe('retry');
    expect(read!.status).toBe(503); // last of the statuses array
    expect(read!.records_sent).toBe(2);
    expect(read!.records_quarantined).toBe(1);
    expect(existsSync(lastFlushPath(root))).toBe(true);
  });

  test('no statuses observed -> status 0 (network/timeout convention)', () => {
    const root = mkProject();
    recordLastFlush(root, flushResult({ statuses: [] }), Date.now());
    expect(readLastFlush(root)!.status).toBe(0);
  });

  test('content-free: the persisted file never carries a response body or payload — only counters/status', () => {
    const root = mkProject();
    recordLastFlush(root, flushResult(), Date.now());
    const raw = require('node:fs').readFileSync(lastFlushPath(root), 'utf-8');
    // The ONLY numbers/strings on disk are the fixed FlushResult-shaped
    // fields — no free-text field exists for a response body to hide in.
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed).sort()).toEqual(
      ['at', 'outcome', 'records_quarantined', 'records_sent', 'requests', 'schema', 'status'].sort(),
    );
  });

  test('missing file -> null, never throws', () => {
    const root = mkProject();
    expect(readLastFlush(root)).toBeNull();
  });

  test('corrupt file -> null, never throws', () => {
    const root = mkProject();
    const path = lastFlushPath(root);
    require('node:fs').mkdirSync(require('node:path').dirname(path), { recursive: true });
    writeFileSync(path, 'not json', 'utf-8');
    expect(readLastFlush(root)).toBeNull();
  });

  test('never throws even against an unwritable directory', () => {
    // recordLastFlush is best-effort (D2) — point it at a path that cannot
    // be created (a file standing where a directory is needed).
    const root = mkProject();
    const blocker = join(root, '.pipeline');
    writeFileSync(blocker, 'i am a file, not a directory', 'utf-8');
    expect(() => recordLastFlush(root, flushResult(), Date.now())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// renderTelemetryStatus — 08 J6's exact seven-line shape
// ---------------------------------------------------------------------------

function baseReport(over: Partial<TelemetryStatusReport> = {}): TelemetryStatusReport {
  return {
    enabled: true,
    connected: true,
    server: 'https://api.example.test',
    org: 'acme',
    project: 'my-project',
    dashboard_url: 'https://api.example.test/acme/runs',
    streaming: { active: false, pid: null },
    queue: { sendable: 0, sendable_runs: 0, oldest_at: null, blocked: 0 },
    dropped: {
      total: 0,
      bound: 0,
      no_run_id: 0,
      malformed: 0,
      lock_contention: 0,
      quarantined: 0,
      quarantine_depth: 0,
      last_drop_at: null,
      last_drop_reason: null,
    },
    last_error: null,
    ...over,
  };
}

describe('renderTelemetryStatus', () => {
  test('answers all seven J6 questions on one screen, in the documented label order', () => {
    const now = 1_700_000_000_000;
    const report = baseReport({
      streaming: { active: false, pid: null },
      queue: { sendable: 2, sendable_runs: 2, oldest_at: new Date(now - 14 * 60_000).toISOString(), blocked: 0 },
      dropped: { ...baseReport().dropped, total: 0 },
      last_error: { schema: 1, at: now - 14 * 60_000, outcome: 'retry', status: 0, requests: 1, records_sent: 0, records_quarantined: 0 },
    });
    const text = renderTelemetryStatus(report, now);
    const lines = text.split('\n');

    expect(lines[0]).toBe('Telemetry  on');
    expect(lines[1]).toBe('Account    acme @ api.example.test');
    expect(lines[2]).toBe('Streaming  idle (no active run)');
    expect(lines[3]).toBe('Queued     2 runs (oldest 14 min ago)');
    expect(lines[4]).toBe('Dropped    0');
    expect(lines[5]).toBe('Last error could not reach the server — 14 min ago');
    expect(lines[6]).toBe('Dashboard  https://api.example.test/acme/runs');
    // "Retry now" hint appears because the queue is non-empty.
    expect(text).toContain('Retry now: pipeline stats telemetry --drain');
  });

  test('off: the Telemetry line says so and no opt-out hint is implied by rendering alone', () => {
    const text = renderTelemetryStatus(baseReport({ enabled: false }), Date.now());
    expect(text.split('\n')[0]).toBe('Telemetry  off (PIPELINE_SYNC_LOCAL_STATS=0)');
  });

  test('not connected: Account/Streaming/Dashboard all say so honestly', () => {
    const text = renderTelemetryStatus(
      baseReport({ connected: false, server: null, org: null, project: null, dashboard_url: null }),
      Date.now(),
    );
    const lines = text.split('\n');
    expect(lines[1]).toContain('not connected');
    expect(lines[2]).toBe('Streaming  idle (not connected)');
    expect(lines[6]).toBe('Dashboard  —');
  });

  test('empty queue -> "0", no oldest/no retry hint', () => {
    const text = renderTelemetryStatus(baseReport(), Date.now());
    expect(text.split('\n')[3]).toBe('Queued     0');
    expect(text).not.toContain('Retry now');
  });

  test('no last error -> "none"', () => {
    const text = renderTelemetryStatus(baseReport(), Date.now());
    expect(text.split('\n')[5]).toBe('Last error none');
  });

  test('daemon active -> Streaming names the pid', () => {
    const text = renderTelemetryStatus(baseReport({ streaming: { active: true, pid: 4242 } }), Date.now());
    expect(text.split('\n')[2]).toContain('4242');
  });

  test('blocked records (F4) surface as an extra line, singular vs plural', () => {
    const one = renderTelemetryStatus(
      baseReport({ queue: { sendable: 0, sendable_runs: 0, oldest_at: null, blocked: 1 } }),
      Date.now(),
    );
    expect(one).toContain('1 record queued under a different org');
    const many = renderTelemetryStatus(
      baseReport({ queue: { sendable: 0, sendable_runs: 0, oldest_at: null, blocked: 3 } }),
      Date.now(),
    );
    expect(many).toContain('3 records queued under a different org');
  });

  test('dropped total renders whatever totalDropped computed, not re-derived', () => {
    const text = renderTelemetryStatus(baseReport({ dropped: { ...baseReport().dropped, total: 7 } }), Date.now());
    expect(text.split('\n')[4]).toBe('Dropped    7');
  });
});
