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
  /** The --json-schema-validated object; null when the flag wasn't passed.
   *  NOTE (verified on Claude Code 2.1.214): a `-p --agent <name>` invocation
   *  NEVER produces structured_output — subagent runs do not support
   *  --json-schema yet (the flag is silently ignored; claude-code#20625).
   *  Callers must treat its absence as normal and fall back to the record
   *  file / final-response text channels. */
  structured_output: Record<string, unknown> | null;
  total_cost_usd: number | null;
  usage: EnvelopeUsage | null;
  num_turns: number | null;
  /** Tool calls the harness DENIED (verified on 2.1.214: headless acceptEdits
   *  auto-denies "sensitive" writes — anything under `.claude/` — instead of
   *  prompting). Empty when the envelope carries none. `file_path` is the
   *  denied call's file_path input when present (Write/Edit denials). */
  permission_denials: PermissionDenial[];
}

export interface PermissionDenial {
  tool_name: string | null;
  file_path: string | null;
}

export interface ProviderLimit {
  /** Classification reason: "rate_limit_exceeded" | "overloaded" — maps the
   *  claude envelope error subtype (error_rate_limited → rate_limit_exceeded;
   *  error_overloaded → overloaded). */
  reason: 'rate_limit_exceeded' | 'overloaded';
  /** Optional retry delay in milliseconds when available in the error. */
  retry_after_ms?: number;
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
    permission_denials: toDenials(o.permission_denials),
  };
}

/** Defensive extraction of the envelope's `permission_denials` array (shape
 *  verified on 2.1.214: `[{tool_name, tool_use_id, tool_input:{file_path,…}}]`).
 *  Anything malformed contributes nothing — never throws. */
function toDenials(v: unknown): PermissionDenial[] {
  if (!Array.isArray(v)) return [];
  const out: PermissionDenial[] = [];
  for (const entry of v) {
    const e = obj(entry);
    if (e === null) continue;
    const input = obj(e.tool_input);
    out.push({ tool_name: str(e.tool_name), file_path: input === null ? null : str(input.file_path) });
  }
  return out;
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

/**
 * Recover a JSON OBJECT from an envelope's `result` text — the belt-and-braces
 * record channel for `-p --agent` invocations, where `--json-schema` produces
 * no `structured_output` (silently ignored for subagent runs; verified on
 * Claude Code 2.1.214, tracked as claude-code#20625) and the drive prompt
 * instead instructs the executor to END with exactly the record object.
 *
 * Tolerant, bounded extraction (never throws):
 *   1. the whole trimmed text as JSON;
 *   2. each ``` fenced block, LAST first (the final fence is the final answer);
 *   3. the first-`{` … last-`}` substring (JSON wrapped in prose).
 * Only a JSON OBJECT is accepted; arrays/scalars/malformed → null.
 */
export function parseResultObject(result: string | null): Record<string, unknown> | null {
  if (result === null) return null;
  const text = result.trim();
  if (!text) return null;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      return obj(JSON.parse(s));
    } catch {
      return null;
    }
  };
  const whole = tryParse(text);
  if (whole !== null) return whole;
  // Fenced blocks, last-first: ```json\n{...}\n``` (language tag optional).
  const fences = [...text.matchAll(/```[a-zA-Z]*\r?\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const inner = tryParse(fences[i][1].trim());
    if (inner !== null) return inner;
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const span = tryParse(text.slice(first, last + 1));
    if (span !== null) return span;
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

/** Detect a provider-limit error from an envelope's subtype. The envelope's
 *  error subtype maps to a structured ProviderLimit — rate_limited /
 *  overloaded (06.7 / D11). Null when the error is some other category or
 *  when the envelope reports success. */
export function detectProviderLimit(env: ClaudeEnvelope): ProviderLimit | null {
  if (!env.is_error || !env.subtype) return null;
  if (env.subtype === 'error_rate_limited') {
    return { reason: 'rate_limit_exceeded' };
  }
  if (env.subtype === 'error_overloaded') {
    return { reason: 'overloaded' };
  }
  return null;
}
