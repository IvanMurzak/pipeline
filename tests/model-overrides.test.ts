// model-overrides.test.ts — per-run `--model <step_id>=<model>` overrides +
// off-plan (synthesized) step model resolution, across all three layers:
//
//   1. computePlan (lib/plan.ts)   — precedence, normalization, warnings,
//                                    Plan.model_overrides exposure.
//   2. computeNext (lib/next.ts)   — synthesized steps honor overrides and the
//                                    injected resolveOffPlanModel seam; an
//                                    off-plan --start / resume current_path is
//                                    synthesized, never swapped for steps[0].
//   3. runNext (commands/next.ts)  — flags parse, persist into next.json at
//                                    init, keep applying on flag-less loop
//                                    calls, and off-plan steps resolve their
//                                    model from their own frontmatter /
//                                    enclosing PIPELINE.md on disk.

import { test, expect, afterEach } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import { computeNext, type NextState, type NextRecord, type NextAction, type NextOpts } from '../src/lib/next';
import { runNext } from '../src/commands/next';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function scaffold(manifest: string | null, steps: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'modelovr-'));
  created.push(root);
  if (manifest !== null) writeFileSync(join(root, 'PIPELINE.md'), manifest);
  const stepsDir = join(root, 'steps');
  mkdirSync(stepsDir, { recursive: true });
  for (const [name, content] of Object.entries(steps)) {
    const full = join(stepsDir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

// ---------------------------------------------------------------------------
// 1. computePlan
// ---------------------------------------------------------------------------

test('plan: --model override beats step frontmatter AND pipeline default', () => {
  const plan = computePlan(
    scaffold('---\nmodel: sonnet\n---\n', {
      '01-a.md': '---\n---\n',
      '02-b.md': '---\nmodel: opus\n---\n',
    }),
    { modelOverrides: { '02-b': 'fable' } },
  );
  expect(plan.steps[0].model).toBe('sonnet'); // untouched step keeps normal resolution
  expect(plan.steps[1].model).toBe('fable'); // override wins over frontmatter opus
  expect(plan.model_overrides).toEqual({ '02-b': 'fable' });
  expect(plan.errors).toEqual([]);
});

test('plan: canonical claude-* override passes through verbatim', () => {
  const plan = computePlan(scaffold(null, { '01-a.md': '# A\n' }), {
    modelOverrides: { '01-a': 'claude-fable-5' },
  });
  expect(plan.steps[0].model).toBe('claude-fable-5');
});

test("plan: override value 'inherit' FORCES session default over frontmatter", () => {
  const plan = computePlan(
    scaffold('---\nmodel: sonnet\n---\n', { '01-a.md': '---\nmodel: opus\n---\n' }),
    { modelOverrides: { '01-a': 'inherit' } },
  );
  expect(plan.steps[0].model).toBeNull(); // not opus, not sonnet — session default
  expect(plan.model_overrides).toEqual({ '01-a': null });
});

test('plan: invalid override value warns and is dropped (frontmatter survives)', () => {
  const plan = computePlan(
    scaffold(null, { '01-a.md': '---\nmodel: opus\n---\n' }),
    { modelOverrides: { '01-a': 'gpt-5' } },
  );
  expect(plan.warnings.some((w) => w.includes('invalid model'))).toBe(true);
  expect(plan.steps[0].model).toBe('opus');
  expect(plan.model_overrides).toEqual({});
});

test('plan: override key matching no enumerated step warns but is kept for off-plan use', () => {
  const plan = computePlan(scaffold(null, { '01-a.md': '# A\n' }), {
    modelOverrides: { '99-ghost': 'fable' },
  });
  expect(plan.warnings.some((w) => w.includes("'99-ghost'"))).toBe(true);
  expect(plan.model_overrides).toEqual({ '99-ghost': 'fable' });
  expect(plan.steps[0].model).toBeNull();
});

// ---------------------------------------------------------------------------
// 2. computeNext (pure engine)
// ---------------------------------------------------------------------------

function driver(plan: ReturnType<typeof computePlan>, baseOpts: Partial<NextOpts> = {}) {
  let state: NextState | null = null;
  return {
    call(record: NextRecord | null, opts: Partial<{ start: string; resume: boolean }> = {}): NextAction {
      const r = computeNext(plan, state, record, { feedbackCount: 0, ...baseOpts, ...opts });
      state = r.state;
      return r.action;
    },
  };
}

const OFF = '/somewhere/.claude/pipeline/other/steps/99-extra.md';

function expectRunStep(a: NextAction): Extract<NextAction, { action: 'run-step' }> {
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw new Error('unreachable');
  return a;
}

test('engine: a synthesized off-plan step honors the --model override for its stem', () => {
  const plan = computePlan(scaffold('---\nmodel: opus\n---\n', { '01-a.md': '# A\n' }), {
    modelOverrides: { '99-extra': 'fable' },
  });
  const d = driver(plan);
  d.call(null);
  const a = expectRunStep(d.call({ kind: 'step', outcome: 'completed', next_iteration: OFF }));
  expect(a.steps[0].step_id).toBe('99-extra');
  expect(a.steps[0].model).toBe('fable');
});

test('engine: a synthesized step uses resolveOffPlanModel when no override, run default when it yields null', () => {
  const plan = computePlan(scaffold('---\nmodel: opus\n---\n', { '01-a.md': '# A\n' }));
  const resolved = driver(plan, { resolveOffPlanModel: () => 'sonnet' });
  resolved.call(null);
  let a = expectRunStep(resolved.call({ kind: 'step', outcome: 'completed', next_iteration: OFF }));
  expect(a.steps[0].model).toBe('sonnet');

  const unresolved = driver(plan, { resolveOffPlanModel: () => null });
  unresolved.call(null);
  a = expectRunStep(unresolved.call({ kind: 'step', outcome: 'completed', next_iteration: OFF }));
  expect(a.steps[0].model).toBe('opus'); // falls back to the run default
});

test('engine: resume with an off-plan current_path re-enters THAT step, not steps[0]', () => {
  const plan = computePlan(scaffold(null, { '01-a.md': '# A\n' }));
  const d = driver(plan);
  d.call(null);
  expectRunStep(d.call({ kind: 'step', outcome: 'completed', next_iteration: OFF })); // now mid off-plan step
  // Crashed manager re-spawn: no-record auto-resume must re-dispatch the
  // off-plan step it was parked on — previously this silently restarted 01-a.
  const a = expectRunStep(d.call(null, { resume: true }));
  expect(a.steps[0].path).toBe(OFF);
  expect(a.steps[0].step_id).toBe('99-extra');
});

test('engine: an off-plan --start is synthesized and dispatched, not swapped for steps[0]', () => {
  const plan = computePlan(scaffold(null, { '01-a.md': '# A\n' }));
  const d = driver(plan);
  const a = expectRunStep(d.call(null, { start: OFF }));
  expect(a.steps[0].path).toBe(OFF);
});

// ---------------------------------------------------------------------------
// 3. runNext (command layer: flag parsing, persistence, disk resolution)
// ---------------------------------------------------------------------------

interface Project {
  project: string;
  pipelineRoot: string;
  otherRoot: string;
}

/** A consumer-project layout with TWO pipelines: `demo` (the run root) and
 *  `other` (holds off-plan steps the run hands off to, mimicking a family
 *  hub/target split). */
function scaffoldProject(): Project {
  const project = mkdtempSync(join(tmpdir(), 'modelovr-proj-'));
  created.push(project);
  const pipelineRoot = join(project, '.claude', 'pipeline', 'demo');
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  writeFileSync(join(pipelineRoot, 'PIPELINE.md'), '---\nmodel: opus\n---\n# P\n\n## End State\nx\n');
  writeFileSync(join(pipelineRoot, 'steps', '01-step.md'), '# step 1\n');
  writeFileSync(join(pipelineRoot, 'steps', '02-step.md'), '---\nmodel: sonnet\n---\n# step 2\n');
  const otherRoot = join(project, '.claude', 'pipeline', 'other');
  mkdirSync(join(otherRoot, 'steps'), { recursive: true });
  writeFileSync(join(otherRoot, 'PIPELINE.md'), '---\nmodel: haiku\n---\n# O\n\n## End State\nx\n');
  writeFileSync(join(otherRoot, 'steps', '07-pinned.md'), '---\nmodel: sonnet\n---\n# pinned\n');
  writeFileSync(join(otherRoot, 'steps', '08-plain.md'), '# plain\n');
  return { project, pipelineRoot, otherRoot };
}

/** Run runNext() in-process from the project dir, capturing the action JSON. */
function nextCall(p: Project, runId: string, extra: string[]): { code: number; json: any } {
  const prevCwd = process.cwd();
  let buf = '';
  const orig = process.stdout.write;
  (process.stdout as any).write = (chunk: unknown) => {
    buf += String(chunk);
    return true;
  };
  let code: number;
  try {
    process.chdir(p.project);
    code = runNext(['--root', p.pipelineRoot, '--run-id', runId, ...extra]);
  } finally {
    (process.stdout as any).write = orig;
    process.chdir(prevCwd);
  }
  return { code, json: buf.trim() ? JSON.parse(buf.trim()) : null };
}

const record = (r: object) => ['--record', JSON.stringify(r)];

test('command: --model overrides parse, apply at init, persist, and survive flag-less loop calls', () => {
  const p = scaffoldProject();
  const runId = 'ovr1';
  // Init WITH the override flags (the only call that carries them).
  let r = nextCall(p, runId, ['--model', '01-step=fable', '--model', '02-step=fable']);
  expect(r.code).toBe(0);
  expect(r.json.action).toBe('run-step');
  expect(r.json.steps[0].model).toBe('fable'); // beats the opus pipeline default

  // Persisted into next.json for loop calls / resumes.
  const state = JSON.parse(readFileSync(join(p.pipelineRoot, '.runtime', runId, 'next.json'), 'utf8'));
  expect(state.model_overrides).toEqual({ '01-step': 'fable', '02-step': 'fable' });

  // Loop call WITHOUT --model flags: the persisted override still beats
  // 02-step's own `model: sonnet` frontmatter.
  const step2 = join(p.pipelineRoot, 'steps', '02-step.md');
  r = nextCall(p, runId, record({ kind: 'step', outcome: 'completed', next_iteration: step2 }));
  expect(r.code).toBe(0);
  expect(r.json.steps[0].model).toBe('fable');
});

test('command: non-overridden steps keep their frontmatter model on an overridden run', () => {
  const p = scaffoldProject();
  const runId = 'ovr2';
  nextCall(p, runId, ['--model', '01-step=fable']);
  const step2 = join(p.pipelineRoot, 'steps', '02-step.md');
  const r = nextCall(p, runId, record({ kind: 'step', outcome: 'completed', next_iteration: step2 }));
  expect(r.json.steps[0].model).toBe('sonnet'); // 02-step's own pin, untouched
});

test('command: an off-plan step resolves its model from its OWN frontmatter, else its OWN PIPELINE.md', () => {
  const p = scaffoldProject();
  const runId = 'ovr3';
  nextCall(p, runId, []);
  // 07-pinned.md carries `model: sonnet` frontmatter — must win over the run
  // root's opus default even though the step is not enumerated in the plan.
  const pinned = join(p.otherRoot, 'steps', '07-pinned.md');
  let r = nextCall(p, runId, record({ kind: 'step', outcome: 'completed', next_iteration: pinned }));
  expect(r.json.steps[0].model).toBe('sonnet');
  // 08-plain.md has no frontmatter — its ENCLOSING other/PIPELINE.md default
  // (haiku) applies, not the run root's opus.
  const plain = join(p.otherRoot, 'steps', '08-plain.md');
  r = nextCall(p, runId, record({ kind: 'step', outcome: 'completed', next_iteration: plain }));
  expect(r.json.steps[0].model).toBe('haiku');
});

test('command: a --model override beats an off-plan step\'s own frontmatter too', () => {
  const p = scaffoldProject();
  const runId = 'ovr4';
  nextCall(p, runId, ['--model', '07-pinned=fable']);
  const pinned = join(p.otherRoot, 'steps', '07-pinned.md');
  const r = nextCall(p, runId, record({ kind: 'step', outcome: 'completed', next_iteration: pinned }));
  expect(r.json.steps[0].model).toBe('fable');
});

test('command: a malformed --model value is a loud usage error (exit 2)', () => {
  const p = scaffoldProject();
  let errBuf = '';
  const orig = process.stderr.write;
  (process.stderr as any).write = (chunk: unknown) => {
    errBuf += String(chunk);
    return true;
  };
  let r: { code: number };
  try {
    r = nextCall(p, 'ovr5', ['--model', 'fable']);
  } finally {
    (process.stderr as any).write = orig;
  }
  expect(r.code).toBe(2);
  expect(errBuf).toContain('--model expects <step_id>=<model>');
});
