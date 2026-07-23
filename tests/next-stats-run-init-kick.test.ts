// T3 — run-init kick (commands/next.ts `statsIsInit` branch, ~line 1306+8):
// a brand-new run's init fires a best-effort `backfillProject` pass over the
// WHOLE project's .stats/ tree (budgetMs≈1500), closing E1 (a missed
// SubagentStop hook leaves an earlier run's record null forever) a little
// sooner than waiting for the next Stop/SubagentStop. CLI-level integration
// test (mirrors the `next()` harness in tests/next.test.ts): spawns the real
// `pipeline next` subprocess so the wiring at the statsIsInit seam is proven
// end-to-end, not just unit-tested against the core in isolation.

import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeClaudeProjectDir } from '../../pipeline-ui/transcripts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** Canonical layout: `<projectRoot>/.claude/pipeline/demo` is the ACTIVE
 *  pipeline (`--root` for `pipeline next`); a SEPARATE `other` pipeline under
 *  the same project already has a stale tokens:null manager record with a
 *  matching transcript on disk — exactly what the run-init kick should pick
 *  up as a side effect of initializing an unrelated run. */
function scaffold(): { projectRoot: string; pipelineRoot: string; staleRunId: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), 'next-kick-'));
  created.push(projectRoot);
  const pipelineRoot = join(projectRoot, '.claude', 'pipeline', 'demo');
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  writeFileSync(join(pipelineRoot, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  writeFileSync(join(pipelineRoot, 'steps', '01-step.md'), '# step 1\n');

  const staleRunId = 'stale-other-run';
  const now = Date.now();
  // findTranscriptByRunId pre-filters candidate files by birth/mtime vs. the
  // record's window (+/- 5s slack, transcript-stats.ts BIRTHTIME_SLACK_MS) —
  // the transcript fixture below is written moments after this record (same
  // synchronous scaffold, well before the CLI subprocess even spawns), so
  // ended_at must stay close to "now".
  const startedAt = new Date(now - 30_000).toISOString();
  const endedAt = new Date(now).toISOString();
  const otherStatsDir = join(projectRoot, '.claude', 'pipeline', '.stats', 'other');
  mkdirSync(join(otherStatsDir, 'runs'), { recursive: true });
  const rec = {
    schema: 1,
    run_id: staleRunId,
    pipeline: 'other',
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
  writeFileSync(join(otherStatsDir, 'runs.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  writeFileSync(join(otherStatsDir, 'runs', `${staleRunId}.log`), `run ${staleRunId}\n`, 'utf8');

  // Transcript home: the `next()` CLI harness convention (below) sets
  // HOME/USERPROFILE to the pipeline root, so the transcript lives under
  // `<pipelineRoot>/.claude/projects/<encoded projectRoot>/`.
  const transcriptDir = join(pipelineRoot, '.claude', 'projects', encodeClaudeProjectDir(projectRoot));
  mkdirSync(transcriptDir, { recursive: true });
  const mid = new Date(now - 15_000).toISOString();
  const entry = (ts: string, message: Record<string, unknown>) => JSON.stringify({ timestamp: ts, message }) + '\n';
  writeFileSync(
    join(transcriptDir, `${staleRunId}.jsonl`),
    entry(mid, { role: 'user', content: `run_id ${staleRunId} mentioned` }) +
      entry(mid, {
        role: 'assistant',
        usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
      }) +
      entry(mid, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] }),
    'utf8',
  );

  return { projectRoot, pipelineRoot, staleRunId };
}

function nextInit(pipelineRoot: string, runId: string, envOverrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...envOverrides };
  delete env.PIPELINE_UI_RUN_ID;
  delete env.PIPELINE_UI_PARENT_RUN_ID;
  delete env.CLAUDE_SESSION_ID;
  env.USERPROFILE = pipelineRoot;
  env.HOME = pipelineRoot;
  const r = spawnSync(process.execPath, [CLI, 'next', '--root', pipelineRoot, '--run-id', runId], {
    encoding: 'utf8',
    cwd: pipelineRoot,
    env,
  });
  return { json: JSON.parse(r.stdout), status: r.status, stderr: r.stderr };
}

function readStaleRecord(projectRoot: string, staleRunId: string): { tokens: unknown } {
  const text = readFileSync(join(projectRoot, '.claude', 'pipeline', '.stats', 'other', 'runs.jsonl'), 'utf8');
  return JSON.parse(text.trim().split('\n').find((l) => l.includes(staleRunId)) as string);
}

test('run-init kick: initializing a NEW run backfills an unrelated stale record in the same project', () => {
  const { projectRoot, pipelineRoot, staleRunId } = scaffold();
  expect(readStaleRecord(projectRoot, staleRunId).tokens).toBeNull();

  const r = nextInit(pipelineRoot, 'newrun');
  expect(r.status).toBe(0);
  expect(r.json.action).toBe('run-step');

  const after = readStaleRecord(projectRoot, staleRunId);
  expect(after.tokens).not.toBeNull();
  expect((after.tokens as { input: number }).input).toBe(12);
});

test('run-init kick: PIPELINE_STATS_ENABLED=0 disables the kick (and stats entirely) — record stays null', () => {
  const { projectRoot, pipelineRoot, staleRunId } = scaffold();
  const r = nextInit(pipelineRoot, 'newrun2', { PIPELINE_STATS_ENABLED: '0' });
  expect(r.status).toBe(0);
  expect(readStaleRecord(projectRoot, staleRunId).tokens).toBeNull();
});
