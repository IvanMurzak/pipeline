// Public surface of the migration ladder (T1-18). Import the FRAMEWORK from
// here. The SYNTHETIC example ladder is intentionally NOT re-exported — import
// it explicitly from './example-transform' (test-only) so it can never be
// pulled into production code by accident.

export * from './types';
export { migratePipeline, readFilesFormat, type MigrateOptions } from './migrate';
export {
  PRODUCTION_MIGRATIONS,
  validateRegistry,
  findUpRung,
  findDownRung,
} from './registry';
export {
  checkRoundTrip,
  assertRoundTrip,
  filesEqual,
  diffFiles,
  type RoundTripReport,
} from './roundtrip';
export { renderDiff, diffStat } from './diff';
export {
  setFormatStamp,
  readEscrow,
  writeEscrow,
  type EscrowPayload,
} from './frontmatter-edit';
