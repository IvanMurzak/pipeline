// Parser for the `claude -p --output-format json` result envelope.
//
// With `--output-format json` a headless claude process prints exactly ONE
// JSON object on stdout when it exits — the "envelope": result text, session
// id, cost/usage, error flags, and (when `--json-schema` was passed) the
// schema-validated `structured_output` object. `pipeline drive` captures the
// executor's stdout and feeds it here; everything in this module is pure and
// defensive — any non-envelope stdout (custom --executor-cmd templates print
// whatever they like) parses to null and the caller falls back to the
// agent-written step record file.
//
// Field reference (verified against Claude Code 2.1.205):
//   type:"result" subtype:"success"|"error_*" is_error result session_id
//   total_cost_usd num_turns structured_output
//   usage:{input_tokens output_tokens cache_read_input_tokens
//          cache_creation_input_tokens}

export interface EnvelopeUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface ClaudeEnvelope {
  /** true when the run errored (subtype carries the category). */
  is_error: boolean;
  /** "success" | "error_max_turns" | ... — null when absent. */
  subtype: string | null;
  /** The final response text (stringified JSON when --json-schema was used). */
  result: string | null;
  session_id: string | null;
  /** The --json-schema-validated object; null when the flag wasn't passed. */
  structured_output: Record<string, unknown> | null;
  total_cost_usd: number | null;
  usage: EnvelopeUsage | null;
  num_turns: number | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toEnvelope(o: Record<string, unknown>): ClaudeEnvelope {
  const u = obj(o.usage);
  return {
    is_error: o.is_error === true,
    subtype: str(o.subtype),
    result: str(o.result),
    session_id: str(o.session_id),
    structured_output: obj(o.structured_output),
    total_cost_usd: num(o.total_cost_usd),
    usage:
      u === null
        ? null
        : {
            input: num(u.input_tokens) ?? 0,
            output: num(u.output_tokens) ?? 0,
            cache_read: num(u.cache_read_input_tokens) ?? 0,
            cache_creation: num(u.cache_creation_input_tokens) ?? 0,
          },
    num_turns: num(o.num_turns),
  };
}

/** True for the one object shape we accept as an envelope. */
function isResultEnvelope(o: Record<string, unknown> | null): o is Record<string, unknown> {
  return o !== null && o.type === 'result';
}

/**
 * Extract the result envelope from a headless executor's captured stdout.
 * Tolerates leading noise (a wrapper script echoing before exec'ing claude):
 * tries the whole text first, then scans lines from the END for the last one
 * that parses to a `type:"result"` object. Returns null when there is none.
 */
export function parseEnvelope(stdout: string): ClaudeEnvelope | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const whole = obj(JSON.parse(text));
    if (isResultEnvelope(whole)) return toEnvelope(whole);
  } catch {
    // fall through to line scan
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const o = obj(JSON.parse(line));
      if (isResultEnvelope(o)) return toEnvelope(o);
    } catch {
      // not this line
    }
  }
  return null;
}

/** Zero-initialized usage accumulator. */
export function emptyUsage(): EnvelopeUsage & { cost_usd: number } {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0, cost_usd: 0 };
}

/** Fold one envelope's usage/cost into an accumulator (mutates + returns it). */
export function addUsage(
  acc: EnvelopeUsage & { cost_usd: number },
  env: ClaudeEnvelope,
): EnvelopeUsage & { cost_usd: number } {
  if (env.usage) {
    acc.input += env.usage.input;
    acc.output += env.usage.output;
    acc.cache_read += env.usage.cache_read;
    acc.cache_creation += env.usage.cache_creation;
  }
  if (env.total_cost_usd !== null) acc.cost_usd += env.total_cost_usd;
  return acc;
}
