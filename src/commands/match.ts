// `pipeline match --pipelines-dir <dir> (--task <t> | --issue <ref>) [--top N] [--neg-threshold N]`
//
// Prints the match result as JSON to stdout. Faithful port of match.py's main()
// argument handling, --issue resolution, and exit-code behavior.
//
// Exit codes:
//   0 - success (JSON written to stdout, possibly with empty candidates list)
//   1 - pipelines-dir does not exist, or gh CLI failed for an --issue ref
//   2 - argument validation failed (missing --task and --issue, empty task)

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { matchPipelines } from '../lib/match';

const ISSUE_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?/i;
const ISSUE_REF_RE = /^([^/]+)\/([^#]+)#(\d+)$/;

/** Marker error so runMatch can map a SystemExit-equivalent to exit 1. */
class IssueResolveError extends Error {}

/** Mimic Python repr() for a plain string (single-quoted, common escapes). */
function pyRepr(s: string): string {
  // Python prefers single quotes unless the string contains a single quote but
  // no double quote (then it uses double quotes). Issue refs never contain
  // quotes in practice, but mirror the rule for fidelity.
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(new RegExp(quote, 'g'), '\\' + quote);
  return quote + escaped + quote;
}

/** Expand a leading `~` to the home directory (mirrors Path.expanduser()). */
function expanduser(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join_home(p.slice(2));
  return p;
}

function join_home(rest: string): string {
  const h = homedir();
  return h.endsWith('/') || h.endsWith('\\') ? h + rest : h + '/' + rest;
}

/**
 * Resolve an issue ref to `title\n\nbody` via the gh CLI.
 *
 * Accepted forms:
 *   https://github.com/owner/repo/issues/123
 *   owner/repo#123
 *   123                           (uses gh's current-repo default)
 */
function fetchIssue(issueRef: string): string {
  let repoArgs: string[] = [];
  let issueArg = issueRef;

  const urlMatch = ISSUE_URL_RE.exec(issueRef);
  const refMatch = ISSUE_REF_RE.exec(issueRef);
  if (urlMatch) {
    const [, owner, repo, num] = urlMatch;
    repoArgs = ['--repo', `${owner}/${repo}`];
    issueArg = num;
  } else if (refMatch) {
    const [, owner, repo, num] = refMatch;
    repoArgs = ['--repo', `${owner}/${repo}`];
    issueArg = num;
  } else if (!/^\d+$/.test(issueRef)) {
    // Python formats the ref with repr() → single quotes. Match that.
    throw new IssueResolveError(
      `Unrecognized --issue ref: ${pyRepr(issueRef)}. Use a URL, owner/repo#NUMBER, ` +
        `or a plain issue number (current repo).`,
    );
  }

  const cmd = ['issue', 'view', issueArg, '--json', 'title,body', ...repoArgs];
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  const result = spawnSync('gh', cmd, { encoding: 'utf8', env });

  if (result.error) {
    // Python special-cases FileNotFoundError (gh not on PATH).
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new IssueResolveError(
        'gh CLI not found on PATH. Install from https://cli.github.com/ ' +
          'or pass --task instead of --issue.',
      );
    }
    throw new IssueResolveError(String(result.error.message ?? result.error));
  }

  if (result.status !== 0) {
    const detail = (result.stderr || '').trim() || (result.stdout || '').trim();
    throw new IssueResolveError(`gh issue view failed (exit ${result.status}):\n${detail}`);
  }

  let data: { title?: string | null; body?: string | null };
  try {
    data = JSON.parse(result.stdout);
  } catch (e) {
    throw new IssueResolveError(`gh returned non-JSON output: ${(e as Error).message}`);
  }
  const title = (data.title ?? '').trim();
  const body = (data.body ?? '').trim();
  return `${title}\n\n${body}`.trim();
}

export function runMatch(args: string[]): number {
  let pipelinesDir: string | undefined;
  let task: string | undefined;
  let issue: string | undefined;
  let top = 3;
  // Default 2: a manifest is hard-excluded only when the task shares >= 2 of its
  // Scope.Out terms, so a single incidental shared word can't drop a correct
  // pipeline. Mirrors the matchPipelines() library default. Override with
  // --neg-threshold.
  let negThreshold = 2;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pipelines-dir') pipelinesDir = args[++i];
    else if (a.startsWith('--pipelines-dir=')) pipelinesDir = a.slice('--pipelines-dir='.length);
    else if (a === '--task') task = args[++i];
    else if (a.startsWith('--task=')) task = a.slice('--task='.length);
    else if (a === '--issue') issue = args[++i];
    else if (a.startsWith('--issue=')) issue = a.slice('--issue='.length);
    else if (a === '--top') top = parseInt(args[++i] ?? '', 10);
    else if (a.startsWith('--top=')) top = parseInt(a.slice('--top='.length), 10);
    else if (a === '--neg-threshold') negThreshold = parseInt(args[++i] ?? '', 10);
    else if (a.startsWith('--neg-threshold='))
      negThreshold = parseInt(a.slice('--neg-threshold='.length), 10);
  }

  // argparse: --pipelines-dir is required; exactly one of --task/--issue required.
  if (!pipelinesDir) {
    process.stderr.write('pipeline match: --pipelines-dir is required\n');
    return 2;
  }
  if ((task === undefined) === (issue === undefined)) {
    process.stderr.write('pipeline match: exactly one of --task or --issue is required\n');
    return 2;
  }
  if (!Number.isFinite(top)) top = 3;
  if (!Number.isFinite(negThreshold)) negThreshold = 2;

  // Path(args.pipelines_dir).expanduser().resolve()
  const resolvedDir = resolve(expanduser(pipelinesDir));
  let isDir = false;
  try {
    isDir = statSync(resolvedDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    process.stderr.write(
      `ERROR: pipelines-dir does not exist or is not a directory: ${resolvedDir}\n`,
    );
    return 1;
  }

  let taskText: string;
  if (issue !== undefined) {
    try {
      taskText = fetchIssue(issue);
    } catch (e) {
      if (e instanceof IssueResolveError) {
        process.stderr.write(`ERROR: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
  } else {
    taskText = task ?? '';
  }

  if (!taskText.trim()) {
    process.stderr.write('ERROR: empty task text after resolution.\n');
    return 2;
  }

  const output = matchPipelines(resolvedDir, taskText, { top, negThreshold });
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  return 0;
}
