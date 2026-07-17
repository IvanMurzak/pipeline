// T31 — command-layer integration tests for in-process `type: script` step
// execution (src/commands/next.ts invokeNext): sequential chain collapse, the
// §7 call budget + {action:'continue'}, graph routing off script flags, the
// §6.3 failure-policy ladder (halt / agent fallback / env), §6.2 feedback
// files, the §10 outputs store (persist + downstream `${steps…}` binding +
// incoming agent-record output), §9 mixed/all-script layer partition,
// `--manual-scripts` passthrough, §8 ledger reuse across a simulated crash,
// and `pipeline drive` completing an all-script fixture with zero executor
// spawns (the callBudgetMs seam).
//
// Spawn strategy mirrors script-step.test.ts: REAL bun-runnable .js fixture
// scripts through the real hook-runner supervisor where end-to-end fidelity
// matters; a FakeProcessRunner (invokeNext's scriptRunner seam) where
// determinism needs it (budget timing, flag sequencing, call counting).

import { test, expect, afterEach } from 'bun:test';
import { invokeNext, runNext } from '../src/commands/next';
import { runDrive } from '../src/commands/drive';
import type { NextRecord, NextState } from '../src/lib/next';
import type { ProcessRunner } from '../src/lib/script-step';
import type { GitRunner } from '../src/lib/git';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// World scaffolding — a consumer project with one pipeline at
// <project>/.claude/pipeline/demo/ (steps + scripts), driven with cwd swapped
// to the project (invokeNext reads process.cwd() as the project root).
// ---------------------------------------------------------------------------

interface World {
  project: string;
  home: string;
  root: string; // the pipeline root
  steps: string;
  scripts: string;
}

function mkWorld(manifest = '# P\n\n## End State\nx\n'): World {
  const project = mkTmp('sint-proj-');
  const home = mkTmp('sint-home-');
  // A real .git dir pins resolveProjectRoot (lib/event.ts) to THIS project so
  // the event journal lands here, never in an enclosing repo (hooks.test.ts
  // does the same).
  spawnSync('git', ['init', '-q'], { cwd: project });
  const root = join(project, '.claude', 'pipeline', 'demo');
  const steps = join(root, 'steps');
  const scripts = join(root, 'scripts');
  mkdirSync(steps, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), manifest);
  return { project, home, root, steps, scripts };
}

/** Swap cwd to the project + isolate HOME/USERPROFILE + clear the event
 *  writer's envelope vars (the hooks.test.ts harness). */
function inProject<T>(w: World, fn: () => T): T {
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

/** A script iteration file with the required sections. `next` is the exact
 *  `## Next` line (an absolute .md path or 'Pipeline complete.'); omit for
 *  graph/DAG steps. */
function scriptStepMd(opts: {
  script: string;
  stepId: string;
  next?: string;
  onFailure?: 'halt' | 'agent';
  timeout?: number;
  dependsOn?: string[];
  params?: string;
}): string {
  const fm = [
    '---',
    'type: script',
    `script: ${opts.script}`,
    `step_id: ${opts.stepId}`,
    ...(opts.timeout !== undefined ? [`timeout: ${opts.timeout}`] : []),
    ...(opts.onFailure ? [`on-failure: ${opts.onFailure}`] : []),
    ...(opts.dependsOn ? [`depends-on: [${opts.dependsOn.join(', ')}]`] : []),
    '---',
  ].join('\n');
  return [
    fm,
    `# ${opts.stepId}`,
    '## Goal',
    'g',
    '## Success Criteria',
    's',
    ...(opts.params ? ['## Params', '', '```json', opts.params, '```', ''] : []),
    '## Steps',
    `1. Run: \`bun ${opts.script}\` — deterministic work.`,
    ...(opts.next ? ['## Next', opts.next] : []),
    '',
  ].join('\n');
}

function agentStepMd(stepId: string, dependsOn?: string[]): string {
  const fm = ['---', `step_id: ${stepId}`, ...(dependsOn ? [`depends-on: [${dependsOn.join(', ')}]`] : []), '---'].join('\n');
  return `${fm}\n# ${stepId}\n## Goal\ng\n## Success Criteria\ns\n`;
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const stateOf = (w: World, runId: string): NextState => readJson(join(w.root, '.runtime', runId, 'next.json'));

function readEvents(w: World): any[] {
  const f = join(w.project, '.claude', 'pipeline', '.runtime', 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l: string) => JSON.parse(l));
}

/** Real fixture scripts (bun-runnable through the hook-runner supervisor). */
const ONE_JS = `console.log('working…');
console.log(JSON.stringify({ ok: true, summary: 'made pr', flags: { made: true }, output: { pr: 7 } }));
`;
const TWO_JS = `const fs = require('node:fs');
const params = JSON.parse(fs.readFileSync(process.env.PIPELINE_STEP_PARAMS_FILE, 'utf8'));
if (params.pr_number !== 7) {
  console.log(JSON.stringify({ ok: false, error: { class: 'bug', detail: 'wrong pr ' + params.pr_number } }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, output: { got: params.pr_number } }));
`;
const BAD_JS = `console.error('boom');
process.exit(3);
`;
const ENV_JS = `console.log(JSON.stringify({ ok: false, error: { class: 'env', detail: 'python missing' } }));
process.exit(1);
`;

/** FakeProcessRunner factory: returns prescribed results per call, counting
 *  calls; optional busy-wait to advance the REAL clock (the §7 budget). */
function fakeRunner(
  results: Array<{ stdout: string; code?: number; sleepMs?: number }>,
): { runner: ProcessRunner; calls: () => number } {
  let n = 0;
  const runner: ProcessRunner = () => {
    const r = results[Math.min(n, results.length - 1)];
    n += 1;
    if (r.sleepMs) {
      const end = Date.now() + r.sleepMs;
      while (Date.now() < end) {
        // busy-wait: deterministic wall-clock advance for the budget check
      }
    }
    return { code: r.code ?? 0, stdout: r.stdout, stderr: '', timedOut: false };
  };
  return { runner, calls: () => n };
}

const okStdout = (extra: Record<string, unknown> = {}) => JSON.stringify({ ok: true, ...extra });

// ---------------------------------------------------------------------------
// 1. Sequential all-script chain collapses in ONE call (real scripts) + §10
//    outputs store feeding a downstream `${steps…}` binding
// ---------------------------------------------------------------------------

test('sequential 2-script chain runs to done in one invokeNext call; outputs persisted and consumed', () => {
  const w = mkWorld();
  writeFileSync(join(w.scripts, 'one.js'), ONE_JS);
  writeFileSync(join(w.scripts, 'two.js'), TWO_JS);
  const twoAbs = join(w.steps, '02-two.md');
  writeFileSync(join(w.steps, '01-one.md'), scriptStepMd({ script: 'scripts/one.js', stepId: 's1', next: twoAbs }));
  writeFileSync(
    twoAbs,
    scriptStepMd({
      script: 'scripts/two.js',
      stepId: 's2',
      next: 'Pipeline complete.',
      params: '{ "pr_number": { "type": "number", "required": true, "from": "${steps.s1.output.pr}" } }',
    }),
  );

  inProject(w, () => {
    const res = invokeNext({ root: w.root, runId: 'r1' });
    expect(res.action.action).toBe('done');
    expect(res.code).toBe(0);

    // §10 outputs store: producer persisted, consumer resolved + persisted.
    expect(readJson(join(w.root, '.runtime', 'r1', 'outputs', 's1.json'))).toEqual({ pr: 7 });
    expect(readJson(join(w.root, '.runtime', 'r1', 'outputs', 's2.json'))).toEqual({ got: 7 });
    // Resolved params file (the PIPELINE_STEP_PARAMS_FILE contract).
    expect(readJson(join(w.root, '.runtime', 'r1', 'params', 's2.json'))).toEqual({ pr_number: 7 });
    // §8 ledger: finished entries at the dispatch indices (s1→1, s2→2).
    expect(readJson(join(w.root, '.runtime', 'r1', 'ledger', 's1-1.json')).phase).toBe('finished');
    expect(readJson(join(w.root, '.runtime', 'r1', 'ledger', 's2-2.json')).phase).toBe('finished');
    // Terminal state.
    const st = stateOf(w, 'r1');
    expect(st.phase).toBe('terminal');
    expect(st.status).toBe('completed');

    // §12 events: started/completed pairs tagged step_type:"script".
    const evs = readEvents(w);
    const started = evs.filter((e) => e.type === 'iteration.started');
    expect(started.length).toBe(2);
    expect(started.every((e) => e.data.step_type === 'script')).toBe(true);
    const completed = evs.filter((e) => e.type === 'iteration.completed');
    expect(completed.length).toBe(2);
    expect(completed.every((e) => e.data.outcome === 'completed' && e.data.step_type === 'script')).toBe(true);
    expect(completed[1].data.next_iteration_path).toBe('PIPELINE_COMPLETE');
    expect(completed[1].data.terminal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. §7 call budget: exhaustion returns {action:'continue'}; the follow-up
//    {"kind":"continue"} call resumes the SAME pending dispatch (same index)
// ---------------------------------------------------------------------------

test('budget exhaustion returns continue; the follow-up continue call resumes and finishes', () => {
  const w = mkWorld();
  const twoAbs = join(w.steps, '02-b.md');
  writeFileSync(join(w.steps, '01-a.md'), scriptStepMd({ script: 'scripts/a.js', stepId: 'a', next: twoAbs, timeout: 10 }));
  writeFileSync(twoAbs, scriptStepMd({ script: 'scripts/b.js', stepId: 'b', next: 'Pipeline complete.', timeout: 28 }));

  // budget = margin + a 30 s fresh window. The first exec busy-waits 4 s
  // (> 10% of the fresh window), so the SECOND script (declared 28 s) no
  // longer fits the remaining ~26 s AND a fresh window is materially better
  // → park + {action:'continue'}.
  const budget = 45_000 + 30_000;
  const fake = fakeRunner([
    { stdout: okStdout({ output: { n: 1 } }), sleepMs: 4_000 },
    { stdout: okStdout({ output: { n: 2 } }) },
  ]);

  inProject(w, () => {
    const first = invokeNext({ root: w.root, runId: 'r2', callBudgetMs: budget, scriptRunner: fake.runner });
    expect(first.action.action).toBe('continue');
    expect(first.code).toBe(0);
    expect(first.out.action).toBe('continue');
    expect(fake.calls()).toBe(1); // only script 'a' ran in this window
    let st = stateOf(w, 'r2');
    expect(st.phase).toBe('await-step');
    expect(st.current_step_id).toBe('b');
    expect(st.index).toBe(2); // dispatch already allocated — the §8 ledger key

    // Fresh window (default budget): 'b' fits and runs.
    const second = invokeNext({
      root: w.root,
      runId: 'r2',
      record: { kind: 'continue' } as NextRecord,
      scriptRunner: fake.runner,
    });
    expect(second.action.action).toBe('done');
    expect(fake.calls()).toBe(2);
    // SAME dispatch index across the window hand-off (ledger b-2, never b-3).
    expect(readJson(join(w.root, '.runtime', 'r2', 'ledger', 'b-2.json')).phase).toBe('finished');
    expect(existsSync(join(w.root, '.runtime', 'r2', 'ledger', 'b-3.json'))).toBe(false);
    st = stateOf(w, 'r2');
    expect(st.status).toBe('completed');
  });
}, 30_000);

// A declared timeout that exceeds even a FRESH window (incl. the 600 s default
// on a smaller budget) can never be helped by `continue` — on a fresh window it
// must run NOW with a truncated deadline instead of ping-ponging forever (the
// old fits-fresh test also truncated it to a near-zero deadline late in a
// window — a guaranteed spurious transient kill).
test('mustContinue: an oversized declared timeout on a FRESH window runs truncated, never continue', () => {
  const w = mkWorld();
  writeFileSync(join(w.steps, '01-big.md'), scriptStepMd({ script: 'scripts/big.js', stepId: 'big', next: 'Pipeline complete.', timeout: 600 }));
  const fake = fakeRunner([{ stdout: okStdout() }]);

  inProject(w, () => {
    // Fresh 60 s window; declared 600 s fits NOTHING → run truncated → done.
    const res = invokeNext({ root: w.root, runId: 'r2b', callBudgetMs: 45_000 + 60_000, scriptRunner: fake.runner });
    expect(res.action.action).toBe('done');
    expect(fake.calls()).toBe(1);
    expect(stateOf(w, 'r2b').status).toBe('completed');
  });
});

test('mustContinue: an oversized-timeout script on a nearly-spent window parks, then runs truncated in the fresh window', () => {
  const w = mkWorld();
  const twoAbs = join(w.steps, '02-big.md');
  writeFileSync(join(w.steps, '01-small.md'), scriptStepMd({ script: 'scripts/small.js', stepId: 'small', next: twoAbs, timeout: 10 }));
  writeFileSync(twoAbs, scriptStepMd({ script: 'scripts/big.js', stepId: 'big', next: 'Pipeline complete.', timeout: 600 }));
  const fake = fakeRunner([
    { stdout: okStdout(), sleepMs: 4_000 }, // burns > 10% of the 30 s fresh window
    { stdout: okStdout() },
  ]);

  inProject(w, () => {
    // Nearly-spent window: 'big' fits nothing, but a fresh window is
    // MATERIALLY better (≥10% more room) → park.
    const first = invokeNext({ root: w.root, runId: 'r2c', callBudgetMs: 45_000 + 30_000, scriptRunner: fake.runner });
    expect(first.action.action).toBe('continue');
    expect(fake.calls()).toBe(1);

    // Fresh window: still oversized → runs truncated to the whole window
    // (the best achievable) instead of parking again.
    const second = invokeNext({ root: w.root, runId: 'r2c', record: { kind: 'continue' } as NextRecord, scriptRunner: fake.runner });
    expect(second.action.action).toBe('done');
    expect(fake.calls()).toBe(2);
    expect(readJson(join(w.root, '.runtime', 'r2c', 'ledger', 'big-2.json')).phase).toBe('finished');
  });
}, 30_000);

// ---------------------------------------------------------------------------
// 3. Graph mode: a script step routes off its synthesized flags
// ---------------------------------------------------------------------------

test('graph: script flags drive routeNext exactly like agent result_flags', () => {
  const graph = { implement: { goto: 'check' }, check: [{ when: 'needs_fix', goto: 'implement', max: 2 }, { goto: 'package' }] };
  const w = mkWorld(`# P\n\n## End State\nx\n\n## Graph\n\n\`\`\`json\n${JSON.stringify(graph)}\n\`\`\`\n`);
  writeFileSync(join(w.steps, '01-implement.md'), agentStepMd('implement'));
  writeFileSync(join(w.steps, '02-check.md'), scriptStepMd({ script: 'scripts/check.js', stepId: 'check', timeout: 30 }));
  writeFileSync(join(w.steps, '03-package.md'), agentStepMd('package'));

  const fake = fakeRunner([
    { stdout: okStdout({ flags: { needs_fix: true } }) },
    { stdout: okStdout({ flags: { needs_fix: false } }) },
  ]);

  inProject(w, () => {
    const init = invokeNext({ root: w.root, runId: 'r3', start: join(w.steps, '01-implement.md'), scriptRunner: fake.runner });
    if (init.action.action !== 'run-step') throw new Error(`expected run-step, got ${init.action.action}`);
    expect(init.action.steps[0].step_id).toBe('implement');

    // implement completed → check (script) intercepted → needs_fix loops back.
    const r1 = invokeNext({
      root: w.root,
      runId: 'r3',
      record: { kind: 'step', outcome: 'completed', flags: {} } as NextRecord,
      scriptRunner: fake.runner,
    });
    if (r1.action.action !== 'run-step') throw new Error(`expected run-step, got ${r1.action.action}`);
    expect(r1.action.steps[0].step_id).toBe('implement');
    expect(r1.action.steps[0].type).toBe('agent');
    expect(fake.calls()).toBe(1);

    // implement completed again → check (clean) → package.
    const r2 = invokeNext({
      root: w.root,
      runId: 'r3',
      record: { kind: 'step', outcome: 'completed', flags: {} } as NextRecord,
      scriptRunner: fake.runner,
    });
    if (r2.action.action !== 'run-step') throw new Error(`expected run-step, got ${r2.action.action}`);
    expect(r2.action.steps[0].step_id).toBe('package');
    expect(fake.calls()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4. on-failure: halt (default) — halt-shaped record, feedback file, and the
//    freshly-written feedback GATES the retrospective of this very halt
// ---------------------------------------------------------------------------

test('halt policy: crash → failure record + .log + feedback file → retrospective → halt', () => {
  const w = mkWorld();
  writeFileSync(join(w.scripts, 'bad.js'), BAD_JS);
  writeFileSync(join(w.steps, '01-bad.md'), scriptStepMd({ script: 'scripts/bad.js', stepId: 'bad', next: 'Pipeline complete.' }));

  inProject(w, () => {
    const res = invokeNext({ root: w.root, runId: 'r4' });
    // The feedback file written by the failure gates the retrospective NOW.
    expect(res.action.action).toBe('retrospective');
    expect(res.code).toBe(0);

    // §6.2.1 failure record + full .log (keyed <step_id>-<dispatch_index>-<attempt>).
    const failure = readJson(join(w.root, '.runtime', 'r4', 'failures', 'bad-1-1.json'));
    expect(failure.class).toBe('crash');
    expect(failure.exit_code).toBe(3);
    expect(readFileSync(join(w.root, '.runtime', 'r4', 'failures', 'bad-1-1.log'), 'utf8')).toContain('boom');
    // §6.2.2 feedback file, CLI-written.
    const fb = readFileSync(join(w.root, '.feedback', 'r4', 'bad-01.md'), 'utf8');
    expect(fb).toContain('category: script-failure');
    expect(fb).toContain("failed with class 'crash'");

    const st = stateOf(w, 'r4');
    expect(st.phase).toBe('await-retro');
    expect(st.status).toBe('halted');
    expect(st.halt_reason).toMatch(/^script step bad failed \(crash\)/);

    // §12: the completion event carries step_type + failure_class.
    const done = readEvents(w).filter((e) => e.type === 'iteration.completed');
    expect(done.length).toBe(1);
    expect(done[0].data.outcome).toBe('halted');
    expect(done[0].data.step_type).toBe('script');
    expect(done[0].data.failure_class).toBe('crash');
    expect(done[0].data.terminal).toBe(true);

    const halt = invokeNext({ root: w.root, runId: 'r4', record: { kind: 'retro' } as NextRecord });
    expect(halt.action.action).toBe('halt');
    expect(halt.code).toBe(1);
    if (halt.action.action === 'halt') expect(halt.action.reason).toMatch(/^script step bad failed \(crash\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. on-failure: agent — the fallback re-dispatch action shape + once-only
// ---------------------------------------------------------------------------

test('agent fallback: failed script re-dispatches as an agent step once; second failure halts', () => {
  const w = mkWorld('---\nmodel: sonnet\n---\n# P\n\n## End State\nx\n');
  writeFileSync(join(w.scripts, 'flaky.js'), BAD_JS);
  const afterAbs = join(w.steps, '02-after.md');
  writeFileSync(
    join(w.steps, '01-flaky.md'),
    scriptStepMd({ script: 'scripts/flaky.js', stepId: 'flaky', next: afterAbs, onFailure: 'agent' }),
  );
  writeFileSync(afterAbs, agentStepMd('02-after'));

  inProject(w, () => {
    const res = invokeNext({ root: w.root, runId: 'r5' });
    if (res.action.action !== 'run-step') throw new Error(`expected run-step, got ${res.action.action}`);
    const s = res.action.steps[0];
    expect(s.step_id).toBe('flaky'); // the SAME step…
    expect(s.type).toBe('agent'); // …as an AGENT dispatch
    expect(s.fallback).toBe('script-failure');
    expect(typeof s.failure_record).toBe('string');
    expect(existsSync(s.failure_record!)).toBe(true); // the §6.2.1 record on disk
    expect(s.model).toBe('sonnet'); // agent spawn resolves the run default
    expect(s.index).toBe(2); // fresh dispatch index (new spawn)
    expect(stateOf(w, 'r5').fallback_attempted).toEqual({ flaky: true });
    // The fallback failure's completion event is NOT terminal (run continues).
    const done = readEvents(w).filter((e) => e.type === 'iteration.completed');
    expect(done[0].data.terminal).toBe(false);
    expect(done[0].data.failure_class).toBe('crash');

    // Fallback completes; the chain loops back to the script (designer revisit)
    // → it fails again → the once-per-run bound is consumed → halt path (the
    // feedback written earlier gates the retrospective).
    const res2 = invokeNext({
      root: w.root,
      runId: 'r5',
      record: { kind: 'step', outcome: 'completed', next_iteration: join(w.steps, '01-flaky.md') } as NextRecord,
    });
    expect(res2.action.action).toBe('retrospective');
    expect(stateOf(w, 'r5').status).toBe('halted');
    // Two feedback files: one per failure.
    const fb = readdirSync(join(w.root, '.feedback', 'r5')).filter((n) => n.endsWith('.md')).sort();
    expect(fb).toEqual(['flaky-01.md', 'flaky-02.md']);
  });
});

// ---------------------------------------------------------------------------
// 6. class env ⇒ halt even under on-failure: agent (§6.3 ladder rung 2)
// ---------------------------------------------------------------------------

test('env-class failure halts even with on-failure: agent (no fallback, category env feedback)', () => {
  const w = mkWorld();
  writeFileSync(join(w.scripts, 'env.js'), ENV_JS);
  writeFileSync(
    join(w.steps, '01-env.md'),
    scriptStepMd({ script: 'scripts/env.js', stepId: 'envy', next: 'Pipeline complete.', onFailure: 'agent' }),
  );

  inProject(w, () => {
    const res = invokeNext({ root: w.root, runId: 'r6' });
    expect(res.action.action).toBe('retrospective'); // halt path (feedback gates retro)
    const st = stateOf(w, 'r6');
    expect(st.status).toBe('halted');
    expect(st.halt_reason).toMatch(/^script step envy failed \(env\)/);
    expect(st.fallback_attempted).toEqual({}); // never consumed
    expect(readFileSync(join(w.root, '.feedback', 'r6', 'envy-01.md'), 'utf8')).toContain('category: env');
  });
});

// ---------------------------------------------------------------------------
// 7. §6.4 bound #2 — repaired_steps: appended after a repair-script run,
//    consulted to suppress a second fallback of the same script
// ---------------------------------------------------------------------------

test('repaired_steps: a script-creator repair is recorded; a post-repair failure halts instead of falling back', () => {
  const w = mkWorld();
  const flakyAbs = join(w.steps, '01-flaky.md');
  const afterAbs = join(w.steps, '02-after.md');
  writeFileSync(flakyAbs, scriptStepMd({ script: 'scripts/flaky.js', stepId: 'flaky', next: afterAbs, onFailure: 'agent' }));
  writeFileSync(afterAbs, agentStepMd('02-after'));
  const fake = fakeRunner([{ stdout: 'no json here', code: 1 }]); // always class crash

  inProject(w, () => {
    // Failure → fallback dispatch.
    const r1 = invokeNext({ root: w.root, runId: 'r7', scriptRunner: fake.runner });
    if (r1.action.action !== 'run-step') throw new Error(`expected run-step, got ${r1.action.action}`);
    expect(r1.action.steps[0].fallback).toBe('script-failure');

    // Fallback completes WITH an improvement brief → Tier-1 improver →
    // script-creator (mode repair-script) → the repair consumes bound #2.
    const r2 = invokeNext({
      root: w.root,
      runId: 'r7',
      record: { kind: 'step', outcome: 'completed', next_iteration: afterAbs, has_improvement_brief: true } as NextRecord,
      scriptRunner: fake.runner,
    });
    expect(r2.action.action).toBe('run-improver');
    const r3 = invokeNext({
      root: w.root,
      runId: 'r7',
      record: { kind: 'improver', applied: true, script_briefs: 1 } as NextRecord,
      scriptRunner: fake.runner,
    });
    expect(r3.action.action).toBe('run-script-creator');
    const r4 = invokeNext({
      root: w.root,
      runId: 'r7',
      record: { kind: 'script', outcome: 'updated', script_path: join(w.scripts, 'flaky.js') } as NextRecord,
      scriptRunner: fake.runner,
    });
    if (r4.action.action !== 'run-step') throw new Error(`expected run-step, got ${r4.action.action}`);
    expect(r4.action.steps[0].step_id).toBe('02-after');
    expect(stateOf(w, 'r7').repaired_steps).toEqual(['flaky']);

    // Surgery: pretend the fallback bound is free again — the repaired_steps
    // consult ALONE must force the halt path on the next failure (§6.4:
    // "a second failure of the same script after an in-run repair ⇒ halt").
    const stFile = join(w.root, '.runtime', 'r7', 'next.json');
    const st = readJson(stFile);
    st.fallback_attempted = {};
    writeFileSync(stFile, JSON.stringify(st, null, 2) + '\n', 'utf8');

    const r5 = invokeNext({
      root: w.root,
      runId: 'r7',
      record: { kind: 'step', outcome: 'completed', next_iteration: flakyAbs } as NextRecord,
      scriptRunner: fake.runner,
    });
    expect(r5.action.action).toBe('retrospective'); // halt path, NOT a fallback dispatch
    const after = stateOf(w, 'r7');
    expect(after.status).toBe('halted');
    expect(after.fallback_attempted).toEqual({}); // fallback never requested
  });
});

// The repair-script mode's MANDATED outcome is 'repaired' — the sanctioned
// §6.4 flow must populate repaired_steps exactly like created/updated.
test("repaired_steps: the repair-script mode's 'repaired' outcome also consumes bound #2", () => {
  const w = mkWorld();
  const flakyAbs = join(w.steps, '01-flaky.md');
  const afterAbs = join(w.steps, '02-after.md');
  writeFileSync(flakyAbs, scriptStepMd({ script: 'scripts/flaky.js', stepId: 'flaky', next: afterAbs, onFailure: 'agent' }));
  writeFileSync(afterAbs, agentStepMd('02-after'));
  const fake = fakeRunner([{ stdout: 'no json here', code: 1 }]); // always class crash

  inProject(w, () => {
    const r1 = invokeNext({ root: w.root, runId: 'r7b', scriptRunner: fake.runner });
    if (r1.action.action !== 'run-step') throw new Error(`expected run-step, got ${r1.action.action}`);
    expect(r1.action.steps[0].fallback).toBe('script-failure');
    const r2 = invokeNext({
      root: w.root,
      runId: 'r7b',
      record: { kind: 'step', outcome: 'completed', next_iteration: afterAbs, has_improvement_brief: true } as NextRecord,
      scriptRunner: fake.runner,
    });
    expect(r2.action.action).toBe('run-improver');
    const r3 = invokeNext({
      root: w.root,
      runId: 'r7b',
      record: { kind: 'improver', applied: true, script_briefs: 1 } as NextRecord,
      scriptRunner: fake.runner,
    });
    expect(r3.action.action).toBe('run-script-creator');
    const r4 = invokeNext({
      root: w.root,
      runId: 'r7b',
      record: { kind: 'script', outcome: 'repaired', script_path: join(w.scripts, 'flaky.js') } as NextRecord,
      scriptRunner: fake.runner,
    });
    if (r4.action.action !== 'run-step') throw new Error(`expected run-step, got ${r4.action.action}`);
    expect(r4.action.steps[0].step_id).toBe('02-after');
    expect(stateOf(w, 'r7b').repaired_steps).toEqual(['flaky']);
  });
});

// ---------------------------------------------------------------------------
// 8. §9 mixed layer: script members execute in-process, the caller receives
//    ONLY the agent members; the engine folds parked + recorded results
// ---------------------------------------------------------------------------

const PARALLEL_MANIFEST = '---\nexecution: parallel\nisolation: manual\n---\n# P\n\n## End State\nx\n';

test('mixed layer partition: script member runs in-process, agent-only action returned, fold advances', () => {
  const w = mkWorld(PARALLEL_MANIFEST);
  writeFileSync(join(w.scripts, 'one.js'), ONE_JS);
  writeFileSync(join(w.steps, '01-setup.md'), agentStepMd('setup'));
  writeFileSync(join(w.steps, '02-x.md'), scriptStepMd({ script: 'scripts/one.js', stepId: 'x', dependsOn: ['setup'] }));
  writeFileSync(join(w.steps, '03-y.md'), agentStepMd('y', ['setup']));
  writeFileSync(join(w.steps, '04-z.md'), agentStepMd('z', ['x', 'y']));

  inProject(w, () => {
    const init = invokeNext({ root: w.root, runId: 'r8' });
    if (init.action.action !== 'run-step') throw new Error(`expected run-step, got ${init.action.action}`);
    expect(init.action.steps.map((s) => s.step_id)).toEqual(['setup']);

    const layer = invokeNext({
      root: w.root,
      runId: 'r8',
      record: { kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] } as NextRecord,
    });
    if (layer.action.action !== 'run-step') throw new Error(`expected run-step, got ${layer.action.action}`);
    expect(layer.action.concurrent).toBe(true);
    expect(layer.action.steps.map((s) => s.step_id)).toEqual(['y']); // agent member only
    const st = stateOf(w, 'r8');
    expect(st.partial_layer_results).toEqual([{ step_id: 'x', outcome: 'completed' }]);
    expect(readJson(join(w.root, '.runtime', 'r8', 'outputs', 'x.json'))).toEqual({ pr: 7 });

    const fold = invokeNext({
      root: w.root,
      runId: 'r8',
      record: { kind: 'layer', results: [{ step_id: 'y', outcome: 'completed' }] } as NextRecord,
    });
    if (fold.action.action !== 'run-step') throw new Error(`expected run-step, got ${fold.action.action}`);
    expect(fold.action.steps.map((s) => s.step_id)).toEqual(['z']); // folded → advanced
    expect(stateOf(w, 'r8').partial_layer_results).toBe(null); // pen cleared
  });
});

// ---------------------------------------------------------------------------
// 9. §9 all-script layer: fully self-fed — the caller only sees the next layer
// ---------------------------------------------------------------------------

test('all-script layer self-feeds: both members execute in-process, next action is the following layer', () => {
  const w = mkWorld(PARALLEL_MANIFEST);
  writeFileSync(join(w.scripts, 'one.js'), ONE_JS);
  writeFileSync(join(w.steps, '01-setup.md'), agentStepMd('setup'));
  writeFileSync(join(w.steps, '02-x.md'), scriptStepMd({ script: 'scripts/one.js', stepId: 'x', dependsOn: ['setup'] }));
  writeFileSync(join(w.steps, '03-y.md'), scriptStepMd({ script: 'scripts/one.js', stepId: 'y', dependsOn: ['setup'] }));
  writeFileSync(join(w.steps, '04-z.md'), agentStepMd('z', ['x', 'y']));

  inProject(w, () => {
    invokeNext({ root: w.root, runId: 'r9' }); // [setup]
    const res = invokeNext({
      root: w.root,
      runId: 'r9',
      record: { kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] } as NextRecord,
    });
    if (res.action.action !== 'run-step') throw new Error(`expected run-step, got ${res.action.action}`);
    expect(res.action.steps.map((s) => s.step_id)).toEqual(['z']); // the whole [x, y] layer was self-fed
    // Per-member indices 2 and 3 (setup was 1) — the §8 ledger keys.
    expect(readJson(join(w.root, '.runtime', 'r9', 'ledger', 'x-2.json')).phase).toBe('finished');
    expect(readJson(join(w.root, '.runtime', 'r9', 'ledger', 'y-3.json')).phase).toBe('finished');
    expect(stateOf(w, 'r9').partial_layer_results).toBe(null);
    // Concurrent-member events carry step_id (v4 rule) + the §12 tag.
    const started = readEvents(w).filter((e) => e.type === 'iteration.started' && e.data.step_type === 'script');
    expect(started.map((e) => e.data.step_id).sort()).toEqual(['x', 'y']);
  });
});

// §9 mid-layer budget park: the pass's collected entries are MERGED into the
// partial_layer_results pen, and the continue re-entry SKIPS penned members —
// a FAILED member (whose §8 ledger stays 'started') must never re-run its
// side effects or write a second feedback file.
test('mid-layer park preserves a failed member: no re-execution, no duplicate feedback on re-entry', () => {
  const w = mkWorld(PARALLEL_MANIFEST);
  writeFileSync(join(w.steps, '01-setup.md'), agentStepMd('setup'));
  writeFileSync(join(w.steps, '02-x.md'), scriptStepMd({ script: 'scripts/x.js', stepId: 'x', timeout: 10, dependsOn: ['setup'] }));
  writeFileSync(join(w.steps, '03-y.md'), scriptStepMd({ script: 'scripts/y.js', stepId: 'y', timeout: 28, dependsOn: ['setup'] }));
  const fake = fakeRunner([
    { stdout: 'boom - no json', code: 1, sleepMs: 4_000 }, // x FAILS (class crash) + burns > 10% of the window
    { stdout: okStdout() }, // y (second pass only)
  ]);

  inProject(w, () => {
    invokeNext({ root: w.root, runId: 'r9b' }); // [setup]
    // Window 1: layer [x, y] — x executes and fails; y no longer fits (28 s >
    // ~26 s left, fresh window materially better) → park MID-LAYER.
    const first = invokeNext({
      root: w.root,
      runId: 'r9b',
      record: { kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] } as NextRecord,
      callBudgetMs: 45_000 + 30_000,
      scriptRunner: fake.runner,
    });
    expect(first.action.action).toBe('continue');
    expect(fake.calls()).toBe(1);
    // x's collected entry is PENNED, not discarded; its ledger stays 'started'
    // (a failed member never flips to 'finished' — a replay would re-execute).
    const st = stateOf(w, 'r9b');
    expect((st.partial_layer_results ?? []).map((e) => [e.step_id, e.outcome])).toEqual([['x', 'halted']]);
    expect(readJson(join(w.root, '.runtime', 'r9b', 'ledger', 'x-2.json')).phase).toBe('started');
    expect(readdirSync(join(w.root, '.feedback', 'r9b')).filter((n) => n.endsWith('.md'))).toEqual(['x-01.md']);

    // Window 2 (fresh budget): x is SKIPPED (penned); only y executes. The
    // fold (pen + fresh results) halts the layer; feedback gates the retro.
    const second = invokeNext({ root: w.root, runId: 'r9b', record: { kind: 'continue' } as NextRecord, scriptRunner: fake.runner });
    expect(second.action.action).toBe('retrospective');
    expect(fake.calls()).toBe(2); // y only — x did NOT re-execute
    expect(readdirSync(join(w.root, '.feedback', 'r9b')).filter((n) => n.endsWith('.md'))).toEqual(['x-01.md']); // no x-02.md
    const after = stateOf(w, 'r9b');
    expect(after.status).toBe('halted');
    expect(after.halt_reason).toMatch(/^script step x failed \(crash\)/);
    expect(after.partial_layer_results).toBe(null); // pen folded + cleared
    // x's started/completed events fired exactly ONCE (window 1).
    const xEvents = readEvents(w).filter((e) => e.data.step_id === 'x');
    expect(xEvents.filter((e) => e.type === 'iteration.started').length).toBe(1);
    expect(xEvents.filter((e) => e.type === 'iteration.completed').length).toBe(1);
  });
}, 30_000);

// ---------------------------------------------------------------------------
// 10. --manual-scripts: raw script actions pass through unexecuted; the
//     caller-recorded step record's output still lands in the outputs store
// ---------------------------------------------------------------------------

test('--manual-scripts: passthrough (no execution) and incoming-record output persistence', () => {
  const w = mkWorld();
  writeFileSync(join(w.steps, '01-one.md'), scriptStepMd({ script: 'scripts/one.js', stepId: 's1', next: 'Pipeline complete.' }));

  inProject(w, () => {
    // Through the real argv surface (flag parsing coverage).
    let buf = '';
    const orig = process.stdout.write;
    (process.stdout as any).write = (chunk: unknown) => {
      buf += String(chunk);
      return true;
    };
    let code: number;
    try {
      code = runNext(['--root', w.root, '--run-id', 'r10', '--manual-scripts']);
    } finally {
      (process.stdout as any).write = orig;
    }
    expect(code).toBe(0);
    const json = JSON.parse(buf.trim());
    expect(json.action).toBe('run-step');
    expect(json.steps[0].type).toBe('script');
    // Nothing executed: no ledger, no params, no outputs.
    expect(existsSync(join(w.root, '.runtime', 'r10', 'ledger'))).toBe(false);
    expect(existsSync(join(w.root, '.runtime', 'r10', 'outputs'))).toBe(false);

    // The caller executed the script itself and records the outcome — the §10
    // outputs store persists the incoming record's output object.
    const res = invokeNext({
      root: w.root,
      runId: 'r10',
      manualScripts: true,
      record: { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE', output: { pr: 9 } } as NextRecord,
    });
    expect(res.action.action).toBe('done');
    expect(readJson(join(w.root, '.runtime', 'r10', 'outputs', 's1.json'))).toEqual({ pr: 9 });

    // §12 symmetry under --manual-scripts: the pass-through dispatch was
    // tagged step_type:"script" (dispatch-type keying), so the caller-recorded
    // completion must carry the SAME tag — and no failure_class (the caller
    // executed it; the CLI never classified anything).
    const evs = readEvents(w);
    const started = evs.filter((e) => e.type === 'iteration.started');
    expect(started.length).toBe(1);
    expect(started[0].data.step_type).toBe('script');
    const completed = evs.filter((e) => e.type === 'iteration.completed');
    expect(completed.length).toBe(1);
    expect(completed[0].data.step_type).toBe('script');
    expect(completed[0].data.failure_class).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. §8 ledger reuse across a simulated crash: a window that died between
//     record synthesis (ledger 'finished') and the engine feed never
//     re-executes the script — the continue re-entry reuses the stored record
// ---------------------------------------------------------------------------

test('ledger reuse: a finished entry from a crashed window is reused, never re-executed', () => {
  const w = mkWorld();
  const twoAbs = join(w.steps, '02-two.md');
  writeFileSync(join(w.steps, '01-one.md'), scriptStepMd({ script: 'scripts/one.js', stepId: 's1', next: twoAbs }));
  writeFileSync(
    twoAbs,
    scriptStepMd({
      script: 'scripts/two.js',
      stepId: 's2',
      next: 'Pipeline complete.',
      params: '{ "pr_number": { "type": "number", "required": true, "from": "${steps.s1.output.pr}" } }',
    }),
  );

  inProject(w, () => {
    // Window A parked the dispatch (state await-step, s1 @ index 1) — produced
    // here via --manual-scripts, which persists the identical parked state.
    const parked = invokeNext({ root: w.root, runId: 'r11', manualScripts: true });
    expect(parked.action.action).toBe('run-step');
    expect(stateOf(w, 'r11').index).toBe(1);

    // The crashed window HAD executed s1: its ledger flipped to 'finished'
    // (record + output stored) but the engine feed / state save never happened.
    const ledgerDir = join(w.root, '.runtime', 'r11', 'ledger');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      join(ledgerDir, 's1-1.json'),
      JSON.stringify({
        step_id: 's1',
        dispatch_index: 1,
        phase: 'finished',
        output: { pr: 7 },
        record: { kind: 'step', outcome: 'completed', summary: null, flags: null, next_iteration: twoAbs, output: { pr: 7 } },
      }),
    );

    // Fresh window, uniform §7 protocol: {"kind":"continue"} re-emits the SAME
    // dispatch (s1 @ index 1) → ledger reuse → only s2 actually spawns.
    const fake = fakeRunner([{ stdout: okStdout({ output: { got: 1 } }) }]);
    const res = invokeNext({ root: w.root, runId: 'r11', record: { kind: 'continue' } as NextRecord, scriptRunner: fake.runner });
    expect(res.action.action).toBe('done');
    expect(fake.calls()).toBe(1); // s2 only — s1 was NOT re-executed
    // The reused record's output was persisted to the store (s2's binding read it).
    expect(readJson(join(w.root, '.runtime', 'r11', 'outputs', 's1.json'))).toEqual({ pr: 7 });
    expect(readJson(join(w.root, '.runtime', 'r11', 'params', 's2.json'))).toEqual({ pr_number: 7 });
  });
});

// The SAME crash, re-entered through the OTHER documented protocol: a
// no-record auto-resume (crashed-manager re-spawn / UI STOP / drive --resume).
// resumeRun must re-emit the pending SCRIPT dispatch at its ORIGINAL index —
// the §8 ledger key — so the 'finished' entry is reused, never re-executed
// (agent steps keep the fresh-index bump; they have no ledger).
test('ledger reuse: a no-record auto-resume re-enters the pending script dispatch at the SAME index', () => {
  const w = mkWorld();
  const twoAbs = join(w.steps, '02-two.md');
  writeFileSync(join(w.steps, '01-one.md'), scriptStepMd({ script: 'scripts/one.js', stepId: 's1', next: twoAbs }));
  writeFileSync(
    twoAbs,
    scriptStepMd({
      script: 'scripts/two.js',
      stepId: 's2',
      next: 'Pipeline complete.',
      params: '{ "pr_number": { "type": "number", "required": true, "from": "${steps.s1.output.pr}" } }',
    }),
  );

  inProject(w, () => {
    // Window A parked the dispatch (state await-step, s1 @ index 1).
    const parked = invokeNext({ root: w.root, runId: 'r11b', manualScripts: true });
    expect(parked.action.action).toBe('run-step');
    expect(stateOf(w, 'r11b').index).toBe(1);

    // The crashed window HAD executed s1 (ledger 'finished'), then died before
    // the engine feed / state save.
    const ledgerDir = join(w.root, '.runtime', 'r11b', 'ledger');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      join(ledgerDir, 's1-1.json'),
      JSON.stringify({
        step_id: 's1',
        dispatch_index: 1,
        phase: 'finished',
        output: { pr: 7 },
        record: { kind: 'step', outcome: 'completed', summary: null, flags: null, next_iteration: twoAbs, output: { pr: 7 } },
      }),
    );

    // Fresh manager, NO record (the auto-resume re-entry): s1 must be reused
    // from the ledger (same index), so only s2 actually spawns.
    const fake = fakeRunner([{ stdout: okStdout({ output: { got: 1 } }) }]);
    const res = invokeNext({ root: w.root, runId: 'r11b', scriptRunner: fake.runner });
    expect(res.action.action).toBe('done');
    expect(fake.calls()).toBe(1); // s2 only — s1 was NOT re-executed
    expect(existsSync(join(w.root, '.runtime', 'r11b', 'ledger', 's1-2.json'))).toBe(false); // no re-bumped dispatch
    expect(readJson(join(w.root, '.runtime', 'r11b', 'outputs', 's1.json'))).toEqual({ pr: 7 });
    expect(readJson(join(w.root, '.runtime', 'r11b', 'params', 's2.json'))).toEqual({ pr_number: 7 });
  });
});

// §8/§12: a ledger REUSE is silent — the replayed member emits NO duplicate
// step.started/step.completed events or .stats lines (and does not burn the
// per-call exec cap). The one started line below comes from the pass-through
// dispatch, never from the reuse pass.
test('ledger reuse is silent: no duplicate events or stats lines for a replayed execution', () => {
  const w = mkWorld();
  const afterAbs = join(w.steps, '02-after.md');
  writeFileSync(join(w.steps, '01-one.md'), scriptStepMd({ script: 'scripts/one.js', stepId: 's1', next: afterAbs }));
  writeFileSync(afterAbs, agentStepMd('after'));

  inProject(w, () => {
    // Window A parked the dispatch (s1 @ index 1) — the pass-through emits the
    // dispatch's ONE tagged started event/stats line.
    const parked = invokeNext({ root: w.root, runId: 'r11c', manualScripts: true });
    expect(parked.action.action).toBe('run-step');

    // The crashed window HAD executed s1 (ledger 'finished') but never fed the
    // engine.
    const ledgerDir = join(w.root, '.runtime', 'r11c', 'ledger');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      join(ledgerDir, 's1-1.json'),
      JSON.stringify({
        step_id: 's1',
        dispatch_index: 1,
        phase: 'finished',
        output: { pr: 7 },
        record: { kind: 'step', outcome: 'completed', summary: null, flags: null, next_iteration: afterAbs, output: { pr: 7 } },
      }),
    );

    // Continue re-entry: s1 is REUSED (nothing spawns) and the run advances to
    // the agent step — silently.
    const fake = fakeRunner([{ stdout: okStdout() }]);
    const res = invokeNext({ root: w.root, runId: 'r11c', record: { kind: 'continue' } as NextRecord, scriptRunner: fake.runner });
    if (res.action.action !== 'run-step') throw new Error(`expected run-step, got ${res.action.action}`);
    expect(res.action.steps[0].step_id).toBe('after');
    expect(fake.calls()).toBe(0); // reuse — nothing executed
    expect(readJson(join(w.root, '.runtime', 'r11c', 'outputs', 's1.json'))).toEqual({ pr: 7 }); // output still persisted

    // Events: exactly ONE started for s1 (the pass-through), ZERO completed
    // (the reuse pass emitted nothing).
    const s1Events = readEvents(w).filter((e) => typeof e.data.iteration_path === 'string' && e.data.iteration_path.endsWith('01-one.md'));
    expect(s1Events.filter((e) => e.type === 'iteration.started').length).toBe(1);
    expect(s1Events.filter((e) => e.type === 'iteration.completed').length).toBe(0);

    // Stats timeline: same shape — one step.started for s1, no step.completed.
    const buf = join(w.project, '.claude', 'pipeline', '.stats', 'demo', 'runs', 'r11c.jsonl');
    const lines = readFileSync(buf, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l: string) => JSON.parse(l));
    expect(lines.filter((l: any) => l.k === 'step.started' && l.step_id === 's1').length).toBe(1);
    expect(lines.filter((l: any) => l.k === 'step.completed' && l.step_id === 's1').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 12. pipeline drive: an all-script fixture completes with ZERO executor
//     spawns (the callBudgetMs: Infinity seam — drive never sees `continue`)
// ---------------------------------------------------------------------------

test('pipeline drive completes an all-script pipeline without spawning any executor', async () => {
  const w = mkWorld();
  writeFileSync(join(w.scripts, 'one.js'), ONE_JS);
  writeFileSync(join(w.scripts, 'two.js'), TWO_JS);
  const twoAbs = join(w.steps, '02-two.md');
  writeFileSync(join(w.steps, '01-one.md'), scriptStepMd({ script: 'scripts/one.js', stepId: 's1', next: twoAbs }));
  writeFileSync(
    twoAbs,
    scriptStepMd({
      script: 'scripts/two.js',
      stepId: 's2',
      next: 'Pipeline complete.',
      params: '{ "pr_number": { "type": "number", "required": true, "from": "${steps.s1.output.pr}" } }',
    }),
  );

  let outBuf = '';
  let errBuf = '';
  const git: GitRunner = () => ({ code: 1, stdout: '', stderr: 'git disabled in this test' });
  const code = await inProject(w, () =>
    runDrive(['--root', w.root, '--run-id', 'r12', '--start', join(w.steps, '01-one.md'), '--json'], {
      executor: () => {
        throw new Error('executor must not be spawned for an all-script pipeline');
      },
      git,
      out: (s) => {
        outBuf += s;
      },
      err: (s) => {
        errBuf += s;
      },
    }),
  );
  delete process.env.PIPELINE_STATS_RUNNER; // drive tags the process env; keep the file's later tests clean
  expect(code).toBe(0);
  const final = JSON.parse(outBuf.trim());
  expect(final.status).toBe('completed');
  expect(errBuf).not.toContain('cannot actuate');
  expect(readJson(join(w.root, '.runtime', 'r12', 'outputs', 's2.json'))).toEqual({ got: 7 });
  const st = stateOf(w, 'r12');
  expect(st.phase).toBe('terminal');
  expect(st.status).toBe('completed');
});

// ---------------------------------------------------------------------------
// 13. PP_* variables end-to-end (env-variables design a4, 05 §4): frozen-map
//     argv substitution (T3/E2), script-path substitution, the D10 child-env
//     overlay winning over inherited env, substituted params files, and the
//     T3b containment halt — REAL spawns through the hook-runner supervisor.
// ---------------------------------------------------------------------------

/** The variables manifest for section 13 worlds. */
const VARS_MANIFEST = [
  '# P',
  '',
  '## End State',
  'x',
  '',
  '## Variables',
  '- PP_SERVICE (required) — service under release',
  '- PP_FLAG (default: ) — empty-default knob',
  '- PP_IMPL (default: probe2) — script impl to run',
  '- PP_URL — optional url',
  '',
].join('\n');

// Echoes its argv and the PP_* env it sees.
const PROBE_JS = `console.log(JSON.stringify({ ok: true, output: {
  args: process.argv.slice(2),
  env_service: process.env.PP_SERVICE ?? null,
  env_url: process.env.PP_URL ?? null,
} }));
`;
// Echoes the WHOLE resolved params object.
const PROBE2_JS = `const fs = require('node:fs');
const p = JSON.parse(fs.readFileSync(process.env.PIPELINE_STEP_PARAMS_FILE, 'utf8'));
console.log(JSON.stringify({ ok: true, output: { got: p } }));
`;

/** Save + clear every PP_* process-env var (deterministic resolution tiers —
 *  a stray shell PP_* must never satisfy a fixture), then plant the given
 *  INHERITED values (e.g. a same-name var the D10 overlay must beat). */
function withPPEnv<T>(plant: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('PP_')) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  for (const [k, v] of Object.entries(plant)) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('PP_')) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
}

test('vars e2e: argv substituted per element (metachar value = ONE element, empty keeps slot); env overlay beats inherited; params file substituted', () => {
  const w = mkWorld(VARS_MANIFEST);
  writeFileSync(join(w.scripts, 'probe.js'), PROBE_JS);
  writeFileSync(join(w.scripts, 'probe2.js'), PROBE2_JS);
  const twoAbs = join(w.steps, '02-two.md');
  writeFileSync(
    join(w.steps, '01-one.md'),
    [
      '---',
      'type: script',
      // command: runs with cwd = the PROJECT root (§4 cwd rule) — reference
      // the probe by absolute path (whitespace-split argv: tmp paths here are
      // space-free, same reliance as the other fixtures on process.execPath).
      `command: ${process.execPath} ${join(w.scripts, 'probe.js')} --service \${PP_SERVICE} \${PP_FLAG} --url \${PP_URL:-http://localhost}`,
      'step_id: s1',
      '---',
      '# s1',
      '## Goal',
      'g',
      '## Success Criteria',
      's',
      '## Steps',
      '1. run it',
      '## Next',
      twoAbs,
      '',
    ].join('\n'),
  );
  writeFileSync(
    twoAbs,
    scriptStepMd({
      script: 'scripts/${PP_IMPL}.js',
      stepId: 's2',
      next: 'Pipeline complete.',
      params:
        '{ "svc": { "type": "string", "required": true, "from": "${PP_SERVICE}" }, "chan": { "type": "string", "from": "${PP_URL:-#rel}" } }',
    }),
  );

  inProject(w, () =>
    withPPEnv({ PP_SERVICE: 'inherited-should-lose' }, () => {
      const res = invokeNext({ root: w.root, runId: 'rv1', cliVars: { PP_SERVICE: '; rm -rf /' } });
      expect(res.action.action).toBe('done');
      expect(res.code).toBe(0);

      // T3/E2: the metacharacter value landed as exactly ONE argv element (no
      // shell anywhere), the resolved-EMPTY PP_FLAG kept its argv slot, and
      // the unresolved PP_URL took its inline default.
      const s1 = readJson(join(w.root, '.runtime', 'rv1', 'outputs', 's1.json'));
      expect(s1.args).toEqual(['--service', '; rm -rf /', '', '--url', 'http://localhost']);
      // D10: the frozen value beats the INHERITED same-name process env…
      expect(s1.env_service).toBe('; rm -rf /');
      // …and an unresolved variable is NOT exported at all.
      expect(s1.env_url).toBeNull();

      // script: path substituted from the manifest-default tier (PP_IMPL).
      const s2 = readJson(join(w.root, '.runtime', 'rv1', 'outputs', 's2.json'));
      expect(s2.got).toEqual({ svc: '; rm -rf /', chan: '#rel' });
      // The params FILE itself was written post-substitution (plain strings).
      expect(readJson(join(w.root, '.runtime', 'rv1', 'params', 's2.json'))).toEqual({
        svc: '; rm -rf /',
        chan: '#rel',
      });

      // The frozen map: CLI > env > default; unresolved optional NOT frozen.
      const st = stateOf(w, 'rv1');
      expect(st.variables).toEqual({ PP_SERVICE: '; rm -rf /', PP_FLAG: '', PP_IMPL: 'probe2' });
    }),
  );
}, 30_000);

test('vars e2e (T3b): a traversal value steering script: halts the run as a binding step error — nothing spawns', () => {
  const w = mkWorld(
    ['# P', '', '## End State', 'x', '', '## Variables', '- PP_EVIL (required) — path under test', ''].join('\n'),
  );
  writeFileSync(
    join(w.steps, '01-evil.md'),
    scriptStepMd({ script: '${PP_EVIL}', stepId: 'evil', next: 'Pipeline complete.' }),
  );

  inProject(w, () =>
    withPPEnv({}, () => {
      const res = invokeNext({
        root: w.root,
        runId: 'rv2',
        cliVars: { PP_EVIL: '../../../../evil.js' },
      });
      // Halt path idiom (see the §6.3 ladder tests above): the freshly-written
      // feedback file gates the retrospective NOW; the state is already parked
      // halted underneath it.
      expect(res.action.action).toBe('retrospective');
      const st = stateOf(w, 'rv2');
      expect(st.phase).toBe('await-retro');
      expect(st.status).toBe('halted');
      // The T3b refusal is a pre-spawn 'binding' failure — record on disk.
      const failure = readJson(join(w.root, '.runtime', 'rv2', 'failures', 'evil-1-1.json'));
      expect(failure.class).toBe('binding');
      expect(failure.detail).toContain('outside the project root');
      expect(failure.exit_code).toBeNull(); // nothing ever spawned
      // Nothing executed: no outputs persisted.
      expect(existsSync(join(w.root, '.runtime', 'rv2', 'outputs', 'evil.json'))).toBe(false);
    }),
  );
}, 30_000);
