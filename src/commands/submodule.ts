// `pipeline submodule bump` — the Phase-1 guarded git primitive.
//
// Records superproject submodule-pointer change(s) on the base branch and PUSHes
// them, isolation-safely (throwaway worktree off origin/<base>; the shared
// checkout is only ever `fetch` + `merge --ff-only`). Replaces the consumer
// project's AI-improvised `land_to_main.py` + `submodule_drift.py` recipe with a
// deterministic, guarded, tested command.
//
// Contract (design §3 universal + §4.3):
//   Args: --project-root <path> (required) --submodules a,b (optional; auto-detect
//         drifted when omitted) --base <branch> (default main) --source-worktree
//         <path> (optional) --dry-run --json
//   Output: ONE JSON object on stdout
//     { status: committed|noop|dry-run|halted,
//       bumped: [{path, from, to}], skipped: [{path, reason, status}],
//       pr, infra_sha, reconcile_status, merged_via_admin, halt_reason?,
//       planned_actions?, diff? }
//   Exit: 0 (committed|noop|dry-run) · 1 (halted) · 2 (usage/env).
//
// GENERIC: no project specifics. A project with no submodules resolves an empty
// candidate set → noop. `gh` absent → clean exit-2 env error (non-dry-run only).

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type GitRunner,
  type GhRunner,
  realGit,
  realGh,
  gitAvailable,
  ghAvailable,
  isGitRepo,
} from '../lib/git';
import { classifyAll, resolveSubmodulePaths, buildBumpMessage, isBumpable, type DriftEntry } from '../lib/drift';
import { landToMain, type GitlinkChange, type LandResult } from '../lib/land';

interface BumpArgs {
  projectRoot?: string;
  submodules?: string[];
  base: string;
  sourceWorktree?: string;
  dryRun: boolean;
  json: boolean;
  noFetch: boolean;
  // Test seams (never set from the CLI): injected runners + fast reconcile.
  git?: GitRunner;
  gh?: GhRunner;
  worktreesDir?: string;
  reconcileAttempts?: number;
  reconcileSleepBaseMs?: number;
}

export interface BumpReport {
  status: 'committed' | 'noop' | 'dry-run' | 'halted';
  bumped: Array<{ path: string; from: string | null; to: string | null }>;
  skipped: Array<{ path: string; reason: string; status: string }>;
  pr: string | null;
  infra_sha: string | null;
  reconcile_status: string | null;
  merged_via_admin: boolean;
  halt_reason?: string | null;
  planned_actions?: string[];
  diff?: string | null;
  stderr?: string | null;
}

function parseArgs(args: string[]): BumpArgs | { error: string } {
  const out: BumpArgs = { base: 'main', dryRun: false, json: false, noFetch: false };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--project-root') out.projectRoot = take(i++);
    else if (eq('--project-root') !== undefined) out.projectRoot = eq('--project-root');
    else if (a === '--submodules') out.submodules = splitList(take(i++));
    else if (eq('--submodules') !== undefined) out.submodules = splitList(eq('--submodules'));
    else if (a === '--base') out.base = take(i++) ?? 'main';
    else if (eq('--base') !== undefined) out.base = eq('--base') ?? 'main';
    else if (a === '--source-worktree') out.sourceWorktree = take(i++);
    else if (eq('--source-worktree') !== undefined) out.sourceWorktree = eq('--source-worktree');
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-fetch') out.noFetch = true;
    else return { error: `unknown argument '${a}'` };
  }
  return out;
}

function splitList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items;
}

/** Turn a drift entry into its `skipped` report shape (only the reportable
 *  ones — `in-sync`/`not-a-gitlink` are uninteresting and dropped by the caller). */
function skipEntry(e: DriftEntry): { path: string; reason: string; status: string } {
  return { path: e.path, reason: e.reason ?? e.status, status: e.status };
}

/**
 * Compute the bump report + exit code. Pure of process I/O except through the
 * injected git/gh runners — the CLI shell (`runSubmoduleBump`) prints + exits.
 */
export function bump(args: BumpArgs): { report: BumpReport; code: number } {
  const root = resolve(args.projectRoot!);
  const git = args.git ?? realGit;

  const gitmodulesFile = join(root, '.gitmodules');
  const paths = resolveSubmodulePaths(git, root, args.submodules, gitmodulesFile);

  const entries = classifyAll(git, root, paths, {
    baseBranch: args.base,
    sourceWorktree: args.sourceWorktree,
    doFetch: !args.noFetch,
  });

  const bumpable = entries.filter(isBumpable);
  const skipped = entries
    .filter((e) => !isBumpable(e) && e.status !== 'in-sync' && e.status !== 'not-a-gitlink')
    .map(skipEntry);

  const report: BumpReport = {
    status: 'noop',
    bumped: [],
    skipped,
    pr: null,
    infra_sha: null,
    reconcile_status: null,
    merged_via_admin: false,
    halt_reason: null,
  };

  if (!bumpable.length) {
    return { report, code: 0 };
  }

  const { commitMessage, prTitle, prBody } = buildBumpMessage(bumpable);
  const gitlinkChanges: GitlinkChange[] = bumpable.map((e) => ({ path: e.path, newSha: e.run! }));

  const land: LandResult = landToMain(root, {
    gitlinkChanges,
    commitMessage,
    branchName: 'chore/bump-submodule',
    prTitle,
    prBody,
    baseBranch: args.base,
    dryRun: args.dryRun,
    git,
    gh: args.gh ?? realGh,
    worktreesDir: args.worktreesDir,
    reconcileAttempts: args.reconcileAttempts,
    reconcileSleepBaseMs: args.reconcileSleepBaseMs,
  });

  report.bumped = bumpable.map((e) => ({ path: e.path, from: e.base ?? null, to: e.run ?? null }));
  report.status = land.status;
  report.pr = land.prRef;
  report.infra_sha = land.infraBumpSha;
  report.reconcile_status = land.reconcileStatus;
  report.merged_via_admin = land.mergedViaAdmin;
  report.halt_reason = land.haltReason;
  report.stderr = land.stderr;
  if (land.status === 'dry-run') {
    report.planned_actions = land.plannedActions;
    report.diff = land.diff;
  }
  // A land noop means the throwaway worktree staged nothing (the pointers were
  // already at origin/<base>) — report noop, no bumps recorded.
  if (land.status === 'noop') {
    report.bumped = [];
  }

  const code = land.status === 'halted' ? 1 : 0;
  return { report, code };
}

/** CLI shell: parse → validate env/args → compute → print JSON → exit code. */
export function runSubmoduleBump(args: string[]): number {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`pipeline submodule bump: ${parsed.error}\n`);
    return 2;
  }
  if (!parsed.projectRoot) {
    process.stderr.write('pipeline submodule bump: --project-root <path> is required\n');
    return 2;
  }
  if (!gitAvailable()) {
    process.stderr.write('pipeline submodule bump: git not found on PATH\n');
    return 2;
  }
  const root = resolve(parsed.projectRoot);
  const git = parsed.git ?? realGit;
  if (!existsSync(root) || !isGitRepo(git, root)) {
    process.stderr.write(`pipeline submodule bump: --project-root is not a git repository (${root})\n`);
    return 2;
  }
  if (parsed.sourceWorktree && !existsSync(parsed.sourceWorktree)) {
    process.stderr.write(`pipeline submodule bump: --source-worktree does not exist (${parsed.sourceWorktree})\n`);
    return 2;
  }
  // gh is only needed for the real (non-dry-run) landing; check early so a
  // missing gh is a clean env error before any worktree is created.
  if (!parsed.dryRun && !parsed.gh && !ghAvailable()) {
    process.stderr.write('pipeline submodule bump: gh (GitHub CLI) not found on PATH — required to open + merge the landing PR\n');
    return 2;
  }

  const { report, code } = bump(parsed);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return code;
}

/** Group dispatcher: `pipeline submodule <verb> [args]`. */
export function runSubmodule(args: string[]): number {
  const verb = args[0];
  const rest = args.slice(1);
  switch (verb) {
    case 'bump':
      return runSubmoduleBump(rest);
    case undefined:
      process.stderr.write('pipeline submodule: a verb is required (bump)\n');
      return 2;
    default:
      process.stderr.write(`pipeline submodule: unknown verb '${verb}' (expected: bump)\n`);
      return 2;
  }
}
