// The worktree-hook LIFECYCLE: the FROZEN `PIPELINE_WT_*` environment assembly
// plus the create / create-failed-cleanup / finalize / destroy invocations.
//
// lib/hooks.ts owns hook RESOLUTION and SPAWNING (which file, which
// interpreter, the supervisor, the stdout parse). This module owns what the
// consumer actually sees: the exact set of `PIPELINE_WT_*` variables each
// action carries, the timeouts, the success/failure classification, and the
// `worktree.*` events.
//
// It lives here — not inlined in commands/next.ts — because the contract is
// FROZEN and must therefore be SINGLE-HOMED. A pipeline run is one caller; a
// standalone `pipeline worktree …` command is another. A second copy of this
// assembly would give a frozen contract two dialects, so tests/worktree-hook-
// module.test.ts asserts that the run path and a direct call produce
// byte-identical `PIPELINE_WT_*` environments for the same inputs.
//
// Two properties make this callable from OUTSIDE a run:
//
//   1. THE EMITTER IS A PARAMETER. These lifecycles emit run-scoped
//      `worktree.created` / `worktree.finalized` / `worktree.destroyed` events
//      keyed on a run id. A caller that has no run passes `noopEmitter` and
//      writes no journal events at all — it must not fabricate run-scoped
//      history for a run that does not exist.
//   2. THESE FUNCTIONS RETURN PROVISIONING DATA, not the
//      `{kind:'worktree', phase:'provisioned', …}` state-machine record. The
//      run path wraps the returned data in that record itself; a standalone
//      caller has no state machine to feed.
//
// The consumer-facing contract itself is unchanged and remains as documented in
// lib/hooks.ts: inputs arrive as `PIPELINE_WT_*` environment variables, stdout
// is ONE JSON object, create is idempotent per `PIPELINE_WT_NAME`, destroy
// soft-fails via `{"ok":false,"detail":"…"}` + exit 0, finalize is strict
// must-succeed.

import { basename, isAbsolute } from 'node:path';
import { resolveHookScript, runHook, parseHookJson, tail } from './hooks';

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

export const CREATE_TIMEOUT_MS = 600_000; // create does submodule worktrees + pulls
export const DESTROY_TIMEOUT_MS = 300_000;
export const FINALIZE_TIMEOUT_MS = 600_000; // finalize may do arbitrary consumer work (commit/push/…) — create-like budget

/** Effective hook timeout: `PIPELINE_HOOK_TIMEOUT_MS` (a positive integer)
 *  overrides every hook budget — injectable so tests can exercise the timeout
 *  path with short values. Read per call, never cached at module load. */
export function hookTimeoutMs(base: number): number {
  const v = Number(process.env.PIPELINE_HOOK_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : base;
}

// ---------------------------------------------------------------------------
// The injected emitter
// ---------------------------------------------------------------------------

/** One `worktree.*` event: the type plus its ordered `[key, value]` fields.
 *  Ordered because the journal preserves field order — the run path adapts
 *  these straight onto its existing kv()/emitEvent writer. */
export type WorktreeEventEmitter = (
  eventType: 'worktree.created' | 'worktree.finalized' | 'worktree.destroyed',
  fields: ReadonlyArray<readonly [string, unknown]>,
) => void;

/** The run-less emitter: writes nothing. A standalone caller has no run id, so
 *  a run-scoped journal event would be a fabricated record. */
export const noopEmitter: WorktreeEventEmitter = () => {
  // intentionally empty
};

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/** Where the hooks live and what they are told about the tree. Field names are
 *  the resolved-absolute forms the env contract carries; the run path resolves
 *  them from the engine action, a standalone caller from its own flags. */
export interface WorktreeHookPaths {
  /** Absolute hook directory (`worktree-create.*` and friends live here). */
  hookDirAbs: string;
  /** `PIPELINE_WT_PROJECT_ROOT`. */
  projectRoot: string;
  /** `PIPELINE_WT_PIPELINE_ROOT`; `PIPELINE_WT_PIPELINE_NAME` is its basename.
   *  A run-less caller passes '' — basename('') is '', so both variables are
   *  then the empty string, which is exactly the standalone contract. */
  pipelineRootAbs: string;
}

/** Create inputs. The field names mirror the engine's `provision-worktree`
 *  action so the run path can pass the action itself. */
export interface CreateHookRequest {
  run_id: string;
  name: string;
  base_branch: string;
  submodules: string[];
  /** The hook dir AS DECLARED (possibly relative). Journalled on
   *  `worktree.created`; never part of the env contract. */
  hook_dir: string;
}

/** Finalize inputs — mirrors the engine's `finalize-worktree` action. */
export interface FinalizeHookRequest {
  run_id: string;
  name: string;
  base_branch: string;
  submodules: string[];
  worktree_path: string | null;
  outcome: 'completed';
}

/** Destroy inputs — mirrors the engine's `teardown-worktree` action. */
export interface DestroyHookRequest {
  run_id: string;
  name: string;
  worktree_path: string | null;
  outcome: 'completed' | 'halted' | 'depth-exhausted';
  delete_branches: boolean;
}

/** Post-failed-create cleanup inputs (the `run_id`/`name` of the create that
 *  failed). */
export interface CreateFailedCleanupRequest {
  run_id: string;
  name: string;
}

export interface ProvisionedInfo {
  worktree_path: string;
  branch: string | null;
  env_file: string | null;
}

export interface FinalizeInfo {
  ok: boolean;
  detail: string | null;
}

export interface TeardownInfo {
  ok: boolean;
  detail: string | null;
}

/** The create hook's INFORMATIONAL port fields, exactly as the frozen contract
 *  documents them: `{"port_base": 0, "ports": {"BACKEND_PORT": 5103}}`. */
export interface HookPorts {
  /** A positive base, or null for the `0`/absent the contract uses for "none". */
  port_base: number | null;
  /** Only well-formed entries survive: a port is an integer in 1..65535. */
  ports: Record<string, number>;
}

/** What a create attempt yields. PROVISIONING DATA, deliberately not a
 *  state-machine record: `provisioned` is non-null exactly when the hook
 *  honored the contract; `detail` carries the halt reason otherwise;
 *  `failedWorktreePath` is the best-effort path a failed create still named
 *  (fed to the create-failed cleanup). */
export interface CreateOutcome {
  ok: boolean;
  provisioned: ProvisionedInfo | null;
  detail: string | null;
  failedWorktreePath: string | null;
  /** D14's input, and NOTHING else's. The standalone command needs to know
   *  whether the hook returned ports at all, because per-field precedence says
   *  an EMPTY answer does not suppress the CLI's own allocation (02 §4.2).
   *  This does not widen what the RUN path consumes: `commands/next.ts` reads
   *  `worktree_path`/`branch`/`env_file` and this is not one of them — the
   *  contract's own line is that ports are informational and live in the env
   *  file. Null when the create failed. */
  hook_ports: HookPorts | null;
}

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

/** Execute the consumer's worktree-create hook per the FROZEN contract
 *  (`PIPELINE_WT_*` env vars; stdout = ONE JSON object with worktree_path;
 *  idempotent per name). Emits `worktree.created` (ok true/false) through the
 *  INJECTED emitter and returns provisioning data. */
export function runCreateHook(
  req: CreateHookRequest,
  paths: WorktreeHookPaths,
  emit: WorktreeEventEmitter = noopEmitter,
): CreateOutcome {
  const { hookDirAbs, projectRoot, pipelineRootAbs } = paths;
  const fail = (detail: string, failedWorktreePath: string | null = null): CreateOutcome => {
    emit('worktree.created', [
      ['run_id', req.run_id],
      ['ok', false],
      ['detail', detail],
    ]);
    return { ok: false, provisioned: null, detail, failedWorktreePath, hook_ports: null };
  };

  const script = resolveHookScript(hookDirAbs, 'worktree-create');
  if (!script) {
    return fail(`isolation: external but no ${hookDirAbs}/worktree-create.* found`);
  }

  const env: Record<string, string> = {
    PIPELINE_WT_ACTION: 'create',
    PIPELINE_WT_RUN_ID: req.run_id,
    PIPELINE_WT_NAME: req.name,
    PIPELINE_WT_PIPELINE_NAME: basename(pipelineRootAbs),
    PIPELINE_WT_PIPELINE_ROOT: pipelineRootAbs,
    PIPELINE_WT_PROJECT_ROOT: projectRoot,
    PIPELINE_WT_BASE_BRANCH: req.base_branch,
    PIPELINE_WT_SUBMODULES: req.submodules.join(','),
    PIPELINE_WT_DRY_RUN: '0',
  };
  const timeoutMs = hookTimeoutMs(CREATE_TIMEOUT_MS);
  const r = runHook(script, env, projectRoot, timeoutMs);
  const exitedClean = r.code === 0 && !r.timedOut && !r.error;
  const parsed = exitedClean ? parseHookJson(r.stdout) : null;
  const wtPath = parsed && typeof parsed.worktree_path === 'string' ? parsed.worktree_path : null;

  if (wtPath === null) {
    const why = r.timedOut
      ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : r.error
        ? `failed to spawn (${r.error})`
        : !exitedClean
          ? `exited ${r.code}`
          : 'stdout not JSON';
    return fail(`worktree-create hook ${why}: ${tail(r.stderr || r.stdout)}`);
  }

  // The contract requires an ABSOLUTE worktree_path — a relative one is a
  // create-hook failure (the same halt as garbage stdout), but the path is
  // still handed to the best-effort create-failed cleanup.
  if (!isAbsolute(wtPath)) {
    return fail(`worktree-create hook returned a non-absolute worktree_path '${wtPath}'`, wtPath);
  }

  const branch = typeof parsed!.branch === 'string' ? (parsed!.branch as string) : null;
  const envFile = typeof parsed!.env_file === 'string' ? (parsed!.env_file as string) : null;
  emit('worktree.created', [
    ['run_id', req.run_id],
    ['worktree_path', wtPath],
    ['branch', branch],
    ['env_file', envFile],
    ['ok', true],
    ['hook_dir', req.hook_dir],
  ]);
  return {
    ok: true,
    provisioned: { worktree_path: wtPath, branch, env_file: envFile },
    detail: null,
    failedWorktreePath: null,
    hook_ports: readHookPorts(parsed!),
  };
}

/** The hook's `port_base`/`ports`, defensively. A hook is consumer code: a
 *  string port, a null, an array, a `ports: 0` are all things it may print, and
 *  none of them may become a port a worker is told to use. `port_base: 0` — what
 *  this repository's own reference hook returns — reads as "none", which is the
 *  case D14 exists for. */
function readHookPorts(parsed: Record<string, unknown>): HookPorts {
  const rawBase = parsed.port_base;
  const port_base =
    typeof rawBase === 'number' && Number.isInteger(rawBase) && rawBase > 0 && rawBase <= 65535 ? rawBase : null;
  const ports: Record<string, number> = {};
  const rawPorts = parsed.ports;
  if (rawPorts !== null && typeof rawPorts === 'object' && !Array.isArray(rawPorts)) {
    for (const [k, v] of Object.entries(rawPorts as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65535) ports[k] = v;
    }
  }
  return { port_base, ports };
}

/** A3: best-effort cleanup after a FAILED create. The create hook may have done
 *  partial work before failing/timing out/printing garbage, so invoke the
 *  consumer's destroy hook ONCE with the additive `PIPELINE_WT_OUTCOME=
 *  create-failed` (full destroy-style env; `PIPELINE_WT_WORKTREE_PATH` only
 *  when the failed create output yielded one). STRICTLY fire-and-forget: never
 *  throws and never changes the caller's outcome; `worktree.destroyed` is
 *  emitted ONLY when the destroy hook reports ok. */
export function runCreateFailedCleanup(
  req: CreateFailedCleanupRequest,
  paths: WorktreeHookPaths,
  failedWorktreePath: string | null,
  emit: WorktreeEventEmitter = noopEmitter,
): void {
  const { hookDirAbs, projectRoot, pipelineRootAbs } = paths;
  try {
    const script = resolveHookScript(hookDirAbs, 'worktree-destroy');
    if (!script) return;
    const env: Record<string, string> = {
      PIPELINE_WT_ACTION: 'destroy',
      PIPELINE_WT_RUN_ID: req.run_id,
      PIPELINE_WT_NAME: req.name,
      PIPELINE_WT_PIPELINE_ROOT: pipelineRootAbs,
      PIPELINE_WT_PROJECT_ROOT: projectRoot,
      PIPELINE_WT_OUTCOME: 'create-failed',
      // ALWAYS '0' here: a failed create leaves a partial slot whose branch (if
      // any) is evidence — the cleanup must never reap it.
      PIPELINE_WT_DELETE_BRANCHES: '0',
      PIPELINE_WT_DRY_RUN: '0',
    };
    if (failedWorktreePath !== null) env.PIPELINE_WT_WORKTREE_PATH = failedWorktreePath;
    const r = runHook(script, env, projectRoot, hookTimeoutMs(DESTROY_TIMEOUT_MS));
    const exitedClean = r.code === 0 && !r.timedOut && !r.error;
    const parsed = parseHookJson(r.stdout);
    if (exitedClean && parsed?.ok !== false) {
      emit('worktree.destroyed', [
        ['run_id', req.run_id],
        ['worktree_path', failedWorktreePath],
        ['ok', true],
        ['outcome', 'create-failed'],
        ['detail', typeof parsed?.detail === 'string' ? parsed.detail : null],
      ]);
    }
  } catch {
    // Best-effort only — a cleanup failure must never affect the caller.
  }
}

/** Execute the consumer's MANDATORY worktree-finalize hook. UNLIKE destroy (a
 *  soft-fail that never strands the run), finalize is STRICT must-succeed: only
 *  an explicit `{"ok":true}` on a clean exit passes; a missing hook, non-zero
 *  exit, timeout, spawn error, or absent/false `ok` FAILS — the run path then
 *  halts the run and the worktree is preserved. Same FROZEN `PIPELINE_WT_*` env
 *  style as create/destroy (+ ACTION=finalize). GENERIC: the caller passes the
 *  worktree context and inspects only `ok` — it never inspects, requires, or
 *  cares WHAT the hook did (commit/push/bump/anything). Emits
 *  `worktree.finalized` through the injected emitter. */
export function runFinalizeHook(
  req: FinalizeHookRequest,
  paths: WorktreeHookPaths,
  emit: WorktreeEventEmitter = noopEmitter,
): FinalizeInfo {
  const { hookDirAbs, projectRoot, pipelineRootAbs } = paths;
  const script = resolveHookScript(hookDirAbs, 'worktree-finalize');
  let ok: boolean;
  let detail: string | null;
  if (!script) {
    // Opted in (e.g. `finalize: true` frontmatter) but no hook exists → the run
    // asked to finalize and cannot → FAIL loud (must-succeed gate). (When the
    // opt-in was hook-PRESENCE, this branch is unreachable.)
    ok = false;
    detail = `no ${hookDirAbs}/worktree-finalize.* hook found`;
  } else {
    const env: Record<string, string> = {
      PIPELINE_WT_ACTION: 'finalize',
      PIPELINE_WT_RUN_ID: req.run_id,
      PIPELINE_WT_NAME: req.name,
      PIPELINE_WT_PIPELINE_NAME: basename(pipelineRootAbs),
      PIPELINE_WT_PIPELINE_ROOT: pipelineRootAbs,
      PIPELINE_WT_PROJECT_ROOT: projectRoot,
      PIPELINE_WT_BASE_BRANCH: req.base_branch,
      PIPELINE_WT_SUBMODULES: req.submodules.join(','),
      PIPELINE_WT_WORKTREE_PATH: req.worktree_path ?? '',
      PIPELINE_WT_OUTCOME: req.outcome,
      PIPELINE_WT_DRY_RUN: '0',
    };
    const timeoutMs = hookTimeoutMs(FINALIZE_TIMEOUT_MS);
    const r = runHook(script, env, projectRoot, timeoutMs);
    const exitedClean = r.code === 0 && !r.timedOut && !r.error;
    const parsed = exitedClean ? parseHookJson(r.stdout) : null;
    ok = exitedClean && parsed?.ok === true; // STRICT: require an explicit ok:true
    if (typeof parsed?.detail === 'string') {
      detail = parsed.detail;
    } else if (ok) {
      detail = null;
    } else {
      const why = r.timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : r.error
          ? `failed to spawn (${r.error})`
          : !exitedClean
            ? `exited ${r.code}`
            : 'stdout missing {"ok":true}';
      detail = `worktree-finalize hook ${why}: ${tail(r.stderr || r.stdout)}`;
    }
  }
  emit('worktree.finalized', [
    ['run_id', req.run_id],
    ['worktree_path', req.worktree_path],
    ['ok', ok],
    ['outcome', req.outcome],
    ['detail', detail],
  ]);
  return { ok, detail };
}

/** Execute the consumer's worktree-destroy hook per the FROZEN contract
 *  ({"ok":true} / {"ok":false,"detail"} soft-fail / non-zero hard-fail). A
 *  missing or failing hook NEVER strands the run — the ok:false result still
 *  advances the run path's state machine to terminal. Emits
 *  `worktree.destroyed` through the injected emitter. */
export function runDestroyHook(
  req: DestroyHookRequest,
  paths: WorktreeHookPaths,
  emit: WorktreeEventEmitter = noopEmitter,
): TeardownInfo {
  const { hookDirAbs, projectRoot, pipelineRootAbs } = paths;
  const script = resolveHookScript(hookDirAbs, 'worktree-destroy');
  let ok: boolean;
  let detail: string | null;
  if (!script) {
    ok = false;
    detail = `no ${hookDirAbs}/worktree-destroy.* hook found`;
  } else {
    const env: Record<string, string> = {
      PIPELINE_WT_ACTION: 'destroy',
      PIPELINE_WT_RUN_ID: req.run_id,
      PIPELINE_WT_NAME: req.name,
      PIPELINE_WT_PIPELINE_ROOT: pipelineRootAbs,
      PIPELINE_WT_PROJECT_ROOT: projectRoot,
      PIPELINE_WT_WORKTREE_PATH: req.worktree_path ?? '',
      PIPELINE_WT_OUTCOME: req.outcome,
      // Outcome-aware (decided by the engine in emitTeardown): '1' only on a
      // COMPLETED run that has not opted out via `delete_branches: false`
      // frontmatter — the run branch dies with the worktree so a finished run
      // leaks nothing. halted/depth-exhausted always get '0' (preserve for
      // debugging/resume).
      PIPELINE_WT_DELETE_BRANCHES: req.delete_branches ? '1' : '0',
      PIPELINE_WT_DRY_RUN: '0',
    };
    const timeoutMs = hookTimeoutMs(DESTROY_TIMEOUT_MS);
    const r = runHook(script, env, projectRoot, timeoutMs);
    const exitedClean = r.code === 0 && !r.timedOut && !r.error;
    const parsed = parseHookJson(r.stdout);
    ok = exitedClean && parsed?.ok !== false;
    if (typeof parsed?.detail === 'string') {
      detail = parsed.detail;
    } else if (ok) {
      detail = null;
    } else {
      const why = r.timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : r.error
          ? `failed to spawn (${r.error})`
          : `exited ${r.code}`;
      detail = `worktree-destroy hook ${why}: ${tail(r.stderr || r.stdout)}`;
    }
  }
  emit('worktree.destroyed', [
    ['run_id', req.run_id],
    ['worktree_path', req.worktree_path],
    ['ok', ok],
    ['outcome', req.outcome],
    ['detail', detail],
  ]);
  return { ok, detail };
}
