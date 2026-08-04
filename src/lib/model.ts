// Model and reasoning-effort normalization — the value spaces a pipeline may
// name, and the tolerance rules for reading them.
//
// Extracted from lib/plan.ts so both plan builders can share them: the v1 walk
// (lib/plan.ts) reads these values out of markdown frontmatter, the v2
// translation (lib/manifest-plan.ts) reads them out of `pipeline.yml`. plan.ts
// re-exports both functions, so `import { normalizeModel } from './lib/plan'`
// and the package's public `src/index.ts` export keep working.
//
// Both normalizers share one contract: `null` means INHERIT (use the session
// default) and is not a failure, while `invalid: true` means the author wrote
// something that is not a value at all — the caller warns and inherits. The
// distinction is why they return a pair instead of `string | null`.

import type { FrontmatterValue } from './frontmatter';

/** The friendly model aliases a pipeline may name, beside a canonical
 *  `claude-*` id (which is preserved verbatim — a future model id must not be
 *  coerced to null by a CLI that predates it). */
const MODEL_ALIASES = new Set(['haiku', 'sonnet', 'opus', 'fable']);

/** The platform's reasoning-effort levels (claude --effort / agent frontmatter
 *  `effort:` / Agent SDK options.effort — verified 2026-07). `inherit`/empty
 *  normalizes to null = use the session default. */
export const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Normalize a frontmatter `effort:` value to an accepted level / null. Same
 *  contract as normalizeModel: null = inherit, invalid flagged for a warning. */
export function normalizeEffort(value: FrontmatterValue | undefined): {
  effort: string | null;
  invalid: boolean;
} {
  if (value == null) return { effort: null, invalid: false };
  if (Array.isArray(value)) return { effort: null, invalid: true };
  const v = String(value).trim().toLowerCase();
  if (v === '' || v === 'inherit') return { effort: null, invalid: false };
  if (EFFORT_LEVELS.has(v)) return { effort: v, invalid: false };
  return { effort: null, invalid: true };
}

/** Normalize a frontmatter `model:` value to an accepted alias / canonical id / null. */
export function normalizeModel(value: FrontmatterValue | undefined): {
  model: string | null;
  invalid: boolean;
} {
  if (value == null) return { model: null, invalid: false };
  if (Array.isArray(value)) return { model: null, invalid: true };
  const v = value.trim();
  if (v === '' || v.toLowerCase() === 'inherit') return { model: null, invalid: false };
  const lower = v.toLowerCase();
  if (MODEL_ALIASES.has(lower)) return { model: lower, invalid: false };
  if (v.startsWith('claude-')) return { model: v, invalid: false };
  return { model: null, invalid: true };
}
