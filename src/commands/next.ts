// `pipeline next --root <pipeline_root> --run-id <id> [--start <iteration-path>]
//   [--default-model <m>] [--model <step_id>=<m> ...]
//   [--default-effort <level>] [--effort <step_id>=<level> ...]
//   [--var NAME=value ...] [--vars-file <path>]
//   [--record '<json>' | --record-file <path>] [--resume] [--manual-hooks]
//   [--manual-scripts]`
//
// The mechanical orchestration driver. Each call returns the NEXT action the
// pipeline-manager should perform, given the run's persisted state + the
// `--record` of the action just performed. The manager loop becomes:
//   action ← pipeline next        (init: no --record)
//   loop: perform(action); action ← pipeline next --record '<outcome>'
//
// `--record-file <path>` reads the record JSON from a UTF-8 file instead of
// inline argv (mutually exclusive with `--record`); the file content then flows
// through the IDENTICAL parse + state-machine path as an inline `--record`.
// The file is never deleted or modified.
//
// Actions returned to the manager: run-step | merge | run-improver
//   | run-script-creator | retrospective | done | halt | blocked.
//
// `isolation: external` worktree hooks are EXECUTED IN-PROCESS: when the state
// machine emits `provision-worktree` / `finalize-worktree` / `teardown-worktree`,
// this command runs the consumer's `worktree-create.*` / `worktree-finalize.*` /
// `worktree-destroy.*` hook itself (lib/hooks.ts — PIPELINE_WT_* env contract,
// JSON-on-stdout, 600 s create/finalize / 300 s destroy timeouts), emits
// `worktree.created` / `worktree.finalized` / `worktree.destroyed`, feeds the
// synthesized {kind:'worktree',…} record back into the state machine, and
// returns the next REAL action — so the manager never sees these actions. A
// successful provision is surfaced as a top-level `provisioned: {…}` field on the
// printed action; the finalize result as `finalized: {ok, detail}`; a completed
// teardown as `teardown: {ok, detail}`. The finalize stage is OPT-IN + GENERIC (a
// mandatory terminal hook whose ok gates `done`; the plugin has no idea WHAT it
// does) — a run without a `worktree-finalize.*` hook and no `finalize: true`
// frontmatter never finalizes and is byte-for-byte unchanged. `--manual-hooks`
// (escape hatch / debugging) restores the legacy behavior: the raw
// provision/finalize/teardown action is printed for the caller to actuate, and no
// worktree.* event is auto-emitted for it.
//
// `type: script` steps are ALSO EXECUTED IN-PROCESS (roadmap/script-steps/
// DESIGN.md §§5–10): when the engine dispatches a script-type `run-step`, this
// command executes it via lib/script-step.ts (zero LLM tokens), persists its
// `output` to `<root>/.runtime/<run-id>/outputs/<step_id>.json`, writes the
// §6.2 feedback file on failure, applies the §6.3 policy ladder (env ⇒ halt;
// on-failure halt ⇒ halt; on-failure agent ⇒ the engine's once-per-run
// fallback re-dispatch), and feeds the synthesized record back into the engine
// until a non-script action surfaces — chains of script steps collapse into
// one call. Mixed DAG layers are PARTITIONED (§9): script members run
// in-process first (results parked in state.partial_layer_results), the caller
// receives only the agent members. The §7 call budget guards the manager's
// 10-minute Bash window: a pending script whose declared timeout no longer
// fits the remaining budget — when a fresh window would be MATERIALLY better —
// parks the persisted dispatch and returns
// `{action:'continue'}` — the caller performs NOTHING and re-invokes with
// `--record '{"kind":"continue"}'` in a fresh window (`pipeline drive` passes
// an infinite budget, so it never sees `continue`). `--manual-scripts`
// (debugging) returns raw script-type run-step actions to the caller
// unexecuted instead — the caller records the step record itself.
//
// Per-iteration UI events (iteration.* / improver.* / script_creator.* /
// worktree.*) are AUTO-EMITTED in-process via lib/event.ts — best-effort,
// wrapped so an emission failure can never affect the printed action or the
// exit code. The supervisor-owned events (pipeline.*, liveness, mirror
// bindings) and the retrospective-internal improver/script events remain the
// callers' responsibility.
//
// State lives at <pipeline_root>/.runtime/<run-id>/next.json (gitignored). The
// retrospective gate counts <pipeline_root>/.feedback/<run-id>/*.md itself, so
// the manager never has to. Graph routing reuses route.js counters embedded in
// the same state. Exit code: 1 on a `halt` action, 0 otherwise.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, isAbsolute, resolve, basename, dirname, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitBin } from '../lib/git';
import { computePlan, findEnclosingPipelineRoot, normalizeEffort, normalizeModel, type Plan, type PlanStep } from '../lib/plan';
import { parseFrontmatter } from '../lib/frontmatter';
import {
  computeNext,
  haltRun,
  pickMode,
  samePath,
  type ActionStep,
  type LayerResultEntry,
  type NextState,
  type NextRecord,
  type NextOpts,
  type NextAction,
  type StepRecord,
  type WorktreeRecord,
} from '../lib/next';
import { emitEvent } from '../lib/event';
import { statsAppend, statsFinalizeRun } from '../lib/stats';
import { resolveHookScript, runHook, parseHookJson, tail } from '../lib/hooks';
import {
  executeScriptStep,
  parseNextSection,
  resolveParams,
  type BindingSources,
  type ProcessRunner,
  type ScriptStepContext,
  type ScriptStepResult,
} from '../lib/script-step';
import {
  CALL_BUDGET_MS,
  MAX_SCRIPT_EXECS_PER_CALL,
  OUTPUT_PERSIST_CAP_BYTES,
  SAFETY_MARGIN_MS,
  type FailureClass,
  type ScriptStepSpec,
} from '../lib/script-types';
import { MAX_COMPOSITION_DEPTH } from '../lib/compose';
import {
  addVarFlag,
  collectRunVarsFiles,
  hasDeclarations,
  initRunVariables,
  loadVarsFile,
  mergeCliVars,
  type ResolvedVars,
} from '../lib/run-vars';
import { renderActionSteps, sourcePathForRendered } from '../lib/render';
import { buildGateQuestion, parseGateDecision, type GateQuestion } from '../lib/gate';
import {
  COMPOSE_EXEC_GUARD,
  activeChildOf,
  childRunIdFor,
  childRunOutput,
  composedDepthOf,
  deliverChildInputs,
  registerChildRun,
  taskFileFor,
} from '../lib/compose-exec';
import type { ActiveChildRun } from '../lib/next';

interface NextArgs {
  root?: string;
  runId?: string;
  start?: string;
  defaultModel?: string | null;
  /** Per-run step-model overrides from repeated `--model <step_id>=<model>`
   *  flags. undefined = no flag passed (persisted state overrides then apply). */
  modelOverrides?: Record<string, string>;
  /** Set when a `--model` value was malformed (no `<step_id>=<model>` shape) —
   *  a loud usage error, never silently ignored. */
  modelError?: string;
  /** Pipeline-level effort override (`--default-effort`). */
  defaultEffort?: string | null;
  /** Per-run step-effort overrides from repeated `--effort <step_id>=<level>`. */
  effortOverrides?: Record<string, string>;
  /** Set when an `--effort` value was malformed — same loudness as modelError. */
  effortError?: string;
  /** PP_* overrides from repeated `--var NAME=value` flags (env-variables
   *  design, 05 §3). undefined = no flag passed — load-bearing for the
   *  D11 frozen-resume check (an EMPTY set still counts as "supplied"). */
  varFlags?: Record<string, string>;
  /** Path passed via `--vars-file <path>` (dotenv format, strict load). */
  varsFile?: string;
  /** Set when a `--var` value was malformed (no NAME=value shape) — the same
   *  loud usage error as modelError; a typo'd override is never dropped. */
  varsError?: string;
  record?: NextRecord | null;
  /**
   * Set when `--record` was PROVIDED but could not be parsed into an object.
   * Distinct from `record == null` (no `--record` flag at all). The former is a
   * loud operational error (a malformed record must NOT be silently swallowed as
   * an auto-resume); the latter is the legitimate "fresh init / re-spawn" signal.
   */
  recordError?: string;
  /** Set when a `--record` flag was passed at all (even with an empty value) —
   *  used to reject the ambiguous `--record` + `--record-file` combination. */
  recordSeen?: boolean;
  /** Path passed via `--record-file`: read as UTF-8 and parsed EXACTLY like an
   *  inline `--record` value. Mutually exclusive with `--record`. */
  recordFile?: string;
  resume: boolean;
  /** Legacy escape hatch: print raw provision/teardown actions instead of
   *  executing the consumer worktree hooks in-process. */
  manualHooks: boolean;
  /** Debugging escape hatch (DESIGN.md §13, mirrors --manual-hooks): return
   *  raw script-type run-step actions to the caller instead of executing them
   *  in-process — the caller records the step record itself. */
  manualScripts: boolean;
}

/** Result of parsing a `--record` value: a record (or null = absent/empty), or a
 *  loud parse error when a value was supplied that isn't a JSON object. */
type RecordParse = { ok: true; record: NextRecord | null } | { ok: false; error: string };

function asModel(v: string | undefined): string | null {
  return v === undefined || v === '' || v === 'null' || v === 'inherit' ? null : v;
}

/** Fold one `--model` value (`<step_id>=<model>`) onto args.modelOverrides.
 *  Malformed values set modelError (loud usage error in the entry point). */
function addModelOverride(out: { modelOverrides?: Record<string, string>; modelError?: string }, v: string | undefined): void {
  const sep = v?.indexOf('=') ?? -1;
  const id = sep > 0 ? v!.slice(0, sep).trim() : '';
  const model = sep > 0 ? v!.slice(sep + 1).trim() : '';
  if (!id || !model) {
    out.modelError = `--model expects <step_id>=<model>, got '${v ?? ''}'`;
    return;
  }
  (out.modelOverrides ??= {})[id] = model;
}

/** Fold one `--effort` value (`<step_id>=<level>`) onto args.effortOverrides —
 *  the exact addModelOverride contract. */
function addEffortOverride(out: { effortOverrides?: Record<string, string>; effortError?: string }, v: string | undefined): void {
  const sep = v?.indexOf('=') ?? -1;
  const id = sep > 0 ? v!.slice(0, sep).trim() : '';
  const effort = sep > 0 ? v!.slice(sep + 1).trim() : '';
  if (!id || !effort) {
    out.effortError = `--effort expects <step_id>=<level>, got '${v ?? ''}'`;
    return;
  }
  (out.effortOverrides ??= {})[id] = effort;
}

function parseArgs(args: string[]): NextArgs {
  const out: NextArgs = { resume: false, record: null, manualHooks: false, manualScripts: false };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--root') out.root = take(i++);
    else if (eq('--root') !== undefined) out.root = eq('--root');
    else if (a === '--run-id') out.runId = take(i++);
    else if (eq('--run-id') !== undefined) out.runId = eq('--run-id');
    else if (a === '--start') out.start = take(i++);
    else if (eq('--start') !== undefined) out.start = eq('--start');
    else if (a === '--default-model') out.defaultModel = asModel(take(i++));
    else if (eq('--default-model') !== undefined) out.defaultModel = asModel(eq('--default-model'));
    else if (a === '--model') addModelOverride(out, take(i++));
    else if (eq('--model') !== undefined) addModelOverride(out, eq('--model'));
    else if (a === '--default-effort') out.defaultEffort = asModel(take(i++));
    else if (eq('--default-effort') !== undefined) out.defaultEffort = asModel(eq('--default-effort'));
    else if (a === '--effort') addEffortOverride(out, take(i++));
    else if (eq('--effort') !== undefined) addEffortOverride(out, eq('--effort'));
    else if (a === '--var') addVarFlag(out, take(i++));
    else if (eq('--var') !== undefined) addVarFlag(out, eq('--var'));
    else if (a === '--vars-file') out.varsFile = take(i++);
    else if (eq('--vars-file') !== undefined) out.varsFile = eq('--vars-file');
    else if (a === '--record-file') out.recordFile = take(i++);
    else if (eq('--record-file') !== undefined) out.recordFile = eq('--record-file');
    else if (a === '--record') {
      out.recordSeen = true;
      applyRecord(out, parseRecord(take(i++)));
    } else if (eq('--record') !== undefined) {
      out.recordSeen = true;
      applyRecord(out, parseRecord(eq('--record')));
    }
    else if (a === '--resume') out.resume = true;
    else if (a === '--manual-hooks') out.manualHooks = true;
    else if (a === '--manual-scripts') out.manualScripts = true;
  }
  return out;
}

/** Thread a parsed `--record` onto NextArgs: a good parse sets `record`; a bad
 *  one records the error (surfaced as a loud exit-2 by runNext) instead of being
 *  conflated with the no-record case. */
function applyRecord(out: NextArgs, p: RecordParse): void {
  if (p.ok) out.record = p.record;
  else out.recordError = p.error;
}

/**
 * Double any backslash that does not begin a valid JSON escape sequence
 * (`" \ / b f n r t u`). This rescues Windows paths embedded in a `--record`
 * value (e.g. `C:\Projects\Repo` → `C:\\Projects\\Repo`) so `JSON.parse`
 * accepts them, without disturbing already-valid escapes (`\\`, `\"`, `\n`, …).
 *
 * Best-effort: a path segment beginning with a JSON-escape letter (e.g.
 * `C:\temp` → `\t`) is left as a valid escape and can still be mis-read; the
 * CORRECTNESS guarantee for that case is the loud parse-error path, not this
 * normalization.
 */
function normalizeJsonBackslashes(raw: string): string {
  return raw.replace(/\\(.)/gs, (m, next: string) => ('"\\/bfnrtu'.includes(next) ? m : '\\\\' + next));
}

/**
 * Parse a `--record` value.
 *   - absent / empty / whitespace        → { ok:true, record:null }  (no record)
 *   - a JSON object (possibly after backslash normalization) → { ok:true, record }
 *   - anything else (unparseable, or valid JSON that isn't an object)
 *                                          → { ok:false, error }       (LOUD)
 *
 * The loud path is what stops a malformed record — most commonly an unescaped
 * Windows path whose `\P`/`\R` etc. are invalid JSON escapes — from being
 * silently treated as "no record" and auto-resumed, which would discard the
 * completed step the record was reporting.
 */
function parseRecord(raw: string | undefined): RecordParse {
  if (!raw || !raw.trim()) return { ok: true, record: null };
  // undefined = JSON.parse threw; null = parsed but not a plain object.
  const tryParse = (s: string): NextRecord | null | undefined => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as NextRecord) : null;
    } catch {
      return undefined;
    }
  };
  let parsed = tryParse(raw);
  if (parsed === undefined) parsed = tryParse(normalizeJsonBackslashes(raw));
  if (parsed === undefined) {
    return { ok: false, error: `--record is not valid JSON (even after backslash normalization): ${raw}` };
  }
  if (parsed === null) {
    return { ok: false, error: `--record must be a JSON object, got: ${raw}` };
  }
  return { ok: true, record: parsed };
}

function stateDir(root: string, runId: string): string {
  return join(root, '.runtime', runId);
}

function loadState(root: string, runId: string): NextState | null {
  const f = join(stateDir(root, runId), 'next.json');
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as NextState;
  } catch {
    return null;
  }
}

/**
 * D11 frozen-variables rejection (env-variables design): supplying
 * `--var`/`--vars-file` against a run whose next.json ALREADY carries a
 * frozen `variables` map is an operator USAGE error — the run itself is
 * intact and a flag-less resume continues it, so this must be rejected
 * BEFORE the engine runs (never routed through a 'halt', which would emit a
 * phantom run.halted event / terminal stats for a healthy run). Also rejects
 * supplying variables while a COMPOSED CHILD run is active: the router would
 * descend into the child and silently drop the flags (the L10-class
 * invisible misconfiguration this feature forbids).
 *
 * Returns the error text, or null when the supply is legal (no flags, a
 * fresh run, or the F10 legacy one-time init). Used by `pipeline next` and
 * `pipeline drive` (exit 2) and defensively at the invokeNext entry.
 */
export function frozenVariablesError(
  root: string,
  runId: string,
  cliVars: Record<string, string> | undefined,
): string | null {
  if (cliVars === undefined) return null;
  const state = loadState(root, runId);
  if (state === null) return null;
  if (Object.prototype.hasOwnProperty.call(state, 'variables')) {
    return (
      'variables are frozen for this run (resolved and persisted in next.json at run init) — ' +
      'start a new run to change them, or resume without --var/--vars-file'
    );
  }
  if (state.active_child != null) {
    return (
      'a composed child pipeline run is active for this run — variables can only be supplied ' +
      'when starting a run, not while a child run is in flight'
    );
  }
  return null;
}

function saveState(root: string, runId: string, state: NextState): void {
  // Self-contained gitignore so run state never pollutes the consumer's commits.
  mkdirSync(join(root, '.runtime'), { recursive: true });
  const gi = join(root, '.runtime', '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '*\n', 'utf8');
  const dir = stateDir(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'next.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** Resolve an OFF-PLAN step's own model from disk: its `model:` frontmatter,
 *  else the `model:` of its OWN enclosing PIPELINE.md (walking up, bounded) —
 *  a family target-rooted run reaches hub-shared steps this way, and those
 *  steps' pinned models must not be silently dropped. Returns null when nothing
 *  yields a model (the engine then falls back to the run default). Injected
 *  into the pure engine via opts.resolveOffPlanModel; every failure is
 *  best-effort null — never affects the action or exit code. */
function resolveOffPlanModel(path: string): string | null {
  try {
    const { fields } = parseFrontmatter(readFileSync(path, 'utf8'));
    const m = normalizeModel(fields.model);
    if (m.model !== null) return m.model;
  } catch {
    return null; // unreadable step file — the executor will fail loudly, not us
  }
  try {
    // maxDepth 12 preserved from the historical inline walk.
    const root = findEnclosingPipelineRoot(dirname(resolve(path)), 12);
    if (root !== null) {
      return normalizeModel(parseFrontmatter(readFileSync(join(root, 'PIPELINE.md'), 'utf8')).fields.model).model;
    }
  } catch {
    // best-effort — fall through to null
  }
  return null;
}

/** The `effort:` companion to resolveOffPlanModel — same walk, same
 *  best-effort-null contract. */
function resolveOffPlanEffort(path: string): string | null {
  try {
    const { fields } = parseFrontmatter(readFileSync(path, 'utf8'));
    const ef = normalizeEffort(fields.effort);
    if (ef.effort !== null) return ef.effort;
  } catch {
    return null;
  }
  try {
    // maxDepth 12 preserved from the historical inline walk.
    const root = findEnclosingPipelineRoot(dirname(resolve(path)), 12);
    if (root !== null) {
      return normalizeEffort(parseFrontmatter(readFileSync(join(root, 'PIPELINE.md'), 'utf8')).fields.effort).effort;
    }
  } catch {
    // best-effort — fall through to null
  }
  return null;
}

/** Count <root>/.feedback/<run-id>/*.md — gates the end-of-run retrospective. */
function feedbackCount(root: string, runId: string): number {
  const dir = join(root, '.feedback', runId);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((n: string) => n.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Auto-emitted UI events (best-effort; NEVER affect the action or exit code)
// ---------------------------------------------------------------------------

/** One `k=v` argv element for emitEvent. Values are passed as single array
 *  elements (no shell), so spaces are safe; null/undefined become the literal
 *  'null' per the writer's kv coercion. */
function kv(k: string, v: unknown): string {
  return `${k}=${v === null || v === undefined ? 'null' : String(v)}`;
}

function safeEmit(eventType: string, argv: string[]): void {
  try {
    emitEvent(eventType, argv);
  } catch {
    // Emissions are best-effort — never let one affect the run.
  }
}

/** In-process script-execution tag for the completion emitters (DESIGN.md
 *  §12): step_type:"script" (+ failure_class on failure) on the labeled event/
 *  stats line, and an optional terminal override (a failed script whose agent
 *  fallback is about to dispatch is NOT terminal despite its halted-shaped
 *  record). Absent (the normal caller-record path) ⇒ byte-identical output. */
interface ScriptTag {
  /** The dispatch-type label for the tag: 'script' (the default — every
   *  pre-gate call site) or 'gate' (a T3-14 approval-gate completion). */
  stepType?: 'script' | 'gate';
  failureClass: FailureClass | null;
  terminal?: boolean;
}

/** Append the §12 script tag (step_type + optional failure_class) to a
 *  completion-event argv — shared by the step and layer branches of
 *  emitCompletionEvents. No tag ⇒ argv untouched (byte-identical legacy events). */
function pushScriptTag(argv: string[], script?: ScriptTag): void {
  if (!script) return;
  argv.push(kv('step_type', script.stepType ?? 'script'));
  if (script.failureClass) argv.push(kv('failure_class', script.failureClass));
}

/** Label the just-recorded completion from the PREVIOUS persisted state. Fires
 *  on an incoming `--record` only (both gated on the record kind AND the phase
 *  the run was parked in, so a wrong-phase record emits nothing). `script` is
 *  set ONLY by the in-process script executions (never derived from the plan:
 *  a §6.3 fallback re-execution of a script-typed STEP is an agent dispatch
 *  and must not be tagged). */
function emitCompletionEvents(
  plan: Plan,
  prev: NextState | null,
  record: NextRecord | null,
  runId: string,
  script?: ScriptTag,
  mapPath: (p: string) => string = (p) => p,
): void {
  if (!prev || !record) return;
  // Worktree-scoped runs (P2/b3): engine state carries WORKTREE paths (the
  // whole plan is worktree-based); events/stats/UI receive the prefix-swapped
  // MAIN author path via `mapPath` (identity on every other run — 05.1.3).
  const mp = (p: string | null | undefined): string | null => (p == null ? null : mapPath(p));
  if (record.kind === 'step' && prev.phase === 'await-step') {
    const terminal =
      script?.terminal ??
      (record.next_iteration === 'PIPELINE_COMPLETE' ||
        record.outcome === 'halted' ||
        record.outcome === 'depth-exhausted');
    const argv = [
      kv('run_id', runId),
      kv('iteration_path', mp(prev.current_path)),
      kv('outcome', record.outcome),
      kv('next_iteration_path', record.next_iteration ?? null),
      kv('has_improvement_brief', record.has_improvement_brief === true),
      kv('has_blocker_delegation', record.outcome === 'blocked-delegating'),
      kv('halt_reason', record.halt_reason ?? null),
      kv('terminal', terminal),
    ];
    pushScriptTag(argv, script);
    safeEmit('iteration.completed', argv);
    return;
  }
  if (record.kind === 'layer' && prev.phase === 'await-step') {
    for (const entry of record.results ?? []) {
      const step = plan.steps.find((s) => s.step_id === entry.step_id);
      const argv = [
        kv('run_id', runId),
        kv('iteration_path', mp(step?.path)),
        kv('outcome', entry.outcome),
        kv('has_improvement_brief', entry.has_improvement_brief === true),
        kv('halt_reason', entry.halt_reason ?? null),
        kv('terminal', false),
        kv('step_id', entry.step_id),
      ];
      pushScriptTag(argv, script);
      safeEmit('iteration.completed', argv);
    }
    return;
  }
  if (record.kind === 'improver' && prev.phase === 'await-improver') {
    safeEmit('improver.completed', [
      kv('run_id', runId),
      kv('iteration_path', mp(prev.improve_target)),
      kv('applied', record.applied === true),
      kv('has_script_brief', (record.script_briefs ?? 0) > 0),
    ]);
    return;
  }
  if (record.kind === 'script' && prev.phase === 'await-script') {
    safeEmit('script_creator.completed', [
      kv('run_id', runId),
      kv('iteration_path', mp(prev.improve_target)),
      kv('script_path', record.script_path ?? null),
      kv('outcome', record.outcome ?? null),
    ]);
  }
  // kind 'retro' / 'merge': no per-iteration event. kind 'worktree': the
  // in-process hook execution emits worktree.*; a --manual-hooks caller emits
  // its own, so a manually-recorded worktree record emits nothing here.
}

// ---------------------------------------------------------------------------
// Per-run measurement (lib/stats.ts) — pure software, PIPELINE_STATS_ENABLED
// gated (default ON). Timeline lines mirror the event emissions; every call is
// best-effort and never affects the action, exit code, or events.
// ---------------------------------------------------------------------------

function statsNoteRecord(
  root: string,
  runId: string,
  prev: NextState | null,
  record: NextRecord | null,
  script?: ScriptTag,
  mapPath: (p: string) => string = (p) => p,
): void {
  if (!prev || !record) return;
  // step_type/failure_class tags mirror the event emitter (§12): set only for
  // in-process script/gate resolutions, additive-only so legacy lines stay
  // identical.
  const tag = script
    ? { step_type: script.stepType ?? 'script', ...(script.failureClass ? { failure_class: script.failureClass } : {}) }
    : {};
  if (record.kind === 'step' && prev.phase === 'await-step') {
    // step_id must ride the completion (additive): the fold pairs started/
    // completed lines via stepIdOf, which PREFERS step_id — the started line
    // always carries it, so a completion keyed only by path never pairs when
    // a step's explicit step_id differs from its filename stem (e.g. the
    // documented `03-wait-ci.md` + `step_id: wait-ci` shape) and the step
    // loses its wall-clock seconds.
    statsAppend(root, runId, {
      k: 'step.completed',
      // Worktree-scoped runs (P2/b3): the state cursor is a WORKTREE path —
      // swap back to the MAIN author path so .stats pairing/placement stays
      // stable (identity on every other run).
      path: prev.current_path === null ? null : mapPath(prev.current_path),
      step_id: prev.current_step_id ?? null,
      outcome: record.outcome,
      ...tag,
    });
    return;
  }
  if (record.kind === 'layer' && prev.phase === 'await-step') {
    for (const entry of record.results ?? []) {
      statsAppend(root, runId, { k: 'step.completed', step_id: entry.step_id, outcome: entry.outcome, ...tag });
    }
    return;
  }
  if (record.kind === 'improver' && prev.phase === 'await-improver') {
    statsAppend(root, runId, { k: 'improver.completed', applied: record.applied === true });
    return;
  }
  if (record.kind === 'script' && prev.phase === 'await-script') {
    statsAppend(root, runId, { k: 'script.completed', outcome: record.outcome ?? null });
    return;
  }
  if (record.kind === 'merge') {
    statsAppend(root, runId, { k: 'merge.completed', conflict: record.conflict === true });
    return;
  }
  if (record.kind === 'retro') statsAppend(root, runId, { k: 'retro.completed' });
}

function statsNoteAction(root: string, runId: string, action: NextAction): void {
  if (action.action === 'run-step') {
    for (const step of action.steps) {
      statsAppend(root, runId, {
        k: 'step.started',
        // SOURCE path label (env-variables a5): completion lines are keyed off
        // engine state (prev.current_path — always the source), so a rendered
        // `.runtime/<run>/rendered/` dispatch path would de-pair the
        // started/completed lines and put volatile run-scoped paths in .stats.
        // Identical to step.path on every non-rendered dispatch (the engine
        // always sets source_path).
        path: step.source_path,
        step_id: step.step_id,
        model: step.model,
        effort: step.effort,
        // Additive step_type tag on SCRIPT/PIPELINE/GATE dispatches only
        // (agent lines stay byte-identical) — T32 counts llm_steps as the
        // untagged step.started lines, and none of a script, a composed
        // child-run dispatch, or an approval gate spawns an LLM itself. A
        // §6.3 fallback dispatch is type 'agent' ⇒ untagged (an LLM step is
        // exactly what it is).
        ...(step.type === 'script' || step.type === 'pipeline' || step.type === 'gate'
          ? { step_type: step.type }
          : {}),
      });
    }
    return;
  }
  if (action.action === 'run-improver') {
    statsAppend(root, runId, { k: 'improver.started' });
    return;
  }
  if (action.action === 'run-script-creator') {
    statsAppend(root, runId, { k: 'script.started' });
    return;
  }
  if (action.action === 'blocked') statsAppend(root, runId, { k: 'run.blocked' });
}

function statsNoteTerminal(root: string, runId: string, action: NextAction): void {
  if (action.action === 'done') {
    statsFinalizeRun(root, runId, 'completed', null);
    return;
  }
  if (action.action === 'halt') {
    statsFinalizeRun(root, runId, action.status ?? 'halted', action.reason ?? null);
  }
}

/** Announce the outgoing action (just before printing it). Tier-1
 *  run-improver / run-script-creator only — the retrospective's internal
 *  improver/script spawns are invisible to the CLI and stay manager-emitted. */
function emitStartedEvents(
  action: NextAction,
  runId: string,
  mapPath: (p: string) => string = (p) => p,
  resumedReentry = false,
): void {
  if (action.action === 'run-step') {
    for (const step of action.steps) {
      const argv = [
        kv('run_id', runId),
        // SOURCE path label (env-variables a5): iteration.completed is labeled
        // from engine state (prev.current_path — always the source), and the
        // v4 sequential fold pairs started/completed by consecutive paths — a
        // rendered dispatch path would break the pairing and surface volatile
        // `.runtime/<run>/rendered/` paths in the UI. Identical to step.path
        // on every non-rendered dispatch (the engine always sets source_path).
        kv('iteration_path', step.source_path),
        kv('index', step.index),
        kv('resolved_model', step.model),
        kv('resolved_effort', step.effort),
      ];
      // Additive v5 G5 tag (e7 DEFECT-3): this dispatch re-issues a step that
      // was already dispatched before (a --resume/auto-resume re-entry parked
      // in 'await-step' — needs-input answer delivery, crash re-spawn, blocked
      // resume). The cloud ingest keys its resume-from-awaiting / attempt
      // bookkeeping on it; v4 consumers ignore the extra field.
      if (resumedReentry) argv.push(kv('resumed', true));
      // Additive §12 tag, keyed on the DISPATCH type (a §6.3 fallback
      // re-dispatch of a script step is type 'agent' ⇒ untagged). Pipeline
      // dispatches (T3-10 child runs) and approval gates (T3-14) are tagged
      // the same way.
      if (step.type === 'script' || step.type === 'pipeline' || step.type === 'gate')
        argv.push(kv('step_type', step.type));
      // Additive A2 tag (04 §retries.6): present ONLY on a retry re-dispatch,
      // the 1-based attempt number engine-set on ActionStep.retry.
      if (step.retry !== undefined) argv.push(kv('retry', step.retry));
      // step_id ONLY on a concurrent layer (v4 rule) — sequential/graph events
      // omit it so older folds keep the consecutive-window behavior.
      if (action.concurrent === true) argv.push(kv('step_id', step.step_id));
      safeEmit('iteration.started', argv);
    }
    return;
  }
  if (action.action === 'run-improver') {
    // Worktree-scoped runs (P2/b3): the ACTION keeps the worktree target (the
    // improver edits the run's working tree); the EVENT gets the prefix-swapped
    // main path (identity on every other run — 05.1.3).
    safeEmit('improver.started', [kv('run_id', runId), kv('iteration_path', mapPath(action.iteration_path))]);
    return;
  }
  if (action.action === 'run-script-creator') {
    safeEmit('script_creator.started', [kv('run_id', runId), kv('iteration_path', mapPath(action.iteration_path))]);
  }
}

// ---------------------------------------------------------------------------
// In-process worktree-hook execution (isolation: external)
// ---------------------------------------------------------------------------

const CREATE_TIMEOUT_MS = 600_000; // create does submodule worktrees + pulls
const DESTROY_TIMEOUT_MS = 300_000;
const FINALIZE_TIMEOUT_MS = 600_000; // finalize may do arbitrary consumer work (commit/push/…) — create-like budget

/** Effective hook timeout: `PIPELINE_HOOK_TIMEOUT_MS` (a positive integer)
 *  overrides every hook budget — injectable so tests can exercise the timeout
 *  path with short values. Read per call, never cached at module load. */
function hookTimeoutMs(base: number): number {
  const v = Number(process.env.PIPELINE_HOOK_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : base;
}

type ProvisionAction = Extract<NextAction, { action: 'provision-worktree' }>;
type FinalizeAction = Extract<NextAction, { action: 'finalize-worktree' }>;
type TeardownAction = Extract<NextAction, { action: 'teardown-worktree' }>;

export interface ProvisionedInfo {
  worktree_path: string;
  branch: string | null;
  env_file: string | null;
}

export interface FinalizeInfo {
  ok: boolean;
  detail: string | null;
}

export interface TeardownInfo {
  ok: boolean;
  detail: string | null;
}

/** Execute the consumer's worktree-create hook per the FROZEN contract
 *  (PIPELINE_WT_* env vars; stdout = ONE JSON object with worktree_path;
 *  idempotent per name). Emits worktree.created (ok true/false) and returns the
 *  {kind:'worktree',phase:'provisioned',…} record to feed the state machine. */
function execCreateHook(
  action: ProvisionAction,
  hookDirAbs: string,
  projectRoot: string,
  pipelineRootAbs: string,
): { record: WorktreeRecord; provisioned: ProvisionedInfo | null; failedWorktreePath: string | null } {
  const fail = (
    detail: string,
    failedWorktreePath: string | null = null,
  ): { record: WorktreeRecord; provisioned: null; failedWorktreePath: string | null } => {
    safeEmit('worktree.created', [kv('run_id', action.run_id), kv('ok', false), kv('detail', detail)]);
    return { record: { kind: 'worktree', phase: 'provisioned', ok: false, detail }, provisioned: null, failedWorktreePath };
  };

  const script = resolveHookScript(hookDirAbs, 'worktree-create');
  if (!script) {
    return fail(`isolation: external but no ${hookDirAbs}/worktree-create.* found`);
  }

  const env: Record<string, string> = {
    PIPELINE_WT_ACTION: 'create',
    PIPELINE_WT_RUN_ID: action.run_id,
    PIPELINE_WT_NAME: action.name,
    PIPELINE_WT_PIPELINE_NAME: basename(pipelineRootAbs),
    PIPELINE_WT_PIPELINE_ROOT: pipelineRootAbs,
    PIPELINE_WT_PROJECT_ROOT: projectRoot,
    PIPELINE_WT_BASE_BRANCH: action.base_branch,
    PIPELINE_WT_SUBMODULES: action.submodules.join(','),
    PIPELINE_WT_DRY_RUN: '0',
  };
  const timeoutMs = hookTimeoutMs(CREATE_TIMEOUT_MS);
  const r = runHook(script, env, projectRoot, timeoutMs);
  const exitedClean = r.code === 0 && !r.timedOut && !r.error;
  const parsed = exitedClean ? parseHookJson(r.stdout) : null;
  const wtPath = parsed && typeof parsed.worktree_path === 'string' ? parsed.worktree_path : null;

  if (wtPath === null) {
    const why = r.timedOut
      ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : r.error
        ? `failed to spawn (${r.error})`
        : !exitedClean
          ? `exited ${r.code}`
          : 'stdout not JSON';
    return fail(`worktree-create hook ${why}: ${tail(r.stderr || r.stdout)}`);
  }

  // The contract requires an ABSOLUTE worktree_path — a relative one is a
  // create-hook failure (the same halt as garbage stdout), but the path is
  // still handed to the best-effort create-failed cleanup.
  if (!isAbsolute(wtPath)) {
    return fail(`worktree-create hook returned a non-absolute worktree_path '${wtPath}'`, wtPath);
  }

  const branch = typeof parsed!.branch === 'string' ? (parsed!.branch as string) : null;
  const envFile = typeof parsed!.env_file === 'string' ? (parsed!.env_file as string) : null;
  safeEmit('worktree.created', [
    kv('run_id', action.run_id),
    kv('worktree_path', wtPath),
    kv('branch', branch),
    kv('env_file', envFile),
    kv('ok', true),
    kv('hook_dir', action.hook_dir),
  ]);
  return {
    record: { kind: 'worktree', phase: 'provisioned', worktree_path: wtPath, branch, env_file: envFile },
    provisioned: { worktree_path: wtPath, branch, env_file: envFile },
    failedWorktreePath: null,
  };
}

/** A3: best-effort cleanup after a FAILED create. The create hook may have done
 *  partial work before failing/timing out/printing garbage, so invoke the
 *  consumer's destroy hook ONCE with the additive `PIPELINE_WT_OUTCOME=
 *  create-failed` (full destroy-style env; `PIPELINE_WT_WORKTREE_PATH` only
 *  when the failed create output yielded one). STRICTLY fire-and-forget: never
 *  throws and never changes the halt outcome; `worktree.destroyed` is emitted
 *  ONLY when the destroy hook reports ok. */
function execCreateFailedCleanup(
  action: ProvisionAction,
  hookDirAbs: string,
  projectRoot: string,
  pipelineRootAbs: string,
  failedWorktreePath: string | null,
): void {
  try {
    const script = resolveHookScript(hookDirAbs, 'worktree-destroy');
    if (!script) return;
    const env: Record<string, string> = {
      PIPELINE_WT_ACTION: 'destroy',
      PIPELINE_WT_RUN_ID: action.run_id,
      PIPELINE_WT_NAME: action.name,
      PIPELINE_WT_PIPELINE_ROOT: pipelineRootAbs,
      PIPELINE_WT_PROJECT_ROOT: projectRoot,
      PIPELINE_WT_OUTCOME: 'create-failed',
      // ALWAYS '0' here: a failed create leaves a partial slot whose branch (if
      // any) is evidence — the cleanup must never reap it.
      PIPELINE_WT_DELETE_BRANCHES: '0',
      PIPELINE_WT_DRY_RUN: '0',
    };
    if (failedWorktreePath !== null) env.PIPELINE_WT_WORKTREE_PATH = failedWorktreePath;
    const r = runHook(script, env, projectRoot, hookTimeoutMs(DESTROY_TIMEOUT_MS));
    const exitedClean = r.code === 0 && !r.timedOut && !r.error;
    const parsed = parseHookJson(r.stdout);
    if (exitedClean && parsed?.ok !== false) {
      safeEmit('worktree.destroyed', [
        kv('run_id', action.run_id),
        kv('worktree_path', failedWorktreePath),
        kv('ok', true),
        kv('outcome', 'create-failed'),
        kv('detail', typeof parsed?.detail === 'string' ? parsed.detail : null),
      ]);
    }
  } catch {
    // Best-effort only — a cleanup failure must never affect the halt.
  }
}

/** Execute the consumer's MANDATORY worktree-finalize hook. UNLIKE destroy (a
 *  soft-fail that never strands the run), finalize is STRICT must-succeed: only
 *  an explicit `{"ok":true}` on a clean exit passes; a missing hook, non-zero
 *  exit, timeout, spawn error, or absent/false `ok` FAILS — the state machine
 *  then halts the run and the worktree is preserved. Same FROZEN PIPELINE_WT_*
 *  env style as create/destroy (+ ACTION=finalize). GENERIC: the plugin passes
 *  the worktree context and inspects only `ok` — it never inspects, requires, or
 *  cares WHAT the hook did (commit/push/bump/anything). Emits worktree.finalized. */
function execFinalizeHook(
  action: FinalizeAction,
  hookDirAbs: string,
  projectRoot: string,
  pipelineRootAbs: string,
): { record: WorktreeRecord; finalize: FinalizeInfo } {
  const script = resolveHookScript(hookDirAbs, 'worktree-finalize');
  let ok: boolean;
  let detail: string | null;
  if (!script) {
    // Opted in (e.g. `finalize: true` frontmatter) but no hook exists → the run
    // asked to finalize and cannot → FAIL loud (must-succeed gate). (When the
    // opt-in was hook-PRESENCE, this branch is unreachable.)
    ok = false;
    detail = `no ${hookDirAbs}/worktree-finalize.* hook found`;
  } else {
    const env: Record<string, string> = {
      PIPELINE_WT_ACTION: 'finalize',
      PIPELINE_WT_RUN_ID: action.run_id,
      PIPELINE_WT_NAME: action.name,
      PIPELINE_WT_PIPELINE_NAME: basename(pipelineRootAbs),
      PIPELINE_WT_PIPELINE_ROOT: pipelineRootAbs,
      PIPELINE_WT_PROJECT_ROOT: projectRoot,
      PIPELINE_WT_BASE_BRANCH: action.base_branch,
      PIPELINE_WT_SUBMODULES: action.submodules.join(','),
      PIPELINE_WT_WORKTREE_PATH: action.worktree_path ?? '',
      PIPELINE_WT_OUTCOME: action.outcome,
      PIPELINE_WT_DRY_RUN: '0',
    };
    const timeoutMs = hookTimeoutMs(FINALIZE_TIMEOUT_MS);
    const r = runHook(script, env, projectRoot, timeoutMs);
    const exitedClean = r.code === 0 && !r.timedOut && !r.error;
    const parsed = exitedClean ? parseHookJson(r.stdout) : null;
    ok = exitedClean && parsed?.ok === true; // STRICT: require an explicit ok:true
    if (typeof parsed?.detail === 'string') {
      detail = parsed.detail;
    } else if (ok) {
      detail = null;
    } else {
      const why = r.timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : r.error
          ? `failed to spawn (${r.error})`
          : !exitedClean
            ? `exited ${r.code}`
            : 'stdout missing {"ok":true}';
      detail = `worktree-finalize hook ${why}: ${tail(r.stderr || r.stdout)}`;
    }
  }
  safeEmit('worktree.finalized', [
    kv('run_id', action.run_id),
    kv('worktree_path', action.worktree_path),
    kv('ok', ok),
    kv('outcome', action.outcome),
    kv('detail', detail),
  ]);
  return { record: { kind: 'worktree', phase: 'finalized', ok, detail }, finalize: { ok, detail } };
}

/** Execute the consumer's worktree-destroy hook per the FROZEN contract
 *  ({"ok":true} / {"ok":false,"detail"} soft-fail / non-zero hard-fail). A
 *  missing or failing hook NEVER strands the run — the ok:false record still
 *  advances the state machine to terminal. Emits worktree.destroyed. */
function execDestroyHook(
  action: TeardownAction,
  hookDirAbs: string,
  projectRoot: string,
  pipelineRootAbs: string,
): { record: WorktreeRecord; teardown: TeardownInfo } {
  const script = resolveHookScript(hookDirAbs, 'worktree-destroy');
  let ok: boolean;
  let detail: string | null;
  if (!script) {
    ok = false;
    detail = `no ${hookDirAbs}/worktree-destroy.* hook found`;
  } else {
    const env: Record<string, string> = {
      PIPELINE_WT_ACTION: 'destroy',
      PIPELINE_WT_RUN_ID: action.run_id,
      PIPELINE_WT_NAME: action.name,
      PIPELINE_WT_PIPELINE_ROOT: pipelineRootAbs,
      PIPELINE_WT_PROJECT_ROOT: projectRoot,
      PIPELINE_WT_WORKTREE_PATH: action.worktree_path ?? '',
      PIPELINE_WT_OUTCOME: action.outcome,
      // Outcome-aware (decided by the engine in emitTeardown): '1' only on a
      // COMPLETED run that has not opted out via `delete_branches: false`
      // frontmatter — the run branch dies with the worktree so a finished run
      // leaks nothing. halted/depth-exhausted always get '0' (preserve for
      // debugging/resume).
      PIPELINE_WT_DELETE_BRANCHES: action.delete_branches ? '1' : '0',
      PIPELINE_WT_DRY_RUN: '0',
    };
    const timeoutMs = hookTimeoutMs(DESTROY_TIMEOUT_MS);
    const r = runHook(script, env, projectRoot, timeoutMs);
    const exitedClean = r.code === 0 && !r.timedOut && !r.error;
    const parsed = parseHookJson(r.stdout);
    ok = exitedClean && parsed?.ok !== false;
    if (typeof parsed?.detail === 'string') {
      detail = parsed.detail;
    } else if (ok) {
      detail = null;
    } else {
      const why = r.timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : r.error
          ? `failed to spawn (${r.error})`
          : `exited ${r.code}`;
      detail = `worktree-destroy hook ${why}: ${tail(r.stderr || r.stdout)}`;
    }
  }
  safeEmit('worktree.destroyed', [
    kv('run_id', action.run_id),
    kv('worktree_path', action.worktree_path),
    kv('ok', ok),
    kv('outcome', action.outcome),
    kv('detail', detail),
  ]);
  return { record: { kind: 'worktree', phase: 'torn-down', ok, detail }, teardown: { ok, detail } };
}

// ---------------------------------------------------------------------------
// Worktree-scoped pipeline I/O (P2/b3 — fix-fundamental-issues 05.1; D3/D6/D14)
//
// For `isolation: external` runs the pipeline execution scope is the tree the
// run works in: the run's plan is computed FROM the provisioned worktree's
// pipeline copy (`computePlan(<worktree>/<pipeline-root-rel>)`), so dispatch
// paths, ledger keys, `## Next` parsing, rendered copies, outputs, and
// improver/script-creator targets are all worktree paths and self-improvement
// edits ride the run's own finalize commit/PR instead of dirtying main (the
// verified D3 flaw). Run BOOKKEEPING stays main-scoped (D6): next.json, the
// events journal, `.stats`, liveness. Observability surfaces receive the
// prefix-swapped MAIN author path via the `(worktree_prefix, main_prefix)`
// pair frozen into next.json (05.1.3).
//
// Rollout flag: `PIPELINE_WORKTREE_SCOPED` (default ON; `0` restores the
// legacy main-scoped reads byte-identically). The flag is FROZEN per-run into
// next.json at init — a mid-run flip can never mix path models in one run.
// Native-parallel and in-place isolation modes change NOTHING (rule table
// 05.1); composed CHILD runs and `--manual-hooks` runs stay main-scoped.
// ---------------------------------------------------------------------------

/** The `PIPELINE_WORKTREE_SCOPED` rollout flag — default ON; only an explicit
 *  0/false/off/no disables scoping. Read once per run at init (then frozen). */
function worktreeScopedEnvOn(): boolean {
  const v = (process.env.PIPELINE_WORKTREE_SCOPED ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Swap `p`'s `fromPrefix` for `toPrefix` (both directory prefixes, compared
 *  with lib/next.ts samePath semantics — case-insensitive on win32). Returns
 *  null when `p` does not live under `fromPrefix`. The suffix keeps its
 *  original casing. */
function swapPathPrefix(p: string, fromPrefix: string, toPrefix: string): string | null {
  const norm = (s: string): string =>
    process.platform === 'win32' ? s.replace(/\//g, '\\').toLowerCase() : s;
  const rp = resolve(p);
  const np = norm(rp);
  const nf = norm(resolve(fromPrefix));
  if (np === nf) return resolve(toPrefix);
  const nfSep = nf.endsWith(sep) ? nf : nf + sep;
  if (!np.startsWith(nfSep)) return null;
  return join(resolve(toPrefix), rp.slice(nfSep.length));
}

/** Whether `child` lives under (or is) `parent` — the swapPathPrefix
 *  containment test without the swap. */
function isUnderPath(child: string, parent: string): boolean {
  return swapPathPrefix(child, parent, parent) !== null;
}

/** D14 preflight: uncommitted changes in the MAIN tree's pipeline dir.
 *  A worktree materializes COMMITTED state only, so a dirty pipeline dir means
 *  the run will NOT see the operator's latest edits — a documented semantic
 *  change vs the legacy main-scoped reads, surfaced loudly as a warning (the
 *  run still proceeds on the committed state). Best-effort: any git failure
 *  (not a repo, no git) returns null. */
function dirtyPipelineDirWarning(projectRoot: string, mainPipelineRoot: string): string | null {
  try {
    const rel = relative(projectRoot, mainPipelineRoot);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    const spec = rel === '' ? '.' : rel.split(sep).join('/');
    const r = spawnSync(gitBin(), ['status', '--porcelain', '--', spec], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    const dirty = r.stdout.split('\n').filter((l) => l.trim() !== '').length;
    if (dirty === 0) return null;
    return (
      `worktree-scoped run: the main tree's pipeline dir has ${dirty} uncommitted change(s) — ` +
      'an external-isolation run executes the COMMITTED state only (the run worktree materializes ' +
      'commits, D14). Commit pipeline edits before the run, or set PIPELINE_WORKTREE_SCOPED=0 ' +
      'for the legacy main-scoped reads.'
    );
  } catch {
    return null;
  }
}

/** Idempotently write the run-artifact `.gitignore` stubs + the per-run
 *  feedback dir in the WORKTREE pipeline tree (05.1.5): finalize must never
 *  commit `.runtime/` (rendered/records/outputs/ledger) or `.feedback/`.
 *  Throws on failure — a worktree whose stubs cannot be written must not run
 *  (the finalize commit would swallow run artifacts). */
function writeWorktreeArtifactStubs(wtPipelineRoot: string, runId: string): void {
  for (const dir of ['.runtime', '.feedback']) {
    const d = join(wtPipelineRoot, dir);
    mkdirSync(d, { recursive: true });
    const gi = join(d, '.gitignore');
    if (!existsSync(gi)) writeFileSync(gi, '*\n', 'utf8');
  }
  mkdirSync(join(wtPipelineRoot, '.feedback', runId), { recursive: true });
}

// ---------------------------------------------------------------------------
// In-process script-step execution (type: script — DESIGN.md §§5–10)
// ---------------------------------------------------------------------------

/** Best-effort stderr note (script warnings, outputs-store skips). Never
 *  affects the printed action JSON (stdout) or the exit code. */
function warnNote(msg: string): void {
  try {
    process.stderr.write(`pipeline next: ${msg}\n`);
  } catch {
    // best-effort
  }
}

/** The enumerated PlanStep behind a dispatched path (path first — the
 *  engine's own identity — then the optional step_id fallback). Script-typed
 *  dispatches always map to an enumerated step (off-plan synthesis pins type
 *  'agent'). */
function planStepFor(plan: Plan, path: string, stepId?: string | null): PlanStep | undefined {
  return plan.steps.find((s) => samePath(s.path, path)) ?? (stepId ? plan.steps.find((s) => s.step_id === stepId) : undefined);
}

/** Which dispatches get rendered shadow copies (env-variables a5; E11 v1
 *  LOCKED): AGENT steps only. Script, gate, and pipeline dispatches — and the
 *  §6.3 agent FALLBACK of a failed script step (its file IS a script step's
 *  file) — keep `path === source_path`, because their path-keyed consumers
 *  (planStepFor, the script/gate `## Next` parse, `active.step_path` at
 *  composition pop) key back to plan steps by path equality. */
function isRenderedDispatch(s: ActionStep): boolean {
  return (s.type ?? 'agent') === 'agent' && s.fallback === undefined;
}

/** Actuate a mid-run FORCE-HALT through the engine's terminal seam (haltRun):
 *  an external run still gets its destroy hook executed in-process (state
 *  crash-safe parked first), `--manual-hooks` goes straight terminal (the
 *  worktree is the caller's to reap), the final state is saved, and the run's
 *  stats are finalized as 'halted'. ONE implementation shared by the mid-run
 *  plan-error halt and the render-failure halt (env-variables a5) so the two
 *  flows can never drift. `stamp` (when provided) re-stamps the run-scoped
 *  persisted fields before each save — the render path passes its
 *  stampRunFields closure; the plan-error path runs before that closure
 *  exists and passes nothing (its historical behavior). */
function executeForceHalt(
  plan: Plan,
  state: NextState,
  reason: string,
  opts: NextOpts,
  a: { root: string; runId: string; manualHooks?: boolean },
  stamp?: (s: NextState) => void,
): { state: NextState; teardown: TeardownInfo | null } {
  let { action, state: cur } = haltRun(plan, state, reason, opts);
  let teardown: TeardownInfo | null = null;
  if (action.action === 'teardown-worktree') {
    if (a.manualHooks !== true) {
      // Crash-safe parking (mirrors the main hook loop), then run the destroy
      // hook in-process and consume its record.
      stamp?.(cur);
      saveState(a.root, a.runId, cur);
      const projectRoot = action.project_root ?? process.cwd();
      const hookDirAbs = isAbsolute(action.hook_dir) ? action.hook_dir : join(projectRoot, action.hook_dir);
      const res = execDestroyHook(action, hookDirAbs, projectRoot, resolve(action.pipeline_root ?? a.root));
      cur = computeNext(plan, cur, res.record, { ...opts, resume: false }).state;
      teardown = res.teardown;
    } else {
      // --manual-hooks cannot actuate a hook here, and parking in
      // await-teardown would wedge — go terminal; the worktree is the
      // caller's to reap.
      cur.phase = 'terminal';
    }
  }
  stamp?.(cur);
  saveState(a.root, a.runId, cur);
  // A mid-run force-halt is a real terminal outcome — measure it too.
  statsFinalizeRun(a.root, a.runId, 'halted', reason);
  return { state: cur, teardown };
}

/** §10 outputs store: `<pipeline_root>/.runtime/<run-id>/outputs/<step_id>.json`. */
function outputsFile(root: string, runId: string, stepId: string): string {
  return join(root, '.runtime', runId, 'outputs', `${stepId}.json`);
}

/** Read one step's persisted `output` object (the `${steps.<id>.output.…}`
 *  binding source). Missing/corrupt/non-object ⇒ null. */
function readPersistedOutput(root: string, runId: string, stepId: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(outputsFile(root, runId, stepId), 'utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** §10: persist a step record's `output` object to the outputs store
 *  (loop-back executions overwrite — latest wins). Over the 64 KB cap ⇒ NOT
 *  persisted (returns the warning; downstream bindings then fail as 'binding'
 *  with a clear message). Returns null when persisted or nothing to persist. */
function persistOutput(
  root: string,
  runId: string,
  stepId: string,
  output: Record<string, unknown> | null | undefined,
): string | null {
  if (output === null || output === undefined || typeof output !== 'object' || Array.isArray(output)) return null;
  let json: string;
  try {
    json = JSON.stringify(output);
  } catch (e) {
    return `step '${stepId}' output is not JSON-serializable — not persisted (${(e as Error).message})`;
  }
  if (Buffer.byteLength(json, 'utf8') > OUTPUT_PERSIST_CAP_BYTES) {
    return `step '${stepId}' output exceeds the ${Math.floor(OUTPUT_PERSIST_CAP_BYTES / 1024)} KB persist cap — not persisted (downstream \${steps.${stepId}.output…} bindings will fail)`;
  }
  try {
    const f = outputsFile(root, runId, stepId);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, json + '\n', 'utf8');
    return null;
  } catch (e) {
    return `step '${stepId}' output could not be persisted: ${(e as Error).message}`;
  }
}

/** §6.2.2: persist the T12 feedback draft as `.feedback/<run_id>/<step_id>-NN.md`
 *  (the existing Tier-2 problem-file shape; body IS the complete file). NN is
 *  the first free 2-digit slot so repeated failures of one step never clobber.
 *  Best-effort for I/O, but the caller re-counts the feedback dir afterwards so
 *  a successful write gates the retrospective of the very halt it documents. */
function writeFeedbackFile(root: string, runId: string, stepId: string, body: string): void {
  try {
    const dir = join(root, '.feedback', runId);
    mkdirSync(dir, { recursive: true });
    // Self-contained gitignore (the pipeline-manager/drive run-start setup does
    // the same; a script-only run may reach here first).
    const gi = join(root, '.feedback', '.gitignore');
    if (!existsSync(gi)) writeFileSync(gi, '*\n', 'utf8');
    let n = 1;
    while (existsSync(join(dir, `${stepId}-${String(n).padStart(2, '0')}.md`)) && n < 100) n++;
    writeFileSync(join(dir, `${stepId}-${String(n).padStart(2, '0')}.md`), body, 'utf8');
  } catch (e) {
    warnNote(`feedback file for script step ${stepId} could not be written: ${(e as Error).message}`);
  }
}

/** `${run.task}` source: the run's task statement. `pipeline drive` persists
 *  a task-ref (`--task`/`--task-file`) at `.runtime/<run>/task-ref.json`
 *  pointing at the file; fall back to the conventional task.md. Null when the
 *  run has no task (manager runs typically don't). */
function readTaskText(root: string, runId: string): string | null {
  try {
    const ref = JSON.parse(readFileSync(join(root, '.runtime', runId, 'task-ref.json'), 'utf8')) as {
      task_file?: unknown;
    };
    if (typeof ref.task_file === 'string') return readFileSync(ref.task_file, 'utf8');
  } catch {
    // no ref — try the conventional location
  }
  try {
    return readFileSync(join(root, '.runtime', runId, 'task.md'), 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Approval gates (`type: gate` — T3-14, runner side)
// ---------------------------------------------------------------------------

/** Resolve a delivered gate ANSWER into the plain step record the pure engine
 *  consumes. approve ⇒ the gate step COMPLETES and routing proceeds normally:
 *  in sequential mode its `## Next` is parsed MECHANICALLY (the script-step
 *  rule §5.2 — same parser, same warn-on-unparseable degradation); graph mode
 *  routes off the additive `approved` flag / the node's default edge. reject
 *  — or a missing/non-JSON/unknown-decision answer — HALTS the run, comment
 *  folded into the halt_reason. Fail CLOSED: an unparseable answer is NEVER
 *  treated as approval. */
function gateRecordFor(step: PlanStep, answer: unknown, sequential: boolean): StepRecord {
  const parsed = parseGateDecision(answer);
  if (!parsed.ok) {
    return {
      kind: 'step',
      outcome: 'halted',
      halt_reason: `approval gate '${step.step_id}' halted: ${parsed.detail} — an unparseable answer is never treated as approval`,
    };
  }
  const { decision, comment } = parsed.decision;
  if (decision === 'reject') {
    return {
      kind: 'step',
      outcome: 'halted',
      halt_reason: `approval gate '${step.step_id}' rejected${comment !== null && comment !== '' ? `: ${comment}` : ''}`,
    };
  }
  let nextIteration: string | null = null;
  if (sequential) {
    const p = parseNextSection(step.path);
    if (p.error) warnNote(`gate step ${step.step_id}: ## Next not mechanically parseable: ${p.error}`);
    nextIteration = p.next;
  }
  return { kind: 'step', outcome: 'completed', flags: { approved: true }, next_iteration: nextIteration };
}

// ---------------------------------------------------------------------------
// Core invocation (shared by `pipeline next` and the EXPERIMENTAL `pipeline drive`)
// ---------------------------------------------------------------------------

export interface InvokeNextArgs {
  root: string;
  runId: string;
  start?: string;
  defaultModel?: string | null;
  /** Per-run step-model overrides. undefined ⇒ reuse the overrides persisted in
   *  the run's next.json (so init-only flags survive loop calls and resumes);
   *  provided ⇒ use these AND persist them. */
  modelOverrides?: Record<string, string | null>;
  /** Pipeline-level effort override (`--default-effort`). Same contract as
   *  defaultModel: undefined ⇒ PIPELINE.md frontmatter; null ⇒ force inherit. */
  defaultEffort?: string | null;
  /** Per-run step-effort overrides — same persistence contract as
   *  modelOverrides. */
  effortOverrides?: Record<string, string | null>;
  /** PP_* variable overrides — the merged `--var`/`--vars-file` map
   *  (vars-file first, flags win; env-variables design D2/D11). Pass ONLY on
   *  the init/resume invocation (like `start`): the map is resolved + FROZEN
   *  into next.json once, and supplying it again when the state already
   *  carries a frozen map is the D11 "variables are frozen" error. undefined
   *  = no flags passed (an EMPTY map still counts as supplied). */
  cliVars?: Record<string, string>;
  record?: NextRecord | null;
  resume?: boolean;
  manualHooks?: boolean;
  /** §13 debugging escape hatch: return raw script-type run-step actions to
   *  the caller instead of executing them in-process. */
  manualScripts?: boolean;
  /** §7 call budget (ms) for in-process script executions, measured from
   *  invokeNext entry. Default CALL_BUDGET_MS (manager mode — the outer Bash
   *  call is capped at 10 min); `pipeline drive` passes Infinity (no outer
   *  ceiling, `continue` never emitted). */
  callBudgetMs?: number;
  /** Test seam: the spawn runner handed to executeScriptStep (defaults to the
   *  real hook-runner supervisor). */
  scriptRunner?: ProcessRunner;
}

export interface InvokeNextResult {
  /** The next real action (post in-process worktree-hook execution). */
  action: NextAction;
  /** The printable action JSON (action + mode/warnings/provisioned/finalized/teardown). */
  out: Record<string, unknown>;
  /** The `pipeline next` exit code: 1 on a halt action, 0 otherwise. */
  code: number;
  /** The plan the invocation computed (T3-10: the composition wrapper reads
   *  the dispatched step's pipeline_spec off it). Absent only on synthetic
   *  results the wrapper itself fabricates (the recursion-guard `continue`). */
  plan?: Plan;
}

/**
 * The full `pipeline next` computation minus argv parsing and printing: plan
 * computation, state load/persist, no-record auto-resume detection, completion/
 * started UI-event auto-emission, and in-process worktree-hook execution.
 * `invokeNext` (exported below) wraps this core with the T3-10 composition
 * router — `type: pipeline` dispatches become nested CHILD RUNS (the parent
 * waits) and records/resumes route depth-first into the active child; the
 * EXPERIMENTAL `pipeline drive` headless runner loops over the IDENTICAL
 * wrapped invocation in-process instead of duplicating any of it.
 */
function invokeNextCore(a: InvokeNextArgs): InvokeNextResult {
  // §7 call-budget anchor: elapsed time (plan compute, hooks, scripts) all
  // counts against the window the outer Bash call gives us.
  const entryMs = Date.now();
  const callBudgetMs = a.callBudgetMs ?? CALL_BUDGET_MS;
  // Resolved once — reused by the script-execution context and outputs store.
  const rootAbs = resolve(a.root);
  // State is loaded BEFORE the plan so persisted `--model` overrides (stamped at
  // init) keep applying on loop calls / resumes where the caller re-passes none.
  const prevState = loadState(a.root, a.runId);
  const modelOverrides = a.modelOverrides !== undefined ? a.modelOverrides : prevState?.model_overrides;
  const effortOverrides = a.effortOverrides !== undefined ? a.effortOverrides : prevState?.effort_overrides;
  const planOpts = {
    ...(a.defaultModel === undefined ? {} : { defaultModel: a.defaultModel }),
    ...(modelOverrides === undefined ? {} : { modelOverrides }),
    ...(a.defaultEffort === undefined ? {} : { defaultEffort: a.defaultEffort }),
    ...(effortOverrides === undefined ? {} : { effortOverrides }),
  };
  // The MAIN-tree plan: the run plan for every unscoped run, and the
  // BOOTSTRAP plan (isolation/hooks/base-branch facts) for a worktree-scoped
  // external run — whose RUN plan is computed from the worktree below.
  const mainPlan = computePlan(a.root, planOpts);

  // Finalize opt-in (external only, additive): the run runs the mandatory
  // finalize stage when the pipeline opted in — via the PRESENCE of a
  // `worktree-finalize.*` hook in the resolved hook dir OR a `finalize: true`
  // frontmatter flag. Resolved from the MAIN tree (init-time facts — hooks
  // are project infrastructure, provisioned before any worktree exists).
  // Consumed once at init (persisted into state.finalize); inert on resume.
  const finalizeHookDirAbs = isAbsolute(mainPlan.worktree_hook_dir)
    ? mainPlan.worktree_hook_dir
    : join(process.cwd(), mainPlan.worktree_hook_dir);
  const finalizeOptIn =
    mainPlan.isolation === 'external' &&
    (mainPlan.finalize || resolveHookScript(finalizeHookDirAbs, 'worktree-finalize') !== null);

  // -------------------------------------------------------------------------
  // Worktree-scoped pipeline I/O (P2/b3 — 05.1; D3/D6/D14). Resolve the run's
  // FROZEN path model: a state that carries `worktree_scoped` keeps it
  // verbatim (mid-run env flips can never mix path models); a legacy
  // in-flight external state freezes to false (main-scoped); a FRESH external
  // run freezes from `PIPELINE_WORKTREE_SCOPED` (default ON) gated on
  // eligibility. Non-external runs never gain the state key (rule table
  // 05.1: native-parallel + in-place change NOTHING).
  // -------------------------------------------------------------------------
  const externalShape =
    mainPlan.errors.length === 0 && mainPlan.isolation === 'external' && pickMode(mainPlan) !== 'parallel';
  let scoped = false;
  let scopeFreeze = false;
  let wtPipelineRoot: string | null = null;
  let mainPipelineRoot = rootAbs;
  const scopeWarnings: string[] = [];
  if (prevState !== null && typeof prevState.worktree_scoped === 'boolean') {
    scoped = prevState.worktree_scoped;
    scopeFreeze = true;
    wtPipelineRoot =
      typeof prevState.worktree_pipeline_root === 'string' ? resolve(prevState.worktree_pipeline_root) : null;
    if (typeof prevState.main_pipeline_root === 'string') {
      mainPipelineRoot = resolve(prevState.main_pipeline_root);
    }
  } else if (prevState !== null) {
    // Legacy in-flight state (pre-b3): frozen LEGACY — an in-flight run must
    // never switch path models. Stamp false so a later env flip stays inert.
    scoped = false;
    scopeFreeze = externalShape;
  } else if (externalShape) {
    const blockers: string[] = [];
    if (a.manualHooks === true) blockers.push('--manual-hooks (worktree hooks are caller-actuated)');
    else if (!isUnderPath(rootAbs, resolve(process.cwd()))) {
      blockers.push('--root lies outside the project root (no worktree-relative pipeline path)');
    } else if (composedDepthOf(rootAbs, a.runId) > 1) {
      blockers.push('composed child runs stay main-scoped');
    }
    // `a.record == null`: a record on a STATE-LESS run is already an operator
    // anomaly (the engine inits regardless) — freeze legacy rather than
    // provisioning around an un-consumable record.
    const eligible = blockers.length === 0 && mainPlan.steps.length > 0 && a.record == null;
    const envOn = worktreeScopedEnvOn();
    scoped = eligible && envOn;
    scopeFreeze = true;
    if (envOn && blockers.length > 0) {
      const w = `worktree scoping disabled for this run: ${blockers.join('; ')} — running main-scoped`;
      warnNote(w);
      scopeWarnings.push(w);
    }
  }
  /** 05.1.3 prefix-swap mapping: worktree → main (observability surfaces) and
   *  main → worktree (--start/answer-resume round trips). Identity on
   *  unscoped runs and on paths outside the pair. */
  const toMainPath = (p: string): string =>
    scoped && wtPipelineRoot !== null ? (swapPathPrefix(p, wtPipelineRoot, mainPipelineRoot) ?? p) : p;
  const toWtPath = (p: string): string =>
    scoped && wtPipelineRoot !== null ? (swapPathPrefix(p, mainPipelineRoot, wtPipelineRoot) ?? p) : p;
  /** Stamp the frozen path-model trio onto a state about to be saved (the
   *  model_overrides persistence pattern — called from stampRunFields and the
   *  pre-provision parking below). */
  const stampScope = (s: NextState): void => {
    if (!scopeFreeze) return;
    s.worktree_scoped = scoped;
    if (scoped) {
      s.worktree_pipeline_root = wtPipelineRoot;
      s.main_pipeline_root = mainPipelineRoot;
    }
  };

  /** Provision-at-init (05.1.1, scoped external runs): run the create hook
   *  BEFORE plan computation, then compute the run plan AGAINST the worktree
   *  pipeline copy — the run executes the BRANCH's definition. An invalid
   *  worktree plan runs the destroy hook with outcome 'halted' (init-failure
   *  teardown — an invalid plan never silently leaks a worktree). */
  const preProvision = ():
    | { kind: 'halt'; result: InvokeNextResult }
    | { kind: 'feed'; plan: Plan; parkedState: NextState; record: WorktreeRecord; provisioned: ProvisionedInfo | null }
    | { kind: 'passthrough' } => {
    const projectRoot = process.cwd();
    const baseOpts: NextOpts = {
      start: a.start,
      resume: a.resume === true || prevState !== null,
      feedbackCount: 0,
      runId: a.runId,
      projectRoot,
      pipelineRoot: a.root,
      finalizeOptIn,
      resolveOffPlanModel,
      resolveOffPlanEffort,
    };
    const r1 = computeNext(mainPlan, prevState, null, baseOpts);
    const provisionAction = r1.action;
    if (provisionAction.action !== 'provision-worktree') {
      // Defensive (external + steps>0 always provisions at init/resume):
      // fall through to the generic flow on the main plan.
      warnNote('worktree scoping: engine did not emit provision-worktree — dispatching main-scoped this call');
      return { kind: 'passthrough' };
    }
    const parked = r1.state;
    // Crash-safe parking BEFORE the hook (mirrors the in-process hook loop):
    // a crash inside the hook re-enters here via the no-record auto-resume
    // (phase await-provision, prefix still null) and the idempotent hook
    // simply re-runs.
    parked.model_overrides = mainPlan.model_overrides;
    parked.effort_overrides = mainPlan.effort_overrides;
    stampScope(parked);
    saveState(a.root, a.runId, parked);
    // D14 preflight (init only): a worktree materializes COMMITTED state —
    // warn loudly when the main pipeline dir is dirty.
    if (prevState === null) {
      const dirty = dirtyPipelineDirWarning(projectRoot, rootAbs);
      if (dirty !== null) {
        warnNote(dirty);
        scopeWarnings.push(dirty);
      }
    }
    const hookDirAbs = isAbsolute(provisionAction.hook_dir)
      ? provisionAction.hook_dir
      : join(projectRoot, provisionAction.hook_dir);
    const res = execCreateHook(provisionAction, hookDirAbs, projectRoot, rootAbs);
    if (res.provisioned === null) {
      // Failed create: best-effort cleanup, then let the generic flow consume
      // the ok:false record against the main plan — the exact legacy halt
      // path (worktree_provisioned stays false ⇒ no teardown).
      execCreateFailedCleanup(provisionAction, hookDirAbs, projectRoot, rootAbs, res.failedWorktreePath);
      return { kind: 'feed', plan: mainPlan, parkedState: parked, record: res.record, provisioned: null };
    }
    // The worktree mirrors the project tree, so the pipeline root keeps its
    // project-relative path — the `(worktree_prefix, main_prefix)` pair.
    const wtRoot = resolve(join(res.provisioned.worktree_path, relative(projectRoot, rootAbs)));
    wtPipelineRoot = wtRoot;
    let wtPlan: Plan | null = null;
    let failReason: string | null = null;
    try {
      writeWorktreeArtifactStubs(wtRoot, a.runId);
      wtPlan = computePlan(wtRoot, planOpts);
      if (wtPlan.errors.length) failReason = `worktree pipeline plan errors: ${wtPlan.errors.join('; ')}`;
    } catch (e) {
      failReason = `worktree pipeline could not be prepared: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (failReason !== null) {
      // Init-failure teardown: destroy hook with outcome 'halted' (the
      // consumer's preserve-on-halt cue applies), state parked terminal.
      parked.worktree_provisioned = true; // mirror onProvisionPhase bookkeeping
      parked.worktree_path = res.provisioned.worktree_path;
      if (res.provisioned.env_file != null) parked.worktree_env_file = res.provisioned.env_file;
      const haltOpts: NextOpts = { resume: false, feedbackCount: 0, runId: a.runId, projectRoot, pipelineRoot: a.root };
      const stamp = (s: NextState): void => {
        s.model_overrides = mainPlan.model_overrides;
        s.effort_overrides = mainPlan.effort_overrides;
        stampScope(s);
      };
      const halted = executeForceHalt(mainPlan, parked, failReason, haltOpts, a, stamp);
      const haltOut: Record<string, unknown> = {
        action: 'halt',
        status: 'halted',
        reason: failReason,
        mode: pickMode(mainPlan),
        provisioned: res.provisioned,
      };
      if (wtPlan !== null && wtPlan.errors.length) haltOut.errors = wtPlan.errors;
      if (halted.teardown) haltOut.teardown = halted.teardown;
      return {
        kind: 'halt',
        result: { action: { action: 'halt', reason: failReason, status: 'halted' }, out: haltOut, code: 1, plan: mainPlan },
      };
    }
    // Success: the run executes the WORKTREE's definition. Re-point the
    // pinned start/resume cursor (a --start names the MAIN author path).
    if (parked.current_path !== null) {
      const swapped = swapPathPrefix(parked.current_path, mainPipelineRoot, wtRoot);
      if (swapped !== null) parked.current_path = swapped;
    }
    return { kind: 'feed', plan: wtPlan!, parkedState: parked, record: res.record, provisioned: res.provisioned };
  };

  // Execution-plan selection: scoped runs plan against the worktree pipeline
  // copy; everything else keeps the main plan byte-identically.
  let plan = mainPlan;
  let feed: { state: NextState; record: WorktreeRecord } | null = null;
  let feedProvisioned: ProvisionedInfo | null = null;
  if (scoped && wtPipelineRoot !== null) {
    // Loop call / resume of a provisioned scoped run: plan from the recorded
    // worktree prefix; --start round trips arrive as MAIN author paths.
    if (a.start !== undefined) a.start = toWtPath(a.start);
    // A TERMINAL run needs no dispatch paths (and its worktree may already be
    // torn down) — answer terminal re-polls off the main plan.
    plan = prevState !== null && prevState.phase === 'terminal' ? mainPlan : computePlan(wtPipelineRoot, planOpts);
  } else if (scoped && a.record == null && (prevState === null || prevState.phase === 'await-provision')) {
    const pre = preProvision();
    if (pre.kind === 'halt') return pre.result;
    if (pre.kind === 'feed') {
      plan = pre.plan;
      feed = { state: pre.parkedState, record: pre.record };
      feedProvisioned = pre.provisioned;
    }
  } else if (scoped) {
    // Defensive: a scoped state with no prefix outside await-provision (or an
    // unexpected record before provisioning) — dispatch main-scoped this call.
    warnNote('worktree-scoped state carries no worktree prefix — dispatching main-scoped this call');
  }
  /** Effective run-artifact root (05.1.3): outputs, ledger/failures, rendered
   *  copies, and feedback live under the WORKTREE pipeline root on a scoped
   *  run; bookkeeping (next.json/events/.stats/liveness) ALWAYS stays under
   *  the main root (D6). */
  const execRootAbs = scoped && wtPipelineRoot !== null ? resolve(wtPipelineRoot) : rootAbs;
  const artifactRoot = scoped && wtPipelineRoot !== null ? execRootAbs : a.root;
  const mode = pickMode(plan);

  if (plan.errors.length) {
    const reason = `plan errors: ${plan.errors.join('; ')}`;
    const out: Record<string, unknown> = { action: 'halt', status: 'halted', reason, errors: plan.errors, mode };
    // A MID-RUN plan error (persisted, non-terminal state) must not bypass
    // teardown: route the halt through the engine's terminal seam
    // (executeForceHalt → haltRun) so an external run that already provisioned
    // a worktree still runs its destroy hook (PIPELINE_WT_OUTCOME=halted,
    // worktree.destroyed emitted) and the state parks TERMINAL `halted` with
    // the plan-error reason — otherwise the worktree leaks forever and the
    // run stays non-terminal. A FRESH run (no persisted state) keeps the
    // stateless early-return exactly as before.
    const planErrState = prevState;
    if (planErrState !== null && planErrState.phase !== 'terminal') {
      const haltOpts: NextOpts = {
        feedbackCount: 0,
        runId: a.runId,
        projectRoot: process.cwd(),
        pipelineRoot: a.root,
      };
      const halted = executeForceHalt(plan, planErrState, reason, haltOpts, a);
      if (halted.teardown) out.teardown = halted.teardown;
    }
    return {
      action: { action: 'halt', reason, status: 'halted' },
      out,
      code: 1,
      plan,
    };
  }

  // -------------------------------------------------------------------------
  // PP_* variables — run-init resolve → validate → freeze (env-variables
  // design 05 §3, P2). Runs BEFORE any record consumption or action: a
  // mis-supplied run must halt with state (and the pending record's step)
  // untouched, so the operator's retry with corrected flags loses nothing.
  //
  //   frozen map in state  → reuse VERBATIM (D11; no re-resolve, no env read —
  //                          environment drift mid-run cannot change values).
  //                          `--var`/`--vars-file` alongside a frozen map is
  //                          the D11 "variables are frozen" error — REJECTED
  //                          UPSTREAM (frozenVariablesError: exit-2 usage
  //                          error in runNext/runDrive; a defensive halt at
  //                          the invokeNext entry for embedders), so this
  //                          core never sees that combination.
  //   state PREDATES vars  → (legacy state, or the first run after the
  //                          pipeline gained declarations) `--var` IS accepted
  //                          and a ONE-TIME resolve runs now, written back on
  //                          the next state save (F10 migration).
  //   fresh run            → resolve + validate; L6 missing / L10 unknown
  //                          emit the aggregated F2 halt (exit non-zero,
  //                          before ANY action, no state created).
  //
  // The `resolveVariables(..., process.env)` call inside initRunVariables is
  // THE single environment read of the whole feature (D9): the engine itself
  // never touches process.env, and every later consumer (script argv/env
  // overlay, rendering — a4/a5) reads only the frozen map.
  // -------------------------------------------------------------------------
  let frozenVars: ResolvedVars | null = null;
  {
    const stateHasVars =
      prevState !== null && Object.prototype.hasOwnProperty.call(prevState, 'variables');
    if (stateHasVars) {
      frozenVars = prevState!.variables ?? {};
    } else if (hasDeclarations(plan.variables) || a.cliVars !== undefined) {
      // Scoped runs resolve declarations from the WORKTREE tree (the run
      // executes the branch's definition — its `## Variables` included).
      const { files, manifestRaw } = collectRunVarsFiles(scoped && wtPipelineRoot !== null ? execRootAbs : a.root, plan.steps);
      const init = initRunVariables(plan.variables, a.cliVars ?? {}, process.env, files, manifestRaw);
      if (init.errors.length) {
        const reason = init.message ?? 'variable validation failed';
        return {
          action: { action: 'halt', reason, status: 'halted' },
          out: {
            action: 'halt',
            status: 'halted',
            reason,
            errors: init.errors.map((i) => i.message),
            mode,
          },
          code: 1,
          plan,
        };
      }
      // Freeze ONLY when the pipeline actually declares variables: with zero
      // declarations the resolution above exists purely to surface L10 for
      // any supplied names — an EMPTY supplied set (e.g. a comments-only
      // --vars-file) must not stamp `variables: {}` onto a declaration-less
      // run (E9 zero-change; a bogus key would also make every later
      // `--var` trip the frozen-map rejection on a pipeline that has no
      // variables at all).
      frozenVars = hasDeclarations(plan.variables) ? init.resolved : null;
    }
    // else: no declarations, no flags — the E9 zero-change path (no `variables`
    // key is ever written; state shape is byte-identical to today).
  }

  /** Stamp the run-scoped persisted fields onto a state object — the ONE
   *  place that knows the set (model/effort overrides + the frozen PP_*
   *  variable map, D11). Called before every save: init stamps fresh values;
   *  loop calls/resumes re-stamp the same ones; a legacy state gains the
   *  `variables` key here (the F10 one-time write-back). frozenVars null =
   *  the run has no variables — the key is never created (E9). */
  const stampRunFields = (s: NextState): void => {
    s.model_overrides = plan.model_overrides;
    s.effort_overrides = plan.effort_overrides;
    if (frozenVars !== null) s.variables = frozenVars;
    // The frozen worktree-scope trio (P2/b3) rides every save the same way.
    stampScope(s);
  };

  // T3-14 approval gates: a {kind:'gate-answer'} record delivers the decision
  // for the pending `type: gate` dispatch. The COMMAND layer (never the pure
  // engine) parses the {decision, comment} answer and swaps in the plain step
  // record it resolves to — approve completes the gate (routing proceeds
  // normally), reject/unparseable halts (fail closed). A gate-answer arriving
  // with no pending gate dispatch passes through untouched and takes the
  // engine's uniform wrong-record halt.
  let record: NextRecord | null = a.record ?? null;
  let gateTag: ScriptTag | undefined;
  if (record !== null && record.kind === 'gate-answer') {
    const pendingGate =
      prevState?.phase === 'await-step' && prevState.pending_fallback == null && prevState.current_path
        ? planStepFor(plan, prevState.current_path, prevState.current_step_id)
        : undefined;
    if (pendingGate?.type === 'gate') {
      record = gateRecordFor(pendingGate, record.answer, mode === 'sequential');
      gateTag = { stepType: 'gate', failureClass: null };
    }
  }

  // Rendered-shadow next_iteration → SOURCE (env-variables a5): a step run from
  // its RENDERED copy has its executor resolve `## Next` relative to the rendered
  // tree, so the reported next_iteration is a `.runtime/<run>/rendered/<slug>/…`
  // path. Map it back to the author source BEFORE anything consumes it (the
  // completion event's next_iteration_path, and — crucially — the engine's
  // advance()/findStepByPath). Left verbatim it would miss the plan step (⇒
  // off-plan synthesis, source_path pinned to the rendered path) and the render
  // seam would judge that `.runtime` path out-of-root and dispatch the NEXT step
  // UNRENDERED — the "multi-step ${PP_*} pipeline halts at step 2" defect. No-op
  // on source paths, PIPELINE_COMPLETE, and cross-pipeline hand-offs; idempotent.
  if (record !== null && record.kind === 'step' && typeof record.next_iteration === 'string' && record.next_iteration !== 'PIPELINE_COMPLETE') {
    const mapped = sourcePathForRendered(execRootAbs, a.runId, record.next_iteration);
    if (mapped !== record.next_iteration) record = { ...record, next_iteration: mapped };
  }

  // Auto-resume on a re-spawn: persisted state exists but the caller passed no
  // record (a fresh manager re-entering an in-flight run). Explicit --resume also
  // forces it. A brand-new run (no state) is init; a normal loop step carries a
  // record and is neither.
  const resume = a.resume === true || (prevState !== null && record == null);
  // (Finalize opt-in is resolved from the MAIN plan above, before the
  // worktree-scope machinery — it feeds the pre-provision init too.)
  const opts: NextOpts = {
    start: a.start,
    resume,
    // Feedback lives under the ARTIFACT root: the worktree pipeline tree on a
    // scoped run (05.1.3), the main root otherwise.
    feedbackCount: feedbackCount(artifactRoot, a.runId),
    // External-isolation context — surfaced in provision/finalize/teardown actions
    // and consumed by the in-process hook execution below. The command runs with
    // cwd = the consumer project root; --root is the pipeline folder.
    runId: a.runId,
    projectRoot: process.cwd(),
    pipelineRoot: a.root,
    finalizeOptIn,
    // Off-plan steps (family hand-offs, nested next_iteration paths) resolve
    // their model/effort from their OWN frontmatter / enclosing manifest on disk.
    resolveOffPlanModel,
    resolveOffPlanEffort,
  };

  // Auto-emit the completion event for the just-recorded outcome (a resume
  // ignores the record, so nothing is labeled "completed" on that path). MUST
  // run BEFORE computeNext: the engine mutates the state object in place, so
  // the pre-call phase/current_path are gone afterwards.
  // §13 --manual-scripts symmetry: the pass-through dispatch of a SCRIPT-typed
  // plan step was tagged step_type:"script" (dispatch-type keying, §12), so the
  // caller-recorded completion for that same dispatch must carry the tag too —
  // otherwise events.jsonl/.stats count the step as an LLM step on one side
  // only. No failure_class (the caller executed it; we never classified). NEVER
  // tagged when the pending dispatch was the §6.3 agent FALLBACK of a script
  // step (state.pending_fallback marks it — that dispatch is agent-typed).
  let manualScriptTag: ScriptTag | undefined;
  if (
    !resume &&
    a.manualScripts === true &&
    record?.kind === 'step' &&
    prevState?.phase === 'await-step' &&
    prevState.pending_fallback == null &&
    prevState.current_path
  ) {
    const pending = planStepFor(plan, prevState.current_path, prevState.current_step_id);
    if (pending?.type === 'script') manualScriptTag = { failureClass: null };
  }
  if (!resume) {
    emitCompletionEvents(plan, prevState, record, a.runId, gateTag ?? manualScriptTag, toMainPath);
    statsNoteRecord(a.root, a.runId, prevState, record, gateTag ?? manualScriptTag, toMainPath);
  }
  const statsIsInit = prevState === null;
  // §10: an INCOMING agent-step record may carry the additive `output` object
  // (STEP_RECORD_SCHEMA) — persist it to the outputs store keyed by the step
  // that was in flight. (Synthesized script records are persisted inline by
  // the interception loop below; layer entries carry no output in v1.)
  if (!resume && record?.kind === 'step' && prevState?.phase === 'await-step' && prevState.current_step_id) {
    const w = persistOutput(execRootAbs, a.runId, prevState.current_step_id, record.output ?? null);
    if (w) warnNote(w);
  }
  // §6.4 bound #2 (command-owned state.repaired_steps): a script-creator run
  // that just repaired a SCRIPT step's iteration consumes that step's
  // once-per-run repair. Capture the target now — the engine clears
  // improve_target while consuming the record — and append after computeNext.
  let repairedStepId: string | null = null;
  if (
    !resume &&
    record?.kind === 'script' &&
    prevState?.phase === 'await-script' &&
    prevState.improve_target &&
    // 'repaired' is the repair-script mode's MANDATED outcome — the sanctioned
    // §6.4 flow must populate the bound, not just created/updated edits.
    (record.outcome === 'created' || record.outcome === 'updated' || record.outcome === 'repaired')
  ) {
    const target = prevState.improve_target;
    repairedStepId = plan.steps.find((s) => s.type === 'script' && samePath(s.path, target))?.step_id ?? null;
  }

  // e7 DEFECT-3 (protocol G5): a resume re-entry whose persisted phase is
  // 'await-step' RE-ISSUES a previously-dispatched step — its auto-emitted
  // iteration.started must carry `resumed: true` so consumers (the cloud
  // ingest's awaiting_input/attempt derivation) can tell a resume-after-answer
  // (or crash/blocked re-entry) from a fresh first dispatch. Captured BEFORE
  // computeNext — the engine mutates the state object in place. The pending
  // step identity is captured too: the in-process script loop below can
  // advance PAST the re-issued step inside this same call, and the tail
  // action's FRESH step must not inherit the tag.
  const resumedReentry = resume && prevState !== null && prevState.phase === 'await-step';
  const resumedPendingPath = resumedReentry ? (prevState!.current_path ?? null) : null;
  const resumedPendingStepId = resumedReentry ? (prevState!.current_step_id ?? null) : null;

  // Worktree-scoped pre-provision (P2/b3): the create hook already ran and the
  // run plan is the WORKTREE's — consume the provisioned record against the
  // parked state instead of re-entering init/resume (resume MUST be false: the
  // record is being consumed, not replayed; `start` MUST be dropped: initRun/
  // resumeRun already pinned it into the parked current_path, which the
  // pre-provision swapped into the worktree — re-passing the raw MAIN path
  // would override the swap in onProvisionPhase's selectStep).
  let { action, state: newState } =
    feed !== null
      ? computeNext(plan, feed.state, feed.record, { ...opts, start: undefined, resume: false })
      : computeNext(plan, prevState, record, opts);
  if (repairedStepId !== null && !(newState.repaired_steps ?? []).includes(repairedStepId)) {
    (newState.repaired_steps ??= []).push(repairedStepId);
  }
  // Persist the run's effective step-model/effort overrides + frozen PP_*
  // variables (init stamps them; later calls re-stamp the same values). The
  // pure engine ignores the fields — they exist so loop calls / resumes
  // recompute the SAME plan and reuse the SAME frozen map.
  stampRunFields(newState);

  // Early run.started measurement on init — BEFORE any in-process hook/script
  // execution appends its own timeline lines, so the buffer stays
  // chronologically ordered (the tail statsNoteAction call passes false).
  if (statsIsInit) statsAppend(a.root, a.runId, { k: 'run.started', mode, model: plan.default_model ?? null });

  // ---------------------------------------------------------------------
  // In-process execution loop: worktree hooks AND `type: script` steps are
  // performed HERE, feeding their records back into the engine, until a real
  // caller-facing action surfaces. Hooks are bounded by ≤6 chained actions per
  // invocation (provision at init; finalize+teardown at the end); scripts by
  // MAX_SCRIPT_EXECS_PER_CALL and the §7 call budget — exceeding either parks
  // the persisted dispatch and returns {action:'continue'}.
  // ---------------------------------------------------------------------
  let provisioned: ProvisionedInfo | null = feedProvisioned;
  let finalize: FinalizeInfo | null = null;
  let teardown: TeardownInfo | null = null;
  /** T3-14: the needs_input question of a `type: gate` dispatch that just
   *  surfaced — attached to the printed action as `gate_question` so callers
   *  (`pipeline drive`, a manager) can relay it without recomputing the plan. */
  let gateQuestion: GateQuestion | null = null;
  let hookExecs = 0;
  let scriptExecs = 0;

  /** Re-stamp the override maps + persist next.json (the crash-safe parking
   *  used before every in-process spawn and at the tail). */
  const persistState = (): void => {
    stampRunFields(newState);
    saveState(a.root, a.runId, newState);
  };

  /** Fresh opts for the in-process self-feed calls: resume MUST be false (a
   *  resume would re-emit instead of consuming the record) and the feedback
   *  count is RE-COUNTED so a feedback file written by a just-failed script
   *  gates the retrospective of the very halt it documents (§6.2). */
  const feedOpts = (): NextOpts => ({ ...opts, resume: false, feedbackCount: feedbackCount(artifactRoot, a.runId) });

  /** §7: must the pending script execution be handed to a fresh call window?
   *  TRUE when the per-call execution cap is spent, or when the script's
   *  DECLARED timeout no longer fits the remaining window (minus the safety
   *  margin) AND a fresh window would be MATERIALLY better (≥10% more room).
   *  A script that fits nothing — declared above even a fresh window,
   *  including the 600 s DEFAULT on a smaller budget — runs NOW with a
   *  truncated deadline: an already-fresh window is the best it can ever get,
   *  and parking it would ping-pong forever (the old fits-fresh test instead
   *  truncated it to a near-zero deadline late in a window — a guaranteed
   *  spurious transient kill). */
  const mustContinue = (declaredMs: number): boolean => {
    if (scriptExecs >= MAX_SCRIPT_EXECS_PER_CALL) return true;
    const remainingMs = callBudgetMs - (Date.now() - entryMs) - SAFETY_MARGIN_MS;
    const freshMs = callBudgetMs - SAFETY_MARGIN_MS;
    if (declaredMs <= remainingMs) return false; // fits now — run
    return remainingMs < freshMs * 0.9; // park only if a fresh window gives materially more time
  };

  /** Emit the started pair (iteration.started event + step.started stats line)
   *  for ONE in-process script dispatch. Wired into ctx.onExecute so it fires
   *  only when the §8 ledger check concludes a REAL execution — a silent
   *  ledger reuse (crash-resume replay) emits nothing and events.jsonl/.stats
   *  never double-count the step. */
  const noteScriptStarted = (step: ActionStep, concurrent: boolean): void => {
    const act: NextAction = { action: 'run-step', concurrent, steps: [step] };
    emitStartedEvents(act, a.runId, toMainPath);
    statsNoteAction(a.root, a.runId, act);
  };

  // `${run.task}` is stable for the whole invocation — read once, not per
  // script execution.
  const taskText = readTaskText(a.root, a.runId);

  /** Execute ONE script step (ledger check → bindings → spawn → classify —
   *  lib/script-step.ts owns all of it, including transient retries) with the
   *  §7 effective deadline = min(declared timeout, remaining budget − margin). */
  const runScript = (step: ActionStep, spec: ScriptStepSpec, concurrent: boolean): ScriptStepResult => {
    const deadlineMs = Math.max(
      1,
      Math.min(spec.timeoutS * 1000, callBudgetMs - (Date.now() - entryMs) - SAFETY_MARGIN_MS),
    );
    // Per-execution memo for the outputs-store reader: one execution may
    // resolve several `${steps.<id>.output…}` bindings against the same file.
    const outputCache = new Map<string, Record<string, unknown> | null>();
    const ctx: ScriptStepContext = {
      runId: a.runId,
      stepId: step.step_id,
      dispatchIndex: step.index,
      deadlineMs,
      // Scoped runs (P2/b3): scripts resolve + run against the WORKTREE
      // pipeline tree — the branch's scripts/, ledger + failure records under
      // the worktree's .runtime (gitignore-stubbed; preserved on halt).
      pipelineRoot: execRootAbs,
      projectRoot: process.cwd(),
      // External isolation threads the run worktree; parallel worktree layers
      // deliberately do NOT (script members run IN-PLACE, §9).
      worktreePath: step.worktree_path ?? newState.worktree_path ?? null,
      worktreeEnvFile: step.worktree_env_file ?? newState.worktree_env_file ?? null,
      taskText,
      readOutput: (id) => {
        let out = outputCache.get(id);
        if (out === undefined) {
          out = readPersistedOutput(execRootAbs, a.runId, id);
          outputCache.set(id, out);
        }
        return out;
      },
      onExecute: () => noteScriptStarted(step, concurrent),
      // Only sequential advancement reads next_iteration (graph routes off
      // flags, DAG off layers) — outside sequential mode the lib skips the
      // ## Next parse entirely, so no 'not mechanically parseable' noise.
      parseNext: mode === 'sequential',
      // The run's FROZEN PP_* map (env-variables design a4, 05 §4): script
      // argv/`script:` substitution + T3b containment, the Params PP_* root,
      // and the D10 child-env overlay all read this map inside
      // executeScriptStep — the frozen state is the ONLY source (never a
      // fresh env read, D9). null = the E9 zero-change path (key omitted).
      ...(frozenVars !== null ? { variables: frozenVars } : {}),
      ...(a.scriptRunner ? { runner: a.scriptRunner } : {}),
    };
    const res = executeScriptStep(spec, step.path, ctx);
    // The MAX_SCRIPT_EXECS_PER_CALL cap counts REAL executions only: a §8
    // ledger reuse (crash-resume replay) performs no work, and burning the cap
    // on replays could keep a >cap-member layer from ever finishing.
    if (!res.ledgerReused) scriptExecs += 1;
    for (const w of res.warnings) warnNote(`script step ${step.step_id}: ${w}`);
    return res;
  };

  const interceptScripts = a.manualScripts !== true;

  /** Worktree-scoped observability re-point (P2/b3, 05.1.3): dispatched steps
   *  keep the WORKTREE `path` (executors/ledger/`## Next` all work there);
   *  `source_path` becomes the prefix-swapped MAIN author path — what events,
   *  stats, the UI, and answer-resume round trips key on. Idempotent (a main
   *  path swaps to itself); no-op on unscoped runs. */
  const stampObsPaths = (act: NextAction): void => {
    if (!scoped || wtPipelineRoot === null || act.action !== 'run-step') return;
    for (const s of act.steps) s.source_path = toMainPath(s.source_path);
  };

  for (let guard = 0; guard < MAX_SCRIPT_EXECS_PER_CALL + 12; guard++) {
    stampObsPaths(action);
    // ---- worktree hooks (isolation: external) ---------------------------
    if (
      a.manualHooks !== true &&
      hookExecs < 6 &&
      (action.action === 'provision-worktree' ||
        action.action === 'finalize-worktree' ||
        action.action === 'teardown-worktree')
    ) {
      hookExecs += 1;
      // Persist the parked state FIRST (await-provision / await-finalize /
      // await-teardown) — crash-safe: if we die inside the hook, a re-spawned
      // caller's no-record auto-resume re-enters resumeRun, which re-emits the
      // action, and the idempotent hook simply re-runs.
      persistState();
      const projectRoot = action.project_root ?? process.cwd();
      const hookDirAbs = isAbsolute(action.hook_dir) ? action.hook_dir : join(projectRoot, action.hook_dir);
      const pipelineRootAbs = resolve(action.pipeline_root ?? a.root);
      let record: WorktreeRecord;
      if (action.action === 'provision-worktree') {
        const res = execCreateHook(action, hookDirAbs, projectRoot, pipelineRootAbs);
        record = res.record;
        if (res.provisioned) {
          provisioned = res.provisioned;
        } else {
          // A3: the failed create may have left a partial slot — best-effort
          // destroy-hook cleanup (OUTCOME=create-failed). Never alters the halt.
          execCreateFailedCleanup(action, hookDirAbs, projectRoot, pipelineRootAbs, res.failedWorktreePath);
        }
      } else if (action.action === 'finalize-worktree') {
        const res = execFinalizeHook(action, hookDirAbs, projectRoot, pipelineRootAbs);
        record = res.record;
        finalize = res.finalize;
      } else {
        const res = execDestroyHook(action, hookDirAbs, projectRoot, pipelineRootAbs);
        record = res.record;
        teardown = res.teardown;
      }
      // resume MUST be false on these inner calls — otherwise resumeRun would
      // re-emit provision-worktree forever instead of consuming the record.
      const r = computeNext(plan, newState, record, { ...opts, resume: false });
      action = r.action;
      newState = r.state;
      continue;
    }

    // ---- type: gate (T3-14), sequential/graph (single-step dispatch) -----
    // A deterministic APPROVAL GATE — never executed in-process and never
    // spawned: annotate the pass-through run-step action with the needs_input
    // question (the additive `approval:{required_role}` marker rides the
    // question object — the cloud contract) and stop. The state stays parked
    // in await-step until a {kind:'gate-answer'} record delivers the decision
    // (`pipeline drive` parks the run on it with exit 4 and feeds the answer
    // from --answer; a manager-mode caller re-invokes with --record).
    if (action.action === 'run-step' && action.concurrent !== true && action.steps[0]?.type === 'gate') {
      const step = action.steps[0];
      const spec = planStepFor(plan, step.path, step.step_id)?.gate_spec ?? null;
      if (!spec || spec.required_role === null) {
        // Defensive (plan/state drift) — mirrors the script missing-spec halt:
        // computePlan ERRORs on a role-less gate, so a dispatched gate always
        // carries one unless the tree changed mid-run.
        const r = computeNext(
          plan,
          newState,
          {
            kind: 'step',
            outcome: 'halted',
            halt_reason: `gate step ${step.step_id} failed (binding): the plan carries no gate_spec/required_role for it`,
          },
          feedOpts(),
        );
        action = r.action;
        newState = r.state;
        continue;
      }
      gateQuestion = buildGateQuestion(step.step_id, spec.required_role, spec.message);
      break;
    }

    // ---- type: gate inside a PARALLEL layer: degrade to a loud halt (v1) --
    // (mirrors the `type: pipeline` parallel degradation — approval gates are
    // sequential/graph-only; the halted entries fold with any §9 pen in the
    // engine and halt the run BEFORE any layer member executes.)
    if (action.action === 'run-step' && action.concurrent === true && action.steps.some((s) => s.type === 'gate')) {
      const results: LayerResultEntry[] = action.steps
        .filter((s) => s.type === 'gate')
        .map((s) => ({
          step_id: s.step_id,
          outcome: 'halted' as const,
          halt_reason: `type: gate step '${s.step_id}' is not supported inside a parallel layer (v1) — approval gates are sequential/graph-only`,
        }));
      const rec: NextRecord = { kind: 'layer', results };
      // Label the degradation before the engine consumes it (mutates state in
      // place) — the same completion-pair discipline as the script partition.
      emitCompletionEvents(plan, newState, rec, a.runId, { stepType: 'gate', failureClass: null }, toMainPath);
      statsNoteRecord(a.root, a.runId, newState, rec, { stepType: 'gate', failureClass: null }, toMainPath);
      const r = computeNext(plan, newState, rec, feedOpts());
      action = r.action;
      newState = r.state;
      continue;
    }

    // ---- type: script, sequential/graph (single-step dispatch) -----------
    if (
      interceptScripts &&
      action.action === 'run-step' &&
      action.concurrent !== true &&
      action.steps[0]?.type === 'script'
    ) {
      const step = action.steps[0];
      const spec = planStepFor(plan, step.path, step.step_id)?.script_spec ?? null;
      if (!spec) {
        // Defensive (plan/state drift): a script-typed dispatch the plan has no
        // spec for. Feed the uniform §6.3 halt shape rather than handing the
        // caller an action it cannot execute.
        const r = computeNext(
          plan,
          newState,
          {
            kind: 'step',
            outcome: 'halted',
            halt_reason: `script step ${step.step_id} failed (binding): the plan carries no script_spec for it`,
          },
          feedOpts(),
        );
        action = r.action;
        newState = r.state;
        continue;
      }
      if (mustContinue(spec.timeoutS * 1000)) {
        // §7: the state already describes this pending dispatch (same index on
        // the re-emit — the §8 ledger key). Persist and hand off.
        action = { action: 'continue' };
        break;
      }
      // Crash-safe parking BEFORE the spawn (mirrors the hook loop): a killed
      // window re-enters via {"kind":"continue"} / auto-resume and the §8
      // ledger decides reuse vs re-execution. The started pair is emitted via
      // ctx.onExecute — only when the ledger check concludes a REAL execution,
      // so a §8 silent reuse never double-counts the step in events.jsonl/.stats.
      persistState();
      const res = runScript(step, spec, false);

      if (res.failure === null) {
        // §5.1 success (or §8 ledger reuse): persist the output (§10), label
        // the completion, feed the synthesized record — the chain advances
        // (sequential ## Next / graph flags / DAG layer) inside the engine.
        const w = persistOutput(execRootAbs, a.runId, step.step_id, res.record.output ?? null);
        if (w) warnNote(w);
        if (!res.ledgerReused) {
          emitCompletionEvents(plan, newState, res.record as StepRecord, a.runId, { failureClass: null }, toMainPath);
          statsNoteRecord(a.root, a.runId, newState, res.record as StepRecord, { failureClass: null }, toMainPath);
        }
        const r = computeNext(plan, newState, res.record as NextRecord, feedOpts());
        action = r.action;
        newState = r.state;
        continue;
      }

      // §6.2 — ALWAYS on failure: the CLI-written feedback file (what lets the
      // Tier-2 retrospective heal scripts even when the run halts). Scoped
      // runs journal into the WORKTREE's .feedback (the retrospective and its
      // improver work there — 05.1.3/6).
      if (res.feedback) writeFeedbackFile(artifactRoot, a.runId, step.step_id, res.feedback.body);
      const cls = res.failure.class;
      // §6.3 policy ladder (transient retries already ran inside
      // executeScriptStep): env ⇒ halt; on-failure halt ⇒ halt; on-failure
      // agent ⇒ request the engine's fallback re-dispatch — suppressed after an
      // in-run repair of the same script (§6.4 bound #2, repaired_steps) and
      // inert in the engine when the once-per-run §6.4 bound is consumed.
      const wantFallback =
        spec.onFailure === 'agent' &&
        cls !== 'env' &&
        res.failurePath !== null &&
        !(newState.repaired_steps ?? []).includes(step.step_id);
      // Snapshot the prev-state fields the completion emitters read
      // (phase/current_path/current_step_id) — the engine mutates the state
      // object in place.
      const prevSnap: NextState = { ...newState };
      const fo = feedOpts();
      if (wantFallback) fo.scriptFallback = { failure_record: res.failurePath! };
      const r = computeNext(plan, newState, res.record as NextRecord, fo);
      // The engine persists the authoritative fallback answer: pending_fallback
      // is set IFF the §6.3 agent fallback actually dispatched — in which case
      // this halt-shaped completion is NOT terminal. Journal order is
      // preserved: the fallback's own started pair is emitted at the loop
      // tail, after this completion.
      emitCompletionEvents(
        plan,
        prevSnap,
        res.record as StepRecord,
        a.runId,
        { failureClass: cls, terminal: r.state.pending_fallback == null },
        toMainPath,
      );
      statsNoteRecord(a.root, a.runId, prevSnap, res.record as StepRecord, { failureClass: cls }, toMainPath);
      action = r.action;
      newState = r.state;
      continue;
    }

    // ---- §9 layer partition (concurrent dispatch with script members) ----
    if (
      interceptScripts &&
      action.action === 'run-step' &&
      action.concurrent === true &&
      action.steps.some((s) => s.type === 'script')
    ) {
      // §9 pen: entries already collected for THIS layer by an earlier pass
      // (budget park mid-layer). Those members are DONE for this layer — never
      // re-partitioned, never re-executed: a FAILED member's ledger stays
      // 'started', so a replay would re-run its side effects and write a fresh
      // duplicate feedback file on every pass.
      const parkedEntries = newState.partial_layer_results ?? [];
      const isParked = (id: string): boolean => parkedEntries.some((e) => e.step_id === id);
      const scriptMembers = action.steps.filter((s) => s.type === 'script' && !isParked(s.step_id));
      const agentMembers = action.steps.filter((s) => s.type !== 'script');
      const entries: LayerResultEntry[] = [];
      /** Collect one member's layer entry AND emit its single-entry completion
       *  pair (event + stats line). §8 silent-reuse callers push to `entries`
       *  directly instead — a replay emits nothing. */
      const noteMemberDone = (entry: LayerResultEntry, failureClass: FailureClass | null): void => {
        entries.push(entry);
        const rec: NextRecord = { kind: 'layer', results: [entry] };
        emitCompletionEvents(plan, newState, rec, a.runId, { failureClass }, toMainPath);
        statsNoteRecord(a.root, a.runId, newState, rec, { failureClass }, toMainPath);
      };
      let parked = false;
      for (const member of scriptMembers) {
        const spec = planStepFor(plan, member.path, member.step_id)?.script_spec ?? null;
        if (!spec) {
          entries.push({
            step_id: member.step_id,
            outcome: 'halted',
            halt_reason: `script step ${member.step_id} failed (binding): the plan carries no script_spec for it`,
          });
          continue;
        }
        if (mustContinue(spec.timeoutS * 1000)) {
          // Budget spent mid-layer: this pass's collected entries are MERGED
          // into the pen below — the continue re-entry re-emits the layer with
          // the SAME per-member indices and SKIPS the penned members, so
          // nothing executed this pass (least of all a FAILED member) ever
          // re-runs.
          action = { action: 'continue' };
          parked = true;
          break;
        }
        // The member's started pair is emitted via ctx.onExecute — only when
        // the §8 ledger check concludes a REAL execution, so a silent reuse
        // (crash-resume replay) never double-counts in events.jsonl/.stats.
        persistState();
        const res = runScript(member, spec, true);
        if (res.failure === null) {
          const w = persistOutput(execRootAbs, a.runId, member.step_id, res.record.output ?? null);
          if (w) warnNote(w);
          // §9: script members run IN-PLACE — no worktree fields, no merge entry.
          const entry: LayerResultEntry = { step_id: member.step_id, outcome: 'completed' };
          if (res.ledgerReused) entries.push(entry);
          else noteMemberDone(entry, null);
        } else {
          if (res.feedback) writeFeedbackFile(artifactRoot, a.runId, member.step_id, res.feedback.body);
          // §6.4 v1: `on-failure: agent` inside a parallel layer degrades to
          // halt — the halted entry halts the folded layer in the engine.
          noteMemberDone(
            {
              step_id: member.step_id,
              outcome: 'halted',
              halt_reason: res.record.halt_reason ?? `script step ${member.step_id} failed (${res.failure.class})`,
            },
            res.failure.class,
          );
        }
      }
      // MERGE this pass's entries into the pen: parking must never discard an
      // executed member's result. Append-only BY CONSTRUCTION — scriptMembers
      // was filtered by !isParked above, so no entry here can duplicate a
      // penned step_id.
      const penned = [...parkedEntries, ...entries];
      if (parked) {
        newState.partial_layer_results = penned;
        break;
      }
      // §9 partial_layer_results hand-off. An all-script layer is fully
      // self-fed: earlier passes' entries stay in the pen and THIS pass's
      // fresh entries ride the record — onLayerRecord folds pen + results and
      // clears the pen. A mixed layer parks ALL script entries (earlier passes
      // + this one) and returns ONLY the agent members to the caller, whose
      // eventual {kind:'layer'} record folds with the pen in the engine.
      if (agentMembers.length === 0) {
        const r = computeNext(plan, newState, { kind: 'layer', results: entries }, feedOpts());
        action = r.action;
        newState = r.state;
        continue;
      }
      newState.partial_layer_results = penned;
      action = { action: 'run-step', concurrent: true, steps: agentMembers };
      break;
    }

    break;
  }

  // Re-stamp defensively — the in-process loop may have swapped the state object.
  stampRunFields(newState);
  saveState(a.root, a.runId, newState);
  // The loop may have exited via `break` after a fresh computeNext — make sure
  // the outgoing steps carry the prefix-swapped MAIN source_path (idempotent).
  stampObsPaths(action);

  // -------------------------------------------------------------------------
  // Rendered shadow copies (env-variables design 05 §5, D6 — P4/a5): when the
  // run carries a frozen PP_* map AND the pipeline declares variables, each
  // surfaced AGENT step is re-rendered LAZILY from its CURRENT source (plus
  // PIPELINE.md) into `.runtime/<run>/rendered/<slug>/…` and the action's
  // `path` is pointed at the rendered copy (`source_path` keeps the original).
  // Lazy-per-action ⇒ mid-run improver edits are honored (F5) and a deleted
  // rendered tree self-heals on resume (F4). E9 zero-change: no declarations
  // ⇒ this whole block is a no-op and `path === source_path` byte-identically.
  //
  // ONLY agent steps are rendered (isRenderedDispatch — E11, v1 LOCKED):
  // script steps keep `path === source_path` — executeScriptStep parses
  // `## Next` from that path and planStepFor/the §8 ledger key dispatches
  // back to plan steps — and the same exclusion covers gate steps
  // (parseNextSection at answer time), `type: pipeline` steps
  // (startChild/popChild key `active.step_path` by plan-path equality), and
  // the §6.3 agent FALLBACK of a failed script step.
  //
  // A render failure (an occurrence added mid-run for a variable that was
  // unresolved at init — the 04 §3 re-check — or an I/O failure, F10) halts
  // the run through the shared terminal seam exactly like a mid-run plan
  // error: an F2-style reason, external teardown still runs, stats finalize,
  // exit 1 — never a substituteText throw (07 P4 gate).
  // -------------------------------------------------------------------------
  if (action.action === 'run-step' && frozenVars !== null && hasDeclarations(plan.variables)) {
    const renderable = action.steps.filter(isRenderedDispatch);
    if (renderable.length) {
      const rendered = renderActionSteps({
        // Scoped runs render FROM the worktree tree INTO the worktree's
        // `.runtime/<run>/rendered/` (P2/b3) — `s.path` is the execution-tree
        // source here (identical to source_path on unscoped runs; on scoped
        // runs source_path already carries the prefix-swapped MAIN label).
        pipelineRootAbs: execRootAbs,
        runId: a.runId,
        stepSources: renderable.map((s) => s.path),
        vars: frozenVars,
      });
      if (!rendered.ok) {
        const reason = rendered.reason;
        const halted = executeForceHalt(plan, newState, reason, opts, a, stampRunFields);
        const haltOut: Record<string, unknown> = { action: 'halt', status: 'halted', reason, mode };
        if (halted.teardown) haltOut.teardown = halted.teardown;
        return { action: { action: 'halt', reason, status: 'halted' }, out: haltOut, code: 1, plan };
      }
      renderable.forEach((s, i) => {
        const renderedPath = rendered.rendered[i];
        if (renderedPath != null) {
          s.path = renderedPath;
          return;
        }
        // Outside the pipeline root (off-plan family/hub hand-off): stays
        // unrendered with `path === source_path` — a documented v1
        // limitation, but never a SILENT one: the executor is about to read
        // raw `${PP_*}` tokens.
        warnNote(
          `step ${s.step_id}: source ${s.source_path} lies outside the pipeline root — ` +
            'dispatched unrendered (pipeline variables are not substituted for out-of-root steps)',
        );
      });
    }
  }

  // Announce the outgoing action (after completions, so journal order is
  // completed(N) → started(N+1)). In-process script executions already emitted
  // their own started/completed pairs inline; `continue` announces nothing.
  // run.started was measured early (isInit false here). Event/stats labels use
  // steps[].source_path, so rendering above never leaks `.runtime/rendered/`
  // paths into the journal. The `resumed:true` tag (e7 DEFECT-3, G5) applies
  // only when this action RE-ISSUES the step the run was parked on.
  const tagResumed =
    resumedReentry &&
    action.action === 'run-step' &&
    action.steps.some(
      (s) =>
        (resumedPendingStepId !== null && s.step_id === resumedPendingStepId) ||
        (resumedPendingPath !== null &&
          (samePath(s.path, resumedPendingPath) || samePath(s.source_path, resumedPendingPath))),
    );
  emitStartedEvents(action, a.runId, toMainPath, tagResumed);
  statsNoteAction(a.root, a.runId, action);
  statsNoteTerminal(a.root, a.runId, action);

  // Attach run-context fields the manager surfaces. `warnings` only on init;
  // `provisioned`/`finalized`/`teardown` only when an in-process hook actually ran.
  const out: Record<string, unknown> = { ...action, mode };
  if (prevState === null && (plan.warnings.length || scopeWarnings.length)) {
    out.warnings = [...plan.warnings, ...scopeWarnings];
  }
  if (provisioned) out.provisioned = provisioned;
  // Worktree-scoped runs (P2/b3): surface the execution pipeline root so
  // callers (manager) derive feedback/records paths + improver context from
  // the RUN's working tree instead of the main checkout.
  if (scoped && wtPipelineRoot !== null) out.worktree_pipeline_root = execRootAbs;
  if (finalize) out.finalized = finalize;
  if (teardown) out.teardown = teardown;
  // T3-14: a surfaced `type: gate` dispatch carries its needs_input question
  // (approval marker included) so callers relay it without recomputing the plan.
  if (gateQuestion) out.gate_question = gateQuestion;

  return { action, out, code: action.action === 'halt' ? 1 : 0, plan };
}

// ---------------------------------------------------------------------------
// Composition execution (T3-10) — flattened CHILD RUNS over invokeNextCore.
//
// A `type: pipeline` dispatch (sequential/graph) becomes a nested child run:
// the parent parks in 'await-step' with the persisted stack link
// (NextState.active_child), the child pipeline runs to completion — its own
// state/ledger/outputs under `<child_root>/.runtime/<child_run_id>/` — and
// the pop synthesizes the parent's step record (the child's captured output
// feeding downstream `${steps.<id>.output.<f>}` bindings) exactly as if the
// step had executed in place. The CALLER's loop is unchanged: it keeps
// invoking the run it started, and the router below flattens the tree —
// records/resumes descend depth-first to the deepest active run, child
// actions surface annotated with the run they belong to (ActionStep.run_id /
// .pipeline_root), and terminal child actions pop into the parent. Children
// can themselves compose (the stack), bounded by the plan-lint depth cap
// (MAX_COMPOSITION_DEPTH) re-checked at runtime.
//
// Param passing: the parent step's `## Params` bindings resolve through the
// EXACT script-step resolver (lib/script-step.ts resolveParams) against the
// PARENT's outputs store / env / task / worktree context; the resolved object
// is delivered to the child through the established run-input channel
// (lib/compose-exec.ts deliverChildInputs — `${run.task}` / drive task_file).
// Child failure: a halted/depth-exhausted child pops as the SAME outcome on
// the parent's pipeline step, halt_reason prefixed with the child run — the
// parent then takes its normal halt path (retro gate, external teardown).
// A blocked child surfaces `blocked` with the stack intact, so a later
// --resume descends back into the child.
// ---------------------------------------------------------------------------

/** The composed `pipeline next` invocation — what `pipeline next`, `pipeline
 *  drive`, and embedders call. Behaviorally identical to the core for every
 *  run without `type: pipeline` steps. */
export function invokeNext(a: InvokeNextArgs): InvokeNextResult {
  // D11 defensive gate for EMBEDDERS: `pipeline next`/`drive` already reject
  // this as an exit-2 usage error before invoking (frozenVariablesError), but
  // a direct invokeNext caller must get the same rejection — checked HERE, at
  // the top-level entry, because the composition router below would otherwise
  // descend into an active child run before the core ever saw the flags
  // (silently dropping them). State is untouched: this is a refusal, not a
  // run halt.
  const frozen = frozenVariablesError(a.root, a.runId, a.cliVars);
  if (frozen !== null) {
    return {
      action: { action: 'halt', reason: frozen, status: 'halted' },
      out: { action: 'halt', status: 'halted', reason: frozen },
      code: 1,
    };
  }
  return invokeComposed(a, 0);
}

/** Remaining call budget for a nested (child/pop) invocation: the outer
 *  window minus what this level already spent. Infinity passes through
 *  (`pipeline drive`); an undefined budget anchors on the manager default. */
function remainingBudget(budget: number | undefined, entryMs: number): number {
  const base = budget === undefined ? CALL_BUDGET_MS : budget;
  if (!Number.isFinite(base)) return base;
  return Math.max(1, base - (Date.now() - entryMs));
}

/** The passthrough knobs every nested invocation inherits from the caller's
 *  top-level call. Model/effort flags deliberately do NOT propagate — a child
 *  run resolves its own defaults from its own PIPELINE.md. `cliVars` does not
 *  propagate either (same precedent): a composed child pipeline resolves its
 *  OWN `## Variables` declarations from the environment/manifest defaults at
 *  its own init — the parent's `--var` overrides stay with the parent run. */
function nestedArgs(
  a: InvokeNextArgs,
  entryMs: number,
): Pick<InvokeNextArgs, 'manualHooks' | 'manualScripts' | 'scriptRunner' | 'callBudgetMs'> {
  return {
    manualHooks: a.manualHooks,
    manualScripts: a.manualScripts,
    ...(a.scriptRunner ? { scriptRunner: a.scriptRunner } : {}),
    callBudgetMs: remainingBudget(a.callBudgetMs, entryMs),
  };
}

function invokeComposed(a: InvokeNextArgs, depth: number): InvokeNextResult {
  if (depth >= COMPOSE_EXEC_GUARD) {
    // Fail safe, never infinite-loop (hard rule): every state is persisted, so
    // hand the caller a fresh call window — re-invoking with
    // `--record '{"kind":"continue"}'` resumes exactly where the guard tripped.
    return {
      action: { action: 'continue' },
      out: {
        action: 'continue',
        detail: `composition recursion guard (${COMPOSE_EXEC_GUARD}) reached — re-invoke with --record '{"kind":"continue"}'`,
      },
      code: 0,
    };
  }
  const entryMs = Date.now();
  // The persisted stack link routes this call into the deepest active run
  // BEFORE the local engine sees anything — the parent is waiting.
  const active = activeChildOf(loadState(a.root, a.runId));
  if (active) return descendIntoChild(a, active, depth, entryMs);
  const res = invokeNextCore(a);
  return maybeStartChild(a, res, depth, entryMs);
}

/** Route the caller's record/resume into the active child run. `start` is
 *  deliberately DROPPED: a caller's --start names a step of the run it
 *  invoked, and the child resumes off its own persisted cursor. */
function descendIntoChild(
  a: InvokeNextArgs,
  active: ActiveChildRun,
  depth: number,
  entryMs: number,
): InvokeNextResult {
  const childRes = invokeComposed(
    {
      root: active.root,
      runId: active.run_id,
      record: a.record ?? null,
      resume: a.resume,
      ...nestedArgs(a, entryMs),
    },
    depth + 1,
  );
  return handleChildResult(a, active, childRes, depth, entryMs);
}

/** Post-process a child invocation's result: auto-skip its retrospective,
 *  pop a terminal child into the parent, or surface a non-terminal action
 *  annotated with the run it belongs to (the parent keeps waiting). */
function handleChildResult(
  a: InvokeNextArgs,
  active: ActiveChildRun,
  childRes: InvokeNextResult,
  depth: number,
  entryMs: number,
): InvokeNextResult {
  let cur = childRes;
  // A child's RETROSPECTIVE is auto-skipped ({kind:'retro'} recorded): the
  // action carries no pipeline-root context, so the caller would run it
  // against the WRONG root. The child's .feedback/<run_id>/ folder is
  // preserved for a parent-level / manual improver pass.
  for (let guard = 0; guard < 4 && cur.action.action === 'retrospective'; guard++) {
    warnNote(
      `composition: child run ${active.run_id} retrospective auto-skipped — feedback preserved at ${join(active.root, '.feedback', active.run_id)}`,
    );
    cur = invokeComposed(
      { root: active.root, runId: active.run_id, record: { kind: 'retro', done: false }, ...nestedArgs(a, entryMs) },
      depth + 1,
    );
  }
  const act = cur.action;
  if (act.action === 'done' || act.action === 'halt') return popChild(a, active, act, depth, entryMs);
  // Non-terminal (run-step / blocked / continue / improver / script-creator):
  // annotate surfaced steps with their run and pass the action through — the
  // parent stays parked in await-step until the child pops.
  if (act.action === 'run-step') {
    for (const s of act.steps) {
      if (s.run_id === undefined) {
        s.run_id = active.run_id;
        s.pipeline_root = active.root;
      }
    }
  }
  cur.out.composed_run_id ??= active.run_id;
  cur.out.composed_pipeline_root ??= active.root;
  return cur;
}

/** Pop a TERMINAL child run into its parent: synthesize the parent's step
 *  record (child output captured + validated on `done`; halt reasons composed
 *  on failure) and feed it through the CORE — never the router, whose stack
 *  link (still set) would descend into the now-terminal child. The engine
 *  clears active_child while consuming the record (same state save), so no
 *  crash window separates consumption from the link's removal. */
function popChild(
  a: InvokeNextArgs,
  active: ActiveChildRun,
  terminal: Extract<NextAction, { action: 'done' } | { action: 'halt' }>,
  depth: number,
  entryMs: number,
): InvokeNextResult {
  const parentState = loadState(a.root, a.runId);
  if (!parentState) {
    // Should be impossible (the dispatch that spawned the child persisted
    // state) — fail loud rather than feeding a record into a fresh init.
    const reason = `composition: parent state missing for run ${a.runId} while popping child ${active.run_id}`;
    return {
      action: { action: 'halt', reason, status: 'halted' },
      out: { action: 'halt', status: 'halted', reason },
      code: 1,
    };
  }
  let record: StepRecord;
  if (terminal.action === 'done') {
    // Child output = the persisted output of the step that ENDED the child
    // run, validated against the parent step's ## Output declaration with the
    // script-step validator (§3.4) — a violation fails the pipeline step the
    // same way a script's non-conformant stdout does (contract).
    const childState = loadState(active.root, active.run_id);
    const spec = planStepFor(computePlan(a.root), active.step_path, active.step_id)?.pipeline_spec ?? null;
    const { output, violation } = childRunOutput(
      active.root,
      active.run_id,
      childState?.current_step_id ?? null,
      spec?.output ?? null,
    );
    if (violation) {
      record = {
        kind: 'step',
        outcome: 'halted',
        halt_reason: `pipeline step ${active.step_id} failed (contract): child run '${active.run_id}' output violates the ## Output declaration: ${violation}`,
      };
    } else {
      // Sequential parents advance off the parent step's own ## Next — the
      // same mechanical parse (and the same warn-on-unparseable degradation)
      // as script steps (§5.2); graph/DAG parents route off flags/layers.
      let nextIteration: string | null = null;
      if (parentState.mode === 'sequential') {
        const parsed = parseNextSection(active.step_path);
        if (parsed.error) warnNote(`pipeline step ${active.step_id}: ## Next not mechanically parseable: ${parsed.error}`);
        nextIteration = parsed.next;
      }
      record = { kind: 'step', outcome: 'completed', flags: null, next_iteration: nextIteration, output };
    }
  } else {
    const status: 'halted' | 'depth-exhausted' = terminal.status === 'depth-exhausted' ? 'depth-exhausted' : 'halted';
    record = {
      kind: 'step',
      outcome: status,
      halt_reason: `pipeline step ${active.step_id}: child pipeline run '${active.run_id}' (${active.root}) ${status}: ${terminal.reason}`,
    };
  }
  const res = invokeNextCore({ root: a.root, runId: a.runId, record, resume: false, ...nestedArgs(a, entryMs) });
  // The parent's next dispatch may itself be a pipeline step (chained
  // composition) — same interception, bounded by the recursion guard.
  return maybeStartChild(a, res, depth + 1, entryMs);
}

/** Intercept a freshly-dispatched `type: pipeline` step: start its child run
 *  (sequential/graph), or degrade a parallel-layer member to a LOUD halt
 *  (composed child runs are sequential-only in v1 — the §6.4 idiom). */
function maybeStartChild(a: InvokeNextArgs, res: InvokeNextResult, depth: number, entryMs: number): InvokeNextResult {
  const action = res.action;
  if (action.action !== 'run-step') return res;
  if (action.concurrent === true) {
    const members = action.steps.filter((s) => s.type === 'pipeline');
    if (members.length === 0) return res;
    const results: LayerResultEntry[] = members.map((s) => ({
      step_id: s.step_id,
      outcome: 'halted' as const,
      halt_reason: `type: pipeline step '${s.step_id}' is not supported inside a parallel layer (v1) — compose sequentially`,
    }));
    return invokeNextCore({ root: a.root, runId: a.runId, record: { kind: 'layer', results }, resume: false, ...nestedArgs(a, entryMs) });
  }
  const step = action.steps[0];
  // Annotated steps belong to a CHILD run and were already routed at the
  // child's own wrapper level — only this run's own dispatches start here.
  if (step === undefined || step.type !== 'pipeline' || step.run_id !== undefined) return res;
  return startChild(a, res, step, depth, entryMs);
}

/** Start the child run for one `type: pipeline` dispatch: resolve params
 *  (script-step resolver, parent-side sources), scaffold the run-tree +
 *  child inputs, persist the stack link, and init the child. */
function startChild(
  a: InvokeNextArgs,
  res: InvokeNextResult,
  step: ActionStep,
  depth: number,
  entryMs: number,
): InvokeNextResult {
  const rootAbs = resolve(a.root);
  const feed = (record: StepRecord): InvokeNextResult =>
    maybeStartChild(
      a,
      invokeNextCore({ root: a.root, runId: a.runId, record, resume: false, ...nestedArgs(a, entryMs) }),
      depth + 1,
      entryMs,
    );
  const bindingHalt = (detail: string): InvokeNextResult =>
    feed({ kind: 'step', outcome: 'halted', halt_reason: `pipeline step ${step.step_id} failed (binding): ${detail}` });

  const spec = planStepFor(res.plan ?? computePlan(a.root), step.path, step.step_id)?.pipeline_spec ?? null;
  if (!spec || spec.resolved_root === null) {
    // Defensive (plan/state drift): computePlan ERRORs on an unresolvable
    // reference, so a dispatched pipeline step always carries one — unless
    // the tree changed mid-run.
    return bindingHalt('the plan carries no resolved pipeline_spec for it');
  }
  const childRoot = resolve(spec.resolved_root);

  // Runtime fail-safe on the plan-lint depth cap: the reachable graph is a
  // lint-validated DAG, but files can change mid-run — never nest past the cap.
  const parentDepth = composedDepthOf(rootAbs, a.runId);
  if (parentDepth + 1 > MAX_COMPOSITION_DEPTH) {
    return feed({
      kind: 'step',
      outcome: 'halted',
      halt_reason: `pipeline step ${step.step_id}: composition depth ${parentDepth + 1} exceeds the cap (${MAX_COMPOSITION_DEPTH}) at runtime — the composition changed after plan lint`,
    });
  }

  // Parent-side `## Params` bindings — the EXACT script-step resolver (§3),
  // against the PARENT run's outputs store / env / task / worktree context.
  // A binding failure halts the parent BEFORE any child scaffolding, exactly
  // like a script step's pre-spawn 'binding' failure.
  const parentState = loadState(a.root, a.runId);
  // Worktree-scoped parent (P2/b3): its run artifacts (outputs store) live
  // under the WORKTREE pipeline root — bind against that tree.
  const parentExecRoot =
    parentState?.worktree_scoped === true && typeof parentState.worktree_pipeline_root === 'string'
      ? resolve(parentState.worktree_pipeline_root)
      : rootAbs;
  const sources: BindingSources = {
    runId: a.runId,
    pipelineRoot: parentExecRoot,
    projectRoot: process.cwd(),
    worktreePath: step.worktree_path ?? parentState?.worktree_path ?? null,
    worktreeEnvFile: step.worktree_env_file ?? parentState?.worktree_env_file ?? null,
    taskText: readTaskText(a.root, a.runId),
    readOutput: (id) => readPersistedOutput(parentExecRoot, a.runId, id),
    // The PARENT run's frozen PP_* map (env-variables design a4): resolveRef's
    // PP_* root reads it, so a pipeline-step `## Params` `from: ${PP_X}`
    // template resolves exactly like a script step's (the "EXACT script-step
    // resolver" contract above). Absent key = the E9 zero-change path.
    ...(parentState?.variables !== undefined ? { variables: parentState.variables } : {}),
  };
  const resolved = resolveParams(spec.params, sources);
  if (!resolved.ok) return bindingHalt(resolved.detail);
  if (!parentState) {
    // Should be impossible (the core persisted this dispatch moments ago) —
    // fail loud directly: feeding a record into a state-less engine call
    // would re-INIT the run instead of consuming it.
    const reason = `composition: parent state missing for run ${a.runId} after dispatching pipeline step ${step.step_id}`;
    return {
      action: { action: 'halt', reason, status: 'halted' },
      out: { action: 'halt', status: 'halted', reason },
      code: 1,
    };
  }

  // Deterministic child run id; run-tree records + input delivery are written
  // BEFORE the stack link is persisted, so a crash at any point leaves either
  // no link (the resume re-dispatches and a fresh child starts) or a fully
  // scaffolded child (the resume descends and the child inits/resumes).
  const childRunId = childRunIdFor(a.runId, step.step_id, step.index);
  registerChildRun(
    { root: rootAbs, runId: a.runId },
    { root: childRoot, runId: childRunId, stepId: step.step_id, dispatchIndex: step.index },
  );
  deliverChildInputs(
    childRoot,
    childRunId,
    spec.params !== null ? { ...resolved.params } : null,
    taskFileFor(rootAbs, a.runId),
  );

  const active: ActiveChildRun = {
    root: childRoot,
    run_id: childRunId,
    step_id: step.step_id,
    step_path: step.path,
    dispatch_index: step.index,
  };
  parentState.active_child = active;
  saveState(a.root, a.runId, parentState);

  // Init the child run (record null = init; its own hooks/scripts collapse
  // in-process) and route the result: terminal ⇒ pop, else surface annotated.
  const childRes = invokeComposed(
    { root: childRoot, runId: childRunId, record: null, resume: false, ...nestedArgs(a, entryMs) },
    depth + 1,
  );
  return handleChildResult(a, active, childRes, depth, entryMs);
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export function runNext(args: string[]): number {
  const a = parseArgs(args);
  if (!a.root || !a.runId) {
    process.stderr.write('pipeline next: --root and --run-id are required\n');
    return 2;
  }
  // `--record-file <path>`: read the record JSON from a UTF-8 file, then flow
  // through the IDENTICAL parse path as an inline `--record` (parseRecord,
  // including backslash normalization + the loud malformed-record error). The
  // file is read-only here — never deleted or modified.
  if (a.recordFile !== undefined) {
    if (a.recordSeen) {
      process.stderr.write('pipeline next: --record and --record-file are mutually exclusive\n');
      return 2;
    }
    let raw: string;
    try {
      raw = readFileSync(a.recordFile, 'utf8');
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      process.stderr.write(`pipeline next: --record-file ${a.recordFile} could not be read: ${why}\n`);
      return 2;
    }
    applyRecord(a, parseRecord(raw));
    if (a.recordError !== undefined) {
      process.stderr.write(`pipeline next: --record-file ${a.recordFile}: ${a.recordError}\n`);
      return 2;
    }
  }
  // A `--record` was supplied but is malformed. This MUST be a loud failure
  // (exit 2) — never a silent auto-resume — so the manager retries with valid
  // JSON instead of discarding the completed step the record was reporting.
  if (a.recordError !== undefined) {
    process.stderr.write(`pipeline next: ${a.recordError}\n`);
    return 2;
  }
  // Same loudness for a malformed `--model` / `--effort` — a typo'd override
  // must never be silently dropped (the run would quietly execute on the
  // wrong model/effort).
  if (a.modelError !== undefined) {
    process.stderr.write(`pipeline next: ${a.modelError}\n`);
    return 2;
  }
  if (a.effortError !== undefined) {
    process.stderr.write(`pipeline next: ${a.effortError}\n`);
    return 2;
  }
  // Same loudness for a malformed `--var` (no NAME=value shape) — a typo'd
  // override must never be silently dropped (L10/T11).
  if (a.varsError !== undefined) {
    process.stderr.write(`pipeline next: ${a.varsError}\n`);
    return 2;
  }
  // `--vars-file`: strict dotenv load BEFORE any state exists — unreadable or
  // malformed files are startup errors naming the offending line (F10). Key
  // rejection (non-PP_/undeclared, T11) happens in run-init validation (L10).
  let fileVars: Record<string, string> | undefined;
  if (a.varsFile !== undefined) {
    const loaded = loadVarsFile(a.varsFile);
    if (!loaded.ok) {
      process.stderr.write(`pipeline next: ${loaded.error}\n`);
      return 2;
    }
    fileVars = loaded.vars;
  }
  const cliVars = mergeCliVars(fileVars, a.varFlags);
  // D11: supplying variables against an already-frozen run (or while a
  // composed child is active) is a USAGE error — the run is intact and a
  // flag-less call continues it, so reject with exit 2 BEFORE the engine
  // runs (no phantom halt action/event, no state or stats touched).
  const frozen = frozenVariablesError(a.root, a.runId, cliVars);
  if (frozen !== null) {
    process.stderr.write(`pipeline next: ${frozen}\n`);
    return 2;
  }

  const res = invokeNext({
    root: a.root,
    runId: a.runId,
    start: a.start,
    defaultModel: a.defaultModel,
    modelOverrides: a.modelOverrides,
    defaultEffort: a.defaultEffort,
    effortOverrides: a.effortOverrides,
    ...(cliVars !== undefined ? { cliVars } : {}),
    record: a.record ?? null,
    resume: a.resume,
    manualHooks: a.manualHooks,
    manualScripts: a.manualScripts,
  });

  process.stdout.write(JSON.stringify(res.out, null, 2) + '\n');
  return res.code;
}
