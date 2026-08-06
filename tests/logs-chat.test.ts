// `pipeline logs --chat <run-id>` — commands/logs.ts's `runLogsChat` +
// `findRunRecord`. The post-mortem transcript reader for a headless
// (`pipeline drive`) run: local only, offline, renders files already on
// disk. See .taskflow/2026-08-03-plugin-thin/01-remove-local-ui.md, "The
// transcript / chat panel", and tasks/p1-logs-chat.md's Definition of Done.
//
// Covers: run_id → RunRecord resolution (exact + unique-prefix), the
// headless source-select path (pinned per-step sessions + their subagents/
// fan-out, reusing lib/step-transcripts.ts's readStepSessionRefs /
// listStepSessionTranscriptFiles), the manager-mode path (findTranscriptByRunId
// + a render-time window gate), --json mode, the two "clear message, not a
// stack trace" cases the spec calls out (unknown run id; a resolved run with
// no transcript on disk), and — the hard boundary — that nothing here ever
// touches the network.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { findRunRecord, runLogsChat, parseLogsArgs, type LogsArgs } from '../src/commands/logs';
import { encodeClaudeProjectDir } from '../src/lib/vendor/transcript-walk';
import type { RunRecord } from '../src/lib/stats';

let sandbox: string;
let projectRoot: string;
let home: string;
let out: string[];
let realOut: typeof process.stdout.write;
let realErr: typeof process.stderr.write;

beforeEach(() => {
  sandbox = join(tmpdir(), `pipeline-logs-chat-${Math.random().toString(36).slice(2)}`);
  projectRoot = join(sandbox, 'proj');
  home = join(sandbox, 'home');
  mkdirSync(join(projectRoot, '.git'), { recursive: true }); // resolveProjectRoot anchor
  mkdirSync(home, { recursive: true });
  out = [];
  realOut = process.stdout.write.bind(process.stdout);
  realErr = process.stderr.write.bind(process.stderr);
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
  process.stdout.write = realOut;
  process.stderr.write = realErr;
  rmSync(sandbox, { recursive: true, force: true });
});

function opts(overrides: Partial<LogsArgs> = {}): LogsArgs {
  return { ...parseLogsArgs([]), project: projectRoot, color: 'off', ...overrides };
}

function baseRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema: 1,
    run_id: 'abcdef1234567890abcdef1234567890',
    pipeline: 'demo',
    started_at: null,
    ended_at: new Date().toISOString(),
    duration_s: 12,
    outcome: 'completed',
    halt_reason: null,
    runner: 'headless',
    mode: 'driver',
    steps_run: 1,
    steps: [],
    improver_runs: 0,
    improver_applied: 0,
    scripts_created: 0,
    merges: 0,
    merge_conflicts: 0,
    tokens: null,
    ...overrides,
  };
}

function writeRunsJsonl(pipelineRel: string, records: RunRecord[]): void {
  const dir = join(projectRoot, '.pipeline', '.stats', pipelineRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runs.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function writeSessionFile(pipelineRel: string, runId: string, stepId: string, sessionId: string, spawnCwd: string): void {
  const dir = join(projectRoot, '.pipeline', pipelineRel, '.runtime', runId, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${stepId}.json`),
    JSON.stringify({ session_id: sessionId, status: 'done', spawn_cwd: spawnCwd, questions: [], crashes: 0 }),
    'utf8',
  );
}

function writeTranscript(path: string, entries: Record<string, unknown>[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function sessionFile(spawnCwd: string, sessionId: string): string {
  return join(home, '.claude', 'projects', encodeClaudeProjectDir(spawnCwd), `${sessionId}.jsonl`);
}

function assistantTurn(ts: string, text: string, tool?: { id: string; name: string; input: Record<string, unknown> }) {
  const content: unknown[] = [{ type: 'text', text }];
  if (tool) content.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input });
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', content } };
}

function userToolResult(ts: string, toolUseId: string, resultText: string, isError = false) {
  return {
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: resultText }] },
  };
}

function userText(ts: string, text: string) {
  return { type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'text', text }] } };
}

// ---------------------------------------------------------------------------
// findRunRecord
// ---------------------------------------------------------------------------

describe('findRunRecord', () => {
  test('no .stats dir at all → null', () => {
    expect(findRunRecord(projectRoot, 'anything')).toBe(null);
  });

  test('exact run_id match', () => {
    writeRunsJsonl('demo', [baseRunRecord({ run_id: 'run-exact-1' })]);
    const rec = findRunRecord(projectRoot, 'run-exact-1');
    expect(rec?.run_id).toBe('run-exact-1');
  });

  test('unique prefix match resolves', () => {
    writeRunsJsonl('demo', [baseRunRecord({ run_id: 'abcdef123456' })]);
    const rec = findRunRecord(projectRoot, 'abcdef12');
    expect(rec?.run_id).toBe('abcdef123456');
  });

  test('ambiguous prefix (two runs share it) → null, not a guess', () => {
    writeRunsJsonl('demo', [baseRunRecord({ run_id: 'abcdef111111' }), baseRunRecord({ run_id: 'abcdef222222' })]);
    expect(findRunRecord(projectRoot, 'abcdef')).toBe(null);
  });

  test('unknown run_id → null', () => {
    writeRunsJsonl('demo', [baseRunRecord({ run_id: 'run-a' })]);
    expect(findRunRecord(projectRoot, 'run-does-not-exist')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// runLogsChat — headless (`pipeline drive`) source path
// ---------------------------------------------------------------------------

describe('runLogsChat: headless run', () => {
  test('renders the step session + its subagent fan-out, tagged and in order', () => {
    const runId = 'run-headless-1';
    const spawnCwd = join(projectRoot, 'wt');
    writeRunsJsonl('demo', [baseRunRecord({ run_id: runId, runner: 'headless', mode: 'driver' })]);
    writeSessionFile('demo', runId, '01-build', 'sess-1', spawnCwd);

    writeTranscript(sessionFile(spawnCwd, 'sess-1'), [
      assistantTurn('2026-08-01T10:00:00.000Z', 'Running the build.', { id: 't1', name: 'Bash', input: { command: 'bun run build' } }),
      userToolResult('2026-08-01T10:00:01.000Z', 't1', 'build ok'),
      userText('2026-08-01T10:00:02.000Z', 'looks good, continue'),
    ]);
    writeTranscript(join(home, '.claude', 'projects', encodeClaudeProjectDir(spawnCwd), 'sess-1', 'subagents', 'agent-x.jsonl'), [
      assistantTurn('2026-08-01T10:00:30.000Z', 'Fixing a lint issue.'),
    ]);

    const code = runLogsChat(runId, opts(), home);
    expect(code).toBe(0);
    const text = out.join('');

    expect(text).toContain(`run ${runId}`);
    expect(text).toContain('headless/driver');
    expect(text).toContain('step: 01-build');
    expect(text).toContain('ASSISTANT 01-build');
    expect(text).toContain('Running the build.');
    expect(text).toContain('Bash');
    expect(text).toContain('bun run build');
    // tool_result carries its content inline (this reader is post-mortem —
    // errors/results are the whole point, not collapsed behind a toggle).
    expect(text).toContain('↩ tool_result');
    expect(text).toContain('build ok');
    // A user turn with actual text (not just a tool_result) gets its own
    // labeled header.
    expect(text).toContain('USER 01-build');
    expect(text).toContain('looks good, continue');
    // The subagent fan-out is rendered, distinctly tagged from the step's own
    // session turns — this IS the capability the removed chat panel had that
    // `pipeline logs` (no --chat) does not.
    expect(text).toContain('ASSISTANT 01-build (subagent)');
    expect(text).toContain('Fixing a lint issue.');
  });

  test('two steps render in step_id order, each under its own header', () => {
    const runId = 'run-headless-2';
    const spawnCwd = join(projectRoot, 'wt');
    writeRunsJsonl('demo', [baseRunRecord({ run_id: runId, runner: 'headless' })]);
    writeSessionFile('demo', runId, '02-second', 'sess-b', spawnCwd);
    writeSessionFile('demo', runId, '01-first', 'sess-a', spawnCwd);
    writeTranscript(sessionFile(spawnCwd, 'sess-a'), [assistantTurn('2026-08-01T10:00:00.000Z', 'first step turn')]);
    writeTranscript(sessionFile(spawnCwd, 'sess-b'), [assistantTurn('2026-08-01T10:05:00.000Z', 'second step turn')]);

    const code = runLogsChat(runId, opts(), home);
    expect(code).toBe(0);
    const text = out.join('');
    expect(text.indexOf('step: 01-first')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('step: 01-first')).toBeLessThan(text.indexOf('step: 02-second'));
  });

  test('--json emits one JSON object per rendered entry, step/kind-attributed', () => {
    const runId = 'run-headless-json';
    const spawnCwd = join(projectRoot, 'wt');
    writeRunsJsonl('demo', [baseRunRecord({ run_id: runId, runner: 'headless' })]);
    writeSessionFile('demo', runId, '01-build', 'sess-1', spawnCwd);
    writeTranscript(sessionFile(spawnCwd, 'sess-1'), [assistantTurn('2026-08-01T10:00:00.000Z', 'hello')]);

    const code = runLogsChat(runId, opts({ json: true }), home);
    expect(code).toBe(0);
    const lines = out.join('').split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.step_id).toBe('01-build');
    expect(parsed.kind).toBe('session');
    expect(parsed.role).toBe('assistant');
    expect(parsed.entry.message.content[0].text).toBe('hello');
  });

  test('a run that exists but has no transcript on disk: a clear message, not a crash', () => {
    const runId = 'run-no-transcript';
    writeRunsJsonl('demo', [baseRunRecord({ run_id: runId, runner: 'headless' })]);
    // No sessions/ dir was ever written for this run (e.g. it ran elsewhere,
    // or the transcript was already cleaned up).
    const code = runLogsChat(runId, opts(), home);
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain(runId);
    expect(text).toContain('no transcript on disk');
  });
});

// ---------------------------------------------------------------------------
// runLogsChat — manager-mode source path (findTranscriptByRunId + a
// render-time window gate, since a manager session can span unrelated work)
// ---------------------------------------------------------------------------

describe('runLogsChat: manager-mode run', () => {
  test('locates the transcript by run_id correlation and window-gates entries', () => {
    const runId = 'run-manager-1';
    const base = Date.now();
    const startedAt = new Date(base).toISOString();
    const endedAt = new Date(base + 5000).toISOString();
    writeRunsJsonl('demo', [
      baseRunRecord({ run_id: runId, runner: 'manager', mode: 'manager', started_at: startedAt, ended_at: endedAt }),
    ]);

    const transcriptPath = sessionFile(projectRoot, 'sess-manager');
    writeTranscript(transcriptPath, [
      // Too early — outside [started_at - slack, ended_at + slack].
      assistantTurn(new Date(base - 60_000).toISOString(), `stale turn mentioning ${runId}`),
      // In window.
      assistantTurn(new Date(base + 1000).toISOString(), `the actual run ${runId} turn`),
      // Too late.
      assistantTurn(new Date(base + 120_000).toISOString(), `later, unrelated turn mentioning ${runId}`),
    ]);

    const code = runLogsChat(runId, opts(), home);
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('the actual run');
    expect(text).not.toContain('stale turn');
    expect(text).not.toContain('later, unrelated turn');
  });

  test('a manager run whose transcript is not on disk: a clear message', () => {
    const runId = 'run-manager-missing';
    writeRunsJsonl('demo', [baseRunRecord({ run_id: runId, runner: 'manager', started_at: null, ended_at: new Date().toISOString() })]);
    const code = runLogsChat(runId, opts(), home);
    expect(code).toBe(0);
    expect(out.join('')).toContain('no transcript on disk');
  });
});

// ---------------------------------------------------------------------------
// The hard boundary: local only, nothing uploaded — asserted, not assumed.
// ---------------------------------------------------------------------------

describe('runLogsChat: unknown run id', () => {
  test('a run id that was never recorded prints a clear message, not a stack trace', () => {
    writeRunsJsonl('demo', [baseRunRecord({ run_id: 'some-other-run' })]);
    const code = runLogsChat('totally-unknown-run-id', opts(), home);
    expect(code).toBe(0);
    const text = out.join('');
    expect(text).toContain('no run found');
    expect(text).toContain('totally-unknown-run-id');
  });
});

describe('runLogsChat: uploads nothing', () => {
  let realFetch: typeof fetch | undefined;
  let fetchCalls: number;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    fetchCalls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = (...args: unknown[]) => {
      fetchCalls++;
      throw new Error(`unexpected network call: ${JSON.stringify(args[0])}`);
    };
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch | undefined }).fetch = realFetch;
  });

  test('rendering a full headless run touches zero network calls', () => {
    const runId = 'run-offline-check';
    const spawnCwd = join(projectRoot, 'wt');
    writeRunsJsonl('demo', [baseRunRecord({ run_id: runId, runner: 'headless' })]);
    writeSessionFile('demo', runId, '01-build', 'sess-1', spawnCwd);
    writeTranscript(sessionFile(spawnCwd, 'sess-1'), [
      assistantTurn('2026-08-01T10:00:00.000Z', 'a turn', { id: 't1', name: 'Bash', input: { command: 'ls' } }),
      userToolResult('2026-08-01T10:00:01.000Z', 't1', 'ok'),
    ]);

    const code = runLogsChat(runId, opts(), home);
    expect(code).toBe(0);
    expect(out.join('')).toContain('a turn'); // proves the real path ran, not a no-op
    expect(fetchCalls).toBe(0);
  });

  test('the unknown-run-id and missing-transcript messages also touch zero network calls', () => {
    expect(runLogsChat('nope', opts(), home)).toBe(0);
    writeRunsJsonl('demo', [baseRunRecord({ run_id: 'run-x', runner: 'headless' })]);
    expect(runLogsChat('run-x', opts(), home)).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});
