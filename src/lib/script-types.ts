// Frozen contracts for `type: script` pipeline steps — SINGLE SOURCE for the
// types and constants every script-step module imports (plan parsing in
// lib/plan.ts, execution in lib/script-step.ts, engine threading in
// lib/next.ts, in-process dispatch in commands/next.ts).
//
// The shapes below are FROZEN by roadmap/script-steps/DESIGN.md §14 — same
// names, same values, same defaults. If implementation must deviate, update
// DESIGN.md first; never let this file and the spec drift silently.

/** Step kind. Absent `type:` frontmatter ⇒ 'agent' (absolute backward compat).
 *  'pipeline' (T3-09 composition) references another pipeline to run as a
 *  nested child — plan/format only until T3-10 lands execution; its spec shape
 *  lives in lib/compose.ts (PipelineStepSpec), not here. 'gate' (T3-14
 *  approval gates) is a deterministic pause that emits a needs_input question
 *  carrying an `approval:{required_role}` marker and blocks on the decision;
 *  its spec shape lives in lib/gate.ts (GateStepSpec). */
export type StepType = 'agent' | 'script' | 'pipeline' | 'gate';

/** Mechanical failure classification (DESIGN.md §6.1). 'transient' (network
 *  blip, timeout — incl. the CLI-enforced one), 'binding' (param resolution or
 *  validation failed BEFORE spawn), 'env' (interpreter ENOENT or self-reported
 *  env), 'crash' (exit ≠ 0 with no valid JSON), 'contract' (invalid/oversized
 *  stdout JSON or `## Output` violation), 'bug' (ok:false with class 'bug' or
 *  no class). */
export type FailureClass = 'transient' | 'binding' | 'env' | 'crash' | 'contract' | 'bug';

/** What to do when a script step fails after the mechanical ladder (§6.3):
 *  'halt' (default — right for mutating steps) or 'agent' (re-dispatch the
 *  same step as an agent-type run-step fallback, once per step per run). */
export type OnFailurePolicy = 'halt' | 'agent';

/** One entry of a `## Params` (or `## Output`) JSON block — a deliberate
 *  SUBSET of JSON Schema vocabulary (§3.1) so a later migration to full
 *  schema needs no renames. Value resolution precedence: from → value →
 *  default. */
export interface ScriptParamSpec {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  enum?: (string | number)[];
  required?: boolean;
  default?: unknown;
  description?: string;
  value?: unknown;   // static literal (mutually exclusive with `from`)
  from?: string;     // binding template, e.g. "${steps.build.output.sha}"
}

/** Parsed script-step declaration attached to a PlanStep (frontmatter §2.1 +
 *  the `## Params`/`## Output` blocks §3). Exactly one of script/command is
 *  non-null on a valid plan. */
export interface ScriptStepSpec {
  script: string | null;      // pipeline-root-relative path (xor command)
  command: string[] | null;   // whitespace-split argv template
  timeoutS: number;           // default DEFAULT_SCRIPT_TIMEOUT_S
  retries: number;            // default 0, transient-only
  onFailure: OnFailurePolicy; // default 'halt'
  params: Record<string, ScriptParamSpec> | null;
  output: Record<string, ScriptParamSpec> | null;  // ## Output declaration
}

/** What a script prints as its last JSON-object stdout line (§4). `ok` is
 *  REQUIRED; everything else optional. `error` is only meaningful with
 *  ok:false (self-classification; absent class ⇒ 'bug'). Load-bearing
 *  designer rule: ok:false means "the step could not do its job", NEVER "the
 *  domain answer is no" — domain outcomes are ok:true + flags. */
export interface ScriptResult {
  ok: boolean;
  summary?: string | null;
  flags?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  error?: { class?: 'transient' | 'env' | 'bug'; detail?: string | null } | null;
}

/** Failure record written to <run>/failures/<step_id>-<dispatch_index>-<attempt>.json (§6.2);
 *  events carry only the ~2 KB tails — full stdout/stderr land in a sibling
 *  .log on disk (token discipline). */
export interface ScriptFailureRecord {
  step_id: string; attempt: number; dispatch_index: number;
  class: FailureClass; exit_code: number | null; timed_out: boolean;
  stderr_tail: string; stdout_tail: string;
  params_file: string | null; duration_s: number; detail: string;
}

/** Attempt-ledger entry (<run>/ledger/<step_id>-<dispatch_index>.json, §8) —
 *  double-execution protection for side-effectful scripts. 'finished' ⇒ reuse
 *  the stored record/output on re-dispatch; 'started' ⇒ the previous attempt
 *  died mid-flight ⇒ re-execute. Keyed by (step_id, dispatch_index) so a
 *  graph loop-back is a NEW execution, never a stale reuse. */
export interface LedgerEntry {
  step_id: string; dispatch_index: number;
  phase: 'started' | 'finished';
  output?: Record<string, unknown> | null;
  record?: unknown | null;   // the synthesized StepRecord on 'finished'
}

/** Default per-script timeout (seconds) when frontmatter omits `timeout:`. */
export const DEFAULT_SCRIPT_TIMEOUT_S = 600;
/** Soft per-`pipeline next` call budget (ms) in manager mode — the outer Bash
 *  call is capped at 10 min; 8 min leaves room to persist records/state (§7). */
export const CALL_BUDGET_MS = 480_000;
/** Margin (ms) subtracted from the remaining call budget when computing a
 *  script's effective deadline — the CLI must kill + record BEFORE the outer
 *  Bash ceiling. */
export const SAFETY_MARGIN_MS = 45_000;
/** A single script timeout above this (seconds) on a `runner: manager`
 *  pipeline ⇒ plan WARNING ("use runner: headless or split"). */
export const MANAGER_SAFE_TIMEOUT_S = 420;
/** Hard cap on in-process script executions within one `pipeline next` call
 *  (runaway-loop guard for all-script chains). */
export const MAX_SCRIPT_EXECS_PER_CALL = 200;
/** Captured-stdout cap (bytes); beyond it ⇒ failure class 'contract' (§4). */
export const STDOUT_CAP_BYTES = 10 * 1024 * 1024;
/** Outputs-store persist cap (bytes) per step `output` object (§10) — an
 *  oversized output logs a warning and is NOT persisted. */
export const OUTPUT_PERSIST_CAP_BYTES = 64 * 1024;
/** Secret-looking ${env.NAME} bindings get a plan WARNING (§3.3, §11). */
export const SECRET_ENV_PATTERN = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i;

/** §3.2 `${steps…}` reference shape rule — SINGLE source for the check + the
 *  error message shared by the plan lint (lib/plan.ts stepRefs) and runtime
 *  binding resolution (lib/script-step.ts resolveRef), so a shape resolveRef
 *  hard-fails as 'invalid' is exactly the shape the plan ERRORs on, with the
 *  SAME wording. Takes the inner reference text (e.g. "steps.build.output.sha");
 *  returns the error message when the tokens fail the ≥4-tokens /
 *  'output'-third-token rule, else null. */
export function stepsRefShapeError(refInner: string): string | null {
  const tokens = refInner.split('.');
  if (tokens.length < 4 || tokens[2] !== 'output') {
    return `malformed reference \${${refInner}} — expected \${steps.<step_id>.output.<path>}`;
  }
  return null;
}

/** Normalize one `## Next` line to its payload: trim, strip one leading bullet
 *  (`- ` / `* `), unwrap one pair of surrounding backticks, trim. SINGLE source
 *  for the `## Next` line grammar shared by the runtime parser
 *  (lib/script-step.ts parseNextSection) and the §2.2 plan lint (lib/plan.ts) —
 *  what the lint accepts is exactly what the runtime can parse. Policy stays
 *  local to each caller (the lint keeps its `.md`-suffix + exact
 *  `Pipeline complete.` rules; the runtime keeps its lenient forms). */
export function normalizeNextLine(line: string): string {
  let s = line.trim();
  s = s.replace(/^[-*]\s+/, '').trim();
  if (/^`.*`$/.test(s)) s = s.slice(1, -1).trim();
  return s;
}
