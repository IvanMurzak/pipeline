// Tests for the `type: script` step execution core (src/lib/script-step.ts) —
// DESIGN.md §3 (bindings), §4 (execution contract), §5 (record synthesis +
// `## Next` parse), §6.1–6.2 (classification, failure records, feedback),
// §6.3.1 (transient-only retries), §8 (attempt ledger).
//
// Two spawn strategies, per the T12 task file:
//   - REAL executions use tiny .js fixture scripts (bun-runnable via
//     process.execPath — python may be unavailable on CI) through the real
//     hook-runner supervisor;
//   - a FakeProcessRunner covers the interpreter matrix, failure classes that
//     are awkward to produce for real (spawn ENOENT, 10 MB stdout), and the
//     no-spawn assertions (binding failures, ledger reuse).

import { test, expect, afterEach } from 'bun:test';
import {
  executeScriptStep,
  resolveParams,
  parseScriptStdout,
  parseNextSection,
  classifyFailure,
  mergeChildEnv,
} from '../src/lib/script-step';
import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
  ScriptStepContext,
  BindingSources,
} from '../src/lib/script-step';
import { interpreterFor } from '../src/lib/hooks';
import { STDOUT_CAP_BYTES } from '../src/lib/script-types';
import type { ScriptParamSpec, ScriptStepSpec } from '../src/lib/script-types';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
// World scaffolding
// ---------------------------------------------------------------------------

interface World {
  pipelineRoot: string;
  projectRoot: string;
  iterationPath: string;
  nextAbs: string;
}

function mkWorld(nextContent?: string): World {
  const pipelineRoot = mkTmp('sstep-pipe-');
  const projectRoot = mkTmp('sstep-proj-');
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  mkdirSync(join(pipelineRoot, 'scripts'), { recursive: true });
  const iterationPath = join(pipelineRoot, 'steps', '01-wait-ci.md');
  const nextAbs = join(pipelineRoot, 'steps', '02-deploy.md');
  writeFileSync(
    iterationPath,
    [
      '---',
      'type: script',
      'script: scripts/step.js',
      'step_id: wait-ci',
      '---',
      '# Wait for CI',
      '',
      '## Goal',
      'Wait until CI is green.',
      '',
      '## Success Criteria',
      '- CI green.',
      '',
      '## Next',
      nextContent ?? nextAbs,
      '',
    ].join('\n'),
    'utf8',
  );
  return { pipelineRoot, projectRoot, iterationPath, nextAbs };
}

function writeScript(world: World, name: string, content: string): string {
  const p = join(world.pipelineRoot, 'scripts', name);
  writeFileSync(p, content, 'utf8');
  return p;
}

function mkCtx(world: World, over: Partial<ScriptStepContext> = {}): ScriptStepContext {
  return {
    runId: 'run-1',
    stepId: 'wait-ci',
    dispatchIndex: 1,
    pipelineRoot: world.pipelineRoot,
    projectRoot: world.projectRoot,
    readOutput: () => null,
    deadlineMs: 60_000,
    ...over,
  };
}

function mkSpec(over: Partial<ScriptStepSpec> = {}): ScriptStepSpec {
  return {
    script: 'scripts/step.js',
    command: null,
    timeoutS: 30,
    retries: 0,
    onFailure: 'halt',
    params: null,
    output: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// FakeProcessRunner
// ---------------------------------------------------------------------------

interface Fake {
  runner: ProcessRunner;
  calls: { argv: string[]; opts: ProcessRunOptions }[];
}

/** Returns results in order; the last one repeats when calls exceed it. */
function fakeRunner(results: ProcessRunResult[]): Fake {
  const calls: Fake['calls'] = [];
  const runner: ProcessRunner = (argv, opts) => {
    calls.push({ argv, opts });
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  return { runner, calls };
}

function okRun(result: unknown = { ok: true }): ProcessRunResult {
  return { code: 0, stdout: JSON.stringify(result) + '\n', stderr: '', timedOut: false };
}

const TRANSIENT_RUN: ProcessRunResult = {
  code: 0,
  stdout: JSON.stringify({ ok: false, error: { class: 'transient', detail: 'network blip' } }) + '\n',
  stderr: '',
  timedOut: false,
};

// ---------------------------------------------------------------------------
// Fixture scripts (plain JS — bun runs them via process.execPath)
// ---------------------------------------------------------------------------

const HAPPY_SCRIPT = `
const fs = require('fs');
const path = require('path');
const env = {};
for (const k of Object.keys(process.env)) if (k.startsWith('PIPELINE_STEP_')) env[k] = process.env[k];
const params = JSON.parse(fs.readFileSync(process.env.PIPELINE_STEP_PARAMS_FILE, 'utf8'));
fs.writeFileSync(path.join(process.env.PIPELINE_STEP_PIPELINE_ROOT, 'dump.json'), JSON.stringify({ env, cwd: process.cwd(), params }));
console.log('log noise before the result');
console.log(JSON.stringify({ ok: true, summary: 'CI green', flags: { ci_green: true }, output: { pr_number: 132, tag: params.tag } }));
`;

const CRASH_SCRIPT = `
process.stderr.write('segfault-ish boom\\n');
process.exit(3);
`;

const GARBAGE_SCRIPT = `
console.log('definitely not json');
process.exit(0);
`;

const BUG_SCRIPT = `
console.log(JSON.stringify({ ok: false, error: { class: 'bug', detail: 'null deref in parser' } }));
`;

const FLAKY_SCRIPT = `
const fs = require('fs');
const path = require('path');
const marker = path.join(process.env.PIPELINE_STEP_PIPELINE_ROOT, 'flaky-marker');
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1');
  console.log(JSON.stringify({ ok: false, error: { class: 'transient', detail: 'network blip' } }));
} else {
  console.log(JSON.stringify({ ok: true, summary: 'second time lucky', output: { attempt: 2 } }));
}
`;

const SLEEP_SCRIPT = `
setTimeout(() => { console.log(JSON.stringify({ ok: true })); }, 30000);
`;

const WT_DUMP_SCRIPT = `
const fs = require('fs');
const path = require('path');
const keys = ['FOO', 'QUOTED', 'EXPORTED', 'PIPELINE_STEP_WORKTREE_PATH', 'PIPELINE_STEP_WORKTREE_ENV_FILE'];
const dump = { cwd: process.cwd() };
for (const k of keys) dump[k] = process.env[k] ?? null;
fs.writeFileSync(path.join(process.env.PIPELINE_STEP_PIPELINE_ROOT, 'wt-dump.json'), JSON.stringify(dump));
console.log(JSON.stringify({ ok: true }));
`;

// ---------------------------------------------------------------------------
// Happy path (REAL spawn): flags/output/next, params file, env contract, ledger
// ---------------------------------------------------------------------------

test('happy path: record, flags, output, next_iteration, params file, PIPELINE_STEP_* env, ledger finished', () => {
  const world = mkWorld();
  writeScript(world, 'step.js', HAPPY_SCRIPT);
  const spec = mkSpec({ params: { tag: { type: 'string', value: 'v1.2.3' } } });
  const ctx = mkCtx(world);

  const res = executeScriptStep(spec, world.iterationPath, ctx);

  expect(res.failure).toBeNull();
  expect(res.feedback).toBeNull();
  expect(res.ledgerReused).toBe(false);
  expect(res.attempts).toBe(1);
  expect(res.record.kind).toBe('step');
  expect(res.record.outcome).toBe('completed');
  expect(res.record.summary).toBe('CI green');
  expect(res.record.flags).toEqual({ ci_green: true });
  expect(res.record.output).toEqual({ pr_number: 132, tag: 'v1.2.3' });
  expect(res.record.next_iteration).toBe(world.nextAbs);

  // Params file: resolved params at <pipeline>/.runtime/<run>/params/<step>.json
  const expectedParamsFile = join(world.pipelineRoot, '.runtime', 'run-1', 'params', 'wait-ci.json');
  expect(res.paramsFile).toBe(expectedParamsFile);
  expect(JSON.parse(readFileSync(expectedParamsFile, 'utf8'))).toEqual({ tag: 'v1.2.3' });

  // The script saw the frozen env contract + ran with cwd = project root.
  const dump = JSON.parse(readFileSync(join(world.pipelineRoot, 'dump.json'), 'utf8'));
  expect(dump.env.PIPELINE_STEP_RUN_ID).toBe('run-1');
  expect(dump.env.PIPELINE_STEP_ID).toBe('wait-ci');
  expect(dump.env.PIPELINE_STEP_INDEX).toBe('1');
  expect(dump.env.PIPELINE_STEP_PIPELINE_ROOT).toBe(world.pipelineRoot);
  expect(dump.env.PIPELINE_STEP_PROJECT_ROOT).toBe(world.projectRoot);
  expect(dump.env.PIPELINE_STEP_PARAMS_FILE).toBe(expectedParamsFile);
  expect(dump.env.PIPELINE_STEP_WORKTREE_PATH).toBeUndefined();
  expect(realpathSync(dump.cwd)).toBe(realpathSync(world.projectRoot));
  expect(dump.params).toEqual({ tag: 'v1.2.3' });

  // Ledger flipped to finished with the stored record.
  const ledger = JSON.parse(readFileSync(join(world.pipelineRoot, '.runtime', 'run-1', 'ledger', 'wait-ci-1.json'), 'utf8'));
  expect(ledger.phase).toBe('finished');
  expect(ledger.record.outcome).toBe('completed');
  expect(ledger.output).toEqual({ pr_number: 132, tag: 'v1.2.3' });
});

test('command: argv steps execute for real too', () => {
  const world = mkWorld();
  const cmdScript = writeScript(world, 'cmd.js', 'console.log(JSON.stringify({ ok: true, output: { via: "command" } }));');
  const spec = mkSpec({ script: null, command: [process.execPath, cmdScript] });
  const res = executeScriptStep(spec, world.iterationPath, mkCtx(world));
  expect(res.record.outcome).toBe('completed');
  expect(res.record.output).toEqual({ via: 'command' });
});

// ---------------------------------------------------------------------------
// Failure classes — one named test each (§6.1)
// ---------------------------------------------------------------------------

test('failure class: crash (REAL — exit != 0, no JSON) writes failure record + .log', () => {
  const world = mkWorld();
  writeScript(world, 'step.js', CRASH_SCRIPT);
  const res = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world));

  expect(res.record.outcome).toBe('halted');
  expect(res.failure!.class).toBe('crash');
  expect(res.failure!.exit_code).toBe(3);
  expect(res.failure!.timed_out).toBe(false);
  expect(res.failure!.stderr_tail).toContain('segfault-ish boom');
  expect(res.record.halt_reason).toStartWith('script step wait-ci failed (crash):');
  expect(res.feedback!.category).toBe('script-failure');

  // §6.2.1 — record + sibling .log on disk, keyed <step>-<dispatch>-<attempt>
  const recPath = join(world.pipelineRoot, '.runtime', 'run-1', 'failures', 'wait-ci-1-1.json');
  expect(res.failurePath).toBe(recPath);
  const rec = JSON.parse(readFileSync(recPath, 'utf8'));
  expect(rec.class).toBe('crash');
  expect(rec.step_id).toBe('wait-ci');
  expect(rec.attempt).toBe(1);
  expect(rec.dispatch_index).toBe(1);
  expect(readFileSync(recPath.replace(/\.json$/, '.log'), 'utf8')).toContain('segfault-ish boom');
});

test('failure class: contract (REAL — exit 0 with unparseable stdout)', () => {
  const world = mkWorld();
  writeScript(world, 'step.js', GARBAGE_SCRIPT);
  const res = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world));
  expect(res.failure!.class).toBe('contract');
  expect(res.feedback!.category).toBe('script-failure');
});

test('failure class: bug (REAL — ok:false self-classified bug)', () => {
  const world = mkWorld();
  writeScript(world, 'step.js', BUG_SCRIPT);
  const res = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world));
  expect(res.failure!.class).toBe('bug');
  expect(res.failure!.detail).toBe('null deref in parser');
  expect(res.record.halt_reason).toBe('script step wait-ci failed (bug): null deref in parser');
  expect(res.feedback!.category).toBe('script-failure');
});

test('failure class: transient (REAL — CLI-enforced timeout kills the tree)', () => {
  const world = mkWorld();
  writeScript(world, 'step.js', SLEEP_SCRIPT);
  const res = executeScriptStep(mkSpec({ timeoutS: 1 }), world.iterationPath, mkCtx(world));
  expect(res.failure!.class).toBe('transient');
  expect(res.failure!.timed_out).toBe(true);
  expect(res.feedback!.category).toBe('friction');
});

test('failure class: env (REAL — command binary does not exist)', () => {
  const world = mkWorld();
  const spec = mkSpec({ script: null, command: ['definitely-missing-binary-77asdf'] });
  const res = executeScriptStep(spec, world.iterationPath, mkCtx(world));
  expect(res.failure!.class).toBe('env');
  expect(res.feedback!.category).toBe('env');
});

test('failure class: env (fake — interpreter ENOENT surfaces as spawn error)', () => {
  const world = mkWorld();
  const fake = fakeRunner([{ code: null, stdout: '', stderr: '', timedOut: false, error: 'spawn python3 ENOENT' }]);
  const res = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  expect(res.failure!.class).toBe('env');
  expect(res.failure!.exit_code).toBeNull();
  expect(res.failure!.detail).toContain('ENOENT');
});

test('failure class: binding (required param unresolvable — NO spawn happens)', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const spec = mkSpec({
    params: { pr_number: { type: 'number', required: true, from: '${steps.create-pr.output.pr_number}' } },
  });
  const res = executeScriptStep(spec, world.iterationPath, mkCtx(world, { runner: fake.runner }));

  expect(fake.calls.length).toBe(0); // §3.1 — binding fails BEFORE the script spawns
  expect(res.failure!.class).toBe('binding');
  expect(res.failure!.params_file).toBeNull();
  expect(res.attempts).toBe(0);
  expect(res.feedback!.category).toBe('doc-flaw');
  expect(res.record.outcome).toBe('halted');
  expect(res.record.halt_reason).toContain("required param 'pr_number' has no resolvable value");
  // Failure record still lands on disk (§6.2 runs before any policy).
  expect(existsSync(join(world.pipelineRoot, '.runtime', 'run-1', 'failures', 'wait-ci-1-1.json'))).toBe(true);
});

test('failure class: bug when ok:false carries no error class', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun({ ok: false, summary: 'gave up' })]);
  const res = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  expect(res.failure!.class).toBe('bug');
  expect(res.failure!.detail).toBe('gave up');
});

test('failure class: contract on stdout above the 10 MB cap', () => {
  const world = mkWorld();
  const fake = fakeRunner([{ code: 0, stdout: 'x'.repeat(STDOUT_CAP_BYTES + 16), stderr: '', timedOut: false }]);
  const res = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  expect(res.failure!.class).toBe('contract');
  expect(res.failure!.detail).toContain('cap');
});

test('failure class: contract on ## Output declaration violation', () => {
  const world = mkWorld();
  const outputDecl = { pr_number: { type: 'number' as const, required: true } };

  // wrong type
  const f1 = fakeRunner([okRun({ ok: true, output: { pr_number: 'not-a-number' } })]);
  const r1 = executeScriptStep(mkSpec({ output: outputDecl }), world.iterationPath, mkCtx(world, { runner: f1.runner }));
  expect(r1.failure!.class).toBe('contract');
  expect(r1.failure!.detail).toContain("output field 'pr_number'");

  // missing required field (fresh dispatch index — the ledger keeps attempts apart)
  const f2 = fakeRunner([okRun({ ok: true, output: {} })]);
  const r2 = executeScriptStep(
    mkSpec({ output: outputDecl }),
    world.iterationPath,
    mkCtx(world, { runner: f2.runner, dispatchIndex: 2 }),
  );
  expect(r2.failure!.class).toBe('contract');
  expect(r2.failure!.detail).toContain("missing required output field 'pr_number'");

  // conformant output passes
  const f3 = fakeRunner([okRun({ ok: true, output: { pr_number: 7 } })]);
  const r3 = executeScriptStep(
    mkSpec({ output: outputDecl }),
    world.iterationPath,
    mkCtx(world, { runner: f3.runner, dispatchIndex: 3 }),
  );
  expect(r3.record.outcome).toBe('completed');
});

// ---------------------------------------------------------------------------
// Retries (§6.3.1) — transient ONLY
// ---------------------------------------------------------------------------

test('retries: transient failure re-runs mechanically and succeeds (REAL)', () => {
  const world = mkWorld();
  writeScript(world, 'step.js', FLAKY_SCRIPT);
  const res = executeScriptStep(mkSpec({ retries: 2 }), world.iterationPath, mkCtx(world));

  expect(res.record.outcome).toBe('completed');
  expect(res.attempts).toBe(2);
  expect(res.failure).toBeNull();
  expect(res.record.output).toEqual({ attempt: 2 });
  // The failed attempt still left its §6.2.1 record + log on disk.
  const rec1 = join(world.pipelineRoot, '.runtime', 'run-1', 'failures', 'wait-ci-1-1.json');
  expect(JSON.parse(readFileSync(rec1, 'utf8')).class).toBe('transient');
  expect(existsSync(rec1.replace(/\.json$/, '.log'))).toBe(true);
});

test('retries: budget exhausted after retries — every attempt has a failure record', () => {
  const world = mkWorld();
  const fake = fakeRunner([TRANSIENT_RUN]);
  const res = executeScriptStep(mkSpec({ retries: 2 }), world.iterationPath, mkCtx(world, { runner: fake.runner }));

  expect(fake.calls.length).toBe(3);
  expect(res.attempts).toBe(3);
  expect(res.failure!.class).toBe('transient');
  expect(res.failure!.attempt).toBe(3);
  expect(res.feedback!.category).toBe('friction');
  for (const n of [1, 2, 3]) {
    expect(existsSync(join(world.pipelineRoot, '.runtime', 'run-1', 'failures', `wait-ci-1-${n}.json`))).toBe(true);
  }
});

test('retries: NOT applied to non-transient classes', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun({ ok: false, error: { class: 'bug', detail: 'always broken' } })]);
  const res = executeScriptStep(mkSpec({ retries: 3 }), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  expect(fake.calls.length).toBe(1);
  expect(res.attempts).toBe(1);
  expect(res.failure!.class).toBe('bug');
});

// ---------------------------------------------------------------------------
// Attempt ledger (§8)
// ---------------------------------------------------------------------------

test('ledger: finished entry is reused — the script is NEVER re-executed', () => {
  const world = mkWorld();
  const f1 = fakeRunner([okRun({ ok: true, summary: 'done once', output: { n: 1 } })]);
  const r1 = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: f1.runner }));
  expect(r1.ledgerReused).toBe(false);

  // Re-dispatch of the SAME (step_id, dispatch_index): stored record returned.
  const f2 = fakeRunner([{ code: 1, stdout: '', stderr: 'would fail', timedOut: false }]);
  const r2 = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: f2.runner }));
  expect(f2.calls.length).toBe(0);
  expect(r2.ledgerReused).toBe(true);
  expect(r2.attempts).toBe(0);
  expect(r2.record).toEqual(r1.record);
  expect(r2.failure).toBeNull();
});

test('ledger: a graph loop-back (new dispatch_index) re-executes', () => {
  const world = mkWorld();
  const f1 = fakeRunner([okRun({ ok: true, output: { n: 1 } })]);
  executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: f1.runner, dispatchIndex: 1 }));

  const f2 = fakeRunner([okRun({ ok: true, output: { n: 2 } })]);
  const r2 = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: f2.runner, dispatchIndex: 2 }));
  expect(f2.calls.length).toBe(1);
  expect(r2.ledgerReused).toBe(false);
  expect(r2.record.output).toEqual({ n: 2 });
});

test('failure records: a graph loop-back (new dispatch_index) does NOT overwrite earlier failure evidence', () => {
  const world = mkWorld();
  const f1 = fakeRunner([{ code: 2, stdout: '', stderr: 'first boom', timedOut: false }]);
  const r1 = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: f1.runner, dispatchIndex: 1 }));
  const f2 = fakeRunner([{ code: 2, stdout: '', stderr: 'second boom', timedOut: false }]);
  const r2 = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: f2.runner, dispatchIndex: 2 }));

  const dir = join(world.pipelineRoot, '.runtime', 'run-1', 'failures');
  expect(r1.failurePath).toBe(join(dir, 'wait-ci-1-1.json'));
  expect(r2.failurePath).toBe(join(dir, 'wait-ci-2-1.json'));
  // Both executions' evidence survives side by side (.json + sibling .log).
  expect(JSON.parse(readFileSync(join(dir, 'wait-ci-1-1.json'), 'utf8')).dispatch_index).toBe(1);
  expect(JSON.parse(readFileSync(join(dir, 'wait-ci-2-1.json'), 'utf8')).dispatch_index).toBe(2);
  expect(readFileSync(join(dir, 'wait-ci-1-1.log'), 'utf8')).toContain('first boom');
  expect(readFileSync(join(dir, 'wait-ci-2-1.log'), 'utf8')).toContain('second boom');
});

test('ledger: writes are atomic (no .tmp residue)', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun({ ok: true, output: { n: 1 } })]);
  executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: fake.runner }));

  const ledgerPath = join(world.pipelineRoot, '.runtime', 'run-1', 'ledger', 'wait-ci-1.json');
  expect(existsSync(ledgerPath)).toBe(true);
  expect(existsSync(ledgerPath + '.tmp')).toBe(false); // rename landed — no temp residue
  expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).phase).toBe('finished');
});

test('onExecute: fires exactly ONCE per real execution — not per retry attempt', () => {
  const world = mkWorld();
  const fake = fakeRunner([TRANSIENT_RUN]); // transient every attempt
  let fired = 0;
  const res = executeScriptStep(
    mkSpec({ retries: 2 }),
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, onExecute: () => fired++ }),
  );
  expect(res.attempts).toBe(3); // three attempts really ran…
  expect(fired).toBe(1); // …but the seam fired once
});

test('onExecute: fires on an execution that dies at binding resolution (before any spawn)', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  let fired = 0;
  const spec = mkSpec({
    params: { pr_number: { type: 'number', required: true, from: '${steps.create-pr.output.pr_number}' } },
  });
  const res = executeScriptStep(spec, world.iterationPath, mkCtx(world, { runner: fake.runner, onExecute: () => fired++ }));
  expect(fake.calls.length).toBe(0);
  expect(res.failure!.class).toBe('binding');
  expect(fired).toBe(1);
});

test('onExecute: does NOT fire on ledger reuse', () => {
  const world = mkWorld();
  const f1 = fakeRunner([okRun({ ok: true, output: { n: 1 } })]);
  executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: f1.runner }));

  const f2 = fakeRunner([okRun()]);
  let fired = 0;
  const res = executeScriptStep(
    mkSpec(),
    world.iterationPath,
    mkCtx(world, { runner: f2.runner, onExecute: () => fired++ }),
  );
  expect(res.ledgerReused).toBe(true);
  expect(fired).toBe(0);
});

test('ledger: a stale started entry (previous attempt died mid-flight) re-executes', () => {
  const world = mkWorld();
  const ledgerPath = join(world.pipelineRoot, '.runtime', 'run-1', 'ledger', 'wait-ci-1.json');
  mkdirSync(join(world.pipelineRoot, '.runtime', 'run-1', 'ledger'), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({ step_id: 'wait-ci', dispatch_index: 1, phase: 'started' }), 'utf8');

  const fake = fakeRunner([okRun({ ok: true, output: { recovered: true } })]);
  const res = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  expect(fake.calls.length).toBe(1);
  expect(res.ledgerReused).toBe(false);
  expect(res.record.output).toEqual({ recovered: true });
  expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).phase).toBe('finished');
});

// ---------------------------------------------------------------------------
// Worktree cwd + env-file parsing (§4)
// ---------------------------------------------------------------------------

test('external isolation: cwd = worktree, env file parsed KEY=VALUE (never sourced), worktree env vars set (REAL)', () => {
  const world = mkWorld();
  writeScript(world, 'step.js', WT_DUMP_SCRIPT);
  const worktree = mkTmp('sstep-wt-');
  const envFile = join(worktree, '.worktree.env');
  writeFileSync(envFile, ['# a comment', 'FOO=bar', 'QUOTED="q v"', 'export EXPORTED=e1', '', 'BROKEN-LINE'].join('\n'), 'utf8');

  const res = executeScriptStep(
    mkSpec(),
    world.iterationPath,
    mkCtx(world, { worktreePath: worktree, worktreeEnvFile: envFile }),
  );
  expect(res.record.outcome).toBe('completed');

  const dump = JSON.parse(readFileSync(join(world.pipelineRoot, 'wt-dump.json'), 'utf8'));
  expect(realpathSync(dump.cwd)).toBe(realpathSync(worktree));
  expect(dump.FOO).toBe('bar');
  expect(dump.QUOTED).toBe('q v');
  expect(dump.EXPORTED).toBe('e1');
  expect(dump.PIPELINE_STEP_WORKTREE_PATH).toBe(worktree);
  expect(dump.PIPELINE_STEP_WORKTREE_ENV_FILE).toBe(envFile);
});

test('external isolation: unreadable env file is a pre-spawn env failure', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(
    mkSpec(),
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, worktreePath: world.projectRoot, worktreeEnvFile: join(world.projectRoot, 'no-such.env') }),
  );
  expect(fake.calls.length).toBe(0);
  expect(res.failure!.class).toBe('env');
});

// ---------------------------------------------------------------------------
// Oversized output (§10 persist cap) — success, but output dropped
// ---------------------------------------------------------------------------

test('oversized output: step succeeds, output is dropped with a warning, ledger stores null', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun({ ok: true, output: { blob: 'y'.repeat(70 * 1024) } })]);
  const res = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  expect(res.record.outcome).toBe('completed');
  expect(res.record.output).toBeNull();
  expect(res.warnings.some((w) => w.includes('persist cap'))).toBe(true);
  const ledger = JSON.parse(readFileSync(join(world.pipelineRoot, '.runtime', 'run-1', 'ledger', 'wait-ci-1.json'), 'utf8'));
  expect(ledger.output).toBeNull();
});

// ---------------------------------------------------------------------------
// Interpreter matrix + argv/timeout plumbing (FakeProcessRunner)
// ---------------------------------------------------------------------------

test('interpreter matrix: argv follows the lib/hooks.ts ladder per extension', () => {
  const world = mkWorld();
  const names = ['x.py', 'x.sh', 'x.ps1', 'x.js', 'x.ts', 'plain'];
  names.forEach((name, i) => {
    const fake = fakeRunner([okRun()]);
    const spec = mkSpec({ script: `scripts/${name}` });
    // unique dispatchIndex per case — the success ledger would otherwise
    // short-circuit later iterations into a reuse
    executeScriptStep(spec, world.iterationPath, mkCtx(world, { runner: fake.runner, dispatchIndex: 100 + i }));
    const abs = join(world.pipelineRoot, 'scripts', name);
    const exp = interpreterFor(abs);
    expect(fake.calls[0].argv).toEqual(exp.args.length > 0 ? [exp.cmd, ...exp.args] : [exp.cmd]);
  });
});

test('command argv passes through verbatim; timeout honors min(spec.timeoutS, deadline)', () => {
  const world = mkWorld();
  const f1 = fakeRunner([okRun()]);
  executeScriptStep(
    mkSpec({ script: null, command: ['gh', 'run', 'list'], timeoutS: 2 }),
    world.iterationPath,
    mkCtx(world, { runner: f1.runner, deadlineMs: 60_000 }),
  );
  expect(f1.calls[0].argv).toEqual(['gh', 'run', 'list']);
  expect(f1.calls[0].opts.timeoutMs).toBe(2000);
  expect(f1.calls[0].opts.cwd).toBe(world.projectRoot);

  const f2 = fakeRunner([okRun()]);
  executeScriptStep(
    mkSpec({ script: null, command: ['gh'], timeoutS: 600 }),
    world.iterationPath,
    mkCtx(world, { runner: f2.runner, deadlineMs: 5_000, dispatchIndex: 2 }),
  );
  expect(f2.calls[0].opts.timeoutMs).toBeLessThanOrEqual(5_000);
});

test('spec with neither script nor command degrades to a binding failure', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(mkSpec({ script: null, command: null }), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  expect(fake.calls.length).toBe(0);
  expect(res.failure!.class).toBe('binding');
});

// ---------------------------------------------------------------------------
// Feedback draft shape (§6.2.2 — Tier-2 problem-file format)
// ---------------------------------------------------------------------------

test('feedback body matches the Tier-2 problem-file shape', () => {
  const world = mkWorld();
  const fake = fakeRunner([{ code: 2, stdout: '', stderr: 'stack trace here', timedOut: false }]);
  const res = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  const body = res.feedback!.body;
  expect(body.startsWith('---\ncategory: script-failure\n')).toBe(true);
  expect(body).toContain(`iteration: ${world.iterationPath}`);
  expect(body).toContain('step_id: wait-ci');
  expect(body).toContain('## Problem');
  expect(body).toContain('## Evidence');
  expect(body).toContain('## Suggested fix');
  expect(body).toContain(res.failurePath!);
});

// ---------------------------------------------------------------------------
// resolveParams (§3.1–3.2)
// ---------------------------------------------------------------------------

function bindCtx(over: Partial<BindingSources> = {}): BindingSources {
  return {
    runId: 'run-9',
    pipelineRoot: '/pipe/root',
    projectRoot: '/proj/root',
    readOutput: () => null,
    env: {},
    ...over,
  };
}

test('resolveParams: precedence from → value → default; optional unresolved params are omitted', () => {
  const ctx = bindCtx({
    readOutput: (id) => (id === 'build' ? { sha: 'abc123', count: 42 } : null),
  });
  const r = resolveParams(
    {
      sha: { type: 'string', from: '${steps.build.output.sha}', default: 'nope' },
      fallback: { type: 'string', from: '${steps.missing.output.x}', default: 'used-default' },
      lit: { type: 'array', value: ['a', 'b'] },
      omitted: { type: 'string', from: '${steps.missing.output.y}' },
    },
    ctx,
  );
  expect(r).toEqual({ ok: true, params: { sha: 'abc123', fallback: 'used-default', lit: ['a', 'b'] } });
});

test('resolveParams: a single-ref from keeps the JSON type; a mixed template interpolates to string', () => {
  const ctx = bindCtx({ readOutput: () => ({ pr_number: 132, labels: ['x'] }) });
  const r = resolveParams(
    {
      pr: { type: 'number', from: '${steps.create-pr.output.pr_number}' },
      labels: { type: 'array', from: '${steps.create-pr.output.labels}' },
      msg: { type: 'string', from: 'PR #${steps.create-pr.output.pr_number} of ${run.id}' },
    },
    ctx,
  );
  expect(r).toEqual({ ok: true, params: { pr: 132, labels: ['x'], msg: 'PR #132 of run-9' } });
});

test('resolveParams: run/pipeline/project/worktree/env references', () => {
  const ctx = bindCtx({
    taskText: 'do the thing',
    worktreePath: '/wt/path',
    worktreeEnvFile: '/wt/.env',
    env: { CI_PROVIDER: 'gh' },
  });
  const r = resolveParams(
    {
      id: { type: 'string', from: '${run.id}' },
      task: { type: 'string', from: '${run.task}' },
      pipe: { type: 'string', from: '${pipeline.root}' },
      proj: { type: 'string', from: '${project.root}' },
      wt: { type: 'string', from: '${worktree.path}' },
      wtenv: { type: 'string', from: '${worktree.env_file}' },
      prov: { type: 'string', from: '${env.CI_PROVIDER}' },
    },
    ctx,
  );
  expect(r).toEqual({
    ok: true,
    params: {
      id: 'run-9',
      task: 'do the thing',
      pipe: '/pipe/root',
      proj: '/proj/root',
      wt: '/wt/path',
      wtenv: '/wt/.env',
      prov: 'gh',
    },
  });
});

test('resolveParams: null task / unset env / absent worktree fall down the ladder (binding when required)', () => {
  const ctx = bindCtx(); // no taskText, no worktree, empty env
  const ok = resolveParams(
    {
      task: { type: 'string', from: '${run.task}', default: 'no-task' },
      wt: { type: 'string', from: '${worktree.path}', default: 'in-place' },
    },
    ctx,
  );
  expect(ok).toEqual({ ok: true, params: { task: 'no-task', wt: 'in-place' } });

  const bad = resolveParams({ home: { type: 'string', required: true, from: '${env.NOT_SET_XYZ}' } }, ctx);
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.detail).toContain("required param 'home'");
});

test('resolveParams: malformed/unknown references are hard binding failures even with a default', () => {
  const r1 = resolveParams({ x: { type: 'string', from: '${bogus.thing}', default: 'd' } }, bindCtx());
  expect(r1.ok).toBe(false);
  if (!r1.ok) expect(r1.detail).toContain('unknown binding reference');

  const r2 = resolveParams({ x: { type: 'string', from: '${steps.build.sha}', default: 'd' } }, bindCtx());
  expect(r2.ok).toBe(false);
  if (!r2.ok) expect(r2.detail).toContain('malformed reference');
});

test('resolveParams: strict types — env strings do NOT coerce to number; enum enforced', () => {
  const ctx = bindCtx({ env: { PR: '132' } });
  const r1 = resolveParams({ pr: { type: 'number', from: '${env.PR}' } }, ctx);
  expect(r1.ok).toBe(false);
  if (!r1.ok) expect(r1.detail).toContain("expected number");

  const r2 = resolveParams({ mode: { type: 'string', value: 'purple', enum: ['red', 'green'] } }, bindCtx());
  expect(r2.ok).toBe(false);
  if (!r2.ok) expect(r2.detail).toContain('enum');

  const r3 = resolveParams({ mode: { type: 'string', value: 'red', enum: ['red', 'green'] } }, bindCtx());
  expect(r3).toEqual({ ok: true, params: { mode: 'red' } });
});

test('resolveParams: a param named __proto__ lands as an OWN key — no prototype pollution, no silent drop', () => {
  // Computed key — a literal '__proto__' key in an object literal would hit
  // the prototype setter in the TEST itself.
  const specs: Record<string, ScriptParamSpec> = { ['__proto__']: { type: 'object', required: true, value: { polluted: true } } };
  const r = resolveParams(specs, bindCtx());
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(Object.hasOwn(r.params, '__proto__')).toBe(true);
    expect(r.params['__proto__']).toEqual({ polluted: true });
    // It reaches the params-file payload…
    expect(JSON.stringify(r.params)).toContain('"__proto__"');
  }
  // …and the shared Object prototype was NOT mutated.
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test('resolveParams: inherited keys (__proto__/constructor/toString) do NOT resolve from step outputs', () => {
  const ctx = bindCtx({ readOutput: () => ({ real: 1 }) });
  for (const key of ['__proto__', 'constructor', 'toString']) {
    const r = resolveParams({ x: { type: 'object', required: true, from: `\${steps.s.output.${key}}` } }, ctx);
    expect(r.ok).toBe(false);
    // 'unavailable' (not a type mismatch on the inherited value) ⇒ the
    // required-param ladder bottomed out.
    if (!r.ok) expect(r.detail).toContain("required param 'x' has no resolvable value");
  }
  // An OWN key named __proto__ in the output still resolves.
  const own = Object.create(null) as Record<string, unknown>;
  own['__proto__'] = { legit: true };
  const r2 = resolveParams({ x: { type: 'object', from: '${steps.s.output.__proto__}' } }, bindCtx({ readOutput: () => own }));
  expect(r2.ok).toBe(true);
  if (r2.ok) expect(r2.params.x).toEqual({ legit: true });
});

test('resolveParams: a non-array enum declaration is a binding problem, not a crash', () => {
  const specs: Record<string, ScriptParamSpec> = {
    mode: { type: 'string', value: 'prod', enum: 'prod|staging' as unknown as (string | number)[] },
  };
  const r = resolveParams(specs, bindCtx());
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.detail).toContain('non-array enum');

  // End-to-end: class 'binding', pre-spawn (no execution, halt record intact).
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(mkSpec({ params: specs }), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  expect(fake.calls.length).toBe(0);
  expect(res.failure!.class).toBe('binding');
  expect(res.record.outcome).toBe('halted');
});

test('resolveParams: overrides (the step-run --param seam) win over from/value/default', () => {
  const ctx = bindCtx({ readOutput: () => ({ n: 1 }) });
  const r = resolveParams(
    { n: { type: 'number', from: '${steps.s.output.n}', default: 9 } },
    ctx,
    { n: 55 },
  );
  expect(r).toEqual({ ok: true, params: { n: 55 } });
});

test('resolveParams: null/absent spec resolves to an empty params object', () => {
  expect(resolveParams(null, bindCtx())).toEqual({ ok: true, params: {} });
});

// ---------------------------------------------------------------------------
// parseScriptStdout (§4)
// ---------------------------------------------------------------------------

test('parseScriptStdout: last JSON-object line wins over earlier ones and noise', () => {
  const out = ['starting…', JSON.stringify({ ok: false }), 'more noise', JSON.stringify({ ok: true, summary: 'final' })].join('\n');
  const r = parseScriptStdout(out);
  expect(r.result).toEqual({ ok: true, summary: 'final' });
});

test('parseScriptStdout: whole-stdout fallback parses a pretty-printed object', () => {
  const out = JSON.stringify({ ok: true, output: { a: 1 } }, null, 2);
  const r = parseScriptStdout(out);
  expect(r.result!.ok).toBe(true);
  expect(r.result!.output).toEqual({ a: 1 });
});

test('parseScriptStdout: garbage / arrays / missing ok all fail with a detail', () => {
  expect(parseScriptStdout('not json at all').result).toBeNull();
  expect(parseScriptStdout('[1,2,3]').result).toBeNull();
  const noOk = parseScriptStdout(JSON.stringify({ summary: 'no ok field' }));
  expect(noOk.result).toBeNull();
  expect(noOk.detail).toContain("'ok'");
});

// ---------------------------------------------------------------------------
// classifyFailure (§6.1)
// ---------------------------------------------------------------------------

test('classifyFailure: the full mechanical matrix', () => {
  const base = { stdout: '', stderr: '', timedOut: false };
  expect(classifyFailure({ ...base, code: null, timedOut: true }).class).toBe('transient');
  expect(classifyFailure({ ...base, code: null, error: 'spawn x ENOENT' }).class).toBe('env');
  expect(classifyFailure({ ...base, code: 0, stdout: 'garbage' }).class).toBe('contract');
  expect(classifyFailure({ ...base, code: 2, stdout: 'garbage' }).class).toBe('crash');
  expect(classifyFailure({ ...base, code: 2, stdout: JSON.stringify({ ok: true }) }).class).toBe('crash');
  expect(classifyFailure({ ...base, code: 0, stdout: JSON.stringify({ ok: false, error: { class: 'transient' } }) }).class).toBe('transient');
  expect(classifyFailure({ ...base, code: 0, stdout: JSON.stringify({ ok: false, error: { class: 'env' } }) }).class).toBe('env');
  expect(classifyFailure({ ...base, code: 0, stdout: JSON.stringify({ ok: false, error: { class: 'bug' } }) }).class).toBe('bug');
  expect(classifyFailure({ ...base, code: 0, stdout: JSON.stringify({ ok: false }) }).class).toBe('bug');
  // junk self-classification is NOT trusted — falls back to bug
  expect(classifyFailure({ ...base, code: 0, stdout: JSON.stringify({ ok: false, error: { class: 'weird' } }) }).class).toBe('bug');
  // success
  const okC = classifyFailure({ ...base, code: 0, stdout: JSON.stringify({ ok: true }) });
  expect(okC.ok).toBe(true);
  expect(okC.class).toBeNull();
});

test('classifyFailure: a non-array enum in ## Output is class contract, not a crash', () => {
  const decl: Record<string, ScriptParamSpec> = {
    mode: { type: 'string', enum: 'prod|staging' as unknown as (string | number)[] },
  };
  const c = classifyFailure(
    { code: 0, stdout: JSON.stringify({ ok: true, output: { mode: 'prod' } }), stderr: '', timedOut: false },
    decl,
  );
  expect(c.ok).toBe(false);
  expect(c.class).toBe('contract');
  expect(c.detail).toContain('non-array enum');
});

// ---------------------------------------------------------------------------
// mergeChildEnv — win32 case-insensitive env-key dedup
// ---------------------------------------------------------------------------

test('mergeChildEnv: win32 drops case-variant duplicates of overlay keys; POSIX merges plainly', () => {
  const base = { Path: 'C:\\Windows', HOME: '/h', Keep: 'k' };
  const overlay = { PATH: 'D:\\override', NEW: 'n' };

  const win = mergeChildEnv(base, overlay, 'win32');
  expect(win.PATH).toBe('D:\\override');
  expect(Object.hasOwn(win, 'Path')).toBe(false); // no duplicate case-variant key survives
  expect(win.HOME).toBe('/h');
  expect(win.Keep).toBe('k');
  expect(win.NEW).toBe('n');

  const posix = mergeChildEnv(base, overlay, 'linux');
  expect(posix.Path).toBe('C:\\Windows'); // case-sensitive: both coexist
  expect(posix.PATH).toBe('D:\\override');

  // Same exact spelling needs no delete — the overlay simply wins on win32 too.
  const same = mergeChildEnv({ FOO: 'old', Bar: 'keep' }, { FOO: 'new' }, 'win32');
  expect(same.FOO).toBe('new');
  expect(same.Bar).toBe('keep');
});

// ---------------------------------------------------------------------------
// parseNextSection (§5.2)
// ---------------------------------------------------------------------------

function writeIterationWithNext(nextBlock: string | null): string {
  const dir = mkTmp('sstep-next-');
  const p = join(dir, '01-step.md');
  const sections = ['---', 'type: script', '---', '# T', '', '## Goal', 'g', ''];
  if (nextBlock !== null) sections.push('## Next', nextBlock, '');
  sections.push('## Notes', 'trailing section ignored', '');
  writeFileSync(p, sections.join('\n'), 'utf8');
  return p;
}

test('parseNextSection: single absolute path (plain and backticked)', () => {
  const target = join(tmpdir(), 'steps', '02-x.md');
  expect(parseNextSection(writeIterationWithNext(target))).toEqual({ next: target, error: null });
  expect(parseNextSection(writeIterationWithNext('`' + target + '`'))).toEqual({ next: target, error: null });
});

test('parseNextSection: bulleted forms (the plan-lint grammar) parse — plain, backticked, Pipeline complete.', () => {
  const target = join(tmpdir(), 'steps', '02-x.md');
  expect(parseNextSection(writeIterationWithNext(`- ${target}`))).toEqual({ next: target, error: null });
  expect(parseNextSection(writeIterationWithNext(`* ${target}`))).toEqual({ next: target, error: null });
  expect(parseNextSection(writeIterationWithNext('- `' + target + '`'))).toEqual({ next: target, error: null });
  expect(parseNextSection(writeIterationWithNext('- Pipeline complete.'))).toEqual({ next: 'PIPELINE_COMPLETE', error: null });
});

test('parseNextSection: Pipeline complete. maps to PIPELINE_COMPLETE', () => {
  expect(parseNextSection(writeIterationWithNext('Pipeline complete.'))).toEqual({ next: 'PIPELINE_COMPLETE', error: null });
});

test('parseNextSection: malformed variants return an error (and null next)', () => {
  const multi = parseNextSection(writeIterationWithNext('/a/b.md\n/c/d.md'));
  expect(multi.next).toBeNull();
  expect(multi.error).toContain('exactly one');

  const prose = parseNextSection(writeIterationWithNext('If CI is green go to steps/02.md else stop'));
  expect(prose.next).toBeNull();
  expect(prose.error).toContain('neither an absolute path');

  const relative = parseNextSection(writeIterationWithNext('steps/02-x.md'));
  expect(relative.next).toBeNull();

  const missing = parseNextSection(writeIterationWithNext(null));
  expect(missing.next).toBeNull();
  expect(missing.error).toContain('no ## Next section');

  const unreadable = parseNextSection(join(tmpdir(), 'definitely-not-a-real-file-8877.md'));
  expect(unreadable.next).toBeNull();
  expect(unreadable.error).toContain('cannot read');
});

test('parseNextSection: success record carries PIPELINE_COMPLETE through executeScriptStep', () => {
  const world = mkWorld('Pipeline complete.');
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  expect(res.record.next_iteration).toBe('PIPELINE_COMPLETE');
});

test('parseNextSection: unparseable ## Next on a completed step yields null next + a warning', () => {
  const world = mkWorld('conditional prose, not a path');
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(mkSpec(), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  expect(res.record.outcome).toBe('completed');
  expect(res.record.next_iteration).toBeNull();
  expect(res.warnings.some((w) => w.includes('## Next'))).toBe(true);
});

test('parseNext: false skips the ## Next parse — no warning on a file whose Next is not parseable, next_iteration null', () => {
  // A ## Next that would warn under the default (prose ⇒ not mechanically
  // parseable) stays silent when the caller routes without next_iteration.
  const world = mkWorld('conditional prose, not a path');
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(
    mkSpec(),
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, parseNext: false }),
  );
  expect(res.record.outcome).toBe('completed');
  expect(res.record.next_iteration).toBeNull();
  expect(res.warnings.some((w) => w.includes('## Next'))).toBe(false);
});

// ---------------------------------------------------------------------------
// PP_* variables (env-variables design a4): the Params PP_* binding root (D7),
// argv/`script:` substitution (05 §4), T3b containment, the T3c .bat/.cmd
// carve-out, and the D10 child-env overlay.
// ---------------------------------------------------------------------------

const winOnly = process.platform === 'win32' ? test : test.skip;

// --- resolveParams: the PP_* root (D7/E6) -----------------------------------

test('PP root: a ${PP_X} Params ref resolves from ctx.variables — never the environment', () => {
  const prev = process.env.PP_HIT_TEST;
  process.env.PP_HIT_TEST = 'from-real-env';
  try {
    const r = resolveParams(
      { svc: { type: 'string', from: '${PP_HIT_TEST}' } },
      bindCtx({ variables: { PP_HIT_TEST: 'from-frozen-map' } }),
    );
    expect(r).toEqual({ ok: true, params: { svc: 'from-frozen-map' } });
  } finally {
    if (prev === undefined) delete process.env.PP_HIT_TEST;
    else process.env.PP_HIT_TEST = prev;
  }
});

test('PP root: inline defaults follow POSIX colon semantics (unset; set-but-empty)', () => {
  // Unset: both forms fall back.
  const unset = resolveParams(
    {
      a: { type: 'string', from: '${PP_C:-#releases}' },
      b: { type: 'string', from: '${PP_C-plain}' },
    },
    bindCtx({ variables: {} }),
  );
  expect(unset).toEqual({ ok: true, params: { a: '#releases', b: 'plain' } });
  // Set-but-empty: `:-` swaps the default in, plain `-` keeps the empty.
  const empty = resolveParams(
    {
      a: { type: 'string', from: '${PP_C:-d}' },
      b: { type: 'string', from: '${PP_C-d}' },
      c: { type: 'string', from: '${PP_C}' },
    },
    bindCtx({ variables: { PP_C: '' } }),
  );
  expect(empty).toEqual({ ok: true, params: { a: 'd', b: '', c: '' } });
});

test('PP root: E6 — single-ref position yields a JSON STRING (a numeric-looking value does not become a number)', () => {
  const ctx = bindCtx({ variables: { PP_PORT: '8080' } });
  const asString = resolveParams({ port: { type: 'string', from: '${PP_PORT}' } }, ctx);
  expect(asString).toEqual({ ok: true, params: { port: '8080' } });
  const asNumber = resolveParams({ port: { type: 'number', from: '${PP_PORT}' } }, ctx);
  expect(asNumber.ok).toBe(false);
  if (!asNumber.ok) expect(asNumber.detail).toContain('expected number');
});

test('PP root: a mixed template interpolates PP values alongside other roots', () => {
  const r = resolveParams(
    { msg: { type: 'string', from: 'deploy ${PP_SVC} in ${run.id}' } },
    bindCtx({ variables: { PP_SVC: 'payments' } }),
  );
  expect(r).toEqual({ ok: true, params: { msg: 'deploy payments in run-9' } });
});

test('PP root: unresolved (no frozen value, no inline default) is a HARD binding failure — even with a param default', () => {
  // Invariant post-validateRun: reaching this means the map was not plumbed
  // or the tree drifted — never a silent fall-through to the param default.
  const r = resolveParams(
    { x: { type: 'string', from: '${PP_MISSING}', default: 'd' } },
    bindCtx({ variables: {} }),
  );
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.detail).toContain('PP_MISSING');
    expect(r.detail).toContain('no value and no inline default');
  }
  // ctx WITHOUT a variables map at all (E9 zero-change path): same failure.
  const noMap = resolveParams({ x: { type: 'string', from: '${PP_MISSING}' } }, bindCtx());
  expect(noMap.ok).toBe(false);
});

test('PP root: documented F3 limitation — `$$` is NOT an escape inside a Params template (REF_RE has no `$$` awareness)', () => {
  const r = resolveParams(
    { doc: { type: 'string', from: '$${PP_X}' } },
    bindCtx({ variables: { PP_X: 'v' } }),
  );
  // REF_RE matches the inner ${PP_X}; the leading `$` stays literal text.
  expect(r).toEqual({ ok: true, params: { doc: '$v' } });
});

// --- executeScriptStep: command argv substitution (E2/T3) --------------------

test('T3: a metacharacter value lands as exactly ONE argv element — and an empty value keeps its slot', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const spec = mkSpec({ script: null, command: ['mytool', '--svc', '${PP_SVC}', '${PP_EMPTY}', 'tail'] });
  const res = executeScriptStep(
    spec,
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, variables: { PP_SVC: '; rm -rf /', PP_EMPTY: '' } }),
  );
  expect(res.failure).toBeNull();
  expect(fake.calls.length).toBe(1);
  // Per-element substitution AFTER tokenization: the value is one argument
  // regardless of metacharacters; the empty value keeps its argv slot.
  expect(fake.calls[0].argv).toEqual(['mytool', '--svc', '; rm -rf /', '', 'tail']);
});

test('command: a mixed literal+token element substitutes in place (still one element)', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const spec = mkSpec({ script: null, command: ['mytool', '--url=${PP_HOST}:8080'] });
  executeScriptStep(spec, world.iterationPath, mkCtx(world, { runner: fake.runner, variables: { PP_HOST: 'db host' } }));
  expect(fake.calls[0].argv).toEqual(['mytool', '--url=db host:8080']);
});

test('T3b: argv[0] is NEVER a substitution surface — a token there is a binding failure, nothing spawns', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const spec = mkSpec({ script: null, command: ['${PP_TOOL}', '--version'] });
  const res = executeScriptStep(
    spec,
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, variables: { PP_TOOL: 'evil' } }),
  );
  expect(fake.calls.length).toBe(0);
  expect(res.failure?.class).toBe('binding');
  expect(res.failure?.detail).toContain('argv[0]');
  expect(res.record.outcome).toBe('halted');
});

test('command: an unresolvable token is a binding failure (caught, never a throw), nothing spawns', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const spec = mkSpec({ script: null, command: ['mytool', '${PP_NOPE}'] });
  const res = executeScriptStep(spec, world.iterationPath, mkCtx(world, { runner: fake.runner, variables: {} }));
  expect(fake.calls.length).toBe(0);
  expect(res.failure?.class).toBe('binding');
  expect(res.failure?.detail).toContain('PP_NOPE');
});

test('E9 zero-change: WITHOUT ctx.variables the authored argv passes through byte-identically (no `$$` collapse)', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const spec = mkSpec({ script: null, command: ['mytool', 'a$$b', 'plain'] });
  const res = executeScriptStep(spec, world.iterationPath, mkCtx(world, { runner: fake.runner }));
  expect(res.failure).toBeNull();
  expect(fake.calls[0].argv).toEqual(['mytool', 'a$$b', 'plain']);
  // WITH a variables map, the same element takes the compose-style collapse.
  const fake2 = fakeRunner([okRun()]);
  executeScriptStep(spec, world.iterationPath, mkCtx(world, { runner: fake2.runner, variables: {}, dispatchIndex: 2 }));
  expect(fake2.calls[0].argv).toEqual(['mytool', 'a$b', 'plain']);
});

// --- executeScriptStep: script: substitution + T3b containment ---------------

test('script: the path substitutes from the frozen map before the interpreter ladder', () => {
  const world = mkWorld();
  writeScript(world, 'step.js', 'console.log(JSON.stringify({ok:true}))');
  const fake = fakeRunner([okRun()]);
  const spec = mkSpec({ script: 'scripts/${PP_IMPL}.js' });
  const res = executeScriptStep(
    spec,
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, variables: { PP_IMPL: 'step' } }),
  );
  expect(res.failure).toBeNull();
  expect(fake.calls.length).toBe(1);
  // .js → the running bun/node binary + the substituted absolute path.
  expect(fake.calls[0].argv[0]).toBe(process.execPath);
  expect(fake.calls[0].argv[1]).toBe(join(world.pipelineRoot, 'scripts', 'step.js'));
});

test('T3b: a traversal value in script: is rejected as a binding step error — nothing spawns', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const spec = mkSpec({ script: '${PP_X}' });
  const res = executeScriptStep(
    spec,
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, variables: { PP_X: '../../evil.py' } }),
  );
  expect(fake.calls.length).toBe(0);
  expect(res.failure?.class).toBe('binding');
  expect(res.failure?.detail).toContain('outside the project root');
  expect(res.record.outcome).toBe('halted');
});

test('T3b: an out-of-root ABSOLUTE substituted path (drive-letter form) is rejected', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const spec = mkSpec({ script: '${PP_X}' });
  // isAbsPath accepts the drive-letter form on every platform; the canonical
  // containment compare rejects it against the tmp roots either way.
  const res = executeScriptStep(
    spec,
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, variables: { PP_X: 'C:\\Windows\\evil.py' } }),
  );
  expect(fake.calls.length).toBe(0);
  expect(res.failure?.class).toBe('binding');
});

winOnly('T3b (win32): backslash traversal and trailing-dot forms are rejected (canonical compare, not a prefix compare)', () => {
  const world = mkWorld();
  for (const evil of ['..\\..\\evil.py', '..\\..\\evil.py.']) {
    const fake = fakeRunner([okRun()]);
    const res = executeScriptStep(
      mkSpec({ script: '${PP_X}' }),
      world.iterationPath,
      mkCtx(world, { runner: fake.runner, variables: { PP_X: evil } }),
    );
    expect(fake.calls.length).toBe(0);
    expect(res.failure?.class).toBe('binding');
    expect(res.failure?.detail).toContain('T3b');
  }
});

test('T3b: a substituted path inside the PROJECT root (not the pipeline root) is allowed', () => {
  const world = mkWorld();
  const p = join(world.projectRoot, 'tools', 'ok.js');
  mkdirSync(join(world.projectRoot, 'tools'), { recursive: true });
  writeFileSync(p, 'x', 'utf8');
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(
    mkSpec({ script: '${PP_X}' }),
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, variables: { PP_X: p } }),
  );
  expect(res.failure).toBeNull();
  expect(fake.calls.length).toBe(1);
});

test('zero-change: an AUTHORED (unsubstituted) script path outside the roots is untouched by T3b', () => {
  // Author-owned text is a pre-existing capability — the gate fires only on
  // substituted values. Note ctx.variables IS present here (the run declares
  // variables); the value simply contains no token.
  const world = mkWorld();
  const outside = join(mkTmp('sstep-outside-'), 'tool.js');
  writeFileSync(outside, 'x', 'utf8');
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(
    mkSpec({ script: outside }),
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, variables: { PP_UNRELATED: 'v' } }),
  );
  expect(res.failure).toBeNull();
  expect(fake.calls[0].argv[1]).toBe(outside);
});

// --- T3c: the .bat/.cmd carve-out (shell-reachable, not argv-safe) -----------

test('T3c: a substituted script: path landing on .bat/.cmd is refused (cmd.exe re-parses)', () => {
  const world = mkWorld();
  for (const impl of ['run.bat', 'run.cmd']) {
    const fake = fakeRunner([okRun()]);
    const res = executeScriptStep(
      mkSpec({ script: 'scripts/${PP_IMPL}' }),
      world.iterationPath,
      mkCtx(world, { runner: fake.runner, variables: { PP_IMPL: impl } }),
    );
    expect(fake.calls.length).toBe(0);
    expect(res.failure?.class).toBe('binding');
    expect(res.failure?.detail).toContain('cmd.exe');
  }
});

test('T3c: substituted ARGS to an authored cmd/.bat command are refused; an all-literal one still runs', () => {
  const world = mkWorld();
  // Substituted arg through cmd.exe ⇒ refused, nothing spawns.
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(
    mkSpec({ script: null, command: ['cmd', '/c', 'scripts\\run.bat', '${PP_A}'] }),
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, variables: { PP_A: 'x' } }),
  );
  expect(fake.calls.length).toBe(0);
  expect(res.failure?.class).toBe('binding');
  expect(res.failure?.detail).toContain('cmd.exe');
  // All-literal cmd.exe command (authored, no substitution) is untouched.
  const fake2 = fakeRunner([okRun()]);
  const ok = executeScriptStep(
    mkSpec({ script: null, command: ['cmd', '/c', 'scripts\\run.bat', 'literal'] }),
    world.iterationPath,
    mkCtx(world, { runner: fake2.runner, variables: { PP_A: 'x' }, dispatchIndex: 2 }),
  );
  expect(ok.failure).toBeNull();
  expect(fake2.calls[0].argv).toEqual(['cmd', '/c', 'scripts\\run.bat', 'literal']);
});

test('T3c: an authored (unsubstituted) .bat script: still routes through cmd /c exactly as before', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(
    mkSpec({ script: 'scripts/run.bat' }),
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, variables: { PP_UNRELATED: 'v' } }),
  );
  expect(res.failure).toBeNull();
  expect(fake.calls[0].argv[0]).toBe('cmd');
  expect(fake.calls[0].argv[1]).toBe('/c');
});

// --- D10: the child-env overlay ----------------------------------------------

test('D10: every frozen PP_* entry rides the child env — after env-file entries, PIPELINE_STEP_* untouched', () => {
  const world = mkWorld();
  const envFile = join(world.projectRoot, 'wt.env');
  writeFileSync(envFile, 'PP_SVC=stale-worktree-value\nKEEP_ME=x\n', 'utf8');
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(
    mkSpec({ script: null, command: ['mytool'] }),
    world.iterationPath,
    mkCtx(world, {
      runner: fake.runner,
      worktreeEnvFile: envFile,
      variables: { PP_SVC: 'frozen-wins', PP_ONLY: 'exported' },
    }),
  );
  expect(res.failure).toBeNull();
  const env = fake.calls[0].opts.env;
  // The frozen map wins over a same-name worktree env-file entry (D10)…
  expect(env.PP_SVC).toBe('frozen-wins');
  // …other env-file entries survive…
  expect(env.KEEP_ME).toBe('x');
  // …every frozen entry is exported even without a placeholder anywhere…
  expect(env.PP_ONLY).toBe('exported');
  // …and PIPELINE_STEP_* stays most-authoritative for its own namespace.
  expect(env.PIPELINE_STEP_ID).toBe('wait-ci');
});

test('T3b/T3c gate on VARIABLE DATA, not a text diff: an authored `$$` escape collapse never trips them', () => {
  const world = mkWorld();
  // script: an authored `$$` path OUTSIDE every root — collapsed but never
  // variable-steered, so containment must NOT fire (authored capability).
  const outsideDir = mkTmp('sstep-dollar-');
  const authoredScript = join(outsideDir, '$$cache', 'run.js');
  const fake = fakeRunner([okRun()]);
  const res = executeScriptStep(
    mkSpec({ script: authoredScript }),
    world.iterationPath,
    mkCtx(world, { runner: fake.runner, variables: { PP_UNRELATED: 'v' } }),
  );
  expect(res.failure).toBeNull();
  expect(fake.calls[0].argv[1]).toBe(join(outsideDir, '$cache', 'run.js')); // collapse still applied

  // command: an all-literal `$$` arg through cmd.exe — no variable data, so
  // the T3c refusal must NOT fire either.
  const fake2 = fakeRunner([okRun()]);
  const ok = executeScriptStep(
    mkSpec({ script: null, command: ['cmd', '/c', 'run.bat', 'a$$b'] }),
    world.iterationPath,
    mkCtx(world, { runner: fake2.runner, variables: { PP_UNRELATED: 'v' }, dispatchIndex: 2 }),
  );
  expect(ok.failure).toBeNull();
  expect(fake2.calls[0].argv).toEqual(['cmd', '/c', 'run.bat', 'a$b']);
});

test('D10/E9: without ctx.variables no PP_* entry is added to the overlay', () => {
  const world = mkWorld();
  const fake = fakeRunner([okRun()]);
  executeScriptStep(mkSpec({ script: null, command: ['mytool'] }), world.iterationPath, mkCtx(world, { runner: fake.runner }));
  const env = fake.calls[0].opts.env;
  expect(Object.keys(env).some((k) => k.startsWith('PP_'))).toBe(false);
});
