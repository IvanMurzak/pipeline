// ⚠️  SYNTHETIC / EXAMPLE MIGRATIONS — TEST-ONLY. NOT A REAL FORMAT BUMP.  ⚠️
//
// These transforms exist ONLY to exercise the migration machinery (ladder walk,
// x-escrow, byte-identical round-trip, plan-lint gate) while
// CURRENT_FORMAT_VERSION is still 1 and there is no real format-2 to migrate to.
//
// They are DELIBERATELY NOT in PRODUCTION_MIGRATIONS (registry.ts), so the real
// `pipeline migrate` command NEVER applies them: with the empty production
// ladder the only valid real migration is the no-op `--to 1`. Tests opt in
// explicitly by passing `{ registry: EXAMPLE_MIGRATIONS, current: EXAMPLE_CURRENT }`.
//
// Do NOT register these, do NOT bump CURRENT_FORMAT_VERSION for them, and do NOT
// let real pipelines carry `x-legacy-flag` / `x-modern-flag` / `x-final-flag` /
// `x-v2-extra` — those keys are `x-`-prefixed extension fields that plan-lint
// ignores, chosen precisely so a migrated example still passes plan-lint without
// pretending to be a real format.
//
// ── What the example ladder demonstrates ─────────────────────────────────────
//
//   format 1  --(1→2)-->  format 2  --(2→3)-->  format 3
//
//   1→2 (escrow rung): renames `x-legacy-flag` → `x-modern-flag` and introduces
//        a NEW field `x-v2-extra`. Going DOWN, `x-v2-extra` has no home in
//        format 1: if it still holds the synthesized default it is simply
//        dropped (so an up-then-down of a format-1 pipeline is byte-identical);
//        if a user customized it, the EXACT line is stashed in `x-escrow` and
//        the paired up restores it verbatim (lossless down→up).
//
//   2→3 (pure-rename rung): renames `x-modern-flag` → `x-final-flag`. No new
//        data, so NO escrow is needed — the inverse rename is byte-exact. This
//        shows a rung that legitimately does not touch escrow, and makes the
//        ladder span >1 version so the walker's multi-step loop is tested.
//
// Byte-identity is achieved BY CONSTRUCTION via surgical, single-line edits
// (frontmatter-edit.ts) plus exact-bytes escrow — never by re-serializing.

import {
  getKeyValue,
  parseDoc,
  readEscrow,
  removeKeyLine,
  renameKey,
  render,
  writeEscrow,
  insertLineAfterKey,
  type FrontmatterDoc,
} from './frontmatter-edit';
import { MANIFEST_BASENAME, type MigrationRegistry, type MigrationTransform, type PipelineFiles } from './types';

/** The engine's pretend-current format WHILE the example ladder is under test. */
export const EXAMPLE_CURRENT = 3;

/** The synthetic field the example manages, per format. */
const FLAG_KEY = { 1: 'x-legacy-flag', 2: 'x-modern-flag', 3: 'x-final-flag' } as const;

/** The new-in-format-2 field and the sentinel value `up` synthesizes by default. */
const V2_FIELD = 'x-v2-extra';
const V2_DEFAULT = 'default';
/** Escrow namespace for the 1→2 rung (keeps rungs independent within `x-escrow`). */
const V2_ESCROW_NS = 'example-v2-extra';

function editManifest(files: PipelineFiles, edit: (doc: FrontmatterDoc) => void): PipelineFiles {
  const text = files[MANIFEST_BASENAME];
  if (text === undefined) throw new Error(`example transform: missing ${MANIFEST_BASENAME}`);
  const doc = parseDoc(text);
  edit(doc);
  return { ...files, [MANIFEST_BASENAME]: render(doc) };
}

// ── 1 → 2 : rename + add-field-with-escrow ───────────────────────────────────

const exampleUp1to2 = (files: PipelineFiles): PipelineFiles => {
  const manifestText = files[MANIFEST_BASENAME]!;
  const escrow = readEscrow(manifestText);
  const stashed = escrow?.[V2_ESCROW_NS] as { line: string; afterKey: string } | undefined;

  // Rename the flag first so the escrow anchor (x-modern-flag) exists.
  let out = editManifest(files, (doc) => {
    renameKey(doc, FLAG_KEY[1], FLAG_KEY[2]);
  });

  if (stashed) {
    // Restore the user's exact original x-v2-extra line at its recorded anchor,
    // then clear the escrow entry — byte-exact reconstruction.
    out = editManifest(out, (doc) => {
      insertLineAfterKey(doc, stashed.afterKey, stashed.line);
    });
    out = { ...out, [MANIFEST_BASENAME]: clearEscrowNs(out[MANIFEST_BASENAME]!, V2_ESCROW_NS) };
  } else {
    // No escrow → this pipeline came from a genuine format-1 source; synthesize
    // the default new field right after the (renamed) flag.
    out = editManifest(out, (doc) => {
      insertLineAfterKey(doc, FLAG_KEY[2], `${V2_FIELD}: ${V2_DEFAULT}`);
    });
  }
  return out;
};

const exampleDown2to1 = (files: PipelineFiles): PipelineFiles => {
  // Read the current x-v2-extra value BEFORE mutating.
  const doc0 = parseDoc(files[MANIFEST_BASENAME]!);
  const value = getKeyValue(doc0, V2_FIELD);
  const rawLine = value === null ? null : exactLine(doc0, V2_FIELD);

  let out = editManifest(files, (doc) => {
    renameKey(doc, FLAG_KEY[2], FLAG_KEY[1]);
    removeKeyLine(doc, V2_FIELD);
  });

  if (value !== null && value !== V2_DEFAULT && rawLine !== null) {
    // Newer-only data with no home in format 1 → escrow the EXACT bytes so up
    // restores them losslessly. Anchor is the format-2 key the paired up recreates.
    out = {
      ...out,
      [MANIFEST_BASENAME]: mergeEscrowNs(out[MANIFEST_BASENAME]!, V2_ESCROW_NS, {
        line: rawLine,
        afterKey: FLAG_KEY[2],
      }),
    };
  }
  return out;
};

// ── 2 → 3 : pure key rename (no escrow) ──────────────────────────────────────

const exampleUp2to3 = (files: PipelineFiles): PipelineFiles =>
  editManifest(files, (doc) => {
    renameKey(doc, FLAG_KEY[2], FLAG_KEY[3]);
  });

const exampleDown3to2 = (files: PipelineFiles): PipelineFiles =>
  editManifest(files, (doc) => {
    renameKey(doc, FLAG_KEY[3], FLAG_KEY[2]);
  });

// ── escrow-namespace helpers (merge/clear a single namespace within x-escrow) ─

function mergeEscrowNs(text: string, ns: string, entry: unknown): string {
  const existing = readEscrow(text) ?? {};
  return writeEscrow(text, { ...existing, [ns]: entry });
}

function clearEscrowNs(text: string, ns: string): string {
  const existing = readEscrow(text);
  if (!existing) return text;
  const { [ns]: _removed, ...rest } = existing;
  return writeEscrow(text, rest);
}

/** The exact raw line (with any trailing '\r') owning `key`, or null. */
function exactLine(doc: FrontmatterDoc, key: string): string | null {
  for (let i = doc.open + 1; i < doc.close; i++) {
    const noCr = doc.lines[i].replace(/\r$/, '');
    const colon = noCr.indexOf(':');
    if (colon !== -1 && !/^\s/.test(noCr) && noCr.slice(0, colon).trim() === key) {
      return doc.lines[i];
    }
  }
  return null;
}

/** The 1→2 rung: rename + add field, escrow-on-down. */
export const EXAMPLE_1_TO_2: MigrationTransform = {
  from: 1,
  to: 2,
  up: exampleUp1to2,
  down: exampleDown2to1,
  summary: '[example] rename x-legacy-flag→x-modern-flag; add x-v2-extra (escrowed on down)',
};

/** The 2→3 rung: pure reversible rename, no escrow. */
export const EXAMPLE_2_TO_3: MigrationTransform = {
  from: 2,
  to: 3,
  up: exampleUp2to3,
  down: exampleDown3to2,
  summary: '[example] rename x-modern-flag→x-final-flag',
};

/**
 * The SYNTHETIC example ladder (1→2→3). TEST-ONLY. Pass this as
 * `{ registry: EXAMPLE_MIGRATIONS, current: EXAMPLE_CURRENT }`. NEVER add these
 * to PRODUCTION_MIGRATIONS and NEVER bump CURRENT_FORMAT_VERSION for them.
 */
export const EXAMPLE_MIGRATIONS: MigrationRegistry = [EXAMPLE_1_TO_2, EXAMPLE_2_TO_3];
