// SG4 — the PRODUCTION reproduction (ux-v2 `b22`).
//
// §1 of `tests/path-privacy.test.ts` proves the rule. This file proves the
// defect that was live in production from 2026-07-19 to 2026-08-07 is gone,
// using the REAL machinery end to end and the REAL bytes:
//
//   - the journal envelopes are transcribed VERBATIM from
//     `scripts/i1-production-e2e/evidence/wire-payloads.jsonl` in the parent
//     monorepo — the rows read back out of the production `events` table with
//     `PGOPTIONS='-c default_transaction_read_only=on'`;
//   - they are written to a real `events.jsonl` and drained by the real
//     `TelemetryOutbox`, so the queue file on disk is a real queue file;
//   - the queue is flushed by the real `TelemetryUploader` with a capturing
//     `fetch`, so the request body is the real request body;
//   - both are judged by {@link SG4_PATH_RE}, transcribed verbatim from
//     `check-sg4.mjs`'s `PATH_RE` — the check that produced the finding.
//
// The i1 verdict on these exact payloads was:
//
//     payloads checked: 21
//     SG4: 4 problem(s)
//       - wire#6:  raw absolute path at payload.data.iteration_path
//       - wire#6:  raw absolute path at payload.data.next_iteration_path
//       - wire#7:  raw absolute path at payload.data.iteration_path
//       - wire#12: raw absolute path at payload.data.iteration_path
//
// NON-VACUITY. The last describe block applies the SAME check to the RAW
// production journal, before any filtering, and pins the exact four findings
// `i1` reported — so this file demonstrates, in the same run, that the check it
// applies really does catch the defect and is not vacuous.
//
// ── ux-v2 `b23` ─────────────────────────────────────────────────────────────
//
// `b22` closed this by COMPOSING `src/lib/path-privacy.ts` over the vendored
// filter at the outbox and wire seams, because its specification required the
// rule to land upstream first. `b23` landed it in `pipeline-runner`, re-vendored
// the filter, and DELETED that module. Nothing about the machinery under test
// changed — same outbox, same uploader, same production bytes — but the scrub is
// now the FILTER'S OWN, which is why `SG4_PATH_RE` is imported from
// `@baizor/pipeline-protocol` below and why the control block at the bottom was
// rewritten: it used to reproduce the leak by calling the filter directly, and
// calling the filter directly IS the fix now.

import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TelemetryOutbox,
  journalPath,
  telemetryDir,
  type OutboxRecord,
} from '../src/lib/telemetry-outbox';
import {
  TelemetryUploader,
  type UploadFetch,
  type UploadRequest,
  type UploadTarget,
} from '../src/lib/telemetry-upload';
import { SG4_PATH_RE, filterEventForTier } from '@baizor/pipeline-protocol';

// ---------------------------------------------------------------------------
// The production bytes
// ---------------------------------------------------------------------------

/** The account name and machine layout the production rows carry. Kept
 *  verbatim — a paraphrased fixture would not be evidence. */
const PROD_PROJECT_ROOT =
  'C:\\Users\\IvanD\\AppData\\Local\\Temp\\claude\\C--Projects-AI-ai-pipeline\\d2cb2e21-f860-44f1-adcc-fe66015824da\\scratchpad\\i1\\proj-i1-e2e';
const PROD_STEPS = `${PROD_PROJECT_ROOT}\\.pipeline\\i1-e2e-probe\\steps`;
const PROD_ACCOUNT = 'IvanD';
const PROD_RUN_ID = '019fdbdf-822f-7006-8fae-200bec3ae07c';

/** The five envelopes from the i1 run that carry a path field, in order. The
 *  journal form (raw `project_root`) rather than the wire form (`fp:…`) — the
 *  outbox is what turns one into the other. */
function productionJournal(): Array<Record<string, unknown>> {
  const env = (
    ts: string,
    type: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> => ({
    schema: 5,
    ts,
    type,
    project_root: PROD_PROJECT_ROOT,
    worktree: null,
    run_id: PROD_RUN_ID,
    parent_run_id: null,
    session_id: null,
    data,
  });
  return [
    // wire#1 — the sample that LOOKED filtered. It is the raw `--start
    // 01-prepare.md` argv token, not a relativized path.
    env('2026-08-07T10:58:07.521Z', 'iteration.started', {
      index: 1,
      step_name: '01-prepare',
      iteration_path: '01-prepare.md',
      resolved_model: null,
      resolved_effort: null,
    }),
    // wire#6 — the SAME step, eight seconds later, labelled from the plan.
    env('2026-08-07T10:58:39.207Z', 'iteration.completed', {
      outcome: 'completed',
      terminal: false,
      halt_reason: null,
      iteration_path: `${PROD_STEPS}\\01-prepare.md`,
      next_iteration_path: `${PROD_STEPS}\\02-finish.md`,
      has_improvement_brief: false,
      has_blocker_delegation: false,
    }),
    // wire#7
    env('2026-08-07T10:58:39.210Z', 'iteration.started', {
      index: 2,
      step_name: '02-finish',
      iteration_path: `${PROD_STEPS}\\02-finish.md`,
      resolved_model: null,
      resolved_effort: null,
    }),
    // wire#12
    env('2026-08-07T10:59:20.004Z', 'iteration.completed', {
      outcome: 'completed',
      terminal: true,
      halt_reason: null,
      iteration_path: `${PROD_STEPS}\\02-finish.md`,
      next_iteration_path: 'PIPELINE_COMPLETE',
      has_improvement_brief: false,
      has_blocker_delegation: false,
    }),
    // A clean control from the same run, so a fix that simply dropped every
    // `data` field would be caught.
    env('2026-08-07T10:58:15.158Z', 'tool.called', {
      success: true,
      tool_name: 'Read',
      agent_spawn: false,
      tool_use_id: 'toolu_015HYTu95fgxM8L2yTjCAiWV',
    }),
  ];
}

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

const TEST_SALT = 'test-salt-b22-production-repro';
const TARGET: UploadTarget = { server: 'https://api.example.test', org: 'acme', token: 'tok' };

function mkProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'sg4-'));
  created.push(d);
  mkdirSync(join(d, '.pipeline', '.runtime'), { recursive: true });
  return d;
}

function mkOutbox(root: string): TelemetryOutbox {
  return new TelemetryOutbox({
    projectRoot: root,
    org: 'acme',
    env: {},
    fingerprintSalt: TEST_SALT,
    onDrop: () => {},
  });
}

function captureFetch(): { fetch: UploadFetch; requests: UploadRequest[] } {
  const requests: UploadRequest[] = [];
  return { requests, fetch: async (req) => (requests.push(req), { status: 200 }) };
}

/** Every string leaf, with its dotted location — `check-sg4.mjs:scanStrings`. */
function stringLeaves(node: unknown, at = 'payload'): Array<[string, string]> {
  if (typeof node === 'string') return [[at, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => stringLeaves(v, `${at}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => stringLeaves(v, `${at}.${k}`));
  }
  return [];
}

/** `check-sg4.mjs`'s verdict, as `label: location -> value` findings. */
function sg4Findings(payload: unknown, label: string): string[] {
  return stringLeaves(payload)
    .filter(([, v]) => SG4_PATH_RE.test(v))
    .map(([at, v]) => `${label}: raw absolute path at ${at} -> ${JSON.stringify(v.slice(0, 140))}`);
}

// ---------------------------------------------------------------------------
// The reproduction
// ---------------------------------------------------------------------------

describe('b22 §2 — the i1 production payloads, through the REAL outbox and uploader', () => {
  test('the queue file on disk carries no absolute path and no account name', () => {
    const root = mkProject();
    appendFileSync(
      journalPath(root),
      productionJournal().map((e) => `${JSON.stringify(e)}\n`).join(''),
      'utf-8',
    );

    const outbox = mkOutbox(root);
    const drained = outbox.drainJournal();
    expect(drained.enqueued).toBe(5);

    const records = outbox.readAll();
    const findings = records.flatMap((r, i) => sg4Findings(r.payload, `queue#${i + 1}`));

    console.log(
      `\n[b22 §2 queue scan] payloads checked: ${records.length}\n` +
        (findings.length === 0
          ? 'SG4: PASS — no prohibited field found'
          : `SG4: ${findings.length} problem(s)\n  - ${findings.join('\n  - ')}`) +
        '\n',
    );
    expect(findings).toEqual([]);

    // …and the BYTES on disk, which is where an offline machine keeps them.
    for (const f of telemetryFilesOnDisk(root)) {
      expect(`${f.name}: ${f.bytes.includes(Buffer.from(PROD_ACCOUNT, 'utf8'))}`).toBe(
        `${f.name}: false`,
      );
      expect(`${f.name}: ${f.bytes.includes(Buffer.from('C:\\\\Users', 'utf8'))}`).toBe(
        `${f.name}: false`,
      );
    }
  });

  test('the wire bytes carry no absolute path and no account name', async () => {
    const root = mkProject();
    appendFileSync(
      journalPath(root),
      productionJournal().map((e) => `${JSON.stringify(e)}\n`).join(''),
      'utf-8',
    );
    mkOutbox(root).drainJournal();

    const cap = captureFetch();
    await new TelemetryUploader({
      outbox: mkOutbox(root),
      target: TARGET,
      fetch: cap.fetch,
      env: {},
    }).flushOnce();

    expect(cap.requests.length).toBeGreaterThan(0);
    const events = cap.requests.flatMap(
      (r) => (JSON.parse(r.body) as { events: Array<{ seq: number; payload: unknown }> }).events,
    );
    expect(events).toHaveLength(5);

    const findings = events.flatMap((e) => sg4Findings(e.payload, `wire#${e.seq}`));
    console.log(
      `\n[b22 §2 wire scan] payloads checked: ${events.length}\n` +
        (findings.length === 0
          ? 'SG4: PASS — no prohibited field found'
          : `SG4: ${findings.length} problem(s)\n  - ${findings.join('\n  - ')}`) +
        '\n',
    );
    expect(findings).toEqual([]);

    // The raw request bodies, as bytes.
    for (const req of cap.requests) {
      expect(req.body.includes(PROD_ACCOUNT)).toBe(false);
      expect(req.body).not.toContain('C:\\\\Users');
    }
  });

  test('the labels SURVIVE — and started/completed now agree, which they never did', async () => {
    const root = mkProject();
    appendFileSync(
      journalPath(root),
      productionJournal().map((e) => `${JSON.stringify(e)}\n`).join(''),
      'utf-8',
    );
    mkOutbox(root).drainJournal();

    const cap = captureFetch();
    await new TelemetryUploader({
      outbox: mkOutbox(root),
      target: TARGET,
      fetch: cap.fetch,
      env: {},
    }).flushOnce();
    const events = cap.requests.flatMap(
      (r) =>
        (JSON.parse(r.body) as { events: Array<{ seq: number; payload: Record<string, unknown> }> })
          .events,
    );
    const data = (i: number): Record<string, unknown> =>
      events[i]!.payload.data as Record<string, unknown>;

    // The step is still named, relative to the run's own root — this is what
    // `07-security.md` §4.2 grants the metadata tier and what `pipeline logs`
    // and the control plane's step correlation read.
    expect(data(1).iteration_path).toBe('.pipeline/i1-e2e-probe/steps/01-prepare.md');
    expect(data(1).next_iteration_path).toBe('.pipeline/i1-e2e-probe/steps/02-finish.md');
    expect(data(2).iteration_path).toBe('.pipeline/i1-e2e-probe/steps/02-finish.md');
    expect(data(3).iteration_path).toBe('.pipeline/i1-e2e-probe/steps/02-finish.md');
    // The sentinel is not a path and must not be mangled.
    expect(data(3).next_iteration_path).toBe('PIPELINE_COMPLETE');
    // Nothing else about the payload changed.
    expect(data(4).tool_name).toBe('Read');
    expect(events[0]!.payload.project_root).toMatch(/^fp:[0-9a-f]{16}$/);

    // `iteration.completed` for step 2 (seq 4) and `iteration.started` for
    // step 2 (seq 3) now carry the SAME label. Before `b22` one was the plan's
    // absolute path and the other was too, while step 1's pair disagreed
    // outright ('01-prepare.md' vs the absolute path) — which is the v4
    // sequential fold's own pairing key.
    expect(data(2).iteration_path).toBe(data(3).iteration_path);
  });
});

// ---------------------------------------------------------------------------
// b21's run-exit stats path, under the same rule
// ---------------------------------------------------------------------------

describe('b22 §2b — the rule holds on `b21`\'s run-exit STATS path too', () => {
  // `b21` (`lib/telemetry-ship.ts`) reaches the queue through `enqueueStats`,
  // and its envelope is built at flush time by `statsEnvelope`, which sets a
  // RAW `project_root` on purpose — the field the control plane requires and
  // the pre-`b21` CLI omitted. That envelope never passes through `b9`'s
  // filter, so it is the one payload whose only scrub is the wire-side one.
  test('the stats envelope is SG4-clean and still carries the run\'s fingerprint', async () => {
    const root = mkProject();
    const outbox = mkOutbox(root);
    outbox.enqueueStats({
      schema: 1,
      run_id: PROD_RUN_ID,
      pipeline: 'i1-e2e-probe',
      started_at: '2026-08-07T10:58:07.000Z',
      ended_at: '2026-08-07T10:59:20.000Z',
      duration_s: 73,
      outcome: 'completed',
      halt_reason: null,
      runner: 'headless',
      steps_run: 2,
      // A step id and a failure whose `step` field is a PATH, which is where a
      // stats record can carry one at all.
      steps: [{ id: '01-prepare', outcome: 'completed' }],
      failures: [{ ts: '2026-08-07T10:58:20.000Z', tool: 'Bash', step: `${PROD_STEPS}\\01-prepare.md` }],
      tokens: null,
      origin: 'local',
    });

    const cap = captureFetch();
    await new TelemetryUploader({
      outbox: mkOutbox(root),
      target: TARGET,
      fetch: cap.fetch,
      env: {},
    }).flushOnce();

    const events = cap.requests.flatMap(
      (r) =>
        (JSON.parse(r.body) as { events: Array<{ seq: number; payload: Record<string, unknown> }> })
          .events,
    );
    const stats = events.filter((e) => e.payload.type === 'stats.run_record');
    expect(stats).toHaveLength(1);
    expect(sg4Findings(stats[0]!.payload, 'stats#1')).toEqual([]);
    // `b21`'s own assertion, unchanged by `b22`: the envelope names the project
    // by fingerprint, which is what correlates it with the run's events.
    expect(stats[0]!.payload.project_root).toMatch(/^fp:[0-9a-f]{16}$/);
    // …and the terminal state the control plane derives from is untouched.
    const data = stats[0]!.payload.data as Record<string, unknown>;
    expect(data.outcome).toBe('completed');
    expect(data.origin).toBe('local');
    // The queue file's own bytes, too.
    for (const f of telemetryFilesOnDisk(root)) {
      expect(`${f.name}: ${f.bytes.includes(Buffer.from(PROD_ACCOUNT, 'utf8'))}`).toBe(
        `${f.name}: false`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The control: the check, applied to the RAW production journal
// ---------------------------------------------------------------------------

describe('b22 §2 control — the SAME check finds the defect in the raw production bytes', () => {
  test('the unfiltered journal carries exactly the four findings i1 reported, plus the envelope roots', () => {
    // Non-vacuity, without needing a broken filter on hand to compare against.
    //
    // Before `b23` this block called `filterEventForTier` directly to reproduce
    // `TelemetryOutbox.filterPayload`'s pre-`b22` behaviour — the allowlist with
    // nothing after it. That is no longer the pre-fix behaviour: the scrub is
    // INSIDE the filter now, so calling it directly is calling the fix. What the
    // block was really asserting is that these four fields carried absolute
    // paths and that this check sees them, so it asserts exactly that, against
    // the bytes.
    //
    // The four `data` findings are the ones `keep` copied VERBATIM, which is why
    // they reached production. The five `project_root`s beside them were ALWAYS
    // fingerprinted — same payloads, same filter, two dispositions, and only one
    // of them was ever looked at. That is why a spot check passed.
    const findings = productionJournal().flatMap((e, i) => sg4Findings(e, `raw#${i + 1}`));
    const inData = findings.filter((f) => f.includes('payload.data.'));
    const inEnvelope = findings.filter((f) => f.includes('payload.project_root'));
    console.log(
      `\n[b22 §2 control — the RAW journal, unfiltered]\nSG4: ${findings.length} problem(s)\n  - ${findings.join('\n  - ')}\n`,
    );
    expect(inData).toHaveLength(4); // wire#6 twice, #7 once, #12 once — the i1 count
    expect(inEnvelope).toHaveLength(5); // one per envelope, and always fingerprinted
    expect(findings.every((f) => f.includes(PROD_ACCOUNT))).toBe(true);
    expect(inData.filter((f) => f.includes('next_iteration_path'))).toHaveLength(1);
    expect(inData.filter((f) => f.includes('.iteration_path'))).toHaveLength(3);
  });

  test('…and the vendored filter ALONE — nothing composed over it — clears every one of them', () => {
    // The proof that `b23` MOVED the rule rather than duplicating it: nothing is
    // layered over `filterEventForTier` here, and there is nothing left to
    // layer. Before `b23` this exact call produced the four findings above.
    const findings = productionJournal().flatMap((e, i) =>
      sg4Findings(filterEventForTier(e, 'metadata', { fingerprintSalt: TEST_SALT }), `filtered#${i + 1}`),
    );
    console.log(
      `\n[b23 — the vendored filter alone]\n` +
        (findings.length === 0
          ? 'SG4: PASS — no prohibited field found'
          : `SG4: ${findings.length} problem(s)\n  - ${findings.join('\n  - ')}`) +
        '\n',
    );
    expect(findings).toEqual([]);
  });
});

/** Every file the outbox created, read back AS BYTES. */
function telemetryFilesOnDisk(root: string): Array<{ name: string; bytes: Buffer }> {
  const dir = telemetryDir(root);
  return readdirSync(dir)
    .map((name) => ({ name, path: join(dir, name) }))
    .filter((f) => {
      try {
        return statSync(f.path).isFile();
      } catch {
        return false;
      }
    })
    .map((f) => ({ name: f.name, bytes: readFileSync(f.path) }));
}

// Re-exported so a future suite can reuse the record shape without importing
// the outbox's private types.
export type { OutboxRecord };
