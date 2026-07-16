// T1-18 — migration ladder: the golden-corpus BYTE-IDENTICAL round-trip harness,
// x-escrow mechanics, support-window guards, and the multi-step ladder walk.
//
// Exercised with the SYNTHETIC example ladder (1→2→3) from
// lib/migrate/example-transform.ts — TEST-ONLY, never in PRODUCTION_MIGRATIONS,
// and CURRENT_FORMAT_VERSION stays 1. Everything here is pure (no filesystem).

import { test, expect } from 'bun:test';
import {
  migratePipeline,
  checkRoundTrip,
  assertRoundTrip,
  filesEqual,
  diffFiles,
  validateRegistry,
  renderDiff,
  readEscrow,
  MigrationLadderError,
  type PipelineFiles,
  type MigrationRegistry,
} from '../src/lib/migrate';
import { FormatVersionError, parsePipelineFormat } from '../src/lib/format-version';
import {
  EXAMPLE_MIGRATIONS,
  EXAMPLE_CURRENT,
  EXAMPLE_2_TO_3,
} from '../src/lib/migrate/example-transform';

// ── golden corpus ────────────────────────────────────────────────────────────

const PIPE_V1 = [
  '---',
  'format: 1',
  'execution: sequential',
  'x-legacy-flag: enabled',
  'title: Example Migration Corpus',
  '---',
  '# Example Migration Corpus',
  '',
  'A synthetic pipeline used only by T1-18 migration tests.',
  '',
].join('\n');

// Format 3, with a USER-CUSTOMIZED x-v2-extra (the value has no home in format 1
// and must survive down→up via x-escrow).
const PIPE_V3_CUSTOM = [
  '---',
  'format: 3',
  'execution: sequential',
  'x-final-flag: enabled',
  'x-v2-extra: custom-user-value',
  'title: Example Migration Corpus',
  '---',
  '# Example Migration Corpus',
  '',
  'A synthetic pipeline used only by T1-18 migration tests.',
  '',
].join('\n');

const STEP = ['---', 'step_id: only-step', '---', '# Only Step', '', 'Do the thing.', ''].join('\n');

const older = (): PipelineFiles => ({ 'PIPELINE.md': PIPE_V1, 'steps/01-only-step.md': STEP });
const newer = (): PipelineFiles => ({ 'PIPELINE.md': PIPE_V3_CUSTOM, 'steps/01-only-step.md': STEP });

const opts = { registry: EXAMPLE_MIGRATIONS, current: EXAMPLE_CURRENT };
const MANIFEST = 'PIPELINE.md';

// ── HEADLINE: up → down → up is byte-identical ───────────────────────────────

test('HEADLINE round-trip: up→down→up from the older format is byte-identical', () => {
  const up1 = migratePipeline(older(), 3, opts).files; // 1 → 3
  const down1 = migratePipeline(up1, 1, opts).files; //   3 → 1
  const up2 = migratePipeline(down1, 3, opts).files; //   1 → 3

  // The two "up" snapshots are byte-for-byte identical (the load-bearing bar).
  expect(filesEqual(up1, up2)).toBe(true);
  expect(up2).toEqual(up1);
  // And the down landed exactly back on the original older bytes.
  expect(down1).toEqual(older());
});

test('HEADLINE round-trip: down→up from the newer (customized) format is byte-identical', () => {
  const down = migratePipeline(newer(), 1, opts).files; // 3 → 1 (escrows the custom value)
  const up = migratePipeline(down, 3, opts).files; //       1 → 3 (restores it)
  expect(up).toEqual(newer());
  expect(up[MANIFEST]).toBe(PIPE_V3_CUSTOM);
});

test('assertRoundTrip passes for both a newer and an older fixture', () => {
  expect(assertRoundTrip(newer(), 1, opts).ok).toBe(true); // exercises escrow
  expect(assertRoundTrip(older(), 3, opts).ok).toBe(true); // literal up→down→up
});

// ── x-escrow: newer-only data survives a down ────────────────────────────────

test('x-escrow: down stashes the customized newer-only field; old engine reads format 1', () => {
  const down = migratePipeline(newer(), 1, opts).files;
  const manifest = down[MANIFEST];

  // The live newer-only field is gone from the format-1 file (no top-level
  // `x-v2-extra:` line — it survives only inside the x-escrow payload)...
  expect(manifest).not.toMatch(/^x-v2-extra:/m);
  expect(manifest).toContain('x-legacy-flag: enabled'); // flag renamed back down
  // ...but its exact bytes are stashed in x-escrow for the paired up.
  expect(manifest).toContain('x-escrow:');
  expect(manifest).toContain('custom-user-value');

  const escrow = readEscrow(manifest);
  expect(escrow).not.toBeNull();
  expect((escrow as any)['example-v2-extra'].line).toBe('x-v2-extra: custom-user-value');

  // A format-1 engine (using the shared reader) sees a plain format-1 pipeline.
  expect(parsePipelineFormat(manifest)).toBe(1);
});

test('x-escrow: a DEFAULT-valued newer field is dropped without escrow (no residue)', () => {
  // up(older) synthesizes x-v2-extra:default; down must drop it cleanly.
  const up = migratePipeline(older(), 3, opts).files;
  expect(up[MANIFEST]).toContain('x-v2-extra: default');
  const down = migratePipeline(up, 1, opts).files;
  expect(down[MANIFEST]).not.toContain('x-escrow'); // nothing worth stashing
  expect(down).toEqual(older());
});

// ── ladder walk spans multiple versions ──────────────────────────────────────

test('ladder walks every adjacent rung, up and down, in order', () => {
  const up = migratePipeline(older(), 3, opts);
  expect(up.applied.map((a) => `${a.from}->${a.to}`)).toEqual(['1->2', '2->3']);
  expect(up.applied.every((a) => a.direction === 'up')).toBe(true);

  const down = migratePipeline(newer(), 1, opts);
  expect(down.applied.map((a) => `${a.from}->${a.to}`)).toEqual(['3->2', '2->1']);
  expect(down.applied.every((a) => a.direction === 'down')).toBe(true);
});

test('no-op when already at the target format (changed:false, nothing applied)', () => {
  const r = migratePipeline(older(), 1, opts);
  expect(r.changed).toBe(false);
  expect(r.applied).toEqual([]);
  expect(r.files).toEqual(older());
});

// ── guards: classifyFormat refuses too-new / unknown / malformed targets ─────

test('guard: refuses a target NEWER than the engine current (throws too-new)', () => {
  // Real engine (empty production registry, current = 1): --to 2 is too-new.
  expect(() => migratePipeline(older(), 2)).toThrow(FormatVersionError);
  try {
    migratePipeline(older(), 2);
  } catch (e) {
    expect((e as FormatVersionError).kind).toBe('too-new');
  }
  // Even with the example ladder, a target past its pretend-current is refused.
  expect(() => migratePipeline(older(), 5, opts)).toThrow(FormatVersionError);
});

test('guard: refuses a non-positive-integer target (invalid)', () => {
  for (const bad of [0, -1, 1.5]) {
    expect(() => migratePipeline(older(), bad, opts)).toThrow(FormatVersionError);
  }
});

test('guard: a missing ladder rung is a loud MigrationLadderError, not a silent skip', () => {
  const gapped: MigrationRegistry = [EXAMPLE_2_TO_3]; // no 1→2 rung
  expect(() => migratePipeline(older(), 3, { registry: gapped, current: 3 })).toThrow(
    MigrationLadderError,
  );
});

// ── the harness actually ENFORCES byte-identity ──────────────────────────────

test('round-trip harness CATCHES a non-byte-identical transform', () => {
  // up appends a byte the down never removes → the round trip is not identical.
  const broken: MigrationRegistry = [
    {
      from: 1,
      to: 2,
      up: (f) => ({ ...f, [MANIFEST]: f[MANIFEST] + 'x' }),
      down: (f) => f,
    },
  ];
  const report = checkRoundTrip(older(), 2, { registry: broken, current: 2 });
  expect(report.ok).toBe(false);
  expect(report.roundTripIdentical).toBe(false);
  expect(report.firstDiff?.path).toBe(MANIFEST);
});

// ── small pure helpers ───────────────────────────────────────────────────────

test('validateRegistry: example ladder is well-formed; non-adjacent rungs are flagged', () => {
  expect(validateRegistry(EXAMPLE_MIGRATIONS)).toEqual([]);
  const bad = validateRegistry([{ from: 1, to: 3, up: (f) => f, down: (f) => f }]);
  expect(bad.length).toBeGreaterThan(0);
});

test('diffFiles / filesEqual detect and locate the first divergence', () => {
  const a = older();
  const b = { ...a, [MANIFEST]: a[MANIFEST].replace('enabled', 'disabled') };
  expect(filesEqual(a, a)).toBe(true);
  expect(filesEqual(a, b)).toBe(false);
  expect(diffFiles(a, b)?.path).toBe(MANIFEST);
});

test('renderDiff produces a unified-ish diff for a migration', () => {
  const up = migratePipeline(older(), 3, opts).files;
  const diff = renderDiff(older(), up);
  expect(diff).toContain('--- a/PIPELINE.md');
  expect(diff).toContain('+++ b/PIPELINE.md');
  expect(diff).toContain('x-final-flag'); // the format-3 field appears as added
  // The untouched step file is not in the diff.
  expect(diff).not.toContain('01-only-step');
});
