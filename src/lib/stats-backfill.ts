// Shared backfill reconciliation core — the ONE fold path every trigger
// (SubagentStop/Stop relay, run-init kick, daemon sweep, `pipeline stats
// backfill`) calls through, so every number they produce is bit-identical.
//
// Reconciliation predicate (P2): a run record is a backfill candidate iff
// `tokens === null` — this is the single source of truth for "needs
// enrichment"; nothing here ever rewrites an already-enriched record
// (`rewriteRunTokens` only fills nulls, lib/stats.ts) and nothing here
// fabricates zeros (that is `summarizeRun`'s explicit-zero rule, §12 —
// finalize-time only, untouched by this module).
//
// Correlation invariant (load-bearing): a record is NEVER folded from a
// transcript that is not correlated with that record's run. The two sources
// that satisfy it by construction: `findTranscriptByRunId` (picks the file
// with the most literal run_id mentions) and the pinned per-step session refs
// (each names its exact session files). A caller-supplied `transcriptHint`
// satisfies it either by provenance (`hintMode: 'always'` — the SubagentStop
// relay, whose matcher guarantees the transcript IS a pipeline-manager's) or
// by an explicit per-record content check (`hintMode: 'correlated'`, the
// default — the record's run_id must literally occur in the hinted
// transcript). Without this gate, a plain session-Stop transcript (which can
// span hours of unrelated work) would time-window-match a stale tokens-null
// record and corrupt it with unrelated usage.
//
// Source select per record:
//   - `runner === 'headless'` (a `pipeline drive` run) → the pinned per-step
//     session transcripts (`.runtime/<run>/sessions/`, apps/pipeline-cli/src/
//     lib/step-transcripts.ts), envelope `usage.json` preferred over the
//     transcript-folded tokens when it carries any usage/cost — the SAME
//     precedence `pipeline drive`'s own terminal-action enrichment uses
//     (commands/drive.ts `enrichStats`).
//   - everything else (`runner === 'manager'`, or unset/legacy) → locate the
//     manager transcript by run_id (`findTranscriptByRunId`) and fold it +
//     its in-window subagents (`foldRunStatsFromTranscript`,
//     apps/pipeline-ui/transcript-stats.ts) — the exact walk the pre-refactor
//     stats_relay hook used inline.
//   - `transcriptHint` + `hintMode:'always'` overrides BOTH branches: every
//     in-window tokens-null record is folded against the hint, regardless of
//     `runner` — byte-compatible with the pre-refactor SubagentStop relay,
//     which never branched on `runner` at all (a headless record's window
//     essentially never overlaps a pipeline-manager transcript, so that fold
//     is a harmless zero — E2 in 01-current-architecture.md §6).
//   - `transcriptHint` + `hintMode:'correlated'` (default) uses the hint only
//     for records whose run_id occurs in it; every other record falls back to
//     the normal runner-based select above.
//
// Every record is guarded independently (try/catch) — one malformed/
// unexpected-shape record must never abort the rest of the pass. Nothing in
// this module throws out to the caller; it is polled by best-effort callers
// (a hook, a run-init kick, a CLI verb, a daemon sweep) that must never fail
// their own operation because of a stats hiccup.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  attributeFailureStep,
  findRunsFiles,
  parseRunRecords,
  statsEnrichTokens,
  stepWindows,
  type RunFailureDetail,
  type TokenStats,
} from './stats';
import { loadUsageTotals } from './envelope';
import { readStepSessionRefs, foldStepSessionTranscripts } from './step-transcripts';
// VENDORED walkers, never the sibling app: apps/pipeline-cli publishes
// standalone to npm and the tarball contains no apps/pipeline-ui, so a
// `../../../pipeline-ui/…` import resolves in this checkout but crashes at
// import time for every npm-installed user (the shipped 0.2.0 regression that
// created lib/vendor/transcript-walk.ts in the first place). Keep the vendor
// file in lockstep with its source per that file's header.
import {
  RUN_FAILURES_COLLECT_MAX,
  collectRunToolFailures,
  foldRunStatsFromTranscript,
  findTranscriptByRunId,
} from './vendor/transcript-walk';

/** D10: default reconciliation window — how far back a record's `ended_at`
 *  may be and still be considered for backfill. The relay keeps its own
 *  narrower 48h window (its trigger fires promptly after the run); this
 *  wider default serves the manual verb / run-init kick / daemon sweep,
 *  which may run long after the fact. */
export const DEFAULT_BACKFILL_WINDOW_MS = 14 * 24 * 3600 * 1000;

export interface BackfillReport {
  /** Records inspected (tokens-null-or-not, in or out of window alike). */
  scanned: number;
  /** run_ids filled this pass. */
  enriched: string[];
  /** tokens !== null already — nothing to do. */
  skipped_enriched: number;
  /** tokens === null but older than windowMs — left alone by design. */
  skipped_window: number;
  /** tokens === null, in window, but no transcript/session evidence found at
   *  all — left null (D10: no snapshotting; revisit on evidence). */
  transcript_pruned: string[];
  /** tokens === null, in window, evidence found, but the fold summed to zero
   *  — left null (never fabricate a zero; a later pass may catch the real
   *  window once the right session is on disk). */
  zero_fold: string[];
  /** Per-record guard trips — the record that failed is skipped; every other
   *  record in the pass still proceeds. */
  errors: string[];
}

export interface BackfillOptions {
  /** Default 14 days (D10). The relay keeps its own 48h. */
  windowMs?: number;
  /** Soft time budget (ms) for best-effort callers (run-init kick ~1500ms,
   *  Stop relay ~4000ms) — checked between records; once exceeded, the pass
   *  stops scanning further records (already-processed records' results
   *  stand). */
  budgetMs?: number;
  /** Test seam: threaded to the transcript locator/folds so tests can point
   *  at a fake `~/.claude/projects` home instead of the real one. */
  homeOverride?: string;
  /** A caller-known transcript (the relay's hook payload). How it is applied
   *  depends on `hintMode`; a hint pointing at a file that does not exist is
   *  treated per-mode too (see below). */
  transcriptHint?: string;
  /** How `transcriptHint` may be applied (see the correlation invariant in
   *  the module header):
   *  - 'always': fold EVERY in-window tokens-null record against the hint,
   *    regardless of `runner` — pre-refactor SubagentStop semantics (the
   *    hook's `pipeline-manager` matcher is the correlation guarantee).
   *    A missing hint file buckets every candidate as transcript_pruned.
   *  - 'correlated' (default): use the hint only for records whose run_id
   *    literally occurs in the hinted transcript; all other records (and
   *    every record when the hint file is missing) take the normal
   *    runner-based source select. The safe mode for the plain Stop hook,
   *    whose transcript is the MAIN session (hours of unrelated work). */
  hintMode?: 'always' | 'correlated';
}

/** One source-select outcome — exactly one of the three report buckets an
 *  in-window tokens-null record can land in. */
type SourceResult =
  | { status: 'pruned' } // no transcript/session evidence at all
  | { status: 'zero' } // evidence found, fold summed to zero — leave null
  | { status: 'found'; tokens: TokenStats; failures?: RunFailureDetail[] };

/** The one "did the fold produce anything" test (P3: one fold path, one zero
 *  rule). cost_usd only exists on the headless/envelope path — undefined
 *  (manager folds) and 0 alike mean "no cost evidence". */
function isZeroTokens(tokens: TokenStats): boolean {
  return tokens.input + tokens.output + tokens.cache_read + tokens.cache_creation === 0 && !tokens.cost_usd;
}

/** Manager-style fold: fold the given transcript + its in-window subagents
 *  over the record's window; collect step-attributed failure detail when the
 *  fold saw a failure. */
function foldManagerStyle(
  transcript: string,
  rec: { run_id: string; started_at: string | null; ended_at: string; steps: unknown },
): SourceResult {
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
  if (isZeroTokens(tokens)) return { status: 'zero' };
  let failures: RunFailureDetail[] | undefined;
  if (folded.tools_failed > 0) {
    const windows = stepWindows(Array.isArray(rec.steps) ? (rec.steps as Parameters<typeof stepWindows>[0]) : []);
    const { failures: raw } = collectRunToolFailures(transcript, rec.started_at, rec.ended_at, RUN_FAILURES_COLLECT_MAX);
    failures = raw.map((f) => ({
      ts: f.ts,
      tool: f.tool_name,
      step: attributeFailureStep(windows, f.ts),
      error: f.error_excerpt,
    }));
  }
  return { status: 'found', tokens, failures };
}

/** Headless-style fold: pinned per-step session transcripts, envelope
 *  `usage.json` preferred over the transcript-folded totals when it carries
 *  any usage/cost — same precedence as `pipeline drive`'s own terminal-action
 *  enrichment (commands/drive.ts `enrichStats`). */
function foldHeadlessStyle(runtimeDir: string, homeOverride: string | undefined): SourceResult {
  const refs = readStepSessionRefs(join(runtimeDir, 'sessions'));
  const fold = foldStepSessionTranscripts(refs, homeOverride);
  // `found` comes from the single read inside loadUsageTotals (no separate
  // existsSync — no TOCTOU between classification and content).
  const usage = loadUsageTotals(join(runtimeDir, 'usage.json'));
  if (!fold.found_any && !usage.found) return { status: 'pruned' };
  const hasEnvelopeUsage =
    usage.totals.input + usage.totals.output + usage.totals.cache_read + usage.totals.cache_creation > 0 ||
    usage.totals.cost_usd > 0;
  const tokens: TokenStats = {
    ...(hasEnvelopeUsage
      ? {
          input: usage.totals.input,
          output: usage.totals.output,
          cache_read: usage.totals.cache_read,
          cache_creation: usage.totals.cache_creation,
          cost_usd: usage.totals.cost_usd,
        }
      : {
          input: fold.input_tokens,
          output: fold.output_tokens,
          cache_read: fold.cache_read_tokens,
          cache_creation: fold.cache_creation_tokens,
        }),
    ...(fold.found_any
      ? { tools_called: fold.tools_called, tools_failed: fold.tools_failed, agents_spawned: fold.agents_spawned }
      : {}),
  };
  if (isZeroTokens(tokens)) return { status: 'zero' };
  return { status: 'found', tokens, failures: fold.failures.length ? fold.failures : undefined };
}

/** Walk up from `start` (an arbitrary cwd, or a pipeline root like
 *  `<project>/.claude/pipeline/<name>`) to the first ancestor containing
 *  `.claude/pipeline` — the projectRoot `backfillProject` expects. The ONE
 *  shared walk every trigger uses to derive its argument (the relay from the
 *  hook payload's cwd, the run-init kick from `--root`). Null when no such
 *  ancestor exists. */
export function findStatsProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, '.claude', 'pipeline'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Reconcile every `tokens === null` run record under `<projectRoot>/.claude/
 *  pipeline/.stats/` that falls in window, per the source-select rules above.
 *  Writes enrichment via `statsEnrichTokens` (regenerates SUMMARY.md).
 *  Idempotent: a record already enriched (by this pass or an earlier one) is
 *  a no-op (`skipped_enriched`) — re-running over an already-reconciled tree
 *  performs zero writes. Never throws. */
export function backfillProject(projectRoot: string, opts: BackfillOptions = {}): BackfillReport {
  const report: BackfillReport = {
    scanned: 0,
    enriched: [],
    skipped_enriched: 0,
    skipped_window: 0,
    transcript_pruned: [],
    zero_fold: [],
    errors: [],
  };
  const root = resolve(projectRoot);
  const base = join(root, '.claude', 'pipeline', '.stats');
  if (!existsSync(base)) return report;

  const windowMs = opts.windowMs ?? DEFAULT_BACKFILL_WINDOW_MS;
  const hintMode = opts.hintMode ?? 'correlated';
  const now = Date.now();
  const budgetStart = now;

  // The hint transcript's text, read ONCE per pass — 'correlated' mode checks
  // each candidate's run_id against it (the same literal-occurrence evidence
  // findTranscriptByRunId counts). null = no hint usable (none supplied, or
  // the file is gone).
  let hintText: string | null = null;
  if (opts.transcriptHint !== undefined) {
    try {
      hintText = readFileSync(opts.transcriptHint, 'utf8');
    } catch {
      hintText = null;
    }
  }

  outer: for (const runsFile of findRunsFiles(base)) {
    let text: string;
    try {
      text = readFileSync(runsFile, 'utf8');
    } catch {
      continue;
    }
    for (const rec of parseRunRecords(text)) {
      if (opts.budgetMs !== undefined && Date.now() - budgetStart > opts.budgetMs) break outer;
      report.scanned++;
      // Per-record guard: one record with an unexpected shape must not abort
      // enrichment for every remaining record and file.
      try {
        if (rec.tokens !== null) {
          report.skipped_enriched++;
          continue;
        }
        const endedMs = Date.parse(rec.ended_at);
        if (!Number.isFinite(endedMs) || now - endedMs > windowMs) {
          report.skipped_window++;
          continue;
        }

        let result: SourceResult;
        if (opts.transcriptHint !== undefined && hintMode === 'always') {
          // Pre-refactor relay semantics: hint or nothing (a vanished hint
          // file means every candidate is unprovable this pass).
          result = hintText === null ? { status: 'pruned' } : foldManagerStyle(opts.transcriptHint, rec);
        } else if (hintText !== null && hintText.includes(rec.run_id)) {
          // 'correlated': this record demonstrably belongs to the hinted
          // session — fold it (manager-style: the hint + its subagents dir,
          // which is where a pipeline-manager's transcript lives when the
          // hint is a main-session file).
          result = foldManagerStyle(opts.transcriptHint as string, rec);
        } else if (rec.runner === 'headless') {
          const runtimeDir = join(root, '.claude', 'pipeline', rec.pipeline, '.runtime', rec.run_id);
          result = foldHeadlessStyle(runtimeDir, opts.homeOverride);
        } else {
          // 'manager' or unset/legacy — same default as statsFinalizeRun.
          const transcript = findTranscriptByRunId(root, rec.run_id, rec.started_at, rec.ended_at, opts.homeOverride);
          result = transcript === null ? { status: 'pruned' } : foldManagerStyle(transcript, rec);
        }

        if (result.status === 'pruned') {
          report.transcript_pruned.push(rec.run_id);
        } else if (result.status === 'zero') {
          report.zero_fold.push(rec.run_id);
        } else if (statsEnrichTokens(base, runsFile, rec.run_id, result.tokens, result.failures)) {
          report.enriched.push(rec.run_id);
        }
      } catch (e) {
        report.errors.push(`${rec.run_id ?? 'unknown'}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return report;
}
