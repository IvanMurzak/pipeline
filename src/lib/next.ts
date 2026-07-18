// computeNext — the deterministic orchestration state machine.
//
// This is the control-flow work the pipeline-manager used to do in its own
// context: decide what to run next (the next step, the improver, a
// script-creator, a worktree merge, the end-of-run retrospective, or terminate),
// for every execution mode (sequential / graph / parallel-DAG). Moving it here
// turns the manager into a thin actuator — it asks `pipeline next` for the next
// ACTION, performs it (spawn / parse / merge / emit), records the structured
// OUTCOME, and asks again. The loop, the improver/script gating, the
// retrospective gate, and the terminal decision all live here, tested, instead
// of being re-derived in prose on every run.
//
// The engine is PURE: it takes the plan + the persisted state + the record of
// the just-performed action and returns the next action + the new state. The
// `pipeline next` command (commands/next.ts) owns persistence, plan computation,
// and counting feedback files. Graph routing reuses routeNext() from graph.ts,
// keeping the bounded-retry counter logic in exactly one place.

import type { Plan, PlanStep, Isolation } from './plan';
import { routeNext, emptyRouteState, type RouteState } from './graph';
import { ENGINE_OUTCOMES } from './step-schema';
import type { ScriptCreatorOutcome } from './improver-schema';
import type { StepType } from './script-types';
import { resolve } from 'node:path';

export type RunMode = 'sequential' | 'graph' | 'parallel';

export type NextPhase =
  | 'await-provision' // external mode: provision-worktree emitted; awaiting the {worktree,provisioned} record
  | 'await-step' // a step (sequential/graph) or a whole layer (parallel) is in flight
  | 'await-merge' // parallel worktree layer finished; awaiting the merge record
  | 'await-improver' // a between-steps improver run is in flight
  | 'await-script' // a script-creator is in flight
  | 'await-retro' // the end-of-run retrospective is in flight
  | 'await-finalize' // external mode: finalize-worktree emitted; awaiting the {worktree,finalized} record — MUST succeed or the run halts (worktree preserved)
  | 'await-teardown' // external mode: teardown-worktree emitted; awaiting the {worktree,torn-down} record
  | 'blocked' // returned a `blocked` action; awaiting a `--resume`
  | 'terminal'; // run finished (done / halt) — idempotent from here

export type TerminalStatus = 'completed' | 'halted' | 'depth-exhausted' | 'blocked-delegating';

export interface ImproveItem {
  step_id: string;
  iteration_path: string;
}

export interface NextState {
  mode: RunMode;
  isolation: Isolation;
  default_model: string | null;
  /** Pipeline-level reasoning effort (plan.default_effort). Absent on
   *  pre-effort next.json files → treated as null (inherit). */
  default_effort?: string | null;
  phase: NextPhase;
  /** Count of steps dispatched so far — the 1-based `index` for iteration.started. */
  index: number;
  /** Sequential/graph cursor: the step currently in flight or just recorded. */
  current_step_id: string | null;
  current_path: string | null;
  /** Graph routing counters (reused by routeNext). */
  route: RouteState;
  /** Parallel: index into plan.layers of the in-flight layer. */
  layer_index: number;
  /** Parallel: step_ids dispatched in the in-flight layer. */
  layer: string[];
  /** Between-steps improvement work pending for the just-finished step(s). */
  improve_queue: ImproveItem[];
  /** Script-creator runs for the CURRENT improver: total + how many are done. */
  scripts_total: number;
  scripts_done: number;
  improve_target: string | null;
  /** Stored advancement decision (consumed once the improve queue drains). */
  pending_next: string | null; // sequential: the next_iteration the step reported
  pending_flags: Record<string, unknown> | null; // graph: the step's result_flags
  /** Terminal bookkeeping. */
  status: TerminalStatus | null;
  halt_reason: string | null;
  /**
   * External-isolation bookkeeping (isolation === 'external', sequential only).
   * `worktree_provisioned` gates teardown — it is the single fact that says a
   * worktree exists to tear down. The path + env file are re-learned on resume
   * by re-running the idempotent create hook (§4.2 — executed in-process by the
   * `pipeline next` command); they are persisted so the engine knows
   * provisioning already happened.
   */
  worktree_provisioned: boolean;
  worktree_path: string | null;
  worktree_env_file: string | null;
  /**
   * Opt-in to the mandatory **finalize** stage (external isolation only). TRUE
   * when the pipeline opted in — via `finalize: true` frontmatter (plan.finalize)
   * OR the presence of a `worktree-finalize.*` hook (resolved by the command and
   * passed as opts.finalizeOptIn). Persisted so the terminal seam knows to run
   * finalize BEFORE teardown. Default false ⇒ the stage never fires and the run
   * is byte-for-byte unchanged. A pre-finalize next.json lacks the key → reads as
   * undefined (≠ true) on resume, so in-flight legacy runs never finalize.
   */
  finalize: boolean;
  /** Finalize-hook result, made observable in state (mirrors teardown_ok). null
   *  until the {worktree,finalized} record lands. */
  finalize_ok: boolean | null;
  finalize_detail: string | null;
  /**
   * Teardown-hook result, made observable in state instead of being silently
   * dropped (§ robustness). null until the {worktree,torn-down} record lands;
   * `false` is the leaked-worktree signal a caller/UI can surface. The run still
   * PROCEEDS to terminal regardless — a leaked worktree never hangs the run.
   */
  teardown_ok: boolean | null;
  teardown_detail: string | null;
  /**
   * Design-time lint findings (plan.warnings: token budgets, procedural blocks,
   * …) captured ONCE at run init and persisted, so a resumed/re-spawned run
   * still carries them. Threaded onto the `retrospective` action — only when
   * non-empty — so the retrospective improver pass can compact bloated files.
   * Backward compat: an old next.json lacks the key → normalized to [] on load
   * (computeNext), so legacy in-flight runs behave exactly as before.
   */
  lint_warnings: string[];
  /**
   * Per-run step-model overrides (`--model <step_id>=<model>`), persisted at
   * init by the `pipeline next` COMMAND so later loop calls and crash/blocker
   * resumes keep them without the caller re-passing every flag. The pure
   * engine never reads this field — the command folds it into the plan it
   * computes (plan.model_overrides / steps[].model). Absent on pre-override
   * next.json files → treated as none.
   */
  model_overrides?: Record<string, string | null>;
  /** Per-run step-effort overrides (`--effort <step_id>=<level>`) — same
   *  persistence contract as model_overrides. Absent → none. */
  effort_overrides?: Record<string, string | null>;
  /**
   * The run's FROZEN PP_* variable map (env-variables design, D11): resolved
   * ONCE at run init by the `pipeline next` COMMAND (`--var`/`--vars-file` >
   * environment > manifest defaults, D2) and persisted here so resumes reuse
   * it verbatim — environment drift mid-run can never make step 7 see
   * different values than step 2. The pure engine never reads this field
   * (the model_overrides persistence pattern). Key PRESENCE is load-bearing:
   * a state WITHOUT the key predates variables (legacy, or the first run
   * after a pipeline gained declarations) and takes the one-time
   * resolve+write-back (F10); a state WITH it (even `{}`) is frozen — `--var`
   * on such a run is an error (D11-REVISED). Never written for a pipeline
   * with no declarations (E9 zero-change).
   */
  variables?: Record<string, string>;
  /**
   * Script-step self-healing bound #1 (DESIGN.md §6.4): step_ids whose
   * ONCE-per-run agent fallback (`on-failure: agent`) has already fired.
   * Written by the engine when opts.scriptFallback dispatches the fallback;
   * consulted to refuse a second one (the halt-shaped record is then processed
   * normally — the halt path). Absent on a legacy next.json → normalized to {}
   * on load (the lint_warnings pattern).
   */
  fallback_attempted?: Record<string, true>;
  /**
   * Agent-step retries (A2 — 04-runner-crash-resume.md §retries): step_ids
   * mapped to how many RETRY attempts have been dispatched so far (0 = never
   * retried), mirroring fallback_attempted's storage shape. Written by the
   * engine BEFORE it re-dispatches a transiently-halted agent step (the
   * onStepPhase retry decision, sibling of the scriptFallback block);
   * consulted there to bound further retries against the step's `retries:`
   * frontmatter budget (plan.ts PlanStep.retries) and by resumeRun's crash
   * twin to re-emit an in-flight retry dispatch correctly. A step_id's count
   * is NEVER reset (matches fallback_attempted's once-per-run-bound idiom) —
   * a graph loop-back revisiting the same step_id later shares the same
   * budget rather than getting a fresh one. Sequential steps only in v1:
   * concurrent-layer members never reach this map (their results arrive as a
   * single {kind:'layer'} record, never the per-step retry decision seam).
   * Absent on a legacy next.json → normalized to {} on load (the
   * fallback_attempted pattern).
   */
  agent_attempts?: Record<string, number>;
  /**
   * Script-step self-healing bound #2 (§6.4): step_ids whose script received
   * an in-run `mode: repair-script` fix. OWNED by the command layer (T31
   * appends after dispatching a repair and consults it before dispatching
   * another — a second failure of the same script after an in-run repair ⇒
   * halt); the pure engine only carries/persists the field. Absent →
   * normalized to [].
   */
  repaired_steps?: string[];
  /**
   * Partial-layer holding pen (§9): results of a concurrent layer's SCRIPT
   * members, executed in-process by the command layer BEFORE the (agent-only)
   * `run-step` action went to the caller. onLayerRecord folds these with the
   * incoming layer record's results, then clears the field. Preserved
   * untouched across a §7 `continue` re-emit. Absent → normalized to null.
   */
  partial_layer_results?: LayerResultEntry[] | null;
  /**
   * §6.3 pending agent-fallback marker: non-null iff the dispatch currently
   * in flight (phase 'await-step', at the CURRENT state.index) is the
   * agent-type fallback of a failed script step. Without it, nothing in the
   * persisted state distinguishes that dispatch from a plain script dispatch
   * — the PLAN step's type is 'script' — so a crash-resume would re-emit a
   * SCRIPT dispatch, re-execute the already-failed side-effectful script at a
   * fresh index (no ledger entry), fail again with the once-per-run §6.4
   * bound already consumed, and halt: the §6.3-promised fallback would never
   * run. Set by dispatchFallback; cleared wherever the pending dispatch is
   * consumed (a step record arrives) or superseded (any fresh dispatch or
   * halt) — it never survives past the dispatch it describes. NOT cleared by
   * the §7 `continue` / crash-resume re-emits (same pending dispatch).
   * Absent on a legacy next.json → normalized to null.
   */
  pending_fallback?: { failure_record: string } | null;
  /**
   * Composition (T3-10): the CHILD RUN currently executing the pending
   * `type: pipeline` dispatch — the persisted STACK link that makes the
   * parent wait. OWNED by the command layer (the repaired_steps pattern): it
   * sets the field when it starts the child run (after the engine parked this
   * state in 'await-step' for the pipeline step) and consults it on every
   * later call to route records/resumes into the child, depth-first. The PURE
   * engine only carries/persists the field and CLEARS it exactly where a
   * pending dispatch is consumed or superseded (the pending_fallback sites),
   * so the pop record's consumption and the field's clearing land in the SAME
   * state save — no crash window in which the child's result is consumed but
   * the stale stack link survives (a resume would re-descend into a TERMINAL
   * child and pop a duplicate record onto the NEXT step). Absent on a legacy
   * next.json → normalized to null.
   */
  active_child?: ActiveChildRun | null;
  /**
   * Worktree-scoped pipeline I/O (P2/b3 — fix-fundamental-issues design 05.1,
   * D3/D6): the run's FROZEN path model, OWNED by the command layer (the
   * model_overrides persistence pattern — the pure engine never reads these).
   * `worktree_scoped` is the `PIPELINE_WORKTREE_SCOPED` rollout flag frozen
   * per-run at init: a mid-run env flip can never mix path models within one
   * run. Written ONLY for external-isolation-shaped runs; absent on every
   * other run (zero state-shape change) and on legacy in-flight external
   * runs, which read as false (main-scoped — an in-flight run never switches
   * models mid-run).
   */
  worktree_scoped?: boolean;
  /**
   * The `(worktree_prefix, main_prefix)` pair of the 05.1.3 prefix-swap
   * mapping — absolute pipeline roots, recorded once the run worktree is
   * provisioned. The whole plan is computed FROM `worktree_pipeline_root`
   * (dispatch, ledger keys, `## Next` parsing are worktree paths); the
   * command layer derives every observability `source_path` by swapping the
   * worktree prefix back to `main_pipeline_root`, keeping events/stats/UI on
   * stable author paths. Only meaningful when `worktree_scoped` is true.
   */
  worktree_pipeline_root?: string | null;
  main_pipeline_root?: string | null;
}

/** Composition (T3-10): the persisted parent→child stack link (see
 *  NextState.active_child). All paths absolute. */
export interface ActiveChildRun {
  /** Absolute root of the CHILD pipeline (the dir holding its PIPELINE.md). */
  root: string;
  /** The child run's id (deterministic per parent dispatch — see
   *  lib/compose-exec.ts childRunIdFor). */
  run_id: string;
  /** The parent `type: pipeline` step this child run executes. */
  step_id: string;
  /** Absolute path of the parent step's iteration file (its `## Next` is
   *  parsed mechanically at pop time in sequential mode — script-step rule). */
  step_path: string;
  /** The parent dispatch index the child run is keyed on. */
  dispatch_index: number;
}

export interface ActionStep {
  step_id: string;
  path: string;
  /**
   * The step's SOURCE iteration file (env-variables design, D6): always set.
   * The pure engine always emits `source_path === path`; on a variable-
   * declaring run the COMMAND layer (commands/next.ts, P4/a5) re-points an
   * AGENT step's `path` at its lazily rendered copy under
   * `.runtime/<run>/rendered/` while `source_path` keeps the author-owned
   * original for the improver/script-creator briefs and every path-keyed
   * consumer (events, stats, awaiting/--start round-trips). Script, gate,
   * pipeline, and §6.3 fallback dispatches keep `path === source_path` (E11).
   */
  source_path: string;
  model: string | null;
  /** Resolved reasoning effort for this spawn (override ?? step frontmatter ??
   *  pipeline default ?? null = inherit). The headless runner passes it as
   *  `claude --effort`; the manager passes it to the Agent tool when the
   *  harness supports a per-call effort param (else it degrades to inherit). */
  effort: string | null;
  /** "worktree" in parallel+worktree mode; null otherwise (run in-place). */
  isolation: 'worktree' | null;
  /**
   * 1-based dispatch index for the iteration.started event. This is ALSO the
   * `dispatch_index` the command layer keys the §8 attempt ledger on —
   * `(step_id, index)` maps 1:1 to lib/script-step.ts `ctx.dispatchIndex`
   * (ledger file `<run>/ledger/<step_id>-<index>.json`), so no extra field is
   * needed. Every REAL (re-)dispatch — advance, graph loop-back, resume,
   * agent fallback — allocates a fresh value by bumping `state.index` first;
   * the §7 `continue` re-emit reuses the CURRENT value (same pending dispatch,
   * the step never ran in the exhausted call window), which is load-bearing
   * for ledger reuse across call windows.
   */
  index: number;
  /** Step kind threaded from PlanStep.type ('agent' | 'script'); synthesized
   *  off-plan steps are always 'agent'. The command layer keys in-process
   *  script execution on this; a §6.3 fallback re-dispatch FORCES it back to
   *  'agent' (the executor achieves the Goal manually). */
  type: StepType;
  /** §6.3 `on-failure: agent` re-dispatch marker: present ONLY on the
   *  agent-fallback dispatch of a failed script step (with failure_record). */
  fallback?: 'script-failure';
  /** Absolute path of the §6.2.1 failure record the fallback executor reads
   *  (full stdout/stderr live in the sibling .log). */
  failure_record?: string;
  /**
   * Agent-step retries (A2 — 04 §retries.6): present ONLY on a retry
   * re-dispatch — the 1-based attempt number (matching the value just written
   * to state.agent_attempts[step_id]). Additive event tagging: the command
   * layer folds it into the re-dispatch's `iteration.started` payload as
   * `retry: n`. Absent on a step's FIRST (non-retry) dispatch.
   */
  retry?: number;
  /**
   * External-isolation (run-level) context, threaded onto every step of an
   * `isolation: external` run. INFORMATIONAL only — the step `cd`s into
   * `worktree_path` and sources `worktree_env_file` itself; the native
   * `isolation:'worktree'` Agent option is NOT set (it stays null). The
   * `external_worktree` flag suppresses the executor's native-parallel
   * self-detection (§5, §6 step-executor row). Absent on non-external steps.
   */
  external_worktree?: true;
  worktree_path?: string;
  worktree_env_file?: string;
  /**
   * Composition (T3-10) annotations, stamped by the COMMAND layer on steps
   * surfaced from a nested CHILD run: the run id / pipeline root the step
   * actually belongs to, so callers key record/session files and prompt
   * context (feedback dir, task file) on the child run instead of the run
   * they invoked. ABSENT on steps of the invoked run itself — the pure
   * engine never sets these.
   */
  run_id?: string;
  pipeline_root?: string;
}

export interface MergeBranch {
  step_id: string;
  branch: string;
  path: string;
}

export type NextAction =
  | { action: 'run-step'; concurrent: boolean; steps: ActionStep[] }
  | { action: 'merge'; branches: MergeBranch[] }
  | { action: 'run-improver'; iteration_path: string }
  | { action: 'run-script-creator'; iteration_path: string; number: number; of: number }
  | {
      action: 'retrospective';
      /** Design-time lint findings captured at init (state.lint_warnings).
       *  Present ONLY when non-empty — a lint-clean pipeline's retrospective
       *  action stays byte-identical to the pre-field shape. */
      lint_warnings?: string[];
    }
  | {
      // external mode: provision the run-level worktree before the first step.
      // By default the `pipeline next` COMMAND executes the consumer's create
      // hook in-process (commands/next.ts + lib/hooks.ts) with these env-var
      // inputs and feeds back {kind:'worktree',phase:'provisioned',...}; a
      // --manual-hooks caller (legacy manager) actuates it by hand instead.
      action: 'provision-worktree';
      name: string;
      run_id: string;
      base_branch: string;
      submodules: string[];
      hook_dir: string;
      project_root: string | null;
      pipeline_root: string | null;
    }
  | {
      // external mode: run the consumer's MANDATORY finalize hook once, at the
      // very end of a COMPLETED run, AFTER the last step + optional retro and
      // BEFORE teardown. Its hook MUST return {ok:true} or the run halts (the
      // worktree is preserved). GENERIC: the plugin has zero knowledge of WHAT
      // finalize does — that is entirely the consumer hook's business. By default
      // the `pipeline next` COMMAND executes the consumer's `worktree-finalize.*`
      // hook in-process with these inputs and feeds back
      // {kind:'worktree',phase:'finalized',ok,detail}; --manual-hooks defers to
      // the caller.
      action: 'finalize-worktree';
      name: string;
      run_id: string;
      worktree_path: string | null;
      outcome: 'completed'; // finalize only fires on a completed run
      submodules: string[];
      base_branch: string;
      hook_dir: string;
      project_root: string | null;
      pipeline_root: string | null;
    }
  | {
      // external mode: tear down the run-level worktree at run end. By default
      // the `pipeline next` COMMAND executes the consumer's destroy hook
      // in-process with these inputs and feeds back
      // {kind:'worktree',phase:'torn-down',...}; --manual-hooks defers to the caller.
      action: 'teardown-worktree';
      name: string;
      run_id: string;
      worktree_path: string | null;
      outcome: 'completed' | 'halted' | 'depth-exhausted';
      delete_branches: boolean;
      hook_dir: string;
      project_root: string | null;
      pipeline_root: string | null;
    }
  | {
      // §7 call-budget hand-off. Emitted by the COMMAND layer ONLY (the pure
      // engine never returns it): the pending script execution does not fit
      // the remaining call budget, state is already persisted with the
      // dispatch allocated, and the caller must perform NOTHING except
      // re-invoke `pipeline next … --record '{"kind":"continue"}'` in a fresh
      // call window. Declared here so the full caller-facing action
      // vocabulary lives in one union (DESIGN.md §14).
      action: 'continue';
    }
  | { action: 'done' }
  | { action: 'halt'; reason: string; status: 'halted' | 'depth-exhausted' }
  | { action: 'blocked' };

// ---- Records the manager sends back after performing an action ----

/** Derived from lib/step-schema.ts's ENGINE_OUTCOMES so the engine types and
 *  the --json-schema headless executors are validated against cannot drift:
 *  adding an outcome to one without the other fails typecheck. */
export type EngineOutcome = (typeof ENGINE_OUTCOMES)[number];

export interface StepRecord {
  kind: 'step';
  outcome: EngineOutcome;
  flags?: Record<string, unknown> | null;
  next_iteration?: string | null;
  has_improvement_brief?: boolean;
  halt_reason?: string | null;
  /** OPTIONAL additive dataflow payload (DESIGN.md §10) — persisted by the
   *  command layer to `<run>/outputs/<step_id>.json`. Script steps synthesize
   *  it from stdout JSON (lib/script-step.ts ScriptStepRecord); agent steps
   *  may report it via the STEP_RECORD_SCHEMA `output` field (T00). The pure
   *  engine carries it without inspection. */
  output?: Record<string, unknown> | null;
}
export interface LayerResultEntry {
  step_id: string;
  outcome: EngineOutcome;
  worktree_branch?: string | null;
  worktree_path?: string | null;
  has_improvement_brief?: boolean;
  halt_reason?: string | null;
}
export interface LayerRecord {
  kind: 'layer';
  results: LayerResultEntry[];
}
export interface MergeRecord {
  kind: 'merge';
  conflict?: boolean;
  detail?: string | null;
}
export interface ImproverRecord {
  kind: 'improver';
  applied?: boolean;
  script_briefs?: number;
}
export interface ScriptRecord {
  kind: 'script';
  /** pipeline-script-creator result vocabulary: 'created'/'updated' (extract
   *  mode), 'converted' (convert-step mode), 'repaired' (repair-script mode),
   *  'refused'. Derived from lib/improver-schema.ts's SCRIPT_CREATOR_OUTCOMES
   *  (the --json-schema headless sessions validate against it) so the two
   *  cannot drift. The pure engine never keys on the value — onScriptPhase
   *  only counts records; the command layer/stats interpret the outcome. */
  outcome?: ScriptCreatorOutcome;
  /** Absolute path of the created/updated script (or null when refused). The
   *  manager reports it so the CLI can emit script_creator.completed. */
  script_path?: string | null;
}
export interface RetroRecord {
  kind: 'retro';
  done?: boolean;
}
/** §7: the caller's answer to a command-layer {action:'continue'} — a fresh
 *  call window opened, nothing was performed. In phase 'await-step' the engine
 *  re-emits the SAME pending dispatch (same step(s), same dispatch
 *  index(es) — idempotent, counters untouched); in any other phase it is a
 *  protocol violation and takes the uniform wrong-record halt. The record
 *  exists (instead of a bare no-record call) because a no-record re-entry
 *  already means "crashed manager auto-resume" to the command layer. */
export interface ContinueRecord {
  kind: 'continue';
}
/** T3-14 approval gates: the ANSWER delivered for a parked `type: gate`
 *  dispatch — `answer` is the raw needs-input answer text, expected to be the
 *  JSON string {"decision":"approve"|"reject","comment":string|null}. The
 *  COMMAND layer (commands/next.ts) parses it and swaps in the plain step
 *  record it resolves to BEFORE the pure engine sees anything (approve ⇒
 *  completed + mechanical `## Next`; reject/unparseable ⇒ halted — never
 *  treated as approval). A gate-answer that reaches the engine anyway (no
 *  pending gate dispatch) takes the uniform wrong-record halt. */
export interface GateAnswerRecord {
  kind: 'gate-answer';
  answer?: unknown;
}
export interface WorktreeRecord {
  kind: 'worktree';
  phase: 'provisioned' | 'finalized' | 'torn-down';
  /** create hook stdout (provisioned): where the worktree lives + its env file. */
  worktree_path?: string | null;
  branch?: string | null;
  env_file?: string | null;
  /** finalize hook (finalized): must-succeed flag + optional detail. destroy hook
   *  stdout (torn-down): clean-teardown flag + optional detail. create hook
   *  (provisioned): ok:false signals a failed provision. */
  ok?: boolean;
  detail?: string | null;
}
export type NextRecord =
  | StepRecord
  | LayerRecord
  | MergeRecord
  | ImproverRecord
  | ScriptRecord
  | RetroRecord
  | WorktreeRecord
  | ContinueRecord
  | GateAnswerRecord;

export interface NextOpts {
  /** Starting iteration path (init or resume). When absent, init uses steps[0]. */
  start?: string;
  /** Resume after a nested blocker landed — re-run the current/start step. */
  resume?: boolean;
  /** Number of files in <root>/.feedback/<run_id>/ — gates the retrospective. */
  feedbackCount: number;
  /**
   * Run/path context surfaced ONLY in `provision-worktree`/`teardown-worktree`
   * actions (external mode). Optional + additive: legacy callers omit them, and
   * non-external runs never emit those actions, so the defaults below are inert.
   */
  runId?: string;
  /** Absolute path to the consumer project root (the hook's cwd). */
  projectRoot?: string;
  /** Absolute path to the pipeline folder (`--root`). */
  pipelineRoot?: string;
  /**
   * Finalize opt-in resolved by the COMMAND (external only): true when a
   * `worktree-finalize.*` hook exists in the resolved hook dir OR `finalize: true`
   * frontmatter is set. Threaded in because hook-presence needs the project root
   * (the command's cwd), which the pure planner/engine does not have. Consumed
   * ONCE at init (persisted into state.finalize); undefined ⇒ fall back to
   * plan.finalize, so the pure-engine tests can opt in via frontmatter alone.
   */
  finalizeOptIn?: boolean;
  /**
   * OFF-PLAN step-model resolver, injected by the COMMAND (the engine is pure
   * and never touches the filesystem). Called when a `next_iteration` path is
   * not enumerated in the plan (synthesizeStep): given the iteration path it
   * returns the model the step would resolve to on its own — its `model:`
   * frontmatter, else its OWN enclosing PIPELINE.md default — or null when
   * neither exists / the file is unreadable. A per-run `--model` override for
   * the synthesized step's id still wins over this; state.default_model stays
   * the last fallback. Absent (pure-engine tests) ⇒ legacy behavior.
   */
  resolveOffPlanModel?: (path: string) => string | null;
  /**
   * OFF-PLAN step-effort resolver — the `effort:` companion to
   * resolveOffPlanModel (same injection seam, same precedence: a per-run
   * `--effort` override still wins; state.default_effort is the last
   * fallback). Absent (pure-engine tests) ⇒ off-plan steps inherit.
   */
  resolveOffPlanEffort?: (path: string) => string | null;
  /**
   * Script-failure agent fallback (§6.3 `on-failure: agent`), set ONLY by the
   * COMMAND layer after an in-process script execution of the CURRENT step
   * failed with that policy. The command calls computeNext with the
   * halt-shaped step record it got from executeScriptStep PLUS this opt.
   * Shape choice (T21 step 3): an OPTS FLAG, not a record kind — like
   * opts.resume it REDIRECTS how the engine treats the call instead of adding
   * outcome vocabulary, and the paired record keeps the halt path intact when
   * the flag is inert. In phase 'await-step' with the once-per-run §6.4 bound
   * unconsumed (state.fallback_attempted lacks the current step) and mode !==
   * 'parallel' (v1 parallel fallback degrades to halt, §6.4), the engine
   * DISCARDS the record, marks the bound consumed, and re-dispatches the SAME
   * step as an agent-type run-step carrying fallback:'script-failure' +
   * failure_record. Otherwise the flag is INERT and the halt-shaped record is
   * processed normally (⇒ the halt path).
   */
  scriptFallback?: {
    /** Absolute path of the persisted §6.2.1 failure-record JSON. */
    failure_record: string;
  };
}

export interface NextResult {
  action: NextAction;
  state: NextState;
}

// ---------------------------------------------------------------------------
// Path comparison (case-insensitive on Windows; matches event.ts/normcase)
// ---------------------------------------------------------------------------

/** Case-aware absolute-path equality. Exported so the command layer compares
 *  paths identically (one source — same pattern as pickMode below). */
export function samePath(a: string, b: string): boolean {
  const na = resolve(a);
  const nb = resolve(b);
  if (process.platform === 'win32') {
    return na.replace(/\//g, '\\').toLowerCase() === nb.replace(/\//g, '\\').toLowerCase();
  }
  return na === nb;
}

function findStepByPath(plan: Plan, path: string): PlanStep | undefined {
  return plan.steps.find((s) => samePath(s.path, path));
}

/** The run mode for a plan: graph wins over parallel, parallel over sequential.
 *  Exported so the `next` command labels its output identically (one source). */
export function pickMode(plan: Plan): RunMode {
  if (plan.graph) return 'graph';
  if (plan.mode === 'parallel') return 'parallel';
  return 'sequential';
}

/** Find a step by its step_id (the by-path companion to findStepByPath). */
function stepById(plan: Plan, id: string): PlanStep | undefined {
  return plan.steps.find((s) => s.step_id === id);
}

// ---------------------------------------------------------------------------
// External isolation (run-level worktree) helpers
// ---------------------------------------------------------------------------

/** External mode is run-level + SEQUENTIAL-only: parallel+external degraded to
 *  manual at plan time (plan.ts), so this is the single gate the whole
 *  provision/teardown machinery keys on. `mode !== 'parallel'` is belt-and-
 *  suspenders against a state where isolation somehow stayed 'external'. */
function isExternal(state: NextState): boolean {
  return state.isolation === 'external' && state.mode !== 'parallel';
}

/** Resolve the step to dispatch: explicit `--start`, else the persisted
 *  `current_path` (a resume), else the first plan step. Returns undefined only
 *  when the plan has no steps — callers handle that halt with their own reason.
 *  Single source of the selection ladder shared by initRun / resumeRun /
 *  onProvisionPhase. */
function selectStep(plan: Plan, state: NextState, opts: NextOpts): PlanStep | undefined {
  // An explicit --start / persisted current_path that is OFF-plan (a family
  // hub/target hand-off, an unusual nested path) is synthesized — NEVER silently
  // swapped for steps[0]: a target-rooted run resuming at a synthesized hub step
  // must re-enter THAT step, not restart at its first enumerated one.
  const lookup = (p: string): PlanStep =>
    findStepByPath(plan, p) ?? synthesizeStep(p, state, plan, opts);
  if (opts.start) return lookup(opts.start);
  if (state.current_path) return lookup(state.current_path);
  return plan.steps[0];
}

/** Pin `--start` onto `current_path` so a later onProvisionPhase dispatches it
 *  after the provisioned record (external mode pins before emitProvision; a
 *  crash-respawn `--start` thus wins over a stale current_path). An off-plan
 *  start pins its raw path (selectStep synthesizes it later). No-op without
 *  `--start`. */
function pinStartPath(plan: Plan, state: NextState, opts: NextOpts): void {
  if (!opts.start) return;
  state.current_path = findStepByPath(plan, opts.start)?.path ?? opts.start;
}

/** Emit `provision-worktree` and park in `await-provision`. Used by initRun (run
 *  start) and resumeRun (idempotent re-emit). The `pipeline next` command (or a
 *  --manual-hooks caller) runs the create hook with these env-var inputs and
 *  records {kind:'worktree', phase:'provisioned'}; onProvisionPhase then
 *  dispatches the first/resumed step. */
function emitProvision(plan: Plan, state: NextState, opts: NextOpts): NextResult {
  state.phase = 'await-provision';
  return {
    action: {
      action: 'provision-worktree',
      name: opts.runId ?? '',
      run_id: opts.runId ?? '',
      base_branch: plan.base_branch ?? 'main',
      submodules: plan.submodules ?? [],
      hook_dir: plan.worktree_hook_dir,
      project_root: opts.projectRoot ?? null,
      pipeline_root: opts.pipelineRoot ?? null,
    },
    state,
  };
}

/** Emit `teardown-worktree` and park in `await-teardown`. Inserted between the
 *  retro/terminal decision and terminalAction at BOTH terminal seams (§4.3). The
 *  `pipeline next` command (or a --manual-hooks caller) runs the destroy hook and
 *  records {kind:'worktree',phase:'torn-down'}, which advances to
 *  phase='terminal' + terminalAction. */
function emitTeardown(plan: Plan, state: NextState, opts: NextOpts): NextResult {
  state.phase = 'await-teardown';
  const outcome: 'completed' | 'halted' | 'depth-exhausted' =
    state.status === 'completed' ? 'completed' : state.status === 'depth-exhausted' ? 'depth-exhausted' : 'halted';
  return {
    action: {
      action: 'teardown-worktree',
      name: opts.runId ?? '',
      run_id: opts.runId ?? '',
      worktree_path: state.worktree_path,
      outcome,
      // Outcome-aware branch reaping: a COMPLETED (post-finalize) run's branch
      // is done — delete it with the worktree unless the pipeline opted out via
      // `delete_branches: false` frontmatter. halted/depth-exhausted ALWAYS
      // preserve the branch (debugging/resume evidence, not a leak).
      delete_branches: outcome === 'completed' && plan.delete_branches !== false,
      hook_dir: plan.worktree_hook_dir,
      project_root: opts.projectRoot ?? null,
      pipeline_root: opts.pipelineRoot ?? null,
    },
    state,
  };
}

/** Emit `finalize-worktree` and park in `await-finalize`. Inserted between the
 *  retro/terminal decision and teardown at BOTH terminal seams — but ONLY for a
 *  COMPLETED external run that opted in (shouldFinalize). The `pipeline next`
 *  command (or a --manual-hooks caller) runs the consumer's MANDATORY finalize
 *  hook and records {kind:'worktree',phase:'finalized',ok,detail}; onFinalizePhase
 *  then advances to teardown (ok) or halts + preserves the worktree (not ok).
 *  GENERIC: the plugin passes the worktree context and requires ok — it never
 *  knows or cares WHAT the hook does with the worktree. */
function emitFinalize(plan: Plan, state: NextState, opts: NextOpts): NextResult {
  state.phase = 'await-finalize';
  return {
    action: {
      action: 'finalize-worktree',
      name: opts.runId ?? '',
      run_id: opts.runId ?? '',
      worktree_path: state.worktree_path,
      outcome: 'completed', // shouldFinalize gates on status === 'completed'
      submodules: plan.submodules ?? [],
      base_branch: plan.base_branch ?? 'main',
      hook_dir: plan.worktree_hook_dir,
      project_root: opts.projectRoot ?? null,
      pipeline_root: opts.pipelineRoot ?? null,
    },
    state,
  };
}

/** await-provision handler: the create hook returned. Record its path/branch/env,
 *  flip worktree_provisioned=true, and dispatch the first (init) or resumed step.
 *  Step selection mirrors initRun/resumeRun: --start, else the resumed
 *  current_path, else the first plan step. */
function onProvisionPhase(plan: Plan, state: NextState, record: NextRecord | null, opts: NextOpts): NextResult {
  if (!record || record.kind !== 'worktree' || record.phase !== 'provisioned') {
    return wrongRecord(plan, state, opts, 'worktree/provisioned', 'await-provision', record);
  }
  // ok:false = the create hook FAILED. Halt before any step runs (fixes the
  // latent bug where a failed provision was recorded as success).
  // worktree_provisioned STAYS false so teardown never fires for a failed
  // provision — there is nothing to tear down.
  if (record.ok === false) {
    state.status = 'halted';
    state.halt_reason = 'worktree-create hook failed: ' + (record.detail ?? 'unknown');
    return retroOrTerminal(plan, state, opts);
  }
  state.worktree_provisioned = true;
  if (record.worktree_path != null) state.worktree_path = record.worktree_path;
  if (record.env_file != null) state.worktree_env_file = record.env_file;

  const step = selectStep(plan, state, opts);
  if (!step) {
    // No steps to run after a clean provision (shouldn't happen — initRun only
    // provisions when plan.steps.length > 0). Fall through to terminal; teardown
    // will fire because worktree_provisioned is now true.
    state.status = 'halted';
    state.halt_reason = 'external: provisioned but no iteration to run';
    return retroOrTerminal(plan, state, opts);
  }
  return dispatchStep(state, step);
}

/** await-teardown handler: the destroy hook returned. Flip to terminal and emit
 *  the real done/halt. Idempotent re-entry is the phase==='terminal' case in
 *  computeNext, which never re-emits teardown (fire-once guard, §4.3). */
function onTeardownPhase(state: NextState, record: NextRecord | null): NextResult {
  // A wrong/missing record here must NOT strand the run as non-terminal: a leaked
  // worktree is smaller than a hung run (§3.3). Proceed to terminal regardless.
  // But no longer SILENTLY drop the result — make it observable in state so a
  // leaked-worktree (teardown_ok === false) signal survives (§ robustness).
  if (record && record.kind === 'worktree' && record.phase === 'torn-down') {
    state.teardown_ok = record.ok ?? null;
    state.teardown_detail = record.detail ?? null;
  }
  state.phase = 'terminal';
  return terminalAction(state);
}

/** await-finalize handler: the MANDATORY finalize hook returned. UNLIKE
 *  onTeardownPhase, this INSPECTS record.ok — finalize is a must-succeed gate.
 *   - ok === true  → status stays 'completed'; fall through to teardown → done.
 *   - ok !== true (false, or a missing/wrong record we cannot confirm) →
 *     status = 'halted' + a clear halt_reason, so the run does NOT reach `done`.
 *     It then flows through the SAME terminal decision as any other halt: teardown
 *     runs with outcome === 'halted', and the consumer's outcome-aware destroy
 *     hook PRESERVES the worktree (its existing preserve-on-halt) so the
 *     finalize work is not reaped. No new preserve logic — the halt path already
 *     does the right thing. */
function onFinalizePhase(plan: Plan, state: NextState, record: NextRecord | null, opts: NextOpts): NextResult {
  const finalized = record != null && record.kind === 'worktree' && record.phase === 'finalized';
  if (finalized) {
    state.finalize_ok = record.ok ?? null;
    state.finalize_detail = record.detail ?? null;
  }
  if (!finalized) {
    // Cannot confirm the finalize succeeded → treat as failure (fail loud, never
    // silently proceed to teardown, which would reap the un-finalized worktree).
    state.status = 'halted';
    state.halt_reason = `finalize did not confirm success: expected a worktree/finalized record in phase await-finalize, got ${record ? record.kind : 'none'}`;
    state.finalize_ok = false;
  } else if (record.ok === false) {
    state.status = 'halted';
    state.halt_reason = 'worktree-finalize hook failed: ' + (record.detail ?? 'unknown');
  }
  // Success leaves status 'completed'; failure set it 'halted'. Either way take
  // the standard teardown-or-terminal decision (retro already ran, if any). The
  // resulting outcome flows to the destroy hook, which reaps (completed) or
  // preserves (halted) the worktree.
  if (shouldTeardown(state)) return emitTeardown(plan, state, opts);
  state.phase = 'terminal';
  return terminalAction(state);
}

// ---------------------------------------------------------------------------
// Engine entry point
// ---------------------------------------------------------------------------

/**
 * Compute the next orchestration action. `state` is null on the first call
 * (init); otherwise it is the persisted state and `record` is the outcome of the
 * action just performed. Mutates a working copy of `state` and returns it.
 */
export function computeNext(
  plan: Plan,
  state: NextState | null,
  record: NextRecord | null,
  opts: NextOpts,
): NextResult {
  if (state === null) return initRun(plan, opts);

  // Backward compat: an old next.json (pre lint_warnings) lacks the key —
  // normalize to [] so every downstream read is safe and legacy runs are
  // byte-identical (the empty list is omitted from the retrospective action).
  if (!Array.isArray(state.lint_warnings)) state.lint_warnings = [];
  // Backward compat, script-step state bits (same pattern): a pre-script-steps
  // next.json lacks all three keys — absent ⇒ default, so legacy in-flight
  // runs load fine and behave byte-identically (empty bounds, no partial layer).
  if (
    state.fallback_attempted == null ||
    typeof state.fallback_attempted !== 'object' ||
    Array.isArray(state.fallback_attempted)
  ) {
    state.fallback_attempted = {};
  }
  if (!Array.isArray(state.repaired_steps)) state.repaired_steps = [];
  if (state.partial_layer_results === undefined) state.partial_layer_results = null;
  if (state.pending_fallback === undefined) state.pending_fallback = null;
  if (state.active_child === undefined) state.active_child = null;
  // Backward compat, agent-step retries (A2 — same pattern as
  // fallback_attempted): a pre-retries next.json lacks the key — absent ⇒
  // empty map, so legacy in-flight runs load fine and behave byte-identically
  // (no step has ever been retried).
  if (
    state.agent_attempts == null ||
    typeof state.agent_attempts !== 'object' ||
    Array.isArray(state.agent_attempts)
  ) {
    state.agent_attempts = {};
  }

  // Resume / re-entry: re-run the parent step (sequential/graph) or re-dispatch
  // the in-flight layer (parallel). Used both after a nested blocker landed and
  // when the supervisor re-spawns a crashed/overflowed manager — in either case
  // the persisted state exists and we re-enter at `--start`. Graph route counters
  // are preserved so bounded-loop budgets carry across the re-entry.
  if (opts.resume && state.phase !== 'terminal') {
    return resumeRun(plan, state, opts);
  }

  switch (state.phase) {
    case 'await-provision': // external: the create hook returned → dispatch first/resumed step
      return onProvisionPhase(plan, state, record, opts);
    case 'await-step':
      return onStepPhase(plan, state, record, opts);
    case 'await-merge':
      return onMergePhase(plan, state, record, opts);
    case 'await-improver':
      return onImproverPhase(plan, state, record, opts);
    case 'await-script':
      return onScriptPhase(plan, state, record, opts);
    case 'await-finalize': // external: the mandatory finalize hook returned → teardown (ok) or halt+preserve (not ok)
      return onFinalizePhase(plan, state, record, opts);
    case 'await-teardown': // external: the destroy hook returned → emit the real done/halt
      return onTeardownPhase(state, record);
    case 'await-retro': // the retro can't fail; the {kind:'retro'} record just advances us
      // Post-retro: insert finalize (must-succeed), THEN teardown, between the
      // retro record and terminalAction (the second seam). If neither applies
      // fall through to terminalAction.
      if (shouldFinalize(state)) return emitFinalize(plan, state, opts);
      if (shouldTeardown(state)) return emitTeardown(plan, state, opts);
      return terminalAction(state);
    case 'terminal':
      return terminalAction(state);
    case 'blocked':
      return { action: { action: 'blocked' }, state };
    default:
      // Defensive: a corrupt next.json with an unknown phase — relay as blocked.
      return { action: { action: 'blocked' }, state };
  }
}

// ---------------------------------------------------------------------------
// Init / resume
// ---------------------------------------------------------------------------

function initRun(plan: Plan, opts: NextOpts): NextResult {
  const mode = pickMode(plan);
  const state: NextState = {
    mode,
    isolation: plan.isolation,
    default_model: plan.default_model,
    default_effort: plan.default_effort,
    phase: 'await-step',
    index: 0,
    current_step_id: null,
    current_path: null,
    route: emptyRouteState(),
    layer_index: 0,
    layer: [],
    improve_queue: [],
    scripts_total: 0,
    scripts_done: 0,
    improve_target: null,
    pending_next: null,
    pending_flags: null,
    status: null,
    halt_reason: null,
    worktree_provisioned: false,
    worktree_path: null,
    worktree_env_file: null,
    // Finalize opt-in resolved ONCE, here: the command's hook-presence result
    // (opts.finalizeOptIn) wins; absent it (pure-engine tests) fall back to the
    // frontmatter flag (plan.finalize). shouldFinalize additionally gates on
    // external isolation, so this is inert for non-external runs.
    finalize: opts.finalizeOptIn ?? plan.finalize,
    finalize_ok: null,
    finalize_detail: null,
    teardown_ok: null,
    teardown_detail: null,
    // Capture the plan's design-time lint findings ONCE, at init — persisted so
    // a resumed/re-spawned run still has them for the retrospective.
    lint_warnings: (plan.warnings ?? []).slice(),
    // Script-step state bits (§6.4 bounds + §9 partial layers) start empty.
    fallback_attempted: {},
    repaired_steps: [],
    partial_layer_results: null,
    pending_fallback: null,
    // Composition (T3-10): no child run in flight at init.
    active_child: null,
    // Agent-step retries (A2): no step has been retried yet.
    agent_attempts: {},
  };

  if (mode === 'parallel') {
    return dispatchLayer(plan, state, 0, opts);
  }

  // External (sequential): provision the run-level worktree BEFORE the first
  // step. The first step is dispatched only after the {worktree,provisioned}
  // record lands (onProvisionPhase). No steps yet ⇒ a plan-error/no-files halt
  // below keeps worktree_provisioned=false so teardown is correctly skipped.
  if (isExternal(state) && plan.steps.length > 0) {
    // Pin the start step NOW so onProvisionPhase dispatches it after the
    // provisioned record (the --start arrives only on this init call). Absent
    // --start, current_path stays null and onProvisionPhase falls to steps[0].
    pinStartPath(plan, state, opts);
    return emitProvision(plan, state, opts);
  }

  // Sequential / graph: start at --start (mapped to a step), else the first step.
  const step = selectStep(plan, state, opts);
  if (!step) {
    state.status = 'halted';
    state.halt_reason = 'no iteration files to run';
    return retroOrTerminal(plan, state, opts);
  }
  return dispatchStep(state, step);
}

function resumeRun(plan: Plan, state: NextState, opts: NextOpts): NextResult {
  // Crash during finalize: the run reached its terminal decision
  // (phase==='await-finalize', status still 'completed') but the finalize hook
  // hadn't confirmed. Re-run the IDEMPOTENT finalize hook — do NOT blank status
  // or re-provision/re-dispatch a step (the pipeline already completed). The
  // finalized record then advances to teardown (ok) or halt (not ok). Mirrors the
  // await-teardown resume; the finalize hook, like create/destroy, is idempotent.
  if (isExternal(state) && state.phase === 'await-finalize') {
    return emitFinalize(plan, state, opts);
  }
  // Crash during teardown: the run already reached its terminal DECISION
  // (phase==='await-teardown', status already set) but the destroy hook hadn't
  // confirmed. Re-run the idempotent teardown — do NOT blank status or
  // re-provision (§4.4 ordering). The torn-down record then advances to terminal.
  if (isExternal(state) && state.phase === 'await-teardown') {
    return emitTeardown(plan, state, opts);
  }
  state.status = null;
  state.halt_reason = null;
  if (state.mode === 'parallel') {
    // Re-dispatch the in-flight layer (the blocked step plus its layer-mates).
    return dispatchLayer(plan, state, state.layer_index, opts);
  }
  // External resume (§4.2 linchpin): a fresh-context re-spawned manager has no
  // worktree path, so RE-EMIT provision-worktree before re-dispatching the
  // resumed step — even when worktree_provisioned===true. The create hook is
  // idempotent (returns the EXISTING worktree, no second slot), and re-running
  // it is how the manager re-learns worktree_path/env_file. onProvisionPhase
  // then re-dispatches the resumed step. Never skip it; never allocate twice.
  if (isExternal(state)) {
    // Pin the resume target NOW (the --start arrives on this call, but the step
    // is dispatched later in onProvisionPhase after the provisioned record). A
    // crash-respawn --start must win over the stale current_path; otherwise the
    // existing current_path is preserved.
    pinStartPath(plan, state, opts);
    return emitProvision(plan, state, opts);
  }
  const step = selectStep(plan, state, opts);
  if (!step) {
    state.status = 'halted';
    state.halt_reason = 'resume: no iteration to re-enter';
    return retroOrTerminal(plan, state, opts);
  }
  // §8 crash re-entry for a pending SCRIPT dispatch: the command layer parks
  // the state ('await-step', index allocated) BEFORE every in-process spawn,
  // so a window killed between script success and state persistence leaves a
  // 'finished' ledger entry keyed by (step_id, THIS index). A --resume /
  // no-record re-entry (crashed manager, UI STOP, Bash-timeout kill — the §8
  // coverage list) must therefore re-emit the SAME dispatch index — the
  // idempotent-re-emit twin of the {"kind":"continue"} path — or the ledger
  // reuse could never fire and a side-effectful script would re-execute.
  // Agent steps keep the fresh-index bump: a resumed agent step is a genuinely
  // new spawn and has no ledger. (Parallel resume re-dispatches the layer via
  // dispatchLayer above; script members there rely on the mandated
  // idempotency — v1, mirrored by the §6.4 parallel degradations.)
  //
  // §6.3 crash re-entry for a pending AGENT-FALLBACK dispatch — checked BEFORE
  // the script re-emit below, because the PLAN step's type is 'script' either
  // way: only state.pending_fallback records that the dispatch in flight was
  // the agent fallback of the already-failed script. Keying on the plan type
  // alone would re-emit a SCRIPT dispatch, re-execute the failed side-effectful
  // script (no ledger at the fallback's bumped index), fail again with the
  // once-per-run §6.4 bound already consumed, and halt — the §6.3-promised
  // fallback would never run. Re-emit the SAME pending dispatch instead: the
  // agent-type fallback ActionStep at the CURRENT index (NO bump), via the
  // shared makeFallbackStep so the shape cannot drift from dispatchFallback.
  // The marker stays set — the dispatch is still pending (a second crash must
  // re-emit again); the eventual step record clears it in onStepPhase.
  if (
    state.phase === 'await-step' &&
    state.pending_fallback != null &&
    state.current_path != null &&
    samePath(step.path, state.current_path)
  ) {
    state.current_step_id = step.step_id;
    return {
      action: {
        action: 'run-step',
        concurrent: false,
        steps: [makeFallbackStep(state, step, state.index, state.pending_fallback.failure_record)],
      },
      state,
    };
  }
  if (
    state.phase === 'await-step' &&
    (step.type ?? 'agent') === 'script' &&
    state.current_path != null &&
    samePath(step.path, state.current_path)
  ) {
    state.current_step_id = step.step_id;
    return {
      action: { action: 'run-step', concurrent: false, steps: [makeActionStep(state, step, state.index, null)] },
      state,
    };
  }
  // A2 agent-step retries — crash twin (04 §retries.5), beside the
  // pending_fallback re-emit above: the dispatch in flight at crash time was
  // itself a RETRY attempt when state.agent_attempts already carries one for
  // this step AND current_path still points at it — set by
  // dispatchAgentRetry BEFORE the crash, the same way pending_fallback marks
  // an in-flight fallback dispatch. Re-emit the SAME pending dispatch — SAME
  // index (NO bump), mirroring the pending_fallback/script re-emits above —
  // tagged with the SAME attempt number it already carried, instead of
  // falling through to the generic dispatchStep fresh-spawn bump below
  // (which would silently drop the `retry: n` tag and desync the reported
  // attempt from state.agent_attempts). Agent-only: a fallback dispatch's
  // PLAN step is always 'script' (handled by the pending_fallback branch
  // above, mutually exclusive with this one), and a plain script step never
  // reaches here as 'agent' either.
  const pendingRetryAttempt = (state.agent_attempts ?? {})[step.step_id] ?? 0;
  if (
    state.phase === 'await-step' &&
    (step.type ?? 'agent') === 'agent' &&
    pendingRetryAttempt > 0 &&
    state.current_path != null &&
    samePath(step.path, state.current_path)
  ) {
    state.current_step_id = step.step_id;
    const actionStep = makeActionStep(state, step, state.index, null);
    actionStep.retry = pendingRetryAttempt;
    return { action: { action: 'run-step', concurrent: false, steps: [actionStep] }, state };
  }
  return dispatchStep(state, step);
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

/** Build one run-step ActionStep — the single construction point shared by
 *  every dispatch (fresh, layer, §7 continue re-emit, §6.3 fallback), so the
 *  `type` threading + external-worktree threading can never diverge. `index`
 *  is the caller-chosen dispatch index (see the ActionStep.index doc). */
function makeActionStep(
  state: NextState,
  step: PlanStep,
  index: number,
  isolation: 'worktree' | null,
): ActionStep {
  const actionStep: ActionStep = {
    step_id: step.step_id,
    path: step.path,
    // Always set; identical to `path` here — the command layer re-points an
    // agent step's `path` at its rendered shadow copy on variable-declaring
    // runs (P4/a5; see the field doc).
    source_path: step.path,
    model: step.model,
    effort: step.effort ?? null,
    isolation,
    index,
    // Threaded from the plan; synthesizeStep pins 'agent' for off-plan steps,
    // so the fallback covers only hand-built PlanStep objects in tests.
    type: step.type ?? 'agent',
  };
  // External mode (sequential-only, so never true for layer dispatches): thread
  // the three informational worktree fields so the step `cd`s into the
  // run-level worktree itself — without touching isolation.
  if (isExternal(state)) {
    actionStep.external_worktree = true;
    if (state.worktree_path != null) actionStep.worktree_path = state.worktree_path;
    if (state.worktree_env_file != null) actionStep.worktree_env_file = state.worktree_env_file;
  }
  return actionStep;
}

function dispatchStep(state: NextState, step: PlanStep): NextResult {
  state.index += 1;
  state.current_step_id = step.step_id;
  state.current_path = step.path;
  state.phase = 'await-step';
  // A fresh dispatch supersedes any §6.3 pending-fallback marker (it describes
  // only the dispatch it was set for — e.g. a post-fallback graph loop-back to
  // the same script step is a NEW script dispatch, never a fallback re-emit).
  state.pending_fallback = null;
  // …and any T3-10 stack link (a fresh dispatch means no child run pending).
  state.active_child = null;
  // Sequential steps run in-place: isolation:null is hardcoded (NEVER the native
  // 'worktree' option), exactly as before.
  const actionStep = makeActionStep(state, step, state.index, null);
  return {
    action: { action: 'run-step', concurrent: false, steps: [actionStep] },
    state,
  };
}

/** §6.3 fallback re-dispatch: the SAME step goes out again as an AGENT-type
 *  run-step (type FORCED to 'agent' — the executor achieves the iteration's
 *  Goal manually; the markdown body IS the fallback spec) carrying
 *  fallback:'script-failure' + the §6.2.1 failure-record path. A FRESH
 *  dispatch index is allocated: this is a new spawn (its own
 *  iteration.started), and the failed script execution keeps its own §8
 *  ledger slot. Model/effort: a script step carries null by §2.1 (meaningless
 *  on scripts — plan.ts skips the inheritance ladder), but the fallback IS an
 *  agent spawn, so it resolves the run default exactly like an un-pinned
 *  agent step would have. */
function dispatchFallback(state: NextState, step: PlanStep, failureRecord: string): NextResult {
  state.index += 1;
  state.current_step_id = step.step_id;
  state.current_path = step.path;
  state.phase = 'await-step';
  // Persist the pending-fallback marker: the dispatch now in flight is the
  // agent fallback, not a script run — the ONLY durable fact that lets a
  // crash-resume / §7 continue re-emit the SAME agent dispatch instead of
  // re-executing the already-failed script (see the NextState field doc).
  state.pending_fallback = { failure_record: failureRecord };
  state.active_child = null; // a fresh dispatch supersedes any T3-10 stack link
  return {
    action: { action: 'run-step', concurrent: false, steps: [makeFallbackStep(state, step, state.index, failureRecord)] },
    state,
  };
}

/** Build the §6.3 agent-fallback ActionStep — the single construction point
 *  shared by dispatchFallback (fresh dispatch) and the pending_fallback
 *  re-emits (crash-resume in resumeRun, §7 continue in redispatchPending), so
 *  the shape cannot drift between the sites. Type FORCED to 'agent' (the
 *  executor achieves the Goal manually; the markdown body IS the fallback
 *  spec). Model/effort: a script step carries null by §2.1, but the fallback
 *  IS an agent spawn, so it resolves the run default exactly like an
 *  un-pinned agent step would have. */
function makeFallbackStep(
  state: NextState,
  step: PlanStep,
  index: number,
  failureRecord: string,
): ActionStep {
  const actionStep = makeActionStep(state, step, index, null);
  actionStep.type = 'agent';
  actionStep.fallback = 'script-failure';
  actionStep.failure_record = failureRecord;
  actionStep.model = step.model ?? state.default_model;
  actionStep.effort = step.effort ?? state.default_effort ?? null;
  return actionStep;
}

/** A2 agent-step retries (04-runner-crash-resume.md §retries.3): re-dispatch
 *  the SAME agent step in a FRESH executor after a transient halt — a brand
 *  new spawn (bumped state.index, its own iteration.started, in drive a NEW
 *  pinned session), never a resume of the halted one. Consumes whatever
 *  pending dispatch the just-arrived halted record described (pending_fallback
 *  / active_child cleared — mirrors dispatchStep/dispatchFallback: a fresh
 *  dispatch supersedes any stale marker). `attempt` (1-based, already written
 *  to state.agent_attempts[step_id] by the caller) is tagged onto the
 *  ActionStep for the additive `retry: n` event annotation. */
function dispatchAgentRetry(state: NextState, step: PlanStep, attempt: number): NextResult {
  state.index += 1;
  state.current_step_id = step.step_id;
  state.current_path = step.path;
  state.phase = 'await-step';
  state.pending_fallback = null;
  state.active_child = null;
  const actionStep = makeActionStep(state, step, state.index, null);
  actionStep.retry = attempt;
  return {
    action: { action: 'run-step', concurrent: false, steps: [actionStep] },
    state,
  };
}

function dispatchLayer(plan: Plan, state: NextState, layerIndex: number, opts: NextOpts): NextResult {
  const layers = plan.layers ?? [];
  if (layerIndex >= layers.length) {
    state.status = 'completed';
    return retroOrTerminal(plan, state, opts);
  }
  const ids = layers[layerIndex];
  const useWorktree = state.isolation === 'worktree';
  const steps: ActionStep[] = [];
  for (const id of ids) {
    const s = stepById(plan, id);
    if (!s) continue;
    state.index += 1;
    steps.push(makeActionStep(state, s, state.index, useWorktree ? 'worktree' : null));
  }
  state.layer_index = layerIndex;
  state.layer = ids.slice();
  state.phase = 'await-step';
  // Defensive: pending_fallback is never SET in parallel mode (§6.4 degrades
  // the fallback to halt), but a fresh layer dispatch supersedes it regardless.
  state.pending_fallback = null;
  state.active_child = null;
  return { action: { action: 'run-step', concurrent: true, steps }, state };
}

/** §7 `continue` record handling: the command layer parked a pending dispatch
 *  because the next script execution did not fit the remaining call budget —
 *  state was persisted AFTER the dispatch (phase 'await-step', index/indices
 *  already allocated), the caller opened a fresh call window, and now asks for
 *  the SAME work again.
 *
 *  DESIGN CHOICE (T21 step 2): NO dedicated phase — we stay in 'await-step'
 *  and re-emit the pending dispatch IDEMPOTENTLY (same step(s), same dispatch
 *  index(es), counters/route budgets untouched). A separate 'await-continue'
 *  phase would have to duplicate every await-step transition (the eventual
 *  step/layer record must land somewhere) for zero benefit: the persisted
 *  state already describes the pending dispatch completely. The UNCHANGED
 *  index is load-bearing — the §8 attempt ledger keys on
 *  (step_id, dispatch_index), so the re-emitted dispatch must present the
 *  SAME index for a mid-flight 'started' entry (or a 'finished' reuse) to be
 *  detected in the new call window.
 *
 *  Parallel: the in-flight layer is re-emitted in FULL with its ORIGINAL
 *  per-member indices (dispatchLayer allocated consecutive values ending at
 *  state.index for the members it found in the plan — reconstructed here).
 *  state.partial_layer_results is left untouched: the command re-partitions
 *  on every pass, and already-executed script members reuse their 'finished'
 *  ledger entries at these same indices. */
function redispatchPending(plan: Plan, state: NextState, opts: NextOpts): NextResult {
  if (state.mode === 'parallel') {
    const found = state.layer
      .map((id) => stepById(plan, id))
      .filter((s): s is PlanStep => s !== undefined);
    const useWorktree = state.isolation === 'worktree';
    let idx = state.index - found.length;
    const steps = found.map((s) => makeActionStep(state, s, ++idx, useWorktree ? 'worktree' : null));
    state.phase = 'await-step';
    return { action: { action: 'run-step', concurrent: true, steps }, state };
  }
  if (!state.current_path) {
    // Defensive: await-step with no pending dispatch is a corrupt state.
    state.status = 'halted';
    state.halt_reason = 'continue record but no pending step (current_path is null)';
    return retroOrTerminal(plan, state, opts);
  }
  const step =
    findStepByPath(plan, state.current_path) ?? synthesizeStep(state.current_path, state, plan, opts);
  state.phase = 'await-step';
  // §6.3: if the pending dispatch is the AGENT FALLBACK of a failed script
  // step, "the same pending dispatch" means the fallback ActionStep — never a
  // fresh script dispatch off the plan type. (The command layer only parks
  // SCRIPT executions on the budget, so this is defense-in-depth; the marker
  // stays set — the dispatch is still pending.)
  if (state.pending_fallback != null) {
    return {
      action: {
        action: 'run-step',
        concurrent: false,
        steps: [makeFallbackStep(state, step, state.index, state.pending_fallback.failure_record)],
      },
      state,
    };
  }
  const actionStep = makeActionStep(state, step, state.index, null);
  // A2 agent-step retries: the "same pending dispatch" idiom applies to a
  // retry-in-flight too — carry the `retry: n` tag through so a `continue`
  // re-emit of a retry attempt (defense-in-depth; §7 continue targets script
  // call-budget hand-offs, but this path is generic over step type) does not
  // silently present as an untagged fresh dispatch.
  const pendingRetryAttempt = (state.agent_attempts ?? {})[step.step_id] ?? 0;
  if (pendingRetryAttempt > 0) actionStep.retry = pendingRetryAttempt;
  return {
    action: { action: 'run-step', concurrent: false, steps: [actionStep] },
    state,
  };
}

// ---------------------------------------------------------------------------
// Phase handlers
// ---------------------------------------------------------------------------

/** A phase handler got the wrong record kind — halt with a uniform reason. */
function wrongRecord(
  plan: Plan,
  state: NextState,
  opts: NextOpts,
  expected: string,
  phase: NextPhase,
  record: NextRecord | null,
): NextResult {
  state.status = 'halted';
  state.halt_reason = `expected a ${expected} record in phase ${phase}, got ${record ? record.kind : 'none'}`;
  // The halt supersedes whatever dispatch was pending — spend the §6.3 marker
  // and the T3-10 stack link.
  state.pending_fallback = null;
  state.active_child = null;
  return retroOrTerminal(plan, state, opts);
}

/** Reset the "current improver" cursor (between improve-queue items). */
function clearImproveCursor(state: NextState): void {
  state.improve_target = null;
  state.scripts_total = 0;
  state.scripts_done = 0;
}

/** A path not enumerated in the plan (a family target/hub hand-off or an
 *  unusual nested next_iteration). Build a synthetic PlanStep so it still flows
 *  through the single dispatchStep path — id derived from the filename stem
 *  (the same rule plan.ts uses). Model AND effort, highest → lowest: the run's
 *  `--model`/`--effort` override for that stem, the command-injected off-plan
 *  resolver (the step's own frontmatter, else its own enclosing PIPELINE.md
 *  default), the run default. */
function synthesizeStep(
  path: string,
  state: NextState,
  plan: Plan,
  opts: NextOpts,
): PlanStep {
  const stem = path.replace(/\\/g, '/').split('/').pop()?.replace(/\.md$/i, '') ?? path;
  const modelOverrides = plan.model_overrides ?? {};
  const model = Object.prototype.hasOwnProperty.call(modelOverrides, stem)
    ? modelOverrides[stem]
    : (opts.resolveOffPlanModel?.(path) ?? state.default_model);
  const effortOverrides = plan.effort_overrides ?? {};
  const effort = Object.prototype.hasOwnProperty.call(effortOverrides, stem)
    ? effortOverrides[stem]
    : (opts.resolveOffPlanEffort?.(path) ?? state.default_effort ?? null);
  // Off-plan steps are ALWAYS agent-type with no script spec: only enumerated
  // steps get a parsed `type: script` declaration (plan.ts), and a family
  // hub/target hand-off is executed as a normal agent iteration. (T11 flagged
  // this literal as type-incomplete once PlanStep gained the fields — fixed.)
  return {
    index: 0,
    path,
    rel: stem,
    step_id: stem,
    model,
    effort,
    depends_on: [],
    type: 'agent',
    script_spec: null,
    pipeline_spec: null,
    gate_spec: null,
    // Off-plan steps carry no frontmatter read here (unlike model/effort,
    // which resolve through the injected off-plan resolvers) — no retry
    // budget, matching the pre-A2 halt-on-failure behavior (out of the v1
    // scope: bounded retries apply to enumerated PlanSteps only).
    retries: 0,
  };
}

function onStepPhase(plan: Plan, state: NextState, record: NextRecord | null, opts: NextOpts): NextResult {
  // §7: a fresh call window after a command-layer {action:'continue'} —
  // idempotently re-emit the pending dispatch (see redispatchPending).
  if (record && record.kind === 'continue') return redispatchPending(plan, state, opts);
  // §6.3 `on-failure: agent`: the command layer executed the CURRENT script
  // step in-process, it failed, and the policy asks for the agent fallback.
  // The command passes the halt-shaped record PLUS opts.scriptFallback; when
  // the once-per-run §6.4 bound is still available (and we are not in a
  // parallel layer — v1 degrades that to halt), the record is DISCARDED and
  // the same step is re-dispatched as an agent-type fallback. Otherwise the
  // flag is inert and the record takes the normal (halt) path below.
  if (
    opts.scriptFallback &&
    state.mode !== 'parallel' &&
    state.current_step_id !== null &&
    state.current_path !== null &&
    (state.fallback_attempted ?? {})[state.current_step_id] !== true
  ) {
    (state.fallback_attempted ??= {})[state.current_step_id] = true;
    const step =
      findStepByPath(plan, state.current_path) ?? synthesizeStep(state.current_path, state, plan, opts);
    return dispatchFallback(state, step, opts.scriptFallback.failure_record);
  }
  // A2 agent-step retries (04-runner-crash-resume.md §retries), sibling of
  // the scriptFallback block above: a transiently-halted AGENT step
  // re-dispatches in a fresh executor instead of halting the run, bounded by
  // its `retries:` frontmatter (plan.ts PlanStep.retries, default 0 = zero
  // behavior change for every pipeline without the key). Gated on
  // `record.outcome === 'halted'` only — blocked-delegating and
  // depth-exhausted are NEVER retried (this branch structurally never
  // matches either). Placed strictly BEFORE the halted fold below: an
  // eligible retry returns here and never sets state.status='halted' / never
  // reaches retroOrTerminal, so the intermediate halted record never feeds
  // graph route counters/flags (§retries.4) — those are touched only by
  // advance()'s routeNext call on a COMPLETED outcome, so the route sees
  // only the FINAL outcome once the retry budget is exhausted or the step
  // succeeds. `state.mode !== 'parallel'` excludes concurrent-layer members
  // explicitly (defense-in-depth: their results arrive as a single
  // {kind:'layer'} record via onLayerRecord below in the normal case, never
  // reaching here at all).
  if (
    record &&
    record.kind === 'step' &&
    record.outcome === 'halted' &&
    state.mode !== 'parallel' &&
    state.current_step_id !== null &&
    state.current_path !== null
  ) {
    const step =
      findStepByPath(plan, state.current_path) ?? synthesizeStep(state.current_path, state, plan, opts);
    const budget = step.retries ?? 0;
    const attempts = (state.agent_attempts ?? {})[state.current_step_id] ?? 0;
    if (budget > 0 && attempts < budget) {
      (state.agent_attempts ??= {})[state.current_step_id] = attempts + 1;
      return dispatchAgentRetry(state, step, attempts + 1);
    }
  }
  if (record && record.kind === 'layer') return onLayerRecord(plan, state, record, opts);
  if (!record || record.kind !== 'step') return wrongRecord(plan, state, opts, 'step/layer', 'await-step', record);
  // The arriving step record CONSUMES the pending dispatch — the §6.3
  // pending-fallback marker (if the dispatch was the agent fallback) is spent
  // with it, on every outcome branch below (blocked/halted/completed alike).
  // The T3-10 stack link is spent with it too: the pop record synthesized
  // from a finished child run arrives exactly here, and clearing the link in
  // the same engine call (⇒ the same state save) closes the crash window a
  // separate clear-then-feed sequence would open.
  state.pending_fallback = null;
  state.active_child = null;
  const r = record;
  if (r.outcome === 'blocked-delegating') {
    state.status = 'blocked-delegating';
    state.phase = 'blocked';
    return { action: { action: 'blocked' }, state };
  }
  if (r.outcome === 'halted') {
    state.status = 'halted';
    state.halt_reason = r.halt_reason ?? 'step halted';
    return retroOrTerminal(plan, state, opts);
  }
  if (r.outcome === 'depth-exhausted') {
    state.status = 'depth-exhausted';
    state.halt_reason = r.halt_reason ?? 'Agent tool unavailable (depth ceiling)';
    return retroOrTerminal(plan, state, opts);
  }
  // completed
  if (r.has_improvement_brief && state.current_step_id && state.current_path) {
    state.improve_queue.push({ step_id: state.current_step_id, iteration_path: state.current_path });
  }
  // Stash the advancement decision; it's consumed once the improve queue drains.
  state.pending_next = r.next_iteration ?? null;
  state.pending_flags = r.flags ?? null;
  return processImproveQueue(plan, state, opts);
}

function onLayerRecord(plan: Plan, state: NextState, record: LayerRecord, opts: NextOpts): NextResult {
  // §9 partial-layer fold: SCRIPT members of this layer were executed
  // in-process by the command layer BEFORE the caller ever saw the (agent-only)
  // run-step action; their results were parked in state.partial_layer_results.
  // Fold parked + recorded results — an all-script layer arrives as a complete
  // {kind:'layer'} record from the command itself (parked results + an empty
  // results array), so no action ever escaped to the caller. Parked results
  // come FIRST: a duplicated step_id (should not happen) resolves via find()
  // to the in-process result. The pen is cleared unconditionally — folded
  // results flow through the SAME halt/merge/improve/advance logic as a
  // purely-recorded layer.
  const parked = state.partial_layer_results ?? [];
  const results = [...parked, ...(record.results ?? [])];
  state.partial_layer_results = null;
  if (results.some((x) => x.outcome === 'blocked-delegating')) {
    state.status = 'blocked-delegating';
    state.phase = 'blocked';
    return { action: { action: 'blocked' }, state };
  }
  const bad = results.find((x) => x.outcome === 'halted' || x.outcome === 'depth-exhausted');
  if (bad) {
    state.status = bad.outcome === 'depth-exhausted' ? 'depth-exhausted' : 'halted';
    state.halt_reason = bad.halt_reason ?? `step ${bad.step_id} ${bad.outcome}`;
    return retroOrTerminal(plan, state, opts);
  }
  // All completed. Build the improve queue (preserve layer order).
  state.improve_queue = [];
  for (const id of state.layer) {
    const res = results.find((x) => x.step_id === id);
    if (res?.has_improvement_brief) {
      const s = stepById(plan, id);
      if (s) state.improve_queue.push({ step_id: id, iteration_path: s.path });
    }
  }
  // Worktree mode: merge committed branches first; manual mode skips merge.
  if (state.isolation === 'worktree') {
    const branches: MergeBranch[] = [];
    for (const id of state.layer) {
      const res = results.find((x) => x.step_id === id);
      if (res?.worktree_branch) {
        const s = stepById(plan, id);
        branches.push({ step_id: id, branch: res.worktree_branch, path: res.worktree_path ?? (s?.path ?? '') });
      }
    }
    if (branches.length) {
      state.phase = 'await-merge';
      return { action: { action: 'merge', branches }, state };
    }
  }
  return processImproveQueue(plan, state, opts);
}

function onMergePhase(plan: Plan, state: NextState, record: NextRecord | null, opts: NextOpts): NextResult {
  if (!record || record.kind !== 'merge') return wrongRecord(plan, state, opts, 'merge', 'await-merge', record);
  if (record.conflict) {
    state.status = 'halted';
    state.halt_reason = `merge conflict: ${record.detail ?? 'parallel steps overlapped (designer error)'}`;
    return retroOrTerminal(plan, state, opts);
  }
  return processImproveQueue(plan, state, opts);
}

function onImproverPhase(plan: Plan, state: NextState, record: NextRecord | null, opts: NextOpts): NextResult {
  if (!record || record.kind !== 'improver') return wrongRecord(plan, state, opts, 'improver', 'await-improver', record);
  const n = Number.isInteger(record.script_briefs) ? (record.script_briefs as number) : 0;
  if (n > 0) {
    state.scripts_total = n;
    state.scripts_done = 0;
    state.phase = 'await-script';
    return {
      action: { action: 'run-script-creator', iteration_path: state.improve_target ?? '', number: 1, of: n },
      state,
    };
  }
  // No scripts → this improve item is done; move on.
  clearImproveCursor(state);
  return processImproveQueue(plan, state, opts);
}

function onScriptPhase(plan: Plan, state: NextState, record: NextRecord | null, opts: NextOpts): NextResult {
  if (!record || record.kind !== 'script') return wrongRecord(plan, state, opts, 'script', 'await-script', record);
  state.scripts_done += 1;
  if (state.scripts_done < state.scripts_total) {
    return {
      action: {
        action: 'run-script-creator',
        iteration_path: state.improve_target ?? '',
        number: state.scripts_done + 1,
        of: state.scripts_total,
      },
      state,
    };
  }
  // All scripts for this improve item done.
  clearImproveCursor(state);
  return processImproveQueue(plan, state, opts);
}

// ---------------------------------------------------------------------------
// Improve queue + advancement
// ---------------------------------------------------------------------------

function processImproveQueue(plan: Plan, state: NextState, opts: NextOpts): NextResult {
  const item = state.improve_queue.shift();
  if (item) {
    clearImproveCursor(state);
    state.improve_target = item.iteration_path;
    state.phase = 'await-improver';
    return { action: { action: 'run-improver', iteration_path: item.iteration_path }, state };
  }
  return advance(plan, state, opts);
}

function advance(plan: Plan, state: NextState, opts: NextOpts): NextResult {
  if (state.mode === 'parallel') {
    return dispatchLayer(plan, state, state.layer_index + 1, opts);
  }

  if (state.mode === 'graph' && plan.graph) {
    const from = state.current_step_id ?? '';
    const flags = state.pending_flags ?? {};
    state.pending_flags = null;
    const decision = routeNext(plan.graph, from, flags, state.route);
    if (decision.action === 'done') {
      state.status = 'completed';
      return retroOrTerminal(plan, state, opts);
    }
    if (decision.action === 'halt') {
      state.status = 'halted';
      state.halt_reason = decision.reason;
      return retroOrTerminal(plan, state, opts);
    }
    const step = stepById(plan, decision.target);
    if (!step) {
      state.status = 'halted';
      state.halt_reason = `graph routed to '${decision.target}' but no step has that step_id`;
      return retroOrTerminal(plan, state, opts);
    }
    return dispatchStep(state, step);
  }

  // Sequential (legacy): advance off the recorded next_iteration hint.
  const next = state.pending_next;
  state.pending_next = null;
  if (!next || next === 'PIPELINE_COMPLETE') {
    state.status = 'completed';
    return retroOrTerminal(plan, state, opts);
  }
  // A planned path resolves to its PlanStep; an off-plan path (an unusual nested
  // next_iteration) gets a synthetic one — either way through the single dispatch.
  const step = findStepByPath(plan, next) ?? synthesizeStep(next, state, plan, opts);
  return dispatchStep(state, step);
}

// ---------------------------------------------------------------------------
// Terminal / retrospective gate
// ---------------------------------------------------------------------------

/** Whether an external run-level worktree must be torn down at this terminal.
 *  TRUE iff external mode actually provisioned a worktree AND the run is ending on
 *  a real terminal outcome (completed/halted/depth-exhausted). NEVER on
 *  blocked-delegating (structurally unreachable here — it short-circuits in
 *  onStepPhase before retroOrTerminal — but gated explicitly for safety), and
 *  NEVER when nothing was provisioned (plan-error/no-files halt keeps
 *  worktree_provisioned=false → no teardown). §4.3 / §4.4. */
function shouldTeardown(state: NextState): boolean {
  return (
    isExternal(state) &&
    state.worktree_provisioned === true &&
    (state.status === 'completed' || state.status === 'halted' || state.status === 'depth-exhausted')
  );
}

/** Whether the mandatory finalize stage must run at this terminal seam. TRUE iff
 *  an external run provisioned a worktree, opted into finalize, AND is ending on
 *  a CLEAN `completed` outcome. Deliberately NOT run on halted/depth-exhausted (a
 *  run that is ALREADY halting is not asked to finalize — there is nothing to
 *  finalize) nor on blocked-delegating. Wired into BOTH terminal seams
 *  (retroOrTerminal + the await-retro case) BEFORE shouldTeardown, so the order
 *  is: last step → [retro] → finalize (must succeed) → teardown → done. */
function shouldFinalize(state: NextState): boolean {
  return (
    isExternal(state) &&
    state.worktree_provisioned === true &&
    state.status === 'completed' &&
    state.finalize === true
  );
}

/**
 * Command-layer seam (mid-run plan errors): force-halt a PERSISTED,
 * NON-TERMINAL run with `reason`, routing through the SAME terminal decision as
 * an engine halt — so an external run that provisioned a worktree still emits
 * `teardown-worktree` (shouldTeardown) instead of leaking it, and the state
 * parks TERMINAL with the halt reason. Deliberately SKIPS the retrospective
 * seam: a broken plan preempts record consumption in the command on every
 * subsequent call, so parking in await-retro could never advance (finalize
 * never applies either — status is 'halted', never 'completed').
 */
export function haltRun(plan: Plan, state: NextState, reason: string, opts: NextOpts): NextResult {
  if (!Array.isArray(state.lint_warnings)) state.lint_warnings = [];
  state.status = 'halted';
  state.halt_reason = reason;
  // The force-halt supersedes any pending dispatch — spend the §6.3 marker
  // and the T3-10 stack link.
  state.pending_fallback = null;
  state.active_child = null;
  if (shouldTeardown(state)) return emitTeardown(plan, state, opts);
  state.phase = 'terminal';
  return terminalAction(state);
}

function retroOrTerminal(plan: Plan, state: NextState, opts: NextOpts): NextResult {
  // The retrospective runs once, at the very end, on completed/halted/
  // depth-exhausted (NOT blocked-delegating), and only when feedback exists.
  const eligible =
    state.status === 'completed' || state.status === 'halted' || state.status === 'depth-exhausted';
  if (eligible && (opts.feedbackCount ?? 0) > 0) {
    state.phase = 'await-retro';
    // Thread the design-time lint findings onto the retrospective so its
    // improver pass can compact bloated files. Key OMITTED when empty — a
    // lint-clean pipeline's action stays byte-identical.
    const retro: Extract<NextAction, { action: 'retrospective' }> = { action: 'retrospective' };
    if (state.lint_warnings.length > 0) retro.lint_warnings = state.lint_warnings;
    return { action: retro, state };
  }
  // No-feedback seam (§4.3): insert the mandatory finalize stage FIRST (only on a
  // completed, opted-in external run), THEN teardown, between the terminal
  // decision and terminalAction. The {worktree,finalized} record advances to
  // teardown (ok) or halt (not ok); the {worktree,torn-down} record advances to
  // phase='terminal' + done/halt.
  if (shouldFinalize(state)) return emitFinalize(plan, state, opts);
  if (shouldTeardown(state)) return emitTeardown(plan, state, opts);
  state.phase = 'terminal';
  return terminalAction(state);
}

function terminalAction(state: NextState): NextResult {
  state.phase = 'terminal';
  if (state.status === 'completed') {
    return { action: { action: 'done' }, state };
  }
  if (state.status === 'blocked-delegating') {
    return { action: { action: 'blocked' }, state };
  }
  const status = state.status === 'depth-exhausted' ? 'depth-exhausted' : 'halted';
  return { action: { action: 'halt', reason: state.halt_reason ?? 'halted', status }, state };
}
