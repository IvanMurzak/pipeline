// Incremental parser for `claude -p --output-format stream-json --verbose`.
//
// Under `--output-format json` a headless claude prints ONE object when it
// exits, so nothing is observable until the step is over. Under
// `--output-format stream-json` it prints newline-delimited JSON AS IT GOES —
// one object per line — and the same terminal `result` object arrives as the
// LAST line. This module consumes that stream a chunk at a time so callers get
// live tool-call granularity, and hands back the same {@link ClaudeEnvelope}
// the buffered parser produced, built from the terminal `result` frame only.
//
// `--verbose` is NOT optional. Measured on claude 2.1.222 (ux-v2 b5): without
// it the CLI refuses before any API call with
//   Error: When using --print, --output-format=stream-json requires --verbose
// The same argv is emitted by `pipeline-runner`'s department adapter
// (`src/department/claude-code.ts` buildClaudeArgs) — this module is the CLI
// side of the same contract.
//
// THE PARSER CONTRACT (ux-v2 `02` § Streaming, rule matrix 31):
//
//   1. Discriminate on `(type, subtype)`, NEVER on `type` alone. Top-level
//      `type` is `system` | `assistant` | `user` | `stream_event` | `result`.
//      `compact_boundary`, `api_retry` and `plugin_install` are `system`
//      SUBTYPES, not top-level types — a parser switching on `type` alone
//      would never match them. `hook_started` / `hook_progress` /
//      `hook_response` are separate SDK message types.
//   2. Startup frames arrive BEFORE `system`/`init`: `plugin_install` when
//      CLAUDE_CODE_SYNC_PLUGIN_INSTALL is set, and the hook lifecycle trio
//      while a SessionStart or Setup hook runs. Nothing here assumes `init`
//      is first.
//   3. An unknown top-level `type` — AND an unknown `system` subtype — is
//      IGNORED and COUNTED, never thrown. The union grows without notice;
//      `task_progress` and `commands_changed` are not documented stream-json
//      types and are deliberately treated as unknown rather than as contract.
//      (So are `rate_limit_event` and `system`/`background_tasks_changed`,
//      which pipeline-runner has observed on 2.1.220 but `02` does not list:
//      counted, ignored, harmless either way.)
//   4. A MISSING terminal `result` is not an error. SIGTERM aborts the turn,
//      runs SessionEnd hooks and exits 143 — the stream simply stops. `end()`
//      returns a null envelope and `saw_result: false`; it never synthesizes
//      a failure.
//   5. TOKENS COME FROM THE TERMINAL `result` FRAME ONLY. `assistant` frames
//      carry their own per-turn `message.usage`; accumulating those AND the
//      terminal frame would double-count every token in the run. The terminal
//      frame is already the session total — see tests/stream-json.test.ts,
//      which asserts equality against the transcript fold on a multi-turn
//      fixture generated from ONE turn list.
//
// Subagent attribution: `assistant`/`user` frames carry a top-level
// `parent_tool_use_id` naming the tool call that spawned the context they were
// produced in. Chaining those gives each tool call a DEPTH. Measured on claude
// 2.1.222 with `--forward-subagent-text` never passed and
// CLAUDE_CODE_FORWARD_SUBAGENT_TEXT confirmed unset (ux-v2 b5, probe 5), a
// genuine two-level nest put a DEPTH-2 `tool_use` in the stream, correctly
// chained: forwarding is not depth-1-only. Depth is therefore computed, not
// assumed — and it is not a privacy control: the metadata allowlist is.
//
// Everything here is defensive: malformed lines are counted and dropped, no
// input throws, and the buffers are bounded.

import { envelopeFromResultFrame, parseEnvelope, type ClaudeEnvelope } from './envelope';

/**
 * Top-level stream-json message types.
 *
 * The first five are `02` § Streaming's documented union. The hook lifecycle
 * trio are documented there as SEPARATE message types — and the TS SDK does
 * define them that way — but the shipped binary does not emit them in that
 * position: see {@link STREAM_SYSTEM_SUBTYPES}. Both spellings are accepted so
 * a frame is "known" wherever it turns up.
 *
 * `rate_limit_event` is MEASURED, not documented: it appears in a real
 * 2.1.222 stream (quota warning) and pipeline-runner's adapter already drops
 * it by name. Accepting it here only means it stops inflating the unknown
 * tally — the handling is identical either way.
 */
export const STREAM_TYPES: ReadonlySet<string> = new Set([
  // documented (`02` § Streaming)
  'system',
  'assistant',
  'user',
  'stream_event',
  'result',
  'hook_started',
  'hook_progress',
  'hook_response',
  // measured on claude 2.1.222
  'rate_limit_event',
]);

/**
 * `system` subtypes.
 *
 * `init` is the session announcement; `compact_boundary`, `api_retry` and
 * `plugin_install` are the three an earlier design revision wrongly listed as
 * TOP-LEVEL types — they are subtypes, which is why nothing here may
 * discriminate on `type` alone.
 *
 * The rest are MEASURED, from a real `claude -p --output-format stream-json
 * --verbose` capture on 2.1.222 (ux-v2 b6). Two things that capture settled:
 *
 *   - the hook lifecycle frames arrive as `{"type":"system","subtype":
 *     "hook_started"|"hook_response", hook_id, hook_name, hook_event, …}` —
 *     i.e. as SUBTYPES, not as the top-level types `02` describes. Recorded
 *     here as measured; `02` is not rewritten from this repo.
 *   - `thinking_tokens` is emitted several times per turn and appears in no
 *     design document at all.
 *
 * `background_tasks_changed` comes from pipeline-runner's own observation of
 * 2.1.220 (`src/department/claude-code.ts`).
 *
 * None of this is load-bearing: an unlisted subtype is ignored exactly like a
 * listed one it has no case for. The list only keeps `counts.unknown` meaning
 * "genuinely new" instead of "ordinary traffic".
 */
export const STREAM_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  // documented (`02` § Streaming)
  'init',
  'compact_boundary',
  'api_retry',
  'plugin_install',
  // measured on claude 2.1.222 / 2.1.220
  'hook_started',
  'hook_progress',
  'hook_response',
  'thinking_tokens',
  'background_tasks_changed',
]);

/** One `tool_use` block seen in the stream, with its subagent attribution. */
export interface StreamToolCall {
  /** The `tool_use` block id (`toolu_…`). */
  id: string;
  tool: string;
  /** The frame's `parent_tool_use_id` — the tool call that spawned the context
   *  this call was made in. Null for the main conversation. */
  parent_tool_use_id: string | null;
  /** Ancestors in the `parent_tool_use_id` chain: 0 = main conversation,
   *  1 = inside a subagent, 2 = inside a subagent's subagent (measured real on
   *  2.1.222 — see the header). */
  depth: number;
}

/** Frame tallies. Every line that arrives is counted somewhere — that is what
 *  makes "unknown ⇒ ignored" auditable rather than silent. */
export interface StreamCounts {
  /** Lines that parsed to a JSON object. */
  frames: number;
  /** Lines that did not (wrapper/shim chatter, a truncated final line). */
  non_json: number;
  /** Frames whose `(type, subtype)` is not in the documented contract. */
  unknown: number;
  /** Per-kind tally, keyed `type` — or `system/<subtype>` for `system` frames,
   *  because `system` alone is not a discriminator. */
  by_kind: Record<string, number>;
}

/** What a finished (or abandoned) stream amounted to. */
export interface StreamSummary {
  /** The terminal `result` frame as the shared envelope shape, or null when
   *  the stream carried none (SIGTERM/exit 143 — NOT an error). */
  envelope: ClaudeEnvelope | null;
  /** True when a `type:"result"` frame was seen. */
  saw_result: boolean;
  counts: StreamCounts;
  /** Every `tool_use` seen, bounded by {@link MAX_TRACKED_TOOL_CALLS}. */
  tool_calls: StreamToolCall[];
  /** Total `tool_use` blocks — unbounded, unlike `tool_calls`. */
  tools_called: number;
  /** The deepest `parent_tool_use_id` chain observed (0 = no subagent calls). */
  max_depth: number;
}

export interface StreamParserOptions {
  /** Live hook: fired for each `tool_use` as its frame arrives. */
  onToolCall?: (call: StreamToolCall) => void;
  /** Live hook: fired for each line that was not a JSON object — a wrapper
   *  script's own chatter, which callers usually relay verbatim. */
  onNonJson?: (line: string) => void;
}

/** Hard ceiling on a single un-terminated line before it is abandoned as
 *  garbage (never thrown). Far above any real frame. */
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
/** Ceiling on the not-a-stream fallback buffer (see {@link ClaudeStreamParser.end}). */
const MAX_FALLBACK_BYTES = 1024 * 1024;
/** Ceiling on the retained tool-call list; `tools_called` keeps counting past it. */
const MAX_TRACKED_TOOL_CALLS = 2000;
/** Ceiling on the id→parent map used for depth (FIFO eviction past it). */
const MAX_TRACKED_PARENTS = 10000;
/** Ceiling on one depth walk — a malformed/cyclic chain can never spin. */
const MAX_DEPTH_WALK = 64;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * A stream-json reader fed a chunk at a time.
 *
 * ```ts
 * const p = new ClaudeStreamParser({ onToolCall: (c) => log(c.tool) });
 * child.stdout.on('data', (d) => p.push(String(d)));
 * child.on('close', () => { p.end(); use(p.summary()); });
 * ```
 *
 * `push()` and `end()` never throw, whatever arrives.
 */
export class ClaudeStreamParser {
  private pending = '';
  /** Raw text kept ONLY until the first line that parses as a JSON object —
   *  see {@link end} for why. Empty for any real stream-json run. */
  private fallback = '';
  private fallbackOpen = true;
  private envelope: ClaudeEnvelope | null = null;
  private sawResult = false;
  private ended = false;
  private counts: StreamCounts = { frames: 0, non_json: 0, unknown: 0, by_kind: {} };
  private calls: StreamToolCall[] = [];
  private toolsCalled = 0;
  private maxDepth = 0;
  /** tool_use id → the `parent_tool_use_id` of the frame that carried it. */
  private parents = new Map<string, string | null>();

  constructor(private readonly opts: StreamParserOptions = {}) {}

  /** Feed the next stdout chunk. Partial lines are held until their newline. */
  push(chunk: string): void {
    if (this.ended || chunk.length === 0) return;
    this.pending += chunk;
    for (;;) {
      const nl = this.pending.indexOf('\n');
      if (nl === -1) break;
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      this.line(line);
    }
    if (this.pending.length > MAX_PENDING_BYTES) {
      // Not a line — abandon it rather than grow without bound.
      this.counts.non_json += 1;
      this.pending = '';
    }
  }

  /**
   * Close the stream: flush a trailing partial line, then — ONLY when no
   * `result` frame ever arrived and nothing on this stream parsed as JSON —
   * fall back to the buffered {@link parseEnvelope}. That fallback exists for
   * custom `--executor-cmd` templates that still print one pretty-printed
   * `--output-format json` envelope across several lines: none of those lines
   * parses alone, so the whole text is retried as one document. A real
   * stream-json run closes the fallback buffer on its FIRST frame and never
   * pays for it.
   *
   * A stream that ends with no `result` at all (SIGTERM, exit 143) is left
   * exactly as it is: null envelope, `saw_result: false`, no error.
   */
  end(): void {
    if (this.ended) return;
    if (this.pending.length > 0) {
      const last = this.pending;
      this.pending = '';
      this.line(last);
    }
    this.ended = true;
    if (!this.sawResult && this.fallback.length > 0) {
      this.envelope = parseEnvelope(this.fallback);
      if (this.envelope !== null) this.sawResult = true;
    }
  }

  summary(): StreamSummary {
    return {
      envelope: this.envelope,
      saw_result: this.sawResult,
      counts: { ...this.counts, by_kind: { ...this.counts.by_kind } },
      tool_calls: [...this.calls],
      tools_called: this.toolsCalled,
      max_depth: this.maxDepth,
    };
  }

  // -- internals ------------------------------------------------------------

  private line(raw: string): void {
    const text = raw.trim();
    if (text.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed)) {
      this.counts.non_json += 1;
      this.keepForFallback(raw);
      this.opts.onNonJson?.(raw);
      return;
    }
    // The first real frame proves this IS a stream — the whole-document
    // fallback can never apply, so stop paying for it.
    this.fallbackOpen = false;
    this.fallback = '';
    this.counts.frames += 1;
    this.frame(parsed);
  }

  private keepForFallback(raw: string): void {
    if (!this.fallbackOpen || this.fallback.length > MAX_FALLBACK_BYTES) return;
    this.fallback += raw + '\n';
  }

  /** Discriminate on `(type, subtype)` — rule 1. */
  private frame(frame: Record<string, unknown>): void {
    const type = typeof frame.type === 'string' ? frame.type : '';
    const subtype = typeof frame.subtype === 'string' ? frame.subtype : '';
    const kind = type === 'system' ? `system/${subtype || 'unknown'}` : type || 'unknown';
    this.counts.by_kind[kind] = (this.counts.by_kind[kind] ?? 0) + 1;

    const known = type === 'system' ? STREAM_SYSTEM_SUBTYPES.has(subtype) : STREAM_TYPES.has(type);
    if (!known) {
      // Rule 3: counted, ignored, never thrown — including a `system` frame
      // whose SUBTYPE is new, which a `type`-only switch would have accepted.
      this.counts.unknown += 1;
      return;
    }

    switch (type) {
      case 'result':
        this.sawResult = true;
        // Rule 5: the ONLY place usage/cost is taken from. Last one wins — a
        // stream carries exactly one, but a wrapper replaying two must not
        // accumulate them.
        this.envelope = envelopeFromResultFrame(frame) ?? this.envelope;
        return;
      case 'assistant':
      case 'user':
        this.message(frame);
        return;
      default:
        // system/*, stream_event, hook_* — real frames with nothing to fold.
        return;
    }
  }

  private message(frame: Record<string, unknown>): void {
    const message = frame.message;
    if (!isRecord(message)) return;
    const content = message.content;
    if (!Array.isArray(content)) return;
    const parent = str(frame.parent_tool_use_id);
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      const id = str(block.id);
      const tool = str(block.name) ?? 'unknown';
      this.toolsCalled += 1;
      const depth = this.depthOf(parent);
      if (depth > this.maxDepth) this.maxDepth = depth;
      if (id !== null) this.rememberParent(id, parent);
      const call: StreamToolCall = { id: id ?? '', tool, parent_tool_use_id: parent, depth };
      if (this.calls.length < MAX_TRACKED_TOOL_CALLS) this.calls.push(call);
      this.opts.onToolCall?.(call);
    }
  }

  private rememberParent(id: string, parent: string | null): void {
    if (this.parents.size >= MAX_TRACKED_PARENTS) {
      const oldest = this.parents.keys().next();
      if (!oldest.done) this.parents.delete(oldest.value);
    }
    this.parents.set(id, parent);
  }

  /** Ancestors of a frame's `parent_tool_use_id`: the depth of the tool calls
   *  that frame carries. Bounded and cycle-safe. */
  private depthOf(parent: string | null): number {
    let depth = 0;
    let cursor = parent;
    const seen = new Set<string>();
    while (cursor !== null && depth < MAX_DEPTH_WALK && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = this.parents.get(cursor) ?? null;
    }
    return depth;
  }
}

/**
 * Parse an ALREADY-BUFFERED stdout through the same parser — the path taken
 * when a caller (an injected test executor, a custom wrapper whose output was
 * captured whole) hands over text rather than chunks. Identical contract to
 * feeding it incrementally.
 */
export function parseStream(stdout: string): StreamSummary {
  const parser = new ClaudeStreamParser();
  parser.push(stdout);
  parser.end();
  return parser.summary();
}
