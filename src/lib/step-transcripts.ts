// Drive-run transcript fold — tool counts + failures for .stats enrichment.
//
// A headless run has no pipeline-manager transcript for the SubagentStop stats
// relay to fold, so its envelope-based enrichment used to carry tokens/cost
// only — no tool counts and no failures. But `pipeline drive` PINS a session
// UUID per step (persisted under `.runtime/<run>/sessions/<step>.json`), and
// each pinned session's transcript lives at
// `~/.claude/projects/<encoded spawn_cwd>/<session_id>.jsonl` (plus that
// session's `subagents/` for intra-step fan-out). Folding those files at the
// terminal action gives drive runs the same tools_called/tools_failed the
// manager path gets — with EXACT step attribution, because each session file
// belongs to exactly one step. A step re-executed in the same run (graph
// loop-back) gets a FRESH session; the replaced ids are kept in the session
// file's `previous_session_ids` so the fold covers every execution, not just
// the last.
//
// Uses the SAME validated fold the dashboard's FAIL tile and stats relay run
// on (apps/pipeline-ui/transcript-stats — each walks the session file + its
// in-window subagents), but via a VENDORED copy (lib/vendor/transcript-walk.ts)
// rather than a relative import into the sibling pipeline-ui app: this module
// is reachable from `pipeline drive`, which ships standalone as the published
// npm package @baizor/pipeline — a package that contains only apps/pipeline-cli,
// so an import reaching out to `../../../pipeline-ui/*` resolves in this
// monorepo checkout but 404s (crashing the whole CLI at import time) for every
// npm-installed user. See lib/vendor/transcript-walk.ts's header for the full
// lockstep note. Best-effort like all stats code: every entry point swallows
// failures and returns what it could read.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  RUN_FAILURES_COLLECT_MAX,
  collectRunToolFailures,
  foldRunStatsFromTranscript,
  claudeProjectsDir,
  encodeClaudeProjectDir,
} from './vendor/transcript-walk';
import type { RunFailureDetail } from './stats';
import type { StepQuestion } from './step-schema';

/** One step's pinned executor session, persisted by `pipeline drive` at
 *  `.runtime/<run>/sessions/<step_id>.json` BEFORE each spawn. Single-sourced
 *  here: drive.ts (the writer) and the terminal-fold reader below share it. */
export interface StepSession {
  /** The claude session UUID pinned via --session-id BEFORE the spawn. */
  session_id: string;
  status: 'running' | 'awaiting-input' | 'done';
  /** The cwd the executor was spawned from — session-id resolution is scoped
   *  to the project directory, so a resume must run from the same place. */
  spawn_cwd: string;
  /** Session ids this step used in EARLIER executions of the same run (a
   *  graph loop-back mints a fresh session and pushes the replaced one here)
   *  so the terminal fold covers every execution's transcript. */
  previous_session_ids?: string[];
  /** Questions asked so far in THIS session (resets on a fresh spawn). */
  questions: StepQuestion[];
  /** Crash-resume attempts consumed for THIS session (a spawn that produced
   *  no valid record, or a drive process that died mid-step). */
  crashes: number;
}

/** Parse one step-session file. Null when missing/corrupt/id-less. */
export function readStepSession(sessionsDir: string, stepId: string): StepSession | null {
  try {
    const v = JSON.parse(readFileSync(join(sessionsDir, `${stepId}.json`), 'utf8')) as StepSession;
    return v && typeof v === 'object' && typeof v.session_id === 'string'
      ? {
          ...v,
          questions: Array.isArray(v.questions) ? v.questions : [],
          crashes: typeof v.crashes === 'number' && Number.isFinite(v.crashes) ? v.crashes : 0,
        }
      : null;
  } catch {
    return null;
  }
}

export interface StepSessionRef {
  step_id: string;
  /** Current + previous session ids, most recent first. */
  session_ids: string[];
  spawn_cwd: string;
}

/** Read every step-session file a drive run persisted. Never throws. */
export function readStepSessionRefs(sessionsDir: string): StepSessionRef[] {
  const out: StepSessionRef[] = [];
  if (!existsSync(sessionsDir)) return out;
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const s = readStepSession(sessionsDir, basename(name, '.json'));
    if (s === null) continue;
    out.push({
      step_id: basename(name, '.json'),
      session_ids: [s.session_id, ...(Array.isArray(s.previous_session_ids) ? s.previous_session_ids : [])],
      spawn_cwd: s.spawn_cwd || process.cwd(),
    });
  }
  return out;
}

export interface StepTranscriptFold {
  tools_called: number;
  tools_failed: number;
  agents_spawned: number;
  /** Transcript-folded token totals — the fallback token source when a run
   *  accumulated no envelope usage (a custom executor template that emits no
   *  terminal `result` frame, or every attempt crashed pre-envelope). */
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Exact-step-attributed failures, chronological across all steps. */
  failures: RunFailureDetail[];
  /** True when at least one session transcript existed on disk — counts are
   *  only meaningful (and worth persisting) when something was actually read. */
  found_any: boolean;
}

/** Fold tool counts + failures from every pinned step session's transcript
 *  (+ its subagents), current and previous executions alike. Window is fully
 *  open — each session hosts exactly one step execution, including its
 *  crash/answer resumes. The second (failure-detail) walk of a file only
 *  happens when its fold saw a failure — clean sessions, the common case,
 *  are read once. Never throws. */
export function foldStepSessionTranscripts(refs: StepSessionRef[], homeOverride?: string): StepTranscriptFold {
  const out: StepTranscriptFold = {
    tools_called: 0,
    tools_failed: 0,
    agents_spawned: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    failures: [],
    found_any: false,
  };
  for (const ref of refs) {
    for (const sessionId of ref.session_ids) {
      try {
        const file = join(claudeProjectsDir(homeOverride), encodeClaudeProjectDir(ref.spawn_cwd), `${sessionId}.jsonl`);
        if (!existsSync(file)) continue;
        out.found_any = true;
        const folded = foldRunStatsFromTranscript(file, null, null);
        out.tools_called += folded.tools_called;
        out.tools_failed += folded.tools_failed;
        out.agents_spawned += folded.agents_spawned;
        out.input_tokens += folded.input_tokens;
        out.output_tokens += folded.output_tokens;
        out.cache_read_tokens += folded.cache_read_tokens;
        out.cache_creation_tokens += folded.cache_creation_tokens;
        if (folded.tools_failed > 0 && out.failures.length < RUN_FAILURES_COLLECT_MAX) {
          const { failures: raw } = collectRunToolFailures(
            file,
            null,
            null,
            RUN_FAILURES_COLLECT_MAX - out.failures.length,
          );
          for (const f of raw) {
            out.failures.push({ ts: f.ts, tool: f.tool_name, step: ref.step_id, error: f.error_excerpt });
          }
        }
      } catch {
        // skip this session's transcript — partial counts beat none
      }
    }
  }
  out.failures.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// listStepSessionTranscriptFiles — the LOCATE-ONLY counterpart of
// foldStepSessionTranscripts, for `pipeline logs --chat` (a headless run's
// post-mortem transcript reader, see commands/logs.ts). The fold above
// answers "how many tools/tokens"; this answers "which files, in what
// order" so the caller can render their actual conversation content instead
// of a count.
// ---------------------------------------------------------------------------

export interface StepTranscriptFile {
  step_id: string;
  session_id: string;
  /** True when this file came from `previous_session_ids` (an earlier
   *  execution, replaced by a graph loop-back) rather than the CURRENT
   *  pinned session. */
  is_previous: boolean;
  /** 'session' = the step's own pinned transcript; 'subagent' = a Task/Agent
   *  fan-out spawned from within that session. */
  kind: 'session' | 'subagent';
  path: string;
}

/** List every transcript file belonging to a headless run's step sessions,
 *  in a readable order: `refs` in the order given (callers sort by step_id
 *  for the usual numbered-step convention), and within each step every
 *  PREVIOUS execution's session (oldest first) then the CURRENT session —
 *  each followed by its own `subagents/` fan-out, sorted by file birth/mtime.
 *
 *  Unlike `foldStepSessionTranscripts`'s fold (which reaches a session's
 *  subagents via `foldRunStatsFromTranscript`'s internal, unexported
 *  `inWindowSubagentFiles`), this does its own subagents/ directory listing:
 *  that vendored helper is both private and window-gated, and a headless
 *  step's `subagents/` dir needs neither — it belongs to exactly one pinned
 *  session, so every file in it is this step's by construction, no window
 *  needed. Best-effort throughout: a missing file or unreadable dir is
 *  skipped, never thrown. */
export function listStepSessionTranscriptFiles(refs: StepSessionRef[], homeOverride?: string): StepTranscriptFile[] {
  const out: StepTranscriptFile[] = [];
  const dir = claudeProjectsDir(homeOverride);
  for (const ref of refs) {
    const projDir = encodeClaudeProjectDir(ref.spawn_cwd);
    // session_ids is [current, ...previous] (most recent first) — reverse so
    // the render order is chronological: oldest previous execution first,
    // current execution last.
    const chronological = [...ref.session_ids].reverse();
    const currentId = ref.session_ids[0];
    for (const sessionId of chronological) {
      const file = join(dir, projDir, `${sessionId}.jsonl`);
      if (existsSync(file)) {
        out.push({ step_id: ref.step_id, session_id: sessionId, is_previous: sessionId !== currentId, kind: 'session', path: file });
      }
      const subDir = join(dir, projDir, sessionId, 'subagents');
      if (!existsSync(subDir)) continue;
      let names: string[];
      try {
        names = readdirSync(subDir).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue;
      }
      const withTime = names.map((name) => {
        const p = join(subDir, name);
        let t = 0;
        try {
          const s = statSync(p);
          t = s.birthtimeMs && s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
        } catch {
          // 0 sorts first — still rendered, just not necessarily in order
        }
        return { p, t };
      });
      withTime.sort((a, b) => a.t - b.t);
      for (const { p } of withTime) {
        out.push({ step_id: ref.step_id, session_id: sessionId, is_previous: sessionId !== currentId, kind: 'subagent', path: p });
      }
    }
  }
  return out;
}
