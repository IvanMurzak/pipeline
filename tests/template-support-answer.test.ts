// The bundled `support-answer` template is a SHIPPED ARTEFACT — `pipeline init`
// and `pipeline clone` copy it verbatim into a user's project, so a break here
// reaches every new user before it reaches any of our own pipelines. Its own
// suite (`templates/support-answer/scripts/tests/`) travels with the clone and
// is deliberately NOT scanned by `bun test tests/`, so nothing in CI guarded it
// until this file: these tests run against the REAL template directory, not a
// fixture copy of it.
//
// Step 01 is a `type: script` step, which moves three things out of an agent's
// hands and into a contract that has to be pinned:
//   - the plan must lint clean (a script step that fails `pipeline plan` is a
//     template that cannot run at all);
//   - the script's STDOUT is now the result object the command layer parses
//     (docs/script-steps.md §3.5), so its shape is load-bearing;
//   - the run must actually collapse step 01 in-process and persist its
//     `output` to the outputs store, which is the file steps 02/03 read.

import { test, expect, afterEach, afterAll } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import { invokeNext } from '../src/commands/next';
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const TEMPLATE = join(import.meta.dir, '..', 'templates', 'support-answer');
const SCRIPT = join(TEMPLATE, 'scripts', 'bm25_retrieve.ts');

/** Every test below that spawns a process gets an explicit budget: bun's 5 s
 *  default is a fine unit-test bound but not an I/O one — a cold `bun` start
 *  plus a template copy plus a git init exceeds it on a loaded Windows box, and
 *  a test that flakes under load is worse than no test. Generous enough that a
 *  real hang still fails the suite. */
const SPAWN_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 40_000;

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

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

// ---------------------------------------------------------------------------
// 1. The template plan-lints clean
// ---------------------------------------------------------------------------

test('the shipped template produces a clean plan — zero errors AND zero warnings', () => {
  const plan = computePlan(TEMPLATE);
  // Warnings matter as much as errors for a template: a scaffold that greets a
  // new user with lint output teaches them to ignore lint output.
  expect(plan.errors).toEqual([]);
  expect(plan.warnings).toEqual([]);
});

test('step 01 is a script step wired to the bundled retrieval script', () => {
  const plan = computePlan(TEMPLATE);
  const step = plan.steps[0]!;
  expect(step.step_id).toBe('01-retrieve');
  expect(step.type).toBe('script');
  expect(step.script_spec?.script).toBe('scripts/bm25_retrieve.ts');
  // No `command:` — the script takes NO arguments; its inputs arrive as PP_*
  // entries in the child environment (script-steps.md §2.5), which is what
  // keeps the frontmatter free of substitution footguns (argv[0], `--`).
  expect(step.script_spec?.command).toBeNull();
  expect(step.script_spec?.params).toBeNull();
  // `env` failures halt regardless; declaring `halt` states the intent for the
  // rest (an agent cannot re-do deterministic retrieval usefully).
  expect(step.script_spec?.onFailure).toBe('halt');
  expect(step.script_spec?.retries).toBe(0);
});

test('the declared ## Output names exactly the two fields steps 02/03 read', () => {
  const out = computePlan(TEMPLATE).steps[0]!.script_spec!.output!;
  // Declared, so the runtime VALIDATES the script against it (a violation is a
  // `contract` failure) instead of passing a malformed payload downstream.
  expect(Object.keys(out).sort()).toEqual(['candidates', 'docs_dir']);
  expect((out as any).docs_dir.required).toBe(true);
  expect((out as any).candidates.required).toBe(true);
});

test('steps 02 and 03 stay agent steps — only the deterministic one was converted', () => {
  const plan = computePlan(TEMPLATE);
  expect(plan.steps.map((s) => s.type)).toEqual(['script', 'agent', 'agent']);
});

test('routing is declared in the graph, so the template needs no absolute paths', () => {
  // A sequential script step must carry an ABSOLUTE `## Next`, which a shipped
  // template cannot know (it is copied to a path chosen by the user). Graph
  // mode routes by step_id instead — that is why this pipeline declares one.
  const plan = computePlan(TEMPLATE);
  expect(plan.graph).toEqual({
    '01-retrieve': { goto: '02-select' },
    '02-select': { goto: '03-answer' },
    '03-answer': { done: true },
  });
  const stepText = readFileSync(join(TEMPLATE, 'steps', '01-retrieve.md'), 'utf8');
  expect(stepText).toInclude('<pipeline-root>/steps/02-select.md');
});

test('all three pipeline variables stay declared with defaults, so a bare run works', () => {
  const vars = computePlan(TEMPLATE).variables;
  expect(vars.map((v) => v.name).sort()).toEqual(['PP_DOCS_DIR', 'PP_QUESTION', 'PP_TOP_K']);
  // None required: `pipeline next` with no --var must not halt at run init.
  expect(vars.filter((v) => v.required)).toEqual([]);
});

// ---------------------------------------------------------------------------
// 2. The script's stdout contract, exercised by a REAL spawn
// ---------------------------------------------------------------------------

interface Spawned {
  status: number;
  stdout: string;
  stderr: string;
  result: any;
}

/** Run the script the way the runtime does — no arguments unless asked, values
 *  through the environment — and parse stdout by the SAME rule the command
 *  layer uses (§3.5: the last line that parses as a JSON object). */
function runScript(env: Record<string, string> = {}, args: string[] = []): Spawned {
  const r = spawnSync('bun', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const lines = (r.stdout ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  let result: any = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        result = parsed;
        break;
      }
    } catch {
      // keep walking backwards
    }
  }
  // The script pretty-prints, so the last LINE is `}`; fall back to a
  // whole-stdout parse exactly as the runtime does.
  if (result === null) {
    try {
      result = JSON.parse(r.stdout ?? '');
    } catch {
      result = null;
    }
  }
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', result };
}

/** The plain default invocation, spawned once and asserted from several angles
 *  — spawning it per assertion buys nothing and costs a process each time. */
let defaultRun: Spawned | null = null;
const theDefaultRun = (): Spawned => (defaultRun ??= runScript());

test(
  'a default invocation prints a well-formed success result and exits 0',
  () => {
    const { status, result } = theDefaultRun();
    expect(status).toBe(0);
    expect(result.ok).toBe(true);
    expect(isAbsolute(result.output.docs_dir)).toBe(true);
    expect(result.output.docs_dir).toInclude('sample-docs');
    expect(result.output.candidates.length).toBeGreaterThan(0);
    expect(result.flags.has_candidates).toBe(true);
    for (const c of result.output.candidates) {
      expect(Object.keys(c).sort()).toEqual(['file', 'score', 'snippet']);
    }
  },
  SPAWN_TIMEOUT_MS,
);

test(
  'stdout carries the result object and NOTHING else',
  () => {
    // Diagnostics on stdout are exactly what breaks the §3.5 parse, so this is
    // a contract test, not a style one.
    const { stdout } = theDefaultRun();
    expect(() => JSON.parse(stdout)).not.toThrow();
  },
  SPAWN_TIMEOUT_MS,
);

test(
  'a question matching nothing is a SUCCESS with an empty list, not a failure',
  () => {
    const { status, result } = runScript({ PP_QUESTION: 'quantum chromodynamics zzzq' });
    expect(status).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.output.candidates).toEqual([]);
    expect(result.flags.has_candidates).toBe(false);
  },
  SPAWN_TIMEOUT_MS,
);

test(
  'PP_* environment variables steer the run with no arguments at all',
  () => {
    // This is the whole reason the step file passes no argv: the runtime
    // exports the frozen PP_* map into the child environment and the script
    // reads it.
    const { result } = runScript({ PP_QUESTION: 'request a refund', PP_TOP_K: '1' });
    expect(result.output.candidates.length).toBe(1);
    expect(result.output.candidates[0].file).toBe('billing.md');
  },
  SPAWN_TIMEOUT_MS,
);

test(
  'a missing docs folder fails as class `env` — classified, not a bare crash',
  () => {
    const { status, result, stderr } = runScript({ PP_DOCS_DIR: join(tmpdir(), 'sa-no-such-dir-xyz') });
    expect(status).toBe(2);
    expect(result.ok).toBe(false);
    // The runtime trusts this class and halts without spending an agent on a
    // machine problem; without the JSON it could only classify the exit as
    // `crash`, whose policy is different.
    expect(result.error.class).toBe('env');
    expect(stderr).toInclude('docs directory not found');
  },
  SPAWN_TIMEOUT_MS,
);

test(
  'a malformed PP_TOP_K fails as class `bug` and never ranks anything',
  () => {
    const { status, result } = runScript({ PP_TOP_K: 'not-a-number' });
    expect(status).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.error.class).toBe('bug');
    expect(result.output).toBeUndefined();
  },
  SPAWN_TIMEOUT_MS,
);

// ---------------------------------------------------------------------------
// 3. End-to-end: the step really runs in-process and lands in the outputs store
// ---------------------------------------------------------------------------

interface World {
  project: string;
  root: string;
}

/** A consumer project holding a real clone of the template, exactly where
 *  `pipeline clone` puts it. `autoClean: false` opts out of the per-test
 *  teardown for the world shared across several assertions. */
function mkWorld(autoClean = true): World {
  const project = autoClean ? mkTmp('sa-e2e-proj-') : mkdtempSync(join(tmpdir(), 'sa-e2e-proj-'));
  // A real .git pins resolveProjectRoot to THIS project so the event journal
  // never lands in an enclosing repo (the hooks.test.ts harness rule).
  spawnSync('git', ['init', '-q'], { cwd: project });
  const root = join(project, '.pipeline', 'support-answer');
  mkdirSync(join(project, '.pipeline'), { recursive: true });
  cpSync(TEMPLATE, root, { recursive: true });
  return { project, root };
}

/** Swap cwd to the project and isolate HOME + the event-writer envelope. */
function inProject<T>(w: World, fn: () => T): T {
  const prevCwd = process.cwd();
  const home = mkTmp('sa-e2e-home-');
  const keys = ['PIPELINE_RUN_ID', 'PIPELINE_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'USERPROFILE', 'HOME'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.chdir(w.project);
    delete process.env.PIPELINE_RUN_ID;
    delete process.env.PIPELINE_PARENT_RUN_ID;
    delete process.env.CLAUDE_SESSION_ID;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    return fn();
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** ONE default run of the real pipeline, shared by the assertions below: they
 *  interrogate the same run from different angles, and re-running it per test
 *  would triple the wall-clock for no extra coverage. Torn down in afterAll,
 *  not afterEach, so it survives between them. */
let happy: { w: World; res: ReturnType<typeof invokeNext> } | null = null;
function happyRun() {
  if (happy === null) {
    const w = mkWorld(false);
    const res = inProject(w, () =>
      invokeNext({ root: w.root, runId: 'r1', start: join(w.root, 'steps', '01-retrieve.md') }),
    );
    happy = { w, res };
  }
  return happy;
}
afterAll(() => {
  if (happy) rmSync(happy.w.project, { recursive: true, force: true });
});

test(
  'the first `next` call runs step 01 in-process and dispatches step 02',
  () => {
    const { res } = happyRun();
    // The retrieval step never becomes an action for a caller to execute — it
    // is collapsed inside this one call. If it regressed to an agent step, the
    // very first action would be `01-retrieve`, and this is what catches that.
    expect(res.action.action).toBe('run-step');
    const dispatched = (res.out as any).steps;
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].step_id).toBe('02-select');
    expect(dispatched[0].type).toBe('agent');
    expect((res.out as any).mode).toBe('graph');
  },
  RUN_TIMEOUT_MS,
);

test(
  'step 01 persists its output to the exact file steps 02/03 read',
  () => {
    const { w } = happyRun();
    const outFile = join(w.root, '.runtime', 'r1', 'outputs', '01-retrieve.json');
    expect(existsSync(outFile)).toBe(true);
    const out = readJson(outFile);
    // Steps 02 and 03 name this path and these two keys in their own bodies —
    // the payload shape is a cross-step contract, not an implementation detail.
    expect(Object.keys(out).sort()).toEqual(['candidates', 'docs_dir']);
    expect(isAbsolute(out.docs_dir)).toBe(true);
    // Resolved against the CLONE's own root, not the template it was copied
    // from: a relative PP_DOCS_DIR must follow the pipeline, not its origin.
    //
    // Asserted WITHOUT comparing absolute paths. A Windows CI runner's TEMP is
    // the 8.3 short form (C:\Users\RUNNER~1\…) while the script resolves its own
    // location to the long form (C:\Users\runneradmin\…) — two names for one
    // directory. `realpathSync` does NOT reconcile them here (verified on CI:
    // it returned the short form unchanged), so these three facts are checked
    // instead, and every one of them is spelled identically in both forms.
    expect(out.docs_dir).toInclude(basename(w.project)); // THIS run's own clone
    expect(out.docs_dir.endsWith(join('support-answer', 'sample-docs'))).toBe(true);
    expect(out.docs_dir.startsWith(TEMPLATE)).toBe(false); // not the source template
    expect(out.candidates.length).toBeGreaterThan(0);

    const stepBody = readFileSync(join(w.root, 'steps', '02-select.md'), 'utf8');
    expect(stepBody).toInclude('outputs/01-retrieve.json');
  },
  RUN_TIMEOUT_MS,
);

test(
  'the ledger records the step finished, with its routing flag',
  () => {
    const { w } = happyRun();
    // §8: a `finished` entry is what stops a re-dispatch from re-executing the
    // script after a crash between success and state persistence.
    const ledger = readJson(join(w.root, '.runtime', 'r1', 'ledger', '01-retrieve-1.json'));
    expect(ledger.phase).toBe('finished');
    expect(ledger.record.outcome).toBe('completed');
    expect(ledger.record.flags).toEqual({ has_candidates: true });
  },
  RUN_TIMEOUT_MS,
);

test(
  '--var reaches the script through the environment overlay',
  () => {
    const w = mkWorld();
    inProject(w, () =>
      invokeNext({
        root: w.root,
        runId: 'r2',
        start: join(w.root, 'steps', '01-retrieve.md'),
        cliVars: { PP_QUESTION: 'how do I request a refund', PP_TOP_K: '1' },
      }),
    );

    const out = readJson(join(w.root, '.runtime', 'r2', 'outputs', '01-retrieve.json'));
    // A different question really produced a different source — proof the value
    // travelled all the way into the spawned process, not just into next.json.
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].file).toBe('billing.md');
  },
  RUN_TIMEOUT_MS,
);

test(
  'a run whose docs folder does not exist stops, carrying the script`s own reason',
  () => {
    const w = mkWorld();
    const res = inProject(w, () =>
      invokeNext({
        root: w.root,
        runId: 'r3',
        start: join(w.root, 'steps', '01-retrieve.md'),
        cliVars: { PP_DOCS_DIR: join(tmpdir(), 'sa-no-such-dir-xyz') },
      }),
    );

    // The engine does NOT return `halt` here: a failed run still gets its
    // end-of-run retrospective first (that is what lets the feedback file heal
    // the script), and the halt reason rides in the state. What matters for
    // this template is that the chain made no forward progress...
    expect(res.action.action).not.toBe('run-step');
    expect(JSON.stringify(res.out)).not.toInclude('02-select');

    // ...and that the reason preserved BOTH the script's self-classification
    // and its own message, rather than a generic "script failed".
    const state = readJson(join(w.root, '.runtime', 'r3', 'next.json'));
    expect(state.halt_reason).toInclude('(env)');
    expect(state.halt_reason).toInclude('docs directory not found');

    // A failure record plus the full log is written for whoever fixes it —
    // `<step_id>-<dispatch_index>-<attempt>`.
    const failures = join(w.root, '.runtime', 'r3', 'failures');
    expect(existsSync(join(failures, '01-retrieve-1-1.json'))).toBe(true);
    expect(existsSync(join(failures, '01-retrieve-1-1.log'))).toBe(true);
    expect(readJson(join(failures, '01-retrieve-1-1.json')).class).toBe('env');

    // And no output was persisted — a failed retrieval must not leave steps
    // 02/03 a file to read.
    expect(existsSync(join(w.root, '.runtime', 'r3', 'outputs', '01-retrieve.json'))).toBe(false);
  },
  RUN_TIMEOUT_MS,
);
