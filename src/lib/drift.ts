// Submodule-pointer drift classification + the bump guards, ported from the
// consumer project's tested `_lib/submodule_drift.py` and extended with the
// fork-diff / conflict guards from `worktree-destroy.py`'s `_detect_pipeline_edits`
// (the #132-revert fix), applied to POINTERS instead of files.
//
// For each candidate submodule the resolver computes three pointer values,
// relative to the ref the bump LANDS ONTO (`origin/<base>`):
//   - base_ptr : the gitlink recorded at origin/<base> (what we'd change FROM).
//   - run_sha  : the run's intended pointer (its source-worktree submodule HEAD,
//                or — with no source worktree — the live drifted checkout HEAD).
//   - fork_ptr : the gitlink recorded at the run's FORK POINT
//                (merge-base(origin/<base>, run-ref)). This is what distinguishes
//                "the run genuinely changed this pointer" from "the pointer merely
//                differs because base advanced past the run's fork".
//
// Guards, in order (each maps to one of the incidents that ARE the spec):
//   unchanged-by-run   run_sha == fork_ptr → the run did not move this pointer;
//                      any diff vs base is base's own advance. #132 guard: NEVER
//                      land the run's stale value (would revert base). SKIP.
//   base-advanced      base_ptr != fork_ptr (base moved the pointer since the
//                      fork) and run_sha != base_ptr → CONFLICT; don't clobber
//                      base's concurrent bump. SKIP + surface.
//   unreachable        run_sha is NOT reachable from the submodule's
//                      origin/<default> (local WIP / detached / force-pushed
//                      away). SKIP.
//   diverged-or-behind base_ptr is not an ancestor of run_sha (the bump would
//                      move the pointer sideways/backward). SKIP.
//   dirty              (source-worktree/drift checkout is dirty) SKIP a WIP HEAD.
//   in-sync            run_sha == base_ptr → nothing to bump (silent).
//   ahead-reachable    else → BUMPABLE: record base_ptr → run_sha.

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  type GitRunner,
  detectDefaultBranch,
  gitlinkAt,
  submoduleHead,
  isDirty,
  isAncestor,
  revParse,
  mergeBase,
  gitmodulesPaths,
} from './git';

export type DriftStatus =
  | 'not-a-gitlink'
  | 'uninitialized'
  | 'no-head'
  | 'in-sync'
  | 'unchanged-by-run'
  | 'base-advanced-conflict'
  | 'dirty'
  | 'no-default-branch'
  | 'unreachable'
  | 'diverged-or-behind'
  | 'ahead-reachable';

export interface DriftEntry {
  path: string;
  status: DriftStatus;
  base?: string | null; // gitlink at origin/<base> (the FROM value)
  run?: string | null; // the run's intended pointer
  fork?: string | null; // gitlink at the run's fork point
  defaultBranch?: string | null;
  reason?: string | null;
}

export function isBumpable(e: DriftEntry): boolean {
  return e.status === 'ahead-reachable' && !!e.base && !!e.run;
}

export interface ClassifyOptions {
  /** The base ref the bump lands onto (default `main`). */
  baseBranch?: string;
  /** Where the merged submodule state lives (optional). When absent, the run's
   *  intended pointer is the live drifted checkout HEAD under the superproject. */
  sourceWorktree?: string;
  /** Read-only `git fetch origin <default>` in the submodule before the
   *  reachability check (default true; tests pass false to stay offline). */
  doFetch?: boolean;
}

/** Classify one submodule's pointer drift + apply the bump guards. Read-only
 *  except for an optional fetch inside the submodule. */
export function classifyDrift(git: GitRunner, root: string, path: string, opts: ClassifyOptions = {}): DriftEntry {
  const baseBranch = opts.baseBranch ?? 'main';
  const baseRef = `origin/${baseBranch}`;

  const base = gitlinkAt(git, root, baseRef, path);
  if (base === null) {
    // Not a gitlink at the landing ref (regular file / absent / ref unknown).
    return { path, status: 'not-a-gitlink', base: null };
  }

  // Resolve the run's INTENDED pointer (`runSha`).
  //   - source-worktree mode, submodule populated → the worktree's submodule
  //     checkout HEAD (drift produced inside the run's worktree);
  //   - source-worktree mode, submodule NOT populated → the gitlink the
  //     worktree's HEAD RECORDS (what the run's branch would land);
  //   - drift mode (no source worktree) → the superproject's live checkout HEAD.
  const canonicalSub = join(root, path);
  let runSha: string | null = null;
  let dirtyCheckDir: string | null = null;
  if (opts.sourceWorktree) {
    const wtSub = join(opts.sourceWorktree, path);
    if (existsSync(join(wtSub, '.git'))) {
      runSha = submoduleHead(git, wtSub);
      dirtyCheckDir = wtSub;
    } else {
      const wtHead = revParse(git, opts.sourceWorktree, 'HEAD');
      runSha = wtHead ? gitlinkAt(git, root, wtHead, path) : null;
    }
  } else {
    if (!existsSync(join(canonicalSub, '.git'))) {
      return { path, status: 'uninitialized', base, reason: `submodule checkout not present at ${canonicalSub}` };
    }
    runSha = submoduleHead(git, canonicalSub);
    dirtyCheckDir = canonicalSub;
  }
  if (runSha === null) {
    return { path, status: 'no-head', base, reason: "could not resolve the run's intended pointer" };
  }

  // The run's fork point relative to the landing ref, and the pointer recorded
  // there. Computed in the SUPERPROJECT (the source worktree shares its object
  // store, so its HEAD is resolvable from `root`).
  let forkPtr: string | null = null;
  const runRefRepo = opts.sourceWorktree ?? root;
  const runHead = revParse(git, runRefRepo, 'HEAD');
  if (runHead) {
    const fork = mergeBase(git, root, baseRef, runHead);
    if (fork) forkPtr = gitlinkAt(git, root, fork, path);
  }

  // ---- #132 guard: the run did NOT move this pointer → never revert base. ----
  if (forkPtr !== null && runSha === forkPtr) {
    if (runSha === base) return { path, status: 'in-sync', base, run: runSha, fork: forkPtr };
    return {
      path,
      status: 'unchanged-by-run',
      base,
      run: runSha,
      fork: forkPtr,
      reason:
        `the run did not change this pointer (run==fork ${runSha.slice(0, 12)}); the difference vs ${baseRef} ` +
        `is base's own advance — refusing to land the run's stale value (would revert base)`,
    };
  }

  // ---- Conflict guard: base advanced the pointer since the run's fork. ----
  if (forkPtr !== null && base !== forkPtr && runSha !== base) {
    return {
      path,
      status: 'base-advanced-conflict',
      base,
      run: runSha,
      fork: forkPtr,
      reason:
        `${baseRef} changed this pointer since the run's fork (fork ${forkPtr.slice(0, 12)} → base ` +
        `${base.slice(0, 12)}); not clobbering base's concurrent bump`,
    };
  }

  // Already at the landing value → nothing to bump.
  if (runSha === base) return { path, status: 'in-sync', base, run: runSha, fork: forkPtr };

  // WIP guard: refuse to bump to a dirty live checkout HEAD (only when we read
  // the pointer from a live checkout; a recorded gitlink is inherently clean).
  if (dirtyCheckDir && isDirty(git, dirtyCheckDir)) {
    return {
      path,
      status: 'dirty',
      base,
      run: runSha,
      fork: forkPtr,
      reason: 'submodule working tree is dirty; refusing to bump a WIP HEAD',
    };
  }

  // Reachability + strictly-ahead, evaluated in the canonical submodule repo
  // (present in the superproject; shares the object store with the worktree).
  if (!existsSync(join(canonicalSub, '.git'))) {
    return {
      path,
      status: 'uninitialized',
      base,
      run: runSha,
      fork: forkPtr,
      reason: `cannot verify reachability: submodule checkout not present at ${canonicalSub}`,
    };
  }
  const def = detectDefaultBranch(git, canonicalSub);
  if (def === null) {
    return {
      path,
      status: 'no-default-branch',
      base,
      run: runSha,
      fork: forkPtr,
      reason: 'could not resolve the submodule default branch (offline / no origin / unknown)',
    };
  }
  if (opts.doFetch ?? true) git(['fetch', 'origin', def], canonicalSub);

  const ref = `origin/${def}`;
  if (!isAncestor(git, canonicalSub, runSha, ref)) {
    return {
      path,
      status: 'unreachable',
      base,
      run: runSha,
      fork: forkPtr,
      defaultBranch: def,
      reason: `${runSha.slice(0, 12)} is not reachable from ${ref} (local WIP / detached / force-pushed-away)`,
    };
  }
  if (!isAncestor(git, canonicalSub, base, runSha)) {
    return {
      path,
      status: 'diverged-or-behind',
      base,
      run: runSha,
      fork: forkPtr,
      defaultBranch: def,
      reason:
        `${runSha.slice(0, 12)} is not strictly ahead of the recorded pointer ${base.slice(0, 12)} ` +
        `(would move the pointer sideways/backward)`,
    };
  }

  return { path, status: 'ahead-reachable', base, run: runSha, fork: forkPtr, defaultBranch: def };
}

export function classifyAll(git: GitRunner, root: string, paths: string[], opts: ClassifyOptions = {}): DriftEntry[] {
  return paths.map((p) => classifyDrift(git, root, p, opts));
}

/** Resolve the candidate submodule paths: the explicit subset, or all declared
 *  in `<root>/.gitmodules`. */
export function resolveSubmodulePaths(
  git: GitRunner,
  root: string,
  explicit: string[] | undefined,
  gitmodulesFile: string,
): string[] {
  if (explicit && explicit.length) return explicit;
  return gitmodulesPaths(git, root, gitmodulesFile);
}

/** Build `(commitMessage, prTitle, prBody)` for a batch of bumps. */
export function buildBumpMessage(entries: DriftEntry[]): { commitMessage: string; prTitle: string; prBody: string } {
  const short = (s: string | null | undefined) => (s || '').slice(0, 7);
  let subject: string;
  if (entries.length === 1) {
    subject = `chore(submodule): bump ${entries[0].path} to ${short(entries[0].run)}`;
  } else {
    subject = `chore(submodule): bump ${entries.length} drifted pointer(s)`;
  }
  const bullets = entries
    .map((e) => `- ${e.path}: ${short(e.base)} -> ${short(e.run)} (reachable from origin/${e.defaultBranch})`)
    .join('\n');
  const body =
    'Auto-bump of submodule pointer(s) verified reachable from each submodule\'s default branch.\n\n' + bullets;
  return { commitMessage: `${subject}\n\n${body}`, prTitle: subject, prBody: body };
}
