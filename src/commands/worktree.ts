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
// THE BUILT-IN TEARDOWN (taskflow-v2 a5; 03-execution-flows.md F7 step 4).
// What this command can provision, it can also reap: with no
// `worktree-destroy.*` in the hook dir, `destroy --outcome completed` calls
// lib/worktree-provision.ts's `teardownSlot` — the parent worktree, every
// submodule worktree, the branch, the env file — and this command releases the
// slot's port reservations, exactly as it does after a hook teardown.
// `--outcome halted` preserves the slot WHOLE, ports included. `finalize` has a
// built-in too, and it is a NO-OP that reports ok (see `finalizeSlot`).
//
// TWO CONDITIONS GATE THE BUILT-IN TEARDOWN, and the second is the symmetry
// rule that decides every edge case:
//
//   1. the hook is ABSENT — a `worktree-destroy.*` that exists always wins,
//      including over a slot the built-in provisioner made (the JSON says so in
//      `detail`, so the choice is never silent); and
//   2. the slot record says `provisioner: 'builtin'` — the built-in teardown
//      reaps only what the built-in provisioner made. A hook provisioned its
//      slot with bookkeeping this CLI never saw, so tearing one down from here
//      would orphan it; that case is REFUSED with a stated reason instead.
//      Unknown provenance (no record, or a record that predates the field)
//      reads as `hook` — the conservative half of the rule, and the behavior
//      this command already had.
//
// D9 again: none of the above is reachable from a pipeline RUN either. A run
// whose repository has no `worktree-destroy.*` still reports a FAILED teardown
// (lib/worktree-hooks.ts), and tests/worktree-hook-module.test.ts asserts both
// the runtime behavior and the absence of the import.
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
// SUBMODULE SLOTS ARE REPORTED, NOT ONLY RECORDED (taskflow-v2 a11 — P-1, and
// the defect that destroyed finished work). A worker dispatched into a slot
// does its work in the SUBMODULE worktree; the parent slot is genuinely empty.
// `create`/`list` used to report `submodule_slots: []` for every HOOK-
// provisioned slot, so an orchestrator reconciling a resumed run could only see
// the parent — read it as an empty shell, and reap a slot that held finished
// commits. The only machine-readable pointer to the real directory was
// `SUBMODULE_*_DIR` inside the slot's env file, and nothing on the resume path
// read it.
//
// `reportedSubmoduleSlots` closes that, for both verbs and both provisioners,
// through THREE channels in descending order of authority:
//
//   1. the slot record's own `submodule_slots` — what the BUILT-IN provisioner
//      said it cut, at the moment it cut it (`source: 'record'`);
//   2. the slot's ENV FILE — `SUBMODULE_<n>_{PATH,NAME,DIR,BASE}`, which is
//      where the frozen contract leaves a hook's answer and what this
//      repository's own reference `worktree-create.py` writes
//      (`source: 'env-file'`);
//   3. the CONVENTION `teardownSubmodulesOf` already reaps by —
//      `derivedSubmoduleSlotDir` off the parent slot's own path
//      (`source: 'derived'`).
//
// Every entry also carries `exists`, because the question being answered is
// "is this slot really empty?" and a directory that is not there is a different
// answer from one that is. Reporting is ALL this adds: what `create` RECORDS is
// unchanged (`[]` on the hook path — the frozen contract does not report
// submodule slots and this command still does not invent them into the record
// teardown reads), the `SUBMODULE_*_DIR` env keys stay exactly where they are,
// and teardown is untouched.
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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
import {
  derivedSubmoduleSlotDir,
  provisionSlot,
  slotRootBase,
  teardownSlot,
  unsafeEnvEntry,
  type ProvisionedSubmodule,
  type TeardownSubmodule,
} from '../lib/worktree-provision';
import {
  noopEmitter,
  runCreateFailedCleanup,
  runCreateHook,
  runDestroyHook,
  runFinalizeHook,
  type FinalizeInfo,
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
  /** The submodule slots the BUILT-IN provisioner actually cut, as it reported
   *  them. Always `[]` on the hook path — the frozen contract does not report
   *  submodule slots and this command must not invent them.
   *
   *  Recorded rather than recomputed because it is what teardown reaps: a slot
   *  must be torn down where it was MADE, and `PIPELINE_WT_ROOT` can move
   *  between create and destroy. Records that predate the field read back as
   *  `[]` and teardown falls back to the same derivation the provisioner used
   *  (`derivedSubmoduleSlotDir`). */
  submodule_slots: ProvisionedSubmodule[];
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
  /** WHICH PATH finalized this slot (taskflow-v2 a10 — the weakness a5's own
   *  report flagged): the consumer's `worktree-finalize.*` (`hook`), or the
   *  CLI's built-in NO-OP (`builtin`).
   *  Set alongside `finalized` by a SUCCESSFUL `finalize`, from the same
   *  vocabulary `FinalizeOutput.finalized_by` already uses (a5) — this is that
   *  same distinction, persisted rather than left in the one-shot output.
   *
   *  `null` — never silently defaulted to `'hook'` or `'builtin'` — for a slot
   *  that has not been finalized yet, AND for a record written before this
   *  field existed (`finalized` may already be `true` there; provenance is
   *  simply unknown, and `list` says so rather than guessing). That is
   *  deliberately the opposite convention from `provisioner`, which defaults an
   *  older record to `hook`: `provisioner`'s default is safe because it only
   *  gates a REFUSAL (teardown of the conservative case), while a `finalized_by`
   *  default here would let a stale record impersonate a real answer to the
   *  exact question this field exists to answer — whether a built-in no-op
   *  finalize (which pushes nothing) or a hook (which may have) ran. */
  finalized_by: 'hook' | 'builtin' | null;
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

/** The record's `submodule_slots`, defensively: the file is on disk between
 *  processes and a truncated or hand-edited entry must not become a PATH that
 *  teardown then deletes. Only entries with both a declared path and a
 *  directory survive. */
function readSubmoduleSlots(raw: unknown): ProvisionedSubmodule[] {
  if (!Array.isArray(raw)) return [];
  const out: ProvisionedSubmodule[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Partial<ProvisionedSubmodule>;
    if (typeof e.path !== 'string' || !e.path || typeof e.dir !== 'string' || !e.dir) continue;
    out.push({
      path: e.path,
      name: typeof e.name === 'string' ? e.name : e.path,
      dir: e.dir,
      base: typeof e.base === 'string' ? e.base : '',
    });
  }
  return out;
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
      submodule_slots: readSubmoduleSlots(raw.submodule_slots),
      hook_dir: typeof raw.hook_dir === 'string' ? raw.hook_dir : DEFAULT_HOOK_DIR,
      ports_requested: typeof raw.ports_requested === 'number' ? raw.ports_requested : null,
      port_base: typeof raw.port_base === 'number' ? raw.port_base : null,
      provisioner: raw.provisioner === 'builtin' ? 'builtin' : 'hook',
      created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
      outcome: raw.outcome === 'completed' || raw.outcome === 'halted' ? raw.outcome : null,
      finalized: raw.finalized === true,
      // Absent or unrecognized reads as null — NOT defaulted to 'hook' the way
      // `provisioner` is. See the field's doc comment: a wrong guess here would
      // impersonate the exact answer this field exists to give.
      finalized_by: raw.finalized_by === 'builtin' || raw.finalized_by === 'hook' ? raw.finalized_by : null,
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

/** Drop a slot's record, reporting whether it is gone afterwards.
 *
 *  Idempotent: an already-absent record reports `true`. EXPORTED for
 *  `pipeline gc` (a8) — a slot record whose worktree has already vanished is
 *  part of the leak, not a survivor of it, so the janitor that reaps the slot
 *  drops the record through the same function `destroy` uses rather than
 *  re-deriving the registry's path. */
export function deleteSlot(projectRoot: string, name: string): boolean {
  const file = slotFile(projectRoot, name);
  try {
    unlinkSync(file);
  } catch {
    // already gone — nothing to reap
  }
  return !existsSync(file);
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
// Reporting a slot's submodule directories (a11 — P-1)
//
// The parent slot of a dispatched worker is EMPTY BY DESIGN: the worker works
// in the submodule slot. Anything that reconciles a slot it did not create —
// a resumed parallel run, an orchestrator deciding whether to reap — has to be
// able to reach that directory from `create --json` / `list --json`, or it will
// conclude the slot never held anything. See the module header.
// ---------------------------------------------------------------------------

/** A submodule slot AS REPORTED: the provisioner's four fields, plus how this
 *  command came to know the directory and whether it is on disk right now.
 *
 *  Both provisioner paths produce this same shape — that is the point. A
 *  consumer must not have to branch on `provisioner` to find out where a
 *  worker's commits are. */
export interface ReportedSubmoduleSlot extends ProvisionedSubmodule {
  /** Which channel named `dir`:
   *  `record`   — the built-in provisioner reported it at create time and the
   *               slot record kept it. Authoritative.
   *  `env-file` — the slot's env file publishes it (`SUBMODULE_<n>_DIR`). This
   *               is a HOOK's own answer, on the channel the frozen contract
   *               leaves for it. Authoritative.
   *  `derived`  — neither channel named it, so this is the CONVENTION the
   *               built-in provisioner and the reference hook both follow
   *               (`derivedSubmoduleSlotDir`), which is also the one
   *               `teardownSubmodulesOf` reaps by. A well-founded guess, and
   *               labelled as one — check `exists` before trusting it. */
  source: 'record' | 'env-file' | 'derived';
  /** Is `dir` on disk NOW? The reconciliation question ("is this slot empty?")
   *  is not answerable from a path alone, and a stale record is a different
   *  answer from a live slot. */
  exists: boolean;
}

/** A sane ceiling on the `SUBMODULE_<n>_*` block: a slot with more declared
 *  submodules than this is a malformed env file, not a monorepo. */
const MAX_ENV_SUBMODULE_SLOTS = 256;

/** The `SUBMODULE_<n>_{PATH,NAME,DIR,BASE}` block of a slot env file.
 *
 *  This is the channel a HOOK answers on — the frozen create-hook JSON has no
 *  field for submodule slots, and this repository's own reference
 *  `worktree-create.py` publishes exactly these keys (as does the built-in
 *  provisioner). Best-effort in every direction: an absent, unreadable or
 *  half-written file yields no entries rather than failing a command, an index
 *  with no `_DIR` is skipped rather than becoming an empty path, and
 *  `SUBMODULE_COUNT` is treated as a hint, never as the truth about which
 *  indices exist. */
function envFileSubmoduleSlots(envFile: string | null): ProvisionedSubmodule[] {
  if (envFile === null) return [];
  let env: Record<string, string>;
  try {
    env = parseEnvFile(readFileSync(envFile, 'utf8'));
  } catch {
    return [];
  }
  const declared = Number(env.SUBMODULE_COUNT);
  const limit =
    Number.isInteger(declared) && declared > 0 ? Math.min(declared, MAX_ENV_SUBMODULE_SLOTS) : MAX_ENV_SUBMODULE_SLOTS;
  const out: ProvisionedSubmodule[] = [];
  for (let n = 1; n <= limit; n++) {
    const dir = (env[`SUBMODULE_${n}_DIR`] ?? '').trim();
    if (!dir) continue;
    const path = (env[`SUBMODULE_${n}_PATH`] ?? '').trim();
    const name = (env[`SUBMODULE_${n}_NAME`] ?? '').trim() || basename(path) || `submodule-${n}`;
    out.push({ path: path || name, name, dir, base: (env[`SUBMODULE_${n}_BASE`] ?? '').trim() });
  }
  return out;
}

/** What `dir` a slot's declared submodules are at, for REPORTING.
 *
 *  Record first, then the env file, then the convention — see the module
 *  header. Ordered by the DECLARED `--submodules` list so both provisioner
 *  paths report the same order for the same request; anything the env file
 *  names that was not declared is appended rather than dropped (a hook may
 *  provision more than it was asked for, and hiding that is how the parent-slot
 *  mistake happened in the first place).
 *
 *  Never throws and never touches git: `list` must stay a read of the registry. */
export function reportedSubmoduleSlots(slot: {
  name: string;
  worktree_path: string;
  env_file: string | null;
  submodules: string[];
  submodule_slots: ProvisionedSubmodule[];
}): ReportedSubmoduleSlot[] {
  const seal = (s: ProvisionedSubmodule, source: ReportedSubmoduleSlot['source']): ReportedSubmoduleSlot => ({
    ...s,
    source,
    exists: existsSync(s.dir),
  });
  // The built-in path: the provisioner said what it cut and the record kept it.
  if (slot.submodule_slots.length) return slot.submodule_slots.map((s) => seal(s, 'record'));

  const fromEnv = new Map<string, ProvisionedSubmodule>();
  for (const s of envFileSubmoduleSlots(slot.env_file)) if (!fromEnv.has(s.path)) fromEnv.set(s.path, s);

  const out: ReportedSubmoduleSlot[] = [];
  const claimed = new Set<string>();
  for (const rel of slot.submodules) {
    const published = fromEnv.get(rel);
    if (published) {
      claimed.add(rel);
      out.push(seal(published, 'env-file'));
      continue;
    }
    out.push(
      seal(
        {
          path: rel,
          name: basename(rel),
          dir: derivedSubmoduleSlotDir(slot.worktree_path, slot.name, rel),
          // The integration branch is the one thing the convention cannot
          // derive — it is a fact about the submodule repository, not about the
          // layout. Empty, never guessed; the key is always present (a consumer
          // reads a shape, not a maybe-shape).
          base: '',
        },
        'derived',
      ),
    );
  }
  for (const [rel, s] of fromEnv) if (!claimed.has(rel)) out.push(seal(s, 'env-file'));
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
  /** One entry per submodule slot this create produced — `{ path, name, dir,
   *  base, source, exists }` — WHICHEVER side provisioned it (a11).
   *
   *  It used to be `[]` on the hook path, on the reasoning that the frozen
   *  contract does not make a hook enumerate its submodule slots. It does not;
   *  but a worker works IN the submodule slot, so an empty list here reads as
   *  "there is nothing to look at" about the only directory that ever holds the
   *  work. The directory is derived instead — from the record, the env file, or
   *  the shared convention — and `source` says which, so an unreported hook
   *  answer is never dressed up as a reported one. See `reportedSubmoduleSlots`.
   *
   *  On a FAILED create it lists the submodule slots that were cut before the
   *  failure (the provisioner deletes nothing), so an operator can see what is
   *  on disk. `[]` — never null, never absent — when none were declared. */
  submodule_slots: ReportedSubmoduleSlot[];
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
    releaseReservations(reservationDirFor(slotRootBase()), ctx.name, ctx.worktreePath);
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
  // WHAT THE RECORD KEEPS, and it is deliberately unchanged by a11: only the
  // built-in provisioner's own answer. The record is what teardown reaps from,
  // and a derived directory — however well-founded — is not a thing this
  // command watched itself create. Reporting derives; recording does not.
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
    // The failure case's value: what the provisioner managed to cut before it
    // gave up. A failed create has no env file and no record to derive from, so
    // there is nothing else to report; the success return below replaces this
    // with the full derivation.
    submodule_slots: submoduleSlots.map((s) => ({ ...s, source: 'record' as const, exists: existsSync(s.dir) })),
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
    // What teardown will have to reap — recorded now, while the provisioner is
    // the one saying what it made.
    submodule_slots: submoduleSlots,
    hook_dir: hookDir,
    ports_requested: portCount,
    port_base: portBase,
    provisioner: hasHook ? 'hook' : 'builtin',
    created_at: known?.created_at || at,
    updated_at: at,
    outcome: null,
    finalized: false,
    finalized_by: null,
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
      // Derived from what this create actually produced — including a HOOK's,
      // which reports nothing of its own (a11). Same shape from both paths.
      submodule_slots: reportedSubmoduleSlots({
        name,
        worktree_path,
        env_file,
        submodules: args.submodules,
        submodule_slots: submoduleSlots,
      }),
      detail: portsNote,
    },
    code: 0,
  };
}

/** The bracketed tail of a submodule-slot line: the integration branch, where
 *  the directory came from, and — the question a reconciliation is actually
 *  asking — whether it is on disk. */
function submoduleNote(s: ReportedSubmoduleSlot): string {
  return `[base ${s.base || 'unknown'}]  [${s.source}${s.exists ? '' : ', NOT on disk'}]`;
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
  // The directory a worker actually works in — printed for a hook-provisioned
  // slot too (a11), with the provenance of the path and whether it is there.
  for (const s of o.submodule_slots) lines.push(`  submodule ${s.path}: ${s.dir}  ${submoduleNote(s)}`);
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
  /** WHO finalized: the consumer's `worktree-finalize.*` (`hook`), or the
   *  CLI's built-in no-op (`builtin`). The `ok:true` of a built-in finalize
   *  means "nothing was required and nothing was done" — NOT "the work was
   *  landed" — and this field is how an orchestrator tells them apart. */
  finalized_by: 'hook' | 'builtin';
  /** Which side provisioned the slot (`hook` when unknown). */
  provisioner: 'hook' | 'builtin';
  detail: string | null;
}

/** THE BUILT-IN FINALIZE IS A NO-OP THAT REPORTS OK, and the reasoning is worth
 *  stating because "do nothing, successfully" looks like a stub:
 *
 *  On the run path, `finalize` is where a consumer COMMITS AND PUSHES. There is
 *  no defensible default for that — which remote, which branch, what message,
 *  whether to sign, whether to open a pull request, whether to merge — and
 *  every one of those choices is irreversible in a way the create path's is
 *  not: a wrong worktree is a directory `destroy` reaps, a wrong push is
 *  somebody else's history. A built-in provisioner can copy the reference
 *  hook's layout because a layout is a convention; there is no equivalent
 *  convention for landing work.
 *
 *  Refusing instead (`ok:false`) was the other candidate and it fails the goal:
 *  it would re-break `create → finalize → destroy` in a hook-less repository,
 *  which is exactly the asymmetry F-7 exists to close.
 *
 *  So: succeed, do nothing, and SAY SO — in `detail` and in `finalized_by`, so
 *  no caller can read `ok:true` as "my branch is pushed". */
function builtinFinalizeDetail(hookDirAbs: string): string {
  return (
    `no ${hookDirAbs}/worktree-finalize.* hook found — the built-in finalize is a NO-OP: ` +
    `nothing was committed, pushed, merged or tagged, and the slot is unchanged. ` +
    `Author a worktree-finalize.* hook if this slot's work has to be landed; a hook always wins over the built-in path.`
  );
}

function finalizeSlot(args: WorktreeArgs): { output: FinalizeOutput; code: number } {
  const projectRoot = projectRootOf();
  const name = args.name!;
  const slot = readSlot(projectRoot, name);
  const hookDir = args.hookDir ?? slot?.hook_dir ?? DEFAULT_HOOK_DIR;
  const paths = hookPathsFor(projectRoot, hookDir);
  // Same two conditions as the teardown, and the same conservative default: a
  // slot whose provenance is unknown is treated as a HOOK's, so a repository
  // with a create hook and no finalize hook keeps failing loudly exactly as it
  // did before this path existed.
  const hasHook = resolveHookScript(paths.hookDirAbs, 'worktree-finalize') !== null;
  const provisioner: 'hook' | 'builtin' = slot?.provisioner ?? 'hook';
  const builtin = !hasHook && provisioner === 'builtin' && slot !== null;

  const res: FinalizeInfo = builtin
    ? { ok: true, detail: builtinFinalizeDetail(paths.hookDirAbs) }
    : runFinalizeHook(
        {
          run_id: name,
          name,
          base_branch: args.baseGiven ? args.base : (slot?.base_branch ?? args.base),
          submodules: args.submodulesGiven ? args.submodules : (slot?.submodules ?? []),
          worktree_path: slot?.worktree_path ?? null,
          outcome: 'completed',
        },
        paths,
        noopEmitter,
      );
  if (slot && res.ok) {
    slot.finalized = true;
    // Persisted, not just reported: `list` must be able to tell a builtin
    // no-op finalize from a hook's without re-running finalize (a10 DoD 3).
    slot.finalized_by = builtin ? 'builtin' : 'hook';
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
      finalized_by: builtin ? 'builtin' : 'hook',
      provisioner,
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
  /** WHO tore it down — the same distinction `ports_source` draws for ports
   *  (a4). `hook`: the consumer's `worktree-destroy.*` ran. `builtin`: this
   *  CLI's own teardown did. `none`: neither, and `detail` says why. */
  teardown_by: 'hook' | 'builtin' | 'none';
  /** Which side PROVISIONED the slot, from its record (`hook` when unknown).
   *  Together with `teardown_by` it makes the symmetry rule readable off the
   *  JSON: `builtin`/`hook` is a slot whose repository grew a destroy hook. */
  provisioner: 'hook' | 'builtin';
  /** Worktrees the BUILT-IN teardown removed (parent first). Always `[]` on the
   *  hook path — what a hook removes is the hook's to report, in `detail`. */
  removed_worktrees: string[];
  /** `<repo>: <branch>` per branch the built-in teardown deleted. */
  removed_branches: string[];
  removed_env_file: string | null;
  detail: string | null;
}

/** The submodule slots to reap for `slot`: what `create` recorded, or — for a
 *  record written before that field existed — the same derivation the
 *  provisioner used, from the parent slot's own path. */
function teardownSubmodulesOf(slot: SlotRecord): TeardownSubmodule[] {
  if (slot.submodule_slots.length) return slot.submodule_slots.map((s) => ({ path: s.path, dir: s.dir }));
  return slot.submodules.map((rel) => ({
    path: rel,
    dir: derivedSubmoduleSlotDir(slot.worktree_path, slot.name, rel),
  }));
}

function destroySlot(args: WorktreeArgs, git: GitRunner): { output: DestroyOutput; code: number } {
  const projectRoot = projectRootOf();
  const name = args.name!;
  const slot = readSlot(projectRoot, name);
  const hookDir = args.hookDir ?? slot?.hook_dir ?? DEFAULT_HOOK_DIR;
  const paths = hookPathsFor(projectRoot, hookDir);
  // Outcome-aware, mirroring the engine: a COMPLETED slot's branch dies with
  // it; a HALTED one is preserved for post-mortem and resume.
  const deleteBranches = args.outcome === 'completed';
  // The SAME resolution function the run path uses (lib/hooks.ts), so "is there
  // a hook?" cannot answer differently in two places.
  const hasHook = resolveHookScript(paths.hookDirAbs, 'worktree-destroy') !== null;
  const provisioner: 'hook' | 'builtin' = slot?.provisioner ?? 'hook';

  let ok: boolean;
  let detail: string | null;
  let teardown_by: DestroyOutput['teardown_by'];
  let removed_worktrees: string[] = [];
  let removed_branches: string[] = [];
  let removed_env_file: string | null = null;

  if (hasHook) {
    // A hook that exists ALWAYS wins — including over a slot the built-in
    // provisioner made. Said out loud in `detail` rather than left to be
    // inferred: a repository that grew a destroy hook after the fact is exactly
    // the case where an operator wants to know which side ran.
    const res = runDestroyHook(
      {
        run_id: name,
        name,
        worktree_path: slot?.worktree_path ?? null,
        outcome: args.outcome,
        delete_branches: deleteBranches,
      },
      paths,
      noopEmitter,
    );
    teardown_by = 'hook';
    ok = res.ok;
    const note =
      provisioner === 'builtin'
        ? `this slot was provisioned by the built-in provisioner, but ${hookDir}/worktree-destroy.* exists and a hook always wins — the HOOK tore it down`
        : null;
    detail = note === null ? res.detail : res.detail === null ? note : `${note} — ${res.detail}`;
  } else if (provisioner === 'builtin' && slot !== null) {
    teardown_by = 'builtin';
    if (args.outcome !== 'completed') {
      // PRESERVED WHOLE. Nothing is removed on `halted`, which is what makes
      // the slot resumable — and its port reservation stays claimed for the
      // same reason (a4): a preserved slot still owns its ports.
      ok = true;
      detail =
        `no ${paths.hookDirAbs}/worktree-destroy.* hook found — the built-in teardown PRESERVED this slot ` +
        `(--outcome ${args.outcome}): its worktree, branch, env file and port reservation are untouched. ` +
        `Re-run with --outcome completed to reap it.`;
    } else {
      const res = teardownSlot(
        {
          name,
          worktreePath: slot.worktree_path,
          branch: slot.branch,
          envFile: slot.env_file,
          submodules: teardownSubmodulesOf(slot),
          projectRoot,
          deleteBranches,
        },
        git,
      );
      ok = res.ok;
      removed_worktrees = res.removed_worktrees;
      removed_branches = res.removed_branches;
      removed_env_file = res.removed_env_file;
      detail = res.ok
        ? `no ${paths.hookDirAbs}/worktree-destroy.* hook found — the built-in teardown reaped this slot (the built-in provisioner made it)`
        : res.detail;
    }
  } else {
    // THE REFUSAL SIDE OF THE SYMMETRY RULE. A slot this CLI did not provision
    // is not this CLI's to reap: a hook's bookkeeping is invisible from here,
    // and a built-in teardown that guessed at it would orphan the parts it
    // guessed wrong. Same exit code the missing-hook case has always had.
    teardown_by = 'none';
    ok = false;
    detail =
      slot === null
        ? `no slot record for '${name}' under .pipeline/.runtime/worktrees/, and no ${paths.hookDirAbs}/worktree-destroy.* hook — ` +
          `there is nothing this command can safely tear down. Either the slot was already reaped (a completed destroy drops its record), or it was never created here; ` +
          `a slot this command never recorded may be a hook's, and a hook's bookkeeping is not this CLI's to guess at.`
        : `slot '${name}' was provisioned by a ${slot.hook_dir}/worktree-create.* hook, and there is no ${paths.hookDirAbs}/worktree-destroy.* hook to reap it. ` +
          `The built-in teardown REFUSES to reap a hook-provisioned slot: the hook owns bookkeeping this CLI never wrote — its own registrations, branches and env files — and reaping around it would silently orphan them. ` +
          `Restore the destroy hook (a hook always wins), or tear the slot down by hand and delete .pipeline/.runtime/worktrees/${name}.json.`;
  }

  const reaped = ok && args.outcome === 'completed';
  if (reaped) {
    deleteSlot(projectRoot, name);
    // The slot is gone, so its ports go back to the pool NOW rather than
    // waiting for some later allocation to notice the reservation is stale.
    // Identified by name AND worktree path — the registry is machine-wide and
    // slot names (task ids) repeat across projects.
    if (slot) releaseReservations(reservationDirFor(slotRootBase()), name, slot.worktree_path);
  } else if (slot) {
    slot.outcome = args.outcome;
    slot.updated_at = nowIso();
    writeSlot(projectRoot, slot);
  }

  return {
    output: {
      command: 'worktree destroy',
      ok,
      name,
      worktree_path: slot?.worktree_path ?? null,
      outcome: args.outcome,
      delete_branches: deleteBranches,
      reaped,
      preserved: !reaped,
      teardown_by,
      provisioner,
      removed_worktrees,
      removed_branches,
      removed_env_file,
      detail,
    },
    code: ok ? 0 : 1,
  };
}

function humanDestroy(o: DestroyOutput): string {
  if (!o.ok) return `worktree destroy ${o.name}: FAILED — ${o.detail ?? 'unknown reason'}\n`;
  const by =
    o.teardown_by === 'hook' ? 'a worktree-destroy.* hook' : 'the built-in teardown (no worktree-destroy.* found)';
  const lines = [`worktree ${o.reaped ? 'destroyed (reaped)' : 'destroyed (preserved)'} ${o.name}`, `  by:       ${by}`];
  for (const p of o.removed_worktrees) lines.push(`  removed:  ${p}`);
  for (const b of o.removed_branches) lines.push(`  branch:   ${b} (deleted)`);
  if (o.removed_env_file) lines.push(`  env file: ${o.removed_env_file} (deleted)`);
  if (o.detail) lines.push(`  note:     ${o.detail}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListedSlot extends SlotRecord {
  /** The slot's submodule directories, DERIVED at list time rather than read
   *  straight off the record (a11 — the fix that matters for resume).
   *
   *  `create`'s output is long gone by the time a run is reconciled; `list` is
   *  what a resume calls, and a hook-provisioned slot's record carries `[]`
   *  here by design. Narrowing `SlotRecord`'s field rather than adding a second
   *  one is deliberate: a consumer that reads `submodule_slots` off `list` must
   *  get the answer, not a `[]` that happens to be the record's spelling of "I
   *  did not write this down". `source`/`exists` say how solid each entry is. */
  submodule_slots: ReportedSubmoduleSlot[];
  /** Whether the recorded worktree path is still on disk. A false here is a
   *  stale record, not a leak — `pipeline gc` owns leak detection and reaping.
   *
   *  ⚠ It is the PARENT slot's path, and a parent slot is empty by design when
   *  the work happens in a submodule. `exists: true` with a clean tree is not
   *  evidence that a slot holds nothing — read `submodule_slots` before
   *  concluding that. */
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
    slots: listSlots(projectRoot).map((s) => ({
      ...s,
      submodule_slots: reportedSubmoduleSlots(s),
      exists: existsSync(s.worktree_path),
    })),
  };
}

function humanList(o: ListOutput): string {
  if (!o.slots.length) return `no provisioned worktree slots under ${o.project_root}\n`;
  const lines = [`provisioned worktree slots (${o.slots.length}) — ${o.project_root}`];
  for (const s of o.slots) {
    const state = !s.exists ? 'missing' : s.outcome === 'halted' ? 'preserved' : s.finalized ? 'finalized' : 'live';
    // Only meaningful once finalized — and even then may be `null` (an older
    // record, from before this field existed): say "unknown" rather than
    // guessing, exactly as the record itself refuses to guess (DoD 4/5).
    const finalizedNote = s.finalized ? `  [finalized_by=${s.finalized_by ?? 'unknown'}]` : '';
    lines.push(`  ${state.padEnd(9)} ${s.name}  ${s.worktree_path}  [${s.branch ?? 'no branch reported'}]${finalizedNote}`);
    // The parent slot above is EMPTY BY DESIGN when a worker works in a
    // submodule. These lines are where the work is (a11); without them an
    // operator reading this output reaches the same wrong conclusion the
    // machine-readable path used to force.
    for (const sub of s.submodule_slots) {
      lines.push(`            submodule ${sub.path}: ${sub.dir}  ${submoduleNote(sub)}`);
    }
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
  '  A hook, where one exists, PROVISIONS THE SLOT — the built-in provisioner',
  '  does not run beside it: the worktree, the branch and the env file are the',
  "  hook's. It is NOT inert in every respect, and the exception is PORTS, which",
  '  fall back PER FIELD (D14): a hook that returns `ports: {}` / `port_base: 0`',
  '  — i.e. any hook written before ports existed — still gets the CLI\'s block,',
  '  appended to the env file the hook itself reported. Only a hook that returns',
  '  NON-EMPTY ports overrides. See PORTS below.',
  '  The provisioner is reachable from this command only: a pipeline RUN with no',
  '  worktree-create.* still halts, exactly as before.',
  '  --json reports the slot\'s SUBMODULE directories whichever side provisioned',
  '  it (submodule_slots[].dir, with `source` and `exists`) — a worker works in',
  '  the submodule slot, and the parent slot is empty by design.',
  '  Environment: PIPELINE_WT_ROOT (where slots live; default C:/tmp on Windows,',
  '  else the system temp dir) · PIPELINE_WT_INTEGRATION_BRANCH (default `next`)',
  '  · PIPELINE_WT_FETCH=1 (fetch origin first; off by default so create never',
  '  blocks on a remote) · PIPELINE_WT_PORT_RANGE=min-max (default 20000-32767).',
  '  Requires git 2.20+.',
  '',
  'NO worktree-finalize.* / worktree-destroy.* HOOK? What this command',
  'provisioned, it also reaps — so a repository with NO hooks at all runs the',
  'whole lifecycle: create -> finalize -> destroy.',
  '  * finalize is a NO-OP that reports ok. finalize is where a consumer commits',
  '    and pushes, and there is no defensible default for which remote, which',
  '    branch, or what message — so nothing is committed, pushed, merged or',
  '    tagged, --json says finalized_by=builtin, and the note says so too.',
  '  * destroy --outcome completed REAPS what the built-in provisioner made: the',
  '    worktree, every submodule worktree, the worktree-<name> branch in each of',
  '    those repositories, the env file, the port reservation and the slot',
  '    record. --outcome halted PRESERVES all of it, ports included.',
  '  * A worktree-destroy.* hook, where one exists, ALWAYS wins — including over',
  '    a slot the built-in provisioner made (--json: teardown_by=hook while',
  '    provisioner=builtin, and the note says which ran).',
  '  * The reverse is REFUSED: the built-in teardown never reaps a slot a hook',
  '    provisioned. A hook keeps bookkeeping this CLI never wrote, and guessing',
  '    at it would orphan it — so `destroy` exits 1 with the reason instead.',
  '  Reachable from this command only (D9): a pipeline RUN with no',
  '  worktree-destroy.* still reports a failed teardown, exactly as before.',
  '  `pipeline gc` is the janitor for a slot NOTHING can still name: it scans the',
  '  built-in slot root too, and reaps a slot there with no slot record — a run',
  '  that died before destroy — through this same teardown. A slot a record still',
  '  names is destroy\'s, and a hook-provisioned one is never reaped from either.',
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
  '            must-succeed: only an explicit {"ok":true} passes). With no',
  '            hook, a built-in NO-OP reports ok for a slot this command',
  '            provisioned itself (--json: finalized_by).',
  '  destroy   Tear the slot down. --outcome completed (default) REAPS —',
  '            PIPELINE_WT_DELETE_BRANCHES=1 and the slot record is dropped;',
  '            --outcome halted PRESERVES — DELETE_BRANCHES=0 and the record',
  '            is kept for post-mortem. With no hook, the built-in teardown',
  '            reaps a slot this command provisioned (--json: teardown_by).',
  '  list      The slots this command provisioned, and whether each is still on',
  '            disk — INCLUDING each slot\'s submodule directories, for a hook-',
  '            provisioned slot too. That is where a dispatched worker works, so',
  '            it is what a resumed run must inspect before concluding a slot is',
  '            empty. Leak detection and reaping belong to `pipeline gc`.',
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
  const { output, code } = destroySlot(parsed, git);
  emit(parsed.json, output, humanDestroy(output));
  return code;
}
