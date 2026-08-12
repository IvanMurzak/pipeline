// _conformance-engine.ts — ONE fake engine, driven through BOTH front doors
// (d2, 02-standalone-executor.md's Work-table `tests` row).
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// d2 compares a run under `--executor=claude-cli` against the same run under
// `--executor=claude-sdk`. Neither may make a live API call, so both need a
// stand-in for Claude. The obvious shape — a fake `claude` script for the CLI
// path and a fake `query()` for the SDK path — has a fatal flaw: TWO fakes can
// disagree, and then the test measures the fakes rather than the executors. A
// divergence would be reported where none exists, and (far worse) two fakes
// that drifted into agreeing about the wrong thing would hide a real one.
//
// So there is exactly one engine, and it lives here. {@link engineFrames} is a
// PURE function of (spec, agent, prompt, model, session) → the stream-json
// frames a `result`-producing turn emits. The CLI front door is a generated
// `bun` script that imports this module and prints those frames on stdout; the
// SDK front door is a `query()` that imports this module and yields the same
// objects. The comparison is therefore genuinely between two front doors to
// one engine — which is what the design claims the two executors are, since
// the Agent SDK bundles and drives the same Claude Code binary the CLI is.
//
// ── WHAT "THE SAME ENGINE" HAS TO MEAN MECHANICALLY ─────────────────────────
//
// Both front doors receive the same two inputs and nothing else:
//
//   - the AGENT — `--agent <name>` in argv for the CLI, `options.agent` for
//     the SDK. This is what discriminates a step dispatch from an improver
//     dispatch from a script-creator dispatch.
//   - the PROMPT — stdin for the CLI, `query({ prompt })` for the SDK.
//
// Everything the engine answers is derived from those two, plus a fixture
// {@link EngineSpec} read from a JSON file BOTH front doors are pointed at.
// The step a prompt belongs to is recovered from the prompt's own
// `step_record_file = <…>/<step_id>.json` line — the same recovery
// `tests/sdk-seams.test.ts` uses — so the engine needs no privileged knowledge
// of the run it is serving.
//
// ── THE MODEL IS PINNED, AND THE PIN IS ECHOED BACK ─────────────────────────
//
// d1 (`_model-conformance.ts`) requires a conformance fixture to pin a FULL
// model id and to verify what actually ran rather than what was requested. The
// engine cooperates with the second half: whatever model it was ASKED for
// (`--model` / `options.model`) is echoed into the terminal frame's
// `modelUsage` map, which is the only channel `ClaudeEnvelope.models_used`
// reads. A front door that dropped the model on the floor therefore produces
// an envelope with no `modelUsage` at all, and `assertModelUsedMatches` fails
// with "no modelUsage in the result envelope" rather than passing quietly.

import type { SdkMessage } from '../src/lib/executors/sdk';

// ---------------------------------------------------------------------------
// The fixture the engine serves
// ---------------------------------------------------------------------------

/** The three `--agent` values the three seams carry (mirrors
 *  `sdk-seams.ts`'s SDK_*_AGENT constants; the fixture passes them in rather
 *  than importing them so the generated CLI script needs one import only). */
export interface EngineAgents {
  step: string;
  improver: string;
  scriptCreator: string;
}

/** Everything the engine will ever answer, as data. Serialised to JSON and
 *  read by BOTH front doors — the CLI one is a separate process, so a shared
 *  file is the only way it and the in-process SDK fake can be driven from one
 *  source of truth. */
export interface EngineSpec {
  agents: EngineAgents;
  /** step_id → the structured step record that step reports. */
  steps: Record<string, Record<string, unknown>>;
  /** The improver session's structured record. */
  improver: Record<string, unknown>;
  /** The script-creator session's structured record. */
  scriptCreator: Record<string, unknown>;
}

/** One dispatch as a front door saw it — appended to a per-run JSONL log by
 *  BOTH front doors, so the two runs' dispatch SEQUENCES can be compared
 *  before their records are. */
export interface EngineDispatch {
  /** Which front door served it: proof the two runs really used different
   *  ones, without which the whole comparison could be a path against itself. */
  door: 'claude-cli' | 'claude-sdk';
  agent: string | null;
  model: string | null;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Prompt → step id
// ---------------------------------------------------------------------------

/** The step a step-executor prompt belongs to, recovered from the
 *  `step_record_file = <path>/<step_id>.json` line the spawn prompt carries.
 *  Null when the prompt has no such line (never true for a step dispatch). */
export function stepIdFromPrompt(prompt: string): string | null {
  const m = /^step_record_file = (.+)$/m.exec(prompt);
  if (!m) return null;
  const leaf = m[1].trim().replaceAll('\\', '/').split('/').pop();
  return leaf === undefined ? null : leaf.replace(/\.json$/, '');
}

// ---------------------------------------------------------------------------
// argv helpers — the CLI front door's half of "the same two inputs"
// ---------------------------------------------------------------------------

/** The value of `--flag <value>` in an argv, or null when the flag is absent
 *  (which is what `buildExecutorArgv` produces for an unresolved token: the
 *  token AND its preceding flag are dropped together). */
export function flagValue(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** Raised when a dispatch names an agent, or a step, the fixture has no answer
 *  for. Loud on purpose: a silent `{}` would surface much later as an
 *  unexplained conformance divergence instead of as the fixture gap it is. */
export class EngineSpecGapError extends Error {}

/** The structured record this engine answers a dispatch with. Pure — the same
 *  (spec, agent, prompt) always yields the same object, which is what makes a
 *  difference between the two runs attributable to the EXECUTOR. */
export function engineReply(spec: EngineSpec, agent: string | null, prompt: string): Record<string, unknown> {
  if (agent === spec.agents.improver) return spec.improver;
  if (agent === spec.agents.scriptCreator) return spec.scriptCreator;
  if (agent !== spec.agents.step) {
    throw new EngineSpecGapError(
      `conformance engine: dispatch named agent ${JSON.stringify(agent)}, which is none of the three ` +
        `seams the fixture declares (${JSON.stringify(spec.agents)}). A front door that loses or rewrites ` +
        'the agent looks exactly like this.',
    );
  }
  const stepId = stepIdFromPrompt(prompt);
  const record = stepId === null ? undefined : spec.steps[stepId];
  if (record === undefined) {
    throw new EngineSpecGapError(
      `conformance engine: no fixture record for step ${JSON.stringify(stepId)} (known: ` +
        `${JSON.stringify(Object.keys(spec.steps))}).`,
    );
  }
  return record;
}

/**
 * The stream-json frames one dispatch emits: an assistant frame carrying a
 * tool call (so the progress path is exercised on both front doors, not just
 * the terminal frame) and the terminal `result` frame.
 *
 * `modelUsage` is keyed on the model the front door ASKED for, which is what
 * makes d1's `assertModelUsedMatches` a real read-back rather than a
 * restatement of the fixture: no model requested ⇒ no `modelUsage` ⇒ the
 * assertion fails for want of evidence.
 *
 * The numbers below (cost, tokens, turns) are FIXED rather than random. They
 * are not part of what this test compares — see the exclusion list in
 * `executor-conformance.test.ts` — but a deterministic engine keeps them from
 * adding noise that would have to be excluded for a second, weaker reason.
 */
export function engineFrames(
  spec: EngineSpec,
  agent: string | null,
  prompt: string,
  model: string | null,
  sessionId: string | null,
): SdkMessage[] {
  const structured = engineReply(spec, agent, prompt);
  return [
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: 'tool_use', id: 'toolu_conformance_read', name: 'Read', input: {} }],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 2,
      result: JSON.stringify(structured),
      session_id: sessionId,
      total_cost_usd: 0.01,
      usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 },
      ...(model === null ? {} : { modelUsage: { [model]: { inputTokens: 11, outputTokens: 22 } } }),
      permission_denials: [],
      structured_output: structured,
    },
  ];
}
