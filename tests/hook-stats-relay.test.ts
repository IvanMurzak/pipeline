/**
 * Stop/SubagentStop stats relay — hooks/stats_relay.ts.
 *
 *   bun test tests/hook-stats-relay.test.ts
 *
 * Two layers of coverage:
 *   • byte-equivalence: the refactored hook (now a thin wrapper over
 *     `lib/stats-backfill.ts#backfillProject`) must still write the exact
 *     same `runs.jsonl` a synthetic SubagentStop payload produced BEFORE the
 *     refactor — proven by spawning a frozen copy of the pre-refactor
 *     algorithm (tests/fixtures/stats_relay.pre-refactor.ts) and the real
 *     hook against two identical fixture trees, then diffing runs.jsonl.
 *   • end-to-end smoke: the real hook, spawned exactly as Claude Code spawns
 *     it, enriches a tokens:null record and no-ops on the documented gates.
 */

import { describe, expect, test, afterAll } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK_PATH = resolve(import.meta.dir, '../../../hooks/stats_relay.ts');
const PRE_REFACTOR_PATH = resolve(import.meta.dir, 'fixtures/stats_relay.pre-refactor.ts');

const created: string[] = [];
afterAll(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

const entry = (ts: string, message: Record<string, unknown>) => JSON.stringify({ timestamp: ts, message }) + '\n';
const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const failResult = (id: string, text: string) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: text });
const okResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' });

/** A run's window, comfortably inside the relay's 48h enrichment window and
 *  wide enough that clock jitter between two subprocess spawns can never
 *  push the transcript entries outside it. */
function runWindow(): { startedAt: string; endedAt: string; entry1: string; entry2: string } {
  const now = Date.now();
  return {
    startedAt: new Date(now - 10 * 60_000).toISOString(),
    endedAt: new Date(now - 1 * 60_000).toISOString(),
    entry1: new Date(now - 8 * 60_000).toISOString(),
    entry2: new Date(now - 7 * 60_000).toISOString(),
  };
}

/** Build one fixture project tree: `.claude/pipeline/` (so findProjectRoot
 *  resolves it), a `.stats/demo/runs.jsonl` with ONE tokens:null manager
 *  record, and a manager transcript whose fold yields nonzero tokens + one
 *  tool failure (exercises both the tokens rewrite and the failure-detail
 *  .log append). */
function buildFixtureTemplate(runId: string): string {
  const root = mkTmp('stats-relay-tpl-');
  const w = runWindow();
  mkdirSync(join(root, '.claude', 'pipeline'), { recursive: true });
  const statsDir = join(root, '.claude', 'pipeline', '.stats', 'demo');
  mkdirSync(join(statsDir, 'runs'), { recursive: true });

  const rec = {
    schema: 1,
    run_id: runId,
    pipeline: 'demo',
    started_at: w.startedAt,
    ended_at: w.endedAt,
    duration_s: 540,
    outcome: 'completed',
    halt_reason: null,
    runner: 'manager',
    mode: 'sequential',
    steps_run: 1,
    steps: [{ id: '01-a', started_at: w.startedAt, seconds: 300, outcome: 'completed', model: 'sonnet', effort: null }],
    improver_runs: 0,
    improver_applied: 0,
    scripts_created: 0,
    merges: 0,
    merge_conflicts: 0,
    llm_steps: 1,
    tokens: null,
  };
  writeFileSync(join(statsDir, 'runs.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  writeFileSync(join(statsDir, 'runs', `${runId}.log`), `run ${runId} — demo — COMPLETED\n`, 'utf8');

  const transcriptDir = join(root, 'transcript-home');
  mkdirSync(transcriptDir, { recursive: true });
  const transcript = join(transcriptDir, `${runId}.jsonl`);
  writeFileSync(
    transcript,
    entry(w.entry1, {
      role: 'assistant',
      usage: { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 },
      content: [use('t1', 'Bash', { command: 'bun test' })],
    }) +
      entry(w.entry2, { role: 'user', content: [failResult('t1', 'bun: command not found')] }) +
      entry(w.entry2, {
        role: 'assistant',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [use('t2', 'Read', { file_path: '/x' })],
      }) +
      entry(w.entry2, { role: 'user', content: [okResult('t2')] }),
    'utf8',
  );

  return root;
}

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function spawnRelay(hookPath: string, cwd: string, payload: Record<string, unknown>): HookRun {
  const env = { ...process.env };
  delete env.PIPELINE_STATS_ENABLED;
  const r = spawnSync(process.execPath, [hookPath], {
    cwd,
    env,
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function runsJsonlPath(root: string): string {
  return join(root, '.claude', 'pipeline', '.stats', 'demo', 'runs.jsonl');
}

describe('stats_relay byte-equivalence (pre-refactor vs refactored)', () => {
  test('SubagentStop payload → identical runs.jsonl from both the frozen pre-refactor script and the real hook', () => {
    const runId = 'relay-eq-' + Math.random().toString(36).slice(2);
    const template = buildFixtureTemplate(runId);
    const transcript = join(template, 'transcript-home', `${runId}.jsonl`);

    const rootOld = mkTmp('stats-relay-old-');
    const rootNew = mkTmp('stats-relay-new-');
    cpSync(template, rootOld, { recursive: true });
    cpSync(template, rootNew, { recursive: true });

    // A real SubagentStop payload names its event — that name is the hook's
    // correlation guarantee (the pipeline-manager matcher), so the hint applies
    // unconditionally on this rung. The frozen pre-refactor script ignores the
    // field entirely, which is exactly what makes the diff meaningful.
    const payloadFor = (root: string) => ({
      session_id: 'sess-1',
      hook_event_name: 'SubagentStop',
      transcript_path: join(root, 'transcript-home', `${runId}.jsonl`),
      cwd: root,
    });

    const oldRun = spawnRelay(PRE_REFACTOR_PATH, rootOld, payloadFor(rootOld));
    const newRun = spawnRelay(HOOK_PATH, rootNew, payloadFor(rootNew));

    expect(oldRun.status).toBe(0);
    expect(newRun.status).toBe(0);

    const oldText = readFileSync(runsJsonlPath(rootOld), 'utf8');
    const newText = readFileSync(runsJsonlPath(rootNew), 'utf8');
    expect(newText).toBe(oldText);

    // Sanity: the record actually got enriched (not a vacuous "both did
    // nothing" pass) — tokens present, nonzero, tool failure recorded.
    const rec = JSON.parse(oldText.trim());
    expect(rec.tokens).not.toBeNull();
    expect(rec.tokens.input).toBe(41);
    expect(rec.tokens.output).toBe(21);
    expect(rec.tokens.tools_called).toBe(2);
    expect(rec.tokens.tools_failed).toBe(1);
    expect(rec.tokens.failed_tools).toEqual({ Bash: 1 });

    void transcript; // referenced only for clarity of intent above
  });
});

describe('stats_relay end-to-end (Stop/SubagentStop, real hook)', () => {
  test('SubagentStop: enriches a tokens:null record from the payload transcript', () => {
    const runId = 'relay-e2e-' + Math.random().toString(36).slice(2);
    const root = buildFixtureTemplate(runId);
    const r = spawnRelay(HOOK_PATH, root, {
      session_id: 'sess-1',
      hook_event_name: 'SubagentStop',
      transcript_path: join(root, 'transcript-home', `${runId}.jsonl`),
      cwd: root,
    });
    expect(r.status).toBe(0);
    const rec = JSON.parse(readFileSync(runsJsonlPath(root), 'utf8').trim());
    expect(rec.tokens).not.toBeNull();
    expect(rec.tokens.tools_failed).toBe(1);
  });

  // The Stop rung (T2 of the E1 cascade) fires on EVERY ordinary session close,
  // where the transcript is the main session's and can span hours of unrelated
  // work. The hook therefore hands the core `hintMode: 'correlated'`, and these
  // two tests pin both sides of that gate.
  test('Stop: an uncorrelated session transcript never enriches the record (no cross-run corruption)', () => {
    const runId = 'relay-stop-uncorr-' + Math.random().toString(36).slice(2);
    const root = buildFixtureTemplate(runId);
    const r = spawnRelay(HOOK_PATH, root, {
      session_id: 'sess-1',
      hook_event_name: 'Stop',
      transcript_path: join(root, 'transcript-home', `${runId}.jsonl`),
      cwd: root,
    });
    expect(r.status).toBe(0);
    // The fixture transcript never mentions the run_id (it is named after it,
    // but the CONTENT is what the correlation check reads) — and the manager
    // locator finds nothing under the fixture's fake home, so the record is
    // left exactly as it was rather than folded from unrelated usage.
    const rec = JSON.parse(readFileSync(runsJsonlPath(root), 'utf8').trim());
    expect(rec.tokens).toBeNull();
  });

  test('Stop: a transcript that names the run enriches it', () => {
    const runId = 'relay-stop-corr-' + Math.random().toString(36).slice(2);
    const root = buildFixtureTemplate(runId);
    const transcript = join(root, 'transcript-home', `${runId}.jsonl`);
    // Same transcript, plus one entry that literally names the run — the
    // content correlation the Stop rung requires (a real session gets this for
    // free: `/pipeline:run` prints the run id into the conversation).
    writeFileSync(
      transcript,
      readFileSync(transcript, 'utf8') +
        JSON.stringify({
          timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: `run ${runId} finished` }] },
        }) +
        '\n',
      'utf8',
    );
    const r = spawnRelay(HOOK_PATH, root, {
      session_id: 'sess-1',
      hook_event_name: 'Stop',
      transcript_path: transcript,
      cwd: root,
    });
    expect(r.status).toBe(0);
    const rec = JSON.parse(readFileSync(runsJsonlPath(root), 'utf8').trim());
    expect(rec.tokens).not.toBeNull();
    expect(rec.tokens.tools_failed).toBe(1);
  });

  test('disabled gate (PIPELINE_STATS_ENABLED=0) → no-op, record stays null', () => {
    const runId = 'relay-disabled-' + Math.random().toString(36).slice(2);
    const root = buildFixtureTemplate(runId);
    const env = { ...process.env, PIPELINE_STATS_ENABLED: '0' };
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      cwd: root,
      env,
      input: JSON.stringify({
        session_id: 'sess-1',
        transcript_path: join(root, 'transcript-home', `${runId}.jsonl`),
        cwd: root,
      }),
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    const rec = JSON.parse(readFileSync(runsJsonlPath(root), 'utf8').trim());
    expect(rec.tokens).toBeNull();
  });

  test('missing transcript_path → no-op, no throw', () => {
    const runId = 'relay-notranscript-' + Math.random().toString(36).slice(2);
    const root = buildFixtureTemplate(runId);
    const r = spawnRelay(HOOK_PATH, root, { session_id: 'sess-1', cwd: root });
    expect(r.status).toBe(0);
    const rec = JSON.parse(readFileSync(runsJsonlPath(root), 'utf8').trim());
    expect(rec.tokens).toBeNull();
  });

  test('malformed stdin → exit 0, no throw', () => {
    const runId = 'relay-malformed-' + Math.random().toString(36).slice(2);
    const root = buildFixtureTemplate(runId);
    const env = { ...process.env };
    delete env.PIPELINE_STATS_ENABLED;
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      cwd: root,
      env,
      input: 'not json {{{',
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
  });
});
