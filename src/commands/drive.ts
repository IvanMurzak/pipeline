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
// in the final JSON, the engine untouched — and the park is JOURNALLED as an
// `awaiting_input` event ({run_id, iteration, question_id, question} — the
// @baizor/pipeline-protocol AwaitingInputData shape the cloud ingest consumes
// to set the run's parked status; e7 DEFECT-3). Re-run with
// `--resume --start <same-iteration> --answer "<text>"` and drive resumes the
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
// `--resume --start <same-iteration>`) · 4 awaiting-input (a step asked a
// question; answer via `--resume --start <same-iteration> --answer <text>`).

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { frozenVariablesError, invokeNext } from './next';
import { addVarFlag, loadVarsFile, mergeCliVars } from '../lib/run-vars';
import type { ActionStep, LayerResultEntry, MergeBranch, NextRecord, StepRecord } from '../lib/next';
import { realGit, type GitResult, type GitRunner } from '../lib/git';
import { ensureGeneratedDir } from '../lib/generated-dir';
import {
  addUsage,
  emptyUsage,
  loadUsageTotals,
  parseEnvelope,
  parseResultObject,
  detectProviderLimit,
  type ClaudeEnvelope,
  type ProviderLimit,
} from '../lib/envelope';
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
import { emitEvent, emitEventJson } from '../lib/event';

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

// ---------------------------------------------------------------------------
// Executor command template
// ---------------------------------------------------------------------------

/** Default executor command. EXPERIMENTAL — the exact claude flags may need
 *  per-machine adjustment; override the whole template with --executor-cmd or
 *  PIPELINE_DRIVE_EXECUTOR_CMD. The prompt is always delivered on stdin.
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
 *  writable; this is the narrowest grant that keeps the file channel alive). */
export const DEFAULT_EXECUTOR_TEMPLATE =
  'claude -p --agent pipeline:step-executor --model {model} --effort {effort} --permission-mode {permissions} --session-id {session} --add-dir {record_dir} --output-format json --json-schema {schema}';

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
  if (!sawSession && opts.session) {
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
        // The --add-dir record grant applies to STEP executors only — their
        // record_file lives in the run's tmp drop dir (see runDrive). The
        // improver/script-creator record files are drive-written observability
        // copies; those sessions never write them, so no grant is needed.
        recordDir: (req.kind ?? 'step') === 'step' ? dirname(req.record_file) : null,
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
        // Executor retry environment (08.4): set defaults that may be overridden
        // via template/env (only override absent values).
        const env = {
          ...process.env,
          CLAUDE_CODE_RETRY_WATCHDOG: process.env.CLAUDE_CODE_RETRY_WATCHDOG ?? '1',
          CLAUDE_CODE_MAX_RETRIES: process.env.CLAUDE_CODE_MAX_RETRIES ?? '15',
        };
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
 *  radius is the pipeline tree. The WHOLE template is overridable via
 *  PIPELINE_DRIVE_IMPROVER_CMD. Requires claude >= 2.1.205 for reliable
 *  --json-schema structured output (older versions silently produce
 *  unstructured output — drive falls back to applied:false with a warning). */
export const DEFAULT_IMPROVER_TEMPLATE =
  'claude -p --agent pipeline:pipeline-improver --permission-mode acceptEdits --session-id {session} --output-format json --json-schema {schema}';

/** Default script-creator command — the improver template's twin
 *  (PIPELINE_DRIVE_SCRIPT_CREATOR_CMD overrides). */
export const DEFAULT_SCRIPT_CREATOR_TEMPLATE =
  'claude -p --agent pipeline:pipeline-script-creator --permission-mode acceptEdits --session-id {session} --output-format json --json-schema {schema}';

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

  // Track provider-limit errors for the final JSON (06.7 / D11). Any step may
  // hit a limit; the first one is captured so the caller can implement retry
  // policy. Null unless a provider-limit envelope was seen.
  let detectedLimit: ProviderLimit | null = null;

  progress('run.started', { run_id: runId, pipeline_root: rootAbs, experimental: true });

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
  const dropRecordPath = (stepId: string) => join(dropRecordsDir, `${stepId}.json`);
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

  // ---------------------------------------------------------------------------
  // Headless self-improvement (design 05.2, P3) — run-scoped machinery
  // ---------------------------------------------------------------------------

  const selfImprove = selfImproveEnabled();
  const improverRunner =
    deps.improver ??
    subprocessExecutor(process.env.PIPELINE_DRIVE_IMPROVER_CMD ?? DEFAULT_IMPROVER_TEMPLATE, improverSchemaJson(), err);
  const scriptCreatorRunner =
    deps.scriptCreator ??
    subprocessExecutor(
      process.env.PIPELINE_DRIVE_SCRIPT_CREATOR_CMD ?? DEFAULT_SCRIPT_CREATOR_TEMPLATE,
      scriptCreatorSchemaJson(),
      err,
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
      writeFileSync(briefsFile, JSON.stringify({ briefs }), 'utf8');
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
      const envelope = typeof exit.stdout === 'string' ? parseEnvelope(exit.stdout) : null;
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
          writeFileSync(recordFile, JSON.stringify(structured), 'utf8');
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
      safeEmit('improver.started', { run_id: runId, iteration_path: retroRoot });
      const res = await runSelfImproveSession(improverRunner, 'improver', 'improver', () =>
        buildRetroImproverPrompt(retroRoot, feedbackDir, runId, lintWarnings),
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
      });
      if (parsed.applied) {
        noteImprovementApplied({
          source: 'retrospective',
          pipeline_root: retroRoot,
          summary: parsed.summary,
          script_briefs: parsed.script_creation_briefs.length,
        });
      }
      // Script-creators are STRICTLY SEQUENTIAL — they edit shared docs.
      for (let i = 0; i < parsed.script_creation_briefs.length; i++) {
        safeEmit('script_creator.started', { run_id: runId, iteration_path: retroRoot });
        const sres = await runSelfImproveSession(scriptCreatorRunner, 'script-creator', 'script', () =>
          buildScriptCreatorPrompt(parsed.script_creation_briefs[i], i + 1, parsed.script_creation_briefs.length, runId, retroRoot),
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
        // in the exit-4 JSON, echoed in the `--resume --start <path>` hint, and
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
      const envelope = typeof exit.stdout === 'string' ? parseEnvelope(exit.stdout) : null;
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
          writeFileSync(canonicalRecordFile, JSON.stringify(attemptRaw), 'utf8');
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
            // additive fields only beyond that.
            journalEvent(
              'awaiting_input',
              {
                run_id: runId,
                iteration: gateStep.index,
                question_id: gateQuestionId,
                question: { ...(question ?? { text: `Approval required to proceed past gate '${gateStep.step_id}'.` }), question_id: gateQuestionId },
                step_id: gateStep.step_id,
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
                  `--resume --start ${gateStep.path} --answer '{"decision":"approve|reject","comment":<string|null>}' ` +
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
            // fields (step_id, iteration_path) beyond that. Emitted on the
            // repeat park too (a --resume without --answer), restoring the
            // parked state after the re-entry's iteration.started un-parked it.
            journalEvent(
              'awaiting_input',
              {
                run_id: runId,
                iteration: action.steps[0].index,
                question_id: r.awaiting.question_id,
                question: { ...r.awaiting.question, question_id: r.awaiting.question_id },
                step_id: r.awaiting.step_id,
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
        const res = await runSelfImproveSession(improverRunner, 'improver', 'improver', () => {
          const brief = takeBrief(action.iteration_path);
          return brief === null ? null : buildImproverPrompt(action.iteration_path, brief, runId, worktreePipelineRoot ?? rootAbs);
        });
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
        const res = await runSelfImproveSession(scriptCreatorRunner, 'script-creator', 'script', () => {
          const brief = scriptBriefs[action.number - 1] ?? null;
          return brief === null
            ? null
            : buildScriptCreatorPrompt(brief, action.number, action.of, runId, worktreePipelineRoot ?? rootAbs);
        });
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
              'a step reported blocked-delegating; resolve the blocker (see the blocker_delegation brief in the record file), then re-run pipeline drive with --resume --start <same-iteration>',
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
