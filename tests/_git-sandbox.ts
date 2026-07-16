// Shared real-git sandbox plumbing for the submodule-* and gc-* test shards
// (imported via their world modules _submodule-world.ts / _gc-world.ts).
// One home for the pieces that would otherwise drift in two copies: the git
// binary pin, hook isolation, temp-dir lifecycle, and repo identity.

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realGit } from '../src/lib/git';

// The host's PATH `git` may be a wrapper/shim (e.g. `.git-ai`) that forks
// heavily + adds large per-call latency (and can deadlock a 500+ git-call test
// suite). Pin the REAL Git-for-Windows binary via PIPELINE_GIT_BIN so
// realGit() bypasses it. Falls back to plain `git` on other hosts. realGit
// reads this at call time, and every git call in the suites happens inside a
// test body (after module eval), so setting it at import — before any test
// runs — is sufficient.
if (!process.env.PIPELINE_GIT_BIN) {
  for (const cand of ['C:\\Program Files\\Git\\cmd\\git.exe', '/usr/bin/git']) {
    if (existsSync(cand)) {
      process.env.PIPELINE_GIT_BIN = cand;
      break;
    }
  }
}

// An empty hooks dir every test repo points `core.hooksPath` at, so the
// host's global commit hooks (identity guard etc., ~7s/commit) never fire in
// the sandboxes. A DETERMINISTIC path (not mkdtemp) so the many parallel test
// processes share one dir instead of leaking a fresh temp dir each — it is
// created empty and nothing ever writes into it, so sharing is safe.
export const EMPTY_HOOKS = join(tmpdir(), 'pipeline-tests-nohooks');
mkdirSync(EMPTY_HOOKS, { recursive: true });

const created: string[] = [];

/** Register in each shard: `afterEach(cleanupCreated)`. */
export function cleanupCreated(): void {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export function mkTmp(prefix: string): string {
  // realpath so path comparisons survive symlinked temp dirs (git prints
  // resolved paths in `worktree list --porcelain`).
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(d);
  return d;
}

/** Sandbox identity + hook isolation. Worktrees share the repo config, so
 *  their commits skip the host hooks too. Throws on failure — a broken
 *  sandbox setup must be loud. */
export function ident(repo: string): void {
  const cfg = (k: string, v: string): void => {
    const r = realGit(['config', k, v], repo);
    if (r.code !== 0) throw new Error(`git config ${k} @ ${repo} → ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  };
  cfg('core.hooksPath', EMPTY_HOOKS);
  cfg('user.email', 'test@example.com');
  cfg('user.name', 'Pipeline Test');
  cfg('commit.gpgsign', 'false');
}
