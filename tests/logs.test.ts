import { test, expect, afterEach } from 'bun:test';
import { parseLogsArgs, formatEvent, journalPathFor } from '../src/commands/logs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

test('parseLogsArgs: defaults', () => {
  expect(parseLogsArgs([])).toEqual({
    follow: false,
    tail: 20,
    all: false,
    json: false,
    color: 'auto',
    project: null,
  });
});

test('parseLogsArgs: flags + values', () => {
  const a = parseLogsArgs(['-f', '--tail', '5', '--all', '--json', '--no-color', '--project', '/x']);
  expect(a.follow).toBe(true);
  expect(a.tail).toBe(5);
  expect(a.all).toBe(true);
  expect(a.json).toBe(true);
  expect(a.color).toBe('off');
  expect(a.project).toBe('/x');
});

test('parseLogsArgs: --tail= and --project= forms, --color', () => {
  const a = parseLogsArgs(['--follow', '--tail=12', '--project=/y', '--color']);
  expect(a.tail).toBe(12);
  expect(a.project).toBe('/y');
  expect(a.color).toBe('on');
});

test('parseLogsArgs: ignores a non-numeric / negative tail', () => {
  expect(parseLogsArgs(['--tail', 'abc']).tail).toBe(20);
  expect(parseLogsArgs(['--tail', '-3']).tail).toBe(20);
});

test('formatEvent: pipeline.started (no color) is a readable one-liner', () => {
  const line = formatEvent(
    {
      ts: '2026-05-21T18:42:11.342Z',
      type: 'pipeline.started',
      run_id: 'abcdef1234567890',
      worktree: null,
      data: { pipeline_name: 'build-cli', default_model: 'opus' },
    },
    false,
  );
  expect(line).toBe('18:42:11 ▶ pipeline.started abcdef12  build-cli [opus]');
});

test('formatEvent: tool.called success has no run tag when run_id is null', () => {
  const line = formatEvent(
    {
      ts: '2026-05-21T09:00:00.000Z',
      type: 'tool.called',
      run_id: null,
      data: { tool_name: 'Bash', success: true, agent_spawn: false },
    },
    false,
  );
  expect(line).toBe('09:00:00 · tool.called  Bash');
});

test('formatEvent: tool.called failure is marked failed', () => {
  const line = formatEvent(
    { ts: '2026-05-21T09:00:00.000Z', type: 'tool.called', data: { tool_name: 'Edit', success: false } },
    false,
  );
  expect(line).toContain('✗ tool.called');
  expect(line).toContain('Edit failed');
});

test('formatEvent: iteration.started shows index, basename, model, step_id', () => {
  const line = formatEvent(
    {
      ts: '2026-05-21T10:11:12.000Z',
      type: 'iteration.started',
      run_id: 'r',
      data: {
        index: 2,
        iteration_path: '/a/b/.claude/pipeline/x/steps/02-foo.md',
        resolved_model: 'sonnet',
        step_id: 'build',
      },
    },
    false,
  );
  expect(line).toBe('10:11:12 → iteration.started r  #2 02-foo.md <build> [sonnet]');
});

test('formatEvent: iteration.started tags a script step (§12)', () => {
  const line = formatEvent(
    {
      ts: '2026-05-21T10:11:12.000Z',
      type: 'iteration.started',
      run_id: 'r',
      data: { index: 3, iteration_path: '/a/b/.claude/pipeline/x/steps/03-wait-ci.md', step_type: 'script' },
    },
    false,
  );
  expect(line).toBe('10:11:12 → iteration.started r  #3 03-wait-ci.md [script]');
});

test('formatEvent: iteration.completed shows the script tag + failure class + terminal (§12)', () => {
  const line = formatEvent(
    {
      ts: '2026-05-21T10:12:00.000Z',
      type: 'iteration.completed',
      run_id: 'r',
      data: {
        iteration_path: '/a/b/steps/03-wait-ci.md',
        outcome: 'halted',
        step_type: 'script',
        failure_class: 'contract',
        terminal: true,
      },
    },
    false,
  );
  expect(line).toContain('■ iteration.completed');
  expect(line).toContain('03-wait-ci.md halted [script] (contract) (terminal)');
});

test('formatEvent: iteration.completed WITHOUT the new fields is byte-identical (agent step, backward-compat)', () => {
  const line = formatEvent(
    {
      ts: '2026-05-21T10:12:00.000Z',
      type: 'iteration.completed',
      run_id: 'r',
      data: { iteration_path: '/a/b/steps/02-foo.md', outcome: 'completed', terminal: false },
    },
    false,
  );
  expect(line).toBe('10:12:00 ✓ iteration.completed r  02-foo.md completed');
});

test('formatEvent: pipeline.halted surfaces reason + abandoned flag', () => {
  const line = formatEvent(
    {
      ts: '2026-05-21T12:00:00.000Z',
      type: 'pipeline.halted',
      data: { pipeline_name: 'p', halt_reason: 'driver dead', abandoned: true },
    },
    false,
  );
  expect(line).toContain('■ pipeline.halted');
  expect(line).toContain('p — driver dead (abandoned)');
});

test('formatEvent: worktree tag rendered when present', () => {
  const line = formatEvent(
    { ts: '2026-05-21T12:00:00.000Z', type: 'session.opened', worktree: '/wt', data: { claude_pid: 42 } },
    false,
  );
  expect(line).toContain('(wt)');
});

test('formatEvent: unknown type falls back to dumping data', () => {
  const line = formatEvent({ ts: '2026-05-21T12:00:00.000Z', type: 'something.new', data: { a: 1 } }, false);
  expect(line).toContain('something.new');
  expect(line).toContain('{"a":1}');
});

test('formatEvent: color=true wraps in ANSI escapes', () => {
  const plain = formatEvent({ ts: '2026-05-21T12:00:00.000Z', type: 'pipeline.completed', data: {} }, false);
  const colored = formatEvent({ ts: '2026-05-21T12:00:00.000Z', type: 'pipeline.completed', data: {} }, true);
  expect(plain).not.toContain('\x1b[');
  expect(colored).toContain('\x1b[');
});

test('journalPathFor: resolves to <project>/.claude/pipeline/.runtime/events.jsonl', () => {
  const root = mkdtempSync(join(tmpdir(), 'logs-root-'));
  created.push(root);
  // A `.git` directory makes resolveProjectRoot stop here (the main repo).
  mkdirSync(join(root, '.git'), { recursive: true });
  const deep = join(root, 'a', 'b');
  mkdirSync(deep, { recursive: true });
  const expected = join(root, '.claude', 'pipeline', '.runtime', 'events.jsonl');
  expect(journalPathFor(root)).toBe(expected);
  expect(journalPathFor(deep)).toBe(expected);
});

// design 05: the ⏸ line is the whole daemon-free half of the awaiting-input
// feature — a user who opted out of the dashboard still sees a blocked run.
test('formatEvent: run.awaiting_input renders the pause line with kind + excerpt', () => {
  const line = formatEvent(
    {
      ts: '2026-05-21T19:03:00.000Z',
      type: 'run.awaiting_input',
      run_id: 'feedfacecafe0000',
      data: { kind: 'permission', message_excerpt: 'Claude needs your permission to use Bash' },
    },
    false,
  );
  expect(line).toBe(
    '19:03:00 ⏸ run.awaiting_input feedface  awaiting permission: Claude needs your permission to use Bash',
  );
});

test('formatEvent: run.awaiting_input without an excerpt still reads cleanly', () => {
  const line = formatEvent(
    { ts: '2026-05-21T19:04:00.000Z', type: 'run.awaiting_input', run_id: null, data: { kind: 'input' } },
    false,
  );
  expect(line).toBe('19:04:00 ⏸ run.awaiting_input  awaiting input');
});
