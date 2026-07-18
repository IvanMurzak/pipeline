// The step record JSON Schema — SINGLE SOURCE for what a step-executor reports.
//
// Passed to headless executors via `claude -p --json-schema` so the harness
// itself validates the final response: the envelope's `structured_output` IS
// the step record, and a malformed record becomes impossible instead of a
// synthesized halt. The same shape is what executors write to their
// step_record_file (the manager-mode protocol in agents/step-executor.md) and
// what the `pipeline next` engine consumes as a {kind:'step'} record — keep
// the three in lockstep: engine fields live in lib/next.ts (StepRecord /
// LayerResultEntry), the prose protocol in agents/step-executor.md.
//
// IMPORTANT: the serialized schema must stay WHITESPACE-FREE. The executor
// command template in commands/drive.ts is whitespace-split, and the compact
// schema travels as a single `{schema}` token — a space inside would shear it
// in two. stepRecordSchemaJson() uses plain JSON.stringify (no indent) and a
// test asserts the invariant; never add a space to a property name, enum
// value, or description inside this schema.

/** Outcomes the `pipeline next` engine accepts on a step record. */
export const ENGINE_OUTCOMES = ['completed', 'halted', 'blocked-delegating', 'depth-exhausted'] as const;

/** Everything a headless executor may report: the engine outcomes plus
 *  'needs-input' — intercepted by `pipeline drive` BEFORE the engine (the run
 *  parks awaiting an answer and the session is resumed with it; the engine
 *  never sees a needs-input record). */
export const RECORD_OUTCOMES = [...ENGINE_OUTCOMES, 'needs-input'] as const;

export const STEP_RECORD_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: [...RECORD_OUTCOMES] },
    // One-line human summary of what the step did (surfaced in drive progress).
    summary: { type: ['string', 'null'] },
    // Absolute path of the next iteration, or "PIPELINE_COMPLETE" (sequential
    // mode); null/absent in graph/DAG modes where the engine routes.
    next_iteration: { type: ['string', 'null'] },
    halt_reason: { type: ['string', 'null'] },
    has_improvement_brief: { type: 'boolean' },
    // Tier-1 self-improvement: the VERBATIM improvement brief (the record-FILE
    // protocol in step-executor.md already carries it). Present here so the
    // headless structured-output path carries it too — `pipeline drive` hands
    // it to its improver session; the engine itself never reads it.
    improvement_brief: { type: ['string', 'null'] },
    // Graph-mode routing flags (lib/graph.ts routes on these).
    flags: { type: ['object', 'null'] },
    // Parallel-worktree steps: the branch/worktree the step committed to.
    worktree_branch: { type: ['string', 'null'] },
    worktree_path: { type: ['string', 'null'] },
    // blocked-delegating: the blocker brief (docs/nested-blocker-delegation.md).
    blocker_delegation: { type: ['object', 'null'] },
    // OPTIONAL structured step output — persisted by the command layer to the
    // run's outputs store (.runtime/<run-id>/outputs/<step_id>.json) and
    // consumed by downstream ${steps.<id>.output.*} bindings (script steps)
    // or Inputs-section file reads (agent steps). See DESIGN.md §10.
    output: { type: ['object', 'null'] },
    // needs-input: the question for the caller. `context` MUST summarize what
    // the step already did/found so the answerer can decide (it doubles as the
    // re-spawn digest if the session cannot be resumed).
    question: {
      type: ['object', 'null'],
      properties: {
        text: { type: 'string' },
        context: { type: ['string', 'null'] },
        options: { type: ['array', 'null'], items: { type: 'string' } },
      },
      required: ['text'],
    },
  },
  required: ['outcome'],
} as const;

/** Compact (whitespace-free) serialization for the `{schema}` template token. */
export function stepRecordSchemaJson(): string {
  return JSON.stringify(STEP_RECORD_SCHEMA);
}

export interface StepQuestion {
  text: string;
  context: string | null;
  options: string[] | null;
  /** Correlatable id minted at park time — used by runner to match cloud
   *  answers on the bridge (06.2.1). Additive; older CLI versions omit this. */
  question_id?: string;
}

/** Extract the needs-input question from a step record, defensively. Lives
 *  here (not in commands/drive.ts) so record CONSUMERS — the pipeline-ui
 *  launcher parses the same shape out of drive's final JSON — can import it
 *  without dragging in the whole drive/engine module graph. */
export function extractQuestion(raw: Record<string, unknown>, fallbackText = "executor requested input but provided no question text"): StepQuestion {
  const q =
    raw.question !== null && typeof raw.question === "object" && !Array.isArray(raw.question)
      ? (raw.question as Record<string, unknown>)
      : {};
  return {
    text: typeof q.text === "string" && q.text ? q.text : fallbackText,
    context: typeof q.context === "string" ? q.context : null,
    options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string") : null,
  };
}
