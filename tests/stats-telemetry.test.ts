// stats-telemetry.test.ts — `pipeline stats telemetry [--drain] [--json]`
// (src/commands/stats.ts's `runStatsTelemetry`, ux-v2 b13, 08-user-workflows
// J6: "everything answered on one screen").
//
// Covers:
//   - all seven J6 questions, both human and --json shapes
//   - the drop count reads b9's ONE ledger (state.json), quarantine folded in
//     — never a second scan of quarantine.jsonl for the total
//   - --drain performs one real (mocked) flush and the report reflects the
//     post-drain state, including a persisted "Last error" on failure
//   - the F4 blocked-queue line when records are queued under a different org
//   - not-connected / disabled degrade honestly rather than crashing

import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFs } from '../src/lib/cloud-config';
import { telemetryDir, type OutboxRecord } from '../src/lib/telemetry-outbox';
import { OUTBOX_STATE_SCHEMA } from '../src/lib/telemetry-outbox';
import type { UploadFetch, UploadRequest } from '../src/lib/telemetry-upload';
import { telemetryDaemonLockPath } from '../src/commands/telemetry-daemon';
import { readLastFlush } from '../src/lib/telemetry-status';
import { runStatsTelemetry, type StatsTelemetryDeps } from '../src/commands/stats';

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
  const d = mkdtempSync(join(tmpdir(), 'st-tel-proj-'));
  created.push(d);
  return d;
}

function writeBinding(root: string, binding: Record<string, unknown>): void {
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  writeFileSync(join(root, '.pipeline', 'cloud.json'), JSON.stringify(binding), 'utf-8');
}

function writeStore(root: string, cred: Record<string, unknown>, server = 'https://api.example.test'): void {
  mkdirSync(join(root, 'cfg'), { recursive: true });
  writeFileSync(
    join(root, 'cfg', 'credentials.json'),
    JSON.stringify({ version: 1, servers: { [server]: cred } }),
    'utf-8',
  );
}

function boundAndCredentialed(root: string, org = 'acme', server = 'https://api.example.test'): void {
  writeBinding(root, { server, org, project: 'p', connected_at: 'x' });
  writeStore(root, { access_token: 'tok', token_type: 'bearer', org_slug: org }, server);
}

function plantInQueue(root: string, records: OutboxRecord[]): void {
  const dir = telemetryDir(root);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'outbox.jsonl'), records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf-8');
}

function rec(over: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    org: 'acme',
    run_id: 'run-a',
    seq: 1,
    kind: 'stats',
    payload: { ended_at: '2026-08-05T09:46:00.000Z' },
    ...over,
  };
}

function writeOutboxCounters(root: string, counters: Record<string, unknown>): void {
  const dir = telemetryDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      schema: OUTBOX_STATE_SCHEMA,
      cursor: null,
      seq: {},
      seq_order: [],
      counters: {
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
        ...counters,
      },
    }),
    'utf-8',
  );
}

function writeDaemonLock(root: string, pid: number, startedAt: string): void {
  const dir = telemetryDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(telemetryDaemonLockPath(root), JSON.stringify({ pid, started_at: startedAt }), 'utf-8');
}

/** `homedir` doubles as the project root, exactly like telemetry-daemon.test.ts's own helper. */
function baseDeps(root: string, overrides: Partial<StatsTelemetryDeps> = {}): { deps: StatsTelemetryDeps; out: () => string; err: () => string } {
  let outBuf = '';
  let errBuf = '';
  const deps: StatsTelemetryDeps = {
    cwd: root,
    env: { PIPELINE_CLOUD_HOME: join(root, 'cfg') },
    platform: 'linux',
    homedir: root,
    now: () => Date.now(),
    out: (s) => {
      outBuf += s;
    },
    err: (s) => {
      errBuf += s;
    },
    fs: realFs,
    ...overrides,
  };
  return { deps, out: () => outBuf, err: () => errBuf };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

describe('runStatsTelemetry — usage', () => {
  test('unknown flag -> exit 2, usage on stderr', async () => {
    const root = mkProject();
    const { deps, err } = baseDeps(root);
    const code = await runStatsTelemetry(['--bogus'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('usage: pipeline stats telemetry');
  });
});

// ---------------------------------------------------------------------------
// The seven questions — human rendering
// ---------------------------------------------------------------------------

describe('runStatsTelemetry — the seven J6 questions on one screen', () => {
  test('not connected: honest, no crash, exit 0', async () => {
    const root = mkProject();
    const { deps, out } = baseDeps(root);
    const code = await runStatsTelemetry([], deps);
    expect(code).toBe(0);
    const text = out();
    expect(text).toContain('Telemetry  on');
    expect(text).toContain('not connected');
    expect(text).toContain('Dashboard  —');
  });

  test('PIPELINE_SYNC_LOCAL_STATS=0 -> "off", still one screen, exit 0', async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    const { deps, out } = baseDeps(root, { env: { PIPELINE_CLOUD_HOME: join(root, 'cfg'), PIPELINE_SYNC_LOCAL_STATS: '0' } });
    const code = await runStatsTelemetry([], deps);
    expect(code).toBe(0);
    expect(out()).toContain('Telemetry  off');
  });

  test('connected, queue + drop counters + a live daemon lock -> all seven answered', async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    plantInQueue(root, [rec({ run_id: 'run-a', seq: 1 }), rec({ run_id: 'run-b', seq: 1 })]);
    writeOutboxCounters(root, { dropped_bound: 2, dropped_malformed: 1, quarantined: 3, quarantine_depth: 1 });
    writeDaemonLock(root, process.pid, new Date().toISOString());

    const { deps, out } = baseDeps(root);
    const code = await runStatsTelemetry([], deps);
    expect(code).toBe(0);
    const text = out();

    // Q1 on/off
    expect(text).toContain('Telemetry  on');
    // Q2 account
    expect(text).toContain('Account    acme @ api.example.test');
    // Q3 streaming state — a real, live pid (this test process itself)
    expect(text).toContain('active — uploading');
    expect(text).toContain(String(process.pid));
    // Q4 queue depth — 2 distinct runs
    expect(text).toContain('2 runs');
    // Q5 drop count — read from the ONE ledger: 2 + 1 + 3 = 6 (quarantine folded in)
    expect(text).toContain('Dropped    6');
    // Q6 last error — none recorded yet in this scenario
    expect(text).toContain('Last error none');
    // Q7 where to look
    expect(text).toContain('Dashboard  https://api.example.test/acme/runs');
  });

  test('the drop count is the SAME whether read via the human or --json rendering (one ledger, not two)', async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    writeOutboxCounters(root, { dropped_bound: 4, quarantined: 5 });
    const { deps, out: humanOut } = baseDeps(root);
    await runStatsTelemetry([], deps);
    expect(humanOut()).toContain('Dropped    9');

    const { deps: jsonDeps, out: jsonOut } = baseDeps(root);
    await runStatsTelemetry(['--json'], jsonDeps);
    const report = JSON.parse(jsonOut());
    expect(report.dropped.total).toBe(9);
    expect(report.dropped.bound).toBe(4);
    expect(report.dropped.quarantined).toBe(5);
  });

  test('F4: records queued under a different org surface as a blocked line', async () => {
    const root = mkProject();
    boundAndCredentialed(root, 'acme');
    plantInQueue(root, [rec({ org: 'other-org', run_id: 'run-x' })]);
    const { deps, out } = baseDeps(root);
    await runStatsTelemetry([], deps);
    expect(out()).toContain('1 record queued under a different org');
  });
});

// ---------------------------------------------------------------------------
// --json shape
// ---------------------------------------------------------------------------

describe('runStatsTelemetry --json', () => {
  test('emits the same fields machine-readably', async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    plantInQueue(root, [rec()]);
    const { deps, out } = baseDeps(root);
    const code = await runStatsTelemetry(['--json'], deps);
    expect(code).toBe(0);
    const report = JSON.parse(out());
    expect(report.enabled).toBe(true);
    expect(report.connected).toBe(true);
    expect(report.org).toBe('acme');
    expect(report.server).toBe('https://api.example.test');
    expect(report.streaming).toEqual({ active: false, pid: null });
    expect(report.queue.sendable).toBe(1);
    expect(report.queue.sendable_runs).toBe(1);
    expect(typeof report.dropped.total).toBe('number');
    expect(report.dashboard_url).toBe('https://api.example.test/acme/runs');
  });
});

// ---------------------------------------------------------------------------
// --drain
// ---------------------------------------------------------------------------

describe('runStatsTelemetry --drain', () => {
  test('a successful drain empties the queue and the re-read report shows it', async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    plantInQueue(root, [rec({ run_id: 'run-a' }), rec({ run_id: 'run-b' })]);

    const requests: UploadRequest[] = [];
    const fetchImpl: UploadFetch = async (req) => {
      requests.push(req);
      return { status: 200 };
    };
    const { deps, out } = baseDeps(root, { fetch: fetchImpl });
    const code = await runStatsTelemetry(['--drain', '--json'], deps);
    expect(code).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    const report = JSON.parse(out());
    expect(report.queue.sendable).toBe(0);
  });

  test('a failing drain persists a "Last error" the NEXT (undrained) status call can read', async () => {
    const root = mkProject();
    boundAndCredentialed(root);
    plantInQueue(root, [rec({ run_id: 'run-a' })]);

    const failing: UploadFetch = async () => ({ status: 503 });
    const { deps: drainDeps } = baseDeps(root, { fetch: failing });
    await runStatsTelemetry(['--drain'], drainDeps);

    // The failure is durable — a later, undrained status call sees it too.
    const last = readLastFlush(root);
    expect(last).not.toBeNull();
    expect(last!.status).toBe(503);

    const { deps: readDeps, out } = baseDeps(root);
    await runStatsTelemetry([], readDeps);
    expect(out()).toContain('Last error');
    expect(out()).toContain('HTTP 503');
  });

  test('--drain with no cloud binding is a safe no-op (F7), still exit 0', async () => {
    const root = mkProject();
    const { deps } = baseDeps(root);
    const code = await runStatsTelemetry(['--drain'], deps);
    expect(code).toBe(0);
  });
});
