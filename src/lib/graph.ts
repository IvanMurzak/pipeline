// Declarative routing graph — the deterministic control flow for Variant-A
// pipelines. A pipeline opts in by adding a `## Graph` section to PIPELINE.md
// containing a fenced ```json block that maps each step_id to its outgoing
// edges. Steps then stop deciding their own `next_iteration`; instead they
// emit result FLAGS, and `pipeline route` (this module) evaluates graph + flags
// + per-run edge counters to pick the next step — so loop/skip/counter logic
// lives in ONE declarative place, never duplicated across step bodies.
//
// A pipeline with no `## Graph` section is untouched (legacy sequential / DAG).

export interface GraphEdge {
  /** When set, this edge is taken only if the named result flag is truthy.
   *  Absent → a default edge (taken when no earlier `when` matched). */
  when?: string;
  /** Forward to this step_id. Mutually exclusive with `done`. */
  goto?: string;
  /** Terminate the run on this edge. Mutually exclusive with `goto`. */
  done?: boolean;
  /** Bounded loop: this edge may be taken at most `max` times per run; after
   *  that it is skipped (control falls through to the next matching edge). */
  max?: number;
}

/** A node is an array of edges, or a shorthand for a single unconditional edge. */
export type GraphNode = { goto: string } | { done: true } | GraphEdge[];

export type Graph = Record<string, GraphNode>;

export interface RouteState {
  /** Per-edge take counts, keyed `<from_step_id>#<edge_index>`. */
  counters: Record<string, number>;
  /** Total transitions this run (a runaway-loop backstop). */
  transitions: number;
}

export type RouteAction =
  | { action: 'run'; target: string }
  | { action: 'done' }
  | { action: 'halt'; reason: string };

/** Hard cap on transitions per run — a backstop against an unbounded loop with
 *  a missing `max`. Far above any real pipeline. */
export const ROUTE_TRANSITION_CAP = 1000;

const GRAPH_SECTION_RE = /^##\s+Graph\s*$/im;
const JSON_FENCE_RE = /```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/;

export interface ExtractGraphResult {
  graph: Graph | null;
  error: string | null;
}

/** Pull the graph object out of a PIPELINE.md body, or {null,null} when there
 *  is no `## Graph` section. A present-but-malformed block returns an error. */
export function extractGraph(manifestBody: string): ExtractGraphResult {
  const m = GRAPH_SECTION_RE.exec(manifestBody);
  if (!m) return { graph: null, error: null };
  // Search for the first JSON fence AFTER the heading.
  const after = manifestBody.slice(m.index + m[0].length);
  const fence = JSON_FENCE_RE.exec(after);
  if (!fence) return { graph: null, error: '## Graph section has no ```json code block' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch (e) {
    return { graph: null, error: `## Graph JSON is invalid: ${(e as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { graph: null, error: '## Graph must be a JSON object mapping step_id → node' };
  }
  return { graph: parsed as Graph, error: null };
}

/** Normalize a node to its edge list. */
export function nodeEdges(node: GraphNode): GraphEdge[] {
  if (Array.isArray(node)) return node;
  if ('done' in node && node.done) return [{ done: true }];
  if ('goto' in node && typeof node.goto === 'string') return [{ goto: node.goto }];
  return [];
}

/** Validate a graph against the set of real step_ids. Returns error strings. */
export function validateGraph(graph: Graph, stepIds: Set<string>): string[] {
  const errors: string[] = [];
  for (const [from, node] of Object.entries(graph)) {
    if (!stepIds.has(from)) errors.push(`Graph node '${from}' is not a known step_id`);
    const edges = nodeEdges(node);
    if (edges.length === 0) {
      errors.push(`Graph node '${from}' has no usable edges`);
      continue;
    }
    edges.forEach((e, i) => {
      const hasGoto = typeof e.goto === 'string';
      const hasDone = e.done === true;
      if (hasGoto === hasDone) {
        errors.push(`Graph '${from}' edge ${i} must have exactly one of 'goto' or 'done'`);
      }
      if (hasGoto && !stepIds.has(e.goto as string)) {
        errors.push(`Graph '${from}' edge ${i} goes to unknown step '${e.goto}'`);
      }
      if (e.max !== undefined && (!Number.isInteger(e.max) || e.max < 1)) {
        errors.push(`Graph '${from}' edge ${i} has invalid max '${e.max}' (positive integer)`);
      }
    });
  }
  return errors;
}

export function emptyRouteState(): RouteState {
  return { counters: {}, transitions: 0 };
}

/**
 * The pure routing decision. Given the graph, the step we just finished
 * (`from`), the result flags it emitted, and the mutable run state, pick the
 * next action. MUTATES `state` (counters / transitions) when an edge is taken.
 */
export function routeNext(
  graph: Graph,
  from: string,
  flags: Record<string, unknown>,
  state: RouteState,
): RouteAction {
  const node = graph[from];
  // A step with no graph node is terminal (nothing routes onward from it).
  if (node === undefined) return { action: 'done' };

  const edges = nodeEdges(node);
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const conditionMatches = edge.when === undefined ? true : Boolean(flags[edge.when]);
    if (!conditionMatches) continue;
    if (edge.max !== undefined) {
      const key = `${from}#${i}`;
      const taken = state.counters[key] ?? 0;
      if (taken >= edge.max) continue; // budget exhausted → fall through
      state.counters[key] = taken + 1;
    }
    state.transitions += 1;
    if (state.transitions > ROUTE_TRANSITION_CAP) {
      return {
        action: 'halt',
        reason: `route transition cap (${ROUTE_TRANSITION_CAP}) exceeded — likely an unbounded loop (missing 'max')`,
      };
    }
    if (edge.done) return { action: 'done' };
    return { action: 'run', target: edge.goto as string };
  }

  return {
    action: 'halt',
    reason: `no matching edge from '${from}' (flags: ${JSON.stringify(flags)}) — add a default edge (one with no 'when')`,
  };
}
