// `pipeline drive --root <pipeline_root> --run-id <id> --start <iteration-path>
//   [--default-model <m>] [--model <step_id>=<m> ...]
//   [--default-effort <level>] [--effort <step_id>=<level> ...] [--resume]
//   [--var NAME=value ...] [--vars-file <path>]
//   [--answer <text> | --answer-file <path>]
//   [--task <text> | --task-file <path>]
//   [--executor-cmd <template>] [--json]`
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
//                         manager-documented spawn prompt on stdin), then take
//                         its step record from the claude JSON envelope's
//                         schema-validated `structured_output` (the default
//                         template passes --output-format json --json-schema);
//                         drive persists it to the record file itself. When the
//                         envelope is absent (custom --executor-cmd without the
//                         flags) it falls back to reading the record file the
//                         executor wrote. Concurrent layers spawn all steps in
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
//   run-improver /      → v1 SKIPS self-improvement: records applied:false /
//   run-script-creator    outcome:'refused' and logs a warning.
//   retrospective       → records done:true; the feedback folder is left in
//                         place for a manual improver pass.
//   done / halt / blocked → final JSON on stdout; exit 0 / 1 / 3.
//
// The executor spawn goes through an injectable ExecutorRunner seam. The
// default runner shells out to `claude -p --agent pipeline:step-executor
// --model {model} --output-format json --json-schema {schema}` (prompt ALWAYS
// via stdin; a `--flag {token}` pair is dropped when its token resolves to
// nothing). Because the exact claude flags may need per-machine adjustment,
// the WHOLE command template is overridable via `--executor-cmd` or the env
// var PIPELINE_DRIVE_EXECUTOR_CMD — a whitespace-split template in which
// `{model}` is substituted with the step's resolved model and `{schema}` with
// the compact step-record JSON Schema (lib/step-schema.ts — deliberately
// whitespace-free so it survives the split; when a token has no value, the
// token AND an immediately preceding `-`/`--` flag token are dropped).
//
// Interactive steps (needs-input): every executor session is PINNED to a
// UUID generated before the spawn and persisted in
// .runtime/<run_id>/sessions/<step_id>.json. A step that reports outcome
// "needs-input" (with a question object) parks the run: exit 4, the question
// in the final JSON, the engine untouched. Re-run with
// `--resume --start <same-iteration> --answer "<text>"` and drive resumes the
// SAME claude session (`--resume <session-id>`) with the answer — the step
// continues from where it stopped instead of re-deriving its work. At most 3
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
// `--resume --start <same-iteration>`) · 4 awaiting-input (a step asked a
// question; answer via `--resume --start <same-iteration> --answer <text>`).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { frozenVariablesError, invokeNext } from './next';
import { addVarFlag, loadVarsFile, mergeCliVars } from '../lib/run-vars';
import type { ActionStep, LayerResultEntry, MergeBranch, NextRecord, StepRecord } from '../lib/next';
import { realGit, type GitResult, type GitRunner } from '../lib/git';
import { addUsage, emptyUsage, parseEnvelope, type ClaudeEnvelope } from '../lib/envelope';
import {
  RECORD_OUTCOMES as RECORD_OUTCOME_LIST,
  extractQuestion,
  stepRecordSchemaJson,
  type StepQuestion,
} from '../lib/step-schema';

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

// Re-exported: StepSession historically lived here (launcher/tests import it).
export type { StepSession };

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export interface ExecutorRequest {
  step_id: string;
  /** The full step-executor spawn prompt (delivered on stdin by the default runner). */
  prompt: string;
  /** The step's resolved model, or null (inherit). */
  model: string | null;
  /** The step's resolved reasoning effort, or null (inherit the session
   *  default). Passed as `claude --effort` on EVERY invocation — the flag does
   *  not persist across `--resume`, so answer deliveries re-pass it too. */
  effort: string | null;
  /** Where the executor is expected to write its {"kind":"step",…} record JSON. */
  record_file: string;
  /** The pinned claude session: fresh spawns pass `--session-id <id>`, answer
   *  deliveries pass `--resume <id>` (the same session continues). */
  session: { id: string; resume: boolean };
  /** Resolved --permission-mode value; null = inherit machine settings. */
  permission_mode: string | null;
}

export interface ExecutorExit {
  /** Subprocess exit code; null when the process could not be spawned. */
  code: number | null;
  /** Spawn-failure detail (code === null). */
  error?: string;
  /** Captured stdout — the claude JSON envelope when the template passes
   *  --output-format json; absent/garbage for custom templates (fine: the
   *  caller falls back to the record file). */
  stdout?: string;
}

/** The executor seam: spawn ONE step-executor and resolve when it exits. Tests
 *  inject a fake that writes prescribed record files; production uses the
 *  template-driven subprocess runner below. */
export type ExecutorRunner = (req: ExecutorRequest) => Promise<ExecutorExit>;

export interface DriveDeps {
  executor?: ExecutorRunner;
  git?: GitRunner;
  /** stdout sink (the final JSON only). */
  out?: (s: string) => void;
  /** stderr sink (progress lines + warnings + relayed executor output). */
  err?: (s: string) => void;
}

// ---------------------------------------------------------------------------
// Executor command template
// ---------------------------------------------------------------------------

/** Default executor command. EXPERIMENTAL — the exact claude flags may need
 *  per-machine adjustment; override the whole template with --executor-cmd or
 *  PIPELINE_DRIVE_EXECUTOR_CMD. The prompt is always delivered on stdin.
 *  `{schema}` expands to the compact step-record JSON Schema (the harness
 *  validates the final response and returns it in `structured_output`),
 *  `{permissions}` to the step's resolved permission mode, and `{session}` to
 *  the pinned session UUID — on an answer delivery the flag preceding
 *  `{session}` is swapped to `--resume` so the SAME session continues
 *  (verified on Claude Code 2.1.205). */
export const DEFAULT_EXECUTOR_TEMPLATE =
  'claude -p --agent pipeline:step-executor --model {model} --effort {effort} --permission-mode {permissions} --session-id {session} --output-format json --json-schema {schema}';

export interface ExecutorArgvOpts {
  session?: { id: string; resume: boolean };
  permissionMode?: string | null;
  /** The step's resolved reasoning effort — `{effort}` token. Null/absent
   *  drops the `--effort {effort}` pair (inherit the session default). */
  effort?: string | null;
}

/**
 * Expand a command template into an argv. Whitespace-split (paths with spaces
 * are not supported in templates — this is an experimental headless seam).
 * Tokens: `{model}` → the step's resolved model, `{effort}` → the step's
 * resolved reasoning effort, `{schema}` → the compact (whitespace-free)
 * step-record schema, `{permissions}` → the resolved permission mode,
 * `{session}` → the pinned session UUID. When a token has NO value, the token
 * is dropped along with an immediately preceding `-`/`--` flag token so the
 * pair disappears together. Session special cases: when resuming, the flag
 * token immediately preceding `{session}` is REPLACED with `--resume`; a
 * template WITHOUT a `{session}` token gets the session pair appended (custom
 * claude wrappers must forward unknown flags; fakes ignore argv entirely).
 */
export function buildExecutorArgv(
  template: string,
  model: string | null,
  schema?: string | null,
  opts: ExecutorArgvOpts = {},
): string[] {
  const argv: string[] = [];
  let sawSession = false;
  const dropPair = (): void => {
    if (argv.length && argv[argv.length - 1].startsWith('-')) argv.pop();
  };
  // Scalar tokens all follow the same rule: substitute when a value resolved,
  // otherwise drop the token AND its preceding flag. {session} stays a special
  // case (resume swaps the preceding flag to --resume; appended when absent).
  const scalars: Record<string, string | null | undefined> = {
    '{model}': model,
    '{effort}': opts.effort,
    '{schema}': schema,
    '{permissions}': opts.permissionMode,
  };
  for (const t of template.split(/\s+/).filter(Boolean)) {
    const token = Object.keys(scalars).find((k) => t.includes(k));
    if (token !== undefined) {
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
  if (!sawSession && opts.session) {
    argv.push(opts.session.resume ? '--resume' : '--session-id', opts.session.id);
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

/** The production ExecutorRunner: spawn the templated command, write the prompt
 *  to stdin, capture stdout (the JSON envelope) while relaying stdout+stderr to
 *  the drive stderr sink, and resolve with the exit code + captured stdout.
 *  Never throws — spawn failures resolve as {code:null, error}. */
function subprocessExecutor(template: string, schema: string | null, err: (s: string) => void): ExecutorRunner {
  return (req) =>
    new Promise<ExecutorExit>((done) => {
      const argv = buildExecutorArgv(template, req.model, schema, {
        session: req.session,
        permissionMode: req.permission_mode,
        effort: req.effort,
      });
      if (argv.length === 0) {
        done({ code: null, error: 'executor command template expanded to an empty argv' });
        return;
      }
      let settled = false;
      let outBuf = '';
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
        const child = useShell
          ? spawn(argv.map(quoteForShell).join(' '), {
              stdio: ['pipe', 'pipe', 'pipe'],
              shell: true,
              windowsHide: true,
            })
          : spawn(argv[0], argv.slice(1), {
              stdio: ['pipe', 'pipe', 'pipe'],
              shell: false,
              windowsHide: true,
            });
        child.stdout?.on('data', (d: unknown) => {
          outBuf += String(d);
          err(String(d));
        });
        child.stderr?.on('data', (d: unknown) => err(String(d)));
        child.on('error', (e: unknown) => {
          // Windows: `claude` installs as a .cmd shim that only a shell can
          // launch — retry ONCE through the shell before giving up. Direct
          // spawn stays the default (no extra cmd.exe per step).
          if (!useShell && process.platform === 'win32') {
            outBuf = '';
            launch(true);
            return;
          }
          finish({ code: null, error: e instanceof Error ? e.message : String(e) });
        });
        child.on('close', (code: number | null) => {
          // A failed direct spawn also emits close(-1/null) after error — only
          // settle from the attempt that actually ran (finish() dedupes anyway).
          if (child.pid !== undefined || useShell) finish({ code, stdout: outBuf });
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
    writeFileSync(join(sessionsDir, `${stepId}.json`), JSON.stringify(s, null, 2), 'utf8');
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

You are running headless: when your session was started with a JSON schema
(the default), your FINAL response is parsed as your step record — end with
exactly the step-record object (same fields as your step_record_file protocol);
prose belongs in its "summary" field. Write step_record_file as usual too: the
driver prefers the structured response and falls back to the file.

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
 *  its needs-input question. Repeats step_record_file so the executor (or a
 *  wrapper script) never has to dig it out of the earlier conversation. */
export function buildAnswerPrompt(answer: string, recordFile: string): string {
  return `Answer to your question: ${answer}

step_record_file = ${recordFile}

Continue executing the iteration from where you stopped, using this answer.
Same protocol as before: verify the Success Criteria, write your step record
to step_record_file, and end with the step-record object as your final
response. If the answer is insufficient you may ask again (outcome
"needs-input"), but the per-step question limit still applies.
`;
}

/** The prompt delivered when a session is resumed after an INTERRUPTION (the
 *  executor process died, or a previous drive was killed mid-step): the
 *  transcript survived on disk, so the executor verifies and continues
 *  instead of a fresh spawn re-deriving everything. */
export function buildCrashResumePrompt(recordFile: string): string {
  return `Your session was interrupted before a valid step record was produced.

step_record_file = ${recordFile}

Re-verify the current state of your work (files, commands, Success Criteria),
finish anything incomplete, and report as usual: write your step record to
step_record_file and end with the step-record object as your final response.
If the iteration's work was already complete before the interruption, just
verify and report.
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
  return `no valid step record at ${recordFile} (executor exit ${code}${env})`;
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function runDrive(args: string[], deps: DriveDeps = {}): Promise<number> {
  const a = parseArgs(args);
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const err = deps.err ?? ((s: string) => process.stderr.write(s));
  if (!a.root || !a.runId) {
    err('pipeline drive: --root and --run-id are required\n');
    return 2;
  }
  if (!a.start && !a.resume) {
    err('pipeline drive: --start <iteration-path> is required (or pass --resume to re-enter a persisted run)\n');
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
  process.env.PIPELINE_STATS_RUNNER = 'headless';
  // NOTE: the merge cwd is NOT process.cwd() — runMerge resolves the project
  // root enclosing --root itself (B3) so merges never land in a random cwd.
  const template = a.executorCmd ?? process.env.PIPELINE_DRIVE_EXECUTOR_CMD ?? DEFAULT_EXECUTOR_TEMPLATE;
  const executor = deps.executor ?? subprocessExecutor(template, stepRecordSchemaJson(), err);
  const git = deps.git ?? realGit;

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

  progress('run.started', { run_id: runId, pipeline_root: rootAbs, experimental: true });

  // Run-start setup — mirrors the pipeline-manager's "Set up the Tier-2 feedback
  // directory" section: the .feedback/<run_id>/ folder + its self-contained
  // .gitignore stub, and the .runtime/<run_id>/records/ folder the executors
  // write their step records into.
  const recordsDir = join(rootAbs, '.runtime', runId, 'records');
  const sessionsDir = join(rootAbs, '.runtime', runId, 'sessions');
  try {
    mkdirSync(join(rootAbs, '.feedback', runId), { recursive: true });
    const gi = join(rootAbs, '.feedback', '.gitignore');
    if (!existsSync(gi)) writeFileSync(gi, '*\n', 'utf8');
    mkdirSync(recordsDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
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
      writeFileSync(taskFile, a.task, 'utf8');
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
  const finalJson = (obj: Record<string, unknown>, code: number): number => {
    out(JSON.stringify({ ...obj, run_id: runId, pipeline_root: rootAbs }, null, 2) + '\n');
    return code;
  };

  // Envelope usage/cost accumulator, persisted across drive invocations of the
  // SAME run (blocked → resume re-enters a fresh process) so the terminal
  // stats enrichment covers every spawn. Best-effort like all stats.
  const usageFile = join(rootAbs, '.runtime', runId, 'usage.json');
  const usageTotals = emptyUsage();
  try {
    const prev = JSON.parse(readFileSync(usageFile, 'utf8')) as Record<string, unknown>;
    for (const k of ['input', 'output', 'cache_read', 'cache_creation', 'cost_usd'] as const) {
      if (typeof prev[k] === 'number' && Number.isFinite(prev[k] as number)) usageTotals[k] = prev[k] as number;
    }
  } catch {
    // no prior usage — fresh run
  }
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
    // else the transcript-folded totals (custom executor template without
    // --output-format json, or every attempt crashed pre-envelope). All-zero
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

  /** A parked needs-input question, surfaced in the final awaiting-input JSON. */
  interface Awaiting {
    step_id: string;
    iteration_path: string;
    session_id: string;
    question: StepQuestion;
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
    const stepRootAbs = step.pipeline_root ? resolve(step.pipeline_root) : rootAbs;
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
    const recordFile = recordPath(stepKey);
    /** Halt this step (and close its session — every non-awaiting exit does). */
    const halted = (reason: string): { entry: LayerResultEntry; raw: null; recordFile: string } => {
      sess.status = 'done';
      writeStepSession(sessionsDir, stepKey, sess);
      progress('step.failed', { step_id: step.step_id, reason });
      return { entry: { step_id: step.step_id, outcome: 'halted', halt_reason: reason }, raw: null, recordFile };
    };
    /** Park this step on a question — the run exits 4 and the caller resumes
     *  the SAME session with the user's answer. */
    const park = (question: StepQuestion, sessionId: string, repeat: boolean) => {
      progress('step.awaiting_input', { step_id: step.step_id, question: question.text, ...(repeat ? { repeat: true } : {}) });
      return {
        entry: { step_id: step.step_id, outcome: 'halted' as const, halt_reason: 'awaiting input' },
        raw: null,
        recordFile,
        // SOURCE path (env-variables a5, E11): this iteration_path is surfaced
        // in the exit-4 JSON, echoed in the `--resume --start <path>` hint, and
        // machine-fed back as `--start` by pipeline-ui's answer flow — a
        // rendered `.runtime/<run>/rendered/` path there would make the engine
        // synthesize an off-plan step on the answer resume instead of resuming
        // the parked plan step. Identical to step.path on non-rendered runs.
        awaiting: { step_id: step.step_id, iteration_path: step.source_path, session_id: sessionId, question },
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
        return park(question, prior.session_id, true);
      }
      sess = { ...prior, status: 'running' };
      warnCwd(sess);
      initialPrompt = buildAnswerPrompt(pendingAnswer, recordFile);
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
      initialPrompt = buildCrashResumePrompt(recordFile);
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

    // Manifest fallback resolves against the step's OWN pipeline (a child
    // run's steps read the child manifest's permission-mode, not the parent's).
    const permissionMode = resolvePermissionMode(step.path, stepRootAbs);

    /** One executor spawn against the pinned session; extracts the record
     *  (structured_output preferred, file fallback) and folds usage. */
    const runAttempt = async (promptText: string, resume: boolean) => {
      rmSync(recordFile, { force: true }); // never trust a stale record from a previous attempt
      const exit = await executor({
        step_id: step.step_id,
        prompt: promptText,
        model: step.model,
        effort: step.effort ?? null,
        record_file: recordFile,
        session: { id: sess.session_id, resume },
        permission_mode: permissionMode,
      });
      const envelope = typeof exit.stdout === 'string' ? parseEnvelope(exit.stdout) : null;
      noteUsage(envelope);
      let attemptRaw: Record<string, unknown> | null;
      const structured = envelope?.structured_output ?? null;
      if (validRecord(structured)) {
        // Authoritative: the harness validated this against the step schema.
        attemptRaw = { ...structured, kind: 'step' };
        try {
          writeFileSync(recordFile, JSON.stringify(attemptRaw), 'utf8');
        } catch (e) {
          progress('warning', {
            detail: `failed to persist structured record to ${recordFile}: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
        progress('step.record', { step_id: step.step_id, source: 'structured_output' });
      } else {
        attemptRaw = readRecordFile(recordFile);
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
      att = await runAttempt(buildCrashResumePrompt(recordFile), true);
    }
    const { exit, envelope } = att;
    const raw = att.raw;

    // needs-input — intercepted BEFORE the engine ever sees the record.
    if (raw !== null && raw.outcome === 'needs-input') {
      const question = extractQuestion(raw);
      sess.questions.push(question);
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
      return park(question, sess.session_id, false);
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
      recordFile,
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

    switch (action.action) {
      case 'run-step': {
        if (action.concurrent) {
          const results = await Promise.all(action.steps.map((s) => execStep(s, { allowInput: false })));
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
            progress('run.awaiting_input', {
              step_id: gateStep.step_id,
              question: question?.text ?? null,
              approval_required_role: question?.approval.required_role ?? null,
            });
            enrichStats(false);
            return finalJson(
              {
                status: 'awaiting-input',
                step_id: gateStep.step_id,
                iteration_path: gateStep.path,
                session_id: null,
                question,
                detail:
                  'the step is an APPROVAL GATE; deliver the decision by re-running pipeline drive with ' +
                  `--resume --start ${gateStep.path} --answer '{"decision":"approve|reject","comment":<string|null>}' ` +
                  '(or --answer-file <path>) — an unparseable answer halts the run, never approves it',
              },
              4,
            );
          }
          const r = await execStep(action.steps[0], { allowInput: true });
          if (r.awaiting !== undefined) {
            // Park the run WITHOUT feeding the engine: on re-entry it re-issues
            // this same step and drive resumes the pinned session with --answer.
            progress('run.awaiting_input', {
              step_id: r.awaiting.step_id,
              session_id: r.awaiting.session_id,
              question: r.awaiting.question.text,
            });
            enrichStats(false);
            return finalJson(
              {
                status: 'awaiting-input',
                step_id: r.awaiting.step_id,
                iteration_path: r.awaiting.iteration_path,
                session_id: r.awaiting.session_id,
                question: r.awaiting.question,
                detail:
                  'the step asked a question; answer it, then re-run pipeline drive with ' +
                  `--resume --start ${r.awaiting.iteration_path} --answer "<text>" (or --answer-file <path>) — ` +
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
        progress('warning', {
          detail: `self-improvement skipped in headless v1 (improvement brief for ${action.iteration_path} not applied)`,
        });
        record = { kind: 'improver', applied: false, script_briefs: 0 };
        continue;
      }
      case 'run-script-creator': {
        progress('warning', {
          detail: `self-improvement skipped in headless v1 (script-creation brief ${action.number}/${action.of} refused)`,
        });
        record = { kind: 'script', outcome: 'refused', script_path: null };
        continue;
      }
      case 'retrospective': {
        progress('warning', {
          detail: `retrospective skipped in headless v1 — feedback left at ${join(rootAbs, '.feedback', runId)} for a manual improver pass`,
        });
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
              'a step reported blocked-delegating; resolve the blocker (see the blocker_delegation brief in the record file), then re-run pipeline drive with --resume --start <same-iteration>',
          },
          3,
        );
      }
      case 'done': {
        progress('run.completed', {});
        enrichStats(true);
        return finalJson({ status: 'completed' }, 0);
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
        return finalJson({ status: action.status, reason: action.reason }, 1);
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
        return finalJson({ status: 'halted', reason: `pipeline drive cannot actuate action '${action.action}'` }, 1);
      }
    }
  }
  return finalJson({ status: 'halted', reason: 'drive loop guard exceeded (10000 engine calls)' }, 1);
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
