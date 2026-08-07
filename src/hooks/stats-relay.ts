/**
 * `pipeline hook stats-relay` — the stats relay (Stop; SubagentStop, matcher:
 * pipeline-manager).
 *
 * WHERE THIS RUNS. A CLI SUBCOMMAND, invoked by `pipeline-claude`'s
 * `hooks/hooks.json` through `hooks/run-hook.sh` (plugin-thin `p6`). It was
 * the file that made the move non-optional: as a script inside the plugin it
 * imported `apps/pipeline-cli/src/lib/stats` and `lib/stats-backfill`, so it
 * would have broken the instant that directory was deleted. Now the import is
 * an ordinary sibling one.
 *
 * Token enrichment for the per-run measurement system (pure software, zero
 * LLM tokens). Phase 1 happens in-process inside `pipeline next`: duration,
 * per-step timings, and outcomes are finalized into
 * `<project>/.pipeline/.stats/<pipeline>/runs.jsonl` the moment a run
 * ends — but the CLI subprocess cannot see transcripts, so `tokens` is null.
 * This hook is phase 2: it fires when a pipeline-manager subagent stops (or
 * on a plain session Stop — same script, registered under both), folds the
 * manager + subagent transcripts through the SAME window-gated fold the
 * CLI uses (src/lib/vendor/transcript-walk.ts — validated as the
 * only complete token source), and rewrites the matching runs.jsonl entries
 * in place — tokens, tool counts, AND tool failures (per-tool counts in the
 * record, per-failure detail lines in the run's .log) so /pipeline:optimize
 * can flag failing pipelines without re-reading transcripts.
 *
 * Thin wrapper: the actual reconciliation walk (find every tokens-null
 * record in window, source its transcript, fold, write) lives in the shared
 * core `src/lib/stats-backfill.ts#backfillProject` — the
 * SAME core every other trigger (this hook, the run-init kick, the daemon
 * sweep, `pipeline stats backfill`) calls through, so every trigger produces
 * bit-identical numbers. This hook's only job: gate, resolve the project
 * root, and pass its own transcript as `transcriptHint` with its narrower
 * 48h window — in the mode the firing event justifies:
 *
 *  - SubagentStop (matcher: pipeline-manager): the transcript IS a
 *    pipeline-manager's — the matcher is the correlation guarantee, so the
 *    hint applies unconditionally (`hintMode: 'always'`), byte-compatible
 *    with the pre-refactor inline loop. Unbudgeted, like before.
 *  - Stop (every ordinary session close — INTENDED, rung T2 of the E1
 *    cascade, not an accident): the transcript is the MAIN session's, which
 *    can span hours of unrelated runs and chat. The hint therefore applies
 *    only to records whose run_id literally occurs in it
 *    (`hintMode: 'correlated'`); everything else falls back to the core's
 *    correlation-safe locator. Soft-budgeted (STOP_BUDGET_MS) so a session
 *    close never stalls on a large .stats tree.
 *
 * Gating: PIPELINE_STATS_ENABLED (default ON — set 0/false/off/no to disable;
 * NOTE this is deliberately independent of PIPELINE_JOURNAL_ENABLED — stats keep
 * their own gate even when the journal/analytics system is opted out). Also a no-op
 * when the cwd has no `.pipeline/.stats/`.
 *
 * Attribution: each tokens-null run recorded in the last 48h is folded with
 * ITS OWN [started_at, ended_at] window over this session's transcript — the
 * per-entry timestamp gate attributes entries correctly even when a session
 * hosts several runs. A fold that lands zero tokens leaves the record null
 * (a later stop in the right session will fill it).
 *
 * Failure posture: silent no-op. This hook must never fail a session stop.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statsEnabled } from '../lib/stats';
import { backfillProject, findStatsProjectRoot } from '../lib/stats-backfill';

const ENRICH_WINDOW_MS = 48 * 3600 * 1000;
/** Soft budget for the Stop rung only — an ordinary session close must never
 *  hang on reconciling a huge .stats tree (the SubagentStop rung stays
 *  unbudgeted for byte-compat with the pre-refactor relay; the tree it walks
 *  is the same one, so a pathological tree would have stalled it before this
 *  refactor too). */
const STOP_BUDGET_MS = 4000;

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
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
  const projectRoot = findStatsProjectRoot(payload.cwd || process.cwd());
  if (!projectRoot) return;
  if (!existsSync(join(projectRoot, '.pipeline', '.stats'))) return;

  // SubagentStop's pipeline-manager matcher makes the transcript run-
  // correlated by provenance → unconditional hint. Anything else (Stop, or a
  // payload without hook_event_name) gets the content-correlated safe mode.
  if (payload.hook_event_name === 'SubagentStop') {
    backfillProject(projectRoot, { windowMs: ENRICH_WINDOW_MS, transcriptHint: transcript, hintMode: 'always' });
  } else {
    backfillProject(projectRoot, {
      windowMs: ENRICH_WINDOW_MS,
      transcriptHint: transcript,
      hintMode: 'correlated',
      budgetMs: STOP_BUDGET_MS,
    });
  }
}

/**
 * `pipeline hook stats-relay` — the subcommand entry point.
 *
 * ALWAYS RETURNS 0, for the reason this file's header calls its failure
 * posture: a stats enrichment pass must never fail a session stop. The
 * standalone script spelled the same contract as a bare `process.exit(0)`
 * after a swallowing try/catch.
 */
export function runStatsRelay(): number {
  try {
    main();
  } catch {
    // never fail the stop
  }
  return 0;
}

export { main as statsRelayMain };
