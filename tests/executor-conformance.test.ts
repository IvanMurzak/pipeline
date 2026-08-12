// executor-conformance.test.ts — d2: ONE pipeline, run under
// `--executor=claude-cli` AND `--executor=claude-sdk`, with the two runs'
// artifacts required to match.
//
// ── WHAT THIS TEST IS FOR ──────────────────────────────────────────────────
//
// Two implementations of one seam drift unless something forces them
// together, and drift HERE is invisible: both executors produce a step
// record, both report success, and the only symptom is a pipeline that
// behaves differently depending on a flag nobody thought was semantic.
//
// ── WHY THIS IS COMPARABLE AT ALL: ONE ENGINE, TWO FRONT DOORS ─────────────
//
// The Agent SDK bundles and drives the same Claude Code binary the CLI
// executor spawns, so `claude-cli` and `claude-sdk` are two front doors to one
// engine, not two engines. `tests/_conformance-engine.ts` makes that literally
// true for this test: ONE pure function answers every dispatch, and the two
// front doors are (a) a generated `bun` script that imports it and prints
// stream-json on stdout — reached through the REAL `subprocessExecutor`, the
// REAL `buildExecutorArgv`, and the REAL `ClaudeStreamParser` — and (b) a fake
// `query()` that imports it and yields the same frames, reached through the
// REAL `sdkExecutor`/`sdkDriveSeams`. Only the vendor is faked. Two separate
// fakes could disagree and the test would then be measuring the fakes; one
// shared engine cannot.
//
// ── NOTHING IS INJECTED: THE FLAG IS THE ONLY DIFFERENCE ──────────────────
//
// `DriveDeps` is EMPTY (bar the two output sinks) on both runs. The CLI run
// reaches `subprocessExecutor` because that is what `--executor=claude-cli`
// selects; the SDK run reaches `sdkDriveSeams` because that is what
// `--executor=claude-sdk` selects. Nothing about the executor is handed in.
//
// That matters more than it looks. Injecting `DriveDeps.executor` — the
// obvious way to test an SDK path whose package is not installed — silently
// bypasses the wiring `drive` does around the seams it builds itself
// (`onToolCall`, the plugin root), so an injected run is NOT the run the flag
// produces, and comparing it against a real CLI run would report differences
// that only the harness caused. The first draft of this file did exactly that
// and "found" a missing `step.tool` progress event that does not exist in the
// product.
//
// So the optional peer dependency `@anthropic-ai/claude-agent-sdk` — which
// this repository deliberately does not install — is supplied instead at the
// MODULE level, via `mock.module`, exactly where `loadSdkQuery()` looks for
// it. `drive` then builds its own seams, through its own code, for both runs.
//
// ── THE TWO WAYS A TEST LIKE THIS BECOMES WORTHLESS, AND THE GUARDS ────────
//
// 1. **A vacuous comparison.** If the exclusion list grows until only trivia
//    is compared, this passes forever and proves nothing. Two guards:
//    - Nothing is cherry-picked. The WHOLE of `.runtime/<run>/` is compared,
//      file set and file contents, field by field. A new artifact is compared
//      the day it appears, without anyone remembering to add it.
//    - {@link EXCLUSIONS} is a closed, reasoned list, and
//      `'every exclusion earns its place'` re-runs the comparison with each
//      entry REMOVED and requires it to fail. An exclusion that is not
//      load-bearing cannot survive in this file.
//
// 2. **A comparison of one path against itself.** If both runs quietly went
//    through the same executor, everything would match and nothing would be
//    proved. `'the two runs really used different front doors'` is the
//    control: the CLI command templates are ARMED at the fake `claude` for
//    BOTH runs, and the dispatch log records which door served each dispatch.
//    The CLI run must show three `claude-cli` dispatches; the SDK run must
//    show three `claude-sdk` dispatches and must never have touched the armed
//    templates.
//
// ── WHAT IS COMPARED ──────────────────────────────────────────────────────
//
// The engine-visible contract, not byte equality of everything that moved:
//
//   - **outcome** — the terminal JSON `pipeline drive` prints, and each step's
//     recorded outcome inside it;
//   - **the structured records** — every file under `.runtime/<run>/records/`,
//     agent steps and both self-improvement sessions alike;
//   - **the files the steps wrote** — `.runtime/<run>/outputs/` (both the
//     agent step's `output` and the script step's §10 output) and the script
//     step's `.runtime/<run>/ledger/` entries;
//   - **the effect on the run cursor** — `.runtime/<run>/next.json`, the
//     engine state the next call resumes from.
//
// All four fall out of comparing `.runtime/<run>/` wholesale; they are named
// here because they are what the design asks for, not because they are
// separately special-cased.
//
// ── WHY BOTH RUNS SHARE ONE PIPELINE ROOT ─────────────────────────────────
//
// Two temp roots would put a different absolute path inside every record that
// names one, and the comparison would need a path-rewriting normalisation —
// i.e. a blanket exclusion over the very fields (`next_iteration`,
// `script_path`) a divergence would most likely show up in. One root and two
// run ids (`cli`, `sdk`) removes that entirely: the run id appears in
// directory names but in none of the compared CONTENT, so the artifacts are
// compared as literal bytes with no rewriting at all.

import { afterAll, describe, expect, mock, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_EXECUTOR_TEMPLATE,
  DEFAULT_IMPROVER_TEMPLATE,
  DEFAULT_SCRIPT_CREATOR_TEMPLATE,
  EXECUTOR_KINDS,
  runDrive,
  type DriveDeps,
  type ExecutorKind,
} from '../src/commands/drive';
import { SDK_IMPROVER_AGENT, SDK_SCRIPT_CREATOR_AGENT, SDK_STEP_AGENT } from '../src/lib/executors/sdk-seams';
import { SDK_MODULE_ID, type SdkQuery } from '../src/lib/executors/sdk';
import { envelopeFromResultFrame } from '../src/lib/envelope';
import { computePlan } from '../src/lib/plan';
import { assertFullModelId, assertModelUsedMatches } from './_model-conformance';
import { engineFrames, type EngineDispatch, type EngineSpec } from './_conformance-engine';

// ---------------------------------------------------------------------------
// The pinned model (d1)
// ---------------------------------------------------------------------------

/**
 * A FULL model id, never an alias — d1/`_model-conformance.ts` explains why at
 * length: an alias resolves by provider, Claude Code version, org entitlement
 * and settings, so two alias-pinned runs about to be diffed could be two
 * different models and this test would never find out.
 *
 * `assertFullModelId` runs at module load, so replacing this with `sonnet`
 * fails the file immediately rather than quietly weakening every comparison
 * below.
 */
const PINNED_MODEL = 'claude-opus-4-1-20250805';
assertFullModelId(PINNED_MODEL);

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

const IMPROVEMENT_BRIEF = 'IMPROVEMENT BRIEF: the plan step names the wrong linter; use eslint.';
const EXTRACTION_BRIEF = 'EXTRACT-A: pull the emit block into a script';

/** The script the `type: script` step runs, in-process, with NO executor
 *  involved on EITHER run — which is why its artifacts are asserted
 *  byte-identical rather than merely equivalent. */
const EMIT_JS = `console.log('emitting…');
console.log(JSON.stringify({ ok: true, summary: 'emitted the thing', flags: { emitted: true }, output: { n: 42 } }));
`;

interface World {
  /** The pipeline root, shared by both runs (see the header). */
  root: string;
  planStep: string;
  emitStep: string;
  /** The generated stand-in for the `claude` binary — see below. */
  fakeClaude: string;
}

/**
 * One pipeline covering all four cases the DoD requires:
 *
 *   1. an AGENT step (`plan`) — dispatched through the executor seam, and it
 *      reports an improvement brief, which is what makes the engine dispatch…
 *   2. an IMPROVER session — which returns one script-creation brief, which is
 *      what makes the engine dispatch…
 *   3. a SCRIPT-CREATOR session;
 *   4. a `type: script` step (`emit`) — executed IN-PROCESS by the command
 *      layer, never reaching an executor at all.
 *
 * A one-agent-step fixture would let a half-implemented c4 (only
 * `DriveDeps.executor` wired, the self-improvement seams silently falling back
 * to `claude -p`) pass this file — so covering 2 and 3 is not padding.
 */
function scaffold(): World {
  const root = mkdtempSync(join(tmpdir(), 'exec-conformance-'));
  created.push(root);
  // A whitespace-split command template cannot carry a path with a space; a
  // machine whose TEMP has one would produce a confusing spawn failure many
  // layers down, so say so here instead.
  expect(root).not.toContain(' ');
  mkdirSync(join(root, 'steps'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), '# Conformance\n\n## End State\nboth executors agree\n');

  const planStep = join(root, 'steps', '01-plan.md');
  const emitStep = join(root, 'steps', '02-emit.md');
  writeFileSync(planStep, '---\nstep_id: plan\n---\n# plan\n## Goal\ng\n## Success Criteria\ns\n');
  writeFileSync(
    emitStep,
    [
      '---',
      'type: script',
      'script: scripts/emit.js',
      'step_id: emit',
      // Well under the manager-safe ceiling: the default would emit a
      // (harmless, identical-on-both-sides) budget warning that only adds
      // noise to a fixture whose job is to be boring.
      'timeout: 60',
      '---',
      '# emit',
      '## Goal',
      'g',
      '## Success Criteria',
      's',
      '## Steps',
      '1. Run: `bun scripts/emit.js`',
      '## Next',
      'Pipeline complete.',
      '',
    ].join('\n'),
  );
  writeFileSync(join(root, 'scripts', 'emit.js'), EMIT_JS);

  const fakeClaude = join(root, 'fake-claude.ts');
  writeFileSync(fakeClaude, FAKE_CLAUDE_SRC, 'utf8');

  // Each run writes its OWN engine spec (driveOnce) — the deliberate-drift run
  // needs a different one, and a per-run file keeps that from being a mutation
  // of shared state between runs that are supposed to be independent.
  return { root, planStep, emitStep, fakeClaude };
}

/** The fixture's answers, as data — see `_conformance-engine.ts`. Built fresh
 *  on every call so a caller that mutates one (the deliberate-drift run below)
 *  cannot reach the spec another run is using. */
function engineSpec(emitStep: string): EngineSpec {
  return {
    agents: { step: SDK_STEP_AGENT, improver: SDK_IMPROVER_AGENT, scriptCreator: SDK_SCRIPT_CREATOR_AGENT },
    steps: {
      plan: {
        outcome: 'completed',
        summary: 'planned the work',
        next_iteration: emitStep,
        has_improvement_brief: true,
        improvement_brief: IMPROVEMENT_BRIEF,
        // An agent step's own §10 output — so `outputs/` carries a file from
        // the EXECUTOR path too, not only from the in-process script step.
        output: { planned: true },
      },
    },
    improver: { applied: true, script_creation_briefs: [EXTRACTION_BRIEF], summary: 'fixed the linter reference' },
    scriptCreator: { outcome: 'created', script_path: 'scripts/emit.js', summary: 'extracted emit.js' },
  };
}

// ---------------------------------------------------------------------------
// Front door 1 — the CLI: a real subprocess, spawned by the real runner
// ---------------------------------------------------------------------------

const ENGINE_URL = pathToFileURL(join(import.meta.dir, '_conformance-engine.ts')).href;

/** The generated stand-in for `claude`. It imports the SHARED engine rather
 *  than re-implementing one, which is the whole reason the two doors are
 *  comparable. */
const FAKE_CLAUDE_SRC = `// generated by tests/executor-conformance.test.ts — the claude-cli front door.
import { appendFileSync, readFileSync } from 'node:fs';
import { engineFrames, flagValue } from ${JSON.stringify(ENGINE_URL)};

const argv = process.argv.slice(2);
const prompt = await Bun.stdin.text();
const spec = JSON.parse(readFileSync(process.env.PIPELINE_CONFORMANCE_SPEC, 'utf8'));
const agent = flagValue(argv, '--agent');
const model = flagValue(argv, '--model');
const session = flagValue(argv, '--session-id') ?? flagValue(argv, '--resume');
appendFileSync(
  process.env.PIPELINE_CONFORMANCE_LOG,
  JSON.stringify({ door: 'claude-cli', agent, model, prompt }) + '\\n',
  'utf8',
);
const frames = engineFrames(spec, agent, prompt, model, session);
process.stdout.write(frames.map((f) => JSON.stringify(f)).join('\\n') + '\\n');
process.exit(0);
`;

/**
 * The three command templates, derived from the REAL defaults by swapping only
 * the `claude` token for `bun <fake>`.
 *
 * Deriving rather than hand-writing matters: every other flag — `--agent`,
 * `--model {model}`, `--session-id {session}`, `--add-dir {record_dir}`,
 * `--output-format stream-json --verbose`, `--json-schema {schema}` — is the
 * one production uses, so `buildExecutorArgv` is exercised on the real token
 * set and a change to a default template is inherited here instead of silently
 * diverging from it.
 */
function fakeTemplates(fakeClaude: string): Record<string, string> {
  const swap = (t: string): string => t.replace(/^claude\b/, `bun ${fakeClaude}`);
  return {
    PIPELINE_DRIVE_EXECUTOR_CMD: swap(DEFAULT_EXECUTOR_TEMPLATE),
    PIPELINE_DRIVE_IMPROVER_CMD: swap(DEFAULT_IMPROVER_TEMPLATE),
    PIPELINE_DRIVE_SCRIPT_CREATOR_CMD: swap(DEFAULT_SCRIPT_CREATOR_TEMPLATE),
  };
}

// ---------------------------------------------------------------------------
// Front door 2 — the SDK: the real sdkExecutor, with only the VENDOR faked
// ---------------------------------------------------------------------------

/**
 * The stand-in for `@anthropic-ai/claude-agent-sdk`'s `query()`.
 *
 * It takes its wiring out of the ENVIRONMENT rather than from a closure, for
 * the same reason the generated `claude` script does: this is what the SDK
 * front door is allowed to know, and reading it the same way on both sides
 * keeps the two doors symmetric. It also has to, mechanically — the module
 * mock below is installed once, before any run exists to close over.
 */
const envQuery: SdkQuery = ({ prompt, options }) => {
  const spec = JSON.parse(readFileSync(process.env.PIPELINE_CONFORMANCE_SPEC!, 'utf8')) as EngineSpec;
  const agent = options?.agent ?? null;
  const model = options?.model ?? null;
  const session = options?.sessionId ?? options?.resume ?? null;
  const dispatch: EngineDispatch = { door: 'claude-sdk', agent, model, prompt };
  appendFileSync(process.env.PIPELINE_CONFORMANCE_LOG!, JSON.stringify(dispatch) + '\n', 'utf8');
  const frames = engineFrames(spec, agent, prompt, model, session);
  return (async function* () {
    for (const f of frames) yield f;
  })();
};

/**
 * Supply the optional peer dependency at the module level — the ONE place
 * `loadSdkQuery()` looks — so `drive` builds its own SDK seams through its own
 * code path instead of being handed a pre-built runner (see the header).
 *
 * Mocking a package that is genuinely absent from this repository shadows
 * nothing: no other module imports this specifier, and `sdk.ts` reads it out
 * of a value (`SDK_MODULE_ID`) precisely so the bundler never follows it.
 * `scripts/parallel-tests.ts` runs each test FILE in its own process, so the
 * mock cannot reach another file there; under the sequential `bun test tests/`
 * it outlives this file, and still shadows nothing for the same reason.
 */
mock.module(SDK_MODULE_ID, () => ({ query: envQuery }));

// ---------------------------------------------------------------------------
// Running one side
// ---------------------------------------------------------------------------

const created: string[] = [];
afterAll(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}, 30000);

const ENV_KEYS = [
  'PIPELINE_DRIVE_SELF_IMPROVE',
  'PIPELINE_DRIVE_EXECUTOR_CMD',
  'PIPELINE_DRIVE_IMPROVER_CMD',
  'PIPELINE_DRIVE_SCRIPT_CREATOR_CMD',
  'PIPELINE_RUN_ID',
  'PIPELINE_PARENT_RUN_ID',
  'PIPELINE_SYNC_LOCAL_STATS',
  'PIPELINE_STATS_RUNNER',
  'PIPELINE_CONFORMANCE_SPEC',
  'PIPELINE_CONFORMANCE_LOG',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PLUGIN_ROOT',
  'HOME',
  'USERPROFILE',
] as const;

interface RunResult {
  kind: ExecutorKind;
  runId: string;
  code: number;
  /** The terminal JSON `pipeline drive` printed. */
  json: Record<string, unknown> | null;
  stderr: string;
  /** Every dispatch, in order, as the front door that served it saw it. */
  dispatches: EngineDispatch[];
  /** The run's progress-event NAMES, in order — what a watching human sees. */
  events: string[];
  /** Which rung of the record-recovery ladder produced each step record. */
  recordSources: string[];
  /** `.runtime/<run>/` — relative posix path → file text. */
  tree: Tree;
}

/** The `[drive] <event>` names a run emitted, in order. NAMES only: the field
 *  values carry session ids and costs, which are not executor evidence, while
 *  the sequence itself is exactly the observable behaviour a user watches. */
function progressEvents(stderr: string): string[] {
  return [...stderr.matchAll(/^\[drive\] (\S+)/gm)].map((m) => m[1]);
}

/**
 * The `source=` of every `step.record` progress line — which rung of drive's
 * four-rung recovery ladder actually produced the record.
 *
 * Worth comparing on its own: two executors can agree on the record CONTENT
 * while reaching it by different routes (`structured_output` vs the tmp drop
 * file vs the final-response text). That is a real behavioural difference —
 * the design's "the ladder narrows but does not collapse" note is precisely
 * about the SDK making the lower rungs unnecessary — and it is invisible in
 * every artifact the runs persist.
 */
function recordSources(stderr: string): string[] {
  return [...stderr.matchAll(/^\[drive\] step\.record .*\bsource=(\S+)/gm)].map((m) => m[1]);
}

/**
 * Run the fixture once, end to end, in-process.
 *
 * The three `claude -p` command templates are armed for BOTH runs, not just
 * the CLI one. For `claude-cli` they ARE the front door; for `claude-sdk` they
 * are a tripwire — an SDK run that touched one would append a `claude-cli`
 * dispatch to the log, and the control test below would see it. That is what
 * keeps this from being a comparison of one path against itself.
 */
async function driveOnce(w: World, kind: ExecutorKind, runId: string, spec: EngineSpec): Promise<RunResult> {
  const specFile = join(w.root, `engine-spec-${runId}.json`);
  writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf8');
  const logFile = join(w.root, `dispatches-${runId}.jsonl`);
  rmSync(logFile, { force: true });

  const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
  const prevCwd = process.cwd();
  let outBuf = '';
  let errBuf = '';
  try {
    for (const [k, v] of Object.entries(fakeTemplates(w.fakeClaude))) process.env[k] = v;
    process.env.PIPELINE_DRIVE_SELF_IMPROVE = '1';
    process.env.PIPELINE_CONFORMANCE_SPEC = specFile;
    process.env.PIPELINE_CONFORMANCE_LOG = logFile;
    process.env.HOME = w.root;
    process.env.USERPROFILE = w.root;
    for (const k of [
      'PIPELINE_RUN_ID',
      'PIPELINE_PARENT_RUN_ID',
      'PIPELINE_SYNC_LOCAL_STATS',
      'PIPELINE_STATS_RUNNER',
      'CLAUDE_SESSION_ID',
      'CLAUDE_PLUGIN_ROOT',
    ]) {
      delete process.env[k];
    }
    process.chdir(w.root);

    // NOTHING executor-shaped is injected on EITHER run: `--executor` alone
    // decides which implementation drive builds and wires (see the header).
    const deps: DriveDeps = { out: (s) => (outBuf += s), err: (s) => (errBuf += s) };

    const code = await runDrive(
      [
        '--root',
        w.root,
        '--run-id',
        runId,
        '--start',
        w.planStep,
        '--default-model',
        PINNED_MODEL,
        '--executor',
        kind,
      ],
      deps,
    );

    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(outBuf) as Record<string, unknown>;
    } catch {
      /* error paths print nothing on stdout */
    }
    const dispatches = existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as EngineDispatch)
      : [];
    return {
      kind,
      runId,
      code,
      json,
      stderr: errBuf,
      dispatches,
      events: progressEvents(errBuf),
      recordSources: recordSources(errBuf),
      tree: captureTree(join(w.root, '.runtime', runId)),
    };
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Capturing a run's artifacts
// ---------------------------------------------------------------------------

/** Relative posix path → file text, for every file under a run's state dir. */
type Tree = Map<string, string>;

function captureTree(dir: string): Tree {
  const out: Tree = new Map();
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p).split(sep).join('/'), readFileSync(p, 'utf8'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// The comparator — a divergence NAMES its field
// ---------------------------------------------------------------------------

/**
 * One difference between the two runs, located precisely enough to act on.
 *
 * `field` is a dotted JSON path (`record.next_iteration`, `results.0.outcome`)
 * for a parsed artifact, `<file>` when a file exists on one side only, and
 * `<bytes>` for a file that is not JSON. "Records differ" is exactly the
 * message this type exists to make impossible: at the moment this test finally
 * fires, the ONE thing its reader needs is which field moved.
 */
interface Divergence {
  file: string;
  field: string;
  cli: unknown;
  sdk: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Field-level divergences between two parsed JSON values. Keys are walked in
 *  sorted order, so the FIRST divergence reported is stable across runs and
 *  platforms rather than depending on object insertion order. */
function jsonDivergences(file: string, path: string, a: unknown, b: unknown, out: Divergence[]): void {
  const here = (cli: unknown, sdk: unknown): void => {
    out.push({ file, field: path === '' ? '<root>' : path, cli, sdk });
  };
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const child = path === '' ? key : `${path}.${key}`;
      if (!(key in a) || !(key in b)) {
        out.push({ file, field: child, cli: key in a ? a[key] : '<absent>', sdk: key in b ? b[key] : '<absent>' });
        continue;
      }
      jsonDivergences(file, child, a[key], b[key], out);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      here(`<${a.length} items>`, `<${b.length} items>`);
      return;
    }
    for (let i = 0; i < a.length; i++) jsonDivergences(file, path === '' ? String(i) : `${path}.${i}`, a[i], b[i], out);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) here(a, b);
}

/** Every divergence between two runs' artifact trees, before exclusions. */
function treeDivergences(cli: Tree, sdk: Tree): Divergence[] {
  const out: Divergence[] = [];
  for (const file of [...new Set([...cli.keys(), ...sdk.keys()])].sort()) {
    const a = cli.get(file);
    const b = sdk.get(file);
    if (a === undefined || b === undefined) {
      out.push({ file, field: '<file>', cli: a === undefined ? '<absent>' : '<present>', sdk: b === undefined ? '<absent>' : '<present>' });
      continue;
    }
    if (a === b) continue; // byte-identical: nothing to say
    let pa: unknown;
    let pb: unknown;
    try {
      pa = JSON.parse(a);
      pb = JSON.parse(b);
    } catch {
      out.push({ file, field: '<bytes>', cli: a, sdk: b });
      continue;
    }
    jsonDivergences(file, '', pa, pb, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE EXCLUSION LIST — every entry states what, and why
// ---------------------------------------------------------------------------

/**
 * Fields that may legitimately differ between two runs of the same pipeline,
 * whichever executor ran them.
 *
 * The test for this list is not "does it look short". It is
 * `'every exclusion earns its place'` below, which re-runs the comparison with
 * each entry removed and requires the comparison to FAIL — so an entry that
 * excludes nothing real cannot stay, and an entry cannot be widened to cover a
 * genuine divergence without being visibly wider here.
 *
 * The general test each reason has to pass: *would two runs of the SAME
 * executor also differ here?* If yes, the field carries no information about
 * the executor and excluding it costs nothing. If no, it must be compared.
 */
interface Exclusion {
  /** Which artifact, relative to `.runtime/<run>/`. */
  file: RegExp;
  /** Which field within it (a dotted JSON path). */
  field: RegExp;
  reason: string;
}

const EXCLUSIONS: readonly Exclusion[] = [
  {
    file: /^next\.json$/,
    field: /^current_step_uuid$/,
    reason:
      'the UUIDv7 identity of the in-flight dispatch, minted fresh by the engine on every dispatch that ' +
      'moves the run forward (lib/next.ts mintStepUuid). Two runs of the SAME executor differ here, and ' +
      'the executor is never consulted about it — drive mints it before an executor is chosen.',
  },
  {
    file: /^sessions\/[^/]+\.json$/,
    field: /^session_id$/,
    reason:
      'the pinned claude session id, `randomUUID()` per fresh spawn (commands/drive.ts execStep / ' +
      'runSelfImproveSession). It identifies a session in a FOREIGN system, is minted by drive before ' +
      'either executor is called, and differs between any two runs.',
  },
  {
    file: /^<terminal JSON>$/,
    field: /^run_id$/,
    reason:
      "the caller's own label for the run, passed straight through from --run-id. Both runs share one " +
      'pipeline root (see this file\'s header), so the two ids differ by construction; any two runs differ ' +
      'here whatever executed them.',
  },
] as const;

function isExcluded(d: Divergence, exclusions: readonly Exclusion[]): boolean {
  return exclusions.some((e) => e.file.test(d.file) && e.field.test(d.field));
}

/**
 * EVERYTHING this test compares, as one flat list: every file under
 * `.runtime/<run>/`, plus the terminal JSON the command printed.
 *
 * One list is the point. Two comparison surfaces with two ad-hoc exclusion
 * mechanisms is how a quiet `delete json.cost` ends up outside the minimality
 * guard below; here every exclusion, wherever it applies, is an entry in the
 * one table and is checked by the one test.
 */
function allDivergences(cli: RunResult, sdk: RunResult): Divergence[] {
  const out = treeDivergences(cli.tree, sdk.tree);
  jsonDivergences('<terminal JSON>', '', cli.json, sdk.json, out);
  return out;
}

function compare(cli: RunResult, sdk: RunResult, exclusions: readonly Exclusion[] = EXCLUSIONS): Divergence[] {
  return allDivergences(cli, sdk).filter((d) => !isExcluded(d, exclusions));
}

/** The comparator over two bare trees — used by the unit tests that exercise
 *  the reporting itself without paying for two pipeline runs. */
function compareTrees(a: Tree, b: Tree): Divergence[] {
  return treeDivergences(a, b).filter((d) => !isExcluded(d, EXCLUSIONS));
}

/** Render divergences so the FIRST line names the file and the field. A
 *  generic "the records differ" is useless precisely when this finally fires. */
function describeDivergences(divs: readonly Divergence[]): string {
  const one = (d: Divergence): string =>
    `${d.file} → field \`${d.field}\`\n` +
    `      claude-cli: ${JSON.stringify(d.cli)}\n` +
    `      claude-sdk: ${JSON.stringify(d.sdk)}`;
  return (
    `executor conformance: ${divs.length} divergence(s) between claude-cli and claude-sdk.\n` +
    divs.map((d, i) => `  [${i + 1}] ${one(d)}`).join('\n') +
    '\n  Every field above is part of the engine-visible contract. If one of them genuinely may differ ' +
    'between executors, add it to EXCLUSIONS in this file WITH A REASON — an unexplained exclusion is how ' +
    'a real divergence gets normalised away later.'
  );
}

/** Fail naming the diverging field, or pass silently. */
function assertConform(divs: readonly Divergence[]): void {
  if (divs.length > 0) throw new Error(describeDivergences(divs));
}

// ---------------------------------------------------------------------------
// The two runs — executed once, asserted many times
// ---------------------------------------------------------------------------

interface Conformance {
  world: World;
  cli: RunResult;
  sdk: RunResult;
}

let pending: Promise<Conformance> | null = null;

/** Both runs, executed lazily and exactly once: this file drives two full
 *  pipelines and each spawns real subprocesses, so re-running them per test
 *  would triple the file's cost for no extra coverage. */
function conformance(): Promise<Conformance> {
  pending ??= (async (): Promise<Conformance> => {
    const world = scaffold();
    const spec = engineSpec(world.emitStep);
    const cli = await driveOnce(world, 'claude-cli', 'cli', spec);
    const sdk = await driveOnce(world, 'claude-sdk', 'sdk', spec);
    return { world, cli, sdk };
  })();
  return pending;
}

const TIMEOUT = 120000;

// ---------------------------------------------------------------------------
// Control: the two runs really did use two different front doors
// ---------------------------------------------------------------------------

describe('the comparison is between two executors, not one executor twice', () => {
  test('both runs completed, and each dispatch was served by the door its --executor names', async () => {
    const { cli, sdk } = await conformance();

    for (const r of [cli, sdk]) {
      expect(r.code).toBe(0);
      expect(r.json?.status).toBe('completed');
    }

    // The CLI run really spawned the templated subprocess — no injected
    // executor was in play, so this went through subprocessExecutor,
    // buildExecutorArgv and the stream-json parser.
    expect(cli.dispatches.map((d) => d.door)).toEqual(['claude-cli', 'claude-cli', 'claude-cli']);
    // The SDK run went through sdkExecutor for ALL THREE seams — and never
    // touched the command templates, which were armed at the same fake claude
    // for this run too. A run that fell back for even one seam (c4's exact
    // failure mode) would show a 'claude-cli' entry here.
    expect(sdk.dispatches.map((d) => d.door)).toEqual(['claude-sdk', 'claude-sdk', 'claude-sdk']);

    // …and `--executor=claude-sdk` really selected the SDK path inside drive:
    // sdkDriveSeams reports the (inapplicable) command-template overrides at
    // construction, which only happens when claude-sdk was chosen.
    expect(sdk.stderr).toContain('PIPELINE_DRIVE_EXECUTOR_CMD');
    expect(sdk.stderr).toContain('does NOT apply');
    expect(cli.stderr).not.toContain('does NOT apply');
  }, TIMEOUT);

  test('the fixture covered an agent step, a script step, an improver AND a script-creator', async () => {
    const { world, cli, sdk } = await conformance();

    for (const r of [cli, sdk]) {
      // Three EXECUTOR dispatches: the agent step, then the two
      // self-improvement sessions the agent step's brief set off.
      expect(r.dispatches.map((d) => d.agent)).toEqual([SDK_STEP_AGENT, SDK_IMPROVER_AGENT, SDK_SCRIPT_CREATOR_AGENT]);
      // The agent step's record, and one for each self-improvement session.
      expect([...r.tree.keys()].filter((f) => f.startsWith('records/')).sort()).toEqual([
        'records/improver-1.json',
        'records/plan.json',
        'records/script-1.json',
      ]);
      // The `type: script` step ran IN-PROCESS: it has a ledger entry and an
      // output, and no record file at all — no executor was involved.
      expect(r.tree.has('records/emit.json')).toBe(false);
      expect(r.tree.has('ledger/emit-2.json')).toBe(true);
      expect(JSON.parse(r.tree.get('outputs/emit.json')!)).toEqual({ n: 42 });
      expect(r.json?.improvements_applied).toBe(true);
    }
    // Sanity on the fixture itself: the second step really is a script step,
    // so 'no record file' above means 'ran in-process', not 'never ran'.
    expect(computePlan(world.root).steps[1].script_spec).not.toBeNull();
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// DoD 1 + 2 — the records match on the engine-visible contract
// ---------------------------------------------------------------------------

describe('one pipeline, two executors, one set of artifacts', () => {
  test('every artifact under .runtime/<run>/, and the terminal JSON, match field by field', async () => {
    const { cli, sdk } = await conformance();
    // Not a cherry-picked list: the whole run-state tree plus the terminal
    // JSON, so an artifact added later is compared without anyone remembering
    // to come back here.
    assertConform(compare(cli, sdk));
    // Guard against the comparison being vacuous because nothing was captured.
    expect(cli.tree.size).toBeGreaterThan(5);
    expect([...cli.tree.keys()].sort()).toEqual([...sdk.tree.keys()].sort());
    // The DoD's four surfaces, named, so a refactor that stopped capturing one
    // of them fails here rather than silently shrinking what is compared.
    const files = [...cli.tree.keys()];
    expect(files.some((f) => f.startsWith('records/'))).toBe(true); // the structured records
    expect(files.some((f) => f.startsWith('outputs/'))).toBe(true); // the files the steps wrote
    expect(files).toContain('next.json'); // the run cursor
    expect(cli.json?.status).toBe('completed'); // the outcome
  }, TIMEOUT);

  test('the records carry what the ENGINE said — the two runs agree WITH THE FIXTURE, not merely with each other', async () => {
    const { world, cli, sdk } = await conformance();
    // Two executors that were broken the SAME way would agree with each other
    // and prove nothing. These pin the ABSOLUTE content, so a field dropped by
    // both front doors is still caught.
    const spec = engineSpec(world.emitStep);
    for (const r of [cli, sdk]) {
      expect(JSON.parse(r.tree.get('records/plan.json')!)).toEqual({ ...spec.steps.plan, kind: 'step' });
      expect(JSON.parse(r.tree.get('records/improver-1.json')!)).toEqual(spec.improver);
      // The script-creator record is persisted verbatim, never re-mapped.
      const scriptRecord = JSON.parse(r.tree.get('records/script-1.json')!) as Record<string, unknown>;
      expect(scriptRecord.outcome).toBe(spec.scriptCreator.outcome);
      expect(scriptRecord.script_path).toBe(spec.scriptCreator.script_path);
    }
  }, TIMEOUT);

  test('the two runs are observably the same run: identical progress events, identical recovery rung', async () => {
    const { cli, sdk } = await conformance();
    // The sequence a watching human sees — step.started, step.tool,
    // step.record, improver.session_started, and so on.
    expect(cli.events).toEqual(sdk.events);
    expect(cli.events.length).toBeGreaterThan(5);
    // …and each record came off the SAME rung of the recovery ladder. Equal
    // records reached by different routes is a real behavioural difference
    // that no persisted artifact would show.
    expect(cli.recordSources).toEqual(sdk.recordSources);
    expect(cli.recordSources.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test('every dispatch asked for the same agent and the same model on both executors', async () => {
    const { cli, sdk } = await conformance();
    const asked = (r: RunResult): Array<{ agent: string | null; model: string | null }> =>
      r.dispatches.map((d) => ({ agent: d.agent, model: d.model }));
    expect(asked(cli)).toEqual(asked(sdk));
    // The step dispatch carries the pinned FULL model id through both front
    // doors — `--model {model}` in argv, `options.model` in the SDK call.
    expect(cli.dispatches[0].model).toBe(PINNED_MODEL);
    expect(sdk.dispatches[0].model).toBe(PINNED_MODEL);
    // The two self-improvement sessions carry `model: null` by design
    // (runSelfImproveSession builds them that way) — on BOTH doors, which is
    // itself a conformance fact worth pinning.
    expect(cli.dispatches.slice(1).map((d) => d.model)).toEqual([null, null]);
    expect(sdk.dispatches.slice(1).map((d) => d.model)).toEqual([null, null]);
  }, TIMEOUT);

  test('the model the run REPORTS using reads back as the pinned id, on both executors (d1)', async () => {
    const { world, cli, sdk } = await conformance();
    const spec = engineSpec(world.emitStep);
    for (const r of [cli, sdk]) {
      // Replay the step dispatch's terminal frame and read the model back out
      // of `modelUsage` through d1's own harness. Requesting a model and a run
      // actually using it are different facts, and only the second is
      // evidence: a front door that dropped the model would have logged
      // `model: null`, the frame would carry no `modelUsage`, and
      // assertModelUsedMatches would fail for want of evidence rather than
      // pass quietly.
      const step = r.dispatches[0];
      const frames = engineFrames(spec, step.agent, step.prompt, step.model, null);
      const envelope = envelopeFromResultFrame(frames[frames.length - 1] as Record<string, unknown>);
      assertModelUsedMatches(envelope, PINNED_MODEL);
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// DoD 4 — `type: script` steps are byte-identical, because no executor runs them
// ---------------------------------------------------------------------------

describe('a `type: script` step is byte-identical across executors', () => {
  test('its ledger entry and its output file are the same BYTES, not merely equivalent', async () => {
    const { cli, sdk } = await conformance();
    // The command layer runs `type: script` steps in-process; no executor is
    // involved on either side, so anything but byte equality here means
    // something upstream of the executor seam changed with the flag.
    const scriptFiles = [...cli.tree.keys()].filter((f) => f.startsWith('ledger/') || f === 'outputs/emit.json').sort();
    expect(scriptFiles).toEqual(['ledger/emit-2.json', 'outputs/emit.json']);
    for (const f of scriptFiles) {
      const a = cli.tree.get(f);
      const b = sdk.tree.get(f);
      if (a !== b) {
        throw new Error(
          `\`type: script\` artifact ${f} is NOT byte-identical between executors — but no executor runs a ` +
            `script step, so this cannot be an executor difference.\n  claude-cli: ${JSON.stringify(a)}\n` +
            `  claude-sdk: ${JSON.stringify(b)}`,
        );
      }
    }
    // Not vacuous: the ledger entry really carries the step's record.
    expect(JSON.parse(cli.tree.get('ledger/emit-2.json')!).phase).toBe('finished');
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// DoD 2 — the exclusion list cannot quietly grow
// ---------------------------------------------------------------------------

describe('the exclusion list is closed, reasoned and minimal', () => {
  test('every exclusion states a reason', () => {
    for (const e of EXCLUSIONS) {
      expect(e.reason.length).toBeGreaterThan(40);
      // A reason has to say WHY the field is not executor-evidence, which in
      // every legitimate case is "two runs of the same executor differ here".
      expect(e.reason.toLowerCase()).toContain('run');
    }
  });

  test('every exclusion earns its place — removing it makes the comparison fail', async () => {
    const { cli, sdk } = await conformance();
    for (const e of EXCLUSIONS) {
      const without = EXCLUSIONS.filter((x) => x !== e);
      const divs = compare(cli, sdk, without);
      const covered = divs.filter((d) => e.file.test(d.file) && e.field.test(d.field));
      if (covered.length === 0) {
        throw new Error(
          `the exclusion {file: ${e.file}, field: ${e.field}} excludes NOTHING — the two runs agree on ` +
            'that field. Delete it: an exclusion that is not load-bearing is a licence for a future ' +
            'divergence to be normalised away, bought for nothing.',
        );
      }
    }
  }, TIMEOUT);

  test('the exclusions are narrow — none of them can swallow a step record', async () => {
    const { cli } = await conformance();
    // A wildcard over records/ would make this whole file pass forever.
    for (const file of [...cli.tree.keys()].filter((f) => f.startsWith('records/'))) {
      for (const field of ['outcome', 'summary', 'next_iteration', 'applied', 'script_path', 'has_improvement_brief']) {
        expect(isExcluded({ file, field, cli: 1, sdk: 2 }, EXCLUSIONS)).toBe(false);
      }
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// DoD 5 — the failure NAMES the diverging field
// ---------------------------------------------------------------------------

describe('a divergence is reported by name, never as a generic mismatch', () => {
  test('an injected divergence in a real run names the exact field, the file, and both values', async () => {
    const { world, cli } = await conformance();
    // Re-run the SDK side against an engine that answers ONE field
    // differently — the step record's `summary`. Everything else about the run
    // is unchanged, so this is the shape a real executor drift would take:
    // a single field, in a well-formed record, in a run that reports success.
    const drifted = engineSpec(world.emitStep);
    drifted.steps.plan = { ...drifted.steps.plan, summary: 'planned the work DIFFERENTLY' };
    const bad = await driveOnce(world, 'claude-sdk', 'drift', drifted);

    expect(bad.code).toBe(0); // the run still succeeds — that is why this is invisible without the test
    const divs = compare(cli, bad);
    expect(divs.length).toBeGreaterThan(0);

    let message = '';
    try {
      assertConform(divs);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toBe('');
    // The field is NAMED…
    expect(message).toContain('records/plan.json');
    expect(message).toContain('`summary`');
    // …with both sides' values, so the reader does not have to re-run anything.
    expect(message).toContain('planned the work DIFFERENTLY');
    expect(message).toContain('planned the work');
    // …and the divergence really was the injected one, not incidental noise.
    expect(divs.some((d) => d.file === 'records/plan.json' && d.field === 'summary')).toBe(true);
  }, TIMEOUT);

  test('a file present on one side only is reported by NAME too', () => {
    const a: Tree = new Map([['records/plan.json', '{"outcome":"completed"}']]);
    const b: Tree = new Map();
    const divs = compareTrees(a, b);
    expect(divs).toEqual([{ file: 'records/plan.json', field: '<file>', cli: '<present>', sdk: '<absent>' }]);
    expect(describeDivergences(divs)).toContain('records/plan.json');
  });

  test('a nested field is named by its full path', () => {
    const a: Tree = new Map([['next.json', JSON.stringify({ route: { visits: { plan: 1 } } })]]);
    const b: Tree = new Map([['next.json', JSON.stringify({ route: { visits: { plan: 2 } } })]]);
    const divs = compareTrees(a, b);
    expect(divs).toEqual([{ file: 'next.json', field: 'route.visits.plan', cli: 1, sdk: 2 }]);
    expect(describeDivergences(divs)).toContain('`route.visits.plan`');
  });
});

// ---------------------------------------------------------------------------
// A note on the flag itself
// ---------------------------------------------------------------------------

test('both executors this file compares are accepted --executor values', () => {
  // If EXECUTOR_KINDS ever loses one of these, this file is comparing
  // something that no longer exists.
  expect(EXECUTOR_KINDS).toContain('claude-cli');
  expect(EXECUTOR_KINDS).toContain('claude-sdk');
});
