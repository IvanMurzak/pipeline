// `pipeline drive` — the EXPERIMENTAL headless runner (no pipeline-manager LLM).
//
// The executor seam is exercised through the documented template override
// (`--executor-cmd` / PIPELINE_DRIVE_EXECUTOR_CMD): each test scaffolds a
// FakeExecutorRunner — a bun script that reads the spawn prompt on stdin,
// extracts `step_record_file`, logs the call, and copies a PRESCRIBED record
// from <root>/canned/<step_id>.json into place (no prescription → exit 7 with
// no record written). Subprocess invocation mirrors next.test.ts (controlled
// cwd/env so auto-emitted UI events land inside the temp dir, never the repo
// or the real ~/.claude).

import { test, expect, afterEach } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import {
  buildExecutorArgv,
  DEFAULT_EXECUTOR_TEMPLATE,
  extractQuestion,
  quoteForShell,
  resolvePermissionMode,
  runDrive,
  type ExecutorRunner,
} from '../src/commands/drive';
import { stepRecordSchemaJson } from '../src/lib/step-schema';
import type { GitResult, GitRunner } from '../src/lib/git';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}, 30000);

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// --- FakeExecutorRunner (template-injected) ---------------------------------

const FAKE_EXECUTOR = `// FakeExecutorRunner: prescribed-record step executor for drive tests.
import { copyFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const prompt = await Bun.stdin.text();
const m = /^step_record_file = (.+)$/m.exec(prompt);
if (!m) process.exit(9);
const recordFile = m[1].trim();
// records/<step>.json → <run> → .runtime → <pipeline root>
const root = dirname(dirname(dirname(dirname(recordFile))));
const stepId = basename(recordFile, '.json');
const canned = join(root, 'canned');
mkdirSync(canned, { recursive: true });
appendFileSync(join(canned, 'calls.log'), stepId + '\\n');
writeFileSync(join(canned, 'prompt-' + stepId + '.txt'), prompt);
const rec = join(canned, stepId + '.json');
if (!existsSync(rec)) process.exit(7); // no prescription → no record written
copyFileSync(rec, recordFile);
process.exit(0);
`;

// --- FakeEnvelopeExecutor (structured-output path) ----------------------------
//
// Mimics `claude -p --output-format json --json-schema`: prints a PRESCRIBED
// envelope from <root>/canned/<step_id>.envelope.json on stdout and writes NO
// record file (proving drive persists the record itself from
// structured_output). An optional canned <step_id>.filerecord.json IS copied
// into place first — the precedence test's conflicting agent-written record.

const ENVELOPE_EXECUTOR = `// FakeEnvelopeExecutor: canned-envelope executor for drive tests.
import { copyFileSync, existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const prompt = await Bun.stdin.text();
const m = /^step_record_file = (.+)$/m.exec(prompt);
if (!m) process.exit(9);
const recordFile = m[1].trim();
const root = dirname(dirname(dirname(dirname(recordFile))));
const stepId = basename(recordFile, '.json');
const canned = join(root, 'canned');
mkdirSync(canned, { recursive: true });
appendFileSync(join(canned, 'calls.log'), stepId + '\\n');
// nth call for this step (1-based, counted AFTER appending).
const n = readFileSync(join(canned, 'calls.log'), 'utf8').split('\\n').filter((l) => l === stepId).length;
writeFileSync(join(canned, 'prompt-' + stepId + '.txt'), prompt);
writeFileSync(join(canned, 'prompt-' + stepId + '-' + n + '.txt'), prompt);
writeFileSync(join(canned, 'args-' + stepId + '-' + n + '.txt'), JSON.stringify(process.argv.slice(2)));
const fileRec = join(canned, stepId + '.filerecord.json');
if (existsSync(fileRec)) copyFileSync(fileRec, recordFile);
// Per-call envelope <step>.envelope.<n>.json beats the static <step>.envelope.json.
const perCall = join(canned, stepId + '.envelope.' + n + '.json');
const env = existsSync(perCall) ? perCall : join(canned, stepId + '.envelope.json');
if (!existsSync(env)) process.exit(7);
process.stdout.write(readFileSync(env, 'utf8'));
process.exit(0);
`;

/** Prescribe the JSON envelope the fake envelope executor prints for a step. */
function cannedEnvelope(root: string, stepId: string, structured: unknown, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(root, 'canned'), { recursive: true });
  const envelope = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    result: structured === undefined ? 'no structured output' : JSON.stringify(structured),
    session_id: `sess-${stepId}`,
    total_cost_usd: 0.05,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    ...(structured === undefined ? {} : { structured_output: structured }),
    ...overrides,
  };
  writeFileSync(join(root, 'canned', `${stepId}.envelope.json`), JSON.stringify(envelope), 'utf8');
}

/** Scaffold + envelope executor; returns the template for drive(). */
function envelopeTemplate(root: string): string {
  writeFileSync(join(root, 'envelope-executor.ts'), ENVELOPE_EXECUTOR, 'utf8');
  return `bun ${join(root, 'envelope-executor.ts')}`;
}

// --- scaffolding -------------------------------------------------------------

function scaffold(n = 3): string {
  const root = mkdtempSync(join(tmpdir(), 'drive-seq-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(2, '0');
    writeFileSync(join(steps, `${id}-step.md`), `# step ${id}\n`);
  }
  writeFileSync(join(root, 'fake-executor.ts'), FAKE_EXECUTOR, 'utf8');
  return root;
}

/** Prescribe the record the fake executor writes for a step. */
function canned(root: string, stepId: string, record: unknown): void {
  mkdirSync(join(root, 'canned'), { recursive: true });
  writeFileSync(join(root, 'canned', `${stepId}.json`), JSON.stringify(record), 'utf8');
}

function callsLog(root: string): string[] {
  const f = join(root, 'canned', 'calls.log');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean);
}

/** Run `pipeline drive` as a subprocess with the fake executor injected via the
 *  template seam. Same controlled cwd/env recipe as next.test.ts. */
function drive(root: string, runId: string, extra: string[] = [], opts: { viaEnv?: boolean; template?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PIPELINE_UI_RUN_ID;
  delete env.PIPELINE_UI_PARENT_RUN_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.PIPELINE_DRIVE_EXECUTOR_CMD;
  // Self-improvement stays on its shipped default (OFF) regardless of the
  // developer machine's environment — the v1-skip tests depend on it.
  delete env.PIPELINE_DRIVE_IMPROVER_CMD;
  delete env.PIPELINE_DRIVE_SCRIPT_CREATOR_CMD;
  delete env.PIPELINE_DRIVE_SELF_IMPROVE;
  env.USERPROFILE = root;
  env.HOME = root;
  const template = opts.template ?? `bun ${join(root, 'fake-executor.ts')}`;
  const args = [CLI, 'drive', '--root', root, '--run-id', runId];
  if (opts.viaEnv) env.PIPELINE_DRIVE_EXECUTOR_CMD = template;
  else args.push('--executor-cmd', template);
  args.push(...extra);
  // process.execPath, not 'bun': with an EXPLICIT env, Bun's spawnSync skips its
  // self-spawn special case and a shim-installed `bun` (npm .cmd/.ps1) is not
  // directly spawnable on Windows.
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: root, env });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* error paths have empty stdout */
  }
  return { json, status: r.status, stderr: r.stderr, stdout: r.stdout };
}

// --- executor command template (pure) ----------------------------------------

test('buildExecutorArgv: default template substitutes {model}+{schema}; drops a pair when its value is null', () => {
  const schema = stepRecordSchemaJson();
  expect(buildExecutorArgv(DEFAULT_EXECUTOR_TEMPLATE, 'sonnet', schema)).toEqual([
    'claude',
    '-p',
    '--agent',
    'pipeline:step-executor',
    '--model',
    'sonnet',
    '--output-format',
    'json',
    '--json-schema',
    schema,
  ]);
  // No model → the --model pair drops; the schema flags stay.
  expect(buildExecutorArgv(DEFAULT_EXECUTOR_TEMPLATE, null, schema)).toEqual([
    'claude',
    '-p',
    '--agent',
    'pipeline:step-executor',
    '--output-format',
    'json',
    '--json-schema',
    schema,
  ]);
  // No schema (custom runner without envelope support) → the --json-schema pair drops.
  expect(buildExecutorArgv(DEFAULT_EXECUTOR_TEMPLATE, 'sonnet', null)).toEqual([
    'claude',
    '-p',
    '--agent',
    'pipeline:step-executor',
    '--model',
    'sonnet',
    '--output-format',
    'json',
  ]);
  // A custom template whose {model} token has no preceding flag: only the token drops.
  expect(buildExecutorArgv('bun fake.ts {model}', null)).toEqual(['bun', 'fake.ts']);
  expect(buildExecutorArgv('bun fake.ts {model}', 'opus')).toEqual(['bun', 'fake.ts', 'opus']);
  // The compact schema is one whitespace-free token — the split can't shear it.
  expect(schema.includes(' ')).toBe(false);
}, 30000);

test('buildExecutorArgv: {effort} substitutes when resolved and drops its pair on inherit', () => {
  // Effort present → --effort <level> stays in the argv.
  const withEffort = buildExecutorArgv(DEFAULT_EXECUTOR_TEMPLATE, 'sonnet', null, { effort: 'xhigh' });
  const ei = withEffort.indexOf('--effort');
  expect(ei).toBeGreaterThan(-1);
  expect(withEffort[ei + 1]).toBe('xhigh');
  // Inherit (null/absent) → the --effort pair disappears entirely.
  expect(buildExecutorArgv(DEFAULT_EXECUTOR_TEMPLATE, 'sonnet', null)).not.toContain('--effort');
  expect(buildExecutorArgv(DEFAULT_EXECUTOR_TEMPLATE, 'sonnet', null, { effort: null })).not.toContain('--effort');
  // Resume (answer delivery / crash-resume) keeps the effort flag — `claude
  // --effort` does NOT persist across --resume, so it must be re-passed.
  const resumed = buildExecutorArgv(DEFAULT_EXECUTOR_TEMPLATE, null, null, {
    effort: 'max',
    session: { id: 'abc', resume: true },
  });
  expect(resumed).toContain('--effort');
  expect(resumed[resumed.indexOf('--effort') + 1]).toBe('max');
  expect(resumed).toContain('--resume');
}, 30000);

test('quoteForShell: schema JSON survives the cmd.exe fallback quoting', () => {
  expect(quoteForShell('plain')).toBe('plain');
  expect(quoteForShell('has space')).toBe('"has space"');
  expect(quoteForShell('{"a":"b"}')).toBe('"{\\"a\\":\\"b\\"}"');
}, 30000);

test('buildExecutorArgv: {session}/{permissions} tokens — pin, resume-swap, drop, append', () => {
  const schema = stepRecordSchemaJson();
  // Fresh spawn: --session-id <id> + --permission-mode <mode>.
  expect(
    buildExecutorArgv(DEFAULT_EXECUTOR_TEMPLATE, 'sonnet', schema, {
      session: { id: 'u-1', resume: false },
      permissionMode: 'acceptEdits',
    }),
  ).toEqual([
    'claude',
    '-p',
    '--agent',
    'pipeline:step-executor',
    '--model',
    'sonnet',
    '--permission-mode',
    'acceptEdits',
    '--session-id',
    'u-1',
    '--output-format',
    'json',
    '--json-schema',
    schema,
  ]);
  // Resume: the flag preceding {session} is swapped to --resume.
  const resumed = buildExecutorArgv(DEFAULT_EXECUTOR_TEMPLATE, 'sonnet', schema, {
    session: { id: 'u-1', resume: true },
    permissionMode: 'acceptEdits',
  });
  expect(resumed).toContain('--resume');
  expect(resumed).not.toContain('--session-id');
  expect(resumed[resumed.indexOf('--resume') + 1]).toBe('u-1');
  // permissionMode null (inherit) → the --permission-mode pair drops.
  const inherit = buildExecutorArgv(DEFAULT_EXECUTOR_TEMPLATE, 'sonnet', schema, {
    session: { id: 'u-1', resume: false },
    permissionMode: null,
  });
  expect(inherit).not.toContain('--permission-mode');
  // A template WITHOUT {session} gets the session pair appended at the end.
  expect(buildExecutorArgv('bun fake.ts', null, null, { session: { id: 'u-2', resume: false } })).toEqual([
    'bun',
    'fake.ts',
    '--session-id',
    'u-2',
  ]);
  expect(buildExecutorArgv('bun fake.ts', null, null, { session: { id: 'u-2', resume: true } })).toEqual([
    'bun',
    'fake.ts',
    '--resume',
    'u-2',
  ]);
}, 30000);

test('extractQuestion: defensive extraction from a step record', () => {
  expect(extractQuestion({ question: { text: 'Which env?', context: 'checked .env', options: ['dev', 'prod'] } })).toEqual({
    text: 'Which env?',
    context: 'checked .env',
    options: ['dev', 'prod'],
  });
  // Missing/garbage question → placeholder text, nulls.
  expect(extractQuestion({})).toEqual({
    text: 'executor requested input but provided no question text',
    context: null,
    options: null,
  });
  expect(extractQuestion({ question: { text: '', options: [1, 'ok'] } }).options).toEqual(['ok']);
}, 30000);

test('resolvePermissionMode: step frontmatter beats manifest, manifest beats acceptEdits, inherit → null', () => {
  const root = mkdtempSync(join(tmpdir(), 'drive-perm-'));
  created.push(root);
  mkdirSync(join(root, 'steps'), { recursive: true });
  const step = join(root, 'steps', '01-a.md');
  // 1. Nothing anywhere → acceptEdits.
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n');
  writeFileSync(step, '# a\n');
  expect(resolvePermissionMode(step, root)).toBe('acceptEdits');
  // 2. Manifest default applies to steps without their own key.
  writeFileSync(join(root, 'PIPELINE.md'), '---\npermission-mode: dontAsk\n---\n# P\n');
  expect(resolvePermissionMode(step, root)).toBe('dontAsk');
  // 3. Step frontmatter wins.
  writeFileSync(step, '---\npermission-mode: plan\n---\n# a\n');
  expect(resolvePermissionMode(step, root)).toBe('plan');
  // 4. inherit → null (no flag passed).
  writeFileSync(step, '---\npermission-mode: inherit\n---\n# a\n');
  expect(resolvePermissionMode(step, root)).toBeNull();
}, 30000);

// --- end-to-end drives --------------------------------------------------------

test('drive: 3-step sequential run to completion (exit 0, manager-shaped prompts, run-start setup)', () => {
  const root = scaffold(3);
  const plan = computePlan(root);
  const run = 'drivehappy';
  canned(root, plan.steps[0].step_id, { kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  canned(root, plan.steps[1].step_id, { kind: 'step', outcome: 'completed', next_iteration: plan.steps[2].path });
  canned(root, plan.steps[2].step_id, { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');
  expect(r.json.run_id).toBe(run);

  // All three steps executed, in order, exactly once.
  expect(callsLog(root)).toEqual([plan.steps[0].step_id, plan.steps[1].step_id, plan.steps[2].step_id]);

  // The spawn prompt matches the manager-documented template (run_id /
  // pipeline_root / step_record_file lines + the protocol paragraphs).
  const prompt = readFileSync(join(root, 'canned', `prompt-${plan.steps[0].step_id}.txt`), 'utf8');
  expect(prompt).toContain(`Execute pipeline iteration: ${plan.steps[0].path}`);
  expect(prompt).toContain(`run_id = ${run}`);
  expect(prompt).toContain(`pipeline_root = ${root}`);
  expect(prompt).toContain(`step_record_file = ${join(root, '.runtime', run, 'records', `${plan.steps[0].step_id}.json`)}`);
  expect(prompt).toContain('Follow the step-executor protocol');
  expect(prompt).toContain(`${root}/.feedback/${run}/`);

  // Run-start setup mirrored the manager: feedback dir + gitignore stub + records dir.
  expect(existsSync(join(root, '.feedback', run))).toBe(true);
  expect(readFileSync(join(root, '.feedback', '.gitignore'), 'utf8')).toBe('*\n');
  expect(existsSync(join(root, '.runtime', run, 'records'))).toBe(true);
}, 30000);

// --- structured-output envelope path ------------------------------------------

test('drive: structured_output IS the record — drive persists the record file itself and completes', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'driveenvhappy';
  const template = envelopeTemplate(root);
  cannedEnvelope(root, plan.steps[0].step_id, {
    outcome: 'completed',
    next_iteration: plan.steps[1].path,
    summary: 'step one done',
  });
  cannedEnvelope(root, plan.steps[1].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });

  const r = drive(root, run, ['--start', plan.steps[0].path], { template });
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');
  expect(callsLog(root)).toEqual([plan.steps[0].step_id, plan.steps[1].step_id]);

  // The executor wrote NO record file — drive persisted it from structured_output.
  const rec = JSON.parse(readFileSync(join(root, '.runtime', run, 'records', `${plan.steps[0].step_id}.json`), 'utf8'));
  expect(rec.kind).toBe('step');
  expect(rec.outcome).toBe('completed');
  expect(rec.summary).toBe('step one done');
  expect(r.stderr).toContain('step.record');
  expect(r.stderr).toContain('structured_output');

  // Envelope usage/cost accumulated across both spawns into usage.json.
  const usage = JSON.parse(readFileSync(join(root, '.runtime', run, 'usage.json'), 'utf8'));
  expect(usage).toEqual({ input: 20, output: 40, cache_read: 60, cache_creation: 80, cost_usd: 0.1 });

  // The spawn prompt carries the headless structured-output paragraph.
  const prompt = readFileSync(join(root, 'canned', `prompt-${plan.steps[0].step_id}.txt`), 'utf8');
  expect(prompt).toContain('You are running headless');
  expect(prompt).toContain('FINAL response is parsed as your step record');
}, 30000);

test('drive: structured_output wins over a conflicting agent-written record file', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'driveenvwins';
  const template = envelopeTemplate(root);
  // The file record says halted; the schema-validated envelope says completed.
  mkdirSync(join(root, 'canned'), { recursive: true });
  writeFileSync(
    join(root, 'canned', `${plan.steps[0].step_id}.filerecord.json`),
    JSON.stringify({ kind: 'step', outcome: 'halted', halt_reason: 'stale file record' }),
    'utf8',
  );
  cannedEnvelope(root, plan.steps[0].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });

  const r = drive(root, run, ['--start', plan.steps[0].path], { template });
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');
  // The persisted record was overwritten with the structured one.
  const rec = JSON.parse(readFileSync(join(root, '.runtime', run, 'records', `${plan.steps[0].step_id}.json`), 'utf8'));
  expect(rec.outcome).toBe('completed');
}, 30000);

test('drive: envelope WITHOUT structured_output falls back to the agent-written record file', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'driveenvfallback';
  const template = envelopeTemplate(root);
  // Envelope has no structured_output (schema flag absent in a custom
  // template), but the executor wrote a valid file record.
  mkdirSync(join(root, 'canned'), { recursive: true });
  writeFileSync(
    join(root, 'canned', `${plan.steps[0].step_id}.filerecord.json`),
    JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }),
    'utf8',
  );
  cannedEnvelope(root, plan.steps[0].step_id, undefined);

  const r = drive(root, run, ['--start', plan.steps[0].path], { template });
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');
}, 30000);

test('drive: error envelope + no record → synthesized halt names the claude error category', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'driveenverror';
  const template = envelopeTemplate(root);
  cannedEnvelope(root, plan.steps[0].step_id, undefined, { is_error: true, subtype: 'error_max_turns' });

  const r = drive(root, run, ['--start', plan.steps[0].path], { template });
  expect(r.status).toBe(1);
  expect(r.json.status).toBe('halted');
  expect(r.json.reason).toContain('no valid step record at');
  expect(r.json.reason).toContain('claude error: error_max_turns');
}, 30000);

test('drive: envelope usage enriches the finished run\'s .stats tokens (cost included)', () => {
  // Scaffold under a real <project>/.claude/pipeline/ ancestor so the stats
  // tree lands INSIDE the sandbox (statsLocation walks up to that anchor).
  const base = mkdtempSync(join(tmpdir(), 'drive-stats-'));
  created.push(base);
  const root = join(base, 'proj', '.claude', 'pipeline', 'pipe');
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  writeFileSync(join(root, 'steps', '01-step.md'), '# step 01\n');
  const plan = computePlan(root);
  const run = 'drivestats';
  const template = envelopeTemplate(root);
  cannedEnvelope(root, plan.steps[0].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });

  const r = drive(root, run, ['--start', plan.steps[0].path], { template });
  expect(r.status).toBe(0);

  const runsFile = join(base, 'proj', '.claude', 'pipeline', '.stats', 'pipe', 'runs.jsonl');
  expect(existsSync(runsFile)).toBe(true);
  const rec = JSON.parse(readFileSync(runsFile, 'utf8').trim().split('\n')[0]);
  expect(rec.run_id).toBe(run);
  expect(rec.runner).toBe('headless');
  expect(rec.tokens).toEqual({ input: 10, output: 20, cache_read: 30, cache_creation: 40, cost_usd: 0.05 });
  // The per-run log got the cost line.
  const log = readFileSync(join(base, 'proj', '.claude', 'pipeline', '.stats', 'pipe', 'runs', `${run}.log`), 'utf8');
  expect(log).toContain('cost=$0.0500');
}, 30000);

// --- needs-input: park → answer → SAME session resumes --------------------------

test('drive: needs-input parks the run (exit 4) and --answer resumes the SAME session to completion', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'driveqna';
  const template = envelopeTemplate(root);
  const step0 = plan.steps[0].step_id;
  // Call 1: the executor asks; call 2 (the resumed session): completes.
  cannedEnvelope(root, step0, {
    outcome: 'needs-input',
    question: { text: 'Which deployment target?', context: 'checked infra/, found none', options: ['aws', 'gcp'] },
  });
  writeFileSync(
    join(root, 'canned', `${step0}.envelope.2.json`),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      session_id: 'ignored',
      total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      structured_output: { outcome: 'completed', next_iteration: plan.steps[1].path },
    }),
    'utf8',
  );
  cannedEnvelope(root, plan.steps[1].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });

  // Park: exit 4, question in the final JSON, session persisted awaiting-input.
  const first = drive(root, run, ['--start', plan.steps[0].path], { template });
  expect(first.status).toBe(4);
  expect(first.json.status).toBe('awaiting-input');
  expect(first.json.step_id).toBe(step0);
  // question_id is at top-level (06.2.1 contract for runner correlation)
  expect(typeof first.json.question_id).toBe('string');
  expect(first.json.question_id).toMatch(/^[0-9a-f-]{36}$/);
  // question_id is also nested inside question object
  expect(typeof first.json.question.question_id).toBe('string');
  expect(first.json.question.question_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(first.json.question).toEqual({
    text: 'Which deployment target?',
    context: 'checked infra/, found none',
    options: ['aws', 'gcp'],
    question_id: first.json.question.question_id,
  });
  expect(first.json.detail).toContain('--answer');
  const sessFile = join(root, '.runtime', run, 'sessions', `${step0}.json`);
  const sess = JSON.parse(readFileSync(sessFile, 'utf8'));
  expect(sess.status).toBe('awaiting-input');
  expect(sess.questions.length).toBe(1);
  expect(first.json.session_id).toBe(sess.session_id);
  // Top-level and nested question_ids must match for runner correlation
  expect(first.json.question_id).toBe(first.json.question.question_id);

  // Answer: the SAME session id is resumed (--resume <id>), the answer prompt
  // carries the text, and the run completes.
  const second = drive(root, run, ['--resume', '--start', plan.steps[0].path, '--answer', 'use aws'], { template });
  expect(second.status).toBe(0);
  expect(second.json.status).toBe('completed');
  const args2 = JSON.parse(readFileSync(join(root, 'canned', `args-${step0}-2.txt`), 'utf8')) as string[];
  expect(args2).toContain('--resume');
  expect(args2[args2.indexOf('--resume') + 1]).toBe(sess.session_id);
  expect(args2).not.toContain('--session-id');
  const prompt2 = readFileSync(join(root, 'canned', `prompt-${step0}-2.txt`), 'utf8');
  expect(prompt2).toContain('Answer to your question: use aws');
  expect(prompt2).toContain('step_record_file =');
  // Steps ran: step0 twice (ask, resume), step1 once.
  expect(callsLog(root)).toEqual([step0, step0, plan.steps[1].step_id]);
  // Session closed.
  expect(JSON.parse(readFileSync(sessFile, 'utf8')).status).toBe('done');
}, 30000);

test('drive: re-entry while awaiting input WITHOUT --answer re-surfaces the question, spawns nothing', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'driveqnanoans';
  const template = envelopeTemplate(root);
  cannedEnvelope(root, plan.steps[0].step_id, {
    outcome: 'needs-input',
    question: { text: 'Which port?', context: 'no config found' },
  });

  const first = drive(root, run, ['--start', plan.steps[0].path], { template });
  expect(first.status).toBe(4);
  expect(callsLog(root).length).toBe(1);

  const second = drive(root, run, ['--resume', '--start', plan.steps[0].path], { template });
  expect(second.status).toBe(4);
  expect(second.json.status).toBe('awaiting-input');
  expect(second.json.question.text).toBe('Which port?');
  // No executor was spawned for the repeat — no token burn.
  expect(callsLog(root).length).toBe(1);
}, 30000);

test('drive: question limit — more questions than allowed halts the step with the full history', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'driveqnalimit';
  const template = envelopeTemplate(root);
  const step0 = plan.steps[0].step_id;
  // Pre-seed a session that already asked 3 questions (all answered).
  const sessionsDir = join(root, '.runtime', run, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${step0}.json`),
    JSON.stringify({
      session_id: '00000000-0000-4000-8000-000000000001',
      status: 'awaiting-input',
      spawn_cwd: root,
      questions: [
        { text: 'q1', context: null, options: null },
        { text: 'q2', context: null, options: null },
        { text: 'q3', context: null, options: null },
      ],
    }),
    'utf8',
  );
  // The resumed session asks a FOURTH question → over the limit → halt.
  cannedEnvelope(root, step0, { outcome: 'needs-input', question: { text: 'q4', context: null } });

  const r = drive(root, run, ['--resume', '--start', plan.steps[0].path, '--answer', 'a3'], { template });
  expect(r.status).toBe(1);
  expect(r.json.status).toBe('halted');
  expect(r.json.reason).toContain('question limit exhausted');
  expect(r.json.reason).toContain('[4] q4');
}, 30000);

test('drive: needs-input inside a PARALLEL layer maps to halted (v1)', async () => {
  const root = scaffoldParallel();
  const { git } = scriptedGit();
  const r = await driveMerge(
    root,
    'driveqnapar',
    git,
    parallelRecords({
      y: { kind: 'step', outcome: 'needs-input', question: { text: 'which flag?', context: 'ambiguous spec' } },
    }),
  );
  expect(r.code).toBe(1);
  expect(r.json.status).toBe('halted');
  expect(r.json.reason).toContain('parallel layer');
  expect(r.json.reason).toContain('which flag?');
}, 30000);

// --- task delivery ---------------------------------------------------------------

test('drive: --task writes task.md and every spawn prompt carries task_file', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'drivetask';
  const template = envelopeTemplate(root);
  cannedEnvelope(root, plan.steps[0].step_id, { outcome: 'completed', next_iteration: plan.steps[1].path });
  cannedEnvelope(root, plan.steps[1].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });

  const r = drive(root, run, ['--start', plan.steps[0].path, '--task', 'Fix the login bug in auth.ts'], { template });
  expect(r.status).toBe(0);
  const taskFile = join(root, '.runtime', run, 'task.md');
  expect(readFileSync(taskFile, 'utf8')).toBe('Fix the login bug in auth.ts');
  for (const s of [plan.steps[0].step_id, plan.steps[1].step_id]) {
    const prompt = readFileSync(join(root, 'canned', `prompt-${s}-1.txt`), 'utf8');
    expect(prompt).toContain(`task_file = ${taskFile}`);
    expect(prompt).toContain('concrete task statement');
  }
  // Persisted for resume re-entries.
  expect(JSON.parse(readFileSync(join(root, '.runtime', run, 'task-ref.json'), 'utf8'))).toEqual({ task_file: taskFile });
}, 30000);

test('drive: --task-file uses the given file; a resume re-entry keeps the task without re-passing it', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'drivetaskfile';
  const template = envelopeTemplate(root);
  const external = join(root, 'my-task.md');
  writeFileSync(external, 'Implement issue #42', 'utf8');
  // Park on a question first, then resume WITHOUT --task-file — the prompt of
  // the resumed run's next fresh spawn... (the resume itself is an answer
  // delivery; verify via the ref file + the first prompt).
  cannedEnvelope(root, plan.steps[0].step_id, {
    outcome: 'needs-input',
    question: { text: 'Which branch?', context: 'ambiguous' },
  });
  const first = drive(root, run, ['--start', plan.steps[0].path, '--task-file', external], { template });
  expect(first.status).toBe(4);
  const prompt1 = readFileSync(join(root, 'canned', `prompt-${plan.steps[0].step_id}-1.txt`), 'utf8');
  expect(prompt1).toContain(`task_file = ${resolve(external)}`);
  // Resume with the answer only — task ref survives on disk.
  writeFileSync(
    join(root, 'canned', `${plan.steps[0].step_id}.envelope.2.json`),
    JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'ok',
      structured_output: { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' },
    }),
    'utf8',
  );
  const second = drive(root, run, ['--resume', '--start', plan.steps[0].path, '--answer', 'main'], { template });
  expect(second.status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, '.runtime', run, 'task-ref.json'), 'utf8')).task_file).toBe(resolve(external));
}, 30000);

test('drive: missing --task-file and empty --task are loud usage errors', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const bad = drive(root, 'drivetaskbad', ['--start', plan.steps[0].path, '--task-file', join(root, 'nope.md')]);
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('--task-file does not exist');
  const empty = drive(root, 'drivetaskempty', ['--start', plan.steps[0].path, '--task', '   ']);
  expect(empty.status).toBe(2);
  expect(empty.stderr).toContain('--task is empty');
}, 30000);

// --- crash-resume ---------------------------------------------------------------

test('drive: crash-resume — an attempt with no valid record resumes the SAME session and completes', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'drivecrash';
  const template = envelopeTemplate(root);
  const step0 = plan.steps[0].step_id;
  // Call 1: no envelope, no record (the fake exits 7 — a "dead" attempt).
  // Call 2: the resumed session completes.
  mkdirSync(join(root, 'canned'), { recursive: true });
  writeFileSync(
    join(root, 'canned', `${step0}.envelope.2.json`),
    JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'recovered',
      structured_output: { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' },
    }),
    'utf8',
  );

  const r = drive(root, run, ['--start', plan.steps[0].path], { template });
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');
  expect(callsLog(root)).toEqual([step0, step0]);
  expect(r.stderr).toContain('step.crash_resume');
  // Same pinned session: call 1 pinned it, call 2 resumed it.
  const args1 = JSON.parse(readFileSync(join(root, 'canned', `args-${step0}-1.txt`), 'utf8')) as string[];
  const args2 = JSON.parse(readFileSync(join(root, 'canned', `args-${step0}-2.txt`), 'utf8')) as string[];
  const pinned = args1[args1.indexOf('--session-id') + 1];
  expect(args2[args2.indexOf('--resume') + 1]).toBe(pinned);
  expect(readFileSync(join(root, 'canned', `prompt-${step0}-2.txt`), 'utf8')).toContain('interrupted');
  // One crash consumed, session closed.
  const sess = JSON.parse(readFileSync(join(root, '.runtime', run, 'sessions', `${step0}.json`), 'utf8'));
  expect(sess.crashes).toBe(1);
  expect(sess.status).toBe('done');
}, 30000);

test('drive: crash budget exhausted — 1 fresh + 2 resumes, then the step halts', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'drivecrashout';
  const template = envelopeTemplate(root);
  const step0 = plan.steps[0].step_id;
  // No envelopes at all: every attempt dies without a record.

  const r = drive(root, run, ['--start', plan.steps[0].path], { template });
  expect(r.status).toBe(1);
  expect(r.json.status).toBe('halted');
  expect(r.json.reason).toContain('no valid step record at');
  expect(callsLog(root)).toEqual([step0, step0, step0]);
  const sess = JSON.parse(readFileSync(join(root, '.runtime', run, 'sessions', `${step0}.json`), 'utf8'));
  expect(sess.crashes).toBe(2);
  expect(sess.status).toBe('done');
}, 30000);

test('drive: a session left running by a dead drive process is crash-resumed on re-entry', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'drivecrashreentry';
  const template = envelopeTemplate(root);
  const step0 = plan.steps[0].step_id;
  // A previous drive died mid-step: the session file says running.
  const sessionsDir = join(root, '.runtime', run, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const deadSession = '00000000-0000-4000-8000-00000000dead';
  writeFileSync(
    join(sessionsDir, `${step0}.json`),
    JSON.stringify({ session_id: deadSession, status: 'running', spawn_cwd: root, questions: [], crashes: 0 }),
    'utf8',
  );
  cannedEnvelope(root, step0, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });

  const r = drive(root, run, ['--resume', '--start', plan.steps[0].path], { template });
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');
  expect(r.stderr).toContain('previous drive process died mid-step');
  // The surviving session was resumed, not replaced.
  const args1 = JSON.parse(readFileSync(join(root, 'canned', `args-${step0}-1.txt`), 'utf8')) as string[];
  expect(args1[args1.indexOf('--resume') + 1]).toBe(deadSession);
  expect(args1).not.toContain('--session-id');
  expect(readFileSync(join(root, 'canned', `prompt-${step0}-1.txt`), 'utf8')).toContain('interrupted');
}, 30000);

test('drive: per-step permission-mode frontmatter reaches the executor argv; session id is pinned', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'driveperm';
  const step0 = plan.steps[0].step_id;
  // Rewrite the step with permission-mode frontmatter (computePlan already ran).
  writeFileSync(join(root, 'steps', '01-step.md'), '---\npermission-mode: dontAsk\n---\n# step 01\n', 'utf8');
  const template = `${envelopeTemplate(root)} --permission-mode {permissions}`;
  cannedEnvelope(root, step0, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });

  const r = drive(root, run, ['--start', plan.steps[0].path], { template });
  expect(r.status).toBe(0);
  const args = JSON.parse(readFileSync(join(root, 'canned', `args-${step0}-1.txt`), 'utf8')) as string[];
  expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
  // The template has no {session} token → the pinned session pair was appended.
  const sess = JSON.parse(readFileSync(join(root, '.runtime', run, 'sessions', `${step0}.json`), 'utf8'));
  expect(args[args.indexOf('--session-id') + 1]).toBe(sess.session_id);
  expect(sess.status).toBe('done');
}, 30000);

test('drive: a step record with outcome halted propagates as exit 1 + halted JSON', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'drivehalt';
  canned(root, plan.steps[0].step_id, { kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  canned(root, plan.steps[1].step_id, { kind: 'step', outcome: 'halted', halt_reason: 'tests failed' });

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(1);
  expect(r.json.status).toBe('halted');
  expect(r.json.reason).toBe('tests failed');
  expect(callsLog(root)).toEqual([plan.steps[0].step_id, plan.steps[1].step_id]);
}, 30000);

test('drive: a missing step record file → synthesized halt naming the path and exit code', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'drivenorec';
  // NO canned record for step 1 → the fake executor exits 7 without writing one.

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(1);
  expect(r.json.status).toBe('halted');
  expect(r.json.reason).toContain('no valid step record at');
  expect(r.json.reason).toContain(join(root, '.runtime', run, 'records', `${plan.steps[0].step_id}.json`));
  expect(r.json.reason).toContain('(executor exit 7)');
}, 30000);

test('drive: blocked-delegating → exit 3 + blocker JSON pointing at the record file', () => {
  const root = scaffold(3);
  const plan = computePlan(root);
  const run = 'driveblocked';
  canned(root, plan.steps[0].step_id, { kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  canned(root, plan.steps[1].step_id, { kind: 'step', outcome: 'blocked-delegating' });

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(3);
  expect(r.json.status).toBe('blocked');
  expect(r.json.blocker_record_file).toBe(join(root, '.runtime', run, 'records', `${plan.steps[1].step_id}.json`));
  expect(r.json.run_id).toBe(run);
}, 30000);

test('drive: improver-skip path — has_improvement_brief:true is recorded applied:false and the run continues', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'driveimpskip';
  canned(root, plan.steps[0].step_id, {
    kind: 'step',
    outcome: 'completed',
    next_iteration: plan.steps[1].path,
    has_improvement_brief: true,
  });
  canned(root, plan.steps[1].step_id, { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');
  // The engine emitted run-improver between the steps; the driver skipped it
  // with a warning and NEVER spawned an executor for it.
  expect(r.stderr).toContain('self-improvement skipped in headless v1');
  expect(callsLog(root)).toEqual([plan.steps[0].step_id, plan.steps[1].step_id]);
}, 30000);

test('drive: --resume re-entry after a blocker resumes the blocked step, not the whole run', () => {
  const root = scaffold(3);
  const plan = computePlan(root);
  const run = 'driveresume';
  canned(root, plan.steps[0].step_id, { kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  canned(root, plan.steps[1].step_id, { kind: 'step', outcome: 'blocked-delegating' });

  // First drive parks the run blocked (exit 3).
  const first = drive(root, run, ['--start', plan.steps[0].path]);
  expect(first.status).toBe(3);
  expect(first.json.status).toBe('blocked');

  // The blocker is "resolved": the step now completes terminally. Re-enter with
  // --resume --start <blocked step> — via the PIPELINE_DRIVE_EXECUTOR_CMD env
  // override this time (the other seam of the same template).
  canned(root, plan.steps[1].step_id, { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  const second = drive(root, run, ['--resume', '--start', plan.steps[1].path], { viaEnv: true });
  expect(second.status).toBe(0);
  expect(second.json.status).toBe('completed');

  // Step 1 ran exactly once (first drive); step 2 ran twice (blocked, then resumed).
  expect(callsLog(root)).toEqual([plan.steps[0].step_id, plan.steps[1].step_id, plan.steps[1].step_id]);
}, 30000);

// --- parallel merge / worktree removal (B2/B3) --------------------------------
//
// These run runDrive IN-PROCESS through the DriveDeps seams: a fake GitRunner
// scripts every git result and logs each call (args + cwd), and an in-process
// ExecutorRunner writes prescribed step records directly. cwd + HOME/USERPROFILE
// are pointed at the sandbox for the duration so the engine's auto-emitted UI
// events land inside the temp dir (same isolation goal as the subprocess tests).

/** Parallel worktree pipeline (same shape as next.test.ts's scaffoldParallel):
 *  layers [[setup], [x, y], [z]] — x and y report worktree branches. */
function scaffoldParallel(): string {
  const root = mkdtempSync(join(tmpdir(), 'drive-par-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '---\nexecution: parallel\n---\n# P\n\n## End State\nx\n');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-setup.md'), '---\nstep_id: setup\n---\n# setup\n');
  writeFileSync(join(steps, '02-x.md'), '---\nstep_id: x\ndepends-on: [setup]\n---\n# x\n');
  writeFileSync(join(steps, '03-y.md'), '---\nstep_id: y\ndepends-on: [setup]\n---\n# y\n');
  writeFileSync(join(steps, '04-z.md'), '---\nstep_id: z\ndepends-on: [x, y]\n---\n# z\n');
  return root;
}

/** The happy-path step records: x and y each committed a worktree branch. */
function parallelRecords(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    setup: { kind: 'step', outcome: 'completed' },
    x: { kind: 'step', outcome: 'completed', worktree_branch: 'wt-x', worktree_path: '/wt/x' },
    y: { kind: 'step', outcome: 'completed', worktree_branch: 'wt-y', worktree_path: '/wt/y' },
    z: { kind: 'step', outcome: 'completed' },
    ...overrides,
  };
}

/** In-process ExecutorRunner: write the prescribed record for the step (none
 *  prescribed → exit 7 with no record, like the subprocess fake). */
function inProcessExecutor(records: Record<string, unknown>): ExecutorRunner {
  return async (req) => {
    const rec = records[req.step_id];
    if (rec === undefined) return { code: 7 };
    writeFileSync(req.record_file, JSON.stringify(rec), 'utf8');
    return { code: 0 };
  };
}

interface GitCall {
  args: string[];
  cwd?: string;
}

/** Fake GitRunner: logs every call; `script` returns result overrides (default
 *  clean success) keyed off the argv. */
function scriptedGit(script: (args: string[]) => Partial<GitResult> | undefined = () => undefined) {
  const calls: GitCall[] = [];
  const git: GitRunner = (args, cwd) => {
    calls.push({ args, cwd });
    return { code: 0, stdout: '', stderr: '', ...(script(args) ?? {}) };
  };
  return { calls, git };
}

/** Run `pipeline drive` in-process against the scaffold with fake deps, with
 *  cwd + home sandboxed to `root` for the duration. */
async function driveMerge(root: string, runId: string, git: GitRunner, records: Record<string, unknown>) {
  const plan = computePlan(root);
  let outBuf = '';
  let errBuf = '';
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.chdir(root);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  try {
    const code = await runDrive(['--root', root, '--run-id', runId, '--start', plan.steps[0].path], {
      git,
      executor: inProcessExecutor(records),
      out: (s) => (outBuf += s),
      err: (s) => (errBuf += s),
    });
    let json: any = null;
    try {
      json = JSON.parse(outBuf);
    } catch {
      /* error paths have empty stdout */
    }
    return { code, json, stderr: errBuf };
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }
}

test('drive merge: clean 2-branch merge — resolved cwd, merge → branch -d → worktree remove per branch', async () => {
  const root = scaffoldParallel();
  const proj = join(root, 'project-root');
  const { calls, git } = scriptedGit((args) =>
    args[0] === 'rev-parse' ? { stdout: proj + '\n' } : undefined,
  );

  const r = await driveMerge(root, 'drivemergeclean', git, parallelRecords());
  expect(r.code).toBe(0);
  expect(r.json.status).toBe('completed');

  // The cwd was resolved EXPLICITLY from the pipeline root — never process.cwd().
  expect(calls[0]).toEqual({ args: ['rev-parse', '--show-toplevel'], cwd: root });
  // Per branch, in layer order: merge → branch -d → worktree remove, all from
  // the resolved project root.
  expect(calls.slice(1).map((c) => c.args)).toEqual([
    ['merge', '--no-ff', 'wt-x'],
    ['branch', '-d', 'wt-x'],
    ['worktree', 'remove', '/wt/x'],
    ['merge', '--no-ff', 'wt-y'],
    ['branch', '-d', 'wt-y'],
    ['worktree', 'remove', '/wt/y'],
  ]);
  expect(calls.slice(1).every((c) => c.cwd === resolve(proj))).toBe(true);
  // Cleanup progress is logged.
  expect(r.stderr).toContain('merge.branch_deleted');
  expect(r.stderr).toContain('merge.worktree_removed');
  // Nothing leaked on the clean path.
  expect(r.stderr).not.toContain('run.leaked_worktrees');
}, 30000);

test('drive merge: worktree removal fails once → retried with --force; branch -d retried after removal', async () => {
  const root = scaffoldParallel();
  const proj = join(root, 'project-root');
  let xDeleteTries = 0;
  const { calls, git } = scriptedGit((args) => {
    if (args[0] === 'rev-parse') return { stdout: proj + '\n' };
    // Real-git semantics: the branch can't be deleted while its worktree has it
    // checked out — the FIRST wt-x delete fails, the post-removal retry works.
    if (args.join(' ') === 'branch -d wt-x') {
      xDeleteTries++;
      return xDeleteTries === 1
        ? { code: 1, stderr: "error: Cannot delete branch 'wt-x' checked out at '/wt/x'" }
        : undefined;
    }
    if (args.join(' ') === 'worktree remove /wt/x') {
      return { code: 1, stderr: "fatal: '/wt/x' contains modified or untracked files, use --force to delete it" };
    }
    return undefined;
  });

  const r = await driveMerge(root, 'drivemergeforce', git, parallelRecords());
  expect(r.code).toBe(0);
  expect(r.json.status).toBe('completed');
  // wt-x sequence: merge → branch -d (refused) → remove (fails) → remove --force → branch -d retry.
  expect(calls.slice(1, 6).map((c) => c.args)).toEqual([
    ['merge', '--no-ff', 'wt-x'],
    ['branch', '-d', 'wt-x'],
    ['worktree', 'remove', '/wt/x'],
    ['worktree', 'remove', '--force', '/wt/x'],
    ['branch', '-d', 'wt-x'],
  ]);
  expect(r.stderr).toContain('retrying with --force');
  expect(r.stderr).toContain('merge.worktree_removed');
  expect(r.stderr).toContain('merge.branch_deleted');
}, 30000);

test('drive merge: genuine conflict → conflict detail + unmerged enumeration + leaked summary, no cleanup attempted', async () => {
  const root = scaffoldParallel();
  const proj = join(root, 'project-root');
  const { calls, git } = scriptedGit((args) => {
    if (args[0] === 'rev-parse') return { stdout: proj + '\n' };
    if (args[0] === 'merge') {
      return {
        code: 1,
        stdout:
          'Auto-merging foo.ts\nCONFLICT (content): Merge conflict in foo.ts\nAutomatic merge failed; fix conflicts and then commit the result.\n',
      };
    }
    return undefined;
  });

  const r = await driveMerge(root, 'drivemergeconflict', git, parallelRecords());
  expect(r.code).toBe(1);
  expect(r.json.status).toBe('halted');
  // A REAL conflict keeps the plain "conflict:" detail (engine prefixes "merge conflict:").
  expect(r.json.reason).toContain('merge conflict: conflict: git merge --no-ff wt-x (step x)');
  expect(r.json.reason).not.toContain('non-conflict');
  // The not-yet-merged branches + worktree paths are enumerated for cleanup.
  expect(r.json.reason).toContain('unmerged: wt-x @ /wt/x, wt-y @ /wt/y');
  // Halt stops the merge loop: rev-parse + first merge only — no branch -d /
  // worktree remove, no second merge.
  expect(calls.map((c) => c.args)).toEqual([
    ['rev-parse', '--show-toplevel'],
    ['merge', '--no-ff', 'wt-x'],
  ]);
  // The final stderr summary lists the leaked worktrees.
  expect(r.stderr).toContain('run.leaked_worktrees');
  expect(r.stderr).toContain('wt-x @ /wt/x, wt-y @ /wt/y');
}, 30000);

test('drive merge: non-conflict merge failure → detail starts "merge failed (non-conflict):"', async () => {
  const root = scaffoldParallel();
  const proj = join(root, 'project-root');
  const { git } = scriptedGit((args) => {
    if (args[0] === 'rev-parse') return { stdout: proj + '\n' };
    if (args[0] === 'merge') {
      return { code: 128, stderr: 'fatal: unable to auto-detect email address (got "drive@(none)")' };
    }
    return undefined;
  });

  const r = await driveMerge(root, 'drivemergefatal', git, parallelRecords());
  expect(r.code).toBe(1);
  expect(r.json.status).toBe('halted');
  // Same conflict:true record shape (the engine only understands conflict:true),
  // but the detail is prefixed so triage isn't misled into hunting overlaps.
  expect(r.json.reason).toContain('merge conflict: merge failed (non-conflict): git merge --no-ff wt-x (step x)');
  expect(r.json.reason).toContain('unable to auto-detect email address');
  expect(r.json.reason).toContain('unmerged: wt-x @ /wt/x, wt-y @ /wt/y');
  expect(r.stderr).toContain('merge.failed');
  expect(r.stderr).toContain('run.leaked_worktrees');
}, 30000);

test('drive merge: no project root found → clean halt, nothing merged', async () => {
  const root = scaffoldParallel();
  const { calls, git } = scriptedGit((args) => {
    if (args[0] === 'rev-parse') {
      return { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
    }
    return undefined;
  });

  const r = await driveMerge(root, 'drivemergenoroot', git, parallelRecords());
  expect(r.code).toBe(1);
  expect(r.json.status).toBe('halted');
  expect(r.json.reason).toContain('merge failed (non-conflict): no project root found');
  expect(r.json.reason).toContain('not a git repository');
  expect(r.json.reason).toContain('unmerged: wt-x @ /wt/x, wt-y @ /wt/y');
  // Only the root probe ran — with the cwd unresolved, NO git merge was attempted.
  expect(calls.map((c) => c.args)).toEqual([['rev-parse', '--show-toplevel']]);
  expect(r.stderr).toContain('run.leaked_worktrees');
}, 30000);

test('drive merge: a layer halt BEFORE merge lists the layer worktrees as leaked in the stderr summary', async () => {
  const root = scaffoldParallel();
  const { calls, git } = scriptedGit();

  const r = await driveMerge(
    root,
    'drivelayerleak',
    git,
    parallelRecords({
      y: {
        kind: 'step',
        outcome: 'halted',
        halt_reason: 'y tests failed',
        worktree_branch: 'wt-y',
        worktree_path: '/wt/y',
      },
    }),
  );
  expect(r.code).toBe(1);
  expect(r.json.status).toBe('halted');
  // The engine halted the layer before any merge action — git never ran.
  expect(calls.length).toBe(0);
  // But the driver's final stderr summary still names every live worktree.
  expect(r.stderr).toContain('run.leaked_worktrees');
  expect(r.stderr).toContain('wt-x @ /wt/x');
  expect(r.stderr).toContain('wt-y @ /wt/y');
}, 30000);

test('drive: usage errors — missing --start (without --resume) and missing --root/--run-id are exit 2', () => {
  const root = scaffold(1);
  const noStart = drive(root, 'driveusage');
  expect(noStart.status).toBe(2);
  expect(noStart.stderr).toContain('--start');

  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: root, HOME: root };
  const noRoot = spawnSync(process.execPath, [CLI, 'drive'], { encoding: 'utf8', cwd: root, env });
  expect(noRoot.status).toBe(2);
  expect(noRoot.stderr).toContain('--root and --run-id are required');
}, 30000);

test('drive: question_id is minted at park time and included in exit-4 JSON and session', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  cannedEnvelope(root, plan.steps[0].step_id, { outcome: 'needs-input', question: { text: 'what color?', context: 'was blue', options: ['red', 'blue'] } });
  cannedEnvelope(root, plan.steps[1].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  const template = envelopeTemplate(root);

  const r = drive(root, 'q1', ['--start', plan.steps[0].path], { template });
  expect(r.status).toBe(4);
  expect(r.json.status).toBe('awaiting-input');
  // question_id is present in the exit-4 JSON
  expect(typeof r.json.question_id).toBe('string');
  expect(r.json.question_id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
  // Same question_id is persisted in the session file
  const sesFile = join(root, '.runtime', 'q1', 'sessions', plan.steps[0].step_id + '.json');
  const sess = JSON.parse(readFileSync(sesFile, 'utf8'));
  expect(sess.questions.length).toBe(1);
  expect(sess.questions[0].question_id).toBe(r.json.question_id);
}, 30000);

test('drive: provider_limit is detected from error_rate_limited and included in halt JSON', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  cannedEnvelope(root, plan.steps[0].step_id, undefined, { is_error: true, subtype: 'error_rate_limited' });
  const template = envelopeTemplate(root);

  const r = drive(root, 'limit', ['--start', plan.steps[0].path], { template });
  expect(r.status).toBe(1);
  expect(r.json.status).toBe('halted');
  // provider_limit is present with the correct reason
  expect(r.json.provider_limit).toBeDefined();
  expect((r.json.provider_limit as Record<string, unknown>).reason).toBe('rate_limit_exceeded');
}, 30000);

test('drive: executor env includes CLAUDE_CODE_RETRY_WATCHDOG=1 and CLAUDE_CODE_MAX_RETRIES=15 by default', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  // Prescribe an executor that captures its environment and writes it to a file
  const capEnv = `// FakeExecutorRunner: captures spawn environment.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const prompt = await Bun.stdin.text();
const m = /^step_record_file = (.+)$/m.exec(prompt);
if (!m) process.exit(9);
const recordFile = m[1].trim();
const root = dirname(dirname(dirname(dirname(recordFile))));
const canned = join(root, 'canned');
mkdirSync(canned, { recursive: true });

// Write the env vars to a file for inspection
writeFileSync(join(canned, 'executor-env.json'), JSON.stringify({
  CLAUDE_CODE_RETRY_WATCHDOG: process.env.CLAUDE_CODE_RETRY_WATCHDOG,
  CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES,
}), 'utf8');

// Write a minimal valid record
writeFileSync(recordFile, JSON.stringify({ outcome: 'completed' }), 'utf8');
process.exit(0);
`;
  writeFileSync(join(root, 'capture-env.ts'), capEnv, 'utf8');
  const template = `bun ${join(root, 'capture-env.ts')}`;

  const r = drive(root, 'envtest', ['--start', plan.steps[0].path], { template });
  expect(r.status).toBe(0);
  const captured = JSON.parse(readFileSync(join(root, 'canned', 'executor-env.json'), 'utf8'));
  expect(captured.CLAUDE_CODE_RETRY_WATCHDOG).toBe('1');
  expect(captured.CLAUDE_CODE_MAX_RETRIES).toBe('15');
}, 30000);
