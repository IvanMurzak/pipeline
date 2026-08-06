// Tests for the durable, org-tagged telemetry outbox (src/lib/telemetry-outbox.ts,
// ux-v2 `b9`).
//
// The five Definition-of-Done properties, and the test that proves each:
//
//   1. Two concurrent runs in one project produce correct per-run `seq`
//      (matrix 10)                        → "demux" describe block
//   2. Journal rotation mid-run restarts cleanly with no skipped or
//      re-sequenced events (matrix 11)    → "rotation" describe block
//   3. Torn trailing lines are tolerated and retried
//                                          → "torn lines" describe block
//   4. The bound is enforced and drops are counted, never silent
//                                          → "bound" describe block
//   5. NO PROHIBITED FIELD APPEARS IN ANY OUTBOX FILE ON DISK (matrix 7)
//                                          → "on-disk byte scan" describe block
//
// (5) is deliberately NOT tested by inspecting the code path and reasoning that
// the filter runs first. It plants hostile values — prompts, absolute paths,
// tool arguments, error excerpts, an API-key-shaped string — drives them
// through the REAL queue, then reads every file in the telemetry directory back
// off disk AS BYTES and scans for each planted value. Modelled on `e1`'s
// conformance test (tests/vendor-privacy.test.ts), which does the same for the
// filter itself.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_RECORDS,
  TelemetryOutbox,
  journalPath,
  telemetryDir,
  telemetrySyncEnabled,
  type OutboxRecord,
} from '../src/lib/telemetry-outbox';
import { emitEvent } from '../src/lib/event';

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

function mkProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'tob-'));
  created.push(d);
  mkdirSync(join(d, '.pipeline', '.runtime'), { recursive: true });
  return d;
}

/** A journal envelope in exactly the shape `event.ts` writes. */
function evt(
  type: string,
  runId: string | null,
  data: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 5,
    ts: new Date(Date.now() + Math.floor(Math.random() * 1000)).toISOString(),
    type,
    project_root: 'C:/Users/ivan/very-secret-client-project',
    worktree: null,
    run_id: runId,
    parent_run_id: null,
    session_id: 'sess-1',
    data,
    ...extra,
  };
}

/** Append complete journal lines. */
function writeJournal(root: string, events: unknown[]): void {
  const body = events.map((e) => `${JSON.stringify(e)}\n`).join('');
  appendFileSync(journalPath(root), body, 'utf-8');
}

/** Append raw bytes (used to create a genuinely TORN trailing line). */
function writeRaw(root: string, raw: string): void {
  appendFileSync(journalPath(root), raw, 'utf-8');
}

/** Test-only fixed salt (b18) — real enough to satisfy the constructor's
 *  empty-salt guard, distinct enough from `''`/`DEFAULT_FINGERPRINT_SALT`
 *  that a test which forgot to override it would not accidentally collide
 *  with a production constant. */
const TEST_SALT = 'test-salt-outbox-fixture';

function mkOutbox(root: string, over: Record<string, unknown> = {}): TelemetryOutbox {
  return new TelemetryOutbox({
    projectRoot: root,
    org: 'acme',
    // Explicit env so the suite never depends on (or mutates) the ambient one.
    env: {},
    fingerprintSalt: TEST_SALT,
    onDrop: () => {},
    ...over,
  } as ConstructorParameters<typeof TelemetryOutbox>[0]);
}

function seqsFor(records: OutboxRecord[], runId: string): number[] {
  return records.filter((r) => r.run_id === runId).map((r) => r.seq);
}

// ---------------------------------------------------------------------------
// 1. Demux — two concurrent runs in one project (matrix 10)
// ---------------------------------------------------------------------------

describe('outbox — demux: interleaved run_ids become per-run monotonic seq', () => {
  test('two concurrent runs sharing one journal get independent, gapless seq counters', () => {
    const root = mkProject();
    // The interleaving a real pair of concurrent runs produces.
    writeJournal(root, [
      evt('iteration.started', 'run-a', { iteration_path: 'a1.md' }),
      evt('iteration.started', 'run-b', { iteration_path: 'b1.md' }),
      evt('tool.called', 'run-a', { tool_name: 'Read', success: true }),
      evt('tool.called', 'run-b', { tool_name: 'Bash', success: true }),
      evt('iteration.completed', 'run-a', { iteration_path: 'a1.md', outcome: 'completed' }),
    ]);

    const outbox = mkOutbox(root);
    const drained = outbox.drainJournal();
    expect(drained.lines_read).toBe(5);
    expect(drained.enqueued).toBe(5);

    const records = outbox.readAll();
    expect(seqsFor(records, 'run-a')).toEqual([1, 2, 3]);
    expect(seqsFor(records, 'run-b')).toEqual([1, 2]);
    // Every record is org-tagged, and (run_id, seq) is unique across the queue.
    expect(records.every((r) => r.org === 'acme')).toBe(true);
    expect(new Set(records.map((r) => `${r.run_id}#${r.seq}`)).size).toBe(records.length);
  });

  test('seq continues across drains AND across processes — a restart never re-issues (run_id, seq)', () => {
    const root = mkProject();
    writeJournal(root, [
      evt('iteration.started', 'run-a', {}),
      evt('iteration.started', 'run-b', {}),
    ]);
    mkOutbox(root).drainJournal();

    writeJournal(root, [evt('tool.called', 'run-a', { tool_name: 'Read' })]);
    mkOutbox(root).drainJournal(); // a FRESH instance: state comes off disk

    writeJournal(root, [evt('tool.called', 'run-b', { tool_name: 'Bash' })]);
    const third = mkOutbox(root);
    third.drainJournal();

    const records = third.readAll();
    expect(seqsFor(records, 'run-a')).toEqual([1, 2]);
    expect(seqsFor(records, 'run-b')).toEqual([1, 2]);
  });

  test('the per-run counter map is bounded, and evictions are counted rather than silent', () => {
    const root = mkProject();
    writeJournal(
      root,
      Array.from({ length: 12 }, (_, i) => evt('iteration.started', `run-${i}`, {})),
    );
    const outbox = mkOutbox(root, { maxTrackedRuns: 4 });
    outbox.drainJournal();
    expect(outbox.counters().run_counters_evicted).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 2. Rotation (matrix 11)
// ---------------------------------------------------------------------------

describe('outbox — journal rotation restarts cleanly, never on a stale offset', () => {
  /** Reproduce what `event.ts:appendEventLine` does at ROTATE_BYTES: rename the
   *  live journal aside; the next append recreates it. */
  function rotate(root: string): void {
    renameSync(journalPath(root), join(root, '.pipeline', '.runtime', 'events-rotated.jsonl'));
  }

  test('a rotation whose NEW file is LONGER than the old offset — the case a bare offset silently garbles', () => {
    const root = mkProject();
    writeJournal(root, [
      evt('iteration.started', 'run-a', { iteration_path: 'a1.md' }),
      evt('tool.called', 'run-a', { tool_name: 'Read', success: true }),
    ]);
    const outbox = mkOutbox(root);
    outbox.drainJournal();
    const staleOffset = outbox.cursor()!.offset;
    expect(staleOffset).toBeGreaterThan(0);
    const anchorBefore = outbox.cursor()!.anchor;

    rotate(root);
    // The replacement journal is deliberately BIGGER than the stale offset, so
    // seeking to it would land mid-file and skip everything before it.
    const post = [
      evt('iteration.started', 'run-a', { iteration_path: 'a2.md' }),
      evt('tool.called', 'run-a', { tool_name: 'Edit', success: true }),
      evt('tool.called', 'run-a', { tool_name: 'Bash', success: true }),
      evt('iteration.completed', 'run-a', { iteration_path: 'a2.md', outcome: 'completed' }),
    ];
    writeJournal(root, post);
    expect(statSync(journalPath(root)).size).toBeGreaterThan(staleOffset);

    const result = outbox.drainJournal();
    expect(result.restarted).toBe(true);
    // The observable proof that no stale seek happened: the whole new file was
    // consumed, byte for byte, from zero.
    expect(result.bytes_consumed).toBe(statSync(journalPath(root)).size);
    expect(result.lines_read).toBe(post.length);
    expect(outbox.cursor()!.anchor).not.toBe(anchorBefore);
    expect(outbox.counters().rotations_detected).toBe(1);

    const records = outbox.readAll();
    // NOTHING SKIPPED: both pre- and post-rotation events are present.
    expect(records.length).toBe(2 + post.length);
    // NOTHING RE-SEQUENCED: one run, one strictly increasing seq run 1..6, and
    // no (run_id, seq) pair issued twice.
    expect(seqsFor(records, 'run-a')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(records.map((r) => `${r.run_id}#${r.seq}`)).size).toBe(records.length);
  });

  test('a rotation whose NEW file is SHORTER than the old offset — the case a bare offset silently skips', () => {
    const root = mkProject();
    writeJournal(
      root,
      Array.from({ length: 8 }, (_, i) => evt('tool.called', 'run-a', { tool_name: `T${i}` })),
    );
    const outbox = mkOutbox(root);
    outbox.drainJournal();
    const staleOffset = outbox.cursor()!.offset;

    rotate(root);
    writeJournal(root, [evt('tool.called', 'run-a', { tool_name: 'AfterRotation' })]);
    expect(statSync(journalPath(root)).size).toBeLessThan(staleOffset);

    const result = outbox.drainJournal();
    expect(result.restarted).toBe(true);
    expect(result.lines_read).toBe(1);
    const records = outbox.readAll();
    expect(seqsFor(records, 'run-a')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const last = records[records.length - 1];
    expect((last.payload.data as Record<string, unknown>).tool_name).toBe('AfterRotation');
  });

  test('the identity is CONTENT, not inode or birthtime: corrupting those diagnostics does not fake a rotation', () => {
    // This is the cross-platform claim under test. `Stats.ino` is often 0 or
    // unstable on Windows and `birthtimeMs` is unreliable on pre-statx Linux,
    // so neither may decide rotation — a FALSE mismatch would re-read a
    // journal already shipped and re-sequence it.
    const root = mkProject();
    writeJournal(root, [evt('iteration.started', 'run-a', {}), evt('tool.called', 'run-a', {})]);
    const outbox = mkOutbox(root);
    outbox.drainJournal();

    const statePath = join(telemetryDir(root), 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.cursor.anchor).toMatch(/^[0-9a-f]{64}$/);
    // Both diagnostics are recorded…
    expect('ino' in state.cursor).toBe(true);
    expect('birthtime_ms' in state.cursor).toBe(true);
    // …and both are now nonsense of the exact shapes the two platforms produce.
    state.cursor.ino = 0; // Windows' frequent value
    state.cursor.birthtime_ms = 0; // pre-statx Linux' value
    writeFileSync(statePath, JSON.stringify(state), 'utf-8');

    writeJournal(root, [evt('tool.called', 'run-a', { tool_name: 'After' })]);
    const result = mkOutbox(root).drainJournal();
    expect(result.restarted).toBe(false); // no phantom rotation
    expect(result.lines_read).toBe(1); // and no re-read of the first two
    expect(mkOutbox(root).readAll().length).toBe(3);
  });

  test('an anchor that matches but an offset that does not sit after a newline restarts too', () => {
    const root = mkProject();
    writeJournal(root, [evt('iteration.started', 'run-a', {}), evt('tool.called', 'run-a', {})]);
    const outbox = mkOutbox(root);
    outbox.drainJournal();

    const statePath = join(telemetryDir(root), 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    state.cursor.offset = state.cursor.offset - 3; // now mid-line
    writeFileSync(statePath, JSON.stringify(state), 'utf-8');

    writeJournal(root, [evt('tool.called', 'run-a', { tool_name: 'After' })]);
    const result = mkOutbox(root).drainJournal();
    expect(result.restarted).toBe(true);
    expect(result.bytes_consumed).toBe(statSync(journalPath(root)).size);
  });
});

// ---------------------------------------------------------------------------
// 3. Torn trailing lines
// ---------------------------------------------------------------------------

describe('outbox — torn trailing lines are retried, never skipped and never parsed', () => {
  test('a line truncated mid-write is left whole for the next drain, then arrives exactly once', () => {
    const root = mkProject();
    const complete = [
      evt('iteration.started', 'run-a', { iteration_path: 'a1.md' }),
      evt('tool.called', 'run-a', { tool_name: 'Read', success: true }),
    ];
    writeJournal(root, complete);

    // The third line is written HALF-WAY — the exact state a reader observes
    // when it polls between the writer's buffer flush and its newline.
    const third = JSON.stringify(evt('iteration.completed', 'run-a', { iteration_path: 'a1.md', outcome: 'completed' }));
    const cut = Math.floor(third.length / 2);
    writeRaw(root, third.slice(0, cut));

    const outbox = mkOutbox(root);
    const first = outbox.drainJournal();
    expect(first.torn_tail).toBe(true);
    expect(first.lines_read).toBe(2);
    expect(first.skipped_malformed).toBe(0); // not parsed, and not counted as bad
    expect(outbox.readAll().length).toBe(2);
    // The cursor stopped at the newline BEFORE the torn line.
    expect(outbox.cursor()!.offset).toBe(first.bytes_consumed);

    // The writer finishes the line.
    writeRaw(root, `${third.slice(cut)}\n`);
    const second = outbox.drainJournal();
    expect(second.lines_read).toBe(1);
    expect(second.torn_tail).toBe(false);

    const records = outbox.readAll();
    expect(records.length).toBe(3);
    expect(seqsFor(records, 'run-a')).toEqual([1, 2, 3]); // exactly once, in order
    expect((records[2].payload.data as Record<string, unknown>).outcome).toBe('completed');
    expect(outbox.counters().torn_line_retries).toBe(1);
  });

  test('a torn FIRST line binds no cursor at all — a provisional identity would be a guess', () => {
    const root = mkProject();
    const only = JSON.stringify(evt('iteration.started', 'run-a', { iteration_path: 'a1.md' }));
    writeRaw(root, only.slice(0, 20));

    const outbox = mkOutbox(root);
    const first = outbox.drainJournal();
    expect(first.torn_tail).toBe(true);
    expect(first.lines_read).toBe(0);
    expect(outbox.cursor()).toBeNull();

    writeRaw(root, `${only.slice(20)}\n`);
    const second = outbox.drainJournal();
    expect(second.lines_read).toBe(1);
    expect(second.restarted).toBe(false); // first bind, not a rotation
    expect(outbox.cursor()!.offset).toBe(statSync(journalPath(root)).size);
  });

  test('a newline-terminated line that is NOT JSON is malformed, not torn: counted and stepped over', () => {
    const root = mkProject();
    writeJournal(root, [evt('iteration.started', 'run-a', {})]);
    writeRaw(root, 'this is not json at all\n');
    writeJournal(root, [evt('tool.called', 'run-a', { tool_name: 'Read' })]);

    const outbox = mkOutbox(root);
    const first = outbox.drainJournal();
    expect(first.skipped_malformed).toBe(1);
    expect(first.enqueued).toBe(2);
    expect(outbox.counters().dropped_malformed).toBe(1);

    // Stepped over, not retried forever — the queue cannot wedge behind it.
    const second = outbox.drainJournal();
    expect(second.lines_read).toBe(0);
  });

  test('a journal line with no usable run_id is dropped and counted — it cannot be dedup-keyed', () => {
    const root = mkProject();
    writeJournal(root, [evt('session.opened', null, { claude_pid: 42 }), evt('tool.called', 'run-a', {})]);
    const outbox = mkOutbox(root);
    const result = outbox.drainJournal();
    expect(result.skipped_no_run_id).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(outbox.counters().dropped_no_run_id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The bound
// ---------------------------------------------------------------------------

describe('outbox — the bound is enforced and every drop is counted, never silent', () => {
  test('oldest records are dropped at the bound; the counters and the report both fire', () => {
    const root = mkProject();
    const drops: string[] = [];
    writeJournal(
      root,
      Array.from({ length: 60 }, (_, i) => evt('tool.called', 'run-a', { tool_name: `T${i}` })),
    );
    const outbox = mkOutbox(root, {
      maxRecords: 20,
      onDrop: (info: { reason: string; count: number; detail: string }) => {
        drops.push(`${info.reason}:${info.count}`);
      },
    });
    outbox.drainJournal();

    const counters = outbox.counters();
    const kept = outbox.readAll();
    expect(kept.length).toBeLessThanOrEqual(20);
    expect(counters.enqueued).toBe(60);
    // Conservation: nothing vanished unaccounted for.
    expect(kept.length + counters.dropped_bound).toBe(counters.enqueued);
    expect(counters.dropped_bound).toBeGreaterThan(0);
    // Logged, not silent — and reported per BATCH, not per record.
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.every((d) => d.startsWith('bound:'))).toBe(true);
    expect(counters.last_drop_reason).toBe('bound');
    expect(counters.last_drop_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // OLDEST-first: the survivors are the newest tail (`03` F3 — "a lost tail
    // is not" acceptable, a lost head is).
    const names = kept.map((r) => (r.payload.data as Record<string, unknown>).tool_name);
    expect(names[names.length - 1]).toBe('T59');
    expect(names).not.toContain('T0');
  });

  test('drop counters are DURABLE — another process reads the same numbers', () => {
    const root = mkProject();
    writeJournal(
      root,
      Array.from({ length: 30 }, (_, i) => evt('tool.called', 'run-a', { tool_name: `T${i}` })),
    );
    mkOutbox(root, { maxRecords: 10 }).drainJournal();
    const fresh = mkOutbox(root, { maxRecords: 10 });
    expect(fresh.counters().dropped_bound).toBeGreaterThan(0);
    expect(fresh.counters().enqueued).toBe(30);
    expect(fresh.counters().queued).toBe(fresh.readAll().length);
  });

  test('the default bound is the documented one', () => {
    expect(DEFAULT_MAX_RECORDS).toBe(10_000);
  });

  test('drops are reported ONCE PER CYCLE, not once per record — a report nobody reads is silence', () => {
    const root = mkProject();
    // `session.opened` legitimately has a null run_id and a real journal is
    // full of such lines; per-record reporting would drown the signal.
    writeJournal(root, [
      ...Array.from({ length: 5 }, () => evt('session.opened', null, { claude_pid: 1 })),
      evt('tool.called', 'run-a', { tool_name: 'Read' }),
    ]);
    const reports: Array<{ reason: string; count: number }> = [];
    const outbox = mkOutbox(root, {
      onDrop: (i: { reason: string; count: number }) => reports.push({ reason: i.reason, count: i.count }),
    });
    const result = outbox.drainJournal();
    expect(result.skipped_no_run_id).toBe(5);
    expect(reports).toEqual([{ reason: 'no_run_id', count: 5 }]); // one report, full count
    expect(outbox.counters().dropped_no_run_id).toBe(5); // and the count is durable
  });

  test('the durable queue depth is right even on a drain that returns early', () => {
    const root = mkProject();
    writeJournal(root, [evt('tool.called', 'run-a', { tool_name: 'A' })]);
    mkOutbox(root).drainJournal();
    // Now leave the journal with a torn tail so the next drain returns early.
    writeRaw(root, '{"partial":');
    mkOutbox(root).drainJournal();
    const persisted = JSON.parse(readFileSync(join(telemetryDir(root), 'state.json'), 'utf-8'));
    expect(persisted.counters.queued).toBe(1); // not 0 — the queue is not empty
  });
});

// ---------------------------------------------------------------------------
// 5. THE on-disk byte scan (matrix 7)
// ---------------------------------------------------------------------------

/** Hostile values planted in the journal. Every one of these is exactly the
 *  kind of thing the metadata-tier allowlist exists to keep off the wire — and
 *  therefore off the queue file, which sits inside the user's repository for as
 *  long as the machine is offline. */
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

/** Drive a hostile journal through the real queue. */
function plantAndDrain(root: string, over: Record<string, unknown> = {}): TelemetryOutbox {
  writeJournal(root, [
    // Prompt-like text on a KNOWN type, in fields its allowlist does not name.
    evt('iteration.completed', 'run-a', {
      iteration_path: 'steps/03-review.md',
      outcome: 'completed',
      prompt: SECRETS.prompt,
      file_content: SECRETS.apiKey,
    }),
    // The needs-input question: text and context are authored content.
    evt('awaiting_input', 'run-a', {
      run_id: 'run-a',
      iteration: 3,
      question_id: 'q-77',
      question: { text: SECRETS.questionText, context: SECRETS.questionContext, options: ['yes'] },
    }),
    // Tool arguments and output.
    evt('tool.called', 'run-a', {
      tool_name: 'Bash',
      success: true,
      tool_use_id: 't-1',
      args: SECRETS.toolArgs,
      output: SECRETS.toolOutput,
    }),
    // Absolute machine paths (envelope + data).
    evt('worktree.created', 'run-a', {
      ok: false,
      worktree_path: SECRETS.worktreePath,
      detail: SECRETS.hookDetail,
    }),
    // An entirely unknown event type.
    evt('chat.message', 'run-a', { body: SECRETS.unknownTypeBody }),
    // An envelope-level passthrough addition from a newer peer.
    evt('run.started', 'run-a', { pipeline_name: 'release' }, { note: SECRETS.envelopeExtra }),
    // Department task content.
    evt('department.message', 'run-a', {
      parts: [{ text: SECRETS.departmentMessage, media_type: 'text/plain' }],
    }),
  ]);

  const outbox = mkOutbox(root, over);
  outbox.drainJournal();

  // …and the stats path, whose failure excerpts are stripped at EVERY tier.
  outbox.enqueueStats({
    schema: 1,
    run_id: 'run-a',
    pipeline: 'workflows/release',
    outcome: 'halted',
    halt_reason: 'build failed',
    failures: [
      { ts: '2026-08-05T12:00:00.000Z', tool: 'Bash', step: '02-build', error: SECRETS.errorExcerpt },
    ],
    steps: [{ id: '01-plan', outcome: 'completed', notes: SECRETS.prompt }],
  });
  return outbox;
}

describe('outbox — ON-DISK BYTE SCAN: no prohibited field appears in any outbox file (matrix 7)', () => {
  test('every planted secret is absent from the raw bytes of every telemetry file', () => {
    const root = mkProject();
    const outbox = plantAndDrain(root);

    const files = telemetryFilesOnDisk(root);
    const lines: string[] = [];
    lines.push(`files scanned: ${files.map((f) => `${f.name} (${f.bytes.length} bytes)`).join(', ')}`);
    let hits = 0;
    for (const [name, secret] of Object.entries(SECRETS)) {
      const needle = Buffer.from(secret, 'utf8');
      const found = files.filter((f) => f.bytes.includes(needle)).map((f) => f.name);
      if (found.length) hits += 1;
      lines.push(`  ${found.length ? 'LEAKED' : 'clean '}  ${name.padEnd(18)} ${found.join(',') || '—'}`);
    }
    lines.push(`result: ${hits === 0 ? 'CLEAN' : `${hits} LEAK(S)`}`);
    // Printed so the evidence can be quoted verbatim rather than paraphrased.
    console.log(`\n[b9 on-disk byte scan]\n${lines.join('\n')}\n`);

    for (const [name, secret] of Object.entries(SECRETS)) {
      for (const file of files) {
        expect(
          `${name} in ${file.name}: ${file.bytes.includes(Buffer.from(secret, 'utf8'))}`,
        ).toBe(`${name} in ${file.name}: false`);
      }
    }

    // NOT VACUOUS: the queue really is full of records, and the metadata the
    // product runs on really did survive.
    const records = outbox.readAll();
    expect(records.length).toBe(8); // 7 journal events + 1 stats record
    const byType = new Map(
      records
        .filter((r) => r.kind === 'event')
        .map((r) => [String(r.payload.type), r.payload as Record<string, unknown>]),
    );
    expect((byType.get('tool.called')!.data as Record<string, unknown>).tool_name).toBe('Bash');
    expect((byType.get('awaiting_input')!.data as Record<string, unknown>).question_id).toBe('q-77');
    expect((byType.get('chat.message')!.data as Record<string, unknown>)).toEqual({});
    expect((byType.get('iteration.completed')!.data as Record<string, unknown>).outcome).toBe('completed');
    // Absolute paths survive only as fingerprints, so telemetry still
    // correlates without the path ever leaving the machine.
    expect(byType.get('tool.called')!.project_root).toMatch(/^fp:[0-9a-f]{16}$/);
    const stats = records.find((r) => r.kind === 'stats')!;
    expect((stats.payload.failures as Array<Record<string, unknown>>)[0]).toEqual({
      ts: '2026-08-05T12:00:00.000Z',
      tool: 'Bash',
      step: '02-build',
    });
  });

  test('an unrecognized privacy tier FAILS CLOSED — the disk stays clean either way', () => {
    const root = mkProject();
    const outbox = plantAndDrain(root, { env: { PIPELINE_PRIVACY_TIER: 'everything' } });
    expect(outbox.tier).toBe('metadata');
    expect(outbox.tierWarning).toContain('failing closed');
    for (const file of telemetryFilesOnDisk(root)) {
      for (const [name, secret] of Object.entries(SECRETS)) {
        expect(`${name}: ${file.bytes.includes(Buffer.from(secret, 'utf8'))}`).toBe(`${name}: false`);
      }
    }
  });

  test('a fingerprint salt changes the on-disk path fingerprint and never reveals the path', () => {
    const a = mkProject();
    const b = mkProject();
    plantAndDrain(a);
    plantAndDrain(b, { fingerprintSalt: 'salt-1' });
    const fpA = mkOutbox(a).readAll()[0].payload.project_root as string;
    const fpB = mkOutbox(b, { fingerprintSalt: 'salt-1' }).readAll()[0].payload.project_root as string;
    expect(fpA).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(fpB).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(fpA).not.toBe(fpB);
  });
});

// ---------------------------------------------------------------------------
// The org tag (F4)
// ---------------------------------------------------------------------------

describe('outbox — the org tag is what prevents the F4 cross-org leak', () => {
  test('records queued under org A are handed back as BLOCKED, never sendable, under org B', () => {
    const root = mkProject();
    writeJournal(root, [evt('tool.called', 'run-a', { tool_name: 'Read' }), evt('tool.called', 'run-a', {})]);
    mkOutbox(root, { org: 'org-a' }).drainJournal();

    const asB = mkOutbox(root, { org: 'org-b' });
    const batch = asB.takeBatch();
    expect(batch.sendable).toEqual([]); // nothing crosses the boundary
    expect(batch.blocked.length).toBe(2);
    expect(batch.blocked.every((r) => r.org === 'org-a')).toBe(true);

    // Reconnecting to A releases them — blocked is a refusal, not a delete.
    const asA = mkOutbox(root, { org: 'org-a' });
    expect(asA.takeBatch().sendable.length).toBe(2);
    expect(asA.takeBatch().blocked).toEqual([]);
  });

  test('an outbox cannot be constructed without an org — an untagged record never exists', () => {
    const root = mkProject();
    expect(() => new TelemetryOutbox({ projectRoot: root, org: '' })).toThrow(/non-empty org/);
    expect(() => new TelemetryOutbox({ projectRoot: root, org: '   ' })).toThrow(/non-empty org/);
  });
});

// ---------------------------------------------------------------------------
// The fingerprint salt (07-security.md T16/SG13, ux-v2 `b18`)
//
// `b15` shipped the per-install secret but wired it only into
// `run-identity.ts`'s project fingerprint (`commands/hash.ts`'s sole
// consumer) — nothing uploads that value. THIS class is what actually
// filters (and, via `fingerprintSalt`, re-filters at wire time) every
// uploaded record, and it used to default an unresolved salt to `''`
// (`telemetry-outbox.ts:595`, pre-`b18`) — a silent empty HMAC key, weaker
// than the public constant `b15` retired. These tests cover the fix: the
// empty-salt guard, and that the resolved salt is actually load-bearing on
// the filtered output (not just accepted and ignored).
// ---------------------------------------------------------------------------

describe('outbox — the fingerprint salt is REQUIRED, not defaulted (b18)', () => {
  test('an outbox cannot be constructed with an empty fingerprintSalt — the empty-salt guard', () => {
    const root = mkProject();
    expect(() => new TelemetryOutbox({ projectRoot: root, org: 'acme', fingerprintSalt: '' })).toThrow(
      /non-empty fingerprintSalt/,
    );
    expect(() => new TelemetryOutbox({ projectRoot: root, org: 'acme', fingerprintSalt: '   ' })).toThrow(
      /non-empty fingerprintSalt/,
    );
  });

  test('an outbox cannot be constructed with fingerprintSalt omitted entirely — the same guard catches a reverted call site', () => {
    const root = mkProject();
    // `as any`: TypeScript's own "required field" check is a SEPARATE net
    // (bun's runtime strips types and does not enforce it) — this asserts
    // the RUNTIME guard independently, which is what actually protects a
    // caller that reverts to the pre-b18 shape (`new TelemetryOutbox({
    // projectRoot, org, env, now })`, no `fingerprintSalt` key at all).
    expect(() => new (TelemetryOutbox as any)({ projectRoot: root, org: 'acme' })).toThrow(
      /non-empty fingerprintSalt/,
    );
  });

  test('two outboxes salted differently produce DIFFERENT fingerprints for the SAME journal input', () => {
    const root = mkProject();
    writeJournal(root, [evt('tool.called', 'run-a', { tool_name: 'Read', success: true })]);

    const a = mkOutbox(root, { org: 'org-a', fingerprintSalt: 'install-secret-A' });
    a.drainJournal();
    const [recordA] = a.readAll();

    // A second, independent project (a fresh journal) fingerprinted under a
    // DIFFERENT salt — same identifier value (`project_root`), different key.
    const root2 = mkProject();
    writeJournal(root2, [evt('tool.called', 'run-a', { tool_name: 'Read', success: true })]);
    const b = mkOutbox(root2, { org: 'org-a', fingerprintSalt: 'install-secret-B' });
    b.drainJournal();
    const [recordB] = b.readAll();

    expect(recordA.payload.project_root).not.toBe(recordB.payload.project_root);
    // Both are still well-formed fingerprints, not raw paths.
    expect(recordA.payload.project_root).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(recordB.payload.project_root).toMatch(/^fp:[0-9a-f]{16}$/);
  });

  test('the SAME salt reused across two outbox instances is STABLE (deterministic, not per-instance-random)', () => {
    const root = mkProject();
    writeJournal(root, [evt('tool.called', 'run-a', { tool_name: 'Read', success: true })]);
    const first = mkOutbox(root, { org: 'org-a', fingerprintSalt: 'shared-secret' });
    first.drainJournal();
    const [recordFirst] = first.readAll();

    // A second, independently-constructed outbox instance over the SAME
    // project, salted identically — simulates the daemon rebuilding a fresh
    // TelemetryOutbox every poll cycle (`telemetry-daemon.ts`'s own doc
    // comment: "A fresh TelemetryOutbox … is built EVERY cycle").
    const root2 = mkProject();
    writeJournal(root2, [evt('tool.called', 'run-a', { tool_name: 'Read', success: true })]);
    const second = mkOutbox(root2, { org: 'org-a', fingerprintSalt: 'shared-secret' });
    second.drainJournal();
    const [recordSecond] = second.readAll();

    expect(recordFirst.payload.project_root).toBe(recordSecond.payload.project_root);
  });

  test('NEVER UPLOADED: the raw salt string never appears in the outbox file on disk', () => {
    const root = mkProject();
    const secretSalt = 'super-secret-install-salt-do-not-leak-me-9f3a7c';
    writeJournal(root, [
      evt('tool.called', 'run-a', { tool_name: 'Read', success: true }),
      evt('iteration.completed', 'run-a', { iteration_path: 'a1.md', outcome: 'completed' }),
    ]);
    const outbox = mkOutbox(root, { org: 'org-a', fingerprintSalt: secretSalt });
    outbox.drainJournal();

    // Scan every file the telemetry dir wrote, as BYTES — same discipline as
    // the "on-disk byte scan" block below (matrix 7), applied to the salt
    // itself rather than a planted secret.
    const dir = telemetryDir(root);
    for (const name of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, name), 'utf-8');
      expect(bytes).not.toContain(secretSalt);
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring, opt-out and queue mechanics
// ---------------------------------------------------------------------------

describe('outbox — wiring and mechanics', () => {
  test('it tails the journal the REAL writer writes (event.ts emitEvent)', () => {
    const root = mkProject();
    const savedHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    const fakeHome = mkProject();
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    try {
      emitEvent('iteration.started', [
        `--project-root=${root}`,
        'run_id=run-a',
        'iteration_path=steps/01-plan.md',
      ]);
      emitEvent('tool.called', [`--project-root=${root}`, 'run_id=run-a', 'tool_name=Read', 'success=true']);
    } finally {
      process.env.USERPROFILE = savedHome.USERPROFILE;
      process.env.HOME = savedHome.HOME;
    }

    const outbox = mkOutbox(root);
    const result = outbox.drainJournal();
    expect(result.enqueued).toBe(2);
    const records = outbox.readAll();
    expect(records.map((r) => r.payload.type)).toEqual(['iteration.started', 'tool.called']);
    expect((records[1].payload.data as Record<string, unknown>).tool_name).toBe('Read');
  });

  test('the queue tree carries its own .gitignore, at the .runtime ROOT', () => {
    const root = mkProject();
    mkOutbox(root);
    const stub = readFileSync(join(root, '.pipeline', '.runtime', '.gitignore'), 'utf-8');
    expect(stub).toContain('*');
  });

  test('PIPELINE_SYNC_LOCAL_STATS=0 queues nothing at all', () => {
    const root = mkProject();
    writeJournal(root, [evt('tool.called', 'run-a', { tool_name: 'Read' })]);
    const outbox = mkOutbox(root, { env: { PIPELINE_SYNC_LOCAL_STATS: '0' } });
    expect(outbox.drainJournal().enqueued).toBe(0);
    expect(outbox.enqueueStats({ run_id: 'run-a' })).toBeNull();
    expect(outbox.readAll()).toEqual([]);
    expect(telemetrySyncEnabled({ PIPELINE_SYNC_LOCAL_STATS: 'off' })).toBe(false);
    expect(telemetrySyncEnabled({})).toBe(true);
  });

  test('ack removes exactly the acked records and leaves the rest in order', () => {
    const root = mkProject();
    writeJournal(root, [
      evt('tool.called', 'run-a', { tool_name: 'A' }),
      evt('tool.called', 'run-b', { tool_name: 'B' }),
      evt('tool.called', 'run-a', { tool_name: 'C' }),
    ]);
    const outbox = mkOutbox(root);
    outbox.drainJournal();
    const all = outbox.readAll();
    expect(outbox.ack([all[0], all[2]])).toBe(2);
    const left = outbox.readAll();
    expect(left.length).toBe(1);
    expect(left[0].run_id).toBe('run-b');
    expect(outbox.counters().queued).toBe(1);
    expect(outbox.ack([])).toBe(0);
  });

  test('byte accounting is exact: the cursor lands on the file size, multibyte payloads included', () => {
    const root = mkProject();
    writeJournal(root, [
      evt('iteration.started', 'run-a', { iteration_path: 'étape/01-planifier.md' }),
      evt('tool.called', 'run-a', { tool_name: 'Read', success: true }),
      evt('iteration.completed', 'run-a', { iteration_path: 'étape/01-planifier.md', outcome: 'completed' }),
    ]);
    const size = statSync(journalPath(root)).size;
    const outbox = mkOutbox(root);
    const result = outbox.drainJournal();
    expect(result.bytes_consumed).toBe(size);
    expect(outbox.cursor()!.offset).toBe(size);
    expect(result.lines_read).toBe(3);
    // A second drain sees nothing new — proof the offset did not overshoot or
    // fall short of a real byte boundary.
    expect(outbox.drainJournal().lines_read).toBe(0);
  });

  test('a nothing-new drain is a no-op that does not move the cursor', () => {
    const root = mkProject();
    writeJournal(root, [evt('tool.called', 'run-a', {})]);
    const outbox = mkOutbox(root);
    outbox.drainJournal();
    const at = outbox.cursor()!.offset;
    const again = outbox.drainJournal();
    expect(again.lines_read).toBe(0);
    expect(again.enqueued).toBe(0);
    expect(again.restarted).toBe(false);
    expect(outbox.cursor()!.offset).toBe(at);
  });

  test('a missing journal, and unreadable state, both degrade quietly', () => {
    const root = mkProject();
    const outbox = mkOutbox(root);
    expect(outbox.drainJournal().lines_read).toBe(0);
    expect(outbox.cursor()).toBeNull();
    writeFileSync(join(telemetryDir(root), 'state.json'), '{ not json', 'utf-8');
    writeJournal(root, [evt('tool.called', 'run-a', {})]);
    expect(outbox.drainJournal().enqueued).toBe(1);
  });
});
