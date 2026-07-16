// lib/step-schema.ts — the single-source step-record JSON Schema.

import { test, expect } from 'bun:test';
import { ENGINE_OUTCOMES, RECORD_OUTCOMES, STEP_RECORD_SCHEMA, stepRecordSchemaJson } from '../src/lib/step-schema';

test('stepRecordSchemaJson: WHITESPACE-FREE (travels as one whitespace-split template token)', () => {
  const json = stepRecordSchemaJson();
  expect(/\s/.test(json)).toBe(false);
});

test('stepRecordSchemaJson: round-trips to the schema object', () => {
  expect(JSON.parse(stepRecordSchemaJson())).toEqual(JSON.parse(JSON.stringify(STEP_RECORD_SCHEMA)));
});

test('schema: outcome enum = engine outcomes + needs-input, and is required', () => {
  expect([...STEP_RECORD_SCHEMA.properties.outcome.enum]).toEqual([...RECORD_OUTCOMES]);
  expect([...RECORD_OUTCOMES]).toEqual([...ENGINE_OUTCOMES, 'needs-input']);
  expect([...STEP_RECORD_SCHEMA.required]).toEqual(['outcome']);
  expect(ENGINE_OUTCOMES).toContain('completed');
  expect(ENGINE_OUTCOMES).toContain('halted');
  expect(ENGINE_OUTCOMES).toContain('blocked-delegating');
  expect(ENGINE_OUTCOMES).toContain('depth-exhausted');
  // needs-input is drive-only — the ENGINE list must not contain it.
  expect([...ENGINE_OUTCOMES]).not.toContain('needs-input');
});

test('schema: carries every engine-consumed record field + the question object', () => {
  const props = Object.keys(STEP_RECORD_SCHEMA.properties);
  for (const f of [
    'outcome',
    'next_iteration',
    'halt_reason',
    'has_improvement_brief',
    'flags',
    'worktree_branch',
    'worktree_path',
    'blocker_delegation',
    'question',
    'output',
  ]) {
    expect(props).toContain(f);
  }
  expect([...STEP_RECORD_SCHEMA.properties.question.required]).toEqual(['text']);
});

test('schema: output is OPTIONAL (records with and without it are both valid)', () => {
  // Additive script-steps field: an object-or-null property, never required —
  // a pre-existing record without `output` must stay schema-valid.
  expect([...STEP_RECORD_SCHEMA.properties.output.type]).toEqual(['object', 'null']);
  expect([...STEP_RECORD_SCHEMA.required]).toEqual(['outcome']);
  expect([...STEP_RECORD_SCHEMA.required]).not.toContain('output');
  // With output: the declared type admits a plain JSON object (or null).
  const withOutput = { outcome: 'completed', output: { pr_number: 132 } };
  const withoutOutput = { outcome: 'completed' };
  for (const record of [withOutput, withoutOutput]) {
    for (const key of STEP_RECORD_SCHEMA.required) {
      expect(Object.keys(record)).toContain(key);
    }
  }
  expect(typeof withOutput.output).toBe('object');
});
