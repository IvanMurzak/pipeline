// Surgical, byte-preserving frontmatter EDITOR for migrations (T1-18).
//
// IMPORTANT: this is deliberately SEPARATE from lib/frontmatter.ts. That file is
// a lockstep-sensitive shared READER (the script-step chain depends on it) and
// is READ-ONLY. When a migration must WRITE frontmatter back, it does so HERE.
//
// The byte-identical round-trip property hinges on ONE idea: never re-serialize.
// We split a file on '\n' into a line array, mutate ONLY the specific lines a
// transform intends to change, and join back with '\n'. Because
// `s.split('\n').join('\n') === s` for every string, every untouched line —
// including its exact spacing, quoting, and trailing '\r' under CRLF — is
// reproduced verbatim. Value edits replace a single token in place; inserts and
// removals splice whole lines. Nothing else moves.
//
// Frontmatter keys here are top-level (non-indented) `key: value` lines between
// the opening and closing `---` fences — matching what lib/frontmatter.ts reads.

import { ESCROW_KEY } from './types';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A line-array view of a file that locates its YAML frontmatter block. `lines`
 * is the FULL file split on '\n'; `open`/`close` are the indices of the opening
 * and closing `---` fences (or -1 when the file has no frontmatter). Mutating
 * `lines` and calling `render` reproduces every untouched byte exactly.
 */
export interface FrontmatterDoc {
  lines: string[];
  open: number;
  close: number;
}

/** True for a line that is exactly a `---` fence (tolerating a trailing '\r'). */
function isFence(line: string): boolean {
  return line.replace(/\r$/, '') === '---';
}

/** Parse a file into a line-array + frontmatter fence positions (no mutation). */
export function parseDoc(text: string): FrontmatterDoc {
  const lines = text.split('\n');
  let open = -1;
  let close = -1;
  if (lines.length > 0 && isFence(lines[0])) {
    open = 0;
    for (let i = 1; i < lines.length; i++) {
      if (isFence(lines[i])) {
        close = i;
        break;
      }
    }
  }
  // A lone opening fence with no closing fence is not a usable frontmatter block.
  if (close === -1) open = -1;
  return { lines, open, close };
}

/** Reproduce the file text. Identity for any doc whose lines were not mutated. */
export function render(doc: FrontmatterDoc): string {
  return doc.lines.join('\n');
}

/** Does this file have a usable frontmatter block? */
export function hasFrontmatter(doc: FrontmatterDoc): boolean {
  return doc.open === 0 && doc.close > 0;
}

/** The parsed key of a frontmatter line (part before the first ':'), or null. */
function lineKey(line: string): string | null {
  const noCr = line.replace(/\r$/, '');
  // Top-level keys only: reject indented / comment / list lines.
  if (/^\s/.test(noCr) || noCr.startsWith('#')) return null;
  const colon = noCr.indexOf(':');
  if (colon === -1) return null;
  return noCr.slice(0, colon).trim();
}

/** Index (into `doc.lines`) of the first frontmatter line whose key === `key`, or -1. */
export function findKeyLine(doc: FrontmatterDoc, key: string): number {
  if (!hasFrontmatter(doc)) return -1;
  for (let i = doc.open + 1; i < doc.close; i++) {
    if (lineKey(doc.lines[i]) === key) return i;
  }
  return -1;
}

/** Raw value text after `key:` on its line (trimmed; trailing '\r' stripped), or null. */
export function getKeyValue(doc: FrontmatterDoc, key: string): string | null {
  const i = findKeyLine(doc, key);
  if (i === -1) return null;
  const noCr = doc.lines[i].replace(/\r$/, '');
  const colon = noCr.indexOf(':');
  return noCr.slice(colon + 1).trim();
}

/**
 * Rename a frontmatter key IN PLACE — replaces only the leading key token,
 * preserving the `:`, all inter-token spacing, the value, and any trailing '\r'.
 * No-op (returns false) when `oldKey` is absent. Byte-reversible with the
 * inverse rename.
 */
export function renameKey(doc: FrontmatterDoc, oldKey: string, newKey: string): boolean {
  const i = findKeyLine(doc, oldKey);
  if (i === -1) return false;
  doc.lines[i] = doc.lines[i].replace(new RegExp('^' + escapeRegExp(oldKey) + '(?=\\s*:)'), newKey);
  return true;
}

/**
 * Replace the VALUE token of `key` in place, preserving the `key:` prefix, the
 * spacing after the colon, and any trailing whitespace/'\r'. Used for the
 * numeric `format:` stamp. No-op (false) when the key is absent.
 */
export function setKeyValue(doc: FrontmatterDoc, key: string, value: string): boolean {
  const i = findKeyLine(doc, key);
  if (i === -1) return false;
  const cr = /\r$/.test(doc.lines[i]) ? '\r' : '';
  const noCr = doc.lines[i].replace(/\r$/, '');
  // `<key><spaces?>:<spaces>VALUE<trailing spaces>`
  const m = /^([^:]*:\s*)(\S.*?|)(\s*)$/.exec(noCr);
  if (!m) return false;
  doc.lines[i] = m[1] + value + m[3] + cr;
  return true;
}

/** Insert `newLine` (no trailing '\n') immediately AFTER the line at `index`. */
export function insertLineAfterIndex(doc: FrontmatterDoc, index: number, newLine: string): void {
  doc.lines.splice(index + 1, 0, newLine);
  if (index < doc.close) doc.close += 1;
}

/** Insert `newLine` right after the line owning `afterKey`. Returns false if absent. */
export function insertLineAfterKey(doc: FrontmatterDoc, afterKey: string, newLine: string): boolean {
  const i = findKeyLine(doc, afterKey);
  if (i === -1) return false;
  insertLineAfterIndex(doc, i, newLine);
  return true;
}

/** Insert `newLine` as the LAST frontmatter line (just before the closing fence). */
export function appendFrontmatterLine(doc: FrontmatterDoc, newLine: string): void {
  if (!hasFrontmatter(doc)) return;
  doc.lines.splice(doc.close, 0, newLine);
  doc.close += 1;
}

/** Remove the line owning `key`. Returns the EXACT removed line text (with any
 *  '\r'), or null when the key was absent. */
export function removeKeyLine(doc: FrontmatterDoc, key: string): string | null {
  const i = findKeyLine(doc, key);
  if (i === -1) return null;
  const [removed] = doc.lines.splice(i, 1);
  if (i < doc.close) doc.close -= 1;
  return removed;
}

// ── format stamp ─────────────────────────────────────────────────────────────

/**
 * Surgically set the `format: N` stamp on a file's text. Replaces the value on
 * an existing `format:` line (byte-preserving), or inserts `format: N` as the
 * first frontmatter line when absent. Pure: returns new text, never mutates.
 */
export function setFormatStamp(text: string, version: number): string {
  const doc = parseDoc(text);
  if (!hasFrontmatter(doc)) return text; // no frontmatter → nothing to stamp
  if (!setKeyValue(doc, 'format', String(version))) {
    insertLineAfterIndex(doc, doc.open, `format: ${version}`);
  }
  return render(doc);
}

// ── x-escrow ─────────────────────────────────────────────────────────────────
//
// Escrow is a single frontmatter line `x-escrow: <json>` carrying a namespaced
// JSON payload. Old engines treat it as an unknown (ignored) field; the paired
// up-migration reads it, restores the stashed bytes, and removes the line — so a
// round-tripped file has no escrow residue.

export type EscrowPayload = Record<string, unknown>;

/** Read + JSON.parse the `x-escrow` payload from a file's frontmatter, or null. */
export function readEscrow(text: string): EscrowPayload | null {
  const doc = parseDoc(text);
  const raw = getKeyValue(doc, ESCROW_KEY);
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as EscrowPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Write (or clear) the `x-escrow` line. A null/empty payload REMOVES the line;
 * otherwise it sets `x-escrow: <compact-json>`, appended as the last
 * frontmatter line when absent (deterministic position → reversible). Pure.
 */
export function writeEscrow(text: string, payload: EscrowPayload | null): string {
  const doc = parseDoc(text);
  if (!hasFrontmatter(doc)) return text;
  const isEmpty = payload === null || Object.keys(payload).length === 0;
  if (isEmpty) {
    removeKeyLine(doc, ESCROW_KEY);
    return render(doc);
  }
  const line = `${ESCROW_KEY}: ${JSON.stringify(payload)}`;
  const existing = findKeyLine(doc, ESCROW_KEY);
  if (existing === -1) {
    appendFrontmatterLine(doc, line);
  } else {
    doc.lines[existing] = line;
  }
  return render(doc);
}
