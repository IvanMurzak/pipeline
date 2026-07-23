// T5 — `pipeline stats backfill [--project <path>] [--json]` (commands/
// stats.ts `runBackfill`, dispatched from `rest[0] === 'backfill'` in
// `runStats`). Covers spec 04's verb test-plan line: "--json shape; exit 0
// with no .stats" — plus usage errors and an actual enrichment pass so the
// verb is proven wired to the real `backfillProject` core, not just parsing
// flags.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStats } from '../src/commands/stats';
import { encodeClaudeProjectDir } from '../../pipeline-ui/transcripts';
import type { BackfillReport } from '../src/lib/stats-backfill';

let sandbox: string;
let projectRoot: string;
const savedEnv = { ...process.env };
let out: string[];
let realWrite: typeof process.stdout.write;
let realErrWrite: typeof process.stderr.write;

beforeEach(() => {
  sandbox = join(tmpdir(), `pipeline-stats-backfill-verb-${Math.random().toString(36).slice(2)}`);
  projectRoot = join(sandbox, 'proj');
  mkdirSync(projectRoot, { recursive: true });
  delete process.env.PIPELINE_STATS_ENABLED;
  out = [];
  realWrite = process.stdout.write.bind(process.stdout);
  realErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = realWrite;
  process.stderr.write = realErrWrite;
  rmSync(sandbox, { recursive: true, force: true });
  if (savedEnv.PIPELINE_STATS_ENABLED === undefined) delete process.env.PIPELINE_STATS_ENABLED;
  else process.env.PIPELINE_STATS_ENABLED = savedEnv.PIPELINE_STATS_ENABLED as string;
});

describe('pipeline stats backfill', () => {
  test('no .stats dir yet → exit 0, --json prints an empty-shaped report', () => {
    const code = runStats(['backfill', '--project', projectRoot, '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(out.join('')) as BackfillReport;
    expect(report).toEqual({
      scanned: 0,
      enriched: [],
      skipped_enriched: 0,
      skipped_window: 0,
      transcript_pruned: [],
      zero_fold: [],
      errors: [],
    });
  });

  test('PIPELINE_STATS_ENABLED=0 → exit 0, disabled message, no report printed', () => {
    process.env.PIPELINE_STATS_ENABLED = '0';
    const code = runStats(['backfill', '--project', projectRoot]);
    expect(code).toBe(0);
    expect(out.join('')).toContain('DISABLED');
  });

  test('unknown flag → exit 2, usage on stderr', () => {
    const code = runStats(['backfill', '--bogus']);
    expect(code).toBe(2);
    expect(out.join('')).toContain('usage:');
  });

  test('--project requires a value → exit 2', () => {
    const code = runStats(['backfill', '--project']);
    expect(code).toBe(2);
  });

  test('enriches a real tokens:null manager record and prints a human summary by default', () => {
    const home = join(sandbox, 'home');
    mkdirSync(home, { recursive: true });
    const now = Date.now();
    // findTranscriptByRunId pre-filters candidate files by birth/mtime vs.
    // the record's window (+/- 5s slack, transcript-stats.ts
    // BIRTHTIME_SLACK_MS) — the transcript fixture below is written moments
    // after this record, so ended_at must stay close to "now".
    const startedAt = new Date(now - 30_000).toISOString();
    const endedAt = new Date(now).toISOString();
    const statsDir = join(projectRoot, '.claude', 'pipeline', '.stats', 'demo');
    mkdirSync(join(statsDir, 'runs'), { recursive: true });
    const runId = 'verb-run-1';
    const rec = {
      schema: 1,
      run_id: runId,
      pipeline: 'demo',
      started_at: startedAt,
      ended_at: endedAt,
      duration_s: 540,
      outcome: 'completed',
      halt_reason: null,
      runner: 'manager',
      mode: 'sequential',
      steps_run: 1,
      steps: [{ id: '01-a', started_at: startedAt, seconds: 300, outcome: 'completed', model: 'sonnet', effort: null }],
      improver_runs: 0,
      improver_applied: 0,
      scripts_created: 0,
      merges: 0,
      merge_conflicts: 0,
      llm_steps: 1,
      tokens: null,
    };
    writeFileSync(join(statsDir, 'runs.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
    writeFileSync(join(statsDir, 'runs', `${runId}.log`), `run ${runId}\n`, 'utf8');

    const transcriptDir = join(home, '.claude', 'projects', encodeClaudeProjectDir(projectRoot));
    mkdirSync(transcriptDir, { recursive: true });
    const mid = new Date(now - 15_000).toISOString();
    const entry = (ts: string, message: Record<string, unknown>) => JSON.stringify({ timestamp: ts, message }) + '\n';
    writeFileSync(
      join(transcriptDir, `${runId}.jsonl`),
      entry(mid, { role: 'user', content: `run_id ${runId} mentioned` }) +
        entry(mid, {
          role: 'assistant',
          usage: { input_tokens: 8, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        }) +
        entry(mid, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] }),
      'utf8',
    );

    const savedHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    try {
      const code = runStats(['backfill', '--project', projectRoot]);
      expect(code).toBe(0);
    } finally {
      if (savedHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedHome.USERPROFILE;
      if (savedHome.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome.HOME;
    }

    const summary = out.join('');
    expect(summary).toContain('scanned 1');
    expect(summary).toContain('enriched 1');
    expect(summary).toContain(runId);

    const written = JSON.parse(readFileSync(join(statsDir, 'runs.jsonl'), 'utf8').trim());
    expect(written.tokens.input).toBe(8);
    expect(written.tokens.output).toBe(4);
  });
});
