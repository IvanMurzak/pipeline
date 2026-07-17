// Drive-run transcript fold (lib/step-transcripts.ts): reading the pinned
// per-step session refs and folding tool counts + exact-step-attributed
// failures from a fake ~/.claude/projects tree (homeOverride).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { foldStepSessionTranscripts, readStepSessionRefs } from '../src/lib/step-transcripts';
import { encodeClaudeProjectDir } from '../src/lib/vendor/transcript-walk';

let sandbox: string;
let home: string;
let sessionsDir: string;
let spawnCwd: string;

beforeEach(() => {
  sandbox = join(tmpdir(), `pipeline-step-transcripts-${Math.random().toString(36).slice(2)}`);
  home = join(sandbox, 'home');
  sessionsDir = join(sandbox, 'run', 'sessions');
  spawnCwd = join(sandbox, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function writeSession(stepId: string, sessionId: string, previous: string[] = []): void {
  writeFileSync(
    join(sessionsDir, `${stepId}.json`),
    JSON.stringify({
      session_id: sessionId,
      status: 'done',
      spawn_cwd: spawnCwd,
      ...(previous.length ? { previous_session_ids: previous } : {}),
      questions: [],
      crashes: 0,
    }),
    'utf8',
  );
}

function transcriptDir(): string {
  return join(home, '.claude', 'projects', encodeClaudeProjectDir(spawnCwd));
}

function entry(ts: string, message: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: ts, message }) + '\n';
}

const use = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const fail = (id: string, text: string) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: text });
const okResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' });

describe('readStepSessionRefs', () => {
  test('reads step files, skips corrupt ones, missing dir → empty', () => {
    writeSession('01-a', 'sess-1');
    writeFileSync(join(sessionsDir, '02-b.json'), '{oops', 'utf8');
    writeFileSync(join(sessionsDir, 'notes.txt'), 'ignored', 'utf8');
    const refs = readStepSessionRefs(sessionsDir);
    expect(refs).toEqual([{ step_id: '01-a', session_ids: ['sess-1'], spawn_cwd: spawnCwd }]);
    expect(readStepSessionRefs(join(sandbox, 'nope'))).toEqual([]);
  });

  test('previous_session_ids (loop-back re-executions) ride along, current first', () => {
    writeSession('02-b', 'sess-3', ['sess-2', 'sess-1']);
    expect(readStepSessionRefs(sessionsDir)).toEqual([
      { step_id: '02-b', session_ids: ['sess-3', 'sess-2', 'sess-1'], spawn_cwd: spawnCwd },
    ]);
  });
});

describe('foldStepSessionTranscripts', () => {
  test('folds counts + exact-step failures across step sessions and subagents', () => {
    writeSession('01-a', 'sess-1');
    writeSession('02-b', 'sess-2');
    const dir = transcriptDir();
    mkdirSync(dir, { recursive: true });
    // step 01: one failing Bash call
    writeFileSync(
      join(dir, 'sess-1.jsonl'),
      entry('2026-07-08T10:00:01.000Z', {
        role: 'assistant',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [use('t1', 'Bash', { command: 'bun test' })],
      }) + entry('2026-07-08T10:00:02.000Z', { role: 'user', content: [fail('t1', 'bun: command not found')] }),
      'utf8',
    );
    // step 02: one clean call in the session + one failure inside a subagent
    writeFileSync(
      join(dir, 'sess-2.jsonl'),
      entry('2026-07-08T10:05:01.000Z', {
        role: 'assistant',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [use('t2', 'Read', { file_path: '/x' })],
      }) + entry('2026-07-08T10:05:02.000Z', { role: 'user', content: [okResult('t2')] }),
      'utf8',
    );
    const subDir = join(dir, 'sess-2', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-x.jsonl'),
      entry('2026-07-08T10:06:01.000Z', {
        role: 'assistant',
        usage: { input_tokens: 2, output_tokens: 2 },
        content: [use('t3', 'Edit', { file_path: '/y' })],
      }) + entry('2026-07-08T10:06:02.000Z', { role: 'user', content: [fail('t3', 'old_string not found')] }),
      'utf8',
    );

    const fold = foldStepSessionTranscripts(readStepSessionRefs(sessionsDir), home);
    expect(fold.found_any).toBe(true);
    expect(fold.tools_called).toBe(3);
    expect(fold.tools_failed).toBe(2);
    // Transcript-folded token totals ride along — the fallback token source
    // for runs that accumulated no envelope usage.
    expect(fold.input_tokens).toBe(13); // 10 + 1 + 2
    expect(fold.output_tokens).toBe(8); // 5 + 1 + 2
    expect(fold.failures).toEqual([
      { ts: '2026-07-08T10:00:02.000Z', tool: 'Bash', step: '01-a', error: 'bun: command not found' },
      { ts: '2026-07-08T10:06:02.000Z', tool: 'Edit', step: '02-b', error: 'old_string not found' },
    ]);
  });

  test('previous_session_ids transcripts are folded too (loop-back coverage)', () => {
    writeSession('02-b', 'sess-new', ['sess-old']);
    const dir = transcriptDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'sess-old.jsonl'),
      entry('2026-07-08T09:00:01.000Z', {
        role: 'assistant',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [use('t1', 'Bash', { command: 'x' })],
      }) + entry('2026-07-08T09:00:02.000Z', { role: 'user', content: [fail('t1', 'first execution failed')] }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'sess-new.jsonl'),
      entry('2026-07-08T09:10:01.000Z', {
        role: 'assistant',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [use('t2', 'Bash', { command: 'x' })],
      }) + entry('2026-07-08T09:10:02.000Z', { role: 'user', content: [okResult('t2')] }),
      'utf8',
    );
    const fold = foldStepSessionTranscripts(readStepSessionRefs(sessionsDir), home);
    expect(fold.tools_called).toBe(2); // both executions counted
    expect(fold.tools_failed).toBe(1);
    expect(fold.failures).toEqual([
      { ts: '2026-07-08T09:00:02.000Z', tool: 'Bash', step: '02-b', error: 'first execution failed' },
    ]);
  });

  test('missing transcripts → found_any false, zero counts, no failures', () => {
    writeSession('01-a', 'sess-none');
    const fold = foldStepSessionTranscripts(readStepSessionRefs(sessionsDir), home);
    expect(fold.found_any).toBe(false);
    expect(fold.tools_called).toBe(0);
    expect(fold.failures).toEqual([]);
  });
});
