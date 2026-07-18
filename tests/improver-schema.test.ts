// lib/improver-schema.ts — the improver / script-creator record JSON Schemas
// (headless self-improvement, design 05.2).

import { test, expect } from 'bun:test';
import {
  IMPROVER_RECORD_SCHEMA,
  SCRIPT_CREATOR_OUTCOMES,
  SCRIPT_CREATOR_RECORD_SCHEMA,
  improverSchemaJson,
  parseImproverOutput,
  parseScriptCreatorOutput,
  scriptCreatorSchemaJson,
} from '../src/lib/improver-schema';

test('improver/script schemas: WHITESPACE-FREE (travel as one whitespace-split template token)', () => {
  expect(/\s/.test(improverSchemaJson())).toBe(false);
  expect(/\s/.test(scriptCreatorSchemaJson())).toBe(false);
});

test('improver/script schemas: round-trip to the schema objects', () => {
  expect(JSON.parse(improverSchemaJson())).toEqual(JSON.parse(JSON.stringify(IMPROVER_RECORD_SCHEMA)));
  expect(JSON.parse(scriptCreatorSchemaJson())).toEqual(JSON.parse(JSON.stringify(SCRIPT_CREATOR_RECORD_SCHEMA)));
});

test('improver schema: applied + script_creation_briefs are required; summary optional', () => {
  expect([...IMPROVER_RECORD_SCHEMA.required]).toEqual(['applied', 'script_creation_briefs']);
  const props = Object.keys(IMPROVER_RECORD_SCHEMA.properties);
  expect(props).toContain('applied');
  expect(props).toContain('script_creation_briefs');
  expect(props).toContain('summary');
});

test('script-creator schema: outcome enum is the verbatim creator vocabulary, required', () => {
  expect([...SCRIPT_CREATOR_RECORD_SCHEMA.properties.outcome.enum]).toEqual([...SCRIPT_CREATOR_OUTCOMES]);
  expect([...SCRIPT_CREATOR_OUTCOMES]).toEqual(['created', 'updated', 'converted', 'repaired', 'refused']);
  expect([...SCRIPT_CREATOR_RECORD_SCHEMA.required]).toEqual(['outcome']);
});

test('parseImproverOutput: null structured_output → conservative fallback (applied:false, fallback:true)', () => {
  expect(parseImproverOutput(null)).toEqual({
    applied: false,
    script_creation_briefs: [],
    summary: null,
    fallback: true,
  });
});

test('parseImproverOutput: defensive read — non-boolean applied, non-string briefs dropped', () => {
  expect(
    parseImproverOutput({
      applied: true,
      script_creation_briefs: ['brief A', 42, '', 'brief B'],
      summary: 'tightened step 2',
    }),
  ).toEqual({
    applied: true,
    script_creation_briefs: ['brief A', 'brief B'],
    summary: 'tightened step 2',
    fallback: false,
  });
  expect(parseImproverOutput({ applied: 'yes', script_creation_briefs: 'nope' })).toEqual({
    applied: false,
    script_creation_briefs: [],
    summary: null,
    fallback: false,
  });
});

test('parseScriptCreatorOutput: null → refused fallback; out-of-vocabulary outcome → refused; verbatim otherwise', () => {
  expect(parseScriptCreatorOutput(null)).toEqual({ outcome: 'refused', script_path: null, summary: null, fallback: true });
  expect(parseScriptCreatorOutput({ outcome: 'exploded', script_path: '/x' }).outcome).toBe('refused');
  for (const outcome of SCRIPT_CREATOR_OUTCOMES) {
    expect(parseScriptCreatorOutput({ outcome, script_path: '/s.py' }).outcome).toBe(outcome);
  }
  expect(parseScriptCreatorOutput({ outcome: 'created', script_path: '/s.py', summary: 'extracted' })).toEqual({
    outcome: 'created',
    script_path: '/s.py',
    summary: 'extracted',
    fallback: false,
  });
});
