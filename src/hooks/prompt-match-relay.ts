/**
 * `pipeline hook prompt-match-relay` — the prompt match relay
 * (UserPromptSubmit).
 *
 * WHERE THIS RUNS. A CLI SUBCOMMAND, invoked by `pipeline-claude`'s
 * `hooks/hooks.json` through `hooks/run-hook.sh` (plugin-thin `p6`).
 *
 * Opt-in, deterministic pipeline auto-discovery with ZERO always-loaded
 * context. When the user submits a prompt, this hook runs the same BM25
 * matcher `/pipeline:find` / `/pipeline:dispatch` use (matchPipelines,
 * src/lib/match.ts) against the prompt text and — on a
 * CONFIDENT single match only — injects ONE line of additional context
 * pointing at the matching pre-authored pipeline. On no match, an
 * ambiguous match, or any error it stays completely silent.
 *
 * Confidence rule (same as /pipeline:dispatch tier-1 → tier-2 gate):
 *   • exactly 1 surviving candidate                  → confident
 *   • 2+ candidates and top1/top2 score ratio ≥ 2.0  → confident (top1)
 *   • otherwise (0 candidates, or ratio < 2.0)       → silent
 *
 * Gated: no-ops at entry unless PIPELINE_PROMPT_MATCH_ENABLED is set to a
 * non-empty, non-falsy value — prompt matching is OFF BY DEFAULT (its own
 * opt-in switch, distinct from the now-on-by-default PIPELINE_JOURNAL_ENABLED; only
 * the non-falsy value parsing is shared). Also skips silently when the prompt
 * is a slash command,
 * shorter than 20 chars, or no `.pipeline/` dir exists walking up
 * from cwd to the project root.
 *
 * Stdin payload (Claude Code UserPromptSubmit hook contract,
 * https://code.claude.com/docs/en/hooks): { session_id, transcript_path,
 * cwd, permission_mode, hook_event_name: "UserPromptSubmit", prompt_text }.
 * Older Claude Code versions named the prompt field `prompt`; both
 * spellings are accepted.
 *
 * Stdout on a confident match (same doc): JSON with
 * { hookSpecificOutput: { hookEventName: "UserPromptSubmit",
 *   additionalContext: "<one line>" } } — added as context alongside the
 * submitted prompt.
 *
 * Never blocks the prompt, never errors — always exits 0.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The matcher is imported RELATIVE TO THIS FILE (ES module resolution is
// file-relative, not cwd-relative), so it resolves no matter which consumer
// project directory Claude Code spawns the hook from. lib/match.ts is
// dependency-free (node: builtins only), so this pulls in nothing heavy.
import { matchPipelines } from "../lib/match.ts";
import type { Candidate, MatchResult } from "../lib/match.ts";

const DEBUG = process.env.PIPELINE_JOURNAL_DEBUG === "1";
const log = (msg: string) => DEBUG && console.error(`[prompt-match-relay] ${msg}`);

/** Master enable switch. Prompt matching is OFF BY DEFAULT — this hook
 *  no-ops at entry UNLESS PIPELINE_PROMPT_MATCH_ENABLED is set to a
 *  non-empty, non-falsy value (anything other than 0/false/no/off opts in).
 *  Shares the non-falsy value parsing with PIPELINE_JOURNAL_ENABLED but keeps its
 *  OWN default: prompt matching stays OFF unless explicitly enabled (unlike the
 *  UI/analytics system, which is on by default). The Bun process still spawns
 *  (the registration lives in hooks.json), but it exits immediately, so the
 *  hook imposes ~zero work per prompt until you opt in. To eliminate the spawn
 *  entirely, disable the plugin. */
export function promptMatchEnabled(): boolean {
  const v = (process.env.PIPELINE_PROMPT_MATCH_ENABLED ?? "").trim().toLowerCase();
  if (v === "") return false;
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

// --------------------------------------------------------------------
// Project resolution (shared logic, kept local — hooks must not depend
// on a sibling .ts file at runtime since each is spawned standalone).
// Copied byte-for-byte from src/hooks/analytics-relay.ts.
// --------------------------------------------------------------------

/** The main working tree recorded in a submodule's module directory.
 *
 *  A worktree of a SUBMODULE resolves its commondir to `<repo>/.git/modules/
 *  <name>`, which is not a working tree at all — git records the submodule's
 *  checkout there as `core.worktree`. Without this, every worktree of a
 *  submodule registers as its own project under a path inside `.git`.
 *
 *  COPY of src/lib/event.ts:submoduleWorktreeOf — hooks cannot import
 *  from a sibling .ts at runtime. tests/resolve-parity.test.ts fails on drift. */
function submoduleWorktreeOf(commonDir: string): string | null {
  try {
    const config = readFileSync(join(commonDir, "config"), "utf-8");
    let inCore = false;
    for (const rawLine of config.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("[")) {
        inCore = line.toLowerCase().startsWith("[core");
        continue;
      }
      if (!inCore) continue;
      const m = /^worktree\s*=\s*(.+)$/i.exec(line);
      if (m?.[1]) return resolve(commonDir, m[1].trim());
    }
  } catch {
    /* unreadable config → not a submodule module dir we can resolve */
  }
  return null;
}

export function resolveProjectRoot(start: string): { project_root: string; worktree: string | null } {
  let cur = resolve(start);
  for (let i = 0; i < 64; i++) {
    const git = join(cur, ".git");
    if (existsSync(git)) {
      const s = statSync(git);
      if (s.isDirectory()) return { project_root: cur, worktree: null };
      if (s.isFile()) {
        try {
          const content = readFileSync(git, "utf-8").trim();
          if (content.startsWith("gitdir:")) {
            const gitdir = resolve(cur, content.slice(7).trim());
            const commondirFile = join(gitdir, "commondir");
            if (existsSync(commondirFile)) {
              const commondir = readFileSync(commondirFile, "utf-8").trim();
              const common = resolve(gitdir, commondir);
              if (common.endsWith(".git")) return { project_root: dirname(common), worktree: cur };
              // Submodule worktree: common is `<repo>/.git/modules/<name>`.
              const checkout = submoduleWorktreeOf(common);
              if (checkout) return { project_root: checkout, worktree: cur };
              // Unknown parent — treat this worktree as its own project rather
              // than registering a path inside `.git`.
              return { project_root: cur, worktree: null };
            }
          }
        } catch (e) {
          log(`.git read failed: ${e}`);
        }
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { project_root: resolve(start), worktree: null };
}

/** True when a `.pipeline` directory exists at `start` or any
 *  ancestor up to and including `stopAt` (the resolved project root). This
 *  is the hook's "is this a pipeline project?" gate. It is deliberately
 *  depth- and worktree-independent: it fires whether the session sits at
 *  the project root, deep inside `.pipeline/<name>/steps/…`, or
 *  inside a git worktree checked out under `.claude/worktrees/<name>/`.
 *  Bounding the walk at `stopAt` (the git root — the MAIN repo for a
 *  worktree, since resolveProjectRoot resolves it via commondir) keeps a
 *  stray `.pipeline` far up the tree (e.g. in $HOME) from making
 *  every unrelated session look like a pipeline project. Event routing and
 *  the worktree tag are a SEPARATE concern owned by resolveProjectRoot. */
export function hasPipelineDirUpTo(start: string, stopAt: string): boolean {
  let cur = resolve(start);
  const stop = resolve(stopAt);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, ".pipeline"))) return true;
    if (cur === stop) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

/** Same walk as hasPipelineDirUpTo, but returns the absolute path of the
 *  first `.pipeline` directory found (the matcher's pipelines-dir),
 *  or null when none exists up to the project root. */
export function findPipelineDirUpTo(start: string, stopAt: string): string | null {
  let cur = resolve(start);
  const stop = resolve(stopAt);
  for (let i = 0; i < 64; i++) {
    const candidate = join(cur, ".pipeline");
    if (existsSync(candidate)) return candidate;
    if (cur === stop) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// --------------------------------------------------------------------
// Stdin payload reader (copied from analytics-relay.ts)
// --------------------------------------------------------------------

async function readStdinJson(): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  return new Promise((resolveP) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        const raw = Buffer.concat(chunks).toString("utf-8").trim();
        if (!raw) {
          resolveP(null);
          return;
        }
        resolveP(JSON.parse(raw));
      } catch (e) {
        log(`stdin parse failed: ${e}`);
        resolveP(null);
      }
    };
    process.stdin.on("data", (c) => chunks.push(c as Buffer));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    // Hard cap — hooks should be fast.
    setTimeout(finish, 1500);
  });
}

// --------------------------------------------------------------------
// Prompt extraction + skip rules
// --------------------------------------------------------------------

/** Pull the submitted prompt text from a UserPromptSubmit payload. Current
 *  docs name the field `prompt_text`; older Claude Code versions used
 *  `prompt`. Accept both (same defensive multi-spelling pattern as
 *  analytics-relay's subagentTypeFromPayload). Returns "" when absent. */
export function promptFromPayload(payload: Record<string, unknown>): string {
  const candidates = [payload.prompt_text, payload.prompt];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}

/** Prompts shorter than this (after trimming) carry too little signal for
 *  BM25 to produce a meaningful ranking — skip them. */
export const MIN_PROMPT_LENGTH = 20;

/** True when the prompt should NOT be matched: slash commands (the user
 *  already chose a command — suggesting a pipeline would be noise) and
 *  short prompts (not enough tokens for a meaningful BM25 score). */
export function shouldSkipPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("/")) return true;
  if (trimmed.length < MIN_PROMPT_LENGTH) return true;
  return false;
}

// --------------------------------------------------------------------
// Confidence rule — mirrors /pipeline:dispatch's tier-1 decision tree
// (skills/dispatch/SKILL.md step 3): a single candidate is confident;
// with 2+ candidates the top match is confident only when its score is
// at least AMBIGUITY_RATIO × the runner-up's (otherwise dispatch would
// escalate to the disambiguator — this hook just stays silent instead).
// --------------------------------------------------------------------

export const AMBIGUITY_RATIO = 2.0;

/** Return the single confident candidate, or null when the match is
 *  empty or ambiguous. matchPipelines never returns candidates with
 *  score <= 0, so the ratio division is safe; the defensive branch keeps
 *  a malformed zero-score runner-up from crashing the hook. */
export function pickConfidentMatch(result: MatchResult): Candidate | null {
  const c = result.candidates;
  if (!c || c.length === 0) return null;
  if (c.length === 1) return c[0];
  const top = c[0];
  const second = c[1];
  if (!(second.score > 0)) return top; // defensive — cannot happen via matchPipelines
  return top.score / second.score >= AMBIGUITY_RATIO ? top : null;
}

/** Build the ONE context line injected on a confident match. */
export function buildContextLine(candidate: Candidate): string {
  const pipelineRoot = dirname(candidate.manifest);
  const runHint = candidate.first_iteration
    ? `Consider /pipeline:run ${candidate.first_iteration} or /pipeline:dispatch.`
    : `Consider /pipeline:dispatch.`;
  return `Task may match the pre-authored pipeline '${candidate.name}' (${pipelineRoot}). ${runHint}`;
}

// --------------------------------------------------------------------
// Main
// --------------------------------------------------------------------

async function main(): Promise<void> {
  // Gate FIRST — before any stdin read or filesystem walk.
  if (!promptMatchEnabled()) {
    log("PIPELINE_PROMPT_MATCH_ENABLED not set — no-op (prompt matching disabled by default)");
    return;
  }

  const payload = (await readStdinJson()) ?? {};
  const eventName = String(payload.hook_event_name ?? "").trim();
  if (eventName && eventName !== "UserPromptSubmit") {
    log(`unexpected hook event: ${eventName}`);
    return;
  }

  const prompt = promptFromPayload(payload);
  if (shouldSkipPrompt(prompt)) {
    log("prompt skipped (empty / slash command / too short)");
    return;
  }

  // Locate the consumer project's pipelines dir — walk up from cwd (the
  // payload's cwd when present, else the hook process cwd), bounded at the
  // resolved project root, exactly like analytics-relay's gate.
  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0
    ? payload.cwd
    : process.cwd();
  const { project_root } = resolveProjectRoot(cwd);
  const pipelinesDir = findPipelineDirUpTo(cwd, project_root);
  if (!pipelinesDir) {
    log(`no .pipeline from ${cwd} up to project root ${project_root}, skipping`);
    return;
  }

  // Deterministic BM25 match — same engine as /pipeline:find and
  // /pipeline:dispatch tier 1. Route parse warnings to the debug log so
  // a malformed manifest never surfaces noise into the user's transcript.
  const result = matchPipelines(pipelinesDir, prompt, { onWarn: (m) => log(m) });
  const confident = pickConfidentMatch(result);
  if (!confident) {
    log(`no confident match (${result.candidates.length} candidate(s))`);
    return;
  }

  // Confident single match — inject ONE line of context alongside the
  // prompt via the documented UserPromptSubmit JSON output shape.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: buildContextLine(confident),
      },
    }) + "\n",
  );
}

/**
 * `pipeline hook prompt-match-relay` — the subcommand entry point.
 *
 * ALWAYS RESOLVES 0: a UserPromptSubmit hook that exits non-zero blocks the
 * user's prompt, and a suggestion engine has no business doing that.
 */
export async function runPromptMatchRelay(): Promise<number> {
  try {
    await main();
  } catch (e) {
    log(`top-level: ${e}`);
  }
  return 0;
}
