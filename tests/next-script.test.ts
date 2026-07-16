// T21 — pure-engine tests for `type: script` step support in lib/next.ts:
// step-type threading on actions, the §7 `continue` record (idempotent
// re-dispatch), the §6.3/§6.4 agent-fallback re-dispatch + once-per-run bound,
// §9 partial-layer folding, and backward-compat normalization of the new
// NextState fields. Execution/budget/feedback are the command layer's job
// (T31) — nothing here touches a process or the run filesystem.
import { test, expect, afterEach } from 'bun:test';
import { computeNext, type NextState, type NextRecord, type NextAction, type NextOpts } from '../src/lib/next';
import { computePlan, type Plan } from '../src/lib/plan';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

// --- scaffolding -----------------------------------------------------------

/** A minimal VALID script-step body: required sections + the mechanical
 *  `## Next` line (one absolute path or 'Pipeline complete.'). */
function scriptStepBody(script: string, next: string): string {
  return [
    '# wait for CI',
    '## Goal',
    'Wait until CI is green.',
    '## Success Criteria',
    'All checks passed.',
    '## Steps',
    `1. Run: \`python ${script}\` — waits for CI.`,
    '## Next',
    next,
    '',
  ].join('\n');
}

/** Sequential: 01-build (agent) → 02-wait (SCRIPT, step_id 'wait') → 03-ship
 *  (agent). `model` sets the pipeline default; `onFailure` the script policy. */
function scaffoldScriptSeq(opts: { onFailure?: 'halt' | 'agent'; model?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'next-scr-seq-'));
  created.push(root);
  const fm = opts.model ? `---\nmodel: ${opts.model}\n---\n` : '';
  writeFileSync(join(root, 'PIPELINE.md'), `${fm}# P\n\n## End State\nx\n`);
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-build.md'), '# build\n');
  const front = [
    '---',
    'type: script',
    'script: scripts/wait.py',
    'timeout: 120',
    'step_id: wait',
    ...(opts.onFailure ? [`on-failure: ${opts.onFailure}`] : []),
    '---',
  ].join('\n');
  writeFileSync(join(steps, '02-wait.md'), front + '\n' + scriptStepBody('scripts/wait.py', join(steps, '03-ship.md')));
  writeFileSync(join(steps, '03-ship.md'), '# ship\n');
  return root;
}

/** Graph mode: implement (agent) → check (SCRIPT) → package (agent), with a
 *  bounded needs_fix loop back to implement. Graph mode skips the `## Next`
 *  mechanical lint — routing runs off the script's flags. */
const SCRIPT_GRAPH = {
  implement: { goto: 'check' },
  check: [
    { when: 'needs_fix', goto: 'implement', max: 2 },
    { goto: 'package' },
  ],
};

function scaffoldScriptGraph(): string {
  const root = mkdtempSync(join(tmpdir(), 'next-scr-graph-'));
  created.push(root);
  writeFileSync(
    join(root, 'PIPELINE.md'),
    `# P\n\n## End State\nx\n\n## Graph\n\n\`\`\`json\n${JSON.stringify(SCRIPT_GRAPH)}\n\`\`\`\n`,
  );
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-implement.md'), '---\nstep_id: implement\n---\n# implement\n');
  writeFileSync(
    join(steps, '02-check.md'),
    '---\ntype: script\nscript: scripts/check.py\ntimeout: 60\nstep_id: check\n---\n# check\n## Goal\nCheck CI.\n## Success Criteria\nKnown state.\n',
  );
  writeFileSync(join(steps, '03-package.md'), '---\nstep_id: package\n---\n# package\n');
  return root;
}

/** Parallel DAG: [setup] → [x, y] → [z]. `x` is ALWAYS a script; `y` is a
 *  script too when allScript is set (the all-script-layer case). */
function scaffoldScriptParallel(
  isolation: 'worktree' | 'manual',
  opts: { allScript?: boolean } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'next-scr-par-'));
  created.push(root);
  const iso = isolation === 'manual' ? '\nisolation: manual' : '';
  writeFileSync(join(root, 'PIPELINE.md'), `---\nexecution: parallel${iso}\n---\n# P\n\n## End State\nx\n`);
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-setup.md'), '---\nstep_id: setup\n---\n# setup\n');
  writeFileSync(
    join(steps, '02-x.md'),
    '---\ntype: script\nscript: scripts/x.py\ntimeout: 60\nstep_id: x\ndepends-on: [setup]\n---\n# x\n## Goal\ng\n## Success Criteria\ns\n',
  );
  writeFileSync(
    join(steps, '03-y.md'),
    opts.allScript
      ? '---\ntype: script\nscript: scripts/y.py\ntimeout: 60\nstep_id: y\ndepends-on: [setup]\n---\n# y\n## Goal\ng\n## Success Criteria\ns\n'
      : '---\nstep_id: y\ndepends-on: [setup]\n---\n# y\n',
  );
  writeFileSync(join(steps, '04-z.md'), '---\nstep_id: z\ndepends-on: [x, y]\n---\n# z\n');
  return root;
}

/** In-memory driver mirroring next.test.ts, with full NextOpts injection per
 *  call (scriptFallback etc.) and a state setter for legacy-state surgery. */
function driver(plan: Plan, feedbackCount = 0, baseOpts: Partial<NextOpts> = {}) {
  let state: NextState | null = null;
  return {
    call(record: NextRecord | null, opts: Partial<NextOpts> = {}): NextAction {
      const r = computeNext(plan, state, record, { feedbackCount, ...baseOpts, ...opts });
      state = r.state;
      return r.action;
    },
    get state() {
      return state;
    },
    set state(s: NextState | null) {
      state = s;
    },
  };
}

/** JSON round-trip — what saveState/loadState do to the persisted next.json. */
function roundTrip(state: NextState | null): NextState {
  return JSON.parse(JSON.stringify(state)) as NextState;
}

// --- step-type threading (task step 1) ---------------------------------------

test('sequential: run-step actions carry the step type threaded from the plan', () => {
  const plan = computePlan(scaffoldScriptSeq());
  expect(plan.errors).toEqual([]);
  expect(plan.steps.map((s) => s.type)).toEqual(['agent', 'script', 'agent']);
  const d = driver(plan);

  let a = d.call(null);
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].type).toBe('agent');
  expect(a.steps[0].index).toBe(1);

  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('wait');
  expect(a.steps[0].type).toBe('script');
  expect(a.steps[0].index).toBe(2);
  // §2.1: model/effort are meaningless on a script step — resolved to null,
  // never the pipeline default.
  expect(a.steps[0].model).toBe(null);
  expect(a.steps[0].effort).toBe(null);

  // The script's SYNTHESIZED record (command layer, §5.1) — carries the
  // additive `output` field, which the engine accepts and ignores.
  a = d.call({
    kind: 'step',
    outcome: 'completed',
    flags: { ci_green: true },
    next_iteration: plan.steps[2].path,
    output: { checks_passed: 14 },
  });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].type).toBe('agent');
  expect(a.steps[0].index).toBe(3);
});

test('sequential: a synthesized off-plan step defaults to type agent', () => {
  const plan = computePlan(scaffoldScriptSeq());
  const d = driver(plan);
  d.call(null);
  const off = '/somewhere/.claude/pipeline/demo/steps/99-extra.md';
  const a = d.call({ kind: 'step', outcome: 'completed', next_iteration: off });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].path).toBe(off);
  expect(a.steps[0].type).toBe('agent');
});

test('parallel: layer members carry their own types (mixed script/agent layer)', () => {
  const plan = computePlan(scaffoldScriptParallel('worktree'));
  expect(plan.errors).toEqual([]);
  expect(plan.layers).toEqual([['setup'], ['x', 'y'], ['z']]);
  const d = driver(plan);
  d.call(null); // [setup]
  const a = d.call({ kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] });
  if (a.action !== 'run-step') throw 0;
  expect(a.concurrent).toBe(true);
  const byId = new Map(a.steps.map((s) => [s.step_id, s]));
  expect(byId.get('x')?.type).toBe('script');
  expect(byId.get('y')?.type).toBe('agent');
});

// --- continue (task step 2) ---------------------------------------------------

test('continue: re-emits the SAME pending dispatch idempotently (index, ids, counters intact)', () => {
  const plan = computePlan(scaffoldScriptSeq());
  const d = driver(plan);
  d.call(null); // step 1 (agent, index 1)
  let a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('wait');
  expect(a.steps[0].index).toBe(2);

  // The command parked this dispatch (budget) and the caller re-enters in a
  // fresh call window. The FULL persisted state must be untouched by the
  // re-emit — same phase, same index, same cursor.
  const snapshot = JSON.stringify(roundTrip(d.state));
  a = d.call({ kind: 'continue' });
  if (a.action !== 'run-step') throw 0;
  expect(a.concurrent).toBe(false);
  expect(a.steps[0].step_id).toBe('wait');
  expect(a.steps[0].path).toBe(plan.steps[1].path);
  expect(a.steps[0].type).toBe('script');
  expect(a.steps[0].index).toBe(2); // SAME dispatch index — the §8 ledger key half
  expect(JSON.stringify(roundTrip(d.state))).toBe(snapshot);

  // A chain of continues (multiple exhausted windows) stays idempotent.
  a = d.call({ kind: 'continue' });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].index).toBe(2);
  expect(JSON.stringify(roundTrip(d.state))).toBe(snapshot);

  // The eventually-recorded step advances normally with a FRESH index.
  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[2].path });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('03-ship');
  expect(a.steps[0].index).toBe(3);
});

test('continue: graph mode — route counters intact across the re-emit', () => {
  const plan = computePlan(scaffoldScriptGraph());
  expect(plan.errors).toEqual([]);
  const d = driver(plan);
  d.call(null, { start: plan.steps[0].path }); // implement
  // one needs_fix loop-back consumes 1 of max 2
  let a = d.call({ kind: 'step', outcome: 'completed', flags: {} }); // → check
  a = d.call({ kind: 'step', outcome: 'completed', flags: { needs_fix: true } }); // → implement (1)
  a = d.call({ kind: 'step', outcome: 'completed', flags: {} }); // → check again
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('check');
  const idx = a.steps[0].index;
  const routeBefore = JSON.stringify(d.state!.route);

  a = d.call({ kind: 'continue' });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('check');
  expect(a.steps[0].type).toBe('script');
  expect(a.steps[0].index).toBe(idx); // unchanged
  expect(JSON.stringify(d.state!.route)).toBe(routeBefore); // loop budget NOT consumed

  // The loop budget still has exactly 1 left: needs_fix loops once more…
  a = d.call({ kind: 'step', outcome: 'completed', flags: { needs_fix: true } });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('implement'); // (2)
  a = d.call({ kind: 'step', outcome: 'completed', flags: {} }); // → check
  // …then the spent budget falls through to package.
  a = d.call({ kind: 'step', outcome: 'completed', flags: { needs_fix: true } });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('package');
});

test('continue: parallel mode — re-emits the in-flight layer with the ORIGINAL per-member indices', () => {
  const plan = computePlan(scaffoldScriptParallel('worktree'));
  const d = driver(plan);
  d.call(null); // [setup] (index 1)
  let a = d.call({ kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] }); // → [x, y]
  if (a.action !== 'run-step') throw 0;
  const original = a.steps.map((s) => ({ id: s.step_id, index: s.index, iso: s.isolation, type: s.type }));
  expect(original.map((s) => s.index)).toEqual([2, 3]);

  a = d.call({ kind: 'continue' });
  if (a.action !== 'run-step') throw 0;
  expect(a.concurrent).toBe(true);
  expect(a.steps.map((s) => ({ id: s.step_id, index: s.index, iso: s.isolation, type: s.type }))).toEqual(original);
  expect(d.state!.index).toBe(3); // counter untouched
});

test('continue: in any phase other than await-step it is a wrong-record halt', () => {
  const plan = computePlan(scaffoldScriptSeq());
  const d = driver(plan);
  d.call(null);
  let a = d.call({
    kind: 'step',
    outcome: 'completed',
    next_iteration: plan.steps[1].path,
    has_improvement_brief: true,
  });
  expect(a.action).toBe('run-improver'); // now phase await-improver
  a = d.call({ kind: 'continue' });
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.reason).toContain('await-improver');
  expect(a.reason).toContain('continue');
});

// --- agent fallback (task step 3) ---------------------------------------------

test('fallback: halt-shaped record + opts.scriptFallback re-dispatches the SAME step as agent', () => {
  const plan = computePlan(scaffoldScriptSeq({ onFailure: 'agent', model: 'sonnet' }));
  expect(plan.errors).toEqual([]);
  expect(plan.default_model).toBeTruthy();
  const d = driver(plan);
  d.call(null); // step 1
  let a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('wait');
  expect(a.steps[0].type).toBe('script');
  expect(a.steps[0].index).toBe(2);

  // The command executed the script in-process; it failed (class crash),
  // policy is 'agent' → it calls back with the halt-shaped record + the opt.
  const failureRecord = '/proj/.claude/pipeline/demo/.runtime/r1/failures/wait-1.json';
  a = d.call(
    { kind: 'step', outcome: 'halted', halt_reason: 'script step wait failed (crash): boom' },
    { scriptFallback: { failure_record: failureRecord } },
  );
  if (a.action !== 'run-step') throw 0;
  const s = a.steps[0];
  expect(s.step_id).toBe('wait'); // the SAME step…
  expect(s.path).toBe(plan.steps[1].path);
  expect(s.type).toBe('agent'); // …as an AGENT dispatch
  expect(s.fallback).toBe('script-failure');
  expect(s.failure_record).toBe(failureRecord);
  expect(s.index).toBe(3); // a FRESH dispatch index (new spawn)
  // An agent spawn resolves the run default model (the script step's own
  // model is null by §2.1 — meaningless on scripts).
  expect(s.model).toBe(plan.default_model);
  expect(s.isolation).toBe(null);
  // The once-per-run §6.4 bound is consumed.
  expect(d.state!.fallback_attempted).toEqual({ wait: true });

  // The fallback executor achieves the Goal and returns a NORMAL record —
  // the chain advances exactly as if the script had succeeded.
  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[2].path });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('03-ship');
  expect(a.steps[0].index).toBe(4);
});

test('fallback: once per step per run — the second failure halts (bound survives a state round-trip)', () => {
  const plan = computePlan(scaffoldScriptSeq({ onFailure: 'agent' }));
  const d = driver(plan);
  d.call(null);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }); // script 'wait'
  let a = d.call(
    { kind: 'step', outcome: 'halted', halt_reason: 'script step wait failed (bug): first' },
    { scriptFallback: { failure_record: '/f/wait-1.json' } },
  );
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].fallback).toBe('script-failure');

  // Fallback completes, and the chain LOOPS BACK to the script step (a
  // designer-authored revisit) — a new dispatch of the same step_id.
  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('wait');
  expect(a.steps[0].type).toBe('script');

  // Persistence round-trip: the consumed bound must survive save/load.
  d.state = roundTrip(d.state);
  expect(d.state!.fallback_attempted).toEqual({ wait: true });

  // Second script failure of the same step: the opt is INERT — the halt-shaped
  // record is processed normally (§6.4 "normal halt path").
  a = d.call(
    { kind: 'step', outcome: 'halted', halt_reason: 'script step wait failed (bug): second' },
    { scriptFallback: { failure_record: '/f/wait-2.json' } },
  );
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.reason).toBe('script step wait failed (bug): second');
  expect(d.state!.phase).toBe('terminal');
});

test('fallback: parallel mode degrades to halt (§6.4 v1) — the opt is inert on a layer record', () => {
  const plan = computePlan(scaffoldScriptParallel('manual'));
  const d = driver(plan);
  d.call(null); // [setup]
  d.call({ kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] }); // → [x, y]
  const a = d.call(
    {
      kind: 'layer',
      results: [
        { step_id: 'x', outcome: 'halted', halt_reason: 'script step x failed (bug): nope' },
        { step_id: 'y', outcome: 'completed' },
      ],
    },
    { scriptFallback: { failure_record: '/f/x-1.json' } },
  );
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.reason).toBe('script step x failed (bug): nope');
  expect(d.state!.fallback_attempted).toEqual({}); // never consumed in parallel
});

test('fallback: crash-resume re-emits the PENDING agent fallback (same index + failure_record), never a script dispatch', () => {
  const plan = computePlan(scaffoldScriptSeq({ onFailure: 'agent', model: 'sonnet' }));
  const d = driver(plan);
  d.call(null); // step 1 (index 1)
  d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }); // script 'wait' (index 2)
  const failureRecord = '/proj/.claude/pipeline/demo/.runtime/r1/failures/wait-1.json';
  let a = d.call(
    { kind: 'step', outcome: 'halted', halt_reason: 'script step wait failed (crash): boom' },
    { scriptFallback: { failure_record: failureRecord } },
  );
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].fallback).toBe('script-failure'); // fallback dispatched (index 3)
  expect(a.steps[0].index).toBe(3);
  expect(d.state!.pending_fallback).toEqual({ failure_record: failureRecord });

  // The manager crashes BEFORE the fallback executor reports. The supervisor
  // re-spawns; the command layer synthesizes resume=true on the no-record
  // re-entry off the RELOADED persisted state. The re-emit must be the AGENT
  // fallback — re-emitting a script dispatch would re-execute the already-
  // failed side-effectful script and halt (the §6.4 bound is consumed).
  d.state = roundTrip(d.state);
  a = d.call(null, { resume: true });
  if (a.action !== 'run-step') throw 0;
  const s = a.steps[0];
  expect(s.step_id).toBe('wait');
  expect(s.path).toBe(plan.steps[1].path);
  expect(s.type).toBe('agent'); // the FALLBACK again — NOT a script dispatch
  expect(s.fallback).toBe('script-failure');
  expect(s.failure_record).toBe(failureRecord);
  expect(s.index).toBe(3); // SAME pending dispatch — no bump
  expect(s.model).toBe(plan.default_model); // resolved exactly like dispatchFallback

  // The marker survives the re-emit — a SECOND crash re-emits again…
  d.state = roundTrip(d.state);
  a = d.call(null, { resume: true });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].fallback).toBe('script-failure');
  expect(a.steps[0].index).toBe(3);
  expect(d.state!.pending_fallback).toEqual({ failure_record: failureRecord });

  // …and is SPENT when the fallback's record finally lands; the chain advances.
  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[2].path });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('03-ship');
  expect(a.steps[0].index).toBe(4);
  expect(d.state!.pending_fallback).toBe(null);
});

test('fallback: a §7 continue while the fallback is pending re-emits the FALLBACK idempotently', () => {
  const plan = computePlan(scaffoldScriptSeq({ onFailure: 'agent' }));
  const d = driver(plan);
  d.call(null);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  let a = d.call(
    { kind: 'step', outcome: 'halted', halt_reason: 'script step wait failed (bug): x' },
    { scriptFallback: { failure_record: '/f/wait-1.json' } },
  );
  if (a.action !== 'run-step') throw 0;
  const idx = a.steps[0].index;
  const snapshot = JSON.stringify(roundTrip(d.state));
  // Defense-in-depth: the command only parks SCRIPT executions on the budget,
  // but if a continue ever arrives here, "the same pending dispatch" is the
  // fallback — never a fresh script dispatch off the plan type.
  a = d.call({ kind: 'continue' });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].type).toBe('agent');
  expect(a.steps[0].fallback).toBe('script-failure');
  expect(a.steps[0].failure_record).toBe('/f/wait-1.json');
  expect(a.steps[0].index).toBe(idx);
  expect(JSON.stringify(roundTrip(d.state))).toBe(snapshot); // fully idempotent
});

test('fallback: after a COMPLETED fallback, a loop-back to the script step + crash-resume re-emits a SCRIPT dispatch (marker spent)', () => {
  const plan = computePlan(scaffoldScriptSeq({ onFailure: 'agent' }));
  const d = driver(plan);
  d.call(null);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }); // script (index 2)
  let a = d.call(
    { kind: 'step', outcome: 'halted', halt_reason: 'script step wait failed (bug): first' },
    { scriptFallback: { failure_record: '/f/wait-1.json' } },
  );
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].fallback).toBe('script-failure'); // index 3

  // Fallback completes; the chain LOOPS BACK to the same script step (a
  // designer-authored revisit) — a fresh SCRIPT dispatch spends the marker.
  a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('wait');
  expect(a.steps[0].type).toBe('script');
  expect(a.steps[0].fallback).toBeUndefined();
  const scriptIdx = a.steps[0].index;
  expect(d.state!.pending_fallback).toBe(null);

  // Crash HERE: the §8 re-emit must be the SCRIPT dispatch at the SAME index
  // (ledger reuse) — the earlier consumed fallback must NOT leak into it.
  d.state = roundTrip(d.state);
  a = d.call(null, { resume: true });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].type).toBe('script');
  expect(a.steps[0].fallback).toBeUndefined();
  expect(a.steps[0].failure_record).toBeUndefined();
  expect(a.steps[0].index).toBe(scriptIdx);
});

// --- partial layers (task step 5) ----------------------------------------------

test('partial layer (mixed): parked script results fold with the recorded agent results, then clear', () => {
  const plan = computePlan(scaffoldScriptParallel('manual'));
  const d = driver(plan);
  d.call(null);
  d.call({ kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] }); // → [x, y]
  // The command executed script member x in-process and parked its result;
  // the caller only saw (and now records) agent member y.
  d.state!.partial_layer_results = [{ step_id: 'x', outcome: 'completed' }];
  const a = d.call({ kind: 'layer', results: [{ step_id: 'y', outcome: 'completed' }] });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps.map((s) => s.step_id)).toEqual(['z']); // the layer folded complete → advanced
  expect(d.state!.partial_layer_results).toBe(null); // pen cleared
});

test('partial layer (worktree): script members run IN-PLACE — merge only collects agent branches', () => {
  const plan = computePlan(scaffoldScriptParallel('worktree'));
  const d = driver(plan);
  d.call(null);
  let a = d.call({
    kind: 'layer',
    results: [{ step_id: 'setup', outcome: 'completed', worktree_branch: 'wt-setup', worktree_path: '/wt/setup' }],
  });
  if (a.action === 'merge') a = d.call({ kind: 'merge', conflict: false });
  if (a.action !== 'run-step') throw 0; // [x, y]
  // Script member x ran in-place (§9: no worktree, no merge entry).
  d.state!.partial_layer_results = [{ step_id: 'x', outcome: 'completed' }];
  a = d.call({
    kind: 'layer',
    results: [{ step_id: 'y', outcome: 'completed', worktree_branch: 'wt-y', worktree_path: '/wt/y' }],
  });
  expect(a.action).toBe('merge');
  if (a.action !== 'merge') throw 0;
  expect(a.branches.map((b) => b.branch)).toEqual(['wt-y']); // only the agent member
  expect(d.state!.partial_layer_results).toBe(null);
  a = d.call({ kind: 'merge', conflict: false });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps.map((s) => s.step_id)).toEqual(['z']);
});

test('partial layer (all-script): the command self-feeds a complete layer — empty recorded results fold fine', () => {
  const plan = computePlan(scaffoldScriptParallel('manual', { allScript: true }));
  expect(plan.errors).toEqual([]);
  const d = driver(plan);
  d.call(null);
  const layerAction = d.call({ kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] });
  if (layerAction.action !== 'run-step') throw 0;
  expect(layerAction.steps.every((s) => s.type === 'script')).toBe(true);
  // Both members executed in-process; the command records the layer itself
  // with everything parked and nothing from the caller.
  d.state!.partial_layer_results = [
    { step_id: 'x', outcome: 'completed' },
    { step_id: 'y', outcome: 'completed' },
  ];
  const a = d.call({ kind: 'layer', results: [] });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps.map((s) => s.step_id)).toEqual(['z']);
  expect(d.state!.partial_layer_results).toBe(null);
});

test('partial layer: a parked HALTED script member halts the folded layer', () => {
  const plan = computePlan(scaffoldScriptParallel('manual'));
  const d = driver(plan);
  d.call(null);
  d.call({ kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] }); // → [x, y]
  d.state!.partial_layer_results = [
    { step_id: 'x', outcome: 'halted', halt_reason: 'script step x failed (env): python missing' },
  ];
  const a = d.call({ kind: 'layer', results: [{ step_id: 'y', outcome: 'completed' }] });
  expect(a.action).toBe('halt');
  if (a.action !== 'halt') throw 0;
  expect(a.reason).toContain('python missing');
  expect(d.state!.partial_layer_results).toBe(null); // cleared on the halt path too
});

// --- backward compat (task step 4) ----------------------------------------------

test('backward compat: a legacy next.json WITHOUT the new keys loads, normalizes, and advances', () => {
  const plan = computePlan(scaffoldScriptSeq());
  const d = driver(plan);
  d.call(null); // step 1 in flight
  // Simulate a pre-script-steps state file: strip all three new keys.
  const legacy = roundTrip(d.state);
  delete (legacy as Partial<NextState>).fallback_attempted;
  delete (legacy as Partial<NextState>).repaired_steps;
  delete (legacy as Partial<NextState>).partial_layer_results;
  d.state = legacy;

  const a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('wait');
  // Normalized defaults (the lint_warnings pattern): absent ⇒ {} / [] / null.
  expect(d.state!.fallback_attempted).toEqual({});
  expect(d.state!.repaired_steps).toEqual([]);
  expect(d.state!.partial_layer_results).toBe(null);
});

test('backward compat: a legacy state (no new keys) still handles a continue record', () => {
  const plan = computePlan(scaffoldScriptSeq());
  const d = driver(plan);
  d.call(null);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }); // script pending, index 2
  const legacy = roundTrip(d.state);
  delete (legacy as Partial<NextState>).fallback_attempted;
  delete (legacy as Partial<NextState>).repaired_steps;
  delete (legacy as Partial<NextState>).partial_layer_results;
  d.state = legacy;
  const a = d.call({ kind: 'continue' });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('wait');
  expect(a.steps[0].index).toBe(2);
});

test('backward compat: a legacy state WITHOUT pending_fallback loads, normalizes to null, and the §8 script re-emit still works', () => {
  const plan = computePlan(scaffoldScriptSeq());
  const d = driver(plan);
  d.call(null);
  d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }); // script pending (index 2)
  const legacy = roundTrip(d.state);
  delete (legacy as Partial<NextState>).pending_fallback;
  d.state = legacy;
  // No-record crash-resume of a pending SCRIPT dispatch: unchanged behavior.
  const a = d.call(null, { resume: true });
  if (a.action !== 'run-step') throw 0;
  expect(a.steps[0].step_id).toBe('wait');
  expect(a.steps[0].type).toBe('script');
  expect(a.steps[0].fallback).toBeUndefined();
  expect(a.steps[0].index).toBe(2);
  expect(d.state!.pending_fallback).toBe(null); // normalized
});

test('script-creator records: the repaired/converted outcome vocabulary advances await-script like created', () => {
  const plan = computePlan(scaffoldScriptSeq());
  const d = driver(plan);
  d.call(null); // step 1
  let a = d.call({
    kind: 'step',
    outcome: 'completed',
    next_iteration: plan.steps[1].path,
    has_improvement_brief: true,
  });
  expect(a.action).toBe('run-improver');
  a = d.call({ kind: 'improver', applied: true, script_briefs: 2 });
  if (a.action !== 'run-script-creator') throw 0;
  expect(a.number).toBe(1);
  // 'repaired' (repair-script mode) and 'converted' (convert-step mode) are
  // valid ScriptRecord outcomes; the engine counts them like any other.
  a = d.call({ kind: 'script', outcome: 'repaired', script_path: '/p/scripts/wait.py' });
  if (a.action !== 'run-script-creator') throw 0;
  expect(a.number).toBe(2);
  a = d.call({ kind: 'script', outcome: 'converted', script_path: '/p/scripts/wait2.py' });
  if (a.action !== 'run-step') throw 0; // improve item drained → chain advances
  expect(a.steps[0].step_id).toBe('wait');
});

test('new state fields survive a save/load round-trip (repaired_steps is carried, not consumed)', () => {
  const plan = computePlan(scaffoldScriptSeq());
  const d = driver(plan);
  d.call(null);
  // Fresh init writes the defaults.
  expect(d.state!.fallback_attempted).toEqual({});
  expect(d.state!.repaired_steps).toEqual([]);
  expect(d.state!.partial_layer_results).toBe(null);
  // The command layer (T31) owns repaired_steps — the engine must persist it
  // untouched across round-trips and further transitions.
  d.state!.repaired_steps = ['wait'];
  d.state = roundTrip(d.state);
  const a = d.call({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  expect(a.action).toBe('run-step');
  expect(d.state!.repaired_steps).toEqual(['wait']);
});

// --- graph routing off script flags (task step 7 last bullet) --------------------

test('graph: a script step routes off its synthesized flags exactly like an agent step', () => {
  const plan = computePlan(scaffoldScriptGraph());
  const d = driver(plan);
  const stepOf = (a: NextAction) => (a.action === 'run-step' ? a.steps[0] : null);

  let a = d.call(null, { start: plan.steps[0].path }); // implement
  expect(stepOf(a)?.step_id).toBe('implement');
  a = d.call({ kind: 'step', outcome: 'completed', flags: {} }); // → check (script)
  expect(stepOf(a)?.step_id).toBe('check');
  expect(stepOf(a)?.type).toBe('script');

  // The command synthesizes {kind:'step', outcome:'completed', flags, output}
  // from the script's stdout (§5.1); routing consumes flags unchanged.
  a = d.call({ kind: 'step', outcome: 'completed', flags: { needs_fix: true }, output: { lint: 3 } });
  expect(stepOf(a)?.step_id).toBe('implement'); // looped back
  a = d.call({ kind: 'step', outcome: 'completed', flags: {} });
  expect(stepOf(a)?.step_id).toBe('check');
  const secondCheckIndex = stepOf(a)!.index;
  a = d.call({ kind: 'step', outcome: 'completed', flags: { needs_fix: false }, output: { lint: 0 } });
  expect(stepOf(a)?.step_id).toBe('package');
  // A graph loop-back re-ran the same step_id under a NEW dispatch index —
  // the §8 ledger property (never a stale reuse).
  expect(secondCheckIndex).toBeGreaterThan(2);
  a = d.call({ kind: 'step', outcome: 'completed', flags: {} });
  expect(a.action).toBe('done');
});
