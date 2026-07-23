// `pipeline stats [--project <path>] [--json]`
// `pipeline stats backfill [--project <path>] [--json]`
//
// View (and regenerate) the per-run measurement files the stats system writes
// under `<project>/.claude/pipeline/.stats/` (see lib/stats.ts — pure
// software, PIPELINE_STATS_ENABLED gated, default ON). The base command:
//   1. regenerates SUMMARY.md from every recorded run (so it is always
//      current even if a best-effort render was missed), then
//   2. prints it (or, with --json, prints every run record as a JSON array).
// The `backfill` verb (T5, gated by PIPELINE_STATS_ENABLED like every other
// trigger) runs the shared reconciliation core (lib/stats-backfill.ts) over
// the project's whole `.stats/` tree and prints the resulting BackfillReport
// — useful after a missed hook (crash, plugin disabled at the time) or a
// pruned-transcript pass that has since gained a snapshot.
// Read-only apart from the SUMMARY.md regeneration / backfill's writes.
// Exit 0; 2 on usage.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findRunsFiles, parseRunRecords, renderSummary, statsEnabled } from '../lib/stats';
import { backfillProject } from '../lib/stats-backfill';

const USAGE = 'usage: pipeline stats [--project <path>] [--json]\n       pipeline stats backfill [--project <path>] [--json]\n';

function parseFlags(args: string[]): { project: string | null; json: boolean } | number {
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
  return { project, json };
}

function runBackfill(args: string[]): number {
  const parsed = parseFlags(args);
  if (typeof parsed === 'number') return parsed;
  const { project, json } = parsed;
  const root = resolve(project ?? process.cwd());

  if (!statsEnabled()) {
    process.stdout.write('stats are DISABLED via PIPELINE_STATS_ENABLED — unset it to measure runs\n');
    return 0;
  }

  const report = backfillProject(root);
  if (json) {
    process.stdout.write(JSON.stringify(report) + '\n');
    return 0;
  }
  process.stdout.write(
    `backfill: scanned ${report.scanned} · enriched ${report.enriched.length} · ` +
      `already-enriched ${report.skipped_enriched} · out-of-window ${report.skipped_window} · ` +
      `pruned ${report.transcript_pruned.length} · zero-fold ${report.zero_fold.length}` +
      (report.errors.length ? ` · errors ${report.errors.length}` : '') +
      '\n',
  );
  if (report.enriched.length) process.stdout.write(`enriched run_ids: ${report.enriched.join(', ')}\n`);
  if (report.errors.length) process.stdout.write(`errors: ${report.errors.join('; ')}\n`);
  return 0;
}

export function runStats(args: string[]): number {
  if (args[0] === 'backfill') return runBackfill(args.slice(1));

  const parsed = parseFlags(args);
  if (typeof parsed === 'number') return parsed;
  const { project, json } = parsed;

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
