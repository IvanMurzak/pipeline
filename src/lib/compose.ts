// Composition (`type: pipeline` steps) — format & plan-lint half (T3-09).
//
// A `type: pipeline` step references ANOTHER pipeline (by name or relative
// path) to be executed as a nested child run. This module owns the STATIC
// side: resolving a `pipeline:` reference to a pipeline root, building the
// cross-pipeline reference graph by reading the referenced pipelines'
// manifests/steps, and linting that graph — reference cycles (A→B→A, or a
// self-reference) and chains deeper than the composition depth cap are plan
// ERRORS. Execution (child-run flattening, run-tree records, runtime param
// passing) is deliberately NOT here — that is the sibling task T3-10.
//
// Param bindings on a pipeline step mirror the script-step `## Params`
// mechanism exactly (same `ScriptParamSpec` vocabulary, same binding
// templates) — the parsing/linting of those blocks stays in lib/plan.ts,
// shared with script steps; this module only carries the step-spec shape.
//
// Filesystem access goes through the injectable `ComposeFs` seam (defaulting
// to node:fs) so the reference-graph lint is unit-testable over in-memory
// fixtures.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseFrontmatter } from './frontmatter';
import { MANIFEST_FILENAME, parseManifest } from './manifest';
import type { ScriptParamSpec } from './script-types';

/** Parsed `type: pipeline` declaration attached to a PlanStep — the composed
 *  sibling of ScriptStepSpec. `params`/`output` use the EXACT script-step
 *  `## Params`/`## Output` vocabulary (§3 of roadmap/script-steps/DESIGN.md);
 *  how the child run consumes params / populates output is T3-10's contract. */
export interface PipelineStepSpec {
  /** The raw `pipeline:` frontmatter reference (name or relative path of
   *  another pipeline); null when the required key is missing (plan ERROR). */
  pipeline: string | null;
  /** Absolute root directory of the referenced pipeline (the dir holding its
   *  `pipeline.yml` or its PIPELINE.md); null when the reference does not
   *  resolve (plan ERROR). */
  resolved_root: string | null;
  /** `## Params` bindings for the child pipeline — same declaration + binding
   *  syntax/semantics as script steps (value XOR from, `${steps.<id>.output.<path>}`
   *  ancestor refs, `${env.NAME}` secret lint). */
  params: Record<string, ScriptParamSpec> | null;
  /** `## Output` declaration — same vocabulary; downstream `${steps.<id>.output.<f>}`
   *  bindings are field-checked against it exactly like a script producer. */
  output: Record<string, ScriptParamSpec> | null;
}

/**
 * Maximum composition depth — the number of pipelines in a nesting CHAIN,
 * counting the entry pipeline itself (entry alone = 1; entry → child = 2; …).
 * A chain deeper than this is a plan-lint ERROR even without a cycle, so
 * composition stays bounded. Override per call via
 * `ComputePlanOptions.maxCompositionDepth` (lib/plan.ts) when a project
 * legitimately needs deeper nesting.
 */
export const MAX_COMPOSITION_DEPTH = 6;

/** Runaway guard on graph exploration (distinct DFS node visits). Far above
 *  any real composition tree; only reachable by pathological fixtures. */
export const COMPOSE_VISIT_CAP = 512;

/** Injectable filesystem seam — production uses node:fs (realComposeFs);
 *  tests inject an in-memory fixture, never a real tree. */
export interface ComposeFs {
  /** True when `path` exists (file or directory). */
  exists(path: string): boolean;
  /** UTF-8 file contents; may throw when missing (callers guard with exists). */
  readFile(path: string): string;
  /** All `.md` files under `dir`, recursive, absolute paths, sorted — the same
   *  enumeration rule as plan.ts's iteration-file walker. Missing dir → []. */
  listMarkdownFiles(dir: string): string[];
}

export const realComposeFs: ComposeFs = {
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  listMarkdownFiles: (dir) => {
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
  },
};

/** Nearest ancestor that IS the canonical `<project>/.pipeline` dir
 *  (same rule as lib/stats.ts statsLocation) — used as the by-name resolution
 *  base so nested pipelines can reference top-level ones. Null when the
 *  pipeline lives outside a `.pipeline` tree (tests, embedded use). */
function findPipelinesRoot(fromRoot: string): string | null {
  let dir = fromRoot;
  while (true) {
    if (basename(dir) === '.pipeline') return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface ResolvedPipelineRef {
  /** Absolute pipeline root (dir containing a `pipeline.yml` or a
   *  PIPELINE.md), or null. */
  root: string | null;
  /** Candidate roots probed, in order (for the actionable error message). */
  tried: string[];
}

/** The v1 header file. A directory holding it is a pipeline root, exactly as a
 *  directory holding `pipeline.yml` is — `computePlan` reads either. */
const V1_MANIFEST_FILENAME = 'PIPELINE.md';

/** Named for the error message: what a candidate directory must hold to BE a
 *  pipeline root. Both spellings, in the order `computePlan` prefers them. */
const PIPELINE_ROOT_FILES = [MANIFEST_FILENAME, V1_MANIFEST_FILENAME] as const;

/** Whether `dir` is a pipeline root in EITHER format. Probing only PIPELINE.md
 *  made a schema-2 child that dropped its v1 header unresolvable — a pipeline
 *  the engine runs happily, that composition refused to see. */
function isPipelineRoot(dir: string, fs: ComposeFs): boolean {
  return PIPELINE_ROOT_FILES.some((name) => fs.exists(join(dir, name)));
}

/**
 * Resolve a `pipeline:` reference from a pipeline root. Candidate bases, in
 * order (first candidate that IS a pipeline root — `pipeline.yml` or
 * PIPELINE.md — wins):
 *   1. the referencing pipeline root itself   — child pipelines (`targets/x`)
 *      and explicit relative refs (`../sibling`);
 *   2. its parent directory                   — sibling pipelines by name
 *      (the common flat `.pipeline/<name>` layout);
 *   3. the enclosing `.pipeline` dir   — top-level pipelines by
 *      name/path from anywhere in a nested (family-target) tree.
 */
export function resolvePipelineRef(
  ref: string,
  fromRoot: string,
  fs: ComposeFs = realComposeFs,
): ResolvedPipelineRef {
  const from = resolve(fromRoot);
  const candidates = [resolve(from, ref), resolve(dirname(from), ref)];
  const pipelinesRoot = findPipelinesRoot(from);
  if (pipelinesRoot !== null) candidates.push(resolve(pipelinesRoot, ref));
  const tried: string[] = [];
  for (const candidate of candidates) {
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    if (isPipelineRoot(candidate, fs)) return { root: candidate, tried };
  }
  return { root: null, tried };
}

/** The tail of an unresolved-reference error — one wording, so the v1 walk,
 *  the manifest translation and the child-graph lint cannot drift. */
export function unresolvedRefDetail(tried: string[]): string {
  return `no ${PIPELINE_ROOT_FILES.join(' or ')} at any of: ${tried.join(', ')}`;
}

/** One outgoing composition edge of the ENTRY pipeline: a `type: pipeline`
 *  step (already parsed by computePlan) and the root it resolved to. Entry
 *  edges whose reference did not resolve are reported by computePlan itself
 *  and excluded here. */
export interface CompositionEdge {
  /** How the step is LABELLED: its path relative to the entry pipeline's
   *  `steps/` (POSIX-separated) in v1, its manifest `name:` in schema 2. The
   *  lint routes on `root` alone — this only names the step to a reader. */
  rel: string;
  /** Absolute root of the referenced (child) pipeline. */
  root: string;
}

export interface CompositionOptions {
  /** Depth cap override (whole chain, entry included). Default MAX_COMPOSITION_DEPTH. */
  maxDepth?: number;
  /** Filesystem seam. Default realComposeFs. */
  fs?: ComposeFs;
}

/** Human label for a pipeline root in lint messages: the path relative to the
 *  entry pipeline's parent dir when it stays inside it (clean sibling/child
 *  names), else the absolute root. */
function makeLabeler(entryRoot: string): (root: string) => string {
  const base = dirname(entryRoot);
  return (root) => {
    const rel = relative(base, root);
    if (rel === '' || rel.startsWith('..') || resolve(base, rel) !== root) return root;
    return rel.split(sep).join('/');
  };
}

/** Outgoing `type: pipeline` references of a NON-entry pipeline, read
 *  statically through the fs seam — from its `pipeline.yml` when it has one,
 *  else from its steps' frontmatter. Same precedence `computePlan` uses, so
 *  the graph walked here is the graph that would run. */
function childEdges(
  root: string,
  fs: ComposeFs,
  label: string,
  errors: Set<string>,
): CompositionEdge[] {
  return fs.exists(join(root, MANIFEST_FILENAME))
    ? manifestChildEdges(root, fs, label, errors)
    : markdownChildEdges(root, fs, label, errors);
}

/** Schema-2 child: its steps live in `pipeline.yml`, not in step frontmatter,
 *  so the v1 walk below found NOTHING in it — a cycle between two manifests
 *  went undetected. */
function manifestChildEdges(
  root: string,
  fs: ComposeFs,
  label: string,
  errors: Set<string>,
): CompositionEdge[] {
  let raw: string;
  try {
    raw = fs.readFile(join(root, MANIFEST_FILENAME));
  } catch (e) {
    errors.add(
      `composition: '${label}': ${MANIFEST_FILENAME} could not be read (${(e as Error).message}) — the child's own composition cannot be checked`,
    );
    return [];
  }
  const manifest = parseManifest(raw);
  // A child that does not parse cannot be walked, and reporting nothing would
  // silently narrow the graph — the parent's run would break inside it anyway.
  if (manifest.errors.length > 0) {
    errors.add(
      `composition: '${label}': ${MANIFEST_FILENAME} does not parse (${manifest.errors[0]}) — the child's own composition cannot be checked`,
    );
    return [];
  }
  const edges: CompositionEdge[] = [];
  for (const step of manifest.steps) {
    // A parsed manifest never carries a `type: pipeline` step without a
    // `pipeline:` — that is one of parseStep's hard errors, caught above.
    if (step.type !== 'pipeline' || step.pipeline === null) continue;
    const resolved = resolvePipelineRef(step.pipeline, root, fs);
    if (resolved.root === null) {
      errors.add(
        `composition: '${label}' ${MANIFEST_FILENAME} step '${step.name}': pipeline reference '${step.pipeline}' does not resolve — ${unresolvedRefDetail(resolved.tried)}`,
      );
      continue;
    }
    edges.push({ rel: step.name, root: resolved.root });
  }
  return edges;
}

/** v1 child: one step per markdown file, the reference in its frontmatter. */
function markdownChildEdges(
  root: string,
  fs: ComposeFs,
  label: string,
  errors: Set<string>,
): CompositionEdge[] {
  const stepsDir = join(root, 'steps');
  const edges: CompositionEdge[] = [];
  for (const file of fs.listMarkdownFiles(stepsDir)) {
    let raw: string;
    try {
      raw = fs.readFile(file);
    } catch {
      continue;
    }
    const { fields } = parseFrontmatter(raw);
    const t = typeof fields.type === 'string' ? fields.type.trim().toLowerCase() : '';
    if (t !== 'pipeline') continue;
    const rel = relative(stepsDir, file).split(sep).join('/');
    const ref = typeof fields.pipeline === 'string' && fields.pipeline.trim() ? fields.pipeline.trim() : null;
    if (ref === null) {
      errors.add(
        `composition: '${label}' steps/${rel}: type: pipeline requires a 'pipeline:' frontmatter reference (the name or relative path of another pipeline)`,
      );
      continue;
    }
    const resolved = resolvePipelineRef(ref, root, fs);
    if (resolved.root === null) {
      errors.add(
        `composition: '${label}' steps/${rel}: pipeline reference '${ref}' does not resolve — ${unresolvedRefDetail(resolved.tried)}`,
      );
      continue;
    }
    edges.push({ rel, root: resolved.root });
  }
  return edges;
}

/**
 * Lint the cross-pipeline reference graph reachable from `entryRoot` through
 * its `type: pipeline` steps (`entryEdges`, parsed by computePlan). Children's
 * own references are read statically through the fs seam, from whichever
 * format each child is written in. Returns plan ERROR strings:
 *   - a reference CYCLE (self-reference included), naming the cycle path;
 *   - a chain deeper than the depth cap (entry pipeline counts as depth 1);
 *   - a child's `type: pipeline` step whose reference is missing/unresolvable
 *     (the parent's run would break inside that child).
 * A pipeline with no `type: pipeline` steps never reaches this function —
 * existing non-composed pipelines lint exactly as before.
 */
export function lintComposition(
  entryRoot: string,
  entryEdges: CompositionEdge[],
  options: CompositionOptions = {},
): string[] {
  const fs = options.fs ?? realComposeFs;
  const maxDepth =
    options.maxDepth !== undefined && Number.isInteger(options.maxDepth) && options.maxDepth >= 1
      ? options.maxDepth
      : MAX_COMPOSITION_DEPTH;
  const entry = resolve(entryRoot);
  const label = makeLabeler(entry);
  const errors = new Set<string>();
  let visits = 0;

  // Plain DFS with an explicit ancestor stack: a child already on the stack is
  // a cycle; a stack longer than the cap is a depth violation. No black-set
  // memoization — depth violations are path-dependent, and real composition
  // graphs are tiny (the visit cap bounds pathological ones).
  const visit = (root: string, stack: string[]): void => {
    if (visits++ > COMPOSE_VISIT_CAP) return;
    const at = stack.indexOf(root);
    if (at !== -1) {
      const cycle = [...stack.slice(at), root].map(label);
      errors.add(
        `composition cycle detected: ${cycle.join(' → ')} — 'type: pipeline' references must form a DAG (break the cycle by removing one of the references)`,
      );
      return;
    }
    const depth = stack.length + 1;
    if (depth > maxDepth) {
      const chain = [...stack, root].map(label);
      errors.add(
        `composition depth ${depth} exceeds the cap (${maxDepth}): ${chain.join(' → ')} — flatten the chain or raise maxCompositionDepth (default MAX_COMPOSITION_DEPTH = ${MAX_COMPOSITION_DEPTH})`,
      );
      return;
    }
    const edges =
      stack.length === 0 ? entryEdges : childEdges(root, fs, label(root), errors);
    for (const edge of edges) visit(resolve(edge.root), [...stack, root]);
  };

  visit(entry, []);
  if (visits > COMPOSE_VISIT_CAP) {
    errors.add(
      `composition graph exploration exceeded ${COMPOSE_VISIT_CAP} visits — the reference graph is unreasonably large; simplify the composition`,
    );
  }
  return [...errors];
}

/**
 * The plan-side wrapper around {@link lintComposition}: validate the depth-cap
 * override, then append the graph's errors.
 *
 * Shared by BOTH plan builders on purpose. The lint used to be wired into the
 * v1 walk only, so a schema-2 plan checked that each `pipeline:` reference
 * RESOLVED and nothing else — two manifests pointing at each other were a plan
 * with no errors and a run that never terminates. A lint that only one of two
 * front doors calls is a lint that will be forgotten again.
 *
 * A pipeline with no resolved `type: pipeline` step passes no edges and this
 * does nothing — non-composed pipelines lint exactly as before.
 */
export function lintCompositionForPlan(
  pipelineRoot: string,
  edges: CompositionEdge[],
  options: { maxCompositionDepth?: number | undefined; fs?: ComposeFs | undefined },
  errors: string[],
  warnings: string[],
): void {
  if (edges.length === 0) return;
  let maxDepth = options.maxCompositionDepth;
  if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 1)) {
    warnings.push(
      `maxCompositionDepth ${String(maxDepth)} is invalid (positive integer required) — using the default ${MAX_COMPOSITION_DEPTH}`,
    );
    maxDepth = undefined;
  }
  errors.push(
    ...lintComposition(pipelineRoot, edges, {
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    }),
  );
}
