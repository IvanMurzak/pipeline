// Per-run measurement (stats) — pure software, zero LLM tokens.
//
// Measures every pipeline run (duration, per-step timings, outcomes, and —
// via the stats relay hook — tokens folded from the raw transcripts) into
// simple text files the user reviews directly:
//
//   <project>/.claude/pipeline/.stats/
//     SUMMARY.md                     # rollup: per pipeline — runs, success, avg duration/tokens
//     <pipeline-rel>/runs.jsonl      # one machine-readable line per finished run
//     <pipeline-rel>/runs/<id>.log   # human per-run timeline (step-by-step timings)
//     <pipeline-rel>/runs/<id>.jsonl # in-flight buffer (deleted on finalize; a
//                                    # leftover = crashed/killed run, surfaced by SUMMARY)
//
// Wiring: `pipeline next` (and therefore `pipeline drive`, which shares
// invokeNext) appends timeline lines in-process as actions/records flow
// through, and finalizes on the terminal action. The SubagentStop stats relay
// hook (hooks/stats_relay.ts) later enriches finished runs with token counts
// folded from the manager transcript (apps/pipeline-ui/transcript-stats.ts —
// the only complete token source; hook-emitted turn.usage undercounts).
//
// Master switch: PIPELINE_STATS_ENABLED — ON by default; set 0/false/off/no
// to disable. Every entry point is best-effort and MUST NOT throw into the
// run loop: stats failures never affect an action, exit code, or event.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { ensureGeneratedDir } from './generated-dir';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Switch + paths
// ---------------------------------------------------------------------------

const OFF = new Set(['0', 'false', 'off', 'no']);

/** Default ON. Only an explicit 0/false/off/no disables measurement. */
export function statsEnabled(): boolean {
  const v = (process.env.PIPELINE_STATS_ENABLED ?? '').trim().toLowerCase();
  return !OFF.has(v);
}

export interface StatsLocation {
  /** `<pipelines-dir>/.stats` (or `<parent-of-root>/.stats` as fallback). */
  base: string;
  /** Pipeline path relative to the pipelines dir — the per-pipeline subdir. */
  rel: string;
}

/** Resolve where stats live for a pipeline root. Walks up looking for the
 *  canonical `<project>/.claude/pipeline` ancestor so every pipeline in a
 *  project (including nested targets) shares ONE `.stats/` tree. */
export function statsLocation(pipelineRoot: string): StatsLocation {
  const root = resolve(pipelineRoot);
  let dir = dirname(root);
  while (true) {
    if (basename(dir) === 'pipeline' && basename(dirname(dir)) === '.claude') {
      return { base: join(dir, '.stats'), rel: relative(dir, root).split(sep).join('/') };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { base: join(dirname(root), '.stats'), rel: basename(root) };
}

function bufferPath(loc: StatsLocation, runId: string): string {
  return join(loc.base, loc.rel, 'runs', `${runId}.jsonl`);
}

function runsJsonlPath(loc: StatsLocation): string {
  return join(loc.base, loc.rel, 'runs.jsonl');
}

// ---------------------------------------------------------------------------
// Timeline buffer (appended as the run progresses)
// ---------------------------------------------------------------------------

export interface BufferLine {
  /** epoch ms */
  t: number;
  /** kind: run.started | step.started | step.completed | improver.started |
   *  improver.completed | script.started | script.completed | merge.completed |
   *  retro.completed | run.blocked */
  k: string;
  [key: string]: unknown;
}

/** Append one timeline line to the in-flight buffer. Never throws. */
export function statsAppend(pipelineRoot: string, runId: string, line: Omit<BufferLine, 't'> & { t?: number }): void {
  if (!statsEnabled()) return;
  try {
    const loc = statsLocation(pipelineRoot);
    const p = bufferPath(loc, runId);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ t: line.t ?? Date.now(), ...line }) + '\n', 'utf8');
  } catch {
    // best-effort — never affect the run
  }
}

export function parseBufferLines(text: string): BufferLine[] {
  const out: BufferLine[] = [];
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as BufferLine;
      if (o && typeof o === 'object' && typeof o.k === 'string') out.push(o);
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finalize — buffer → runs.jsonl line + per-run .log + SUMMARY.md
// ---------------------------------------------------------------------------

export interface StepStat {
  id: string;
  /** ISO of the step.started line (null when only a completion was seen) —
   *  lets enrichment attribute a tool failure's timestamp to a step. */
  started_at: string | null;
  seconds: number | null;
  outcome: string;
  model: string | null;
  /** Resolved reasoning effort the step ran with (null = inherited). */
  effort: string | null;
  /** `'script'` for a `type: script` step executed in-process (zero LLM
   *  tokens) — ABSENT means an ordinary agent step (the default). Tagged from
   *  the T31 buffer notes; keyed on the DISPATCH type, so a §6.3 fallback
   *  (agent re-dispatch of a failed script step) is an agent step and untagged. */
  step_type?: 'script';
  /** Failure class of a FAILED script step (transient|binding|env|crash|
   *  contract|bug) — ABSENT on success and on every agent step. Surfaces the
   *  script failure in the run .log beside the agent tool fails (§12). */
  failure_class?: string;
}

export interface TokenStats {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  tools_called?: number;
  tools_failed?: number;
  /** Per-tool failure counts, e.g. {"Bash": 3, "Edit": 1} — only present when
   *  the run had failures. What /pipeline:optimize flags on. */
  failed_tools?: Record<string, number>;
  agents_spawned?: number;
  /** Total API cost in USD — headless runs fold it from the claude -p JSON
   *  envelopes (`total_cost_usd`); absent for manager-transcript folds. */
  cost_usd?: number;
}

/** One tool failure, ready for the run's .log — enrichment builds these from
 *  the transcript fold (relay: manager+subagent walk; drive: per-step session
 *  transcripts, where `step` is exact). */
export interface RunFailureDetail {
  ts: string;
  tool: string | null;
  /** Step the failure happened in — null when it can't be attributed. */
  step: string | null;
  error: string;
}

export interface RunRecord {
  schema: 1;
  run_id: string;
  pipeline: string;
  started_at: string | null;
  ended_at: string;
  duration_s: number | null;
  outcome: string;
  halt_reason: string | null;
  runner: string;
  mode: string | null;
  steps_run: number;
  steps: StepStat[];
  improver_runs: number;
  improver_applied: number;
  scripts_created: number;
  merges: number;
  merge_conflicts: number;
  /** Count of AGENT-type step dispatches (untagged `step.started` lines). A run
   *  whose steps were all `type: script` has `llm_steps: 0`. Optional so
   *  records written BEFORE 0.71 (which lack it) still parse — an absent value
   *  is "unknown" and keeps the legacy pending-enrichment behavior. */
  llm_steps?: number;
  /** null until the stats relay hook folds the transcripts. A finished run with
   *  `llm_steps === 0` finalizes this as explicit zeros instead (§12): it spent
   *  no LLM tokens, so it must NOT wait for an enrichment that will never come. */
  tokens: TokenStats | null;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function stepIdOf(line: BufferLine): string {
  const sid = typeof line.step_id === 'string' && line.step_id ? line.step_id : null;
  const path = typeof line.path === 'string' ? line.path : '';
  return sid ?? (path ? basename(path).replace(/\.md$/i, '') : 'step');
}

/** Pure fold: timeline buffer → the run's summary record. Exported for tests. */
export function summarizeRun(
  lines: BufferLine[],
  args: { runId: string; pipeline: string; outcome: string; haltReason: string | null; runner: string; endedMs: number },
): RunRecord {
  const startedMs = lines.length ? lines[0].t : null;
  let mode: string | null = null;
  const stepStart = new Map<string, { t: number; model: string | null; effort: string | null; scriptStep: boolean }>();
  const steps: StepStat[] = [];
  let improverRuns = 0;
  let improverApplied = 0;
  let scriptsCreated = 0;
  let merges = 0;
  let mergeConflicts = 0;
  // §12: count of AGENT-type step dispatches — the UNTAGGED `step.started`
  // lines. Script dispatches carry `step_type: 'script'` (T31) and are
  // excluded; this holds in both normal and --manual-scripts modes.
  let llmSteps = 0;

  for (const line of lines) {
    switch (line.k) {
      case 'run.started':
        if (typeof line.mode === 'string') mode = line.mode;
        break;
      case 'step.started': {
        const scriptStep = line.step_type === 'script';
        if (!scriptStep) llmSteps += 1;
        stepStart.set(stepIdOf(line), {
          t: line.t,
          model: typeof line.model === 'string' ? line.model : null,
          effort: typeof line.effort === 'string' ? line.effort : null,
          scriptStep,
        });
        break;
      }
      case 'step.completed': {
        const id = stepIdOf(line);
        const started = stepStart.get(id);
        stepStart.delete(id);
        // step_type is on both the started and completed line (T31); read
        // whichever is present so a completion with no matching start (layer
        // entries) is still tagged. failure_class rides the completion only.
        const scriptStep = started?.scriptStep === true || line.step_type === 'script';
        const failureClass = typeof line.failure_class === 'string' ? line.failure_class : undefined;
        steps.push({
          id,
          started_at: started ? (iso(started.t) as string) : null,
          seconds: started ? Math.round((line.t - started.t) / 1000) : null,
          outcome: typeof line.outcome === 'string' ? line.outcome : 'unknown',
          model: started?.model ?? null,
          effort: started?.effort ?? null,
          // Additive tags — omitted entirely for agent steps so their StepStat
          // shape is byte-identical to pre-0.71 records.
          ...(scriptStep ? { step_type: 'script' as const } : {}),
          ...(failureClass ? { failure_class: failureClass } : {}),
        });
        break;
      }
      case 'improver.completed':
        improverRuns++;
        if (line.applied === true) improverApplied++;
        break;
      case 'script.completed':
        if (line.outcome === 'created' || line.outcome === 'updated') scriptsCreated++;
        break;
      case 'merge.completed':
        merges++;
        if (line.conflict === true) mergeConflicts++;
        break;
      default:
        break;
    }
  }

  return {
    schema: 1,
    run_id: args.runId,
    pipeline: args.pipeline,
    started_at: iso(startedMs),
    ended_at: iso(args.endedMs) as string,
    duration_s: startedMs === null ? null : Math.round((args.endedMs - startedMs) / 1000),
    outcome: args.outcome,
    halt_reason: args.haltReason,
    runner: args.runner,
    mode,
    steps_run: steps.length,
    steps,
    improver_runs: improverRuns,
    improver_applied: improverApplied,
    scripts_created: scriptsCreated,
    merges,
    merge_conflicts: mergeConflicts,
    llm_steps: llmSteps,
    // §12 zero-token truth fix: a FINISHED (completed) run with NO agent steps
    // spent zero LLM tokens — finalize as explicit zeros so it is not left
    // "pending" for a transcript enrichment that will never fold anything. The
    // relay hook's own zero-guard (leave null when a fold lands zero) is for
    // runs that HAD agent steps but whose window this session's transcript
    // doesn't cover; here there simply are none, so zeros are the truth.
    //
    // The `outcome === 'completed'` gate is load-bearing: statsFinalizeRun is
    // also called with 'halted' on every halt action and on mid-run plan
    // errors. An agent-mode run that HALTS before dispatching any step (e.g. a
    // worktree provision-hook failure at init — run.started is buffered before
    // the hooks run) also has llm_steps 0, but it DID spawn the manager and
    // must stay tokens:null so the SubagentStop relay (which skips records
    // whose tokens !== null) can still restore the manager's real spend +
    // tool-failure forensics. Only a genuinely COMPLETED all-deterministic run
    // (manager-driven, all-script — spec'd to stay zeros) is truly zero (§12).
    tokens:
      llmSteps === 0 && args.outcome === 'completed'
        ? { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
        : null,
  };
}

/** Render the human per-run timeline log. Exported for tests. */
export function renderRunLog(rec: RunRecord): string {
  const lines: string[] = [];
  lines.push(
    `run ${rec.run_id} — ${rec.pipeline} — ${rec.outcome.toUpperCase()} in ${fmtDuration(rec.duration_s)} (runner: ${rec.runner}${rec.mode ? `, mode: ${rec.mode}` : ''})`,
  );
  lines.push(`started ${rec.started_at ?? '—'} · ended ${rec.ended_at}`);
  if (rec.steps.length) {
    lines.push(`steps (${rec.steps.length}):`);
    const wid = Math.max(...rec.steps.map((s) => s.id.length), 4);
    for (const s of rec.steps) {
      // A script step shows `script` in place of a model (it has none); a
      // failed script also shows its failure class, so script fails read in the
      // .log beside the agent tool fails (§12).
      const meta = [
        s.step_type === 'script' ? 'script' : s.model,
        s.effort ? `effort:${s.effort}` : null,
        s.failure_class ? `failed: ${s.failure_class}` : null,
      ].filter(Boolean);
      lines.push(
        `  ${s.id.padEnd(wid)}  ${fmtDuration(s.seconds).padStart(7)}  ${s.outcome}${
          meta.length ? `  (${meta.join(', ')})` : ''
        }`,
      );
    }
  }
  lines.push(
    `improver passes: ${rec.improver_runs} (applied ${rec.improver_applied}) · scripts created: ${rec.scripts_created} · merges: ${rec.merges}${rec.merge_conflicts ? ` (${rec.merge_conflicts} conflict)` : ''}`,
  );
  if (rec.halt_reason) lines.push(`halt reason: ${rec.halt_reason}`);
  if (!rec.tokens) {
    lines.push('tokens: pending — the stats hook fills this in when the manager session ends');
  } else if (rec.llm_steps === 0 && rec.outcome === 'completed') {
    // §12 zero-token run (all deterministic / script steps) — finalized as
    // explicit zeros, never "pending". Gated on 'completed' to match the
    // finalize above: a HALTED zero-dispatch run keeps tokens:null and renders
    // as "pending" (it still awaits the manager-spend enrichment).
    lines.push('tokens: none — 0 LLM steps (all deterministic)');
  }
  return lines.join('\n') + '\n';
}

/** Finalize a run: fold its buffer, append runs.jsonl, write the .log, delete
 *  the buffer, regenerate SUMMARY.md. Idempotent per run_id. Never throws. */
export function statsFinalizeRun(
  pipelineRoot: string,
  runId: string,
  outcome: string,
  haltReason: string | null,
): void {
  if (!statsEnabled()) return;
  try {
    const loc = statsLocation(pipelineRoot);
    const runsFile = runsJsonlPath(loc);
    if (existsSync(runsFile) && readFileSync(runsFile, 'utf8').includes(`"run_id":${JSON.stringify(runId)}`)) {
      return; // already finalized (terminal `next` actions can repeat)
    }
    const buf = bufferPath(loc, runId);
    const lines = existsSync(buf) ? parseBufferLines(readFileSync(buf, 'utf8')) : [];
    const rec = summarizeRun(lines, {
      runId,
      pipeline: loc.rel,
      outcome,
      haltReason,
      runner: (process.env.PIPELINE_STATS_RUNNER ?? '').trim() || 'manager',
      endedMs: Date.now(),
    });
    ensureGeneratedDir(join(loc.base, loc.rel, 'runs'), loc.base);
    appendFileSync(runsFile, JSON.stringify(rec) + '\n', 'utf8');
    writeFileSync(join(loc.base, loc.rel, 'runs', `${runId}.log`), renderRunLog(rec), 'utf8');
    if (existsSync(buf)) unlinkSync(buf);
    renderSummary(loc.base);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Token enrichment (called by hooks/stats_relay.ts + `pipeline stats`)
// ---------------------------------------------------------------------------

/** Every runs.jsonl under the stats base (recursive; skips per-run `runs/`). */
export function findRunsFiles(base: string, depth = 8): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number): void => {
    if (d > depth || !existsSync(dir)) return;
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? e.name + '/' : e.name));
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'runs.jsonl') out.push(join(dir, name));
      else if (name.endsWith('/') && name !== 'runs/') walk(join(dir, name.slice(0, -1)), d + 1);
    }
  };
  walk(base, 0);
  return out;
}

export function parseRunRecords(text: string): RunRecord[] {
  const out: RunRecord[] = [];
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as RunRecord;
      if (o && typeof o === 'object' && typeof o.run_id === 'string') out.push(o);
    } catch {
      // skip corrupt lines
    }
  }
  return out;
}

/** Rewrite one run's `tokens` in a runs.jsonl text. Returns the new text, or
 *  null when the run_id wasn't found / already enriched. Pure; tested. */
export function rewriteRunTokens(text: string, runId: string, tokens: TokenStats): string | null {
  const lines = text.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    let rec: RunRecord;
    try {
      rec = JSON.parse(t) as RunRecord;
    } catch {
      continue;
    }
    if (rec.run_id === runId && rec.tokens === null) {
      rec.tokens = tokens;
      lines[i] = JSON.stringify(rec);
      changed = true;
    }
  }
  return changed ? lines.join('\n') : null;
}

/** Slack (ms) when mapping a failure timestamp onto a step's time window —
 *  step.started/completed lines and transcript entries come from different
 *  clocks (CLI process vs. Claude Code writer). */
const STEP_ATTRIBUTION_SLACK_MS = 2000;

/** Precomputed attribution window (epoch ms) — build once per run record via
 *  stepWindows(), then attribute each failure against numbers instead of
 *  re-parsing every step's ISO timestamps per failure (up to 5000×). */
export interface StepWindow {
  id: string;
  start: number;
  end: number;
}

export function stepWindows(steps: StepStat[]): StepWindow[] {
  const out: StepWindow[] = [];
  for (const s of steps) {
    if (s.started_at === null || s.seconds === null) continue;
    const start = Date.parse(s.started_at);
    if (!Number.isFinite(start)) continue;
    out.push({ id: s.id, start, end: start + s.seconds * 1000 });
  }
  return out;
}

/** Attribute a failure timestamp to a step: the step whose window contains
 *  it. Exact containment wins over slack-only matches (a failure in step A's
 *  final seconds must not go null just because step B started within the
 *  clock-skew slack); windows that agree on the step id are one match, not an
 *  ambiguity (a re-executed step has several windows with the same id).
 *  Returns null only when the timestamp genuinely matches steps with
 *  DIFFERENT ids (overlapping DAG layers — a guess is worse than "unknown")
 *  or matches nothing. */
export function attributeFailureStep(windows: StepWindow[], tsIso: string): string | null {
  const ts = Date.parse(tsIso);
  if (!Number.isFinite(ts)) return null;
  const uniqueId = (ids: Set<string>): string | null => (ids.size === 1 ? [...ids][0] : null);
  const exact = new Set<string>();
  const slack = new Set<string>();
  for (const w of windows) {
    if (ts >= w.start && ts <= w.end) exact.add(w.id);
    else if (ts >= w.start - STEP_ATTRIBUTION_SLACK_MS && ts <= w.end + STEP_ATTRIBUTION_SLACK_MS) slack.add(w.id);
  }
  if (exact.size) return uniqueId(exact);
  return uniqueId(slack);
}

/** Per-tool failure counts for the run record — {"Bash": 3, "Edit": 1}. */
export function failedToolCounts(failures: Array<{ tool: string | null }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of failures) out[f.tool ?? '?'] = (out[f.tool ?? '?'] ?? 0) + 1;
  return out;
}

const FAILURE_LOG_MAX_LINES = 30;
const FAILURE_LOG_ERROR_MAX = 180;

/** Render the "tool fails" .log section appended by enrichment. Pure. */
export function renderFailureLogSection(failures: RunFailureDetail[], totalFailed: number): string {
  const shown = failures.slice(0, FAILURE_LOG_MAX_LINES);
  const L = [`tool fails (${totalFailed}):`];
  for (const f of shown) {
    const err = f.error.replace(/\s+/g, ' ').trim();
    L.push(
      `  ${f.ts}  ${f.tool ?? '?'}${f.step ? `  [${f.step}]` : ''}  ${
        err.length > FAILURE_LOG_ERROR_MAX ? err.slice(0, FAILURE_LOG_ERROR_MAX) + ' […]' : err
      }`,
    );
  }
  const rest = totalFailed - shown.length;
  if (rest > 0) L.push(`  (+${rest} more — the dashboard FAIL tile has the full list)`);
  return L.join('\n') + '\n';
}

/** Enrich a finished run with folded token stats: rewrite its runs.jsonl line,
 *  append a tokens line (and, when provided, a tool-fails section) to its
 *  .log, regenerate SUMMARY.md. `failed_tools` is derived here from the
 *  failures list — callers pass the raw details once, not the counts too.
 *  Never throws. */
export function statsEnrichTokens(
  base: string,
  runsFile: string,
  runId: string,
  tokens: TokenStats,
  failures?: RunFailureDetail[],
): boolean {
  try {
    if (!existsSync(runsFile)) return false;
    if (failures && failures.length && tokens.failed_tools === undefined) {
      tokens = { ...tokens, failed_tools: failedToolCounts(failures) };
    }
    const next = rewriteRunTokens(readFileSync(runsFile, 'utf8'), runId, tokens);
    if (next === null) return false;
    writeFileSync(runsFile, next, 'utf8');
    const log = join(dirname(runsFile), 'runs', `${runId}.log`);
    if (existsSync(log)) {
      appendFileSync(
        log,
        `tokens: in=${tokens.input} out=${tokens.output} cache_read=${tokens.cache_read} cache_write=${tokens.cache_creation}` +
          (tokens.tools_called != null ? ` tools=${tokens.tools_called}` : '') +
          (tokens.tools_failed != null ? ` tool_fails=${tokens.tools_failed}` : '') +
          (tokens.agents_spawned != null ? ` agents=${tokens.agents_spawned}` : '') +
          (tokens.cost_usd != null ? ` cost=$${tokens.cost_usd.toFixed(4)}` : '') +
          ` (folded ${new Date().toISOString()})\n`,
      );
      if (failures && failures.length) {
        appendFileSync(log, renderFailureLogSection(failures, tokens.tools_failed ?? failures.length));
      }
    }
    renderSummary(base);
    return true;
  } catch {
    return false;
  }
}

/** Convenience for callers that only know the pipeline root (`pipeline drive`
 *  folds envelope usage at its terminal action): resolve the stats location
 *  and enrich that run. Never throws; false when the run wasn't finalized. */
export function statsEnrichTokensForRun(
  pipelineRoot: string,
  runId: string,
  tokens: TokenStats,
  failures?: RunFailureDetail[],
): boolean {
  if (!statsEnabled()) return false;
  try {
    const loc = statsLocation(pipelineRoot);
    return statsEnrichTokens(loc.base, runsJsonlPath(loc), runId, tokens, failures);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SUMMARY.md
// ---------------------------------------------------------------------------

interface Rollup {
  pipeline: string;
  runs: number;
  completed: number;
  avgDuration: number | null;
  avgOutTokens: number | null;
  /** Average tool failures per run, over runs whose fold recorded the count. */
  avgToolFails: number | null;
  lastRun: string;
}

function avg(nums: number[]): number | null {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

/** Recent-runs "Tool fails" cell: count + the worst offender, e.g. `7 (Bash 5)`. */
function fmtToolFails(tokens: TokenStats | null): string {
  const n = tokens?.tools_failed;
  if (typeof n !== 'number') return '—';
  if (n === 0) return '0';
  const top = Object.entries(tokens?.failed_tools ?? {}).sort((a, b) => b[1] - a[1])[0];
  return top ? `${n} (${top[0]} ${top[1]})` : String(n);
}

/** Pure render of SUMMARY.md from all run records (+ in-flight buffer names). */
export function renderSummaryMd(records: RunRecord[], inflight: Array<{ pipeline: string; runId: string; ageH: number }>): string {
  const byPipeline = new Map<string, RunRecord[]>();
  for (const r of records) {
    const list = byPipeline.get(r.pipeline) ?? [];
    list.push(r);
    byPipeline.set(r.pipeline, list);
  }
  const rollups: Rollup[] = [...byPipeline.entries()]
    .map(([pipeline, rs]) => ({
      pipeline,
      runs: rs.length,
      completed: rs.filter((r) => r.outcome === 'completed').length,
      avgDuration: avg(rs.map((r) => r.duration_s).filter((n): n is number => n !== null)),
      avgOutTokens: avg(rs.map((r) => r.tokens?.output).filter((n): n is number => typeof n === 'number')),
      avgToolFails: avg(rs.map((r) => r.tokens?.tools_failed).filter((n): n is number => typeof n === 'number')),
      lastRun: rs.map((r) => r.ended_at).sort().at(-1) ?? '—',
    }))
    .sort((a, b) => (a.lastRun < b.lastRun ? 1 : -1));

  const L: string[] = [];
  L.push('# Pipeline run measurements');
  L.push('');
  L.push(
    `_Generated ${new Date().toISOString()} by the pipeline plugin's stats system (pure software, no LLM). ` +
      'Per-run details: `<pipeline>/runs/<run-id>.log`; machine data: `<pipeline>/runs.jsonl`. ' +
      'Disable with `PIPELINE_STATS_ENABLED=0`. Review + apply improvements with `/pipeline:optimize`._',
  );
  L.push('');
  L.push('| Pipeline | Runs | Completed | Halted/other | Avg duration | Avg out-tokens | Avg tool fails | Last run (UTC) |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const r of rollups) {
    L.push(
      `| ${r.pipeline} | ${r.runs} | ${r.completed} | ${r.runs - r.completed} | ${fmtDuration(r.avgDuration)} | ${
        r.avgOutTokens === null ? '—' : Math.round(r.avgOutTokens).toLocaleString('en-US')
      } | ${r.avgToolFails === null ? '—' : r.avgToolFails.toFixed(1)} | ${r.lastRun} |`,
    );
  }
  if (!rollups.length) L.push('| _no finished runs measured yet_ | | | | | | | |');
  L.push('');
  L.push('## Recent runs');
  L.push('');
  L.push('| Ended (UTC) | Pipeline | Outcome | Duration | Out-tokens | Tool fails | Run id |');
  L.push('|---|---|---|---:|---:|---:|---|');
  const recent = [...records].sort((a, b) => (a.ended_at < b.ended_at ? 1 : -1)).slice(0, 25);
  for (const r of recent) {
    L.push(
      `| ${r.ended_at} | ${r.pipeline} | ${r.outcome}${r.halt_reason ? ` — ${r.halt_reason.slice(0, 60)}` : ''} | ${fmtDuration(
        r.duration_s,
      )} | ${r.tokens ? r.tokens.output.toLocaleString('en-US') : 'pending'} | ${fmtToolFails(r.tokens)} | ${r.run_id} |`,
    );
  }
  if (!recent.length) L.push('| _none yet_ | | | | | | |');
  if (inflight.length) {
    L.push('');
    L.push('## In-flight or crashed runs (timeline buffer still present)');
    L.push('');
    for (const f of inflight) {
      L.push(`- ${f.pipeline} · ${f.runId} · buffer age ${f.ageH.toFixed(1)}h${f.ageH > 12 ? ' — likely crashed/killed' : ''}`);
    }
  }
  L.push('');
  return L.join('\n');
}

/** Collect in-flight buffers (runs/<id>.jsonl files) under the stats base. */
export function findInflight(base: string): Array<{ pipeline: string; runId: string; ageH: number }> {
  const out: Array<{ pipeline: string; runId: string; ageH: number }> = [];
  for (const runsFile of findRunsFilesWithDirs(base)) {
    const dir = join(dirname(runsFile), 'runs');
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      try {
        const st = statSync(join(dir, n));
        out.push({
          pipeline: relative(base, dirname(runsFile)).split(sep).join('/'),
          runId: n.replace(/\.jsonl$/, ''),
          ageH: (Date.now() - st.mtimeMs) / 3_600_000,
        });
      } catch {
        // skip
      }
    }
  }
  return out;
}

/** Like findRunsFiles but ALSO returns pipeline dirs that only have buffers
 *  (crashed before the first finalize) so their in-flight runs still surface. */
function findRunsFilesWithDirs(base: string, depth = 8): string[] {
  const seen = new Set<string>(findRunsFiles(base, depth));
  const walk = (dir: string, d: number): void => {
    if (d > depth || !existsSync(dir)) return;
    let entries: Array<{ name: string; dir: boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.dir) continue;
      if (e.name === 'runs') seen.add(join(dir, 'runs.jsonl'));
      else walk(join(dir, e.name), d + 1);
    }
  };
  walk(base, 0);
  return [...seen];
}

/** Regenerate SUMMARY.md from every runs.jsonl under the base. Never throws. */
export function renderSummary(base: string): void {
  try {
    const records: RunRecord[] = [];
    for (const f of findRunsFiles(base)) {
      if (existsSync(f)) records.push(...parseRunRecords(readFileSync(f, 'utf8')));
    }
    ensureGeneratedDir(base);
    writeFileSync(join(base, 'SUMMARY.md'), renderSummaryMd(records, findInflight(base)), 'utf8');
  } catch {
    // best-effort
  }
}
