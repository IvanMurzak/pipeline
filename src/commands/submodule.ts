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
//         <path> (optional) --dry-run --json --no-fetch --no-admin
//   Output: ONE JSON object on stdout
//     { status: committed|noop|dry-run|halted,
//       bumped: [{path, from, to}], skipped: [{path, reason, status}],
//       pr, infra_sha, reconcile_status, merged_via_admin, merge_outcome,
//       halt_reason?, planned_actions?, diff? }
//   Exit: 0 (committed|noop|dry-run) · 1 (halted) · 2 (usage/env).
//
// ELEVATION (`--no-admin`). By default the landing PR's merge falls back to
// `gh pr merge --admin` when GitHub refuses the plain merge — i.e. it BYPASSES
// branch protection on the caller's repository. `--no-admin` turns that
// fallback off: a refused merge is reported (`status: halted`,
// `merge_outcome: "refused"`, exit 1) and no `--admin` invocation is ever made.
// The default is deliberately left ON so existing callers do not change
// behaviour silently; an orchestrator that promises never to elevate is
// expected to pass `--no-admin` on every invocation.
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
import { landToMain, type GitlinkChange, type LandResult, type MergeOutcome } from '../lib/land';

interface BumpArgs {
  projectRoot?: string;
  submodules?: string[];
  base: string;
  sourceWorktree?: string;
  dryRun: boolean;
  json: boolean;
  noFetch: boolean;
  /** `--no-admin`: disable landToMain's `--admin` merge fallback. Same bare
   *  `--no-<x>` → `true` negation shape as `--no-fetch` above; consumed
   *  inverted at the call site (`adminFallback: !args.noAdmin`). */
  noAdmin: boolean;
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
  /** Which of the three merge outcomes happened: `"plain"` (merged as-is),
   *  `"admin"` (merged via the `--admin` bypass), `"refused"` (not merged —
   *  reported, never forced), or `null` when the merge step was never reached
   *  (dry-run / noop / an earlier halt). `merged_via_admin` remains for
   *  compatibility; this field is the discriminator, since a refusal is
   *  otherwise only distinguishable from any other halt by prose. */
  merge_outcome: MergeOutcome | null;
  halt_reason?: string | null;
  planned_actions?: string[];
  diff?: string | null;
  stderr?: string | null;
}

function parseArgs(args: string[]): BumpArgs | { error: string } {
  const out: BumpArgs = { base: 'main', dryRun: false, json: false, noFetch: false, noAdmin: false };
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
    else if (a === '--no-admin') out.noAdmin = true;
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
    merge_outcome: null,
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
    // `--no-admin` ⇒ adminFallback:false. Omitting the option would take
    // land.ts's `?? true` default, so this must be passed explicitly.
    adminFallback: !args.noAdmin,
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
  report.merge_outcome = land.mergeOutcome;
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

// `--help` for this group, in the same shape `pipeline worktree` uses. It did
// not exist before: `submodule bump --help` fell through parseArgs as an
// unknown argument and exited 2. The elevation switch below is the kind of flag
// an operator has to be able to find from the command itself, so this is the
// command's own reference, not only a line in `pipeline --help`.
const USAGE = [
  'pipeline submodule bump — the guarded submodule-pointer bump',
  '',
  'Usage:',
  '  pipeline submodule bump --project-root <path> [--submodules a,b]',
  '                          [--base <branch>] [--source-worktree <path>]',
  '                          [--dry-run] [--json] [--no-fetch] [--no-admin]',
  '',
  'Records superproject submodule-pointer change(s) on the base branch and',
  'pushes them isolation-safely: all branch/commit work happens in a throwaway',
  'worktree off origin/<base>, and the shared checkout is only ever `fetch` +',
  '`merge --ff-only` — never checkout, reset, or force. Drifted pointers are',
  'auto-detected when --submodules is omitted. ONE JSON object on stdout.',
  '',
  'Flags:',
  '  --project-root <path>     the superproject checkout (REQUIRED)',
  '  --submodules a,b          the subset to consider (default: auto-detect drift)',
  '  --base <branch>           the SUPERPROJECT branch to land onto (default main)',
  '  --source-worktree <path>  read the run\'s intended pointer from this worktree',
  '  --dry-run                 stage + capture the diff, then STOP before',
  '                            push/PR/merge (mutates nothing on the base branch)',
  '  --json                    accepted for symmetry; JSON is always emitted',
  '  --no-fetch                trust the present remote-tracking refs (skip the',
  '                            read-only reachability fetch)',
  '  --no-admin                do NOT retry a refused `gh pr merge` with --admin',
  '',
  '--no-admin — REFUSE TO BYPASS BRANCH PROTECTION. The landing PR is merged',
  'with `gh pr merge --squash --delete-branch`. BY DEFAULT, a merge GitHub',
  'refuses (a required review, a required check, any protection rule) is retried',
  'once with --admin, GitHub\'s administrator bypass — it merges the PR DESPITE',
  'the rule that refused it. --no-admin turns that fallback off: the plain merge',
  'is attempted once, a refusal is REPORTED (status "halted", merge_outcome',
  '"refused", exit 1) with GitHub\'s own text in `stderr`, and gh is never invoked',
  'with --admin at all. Nothing is lost — the commit is on origin and the PR is',
  'open; merge it through whatever gate refused it.',
  'The default is deliberately still the fallback, so no existing caller changes',
  'behaviour silently. AN AUTOMATED ORCHESTRATOR IS EXPECTED TO PASS --no-admin:',
  'a driver that lands pointer bumps on your behalf must not be able to overrule',
  'branch protection you configured.',
  '',
  'merge_outcome distinguishes the three merge outcomes — "plain" (merged as',
  'is) · "admin" (merged by bypassing branch protection) · "refused" (not',
  'merged; reported, never forced) · null (the merge step was never reached).',
  '`status` does not answer this on its own: a PR that merged fine still reports',
  '"halted" when the shared checkout could not afterwards be fast-forwarded.',
  '',
  'Exit: 0 (committed | noop | dry-run) · 1 (halted) · 2 (usage / env — bad',
  'args, not a git repository, or `gh` missing for a non-dry-run landing).',
  '',
].join('\n');

/** CLI shell: parse → validate env/args → compute → print JSON → exit code. */
export function runSubmoduleBump(args: string[]): number {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`pipeline submodule bump: ${parsed.error}\n\n${USAGE}`);
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
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    case undefined:
      process.stderr.write(`pipeline submodule: a verb is required (bump)\n\n${USAGE}`);
      return 2;
    default:
      process.stderr.write(`pipeline submodule: unknown verb '${verb}' (expected: bump)\n\n${USAGE}`);
      return 2;
  }
}
