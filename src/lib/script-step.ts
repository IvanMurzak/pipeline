// `type: script` step execution core — roadmap/script-steps/DESIGN.md §§3–8.
//
// This module executes ONE script step end-to-end: resolve `## Params`
// bindings → validate → spawn (via the hook-runner.ts supervisor, same
// tree-kill machinery as worktree hooks) → parse stdout → classify failures →
// write failure records + the attempt ledger → synthesize the engine-shaped
// step record. It knows NOTHING about the engine loop: the command layer
// (T31) computes the effective deadline (§7), persists the outputs store
// (§10), writes the returned feedback draft into `.feedback/<run_id>/`
// (§6.2.2), and applies the on-failure policy ladder (§6.3) — this module
// only performs the mechanical `retries:` loop for class 'transient'.
//
// Import discipline (acceptance criterion): only script-types.ts, hooks.ts
// (read-only import) and node builtins — NEVER next.ts / plan.ts / commands/*,
// so T31 (invokeNext) and T33 (`pipeline step run`) can both reuse it without
// cycles.
//
// Documented interpretations of DESIGN.md gaps (flagged in the T12 report):
//   - Bindings are validated STRICTLY, no type coercion: `${env.X}` is always
//     a string, so a `type: "number"` param bound to an env var is a
//     'binding' failure ("keeps the referenced JSON type", §3.2).
//   - A `from` that resolves to null/undefined (e.g. `${run.task}` with no
//     task.md, an unset env var, a missing upstream output field) is treated
//     as UNRESOLVED and falls down the from → value → default ladder; a
//     MALFORMED reference (unknown root, bad `${steps…}` shape) is a hard
//     'binding' failure even when a default exists (it is a wiring bug).
//   - §6.2.2 assigns feedback categories to every class except 'transient';
//     an exhausted-retries transient failure maps to 'friction' (HUMAN-ONLY —
//     nothing for the improver to heal in the script or the docs).
//   - `ctx.deadlineMs` is the wall-clock budget for the WHOLE execution
//     (all attempts); each attempt runs with
//     min(spec.timeoutS, remaining deadline) and retries stop early when the
//     budget is gone — the CLI must kill + record before the outer ceiling.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { interpreterFor, spawnViaHookRunner, tail } from './hooks';
import {
  normalizeNextLine,
  OUTPUT_PERSIST_CAP_BYTES,
  STDOUT_CAP_BYTES,
  stepsRefShapeError,
} from './script-types';
import type {
  FailureClass,
  LedgerEntry,
  ScriptFailureRecord,
  ScriptParamSpec,
  ScriptResult,
  ScriptStepSpec,
} from './script-types';

// ---------------------------------------------------------------------------
// Process seam (mirrors the GitRunner style in lib/git.ts)
// ---------------------------------------------------------------------------

export interface ProcessRunOptions {
  /** Env OVERLAY — the real runner merges it over process.env (scripts
   *  inherit the full environment per §11; secrets never travel via params). */
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
}

export interface ProcessRunResult {
  /** Exit code; null when the process never exited cleanly (spawn error,
   *  timeout kill). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the run was killed by the CLI-enforced timeout (⇒ transient). */
  timedOut: boolean;
  /** Spawn-level error (interpreter not found, …); absent otherwise. */
  error?: string;
}

/** Injectable spawn seam. Production uses realProcessRunner (the hook-runner
 *  supervisor — process-tree kill on timeout); tests inject fakes. */
export type ProcessRunner = (argv: string[], opts: ProcessRunOptions) => ProcessRunResult;

/** Merge the env OVERLAY over a base environment for a child process.
 *  On win32 env-var names are case-INSENSITIVE, but a JS spread merges by
 *  exact-case key — an overlay 'PATH' would coexist with a base 'Path',
 *  leaving duplicate case-variant keys whose override wins unreliably. So on
 *  win32 any base key that case-insensitively equals an overlay key (under a
 *  DIFFERENT exact spelling) is dropped before the merge. POSIX (case-
 *  sensitive) is a plain spread. Exported for tests only. */
export function mergeChildEnv(
  base: NodeJS.ProcessEnv,
  overlay: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  if (platform === 'win32') {
    const overlayLower = new Set(Object.keys(overlay).map((k) => k.toLowerCase()));
    for (const key of Object.keys(merged)) {
      if (overlayLower.has(key.toLowerCase()) && !Object.prototype.hasOwnProperty.call(overlay, key)) {
        delete merged[key];
      }
    }
  }
  return Object.assign(merged, overlay);
}

/** Real spawn: argv through the hook-runner supervisor (sync, never throws) —
 *  lib/hooks.ts spawnViaHookRunner, the SAME tree-kill machinery worktree
 *  hooks run through (DESIGN.md §4: "executed via the existing HOOK_RUNNER
 *  wrapper"), used directly (read-only reuse) because runHook() is bound to a
 *  script path + interpreterFor, while script steps also need raw `command:`
 *  argv execution. Only the env merge is script-specific: mergeChildEnv's
 *  win32 case-dedup (above) instead of runHook's plain spread. */
export const realProcessRunner: ProcessRunner = (argv, opts) =>
  spawnViaHookRunner(argv, {
    cwd: opts.cwd,
    env: mergeChildEnv(process.env, opts.env),
    timeoutMs: opts.timeoutMs,
    supervisorLabel: 'script supervisor',
  });

// ---------------------------------------------------------------------------
// Public context / result shapes
// ---------------------------------------------------------------------------

/** Binding-resolution sources — the subset of the execution context that
 *  `${…}` references read from (§3.2). Split out so `pipeline step run` (T33)
 *  can resolve params without a full execution context. */
export interface BindingSources {
  runId: string;
  pipelineRoot: string;
  projectRoot: string;
  /** External isolation only; null/absent otherwise. */
  worktreePath?: string | null;
  worktreeEnvFile?: string | null;
  /** Contents of the drive task.md when present (`${run.task}`), else null. */
  taskText?: string | null;
  /** Outputs-store reader for `${steps.<id>.output.<path>}` (§10; T31 wires
   *  the real store, tests/step-run wire closures). Null ⇒ no persisted
   *  output for that step. */
  readOutput: (stepId: string) => Record<string, unknown> | null;
  /** `${env.NAME}` source; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export interface ScriptStepContext extends BindingSources {
  stepId: string;
  /** Dispatch index of this execution — the ledger key half that makes a
   *  graph loop-back a NEW execution, never a stale reuse (§8). */
  dispatchIndex: number;
  /** Wall-clock budget (ms) for the WHOLE execution incl. retries — the
   *  caller computes it per §7 (min(step timeout, remaining call budget −
   *  margin)); each attempt runs with min(spec.timeoutS, remaining budget). */
  deadlineMs: number;
  /** Spawn seam; defaults to realProcessRunner. */
  runner?: ProcessRunner;
  /** Per-param override seam (resolveParams' third argument) — the
   *  `pipeline step run --param` values, threaded through to the internal
   *  resolveParams call so callers never re-bake specs. */
  overrides?: Record<string, unknown>;
  /** Invoked EXACTLY ONCE, immediately after the §8 ledger-reuse check
   *  concludes no reuse will happen — before binding resolution, before any
   *  spawn, NOT per retry attempt. The command layer hooks its
   *  about-to-execute side effects (e.g. the step.executing event) here
   *  instead of peeking at the ledger from outside. */
  onExecute?: () => void;
  /** Default true. When false, executeScriptStep skips the mechanical
   *  `## Next` parse entirely — no file re-read, no '## Next not mechanically
   *  parseable' warning, record.next_iteration null. Callers in graph/DAG
   *  mode (where routing never reads next_iteration) pass false. */
  parseNext?: boolean;
}

/** Engine-shaped step record synthesized by this module (§5.1). Structurally
 *  a lib/next.ts {kind:'step'} StepRecord + the additive `output`/`summary`
 *  fields (STEP_RECORD_SCHEMA) — declared locally so this module never
 *  imports the engine. */
export interface ScriptStepRecord {
  kind: 'step';
  outcome: 'completed' | 'halted';
  summary?: string | null;
  flags?: Record<string, unknown> | null;
  /** Absolute path of the next iteration, or 'PIPELINE_COMPLETE' (sequential
   *  §5.2); null when `## Next` is not mechanically parseable (graph/DAG). */
  next_iteration?: string | null;
  output?: Record<string, unknown> | null;
  halt_reason?: string | null;
}

/** Feedback-file draft (§6.2.2) — the caller persists it as
 *  `.feedback/<run_id>/<step_id>-NN.md`; `body` is the COMPLETE file content
 *  in the Tier-2 problem-file shape of agents/step-executor.md. */
export interface ScriptFeedbackDraft {
  category: 'script-failure' | 'env' | 'doc-flaw' | 'friction';
  body: string;
}

export interface ScriptStepResult {
  /** Success ⇒ {outcome:'completed', flags, output, next_iteration}. Failure
   *  ⇒ a ready halt-shaped record ({outcome:'halted', halt_reason: "script
   *  step <id> failed (<class>): <detail>"} per §6.3) — the caller uses it
   *  for on-failure:'halt' and discards it when re-dispatching the agent
   *  fallback. */
  record: ScriptStepRecord;
  /** Classified failure of the FINAL attempt; null on success/reuse. */
  failure: ScriptFailureRecord | null;
  /** Absolute path of the persisted failure-record JSON (the agent-fallback
   *  `failure_record` pointer, §6.3); full stdout/stderr in the sibling .log. */
  failurePath: string | null;
  /** Feedback-file draft the caller persists (§6.2.2); null on success. */
  feedback: ScriptFeedbackDraft | null;
  /** True ⇒ the ledger already held a 'finished' entry for this
   *  (step_id, dispatch_index) — stored record returned, NOTHING re-executed. */
  ledgerReused: boolean;
  /** Process executions performed (0 on ledger reuse or pre-spawn failure). */
  attempts: number;
  /** Where the resolved params were written; null when never written
   *  (ledger reuse / binding failure). */
  paramsFile: string | null;
  /** Non-fatal notes (oversized output dropped, unparseable `## Next`, …). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// §3 — Params & binding resolution
// ---------------------------------------------------------------------------

export type ResolveParamsResult =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; detail: string };

type RefResult =
  | { kind: 'value'; value: unknown }
  | { kind: 'unavailable'; why: string }
  | { kind: 'invalid'; why: string };

/** Resolve one `${…}` reference against the binding sources (§3.2). */
function resolveRef(ref: string, ctx: BindingSources): RefResult {
  const invalid = (why: string): RefResult => ({ kind: 'invalid', why });
  const unavailable = (why: string): RefResult => ({ kind: 'unavailable', why });
  const value = (v: unknown): RefResult =>
    v === null || v === undefined ? unavailable(`\${${ref}} resolved to null`) : { kind: 'value', value: v };

  const tokens = ref.split('.');
  switch (tokens[0]) {
    case 'steps': {
      // ${steps.<step_id>.output.<dot.path>} — shape rule + message shared
      // with the plan lint (script-types.ts stepsRefShapeError).
      const shapeError = stepsRefShapeError(ref);
      if (shapeError) return invalid(shapeError);
      const stepId = tokens[1];
      const out = ctx.readOutput(stepId);
      if (out === null) return unavailable(`no persisted output for step '${stepId}'`);
      let cur: unknown = out;
      for (const key of tokens.slice(3)) {
        // Own keys ONLY — inherited keys ('__proto__', 'constructor',
        // 'toString', …) must never resolve from consumer-controlled paths.
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur as object, key)) {
          return unavailable(`\${${ref}}: '${key}' is not reachable in step '${stepId}' output`);
        }
        cur = (cur as Record<string, unknown>)[key];
      }
      return value(cur);
    }
    case 'run':
      if (tokens.length === 2 && tokens[1] === 'id') return value(ctx.runId);
      if (tokens.length === 2 && tokens[1] === 'task') return value(ctx.taskText ?? null);
      return invalid(`unknown reference \${${ref}} — expected \${run.id} or \${run.task}`);
    case 'env': {
      const name = ref.slice('env.'.length);
      if (tokens.length < 2 || !name) return invalid(`malformed reference \${${ref}}`);
      return value((ctx.env ?? process.env)[name]);
    }
    case 'pipeline':
      if (tokens.length === 2 && tokens[1] === 'root') return value(ctx.pipelineRoot);
      return invalid(`unknown reference \${${ref}} — expected \${pipeline.root}`);
    case 'project':
      if (tokens.length === 2 && tokens[1] === 'root') return value(ctx.projectRoot);
      return invalid(`unknown reference \${${ref}} — expected \${project.root}`);
    case 'worktree':
      if (tokens.length === 2 && tokens[1] === 'path') return value(ctx.worktreePath ?? null);
      if (tokens.length === 2 && tokens[1] === 'env_file') return value(ctx.worktreeEnvFile ?? null);
      return invalid(`unknown reference \${${ref}} — expected \${worktree.path} or \${worktree.env_file}`);
    default:
      return invalid(`unknown binding reference \${${ref}}`);
  }
}

const SINGLE_REF_RE = /^\$\{([^}]*)\}$/;
const REF_RE = /\$\{([^}]*)\}/g;

/** Resolve a `from` template: exactly one `${…}` keeps the referenced JSON
 *  type; a mixed template interpolates to a string (§3.2). */
function resolveFrom(template: string, ctx: BindingSources): RefResult {
  const single = SINGLE_REF_RE.exec(template.trim());
  if (single) return resolveRef(single[1], ctx);

  const resolvedByRef = new Map<string, unknown>();
  for (const m of template.matchAll(REF_RE)) {
    const ref = m[1];
    if (resolvedByRef.has(ref)) continue;
    const r = resolveRef(ref, ctx);
    if (r.kind !== 'value') return r; // any unresolved/malformed ref fails the whole template
    resolvedByRef.set(ref, r.value);
  }
  const interpolated = template.replace(REF_RE, (_m, ref: string) => {
    const v = resolvedByRef.get(ref);
    return typeof v === 'string' ? v : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  });
  return { kind: 'value', value: interpolated };
}

function typeMatches(v: unknown, t: ScriptParamSpec['type']): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v);
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    default:
      return false;
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Resolve a `## Params` declaration to the concrete params object (§3.1).
 *  Precedence per param: `overrides[name]` (the `pipeline step run --param`
 *  seam, T33) → `from` → `value` → `default`; an unresolvable REQUIRED param
 *  or a type/enum mismatch is a 'binding' failure (before any spawn).
 *  Unresolved OPTIONAL params are omitted from the params object. */
export function resolveParams(
  specs: Record<string, ScriptParamSpec> | null,
  ctx: BindingSources,
  overrides?: Record<string, unknown>,
): ResolveParamsResult {
  // Null prototype: a consumer-authored param named '__proto__' must land as
  // an OWN key of the params object (and thus in the params file), never hit
  // the Object.prototype setter (silent drop / prototype pollution).
  const params: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const problems: string[] = [];

  for (const [name, spec] of Object.entries(specs ?? {})) {
    let resolved = false;
    let candidate: unknown;

    if (overrides && Object.prototype.hasOwnProperty.call(overrides, name) && overrides[name] !== undefined) {
      candidate = overrides[name];
      resolved = true;
    }
    if (!resolved && typeof spec.from === 'string') {
      const r = resolveFrom(spec.from, ctx);
      if (r.kind === 'invalid') {
        problems.push(`param '${name}': ${r.why}`);
        continue;
      }
      if (r.kind === 'value') {
        candidate = r.value;
        resolved = true;
      }
      // 'unavailable' falls down the value → default ladder.
    }
    if (!resolved && Object.prototype.hasOwnProperty.call(spec, 'value') && spec.value !== undefined) {
      candidate = spec.value;
      resolved = true;
    }
    if (!resolved && Object.prototype.hasOwnProperty.call(spec, 'default') && spec.default !== undefined) {
      candidate = spec.default;
      resolved = true;
    }
    if (!resolved) {
      if (spec.required) problems.push(`required param '${name}' has no resolvable value`);
      continue; // optional & unresolved ⇒ omitted
    }
    if (!typeMatches(candidate, spec.type)) {
      problems.push(`param '${name}' resolved to ${describe(candidate)}, expected ${spec.type}`);
      continue;
    }
    if (spec.enum !== undefined && spec.enum !== null) {
      // Defensive: a consumer-authored non-array enum (e.g. "prod|staging")
      // is a declaration flaw, not a CLI crash (the plan lint ERRORs on it at
      // design time; this is the runtime backstop).
      if (!Array.isArray(spec.enum)) {
        problems.push(`param '${name}' declares a non-array enum (${describe(spec.enum)}) — enum must be a JSON array`);
        continue;
      }
      if (!spec.enum.some((e) => e === candidate)) {
        problems.push(`param '${name}' value ${JSON.stringify(candidate)} is not in enum ${JSON.stringify(spec.enum)}`);
        continue;
      }
    }
    params[name] = candidate;
  }

  if (problems.length > 0) return { ok: false, detail: problems.join('; ') };
  return { ok: true, params };
}

// ---------------------------------------------------------------------------
// §4 — stdout parse + §3.4 output validation
// ---------------------------------------------------------------------------

export interface ParsedStdout {
  result: ScriptResult | null;
  /** Why parsing failed; null when `result` is set. */
  detail: string | null;
}

function tryPlainObject(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Validate a parsed stdout object against the ScriptResult shape (§4). */
function validateResultShape(obj: Record<string, unknown>): ParsedStdout {
  if (typeof obj.ok !== 'boolean') return { result: null, detail: "result JSON has no boolean 'ok'" };
  if (obj.summary !== undefined && obj.summary !== null && typeof obj.summary !== 'string') {
    return { result: null, detail: "result 'summary' must be a string" };
  }
  for (const field of ['flags', 'output', 'error'] as const) {
    if (obj[field] !== undefined && obj[field] !== null && !isPlainObject(obj[field])) {
      return { result: null, detail: `result '${field}' must be a JSON object` };
    }
  }
  return { result: obj as unknown as ScriptResult, detail: null };
}

/** §4: take the LAST stdout line that parses as a JSON object; if no line
 *  parses, attempt a whole-stdout parse; else null (⇒ contract/crash).
 *
 *  Deliberately NOT unified with lib/hooks.ts parseHookJson — precedence
 *  order differs per frozen contract (script: last-line-first; hook:
 *  whole-first); do not merge. */
export function parseScriptStdout(stdout: string): ParsedStdout {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const obj = tryPlainObject(line);
    if (obj) return validateResultShape(obj);
  }
  const whole = tryPlainObject(stdout.trim());
  if (whole) return validateResultShape(whole);
  return { result: null, detail: 'no stdout line (nor the whole stdout) parses as a JSON object' };
}

/** Validate the script's actual `output` object against a `## Output`
 *  declaration (§3.4) — declared-field checks only (extra fields are fine).
 *  Returns a problem description, or null when the output conforms.
 *  EXPORTED (T3-10, additive): composition pops validate a CHILD RUN's
 *  captured output against the parent pipeline step's identical `## Output`
 *  vocabulary — one validator, never forked. */
export function validateOutputShape(
  output: Record<string, unknown> | null,
  decl: Record<string, ScriptParamSpec>,
): string | null {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(decl)) {
    const present = output !== null && Object.prototype.hasOwnProperty.call(output, name) && output[name] !== undefined;
    if (!present) {
      if (spec.required) problems.push(`missing required output field '${name}'`);
      continue;
    }
    const v = output![name];
    if (!typeMatches(v, spec.type)) {
      problems.push(`output field '${name}' is ${describe(v)}, expected ${spec.type}`);
      continue;
    }
    if (spec.enum !== undefined && spec.enum !== null) {
      // Defensive twin of the resolveParams guard: a non-array enum in the
      // ## Output declaration is a contract problem, never a CLI crash.
      if (!Array.isArray(spec.enum)) {
        problems.push(`output field '${name}' declares a non-array enum (${describe(spec.enum)}) — enum must be a JSON array`);
        continue;
      }
      if (!spec.enum.some((e) => e === v)) {
        problems.push(`output field '${name}' value ${JSON.stringify(v)} is not in enum ${JSON.stringify(spec.enum)}`);
      }
    }
  }
  return problems.length > 0 ? problems.join('; ') : null;
}

// ---------------------------------------------------------------------------
// §6.1 — mechanical failure classification
// ---------------------------------------------------------------------------

export interface ClassifiedRun {
  /** True ⇒ success: exit 0 + ok:true + (when declared) conformant output. */
  ok: boolean;
  /** The parsed ScriptResult when stdout yielded one; else null. */
  result: ScriptResult | null;
  class: FailureClass | null;
  detail: string | null;
}

/** Classify one process run per §6.1. The script's own `error.class` is
 *  trusted when present ('transient'|'env'|'bug'; anything else ⇒ 'bug'). */
export function classifyFailure(
  run: ProcessRunResult,
  outputDecl?: Record<string, ScriptParamSpec> | null,
): ClassifiedRun {
  const fail = (c: FailureClass, d: string, result: ScriptResult | null = null): ClassifiedRun => ({
    ok: false,
    result,
    class: c,
    detail: d,
  });

  if (run.timedOut) return fail('transient', 'timed out (killed by the CLI-enforced deadline)');
  if (run.error) {
    // ENOBUFS = the supervisor's stdout blew the outer buffer — oversized
    // stdout is a contract violation, not a machine problem.
    if (/ENOBUFS/.test(run.error)) return fail('contract', `stdout exceeded the capture buffer: ${run.error}`);
    return fail('env', `spawn failed: ${run.error}`);
  }
  if (Buffer.byteLength(run.stdout, 'utf8') > STDOUT_CAP_BYTES) {
    return fail('contract', `stdout exceeded the ${Math.floor(STDOUT_CAP_BYTES / (1024 * 1024))} MB cap`);
  }

  const { result, detail } = parseScriptStdout(run.stdout);
  if (!result) {
    return run.code === 0
      ? fail('contract', `exit 0 but ${detail}`)
      : fail('crash', `exit ${run.code ?? 'unknown'} with no valid result JSON (${detail})`);
  }
  if (!result.ok) {
    const cls = result.error?.class;
    const c: FailureClass = cls === 'transient' || cls === 'env' ? cls : 'bug';
    const d = result.error?.detail ?? result.summary ?? 'script reported ok:false with no detail';
    return fail(c, d, result);
  }
  if (run.code !== 0) {
    return fail('crash', `exit ${run.code ?? 'unknown'} despite an ok:true result`, result);
  }
  if (outputDecl) {
    const violation = validateOutputShape(result.output ?? null, outputDecl);
    if (violation) return fail('contract', `output violates the ## Output declaration: ${violation}`, result);
  }
  return { ok: true, result, class: null, detail: null };
}

// ---------------------------------------------------------------------------
// §5.2 — mechanical `## Next` parse (sequential advancement)
// ---------------------------------------------------------------------------

export interface NextParse {
  /** Absolute path of the next iteration, or the literal 'PIPELINE_COMPLETE';
   *  null when the section is missing/ambiguous (graph/DAG steps routinely
   *  have no mechanically-parseable Next — the §2.2 plan ERROR guarantees
   *  sequential script steps DO). */
  next: string | null;
  error: string | null;
}

// Strip-only variant of lib/frontmatter.ts — kept local for import
// discipline; extra trailing-whitespace/EOF tolerance is deliberate.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const NEXT_HEADING_RE = /^##\s+Next\s*$/im;

/** Absolute-path check accepting BOTH platform forms regardless of the host
 *  (iteration files carry consumer-authored absolute paths). */
function isAbsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

/** Deterministically parse the step file's `## Next` section: the single
 *  absolute path, or `Pipeline complete.` ⇒ 'PIPELINE_COMPLETE' (§5.2). */
export function parseNextSection(iterationPath: string): NextParse {
  let text: string;
  try {
    text = readFileSync(iterationPath, 'utf8');
  } catch (e) {
    return { next: null, error: `cannot read iteration file: ${(e as Error).message}` };
  }
  const body = text.replace(FRONTMATTER_RE, '');
  const heading = NEXT_HEADING_RE.exec(body);
  if (!heading) return { next: null, error: 'no ## Next section' };
  const after = body.slice(heading.index + heading[0].length);
  const nextHeading = /^#{1,6}\s/m.exec(after);
  const section = nextHeading ? after.slice(0, nextHeading.index) : after;
  const lines = section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { next: null, error: '## Next section is empty' };
  if (lines.length > 1) {
    return {
      next: null,
      error: `## Next must be exactly one absolute path or 'Pipeline complete.' (found ${lines.length} lines)`,
    };
  }
  // Bullet + backtick normalization shared with the §2.2 plan lint
  // (script-types.ts normalizeNextLine) — lint grammar ⊆ runtime grammar.
  const line = normalizeNextLine(lines[0]);
  if (/^pipeline complete\.?$/i.test(line)) return { next: 'PIPELINE_COMPLETE', error: null };
  if (isAbsPath(line)) return { next: line, error: null };
  return { next: null, error: `## Next line is neither an absolute path nor 'Pipeline complete.': "${line}"` };
}

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** Atomic variant for the LEDGER (§8): write a sibling temp file, then
 *  rename over the target (rename replaces on both win32 and POSIX in
 *  node/bun). A SIGKILL mid-write must never leave truncated ledger JSON —
 *  readLedger would treat it as ABSENT and re-execute a side-effectful
 *  script, the exact crash window the ledger exists to close. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

function readLedger(path: string): LedgerEntry | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (isPlainObject(v) && (v.phase === 'started' || v.phase === 'finished')) return v as unknown as LedgerEntry;
  } catch {
    // corrupt ledger entry ⇒ treat as absent (re-execute; scripts are
    // idempotency-mandated for exactly this case)
  }
  return null;
}

/** The attempt-ledger file for one (step_id, dispatch_index) execution (§8) —
 *  single source of the ledger path layout. */
function ledgerPath(pipelineRoot: string, runId: string, stepId: string, dispatchIndex: number): string {
  return join(pipelineRoot, '.runtime', runId, 'ledger', `${stepId}-${dispatchIndex}.json`);
}

/** Parse a worktree env file: KEY=VALUE lines, `#` comments ignored, optional
 *  `export ` prefix and surrounding quotes tolerated — NEVER shell-sourced (§4). */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// §6.2.2 — feedback-file draft
// ---------------------------------------------------------------------------

/** §6.2.2 category mapping. 'transient' is unassigned by the spec — it maps
 *  to 'friction' (HUMAN-ONLY: a flake is not a script or doc flaw). */
function categoryFor(c: FailureClass): ScriptFeedbackDraft['category'] {
  switch (c) {
    case 'crash':
    case 'contract':
    case 'bug':
      return 'script-failure';
    case 'env':
      return 'env';
    case 'binding':
      return 'doc-flaw';
    case 'transient':
      return 'friction';
  }
}

function suggestedFixFor(c: FailureClass, spec: ScriptStepSpec, failure: ScriptFailureRecord): string {
  const target = spec.script ?? (spec.command ? spec.command.join(' ') : '<unknown>');
  switch (c) {
    case 'binding':
      return `Fix the \`## Params\` wiring in the iteration file — ${failure.detail}`;
    case 'env':
      return 'Environment/machine issue (interpreter or dependency unavailable) — a human must fix the machine; not a pipeline-doc flaw.';
    case 'transient':
      return `Transient failure persisted after ${failure.attempt} attempt(s); consider raising \`retries:\` or investigating the flaky dependency.`;
    default:
      return `Repair the script (\`mode: repair-script\`): read the failure record and its sibling .log, then fix \`${target}\`.`;
  }
}

function feedbackDraft(
  spec: ScriptStepSpec,
  iterationPath: string,
  ctx: ScriptStepContext,
  failure: ScriptFailureRecord,
  failurePath: string | null,
): ScriptFeedbackDraft {
  const category = categoryFor(failure.class);
  const evidence = [
    `exit_code: ${failure.exit_code ?? 'null'}; timed_out: ${failure.timed_out}; duration_s: ${failure.duration_s}; attempt: ${failure.attempt}`,
    failure.stderr_tail ? `stderr tail:\n${tail(failure.stderr_tail, 400)}` : 'stderr: (empty)',
    failurePath ? `Full failure record: ${failurePath} (full stdout/stderr in the sibling .log).` : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n');
  const body = [
    '---',
    `category: ${category}`,
    `iteration: ${iterationPath}`,
    `step_id: ${ctx.stepId}`,
    '---',
    '## Problem',
    `Script step '${ctx.stepId}' failed with class '${failure.class}': ${failure.detail}`,
    '## Evidence',
    evidence,
    '## Suggested fix',
    suggestedFixFor(failure.class, spec, failure),
    '',
  ].join('\n');
  return { category, body };
}

// ---------------------------------------------------------------------------
// executeScriptStep — the whole §3→§8 pipeline for ONE step execution
// ---------------------------------------------------------------------------

/** ≈2 KB stdout/stderr tails on failure records (§6.2.1). */
const FAILURE_TAIL_CHARS = 2048;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Execute one script step: ledger check → binding resolution → params file →
 *  spawn (with transient-only retries) → classification → failure record /
 *  ledger writes → synthesized engine record. Synchronous, never throws for
 *  script-side problems (only for catastrophic CLI-side fs errors). */
export function executeScriptStep(
  spec: ScriptStepSpec,
  iterationPath: string,
  ctx: ScriptStepContext,
): ScriptStepResult {
  const warnings: string[] = [];
  const runDir = join(ctx.pipelineRoot, '.runtime', ctx.runId);
  const ledgerFile = ledgerPath(ctx.pipelineRoot, ctx.runId, ctx.stepId, ctx.dispatchIndex);
  const failuresDir = join(runDir, 'failures');

  // §8 — attempt-ledger check BEFORE anything else: 'finished' ⇒ reuse the
  // stored record, never re-execute; 'started' ⇒ the previous attempt died
  // mid-flight ⇒ fall through and re-execute (idempotency requirement).
  const prior = readLedger(ledgerFile);
  if (prior && prior.phase === 'finished' && isPlainObject(prior.record)) {
    return {
      record: prior.record as unknown as ScriptStepRecord,
      failure: null,
      failurePath: null,
      feedback: null,
      ledgerReused: true,
      attempts: 0,
      paramsFile: null,
      warnings,
    };
  }

  // No reuse ⇒ a real execution follows (even one that dies at binding
  // resolution) — fire the once-per-execution seam. Never re-fired per retry.
  ctx.onExecute?.();

  /** Shared pre-spawn/final failure epilogue: §6.2.1 record + .log, feedback
   *  draft, halt-shaped record. */
  const finalize = (failure: ScriptFailureRecord, run: ProcessRunResult | null, attempts: number): ScriptStepResult => {
    // Keyed <step_id>-<dispatch_index>-<attempt> (§6.2.1): a graph loop-back
    // re-execution (same step_id, NEW dispatch index) must never overwrite an
    // earlier execution's evidence.
    const failurePath = join(failuresDir, `${ctx.stepId}-${failure.dispatch_index}-${failure.attempt}.json`);
    writeJson(failurePath, failure);
    const logPath = failurePath.replace(/\.json$/, '.log');
    const logBody = run
      ? `# stdout\n${run.stdout}\n\n# stderr\n${run.stderr}\n`
      : `# no execution — ${failure.class} failure before spawn\n${failure.detail}\n`;
    writeFileSync(logPath, logBody, 'utf8');
    const record: ScriptStepRecord = {
      kind: 'step',
      outcome: 'halted',
      halt_reason: `script step ${ctx.stepId} failed (${failure.class}): ${failure.detail}`,
      flags: null,
      next_iteration: null,
      output: null,
    };
    return {
      record,
      failure,
      failurePath,
      feedback: feedbackDraft(spec, iterationPath, ctx, failure, failurePath),
      ledgerReused: false,
      attempts,
      paramsFile: failure.params_file,
      warnings,
    };
  };

  const preSpawnFailure = (cls: FailureClass, detail: string, paramsFile: string | null): ScriptStepResult =>
    finalize(
      {
        step_id: ctx.stepId,
        attempt: 1,
        dispatch_index: ctx.dispatchIndex,
        class: cls,
        exit_code: null,
        timed_out: false,
        stderr_tail: '',
        stdout_tail: '',
        params_file: paramsFile,
        duration_s: 0,
        detail,
      },
      null,
      0,
    );

  // §3 — bindings BEFORE anything spawns (failure class 'binding');
  // ctx.overrides is the `pipeline step run --param` seam.
  const resolved = resolveParams(spec.params, ctx, ctx.overrides);
  if (!resolved.ok) return preSpawnFailure('binding', resolved.detail, null);

  // argv: script (interpreter ladder via lib/hooks.ts) XOR command (§2.1/§2.2).
  let argv: string[];
  if (spec.script) {
    const scriptAbs = isAbsPath(spec.script) ? spec.script : join(ctx.pipelineRoot, spec.script);
    const interp = interpreterFor(scriptAbs);
    argv = interp.args.length > 0 ? [interp.cmd, ...interp.args] : [interp.cmd];
  } else if (spec.command && spec.command.length > 0) {
    argv = [...spec.command];
  } else {
    return preSpawnFailure('binding', 'script step declares neither script: nor command:', null);
  }

  // §4 — params file (a file, not argv/env payload: Windows quoting + size).
  const paramsFile = join(runDir, 'params', `${ctx.stepId}.json`);
  writeJson(paramsFile, resolved.params);

  // §4 — env overlay: worktree env-file entries first (never shell-sourced),
  // then the authoritative PIPELINE_STEP_* contract vars on top.
  const overlay: Record<string, string> = {};
  if (ctx.worktreeEnvFile) {
    try {
      Object.assign(overlay, parseEnvFile(readFileSync(ctx.worktreeEnvFile, 'utf8')));
    } catch (e) {
      return preSpawnFailure('env', `cannot read worktree env file ${ctx.worktreeEnvFile}: ${(e as Error).message}`, paramsFile);
    }
  }
  overlay.PIPELINE_STEP_RUN_ID = ctx.runId;
  overlay.PIPELINE_STEP_ID = ctx.stepId;
  overlay.PIPELINE_STEP_INDEX = String(ctx.dispatchIndex);
  overlay.PIPELINE_STEP_PIPELINE_ROOT = ctx.pipelineRoot;
  overlay.PIPELINE_STEP_PROJECT_ROOT = ctx.projectRoot;
  overlay.PIPELINE_STEP_PARAMS_FILE = paramsFile;
  if (ctx.worktreePath) overlay.PIPELINE_STEP_WORKTREE_PATH = ctx.worktreePath;
  if (ctx.worktreeEnvFile) overlay.PIPELINE_STEP_WORKTREE_ENV_FILE = ctx.worktreeEnvFile;

  const cwd = ctx.worktreePath ?? ctx.projectRoot; // §4 cwd rule
  const runner = ctx.runner ?? realProcessRunner;

  // §8 — mark 'started' immediately before the first spawn.
  writeJsonAtomic(ledgerFile, {
    step_id: ctx.stepId,
    dispatch_index: ctx.dispatchIndex,
    phase: 'started',
  } satisfies LedgerEntry);

  const startedAt = Date.now();
  const maxAttempts = 1 + Math.max(0, spec.retries);
  let attempt = 0;
  let last: { failure: ScriptFailureRecord; run: ProcessRunResult } | null = null;

  while (attempt < maxAttempts) {
    attempt++;
    const remainingMs = ctx.deadlineMs - (Date.now() - startedAt);
    const timeoutMs = Math.max(1, Math.min(spec.timeoutS * 1000, remainingMs));
    const attemptStart = Date.now();
    const run = runner(argv, { env: overlay, cwd, timeoutMs });
    const durationS = round3((Date.now() - attemptStart) / 1000);

    const cls = classifyFailure(run, spec.output);
    if (cls.ok) {
      const result = cls.result!;
      let output = result.output ?? null;
      if (output && Buffer.byteLength(JSON.stringify(output), 'utf8') > OUTPUT_PERSIST_CAP_BYTES) {
        warnings.push(
          `step output exceeds the ${Math.floor(OUTPUT_PERSIST_CAP_BYTES / 1024)} KB persist cap — dropped (downstream bindings to it will fail)`,
        );
        output = null;
      }
      // §5.2 — mechanical `## Next` parse, skipped when the caller routes
      // without next_iteration (ctx.parseNext false ⇒ graph/DAG): no file
      // re-read, no warning noise.
      let nextIteration: string | null = null;
      if (ctx.parseNext !== false) {
        const nextParse = parseNextSection(iterationPath);
        if (nextParse.error) warnings.push(`## Next not mechanically parseable: ${nextParse.error}`);
        nextIteration = nextParse.next;
      }
      const record: ScriptStepRecord = {
        kind: 'step',
        outcome: 'completed',
        summary: result.summary ?? null,
        flags: result.flags ?? null,
        next_iteration: nextIteration,
        output,
      };
      // §8 — flip to 'finished' (record + output stored for reuse).
      writeJsonAtomic(ledgerFile, {
        step_id: ctx.stepId,
        dispatch_index: ctx.dispatchIndex,
        phase: 'finished',
        output,
        record,
      } satisfies LedgerEntry);
      return {
        record,
        failure: null,
        failurePath: null,
        feedback: null,
        ledgerReused: false,
        attempts: attempt,
        paramsFile,
        warnings,
      };
    }

    // §6.2.1 — EVERY failed attempt gets a failure record + full .log.
    const failure: ScriptFailureRecord = {
      step_id: ctx.stepId,
      attempt,
      dispatch_index: ctx.dispatchIndex,
      class: cls.class!,
      exit_code: run.code,
      timed_out: run.timedOut,
      stderr_tail: tail(run.stderr, FAILURE_TAIL_CHARS),
      stdout_tail: tail(run.stdout, FAILURE_TAIL_CHARS),
      params_file: paramsFile,
      duration_s: durationS,
      detail: cls.detail!,
    };
    last = { failure, run };

    // §6.3.1 — mechanical retries: class 'transient' ONLY, budget permitting.
    const budgetLeft = ctx.deadlineMs - (Date.now() - startedAt) > 0;
    if (!(cls.class === 'transient' && attempt < maxAttempts && budgetLeft)) break;
    // Intermediate transient failures still persist their §6.2.1 records.
    const midPath = join(failuresDir, `${ctx.stepId}-${ctx.dispatchIndex}-${attempt}.json`);
    writeJson(midPath, failure);
    writeFileSync(midPath.replace(/\.json$/, '.log'), `# stdout\n${run.stdout}\n\n# stderr\n${run.stderr}\n`, 'utf8');
  }

  return finalize(last!.failure, last!.run, attempt);
}

