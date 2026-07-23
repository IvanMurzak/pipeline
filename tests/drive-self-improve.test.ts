// `pipeline drive` — headless self-improvement (design 05.2, P3): real
// improver / script-creator sessions + the mechanical retrospective, gated by
// PIPELINE_DRIVE_SELF_IMPROVE (ships OFF by default; `0`/unset restores the
// v1 skip byte-identically).
//
// Same subprocess harness as drive.test.ts: fakes are bun scripts injected
// through the documented template seams — the step executor via
// PIPELINE_DRIVE_EXECUTOR_CMD (canned claude envelopes), the improver /
// script-creator via PIPELINE_DRIVE_IMPROVER_CMD /
// PIPELINE_DRIVE_SCRIPT_CREATOR_CMD (canned envelopes keyed by call number).
// Controlled cwd/env so auto-emitted UI events land inside the temp dir.

import { test, expect, afterEach } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import {
  DEFAULT_IMPROVER_TEMPLATE,
  DEFAULT_SCRIPT_CREATOR_TEMPLATE,
  DOC_ACTIONABLE_CATEGORIES,
  HUMAN_ONLY_CATEGORIES,
  buildExecutorArgv,
  feedbackSummaryLine,
  selfImproveEnabled,
} from '../src/commands/drive';
import { improverSchemaJson, scriptCreatorSchemaJson } from '../src/lib/improver-schema';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}, 30000);

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// --- FakeEnvelopeExecutor (steps) — same shape as drive.test.ts ---------------

const ENVELOPE_EXECUTOR = `// FakeEnvelopeExecutor: canned-envelope step executor.
import { copyFileSync, existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const prompt = await Bun.stdin.text();
const m = /^step_record_file = (.+)$/m.exec(prompt);
if (!m) process.exit(9);
const recordFile = m[1].trim();
// pipeline_root line preferred (step record files live in the tmp DROP dir);
// legacy fallback derives from the record path.
const rm = /^pipeline_root = (.+)$/m.exec(prompt);
const root = rm ? rm[1].trim() : dirname(dirname(dirname(dirname(recordFile))));
const stepId = basename(recordFile, '.json');
const canned = join(root, 'canned');
mkdirSync(canned, { recursive: true });
appendFileSync(join(canned, 'calls.log'), stepId + '\\n');
const n = readFileSync(join(canned, 'calls.log'), 'utf8').split('\\n').filter((l) => l === stepId).length;
writeFileSync(join(canned, 'prompt-' + stepId + '-' + n + '.txt'), prompt);
const perCall = join(canned, stepId + '.envelope.' + n + '.json');
const env = existsSync(perCall) ? perCall : join(canned, stepId + '.envelope.json');
if (!existsSync(env)) process.exit(7);
process.stdout.write(readFileSync(env, 'utf8'));
process.exit(0);
`;

// --- Fake improver / script-creator executors ---------------------------------
//
// The self-improvement prompts carry no step_record_file line, so these fakes
// find the sandbox root from their OWN location (they are written into <root>)
// and count their own calls: canned/<tag>-calls.log, canned/<tag>-prompt-<n>.txt,
// canned/<tag>-args-<n>.txt, envelope from canned/<tag>.envelope.<n>.json (per
// call) else canned/<tag>.envelope.json; no envelope at all → exit 7 (a crash).

function selfImproveFake(tag: string): string {
  return `// Fake ${tag} executor for drive self-improve tests.
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const prompt = await Bun.stdin.text();
const root = import.meta.dir;
const canned = join(root, 'canned');
mkdirSync(canned, { recursive: true });
appendFileSync(join(canned, '${tag}-calls.log'), '${tag}\\n');
const n = readFileSync(join(canned, '${tag}-calls.log'), 'utf8').split('\\n').filter(Boolean).length;
writeFileSync(join(canned, '${tag}-prompt-' + n + '.txt'), prompt);
writeFileSync(join(canned, '${tag}-args-' + n + '.txt'), JSON.stringify(process.argv.slice(2)));
const perCall = join(canned, '${tag}.envelope.' + n + '.json');
const env = existsSync(perCall) ? perCall : join(canned, '${tag}.envelope.json');
if (!existsSync(env)) process.exit(7);
process.stdout.write(readFileSync(env, 'utf8'));
process.exit(0);
`;
}

// --- scaffolding --------------------------------------------------------------

function scaffold(n = 2): string {
  const root = mkdtempSync(join(tmpdir(), 'drive-si-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(2, '0');
    writeFileSync(join(steps, `${id}-step.md`), `# step ${id}\n`);
  }
  writeFileSync(join(root, 'envelope-executor.ts'), ENVELOPE_EXECUTOR, 'utf8');
  writeFileSync(join(root, 'fake-improver.ts'), selfImproveFake('improver'), 'utf8');
  writeFileSync(join(root, 'fake-script-creator.ts'), selfImproveFake('script-creator'), 'utf8');
  return root;
}

function envelope(structured: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    result: structured === undefined ? 'no structured output' : JSON.stringify(structured),
    session_id: 'sess-x',
    total_cost_usd: 0.05,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    ...(structured === undefined ? {} : { structured_output: structured }),
    ...overrides,
  });
}

/** Canned claude envelope for a STEP (static — every call of that step). */
function cannedStep(root: string, stepId: string, structured: unknown, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(root, 'canned'), { recursive: true });
  writeFileSync(join(root, 'canned', `${stepId}.envelope.json`), envelope(structured, overrides), 'utf8');
}

/** Canned envelope for the improver / script-creator fakes. `call` targets the
 *  n-th call; absent → the static default for every call. */
function cannedSelfImprove(
  root: string,
  tag: 'improver' | 'script-creator',
  structured: unknown,
  overrides: Record<string, unknown> = {},
  call?: number,
): void {
  mkdirSync(join(root, 'canned'), { recursive: true });
  const name = call === undefined ? `${tag}.envelope.json` : `${tag}.envelope.${call}.json`;
  writeFileSync(join(root, 'canned', name), envelope(structured, overrides), 'utf8');
}

function callsOf(root: string, tag: string): number {
  const f = join(root, 'canned', `${tag}-calls.log`);
  if (!existsSync(f)) return 0;
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
}

function promptOf(root: string, tag: string, n: number): string {
  return readFileSync(join(root, 'canned', `${tag}-prompt-${n}.txt`), 'utf8');
}

function argsOf(root: string, tag: string, n: number): string[] {
  return JSON.parse(readFileSync(join(root, 'canned', `${tag}-args-${n}.txt`), 'utf8')) as string[];
}

/** Seed Tier-2 feedback problem files. The Evidence marker must NEVER appear
 *  in any emitted event (paths + one-line summaries only — privacy tier). */
const EVIDENCE_MARKER = 'SECRET-EVIDENCE-BLOB';
function problemFile(category: string, problem: string): string {
  return `---\ncategory: ${category}\niteration: /abs/iter.md\nstep_id: s1\n---\n## Problem\n${problem}\n## Evidence\n${EVIDENCE_MARKER} details of what was tried\n## Suggested fix\nnone\n`;
}
function seedFeedback(root: string, run: string, files: Record<string, string>): string {
  const dir = join(root, '.feedback', run);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8');
  return dir;
}

function readEvents(root: string): { type: string; data: Record<string, unknown> }[] {
  const f = join(root, '.claude', 'pipeline', '.runtime', 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
}

/** Run `pipeline drive` as a subprocess with all three fakes injected through
 *  the template seams. `selfImprove`: true → '1', false → env DELETED (the
 *  shipped default), a string → that literal value. */
function drive(
  root: string,
  runId: string,
  extra: string[] = [],
  opts: { selfImprove?: boolean | string } = {},
) {
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
  env.PIPELINE_DRIVE_EXECUTOR_CMD = `bun ${join(root, 'envelope-executor.ts')}`;
  env.PIPELINE_DRIVE_IMPROVER_CMD = `bun ${join(root, 'fake-improver.ts')}`;
  env.PIPELINE_DRIVE_SCRIPT_CREATOR_CMD = `bun ${join(root, 'fake-script-creator.ts')}`;
  const si = opts.selfImprove ?? true;
  if (si === true) env.PIPELINE_DRIVE_SELF_IMPROVE = '1';
  else if (typeof si === 'string') env.PIPELINE_DRIVE_SELF_IMPROVE = si;
  const args = [CLI, 'drive', '--root', root, '--run-id', runId, ...extra];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: root, env });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* error paths have empty stdout */
  }
  return { json, status: r.status, stderr: r.stderr, stdout: r.stdout };
}

// --- pure units ---------------------------------------------------------------

test('selfImproveEnabled: OFF by default; 0/false/off/no/"" stay off; anything else enables', () => {
  expect(selfImproveEnabled({})).toBe(false);
  for (const v of ['0', 'false', 'off', 'no', '', ' 0 ', 'FALSE']) {
    expect(selfImproveEnabled({ PIPELINE_DRIVE_SELF_IMPROVE: v })).toBe(false);
  }
  for (const v of ['1', 'true', 'on', 'yes']) {
    expect(selfImproveEnabled({ PIPELINE_DRIVE_SELF_IMPROVE: v })).toBe(true);
  }
}, 30000);

test('default improver/script-creator templates: session pinned, schema substituted, no model/effort pair', () => {
  for (const [template, schema] of [
    [DEFAULT_IMPROVER_TEMPLATE, improverSchemaJson()],
    [DEFAULT_SCRIPT_CREATOR_TEMPLATE, scriptCreatorSchemaJson()],
  ] as const) {
    const argv = buildExecutorArgv(template, null, schema, { session: { id: 'u-1', resume: false } });
    expect(argv[0]).toBe('claude');
    expect(argv).toContain('--session-id');
    expect(argv[argv.indexOf('--session-id') + 1]).toBe('u-1');
    expect(argv[argv.indexOf('--json-schema') + 1]).toBe(schema);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--effort');
    // Resume swaps the session flag — the crash-resume path.
    const resumed = buildExecutorArgv(template, null, schema, { session: { id: 'u-1', resume: true } });
    expect(resumed).toContain('--resume');
    expect(resumed).not.toContain('--session-id');
  }
}, 30000);

test('category partition constants + feedbackSummaryLine (one line, no headings, truncated)', () => {
  for (const c of ['doc-flaw', 'ambiguity', 'script-candidate', 'script-failure']) {
    expect(DOC_ACTIONABLE_CATEGORIES.has(c)).toBe(true);
    expect(HUMAN_ONLY_CATEGORIES.has(c)).toBe(false);
  }
  for (const c of ['project-issue', 'env', 'friction']) {
    expect(HUMAN_ONLY_CATEGORIES.has(c)).toBe(true);
    expect(DOC_ACTIONABLE_CATEGORIES.has(c)).toBe(false);
  }
  expect(feedbackSummaryLine(problemFile('env', 'bun was missing from PATH'))).toBe('bun was missing from PATH');
  expect(feedbackSummaryLine('---\ncategory: env\n---\n')).toBe('(empty problem file)');
  expect(feedbackSummaryLine(`---\ncategory: env\n---\n## Problem\n${'x'.repeat(300)}\n`).length).toBe(201);
}, 30000);

// --- Tier-1 improver ----------------------------------------------------------

test('drive self-improve: run-improver spawns a pinned improver session with the verbatim brief; record + events + usage', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'siimprover';
  cannedStep(root, plan.steps[0].step_id, {
    outcome: 'completed',
    next_iteration: plan.steps[1].path,
    has_improvement_brief: true,
    improvement_brief: 'IMPROVEMENT BRIEF: step 1 pointed at the wrong linter; use eslint.',
  });
  cannedStep(root, plan.steps[1].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  cannedSelfImprove(
    root,
    'improver',
    { applied: true, script_creation_briefs: [], summary: 'fixed the linter reference' },
    { total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
  );

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');

  // Exactly ONE improver session; the prompt carries the manager-shaped header
  // + the brief verbatim + the headless structured-output note.
  expect(callsOf(root, 'improver')).toBe(1);
  const prompt = promptOf(root, 'improver', 1);
  expect(prompt).toContain('Tier-1 improvement pass');
  expect(prompt).toContain(`run_id = ${run}`);
  expect(prompt).toContain(`pipeline_root = ${root}`);
  expect(prompt).toContain(`Source iteration file: ${plan.steps[0].path}`);
  expect(prompt).toContain('IMPROVEMENT BRIEF: step 1 pointed at the wrong linter; use eslint.');
  expect(prompt).toContain('You are running headless');
  expect(prompt).toContain('"script_creation_briefs"');

  // Session pinned (--session-id appended to the custom template) + persisted.
  const args = argsOf(root, 'improver', 1);
  const sess = JSON.parse(readFileSync(join(root, '.runtime', run, 'sessions', 'improver-1.json'), 'utf8'));
  expect(args[args.indexOf('--session-id') + 1]).toBe(sess.session_id);
  expect(sess.status).toBe('done');
  expect(sess.crashes).toBe(0);

  // Drive persisted the structured record for observability.
  const rec = JSON.parse(readFileSync(join(root, '.runtime', run, 'records', 'improver-1.json'), 'utf8'));
  expect(rec).toEqual({ applied: true, script_creation_briefs: [], summary: 'fixed the linter reference' });

  // Usage accumulation includes the improver session (2 steps + 1 improver).
  const usage = JSON.parse(readFileSync(join(root, '.runtime', run, 'usage.json'), 'utf8'));
  expect(usage.input).toBe(21);
  expect(usage.output).toBe(42);
  expect(usage.cache_read).toBe(63);
  expect(usage.cache_creation).toBe(84);
  expect(usage.cost_usd).toBeCloseTo(0.11, 8);

  // The engine auto-emitted improver.started/completed from the action/record;
  // drive emitted improvement.applied (paths + summary only).
  const events = readEvents(root);
  const started = events.find((e) => e.type === 'improver.started');
  expect(started?.data.iteration_path).toBe(plan.steps[0].path);
  const completed = events.find((e) => e.type === 'improver.completed');
  expect(completed?.data.applied).toBe(true);
  const appliedEv = events.find((e) => e.type === 'improvement.applied');
  expect(appliedEv?.data.source).toBe('tier1');
  expect(appliedEv?.data.summary).toBe('fixed the linter reference');

  // Improvements applied + no finalize hook → preserve-workspace cue (05
  // §Cloud interplay) in the final JSON.
  expect(r.json.improvements_applied).toBe(true);
  expect(r.json.preserve_workspace).toBe(true);
  expect(String(r.json.preserve_workspace_reason)).toContain('finalize');
}, 30000);

test('drive self-improve: script-creator outcomes recorded VERBATIM; briefs delivered 1..N sequentially', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'siscripts';
  cannedStep(root, plan.steps[0].step_id, {
    outcome: 'completed',
    next_iteration: plan.steps[1].path,
    has_improvement_brief: true,
    improvement_brief: 'brief with two extractions',
  });
  cannedStep(root, plan.steps[1].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  cannedSelfImprove(root, 'improver', {
    applied: true,
    script_creation_briefs: ['EXTRACT-A: pull the build block into a script', 'EXTRACT-B: pull the deploy block'],
  });
  cannedSelfImprove(root, 'script-creator', { outcome: 'created', script_path: join(root, 'scripts', 'build.py') }, {}, 1);
  cannedSelfImprove(root, 'script-creator', { outcome: 'refused', script_path: null }, {}, 2);

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');

  expect(callsOf(root, 'script-creator')).toBe(2);
  const p1 = promptOf(root, 'script-creator', 1);
  expect(p1).toContain('Script-creation brief 1 of 2');
  expect(p1).toContain('EXTRACT-A: pull the build block into a script');
  expect(p1).toContain('You are running headless');
  const p2 = promptOf(root, 'script-creator', 2);
  expect(p2).toContain('Script-creation brief 2 of 2');
  expect(p2).toContain('EXTRACT-B: pull the deploy block');

  // Session files script-1/script-2 pinned + closed.
  for (const key of ['script-1', 'script-2']) {
    const sess = JSON.parse(readFileSync(join(root, '.runtime', run, 'sessions', `${key}.json`), 'utf8'));
    expect(sess.status).toBe('done');
  }

  // The auto-emitted script_creator.completed events carry the outcomes
  // VERBATIM (created, then refused) — never re-mapped.
  const events = readEvents(root);
  const completions = events.filter((e) => e.type === 'script_creator.completed');
  expect(completions.map((e) => e.data.outcome)).toEqual(['created', 'refused']);
  expect(completions[0].data.script_path).toBe(join(root, 'scripts', 'build.py'));
  // improvement.applied fired for the created script only.
  const applied = events.filter((e) => e.type === 'improvement.applied');
  expect(applied.some((e) => e.data.source === 'script-creator' && e.data.outcome === 'created')).toBe(true);
  expect(applied.some((e) => e.data.outcome === 'refused')).toBe(false);
}, 30000);

test('drive self-improve: null structured_output (pre-2.1.205 claude) → applied:false fallback + version warning, run continues', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'sinullso';
  cannedStep(root, plan.steps[0].step_id, {
    outcome: 'completed',
    next_iteration: plan.steps[1].path,
    has_improvement_brief: true,
    improvement_brief: 'a brief that will not land',
  });
  cannedStep(root, plan.steps[1].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  // SUCCESS envelope, no structured_output — a version-tolerance fallback, NOT a crash.
  cannedSelfImprove(root, 'improver', undefined);

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');
  // Exactly one improver call — no crash-resume for a clean-but-unstructured session.
  expect(callsOf(root, 'improver')).toBe(1);
  expect(r.stderr).toContain('no structured output');
  expect(r.stderr).toContain('2.1.205');
  const events = readEvents(root);
  expect(events.find((e) => e.type === 'improver.completed')?.data.applied).toBe(false);
  expect(events.some((e) => e.type === 'improvement.applied')).toBe(false);
  expect(r.json.improvements_applied).toBeUndefined();
  expect(r.json.preserve_workspace).toBeUndefined();
}, 30000);

test('drive self-improve: improver crash-resume — dead attempt resumes the SAME session with the interrupted prompt', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'sicrash';
  cannedStep(root, plan.steps[0].step_id, {
    outcome: 'completed',
    next_iteration: plan.steps[1].path,
    has_improvement_brief: true,
    improvement_brief: 'crashy brief',
  });
  cannedStep(root, plan.steps[1].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  // Call 1: the fake exits 7 (no envelope — dead attempt). Call 2: recovers.
  cannedSelfImprove(root, 'improver', { applied: true, script_creation_briefs: [] }, {}, 2);

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');
  expect(callsOf(root, 'improver')).toBe(2);
  expect(r.stderr).toContain('improver.crash_resume');

  // Same pinned session: call 1 pinned it, call 2 resumed it.
  const args1 = argsOf(root, 'improver', 1);
  const args2 = argsOf(root, 'improver', 2);
  const pinned = args1[args1.indexOf('--session-id') + 1];
  expect(args2[args2.indexOf('--resume') + 1]).toBe(pinned);
  expect(args2).not.toContain('--session-id');
  expect(promptOf(root, 'improver', 2)).toContain('interrupted');

  // One crash consumed against the SHARED step budget machinery; session closed.
  const sess = JSON.parse(readFileSync(join(root, '.runtime', run, 'sessions', 'improver-1.json'), 'utf8'));
  expect(sess.crashes).toBe(1);
  expect(sess.status).toBe('done');
  expect(readEvents(root).find((e) => e.type === 'improver.completed')?.data.applied).toBe(true);
}, 30000);

test('drive self-improve: improver crash budget exhausted (1 fresh + 2 resumes) → applied:false, chain CONTINUES', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'sicrashout';
  cannedStep(root, plan.steps[0].step_id, {
    outcome: 'completed',
    next_iteration: plan.steps[1].path,
    has_improvement_brief: true,
    improvement_brief: 'doomed brief',
  });
  cannedStep(root, plan.steps[1].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  // NO improver envelopes: every attempt dies.

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  // Improver failure never halts the chain (05.2 failure modes).
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');
  expect(callsOf(root, 'improver')).toBe(3);
  expect(r.stderr).toContain('improver pass');
  expect(r.stderr).toContain('not applied');
  const sess = JSON.parse(readFileSync(join(root, '.runtime', run, 'sessions', 'improver-1.json'), 'utf8'));
  expect(sess.crashes).toBe(2);
  expect(sess.status).toBe('done');
  expect(readEvents(root).find((e) => e.type === 'improver.completed')?.data.applied).toBe(false);
}, 30000);

// --- mechanical retrospective -------------------------------------------------

test('drive self-improve: retrospective partitions all six categories (+script-failure, +unknown/unparseable) and cleans up on success', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'siretro';
  cannedStep(root, plan.steps[0].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  const feedbackDir = seedFeedback(root, run, {
    'a-01.md': problemFile('doc-flaw', 'step 1 named the wrong file'),
    'a-02.md': problemFile('ambiguity', 'unclear which env to target'),
    'a-03.md': problemFile('script-candidate', 'the build block is deterministic'),
    'a-04.md': problemFile('script-failure', 'build script exited 2'),
    'b-01.md': problemFile('project-issue', 'auth.ts has a real bug'),
    'b-02.md': problemFile('env', 'bun was missing from PATH'),
    'b-03.md': problemFile('friction', 'CI queue was slow today'),
    'c-01.md': problemFile('mystery-category', 'unknown category file'),
    'c-02.md': 'no frontmatter at all — unparseable',
  });
  cannedSelfImprove(root, 'improver', {
    applied: true,
    script_creation_briefs: ['EXTRACT: the deterministic build block'],
    summary: 'consolidated 4 doc problems',
  });
  cannedSelfImprove(root, 'script-creator', { outcome: 'created', script_path: join(root, 'scripts', 'gen.py') });

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');

  // Partition: 4 doc-actionable, 3 human-only, 2 skipped.
  expect(r.stderr).toContain('retrospective.started');
  const retro = r.json.retrospective as Record<string, any>;
  expect(retro.doc_actionable).toBe(4);
  expect(retro.skipped).toBe(2);
  expect(retro.improver_applied).toBe(true);
  expect(retro.scripts).toEqual([{ outcome: 'created', script_path: join(root, 'scripts', 'gen.py') }]);
  expect(retro.feedback_deleted).toBe(true);
  // Human-only: one line each — category + summary + path, never body content.
  const humanOnly = retro.human_only as { category: string; path: string; summary: string }[];
  expect(humanOnly.map((h) => h.category).sort()).toEqual(['env', 'friction', 'project-issue']);
  expect(humanOnly.find((h) => h.category === 'env')?.summary).toBe('bun was missing from PATH');
  for (const h of humanOnly) expect(h.summary).not.toContain(EVIDENCE_MARKER);

  // ONE batch improver with the retro prompt; ONE sequential script-creator.
  expect(callsOf(root, 'improver')).toBe(1);
  expect(callsOf(root, 'script-creator')).toBe(1);
  const prompt = promptOf(root, 'improver', 1);
  expect(prompt).toContain('Retrospective (batch) improvement pass');
  expect(prompt).toContain(`Feedback folder: ${feedbackDir}`);
  expect(prompt).toContain(`Pipeline root:   ${root}`);
  expect(prompt).toContain('doc-flaw');
  expect(prompt).toContain('script-failure');

  // Feedback deleted on success; the .gitignore stub kept (manager parity).
  expect(existsSync(feedbackDir)).toBe(false);
  expect(readFileSync(join(root, '.feedback', '.gitignore'), 'utf8')).toMatch(/^\*$/m);

  // Events: retro-internal improver/script events are drive-emitted; the
  // run.retrospective payload carries counts + summaries + paths ONLY.
  const events = readEvents(root);
  expect(events.filter((e) => e.type === 'improver.started').length).toBe(1);
  expect(events.find((e) => e.type === 'improver.completed')?.data.applied).toBe(true);
  expect(events.find((e) => e.type === 'script_creator.completed')?.data.outcome).toBe('created');
  const retroEv = events.find((e) => e.type === 'run.retrospective');
  expect(retroEv).toBeDefined();
  expect(retroEv?.data.doc_actionable).toBe(4);
  expect(retroEv?.data.human_only).toBe(3);
  expect(retroEv?.data.skipped).toBe(2);
  expect(retroEv?.data.improver_applied).toBe(true);
  expect(retroEv?.data.scripts_created).toBe(1);

  // NO file content in ANY emitted event (privacy tier, 07).
  const journal = readFileSync(join(root, '.claude', 'pipeline', '.runtime', 'events.jsonl'), 'utf8');
  expect(journal).not.toContain(EVIDENCE_MARKER);
}, 30000);

test('drive self-improve: retrospective with ONLY human-only feedback spawns no improver, still summarizes + deletes', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'siretrohuman';
  cannedStep(root, plan.steps[0].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  const feedbackDir = seedFeedback(root, run, {
    'b-01.md': problemFile('friction', 'slow CI'),
  });

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(0);
  expect(callsOf(root, 'improver')).toBe(0);
  expect(callsOf(root, 'script-creator')).toBe(0);
  const retro = r.json.retrospective as Record<string, any>;
  expect(retro.doc_actionable).toBe(0);
  expect(retro.improver_applied).toBe(false);
  expect(retro.human_only.length).toBe(1);
  expect(existsSync(feedbackDir)).toBe(false);
  // No improvements were applied → no preserve-workspace cue.
  expect(r.json.improvements_applied).toBeUndefined();
  expect(r.json.preserve_workspace).toBeUndefined();
}, 30000);

test('drive self-improve: retrospective improver session failure PRESERVES the feedback folder', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'siretrocrash';
  cannedStep(root, plan.steps[0].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  const feedbackDir = seedFeedback(root, run, { 'a-01.md': problemFile('doc-flaw', 'bad doc') });
  // NO improver envelopes: the batch improver crashes out.

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(0); // improver failure never halts the chain
  expect(r.json.status).toBe('completed');
  const retro = r.json.retrospective as Record<string, any>;
  expect(retro.improver_applied).toBe(false);
  expect(retro.feedback_deleted).toBe(false);
  expect(existsSync(feedbackDir)).toBe(true);
  expect(r.stderr).toContain('feedback preserved');
}, 30000);

test('drive self-improve: retrospective also runs on a HALTED run and deletes processed feedback', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'siretrohalt';
  cannedStep(root, plan.steps[0].step_id, { outcome: 'halted', halt_reason: 'tests failed' });
  const feedbackDir = seedFeedback(root, run, { 'a-01.md': problemFile('doc-flaw', 'bad doc') });
  cannedSelfImprove(root, 'improver', { applied: true, script_creation_briefs: [] });

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(1);
  expect(r.json.status).toBe('halted');
  expect(r.json.reason).toBe('tests failed');
  // The halt JSON carries the retrospective + improvement bookkeeping too.
  expect((r.json.retrospective as Record<string, unknown>).improver_applied).toBe(true);
  expect(r.json.improvements_applied).toBe(true);
  expect(existsSync(feedbackDir)).toBe(false);
}, 30000);

// --- feedback lifecycle on parks ----------------------------------------------

test('drive self-improve: feedback is NEVER deleted on a blocked park (exit 3)', () => {
  const root = scaffold(2);
  const plan = computePlan(root);
  const run = 'sifbblocked';
  cannedStep(root, plan.steps[0].step_id, { outcome: 'blocked-delegating' });
  const feedbackDir = seedFeedback(root, run, { 'a-01.md': problemFile('doc-flaw', 'bad doc') });

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(3);
  expect(r.json.status).toBe('blocked');
  expect(existsSync(feedbackDir)).toBe(true);
  expect(callsOf(root, 'improver')).toBe(0);
}, 30000);

test('drive self-improve: feedback is NEVER deleted on an awaiting-input park (exit 4)', () => {
  const root = scaffold(1);
  const plan = computePlan(root);
  const run = 'sifbawait';
  cannedStep(root, plan.steps[0].step_id, {
    outcome: 'needs-input',
    question: { text: 'Which port?', context: 'no config found' },
  });
  const feedbackDir = seedFeedback(root, run, { 'a-01.md': problemFile('doc-flaw', 'bad doc') });

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(4);
  expect(r.json.status).toBe('awaiting-input');
  expect(existsSync(feedbackDir)).toBe(true);
  expect(callsOf(root, 'improver')).toBe(0);
}, 30000);

// --- the skip flag restores v1 ------------------------------------------------

test('drive self-improve: PIPELINE_DRIVE_SELF_IMPROVE=0 and unset both restore the v1 skip sites byte-identically', () => {
  for (const [runId, selfImprove] of [
    ['siskipzero', '0'],
    ['siskipunset', false],
  ] as const) {
    const root = scaffold(2);
    const plan = computePlan(root);
    cannedStep(root, plan.steps[0].step_id, {
      outcome: 'completed',
      next_iteration: plan.steps[1].path,
      has_improvement_brief: true,
      improvement_brief: 'a brief the v1 path must ignore',
    });
    cannedStep(root, plan.steps[1].step_id, { outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
    const feedbackDir = seedFeedback(root, runId, { 'a-01.md': problemFile('doc-flaw', 'bad doc') });

    const r = drive(root, runId, ['--start', plan.steps[0].path], { selfImprove });
    expect(r.status).toBe(0);
    expect(r.json.status).toBe('completed');
    // The v1 warning strings, verbatim.
    expect(r.stderr).toContain(
      `self-improvement skipped in headless v1 (improvement brief for ${plan.steps[0].path} not applied)`,
    );
    expect(r.stderr).toContain(
      `retrospective skipped in headless v1 — feedback left at ${join(root, '.feedback', runId)} for a manual improver pass`,
    );
    // NO improver/script sessions were ever spawned; no session/record files.
    expect(callsOf(root, 'improver')).toBe(0);
    expect(callsOf(root, 'script-creator')).toBe(0);
    expect(existsSync(join(root, '.runtime', runId, 'sessions', 'improver-1.json'))).toBe(false);
    // The v1 records reached the engine: improver.completed applied=false.
    const events = readEvents(root);
    expect(events.find((e) => e.type === 'improver.completed')?.data.applied).toBe(false);
    expect(events.some((e) => e.type === 'improvement.applied')).toBe(false);
    expect(events.some((e) => e.type === 'run.retrospective')).toBe(false);
    // Feedback left in place for a manual pass; final JSON carries NONE of the
    // self-improvement fields.
    expect(existsSync(feedbackDir)).toBe(true);
    expect(r.json.retrospective).toBeUndefined();
    expect(r.json.improvements_applied).toBeUndefined();
    expect(r.json.preserve_workspace).toBeUndefined();
  }
}, 60000);

// --- stats enrichment ---------------------------------------------------------

test('drive self-improve: .stats tokens include the improver session usage', () => {
  const base = mkdtempSync(join(tmpdir(), 'drive-si-stats-'));
  created.push(base);
  const root = join(base, 'proj', '.claude', 'pipeline', 'pipe');
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  writeFileSync(join(root, 'steps', '01-step.md'), '# step 01\n');
  writeFileSync(join(root, 'envelope-executor.ts'), ENVELOPE_EXECUTOR, 'utf8');
  writeFileSync(join(root, 'fake-improver.ts'), selfImproveFake('improver'), 'utf8');
  writeFileSync(join(root, 'fake-script-creator.ts'), selfImproveFake('script-creator'), 'utf8');
  const plan = computePlan(root);
  const run = 'sistats';
  cannedStep(root, plan.steps[0].step_id, {
    outcome: 'completed',
    next_iteration: 'PIPELINE_COMPLETE',
    has_improvement_brief: true,
    improvement_brief: 'measure me',
  });
  cannedSelfImprove(
    root,
    'improver',
    { applied: true, script_creation_briefs: [] },
    { total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
  );

  const r = drive(root, run, ['--start', plan.steps[0].path]);
  expect(r.status).toBe(0);

  const runsFile = join(base, 'proj', '.claude', 'pipeline', '.stats', 'pipe', 'runs.jsonl');
  expect(existsSync(runsFile)).toBe(true);
  const rec = JSON.parse(readFileSync(runsFile, 'utf8').trim().split('\n')[0]);
  expect(rec.run_id).toBe(run);
  // Step {10,20,30,40, $0.05} + improver {1,2,3,4, $0.01}.
  expect(rec.tokens.input).toBe(11);
  expect(rec.tokens.output).toBe(22);
  expect(rec.tokens.cache_read).toBe(33);
  expect(rec.tokens.cache_creation).toBe(44);
  expect(rec.tokens.cost_usd).toBeCloseTo(0.06, 8);
}, 30000);
