// g1 — the gate-step execution invariant: a plan-enumerated `type: gate` step
// never executes as anything but the deterministic gate, on ANY resolution path.
//
//   bun test tests/gate-path-identity.test.ts
//
// WHY THIS FILE EXISTS SEPARATELY FROM gate.test.ts
// ------------------------------------------------
// `gate.test.ts` covers the gate contract end to end — but every one of its
// drive cases passes `--start <ABSOLUTE path of a real v1 step file>`. Under
// that shape `findStepByPath` matches trivially, so the whole suite was green
// while production was broken.
//
// A dispatched runner does not use that shape. It resolves the entry iteration
// as a PIPELINE-ROOT-RELATIVE, forward-slashed path — `steps/<rel>`, from
// `pipeline plan --json`'s `steps[0].rel` (pipeline-runner
// `jobs/workspace.ts` cliStartIterationResolver) — and then spawns the CLI with
// `cwd` set to the CHECKOUT root, not the pipeline root (`jobs/executor.ts`
// `cwd: workspace.dir`), passing `--root <pipelineRoot> --start steps/<rel>`
// (`jobs/drive.ts` buildDriveArgs `case 'start'`).
//
// Those two facts together are the defect: `samePath` resolves a relative
// `--start` against `process.cwd()`, which under a dispatched run is the
// checkout root and NOT the pipeline root, so a root-relative `--start` can
// never equal an absolute plan path. Every dispatched run therefore missed
// `findStepByPath` and fell into `synthesizeStep`, which hard-pins
// `type:'agent'` / `gate_spec:null`.
//
// For an AGENT step that miss is invisible (the synthetic step keeps the same
// filename stem and the body still resolves), which is exactly why it survived
// so long. For a GATE it is a security defect: the gate's identity is erased
// before the deterministic-gate arms can see it, a real executor session spawns
// in its place, and no `approval` marker ever reaches the wire — so the
// server-side role check is never consulted at all (07 §P0 e2e, D4-1; prod run
// cad229a1…). The same erasure on the answer re-entry is D4-3.
//
// These tests reproduce the runner's argv EXACTLY. They are the regression
// fence for the invariant, so they must keep using the relative form: rewriting
// any `--start` here into an absolute path silently restores the green-suite
// blindness this file was written to remove.

import { test, expect, afterEach, describe } from 'bun:test';
import { runDrive, type ExecutorRunner } from '../src/commands/drive';
import { invokeNext } from '../src/commands/next';
import { computePlan } from '../src/lib/plan';
import type { GitRunner } from '../src/lib/git';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
}, 30000);

// --- scaffolding -------------------------------------------------------------

interface World {
  /** The consumer project root — a dispatched runner's CHECKOUT dir, and the
   *  cwd the CLI is spawned with. */
  project: string;
  /** The pipeline root at `<project>/.pipeline/demo` — what `--root` names. */
  root: string;
  steps: string;
}

/** A v2-manifest world. The gate's plan path is SYNTHETIC (`steps/<name>.md`,
 *  `manifest-plan.ts` dispatchPath) — no such file exists on disk, which is the
 *  structural difference from every v1 fixture in gate.test.ts. */
function mkWorld(manifestYaml: string): World {
  const project = mkdtempSync(join(tmpdir(), 'gate-path-'));
  created.push(project);
  spawnSync('git', ['init', '-q'], { cwd: project });
  const root = join(project, '.pipeline', 'demo');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(root, 'pipeline.yml'), manifestYaml.trim() + '\n');
  return { project, root, steps };
}

function agentBody(name: string): string {
  return `# ${name}\n\nDo the ${name} work.\n`;
}

/** The runner's own start-iteration resolution, reproduced against the real
 *  plan: `steps/${plan.steps[0].rel}`, forward-slashed and root-RELATIVE
 *  (pipeline-runner `cliStartIterationResolver`). */
function runnerStartIteration(root: string): string {
  const plan = computePlan(root);
  expect(plan.errors).toEqual([]);
  return `steps/${plan.steps[0].rel}`;
}

async function inSandbox<T>(w: World, fn: () => T | Promise<T>): Promise<T> {
  const prevCwd = process.cwd();
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['HOME', 'USERPROFILE', 'PIPELINE_RUN_ID', 'PIPELINE_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'PIPELINE_STATS_RUNNER'];
  for (const k of envKeys) savedEnv[k] = process.env[k];
  // The dispatched-runner shape: cwd is the CHECKOUT root, never the pipeline
  // root. Every relative-path resolution in this file depends on that.
  process.chdir(w.project);
  process.env.HOME = w.project;
  process.env.USERPROFILE = w.project;
  delete process.env.PIPELINE_RUN_ID;
  delete process.env.PIPELINE_PARENT_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** In-process runDrive with a recording fake executor. `calls` is the security
 *  assertion: a gate that reaches the executor seam at all has already lost. */
async function drive(w: World, runId: string, args: string[], records: Record<string, unknown>) {
  const calls: string[] = [];
  const executor: ExecutorRunner = async (req) => {
    calls.push(req.step_id);
    const rec = records[req.step_id];
    if (rec === undefined) return { code: 7 };
    writeFileSync(req.record_file, JSON.stringify(rec), 'utf8');
    return { code: 0 };
  };
  const git: GitRunner = () => ({ code: 1, stdout: '', stderr: 'git disabled in this test' });
  let outBuf = '';
  let errBuf = '';
  const code = await inSandbox(w, () =>
    runDrive(['--root', w.root, '--run-id', runId, '--json', ...args], {
      executor,
      git,
      out: (s) => (outBuf += s),
      err: (s) => (errBuf += s),
    }),
  );
  let json: any = null;
  try {
    json = JSON.parse(outBuf);
  } catch {
    /* error paths have empty stdout */
  }
  return { code, json, stderr: errBuf, calls };
}

/** The run's journalled events — the wire the cloud actually consumes. */
function journal(w: World): any[] {
  const file = join(w.project, '.pipeline', '.runtime', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as any);
}

const APPROVE = '{"decision":"approve","comment":null}';

// A gate as the FIRST step — D4-1's exact production shape.
const GATE_FIRST = `
schema: 2
name: demo
steps:
  - name: approve-deploy
    type: gate
    required_role: admin
    message: Deploy to production?
  - name: ship
    body: steps/02-ship.md
`;

// A gate MID-plan — reached through advance()'s manifest hop rather than
// through --start, so it exercises a different route to the same invariant.
const GATE_MID = `
schema: 2
name: demo
steps:
  - name: build
    body: steps/01-build.md
  - name: approve-deploy
    type: gate
    required_role: owner
    message: Ship it?
  - name: ship
    body: steps/03-ship.md
`;

const DONE = { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' };

// ============================================================================
// Repro A (D4-1, security): a gate as the FIRST step, started the way the
// runner starts one, must park as the deterministic gate — never spawn.
// ============================================================================

describe('repro A — D4-1: gate as first step, runner-shaped path start', () => {
  test('parks as the deterministic gate: no executor spawn, exit 4, approval marker on the wire', async () => {
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    const start = runnerStartIteration(w.root);
    // The runner's literal argv value — root-relative, forward slashes.
    expect(start).toBe('steps/approve-deploy.md');

    const r = await drive(w, 'reproA', ['--start', start], { ship: DONE });

    // THE security assertion: the executor seam never fired. A gate that
    // spawns an agent has bypassed approval entirely.
    expect(r.calls).toEqual([]);
    expect(r.code).toBe(4);
    expect(r.json.status).toBe('awaiting-input');
    expect(r.json.step_id).toBe('approve-deploy');
    expect(r.json.session_id).toBe(null); // no claude session behind a gate
    // The approval marker the control plane keys on — without it the run is an
    // ordinary needs-input and the server-side role check is never consulted.
    expect(r.json.question.approval).toEqual({ required_role: 'admin' });
    expect(r.json.question.text).toBe('Deploy to production?');
    expect(r.json.question_id).toBe('gate:reproA:approve-deploy');

    // The journalled park carries the DETERMINISTIC gate question id (not a
    // per-session uuid) and the gate's approval marker.
    const parks = journal(w).filter((e) => e.type === 'awaiting_input');
    expect(parks.length).toBe(1);
    expect(parks[0].data.question_id).toBe('gate:reproA:approve-deploy');
    expect(parks[0].data.question.approval).toEqual({ required_role: 'admin' });
    expect(parks[0].data.step_name).toBe('approve-deploy');
    expect(parks[0].session_id).toBe(null);

    // The dispatch itself was tagged as a gate — the cloud's step_type signal.
    const started = journal(w).filter((e) => e.type === 'iteration.started');
    expect(started.length).toBe(1);
    expect(started[0].data.step_type).toBe('gate');
    expect(started[0].data.step_name).toBe('approve-deploy');
  }, 30000);

  test('the parked engine state keeps the gate identity — cursor by name, no session file', async () => {
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    const start = runnerStartIteration(w.root);
    await drive(w, 'reproAstate', ['--start', start], { ship: DONE });

    const state = JSON.parse(readFileSync(join(w.root, '.runtime', 'reproAstate', 'next.json'), 'utf8'));
    expect(state.phase).toBe('await-step');
    expect(state.current_step_id).toBe('approve-deploy');
    // The cursor must NOT have been recorded as an off-plan path: doing so is
    // precisely how the identity is lost again on the answer re-entry.
    expect(state.current_off_plan_path ?? null).toBe(null);
    expect(existsSync(join(w.root, '.runtime', 'reproAstate', 'sessions', 'approve-deploy.json'))).toBe(false);
  }, 30000);
});

// ============================================================================
// Repro B (D4-3): the approval delivered exactly as the runner delivers it
// must consume as a gate-answer and ADVANCE the run.
// ============================================================================

describe('repro B — D4-3: approval re-entry at the parked iteration_path', () => {
  test('approve consumes as a gate-answer and the NEXT step dispatches', async () => {
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    const start = runnerStartIteration(w.root);
    const run = 'reproB';

    const parked = await drive(w, run, ['--start', start], { ship: DONE });
    expect(parked.code).toBe(4);
    expect(parked.calls).toEqual([]);

    // The runner answers at the park JSON's `iteration_path`, verbatim
    // (pipeline-runner `jobs/executor.ts:954` → buildDriveArgs `case 'answer'`).
    const iterationPath: string = parked.json.iteration_path;
    const answered = await drive(w, run, ['--resume', '--start', iterationPath, '--answer', APPROVE], { ship: DONE });

    expect(answered.code).toBe(0);
    expect(answered.json.status).toBe('completed');
    // The gate itself still never spawned; only the agent step after it ran.
    expect(answered.calls).toEqual(['ship']);

    // D4-3's literal symptom: an `iteration.started` for the step AFTER the
    // gate is what the cloud's resumeFromAwaiting waits for. Without it the run
    // stays `needs-approval` forever (2 prod runs did).
    //
    // The gate appears TWICE by design, and that is the sequence the cloud
    // needs: the answer re-entry re-dispatches the parked gate (`resumed: true`
    // — this is what un-parks the run server-side, the same shape the agent
    // needs-input path uses), and only then does `ship` start.
    const started = journal(w).filter((e) => e.type === 'iteration.started');
    expect(started.map((e) => e.data.step_name)).toEqual(['approve-deploy', 'approve-deploy', 'ship']);
    expect(started[0].data.step_type).toBe('gate');
    expect(started[1].data.step_type).toBe('gate');
    expect(started[1].data.resumed).toBe(true);
    // The advance itself: a dispatch for the step after the gate exists at all.
    expect(started[2].data.step_type).toBeUndefined(); // an agent step carries no step_type tag
  }, 30000);

  test('approve on a LAST-position gate completes the run', async () => {
    const w = mkWorld(`
schema: 2
name: demo
steps:
  - name: approve-deploy
    type: gate
    required_role: admin
    message: Ship it?
`);
    const start = runnerStartIteration(w.root);
    const run = 'reproBlast';
    const parked = await drive(w, run, ['--start', start], {});
    expect(parked.code).toBe(4);

    const answered = await drive(w, run, ['--resume', '--start', parked.json.iteration_path, '--answer', APPROVE], {});
    expect(answered.code).toBe(0);
    expect(answered.json.status).toBe('completed');
    expect(answered.calls).toEqual([]);
  }, 30000);

  test('reject at the same re-entry HALTS — it is never an approval, and never a spawn', async () => {
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    const start = runnerStartIteration(w.root);
    const run = 'reproBrej';
    const parked = await drive(w, run, ['--start', start], { ship: DONE });
    expect(parked.code).toBe(4);

    const r = await drive(
      w,
      run,
      ['--resume', '--start', parked.json.iteration_path, '--answer', '{"decision":"reject","comment":"no"}'],
      { ship: DONE },
    );
    expect(r.code).toBe(1);
    expect(r.json.status).toBe('halted');
    expect(r.json.reason).toContain("approval gate 'approve-deploy' rejected: no");
    expect(r.calls).toEqual([]);
  }, 30000);

  test('an unparseable answer at the same re-entry HALTS — never treated as approval', async () => {
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    const start = runnerStartIteration(w.root);
    const run = 'reproBbad';
    const parked = await drive(w, run, ['--start', start], { ship: DONE });
    const r = await drive(w, run, ['--resume', '--start', parked.json.iteration_path, '--answer', 'lgtm ship it'], {
      ship: DONE,
    });
    expect(r.code).toBe(1);
    expect(r.json.status).toBe('halted');
    expect(r.json.reason).toContain('never treated as approval');
    expect(r.calls).toEqual([]);
  }, 30000);

  test('a re-entry with NO answer re-parks on the same deterministic question — still no spawn', async () => {
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    const start = runnerStartIteration(w.root);
    const run = 'reproBrepark';
    const parked = await drive(w, run, ['--start', start], { ship: DONE });
    const again = await drive(w, run, ['--resume', '--start', parked.json.iteration_path], { ship: DONE });
    expect(again.code).toBe(4);
    expect(again.calls).toEqual([]);
    expect(again.json.question_id).toBe('gate:reproBrepark:approve-deploy');
    expect(again.json.question.approval).toEqual({ required_role: 'admin' });
  }, 30000);
});

// ============================================================================
// Additional coverage the spec names: mid-plan gate, NAME strictness, and the
// off-plan hand-off whose v1 synthesis must survive.
// ============================================================================

describe('every other route to a gate', () => {
  test('a MID-plan gate reached through the manifest hop stays deterministic', async () => {
    const w = mkWorld(GATE_MID);
    writeFileSync(join(w.steps, '01-build.md'), agentBody('build'));
    writeFileSync(join(w.steps, '03-ship.md'), agentBody('ship'));
    const start = runnerStartIteration(w.root);
    expect(start).toBe('steps/01-build.md'); // single body ⇒ the file itself
    const run = 'midgate';

    const parked = await drive(w, run, ['--start', start], {
      build: { kind: 'step', outcome: 'completed', next_iteration: null },
      ship: DONE,
    });
    expect(parked.code).toBe(4);
    expect(parked.json.step_id).toBe('approve-deploy');
    expect(parked.json.question.approval).toEqual({ required_role: 'owner' });
    expect(parked.calls).toEqual(['build']); // the gate did not spawn

    const answered = await drive(w, run, ['--resume', '--start', parked.json.iteration_path, '--answer', APPROVE], {
      build: { kind: 'step', outcome: 'completed', next_iteration: null },
      ship: DONE,
    });
    expect(answered.code).toBe(0);
    expect(answered.json.status).toBe('completed');
    expect(answered.calls).toEqual(['ship']);
  }, 30000);

  test('--start by NAME resolves the gate, and an unknown NAME stays strict (no synthesis)', async () => {
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));

    // By name: the gate, deterministically.
    const byName = await drive(w, 'namegate', ['--start', 'approve-deploy'], { ship: DONE });
    expect(byName.code).toBe(4);
    expect(byName.json.step_id).toBe('approve-deploy');
    expect(byName.json.question.approval).toEqual({ required_role: 'admin' });
    expect(byName.calls).toEqual([]);

    // A name that matches nothing must HALT, not invent a step out of a typo.
    const typo = await drive(w, 'nametypo', ['--start', 'approve-deploi'], { ship: DONE });
    expect(typo.code).not.toBe(0);
    expect(typo.calls).toEqual([]);
  }, 30000);

  test('a genuinely off-plan path still synthesizes an agent step (v1 hand-off preserved)', async () => {
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    // A hub/target hand-off into ANOTHER pipeline's file — enumerated nowhere
    // in this plan, and sharing no name with any step in it.
    const other = join(w.project, '.pipeline', 'other', 'steps');
    mkdirSync(other, { recursive: true });
    const handoff = join(other, '01-handoff.md');
    writeFileSync(handoff, agentBody('handoff'));

    const r = await drive(w, 'offplan', ['--start', handoff], {
      '01-handoff': { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' },
    });
    expect(r.code).toBe(0);
    // It DID execute as an agent — that is the behaviour being preserved.
    expect(r.calls).toEqual(['01-handoff']);
  }, 30000);

  test('a gate that declares its own `body:` still resolves on the runner path form', async () => {
    // Nothing in manifest.ts forbids `body:` on a gate, and one body makes the
    // dispatch path the FILE rather than the synthetic `steps/<name>.md` — so
    // the runner's `--start` carries a name that no longer matches the step's.
    const w = mkWorld(`
schema: 2
name: demo
steps:
  - name: approve-deploy
    type: gate
    required_role: admin
    message: Deploy?
    body: steps/approve-body.md
  - name: ship
    body: steps/02-ship.md
`);
    writeFileSync(join(w.steps, 'approve-body.md'), agentBody('approve'));
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    const start = runnerStartIteration(w.root);
    expect(start).toBe('steps/approve-body.md'); // the FILE, not the step name

    const r = await drive(w, 'gatebody', ['--start', start], { ship: DONE });
    expect(r.calls).toEqual([]);
    expect(r.code).toBe(4);
    expect(r.json.step_id).toBe('approve-deploy');
    expect(r.json.question.approval).toEqual({ required_role: 'admin' });
  }, 30000);

  test('the manager-mode `next` dispatch of a gate is annotated, not spawned, on the path form', async () => {
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    const start = runnerStartIteration(w.root);
    await inSandbox(w, () => {
      const r = invokeNext({ root: w.root, runId: 'nextgate', start, record: null });
      expect(r.action.action).toBe('run-step');
      if (r.action.action !== 'run-step') throw 0;
      expect(r.action.steps[0].type).toBe('gate');
      expect(r.action.steps[0].step_id).toBe('approve-deploy');
      expect((r.out.gate_question as any).approval).toEqual({ required_role: 'admin' });
    });
  }, 30000);
});

// ============================================================================
// The FAIL-CLOSED BACKSTOP itself.
//
// Anchored resolution is what makes the legitimate case work; these cases are
// the ones resolution genuinely CANNOT resolve. The requirement is not that
// they succeed — it is that they never execute. Each one halts loudly.
// ============================================================================

describe('fail-closed backstop: synthesis over an enumerated non-agent step', () => {
  /** An unresolvable path whose identity nonetheless names an enumerated step:
   *  the right basename, in a directory the plan knows nothing about. */
  function strayPathFor(w: World, basename: string): string {
    const stray = join(w.project, 'stray');
    mkdirSync(stray, { recursive: true });
    const p = join(stray, basename);
    writeFileSync(p, agentBody('stray'));
    return p;
  }

  test('a stray path carrying a GATE identity halts — it never spawns', async () => {
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    const stray = strayPathFor(w, 'approve-deploy.md');

    const r = await drive(w, 'backstopgate', ['--start', stray], { ship: DONE, 'approve-deploy': DONE });
    expect(r.calls).toEqual([]); // THE assertion: no agent session behind a gate
    expect(r.code).not.toBe(0);
    expect(r.json.reason).toContain('refusing to execute');
    expect(r.json.reason).toContain('`type: gate`');
    expect(r.json.reason).toContain('--start approve-deploy');
  }, 30000);

  test('a stray path carrying a SCRIPT identity halts too — the guard is not gate-only', async () => {
    const w = mkWorld(`
schema: 2
name: demo
steps:
  - name: build
    type: script
    script: scripts/build.sh
  - name: ship
    body: steps/02-ship.md
`);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    mkdirSync(join(w.root, 'scripts'), { recursive: true });
    writeFileSync(join(w.root, 'scripts', 'build.sh'), '#!/bin/sh\nexit 0\n');
    const stray = strayPathFor(w, 'build.md');

    const r = await drive(w, 'backstopscript', ['--start', stray], { ship: DONE, build: DONE });
    expect(r.calls).toEqual([]);
    expect(r.code).not.toBe(0);
    expect(r.json.reason).toContain('refusing to execute');
    expect(r.json.reason).toContain('`type: script`');
  }, 30000);

  test('a persisted OFF-PLAN CURSOR pointing at a gate identity halts on resume', async () => {
    // The resume route (`current_off_plan_path`), reached by hand because a
    // fixed engine no longer writes such a cursor for a gate — but a state file
    // persisted by a PRE-FIX build carries exactly this, and re-entering it
    // must not spawn.
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    const run = 'backstopcursor';
    const parked = await drive(w, run, ['--start', runnerStartIteration(w.root)], { ship: DONE });
    expect(parked.code).toBe(4);

    const stateFile = join(w.root, '.runtime', run, 'next.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    // The pre-fix shape: cursor by a stem that is not a plan name, plus the
    // off-plan path the old engine would have re-synthesized from.
    state.current_step_id = 'approve-deploy-stale';
    state.current_off_plan_path = join(w.project, 'stray', 'approve-deploy.md');
    writeFileSync(stateFile, JSON.stringify(state), 'utf8');

    const r = await drive(w, run, ['--resume'], { ship: DONE, 'approve-deploy': DONE });
    expect(r.calls).toEqual([]);
    expect(r.code).not.toBe(0);
    expect(r.json.reason).toContain('refusing to execute');
  }, 30000);

  test('the v1 `## Next` hop cannot hand off into a gate identity either', async () => {
    // v1 advance()'s next_iteration route (lib/next.ts advance()). A step
    // reports a successor PATH; if it names a gate's identity but no plan step,
    // dispatching it would execute the gate as an agent.
    const project = mkdtempSync(join(tmpdir(), 'gate-path-v1-'));
    created.push(project);
    spawnSync('git', ['init', '-q'], { cwd: project });
    const root = join(project, '.pipeline', 'demo');
    const steps = join(root, 'steps');
    mkdirSync(steps, { recursive: true });
    writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
    const stray = join(project, 'stray');
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'approve.md'), agentBody('stray-approve'));
    writeFileSync(
      join(steps, '01-build.md'),
      `---\nstep_id: build\n---\n\n# Build\n\n## Goal\nb\n\n## Next\n${join(stray, 'approve.md')}\n`,
    );
    writeFileSync(
      join(steps, '02-approve.md'),
      '---\ntype: gate\nrequired_role: admin\nstep_id: approve\n---\n\n# Approve\n\n## Message\nok?\n\n## Next\nPipeline complete.\n',
    );
    const w: World = { project, root, steps };

    const r = await drive(w, 'backstopv1', ['--start', join(steps, '01-build.md')], {
      build: { kind: 'step', outcome: 'completed', next_iteration: join(stray, 'approve.md') },
      approve: DONE,
    });
    expect(r.calls).toEqual(['build']); // build ran; the hand-off never did
    expect(r.code).not.toBe(0);
    expect(r.json.reason).toContain('refusing to execute');
    expect(r.json.reason).toContain('`type: gate`');
  }, 30000);

  test("the runner's `steps/` prefix bug on a body OUTSIDE steps/ halts a gate rather than spawning it", async () => {
    // Runner adjudication finding (g1 item 3): `cliStartIterationResolver`
    // returns `steps/${plan.steps[0].rel}` unconditionally, but `rel` is only
    // steps/-relative when the body lives under `steps/` (`manifest-plan.ts`
    // relLabel) — for a body elsewhere it is root-relative, so the runner sends
    // `steps/<root-relative>`, which names nothing in either tree.
    //
    // That is a pre-existing runner defect, NOT part of D4-1/D4-3, and it is
    // why the backstop matches on the body-file basename as well as the stem:
    // on this path a gate is unresolvable by construction, and the run must
    // halt rather than fall through to an agent session.
    const w = mkWorld(`
schema: 2
name: demo
steps:
  - name: approve-deploy
    type: gate
    required_role: admin
    message: Deploy?
    body: prompts/approve.md
  - name: ship
    body: steps/02-ship.md
`);
    mkdirSync(join(w.root, 'prompts'), { recursive: true });
    writeFileSync(join(w.root, 'prompts', 'approve.md'), agentBody('approve'));
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));

    const plan = computePlan(w.root);
    const runnerSends = `steps/${plan.steps[0].rel}`;
    expect(runnerSends).toBe('steps/prompts/approve.md'); // names nothing
    const r = await drive(w, 'prefixbug', ['--start', runnerSends], { ship: DONE, 'approve-deploy': DONE, approve: DONE });
    expect(r.calls).toEqual([]); // fail-closed, not an unapproved agent session
    expect(r.code).not.toBe(0);
    expect(r.json.reason).toContain('refusing to execute');
    expect(r.json.reason).toContain('`type: gate`');
  }, 30000);

  test('a stray path with an AGENT identity is NOT guarded — hand-offs still work', async () => {
    // The narrowing that keeps the backstop from breaking v1: only a step whose
    // TYPE would be erased is guarded.
    const w = mkWorld(GATE_FIRST);
    writeFileSync(join(w.steps, '02-ship.md'), agentBody('ship'));
    const stray = strayPathFor(w, 'ship.md'); // 'ship' IS an enumerated agent step

    const r = await drive(w, 'backstopagent', ['--start', stray], { ship: DONE });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(['ship']);
  }, 30000);
});
