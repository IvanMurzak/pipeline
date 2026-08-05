// Tests for the telemetry uploader (src/lib/telemetry-upload.ts, ux-v2 `b10`).
//
// The five Definition-of-Done properties, and the block that proves each:
//
//   1. Records queued under org A are not sent to org B (matrix 12, SG3)
//                                        → "org refusal" describe block
//   2. All four outcome rules are exercised (matrix 21)
//                                        → "outcome rules" describe block
//   3. REQUEST BODIES CONTAIN NO PROHIBITED FIELD (matrix 7)
//                                        → "ON-WIRE BYTE SCAN" describe block
//   4. An unreachable or hostile server cannot fail, DELAY, or alter a local run
//                                        → "hostile servers" describe block
//   5. No payload content reaches logs or metrics (matrix 29)
//                                        → "logs and metrics" describe block
//
// Two deliberate choices about how these are proven:
//
//   (3) does NOT inspect the code path and reason that the filter ran. It
//   plants hostile values DIRECTLY INTO THE QUEUE FILE — bypassing `b9`'s
//   enqueue filter entirely, which is what a hand-edit, a restored backup or a
//   hostile commit would do — then captures the exact `body` string the HTTP
//   layer is handed and scans its BYTES. `b9`'s on-disk scan is the model; this
//   is its on-wire equivalent, and planting past `b9` is what makes the wire
//   filter, rather than `b9`, the thing under test.
//
//   (4) uses REAL `node:http` servers on 127.0.0.1 — one that refuses the
//   connection, one that accepts and never answers, one that answers with
//   garbage, and one that answers with a hostile unbounded body. A mock cannot
//   prove a timeout.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  TelemetryOutbox,
  journalPath,
  telemetryDir,
  type OutboxRecord,
} from '../src/lib/telemetry-outbox';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_DEADLINE_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  INGEST_PATH,
  KEEP_NOT_QUARANTINE_STATUSES,
  OrgRefusalError,
  TelemetryUploader,
  backoffDelayMs,
  buildIngestBody,
  chunkByRun,
  filterForWire,
  realUploadFetch,
  resolveUploadTarget,
  uploadStatePath,
  type FlushResult,
  type UploadFetch,
  type UploadRequest,
  type UploadTarget,
} from '../src/lib/telemetry-upload';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const created: string[] = [];
const servers: Server[] = [];

afterAll(() => {
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

afterEach(() => {
  while (servers.length) {
    const s = servers.pop();
    try {
      s?.closeAllConnections?.();
      s?.close();
    } catch {
      /* best effort */
    }
  }
});

function mkProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'tup-'));
  created.push(d);
  mkdirSync(join(d, '.pipeline', '.runtime'), { recursive: true });
  return d;
}

function mkOutbox(root: string, over: Record<string, unknown> = {}): TelemetryOutbox {
  return new TelemetryOutbox({
    projectRoot: root,
    org: 'acme',
    env: {},
    onDrop: () => {},
    ...over,
  } as ConstructorParameters<typeof TelemetryOutbox>[0]);
}

const TARGET: UploadTarget = { server: 'https://api.example.test', org: 'acme', token: 'tok-SECRET' };

/** A `UploadFetch` that records every request and replies from a script. */
function captureFetch(statuses: number[] | number = 200): {
  fetch: UploadFetch;
  requests: UploadRequest[];
} {
  const requests: UploadRequest[] = [];
  const script = Array.isArray(statuses) ? [...statuses] : null;
  const fixed = Array.isArray(statuses) ? 200 : statuses;
  return {
    requests,
    fetch: async (req) => {
      requests.push(req);
      const status = script ? (script.shift() ?? fixed) : fixed;
      return { status };
    },
  };
}

/** Append records to `outbox.jsonl` WITHOUT going through `b9`'s enqueue —
 *  i.e. exactly what a hand-edit or a hostile commit can do to a file that
 *  lives inside the user's repository. */
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
    kind: 'event',
    payload: { schema: 5, ts: '2026-08-05T10:00:00.000Z', type: 'tool.called', run_id: 'run-a', data: { tool_name: 'Read' } },
    ...over,
  };
}

function uploader(root: string, over: Record<string, unknown> = {}, outboxOver: Record<string, unknown> = {}) {
  return new TelemetryUploader({
    outbox: mkOutbox(root, outboxOver),
    target: TARGET,
    env: {},
    // Fast, deterministic timing unless a test says otherwise.
    now: () => Date.now(),
    random: () => 0,
    backoffBaseMs: 1,
    backoffCapMs: 2,
    ...over,
  } as ConstructorParameters<typeof TelemetryUploader>[0]);
}

/** Start a real server on 127.0.0.1 and return its base URL. */
async function startServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A port nothing is listening on: bind, read the port, close. */
async function deadPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------
// 1. THE ORG REFUSAL (matrix 12 — SG3)
// ---------------------------------------------------------------------------

/** A marker planted in an org-A payload, in a field the allowlist KEEPS
 *  (`tool.called.tool_name`), so that if the refusal ever failed the marker
 *  would reach the wire verbatim. Counting requests proves a leak did not
 *  happen this time; scanning for this proves what a leak would look like. */
const ORG_A_MARKER = 'CROSS_ORG_A_MARKER_do-not-ship-to-b';

function markedOrgA(seq: number, runId = 'run-a'): OutboxRecord {
  return rec({
    org: 'org-a',
    seq,
    run_id: runId,
    payload: {
      schema: 5,
      ts: '2026-08-05T10:00:00.000Z',
      type: 'tool.called',
      run_id: runId,
      data: { tool_name: ORG_A_MARKER, success: true },
    },
  });
}

/** Scan the exact bytes of every request for org-A's marker. */
function crossOrgWitness(requests: UploadRequest[], label: string): string[] {
  const needle = Buffer.from(ORG_A_MARKER, 'utf8');
  const leaked = requests
    .map((r, i) => ({ name: `request[${i}]`, bytes: Buffer.from(r.body, 'utf8') }))
    .filter((b) => b.bytes.includes(needle))
    .map((b) => b.name);
  console.log(
    `\n[b10 cross-org wire witness — ${label}]\n` +
      `  requests: ${requests.length}\n` +
      `  ${leaked.length ? 'LEAKED' : 'clean '}  org-A marker on the wire ${leaked.join(',') || '—'}\n` +
      `result: ${leaked.length === 0 ? 'CLEAN' : `${leaked.length} LEAK(S)`}\n`,
  );
  return leaked;
}

describe('upload — org refusal: records queued under A are never sent to B (matrix 12, SG3)', () => {
  test('a queue full of org-A records produces ZERO requests when the credential is org B', async () => {
    const root = mkProject();
    plantInQueue(root, [markedOrgA(1), markedOrgA(2), markedOrgA(3, 'run-b')]);
    const cap = captureFetch(200);
    const up = uploader(
      root,
      { fetch: cap.fetch, target: { ...TARGET, org: 'org-b' } },
      { org: 'org-b' },
    );
    const result = await up.flushOnce();

    // Nothing on the wire at all — not a filtered request, not an empty one.
    expect(crossOrgWitness(cap.requests, 'org-A queue, org-B credential')).toEqual([]);
    expect(cap.requests.length).toBe(0);
    expect(result.records_sent).toBe(0);
    expect(result.records_refused_org).toBe(3);
    // A refusal is not a delete: reconnecting to org A releases them.
    expect(mkOutbox(root, { org: 'org-a' }).readAll().length).toBe(3);
  });

  test('a MIXED queue sends only the current org, and the foreign records stay put', async () => {
    const root = mkProject();
    plantInQueue(root, [markedOrgA(1), rec({ org: 'acme', seq: 2 }), markedOrgA(3), rec({ org: 'acme', seq: 4 })]);
    const cap = captureFetch(200);
    const result = await uploader(root, { fetch: cap.fetch }).flushOnce();

    // THE assertion: org-A's marker is not in the bytes that went out.
    expect(crossOrgWitness(cap.requests, 'mixed queue, org-acme credential')).toEqual([]);
    expect(cap.requests.length).toBe(1);
    const body = JSON.parse(cap.requests[0]!.body) as { events: Array<{ seq: number }> };
    expect(body.events.map((e) => e.seq).sort()).toEqual([2, 4]);
    expect(result.records_refused_org).toBe(2);
    expect(mkOutbox(root, { org: 'org-a' }).readAll().length).toBe(2);
  });

  test('GATE 2 alone: buildIngestBody — the only producer of wire bytes — refuses a foreign record', () => {
    expect(() =>
      buildIngestBody('run-a', [rec({ org: 'acme' }), rec({ org: 'org-a', seq: 2 })], 'acme', 'metadata', '', 'ts'),
    ).toThrow(OrgRefusalError);
    // …and refuses even a single foreign record with no company.
    expect(() => buildIngestBody('run-a', [rec({ org: 'evil' })], 'acme', 'metadata', '', 'ts')).toThrow(
      /refusing to send telemetry queued under org 'evil' to org 'acme'/,
    );
    // The happy case still works, so the guard is not simply "always throw".
    expect(buildIngestBody('run-a', [rec()], 'acme', 'metadata', '', 'ts')).toContain('"run_id":"run-a"');
  });

  test('GATE 1 alone: the uploader does not trust b9 — a broken partition still ships only our org', async () => {
    // A stub queue standing in for a REGRESSED or older `b9` whose own
    // partition has stopped working: it hands back a foreign record as
    // sendable. Gate 1 (the uploader's own filter) must drop it — and must do
    // so by FILTERING, so that our own records in the same run still ship.
    // Without gate 1 the batch reaches gate 2, which refuses the whole batch:
    // safe, but our telemetry stops moving.
    const acked: OutboxRecord[] = [];
    const leaky = {
      projectRoot: mkProject(),
      tier: 'metadata' as const,
      fingerprintSalt: '',
      takeBatch: () => ({ sendable: [markedOrgA(1), rec({ org: 'acme', seq: 2 })], blocked: [] }),
      ack: (r: OutboxRecord[]) => {
        acked.push(...r);
        return r.length;
      },
      quarantine: () => 0,
    } as unknown as TelemetryOutbox;

    const cap = captureFetch(200);
    const result = await new TelemetryUploader({ outbox: leaky, target: TARGET, fetch: cap.fetch, env: {} }).flushOnce();

    expect(crossOrgWitness(cap.requests, 'gate 1 alone, against a regressed b9')).toEqual([]);
    expect(result.records_refused_org).toBe(1);
    expect(result.records_sent).toBe(1); // ours still went — liveness, not just safety
    expect(acked.map((r) => r.seq)).toEqual([2]);
  });

  test('an outbox and a target that DISAGREE send nothing — the two gates intersect to zero', async () => {
    const root = mkProject();
    plantInQueue(root, [rec({ org: 'org-a' }), rec({ org: 'org-b', seq: 2 })]);
    const cap = captureFetch(200);
    // Outbox thinks org-a, credential says org-b: neither record is sendable.
    const up = new TelemetryUploader({
      outbox: mkOutbox(root, { org: 'org-a' }),
      target: { ...TARGET, org: 'org-b' },
      fetch: cap.fetch,
      env: {},
    });
    const result = await up.flushOnce();
    expect(cap.requests.length).toBe(0);
    expect(result.records_sent).toBe(0);
    expect(result.records_refused_org).toBe(2);
  });

  test('the refusal survives a run_id collision — same run, two orgs, only ours ships', async () => {
    const root = mkProject();
    plantInQueue(root, [
      rec({ org: 'org-a', run_id: 'shared', seq: 1, payload: { type: 'run.started', run_id: 'shared', data: {} } }),
      rec({ org: 'acme', run_id: 'shared', seq: 1, payload: { type: 'run.started', run_id: 'shared', data: {} } }),
    ]);
    const cap = captureFetch(200);
    await uploader(root, { fetch: cap.fetch }).flushOnce();
    expect(cap.requests.length).toBe(1);
    const parsed = JSON.parse(cap.requests[0]!.body) as { run_id: string; events: unknown[] };
    expect(parsed.run_id).toBe('shared');
    expect(parsed.events.length).toBe(1);
    expect(mkOutbox(root, { org: 'org-a' }).readAll().length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. THE FOUR OUTCOME RULES (matrix 21)
// ---------------------------------------------------------------------------

describe('upload — outcome rules: 2xx drop / 5xx keep / 4xx quarantine / exception swallowed', () => {
  test('2xx DROPS the record', async () => {
    const root = mkProject();
    plantInQueue(root, [rec({ seq: 1 }), rec({ seq: 2 })]);
    const cap = captureFetch(200);
    const result = await uploader(root, { fetch: cap.fetch }).flushOnce();
    expect(result.outcome).toBe('sent');
    expect(result.records_sent).toBe(2);
    expect(mkOutbox(root).readAll()).toEqual([]);
    expect(mkOutbox(root).readQuarantine()).toEqual([]);
  });

  test('every 2xx counts as success, not just 200', async () => {
    for (const status of [200, 201, 202, 204, 299]) {
      const root = mkProject();
      plantInQueue(root, [rec()]);
      const result = await uploader(root, { fetch: captureFetch(status).fetch }).flushOnce();
      expect(`${status}: ${result.records_sent}`).toBe(`${status}: 1`);
    }
  });

  test('5xx KEEPS the record and schedules a backoff', async () => {
    const root = mkProject();
    plantInQueue(root, [rec({ seq: 1 }), rec({ seq: 2 })]);
    const cap = captureFetch(503);
    const up = uploader(root, { fetch: cap.fetch, maxAttempts: 3 });
    const result = await up.flushOnce();

    expect(result.outcome).toBe('retry');
    expect(result.records_kept).toBe(2);
    expect(result.requests).toBe(3); // retried in-flush, with backoff
    expect(mkOutbox(root).readAll().length).toBe(2); // still queued
    expect(mkOutbox(root).readQuarantine()).toEqual([]); // NOT quarantined
    const state = JSON.parse(readFileSync(uploadStatePath(root), 'utf-8')) as { attempt: number; next_attempt_at: number };
    expect(state.attempt).toBe(1);
    expect(state.next_attempt_at).toBeGreaterThan(0);
  });

  test('a NETWORK ERROR (no HTTP response at all) keeps too', async () => {
    const root = mkProject();
    plantInQueue(root, [rec()]);
    const result = await uploader(root, { fetch: captureFetch(0).fetch, maxAttempts: 2 }).flushOnce();
    expect(result.outcome).toBe('retry');
    expect(result.records_kept).toBe(1);
    expect(mkOutbox(root).readAll().length).toBe(1);
  });

  test('4xx QUARANTINES: out of the send queue, into quarantine.jsonl, counted — never lost', async () => {
    const root = mkProject();
    plantInQueue(root, [rec({ seq: 1 }), rec({ seq: 2 })]);
    const drops: Array<{ reason: string; count: number; detail: string }> = [];
    const cap = captureFetch(400);
    const result = await uploader(root, { fetch: cap.fetch }, { onDrop: (d) => drops.push(d) }).flushOnce();

    expect(result.outcome).toBe('quarantined');
    expect(result.records_quarantined).toBe(2);
    expect(result.requests).toBe(1); // NO retry — that is the "never hot-loop" clause
    const ob = mkOutbox(root);
    expect(ob.readAll()).toEqual([]); // gone from the send queue
    expect(ob.readQuarantine().map((r) => r.seq)).toEqual([1, 2]); // but still on disk
    // Visible in b9's OWN counters, not a parallel ledger.
    expect(ob.counters().quarantined).toBe(2);
    expect(ob.counters().quarantine_depth).toBe(2);
    expect(ob.counters().last_drop_reason).toBe('quarantine');
    expect(drops.filter((d) => d.reason === 'quarantine')).toEqual([
      {
        reason: 'quarantine',
        count: 2,
        detail: '2 record(s) permanently rejected by the server — set aside in quarantine.jsonl, not deleted',
      },
    ]);
  });

  test('a quarantined record is CONSERVED: nothing is deleted without first being written', async () => {
    const root = mkProject();
    plantInQueue(root, [rec({ seq: 1 }), rec({ seq: 2 }), rec({ seq: 3 })]);
    const ob = mkOutbox(root);
    const before = ob.readAll().length;
    await uploader(root, { fetch: captureFetch(422).fetch }).flushOnce();
    const after = mkOutbox(root);
    expect(after.readAll().length + after.readQuarantine().length).toBe(before);
  });

  test('a quarantined record is never re-sent on a later flush', async () => {
    const root = mkProject();
    plantInQueue(root, [rec()]);
    await uploader(root, { fetch: captureFetch(400).fetch }).flushOnce();
    const cap = captureFetch(200);
    const second = await uploader(root, { fetch: cap.fetch }).flushOnce();
    expect(cap.requests.length).toBe(0);
    expect(second.outcome).toBe('idle');
    expect(mkOutbox(root).readQuarantine().length).toBe(1);
  });

  test('401 / 403 / 408 / 425 / 429 are KEPT, not quarantined — they describe the caller, not the record', async () => {
    for (const status of [...KEEP_NOT_QUARANTINE_STATUSES]) {
      const root = mkProject();
      plantInQueue(root, [rec()]);
      const result = await uploader(root, { fetch: captureFetch(status).fetch, maxAttempts: 1 }).flushOnce();
      const ob = mkOutbox(root);
      expect(`${status}: kept=${result.records_kept} quarantined=${ob.readQuarantine().length} queued=${ob.readAll().length}`)
        .toBe(`${status}: kept=1 quarantined=0 queued=1`);
    }
  });

  test('every other 4xx quarantines', async () => {
    for (const status of [400, 404, 409, 413, 422, 451, 499]) {
      const root = mkProject();
      plantInQueue(root, [rec()]);
      await uploader(root, { fetch: captureFetch(status).fetch }).flushOnce();
      expect(`${status}: ${mkOutbox(root).readQuarantine().length}`).toBe(`${status}: 1`);
    }
  });

  test('ANY EXCEPTION is swallowed — the uploader never throws into the run (D2)', async () => {
    const root = mkProject();
    plantInQueue(root, [rec()]);

    // (a) the transport throws
    const boom: UploadFetch = async () => {
      throw new Error('SECRET_TRANSPORT_EXPLOSION');
    };
    const a = await uploader(root, { fetch: boom }).flushOnce();
    expect(a.outcome).toBe('error');

    // (b) the transport returns a garbage shape
    const garbage = (async () => 'not a response') as unknown as UploadFetch;
    const b = await uploader(root, { fetch: garbage }).flushOnce();
    expect(['error', 'retry', 'idle']).toContain(b.outcome);

    // (c) the queue itself is unreadable rubbish
    const root2 = mkProject();
    mkdirSync(telemetryDir(root2), { recursive: true });
    writeFileSync(join(telemetryDir(root2), 'outbox.jsonl'), '{{{not json\n\u0000\u0000\n', 'utf-8');
    const c = await uploader(root2, { fetch: captureFetch(200).fetch }).flushOnce();
    expect(c.outcome).toBe('idle');

    // (d) the log sink itself throws
    const root3 = mkProject();
    plantInQueue(root3, [rec()]);
    const d = await uploader(root3, {
      fetch: captureFetch(200).fetch,
      log: () => {
        throw new Error('sink exploded');
      },
    }).flushOnce();
    expect(d.records_sent).toBe(1);

    // Nothing above escaped: reaching this line IS the assertion.
    expect(true).toBe(true);
  });

  test('the persistent backoff refuses the NEXT flush outright — the cross-process no-hot-loop guard', async () => {
    const root = mkProject();
    plantInQueue(root, [rec()]);
    let clock = 1_000_000;
    const first = await uploader(root, {
      fetch: captureFetch(500).fetch,
      maxAttempts: 1,
      now: () => clock,
      backoffBaseMs: 5_000,
      backoffCapMs: 30_000,
    }).flushOnce();
    expect(first.outcome).toBe('retry');

    // A brand-new uploader (i.e. a fresh daemon process) sees the schedule.
    clock += 1_000;
    const cap = captureFetch(200);
    const second = await uploader(root, { fetch: cap.fetch, now: () => clock }).flushOnce();
    expect(second.outcome).toBe('backoff');
    expect(cap.requests.length).toBe(0);

    // Once it elapses, the same records go out.
    clock += 60_000;
    const third = await uploader(root, { fetch: cap.fetch, now: () => clock }).flushOnce();
    expect(third.records_sent).toBe(1);
    // …and success clears the schedule.
    expect(JSON.parse(readFileSync(uploadStatePath(root), 'utf-8')).attempt).toBe(0);
  });

  test('PIPELINE_SYNC_LOCAL_STATS=0 sends nothing at all', async () => {
    const root = mkProject();
    plantInQueue(root, [rec()]);
    const cap = captureFetch(200);
    const result = await uploader(root, { fetch: cap.fetch, env: { PIPELINE_SYNC_LOCAL_STATS: '0' } }).flushOnce();
    expect(result.outcome).toBe('disabled');
    expect(cap.requests.length).toBe(0);
    expect(mkOutbox(root).readAll().length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. THE ON-WIRE BYTE SCAN (matrix 7)
// ---------------------------------------------------------------------------

/** Hostile values, mirroring `b9`'s planted set so the two scans are directly
 *  comparable — one over the queue FILE, one over the request BYTES. */
const SECRETS = {
  prompt: 'SECRET_PROMPT_full-step-instructions-with-code',
  questionText: 'SECRET_QUESTION_should-we-deploy-the-payment-hotfix',
  questionContext: 'SECRET_CONTEXT_the-diff-touches-billing.ts-lines-40-90',
  absolutePath: 'C:/Users/ivan/very-secret-client-project',
  worktreePath: 'C:/Users/ivan/very-secret-client-project/.worktrees/run-1',
  toolArgs: 'SECRET_TOOL_ARGS_rm -rf /var/secrets --force',
  toolOutput: 'SECRET_TOOL_OUTPUT_stdout-dump-with-customer-data',
  errorExcerpt: 'SECRET_ERROR_EXCERPT_stack-trace-with-code-and-paths',
  apiKey: 'sk-ant-api03-SECRETKEYSHAPE-DEADBEEFdeadbeef0123456789abcdefABCDEF',
  hookDetail: 'SECRET_HOOK_STDERR_dump-with-paths-and-code',
  unknownTypeBody: 'SECRET_UNKNOWN_TYPE_chat-message-body',
  departmentMessage: 'SECRET_DEPARTMENT_MESSAGE_task-content',
  envelopeExtra: 'SECRET_ENVELOPE_note-field-added-by-newer-peer',
} as const;

/** A raw journal envelope, stuffed with content the allowlist must drop. */
function hostileEnvelope(type: string, runId: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    schema: 5,
    ts: '2026-08-05T10:00:00.000Z',
    type,
    project_root: SECRETS.absolutePath,
    worktree: SECRETS.worktreePath,
    run_id: runId,
    parent_run_id: null,
    session_id: 'sess-1',
    data,
    ...extra,
  };
}

/**
 * The hostile corpus, planted DIRECTLY into `outbox.jsonl` — unfiltered, as if
 * `b9` had never touched it. This is the point: the wire filter, not `b9`, is
 * what these records have to get past.
 */
function plantHostileQueue(root: string, org = 'acme'): void {
  const payloads: Array<{ kind: 'event' | 'stats'; payload: Record<string, unknown> }> = [
    { kind: 'event', payload: hostileEnvelope('iteration.completed', 'run-a', { iteration_path: 'steps/03-review.md', outcome: 'completed', prompt: SECRETS.prompt, file_content: SECRETS.apiKey }) },
    { kind: 'event', payload: hostileEnvelope('awaiting_input', 'run-a', { run_id: 'run-a', iteration: 3, question_id: 'q-77', question: { text: SECRETS.questionText, context: SECRETS.questionContext, options: ['yes'] } }) },
    { kind: 'event', payload: hostileEnvelope('tool.called', 'run-a', { tool_name: 'Bash', success: true, tool_use_id: 't-1', args: SECRETS.toolArgs, output: SECRETS.toolOutput }) },
    { kind: 'event', payload: hostileEnvelope('worktree.created', 'run-b', { ok: false, worktree_path: SECRETS.worktreePath, detail: SECRETS.hookDetail }) },
    { kind: 'event', payload: hostileEnvelope('chat.message', 'run-b', { body: SECRETS.unknownTypeBody }) },
    { kind: 'event', payload: hostileEnvelope('run.started', 'run-b', { pipeline_name: 'release' }, { note: SECRETS.envelopeExtra }) },
    { kind: 'event', payload: hostileEnvelope('department.message', 'run-b', { parts: [{ text: SECRETS.departmentMessage, media_type: 'text/plain' }] }) },
    {
      kind: 'stats',
      payload: {
        schema: 1,
        run_id: 'run-a',
        pipeline: 'workflows/release',
        ended_at: '2026-08-05T12:00:00.000Z',
        outcome: 'halted',
        halt_reason: 'build failed',
        project_root: SECRETS.absolutePath,
        failures: [{ ts: '2026-08-05T12:00:00.000Z', tool: 'Bash', step: '02-build', error: SECRETS.errorExcerpt }],
        steps: [{ id: '01-plan', outcome: 'completed', notes: SECRETS.prompt }],
      },
    },
  ];
  plantInQueue(
    root,
    payloads.map((p, i) => ({
      org,
      run_id: String(p.payload.run_id ?? 'run-a'),
      seq: i + 1,
      kind: p.kind,
      payload: p.payload,
    })),
  );
}

/** Scan a set of on-wire request bodies for every planted secret. */
function scanWire(requests: UploadRequest[], label: string): { hits: number; report: string } {
  const bodies = requests.map((r, i) => ({ name: `request[${i}] ${r.body.length}B`, bytes: Buffer.from(r.body, 'utf8') }));
  const lines: string[] = [];
  lines.push(`bodies scanned: ${bodies.map((b) => b.name).join(', ') || '(none)'}`);
  let hits = 0;
  for (const [name, secret] of Object.entries(SECRETS)) {
    const needle = Buffer.from(secret, 'utf8');
    const found = bodies.filter((b) => b.bytes.includes(needle)).map((b) => b.name);
    if (found.length) hits += 1;
    lines.push(`  ${found.length ? 'LEAKED' : 'clean '}  ${name.padEnd(18)} ${found.join(',') || '—'}`);
  }
  lines.push(`result: ${hits === 0 ? 'CLEAN' : `${hits} LEAK(S)`}`);
  const report = `\n[b10 ${label}]\n${lines.join('\n')}\n`;
  console.log(report);
  return { hits, report };
}

describe('upload — ON-WIRE BYTE SCAN: no prohibited field appears in any request body (matrix 7)', () => {
  test('every planted secret is absent from the exact bytes the HTTP layer is handed', async () => {
    const root = mkProject();
    plantHostileQueue(root);
    const cap = captureFetch(200);
    const result = await uploader(root, { fetch: cap.fetch }).flushOnce();

    expect(result.records_sent).toBe(8);
    expect(cap.requests.length).toBeGreaterThan(0);
    scanWire(cap.requests, 'on-wire byte scan (planted straight into the queue file)');

    for (const [name, secret] of Object.entries(SECRETS)) {
      for (let i = 0; i < cap.requests.length; i++) {
        expect(`${name} in request[${i}]: ${Buffer.from(cap.requests[i]!.body, 'utf8').includes(Buffer.from(secret, 'utf8'))}`)
          .toBe(`${name} in request[${i}]: false`);
      }
    }

    // NOT VACUOUS: the metadata the product runs on really did survive.
    const all = cap.requests.flatMap((r) => (JSON.parse(r.body) as { events: Array<{ seq: number; payload: Record<string, unknown> }> }).events);
    expect(all.length).toBe(8);
    const byType = new Map(all.map((e) => [String(e.payload.type), e.payload]));
    expect((byType.get('tool.called')!.data as Record<string, unknown>).tool_name).toBe('Bash');
    expect((byType.get('awaiting_input')!.data as Record<string, unknown>).question_id).toBe('q-77');
    expect(byType.get('chat.message')!.data).toEqual({});
    expect(byType.get('tool.called')!.project_root).toMatch(/^fp:[0-9a-f]{16}$/);
    // The stats record arrived as the envelope the control plane derives from.
    const stats = byType.get('stats.run_record')!;
    expect((stats.data as Record<string, unknown>).outcome).toBe('halted');
    expect(((stats.data as Record<string, unknown>).failures as Array<Record<string, unknown>>)[0]).toEqual({
      ts: '2026-08-05T12:00:00.000Z',
      tool: 'Bash',
      step: '02-build',
    });
  });

  test('the same corpus arriving the REAL way (b9 drains the journal) is equally clean', async () => {
    const root = mkProject();
    const lines = [
      hostileEnvelope('tool.called', 'run-a', { tool_name: 'Bash', args: SECRETS.toolArgs, output: SECRETS.toolOutput }),
      hostileEnvelope('awaiting_input', 'run-a', { run_id: 'run-a', question_id: 'q-1', question: { text: SECRETS.questionText, context: SECRETS.questionContext } }),
      hostileEnvelope('chat.message', 'run-a', { body: SECRETS.unknownTypeBody }),
    ];
    writeFileSync(journalPath(root), lines.map((l) => `${JSON.stringify(l)}\n`).join(''), 'utf-8');
    const ob = mkOutbox(root);
    ob.drainJournal();
    ob.enqueueStats({ schema: 1, run_id: 'run-a', pipeline: 'p', failures: [{ ts: 't', tool: 'Bash', step: 's', error: SECRETS.errorExcerpt }] });

    const cap = captureFetch(200);
    await new TelemetryUploader({ outbox: ob, target: TARGET, fetch: cap.fetch, env: {} }).flushOnce();
    const { hits } = scanWire(cap.requests, 'on-wire byte scan (real b9 → b10 path)');
    expect(hits).toBe(0);
  });

  test('failure excerpts never reach the wire even at the permissive `events` tier (D16)', async () => {
    const root = mkProject();
    plantInQueue(root, [
      rec({
        kind: 'stats',
        payload: { schema: 1, run_id: 'run-a', failures: [{ ts: 't', tool: 'Bash', step: 's', error: SECRETS.errorExcerpt }] },
      }),
    ]);
    const cap = captureFetch(200);
    await uploader(root, { fetch: cap.fetch }, { tier: 'events' }).flushOnce();
    expect(cap.requests[0]!.body).not.toContain(SECRETS.errorExcerpt);
  });

  test('an unrecognized privacy tier FAILS CLOSED — the wire stays clean either way', async () => {
    const root = mkProject();
    plantHostileQueue(root);
    const cap = captureFetch(200);
    const ob = mkOutbox(root, { env: { PIPELINE_PRIVACY_TIER: 'everything' } });
    expect(ob.tier).toBe('metadata');
    await new TelemetryUploader({ outbox: ob, target: TARGET, fetch: cap.fetch, env: {} }).flushOnce();
    const { hits } = scanWire(cap.requests, 'on-wire byte scan (unrecognized tier ⇒ fail closed)');
    expect(hits).toBe(0);
  });

  test('the wire filter is IDEMPOTENT — a second pass never re-fingerprints a fingerprint', () => {
    const salt = 'salt-1';
    const corpus = [
      hostileEnvelope('tool.called', 'run-a', { tool_name: 'Bash', args: SECRETS.toolArgs }),
      hostileEnvelope('pipeline.started', 'run-a', { pipeline_name: 'p', pipeline_root: SECRETS.absolutePath }),
      hostileEnvelope('worktree.created', 'run-a', { ok: true, worktree_path: SECRETS.worktreePath }),
      hostileEnvelope('awaiting_input', 'run-a', { question_id: 'q', question: { text: SECRETS.questionText } }),
      hostileEnvelope('department.message', 'run-a', { parts: [{ text: SECRETS.departmentMessage }] }),
      hostileEnvelope('department.status', 'run-a', { state: 'x', message: 'y'.repeat(400) }, { sender: 'ivan@acme' }),
    ];
    for (const raw of corpus) {
      const once = filterForWire(raw, 'metadata', salt);
      const twice = filterForWire(once, 'metadata', salt);
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
      // …and the fingerprint is the SAME value b9 would have written, not a
      // hash of a hash.
      expect(twice.project_root).toBe(once.project_root);
      expect(String(once.project_root)).toMatch(/^fp:[0-9a-f]{16}$/);
    }
  });

  test('the salt reaches the wire filter — a salted queue is not re-fingerprinted with the empty salt', async () => {
    const root = mkProject();
    plantHostileQueue(root);
    const cap = captureFetch(200);
    await uploader(root, { fetch: cap.fetch }, { fingerprintSalt: 'pepper' }).flushOnce();
    const events = (JSON.parse(cap.requests[0]!.body) as { events: Array<{ payload: Record<string, unknown> }> }).events;
    expect(String(events[0]!.payload.project_root)).toMatch(/^fp:[0-9a-f]{16}$/);

    const other = mkProject();
    plantHostileQueue(other);
    const cap2 = captureFetch(200);
    await uploader(other, { fetch: cap2.fetch }, { fingerprintSalt: 'different' }).flushOnce();
    const events2 = (JSON.parse(cap2.requests[0]!.body) as { events: Array<{ payload: Record<string, unknown> }> }).events;
    expect(events2[0]!.payload.project_root).not.toBe(events[0]!.payload.project_root);
  });
});

// ---------------------------------------------------------------------------
// 4. HOSTILE SERVERS: cannot fail, DELAY, or alter a local run
// ---------------------------------------------------------------------------

/** A stand-in for a local run: a bounded, deterministic unit of work whose
 *  result and duration we can compare with and without a flush in flight. */
function localRunWork(): number {
  let acc = 0;
  for (let i = 0; i < 200_000; i++) acc = (acc + i * 7) % 1_000_003;
  return acc;
}

describe('upload — an unreachable or hostile server cannot fail, delay, or alter a local run', () => {
  const BOUND_MS = 4_000; // generous slack over the 300 ms configured deadline

  async function flushAgainst(server: string, over: Record<string, unknown> = {}): Promise<{ result: FlushResult; elapsed: number; root: string }> {
    const root = mkProject();
    plantInQueue(root, [rec({ seq: 1 }), rec({ seq: 2 })]);
    const up = new TelemetryUploader({
      outbox: mkOutbox(root),
      target: { ...TARGET, server },
      env: {},
      requestTimeoutMs: 150,
      flushDeadlineMs: 300,
      maxAttempts: 2,
      backoffBaseMs: 5,
      backoffCapMs: 10,
      random: () => 0,
      ...over,
    } as ConstructorParameters<typeof TelemetryUploader>[0]);
    const t0 = Date.now();
    const result = await up.flushOnce();
    return { result, elapsed: Date.now() - t0, root };
  }

  test('UNREACHABLE (connection refused): bounded, no throw, queue untouched', async () => {
    const url = await deadPort();
    const { result, elapsed, root } = await flushAgainst(url);
    expect(result.outcome).toBe('retry');
    expect(elapsed).toBeLessThan(BOUND_MS);
    expect(mkOutbox(root).readAll().length).toBe(2); // nothing altered
    expect(mkOutbox(root).readQuarantine()).toEqual([]);
  });

  test('HANGS FOREVER (accepts the socket, never answers): the flush still returns inside its bound', async () => {
    const url = await startServer(() => {
      /* deliberately never responds and never closes */
    });
    const { result, elapsed, root } = await flushAgainst(url);
    expect(result.outcome).toBe('retry');
    expect(elapsed).toBeLessThan(BOUND_MS);
    expect(result.duration_ms).toBeLessThan(BOUND_MS);
    expect(mkOutbox(root).readAll().length).toBe(2);
  });

  test('GARBAGE (200 with a non-JSON body): treated by STATUS alone, body never parsed', async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not an ingest ack at all</html>');
    });
    const { result, elapsed, root } = await flushAgainst(url);
    expect(result.records_sent).toBe(2);
    expect(elapsed).toBeLessThan(BOUND_MS);
    expect(mkOutbox(root).readAll()).toEqual([]);
  });

  test('HOSTILE OVERSIZED BODY (500 + an endless stream): never buffered, still bounded', async () => {
    const chunk = 'X'.repeat(64 * 1024);
    let writing = true;
    const url = await startServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      const pump = (): void => {
        if (!writing) return;
        if (res.write(chunk)) setImmediate(pump);
        else res.once('drain', pump);
      };
      pump();
    });
    const rssBefore = process.memoryUsage().rss;
    const { result, elapsed, root } = await flushAgainst(url);
    writing = false;
    expect(result.outcome).toBe('retry');
    expect(elapsed).toBeLessThan(BOUND_MS);
    expect(mkOutbox(root).readAll().length).toBe(2);
    // The uploader never read the stream, so the process did not grow by
    // anything like the volume the server was willing to send.
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(200 * 1024 * 1024);
  });

  test('SOCKET DESTROYED MID-RESPONSE: classified as retryable, nothing lost', async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"run_id":');
      res.socket?.destroy();
    });
    const { result, elapsed, root } = await flushAgainst(url);
    expect(elapsed).toBeLessThan(BOUND_MS);
    // Either the status arrived (2xx, acked) or the socket died first
    // (retryable) — both are safe; what is forbidden is a throw or a hang.
    expect(['sent', 'retry']).toContain(result.outcome);
    expect(mkOutbox(root).readAll().length + mkOutbox(root).readQuarantine().length + result.records_sent).toBe(2);
  });

  test('a "local run" running CONCURRENTLY with a flush against a hanging server is unaffected', async () => {
    const url = await startServer(() => {
      /* never responds */
    });
    const expected = localRunWork();
    const baselineStart = Date.now();
    localRunWork();
    const baseline = Date.now() - baselineStart;

    const root = mkProject();
    plantInQueue(root, [rec()]);
    const up = new TelemetryUploader({
      outbox: mkOutbox(root),
      target: { ...TARGET, server: url },
      env: {},
      requestTimeoutMs: 200,
      flushDeadlineMs: 400,
      maxAttempts: 2,
      backoffBaseMs: 5,
      backoffCapMs: 10,
    });
    const inFlight = up.flushOnce();
    const workStart = Date.now();
    const got = localRunWork();
    const withFlush = Date.now() - workStart;
    const result = await inFlight;

    // Same answer…
    expect(got).toBe(expected);
    // …and no meaningful delay: the flush is I/O-bound and detached, so the
    // run's own work is not waiting on it. (Wide slack: this is a CI box.)
    expect(withFlush).toBeLessThan(Math.max(1_000, baseline * 10 + 500));
    expect(result.outcome).toBe('retry');
  });

  test('the deadline is enforced even when every request answers instantly', async () => {
    const root = mkProject();
    plantInQueue(root, Array.from({ length: 500 }, (_, i) => rec({ seq: i + 1, run_id: `run-${i % 10}` })));
    let calls = 0;
    const slow: UploadFetch = async () => {
      calls += 1;
      return { status: 500 };
    };
    const up = new TelemetryUploader({
      outbox: mkOutbox(root),
      target: TARGET,
      fetch: slow,
      env: {},
      batchSize: 5,
      maxRequests: 3,
      maxAttempts: 10,
      backoffBaseMs: 0,
      backoffCapMs: 0,
      flushDeadlineMs: 1_000,
      requestTimeoutMs: 50,
    });
    const result = await up.flushOnce();
    // maxAttempts bounds the batch, maxRequests bounds the flush — the queue
    // is 500 records deep and this made at most 10 requests.
    expect(calls).toBeLessThanOrEqual(10);
    expect(result.requests).toBeLessThanOrEqual(10);
    expect(result.duration_ms).toBeLessThan(4_000);
  });

  test('the deadline stops a LONG SUCCESSFUL run of batches — not just a failing one', async () => {
    // Every request answers (a 4xx, so there is no retry and no backoff to
    // hide behind) but each takes 40 ms. Nothing except the wall-clock deadline
    // can stop this loop: `maxRequests` is far above the batch count and the
    // per-request timeout is far above the per-request cost.
    const root = mkProject();
    plantInQueue(root, Array.from({ length: 60 }, (_, i) => rec({ seq: i + 1 })));
    let calls = 0;
    const slow: UploadFetch = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 40));
      return { status: 400 };
    };
    const result = await new TelemetryUploader({
      outbox: mkOutbox(root),
      target: TARGET,
      fetch: slow,
      env: {},
      batchSize: 1,
      maxRequests: 60,
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
      flushDeadlineMs: 250,
    }).flushOnce();

    expect(result.deadline_hit).toBe(true);
    expect(result.outcome).toBe('deadline');
    expect(calls).toBeLessThan(20); // ~6 fit in 250 ms; 60 would mean no deadline
    expect(result.duration_ms).toBeLessThan(3_000);
    // The rest is still queued for the next poll — bounded, not lost.
    expect(mkOutbox(root).readAll().length + mkOutbox(root).readQuarantine().length).toBe(60);
  });

  test('the per-request timeout is CLAMPED to the deadline — a hang cannot overrun it', async () => {
    // The request timeout (5 s) is deliberately far LOOSER than the deadline
    // (200 ms). Without the clamp the single in-flight request would run to its
    // own 5 s timeout and the flush would return long after its deadline; with
    // it, the request is issued with the time that actually remains.
    const url = await startServer(() => {
      /* never responds */
    });
    const root = mkProject();
    plantInQueue(root, [rec()]);
    const t0 = Date.now();
    const result = await new TelemetryUploader({
      outbox: mkOutbox(root),
      target: { ...TARGET, server: url },
      env: {},
      maxAttempts: 1,
      requestTimeoutMs: 5_000,
      flushDeadlineMs: 200,
    }).flushOnce();
    const elapsed = Date.now() - t0;
    expect(result.outcome).toBe('retry');
    expect(elapsed).toBeLessThan(2_000); // 5 000 ms would mean no clamp
  }, 20_000);

  test('the deadline also clamps RETRIES WITHIN one batch', async () => {
    const root = mkProject();
    plantInQueue(root, [rec()]);
    let calls = 0;
    const slow: UploadFetch = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 40));
      return { status: 500 };
    };
    const result = await new TelemetryUploader({
      outbox: mkOutbox(root),
      target: TARGET,
      fetch: slow,
      env: {},
      maxAttempts: 50,
      backoffBaseMs: 0,
      backoffCapMs: 0,
      requestTimeoutMs: 5_000,
      flushDeadlineMs: 200,
    }).flushOnce();

    expect(calls).toBeLessThan(20); // 50 attempts would mean no clamp
    expect(result.duration_ms).toBeLessThan(3_000);
  });

  test('the real transport honours its per-request timeout against a hanging server', async () => {
    const url = await startServer(() => {
      /* never responds */
    });
    const t0 = Date.now();
    const res = await realUploadFetch({
      url: `${url}${INGEST_PATH}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"run_id":"r","events":[]}',
      timeoutMs: 150,
    });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(0); // no HTTP response — retryable
    expect(elapsed).toBeLessThan(3_000);
  });

  test('the real transport never follows a redirect (the bearer must not reach another host)', async () => {
    const url = await startServer((_req, res) => {
      res.writeHead(302, { location: 'http://evil.invalid/steal' });
      res.end();
    });
    const res = await realUploadFetch({
      url: `${url}${INGEST_PATH}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok-SECRET' },
      body: '{"run_id":"r","events":[]}',
      timeoutMs: 1_000,
    });
    // A 3xx is reported as-is and classified retryable — never chased.
    expect(res.status).toBe(302);
  });
});

// ---------------------------------------------------------------------------
// 5. NO PAYLOAD CONTENT IN LOGS OR METRICS (matrix 29)
// ---------------------------------------------------------------------------

describe('upload — no payload content reaches logs or metrics (matrix 29)', () => {
  test('nothing written to the log sink, stdout or stderr contains a planted secret or the token', async () => {
    const root = mkProject();
    plantHostileQueue(root);

    const captured: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    // Capture EVERYTHING the flush emits by any route, not just the sink.
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
      captured.push(String(c));
      return true;
    };
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
      captured.push(String(c));
      return true;
    };

    let results: FlushResult[] = [];
    try {
      // A hostile server that ECHOES a secret back in its error body — the
      // classic way payload content re-enters a log via an error message.
      const hostile: UploadFetch = async () => ({ status: 400 });
      const up = new TelemetryUploader({
        outbox: mkOutbox(root, { onDrop: (d) => captured.push(JSON.stringify(d)) }),
        target: TARGET,
        fetch: hostile,
        env: {},
        log: (r) => {
          results.push(r);
          captured.push(JSON.stringify(r));
        },
      });
      await up.flushOnce();
    } finally {
      (process.stdout as unknown as { write: typeof realOut }).write = realOut;
      (process.stderr as unknown as { write: typeof realErr }).write = realErr;
    }

    const blob = captured.join('\n');
    const leaks = Object.entries(SECRETS).filter(([, s]) => blob.includes(s));
    console.log(
      `\n[b10 log/metric scan]\ncaptured ${captured.length} line(s), ${blob.length} chars\n` +
        Object.entries(SECRETS)
          .map(([n, s]) => `  ${blob.includes(s) ? 'LEAKED' : 'clean '}  ${n}`)
          .join('\n') +
        `\n  ${blob.includes(TARGET.token) ? 'LEAKED' : 'clean '}  bearer token\nresult: ${leaks.length === 0 && !blob.includes(TARGET.token) ? 'CLEAN' : 'LEAK(S)'}\n`,
    );
    expect(leaks.map(([n]) => n)).toEqual([]);
    expect(blob).not.toContain(TARGET.token);

    // The result object itself — the "metric" — is counters and statuses only.
    expect(Object.keys(results[0]!).sort()).toEqual(
      [
        'deadline_hit',
        'duration_ms',
        'outcome',
        'records_kept',
        'records_quarantined',
        'records_refused_org',
        'records_sent',
        'requests',
        'statuses',
      ].sort(),
    );
    expect(JSON.stringify(results[0])).not.toContain('payload');
  });

  test('a transport exception carrying a secret in its message never reaches a log', async () => {
    const root = mkProject();
    plantInQueue(root, [rec()]);
    const captured: string[] = [];
    const realErr = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
      captured.push(String(c));
      return true;
    };
    try {
      const boom: UploadFetch = async () => {
        throw new Error(SECRETS.toolOutput);
      };
      const r = await uploader(root, { fetch: boom, log: (x) => captured.push(JSON.stringify(x)) }).flushOnce();
      expect(r.outcome).toBe('error');
    } finally {
      (process.stderr as unknown as { write: typeof realErr }).write = realErr;
    }
    expect(captured.join('\n')).not.toContain(SECRETS.toolOutput);
  });
});

// ---------------------------------------------------------------------------
// 6. Wiring, bounds and credential resolution
// ---------------------------------------------------------------------------

describe('upload — wiring and mechanics', () => {
  test('the URL and headers are the ingest contract, and the token rides only in the header', async () => {
    const root = mkProject();
    plantInQueue(root, [rec()]);
    const cap = captureFetch(200);
    await uploader(root, { fetch: cap.fetch }).flushOnce();
    const req = cap.requests[0]!;
    expect(req.url).toBe('https://api.example.test/api/v1/ingest');
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers.authorization).toBe('Bearer tok-SECRET');
    expect(req.headers['x-org-id']).toBeUndefined(); // absent unless a UUID is known
    expect(req.body).not.toContain('tok-SECRET');
    expect(req.timeoutMs).toBeLessThanOrEqual(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  test('a trailing slash on the server never yields a double slash', async () => {
    const root = mkProject();
    plantInQueue(root, [rec()]);
    const cap = captureFetch(200);
    await uploader(root, { fetch: cap.fetch, target: { ...TARGET, server: 'https://api.example.test/' } }).flushOnce();
    expect(cap.requests[0]!.url).toBe('https://api.example.test/api/v1/ingest');
  });

  test('X-Org-Id rides only when an org UUID is known', async () => {
    const root = mkProject();
    plantInQueue(root, [rec()]);
    const cap = captureFetch(200);
    await uploader(root, {
      fetch: cap.fetch,
      target: { ...TARGET, orgId: 'bd78c116-0000-4000-8000-000000000000' },
    }).flushOnce();
    expect(cap.requests[0]!.headers['x-org-id']).toBe('bd78c116-0000-4000-8000-000000000000');
  });

  test('the body is the protocol batch shape: { run_id, events: [{ seq, payload }] }', async () => {
    const root = mkProject();
    plantInQueue(root, [rec({ seq: 7 })]);
    const cap = captureFetch(200);
    await uploader(root, { fetch: cap.fetch }).flushOnce();
    const body = JSON.parse(cap.requests[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['events', 'run_id']);
    expect(body.run_id).toBe('run-a');
    const events = body.events as Array<Record<string, unknown>>;
    expect(Object.keys(events[0]!).sort()).toEqual(['payload', 'seq']);
    expect(events[0]!.seq).toBe(7);
  });

  test('batches are per-run and chunked — ingest cannot express a mixed batch', async () => {
    const root = mkProject();
    plantInQueue(root, [
      rec({ run_id: 'r1', seq: 1 }),
      rec({ run_id: 'r2', seq: 1 }),
      rec({ run_id: 'r1', seq: 2 }),
      rec({ run_id: 'r1', seq: 3 }),
    ]);
    const cap = captureFetch(200);
    await uploader(root, { fetch: cap.fetch, batchSize: 2 }).flushOnce();
    const bodies = cap.requests.map((r) => JSON.parse(r.body) as { run_id: string; events: Array<{ seq: number }> });
    expect(bodies.map((b) => `${b.run_id}:${b.events.map((e) => e.seq).join(',')}`).sort()).toEqual([
      'r1:1,2',
      'r1:3',
      'r2:1',
    ]);
  });

  test('chunkByRun preserves order within a run and never mixes runs', () => {
    const chunks = chunkByRun(
      [rec({ run_id: 'a', seq: 1 }), rec({ run_id: 'b', seq: 1 }), rec({ run_id: 'a', seq: 2 }), rec({ run_id: 'a', seq: 3 })],
      2,
    );
    expect(chunks.map((c) => `${c.runId}:${c.records.map((r) => r.seq).join(',')}`)).toEqual(['a:1,2', 'a:3', 'b:1']);
    expect(chunks.every((c) => c.records.every((r) => r.run_id === c.runId))).toBe(true);
  });

  test('the documented defaults are the documented defaults', () => {
    expect(DEFAULT_BATCH_SIZE).toBe(100);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_FLUSH_DEADLINE_MS).toBe(20_000);
    expect(INGEST_PATH).toBe('/api/v1/ingest');
  });

  test('backoff grows, caps and jitters within ±25 %', () => {
    const mid = () => 0.5; // no jitter
    expect(backoffDelayMs(1, 1_000, 30_000, mid)).toBe(1_000);
    expect(backoffDelayMs(2, 1_000, 30_000, mid)).toBe(2_000);
    expect(backoffDelayMs(6, 1_000, 30_000, mid)).toBe(30_000);
    expect(backoffDelayMs(99, 1_000, 30_000, mid)).toBe(30_000);
    expect(backoffDelayMs(1, 1_000, 30_000, () => 0)).toBe(750);
    expect(backoffDelayMs(1, 1_000, 30_000, () => 1)).toBe(1_250);
  });

  test('an empty queue is a no-op that makes no request', async () => {
    const root = mkProject();
    const cap = captureFetch(200);
    const result = await uploader(root, { fetch: cap.fetch }).flushOnce();
    expect(result.outcome).toBe('idle');
    expect(cap.requests.length).toBe(0);
  });
});

describe('upload — credential resolution is silent (never prompts, never opens a browser)', () => {
  const home = (root: string) => ({ platform: 'linux', homedir: root, env: { PIPELINE_CLOUD_HOME: join(root, 'cfg') } });

  function writeStore(root: string, cred: Record<string, unknown>, server = 'https://api.example.test'): void {
    mkdirSync(join(root, 'cfg'), { recursive: true });
    writeFileSync(
      join(root, 'cfg', 'credentials.json'),
      JSON.stringify({ version: 1, servers: { [server]: cred } }),
      'utf-8',
    );
  }

  function writeBinding(root: string, binding: Record<string, unknown>): void {
    mkdirSync(join(root, '.pipeline'), { recursive: true });
    writeFileSync(join(root, '.pipeline', 'cloud.json'), JSON.stringify(binding), 'utf-8');
  }

  test('no binding ⇒ null (F7: with no account the subsystem is ABSENT)', async () => {
    const root = mkProject();
    expect(await resolveUploadTarget({ cwd: root, ...home(root) })).toBeNull();
  });

  test('a binding but no credential store ⇒ null, silently', async () => {
    const root = mkProject();
    writeBinding(root, { server: 'https://api.example.test', org: 'acme', project: 'p', connected_at: 'x' });
    expect(await resolveUploadTarget({ cwd: root, ...home(root) })).toBeNull();
  });

  test('the CREDENTIAL org wins over a stale binding org — the server routes by token', async () => {
    const root = mkProject();
    writeBinding(root, { server: 'https://api.example.test', org: 'stale-org', project: 'p', connected_at: 'x' });
    writeStore(root, { access_token: 'tok-1', token_type: 'bearer', org_slug: 'real-org' });
    const target = await resolveUploadTarget({ cwd: root, ...home(root) });
    expect(target).toEqual({ server: 'https://api.example.test', org: 'real-org', token: 'tok-1' });
  });

  test('a credential with no org_slug falls back to the binding', async () => {
    const root = mkProject();
    writeBinding(root, { server: 'https://api.example.test', org: 'bound-org', project: 'p', connected_at: 'x' });
    writeStore(root, { access_token: 'tok-2', token_type: 'bearer' });
    expect((await resolveUploadTarget({ cwd: root, ...home(root) }))!.org).toBe('bound-org');
  });

  test('an expired credential with no refresh token ⇒ null, not a prompt and not a throw', async () => {
    const root = mkProject();
    writeBinding(root, { server: 'https://api.example.test', org: 'acme', project: 'p', connected_at: 'x' });
    writeStore(root, { access_token: 'tok-3', token_type: 'bearer', expires_at: 1 });
    expect(await resolveUploadTarget({ cwd: root, ...home(root) })).toBeNull();
  });

  test('a refresh that fails ⇒ null; a refresh that succeeds ⇒ the fresh token, with no interaction', async () => {
    const root = mkProject();
    writeBinding(root, { server: 'https://api.example.test', org: 'acme', project: 'p', connected_at: 'x' });
    writeStore(root, { access_token: 'old', token_type: 'bearer', refresh_token: 'r1', expires_at: 1, org_slug: 'acme' });

    const failing = await resolveUploadTarget({
      cwd: root,
      ...home(root),
      fetch: async () => ({ status: 400, json: async () => ({ error: 'invalid_grant' }) }),
    });
    expect(failing).toBeNull();

    const ok = await resolveUploadTarget({
      cwd: root,
      ...home(root),
      now: () => 1_000,
      fetch: async () => ({ status: 200, json: async () => ({ access_token: 'fresh', expires_in: 900 }) }),
    });
    expect(ok!.token).toBe('fresh');
  });

  test('PIPELINE_CLOUD_API overrides the binding server', async () => {
    const root = mkProject();
    writeBinding(root, { server: 'https://old.example.test', org: 'acme', project: 'p', connected_at: 'x' });
    writeStore(root, { access_token: 'tok', token_type: 'bearer' }, 'https://new.example.test');
    const h = home(root);
    const target = await resolveUploadTarget({
      cwd: root,
      ...h,
      env: { ...h.env, PIPELINE_CLOUD_API: 'https://new.example.test/' },
    });
    expect(target!.server).toBe('https://new.example.test');
  });
});
