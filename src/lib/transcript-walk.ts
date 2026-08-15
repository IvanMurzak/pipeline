// The transcript walk: fold per-run analytics out of a Claude Code session
// transcript, locate a run's transcript, and collect its tool failures.
//
// THIS IS ORDINARY SOURCE, AND IT IS THE ONLY IMPLEMENTATION. There is no
// upstream, no lockstep obligation, and nothing to sync against. Edit it here.
//
// PROVENANCE: originally lifted from apps/pipeline-ui/{transcript-stats.ts,
// transcripts.ts,lib.ts}, since deleted (plugin-thin `p3` removed that app).
// It lived under `src/lib/vendor/` for as long as that upstream existed —
// `vendor/` meaning "do not edit, sync upstream". Both halves of that
// arrangement are now void: the upstream is gone, so this file became the
// sole definition of `foldRunStatsFromTranscript` and `collectRunToolFailures`,
// and plugin-thin `k2` promoted it out of `vendor/` to say so. (Same shape as
// commands/fix.ts's "ported from apps/pipeline-ui/aifix.ts, since deleted"
// note — history, not a pointer to follow.)
//
// ⚠ DO NOT DELETE THIS FILE in the belief that it duplicates something. The
// wording that retired the other vendored file — plugin-thin phase 6, "delete
// the vendored copies in favour of real imports" — does NOT apply here, and
// applying it literally deletes live code. `vendor/privacy.ts` had a real
// upstream to become a dependency on (`@baizor/pipeline-protocol`, now a
// declared dependency of this package). This file has none. ROADMAP B.9
// records that trap; this paragraph is the guard against re-reading the same
// sentence the same wrong way.
//
// COVERAGE: the fold's behaviour is pinned by tests/step-transcripts.test.ts,
// tests/stats-backfill.test.ts, tests/stream-json.test.ts and
// tests/logs-chat.test.ts. Those are the only cross-check there is now that
// the pre/post comparison against pipeline-ui's own suite is gone.
//
// SCOPE: only the functions lib/step-transcripts.ts and lib/stats-backfill.ts
// actually consume were carried over, not the whole of the original files.
// That is why the per-run analytics fold here is a subset of what the deleted
// app computed — a deliberate narrowing, not an incomplete port.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Originally from apps/pipeline-ui/transcripts.ts (deleted)
// ---------------------------------------------------------------------------

/** `~/.claude/projects` — where Claude Code keeps session transcripts. The
 *  optional override exists for tests. */
export function claudeProjectsDir(homeOverride?: string): string {
  const home = homeOverride ?? process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(home, '.claude', 'projects');
}

/** Encode an absolute filesystem path the way Claude Code does for its
 *  `~/.claude/projects/<encoded>/` directory: replace EVERY non-alphanumeric
 *  character with `-`. */
export function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

// ---------------------------------------------------------------------------
// Originally from apps/pipeline-ui/lib.ts (deleted)
// ---------------------------------------------------------------------------

/** The subagent-spawning tool names. */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'TaskCreate']);
function isAgentSpawnTool(name: unknown): boolean {
  return typeof name === 'string' && SPAWN_TOOLS.has(name);
}

/** The 7 tool/token counters every analytics shape carries. Not exported —
 *  nothing outside this file needs the shape by name, only step-transcripts.ts's
 *  5 actually-imported symbols (RUN_FAILURES_COLLECT_MAX, collectRunToolFailures,
 *  foldRunStatsFromTranscript, claudeProjectsDir, encodeClaudeProjectDir) are
 *  public here — keep it that way; this file carries only what's consumed. */
interface ToolTokenCounters {
  tools_called: number;
  tools_failed: number;
  agents_spawned: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd?: number;
}

function emptyToolTokenCounters(): ToolTokenCounters {
  return {
    tools_called: 0,
    tools_failed: 0,
    agents_spawned: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
}

/** Parse an ISO timestamp to epoch ms, or null when absent/unparseable. */
function toEpochOrNull(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------------------
// Originally from apps/pipeline-ui/transcript-stats.ts (deleted)
// ---------------------------------------------------------------------------

/** Small slack (ms) on the window so an entry written a beat before/after the
 *  lifecycle event timestamps isn't dropped (clock skew + fs granularity). */
const WINDOW_SLACK_MS = 2000;
const BIRTHTIME_SLACK_MS = 5000;

interface Window {
  start: number | null; // epoch ms; null = open start
  end: number | null; // epoch ms; null = open end (live run)
}

type TranscriptRunStats = ToolTokenCounters;
const emptyTranscriptRunStats = emptyToolTokenCounters;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Fold one parsed transcript entry into the accumulator, gated by the window. */
function foldTranscriptEntry(entry: unknown, acc: TranscriptRunStats, win: Window): void {
  if (!entry || typeof entry !== 'object') return;
  const e = entry as Record<string, unknown>;
  const tsRaw = typeof e.timestamp === 'string' ? e.timestamp : '';
  const ts = tsRaw ? Date.parse(tsRaw) : NaN;
  if (win.start !== null || win.end !== null) {
    if (!Number.isFinite(ts)) return;
    if (win.start !== null && ts < win.start - WINDOW_SLACK_MS) return;
    if (win.end !== null && ts > win.end + WINDOW_SLACK_MS) return;
  }
  const message = e.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== 'object') return;
  const role = typeof message.role === 'string' ? message.role : (typeof e.type === 'string' ? e.type : '');
  const content = message.content;

  if (role === 'assistant') {
    const u = message.usage as Record<string, unknown> | undefined;
    if (u) {
      acc.input_tokens += num(u.input_tokens);
      acc.output_tokens += num(u.output_tokens);
      acc.cache_read_tokens += num(u.cache_read_input_tokens);
      acc.cache_creation_tokens += num(u.cache_creation_input_tokens);
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_use') continue;
        acc.tools_called += 1;
        if (isAgentSpawnTool(b.name)) acc.agents_spawned += 1;
      }
    }
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result' && b.is_error === true) acc.tools_failed += 1;
    }
  }
}

/** Fold every entry of a single transcript file into `acc`, window-gated. */
function foldTranscriptFile(path: string, acc: TranscriptRunStats, win: Window): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    foldTranscriptEntry(parsed, acc, win);
  }
}

/** Given a manager/parent transcript path, return the sibling subagents
 *  directory CC writes (`<encoded-cwd>/<session-id>/subagents/`). */
function subagentsDirFor(transcriptPath: string): string {
  return join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents');
}

/** List subagent transcript files whose CREATION time plausibly falls inside
 *  the run window (cheap birthtime pre-filter). */
function inWindowSubagentFiles(transcriptPath: string, win: Window): string[] {
  const dir = subagentsDirFor(transcriptPath);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const p = join(dir, name);
    let createdMs: number;
    try {
      const s = statSync(p);
      createdMs = s.birthtimeMs && s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
    } catch {
      continue;
    }
    if (win.start !== null && createdMs < win.start - BIRTHTIME_SLACK_MS) continue;
    if (win.end !== null && createdMs > win.end + BIRTHTIME_SLACK_MS) continue;
    out.push(p);
  }
  return out;
}

/**
 * Fold complete per-run stats: the manager/parent transcript + every in-window
 * subagent transcript under it. Returns zeroed stats when the transcript is
 * missing.
 */
export function foldRunStatsFromTranscript(
  managerTranscriptPath: string | null,
  windowStartIso: string | null,
  windowEndIso: string | null,
): TranscriptRunStats {
  const acc = emptyTranscriptRunStats();
  if (!managerTranscriptPath) return acc;
  const win: Window = { start: toEpochOrNull(windowStartIso), end: toEpochOrNull(windowEndIso) };

  foldTranscriptFile(managerTranscriptPath, acc, win);
  for (const sub of inWindowSubagentFiles(managerTranscriptPath, win)) {
    foldTranscriptFile(sub, acc, win);
  }
  return acc;
}

// --------------------------------------------------------------------
// Per-failure detail — same transcript walk as the stats fold, but instead
// of counting `tool_result` errors it captures WHAT failed.
// --------------------------------------------------------------------

interface ToolFailure {
  ts: string;
  tool_name: string | null;
  input_excerpt: string | null;
  error_excerpt: string;
  source: 'manager' | 'subagent';
}

const FAILURE_INPUT_EXCERPT_MAX = 400;
const FAILURE_ERROR_EXCERPT_MAX = 1000;

/** Hard per-run collection bound — the cap every per-file
 *  `collectFailuresFromFile` call below uses. (Carried over unchanged from the
 *  deleted app's RUN_FAILURES_COLLECT_MAX.) */
export const RUN_FAILURES_COLLECT_MAX = 5000;

/** Display-cap default for collectRunToolFailures's `cap` param. Do NOT
 *  "simplify" this to RUN_FAILURES_COLLECT_MAX: that constant bounds the
 *  internal collection walk, this one bounds the caller-facing result size,
 *  and collapsing the two changes behaviour. They are deliberately distinct.
 *  The current call site in step-transcripts.ts always passes an explicit cap,
 *  so this default is presently inert — but it is still a real behavioural bug
 *  if anyone ever calls this without one. (Carried over unchanged from the
 *  deleted app's RUN_FAILURES_CAP; the value is now defined here and nowhere
 *  else, so there is no other copy to reconcile it against.) */
const RUN_FAILURES_CAP = 200;

/** Flatten a tool_result / message content value to plain text. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function excerpt(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + ' […]' : t;
}

/** Collect window-gated tool failures from ONE transcript file. */
function collectFailuresFromFile(
  path: string,
  win: Window,
  source: ToolFailure['source'],
  out: ToolFailure[],
  cap: number,
): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const useById = new Map<string, { name: string | null; input: string | null }>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(t);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const message = e.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_use' || typeof b.id !== 'string') continue;
      let input: string | null = null;
      try {
        input = b.input === undefined ? null : JSON.stringify(b.input);
      } catch {
        input = null;
      }
      useById.set(b.id, {
        name: typeof b.name === 'string' ? b.name : null,
        input: input ? excerpt(input, FAILURE_INPUT_EXCERPT_MAX) : null,
      });
    }
    const tsRaw = typeof e.timestamp === 'string' ? e.timestamp : '';
    const ts = tsRaw ? Date.parse(tsRaw) : NaN;
    if (win.start !== null || win.end !== null) {
      if (!Number.isFinite(ts)) continue;
      if (win.start !== null && ts < win.start - WINDOW_SLACK_MS) continue;
      if (win.end !== null && ts > win.end + WINDOW_SLACK_MS) continue;
    }
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_result' || b.is_error !== true) continue;
      if (out.length >= cap) return;
      const use = typeof b.tool_use_id === 'string' ? useById.get(b.tool_use_id) : undefined;
      out.push({
        ts: tsRaw,
        tool_name: use?.name ?? null,
        input_excerpt: use?.input ?? null,
        error_excerpt: excerpt(textOfContent(b.content), FAILURE_ERROR_EXCERPT_MAX),
        source,
      });
    }
  }
}

/** All tool failures for a run: the manager/parent transcript + every
 *  in-window subagent transcript, chronological. */
export function collectRunToolFailures(
  managerTranscriptPath: string | null,
  windowStartIso: string | null,
  windowEndIso: string | null,
  cap: number = RUN_FAILURES_CAP,
): { failures: ToolFailure[]; truncated: boolean } {
  const all: ToolFailure[] = [];
  if (!managerTranscriptPath) return { failures: all, truncated: false };
  const win: Window = { start: toEpochOrNull(windowStartIso), end: toEpochOrNull(windowEndIso) };
  collectFailuresFromFile(managerTranscriptPath, win, 'manager', all, RUN_FAILURES_COLLECT_MAX);
  for (const sub of inWindowSubagentFiles(managerTranscriptPath, win)) {
    if (all.length >= RUN_FAILURES_COLLECT_MAX) break;
    collectFailuresFromFile(sub, win, 'subagent', all, RUN_FAILURES_COLLECT_MAX);
  }
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { failures: all.slice(0, cap), truncated: all.length > cap };
}

// ---------------------------------------------------------------------------
// Originally from apps/pipeline-ui/transcript-stats.ts (deleted) — run→transcript locator
// ---------------------------------------------------------------------------

/** Per-(file, run_id) occurrence-count memo. The negative-result path retries
 *  while a live run has no resolved transcript — without this it re-reads every
 *  in-window multi-MB session file each time even though none of them changed.
 *  Keyed by path|runId; invalidated by size/mtime drift. */
const occurrenceMemo = new Map<string, { size: number; mtimeMs: number; count: number }>();
const OCCURRENCE_MEMO_MAX = 2000;

/** Locate the session transcript belonging to a run: among the project's
 *  in-window session files, the one that mentions the run id the most times
 *  (a manager transcript names its run repeatedly; a session that merely
 *  mentions it once loses). Returns null when nothing contains the run id —
 *  callers must treat that as "no transcript", never guess by window alone. */
export function findTranscriptByRunId(
  projectRoot: string,
  runId: string,
  windowStartIso: string | null,
  windowEndIso: string | null,
  homeOverride?: string,
): string | null {
  if (!runId) return null;
  const dir = join(claudeProjectsDir(homeOverride), encodeClaudeProjectDir(projectRoot));
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const start = toEpochOrNull(windowStartIso);
  const end = toEpochOrNull(windowEndIso);
  let best: string | null = null;
  let bestCount = 0;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const birth = st.birthtimeMs && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
    // Window overlap: the session must still have been written to after the
    // run started, and must have existed before the run ended.
    if (start !== null && st.mtimeMs < start - BIRTHTIME_SLACK_MS) continue;
    if (end !== null && birth > end + BIRTHTIME_SLACK_MS) continue;
    const memoKey = `${p}|${runId}`;
    const memo = occurrenceMemo.get(memoKey);
    let count: number;
    if (memo && memo.size === st.size && memo.mtimeMs === st.mtimeMs) {
      count = memo.count;
    } else {
      let text: string;
      try {
        text = readFileSync(p, 'utf-8');
      } catch {
        continue;
      }
      count = 0;
      for (let i = text.indexOf(runId); i !== -1; i = text.indexOf(runId, i + runId.length)) count++;
      if (occurrenceMemo.size >= OCCURRENCE_MEMO_MAX) occurrenceMemo.clear();
      occurrenceMemo.set(memoKey, { size: st.size, mtimeMs: st.mtimeMs, count });
    }
    if (count > bestCount) {
      bestCount = count;
      best = p;
    }
  }
  return best;
}
