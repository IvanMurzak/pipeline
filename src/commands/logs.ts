// `pipeline logs [--follow|-f] [--tail <n>] [--all] [--json] [--no-color]
//   [--project <path>]`
//
// Tail the project's event journal (.runtime/events.jsonl) to the terminal,
// pretty-printing each event as a readable one-liner. This is the
// terminal-visible counterpart to the browser dashboard — it answers "show me
// the pipeline events as they appear" WITHOUT running the UI daemon, so it
// works regardless of PIPELINE_UI_ENABLED (the UI/daemon is off by default).
//
// Deliberately READ-ONLY: it never writes the journal, never spawns the daemon,
// and never emits events. It just resolves the journal path (project root via
// the shared resolveProjectRoot, so a worktree maps to its main repo) and reads.
//
// Pure helpers (parseLogsArgs / formatEvent / journalPathFor) are unit-tested;
// the follow loop is an integration concern (like the daemon spawn in ui.ts).

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { resolveProjectRoot } from '../lib/event';

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
}

export function parseLogsArgs(args: string[]): LogsArgs {
  const out: LogsArgs = {
    follow: false,
    tail: 20,
    all: false,
    json: false,
    color: 'auto',
    project: null,
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
    }
  }
  return out;
}

/** Resolve `<project-root>/.claude/pipeline/.runtime/events.jsonl` for a start
 *  dir. A git worktree resolves to its MAIN repo (where events are journaled). */
export function journalPathFor(startDir: string): string {
  const { project_root } = resolveProjectRoot(resolve(startDir));
  return join(project_root, '.claude', 'pipeline', '.runtime', 'events.jsonl');
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
          `${f(d, 'step_id') ? ` <${f(d, 'step_id')}>` : ''}` +
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
