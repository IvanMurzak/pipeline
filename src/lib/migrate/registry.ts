// The migration-ladder REGISTRY (T1-18).
//
// A real format bump slots in here by pushing ONE `MigrationTransform` whose
// `from`/`to` are the adjacent versions it bridges (`to === from + 1`). The
// ladder walker (migrate.ts) keys off `from`/`to` to find each rung.
//
// PRODUCTION IS INTENTIONALLY EMPTY. CURRENT_FORMAT_VERSION is 1 (T1-17) — there
// is no real format-2 yet, so there is no real transform to register. This is a
// SKELETON: the framework, the escrow mechanic, and the round-trip harness are
// all here and exercised by a clearly-marked SYNTHETIC example
// (example-transform.ts) that is NEVER added to this array. Do NOT register a
// real bump until CURRENT_FORMAT_VERSION actually advances.

import type { MigrationRegistry, MigrationTransform } from './types';

/**
 * The transforms this engine ships. EMPTY at format 1 — a format-1 pipeline is
 * already current, so the only valid production migration is the no-op
 * `--to 1`. When a real format 2 lands, push its paired 1→2 transform here.
 */
export const PRODUCTION_MIGRATIONS: MigrationRegistry = [];

/**
 * Validate a registry is a well-formed ladder: every rung is adjacent
 * (`to === from + 1`), positive, and no two rungs bridge the same version pair.
 * Returns the list of problems (empty ⇒ valid). Pure. Call it before trusting a
 * registry (the walker also fails loudly on a missing rung).
 */
export function validateRegistry(registry: MigrationRegistry): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const t of registry) {
    if (!Number.isInteger(t.from) || t.from < 1) {
      problems.push(`rung ${t.from}→${t.to}: 'from' must be a positive integer`);
    }
    if (t.to !== t.from + 1) {
      problems.push(`rung ${t.from}→${t.to}: 'to' must equal 'from + 1' (non-adjacent rungs are not allowed)`);
    }
    if (seen.has(t.from)) {
      problems.push(`duplicate rung starting at format ${t.from}`);
    }
    seen.add(t.from);
  }
  return problems;
}

/** Find the rung that migrates UP out of `version` (from === version), or null. */
export function findUpRung(registry: MigrationRegistry, version: number): MigrationTransform | null {
  return registry.find((t) => t.from === version) ?? null;
}

/** Find the rung that migrates DOWN out of `version` (to === version), or null. */
export function findDownRung(registry: MigrationRegistry, version: number): MigrationTransform | null {
  return registry.find((t) => t.to === version) ?? null;
}
