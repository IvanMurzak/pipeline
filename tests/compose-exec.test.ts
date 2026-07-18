// T3-10 — composition EXECUTION: flattened child runs over invokeNext (the
// stack — parent waits), run-tree records (parent_run_id / root_run_id /
// path), runtime param passing (the EXACT script-step resolver) and child
// output capture feeding downstream `${steps.<id>.output.<f>}` bindings.
//
// Style mirrors script-exec-integration.test.ts (the T31 command-layer
// harness): real temp worlds under <project>/.claude/pipeline/<name>, cwd/HOME
// sandboxed per call, and a FakeProcessRunner on invokeNext's scriptRunner
// seam so no process ever spawns — script "executions" are prescribed results
// keyed by PIPELINE_STEP_ID, with the resolved params file captured per call.

import { test, expect, afterEach } from 'bun:test';
import { invokeNext } from '../src/commands/next';
import { dropRecordsDirFor, runDrive, type ExecutorRequest, type ExecutorRunner } from '../src/commands/drive';
import { computePlan } from '../src/lib/plan';
import { computeNext, type NextRecord, type NextState } from '../src/lib/next';
import { childRunIdFor, readRunTree } from '../src/lib/compose-exec';
import type { ProcessRunner } from '../src/lib/script-step';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// World scaffolding — a consumer project holding SIBLING pipelines under
// <project>/.claude/pipeline/ (the layout resolvePipelineRef's parent-dir
// candidate serves), driven with cwd swapped to the project.
// ---------------------------------------------------------------------------

interface PipelineFixture {
  manifest?: string;
  steps: Record<string, string | ((w: ComposeWorld) => string)>;
}

interface ComposeWorld {
  project: string;
  home: string;
  base: string;
  /** name → absolute pipeline root. */
  roots: Record<string, string>;
}

function mkComposeWorld(pipelines: Record<string, PipelineFixture>): ComposeWorld {
  const project = mkTmp('cmpx-proj-');
  const home = mkTmp('cmpx-home-');
  // A real .git dir pins resolveProjectRoot (lib/event.ts) to THIS project so
  // the event journal lands here (the script-exec-integration harness).
  spawnSync('git', ['init', '-q'], { cwd: project });
  const base = join(project, '.claude', 'pipeline');
  const w: ComposeWorld = { project, home, base, roots: {} };
  for (const name of Object.keys(pipelines)) w.roots[name] = join(base, ...name.split('/'));
  for (const [name, p] of Object.entries(pipelines)) {
    const root = w.roots[name];
    mkdirSync(join(root, 'steps'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'PIPELINE.md'), p.manifest ?? '# P\n\n## End State\nx\n');
    writeFileSync(join(root, 'scripts', 'noop.js'), 'console.log(JSON.stringify({ ok: true }));\n');
    for (const [file, content] of Object.entries(p.steps)) {
      writeFileSync(join(root, 'steps', file), typeof content === 'function' ? content(w) : content);
    }
  }
  return w;
}

/** Swap cwd to the project + isolate HOME/USERPROFILE + clear the event
 *  writer's envelope vars (the established harness). */
function inProject<T>(w: ComposeWorld, fn: () => T): T {
  const prevCwd = process.cwd();
  const keys = ['PIPELINE_UI_RUN_ID', 'PIPELINE_UI_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'PIPELINE_UI_DEBUG', 'USERPROFILE', 'HOME'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.chdir(w.project);
    delete process.env.PIPELINE_UI_RUN_ID;
    delete process.env.PIPELINE_UI_PARENT_RUN_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.PIPELINE_UI_DEBUG;
    process.env.USERPROFILE = w.home;
    process.env.HOME = w.home;
    return fn();
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

/** A valid `type: script` iteration doc (all required sections + mechanical
 *  `## Next`). */
function scriptStep(opts: {
  stepId: string;
  params?: unknown;
  output?: unknown;
  next: string;
  dependsOn?: string[];
}): string {
  return [
    '---',
    'type: script',
    'script: scripts/noop.js',
    `step_id: ${opts.stepId}`,
    'timeout: 60',
    ...(opts.dependsOn ? [`depends-on: [${opts.dependsOn.join(', ')}]`] : []),
    '---',
    `# ${opts.stepId}`,
    '## Goal',
    'g',
    '## Success Criteria',
    's',
    ...(opts.params !== undefined ? ['## Params', '', jsonBlock(opts.params), ''] : []),
    ...(opts.output !== undefined ? ['## Output', '', jsonBlock(opts.output), ''] : []),
    '## Steps',
    '1. Run: `bun scripts/noop.js` — deterministic work.',
    '## Next',
    opts.next,
    '',
  ].join('\n');
}

/** A valid `type: pipeline` iteration doc (the T3-09 shape). `next: null`
 *  omits the section (graph/DAG parents). */
function pipelineStep(opts: {
  stepId: string;
  ref: string;
  params?: unknown;
  output?: unknown;
  next?: string | null;
  dependsOn?: string[];
}): string {
  return [
    '---',
    'type: pipeline',
    `pipeline: ${opts.ref}`,
    `step_id: ${opts.stepId}`,
    ...(opts.dependsOn ? [`depends-on: [${opts.dependsOn.join(', ')}]`] : []),
    '---',
    `# ${opts.stepId}`,
    '## Goal',
    'Run the child pipeline.',
    ...(opts.params !== undefined ? ['## Params', '', jsonBlock(opts.params), ''] : []),
    ...(opts.output !== undefined ? ['## Output', '', jsonBlock(opts.output), ''] : []),
    '## Success Criteria',
    '- child run completed',
    ...(opts.next === null ? [] : ['## Next', opts.next ?? 'Pipeline complete.']),
    '',
  ].join('\n');
}

function agentStep(stepId: string, dependsOn?: string[]): string {
  const fm = ['---', `step_id: ${stepId}`, ...(dependsOn ? [`depends-on: [${dependsOn.join(', ')}]`] : []), '---'].join('\n');
  return `${fm}\n# ${stepId}\n## Goal\ng\n## Success Criteria\ns\n`;
}

// ---------------------------------------------------------------------------
// FakeProcessRunner keyed by PIPELINE_STEP_ID, capturing run id + the resolved
// params file content per call (the child-input assertions).
// ---------------------------------------------------------------------------

interface ScriptCall {
  stepId: string;
  runId: string;
  params: Record<string, unknown> | null;
}

function stepKeyedRunner(
  map: Record<string, { stdout: string; code?: number }>,
): { runner: ProcessRunner; calls: ScriptCall[] } {
  const calls: ScriptCall[] = [];
  const runner: ProcessRunner = (_argv, opts) => {
    const stepId = opts.env.PIPELINE_STEP_ID ?? '<unknown>';
    let params: Record<string, unknown> | null = null;
    try {
      params = JSON.parse(readFileSync(opts.env.PIPELINE_STEP_PARAMS_FILE!, 'utf8')) as Record<string, unknown>;
    } catch {
      // no params file — leave null
    }
    calls.push({ stepId, runId: opts.env.PIPELINE_STEP_RUN_ID ?? '<unknown>', params });
    const r = map[stepId];
    if (!r) {
      return {
        code: 1,
        stdout: JSON.stringify({ ok: false, error: { class: 'bug', detail: `no fixture for ${stepId}` } }),
        stderr: '',
        timedOut: false,
      };
    }
    return { code: r.code ?? 0, stdout: r.stdout, stderr: '', timedOut: false };
  };
  return { runner, calls };
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const stateOf = (root: string, runId: string): NextState => readJson(join(root, '.runtime', runId, 'next.json'));

// ---------------------------------------------------------------------------
// 1. Parent with one pipeline step: all-script child runs in ONE call, the
//    child's ## Output feeds the parent's downstream binding, params flow in
//    (parent ancestor output + env), and run-tree records are written.
// ---------------------------------------------------------------------------

test('composition: parent → all-script child → downstream binding, single call to done', () => {
  const w = mkComposeWorld({
    main: {
      steps: {
        '01-prep.md': (x) =>
          scriptStep({ stepId: 'prep', output: { sha: { type: 'string' } }, next: join(x.roots.main, 'steps', '02-deploy.md') }),
        '02-deploy.md': (x) =>
          pipelineStep({
            stepId: 'deploy',
            ref: 'child',
            params: {
              sha: { type: 'string', from: '${steps.prep.output.sha}', required: true },
              tag: { type: 'string', from: '${env.T310_TAG}', required: true },
            },
            output: { url: { type: 'string', required: true } },
            next: join(x.roots.main, 'steps', '03-verify.md'),
          }),
        '03-verify.md': () =>
          scriptStep({
            stepId: 'verify',
            params: { url: { type: 'string', from: '${steps.deploy.output.url}', required: true } },
            next: 'Pipeline complete.',
          }),
      },
    },
    child: {
      steps: {
        '01-build.md': scriptStep({
          stepId: 'build',
          params: { task: { type: 'string', from: '${run.task}', required: true } },
          output: { url: { type: 'string' } },
          next: 'Pipeline complete.',
        }),
      },
    },
  });
  // Lint-clean fixture (both plans).
  expect(computePlan(w.roots.main).errors).toEqual([]);
  expect(computePlan(w.roots.child).errors).toEqual([]);

  const fake = stepKeyedRunner({
    prep: { stdout: JSON.stringify({ ok: true, output: { sha: 'abc123' } }) },
    build: { stdout: JSON.stringify({ ok: true, output: { url: 'https://x/abc123' } }) },
    verify: { stdout: JSON.stringify({ ok: true }) },
  });

  process.env.T310_TAG = 'v9';
  try {
    const res = inProject(w, () => invokeNext({ root: w.roots.main, runId: 'r1', scriptRunner: fake.runner }));
    expect(res.action.action).toBe('done');
    expect(res.code).toBe(0);
  } finally {
    delete process.env.T310_TAG;
  }

  const childRunId = childRunIdFor('r1', 'deploy', 2); // prep=1, deploy=2
  expect(childRunId).toBe('r1-deploy-2');

  // Execution order: parent prep → child build (in the CHILD run) → parent verify.
  expect(fake.calls.map((c) => c.stepId)).toEqual(['prep', 'build', 'verify']);
  expect(fake.calls.map((c) => c.runId)).toEqual(['r1', childRunId, 'r1']);

  // Params INTO the child: the parent step's bindings resolved against the
  // parent's ancestor output + env, delivered via the run-input channel —
  // `${run.task}` in the child's script is the params JSON text.
  const childTask = fake.calls[1].params?.task;
  expect(typeof childTask).toBe('string');
  expect(JSON.parse(childTask as string)).toEqual({ sha: 'abc123', tag: 'v9' });
  expect(readJson(join(w.roots.child, '.runtime', childRunId, 'params.json'))).toEqual({ sha: 'abc123', tag: 'v9' });

  // Output OUT of the child: captured from the child's final step, persisted
  // to the PARENT's outputs store under the pipeline step's id, and consumed
  // by the downstream `${steps.deploy.output.url}` binding.
  expect(readJson(join(w.roots.main, '.runtime', 'r1', 'outputs', 'deploy.json'))).toEqual({ url: 'https://x/abc123' });
  expect(fake.calls[2].params).toEqual({ url: 'https://x/abc123' });

  // Run-tree records, both sides.
  const parentTree = readRunTree(w.roots.main, 'r1')!;
  expect(parentTree.parent_run_id).toBe(null);
  expect(parentTree.root_run_id).toBe('r1');
  expect(parentTree.path).toEqual(['r1']);
  expect(parentTree.depth).toBe(1);
  expect(parentTree.children).toEqual([
    { run_id: childRunId, pipeline_root: w.roots.child, step_id: 'deploy', dispatch_index: 2 },
  ]);
  const childTree = readRunTree(w.roots.child, childRunId)!;
  expect(childTree.parent_run_id).toBe('r1');
  expect(childTree.parent_pipeline_root).toBe(w.roots.main);
  expect(childTree.parent_step_id).toBe('deploy');
  expect(childTree.root_run_id).toBe('r1');
  expect(childTree.path).toEqual(['r1', childRunId]);
  expect(childTree.depth).toBe(2);

  // Both runs parked terminal-completed; the parent's stack link is spent.
  const parentState = stateOf(w.roots.main, 'r1');
  expect(parentState.phase).toBe('terminal');
  expect(parentState.status).toBe('completed');
  expect(parentState.active_child).toBe(null);
  const childState = stateOf(w.roots.child, childRunId);
  expect(childState.phase).toBe('terminal');
  expect(childState.status).toBe('completed');
});

// ---------------------------------------------------------------------------
// 2. Nested composition: parent → child → grandchild, depth-first, with
//    correct run-tree records at every level.
// ---------------------------------------------------------------------------

test('composition: parent → child → grandchild runs depth-first with correct run-tree records', () => {
  const w = mkComposeWorld({
    main: { steps: { '01-go.md': pipelineStep({ stepId: 'go', ref: 'mid' }) } },
    mid: { steps: { '01-go.md': pipelineStep({ stepId: 'go', ref: 'leaf' }) } },
    leaf: {
      steps: {
        '01-a.md': scriptStep({ stepId: 'a', output: { n: { type: 'number' } }, next: 'Pipeline complete.' }),
      },
    },
  });
  expect(computePlan(w.roots.main).errors).toEqual([]);

  const fake = stepKeyedRunner({ a: { stdout: JSON.stringify({ ok: true, output: { n: 1 } }) } });
  const res = inProject(w, () => invokeNext({ root: w.roots.main, runId: 'r2', scriptRunner: fake.runner }));
  expect(res.action.action).toBe('done');

  const midRun = childRunIdFor('r2', 'go', 1); // 'r2-go-1'
  const leafRun = childRunIdFor(midRun, 'go', 1); // 'r2-go-1-go-1'
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].stepId).toBe('a');
  expect(fake.calls[0].runId).toBe(leafRun);

  const rootTree = readRunTree(w.roots.main, 'r2')!;
  expect(rootTree.children.map((c) => c.run_id)).toEqual([midRun]);
  const midTree = readRunTree(w.roots.mid, midRun)!;
  expect(midTree.parent_run_id).toBe('r2');
  expect(midTree.root_run_id).toBe('r2');
  expect(midTree.depth).toBe(2);
  expect(midTree.children.map((c) => c.run_id)).toEqual([leafRun]);
  const leafTree = readRunTree(w.roots.leaf, leafRun)!;
  expect(leafTree.parent_run_id).toBe(midRun);
  expect(leafTree.parent_pipeline_root).toBe(w.roots.mid);
  expect(leafTree.root_run_id).toBe('r2');
  expect(leafTree.path).toEqual(['r2', midRun, leafRun]);
  expect(leafTree.depth).toBe(3);

  // Every run in the tree completed.
  expect(stateOf(w.roots.main, 'r2').status).toBe('completed');
  expect(stateOf(w.roots.mid, midRun).status).toBe('completed');
  expect(stateOf(w.roots.leaf, leafRun).status).toBe('completed');
});

// ---------------------------------------------------------------------------
// 3. Child failure propagates: a halted child pops as a halted parent step
//    whose reason names the child run + the child's own halt reason. (The
//    child's retrospective — gated open by its own failure feedback — is
//    auto-skipped by the router; the feedback file survives on disk.)
// ---------------------------------------------------------------------------

test('composition: child run failure halts the parent with a composed reason; child feedback preserved', () => {
  const w = mkComposeWorld({
    main: { steps: { '01-run.md': pipelineStep({ stepId: 'run', ref: 'childf' }) } },
    childf: { steps: { '01-boom.md': scriptStep({ stepId: 'boom', next: 'Pipeline complete.' }) } },
  });
  const fake = stepKeyedRunner({ boom: { stdout: 'garbage — not JSON', code: 3 } });
  const res = inProject(w, () => invokeNext({ root: w.roots.main, runId: 'r3', scriptRunner: fake.runner }));

  expect(res.action.action).toBe('halt');
  expect(res.code).toBe(1);
  const childRunId = childRunIdFor('r3', 'run', 1);
  if (res.action.action !== 'halt') throw 0;
  expect(res.action.reason).toContain(`pipeline step run: child pipeline run '${childRunId}'`);
  expect(res.action.reason).toContain('halted');
  expect(res.action.reason).toContain('script step boom failed (crash)');

  // Parent AND child parked terminal-halted; the stack link is spent.
  const parentState = stateOf(w.roots.main, 'r3');
  expect(parentState.status).toBe('halted');
  expect(parentState.phase).toBe('terminal');
  expect(parentState.active_child).toBe(null);
  expect(stateOf(w.roots.childf, childRunId).status).toBe('halted');

  // The child's own §6.2 feedback file survives (its retro was auto-skipped,
  // not its evidence).
  const fb = join(w.roots.childf, '.feedback', childRunId);
  expect(existsSync(join(fb, 'boom-01.md'))).toBe(true);
});

// ---------------------------------------------------------------------------
// 4. Manager path: AGENT steps inside the child surface to the caller
//    annotated with the child run (run_id / pipeline_root); records fed to the
//    PARENT run route into the child; the pop feeds the child's record output
//    into the parent's outputs store. A no-record call mid-child auto-resumes
//    INTO the child.
// ---------------------------------------------------------------------------

test('composition: child agent steps surface annotated; records route depth-first; output pops to the parent', () => {
  const w = mkComposeWorld({
    main: {
      steps: {
        '01-pipe.md': pipelineStep({
          stepId: 'pipe',
          ref: 'childa',
          output: { done: { type: 'boolean', required: true } },
        }),
      },
    },
    childa: { steps: { '01-work.md': agentStep('work') } },
  });
  const childRunId = childRunIdFor('r4', 'pipe', 1);

  inProject(w, () => {
    // Init: the pipeline dispatch becomes a child run whose first AGENT step
    // surfaces to the caller, annotated.
    const first = invokeNext({ root: w.roots.main, runId: 'r4' });
    expect(first.action.action).toBe('run-step');
    if (first.action.action !== 'run-step') throw 0;
    expect(first.action.steps[0].step_id).toBe('work');
    expect(first.action.steps[0].path).toBe(join(w.roots.childa, 'steps', '01-work.md'));
    expect(first.action.steps[0].run_id).toBe(childRunId);
    expect(first.action.steps[0].pipeline_root).toBe(w.roots.childa);
    expect(first.out.composed_run_id).toBe(childRunId);
    expect(first.out.composed_pipeline_root).toBe(w.roots.childa);

    // The parent is WAITING: parked await-step on the pipeline step with the
    // persisted stack link.
    const parentState = stateOf(w.roots.main, 'r4');
    expect(parentState.phase).toBe('await-step');
    expect(parentState.current_step_id).toBe('pipe');
    expect(parentState.active_child).toEqual({
      root: w.roots.childa,
      run_id: childRunId,
      step_id: 'pipe',
      step_path: join(w.roots.main, 'steps', '01-pipe.md'),
      dispatch_index: 1,
    });

    // A no-record call (crashed-manager auto-resume) descends into the child
    // and re-emits ITS pending step — still annotated.
    const resumed = invokeNext({ root: w.roots.main, runId: 'r4' });
    if (resumed.action.action !== 'run-step') throw 0;
    expect(resumed.action.steps[0].step_id).toBe('work');
    expect(resumed.action.steps[0].run_id).toBe(childRunId);

    // The step record — sent against the PARENT run — routes into the child,
    // completes it, and the pop resumes the parent to done.
    const done = invokeNext({
      root: w.roots.main,
      runId: 'r4',
      record: {
        kind: 'step',
        outcome: 'completed',
        next_iteration: 'PIPELINE_COMPLETE',
        output: { done: true },
      } as NextRecord,
    });
    expect(done.action.action).toBe('done');
    expect(readJson(join(w.roots.main, '.runtime', 'r4', 'outputs', 'pipe.json'))).toEqual({ done: true });
    expect(stateOf(w.roots.main, 'r4').status).toBe('completed');
    expect(stateOf(w.roots.childa, childRunId).status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// 5. Blocked child: the run parks with the stack INTACT, and a --resume
//    descends back into the child (nested blocker resolution).
// ---------------------------------------------------------------------------

test('composition: a blocked child parks the run; --resume re-enters the child step', () => {
  const w = mkComposeWorld({
    main: { steps: { '01-pipe.md': pipelineStep({ stepId: 'pipe', ref: 'childb' }) } },
    childb: { steps: { '01-work.md': agentStep('work') } },
  });
  const childRunId = childRunIdFor('r5', 'pipe', 1);

  inProject(w, () => {
    const first = invokeNext({ root: w.roots.main, runId: 'r5' });
    expect(first.action.action).toBe('run-step');

    const blocked = invokeNext({
      root: w.roots.main,
      runId: 'r5',
      record: { kind: 'step', outcome: 'blocked-delegating' } as NextRecord,
    });
    expect(blocked.action.action).toBe('blocked');
    // The stack survives the park: parent still waiting on the child.
    expect(stateOf(w.roots.main, 'r5').active_child).not.toBe(null);
    expect(stateOf(w.roots.childb, childRunId).phase).toBe('blocked');

    // Resume routes into the child, which re-dispatches its blocked step.
    const resumed = invokeNext({ root: w.roots.main, runId: 'r5', resume: true });
    if (resumed.action.action !== 'run-step') throw 0;
    expect(resumed.action.steps[0].step_id).toBe('work');
    expect(resumed.action.steps[0].run_id).toBe(childRunId);

    const done = invokeNext({
      root: w.roots.main,
      runId: 'r5',
      record: { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' } as NextRecord,
    });
    expect(done.action.action).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// 6. Output contract: a completed child whose captured output violates the
//    parent step's ## Output declaration fails the pipeline step (contract).
// ---------------------------------------------------------------------------

test('composition: child output violating the parent ## Output declaration halts the parent (contract)', () => {
  const w = mkComposeWorld({
    main: {
      steps: {
        '01-pipe.md': pipelineStep({
          stepId: 'pipe',
          ref: 'childc',
          output: { url: { type: 'string', required: true } },
        }),
      },
    },
    childc: { steps: { '01-work.md': agentStep('work') } },
  });

  inProject(w, () => {
    const first = invokeNext({ root: w.roots.main, runId: 'r6' });
    expect(first.action.action).toBe('run-step');
    // Child completes WITHOUT the required output field.
    const res = invokeNext({
      root: w.roots.main,
      runId: 'r6',
      record: { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' } as NextRecord,
    });
    expect(res.action.action).toBe('halt');
    if (res.action.action !== 'halt') throw 0;
    expect(res.action.reason).toContain('pipeline step pipe failed (contract)');
    expect(res.action.reason).toContain('output violates the ## Output declaration');
    expect(res.action.reason).toContain("missing required output field 'url'");
  });
});

// ---------------------------------------------------------------------------
// 7. Param binding failure: an unresolvable REQUIRED param halts the parent
//    BEFORE any child scaffolding — no child run, no run-tree record.
// ---------------------------------------------------------------------------

test('composition: a pipeline step binding failure halts the parent before the child exists', () => {
  const w = mkComposeWorld({
    main: {
      steps: {
        '01-p.md': pipelineStep({
          stepId: 'p',
          ref: 'childd',
          params: { name: { type: 'string', from: '${env.T310_DEFINITELY_UNSET}', required: true } },
        }),
      },
    },
    childd: { steps: { '01-a.md': agentStep('a') } },
  });
  delete process.env.T310_DEFINITELY_UNSET;

  const res = inProject(w, () => invokeNext({ root: w.roots.main, runId: 'r7' }));
  expect(res.action.action).toBe('halt');
  if (res.action.action !== 'halt') throw 0;
  expect(res.action.reason).toContain('pipeline step p failed (binding)');
  expect(res.action.reason).toContain("required param 'name' has no resolvable value");

  // Nothing was scaffolded: no child run dir, no run-tree on either side.
  expect(existsSync(join(w.roots.childd, '.runtime', childRunIdFor('r7', 'p', 1)))).toBe(false);
  expect(readRunTree(w.roots.main, 'r7')).toBe(null);
  expect(stateOf(w.roots.main, 'r7').status).toBe('halted');
});

// ---------------------------------------------------------------------------
// 8. Parallel layers: a `type: pipeline` member degrades to a LOUD halt
//    (composed child runs are sequential-only in v1) — never an un-actuatable
//    action escaping to the caller.
// ---------------------------------------------------------------------------

test('composition: a pipeline step inside a parallel layer halts loudly (v1 degradation)', () => {
  const w = mkComposeWorld({
    main: {
      manifest: '---\nexecution: parallel\nisolation: manual\n---\n# P\n\n## End State\nx\n',
      steps: {
        '01-setup.md': agentStep('setup'),
        '02-p.md': pipelineStep({ stepId: 'p', ref: 'childd', next: null, dependsOn: ['setup'] }),
      },
    },
    childd: { steps: { '01-a.md': agentStep('a') } },
  });
  expect(computePlan(w.roots.main).errors).toEqual([]);

  inProject(w, () => {
    const first = invokeNext({ root: w.roots.main, runId: 'r8' });
    if (first.action.action !== 'run-step') throw 0;
    expect(first.action.steps.map((s) => s.step_id)).toEqual(['setup']);

    const res = invokeNext({
      root: w.roots.main,
      runId: 'r8',
      record: { kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] } as NextRecord,
    });
    expect(res.action.action).toBe('halt');
    if (res.action.action !== 'halt') throw 0;
    expect(res.action.reason).toContain("type: pipeline step 'p' is not supported inside a parallel layer (v1)");
    // No child run ever started.
    expect(existsSync(join(w.roots.childd, '.runtime'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Engine: active_child is command-owned state the PURE engine carries,
//    normalizes (legacy next.json), and clears atomically with the record
//    consumption (the pending_fallback pattern).
// ---------------------------------------------------------------------------

test('engine: active_child survives a JSON round-trip, normalizes when absent, and is spent by the step record', () => {
  const w = mkComposeWorld({
    main: { steps: { '01-a.md': agentStep('a'), '02-b.md': agentStep('b') } },
  });
  const plan = computePlan(w.roots.main);
  expect(plan.errors).toEqual([]);

  // Init dispatches step a; the command layer would now set the stack link.
  const init = computeNext(plan, null, null, { feedbackCount: 0 });
  expect(init.action.action).toBe('run-step');
  expect(init.state.active_child).toBe(null);
  init.state.active_child = {
    root: '/abs/child',
    run_id: 'run-a-1',
    step_id: 'a',
    step_path: plan.steps[0].path,
    dispatch_index: 1,
  };

  // Persisted round-trip (what saveState/loadState do) keeps the link.
  const loaded = JSON.parse(JSON.stringify(init.state)) as NextState;
  expect(loaded.active_child?.run_id).toBe('run-a-1');

  // The arriving step record (the pop) SPENDS the link in the same engine
  // call that consumes the record — no separate clear step.
  const next = computeNext(plan, loaded, { kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }, { feedbackCount: 0 });
  expect(next.action.action).toBe('run-step');
  expect(next.state.active_child).toBe(null);

  // Legacy state (pre-T3-10 next.json without the key) normalizes to null.
  const legacy = JSON.parse(JSON.stringify(next.state)) as NextState;
  delete (legacy as unknown as Record<string, unknown>).active_child;
  const r = computeNext(plan, legacy, { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }, { feedbackCount: 0 });
  expect(r.state.active_child).toBe(null);
  expect(r.action.action).toBe('done');
});

// ---------------------------------------------------------------------------
// 10. `pipeline drive` end-to-end: the headless runner executes a composed
//     run — the child's agent step spawns with the CHILD's run id, pipeline
//     root, task file (the delivered params) and a child-keyed record file.
// ---------------------------------------------------------------------------

test('drive: composed run completes; child step spawns with child-run context and child-keyed record file', async () => {
  const w = mkComposeWorld({
    main: {
      steps: {
        '01-pipe.md': pipelineStep({
          stepId: 'pipe',
          ref: 'childe',
          params: { note: { type: 'string', value: 'hello' } },
          output: { done: { type: 'boolean', required: true } },
        }),
      },
    },
    childe: { steps: { '01-work.md': agentStep('work') } },
  });
  const childRunId = childRunIdFor('drv1', 'pipe', 1);

  const captured: ExecutorRequest[] = [];
  const executor: ExecutorRunner = async (req) => {
    captured.push(req);
    writeFileSync(
      req.record_file,
      JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE', output: { done: true } }),
      'utf8',
    );
    return { code: 0 };
  };

  let outBuf = '';
  let errBuf = '';
  const code = await inProject(w, () =>
    runDrive(
      ['--root', w.roots.main, '--run-id', 'drv1', '--start', join(w.roots.main, 'steps', '01-pipe.md')],
      { executor, out: (s) => (outBuf += s), err: (s) => (errBuf += s) },
    ),
  );
  expect(code).toBe(0);
  expect(JSON.parse(outBuf).status).toBe('completed');

  // Exactly one executor spawn — the CHILD's agent step, keyed on the child run.
  expect(captured).toHaveLength(1);
  const req = captured[0];
  expect(req.step_id).toBe('work');
  // e7 DEFECT-1: the executor-facing record path is the run's tmp DROP dir
  // (child steps keyed `<child_run>-<step>` exactly like the canonical copy).
  expect(req.record_file).toBe(join(dropRecordsDirFor(resolve(w.roots.main), 'drv1'), `${childRunId}-work.json`));
  // The spawn prompt carries the CHILD's run context: run id, pipeline root,
  // feedback dir, and the delivered params as the run's task file.
  expect(req.prompt).toContain(`run_id = ${childRunId}`);
  expect(req.prompt).toContain(`pipeline_root = ${w.roots.childe}`);
  // The prompt template joins with forward slashes — match its literal form.
  expect(req.prompt).toContain(`${w.roots.childe}/.feedback/${childRunId}`);
  const childParamsFile = join(w.roots.childe, '.runtime', childRunId, 'params.json');
  expect(req.prompt).toContain(`task_file = ${childParamsFile}`);
  expect(readJson(childParamsFile)).toEqual({ note: 'hello' });
  // Drive created the child's feedback dir before the spawn.
  expect(existsSync(join(w.roots.childe, '.feedback', childRunId))).toBe(true);

  // The child's output popped into the parent's outputs store.
  expect(readJson(join(w.roots.main, '.runtime', 'drv1', 'outputs', 'pipe.json'))).toEqual({ done: true });
  expect(stateOf(w.roots.main, 'drv1').status).toBe('completed');
  expect(stateOf(w.roots.childe, childRunId).status).toBe('completed');
});
