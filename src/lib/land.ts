// Isolation-safe primitive: land a set of submodule-pointer bumps onto a shared
// superproject's base branch via a PR — WITHOUT ever branch-switching or
// resetting the shared checkout. TypeScript port of the consumer project's
// tested `_lib/land_to_main.py`.
//
// The shared checkout is contended by concurrent runs/agents, so a
// `git checkout`/`checkout -b`/`reset` there would corrupt every parallel
// worktree. The ONLY shared-checkout mutation this primitive performs is
// `git fetch` + `git merge --ff-only` (Step 6). All branch/commit work happens
// in a THROWAWAY worktree off `origin/<base>`.
//
// Algorithm (see land_to_main.py's module docstring for the full rationale):
//   0. Pre-flight self-clean — reap orphaned `land-*` throwaway worktrees +
//      stale scratch branches from prior KILLED runs (owner-pid dead). Makes the
//      primitive idempotent under a mid-run SIGKILL; correctness never depends on
//      a `finally`.
//   1. fetch origin <base> (read-only wrt the shared working tree), retrying a
//      transient ref-update race with --prune.
//   2. Create a throwaway worktree off origin/<base> on a collision-proof branch.
//   3. Stage each gitlink surgically via `update-index --cacheinfo 160000,...`.
//   4. Commit → push -u origin <branch>.
//   5. gh pr create → gh pr merge --squash --delete-branch (--admin fallback).
//   6. Reconcile the shared checkout NON-branch-switchingly with a BOUNDED RETRY:
//      loop fetch + merge --ff-only until HEAD contains the authoritative merge
//      commit (immune to a premature "Already up to date" / propagation lag).
//      NEVER checkout/reset/force. Exhaustion ⇒ halt (the PR already landed on
//      origin; local base catches up on the operator's next ff).
//   7. Remove the throwaway worktree (+ prune + delete branch) — best-effort.
//
// `dryRun` performs steps 1–3 + a local commit, captures the diff, then STOPS
// before push/PR/merge/reconcile.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GitRunner,
  type GhRunner,
  type GitResult,
  currentBranch,
  branchExists,
  iterWorktrees,
  isAncestor,
  revParse,
  pidAlive,
  sleepSync,
} from './git';

const GITLINK_MODE = '160000';

// Reconcile-retry tuning (Step 6) — the shared checkout is contended and
// origin/<base> lags `gh pr merge` returning, so the reconcile CANNOT be a
// single no-retry attempt. These are the defaults; tests inject 0 backoff.
export const RECONCILE_ATTEMPTS = 6;
export const RECONCILE_SLEEP_BASE_MS = 2000;
export const RECONCILE_SLEEP_CAP_MS = 30000;
export const MERGE_SHA_LOOKUP_ATTEMPTS = 3;
export const FETCH_ATTEMPTS = 4;

// Throwaway-worktree identity + kill-safety. Every throwaway parent dir is named
// `land-*` with a single `wt` leaf worktree and a `.land-owner.pid` liveness
// file written BEFORE `git worktree add` registers the worktree. The pre-flight
// self-clean reaps ONLY dead orphans (never a live concurrent run's worktree).
const THROWAWAY_PARENT_PREFIX = 'land-';
const THROWAWAY_LEAF = 'wt';
const OWNER_PID_FILE = '.land-owner.pid';

// Substrings marking a TRANSIENT ref-update race on `git fetch origin <base>`
// (a concurrent flow racing refs/remotes/origin/<base>). Retried with --prune;
// a genuine network/auth failure is NOT in this set and halts immediately.
const FETCH_REF_RACE_MARKERS = [
  'incorrect old value',
  'cannot lock ref',
  'unable to update local ref',
  'failed to lock',
  'failed to update ref',
  'reference already exists',
];

export interface GitlinkChange {
  /** Submodule directory relative to the superproject root. */
  path: string;
  /** FULL 40-hex commit sha to record (update-index rejects abbreviated). */
  newSha: string;
}

export type LandStatus = 'committed' | 'noop' | 'dry-run' | 'halted';
export type ReconcileStatus = 'ff' | 'skipped' | 'failed' | 'na';

export interface LandResult {
  status: LandStatus;
  branch: string | null;
  commitSha: string | null;
  prRef: string | null;
  infraBumpSha: string | null;
  mergeSha: string | null;
  reconcileStatus: ReconcileStatus;
  mergedViaAdmin: boolean;
  plannedActions: string[];
  diff: string | null;
  haltReason: string | null;
  stderr: string | null;
}

export interface LandOptions {
  gitlinkChanges: GitlinkChange[];
  commitMessage: string;
  branchName: string;
  prTitle: string;
  prBody: string;
  baseBranch?: string;
  dryRun?: boolean;
  /** Parent dir for the throwaway worktree (default: a fresh OS temp dir). */
  worktreesDir?: string;
  adminFallback?: boolean;
  uniqueBranch?: boolean;
  reconcileAttempts?: number;
  reconcileSleepBaseMs?: number;
  mergeShaLookupAttempts?: number;
  /** Injected git runner (default: realGit). Tests wrap it for the isolation
   *  assertion + transient-failure injection. */
  git: GitRunner;
  /** Injected gh runner (default: realGh). Tests simulate PR create/merge. */
  gh: GhRunner;
}

function reconcileDelay(baseMs: number, attempt: number): number {
  return Math.min(baseMs * attempt, RECONCILE_SLEEP_CAP_MS);
}

function isRefRace(stderr: string): boolean {
  const low = (stderr || '').toLowerCase();
  return FETCH_REF_RACE_MARKERS.some((m) => low.includes(m));
}

function log(msg: string): void {
  process.stderr.write(`[land] ${msg}\n`);
}

function uniqueBranchName(base: string): string {
  return `${base}-${randomBytes(4).toString('hex')}`;
}

function isThrowaway(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const leaf = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  return leaf === THROWAWAY_LEAF && !!parent && parent.startsWith(THROWAWAY_PARENT_PREFIX);
}

/** True iff `parentDir`'s owner-pid file names a LIVE process. A missing /
 *  unreadable pid file reads as DEAD (a live run writes its pid BEFORE
 *  `git worktree add`, so any registered throwaway with no live pid is an
 *  orphan of a killed run). */
function ownerAlive(parentDir: string): boolean {
  try {
    const raw = readFileSync(join(parentDir, OWNER_PID_FILE), 'utf8');
    const pid = parseInt((raw || '').trim() || '0', 10);
    return pidAlive(pid);
  } catch {
    return false;
  }
}

/** Collision-proof scratch branch name — never == baseBranch (so `worktree add`
 *  can't die with "'<base>' is already used"), uuid-regenerated on an existing
 *  ref clash. */
function freshBranch(git: GitRunner, root: string, branchName: string, baseBranch: string, unique: boolean): string {
  if (!unique) {
    if (branchName === baseBranch) {
      throw new Error(
        `branchName '${branchName}' equals baseBranch '${baseBranch}'; refusing to create a throwaway worktree on the base branch`,
      );
    }
    return branchName;
  }
  let candidate = uniqueBranchName(branchName);
  for (let i = 0; i < 8; i++) {
    if (candidate !== baseBranch && !branchExists(git, root, candidate)) break;
    candidate = uniqueBranchName(branchName);
  }
  return candidate;
}

/** Reap orphaned throwaway worktrees / scratch branches from prior KILLED runs.
 *  Concurrency-safe (dead-owner-pid only; `git branch -D` refuses a live
 *  worktree's branch). Only .git admin data + refs are mutated. */
function preflightSelfclean(git: GitRunner, root: string, branchName: string, unique: boolean): void {
  git(['worktree', 'prune'], root);
  const cleanedParents: string[] = [];
  for (const { path } of iterWorktrees(git, root)) {
    if (!isThrowaway(path)) continue;
    const parent = join(path, '..');
    if (ownerAlive(parent)) continue; // LIVE concurrent run — never touch it
    const rm = git(['worktree', 'remove', '--force', path], root);
    if (rm.code === 0) log(`preflight: reaped orphaned throwaway worktree ${path}`);
    else log(`preflight: worktree remove ${path} failed (${rm.stderr.trim()})`);
    cleanedParents.push(parent);
  }
  git(['worktree', 'prune'], root);
  const patterns = [`${branchName}-*`];
  if (!unique) patterns.push(branchName);
  const seen = new Set<string>();
  for (const pat of patterns) {
    const r = git(['branch', '--list', pat], root);
    if (r.code !== 0) continue;
    for (const raw of r.stdout.split(/\r?\n/)) {
      const name = raw.replace(/^[*+ ]+/, '').trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        git(['branch', '-D', name], root);
      }
    }
  }
  for (const parent of cleanedParents) {
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Fetch origin/<base> read-only, retrying ONLY a transient ref race. */
function fetchBaseWithRetry(git: GitRunner, root: string, base: string, attempts: number, sleepBaseMs: number): GitResult {
  let proc = git(['fetch', 'origin', base], root);
  if (proc.code === 0 || !isRefRace(proc.stderr)) return proc;
  for (let attempt = 1; attempt < Math.max(1, attempts); attempt++) {
    sleepSync(reconcileDelay(sleepBaseMs, attempt));
    proc = git(['fetch', '--prune', 'origin', base], root);
    if (proc.code === 0 || !isRefRace(proc.stderr)) return proc;
  }
  return proc;
}

function emptyResult(branch: string | null): LandResult {
  return {
    status: 'halted',
    branch,
    commitSha: null,
    prRef: null,
    infraBumpSha: null,
    mergeSha: null,
    reconcileStatus: 'na',
    mergedViaAdmin: false,
    plannedActions: [],
    diff: null,
    haltReason: null,
    stderr: null,
  };
}

function removeWorktree(git: GitRunner, root: string, tmp: string, branch: string, tmpParent: string): void {
  const rm = git(['worktree', 'remove', '--force', tmp], root);
  if (rm.code !== 0) log(`WARN: worktree remove failed (${rm.stderr.trim()}); pruning anyway`);
  git(['worktree', 'prune'], root);
  git(['branch', '-D', branch], root);
  try {
    rmSync(tmpParent, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Land `gitlinkChanges` onto `baseBranch` via a PR. See the module header for the
 * algorithm + isolation guarantees. Returns a structured LandResult; never
 * throws for expected outcomes (env errors are the caller's responsibility to
 * pre-check).
 */
export function landToMain(root: string, opts: LandOptions): LandResult {
  const git = opts.git;
  const gh = opts.gh;
  const baseBranch = opts.baseBranch ?? 'main';
  const dryRun = opts.dryRun ?? false;
  const adminFallback = opts.adminFallback ?? true;
  const unique = opts.uniqueBranch ?? true;
  const reconcileAttempts = opts.reconcileAttempts ?? RECONCILE_ATTEMPTS;
  const sleepBaseMs = opts.reconcileSleepBaseMs ?? RECONCILE_SLEEP_BASE_MS;
  const mergeShaLookupAttempts = opts.mergeShaLookupAttempts ?? MERGE_SHA_LOOKUP_ATTEMPTS;

  // Pre-flight self-clean (skipped on dry-run — mutate nothing).
  if (!dryRun) preflightSelfclean(git, root, opts.branchName, unique);

  const branch = freshBranch(git, root, opts.branchName, baseBranch, unique);

  // ---- Step 1: fetch origin <base>. ----
  const fetch = fetchBaseWithRetry(git, root, baseBranch, FETCH_ATTEMPTS, sleepBaseMs);
  if (fetch.code !== 0) {
    const r = emptyResult(branch);
    r.haltReason = `git fetch origin ${baseBranch} failed in ${root}`;
    r.stderr = fetch.stderr.trim();
    return r;
  }

  // ---- Step 2: create the throwaway worktree off origin/<base>. ----
  let tmpParent: string;
  if (opts.worktreesDir) {
    mkdirSync(opts.worktreesDir, { recursive: true });
    tmpParent = mkdtempSync(join(opts.worktreesDir, THROWAWAY_PARENT_PREFIX));
  } else {
    tmpParent = mkdtempSync(join(tmpdir(), 'land-to-main-'));
  }
  const tmp = join(tmpParent, THROWAWAY_LEAF);

  // Liveness marker written BEFORE `git worktree add` registers the worktree.
  try {
    writeFileSync(join(tmpParent, OWNER_PID_FILE), String(process.pid), 'utf8');
  } catch {
    /* best-effort */
  }

  const add = git(['worktree', 'add', '-b', branch, tmp, `origin/${baseBranch}`], root);
  if (add.code !== 0) {
    try {
      rmSync(tmpParent, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    const r = emptyResult(branch);
    r.haltReason = `could not create throwaway worktree at ${tmp}`;
    r.stderr = add.stderr.trim();
    return r;
  }

  const result = emptyResult(branch);
  try {
    // ---- Step 3: stage each gitlink surgically. ----
    for (const gl of opts.gitlinkChanges) {
      const st = git(['update-index', '--cacheinfo', `${GITLINK_MODE},${gl.newSha},${gl.path}`], tmp);
      if (st.code !== 0) {
        result.haltReason = `git update-index --cacheinfo for ${gl.path} -> ${gl.newSha} failed: ${st.stderr.trim()}`;
        return result;
      }
    }

    // Nothing staged (every change a no-op) → noop, no empty commit.
    const staged = git(['diff', '--cached', '--quiet'], tmp);
    if (staged.code === 0) {
      result.status = 'noop';
      result.haltReason = null;
      result.reconcileStatus = 'na';
      return result;
    }

    // ---- Step 4a: commit the staged index. ----
    const commit = git(['commit', '-m', opts.commitMessage], tmp);
    if (commit.code !== 0) {
      result.haltReason = 'git commit failed in the throwaway worktree';
      result.stderr = commit.stderr.trim() || commit.stdout.trim();
      return result;
    }
    result.commitSha = revParse(git, tmp, 'HEAD');

    // ---- Dry-run: capture the diff and STOP. ----
    if (dryRun) {
      const show = git(['show', '--no-color', 'HEAD'], tmp);
      result.status = 'dry-run';
      result.haltReason = null;
      result.diff = show.stdout;
      result.plannedActions = [
        `git -C ${tmp} push -u origin ${branch}`,
        `gh pr create --base ${baseBranch} --head ${branch} --title ${JSON.stringify(opts.prTitle)}`,
        `gh pr merge <pr> --squash --delete-branch${adminFallback ? ' (with --admin fallback)' : ''}`,
        `git -C ${root} fetch origin ${baseBranch} && git -C ${root} merge --ff-only origin/${baseBranch}`,
      ];
      return result;
    }

    // ---- Step 4b: push the scratch branch. ----
    const push = git(['push', '-u', 'origin', branch], tmp);
    if (push.code !== 0) {
      result.haltReason = `could not push scratch branch '${branch}' to origin`;
      result.stderr = push.stderr.trim();
      return result;
    }

    // ---- Step 5: open the PR. ----
    const create = gh(
      ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', opts.prTitle, '--body', opts.prBody],
      tmp,
    );
    if (create.code !== 0) {
      result.haltReason = 'could not create the landing PR';
      result.stderr = create.stderr.trim();
      return result;
    }
    const prLines = create.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const prRef = prLines.length ? prLines[prLines.length - 1] : '';
    if (!prRef) {
      result.haltReason = 'gh pr create succeeded but printed no PR reference to parse';
      result.stderr = create.stderr.trim();
      return result;
    }
    result.prRef = prRef;

    // ---- Step 5b: merge the PR (squash + delete-branch), --admin fallback. ----
    const merge = gh(['pr', 'merge', prRef, '--squash', '--delete-branch'], tmp);
    if (merge.code !== 0) {
      if (!adminFallback) {
        result.haltReason = `could not merge the landing PR (${prRef})`;
        result.stderr = merge.stderr.trim();
        return result;
      }
      const mergeAdmin = gh(['pr', 'merge', prRef, '--squash', '--delete-branch', '--admin'], tmp);
      if (mergeAdmin.code !== 0) {
        result.haltReason = `could not merge the landing PR (${prRef})`;
        result.stderr = [merge.stderr.trim(), mergeAdmin.stderr.trim()].filter(Boolean).join('\n');
        return result;
      }
      result.mergedViaAdmin = true;
    }

    // ---- Step 5c: capture the AUTHORITATIVE merge commit sha. ----
    let mergeSha: string | null = null;
    for (let lookup = 1; lookup <= Math.max(1, mergeShaLookupAttempts); lookup++) {
      const view = gh(['pr', 'view', prRef, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'], tmp);
      if (view.code === 0) {
        const candidate = view.stdout.trim();
        if (candidate) {
          mergeSha = candidate;
          break;
        }
      }
      if (lookup < Math.max(1, mergeShaLookupAttempts)) sleepSync(reconcileDelay(sleepBaseMs, lookup));
    }
    result.mergeSha = mergeSha;

    // ---- Step 6: reconcile the shared checkout NON-branch-switchingly. ----
    const sharedBranch = currentBranch(git, root);
    if (sharedBranch !== baseBranch) {
      result.status = 'committed';
      result.reconcileStatus = 'skipped';
      log(
        `shared checkout on '${sharedBranch ?? '<DETACHED>'}' (not '${baseBranch}'); skipped the ff reconcile. ` +
          `The PR landed on origin/${baseBranch}; local ${baseBranch} catches up on the next fetch + merge --ff-only.`,
      );
      return result;
    }

    // ---- Step 6b: reconcile with a BOUNDED RETRY. ----
    let preHead: string | null = null;
    if (mergeSha === null) preHead = revParse(git, root, 'HEAD');

    const headReconciled = (): boolean => {
      if (mergeSha !== null) return isAncestor(git, root, mergeSha, 'HEAD');
      const head = revParse(git, root, 'HEAD');
      return !!head && head !== preHead;
    };

    let reconciled = false;
    let lastStderr = '';
    const attempts = Math.max(1, reconcileAttempts);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const refetch = git(['fetch', 'origin', baseBranch], root);
      if (refetch.code !== 0) {
        lastStderr = refetch.stderr.trim();
        if (attempt < attempts) sleepSync(reconcileDelay(sleepBaseMs, attempt));
        continue;
      }

      let originReady = true;
      if (mergeSha !== null) {
        originReady = isAncestor(git, root, mergeSha, `origin/${baseBranch}`);
      }

      if (originReady) {
        const ff = git(['merge', '--ff-only', `origin/${baseBranch}`], root);
        if (ff.code !== 0) lastStderr = ff.stderr.trim();
      }

      if (headReconciled()) {
        reconciled = true;
        break;
      }
      if (attempt < attempts) sleepSync(reconcileDelay(sleepBaseMs, attempt));
    }

    if (reconciled) {
      result.infraBumpSha = revParse(git, root, 'HEAD');
      result.status = 'committed';
      result.reconcileStatus = 'ff';
      result.haltReason = null;
      return result;
    }

    // ---- Exhausted: the PR ALREADY LANDED on origin. Surface a halt. ----
    result.status = 'halted';
    result.reconcileStatus = 'failed';
    result.haltReason =
      `the PR landed (${prRef}) on origin/${baseBranch} (pointers are correct on the remote) but the shared checkout ` +
      `could not be fast-forwarded to it within ${attempts} attempts (a concurrent flow's index.lock, a diverged local ` +
      `${baseBranch}, or a dirty gitlink blocking the ff). NOT forced — reconcile manually: ` +
      `git -C ${root} fetch origin ${baseBranch} && git -C ${root} merge --ff-only origin/${baseBranch}.`;
    result.stderr = lastStderr;
    return result;
  } finally {
    removeWorktree(git, root, tmp, branch, tmpParent);
  }
}
