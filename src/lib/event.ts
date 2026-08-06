// Event journal writer.
//
// (Historically a TypeScript port of the local dashboard's writer.py; both that
// file and the dashboard are gone. The journal is not — it is ux-v2's telemetry
// source and what `pipeline logs` renders.)
//
// Appends one JSON event to
//     <project-root>/.pipeline/.runtime/events.jsonl
//
// This is a FAITHFUL MECHANICAL PORT of writer.py. The envelope shape/order,
// kv coercion, worktree detection, rotation, mirror-binding, and liveness logic
// are byte-for-byte compatible with the Python so the two emitters can write the
// same journal interchangeably. The worktree/envelope logic intentionally
// mirrors hooks/analytics_relay.ts (resolveProjectRoot, SCHEMA_VERSION, the
// event envelope) so the journal stays consistent — but the logic is duplicated
// here, not imported, to keep pipeline-cli self-contained.
//
// Every entry point ALWAYS returns 0 (never block the caller). Debug logging
// goes to stderr only when PIPELINE_UI_DEBUG=1.

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  readFileSync,
  statSync,
  renameSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { ensureGeneratedDir } from './generated-dir';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute, basename } from 'node:path';

// Schema v5 — see EVENTS.md. Kept in lockstep with analytics_relay.ts /
// server.ts. v4 added the optional `step_id` field on iteration.* events; v5
// RENAMES it to `step_name` (pipeline v2: a step is a manifest entry named by
// `name:`). The rename is the only non-additive change in the journal's
// history, which is why it bumps the stamp at all — every prior addition
// stayed at its version. Readers MUST still accept `step_id` (EVENTS.md's
// "a reader at vN parses vN-1 cleanly" invariant): journals already on disk
// keep folding, so no already-computed analytic reattributes.
export const SCHEMA_VERSION = 5;

// Keep in sync with hooks/analytics_relay.ts's MIRROR_BINDING_SCHEMA (issue #11).
// The bindings journal is now read by analytics_relay.ts's own session→run
// lookup; the dashboard's MirrorService that first consumed it is deleted.
export const MIRROR_BINDING_SCHEMA = 1;

const DEBUG = process.env.PIPELINE_UI_DEBUG === '1';

function log(msg: string): void {
  if (DEBUG) process.stderr.write(`[pipeline-ui-writer] ${msg}\n`);
}

/** Transcript opt-out switch (`PIPELINE_UI_TRANSCRIPTS`, default ON). Gates
 *  ONLY the transcript pointer this writer records on the Path-B supervisor
 *  mirror binding: when off, `registerMirrorBinding` writes `transcript_path:
 *  null` so nothing downstream can reach the session transcript through the
 *  binding, while the binding still carries run_id/session_id for correlation. Same falsy parse as
 *  `PIPELINE_UI_ENABLED`. Orthogonal to `PIPELINE_STATS_ENABLED`. */
export function pipelineUiTranscriptsEnabled(): boolean {
  const v = (process.env.PIPELINE_UI_TRANSCRIPTS ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

/** Master UI opt-out switch (`PIPELINE_UI_ENABLED`, default ON) — the same
 *  first-statement gate `hooks/analytics_relay.ts` and `hooks/session_relay.ts`
 *  apply. Only an explicit falsy value (`0`/`false`/`no`/`off`) disables; unset,
 *  empty and every other value leave it enabled.
 *
 *  This is the CLI-side copy of the helper the two hooks duplicate (they cannot
 *  import a sibling at runtime), so the count of independent copies is three:
 *  here, `hooks/analytics_relay.ts`, and `hooks/session_relay.ts`. Keep the
 *  falsy-parse semantics identical in all of them.
 *
 *  Used by {@link registerDriveSessionBinding}: "opted out ⇒ no mirror
 *  bindings" is part of the master switch's contract (`docs/journal-and-hooks.md`),
 *  and drive writes its bindings unprompted, so the gate belongs on that path.
 *  `emitEvent`/`registerMirrorBinding` deliberately stay ungated — they are
 *  called explicitly by `/pipeline:run` and journal what `pipeline logs` reads. */
export function pipelineUiEnabled(): boolean {
  const v = (process.env.PIPELINE_UI_ENABLED ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** UTC now as `YYYY-MM-DDTHH:MM:SS.mmmZ` — identical to Python's
 *  datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
 *  "+00:00","Z"). `Date.toISOString()` produces exactly this format. */
function utcNowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Path equality (case-insensitive on Windows; samefile-style when both exist)
// ---------------------------------------------------------------------------

/** Compare two resolved paths, case-insensitively on Windows.
 *
 *  Mirrors writer.py's _paths_equal: when both paths exist, compare them by
 *  real (canonical) path so `c:/projects/foo` and `C:/Projects/Foo` match on
 *  NTFS; otherwise fall back to a normcase/lowercased compare. On POSIX the
 *  fallback is a strict string compare. */
function pathsEqual(a: string, b: string): boolean {
  try {
    if (existsSync(a) && existsSync(b)) {
      try {
        return realpathSync(a) === realpathSync(b);
      } catch {
        // fall through to normcase compare
      }
    }
  } catch {
    // fall through
  }
  return normcase(a) === normcase(b);
}

/** Mirror of os.path.normcase: lowercase + backslashes on Windows, identity on
 *  POSIX. */
function normcase(p: string): string {
  if (process.platform === 'win32') {
    return p.replace(/\//g, '\\').toLowerCase();
  }
  return p;
}

// ---------------------------------------------------------------------------
// Home-runtime bookkeeping
// ---------------------------------------------------------------------------

/** Per-user bookkeeping dir (~/.claude/pipeline-ui) — home of the mirror
 *  bindings journal.
 *
 *  Reads process.env first (USERPROFILE/HOME) so tests can override the home
 *  dir between cases — matching analytics_relay.ts:mirrorBindingsPath, since
 *  Node's os.homedir() caches the home dir at process start. */
function userHomeRuntime(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(home, '.claude', 'pipeline-ui');
}

// ---------------------------------------------------------------------------
// Worktree detection
// ---------------------------------------------------------------------------

export interface ResolvedRoot {
  /** Main repo working tree. */
  project_root: string;
  /** Worktree path string, or null when `start` is not inside a git worktree. */
  worktree: string | null;
}

/** Walk up from `start` to find a `.git` entry. Returns
 *  (main_repo_working_tree, worktree_path_or_null).
 *
 *  - `.git` is a directory → not a worktree → (parent_of_.git=cur, null).
 *  - `.git` is a file with `gitdir: <path>` → it's a worktree; follow
 *    <gitdir>/commondir to find the parent repo; the main working tree is
 *    common.parent when common's basename is `.git`, else common. Returns
 *    (mainRoot, cur).
 *  - no `.git` found → (resolve(start), null).
 *
 *  Mirrors writer.py:resolve_project_root and analytics_relay.ts:
 *  resolveProjectRoot byte-for-byte. */
/** The main working tree recorded in a submodule's module directory.
 *
 *  A worktree of a SUBMODULE resolves its commondir to `<repo>/.git/modules/
 *  <name>`, which is not a working tree at all — git records the submodule's
 *  checkout there as `core.worktree`. Without this, every worktree of a
 *  submodule registers as its own project under a path inside `.git`.
 *
 *  This is the CANONICAL copy of submoduleWorktreeOf — this package publishes
 *  standalone to npm and cannot import a sibling app at runtime.
 *  apps/pipeline-cli/tests/resolve-parity.test.ts fails on drift. */
function submoduleWorktreeOf(commonDir: string): string | null {
  try {
    const config = readFileSync(join(commonDir, 'config'), 'utf-8');
    let inCore = false;
    for (const rawLine of config.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('[')) {
        inCore = line.toLowerCase().startsWith('[core');
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

export function resolveProjectRoot(start: string): ResolvedRoot {
  let cur = resolve(start);
  for (let i = 0; i < 64; i++) {
    const gitPath = join(cur, '.git');
    if (existsSync(gitPath)) {
      let st;
      try {
        st = statSync(gitPath);
      } catch {
        st = null;
      }
      if (st && st.isDirectory()) {
        return { project_root: cur, worktree: null };
      }
      if (st && st.isFile()) {
        try {
          const content = readFileSync(gitPath, 'utf-8').trim();
          if (content.startsWith('gitdir:')) {
            const raw = content.split(/:(.*)/s)[1]?.trim() ?? '';
            let gitdir = raw;
            if (!isAbsolute(gitdir)) {
              gitdir = resolve(cur, gitdir);
            }
            const commondirFile = join(gitdir, 'commondir');
            if (existsSync(commondirFile)) {
              const commondir = readFileSync(commondirFile, 'utf-8').trim();
              const common = isAbsolute(commondir)
                ? resolve(commondir)
                : resolve(gitdir, commondir);
              // common usually ends in `.git` → its parent is the main tree.
              if (basename(common) === '.git') {
                return { project_root: resolve(dirname(common)), worktree: cur };
              }
              // Submodule worktree: common is `<repo>/.git/modules/<name>`.
              const checkout = submoduleWorktreeOf(common);
              if (checkout) return { project_root: resolve(checkout), worktree: cur };
              // Unknown parent — treat this worktree as its own project rather
              // than recording a path inside `.git`.
              return { project_root: cur, worktree: null };
            }
            // No commondir → fall through to treat as a plain repo.
          }
        } catch (e) {
          log(`failed to read ${gitPath}: ${e}`);
        }
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { project_root: resolve(start), worktree: null };
}

// ---------------------------------------------------------------------------
// Runtime dirs
// ---------------------------------------------------------------------------

function ensureRuntimeDir(projectRoot: string): string {
  const runtime = join(projectRoot, '.pipeline', '.runtime');
  // The whole .runtime tree is machine-generated — journals, liveness
  // lockfiles, per-run session ids, rendered shadow copies. Mark it ignored at
  // the root so a `git add -A` after a run cannot sweep it into a commit.
  ensureGeneratedDir(runtime);
  return runtime;
}

function runsLivenessDir(projectRoot: string): string {
  return join(projectRoot, '.pipeline', '.runtime', 'runs');
}

// ---------------------------------------------------------------------------
// kv parsing
// ---------------------------------------------------------------------------

export type KvValue = string | number | boolean | null;

export interface ParsedKv {
  data: Record<string, KvValue>;
  projectRootOverride: string | null;
}

/** Mirror of Python int(v) acceptance for kv coercion. Python int() accepts an
 *  optional leading sign and base-10 digits (and would accept leading zeros and
 *  surrounding whitespace / underscores). kv values never carry whitespace or
 *  underscores, so the simple `/^[+-]?\d+$/` form matches Python's behavior for
 *  every value the writer sees. Rejects "1.5", "1e3", "" → kept as string. */
const INT_RE = /^[+-]?\d+$/;

/** Split kv args into payload data + an optional --project-root override.
 *  Faithful port of writer.py:_parse_kv_args. */
export function parseKvArgs(args: string[]): ParsedKv {
  const data: Record<string, KvValue> = {};
  let projectRootOverride: string | null = null;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--project-root=')) {
      projectRootOverride = arg.slice('--project-root='.length);
      i += 1;
      continue;
    }
    if (arg === '--project-root') {
      if (i + 1 < args.length) {
        projectRootOverride = args[i + 1];
        i += 2;
      } else {
        log('--project-root flag has no value; ignoring');
        i += 1;
      }
      continue;
    }
    if (!arg.includes('=')) {
      log(`ignoring malformed arg (no '='): ${arg}`);
      i += 1;
      continue;
    }
    const eq = arg.indexOf('=');
    const k = arg.slice(0, eq);
    const v = arg.slice(eq + 1);
    // Coerce to null / bool / int; else keep string.
    if (v === 'null') {
      data[k] = null;
    } else if (v === 'true') {
      data[k] = true;
    } else if (v === 'false') {
      data[k] = false;
    } else if (INT_RE.test(v)) {
      data[k] = Number(v);
    } else {
      data[k] = v;
    }
    i += 1;
  }
  return { data, projectRootOverride };
}

// ---------------------------------------------------------------------------
// Rotation + append
// ---------------------------------------------------------------------------

/** Format a UTC Date as `%Y%m%d-%H%M%S-%f` (Python strftime), where %f is 6
 *  microsecond digits. JS has no microseconds; we pad the milliseconds to 6
 *  digits (the trailing 3 are always 000). The format — not the sub-millisecond
 *  precision — is what matters for the rare rotation path. */
function rotationStamp(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const mo = p2(d.getUTCMonth() + 1);
  const da = p2(d.getUTCDate());
  const h = p2(d.getUTCHours());
  const mi = p2(d.getUTCMinutes());
  const s = p2(d.getUTCSeconds());
  const micros = String(d.getUTCMilliseconds()).padStart(3, '0') + '000';
  return `${y}${mo}${da}-${h}${mi}${s}-${micros}`;
}

const ROTATE_BYTES = 50 * 1024 * 1024;

/** Append one event line to events.jsonl, rotating at 50 MB first. Faithful
 *  port of writer.py:_append_event. */
function appendEventLine(runtimeDir: string, event: unknown): void {
  const journal = join(runtimeDir, 'events.jsonl');
  try {
    if (existsSync(journal) && statSync(journal).size > ROTATE_BYTES) {
      const stamp = rotationStamp(new Date());
      const pid = process.pid;
      let target = join(runtimeDir, `events-${stamp}-${pid}.jsonl`);
      let attempt = 0;
      while (existsSync(target) && attempt < 10) {
        attempt += 1;
        target = join(runtimeDir, `events-${stamp}-${pid}-${attempt}.jsonl`);
      }
      renameSync(journal, target);
    }
  } catch (e) {
    log(`rotation failed: ${e}`);
  }
  // Compact JSON, no spaces — matches Python separators=(",",":").
  const line = JSON.stringify(event);
  appendFileSync(journal, line + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Envelope normalization
// ---------------------------------------------------------------------------

/** Normalize an envelope override value: null → null, else String(v); empty
 *  string → null. Mirrors writer.py's inner _norm_envelope. */
function normEnvelope(v: KvValue | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s ? s : null;
}

// ---------------------------------------------------------------------------
// Transcript-path encoding (mirror binding)
// ---------------------------------------------------------------------------

/** Mirror of vendor/transcript-walk.ts:encodeClaudeProjectDir and
 *  writer.py:_encode_claude_project_dir — replace each `:`, `/`, `\` with `-`. */
function encodeClaudeProjectDir(absPath: string): string {
  let out = '';
  for (const ch of absPath) {
    out += ch === ':' || ch === '/' || ch === '\\' ? '-' : ch;
  }
  return out;
}

/** Best-effort: locate the main-session transcript jsonl for a project_root +
 *  session_id. Returns null when session_id is missing or the path does not
 *  exist. Mirrors writer.py:_derive_main_transcript_path. Uses the same
 *  env-overridable home resolution as userHomeRuntime so tests can redirect it. */
function deriveMainTranscriptPath(projectRoot: string, sessionId: string | null): string | null {
  if (!sessionId) return null;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  const encoded = encodeClaudeProjectDir(projectRoot);
  const candidate = join(home, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  return existsSync(candidate) ? candidate : null;
}

function mirrorBindingsPath(): string {
  return join(userHomeRuntime(), 'active-mirror-bindings.jsonl');
}

// ---------------------------------------------------------------------------
// Envelope root resolution (shared by emitEvent / emitEventJson)
// ---------------------------------------------------------------------------

/** Resolve the envelope's project_root + worktree: with an explicit override,
 *  use it but STILL detect worktree from cwd — inherited only when the
 *  resolved main repo matches the override (case-insensitive on Windows);
 *  otherwise detect both from cwd. Extracted verbatim from emitEvent so the
 *  kv and structured emitters can never drift. */
function resolveEnvelopeRoot(projectRootOverride: string | null): {
  projectRoot: string;
  worktree: string | null;
} {
  if (projectRootOverride) {
    const overridePath = resolve(projectRootOverride);
    let cwd: string;
    try {
      cwd = process.cwd();
    } catch {
      cwd = overridePath;
    }
    const { project_root: resolvedRoot, worktree: resolvedWorktree } =
      resolveProjectRoot(cwd);
    if (resolvedWorktree !== null && pathsEqual(resolvedRoot, overridePath)) {
      return { projectRoot: overridePath, worktree: resolvedWorktree };
    }
    return { projectRoot: overridePath, worktree: null };
  }
  const cwd = process.cwd();
  const resolved = resolveProjectRoot(cwd);
  return { projectRoot: resolved.project_root, worktree: resolved.worktree };
}

// ---------------------------------------------------------------------------
// Public API: emitEvent
// ---------------------------------------------------------------------------

/** Build the envelope and append it to events.jsonl. Always
 *  returns 0. `argv` is the kv-arg list AFTER the event-type token.
 *  Faithful port of the event-emit branch of writer.py:main. */
export function emitEvent(eventType: string, argv: string[]): number {
  const { data, projectRootOverride } = parseKvArgs(argv);

  // Envelope-level overrides passed as k=v alongside data fields. Pop them out
  // of `data` so they don't leak into the payload, letting them take precedence
  // over the env fallback.
  const runIdOverride = popKey(data, 'run_id');
  const parentRunIdOverride = popKey(data, 'parent_run_id');
  const sessionIdOverride = popKey(data, 'session_id');

  const runIdValue =
    normEnvelope(runIdOverride) ?? envOrNull('PIPELINE_UI_RUN_ID');
  const parentRunIdValue =
    normEnvelope(parentRunIdOverride) ?? envOrNull('PIPELINE_UI_PARENT_RUN_ID');
  const sessionIdValue =
    normEnvelope(sessionIdOverride) ?? envOrNull('CLAUDE_SESSION_ID');

  const { projectRoot, worktree } = resolveEnvelopeRoot(projectRootOverride);

  const event = {
    schema: SCHEMA_VERSION,
    ts: utcNowIso(),
    type: eventType,
    project_root: projectRoot,
    worktree: worktree ? worktree : null,
    run_id: runIdValue,
    parent_run_id: parentRunIdValue,
    session_id: sessionIdValue,
    data,
  };

  try {
    const runtime = ensureRuntimeDir(projectRoot);
    appendEventLine(runtime, event);
  } catch (e) {
    log(`journal write failed: ${e}`);
    return 0;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Public API: emitEventJson (structured data payloads)
// ---------------------------------------------------------------------------

export interface EmitEventJsonOpts {
  /** Envelope run_id override (else the PIPELINE_UI_RUN_ID env fallback). */
  runId?: string | null;
  parentRunId?: string | null;
  sessionId?: string | null;
  /** Explicit project_root (else resolved from cwd, worktree-aware). */
  projectRoot?: string | null;
}

/**
 * Append one event whose `data` payload is a STRUCTURED object — nested
 * objects/arrays survive verbatim, which the kv interface of {@link emitEvent}
 * cannot carry (kv values coerce to scalars only). Needed for events whose
 * cloud-consumed shape REQUIRES nested objects, e.g. `awaiting_input`'s
 * `question: {text, context, options}` (the pipeline-protocol
 * `AwaitingInputData` schema, consumed by the control plane's runs/ingest).
 *
 * Envelope shape and resolution are identical to emitEvent: same schema
 * version, same field order, same env fallbacks (PIPELINE_UI_RUN_ID /
 * PIPELINE_UI_PARENT_RUN_ID / CLAUDE_SESSION_ID), same project_root/worktree
 * detection (shared resolveEnvelopeRoot), same rotation. `data`
 * is journalled as passed (caller owns the payload shape). Always returns 0 —
 * never blocks the caller.
 */
export function emitEventJson(
  eventType: string,
  data: Record<string, unknown>,
  opts: EmitEventJsonOpts = {},
): number {
  const runIdValue = normEnvelope(opts.runId ?? undefined) ?? envOrNull('PIPELINE_UI_RUN_ID');
  const parentRunIdValue =
    normEnvelope(opts.parentRunId ?? undefined) ?? envOrNull('PIPELINE_UI_PARENT_RUN_ID');
  const sessionIdValue = normEnvelope(opts.sessionId ?? undefined) ?? envOrNull('CLAUDE_SESSION_ID');

  const { projectRoot, worktree } = resolveEnvelopeRoot(opts.projectRoot ?? null);

  const event = {
    schema: SCHEMA_VERSION,
    ts: utcNowIso(),
    type: eventType,
    project_root: projectRoot,
    worktree: worktree ? worktree : null,
    run_id: runIdValue,
    parent_run_id: parentRunIdValue,
    session_id: sessionIdValue,
    data,
  };

  try {
    const runtime = ensureRuntimeDir(projectRoot);
    appendEventLine(runtime, event);
  } catch (e) {
    log(`journal write failed: ${e}`);
    return 0;
  }

  return 0;
}

/** Pop a key from the data map, returning its value (or undefined). Mirrors
 *  Python dict.pop(key, None) semantics used for envelope overrides. */
function popKey(data: Record<string, KvValue>, key: string): KvValue | undefined {
  if (Object.prototype.hasOwnProperty.call(data, key)) {
    const v = data[key];
    delete data[key];
    return v;
  }
  return undefined;
}

/** Read an env var, treating "" as unset (returns null). Mirrors Python's
 *  `os.environ.get(...) or None`. */
function envOrNull(name: string): string | null {
  const v = process.env[name];
  return v ? v : null;
}

// ---------------------------------------------------------------------------
// Public API: registerMirrorBinding
// ---------------------------------------------------------------------------

/** Append a mirror-binding line to ~/.claude/pipeline-ui/active-mirror-bindings.jsonl.
 *  Faithful port of writer.py:_register_mirror_binding. Always returns 0; skips
 *  (still 0) when no run_id can be resolved. */
export function registerMirrorBinding(argv: string[]): number {
  const { data, projectRootOverride } = parseKvArgs(argv);

  let projectRoot: string;
  let worktree: string | null;
  if (projectRootOverride) {
    projectRoot = resolve(projectRootOverride);
    let cwd: string;
    try {
      cwd = process.cwd();
    } catch {
      cwd = projectRoot;
    }
    const { project_root: resolvedRoot, worktree: resolvedWorktree } =
      resolveProjectRoot(cwd);
    worktree =
      resolvedWorktree !== null && pathsEqual(resolvedRoot, projectRoot)
        ? resolvedWorktree
        : null;
  } else {
    const cwd = process.cwd();
    const resolved = resolveProjectRoot(cwd);
    projectRoot = resolved.project_root;
    worktree = resolved.worktree;
  }

  const runId = dataStrOr(data, 'run_id') || envOrNull('PIPELINE_UI_RUN_ID');
  if (!runId) {
    log('register-mirror-binding: no run_id; skipping');
    return 0;
  }

  const iterationPath = dataStrOr(data, 'iteration_path') || '';
  const pipelineName = dataStrOr(data, 'pipeline_name') || '';
  const sessionId = dataStrOr(data, 'session_id') || envOrNull('CLAUDE_SESSION_ID');
  // PIPELINE_UI_TRANSCRIPTS off: withhold the transcript pointer (and skip the
  // filesystem derivation) so nothing downstream can reach this session's
  // transcript; the binding still carries run_id/session_id for correlation.
  const transcriptPath = pipelineUiTranscriptsEnabled()
    ? (dataStrOr(data, 'transcript_path') ||
       deriveMainTranscriptPath(projectRoot, sessionId))
    : null;
  const toolUseId = data['tool_use_id'];

  const binding = {
    event: 'bound',
    tool_use_id: toolUseId === undefined ? null : toolUseId,
    run_id: String(runId),
    session_id: sessionId,
    transcript_path: transcriptPath,
    project_root: projectRoot,
    worktree: worktree ? worktree : null,
    pipeline_name: String(pipelineName),
    iteration_path: String(iterationPath),
    start_ts: utcNowIso(),
    kind: 'chain-controller',
    schema: MIRROR_BINDING_SCHEMA,
  };

  try {
    const bp = mirrorBindingsPath();
    mkdirSync(dirname(bp), { recursive: true });
    // Python uses json.dumps(..., ensure_ascii=False) (default separators);
    // JS JSON.stringify has no spaces either, so the lines match.
    appendFileSync(bp, JSON.stringify(binding) + '\n', 'utf-8');
  } catch (e) {
    log(`mirror binding write failed: ${e}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Public API: registerDriveSessionBinding (ux-v2 b7)
// ---------------------------------------------------------------------------

/** The identity `pipeline drive` pins onto ONE headless `claude -p` session. */
export interface DriveSessionBinding {
  /** The run that owns the session (a composed CHILD run's steps carry the
   *  child's run id, not the parent's — the same id drive stamps on the step's
   *  own events). */
  runId: string;
  /** The session UUID drive passes to `claude --session-id` / `--resume`. This
   *  is the JOIN KEY: Claude Code hands the same value to every hook that
   *  fires inside that child, so the hook's `resolveBindingFromEnvOrSession`
   *  finds this record by construction. */
  sessionId: string;
  /** The `step_uuid` (ux-v2 b4) of the execution this session performs. Null
   *  only when the caller genuinely has no step identity. */
  stepUuid: string | null;
  /** The run's project root; resolved from cwd (worktree-aware) when absent. */
  projectRoot?: string | null;
  pipelineName?: string | null;
  iterationPath?: string | null;
}

/**
 * PRE-WRITE the session→(run, step) binding that a headless `claude -p` child
 * will be attributed by, then spawn the child (ux-v2 b7).
 *
 * The write must happen BEFORE the spawn: the child's very first hook can fire
 * within milliseconds of exec, and a binding that lands afterwards would lose
 * exactly the events this exists to attribute. Drive pins the session id
 * itself, so the record is complete before the process it describes exists —
 * attribution by construction, not by correlation.
 *
 * `transcript_path` is deliberately `null`: at pre-write time the child's
 * transcript file does not exist yet, and a pointer-less record names no
 * transcript, so this binding never widens transcript scope (issue #11 scope
 * discipline is unchanged).
 *
 * Lifecycle: no explicit `terminal` record is written, and none is needed —
 * `findRunIdForSession` treats a binding as terminated once the run emits
 * `pipeline.completed`/`pipeline.halted` into events.jsonl, which retires every
 * binding sharing that run_id at once; a run that never terminates ages out at
 * `BINDING_MAX_AGE_MS` (7 days). A session id is minted per step-session
 * and never reused across runs, so a record whose spawn never happened can
 * never be matched by anything — it is inert bytes, bounded by compaction.
 *
 * Never throws; failure only degrades attribution.
 */
export function registerDriveSessionBinding(b: DriveSessionBinding): void {
  // Master opt-out: "no events, no mirror bindings" (docs/journal-and-hooks.md).
  if (!pipelineUiEnabled()) return;
  if (!b.runId || !b.sessionId) return;

  const { projectRoot, worktree } = resolveEnvelopeRoot(b.projectRoot ?? null);

  const binding = {
    event: 'bound',
    tool_use_id: null,
    run_id: b.runId,
    // ux-v2 b7: the step identity travels WITH the run identity, so a hook
    // event fired inside the child names both by construction.
    step_uuid: b.stepUuid ?? null,
    session_id: b.sessionId,
    transcript_path: null,
    project_root: projectRoot,
    worktree: worktree ? worktree : null,
    pipeline_name: b.pipelineName ? String(b.pipelineName) : '',
    iteration_path: b.iterationPath ? String(b.iterationPath) : '',
    start_ts: utcNowIso(),
    kind: 'drive-session',
    schema: MIRROR_BINDING_SCHEMA,
  };

  try {
    const bp = mirrorBindingsPath();
    mkdirSync(dirname(bp), { recursive: true });
    appendFileSync(bp, JSON.stringify(binding) + '\n', 'utf-8');
  } catch (e) {
    log(`drive session binding write failed: ${e}`);
  }
}

/** Return the value of `key` as the raw value coerced for `... or <fallback>`
 *  truthiness — Python's `data.get(key)` returns the coerced kv value. For the
 *  mirror-binding fields we want the truthy string form. null/0/false/"" are
 *  falsy and fall through to the fallback, matching Python `or`. Returns the
 *  string form when truthy, else null. */
function dataStrOr(data: Record<string, KvValue>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(data, key)) return null;
  const v = data[key];
  if (v === null || v === undefined) return null;
  if (v === false) return null;
  if (v === 0) return null;
  if (v === '') return null;
  return String(v);
}

// ---------------------------------------------------------------------------
// Subcommand root resolution (write/clear liveness)
// ---------------------------------------------------------------------------

interface SubcommandRoot {
  projectRoot: string;
  data: Record<string, KvValue>;
}

/** Faithful port of writer.py:_resolve_root_for_subcommand. */
function resolveRootForSubcommand(argv: string[]): SubcommandRoot {
  const { data, projectRootOverride } = parseKvArgs(argv);
  let projectRoot: string;
  if (projectRootOverride) {
    projectRoot = resolve(projectRootOverride);
  } else {
    try {
      projectRoot = resolveProjectRoot(process.cwd()).project_root;
    } catch {
      projectRoot = process.cwd();
    }
  }
  return { projectRoot, data };
}

// ---------------------------------------------------------------------------
// Public API: writeLiveness / clearLiveness
// ---------------------------------------------------------------------------

/** Write a per-run liveness lockfile:
 *  <project>/.pipeline/.runtime/runs/<run_id>.alive = {pid, run_id, started_at}.
 *  Requires run_id + integer pid; skips (returns 0) otherwise. Faithful port of
 *  writer.py:_write_liveness. */
export function writeLiveness(argv: string[]): number {
  const { projectRoot, data } = resolveRootForSubcommand(argv);
  const runId = dataStrOr(data, 'run_id') || envOrNull('PIPELINE_UI_RUN_ID');
  const pid = data['pid'];
  // Python `isinstance(pid, int)` — kv coercion gives a number for a pure int
  // string, and bools are NOT ints here (bool kv values are true/false). In JS
  // we accept only a finite number that is not a boolean.
  if (!runId || typeof pid !== 'number' || !Number.isInteger(pid)) {
    log('write-liveness: missing run_id or non-int pid; skipping');
    return 0;
  }
  try {
    const d = runsLivenessDir(projectRoot);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, `${runId}.alive`),
      JSON.stringify({ pid, run_id: String(runId), started_at: utcNowIso() }),
      'utf-8',
    );
  } catch (e) {
    log(`write-liveness failed: ${e}`);
  }
  return 0;
}

/** Remove a run's liveness lockfile if present. Faithful port of
 *  writer.py:_clear_liveness. */
export function clearLiveness(argv: string[]): number {
  const { projectRoot, data } = resolveRootForSubcommand(argv);
  const runId = dataStrOr(data, 'run_id') || envOrNull('PIPELINE_UI_RUN_ID');
  if (!runId) return 0;
  try {
    const f = join(runsLivenessDir(projectRoot), `${runId}.alive`);
    if (existsSync(f)) rmSync(f);
  } catch (e) {
    log(`clear-liveness failed: ${e}`);
  }
  return 0;
}
