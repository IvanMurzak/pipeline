#!/usr/bin/env bun
/**
 * FROZEN CHARACTERIZATION FIXTURE — do not "fix" or refactor this file.
 *
 * A verbatim copy of `hooks/stats_relay.ts` as it existed BEFORE the a1
 * backfill-core refactor (the inline SubagentStop enrichment loop, before it
 * became a thin wrapper over `lib/stats-backfill.ts#backfillProject`). Its
 * only job is to be spawned by
 * `apps/pipeline-cli/tests/hook-stats-relay.test.ts` as the "pre-refactor"
 * half of the byte-equivalence check — the refactored hook must still
 * produce byte-identical `runs.jsonl` output for the SubagentStop path.
 *
 * Only the two import paths were adjusted (this file lives two directories
 * deeper than the real hook did); the algorithm below is untouched.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  attributeFailureStep,
  findRunsFiles,
  parseRunRecords,
  statsEnabled,
  statsEnrichTokens,
  stepWindows,
  type RunFailureDetail,
  type TokenStats,
} from '../../src/lib/stats';
import {
  RUN_FAILURES_COLLECT_MAX,
  collectRunToolFailures,
  foldRunStatsFromTranscript,
} from '../../../pipeline-ui/transcript-stats';

const ENRICH_WINDOW_MS = 48 * 3600 * 1000;

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Walk up from `start` to the first dir containing `.claude/pipeline`. */
function findProjectRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.claude', 'pipeline'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function main(): void {
  if (!statsEnabled()) return;
  let payload: HookPayload;
  try {
    payload = JSON.parse(readStdin()) as HookPayload;
  } catch {
    return;
  }
  const transcript = payload.transcript_path;
  if (!transcript || !existsSync(transcript)) return;
  const projectRoot = findProjectRoot(payload.cwd || process.cwd());
  if (!projectRoot) return;
  const base = join(projectRoot, '.claude', 'pipeline', '.stats');
  if (!existsSync(base)) return;

  const now = Date.now();
  for (const runsFile of findRunsFiles(base)) {
    let text: string;
    try {
      text = readFileSync(runsFile, 'utf8');
    } catch {
      continue;
    }
    for (const rec of parseRunRecords(text)) {
      // Per-record guard: one malformed line (valid JSON, wrong shape) must
      // not abort enrichment for every remaining run and file.
      try {
        if (rec.tokens !== null) continue;
        const endedMs = Date.parse(rec.ended_at);
        if (!Number.isFinite(endedMs) || now - endedMs > ENRICH_WINDOW_MS) continue;
        const folded = foldRunStatsFromTranscript(transcript, rec.started_at, rec.ended_at);
        const tokens: TokenStats = {
          input: folded.input_tokens,
          output: folded.output_tokens,
          cache_read: folded.cache_read_tokens,
          cache_creation: folded.cache_creation_tokens,
          tools_called: folded.tools_called,
          tools_failed: folded.tools_failed,
          agents_spawned: folded.agents_spawned,
        };
        // Zero tokens ⇒ this session's transcript doesn't cover that run's
        // window — leave it null for the run's own manager-stop to fill.
        if (tokens.input + tokens.output + tokens.cache_read + tokens.cache_creation === 0) continue;
        // Failure detail (same walk as the FAIL tile): per-failure lines for
        // the .log, step-attributed by timestamp against windows built ONCE
        // per record (null when no window, or windows of different steps,
        // contain it). failed_tools counts derive inside statsEnrichTokens.
        let failures: RunFailureDetail[] | undefined;
        if (folded.tools_failed > 0) {
          const windows = stepWindows(Array.isArray(rec.steps) ? rec.steps : []);
          const { failures: raw } = collectRunToolFailures(
            transcript,
            rec.started_at,
            rec.ended_at,
            RUN_FAILURES_COLLECT_MAX,
          );
          failures = raw.map((f) => ({
            ts: f.ts,
            tool: f.tool_name,
            step: attributeFailureStep(windows, f.ts),
            error: f.error_excerpt,
          }));
        }
        statsEnrichTokens(base, runsFile, rec.run_id, tokens, failures);
      } catch {
        // skip this record — the rest still enrich
      }
    }
  }
}

try {
  main();
} catch {
  // never fail the stop
}
process.exit(0);
