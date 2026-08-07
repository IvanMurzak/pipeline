// ux-v2 b4 — step UUID minting: "one step identity, minted at step start,
// referenced by both reporting paths — so the cloud writes one row instead of
// two."
//
// Two layers of proof, per the task's own warning about what's easiest to
// fake:
//
//   1. Pure-engine tests (computeNext driven through a driver(), mirroring
//      next.test.ts/next-script.test.ts's own conventions) pin the MINT vs
//      REUSE boundary precisely: a dispatch that genuinely moves the run
//      forward (fresh spawn, A2 retry, §6.3 fallback, a second independent
//      run of the SAME pipeline) gets a NEW uuid; an idempotent re-emission
//      of a dispatch already in flight (§7 continue, crash re-entry) reuses
//      the SAME one. This is the "re-run vs re-emit" line the task calls out
//      as easy to fake by minting twice in a loop instead of exercising a
//      genuine re-run.
//   2. An in-process end-to-end section (invokeNext — the same entry point
//      `pipeline next`/`pipeline drive` call, exercised WITHOUT spawning a
//      CLI subprocess, which is the flaky part on this box) proves the event
//      stream (events.jsonl) and the stats record (runs.jsonl) reference the
//      SAME uuid for ONE execution, and that a SECOND independent run of the
//      identical step gets a DIFFERENT uuid in BOTH artifacts while step_key
//      stays identical in both.

import { test, expect, afterEach } from 'bun:test';
import { computeNext, type NextState, type NextRecord, type NextAction, type NextOpts } from '../src/lib/next';
import { computePlan, type Plan } from '../src/lib/plan';
import { invokeNext } from '../src/commands/next';
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
});

/** RFC 9562 §5.7 UUIDv7 — version nibble `7`, variant `0b10`. Same shape
 *  `tests/ids.test.ts` pins for `newId()` itself; asserted here to prove the
 *  step identity is a REAL mint, not a placeholder string. */
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Pure-engine scaffolding — mirrors next.test.ts / next-script.test.ts
// ---------------------------------------------------------------------------

function scaffoldSequential(n = 3): string {
  const root = mkdtempSync(join(tmpdir(), 'uuid-seq-'));
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

/** Sequential: 01-build (agent) -> 02-flaky (agent, `retries: N`) -> 03-ship
 *  (agent) — the A2 agent-retry shape from next.test.ts, reused here to prove
 *  a GENUINE re-execution (not a re-emit) mints a new identity. */
function scaffoldAgentRetrySeq(retries: number): string {
  const root = mkdtempSync(join(tmpdir(), 'uuid-retry-seq-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-build.md'), '# build\n');
  writeFileSync(join(steps, '02-flaky.md'), `---\nstep_id: flaky\nretries: ${retries}\n---\n# flaky\n`);
  writeFileSync(join(steps, '03-ship.md'), '# ship\n');
  return root;
}

/** Sequential: 01-build (agent) -> 02-wait (SCRIPT, on-failure: agent) ->
 *  03-ship (agent) — next-script.test.ts's shape, reused for the crash-resume
 *  (script) and §6.3 fallback (agent re-dispatch) boundaries. */
function scriptStepBody(script: string, next: string): string {
  return ['# wait for CI', '## Goal', 'g', '## Success Criteria', 's', '## Steps', '1. x', '## Next', next, ''].join(
    '\n',
  );
}
function scaffoldScriptSeq(onFailure?: 'halt' | 'agent'): string {
  const root = mkdtempSync(join(tmpdir(), 'uuid-script-seq-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-build.md'), '# build\n');
  const front = [
    '---',
    'type: script',
    'script: scripts/wait.py',
    'timeout: 120',
    'step_id: wait',
    ...(onFailure ? [`on-failure: ${onFailure}`] : []),
    '---',
  ].join('\n');
  writeFileSync(join(steps, '02-wait.md'), front + '\n' + scriptStepBody('scripts/wait.py', join(steps, '03-ship.md')));
  writeFileSync(join(steps, '03-ship.md'), '# ship\n');
  return root;
}

/** Parallel fan-out/join: [setup] -> [x, y] -> [z]. */
function scaffoldParallel(): string {
  const root = mkdtempSync(join(tmpdir(), 'uuid-par-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), `---\nexecution: parallel\n---\n# P\n\n## End State\nx\n`);
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-setup.md'), '---\nstep_id: setup\n---\n# setup\n');
  writeFileSync(join(steps, '02-x.md'), '---\nstep_id: x\ndepends-on: [setup]\n---\n# x\n');
  writeFileSync(join(steps, '03-y.md'), '---\nstep_id: y\ndepends-on: [setup]\n---\n# y\n');
  writeFileSync(join(steps, '04-z.md'), '---\nstep_id: z\ndepends-on: [x, y]\n---\n# z\n');
  return root;
}

function driver(plan: Plan, feedbackCount = 0) {
  let state: NextState | null = null;
  return {
    call(record: NextRecord | null, opts: Partial<NextOpts> = {}): NextAction {
      const r = computeNext(plan, state, record, { feedbackCount, ...opts });
      state = r.state;
      return r.action;
    },
    get state() {
      return state;
    },
  };
}

function stepUuidOf(a: NextAction, i = 0): string {
  if (a.action !== 'run-step') throw new Error(`expected run-step, got ${a.action}`);
  return a.steps[i].step_uuid;
}

// ---------------------------------------------------------------------------
// 1. A fresh dispatch mints a real UUIDv7, alongside an UNCHANGED step_key
// ---------------------------------------------------------------------------

test('a fresh dispatch mints a UUIDv7 step_uuid, and step_id (step_key) is present and unchanged', () => {
  const plan = computePlan(scaffoldSequential(2));
  const d = driver(plan);
  const a = d.call(null);
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_uuid).toMatch(UUID_V7_RE);
  // step_key: the analytics dimension — a completely independent field, same
  // value/shape it always had (the filename stem for a plain v1 step).
  expect(a.steps[0].step_id).toBe('01-step');
  expect(a.steps[0].step_uuid).not.toBe(a.steps[0].step_id);
});

test('two DIFFERENT steps in one run get two DIFFERENT uuids', () => {
  const plan = computePlan(scaffoldSequential(2));
  const d = driver(plan);
  const first = d.call(null);
  const firstUuid = stepUuidOf(first);
  const second = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  const secondUuid = stepUuidOf(second);
  expect(secondUuid).toMatch(UUID_V7_RE);
  expect(secondUuid).not.toBe(firstUuid);
});

// ---------------------------------------------------------------------------
// 2. Idempotent RE-EMIT of the SAME pending dispatch reuses the SAME uuid
//    (this is NOT a re-run — nothing executed a second time)
// ---------------------------------------------------------------------------

test('§7 continue: re-emitting the SAME pending dispatch reuses the SAME uuid', () => {
  const plan = computePlan(scaffoldScriptSeq());
  const d = driver(plan);
  d.call(null); // step 1 (agent)
  const dispatched = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }); // 'wait' (script)
  const uuid = stepUuidOf(dispatched);
  expect(uuid).toMatch(UUID_V7_RE);

  const again = d.call({ kind: 'continue' });
  expect(stepUuidOf(again)).toBe(uuid); // SAME dispatch, asked about twice

  const yetAgain = d.call({ kind: 'continue' });
  expect(stepUuidOf(yetAgain)).toBe(uuid); // a chain of continues stays idempotent
});

test('crash re-entry of a pending SCRIPT step (--resume, no record) reuses the SAME uuid', () => {
  const plan = computePlan(scaffoldScriptSeq());
  const d = driver(plan);
  d.call(null);
  const dispatched = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  const uuid = stepUuidOf(dispatched);

  // A fresh process re-enters with --resume and NO record (the driver died
  // before the script produced one) — the SAME pending dispatch comes back.
  const resumed = d.call(null, { resume: true });
  expect(stepUuidOf(resumed)).toBe(uuid);
});

test('§6.3 fallback: the agent re-dispatch is a NEW spawn (new uuid); a crash re-entry of THAT pending fallback reuses it', () => {
  const plan = computePlan(scaffoldScriptSeq('agent'));
  const d = driver(plan);
  d.call(null);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }); // 'wait' (script)

  // The command executed the script in-process; it failed; policy 'agent'
  // re-dispatches the SAME step as an agent fallback — a genuinely NEW spawn.
  const failureRecord = '/proj/.pipeline/demo/.runtime/r1/failures/wait-1.json';
  const fallback = d.call(
    { kind: 'step', outcome: 'halted', halt_reason: 'script step wait failed (crash): boom' },
    { scriptFallback: { failure_record: failureRecord } },
  );
  if (fallback.action !== 'run-step') throw 0;
  expect(fallback.steps[0].step_id).toBe('wait'); // SAME step_key…
  expect(fallback.steps[0].fallback).toBe('script-failure');
  const fallbackUuid = fallback.steps[0].step_uuid;
  expect(fallbackUuid).toMatch(UUID_V7_RE);

  // Now the DRIVER PROCESS itself crashes before the fallback executor
  // produces a record: a fresh process re-enters with --resume and no
  // record. state.pending_fallback is still set — this is a re-emit of the
  // SAME pending dispatch, not a new one, so the uuid must NOT change.
  const resumed = d.call(null, { resume: true });
  if (resumed.action !== 'run-step') throw 0;
  expect(resumed.steps[0].fallback).toBe('script-failure');
  expect(resumed.steps[0].step_uuid).toBe(fallbackUuid);
});

// ---------------------------------------------------------------------------
// 3. A GENUINE re-execution — not a re-emit — mints a NEW uuid
// ---------------------------------------------------------------------------

test('A2 agent retry: a genuinely re-executed attempt of the SAME step gets a NEW uuid', () => {
  const plan = computePlan(scaffoldAgentRetrySeq(1));
  const flaky = plan.steps.find((s) => s.step_id === 'flaky')!;
  const d = driver(plan);
  d.call(null); // step 1
  const firstAttempt = d.call({ kind: 'step', outcome: 'completed', next_iteration: flaky.path }); // index 2
  const firstUuid = stepUuidOf(firstAttempt);
  expect(firstUuid).toMatch(UUID_V7_RE);

  // The attempt HALTS (transient failure) — the budget (1) allows a retry: a
  // FRESH executor spawn, same step_id, own iteration.started.
  const retryAttempt = d.call({ kind: 'step', outcome: 'halted', halt_reason: 'first failure' });
  if (retryAttempt.action !== 'run-step') throw 0;
  expect(retryAttempt.steps[0].step_id).toBe('flaky'); // SAME step_key…
  expect(retryAttempt.steps[0].retry).toBe(1); // …a genuine retry (A2 tag)…
  const retryUuid = stepUuidOf(retryAttempt);
  expect(retryUuid).toMatch(UUID_V7_RE);
  expect(retryUuid).not.toBe(firstUuid); // …but a NEW identity: a distinct execution
});

test('a SECOND, INDEPENDENT run of the identical pipeline mints a NEW uuid for the same step_key (the cross-run "re-run")', () => {
  const root = scaffoldSequential(2);
  const plan = computePlan(root);

  // Two separate run states — exactly what two separate `pipeline next
  // --run-id <id>` invocations would produce. Not "mint twice in a loop": each
  // goes through the real dispatch path (dispatchStep -> mintStepUuid).
  const runA = driver(plan).call(null);
  const runB = driver(plan).call(null);
  const uuidA = stepUuidOf(runA);
  const uuidB = stepUuidOf(runB);

  if (runA.action !== 'run-step' || runB.action !== 'run-step') throw 0;
  expect(runA.steps[0].step_id).toBe(runB.steps[0].step_id); // SAME step_key…
  expect(uuidA).toMatch(UUID_V7_RE);
  expect(uuidB).toMatch(UUID_V7_RE);
  expect(uuidA).not.toBe(uuidB); // …but two DIFFERENT executions, two DIFFERENT uuids
});

// ---------------------------------------------------------------------------
// 4. Parallel layers: one uuid PER MEMBER, reused (not re-minted) on a
//    §7 continue re-emit of the whole in-flight layer
// ---------------------------------------------------------------------------

test('parallel: concurrent layer members each get their OWN uuid, and a continue re-emit reuses them', () => {
  const plan = computePlan(scaffoldParallel());
  const d = driver(plan);
  d.call(null); // [setup]
  const layer = d.call({ kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] }); // -> [x, y]
  if (layer.action !== 'run-step') throw 0;
  expect(layer.concurrent).toBe(true);
  const byId = new Map(layer.steps.map((s) => [s.step_id, s.step_uuid]));
  expect(byId.get('x')).toMatch(UUID_V7_RE);
  expect(byId.get('y')).toMatch(UUID_V7_RE);
  expect(byId.get('x')).not.toBe(byId.get('y')); // two DIFFERENT steps, two DIFFERENT uuids

  const again = d.call({ kind: 'continue' });
  if (again.action !== 'run-step') throw 0;
  const byIdAgain = new Map(again.steps.map((s) => [s.step_id, s.step_uuid]));
  expect(byIdAgain.get('x')).toBe(byId.get('x')); // SAME dispatch, reused
  expect(byIdAgain.get('y')).toBe(byId.get('y'));
});

// ---------------------------------------------------------------------------
// 5. improver:* / script_creator:* actions (the other two client-minted
//    classes — drive.ts's Tier-1 spawns route through this SAME action system)
// ---------------------------------------------------------------------------

test('run-improver and run-script-creator actions each carry their own fresh uuid', () => {
  const plan = computePlan(scaffoldSequential(1));
  const d = driver(plan);
  d.call(null);
  const improver = d.call({
    kind: 'step',
    outcome: 'completed',
    next_iteration: 'PIPELINE_COMPLETE',
    has_improvement_brief: true,
  });
  expect(improver.action).toBe('run-improver');
  if (improver.action !== 'run-improver') throw 0;
  expect(improver.step_uuid).toMatch(UUID_V7_RE);

  // Two script-creation briefs from the same improver pass: each is its OWN
  // spawn and gets its OWN identity, never reusing the improver's.
  const script1 = d.call({ kind: 'improver', applied: true, script_briefs: 2 });
  expect(script1.action).toBe('run-script-creator');
  if (script1.action !== 'run-script-creator') throw 0;
  expect(script1.step_uuid).toMatch(UUID_V7_RE);
  expect(script1.step_uuid).not.toBe(improver.step_uuid);

  const script2 = d.call({ kind: 'script', outcome: 'created', script_path: '/s1.py' });
  expect(script2.action).toBe('run-script-creator');
  if (script2.action !== 'run-script-creator') throw 0;
  expect(script2.step_uuid).toMatch(UUID_V7_RE);
  expect(script2.step_uuid).not.toBe(script1.step_uuid);
});

// ---------------------------------------------------------------------------
// 6. End-to-end, in-process (no CLI subprocess — the flaky part on this box):
//    the event stream AND runs.jsonl agree on ONE uuid for ONE execution, and
//    a second independent run mints a different one while step_key survives.
// ---------------------------------------------------------------------------

interface World {
  project: string;
  home: string;
  root: string;
  steps: string;
}

function mkWorld(): World {
  const project = mkdtempSync(join(tmpdir(), 'uuid-e2e-proj-'));
  created.push(project);
  const home = mkdtempSync(join(tmpdir(), 'uuid-e2e-home-'));
  created.push(home);
  spawnSync('git', ['init', '-q'], { cwd: project });
  const root = join(project, '.pipeline', 'demo');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  writeFileSync(join(steps, '01-implement.md'), '---\nstep_id: implement\n---\n# implement\n');
  writeFileSync(join(steps, '02-ship.md'), '---\nstep_id: ship\n---\n# ship\n');
  return { project, home, root, steps };
}

function inProject<T>(w: World, fn: () => T): T {
  const prevCwd = process.cwd();
  const keys = ['PIPELINE_RUN_ID', 'PIPELINE_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'USERPROFILE', 'HOME'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.chdir(w.project);
    delete process.env.PIPELINE_RUN_ID;
    delete process.env.PIPELINE_PARENT_RUN_ID;
    delete process.env.CLAUDE_SESSION_ID;
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

function readEvents(w: World): any[] {
  const f = join(w.project, '.pipeline', '.runtime', 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
}

function readRunsJsonl(w: World): any[] {
  const f = join(w.project, '.pipeline', '.stats', 'demo', 'runs.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
}

/** Drive ONE run (implement -> ship -> done) to completion via invokeNext —
 *  the SAME entry point `pipeline next`/`pipeline drive` call — in-process. */
function runToCompletion(w: World, runId: string): { implementUuid: string } {
  const first = invokeNext({ root: w.root, runId });
  if (first.action.action !== 'run-step') throw new Error(`expected run-step, got ${first.action.action}`);
  const implementUuid = first.action.steps[0].step_uuid;
  const afterImplement = invokeNext({
    root: w.root,
    runId,
    record: { kind: 'step', outcome: 'completed', next_iteration: join(w.steps, '02-ship.md') },
  });
  if (afterImplement.action.action !== 'run-step') throw new Error(`expected run-step, got ${afterImplement.action.action}`);
  const afterShip = invokeNext({
    root: w.root,
    runId,
    record: { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' },
  });
  if (afterShip.action.action !== 'done') throw new Error(`expected done, got ${afterShip.action.action}`);
  return { implementUuid };
}

test('end-to-end: the event stream and runs.jsonl reference the SAME uuid for the same execution, and step_key rides both unchanged', () => {
  const w = mkWorld();
  inProject(w, () => {
    const runId = 'e2e-run-1';
    const { implementUuid } = runToCompletion(w, runId);
    expect(implementUuid).toMatch(UUID_V7_RE);

    // --- Reporting path 1: the event stream (events.jsonl) -----------------
    const events = readEvents(w);
    const started = events.find((e) => e.type === 'iteration.started' && e.data?.index === 1);
    const completed = events.filter((e) => e.type === 'iteration.completed');
    expect(started).toBeTruthy();
    expect(started.data.step_uuid).toBe(implementUuid);
    // step_key survives, unchanged: every event still labels the iteration by
    // its SOURCE PATH (`02` principle 3), concurrent or not.
    expect(started.data.iteration_path).toBe(join(w.steps, '01-implement.md'));
    // ux-v2 b19: a SEQUENTIAL dispatch's iteration.started now carries
    // step_name too — it used to ride ONLY a concurrent layer (see
    // next-step-name.test.ts for the dedicated coverage of that change and of
    // the concurrent path staying unchanged).
    expect(started.data.step_name).toBe('implement');
    // The FIRST iteration.completed pairs with 'implement' by fold order.
    expect(completed[0].data.step_uuid).toBe(implementUuid);
    expect(completed[0].data.iteration_path).toBe(join(w.steps, '01-implement.md'));

    // --- Reporting path 2: the stats record (runs.jsonl) --------------------
    const runs = readRunsJsonl(w);
    const rec = runs.find((r) => r.run_id === runId);
    expect(rec).toBeTruthy();
    const implementStat = rec.steps.find((s: any) => s.id === 'implement');
    expect(implementStat).toBeTruthy();
    // step_key ('id') unchanged in shape and value — the filename stem, same
    // as every runs.jsonl line before this task.
    expect(implementStat.id).toBe('implement');
    // The SAME uuid the event stream carried — one identity, two reporters.
    expect(implementStat.step_uuid).toBe(implementUuid);
  });
});

test('end-to-end: a SECOND run of the identical pipeline mints a DIFFERENT uuid in BOTH events.jsonl and runs.jsonl, while step_key (id/iteration_path) is identical to the first run', () => {
  const w = mkWorld();
  inProject(w, () => {
    const { implementUuid: uuid1 } = runToCompletion(w, 'e2e-run-a');
    const { implementUuid: uuid2 } = runToCompletion(w, 'e2e-run-b');
    expect(uuid1).toMatch(UUID_V7_RE);
    expect(uuid2).toMatch(UUID_V7_RE);
    expect(uuid1).not.toBe(uuid2); // a genuine re-run — a new identity each time

    const events = readEvents(w);
    const run1Started = events.find((e) => e.run_id === 'e2e-run-a' && e.type === 'iteration.started' && e.data?.index === 1);
    const run2Started = events.find((e) => e.run_id === 'e2e-run-b' && e.type === 'iteration.started' && e.data?.index === 1);
    expect(run1Started.data.step_uuid).toBe(uuid1);
    expect(run2Started.data.step_uuid).toBe(uuid2);
    // step_key (here, iteration_path — the source label the events use for a
    // sequential dispatch) is IDENTICAL across the two runs: same step, two
    // executions.
    expect(run1Started.data.iteration_path).toBe(run2Started.data.iteration_path);

    const runs = readRunsJsonl(w);
    const stat1 = runs.find((r) => r.run_id === 'e2e-run-a').steps.find((s: any) => s.id === 'implement');
    const stat2 = runs.find((r) => r.run_id === 'e2e-run-b').steps.find((s: any) => s.id === 'implement');
    expect(stat1.step_uuid).toBe(uuid1);
    expect(stat2.step_uuid).toBe(uuid2);
    expect(stat1.step_uuid).not.toBe(stat2.step_uuid);
    expect(stat1.id).toBe(stat2.id); // step_key unchanged across the "re-run"
  });
});
