// stats-run-exit-ship.test.ts — ux-v2 `b21`: "a finished run must actually
// finish".
//
// WHAT THIS PROVES. A local run that ends must appear ENDED in the control
// plane, and it must get there WITHOUT anybody running `pipeline cloud
// connect` afterwards. Before `b21` two independent faults made that
// impossible, and fixing either alone was not enough:
//
//   FAULT 1 — the envelope omitted a REQUIRED field. `statsEnvelope`
//     (`lib/telemetry-upload.ts`) deliberately left `project_root` off the
//     `stats.run_record` envelope. `AnyEventEnvelope` (`@baizor/
//     pipeline-protocol`, `src/events/envelope.ts`) declares it
//     `z.string().min(1)` — REQUIRED — so `cloud/apps/api/src/modules/runs/
//     ingest.ts:523-524` `continue`d past the record: it was stored in
//     `events` and derived NOTHING. Production evidence (i1, 2026-08-07):
//     10 of 10 `stats.run_record` rows carried no `project_root` key at all,
//     while every `iteration.*`/`tool.called`/`turn.usage` row in the same
//     run carried `"project_root": "fp:d00eb2c5706c9640"`.
//
//   FAULT 2 — nothing on the RUN-EXIT path enqueued the record. `enqueueStats`
//     had exactly one caller: `cloud connect`'s history scan
//     (`commands/cloud.ts`). A run that ended and was never followed by a
//     `cloud connect` shipped nothing at all, so there was no record to derive
//     from in the first place.
//
// The tests below drive the REAL run-exit path — `statsFinalizeRun` /
// `statsEnrichTokensForRun`, the two functions `commands/next.ts`'s terminal
// action and `commands/drive.ts`'s `enrichStats` actually call — and then the
// REAL uploader, and assert on the bytes the HTTP layer is handed. No mock
// stands in for either half.
//
// NEGATIVE CONTROL. Every assertion here fails against the pre-`b21` tree:
// the enqueue assertions because the outbox stays empty, the envelope
// assertions because `project_root` is absent. See the PR body for the
// verbatim before/after output.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statsAppend, statsEnrichTokensForRun, statsFinalizeRun } from '../src/lib/stats';
import {
  TelemetryOutbox,
  telemetryDir,
  type OutboxRecord,
} from '../src/lib/telemetry-outbox';
import {
  TelemetryUploader,
  type UploadFetch,
  type UploadRequest,
  type UploadTarget,
} from '../src/lib/telemetry-upload';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

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

/** Pinned so BOTH sides — the run-exit ship (which resolves the salt from
 *  `process.env`, exactly as it does in production) and the uploader's own
 *  wire re-filter — key the same HMAC, and so no per-install salt file is
 *  ever written into the developer's real config dir. */
const TEST_SALT = 'test-salt-b21-run-exit';

const SAVED = {
  salt: process.env.PIPELINE_FINGERPRINT_SALT,
  stats: process.env.PIPELINE_STATS_ENABLED,
  sync: process.env.PIPELINE_SYNC_LOCAL_STATS,
  runner: process.env.PIPELINE_STATS_RUNNER,
};

beforeEach(() => {
  process.env.PIPELINE_FINGERPRINT_SALT = TEST_SALT;
  delete process.env.PIPELINE_STATS_ENABLED;
  delete process.env.PIPELINE_SYNC_LOCAL_STATS;
  process.env.PIPELINE_STATS_RUNNER = 'headless';
});

afterEach(() => {
  for (const [k, v] of Object.entries({
    PIPELINE_FINGERPRINT_SALT: SAVED.salt,
    PIPELINE_STATS_ENABLED: SAVED.stats,
    PIPELINE_SYNC_LOCAL_STATS: SAVED.sync,
    PIPELINE_STATS_RUNNER: SAVED.runner,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Project {
  /** `<tmp>/proj-xxxx` — where `.pipeline/cloud.json` lives. */
  root: string;
  /** `<root>/.pipeline/demo` — what `next.ts`/`drive.ts` pass as `root`. */
  pipelineRoot: string;
}

function mkProject(opts: { connected?: boolean } = {}): Project {
  const root = mkdtempSync(join(tmpdir(), 'b21-proj-'));
  created.push(root);
  const pipelineRoot = join(root, '.pipeline', 'demo');
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  mkdirSync(join(root, '.pipeline', '.runtime'), { recursive: true });
  if (opts.connected !== false) {
    writeFileSync(
      join(root, '.pipeline', 'cloud.json'),
      JSON.stringify({
        server: 'https://api.example.test',
        org: 'acme',
        project: 'demo',
        connected_at: '2026-08-07T00:00:00.000Z',
      }),
      'utf-8',
    );
  }
  return { root, pipelineRoot };
}

/**
 * Exactly what `commands/next.ts` buffers for a two-step run and then
 * finalizes on its terminal `done` action — `statsNoteAction` +
 * `statsNoteTerminal`, with no telemetry-aware code anywhere in the path.
 * This IS the run-exit path; nothing else is invoked and, critically, NO
 * `pipeline cloud connect` ever runs in this file.
 */
function runAndFinalize(p: Project, runId: string): void {
  statsAppend(p.pipelineRoot, runId, { k: 'run.started' });
  statsAppend(p.pipelineRoot, runId, {
    k: 'step.started',
    path: 'steps/01-prepare.md',
    step_id: '01-prepare',
    step_uuid: '019fdbdf-0000-7000-8000-00000000aa01',
    model: 'claude-sonnet-4-5',
    effort: null,
  });
  statsAppend(p.pipelineRoot, runId, {
    k: 'step.completed',
    path: 'steps/01-prepare.md',
    step_id: '01-prepare',
    outcome: 'completed',
  });
  statsFinalizeRun(p.pipelineRoot, runId, 'completed', null);
}

function outboxRecords(root: string): OutboxRecord[] {
  const file = join(telemetryDir(root), 'outbox.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as OutboxRecord);
}

const TARGET: UploadTarget = { server: 'https://api.example.test', org: 'acme', token: 'tok' };

function captureFetch(): { fetch: UploadFetch; requests: UploadRequest[] } {
  const requests: UploadRequest[] = [];
  return {
    requests,
    fetch: async (req) => {
      requests.push(req);
      return { status: 200 };
    },
  };
}

interface WireEvent {
  seq: number;
  payload: Record<string, unknown>;
}

/** Flush the project's queue through the REAL uploader and return the
 *  `stats.run_record` envelopes exactly as the HTTP layer would see them. */
async function shipAndReadWire(root: string): Promise<WireEvent[]> {
  const outbox = new TelemetryOutbox({
    projectRoot: root,
    org: 'acme',
    env: {},
    fingerprintSalt: TEST_SALT,
    onDrop: () => {},
  });
  const cap = captureFetch();
  await new TelemetryUploader({ outbox, target: TARGET, fetch: cap.fetch, env: {} }).flushOnce();
  return cap.requests
    .flatMap((r) => (JSON.parse(r.body) as { events: WireEvent[] }).events)
    .filter((e) => e.payload.type === 'stats.run_record');
}

/**
 * The base-envelope gate the control plane actually applies, transcribed from
 * `@baizor/pipeline-protocol` `src/events/envelope.ts` (`eventEnvelopeBaseShape`
 * at :49, `AnyEventEnvelope` at :96). The schema is TRANSCRIBED here rather
 * than imported. The original reason for that is now void: it was that this
 * package deliberately had NO dependencies, being executed straight out of a
 * git checkout with no install step (`01` §5) — the same reason the privacy
 * filter was vendored. plugin-thin `p9` deleted that checkout path and `k2`
 * made `@baizor/pipeline-protocol` a real dependency, so this transcription
 * COULD now become a real import of `AnyEventEnvelope`. It deliberately was
 * not changed in `k2`, whose swap was import-path-only for a byte-identical
 * file; converting a hand-transcribed gate into an imported one changes what
 * this test asserts and wants its own review. Until then, the transcription
 * below must be kept in step with the package by hand.
 *
 * `ingest.ts:523-524` does `AnyEventEnvelope.safeParse(payload)` and
 * `continue`s on failure, so ANY violation below means the record derives
 * nothing: no `ended_at`, no `outcome`, no `stats_*`.
 */
function envelopeGateViolations(payload: Record<string, unknown>): string[] {
  const bad: string[] = [];
  const nonEmptyString = (k: string): void => {
    if (typeof payload[k] !== 'string' || (payload[k] as string).length < 1) {
      bad.push(`${k}: expected a non-empty string, got ${JSON.stringify(payload[k])}`);
    }
  };
  const nullableString = (k: string): void => {
    if (payload[k] !== null && typeof payload[k] !== 'string') {
      bad.push(`${k}: expected string|null, got ${JSON.stringify(payload[k])}`);
    }
  };
  if (typeof payload.schema !== 'number' || !Number.isInteger(payload.schema) || payload.schema <= 0) {
    bad.push(`schema: expected a positive integer, got ${JSON.stringify(payload.schema)}`);
  }
  nonEmptyString('ts');
  if (typeof payload.ts === 'string' && Number.isNaN(Date.parse(payload.ts))) {
    bad.push(`ts: not an ISO-8601 datetime — ${JSON.stringify(payload.ts)}`);
  }
  // THE b21 FIELD. Required by the schema; omitted by the pre-b21 CLI.
  nonEmptyString('project_root');
  nullableString('worktree');
  nullableString('run_id');
  if (payload.run_id === null) bad.push('run_id: null is not shippable');
  nullableString('parent_run_id');
  nullableString('session_id');
  nonEmptyString('type');
  return bad;
}

// ---------------------------------------------------------------------------
// FAULT 2 — the run-exit path must enqueue the record
// ---------------------------------------------------------------------------

describe('b21 fault 2 — the RUN-EXIT path ships the record, with no `cloud connect`', () => {
  test('a finalized run leaves a stats record in the outbox', () => {
    const p = mkProject();
    const runId = '019fdbdf-822f-7006-8fae-200bec3ae07c';

    runAndFinalize(p, runId);

    const stats = outboxRecords(p.root).filter((r) => r.kind === 'stats');
    expect(stats.map((r) => `${r.kind} ${r.run_id} org=${r.org}`)).toEqual([
      `stats ${runId} org=acme`,
    ]);
    // D18: a run that started on THIS machine, not a cloud dispatch — absent
    // would default to "dispatched" server-side.
    expect((stats[0]!.payload as Record<string, unknown>).origin).toBe('local');
  });

  test('token enrichment re-ships a SUPERSEDING revision, so the tokens can land', () => {
    const p = mkProject();
    const runId = '019fdbdf-822f-7006-8fae-200bec3ae07d';

    runAndFinalize(p, runId);
    const finalized = outboxRecords(p.root).filter((r) => r.kind === 'stats');
    expect(finalized).toHaveLength(1);

    // `commands/drive.ts`'s `enrichStats(true)`, verbatim in shape.
    const enriched = statsEnrichTokensForRun(p.pipelineRoot, runId, {
      input: 1200,
      output: 340,
      cache_read: 90,
      cache_creation: 12,
      cost_usd: 0.0731,
      tools_called: 7,
      tools_failed: 1,
    });
    expect(enriched).toBe(true);

    const all = outboxRecords(p.root).filter((r) => r.kind === 'stats');
    expect(all).toHaveLength(2);

    const revisions = all.map((r) => (r.payload as Record<string, unknown>).revision);
    // `applyRunStats` (cloud store.ts) is a COMPARE AND SWAP: it applies only
    // when `incoming > stored`. Two records at the same (or absent ⇒ 1)
    // revision means the enriched one is REFUSED and the tokens never land.
    expect(revisions[1]).toBeGreaterThan(revisions[0] as number);

    const tokens = (all[1]!.payload as Record<string, unknown>).tokens as Record<string, unknown>;
    expect(tokens.input).toBe(1200);
    expect(tokens.cost_usd).toBe(0.0731);
  });

  test('F7 — an UNCONNECTED project ships nothing at all', () => {
    const p = mkProject({ connected: false });
    runAndFinalize(p, '019fdbdf-822f-7006-8fae-200bec3ae07e');
    expect(outboxRecords(p.root)).toEqual([]);
  });

  test('the opt-out is honoured on this path too', () => {
    process.env.PIPELINE_SYNC_LOCAL_STATS = '0';
    const p = mkProject();
    runAndFinalize(p, '019fdbdf-822f-7006-8fae-200bec3ae07f');
    expect(outboxRecords(p.root)).toEqual([]);
  });

  test('D2 — a hostile telemetry dir never breaks the run record itself', () => {
    const p = mkProject();
    // Make the outbox unwritable by planting a FILE where its directory goes.
    mkdirSync(join(p.root, '.pipeline', '.runtime'), { recursive: true });
    writeFileSync(join(p.root, '.pipeline', '.runtime', 'telemetry'), 'not a directory', 'utf-8');
    const runId = '019fdbdf-822f-7006-8fae-200bec3ae080';
    expect(() => runAndFinalize(p, runId)).not.toThrow();
    // The measurement itself is untouched — telemetry is a side effect.
    const runs = readFileSync(join(p.root, '.pipeline', '.stats', 'demo', 'runs.jsonl'), 'utf-8');
    expect(runs).toContain(runId);
  });
});

// ---------------------------------------------------------------------------
// FAULT 1 — the envelope must satisfy the contract the cloud parses it with
// ---------------------------------------------------------------------------

describe('b21 fault 1 — the shipped envelope passes `AnyEventEnvelope`', () => {
  // ISOLATED FROM FAULT 2 ON PURPOSE. This one plants the record straight into
  // `outbox.jsonl`, bypassing the enqueue path entirely, so it is red on a tree
  // where only fault 2 was fixed — the two faults are independent and each
  // needs its own control.
  test('a stats record ALREADY in the queue still ships a complete envelope', async () => {
    const p = mkProject();
    const runId = '019fdbdf-822f-7006-8fae-200bec3ae084';
    const dir = telemetryDir(p.root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'outbox.jsonl'),
      `${JSON.stringify({
        org: 'acme',
        run_id: runId,
        seq: 1,
        kind: 'stats',
        payload: {
          schema: 1,
          run_id: runId,
          pipeline: 'demo',
          started_at: '2026-08-07T00:00:00.000Z',
          ended_at: '2026-08-07T00:01:00.000Z',
          duration_s: 60,
          outcome: 'completed',
          halt_reason: null,
          runner: 'headless',
          mode: null,
          steps_run: 1,
          steps: [],
          improver_runs: 0,
          improver_applied: 0,
          scripts_created: 0,
          merges: 0,
          merge_conflicts: 0,
          tokens: null,
          origin: 'local',
        },
      })}\n`,
      'utf-8',
    );

    const wire = await shipAndReadWire(p.root);
    expect(wire).toHaveLength(1);
    expect(envelopeGateViolations(wire[0]!.payload)).toEqual([]);
    expect(wire[0]!.payload.project_root).toMatch(/^fp:[0-9a-f]{16}$/);
  });

  test('the wire bytes carry project_root, and the whole base envelope is valid', async () => {
    const p = mkProject();
    const runId = '019fdbdf-822f-7006-8fae-200bec3ae081';
    runAndFinalize(p, runId);

    const wire = await shipAndReadWire(p.root);
    expect(wire).toHaveLength(1);
    const payload = wire[0]!.payload;

    // This is the assertion `ingest.ts:523-524` makes before it will derive
    // anything at all. Reported as a list so a failure names the field.
    expect(envelopeGateViolations(payload)).toEqual([]);

    // SG4: on the wire `project_root` is a FINGERPRINT, never a machine path —
    // `vendor/privacy.ts`'s ENVELOPE_ALLOWLIST maps it to the `fingerprint`
    // rule, and `metadata` is the default tier.
    expect(payload.project_root).toMatch(/^fp:[0-9a-f]{16}$/);

    // and the record the control plane derives the terminal state from.
    const data = payload.data as Record<string, unknown>;
    expect(data.run_id).toBe(runId);
    expect(data.outcome).toBe('completed');
    expect(typeof data.ended_at).toBe('string');
    expect(data.origin).toBe('local');
  });

  test('the stats envelope and the run own events agree on the project fingerprint', async () => {
    const p = mkProject();
    const runId = '019fdbdf-822f-7006-8fae-200bec3ae082';

    // One ordinary journal event for the SAME run, through the SAME salt —
    // the `iteration.started` the production evidence shows carrying
    // "fp:d00eb2c5706c9640" beside a stats record that carried nothing.
    const outbox = new TelemetryOutbox({
      projectRoot: p.root,
      org: 'acme',
      env: {},
      fingerprintSalt: TEST_SALT,
      onDrop: () => {},
    });
    outbox.enqueueEvent({
      schema: 5,
      ts: '2026-08-07T00:00:00.000Z',
      type: 'iteration.started',
      project_root: p.root,
      worktree: null,
      run_id: runId,
      parent_run_id: null,
      session_id: 'sess-1',
      data: { index: 1, iteration_path: 'steps/01-prepare.md', step_name: '01-prepare' },
    });

    runAndFinalize(p, runId);

    const outboxRoot = new TelemetryOutbox({
      projectRoot: p.root,
      org: 'acme',
      env: {},
      fingerprintSalt: TEST_SALT,
      onDrop: () => {},
    });
    const cap = captureFetch();
    await new TelemetryUploader({ outbox: outboxRoot, target: TARGET, fetch: cap.fetch, env: {} }).flushOnce();
    const events = cap.requests.flatMap(
      (r) => (JSON.parse(r.body) as { events: WireEvent[] }).events,
    );
    const iteration = events.find((e) => e.payload.type === 'iteration.started')!;
    const stats = events.find((e) => e.payload.type === 'stats.run_record')!;
    expect(iteration).toBeDefined();
    expect(stats).toBeDefined();
    // ONE project, ONE fingerprint — the correlation the omission destroyed.
    expect(stats.payload.project_root).toBe(iteration.payload.project_root);
  });

  test('no raw machine path reaches the wire on the stats path (SG4)', async () => {
    const p = mkProject();
    runAndFinalize(p, '019fdbdf-822f-7006-8fae-200bec3ae083');
    const wire = await shipAndReadWire(p.root);
    expect(wire).toHaveLength(1); // never vacuous
    const bytes = JSON.stringify(wire);
    expect(bytes).not.toContain(p.root);
    expect(bytes).not.toContain(p.root.replace(/\\/g, '/'));
    expect(bytes).not.toContain(p.root.replace(/\\/g, '\\\\'));
  });
});
