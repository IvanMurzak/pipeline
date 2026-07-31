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
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  const { mainPipelineRoot, wtPipelineRoot } = scaffold();
  expect(existsSync(join(wtPipelineRoot, 'steps', '01-step.md'))).toBe(true);

  expect(mainCheckoutPipelineRoot(wtPipelineRoot)).toBe(resolve(mainPipelineRoot));
});

test('an ordinary checkout is left alone', () => {
  const { mainPipelineRoot } = scaffold();
  expect(mainCheckoutPipelineRoot(mainPipelineRoot)).toBe(resolve(mainPipelineRoot));
});

test('statsLocation anchors a worktree run to the main .stats tree', () => {
  const { project, mainPipelineRoot, wtPipelineRoot } = scaffold();

  const fromWorktree = statsLocation(wtPipelineRoot);
  const fromMain = statsLocation(mainPipelineRoot);

  // Same tree, same per-pipeline subdir — a run is measured in one place
  // regardless of which checkout it executed from.
  expect(fromWorktree).toEqual(fromMain);
  expect(fromWorktree.base).toBe(resolve(join(project, '.claude', 'pipeline', '.stats')));
  expect(fromWorktree.rel).toBe('demo');
  // And crucially NOT inside the ephemeral tree.
  expect(fromWorktree.base.startsWith(resolve(wtPipelineRoot))).toBe(false);
});

test('the readers resolve the same project root as the writer', () => {
  const { project, worktree, wtPipelineRoot } = scaffold();

  // The Stop-hook relay resolves from the session cwd; the run-init kick from
  // --root. Both must land on the checkout the stats were written under, or a
  // worktree run's records would be written in one place and enriched in
  // another — i.e. never enriched at all.
  expect(findStatsProjectRoot(worktree)).toBe(resolve(project));
  expect(findStatsProjectRoot(wtPipelineRoot)).toBe(resolve(project));
  expect(findStatsProjectRoot(project)).toBe(resolve(project));
});

test('a project with no git at all still resolves to itself', () => {
  const plain = mkTmp('stats-nogit-');
  const pipelineRoot = join(plain, '.claude', 'pipeline', 'demo');
  mkdirSync(pipelineRoot, { recursive: true });

  expect(mainCheckoutPipelineRoot(pipelineRoot)).toBe(resolve(pipelineRoot));
  expect(findStatsProjectRoot(pipelineRoot)).toBe(resolve(plain));
  expect(statsLocation(pipelineRoot).base).toBe(resolve(join(plain, '.claude', 'pipeline', '.stats')));
});
