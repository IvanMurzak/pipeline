// `pipeline drive` against a REAL newline-delimited stream (ux-v2 b6).
//
// tests/stream-json.test.ts pins the parser in isolation; this suite drives the
// whole command through the executor-template seam with a fake that prints an
// actual `--output-format stream-json --verbose` stdout — frames first, the
// terminal `result` last — and checks what drive does with it end to end:
//
//   - the step record still comes from the terminal frame's structured_output;
//   - each tool call surfaces LIVE as a `step.tool` progress event, carrying
//     the measured subagent depth from `parent_tool_use_id`;
//   - unknown frames (an invented top-level type AND an invented `system`
//     subtype) pass through without disturbing any of that;
//   - usage lands in usage.json ONCE per spawn — the terminal frame's totals,
//     not those plus the per-turn `assistant` usage the stream also carries;
//   - a stream cut short with NO terminal `result` (SIGTERM → exit 143) is not
//     an error: the record file channel carries the run to completion.

import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computePlan } from '../src/lib/plan';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}, 30000);

// --- the fake: a genuine stream-json emitter ---------------------------------
//
// Prints one JSON object per line, in the order the CLI does: startup frames,
// `system`/`init`, `assistant` turns (each with its own usage — the
// double-count trap), then the terminal `result`. With <step>.noresult present
// it instead writes the record file and dies mid-stream with 143.

const STREAM_EXECUTOR = `// FakeStreamExecutor: NDJSON stream-json executor for drive tests.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const prompt = await Bun.stdin.text();
const m = /^step_record_file = (.+)$/m.exec(prompt);
if (!m) process.exit(9);
const recordFile = m[1].trim();
const rm = /^pipeline_root = (.+)$/m.exec(prompt);
const root = rm ? rm[1].trim() : dirname(dirname(dirname(dirname(recordFile))));
const stepId = basename(recordFile, '.json');
const canned = join(root, 'canned');
mkdirSync(canned, { recursive: true });
appendFileSync(join(canned, 'calls.log'), stepId + '\\n');
writeFileSync(join(canned, 'args-' + stepId + '.json'), JSON.stringify(process.argv.slice(2)));

const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const turn = (usage, blocks, parent) =>
  w({ type: 'assistant', parent_tool_use_id: parent ?? null,
      message: { role: 'assistant', usage, content: blocks } });

w({ type: 'system', subtype: 'plugin_install', plugin: 'pipeline' });
w({ type: 'hook_started', hook_name: 'SessionStart' });
w({ type: 'hook_response', hook_name: 'SessionStart' });
w({ type: 'system', subtype: 'init', session_id: 'sess-' + stepId, tools: ['Bash'] });
// depth 0 — the step-executor's own call, and the Agent dispatch.
turn({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 },
     [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} },
      { type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { subagent_type: 'helper' } }], null);
// depth 1 — made INSIDE the subagent the Agent call spawned.
turn({ input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
     [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'echo hi' } }], 'toolu_agent');
w({ type: 'system', subtype: 'from_a_future_release', note: 'unknown SUBTYPE' });
w({ type: 'a_type_nobody_documented', note: 'unknown TYPE' });
w({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'partial' } } });

if (existsSync(join(canned, stepId + '.noresult'))) {
  // SIGTERM-shaped: the record file IS written, the stream just stops.
  writeFileSync(recordFile, readFileSync(join(canned, stepId + '.filerecord.json'), 'utf8'));
  process.exit(143);
}
const structured = JSON.parse(readFileSync(join(canned, stepId + '.structured.json'), 'utf8'));
w({ type: 'result', subtype: 'success', is_error: false, num_turns: 3,
    session_id: 'sess-' + stepId, total_cost_usd: 0.25,
    // The session TOTAL — deliberately NOT the sum of the turns above, so a
    // parser that accumulated per-turn usage would be caught by the exact
    // usage.json assertion below.
    usage: { input_tokens: 140, output_tokens: 25, cache_read_input_tokens: 1200, cache_creation_input_tokens: 5 },
    result: JSON.stringify(structured), structured_output: structured });
process.exit(0);
`;

function scaffold(n = 1): string {
  const root = mkdtempSync(join(tmpdir(), 'drive-stream-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  mkdirSync(join(root, 'steps'), { recursive: true });
  for (let i = 1; i <= n; i++) {
    writeFileSync(join(root, 'steps', `${String(i).padStart(2, '0')}-step.md`), `# step ${i}\n`);
  }
  writeFileSync(join(root, 'stream-executor.ts'), STREAM_EXECUTOR, 'utf8');
  return root;
}

function cannedStructured(root: string, stepId: string, record: unknown): void {
  mkdirSync(join(root, 'canned'), { recursive: true });
  writeFileSync(join(root, 'canned', `${stepId}.structured.json`), JSON.stringify(record), 'utf8');
}

function drive(root: string, runId: string, extra: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PIPELINE_UI_RUN_ID;
  delete env.PIPELINE_UI_PARENT_RUN_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.PIPELINE_DRIVE_EXECUTOR_CMD;
  delete env.PIPELINE_DRIVE_IMPROVER_CMD;
  delete env.PIPELINE_DRIVE_SCRIPT_CREATOR_CMD;
  delete env.PIPELINE_DRIVE_SELF_IMPROVE;
  env.USERPROFILE = root;
  env.HOME = root;
  const args = [
    CLI,
    'drive',
    '--root',
    root,
    '--run-id',
    runId,
    '--executor-cmd',
    `bun ${join(root, 'stream-executor.ts')}`,
    ...extra,
  ];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: root, env });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* error paths have empty stdout */
  }
  return { json, status: r.status, stderr: r.stderr };
}

test('drive over stream-json: the record lands, tool calls surface live with their depth, unknown frames are harmless', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'drivestream';
  const step = plan.steps[0].step_id;
  cannedStructured(root, step, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE', summary: 'streamed' });

  const r = drive(root, run, ['--start', plan.steps[0].path, '--json']);
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');

  // The record came from the TERMINAL frame's structured_output — the stream
  // did not disturb the channel ladder.
  const rec = JSON.parse(readFileSync(join(root, '.runtime', run, 'records', `${step}.json`), 'utf8'));
  expect(rec.outcome).toBe('completed');
  expect(rec.summary).toBe('streamed');
  expect(r.stderr).toContain('"event":"step.record"');
  expect(r.stderr).toContain('"source":"structured_output"');

  // LIVE tool granularity: one event per tool_use, with the subagent depth
  // computed from parent_tool_use_id (not assumed).
  const events = r.stderr
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'step.tool');
  expect(events.map((e) => [e.tool, e.depth])).toEqual([
    ['Read', 0],
    ['Agent', 0],
    ['Bash', 1],
  ]);
  expect(events[2].parent_tool_use_id).toBe('toolu_agent');
  expect(events.every((e) => e.step_id === step)).toBe(true);

  // Tokens: the terminal frame's totals, ONCE. Had the per-turn `assistant`
  // usage been folded in too, input would read 280 rather than 140.
  const usage = JSON.parse(readFileSync(join(root, '.runtime', run, 'usage.json'), 'utf8'));
  expect(usage).toEqual({ input: 140, output: 25, cache_read: 1200, cache_creation: 5, cost_usd: 0.25 });
}, 60000);

test('drive over stream-json: a stream with NO terminal result (SIGTERM, exit 143) is not an error', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'drivestreamkill';
  const step = plan.steps[0].step_id;
  mkdirSync(join(root, 'canned'), { recursive: true });
  writeFileSync(join(root, 'canned', `${step}.noresult`), '', 'utf8');
  writeFileSync(
    join(root, 'canned', `${step}.filerecord.json`),
    JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }),
    'utf8',
  );

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  // No envelope at all, exit 143 — and the run still completes, because the
  // absence of a terminal `result` is not a failure signal.
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');
  expect(r.stderr).toContain('step.tool');
  // Nothing was folded into usage.json: no terminal frame, no usage to take.
  expect(existsSync(join(root, '.runtime', run, 'usage.json'))).toBe(false);
  // And the step was NOT crash-resumed: one spawn, one call.
  expect(readFileSync(join(root, 'canned', 'calls.log'), 'utf8').trim().split('\n')).toEqual([step]);
}, 60000);
