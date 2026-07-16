// Migration-ladder types (T1-18). See ARCHITECTURE.md § "Format versioning &
// migrations".
//
// A pipeline folder (PIPELINE.md manifest + steps/** + scripts/**) versions as
// ONE unit via the `format: N` stamp. A migration is a PAIRED transform
// `up(N→N+1)` / `down(N+1→N)` that is DETERMINISTIC and PURE — files in, files
// out, no I/O. The load-bearing correctness property is that `up → down → up`
// is BYTE-IDENTICAL (golden-corpus round-trip); `x-escrow` carries
// newer-format-only data across a `down` so a later `up` restores it losslessly.

/**
 * The in-memory representation of a pipeline folder a transform operates on:
 * a map from POSIX-relative path (from the pipeline root) to raw file text.
 * Keys look like `PIPELINE.md`, `steps/01-intro.md`. RAW bytes are preserved
 * verbatim — transforms MUST edit surgically (not re-serialize) to keep the
 * round-trip byte-identical for untouched content.
 */
export type PipelineFiles = Record<string, string>;

/** Direction of a single ladder rung actually applied. */
export type MigrationDirection = 'up' | 'down';

/**
 * One rung of the migration ladder: the paired transform between two ADJACENT
 * formats (`to === from + 1`). Both halves are PURE `(files) => files`:
 *   - `up`:   format `from` → `from + 1` (semantic edits only; the ladder stamps
 *             the `format:` field for you).
 *   - `down`: format `from + 1` → `from` (semantic edits + `x-escrow` of any
 *             newer-only data so the paired `up` can restore it byte-for-byte).
 *
 * A REAL production transform slots in by pushing one of these into the
 * registry (see registry.ts). The registry is keyed by version via `from`/`to`.
 */
export interface MigrationTransform {
  /** Lower adjacent format. */
  from: number;
  /** Upper adjacent format — MUST equal `from + 1`. */
  to: number;
  /** Pure `from → to` transform. Do NOT touch the `format:` stamp (the ladder does). */
  up: (files: PipelineFiles) => PipelineFiles;
  /** Pure `to → from` transform. Stash newer-only data via `x-escrow`. */
  down: (files: PipelineFiles) => PipelineFiles;
  /** One-line human summary shown in messages/diffs (optional). */
  summary?: string;
}

/** An ordered set of ladder rungs. Adjacent + contiguous; validated on use. */
export type MigrationRegistry = readonly MigrationTransform[];

/** A single rung that was applied during a `migratePipeline` walk. */
export interface AppliedRung {
  from: number;
  to: number;
  direction: MigrationDirection;
  summary?: string;
}

/** Result of walking the ladder from the source format to a target. */
export interface MigrationResult {
  /** The source pipeline's `format:` at the start of the walk. */
  from: number;
  /** The requested target format. */
  to: number;
  /** The transformed files (a fresh map; the input is never mutated). */
  files: PipelineFiles;
  /** Rungs applied, in order (empty when `from === to`). */
  applied: AppliedRung[];
  /** False iff `from === to` (nothing to do). */
  changed: boolean;
}

/** The conventional manifest basename at the pipeline root. */
export const MANIFEST_BASENAME = 'PIPELINE.md';

/** The frontmatter key that carries down-migration escrow (old engines ignore it). */
export const ESCROW_KEY = 'x-escrow';

/** Thrown when the ladder has no rung for a step it must take. */
export class MigrationLadderError extends Error {
  readonly code = 'MIGRATION_LADDER_GAP' as const;
  readonly from: number;
  readonly to: number;
  constructor(message: string, from: number, to: number) {
    super(message);
    this.name = 'MigrationLadderError';
    this.from = from;
    this.to = to;
  }
}
