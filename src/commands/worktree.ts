// `pipeline worktree create|finalize|destroy|list` — the FROZEN worktree-hook
// lifecycle WITHOUT a pipeline run (taskflow-v2 a2; 02-target-architecture.md
// §4.1, 03-execution-flows.md F3).
//
// An orchestrator that dispatches parallel workers needs a slot — a worktree,
// its branch, its env file — but has no pipeline run to hang it on. This
// command group provides exactly that, by CALLING lib/worktree-hooks.ts, the
// module the run path calls. It does NOT reassemble `PIPELINE_WT_*` itself: a
// second copy of a FROZEN contract's env assembly is how that contract acquires
// a second dialect (risk R3), and tests/worktree-hook-module.test.ts fails on
// any divergence between the run path and this command.
//
// THREE PROPERTIES MAKE THIS RUN-LESS:
//
//  1. THE EMITTER IS `noopEmitter`. `worktree.created`/`.finalized`/
//     `.destroyed` are RUN-SCOPED journal events keyed on a run id. There is no
//     run here, so nothing is journalled — a standalone invocation must never
//     fabricate history for a run that does not exist.
//
//  2. `PIPELINE_WT_PIPELINE_ROOT` and `PIPELINE_WT_PIPELINE_NAME` ARE THE EMPTY
//     STRING. The frozen contract lists them as always present, and outside a
//     run they have no natural value. The command passes `pipelineRootAbs: ''`
//     — `basename('')` is `''` — so both variables are present and empty rather
//     than absent. Documented, not silent: silence is the other way a frozen
//     contract acquires a second dialect.
//
//     ⚠ `PIPELINE_WT_NAME` is NOT emptied. It is the slot identity — the
//     contract makes the create hook "idempotent per `PIPELINE_WT_NAME`" and
//     derives the worktree dir, the `worktree-<name>` branch and the hook's own
//     registry key from it (docs/worktree-hook-contract.md). Emptying it would
//     collapse every standalone slot onto one nameless slot and make `--name`
//     inert. The taskflow's task file abbreviates the pair as
//     "`PIPELINE_WT_PIPELINE_ROOT` / `_NAME`" (02 §4.1 item 3); the two
//     variables that are empty here are the two PIPELINE_* ones.
//
//  3. `PIPELINE_WT_RUN_ID` CARRIES THE SLOT NAME. There is no run id, and an
//     empty one would break every consumer hook that names a branch or a log
//     after it. On the run path name and run id have always been equal, so
//     passing the slot name is the value existing hooks already expect — and it
//     is not a fabricated run: nothing writes a run journal, a run record, or a
//     `.runtime/<run-id>/` tree.
//
// SLOT BOOKKEEPING. `finalize`/`destroy` must tell the hook WHICH worktree
// (`PIPELINE_WT_WORKTREE_PATH`), and `list` must be able to answer at all. The
// run path reads that from its run state; there is none here, so `create`
// records one small JSON file per slot under
// `<project>/.pipeline/.runtime/worktrees/<name>.json`. ONE FILE PER SLOT, not
// one shared index: parallel dispatch is the whole point of this command, and a
// shared index would need a lock to survive two concurrent `create`s.
//
// Exit codes (all four subcommands):
//   0  the action succeeded
//   1  the hook failed — SOFT (`{"ok":false,"detail":…}` + exit 0) or HARD
//      (missing hook, non-zero exit, timeout, spawn error, non-JSON stdout).
//      `detail` in the output says which; the exit code deliberately does not
//      distinguish them, because both mean "the slot is not in the state you
//      asked for".
//   2  usage error: unknown flag/verb, missing value, invalid `--name` (SG6),
//      invalid `--outcome`, invalid `--ports`.

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { ensureGeneratedDir } from '../lib/generated-dir';
import { iterWorktrees, realGit, type GitRunner } from '../lib/git';
import { newId } from '../lib/ids';
import {
  noopEmitter,
  runCreateFailedCleanup,
  runCreateHook,
  runDestroyHook,
  runFinalizeHook,
  type WorktreeHookPaths,
} from '../lib/worktree-hooks';

/** Same default as the plan's `worktree_hook_dir` (lib/plan.ts). */
const DEFAULT_HOOK_DIR = '.pipeline/.hooks';

// ---------------------------------------------------------------------------
// SG6 — slot-name validation
//
// The slot name reaches a FILESYSTEM PATH and a GIT BRANCH NAME (`worktree-
// <name>`), inside a consumer-authored hook this command cannot audit. It is
// the injection surface of the whole command group, so it is validated against
// a strict allow-list BEFORE it reaches a path, a branch, the registry, or the
// hook environment — an allow-list, never a blocklist of known-bad characters.
// ---------------------------------------------------------------------------

/** Long enough for a UUIDv7 (36) plus a human prefix; short enough to stay
 *  inside path limits once a hook appends it to a worktree root. */
export const SLOT_NAME_MAX = 64;

/** Letters, digits, `.`, `_`, `-`; first character alphanumeric. Excludes (by
 *  construction) `/` `\` `:` whitespace `~` `$` `` ` `` `;` `|` `&` `<` `>` `*`
 *  `?` quotes, control characters, and a LEADING `-` (which git and most CLIs
 *  would read as a flag). */
const SLOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Windows reserved device names — a directory named `NUL` cannot be created
 *  and `CON.foo` resolves to the console device. */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** null when `name` is a legal slot name, else the reason it is refused. */
export function validateSlotName(name: string): string | null {
  if (name.length === 0) return 'must not be empty';
  if (name.length > SLOT_NAME_MAX) return `must be at most ${SLOT_NAME_MAX} characters (got ${name.length})`;
  if (!SLOT_NAME_RE.test(name))
    return "must match [A-Za-z0-9][A-Za-z0-9._-]* — letters, digits, '.', '_' and '-' only, first character alphanumeric (no path separators, whitespace, shell metacharacters, or leading '-')";
  if (name.includes('..')) return "must not contain '..'";
  if (name.endsWith('.')) return "must not end with '.'";
  if (WINDOWS_RESERVED_RE.test(name)) return 'must not be a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9)';
  return null;
}

// ---------------------------------------------------------------------------
// The slot registry — one JSON file per slot
// ---------------------------------------------------------------------------

export interface SlotRecord {
  name: string;
  worktree_path: string;
  branch: string | null;
  env_file: string | null;
  base_branch: string;
  submodules: string[];
  /** The hook dir AS DECLARED (possibly relative) — replayed by finalize/destroy. */
  hook_dir: string;
  /** `--ports N` as requested. NOT allocated yet — allocation ships with the
   *  built-in provisioner (taskflow-v2 a4). */
  ports_requested: number | null;
  created_at: string;
  updated_at: string;
  /** Set by `destroy` when the slot was PRESERVED rather than reaped. */
  outcome: 'completed' | 'halted' | null;
  finalized: boolean;
}

function runtimeDir(projectRoot: string): string {
  return join(projectRoot, '.pipeline', '.runtime');
}

function slotsDir(projectRoot: string): string {
  return join(runtimeDir(projectRoot), 'worktrees');
}

/** Safe because every caller validated `name` against SLOT_NAME_RE first. */
function slotFile(projectRoot: string, name: string): string {
  return join(slotsDir(projectRoot), `${name}.json`);
}

export function readSlot(projectRoot: string, name: string): SlotRecord | null {
  try {
    const raw = JSON.parse(readFileSync(slotFile(projectRoot, name), 'utf8')) as Partial<SlotRecord>;
    if (typeof raw.name !== 'string' || typeof raw.worktree_path !== 'string') return null;
    return {
      name: raw.name,
      worktree_path: raw.worktree_path,
      branch: typeof raw.branch === 'string' ? raw.branch : null,
      env_file: typeof raw.env_file === 'string' ? raw.env_file : null,
      base_branch: typeof raw.base_branch === 'string' ? raw.base_branch : 'main',
      submodules: Array.isArray(raw.submodules) ? raw.submodules.filter((s): s is string => typeof s === 'string') : [],
      hook_dir: typeof raw.hook_dir === 'string' ? raw.hook_dir : DEFAULT_HOOK_DIR,
      ports_requested: typeof raw.ports_requested === 'number' ? raw.ports_requested : null,
      created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
      outcome: raw.outcome === 'completed' || raw.outcome === 'halted' ? raw.outcome : null,
      finalized: raw.finalized === true,
    };
  } catch {
    // absent, unreadable, or not JSON — the slot is simply unknown to us
    return null;
  }
}

/** Write-then-rename so a reader never sees a half-written record. */
function writeSlot(projectRoot: string, rec: SlotRecord): void {
  const dir = slotsDir(projectRoot);
  ensureGeneratedDir(dir, runtimeDir(projectRoot));
  const target = slotFile(projectRoot, rec.name);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
}

function deleteSlot(projectRoot: string, name: string): void {
  try {
    unlinkSync(slotFile(projectRoot, name));
  } catch {
    // already gone — nothing to reap
  }
}

export function listSlots(projectRoot: string): SlotRecord[] {
  const dir = slotsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const out: SlotRecord[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.json')) continue;
    const rec = readSlot(projectRoot, entry.slice(0, -'.json'.length));
    if (rec) out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** The run path uses `process.cwd()` verbatim as `PIPELINE_WT_PROJECT_ROOT`
 *  (commands/next.ts) — this command does the same, so the two produce
 *  byte-identical environments. Run it from the project root. */
function projectRootOf(): string {
  return process.cwd();
}

function hookPathsFor(projectRoot: string, hookDir: string): WorktreeHookPaths {
  return {
    hookDirAbs: isAbsolute(hookDir) ? hookDir : join(projectRoot, hookDir),
    projectRoot,
    // Standalone: no pipeline. '' makes PIPELINE_WT_PIPELINE_ROOT and
    // PIPELINE_WT_PIPELINE_NAME (its basename) both the empty string.
    pipelineRootAbs: '',
  };
}

/** Canonical form for path comparison (case-folded on win32). No realpath: the
 *  path may not exist yet, and git already prints resolved paths. */
function normPath(p: string): string {
  let r = resolve(p);
  if (process.platform === 'win32') r = r.replace(/\//g, '\\').toLowerCase();
  return r.length > 1 ? r.replace(/[\\/]+$/, '') : r;
}

/** Registered git worktrees of the project, normalized. Best-effort: a
 *  non-repo (or a hook that provisions without git) yields an empty set and the
 *  reuse verdict falls back to the registry alone. */
function registeredWorktreePaths(git: GitRunner, projectRoot: string): Set<string> {
  try {
    return new Set(iterWorktrees(git, projectRoot).map((w) => normPath(w.path)));
  } catch {
    return new Set();
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function emit(json: boolean, payload: object, human: string): void {
  process.stdout.write(json ? JSON.stringify(payload, null, 2) + '\n' : human);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface WorktreeArgs {
  name?: string;
  base: string;
  /** True when `--base` was given: `finalize` replays the slot's recorded base
   *  branch unless the caller overrode it, and 'main' is also the default. */
  baseGiven: boolean;
  submodules: string[];
  submodulesGiven: boolean;
  hookDir?: string;
  ports: number | null;
  outcome: 'completed' | 'halted';
  json: boolean;
}

const ALLOWED: Record<string, ReadonlyArray<string>> = {
  create: ['--name', '--base', '--submodules', '--hook-dir', '--ports', '--json'],
  finalize: ['--name', '--base', '--submodules', '--hook-dir', '--json'],
  destroy: ['--name', '--hook-dir', '--outcome', '--json'],
  list: ['--json'],
};

function parseArgs(verb: string, args: string[]): WorktreeArgs | { error: string } {
  const out: WorktreeArgs = {
    base: 'main',
    baseGiven: false,
    submodules: [],
    submodulesGiven: false,
    ports: null,
    outcome: 'completed',
    json: false,
  };
  const allowed = ALLOWED[verb] ?? [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const eqAt = a.indexOf('=');
    const flag = a.startsWith('--') && eqAt > 0 ? a.slice(0, eqAt) : a;
    const inlineValue = a.startsWith('--') && eqAt > 0 ? a.slice(eqAt + 1) : undefined;
    if (!allowed.includes(flag)) return { error: `unknown argument '${a}'` };
    const value = (): string | { error: string } => {
      if (inlineValue !== undefined) return inlineValue;
      const v = args[++i];
      return v === undefined ? { error: `${flag} requires a value` } : v;
    };
    if (flag === '--json') {
      if (inlineValue !== undefined) return { error: `--json takes no value` };
      out.json = true;
      continue;
    }
    const v = value();
    if (typeof v === 'object') return v;
    if (flag === '--name') out.name = v;
    else if (flag === '--base') {
      out.base = v;
      out.baseGiven = true;
    } else if (flag === '--submodules') {
      out.submodules = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      out.submodulesGiven = true;
    }
    else if (flag === '--hook-dir') out.hookDir = v;
    else if (flag === '--ports') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return { error: `--ports must be a non-negative integer (got '${v}')` };
      out.ports = n;
    } else if (flag === '--outcome') {
      if (v !== 'completed' && v !== 'halted') return { error: `--outcome must be 'completed' or 'halted' (got '${v}')` };
      out.outcome = v;
    }
  }
  return out;
}

/** Resolve `--name` (defaulting to a fresh UUIDv7, the same identifier
 *  `pipeline id` mints) and VALIDATE it. Returns the error message on refusal —
 *  the caller must stop before touching a path, a branch, or a hook. */
function resolveName(given: string | undefined): string | { error: string } {
  const name = given ?? newId();
  const bad = validateSlotName(name);
  if (bad) return { error: `invalid --name '${name}': ${bad}` };
  return name;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateOutput {
  command: 'worktree create';
  ok: boolean;
  /** `created` · `reused` · `failed` — the orchestrator treats `reused` as a
   *  duplicate-dispatch error (02-target-architecture.md §1.6). */
  status: 'created' | 'reused' | 'failed';
  reused: boolean;
  /** What proved the reuse: this command's own slot record, or a git worktree
   *  registration that predated the hook call. null when not reused. */
  reused_evidence: 'registry' | 'git-worktree' | null;
  name: string;
  worktree_path: string | null;
  branch: string | null;
  env_file: string | null;
  base_branch: string;
  submodules: string[];
  hook_dir: string;
  /** Always null today: `--ports` is recorded, not allocated (taskflow-v2 a4). */
  ports: null;
  ports_requested: number | null;
  detail: string | null;
}

function createSlot(args: WorktreeArgs, git: GitRunner): { output: CreateOutput; code: number } {
  const projectRoot = projectRootOf();
  const name = args.name!;
  const hookDir = args.hookDir ?? DEFAULT_HOOK_DIR;
  const paths = hookPathsFor(projectRoot, hookDir);

  // Reuse evidence must be gathered BEFORE the hook runs — afterwards the slot
  // exists either way and the two cases are indistinguishable.
  const known = readSlot(projectRoot, name);
  const preRegistered = registeredWorktreePaths(git, projectRoot);

  const res = runCreateHook(
    { run_id: name, name, base_branch: args.base, submodules: args.submodules, hook_dir: hookDir },
    paths,
    noopEmitter,
  );

  const base: Omit<CreateOutput, 'ok' | 'status' | 'reused' | 'reused_evidence' | 'worktree_path' | 'branch' | 'env_file' | 'detail'> = {
    command: 'worktree create',
    name,
    base_branch: args.base,
    submodules: args.submodules,
    hook_dir: hookDir,
    ports: null,
    ports_requested: args.ports,
  };

  if (!res.ok || res.provisioned === null) {
    // Same best-effort cleanup the run path performs: a create that failed
    // halfway may have left a partial slot. Never changes this outcome.
    runCreateFailedCleanup({ run_id: name, name }, paths, res.failedWorktreePath, noopEmitter);
    return {
      output: {
        ...base,
        ok: false,
        status: 'failed',
        reused: false,
        reused_evidence: null,
        worktree_path: null,
        branch: null,
        env_file: null,
        detail: res.detail,
      },
      code: 1,
    };
  }

  const { worktree_path, branch, env_file } = res.provisioned;
  const sameSlotOnDisk =
    known !== null && normPath(known.worktree_path) === normPath(worktree_path) && existsSync(worktree_path);
  const evidence: CreateOutput['reused_evidence'] = sameSlotOnDisk
    ? 'registry'
    : preRegistered.has(normPath(worktree_path))
      ? 'git-worktree'
      : null;

  const at = nowIso();
  writeSlot(projectRoot, {
    name,
    worktree_path,
    branch,
    env_file,
    base_branch: args.base,
    submodules: args.submodules,
    hook_dir: hookDir,
    ports_requested: args.ports,
    created_at: known?.created_at || at,
    updated_at: at,
    outcome: null,
    finalized: false,
  });

  return {
    output: {
      ...base,
      ok: true,
      status: evidence === null ? 'created' : 'reused',
      reused: evidence !== null,
      reused_evidence: evidence,
      worktree_path,
      branch,
      env_file,
      detail: null,
    },
    code: 0,
  };
}

function humanCreate(o: CreateOutput): string {
  if (!o.ok) return `worktree create ${o.name}: FAILED — ${o.detail ?? 'unknown reason'}\n`;
  const lines = [
    `worktree ${o.status} ${o.name}`,
    `  path:     ${o.worktree_path}`,
    `  branch:   ${o.branch ?? '(none reported)'}`,
    `  env_file: ${o.env_file ?? '(none reported)'}`,
  ];
  if (o.reused) lines.push(`  reused:   yes (${o.reused_evidence}) — an orchestrator should treat this as a duplicate dispatch`);
  if (o.ports_requested !== null)
    lines.push(`  ports:    requested ${o.ports_requested}, NOT allocated — allocation ships with the built-in provisioner`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

export interface FinalizeOutput {
  command: 'worktree finalize';
  ok: boolean;
  name: string;
  worktree_path: string | null;
  outcome: 'completed';
  detail: string | null;
}

function finalizeSlot(args: WorktreeArgs): { output: FinalizeOutput; code: number } {
  const projectRoot = projectRootOf();
  const name = args.name!;
  const slot = readSlot(projectRoot, name);
  const hookDir = args.hookDir ?? slot?.hook_dir ?? DEFAULT_HOOK_DIR;
  const res = runFinalizeHook(
    {
      run_id: name,
      name,
      base_branch: args.baseGiven ? args.base : (slot?.base_branch ?? args.base),
      submodules: args.submodulesGiven ? args.submodules : (slot?.submodules ?? []),
      worktree_path: slot?.worktree_path ?? null,
      outcome: 'completed',
    },
    hookPathsFor(projectRoot, hookDir),
    noopEmitter,
  );
  if (slot && res.ok) {
    slot.finalized = true;
    slot.updated_at = nowIso();
    writeSlot(projectRoot, slot);
  }
  return {
    output: {
      command: 'worktree finalize',
      ok: res.ok,
      name,
      worktree_path: slot?.worktree_path ?? null,
      outcome: 'completed',
      detail: res.detail,
    },
    code: res.ok ? 0 : 1,
  };
}

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

export interface DestroyOutput {
  command: 'worktree destroy';
  ok: boolean;
  name: string;
  worktree_path: string | null;
  outcome: 'completed' | 'halted';
  /** `PIPELINE_WT_DELETE_BRANCHES` — outcome-aware, exactly as on the run path. */
  delete_branches: boolean;
  /** The slot record was dropped: a completed teardown the hook confirmed. */
  reaped: boolean;
  /** The slot record is still tracked — `halted`, or a teardown that failed. */
  preserved: boolean;
  detail: string | null;
}

function destroySlot(args: WorktreeArgs): { output: DestroyOutput; code: number } {
  const projectRoot = projectRootOf();
  const name = args.name!;
  const slot = readSlot(projectRoot, name);
  const hookDir = args.hookDir ?? slot?.hook_dir ?? DEFAULT_HOOK_DIR;
  // Outcome-aware, mirroring the engine: a COMPLETED slot's branch dies with
  // it; a HALTED one is preserved for post-mortem and resume.
  const deleteBranches = args.outcome === 'completed';
  const res = runDestroyHook(
    {
      run_id: name,
      name,
      worktree_path: slot?.worktree_path ?? null,
      outcome: args.outcome,
      delete_branches: deleteBranches,
    },
    hookPathsFor(projectRoot, hookDir),
    noopEmitter,
  );

  const reaped = res.ok && args.outcome === 'completed';
  if (reaped) {
    deleteSlot(projectRoot, name);
  } else if (slot) {
    slot.outcome = args.outcome;
    slot.updated_at = nowIso();
    writeSlot(projectRoot, slot);
  }

  return {
    output: {
      command: 'worktree destroy',
      ok: res.ok,
      name,
      worktree_path: slot?.worktree_path ?? null,
      outcome: args.outcome,
      delete_branches: deleteBranches,
      reaped,
      preserved: !reaped,
      detail: res.detail,
    },
    code: res.ok ? 0 : 1,
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListedSlot extends SlotRecord {
  /** Whether the recorded worktree path is still on disk. A false here is a
   *  stale record, not a leak — `pipeline gc` owns leak detection and reaping. */
  exists: boolean;
}

export interface ListOutput {
  command: 'worktree list';
  project_root: string;
  slots: ListedSlot[];
}

function listOutput(): ListOutput {
  const projectRoot = projectRootOf();
  return {
    command: 'worktree list',
    project_root: projectRoot,
    slots: listSlots(projectRoot).map((s) => ({ ...s, exists: existsSync(s.worktree_path) })),
  };
}

function humanList(o: ListOutput): string {
  if (!o.slots.length) return `no provisioned worktree slots under ${o.project_root}\n`;
  const lines = [`provisioned worktree slots (${o.slots.length}) — ${o.project_root}`];
  for (const s of o.slots) {
    const state = !s.exists ? 'missing' : s.outcome === 'halted' ? 'preserved' : s.finalized ? 'finalized' : 'live';
    lines.push(`  ${state.padEnd(9)} ${s.name}  ${s.worktree_path}  [${s.branch ?? 'no branch reported'}]`);
  }
  lines.push('(leaked worktrees and branches this command never provisioned: `pipeline gc`)');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CLI shell
// ---------------------------------------------------------------------------

const USAGE = [
  'pipeline worktree — the worktree-hook lifecycle WITHOUT a pipeline run',
  '',
  'Usage:',
  '  pipeline worktree create   [--name <slot>] [--base <branch>] [--submodules a,b]',
  '                             [--hook-dir <path>] [--ports <n>] [--json]',
  '  pipeline worktree finalize --name <slot> [--base <branch>] [--submodules a,b]',
  '                             [--hook-dir <path>] [--json]',
  '  pipeline worktree destroy  --name <slot> [--outcome completed|halted]',
  '                             [--hook-dir <path>] [--json]',
  '  pipeline worktree list     [--json]',
  '',
  'Runs the consumer hooks in <project>/.pipeline/.hooks (override: --hook-dir)',
  'through the SAME code path a pipeline run uses, with the FROZEN PIPELINE_WT_*',
  'contract. Run it from the project root: PIPELINE_WT_PROJECT_ROOT is the',
  'current directory, exactly as on the run path.',
  '',
  'Standalone context — stated because the contract is frozen:',
  '  PIPELINE_WT_PIPELINE_ROOT and PIPELINE_WT_PIPELINE_NAME are the EMPTY',
  '  STRING (there is no pipeline). PIPELINE_WT_NAME is the slot name and',
  '  PIPELINE_WT_RUN_ID carries it too (there is no run id; on the run path the',
  '  two have always been equal). NO run-scoped journal event is written.',
  '',
  '  create    Provision a slot. --name defaults to a fresh UUIDv7 (the',
  '            identifier `pipeline id` mints) and must match',
  "            [A-Za-z0-9][A-Za-z0-9._-]* (max 64). Creation is IDEMPOTENT per",
  '            name by frozen contract: a second create REUSES the slot and',
  '            reports status "reused" (--json: reused + reused_evidence) —',
  '            an orchestrator treats that as a duplicate dispatch.',
  '            --ports <n> is RECORDED, NOT ALLOCATED yet.',
  '  finalize  Run the mandatory terminal hook for the slot (strict',
  '            must-succeed: only an explicit {"ok":true} passes).',
  '  destroy   Tear the slot down. --outcome completed (default) REAPS —',
  '            PIPELINE_WT_DELETE_BRANCHES=1 and the slot record is dropped;',
  '            --outcome halted PRESERVES — DELETE_BRANCHES=0 and the record',
  '            is kept for post-mortem.',
  '  list      The slots this command provisioned, and whether each is still on',
  '            disk. Leak detection and reaping belong to `pipeline gc`.',
  '',
  'Exit: 0 success · 1 the hook failed (soft-fail {"ok":false} or hard-fail;',
  '      `detail` says which) · 2 usage / invalid --name / invalid --outcome.',
  '',
].join('\n');

/** Group dispatcher: `pipeline worktree <verb> [args]`. */
export function runWorktree(args: string[], git: GitRunner = realGit): number {
  const verb = args[0];
  const rest = args.slice(1);

  if (verb === '--help' || verb === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (verb === undefined) {
    // Same shape as the other command groups: a missing verb is a usage error
    // on stderr, never a successful help print on stdout.
    process.stderr.write(`pipeline worktree: a verb is required (create, finalize, destroy, list)\n\n${USAGE}`);
    return 2;
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, verb)) {
    process.stderr.write(
      `pipeline worktree: unknown verb '${verb}' (expected: create, finalize, destroy, list)\n\n${USAGE}`,
    );
    return 2;
  }

  const parsed = parseArgs(verb, rest);
  if ('error' in parsed) {
    process.stderr.write(`pipeline worktree ${verb}: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  if (verb === 'list') {
    const o = listOutput();
    emit(parsed.json, o, humanList(o));
    return 0;
  }

  // SG6: the name is validated here — before any filesystem path, branch name,
  // registry file, or hook environment is derived from it.
  if (verb !== 'create' && parsed.name === undefined) {
    process.stderr.write(`pipeline worktree ${verb}: --name <slot> is required\n\n${USAGE}`);
    return 2;
  }
  const name = resolveName(parsed.name);
  if (typeof name === 'object') {
    process.stderr.write(`pipeline worktree ${verb}: ${name.error}\n`);
    return 2;
  }
  parsed.name = name;

  if (verb === 'create') {
    const { output, code } = createSlot(parsed, git);
    emit(parsed.json, output, humanCreate(output));
    return code;
  }
  if (verb === 'finalize') {
    const { output, code } = finalizeSlot(parsed);
    emit(
      parsed.json,
      output,
      output.ok
        ? `worktree finalized ${output.name}${output.detail ? ` — ${output.detail}` : ''}\n`
        : `worktree finalize ${output.name}: FAILED — ${output.detail ?? 'unknown reason'}\n`,
    );
    return code;
  }
  const { output, code } = destroySlot(parsed);
  emit(
    parsed.json,
    output,
    output.ok
      ? `worktree ${output.reaped ? 'destroyed (reaped)' : 'destroyed (preserved)'} ${output.name}` +
          `${output.detail ? ` — ${output.detail}` : ''}\n`
      : `worktree destroy ${output.name}: FAILED — ${output.detail ?? 'unknown reason'}\n`,
  );
  return code;
}
