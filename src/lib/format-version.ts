// Pipeline file-format versioning: the `format: N` stamp + the support-window
// classification/guard. See ARCHITECTURE.md § "Format versioning & migrations".
//
// The pipeline folder (PIPELINE.md manifest + steps/** + script declarations)
// versions as ONE unit, stamped by `format: N` in PIPELINE.md frontmatter. This
// module is the pure library + accessor for that stamp:
//   - read the stamped format from a pipeline dir (default 1 when absent),
//   - classify a format against the engine's support window
//     (current + 2 majors back), and
//   - assert it is supported (hard error on too-new / too-old).
//
// T1-17 is the STAMP + support-window classification only. The actual up/down
// migration LADDER (`pipeline migrate`) is a SEPARATE task (T1-18), and wiring
// enforcement into the load path (plan.ts) is ALSO deferred to T1-18 — this file
// stays a pure library + accessor with no load-path side effects.
//
// Import-inert: no I/O runs at import time. All filesystem access lives inside
// readPipelineFormat and is injectable for tests.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter';

/** The format this engine authors and treats as "current". Start at 1. */
export const CURRENT_FORMAT_VERSION = 1;

/**
 * The pre-stamp default: a pipeline whose PIPELINE.md has NO `format:` field is
 * format 1 (stamped from the first alpha while the installed base was small).
 */
export const DEFAULT_FORMAT_VERSION = 1;

/**
 * Floor of the in-memory support window for a given engine `current` format:
 * the engine reads `current`, `current-1`, and `current-2` — i.e. 2 majors back —
 * floored at 1 (there is no format 0).
 */
export function minSupportedFor(current: number): number {
  return Math.max(1, current - 2);
}

/**
 * The oldest format THIS engine reads in-memory (= CURRENT - 2, floored at 1).
 * Older-than-this pipelines are unsupported and need `pipeline migrate` up.
 */
export const MIN_SUPPORTED_FORMAT_VERSION = minSupportedFor(CURRENT_FORMAT_VERSION);

/** Discriminated classification of a format against the engine's support window. */
export type FormatClassification =
  | { kind: 'supported'; version: number; current: number }
  | { kind: 'upgrade-suggested'; version: number; current: number; message: string }
  | { kind: 'too-old'; version: number; current: number; minSupported: number; message: string }
  | { kind: 'too-new'; version: number; current: number; message: string };

/** Kinds that are hard errors (unreadable on this engine). */
export type UnsupportedFormatKind = 'too-new' | 'too-old';

/**
 * Typed error for a format this engine cannot read. `kind`:
 *   - `too-new`  — newer than the engine (upgrade the plugin, or migrate down)
 *   - `too-old`  — older than the support window (migrate up)
 *   - `invalid`  — a malformed / non-positive-integer `format:` stamp
 * Pure: constructing/throwing this never calls process.exit.
 */
export class FormatVersionError extends Error {
  readonly code = 'FORMAT_VERSION_UNSUPPORTED' as const;
  readonly kind: UnsupportedFormatKind | 'invalid';
  /** The offending version (or NaN for an unparseable stamp). */
  readonly version: number;
  /** The engine's current format at the time of the check. */
  readonly current: number;
  /** Present for the `too-old` case. */
  readonly minSupported?: number;

  constructor(
    message: string,
    kind: UnsupportedFormatKind | 'invalid',
    version: number,
    current: number,
    minSupported?: number,
  ) {
    super(message);
    this.name = 'FormatVersionError';
    this.kind = kind;
    this.version = version;
    this.current = current;
    if (minSupported !== undefined) this.minSupported = minSupported;
  }
}

function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}

/**
 * Classify a format `version` against an engine `current` (default: this
 * engine's CURRENT_FORMAT_VERSION). Pure and total over positive integers.
 * Throws FormatVersionError(kind:'invalid') if `version` is not a positive int.
 *
 * Thresholds:
 *   - version >  current                          → 'too-new'   (hard error)
 *   - version === current                         → 'supported'
 *   - minSupported <= version < current           → 'upgrade-suggested'
 *   - version <  minSupported                     → 'too-old'   (hard error)
 * where minSupported = max(1, current - 2).
 */
export function classifyFormat(
  version: number,
  current: number = CURRENT_FORMAT_VERSION,
): FormatClassification {
  if (!isPositiveInteger(version)) {
    throw new FormatVersionError(
      `Invalid pipeline format ${JSON.stringify(version)} — expected a positive integer.`,
      'invalid',
      version,
      current,
    );
  }

  const minSupported = minSupportedFor(current);

  if (version > current) {
    return {
      kind: 'too-new',
      version,
      current,
      message:
        `Pipeline format ${version} is a newer pipeline format than this engine can read ` +
        `(this engine's current format is ${current}). ` +
        `Upgrade the plugin to read it, or run \`pipeline migrate --to ${current}\` to down-migrate the pipeline.`,
    };
  }

  if (version === current) {
    return { kind: 'supported', version, current };
  }

  if (version >= minSupported) {
    return {
      kind: 'upgrade-suggested',
      version,
      current,
      message:
        `Pipeline format ${version} is older than this engine's current format ${current}, ` +
        `but still within the support window and readable as-is. ` +
        `Consider running \`pipeline migrate --to ${current}\` to persist the upgrade.`,
    };
  }

  // version < minSupported
  return {
    kind: 'too-old',
    version,
    current,
    minSupported,
    message:
      `Pipeline format ${version} is older than this engine supports ` +
      `(oldest readable is ${minSupported}; current is ${current}). ` +
      `Run \`pipeline migrate\` to up-migrate the pipeline to a supported format.`,
  };
}

/**
 * Assert a format is readable on this engine. Throws FormatVersionError on
 * `too-new` / `too-old` (or `invalid`); otherwise RETURNS the classification —
 * so callers can surface the `upgrade-suggested` hint without failing.
 * Pure: no process.exit, no I/O.
 */
export function assertFormatSupported(
  version: number,
  current: number = CURRENT_FORMAT_VERSION,
): Extract<FormatClassification, { kind: 'supported' | 'upgrade-suggested' }> {
  const c = classifyFormat(version, current);
  if (c.kind === 'too-new' || c.kind === 'too-old') {
    throw new FormatVersionError(c.message, c.kind, c.version, c.current, (c as { minSupported?: number }).minSupported);
  }
  return c;
}

/**
 * Parse the `format: N` stamp out of a PIPELINE.md's RAW text, using the shared
 * frontmatter reader. Returns the integer format, defaulting to
 * DEFAULT_FORMAT_VERSION when the field is absent. Throws
 * FormatVersionError(kind:'invalid') when the stamp is present but not a
 * positive integer (empty, list, decimal, negative, non-numeric, ...).
 *
 * `sourceLabel` is only woven into error messages (e.g. the file path).
 */
export function parsePipelineFormat(pipelineMdText: string, sourceLabel = 'PIPELINE.md'): number {
  const { fields } = parseFrontmatter(pipelineMdText);
  const raw = fields.format;

  if (raw === undefined) return DEFAULT_FORMAT_VERSION;

  if (typeof raw !== 'string') {
    // e.g. `format: [1, 2]` parses to a string[] — never a valid stamp.
    throw new FormatVersionError(
      `${sourceLabel}: invalid \`format\` stamp ${JSON.stringify(raw)} — expected a single positive integer (e.g. \`format: 1\`).`,
      'invalid',
      NaN,
      CURRENT_FORMAT_VERSION,
    );
  }

  const trimmed = raw.trim();
  // Digits only — reject '', '1.0', '-1', '0x1', '1e3', 'v1', ' 1 2 ', etc.
  if (!/^\d+$/.test(trimmed)) {
    throw new FormatVersionError(
      `${sourceLabel}: invalid \`format\` stamp ${JSON.stringify(raw)} — expected a positive integer (e.g. \`format: 1\`).`,
      'invalid',
      NaN,
      CURRENT_FORMAT_VERSION,
    );
  }

  const n = Number.parseInt(trimmed, 10);
  if (!isPositiveInteger(n)) {
    // Catches '0' (and, defensively, any non-positive result).
    throw new FormatVersionError(
      `${sourceLabel}: invalid \`format\` stamp ${JSON.stringify(raw)} — expected a positive integer >= 1 (e.g. \`format: 1\`).`,
      'invalid',
      n,
      CURRENT_FORMAT_VERSION,
    );
  }

  return n;
}

/** Minimal filesystem surface readPipelineFormat needs — injectable for tests. */
export interface FormatReaderIO {
  exists(path: string): boolean;
  readFile(path: string): string;
}

const nodeIO: FormatReaderIO = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, 'utf8'),
};

export interface ReadPipelineFormatOptions {
  /** Injectable fs (defaults to node:fs). */
  io?: FormatReaderIO;
}

/**
 * Locate + read the `format: N` stamp for a pipeline directory. Mirrors
 * plan.ts's manifest convention exactly: the manifest is `PIPELINE.md` directly
 * inside `pipelineDir` (`join(pipelineDir, 'PIPELINE.md')`, gated by existsSync,
 * read via readFileSync(..,'utf8'), parsed by the shared parseFrontmatter).
 *
 *   - manifest missing            → FormatVersionError(kind:'invalid') (not a pipeline dir)
 *   - `format:` field absent      → DEFAULT_FORMAT_VERSION (1)
 *   - `format:` present, malformed → FormatVersionError(kind:'invalid')
 *
 * Does NOT classify or enforce — callers pass the result to
 * classifyFormat / assertFormatSupported. Enforcement wiring into the load path
 * is deferred to T1-18.
 */
export function readPipelineFormat(pipelineDir: string, opts: ReadPipelineFormatOptions = {}): number {
  const io = opts.io ?? nodeIO;
  const manifestPath = join(pipelineDir, 'PIPELINE.md');

  if (!io.exists(manifestPath)) {
    throw new FormatVersionError(
      `No PIPELINE.md found in ${pipelineDir} — cannot read a pipeline \`format\` stamp.`,
      'invalid',
      NaN,
      CURRENT_FORMAT_VERSION,
    );
  }

  const raw = io.readFile(manifestPath);
  return parsePipelineFormat(raw, manifestPath);
}
