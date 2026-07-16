// The golden-corpus ROUND-TRIP harness (T1-18).
//
// The load-bearing correctness property for the whole migration system is that
// migrating a pipeline to another format and back is BYTE-IDENTICAL, and that
// re-migrating is stable — colloquially "up → down → up is byte-identical".
//
// Given a fixture at format A and the other end B, this checks BOTH:
//   1. round-trip fidelity:  migrate(migrate(X, B), A)  ===  X        (byte-for-byte)
//   2. re-migration stability: migrate(that, B)         ===  migrate(X, B)
//
// (2) is the literal up→down→up when A<B, and the escrow-exercising down→up→down
// when A>B. A future real transform passes this harness or it does not ship.
//
// Pure: delegates to migratePipeline; no I/O.

import { migratePipeline, type MigrateOptions } from './migrate';
import type { PipelineFiles } from './types';

export interface RoundTripReport {
  ok: boolean;
  startVersion: number;
  otherVersion: number;
  /** migrate(migrate(X, other), start) === X */
  roundTripIdentical: boolean;
  /** migrate(migrate(migrate(X, other), start), other) === migrate(X, other) */
  reMigrationStable: boolean;
  /** First file path that differed (with a short reason), when !ok. */
  firstDiff?: { path: string; reason: string };
}

/** Compare two files maps byte-for-byte; report the first path that differs. */
export function diffFiles(
  a: PipelineFiles,
  b: PipelineFiles,
): { path: string; reason: string } | null {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const path of [...keys].sort()) {
    const inA = Object.prototype.hasOwnProperty.call(a, path);
    const inB = Object.prototype.hasOwnProperty.call(b, path);
    if (inA && !inB) return { path, reason: 'present on one side only (removed)' };
    if (!inA && inB) return { path, reason: 'present on one side only (added)' };
    if (a[path] !== b[path]) {
      return { path, reason: firstByteDiff(a[path], b[path]) };
    }
  }
  return null;
}

function firstByteDiff(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 12), i + 12));
  return `bytes differ at offset ${i} (len ${a.length} vs ${b.length}): ${ctx(a)} vs ${ctx(b)}`;
}

/** True iff the two files maps are byte-identical. */
export function filesEqual(a: PipelineFiles, b: PipelineFiles): boolean {
  return diffFiles(a, b) === null;
}

/**
 * Run the round-trip on `fixture` (at whatever format it is stamped) against the
 * `otherVersion` end of the ladder, using the given registry/current options.
 * Returns a structured report (never throws for a mere byte mismatch — the
 * mismatch is reported; it DOES propagate ladder/guard errors).
 */
export function checkRoundTrip(
  fixture: PipelineFiles,
  otherVersion: number,
  opts: MigrateOptions = {},
): RoundTripReport {
  const there = migratePipeline(fixture, otherVersion, opts);
  const startVersion = there.from;
  const back = migratePipeline(there.files, startVersion, opts);

  const roundDiff = diffFiles(back.files, fixture);
  const roundTripIdentical = roundDiff === null;

  const thereAgain = migratePipeline(back.files, otherVersion, opts);
  const stableDiff = diffFiles(thereAgain.files, there.files);
  const reMigrationStable = stableDiff === null;

  const ok = roundTripIdentical && reMigrationStable;
  const report: RoundTripReport = {
    ok,
    startVersion,
    otherVersion,
    roundTripIdentical,
    reMigrationStable,
  };
  const firstDiff = roundDiff ?? stableDiff;
  if (firstDiff) report.firstDiff = firstDiff;
  return report;
}

/**
 * Assert the round-trip holds, throwing a descriptive Error otherwise. Handy in
 * tests and as a self-check a future transform's own suite can call.
 */
export function assertRoundTrip(
  fixture: PipelineFiles,
  otherVersion: number,
  opts: MigrateOptions = {},
): RoundTripReport {
  const report = checkRoundTrip(fixture, otherVersion, opts);
  if (!report.ok) {
    const where = report.firstDiff
      ? ` — first divergence in ${report.firstDiff.path}: ${report.firstDiff.reason}`
      : '';
    const stage = !report.roundTripIdentical ? 'round-trip fidelity' : 're-migration stability';
    throw new Error(
      `Round-trip FAILED (${stage}) between format ${report.startVersion} and ${report.otherVersion}${where}`,
    );
  }
  return report;
}
