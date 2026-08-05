// lib/stream-json.ts — the `--output-format stream-json --verbose` parser
// contract (ux-v2 b6, `02` § Streaming + rule matrix 31).
//
// Every frame shape below is taken from a REAL stream: the terminal `result`
// lines are verbatim from the b5 G4 probes against claude 2.1.222
// (.taskflow/2026-08-03-ux-v2/b5-g4-evidence-output.md), and the subagent
// chain is that evidence's measured depth-2 nest, ids included.
//
// The load-bearing assertion in this file is the last describe block: the
// stream's token totals must equal the end-of-run transcript fold EXACTLY.
// Both sides are generated from ONE list of turns, so a parser that dropped a
// turn — or, the real trap, one that accumulated the per-turn `assistant`
// usage ON TOP of the terminal `result` totals — fails it. The stream is for
// liveness, the fold is for tokens; they are not redundant and they must not
// disagree.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ClaudeStreamParser,
  parseStream,
  STREAM_SYSTEM_SUBTYPES,
  STREAM_TYPES,
  type StreamToolCall,
} from '../src/lib/stream-json';
import { addUsage, emptyUsage } from '../src/lib/envelope';
import { foldStepSessionTranscripts, readStepSessionRefs } from '../src/lib/step-transcripts';
import { encodeClaudeProjectDir } from '../src/lib/vendor/transcript-walk';

const line = (o: unknown): string => JSON.stringify(o) + '\n';

/** The `system`/`init` announcement, trimmed to the fields anything reads. */
const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'b083036e-ccd4-4b3a-9415-3d0c67ec51f4',
  model: 'claude-haiku-4-5-20251001',
  tools: ['Bash', 'Read'],
};

/** b5 probe 1, verbatim shape: a success `result` carrying structured_output
 *  — the proof `--json-schema` survives `--output-format stream-json`. */
const RESULT_SUCCESS = {
  is_error: false,
  duration_api_ms: 2439,
  num_turns: 2,
  stop_reason: 'tool_use',
  session_id: 'b083036e-ccd4-4b3a-9415-3d0c67ec51f4',
  total_cost_usd: 0.067023,
  usage: {
    input_tokens: 11,
    output_tokens: 97,
    cache_read_input_tokens: 14203,
    cache_creation_input_tokens: 1902,
  },
  terminal_reason: 'completed',
  subtype: 'success',
  api_error_status: null,
  result: '{"animal":"cat","sound":"meow"}',
  structured_output: { animal: 'cat', sound: 'meow' },
  type: 'result',
  duration_ms: 3555,
  uuid: '7752e1fa-2398-43ba-8c20-bde5dca91613',
};

/** b5 probe 4a: `subtype:"success"`, `is_error:false`, and the
 *  `structured_output` KEY SIMPLY ABSENT — a failure the parser must surface
 *  as "no structured output", not as an error. */
const RESULT_SUCCESS_NO_STRUCTURED = {
  is_error: false,
  num_turns: 4,
  stop_reason: 'end_turn',
  session_id: 'f6928595-260d-470c-8d13-ed5facc26a0b',
  total_cost_usd: 0.0174909,
  permission_denials: [
    {
      tool_name: 'StructuredOutput',
      tool_use_id: 'toolu_01Kp9uckzTTdpDNWw79QNAN5',
      tool_input: { animal: 'dog', sound: 'bark' },
    },
  ],
  terminal_reason: 'completed',
  subtype: 'success',
  api_error_status: null,
  result: 'I attempted to call the StructuredOutput tool as you instructed, but the system permission is still being denied...',
  type: 'result',
};

/** b5 probe 4b: retry-exhausted — `is_error:true`, NO `result` key, NO
 *  `structured_output` key, `terminal_reason` naming the cause. */
const RESULT_RETRY_EXHAUSTED = {
  is_error: true,
  num_turns: 6,
  stop_reason: 'tool_use',
  session_id: '09f24b09-c1e4-44f0-94b7-520bdf54f153',
  total_cost_usd: 0.0851593,
  permission_denials: [],
  terminal_reason: 'structured_output_retry_exhausted',
  subtype: 'error_max_structured_output_retries',
  errors: ['Failed to provide valid structured output after 5 attempts'],
  type: 'result',
};

// ---------------------------------------------------------------------------
// (type, subtype) discrimination
// ---------------------------------------------------------------------------

describe('discrimination is on (type, subtype), never on type alone', () => {
  test('the three system SUBTYPES are recognized as system frames, not as top-level types', () => {
    // The regression this pins: an earlier design revision listed
    // compact_boundary / api_retry / plugin_install as TOP-LEVEL types. They
    // are not — a parser switching on `type` alone never matches them, and a
    // parser that put them in the type set would count real frames as unknown.
    for (const subtype of ['compact_boundary', 'api_retry', 'plugin_install']) {
      expect(STREAM_TYPES.has(subtype)).toBe(false);
      expect(STREAM_SYSTEM_SUBTYPES.has(subtype)).toBe(true);
    }
    const s = parseStream(
      line({ type: 'system', subtype: 'plugin_install', plugin: 'pipeline' }) +
        line(INIT) +
        line({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } }) +
        line({ type: 'system', subtype: 'api_retry', attempt: 2 }) +
        line(RESULT_SUCCESS),
    );
    expect(s.counts.frames).toBe(5);
    expect(s.counts.unknown).toBe(0);
    expect(s.counts.by_kind).toEqual({
      'system/plugin_install': 1,
      'system/init': 1,
      'system/compact_boundary': 1,
      'system/api_retry': 1,
      result: 1,
    });
    expect(s.saw_result).toBe(true);
  });

  test('startup frames arriving BEFORE system/init are ordinary frames (hook trio + plugin_install)', () => {
    // Documented order: plugin_install (CLAUDE_CODE_SYNC_PLUGIN_INSTALL) and
    // the hook lifecycle trio (SessionStart / Setup) precede `init`. Nothing
    // here may assume `init` is first.
    const s = parseStream(
      line({ type: 'plugin_install', name: 'not-the-documented-shape' }) + // decoy: see the unknown test
        line({ type: 'hook_started', hook_name: 'SessionStart' }) +
        line({ type: 'hook_progress', hook_name: 'SessionStart' }) +
        line({ type: 'hook_response', hook_name: 'SessionStart' }) +
        line(INIT) +
        line(RESULT_SUCCESS),
    );
    expect(s.counts.by_kind.hook_started).toBe(1);
    expect(s.counts.by_kind.hook_progress).toBe(1);
    expect(s.counts.by_kind.hook_response).toBe(1);
    // The decoy — `plugin_install` as a TOP-LEVEL type — is exactly the shape
    // the corrected contract says does not exist, so it lands in `unknown`.
    expect(s.counts.by_kind.plugin_install).toBe(1);
    expect(s.counts.unknown).toBe(1);
    expect(s.envelope?.subtype).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// What a REAL 2.1.222 stream actually contains
// ---------------------------------------------------------------------------

describe('a captured claude 2.1.222 stream (ux-v2 b6, `claude -p --output-format stream-json --verbose --model haiku`)', () => {
  // Verbatim frame SHAPES from a real capture (ids/paths replaced, key sets
  // and the type/subtype pairs untouched). Two things this measured, which no
  // design document says:
  //
  //   1. the hook lifecycle frames arrive as `system` SUBTYPES —
  //      {"type":"system","subtype":"hook_started",…} — not as the top-level
  //      types `02` § Streaming describes. That is exactly the discrimination
  //      trap in reverse, and the reason nothing may key on `type` alone.
  //   2. `system`/`thinking_tokens` and top-level `rate_limit_event` exist and
  //      are frequent, and appear in no design document at all.
  //
  // Both are handled either way — the contract's unknown rule made the run
  // work before they were listed. Listing them only keeps `unknown` meaning
  // "genuinely new".
  const CAPTURE =
    line({
      type: 'system',
      subtype: 'hook_started',
      hook_id: '801afa38-f5c0-421c-8dbe-ae709ac83426',
      hook_name: 'SessionStart:startup',
      hook_event: 'SessionStart',
      session_id: 'sess',
    }) +
    line({
      type: 'system',
      subtype: 'hook_response',
      hook_id: '801afa38-f5c0-421c-8dbe-ae709ac83426',
      hook_name: 'SessionStart:startup',
      exit_code: 0,
      outcome: 'success',
      session_id: 'sess',
    }) +
    line({ type: 'system', subtype: 'init', cwd: '/tmp/probe', session_id: 'sess', tools: ['Bash'] }) +
    line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 4, estimated_tokens_delta: 4, session_id: 'sess' }) +
    line({
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: 'sess',
      message: {
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 4, output_tokens: 60 },
        content: [{ type: 'tool_use', id: 'toolu_01GmSxiEr4vNBGLYf', name: 'Bash', input: { command: 'echo b6probe' } }],
      },
    }) +
    line({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.83 },
      session_id: 'sess',
    }) +
    line({
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'sess',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01GmSxiEr4vNBGLYf', content: 'b6probe' }] },
    }) +
    line({ ...RESULT_SUCCESS, usage: { input_tokens: 18, output_tokens: 147, cache_read_input_tokens: 50580, cache_creation_input_tokens: 7998 } });

  test('every kind the real binary emitted is recognized — nothing lands in `unknown`', () => {
    const s = parseStream(CAPTURE);
    expect(s.counts.by_kind).toEqual({
      'system/hook_started': 1,
      'system/hook_response': 1,
      'system/init': 1,
      'system/thinking_tokens': 1,
      assistant: 1,
      rate_limit_event: 1,
      user: 1,
      result: 1,
    });
    expect(s.counts.unknown).toBe(0);
    expect(s.counts.non_json).toBe(0);
    expect(s.tools_called).toBe(1);
    expect(s.envelope?.usage).toEqual({ input: 18, output: 147, cache_read: 50580, cache_creation: 7998 });
  });

  test('the hook trio is accepted in BOTH positions — the SDK type and the measured `system` subtype', () => {
    // `02` says separate message types; the binary emits subtypes. Neither
    // spelling may be counted as unknown, because both occur.
    expect(STREAM_TYPES.has('hook_started')).toBe(true);
    expect(STREAM_SYSTEM_SUBTYPES.has('hook_started')).toBe(true);
    const s = parseStream(line({ type: 'hook_progress', hook_name: 'Setup' }) + line({ type: 'system', subtype: 'hook_progress' }));
    expect(s.counts.unknown).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DoD: unknown type AND unknown system subtype ⇒ ignored and COUNTED, never thrown
// ---------------------------------------------------------------------------

describe('unknown frames (matrix 31)', () => {
  test('an invented system subtype and an invented top-level type are BOTH counted, neither dropped nor fatal', () => {
    const feed =
      line(INIT) +
      // 1. an invented top-level type — the union grows without notice.
      line({ type: 'quantum_entanglement_event', payload: { anything: true } }) +
      // 2. an invented `system` SUBTYPE — the case a type-only switch would
      //    have silently accepted as a known `system` frame.
      line({ type: 'system', subtype: 'tachyon_boundary', detail: 'from the future' }) +
      // 3. the two named-but-undocumented ones the contract says to treat as
      //    unknown rather than as contract.
      line({ type: 'task_progress', progress: 0.5 }) +
      line({ type: 'commands_changed', commands: [] }) +
      line(RESULT_SUCCESS);

    // Never thrown — asserted on the incremental path, which is the one
    // production uses.
    const parser = new ClaudeStreamParser();
    expect(() => {
      for (const chunk of feed.split('\n')) parser.push(chunk + '\n');
      parser.end();
    }).not.toThrow();
    const s = parser.summary();

    // COUNTED, not dropped: every unknown frame is in `frames`, in `unknown`,
    // and individually visible in `by_kind`.
    expect(s.counts.frames).toBe(6);
    expect(s.counts.unknown).toBe(4);
    expect(s.counts.by_kind.quantum_entanglement_event).toBe(1);
    expect(s.counts.by_kind['system/tachyon_boundary']).toBe(1);
    expect(s.counts.by_kind.task_progress).toBe(1);
    expect(s.counts.by_kind.commands_changed).toBe(1);
    // IGNORED: they change nothing else — the run still resolves normally.
    expect(s.saw_result).toBe(true);
    expect(s.envelope?.structured_output).toEqual({ animal: 'cat', sound: 'meow' });
    expect(s.tools_called).toBe(0);
  });

  test('a system frame with NO subtype, and a frame with no type at all, are counted rather than fatal', () => {
    const s = parseStream(line({ type: 'system' }) + line({ no_type: true }) + line(RESULT_SUCCESS));
    expect(s.counts.by_kind['system/unknown']).toBe(1);
    expect(s.counts.by_kind.unknown).toBe(1);
    expect(s.counts.unknown).toBe(2);
    expect(s.envelope).not.toBeNull();
  });

  test('garbage lines are counted as non_json, relayed verbatim, and never interrupt the stream', () => {
    const seen: string[] = [];
    const parser = new ClaudeStreamParser({ onNonJson: (l) => seen.push(l) });
    parser.push(line(INIT));
    parser.push('wrapper script says hello\n');
    parser.push('{"truncated": \n');
    parser.push('[1,2,3]\n'); // valid JSON, but not an object
    parser.push(line(RESULT_SUCCESS));
    parser.end();
    const s = parser.summary();
    expect(s.counts.non_json).toBe(3);
    expect(seen).toEqual(['wrapper script says hello', '{"truncated": ', '[1,2,3]']);
    expect(s.envelope?.session_id).toBe('b083036e-ccd4-4b3a-9415-3d0c67ec51f4');
  });
});

// ---------------------------------------------------------------------------
// The terminal result frame: success, and the two measured failure shapes
// ---------------------------------------------------------------------------

describe('terminal result frame', () => {
  test('success carries structured_output, usage and cost through to the envelope (b5 probe 1)', () => {
    const s = parseStream(line(INIT) + line(RESULT_SUCCESS));
    expect(s.envelope).toEqual({
      is_error: false,
      subtype: 'success',
      result: '{"animal":"cat","sound":"meow"}',
      session_id: 'b083036e-ccd4-4b3a-9415-3d0c67ec51f4',
      structured_output: { animal: 'cat', sound: 'meow' },
      total_cost_usd: 0.067023,
      usage: { input: 11, output: 97, cache_read: 14203, cache_creation: 1902 },
      num_turns: 2,
      permission_denials: [],
    });
  });

  test('success with the structured_output key ABSENT is not an error, and yields no structured output (b5 probe 4a)', () => {
    const s = parseStream(line(INIT) + line(RESULT_SUCCESS_NO_STRUCTURED));
    expect(s.saw_result).toBe(true);
    expect(s.envelope?.is_error).toBe(false);
    expect(s.envelope?.subtype).toBe('success');
    // The whole point of this shape: callers must decide on structured_output,
    // not on is_error/subtype.
    expect(s.envelope?.structured_output).toBeNull();
    expect(s.envelope?.result).toContain('permission is still being denied');
    expect(s.envelope?.permission_denials).toEqual([{ tool_name: 'StructuredOutput', file_path: null }]);
  });

  test('error_max_structured_output_retries: is_error true, no result key, no structured_output (b5 probe 4b)', () => {
    const s = parseStream(line(INIT) + line(RESULT_RETRY_EXHAUSTED));
    expect(s.envelope?.is_error).toBe(true);
    expect(s.envelope?.subtype).toBe('error_max_structured_output_retries');
    expect(s.envelope?.result).toBeNull();
    expect(s.envelope?.structured_output).toBeNull();
  });

  test('a MISSING terminal result (SIGTERM, exit 143) is not an error — null envelope, no throw', () => {
    const parser = new ClaudeStreamParser();
    parser.push(line(INIT));
    parser.push(
      line({
        type: 'assistant',
        message: { role: 'assistant', usage: { input_tokens: 4, output_tokens: 8 }, content: [{ type: 'text', text: 'working' }] },
      }),
    );
    // …and the process is killed mid-frame: a partial line, then nothing.
    parser.push('{"type":"assistant","message":{"role":"assist');
    expect(() => parser.end()).not.toThrow();
    const s = parser.summary();
    expect(s.saw_result).toBe(false);
    expect(s.envelope).toBeNull();
    // The truncated tail is accounted for, not silently swallowed.
    expect(s.counts.non_json).toBe(1);
    expect(s.counts.frames).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Chunking and the buffered fallback
// ---------------------------------------------------------------------------

describe('chunking', () => {
  test('frames split across arbitrary chunk boundaries reassemble; CRLF is tolerated', () => {
    const feed = line(INIT) + line(RESULT_SUCCESS).replace('\n', '\r\n');
    const parser = new ClaudeStreamParser();
    for (let i = 0; i < feed.length; i += 7) parser.push(feed.slice(i, i + 7));
    parser.end();
    const s = parser.summary();
    expect(s.counts.frames).toBe(2);
    expect(s.counts.non_json).toBe(0);
    expect(s.envelope?.total_cost_usd).toBe(0.067023);
  });

  test('a custom template that still prints ONE pretty-printed --output-format json object is absorbed', () => {
    // The end-of-stream fallback: none of these lines parses alone, so the
    // whole text is retried as one document. A user's `--executor-cmd`
    // override predating the swap keeps working.
    const s = parseStream(JSON.stringify(RESULT_SUCCESS, null, 2) + '\n');
    expect(s.saw_result).toBe(true);
    expect(s.envelope?.structured_output).toEqual({ animal: 'cat', sound: 'meow' });
    expect(s.counts.frames).toBe(0);
  });

  test('empty / whitespace-only output yields a null envelope and no error', () => {
    expect(parseStream('').envelope).toBeNull();
    expect(parseStream('   \n\n  \n').envelope).toBeNull();
    expect(parseStream('   \n\n  \n').saw_result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Subagent attribution via parent_tool_use_id — the MEASURED depth, not an
// assumed one.
// ---------------------------------------------------------------------------

describe('subagent attribution (parent_tool_use_id)', () => {
  // Ids and shape from b5 probe 5 (claude 2.1.222, --forward-subagent-text
  // never passed, CLAUDE_CODE_FORWARD_SUBAGENT_TEXT confirmed unset):
  //   line 28  Agent  parent=None            → the top-level dispatch
  //   line 39  Agent  parent=toolu_019NJJ…   → level-1 subagent dispatching level-2
  //   line 58  Bash   parent=toolu_018hgH…   → the level-2 subagent's own call
  const L1 = 'toolu_019NJJygCeH2wKrX86Ccd7RV';
  const L2 = 'toolu_018hgHg4TXLRud1tTfMLMUtc';
  const BASH = 'toolu_01ASK6Zs3Z6bznxayo4XV4bc';

  const NESTED_STREAM =
    line(INIT) +
    line({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: L1, name: 'Agent', input: { subagent_type: 'level1', prompt: 'GO' } }],
      },
    }) +
    line({
      type: 'assistant',
      parent_tool_use_id: L1,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: L2, name: 'Agent', input: { subagent_type: 'level2', prompt: 'GO' } }],
      },
    }) +
    line({
      type: 'assistant',
      parent_tool_use_id: L2,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: BASH, name: 'Bash', input: { command: 'echo NESTED_MARKER_7f3a9c2' } }],
      },
    }) +
    line({
      type: 'user',
      parent_tool_use_id: L2,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: BASH, content: 'NESTED_MARKER_7f3a9c2' }] },
    }) +
    line({ ...RESULT_SUCCESS, result: 'NESTED_MARKER_7f3a9c2' });

  test('the depth-2 nest b5 measured is attributed by its parent chain, not assumed to be depth-1', () => {
    const live: StreamToolCall[] = [];
    const parser = new ClaudeStreamParser({ onToolCall: (c) => live.push(c) });
    parser.push(NESTED_STREAM);
    parser.end();
    const s = parser.summary();

    expect(s.tool_calls).toEqual([
      { id: L1, tool: 'Agent', parent_tool_use_id: null, depth: 0 },
      { id: L2, tool: 'Agent', parent_tool_use_id: L1, depth: 1 },
      { id: BASH, tool: 'Bash', parent_tool_use_id: L2, depth: 2 },
    ]);
    // DEPTH 2 — a tool call made by a subagent spawned BY a subagent, present
    // in the stream with the forwarding flag unset. Forwarding is not
    // depth-1-only on claude 2.1.222; `02`/`03` F2 record the correction. The
    // allowlist, not the depth, is the privacy control.
    expect(s.max_depth).toBe(2);
    expect(s.tools_called).toBe(3);
    // The live hook fires per call as the frame arrives — same objects, in
    // stream order. This is the liveness the swap buys.
    expect(live).toEqual(s.tool_calls);
  });

  test('an orphaned parent id still yields a depth ≥ 1 rather than being mis-attributed to the main conversation', () => {
    const s = parseStream(
      line(INIT) +
        line({
          type: 'assistant',
          parent_tool_use_id: 'toolu_never_announced',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: {} }] },
        }) +
        line(RESULT_SUCCESS),
    );
    expect(s.tool_calls[0].depth).toBe(1);
    expect(s.max_depth).toBe(1);
  });

  test('a cyclic parent chain terminates instead of spinning', () => {
    const s = parseStream(
      line({
        type: 'assistant',
        parent_tool_use_id: 'b',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'X', input: {} }] },
      }) +
        line({
          type: 'assistant',
          parent_tool_use_id: 'a',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Y', input: {} }] },
        }),
    );
    expect(s.tools_called).toBe(2);
    expect(s.max_depth).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// THE token equality: stream totals === transcript fold, exactly.
// ---------------------------------------------------------------------------

interface Turn {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  tools: { id: string; name: string }[];
  /** Non-null → the turn happened inside a subagent context. */
  parent: string | null;
  ts: string;
}

/** One multi-turn run, described ONCE. Both renderings below are generated
 *  from this list, so the two sides cannot drift apart in the fixture — only
 *  in the code under test, which is the point. */
const TURNS: Turn[] = [
  { input: 1200, output: 340, cache_read: 18000, cache_creation: 2400, tools: [{ id: 'toolu_a', name: 'Read' }], parent: null, ts: '2026-08-05T10:00:01.000Z' },
  { input: 95, output: 512, cache_read: 21000, cache_creation: 0, tools: [{ id: 'toolu_b', name: 'Bash' }, { id: 'toolu_c', name: 'Agent' }], parent: null, ts: '2026-08-05T10:00:05.000Z' },
  { input: 40, output: 128, cache_read: 900, cache_creation: 64, tools: [{ id: 'toolu_d', name: 'Edit' }], parent: 'toolu_c', ts: '2026-08-05T10:00:09.000Z' },
  { input: 7, output: 33, cache_read: 0, cache_creation: 0, tools: [], parent: null, ts: '2026-08-05T10:00:12.000Z' },
];

const sumTurns = () => ({
  input: TURNS.reduce((n, t) => n + t.input, 0),
  output: TURNS.reduce((n, t) => n + t.output, 0),
  cache_read: TURNS.reduce((n, t) => n + t.cache_read, 0),
  cache_creation: TURNS.reduce((n, t) => n + t.cache_creation, 0),
});

/** The turns as a `--output-format stream-json` stdout: per-turn `assistant`
 *  frames (each carrying its OWN usage — the double-count trap) followed by
 *  the terminal `result` whose usage is the session TOTAL, exactly as the CLI
 *  emits it. */
function renderStream(): string {
  const total = sumTurns();
  let out = line(INIT);
  for (const t of TURNS) {
    out += line({
      type: 'assistant',
      parent_tool_use_id: t.parent,
      message: {
        role: 'assistant',
        usage: {
          input_tokens: t.input,
          output_tokens: t.output,
          cache_read_input_tokens: t.cache_read,
          cache_creation_input_tokens: t.cache_creation,
        },
        content: [
          { type: 'text', text: 'thinking out loud' },
          ...t.tools.map((tool) => ({ type: 'tool_use', id: tool.id, name: tool.name, input: {} })),
        ],
      },
    });
  }
  out += line({
    ...RESULT_SUCCESS,
    usage: {
      input_tokens: total.input,
      output_tokens: total.output,
      cache_read_input_tokens: total.cache_read,
      cache_creation_input_tokens: total.cache_creation,
    },
  });
  return out;
}

/** The SAME turns as the pinned session's `~/.claude/projects/.../<id>.jsonl`
 *  transcript — what `foldStepSessionTranscripts` walks at the terminal
 *  action. */
function renderTranscript(): string {
  return TURNS.map((t) =>
    JSON.stringify({
      timestamp: t.ts,
      message: {
        role: 'assistant',
        usage: {
          input_tokens: t.input,
          output_tokens: t.output,
          cache_read_input_tokens: t.cache_read,
          cache_creation_input_tokens: t.cache_creation,
        },
        content: [
          { type: 'text', text: 'thinking out loud' },
          ...t.tools.map((tool) => ({ type: 'tool_use', id: tool.id, name: tool.name, input: {} })),
        ],
      },
    }),
  ).join('\n');
}

describe('token totals after the swap match the transcript fold EXACTLY', () => {
  let sandbox: string;
  let home: string;
  let sessionsDir: string;
  let spawnCwd: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `pipeline-stream-tokens-${Math.random().toString(36).slice(2)}`);
    home = join(sandbox, 'home');
    sessionsDir = join(sandbox, 'run', 'sessions');
    spawnCwd = join(sandbox, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, '01-a.json'),
      JSON.stringify({ session_id: 'sess-1', status: 'done', spawn_cwd: spawnCwd, questions: [], crashes: 0 }),
      'utf8',
    );
    const dir = join(home, '.claude', 'projects', encodeClaudeProjectDir(spawnCwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess-1.jsonl'), renderTranscript(), 'utf8');
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  test('stream envelope usage === transcript fold, field by field, on a multi-turn run', () => {
    const stream = parseStream(renderStream());
    const fold = foldStepSessionTranscripts(readStepSessionRefs(sessionsDir), home);
    expect(fold.found_any).toBe(true);

    // Non-trivial: an all-zero "equality" would prove nothing.
    const expected = sumTurns();
    expect(expected.input).toBe(1342);
    expect(expected.output).toBe(1013);
    expect(expected.cache_read).toBe(39900);
    expect(expected.cache_creation).toBe(2464);

    expect(stream.envelope?.usage).toEqual(expected);
    expect({
      input: fold.input_tokens,
      output: fold.output_tokens,
      cache_read: fold.cache_read_tokens,
      cache_creation: fold.cache_creation_tokens,
    }).toEqual(expected);

    // And through drive's real accumulator (`noteUsage` → addUsage), which is
    // what actually reaches `.stats/`.
    const totals = addUsage(emptyUsage(), stream.envelope!);
    expect(totals.input).toBe(fold.input_tokens);
    expect(totals.output).toBe(fold.output_tokens);
    expect(totals.cache_read).toBe(fold.cache_read_tokens);
    expect(totals.cache_creation).toBe(fold.cache_creation_tokens);
    expect(totals.cost_usd).toBe(0.067023);
  });

  test('the double-count trap: per-turn assistant usage is NOT accumulated on top of the terminal frame', () => {
    // A parser that folded every `assistant` frame's usage AND the terminal
    // `result` would report exactly twice the truth on this fixture. This
    // asserts the arithmetic of that failure so the equality above cannot be
    // satisfied by accident.
    const naive = TURNS.reduce((n, t) => n + t.input, 0) + sumTurns().input;
    expect(naive).toBe(2 * sumTurns().input);
    expect(parseStream(renderStream()).envelope?.usage?.input).toBe(sumTurns().input);
  });

  test('two spawns in one run accumulate once each — a resumed step does not double its tokens', () => {
    // drive folds one envelope per spawn (noteUsage), so N spawns = N × the
    // terminal totals and nothing else.
    const acc = emptyUsage();
    addUsage(acc, parseStream(renderStream()).envelope!);
    addUsage(acc, parseStream(renderStream()).envelope!);
    expect(acc.input).toBe(2 * sumTurns().input);
    expect(acc.output).toBe(2 * sumTurns().output);
  });

  test('the fold also sees the tool calls the stream attributed — same run, two lenses', () => {
    const stream = parseStream(renderStream());
    const fold = foldStepSessionTranscripts(readStepSessionRefs(sessionsDir), home);
    expect(stream.tools_called).toBe(4);
    expect(fold.tools_called).toBe(4);
    // The Agent spawn and the call made INSIDE it: depth 0 and depth 1.
    expect(stream.max_depth).toBe(1);
    expect(fold.agents_spawned).toBe(1);
  });
});
