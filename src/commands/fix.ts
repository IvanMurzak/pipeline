// `pipeline fix --root <pipeline_root> [--project <path>] [--model <m>]
//   [--timeout <sec>] [--json]`
//
// AI Fix as a CLI command. It computes the same lint `pipeline plan` reports
// and spawns ONE headless `claude -p` session that edits the pipeline folder
// until those issues are gone, then re-plans and reports what is left.
//
// PROVENANCE: ported from apps/pipeline-ui/aifix.ts, since deleted
// with the local dashboard (plugin-thin 01-remove-local-ui.md). The browser's
// job-polling shape (POST -> 202 {job_id}, GET job snapshot) is deliberately
// NOT ported — it existed because a browser cannot hold a subprocess. A
// terminal command runs the session in the foreground and reports directly.
//
// ---------------------------------------------------------------------------
// SAFETY PROPERTIES (this file is the whole of them — keep all four)
// ---------------------------------------------------------------------------
//
// 1. WRITE SCOPE IS THE PIPELINE FOLDER ONLY, and it is ENFORCED, not merely
//    instructed. The prompt says so (buildFixPrompt), AND the session runs
//    with a `PreToolUse` hook — this same binary re-entered as
//    `pipeline fix --scope-guard --root <pipeline_root>` (see runScopeGuard)
//    — that DENIES every Edit/Write/MultiEdit/NotebookEdit whose target
//    canonicalizes outside the pipeline root. PreToolUse runs BEFORE the
//    permission system, so the deny beats `acceptEdits`. The guard fails
//    CLOSED: unparseable payload, unknown write shape, or a missing path is a
//    deny, never a fall-through allow.
//
//    The honest boundary: the guard covers the file-editing tools. `Bash`
//    inside the session is not path-restricted — exactly as it is not for
//    `pipeline drive`'s step-executors, so this does not exceed the
//    precedent. It is stated in --help rather than papered over.
//
// 2. `pipeline_root` IS CONTAINMENT-CHECKED BEFORE ANYTHING IS SPAWNED. The
//    check is the FIRST thing runFix does after argument parsing — before the
//    manifest stat, before computePlan, before the temp settings file, before
//    the spawn. It is not a post-check and it must not be reordered:
//    tests/fix.test.ts drives an escape attempt through an injected session
//    runner and asserts the runner was never called.
//
//    The project root defaults to the CWD, never to something derived from
//    `--root`. Deriving it from --root would make every directory "inside its
//    own .pipeline" and reduce the check to a tautology.
//
// 3. IT RUNS WITH `--permission-mode acceptEdits` FROM THE PROJECT ROOT —
//    the same trust level as `pipeline drive`, which also spawns `claude -p`
//    against consumer files on user request. That precedent is what makes the
//    trust level defensible. DO NOT EXCEED IT.
//
// 4. THE TRUST LEVEL IS STATED IN `--help`. In the deleted browser the
//    Validate -> AI Fix button flow made it obvious an agent was about to edit
//    files; a terminal command has to say it out loud.
//
// Offline and upload-free: the only network call is the model session `claude`
// itself makes. Nothing is sent to the control plane, no telemetry is emitted,
// and the pipeline never leaves the machine.
//
// Exit codes:
//   0  the reported issues are gone (or there were none, or --help)
//   1  the session failed, or issues remain after it ran
//   2  usage error, a `--root` outside the project's pipelines dir, a missing
//      manifest, or a pipeline whose manifest cannot be read

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { computePlan } from '../lib/plan';
import { MANIFEST_FILENAME } from '../lib/manifest';
import { normalizeModel } from '../lib/model';
import { ClaudeStreamParser } from '../lib/stream-json';

const USAGE =
  'Usage: pipeline fix --root <pipeline_root> [--project <path>] [--model <m>]\n' +
  '                    [--timeout <sec>] [--json]';

/** Cap on the issues handed to one session — a lint list this long is a
 *  pipeline to rewrite, not to patch (parity with the UI's MAX_ISSUES). */
const MAX_ISSUES = 100;

/** Default wall-clock cap on the session (parity with the UI's JOB_TIMEOUT_MS). */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** The file-editing tools the scope guard arbitrates. Anything else that
 *  reaches the guard is allowed through (the hook matcher should not have
 *  routed it), but a tool NAMED here with no resolvable target is denied. */
const GUARDED_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** The hook matcher registered for the spawned session. Regex-alternation over
 *  the same names as GUARDED_TOOLS — keep the two in lockstep. */
const GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

/** Canonicalize for containment: lexical resolve (normalizes `.`/`..`
 *  segments, win32 separators and drive-relative forms) + realpath when the
 *  path exists (resolves symlinks and win32 8.3 short names — a symlink inside
 *  the root pointing outside must compare OUTSIDE). A not-yet-existing path
 *  keeps the lexical resolution; the lexical form still rejects `..`
 *  traversal, and a Write to a path that cannot be canonicalized is exactly
 *  the case where the lexical verdict must stand.
 *
 *  Deliberately a local copy of the identically-shaped pair in
 *  lib/script-step.ts (its `canonicalizePath`/`isInsideRoot`) rather than an
 *  import: that module is the FROZEN script-step process-I/O contract and
 *  pulls the whole spawn/ledger machinery in with it. The security guard in
 *  this file must not be able to change behaviour because an unrelated
 *  contract module was refactored. Exported so tests drive the real thing. */
export function canonicalizePath(p: string): string {
  const lex = resolve(p);
  try {
    return realpathSync(lex);
  } catch {
    return lex;
  }
}

/** True iff `childCanon` is `rootCanon` or inside it. Case-insensitive on
 *  win32 (NTFS); the verdict comes from path.relative's `..`-segment shape —
 *  NEVER a startsWith prefix compare, which win32 defeats (`\` vs `/`
 *  separators, drive letters, and sibling dirs sharing a prefix like
 *  `proj-evil` vs `proj`). */
export function isInsideRoot(childCanon: string, rootCanon: string): boolean {
  const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = relative(fold(rootCanon), fold(childCanon));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * SAFETY PROPERTY 2. `pipelineRoot` must canonicalize inside the project's
 * `.pipeline/` directory. Exported so the escape test drives the same
 * predicate the command runs.
 */
export function isInsidePipelinesDir(projectRoot: string, pipelineRoot: string): boolean {
  return isInsideRoot(canonicalizePath(pipelineRoot), canonicalizePath(join(projectRoot, '.pipeline')));
}

// ---------------------------------------------------------------------------
// The scope guard (SAFETY PROPERTY 1) — `pipeline fix --scope-guard`
// ---------------------------------------------------------------------------

export type ScopeDecision = { allow: true } | { allow: false; reason: string };

/** Every path a guarded tool payload could write to. `MultiEdit` and `Edit`
 *  both carry `file_path`; `NotebookEdit` carries `notebook_path`; `path` is
 *  accepted defensively so a renamed field cannot become a silent bypass. */
function targetPaths(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim() !== '') out.push(v);
  }
  return out;
}

/**
 * The guard's decision function — pure, so a test can prove the verdict
 * without spawning anything.
 *
 * FAILS CLOSED. A guarded tool whose payload has no resolvable target is
 * denied, because "we could not tell where this writes" must never read as
 * "this writes somewhere fine".
 */
export function decideScopeGuard(pipelineRoot: string, payload: unknown): ScopeDecision {
  const p = (payload ?? {}) as Record<string, unknown>;
  const tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  if (!GUARDED_TOOLS.has(tool)) {
    // The hook matcher should not have routed this here. Nothing to arbitrate.
    return { allow: true };
  }
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  const targets = targetPaths(input);
  if (targets.length === 0) {
    return {
      allow: false,
      reason:
        `pipeline fix: ${tool} carries no file path this guard can check — refused. ` +
        `Edits are limited to ${pipelineRoot}.`,
    };
  }
  const rootCanon = canonicalizePath(pipelineRoot);
  for (const t of targets) {
    const canon = canonicalizePath(resolve(t));
    if (!isInsideRoot(canon, rootCanon)) {
      return {
        allow: false,
        reason:
          `pipeline fix: refused — '${t}' resolves to '${canon}', outside the pipeline ` +
          `folder '${rootCanon}'. This session may only edit files inside that folder.`,
      };
    }
  }
  return { allow: true };
}

export interface ScopeGuardDeps {
  readStdin?: () => Promise<string>;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

/**
 * `pipeline fix --scope-guard --root <pipeline_root>` — the PreToolUse hook
 * body. Reads one hook payload on stdin and decides.
 *
 * Belt AND braces on the wire format, because a hook that silently stops
 * blocking after a Claude Code upgrade is exactly the failure this task exists
 * to prevent:
 *   - deny  -> the structured `permissionDecision: "deny"` JSON on stdout, the
 *              reason on stderr, AND exit 2 (the older, universally understood
 *              "blocking error" code). A harness that reads either one blocks.
 *   - allow -> exit 0 and NOTHING on stdout (silence is allow everywhere;
 *              stray stdout is interpreted as a message by some versions).
 *
 * Not listed in `pipeline --help`: it is a machine entry point, invoked only
 * by the session this command spawns.
 */
export async function runScopeGuard(args: string[], deps: ScopeGuardDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const err = deps.err ?? ((s: string) => process.stderr.write(s));

  let root: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') root = args[++i];
    else if (a.startsWith('--root=')) root = a.slice('--root='.length);
  }
  if (!root) {
    err(`pipeline fix --scope-guard: --root is required\n`);
    return 2;
  }

  const deny = (reason: string): number => {
    out(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }) + '\n',
    );
    err(reason + '\n');
    return 2;
  };

  let raw: string;
  try {
    raw = await (deps.readStdin ?? (() => Bun.stdin.text()))();
  } catch (e) {
    return deny(`pipeline fix: could not read the hook payload (${String(e)}) — refused.`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return deny('pipeline fix: unparseable hook payload — refused (the guard fails closed).');
  }

  const decision = decideScopeGuard(root, payload);
  if (decision.allow) return 0;
  return deny(decision.reason);
}

// ---------------------------------------------------------------------------
// The session seam
// ---------------------------------------------------------------------------

export interface FixSessionRequest {
  /** The full argv of the `claude -p` session. */
  argv: string[];
  /** cwd of the child — the PROJECT root (safety property 3). */
  cwd: string;
  /** The prompt, delivered on stdin. */
  prompt: string;
  /** The child's environment (see buildFixChildEnv). */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Live progress: one call per tool the session invokes. */
  onToolCall?: (tool: string) => void;
}

export interface FixSessionResult {
  /** Subprocess exit code; null when it could not be spawned. */
  code: number | null;
  /** Claude's final text (truncated) — what it says it fixed. */
  summary?: string | null;
  costUsd?: number | null;
  error?: string | null;
}

/** The spawn seam. Tests inject a fake; production uses subprocessSession. */
export type FixSessionRunner = (req: FixSessionRequest) => Promise<FixSessionResult>;

export interface FixDeps {
  session?: FixSessionRunner;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Default project root — process.cwd() in production. */
  cwd?: string;
}

/**
 * The `claude -p` child's environment. `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`
 * enables the same subagent-text/thinking forwarding as
 * `--forward-subagent-text` (never passed on this session's argv), and a child
 * inherits it from whatever shell launched `pipeline fix`. Not passing the
 * flag is therefore not enough — the variable is deleted from the CHILD's
 * environment explicitly, so an operator's or CI's exported var cannot reach
 * this session either. Ported verbatim from apps/pipeline-ui/aifix.ts
 * (ux-v2 b8 / T18); exported (and taking `base` rather than reading
 * process.env itself) so a test can prove the deletion without spawning.
 */
export function buildFixChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT;
  return env;
}

/** Cap on the raw stdout retained for diagnostics. */
const MAX_CAPTURED_STDOUT = 1024 * 1024;

/** The production runner: spawn `claude -p`, feed the prompt on stdin, parse
 *  stream-json AS IT ARRIVES so each tool call surfaces while the session is
 *  still running. Never throws — a spawn failure resolves as {code:null}. */
const subprocessSession: FixSessionRunner = async (req) => {
  const spawnWith = (cmd: string[]) =>
    Bun.spawn({
      cmd,
      cwd: req.cwd,
      stdin: new TextEncoder().encode(req.prompt),
      stdout: 'pipe',
      stderr: 'pipe',
      env: req.env,
    });

  let child: ReturnType<typeof spawnWith>;
  try {
    child = spawnWith(req.argv);
  } catch (e) {
    // Windows: `claude` may be a .cmd shim only a shell can launch (the same
    // fallback `pipeline drive` uses). Every argv token here is shell-safe —
    // the prompt travels via stdin and the only quoted token is a temp path.
    if (process.platform !== 'win32') return { code: null, error: `could not spawn claude: ${e}` };
    try {
      child = spawnWith(['cmd.exe', '/c', ...req.argv]);
    } catch (e2) {
      return { code: null, error: `could not spawn claude: ${e2}` };
    }
  }

  const killTimer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, req.timeoutMs);

  try {
    const parser = new ClaudeStreamParser({ onToolCall: (c) => req.onToolCall?.(c.tool) });
    let stdout = '';
    const pump = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        stdout += text;
        if (stdout.length > MAX_CAPTURED_STDOUT) stdout = stdout.slice(-MAX_CAPTURED_STDOUT);
        parser.push(text);
      }
      const tail = decoder.decode(); // flush a split multi-byte sequence
      if (tail.length > 0) {
        stdout += tail;
        parser.push(tail);
      }
      parser.end();
    })();
    const [, stderr, code] = await Promise.all([
      pump,
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    clearTimeout(killTimer);
    if (code !== 0) {
      return { code, error: (stderr || stdout || `claude exited ${code}`).slice(0, 2000) };
    }
    const env = parser.summary().envelope;
    return {
      code,
      summary: env?.result?.slice(0, 4000) ?? (stdout.trim().slice(0, 4000) || null),
      costUsd: env?.total_cost_usd ?? null,
    };
  } catch (e) {
    clearTimeout(killTimer);
    return { code: null, error: String(e).slice(0, 2000) };
  }
};

// ---------------------------------------------------------------------------
// Prompt + settings
// ---------------------------------------------------------------------------

/** The prompt handed to the headless session. Exported for tests — the
 *  write-scope sentence is a contract, not decoration. */
export function buildFixPrompt(pipelineRoot: string, manifestName: string, issues: string[]): string {
  const list = issues.map((i) => `- ${i}`).join('\n');
  return [
    `You are fixing validation issues in a Claude-Pipeline pipeline folder.`,
    ``,
    `Pipeline root: ${pipelineRoot}`,
    `Manifest: ${manifestName}`,
    ``,
    `The \`pipeline plan\` lint reported these errors/warnings:`,
    list,
    ``,
    `Rules:`,
    `- Edit files ONLY inside ${pipelineRoot} (the manifest, steps/**.md, scripts/**). Never touch anything else in the repository. A hook enforces this and will refuse any edit outside that folder.`,
    `- Make the minimal edits that resolve each issue while preserving the pipeline's intent. Do not rewrite content that isn't implicated.`,
    `- A v2 pipeline is configured entirely by its \`${MANIFEST_FILENAME}\` manifest: a step is a NAMED manifest entry, not a file. A v1 pipeline keeps its PIPELINE.md required sections (End State, Scope, Project Context, Invariants) and its per-step frontmatter contract (step_id, depends-on, model, permission-mode).`,
    `- You can re-check your work at any time by running \`pipeline plan --root "${pipelineRoot}"\`.`,
    ``,
    `When you are done, reply with a short bullet list of what you changed and why it resolves each issue.`,
  ].join('\n');
}

/** The settings document that installs the scope guard (safety property 1).
 *  Exported so a test can assert the guard is actually wired, not just
 *  implemented. */
export function buildGuardSettings(guardCommand: string): unknown {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: GUARD_MATCHER,
          hooks: [{ type: 'command', command: guardCommand }],
        },
      ],
    },
  };
}

/** The shell command string the PreToolUse hook runs: this binary, re-entered
 *  in guard mode against this pipeline root. Every path is double-quoted —
 *  install paths contain spaces on both Windows and macOS. */
export function buildGuardCommand(execPath: string, cliPath: string, pipelineRoot: string): string {
  return `"${execPath}" "${cliPath}" fix --scope-guard --root "${pipelineRoot}"`;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface FixArgs {
  root?: string;
  project?: string;
  model?: string;
  timeoutSec?: string;
  json: boolean;
  help: boolean;
  scopeGuard: boolean;
  unknownFlag?: string;
}

function parseArgs(args: string[]): FixArgs {
  const out: FixArgs = { json: false, help: false, scopeGuard: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (a === '--scope-guard') out.scopeGuard = true;
    else if (a === '--root') out.root = args[++i];
    else if (eq('--root') !== undefined) out.root = eq('--root');
    else if (a === '--project') out.project = args[++i];
    else if (eq('--project') !== undefined) out.project = eq('--project');
    else if (a === '--model') out.model = args[++i];
    else if (eq('--model') !== undefined) out.model = eq('--model');
    else if (a === '--timeout') out.timeoutSec = args[++i];
    else if (eq('--timeout') !== undefined) out.timeoutSec = eq('--timeout');
    else if (a.startsWith('-')) out.unknownFlag = a;
  }
  return out;
}

/**
 * SAFETY PROPERTY 4 — the trust level, in the command's own help. A user
 * invoking this from a terminal must know an agent is about to edit files.
 */
export function helpText(): string {
  return (
    `${USAGE}\n\n` +
    'Resolve the errors and warnings `pipeline plan` reports for a pipeline, by\n' +
    'running an AI coding session over that pipeline folder.\n\n' +
    'TRUST LEVEL — READ THIS:\n' +
    '  This command starts a headless Claude Code agent that EDITS FILES IN YOUR\n' +
    '  PROJECT. It runs with `--permission-mode acceptEdits` from your project\n' +
    '  root, without asking per edit — the same trust level as `pipeline drive`.\n' +
    '  Write scope is ENFORCED, not just requested: a PreToolUse hook denies\n' +
    '  every Edit/Write/MultiEdit/NotebookEdit whose target resolves outside\n' +
    '  <pipeline_root>, and a --root outside the project\'s .pipeline/ directory\n' +
    '  is refused before anything is spawned. `Bash` inside the session is NOT\n' +
    '  path-restricted (same as `pipeline drive`). Commit or stash your work\n' +
    '  first if you want a clean diff to review.\n\n' +
    '  Nothing is uploaded: no telemetry, no control-plane round-trip. The only\n' +
    '  network call is the model session `claude` itself makes.\n\n' +
    'Options:\n' +
    '  --root <path>      The pipeline folder to fix. Required. Must resolve\n' +
    "                     inside the project's .pipeline/ directory.\n" +
    '  --project <path>   Project root (default: current directory). This is the\n' +
    "                     trust anchor for --root's containment check and the\n" +
    "                     session's working directory.\n" +
    '  --model <m>        haiku | sonnet | opus | fable, or a canonical claude-*\n' +
    '                     id (default: sonnet).\n' +
    `  --timeout <sec>    Wall-clock cap on the session (default: ${DEFAULT_TIMEOUT_MS / 1000}).\n` +
    '  --json             Print one JSON result object instead of a transcript.\n' +
    '  --help, -h         Show this help.\n\n' +
    'Exit codes:\n' +
    '  0  the reported issues are gone (or there were none)\n' +
    '  1  the session failed, or issues remain\n' +
    '  2  usage error, --root outside the project, or no readable manifest\n'
  );
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export async function runFix(args: string[], deps: FixDeps = {}): Promise<number> {
  const a = parseArgs(args);
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const err = deps.err ?? ((s: string) => process.stderr.write(s));
  const usage = (msg: string): number => {
    err(`pipeline fix: ${msg}\n`);
    return 2;
  };

  if (a.scopeGuard) return runScopeGuard(args, { out, err });
  if (a.help) {
    out(helpText());
    return 0;
  }
  if (a.unknownFlag !== undefined) return usage(`unknown flag '${a.unknownFlag}'\n${USAGE}`);
  if (!a.root) return usage(`--root is required\n${USAGE}`);

  const projectRoot = resolve(a.project ?? deps.cwd ?? process.cwd());
  const pipelineRoot = resolve(a.root);

  // ==== SAFETY PROPERTY 2 =================================================
  // BEFORE the manifest stat, BEFORE computePlan, BEFORE the settings file,
  // BEFORE the spawn. Nothing above this line touches the pipeline folder and
  // nothing above it can start a process. Do not move it down.
  // ========================================================================
  if (!isInsidePipelinesDir(projectRoot, pipelineRoot)) {
    return usage(
      `refusing to fix '${pipelineRoot}': it is outside '${join(projectRoot, '.pipeline')}'.\n` +
        `  pipeline fix only edits pipelines inside the current project. Pass --project <path>\n` +
        `  if the pipeline belongs to a different project root.`,
    );
  }

  const manifestName = existsSync(join(pipelineRoot, MANIFEST_FILENAME))
    ? MANIFEST_FILENAME
    : existsSync(join(pipelineRoot, 'PIPELINE.md'))
      ? 'PIPELINE.md'
      : null;
  if (manifestName === null) {
    return usage(`no ${MANIFEST_FILENAME} or PIPELINE.md at '${pipelineRoot}' — not a pipeline folder.`);
  }

  const model = (() => {
    if (a.model === undefined) return 'sonnet';
    const norm = normalizeModel(a.model);
    return norm.invalid || norm.model === null ? null : norm.model;
  })();
  if (model === null) {
    return usage(`unknown model '${a.model}' (haiku|sonnet|opus|fable, or a claude-* id)`);
  }

  const timeoutMs = (() => {
    if (a.timeoutSec === undefined) return DEFAULT_TIMEOUT_MS;
    const n = Number(a.timeoutSec);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
  })();
  if (timeoutMs === null) return usage(`--timeout expects a positive number of seconds`);

  const before = computePlan(pipelineRoot);
  const issues = [...before.errors, ...before.warnings]
    .filter((s) => typeof s === 'string' && s.trim() !== '')
    .slice(0, MAX_ISSUES);

  if (issues.length === 0) {
    if (a.json) {
      out(
        JSON.stringify(
          { ok: true, pipeline_root: pipelineRoot, issues_before: 0, issues_after: 0, resolved: true },
          null,
          2,
        ) + '\n',
      );
    } else {
      out(`Nothing to fix — \`pipeline plan --root "${pipelineRoot}"\` reports no errors or warnings.\n`);
    }
    return 0;
  }

  if (!a.json) {
    err(`pipeline fix: ${issues.length} issue(s) in ${pipelineRoot}\n`);
    for (const i of issues) err(`  - ${i}\n`);
    err(
      `\nStarting a headless ${model} session with acceptEdits from ${projectRoot}.\n` +
        `Edits outside ${pipelineRoot} are denied by a PreToolUse hook. Ctrl-C to abort.\n\n`,
    );
  }

  // The temp settings file carries the PreToolUse guard. A file (not inline
  // JSON on argv) so no quoting rule on any platform can shear it.
  const settingsDir = mkdtempSync(join(tmpdir(), 'pipeline-fix-'));
  const settingsPath = join(settingsDir, 'settings.json');
  const cliPath = resolve(import.meta.dir, '..', 'cli.ts');
  const guardCommand = buildGuardCommand(process.execPath, cliPath, pipelineRoot);
  writeFileSync(settingsPath, JSON.stringify(buildGuardSettings(guardCommand), null, 2), 'utf8');

  // `--verbose` is REQUIRED with `--output-format stream-json`: `-p
  // --output-format stream-json` is rejected at startup without it (measured
  // on claude 2.1.222). Frames are parsed as they arrive so tool calls surface
  // while the session runs.
  const argv = [
    'claude',
    '-p',
    '--model',
    model,
    '--permission-mode',
    'acceptEdits', // SAFETY PROPERTY 3 — parity with `pipeline drive`; do not raise.
    '--settings',
    settingsPath,
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  const startedMs = Date.now();
  let toolsCalled = 0;
  const session = deps.session ?? subprocessSession;
  let result: FixSessionResult;
  try {
    result = await session({
      argv,
      cwd: projectRoot, // SAFETY PROPERTY 3 — the project root, as `drive` does.
      prompt: buildFixPrompt(pipelineRoot, manifestName, issues),
      env: buildFixChildEnv(),
      timeoutMs,
      onToolCall: (tool) => {
        toolsCalled += 1;
        if (!a.json) err(`  · ${tool}\n`);
      },
    });
  } finally {
    try {
      rmSync(settingsDir, { recursive: true, force: true });
    } catch {
      /* best effort — a leaked temp dir is not worth failing the command */
    }
  }

  const durationMs = Date.now() - startedMs;

  if (result.code !== 0) {
    const message = result.error ?? `claude exited ${result.code}`;
    if (a.json) {
      out(
        JSON.stringify(
          {
            ok: false,
            pipeline_root: pipelineRoot,
            model,
            issues_before: issues.length,
            issues_after: issues.length,
            resolved: false,
            error: message,
            duration_ms: durationMs,
            tools_called: toolsCalled,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      err(`\npipeline fix: the session failed — ${message}\n`);
    }
    return 1;
  }

  const after = computePlan(pipelineRoot);
  const remaining = [...after.errors, ...after.warnings];
  const resolved = remaining.length === 0;

  if (a.json) {
    out(
      JSON.stringify(
        {
          ok: true,
          pipeline_root: pipelineRoot,
          model,
          issues_before: issues.length,
          issues_after: remaining.length,
          resolved,
          remaining,
          summary: result.summary ?? null,
          cost_usd: result.costUsd ?? null,
          duration_ms: durationMs,
          tools_called: toolsCalled,
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    if (result.summary) out(`\n${result.summary.trim()}\n`);
    out(
      `\n${issues.length} issue(s) before, ${remaining.length} after ` +
        `(${Math.round(durationMs / 1000)}s${result.costUsd != null ? `, $${result.costUsd.toFixed(4)}` : ''}).\n`,
    );
    if (!resolved) {
      err(`Still reported by \`pipeline plan\`:\n`);
      for (const r of remaining) err(`  - ${r}\n`);
    }
  }
  return resolved ? 0 : 1;
}
