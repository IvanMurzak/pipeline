// The improver / script-creator record JSON Schemas — SINGLE SOURCE for what
// `pipeline drive`'s headless self-improvement sessions report (design 05.2).
//
// Passed to headless improver / script-creator sessions via
// `claude -p --json-schema` so the harness itself validates the final
// response: the envelope's `structured_output` IS the record. The shapes
// mirror what the pipeline-manager parses out of the agents' markdown reports
// (`pipeline-improver.md` "Report" / `pipeline-script-creator.md` "Script
// Creator Final Report") and what the `pipeline next` engine consumes as
// {kind:'improver'} / {kind:'script'} records — keep them in lockstep:
// engine fields live in lib/next.ts (ImproverRecord / ScriptRecord), the
// prose protocols in the two agent files.
//
// IMPORTANT: the serialized schemas must stay WHITESPACE-FREE — they travel
// as single `{schema}` tokens through the whitespace-split command templates
// in commands/drive.ts (same invariant as lib/step-schema.ts; a test asserts
// it). Never add a space to a property name or enum value here.
//
// Version tolerance (05.2 review B): before claude v2.1.205 an invalid
// `--json-schema` produced UNSTRUCTURED output with no error, so
// `structured_output` can be null even on a successful session. The parse
// helpers below fall back to the conservative records the design mandates —
// `applied: false` / `outcome: 'refused'` — and the caller warns; document
// the minimum claude version for reliable self-improvement.

/** pipeline-script-creator result vocabulary — recorded VERBATIM (never
 *  re-mapped) into the engine's {kind:'script'} record. Derived-from single
 *  source: lib/next.ts ScriptRecord['outcome'] is typechecked against this. */
export const SCRIPT_CREATOR_OUTCOMES = ['created', 'updated', 'converted', 'repaired', 'refused'] as const;
export type ScriptCreatorOutcome = (typeof SCRIPT_CREATOR_OUTCOMES)[number];

export const IMPROVER_RECORD_SCHEMA = {
  type: 'object',
  properties: {
    // True when the improver applied doc fixes; false on refusal.
    applied: { type: 'boolean' },
    // 0..N confirmed script-extraction briefs (Tier-1: 0 or 1; batch: any).
    // Each entry is one self-contained brief the script-creator receives
    // verbatim. REQUIRED (an empty list when none) so the harness always
    // yields a well-formed record.
    script_creation_briefs: { type: 'array', items: { type: 'string' } },
    // One-line human summary of what was improved (or why it was refused).
    summary: { type: ['string', 'null'] },
  },
  required: ['applied', 'script_creation_briefs'],
} as const;

export const SCRIPT_CREATOR_RECORD_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: [...SCRIPT_CREATOR_OUTCOMES] },
    // Absolute path of the created/updated/converted/repaired script; null on
    // refusal.
    script_path: { type: ['string', 'null'] },
    // One-line human summary (surfaced in drive progress + events).
    summary: { type: ['string', 'null'] },
  },
  required: ['outcome'],
} as const;

/** Compact (whitespace-free) serialization for the `{schema}` template token. */
export function improverSchemaJson(): string {
  return JSON.stringify(IMPROVER_RECORD_SCHEMA);
}

/** Compact (whitespace-free) serialization for the `{schema}` template token. */
export function scriptCreatorSchemaJson(): string {
  return JSON.stringify(SCRIPT_CREATOR_RECORD_SCHEMA);
}

export interface ImproverOutput {
  applied: boolean;
  script_creation_briefs: string[];
  summary: string | null;
  /** True when structured_output was null/absent (pre-v2.1.205 claude, or a
   *  custom template without --json-schema) and the conservative fallback
   *  applied — the caller warns and records applied:false. */
  fallback: boolean;
}

/** Defensive parse of an improver session's structured_output. Null →
 *  the version-tolerance fallback {applied:false, briefs:[]} with
 *  fallback:true; a present object is read defensively (non-boolean applied →
 *  false, non-string briefs dropped). */
export function parseImproverOutput(structured: Record<string, unknown> | null): ImproverOutput {
  if (structured === null) {
    return { applied: false, script_creation_briefs: [], summary: null, fallback: true };
  }
  const briefs = Array.isArray(structured.script_creation_briefs)
    ? structured.script_creation_briefs.filter((b): b is string => typeof b === 'string' && b.trim() !== '')
    : [];
  return {
    applied: structured.applied === true,
    script_creation_briefs: briefs,
    summary: typeof structured.summary === 'string' && structured.summary.trim() !== '' ? structured.summary : null,
    fallback: false,
  };
}

export interface ScriptCreatorOutput {
  outcome: ScriptCreatorOutcome;
  script_path: string | null;
  summary: string | null;
  /** True when structured_output was null/absent and the conservative
   *  'refused' fallback applied. */
  fallback: boolean;
}

/** Defensive parse of a script-creator session's structured_output. Null (or
 *  an out-of-vocabulary outcome) → the conservative 'refused' fallback. The
 *  reported outcome is otherwise passed through VERBATIM — never re-mapped. */
export function parseScriptCreatorOutput(structured: Record<string, unknown> | null): ScriptCreatorOutput {
  if (structured === null) {
    return { outcome: 'refused', script_path: null, summary: null, fallback: true };
  }
  const outcome = (SCRIPT_CREATOR_OUTCOMES as readonly string[]).includes(structured.outcome as string)
    ? (structured.outcome as ScriptCreatorOutcome)
    : 'refused';
  return {
    outcome,
    script_path: typeof structured.script_path === 'string' && structured.script_path !== '' ? structured.script_path : null,
    summary: typeof structured.summary === 'string' && structured.summary.trim() !== '' ? structured.summary : null,
    fallback: false,
  };
}
