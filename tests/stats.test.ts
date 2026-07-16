// Per-run measurement system (lib/stats.ts): pure folds + the file lifecycle
// (buffer → finalize → runs.jsonl + .log + SUMMARY.md → token enrichment)
// against a real temp directory. Also proves the PIPELINE_STATS_ENABLED gate
// (default ON) and finalize idempotence.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  attributeFailureStep,
  failedToolCounts,
  fmtDuration,
  parseBufferLines,
  renderFailureLogSection,
  renderRunLog,
  renderSummaryMd,
  rewriteRunTokens,
  statsAppend,
  statsEnabled,
  statsEnrichTokens,
  statsFinalizeRun,
  statsLocation,
  stepWindows,
  summarizeRun,
  findRunsFiles,
  parseRunRecords,
  type BufferLine,
  type RunRecord,
  type StepStat,
} from '../src/lib/stats';

let sandbox: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  sandbox = join(tmpdir(), `pipeline-stats-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(sandbox, { recursive: true });
  delete process.env.PIPELINE_STATS_ENABLED;
  delete process.env.PIPELINE_STATS_RUNNER;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  process.env.PIPELINE_STATS_ENABLED = savedEnv.PIPELINE_STATS_ENABLED as string;
  if (savedEnv.PIPELINE_STATS_ENABLED === undefined) delete process.env.PIPELINE_STATS_ENABLED;
  delete process.env.PIPELINE_STATS_RUNNER;
});

/** A canonical consumer layout: <project>/.claude/pipeline/<rel>. */
function mkPipeline(rel: string): string {
  const root = join(sandbox, '.claude', 'pipeline', ...rel.split('/'));
  mkdirSync(root, { recursive: true });
  return root;
}

describe('statsEnabled', () => {
  test('default ON; 0/false/off/no disable; other values stay on', () => {
    expect(statsEnabled()).toBe(true);
    for (const v of ['0', 'false', 'OFF', 'no']) {
      process.env.PIPELINE_STATS_ENABLED = v;
      expect(statsEnabled()).toBe(false);
    }
    process.env.PIPELINE_STATS_ENABLED = '1';
    expect(statsEnabled()).toBe(true);
  });
});

describe('statsLocation', () => {
  test('resolves the shared .claude/pipeline/.stats base + rel path', () => {
    const root = mkPipeline('workflows/implement-task');
    const loc = statsLocation(root);
    expect(loc.base).toBe(join(sandbox, '.claude', 'pipeline', '.stats'));
    expect(loc.rel).toBe('workflows/implement-task');
  });

  test('nested family target shares the same base', () => {
    const root = mkPipeline('workflows/release/targets/godot-ai-csg');
    const loc = statsLocation(root);
    expect(loc.base).toBe(join(sandbox, '.claude', 'pipeline', '.stats'));
    expect(loc.rel).toBe('workflows/release/targets/godot-ai-csg');
  });

  test('non-canonical layout falls back to a sibling .stats', () => {
    const root = join(sandbox, 'elsewhere', 'my-pipe');
    mkdirSync(root, { recursive: true });
    const loc = statsLocation(root);
    expect(loc.base).toBe(join(sandbox, 'elsewhere', '.stats'));
    expect(loc.rel).toBe('my-pipe');
  });
});

describe('summarizeRun (pure fold)', () => {
  const t0 = Date.parse('2026-07-08T10:00:00Z');
  const lines: BufferLine[] = [
    { t: t0, k: 'run.started', mode: 'sequential', model: 'sonnet' },
    { t: t0 + 1_000, k: 'step.started', path: '/p/steps/01-analyze.md', model: 'sonnet' },
    { t: t0 + 61_000, k: 'step.completed', path: '/p/steps/01-analyze.md', outcome: 'completed' },
    { t: t0 + 62_000, k: 'improver.started' },
    { t: t0 + 90_000, k: 'improver.completed', applied: true },
    { t: t0 + 91_000, k: 'script.started' },
    { t: t0 + 120_000, k: 'script.completed', outcome: 'created' },
    { t: t0 + 121_000, k: 'step.started', path: '/p/steps/02-implement.md', model: null },
    { t: t0 + 421_000, k: 'step.completed', path: '/p/steps/02-implement.md', outcome: 'completed' },
  ];

  test('durations, counts, and step stats', () => {
    const rec = summarizeRun(lines, {
      runId: 'r1',
      pipeline: 'workflows/implement-task',
      outcome: 'completed',
      haltReason: null,
      runner: 'manager',
      endedMs: t0 + 430_000,
    });
    expect(rec.duration_s).toBe(430);
    expect(rec.mode).toBe('sequential');
    expect(rec.steps_run).toBe(2);
    expect(rec.steps[0]).toEqual({
      id: '01-analyze',
      started_at: new Date(t0 + 1_000).toISOString(),
      seconds: 60,
      outcome: 'completed',
      model: 'sonnet',
      effort: null,
    });
    expect(rec.steps[1].seconds).toBe(300);
    expect(rec.improver_runs).toBe(1);
    expect(rec.improver_applied).toBe(1);
    expect(rec.scripts_created).toBe(1);
    // Both step.started lines are untagged (agent) ⇒ llm_steps 2, so the run
    // stays pending for token enrichment.
    expect(rec.llm_steps).toBe(2);
    expect(rec.tokens).toBeNull();
  });

  test('empty buffer (stats enabled mid-run) still yields a record', () => {
    const rec = summarizeRun([], {
      runId: 'r2',
      pipeline: 'p',
      outcome: 'halted',
      haltReason: 'boom',
      runner: 'manager',
      endedMs: t0,
    });
    expect(rec.started_at).toBeNull();
    expect(rec.duration_s).toBeNull();
    expect(rec.halt_reason).toBe('boom');
  });

  test('layer completions (step_id, no matching start) get null seconds', () => {
    const rec = summarizeRun(
      [
        { t: t0, k: 'run.started', mode: 'parallel' },
        { t: t0 + 1000, k: 'step.completed', step_id: 'a', outcome: 'completed' },
      ],
      { runId: 'r3', pipeline: 'p', outcome: 'completed', haltReason: null, runner: 'manager', endedMs: t0 + 2000 },
    );
    expect(rec.steps[0]).toEqual({ id: 'a', started_at: null, seconds: null, outcome: 'completed', model: null, effort: null });
  });

  test('llm_steps counts only untagged (agent) step.starts; script steps + their fail class are tagged (§12)', () => {
    const rec = summarizeRun(
      [
        { t: t0, k: 'run.started', mode: 'sequential', model: 'sonnet' },
        // agent step
        { t: t0 + 1_000, k: 'step.started', path: '/p/steps/01-build.md', model: 'sonnet' },
        { t: t0 + 2_000, k: 'step.completed', path: '/p/steps/01-build.md', outcome: 'completed' },
        // script step that FAILED (halt) — tagged step_type + failure_class
        { t: t0 + 3_000, k: 'step.started', path: '/p/steps/02-wait-ci.md', step_type: 'script' },
        {
          t: t0 + 4_000,
          k: 'step.completed',
          path: '/p/steps/02-wait-ci.md',
          outcome: 'halted',
          step_type: 'script',
          failure_class: 'contract',
        },
      ],
      { runId: 'mix', pipeline: 'p', outcome: 'halted', haltReason: 'boom', runner: 'manager', endedMs: t0 + 5_000 },
    );
    // Only the agent step.started counts; the script dispatch is excluded.
    expect(rec.llm_steps).toBe(1);
    // A run that HAD an agent step stays pending for enrichment.
    expect(rec.tokens).toBeNull();
    const script = rec.steps.find((s) => s.id === '02-wait-ci')!;
    expect(script.step_type).toBe('script');
    expect(script.failure_class).toBe('contract');
    // Agent steps carry NO tag keys (byte-identical to pre-0.71 records).
    const agent = rec.steps.find((s) => s.id === '01-build')!;
    expect(agent.step_type).toBeUndefined();
    expect(agent.failure_class).toBeUndefined();
  });

  test('a script-only run (llm_steps 0) finalizes tokens as explicit zeros, not pending (§12)', () => {
    const rec = summarizeRun(
      [
        { t: t0, k: 'run.started', mode: 'sequential', model: null },
        { t: t0 + 1_000, k: 'step.started', path: '/p/steps/01-wait-ci.md', step_type: 'script' },
        { t: t0 + 2_000, k: 'step.completed', path: '/p/steps/01-wait-ci.md', outcome: 'completed', step_type: 'script' },
      ],
      { runId: 'z', pipeline: 'p', outcome: 'completed', haltReason: null, runner: 'manager', endedMs: t0 + 3_000 },
    );
    expect(rec.llm_steps).toBe(0);
    expect(rec.tokens).toEqual({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });
  });

  test('a HALTED run with llm_steps 0 stays pending (tokens:null), NOT zeroed (§12 outcome gate)', () => {
    // An agent-mode run that halts BEFORE dispatching any step (e.g. a worktree
    // provision-hook failure at init — run.started is buffered before the hooks
    // run). llm_steps is 0, but the run DID spawn the manager, so tokens must
    // stay null for the SubagentStop relay to restore the manager's real spend +
    // tool-failure forensics — it must NOT be zeroed like a completed all-script
    // run. The gate is `outcome === 'completed'`, so a 'halted' outcome ⇒ null.
    const rec = summarizeRun(
      [{ t: t0, k: 'run.started', mode: 'sequential', model: 'sonnet' }],
      {
        runId: 'h',
        pipeline: 'p',
        outcome: 'halted',
        haltReason: 'worktree provision hook failed',
        runner: 'manager',
        endedMs: t0 + 500,
      },
    );
    expect(rec.llm_steps).toBe(0);
    expect(rec.tokens).toBeNull();
  });
});

describe('fmtDuration', () => {
  test('formats s / m / h', () => {
    expect(fmtDuration(42)).toBe('42s');
    expect(fmtDuration(137)).toBe('2m17s');
    expect(fmtDuration(3840)).toBe('1h04m');
    expect(fmtDuration(null)).toBe('—');
  });
});

describe('file lifecycle: append → finalize → enrich', () => {
  test('finalize folds the buffer into runs.jsonl + .log + SUMMARY.md and deletes the buffer', () => {
    const root = mkPipeline('workflows/implement-task');
    statsAppend(root, 'run-a', { k: 'run.started', mode: 'sequential', model: null });
    statsAppend(root, 'run-a', { k: 'step.started', path: join(root, 'steps', '01-x.md'), model: 'opus' });
    statsAppend(root, 'run-a', { k: 'step.completed', path: join(root, 'steps', '01-x.md'), outcome: 'completed' });
    const base = join(sandbox, '.claude', 'pipeline', '.stats');
    const bufferFile = join(base, 'workflows/implement-task', 'runs', 'run-a.jsonl');
    expect(existsSync(bufferFile)).toBe(true);

    statsFinalizeRun(root, 'run-a', 'completed', null);

    expect(existsSync(bufferFile)).toBe(false);
    const records = parseRunRecords(readFileSync(join(base, 'workflows/implement-task', 'runs.jsonl'), 'utf8'));
    expect(records.length).toBe(1);
    expect(records[0].outcome).toBe('completed');
    expect(records[0].runner).toBe('manager');
    expect(records[0].steps[0].id).toBe('01-x');
    // One untagged (agent) step ⇒ llm_steps 1, so the run stays pending.
    expect(records[0].llm_steps).toBe(1);
    const log = readFileSync(join(base, 'workflows/implement-task', 'runs', 'run-a.log'), 'utf8');
    expect(log).toContain('COMPLETED');
    expect(log).toContain('01-x');
    expect(log).toContain('tokens: pending');
    const summary = readFileSync(join(base, 'SUMMARY.md'), 'utf8');
    expect(summary).toContain('workflows/implement-task');
    expect(summary).toContain('run-a');
  });

  test('finalize is idempotent per run_id', () => {
    const root = mkPipeline('p1');
    statsAppend(root, 'run-b', { k: 'run.started' });
    statsFinalizeRun(root, 'run-b', 'completed', null);
    statsFinalizeRun(root, 'run-b', 'completed', null); // terminal `next` repeats
    const base = join(sandbox, '.claude', 'pipeline', '.stats');
    const records = parseRunRecords(readFileSync(join(base, 'p1', 'runs.jsonl'), 'utf8'));
    expect(records.length).toBe(1);
  });

  test('PIPELINE_STATS_ENABLED=0 writes nothing at all', () => {
    process.env.PIPELINE_STATS_ENABLED = '0';
    const root = mkPipeline('p2');
    statsAppend(root, 'run-c', { k: 'run.started' });
    statsFinalizeRun(root, 'run-c', 'completed', null);
    expect(existsSync(join(sandbox, '.claude', 'pipeline', '.stats'))).toBe(false);
  });

  test('runner tag from PIPELINE_STATS_RUNNER (headless drive)', () => {
    process.env.PIPELINE_STATS_RUNNER = 'headless';
    const root = mkPipeline('p3');
    statsAppend(root, 'run-d', { k: 'run.started' });
    statsFinalizeRun(root, 'run-d', 'completed', null);
    const base = join(sandbox, '.claude', 'pipeline', '.stats');
    const [rec] = parseRunRecords(readFileSync(join(base, 'p3', 'runs.jsonl'), 'utf8'));
    expect(rec.runner).toBe('headless');
  });

  test('token enrichment rewrites the record, appends to the log, refreshes SUMMARY', () => {
    const root = mkPipeline('p4');
    statsAppend(root, 'run-e', { k: 'run.started' });
    // An untagged (agent) step ⇒ llm_steps>0 ⇒ tokens finalizes null (pending),
    // so the transcript-fold enrichment below applies (a zero-llm-step run would
    // finalize as zeros and skip enrichment).
    statsAppend(root, 'run-e', { k: 'step.started', path: join(root, 'steps', '01-x.md'), model: 'opus' });
    statsAppend(root, 'run-e', { k: 'step.completed', path: join(root, 'steps', '01-x.md'), outcome: 'completed' });
    statsFinalizeRun(root, 'run-e', 'completed', null);
    const base = join(sandbox, '.claude', 'pipeline', '.stats');
    const runsFile = join(base, 'p4', 'runs.jsonl');

    const ok = statsEnrichTokens(base, runsFile, 'run-e', {
      input: 1000,
      output: 25_000,
      cache_read: 400_000,
      cache_creation: 9000,
      tools_called: 42,
      agents_spawned: 3,
    });
    expect(ok).toBe(true);
    const [rec] = parseRunRecords(readFileSync(runsFile, 'utf8'));
    expect(rec.tokens?.output).toBe(25_000);
    expect(readFileSync(join(base, 'p4', 'runs', 'run-e.log'), 'utf8')).toContain('out=25000');
    expect(readFileSync(join(base, 'SUMMARY.md'), 'utf8')).toContain('25,000');
    // second enrichment is a no-op (tokens no longer null)
    expect(statsEnrichTokens(base, runsFile, 'run-e', { input: 1, output: 1, cache_read: 0, cache_creation: 0 })).toBe(
      false,
    );
  });

  test('failure enrichment persists failed_tools and appends the tool-fails .log section', () => {
    const root = mkPipeline('p6');
    statsAppend(root, 'run-f', { k: 'run.started' });
    // An agent step so llm_steps>0 ⇒ tokens pending ⇒ enrichment applies.
    statsAppend(root, 'run-f', { k: 'step.started', path: join(root, 'steps', '01-x.md'), model: 'opus' });
    statsAppend(root, 'run-f', { k: 'step.completed', path: join(root, 'steps', '01-x.md'), outcome: 'completed' });
    statsFinalizeRun(root, 'run-f', 'completed', null);
    const base = join(sandbox, '.claude', 'pipeline', '.stats');
    const runsFile = join(base, 'p6', 'runs.jsonl');

    const ok = statsEnrichTokens(
      base,
      runsFile,
      'run-f',
      // failed_tools deliberately NOT passed — statsEnrichTokens derives it
      // from the failures list.
      {
        input: 10,
        output: 20,
        cache_read: 0,
        cache_creation: 0,
        tools_called: 9,
        tools_failed: 2,
      },
      [
        { ts: '2026-07-08T10:01:00.000Z', tool: 'Bash', step: '01-x', error: 'command not found: bun' },
        { ts: '2026-07-08T10:02:00.000Z', tool: 'Bash', step: null, error: 'exit code 1\nlong\noutput' },
      ],
    );
    expect(ok).toBe(true);
    const [rec] = parseRunRecords(readFileSync(runsFile, 'utf8'));
    expect(rec.tokens?.tools_failed).toBe(2);
    expect(rec.tokens?.failed_tools).toEqual({ Bash: 2 });
    const log = readFileSync(join(base, 'p6', 'runs', 'run-f.log'), 'utf8');
    expect(log).toContain('tool_fails=2');
    expect(log).toContain('tool fails (2):');
    expect(log).toContain('Bash  [01-x]  command not found: bun');
    expect(log).toContain('exit code 1 long output'); // newlines collapsed
    const summary = readFileSync(join(base, 'SUMMARY.md'), 'utf8');
    expect(summary).toContain('2 (Bash 2)');
  });

  test('script-only run finalizes tokens as zeros — .log is not pending and enrichment is a no-op (§12)', () => {
    const root = mkPipeline('scripts-only');
    statsAppend(root, 'run-z', { k: 'run.started', mode: 'sequential', model: null });
    statsAppend(root, 'run-z', { k: 'step.started', path: join(root, 'steps', '01-ci.md'), step_type: 'script' });
    statsAppend(root, 'run-z', {
      k: 'step.completed',
      path: join(root, 'steps', '01-ci.md'),
      outcome: 'completed',
      step_type: 'script',
    });
    statsFinalizeRun(root, 'run-z', 'completed', null);

    const base = join(sandbox, '.claude', 'pipeline', '.stats');
    const runsFile = join(base, 'scripts-only', 'runs.jsonl');
    const [rec] = parseRunRecords(readFileSync(runsFile, 'utf8'));
    expect(rec.llm_steps).toBe(0);
    expect(rec.tokens).toEqual({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });

    const log = readFileSync(join(base, 'scripts-only', 'runs', 'run-z.log'), 'utf8');
    expect(log).not.toContain('tokens: pending');
    expect(log).toContain('tokens: none — 0 LLM steps');
    expect(log).toContain('01-ci'); // the script step line
    expect(log).toContain('(script)');

    // The stats-relay path only rewrites tokens===null records — a zero-token
    // run is already finalized, so enrichment is a no-op (never overwritten).
    expect(
      rewriteRunTokens(readFileSync(runsFile, 'utf8'), 'run-z', { input: 5, output: 5, cache_read: 0, cache_creation: 0 }),
    ).toBeNull();
  });

  test('a HALTED zero-dispatch run finalizes tokens:null; .log reads "pending", stays enrichable (§12 outcome gate)', () => {
    const root = mkPipeline('halt-zero');
    // Manager spawned, run.started buffered, then the run halts BEFORE any step
    // dispatch (e.g. worktree provision-hook failure at init). llm_steps 0,
    // outcome halted ⇒ tokens must stay null (unlike a completed all-script run).
    statsAppend(root, 'run-hz', { k: 'run.started', mode: 'sequential', model: 'sonnet' });
    statsFinalizeRun(root, 'run-hz', 'halted', 'worktree provision hook failed');

    const base = join(sandbox, '.claude', 'pipeline', '.stats');
    const runsFile = join(base, 'halt-zero', 'runs.jsonl');
    const [rec] = parseRunRecords(readFileSync(runsFile, 'utf8'));
    expect(rec.llm_steps).toBe(0);
    expect(rec.tokens).toBeNull();

    const log = readFileSync(join(base, 'halt-zero', 'runs', 'run-hz.log'), 'utf8');
    expect(log).toContain('tokens: pending');
    expect(log).not.toContain('all deterministic');

    // Because tokens is null, the relay enrichment path CAN still restore the
    // manager's real spend (a completed all-script run zeroes + is skipped).
    expect(
      rewriteRunTokens(readFileSync(runsFile, 'utf8'), 'run-hz', {
        input: 700,
        output: 1200,
        cache_read: 0,
        cache_creation: 0,
      }),
    ).not.toBeNull();
  });

  test('a script FAILURE renders its class in the run .log beside the step timeline (§12)', () => {
    const root = mkPipeline('script-fail');
    statsAppend(root, 'run-sf', { k: 'run.started', mode: 'sequential', model: null });
    statsAppend(root, 'run-sf', { k: 'step.started', path: join(root, 'steps', '01-push.md'), step_type: 'script' });
    statsAppend(root, 'run-sf', {
      k: 'step.completed',
      path: join(root, 'steps', '01-push.md'),
      outcome: 'halted',
      step_type: 'script',
      failure_class: 'crash',
    });
    statsFinalizeRun(root, 'run-sf', 'halted', 'script step 01-push failed (crash)');
    const base = join(sandbox, '.claude', 'pipeline', '.stats');
    const log = readFileSync(join(base, 'script-fail', 'runs', 'run-sf.log'), 'utf8');
    expect(log).toContain('01-push');
    expect(log).toContain('failed: crash');
  });

  test('a pre-0.71 record without llm_steps still parses and stays enrichable (pending)', () => {
    // A record shape as written before this change: no llm_steps, tokens null.
    const legacy =
      JSON.stringify({
        schema: 1,
        run_id: 'old',
        pipeline: 'p',
        started_at: '2026-01-01T00:00:00.000Z',
        ended_at: '2026-01-01T00:05:00.000Z',
        duration_s: 300,
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
        tokens: null,
      }) + '\n';
    const [rec] = parseRunRecords(legacy);
    expect(rec.run_id).toBe('old');
    expect(rec.llm_steps).toBeUndefined(); // absent ⇒ unknown, legacy behavior
    // tokens null ⇒ the relay enrichment path still fills it in (unchanged).
    expect(rewriteRunTokens(legacy, 'old', { input: 1, output: 2, cache_read: 0, cache_creation: 0 })).not.toBeNull();
  });
});

describe('rewriteRunTokens (pure)', () => {
  test('only the matching tokens-null record is rewritten', () => {
    const a = JSON.stringify({ run_id: 'a', tokens: null });
    const b = JSON.stringify({ run_id: 'b', tokens: { input: 1, output: 2, cache_read: 0, cache_creation: 0 } });
    const text = a + '\n' + b + '\n';
    const out = rewriteRunTokens(text, 'a', { input: 5, output: 6, cache_read: 7, cache_creation: 8 });
    expect(out).not.toBeNull();
    expect(out).toContain('"output":6');
    expect(out).toContain('"output":2');
    expect(rewriteRunTokens(text, 'missing', { input: 0, output: 0, cache_read: 0, cache_creation: 0 })).toBeNull();
  });
});

describe('attributeFailureStep + stepWindows (pure)', () => {
  const step = (id: string, startedAt: string | null, seconds: number | null): StepStat => ({
    id,
    started_at: startedAt,
    seconds,
    outcome: 'completed',
    model: null,
    effort: null,
  });
  const windows = stepWindows([
    step('01-a', '2026-07-08T10:00:00.000Z', 60),
    step('02-b', '2026-07-08T10:02:00.000Z', 120),
  ]);

  test('maps a timestamp inside exactly one step window to that step', () => {
    expect(attributeFailureStep(windows, '2026-07-08T10:00:30.000Z')).toBe('01-a');
    expect(attributeFailureStep(windows, '2026-07-08T10:03:00.000Z')).toBe('02-b');
  });

  test('outside every window, missing data, or bad timestamp → null', () => {
    expect(attributeFailureStep(windows, '2026-07-08T10:01:30.000Z')).toBeNull(); // improver gap
    expect(attributeFailureStep(windows, 'not-a-date')).toBeNull();
    expect(stepWindows([step('x', null, null)])).toEqual([]);
    expect(attributeFailureStep([], '2026-07-08T10:00:30.000Z')).toBeNull();
  });

  test('overlapping windows of DIFFERENT steps (DAG layer) → null, never a guess', () => {
    const overlap = stepWindows([
      step('a', '2026-07-08T10:00:00.000Z', 300),
      step('b', '2026-07-08T10:00:00.000Z', 300),
    ]);
    expect(attributeFailureStep(overlap, '2026-07-08T10:01:00.000Z')).toBeNull();
  });

  test('exact containment beats a slack-only match at a sequential boundary', () => {
    // Failure in step A's final second: inside A, within 2s slack of B's start.
    const seq = stepWindows([
      step('a', '2026-07-08T10:00:00.000Z', 60),
      step('b', '2026-07-08T10:01:01.000Z', 60),
    ]);
    expect(attributeFailureStep(seq, '2026-07-08T10:00:59.500Z')).toBe('a');
  });

  test('re-executed step: two windows with the SAME id are one match, not ambiguity', () => {
    const looped = stepWindows([
      step('02-impl', '2026-07-08T10:00:00.000Z', 60),
      step('02-impl', '2026-07-08T10:01:01.000Z', 60),
    ]);
    // Inside the slack overlap of both same-id windows.
    expect(attributeFailureStep(looped, '2026-07-08T10:01:00.500Z')).toBe('02-impl');
  });
});

describe('renderFailureLogSection + failedToolCounts (pure)', () => {
  test('caps at 30 lines and notes the remainder', () => {
    const failures = Array.from({ length: 35 }, (_, i) => ({
      ts: `2026-07-08T10:00:${String(i).padStart(2, '0')}.000Z`,
      tool: 'Bash',
      step: null,
      error: `err ${i}`,
    }));
    const section = renderFailureLogSection(failures, 35);
    expect(section).toContain('tool fails (35):');
    expect(section.trimEnd().split('\n').length).toBe(32); // header + 30 + remainder note
    expect(section).toContain('(+5 more');
  });

  test('failedToolCounts groups by tool with ? for unknown', () => {
    expect(
      failedToolCounts([
        { tool: 'Bash' },
        { tool: 'Bash' },
        { tool: 'Edit' },
        { tool: null },
      ]),
    ).toEqual({ Bash: 2, Edit: 1, '?': 1 });
  });
});

describe('renderSummaryMd (pure)', () => {
  test('rollup + recent runs + in-flight section', () => {
    const rec = (over: Partial<RunRecord>): RunRecord => ({
      schema: 1,
      run_id: 'r',
      pipeline: 'p',
      started_at: '2026-07-08T10:00:00.000Z',
      ended_at: '2026-07-08T10:10:00.000Z',
      duration_s: 600,
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
      tokens: null,
      ...over,
    });
    const md = renderSummaryMd(
      [rec({ run_id: 'r1' }), rec({ run_id: 'r2', outcome: 'halted', halt_reason: 'x failed' })],
      [{ pipeline: 'p', runId: 'r3', ageH: 30 }],
    );
    expect(md).toContain('| p | 2 | 1 | 1 |');
    expect(md).toContain('halted — x failed');
    expect(md).toContain('likely crashed/killed');
    expect(md).toContain('pending');

    // Tool-fails columns: avg in the rollup, count + worst offender per run,
    // '—' for unmeasured, '0' (not '—') for a measured clean run.
    const tk = (over: Partial<NonNullable<RunRecord['tokens']>>) => ({
      input: 1,
      output: 2,
      cache_read: 0,
      cache_creation: 0,
      ...over,
    });
    const md2 = renderSummaryMd(
      [
        rec({ run_id: 'r4', tokens: tk({ tools_failed: 7, failed_tools: { Bash: 5, Edit: 2 } }) }),
        rec({ run_id: 'r5', tokens: tk({ tools_failed: 0 }) }),
        rec({ run_id: 'r6' }), // tokens null → unmeasured
      ],
      [],
    );
    expect(md2).toContain('| 3.5 |'); // avg over the two measured runs
    expect(md2).toContain('| 7 (Bash 5) | r4 |');
    expect(md2).toContain('| 0 | r5 |');
    expect(md2).toContain('| — | r6 |');
  });
});

describe('parse helpers tolerate corruption', () => {
  test('parseBufferLines / parseRunRecords skip bad lines', () => {
    expect(parseBufferLines('{"t":1,"k":"run.started"}\nnot json\n\n').length).toBe(1);
    expect(parseRunRecords('{"run_id":"x"}\n{oops\n').length).toBe(1);
  });

  test('findRunsFiles skips per-run runs/ dirs', () => {
    const root = mkPipeline('p5');
    statsAppend(root, 'r', { k: 'run.started' });
    statsFinalizeRun(root, 'r', 'completed', null);
    const base = join(sandbox, '.claude', 'pipeline', '.stats');
    // plant a decoy runs.jsonl inside the per-run dir — must NOT be picked up
    writeFileSync(join(base, 'p5', 'runs', 'runs.jsonl'), '{"run_id":"decoy"}\n', 'utf8');
    const files = findRunsFiles(base);
    expect(files.length).toBe(1);
    expect(files[0]).toBe(join(base, 'p5', 'runs.jsonl'));
  });
});
