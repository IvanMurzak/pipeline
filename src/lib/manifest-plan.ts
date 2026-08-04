// planFromManifest — the bridge from the v2 manifest to the engine's Plan.
//
// `computePlan` (lib/plan.ts) builds a Plan by walking a v1 pipeline: PIPELINE.md
// frontmatter, every `steps/**/*.md` frontmatter, a `## Graph` section, and the
// filename order. This module builds the SAME Plan from a single `pipeline.yml`.
//
// The engine downstream is untouched. That is the point: the manifest changes
// where a pipeline's definition comes from, not what the engine does with it —
// so the two sources must produce plans that dispatch identically, and the
// three local pipelines are the fixture that proves it.
//
// TRANSLATION, not re-interpretation. Where v1 and v2 name the same thing
// differently, the mapping is written down here once, with the reason:
//
//   * `isolation:` — v2's axis is SCOPE (`none`/`step`/`run`); v1's three values
//     named three different axes and two were inert in sequential mode. The
//     mapping to what the engine already implements is none→manual (no
//     worktree), step→worktree (one per step, parallel layers), run→external
//     (one per run, provisioned and torn down around the whole chain).
//   * `params:`/`args:`/`output:` — v1 declared these as a fenced JSON block
//     under `## Params` in the step's markdown. Same vocabulary, same frozen
//     `ScriptParamSpec` type, same lints; only the location moved.
//   * `PlanStep.step_id` carries the manifest's `name:`. The field keeps its v1
//     spelling for now — the engine, its persisted state and the daemon's HTTP
//     surfaces all still say `step_id`, and they move together, later.
//
// Two v1 features are NOT expressible in a v2 manifest yet, and a pipeline
// using them cannot be migrated until they are. Both are recorded rather than
// silently dropped:
//
//   * a script step's `command:` (inline argv instead of a script file), and
//   * a `${PP_*}` variable declared `(required)` — `vars:` carries defaults
//     only, so a v2 manifest cannot demand an operator-supplied value.

import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { resolvePipelineRef, type PipelineStepSpec } from './compose';
import type { GateStepSpec } from './gate';
import { normalizeApprovalRole } from './gate';
import {
  buildLayers,
  effectiveNeeds,
  resolveBody,
  type BodyEntry,
  type Manifest,
  type ManifestStep,
} from './manifest';
import { normalizeEffort, normalizeModel } from './model';
// TYPE-ONLY on purpose: lib/plan.ts imports this module to dispatch to it, so a
// value import here would close the cycle.
import type { ComputePlanOptions, Isolation, Plan, PlanStep } from './plan';
import {
  DEFAULT_SCRIPT_TIMEOUT_S,
  envRefs,
  MANAGER_SAFE_TIMEOUT_S,
  SECRET_ENV_PATTERN,
  stepRefs,
  type ScriptStepSpec,
} from './script-types';
import type { VariableDecl } from './substitution';

/** v2's isolation SCOPE → the mechanism the engine already implements.
 *  See the header for why the two vocabularies differ at all. */
const ISOLATION_BY_SCOPE = {
  none: 'manual',
  step: 'worktree',
  run: 'external',
} as const satisfies Record<string, Isolation>;

/** Where the engine's default worktree hooks live, relative to the project
 *  root. v1 made this a `worktree_hook_dir:` frontmatter key; no v2 manifest
 *  has needed to move it, so it is a constant until one does. */
const DEFAULT_WORKTREE_HOOK_DIR = '.pipeline/.hooks';

export interface ManifestPlanOptions extends ComputePlanOptions {
  /** Resolve a `type: pipeline` step's reference to a child pipeline root.
   *  Injected so the translation can be exercised without a real tree; the
   *  default is the same on-disk resolver `computePlan` uses. */
  resolvePipeline?: (ref: string, fromRoot: string) => { root: string | null; tried: string[] };
}

/**
 * Translate a parsed `pipeline.yml` into the engine's Plan.
 *
 * `manifest.errors` flow through onto `Plan.errors`: a manifest that failed to
 * parse must halt the run, and the caller decides that by reading one list, not
 * two. Translation adds its own errors for the things only a Plan can check
 * (an unresolvable child pipeline, a gate whose role survived parsing but not
 * normalization).
 *
 * @param pipelineRoot absolute path of the directory holding `pipeline.yml`.
 */
export function planFromManifest(
  manifest: Manifest,
  pipelineRoot: string,
  options: ManifestPlanOptions = {},
): Plan {
  const errors = [...manifest.errors];
  const warnings = [...manifest.warnings];

  // Per-run overrides: normalize once, invalid → warn and drop, key PRESENCE
  // (not value truthiness) wins so an explicit `inherit` forces the session
  // default. Identical contract to computePlan's, deliberately.
  const modelOverrides: Record<string, string | null> = {};
  for (const [id, raw] of Object.entries(options.modelOverrides ?? {})) {
    const m = normalizeModel(raw ?? undefined);
    if (m.invalid) {
      warnings.push(`--model ${id}=${String(raw)}: invalid model — ignoring this override`);
      continue;
    }
    modelOverrides[id] = m.model;
  }
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
  const has = (map: Record<string, unknown>, id: string): boolean =>
    Object.prototype.hasOwnProperty.call(map, id);

  const defaultModel =
    options.defaultModel !== undefined ? options.defaultModel : manifest.defaults.model;
  const defaultEffort =
    options.defaultEffort !== undefined ? options.defaultEffort : manifest.defaults.effort;

  const needs = effectiveNeeds(manifest.steps);
  const resolveRef = options.resolvePipeline ?? resolvePipelineRef;

  const steps: PlanStep[] = manifest.steps.map((s, i) => {
    // Resolved with NO run flags, so a conditional include is left out and a
    // `oneof` takes its default branch. That is the right answer for a plan —
    // a plan is computed before a run has flags — and it only matters for the
    // first-body label below, which no longer exists once the engine keys on
    // the name and the body is composed per dispatch.
    const bodyPaths = resolveBody(s).map((p) => absolutize(p, pipelineRoot));
    return {
      index: i + 1,
      path: dispatchPath(s, bodyPaths, pipelineRoot),
      rel: relLabel(s, bodyPaths, pipelineRoot),
      step_id: s.name,
      model: has(modelOverrides, s.name)
        ? modelOverrides[s.name]
        : (normalizeStepModel(s, warnings) ?? defaultModel ?? null),
      effort: has(effortOverrides, s.name)
        ? effortOverrides[s.name]
        : (normalizeStepEffort(s, warnings) ?? defaultEffort ?? null),
      depends_on: needs.get(s.name) ?? [],
      type: s.type,
      script_spec: s.type === 'script' ? scriptSpec(s, warnings) : null,
      pipeline_spec: s.type === 'pipeline' ? pipelineSpec(s, pipelineRoot, resolveRef, errors) : null,
      gate_spec: s.type === 'gate' ? gateSpec(s) : null,
      // Agent-step retry budget (a script step's own budget lives on its spec).
      retries: s.type === 'agent' ? (s.retries ?? 0) : 0,
      // The DECLARATION, absolutized — conditions are evaluated per dispatch
      // against the run's flags, not here (see PlanStep.body).
      body: absolutizeBody(s.body, pipelineRoot),
    };
  });

  // A manifest declares its dependency graph unconditionally; `execution:` only
  // says how much of it may run at once. The engine still reads `layers` as
  // "parallel dispatch", so a sequential run carries none — same plan shape v1
  // produced, so `pickMode` keeps choosing the same mode.
  const layers = manifest.execution === 'parallel' ? buildLayers(manifest.steps).layers : null;

  // A script whose timeout exceeds what a manager-driven `pipeline next` call
  // can honor would be killed by the outer Bash ceiling instead of by the CLI,
  // losing its failure record. v2 has no `runner:` key yet, so every manifest
  // is manager-driven and the lint always applies.
  for (const s of steps) {
    if (s.script_spec && s.script_spec.timeoutS > MANAGER_SAFE_TIMEOUT_S) {
      warnings.push(
        `step '${s.step_id}': script timeout ${s.script_spec.timeoutS}s exceeds the manager-safe ${MANAGER_SAFE_TIMEOUT_S}s — split the step`,
      );
    }
  }

  lintBindings(manifest, steps, errors, warnings);

  return {
    mode: manifest.execution,
    isolation: ISOLATION_BY_SCOPE[manifest.isolation],
    runner: 'manager',
    default_model: defaultModel ?? null,
    default_effort: defaultEffort ?? null,
    steps,
    // The manifest declares the order, so nothing downstream has to report it.
    advance: 'manifest',
    layers,
    graph: manifest.flow,
    variables: variableDecls(manifest),
    model_overrides: modelOverrides,
    effort_overrides: effortOverrides,
    errors,
    warnings,
    worktree_hook_dir: DEFAULT_WORKTREE_HOOK_DIR,
    submodules: manifest.submodules,
    base_branch: manifest.base_branch,
    // Neither flag has a v2 key yet. `finalize` also has a second, hook-presence
    // trigger the `next` command owns, so a pipeline with a `worktree-finalize`
    // hook still finalizes; `delete_branches` keeps its v1 default.
    finalize: false,
    delete_branches: true,
  };
}

// ---------------------------------------------------------------------------
// Binding lints
// ---------------------------------------------------------------------------

/**
 * The `${steps.…}` / `${env.…}` checks the v1 walk ran over `## Params`, run
 * here over the manifest's `params:`/`args:` instead.
 *
 * Not optional polish: without them a typo'd binding is only discovered when
 * the step actually dispatches — after everything before it has already run and
 * possibly already written to a branch. The rules and the wording are the v1
 * ones on purpose; a lint that reads differently in the two formats is one more
 * thing that can disagree.
 */
function lintBindings(
  manifest: Manifest,
  steps: PlanStep[],
  errors: string[],
  warnings: string[],
): void {
  // Graph mode routes on flags, so "runs before" is dynamic and the static
  // ancestor check cannot mean anything — runtime resolution covers it there.
  const ancestors = manifest.flow === null ? ancestorSets(manifest) : null;
  const byName = new Map(steps.map((s) => [s.step_id, s] as const));

  for (const step of steps) {
    const declared = step.script_spec?.params ?? step.pipeline_spec?.params ?? null;
    for (const [name, spec] of Object.entries(declared ?? {})) {
      const from = spec?.from;
      if (typeof from !== 'string') continue;
      const label = `step '${step.step_id}' param '${name}'`;

      for (const envName of envRefs(from)) {
        if (SECRET_ENV_PATTERN.test(envName)) {
          warnings.push(
            `${label}: \${env.${envName}} looks like a secret — secrets never travel through params; read it from the environment inside the script instead`,
          );
        }
      }

      for (const ref of stepRefs(from)) {
        // A malformed reference is rejected at runtime with this exact message,
        // so the plan rejects it with the same one — and skips the checks below,
        // which do not apply to a reference that never resolves.
        if (ref.shapeError) {
          errors.push(`${label}: ${ref.shapeError}`);
          continue;
        }
        if (!byName.has(ref.stepId)) {
          errors.push(`${label}: \${steps.${ref.stepId}…} names no step in this pipeline`);
          continue;
        }
        if (ancestors && !(ancestors.get(step.step_id)?.has(ref.stepId) ?? false)) {
          errors.push(
            `${label}: \${steps.${ref.stepId}…} does not run before '${step.step_id}' — it can never have produced an output to bind`,
          );
          continue;
        }
        const producer = byName.get(ref.stepId);
        const output = producer?.script_spec?.output ?? producer?.pipeline_spec?.output ?? null;
        if (ref.outputField !== null && output && !Object.hasOwn(output, ref.outputField)) {
          errors.push(
            `${label}: step '${ref.stepId}' declares an output without field '${ref.outputField}'`,
          );
        }
      }
    }
  }
}

/** Transitive `needs:` ancestors per step. A sequential pipeline gets these for
 *  free — an absent `needs` inherits the previous step — so one closure serves
 *  both execution modes instead of the two rules v1 needed. */
function ancestorSets(manifest: Manifest): Map<string, Set<string>> {
  const deps = effectiveNeeds(manifest.steps);
  const sets = new Map<string, Set<string>>();
  // Declaration order is a valid topological order only when the manifest is
  // acyclic — and a cycle is already a manifest ERROR, so the plan halts
  // regardless of what this computes.
  for (const step of manifest.steps) {
    const acc = new Set<string>();
    for (const d of deps.get(step.name) ?? []) {
      acc.add(d);
      for (const t of sets.get(d) ?? []) acc.add(t);
    }
    sets.set(step.name, acc);
  }
  return sets;
}

// ---------------------------------------------------------------------------
// Step-level translation
// ---------------------------------------------------------------------------

function absolutize(p: string, pipelineRoot: string): string {
  return isAbsolute(p) ? p : join(pipelineRoot, p);
}

/** The body declaration with every `use:` resolved against the pipeline root,
 *  so the engine can filter it by flags without knowing where the pipeline
 *  lives. Structure and order are untouched — only the paths change. */
function absolutizeBody(body: BodyEntry[], pipelineRoot: string): BodyEntry[] {
  return body.map((entry) =>
    entry.kind === 'include'
      ? { ...entry, use: absolutize(entry.use, pipelineRoot) }
      : {
          kind: 'oneof' as const,
          options: entry.options.map((o) => ({ ...o, use: absolutize(o.use, pipelineRoot) })),
        },
  );
}

/**
 * The path this step is LABELLED by — in events, in `.stats`, in the iteration
 * tree, and wherever a `--start` path still round-trips.
 *
 * v1 had exactly one answer: the step IS a file. v2 has none. A step composes
 * zero, one, or several bodies, so:
 *
 *   * exactly one body ⇒ that file, which is v1's answer and keeps a
 *     single-body step's dispatch byte-identical;
 *   * anything else ⇒ a synthetic `steps/<name>.md`, derived from the step's
 *     own identity.
 *
 * The synthetic label is deliberately NOT the first fragment: a shared
 * `_shared/preamble.md` is first in several steps, so labelling by it would give
 * them all the same name in every consumer that keys on the path. It is also
 * where the COMPOSED document is written inside the run's shadow tree — under
 * `steps/`, at the depth a step body normally sits, so the relative references
 * inside it resolve exactly as an ordinary step's do.
 */
function dispatchPath(step: ManifestStep, bodyPaths: string[], pipelineRoot: string): string {
  return bodyPaths.length === 1 ? bodyPaths[0] : join(pipelineRoot, 'steps', `${step.name}.md`);
}

/** The iteration tree's row key: the path under `steps/` when the body lives
 *  there (v1's meaning), else the pipeline-root-relative path, POSIX-separated
 *  either way so a plan reads the same on Windows and Linux. */
function relLabel(step: ManifestStep, bodyPaths: string[], pipelineRoot: string): string {
  if (bodyPaths.length !== 1) return `${step.name}.md`;
  const fromRoot = relative(pipelineRoot, bodyPaths[0]).split(/[\\/]/).join('/');
  return fromRoot.startsWith('steps/') ? fromRoot.slice('steps/'.length) : fromRoot;
}

function normalizeStepModel(step: ManifestStep, warnings: string[]): string | null {
  if (step.model === null) return null;
  const m = normalizeModel(step.model);
  if (m.invalid) {
    warnings.push(`step '${step.name}': invalid model '${step.model}' — inheriting instead`);
    return null;
  }
  return m.model;
}

function normalizeStepEffort(step: ManifestStep, warnings: string[]): string | null {
  if (step.effort === null) return null;
  const ef = normalizeEffort(step.effort);
  if (ef.invalid) {
    warnings.push(
      `step '${step.name}': invalid effort '${step.effort}' (valid: low|medium|high|xhigh|max) — inheriting instead`,
    );
    return null;
  }
  return ef.effort;
}

/** v1 read these off the step's frontmatter and its `## Params`/`## Output`
 *  blocks; v2 reads them off the manifest entry. `command:` has no v2 spelling
 *  yet (see the header), so a manifest-built script step always runs a file. */
function scriptSpec(step: ManifestStep, warnings: string[]): ScriptStepSpec {
  let timeoutS = DEFAULT_SCRIPT_TIMEOUT_S;
  if (step.timeout !== null) {
    if (step.timeout > 0) timeoutS = step.timeout;
    else
      warnings.push(
        `step '${step.name}': invalid timeout ${step.timeout} — using the default ${DEFAULT_SCRIPT_TIMEOUT_S}s`,
      );
  }
  let retries = 0;
  if (step.retries !== null) {
    if (Number.isInteger(step.retries) && step.retries >= 0) retries = step.retries;
    else warnings.push(`step '${step.name}': invalid retries ${step.retries} — using 0`);
  }
  return {
    script: step.script,
    command: null,
    timeoutS,
    retries,
    onFailure: step.on_failure ?? 'halt',
    params: step.params,
    output: step.output,
  };
}

function pipelineSpec(
  step: ManifestStep,
  pipelineRoot: string,
  resolveRef: NonNullable<ManifestPlanOptions['resolvePipeline']>,
  errors: string[],
): PipelineStepSpec {
  let resolvedRoot: string | null = null;
  if (step.pipeline !== null) {
    const resolved = resolveRef(step.pipeline, pipelineRoot);
    if (resolved.root === null) {
      errors.push(
        `step '${step.name}': pipeline reference '${step.pipeline}' does not resolve — nothing at any of: ${resolved.tried.join(', ')}`,
      );
    } else {
      resolvedRoot = resolved.root;
    }
  }
  return {
    pipeline: step.pipeline,
    resolved_root: resolvedRoot,
    params: step.args,
    output: step.output,
  };
}

/** The role already passed the manifest's enum check; re-normalizing here keeps
 *  ONE construction point for the value the runtime compares against. */
function gateSpec(step: ManifestStep): GateStepSpec {
  return {
    required_role: normalizeApprovalRole(step.required_role),
    message: step.message,
  };
}

/**
 * `vars:` → the engine's variable declarations.
 *
 * v1 parsed a `## Variables` section that could mark a variable `(required)`.
 * A v2 `vars:` entry is a name→default mapping, so every declaration it can
 * express is optional-with-a-default. Rather than fake a `required` flag the
 * manifest cannot carry, this reports exactly what was declared — and the
 * header records the gap.
 */
function variableDecls(manifest: Manifest): VariableDecl[] {
  return Object.entries(manifest.vars).map(([name, value]) => ({
    name,
    description: '',
    required: false,
    default: value,
  }));
}

/** Whether a directory holds a v2 manifest — the check `computePlan` uses to
 *  decide which builder to run. Kept beside the translation so the filename and
 *  the resolution rule live in one place. */
export function hasManifest(pipelineRoot: string, filename: string): boolean {
  return existsSync(join(pipelineRoot, filename));
}
