// Shared real-git sandbox helpers for the submodule-*.test.ts shards.
//
// The `pipeline submodule bump` suite replays the incidents that ARE the spec
// (design §1) against genuine git repositories. It used to be ONE file taking
// ~500s — longer than every other test file COMBINED — so it is sharded into
// four files (drift / orphan / reconcile / modes) that the parallel runner
// (scripts/parallel-tests.ts) can overlap. Everything world-related lives here;
// each shard imports what it needs and registers `afterEach(cleanupCreated)`.
//
// No network + no real `gh`: the superproject has a LOCAL bare origin, and a
// FAKE gh runner simulates `pr create`/`merge`/`view` by fast-forwarding the
// bare origin's base ref to the pushed scratch commit (a real, ff-able
// advance). This exercises the full land → merge → reconcile path with real
// git objects.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realGit, type GitRunner, type GhRunner, type GitResult } from '../src/lib/git';
import { cleanupCreated, ident, mkTmp } from './_git-sandbox';

// Re-exported so the submodule-* shards import everything from ONE module.
export { cleanupCreated, ident, mkTmp };

// ---------------------------------------------------------------------------
// git setup helpers (use realGit directly; throw on failure so setup bugs are loud)
// ---------------------------------------------------------------------------

export function sh(args: string[], cwd?: string, check = true): GitResult {
  const r = realGit(args, cwd);
  if (check && r.code !== 0) {
    throw new Error(`git ${args.join(' ')} @ ${cwd ?? '.'} → ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

export function head(repo: string): string {
  return sh(['rev-parse', 'HEAD'], repo).stdout.trim();
}

export function recordedGitlink(repo: string, ref: string, path: string): string | null {
  const r = realGit(['ls-tree', ref, '--', path], repo);
  const m = /^160000 commit ([0-9a-f]{40})\t/.exec(r.stdout.trim());
  return m ? m[1] : null;
}

export interface World {
  base: string;
  subOrigin: string;
  subco: string; // superRoot/sub checkout
  superOrigin: string;
  superRoot: string;
  C1: string;
  C2: string;
  C3: string;
  P0: string;
}

/** A superproject (local bare origin + working clone) recording a gitlink to a
 *  fake submodule (its own local bare origin) at C1. The submodule has commits
 *  C1→C2→C3 on `main`. A committed `.gitmodules` enables auto-detect. */
export function makeWorld(): World {
  const base = mkTmp('bump-');
  // Submodule: bare origin + working clone with three linear commits.
  const subOrigin = join(base, 'sub.git');
  sh(['init', '--bare', '-b', 'main', subOrigin]);
  const subWork = join(base, 'subwork');
  sh(['clone', subOrigin, subWork]);
  ident(subWork);
  const commit = (content: string, msg: string): string => {
    writeFileSync(join(subWork, 'a.txt'), content);
    sh(['add', '.'], subWork);
    sh(['commit', '-m', msg], subWork);
    sh(['push', 'origin', 'main'], subWork);
    return head(subWork);
  };
  const C1 = commit('1', 'c1');
  const C2 = commit('2', 'c2');
  const C3 = commit('3', 'c3');

  // Superproject: bare origin + working clone; record the gitlink at C1.
  const superOrigin = join(base, 'super.git');
  sh(['init', '--bare', '-b', 'main', superOrigin]);
  const superRoot = join(base, 'super');
  sh(['clone', superOrigin, superRoot]);
  ident(superRoot);
  const subco = join(superRoot, 'sub');
  sh(['clone', subOrigin, subco]);
  ident(subco);
  sh(['checkout', '--detach', C1], subco);
  writeFileSync(join(superRoot, 'README.md'), 'readme');
  writeFileSync(
    join(superRoot, '.gitmodules'),
    `[submodule "sub"]\n\tpath = sub\n\turl = ${subOrigin.replace(/\\/g, '/')}\n`,
  );
  sh(['add', 'README.md', '.gitmodules'], superRoot);
  sh(['update-index', '--add', '--cacheinfo', `160000,${C1},sub`], superRoot);
  sh(['commit', '-m', 'init super'], superRoot);
  sh(['push', 'origin', 'main'], superRoot);
  const P0 = head(superRoot);

  return { base, subOrigin, subco, superOrigin, superRoot, C1, C2, C3, P0 };
}

/** Advance the superproject's `main` (and origin/main) by committing a gitlink
 *  bump — simulates the base branch moving forward concurrently. */
export function advanceBase(w: World, newSha: string): string {
  sh(['update-index', '--cacheinfo', `160000,${newSha},sub`], w.superRoot);
  sh(['commit', '-m', `bump sub to ${newSha.slice(0, 7)}`], w.superRoot);
  sh(['push', 'origin', 'main'], w.superRoot);
  return head(w.superRoot);
}

// ---------------------------------------------------------------------------
// Fake gh — simulates PR create/merge/view against the LOCAL bare origin
// ---------------------------------------------------------------------------

export interface FakeGh {
  gh: GhRunner;
  calls: Array<{ args: string[]; cwd: string }>;
}

/** advanceMode 'advance' (default): `pr merge` fast-forwards the bare origin's
 *  base to the pushed scratch commit (a real ff). 'never': stores the merge sha
 *  but does NOT advance origin (⇒ the reconcile can never catch up → halt). */
export function makeFakeGh(
  superOrigin: string,
  opts: { advanceMode?: 'advance' | 'never'; failFirstMerge?: boolean } = {},
): FakeGh {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const mode = opts.advanceMode ?? 'advance';
  const state: { base?: string; head?: string; sha?: string; mergeSha?: string; mergedOnce?: boolean } = {};
  const gh: GhRunner = (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const [group, verb] = args;
    if (group === 'pr' && verb === 'create') {
      const b = args.indexOf('--base');
      const h = args.indexOf('--head');
      state.base = b >= 0 ? args[b + 1] : 'main';
      state.head = h >= 0 ? args[h + 1] : '';
      state.sha = realGit(['rev-parse', `refs/heads/${state.head}`], superOrigin).stdout.trim();
      return { code: 0, stdout: 'https://github.com/acme/repo/pull/1\n', stderr: '' };
    }
    if (group === 'pr' && verb === 'merge') {
      if (opts.failFirstMerge && !state.mergedOnce && !args.includes('--admin')) {
        state.mergedOnce = true;
        return { code: 1, stdout: '', stderr: 'Pull request is not mergeable: branch protection' };
      }
      if (mode === 'advance' && state.sha) {
        realGit(['update-ref', `refs/heads/${state.base}`, state.sha], superOrigin);
      }
      state.mergeSha = state.sha;
      if (state.head) realGit(['update-ref', '-d', `refs/heads/${state.head}`], superOrigin);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (group === 'pr' && verb === 'view') {
      return { code: 0, stdout: (state.mergeSha ?? '') + '\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { gh, calls };
}

export const ghThatThrows: GhRunner = () => {
  throw new Error('gh should NOT be called on a skip/noop/dry-run path');
};

/** Wrap realGit and record every (args, cwd). */
export function recordingGit(): { git: GitRunner; calls: Array<{ args: string[]; cwd?: string }> } {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const git: GitRunner = (args, cwd) => {
    calls.push({ args: [...args], cwd });
    return realGit(args, cwd);
  };
  return { git, calls };
}

export const fastReconcile = { reconcileSleepBaseMs: 0, reconcileAttempts: 4 } as const;
