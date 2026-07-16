// Composition EXECUTION helpers (T3-10) — the run-tree/stack/child-run half
// of `type: pipeline` steps. T3-09 (lib/compose.ts) owns the STATIC side
// (reference resolution + plan-lint of the cross-pipeline graph); this module
// owns the small deterministic pieces the command layer composes into child
// runs at runtime:
//
//   - RUN-TREE RECORDS: every run that participates in composition gets a
//     `<pipeline_root>/.runtime/<run_id>/run-tree.json` describing its
//     position — parent_run_id / root_run_id / path (run_ids from the root,
//     inclusive) / depth (root = 1, the MAX_COMPOSITION_DEPTH counting) /
//     children. A run with no composition never gets one (zero overhead for
//     existing pipelines).
//   - CHILD RUN IDS: deterministic per parent dispatch
//     (`<parent_run_id>-<step_id>-<dispatch_index>`), so a crash-resume of a
//     pending pipeline dispatch re-enters the SAME child run (which then
//     resumes off its own persisted next.json) while a graph loop-back — a
//     NEW dispatch index — starts a fresh child run.
//   - CHILD INPUTS: the parent step's `## Params` bindings are resolved by
//     the command layer with the EXACT script-step resolver
//     (lib/script-step.ts resolveParams) against the PARENT's outputs/env;
//     this module delivers the resolved object to the child through the
//     established run-input channel — `.runtime/<child_run>/params.json` +
//     a task-ref pointing at it, so `${run.task}` (script steps) and the
//     drive `task_file` prompt line (agent steps) both see it. A pipeline
//     step with no `## Params` passes the PARENT's own task file through
//     instead (generic children keep working).
//   - CHILD OUTPUT: a completed child run's output is the persisted output
//     of the step that ENDED the run (its terminal state's current_step_id),
//     validated against the parent step's `## Output` declaration with the
//     same validator script steps use (validateOutputShape).
//
// The orchestration itself (descend/pop routing over the persisted
// NextState.active_child stack link) lives in commands/next.ts — it needs
// invokeNext, which a lib module must not import (layering).
//
// Import discipline: lib-only (script-step/script-types/next types + node
// builtins) — never plan.ts or commands/*.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScriptParamSpec } from './script-types';
import { validateOutputShape } from './script-step';
import type { ActiveChildRun } from './next';

/**
 * Runaway guard on the command layer's composition recursion within ONE
 * `pipeline next` call (descends + pops + chained child starts). Real trees
 * are bounded by the plan-lint depth cap; hitting this guard parks the call
 * with `{action:'continue'}` (state intact — a fresh call window resumes)
 * instead of recursing forever.
 */
export const COMPOSE_EXEC_GUARD = 128;

export interface RunTreeChildRef {
  run_id: string;
  pipeline_root: string;
  /** The parent `type: pipeline` step that spawned this child. */
  step_id: string;
  dispatch_index: number;
}

/** One run's position in the composition tree — persisted as
 *  `<pipeline_root>/.runtime/<run_id>/run-tree.json`. */
export interface RunTreeRecord {
  run_id: string;
  /** Absolute pipeline root the run executes. */
  pipeline_root: string;
  /** Immediate parent run, or null for the root run. */
  parent_run_id: string | null;
  parent_pipeline_root: string | null;
  /** The parent step (type: pipeline) this run executes, or null at the root. */
  parent_step_id: string | null;
  /** The tree's root run (itself for a root run). */
  root_run_id: string;
  /** Position in the tree: run_ids from the ROOT run to this run, inclusive
   *  (path[0] === root_run_id, path[path.length-1] === run_id). */
  path: string[];
  /** path.length — the root run is depth 1, matching the plan-lint
   *  MAX_COMPOSITION_DEPTH counting (entry pipeline counts as 1). */
  depth: number;
  /** Child runs spawned by this run's `type: pipeline` steps, in spawn order. */
  children: RunTreeChildRef[];
}

function runDir(pipelineRoot: string, runId: string): string {
  return join(pipelineRoot, '.runtime', runId);
}

/** Single source of the run-tree record location. */
export function runTreeFile(pipelineRoot: string, runId: string): string {
  return join(runDir(pipelineRoot, runId), 'run-tree.json');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Read a run's run-tree record; missing/corrupt/mis-shaped ⇒ null. */
export function readRunTree(pipelineRoot: string, runId: string): RunTreeRecord | null {
  let raw: string;
  try {
    raw = readFileSync(runTreeFile(pipelineRoot, runId), 'utf8');
  } catch {
    return null;
  }
  try {
    const v: unknown = JSON.parse(raw);
    if (
      isPlainObject(v) &&
      typeof v.run_id === 'string' &&
      typeof v.root_run_id === 'string' &&
      Array.isArray(v.path) &&
      typeof v.depth === 'number' &&
      Array.isArray(v.children)
    ) {
      return v as unknown as RunTreeRecord;
    }
  } catch {
    // corrupt record ⇒ treated as absent (registerChildRun re-synthesizes)
  }
  return null;
}

function writeRunTree(record: RunTreeRecord): void {
  const f = runTreeFile(record.pipeline_root, record.run_id);
  mkdirSync(runDir(record.pipeline_root, record.run_id), { recursive: true });
  writeFileSync(f, JSON.stringify(record, null, 2) + '\n', 'utf8');
}

/** The record a run has — or WOULD have — as a tree ROOT (used when a run
 *  spawns its first child and no record exists yet: existing runs only become
 *  tree members when composition actually happens). */
export function rootRunTree(pipelineRoot: string, runId: string): RunTreeRecord {
  return (
    readRunTree(pipelineRoot, runId) ?? {
      run_id: runId,
      pipeline_root: pipelineRoot,
      parent_run_id: null,
      parent_pipeline_root: null,
      parent_step_id: null,
      root_run_id: runId,
      path: [runId],
      depth: 1,
      children: [],
    }
  );
}

/** Deterministic child run id for one parent `type: pipeline` dispatch:
 *  `<parent_run_id>-<step_id>-<dispatch_index>`. Deterministic so a
 *  crash-resume of the same pending dispatch re-enters the SAME child run;
 *  index-keyed so a graph loop-back (a NEW dispatch) starts a FRESH one. */
export function childRunIdFor(parentRunId: string, stepId: string, dispatchIndex: number): string {
  const safe = stepId.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${parentRunId}-${safe}-${dispatchIndex}`;
}

/** Register a child run in the tree: append it to the parent's `children`
 *  (idempotent by run_id — a crash-resume re-registration never duplicates),
 *  write/refresh both run-tree records, and return the CHILD's. The parent
 *  record is synthesized as a tree root when this is its first child. */
export function registerChildRun(
  parent: { root: string; runId: string },
  child: { root: string; runId: string; stepId: string; dispatchIndex: number },
): RunTreeRecord {
  const parentRec = rootRunTree(parent.root, parent.runId);
  if (!parentRec.children.some((c) => c.run_id === child.runId)) {
    parentRec.children.push({
      run_id: child.runId,
      pipeline_root: child.root,
      step_id: child.stepId,
      dispatch_index: child.dispatchIndex,
    });
  }
  writeRunTree(parentRec);
  const childRec: RunTreeRecord = {
    run_id: child.runId,
    pipeline_root: child.root,
    parent_run_id: parent.runId,
    parent_pipeline_root: parent.root,
    parent_step_id: child.stepId,
    root_run_id: parentRec.root_run_id,
    path: [...parentRec.path, child.runId],
    depth: parentRec.depth + 1,
    // Preserve any children a resumed child run already registered.
    children: readRunTree(child.root, child.runId)?.children ?? [],
  };
  writeRunTree(childRec);
  return childRec;
}

/** A run's composition depth (root = 1); runs outside any tree read as 1. */
export function composedDepthOf(pipelineRoot: string, runId: string): number {
  return readRunTree(pipelineRoot, runId)?.depth ?? 1;
}

/** The task file a run's `${run.task}` / drive `task_file` resolves from:
 *  the run's task-ref.json target when present, else the conventional
 *  `.runtime/<run>/task.md` — the same ladder commands/next.ts readTaskText
 *  walks, but returning the PATH (composition passes it through to children
 *  and drive threads it into child-step prompts). */
export function taskFileFor(pipelineRoot: string, runId: string): string | null {
  const dir = runDir(pipelineRoot, runId);
  try {
    const ref = JSON.parse(readFileSync(join(dir, 'task-ref.json'), 'utf8')) as { task_file?: unknown };
    if (typeof ref.task_file === 'string' && existsSync(ref.task_file)) return ref.task_file;
  } catch {
    // no ref — try the conventional location
  }
  const conventional = join(dir, 'task.md');
  return existsSync(conventional) ? conventional : null;
}

/**
 * Deliver the child run's inputs through the established run-input channel:
 *   - params declared (even resolving to {}) → write them to
 *     `.runtime/<child_run>/params.json` and point the child's task-ref at it
 *     (child script steps read `${run.task}`, drive-spawned agent steps get
 *     `task_file = <params.json>` in their prompt);
 *   - no `## Params` on the pipeline step → pass the PARENT's task file
 *     through unchanged (generic children — e.g. an implement-task template —
 *     receive the run's actual task).
 * Returns the child's effective task file (null when neither applies).
 * Idempotent — a crash-resume re-delivery overwrites with identical content.
 */
export function deliverChildInputs(
  childRoot: string,
  childRunId: string,
  params: Record<string, unknown> | null,
  parentTaskFile: string | null,
): string | null {
  const dir = runDir(childRoot, childRunId);
  mkdirSync(dir, { recursive: true });
  if (params !== null) {
    const paramsFile = join(dir, 'params.json');
    writeFileSync(paramsFile, JSON.stringify(params, null, 2) + '\n', 'utf8');
    writeFileSync(join(dir, 'task-ref.json'), JSON.stringify({ task_file: paramsFile }), 'utf8');
    return paramsFile;
  }
  if (parentTaskFile !== null) {
    writeFileSync(join(dir, 'task-ref.json'), JSON.stringify({ task_file: parentTaskFile }), 'utf8');
    return parentTaskFile;
  }
  return null;
}

/**
 * Capture a COMPLETED child run's output: the persisted output of the step
 * that ended the run (`finalStepId` — the child's terminal current_step_id),
 * read from the child's §10 outputs store, validated against the parent
 * pipeline step's `## Output` declaration with the script-step validator.
 * `violation` non-null ⇒ the parent step fails (contract), exactly like a
 * script whose stdout violates its declaration. Children that end without a
 * final-step output (e.g. parallel-mode children — layer entries carry no
 * output in v1) yield output null, which only violates when the declaration
 * REQUIRES fields.
 */
export function childRunOutput(
  childRoot: string,
  childRunId: string,
  finalStepId: string | null,
  decl: Record<string, ScriptParamSpec> | null,
): { output: Record<string, unknown> | null; violation: string | null } {
  let output: Record<string, unknown> | null = null;
  if (finalStepId) {
    // §10 outputs-store layout (commands/next.ts outputsFile): missing/corrupt ⇒ null.
    try {
      const v: unknown = JSON.parse(
        readFileSync(join(runDir(childRoot, childRunId), 'outputs', `${finalStepId}.json`), 'utf8'),
      );
      if (isPlainObject(v)) output = v;
    } catch {
      // no persisted output — null
    }
  }
  const violation = decl ? validateOutputShape(output, decl) : null;
  return { output, violation };
}

/** Validate a persisted state's `active_child` field (untrusted JSON) into a
 *  typed stack link; anything mis-shaped reads as null (no child in flight). */
export function activeChildOf(state: { active_child?: unknown } | null | undefined): ActiveChildRun | null {
  const c = state?.active_child;
  if (!isPlainObject(c)) return null;
  return typeof c.root === 'string' &&
    typeof c.run_id === 'string' &&
    typeof c.step_id === 'string' &&
    typeof c.step_path === 'string' &&
    typeof c.dispatch_index === 'number'
    ? (c as unknown as ActiveChildRun)
    : null;
}
