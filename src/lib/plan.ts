// computePlan — the deterministic "what does this pipeline run look like" pass.
//
// This is the work the pipeline-manager used to do in-context: glob every
// iteration file, read its frontmatter, decide sequential vs DAG, resolve each
// step's model, and (for DAG) build + validate the dependency layers. Doing it
// here, in a plain process, means the manager reads ONE compact JSON instead of
// O(N) frontmatter files — flat token cost regardless of pipeline length.
//
// Library-exported so other local projects can `import { computePlan }` instead
// of shelling out to the CLI.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, basename, dirname } from 'node:path';
import { parseFrontmatter, type FrontmatterValue } from './frontmatter';
import { extractGraph, validateGraph, type Graph } from './graph';
import {
  DEFAULT_SCRIPT_TIMEOUT_S,
  MANAGER_SAFE_TIMEOUT_S,
  normalizeNextLine,
  SECRET_ENV_PATTERN,
  stepsRefShapeError,
  type OnFailurePolicy,
  type ScriptParamSpec,
  type ScriptStepSpec,
  type StepType,
} from './script-types';
import {
  lintComposition,
  resolvePipelineRef,
  MAX_COMPOSITION_DEPTH,
  type CompositionEdge,
  type PipelineStepSpec,
} from './compose';
import { APPROVAL_ROLES, normalizeApprovalRole, type GateStepSpec } from './gate';
import {
  hasDeclarations,
  parseVariablesSection,
  scanNearMisses,
  scanOccurrences,
  validateRun,
  type SubstitutionIssue,
  type VariableDecl,
} from './substitution';

export type PipelineMode = 'sequential' | 'parallel';
export type Isolation = 'worktree' | 'manual' | 'external';

export interface PlanStep {
  /** 1-based position in enumeration (sorted relative path) order. */
  index: number;
  /** Absolute path to the iteration file. */
  path: string;
  /** Path relative to `steps/`, POSIX-separated. */
  rel: string;
  /** `step_id` frontmatter, or the filename stem when absent. */
  step_id: string;
  /** Effective model: step `model` ?? pipeline default ?? null (inherit). */
  model: string | null;
  /** Effective reasoning effort: step `effort` ?? pipeline default ?? null
   *  (inherit the session's effort). Same precedence ladder as `model`. */
  effort: string | null;
  /** Explicit `depends-on` ids (empty when none declared). */
  depends_on: string[];
  /** Step kind (frontmatter `type:`) — absent ⇒ 'agent', so every existing
   *  pipeline parses exactly as before (absolute backward compat). */
  type: StepType;
  /** Parsed `type: script` declaration (frontmatter §2.1 + the `## Params` /
   *  `## Output` body blocks §3 of roadmap/script-steps/DESIGN.md) — null on
   *  agent steps. Exactly one of script/command is non-null on an error-free
   *  plan. */
  script_spec: ScriptStepSpec | null;
  /** Parsed `type: pipeline` declaration (T3-09 composition — a reference to
   *  another pipeline run as a nested child, with `## Params` bindings that
   *  mirror script steps exactly) — null on agent/script steps. Execution of
   *  the child run is T3-10; the plan only represents + lints it. */
  pipeline_spec: PipelineStepSpec | null;
  /** Parsed `type: gate` declaration (T3-14 approval gates — a deterministic
   *  needs_input pause carrying an `approval:{required_role}` marker; see
   *  lib/gate.ts) — null on non-gate steps. `required_role` is non-null on an
   *  error-free plan. */
  gate_spec: GateStepSpec | null;
}

export interface Plan {
  mode: PipelineMode;
  isolation: Isolation;
  /**
   * Who drives the run: `manager` (a pipeline-manager subagent, the default)
   * or `headless` (a detached CLI-driven runner). From the optional `runner`
   * frontmatter key of PIPELINE.md; unknown values warn and fall back to
   * `manager` (mirrors the `execution:` / `isolation:` parsing).
   */
  runner: 'manager' | 'headless';
  default_model: string | null;
  /** Pipeline-level reasoning effort (PIPELINE.md `effort:`), null = inherit. */
  default_effort: string | null;
  steps: PlanStep[];
  /** Topological layers of step_ids — parallel mode only; null otherwise. */
  layers: string[][] | null;
  /** Routing graph (Variant A) parsed from a `## Graph` section of PIPELINE.md,
   *  or null when the pipeline has none (legacy sequential/DAG). */
  graph: Graph | null;
  /** Declarations parsed from PIPELINE.md's `## Variables` section
   *  (env-variables design, doc 04 §2) — empty when the pipeline declares no
   *  variables (E9 zero-change path). Plan-time lints L1–L5/L7/L8/L9 over
   *  every occurrence surface (step bodies, manifest body, non-exempt
   *  frontmatter) are already folded into `errors`/`warnings`; this field is
   *  attached so callers (the UI editor, `pipeline plan` JSON) can render the
   *  declarations themselves without re-parsing the manifest. */
  variables: VariableDecl[];
  /**
   * Normalized per-run step-model overrides (from ComputePlanOptions.
   * modelOverrides). Already folded into each enumerated step's `model`; kept
   * here so the engine can also apply them to OFF-PLAN (synthesized) steps.
   * Empty when the run has none.
   */
  model_overrides: Record<string, string | null>;
  /** Normalized per-run step-effort overrides (`--effort <step_id>=<level>`) —
   *  same key-presence semantics as model_overrides (null value = force
   *  inherit). Already folded into each enumerated step's `effort`. */
  effort_overrides: Record<string, string | null>;
  /** Hard problems (DAG cycle, dangling/duplicate id, no steps). Non-empty → caller should halt. */
  errors: string[];
  /** Soft notices (ignored depends-on, unknown/invalid field values). */
  warnings: string[];
  /**
   * Directory of conventionally-named worktree hook scripts for
   * `isolation: external` runs. From the optional `worktree_hook_dir`
   * frontmatter key; defaults to `.claude/pipeline/.hooks`.
   */
  worktree_hook_dir: string;
  /**
   * Submodule names the external worktree should include (passed to the hook
   * as `PIPELINE_WT_SUBMODULES`). From the optional `submodules` frontmatter
   * key (inline `[a, b]` or block list); empty when absent.
   */
  submodules: string[];
  /**
   * Base branch the external worktree hooks branch from / integrate into
   * (passed to the create AND finalize hooks as `PIPELINE_WT_BASE_BRANCH`).
   * From the optional `base_branch` frontmatter key; defaults to `main`.
   */
  base_branch: string;
  /**
   * Opt-in to the mandatory **finalize** stage (external isolation only): a
   * terminal `worktree-finalize` hook that MUST succeed before a completed run
   * may be torn down / marked done. From the optional `finalize: true`
   * frontmatter flag; default false. This is only ONE of two opt-in triggers —
   * the `pipeline next` command ALSO opts a run in when a `worktree-finalize.*`
   * hook is present in the resolved hook dir (it owns project-root/hook-dir
   * resolution; plan.ts sees only the frontmatter flag). GENERIC: WHAT finalize
   * does (commit something, push, bump a pointer, anything) is entirely the
   * consumer hook's business — the plugin only requires it return ok.
   */
  finalize: boolean;
  /**
   * Opt-OUT of run-branch deletion (external isolation only): when true (the
   * default), the destroy hook of a COMPLETED run receives
   * `PIPELINE_WT_DELETE_BRANCHES=1` so the run branch dies with the worktree —
   * a finished, finalized run leaves nothing behind. `delete_branches: false`
   * frontmatter keeps branches on every outcome. Failed runs (halted /
   * depth-exhausted) ALWAYS preserve the branch regardless of this flag — that
   * outcome-aware gate lives in the engine (emitTeardown), not here.
   */
  delete_branches: boolean;
}

export interface ComputePlanOptions {
  /**
   * Pipeline-level default model, when the caller already resolved it
   * (e.g. the /pipeline:run supervisor). When omitted, it is read from
   * PIPELINE.md frontmatter. `null` means "inherit".
   */
  defaultModel?: string | null;
  /**
   * Per-run, per-step model overrides (`--model <step_id>=<model>`), keyed by
   * step_id. HIGHEST precedence: an override beats the step's own `model:`
   * frontmatter AND the pipeline default. A `null`/`inherit` value forces the
   * session default for that step. Values are normalized here (invalid ones
   * warn and are dropped); keys matching no enumerated step warn but are kept
   * on `Plan.model_overrides` so off-plan (synthesized) steps still honor them.
   */
  modelOverrides?: Record<string, string | null>;
  /**
   * Pipeline-level default reasoning effort override (mirrors defaultModel).
   * When omitted, read from PIPELINE.md `effort:` frontmatter. `null` = inherit.
   */
  defaultEffort?: string | null;
  /**
   * Per-run, per-step effort overrides (`--effort <step_id>=<level>`) —
   * exactly the modelOverrides contract: highest precedence, key presence
   * wins, null value forces inherit, invalid values warn and drop.
   */
  effortOverrides?: Record<string, string | null>;
  /**
   * Composition depth cap override — the maximum number of pipelines in a
   * `type: pipeline` nesting chain, the entry pipeline included (see
   * lib/compose.ts MAX_COMPOSITION_DEPTH, the default). Invalid values
   * (non-integer, < 1) warn and fall back to the default.
   */
  maxCompositionDepth?: number;
}

const MODEL_ALIASES = new Set(['haiku', 'sonnet', 'opus', 'fable']);

/** The platform's reasoning-effort levels (claude --effort / agent frontmatter
 *  `effort:` / Agent SDK options.effort — verified 2026-07). `inherit`/empty
 *  normalizes to null = use the session default. */
export const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Normalize a frontmatter `effort:` value to an accepted level / null. Same
 *  contract as normalizeModel: null = inherit, invalid flagged for a warning. */
export function normalizeEffort(value: FrontmatterValue | undefined): {
  effort: string | null;
  invalid: boolean;
} {
  if (value == null) return { effort: null, invalid: false };
  if (Array.isArray(value)) return { effort: null, invalid: true };
  const v = String(value).trim().toLowerCase();
  if (v === '' || v === 'inherit') return { effort: null, invalid: false };
  if (EFFORT_LEVELS.has(v)) return { effort: v, invalid: false };
  return { effort: null, invalid: true };
}

/** Normalize a frontmatter `model:` value to an accepted alias / canonical id / null. */
export function normalizeModel(value: FrontmatterValue | undefined): {
  model: string | null;
  invalid: boolean;
} {
  if (value == null) return { model: null, invalid: false };
  if (Array.isArray(value)) return { model: null, invalid: true };
  const v = value.trim();
  if (v === '' || v.toLowerCase() === 'inherit') return { model: null, invalid: false };
  const lower = v.toLowerCase();
  if (MODEL_ALIASES.has(lower)) return { model: lower, invalid: false };
  if (v.startsWith('claude-')) return { model: v, invalid: false };
  return { model: null, invalid: true };
}

// --- Design-time token linting (non-fatal — feeds `warnings`, never `errors`) ---
//
// Thresholds are deliberately conservative: a missed lint costs nothing (the
// pipeline still runs), while a false positive trains authors to ignore
// warnings. Prefer false negatives.

/** Iteration files above this estimated token count get a "consider splitting" warning. */
const ITERATION_TOKEN_BUDGET = 1500;
/** The documented PIPELINE.md manifest cap (see CLAUDE.md — "capped at 300 tokens"). */
const MANIFEST_TOKEN_CAP = 300;
/**
 * Softer manifest cap for target-family members (pipelines under a `targets/`
 * dir): their manifests legitimately carry per-target submodule lists and
 * routing context. Family HUBS (pipelines that HAVE a `targets/` subfolder)
 * are exempt from the manifest cap entirely.
 */
const FAMILY_TARGET_TOKEN_CAP = 1500;
/**
 * Minimum run of CONSECUTIVE imperative/shell-ish lines inside a `## Steps`
 * section before the block is flagged as a script-extraction candidate.
 * Any blank or non-imperative line resets the run.
 */
const PROCEDURAL_BLOCK_MIN_LINES = 10;

/** Crude but deterministic token estimate: ~4 bytes per token. */
function estimateTokens(text: string): number {
  return Math.round(Buffer.byteLength(text, 'utf8') / 4);
}

// A line "looks imperative/shell-ish" when it starts (after indentation) with
// an ordered-list marker (`NN.`), a bullet (`- `), or a shell prompt (`$`),
// or contains a backticked MULTI-WORD span (a command like `git status`).
// Single-word backticked spans (`plan.ts`, `finalize`) are prose mentions of
// identifiers and deliberately do NOT count — conservative by design.
const IMPERATIVE_LINE_START = /^(\d{1,3}\.\s|-\s|\$\s?)/;
const BACKTICKED_COMMAND = /`[^`\n]+\s[^`\n]+`/;

function looksImperative(line: string): boolean {
  return IMPERATIVE_LINE_START.test(line.trimStart()) || BACKTICKED_COMMAND.test(line);
}

/** Lines belonging to `## Steps` sections of a markdown body (frontmatter already stripped). */
function stepsSectionLines(body: string): string[] {
  const out: string[] = [];
  let inSteps = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^##\s+\S/.test(line)) {
      inSteps = /^##\s+Steps\s*$/.test(line);
      continue;
    }
    if (inSteps) out.push(line);
  }
  return out;
}

/** Length of the longest run of consecutive non-blank imperative lines. */
function longestProceduralRun(lines: string[]): number {
  let best = 0;
  let current = 0;
  for (const line of lines) {
    if (line.trim() === '' || !looksImperative(line)) {
      current = 0;
      continue;
    }
    current += 1;
    if (current > best) best = current;
  }
  return best;
}

// --- Script steps (`type: script`) — frontmatter + body-block parsing --------
//
// Spec: roadmap/script-steps/DESIGN.md §2 (declaration + rules), §3
// (Params/Output vocabulary + binding lints), §7 (manager call-budget lint).
// Types and constants come from script-types.ts (frozen) — never redeclared.

/** The `## Params` / `## Output` vocabulary's accepted `type` values (§3.1). */
const PARAM_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);

/** Same fence rule as graph.ts's `## Graph` extraction — kept local because
 *  graph.ts is not this feature's file to edit (see T11 footprint). */
const SPEC_JSON_FENCE_RE = /```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/;

/** Raw text of a `## <heading>` section (up to the next `## ` heading or EOF),
 *  or null when the section is absent. Bounded to the section so a fence in a
 *  LATER section can never be picked up by mistake. */
function sectionText(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/);
  const open = new RegExp(`^##\\s+${heading}\\s*$`, 'i');
  for (let i = 0; i < lines.length; i++) {
    if (!open.test(lines[i])) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s+\S/.test(lines[j])) {
        end = j;
        break;
      }
    }
    return lines.slice(i + 1, end).join('\n');
  }
  return null;
}

/** Extract + vocabulary-check the fenced ```json block of a `## Params` /
 *  `## Output` section (§3.1/§3.4). Absent section → null with no error;
 *  malformed JSON, non-object block, unknown `type`, or `value`+`from`
 *  together → plan ERROR (§3.3). */
function extractSpecBlock(
  body: string,
  section: 'Params' | 'Output',
  label: string,
  errors: string[],
): Record<string, ScriptParamSpec> | null {
  const text = sectionText(body, section);
  if (text === null) return null;
  const fence = SPEC_JSON_FENCE_RE.exec(text);
  if (!fence) {
    errors.push(`${label}: ## ${section} section has no \`\`\`json code block`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch (e) {
    errors.push(`${label}: ## ${section} JSON is invalid: ${(e as Error).message}`);
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push(`${label}: ## ${section} must be a JSON object mapping name → spec`);
    return null;
  }
  for (const [name, rawSpec] of Object.entries(parsed as Record<string, unknown>)) {
    if (rawSpec === null || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
      errors.push(`${label}: ## ${section} '${name}' must be an object spec`);
      continue;
    }
    const spec = rawSpec as Record<string, unknown>;
    if (typeof spec.type !== 'string' || !PARAM_TYPES.has(spec.type)) {
      errors.push(
        `${label}: ## ${section} '${name}' has unknown type '${String(spec.type)}' (valid: string|number|boolean|array|object)`,
      );
    }
    if (spec.value !== undefined && spec.from !== undefined) {
      errors.push(
        `${label}: ## ${section} '${name}' sets both 'value' and 'from' — they are mutually exclusive`,
      );
    }
    if (spec.enum !== undefined && !Array.isArray(spec.enum)) {
      errors.push(
        `${label}: ## ${section} '${name}' has a non-array 'enum' (enum must be a JSON array of allowed values)`,
      );
    }
  }
  return parsed as Record<string, ScriptParamSpec>;
}

/** One `${steps.<id>…}` reference inside a `from` binding template (§3.2).
 *  `outputField` is the FIRST dot-path segment after `.output.` (the level the
 *  producer's `## Output` block declares), or null for other shapes. */
interface StepBindingRef {
  stepId: string;
  outputField: string | null;
  /** The §3.2 shape verdict from the SHARED script-types.stepsRefShapeError
   *  rule: non-null (the ready lint message) when the reference is NOT the
   *  required `${steps.<id>.output.<path>}` shape (e.g. bare `${steps.foo}`
   *  or `${steps.foo.output}`). resolveRef hard-fails these as 'invalid' at
   *  runtime with the SAME message, so the plan must ERROR. */
  shapeError: string | null;
}

function stepRefs(template: string): StepBindingRef[] {
  const out: StepBindingRef[] = [];
  for (const m of template.matchAll(/\$\{steps\.([^.}]+)([^}]*)\}/g)) {
    const rest = m[2] ?? '';
    out.push({
      stepId: m[1],
      outputField: rest.startsWith('.output.')
        ? rest.slice('.output.'.length).split('.')[0]
        : null,
      shapeError: stepsRefShapeError(`steps.${m[1]}${rest}`),
    });
  }
  return out;
}

function envRefs(template: string): string[] {
  return [...template.matchAll(/\$\{env\.([^}]+)\}/g)].map((m) => m[1]);
}

/** `## Next` mechanical rule for sequential-mode script steps (§2.2/§5.2):
 *  the single line must be one absolute path — POSIX (`/…`), Windows drive
 *  (`C:\…` / `C:/…`), or UNC (`\\…`) — pointing at a `.md` iteration file. */
function isAbsoluteNextPath(line: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(line) && line.toLowerCase().endsWith('.md');
}

/** Transitive-ancestor sets under the DAG's EFFECTIVE-deps rule (explicit
 *  `depends-on`, else the immediately-preceding step; first step: none) —
 *  the same partial-annotation rule buildLayers executes, so a binding is
 *  accepted exactly when execution order guarantees the producer ran. */
function dagAncestorSets(steps: PlanStep[]): Map<string, Set<string>> {
  const deps = new Map<string, string[]>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    deps.set(s.step_id, s.depends_on.length ? s.depends_on : i === 0 ? [] : [steps[i - 1].step_id]);
  }
  const memo = new Map<string, Set<string>>();
  const resolve = (id: string, trail: Set<string>): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    if (trail.has(id)) return out; // cycle — buildLayers reports it as a hard error
    trail.add(id);
    for (const dep of deps.get(id) ?? []) {
      out.add(dep);
      for (const a of resolve(dep, trail)) out.add(a);
    }
    trail.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const s of steps) resolve(s.step_id, new Set());
  return memo;
}

/** Walk up from `fromDir` to the first ancestor directory holding a
 *  PIPELINE.md (the run skill's pipeline-root rule) — the SINGLE source of the
 *  walk-up loop the command layer uses to locate a pipeline from an iteration
 *  file. Returns the absolute root directory, or null when none is found
 *  within `maxDepth` levels. */
export function findEnclosingPipelineRoot(fromDir: string, maxDepth = 64): string | null {
  let dir = fromDir;
  for (let guard = 0; guard < maxDepth; guard++) {
    if (existsSync(join(dir, 'PIPELINE.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name.endsWith('.md')) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

interface LayerResult {
  layers: string[][];
  errors: string[];
}

function buildLayers(steps: PlanStep[]): LayerResult {
  const errors: string[] = [];
  const byId = new Map<string, PlanStep>();
  for (const s of steps) {
    if (byId.has(s.step_id)) errors.push(`Duplicate step_id '${s.step_id}'`);
    byId.set(s.step_id, s);
  }

  // Effective deps: an explicit depends-on wins; a step with none defaults to
  // the immediately-preceding step (the first step depends on nothing). This
  // matches the manager's documented partial-annotation rule.
  const deps = new Map<string, string[]>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    deps.set(s.step_id, s.depends_on.length ? s.depends_on : i === 0 ? [] : [steps[i - 1].step_id]);
  }

  for (const [id, ds] of deps) {
    for (const dep of ds) {
      if (!byId.has(dep)) errors.push(`Step '${id}' depends-on unknown step '${dep}'`);
    }
  }
  if (errors.length) return { layers: [], errors };

  const done = new Set<string>();
  const layers: string[][] = [];
  const remaining = new Set(steps.map((s) => s.step_id));
  while (remaining.size) {
    const ready: string[] = [];
    for (const id of remaining) {
      if ((deps.get(id) ?? []).every((d) => done.has(d))) ready.push(id);
    }
    if (ready.length === 0) {
      errors.push(`Cycle detected among steps: ${[...remaining].sort().join(', ')}`);
      break;
    }
    ready.sort();
    layers.push(ready);
    for (const id of ready) {
      done.add(id);
      remaining.delete(id);
    }
  }

  return { layers, errors };
}

// --- PP_* variable declarations + plan-time substitution lints -------------
//
// Spec: env-variables design doc 04 (grammar/lints) + 05 §2 (this seam).
// computePlan composes a1's pure substitution.ts engine; nothing here
// re-implements grammar or lint logic — only the plumbing to (a) attach
// `plan.variables`, (b) build the per-file `frontmatterRaw`/`body` shape
// validateRun expects, mirroring the existing `stepRefs`/`envRefs` lint
// pattern, and (c) fold its SubstitutionIssue[] into errors[]/warnings[]
// with `file:line` prefixes.

// Cheap pre-filter for the zero-change guard: PP_TOKEN_RE and PP_NEARMISS_RE
// both require a `${` immediately (optional whitespace) followed by a
// case-insensitive `pp_` — so a file failing this test cannot contain any
// valid token OR near-miss anywhere (frontmatter or body), and scanning it
// would be pure overhead. A pipeline that never mentions PP_-shaped text
// anywhere therefore adds NO new files to the sweep and NO new
// errors/warnings (E9): the only per-file work that still always happens is
// the O(1) test itself against text already read into memory (no new I/O).
const PP_ISH_RE = /\$\{\s*[Pp][Pp]_/;
function mayContainPPText(text: string): boolean {
  return PP_ISH_RE.test(text);
}

// Frontmatter block delimiter — same shape as frontmatter.ts's own
// FRONTMATTER_RE, duplicated locally (frontmatter.ts discards the raw block
// once parsed into `fields`, and this feature needs the raw text back for
// scanFrontmatter/scanning purposes).
const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** The frontmatter block's raw text, prefixed with one blank placeholder line
 *  so line numbers computed against this string (substitution.ts's `lineOf`
 *  counts from index 0) line up with the ORIGINAL file's line numbers — line
 *  1 (the opening `---`) becomes the blank placeholder, line 2 is the first
 *  real frontmatter line, exactly as in the source file. Returns '' when the
 *  file has no frontmatter block (nothing to scan there). */
function frontmatterBlockAligned(raw: string): string {
  const m = FRONTMATTER_BLOCK_RE.exec(raw);
  return m ? '\n' + m[1] : '';
}

// D5(c): `command:`/`script:` are declared substitution surfaces ONLY on a
// `type: script` STEP (plan.ts reads them at ~fields.command/fields.script) —
// PIPELINE.md's own frontmatter has no such fields, so this exemption is
// step-scoped; the manifest gets the full, unexempted L3 ban (see the
// `exemptFrontmatterKeys` parameter of `registerSubstitutionFile` below).
// Captures the rest-of-line so the caller can tell an EMPTY inline value
// (`command:` alone, expecting a following block list) from a non-empty one.
const EXEMPT_FRONTMATTER_KEY_RE = /^(command|script)\s*:(.*)$/i;
// Block-list continuation item — mirrors frontmatter.ts's OWN rule
// (`/^\s*-\s+/`, frontmatter.ts:58) exactly, including that it matches a
// ZERO-indent `- item` bullet (frontmatter.ts does not require indentation
// for block-list items, only that the owning `key:` line itself is
// top-level).
const BLOCK_LIST_ITEM_RE = /^\s*-\s+/;

/** Blank out the `command:`/`script:` key lines — and, when that key's
 *  inline value is EMPTY (mirroring frontmatter.ts's own "possible block
 *  list" condition, frontmatter.ts:54), any immediately-following block-list
 *  continuation lines — from an ALIGNED frontmatter block (see
 *  `frontmatterBlockAligned`), so `scanFrontmatter` never reports L3 on them.
 *  Blanking — never deleting — keeps every OTHER line's number stable, so
 *  L3 issues on the remaining (banned) keys still carry the correct original
 *  file line. */
function stripExemptFrontmatterLines(fmBlock: string): string {
  if (!fmBlock) return fmBlock;
  const lines = fmBlock.split('\n');
  let skipContinuation = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (skipContinuation && BLOCK_LIST_ITEM_RE.test(line)) {
      lines[i] = '';
      continue;
    }
    skipContinuation = false;
    const m = EXEMPT_FRONTMATTER_KEY_RE.exec(line);
    if (m) {
      lines[i] = '';
      skipContinuation = (m[2] ?? '').trim() === '';
    }
  }
  return lines.join('\n');
}

/** Number of lines consumed by `raw` before `body` starts (i.e. the
 *  frontmatter block, delimiters included) — added to a BODY-relative line
 *  number (as `scanOccurrences`/`scanNearMisses` compute it, always counting
 *  from index 0 of whatever text they were given) to recover the TRUE file
 *  line. Zero when the file has no frontmatter (body === the whole file). */
function lineOffsetOf(raw: string, body: string): number {
  const headerLen = raw.length - body.length;
  if (headerLen <= 0) return 0;
  let n = 0;
  for (let i = 0; i < headerLen; i++) if (raw.charCodeAt(i) === 10) n++;
  return n;
}

const VARIABLES_H2_RE = /^##\s+Variables\s*$/;
const ANY_H2_RE = /^##\s+/;
const CODE_FENCE_LINE_RE = /^\s*(?:```|~~~)/;

/**
 * D8 (REVISED): the `## Variables` section is excluded from the
 * `MANIFEST_TOKEN_CAP` count (precedent: the family-HUB exemption) — a
 * pipeline's variable documentation shouldn't compete with its ~300-token
 * manifest budget. Finds the section's CHARACTER span (heading line through
 * the line before the next H2 heading, or EOF; fence-aware — closely
 * mirrors `parseVariablesSection`'s boundary rule, 04 §2 — exact declaration
 * parsing stays that function's job) and returns its exact UTF-8 byte length
 * via ONE `Buffer.byteLength` call over the real substring — never a
 * per-line "+1" approximation, which would under-count a CRLF-terminated
 * file by a byte per line relative to `estimateTokens`'s whole-text
 * `Buffer.byteLength` (a real \r\n is 2 bytes, not 1). A cheap substring
 * pre-check skips the whole scan for the common case (no such section).
 * Returns 0 when the body has no `## Variables` section.
 */
function variablesSectionByteLength(body: string): number {
  if (!body.includes('## Variables')) return 0;
  let start = -1;
  let end = body.length;
  let inFence = false;
  let pos = 0;
  while (pos <= body.length) {
    const nl = body.indexOf('\n', pos);
    const lineEnd = nl === -1 ? body.length : nl;
    const line = body.slice(pos, lineEnd);
    if (CODE_FENCE_LINE_RE.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      if (start === -1 && VARIABLES_H2_RE.test(line)) {
        start = pos;
      } else if (start !== -1 && ANY_H2_RE.test(line)) {
        end = pos;
        break;
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (start === -1) return 0;
  return Buffer.byteLength(body.slice(start, end), 'utf8');
}

/** Fold a `SubstitutionIssue[]` (from `parseVariablesSection` or
 *  `validateRun`) into the plan's flat `errors`/`warnings` string arrays,
 *  prefixing every message with `file:line` (or just `file` when the issue is
 *  decl-level and carries no line) for a uniform, greppable shape regardless
 *  of whether the underlying message already happens to mention a location.
 *
 *  Line numbers from `parseVariablesSection` and from validateRun's
 *  `scanOccurrences`/`scanNearMisses` calls are BODY-relative (04 §3's
 *  scanning primitives always count from index 0 of the text they were
 *  given) and need `lineOffsets` added back to recover the true file line.
 *  `scanFrontmatter`-sourced issues (kind `'frontmatter'`) are the one
 *  exception: we feed it a `frontmatterBlockAligned` text whose line numbers
 *  are ALREADY file-true, so `alwaysOffset=false` skips the correction for
 *  those; `alwaysOffset=true` (the `parseVariablesSection` caller) offsets
 *  unconditionally since that call only ever sees body-relative declarations. */
function foldSubstitutionIssues(
  issues: SubstitutionIssue[],
  lineOffsets: Map<string, number>,
  alwaysOffset: boolean,
  errors: string[],
  warnings: string[],
): void {
  for (const issue of issues) {
    let line = issue.line;
    if (line !== undefined && (alwaysOffset || issue.kind !== 'frontmatter')) {
      line += lineOffsets.get(issue.file) ?? 0;
    }
    // Decl-level issues (L7/L8) carry validateRun's `fallbackFile` (the
    // first scanned file's name) rather than a real occurrence location;
    // fall back to 'PIPELINE.md' (declarations always live there) so a run
    // with declarations but nothing else in the sweep never emits a
    // location-less, leading-colon message.
    const file = issue.file || 'PIPELINE.md';
    const loc = line !== undefined ? `${file}:${line}` : file;
    (issue.severity === 'error' ? errors : warnings).push(`${loc}: ${issue.message}`);
  }
}

/** Register one file (PIPELINE.md or a step) for the plan-time substitution
 *  lint sweep — mirrors the stepRefs/envRefs lint pattern of collecting
 *  candidates during enumeration, then linting them all at once via
 *  validateRun. Gated by the zero-change pre-filter (`mayContainPPText`)
 *  UNLESS `force` is set: a file that cannot contain a PP_-shaped token
 *  contributes nothing to validateRun's occurrence/frontmatter scan either
 *  way, so both the aligned-frontmatter computation and the line-offset
 *  bookkeeping are skipped entirely for it — no wasted work on the hot path.
 *  `force` is set for PIPELINE.md whenever the manifest declares ANY
 *  variables, so `substitutionFiles[0]` (validateRun's `fallbackFile`) is
 *  never empty for the decl-level L7/L8 issues even when no file's text
 *  happens to contain PP_-shaped text at all.
 *  `exemptFrontmatterKeys` applies the D5(c) `command:`/`script:` carve-out —
 *  true for step files (which may legitimately declare those keys), false
 *  for PIPELINE.md (which has no such fields; its frontmatter gets the full,
 *  unexempted L3 ban). */
function registerSubstitutionFile(
  file: string,
  raw: string,
  body: string,
  exemptFrontmatterKeys: boolean,
  lineOffsets: Map<string, number>,
  files: Array<{ file: string; frontmatterRaw: string; body: string }>,
  force = false,
): void {
  if (!force && !mayContainPPText(raw)) return;
  lineOffsets.set(file, lineOffsetOf(raw, body));
  const aligned = frontmatterBlockAligned(raw);
  files.push({
    file,
    frontmatterRaw: exemptFrontmatterKeys ? stripExemptFrontmatterLines(aligned) : aligned,
    body,
  });
}

/** 1-based FILE line of the first `command:`/`script:` key line in the raw
 *  file's frontmatter block — the location the D5(c) surface lints report
 *  (line 1 is the opening `---`, so block line i is file line i+2). undefined
 *  when the file has no frontmatter block or no such key. */
function frontmatterKeyLine(raw: string, key: 'command' | 'script'): number | undefined {
  const m = FRONTMATTER_BLOCK_RE.exec(raw);
  if (!m) return undefined;
  const lines = m[1]!.split(/\r?\n/);
  const re = new RegExp(String.raw`^${key}\s*:`, 'i');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) return i + 2;
  }
  return undefined;
}

/** D5(c) surface sweep (env-variables design, a4 extension of the 05 §2
 *  lints): a `type: script` step's `command:`/`script:` VALUES are declared
 *  substitution surfaces, but they live in frontmatter — exempted from the L3
 *  ban as surfaces, and invisible to the body sweep. Sweeping them here
 *  closes both 05 §2 literal-text gaps: an undeclared `${PP_X}` inside a
 *  command is an L1 plan ERROR (was: first caught at run init), and a
 *  variable used ONLY in a command counts as USAGE for L7 (was: a false
 *  "unused" warning). Near-misses are L2 errors like anywhere else.
 *
 *  `command:` is scanned PER ARGV ELEMENT — exactly what the runtime
 *  substitutes (E2, scan/substitute parity) — with two extra rules:
 *    - argv[0] is NEVER substituted at runtime (T3b hardening: a variable
 *      must not choose the executable), so a token there is a plan ERROR now
 *      instead of a run-time binding failure;
 *    - a token visible in the RAW string form but in no post-split element
 *      (an inline default carrying whitespace, destroyed by tokenization)
 *      gets a dedicated warning — it would otherwise silently never
 *      substitute.
 *  All issues carry the KEY line (per-token line bookkeeping inside a
 *  frontmatter value isn't worth it). Zero-change: every scan is gated on the
 *  PP_-ish pre-filter. */
function lintScriptSurfaces(
  fileLabel: string,
  raw: string,
  script: string | null,
  command: string[] | null,
  commandRawValue: string | null,
  declared: Set<string>,
  usedNames: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  // One frontmatter re-parse per key, computed lazily (the common case — no
  // PP_-ish text anywhere — never derives a location at all).
  const locCache = new Map<string, string>();
  const locFor = (key: 'command' | 'script'): string => {
    let loc = locCache.get(key);
    if (loc === undefined) {
      const line = frontmatterKeyLine(raw, key);
      loc = line !== undefined ? `${fileLabel}:${line}` : fileLabel;
      locCache.set(key, loc);
    }
    return loc;
  };
  /** Scan ONE surface value: usage + L1 + L2; returns its occurrence count. */
  const sweep = (text: string, key: 'command' | 'script'): number => {
    if (!mayContainPPText(text)) return 0;
    const occs = scanOccurrences(text, fileLabel);
    for (const occ of occs) {
      usedNames.add(occ.name);
      if (!declared.has(occ.name)) {
        errors.push(
          `${locFor(key)}: \`${occ.raw}\` used in the ${key}: value but not declared in PIPELINE.md ## Variables`,
        );
      }
    }
    for (const near of scanNearMisses(text, fileLabel)) {
      errors.push(`${locFor(key)}: ${near.message}`);
    }
    return occs.length;
  };
  if (script !== null) sweep(script, 'script');
  if (command !== null && command.length > 0) {
    // argv[0] — the PROGRAM — is never substituted at runtime (T3b): ONE
    // error regardless of how many tokens it carries. Its names still count
    // as usage (the variable IS referenced — this error already flags the
    // reference; a contradictory L7 'unused' would only confuse) and its
    // near-misses lint like any other surface.
    let zeroCount = 0;
    if (mayContainPPText(command[0])) {
      const zeroOccs = scanOccurrences(command[0], fileLabel);
      zeroCount = zeroOccs.length;
      for (const occ of zeroOccs) usedNames.add(occ.name);
      if (zeroCount > 0) {
        errors.push(
          `${locFor('command')}: variable substitution is not allowed in the command program ` +
            `(argv[0] '${command[0]}') — write the executable literally and pass variables as arguments (T3b)`,
        );
      }
      for (const near of scanNearMisses(command[0], fileLabel)) {
        errors.push(`${locFor('command')}: ${near.message}`);
      }
    }
    let elCount = zeroCount;
    for (const el of command.slice(1)) elCount += sweep(el, 'command');
    if (commandRawValue !== null && mayContainPPText(commandRawValue)) {
      const rawCount = scanOccurrences(commandRawValue, fileLabel).length;
      if (rawCount > elCount) {
        warnings.push(
          `${locFor('command')}: a \${PP_*} token in the command: value is split apart by whitespace ` +
            `tokenization (an inline default containing spaces?) and will NOT substitute — ` +
            `use the array form or a manifest (default: ...) instead (E2)`,
        );
      }
    }
  }
}

export function computePlan(pipelineRoot: string, options: ComputePlanOptions = {}): Plan {
  const errors: string[] = [];
  const warnings: string[] = [];

  // PP_* variable declarations + the plan-time substitution lint sweep
  // (env-variables design). Populated below as PIPELINE.md and each step
  // file are parsed; a declaration-less, PP_-text-less pipeline leaves
  // `variableDecls`/`substitutionFiles` empty and the final sweep (§2b,
  // after the step-enumeration loop) is skipped entirely — E9 zero-change.
  let variableDecls: VariableDecl[] = [];
  const substitutionLineOffsets = new Map<string, number>();
  const substitutionFiles: Array<{ file: string; frontmatterRaw: string; body: string }> = [];
  /** Names referenced inside `command:`/`script:` values (the D5(c) surface
   *  sweep, lintScriptSurfaces) — they count as USAGE for L7. */
  const commandSurfaceUsed = new Set<string>();

  // 1. PIPELINE.md frontmatter (execution / isolation / default model).
  let execution = 'sequential';
  let isolation: Isolation = 'worktree';
  let runner: 'manager' | 'headless' = 'manager';
  let manifestModel: string | null = null;
  let manifestEffort: string | null = null;
  let manifestBody = '';
  let worktreeHookDir = '.claude/pipeline/.hooks';
  let submodules: string[] = [];
  let baseBranch = 'main';
  let finalize = false;
  let deleteBranches = true;
  const manifestPath = join(pipelineRoot, 'PIPELINE.md');
  if (existsSync(manifestPath)) {
    const manifestRaw = readFileSync(manifestPath, 'utf8');
    const { fields, body } = parseFrontmatter(manifestRaw);
    manifestBody = body;

    // `## Variables` declarations (04 §2) — always parsed (cheap, single pass)
    // so `plan.variables` is attached and L4 malformed-decl/L5 duplicate-decl
    // issues surface even for a pipeline with no occurrences anywhere. Line
    // numbers from parseVariablesSection are relative to `manifestBody`, so
    // fold with the manifest's own header-line offset (`alwaysOffset: true`).
    const parsedVariables = parseVariablesSection(manifestBody, 'PIPELINE.md');
    variableDecls = parsedVariables.decls;
    substitutionLineOffsets.set('PIPELINE.md', lineOffsetOf(manifestRaw, manifestBody));
    foldSubstitutionIssues(parsedVariables.issues, substitutionLineOffsets, true, errors, warnings);
    // Register PIPELINE.md for the plan-time occurrence/frontmatter sweep.
    // `false` (no command:/script: exemption): those keys don't exist on the
    // manifest, only on `type: script` steps (D5(c) is step-scoped). `force`
    // whenever the manifest declares ANY variables — even one referenced
    // nowhere — so validateRun always has at least PIPELINE.md as its
    // `fallbackFile` for the decl-level L7/L8 issues (never an empty file,
    // never a location-less message) instead of relying on some OTHER file
    // happening to also contain PP_-shaped text.
    registerSubstitutionFile(
      'PIPELINE.md',
      manifestRaw,
      manifestBody,
      false,
      substitutionLineOffsets,
      substitutionFiles,
      hasDeclarations(variableDecls),
    );

    const exec = typeof fields.execution === 'string' ? fields.execution.toLowerCase() : '';
    if (exec === 'parallel') execution = 'parallel';
    else if (exec && exec !== 'sequential')
      warnings.push(`PIPELINE.md: unknown execution '${exec}' — treating as sequential`);

    const iso = typeof fields.isolation === 'string' ? fields.isolation.toLowerCase() : '';
    if (iso === 'manual') isolation = 'manual';
    else if (iso === 'external') isolation = 'external';
    else if (iso && iso !== 'worktree')
      warnings.push(`PIPELINE.md: unknown isolation '${iso}' — treating as worktree`);

    const run = typeof fields.runner === 'string' ? fields.runner.toLowerCase() : '';
    if (run === 'headless') runner = 'headless';
    else if (run && run !== 'manager')
      warnings.push(`PIPELINE.md: unknown runner '${run}', using manager`);

    // Design-time lint: the manifest has a documented ~300-token cap — with a
    // target-family carve-out. A family HUB (a pipeline with a `targets/`
    // subfolder of sub-pipelines) legitimately carries routing tables and is
    // exempt; a family TARGET (a pipeline living under some `targets/` dir)
    // carries per-target submodule/context routing and gets the higher cap.
    const isFamilyHub = existsSync(join(pipelineRoot, 'targets'));
    const isFamilyTarget = /[\\/]targets[\\/]/.test(pipelineRoot.replace(/\\/g, '/') + '/');
    // D8 (REVISED): the `## Variables` section is excluded from the cap count
    // (precedent: the family-HUB exemption) — variable documentation
    // shouldn't compete with the manifest's ~300-token budget.
    const manifestTokens = Math.max(
      0,
      estimateTokens(manifestRaw) - Math.round(variablesSectionByteLength(manifestBody) / 4),
    );
    if (!isFamilyHub) {
      const cap = isFamilyTarget ? FAMILY_TARGET_TOKEN_CAP : MANIFEST_TOKEN_CAP;
      if (manifestTokens > cap)
        warnings.push(
          isFamilyTarget
            ? `PIPELINE.md is ~${manifestTokens} tokens (cap ~${FAMILY_TARGET_TOKEN_CAP} for a family target) — trim the manifest`
            : `PIPELINE.md is ~${manifestTokens} tokens (cap ~${MANIFEST_TOKEN_CAP}) — trim the manifest to the documented cap`,
        );
    }

    // Optional `worktree_hook_dir` override (string; default `.claude/pipeline/.hooks`).
    if (typeof fields.worktree_hook_dir === 'string' && fields.worktree_hook_dir.trim())
      worktreeHookDir = fields.worktree_hook_dir.trim();

    // Optional `submodules` (inline `[a, b]` or block list → string[]; default []).
    const subs = fields.submodules;
    if (Array.isArray(subs)) submodules = subs.slice();
    else if (typeof subs === 'string' && subs.trim()) submodules = [subs.trim()];

    // Optional `base_branch` override (string; default `main`) — mirrors the
    // other string fields (worktree_hook_dir): trimmed, blank keeps the default.
    if (typeof fields.base_branch === 'string' && fields.base_branch.trim())
      baseBranch = fields.base_branch.trim();

    // Optional `finalize: true` opt-in (bareword → the frontmatter reader yields
    // the STRING "true"; accept the usual truthy spellings). Default false.
    if (typeof fields.finalize === 'string') finalize = /^(true|yes|on|1)$/i.test(fields.finalize.trim());

    // Optional `delete_branches: false` opt-OUT (mirrors the `finalize:` parsing
    // but with the inverse default): only the explicit falsy spellings flip it —
    // absent/true/anything-else keeps the default true.
    if (typeof fields.delete_branches === 'string' && /^(false|no|off|0)$/i.test(fields.delete_branches.trim()))
      deleteBranches = false;

    const m = normalizeModel(fields.model);
    if (m.invalid) warnings.push(`PIPELINE.md: invalid model '${String(fields.model)}' — treating as inherit`);
    manifestModel = m.model;

    const ef = normalizeEffort(fields.effort);
    if (ef.invalid)
      warnings.push(
        `PIPELINE.md: invalid effort '${String(fields.effort)}' — treating as inherit (valid: low|medium|high|xhigh|max|inherit)`,
      );
    manifestEffort = ef.effort;
  }

  const defaultModel = options.defaultModel !== undefined ? options.defaultModel : manifestModel;
  const defaultEffort = options.defaultEffort !== undefined ? options.defaultEffort : manifestEffort;

  // Per-run step-model overrides: normalize values once (invalid → warn + drop).
  // A key whose value normalizes to null (`inherit`) FORCES the session default
  // for that step — key presence, not value truthiness, is what wins.
  const modelOverrides: Record<string, string | null> = {};
  for (const [id, raw] of Object.entries(options.modelOverrides ?? {})) {
    const m = normalizeModel(raw ?? undefined);
    if (m.invalid) {
      warnings.push(`--model ${id}=${String(raw)}: invalid model — ignoring this override`);
      continue;
    }
    modelOverrides[id] = m.model;
  }
  const hasOverride = (id: string) => Object.prototype.hasOwnProperty.call(modelOverrides, id);

  // Per-run step-effort overrides — same contract as model overrides.
  const effortOverrides: Record<string, string | null> = {};
  for (const [id, raw] of Object.entries(options.effortOverrides ?? {})) {
    const ef = normalizeEffort(raw ?? undefined);
    if (ef.invalid) {
      warnings.push(
        `--effort ${id}=${String(raw)}: invalid effort (valid: low|medium|high|xhigh|max|inherit) — ignoring this override`,
      );
      continue;
    }
    effortOverrides[id] = ef.effort;
  }
  const hasEffortOverride = (id: string) => Object.prototype.hasOwnProperty.call(effortOverrides, id);

  // 2. Enumerate iteration files.
  const stepsDir = join(pipelineRoot, 'steps');
  const files = listMarkdownFiles(stepsDir);
  if (files.length === 0) errors.push(`No iteration files found under ${stepsDir}`);

  const steps: PlanStep[] = [];
  /** Script, pipeline AND gate steps carry cross-step lints (`## Next` — all
   *  three advance mechanically, no agent reads it; `${steps…}` bindings —
   *  pipeline steps mirror the script `## Params` mechanism exactly, gates
   *  have none) that need the FINAL mode/graph — collect what the later pass
   *  needs here. */
  const boundSteps: {
    rel: string;
    step_id: string;
    body: string;
    kind: 'script' | 'pipeline' | 'gate';
    params: Record<string, ScriptParamSpec> | null;
  }[] = [];
  // Declared-name lookup for the D5(c) surface sweep (variableDecls is final
  // here — the manifest was parsed above).
  const declaredVarNames = new Set(variableDecls.map((d) => d.name));
  files.forEach((file, i) => {
    const raw = readFileSync(file, 'utf8');
    const { fields, body } = parseFrontmatter(raw);
    const rel = relative(stepsDir, file).split(sep).join('/');

    // Plan-time substitution lint bookkeeping (env-variables design): mirror
    // the stepRefs/envRefs lint pattern — every step file already loaded here
    // gets its body + non-exempt frontmatter registered for the sweep
    // (command:/script: keys exempted from L3 — D5(c), they are declared
    // substitution surfaces on a `type: script` step), gated by the
    // zero-change pre-filter (mayContainPPText) with no `force` — a step
    // with no PP_-shaped text anywhere contributes nothing either way.
    const stepFileLabel = `steps/${rel}`;
    registerSubstitutionFile(stepFileLabel, raw, body, true, substitutionLineOffsets, substitutionFiles);

    const stem = basename(file).replace(/\.md$/, '');
    const stepId =
      typeof fields.step_id === 'string' && fields.step_id.trim() ? fields.step_id.trim() : stem;
    const dependsRaw = fields['depends-on'];
    const dependsOn = Array.isArray(dependsRaw)
      ? dependsRaw
      : typeof dependsRaw === 'string' && dependsRaw.trim()
        ? [dependsRaw.trim()]
        : [];

    // Step kind (§2.1): absent ⇒ agent (absolute backward compat); unknown
    // values follow the warn-and-default idiom (normalizeModel style).
    // 'pipeline' (T3-09) = a composed child-pipeline reference; 'gate'
    // (T3-14) = a deterministic approval pause.
    let stepType: StepType = 'agent';
    if (fields.type !== undefined) {
      const t = Array.isArray(fields.type) ? null : fields.type.trim().toLowerCase();
      if (t === 'script') stepType = 'script';
      else if (t === 'pipeline') stepType = 'pipeline';
      else if (t === 'gate') stepType = 'gate';
      else if (t !== 'agent' && t !== '')
        warnings.push(`steps/${rel}: unknown type '${String(fields.type)}' — treating as agent`);
    }

    // model/effort are agent-spawn concepts. On a `type: script` (or `type:
    // gate` — T3-14) step they are meaningless (§2.1): warn when explicitly
    // present, resolve both to null, and skip the inheritance ladder entirely
    // (neither spawns an agent). `type: pipeline` steps keep the normal agent
    // ladder — representational for now (whether it seeds the child run's
    // default model is T3-10's call).
    let model: string | null = null;
    let effort: string | null = null;
    if (stepType === 'script' || stepType === 'gate') {
      const meaningless = ['model', 'effort', 'permission-mode'].filter(
        (k) => fields[k] !== undefined,
      );
      if (meaningless.length)
        warnings.push(
          `steps/${rel}: ${meaningless.join(', ')} ignored on a type: ${stepType} step (a ${stepType} spawns no agent)`,
        );
      // A per-run --model/--effort override targeting a script/gate step is
      // just as meaningless as the frontmatter keys above — and, unlike a
      // nonexistent step_id, it matches an enumerated step so the typo-lint
      // stays silent. Warn here (mirroring the frontmatter message) so it is
      // never swallowed.
      if (hasOverride(stepId) || hasEffortOverride(stepId))
        warnings.push(
          `steps/${rel}: --model/--effort override ignored on a 'type: ${stepType}' step (a ${stepType} spawns no agent)`,
        );
    } else {
      const m = normalizeModel(fields.model);
      if (m.invalid) warnings.push(`${stem}: invalid model '${String(fields.model)}' — treating as inherit`);
      const ef = normalizeEffort(fields.effort);
      if (ef.invalid)
        warnings.push(
          `${stem}: invalid effort '${String(fields.effort)}' — treating as inherit (valid: low|medium|high|xhigh|max|inherit)`,
        );
      // Highest → lowest: per-run override, step frontmatter, pipeline default.
      model = hasOverride(stepId) ? modelOverrides[stepId] : (m.model ?? defaultModel ?? null);
      effort = hasEffortOverride(stepId) ? effortOverrides[stepId] : (ef.effort ?? defaultEffort ?? null);
    }

    let scriptSpec: ScriptStepSpec | null = null;
    let pipelineSpec: PipelineStepSpec | null = null;
    let gateSpec: GateStepSpec | null = null;
    if (stepType === 'agent') {
      // Script-only frontmatter on an agent step is ignored (§2.1) — warn.
      const ignored = ['script', 'command', 'timeout', 'retries', 'on-failure'].filter(
        (k) => fields[k] !== undefined,
      );
      if (ignored.length)
        warnings.push(
          `steps/${rel}: script-step field(s) ${ignored.join(', ')} ignored on an agent step (add 'type: script' to use them)`,
        );
      // Same idiom for the composition reference key (T3-09).
      if (fields.pipeline !== undefined)
        warnings.push(
          `steps/${rel}: 'pipeline:' ignored on an agent step (add 'type: pipeline' to compose another pipeline)`,
        );
    } else if (stepType === 'pipeline') {
      // T3-09 composition — `type: pipeline` references ANOTHER pipeline to
      // run as a nested child. Script-only execution knobs are meaningless
      // here (the child pipeline owns its own timeouts/retries) — warn.
      const ignored = ['script', 'command', 'timeout', 'retries', 'on-failure'].filter(
        (k) => fields[k] !== undefined,
      );
      if (ignored.length)
        warnings.push(
          `steps/${rel}: script-step field(s) ${ignored.join(', ')} ignored on a type: pipeline step (the child pipeline owns its own execution)`,
        );

      // The `pipeline:` reference is REQUIRED; it must resolve to a pipeline
      // root (a dir holding PIPELINE.md) — see compose.ts for the candidate
      // bases (own root / parent dir / enclosing .claude/pipeline).
      const ref =
        typeof fields.pipeline === 'string' && fields.pipeline.trim()
          ? fields.pipeline.trim()
          : null;
      let resolvedRoot: string | null = null;
      if (ref === null) {
        errors.push(
          `steps/${rel}: type: pipeline requires a 'pipeline:' frontmatter reference (the name or relative path of another pipeline)`,
        );
      } else {
        const resolved = resolvePipelineRef(ref, pipelineRoot);
        if (resolved.root === null)
          errors.push(
            `steps/${rel}: pipeline reference '${ref}' does not resolve — no PIPELINE.md at any of: ${resolved.tried.join(', ')}`,
          );
        else resolvedRoot = resolved.root;
      }

      // `## Params` / `## Output` — the EXACT script-step mechanism (§3.1,
      // §3.4): same JSON-block declaration, same vocabulary, same lints.
      const params = extractSpecBlock(body, 'Params', `steps/${rel}`, errors);
      const output = extractSpecBlock(body, 'Output', `steps/${rel}`, errors);

      pipelineSpec = { pipeline: ref, resolved_root: resolvedRoot, params, output };
      boundSteps.push({ rel, step_id: stepId, body, kind: 'pipeline', params });
    } else if (stepType === 'gate') {
      // T3-14 approval gate — a deterministic PAUSE: the runtime emits a
      // needs_input question carrying an `approval:{required_role}` marker
      // and blocks until a sufficiently-privileged role answers
      // {decision, comment}. Execution knobs of the other step kinds are
      // meaningless here — warn-and-drop, the script/pipeline idiom.
      const ignored = ['script', 'command', 'timeout', 'retries', 'on-failure'].filter(
        (k) => fields[k] !== undefined,
      );
      if (ignored.length)
        warnings.push(
          `steps/${rel}: script-step field(s) ${ignored.join(', ')} ignored on a type: gate step (a gate executes nothing — it awaits an approval decision)`,
        );
      if (fields.pipeline !== undefined)
        warnings.push(
          `steps/${rel}: 'pipeline:' ignored on a type: gate step (add 'type: pipeline' to compose another pipeline)`,
        );

      // `required_role:` is REQUIRED (plan ERROR when missing/invalid — the
      // gate's whole meaning is WHO may answer it; a gate anyone could answer
      // must never reach a run). Flat frontmatter key, matching the parser's
      // flat vocabulary; the role set mirrors the protocol's
      // owner|admin|member|viewer.
      const roleRaw = fields['required_role'];
      let role = normalizeApprovalRole(roleRaw);
      if (roleRaw === undefined || (typeof roleRaw === 'string' && roleRaw.trim() === '')) {
        role = null;
        errors.push(
          `steps/${rel}: type: gate requires a 'required_role:' frontmatter key (one of: ${[...APPROVAL_ROLES].join('|')})`,
        );
      } else if (role === null) {
        errors.push(
          `steps/${rel}: invalid required_role '${String(roleRaw)}' (valid: ${[...APPROVAL_ROLES].join('|')})`,
        );
      }

      // The gate's PROMPT is the `## Message` section of the step body
      // (trimmed). Absent ⇒ warning; the runtime falls back to a default
      // prompt naming the step.
      const messageText = sectionText(body, 'Message');
      const message = messageText !== null && messageText.trim() !== '' ? messageText.trim() : null;
      if (message === null)
        warnings.push(
          `steps/${rel}: gate has no ## Message section — the approval question will use a default prompt`,
        );

      gateSpec = { required_role: role, message };
      // Gates advance mechanically like script/pipeline steps (no agent reads
      // `## Next`) — the §2.2 sequential-mode lint applies; no params.
      boundSteps.push({ rel, step_id: stepId, body, kind: 'gate', params: null });
    } else {
      // §2.1 — `script:` XOR `command:` (exactly one REQUIRED; plan ERROR otherwise).
      const script =
        typeof fields.script === 'string' && fields.script.trim() ? fields.script.trim() : null;
      let command: string[] | null = null;
      if (Array.isArray(fields.command)) {
        command = fields.command.filter((t) => t.length > 0);
      } else if (typeof fields.command === 'string' && fields.command.trim()) {
        // Whitespace-split argv template (same splitting rule as the drive
        // executor template; paths with spaces unsupported — documented).
        command = fields.command.trim().split(/\s+/);
      }
      if (command !== null && command.length === 0) command = null;
      if (script !== null && command !== null)
        errors.push(`steps/${rel}: 'script:' and 'command:' are mutually exclusive — declare exactly one`);
      else if (script === null && command === null)
        errors.push(`steps/${rel}: type: script requires exactly one of 'script:' or 'command:'`);

      let timeoutS = DEFAULT_SCRIPT_TIMEOUT_S;
      if (fields.timeout !== undefined) {
        const n = Array.isArray(fields.timeout) ? NaN : Number(fields.timeout.trim());
        if (Number.isFinite(n) && n > 0) timeoutS = n;
        else
          warnings.push(
            `steps/${rel}: invalid timeout '${String(fields.timeout)}' — using default ${DEFAULT_SCRIPT_TIMEOUT_S}s`,
          );
      }

      let retries = 0;
      if (fields.retries !== undefined) {
        const n = Array.isArray(fields.retries) ? NaN : Number(fields.retries.trim());
        if (Number.isInteger(n) && n >= 0) retries = n;
        else warnings.push(`steps/${rel}: invalid retries '${String(fields.retries)}' — using 0`);
      }

      let onFailure: OnFailurePolicy = 'halt';
      if (fields['on-failure'] !== undefined) {
        const v = Array.isArray(fields['on-failure'])
          ? null
          : fields['on-failure'].trim().toLowerCase();
        if (v === 'agent') onFailure = 'agent';
        else if (v !== 'halt' && v !== '')
          warnings.push(`steps/${rel}: unknown on-failure '${String(fields['on-failure'])}' — using halt`);
      }

      // §7 — deadline inversion: a manager-driven `pipeline next` call cannot
      // honor a timeout above MANAGER_SAFE_TIMEOUT_S (the 600s DEFAULT
      // included — declare a smaller timeout or run headless).
      if (runner === 'manager' && timeoutS > MANAGER_SAFE_TIMEOUT_S)
        warnings.push(
          `steps/${rel}: script timeout ${timeoutS}s exceeds the manager-safe ${MANAGER_SAFE_TIMEOUT_S}s — use runner: headless or split the step`,
        );

      // `## Params` / `## Output` JSON blocks (§3.1, §3.4).
      const params = extractSpecBlock(body, 'Params', `steps/${rel}`, errors);
      const output = extractSpecBlock(body, 'Output', `steps/${rel}`, errors);

      // D5(c) surface sweep (env-variables design, a4): command:/script:
      // values are substitution surfaces — L1/L2 lint them and count their
      // occurrences as usage for L7 (see lintScriptSurfaces).
      lintScriptSurfaces(
        stepFileLabel,
        raw,
        script,
        command,
        typeof fields.command === 'string' ? fields.command : null,
        declaredVarNames,
        commandSurfaceUsed,
        errors,
        warnings,
      );

      scriptSpec = { script, command, timeoutS, retries, onFailure, params, output };
      boundSteps.push({ rel, step_id: stepId, body, kind: 'script', params });
    }

    steps.push({
      index: i + 1,
      path: file,
      rel,
      step_id: stepId,
      model,
      effort,
      depends_on: dependsOn,
      type: stepType,
      script_spec: scriptSpec,
      pipeline_spec: pipelineSpec,
      gate_spec: gateSpec,
    });

    // Design-time lints (non-fatal, warnings only).
    const tokens = estimateTokens(raw);
    if (tokens > ITERATION_TOKEN_BUDGET)
      warnings.push(
        `steps/${rel} is ~${tokens} tokens (budget ~${ITERATION_TOKEN_BUDGET}) — consider splitting or extracting Steps to a script`,
      );
    // Script-extraction candidate lint is agent-only — a `type: script` step
    // IS the extraction already (its `## Steps` is one degradation line).
    if (stepType === 'agent') {
      const runLen = longestProceduralRun(stepsSectionLines(body));
      if (runLen >= PROCEDURAL_BLOCK_MIN_LINES)
        warnings.push(
          `steps/${rel} § Steps has a ~${runLen}-line procedural block — script-extraction candidate (see pipeline-script-creator)`,
        );
    }
  });

  // 2b. Plan-time substitution lint sweep (L1–L5, L7, L8, L9 — env-variables
  // design, doc 04 §4). Composes a1's validateRun over every step file +
  // PIPELINE.md the pass above already loaded (`substitutionFiles`), plus
  // the manifest declarations (`variableDecls`). `resolved`/`unresolvedNames`/
  // `unknownNames` are left empty here on purpose: resolving `--var`/env/
  // manifest defaults is a run-init concern (`commands/next.ts`, a3) that
  // computePlan has no CLI flags or environment to perform — passing []
  // means L6 `missing` and L10 `unknown-cli-var` never fire from this call
  // (by construction, since both loops iterate their respective name lists),
  // leaving exactly the plan-time set. Skipped entirely when there is
  // nothing to check (no declarations AND no file passed the PP_-ish
  // pre-filter) — the E9 zero-change guarantee.
  if (hasDeclarations(variableDecls) || substitutionFiles.length > 0) {
    const substitutionIssues = validateRun(variableDecls, {}, [], substitutionFiles, []).filter(
      // D5(c) surface sweep: a variable referenced ONLY inside a
      // command:/script: value IS used — validateRun cannot see those
      // surfaces (they live in frontmatter), so its L7 verdict is corrected
      // here from lintScriptSurfaces' usage set.
      (i) => !(i.kind === 'unused-decl' && i.name !== undefined && commandSurfaceUsed.has(i.name)),
    );
    foldSubstitutionIssues(substitutionIssues, substitutionLineOffsets, false, errors, warnings);
  }

  // Surface probable typos: an override key matching no enumerated step. Kept
  // in model_overrides regardless — a run entered via a target/hub family can
  // legitimately reach off-plan steps that the override targets.
  for (const id of Object.keys(modelOverrides)) {
    if (!steps.some((s) => s.step_id === id))
      warnings.push(`--model ${id}=…: no enumerated step has step_id '${id}' (still applies if that step joins the run off-plan)`);
  }
  for (const id of Object.keys(effortOverrides)) {
    if (!steps.some((s) => s.step_id === id))
      warnings.push(`--effort ${id}=…: no enumerated step has step_id '${id}' (still applies if that step joins the run off-plan)`);
  }

  // 3. Mode gate — parallel ONLY when PIPELINE.md opts in via execution:parallel.
  const anyDependsOn = steps.some((s) => s.depends_on.length > 0);
  const mode: PipelineMode = execution === 'parallel' ? 'parallel' : 'sequential';
  if (mode === 'sequential' && anyDependsOn) {
    warnings.push(
      "Steps declare 'depends-on' but PIPELINE.md does not set 'execution: parallel' — " +
        'running SEQUENTIAL and ignoring depends-on. Set execution: parallel to enable DAG mode.',
    );
  }

  // parallel + external is a contradiction: `external` is a run-level,
  // sequential-only mode. Degrade to `manual` (the existing "pipeline owns its
  // own isolation" escape hatch) and warn, so no downstream code sees
  // 'external' in a parallel run.
  if (mode === 'parallel' && isolation === 'external') {
    warnings.push(
      'PIPELINE.md: isolation: external is sequential-only — ignoring it under execution: parallel (treating as manual)',
    );
    isolation = 'manual';
  }

  // 4. DAG build + validation (parallel only).
  let layers: string[][] | null = null;
  if (mode === 'parallel') {
    const result = buildLayers(steps);
    layers = result.layers;
    errors.push(...result.errors);
  }

  // 5. Optional routing graph (Variant A) — parsed + validated from a
  //    `## Graph` JSON block in PIPELINE.md. Null when the pipeline has none.
  let graph: Graph | null = null;
  const g = extractGraph(manifestBody);
  if (g.error) errors.push(g.error);
  if (g.graph) {
    graph = g.graph;
    errors.push(...validateGraph(graph, new Set(steps.map((s) => s.step_id))));
  }

  // 6. Script/pipeline-step cross-lints (`## Next` §2.2, bindings §3.3, output
  //    shape §3.4) — they need the FINAL mode + graph, so they run after 3–5.
  //    Pipeline steps (T3-09) share the machinery verbatim: their `## Params`
  //    bindings mirror script steps, and their `## Next` is parsed just as
  //    mechanically at runtime (neither spawns an agent to decide flow).
  if (boundSteps.length) {
    const isGraphMode = graph !== null;

    // Topological-ancestor lookup for `${steps.x…}` bindings. Graph mode skips
    // the static check entirely — order is dynamic there; runtime binding
    // resolution errors cover it (§3.3).
    let ancestorsOf: ((stepId: string) => Set<string>) | null = null;
    if (!isGraphMode) {
      if (mode === 'sequential') {
        // Sequential: every EARLIER enumerated step is an ancestor.
        const before = new Map<string, Set<string>>();
        const seen = new Set<string>();
        for (const s of steps) {
          before.set(s.step_id, new Set(seen));
          seen.add(s.step_id);
        }
        ancestorsOf = (id) => before.get(id) ?? new Set();
      } else {
        // DAG: transitive `depends-on` ancestors under the effective-deps rule.
        const sets = dagAncestorSets(steps);
        ancestorsOf = (id) => sets.get(id) ?? new Set();
      }
    }

    const byId = new Map(steps.map((s) => [s.step_id, s] as const));

    for (const sc of boundSteps) {
      // §2.2 — a sequential-mode script (or pipeline) step's `## Next` is
      // parsed MECHANICALLY at runtime (§5.2 — no agent reads it), so it must
      // be exactly one absolute path (an optional leading `- ` bullet and one
      // backtick wrap are tolerated — the SHARED normalizeNextLine grammar, so
      // anything lint-clean here is runtime-parseable) or the literal
      // `Pipeline complete.`. Graph mode routes via flags and DAG mode via
      // layers — both skip this.
      if (mode === 'sequential' && !isGraphMode) {
        const nextText = sectionText(sc.body, 'Next');
        const items = (nextText ?? '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l !== '')
          .map((l) => normalizeNextLine(l));
        const ok =
          items.length === 1 &&
          (items[0] === 'Pipeline complete.' || isAbsoluteNextPath(items[0]));
        if (!ok)
          errors.push(
            `steps/${sc.rel}: ## Next of a sequential ${sc.kind} step must be exactly one absolute path or 'Pipeline complete.' — the CLI parses it mechanically (conditional flow belongs to graph mode)`,
          );
      }

      // §3.3 binding lints over every `from` template in `## Params`.
      for (const [name, paramSpec] of Object.entries(sc.params ?? {})) {
        const from =
          paramSpec !== null && typeof paramSpec === 'object' && !Array.isArray(paramSpec)
            ? paramSpec.from
            : undefined;
        if (typeof from !== 'string') continue;
        const label = `steps/${sc.rel} ## Params '${name}'`;

        // Secret-looking `${env.NAME}` ⇒ WARNING (§3.3/§11).
        for (const envName of envRefs(from)) {
          if (SECRET_ENV_PATTERN.test(envName))
            warnings.push(
              `${label}: \${env.${envName}} looks like a secret — secrets never travel through params (§11); read it from the environment inside the script instead`,
            );
        }

        for (const ref of stepRefs(from)) {
          // §3.2 — a `${steps.x…}` whose shape is not `.output.<path>` (bare
          // `${steps.foo}` or `${steps.foo.output}`) is lint-clean here but
          // runtime resolveRef hard-fails it as 'invalid' on every run — catch
          // it now with the same (shared) message, and skip the ancestor/field
          // checks (they don't apply to a malformed reference).
          if (ref.shapeError) {
            errors.push(`${label}: ${ref.shapeError}`);
            continue;
          }
          // `${steps.x…}` where x is not a topological ancestor ⇒ ERROR.
          if (ancestorsOf && !ancestorsOf(sc.step_id).has(ref.stepId))
            errors.push(
              `${label}: \${steps.${ref.stepId}…} does not reference a topological ancestor of '${sc.step_id}'`,
            );
          // §3.4 — field-check against the producer's DECLARED ## Output
          // (script AND pipeline producers share the vocabulary); producers
          // without the block get runtime-only checking. Use Object.hasOwn —
          // `in` would let inherited names ('toString', 'constructor') pass
          // though the producer never declared them.
          const producer = byId.get(ref.stepId);
          const declared = producer?.script_spec?.output ?? producer?.pipeline_spec?.output ?? null;
          if (ref.outputField !== null && declared && !Object.hasOwn(declared, ref.outputField))
            errors.push(
              `${label}: step '${ref.stepId}' declares ## Output without field '${ref.outputField}'`,
            );
        }
      }
    }
  }

  // 7. Composition lint (T3-09) — the cross-PIPELINE reference graph reachable
  //    through `type: pipeline` steps must be a DAG within the depth cap.
  //    Per-step reference errors (missing/unresolvable `pipeline:`) were
  //    already pushed in the enumeration pass; only resolved references become
  //    graph edges here. Pipelines without a `type: pipeline` step skip this
  //    entirely — existing non-composed pipelines lint exactly as before.
  const compositionEdges: CompositionEdge[] = steps.flatMap((s) =>
    s.type === 'pipeline' && s.pipeline_spec?.resolved_root
      ? [{ rel: s.rel, root: s.pipeline_spec.resolved_root }]
      : [],
  );
  if (compositionEdges.length) {
    let maxDepth: number | undefined = options.maxCompositionDepth;
    if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 1)) {
      warnings.push(
        `maxCompositionDepth ${String(maxDepth)} is invalid (positive integer required) — using the default ${MAX_COMPOSITION_DEPTH}`,
      );
      maxDepth = undefined;
    }
    errors.push(
      ...lintComposition(pipelineRoot, compositionEdges, {
        ...(maxDepth === undefined ? {} : { maxDepth }),
      }),
    );
  }

  return {
    mode,
    isolation,
    runner,
    default_model: defaultModel ?? null,
    default_effort: defaultEffort ?? null,
    steps,
    layers,
    graph,
    variables: variableDecls,
    model_overrides: modelOverrides,
    effort_overrides: effortOverrides,
    errors,
    warnings,
    worktree_hook_dir: worktreeHookDir,
    submodules,
    base_branch: baseBranch,
    finalize,
    delete_branches: deleteBranches,
  };
}
