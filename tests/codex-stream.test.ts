// codex-stream.test.ts — c6: parseCodexJsonl, unit-level.
//
// The fixtures below are the LITERAL frames captured from real `codex exec
// --json` runs (codex-cli 0.147.0) during this task's investigation — see
// src/lib/executors/codex-stream.ts's header for the exact commands. This
// file does not re-run codex; it proves the PARSER against what codex was
// actually observed to emit.

import { describe, expect, test } from 'bun:test';
import { parseCodexJsonl } from '../src/lib/executors/codex-stream';

/** A real single-agent-message turn (the first c6 probe). */
const SIMPLE_TURN = [
  '{"type":"thread.started","thread_id":"019ff438-ec6a-7261-a29d-7d325575b120"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"DONE"}}',
  '{"type":"turn.completed","usage":{"input_tokens":29751,"cached_input_tokens":25088,"cache_write_input_tokens":0,"output_tokens":99,"reasoning_output_tokens":40}}',
  '',
].join('\n');

/** A turn that narrates before answering — TWO agent_message items, a
 *  file_change item between them (the second c6 probe). The LAST
 *  agent_message is the real final response, not the first. */
const MULTI_MESSAGE_TURN = [
  '{"type":"thread.started","thread_id":"019ff439-c0b9-78c1-b8bd-f6eec055007f"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_0","type":"file_change","changes":[{"path":"C:\\\\record.json","kind":"add"}],"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_0","type":"file_change","changes":[{"path":"C:\\\\record.json","kind":"add"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"DONE"}}',
  '{"type":"turn.completed","usage":{"input_tokens":29751,"output_tokens":99,"cached_input_tokens":25088,"cache_write_input_tokens":0,"reasoning_output_tokens":40}}',
  '',
].join('\n');

/** A turn that narrates THEN answers — proves "last agent_message wins" is
 *  not vacuous on the simple two-item fixture above (the third c6 probe:
 *  stdin-delivered prompt, codex narrated "I'll create the requested…" before
 *  the file write, then said DONE). */
const NARRATE_THEN_ANSWER_TURN = [
  '{"type":"thread.started","thread_id":"019ff441-9b60-7070-9582-3b45c0f85367"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will create the requested JSON file."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"C:\\\\record3.json","kind":"add"}],"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"C:\\\\record3.json","kind":"add"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"DONE"}}',
  '{"type":"turn.completed","usage":{"input_tokens":44791,"cached_input_tokens":39168,"cache_write_input_tokens":0,"output_tokens":155,"reasoning_output_tokens":26}}',
  '',
].join('\n');

/** The real 400 invalid_json_schema failure reproduced against
 *  --output-schema with the (non-strict) shared step-record schema — the
 *  live evidence behind DEFAULT_CODEX_EXECUTOR_TEMPLATE's decision not to use
 *  --output-schema at all. */
const SCHEMA_ERROR_TURN = [
  '{"type":"thread.started","thread_id":"019ff438-aaaa-7261-a29d-7d325575b120"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\n  \\"type\\": \\"error\\",\\n  \\"error\\": {\\n    \\"type\\": \\"invalid_request_error\\",\\n    \\"code\\": \\"invalid_json_schema\\",\\n    \\"message\\": \\"Invalid schema for response_format \'codex_output_schema\'. In context=(), \'additionalProperties\' is required to be supplied and to be false.\\",\\n    \\"param\\": \\"text.format.schema\\"\\n  },\\n  \\"status\\": 400\\n}"}',
  '{"type":"turn.failed","error":{"message":"invalid_json_schema"}}',
  '',
].join('\n');

describe('parseCodexJsonl — real codex-cli 0.147.0 fixtures', () => {
  test('a simple one-message turn: result, session_id and usage are recovered', () => {
    const env = parseCodexJsonl(SIMPLE_TURN);
    expect(env).not.toBeNull();
    expect(env!.result).toBe('DONE');
    expect(env!.session_id).toBe('019ff438-ec6a-7261-a29d-7d325575b120');
    expect(env!.is_error).toBe(false);
    expect(env!.subtype).toBe('success');
    expect(env!.usage).toEqual({ input: 29751, output: 99, cache_read: 25088, cache_creation: 0 });
    // Never populated from a codex stream — see the module header.
    expect(env!.structured_output).toBeNull();
    expect(env!.total_cost_usd).toBeNull();
    expect(env!.models_used).toEqual([]);
    expect(env!.permission_denials).toEqual([]);
  });

  test('a file_change between thread.started and the agent_message does not confuse extraction', () => {
    const env = parseCodexJsonl(MULTI_MESSAGE_TURN);
    expect(env).not.toBeNull();
    expect(env!.result).toBe('DONE');
    expect(env!.session_id).toBe('019ff439-c0b9-78c1-b8bd-f6eec055007f');
  });

  test('the LAST agent_message wins when the turn narrates before answering', () => {
    const env = parseCodexJsonl(NARRATE_THEN_ANSWER_TURN);
    expect(env).not.toBeNull();
    expect(env!.result).toBe('DONE');
    expect(env!.result).not.toContain('I will create');
  });

  test('a schema/turn failure is reported as is_error with the message captured', () => {
    const env = parseCodexJsonl(SCHEMA_ERROR_TURN);
    expect(env).not.toBeNull();
    expect(env!.is_error).toBe(true);
    expect(env!.subtype).toContain('invalid_json_schema');
    expect(env!.result).toBeNull(); // no agent_message ever arrived
  });

  test('the JSON record a step wrote to disk is untouched by this parser — it only reads the TEXT channel', () => {
    // Sanity: this module's job is rung 4 (final-response text) only; rung
    // 2/3 (the record FILE) is read elsewhere (readRecordFile in drive.ts)
    // and never routes through here.
    const recordLikeText = '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"outcome\\":\\"completed\\"}"}}\n' +
      '{"type":"thread.started","thread_id":"x"}\n';
    const env = parseCodexJsonl(recordLikeText);
    expect(env?.result).toBe('{"outcome":"completed"}');
  });
});

describe('parseCodexJsonl — never misfires on non-codex text', () => {
  test('empty / whitespace-only input is null', () => {
    expect(parseCodexJsonl('')).toBeNull();
    expect(parseCodexJsonl('   \n  \n')).toBeNull();
  });

  test('a claude stream-json capture (bare `type` words, no dotted names) is null', () => {
    const claudeShaped = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"role":"assistant","content":[]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"hi","session_id":"s1"}',
      '',
    ].join('\n');
    expect(parseCodexJsonl(claudeShaped)).toBeNull();
  });

  test('garbage / non-JSON / a plain-text banner is null, never throws', () => {
    expect(parseCodexJsonl('not json at all')).toBeNull();
    expect(parseCodexJsonl('{not valid json')).toBeNull();
    expect(() => parseCodexJsonl('{"type":"thread.started"' /* truncated */)).not.toThrow();
  });

  test('an unrecognised dotted event type is ignored, never thrown, and contributes nothing alone', () => {
    expect(parseCodexJsonl('{"type":"item.deleted","item":{"id":"x"}}\n')).toBeNull();
  });
});
