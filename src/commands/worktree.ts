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
// THE BUILT-IN PROVISIONER (taskflow-v2 a3; 02-target-architecture.md §4.2).
// `create` resolves `worktree-create.*` in the hook dir FIRST. When the
// repository has authored one, nothing below changes: the hook runs and wins.
// When there is none, this command provisions the slot itself through
// lib/worktree-provision.ts — a git worktree outside the repository, one
// worktree per declared submodule cut from that submodule's own integration
// branch, and the env file.
//
// ⚠ THAT FALLBACK IS REACHABLE FROM HERE AND NOWHERE ELSE (D9). On the pipeline
// RUN path a missing `worktree-create.*` still HALTS, exactly as it always has
// — lib/worktree-hooks.ts neither imports nor knows about the provisioner, so
// no existing consumer observes a change. The resolution call below uses
// lib/hooks.ts's own `resolveHookScript`, the same function
// lib/worktree-hooks.ts uses, so "is there a hook?" cannot answer differently
// in the two places.
//
// PORTS (taskflow-v2 a4; 02-target-architecture.md §4.2 item 3). Every slot
// gets a contiguous block of free ports, because a worktree isolates files and
// not TCP ports — two workers each starting a dev server on 3000 is the failure
// that makes file-level isolation insufficient on its own. lib/port-alloc.ts
// owns the allocator; this command owns the PRECEDENCE (D14, per field: a hook
// returning `ports: {}` still gets the CLI's block, and only a hook returning
// non-empty ports overrides) and the reporting (`--json` reads the env file
// back, because the env file — not the hook's JSON — is the channel the frozen
// contract leaves ports in).
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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnvFile } from '../lib/env-file';
import { ensureGeneratedDir } from '../lib/generated-dir';
import { iterWorktrees, realGit, type GitRunner } from '../lib/git';
import { resolveHookScript } from '../lib/hooks';
import { newId } from '../lib/ids';
import {
  allocatePorts,
  DEFAULT_PORT_COUNT,
  PORT_BASE_KEY,
  portEnvEntries,
  readPortsFromEnv,
  releaseReservations,
  reservationDirFor,
  resolvePortRange,
} from '../lib/port-alloc';
import { provisionSlot, slotRootBase, unsafeEnvEntry, type ProvisionedSubmodule } from '../lib/worktree-provision';
import {
  noopEmitter,
  runCreateFailedCleanup,
  runCreateHook,
  runDestroyHook,
  runFinalizeHook,
  type HookPorts,
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
  /** The EFFECTIVE block size for this slot: `--ports N`, or the default when
   *  the flag was omitted. `0` means the slot was provisioned with no ports.
   *  Older records predate allocation and read back as null. */
  ports_requested: number | null;
  /** First port of the slot's block, null when it has none. The authoritative
   *  copy lives in the env file (that is the channel steps read); this is here
   *  so `list` can answer "which ports is that slot holding" without opening a
   *  file that a consumer hook, not this CLI, may own. */
  port_base: number | null;
  /** Which side provisioned this slot: the consumer's `worktree-create.*`
   *  (`hook`) or the CLI's built-in provisioner (`builtin`). Recorded because
   *  teardown differs — a hook-made slot is the hook's to reap. Older records
   *  predate the field and read back as `hook`, which is what they were. */
  provisioner: 'hook' | 'builtin';
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
      port_base: typeof raw.port_base === 'number' ? raw.port_base : null,
      provisioner: raw.provisioner === 'builtin' ? 'builtin' : 'hook',
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
  /** The slot's ports, READ BACK from its env file — the channel, not the
   *  intention (taskflow-v2 a4). Keyed by env-file key: `PORT_1`… for the
   *  built-in allocator, plus any `<ROLE>_PORT` a consumer hook wrote. `{}`
   *  when the slot has none. */
  ports: Record<string, number>;
  /** First port of the block, or null. */
  port_base: number | null;
  /** Who the ports came from. `builtin` — this CLI allocated them (including
   *  the D14 case where a hook returned none and the CLI filled the gap);
   *  `hook` — the create hook's own, which override; `none` — the slot has no
   *  ports. */
  ports_source: 'builtin' | 'hook' | 'none';
  /** The EFFECTIVE block size asked for: `--ports N`, or the default. */
  ports_requested: number | null;
  /** `hook` when a `worktree-create.*` provisioned the slot, `builtin` when the
   *  CLI's own provisioner did (no hook exists). Additive: a repository with a
   *  hook reports `hook` and behaves exactly as it did before a3. */
  provisioner: 'hook' | 'builtin';
  /** One entry per `--submodules` path the BUILT-IN provisioner cut a worktree
   *  for, with the integration branch it was cut from. Always `[]` on the hook
   *  path — the frozen contract does not report submodule slots, and this
   *  command must not invent them. On a FAILED create it lists the submodule
   *  slots that were cut before the failure (the provisioner deletes nothing),
   *  so an operator can see what is on disk. */
  submodule_slots: ProvisionedSubmodule[];
  detail: string | null;
}

/** D14, per field — the whole reason this function exists.
 *
 *  A hook that returns `ports: {}` / `port_base: 0` (which is what this
 *  repository's own reference hook returns, and what any hook that never
 *  implemented ports returns) must NOT suppress the CLI's allocation:
 *  hook-wins-wholesale would make ports unreachable in every repository that
 *  already has a create hook. So an EMPTY answer is filled in, and only a
 *  NON-EMPTY one overrides.
 *
 *  The fill goes into the hook's OWN env file, because that is the channel —
 *  the create-hook JSON's ports are informational and nothing threads them
 *  onward. Two things are deliberately never done here: a value already in
 *  that file is never overwritten (a hook that wrote ports without reporting
 *  them still wins on the channel that matters), and no second env file is
 *  invented when the hook reported none — a file no step sources would be a
 *  worse answer than an honest "no ports". */
function fillHookSlotPorts(ctx: {
  name: string;
  count: number;
  envFile: string | null;
  hookPorts: HookPorts | null;
  worktreePath: string;
}): { source: CreateOutput['ports_source']; note: string | null } | { error: string } {
  const hp = ctx.hookPorts;
  if (hp !== null && (Object.keys(hp.ports).length > 0 || hp.port_base !== null)) {
    // The hook allocated ports and said so. Its answer stands, both fields of
    // it: `ports` and `port_base` describe ONE allocation, and filling half of
    // a pair would publish a block that contradicts its own base.
    return { source: 'hook', note: null };
  }
  if (ctx.count <= 0) return { source: 'none', note: null };
  if (ctx.envFile === null) {
    return {
      source: 'none',
      note: `the worktree-create hook returned no env_file, so there is nowhere to publish ports — ${ctx.count} were not allocated`,
    };
  }
  let text = '';
  try {
    text = readFileSync(ctx.envFile, 'utf8');
  } catch {
    text = ''; // the hook named a file it did not write; the fill creates it
  }
  const already = readPortsFromEnv(parseEnvFile(text));
  if (already.port_base !== null || Object.keys(already.ports).length > 0) return { source: 'hook', note: null };

  const range = resolvePortRange();
  if ('error' in range) return { error: range.error };
  const alloc = allocatePorts({
    name: ctx.name,
    count: ctx.count,
    reservationDir: reservationDirFor(slotRootBase()),
    livePath: ctx.worktreePath,
    range,
  });
  if (!alloc.ok) return { error: alloc.detail };

  const entries = portEnvEntries(alloc.base, alloc.ports.length);
  for (const [k, v] of entries) {
    const problem = unsafeEnvEntry(k, v);
    if (problem) return { error: problem };
  }
  const body =
    (text.length && !text.endsWith('\n') ? `${text}\n` : text) +
    '# ports allocated by `pipeline worktree create` — the hook returned none (D14)\n' +
    entries.map(([k, v]) => `${k}=${v}`).join('\n') +
    '\n';
  try {
    // The hook DECLARED this path; a hook that names an env file it has not
    // written yet is common enough (and was harmless before ports existed)
    // that the directory is created rather than treated as an error.
    mkdirSync(dirname(ctx.envFile), { recursive: true });
    writeFileSync(ctx.envFile, body, 'utf8');
  } catch (e) {
    // NOT a failed create. Exhaustion is this CLI's problem to report; a file
    // this CLI does not own being unwritable is the hook's, and turning it into
    // a failure would break slots that provisioned fine before ports existed.
    // The block is handed back so it does not stay reserved for nothing.
    releaseReservations(reservationDirFor(slotRootBase()), ctx.name);
    return {
      source: 'none',
      note: `could not publish ports into the hook's env file ${ctx.envFile} (${String((e as Error).message ?? e)}) — the slot has none`,
    };
  }
  return { source: 'builtin', note: null };
}

/** The slot's ports as its env file publishes them — the read-BACK direction
 *  DoD 8 asks for. Best-effort: an unreadable file reports no ports rather
 *  than failing a create that already succeeded. */
function readPortsBack(envFile: string | null): { port_base: number | null; ports: Record<string, number> } {
  if (envFile === null) return { port_base: null, ports: {} };
  try {
    return readPortsFromEnv(parseEnvFile(readFileSync(envFile, 'utf8')));
  } catch {
    return { port_base: null, ports: {} };
  }
}

function createSlot(args: WorktreeArgs, git: GitRunner): { output: CreateOutput; code: number } {
  const projectRoot = projectRootOf();
  const name = args.name!;
  const hookDir = args.hookDir ?? DEFAULT_HOOK_DIR;
  const paths = hookPathsFor(projectRoot, hookDir);
  /** `--ports N`, or the default when the flag was omitted. Explicit `0` is a
   *  slot with no ports; nothing else opts out. */
  const portCount = args.ports ?? DEFAULT_PORT_COUNT;

  // D9's decision point, and the ONLY one: a hook that exists is run and wins;
  // its absence is what the built-in provisioner fills, HERE, in the standalone
  // command — never on the run path.
  const hasHook = resolveHookScript(paths.hookDirAbs, 'worktree-create') !== null;

  // Reuse evidence must be gathered BEFORE anything provisions — afterwards the
  // slot exists either way and the two cases are indistinguishable.
  const known = readSlot(projectRoot, name);
  const preRegistered = registeredWorktreePaths(git, projectRoot);

  const res = hasHook
    ? runCreateHook(
        { run_id: name, name, base_branch: args.base, submodules: args.submodules, hook_dir: hookDir },
        paths,
        noopEmitter,
      )
    : provisionSlot({ name, base_branch: args.base, submodules: args.submodules, projectRoot, ports: portCount }, git);
  const submoduleSlots = hasHook ? [] : (res as { submodule_slots: ProvisionedSubmodule[] }).submodule_slots;

  const base: Omit<
    CreateOutput,
    | 'ok'
    | 'status'
    | 'reused'
    | 'reused_evidence'
    | 'worktree_path'
    | 'branch'
    | 'env_file'
    | 'detail'
    | 'ports'
    | 'port_base'
    | 'ports_source'
  > = {
    command: 'worktree create',
    name,
    base_branch: args.base,
    submodules: args.submodules,
    hook_dir: hookDir,
    ports_requested: portCount,
    provisioner: hasHook ? 'hook' : 'builtin',
    submodule_slots: submoduleSlots,
  };
  /** A create that produced no usable slot: no path, no branch, no ports. */
  const failure = (detail: string | null): { output: CreateOutput; code: number } => ({
    output: {
      ...base,
      ok: false,
      status: 'failed',
      reused: false,
      reused_evidence: null,
      worktree_path: null,
      branch: null,
      env_file: null,
      ports: {},
      port_base: null,
      ports_source: 'none',
      detail,
    },
    code: 1,
  });

  if (!res.ok || res.provisioned === null) {
    // Same best-effort cleanup the run path performs: a create that failed
    // halfway may have left a partial slot. Never changes this outcome.
    //
    // HOOK PATH ONLY. When the built-in provisioner failed there is no consumer
    // create hook, so there is no consumer teardown to invoke for a slot the
    // consumer never made — and the provisioner deliberately deletes nothing on
    // failure (a refused slot may be a redirect into the main checkout).
    if (hasHook) {
      runCreateFailedCleanup(
        { run_id: name, name },
        paths,
        (res as { failedWorktreePath: string | null }).failedWorktreePath,
        noopEmitter,
      );
    }
    return failure(res.detail);
  }

  const { worktree_path, branch, env_file } = res.provisioned;

  // ---- ports --------------------------------------------------------------
  // The built-in provisioner allocated them itself (they are already in the
  // env file it wrote). On the HOOK path the decision is D14's, per field.
  let portsSource: CreateOutput['ports_source'] = 'none';
  let portsNote: string | null = null;
  if (hasHook) {
    const filled = fillHookSlotPorts({
      name,
      count: portCount,
      envFile: env_file,
      hookPorts: (res as { hook_ports: HookPorts | null }).hook_ports,
      worktreePath: worktree_path,
    });
    // A slot that cannot be given the ports it was asked for is a FAILED
    // create, not a silent zero-port slot. Nothing is torn down: the hook's
    // slot is real and is evidence, and `pipeline gc` reaps what is left.
    if ('error' in filled) return failure(filled.error);
    portsSource = filled.source;
    portsNote = filled.note;
  } else if ((res as { ports: { base: number } | null }).ports !== null) {
    portsSource = 'builtin';
  }

  const readBack = readPortsBack(env_file);
  const hookPorts = hasHook ? (res as { hook_ports: HookPorts | null }).hook_ports : null;
  // The file is the channel, so it is what gets reported — with the hook's own
  // answer overlaid when the hook is the one that owns the ports.
  const ports =
    portsSource === 'hook' && hookPorts !== null ? { ...readBack.ports, ...hookPorts.ports } : readBack.ports;
  const portBase =
    portsSource === 'hook' && hookPorts !== null && hookPorts.port_base !== null
      ? hookPorts.port_base
      : readBack.port_base;

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
    ports_requested: portCount,
    port_base: portBase,
    provisioner: hasHook ? 'hook' : 'builtin',
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
      ports,
      port_base: portBase,
      ports_source: portsSource,
      detail: portsNote,
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
    `  by:       ${o.provisioner === 'hook' ? `${o.hook_dir}/worktree-create.*` : 'the built-in provisioner (no worktree-create.* found)'}`,
  ];
  for (const s of o.submodule_slots) lines.push(`  submodule ${s.name}: ${s.dir}  [base ${s.base}]`);
  if (o.reused) lines.push(`  reused:   yes (${o.reused_evidence}) — an orchestrator should treat this as a duplicate dispatch`);
  const portNames = Object.keys(o.ports).sort((a, b) => (o.ports[a] ?? 0) - (o.ports[b] ?? 0));
  if (portNames.length) {
    const by = o.ports_source === 'hook' ? `${o.hook_dir}/worktree-create.*` : 'the built-in allocator';
    lines.push(
      `  ports:    ${portNames.length} from ${o.port_base ?? portNames[0]} — ${portNames.map((k) => `${k}=${o.ports[k]}`).join(' ')}  [by ${by}]`,
    );
  } else {
    lines.push(`  ports:    none${o.ports_requested === 0 ? ' (--ports 0)' : ''}`);
  }
  if (o.detail) lines.push(`  note:     ${o.detail}`);
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
  'NO worktree-create.* HOOK? `create` provisions the slot itself:',
  '  * `git worktree add -b worktree-<name>` from --base, OUTSIDE the repository',
  '    (a worker\'s build artifacts never land in the project folder);',
  '  * one worktree per --submodules entry, cut from THAT submodule\'s own',
  '    integration branch (`next` where it exists, else --base) — not from the',
  '    commit the parent pins;',
  '  * a contiguous block of FREE ports, one block per slot (a worktree isolates',
  '    files, not TCP ports);',
  '  * an env file beside the slot: RUN_ID, WORKTREE_NAME/PATH/BRANCH,',
  '    PROJECT_ROOT, BASE_BRANCH, PORT_BASE/PORT_COUNT/PORT_1..N, SUBMODULE_* —',
  '    dotenv, values UNQUOTED and free of spaces and shell metacharacters (it is',
  '    also read with `set -a && source`), so paths are written with forward',
  '    slashes on every platform.',
  '  A hook, where one exists, ALWAYS wins — the provisioner is inert then. It is',
  '  reachable from this command only: a pipeline RUN with no worktree-create.*',
  '  still halts, exactly as before. `create` ONLY: finalize and destroy still',
  '  require their own hooks; `pipeline gc` reaps what the provisioner made.',
  '  Environment: PIPELINE_WT_ROOT (where slots live; default C:/tmp on Windows,',
  '  else the system temp dir) · PIPELINE_WT_INTEGRATION_BRANCH (default `next`)',
  '  · PIPELINE_WT_FETCH=1 (fetch origin first; off by default so create never',
  '  blocks on a remote) · PIPELINE_WT_PORT_RANGE=min-max (default 20000-32767).',
  '  Requires git 2.20+.',
  '',
  'PORTS. Every slot gets its own contiguous block of FREE ports — --ports N,',
  '  default 4, `--ports 0` for none — published in the env file as PORT_BASE,',
  '  PORT_COUNT and PORT_1..PORT_N. The base is DETERMINISTIC per slot name, so',
  '  re-provisioning the same name returns the same ports while they are free;',
  '  occupied ports are skipped, and a block is reserved as it is handed out so',
  '  two concurrent creates cannot be given overlapping ones. A worker is TOLD',
  '  its ports and never searches for them. Exhaustion is a stated failure',
  '  naming the range tried, never a slot with silently no ports.',
  '  A repository WITH a create hook gets them too, per field (D14): a hook that',
  '  returns `ports: {}` / `port_base: 0` — i.e. any hook that never implemented',
  '  ports — has the block appended to the env file it reported; only a hook that',
  '  returns NON-EMPTY ports overrides. --json reports what the env file says.',
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
  '            --ports <n> allocates a contiguous block of n free ports',
  '            (default 4; 0 for none) — see PORTS above.',
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
