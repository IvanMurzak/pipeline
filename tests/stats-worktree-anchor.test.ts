// Stats written from inside a git WORKTREE are anchored to the MAIN checkout.
//
// @serial: real git worktree lifecycle — same class as worktree-scoped.test.ts.
//
// Regression: a worktree is ephemeral by design (`git worktree remove` takes
// the whole tree), so measurements written inside one were destroyed exactly
// when the run they measured finished. They were also invisible while they
// existed — every reader (the dashboard sweep, the Stop-hook backfill,
// `pipeline stats`) resolves a project through the worktree→main mapping and
// so only ever looked in the main checkout. Verified end to end before the
// fix: `pipeline next` from inside a worktree wrote
// `<worktree>/.claude/pipeline/.stats/demo/runs/<id>.jsonl` and the main tree
// got nothing.
//
// This is the same rule the CLI already applies to runs it orchestrates
// itself, whose bookkeeping is main-scoped (D6) — extended to a worktree the
// CLI did not create (Claude Code's own worktree sessions, parallel-wave
// worktrees, `.claude/worktrees/<name>/`).

import { test, expect, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { realGit } from '../src/lib/git';
import { mkTmp, ident, cleanupCreated } from './_git-sandbox';
import { statsLocation, mainCheckoutPipelineRoot } from '../src/lib/stats';
import { findStatsProjectRoot } from '../src/lib/stats-backfill';

afterEach(cleanupCreated);

function git(cwd: string, ...args: string[]): string {
  const r = realGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/**
 * One canonical spelling of a path, so two spellings of the SAME directory
 * compare equal.
 *
 * GitHub's Windows runner hands out 8.3 short TEMP paths (`RUNNER~1`), and git
 * rewrites them to their long form when it records `gitdir:`/`commondir` — so
 * the resolver legitimately returns a differently-spelled path than the one the
 * fixture created, pointing at the very same directory. Plain `realpathSync`
 * does NOT expand 8.3 on Windows; `realpathSync.native` does. Paths that do not
 * exist yet (a `.stats` tree before its first write) are canonicalized via
 * their deepest existing ancestor.
 */
function canon(p: string): string {
  const abs = resolve(p);
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(basename(cur));
    cur = parent;
  }
  try {
    return join(realpathSync.native(cur), ...tail);
  } catch {
    return abs;
  }
}

/** A repo with a pipeline, plus a worktree of it that the CLI knows nothing
 *  about. Returns both checkouts' pipeline roots. */
function scaffold(): { project: string; worktree: string; mainPipelineRoot: string; wtPipelineRoot: string } {
  const project = mkTmp('stats-wt-');
  git(project, 'init', '-q', '-b', 'main');
  ident(project);
  const mainPipelineRoot = join(project, '.claude', 'pipeline', 'demo');
  mkdirSync(join(mainPipelineRoot, 'steps'), { recursive: true });
  writeFileSync(join(mainPipelineRoot, 'PIPELINE.md'), '---\n---\n# P\n\n## End State\nx\n');
  writeFileSync(join(mainPipelineRoot, 'steps', '01-step.md'), '# step 1\n\nwork\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'pipeline');

  const worktree = join(mkTmp('stats-wt-tree-'), 'wt');
  git(project, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  return {
    project,
    worktree,
    mainPipelineRoot,
    wtPipelineRoot: join(worktree, '.claude', 'pipeline', 'demo'),
  };
}

test('a pipeline root inside a worktree maps to the main checkout', () => {
  const { mainPipelineRoot, wtPipelineRoot, worktree } = scaffold();
  expect(existsSync(join(wtPipelineRoot, 'steps', '01-step.md'))).toBe(true);

  const mapped = canon(mainCheckoutPipelineRoot(wtPipelineRoot));
  expect(mapped).toBe(canon(mainPipelineRoot));
  // The point of the exercise: it left the ephemeral tree.
  expect(mapped.startsWith(canon(worktree))).toBe(false);
});

test('an ordinary checkout is left alone', () => {
  const { mainPipelineRoot } = scaffold();
  expect(canon(mainCheckoutPipelineRoot(mainPipelineRoot))).toBe(canon(mainPipelineRoot));
});

test('statsLocation anchors a worktree run to the main .stats tree', () => {
  const { project, mainPipelineRoot, wtPipelineRoot, worktree } = scaffold();

  const fromWorktree = statsLocation(wtPipelineRoot);
  const fromMain = statsLocation(mainPipelineRoot);

  // Same tree, same per-pipeline subdir — a run is measured in one place
  // regardless of which checkout it executed from.
  expect(canon(fromWorktree.base)).toBe(canon(fromMain.base));
  expect(fromWorktree.rel).toBe(fromMain.rel);
  expect(canon(fromWorktree.base)).toBe(canon(join(project, '.claude', 'pipeline', '.stats')));
  expect(fromWorktree.rel).toBe('demo');
  // And crucially NOT inside the ephemeral tree.
  expect(canon(fromWorktree.base).startsWith(canon(worktree))).toBe(false);
});

test('the readers resolve the same project root as the writer', () => {
  const { project, worktree, wtPipelineRoot } = scaffold();

  // The Stop-hook relay resolves from the session cwd; the run-init kick from
  // --root. Both must land on the checkout the stats were written under, or a
  // worktree run's records would be written in one place and enriched in
  // another — i.e. never enriched at all.
  expect(canon(findStatsProjectRoot(worktree)!)).toBe(canon(project));
  expect(canon(findStatsProjectRoot(wtPipelineRoot)!)).toBe(canon(project));
  expect(canon(findStatsProjectRoot(project)!)).toBe(canon(project));
});

test('a project with no git at all still resolves to itself', () => {
  const plain = mkTmp('stats-nogit-');
  const pipelineRoot = join(plain, '.claude', 'pipeline', 'demo');
  mkdirSync(pipelineRoot, { recursive: true });

  expect(canon(mainCheckoutPipelineRoot(pipelineRoot))).toBe(canon(pipelineRoot));
  expect(canon(findStatsProjectRoot(pipelineRoot)!)).toBe(canon(plain));
  expect(canon(statsLocation(pipelineRoot).base)).toBe(canon(join(plain, '.claude', 'pipeline', '.stats')));
});
