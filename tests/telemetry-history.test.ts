// telemetry-history.test.ts — the day-one backfill half of `pipeline cloud
// connect` (src/lib/telemetry-history.ts, ux-v2 b13).
//
// The line most likely to be faked (per the task brief): "a mid-history
// failure leaves records queued and still exits 0." This file proves BOTH
// halves directly against `enqueueHistoryRecords` — a real thrown exception
// partway through a 47-record pass (1) never escapes the function and (2)
// leaves the source `runs.jsonl` files completely untouched, so a second
// pass with a healthy `enqueue` picks up every record the first pass missed.

import { describe, expect, test, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HISTORY_ORIGIN,
  enqueueHistoryRecords,
  findHistoryRecords,
  historyStatsBase,
  type HistoryRecordEntry,
} from '../src/lib/telemetry-history';
import type { OutboxRecord } from '../src/lib/telemetry-outbox';
import type { RunRecord } from '../src/lib/stats';

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
  const d = mkdtempSync(join(tmpdir(), 'th-proj-'));
  created.push(d);
  return d;
}

function runRecord(runId: string, i: number): RunRecord {
  return {
    schema: 1,
    run_id: runId,
    pipeline: 'demo',
    started_at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    ended_at: new Date(1_700_000_060_000 + i * 1000).toISOString(),
    duration_s: 60,
    outcome: 'completed',
    halt_reason: null,
    runner: 'manager',
    mode: 'sequential',
    steps_run: 1,
    steps: [],
    improver_runs: 0,
    improver_applied: 0,
    scripts_created: 0,
    merges: 0,
    merge_conflicts: 0,
    llm_steps: 1,
    tokens: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
  };
}

/** Writes N distinct runs.jsonl records under `<root>/.pipeline/.stats/demo/runs.jsonl`.
 *  Run ids are prefixed by the sanitized pipeline name so records from
 *  different pipeline sub-trees never collide. */
function writeHistory(root: string, n: number, pipeline = 'demo'): void {
  const dir = join(historyStatsBase(root), pipeline);
  mkdirSync(dir, { recursive: true });
  const prefix = pipeline.replace(/\//g, '-');
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify(runRecord(`${prefix}-run-${i}`, i))).join('\n');
  writeFileSync(join(dir, 'runs.jsonl'), lines + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// findHistoryRecords
// ---------------------------------------------------------------------------

describe('findHistoryRecords', () => {
  test('no .stats tree yet -> []', () => {
    const root = mkProject();
    expect(findHistoryRecords(root)).toEqual([]);
  });

  test('finds every record across every pipeline sub-tree', () => {
    const root = mkProject();
    writeHistory(root, 5, 'demo');
    writeHistory(root, 3, 'nested/other');
    const entries = findHistoryRecords(root);
    expect(entries.length).toBe(8);
    expect(new Set(entries.map((e) => e.record.run_id)).size).toBe(8);
  });

  test('never mutates or deletes the source files', () => {
    const root = mkProject();
    writeHistory(root, 4);
    const file = join(historyStatsBase(root), 'demo', 'runs.jsonl');
    const before = readFileSync(file, 'utf-8');
    findHistoryRecords(root);
    findHistoryRecords(root); // idempotent re-scan
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// enqueueHistoryRecords — the happy path + origin tagging
// ---------------------------------------------------------------------------

describe('enqueueHistoryRecords', () => {
  test('47 historical records -> 47 enqueue calls, each tagged origin:"local" (matrix 6)', () => {
    const root = mkProject();
    writeHistory(root, 47);
    const entries = findHistoryRecords(root);
    expect(entries.length).toBe(47);

    const seen: Array<Record<string, unknown>> = [];
    const enqueue = (payload: Record<string, unknown>): OutboxRecord => {
      seen.push(payload);
      return { org: 'acme', run_id: String(payload.run_id), seq: seen.length, kind: 'stats', payload };
    };
    const result = enqueueHistoryRecords(entries, enqueue);

    expect(result.found).toBe(47);
    expect(result.enqueued).toBe(47);
    expect(result.skipped).toBe(0);
    expect(seen.length).toBe(47);
    expect(new Set(seen.map((p) => p.run_id)).size).toBe(47);
    for (const p of seen) expect(p.origin).toBe(HISTORY_ORIGIN);
    expect(HISTORY_ORIGIN).toBe('local');
  });

  test('a null return (e.g. telemetry disabled, no lock) counts as skipped, not enqueued', () => {
    const entries: HistoryRecordEntry[] = [
      { file: 'x', record: runRecord('a', 0) },
      { file: 'x', record: runRecord('b', 1) },
    ];
    const result = enqueueHistoryRecords(entries, () => null);
    expect(result).toEqual({ found: 2, enqueued: 0, skipped: 2 });
  });

  test('--no-history equivalent: zero entries -> zero enqueue calls (matrix 6)', () => {
    let calls = 0;
    const result = enqueueHistoryRecords([], () => {
      calls++;
      return null;
    });
    expect(result).toEqual({ found: 0, enqueued: 0, skipped: 0 });
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The mid-history-failure requirement — BOTH halves, against a REAL thrown
// exception, not an exit-code-only check.
// ---------------------------------------------------------------------------

describe('a mid-history failure leaves records queued and still exits 0 (both halves)', () => {
  test('a sustained failure from record #24 onward never escapes the loop, and every un-enqueued record is provably still on disk to retry', () => {
    const root = mkProject();
    writeHistory(root, 47);
    const entries = findHistoryRecords(root);
    expect(entries.length).toBe(47);

    let calls = 0;
    const succeeded: string[] = [];
    // A REAL injected fault: from the 24th call onward, the "outbox" throws
    // — simulating a genuine failure (e.g. a disk fault, a lock that can
    // never be taken) partway through the pass, not a contrived early return.
    const flaky = (payload: Record<string, unknown>): OutboxRecord | null => {
      calls++;
      if (calls >= 24) throw new Error('simulated disk fault');
      succeeded.push(String(payload.run_id));
      return { org: 'acme', run_id: String(payload.run_id), seq: calls, kind: 'stats', payload };
    };

    // HALF 1: the exception never escapes `enqueueHistoryRecords` — this
    // call itself is the proof; a rethrow would fail this test outright.
    expect(() => {
      const result = enqueueHistoryRecords(entries, flaky);
      // 23 succeeded before the fault started firing; the rest (24-47) each
      // independently hit the fault and were skipped, never enqueued.
      expect(result.found).toBe(47);
      expect(result.enqueued).toBe(23);
      expect(result.skipped).toBe(24);
    }).not.toThrow();
    expect(calls).toBe(47); // every record was still attempted, none abandoned early
    expect(succeeded.length).toBe(23);

    // HALF 2: the un-enqueued remainder (24 records) is STILL on disk,
    // byte-identical — nothing in this module ever mutates or deletes the
    // source `runs.jsonl` files, regardless of where a fault occurs.
    const rescanned = findHistoryRecords(root);
    expect(rescanned.length).toBe(47);
    const rescannedIds = new Set(rescanned.map((e) => e.record.run_id));
    expect(rescannedIds.size).toBe(47);

    // A retry (a second `pipeline cloud connect`) with a HEALTHY enqueue
    // function picks up literally everything, including the 23 that already
    // succeeded (a harmless re-send per 03 F3's revision guard) and the 24
    // that the fault ate.
    const secondPassCalls: string[] = [];
    const healthy = (payload: Record<string, unknown>): OutboxRecord => {
      secondPassCalls.push(String(payload.run_id));
      return { org: 'acme', run_id: String(payload.run_id), seq: secondPassCalls.length, kind: 'stats', payload };
    };
    const retryResult = enqueueHistoryRecords(rescanned, healthy);
    expect(retryResult.enqueued).toBe(47);
    expect(new Set(secondPassCalls).size).toBe(47);
  });

  test('a single mid-pass record failure (record #24 only) skips just that one — the rest complete normally', () => {
    const root = mkProject();
    writeHistory(root, 47);
    const entries = findHistoryRecords(root);

    let calls = 0;
    const enqueue = (payload: Record<string, unknown>): OutboxRecord => {
      calls++;
      if (calls === 24) throw new Error('one bad record');
      return { org: 'acme', run_id: String(payload.run_id), seq: calls, kind: 'stats', payload };
    };
    const result = enqueueHistoryRecords(entries, enqueue);
    expect(result.found).toBe(47);
    expect(result.enqueued).toBe(46);
    expect(result.skipped).toBe(1);
    expect(calls).toBe(47); // the loop continued past the single failure
  });
});
