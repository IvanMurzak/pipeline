// Shared backfill reconciliation core (lib/stats-backfill.ts#backfillProject)
// — spec 04's test plan: manager record enriched; headless record enriched
// via step sessions; pruned; zero-fold; already-enriched skipped; malformed
// record guarded; window boundary; idempotence (second pass = zero writes).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backfillProject, DEFAULT_BACKFILL_WINDOW_MS } from '../src/lib/stats-backfill';
import { encodeClaudeProjectDir } from '../../pipeline-ui/transcripts';
import type { RunRecord } from '../src/lib/stats';

let sandbox: string;
let projectRoot: string;
let home: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  sandbox = join(tmpdir(), `pipeline-backfill-test-${Math.random().toString(36).slice(2)}`);
  projectRoot = join(sandbox, 'proj');
  home = join(sandbox, 'home');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  delete process.env.PIPELINE_STATS_ENABLED;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  if (savedEnv.PIPELINE_STATS_ENABLED === undefined) delete process.env.PIPELINE_STATS_ENABLED;
  else process.env.PIPELINE_STATS_ENABLED = savedEnv.PIPELINE_STATS_ENABLED as string;
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function statsDir(rel = 'demo'): string {
  return join(projectRoot, '.claude', 'pipeline', '.stats', rel);
}

function runsJsonlPath(rel = 'demo'): string {
  return join(statsDir(rel), 'runs.jsonl');
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// findTranscriptByRunId pre-filters candidate transcripts by FILE birth/mtime
// against the record's [started_at, ended_at] window, +/- a 5s slack
// (transcript-stats.ts BIRTHTIME_SLACK_MS) — independent of the per-entry
// window used by the fold itself. Fixture transcripts are written moments
// after the record (same synchronous test body), so `ended_at` must be close
// to "now" (not minutes in the past) or a freshly-written file's birthtime
// falls outside that slack and the locator silently rejects it before ever
// reading its content.
function baseRecord(over: Partial<RunRecord> & { run_id: string }): RunRecord {
  const now = Date.now();
  const startedAt = new Date(now - 30_000).toISOString();
  const endedAt = new Date(now).toISOString();
  return {
    schema: 1,
    run_id: over.run_id,
    pipeline: over.pipeline ?? 'demo',
    started_at: startedAt,
    ended_at: endedAt,
    duration_s: 540,
    outcome: 'completed',
    halt_reason: null,
    runner: 'manager',
    mode: 'sequential',
    steps_run: 1,
    steps: [{ id: '01-a', started_at: startedAt, seconds: 30, outcome: 'completed', model: 'sonnet', effort: null }],
    improver_runs: 0,
    improver_applied: 0,
    scripts_created: 0,
    merges: 0,
    merge_conflicts: 0,
    llm_steps: 1,
    tokens: null,
    ...over,
  };
}

function writeRuns(records: RunRecord[], rel = 'demo'): void {
  mkdirSync(join(statsDir(rel), 'runs'), { recursive: true });
  writeFileSync(runsJsonlPath(rel), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  for (const r of records) writeFileSync(join(statsDir(rel), 'runs', `${r.run_id}.log`), `run ${r.run_id}\n`, 'utf8');
}

const entry = (ts: string, message: Record<string, unknown>) => JSON.stringify({ timestamp: ts, message }) + '\n';
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const failResult = (id: string, text: string) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: text });
const okResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' });

/** Write a manager-style transcript at `~/.claude/projects/<encoded root>/`
 *  containing the run_id (so findTranscriptByRunId can locate it) and usage
 *  entries inside [startedAt, endedAt]. */
function writeManagerTranscript(runId: string, startedAt: string, endedAt: string, opts: { fail?: boolean } = {}): void {
  const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(projectRoot));
  mkdirSync(dir, { recursive: true });
  const mid = new Date((Date.parse(startedAt) + Date.parse(endedAt)) / 2).toISOString();
  const lines =
    entry(mid, { role: 'user', content: `run_id ${runId} in progress` }) +
    entry(mid, {
      role: 'assistant',
      usage: { input_tokens: 30, output_tokens: 15, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      content: [use('t1', 'Bash', { command: 'x' })],
    }) +
    (opts.fail
      ? entry(mid, { role: 'user', content: [failResult('t1', 'boom')] })
      : entry(mid, { role: 'user', content: [okResult('t1')] }));
  writeFileSync(join(dir, `${runId}.jsonl`), lines, 'utf8');
}

function mtimeMs(p: string): number {
  return statSync(p).mtimeMs;
}

// ---------------------------------------------------------------------------
// No .stats dir
// ---------------------------------------------------------------------------

describe('backfillProject', () => {
  test('no .stats dir → empty report, never throws', () => {
    const report = backfillProject(projectRoot);
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

  test('DEFAULT_BACKFILL_WINDOW_MS is 14 days (D10)', () => {
    expect(DEFAULT_BACKFILL_WINDOW_MS).toBe(14 * DAY);
  });

  // -------------------------------------------------------------------------
  // Manager path
  // -------------------------------------------------------------------------

  test('manager record: locates + folds transcript, enriches tokens + tool failures', () => {
    const rec = baseRecord({ run_id: 'mgr-1', runner: 'manager' });
    writeRuns([rec]);
    writeManagerTranscript('mgr-1', rec.started_at as string, rec.ended_at, { fail: true });

    const report = backfillProject(projectRoot, { homeOverride: home });
    expect(report.scanned).toBe(1);
    expect(report.enriched).toEqual(['mgr-1']);

    const written = JSON.parse(readFileSync(runsJsonlPath(), 'utf8').trim());
    expect(written.tokens.input).toBe(30);
    expect(written.tokens.output).toBe(15);
    expect(written.tokens.tools_called).toBe(1);
    expect(written.tokens.tools_failed).toBe(1);
    expect(written.tokens.failed_tools).toEqual({ Bash: 1 });
  });

  test('manager record with no matching transcript → transcript_pruned, record untouched', () => {
    const rec = baseRecord({ run_id: 'mgr-pruned', runner: 'manager' });
    writeRuns([rec]);
    // No transcript written at all under `home`.
    const report = backfillProject(projectRoot, { homeOverride: home });
    expect(report.transcript_pruned).toEqual(['mgr-pruned']);
    expect(report.enriched).toEqual([]);
    const written = JSON.parse(readFileSync(runsJsonlPath(), 'utf8').trim());
    expect(written.tokens).toBeNull();
  });

  test('manager record whose transcript folds to zero → zero_fold, record left null', () => {
    const rec = baseRecord({ run_id: 'mgr-zero', runner: 'manager' });
    writeRuns([rec]);
    // A transcript exists and mentions the run_id, but every entry is OUTSIDE
    // the record's [started_at, ended_at] window, so the fold nets zero.
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(projectRoot));
    mkdirSync(dir, { recursive: true });
    const farPast = new Date(Date.parse(rec.started_at as string) - 5 * DAY).toISOString();
    writeFileSync(
      join(dir, 'mgr-zero.jsonl'),
      entry(farPast, { role: 'user', content: 'run_id mgr-zero mentioned' }) +
        entry(farPast, {
          role: 'assistant',
          usage: { input_tokens: 9, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [],
        }),
      'utf8',
    );
    const report = backfillProject(projectRoot, { homeOverride: home });
    expect(report.zero_fold).toEqual(['mgr-zero']);
    const written = JSON.parse(readFileSync(runsJsonlPath(), 'utf8').trim());
    expect(written.tokens).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Headless path
  // -------------------------------------------------------------------------

  test('headless record: folds pinned step-session transcripts, enriches tokens + tool counts', () => {
    const rec = baseRecord({ run_id: 'hl-1', runner: 'headless', pipeline: 'demo' });
    writeRuns([rec]);

    const pipelineRoot = join(projectRoot, '.claude', 'pipeline', 'demo');
    const sessionsDir = join(pipelineRoot, '.runtime', 'hl-1', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const spawnCwd = pipelineRoot;
    writeFileSync(
      join(sessionsDir, '01-a.json'),
      JSON.stringify({ session_id: 'sess-hl-1', status: 'done', spawn_cwd: spawnCwd, questions: [], crashes: 0 }),
      'utf8',
    );
    const transcriptDir = join(home, '.claude', 'projects', encodeClaudeProjectDir(spawnCwd));
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      join(transcriptDir, 'sess-hl-1.jsonl'),
      entry('2026-07-08T10:00:01.000Z', {
        role: 'assistant',
        usage: { input_tokens: 5, output_tokens: 3 },
        content: [use('t1', 'Read', { file_path: '/x' })],
      }) + entry('2026-07-08T10:00:02.000Z', { role: 'user', content: [okResult('t1')] }),
      'utf8',
    );

    const report = backfillProject(projectRoot, { homeOverride: home });
    expect(report.enriched).toEqual(['hl-1']);
    const written = JSON.parse(readFileSync(runsJsonlPath(), 'utf8').trim());
    expect(written.tokens.input).toBe(5);
    expect(written.tokens.output).toBe(3);
    expect(written.tokens.tools_called).toBe(1);
  });

  test('headless record: usage.json envelope totals take precedence over the transcript fold', () => {
    const rec = baseRecord({ run_id: 'hl-usage', runner: 'headless', pipeline: 'demo' });
    writeRuns([rec]);

    const pipelineRoot = join(projectRoot, '.claude', 'pipeline', 'demo');
    const runtimeDir = join(pipelineRoot, '.runtime', 'hl-usage');
    const sessionsDir = join(runtimeDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, '01-a.json'),
      JSON.stringify({ session_id: 'sess-hl-usage', status: 'done', spawn_cwd: pipelineRoot, questions: [], crashes: 0 }),
      'utf8',
    );
    const transcriptDir = join(home, '.claude', 'projects', encodeClaudeProjectDir(pipelineRoot));
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      join(transcriptDir, 'sess-hl-usage.jsonl'),
      entry('2026-07-08T10:00:01.000Z', {
        role: 'assistant',
        usage: { input_tokens: 5, output_tokens: 3 },
        content: [use('t1', 'Read', { file_path: '/x' })],
      }) + entry('2026-07-08T10:00:02.000Z', { role: 'user', content: [okResult('t1')] }),
      'utf8',
    );
    // Envelope usage.json — DIFFERENT numbers from the transcript fold above,
    // so the assertion proves precedence rather than coincidence.
    writeFileSync(
      join(runtimeDir, 'usage.json'),
      JSON.stringify({ input: 100, output: 50, cache_read: 4, cache_creation: 2, cost_usd: 0.25 }),
      'utf8',
    );

    const report = backfillProject(projectRoot, { homeOverride: home });
    expect(report.enriched).toEqual(['hl-usage']);
    const written = JSON.parse(readFileSync(runsJsonlPath(), 'utf8').trim());
    expect(written.tokens.input).toBe(100);
    expect(written.tokens.output).toBe(50);
    expect(written.tokens.cost_usd).toBe(0.25);
    // tool counts still ride along from the session fold even though the
    // token numbers came from usage.json.
    expect(written.tokens.tools_called).toBe(1);
  });

  test('headless record: no sessions dir and no usage.json → transcript_pruned', () => {
    const rec = baseRecord({ run_id: 'hl-pruned', runner: 'headless', pipeline: 'demo' });
    writeRuns([rec]);
    const report = backfillProject(projectRoot, { homeOverride: home });
    expect(report.transcript_pruned).toEqual(['hl-pruned']);
    const written = JSON.parse(readFileSync(runsJsonlPath(), 'utf8').trim());
    expect(written.tokens).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Common guards
  // -------------------------------------------------------------------------

  test('already-enriched record → skipped_enriched, no locator call, untouched', () => {
    const rec = baseRecord({ run_id: 'already', runner: 'manager', tokens: { input: 1, output: 1, cache_read: 0, cache_creation: 0 } });
    writeRuns([rec]);
    const report = backfillProject(projectRoot, { homeOverride: home });
    expect(report.scanned).toBe(1);
    expect(report.skipped_enriched).toBe(1);
    expect(report.enriched).toEqual([]);
  });

  test('out-of-window record → skipped_window, untouched', () => {
    const now = Date.now();
    const rec = baseRecord({
      run_id: 'stale',
      runner: 'manager',
      started_at: new Date(now - 20 * DAY - 10 * 60_000).toISOString(),
      ended_at: new Date(now - 20 * DAY).toISOString(),
    });
    writeRuns([rec]);
    const report = backfillProject(projectRoot, { homeOverride: home });
    expect(report.skipped_window).toBe(1);
    expect(report.transcript_pruned).toEqual([]);
    expect(report.enriched).toEqual([]);
  });

  test('window boundary: a record just inside a custom windowMs is scanned; just outside is skipped', () => {
    const now = Date.now();
    const inWindow = baseRecord({
      run_id: 'in-window',
      runner: 'manager',
      started_at: new Date(now - HOUR - 10 * 60_000).toISOString(),
      ended_at: new Date(now - HOUR).toISOString(),
    });
    const outWindow = baseRecord({
      run_id: 'out-window',
      runner: 'manager',
      started_at: new Date(now - 3 * HOUR - 10 * 60_000).toISOString(),
      ended_at: new Date(now - 3 * HOUR).toISOString(),
    });
    writeRuns([inWindow, outWindow]);
    const report = backfillProject(projectRoot, { homeOverride: home, windowMs: 2 * HOUR });
    expect(report.skipped_window).toBe(1);
    // The in-window one still gets classified (pruned, since no transcript) —
    // proving it passed the window gate rather than being skipped by it.
    expect(report.transcript_pruned).toEqual(['in-window']);
  });

  test('malformed record (unexpected field types) → guarded into errors, other records still proceed', () => {
    const good = baseRecord({ run_id: 'good-1', runner: 'manager' });
    // `pipeline` as a non-string on a headless record breaks the
    // `.runtime/<run>/sessions` path join — a real per-record guard trip,
    // not a JSON-parse failure (parseRunRecords already filters those out
    // silently, unchanged behavior).
    const bad = baseRecord({ run_id: 'bad-1', runner: 'headless', pipeline: { nested: true } as unknown as string });
    mkdirSync(join(statsDir(), 'runs'), { recursive: true });
    writeFileSync(runsJsonlPath(), [JSON.stringify(bad), JSON.stringify(good)].join('\n') + '\n', 'utf8');
    writeManagerTranscript('good-1', good.started_at as string, good.ended_at, { fail: false });

    const report = backfillProject(projectRoot, { homeOverride: home });
    expect(report.scanned).toBe(2);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]).toContain('bad-1');
    expect(report.enriched).toEqual(['good-1']);
  });

  test("hintMode 'always': uniform fold against the hint regardless of `runner`", () => {
    const rec = baseRecord({ run_id: 'hint-1', runner: 'headless', pipeline: 'demo' });
    writeRuns([rec]);
    // No step-session evidence exists at all for this headless record — the
    // normal headless path would prune it. The hint short-circuit bypasses
    // that entirely, exactly like the pre-refactor relay (never branched on
    // `runner`).
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(projectRoot));
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'hinted.jsonl');
    const mid = new Date((Date.parse(rec.started_at as string) + Date.parse(rec.ended_at)) / 2).toISOString();
    writeFileSync(
      transcript,
      entry(mid, {
        role: 'assistant',
        usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [use('t1', 'Read', { file_path: '/x' })],
      }) + entry(mid, { role: 'user', content: [okResult('t1')] }),
      'utf8',
    );
    const report = backfillProject(projectRoot, { transcriptHint: transcript, hintMode: 'always' });
    expect(report.enriched).toEqual(['hint-1']);
    const written = JSON.parse(readFileSync(runsJsonlPath(), 'utf8').trim());
    expect(written.tokens.input).toBe(7);
  });

  // The default mode is the correlation-safe one: a hint is only applied to a
  // record whose run_id literally occurs in it. Without this, a plain session
  // Stop transcript (hours of unrelated work) would time-window-match a stale
  // tokens-null record and corrupt it with someone else's usage.
  test("hintMode 'correlated' (default): an uncorrelated hint is ignored, the record falls back to its normal source", () => {
    const rec = baseRecord({ run_id: 'hint-uncorr', runner: 'headless', pipeline: 'demo' });
    writeRuns([rec]);
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(projectRoot));
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'uncorrelated.jsonl');
    const mid = new Date((Date.parse(rec.started_at as string) + Date.parse(rec.ended_at)) / 2).toISOString();
    writeFileSync(
      transcript,
      entry(mid, {
        role: 'assistant',
        usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [use('t1', 'Read', { file_path: '/x' })],
      }) + entry(mid, { role: 'user', content: [okResult('t1')] }),
      'utf8',
    );
    const report = backfillProject(projectRoot, { transcriptHint: transcript });
    // Falls through to the headless source select, which has no session
    // evidence for this run → pruned, and the record is left untouched.
    expect(report.enriched).toEqual([]);
    expect(report.transcript_pruned).toEqual(['hint-uncorr']);
    expect(JSON.parse(readFileSync(runsJsonlPath(), 'utf8').trim()).tokens).toBeNull();
  });

  test("hintMode 'correlated' (default): a hint naming the run IS applied", () => {
    const rec = baseRecord({ run_id: 'hint-corr', runner: 'headless', pipeline: 'demo' });
    writeRuns([rec]);
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(projectRoot));
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'correlated.jsonl');
    const mid = new Date((Date.parse(rec.started_at as string) + Date.parse(rec.ended_at)) / 2).toISOString();
    writeFileSync(
      transcript,
      entry(mid, {
        role: 'assistant',
        usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [use('t1', 'Read', { file_path: '/x' })],
      }) +
        entry(mid, { role: 'user', content: [okResult('t1')] }) +
        entry(mid, { role: 'assistant', content: [{ type: 'text', text: 'run hint-corr done' }] }),
      'utf8',
    );
    const report = backfillProject(projectRoot, { transcriptHint: transcript });
    expect(report.enriched).toEqual(['hint-corr']);
    expect(JSON.parse(readFileSync(runsJsonlPath(), 'utf8').trim()).tokens.input).toBe(7);
  });

  test('transcriptHint pointing at a nonexistent file → every candidate reports transcript_pruned', () => {
    const rec = baseRecord({ run_id: 'hint-missing', runner: 'manager' });
    writeRuns([rec]);
    const report = backfillProject(projectRoot, { transcriptHint: join(sandbox, 'nope.jsonl') });
    expect(report.transcript_pruned).toEqual(['hint-missing']);
  });

  // -------------------------------------------------------------------------
  // Idempotence
  // -------------------------------------------------------------------------

  test('idempotence: a second pass over an already-reconciled tree performs zero writes', () => {
    const rec = baseRecord({ run_id: 'idem-1', runner: 'manager' });
    writeRuns([rec]);
    writeManagerTranscript('idem-1', rec.started_at as string, rec.ended_at, { fail: false });

    const first = backfillProject(projectRoot, { homeOverride: home });
    expect(first.enriched).toEqual(['idem-1']);

    const runsFile = runsJsonlPath();
    const logFile = join(statsDir(), 'runs', 'idem-1.log');
    const summaryFile = join(projectRoot, '.claude', 'pipeline', '.stats', 'SUMMARY.md');
    expect(existsSync(summaryFile)).toBe(true);
    const mtimesBefore = { runs: mtimeMs(runsFile), log: mtimeMs(logFile), summary: mtimeMs(summaryFile) };

    const second = backfillProject(projectRoot, { homeOverride: home });
    expect(second.enriched).toEqual([]);
    expect(second.skipped_enriched).toBe(1);

    expect(mtimeMs(runsFile)).toBe(mtimesBefore.runs);
    expect(mtimeMs(logFile)).toBe(mtimesBefore.log);
    expect(mtimeMs(summaryFile)).toBe(mtimesBefore.summary);
  });

  // -------------------------------------------------------------------------
  // budgetMs
  // -------------------------------------------------------------------------

  test('budgetMs: an already-exhausted budget stops the pass before scanning any record', () => {
    const rec = baseRecord({ run_id: 'budget-1', runner: 'manager' });
    writeRuns([rec]);
    const report = backfillProject(projectRoot, { homeOverride: home, budgetMs: -1 });
    expect(report.scanned).toBe(0);
    expect(report.enriched).toEqual([]);
  });
});

/**
 * The hint-correlation index. It replaced a per-record `includes()` scan of the
 * whole transcript, so the property that matters is that it decides IDENTICALLY
 * — including the awkward case of an id sitting inside a longer hash.
 */
describe('hint correlation index', () => {
  const projectRootFor = () => projectRoot;

  test('an id embedded INSIDE a longer hex string still correlates', () => {
    // A 40-char sha whose interior contains the run id — `includes` matched
    // this, so the index must too, or the Stop rung would silently stop
    // enriching such runs.
    const rec = baseRecord({ run_id: 'abcdef123456', runner: 'headless', pipeline: 'demo' });
    writeRuns([rec]);
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(projectRootFor()));
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'embedded.jsonl');
    const mid = new Date((Date.parse(rec.started_at as string) + Date.parse(rec.ended_at)) / 2).toISOString();
    writeFileSync(
      transcript,
      entry(mid, {
        role: 'assistant',
        usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [use('t1', 'Read', { file_path: '/x' })],
      }) +
        entry(mid, { role: 'user', content: [okResult('t1')] }) +
        entry(mid, { role: 'assistant', content: [{ type: 'text', text: 'sha 99abcdef1234567890fedcba0987654321000000 done' }] }),
      'utf8',
    );
    const report = backfillProject(projectRootFor(), { transcriptHint: transcript });
    expect(report.enriched).toEqual(['abcdef123456']);
  });

  test('a NON-hex-shaped run id falls back to a direct scan', () => {
    const rec = baseRecord({ run_id: 'legacy-run-id', runner: 'headless', pipeline: 'demo' });
    writeRuns([rec]);
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(projectRootFor()));
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'legacy.jsonl');
    const mid = new Date((Date.parse(rec.started_at as string) + Date.parse(rec.ended_at)) / 2).toISOString();
    writeFileSync(
      transcript,
      entry(mid, {
        role: 'assistant',
        usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [use('t1', 'Read', { file_path: '/x' })],
      }) +
        entry(mid, { role: 'user', content: [okResult('t1')] }) +
        entry(mid, { role: 'assistant', content: [{ type: 'text', text: 'run legacy-run-id done' }] }),
      'utf8',
    );
    expect(backfillProject(projectRootFor(), { transcriptHint: transcript }).enriched).toEqual(['legacy-run-id']);
  });

  test('an id absent from the hint still does NOT correlate', () => {
    const rec = baseRecord({ run_id: 'ffffffffffff', runner: 'headless', pipeline: 'demo' });
    writeRuns([rec]);
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(projectRootFor()));
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'absent.jsonl');
    const mid = new Date((Date.parse(rec.started_at as string) + Date.parse(rec.ended_at)) / 2).toISOString();
    writeFileSync(
      transcript,
      entry(mid, {
        role: 'assistant',
        usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [use('t1', 'Read', { file_path: '/x' })],
      }) + entry(mid, { role: 'user', content: [okResult('t1')] }),
      'utf8',
    );
    const report = backfillProject(projectRootFor(), { transcriptHint: transcript });
    expect(report.enriched).toEqual([]);
    expect(report.transcript_pruned).toEqual(['ffffffffffff']);
  });
});
