import { test, expect, afterEach } from 'bun:test';
import { computeNext, type NextState, type NextRecord, type NextAction, type NextOpts } from '../src/lib/next';
import { computePlan, type Plan } from '../src/lib/plan';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

// --- scaffolding -----------------------------------------------------------

function scaffoldSequential(n = 3): string {
  const root = mkdtempSync(join(tmpdir(), 'next-seq-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(2, '0');
    writeFileSync(join(steps, `${id}-step.md`), `# step ${id}\n`);
  }
  return root;
}

// A sequential pipeline opted into run-level external isolation. Identical step
// shape to scaffoldSequential, plus `isolation: external` frontmatter (+ optional
// submodules). external is sequential-only, so no execution line.
function scaffoldExternal(
  n = 3,
  opts: { submodules?: string[]; finalize?: boolean; baseBranch?: string; deleteBranches?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'next-ext-'));
  created.push(root);
  const subs = opts.submodules?.length ? `\nsubmodules: [${opts.submodules.join(', ')}]` : '';
  const fin = opts.finalize ? `\nfinalize: true` : '';
  const base = opts.baseBranch ? `\nbase_branch: ${opts.baseBranch}` : '';
  const del = opts.deleteBranches === false ? `\ndelete_branches: false` : '';
  writeFileSync(join(root, 'PIPELINE.md'), `---\nisolation: external${subs}${fin}${base}${del}\n---\n# P\n\n## End State\nx\n`);
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(2, '0');
    writeFileSync(join(steps, `${id}-step.md`), `# step ${id}\n`);
  }
  return root;
}

// A parallel pipeline that ALSO declares isolation: external — a contradiction
// that plan.ts degrades to manual (warning). Used to prove the engine emits no
// provision/teardown/merge for it.
function scaffoldParallelExternal(): string {
  const root = mkdtempSync(join(tmpdir(), 'next-parext-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), `---\nexecution: parallel\nisolation: external\n---\n# P\n\n## End State\nx\n`);
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-setup.md'), '---\nstep_id: setup\n---\n# setup\n');
  writeFileSync(join(steps, '02-x.md'), '---\nstep_id: x\ndepends-on: [setup]\n---\n# x\n');
  writeFileSync(join(steps, '03-y.md'), '---\nstep_id: y\ndepends-on: [setup]\n---\n# y\n');
  return root;
}

// A realistic parallel shape: one root that FANS OUT to two independent
// branches, which then JOIN. plan.ts treats an explicit `depends-on: []` like
// "absent" (defaults to the preceding step), so genuine parallelism is expressed
// via a shared root, not two `[]` roots. Layers: [[setup], [x, y], [z]].
function scaffoldParallel(isolation: 'worktree' | 'manual' = 'worktree'): string {
  const root = mkdtempSync(join(tmpdir(), 'next-par-'));
  created.push(root);
  const iso = isolation === 'manual' ? '\nisolation: manual' : '';
  writeFileSync(join(root, 'PIPELINE.md'), `---\nexecution: parallel${iso}\n---\n# P\n\n## End State\nx\n`);
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-setup.md'), '---\nstep_id: setup\n---\n# setup\n');
  writeFileSync(join(steps, '02-x.md'), '---\nstep_id: x\ndepends-on: [setup]\n---\n# x\n');
  writeFileSync(join(steps, '03-y.md'), '---\nstep_id: y\ndepends-on: [setup]\n---\n# y\n');
  writeFileSync(join(steps, '04-z.md'), '---\nstep_id: z\ndepends-on: [x, y]\n---\n# z\n');
  return root;
}

/** Drive the engine through a single completed layer (with worktree branches),
 *  asserting an optional merge, and return the action that follows. */
function completeLayer(
  d: ReturnType<typeof driver>,
  ids: string[],
  opts: { worktree?: boolean } = {},
): NextAction {
  const results = ids.map((id) => ({
    step_id: id,
    outcome: 'completed' as const,
    ...(opts.worktree ? { worktree_branch: `wt-${id}`, worktree_path: `/wt/${id}` } : {}),
  }));
  let a = d.call({ kind: 'layer', results });
  if (a.action === 'merge') a = d.call({ kind: 'merge', conflict: false });
  return a;
}

const BOUNDED_RETRY = {
  implement: { goto: 'review' },
  review: [
    { when: 'changes_needed', goto: 'implement', max: 3 },
    { goto: 'package' },
  ],
};

function scaffoldGraph(): string {
  const root = mkdtempSync(join(tmpdir(), 'next-graph-'));
  created.push(root);
  writeFileSync(
    join(root, 'PIPELINE.md'),
    `# P\n\n## End State\nx\n\n## Graph\n\n\`\`\`json\n${JSON.stringify(BOUNDED_RETRY)}\n\`\`\`\n`,
  );
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-implement.md'), '---\nstep_id: implement\n---\n# implement\n');
  writeFileSync(join(steps, '02-review.md'), '---\nstep_id: review\n---\n# review\n');
  writeFileSync(join(steps, '03-package.md'), '---\nstep_id: package\n---\n# package\n');
  return root;
}

/** In-memory driver: threads engine state through successive computeNext calls.
 *  `baseOpts` injects fixed NextOpts (e.g. the external provision/teardown
 *  context) on every call; a per-call `opts` overrides it. */
function driver(plan: Plan, feedbackCount = 0, baseOpts: Partial<NextOpts> = {}) {
  let state: NextState | null = null;
  return {
    call(record: NextRecord | null, opts: Partial<{ start: string; resume: boolean }> = {}): NextAction {
      const r = computeNext(plan, state, record, { feedbackCount, ...baseOpts, ...opts });
      state = r.state;
      return r.action;
    },
    get state() {
      return state;
    },
  };
}

// The provision/teardown actions surface run/path context from NextOpts. A real
// run gets these from `pipeline next` (run id + cwd + --root); the in-memory
// driver injects fixed values so the matrix can assert them.
const EXT_OPTS: Partial<NextOpts> = {
  runId: 'run123abc456',
  projectRoot: '/proj/root',
  pipelineRoot: '/proj/root/.claude/pipeline/demo',
};

/** External driver: `driver` pre-loaded with the EXT_OPTS provision/teardown
 *  context (what the `pipeline next` command supplies for an external run). */
const extDriver = (plan: Plan, feedbackCount = 0) => driver(plan, feedbackCount, EXT_OPTS);

/** The standard provisioned record a manager sends after the create hook. */
const PROVISIONED: NextRecord = {
  kind: 'worktree',
  phase: 'provisioned',
  worktree_path: '/proj/root/.claude/worktrees/run123abc456',
  branch: 'worktree-run123abc456',
  env_file: '/proj/root/.claude/worktrees/run123abc456/.worktree.env',
};
const TORN_DOWN: NextRecord = { kind: 'worktree', phase: 'torn-down', ok: true };
/** Finalize records a manager sends after running the mandatory finalize hook. */
const FINALIZED: NextRecord = { kind: 'worktree', phase: 'finalized', ok: true };
const FINALIZED_FAIL: NextRecord = {
  kind: 'worktree',
  phase: 'finalized',
  ok: false,
  detail: 'push rejected (non-fast-forward)',
};

// --- sequential ------------------------------------------------------------

test('sequential: init runs step 1, advances on next_iteration, completes', () => {
  const plan = computePlan(scaffoldSequential(3));
  const d = driver(plan);

  let a = d.call(null);
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.concurrent).toBe(false);
  expect(a.steps[0].path).toBe(plan.steps[0].path);
  expect(a.steps[0].index).toBe(1);

  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].path).toBe(plan.steps[1].path);
  expect(a.steps[0].index).toBe(2);

  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[2].path });
  expect(a.action).toBe('run-step');

  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('done');
});

test('sequential: halt → halt action with status halted', () => {
  const plan = computePlan(scaffoldSequential(2));
  const d = driver(plan);
  d.call(null);
  const a = d.call({ kind: 'step', outcome: 'halted', halt_reason: 'tests failed' });
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.status).toBe('halted');
  expect(a.reason).toBe('tests failed');
});

test('sequential: depth-exhausted record → halt with that status', () => {
  const plan = computePlan(scaffoldSequential(2));
  const d = driver(plan);
  d.call(null);
  const a = d.call({ kind: 'step', outcome: 'depth-exhausted' });
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.status).toBe('depth-exhausted');
});

test('sequential: blocked → blocked action, then resume re-runs the step', () => {
  const plan = computePlan(scaffoldSequential(3));
  const d = driver(plan);
  d.call(null);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }); // now at step 2
  let a = d.call({ kind: 'step', outcome: 'blocked-delegating' });
  expect(a.action).toBe('blocked');
  // Supervisor resolves the blocker and re-invokes with --resume --start <step2>.
  a = d.call(null, { resume: true, start: plan.steps[1].path });
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].path).toBe(plan.steps[1].path);
});

test('sequential: an off-plan next_iteration path still dispatches (synthetic step)', () => {
  const plan = computePlan(scaffoldSequential(1));
  const d = driver(plan);
  d.call(null);
  // The step points Next at a path not enumerated in the plan (e.g. an unusual
  // nested file). The engine synthesizes a step rather than completing.
  const off = '/somewhere/.claude/pipeline/demo/steps/99-extra.md';
  const a = d.call({ kind: 'step', outcome: 'completed', next_iteration: off });
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].path).toBe(off);
  expect(a.steps[0].step_id).toBe('99-extra'); // derived from the filename stem
  expect(a.steps[0].index).toBe(2);
});

// --- improver / script-creator gating --------------------------------------

test('sequential: improvement brief → improver → no scripts → advance', () => {
  const plan = computePlan(scaffoldSequential(2));
  const d = driver(plan);
  d.call(null);
  let a = d.call({
    kind: 'step',
    outcome: 'completed',
    next_iteration: plan.steps[1].path,
    has_improvement_brief: true,
  });
  expect(a.action).toBe('run-improver');
  if (a.action !== 'run-improver') throw 0;
  expect(a.iteration_path).toBe(plan.steps[0].path);

  a = d.call({ kind: 'improver', applied: true, script_briefs: 0 });
  expect(a.action).toBe('run-step'); // advanced to step 2
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].path).toBe(plan.steps[1].path);
});

test('sequential: improver with 2 script briefs → 2 script-creators → advance', () => {
  const plan = computePlan(scaffoldSequential(2));
  const d = driver(plan);
  d.call(null);
  d.call({
    kind: 'step',
    outcome: 'completed',
    next_iteration: 'PIPELINE_COMPLETE',
    has_improvement_brief: true,
  });
  let a = d.call({ kind: 'improver', script_briefs: 2 });
  expect(a.action).toBe('run-script-creator');
  if (a.action !== 'run-script-creator') throw 0;
  expect(a.number).toBe(1);
  expect(a.of).toBe(2);

  a = d.call({ kind: 'script', outcome: 'created' });
  expect(a.action).toBe('run-script-creator');
  if (a.action !== 'run-script-creator') throw 0;
  expect(a.number).toBe(2);

  a = d.call({ kind: 'script', outcome: 'created' });
  expect(a.action).toBe('done'); // next_iteration was PIPELINE_COMPLETE
});

// --- retrospective gate ----------------------------------------------------

test('retrospective: skipped when no feedback files', () => {
  const plan = computePlan(scaffoldSequential(1));
  const d = driver(plan, 0);
  d.call(null);
  const a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('done');
});

test('retrospective: runs before done when feedback files exist', () => {
  const plan = computePlan(scaffoldSequential(1));
  const d = driver(plan, 3);
  d.call(null);
  let a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('retrospective');
  a = d.call({ kind: 'retro', done: true });
  expect(a.action).toBe('done');
});

test('retrospective: runs on halt too (feedback present)', () => {
  const plan = computePlan(scaffoldSequential(2));
  const d = driver(plan, 1);
  d.call(null);
  let a = d.call({ kind: 'step', outcome: 'halted', halt_reason: 'boom' });
  expect(a.action).toBe('retrospective');
  a = d.call({ kind: 'retro', done: true });
  expect(a.action).toBe('halt');
});

test('retrospective: NOT run on blocked-delegating', () => {
  const plan = computePlan(scaffoldSequential(2));
  const d = driver(plan, 5);
  d.call(null);
  const a = d.call({ kind: 'step', outcome: 'blocked-delegating' });
  expect(a.action).toBe('blocked');
});

// --- retrospective lint_warnings (design-time lints → improver pass) --------

// A sequential pipeline whose single iteration file blows the ~1500-token
// design-time budget (≈8400 bytes ≈ ~2100 estimated tokens) so computePlan
// emits the token-budget lint warning.
function scaffoldOverBudget(): string {
  const root = mkdtempSync(join(tmpdir(), 'next-lint-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-step.md'), '# step 01\n\n' + 'lorem ipsum dolor sit amet. '.repeat(300));
  return root;
}

test('retrospective: carries lint_warnings when the plan flagged an over-budget iteration', () => {
  const plan = computePlan(scaffoldOverBudget());
  expect(plan.warnings.some((w) => w.includes('budget'))).toBe(true);
  const d = driver(plan, 1); // feedback present → retro fires
  d.call(null);
  const a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('retrospective');
  if (a.action !== 'retrospective') throw 0;
  expect(a.lint_warnings).toEqual(plan.warnings);
  expect(a.lint_warnings!.some((w) => w.includes('budget'))).toBe(true);
});

test('retrospective: a lint-clean pipeline has NO lint_warnings key (byte-identical action)', () => {
  const plan = computePlan(scaffoldSequential(1));
  expect(plan.warnings).toEqual([]); // genuinely lint-clean
  const d = driver(plan, 2);
  d.call(null);
  const a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('retrospective');
  expect('lint_warnings' in a).toBe(false); // key OMITTED, not present-but-empty
  expect(JSON.stringify(a)).toBe('{"action":"retrospective"}');
});

test('retrospective lint_warnings survive a state round-trip + --resume re-entry', () => {
  const plan = computePlan(scaffoldOverBudget());
  expect(plan.warnings.length).toBeGreaterThan(0);
  const opts = { feedbackCount: 1 };
  // init: the warnings are captured into the persisted state.
  let r = computeNext(plan, null, null, opts);
  expect(r.action.action).toBe('run-step');
  expect(r.state.lint_warnings).toEqual(plan.warnings);
  // Simulate persistence: next.json write + read (JSON round-trip), then a
  // re-spawned manager re-entering via --resume (re-runs the current step).
  let state = JSON.parse(JSON.stringify(r.state)) as NextState;
  r = computeNext(plan, state, null, { ...opts, resume: true });
  expect(r.action.action).toBe('run-step');
  expect(r.state.lint_warnings).toEqual(plan.warnings);
  // Round-trip again, then complete terminal → the retro still carries them.
  state = JSON.parse(JSON.stringify(r.state)) as NextState;
  r = computeNext(plan, state, { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }, opts);
  expect(r.action.action).toBe('retrospective');
  if (r.action.action !== 'retrospective') throw 0;
  expect(r.action.lint_warnings).toEqual(plan.warnings);
});

test('retrospective: a legacy next.json WITHOUT lint_warnings loads fine (defaults to [], key omitted)', () => {
  const plan = computePlan(scaffoldSequential(1));
  let r = computeNext(plan, null, null, { feedbackCount: 1 });
  // Simulate a pre-field state file: strip the key entirely.
  const legacy = JSON.parse(JSON.stringify(r.state)) as NextState;
  delete (legacy as Partial<NextState>).lint_warnings;
  r = computeNext(plan, legacy, { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }, { feedbackCount: 1 });
  expect(r.action.action).toBe('retrospective');
  expect('lint_warnings' in r.action).toBe(false);
  expect(r.state.lint_warnings).toEqual([]); // normalized on load
});

// --- graph -----------------------------------------------------------------

test('graph: bounded retry loops back max times then falls through, then done', () => {
  const plan = computePlan(scaffoldGraph());
  expect(plan.graph).toBeTruthy();
  const d = driver(plan);
  const stepId = (a: NextAction) => (a.action === 'run-step' ? a.steps[0].step_id : a.action);

  // init → implement
  expect(stepId(d.call(null, { start: plan.steps[0].path }))).toBe('implement');
  // implement done → review
  expect(stepId(d.call({ kind: 'step', outcome: 'completed', flags: {} }))).toBe('review');
  // review changes_needed → implement (1)
  expect(stepId(d.call({ kind: 'step', outcome: 'completed', flags: { changes_needed: true } }))).toBe('implement');
  expect(stepId(d.call({ kind: 'step', outcome: 'completed', flags: {} }))).toBe('review');
  expect(stepId(d.call({ kind: 'step', outcome: 'completed', flags: { changes_needed: true } }))).toBe('implement'); // 2
  expect(stepId(d.call({ kind: 'step', outcome: 'completed', flags: {} }))).toBe('review');
  expect(stepId(d.call({ kind: 'step', outcome: 'completed', flags: { changes_needed: true } }))).toBe('implement'); // 3
  expect(stepId(d.call({ kind: 'step', outcome: 'completed', flags: {} }))).toBe('review');
  // 4th time: budget spent → fall through to package
  expect(stepId(d.call({ kind: 'step', outcome: 'completed', flags: { changes_needed: true } }))).toBe('package');
  // package is terminal in the graph → done
  expect(d.call({ kind: 'step', outcome: 'completed', flags: {} }).action).toBe('done');
});

// --- parallel / DAG --------------------------------------------------------

test('parallel worktree: root → fan-out layer → merge → join → done', () => {
  const plan = computePlan(scaffoldParallel('worktree'));
  expect(plan.mode).toBe('parallel');
  expect(plan.layers).toEqual([['setup'], ['x', 'y'], ['z']]);
  const d = driver(plan);

  // layer 0 — the root
  let a = d.call(null);
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.concurrent).toBe(true);
  expect(a.steps.map((s) => s.step_id)).toEqual(['setup']);
  expect(a.steps.every((s) => s.isolation === 'worktree')).toBe(true);

  // complete root → merge → fan-out layer [x, y]
  a = completeLayer(d, ['setup'], { worktree: true });
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.steps.map((s) => s.step_id).sort()).toEqual(['x', 'y']);
  expect(a.steps.every((s) => s.isolation === 'worktree')).toBe(true);

  // complete the fan-out → merge two branches → join layer [z]
  let mergeAction = d.call({
    kind: 'layer',
    results: [
      { step_id: 'x', outcome: 'completed', worktree_branch: 'wt-x', worktree_path: '/wt/x' },
      { step_id: 'y', outcome: 'completed', worktree_branch: 'wt-y', worktree_path: '/wt/y' },
    ],
  });
  expect(mergeAction.action).toBe('merge');
  if (mergeAction.action !== 'merge') throw 0;
  expect(mergeAction.branches.map((b) => b.branch).sort()).toEqual(['wt-x', 'wt-y']);
  a = d.call({ kind: 'merge', conflict: false });
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.steps.map((s) => s.step_id)).toEqual(['z']);

  // complete the join → merge → done
  a = completeLayer(d, ['z'], { worktree: true });
  expect(a.action).toBe('done');
});

test('parallel manual isolation: no merge, advances straight through', () => {
  const plan = computePlan(scaffoldParallel('manual'));
  expect(plan.isolation).toBe('manual');
  const d = driver(plan);
  let a = d.call(null);
  if (a.action !== 'run-step') throw 0;
  expect(a.steps.every((s) => s.isolation === null)).toBe(true);

  // root completes with no worktree branch → no merge, straight to [x, y]
  a = d.call({ kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] });
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.steps.map((s) => s.step_id).sort()).toEqual(['x', 'y']);

  a = d.call({ kind: 'layer', results: [{ step_id: 'x', outcome: 'completed' }, { step_id: 'y', outcome: 'completed' }] });
  expect(a.action).toBe('run-step'); // [z], no merge
  a = d.call({ kind: 'layer', results: [{ step_id: 'z', outcome: 'completed' }] });
  expect(a.action).toBe('done');
});

test('parallel: merge conflict halts the run', () => {
  const plan = computePlan(scaffoldParallel('worktree'));
  const d = driver(plan);
  d.call(null);
  completeLayer(d, ['setup'], { worktree: true }); // now at [x, y]
  d.call({
    kind: 'layer',
    results: [
      { step_id: 'x', outcome: 'completed', worktree_branch: 'wt-x' },
      { step_id: 'y', outcome: 'completed', worktree_branch: 'wt-y' },
    ],
  });
  const a = d.call({ kind: 'merge', conflict: true, detail: 'x and y both touched foo.ts' });
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.reason).toContain('conflict');
});

test('parallel: a halted step in a layer halts the run (no merge)', () => {
  const plan = computePlan(scaffoldParallel('worktree'));
  const d = driver(plan);
  d.call(null);
  completeLayer(d, ['setup'], { worktree: true }); // now at [x, y]
  const a = d.call({
    kind: 'layer',
    results: [
      { step_id: 'x', outcome: 'completed', worktree_branch: 'wt-x' },
      { step_id: 'y', outcome: 'halted', halt_reason: 'y failed' },
    ],
  });
  expect(a.action).toBe('halt');
});

test('parallel: improver runs per completed step before the next layer', () => {
  const plan = computePlan(scaffoldParallel('manual'));
  const d = driver(plan);
  d.call(null);
  d.call({ kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] }); // → [x, y]
  // both x and y emit briefs
  let a = d.call({
    kind: 'layer',
    results: [
      { step_id: 'x', outcome: 'completed', has_improvement_brief: true },
      { step_id: 'y', outcome: 'completed', has_improvement_brief: true },
    ],
  });
  expect(a.action).toBe('run-improver'); // for x
  a = d.call({ kind: 'improver', script_briefs: 0 });
  expect(a.action).toBe('run-improver'); // for y
  a = d.call({ kind: 'improver', script_briefs: 0 });
  expect(a.action).toBe('run-step'); // now layer [z]
  if (a.action !== 'run-step') throw 0;
  expect(a.steps.map((s) => s.step_id)).toEqual(['z']);
});

// --- external isolation (run-level worktree) -------------------------------

test('external sequential init: first action is provision-worktree (not run-step), carrying hook inputs', () => {
  const plan = computePlan(scaffoldExternal(3, { submodules: ['AppX', 'McpY'] }));
  expect(plan.isolation).toBe('external');
  const d = extDriver(plan);

  const a = d.call(null);
  expect(a.action).toBe('provision-worktree');
  if (a.action !== 'provision-worktree') throw 0;
  expect(a.run_id).toBe(EXT_OPTS.runId);
  expect(a.name).toBe(EXT_OPTS.runId);
  expect(a.base_branch).toBe('main');
  expect(a.submodules).toEqual(['AppX', 'McpY']);
  expect(a.hook_dir).toBe('.claude/pipeline/.hooks');
  expect(a.project_root).toBe(EXT_OPTS.projectRoot);
  expect(a.pipeline_root).toBe(EXT_OPTS.pipelineRoot);
  // No step has been dispatched yet.
  expect(d.state?.index).toBe(0);
  expect(d.state?.phase).toBe('await-provision');
  expect(d.state?.worktree_provisioned).toBe(false);
});

test('external: provisioned record → run-step carrying worktree_path, worktree_env_file, external_worktree', () => {
  const plan = computePlan(scaffoldExternal(3));
  const d = extDriver(plan);
  d.call(null); // provision-worktree

  const a = d.call(PROVISIONED);
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.concurrent).toBe(false);
  expect(a.steps[0].path).toBe(plan.steps[0].path);
  expect(a.steps[0].index).toBe(1);
  // The three informational fields are threaded; native isolation stays null.
  expect(a.steps[0].external_worktree).toBe(true);
  expect(a.steps[0].worktree_path).toBe('/proj/root/.claude/worktrees/run123abc456');
  expect(a.steps[0].worktree_env_file).toBe('/proj/root/.claude/worktrees/run123abc456/.worktree.env');
  expect(a.steps[0].isolation).toBe(null);
  // State recorded the worktree facts + flipped the provisioned gate.
  expect(d.state?.worktree_provisioned).toBe(true);
  expect(d.state?.worktree_path).toBe('/proj/root/.claude/worktrees/run123abc456');
  expect(d.state?.worktree_env_file).toBe('/proj/root/.claude/worktrees/run123abc456/.worktree.env');
});

test('external: every step (not just the first) carries the informational worktree fields', () => {
  const plan = computePlan(scaffoldExternal(3));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED); // step 1
  const a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].path).toBe(plan.steps[1].path);
  expect(a.steps[0].external_worktree).toBe(true);
  expect(a.steps[0].worktree_path).toBe('/proj/root/.claude/worktrees/run123abc456');
  expect(a.steps[0].worktree_env_file).toBe('/proj/root/.claude/worktrees/run123abc456/.worktree.env');
  expect(a.steps[0].isolation).toBe(null);
});

test('external terminal (completed): teardown-worktree before done', () => {
  const plan = computePlan(scaffoldExternal(1));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED); // step 1
  let a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('teardown-worktree');
  if (a.action !== 'teardown-worktree') throw 0;
  expect(a.outcome).toBe('completed');
  expect(a.run_id).toBe(EXT_OPTS.runId);
  expect(a.worktree_path).toBe('/proj/root/.claude/worktrees/run123abc456');
  // Outcome-aware: a COMPLETED run reaps its branch by default.
  expect(a.delete_branches).toBe(true);
  expect(d.state?.phase).toBe('await-teardown');
  // torn-down record → the real done
  a = d.call(TORN_DOWN);
  expect(a.action).toBe('done');
  expect(d.state?.phase).toBe('terminal');
});

test('external terminal (completed) with delete_branches: false frontmatter: teardown preserves the branch', () => {
  const plan = computePlan(scaffoldExternal(1, { deleteBranches: false }));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  const a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('teardown-worktree');
  if (a.action !== 'teardown-worktree') throw 0;
  expect(a.outcome).toBe('completed');
  expect(a.delete_branches).toBe(false); // the opt-out wins even on completed
});

test('external terminal (halted): teardown-worktree before halt, outcome halted', () => {
  const plan = computePlan(scaffoldExternal(2));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  let a = d.call({ kind: 'step', outcome: 'halted', halt_reason: 'tests failed' });
  expect(a.action).toBe('teardown-worktree');
  if (a.action !== 'teardown-worktree') throw 0;
  expect(a.outcome).toBe('halted');
  expect(a.delete_branches).toBe(false); // failed runs always preserve
  a = d.call(TORN_DOWN);
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.status).toBe('halted');
  expect(a.reason).toBe('tests failed');
});

test('external terminal (depth-exhausted): teardown-worktree before halt, outcome depth-exhausted', () => {
  const plan = computePlan(scaffoldExternal(2));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  let a = d.call({ kind: 'step', outcome: 'depth-exhausted' });
  expect(a.action).toBe('teardown-worktree');
  if (a.action !== 'teardown-worktree') throw 0;
  expect(a.outcome).toBe('depth-exhausted');
  expect(a.delete_branches).toBe(false); // failed runs always preserve
  a = d.call(TORN_DOWN);
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.status).toBe('depth-exhausted');
});

test('external post-retro path: retrospective → teardown-worktree → done (both seams wired)', () => {
  const plan = computePlan(scaffoldExternal(1));
  const d = extDriver(plan, 2); // feedback present → retro runs
  d.call(null);
  d.call(PROVISIONED);
  // step completes terminal; feedback exists → retrospective FIRST
  let a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('retrospective');
  // retro record → teardown (the second seam: post-retro, not the no-feedback one)
  a = d.call({ kind: 'retro', done: true });
  expect(a.action).toBe('teardown-worktree');
  // torn-down → done
  a = d.call(TORN_DOWN);
  expect(a.action).toBe('done');
});

test('external post-retro path on halt: retrospective → teardown-worktree → halt', () => {
  const plan = computePlan(scaffoldExternal(2));
  const d = extDriver(plan, 1);
  d.call(null);
  d.call(PROVISIONED);
  let a = d.call({ kind: 'step', outcome: 'halted', halt_reason: 'boom' });
  expect(a.action).toBe('retrospective');
  a = d.call({ kind: 'retro', done: true });
  expect(a.action).toBe('teardown-worktree');
  a = d.call(TORN_DOWN);
  expect(a.action).toBe('halt');
});

test('external blocked-delegating: NO teardown, blocked returned, worktree survives', () => {
  const plan = computePlan(scaffoldExternal(3));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED); // step 1
  const a = d.call({ kind: 'step', outcome: 'blocked-delegating' });
  expect(a.action).toBe('blocked');
  expect(d.state?.phase).toBe('blocked');
  expect(d.state?.status).toBe('blocked-delegating');
  // The worktree is untouched — still provisioned, path retained for the resume.
  expect(d.state?.worktree_provisioned).toBe(true);
  expect(d.state?.worktree_path).toBe('/proj/root/.claude/worktrees/run123abc456');
});

test('external resume (--resume) after blocker: re-emits provision-worktree, then resumes the step', () => {
  const plan = computePlan(scaffoldExternal(3));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }); // at step 2
  d.call({ kind: 'step', outcome: 'blocked-delegating' }); // blocked at step 2
  // supervisor resolves the blocker, re-invokes --resume --start <step2>
  let a = d.call(null, { resume: true, start: plan.steps[1].path });
  expect(a.action).toBe('provision-worktree'); // idempotent re-emit (never skipped)
  // manager re-runs the idempotent create hook → same worktree returned
  a = d.call(PROVISIONED);
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].path).toBe(plan.steps[1].path); // the RESUMED step, not step 1
  expect(a.steps[0].external_worktree).toBe(true);
});

test('external resume (no-record auto-resume): re-emits provision-worktree, then resumes', () => {
  const plan = computePlan(scaffoldExternal(3));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }); // at step 2
  // Manager crashed mid-step-2; the command synthesizes resume=true on a
  // no-record re-entry. Simulate that here by passing resume:true with no record.
  let a = d.call(null, { resume: true });
  expect(a.action).toBe('provision-worktree');
  a = d.call(PROVISIONED);
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].path).toBe(plan.steps[1].path);
});

test('external resume (crash-respawn --start): re-emits provision-worktree, then resumes the start step', () => {
  const plan = computePlan(scaffoldExternal(3));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }); // at step 2
  // Crash-respawn: supervisor uses `pipeline next --start <path>` (resume true).
  let a = d.call(null, { resume: true, start: plan.steps[2].path });
  expect(a.action).toBe('provision-worktree');
  a = d.call(PROVISIONED);
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].path).toBe(plan.steps[2].path); // honored --start
});

test('external terminal re-entry: NO second teardown-worktree (fire-once guard)', () => {
  const plan = computePlan(scaffoldExternal(1));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }); // teardown
  let a = d.call(TORN_DOWN); // done
  expect(a.action).toBe('done');
  // A no-record re-entry at terminal must NOT re-emit teardown.
  a = d.call(null);
  expect(a.action).toBe('done');
  expect(d.state?.phase).toBe('terminal');
  // Even an explicit --resume at terminal is a no-op (resume gate: phase==='terminal').
  a = d.call(null, { resume: true });
  expect(a.action).toBe('done');
});

test('external crash during teardown (await-teardown resume): re-runs teardown, NOT provision', () => {
  const plan = computePlan(scaffoldExternal(1));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  let a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('teardown-worktree');
  // Crash before the torn-down record. Supervisor re-spawns with --resume.
  a = d.call(null, { resume: true });
  expect(a.action).toBe('teardown-worktree'); // re-teardown, never re-provision
  a = d.call(TORN_DOWN);
  expect(a.action).toBe('done');
});

test('external: provisioned record with ok:false → halt (create hook failed), NO teardown ever', () => {
  const plan = computePlan(scaffoldExternal(2));
  const d = extDriver(plan);
  d.call(null); // provision-worktree
  const a = d.call({ kind: 'worktree', phase: 'provisioned', ok: false, detail: 'boom on create' });
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.status).toBe('halted');
  expect(a.reason).toContain('worktree-create hook failed');
  expect(a.reason).toContain('boom on create');
  // Nothing was provisioned, so teardown must never fire.
  expect(d.state?.worktree_provisioned).toBe(false);
  expect(d.state?.phase).toBe('terminal');
  // A re-entry stays terminal — still no teardown-worktree.
  const b = d.call(null);
  expect(b.action).toBe('halt');
});

test('external: provisioned ok:false with no detail → halt reason falls back to unknown', () => {
  const plan = computePlan(scaffoldExternal(1));
  const d = extDriver(plan);
  d.call(null);
  const a = d.call({ kind: 'worktree', phase: 'provisioned', ok: false });
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.reason).toBe('worktree-create hook failed: unknown');
});

test('external: provisioned ok:true (explicit) still succeeds (only ok:false halts)', () => {
  const plan = computePlan(scaffoldExternal(1));
  const d = extDriver(plan);
  d.call(null);
  const a = d.call({ kind: 'worktree', phase: 'provisioned', ok: true, worktree_path: '/wt/x', branch: null, env_file: null });
  expect(a.action).toBe('run-step');
  expect(d.state?.worktree_provisioned).toBe(true);
  expect(d.state?.worktree_path).toBe('/wt/x');
});

test('external: base_branch frontmatter is threaded into BOTH provision-worktree AND finalize-worktree actions', () => {
  const plan = computePlan(scaffoldExternal(1, { finalize: true, baseBranch: 'develop' }));
  expect(plan.base_branch).toBe('develop');
  const d = extDriver(plan);
  let a = d.call(null);
  expect(a.action).toBe('provision-worktree');
  if (a.action !== 'provision-worktree') throw 0;
  expect(a.base_branch).toBe('develop');
  d.call(PROVISIONED);
  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('finalize-worktree');
  if (a.action !== 'finalize-worktree') throw 0;
  expect(a.base_branch).toBe('develop');
});

test('external: base_branch absent → provision and finalize actions default to main', () => {
  const plan = computePlan(scaffoldExternal(1, { finalize: true }));
  expect(plan.base_branch).toBe('main');
  const d = extDriver(plan);
  let a = d.call(null);
  if (a.action !== 'provision-worktree') throw 0;
  expect(a.base_branch).toBe('main');
  d.call(PROVISIONED);
  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  if (a.action !== 'finalize-worktree') throw 0;
  expect(a.base_branch).toBe('main');
});

test('external plan-error halt (no steps): NO provision-worktree, NO teardown-worktree', () => {
  // An external pipeline with ZERO iteration files. plan.errors is non-empty and
  // plan.steps is empty; the engine never provisions, so teardown is skipped too.
  const root = mkdtempSync(join(tmpdir(), 'next-ext-empty-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '---\nisolation: external\n---\n# P\n## End State\nx\n');
  mkdirSync(join(root, 'steps'), { recursive: true });
  const plan = computePlan(root);
  expect(plan.isolation).toBe('external');
  expect(plan.steps.length).toBe(0);
  const d = extDriver(plan);
  const a = d.call(null);
  // No worktree provisioned ⇒ a no-files halt with no teardown.
  expect(a.action).toBe('halt');
  expect(d.state?.worktree_provisioned).toBe(false);
});

// --- finalize stage (opt-in, mandatory-before-done, external only) -----------

test('finalize success: completed → finalize-worktree → teardown → done (journal completed → finalized → destroyed)', () => {
  const plan = computePlan(scaffoldExternal(1, { finalize: true }));
  expect(plan.finalize).toBe(true);
  const d = extDriver(plan);
  d.call(null); // provision
  d.call(PROVISIONED); // step 1
  // Terminal completion now inserts finalize BEFORE teardown.
  let a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('finalize-worktree');
  if (a.action !== 'finalize-worktree') throw 0;
  expect(a.outcome).toBe('completed');
  expect(a.run_id).toBe(EXT_OPTS.runId);
  expect(a.worktree_path).toBe('/proj/root/.claude/worktrees/run123abc456');
  expect(a.hook_dir).toBe('.claude/pipeline/.hooks');
  expect(d.state?.phase).toBe('await-finalize');
  // finalize succeeds → teardown (outcome still completed) → done.
  a = d.call(FINALIZED);
  expect(a.action).toBe('teardown-worktree');
  if (a.action !== 'teardown-worktree') throw 0;
  expect(a.outcome).toBe('completed');
  expect(d.state?.finalize_ok).toBe(true);
  a = d.call(TORN_DOWN);
  expect(a.action).toBe('done');
  expect(d.state?.phase).toBe('terminal');
});

test('finalize failure ({ok:false}): status=halted, worktree PRESERVED (teardown outcome=halted, run halts)', () => {
  const plan = computePlan(scaffoldExternal(1, { finalize: true }));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  let a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('finalize-worktree');
  // finalize FAILS — the run must NOT reach done. It halts, and teardown runs
  // with outcome=halted so the consumer's destroy hook PRESERVES the worktree
  // (the OPPOSITE terminal effect of the destroy-soft-fail test, which reaches done).
  a = d.call(FINALIZED_FAIL);
  expect(a.action).toBe('teardown-worktree');
  if (a.action !== 'teardown-worktree') throw 0;
  expect(a.outcome).toBe('halted'); // the preserve-on-halt signal to the destroy hook
  expect(d.state?.status).toBe('halted');
  expect(d.state?.halt_reason).toContain('worktree-finalize hook failed');
  expect(d.state?.halt_reason).toContain('push rejected');
  expect(d.state?.finalize_ok).toBe(false);
  // The worktree was never un-provisioned; it survives for inspection/retry.
  expect(d.state?.worktree_provisioned).toBe(true);
  a = d.call(TORN_DOWN);
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.status).toBe('halted');
  expect(a.reason).toContain('worktree-finalize hook failed');
});

test('finalize: a missing/wrong record in await-finalize is treated as failure → halt (never silently torn down)', () => {
  const plan = computePlan(scaffoldExternal(1, { finalize: true }));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  expect(d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }).action).toBe('finalize-worktree');
  // Wrong record kind arrives → cannot confirm finalize succeeded → halt (with
  // teardown outcome=halted so the worktree is still preserved), never a clean done.
  const a = d.call({ kind: 'retro', done: true });
  expect(a.action).toBe('teardown-worktree');
  if (a.action !== 'teardown-worktree') throw 0;
  expect(a.outcome).toBe('halted');
  expect(d.state?.status).toBe('halted');
  expect(d.state?.halt_reason).toContain('finalize did not confirm success');
});

test('finalize crash resume (await-finalize): re-emits finalize-worktree, NOT provision, NOT teardown', () => {
  const plan = computePlan(scaffoldExternal(1, { finalize: true }));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  let a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('finalize-worktree');
  // Crash before the finalized record. Supervisor re-spawns with --resume.
  a = d.call(null, { resume: true });
  expect(a.action).toBe('finalize-worktree'); // idempotent re-emit, never re-provision/re-teardown
  expect(d.state?.phase).toBe('await-finalize');
  a = d.call(FINALIZED);
  expect(a.action).toBe('teardown-worktree');
  a = d.call(TORN_DOWN);
  expect(a.action).toBe('done');
});

test('finalize post-retro path: completed → retrospective → finalize-worktree → teardown → done (both seams wired)', () => {
  const plan = computePlan(scaffoldExternal(1, { finalize: true }));
  const d = extDriver(plan, 2); // feedback present → retro runs first
  d.call(null);
  d.call(PROVISIONED);
  let a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('retrospective');
  a = d.call({ kind: 'retro', done: true });
  expect(a.action).toBe('finalize-worktree'); // finalize inserted post-retro, before teardown
  a = d.call(FINALIZED);
  expect(a.action).toBe('teardown-worktree');
  a = d.call(TORN_DOWN);
  expect(a.action).toBe('done');
});

test('finalize NOT run on a halted run: a step-halt goes straight to teardown (only completed finalizes)', () => {
  const plan = computePlan(scaffoldExternal(2, { finalize: true }));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  // The run is ALREADY halting — it is not asked to finalize. Straight to teardown.
  const a = d.call({ kind: 'step', outcome: 'halted', halt_reason: 'tests failed' });
  expect(a.action).toBe('teardown-worktree');
  if (a.action !== 'teardown-worktree') throw 0;
  expect(a.outcome).toBe('halted');
});

test('finalize opt-OUT (default): a completed external run goes straight to teardown, NO finalize-worktree ever', () => {
  const plan = computePlan(scaffoldExternal(1)); // no finalize frontmatter
  expect(plan.finalize).toBe(false);
  const d = extDriver(plan);
  const actions: string[] = [];
  actions.push(d.call(null).action); // provision
  actions.push(d.call(PROVISIONED).action); // run-step
  actions.push(d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }).action); // teardown
  actions.push(d.call(TORN_DOWN).action); // done
  expect(actions).toEqual(['provision-worktree', 'run-step', 'teardown-worktree', 'done']);
  expect(actions).not.toContain('finalize-worktree');
});

test('finalize: teardown result is now observable in state (teardown_ok / teardown_detail)', () => {
  const plan = computePlan(scaffoldExternal(1));
  const d = extDriver(plan);
  d.call(null);
  d.call(PROVISIONED);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }); // teardown
  const a = d.call({ kind: 'worktree', phase: 'torn-down', ok: false, detail: 'registry row missing' });
  expect(a.action).toBe('done'); // a leaked worktree never strands the run
  expect(d.state?.teardown_ok).toBe(false);
  expect(d.state?.teardown_detail).toBe('registry row missing');
});

test('parallel + external: degrades to manual — NO provision, NO teardown, NO merge', () => {
  const plan = computePlan(scaffoldParallelExternal());
  expect(plan.mode).toBe('parallel');
  expect(plan.isolation).toBe('manual'); // rewritten by plan.ts
  const d = extDriver(plan);

  // Init dispatches the layer directly — never provision-worktree.
  let a = d.call(null);
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.concurrent).toBe(true);
  expect(a.steps.every((s) => s.isolation === null)).toBe(true);
  expect(a.steps.every((s) => s.external_worktree === undefined)).toBe(true);

  // layer [setup] → [x, y]; manual ⇒ no merge ever.
  a = d.call({ kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] });
  expect(a.action).toBe('run-step');
  a = d.call({
    kind: 'layer',
    results: [{ step_id: 'x', outcome: 'completed' }, { step_id: 'y', outcome: 'completed' }],
  });
  // run completes → done directly, never teardown-worktree, never merge.
  expect(a.action).toBe('done');
});

test('regression — isolation: worktree (default): ZERO provision/teardown ever', () => {
  const plan = computePlan(scaffoldSequential(3)); // no isolation frontmatter → default worktree
  expect(plan.isolation).toBe('worktree');
  const d = extDriver(plan); // even with EXT_OPTS supplied, no external action emits
  const actions: string[] = [];
  let a = d.call(null);
  actions.push(a.action);
  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  actions.push(a.action);
  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[2].path });
  actions.push(a.action);
  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  actions.push(a.action);
  expect(actions).toEqual(['run-step', 'run-step', 'run-step', 'done']);
  // and no step ever carried the external fields
  expect(d.state).toBeTruthy();
});

test('regression — isolation: manual: ZERO provision/teardown ever', () => {
  // Sequential + manual: byte-for-byte the legacy in-place flow.
  const root = mkdtempSync(join(tmpdir(), 'next-man-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '---\nisolation: manual\n---\n# P\n## End State\nx\n');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-step.md'), '# s1\n');
  writeFileSync(join(steps, '02-step.md'), '# s2\n');
  const plan = computePlan(root);
  expect(plan.isolation).toBe('manual');
  const d = extDriver(plan);
  let a = d.call(null);
  expect(a.action).toBe('run-step');
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].external_worktree).toBe(undefined);
  expect(a.steps[0].isolation).toBe(null);
  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  expect(a.action).toBe('done'); // straight to done, no teardown
});

test('regression — parallel worktree still merges (external machinery untouched)', () => {
  const plan = computePlan(scaffoldParallel('worktree'));
  const d = extDriver(plan);
  let a = d.call(null);
  if (a.action !== 'run-step') throw 0;
  expect(a.steps.every((s) => s.isolation === 'worktree')).toBe(true);
  expect(a.steps.every((s) => s.external_worktree === undefined)).toBe(true);
  // root → merge → fan-out (proves the worktree merge gate is unaffected)
  a = completeLayer(d, ['setup'], { worktree: true });
  expect(a.action).toBe('run-step');
});

// --- CLI integration (persistence on disk) ---------------------------------

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

function next(root: string, runId: string, extra: string[], envVars?: Record<string, string>) {
  // Controlled cwd + env: `pipeline next` now auto-emits UI events whose journal
  // resolves from the subprocess cwd — running from the repo checkout would leak
  // events into the plugin repo itself. cwd = the temp pipeline root (no .git →
  // the journal lands inside the temp dir), HOME/USERPROFILE = the temp dir too
  // (so the writer's daemon-lock/mirror paths never touch the real ~/.claude).
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PIPELINE_UI_RUN_ID;
  delete env.PIPELINE_UI_PARENT_RUN_ID;
  delete env.CLAUDE_SESSION_ID;
  // Deterministic PP_* environment for the variable tests: a stray PP_* var in
  // the developer's shell must never satisfy (or fail) a fixture resolution.
  for (const k of Object.keys(env)) if (k.startsWith('PP_')) delete env[k];
  Object.assign(env, envVars ?? {});
  env.USERPROFILE = root;
  env.HOME = root;
  // process.execPath (the real bun binary), NOT the string 'bun': with an npm
  // shim install (bun.ps1/.cmd), spawnSync('bun', …, { env }) defeats Bun's
  // self-spawn special case and stdout comes back null.
  const r = spawnSync(process.execPath, [CLI, 'next', '--root', root, '--run-id', runId, ...extra], { encoding: 'utf8', cwd: root, env });
  return { json: JSON.parse(r.stdout), status: r.status, stderr: r.stderr };
}

test('pipeline next CLI: drives a sequential run with on-disk state', () => {
  const root = scaffoldSequential(2);
  const run = 'seqrun';
  const plan = computePlan(root);

  // init → step 1
  let r = next(root, run, []);
  expect(r.json.action).toBe('run-step');
  expect(r.json.steps[0].path).toBe(plan.steps[0].path);
  // gitignore + state persisted
  expect(existsSync(join(root, '.runtime', '.gitignore'))).toBe(true);
  expect(existsSync(join(root, '.runtime', run, 'next.json'))).toBe(true);

  // record step 1 completed → step 2
  r = next(root, run, ['--record', JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path })]);
  expect(r.json.action).toBe('run-step');
  expect(r.json.steps[0].path).toBe(plan.steps[1].path);

  // record step 2 completed terminal → done (exit 0)
  r = next(root, run, ['--record', JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' })]);
  expect(r.json.action).toBe('done');
  expect(r.status).toBe(0);
});

test('pipeline next CLI: a no-record re-spawn auto-resumes the current step', () => {
  const root = scaffoldSequential(3);
  const run = 'respawn';
  const plan = computePlan(root);
  next(root, run, []); // init → step 1
  next(root, run, ['--record', JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path })]); // → step 2
  // Manager "crashed"; supervisor re-spawns it. A no-record call must NOT halt —
  // it auto-resumes and re-runs the current step (step 2).
  const r = next(root, run, ['--start', plan.steps[1].path]);
  expect(r.json.action).toBe('run-step');
  expect(r.json.steps[0].path).toBe(plan.steps[1].path);
});

test('pipeline next CLI: plan errors → halt with exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'next-err-'));
  created.push(root);
  // execution: parallel + a cyclic depends-on → plan error
  writeFileSync(join(root, 'PIPELINE.md'), '---\nexecution: parallel\n---\n# P\n## End State\nx\n');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-a.md'), '---\nstep_id: a\ndepends-on: [b]\n---\n# a\n');
  writeFileSync(join(steps, '02-b.md'), '---\nstep_id: b\ndepends-on: [a]\n---\n# b\n');
  const r = next(root, 'errrun', []);
  expect(r.json.action).toBe('halt');
  expect(r.status).toBe(1);
});

test('pipeline next CLI: a MID-RUN plan error halts through the terminal seam (state parked terminal halted)', () => {
  const root = scaffoldSequential(2);
  const run = 'midplanerr';
  next(root, run, []); // init → step 1 (state persisted, non-terminal)
  // The plan acquires an error MID-RUN: all iteration files vanish.
  rmSync(join(root, 'steps'), { recursive: true, force: true });
  const r = next(root, run, ['--record', JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' })]);
  expect(r.json.action).toBe('halt');
  expect(r.json.reason).toContain('plan errors');
  expect(r.status).toBe(1);
  // Pre-fix, the early-return left the state parked NON-terminal forever.
  const st = JSON.parse(readFileSync(join(root, '.runtime', run, 'next.json'), 'utf8'));
  expect(st.phase).toBe('terminal');
  expect(st.status).toBe('halted');
  expect(st.halt_reason).toContain('plan errors');
});

test('pipeline next CLI: graph run completes via on-disk counters', () => {
  const root = scaffoldGraph();
  const run = 'graphrun';
  const startPath = join(root, 'steps', '01-implement.md');
  expect(next(root, run, ['--start', startPath]).json.steps[0].step_id).toBe('implement');
  expect(next(root, run, ['--record', JSON.stringify({ kind: 'step', outcome: 'completed', flags: {} })]).json.steps[0].step_id).toBe('review');
  // review with no changes → package
  expect(
    next(root, run, ['--record', JSON.stringify({ kind: 'step', outcome: 'completed', flags: { changes_needed: false } })]).json.steps[0].step_id,
  ).toBe('package');
  // package terminal → done
  const done = next(root, run, ['--record', JSON.stringify({ kind: 'step', outcome: 'completed', flags: {} })]);
  expect(done.json.action).toBe('done');
  expect(done.status).toBe(0);
});

// --- Bug 3: --record robustness (Windows paths) + loud malformed-record error -

test('pipeline next CLI: --record with an unescaped Windows path parses (step NOT swallowed)', () => {
  const root = scaffoldSequential(1);
  const run = 'winpath';
  next(root, run, []); // init → step 1, state persisted

  // A manually-built record (NOT JSON.stringify) embedding a raw Windows path
  // whose `\P`/`\R` are INVALID JSON escapes. The template's `\\` collapses to a
  // single backslash in the actual arg, so the CLI receives `...C:\Projects\Repo`.
  // Pre-fix: JSON.parse threw → parseRecord returned null → the engine treated it
  // as "no record" and SILENTLY auto-resumed (re-ran step 1), discarding the
  // completed step. Post-fix: backslash normalization rescues it → the completed
  // terminal step advances to `done`.
  const raw = `{"kind":"step","outcome":"completed","next_iteration":"PIPELINE_COMPLETE","cwd":"C:\\Projects\\Repo"}`;
  const r = next(root, run, ['--record', raw]);
  expect(r.json.action).toBe('done');
  expect(r.status).toBe(0);
});

test('pipeline next CLI: a malformed --record is a LOUD exit-2 error, never a silent auto-resume', () => {
  const root = scaffoldSequential(2);
  const run = 'badrec';
  const plan = computePlan(root);
  next(root, run, []); // init → step 1, state persisted (step 1 in flight)

  // Garbage that is not JSON even after backslash normalization. Call spawnSync
  // directly (not the `next` helper) because stdout is empty on the error path.
  const bad = spawnSync(
    process.execPath,
    [CLI, 'next', '--root', root, '--run-id', run, '--record', '{"kind":"step","outcome":'],
    { encoding: 'utf8' },
  );
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('--record');
  expect(bad.stdout.trim()).toBe(''); // returned BEFORE computeNext → no action emitted

  // The completed step was NOT swallowed: state is untouched, so a subsequent
  // VALID record for step 1 still advances to step 2 (the manager's retry path).
  const ok = next(root, run, [
    '--record',
    JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }),
  ]);
  expect(ok.json.action).toBe('run-step');
  expect(ok.json.steps[0].path).toBe(plan.steps[1].path);
});

test('pipeline next CLI (--manual-hooks): external run drives provision → step → teardown → done on disk', () => {
  // --manual-hooks = the legacy record-driven actuation path. Without it the
  // command executes the consumer hooks in-process (covered by hooks.test.ts).
  const root = scaffoldExternal(1);
  const run = 'extruncli'; // run id surfaced as PIPELINE_WT_NAME/RUN_ID
  const plan = computePlan(root);

  // init → provision-worktree (run/path context threaded from the command)
  let r = next(root, run, ['--manual-hooks']);
  expect(r.json.action).toBe('provision-worktree');
  expect(r.json.run_id).toBe(run);
  expect(r.json.name).toBe(run);
  expect(r.json.hook_dir).toBe('.claude/pipeline/.hooks');
  expect(existsSync(join(root, '.runtime', run, 'next.json'))).toBe(true);

  // record provisioned → run-step carrying the informational worktree fields
  const prov = JSON.stringify({
    kind: 'worktree',
    phase: 'provisioned',
    worktree_path: '/wt/extruncli',
    branch: 'worktree-extruncli',
    env_file: '/wt/extruncli/.worktree.env',
  });
  r = next(root, run, ['--manual-hooks', '--record', prov]);
  expect(r.json.action).toBe('run-step');
  expect(r.json.steps[0].path).toBe(plan.steps[0].path);
  expect(r.json.steps[0].external_worktree).toBe(true);
  expect(r.json.steps[0].worktree_path).toBe('/wt/extruncli');
  expect(r.json.steps[0].worktree_env_file).toBe('/wt/extruncli/.worktree.env');
  expect(r.json.steps[0].isolation).toBe(null);

  // record step completed terminal → teardown-worktree (not done yet)
  r = next(root, run, ['--manual-hooks', '--record', JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' })]);
  expect(r.json.action).toBe('teardown-worktree');
  expect(r.json.outcome).toBe('completed');
  expect(r.json.worktree_path).toBe('/wt/extruncli');

  // record torn-down → the real done (exit 0)
  r = next(root, run, ['--manual-hooks', '--record', JSON.stringify({ kind: 'worktree', phase: 'torn-down', ok: true })]);
  expect(r.json.action).toBe('done');
  expect(r.status).toBe(0);
});

test('pipeline next CLI (--manual-hooks): finalize:true external run drives provision → step → finalize → teardown → done on disk', () => {
  // finalize opt-in via PIPELINE.md `finalize: true`; --manual-hooks makes the
  // command PRINT the raw finalize-worktree action (the manager actuates it and
  // records the outcome), the legacy actuation path.
  const root = scaffoldExternal(1, { finalize: true });
  const run = 'finruncli';
  const plan = computePlan(root);
  expect(plan.finalize).toBe(true);

  let r = next(root, run, ['--manual-hooks']);
  expect(r.json.action).toBe('provision-worktree');

  const prov = JSON.stringify({ kind: 'worktree', phase: 'provisioned', worktree_path: '/wt/finruncli', branch: 'b', env_file: null });
  r = next(root, run, ['--manual-hooks', '--record', prov]);
  expect(r.json.action).toBe('run-step');
  expect(r.json.steps[0].path).toBe(plan.steps[0].path);

  // step completed terminal → finalize-worktree (NOT teardown yet) with its context
  r = next(root, run, ['--manual-hooks', '--record', JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' })]);
  expect(r.json.action).toBe('finalize-worktree');
  expect(r.json.outcome).toBe('completed');
  expect(r.json.worktree_path).toBe('/wt/finruncli');
  expect(r.json.run_id).toBe(run);

  // finalized ok → teardown-worktree
  r = next(root, run, ['--manual-hooks', '--record', JSON.stringify({ kind: 'worktree', phase: 'finalized', ok: true })]);
  expect(r.json.action).toBe('teardown-worktree');

  // torn-down → done (exit 0)
  r = next(root, run, ['--manual-hooks', '--record', JSON.stringify({ kind: 'worktree', phase: 'torn-down', ok: true })]);
  expect(r.json.action).toBe('done');
  expect(r.status).toBe(0);
});

// ---------------------------------------------------------------------------
// PP_* variables — run-init resolve → validate → freeze (env-variables design
// 05 §3, P2): `--var`/`--vars-file` flags, the F2 halt, D11 freeze/resume
// semantics, the F10 legacy one-time init, and ActionStep.source_path.
// ---------------------------------------------------------------------------

/** A sequential pipeline declaring variables (## Variables at PIPELINE.md:6;
 *  PP_SERVICE declared on line 7, PP_MODE on 8, PP_OPT on 9) with occurrences
 *  in both step bodies (each on line 3 of its file). */
function scaffoldVars(): string {
  const root = mkdtempSync(join(tmpdir(), 'next-vars-'));
  created.push(root);
  writeFileSync(
    join(root, 'PIPELINE.md'),
    [
      '# P',
      '',
      '## End State',
      'x',
      '',
      '## Variables',
      '- PP_SERVICE (required) — service under release',
      '- PP_MODE (default: fast) — build mode',
      '- PP_OPT — optional knob',
      '',
    ].join('\n'),
  );
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-a.md'), '# a\n\nDeploy ${PP_SERVICE} in ${PP_MODE} mode. Opt: ${PP_OPT:-none}.\n');
  writeFileSync(join(steps, '02-b.md'), '# b\n\nAnnounce ${PP_SERVICE}.\n');
  return root;
}

const readState = (root: string, run: string) =>
  JSON.parse(readFileSync(join(root, '.runtime', run, 'next.json'), 'utf8'));

test('vars: run init resolves --var > env > manifest default and FREEZES the map into next.json; source_path always set', () => {
  const root = scaffoldVars();
  const run = 'varfreeze';
  // PP_SERVICE from --var (beats the env value), PP_MODE from its manifest
  // default, PP_OPT explicitly EMPTY via `--var PP_OPT=` (resolved-empty is a
  // value, distinct from unresolved).
  const r = next(root, run, ['--var', 'PP_SERVICE=payments', '--var', 'PP_OPT='], { PP_SERVICE: 'env-loses' });
  expect(r.status).toBe(0);
  expect(r.json.action).toBe('run-step');
  // ActionStep.source_path: always present. This pipeline declares variables,
  // so the agent dispatch is RENDERED (a5): source_path keeps the source plan
  // path while path points into the run's rendered shadow tree.
  expect(r.json.steps[0].source_path).toBe(join(root, 'steps', '01-a.md'));
  expect(r.json.steps[0].path).toBe(
    join(root, '.runtime', run, 'rendered', basename(root), 'steps', '01-a.md'),
  );
  expect(readState(root, run).variables).toEqual({ PP_SERVICE: 'payments', PP_MODE: 'fast', PP_OPT: '' });
});

test('vars: E9 zero-change — a pipeline without declarations never gains a variables key', () => {
  const root = scaffoldSequential(1);
  const run = 'novars';
  expect(next(root, run, []).json.action).toBe('run-step');
  expect('variables' in readState(root, run)).toBe(false);
});

test('vars: resume reuses the frozen map VERBATIM — no environment re-read after init (07 P2 gate)', () => {
  const root = scaffoldVars();
  const run = 'varresume';
  // Init resolves PP_SERVICE from the ENVIRONMENT tier.
  expect(next(root, run, [], { PP_SERVICE: 'from-env' }).json.action).toBe('run-step');
  expect(readState(root, run).variables.PP_SERVICE).toBe('from-env');
  // The environment drifts between sessions; a no-record auto-resume re-enters
  // the run — the frozen value MUST survive untouched.
  const r = next(root, run, [], { PP_SERVICE: 'drifted' });
  expect(r.json.action).toBe('run-step');
  expect(readState(root, run).variables.PP_SERVICE).toBe('from-env');
});

test('vars: --var on a frozen run is REJECTED (D11) as a USAGE error — state untouched, flag-less resume still works', () => {
  const root = scaffoldVars();
  const run = 'varfrozen';
  expect(next(root, run, ['--var', 'PP_SERVICE=payments']).json.action).toBe('run-step');
  const before = readFileSync(join(root, '.runtime', run, 'next.json'), 'utf8');

  // Exit 2 (usage), stderr message, NO stdout action: the run is intact — a
  // halt-shaped rejection would let callers (drive) record a phantom
  // run.halted for a perfectly healthy run.
  const spawnRejected = (extra: string[]) =>
    spawnSync(process.execPath, [CLI, 'next', '--root', root, '--run-id', run, ...extra], {
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root },
    });
  const rejected = spawnRejected(['--resume', '--var', 'PP_SERVICE=other']);
  expect(rejected.status).toBe(2);
  expect(rejected.stderr).toContain('variables are frozen');
  expect(rejected.stderr).toContain('start a new run');
  expect(rejected.stdout.trim()).toBe(''); // no action emitted
  // A --vars-file alongside a frozen map is rejected the same way.
  const vf = join(root, 'extra.env');
  writeFileSync(vf, 'PP_SERVICE=other\n');
  const rejectedFile = spawnRejected(['--resume', '--vars-file', vf]);
  expect(rejectedFile.status).toBe(2);
  expect(rejectedFile.stderr).toContain('variables are frozen');
  // The rejection changed NOTHING on disk — the run resumes normally without flags.
  expect(readFileSync(join(root, '.runtime', run, 'next.json'), 'utf8')).toBe(before);
  const resumed = next(root, run, ['--resume']);
  expect(resumed.json.action).toBe('run-step');
  expect(readState(root, run).variables.PP_SERVICE).toBe('payments');
});

test('vars: invokeNext embedder entry defensively refuses cliVars on a frozen run (state untouched)', async () => {
  // `pipeline next`/`drive` reject at the command layer (exit 2); a direct
  // invokeNext caller gets the same refusal as a code-1 halt-shaped result
  // BEFORE the composition router could descend anywhere.
  const { invokeNext } = await import('../src/commands/next');
  const root = scaffoldVars();
  const run = 'varembed';
  expect(next(root, run, ['--var', 'PP_SERVICE=payments']).json.action).toBe('run-step');
  const before = readFileSync(join(root, '.runtime', run, 'next.json'), 'utf8');
  const res = invokeNext({ root, runId: run, cliVars: { PP_SERVICE: 'other' }, resume: true });
  expect(res.code).toBe(1);
  expect(res.action.action).toBe('halt');
  expect((res.action as { reason?: string }).reason).toContain('variables are frozen');
  expect(readFileSync(join(root, '.runtime', run, 'next.json'), 'utf8')).toBe(before);
});

test('vars: E9 — an EMPTY --vars-file on a declaration-less pipeline never freezes `variables: {}`', () => {
  const root = scaffoldSequential(2);
  const run = 'varemptyfile';
  const vf = join(root, 'empty.env');
  writeFileSync(vf, '# just comments\n\n');
  const r = next(root, run, ['--vars-file', vf]);
  expect(r.json.action).toBe('run-step');
  // No declarations → no key, even though flags were technically supplied.
  expect('variables' in readState(root, run)).toBe(false);
  // …and a later typo'd --var is therefore the L10 error, never the
  // confusing "variables are frozen" rejection.
  const typo = next(root, run, ['--var', 'PP_TYPO=x', '--resume']);
  expect(typo.status).toBe(1);
  expect(typo.json.reason).toContain('PP_TYPO');
  expect(typo.json.reason).toContain('not declared');
});

test('vars: a __proto__ line in a --vars-file is a malformed-line error, never silently dropped', () => {
  const root = scaffoldVars();
  const vf = join(root, 'proto.env');
  writeFileSync(vf, '__proto__=x\nPP_SERVICE=payments\n');
  const r = spawnSync(
    process.execPath,
    [CLI, 'next', '--root', root, '--run-id', 'varproto', '--vars-file', vf],
    { encoding: 'utf8', cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root } },
  );
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('line 1');
  expect(existsSync(join(root, '.runtime'))).toBe(false);
});

test('vars: F10 legacy state (predates variables) — --var IS accepted and the one-time init writes back', () => {
  // The run starts on a pipeline WITHOUT declarations (old CLI ≙ no key)…
  const root = scaffoldSequential(2);
  const run = 'varlegacy';
  const plan = computePlan(root);
  expect(next(root, run, []).json.action).toBe('run-step');
  expect('variables' in readState(root, run)).toBe(false);

  // …then the pipeline gains declarations + occurrences MID-RUN.
  writeFileSync(
    join(root, 'PIPELINE.md'),
    '# P\n\n## End State\nx\n\n## Variables\n- PP_SERVICE (required) — svc\n',
  );
  writeFileSync(join(root, 'steps', '02-step.md'), '# step 02\n\nUse ${PP_SERVICE}.\n');

  // A loop call WITHOUT --var (and no env value) F2-halts — but leaves the
  // state untouched so the retry loses nothing.
  const record = JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  const halted = next(root, run, ['--record', record]);
  expect(halted.status).toBe(1);
  expect(halted.json.reason).toContain('PP_SERVICE');
  expect('variables' in readState(root, run)).toBe(false);

  // The SAME call with --var performs the one-time resolve + write-back and
  // consumes the record normally (D11-REVISED: --var is legal here). The
  // pipeline now declares variables, so the dispatched agent step is RENDERED
  // (a5): source_path keeps the plan path, path points into the run's
  // rendered shadow tree.
  const ok = next(root, run, ['--var', 'PP_SERVICE=payments', '--record', record]);
  expect(ok.json.action).toBe('run-step');
  expect(ok.json.steps[0].source_path).toBe(plan.steps[1].path);
  expect(ok.json.steps[0].path).toBe(
    join(root, '.runtime', run, 'rendered', basename(root), 'steps', '02-step.md'),
  );
  expect(readFileSync(ok.json.steps[0].path, 'utf8')).toContain('Use payments.');
  expect(readState(root, run).variables).toEqual({ PP_SERVICE: 'payments' });
});

test('vars: F2 halt before ANY action — aggregated listing with declaration line, every occurrence, per-kind remedy', () => {
  const root = scaffoldVars();
  // Make PP_OPT ALSO missing-hard: a bare occurrence with no inline default.
  writeFileSync(join(root, 'steps', '02-b.md'), '# b\n\nAnnounce ${PP_SERVICE}.\nOpt is ${PP_OPT}.\n');
  const run = 'varf2';
  const r = next(root, run, []);
  expect(r.status).toBe(1);
  expect(r.json.action).toBe('halt');
  const reason: string = r.json.reason;

  // Aggregated (never first-error-only): BOTH unresolved variables listed.
  expect(reason).toContain('Unresolved pipeline variables:');
  expect(reason).toContain('PP_SERVICE (required) — service under release');
  expect(reason).toContain('PP_OPT');

  // Declaration line + file (09 quality bar).
  expect(reason).toContain('PIPELINE.md:7'); // - PP_SERVICE …
  expect(reason).toContain('PIPELINE.md:9'); // - PP_OPT …

  // EVERY occurrence, file:line.
  expect(reason).toContain('steps/01-a.md:3'); // ${PP_SERVICE} (and ${PP_OPT:-none})
  expect(reason).toContain('steps/02-b.md:3'); // ${PP_SERVICE}
  expect(reason).toContain('steps/02-b.md:4'); // bare ${PP_OPT}

  // Per-kind remedies: required offers --var/env ONLY (a manifest/inline
  // default never satisfies `required`, D1.2)…
  const serviceBlock = reason.slice(reason.indexOf('PP_SERVICE (required)'), reason.indexOf('  PP_OPT'));
  expect(serviceBlock).toContain('--var PP_SERVICE=');
  expect(serviceBlock).toContain('PP_SERVICE environment variable');
  expect(serviceBlock.toLowerCase()).not.toContain('default');
  // …optional-missing additionally offers the default channels.
  const optBlock = reason.slice(reason.indexOf('  PP_OPT'));
  expect(optBlock).toContain('--var PP_OPT=');
  expect(optBlock).toContain('(default: ...)');
  expect(optBlock).toContain('${PP_OPT:-value}');
  expect(optBlock).toContain('occurrences without an inline default: steps/02-b.md:4');

  // Halt BEFORE the first action: no run state was created at all.
  expect(existsSync(join(root, '.runtime', run, 'next.json'))).toBe(false);
});

test('vars: L10 — a typo of --var is an error, never silently dropped', () => {
  const root = scaffoldVars();
  const run = 'vartypo';
  const r = next(root, run, ['--var', 'PP_SERVICE=payments', '--var', 'PP_SERVISE=oops']);
  expect(r.status).toBe(1);
  expect(r.json.action).toBe('halt');
  expect(r.json.reason).toContain('PP_SERVISE');
  expect(r.json.reason).toContain('not declared in PIPELINE.md ## Variables');
  expect(existsSync(join(root, '.runtime', run, 'next.json'))).toBe(false);
});

test('vars: L10/T11 — --vars-file with non-PP_/undeclared entries is REJECTED and never echoes values', () => {
  const root = scaffoldVars();
  const run = 'varsfilereject';
  const vf = join(root, 'project.env');
  // A project .env pointed at by mistake: one legit entry, one undeclared PP_
  // name, one non-PP_ secret-looking entry.
  writeFileSync(vf, 'PP_SERVICE=payments\nPP_UNDECLARED=x\nDATABASE_URL=postgres://user:hunter2@db/prod\n');
  const r = next(root, run, ['--vars-file', vf]);
  expect(r.status).toBe(1);
  expect(r.json.action).toBe('halt');
  expect(r.json.reason).toContain('PP_UNDECLARED');
  expect(r.json.reason).toContain('DATABASE_URL');
  expect(r.json.reason).toContain('PP_[A-Z0-9_]+');
  // The VALUE (a credential-bearing URL) must never appear in the error.
  expect(JSON.stringify(r.json)).not.toContain('hunter2');
  expect(existsSync(join(root, '.runtime', run, 'next.json'))).toBe(false);
});

test('vars: --vars-file unreadable/malformed → startup usage error naming the offending line (number only)', () => {
  const root = scaffoldVars();
  // Unreadable: exit 2, nothing created.
  const missing = spawnSync(
    process.execPath,
    [CLI, 'next', '--root', root, '--run-id', 'vfmiss', '--vars-file', join(root, 'nope.env')],
    { encoding: 'utf8', cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root } },
  );
  expect(missing.status).toBe(2);
  expect(missing.stderr).toContain('could not be read');

  // Malformed: names the LINE NUMBER, never the content (it could be a secret).
  const vf = join(root, 'bad.env');
  writeFileSync(vf, 'PP_SERVICE=ok\nsuper-secret-blob-no-equals\n');
  const bad = spawnSync(
    process.execPath,
    [CLI, 'next', '--root', root, '--run-id', 'vfbad', '--vars-file', vf],
    { encoding: 'utf8', cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root } },
  );
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('line 2');
  expect(bad.stderr).not.toContain('super-secret-blob-no-equals');
  expect(existsSync(join(root, '.runtime'))).toBe(false);
});

test('vars: --var beats --vars-file for the same name (D2 merge order)', () => {
  const root = scaffoldVars();
  const run = 'varmerge';
  const vf = join(root, 'vars.env');
  writeFileSync(vf, 'PP_SERVICE=from-file\nPP_OPT=file-opt\n');
  const r = next(root, run, ['--vars-file', vf, '--var', 'PP_SERVICE=from-flag']);
  expect(r.json.action).toBe('run-step');
  expect(readState(root, run).variables).toEqual({ PP_SERVICE: 'from-flag', PP_MODE: 'fast', PP_OPT: 'file-opt' });
});

test('vars: a malformed --var value is a LOUD exit-2 usage error', () => {
  const root = scaffoldVars();
  const r = spawnSync(
    process.execPath,
    [CLI, 'next', '--root', root, '--run-id', 'varmal', '--var', 'PP_SERVICE'],
    { encoding: 'utf8', cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root } },
  );
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('--var expects NAME=value');
});

test('vars: old-reader tolerance (08 rollback) — unknown next.json keys are ignored AND preserved by the loader', () => {
  // Proxy for "an older CLI ignores the unknown `variables` key": this CLI's
  // own state loader is a plain JSON.parse with no schema validation — any
  // unknown key (like `variables` is to a pre-P2 CLI, or a future key to this
  // one) neither crashes the run nor is stripped on re-save. There is NO
  // state-format marker in next.json to bump — "do not downgrade mid-run"
  // goes into the release notes instead (a6).
  const root = scaffoldVars();
  const run = 'varoldreader';
  const plan = computePlan(root);
  expect(next(root, run, ['--var', 'PP_SERVICE=payments']).json.action).toBe('run-step');
  const stateFile = join(root, '.runtime', run, 'next.json');
  const st = JSON.parse(readFileSync(stateFile, 'utf8'));
  st.__future_key = { from: 'a newer CLI' };
  writeFileSync(stateFile, JSON.stringify(st, null, 2) + '\n', 'utf8');

  const r = next(root, run, ['--record', JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path })]);
  expect(r.json.action).toBe('run-step');
  const after = readState(root, run);
  expect(after.__future_key).toEqual({ from: 'a newer CLI' });
  expect(after.variables).toEqual({ PP_SERVICE: 'payments', PP_MODE: 'fast' });
});

test('vars: 07 P2 source gate — the engine and run-vars libs never read process.env; commands/next.ts injects it exactly once', () => {
  // Comments may DOCUMENT the discipline ("never reads process.env") — the
  // gate checks CODE, so strip line + block comments before scanning.
  const code = (rel: string) =>
    readFileSync(join(import.meta.dir, '..', 'src', rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  expect(code('lib/substitution.ts')).not.toContain('process.env');
  expect(code('lib/run-vars.ts')).not.toContain('process.env');
  // The single injected read (D9): exactly one initRunVariables call site in
  // the next command, receiving process.env as the injected env parameter.
  const nextSrc = code('commands/next.ts');
  const calls = nextSrc.match(/initRunVariables\(/g) ?? [];
  expect(calls.length).toBe(1);
  expect(nextSrc).toContain('initRunVariables(plan.variables, a.cliVars ?? {}, process.env');
});
