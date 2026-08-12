// `pipeline drive --root <pipeline_root> --run-id <id> --start <step-name>
//   [--default-model <m>] [--model <step_id>=<m> ...]
//   [--default-effort <level>] [--effort <step_id>=<level> ...] [--resume]
//   [--var NAME=value ...] [--vars-file <path>]
//   [--answer <text> | --answer-file <path>]
//   [--task <text> | --task-file <path>]
//   [--executor <claude-cli|claude-sdk|codex-cli>] [--executor-cmd <template>]
//   [--json]`
//
// Task delivery: generic pipelines (e.g. an implement-task template) need the
// concrete task text. `--task <text>` writes it to
// .runtime/<run_id>/task.md; `--task-file <path>` points at an existing file.
// Either way every step spawn prompt gains a `task_file = <path>` line telling
// the executor where the run's task statement lives. Persisted in
// .runtime/<run_id>/task-ref.json so --resume re-entries keep it without
// re-passing the flag.
//
// EXPERIMENTAL headless runner: executes an ENTIRE pipeline run with NO
// pipeline-manager LLM agent. It loops over the same engine `pipeline next`
// uses — invokeNext() from commands/next.ts, so state persistence, no-record
// auto-resume, in-process worktree-hook execution, and per-iteration UI-event
// auto-emission are all IDENTICAL — and actuates each returned action itself:
//
//   run-step            → spawn the step-executor as a headless subprocess (the
//                         manager-documented spawn prompt on stdin), then
//                         recover its step record through the belt-and-braces
//                         channel ladder (see execStep.runAttempt): the claude
//                         envelope's schema-validated `structured_output`, the
//                         tmp-dir DROP record file the prompt names (granted
//                         via `--add-dir {record_dir}` — headless acceptEdits
//                         on claude >= 2.1.21x auto-denies every `.claude/`
//                         write as sensitive, and `-p --agent` runs produce no
//                         structured_output at all, claude-code#20625), the
//                         legacy canonical record file, then the final-response
//                         text parsed as JSON. Whichever channel wins, drive
//                         persists the canonical `.runtime/<run>/records/` copy
//                         itself. Concurrent layers spawn all steps in
//                         parallel and fold their records into a {kind:'layer'}
//                         record. Envelope usage/cost accumulates into
//                         .runtime/<run_id>/usage.json and enriches the run's
//                         .stats/ record at the terminal action.
//   merge               → resolve the PROJECT ROOT enclosing --root (`git
//                         rev-parse --show-toplevel`; no root → halt, never
//                         merge from an arbitrary cwd), then `git merge --no-ff
//                         <branch>` sequentially from it; after each CLEAN merge
//                         the branch is safe-deleted and its worktree removed
//                         (`--force` retry once). A genuine conflict — or any
//                         other merge failure, detail-prefixed "merge failed
//                         (non-conflict):" — records conflict:true and the run
//                         halts, enumerating the still-unmerged branches.
//   run-improver /      → headless self-improvement (design 05.2), gated by
//   run-script-creator    PIPELINE_DRIVE_SELF_IMPROVE (ships OFF by default
//   retrospective         this release; `0`/unset restores the v1 skip
//                         byte-identically). When ON: pinned headless
//                         pipeline-improver / pipeline-script-creator sessions
//                         through the SAME session + crash-resume machinery as
//                         steps (session files sessions/improver-<n>.json /
//                         script-<n>.json, shared MAX_CRASH_RESUMES budget,
//                         usage folded into usage.json; templates overridable
//                         via PIPELINE_DRIVE_IMPROVER_CMD /
//                         PIPELINE_DRIVE_SCRIPT_CREATOR_CMD; requires claude
//                         >= 2.1.205 for reliable --json-schema structured
//                         output — a success envelope WITHOUT structured
//                         output takes a conservative applied:false/'refused'
//                         fallback with a warning). The retrospective is
//                         performed MECHANICALLY by drive itself: partition
//                         .feedback/<run-id>/*.md by frontmatter `category`
//                         (doc-actionable → ONE batch improver session +
//                         sequential script-creators; human-only → one-line
//                         summaries in the final JSON), emit the retro-internal
//                         improver.*/script_creator.* events plus
//                         run.retrospective / improvement.applied (paths +
//                         summaries ONLY — never file content), and delete the
//                         feedback folder on success — never on
//                         blocked/awaiting parks (which exit before the
//                         retrospective can ever fire; manager parity, 01§3.4).
//                         When improvements were applied but NO finalize hook
//                         landed them, the final JSON carries
//                         preserve_workspace:true (05 §Cloud interplay).
//                         When OFF: v1 skip — records applied:false /
//                         outcome:'refused' / done:true with a warning; the
//                         feedback folder is left in place for a manual
//                         improver pass.
//   done / halt / blocked → final JSON on stdout; exit 0 / 1 / 3.
//
// The executor spawn goes through an injectable ExecutorRunner seam. The
// default runner shells out to `claude -p --agent pipeline:step-executor
// --model {model} --plugin-dir {plugin_dir} --output-format stream-json
// --verbose --json-schema {schema}` (prompt ALWAYS via stdin; a `--flag
// {token}` pair is dropped when its token resolves to nothing). `stream-json`
// makes each tool call observable while the step runs (lib/stream-json.ts
// parses the frames as they arrive and drive emits a `step.tool` progress
// event per call); `--verbose` is REQUIRED with it — claude 2.1.222 refuses
// `-p --output-format stream-json` without it before any API call. The
// terminal `result` frame is the same envelope `--output-format json` printed,
// and remains the ONLY token/cost source. `--plugin-dir` is what keeps
// `--agent pipeline:step-executor` resolvable once Claude Code's `-p` mode
// defaults to `--bare` (execution-modes wave 5.2) — bare mode skips
// auto-discovery of plugins entirely, so the agent name would otherwise
// resolve to nothing; it expands from CLAUDE_PLUGIN_ROOT, which is set only
// when this CLI is invoked from inside the plugin (a standalone npm install
// never sees it, and the pair drops, same as `{effort}`). Because the exact
// claude flags may need per-machine adjustment, the WHOLE command template is
// overridable via `--executor-cmd` or the env var PIPELINE_DRIVE_EXECUTOR_CMD
// — a whitespace-split template in which `{model}` is substituted with the
// step's resolved model and `{schema}` with
// the compact step-record JSON Schema (lib/step-schema.ts — deliberately
// whitespace-free so it survives the split; when a token has no value, the
// token AND an immediately preceding `-`/`--` flag token are dropped).
//
// Interactive steps (needs-input): every executor session is PINNED to a
// UUID generated before the spawn and persisted in
// .runtime/<run_id>/sessions/<step_id>.json. A step that reports outcome
// "needs-input" (with a question object) parks the run: exit 4, the question
// in the final JSON, the engine untouched — and the park is JOURNALLED as an
// `awaiting_input` event ({run_id, iteration, question_id, question} — the
// @baizor/pipeline-protocol AwaitingInputData shape the cloud ingest consumes
// to set the run's parked status; e7 DEFECT-3). Re-run with
// `--resume --start <same-step> --answer "<text>"` and drive resumes the
// SAME claude session (`--resume <session-id>`) with the answer — the step
// continues from where it stopped instead of re-deriving its work; the
// re-entry's engine-emitted `iteration.started` carries `resumed:true`
// (protocol G5), which is what un-parks the run server-side. At most 3
// questions per step, then the step halts. v1 limitation: needs-input inside
// a PARALLEL layer maps to halted (parallel steps must be self-contained).
//
// Per-step permission mode: the step's `permission-mode:` frontmatter (falling
// back to the manifest's, then to `acceptEdits`) expands into the template's
// `{permissions}` token; the value `inherit` drops the flag pair so the
// machine's own settings apply.
//
// Crash-resume: an attempt that ends with NO valid record (killed process,
// network drop, garbage output) — or a step whose session file says 'running'
// because a previous drive died mid-step — is resumed via `--resume
// <session-id>` with an "interrupted, verify and continue" prompt, up to
// MAX_CRASH_RESUMES times per session; only then does the step halt.
//
// Exit codes: 0 completed · 1 halted/depth-exhausted · 2 usage error ·
// 3 blocked (a step delegated a nested blocker; resolve it, then re-run with
// `--resume --start <same-step>`) · 4 awaiting-input (a step asked a
// question; answer via `--resume --start <same-step> --answer <text>`).

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { frozenVariablesError, invokeNext } from './next';
import { addVarFlag, loadVarsFile, mergeCliVars } from '../lib/run-vars';
import type { ActionStep, LayerResultEntry, MergeBranch, NextRecord, StepRecord } from '../lib/next';
import { realGit, type GitResult, type GitRunner } from '../lib/git';
import { ensureGeneratedDir } from '../lib/generated-dir';
// c5 — --executor selection: computePlan reads the manifest's declared
// `runner:` (a1) so an absent flag can follow it (`runner: standalone` ⇒
// claude-sdk); Runner is the shared enum type, reused rather than redeclared.
import { computePlan } from '../lib/plan';
import type { Runner } from '../lib/manifest';
// c4's seams cover all three DriveDeps runner members together — the
// `--executor=claude-sdk` wiring is a spread of this, never a rebuild of one
// seam at a time (see the "no claude -p subprocess" tests in
// tests/sdk-seams.test.ts, which this selection is what makes real).
import { sdkDriveSeams } from '../lib/executors/sdk-seams';
// c6 — the codex-cli sibling to subprocessExecutor's claude-shaped stream
// reading: recovers a ClaudeEnvelope-shaped result from `codex exec --json`'s
// OWN event shape (thread.started / item.completed / turn.completed), which
// shares no frame `type` with claude's stream-json vocabulary. See
// envelopeOf and lib/executors/codex-stream.ts's header for why this is safe
// to try unconditionally, after the claude-shaped read comes up empty.
import { parseCodexJsonl } from '../lib/executors/codex-stream';
import {
  addUsage,
  emptyUsage,
  loadUsageTotals,
  parseResultObject,
  detectProviderLimit,
  type ClaudeEnvelope,
  type ProviderLimit,
} from '../lib/envelope';
import { ClaudeStreamParser, parseStream, type StreamSummary, type StreamToolCall } from '../lib/stream-json';
import {
  RECORD_OUTCOMES as RECORD_OUTCOME_LIST,
  extractQuestion,
  stepRecordSchemaJson,
  type StepQuestion,
} from '../lib/step-schema';
import {
  improverSchemaJson,
  parseImproverOutput,
  parseScriptCreatorOutput,
  scriptCreatorSchemaJson,
} from '../lib/improver-schema';
import { emitEvent, emitEventJson, registerDriveSessionBinding, resolveProjectRoot } from '../lib/event';
import { newId } from '../lib/ids';
import { cloudJsonPath, readCloudBinding, realFs as realCloudFs } from '../lib/cloud-config';
import { appOriginFor } from '../lib/department-serve';
import { telemetrySyncEnabled } from '../lib/telemetry-outbox';
import { hasPendingUploadBackoff } from '../lib/telemetry-upload';
import { tailProjectJournal } from '../lib/telemetry-tail';
import { ensureTelemetryDaemonRunning } from './telemetry-daemon';

// Re-exported for record consumers that historically imported from here.
export { extractQuestion, type StepQuestion };
import { statsEnabled, statsEnrichTokensForRun, type TokenStats } from '../lib/stats';
import { taskFileFor } from '../lib/compose-exec';
import type { GateQuestion } from '../lib/gate';
import {
  foldStepSessionTranscripts,
  readStepSession,
  readStepSessionRefs,
  type StepSession,
} from '../lib/step-transcripts';
import { parseFrontmatter } from '../lib/frontmatter';
// c2 — layer two of the provider-key defence. EVERY byte this command emits or
// persists goes through `scrub`; see lib/output-scrubber.ts and the sink
// enumeration in tests/output-scrubber-sinks.test.ts.
import { scrub, scrubWriter, scrubbedRelay } from '../lib/output-scrubber';

// Re-exported: StepSession historically lived here (launcher/tests import it).
export type { StepSession };

// ---------------------------------------------------------------------------
// The dashboard link (ux-v2 b12)
// ---------------------------------------------------------------------------

/**
 * Compose the run's dashboard URL — ENTIRELY locally: org slug from
 * `cloud.json`'s `server`/`org`, run UUID already minted by the caller
 * (`newId()`, `b1`). No server round trip (`03` D7/D8) — since D7 withdrew
 * the derived short code, there is nothing about this URL that can later
 * fail to resolve; it is correct the moment it is printed.
 *
 * The host is the control-plane API's own origin (`appOriginFor`,
 * `lib/department-serve.ts`), NOT the bare `server` string reduced to its
 * apex. That module's own header documents why, with production evidence:
 * the dashboard SPA is served from the SAME origin as `/api/v1` (e.g.
 * `https://api.ai-pipeline.dev`); the apex is the MARKETING site and has no
 * run-detail route, so a link built by stripping the `api.` label 404s.
 * Reusing that exact, already-verified function — rather than re-deriving
 * the same host a third time — is deliberate.
 */
export function composeRunLink(server: string, org: string, runId: string): string {
  return `${appOriginFor(server)}/${org}/runs/${runId}`;
}

/**
 * Best-effort, telemetry-gated run-start work: print the dashboard link (F2/
 * J2, within the first two printed lines, before step 1) and — for the SAME
 * project — ensure a background uploader exists and tail whatever the run
 * has journaled so far into the durable outbox. Everything here is LOCAL
 * ONLY (an existsSync, a JSON read, at most one detached spawn); the actual
 * network flush stays the daemon's job — see `lib/telemetry-tail.ts`'s
 * header for why, and `telemetry-upload.ts`'s own header for the rule this
 * keeps ("not inline in drive").
 *
 * F7 (`03`): with NO `.pipeline/cloud.json` at all, this prints nothing and
 * spawns nothing — checked by the caller BEFORE this is invoked, so an
 * unconnected project pays only that one `existsSync`, never this function's
 * body. `PIPELINE_SYNC_LOCAL_STATS=0` is the same "absent" gate — see
 * `runDrive`'s call site, which checks both before resolving anything else.
 */
function driveRunStartTelemetry(
  telemetryProjectRoot: string,
  runId: string,
  progress: (event: string, fields?: Record<string, unknown>) => void,
): void {
  try {
    const bindingPath = cloudJsonPath(telemetryProjectRoot);
    const binding = readCloudBinding(realCloudFs, bindingPath);
    if (binding && binding.org) {
      const link = composeRunLink(binding.server, binding.org, runId);
      const offline = hasPendingUploadBackoff(telemetryProjectRoot);
      progress('run.link', { url: link, ...(offline ? { offline: true } : {}) });
    }
  } catch {
    /* best-effort — a link failure never blocks the run */
  }
  ensureTelemetryDaemonRunning(telemetryProjectRoot);
  tailProjectJournal(telemetryProjectRoot);
}

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export interface ExecutorRequest {
  step_id: string;
  /** Session type: 'step' (absent = step, the historical default) |
   *  'improver' | 'script-creator' — lets an injected runner distinguish
   *  self-improvement spawns without parsing the prompt. */
  kind?: 'step' | 'improver' | 'script-creator';
  /** The full step-executor spawn prompt (delivered on stdin by the default runner). */
  prompt: string;
  /** The step's resolved model, or null (inherit). */
  model: string | null;
  /** The step's resolved reasoning effort, or null (inherit the session
   *  default). Passed as `claude --effort` on EVERY invocation — the flag does
   *  not persist across `--resume`, so answer deliveries re-pass it too. */
  effort: string | null;
  /** Where the executor is expected to write its {"kind":"step",…} record
   *  JSON. For STEP spawns this is a file in the run's tmp-dir record DROP
   *  directory (outside `.claude/` — writable under headless acceptEdits via
   *  the --add-dir grant); drive persists the canonical observability copy to
   *  `.runtime/<run>/records/` itself after recovery. Improver/script-creator
   *  spawns keep the canonical path (drive-written only). */
  record_file: string;
  /** The pinned claude session: fresh spawns pass `--session-id <id>`, answer
   *  deliveries pass `--resume <id>` (the same session continues).
   *
   *  WHY THE ID IS `randomUUID()` AND NOT `newId()` (ux-v2 b7, deliberate):
   *  b1/b2 routed every identity THIS PRODUCT mints through the one UUIDv7 mint
   *  point. A claude session id is not one of them — it identifies a session in
   *  a FOREIGN system (`claude --session-id`), is never an analytics key, is
   *  never indexed, and is never joined on by anything in the journal (the run
   *  and step UUIDs are what b7 propagates and what consumers key on). v7's
   *  payoff is time-ordered index locality in a namespace we own; here we own
   *  neither the namespace nor the index, while the version nibble IS the one
   *  part of the value another vendor's validator could care about. So this
   *  stays `randomUUID()` — revisit only if Claude Code documents a shape
   *  requirement that asks for something else. */
  session: { id: string; resume: boolean };
  /** Resolved --permission-mode value; null = inherit machine settings. */
  permission_mode: string | null;
}

export interface ExecutorExit {
  /** Subprocess exit code; null when the process could not be spawned. */
  code: number | null;
  /** Spawn-failure detail (code === null). */
  error?: string;
  /** Captured stdout — newline-delimited stream-json frames under the default
   *  template; absent/garbage for custom templates (fine: the caller falls
   *  back to the record file). */
  stdout?: string;
  /** The stream-json summary the default subprocess runner built WHILE the
   *  child was running (ux-v2 b6). Absent for injected fakes and any runner
   *  that only captured text — `envelopeOf` then replays `stdout` through the
   *  same parser, so both paths obey one contract. */
  stream?: StreamSummary;
}

/** The step/self-improve envelope for one executor exit. Prefers the summary
 *  the streaming parser already built (production: frames were consumed as
 *  they arrived); falls back to replaying captured stdout through the SAME
 *  parser, which also absorbs a custom template's buffered
 *  `--output-format json` object. Never throws; null = no terminal `result`,
 *  which is not by itself an error (SIGTERM/exit 143).
 *
 *  c6: when the claude-shaped read comes up empty, ALSO tries codex-cli's own
 *  event shape (lib/executors/codex-stream.ts) before giving up. This is what
 *  keeps rung 4 of the record-recovery ladder (final-response text parsed as
 *  JSON) alive for codex-cli, exactly as it already is for claude — codex's
 *  `--json` stream never carries a claude-shaped `type:"result"` frame
 *  (verified live, codex-stream.ts's header), so the claude-shaped read is
 *  ALWAYS null for a codex spawn and this fallback is what supplies one.
 *  Safe to try unconditionally on every executor (see that module's header
 *  for why the two shapes cannot collide): a claude/SDK run that already
 *  resolved an envelope never reaches this line, and a genuinely foreign
 *  stdout (a fake test executor, SIGTERM with no output) still yields null. */
export function envelopeOf(exit: ExecutorExit): ClaudeEnvelope | null {
  const claudeShaped = exit.stream !== undefined ? exit.stream.envelope : typeof exit.stdout === 'string' ? parseStream(exit.stdout).envelope : null;
  if (claudeShaped !== null) return claudeShaped;
  return typeof exit.stdout === 'string' ? parseCodexJsonl(exit.stdout) : null;
}

/** The executor seam: spawn ONE step-executor and resolve when it exits. Tests
 *  inject a fake that writes prescribed record files; production uses the
 *  template-driven subprocess runner below. */
export type ExecutorRunner = (req: ExecutorRequest) => Promise<ExecutorExit>;

export interface DriveDeps {
  executor?: ExecutorRunner;
  /** Self-improvement session runners (05.2): default is the subprocess
   *  runner with DEFAULT_IMPROVER_TEMPLATE / DEFAULT_SCRIPT_CREATOR_TEMPLATE
   *  (env-overridable) + the lib/improver-schema.ts schemas. Injectable for
   *  tests — the fakes see kind:'improver' / 'script-creator' requests. */
  improver?: ExecutorRunner;
  scriptCreator?: ExecutorRunner;
  git?: GitRunner;
  /** stdout sink (the final JSON only). */
  out?: (s: string) => void;
  /** stderr sink (progress lines + warnings + relayed executor output). */
  err?: (s: string) => void;
}

/** The vendor-qualified `--executor` values (E8/E15, c5): which
 *  `ExecutorRunner` IMPLEMENTATION runs a step. `driver` and `standalone`
 *  (01-modes.md) share this one loop and differ only in this choice, which is
 *  why it is a flag on one command rather than two command names.
 *
 *  Deliberately vendor-qualified rather than a bare `cli`: a second vendor
 *  would force renaming a released flag value, which is a migration inside
 *  somebody's CI scripts. `subagent` — the fourth Axis-2 value — is NOT a
 *  member of this type: it is the host's own Agent tool, implied by
 *  `session`/`manager`, and meaningless without a live session, which
 *  `pipeline drive` never has (see setExecutorFlag's rejection message). */
export const EXECUTOR_KINDS = ['claude-cli', 'claude-sdk', 'codex-cli'] as const;
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

// ---------------------------------------------------------------------------
// Executor command template
// ---------------------------------------------------------------------------

/** Default executor command. EXPERIMENTAL — the exact claude flags may need
 *  per-machine adjustment; override the whole template with --executor-cmd or
 *  PIPELINE_DRIVE_EXECUTOR_CMD. The prompt is always delivered on stdin.
 *  `--output-format stream-json --verbose` (ux-v2 b6) is the live-progress
 *  pair: one JSON frame per line as the step runs rather than one object at
 *  exit, and `--verbose` is not optional — claude 2.1.222 rejects
 *  `-p --output-format stream-json` without it at startup, before any API
 *  call. `--json-schema` IS compatible with it: the terminal `result` frame
 *  still carries `structured_output` (both measured for real, ux-v2 b5 probes
 *  1-2). Schemas must be JSON Schema draft-07 — an explicit draft-2020-12
 *  `$schema` is rejected at startup (b5 probe 3); lib/step-schema.ts and
 *  lib/improver-schema.ts declare no `$schema` at all, which is the
 *  implicit-draft-07 case b5 exercised end-to-end. Do not add a 2020-12 one.
 *  `{schema}` expands to the compact step-record JSON Schema (the harness
 *  validates the final response and returns it in `structured_output` — on
 *  claude versions where `-p --agent` supports it; 2.1.214 silently ignores
 *  the flag for subagent runs, so drive ALSO recovers the record from the
 *  record file and the final-response text — see execStep), `{permissions}`
 *  to the step's resolved permission mode, `{session}` to the pinned session
 *  UUID — on an answer delivery the flag preceding `{session}` is swapped to
 *  `--resume` so the SAME session continues (verified on Claude Code
 *  2.1.205) — and `{record_dir}` to the run's tmp-dir record DROP directory,
 *  granted to the executor via `--add-dir` (verified on 2.1.214: headless
 *  acceptEdits auto-DENIES every write under `.claude/` as "sensitive" — no
 *  allow rule can override it — while an --add-dir'd tmp directory is
 *  writable; this is the narrowest grant that keeps the file channel alive).
 *  `{plugin_dir}` expands to CLAUDE_PLUGIN_ROOT (execution-modes wave 5.2):
 *  `--agent pipeline:step-executor` only resolves because the plugin is
 *  auto-discovered today; once `-p` defaults to `--bare` that discovery stops
 *  and the agent name would resolve to nothing, so the plugin root is passed
 *  explicitly. Unset (a standalone npm install of the CLI, invoked outside
 *  the plugin) drops the `--plugin-dir {plugin_dir}` pair entirely — same
 *  drop-on-no-value rule as `{effort}`, not an empty string. */
export const DEFAULT_EXECUTOR_TEMPLATE =
  'claude -p --agent pipeline:step-executor --model {model} --effort {effort} --permission-mode {permissions} --session-id {session} --add-dir {record_dir} --plugin-dir {plugin_dir} --output-format stream-json --verbose --json-schema {schema}';

/**
 * Default `codex-cli` executor command (c6, E14/E15) — the Codex sibling to
 * {@link DEFAULT_EXECUTOR_TEMPLATE}, selected by `--executor=codex-cli`.
 * EXPERIMENTAL, same as the claude template; override the whole thing with
 * `--executor-cmd` or `PIPELINE_DRIVE_EXECUTOR_CMD` — both apply identically
 * to whichever CLI implementation `--executor` selected (USAGE spells out the
 * split). The prompt is always delivered on stdin, never as a positional
 * PROMPT argument — verified live (codex-cli 0.147.0) that `codex exec` reads
 * the whole piped stream as the prompt when no PROMPT arg is given, byte-for-
 * byte the same contract `subprocessExecutor` already relies on for claude.
 *
 * `codex exec` (NOT the bare interactive `codex` command — a distinction this
 * template's own construction got wrong once, see the `{permissions}`
 * paragraph below) is Codex's headless/non-interactive front door, verified
 * present via `codex exec --help` on a real, authenticated install.
 *
 * ── THE FULL PLACEHOLDER MAPPING (every token DEFAULT_EXECUTOR_TEMPLATE
 * carries — model, effort, permission mode, session, record directory,
 * structured schema — plus the two claude-only mechanisms that are not
 * tokens at all: `--agent <name>` and `{plugin_dir}`) ─────────────────────
 *
 * `{model}` — VERIFIED: `-m, --model <MODEL>` (`codex exec --help`). Mapped
 * to `--model {model}`, dropped together with the flag when null (same rule
 * as every scalar token below) so an absent model lets codex use its own
 * configured default, exactly as an absent claude `{model}` does today.
 *
 * `{effort}` — VERIFIED, but by a different route than a CLI flag: `codex
 * exec --help` has no `--effort`/`--reasoning` option, but its `-c
 * key=value` config-override mechanism does, and `model_reasoning_effort` is
 * confirmed to exist as a live config key — read directly out of this
 * machine's own `~/.codex/config.toml` (`model_reasoning_effort = "high"`),
 * not merely inferred from documentation. Mapped to `-c
 * model_reasoning_effort={effort}` — ONE whitespace-free token, so the
 * existing scalar-substitution/drop-pair logic in buildExecutorArgv applies
 * unchanged: an absent effort drops the whole `-c model_reasoning_effort=…`
 * token AND the preceding `-c`.
 *
 * `{permissions}` — APPROXIMATED, not a verified 1:1: the two CLIs gate
 * permission on different axes entirely. Claude's `--permission-mode` gates
 * an INTERACTIVE PROMPT (acceptEdits/bypassPermissions/plan/default control
 * what claude asks the human before doing); `codex exec` never prompts at
 * all — it is non-interactive by construction — and instead gates
 * FILESYSTEM/NETWORK ACCESS via `-s/--sandbox <read-only|workspace-write|
 * danger-full-access>` (VERIFIED present on `codex exec --help`). A THIRD
 * codex axis, `-a/--ask-for-approval`, looks like the obvious match for
 * "permission mode" and is not: verified LIVE that it is REJECTED on `codex
 * exec` ("error: unexpected argument '--ask-for-approval' found") — that flag
 * exists only on the top-level interactive `codex` command, a real trap this
 * template's own construction fell into once. So `{permissions}` maps to
 * `--sandbox {permissions}` alone, through {@link codexSandboxFor}'s
 * documented translation table (Claude vocabulary → the closest codex
 * sandbox level for headless execution); an unrecognised value is warned
 * about at runtime (once per distinct value) rather than silently passed
 * through as a meaningless sandbox name. `null` (the `permission-mode:
 * inherit` case) drops the flag on both templates, which means the same
 * thing on both: "whatever this machine/profile already has set".
 *
 * `{session}` — NO EQUIVALENT for pre-minting a fresh session id, VERIFIED
 * two ways: `codex exec --help` has no `--session-id`/`--resume` flag at all
 * (unlike claude, which accepts a caller-chosen UUID before the first turn
 * even starts), and a live probe confirms codex assigns its OWN id, visible
 * only in the `--json` stream's FIRST event (`{"type":"thread.started",
 * "thread_id":"…"}`) — i.e. only AFTER the turn has already begun, too late
 * to have passed it in as an argument. `codex exec resume <SESSION_ID>` does
 * exist as a genuine resume mechanism (verified via `codex exec resume
 * --help`), but using it would mean capturing and persisting codex's own
 * thread id — a SEPARATE id-space from this drive's own pinned
 * `randomUUID()` session key — which nothing here does today. So this
 * template carries NO `{session}` token at all (`appendSessionIfAbsent:
 * false` on its buildExecutorArgv call — see subprocessExecutor — stops the
 * generic "append `--session-id`/`--resume` when the template omits the
 * token" convention from handing codex a flag pair it would reject).
 * Surfaced at runtime once, at executor construction: EVERY delivery to a
 * codex-cli step — the first spawn, an --answer delivery, a crash-resume —
 * therefore runs a FRESH `codex exec` turn rather than resuming a codex
 * thread; the drive-side prompts for those deliveries (buildAnswerPrompt,
 * buildCrashResumePrompt) already re-hydrate full context from disk for
 * exactly this reason, so a fresh turn is degraded, not broken.
 *
 * `{record_dir}` — VERIFIED, a clean 1:1: `--add-dir <DIR>` (`codex exec
 * --help`), SAME flag name and SAME stated purpose ("additional directories
 * that should be writable") as claude's. Confirmed live, twice: an
 * instructed file write lands inside the granted directory under `--sandbox
 * workspace-write` even when that directory sits OUTSIDE the process's
 * working directory — the exact shape of drive's tmp-dir record DROP
 * directory (`dropRecordsDirFor`). Mapped to `--add-dir {record_dir}`,
 * identically to the claude template.
 *
 * `{schema}` — NO EQUIVALENT USED, and this is the one gap this template
 * discovered by BREAKING something rather than by an absent flag: codex
 * exec's structured-output flag, `--output-schema <FILE>` (VERIFIED present),
 * requires an OpenAI-strict JSON Schema — `additionalProperties:false` on
 * every object — and passing the shared, deliberately permissive step-record
 * schema (lib/step-schema.ts) AS-IS was reproduced live failing outright:
 * `{"type":"error","error":{"code":"invalid_json_schema","message":
 * "'additionalProperties' is required to be supplied and to be false"}}`,
 * immediately followed by `turn.failed` — not a degraded response, a failed
 * turn. Forking a strict-mode variant of the shared schema was considered and
 * rejected: it is a second schema that can silently drift from the one every
 * other channel (the record file, claude's own structured_output) already
 * agrees on, to buy a rung this template does not need — see the next
 * paragraph. So `--output-schema` is not part of this template at all, and
 * `{schema}` is never substituted for codex-cli.
 *
 * `--agent pipeline:step-executor` (a fixed flag, not a token) and its
 * dependent `{plugin_dir}` — NO EQUIVALENT: verified that `codex exec --help`
 * names no per-invocation persona/subagent-selection flag (`codex plugin` is
 * a marketplace install/list mechanism, not a per-spawn selector — `codex
 * plugin --help` confirms its subcommands are `add`/`list`/`marketplace`/
 * `remove`), so there is nothing for `{plugin_dir}` — which exists ONLY to
 * make `--agent <name>` resolvable once claude defaults to `--bare` — to
 * plug into either. Neither appears in this template; the step-executor
 * protocol reaches codex through the spawn prompt text alone
 * (buildStepPrompt), which is already vendor-neutral.
 *
 * ── WHY THE RETAINED FALLBACK LADDER STILL APPLIES DESPITE {schema} BEING
 * UNUSED ─────────────────────────────────────────────────────────────────
 *
 * `{schema}`'s absence removes rung 1 (harness-validated `structured_output`)
 * only. Rungs 2 and 3 — the tmp-dir DROP record file this template's
 * `--add-dir {record_dir}` grants, and the legacy canonical path — are
 * PROMPT-level contracts (the spawn prompt instructs the executor to write
 * `step_record_file`, independent of any CLI vendor) and were verified live
 * to work for codex exactly as documented: an instructed write lands exactly
 * where asked. Rung 4 (the final-response text, parsed as JSON) is ALSO kept
 * alive for codex-cli — `envelopeOf` (this file) falls back to
 * `lib/executors/codex-stream.ts`'s codex-shaped stream reader whenever the
 * claude-shaped one comes up empty, recovering the LAST `agent_message`
 * item's text as the envelope's `result`, the same field `parseResultObject`
 * already reads for claude. So three of the four rungs — the three that do
 * not depend on `--json-schema`/`--output-schema` succeeding — are retained
 * for codex-cli exactly as claude already relies on them.
 *
 * ── WHAT THIS TEMPLATE DOES NOT ATTEMPT ─────────────────────────────────────
 *
 * Live per-tool-call progress (`step.tool` events): `ClaudeStreamParser`
 * discriminates claude's OWN frame shapes (`assistant`/`user` messages
 * carrying `tool_use` blocks) and is not extended here to also recognise
 * codex's `item.started`/`item.completed` shapes — a codex-cli run therefore
 * emits no `step.tool` progress lines. Not a DoD requirement and not
 * attempted; recorded here so it reads as a scoped omission, not an oversight.
 *
 * `--skip-git-repo-check` is included unconditionally: verified live that
 * `codex exec` otherwise refuses to run outside a git repository, a
 * requirement claude has never had — included so a pipeline root that is not
 * itself a git repo behaves the same under either executor.
 */
export const DEFAULT_CODEX_EXECUTOR_TEMPLATE =
  'codex exec --json --skip-git-repo-check --model {model} -c model_reasoning_effort={effort} --sandbox {permissions} --add-dir {record_dir}';

/** Claude `--permission-mode` values this repo's own templates/docs name
 *  (agents/step-executor.md, PIPELINE.md frontmatter) — used only to decide
 *  whether {@link codexSandboxFor} is translating a KNOWN value or guessing at
 *  an unrecognised one; not a validation gate (an unlisted value still maps,
 *  just with a runtime warning — see codexPermissionModeMapper below). */
const KNOWN_CLAUDE_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'default',
]);

/**
 * Translate a resolved claude `--permission-mode` value into the closest
 * codex-cli `--sandbox` value (see DEFAULT_CODEX_EXECUTOR_TEMPLATE's
 * `{permissions}` paragraph for why this is an APPROXIMATION, not a verified
 * equivalence — the two CLIs gate different things). `null` (the
 * `permission-mode: inherit` case) passes through as `null`, dropping the
 * `--sandbox` flag exactly as an inherited claude permission mode drops
 * `--permission-mode` — "use whatever this machine/profile already has set"
 * means the same thing on both templates.
 *
 * `'acceptEdits'` → `'workspace-write'`: the headless default on both sides —
 * a session that cannot prompt still needs to write its own workspace.
 * `'bypassPermissions'` → `'danger-full-access'`: the no-gate-at-all case on
 * both sides. `'plan'` → `'read-only'`: claude's plan mode never edits;
 * codex's read-only sandbox cannot either. `'default'` → `'workspace-write'`:
 * claude's interactive default normally prompts per action, which `codex
 * exec` cannot do at all (it never prompts, full stop — see the
 * `{permissions}` paragraph's `--ask-for-approval` finding), so the
 * non-degenerate headless choice is the same one `acceptEdits` gets. Any
 * OTHER value (a custom `permission-mode:` string this repo does not itself
 * define) also falls back to `'workspace-write'` — never `'read-only'`, which
 * would silently turn a step that expects to edit into one that cannot.
 */
export function codexSandboxFor(claudeMode: string | null): string | null {
  if (claudeMode === null) return null;
  switch (claudeMode) {
    case 'acceptEdits':
      return 'workspace-write';
    case 'bypassPermissions':
      return 'danger-full-access';
    case 'plan':
      return 'read-only';
    case 'default':
    default:
      return 'workspace-write';
  }
}

/**
 * Build a `permissionModeFor` mapper for `subprocessExecutor`'s codex-cli
 * branch: applies {@link codexSandboxFor}, and — the "degrade loudly" half of
 * that translation — warns ONCE PER DISTINCT unrecognised claude
 * permission-mode value it is ever asked to translate, never once per spawn
 * (a pipeline whose every step shares one custom `permission-mode:` string
 * would otherwise repeat the identical warning on every single step).
 * Recognised values ({@link KNOWN_CLAUDE_PERMISSION_MODES}) and `null`
 * (inherit) translate silently — codexSandboxFor's own doc already explains
 * those, so there is nothing this closure needs to add.
 */
function codexPermissionModeMapper(err: (s: string) => void): (mode: string | null) => string | null {
  const warned = new Set<string>();
  return (mode) => {
    const mapped = codexSandboxFor(mode);
    if (mode !== null && !KNOWN_CLAUDE_PERMISSION_MODES.has(mode) && !warned.has(mode)) {
      warned.add(mode);
      err(
        `pipeline drive: codex-cli has no --sandbox mapping for permission-mode '${mode}' ` +
          `(recognised: ${[...KNOWN_CLAUDE_PERMISSION_MODES].join(', ')}) — falling back to ` +
          `'${mapped}', the same headless default 'acceptEdits' gets.\n`,
      );
    }
    return mapped;
  };
}

/**
 * One warning line per codex-cli template mechanism that has NO direct
 * claude-template equivalent — the c6 counterpart to sdk-seams.ts's
 * `sdkSeamOverrideWarnings`: emitted ONCE per run, at executor construction
 * (see runDrive's executor-selection block), never per spawn, following the
 * SAME "state the gap once, in the run's own output, rather than emit a
 * command that quietly means something else" rule c4 established for the SDK
 * executor's inapplicable template overrides.
 *
 * Each line names WHAT has no equivalent, WHY (the verified evidence, not an
 * assumption), and WHAT the template does instead — the three things a reader
 * who set `--executor=codex-cli` needs, same bar sdkSeamOverrideWarnings
 * holds itself to.
 */
export function codexTemplateGapWarnings(): string[] {
  return [
    "pipeline drive: codex-cli has no equivalent to claude's --agent <name> (and " +
      'therefore none to the {plugin_dir} token, which exists only to make --agent ' +
      'resolvable once claude defaults to --bare) — verified: `codex exec --help` names ' +
      'no per-invocation persona/subagent flag, and `codex plugin` is a marketplace ' +
      'install/list mechanism, not a per-spawn selector. The step-executor protocol ' +
      'reaches codex through the spawn prompt text alone.',
    'pipeline drive: codex-cli does not use --output-schema for the step record — ' +
      "verified: codex exec's structured-output mode requires a STRICT JSON Schema " +
      '(additionalProperties:false on every object) and the shared step-record schema ' +
      '(lib/step-schema.ts) is deliberately permissive; passing it as-is was reproduced ' +
      'live failing with an invalid_json_schema error and a failed turn. The record is ' +
      'recovered from the record file and the final-response text instead — the SAME ' +
      "fallback channels the claude template already relies on for claude's own " +
      '-p --agent structured_output gap (claude-code#20625).',
    'pipeline drive: codex-cli never resumes a codex thread — verified: `codex exec` has ' +
      'no --session-id flag to pre-mint a session id (codex assigns its own, visible only ' +
      "in the --json stream's thread.started event AFTER a turn starts); `codex exec " +
      'resume <id>` exists but needs that id captured and persisted first, which this ' +
      'template does not do. Every delivery to a codex-cli step — the first spawn, an ' +
      '--answer delivery, a crash-resume — runs a NEW codex exec turn, with full context ' +
      're-supplied via the prompt text.',
  ];
}

export interface ExecutorArgvOpts {
  session?: { id: string; resume: boolean };
  permissionMode?: string | null;
  /** The step's resolved reasoning effort — `{effort}` token. Null/absent
   *  drops the `--effort {effort}` pair (inherit the session default). */
  effort?: string | null;
  /** The run's record DROP directory — `{record_dir}` token (the `--add-dir`
   *  grant that keeps the record-file channel writable under headless
   *  acceptEdits). Null/absent drops the pair; a template WITHOUT the token
   *  gets `--add-dir <dir>` appended (same convention as `{session}` — custom
   *  claude wrappers must forward unknown flags; fakes ignore argv). */
  recordDir?: string | null;
  /** The plugin install root — `{plugin_dir}` token (the `--plugin-dir` pair
   *  that keeps `--agent pipeline:step-executor` resolvable once `-p`
   *  defaults to `--bare`; execution-modes wave 5.2). Resolved from
   *  CLAUDE_PLUGIN_ROOT by the caller. Null/absent — a standalone npm install
   *  of the CLI never has that env var set — drops the pair, the SAME
   *  plain-scalar rule as `{effort}`: unlike `{session}`/`{record_dir}` it is
   *  NOT appended to a template that omits the token, so a user's
   *  `--executor-cmd` override is unaffected by this flag's existence. */
  pluginDir?: string | null;
  /** c6: when `false`, a template WITHOUT a `{session}` token does NOT get
   *  `--session-id`/`--resume <id>` appended. Default `true` (the original
   *  claude behaviour — see the {session} handling below) so every existing
   *  caller and template is unaffected. codex-cli's default template passes
   *  `false`: `codex exec` has no `--session-id`/`--resume` flags at all
   *  (verified: absent from `codex exec --help`; `--resume` is a top-level
   *  claude-only flag), so appending them would hand codex an argument it
   *  rejects outright rather than a value it ignores. See
   *  DEFAULT_CODEX_EXECUTOR_TEMPLATE's comment for the fuller session gap. */
  appendSessionIfAbsent?: boolean;
}

/**
 * Expand a command template into an argv. Whitespace-split (paths with spaces
 * are not supported in templates — this is an experimental headless seam).
 * Tokens: `{model}` → the step's resolved model, `{effort}` → the step's
 * resolved reasoning effort, `{schema}` → the compact (whitespace-free)
 * step-record schema, `{permissions}` → the resolved permission mode,
 * `{session}` → the pinned session UUID, `{plugin_dir}` → CLAUDE_PLUGIN_ROOT.
 * When a token has NO value, the token is dropped along with an immediately
 * preceding `-`/`--` flag token so the pair disappears together. Session
 * special cases: when resuming, the flag token immediately preceding
 * `{session}` is REPLACED with `--resume`; a template WITHOUT a `{session}`
 * token gets the session pair appended (custom claude wrappers must forward
 * unknown flags; fakes ignore argv entirely) — UNLESS
 * `opts.appendSessionIfAbsent === false` (c6: codex-cli, whose `codex exec`
 * has no `--session-id`/`--resume` flags to append at all).
 */
export function buildExecutorArgv(
  template: string,
  model: string | null,
  schema?: string | null,
  opts: ExecutorArgvOpts = {},
): string[] {
  const argv: string[] = [];
  let sawSession = false;
  let sawRecordDir = false;
  const dropPair = (): void => {
    if (argv.length && argv[argv.length - 1].startsWith('-')) argv.pop();
  };
  // Scalar tokens all follow the same rule: substitute when a value resolved,
  // otherwise drop the token AND its preceding flag. {session} stays a special
  // case (resume swaps the preceding flag to --resume; appended when absent),
  // and {record_dir} is appended when absent too (the --add-dir grant must
  // reach a custom claude template that predates the token).
  const scalars: Record<string, string | null | undefined> = {
    '{model}': model,
    '{effort}': opts.effort,
    '{schema}': schema,
    '{permissions}': opts.permissionMode,
    '{record_dir}': opts.recordDir,
    '{plugin_dir}': opts.pluginDir,
  };
  for (const t of template.split(/\s+/).filter(Boolean)) {
    const token = Object.keys(scalars).find((k) => t.includes(k));
    if (token !== undefined) {
      if (token === '{record_dir}') sawRecordDir = true;
      const value = scalars[token];
      if (value === null || value === undefined || value === '') dropPair();
      else argv.push(t.replaceAll(token, value));
    } else if (t.includes('{session}')) {
      sawSession = true;
      const s = opts.session;
      if (!s) {
        dropPair();
        continue;
      }
      if (s.resume && argv.length && argv[argv.length - 1].startsWith('-')) argv[argv.length - 1] = '--resume';
      argv.push(t.replaceAll('{session}', s.id));
    } else {
      argv.push(t);
    }
  }
  if (!sawSession && opts.session && opts.appendSessionIfAbsent !== false) {
    argv.push(opts.session.resume ? '--resume' : '--session-id', opts.session.id);
  }
  if (!sawRecordDir && opts.recordDir) {
    argv.push('--add-dir', opts.recordDir);
  }
  return argv;
}

/** Quote one argv token for the Windows cmd.exe fallback: the schema JSON
 *  carries double quotes that a naive space-join would shear. Wrap-and-escape
 *  (CommandLineToArgvW rules: \" is a literal quote inside a quoted region);
 *  our controlled tokens contain no trailing backslashes or cmd metachars. */
export function quoteForShell(arg: string): string {
  return /[\s"]/.test(arg) ? '"' + arg.replaceAll('"', '\\"') + '"' : arg;
}

/** Resolve the `{plugin_dir}` token from CLAUDE_PLUGIN_ROOT. Set only when
 *  this CLI is invoked from inside the plugin (skills/agents spawn `pipeline
 *  drive` with that env var already in their process environment, inherited
 *  by claude's own subprocess spawn); a standalone npm install invoked
 *  directly from a terminal never has it, and null here is what makes
 *  buildExecutorArgv drop the `--plugin-dir {plugin_dir}` pair instead of
 *  expanding it to an empty string. Exported for tests. */
export function pluginDirToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.CLAUDE_PLUGIN_ROOT;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Cap on the raw stdout a spawn retains (the TAIL). Diagnostics only — the
 *  streaming parser holds everything that matters, so this bound cannot cost a
 *  record: the terminal `result` is the LAST thing a stream prints, and the
 *  buffered-envelope fallback scans from the end too. */
const MAX_CAPTURED_STDOUT = 1024 * 1024;

/** The production ExecutorRunner: spawn the templated command, write the prompt
 *  to stdin, and PARSE STDOUT AS IT ARRIVES (ux-v2 b6) — the default template
 *  emits `--output-format stream-json --verbose`, one JSON frame per line, so
 *  each tool call is observable while the step is still running instead of
 *  only after it exits. Resolves with the exit code, the captured text (custom
 *  templates / debugging) and the stream summary the parser built live.
 *
 *  What reaches the drive stderr sink changed with the format: relaying every
 *  frame verbatim would bury the run's own progress lines under the model's
 *  full transcript, so `onToolCall` surfaces ONE `step.tool` progress event per
 *  tool call (subagent-attributed) and only non-JSON chatter — a wrapper
 *  script's own output, the one thing the parser cannot interpret — is passed
 *  through untouched. The child's stderr is relayed verbatim as before.
 *
 *  Never throws — spawn failures resolve as {code:null, error}. */
/** c6: the two ways the codex-cli flavour of `subprocessExecutor` differs
 *  from the claude-cli/default one — both explained at length on
 *  DEFAULT_CODEX_EXECUTOR_TEMPLATE and codexSandboxFor. Omitted (undefined)
 *  for claude-cli and every custom `--executor-cmd` template, which keeps
 *  their behaviour byte-identical to before this option existed. */
interface SubprocessExecutorOptions {
  /** Translate a resolved permission_mode value before it reaches
   *  buildExecutorArgv's {permissions} substitution. Identity when absent. */
  permissionModeFor?: (mode: string | null) => string | null;
  /** Forwarded to buildExecutorArgv's ExecutorArgvOpts — see its doc for why
   *  codex-cli needs `false` here. */
  appendSessionIfAbsent?: boolean;
}

function subprocessExecutor(
  template: string,
  schema: string | null,
  err: (s: string) => void,
  onToolCall?: (req: ExecutorRequest, call: StreamToolCall) => void,
  options: SubprocessExecutorOptions = {},
): ExecutorRunner {
  const pluginDir = pluginDirToken();
  return (req) =>
    new Promise<ExecutorExit>((done) => {
      const argv = buildExecutorArgv(template, req.model, schema, {
        session: req.session,
        permissionMode: options.permissionModeFor ? options.permissionModeFor(req.permission_mode) : req.permission_mode,
        effort: req.effort,
        pluginDir,
        // The --add-dir record grant applies to STEP executors only — their
        // record_file lives in the run's tmp drop dir (see runDrive). The
        // improver/script-creator record files are drive-written observability
        // copies; those sessions never write them, so no grant is needed.
        recordDir: (req.kind ?? 'step') === 'step' ? dirname(req.record_file) : null,
        appendSessionIfAbsent: options.appendSessionIfAbsent,
      });
      if (argv.length === 0) {
        done({ code: null, error: 'executor command template expanded to an empty argv' });
        return;
      }
      let settled = false;
      let outBuf = '';
      // c2 — the child's stderr arrives in OS-sized chunks, so a key could
      // straddle a boundary and match neither half. `scrubbedRelay` holds the
      // trailing partial line back until its newline arrives; `err` is already
      // scrub-wrapped, so this is reassembly on top of redaction, not instead
      // of it. Rebuilt with `stream` on the Windows shell retry, and FLUSHED on
      // every terminal path below — an unflushed carry is lost output.
      let stderrRelay = scrubbedRelay(err);
      // Fed chunk-by-chunk below; rebuilt if the Windows shell retry fires so
      // a half-read stream can never leak into the retry's summary.
      let stream = new ClaudeStreamParser({
        onToolCall: (call) => onToolCall?.(req, call),
        onNonJson: (line) => err(line + '\n'),
      });
      const finish = (r: ExecutorExit) => {
        if (!settled) {
          settled = true;
          done(r);
        }
      };
      const launch = (useShell: boolean) => {
        // Shell path: build ONE pre-quoted command line — node's shell:true
        // joins an args array with bare spaces, which would break the schema
        // JSON's quotes inside cmd.exe.
        // Executor retry environment (08.4): set defaults that may be overridden
        // via template/env (only override absent values).
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          CLAUDE_CODE_RETRY_WATCHDOG: process.env.CLAUDE_CODE_RETRY_WATCHDOG ?? '1',
          CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES ?? '15',
        };
        // ux-v2 b8 / T18: `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT` enables the same
        // subagent-text/thinking forwarding as `--forward-subagent-text` —
        // NEITHER of which this template ever passes — and a child inherits it
        // from whatever shell launched `pipeline drive` (CI images export
        // things). Not setting the flag is therefore not sufficient: the
        // variable must be deleted from the CHILD's environment explicitly, not
        // merely left unset in this process (`...process.env` above would
        // otherwise carry it straight through). This covers all three
        // spawn-templated sessions this function runs (step-executor, improver,
        // script-creator) and both the direct and shell-retry launch paths
        // below, since `env` is built once and reused by both.
        delete env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT;
        const child = useShell
          ? spawn(argv.map(quoteForShell).join(' '), {
              stdio: ['pipe', 'pipe', 'pipe'],
              shell: true,
              windowsHide: true,
              env,
            })
          : spawn(argv[0], argv.slice(1), {
              stdio: ['pipe', 'pipe', 'pipe'],
              shell: false,
              windowsHide: true,
              env,
            });
        child.stdout?.on('data', (d: unknown) => {
          const text = String(d);
          outBuf += text;
          // stream-json is UNBOUNDED where one buffered envelope was not — a
          // long step emits a frame per turn, per tool call and per thinking
          // tick. Correctness no longer depends on this buffer (the parser
          // below already consumed every frame), so keep only a TAIL for
          // diagnostics and for the injected-fake path that re-reads `stdout`.
          if (outBuf.length > MAX_CAPTURED_STDOUT) outBuf = outBuf.slice(-MAX_CAPTURED_STDOUT);
          // Live: frames are discriminated here, mid-run, not after the exit.
          stream.push(text);
        });
        child.stderr?.on('data', (d: unknown) => stderrRelay(String(d)));
        child.on('error', (e: unknown) => {
          // Windows: `claude` installs as a .cmd shim that only a shell can
          // launch — retry ONCE through the shell before giving up. Direct
          // spawn stays the default (no extra cmd.exe per step).
          if (!useShell && process.platform === 'win32') {
            outBuf = '';
            stderrRelay.flush();
            stderrRelay = scrubbedRelay(err);
            stream = new ClaudeStreamParser({
              onToolCall: (call) => onToolCall?.(req, call),
              onNonJson: (line) => err(line + '\n'),
            });
            launch(true);
            return;
          }
          stderrRelay.flush();
          finish({ code: null, error: e instanceof Error ? e.message : String(e) });
        });
        child.on('close', (code: number | null) => {
          // A failed direct spawn also emits close(-1/null) after error — only
          // settle from the attempt that actually ran (finish() dedupes anyway).
          if (child.pid !== undefined || useShell) {
            // A stream cut short by SIGTERM (exit 143) simply has no terminal
            // `result` frame — end() closes it without inventing an error.
            stream.end();
            stderrRelay.flush();
            finish({ code, stdout: outBuf, stream: stream.summary() });
          }
        });
        child.stdin?.on('error', () => {}); // a dead child mustn't crash the driver on EPIPE
        if (child.pid !== undefined) {
          child.stdin?.write(req.prompt);
          child.stdin?.end();
        }
      };
      launch(false);
    });
}

// ---------------------------------------------------------------------------
// Per-step session state (.runtime/<run_id>/sessions/<step_id>.json)
// StepSession + readStepSession live in lib/step-transcripts.ts (the terminal
// stats fold reads the same files) — drive is the writer.
// ---------------------------------------------------------------------------

/** At most this many needs-input questions per step; the next one halts the
 *  step (an executor that keeps asking is not making progress). */
export const MAX_QUESTIONS_PER_STEP = 3;

/** At most this many crash-resumes per step session: an attempt that ends with
 *  NO valid record (killed process, network drop, garbage output) is resumed
 *  with a "you were interrupted" prompt — the transcript is on disk, so the
 *  executor continues instead of re-deriving its work — then the step halts
 *  as before once the budget is spent. */
export const MAX_CRASH_RESUMES = 2;

function writeStepSession(sessionsDir: string, stepId: string, s: StepSession): void {
  try {
    writeFileSync(join(sessionsDir, `${stepId}.json`), scrub(JSON.stringify(s, null, 2)), 'utf8');
  } catch {
    // best-effort — a lost session file degrades to a fresh spawn next time
  }
}

// ---------------------------------------------------------------------------
// Per-step permission mode (frontmatter)
// ---------------------------------------------------------------------------

/** Resolve a step's --permission-mode: the step's `permission-mode:`
 *  frontmatter, else the manifest's, else 'acceptEdits' (a headless run that
 *  cannot prompt aborts on the first un-allowed edit otherwise). The value
 *  'inherit' resolves to null — no flag is passed and the machine's own
 *  settings apply. Read at spawn time (drive-only concern; the plan/engine
 *  stay untouched). */
export function resolvePermissionMode(stepPath: string, pipelineRootAbs: string): string | null {
  const fm = (p: string): string | null => {
    try {
      const v = parseFrontmatter(readFileSync(p, 'utf8')).fields['permission-mode'];
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    } catch {
      return null;
    }
  };
  const stepAbs = isAbsolute(stepPath) ? stepPath : join(pipelineRootAbs, stepPath);
  const mode = fm(stepAbs) ?? fm(join(pipelineRootAbs, 'PIPELINE.md')) ?? 'acceptEdits';
  return mode === 'inherit' ? null : mode;
}

// ---------------------------------------------------------------------------
// Spawn prompt (EXACT manager-documented template — agents/pipeline-manager.md
// "run-step"). Keep byte-compatible with the manager's prompt shape.
// ---------------------------------------------------------------------------

export function buildStepPrompt(
  step: ActionStep,
  runId: string,
  pipelineRootAbs: string,
  recordFile: string,
  taskFile?: string | null,
): string {
  let prompt = `Execute pipeline iteration: ${step.path}

run_id = ${runId}
pipeline_root = ${pipelineRootAbs}
step_record_file = ${recordFile}
${taskFile ? `task_file = ${taskFile}\n` : ''}
Follow the step-executor protocol: read the file, execute its Steps, verify its
Success Criteria, and end with a structured Step Executor Final Report. Do not
auto-load PIPELINE.md unless the iteration's Context references it. Never spawn
a pipeline-manager or step-executor and never advance the chain yourself — chain
hand-offs go through your final report to me (the pipeline-manager). Spawning an
iteration-instructed helper for this step's own work is allowed per your
"Intra-step fan-out" rules. Immediately before your final report, write your
machine-readable step record JSON to step_record_file (your "Step record file"
protocol).

As you execute, journal any problems you hit (doc-flaw / ambiguity / script-candidate /
project-issue / env / friction) as individual files under
${pipelineRootAbs}/.feedback/${runId}/ per the step-executor's "Problem journal
(Tier-2 feedback)" protocol. I created that folder at run start.

You are running headless: your FINAL response is parsed as your step record —
end with EXACTLY the step-record JSON object (same fields as your
step_record_file protocol), no prose and no code fences around it; prose
belongs in its "summary" field. Write step_record_file as usual too, at the
EXACT path given above (it may live outside the pipeline tree — that location
is pre-authorized for your Write tool): the driver prefers the
harness-validated structured response, then the record file, then your final
response.

If you cannot proceed because information is MISSING and cannot be discovered
with your tools (a credential, a human decision between valid alternatives, an
unknown external fact), report outcome "needs-input" with a question object
{text, context, options?} — context must summarize what you already did and
found, so the answerer can decide. Your session will be resumed with the
answer and you continue from where you stopped. Never ask what you can find
out yourself; at most ${MAX_QUESTIONS_PER_STEP} questions per step.
`;
  if (taskFile) {
    prompt += `
This run carries a concrete task statement at task_file (see header above).
Read it FIRST — it is the caller's actual request; the iteration file is the
generic procedure to apply to it.
`;
  }
  if (step.external_worktree === true) {
    prompt += `
external_worktree: true
The run's external worktree is at ${step.worktree_path ?? '<unknown>'}; its env file is ${
      step.worktree_env_file ?? '<none>'
    }. cd there and source it per the iteration's Context.
`;
  }
  // §6.3 script-failure fallback dispatch: the ONE extra line the manager doc
  // appends (agents/pipeline-manager.md "Script-failure fallback run-step") so
  // the executor runs its fallback protocol (agents/step-executor.md).
  if (step.fallback === 'script-failure' && step.failure_record) {
    prompt += `
This step's script failed; failure record at ${step.failure_record}; achieve the iteration's Goal per your fallback protocol.
`;
  }
  return prompt;
}

/** The prompt delivered when the pinned session is RESUMED with the answer to
 *  its needs-input question. Repeats step_record_file (and pipeline_root, for
 *  wrappers/compacted sessions) so the executor never has to dig them out of
 *  the earlier conversation — and so an older session parked before a CLI
 *  upgrade is re-pointed at the CURRENT record path. */
export function buildAnswerPrompt(answer: string, recordFile: string, pipelineRootAbs: string): string {
  return `Answer to your question: ${answer}

pipeline_root = ${pipelineRootAbs}
step_record_file = ${recordFile}

Continue executing the iteration from where you stopped, using this answer.
Same protocol as before: verify the Success Criteria, write your step record
to step_record_file (the EXACT path above), and end with the step-record JSON
object as your final response (no prose around it). If the answer is
insufficient you may ask again (outcome "needs-input"), but the per-step
question limit still applies.
`;
}

/** The prompt delivered when a session is resumed after an INTERRUPTION (the
 *  executor process died, or a previous drive was killed mid-step): the
 *  transcript survived on disk, so the executor verifies and continues
 *  instead of a fresh spawn re-deriving everything. */
export function buildCrashResumePrompt(recordFile: string, pipelineRootAbs: string): string {
  return `Your session was interrupted before a valid step record was produced.

pipeline_root = ${pipelineRootAbs}
step_record_file = ${recordFile}

Re-verify the current state of your work (files, commands, Success Criteria),
finish anything incomplete, and report as usual: write your step record to
step_record_file (the EXACT path above) and end with the step-record JSON
object as your final response (no prose around it). If the iteration's work
was already complete before the interruption, just verify and report.
`;
}

// ---------------------------------------------------------------------------
// Headless self-improvement (design 05.2, P3) — templates, gate, prompts
// ---------------------------------------------------------------------------

/** The P3 rollout gate (05.2.4, owner decision Q3): headless self-improvement
 *  ships OFF by default this release. Enabled only when
 *  PIPELINE_DRIVE_SELF_IMPROVE is set to something other than
 *  ''/'0'/'false'/'off'/'no'; `=0` (or unset) restores the v1 skip sites
 *  byte-identically. */
export function selfImproveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PIPELINE_DRIVE_SELF_IMPROVE;
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== '' && t !== '0' && t !== 'false' && t !== 'off' && t !== 'no';
}

/** Default improver command (05.2.1). No {model}/{effort} tokens: the
 *  pipeline-improver agent definition pins Opus + max effort itself (a
 *  per-spawn model would downgrade it — manager parity). acceptEdits because a
 *  headless session cannot answer permission prompts and the improver's blast
 *  radius is the pipeline tree. `{plugin_dir}` is the same `--agent`-survives-
 *  `--bare` grant as the step-executor template (execution-modes wave 5.2) —
 *  dropped, not emptied, when CLAUDE_PLUGIN_ROOT is unset. The WHOLE template
 *  is overridable via PIPELINE_DRIVE_IMPROVER_CMD. Requires claude >= 2.1.205
 *  for reliable --json-schema structured output (older versions silently
 *  produce unstructured output — drive falls back to applied:false with a
 *  warning). */
export const DEFAULT_IMPROVER_TEMPLATE =
  'claude -p --agent pipeline:pipeline-improver --permission-mode acceptEdits --session-id {session} --plugin-dir {plugin_dir} --output-format stream-json --verbose --json-schema {schema}';

/** Default script-creator command — the improver template's twin
 *  (PIPELINE_DRIVE_SCRIPT_CREATOR_CMD overrides). */
export const DEFAULT_SCRIPT_CREATOR_TEMPLATE =
  'claude -p --agent pipeline:pipeline-script-creator --permission-mode acceptEdits --session-id {session} --plugin-dir {plugin_dir} --output-format stream-json --verbose --json-schema {schema}';

/** Feedback categories the retrospective feeds to the batch improver: the
 *  three general doc-actionable categories plus 'script-failure' (written only
 *  in the script-failure fallback; DOC-ACTIONABLE like doc-flaw —
 *  step-executor.md "File shape", pipeline-improver.md batch-mode contract). */
export const DOC_ACTIONABLE_CATEGORIES: ReadonlySet<string> = new Set([
  'doc-flaw',
  'ambiguity',
  'script-candidate',
  'script-failure',
]);

/** HUMAN-ONLY feedback categories — summarized for the human in the final
 *  JSON, NEVER auto-improved (manager parity). */
export const HUMAN_ONLY_CATEGORIES: ReadonlySet<string> = new Set(['project-issue', 'env', 'friction']);

/** One-line summary of a feedback problem file: the first non-empty,
 *  non-heading body line, truncated. This single line (plus the file PATH) is
 *  all that ever leaves the file — events and the final JSON never carry file
 *  content (privacy tier, 07). */
export function feedbackSummaryLine(raw: string): string {
  for (const line of parseFrontmatter(raw).body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('---')) continue;
    return t.length > 200 ? t.slice(0, 200) + '…' : t;
  }
  return '(empty problem file)';
}

const IMPROVER_HEADLESS_NOTE = `
You are running headless: your session was started with a JSON schema, and your
FINAL response is parsed as your improver record. End with exactly one JSON
object {"applied": true|false, "script_creation_briefs": [...], "summary":
"<one line>"|null}: applied=false when you refuse; script_creation_briefs is
the (possibly empty) LIST of confirmed script-extraction briefs, each entry the
self-contained brief text; prose belongs in "summary".
`;

const SCRIPT_CREATOR_HEADLESS_NOTE = `
You are running headless: your session was started with a JSON schema, and your
FINAL response is parsed as your script-creator record. End with exactly one
JSON object {"outcome": "created"|"updated"|"converted"|"repaired"|"refused",
"script_path": "<abs>"|null, "summary": "<one line>"|null} — the same outcome
your Script Creator Final Report states, verbatim; script_path null on refusal.
`;

/** Tier-1 improver spawn prompt: the step's verbatim improvement brief plus
 *  the manager-documented source-iteration line (the executor may have read a
 *  rendered copy, so brief paths can point there — the improver edits the
 *  SOURCE; on a worktree-scoped run that source is the run worktree's copy). */
export function buildImproverPrompt(
  iterationPath: string,
  brief: string,
  runId: string,
  pipelineRootAbs: string,
): string {
  return `Tier-1 improvement pass for a pipeline iteration.

run_id = ${runId}
pipeline_root = ${pipelineRootAbs}
Source iteration file: ${iterationPath}

Apply the improvement brief below per your single-brief (Tier-1) protocol. The
file to edit is the Source iteration file above (paths inside the brief may
point at a rendered per-run copy — always edit the source). Read the current
file state first; never re-apply an already-present fix. You make the final
call; refuse a bad or ambiguous brief.

${brief}
${IMPROVER_HEADLESS_NOTE}`;
}

/** Retrospective (batch) improver spawn prompt — the manager-documented shape
 *  (pipeline-manager.md "End-of-run Retrospective" step 3) plus the headless
 *  structured-output note. */
export function buildRetroImproverPrompt(
  pipelineRootAbs: string,
  feedbackDir: string,
  runId: string,
  lintWarnings: string[],
): string {
  let prompt = `Retrospective (batch) improvement pass for a completed pipeline run.

run_id = ${runId}
pipeline_root = ${pipelineRootAbs}
Feedback folder: ${feedbackDir}
Pipeline root:   ${pipelineRootAbs}

Operate in batch / retrospective mode (see your "Batch / retrospective mode"
section): read the doc-actionable problem files (categories doc-flaw /
ambiguity / script-candidate / script-failure) in the feedback folder,
consolidate and dedup them, then apply surgical doc fixes to the iteration
files / PIPELINE.md. ALWAYS read the current file state first — Tier-1 may
already have landed some of these fixes between steps; never re-apply an
already-present fix. For any script-candidate you confirm is a clean,
deterministic, judgment-free extraction, include it as one entry in your
script_creation_briefs list. You make the final call; refuse a bad or
ambiguous extraction. Ignore human-only files (project-issue / env /
friction) — they are summarized for the human elsewhere.
`;
  if (lintWarnings.length > 0) {
    prompt += `
LOW-PRIORITY compaction items from the design-time lint — address
opportunistically after the doc fixes, per your "Token-budget
counter-pressure" rules; skip any that cannot be resolved safely:
${lintWarnings.map((w) => `- ${w}`).join('\n')}
`;
  }
  return prompt + IMPROVER_HEADLESS_NOTE;
}

/** Script-creator spawn prompt: ONE brief verbatim (manager parity) plus the
 *  headless structured-output note. */
export function buildScriptCreatorPrompt(
  brief: string,
  number: number,
  of: number,
  runId: string,
  pipelineRootAbs: string,
): string {
  return `Script-creation brief ${number} of ${of} from a pipeline improver pass.

run_id = ${runId}
pipeline_root = ${pipelineRootAbs}

${brief}
${SCRIPT_CREATOR_HEADLESS_NOTE}`;
}

/** The crash-resume prompt for an interrupted improver/script-creator session
 *  (buildCrashResumePrompt's self-improvement twin — the transcript survived
 *  on disk, so the session verifies and finishes instead of re-deriving). */
export function buildSelfImproveCrashPrompt(kind: 'improver' | 'script-creator'): string {
  return `Your ${kind} session was interrupted before a structured result was produced.

Re-verify the current state of your work (files you edited, any script you
created), finish anything incomplete, and report as originally instructed: end
with exactly the one JSON object your session's schema requires. If the work
was already complete before the interruption, just verify and report.
`;
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface DriveArgs {
  root?: string;
  runId?: string;
  start?: string;
  defaultModel?: string | null;
  /** Per-run step-model overrides (`--model <step_id>=<model>`, repeatable). */
  modelOverrides?: Record<string, string>;
  /** Set when a `--model` value was malformed — loud usage error (exit 2). */
  modelError?: string;
  /** Pipeline-level effort override (`--default-effort <level>`). */
  defaultEffort?: string | null;
  /** Per-run step-effort overrides (`--effort <step_id>=<level>`, repeatable). */
  effortOverrides?: Record<string, string>;
  /** Set when an `--effort` value was malformed — loud usage error (exit 2). */
  effortError?: string;
  /** PP_* overrides from repeated `--var NAME=value` (env-variables design):
   *  forwarded to the `next` engine's INIT invocation, which resolves and
   *  freezes them into next.json. undefined = no flag passed. */
  varFlags?: Record<string, string>;
  /** Path passed via `--vars-file <path>` (dotenv format, strict load). */
  varsFile?: string;
  /** Set when a `--var` value was malformed — loud usage error (exit 2). */
  varsError?: string;
  resume: boolean;
  /** The answer to a parked needs-input question (--answer / --answer-file). */
  answer?: string;
  answerFile?: string;
  /** The run's task statement (--task text | --task-file path). */
  task?: string;
  taskFile?: string;
  /** `--executor <claude-cli|claude-sdk|codex-cli>` (E8/E15, c5): selects the
   *  ExecutorRunner IMPLEMENTATION. Distinct from `executorCmd` below, which
   *  overrides the subprocess COMMAND TEMPLATE within a CLI implementation —
   *  see USAGE, which spells out the difference in one line each. undefined ⇒
   *  resolved against the manifest's declared `runner:` (see runDrive). */
  executor?: ExecutorKind;
  /** Set when `--executor` named a value outside EXECUTOR_KINDS, INCLUDING
   *  `subagent` (rejected with its own session-only explanation) — a loud
   *  parse-time error, exit 2, exactly the modelError/effortError/varsError
   *  convention. Never a silent fallback to claude-cli. */
  executorError?: string;
  executorCmd?: string;
  json: boolean;
}

function asModel(v: string | undefined): string | null {
  return v === undefined || v === '' || v === 'null' || v === 'inherit' ? null : v;
}

/** Fold one `--model` value (`<step_id>=<model>`) onto args.modelOverrides —
 *  the same shape `pipeline next` accepts (invokeNext persists them at init). */
function addModelOverride(out: DriveArgs, v: string | undefined): void {
  const sep = v?.indexOf('=') ?? -1;
  const id = sep > 0 ? v!.slice(0, sep).trim() : '';
  const model = sep > 0 ? v!.slice(sep + 1).trim() : '';
  if (!id || !model) {
    out.modelError = `--model expects <step_id>=<model>, got '${v ?? ''}'`;
    return;
  }
  (out.modelOverrides ??= {})[id] = model;
}

/** Fold one `--effort` value (`<step_id>=<level>`) — the addModelOverride twin. */
function addEffortOverride(out: DriveArgs, v: string | undefined): void {
  const sep = v?.indexOf('=') ?? -1;
  const id = sep > 0 ? v!.slice(0, sep).trim() : '';
  const effort = sep > 0 ? v!.slice(sep + 1).trim() : '';
  if (!id || !effort) {
    out.effortError = `--effort expects <step_id>=<level>, got '${v ?? ''}'`;
    return;
  }
  (out.effortOverrides ??= {})[id] = effort;
}

/** Validate one `--executor` value onto args.executor/executorError — the
 *  same eager, loud-error convention as addModelOverride/addEffortOverride: a
 *  malformed or unrecognised value is a parse-time error, never a value that
 *  silently resolves to something else later. `subagent` is a real Axis-2
 *  value (01-modes.md) but is not a member of EXECUTOR_KINDS — it is implied
 *  by session/manager and meaningless without a live session, which `pipeline
 *  drive` never has — so it gets its own explanatory message rather than the
 *  generic "unknown value" one. */
function setExecutorFlag(out: DriveArgs, v: string | undefined): void {
  if (v === 'subagent') {
    out.executorError =
      "--executor=subagent is not accepted here — it is the host's own Agent tool, implied by " +
      'session/manager, and only exists inside a live Claude Code session (pipeline drive runs no ' +
      'session, by definition). Pass --executor=claude-cli, claude-sdk, or codex-cli instead.';
    return;
  }
  if (v !== undefined && (EXECUTOR_KINDS as readonly string[]).includes(v)) {
    out.executor = v as ExecutorKind;
    return;
  }
  out.executorError = `--executor: unknown value ${JSON.stringify(v ?? '')} — expected one of ${EXECUTOR_KINDS.join(' | ')}`;
}

function parseArgs(args: string[]): DriveArgs {
  const out: DriveArgs = { resume: false, json: false };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--root') out.root = take(i++);
    else if (eq('--root') !== undefined) out.root = eq('--root');
    else if (a === '--run-id') out.runId = take(i++);
    else if (eq('--run-id') !== undefined) out.runId = eq('--run-id');
    else if (a === '--start') out.start = take(i++);
    else if (eq('--start') !== undefined) out.start = eq('--start');
    else if (a === '--default-model') out.defaultModel = asModel(take(i++));
    else if (eq('--default-model') !== undefined) out.defaultModel = asModel(eq('--default-model'));
    else if (a === '--model') addModelOverride(out, take(i++));
    else if (eq('--model') !== undefined) addModelOverride(out, eq('--model'));
    else if (a === '--default-effort') out.defaultEffort = asModel(take(i++));
    else if (eq('--default-effort') !== undefined) out.defaultEffort = asModel(eq('--default-effort'));
    else if (a === '--effort') addEffortOverride(out, take(i++));
    else if (eq('--effort') !== undefined) addEffortOverride(out, eq('--effort'));
    else if (a === '--var') addVarFlag(out, take(i++));
    else if (eq('--var') !== undefined) addVarFlag(out, eq('--var'));
    else if (a === '--vars-file') out.varsFile = take(i++);
    else if (eq('--vars-file') !== undefined) out.varsFile = eq('--vars-file');
    else if (a === '--executor') setExecutorFlag(out, take(i++));
    else if (eq('--executor') !== undefined) setExecutorFlag(out, eq('--executor'));
    else if (a === '--executor-cmd') out.executorCmd = take(i++);
    else if (eq('--executor-cmd') !== undefined) out.executorCmd = eq('--executor-cmd');
    else if (a === '--answer') out.answer = take(i++);
    else if (eq('--answer') !== undefined) out.answer = eq('--answer');
    else if (a === '--answer-file') out.answerFile = take(i++);
    else if (eq('--answer-file') !== undefined) out.answerFile = eq('--answer-file');
    else if (a === '--task') out.task = take(i++);
    else if (eq('--task') !== undefined) out.task = eq('--task');
    else if (a === '--task-file') out.taskFile = take(i++);
    else if (eq('--task-file') !== undefined) out.taskFile = eq('--task-file');
    else if (a === '--resume') out.resume = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Record-file reading
// ---------------------------------------------------------------------------

/**
 * The per-run executor-writable record DROP directory (e7 DEFECT-1): headless
 * acceptEdits on Claude Code >= 2.1.21x auto-DENIES every write under
 * `.claude/` as sensitive (no allow rule can override it), which killed the
 * canonical `.runtime/<run>/records/` path as an executor write target. Step
 * executors are handed a per-run tmp-dir record path instead (the directory
 * is granted to the claude sandbox via `--add-dir {record_dir}` in the
 * template) and drive persists the canonical observability copy under
 * `.runtime/<run>/records/` ITSELF after recovery. Keyed on a root hash + run
 * id so concurrent runs (and parallel test sandboxes reusing run ids) never
 * collide; the run dir is removed at done/halt.
 */
export function dropRecordsDirFor(rootAbs: string, runId: string): string {
  const rootHash = createHash('sha1').update(rootAbs, 'utf8').digest('hex').slice(0, 8);
  return join(tmpdir(), 'pipeline-drive', `${rootHash}-${runId}`, 'records');
}

/** Parse a step record file: a JSON object → the record; missing/unparseable/
 *  non-object → null (the caller synthesizes a halted record). */
function readRecordFile(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Everything a structured_output record may carry (engine + needs-input;
 *  needs-input is intercepted before the engine ever sees the record). */
const RECORD_OUTCOMES = new Set<string>(RECORD_OUTCOME_LIST);

/** A usable step record from either source (structured_output or the file). */
function validRecord(r: Record<string, unknown> | null): r is Record<string, unknown> {
  return r !== null && typeof r.outcome === 'string' && RECORD_OUTCOMES.has(r.outcome);
}

function noRecordReason(recordFile: string, exit: ExecutorExit, envelope: ClaudeEnvelope | null): string {
  const code = exit.code === null ? (exit.error ? `spawn failed: ${exit.error}` : 'null') : String(exit.code);
  // An error envelope names the failure category (error_max_turns, …) — far
  // better triage than a bare exit code.
  const env = envelope && envelope.is_error ? `; claude error: ${envelope.subtype ?? 'unknown'}` : '';
  // Distinguish "the executor never produced a record" from "the executor DID
  // try to write it and the permission gate denied the write" (headless
  // acceptEdits auto-denies `.claude/` paths as sensitive on Claude Code >=
  // 2.1.21x — a denial here means a custom template/prompt override still
  // points records at a gated path; the default contract drops records in an
  // --add-dir-granted tmp directory precisely to avoid this).
  const denied = deniedRecordWrite(envelope, recordFile);
  const deny =
    denied !== null
      ? `; record write DENIED by the claude permission gate (${denied}) — the executor attempted the write but the harness refused it (sensitive-path auto-deny)`
      : '';
  return `no valid step record at ${recordFile} (executor exit ${code}${env}${deny})`;
}

/** Does the envelope report a PERMISSION DENIAL for a Write/Edit against one
 *  of the given paths? Returns the denied path (as the harness reported it),
 *  or null. Paths compare resolved, slash-normalized, case-insensitive (the
 *  harness reports Windows backslash paths). */
export function deniedRecordWrite(envelope: ClaudeEnvelope | null, ...paths: string[]): string | null {
  if (envelope === null || envelope.permission_denials.length === 0) return null;
  const norm = (p: string): string => resolve(p).replace(/\\/g, '/').toLowerCase();
  const targets = new Set(paths.map(norm));
  for (const d of envelope.permission_denials) {
    if (d.file_path === null) continue;
    if (d.tool_name !== null && !/write|edit/i.test(d.tool_name)) continue;
    if (targets.has(norm(d.file_path))) return d.file_path;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

const USAGE =
  'Usage: pipeline drive --root <pipeline_root> --run-id <id> --start <step-name>\n' +
  '                      [--default-model <m>] [--model <step_id>=<m> ...]\n' +
  '                      [--default-effort <level>] [--effort <step_id>=<level> ...] [--resume]\n' +
  '                      [--var NAME=value ...] [--vars-file <path>]\n' +
  '                      [--answer <text> | --answer-file <path>]\n' +
  '                      [--task <text> | --task-file <path>]\n' +
  '                      [--executor <claude-cli|claude-sdk|codex-cli>]  (which implementation runs a step; default claude-cli)\n' +
  '                      [--executor-cmd <template>]  (overrides the subprocess command template a CLI executor runs)\n' +
  '                      [--json]\n';

export async function runDrive(args: string[], deps: DriveDeps = {}): Promise<number> {
  // c2 — the two sinks this command writes through, both wrapped OUTSIDE the
  // `??` so an INJECTED sink (tests, commands/init.ts) gets exactly the same
  // guarantee as the real stream, and `scrub` again on the default arm so the
  // invariant "no raw stream write in this closure passes unscrubbed text" is
  // checkable by reading one line. Double-scrubbing is free and idempotent.
  const out = scrubWriter(deps.out ?? ((s: string) => process.stdout.write(scrub(s))));
  const err = scrubWriter(deps.err ?? ((s: string) => process.stderr.write(scrub(s))));
  if (args.includes('--help') || args.includes('-h')) {
    out(USAGE);
    return 0;
  }
  const a = parseArgs(args);
  if (!a.root || !a.runId) {
    err('pipeline drive: --root and --run-id are required\n');
    return 2;
  }
  if (!a.start && !a.resume) {
    err('pipeline drive: --start <step-name> is required (or pass --resume to re-enter a persisted run)\n');
    return 2;
  }
  if (a.modelError !== undefined) {
    err(`pipeline drive: ${a.modelError}\n`);
    return 2;
  }
  if (a.effortError !== undefined) {
    err(`pipeline drive: ${a.effortError}\n`);
    return 2;
  }
  if (a.executorError !== undefined) {
    err(`pipeline drive: ${a.executorError}\n`);
    return 2;
  }
  // PP_* variables (env-variables design): same loud usage errors as `next`,
  // resolved BEFORE any run-start setup so a malformed flag/file touches
  // nothing. The merged map is forwarded to the engine's FIRST invocation
  // only (init/resume — like --start): the engine freezes it into next.json,
  // and re-supplying it against a frozen map is the D11 error.
  if (a.varsError !== undefined) {
    err(`pipeline drive: ${a.varsError}\n`);
    return 2;
  }
  let fileVars: Record<string, string> | undefined;
  if (a.varsFile !== undefined) {
    const loaded = loadVarsFile(a.varsFile);
    if (!loaded.ok) {
      err(`pipeline drive: ${loaded.error}\n`);
      return 2;
    }
    fileVars = loaded.vars;
  }
  const cliVars = mergeCliVars(fileVars, a.varFlags);
  // D11: variables against an already-frozen run (a resume with leftover
  // --var flags) are a USAGE error — exit 2 before any run-start setup, no
  // phantom run.halted event, no stats write; a flag-less --resume continues
  // the run untouched.
  if (a.root !== undefined && a.runId !== undefined) {
    const frozen = frozenVariablesError(a.root, a.runId, cliVars);
    if (frozen !== null) {
      err(`pipeline drive: ${frozen}\n`);
      return 2;
    }
  }
  // Resolve the one-shot answer for a parked needs-input question. Consumed by
  // the FIRST awaiting step it can be delivered to (sequential runs park on
  // exactly one step, so "first" is "the" step).
  let pendingAnswer: string | null = a.answer ?? null;
  if (a.answerFile !== undefined) {
    try {
      pendingAnswer = readFileSync(a.answerFile, 'utf8').trim();
    } catch (e) {
      err(`pipeline drive: cannot read --answer-file ${a.answerFile}: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
  }
  if (pendingAnswer !== null && pendingAnswer.trim() === '') {
    err('pipeline drive: --answer/--answer-file is empty\n');
    return 2;
  }

  const root = a.root;
  const runId = a.runId;
  const rootAbs = resolve(root);
  // Tag this run's stats records (lib/stats.ts reads it at finalize) so the
  // measurement files distinguish headless runs from manager-driven ones.
  // E15: the record-layer vocabulary renamed this mode's name to `driver`
  // (Runner, lib/manifest.ts) — `headless` is still read correctly via the
  // read-time shim in lib/stats.ts, but no longer written.
  process.env.PIPELINE_STATS_RUNNER = 'driver';
  // NOTE: the merge cwd is NOT process.cwd() — runMerge resolves the project
  // root enclosing --root itself (B3) so merges never land in a random cwd.
  const progress = (event: string, fields: Record<string, unknown> = {}) => {
    if (a.json) {
      err(JSON.stringify({ event, ...fields }) + '\n');
    } else {
      const kv = Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      err(`[drive] ${event}${kv ? ' ' + kv : ''}\n`);
    }
  };

  /** The live half of the stream-json swap (ux-v2 b6): one progress line per
   *  tool call, emitted WHILE the spawn runs. `depth` is the measured
   *  `parent_tool_use_id` chain length — 0 for the step-executor's own calls,
   *  ≥1 for a subagent's (forwarding is not depth-1-only; a depth-2 call was
   *  observed on claude 2.1.222). It rides the normal progress sink, so
   *  `--json` keeps emitting well-formed event objects. */
  const noteToolCall = (req: ExecutorRequest, call: StreamToolCall): void => {
    progress('step.tool', {
      step_id: req.step_id,
      tool: call.tool,
      depth: call.depth,
      ...(call.parent_tool_use_id !== null ? { parent_tool_use_id: call.parent_tool_use_id } : {}),
    });
  };

  // ---------------------------------------------------------------------------
  // Executor selection (E8/E15, c5) — --executor picks the IMPLEMENTATION that
  // runs a step; --executor-cmd (below, unchanged) overrides the SUBPROCESS
  // COMMAND TEMPLATE within a CLI implementation (claude-cli / codex-cli). The
  // two compose rather than collide: one says WHAT runs a step, the other says
  // HOW a command-line one is invoked — see USAGE for the one-line-each split.
  //
  // Absent --executor, the manifest decides (a1): only `runner: standalone`
  // has an opinion on this axis at all — it names the exact driver+claude-sdk
  // pairing the modes table calls `standalone` (01-modes.md) — so it alone
  // moves the default to claude-sdk. Every other declared (or absent) runner
  // value leaves today's default, claude-cli, untouched (DoD: "absent the
  // flag, behaviour is identical to today"). When an explicit flag AND a
  // `standalone` manifest both speak and they actually differ, the flag wins,
  // and that is reported ONCE here, at selection time — never per step, never
  // silently (the manner "no silent fallback" governs this whole flag).
  const manifestRunner: Runner = computePlan(rootAbs).runner;
  const impliedExecutor: ExecutorKind = manifestRunner === 'standalone' ? 'claude-sdk' : 'claude-cli';
  const executorKind: ExecutorKind = a.executor ?? impliedExecutor;
  if (a.executor !== undefined && manifestRunner === 'standalone' && a.executor !== impliedExecutor) {
    progress('executor.override', {
      manifest_runner: manifestRunner,
      executor: a.executor,
      detail: `manifest declares runner: standalone (implies --executor=claude-sdk); --executor=${a.executor} wins for this run`,
    });
  }

  // c6: the DEFAULT template a bare `--executor=codex-cli` resolves to is
  // codex's own sibling, never DEFAULT_EXECUTOR_TEMPLATE — --executor-cmd /
  // PIPELINE_DRIVE_EXECUTOR_CMD still override whichever default this picks,
  // unchanged (DoD: "--executor-cmd still overrides this template, as it does
  // the others").
  const defaultTemplate = executorKind === 'codex-cli' ? DEFAULT_CODEX_EXECUTOR_TEMPLATE : DEFAULT_EXECUTOR_TEMPLATE;
  const template = a.executorCmd ?? process.env.PIPELINE_DRIVE_EXECUTOR_CMD ?? defaultTemplate;
  // c4's seams cover all three DriveDeps runner members TOGETHER (step +
  // improver + script-creator, below) — built ONCE here, so the inapplicable-
  // template warnings sdkDriveSeams already emits for PIPELINE_DRIVE_EXECUTOR_CMD
  // and the two self-improvement variables fire once per run, never once per
  // spawn, and c5 adds no second copy of that report (c4's own open note on the
  // overlap). `pluginDir` is passed explicitly here, through the SAME helper
  // the CLI templates use for their own `{plugin_dir}` token, rather than left
  // to sdk-seams.ts's own CLAUDE_PLUGIN_ROOT default (c4's other open note) —
  // so both implementations resolve the plugin root through one piece of code
  // instead of two copies that can drift apart.
  const sdkSeams =
    executorKind === 'claude-sdk'
      ? sdkDriveSeams({ err, onToolCall: noteToolCall, pluginDir: pluginDirToken() })
      : null;
  // c6 — codex-cli's own "this has no equivalent" report
  // (DEFAULT_CODEX_EXECUTOR_TEMPLATE's header + codexTemplateGapWarnings),
  // emitted ONCE at construction, the same c4 pattern sdkSeamOverrideWarnings
  // follows above. Fires whether the default codex template or a user's own
  // --executor-cmd is in play — see codexTemplateGapWarnings' own doc for why
  // these three gaps are properties of the EXECUTOR, not of one template
  // string, and codexOpts below for the same reasoning applied to
  // {permissions}/{session} handling.
  if (executorKind === 'codex-cli') {
    for (const line of codexTemplateGapWarnings()) err(line + '\n');
  }
  const codexOpts: SubprocessExecutorOptions | undefined =
    executorKind === 'codex-cli' ? { permissionModeFor: codexPermissionModeMapper(err), appendSessionIfAbsent: false } : undefined;
  const executor =
    deps.executor ??
    sdkSeams?.executor ??
    subprocessExecutor(template, stepRecordSchemaJson(), err, noteToolCall, codexOpts);
  const git = deps.git ?? realGit;

  // Track provider-limit errors for the final JSON (06.7 / D11). Any step may
  // hit a limit; the first one is captured so the caller can implement retry
  // policy. Null unless a provider-limit envelope was seen.
  let detectedLimit: ProviderLimit | null = null;

  progress('run.started', { run_id: runId, pipeline_root: rootAbs, experimental: true });

  // The dashboard link (ux-v2 b12) — line 2, before step 1 (`08` J2). Gated
  // FIRST on PIPELINE_SYNC_LOCAL_STATS (so the disabled baseline this
  // feature's ≤15ms budget is measured against pays nothing beyond this one
  // env read) and THEN on a connected project (`03` F7: no `.pipeline/
  // cloud.json` at all ⇒ no line, nothing spawned, nothing queued — the
  // telemetry subsystem is ABSENT here, matching `src/hooks/analytics-relay.ts`'s
  // OWN "no cloud account" gate exactly, so drive agrees with the hook about
  // what "has a cloud account" means rather than inventing a second notion).
  const telemetrySyncOn = telemetrySyncEnabled(process.env);
  const telemetryProjectRoot = telemetrySyncOn ? resolveProjectRoot(process.cwd()).project_root : null;
  const driveTelemetryEnabled = telemetryProjectRoot !== null && existsSync(cloudJsonPath(telemetryProjectRoot));
  if (driveTelemetryEnabled) {
    driveRunStartTelemetry(telemetryProjectRoot!, runId, progress);
  }

  // Run-start setup — mirrors the pipeline-manager's "Set up the Tier-2 feedback
  // directory" section: the .feedback/<run_id>/ folder + its self-contained
  // .gitignore stub, and the .runtime/<run_id>/records/ folder the executors
  // write their step records into.
  const recordsDir = join(rootAbs, '.runtime', runId, 'records');
  const sessionsDir = join(rootAbs, '.runtime', runId, 'sessions');
  const dropRecordsDir = dropRecordsDirFor(rootAbs, runId);
  const dropRunDir = dirname(dropRecordsDir);
  try {
    // Every one of these is a machine-generated tree; the shared helper marks
    // each tree's ROOT ignored (see lib/generated-dir.ts) instead of leaving
    // the rule to each consumer project's .gitignore.
    ensureGeneratedDir(join(rootAbs, '.feedback', runId), join(rootAbs, '.feedback'));
    ensureGeneratedDir(recordsDir, join(rootAbs, '.runtime'));
    ensureGeneratedDir(sessionsDir, join(rootAbs, '.runtime'));
    ensureGeneratedDir(dropRecordsDir, dropRunDir);
  } catch (e) {
    err(`pipeline drive: run-start setup failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  // Task delivery: --task writes the text to .runtime/<run>/task.md; --task-file
  // points at an existing file. The resolved path persists in task-ref.json so
  // resume re-entries keep it without re-passing the flag.
  const taskRefFile = join(rootAbs, '.runtime', runId, 'task-ref.json');
  let taskFile: string | null = null;
  if (a.taskFile !== undefined) {
    if (!existsSync(a.taskFile)) {
      err(`pipeline drive: --task-file does not exist: ${a.taskFile}\n`);
      return 2;
    }
    taskFile = resolve(a.taskFile);
  } else if (a.task !== undefined) {
    if (a.task.trim() === '') {
      err('pipeline drive: --task is empty\n');
      return 2;
    }
    taskFile = join(rootAbs, '.runtime', runId, 'task.md');
    try {
      writeFileSync(taskFile, scrub(a.task), 'utf8');
    } catch (e) {
      err(`pipeline drive: cannot write task file: ${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
  }
  if (taskFile !== null) {
    try {
      writeFileSync(taskRefFile, JSON.stringify({ task_file: taskFile }), 'utf8');
    } catch {
      // best-effort — a resume without the ref just runs task-less
    }
  } else {
    try {
      const ref = JSON.parse(readFileSync(taskRefFile, 'utf8')) as { task_file?: unknown };
      if (typeof ref.task_file === 'string' && existsSync(ref.task_file)) taskFile = ref.task_file;
    } catch {
      // no persisted task — fine
    }
  }

  const recordPath = (stepId: string) => join(recordsDir, `${stepId}.json`);
  const dropRecordPath = (stepId: string) => join(dropRecordsDir, `${stepId}.json`);

  /** SESSION BINDING PRE-WRITE (ux-v2 b7) — the write half of the run/step
   *  attribution the hooks read back.
   *
   *  Every headless spawn below pins its own session UUID and passes it as
   *  `claude --session-id` (or `--resume`). Claude Code hands that same value to
   *  every hook that fires INSIDE the child, so a record keyed by it lets
   *  `resolveBindingFromEnvOrSession` (src/hooks/analytics-relay.ts) name the run
   *  AND the step for a `tool.called` / `turn.usage` / `manager.stopped` that
   *  the hook itself has no other way to attribute. Before this, those events
   *  stamped `run_id: null` on the whole driven path: `PIPELINE_RUN_ID` is
   *  not exported into the child, and no other binding is keyed by the child's
   *  session.
   *
   *  ORDER IS THE POINT: called immediately after the session is persisted and
   *  strictly BEFORE the spawn — a binding written after exec would miss the
   *  child's first hooks. Called once per session (not per attempt): a crash
   *  resume re-enters with the SAME session id and run/step identity, so the
   *  re-write is a duplicate, not a correction. See registerDriveSessionBinding
   *  for the record's lifecycle (no terminal record; the run's own
   *  pipeline.completed/halted retires every binding sharing its run_id). */
  const bindSession = (
    sessionId: string,
    stepRunId: string,
    stepUuid: string | null,
    iterationPath: string | null,
  ): void => {
    try {
      registerDriveSessionBinding({
        runId: stepRunId,
        sessionId,
        stepUuid,
        pipelineName: basename(rootAbs),
        iterationPath,
      });
    } catch {
      // Attribution is observability — never let it break a run.
    }
  };

  /** Best-effort removal of the run's tmp record drop dir (terminal actions
   *  only — parked/blocked runs may still resume and re-use it). */
  const cleanupDropDir = (): void => {
    try {
      rmSync(dropRunDir, { recursive: true, force: true });
    } catch {
      // best-effort — tmp dirs are reaped by the OS eventually
    }
  };
  /** Journal a structured event into events.jsonl (the shipper's upload
   *  source) — best-effort like every drive emission. */
  const journalEvent = (eventType: string, data: Record<string, unknown>, sessionId: string | null): void => {
    try {
      emitEventJson(eventType, data, { runId, sessionId });
    } catch {
      // best-effort — never affect the run
    }
  };
  const finalJson = (obj: Record<string, unknown>, code: number): number => {
    // Run-exit telemetry (ux-v2 b12): funnels through here because EVERY
    // terminal return of runDrive (done/halt/blocked/awaiting-input) calls
    // finalJson exactly once. Final chance to get this run's last journaled
    // events (run.completed/halted/…) into the durable outbox, and to
    // re-spawn the uploader if a very long run outlived its own 30-minute
    // wall-clock cap — both LOCAL ONLY, same as the run-start call.
    if (driveTelemetryEnabled) {
      ensureTelemetryDaemonRunning(telemetryProjectRoot!);
      tailProjectJournal(telemetryProjectRoot!);
    }
    out(JSON.stringify({ ...obj, run_id: runId, pipeline_root: rootAbs }, null, 2) + '\n');
    return code;
  };

  // Envelope usage/cost accumulator, persisted across drive invocations of the
  // SAME run (blocked → resume re-enters a fresh process) so the terminal
  // stats enrichment covers every spawn. Best-effort like all stats.
  const usageFile = join(rootAbs, '.runtime', runId, 'usage.json');
  // Shared reader (lib/envelope.ts, also used by the stats backfill core):
  // missing/corrupt → zeros, i.e. a fresh run.
  const usageTotals = loadUsageTotals(usageFile).totals;
  const noteUsage = (envelope: ClaudeEnvelope | null): void => {
    if (!envelope || (envelope.usage === null && envelope.total_cost_usd === null)) return;
    addUsage(usageTotals, envelope);
    try {
      writeFileSync(usageFile, JSON.stringify(usageTotals), 'utf8');
    } catch {
      // best-effort
    }
  };
  /** Terminal-action hook: fill the run's .stats/ tokens from the accumulated
   *  envelopes (headless runs have no manager transcript for the stats hook to
   *  fold), plus — when the run actually finalized (done/halt) — tool counts
   *  and failures folded from the pinned per-step session transcripts (exact
   *  step attribution; loop-back re-executions included via each session's
   *  previous_session_ids). `finalized:false` (blocked / awaiting-input parks,
   *  which never finalize a record) skips the transcript walk. Also flags an
   *  --answer nobody consumed (wrong run/step — loudly). */
  const enrichStats = (finalized: boolean): void => {
    if (pendingAnswer !== null) {
      progress('warning', {
        detail: '--answer was provided but no step was awaiting input — the answer was not delivered to any session',
      });
    }
    const fold = finalized && statsEnabled() ? foldStepSessionTranscripts(readStepSessionRefs(sessionsDir)) : null;
    // Token base: envelope totals when any accumulated (they carry cost);
    // else the transcript-folded totals (custom executor template that emits
    // no result envelope, or every attempt crashed pre-envelope). The two are
    // not redundant and the stream-json swap did not merge them (ux-v2 b6):
    // the STREAM is for liveness, the FOLD is for accurate tokens, and the
    // envelope side takes usage from the terminal `result` frame ONLY —
    // accumulating the per-turn `assistant` usage the stream also carries
    // would double every number here. All-zero
    // from both sources ⇒ leave the record pending — measured-as-zero would
    // be indistinguishable from a real zero and drag the SUMMARY averages.
    const hasEnvelopeUsage =
      usageTotals.input + usageTotals.output + usageTotals.cache_read + usageTotals.cache_creation > 0 ||
      usageTotals.cost_usd > 0;
    const tokens: TokenStats = hasEnvelopeUsage
      ? { ...usageTotals }
      : {
          input: fold?.input_tokens ?? 0,
          output: fold?.output_tokens ?? 0,
          cache_read: fold?.cache_read_tokens ?? 0,
          cache_creation: fold?.cache_creation_tokens ?? 0,
        };
    if (tokens.input + tokens.output + tokens.cache_read + tokens.cache_creation === 0 && !tokens.cost_usd) return;
    if (fold?.found_any) {
      tokens.tools_called = fold.tools_called;
      tokens.tools_failed = fold.tools_failed;
      tokens.agents_spawned = fold.agents_spawned;
    }
    statsEnrichTokensForRun(rootAbs, runId, tokens, fold?.failures);
  };

  // ---------------------------------------------------------------------------
  // Headless self-improvement (design 05.2, P3) — run-scoped machinery
  // ---------------------------------------------------------------------------

  const selfImprove = selfImproveEnabled();
  // c4/c5: under claude-sdk the improver and script-creator MUST come from the
  // same sdkSeams object as the step executor above — never wired one seam at
  // a time (tests/sdk-seams.test.ts's positive control shows exactly what that
  // omission looks like: a run that completes, reports success, and silently
  // spawns `claude -p` for self-improvement anyway).
  const improverRunner =
    deps.improver ??
    sdkSeams?.improver ??
    subprocessExecutor(
      process.env.PIPELINE_DRIVE_IMPROVER_CMD ?? DEFAULT_IMPROVER_TEMPLATE,
      improverSchemaJson(),
      err,
      noteToolCall,
    );
  const scriptCreatorRunner =
    deps.scriptCreator ??
    sdkSeams?.scriptCreator ??
    subprocessExecutor(
      process.env.PIPELINE_DRIVE_SCRIPT_CREATOR_CMD ?? DEFAULT_SCRIPT_CREATOR_TEMPLATE,
      scriptCreatorSchemaJson(),
      err,
      noteToolCall,
    );

  /** Worktree-scoped runs (P2/b3): the execution pipeline root invokeNext
   *  surfaces as out.worktree_pipeline_root — the run's pipeline tree, where
   *  step prompts point the Tier-2 feedback journal, where improver/script
   *  sessions operate, and where the retrospective reads/deletes feedback.
   *  Null on unscoped runs (rootAbs applies). */
  let worktreePipelineRoot: string | null = null;
  /** True once the run's finalize hook reported ok — the improvements' landing
   *  path (05 §Cloud interplay). */
  let finalizeLandedOk = false;
  /** True once any improver applied doc fixes or a script-creator produced a
   *  script — drives improvement.applied + the preserve-workspace cue. */
  let improvementsApplied = false;
  /** The mechanical retrospective's summary for the terminal JSON. */
  let retrospectiveSummary: Record<string, unknown> | null = null;
  /** The CURRENT Tier-1 improver's script_creation_briefs — the following
   *  run-script-creator actions index into it (1-based action.number). */
  let scriptBriefs: string[] = [];

  /** Tier-1 improvement briefs captured from completed step records (the
   *  structured-output/record-file `improvement_brief` field), keyed by the
   *  step's dispatch and source paths — the engine's run-improver action
   *  addresses its target by iteration_path. */
  const pendingBriefs = new Map<string, { step_id: string; brief: string }>();
  const noteBrief = (step: ActionStep, raw: Record<string, unknown> | null): void => {
    if (!selfImprove || raw === null || raw.has_improvement_brief !== true) return;
    if (typeof raw.improvement_brief !== 'string' || raw.improvement_brief.trim() === '') return;
    const entry = { step_id: step.step_id, brief: raw.improvement_brief };
    for (const p of [step.path, step.source_path]) {
      if (typeof p === 'string' && p) pendingBriefs.set(resolve(p), entry);
    }
  };
  const takeBrief = (iterationPath: string): string | null => {
    const hit = pendingBriefs.get(resolve(iterationPath));
    const chosen =
      hit ??
      // Path-mapping last resort (a scoped+rendered dispatch path can differ
      // from the engine's plan path): when every pending entry belongs to ONE
      // step, it is this improver's step.
      (new Set([...pendingBriefs.values()].map((v) => v.step_id)).size === 1
        ? pendingBriefs.values().next().value
        : undefined);
    if (chosen === undefined) return null;
    for (const [k, v] of pendingBriefs) if (v.step_id === chosen.step_id) pendingBriefs.delete(k);
    return chosen.brief;
  };

  // The current improver's briefs also persist to disk so a drive process that
  // dies between the improver record and its script-creator spawns can still
  // serve the engine's run-script-creator actions after re-entry.
  const briefsFile = join(rootAbs, '.runtime', runId, 'script-briefs.json');
  const persistScriptBriefs = (briefs: string[]): void => {
    try {
      writeFileSync(briefsFile, scrub(JSON.stringify({ briefs })), 'utf8');
    } catch {
      // best-effort
    }
  };
  const loadScriptBriefs = (): string[] => {
    try {
      const v = JSON.parse(readFileSync(briefsFile, 'utf8')) as { briefs?: unknown };
      return Array.isArray(v.briefs) ? v.briefs.filter((b): b is string => typeof b === 'string') : [];
    } catch {
      return [];
    }
  };

  // Best-effort UI-event emission for what invokeNext cannot see: the
  // retrospective-internal `improver.` / `script_creator.` events (manager
  // parity — the whole retrospective is ONE engine action) and the new
  // run.retrospective / improvement.applied events (07). Payloads carry paths
  // + one-line summaries ONLY — never file content.
  const safeEmit = (eventType: string, fields: Record<string, unknown>): void => {
    try {
      emitEvent(
        eventType,
        Object.entries(fields).map(([k, v]) => `${k}=${v === null || v === undefined ? 'null' : String(v)}`),
      );
    } catch {
      // best-effort — never affect the run
    }
  };
  const noteImprovementApplied = (fields: Record<string, unknown>): void => {
    improvementsApplied = true;
    safeEmit('improvement.applied', { run_id: runId, ...fields });
  };

  /** Claim the session key for the next improver/script-creator session
   *  (`sessions/<prefix>-<n>.json`). A session file left 'running' by a died
   *  drive process is RECLAIMED (crash-resume — same machinery as steps);
   *  otherwise max+1 mints a fresh key. */
  const claimSelfImproveKey = (prefix: 'improver' | 'script'): { key: string; prior: StepSession | null } => {
    let max = 0;
    const re = new RegExp(`^${prefix}-(\\d+)\\.json$`);
    try {
      for (const name of readdirSync(sessionsDir)) {
        const m = re.exec(name);
        if (!m) continue;
        const n = Number(m[1]);
        if (n > max) max = n;
        const s = readStepSession(sessionsDir, `${prefix}-${m[1]}`);
        if (s !== null && s.status === 'running') return { key: `${prefix}-${m[1]}`, prior: s };
      }
    } catch {
      // fresh key below
    }
    return { key: `${prefix}-${max + 1}`, prior: null };
  };

  interface SelfImproveSession {
    structured: Record<string, unknown> | null;
    /** 'structured' — the harness-validated object; 'result-text' — recovered
     *  by parsing the final response as JSON (a `-p --agent` run on claude >=
     *  2.1.21x produces no structured_output — upstream claude-code#20625 —
     *  but the headless notes demand the exact JSON object as the final
     *  response); 'no-structured-output' — a SUCCESSFUL envelope with neither
     *  (pre-v2.1.205 claude, or a session that answered in prose):
     *  version-tolerance fallback, not a crash; 'failed' — no successful
     *  envelope within the crash-resume budget (or no fresh prompt was
     *  available). */
    source: 'structured' | 'result-text' | 'no-structured-output' | 'failed';
    detail: string | null;
  }

  /** Spawn ONE pinned headless improver/script-creator session and return its
   *  structured output. Same machinery as steps: UUID pinned + persisted
   *  BEFORE the spawn, crash-resume of an attempt that produced no successful
   *  envelope SHARING the step budget (MAX_CRASH_RESUMES per session), and
   *  envelope usage/cost folded into usage.json + the terminal stats
   *  enrichment (the session files live in the same sessions dir the
   *  transcript fold walks). `freshPrompt` is a thunk so a crash-RESUMED
   *  session (whose transcript already carries the original prompt) never
   *  needs it — it may return null to signal "cannot fresh-spawn" (e.g. the
   *  improvement brief was captured by a previous, died drive process).
   *  Failures never halt the chain — the caller records the conservative
   *  fallback and continues (05.2 failure modes). */
  const runSelfImproveSession = async (
    runner: ExecutorRunner,
    kind: 'improver' | 'script-creator',
    prefix: 'improver' | 'script',
    freshPrompt: () => string | null,
    /** ux-v2 b7 — the identity of the `improver:` / `script_creator:` class
     *  step this session IS (ux-v2 b4, `02` D15). `stepUuid` is the same value
     *  the caller stamps on `improver.started` / `script_creator.started`, so
     *  the hook events fired inside this `claude -p` name the same execution
     *  the lifecycle events do. Carried into the pre-spawn session binding. */
    identity: { stepUuid: string | null; iterationPath: string | null },
  ): Promise<SelfImproveSession> => {
    const { key, prior } = claimSelfImproveKey(prefix);
    const recordFile = recordPath(key);
    let sess: StepSession;
    let prompt: string;
    let resume: boolean;
    if (prior !== null && prior.crashes < MAX_CRASH_RESUMES) {
      // A previous drive died mid-session — resume the surviving transcript.
      sess = { ...prior, crashes: prior.crashes + 1 };
      prompt = buildSelfImproveCrashPrompt(kind);
      resume = true;
      progress(`${kind}.crash_resume`, {
        session: key,
        attempt: sess.crashes,
        detail: 'previous drive process died mid-session; resuming the surviving session',
      });
    } else {
      const p = freshPrompt();
      if (p === null) {
        return {
          structured: null,
          source: 'failed',
          detail: 'no spawn prompt available (the brief was not captured in this process and no session survives to resume)',
        };
      }
      sess = {
        session_id: randomUUID(),
        status: 'running',
        spawn_cwd: process.cwd(),
        ...(prior !== null
          ? { previous_session_ids: [prior.session_id, ...(prior.previous_session_ids ?? [])] }
          : {}),
        questions: [],
        crashes: 0,
      };
      prompt = p;
      resume = false;
    }
    writeStepSession(sessionsDir, key, sess);
    // ux-v2 b7: same pre-spawn binding the step path writes — see bindSession.
    bindSession(sess.session_id, runId, identity.stepUuid, identity.iterationPath);
    progress(`${kind}.session_started`, { session: key, session_id: sess.session_id, ...(resume ? { resumed: true } : {}) });
    for (;;) {
      rmSync(recordFile, { force: true });
      const exit = await runner({
        step_id: key,
        kind,
        prompt,
        model: null,
        effort: null,
        record_file: recordFile,
        session: { id: sess.session_id, resume },
        permission_mode: null,
      });
      const envelope = envelopeOf(exit);
      noteUsage(envelope);
      if (!detectedLimit && envelope) {
        const limit = detectProviderLimit(envelope);
        if (limit) detectedLimit = limit;
      }
      let structured = envelope?.structured_output ?? null;
      let structuredSource: 'structured' | 'result-text' = 'structured';
      if (structured === null && envelope !== null && !envelope.is_error) {
        // `-p --agent` on claude >= 2.1.21x ignores --json-schema (no
        // structured_output; claude-code#20625) — recover the record from the
        // final-response text the headless notes demand.
        structured = parseResultObject(envelope.result);
        if (structured !== null) structuredSource = 'result-text';
      }
      if (structured !== null) {
        sess.status = 'done';
        writeStepSession(sessionsDir, key, sess);
        try {
          writeFileSync(recordFile, scrub(JSON.stringify(structured)), 'utf8');
        } catch {
          // best-effort observability copy — the in-memory object is authoritative
        }
        return { structured, source: structuredSource, detail: null };
      }
      if (envelope !== null && !envelope.is_error) {
        // Version tolerance (05.2 review B): a SUCCESS envelope without
        // structured output OR a parseable final response (claude < 2.1.205,
        // a custom template without --json-schema, or a session that answered
        // in prose). A resume cannot fix this — fall back conservatively.
        sess.status = 'done';
        writeStepSession(sessionsDir, key, sess);
        return {
          structured: null,
          source: 'no-structured-output',
          detail:
            'session succeeded but produced no structured output — claude >= 2.1.205 (and --json-schema in the template) is required for reliable headless self-improvement',
        };
      }
      const why = envelope?.is_error
        ? `claude error: ${envelope.subtype ?? 'unknown'}`
        : exit.code === null
          ? `spawn failed: ${exit.error ?? 'unknown'}`
          : `no result envelope (exit ${exit.code})`;
      if (sess.crashes >= MAX_CRASH_RESUMES) {
        sess.status = 'done';
        writeStepSession(sessionsDir, key, sess);
        return { structured: null, source: 'failed', detail: why };
      }
      sess.crashes++;
      writeStepSession(sessionsDir, key, sess);
      progress(`${kind}.crash_resume`, { session: key, attempt: sess.crashes, detail: why });
      prompt = buildSelfImproveCrashPrompt(kind);
      resume = true;
    }
  };

  /** The MECHANICAL end-of-run retrospective (05.2.3) — drive performs the
   *  manager's documented procedure deterministically: partition
   *  .feedback/<run-id>/*.md by frontmatter `category`, ONE batch improver
   *  session for the doc-actionable set, sequential script-creators for its
   *  briefs, human-only one-line summaries into the returned summary (the
   *  final JSON's `retrospective` field) + a run.retrospective event. The
   *  feedback folder is DELETED on success and KEPT when the improver session
   *  failed outright (its input would be lost unprocessed); blocked/awaiting
   *  parks exit before this action can ever fire, so their feedback always
   *  survives (manager parity, 01§3.4). Unparseable/unknown-category files
   *  are counted as skipped and surfaced — never a halt. */
  const runRetrospective = async (lintWarnings: string[]): Promise<Record<string, unknown>> => {
    const retroRoot = worktreePipelineRoot ?? rootAbs;
    const feedbackDir = join(retroRoot, '.feedback', runId);
    const docActionable: { path: string; category: string }[] = [];
    const humanOnly: { category: string; path: string; summary: string }[] = [];
    let skipped = 0;
    let names: string[] = [];
    try {
      names = readdirSync(feedbackDir)
        .filter((n) => n.endsWith('.md'))
        .sort();
    } catch {
      // missing/unreadable folder — nothing to partition
    }
    for (const name of names) {
      const p = join(feedbackDir, name);
      try {
        const raw = readFileSync(p, 'utf8');
        const category = String(parseFrontmatter(raw).fields.category ?? '').trim();
        if (DOC_ACTIONABLE_CATEGORIES.has(category)) docActionable.push({ path: p, category });
        else if (HUMAN_ONLY_CATEGORIES.has(category)) humanOnly.push({ category, path: p, summary: feedbackSummaryLine(raw) });
        else skipped++;
      } catch {
        skipped++;
      }
    }
    progress('retrospective.started', {
      feedback_dir: feedbackDir,
      doc_actionable: docActionable.length,
      human_only: humanOnly.length,
      skipped,
    });

    let improverApplied = false;
    let improverSummary: string | null = null;
    let improverFailed = false;
    const scripts: { outcome: string; script_path: string | null }[] = [];
    if (docActionable.length > 0) {
      // Retro-internal events are the CALLER's to emit — the whole
      // retrospective is one engine action, invisible to the auto-emitter.
      // ux-v2 b4: mint the identity ONCE, before the started event, and carry
      // the SAME value onto the completed event — this is the ONE improver
      // session the retrospective spawns for this run's feedback batch.
      const retroImproverUuid = newId();
      safeEmit('improver.started', { run_id: runId, iteration_path: retroRoot, step_uuid: retroImproverUuid });
      const res = await runSelfImproveSession(
        improverRunner,
        'improver',
        'improver',
        () => buildRetroImproverPrompt(retroRoot, feedbackDir, runId, lintWarnings),
        { stepUuid: retroImproverUuid, iterationPath: retroRoot },
      );
      if (res.structured === null) {
        progress('warning', { detail: `retrospective improver pass not applied: ${res.detail}` });
      }
      improverFailed = res.source === 'failed';
      const parsed = parseImproverOutput(res.structured);
      improverApplied = parsed.applied;
      improverSummary = parsed.summary;
      safeEmit('improver.completed', {
        run_id: runId,
        iteration_path: retroRoot,
        applied: parsed.applied,
        has_script_brief: parsed.script_creation_briefs.length > 0,
        step_uuid: retroImproverUuid,
      });
      if (parsed.applied) {
        noteImprovementApplied({
          source: 'retrospective',
          pipeline_root: retroRoot,
          summary: parsed.summary,
          script_briefs: parsed.script_creation_briefs.length,
        });
      }
      // Script-creators are STRICTLY SEQUENTIAL — they edit shared docs. Each
      // brief is its OWN spawn, so each gets its own fresh identity (never the
      // improver's, never a sibling brief's).
      for (let i = 0; i < parsed.script_creation_briefs.length; i++) {
        const retroScriptUuid = newId();
        safeEmit('script_creator.started', { run_id: runId, iteration_path: retroRoot, step_uuid: retroScriptUuid });
        const sres = await runSelfImproveSession(
          scriptCreatorRunner,
          'script-creator',
          'script',
          () =>
            buildScriptCreatorPrompt(parsed.script_creation_briefs[i], i + 1, parsed.script_creation_briefs.length, runId, retroRoot),
          { stepUuid: retroScriptUuid, iterationPath: retroRoot },
        );
        if (sres.structured === null) {
          progress('warning', {
            detail: `retrospective script-creator ${i + 1}/${parsed.script_creation_briefs.length} refused: ${sres.detail}`,
          });
        }
        const sparsed = parseScriptCreatorOutput(sres.structured);
        scripts.push({ outcome: sparsed.outcome, script_path: sparsed.script_path });
        safeEmit('script_creator.completed', {
          run_id: runId,
          iteration_path: retroRoot,
          script_path: sparsed.script_path,
          outcome: sparsed.outcome,
          step_uuid: retroScriptUuid,
        });
        if (sparsed.outcome !== 'refused') {
          noteImprovementApplied({
            source: 'script-creator',
            pipeline_root: retroRoot,
            script_path: sparsed.script_path,
            outcome: sparsed.outcome,
            summary: sparsed.summary,
          });
        }
      }
    }

    let feedbackDeleted = false;
    if (!improverFailed) {
      try {
        rmSync(feedbackDir, { recursive: true, force: true });
        feedbackDeleted = true;
      } catch (e) {
        progress('warning', {
          detail: `failed to delete processed feedback folder ${feedbackDir}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } else {
      progress('warning', {
        detail: `feedback preserved at ${feedbackDir} — the retrospective improver session failed; re-run the improver manually`,
      });
    }

    // run.retrospective (07): counts + paths + one-line summaries ONLY.
    safeEmit('run.retrospective', {
      run_id: runId,
      pipeline_root: retroRoot,
      doc_actionable: docActionable.length,
      human_only: humanOnly.length,
      skipped,
      improver_applied: improverApplied,
      scripts_created: scripts.filter((s) => s.outcome !== 'refused').length,
      human_only_summaries: JSON.stringify(humanOnly),
    });
    progress('retrospective.completed', {
      doc_actionable: docActionable.length,
      human_only: humanOnly.length,
      skipped,
      improver_applied: improverApplied,
      scripts: scripts.length,
    });
    return {
      feedback_dir: feedbackDir,
      doc_actionable: docActionable.length,
      human_only: humanOnly,
      skipped,
      improver_applied: improverApplied,
      ...(improverSummary !== null ? { improver_summary: improverSummary } : {}),
      scripts,
      feedback_deleted: feedbackDeleted,
    };
  };

  /** Self-improvement extras for the terminal (done/halt) JSON: the mechanical
   *  retrospective summary and — when improvements were applied but NO
   *  finalize hook landed them (05 §Cloud interplay) — the preserve-workspace
   *  cue, so an ephemeral (cloud job) checkout is not torn down with unshipped
   *  improvements inside. */
  const finalExtras = (): Record<string, unknown> => ({
    ...(retrospectiveSummary !== null ? { retrospective: retrospectiveSummary } : {}),
    ...(improvementsApplied ? { improvements_applied: true } : {}),
    ...(improvementsApplied && !finalizeLandedOk
      ? {
          preserve_workspace: true,
          preserve_workspace_reason:
            'self-improvement was applied in this working tree but no finalize hook landed it — preserve the workspace or the improvements are lost',
        }
      : {}),
  });

  /** A parked needs-input question, surfaced in the final awaiting-input JSON. */
  interface Awaiting {
    step_id: string;
    iteration_path: string;
    session_id: string;
    question: StepQuestion;
    question_id: string;
  }

  /** Spawn ONE step-executor and fold its record into a LayerResultEntry
   *  (+ the raw record object for the sequential path). The record comes from
   *  the envelope's schema-validated structured_output when present (drive
   *  persists it to the record file itself); otherwise from the record file
   *  the executor wrote.
   *
   *  Sessions: every fresh spawn pins a new UUID (persisted BEFORE the spawn).
   *  When the step is parked awaiting-input and an answer is available, the
   *  SAME session is resumed with the answer instead. A needs-input outcome
   *  parks the step (allowInput) or maps to halted (parallel layers, v1). */
  const execStep = async (
    step: ActionStep,
    opts: { allowInput: boolean },
  ): Promise<{ entry: LayerResultEntry; raw: Record<string, unknown> | null; recordFile: string; awaiting?: Awaiting }> => {
    // Composition (T3-10): a step surfaced from a nested CHILD run carries its
    // run/pipeline annotations (ActionStep.run_id / .pipeline_root). Key its
    // record/session files on the child run (parent/child step_ids may
    // collide) and build its prompt against the child's run id, pipeline root
    // and task file — the child's feedback journal must land in the CHILD's
    // .feedback/<child_run_id>/, which drive creates lazily here (the parent's
    // was created at run start).
    const stepRunId = step.run_id ?? runId;
    // Worktree-scoped runs (P2/b3): the run's pipeline tree is the WORKTREE
    // copy — the spawn prompt's pipeline_root (and with it the Tier-2 feedback
    // dir the executor journals into) derives from it, mirroring the manager
    // contract, so the engine's worktree-scoped retrospective gate counts the
    // files the executors actually wrote. Records/sessions/usage stay
    // MAIN-rooted (run bookkeeping, D6).
    const stepRootAbs = step.pipeline_root ? resolve(step.pipeline_root) : (worktreePipelineRoot ?? rootAbs);
    const stepKey = step.run_id ? `${step.run_id}-${step.step_id}` : step.step_id;
    const stepTaskFile = step.run_id ? taskFileFor(stepRootAbs, stepRunId) : taskFile;
    if (step.run_id) {
      try {
        mkdirSync(join(stepRootAbs, '.feedback', stepRunId), { recursive: true });
        const cgi = join(stepRootAbs, '.feedback', '.gitignore');
        if (!existsSync(cgi)) writeFileSync(cgi, '*\n', 'utf8');
      } catch {
        // best-effort — a missing feedback dir only degrades Tier-2 journaling
      }
    }
    // The executor WRITES the drop file (tmp dir, --add-dir-granted — the only
    // path headless acceptEdits lets it write on claude >= 2.1.21x); drive
    // persists the CANONICAL observability copy after recovery. Consumers of
    // r.recordFile (blocker briefs, final JSONs) get the canonical path.
    const recordFile = dropRecordPath(stepKey);
    const canonicalRecordFile = recordPath(stepKey);
    /** Halt this step (and close its session — every non-awaiting exit does). */
    const halted = (reason: string): { entry: LayerResultEntry; raw: null; recordFile: string } => {
      sess.status = 'done';
      writeStepSession(sessionsDir, stepKey, sess);
      progress('step.failed', { step_id: step.step_id, reason });
      return {
        entry: { step_id: step.step_id, outcome: 'halted', halt_reason: reason },
        raw: null,
        recordFile: canonicalRecordFile,
      };
    };
    /** Park this step on a question — the run exits 4 and the caller resumes
     *  the SAME session with the user's answer. */
    const park = (question: StepQuestion, questionId: string, sessionId: string, repeat: boolean) => {
      progress('step.awaiting_input', { step_id: step.step_id, question: question.text, question_id: questionId, ...(repeat ? { repeat: true } : {}) });
      return {
        entry: { step_id: step.step_id, outcome: 'halted' as const, halt_reason: 'awaiting input' },
        raw: null,
        recordFile: canonicalRecordFile,
        // SOURCE path (env-variables a5, E11): this iteration_path is surfaced
        // in the exit-4 JSON, echoed in the `--resume --start <step-name>` hint, and
        // machine-fed back as `--start` by pipeline-ui's answer flow — a
        // rendered `.runtime/<run>/rendered/` path there would make the engine
        // synthesize an off-plan step on the answer resume instead of resuming
        // the parked plan step. Identical to step.path on non-rendered runs.
        awaiting: { step_id: step.step_id, iteration_path: step.source_path, session_id: sessionId, question, question_id: questionId },
      };
    };

    // Session: resume with the pending answer, resume an interrupted session
    // (a previous drive died mid-step — the transcript is on disk), or pin a
    // fresh UUID.
    const prior = readStepSession(sessionsDir, stepKey);
    const warnCwd = (s: StepSession): void => {
      if (s.spawn_cwd && s.spawn_cwd !== process.cwd()) {
        progress('warning', {
          detail: `resuming session ${s.session_id} from cwd ${process.cwd()} but it was spawned from ${s.spawn_cwd} — claude session lookup is directory-scoped and may not find it`,
        });
      }
    };
    let sess: StepSession;
    let initialPrompt: string;
    let initialResume: boolean;
    if (prior !== null && prior.status === 'awaiting-input') {
      if (pendingAnswer === null) {
        // Parked and still no answer — don't burn a fresh executor re-deriving
        // the same question; surface the stored one again.
        const question = prior.questions[prior.questions.length - 1] ?? {
          text: 'step is awaiting input (no stored question found)',
          context: null,
          options: null,
        };
        const questionId = question.question_id ?? randomUUID();
        return park(question, questionId, prior.session_id, true);
      }
      sess = { ...prior, status: 'running' };
      warnCwd(sess);
      initialPrompt = buildAnswerPrompt(pendingAnswer, recordFile, stepRootAbs);
      initialResume = true;
      pendingAnswer = null; // one-shot: consumed by this step
    } else if (prior !== null && prior.status === 'running' && prior.crashes < MAX_CRASH_RESUMES) {
      sess = { ...prior, crashes: prior.crashes + 1 };
      warnCwd(sess);
      progress('step.crash_resume', {
        step_id: step.step_id,
        attempt: sess.crashes,
        detail: 'previous drive process died mid-step; resuming the surviving session',
      });
      initialPrompt = buildCrashResumePrompt(recordFile, stepRootAbs);
      initialResume = true;
    } else {
      // Fresh session. If this step already ran in this run (graph loop-back /
      // spent crash budget), keep the replaced session id(s) so the terminal
      // stats fold covers every execution's transcript, not just the last.
      sess = {
        session_id: randomUUID(),
        status: 'running',
        spawn_cwd: process.cwd(),
        ...(prior !== null
          ? { previous_session_ids: [prior.session_id, ...(prior.previous_session_ids ?? [])] }
          : {}),
        questions: [],
        crashes: 0,
      };
      // Child-run steps (T3-10) get the CHILD's run id / pipeline root / task
      // file — their feedback journal and record protocol belong to that run.
      initialPrompt = buildStepPrompt(step, stepRunId, stepRootAbs, recordFile, stepTaskFile);
      initialResume = false;
    }
    writeStepSession(sessionsDir, stepKey, sess);
    // ux-v2 b7: bind session → (run, step) BEFORE the executor spawns, so the
    // hooks firing inside `claude -p` attribute to this run AND this step
    // (ActionStep.step_uuid, ux-v2 b4) by construction.
    bindSession(sess.session_id, stepRunId, step.step_uuid, step.source_path);

    // Manifest fallback resolves against the step's OWN pipeline (a child
    // run's steps read the child manifest's permission-mode, not the parent's).
    const permissionMode = resolvePermissionMode(step.path, stepRootAbs);

    /** One executor spawn against the pinned session; recovers the record
     *  through the belt-and-braces channel ladder and folds usage.
     *
     *  Channel ladder (e7 DEFECT-1 — each channel covers a claude-version /
     *  template reality; the FIRST valid record wins, and drive persists the
     *  canonical `.runtime/<run>/records/` copy itself):
     *   1. `structured_output` — harness-validated (claude <= 2.1.205 default
     *      template; any future claude where `-p --agent` supports
     *      --json-schema again).
     *   2. the DROP record file (tmp dir, --add-dir-granted) — the prompt's
     *      step_record_file; the only executor-writable file path under
     *      headless acceptEdits on claude >= 2.1.21x.
     *   3. the CANONICAL record file — legacy channel: custom templates /
     *      permission modes where `.runtime/<run>/records/` is writable, and
     *      sessions parked under an older CLI whose earlier prompt named it.
     *   4. the final-response TEXT parsed as JSON — `-p --agent` on 2.1.21x
     *      silently ignores --json-schema (no structured_output; upstream
     *      claude-code#20625), so the prompt demands the record object as the
     *      exact final response and drive parses it back out.
     *  An INVALID record (wrong outcome) from any file/text channel is still
     *  surfaced for triage when no channel produced a valid one. */
    const runAttempt = async (promptText: string, resume: boolean) => {
      // Never trust a stale record from a previous attempt — on EITHER path.
      rmSync(recordFile, { force: true });
      rmSync(canonicalRecordFile, { force: true });
      try {
        mkdirSync(dropRecordsDir, { recursive: true }); // tmp dirs can be reaped between attempts
      } catch {
        // the read below just misses — the other channels still apply
      }
      const exit = await executor({
        step_id: step.step_id,
        prompt: promptText,
        model: step.model,
        effort: step.effort ?? null,
        record_file: recordFile,
        session: { id: sess.session_id, resume },
        permission_mode: permissionMode,
      });
      const envelope = envelopeOf(exit);
      noteUsage(envelope);
      // Detect provider-limit errors (06.7) — capture the first one encountered
      // for the final JSON so the caller can implement retry policy.
      if (!detectedLimit && envelope) {
        const limit = detectProviderLimit(envelope);
        if (limit) detectedLimit = limit;
      }
      let attemptRaw: Record<string, unknown> | null = null;
      let source: string | null = null;
      const structured = envelope?.structured_output ?? null;
      if (validRecord(structured)) {
        // Authoritative: the harness validated this against the step schema.
        attemptRaw = { ...structured, kind: 'step' };
        source = 'structured_output';
      }
      if (attemptRaw === null || !validRecord(attemptRaw)) {
        const drop = readRecordFile(recordFile);
        if (drop !== null && (attemptRaw === null || validRecord(drop))) {
          attemptRaw = drop;
          if (validRecord(drop)) source = 'record-file';
        }
      }
      if (attemptRaw === null || !validRecord(attemptRaw)) {
        const legacy = readRecordFile(canonicalRecordFile);
        if (legacy !== null && (attemptRaw === null || validRecord(legacy))) {
          attemptRaw = legacy;
          if (validRecord(legacy)) source = 'record-file-legacy';
        }
      }
      if ((attemptRaw === null || !validRecord(attemptRaw)) && envelope !== null && !envelope.is_error) {
        const fromText = parseResultObject(envelope.result);
        if (fromText !== null && (attemptRaw === null || validRecord(fromText))) {
          attemptRaw = fromText;
          if (validRecord(fromText)) source = 'result-text';
        }
      }
      if (validRecord(attemptRaw)) {
        attemptRaw = { ...attemptRaw, kind: 'step' };
        // Persist the canonical observability copy — drive's own write, never
        // permission-gated. The record file consumers see is ALWAYS this one.
        try {
          writeFileSync(canonicalRecordFile, scrub(JSON.stringify(attemptRaw)), 'utf8');
        } catch (e) {
          progress('warning', {
            detail: `failed to persist record to ${canonicalRecordFile}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
        progress('step.record', { step_id: step.step_id, source });
      } else {
        // No valid record from ANY channel — if the harness DENIED the record
        // write, say so loudly (distinguishable from "executor produced none").
        const denied = deniedRecordWrite(envelope, recordFile, canonicalRecordFile);
        if (denied !== null) {
          progress('step.record_write_denied', {
            step_id: step.step_id,
            path: denied,
            detail:
              'the claude permission gate refused the record-file write (sensitive-path auto-deny); ' +
              'the default contract drops records in an --add-dir-granted tmp dir — a denial usually means ' +
              'a custom executor template/prompt override still points records at a path under .claude/',
          });
        }
      }
      return { exit, envelope, raw: attemptRaw };
    };

    progress('step.started', {
      step_id: step.step_id,
      index: step.index,
      // SOURCE path label (env-variables a5): keep the drive journal keyed on
      // the stable source identity like every other observability surface;
      // the executor still receives the rendered step.path via its prompt.
      path: step.source_path,
      model: step.model,
      effort: step.effort ?? null,
      session_id: sess.session_id,
      ...(step.run_id ? { run_id: step.run_id } : {}),
      ...(initialResume ? { resumed: true } : {}),
    });
    let att = await runAttempt(initialPrompt, initialResume);
    // Crash-resume loop: no valid record from either source → resume the SAME
    // session ("you were interrupted") while the per-session budget lasts.
    while (!validRecord(att.raw) && sess.crashes < MAX_CRASH_RESUMES) {
      sess.crashes++;
      writeStepSession(sessionsDir, stepKey, sess);
      progress('step.crash_resume', {
        step_id: step.step_id,
        attempt: sess.crashes,
        detail:
          att.raw === null
            ? noRecordReason(recordFile, att.exit, att.envelope)
            : `invalid outcome '${att.raw.outcome}' in ${recordFile}`,
      });
      att = await runAttempt(buildCrashResumePrompt(recordFile, stepRootAbs), true);
    }
    const { exit, envelope } = att;
    const raw = att.raw;

    // needs-input — intercepted BEFORE the engine ever sees the record.
    if (raw !== null && raw.outcome === 'needs-input') {
      const question = extractQuestion(raw);
      const questionId = randomUUID();
      const questionWithId = { ...question, question_id: questionId };
      sess.questions.push(questionWithId);
      if (sess.questions.length > MAX_QUESTIONS_PER_STEP) {
        return halted(
          `question limit exhausted (${MAX_QUESTIONS_PER_STEP} answered, then asked again): ` +
            sess.questions.map((q, i) => `[${i + 1}] ${q.text}`).join(' '),
        );
      }
      if (!opts.allowInput) {
        return halted(
          `step asked for input inside a parallel layer (not supported in headless v1 — parallel steps must be self-contained): ${question.text}`,
        );
      }
      sess.status = 'awaiting-input';
      writeStepSession(sessionsDir, stepKey, sess);
      return park(questionWithId, questionId, sess.session_id, false);
    }

    if (!validRecord(raw)) {
      const reason =
        raw === null ? noRecordReason(recordFile, exit, envelope) : `invalid outcome '${raw.outcome}' in ${recordFile}`;
      return halted(reason);
    }
    sess.status = 'done';
    writeStepSession(sessionsDir, stepKey, sess);
    progress('step.completed', {
      step_id: step.step_id,
      outcome: raw.outcome,
      ...(envelope?.total_cost_usd !== null && envelope?.total_cost_usd !== undefined
        ? { cost_usd: envelope.total_cost_usd }
        : {}),
    });
    return {
      entry: {
        step_id: step.step_id,
        outcome: raw.outcome as LayerResultEntry['outcome'],
        worktree_branch: typeof raw.worktree_branch === 'string' ? raw.worktree_branch : null,
        worktree_path: typeof raw.worktree_path === 'string' ? raw.worktree_path : null,
        has_improvement_brief: raw.has_improvement_brief === true,
        halt_reason: typeof raw.halt_reason === 'string' ? raw.halt_reason : null,
      },
      raw,
      // The CANONICAL persisted copy — what blocker briefs / consumers read
      // (the drop file is ephemeral tmp state and is cleaned at terminal).
      recordFile: canonicalRecordFile,
    };
  };

  // The path of the record file whose step reported blocked-delegating — the
  // blocker brief lives inside it; surfaced in the final blocked JSON.
  let blockerRecordFile: string | null = null;

  // Live worktrees of the most recent parallel layer that have NOT been merged
  // + removed yet. Refreshed per layer, cleared by a clean merge, narrowed to
  // the unmerged remainder by a failed one — so a halt (before OR at merge) can
  // tell the human exactly which branches/worktrees leaked (B2).
  let leakedWorktrees: MergeBranch[] = [];

  let record: NextRecord | null = null;
  let first = true;
  for (let guard = 0; guard < 10_000; guard++) {
    const res = invokeNext({
      root,
      runId,
      // --start belongs to the init/resume call only; loop calls carry a record.
      start: first ? a.start : undefined,
      defaultModel: a.defaultModel,
      modelOverrides: a.modelOverrides,
      defaultEffort: a.defaultEffort,
      effortOverrides: a.effortOverrides,
      // --var/--vars-file belong to the init/resume call only (the engine
      // freezes the map into next.json there; loop calls must not re-supply
      // it or they would trip the D11 frozen-variables error).
      ...(first && cliVars !== undefined ? { cliVars } : {}),
      record,
      resume: first && a.resume,
      manualHooks: false,
      callBudgetMs: Infinity, // no outer Bash ceiling — removes the budget-fit `continue`, but NOT the MAX_SCRIPT_EXECS_PER_CALL exec-cap one (mustContinue fires on the exec cap regardless of budget; handled below) (DESIGN.md §7)
    });
    first = false;
    record = null;
    const action = res.action;
    if (Array.isArray(res.out.warnings) && res.out.warnings.length) {
      progress('warning', { detail: (res.out.warnings as unknown[]).join('; ') });
    }
    if (res.out.provisioned) progress('worktree.provisioned', res.out.provisioned as Record<string, unknown>);
    if (res.out.finalized) progress('worktree.finalized', res.out.finalized as Record<string, unknown>);
    if (res.out.teardown) progress('worktree.teardown', res.out.teardown as Record<string, unknown>);
    // Worktree-scoped runs (P2/b3): remember the execution pipeline root —
    // step prompts, improver targets, and the retrospective all key on it.
    if (typeof res.out.worktree_pipeline_root === 'string') worktreePipelineRoot = res.out.worktree_pipeline_root;
    // A finalize hook that reported ok IS the improvements' landing path
    // (05 §Cloud interplay) — the preserve-workspace cue keys on its absence.
    if (res.out.finalized && (res.out.finalized as Record<string, unknown>).ok === true) finalizeLandedOk = true;

    switch (action.action) {
      case 'run-step': {
        if (action.concurrent) {
          const results = await Promise.all(action.steps.map((s) => execStep(s, { allowInput: false })));
          results.forEach((r, i) => noteBrief(action.steps[i], r.raw));
          for (const r of results) {
            if (r.entry.outcome === 'blocked-delegating') blockerRecordFile = r.recordFile;
          }
          record = { kind: 'layer', results: results.map((r) => r.entry) };
          // Track this layer's live worktrees: until the merge cleans them up
          // they are what leaks if the run halts here (B2).
          leakedWorktrees = results
            .map((r) => r.entry)
            .filter((e) => e.worktree_branch || e.worktree_path)
            .map((e) => ({
              step_id: e.step_id,
              branch: e.worktree_branch ?? '<unknown-branch>',
              path: e.worktree_path ?? '',
            }));
        } else {
          // T3-14 approval gate: a DETERMINISTIC needs-input step — no
          // executor is ever spawned for it. With a pending --answer the
          // decision is delivered as a {kind:'gate-answer'} record (the
          // command layer parses {decision, comment}: approve completes the
          // gate and routing proceeds; reject/unparseable halts). Without
          // one, park the run exactly like an agent needs-input (exit 4) —
          // the question carries the additive approval:{required_role}
          // marker the control plane keys on; there is no claude session
          // behind a gate, so session_id is null.
          const gateStep = action.steps[0];
          if (gateStep.type === 'gate') {
            const question = (res.out.gate_question as GateQuestion | undefined) ?? null;
            if (pendingAnswer !== null) {
              progress('gate.answer_delivered', { step_id: gateStep.step_id });
              record = { kind: 'gate-answer', answer: pendingAnswer };
              pendingAnswer = null; // one-shot: consumed by this gate
              continue;
            }
            // Stable question identity for the gate (no claude session to pin
            // it to): deterministic on (run, step), so repeat re-entries and
            // the cloud answer round trip correlate on the SAME id (06.2.1).
            const gateQuestionId = `gate:${runId}:${gateStep.step_id}`;
            progress('run.awaiting_input', {
              step_id: gateStep.step_id,
              question: question?.text ?? null,
              question_id: gateQuestionId,
              approval_required_role: question?.approval.required_role ?? null,
            });
            // e7 DEFECT-3: journal the park — the cloud ingest consumes this
            // event (runs/ingest.ts `awaiting_input`) to set the run's parked
            // status; without it a dispatched run looks `running` server-side
            // and the sweeper's HOLD disposition is unreachable. Shape per
            // @baizor/pipeline-protocol AwaitingInputData:
            // { run_id, iteration, question_id, question:{text,…} } —
            // additive fields only beyond that (`step_name`, v5's rename of
            // v4's `step_id`, and `iteration_path`; the schema passes unknown
            // keys through, so both old and new readers stay satisfied).
            journalEvent(
              'awaiting_input',
              {
                run_id: runId,
                iteration: gateStep.index,
                question_id: gateQuestionId,
                question: { ...(question ?? { text: `Approval required to proceed past gate '${gateStep.step_id}'.` }), question_id: gateQuestionId },
                step_name: gateStep.step_id,
                iteration_path: gateStep.path,
              },
              null,
            );
            enrichStats(false);
            return finalJson(
              {
                status: 'awaiting-input',
                step_id: gateStep.step_id,
                iteration_path: gateStep.path,
                session_id: null,
                question_id: gateQuestionId,
                question,
                detail:
                  'the step is an APPROVAL GATE; deliver the decision by re-running pipeline drive with ' +
                  `--resume --start ${gateStep.step_id} --answer '{"decision":"approve|reject","comment":<string|null>}' ` +
                  '(or --answer-file <path>) — an unparseable answer halts the run, never approves it',
              },
              4,
            );
          }
          const r = await execStep(action.steps[0], { allowInput: true });
          noteBrief(action.steps[0], r.raw);
          if (r.awaiting !== undefined) {
            // Park the run WITHOUT feeding the engine: on re-entry it re-issues
            // this same step and drive resumes the pinned session with --answer.
            progress('run.awaiting_input', {
              step_id: r.awaiting.step_id,
              session_id: r.awaiting.session_id,
              question: r.awaiting.question.text,
              question_id: r.awaiting.question_id,
            });
            // e7 DEFECT-3: journal the park — the cloud ingest consumes this
            // event (runs/ingest.ts `awaiting_input`) to set the run's parked
            // status; without it a dispatched run looks `running` server-side,
            // the sweeper's HOLD disposition is unreachable, and a parked run
            // gets re-dispatched on lease death (design-forbidden). Shape per
            // @baizor/pipeline-protocol AwaitingInputData: { run_id, iteration,
            // question_id, question:{text, context, options} } — additive
            // fields (step_name — v5's rename of v4's step_id — and
            // iteration_path) beyond that. Emitted on the
            // repeat park too (a --resume without --answer), restoring the
            // parked state after the re-entry's iteration.started un-parked it.
            journalEvent(
              'awaiting_input',
              {
                run_id: runId,
                iteration: action.steps[0].index,
                question_id: r.awaiting.question_id,
                question: { ...r.awaiting.question, question_id: r.awaiting.question_id },
                step_name: r.awaiting.step_id,
                iteration_path: r.awaiting.iteration_path,
              },
              r.awaiting.session_id,
            );
            enrichStats(false);
            return finalJson(
              {
                status: 'awaiting-input',
                step_id: r.awaiting.step_id,
                iteration_path: r.awaiting.iteration_path,
                session_id: r.awaiting.session_id,
                question_id: r.awaiting.question_id,
                question: r.awaiting.question,
                detail:
                  'the step asked a question; answer it, then re-run pipeline drive with ' +
                  `--resume --start ${r.awaiting.step_id} --answer "<text>" (or --answer-file <path>) — ` +
                  'the SAME executor session resumes with your answer',
              },
              4,
            );
          }
          if (r.raw === null) {
            record = { kind: 'step', outcome: 'halted', halt_reason: r.entry.halt_reason } as StepRecord;
          } else {
            // Valid record → feed it to the engine verbatim (kind pinned to
            // 'step' so a record that omitted it still routes correctly).
            record = { ...r.raw, kind: 'step' } as unknown as NextRecord;
            if (r.raw.outcome === 'blocked-delegating') blockerRecordFile = r.recordFile;
          }
        }
        continue;
      }
      case 'merge': {
        const m = runMerge(action.branches, git, rootAbs, progress);
        record = m.record;
        leakedWorktrees = m.leaked;
        continue;
      }
      case 'run-improver': {
        if (!selfImprove) {
          // PIPELINE_DRIVE_SELF_IMPROVE off — the v1 skip, byte-identical.
          progress('warning', {
            detail: `self-improvement skipped in headless v1 (improvement brief for ${action.iteration_path} not applied)`,
          });
          record = { kind: 'improver', applied: false, script_briefs: 0 };
          continue;
        }
        scriptBriefs = [];
        persistScriptBriefs(scriptBriefs);
        const res = await runSelfImproveSession(
          improverRunner,
          'improver',
          'improver',
          () => {
            const brief = takeBrief(action.iteration_path);
            return brief === null ? null : buildImproverPrompt(action.iteration_path, brief, runId, worktreePipelineRoot ?? rootAbs);
          },
          // ux-v2 b7: the engine minted this action's step_uuid (b4) — the same
          // one the auto-emitted improver.started carries.
          { stepUuid: action.step_uuid, iterationPath: action.iteration_path },
        );
        if (res.structured === null) {
          progress('warning', { detail: `improver pass for ${action.iteration_path} not applied: ${res.detail}` });
        }
        const parsed = parseImproverOutput(res.structured);
        scriptBriefs = parsed.script_creation_briefs;
        persistScriptBriefs(scriptBriefs);
        if (parsed.applied) {
          noteImprovementApplied({
            source: 'tier1',
            iteration_path: action.iteration_path,
            summary: parsed.summary,
            script_briefs: scriptBriefs.length,
          });
        }
        // improver.started/completed events + stats lines are auto-emitted by
        // invokeNext around this Tier-1 action/record — drive emits nothing.
        record = { kind: 'improver', applied: parsed.applied, script_briefs: scriptBriefs.length };
        continue;
      }
      case 'run-script-creator': {
        if (!selfImprove) {
          // PIPELINE_DRIVE_SELF_IMPROVE off — the v1 skip, byte-identical.
          progress('warning', {
            detail: `self-improvement skipped in headless v1 (script-creation brief ${action.number}/${action.of} refused)`,
          });
          record = { kind: 'script', outcome: 'refused', script_path: null };
          continue;
        }
        if (scriptBriefs.length === 0) scriptBriefs = loadScriptBriefs(); // re-entry after a mid-queue crash
        const res = await runSelfImproveSession(
          scriptCreatorRunner,
          'script-creator',
          'script',
          () => {
            const brief = scriptBriefs[action.number - 1] ?? null;
            return brief === null
              ? null
              : buildScriptCreatorPrompt(brief, action.number, action.of, runId, worktreePipelineRoot ?? rootAbs);
          },
          // ux-v2 b7: per-brief identity — each `number` is its own spawn and
          // its own UUID (see the run-script-creator action's step_uuid doc).
          { stepUuid: action.step_uuid, iterationPath: action.iteration_path },
        );
        if (res.structured === null) {
          progress('warning', { detail: `script-creator ${action.number}/${action.of} refused: ${res.detail}` });
        }
        const parsed = parseScriptCreatorOutput(res.structured);
        if (parsed.outcome !== 'refused') {
          noteImprovementApplied({
            source: 'script-creator',
            iteration_path: action.iteration_path,
            script_path: parsed.script_path,
            outcome: parsed.outcome,
            summary: parsed.summary,
          });
        }
        // The outcome is recorded VERBATIM (never re-mapped) — the engine and
        // the auto-emitted script_creator.completed event key on it.
        record = { kind: 'script', outcome: parsed.outcome, script_path: parsed.script_path };
        continue;
      }
      case 'retrospective': {
        if (!selfImprove) {
          // PIPELINE_DRIVE_SELF_IMPROVE off — the v1 skip, byte-identical.
          progress('warning', {
            detail: `retrospective skipped in headless v1 — feedback left at ${join(rootAbs, '.feedback', runId)} for a manual improver pass`,
          });
          record = { kind: 'retro', done: true };
          continue;
        }
        retrospectiveSummary = await runRetrospective(action.lint_warnings ?? []);
        record = { kind: 'retro', done: true };
        continue;
      }
      case 'blocked': {
        progress('run.blocked', { blocker_record_file: blockerRecordFile });
        enrichStats(false);
        return finalJson(
          {
            status: 'blocked',
            blocker_record_file: blockerRecordFile,
            detail:
              'a step reported blocked-delegating; resolve the blocker (see the blocker_delegation brief in the record file), then re-run pipeline drive with --resume --start <same-step>',
          },
          3,
        );
      }
      case 'done': {
        progress('run.completed', {});
        enrichStats(true);
        cleanupDropDir();
        return finalJson({ status: 'completed', ...finalExtras() }, 0);
      }
      case 'halt': {
        // Surface leaked layer worktrees in the final stderr summary (B2): on a
        // layer halt before merge, or a merge halt, the human must know exactly
        // which branches/worktrees are left to clean up.
        if (leakedWorktrees.length) {
          progress('run.leaked_worktrees', {
            detail: `not merged / not removed — clean up manually: ${describeBranches(leakedWorktrees)}`,
          });
        }
        progress('run.halted', { status: action.status, reason: action.reason });
        enrichStats(true);
        cleanupDropDir();
        return finalJson(
          {
            status: action.status,
            reason: action.reason,
            ...(detectedLimit ? { provider_limit: detectedLimit } : {}),
            ...finalExtras(),
          },
          1,
        );
      }
      case 'continue': {
        // §7 call-budget hand-off. Even under drive's infinite budget, a
        // graph-mode all-script loop that iterates past MAX_SCRIPT_EXECS_PER_CALL
        // inside ONE invokeNext call parks the pending dispatch and returns
        // {action:'continue'} (mustContinue fires on the exec cap regardless of
        // budget). Mirror the manager: perform NOTHING, feed the continue record
        // straight back. The fresh invokeNext call resets the per-call exec
        // counter, so the loop re-issues the SAME pending dispatch and keeps
        // advancing — still bounded by this loop's own guard for a runaway.
        record = { kind: 'continue' };
        continue;
      }
      default: {
        // provision/finalize/teardown never surface here (manualHooks:false makes
        // invokeNext execute them in-process). Defensive: never loop on an
        // unactuatable action.
        return finalJson(
          {
            status: 'halted',
            reason: `pipeline drive cannot actuate action '${action.action}'`,
            ...(detectedLimit ? { provider_limit: detectedLimit } : {}),
          },
          1,
        );
      }
    }
  }
  return finalJson(
    {
      status: 'halted',
      reason: 'drive loop guard exceeded (10000 engine calls)',
      ...(detectedLimit ? { provider_limit: detectedLimit } : {}),
    },
    1,
  );
}

/** `branch @ worktree-path, …` — the unmerged/leaked enumeration format shared
 *  by the merge-halt record detail and the driver's final stderr summary. */
function describeBranches(branches: MergeBranch[]): string {
  return branches.map((b) => `${b.branch} @ ${b.path || '<no worktree path>'}`).join(', ');
}

/** A GENUINE textual merge conflict, as opposed to any other merge failure
 *  (dirty index, missing user.email, pre-existing unmerged state, …). realGit
 *  runs with LC_ALL=C (stableEnv), so these English markers are stable. */
function isMergeConflict(m: GitResult): boolean {
  return /(^|\n)CONFLICT\b|Automatic merge failed|fix conflicts and then commit/.test(`${m.stdout}\n${m.stderr}`);
}

interface MergeOutcome {
  record: NextRecord;
  /** The layer branches NOT merged (worktrees still on disk) when the merge
   *  halted; empty on a clean merge. */
  leaked: MergeBranch[];
}

/** Merge each layer branch SEQUENTIALLY from the PROJECT ROOT enclosing the
 *  pipeline root — resolved explicitly via `git rev-parse --show-toplevel` from
 *  `--root` (B3), NEVER the driver's incidental cwd; unresolvable → halt without
 *  merging anything. (Deliberately not event.ts's resolveProjectRoot: that
 *  resolves THROUGH linked worktrees to the main repo, but a run living in a
 *  worktree must merge into the working tree it runs in — and it cannot signal
 *  "no repo found".)
 *
 *  After each CLEAN merge (B2): `git branch -d` (safe delete — just merged),
 *  `git worktree remove` (retried once with `--force`; the branch is merged,
 *  leftover artifacts are disposable), and — because git refuses to delete a
 *  branch still checked out in its worktree — one branch-delete retry after the
 *  removal. On failure, stop and record it — the engine halts the run (a
 *  conflict between parallel steps is a designer error; never auto-resolve). A
 *  genuine conflict gets a "conflict:" detail; anything else "merge failed
 *  (non-conflict):" so triage isn't misled — both with the still-unmerged
 *  branches enumerated. */
function runMerge(
  branches: MergeBranch[],
  git: GitRunner,
  pipelineRootAbs: string,
  progress: (event: string, fields?: Record<string, unknown>) => void,
): MergeOutcome {
  const halt = (detail: string, leaked: MergeBranch[]): MergeOutcome => ({
    record: { kind: 'merge', conflict: true, detail },
    leaked,
  });

  // B3: resolve the merge cwd from the pipeline root, explicitly.
  const top = git(['rev-parse', '--show-toplevel'], pipelineRootAbs);
  const topPath = top.code === 0 ? top.stdout.trim() : '';
  if (!topPath) {
    const detail =
      `merge failed (non-conflict): no project root found — git rev-parse --show-toplevel from ${pipelineRootAbs} ` +
      `failed (${trimOut(top.stderr || top.stdout) || `exit ${top.code}`}); refusing to merge from an arbitrary cwd; ` +
      `unmerged: ${describeBranches(branches)}`;
    progress('merge.failed', { detail });
    return halt(detail, branches.slice());
  }
  const projectRoot = resolve(topPath);
  progress('merge.root_resolved', { project_root: projectRoot });

  for (let i = 0; i < branches.length; i++) {
    const b = branches[i];
    progress('merge.started', { branch: b.branch, step_id: b.step_id, cwd: projectRoot });
    const m = git(['merge', '--no-ff', b.branch], projectRoot);
    if (m.code !== 0) {
      const out = trimOut(m.stderr || m.stdout);
      const conflict = isMergeConflict(m);
      const head = conflict
        ? `conflict: git merge --no-ff ${b.branch} (step ${b.step_id}) failed: ${out}`
        : `merge failed (non-conflict): git merge --no-ff ${b.branch} (step ${b.step_id}): ${out}`;
      const leaked = branches.slice(i);
      const detail = `${head}; unmerged: ${describeBranches(leaked)}`;
      progress(conflict ? 'merge.conflict' : 'merge.failed', { branch: b.branch, detail });
      return halt(detail, leaked);
    }
    progress('merge.completed', { branch: b.branch });

    // B2 cleanup: safe-delete the just-merged branch, then remove its worktree.
    const del = git(['branch', '-d', b.branch], projectRoot);
    if (del.code === 0) progress('merge.branch_deleted', { branch: b.branch });

    let removed = false;
    if (b.path) {
      let w = git(['worktree', 'remove', b.path], projectRoot);
      if (w.code !== 0) {
        progress('warning', {
          detail: `git worktree remove ${b.path} failed — retrying with --force (branch is merged; leftover artifacts are disposable): ${trimOut(w.stderr || w.stdout)}`,
        });
        w = git(['worktree', 'remove', '--force', b.path], projectRoot);
      }
      removed = w.code === 0;
      if (removed) progress('merge.worktree_removed', { path: b.path });
      else {
        progress('warning', {
          detail: `git worktree remove --force ${b.path} failed (continuing; clean up manually): ${trimOut(w.stderr || w.stdout)}`,
        });
      }
    }

    if (del.code !== 0) {
      // git refuses `branch -d` while the branch is checked out in a worktree —
      // retry once now that the worktree removal has run.
      const del2 = b.path ? git(['branch', '-d', b.branch], projectRoot) : del;
      if (b.path && del2.code === 0) progress('merge.branch_deleted', { branch: b.branch });
      else {
        progress('warning', {
          detail: `git branch -d ${b.branch} failed (continuing; the branch IS merged — delete manually): ${trimOut(del2.stderr || del2.stdout)}`,
        });
      }
    }
  }
  return { record: { kind: 'merge', conflict: false }, leaked: [] };
}

function trimOut(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > 400 ? t.slice(0, 400) + '…' : t;
}
