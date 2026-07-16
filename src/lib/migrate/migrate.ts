// The pure ladder walker (T1-18): `migratePipeline(files, toVersion)`.
//
// Reads the source pipeline's `format:` stamp, guards the TARGET against this
// engine's support window (classifyFormat / assertFormatSupported from T1-17),
// then walks the ladder up or down one adjacent rung at a time — applying each
// rung's `up`/`down` and stamping the new `format:` after every step. PURE: no
// I/O; the input map is never mutated. All filesystem work lives in the command
// layer (commands/migrate.ts).

import {
  CURRENT_FORMAT_VERSION,
  assertFormatSupported,
  parsePipelineFormat,
} from '../format-version';
import { PRODUCTION_MIGRATIONS, findDownRung, findUpRung } from './registry';
import { setFormatStamp } from './frontmatter-edit';
import {
  MANIFEST_BASENAME,
  MigrationLadderError,
  type AppliedRung,
  type MigrationRegistry,
  type MigrationResult,
  type PipelineFiles,
} from './types';

export interface MigrateOptions {
  /** The transform ladder to walk (defaults to the — currently empty — production set). */
  registry?: MigrationRegistry;
  /**
   * The engine's "current" format for target guarding (defaults to
   * CURRENT_FORMAT_VERSION). Overridable so the SYNTHETIC example (which pretends
   * current is 3) can exercise real up/down rungs without touching the real
   * CURRENT_FORMAT_VERSION.
   */
  current?: number;
}

/** Shallow-clone the files map (values are immutable strings). */
function cloneFiles(files: PipelineFiles): PipelineFiles {
  return { ...files };
}

/** Read the source `format:` from a files map's manifest (pure, text-level). */
export function readFilesFormat(files: PipelineFiles): number {
  const manifest = files[MANIFEST_BASENAME];
  if (manifest === undefined) {
    throw new Error(`migrate: pipeline files are missing ${MANIFEST_BASENAME}`);
  }
  return parsePipelineFormat(manifest, MANIFEST_BASENAME);
}

/** Re-stamp the manifest's `format:` field to `version` (surgical, pure). */
function stampFormat(files: PipelineFiles, version: number): PipelineFiles {
  const manifest = files[MANIFEST_BASENAME];
  if (manifest === undefined) return files;
  return { ...files, [MANIFEST_BASENAME]: setFormatStamp(manifest, version) };
}

/**
 * Migrate a pipeline (in memory) from its stamped format to `toVersion`,
 * walking the ladder one adjacent rung at a time.
 *
 * Guards:
 *   - `toVersion` is asserted against the engine's support window via
 *     assertFormatSupported — a too-new / too-old / non-integer target throws a
 *     FormatVersionError (the caller refuses the migration). The SOURCE format
 *     is NOT hard-blocked when it is too-new: down-migrating a files-newer-than-
 *     engine pipeline is exactly the sanctioned fix.
 *   - a missing rung anywhere on the path throws MigrationLadderError.
 *
 * Returns a fresh files map; the input is never mutated. `from === to` is a
 * no-op (`changed: false`).
 */
export function migratePipeline(
  files: PipelineFiles,
  toVersion: number,
  opts: MigrateOptions = {},
): MigrationResult {
  const registry = opts.registry ?? PRODUCTION_MIGRATIONS;
  const current = opts.current ?? CURRENT_FORMAT_VERSION;

  const from = readFilesFormat(files);

  // Refuse an unknown / too-new / too-old / malformed TARGET (throws on failure).
  assertFormatSupported(toVersion, current);

  if (from === toVersion) {
    return { from, to: toVersion, files: cloneFiles(files), applied: [], changed: false };
  }

  let cur = from;
  let acc = cloneFiles(files);
  const applied: AppliedRung[] = [];

  if (toVersion > from) {
    while (cur < toVersion) {
      const rung = findUpRung(registry, cur);
      if (!rung) {
        throw new MigrationLadderError(
          `No up-migration registered for format ${cur} → ${cur + 1}.`,
          cur,
          cur + 1,
        );
      }
      acc = stampFormat(rung.up(acc), cur + 1);
      applied.push({ from: cur, to: cur + 1, direction: 'up', ...(rung.summary ? { summary: rung.summary } : {}) });
      cur += 1;
    }
  } else {
    while (cur > toVersion) {
      const rung = findDownRung(registry, cur);
      if (!rung) {
        throw new MigrationLadderError(
          `No down-migration registered for format ${cur} → ${cur - 1}.`,
          cur,
          cur - 1,
        );
      }
      acc = stampFormat(rung.down(acc), cur - 1);
      applied.push({ from: cur, to: cur - 1, direction: 'down', ...(rung.summary ? { summary: rung.summary } : {}) });
      cur -= 1;
    }
  }

  return { from, to: toVersion, files: acc, applied, changed: true };
}
