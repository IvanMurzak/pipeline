// model-conformance.test.ts — the model-alias-parity harness (d1, E16).
//
// Every case here runs against a FIXTURE shaped like a `type:"result"` frame
// (the same style tests/envelope.test.ts and tests/sdk-executor.test.ts use),
// never against a live query(). No live API call was made anywhere in this
// suite or in building tests/_model-conformance.ts.

import { describe, expect, test } from 'bun:test';
import {
  ModelMismatchError,
  ModelPinError,
  assertFullModelId,
  assertModelUsedMatches,
  isFullModelId,
  modelsUsed,
} from './_model-conformance';
import { envelopeFromResultFrame, type ClaudeEnvelope } from '../src/lib/envelope';

/** A terminal `result` frame, matching sdk-executor.test.ts's `resultFrame()`
 *  shape, with a `modelUsage` map layered on top. */
function resultFrame(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: 'done',
    session_id: 'sess-1',
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
    permission_denials: [],
    ...over,
  };
}

function envelopeWithModelUsage(modelUsage: unknown): ClaudeEnvelope {
  return envelopeFromResultFrame(resultFrame({ modelUsage }))!;
}

// ---------------------------------------------------------------------------
// DoD 1 — the alias-vs-full-id predicate, and rejecting an alias pin
// ---------------------------------------------------------------------------

describe('isFullModelId / assertFullModelId — shape-based, not a lookup table', () => {
  test('real full model ids are accepted', () => {
    for (const id of [
      'claude-opus-4-1-20250805',
      'claude-sonnet-4-5-20250929',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-haiku-20240307',
    ]) {
      expect(isFullModelId(id)).toBe(true);
      expect(() => assertFullModelId(id)).not.toThrow();
    }
  });

  test('a bracketed context-window suffix is tolerated', () => {
    expect(isFullModelId('claude-sonnet-4-5-20250929[1m]')).toBe(true);
  });

  test('today\'s known aliases are rejected', () => {
    for (const alias of ['sonnet', 'opus', 'haiku', 'fable']) {
      expect(isFullModelId(alias)).toBe(false);
      expect(() => assertFullModelId(alias)).toThrow(ModelPinError);
    }
  });

  test('an alias NOT on any hardcoded list is rejected too — the rule is shape, not a lookup', () => {
    // Stand-in for "a new alias upstream ships tomorrow": no `claude-` prefix,
    // no trailing 8-digit date. A predicate that hardcoded today's alias names
    // would let this one through undetected; the shape rule does not.
    for (const futureAlias of ['banana', 'quasar', 'sonnet-latest', 'opus-preview']) {
      expect(isFullModelId(futureAlias)).toBe(false);
    }
  });

  test('near-miss shapes that are still not a full id are rejected', () => {
    // Right prefix, no date stamp.
    expect(isFullModelId('claude-sonnet-4-5')).toBe(false);
    // Date-shaped suffix but wrong digit count.
    expect(isFullModelId('claude-opus-4-1-2025080')).toBe(false);
    // Bedrock/Foundry shape — out of scope for this predicate (see header).
    expect(isFullModelId('anthropic.claude-opus-4-1-20250805-v1:0')).toBe(false);
    // Empty / garbage.
    expect(isFullModelId('')).toBe(false);
  });

  test('assertFullModelId names the rejected value and explains the four knobs', () => {
    expect(() => assertFullModelId('sonnet')).toThrow(/"sonnet"/);
    expect(() => assertFullModelId('sonnet')).toThrow(/alias/i);
  });
});

// ---------------------------------------------------------------------------
// DoD 2 / 4 — reading the model back from modelUsage, and failing on mismatch
// ---------------------------------------------------------------------------

describe('modelsUsed / assertModelUsedMatches — evidence, not the request', () => {
  test('modelsUsed reads the modelUsage map\'s keys off the envelope', () => {
    const env = envelopeWithModelUsage({
      'claude-opus-4-1-20250805': { inputTokens: 10, outputTokens: 5 },
    });
    expect(modelsUsed(env)).toEqual(['claude-opus-4-1-20250805']);
  });

  test('modelsUsed is [] when the envelope carries no modelUsage at all', () => {
    const env = envelopeFromResultFrame(resultFrame())!;
    expect(modelsUsed(env)).toEqual([]);
    expect(modelsUsed(null)).toEqual([]);
  });

  test('MATCH: the pinned model is exactly what modelUsage reports — passes silently', () => {
    const pinned = 'claude-opus-4-1-20250805';
    const env = envelopeWithModelUsage({ [pinned]: { inputTokens: 1, outputTokens: 1 } });
    expect(() => assertModelUsedMatches(env, pinned)).not.toThrow();
  });

  test('MISMATCH: modelUsage names a DIFFERENT model than the pin — the run fails', () => {
    const pinned = 'claude-opus-4-1-20250805';
    const env = envelopeWithModelUsage({
      // A version-skew-shaped divergence: the SDK's bundled Claude Code
      // resolved to a different snapshot than the one pinned.
      'claude-opus-4-1-20250701': { inputTokens: 1, outputTokens: 1 },
    });
    expect(() => assertModelUsedMatches(env, pinned)).toThrow(ModelMismatchError);
    try {
      assertModelUsedMatches(env, pinned);
      throw new Error('unreachable');
    } catch (e) {
      expect(String(e)).toContain(pinned);
      expect(String(e)).toContain('claude-opus-4-1-20250701');
    }
  });

  test('MISMATCH: no modelUsage at all — no evidence, so no pass', () => {
    const env = envelopeFromResultFrame(resultFrame())!;
    expect(() => assertModelUsedMatches(env, 'claude-opus-4-1-20250805')).toThrow(ModelMismatchError);
    expect(() => assertModelUsedMatches(null, 'claude-opus-4-1-20250805')).toThrow(ModelMismatchError);
  });

  test('MISMATCH: modelUsage names the pin PLUS a second model — not a clean match', () => {
    const pinned = 'claude-opus-4-1-20250805';
    const env = envelopeWithModelUsage({
      [pinned]: { inputTokens: 1, outputTokens: 1 },
      'claude-3-5-haiku-20241022': { inputTokens: 1, outputTokens: 1 },
    });
    expect(() => assertModelUsedMatches(env, pinned)).toThrow(ModelMismatchError);
  });

  test('a malformed modelUsage (not an object) is treated as no evidence, never throws while reading', () => {
    for (const bad of [null, 'a string', 42, ['array'], undefined]) {
      const env = envelopeFromResultFrame(resultFrame({ modelUsage: bad }))!;
      expect(modelsUsed(env)).toEqual([]);
      expect(() => assertModelUsedMatches(env, 'claude-opus-4-1-20250805')).toThrow(ModelMismatchError);
    }
  });
});
