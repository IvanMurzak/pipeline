// `pipeline logs [--follow|-f] [--tail <n>] [--all] [--json] [--no-color]
//   [--project <path>]`
// `pipeline logs --chat <run-id> [--project <path>] [--json] [--no-color]`
//
// Tail the project's event journal (.runtime/events.jsonl) to the terminal,
// pretty-printing each event as a readable one-liner. This is the
// terminal-visible counterpart to the browser dashboard — it answers "show me
// the pipeline events as they appear" WITHOUT running the browser dashboard, so
// it works regardless of PIPELINE_JOURNAL_ENABLED (even when the journal hooks
// are opted out).
//
// Deliberately READ-ONLY: it never writes the journal, never spawns the daemon,
// and never emits events. It just resolves the journal path (project root via
// the shared resolveProjectRoot, so a worktree maps to its main repo) and reads.
//
// Pure helpers (parseLogsArgs / formatEvent / journalPathFor) are unit-tested;
// the follow loop is an integration concern (like the daemon spawn in ui.ts).
//
// `--chat` is a separate MODE of this same command (see the section below):
// instead of the event journal, it renders a local run's Claude Code
// transcript(s) — the post-mortem reader for a headless run. Local only,
// offline, uploads nothing.

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { resolveProjectRoot } from '../lib/event';
import { findRunsFiles, parseRunRecords, type RunRecord } from '../lib/stats';
import { readStepSessionRefs, listStepSessionTranscriptFiles } from '../lib/step-transcripts';
import { findTranscriptByRunId } from '../lib/vendor/transcript-walk';

export type ColorMode = 'auto' | 'on' | 'off';

export interface LogsArgs {
  follow: boolean;
  /** How many trailing events to print before following. */
  tail: number;
  /** Print the whole journal instead of just the last `tail`. */
  all: boolean;
  /** Emit raw JSON lines instead of the pretty one-liner. */
  json: boolean;
  /** Tri-state — resolved to a boolean in runLogs (auto → stdout.isTTY). */
  color: ColorMode;
  /** Override the directory used to resolve the project root (default cwd). */
  project: string | null;
  /** `--chat <run-id>` — render a LOCAL run's Claude Code transcript
   *  (post-mortem, no daemon) instead of tailing the event journal. */
  chat: boolean;
  /** The run id supplied after `--chat` (or via `--chat=<run-id>`). Null when
   *  `--chat` was given with no value — runLogs treats that as a usage error. */
  chatRunId: string | null;
}

export function parseLogsArgs(args: string[]): LogsArgs {
  const out: LogsArgs = {
    follow: false,
    tail: 20,
    all: false,
    json: false,
    color: 'auto',
    project: null,
    chat: false,
    chatRunId: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '-f' || a === '--follow') out.follow = true;
    else if (a === '--all') out.all = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-color') out.color = 'off';
    else if (a === '--color') out.color = 'on';
    else if (a === '-n' || a === '--tail') {
      const v = Number(args[++i]);
      if (Number.isFinite(v) && v >= 0) out.tail = Math.floor(v);
    } else if (a.startsWith('--tail=')) {
      const v = Number(a.slice('--tail='.length));
      if (Number.isFinite(v) && v >= 0) out.tail = Math.floor(v);
    } else if (a === '--project') {
      out.project = args[++i] ?? null;
    } else if (a.startsWith('--project=')) {
      out.project = a.slice('--project='.length);
    } else if (a === '--chat') {
      out.chat = true;
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith('-')) {
        out.chatRunId = v;
        i++;
      }
    } else if (a.startsWith('--chat=')) {
      out.chat = true;
      out.chatRunId = a.slice('--chat='.length) || null;
    }
  }
  return out;
}

/** Resolve `<project-root>/.pipeline/.runtime/events.jsonl` for a start
 *  dir. A git worktree resolves to its MAIN repo (where events are journaled). */
export function journalPathFor(startDir: string): string {
  const { project_root } = resolveProjectRoot(resolve(startDir));
  return join(project_root, '.pipeline', '.runtime', 'events.jsonl');
}

// ---------------------------------------------------------------------------
// Pretty formatting
// ---------------------------------------------------------------------------

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[90m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
} as const;

function paint(s: string, codes: string[], color: boolean): string {
  if (!color || codes.length === 0) return s;
  return codes.join('') + s + C.reset;
}

/** Stringify a data field, returning '' for null/undefined. */
function f(d: Record<string, unknown>, k: string): string {
  const v = d[k];
  return v === null || v === undefined ? '' : String(v);
}

/** True only when the field is strictly the boolean `true`. */
function isTrue(d: Record<string, unknown>, k: string): boolean {
  return d[k] === true;
}

function baseName(p: string): string {
  return p ? basename(p) : '';
}

interface FormatBits {
  glyph: string;
  codes: string[];
  summary: string;
}

function bitsForEvent(type: string, d: Record<string, unknown>): FormatBits {
  switch (type) {
    case 'session.opened':
      return { glyph: '◇', codes: [C.dim], summary: `pid ${f(d, 'claude_pid') || '?'}` };
    case 'pipeline.started':
      return {
        glyph: '▶',
        codes: [C.green, C.bold],
        summary: `${f(d, 'pipeline_name') || '?'}${f(d, 'default_model') ? ` [${f(d, 'default_model')}]` : ''}`,
      };
    case 'pipeline.completed':
      return { glyph: '✓', codes: [C.green], summary: f(d, 'pipeline_name') };
    case 'pipeline.halted':
      return {
        glyph: '■',
        codes: [C.red],
        summary:
          `${f(d, 'pipeline_name')}${f(d, 'halt_reason') ? ` — ${f(d, 'halt_reason')}` : ''}` +
          `${isTrue(d, 'abandoned') ? ' (abandoned)' : ''}${isTrue(d, 'dismissed') ? ' (dismissed)' : ''}`,
      };
    case 'iteration.started':
      return {
        glyph: '→',
        codes: [C.cyan],
        summary:
          `#${f(d, 'index') || '?'} ${baseName(f(d, 'iteration_path'))}` +
          // v5 `step_name`, falling back to v4 `step_id` so replaying an old
          // journal still shows the step tag.
          `${f(d, 'step_name') || f(d, 'step_id') ? ` <${f(d, 'step_name') || f(d, 'step_id')}>` : ''}` +
          `${d['step_type'] === 'script' ? ' [script]' : ''}` +
          `${f(d, 'resolved_model') ? ` [${f(d, 'resolved_model')}]` : ''}`,
      };
    case 'iteration.resumed':
      return { glyph: '↻', codes: [C.cyan], summary: `#${f(d, 'index') || '?'} ${baseName(f(d, 'iteration_path'))}` };
    case 'iteration.completed': {
      const halted = f(d, 'outcome') === 'halted';
      // Script-step tags (§12): `[script]` marks an in-process deterministic
      // step; the failure class (when present) reads beside the outcome. Both
      // are absent for agent steps, so those lines are byte-identical to before.
      const script = d['step_type'] === 'script' ? ' [script]' : '';
      const fclass = f(d, 'failure_class') ? ` (${f(d, 'failure_class')})` : '';
      return {
        glyph: halted ? '■' : '✓',
        codes: [halted ? C.red : C.cyan],
        summary:
          `${baseName(f(d, 'iteration_path'))} ${f(d, 'outcome')}${script}${fclass}${isTrue(d, 'terminal') ? ' (terminal)' : ''}`.trim(),
      };
    }
    case 'improver.started':
      return { glyph: '✎', codes: [C.magenta], summary: `improver ${baseName(f(d, 'iteration_path'))}` };
    case 'improver.completed':
      return {
        glyph: '✎',
        codes: [C.magenta],
        summary: `improver ${isTrue(d, 'applied') ? 'applied' : 'no-op'}${isTrue(d, 'has_script_brief') ? ' +script' : ''}`,
      };
    case 'script_creator.started':
      return { glyph: '⚙', codes: [C.magenta], summary: `script-creator ${baseName(f(d, 'iteration_path'))}` };
    case 'script_creator.completed':
      return {
        glyph: '⚙',
        codes: [C.magenta],
        summary: `${f(d, 'outcome')}${f(d, 'script_path') ? ` ${baseName(f(d, 'script_path'))}` : ''}`.trim(),
      };
    case 'blocker.delegated':
      return { glyph: '⏸', codes: [C.yellow], summary: `blocker ${f(d, 'blocker_issue_url')}` };
    case 'blocker.polling':
      return { glyph: '⏲', codes: [C.yellow], summary: `poll ${f(d, 'pr_state')}` };
    case 'blocker.resolved':
      return { glyph: '▶', codes: [C.yellow], summary: `resolved ${f(d, 'merged_pr_url')}` };
    case 'manager.stopped':
      return { glyph: '◌', codes: [C.dim], summary: 'manager stopped' };
    case 'run.awaiting_input': {
      // The whole point of this line: `pipeline logs` works with no daemon, so
      // a blocked run is visible even for a user who runs no dashboard.
      const excerpt = f(d, 'message_excerpt');
      return {
        glyph: '⏸',
        codes: [C.yellow],
        summary: `awaiting ${f(d, 'kind') || 'input'}${excerpt ? `: ${excerpt}` : ''}`,
      };
    }
    case 'worktree.created':
      return {
        glyph: '⌥',
        codes: [C.blue],
        summary: `worktree ${d['ok'] === false ? 'FAILED' : baseName(f(d, 'worktree_path'))}${f(d, 'branch') ? ` @${f(d, 'branch')}` : ''}`,
      };
    case 'worktree.finalized':
      return {
        glyph: '⌥',
        codes: [d['ok'] === false ? C.red : C.blue],
        summary: `worktree finalize ${d['ok'] === false ? `FAILED${f(d, 'detail') ? `: ${f(d, 'detail')}` : ''}` : 'ok'}`,
      };
    case 'worktree.destroyed':
      return { glyph: '⌥', codes: [C.blue], summary: `worktree torn down${d['ok'] === false ? ' (soft-fail)' : ''}` };
    case 'tool.called': {
      const ok = d['success'] !== false;
      return {
        glyph: ok ? '·' : '✗',
        codes: [ok ? C.dim : C.red],
        summary: `${f(d, 'tool_name') || '?'}${isTrue(d, 'agent_spawn') ? ' (spawn)' : ''}${ok ? '' : ' failed'}`,
      };
    }
    case 'turn.usage':
      return {
        glyph: 'Σ',
        codes: [C.dim],
        summary:
          `tokens in ${f(d, 'input_tokens') || 0} out ${f(d, 'output_tokens') || 0}` +
          `${f(d, 'cache_read_tokens') ? ` cache-r ${f(d, 'cache_read_tokens')}` : ''}`,
      };
    default:
      return { glyph: '·', codes: [C.dim], summary: JSON.stringify(d) };
  }
}

/** Format one parsed event object as a single readable line. */
export function formatEvent(evt: unknown, color: boolean): string {
  const e = (evt ?? {}) as Record<string, unknown>;
  const ts = typeof e['ts'] === 'string' ? (e['ts'] as string).slice(11, 19) : '--:--:--';
  const type = typeof e['type'] === 'string' ? (e['type'] as string) : 'unknown';
  const d = (e['data'] && typeof e['data'] === 'object' ? e['data'] : {}) as Record<string, unknown>;
  const run = typeof e['run_id'] === 'string' && e['run_id'] ? (e['run_id'] as string).slice(0, 8) : null;
  const wt = typeof e['worktree'] === 'string' && e['worktree'] ? ' (wt)' : '';

  const { glyph, codes, summary } = bitsForEvent(type, d);
  const head = paint(`${ts} ${glyph} ${type}`, codes, color);
  const runTag = run ? paint(` ${run}`, [C.dim], color) : '';
  const body = summary ? `  ${summary}` : '';
  return `${head}${runTag}${wt}${body}`;
}

// ---------------------------------------------------------------------------
// `--chat <run-id>` — a headless run's transcript, read locally
//
// `session`/`manager` runs already show their conversation live in the
// terminal; the gap this closes is `driver`/`standalone`, where each step is
// a separate process, its output goes to stderr, and its (and its
// subagents') Claude Code transcripts become files nobody opens (see
// .taskflow/2026-08-03-plugin-thin/01-remove-local-ui.md, "The transcript /
// chat panel"). This renders those files in the terminal. LOCAL ONLY: every
// path below is a synchronous fs read against files already on this
// machine — nothing here performs a network request, so nothing is
// uploaded (asserted, not just intended, by tests/logs.test.ts).
//
// Reuses the existing walkers to LOCATE files (lib/step-transcripts.ts's
// readStepSessionRefs/listStepSessionTranscriptFiles, the vendored
// lib/vendor/transcript-walk.ts's findTranscriptByRunId/claudeProjectsDir/
// encodeClaudeProjectDir) rather than re-deriving the `~/.claude/projects`
// layout; only the CONTENT rendering below is new, since the walkers only
// ever counted tokens/tools, never printed a message.
// ---------------------------------------------------------------------------

/** A run_id's index entry, resolved from every pipeline's `runs.jsonl` under
 *  `.pipeline/.stats/` —
 *  the same run→pipeline/runner/window index `pipeline stats`/`stats
 *  backfill` already use (lib/stats-backfill.ts). Requires stats to be
 *  enabled (PIPELINE_STATS_ENABLED, default ON) — it is the only run_id
 *  index the CLI keeps. Exact match first; falls back to a UNIQUE prefix
 *  match (git-style) so a truncated id copied from `pipeline logs`'s
 *  8-char run tag still resolves, as long as it is unambiguous. */
export function findRunRecord(projectRoot: string, runId: string): RunRecord | null {
  const base = join(projectRoot, '.pipeline', '.stats');
  if (!existsSync(base)) return null;
  const all: RunRecord[] = [];
  for (const file of findRunsFiles(base)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    all.push(...parseRunRecords(text));
  }
  const exact = all.find((r) => r.run_id === runId);
  if (exact) return exact;
  if (runId.length >= 6) {
    const prefixed = all.filter((r) => r.run_id.startsWith(runId));
    if (prefixed.length === 1) return prefixed[0];
  }
  return null;
}

interface ChatTranscriptFile {
  step_id: string;
  kind: 'session' | 'subagent' | 'manager';
  path: string;
}

/** Locate every transcript file for a resolved run, source-selected exactly
 *  like lib/stats-backfill.ts's fold does (same `runner` branch): headless
 *  (`pipeline drive`) runs pin one session per step
 *  (`.runtime/<run>/sessions/`); everything else (`manager`, unset/legacy)
 *  is a single manager-transcript session located by content correlation
 *  (`findTranscriptByRunId` — the file that mentions this run_id the most). */
function transcriptFilesForRun(projectRoot: string, rec: RunRecord, homeOverride?: string): ChatTranscriptFile[] {
  if (rec.runner === 'headless') {
    const sessionsDir = join(projectRoot, '.pipeline', rec.pipeline, '.runtime', rec.run_id, 'sessions');
    const refs = [...readStepSessionRefs(sessionsDir)].sort((a, b) =>
      a.step_id < b.step_id ? -1 : a.step_id > b.step_id ? 1 : 0,
    );
    return listStepSessionTranscriptFiles(refs, homeOverride).map((f) => ({
      step_id: f.step_id,
      kind: f.kind,
      path: f.path,
    }));
  }
  const transcript = findTranscriptByRunId(projectRoot, rec.run_id, rec.started_at, rec.ended_at, homeOverride);
  if (!transcript) return [];
  return [{ step_id: rec.pipeline, kind: 'manager', path: transcript }];
}

const CHAT_TEXT_MAX = 4000;
const CHAT_TOOL_INPUT_MAX = 800;
const CHAT_TOOL_RESULT_MAX = 1200;
// A manager transcript can span hours of unrelated work either side of this
// run — unlike a headless step's pinned session, which belongs to exactly
// one execution. Only the manager path needs this window; slack absorbs
// clock skew / fs-timestamp granularity around the boundary, same idea as
// (but not imported from) vendor/transcript-walk.ts's private WINDOW_SLACK_MS.
const CHAT_WINDOW_SLACK_MS = 2000;
const CHAT_SKIP_TYPES = new Set(['attachment', 'file-history-snapshot', 'permission-mode', 'summary']);

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max) + ' […truncated]' : t;
}

function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

/** Plain-text content of an assistant/user message's `content` blocks —
 *  string content passes through; array content joins every `text` block. */
function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text')
    .map((c) => {
      const t = (c as Record<string, unknown>).text;
      return typeof t === 'string' ? t : '';
    })
    .join('\n');
}

/** Plain-text rendering of a tool_result block's `content` (string, an
 *  array of text blocks, or an opaque value — falls back to JSON). */
function textOfToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text' ? String((c as Record<string, unknown>).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

interface ChatWindow {
  startMs: number | null;
  endMs: number | null;
}

/** True when a user turn's ENTIRE content is empty tool_results — CC
 *  housekeeping noise (e.g. an attachment ack) with nothing user-facing to
 *  show. Same rule the deleted dashboard's transcript-normalize.ts applied before
 *  mirroring into the (now-removed) chat panel. */
function isNoiseUserTurn(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((c) => {
    if (!c || typeof c !== 'object') return false;
    const b = c as Record<string, unknown>;
    if (b.type !== 'tool_result') return false;
    const inner = b.content;
    return inner == null || (typeof inner === 'string' && inner.length === 0) || (Array.isArray(inner) && (inner as unknown[]).length === 0);
  });
}

/** Render one parsed transcript entry as terminal lines (pretty mode) or one
 *  JSON line (json mode). Returns nothing directly written for entries this
 *  reader skips (CC bookkeeping types, out-of-window, empty housekeeping
 *  turns) — mirrors formatEvent's "never throw, best-effort" spirit. */
function renderChatEntry(raw: unknown, file: ChatTranscriptFile, json: boolean, color: boolean, window: ChatWindow | null): void {
  if (!raw || typeof raw !== 'object') return;
  const e = raw as Record<string, unknown>;
  const type = typeof e.type === 'string' ? e.type : '';
  if (!type || CHAT_SKIP_TYPES.has(type)) return;
  const message = e.message as Record<string, unknown> | undefined;
  const role = typeof message?.role === 'string' ? (message.role as string) : type;
  if (role !== 'assistant' && role !== 'user' && role !== 'system') return;

  const tsRaw = typeof e.timestamp === 'string' ? e.timestamp : '';
  if (window) {
    const ts = tsRaw ? Date.parse(tsRaw) : NaN;
    if (!Number.isFinite(ts)) return;
    if (window.startMs !== null && ts < window.startMs - CHAT_WINDOW_SLACK_MS) return;
    if (window.endMs !== null && ts > window.endMs + CHAT_WINDOW_SLACK_MS) return;
  }

  const content = message?.content;

  if (json) {
    process.stdout.write(JSON.stringify({ step_id: file.step_id, kind: file.kind, ts: tsRaw || null, role, entry: e }) + '\n');
    return;
  }

  if (role === 'user' && isNoiseUserTurn(content)) return;

  const time = tsRaw ? tsRaw.slice(11, 19) : '--:--:--';
  const tag = file.kind === 'subagent' ? ' (subagent)' : '';

  if (role === 'assistant') {
    const text = textOfBlocks(content);
    const blocks = Array.isArray(content) ? content : [];
    process.stdout.write(paint(`[${time}] ▐ ASSISTANT ${file.step_id}${tag}`, [C.cyan, C.bold], color) + '\n');
    if (text) process.stdout.write(indentBlock(truncate(text, CHAT_TEXT_MAX)) + '\n');
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use') {
        let inputText = '';
        try {
          inputText = b.input === undefined ? '' : JSON.stringify(b.input);
        } catch {
          inputText = String(b.input);
        }
        const suffix = inputText && inputText !== '{}' ? ` ${truncate(inputText, CHAT_TOOL_INPUT_MAX)}` : '';
        process.stdout.write(paint(`  ⚙ ${String(b.name ?? 'tool')}`, [C.yellow], color) + suffix + '\n');
      } else if (b.type === 'thinking') {
        const th = typeof b.thinking === 'string' ? b.thinking : '';
        process.stdout.write(paint(`  ⟡ thinking (${th.length} chars)`, [C.dim], color) + '\n');
      }
    }
    if (!text && blocks.length === 0) process.stdout.write(paint('  // empty turn', [C.dim], color) + '\n');
  } else if (role === 'user') {
    const text = textOfBlocks(content);
    if (text) {
      process.stdout.write(paint(`[${time}] ▌ USER ${file.step_id}${tag}`, [C.green], color) + '\n');
      process.stdout.write(indentBlock(truncate(text, CHAT_TEXT_MAX)) + '\n');
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_result') continue;
        const isErr = b.is_error === true;
        const resultText = textOfToolResult(b.content);
        const suffix = resultText ? ` ${truncate(resultText, CHAT_TOOL_RESULT_MAX)}` : '';
        process.stdout.write(paint(`  ↩ tool_result${isErr ? ' ERROR' : ''}`, [isErr ? C.red : C.dim], color) + suffix + '\n');
      }
    }
  } else {
    const text = textOfBlocks(content) || (typeof e.summary === 'string' ? e.summary : '');
    if (text) process.stdout.write(paint(`[${time}] · ${truncate(text, 200)}`, [C.dim], color) + '\n');
  }
}

function renderChatFile(file: ChatTranscriptFile, json: boolean, color: boolean, window: ChatWindow | null): void {
  if (!existsSync(file.path)) return;
  let text: string;
  try {
    text = readFileSync(file.path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(t);
    } catch {
      continue;
    }
    renderChatEntry(raw, file, json, color, window);
  }
}

/** `pipeline logs --chat <run-id>`: render a local run's transcript(s).
 *  Read-only, synchronous, offline — see the section header above.
 *  `homeOverride` is a test seam (mirrors every other walker in this file's
 *  family), never set in production. Exit 0 whether the run/transcript was
 *  found or not — an absent run or transcript is a normal, clearly-reported
 *  outcome here, not a usage error (that's reserved for a missing --chat
 *  value in runLogs). */
export function runLogsChat(runId: string, opts: LogsArgs, homeOverride?: string): number {
  const color = opts.color === 'auto' ? Boolean(process.stdout.isTTY) : opts.color === 'on';
  const { project_root } = resolveProjectRoot(resolve(opts.project ?? process.cwd()));

  const rec = findRunRecord(project_root, runId);
  if (!rec) {
    process.stderr.write(`pipeline logs --chat: no run found with id '${runId}'\n`);
    process.stderr.write(`  (list known run ids with 'pipeline stats --json')\n`);
    return 0;
  }

  const files = transcriptFilesForRun(project_root, rec, homeOverride);
  if (files.length === 0) {
    process.stdout.write(
      `run ${rec.run_id} (${rec.pipeline}) has no transcript on disk — ` +
        `it may have run on a different machine, or the transcript was already cleaned up.\n`,
    );
    return 0;
  }

  const window: ChatWindow | null =
    rec.runner === 'headless' ? null : { startMs: rec.started_at ? Date.parse(rec.started_at) : null, endMs: Date.parse(rec.ended_at) };

  if (!opts.json) {
    process.stdout.write(
      paint(`━━ run ${rec.run_id} · ${rec.pipeline} · ${rec.runner}${rec.mode ? `/${rec.mode}` : ''} ━━`, [C.bold], color) + '\n',
    );
  }

  let lastStep: string | null = null;
  for (const file of files) {
    if (!opts.json && file.step_id !== lastStep) {
      process.stdout.write(paint(`\n── step: ${file.step_id} ──`, [C.dim, C.bold], color) + '\n');
      lastStep = file.step_id;
    }
    renderChatFile(file, opts.json, color, window);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Reading / following
// ---------------------------------------------------------------------------

/** Read bytes [from, to) from a file via a positioned read (no whole-file load
 *  on each follow tick). Mirrors analytics_relay.ts:readTail. */
function readRange(path: string, from: number, to: number): string {
  const len = to - from;
  if (len <= 0) return '';
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    let read = 0;
    let pos = from;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, pos);
      if (n <= 0) break;
      read += n;
      pos += n;
    }
    return buf.subarray(0, read).toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function emitLine(raw: string, args: LogsArgs, color: boolean): void {
  const line = raw.trim();
  if (!line) return;
  if (args.json) {
    process.stdout.write(line + '\n');
    return;
  }
  try {
    process.stdout.write(formatEvent(JSON.parse(line), color) + '\n');
  } catch {
    // Not JSON (partial/corrupt line) — show it dimmed rather than dropping it.
    process.stdout.write(paint(line, [C.dim], color) + '\n');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runLogs(args: string[]): Promise<number> {
  const opts = parseLogsArgs(args);

  if (opts.chat) {
    if (!opts.chatRunId) {
      process.stderr.write('usage: pipeline logs --chat <run-id> [--project <path>] [--json] [--no-color]\n');
      return 2;
    }
    return runLogsChat(opts.chatRunId, opts);
  }

  const color = opts.color === 'auto' ? Boolean(process.stdout.isTTY) : opts.color === 'on';
  const journal = journalPathFor(opts.project ?? process.cwd());

  // Initial dump of the existing tail. `partial` carries an incomplete trailing
  // line (a concurrent `pipeline event` write in flight) into the follow loop,
  // so its remainder completes that line instead of printing as a fresh,
  // corrupt line on the next poll tick.
  let offset = 0;
  let partial = '';
  if (existsSync(journal)) {
    const text = readFileSync(journal, 'utf-8');
    offset = Buffer.byteLength(text, 'utf-8');
    const parts = text.split('\n');
    if (!text.endsWith('\n')) partial = parts.pop() ?? '';
    const lines = parts.filter((l) => l.trim());
    const slice = opts.all ? lines : lines.slice(-opts.tail);
    for (const l of slice) emitLine(l, opts, color);
    if (!opts.follow && lines.length === 0) {
      process.stderr.write(`(no events yet in ${journal})\n`);
    }
  } else if (!opts.follow) {
    process.stderr.write(`pipeline logs: no event journal at ${journal}\n`);
    process.stderr.write('  (nothing has run yet — start a pipeline with /pipeline:run)\n');
    return 0;
  }

  if (!opts.follow) return 0;

  if (color) process.stderr.write(paint(`▸ following ${journal} — Ctrl-C to stop\n`, [C.dim], color));
  else process.stderr.write(`following ${journal} — Ctrl-C to stop\n`);

  // Poll for growth. fs.watch is unreliable across platforms (esp. Windows
  // atomic-rename rotation), so a small poll is the robust choice. `partial`
  // (seeded above from the initial dump) carries an incomplete trailing line
  // between ticks.
  for (;;) {
    await sleep(400);
    let size: number;
    try {
      if (!existsSync(journal)) continue; // not created yet, or mid-rotation
      size = statSync(journal).size;
    } catch {
      continue;
    }
    if (size < offset) {
      // Truncated or rotated to a fresh file — restart from the top.
      offset = 0;
      partial = '';
    }
    if (size === offset) continue;
    const chunk = partial + readRange(journal, offset, size);
    offset = size;
    const parts = chunk.split('\n');
    partial = parts.pop() ?? ''; // last element is the (possibly empty) remainder
    for (const l of parts) emitLine(l, opts, color);
  }
}
