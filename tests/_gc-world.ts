// Shared real-git sandbox helpers for the gc-*.test.ts shards.
//
// Tests for `pipeline gc` run against REAL temp git repos — no network, no gh
// (a deliberately lighter cousin of the _submodule-world.ts pattern). Each
// scenario builds a repo, plants leaked worktrees / stale dirs / orphaned
// branches, then drives runGc() in-process (via --project, so the tests never
// chdir) and asserts the report and the --clean results. The suite is SHARDED
// (report / clean / submodules-report / submodules-clean) so the parallel
// runner (scripts/parallel-tests.ts) can overlap the sandbox-heavy files; each
// shard registers `afterEach(cleanupCreated)`.

import { runGc, type GcReport } from '../src/commands/gc';
import { realGit } from '../src/lib/git';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupCreated, ident, mkTmp } from './_git-sandbox';

// Re-exported so the gc-* shards import everything from ONE module.
export { cleanupCreated, ident, mkTmp };

export function sh(args: string[], cwd: string): string {
  const r = realGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** A real repo on branch `main` with one commit + a local identity. */
export function mkRepo(): string {
  const root = mkTmp('gcrepo-');
  sh(['init', '-q', '-b', 'main'], root);
  ident(root);
  writeFileSync(join(root, 'README.md'), 'x\n');
  sh(['add', '.'], root);
  sh(['commit', '-q', '-m', 'init'], root);
  return root;
}

/** Run runGc() in-process, capturing stdout. */
export function callGc(args: string[]): { code: number; out: string } {
  let buf = '';
  const orig = process.stdout.write;
  (process.stdout as any).write = (chunk: unknown) => {
    buf += String(chunk);
    return true;
  };
  let code: number;
  try {
    code = runGc(args);
  } finally {
    (process.stdout as any).write = orig;
  }
  return { code, out: buf };
}

export function callGcJson(args: string[]): { code: number; report: GcReport } {
  const r = callGc([...args, '--json']);
  return { code: r.code, report: JSON.parse(r.out) as GcReport };
}

/**
 * The full leak zoo, shared by the report + --clean tests:
 *   run-a   worktree on branch worktree-run-a, no extra commits → merged
 *   run-b   worktree on branch worktree-run-b + one commit      → unmerged
 *   run-c   worktree on branch worktree-run-c whose DIRECTORY was deleted
 *           (a prunable record; the branch becomes orphaned once pruned)
 *   run-d   detached-HEAD worktree (merge state unknown → kept by --clean)
 *   stale-x a plain directory in .claude/worktrees never registered as a worktree
 *   worktree-orphan-m  branch at main, no worktree                → merged orphan
 *   worktree-orphan-u  branch at run-b's commit, no worktree      → unmerged orphan
 */
export function scaffoldLeaks(root: string): { wtDir: string } {
  const wtDir = join(root, '.claude', 'worktrees');
  sh(['worktree', 'add', '-q', '-b', 'worktree-run-a', join(wtDir, 'run-a')], root);
  sh(['worktree', 'add', '-q', '-b', 'worktree-run-b', join(wtDir, 'run-b')], root);
  writeFileSync(join(wtDir, 'run-b', 'work.txt'), 'unmerged work\n');
  sh(['add', '.'], join(wtDir, 'run-b'));
  sh(['commit', '-q', '-m', 'unmerged work'], join(wtDir, 'run-b'));
  sh(['worktree', 'add', '-q', '-b', 'worktree-run-c', join(wtDir, 'run-c')], root);
  rmSync(join(wtDir, 'run-c'), { recursive: true, force: true }); // → prunable record
  sh(['worktree', 'add', '-q', '--detach', join(wtDir, 'run-d')], root);
  mkdirSync(join(wtDir, 'stale-x'), { recursive: true });
  writeFileSync(join(wtDir, 'stale-x', 'leftover.txt'), 'crash debris\n');
  sh(['branch', 'worktree-orphan-m'], root); // at main → merged
  sh(['branch', 'worktree-orphan-u', 'worktree-run-b'], root); // → unmerged
  return { wtDir };
}

export const byBase = <T extends { path: string }>(list: T[], base: string): T | undefined =>
  list.find((w) => w.path.split(/[\\/]/).pop() === base);

/**
 * A superproject with one INITIALIZED submodule `Sub` (backed by a local bare
 * origin so the submodule's origin/HEAD ladder resolves to origin/main) and
 * one UNINITIALIZED submodule `Sub2` (deinit'd — must be skipped + counted).
 *
 * Leaks planted in the SUBMODULE repo:
 *   worktree-subm-merged   branch at origin/main, no worktree      → merged orphan
 *   worktree-subm-squash   branch with a real commit whose CONTENT was
 *                          re-committed onto the submodule's local main as a
 *                          DIFFERENT commit (simulated squash-merge) → unmerged orphan
 *   worktree-subm-wt       registered submodule worktree LEAKED under the
 *                          SUPERPROJECT's .claude/worktrees/leak-sub (merged)
 *   worktree-subm-gone     registered worktree whose dir was deleted → prunable
 * Leak planted in the SUPERPROJECT:
 *   worktree-super-u       unmerged orphan branch (for --force-worktree-branches)
 */
export function mkSuperWithSub(): { root: string; subDir: string; wtDir: string } {
  const root = mkRepo();
  const wtDir = join(root, '.claude', 'worktrees');

  // Local bare origin for the submodule, seeded from a scratch clone.
  const bare = mkTmp('gcsubbare-');
  sh(['init', '-q', '--bare', '-b', 'main'], bare);
  const seed = mkTmp('gcsubseed-');
  sh(['init', '-q', '-b', 'main'], seed);
  ident(seed);
  writeFileSync(join(seed, 's.md'), 'sub\n');
  sh(['add', '.'], seed);
  sh(['commit', '-q', '-m', 'sub init'], seed);
  sh(['push', '-q', bare, 'main'], seed);

  // Two declared submodules; Sub2 is deinit'd → uninitialized (skip + count).
  sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', bare, 'Sub'], root);
  sh(['-c', 'protocol.file.allow=always', 'submodule', 'add', bare, 'Sub2'], root);
  sh(['commit', '-q', '-m', 'add submodules'], root);
  sh(['submodule', 'deinit', '-f', '--', 'Sub2'], root);
  const subDir = join(root, 'Sub');
  ident(subDir);
  sh(['remote', 'set-head', 'origin', '--auto'], subDir); // ensure origin/HEAD

  // Merged orphan branch in the submodule.
  sh(['branch', 'worktree-subm-merged', 'origin/main'], subDir);

  // Simulated squash-merge: real commit on the branch (via a scratch worktree
  // OUTSIDE .claude/worktrees), then the same content as a DIFFERENT commit on
  // the submodule's local main → --is-ancestor reads the branch as unmerged.
  const sq = join(mkTmp('gcsq-'), 'wt');
  sh(['worktree', 'add', '-q', '-b', 'worktree-subm-squash', sq, 'origin/main'], subDir);
  writeFileSync(join(sq, 'feature.txt'), 'squash content\n');
  sh(['add', '.'], sq);
  sh(['commit', '-q', '-m', 'feature work'], sq);
  sh(['worktree', 'remove', '--force', sq], subDir);
  writeFileSync(join(subDir, 'feature.txt'), 'squash content\n');
  sh(['add', '.'], subDir);
  sh(['commit', '-q', '-m', 'squash-merge of feature work'], subDir);

  // Leaked registered submodule worktree under the SUPERPROJECT's worktrees
  // dir (merged), plus one whose directory vanished (prunable record).
  sh(['worktree', 'add', '-q', '-b', 'worktree-subm-wt', join(wtDir, 'leak-sub'), 'origin/main'], subDir);
  sh(['worktree', 'add', '-q', '-b', 'worktree-subm-gone', join(wtDir, 'leak-gone'), 'origin/main'], subDir);
  rmSync(join(wtDir, 'leak-gone'), { recursive: true, force: true });

  // Superproject-level unmerged orphan (exercises --force-worktree-branches).
  const swt = join(mkTmp('gcsup-'), 'wt');
  sh(['worktree', 'add', '-q', '-b', 'worktree-super-u', swt], root);
  writeFileSync(join(swt, 'u.txt'), 'u\n');
  sh(['add', '.'], swt);
  sh(['commit', '-q', '-m', 'unmerged super work'], swt);
  sh(['worktree', 'remove', '--force', swt], root);

  return { root, subDir, wtDir };
}
