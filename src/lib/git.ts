// Deterministic git (+ gh) subprocess core for the guarded `pipeline submodule`
// commands. Ports the behaviors of the consumer project's tested Python
// `_lib/git_helpers.py` (stable env, run_git, detect_default_branch,
// current_branch) into TypeScript, plus the small submodule/pointer probes the
// `bump` command needs (gitlink lookups, ancestry, drift status).
//
// Everything is expressed over an injectable `GitRunner` (and, for the landing
// step, a `GhRunner`). Production wires the real `spawnSync`-backed runners; the
// tests wrap them to (a) assert the ISOLATION invariant by inspecting the call
// log and (b) inject transient failures for the reconcile-retry path — WITHOUT
// mocking git itself (the sandboxes are real repos).

import { spawnSync } from 'node:child_process';

export interface GitResult {
  /** Process exit code (127 when the binary could not be spawned). */
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `git <args>` with `cwd` as the working directory. Never throws — a spawn
 *  failure is surfaced as `{code:127,...}` so callers branch on the code. */
export type GitRunner = (args: string[], cwd?: string) => GitResult;

/** Run `gh <args>` INSIDE `cwd` (gh infers the repo from the cwd's origin). */
export type GhRunner = (args: string[], cwd: string) => GitResult;

/** The git binary to invoke — `PIPELINE_GIT_BIN` overrides the PATH-resolved
 *  `git` (lets a consumer pin a specific git, or bypass a wrapper/shim on PATH). */
export function gitBin(): string {
  return process.env.PIPELINE_GIT_BIN || 'git';
}

/** The gh binary to invoke — `PIPELINE_GH_BIN` overrides the PATH-resolved `gh`. */
export function ghBin(): string {
  return process.env.PIPELINE_GH_BIN || 'gh';
}

/** Deterministic locale + no-pager env so git output is stable + parseable. */
export function stableEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

/** The real, spawnSync-backed git runner (used in production). */
export function realGit(args: string[], cwd?: string): GitResult {
  const r = spawnSync(gitBin(), args, {
    cwd,
    encoding: 'utf8',
    env: stableEnv(),
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) {
    return { code: 127, stdout: r.stdout ?? '', stderr: String((r.error as Error).message ?? r.error) };
  }
  return { code: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The real gh runner: gh-stable env (no pager, no color), captured text. */
export function realGh(args: string[], cwd: string): GitResult {
  const env = { ...stableEnv(), GH_PAGER: '', NO_COLOR: '1' };
  const r = spawnSync(ghBin(), args, {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) {
    return { code: 127, stdout: r.stdout ?? '', stderr: String((r.error as Error).message ?? r.error) };
  }
  return { code: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** True iff the git binary is invokable. */
export function gitAvailable(): boolean {
  const r = spawnSync(gitBin(), ['--version'], { encoding: 'utf8', windowsHide: true });
  return !r.error && (r.status ?? 1) === 0;
}

/** True iff the gh binary is invokable. */
export function ghAvailable(): boolean {
  const r = spawnSync(ghBin(), ['--version'], { encoding: 'utf8', windowsHide: true });
  return !r.error && (r.status ?? 1) === 0;
}

// ---------------------------------------------------------------------------
// Read-only probes (all take an injected runner)
// ---------------------------------------------------------------------------

/** True iff `<repo>/.git` exists (a git repo or a linked worktree gitfile). */
export function isGitRepo(git: GitRunner, repo: string): boolean {
  return git(['rev-parse', '--git-dir'], repo).code === 0;
}

/** The repo's current branch, or null on a detached HEAD / failure. */
export function currentBranch(git: GitRunner, repo: string): string | null {
  const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo);
  if (r.code !== 0) return null;
  const name = r.stdout.trim();
  return name || null;
}

const HEAD_BRANCH_RE = /^\s*HEAD branch:\s*(\S+)\s*$/m;

/** The remote's advertised default branch (`git remote show origin`), or null
 *  when offline / no origin / `(unknown)`. Mirrors detect_default_branch but
 *  returns null instead of raising (the caller classifies it as a skip). */
export function detectDefaultBranch(git: GitRunner, repo: string): string | null {
  const r = git(['remote', 'show', 'origin'], repo);
  if (r.code !== 0) return null;
  const m = HEAD_BRANCH_RE.exec(r.stdout);
  if (!m) return null;
  const branch = m[1];
  return branch && branch !== '(unknown)' ? branch : null;
}

/** `git rev-parse <rev>` → full sha, or null on failure. */
export function revParse(git: GitRunner, repo: string, rev: string): string | null {
  const r = git(['rev-parse', '--verify', '--quiet', rev], repo);
  if (r.code !== 0) return null;
  const sha = r.stdout.trim();
  return sha || null;
}

/** `git merge-base <a> <b>` → the fork-point sha, or null when unrelated. */
export function mergeBase(git: GitRunner, repo: string, a: string, b: string): string | null {
  const r = git(['merge-base', a, b], repo);
  if (r.code !== 0) return null;
  const sha = r.stdout.trim();
  return sha || null;
}

/** True iff `ancestor` is an ancestor-or-equal of `descendant` in `repo`. */
export function isAncestor(git: GitRunner, repo: string, ancestor: string, descendant: string): boolean {
  return git(['merge-base', '--is-ancestor', ancestor, descendant], repo).code === 0;
}

/** True iff `refs/heads/<branch>` resolves in `repo`. */
export function branchExists(git: GitRunner, repo: string, branch: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo).code === 0;
}

/** The gitlink sha recorded for `path` at `ref` (e.g. `origin/main` or a fork
 *  sha), verifying the tree entry is a 160000 submodule link. null when `path`
 *  is not a gitlink at `ref` (a regular file, absent, or the ref is unknown). */
export function gitlinkAt(git: GitRunner, root: string, ref: string, path: string): string | null {
  const r = git(['ls-tree', ref, '--', path], root);
  if (r.code !== 0) return null;
  const line = r.stdout.trim();
  if (!line) return null;
  // `<mode> <type> <sha>\t<path>` — a submodule is mode 160000, type commit.
  const m = /^(\d+)\s+(\S+)\s+([0-9a-f]{40})\t/.exec(line);
  if (!m) return null;
  const [, mode, type, sha] = m;
  return mode === '160000' && type === 'commit' ? sha : null;
}

/** The submodule checkout's HEAD sha at `<dir>`, or null if unreadable. */
export function submoduleHead(git: GitRunner, dir: string): string | null {
  return revParse(git, dir, 'HEAD');
}

/** True iff the submodule working tree at `<dir>` has any tracked/untracked change. */
export function isDirty(git: GitRunner, dir: string): boolean {
  const r = git(['status', '--porcelain'], dir);
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** Every submodule path declared in `<root>/.gitmodules`. */
export function gitmodulesPaths(git: GitRunner, root: string, gitmodulesFile: string): string[] {
  const r = git(
    ['config', '--file', gitmodulesFile, '--get-regexp', '^submodule\\..*\\.path$'],
    root,
  );
  if (r.code !== 0) return [];
  const paths: string[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const p = parts.slice(1).join(' ').trim();
      if (p) paths.push(p);
    }
  }
  return paths;
}

/** Parse `git worktree list --porcelain` into `[{path, branch|null}]`. */
export function iterWorktrees(git: GitRunner, root: string): Array<{ path: string; branch: string | null }> {
  const r = git(['worktree', 'list', '--porcelain'], root);
  if (r.code !== 0) return [];
  const out: Array<{ path: string; branch: string | null }> = [];
  let curPath: string | null = null;
  let curBranch: string | null = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (curPath !== null) out.push({ path: curPath, branch: curBranch });
      curPath = line.slice('worktree '.length).trim();
      curBranch = null;
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      curBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  if (curPath !== null) out.push({ path: curPath, branch: curBranch });
  return out;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** True if a process with `pid` is currently running (cross-platform, no deps).
 *  `process.kill(pid, 0)` is an existence probe: it never signals the target,
 *  throws ESRCH when absent, and EPERM (⇒ exists) when owned by another user. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Synchronous sleep (no-op for ms<=0) — the reconcile/backoff path is fully
 *  synchronous, and tests drive it with a 0 backoff base so this never waits. */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}
