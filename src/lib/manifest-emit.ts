// Generate a v2 `pipeline.yml` from a v1 pipeline's computed Plan.
//
// The inverse of lib/manifest-plan.ts, and deliberately written against the
// PLAN rather than the source files: the plan is what the v1 walk actually
// decided after reading PIPELINE.md, every step's frontmatter, the `## Graph`
// section and the filename order — so emitting from it is the only way to be
// sure the manifest says what the pipeline already does, rather than what its
// files appear to say.
//
// That also makes the migration checkable: feed the emitted YAML back through
// `parseManifest` + `planFromManifest` and the two plans must agree. The
// command layer runs exactly that gate before writing anything.
//
// PURE — no filesystem, no environment. It emits text.
//
// WHAT IT WILL NOT DO. A v1 pipeline can express three things a v2 manifest
// cannot, and this module REPORTS them instead of quietly dropping them, which
// would produce a manifest that runs a different pipeline:
//
//   * a script step's inline `command:` (v2 has only `script:`),
//   * a `${PP_*}` variable declared `(required)` (`vars:` carries defaults),
//   * `runner: headless`, and the external-worktree flags `finalize:` /
//     `delete_branches:` / `worktree_hook_dir:`.

import { MANIFEST_SCHEMA, type Execution, type Isolation as ManifestIsolation } from './manifest';
import type { Isolation, Plan, PlanStep } from './plan';
import type { ScriptParamSpec } from './script-types';

/** The engine's isolation MECHANISM back to v2's scope axis — the inverse of
 *  manifest-plan.ts's ISOLATION_BY_SCOPE, kept beside it in spirit so the two
 *  cannot disagree about which of v1's three values meant what. */
const SCOPE_BY_ISOLATION: Record<Isolation, ManifestIsolation> = {
  manual: 'none',
  worktree: 'step',
  external: 'run',
};

export interface EmitManifestInput {
  /** The v1 plan — what the pipeline already does. */
  plan: Plan;
  /** `name:` for the manifest; conventionally the pipeline folder's basename. */
  pipelineName: string;
  /** Pipeline-root-relative body path per step, keyed by the step's plan
   *  `step_id`. The command layer computes these (it owns the filesystem). */
  bodyRelByStepId: Record<string, string>;
  /** Optional one-liner for `description:`. */
  description?: string | null;
}

export interface StepRename {
  /** The v1 step id — an explicit `step_id:` or the filename stem. */
  from: string;
  /** The v2 `name:`. */
  to: string;
}

export interface EmitManifestResult {
  yaml: string;
  /** Every step, old id → new name (unchanged ones included, so the printed
   *  map is the complete correspondence rather than only the surprises). */
  renames: StepRename[];
  /** What the manifest could not carry. Non-empty ⇒ the caller must not treat
   *  the migration as faithful. */
  unsupported: string[];
}

/** Strip a v1 ordering prefix: `01-implement` → `implement`. The prefix encoded
 *  order, which the manifest's step list now carries, so keeping it would leave
 *  every step named after a fact that is no longer true. */
function preferredName(stepId: string): string {
  const stripped = stepId.replace(/^\d+[-_]/, '');
  return stripped === '' ? stepId : stripped;
}

/** New names for every step: the prefix-stripped form where that stays unique,
 *  the original where it would collide (two steps really can be `01-build` and
 *  `02-build`, and silently merging them would be far worse than a clumsy name). */
function assignNames(steps: PlanStep[]): StepRename[] {
  const wanted = steps.map((s) => preferredName(s.step_id));
  const counts = new Map<string, number>();
  for (const n of wanted) counts.set(n, (counts.get(n) ?? 0) + 1);
  return steps.map((s, i) => ({
    from: s.step_id,
    to: (counts.get(wanted[i]) ?? 0) > 1 ? s.step_id : wanted[i],
  }));
}

// ---------------------------------------------------------------------------
// YAML emission
// ---------------------------------------------------------------------------

/** A plain YAML scalar where that is unambiguous, a quoted one otherwise.
 *  Deliberately conservative: anything with structural characters, leading or
 *  trailing space, or a shape YAML would read as a number/bool/null is quoted. */
function scalar(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value);
  const v = value;
  const safe =
    v !== '' &&
    v === v.trim() &&
    !/[:#\-?,[\]{}&*!|>'"%@`\n\t]/.test(v.slice(0, 1)) &&
    !/[:#\n\t]/.test(v) &&
    !/^(?:true|false|null|yes|no|on|off|~)$/i.test(v) &&
    !/^[+-]?(?:\d|\.\d)/.test(v);
  return safe ? v : JSON.stringify(v);
}

/** One `key: value` line, or nothing when the value is absent. */
function line(indent: string, key: string, value: string | number | boolean | null | undefined): string[] {
  return value === null || value === undefined ? [] : [`${indent}${key}: ${scalar(value)}`];
}

/** A `## Params`-vocabulary block as nested YAML. Field order is fixed
 *  (type, required, enum, default, value, from, description) so a re-emitted
 *  manifest diffs cleanly against the last one. */
function paramBlock(indent: string, key: string, specs: Record<string, ScriptParamSpec> | null): string[] {
  if (!specs || Object.keys(specs).length === 0) return [];
  const out = [`${indent}${key}:`];
  for (const [name, raw] of Object.entries(specs)) {
    const spec = raw as ScriptParamSpec & Record<string, unknown>;
    out.push(`${indent}  ${scalar(name)}:`);
    out.push(...line(`${indent}    `, 'type', spec.type));
    out.push(...line(`${indent}    `, 'required', spec.required));
    if (Array.isArray(spec.enum)) {
      out.push(`${indent}    enum: [${spec.enum.map((e) => scalar(e as string | number)).join(', ')}]`);
    }
    for (const k of ['default', 'value'] as const) {
      if (spec[k] !== undefined) out.push(`${indent}    ${k}: ${JSON.stringify(spec[k])}`);
    }
    out.push(...line(`${indent}    `, 'from', spec.from));
    out.push(...line(`${indent}    `, 'description', spec.description));
  }
  return out;
}

const HEADER = [
  '# v2 manifest, generated by `pipeline migrate --to-manifest`.',
  '#',
  '# Everything about how this pipeline runs is declared here — nothing is',
  '# inferred from a filename, a frontmatter block, or a section being present.',
  '# A STEP IS NOT A FILE: it is an entry below, identified by its `name:`. The',
  '# markdown under `body:` is only the prose it reads.',
  '#',
  '# Read it before the first run. Three things migration cannot decide for you:',
  '#   * `needs:` is absent on every step, which means "the one before it" —',
  '#     right for a chain, wrong if two steps could run at once.',
  '#   * the `## Next` sections in the step files are now DEAD. The manifest',
  '#     decides the order; delete them.',
  '#   * `self_improve:` defaults to true. Freeze the steps whose job is to',
  '#     catch a run that lied about succeeding.',
];

/**
 * Emit a v2 manifest for `input.plan`.
 *
 * Values equal to what the manifest would default to are OMITTED — a migration
 * whose output is mostly noise does not get read, and the parser's defaults are
 * the same ones documented in the schema. The exceptions are `execution:` and
 * `isolation:`, which are always written: they decide how much runs at once and
 * where, and a reader should never have to remember a default to know that.
 */
export function emitManifest(input: EmitManifestInput): EmitManifestResult {
  const { plan } = input;
  const renames = assignNames(plan.steps);
  const nameOf = new Map(renames.map((r) => [r.from, r.to] as const));
  const unsupported: string[] = [];

  if (plan.runner === 'headless') {
    unsupported.push("`runner: headless` — a v2 manifest has no runner key; every manifest run is manager-driven");
  }
  if (plan.finalize) {
    unsupported.push(
      '`finalize: true` — no v2 key yet. A `worktree-finalize.*` hook in the hook dir still opts the run in, so check one is present',
    );
  }
  if (!plan.delete_branches) {
    unsupported.push('`delete_branches: false` — no v2 key yet; a completed run will delete its branch');
  }
  if (plan.worktree_hook_dir !== '.pipeline/.hooks') {
    unsupported.push(`\`worktree_hook_dir: ${plan.worktree_hook_dir}\` — no v2 key yet; hooks are read from .pipeline/.hooks`);
  }
  for (const v of plan.variables) {
    if (v.required) {
      unsupported.push(
        `variable \${${v.name}} is declared (required) — \`vars:\` carries defaults only, so the manifest cannot demand it`,
      );
    }
  }

  const out: string[] = [...HEADER, `schema: ${MANIFEST_SCHEMA}`, ''];
  out.push(...line('', 'name', input.pipelineName));
  out.push(...line('', 'description', input.description ?? undefined));
  out.push('');
  out.push(...line('', 'execution', plan.mode satisfies Execution));
  // The FAITHFUL value, so the equivalence gate stays strict — but v1's default
  // isolation was `worktree`, which does nothing at all in sequential mode, and
  // emitting `step` unannotated would promote that accident into a declaration
  // saying "one worktree per step". Say which it is instead of choosing.
  const inertIsolation = plan.mode === 'sequential' && plan.isolation === 'worktree';
  if (inertIsolation) {
    out.push(
      '# v1 defaulted to per-step worktrees, which do nothing in a sequential run.',
      '# `none` says the same thing and reads honestly — change it unless this',
      '# pipeline is about to become parallel.',
    );
  }
  out.push(...line('', 'isolation', SCOPE_BY_ISOLATION[plan.isolation]));
  if (plan.base_branch !== 'main') out.push(...line('', 'base_branch', plan.base_branch));
  if (plan.submodules.length) {
    out.push('submodules:');
    for (const s of plan.submodules) out.push(`  - ${scalar(s)}`);
  }
  if (plan.default_model !== null || plan.default_effort !== null) {
    out.push('', 'defaults:');
    out.push(...line('  ', 'model', plan.default_model));
    out.push(...line('  ', 'effort', plan.default_effort));
  }
  const withDefaults = plan.variables.filter((v) => !v.required);
  if (withDefaults.length) {
    out.push('', 'vars:');
    for (const v of withDefaults) out.push(`  ${scalar(v.name)}: ${scalar(v.default ?? '')}`);
  }

  out.push('', 'steps:');
  plan.steps.forEach((step, i) => {
    if (i > 0) out.push('');
    out.push(`  - name: ${scalar(nameOf.get(step.step_id) ?? step.step_id)}`);
    if (step.type !== 'agent') out.push(`    type: ${scalar(step.type)}`);
    const bodyRel = input.bodyRelByStepId[step.step_id];
    if (bodyRel) out.push(`    body: ${scalar(bodyRel)}`);

    // Only what the step decides for ITSELF: a value equal to the pipeline
    // default resolves the same way whether it is written here or not.
    if (step.model !== plan.default_model) out.push(...line('    ', 'model', step.model));
    if (step.effort !== plan.default_effort) out.push(...line('    ', 'effort', step.effort));

    // `needs:` is omitted when the step depends exactly on the one before it,
    // which is what an absent `needs` already means.
    const implicit = i === 0 ? [] : [nameOf.get(plan.steps[i - 1].step_id) ?? plan.steps[i - 1].step_id];
    const declared = step.depends_on.map((d) => nameOf.get(d) ?? d);
    const explicit = plan.mode === 'parallel' ? declared : [];
    if (plan.mode === 'parallel' && !sameList(explicit, implicit)) {
      out.push(`    needs: [${explicit.map((d) => scalar(d)).join(', ')}]`);
    }

    if (step.retries > 0) out.push(...line('    ', 'retries', step.retries));

    const sc = step.script_spec;
    if (sc) {
      if (sc.command) {
        unsupported.push(
          `step '${step.step_id}' uses \`command:\` (${sc.command.join(' ')}) — a v2 script step runs a \`script:\` file`,
        );
      }
      out.push(...line('    ', 'script', sc.script));
      if (sc.timeoutS !== 600) out.push(...line('    ', 'timeout', sc.timeoutS));
      if (sc.retries > 0) out.push(...line('    ', 'retries', sc.retries));
      if (sc.onFailure !== 'halt') out.push(...line('    ', 'on_failure', sc.onFailure));
      out.push(...paramBlock('    ', 'params', sc.params));
      out.push(...paramBlock('    ', 'output', sc.output));
    }
    const pp = step.pipeline_spec;
    if (pp) {
      out.push(...line('    ', 'pipeline', pp.pipeline));
      out.push(...paramBlock('    ', 'args', pp.params));
      out.push(...paramBlock('    ', 'output', pp.output));
    }
    const gate = step.gate_spec;
    if (gate) {
      out.push(...line('    ', 'required_role', gate.required_role));
      out.push(...line('    ', 'message', gate.message));
    }
  });

  if (plan.graph) {
    out.push('', '# Conditional routing, from the v1 `## Graph` section.', 'flow:');
    out.push(...emitFlow(plan.graph as Record<string, unknown>, nameOf));
  }

  return { yaml: out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', renames, unsupported };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The routing graph as YAML, with every step reference renamed. Node shapes
 *  mirror the v1 `## Graph` JSON exactly — only the key names move. */
function emitFlow(graph: Record<string, unknown>, nameOf: Map<string, string>): string[] {
  const rename = (id: unknown): string => (typeof id === 'string' ? (nameOf.get(id) ?? id) : String(id));
  const out: string[] = [];
  for (const [from, node] of Object.entries(graph)) {
    out.push(`  ${scalar(rename(from))}:`);
    const edges = Array.isArray(node) ? node : [node];
    for (const raw of edges) {
      const e = raw as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof e.when === 'string') parts.push(`when: ${scalar(e.when)}`);
      if (e.goto !== undefined) parts.push(`goto: ${scalar(rename(e.goto))}`);
      if (e.done === true) parts.push('done: true');
      if (typeof e.max === 'number') parts.push(`max: ${e.max}`);
      out.push(`    - { ${parts.join(', ')} }`);
    }
  }
  return out;
}
