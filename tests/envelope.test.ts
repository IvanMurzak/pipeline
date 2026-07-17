// lib/envelope.ts — parsing the `claude -p --output-format json` result
// envelope. The fixture mirrors a REAL envelope captured from Claude Code
// 2.1.205 during the headless spike (trimmed to the fields we consume).

import { test, expect } from 'bun:test';
import { addUsage, emptyUsage, parseEnvelope, detectProviderLimit } from '../src/lib/envelope';

/** A real-shaped envelope (Claude Code 2.1.205). */
function fixture(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 5077,
    num_turns: 2,
    result: '{"outcome":"completed"}',
    stop_reason: 'tool_use',
    session_id: 'fdecb4d9-b87d-4ae5-92c7-4182f7dc44dd',
    total_cost_usd: 0.061626,
    usage: {
      input_tokens: 9,
      cache_creation_input_tokens: 30376,
      cache_read_input_tokens: 12,
      output_tokens: 173,
      service_tier: 'standard',
    },
    permission_denials: [],
    structured_output: { outcome: 'completed', summary: 'done' },
    uuid: '23a4ce0d-06b5-4ef8-b3ed-f94588d30cb4',
    ...overrides,
  });
}

test('parseEnvelope: full envelope → every consumed field extracted', () => {
  const env = parseEnvelope(fixture());
  expect(env).not.toBeNull();
  expect(env!.is_error).toBe(false);
  expect(env!.subtype).toBe('success');
  expect(env!.result).toBe('{"outcome":"completed"}');
  expect(env!.session_id).toBe('fdecb4d9-b87d-4ae5-92c7-4182f7dc44dd');
  expect(env!.structured_output).toEqual({ outcome: 'completed', summary: 'done' });
  expect(env!.total_cost_usd).toBeCloseTo(0.061626);
  expect(env!.usage).toEqual({ input: 9, output: 173, cache_read: 12, cache_creation: 30376 });
  expect(env!.num_turns).toBe(2);
});

test('parseEnvelope: error envelope — is_error + subtype survive, structured_output null', () => {
  const env = parseEnvelope(
    fixture({ is_error: true, subtype: 'error_max_turns', structured_output: undefined, result: 'ran out of turns' }),
  );
  expect(env!.is_error).toBe(true);
  expect(env!.subtype).toBe('error_max_turns');
  expect(env!.structured_output).toBeNull();
});

test('parseEnvelope: leading noise lines are tolerated — last type:"result" line wins', () => {
  const noisy = 'launching claude...\n{"type":"progress"}\n' + fixture() + '\n';
  const env = parseEnvelope(noisy);
  expect(env).not.toBeNull();
  expect(env!.session_id).toBe('fdecb4d9-b87d-4ae5-92c7-4182f7dc44dd');
});

test('parseEnvelope: garbage / empty / non-result JSON → null', () => {
  expect(parseEnvelope('')).toBeNull();
  expect(parseEnvelope('   \n  ')).toBeNull();
  expect(parseEnvelope('not json at all')).toBeNull();
  expect(parseEnvelope('{"type":"progress"}')).toBeNull();
  expect(parseEnvelope('[1,2,3]')).toBeNull();
  expect(parseEnvelope('{"no_type":true}')).toBeNull();
});

test('parseEnvelope: missing optional fields → nulls, no throw', () => {
  const env = parseEnvelope(JSON.stringify({ type: 'result' }));
  expect(env).not.toBeNull();
  expect(env!.is_error).toBe(false);
  expect(env!.subtype).toBeNull();
  expect(env!.result).toBeNull();
  expect(env!.session_id).toBeNull();
  expect(env!.structured_output).toBeNull();
  expect(env!.total_cost_usd).toBeNull();
  expect(env!.usage).toBeNull();
  expect(env!.num_turns).toBeNull();
});

test('parseEnvelope: structured_output must be a plain object — array/string → null', () => {
  expect(parseEnvelope(fixture({ structured_output: [1, 2] }))!.structured_output).toBeNull();
  expect(parseEnvelope(fixture({ structured_output: 'text' }))!.structured_output).toBeNull();
});

test('emptyUsage/addUsage: accumulate usage and cost across envelopes', () => {
  const acc = emptyUsage();
  addUsage(acc, parseEnvelope(fixture())!);
  addUsage(acc, parseEnvelope(fixture())!);
  expect(acc).toEqual({ input: 18, output: 346, cache_read: 24, cache_creation: 60752, cost_usd: 0.123252 });
  // An envelope without usage/cost is a no-op.
  addUsage(acc, parseEnvelope(JSON.stringify({ type: 'result' }))!);
  expect(acc.input).toBe(18);
  expect(acc.cost_usd).toBeCloseTo(0.123252);
});

test('detectProviderLimit: success envelope → null', () => {
  const env = parseEnvelope(fixture())!;
  expect(detectProviderLimit(env)).toBeNull();
});

test('detectProviderLimit: error_rate_limited → rate_limit_exceeded', () => {
  const env = parseEnvelope(fixture({ is_error: true, subtype: 'error_rate_limited' }))!;
  const limit = detectProviderLimit(env);
  expect(limit).not.toBeNull();
  expect(limit!.reason).toBe('rate_limit_exceeded');
});

test('detectProviderLimit: error_overloaded → overloaded', () => {
  const env = parseEnvelope(fixture({ is_error: true, subtype: 'error_overloaded' }))!;
  const limit = detectProviderLimit(env);
  expect(limit).not.toBeNull();
  expect(limit!.reason).toBe('overloaded');
});

test('detectProviderLimit: other error subtype → null', () => {
  const env = parseEnvelope(fixture({ is_error: true, subtype: 'error_max_turns' }))!;
  expect(detectProviderLimit(env)).toBeNull();
});

test('detectProviderLimit: error with null subtype → null', () => {
  const env = parseEnvelope(fixture({ is_error: true, subtype: null }))!;
  expect(detectProviderLimit(env)).toBeNull();
});
