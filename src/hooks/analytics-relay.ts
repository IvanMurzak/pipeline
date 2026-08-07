/**
 * `pipeline hook analytics-relay` — the analytics relay (PreToolUse +
 * PostToolUse + Stop + SubagentStop + Notification).
 *
 * WHERE THIS RUNS. It is a CLI SUBCOMMAND, not a script the plugin ships.
 * `pipeline-claude`'s `hooks/hooks.json` invokes it through
 * `hooks/run-hook.sh`, which resolves the installed `pipeline` binary and
 * execs `pipeline hook analytics-relay` (plugin-thin `p6`). The relay's
 * version is therefore the CLI's version by construction — the divergence
 * that was possible while the plugin shipped its own copy of both cannot
 * happen. `src/commands/hook.ts` is the dispatcher; this module exports
 * `runAnalyticsRelay()` and everything the tests drive directly.
 *
 * One entry point handling all five events; the dispatcher reads
 * `hook_event_name` from the stdin payload that Claude Code sends.
 *
 * PreToolUse (Agent/Task spawns):
 *   Writes the issue-#11 mirror binding, and — for a Path-C bypass spawn of
 *   the `pipeline-manager` (a terminal session that spawns the manager
 *   directly, with no `/pipeline:run` supervisor already owning the run) —
 *   emits the START half of the RUN lifecycle (`pipeline.started` ONLY) at
 *   spawn time, so the run shows as ACTIVE in the UI for the entire time the
 *   manager is in-flight rather than only appearing after it finishes. The
 *   manager is the RUN ANCHOR as of Phase 2; a worker (`step-executor`, or
 *   legacy `pipeline-executor`) spawn only gets a mirror binding, never a
 *   synthesized run.
 *
 * PostToolUse:
 *   Emits a `tool.called` event with { tool_name, success, agent_spawn,
 *   tool_use_id }. Lets the UI aggregate per-iteration / per-pipeline
 *   tool usage (counts, failures, agent spawns).
 *
 *   ALSO: for a Path-C bypass MANAGER spawn, emits the END half of the RUN
 *   lifecycle (`pipeline.completed`-or-`halted`) when the Agent returns,
 *   under the same tool_use_id-derived run_id PreToolUse used. If PreToolUse
 *   never emitted the START half (older Claude Code, no tool_use_id, or a
 *   cwd not yet recognized as a pipeline project), it falls back to
 *   synthesizing both run-level events at once. The bypass run_id is also
 *   used as the tool.called event's run_id so the manager-spawn shows up in
 *   the run's stats panel. NO `iteration.*` is synthesized — the manager
 *   self-emits those. See the "Bypass-path synthesis" section below.
 *
 * SubagentStop:
 *   When a `pipeline-manager` subagent stops, emits `manager.stopped`
 *   { run_id, agent_id } — the PRIMARY "the run's orchestrator is gone"
 *   liveness signal. The daemon consumes it to mark an otherwise-non-
 *   terminal run abandoned. Other agent types are ignored.
 *
 * Stop:
 *   Tails the session's transcript file from a cursor stored in
 *   `<project>/.pipeline/.runtime/transcripts/<session>.offset`,
 *   sums the `usage` fields of any new assistant turns, and emits one
 *   `turn.usage` event with { input_tokens, output_tokens,
 *   cache_read_tokens, cache_creation_tokens }.
 *
 * Run-correlation:
 *   tool.called and turn.usage events correlate with the active
 *   pipeline run via four sources, checked in order:
 *
 *     1. An explicit `runId` option passed by the caller (used for
 *        Path-C bypass synthesis, which mints its own run_id).
 *     2. The `PIPELINE_RUN_ID` env var. This is set by
 *        `/api/chat` (Path A) and inherited by spawned subprocesses,
 *        so Path A reliably propagates. It is NOT propagated for
 *        Path B / Path C: /pipeline:run exports it in a Bash subshell
 *        which never reaches Claude Code's parent process, and a
 *        terminal Path-C session never exports it at all.
 *     3. A session_id lookup against
 *        ~/.claude/pipeline-ui/active-mirror-bindings.jsonl. THREE writers
 *        key bindings by session_id: `/pipeline:run` (via `pipeline event
 *        register-mirror-binding`), the bypass-spawn PreToolUse handler, and
 *        — since ux-v2 b7 — `pipeline drive`, which PRE-WRITES a binding for
 *        the session UUID it is about to pin on a headless `claude -p` child.
 *        This catches the env-var miss for Paths B, C and the driven path.
 *     4. Otherwise the event lands as ambient telemetry with run_id=null
 *        and the UI's per-run aggregates ignore it.
 *
 *   Without source #3 (the historical state before this fix), tool.called
 *   and turn.usage events emitted during Path-B and Path-C runs always
 *   carried run_id=null — making the UI's RUN_ANALYTICS panel render zero
 *   tools, zero agents, zero tokens for any actively-running pipeline.
 *
 *   STEP correlation (ux-v2 b7): drive's binding also carries the step's
 *   UUID, so source #3 resolves { run_id, step_uuid } — `resolveBinding
 *   FromEnvOrSession`. Events fired inside a driven step therefore name the
 *   step as well as the run, by construction rather than by correlating
 *   timestamps after the fact. Sources #1/#2 carry no step identity (an env
 *   var and a synthesized bypass id are run-scoped), so those events keep
 *   omitting `step_uuid` — absent means "not known", never "no step".
 *
 *   SHELF LIFE, stated deliberately: all of this depends on plugin hooks
 *   firing INSIDE `claude -p`. When `-p` defaults to `--bare` they stop, and
 *   this mechanism has nothing left to attach to (`02` § --bare risk). It is
 *   a near-term improvement, not an architecture; the identity minting it
 *   propagates (b4) is the half that survives.
 *
 * Gated: skips entirely if the current cwd has no `.pipeline/`.
 *
 * Never blocks Claude Code — always exits 0.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { newId, hookIdFromToolUseId } from "../lib/ids.ts";

const DEBUG = process.env.PIPELINE_JOURNAL_DEBUG === "1";
const log = (msg: string) => DEBUG && console.error(`[analytics-relay] ${msg}`);

/** Master enable switch. The journal/analytics system is ON BY DEFAULT — this hook
 *  runs UNLESS the user has explicitly opted OUT by setting PIPELINE_JOURNAL_ENABLED
 *  to a falsy value (0/false/no/off); unset/empty (and any other value) leaves
 *  it enabled. When opted out: no event emission, no mirror bindings, no
 *  filesystem walks. The Bun process still spawns (the registration lives in
 *  hooks.json), but it exits immediately, so an explicit opt-out drops the cost
 *  per hook call to ~zero. To eliminate the spawn entirely, disable the plugin. */
function journalEnabled(): boolean {
  const v = (process.env.PIPELINE_JOURNAL_ENABLED ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** Awaiting-input opt-out switch (PIPELINE_AWAITING_INPUT_ENABLED, default ON).
 *  Deliberately INDEPENDENT of PIPELINE_JOURNAL_ENABLED (D2): a `run.awaiting_input`
 *  event has daemon-free value — `pipeline logs` shows the ⏸ line whether or not
 *  the dashboard runs — so a user who opted out of the journal still learns that
 *  a run is blocked on a permission prompt. Same falsy parse as the switches above. */
function awaitingInputEnabled(): boolean {
  const v = (process.env.PIPELINE_AWAITING_INPUT_ENABLED ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** Transcript opt-out switch (PIPELINE_JOURNAL_TRANSCRIPTS, default ON) — gates
 *  ONLY the privacy-sensitive transcript work this hook does: the Stop-handler
 *  token tail (which OPENS + reads the session transcript to sum tokens) and
 *  the transcript_path carried on the mirror bindings (which is what makes this
 *  session's transcript reachable at all — by `pipeline logs --chat` locally, or
 *  by the hosted dashboard for a `standalone` run that executed on our machine).
 *  When it is opted OUT the hook still emits every BASIC lifecycle event — pipeline.*,
 *  tool.called, manager.stopped — and still writes mirror bindings for run
 *  correlation, just with transcript_path nulled. Same falsy parse + default-ON
 *  as journalEnabled; independent of it (this hook is a standalone Bun
 *  process, so — like journalEnabled — the reader is duplicated here rather
 *  than imported from a sibling). Orthogonal to PIPELINE_STATS_ENABLED. */
function journalTranscriptsEnabled(): boolean {
  const v = (process.env.PIPELINE_JOURNAL_TRANSCRIPTS ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

// Keep in sync with src/lib/event.ts and server.ts. v3 adds
// `default_model` on pipeline.started and `resolved_model` on
// iteration.started; analytics-relay populates both when it synthesizes
// lifecycle events for a bypass run (see synthesizeBypassRun). v4 added
// optional `step_id` on iteration.* events; v5 renames it to `step_name`
// (pipeline v2 — a step is a manifest entry named by `name:`). The hook does
// NOT synthesize iteration.* events (the pipeline-manager self-emits those),
// so it only bumps the version stamp here; it never sets either field itself.
const SCHEMA_VERSION = 5;

// --------------------------------------------------------------------
// Project resolution (shared logic, kept local — hooks must not depend
// on a sibling .ts file at runtime since each is spawned standalone).
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

function resolveProjectRoot(start: string): { project_root: string; worktree: string | null } {
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
function hasPipelineDirUpTo(start: string, stopAt: string): boolean {
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

function ensureRuntimeDir(projectRoot: string): string {
  const runtime = join(projectRoot, ".pipeline", ".runtime");
  mkdirSync(runtime, { recursive: true });
  return runtime;
}

interface AppendEventOpts {
  /** Override run_id; default reads PIPELINE_RUN_ID env. */
  runId?: string | null;
  /** Override parent_run_id; default reads PIPELINE_PARENT_RUN_ID env.
   *  Pass `null` explicitly to clear (e.g. synthesized bypass events
   *  must not inherit a stale parent from the caller's shell env). */
  parentRunId?: string | null;
  /** Override session_id; default reads CLAUDE_SESSION_ID env.
   *  Pass `null` explicitly to clear. */
  sessionId?: string | null;
  /** Override ts; default is now() in ISO. */
  ts?: string;
}

function appendEvent(
  projectRoot: string,
  worktree: string | null,
  type: string,
  data: Record<string, unknown>,
  opts: AppendEventOpts = {},
): void {
  try {
    const runtime = ensureRuntimeDir(projectRoot);
    const evt = {
      schema: SCHEMA_VERSION,
      ts: opts.ts ?? new Date().toISOString(),
      type,
      project_root: projectRoot,
      worktree,
      run_id:
        opts.runId !== undefined
          ? opts.runId
          : (process.env.PIPELINE_RUN_ID ?? null),
      parent_run_id:
        opts.parentRunId !== undefined
          ? opts.parentRunId
          : (process.env.PIPELINE_PARENT_RUN_ID ?? null),
      session_id:
        opts.sessionId !== undefined
          ? opts.sessionId
          : (process.env.CLAUDE_SESSION_ID ?? null),
      data,
    };
    appendFileSync(join(runtime, "events.jsonl"), JSON.stringify(evt) + "\n", "utf-8");
  } catch (e) {
    log(`event append failed: ${e}`);
  }
}

// --------------------------------------------------------------------
// Stdin payload reader
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
// PostToolUse handler
// --------------------------------------------------------------------

function inferSuccess(toolResponse: unknown): boolean {
  if (toolResponse == null) return true;
  if (typeof toolResponse !== "object") return true;
  const r = toolResponse as Record<string, unknown>;
  // Common shapes Claude Code uses for tool errors.
  if (typeof r.error === "string" && r.error.length > 0) return false;
  if (r.is_error === true) return false;
  if (typeof r.exit_code === "number" && r.exit_code !== 0) return false;
  if (r.success === false) return false;
  return true;
}

function isAgentSpawn(toolName: string): boolean {
  // Claude Code's subagent-spawning tool is "Agent" in current versions;
  // older transcripts may show "Task". Treat both as a spawn.
  return toolName === "Agent" || toolName === "Task" || toolName === "TaskCreate";
}

// --------------------------------------------------------------------
// Bypass-path synthesis (Path C) — anchored on the `pipeline-manager`
//
// Three invocation paths exist for a pipeline run:
//   A. /api/chat  — daemon self-instruments the run (server.ts).
//   B. /pipeline:run skill — the main-session supervisor emits the
//      run-level lifecycle and spawns ONE `pipeline-manager` (depth 1)
//      which emits the per-iteration events and spawns the workers.
//   C. Direct spawn of the manager from a terminal session ("run pipeline
//      X for me", and the main agent invokes `Agent({subagent_type:
//      "pipeline-manager", prompt: "Orchestrate this pipeline run …
//      current_iteration = …"})`).
//
// Paths A and B already emit pipeline.started / pipeline.completed-or-
// halted at the RUN level. Path C emits nothing run-level on its own, so
// without synthesis the run never shows up in the UI even though the
// manager's (and workers') own PostToolUse stream is journaled.
//
// This module synthesizes the missing RUN-LEVEL lifecycle for a Path-C
// MANAGER spawn, SPLIT across the two hook ticks so the run is visible as
// ACTIVE while the manager is in-flight — not only after it finishes:
//   • PreToolUse  → pipeline.started               (START half)
//   • PostToolUse → pipeline.completed-or-halted   (END half)
// Both halves share one run_id derived from tool_use_id
// (bypassRunIdFromToolUseId), so they describe a single run. When
// PreToolUse didn't run (older Claude Code, missing tool_use_id, or a cwd
// not yet recognized as a pipeline project), PostToolUse falls back to
// emitting both run-level events at once (synthesizeBypassRun).
//
// NO `iteration.*` is ever synthesized: the manager self-emits
// iteration.started / iteration.completed (and improver.* / script_creator.*)
// via `pipeline event`. A WORKER spawn (`step-executor` / legacy
// `pipeline-executor`) is NOT a run anchor — it only gets a mirror binding.
//
// Discrimination of Path B (which would otherwise double-emit) CANNOT
// rely on `process.env.PIPELINE_RUN_ID` — /pipeline:run exports it
// inside a Bash subshell, which never propagates back to Claude Code's
// main process and therefore not to this hook subprocess. Instead, the
// hook (1) extracts the literal `run_id = …` the supervisor writes into
// the manager prompt, and (2) failing that, scans the tail of the
// project's events.jsonl for a recent `pipeline.started` /
// `iteration.started` matching the spawn's iteration path. If an owning
// run_id resolves that DIFFERS from our own tool_use_id-derived id, the
// supervisor already owns the run — stay silent on lifecycle (a match on
// our OWN id just means our PreToolUse START half is already on disk).
// --------------------------------------------------------------------

// Both regexes match the bare form AND the plugin-namespaced form. When
// the plugin is installed via a marketplace, Claude Code prefixes
// subagent types with the plugin slug + ":" — so the manager surfaces as
// `pipeline:pipeline-manager` and the worker as `pipeline:step-executor`
// (a local, non-marketplace install uses the bare names).
//
// MANAGER anchor — `pipeline-manager` is the run anchor as of Phase 2.
// A Path-C spawn of the manager (no `/pipeline:run` supervisor owning the
// run) is what synthesizes the RUN-LEVEL lifecycle (pipeline.started /
// pipeline.completed / halted). The manager self-emits the per-iteration
// events, so the hook NEVER synthesizes iteration.* for it.
const MANAGER_SUBAGENT_RE = /^(?:[a-z0-9_-]+:)?pipeline-manager$/;

// WORKER — the per-step worker, renamed `pipeline-executor` → `step-executor`
// in Phase 2. The legacy `pipeline-executor` name (and its long-removed
// `-(haiku|sonnet|opus)` per-tier suffix) is STILL tolerated so an in-flight
// or forked run that spawns the old worker name keeps mirror-binding. A
// worker spawn is NOT a run anchor: the hook mirror-binds its transcript and
// emits its `tool.called`, but never synthesizes a run for it (the manager,
// or the supervisor, owns the run lifecycle). Do not tighten the regex to
// drop either the legacy name or the suffix.
const WORKER_SUBAGENT_RE = /^(?:[a-z0-9_-]+:)?(?:step-executor|pipeline-executor(?:-(haiku|sonnet|opus))?)$/;
const ITERATION_PATH_RE = /[A-Za-z]:[\\/](?:[^\s"`'<>|\\/]+[\\/])*\.pipeline[\\/](?:[^\s"`'<>|\\/]+[\\/])*steps[\\/](?:[^\s"`'<>|\\/]+[\\/])*[^\s"`'<>|\\/]+\.md|\/(?:[^\s"`'<>|/]+\/)*\.pipeline\/(?:[^\s"`'<>|/]+\/)*steps\/(?:[^\s"`'<>|/]+\/)*[^\s"`'<>|/]+\.md/;

// Rendered shadow copies (env-variables P4): on a PP_*-variable-declaring run
// the manager spawns the step-executor with the CLI-rendered per-run copy at
// `<pipeline_root>/.runtime/<run_id>/rendered/<pipeline-slug>/steps/…`, while
// every journal event (pipeline.started first_iteration_path,
// iteration.started iteration_path) carries the SOURCE path. Strip that shadow
// infix from a parsed spawn path so ownership matching
// (findChainControllerRunId), pipeline root/name derivation, and the mirror
// binding all stay keyed on source paths. Non-rendered paths never contain a
// `.runtime/<run>/rendered/<slug>/` segment, so this is a no-op for them.
const RENDERED_INFIX_RE = /[\\/]\.runtime[\\/][^\\/]+[\\/]rendered[\\/][^\\/]+(?=[\\/])/;

interface ParsedSpawn {
  iterationPath: string;
  pipelineRoot: string;
  pipelineName: string;
  iterationIndex: number;
  resolvedModel: "haiku" | "sonnet" | "opus" | null;
}

function parseIterationIndex(filename: string): number {
  // Canonical filename is "NN-some-slug.md" — leading 2+ digits.
  const m = /^(\d+)/.exec(basename(filename));
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Parse a subagent spawn (Agent/Task tool_input) whose subagent_type
 *  matches `agentRe`, pulling the iteration path out of the prompt. Shared
 *  by the MANAGER anchor parser and the WORKER (mirror-binding) parser.
 *
 *  For a manager spawn the iteration path comes from the supervisor's
 *  `current_iteration = <abs>` line; for a worker spawn it comes from the
 *  `Execute pipeline iteration: <abs>` line. Both resolve to a path under
 *  `.pipeline/<name>/steps/`, which is what we need to derive the
 *  pipeline name/root for the synthesized `pipeline.started` payload and
 *  the mirror binding. `resolvedModel` is taken from the legacy per-tier
 *  worker-name suffix when present (always null for a manager spawn, which
 *  has no tier suffix). */
function parseSpawn(
  toolInput: Record<string, unknown>,
  agentRe: RegExp,
): ParsedSpawn | null {
  const subagentType = String(toolInput.subagent_type ?? "");
  const subagentMatch = agentRe.exec(subagentType);
  if (!subagentMatch) return null;

  const promptCandidates = [
    toolInput.prompt,
    toolInput.description,
    toolInput.message,
  ];
  let prompt = "";
  for (const c of promptCandidates) {
    if (typeof c === "string" && c.length > 0) {
      prompt = c;
      break;
    }
  }
  if (!prompt) return null;

  const pathMatch = ITERATION_PATH_RE.exec(prompt);
  if (!pathMatch) return null;

  // Normalize a rendered shadow-copy path back to its SOURCE path (see
  // RENDERED_INFIX_RE) — journal events are keyed on source paths.
  const iterationPath = pathMatch[0].replace(RENDERED_INFIX_RE, "");
  // Walk upward from the iteration file's directory until we find a
  // folder literally named `steps`. The pipeline contract permits
  // nested step subfolders (e.g. `steps/phase-2/01-x.md`), so a single
  // dirname() check is not enough.
  let cur = dirname(iterationPath);
  let guard = 32;
  while (guard-- > 0 && basename(cur) !== "steps") {
    const parent = dirname(cur);
    if (!parent || parent === cur) return null;
    cur = parent;
  }
  if (basename(cur) !== "steps") return null;
  const pipelineRoot = dirname(cur);
  if (!pipelineRoot) return null;

  // Defensive: confirm we landed under a .pipeline/ tree.
  const lower = pipelineRoot.replace(/\\/g, "/").toLowerCase();
  if (!lower.includes("/.pipeline/")) return null;

  const resolvedModel = (subagentMatch[1] as "haiku" | "sonnet" | "opus" | undefined) ?? null;

  return {
    iterationPath,
    pipelineRoot,
    pipelineName: basename(pipelineRoot),
    iterationIndex: parseIterationIndex(iterationPath),
    resolvedModel,
  };
}

/** Parse a `pipeline-manager` spawn — the Phase-2 run anchor. */
function parseManagerSpawn(toolInput: Record<string, unknown>): ParsedSpawn | null {
  return parseSpawn(toolInput, MANAGER_SUBAGENT_RE);
}

/** Parse a worker (`step-executor`, or legacy `pipeline-executor`) spawn —
 *  used for the mirror binding only, never for run synthesis. */
function parseWorkerSpawn(toolInput: Record<string, unknown>): ParsedSpawn | null {
  return parseSpawn(toolInput, WORKER_SUBAGENT_RE);
}

/** How recent (ms) a `pipeline.started` for this iteration_path must be
 *  for us to assume the chain controller already owns the run. The chain
 *  controller emits pipeline.started BEFORE spawning the executor, and
 *  the executor's subagent typically runs for seconds-to-minutes — so a
 *  fresh pipeline.started should always be within this window when
 *  PostToolUse fires. 10 minutes is generous. */
const BYPASS_DEDUP_WINDOW_MS = 10 * 60 * 1000;

/** Scan the tail of events.jsonl for evidence that an active chain
 *  controller already owns this spawn's iteration. Returns the matching
 *  run_id when found (Path A/B owns the run; no Path-C synthesis should
 *  fire) or null when no recent match exists.
 *
 *  We accept TWO event types as proof of ownership:
 *
 *    1. `pipeline.started` whose `first_iteration_path` matches this
 *       spawn's iterationPath — this catches the chain's FIRST iteration.
 *
 *    2. `iteration.started` whose `iteration_path` matches this spawn's
 *       iterationPath — this catches iterations 2..N. `/pipeline:run`
 *       emits `iteration.started` BEFORE every `Agent` spawn (SKILL.md
 *       step 4.1), so the line is on disk by the time PreToolUse fires.
 *
 *  Without case 2, the chain controller's first `pipeline.started` carries
 *  `first_iteration_path=step01` and matches step 01 only; steps 02..N
 *  would each be misclassified as a Path-C bypass spawn and get phantom
 *  one-step "runs" minted under fresh hookIdFromToolUseId ids. Including
 *  case 2 keeps the entire chain attributed to its real controller run.
 *
 *  Most-recent-matching-event-wins (we scan from the end and return on
 *  the first hit), with the 10-minute freshness window applied. */
function findChainControllerRunId(
  iterationPath: string,
  projectRoot: string,
): string | null {
  const journalPath = join(projectRoot, ".pipeline", ".runtime", "events.jsonl");
  if (!existsSync(journalPath)) return null;
  let text: string;
  try {
    text = readFileSync(journalPath, "utf-8");
  } catch (e) {
    log(`journal read failed: ${e}`);
    return null;
  }
  const lines = text.split("\n");
  const cutoff = Date.now() - BYPASS_DEDUP_WINDOW_MS;
  // Scan from the end backward; cap at the last 500 lines so a huge
  // journal doesn't slow down PostToolUse.
  const start = Math.max(0, lines.length - 500);
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      const t = ev.type;
      let matchedPath: unknown;
      if (t === "pipeline.started") {
        matchedPath = ev?.data?.first_iteration_path;
      } else if (t === "iteration.started" || t === "iteration.resumed") {
        matchedPath = ev?.data?.iteration_path;
      } else {
        continue;
      }
      if (typeof matchedPath !== "string" || matchedPath !== iterationPath) continue;
      const ts = Date.parse(String(ev.ts ?? ""));
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const rid = ev.run_id;
      if (typeof rid === "string" && rid.length > 0) return rid;
    } catch {
      // Malformed line — ignore.
    }
  }
  return null;
}

/** Resolve an active run_id for an event whose author doesn't already
 *  know which run owns it (tool.called outside an Agent-spawn payload,
 *  turn.usage from the Stop hook). Source order matches the file-header
 *  contract: explicit override > PIPELINE_RUN_ID env > session-keyed
 *  mirror-binding lookup > null.
 *
 *  Path B (/pipeline:run chain controller) and Path C (terminal bypass
 *  spawn) both populate the bindings file with the session_id they're
 *  attached to, so this fallback recovers the run_id when env propagation
 *  fails. Treats the empty string as unset so that `PIPELINE_RUN_ID=""`
 *  (a common shell idiom for clearing a stale value) cannot leak as a
 *  literal `run_id: ""` into the journal — see the appendEvent override
 *  helper. */
function resolveRunIdFromEnvOrSession(
  sessionId: string | null,
  projectRoot: string,
): string | null {
  return resolveBindingFromEnvOrSession(sessionId, projectRoot).runId;
}

/** What a session-keyed binding resolves to. `stepUuid` is present only when
 *  the matched binding carries one — today that means a `pipeline drive`
 *  pre-spawn binding (ux-v2 b7); the Path-B/Path-C writers have no step
 *  identity at binding time, so they resolve `{runId, stepUuid: null}` exactly
 *  as before. */
interface ResolvedBinding {
  runId: string | null;
  stepUuid: string | null;
}

/** The RESOLVER (ux-v2 b7): the same env→session-binding ladder
 *  `resolveRunIdFromEnvOrSession` has always applied, widened to return the
 *  STEP identity alongside the run identity.
 *
 *  Precedence is unchanged and deliberate: `PIPELINE_RUN_ID` still wins for
 *  the run id (an explicit env override must stay authoritative). The binding
 *  is still consulted in that case, but only to recover a `step_uuid`, and only
 *  from a binding that agrees with the env var about which run this is — a
 *  step uuid borrowed from a DIFFERENT run would be worse than none. That costs
 *  one extra bindings read on the env-set path, which no shipped caller takes
 *  any more (README lists the var as internal/do-not-set and nothing in the
 *  product exports it — `/pipeline:run` passes `run_id=` as a kv argument
 *  instead); every hot path already read the file.
 *
 *  This function is the single read of `PIPELINE_RUN_ID` for correlation
 *  purposes; new event sources call it (or the run-id wrapper above) rather
 *  than reading the env var themselves — see docs/journal-and-hooks.md's
 *  run-correlation invariant. */
function resolveBindingFromEnvOrSession(
  sessionId: string | null,
  projectRoot: string,
): ResolvedBinding {
  const env = process.env.PIPELINE_RUN_ID;
  const hit = findBindingForSession(sessionId, projectRoot);
  if (env && env.length > 0) {
    return {
      runId: env,
      // Only adopt the step when the binding is talking about the same run.
      stepUuid: hit && hit.runId === env ? hit.stepUuid : null,
    };
  }
  return { runId: hit?.runId ?? null, stepUuid: hit?.stepUuid ?? null };
}

/** Spread helper: turn a resolved step uuid into the event-`data` fragment that
 *  carries it. Absent (not `null`) when unresolved, so a v5 consumer sees the
 *  field only when it means something and every pre-b7 event shape is byte-
 *  identical to what it was. */
function stepUuidData(stepUuid: string | null): Record<string, string> {
  return stepUuid ? { step_uuid: stepUuid } : {};
}

/** Scan ~/.claude/pipeline-ui/active-mirror-bindings.jsonl for the most
 *  recent non-terminated `bound` record whose session_id matches and
 *  whose project_root matches. Returns null when nothing applies.
 *
 *  Bounded by `BINDING_SCAN_LIMIT` lines for the fast path; falls back
 *  to a full file scan when the tail window yields nothing (so a chain
 *  controller's `bound` record that has aged out of the window still
 *  recovers correctly for long-lived sessions). */
const BINDING_SCAN_LIMIT = 2000;

/** Bindings older than this are treated as stale and ignored. Pipelines
 *  normally complete within hours; a binding older than a week is far
 *  more likely to be a leaked chain-controller record from a completed
 *  pipeline than a still-active run, and matching it would mis-attribute
 *  unrelated post-pipeline tool calls to a dead run. 7 days is generous
 *  for the longest-credible single pipeline; tune down if production
 *  feedback says otherwise. */
const BINDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Path-equality test that tolerates Windows drive-letter case (C: vs c:)
 *  and the local platform's path separator. On POSIX this is a strict
 *  string compare. The chain controller may resolve cwd through
 *  PowerShell (preserves user-typed casing) while the hook subprocess
 *  resolves through Node (does not always canonicalize), so a strict
 *  `===` test occasionally drops valid matches on Windows. */
function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (process.platform !== "win32") return false;
  const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

function findRunIdForSession(
  sessionId: string | null,
  projectRoot: string,
): string | null {
  return findBindingForSession(sessionId, projectRoot)?.runId ?? null;
}

/** As `findRunIdForSession`, but returning the matched binding's `step_uuid`
 *  too (ux-v2 b7). One file read serves both. */
function findBindingForSession(
  sessionId: string | null,
  projectRoot: string,
): { runId: string; stepUuid: string | null } | null {
  if (!sessionId) return null;
  const path = mirrorBindingsPath();
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    log(`bindings read failed: ${e}`);
    return null;
  }
  // Pre-compute the set of run_ids that have already emitted
  // pipeline.completed / pipeline.halted into this project's events.jsonl.
  // The bindings file does NOT receive a `terminal` record for chain-
  // controller bindings (only Path-C bypass spawns do), so without this
  // secondary check the lookup would keep returning a long-completed
  // pipeline's run_id for every subsequent unrelated tool call in the
  // same Claude session. events.jsonl is the canonical lifecycle source.
  const terminatedRunIds = collectTerminatedRunIds(projectRoot);

  const lines = text.split("\n");
  // First pass: fast tail window. Most lookups hit here.
  const tailStart = Math.max(0, lines.length - BINDING_SCAN_LIMIT);
  let hit = pickActiveRunFromWindow(
    lines, tailStart, lines.length, sessionId, projectRoot, terminatedRunIds,
  );
  // Fallback: rare, but a long-lived session with a chain-controller
  // binding that scrolled past the tail window needs a full scan, or
  // the very bug this fix targets re-appears for old runs.
  if (hit === null && tailStart > 0) {
    hit = pickActiveRunFromWindow(
      lines, 0, tailStart, sessionId, projectRoot, terminatedRunIds,
    );
  }
  return hit;
}

interface RunBindingState {
  /** Latest start_ts seen (lex compare, identical ISO precision on both
   *  emitters — `pipeline event`'s utcNowIso and analytics-relay's
   *  Date.toISOString() both produce `YYYY-MM-DDTHH:mm:ss.sssZ`). */
  latestTs: string;
  /** `step_uuid` from the newest record seen for this run in this window
   *  (ux-v2 b7). Null for every binding writer that has no step identity —
   *  the Path-B chain controller and the Path-C bypass spawn. A later record
   *  WITHOUT the field does not erase one that had it: within a single
   *  session id the only writer that re-binds is drive's own crash/answer
   *  resume, which re-states the same step. */
  stepUuid: string | null;
  /** Monotone counter capturing record-file order, used as the tie-break
   *  when two non-terminated runs share an identical millisecond
   *  start_ts. The later file-order wins (most-recently-bound). */
  insertionOrder: number;
  /** True once an explicit `terminal` record in the bindings file (Path
   *  C) OR a pipeline.completed/halted in events.jsonl (Path B) marks
   *  this run finished. */
  terminal: boolean;
}

function pickActiveRunFromWindow(
  lines: string[],
  start: number,
  end: number,
  sessionId: string,
  projectRoot: string,
  terminatedRunIds: Set<string>,
): { runId: string; stepUuid: string | null } | null {
  const byRun = new Map<string, RunBindingState>();
  let counter = 0;
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const r = rec as Partial<MirrorBinding>;
    if (r.session_id !== sessionId) continue;
    if (typeof r.project_root !== "string" || !pathsMatch(r.project_root, projectRoot)) continue;
    if (typeof r.run_id !== "string" || !r.run_id) continue;
    const ts = typeof r.start_ts === "string" ? r.start_ts : "";
    if (ts && isBindingTooOld(ts)) continue;
    counter += 1;
    const stepUuid = typeof r.step_uuid === "string" && r.step_uuid ? r.step_uuid : null;
    const prev = byRun.get(r.run_id);
    const isTerminalRecord = r.event === "terminal";
    if (!prev) {
      byRun.set(r.run_id, {
        latestTs: ts,
        stepUuid,
        insertionOrder: counter,
        terminal: isTerminalRecord || terminatedRunIds.has(r.run_id),
      });
    } else {
      if (ts > prev.latestTs) prev.latestTs = ts;
      // Last non-null wins: a `terminal` record (which never carries one) must
      // not blank out the step identity its `bound` record established.
      if (stepUuid) prev.stepUuid = stepUuid;
      prev.insertionOrder = counter;
      if (isTerminalRecord) prev.terminal = true;
    }
  }
  let best: { runId: string; ts: string; order: number; stepUuid: string | null } | null = null;
  for (const [runId, st] of byRun) {
    if (st.terminal) continue;
    if (
      !best
      || st.latestTs > best.ts
      || (st.latestTs === best.ts && st.insertionOrder > best.order)
    ) {
      best = { runId, ts: st.latestTs, order: st.insertionOrder, stepUuid: st.stepUuid };
    }
  }
  return best === null ? null : { runId: best.runId, stepUuid: best.stepUuid };
}

function isBindingTooOld(startTs: string): boolean {
  const t = Date.parse(startTs);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > BINDING_MAX_AGE_MS;
}

/** Scan the tail of events.jsonl and return the set of run_ids that have
 *  emitted pipeline.completed or pipeline.halted. Used by
 *  findRunIdForSession to treat those bindings as terminated even when
 *  the bindings file itself never received a `terminal` record (the
 *  chain-controller binding case). The same 500-line tail cap as
 *  findChainControllerRunId is reused — a journal is append-only and a
 *  pipeline.completed within the operational window will sit near the
 *  tail. */
function collectTerminatedRunIds(projectRoot: string): Set<string> {
  const out = new Set<string>();
  const journalPath = join(projectRoot, ".pipeline", ".runtime", "events.jsonl");
  if (!existsSync(journalPath)) return out;
  let text: string;
  try {
    text = readFileSync(journalPath, "utf-8");
  } catch {
    return out;
  }
  const lines = text.split("\n");
  const start = Math.max(0, lines.length - 500);
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; run_id?: string };
      if (ev.type !== "pipeline.completed" && ev.type !== "pipeline.halted") continue;
      if (typeof ev.run_id === "string" && ev.run_id) out.add(ev.run_id);
    } catch {
      // Malformed line — ignore.
    }
  }
  return out;
}

// --------------------------------------------------------------------
// Mirror-binding writer (issue #11)
//
// When the executor is spawned in a terminal session (Path C) or by the
// chain controller (Path B), the messages produced inside that
// subagent's transcript don't reach the UI's chat-messages.jsonl on
// their own. To bridge that gap, the hook appends a binding record to a
// daemon-managed journal at ~/.claude/pipeline-ui/active-mirror-bindings.jsonl.
// The daemon's MirrorService tails the bound transcript and writes a
// normalized copy of each new message into the project's chat-messages.jsonl
// — strictly scoped to the bound session/run_id. Sessions that never
// trigger a binding are never tailed.
//
// Schema (one JSON object per line, append-only):
//   {"event":"bound","tool_use_id":"toolu_...","run_id":"...",
//    "session_id":"...","transcript_path":"<abs>","project_root":"<abs>",
//    "worktree":"<abs>|null","pipeline_name":"...","iteration_path":"...",
//    "start_ts":"<iso>","kind":"bypass-spawn|bypass-spawn-failed|chain-controller",
//    "schema":1}
//
// `transcript_path` and `session_id` come from the PostToolUse payload
// (Claude Code's hook contract supplies them); when either is absent
// the daemon falls back to a project-dir scan keyed by tool_use_id.
// --------------------------------------------------------------------

const MIRROR_BINDING_SCHEMA = 1;

function mirrorBindingsPath(): string {
  // Match the home-dir resolution used elsewhere in this plugin
  // (transcripts.ts:48). Reading from process.env first lets tests
  // override HOME/USERPROFILE between cases — Bun's node:os.homedir()
  // caches the home dir at process start, so post-spawn env mutations
  // wouldn't take effect on POSIX otherwise.
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(home, ".claude", "pipeline-ui", "active-mirror-bindings.jsonl");
}

interface MirrorBinding {
  event: "bound" | "terminal";
  tool_use_id: string | null;
  run_id: string;
  /** The STEP this binding's session performs (ux-v2 b7). Written only by
   *  `pipeline drive`'s pre-spawn binding (`kind: "drive-session"`, minted by
   *  ux-v2 b4) — this hook's own writers bind at Agent-spawn time, where no
   *  step identity exists yet, so they omit the field entirely and every
   *  reader treats absent as null. */
  step_uuid?: string | null;
  session_id: string | null;
  transcript_path: string | null;
  project_root: string;
  worktree: string | null;
  pipeline_name: string;
  iteration_path: string;
  start_ts: string;
  kind: "bypass-spawn" | "bypass-spawn-failed" | "chain-controller" | "drive-session";
  schema: number;
}

function appendMirrorBinding(binding: MirrorBinding): void {
  try {
    // PIPELINE_JOURNAL_TRANSCRIPTS off: withhold the transcript pointer so the
    // daemon never mirrors this session's transcript into the chat panel,
    // while KEEPING the binding (run_id + session_id) so the basic lifecycle
    // events still correlate to the run (source #3 of run-correlation). The
    // daemon already treats a transcript_path:null binding as non-mirrorable.
    const rec = journalTranscriptsEnabled()
      ? binding
      : { ...binding, transcript_path: null };
    const path = mirrorBindingsPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(rec) + "\n", "utf-8");
  } catch (e) {
    log(`mirror binding append failed: ${e}`);
  }
}

/** Derive a halt_reason string from a failed Agent tool_response, or null
 *  when the spawn succeeded. Shared by every bypass END synthesizer. */
function haltReasonFromResponse(toolResponse: unknown): string | null {
  if (inferSuccess(toolResponse)) return null;
  if (toolResponse && typeof toolResponse === "object") {
    const r = toolResponse as Record<string, unknown>;
    if (typeof r.error === "string" && r.error.length > 0) return r.error;
    if (r.is_error === true) return "manager reported is_error";
    if (typeof r.exit_code === "number" && r.exit_code !== 0) return `exit_code=${r.exit_code}`;
  }
  return "manager failed";
}

/** Full RUN-LEVEL fallback synthesis for a Path-C `pipeline-manager` bypass
 *  spawn: pipeline.started + pipeline.completed-or-halted, emitted together
 *  by PostToolUse when PreToolUse never ran (older Claude Code, missing
 *  tool_use_id, or a cwd not yet recognized as a pipeline project at spawn
 *  time).
 *
 *  RUN-LEVEL ONLY — the hook does NOT synthesize `iteration.*` for a manager
 *  spawn. The manager self-emits iteration.started / iteration.completed /
 *  improver.* / script_creator.* via `pipeline event`, so synthesizing them here
 *  would double-count. The manager IS the run anchor as of Phase 2. */
function synthesizeBypassRun(
  parsed: ParsedSpawn,
  toolResponse: unknown,
  projectRoot: string,
  worktree: string | null,
  runId: string,
): void {
  const ts0 = Date.now();
  const outcome = inferSuccess(toolResponse) ? "completed" : "halted";
  const haltReason = haltReasonFromResponse(toolResponse);

  // Stagger timestamps by 1ms so journal readers that sort by ts see the
  // events in the canonical lifecycle order even if the run completed
  // synchronously inside this single hook invocation.
  const tsAt = (offset: number): string => new Date(ts0 + offset).toISOString();

  appendEvent(
    projectRoot,
    worktree,
    "pipeline.started",
    {
      pipeline_name: parsed.pipelineName,
      first_iteration_path: parsed.iterationPath,
      pipeline_root: parsed.pipelineRoot,
      default_model: null,
    },
    { runId, parentRunId: null, sessionId: null, ts: tsAt(0) },
  );
  if (outcome === "completed") {
    appendEvent(
      projectRoot,
      worktree,
      "pipeline.completed",
      { pipeline_name: parsed.pipelineName },
      { runId, parentRunId: null, sessionId: null, ts: tsAt(1) },
    );
  } else {
    appendEvent(
      projectRoot,
      worktree,
      "pipeline.halted",
      {
        pipeline_name: parsed.pipelineName,
        iteration_path: parsed.iterationPath,
        halt_reason: haltReason,
      },
      { runId, parentRunId: null, sessionId: null, ts: tsAt(1) },
    );
  }
}

/** START half of a Path-C `pipeline-manager` bypass run: pipeline.started
 *  only. Emitted by the PreToolUse hook at spawn time so the run shows as
 *  ACTIVE in the UI for the entire time the manager subagent is in-flight
 *  (the END half — pipeline.completed/halted — is emitted by PostToolUse
 *  when the Agent returns). run_id is the deterministic tool_use_id-derived
 *  id so both halves agree on one run identity.
 *
 *  RUN-LEVEL ONLY — no `iteration.started`. The manager self-emits the
 *  per-iteration events; synthesizing them here would double-count. */
function synthesizeBypassStart(
  parsed: ParsedSpawn,
  projectRoot: string,
  worktree: string | null,
  runId: string,
): void {
  appendEvent(
    projectRoot,
    worktree,
    "pipeline.started",
    {
      pipeline_name: parsed.pipelineName,
      first_iteration_path: parsed.iterationPath,
      pipeline_root: parsed.pipelineRoot,
      default_model: null,
    },
    { runId, parentRunId: null, sessionId: null, ts: new Date().toISOString() },
  );
}

/** END half of a Path-C `pipeline-manager` bypass run:
 *  pipeline.completed-or-halted only. Emitted by PostToolUse when the
 *  manager Agent returns, for a run whose START half PreToolUse already
 *  emitted (detected via journalHasPipelineStarted). The timestamp is
 *  offset +1ms past the START so it always sorts after, even when
 *  PreToolUse and PostToolUse land in the same millisecond (a very fast
 *  manager).
 *
 *  RUN-LEVEL ONLY — no `iteration.completed`. The manager self-emits the
 *  per-iteration terminal event. */
function synthesizeBypassEnd(
  parsed: ParsedSpawn,
  toolResponse: unknown,
  projectRoot: string,
  worktree: string | null,
  runId: string,
): void {
  const ts = new Date(Date.now() + 1).toISOString();
  const outcome = inferSuccess(toolResponse) ? "completed" : "halted";
  const haltReason = haltReasonFromResponse(toolResponse);
  if (outcome === "completed") {
    appendEvent(
      projectRoot,
      worktree,
      "pipeline.completed",
      { pipeline_name: parsed.pipelineName },
      { runId, parentRunId: null, sessionId: null, ts },
    );
  } else {
    appendEvent(
      projectRoot,
      worktree,
      "pipeline.halted",
      {
        pipeline_name: parsed.pipelineName,
        iteration_path: parsed.iterationPath,
        halt_reason: haltReason,
      },
      { runId, parentRunId: null, sessionId: null, ts },
    );
  }
}

/** True when events.jsonl already contains a pipeline.started for this
 *  exact run_id — i.e. the PreToolUse hook already emitted the START half
 *  of a Path-C bypass run. PostToolUse uses this to choose between emitting
 *  only the END half (the normal split path) and the full four-event
 *  fallback (when PreToolUse never ran: older Claude Code, a missing
 *  tool_use_id, or a cwd that wasn't yet recognized as a pipeline project
 *  at spawn time). No time window is applied: a long-running executor's
 *  START event may be far from the journal tail, and the run_id is unique
 *  per spawn (sha1 of tool_use_id), so a full scan cannot false-match. */
function journalHasPipelineStarted(runId: string, projectRoot: string): boolean {
  if (!runId) return false;
  const journalPath = join(projectRoot, ".pipeline", ".runtime", "events.jsonl");
  if (!existsSync(journalPath)) return false;
  let text: string;
  try {
    text = readFileSync(journalPath, "utf-8");
  } catch {
    return false;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; run_id?: string };
      if (ev.type === "pipeline.started" && ev.run_id === runId) return true;
    } catch {
      // Malformed line — ignore.
    }
  }
  return false;
}

/** Derive a run_id from the PostToolUse / PreToolUse tool_use_id so the
 *  same Path-C spawn produces the same run_id no matter which hook
 *  synthesizes its lifecycle events first. Without this, Phase 2's
 *  PreToolUse hook would write a binding with run_id=A, then Phase 1's
 *  PostToolUse would mint a different run_id=B for the synthesized
 *  lifecycle events, leaving the chat panel decoupled from the run's
 *  stats panel.
 *
 *  ux-v2 b2: this is a DERIVATION (`hookIdFromToolUseId` — RFC 9562 §5.5
 *  UUIDv5 over `tool_use_id`), never `newId()`. PreToolUse and PostToolUse
 *  are separate process invocations with no shared state (see the "Run-
 *  correlation" header comment and the schema note above), so the ONLY way
 *  they can agree on one id is to compute it deterministically from the one
 *  input they share. Swapping this for `newId()` would silently break that
 *  agreement — see `tests/hook-bypass-id-determinism.test.ts` for a test
 *  that actually catches it (calling the function twice in ONE process is
 *  not enough; the regression this guards against only shows up across two).
 *
 *  When tool_use_id is missing (defensive), fall back to a genuinely random
 *  id via `newId()` — PreToolUse and PostToolUse will pick different ids in
 *  that case (there is no shared input to derive from), but Phase 1
 *  behavior is preserved. */
function bypassRunIdFromToolUseId(toolUseId: string | null): string {
  if (toolUseId && toolUseId.length > 0) {
    return hookIdFromToolUseId(toolUseId);
  }
  return newId();
}

// --------------------------------------------------------------------
// Telemetry uploader daemon — "ensure it is running" (ux-v2 b11)
//
// `src/lib/telemetry-upload.ts`'s `flushOnce()` header says
// outright: "the only intended caller ... is the DETACHED uploader daemon
// (b11)". This is the OTHER half of that daemon's contract — the code that
// decides whether one needs to be spawned, called once per `pipeline-manager`
// spawn (a run's start; see the call site in `handlePreToolUse` below), which
// is what makes it contribute to the `08` J2 budget: "≤1 process spawned at
// run start".
//
// THE LOCK, AND WHY IT IS ATOMIC WHERE THE NOTIFIER'S IS NOT
// (`src/hooks/department-notifier-relay.ts`'s `ensureDaemonRunning` /
// `spawnNotifyDaemon`, `:135, :162-173`): that function's shape is CHECK
// (`existsSync`) → SPAWN → WRITE (`writeFileSync`, plain). Two callers that
// both read "no lock" before either has written one both spawn — the pid file
// only ever recorded the LAST writer, so nothing here can even detect that it
// happened. The fix is not "check harder" — no read-then-write pair is ever
// atomic against a second process doing the same thing — it is to make the
// WRITE ITSELF be the check: `acquireTelemetryDaemonLock` below creates the
// lock file with the `wx` (`O_EXCL`) flag BEFORE any spawn happens, using
// THIS process's own pid as a short-lived placeholder (finalized to the real
// daemon pid — see `finalizeTelemetryDaemonLock` — the instant `spawn()`
// returns one, a handful of synchronous fs calls later with nothing else able
// to run on this thread in between). `wx` either creates the file or fails
// with `EEXIST` — there is no window between "does it exist" and "create it"
// for a second caller to land in, because those are the SAME filesystem
// operation. Only the caller whose `wx` call wins is told `'acquired'`; every
// other concurrent caller is told `'already-running'` or `'skip'` and never
// spawns. See `tests/hook-telemetry-daemon-lock.test.ts` for
// the race test AND the mutation check (this scheme reverted to
// `existsSync`-then-write, showing two acquisitions instead of one).
//
// THE STALE-LOCK RECLAIM, AND WHY IT MATTERS MORE THAN THE RACE:
// `wx` alone is worse than the bug it fixes the FIRST time a daemon dies
// without cleaning up — SIGKILL, OOM, `taskkill /F`, a crashed machine. Every
// later `wx` create then fails on that dead lock FOREVER, and telemetry stops
// moving permanently — a wedge, not merely a doubled process. So a lock is
// reclaimed (unlinked, then the `wx` create retried ONCE) when EITHER:
//
//   - the recorded pid is no longer alive (`isProcessAlive` throws on
//     `process.kill(pid, 0)`) — the PRIMARY signal, and it fires immediately
//     (no age wait) for exactly the SIGKILL case above; or
//   - the lock is older than `TELEMETRY_LOCK_STALE_AGE_MS` — a defense
//     against PID REUSE: a dead daemon's pid gets recycled by an unrelated
//     live process before anything ever reclaims the lock, which would make
//     `isProcessAlive` answer "alive" about the wrong process forever. This
//     bound is comfortably ABOVE the daemon's own `DEFAULT_MAX_WALL_CLOCK_MS`
//     (`commands/telemetry-daemon.ts`) so a live, spec-compliant daemon's
//     lock is never reclaimed out from under it — only a pid that outlived
//     what any correct daemon could legitimately run for is suspect.
//
// The reclaim retry is single-shot: if the post-reclaim `wx` create ALSO
// fails (a concurrent reclaimer won it first), this caller backs off
// (`'skip'`) rather than looping — the next `pipeline-manager` spawn tries
// again from a clean read. `TELEMETRY_LOCK_STALE_AGE_MS` MUST track
// `commands/telemetry-daemon.ts`'s `LOCK_STALE_AGE_MS` — duplicated, not
// imported (see that file's header for why), so
// `tests/telemetry-daemon-lock-parity.test.ts` pins the two equal.
//
// This "wx create, then EITHER dead-pid OR age reclaims it" shape is not
// novel to this file: `lib/credential-lock.ts` (a5) already ships the exact
// same argument for the credential-store lock — "exclusive file creation ...
// there is no window where two callers can both believe they created it" —
// and this scheme's `isProcessAlive` below borrows that module's EPERM fix
// (see its own doc comment). The difference is shape, not principle:
// `credential-lock.ts`'s `acquireLock` BLOCKS (polls with a timeout) because
// a caller genuinely needs the lock before it can proceed; a hook must never
// block Claude Code, so `acquireTelemetryDaemonLock` below tries ONCE and, on
// any loss, simply does not spawn — the next run start tries again fresh.
//
// WHY THIS WHOLE BLOCK IS DUPLICATED HERE RATHER THAN IMPORTED FROM
// `commands/telemetry-daemon.ts`: that module pulls in the outbox/upload/
// vendor-privacy chain at top level, real (if small) parse-and-eval cost a
// HOT hook — this file runs on every Agent/Task spawn — should not pay just
// to decide whether a daemon is already running. Same reasoning
// `submoduleWorktreeOf`'s own doc comment above gives for copying rather than
// importing a sibling app.
//
// GATING, so this never touches disk (beyond the two checks below) for a
// project that has no telemetry to ever send: `PIPELINE_SYNC_LOCAL_STATS`
// (parsed with this file's own falsy convention, duplicated from
// `telemetry-outbox.ts`'s `telemetrySyncEnabled` for the SAME hot-hook reason
// as above) and — mirroring F7 ("no cloud account ⇒ the subsystem is ABSENT,
// not merely inert", and matrix 4's "no cloud account: run succeeds; nothing
// surfaced, nothing spawned") — a project that has never run
// `pipeline cloud connect` (no `.pipeline/cloud.json`) gets no daemon either;
// `resolveUploadTarget` would return null anyway, so spawning one that can
// only ever idle-exit is pure waste `08` J2's "≤1 process spawned" budget
// does not need to spend.
// --------------------------------------------------------------------

const TELEMETRY_SYNC_ENV = "PIPELINE_SYNC_LOCAL_STATS";

/** Same falsy-parse convention as `journalEnabled`/`awaitingInputEnabled`
 *  above; duplicated (not imported) from `telemetry-outbox.ts`'s
 *  `telemetrySyncEnabled` for the same "keep this hot hook's import graph
 *  light" reason the rest of this block explains. */
function telemetryDaemonSyncEnabled(): boolean {
  const v = (process.env[TELEMETRY_SYNC_ENV] ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** `<project>/.pipeline/.runtime/telemetry/daemon.lock` — DUPLICATED (not
 *  imported) from `commands/telemetry-daemon.ts`'s `telemetryDaemonLockPath`;
 *  `tests/telemetry-daemon-lock-parity.test.ts` asserts the two agree. */
function telemetryDaemonLockPath(projectRoot: string): string {
  return join(projectRoot, ".pipeline", ".runtime", "telemetry", "daemon.lock");
}

/** MUST track `commands/telemetry-daemon.ts`'s `LOCK_STALE_AGE_MS` exactly —
 *  see this block's header comment and the parity test. */
const TELEMETRY_LOCK_STALE_AGE_MS = 35 * 60_000; // 30 min daemon cap + 5 min grace

interface TelemetryDaemonLock {
  pid: number;
  started_at: string;
}

/** Duplicated from `department-notifier-relay.ts`'s own `isProcessAlive` —
 *  hooks cannot import a sibling at runtime; see that file's header — with
 *  ONE correctness fix pulled from this repo's OTHER `wx`-lock precedent,
 *  `lib/credential-lock.ts`'s own `isProcessAlive` (a5): `EPERM` means the
 *  process exists but this one lacks permission to signal it — still alive.
 *  Anything else (`ESRCH`, or the Windows equivalent Node's libuv shim
 *  throws) means it is gone. The notifier's copy treats EPERM as "dead",
 *  which would misclassify a live daemon running under another account as
 *  stale and reclaim a lock that is not actually free. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readTelemetryDaemonLock(lockPath: string): TelemetryDaemonLock | null {
  if (!existsSync(lockPath)) return null;
  try {
    const txt = readFileSync(lockPath, "utf-8").trim();
    if (!txt) return null;
    const parsed = JSON.parse(txt) as Partial<TelemetryDaemonLock>;
    if (typeof parsed.pid !== "number") return null;
    return { pid: parsed.pid, started_at: String(parsed.started_at ?? "") };
  } catch (e) {
    log(`telemetry daemon lock unreadable: ${e}`);
    return null;
  }
}

function telemetryLockAgeMs(lock: TelemetryDaemonLock, now: number): number {
  const t = Date.parse(lock.started_at);
  return Number.isFinite(t) ? Math.max(0, now - t) : Number.POSITIVE_INFINITY;
}

/** A lock is stale when its pid is dead (the primary, immediate signal) OR
 *  it has outlived any correct daemon's own wall-clock cap plus grace (the
 *  pid-reuse defense) — see this block's header comment. */
function isTelemetryLockStale(lock: TelemetryDaemonLock, now: number): boolean {
  if (!isProcessAlive(lock.pid)) return true;
  return telemetryLockAgeMs(lock, now) >= TELEMETRY_LOCK_STALE_AGE_MS;
}

type TelemetryLockAcquireResult =
  | { action: "already-running"; pid: number }
  | { action: "acquired" }
  | { action: "skip" };

/** Attempt the ONE atomic operation this whole scheme rests on: create
 *  `lockPath` with `wx`, or fail `EEXIST` if anything is there right now.
 *  Any OTHER failure (permissions, a vanished parent dir) also returns
 *  `false` — logged, and treated identically to losing the race: never
 *  spawn on an uncertain lock state. */
function tryCreateTelemetryDaemonLock(lockPath: string, pid: number, now: number): boolean {
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid, started_at: new Date(now).toISOString() } satisfies TelemetryDaemonLock) + "\n",
      { flag: "wx" },
    );
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "EEXIST") log(`telemetry daemon lock create failed: ${e}`);
    return false;
  }
}

/**
 * Atomically claim the right to spawn this project's telemetry daemon. See
 * this block's header comment for the full race + stale-lock reasoning.
 * Exported for `tests/hook-telemetry-daemon-lock.test.ts`.
 *
 * ORDER MATTERS, and matches `lib/credential-lock.ts`'s own `acquireLock`
 * loop exactly (`tryCreate` first; `isStale` — a FRESH read — only ever
 * consulted AFTER a create has already failed): the exclusive `wx` create is
 * attempted BEFORE any unlink, on every call, with no preceding read. A
 * cross-process race test
 * (`tests/hook-telemetry-daemon-lock-cross-process.test.ts`)
 * caught the ORIGINAL, wrong order the hard way: reading first and THEN
 * unconditionally unlinking whatever the read had called "absent" or "stale"
 * — even after a concurrent winner had ALREADY written a brand-new, live
 * lock in the gap between that read and the unlink — deleted the winner's
 * lock out from under it and let a second caller "acquire" too. Attempting
 * the create FIRST removes that gap entirely for the common case (no lock
 * exists yet): the `wx` syscall IS the check, so nothing between "read" and
 * "act" can go stale, because there is no read before it. The residual
 * reclaim path below (reached only once a create has ALREADY failed) reads
 * fresh, immediately before its own unlink+retry — a far smaller window,
 * confined to the genuinely rare case where a stale lock exists at all.
 */
function acquireTelemetryDaemonLock(lockPath: string, now: number, selfPid: number): TelemetryLockAcquireResult {
  // FAST PATH — an optimization only, and never itself a write: skips the
  // create attempt entirely when a snapshot read already shows a live,
  // non-stale lock (the overwhelmingly common steady-state case — most
  // manager spawns in a run land here). Every correctness guarantee below
  // holds with this block deleted; the identical "already-running"
  // determination is repeated, from a FRESH read, immediately after a
  // failed create if this fast path is skipped or its snapshot was wrong.
  const snapshot = readTelemetryDaemonLock(lockPath);
  if (snapshot !== null && !isTelemetryLockStale(snapshot, now)) {
    return { action: "already-running", pid: snapshot.pid };
  }

  if (tryCreateTelemetryDaemonLock(lockPath, selfPid, now)) {
    return { action: "acquired" };
  }

  // Lost the create — something occupies the path RIGHT NOW. Re-read it
  // FRESH (never trust `snapshot` here: it describes a moment that has
  // already been proven stale by this very failure).
  const current = readTelemetryDaemonLock(lockPath);
  if (current !== null && !isTelemetryLockStale(current, now)) {
    return { action: "already-running", pid: current.pid };
  }
  // Absent again (the holder released it between our failed create and this
  // read), stale, or corrupt/unreadable — clear it and retry ONCE, based
  // ONLY on what this fresh read just observed.
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone, or a concurrent reclaimer beat us to it */
  }
  if (tryCreateTelemetryDaemonLock(lockPath, selfPid, now)) {
    return { action: "acquired" };
  }
  // A concurrent reclaimer won the retry. Back off rather than loop again —
  // the next pipeline-manager spawn tries from a clean read.
  return { action: "skip" };
}

/** Overwrite a lock this process just won (via `acquireTelemetryDaemonLock`
 *  returning `'acquired'`) with the REAL daemon pid once `spawn()` returns
 *  one. Safe as a plain write — exclusivity was already established by the
 *  `wx` create; this only ever follows a successful acquisition for the same
 *  lock path in the same process. */
function finalizeTelemetryDaemonLock(lockPath: string, pid: number, now: number): void {
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid, started_at: new Date(now).toISOString() } satisfies TelemetryDaemonLock) + "\n",
    );
  } catch (e) {
    log(`telemetry daemon lock finalize failed: ${e}`);
  }
}

/** This package's own `src/cli.ts`, resolved from THIS file's directory
 *  (`src/hooks/` → `src/cli.ts`). It used to be
 *  `$CLAUDE_PLUGIN_ROOT/apps/pipeline-cli/src/cli.ts`, because the relay was a
 *  script inside the plugin reaching sideways into the CLI copy the plugin
 *  shipped. It is neither of those things now: the relay IS the CLI, so the
 *  entry point is one directory up and `CLAUDE_PLUGIN_ROOT` is deliberately
 *  not consulted — a plugin checkout no longer contains a CLI to spawn, and
 *  honouring that variable would point the daemon at whatever stale copy an
 *  older plugin still happened to carry. */
const TELEMETRY_CLI_ENTRY = resolve(import.meta.dir, "..", "cli.ts");

/** Spawn `pipeline telemetry-daemon` detached — the SAME spawn shape as
 *  `department-notifier-relay.ts`'s `spawnNotifyDaemon` (`detached: true`,
 *  `stdio: "ignore"`, `windowsHide: true`, `child.unref()`; the Windows
 *  console-window concern is a verified non-issue there, and copied here
 *  unchanged), using `process.execPath` rather than a bare `bun` on PATH for
 *  the same Windows npm-shim reason that file documents. Only called after
 *  `acquireTelemetryDaemonLock` has already returned `'acquired'` — this
 *  function never decides whether to spawn, only how. */
function spawnTelemetryDaemon(lockPath: string, projectRoot: string, reservedAt: number): void {
  if (!existsSync(TELEMETRY_CLI_ENTRY)) {
    log(`telemetry daemon: cli entry not found at ${TELEMETRY_CLI_ENTRY}`);
    return;
  }
  try {
    const child = spawn(
      process.execPath,
      [TELEMETRY_CLI_ENTRY, "telemetry-daemon", "--project-root", projectRoot],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
        windowsHide: true,
      },
    );
    child.unref();
    if (typeof child.pid === "number") {
      finalizeTelemetryDaemonLock(lockPath, child.pid, reservedAt);
      log(`spawned telemetry daemon pid=${child.pid} for ${projectRoot}`);
    } else {
      // No pid to finalize with. The lock stays reserved under THIS process's
      // (the hook's) own pid, which is fine, not a wedge: the hook process
      // exits within milliseconds of returning from main(), at which point
      // isProcessAlive(lock.pid) immediately answers false and the very next
      // pipeline-manager spawn reclaims the lock and tries again.
      log("telemetry daemon spawn returned no pid — leaving the reservation to self-heal");
    }
  } catch (e) {
    log(`failed to spawn telemetry daemon: ${e}`);
  }
}

/**
 * Ensure this project's telemetry daemon is running, spawning one if the
 * lock is absent, stale, or points at a dead pid. Called once per
 * `pipeline-manager` spawn (`handlePreToolUse` below) — a run's start.
 *
 * Best-effort and NEVER throws (mirrors `department-notifier-relay.ts`'s own
 * `ensureDaemonRunning`): any failure here must never block Claude Code or
 * fail the surrounding hook. No network work happens in this function or
 * anything it calls — only local fs checks and, at most once, a detached
 * spawn — matching this task's "no network work in the hook" rule.
 */
function ensureTelemetryDaemonRunning(projectRoot: string): void {
  try {
    if (!telemetryDaemonSyncEnabled()) return;
    // F7 / matrix 4: no cloud account ⇒ nothing to ever upload ⇒ spawn
    // nothing. `resolveUploadTarget` would reach the same "null" conclusion
    // over the network path this hook must never take; checking the local
    // project binding first is the whole reason this can stay synchronous.
    if (!existsSync(join(projectRoot, ".pipeline", "cloud.json"))) return;

    const lockPath = telemetryDaemonLockPath(projectRoot);
    mkdirSync(dirname(lockPath), { recursive: true });
    const now = Date.now();
    const result = acquireTelemetryDaemonLock(lockPath, now, process.pid);
    if (result.action !== "acquired") return;
    spawnTelemetryDaemon(lockPath, projectRoot, now);
  } catch (e) {
    log(`ensureTelemetryDaemonRunning threw: ${e}`);
  }
}

// --------------------------------------------------------------------
// PreToolUse handler — fires BEFORE the executor subagent runs.
//
// Two spawn shapes are recognized, anchored on the AGENT being spawned:
//
//   • MANAGER spawn (`pipeline-manager`) — the RUN ANCHOR (Phase 2).
//     1. Mirror-bind the manager's transcript so the daemon tails the
//        orchestration as soon as Claude Code starts writing it.
//     2. For a Path-C bypass spawn (a terminal session that spawns the
//        manager directly, with NO `/pipeline:run` supervisor already
//        owning the run), emit the START half of the RUN lifecycle —
//        `pipeline.started` ONLY — RIGHT NOW, so the run shows as ACTIVE
//        in the UI for the whole time the manager is in-flight. The END
//        half (`pipeline.completed`/`halted`) is emitted by PostToolUse
//        when the Agent returns. Both halves use the same tool_use_id-
//        derived run_id. NO `iteration.*` is synthesized — the manager
//        self-emits those.
//     For Path B (the `/pipeline:run` supervisor, which emits its own
//     `pipeline.started` before spawning the manager) PreToolUse stays
//     silent on lifecycle — it only records a chain-controller binding.
//
//   • WORKER spawn (`step-executor`, or legacy `pipeline-executor`) — NOT
//     a run anchor. Mirror-bind the worker's transcript so the UI shows
//     the step work, attributed to the owning run. NEVER synthesize a run
//     for a worker spawn (in Path B the supervisor emitted
//     `pipeline.started` and the manager emits `iteration.started` before
//     each worker spawn, so the run already exists).
// --------------------------------------------------------------------

/** The run-id shapes that can legitimately appear on a `run_id = …` line.
 *
 *  1. A canonical 36-char UUID — what every mint site produces since ux-v2
 *     b2. Deliberately VERSION-AGNOSTIC: `newId()` mints v7, while
 *     `hookIdFromToolUseId()` mints v5 for bypass spawns, and a supervisor
 *     may legitimately be echoing either. This function extracts an id; it
 *     does not adjudicate which class minted it.
 *  2. The pre-b2 12-lowercase-hex id (`randomBytes(6).toString('hex')`).
 *     Kept so a run already in flight when the plugin updates — its manager
 *     prompt written under the old scheme — keeps its Path-B ownership
 *     instead of sprouting a phantom mid-chain.
 *
 *  Ordered UUID-first: the 12-hex alternative cannot match a UUID anyway (a
 *  hyphen sits at offset 8), but leading with the longer shape keeps the
 *  intent obvious and forbids a truncated-prefix match by construction. */
const PROMPT_RUN_ID_RE =
  /\brun_id\s*[=:]\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12})\b/i;

/** Pull the literal `run_id = <id>` the supervisor writes into the
 *  `pipeline-manager` spawn prompt. A strong Path-B ownership signal that
 *  survives a resume (where the journal scan by iteration_path can miss,
 *  because the supervisor's single `pipeline.started` carries the FIRST
 *  iteration path, not the resume iteration). Returns null when no such
 *  line is present (e.g. a Path-C hand spawn that omits it).
 *
 *  Load-bearing, and quietly so: when this misses, the caller falls through
 *  to `findChainControllerRunId`, and where THAT also misses — the matching
 *  journal event aged out of `BYPASS_DEDUP_WINDOW_MS`, was pushed past the
 *  500-line tail cap, or is simply absent — the spawn is misclassified
 *  `bypass-spawn`, a different run id is minted, and `synthesizeBypassStart`
 *  announces a PHANTOM second run on the dashboard. See
 *  <superrepo>/tests/cross-repo/hook-runid-shape-ownership.test.ts, which pins
 *  exactly that population (a fresh chain does NOT reproduce it). */
function extractRunIdFromPrompt(toolInput: Record<string, unknown>): string | null {
  const candidates = [toolInput.prompt, toolInput.description, toolInput.message];
  for (const c of candidates) {
    if (typeof c !== "string" || c.length === 0) continue;
    const m = PROMPT_RUN_ID_RE.exec(c);
    if (m) return m[1];
  }
  return null;
}

function handlePreToolUse(payload: Record<string, unknown>, projectRoot: string, worktree: string | null): void {
  const toolName = String(payload.tool_name ?? "unknown");
  if (!isAgentSpawn(toolName)) return;
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== "object") return;
  const input = toolInput as Record<string, unknown>;

  const transcriptPath = (() => {
    const v = payload.transcript_path;
    return typeof v === "string" && v.length > 0 ? v : null;
  })();
  const sessionId = (() => {
    const v = payload.session_id;
    return typeof v === "string" && v.length > 0 ? v : null;
  })();
  const toolUseId = (() => {
    const v = payload.tool_use_id;
    return typeof v === "string" && v.length > 0 ? v : null;
  })();

  // --- MANAGER spawn: the run anchor. ---
  const managerParsed = parseManagerSpawn(input);
  if (managerParsed) {
    // ux-v2 b11: a pipeline-manager spawn IS a run's start (Path B or Path C
    // alike — the supervisor spawns it exactly once per run, same as a
    // bypass session), so this is where the daemon-ensure check belongs —
    // NOT in the (per-step, many-times-per-run) worker branch below. Cheap
    // (see the block's own header: sync-enabled + a `.pipeline/cloud.json`
    // existence check, then a lock read; never network work) and idempotent
    // — once a live daemon is running, every later call in the same run is a
    // couple of local fs stats.
    ensureTelemetryDaemonRunning(projectRoot);
    // Path-B ownership: the supervisor passes its run_id literally in the
    // manager prompt; failing that, scan the journal for a recent
    // pipeline.started/iteration.started on this iteration path.
    const ownedRunId =
      extractRunIdFromPrompt(input)
      ?? findChainControllerRunId(managerParsed.iterationPath, projectRoot);
    // Without tool_use_id, the Phase-2 PreToolUse binding cannot correlate
    // with the PostToolUse synthesis: bypassRunIdFromToolUseId would fall
    // back to newId() and the two hooks would pick different run_ids.
    // Bail out so PostToolUse handles the binding exclusively in this
    // defensive case — synthesis still works without PreToolUse, just with
    // a longer "no messages yet" window.
    if (!ownedRunId && !toolUseId) return;
    const runId = ownedRunId ?? bypassRunIdFromToolUseId(toolUseId);
    const kind: MirrorBinding["kind"] = ownedRunId ? "chain-controller" : "bypass-spawn";

    // Path C (no supervisor owns the run): emit the START half (pipeline.started
    // only — RUN-LEVEL) so the run is visible as ACTIVE while the manager is
    // in-flight. PostToolUse emits the END half on return. For Path B the
    // supervisor already emitted pipeline.started, so we stay silent.
    if (!ownedRunId) {
      synthesizeBypassStart(managerParsed, projectRoot, worktree, runId);
    }

    appendMirrorBinding({
      event: "bound",
      tool_use_id: toolUseId,
      run_id: runId,
      session_id: sessionId,
      transcript_path: transcriptPath,
      project_root: projectRoot,
      worktree,
      pipeline_name: managerParsed.pipelineName,
      iteration_path: managerParsed.iterationPath,
      start_ts: new Date().toISOString(),
      kind,
      schema: MIRROR_BINDING_SCHEMA,
    });
    return;
  }

  // --- WORKER spawn: mirror-bind only, NEVER synthesize a run. ---
  const workerParsed = parseWorkerSpawn(input);
  if (!workerParsed) return;
  // Attribute the worker's transcript to the owning run. The manager emits
  // iteration.started before each worker spawn, so the journal scan finds
  // the run; a session-keyed binding is the fallback when env propagation
  // failed. A worker spawn never anchors a run, so when neither resolves we
  // simply skip the binding (the worker's tool.called still lands via the
  // PostToolUse session lookup).
  const ownedRunId =
    findChainControllerRunId(workerParsed.iterationPath, projectRoot)
    ?? resolveRunIdFromEnvOrSession(sessionId, projectRoot);
  if (!ownedRunId) return;
  appendMirrorBinding({
    event: "bound",
    tool_use_id: toolUseId,
    run_id: ownedRunId,
    session_id: sessionId,
    transcript_path: transcriptPath,
    project_root: projectRoot,
    worktree,
    pipeline_name: workerParsed.pipelineName,
    iteration_path: workerParsed.iterationPath,
    start_ts: new Date().toISOString(),
    kind: "chain-controller",
    schema: MIRROR_BINDING_SCHEMA,
  });
}

function handlePostToolUse(payload: Record<string, unknown>, projectRoot: string, worktree: string | null): void {
  const toolName = String(payload.tool_name ?? "unknown");
  const toolResponse = payload.tool_response ?? payload.tool_result ?? null;
  const success = inferSuccess(toolResponse);
  const agentSpawn = isAgentSpawn(toolName);

  // Decide whether this PostToolUse triggers Path-C synthesis. We need
  // the answer BEFORE emitting tool.called so the tool.called event can
  // bind to the synthesized run_id — otherwise the synthesized run
  // would show tools_called=0 / agents_spawned=0 even though spawning
  // the manager is literally why the run exists.
  //
  // The RUN ANCHOR is the `pipeline-manager` spawn (Phase 2). A worker
  // (`step-executor` / legacy `pipeline-executor`) spawn is NEVER a run
  // anchor — it only gets a mirror binding attributed to the owning run.
  let bypassRunId: string | null = null;
  let bypassParsed: ParsedSpawn | null = null;
  let bypassStartedEarly = false;
  let mirrorBindingRunId: string | null = null;
  let mirrorBindingKind: MirrorBinding["kind"] | null = null;
  let mirrorBindingParsed: ParsedSpawn | null = null;
  if (agentSpawn) {
    const toolInput = payload.tool_input;
    if (toolInput && typeof toolInput === "object") {
      const input = toolInput as Record<string, unknown>;
      const managerParsed = parseManagerSpawn(input);
      if (managerParsed) {
        // MANAGER spawn — the run anchor. Derive run_id deterministically
        // from tool_use_id so the PreToolUse-emitted START half + mirror
        // binding and the PostToolUse-emitted END half share one identity.
        const toolUseIdStr = typeof payload.tool_use_id === "string" ? payload.tool_use_id : null;
        const candidateRunId = bypassRunIdFromToolUseId(toolUseIdStr);
        // Path-B ownership: the supervisor passes its run_id literally in
        // the manager prompt; else scan the journal by iteration path.
        const ownedRunId =
          extractRunIdFromPrompt(input)
          ?? findChainControllerRunId(managerParsed.iterationPath, projectRoot);
        if (ownedRunId && ownedRunId !== candidateRunId) {
          // Path A or B already owns this run. Still record a binding so
          // the daemon mirrors the manager's transcript into the same chat
          // panel — without this a Path-B run only shows the supervisor's
          // own emission, not the manager's orchestration.
          mirrorBindingRunId = ownedRunId;
          mirrorBindingKind = "chain-controller";
          mirrorBindingParsed = managerParsed;
        } else {
          // Path C bypass spawn. If PreToolUse already emitted the START
          // half for this run_id, emit only the END half now; otherwise
          // (PreToolUse never ran) synthesize the full RUN-level lifecycle
          // as a fallback. journalHasPipelineStarted disambiguates the two.
          bypassParsed = managerParsed;
          bypassRunId = candidateRunId;
          bypassStartedEarly = journalHasPipelineStarted(candidateRunId, projectRoot);
          mirrorBindingRunId = candidateRunId;
          mirrorBindingKind = success ? "bypass-spawn" : "bypass-spawn-failed";
          mirrorBindingParsed = managerParsed;
        }
      } else {
        const workerParsed = parseWorkerSpawn(input);
        if (workerParsed) {
          // WORKER spawn — mirror-bind only, NEVER synthesize a run. The
          // manager emitted iteration.started before this spawn, so the
          // journal scan finds the owning run; the session-keyed binding
          // is the fallback. No run_id resolved ⇒ skip the binding (the
          // worker's tool.called still lands via the session lookup below).
          const ownedRunId =
            findChainControllerRunId(workerParsed.iterationPath, projectRoot)
            ?? resolveRunIdFromEnvOrSession(
              typeof payload.session_id === "string" && payload.session_id.length > 0
                ? payload.session_id
                : null,
              projectRoot,
            );
          if (ownedRunId) {
            mirrorBindingRunId = ownedRunId;
            mirrorBindingKind = "chain-controller";
            mirrorBindingParsed = workerParsed;
          }
        }
      }
    }
  }

  // Resolve the run_id that this tool.called should be attributed to.
  // Source precedence (and why):
  //   1. bypassRunId — Path C: this PostToolUse is itself the Agent spawn,
  //      so the run_id we just minted from tool_use_id is the canonical
  //      identity for the synthesized run. parent_run_id and session_id
  //      are cleared so a stale parent from the caller's shell env can't
  //      mis-attribute the synthesized run (mirrors synthesizeBypassRun).
  //   2. mirrorBindingRunId — Path B Agent spawn: the chain controller
  //      already owns this run; bind the tool.called to its run_id so the
  //      RUN_ANALYTICS panel counts the executor spawn. Same parent/session
  //      reset for the same reason.
  //   3. Otherwise (every OTHER tool call: the executor's internal
  //      Read/Edit/Bash, the chain controller's own tool calls), defer to
  //      PIPELINE_RUN_ID env then a session_id lookup against the
  //      mirror-bindings file. The env var is not propagated for Paths
  //      B/C — it lives only in /pipeline:run's bash subshell, never in
  //      CC's parent process — so the session-keyed lookup is the
  //      load-bearing recovery. Without it per-run stats stay stuck at
  //      zero on every actively-running pipeline. Leave parent_run_id
  //      and session_id to the appendEvent env defaults so a blocker-
  //      delegation child still threads under its parent.
  const sessionIdForLookup = typeof payload.session_id === "string" && payload.session_id.length > 0
    ? payload.session_id
    : null;
  let toolCalledOpts: AppendEventOpts;
  // ux-v2 b7: the step this tool call belongs to, when the binding names one.
  // Sources 1 and 2 are Agent-SPAWN attributions — the spawn is what starts a
  // step, so there is no step identity to inherit; only the session-keyed
  // binding (source 3) can carry one.
  let toolCalledStepUuid: string | null = null;
  if (bypassRunId) {
    toolCalledOpts = { runId: bypassRunId, parentRunId: null, sessionId: null };
  } else if (mirrorBindingRunId) {
    toolCalledOpts = { runId: mirrorBindingRunId, parentRunId: null, sessionId: null };
  } else {
    // Pass runId explicitly (even when null) so appendEvent's env-var
    // default never overrides it with an empty string. resolveRunIdFrom
    // EnvOrSession already treats `PIPELINE_RUN_ID=""` as unset; the
    // explicit-null override seals the leak in appendEvent's fallback
    // (`process.env.PIPELINE_RUN_ID ?? null` returns "" for an empty
    // env, which is neither null nor a valid run_id).
    const resolved = resolveBindingFromEnvOrSession(sessionIdForLookup, projectRoot);
    toolCalledOpts = { runId: resolved.runId };
    toolCalledStepUuid = resolved.stepUuid;
  }

  appendEvent(
    projectRoot,
    worktree,
    "tool.called",
    {
      tool_name: toolName,
      success,
      agent_spawn: agentSpawn,
      tool_use_id: payload.tool_use_id ?? null,
      ...stepUuidData(toolCalledStepUuid),
    },
    toolCalledOpts,
  );

  if (bypassParsed && bypassRunId) {
    if (bypassStartedEarly) {
      // PreToolUse already emitted pipeline.started + iteration.started for
      // this run; emit only the terminal half now.
      synthesizeBypassEnd(bypassParsed, toolResponse, projectRoot, worktree, bypassRunId);
    } else {
      // PreToolUse never ran (older Claude Code / no tool_use_id at spawn /
      // cwd not yet a pipeline project): synthesize the whole lifecycle.
      synthesizeBypassRun(bypassParsed, toolResponse, projectRoot, worktree, bypassRunId);
    }
  }

  if (mirrorBindingParsed && mirrorBindingRunId && mirrorBindingKind) {
    const transcriptPath = (() => {
      const v = payload.transcript_path;
      return typeof v === "string" && v.length > 0 ? v : null;
    })();
    const sessionId = (() => {
      const v = payload.session_id;
      return typeof v === "string" && v.length > 0 ? v : null;
    })();
    const toolUseId = (() => {
      const v = payload.tool_use_id;
      return typeof v === "string" && v.length > 0 ? v : null;
    })();
    const ts = new Date().toISOString();
    const baseBinding: MirrorBinding = {
      event: "bound",
      tool_use_id: toolUseId,
      run_id: mirrorBindingRunId,
      session_id: sessionId,
      transcript_path: transcriptPath,
      project_root: projectRoot,
      worktree,
      pipeline_name: mirrorBindingParsed.pipelineName,
      iteration_path: mirrorBindingParsed.iterationPath,
      start_ts: ts,
      kind: mirrorBindingKind,
      schema: MIRROR_BINDING_SCHEMA,
    };
    appendMirrorBinding(baseBinding);
    // For Path-C bypass spawns, the manager is already finished by the
    // time PostToolUse fires — synthesizeBypassRun/End has already emitted
    // pipeline.completed/halted in the same hook tick. Write a matching
    // terminal record so the daemon's MirrorService stops tailing once
    // it has drained the current transcript content. Without this, if
    // the daemon observed the journal's pipeline.completed BEFORE the
    // bindings file's new line (a common ordering for fast spawns), the
    // binding would register as non-terminal and tail forever — every
    // subsequent unrelated tool call in the user's Claude session would
    // leak into the project's chat-messages.jsonl. Worker bindings
    // (kind="chain-controller", bypassParsed null) get no terminal record.
    if (bypassParsed && bypassRunId) {
      appendMirrorBinding({ ...baseBinding, event: "terminal" });
    }
  }
}

// --------------------------------------------------------------------
// Stop handler — transcript tail with usage extraction
// --------------------------------------------------------------------

interface OffsetState {
  offset: number;
  size_at_offset: number;
}

function readOffset(path: string): OffsetState {
  try {
    if (!existsSync(path)) return { offset: 0, size_at_offset: 0 };
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { offset: 0, size_at_offset: 0 };
  }
}

function writeOffset(path: string, state: OffsetState): void {
  try {
    writeFileSync(path, JSON.stringify(state));
  } catch (e) {
    log(`offset write failed: ${e}`);
  }
}

function readTail(path: string, fromOffset: number, toOffset: number): string {
  const len = toOffset - fromOffset;
  if (len <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    let read = 0;
    let position = fromOffset;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, position);
      if (n <= 0) break;
      read += n;
      position += n;
    }
    return buf.slice(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function handleStop(payload: Record<string, unknown>, projectRoot: string, worktree: string | null): void {
  // The Stop handler's ONLY job is to OPEN + tail the session transcript to sum
  // token usage. That is transcript-derived analytics, so the transcript
  // opt-out governs it: when off we never touch the transcript file and emit no
  // turn.usage. Basic lifecycle events (emitted by the other handlers) are
  // unaffected. Note run-stats prefers the daemon's transcript fold over these
  // turn.usage events anyway, so this is the secondary token source.
  if (!journalTranscriptsEnabled()) {
    log("PIPELINE_JOURNAL_TRANSCRIPTS off — skipping Stop transcript token tail");
    return;
  }
  const transcriptPath = String(payload.transcript_path ?? "");
  const sessionId = String(payload.session_id ?? "");
  if (!transcriptPath || !existsSync(transcriptPath)) {
    log(`no transcript at ${transcriptPath}`);
    return;
  }
  const runtime = ensureRuntimeDir(projectRoot);
  const offsetDir = join(runtime, "transcripts");
  mkdirSync(offsetDir, { recursive: true });
  const offsetPath = join(offsetDir, `${sessionId || "default"}.offset`);

  let { offset, size_at_offset } = readOffset(offsetPath);
  let size: number;
  try {
    size = statSync(transcriptPath).size;
  } catch (e) {
    log(`stat transcript failed: ${e}`);
    return;
  }

  // If the file shrunk, reset.
  if (size < size_at_offset) {
    offset = 0;
    size_at_offset = 0;
  }
  if (size === offset) return;

  const chunk = readTail(transcriptPath, offset, size);
  const lines = chunk.split("\n");
  // The last line may be partial — only advance offset to the start of it.
  let partialLen = 0;
  if (!chunk.endsWith("\n") && lines.length > 0) {
    partialLen = Buffer.byteLength(lines[lines.length - 1] ?? "", "utf-8");
    lines.pop();
  }

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let assistantTurns = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      // Common shapes across Claude Code transcript versions:
      //   { type: "assistant", message: { usage: { input_tokens, output_tokens, ... } } }
      //   { type: "result", usage: { ... } }
      let usage: Record<string, unknown> | null = null;
      const msg = (obj.message ?? null) as Record<string, unknown> | null;
      if (msg && msg.usage && typeof msg.usage === "object") {
        usage = msg.usage as Record<string, unknown>;
      } else if (obj.usage && typeof obj.usage === "object") {
        usage = obj.usage as Record<string, unknown>;
      }
      if (usage) {
        assistantTurns += 1;
        input += Number(usage.input_tokens ?? 0);
        output += Number(usage.output_tokens ?? 0);
        cacheRead += Number(usage.cache_read_input_tokens ?? 0);
        cacheCreation += Number(usage.cache_creation_input_tokens ?? 0);
      }
    } catch (e) {
      log(`transcript line parse failed: ${e}`);
    }
  }

  const newOffset = size - partialLen;
  writeOffset(offsetPath, { offset: newOffset, size_at_offset: size });

  if (assistantTurns > 0) {
    // Same env-or-session-lookup fallback as PostToolUse — see the long
    // comment in handlePostToolUse for the why. PIPELINE_RUN_ID is not
    // propagated to Stop hook subprocesses on Paths B/C, so without the
    // session lookup turn.usage events stamp run_id=null and the per-run
    // token totals stay at zero.
    // Explicit runId override (even when null) seals the same empty-
    // string env leak as the PostToolUse path — see the comment in
    // handlePostToolUse's `else` branch.
    const resolved = resolveBindingFromEnvOrSession(sessionId || null, projectRoot);
    appendEvent(
      projectRoot,
      worktree,
      "turn.usage",
      {
        assistant_turns: assistantTurns,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_creation_tokens: cacheCreation,
        // ux-v2 b7: on the driven path this Stop hook fires INSIDE the
        // step-executor's own `claude -p`, so the tokens it just tallied are
        // that step's — say so, instead of leaving the run to guess.
        ...stepUuidData(resolved.stepUuid),
      },
      { runId: resolved.runId },
    );
  }
}

// --------------------------------------------------------------------
// SubagentStop handler — agent-lifecycle liveness (Phase 2 headline).
//
// Fires when a subagent finishes. We care about ONE agent type: the
// `pipeline-manager`, which is the run's orchestrator. When the manager
// stops we emit a `manager.stopped` event { run_id, agent_id } — the
// PRIMARY "the run's orchestrator is gone" signal. The daemon consumes it
// for event-driven dead-run detection (a run with `pipeline.started` but a
// `manager.stopped` and NO terminal `pipeline.completed`/`halted` is
// abandoned). This is faster + more reliable than the pid-lockfile sweep,
// which remains as a secondary fallback.
//
// We resolve the run_id with the SAME session-keyed binding recovery the
// tool.called path uses (env → session binding), since the manager shares
// the run's session_id. A SubagentStop for any OTHER agent type is ignored.
// --------------------------------------------------------------------

/** Pull the stopped subagent's type from a SubagentStop payload. Claude
 *  Code's field name has varied across versions, so accept the common
 *  spellings. Returns "" when none is present. */
function subagentTypeFromPayload(payload: Record<string, unknown>): string {
  const candidates = [
    payload.agent_type,
    payload.subagent_type,
    payload.agent_name,
    payload.agentType,
    payload.subagentType,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}

function handleSubagentStop(payload: Record<string, unknown>, projectRoot: string, worktree: string | null): void {
  const agentType = subagentTypeFromPayload(payload);
  if (!MANAGER_SUBAGENT_RE.test(agentType)) return; // only the run anchor matters

  // Resolve the run via the shared-session binding recovery (env →
  // session-keyed mirror binding). The manager shares the run's session_id,
  // so the supervisor's binding (Path B) or the bypass-spawn binding
  // (Path C) recovers it. Null ⇒ we can't attribute the stop to a run;
  // skip silently (the pid-lockfile sweep is the fallback).
  const sessionId = (() => {
    const v = payload.session_id;
    return typeof v === "string" && v.length > 0 ? v : null;
  })();
  const resolved = resolveBindingFromEnvOrSession(sessionId, projectRoot);
  const runId = resolved.runId;
  if (!runId) {
    log(`SubagentStop(${agentType}): no run_id resolved, skipping manager.stopped`);
    return;
  }

  const agentId = (() => {
    const candidates = [payload.agent_id, payload.subagent_id, payload.agentId, payload.tool_use_id];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0) return c;
    }
    return null;
  })();

  appendEvent(
    projectRoot,
    worktree,
    "manager.stopped",
    { run_id: runId, agent_id: agentId, ...stepUuidData(resolved.stepUuid) },
    { runId, parentRunId: null, sessionId: null },
  );
}

// --------------------------------------------------------------------
// Notification → run.awaiting_input (design 05)
// --------------------------------------------------------------------

/** Ported from CCAM's `WAITING_INPUT_PATTERN` (`server/routes/hooks.js`,
 *  `isWaitingForUserMessage`) and kept deliberately NARROW: it must match the
 *  permission / needs-input phrasings and must NOT match the idle "Claude has
 *  finished responding"-style notifications, which are not a blocked run. */
const WAITING_INPUT_PATTERN =
  /(needs? your permission|permission to use|waiting for your input|is waiting for input|approval needed|needs? your approval|awaiting your (input|response|approval))/i;

/** `permission` when the text is about granting/approving something, else
 *  `input` — the two kinds the event contract carries. */
function awaitingKindFor(message: string): "permission" | "input" {
  return /permission|approval|approve/i.test(message) ? "permission" : "input";
}

/**
 * Classify a Notification payload into an awaiting-input kind, or null when the
 * notification does not mean "this run is blocked on a human".
 *
 * The structured `notification_type` field is the PRIMARY discriminator when
 * present, but it is frequently absent in the wild (anthropics/claude-code#11964)
 * — hence the regex fallback, and hence the deliberate absence of a hook-level
 * `notification_type` matcher in hooks.json, which would silently drop every
 * event while that issue is open.
 */
function classifyNotification(payload: Record<string, unknown>): "permission" | "input" | null {
  const type = String(payload.notification_type ?? "").trim().toLowerCase();
  if (type) {
    if (type === "permission_prompt") return "permission";
    if (type === "agent_needs_input") return "input";
    return null; // idle_prompt and everything else: not a blocked run
  }
  const message = String(payload.message ?? "");
  if (!message || !WAITING_INPUT_PATTERN.test(message)) return null;
  return awaitingKindFor(message);
}

const AWAITING_EXCERPT_MAX = 200;

/**
 * Emit `run.awaiting_input` for a notification that means a human is blocking
 * the run. No clearing event exists (no "resumed" hook signal does), so the
 * WAITING state is DERIVED downstream: any later event for the same run clears
 * it. An unresolvable run id is not a reason to drop the event — it still shows
 * in the ambient stream, it just cannot mark a run.
 */
function handleNotification(
  payload: Record<string, unknown>,
  projectRoot: string,
  worktree: string | null,
): void {
  const kind = classifyNotification(payload);
  if (kind === null) {
    log(`notification not an input wait: ${String(payload.notification_type ?? payload.message ?? "")}`);
    return;
  }
  const sessionId = String(payload.session_id ?? "") || null;
  const resolved = resolveBindingFromEnvOrSession(sessionId, projectRoot);
  appendEvent(
    projectRoot,
    worktree,
    "run.awaiting_input",
    {
      kind,
      message_excerpt: String(payload.message ?? "").slice(0, AWAITING_EXCERPT_MAX),
      // ux-v2 b7: which step is blocked, not just which run.
      ...stepUuidData(resolved.stepUuid),
    },
    { runId: resolved.runId, parentRunId: null, sessionId },
  );
}

// --------------------------------------------------------------------
// Main
// --------------------------------------------------------------------

async function main(): Promise<void> {
  // Gate ORDER is load-bearing, in BOTH directions:
  //  - the payload read is hoisted above the PIPELINE_JOURNAL_ENABLED early-return,
  //    because the Notification branch must run with the UI opted out (D2);
  //  - but the FILESYSTEM work (resolveProjectRoot + hasPipelineDirUpTo) stays
  //    BELOW it for every other event, because journalEnabled() promises an
  //    opt-out costs ~zero per hook call — and this hook fires twice per tool
  //    call. Reading stdin is cheap; walking the tree is not.
  const payload = (await readStdinJson()) ?? {};
  const eventName = String(payload.hook_event_name ?? payload.event ?? "").trim();

  const isNotification = eventName === "Notification";
  if (isNotification && !awaitingInputEnabled()) {
    log("PIPELINE_AWAITING_INPUT_ENABLED explicitly opted out — no-op");
    return;
  }
  if (!isNotification && !journalEnabled()) {
    log("PIPELINE_JOURNAL_ENABLED explicitly opted out (0/false/no/off) — no-op");
    return;
  }

  const cwd = process.cwd();
  // Resolve the project root FIRST (this also maps a git worktree to its
  // MAIN repo + records the worktree tag), then gate by walking up from
  // cwd for ANY `.pipeline` ancestor up to that root. The session
  // may sit BELOW the project root — cd'd into
  // `.pipeline/<name>/steps/…` (hand-orchestrating a pipeline) or
  // inside a worktree under `.claude/worktrees/<name>/` (Claude Code spawns
  // subagents there). Gating on a single `cwd/.pipeline` (or even
  // `project_root/.pipeline`) would miss those; the walk-up makes
  // the gate depth- and worktree-independent. Events still route to
  // project_root (the main repo for a worktree).
  const { project_root, worktree } = resolveProjectRoot(cwd);
  if (!hasPipelineDirUpTo(cwd, project_root)) {
    log(`no .pipeline from ${cwd} up to project root ${project_root}, skipping`);
    return;
  }

  if (isNotification) {
    handleNotification(payload, project_root, worktree);
    return;
  }

  if (eventName === "PreToolUse") {
    handlePreToolUse(payload, project_root, worktree);
    return;
  }
  if (eventName === "PostToolUse") {
    handlePostToolUse(payload, project_root, worktree);
    return;
  }
  if (eventName === "SubagentStop") {
    handleSubagentStop(payload, project_root, worktree);
    return;
  }
  if (eventName === "Stop") {
    handleStop(payload, project_root, worktree);
    return;
  }
  log(`unknown hook event: ${eventName}`);
}

// Exported for tests; the hook itself imports nothing from this module.
export {
  handleNotification,
  classifyNotification,
  awaitingInputEnabled,
  handlePostToolUse,
  handlePreToolUse,
  handleStop,
  handleSubagentStop,
  parseManagerSpawn,
  parseWorkerSpawn,
  subagentTypeFromPayload,
  extractRunIdFromPrompt,
  synthesizeBypassRun,
  synthesizeBypassStart,
  synthesizeBypassEnd,
  journalHasPipelineStarted,
  hasPipelineDirUpTo,
  resolveProjectRoot,
  appendMirrorBinding,
  mirrorBindingsPath,
  bypassRunIdFromToolUseId,
  findRunIdForSession,
  findBindingForSession,
  resolveBindingFromEnvOrSession,
  resolveRunIdFromEnvOrSession,
  collectTerminatedRunIds,
  pathsMatch,
  journalEnabled,
  journalTranscriptsEnabled,
  MIRROR_BINDING_SCHEMA,
  SCHEMA_VERSION,
  BINDING_MAX_AGE_MS,
  ensureTelemetryDaemonRunning,
  acquireTelemetryDaemonLock,
  telemetryDaemonLockPath,
  telemetryDaemonSyncEnabled,
  TELEMETRY_LOCK_STALE_AGE_MS,
};
export type { MirrorBinding, ParsedSpawn, TelemetryLockAcquireResult };

/**
 * `pipeline hook analytics-relay` — the subcommand entry point.
 *
 * ALWAYS RESOLVES 0. This was `if (import.meta.path === Bun.main) main()
 * .catch(…).finally(() => process.exit(0))` while the relay was a standalone
 * script; the contract it encoded is the same one here and is not a
 * formality. Claude Code reads a hook's exit code, and a non-zero one from
 * PreToolUse BLOCKS the tool call. Every failure mode of this relay —
 * unreadable payload, unwritable journal, absent project — is a reason to do
 * nothing, never a reason to interrupt the user's session.
 */
export async function runAnalyticsRelay(): Promise<number> {
  try {
    await main();
  } catch (e) {
    log(`top-level: ${e}`);
  }
  return 0;
}
