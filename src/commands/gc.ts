// `pipeline gc [--project <path>] [--clean] [--json] [--no-submodules]
//              [--force-worktree-branches]`
//
// The leak janitor: verify (and, with --clean, reap) pipeline worktrees and
// branches left behind by crashed/killed runs. The RUNTIME cleans up after
// itself (parallel merges delete branches; the external destroy hook receives
// the outcome-aware PIPELINE_WT_DELETE_BRANCHES) — `gc` is the safety net that
// proves it, and mops up after the cases no runtime can cover (SIGKILL mid-run,
// a crashed hook, a manually deleted directory).
//
// Report (always, exit 0):
//   - registered git worktrees under `<project>/.claude/worktrees/`, each with
//     its branch and whether that branch is fully merged into the default
//     branch (`git merge-base --is-ancestor`); default branch = the
//     `origin/HEAD` symref when resolvable, else `main`, else `master`;
//   - stale directories inside `.claude/worktrees/` NOT registered as
//     worktrees (leftover dirs after a crash); a dir that IS a registered
//     worktree of a scanned submodule is NOT stale — it's a leaked submodule
//     worktree, reported (and cleaned) under its submodule instead;
//   - prunable worktree records (`git worktree prune --dry-run -v`);
//   - local `worktree-*` branches with no attached worktree, flagged
//     merged/unmerged. NOTE: squash-merged branches read as "unmerged" to
//     `--is-ancestor` — branches are REPORT-ONLY unless merged; plain --clean
//     never force-deletes (see --force-worktree-branches below);
//   - the SAME scan per initialized git submodule (runs provision worktrees in
//     every declared submodule, so each crashed run historically leaked one
//     `worktree-*` branch into EACH submodule repo): the submodule's own
//     default branch resolved with the same ladder, its orphaned `worktree-*`
//     branches, its registered worktrees whose path lies under the
//     SUPERPROJECT's `.claude/worktrees/` (leaked registrations), and its
//     prunable records. Uninitialized submodules are skipped silently and
//     counted. `--no-submodules` disables the whole submodule pass.
//   - the BUILT-IN SLOT ROOT **and the SLOT REGISTRY** — see the sections below.
//
// ── THE BUILT-IN SLOT ROOT (taskflow-v2 a8 / finding F-10) ──────────────────
//
// Everything above looks INSIDE the project. a3's built-in provisioner puts its
// slots OUTSIDE it, under `slotRootFor(<project>)` — `PIPELINE_WT_ROOT` (or
// `C:/tmp`, or the system temp dir) plus a per-project `<basename>-<8 hex of
// the project path>` segment — precisely so a worker's `node_modules` and build
// output never land in the project folder. Their branches are ATTACHED, so the
// orphan-branch sweep skips them too. Between a3 and a5, therefore, NOTHING
// reaped a built-in slot: a5 gave `pipeline worktree destroy` a teardown, which
// closes the happy path, and leaves the leak path — a run that dies before
// `destroy` — with no janitor at all. This is that janitor.
//
// The path is taken from `slotRootFor()` itself, never re-derived: a janitor
// that computed the slot root a second way would disagree with the provisioner
// the first time either changed, and would then either miss every slot or reap
// somebody else's directory.
//
// OWNERSHIP — WHO DECIDES A DIRECTORY IS OURS TO DELETE:
//
//   * A SLOT RECORD (`.pipeline/.runtime/worktrees/<name>.json`) is the
//     evidence. `provisioner: 'builtin'` says this CLI made it; `'hook'` says a
//     consumer's `worktree-create.*` did, and a5's SYMMETRY RULE governs here
//     exactly as it does in `destroy`: the built-in path never reaps a hook's
//     slot, because a hook keeps bookkeeping this CLI never wrote. Such a slot
//     is REPORTED and left alone, with the reason stated. (a12 adds the one
//     exception that is not one: a hook's row that names NOTHING on disk — see
//     the slot-registry section — where the stale row, not the slot, is reaped.)
//   * A record whose worktree is STILL ON DISK is `pipeline worktree destroy
//     --name <n>`'s to reap, not gc's — gc reaps what no command can, and a
//     directory that may hold a live worker is not that. It is reported as
//     `tracked`, with the command that owns it.
//   * A record whose worktree is ALREADY GONE is a leak with no live half: its
//     branch, its env file and its port reservation are stranded, and nothing
//     will call `destroy` for a run that already died. gc reaps it.
//   * A DIRECTORY UNDER THE SLOT ROOT THAT NO RECORD NAMES is the case F10 case
//     4 calls "a slot with no matching row". Nothing can name it — `destroy`
//     takes a `--name` and looks the record up, so a slot whose record is gone
//     (a wiped `.pipeline/.runtime/`, a re-cloned project, a crash between
//     `git worktree add` and the record write) is unreachable by every other
//     command. gc is the only thing that can reap it, so it does — and the
//     CAUTION the absence of a record demands is spent on the guards below plus
//     one more: the path must lie under the project-scoped, hash-suffixed slot
//     root this CLI computed. Nothing else derives that spelling.
//   * A slot preserved on purpose (`destroy --outcome halted`) is never reaped.
//
// ── THE SLOT REGISTRY (taskflow-v2 a12 / finding P-5) ──────────────────────
//
// The section above scans a DIRECTORY: `slotRootFor(<project>)`. That is where
// the BUILT-IN provisioner puts slots, and only there. A consumer's
// `worktree-create.*` puts its slot wherever it likes — this repository's own
// reference hook uses `PIPELINE_WT_ROOT/<name>`, which is the slot root's PARENT
// and therefore outside the scan — so between a8 and a12 a hook-provisioned slot
// was invisible to gc no matter how thoroughly it had leaked, and **a clean gc
// report was not evidence that nothing had leaked.** The second proving run
// established that mechanism; the first had already recorded its gc confirmation
// as a "false clean" and suspected it.
//
// It matters because 03-execution-flows.md F10 case 4 and F11 both lean on this
// command as the janitor of record — "a slot with no matching row → a leak;
// `pipeline gc` reports it, `--clean` reaps it" — which is only true of slots gc
// can SEE. So gc now also scans the SLOT REGISTRY
// (`.pipeline/.runtime/worktrees/<name>.json`) and reports every slot it names,
// wherever that slot's directory is, whichever side provisioned it.
//
// TWO PATHS IN, ONE CLASSIFIER. A candidate is either a directory found under
// the slot root or a row found in the registry (`GcSlot.source` says which);
// both go through `classifySlot`, so the guards and the symmetry rule cannot
// apply to one and not the other. Where a candidate is reached both ways, the
// directory scan names it first and the registry row simply attaches to it.
//
// A REGISTRY ROW IS NOT A LICENCE TO DELETE — it is the opposite. A row can name
// ANY path a hook chose, so the guards matter more here than in the directory
// scan, not less, and they are applied FIRST: a row naming an implausible path
// is a refusal, not a target. The symmetry rule then keeps the built-in path off
// a live hook slot exactly as it does in `destroy`.
//
// The one thing gc will reap for a hook-provisioned slot is a row that names
// NOTHING ON DISK — no worktree, and no submodule slot either. That last clause
// is a11's lesson, and skipping it would re-open the data loss a11 exists to
// prevent: a dispatched worker's PARENT slot is empty (often absent) by design
// because the work happens in the SUBMODULE slot, so "the recorded worktree_path
// is gone" is not "the slot held nothing". The submodule directories are
// resolved through a11's own `reportedSubmoduleSlots` (record → env file →
// convention) rather than a second resolver — two resolvers that can disagree is
// the R3 failure this project has already paid for once. When every part really
// is gone, the row and the a4 port block — this CLI's OWN bookkeeping, not the
// hook's — are dropped, and nothing on disk is touched.
//
// ⚠ WHAT STILL CANNOT BE SEEN, stated so a clean report is read for what it is:
// a hook's slot DIRECTORY whose registry row is also gone. Under the built-in
// slot root that case is the a8 scan's ("a slot with no matching row"); outside
// it there is nothing left to enumerate from — a hook may put its slot anywhere,
// and gc will not walk the filesystem hunting for one. Every slot this CLI ever
// recorded is now visible, and that is the claim a12 makes.
//
// `--no-submodules` does NOT narrow this pass. The provisioner cuts one
// worktree per declared submodule BESIDE the parent slot (`<name>--<slug>`),
// and those belong to their parent: without the submodule list one would read
// as a slot in its own right and be reaped from the superproject, which does
// not own it. The flag switches off the per-submodule branch/registration
// sweep, not half of a slot's shape — a slot is reaped whole or not at all.
//
// ⚠ `--clean` OVER THE SLOT ROOT IS A QUIESCENT-POINT OPERATION. A slot being
// provisioned right now has a directory for the few seconds before its record
// is written, and would read as record-less. That window is not closable from
// here (the provisioner writes the worktree first by necessity), and it does
// not need to be: F10 reconciles BEFORE any new dispatch and F11 runs AFTER the
// last row is verified. Run `--clean` while workers are being dispatched and it
// may reap a slot that is still being born; the read-only report never does.
//
// BRANCHES ARE NOT DELETED BY THE SLOT REAP. a5's teardown can delete the
// `worktree-<name>` branch, and `destroy --outcome completed` asks it to. gc
// does not: this command's contract is that plain `--clean` NEVER force-deletes
// a branch (see `--force-worktree-branches` below), and a run branch is
// routinely squash-merged, which reads as unmerged forever. So the slot reap
// runs FIRST and asks for no branch deletion; removing the worktree detaches
// the branch, and the ordinary branch sweep then applies this command's own
// policy to it — safe-delete when merged, keep with a reason when not.
//
// `--clean` additionally (CONSERVATIVE — never the current branch/worktree,
// never a force branch delete):
//   - `git worktree prune`;
//   - `git worktree remove --force` each registered worktree under
//     `.claude/worktrees/` whose branch is fully merged (unmerged/detached ones
//     are kept and listed with a reason);
//   - deletes the removed dirs' stale leftovers + other stale dirs in
//     `.claude/worktrees/` (protecting dirs that are live submodule worktrees);
//   - `git branch -d` (SAFE delete only) merged branches that either match
//     `worktree-*` or belonged to a worktree just removed;
//   - applies the same per-submodule (prune → remove merged worktrees under
//     the superproject's `.claude/worktrees/` → safe-delete merged branches);
//   - reaps each ORPHANED BUILT-IN SLOT through a5's own `teardownSlot` (the
//     parent worktree, every submodule worktree, the env file) — never a second
//     removal implementation — then drops its stale slot record and hands its
//     a4 PORT RESERVATIONS back, exactly as `destroy --outcome completed` does;
//   - drops each STALE REGISTRY ROW that names nothing on disk (a12), handing
//     its port block back too — and, for a hook-provisioned slot, deleting
//     nothing on disk at all;
//   - prints exactly what was kept and why.
//
// `--force-worktree-branches` (opt-in, requires --clean): additionally
// `git branch -D` UNMERGED `worktree-*` branches, per repo. Rationale: run
// branches are SQUASH-merged in many consumer flows, so a fully-landed branch
// reads as "unmerged" to `--is-ancestor` FOREVER — safe `-d` can never reap it.
// Guard rails: applies ONLY to the machine-owned `worktree-*` namespace, never
// the current branch, and the human output states how many were force-deleted
// per repo.
//
// All git calls go through the injectable GitRunner seam (lib/git.ts) so tests
// can wrap/observe them; the shipped tests drive REAL temp git repos.
// Exit: 0 (report/clean, leaks or not) · 2 (usage / not a git repo).

import { existsSync, readdirSync, rmSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  realGit,
  isGitRepo,
  iterWorktrees,
  branchExists,
  isAncestor,
  currentBranch,
  type GitRunner,
} from '../lib/git';
import { releaseReservations, reservationDirFor } from '../lib/port-alloc';
import {
  derivedSubmoduleSlotDir,
  isUnder as isUnderOrEqual,
  slotRootBase,
  slotRootFor,
  teardownSlot,
  tooShallowToDelete,
  toPosixPath,
  type TeardownSubmodule,
} from '../lib/worktree-provision';
import {
  deleteSlot as deleteSlotRecord,
  listSlots,
  reportedSubmoduleSlots,
  type ReportedSubmoduleSlot,
  type SlotRecord,
} from './worktree';

export interface GcWorktree {
  path: string;
  branch: string | null;
  /** true/false vs the default branch; null when detached or no default branch. */
  merged: boolean | null;
}

export interface GcBranch {
  branch: string;
  merged: boolean | null;
}

/** One scanned submodule's findings (paths judged against the SUPERPROJECT's
 *  `.claude/worktrees/`; merged state judged against the SUBMODULE's own
 *  default branch). */
export interface GcSubmoduleReport {
  /** Submodule path as declared (relative to the project root). */
  path: string;
  default_branch: string | null;
  branches: GcBranch[];
  worktrees: GcWorktree[];
  prunable: string[];
}

/** One submodule slot of a registry-known slot, AS RESOLVED — a11's shape,
 *  narrowed to what a janitor's report needs. `dir` is where the work is when
 *  the parent slot is empty, `source` says which channel named it, and `exists`
 *  is the only thing that decides whether the slot still has parts on disk. */
export interface GcSlotSubmodule {
  path: string;
  dir: string;
  source: ReportedSubmoduleSlot['source'];
  exists: boolean;
}

/** One entry of the SLOT SCAN: a slot found under the built-in slot root
 *  (taskflow-v2 a8 / F-10) or named by the slot registry (a12 / P-5),
 *  classified. */
export interface GcSlot {
  /** The slot name — its directory's basename, or the registry row's `name`,
   *  which is what `pipeline worktree destroy --name` takes. */
  name: string;
  /** The slot directory, in the provisioner's own forward-slash spelling. */
  path: string;
  /** What the slot record says provisioned it; null when NO record names it. */
  record: 'builtin' | 'hook' | null;
  /** How gc found this candidate: a directory under `slot_root`, or a row of
   *  the slot registry. `registry` entries may live ANYWHERE (a12 / P-5). */
  source: 'slot-root' | 'registry';
  exists: boolean;
  /** The slot's submodule directories, resolved through a11's own
   *  `reportedSubmoduleSlots` (record → env file → convention). `[]` when no
   *  record names this candidate, since there is then nothing to resolve from.
   *
   *  ⚠ Read these before concluding a slot is empty: a dispatched worker's
   *  PARENT slot is empty — often absent — by design, because the work happens
   *  here. That is the a11 data loss, and gc must not repeat it. */
  submodule_slots: GcSlotSubmodule[];
  /** True when gc treats it as a reapable leak — `--clean` acts on exactly
   *  these and on nothing else. */
  orphaned: boolean;
  /** Why it is a leak, or why it is left alone. Always stated, both ways. */
  reason: string;
}

/** One orphaned slot `--clean` actually reaped. */
export interface GcReapedSlot {
  name: string;
  path: string;
  /** WHICH reap ran (a12).
   *  `builtin-teardown` — a5's `teardownSlot`: worktrees, env file, then the
   *      record and the ports. The only path that deletes anything on disk, and
   *      it runs for built-in slots only.
   *  `record-only`      — a registry row that named nothing on disk: the row and
   *      the a4 port block go back, and NOTHING on disk is touched. This is what
   *      a hook-provisioned slot gets, because the symmetry rule forbids the
   *      built-in path from reaping a hook's directories. */
  reaped_by: 'builtin-teardown' | 'record-only';
  /** What a5's teardown removed (parent first, then each submodule slot).
   *  Always `[]` under `record-only`. */
  removed_worktrees: string[];
  removed_env_file: string | null;
  /** The stale `.pipeline/.runtime/worktrees/<name>.json` was dropped. */
  removed_record: boolean;
  /** How many a4 port reservations were handed back to the pool. */
  released_ports: number;
}

export interface GcSubmoduleCleaned {
  path: string;
  pruned: string[];
  removed_worktrees: string[];
  kept_worktrees: Array<{ path: string; reason: string }>;
  deleted_branches: string[];
  /** `git branch -D` deletions of UNMERGED worktree-* branches — only ever
   *  populated under --force-worktree-branches. */
  force_deleted_branches: string[];
  kept_branches: Array<{ branch: string; reason: string }>;
}

export interface GcCleaned {
  /** Verbose lines from `git worktree prune -v` (records actually pruned). */
  pruned: string[];
  removed_worktrees: string[];
  kept_worktrees: Array<{ path: string; reason: string }>;
  removed_dirs: string[];
  deleted_branches: string[];
  kept_branches: Array<{ branch: string; reason: string }>;
  /** `git branch -D` deletions of UNMERGED worktree-* branches — only ever
   *  populated under --force-worktree-branches. */
  force_deleted_branches: string[];
  submodules: GcSubmoduleCleaned[];
  /** Orphaned slots reaped from the slot root (a8) or the registry (a12). */
  reaped_slots: GcReapedSlot[];
  /** Orphaned slots the teardown could NOT reap, and why (a locked or in-use
   *  directory — the Windows case — reads exactly like this). */
  kept_slots: Array<{ path: string; reason: string }>;
}

export interface GcReport {
  default_branch: string | null;
  worktrees: GcWorktree[];
  stale_dirs: string[];
  prunable: string[];
  branches: GcBranch[];
  /** One entry per SCANNED (initialized) submodule; [] under --no-submodules. */
  submodules: GcSubmoduleReport[];
  /** Uninitialized (or unreadable) submodules skipped by the scan. */
  submodules_skipped: number;
  /** Where the built-in provisioner puts THIS project's slots — reported even
   *  when it holds nothing, because "gc looked there" is the claim a8 makes. */
  slot_root: string;
  /** Every slot candidate, classified: the built-in slot root scan (a8) AND
   *  every row of the slot registry, wherever its directory is (a12 / P-5).
   *
   *  The field name predates a12 and is kept for compatibility; `GcSlot.source`
   *  is what distinguishes the two scans, and `GcSlot.record` which side
   *  provisioned each slot. */
  builtin_slots: GcSlot[];
  cleaned: GcCleaned | null;
}

interface GcArgs {
  project?: string;
  clean: boolean;
  json: boolean;
  submodules: boolean;
  forceWorktreeBranches: boolean;
}

const USAGE =
  'Usage: pipeline gc [--project <path>] [--clean] [--json] [--no-submodules] [--force-worktree-branches]\n';

// ---------------------------------------------------------------------------
// Path + parsing helpers
// ---------------------------------------------------------------------------

/** Canonical absolute path for comparisons (case-folded + backslashed on
 *  win32; symlinks resolved when possible — git prints resolved paths). */
function normPath(p: string): string {
  let r: string;
  try {
    r = realpathSync(p);
  } catch {
    r = resolve(p);
  }
  if (process.platform === 'win32') r = r.replace(/\//g, '\\').toLowerCase();
  return r.length > 1 ? r.replace(/[\\/]+$/, '') : r;
}

function isUnder(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  return c !== p && c.startsWith(p + sep);
}

function splitLines(...chunks: string[]): string[] {
  return chunks
    .join('\n')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Immediate subdirectories of `dir` (absolute paths), or [] when absent. */
function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) out.push(full);
    } catch {
      // unreadable entry — skip
    }
  }
  return out;
}

/** True when `dir` is (or contains) one of the `protectedPaths` — used to keep
 *  the stale-dir sweep away from live submodule worktree checkouts. */
function coversProtected(dir: string, protectedPaths: string[]): boolean {
  const nd = normPath(dir);
  return protectedPaths.some((p) => {
    const np = normPath(p);
    return np === nd || np.startsWith(nd + sep);
  });
}

function parseGcArgs(args: string[]): GcArgs | { error: string } {
  const out: GcArgs = { clean: false, json: false, submodules: true, forceWorktreeBranches: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--project') {
      out.project = args[++i];
      if (!out.project) return { error: '--project requires a path' };
    } else if (a.startsWith('--project=')) {
      out.project = a.slice('--project='.length);
    } else if (a === '--clean') out.clean = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-submodules') out.submodules = false;
    else if (a === '--force-worktree-branches') out.forceWorktreeBranches = true;
    else return { error: `unknown argument '${a}'` };
  }
  if (out.forceWorktreeBranches && !out.clean)
    return { error: '--force-worktree-branches requires --clean' };
  return out;
}

// ---------------------------------------------------------------------------
// Git probes
// ---------------------------------------------------------------------------

/** The branch merged-state is judged against: the `origin/HEAD` symref when
 *  resolvable (name shown as `origin/<b>`), else local `main`, else `master`,
 *  else null (merged checks then read `unknown` and --clean keeps everything). */
export function resolveDefaultBranch(
  git: GitRunner,
  root: string,
): { name: string; ref: string } | null {
  const r = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], root);
  if (r.code === 0) {
    const full = r.stdout.trim();
    const name = full.startsWith('refs/remotes/origin/') ? full.slice('refs/remotes/origin/'.length) : '';
    if (name) return { name: `origin/${name}`, ref: full };
  }
  for (const cand of ['main', 'master']) {
    if (branchExists(git, root, cand)) return { name: cand, ref: `refs/heads/${cand}` };
  }
  return null;
}

function mergedInto(
  git: GitRunner,
  root: string,
  branch: string,
  def: { ref: string } | null,
): boolean | null {
  if (!def) return null;
  return isAncestor(git, root, `refs/heads/${branch}`, def.ref);
}

/** Local branches matching `worktree-*` (short names). */
function worktreeBranches(git: GitRunner, root: string): string[] {
  const r = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-*'], root);
  if (r.code !== 0) return [];
  return splitLines(r.stdout);
}

/** Initialized submodule paths (relative, as declared) + how many declared
 *  submodules were skipped (uninitialized `-` status, or unreadable as a
 *  repo). `git submodule status` line: `[ +-U]<sha> <path>[ (<desc>)]`. */
function listSubmodules(
  git: GitRunner,
  root: string,
): { initialized: string[]; skipped: number } {
  const r = git(['submodule', 'status'], root);
  if (r.code !== 0) return { initialized: [], skipped: 0 };
  const initialized: string[] = [];
  let skipped = 0;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([ +\-U])([0-9a-f]{40,64})\s+(.+?)(?:\s+\([^)]*\))?\s*$/.exec(line);
    if (!m) continue;
    const status = m[1]!;
    const path = m[3]!;
    if (status === '-' || !isGitRepo(git, join(root, path))) {
      skipped++;
      continue;
    }
    initialized.push(path);
  }
  return { initialized, skipped };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** The shared per-repo scan: registered worktrees under `wtDir` (with merged
 *  state vs `def`), prunable records, and orphaned worktree-* branches. Used
 *  for the superproject AND each submodule (with the SUPERPROJECT's wtDir). */
function scanRepo(
  git: GitRunner,
  repoRoot: string,
  wtDir: string,
  def: { name: string; ref: string } | null,
): { worktrees: GcWorktree[]; prunable: string[]; branches: GcBranch[] } {
  const all = iterWorktrees(git, repoRoot);

  const worktrees: GcWorktree[] = all
    .filter((w) => isUnder(w.path, wtDir))
    .map((w) => ({
      path: w.path,
      branch: w.branch,
      merged: w.branch !== null ? mergedInto(git, repoRoot, w.branch, def) : null,
    }));

  const pr = git(['worktree', 'prune', '--dry-run', '-v'], repoRoot);
  const prunable = splitLines(pr.stdout, pr.stderr);

  const attached = new Set(all.map((w) => w.branch).filter((b): b is string => b !== null));
  const branches: GcBranch[] = worktreeBranches(git, repoRoot)
    .filter((b) => !attached.has(b))
    .map((b) => ({ branch: b, merged: mergedInto(git, repoRoot, b, def) }));

  return { worktrees, prunable, branches };
}

export function gcReport(
  git: GitRunner,
  root: string,
  def: { name: string; ref: string } | null,
  protectedPaths: string[] = [],
): Pick<GcReport, 'default_branch' | 'worktrees' | 'stale_dirs' | 'prunable' | 'branches'> {
  const wtDir = join(root, '.claude', 'worktrees');
  const { worktrees, prunable, branches } = scanRepo(git, root, wtDir, def);

  const registered = new Set(iterWorktrees(git, root).map((w) => normPath(w.path)));
  const stale_dirs = listDirs(wtDir).filter(
    (d) => !registered.has(normPath(d)) && !coversProtected(d, protectedPaths),
  );

  return { default_branch: def?.name ?? null, worktrees, stale_dirs, prunable, branches };
}

// ---------------------------------------------------------------------------
// The SLOT scan: the built-in slot root (a8 / F-10) + the slot registry
// (a12 / P-5) — see the module header
// ---------------------------------------------------------------------------

/** What `--clean` will do with a candidate.
 *
 *  Three values rather than a boolean because "reap" is not one operation:
 *  a5's teardown DELETES DIRECTORIES, and the symmetry rule forbids running it
 *  over a hook's slot. `drop-record` is the reap that touches nothing on disk. */
type SlotAction = 'keep' | 'reap' | 'drop-record';

/** A scanned slot plus the record that proves (or fails to prove) it is ours.
 *  `GcSlot` is the reportable projection of this. */
interface SlotCandidate {
  name: string;
  path: string;
  record: SlotRecord | null;
  source: GcSlot['source'];
  exists: boolean;
  /** a11's resolution of this slot's submodule directories; `[]` with no
   *  record. The parts that decide whether a slot is really gone. */
  submodule_slots: GcSlotSubmodule[];
  action: SlotAction;
  orphaned: boolean;
  reason: string;
}

/** The parts of a slot still on disk: its own directory, plus every submodule
 *  slot a11's resolution found there.
 *
 *  THE PARENT PATH ALONE IS NOT THE ANSWER. A dispatched worker's parent slot is
 *  empty by design because the worker works in the submodule slot — the
 *  reasoning that reaped 21,880 bytes of finished work in the incident a11 was
 *  written for. "Nothing on disk" has to mean nothing, or a12 re-opens it. */
function liveParts(cand: { path: string; exists: boolean; submodule_slots: GcSlotSubmodule[] }): string[] {
  const parts = cand.exists ? [toPosixPath(cand.path)] : [];
  for (const s of cand.submodule_slots) if (s.exists) parts.push(toPosixPath(s.dir));
  return parts;
}

/** Immediate subdirectory NAMES of `dir`, sorted; [] when it is absent. */
function listDirNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    try {
      if (statSync(join(dir, name)).isDirectory()) out.push(name);
    } catch {
      // unreadable entry — skip
    }
  }
  return out;
}

/** Is this candidate a leak gc may reap, or is it somebody else's? Both
 *  answers carry their reason: an operator reading a report that says "kept"
 *  without saying why cannot tell a rule from a bug.
 *
 *  ORDER MATTERS, and a12 moved the deletion guards to the FRONT. A candidate
 *  can now arrive from the slot REGISTRY, where the path is whatever a hook
 *  wrote into a plain JSON file — so an implausible path must be refused as a
 *  path, before any rule about provenance gets to have an opinion about it. The
 *  guards never widen what is reaped, so putting them first can only refuse
 *  more; every case the a8 order decided, it still decides the same way. */
function classifySlot(
  cand: {
    name: string;
    path: string;
    record: SlotRecord | null;
    exists: boolean;
    submodule_slots: GcSlotSubmodule[];
  },
  root: string,
  slotRoot: string,
): { action: SlotAction; reason: string } {
  const rec = cand.record;
  const p = toPosixPath(cand.path);
  const keep = (reason: string): { action: SlotAction; reason: string } => ({ action: 'keep', reason });

  // 1. a5's THREE DELETION GUARDS, applied here rather than only inside the
  //    teardown, so an implausible path is refused where it is CLASSIFIED and
  //    never becomes a target in the first place. They gate the registry scan
  //    too — that is the whole reason they run first (a12).
  if (isUnderOrEqual(cand.path, root)) {
    return keep(
      `refused: ${p} is inside the repository ${toPosixPath(root)}, and the built-in provisioner never creates a slot there`,
    );
  }
  if (isUnderOrEqual(process.cwd(), cand.path)) {
    return keep(`refused: ${p} is (or contains) the current working directory`);
  }
  if (tooShallowToDelete(cand.path)) {
    return keep(`refused: a slot lives at <root>/<project>/<name> and ${p} is too close to a filesystem root to be one`);
  }

  // 2. Preserved ON PURPOSE. `destroy --outcome halted` keeps a slot whole for
  //    post-mortem and resume; a janitor that reaped it would delete the thing
  //    halting exists to save. Ahead of the symmetry rule because it is the more
  //    specific answer and it holds for BOTH provisioners — a halted hook slot
  //    was preserved deliberately, and its record is part of what was preserved.
  if (rec !== null && rec.outcome === 'halted') {
    return keep(
      `slot record '${rec.name}' was PRESERVED by \`pipeline worktree destroy --outcome halted\` — re-run that with --outcome completed to reap it`,
    );
  }

  // 3. THE SYMMETRY RULE (a5). A hook provisioned its slot with bookkeeping
  //    this CLI never saw — its own registrations, branches, env files — so
  //    reaping one from the built-in path would silently orphan them. Same
  //    boundary `pipeline worktree destroy` enforces, same direction.
  //
  //    a12 splits it on ONE question: is any part of the slot still there?
  //    While something is, the answer is unchanged — report it, touch nothing.
  //    When the row names nothing at all, the row itself is the leak: its ports
  //    are still claimed and `destroy` cannot help (with no worktree-destroy.*
  //    it REFUSES a hook's slot outright), so gc drops the row and the port
  //    block — its own bookkeeping — and still deletes nothing on disk.
  if (rec !== null && rec.provisioner === 'hook') {
    const live = liveParts(cand);
    const symmetry =
      `slot record '${rec.name}' says a worktree-create.* HOOK provisioned it — the built-in path never reaps a hook's slot ` +
      `(the symmetry rule: a hook keeps bookkeeping this CLI never wrote). Its worktree-destroy.* owns it.`;
    if (live.length) {
      // Said explicitly when the PARENT is gone but a submodule slot is not:
      // that combination is exactly what a resume misread in the a11 incident,
      // and a janitor's report is the wrong place to leave it implicit.
      const note = cand.exists
        ? ''
        : ` The recorded worktree is gone, but the slot is NOT empty — ${live.join(', ')} ${live.length === 1 ? 'is' : 'are'} still on disk (a dispatched worker's parent slot is empty by design; the work is in the submodule slot).`;
      return keep(`${symmetry}${note}`);
    }
    return {
      action: 'drop-record',
      reason:
        `slot record '${rec.name}' names a HOOK-provisioned slot with nothing left on disk — neither ${p} nor any of its ` +
        `${cand.submodule_slots.length} submodule slot${cand.submodule_slots.length === 1 ? '' : 's'} is there. The stale record and its port ` +
        `reservation are dropped; nothing on disk is touched, because the symmetry rule leaves a hook's directories to its own worktree-destroy.*`,
    };
  }

  // 4. gc's OWN fourth guard, and the one that does the work a slot record
  //    cannot when there is no slot record: only ever under the project-scoped,
  //    hash-suffixed slot root this CLI computed. Nothing else derives that
  //    spelling, so a path outside it is not something the built-in provisioner
  //    produced — whatever a record claims.
  //
  //    Only the BUILT-IN path reaches this: a hook's slot returned above, at the
  //    symmetry rule, and it must — a hook's slot is outside this root by
  //    construction (the reference hook uses the root's PARENT), which is the
  //    mechanism P-5 names. Refusing it here would report it and then explain
  //    the wrong reason for leaving it alone.
  if (!isUnder(cand.path, slotRoot)) {
    return keep(
      `refused: ${p} is not under this project's built-in slot root ${slotRoot} — ` +
        `gc reaps only what the built-in provisioner would have created`,
    );
  }

  // 5. A record whose worktree is still on disk is `destroy`'s to reap. gc
  //    reaps what NO command can reach, and a directory that may still hold a
  //    live worker is emphatically not that.
  if (cand.exists && rec !== null) {
    return keep(
      `tracked by slot record '${rec.name}' — \`pipeline worktree destroy --name ${rec.name}\` owns it; gc reaps only what no command can name`,
    );
  }

  // 6. The two leaks.
  if (!cand.exists) {
    return {
      action: 'reap',
      reason: `slot record '${rec?.name ?? cand.name}' names a worktree that is already gone — its branch, env file and port reservation are stranded`,
    };
  }
  return {
    action: 'reap',
    reason:
      'no slot record names it — nothing can reach this slot by name, so no `pipeline worktree destroy` can reap it; ' +
      'a run that died before destroy is what leaves one',
  };
}

/** Scan the built-in slot root AND the slot registry. READ-ONLY — this is what
 *  a plain `gc` reports.
 *
 *  `submodulePaths` are the project's initialized submodules (empty under
 *  `--no-submodules`): the provisioner cuts one worktree per declared submodule
 *  BESIDE the parent slot, as `<name>--<submodule slug>`, and those belong to
 *  their parent rather than standing as slots of their own. */
function scanSlots(root: string, slotRoot: string, submodulePaths: string[]): SlotCandidate[] {
  // A record that cannot be read is not a record: listSlots already drops
  // unparseable files, which is the conservative direction (an unreadable
  // record makes its slot look record-LESS, and the guards still gate it).
  let records: SlotRecord[] = [];
  try {
    records = listSlots(root);
  } catch {
    records = [];
  }
  const byPath = new Map<string, SlotRecord>();
  for (const r of records) byPath.set(normPath(r.worktree_path), r);

  // a11's RESOLUTION, once per record, imported rather than re-derived: record →
  // env file → convention, with `source` saying which channel answered. gc needs
  // exactly what `list --json` needs, and two resolvers that can disagree about
  // where a worker's commits are is the failure a11 exists to prevent.
  const subSlotsOf = new Map<string, GcSlotSubmodule[]>();
  for (const r of records) {
    subSlotsOf.set(
      r.name,
      reportedSubmoduleSlots(r).map((s) => ({ path: s.path, dir: s.dir, source: s.source, exists: s.exists })),
    );
  }

  const dirNames = listDirNames(slotRoot);

  // Directories that BELONG to another slot: a submodule slot is reaped WITH
  // its parent, from that submodule's own repository, and must never be
  // mistaken for an orphan in its own right. Resolved, not read off the record's
  // own field — that field is `[]` for every hook-provisioned slot by design.
  const owned = new Set<string>();
  for (const r of records) for (const s of subSlotsOf.get(r.name) ?? []) owned.add(normPath(s.dir));
  for (const n of dirNames) {
    for (const rel of submodulePaths) owned.add(normPath(derivedSubmoduleSlotDir(`${slotRoot}/${n}`, n, rel)));
  }

  const out: SlotCandidate[] = [];
  const seen = new Set<string>();
  const add = (name: string, path: string, source: GcSlot['source']): void => {
    const key = normPath(path);
    if (seen.has(key)) return;
    seen.add(key);
    const record = byPath.get(key) ?? null;
    const base = {
      name,
      path: toPosixPath(path),
      record,
      source,
      exists: existsSync(path),
      submodule_slots: record === null ? [] : (subSlotsOf.get(record.name) ?? []),
    };
    const verdict = classifySlot(base, root, slotRoot);
    out.push({ ...base, ...verdict, orphaned: verdict.action !== 'keep' });
  };

  for (const n of dirNames) {
    const p = `${slotRoot}/${n}`;
    if (owned.has(normPath(p))) continue;
    add(n, p, 'slot-root');
  }
  // EVERY registry row (a12 / P-5). Before a12 this loop took `builtin` records
  // only, so a hook-provisioned slot — whose directory is wherever the hook put
  // it, routinely outside the scan above — was invisible to gc entirely, and a
  // clean report proved nothing. A row is also the ONLY way a slot whose
  // directory is already gone can be seen at all.
  for (const r of records) add(r.name, r.worktree_path, 'registry');
  return out;
}

/** The reportable projection. */
function toGcSlot(c: SlotCandidate): GcSlot {
  return {
    name: c.name,
    path: c.path,
    record: c.record?.provisioner ?? null,
    source: c.source,
    exists: c.exists,
    submodule_slots: c.submodule_slots,
    orphaned: c.orphaned,
    reason: c.reason,
  };
}

/** Reap the orphans `scanSlots` found, through a5's `teardownSlot`.
 *
 *  `deleteBranches: false` on purpose — see the module header: this command
 *  never force-deletes a branch under plain `--clean`, and detaching the branch
 *  by removing its worktree hands it to gc's ordinary, documented branch
 *  policy. A teardown that fails leaves the slot AND its record in place, which
 *  is a5's contract and is exactly what a Windows file lock produces. */
function reapSlots(
  git: GitRunner,
  root: string,
  slotRoot: string,
  cands: SlotCandidate[],
  submodulePaths: string[],
): { reaped: GcReapedSlot[]; kept: Array<{ path: string; reason: string }> } {
  const reaped: GcReapedSlot[] = [];
  const kept: Array<{ path: string; reason: string }> = [];
  const reservationDir = reservationDirFor(slotRootBase());

  for (const c of cands) {
    if (c.action === 'keep') continue;
    const rec = c.record;

    // THE RECORD-ONLY REAP (a12). A registry row that names nothing on disk —
    // classifySlot proved that, submodule slots included — for a slot a hook
    // provisioned. There is nothing to tear down and, by the symmetry rule,
    // nothing gc may tear down: what goes is this CLI's OWN bookkeeping, the
    // stale row and the a4 port block it still holds. `teardownSlot` is
    // deliberately NOT called; it would derive submodule directories by the
    // built-in convention and delete whatever it found at them, which is
    // precisely the guess the symmetry rule forbids.
    if (c.action === 'drop-record') {
      if (rec === null) continue; // unreachable: only a hook RECORD yields this
      // A reservation is identified by name AND the slot path AS RECORDED at
      // allocation time (a4) — and on the hook path that is the hook's VERBATIM
      // spelling, which need not be this module's normalized one. Both are
      // tried, or a hook that wrote backslashes would leave its port block
      // claimed forever by a slot that no longer exists.
      let released_ports = releaseReservations(reservationDir, rec.name, c.path);
      if (rec.worktree_path !== c.path) {
        released_ports += releaseReservations(reservationDir, rec.name, rec.worktree_path);
      }
      reaped.push({
        name: rec.name,
        path: c.path,
        reaped_by: 'record-only',
        removed_worktrees: [],
        removed_env_file: null,
        removed_record: deleteSlotRecord(root, rec.name),
        released_ports,
      });
      continue;
    }

    // What create RECORDED, where there is a record; otherwise the same
    // derivation the provisioner used, over every declared submodule. A derived
    // directory that was never cut simply is not there, and the teardown
    // reports no removal for it.
    const declared = rec !== null && rec.submodules.length ? rec.submodules : submodulePaths;
    const submodules: TeardownSubmodule[] =
      rec !== null && rec.submodule_slots.length
        ? rec.submodule_slots.map((s) => ({ path: s.path, dir: s.dir }))
        : declared.map((rel) => ({ path: rel, dir: derivedSubmoduleSlotDir(c.path, c.name, rel) }));
    // The provisioner writes the env file BESIDE the slot as `<name>.env`; a
    // record, where there is one, is more authoritative than that convention.
    const beside = `${slotRoot}/${c.name}.env`;
    const envFile = rec?.env_file ?? (existsSync(beside) ? beside : null);

    const res = teardownSlot(
      {
        name: c.name,
        worktreePath: c.path,
        branch: rec?.branch ?? null,
        envFile,
        submodules,
        projectRoot: root,
        deleteBranches: false,
      },
      git,
    );
    if (!res.ok) {
      kept.push({ path: c.path, reason: res.detail ?? 'the built-in teardown could not reap it' });
      continue;
    }
    // The slot is gone, so everything that DESCRIBED it goes with it: the stale
    // record (which would otherwise keep naming a worktree that is not there)
    // and the port block, handed straight back rather than left to be noticed
    // as stale by some later allocation.
    const removed_record = rec !== null ? deleteSlotRecord(root, rec.name) : false;
    const released_ports = releaseReservations(reservationDir, c.name, c.path);
    reaped.push({
      name: c.name,
      path: c.path,
      reaped_by: 'builtin-teardown',
      removed_worktrees: res.removed_worktrees,
      removed_env_file: res.removed_env_file,
      removed_record,
      released_ports,
    });
  }
  return { reaped, kept };
}

// ---------------------------------------------------------------------------
// Clean
// ---------------------------------------------------------------------------

interface CleanOpts {
  /** The SUPERPROJECT's `.claude/worktrees/` dir (also for submodule repos). */
  wtDir: string;
  /** --force-worktree-branches: `git branch -D` unmerged worktree-* branches. */
  force: boolean;
  /** Sweep stale (unregistered) dirs out of wtDir — superproject only. */
  sweepStaleDirs: boolean;
  /** Live worktree paths of OTHER repos (submodules) the sweep must not touch. */
  protectedPaths: string[];
}

interface GcCleanedCore {
  pruned: string[];
  removed_worktrees: string[];
  kept_worktrees: Array<{ path: string; reason: string }>;
  removed_dirs: string[];
  deleted_branches: string[];
  force_deleted_branches: string[];
  kept_branches: Array<{ branch: string; reason: string }>;
}

function cleanRepo(
  git: GitRunner,
  repoRoot: string,
  def: { name: string; ref: string } | null,
  opts: CleanOpts,
): GcCleanedCore {
  const cleaned: GcCleanedCore = {
    pruned: [],
    removed_worktrees: [],
    kept_worktrees: [],
    removed_dirs: [],
    deleted_branches: [],
    force_deleted_branches: [],
    kept_branches: [],
  };
  const { wtDir } = opts;
  const current = currentBranch(git, repoRoot);
  const squashNote = 'squash-merged branches read as unmerged — verify and delete manually';

  // 1. Prune stale records first (a record whose dir vanished can't be removed).
  const pr = git(['worktree', 'prune', '-v'], repoRoot);
  cleaned.pruned = splitLines(pr.stdout, pr.stderr);

  // 2. Remove each registered worktree under .claude/worktrees whose branch is
  //    fully merged. NEVER the current working directory, NEVER a detached or
  //    unmerged one — those are kept and listed with the reason.
  const removedBranches: string[] = [];
  for (const wt of iterWorktrees(git, repoRoot).filter((w) => isUnder(w.path, wtDir))) {
    if (normPath(wt.path) === normPath(process.cwd())) {
      cleaned.kept_worktrees.push({ path: wt.path, reason: 'current working directory — never touched' });
      continue;
    }
    if (wt.branch === null) {
      cleaned.kept_worktrees.push({ path: wt.path, reason: 'detached HEAD — merge state unknown' });
      continue;
    }
    if (wt.branch === current) {
      cleaned.kept_worktrees.push({ path: wt.path, reason: `current branch '${wt.branch}' — never touched` });
      continue;
    }
    if (!def) {
      cleaned.kept_worktrees.push({ path: wt.path, reason: 'default branch unresolvable — cannot verify merged' });
      continue;
    }
    if (mergedInto(git, repoRoot, wt.branch, def) !== true) {
      cleaned.kept_worktrees.push({
        path: wt.path,
        reason: `branch '${wt.branch}' not merged into ${def.name} (${squashNote})`,
      });
      continue;
    }
    const rm = git(['worktree', 'remove', '--force', wt.path], repoRoot);
    if (rm.code !== 0) {
      cleaned.kept_worktrees.push({
        path: wt.path,
        reason: `git worktree remove failed: ${(rm.stderr || rm.stdout).trim()}`,
      });
      continue;
    }
    cleaned.removed_worktrees.push(wt.path);
    removedBranches.push(wt.branch);
  }

  // 3. Delete stale leftover directories (SUPERPROJECT pass only): anything
  //    still inside .claude/worktrees that is not a registered worktree
  //    (covers pre-existing stale dirs AND debris a `worktree remove` left
  //    behind) — EXCEPT dirs that are live worktrees of a scanned submodule.
  if (opts.sweepStaleDirs) {
    const registered = new Set(iterWorktrees(git, repoRoot).map((w) => normPath(w.path)));
    for (const d of listDirs(wtDir)) {
      if (registered.has(normPath(d))) continue;
      if (coversProtected(d, opts.protectedPaths)) continue;
      try {
        rmSync(d, { recursive: true, force: true });
        cleaned.removed_dirs.push(d);
      } catch {
        // best-effort — an undeletable dir simply stays reported as stale
      }
    }
  }

  // 4. SAFE-delete (git branch -d, never -D) merged branches that either match
  //    worktree-* with no attached worktree (post-prune/removal) or belonged to
  //    a worktree removed in step 2. The current branch is never touched.
  //    Under --force-worktree-branches ONLY: `git branch -D` the UNMERGED
  //    worktree-* leftovers too (squash-merged run branches read as unmerged
  //    forever — this is the only way to reap them; the namespace is
  //    machine-owned, so nothing hand-made is ever force-deleted).
  const attached = new Set(
    iterWorktrees(git, repoRoot)
      .map((w) => w.branch)
      .filter((b): b is string => b !== null),
  );
  const candidates = new Set<string>(removedBranches);
  for (const b of worktreeBranches(git, repoRoot)) if (!attached.has(b)) candidates.add(b);
  for (const b of [...candidates].sort()) {
    if (!branchExists(git, repoRoot, b)) continue; // already gone
    if (b === current) {
      cleaned.kept_branches.push({ branch: b, reason: 'current branch — never touched' });
      continue;
    }
    if (attached.has(b)) {
      cleaned.kept_branches.push({ branch: b, reason: 'attached to a registered worktree' });
      continue;
    }
    if (!def) {
      cleaned.kept_branches.push({ branch: b, reason: 'default branch unresolvable — cannot verify merged' });
      continue;
    }
    const merged = mergedInto(git, repoRoot, b, def);
    if (merged !== true) {
      if (opts.force && merged === false && /^worktree-/.test(b)) {
        const del = git(['branch', '-D', b], repoRoot);
        if (del.code === 0) cleaned.force_deleted_branches.push(b);
        else
          cleaned.kept_branches.push({
            branch: b,
            reason: `git branch -D refused: ${(del.stderr || del.stdout).trim()}`,
          });
        continue;
      }
      cleaned.kept_branches.push({ branch: b, reason: `not merged into ${def.name} (${squashNote})` });
      continue;
    }
    const del = git(['branch', '-d', b], repoRoot);
    if (del.code === 0) cleaned.deleted_branches.push(b);
    else
      cleaned.kept_branches.push({
        branch: b,
        reason: `git branch -d refused: ${(del.stderr || del.stdout).trim()}`,
      });
  }

  return cleaned;
}

/** The superproject's in-repository clean. The return type omits three fields
 *  of `GcCleaned` rather than one: `submodules` is the per-submodule pass, and
 *  `reaped_slots`/`kept_slots` are the slot-root pass (a8) — a separate sweep
 *  over paths OUTSIDE the repository that `runGc` runs BEFORE this one, so the
 *  freed `worktree-*` branches reach the branch policy below. */
export function gcClean(
  git: GitRunner,
  root: string,
  def: { name: string; ref: string } | null,
  opts?: { force?: boolean; protectedPaths?: string[] },
): Omit<GcCleaned, 'submodules' | 'reaped_slots' | 'kept_slots'> {
  return cleanRepo(git, root, def, {
    wtDir: join(root, '.claude', 'worktrees'),
    force: opts?.force ?? false,
    sweepStaleDirs: true,
    protectedPaths: opts?.protectedPaths ?? [],
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function mergedTag(m: boolean | null): string {
  return m === true ? 'merged' : m === false ? 'unmerged' : 'unknown';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function subHasFindings(s: GcSubmoduleReport): boolean {
  return s.worktrees.length > 0 || s.prunable.length > 0 || s.branches.length > 0;
}

function humanReport(
  report: GcReport,
  root: string,
  opts: { submodulesScanned: boolean; force: boolean },
): string {
  const out: string[] = [];
  out.push(`pipeline gc — ${root}`);
  out.push(`default branch: ${report.default_branch ?? '(unresolvable — merged checks read unknown)'}`);

  if (report.worktrees.length) {
    out.push(`registered worktrees under .claude/worktrees (${report.worktrees.length}):`);
    for (const w of report.worktrees)
      out.push(`  ${mergedTag(w.merged).padEnd(8)}  ${w.path}  [${w.branch ?? 'detached'}]`);
  }
  if (report.stale_dirs.length) {
    out.push(`stale directories (not registered as worktrees) (${report.stale_dirs.length}):`);
    for (const d of report.stale_dirs) out.push(`  ${d}`);
  }
  if (report.prunable.length) {
    out.push(`prunable worktree records (${report.prunable.length}):`);
    for (const l of report.prunable) out.push(`  ${l}`);
  }
  if (report.branches.length) {
    out.push(
      `orphaned worktree-* branches (${report.branches.length}) — squash-merged branches read as "unmerged"; report-only, never auto-deleted:`,
    );
    for (const b of report.branches) out.push(`  ${mergedTag(b.merged).padEnd(8)}  ${b.branch}`);
  }

  // The slot scan (a8 + a12). Printed only when it found something — otherwise
  // every report in every repository would grow a line about a directory that
  // does not exist.
  if (report.builtin_slots.length) {
    const orphans = report.builtin_slots.filter((s) => s.orphaned).length;
    const fromRegistry = report.builtin_slots.filter((s) => s.source === 'registry').length;
    out.push(
      `built-in worktree slots under ${report.slot_root}, plus every slot the registry names ` +
        `(${report.builtin_slots.length}, ${fromRegistry} from the registry, ${orphans} orphaned):`,
    );
    for (const s of report.builtin_slots) {
      const tag = s.source === 'registry' ? '  [registry]' : '';
      out.push(`  ${(s.orphaned ? 'orphaned' : 'kept').padEnd(8)}  ${s.path}${tag}`);
      out.push(`            ${s.reason}`);
      // The submodule directories, when a12's resolution found any: they are
      // where a dispatched worker's commits actually are, and an operator
      // deciding what to do with the parent has to be able to see them.
      for (const sub of s.submodule_slots) {
        out.push(`            submodule ${sub.path}: ${sub.dir} (${sub.source}, ${sub.exists ? 'on disk' : 'gone'})`);
      }
    }
  }

  // Per-submodule sections — only submodules WITH findings get a section; the
  // one-line total appears whenever the project actually has submodules.
  if (opts.submodulesScanned) {
    for (const s of report.submodules) {
      if (!subHasFindings(s)) continue;
      out.push(`submodule ${s.path} (default branch: ${s.default_branch ?? 'unresolvable'}):`);
      if (s.worktrees.length) {
        out.push(`  registered worktrees under .claude/worktrees (${s.worktrees.length}):`);
        for (const w of s.worktrees)
          out.push(`    ${mergedTag(w.merged).padEnd(8)}  ${w.path}  [${w.branch ?? 'detached'}]`);
      }
      if (s.prunable.length) {
        out.push(`  prunable worktree records (${s.prunable.length}):`);
        for (const l of s.prunable) out.push(`    ${l}`);
      }
      if (s.branches.length) {
        out.push(`  orphaned worktree-* branches (${s.branches.length}):`);
        for (const b of s.branches) out.push(`    ${mergedTag(b.merged).padEnd(8)}  ${b.branch}`);
      }
    }
    if (report.submodules.length || report.submodules_skipped) {
      const leaked = report.submodules.reduce((n, s) => n + s.branches.length, 0);
      const withLeaks = report.submodules.filter((s) => s.branches.length > 0).length;
      const skipped = report.submodules_skipped
        ? `; skipped ${report.submodules_skipped} uninitialized`
        : '';
      out.push(
        `submodules: ${leaked} leaked ${leaked === 1 ? 'branch' : 'branches'} across ${plural(withLeaks, 'submodule')} (${report.submodules.length} scanned${skipped})`,
      );
    }
  }

  if (
    !report.worktrees.length &&
    !report.stale_dirs.length &&
    !report.prunable.length &&
    !report.branches.length &&
    !report.submodules.some(subHasFindings) &&
    !report.builtin_slots.some((s) => s.orphaned)
  ) {
    // QUALIFIED when the slot scan reported slots gc will not act on (a12). P-5
    // is the finding that a clean gc report was read as "nothing leaked"; a bare
    // "no leaks detected" printed directly beneath a hook-provisioned slot this
    // command has just said it cannot reap invites exactly that reading again.
    // The leading phrase is unchanged — this qualifies the sentence, it does not
    // replace it.
    const reported = report.builtin_slots.length;
    out.push(
      reported === 0
        ? 'no leaks detected'
        : `no leaks detected — but ${plural(reported, 'slot')} above ${reported === 1 ? 'is' : 'are'} reported and left to ${reported === 1 ? 'its' : 'their'} owner: read the reasons before concluding nothing leaked`,
    );
  }

  const c = report.cleaned;
  if (c) {
    out.push('--clean results:');
    out.push(`  pruned records: ${c.pruned.length}`);
    out.push(`  removed worktrees: ${c.removed_worktrees.length}`);
    for (const p of c.removed_worktrees) out.push(`    ${p}`);
    out.push(`  removed stale dirs: ${c.removed_dirs.length}`);
    for (const p of c.removed_dirs) out.push(`    ${p}`);
    out.push(`  reaped built-in slots: ${c.reaped_slots.length}`);
    for (const s of c.reaped_slots) {
      // `record-only` is spelled out: "reaped" must never let an operator think
      // a hook's directories were deleted when nothing on disk was touched.
      const how = s.reaped_by === 'record-only' ? ', stale registry row only — nothing on disk touched' : '';
      out.push(
        `    ${s.path} (${plural(s.removed_worktrees.length, 'worktree')}, ${plural(s.released_ports, 'port')} released${s.removed_record ? ', slot record dropped' : ''}${how})`,
      );
    }
    out.push(`  deleted branches (git branch -d): ${c.deleted_branches.length}`);
    for (const b of c.deleted_branches) out.push(`    ${b}`);
    if (opts.force || c.force_deleted_branches.length) {
      out.push(
        `  force-deleted unmerged worktree-* branches (git branch -D): ${c.force_deleted_branches.length}`,
      );
      for (const b of c.force_deleted_branches) out.push(`    ${b}`);
    }
    if (c.kept_worktrees.length) {
      out.push(`  kept worktrees (${c.kept_worktrees.length}):`);
      for (const k of c.kept_worktrees) out.push(`    ${k.path} — ${k.reason}`);
    }
    if (c.kept_branches.length) {
      out.push(`  kept branches (${c.kept_branches.length}):`);
      for (const k of c.kept_branches) out.push(`    ${k.branch} — ${k.reason}`);
    }
    if (c.kept_slots.length) {
      out.push(`  kept built-in slots (${c.kept_slots.length}):`);
      for (const k of c.kept_slots) out.push(`    ${k.path} — ${k.reason}`);
    }
    for (const s of c.submodules) {
      const active =
        s.pruned.length ||
        s.removed_worktrees.length ||
        s.deleted_branches.length ||
        s.force_deleted_branches.length ||
        s.kept_worktrees.length ||
        s.kept_branches.length;
      if (!active) continue;
      out.push(`  submodule ${s.path}:`);
      out.push(`    pruned records: ${s.pruned.length}`);
      out.push(`    removed worktrees: ${s.removed_worktrees.length}`);
      for (const p of s.removed_worktrees) out.push(`      ${p}`);
      out.push(`    deleted branches (git branch -d): ${s.deleted_branches.length}`);
      for (const b of s.deleted_branches) out.push(`      ${b}`);
      if (opts.force || s.force_deleted_branches.length) {
        out.push(
          `    force-deleted unmerged worktree-* branches (git branch -D): ${s.force_deleted_branches.length}`,
        );
        for (const b of s.force_deleted_branches) out.push(`      ${b}`);
      }
      if (s.kept_worktrees.length) {
        out.push(`    kept worktrees (${s.kept_worktrees.length}):`);
        for (const k of s.kept_worktrees) out.push(`      ${k.path} — ${k.reason}`);
      }
      if (s.kept_branches.length) {
        out.push(`    kept branches (${s.kept_branches.length}):`);
        for (const k of s.kept_branches) out.push(`      ${k.branch} — ${k.reason}`);
      }
    }
    if (
      !c.kept_worktrees.length &&
      !c.kept_branches.length &&
      !c.kept_slots.length &&
      !c.submodules.some((s) => s.kept_worktrees.length || s.kept_branches.length)
    )
      out.push('  nothing kept back');
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export function runGc(args: string[], git: GitRunner = realGit): number {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const parsed = parseGcArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`pipeline gc: ${parsed.error}\n${USAGE}`);
    return 2;
  }

  let root = resolve(parsed.project ?? process.cwd());
  try {
    root = realpathSync(root);
  } catch {
    // keep the resolved path; isGitRepo below reports the real problem
  }
  if (!isGitRepo(git, root)) {
    process.stderr.write(`pipeline gc: not a git repository: ${root}\n`);
    return 2;
  }
  // realpathSync doesn't reliably expand Windows 8.3 short-name path segments
  // (e.g. a CI runner whose profile resolves to `RUNNER~1` while every other
  // API reports `runneradmin`) — git's OWN path resolution always does, and
  // `git worktree list --porcelain` (iterWorktrees, below) prints that long
  // canonical form. Re-anchor root on git's view so `wtDir`-prefix comparisons
  // (isUnder) match what iterWorktrees reports instead of silently missing
  // every registered worktree. Falls back to the realpathSync'd value when git
  // can't answer (defensive; isGitRepo above already confirmed root is a repo).
  const topLevel = git(['rev-parse', '--show-toplevel'], root);
  if (topLevel.code === 0 && topLevel.stdout.trim()) {
    const tl = topLevel.stdout.trim();
    root = process.platform === 'win32' ? tl.replace(/\//g, '\\') : tl;
  }

  const wtDir = join(root, '.claude', 'worktrees');
  const def = resolveDefaultBranch(git, root);

  // Scan initialized submodules first: their registered worktree paths protect
  // the superproject's stale-dir logic from treating a live submodule worktree
  // checkout under .claude/worktrees as deletable debris.
  const subs = parsed.submodules ? listSubmodules(git, root) : { initialized: [], skipped: 0 };
  const subDefs = new Map<string, { name: string; ref: string } | null>();
  const submodules: GcSubmoduleReport[] = subs.initialized.map((rel) => {
    const subRoot = join(root, rel);
    const subDef = resolveDefaultBranch(git, subRoot);
    subDefs.set(rel, subDef);
    const scan = scanRepo(git, subRoot, wtDir, subDef);
    return {
      path: rel,
      default_branch: subDef?.name ?? null,
      branches: scan.branches,
      worktrees: scan.worktrees,
      prunable: scan.prunable,
    };
  });
  const protectedPaths = submodules.flatMap((s) => s.worktrees.map((w) => w.path));

  // The built-in slot root (a8) AND the slot registry (a12) — read-only, and
  // outside the repository, which is exactly why nothing else looks there. The
  // root is taken from slotRootFor(), never re-derived, so the janitor and the
  // provisioner cannot disagree; the registry is read through the same
  // `listSlots` the `worktree` command group writes with, and its slots'
  // submodule directories through a11's own resolution.
  //
  // The declared submodules are resolved for this pass EVEN UNDER
  // `--no-submodules`, and that is deliberate: the provisioner cuts one
  // worktree per submodule BESIDE the parent slot, so without the list a
  // `<name>--<submodule>` directory would read as a slot of its own and be
  // reaped from the superproject, which does not own it. `--no-submodules`
  // switches off the per-submodule BRANCH/registration sweep; it cannot switch
  // off half of a slot's shape, because a slot is reaped whole or not at all.
  const slotRoot = slotRootFor(root);
  const slotSubs = parsed.submodules ? subs.initialized : listSubmodules(git, root).initialized;
  const slotCandidates = scanSlots(root, slotRoot, slotSubs);

  // Snapshot the report FIRST so --clean output shows what was found, then act.
  const report: GcReport = {
    ...gcReport(git, root, def, protectedPaths),
    submodules,
    submodules_skipped: subs.skipped,
    slot_root: slotRoot,
    builtin_slots: slotCandidates.map(toGcSlot),
    cleaned: null,
  };

  if (parsed.clean) {
    // Reap orphaned built-in slots FIRST, before either branch sweep: removing
    // a slot's worktree DETACHES its `worktree-<name>` branch, and the sweeps
    // below are what then apply this command's own branch policy to it (safe
    // delete when merged, kept with a reason when not). Reaping afterwards
    // would leave every freed branch for the next invocation.
    const slotClean = reapSlots(git, root, slotRoot, slotCandidates, slotSubs);

    // Clean submodules BEFORE the superproject: a merged leaked submodule
    // worktree is removed via `git worktree remove` (dir + record together),
    // and only worktrees still registered AFTER that pass are protected from
    // the superproject's stale-dir sweep.
    const subCleans: GcSubmoduleCleaned[] = subs.initialized.map((rel) => {
      const subRoot = join(root, rel);
      const core = cleanRepo(git, subRoot, subDefs.get(rel) ?? null, {
        wtDir,
        force: parsed.forceWorktreeBranches,
        sweepStaleDirs: false,
        protectedPaths: [],
      });
      return {
        path: rel,
        pruned: core.pruned,
        removed_worktrees: core.removed_worktrees,
        kept_worktrees: core.kept_worktrees,
        deleted_branches: core.deleted_branches,
        force_deleted_branches: core.force_deleted_branches,
        kept_branches: core.kept_branches,
      };
    });
    const stillProtected = subs.initialized.flatMap((rel) =>
      iterWorktrees(git, join(root, rel))
        .map((w) => w.path)
        .filter((p) => isUnder(p, wtDir)),
    );
    report.cleaned = {
      ...gcClean(git, root, def, {
        force: parsed.forceWorktreeBranches,
        protectedPaths: stillProtected,
      }),
      submodules: subCleans,
      reaped_slots: slotClean.reaped,
      kept_slots: slotClean.kept,
    };
  }

  if (parsed.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else
    process.stdout.write(
      humanReport(report, root, {
        submodulesScanned: parsed.submodules,
        force: parsed.forceWorktreeBranches,
      }),
    );
  return 0;
}
