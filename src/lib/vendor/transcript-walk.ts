// VENDORED from apps/pipeline-ui/{transcript-stats.ts,transcripts.ts,lib.ts}.
//
// Source of truth: apps/pipeline-ui/transcript-stats.ts (foldRunStatsFromTranscript,
// collectRunToolFailures + their private helpers), apps/pipeline-ui/transcripts.ts
// (claudeProjectsDir, encodeClaudeProjectDir), apps/pipeline-ui/lib.ts
// (emptyToolTokenCounters, isAgentSpawnTool, toEpochOrNull, ToolTokenCounters).
//
// WHY a vendored copy instead of a relative import: apps/pipeline-cli is
// published standalone to npm as @baizor/pipeline (bin points directly at
// `src/cli.ts`, no bundling), and the published tarball contains ONLY
// apps/pipeline-cli — apps/pipeline-ui is a sibling app that never ships.
// A relative import reaching out of the package root (`../../../pipeline-ui/…`)
// resolves fine in this monorepo checkout but crashes at import time for every
// npm-installed user the moment `pipeline drive` (which pulls in
// lib/step-transcripts.ts) is invoked. This is the SAME constraint that
// already forced hooks/*.ts and lib/event.ts to keep their own byte-identical
// copy of encodeClaudeProjectDir (see lib/event.ts's "Mirror of
// apps/pipeline-ui/transcripts.ts" comment) — hooks and the published CLI
// can't import a sibling app at runtime, so the function travels as a
// deliberate, commented copy instead.
//
// LOCKSTEP: this file must stay behaviorally identical to the functions it
// mirrors. If you change the fold/window/failure-collection logic in
// pipeline-ui's transcript-stats.ts/transcripts.ts/lib.ts, port the same
// change here (and vice versa) — apps/pipeline-cli/tests/step-transcripts.test.ts
// and apps/pipeline-ui/tests/transcript-stats.test.ts both exercise this
// contract from opposite sides of the copy.
//
// Only the functions lib/step-transcripts.ts actually needs are vendored
// (not the full source files) — see CLAUDE.md/docs for the full pipeline-ui
// per-run analytics fold this is a subset of.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// From apps/pipeline-ui/transcripts.ts
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
// From apps/pipeline-ui/lib.ts
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
 *  public here — keep it that way; this file vendors only what's consumed. */
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
// From apps/pipeline-ui/transcript-stats.ts
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

/** Hard per-run collection bound — mirrors pipeline-ui's RUN_FAILURES_COLLECT_MAX
 *  (the cap every per-file `collectFailuresFromFile` call below uses). */
export const RUN_FAILURES_COLLECT_MAX = 5000;

/** Display-cap default for collectRunToolFailures's `cap` param — mirrors
 *  pipeline-ui's RUN_FAILURES_CAP exactly (do NOT default to
 *  RUN_FAILURES_COLLECT_MAX here: that constant bounds the internal collection
 *  walk, not the caller-facing result size, and the two must stay distinct to
 *  match the source of truth's behavior byte-for-byte). The current call site
 *  in step-transcripts.ts always passes an explicit cap, so this default is
 *  presently inert — but it's still a real behavioral bug if anyone ever
 *  calls this without one, so it must match the original. */
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
// From apps/pipeline-ui/transcript-stats.ts — run→transcript locator
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
