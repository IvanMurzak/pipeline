// `pipeline stats [--project <path>] [--json]`
//
// View (and regenerate) the per-run measurement files the stats system writes
// under `<project>/.claude/pipeline/.stats/` (see lib/stats.ts — pure
// software, PIPELINE_STATS_ENABLED gated, default ON). This command:
//   1. regenerates SUMMARY.md from every recorded run (so it is always
//      current even if a best-effort render was missed), then
//   2. prints it (or, with --json, prints every run record as a JSON array).
// Read-only apart from the SUMMARY.md regeneration. Exit 0; 2 on usage.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findRunsFiles, parseRunRecords, renderSummary, statsEnabled } from '../lib/stats';

const USAGE = 'usage: pipeline stats [--project <path>] [--json]\n';

export function runStats(args: string[]): number {
  let project: string | null = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--project') {
      const v = args[i + 1];
      if (!v) {
        process.stderr.write(`pipeline stats: --project requires a value\n${USAGE}`);
        return 2;
      }
      project = v;
      i++;
    } else if (a === '--json') {
      json = true;
    } else {
      process.stderr.write(`pipeline stats: unknown option '${a}'\n${USAGE}`);
      return 2;
    }
  }

  const root = resolve(project ?? process.cwd());
  const base = join(root, '.claude', 'pipeline', '.stats');
  if (!existsSync(base)) {
    process.stdout.write(
      `no measurements yet: ${base} does not exist` +
        (statsEnabled()
          ? ' (stats are ENABLED — it appears after the first pipeline run)\n'
          : ' (stats are DISABLED via PIPELINE_STATS_ENABLED — unset it to measure runs)\n'),
    );
    return 0;
  }

  renderSummary(base);

  if (json) {
    const records = findRunsFiles(base).flatMap((f) => (existsSync(f) ? parseRunRecords(readFileSync(f, 'utf8')) : []));
    process.stdout.write(JSON.stringify(records) + '\n');
    return 0;
  }
  const summary = join(base, 'SUMMARY.md');
  process.stdout.write(existsSync(summary) ? readFileSync(summary, 'utf8') : 'no SUMMARY.md rendered\n');
  return 0;
}
