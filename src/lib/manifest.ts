// The v2 pipeline manifest — `pipeline.yaml`.
//
// WHY THIS EXISTS. The v1 manifest spread a pipeline's definition across three
// places that disagreed about who was in charge: `PIPELINE.md` frontmatter, the
// frontmatter of every step file, and — for routing — an optional `## Graph`
// section whose mere PRESENCE silently overrode `execution:`. Ordering came from
// a third source again: the numeric prefix on each step's filename, plus each
// step reporting its own `next_iteration` at runtime. A step that forgot to
// report one ended the run as `completed` — a silent success.
//
// v2 collapses all of that into one file with one rule: **nothing is inferred**.
//
//   * Every mode is declared in the header. No section's existence changes how
//     the pipeline runs.
//   * The graph is DATA, not a mode: `needs:` declares dependencies, `flow:`
//     declares conditional routing, and `execution:` only says how much of the
//     resulting graph may run at once.
//   * Filenames carry nothing. A step's id is `id:`; its order comes from
//     `needs:`/`flow:`; its body is whatever `body:` points at. Numeric
//     prefixes are gone because there is nothing left for them to encode.
//   * An unknown value is an ERROR, never a warning with a silent fallback.
//     Every "treating as X" warning in v1 was a way to look configured while
//     behaving otherwise.
//
// This module is PURE — it parses and validates text, and never touches the
// filesystem. `loadManifest` (fs.ts side) supplies the file reading and the
// existence checks that need a disk.

import type { Graph, GraphNode } from './graph';
import { validateGraph } from './graph';

/** YAML parsing, via the runtime's own parser.
 *
 *  This package ships SOURCE and declares `engines.bun` — `bin` points at
 *  `src/cli.ts` behind `#!/usr/bin/env bun`, so a dependency here would be a
 *  real install-time dependency for every user, not something a bundler could
 *  inline away. The CLI has deliberately kept zero dependencies, so we use the
 *  runtime's built-in parser instead and guard for the one thing that can go
 *  wrong: a Bun older than the one that shipped it. */
function parseYaml(text: string): unknown {
  const yaml = (globalThis as { Bun?: { YAML?: { parse(s: string): unknown } } }).Bun?.YAML;
  if (!yaml?.parse) {
    throw new Error(
      `this Bun has no built-in YAML parser — ${MANIFEST_FILENAME} needs Bun >= 1.3.14 (run \`bun upgrade\`)`,
    );
  }
  return yaml.parse(text);
}

export const MANIFEST_FILENAME = 'pipeline.yaml';
export const MANIFEST_SCHEMA = 2;

export type Execution = 'sequential' | 'parallel';
/** The isolation axis is SCOPE, and nothing else:
 *    none — no worktree at all
 *    step — one worktree per step
 *    run  — one worktree for the whole pipeline
 *  v1's `worktree`/`manual`/`external` named three different axes (mechanism,
 *  ownership, provenance) and two of them were inert in sequential mode. */
export type Isolation = 'none' | 'step' | 'run';
export type StepType = 'agent' | 'script' | 'pipeline';

const EXECUTIONS: Execution[] = ['sequential', 'parallel'];
const ISOLATIONS: Isolation[] = ['none', 'step', 'run'];
const STEP_TYPES: StepType[] = ['agent', 'script', 'pipeline'];
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/** One resolved include in a step's body.
 *  `include` is unconditional when `when` is null; `oneof` takes the FIRST
 *  option whose flag is set, and is required to end in an unconditional one. */
export type BodyEntry =
  | { kind: 'include'; use: string; when: string | null }
  | { kind: 'oneof'; options: BodyOption[] };

export interface BodyOption {
  use: string;
  when: string | null;
}

export interface ManifestStep {
  id: string;
  type: StepType;
  /** Normalized to a list even when the manifest wrote a bare string. */
  body: BodyEntry[];
  /** Explicit `needs:`. NULL means the key was absent — which defaults to "the
   *  previously declared step". An explicit `[]` means genuinely no
   *  dependencies, and is how a step joins the first layer. The distinction is
   *  load-bearing, so it survives parsing instead of being flattened here. */
  needs: string[] | null;
  model: string | null;
  effort: string | null;
  /** Resolved against the pipeline default at parse time. */
  self_improve: boolean;
  script: string | null;
  pipeline: string | null;
  args: Record<string, unknown>;
  params: Record<string, unknown>;
  timeout: number | null;
  retries: number | null;
  on_failure: string | null;
  /** `type: pipeline` only — whether the child gets its own isolation. */
  child_isolation: 'own' | 'inherit' | null;
}

export interface Manifest {
  schema: number;
  name: string;
  description: string | null;
  execution: Execution;
  isolation: Isolation;
  base_branch: string;
  self_improve: boolean;
  defaults: { model: string | null; effort: string | null };
  submodules: string[];
  vars: Record<string, string>;
  steps: ManifestStep[];
  flow: Graph | null;
  errors: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Small typed readers — every one of them records an error rather than
// coercing, because a coerced value is exactly how v1 lied about its config.
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readString(v: unknown, path: string, errors: string[]): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  errors.push(`${path}: expected a string, got ${Array.isArray(v) ? 'a list' : typeof v}`);
  return null;
}

function readBool(v: unknown, path: string, errors: string[]): boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v;
  errors.push(`${path}: expected true or false, got ${JSON.stringify(v)}`);
  return null;
}

function readNumber(v: unknown, path: string, errors: string[]): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  errors.push(`${path}: expected a number, got ${JSON.stringify(v)}`);
  return null;
}

function readStringList(v: unknown, path: string, errors: string[]): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) {
    errors.push(`${path}: expected a list, got ${typeof v}`);
    return null;
  }
  const out: string[] = [];
  v.forEach((item, i) => {
    if (typeof item === 'string') out.push(item);
    else errors.push(`${path}[${i}]: expected a string, got ${typeof item}`);
  });
  return out;
}

function readEnum<T extends string>(
  v: unknown,
  allowed: T[],
  path: string,
  errors: string[],
): T | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && (allowed as string[]).includes(v)) return v as T;
  // Deliberately an error: v1 warned and fell back, which is how a pipeline
  // declaring `isolation: manager` ran for months with no isolation at all.
  errors.push(`${path}: unknown value ${JSON.stringify(v)} — expected one of ${allowed.join(' | ')}`);
  return null;
}

function readMap(v: unknown, path: string, errors: string[]): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) {
    errors.push(`${path}: expected a mapping, got ${Array.isArray(v) ? 'a list' : typeof v}`);
    return {};
  }
  return v;
}

// ---------------------------------------------------------------------------
// body: string | [ entry, ... ]
// ---------------------------------------------------------------------------

function parseBodyOption(v: unknown, path: string, errors: string[]): BodyOption | null {
  if (typeof v === 'string') return { use: v, when: null };
  if (!isPlainObject(v)) {
    errors.push(`${path}: expected a path or { use, when }, got ${typeof v}`);
    return null;
  }
  const use = readString(v.use, `${path}.use`, errors);
  if (!use) {
    if (v.use === undefined) errors.push(`${path}: missing 'use'`);
    return null;
  }
  return { use, when: readString(v.when, `${path}.when`, errors) };
}

function parseBody(v: unknown, path: string, errors: string[]): BodyEntry[] {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return [{ kind: 'include', use: v, when: null }];
  if (!Array.isArray(v)) {
    errors.push(`${path}: expected a path or a list of includes, got ${typeof v}`);
    return [];
  }

  const out: BodyEntry[] = [];
  v.forEach((raw, i) => {
    const at = `${path}[${i}]`;
    if (isPlainObject(raw) && raw.oneof !== undefined) {
      if (!Array.isArray(raw.oneof)) {
        errors.push(`${at}.oneof: expected a list of options`);
        return;
      }
      const options: BodyOption[] = [];
      raw.oneof.forEach((o, j) => {
        const opt = parseBodyOption(o, `${at}.oneof[${j}]`, errors);
        if (opt) options.push(opt);
      });
      if (!options.length) {
        errors.push(`${at}.oneof: needs at least one option`);
        return;
      }
      // The default branch is what stops a run from silently composing an
      // EMPTY body when no condition matches — the same failure shape as v1's
      // "no next_iteration ⇒ completed". Checked here, not at runtime.
      if (!options.some((o) => o.when === null)) {
        errors.push(
          `${at}.oneof: no default option — the last option must have no 'when', ` +
            `otherwise a run where nothing matches composes an empty body`,
        );
      } else if (options[options.length - 1].when !== null) {
        errors.push(`${at}.oneof: the default option (no 'when') must be LAST — options are tried in order`);
      }
      out.push({ kind: 'oneof', options });
      return;
    }
    const opt = parseBodyOption(raw, at, errors);
    if (opt) out.push({ kind: 'include', use: opt.use, when: opt.when });
  });
  return out;
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

function parseStep(
  raw: unknown,
  index: number,
  pipelineSelfImprove: boolean,
  errors: string[],
): ManifestStep | null {
  const at = `steps[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push(`${at}: expected a mapping`);
    return null;
  }

  const id = readString(raw.id, `${at}.id`, errors);
  if (!id) {
    if (raw.id === undefined) errors.push(`${at}: missing 'id'`);
    return null;
  }
  if (!ID_RE.test(id)) {
    errors.push(`${at}.id: '${id}' is not a valid step id (letters, digits, dot, dash, underscore)`);
  }

  const type = raw.type === undefined ? 'agent' : readEnum(raw.type, STEP_TYPES, `${at}.type`, errors);
  if (!type) return null;

  const step: ManifestStep = {
    id,
    type,
    body: parseBody(raw.body, `${at}.body`, errors),
    needs: raw.needs === undefined ? null : (readStringList(raw.needs, `${at}.needs`, errors) ?? []),
    model: readString(raw.model, `${at}.model`, errors),
    effort: readString(raw.effort, `${at}.effort`, errors),
    self_improve: readBool(raw.self_improve, `${at}.self_improve`, errors) ?? pipelineSelfImprove,
    script: readString(raw.script, `${at}.script`, errors),
    pipeline: readString(raw.pipeline, `${at}.pipeline`, errors),
    args: readMap(raw.args, `${at}.args`, errors),
    params: readMap(raw.params, `${at}.params`, errors),
    timeout: readNumber(raw.timeout, `${at}.timeout`, errors),
    retries: readNumber(raw.retries, `${at}.retries`, errors),
    on_failure: readString(raw.on_failure, `${at}.on_failure`, errors),
    child_isolation: null,
  };

  if (raw.isolation !== undefined) {
    if (type !== 'pipeline') {
      errors.push(`${at}.isolation: only a 'type: pipeline' step may set isolation (the pipeline header owns it otherwise)`);
    } else {
      step.child_isolation = readEnum(raw.isolation, ['own', 'inherit'], `${at}.isolation`, errors);
    }
  }

  // Per-type requirements. Each is a hard error because the alternative is a
  // step that dispatches into nothing.
  if (type === 'agent' && step.body.length === 0) {
    errors.push(`${at}: an agent step needs a 'body' (the markdown that tells it what to do)`);
  }
  if (type === 'script' && !step.script) {
    errors.push(`${at}: a 'type: script' step needs 'script:'`);
  }
  if (type === 'pipeline' && !step.pipeline) {
    errors.push(`${at}: a 'type: pipeline' step needs 'pipeline:'`);
  }
  if (type !== 'script' && step.script) {
    errors.push(`${at}.script: ignored on a '${type}' step — add 'type: script'`);
  }
  if (type !== 'pipeline' && step.pipeline) {
    errors.push(`${at}.pipeline: ignored on a '${type}' step — add 'type: pipeline'`);
  }
  return step;
}

// ---------------------------------------------------------------------------
// flow — reuses the v1 routing graph verbatim; only its SOURCE moved, from a
// `## Graph` markdown section into a first-class manifest key.
// ---------------------------------------------------------------------------

function parseFlow(v: unknown, errors: string[]): Graph | null {
  if (v === undefined || v === null) return null;
  if (!isPlainObject(v)) {
    errors.push(`flow: expected a mapping of step_id → edges`);
    return null;
  }
  return v as unknown as Record<string, GraphNode> as Graph;
}

// ---------------------------------------------------------------------------
// Dependency resolution and layering
// ---------------------------------------------------------------------------

/** Effective dependencies. An ABSENT `needs` inherits the previously declared
 *  step, so a plain linear pipeline needs no wiring at all; an explicit `[]`
 *  means none, which is how a step opts into the first layer. */
export function effectiveNeeds(steps: ManifestStep[]): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  steps.forEach((s, i) => {
    deps.set(s.id, s.needs !== null ? s.needs : i === 0 ? [] : [steps[i - 1].id]);
  });
  return deps;
}

export interface LayerResult {
  layers: string[][];
  errors: string[];
}

/** Topological layers over `needs`. `execution:` does NOT change this graph —
 *  it only decides whether a layer is dispatched at once or one step at a time.
 *  That separation is the whole point: concurrency policy stopped being tangled
 *  with dependency structure. */
export function buildLayers(steps: ManifestStep[]): LayerResult {
  const errors: string[] = [];
  const known = new Set<string>();
  for (const s of steps) {
    if (known.has(s.id)) errors.push(`duplicate step id '${s.id}'`);
    known.add(s.id);
  }

  const deps = effectiveNeeds(steps);
  for (const [id, ds] of deps) {
    for (const d of ds) {
      if (!known.has(d)) errors.push(`step '${id}' needs unknown step '${d}'`);
      if (d === id) errors.push(`step '${id}' needs itself`);
    }
  }
  if (errors.length) return { layers: [], errors };

  const layers: string[][] = [];
  const done = new Set<string>();
  const remaining = new Set(steps.map((s) => s.id));
  while (remaining.size) {
    const ready = [...remaining].filter((id) => (deps.get(id) ?? []).every((d) => done.has(d)));
    if (!ready.length) {
      errors.push(`cycle among steps: ${[...remaining].sort().join(', ')}`);
      break;
    }
    // Declaration order inside a layer, so a sequential run is deterministic.
    const ordered = steps.filter((s) => ready.includes(s.id)).map((s) => s.id);
    layers.push(ordered);
    for (const id of ordered) {
      done.add(id);
      remaining.delete(id);
    }
  }
  return { layers, errors };
}

// ---------------------------------------------------------------------------
// Body resolution and the self-improve freeze
// ---------------------------------------------------------------------------

/** Which files this step's body composes to, in order, given the run's flags.
 *  `flags` uses the SAME vocabulary as `flow:` conditions — one condition
 *  language for the whole manifest was a design requirement, not a shortcut. */
export function resolveBody(step: ManifestStep, flags: Record<string, unknown> = {}): string[] {
  const out: string[] = [];
  for (const entry of step.body) {
    if (entry.kind === 'include') {
      if (entry.when === null || flags[entry.when]) out.push(entry.use);
      continue;
    }
    const pick = entry.options.find((o) => o.when === null || flags[o.when]);
    if (pick) out.push(pick.use);
  }
  return out;
}

/** Every file a step could ever include, regardless of flags. */
export function bodyFiles(step: ManifestStep): string[] {
  const out: string[] = [];
  for (const entry of step.body) {
    if (entry.kind === 'include') out.push(entry.use);
    else for (const o of entry.options) out.push(o.use);
  }
  return out;
}

/** Body files no self-improvement pass may touch.
 *
 *  A file is writable only when EVERY step including it allows self-improve.
 *  Composition made per-step permission leaky on its own: a `_shared/` fragment
 *  included by both a permitted and a forbidden step would otherwise be edited
 *  "through" the permitted one, silently rewriting the protected step's body.
 *  One veto freezes the file. */
export function frozenBodyFiles(manifest: Manifest): Set<string> {
  const frozen = new Set<string>();
  for (const step of manifest.steps) {
    if (step.self_improve) continue;
    for (const f of bodyFiles(step)) frozen.add(f);
    if (step.script) frozen.add(step.script);
  }
  return frozen;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Parse and validate a `pipeline.yaml`. Pure: no filesystem, no environment.
 *  Errors are collected rather than thrown so a caller can print all of them at
 *  once; a manifest with a non-empty `errors` must never be run. */
export function parseManifest(text: string): Manifest {
  const errors: string[] = [];
  const warnings: string[] = [];

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return blank({ errors: [`${MANIFEST_FILENAME} is not valid YAML: ${(e as Error).message}`], warnings });
  }
  if (!isPlainObject(doc)) {
    return blank({ errors: [`${MANIFEST_FILENAME}: expected a mapping at the top level`], warnings });
  }

  // `schema:` is required and exact. A manifest that does not say which format
  // it is written in is precisely the ambiguity v2 exists to remove.
  const schema = readNumber(doc.schema, 'schema', errors);
  if (doc.schema === undefined) errors.push(`schema: missing — add 'schema: ${MANIFEST_SCHEMA}'`);
  else if (schema !== null && schema !== MANIFEST_SCHEMA) {
    errors.push(`schema: ${schema} is not supported by this CLI (expected ${MANIFEST_SCHEMA})`);
  }

  const name = readString(doc.name, 'name', errors);
  if (!name) errors.push(`name: missing`);

  const execution = doc.execution === undefined
    ? 'sequential'
    : readEnum(doc.execution, EXECUTIONS, 'execution', errors);
  const isolation = doc.isolation === undefined
    ? 'none'
    : readEnum(doc.isolation, ISOLATIONS, 'isolation', errors);
  const selfImprove = readBool(doc.self_improve, 'self_improve', errors) ?? true;

  const defaultsMap = readMap(doc.defaults, 'defaults', errors);
  const rawSteps = doc.steps;
  const steps: ManifestStep[] = [];
  if (rawSteps === undefined) errors.push(`steps: missing`);
  else if (!Array.isArray(rawSteps)) errors.push(`steps: expected a list`);
  else if (!rawSteps.length) errors.push(`steps: the pipeline has no steps`);
  else {
    rawSteps.forEach((raw, i) => {
      const s = parseStep(raw, i, selfImprove, errors);
      if (s) steps.push(s);
    });
  }

  const flow = parseFlow(doc.flow, errors);
  if (flow) errors.push(...validateGraph(flow, new Set(steps.map((s) => s.id))));

  const { errors: layerErrors } = buildLayers(steps);
  errors.push(...layerErrors);

  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(readMap(doc.vars, 'vars', errors))) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') vars[k] = String(v);
    else errors.push(`vars.${k}: expected a scalar`);
  }

  return {
    schema: schema ?? MANIFEST_SCHEMA,
    name: name ?? '',
    description: readString(doc.description, 'description', errors),
    execution: execution ?? 'sequential',
    isolation: isolation ?? 'none',
    base_branch: readString(doc.base_branch, 'base_branch', errors) ?? 'main',
    self_improve: selfImprove,
    defaults: {
      model: readString(defaultsMap.model, 'defaults.model', errors),
      effort: readString(defaultsMap.effort, 'defaults.effort', errors),
    },
    submodules: readStringList(doc.submodules, 'submodules', errors) ?? [],
    vars,
    steps,
    flow,
    errors,
    warnings,
  };
}

function blank(over: Partial<Manifest>): Manifest {
  return {
    schema: MANIFEST_SCHEMA,
    name: '',
    description: null,
    execution: 'sequential',
    isolation: 'none',
    base_branch: 'main',
    self_improve: true,
    defaults: { model: null, effort: null },
    submodules: [],
    vars: {},
    steps: [],
    flow: null,
    errors: [],
    warnings: [],
    ...over,
  };
}
