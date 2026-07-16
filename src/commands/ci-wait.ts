// `pipeline ci-wait [--pr <ref> | --branch <name> | --sha <sha>] [--repo <path>]
//                   [--timeout <sec>] [--interval <sec>] [--grace <sec>]
//                   [--fail-fast|--no-fail-fast] [--json] [--verbose]`
//
// Token-efficient CI gate: block until GitHub CI for a pull request (or a
// commit on a branch — default: the repo's default branch) reaches a terminal
// state, polling `gh` IN-PROCESS and printing ONE compact result at the end.
// The point: an agent pays a single Bash spawn + one JSON line instead of an
// LLM-driven poll loop (sleep → gh → read → repeat), which burns a full agent
// turn per poll and re-reads the whole check table into context every time.
//
// Modes (mutually exclusive; no selector → commit mode on the default branch):
//   --pr <ref>       `gh pr checks <ref> --json name,state,bucket,link` — <ref>
//                    is a PR number, URL, or head-branch name (whatever gh
//                    accepts). Covers Actions AND third-party checks/statuses.
//   --branch <name>  resolve the branch's HEAD sha once at start (`gh api
//                    repos/{owner}/{repo}/commits/<name>`), then poll the
//                    commit check-runs API for that sha (the sha is pinned —
//                    a later push starts a NEW gate, not a moving target).
//   --sha <sha>      same as --branch but skips resolution.
//
// Terminal decision:
//   - success  → exit 0: every check finished in pass/skipping (PR buckets) or
//                success/skipped/neutral (check-run conclusions).
//   - failure  → exit 1: any check landed in fail/cancel (or a failing
//                conclusion). FAIL-FAST by default — the first failed check
//                ends the wait while others still run (the gate has already
//                failed); `--no-fail-fast` waits for the full picture.
//   - timeout  → exit 3 after --timeout seconds (default 1800), listing the
//                still-pending check names.
//   - no-checks→ exit 4 when NO checks/runs appear within --grace seconds
//                (default 120) — distinct from success so a caller can't
//                mistake "CI never started" for a green gate.
//   - usage/env→ exit 2 (bad flags, gh missing/unauthenticated, unresolvable
//                branch).
//
// Output: silent while polling (opt-in `--verbose` heartbeats go to stderr);
// the single result goes to stdout — a human one-liner, or one JSON object
// with `--json`. All gh/git calls go through the injectable GhRunner/GitRunner
// seams (lib/git.ts) and time/sleep through injectable deps, so tests drive
// the full state machine with scripted gh outputs and zero real waiting.

import { resolve } from 'node:path';
import { realGh, realGit, ghAvailable, sleepSync, type GhRunner, type GitRunner } from '../lib/git';

const USAGE =
  'usage: pipeline ci-wait [--pr <number|url|branch> | --branch <name> | --sha <sha>]\n' +
  '                        [--repo <path>] [--timeout <sec>] [--interval <sec>]\n' +
  '                        [--grace <sec>] [--fail-fast|--no-fail-fast] [--json] [--verbose]\n';

export const DEFAULT_TIMEOUT_S = 1800;
export const DEFAULT_INTERVAL_S = 15;
export const DEFAULT_GRACE_S = 120;

// PR-mode buckets (`gh pr checks --json bucket`) and commit-mode conclusions
// (check-runs API) that count as a PASSING terminal state. Anything terminal
// and not in these sets is a failure (fail, cancel, timed_out, action_required,
// startup_failure, stale, …) — unknown values fail CLOSED, never open.
const PASS_BUCKETS = new Set(['pass', 'skipping']);
const PENDING_BUCKETS = new Set(['pending']);
const PASS_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

export type CiWaitStatus = 'success' | 'failure' | 'timeout' | 'no-checks';

export interface CiCheck {
  name: string;
  /** Raw bucket (PR mode) or status/conclusion (commit mode) that decided it. */
  state: string;
  link?: string | null;
}

export interface CiWaitResult {
  status: CiWaitStatus;
  mode: 'pr' | 'commit';
  /** The selector as given (--pr value, branch name, or sha). */
  ref: string;
  /** Pinned commit sha (commit mode); null in PR mode (gh tracks the PR head). */
  sha: string | null;
  elapsed_s: number;
  polls: number;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  failed_checks: CiCheck[];
  pending_checks: string[];
  detail: string | null;
}

export interface CiWaitDeps {
  gh: GhRunner;
  git: GitRunner;
  /** Milliseconds since some fixed origin — only differences are used. */
  now: () => number;
  sleep: (ms: number) => void;
  /** Env probe for the gh binary (skipped when a fake gh is injected). */
  ghOk: () => boolean;
}

const realDeps: CiWaitDeps = {
  gh: realGh,
  git: realGit,
  now: () => Date.now(),
  sleep: sleepSync,
  ghOk: ghAvailable,
};

interface ParsedArgs {
  pr: string | null;
  branch: string | null;
  sha: string | null;
  repo: string | null;
  timeoutS: number;
  intervalS: number;
  graceS: number;
  failFast: boolean;
  json: boolean;
  verbose: boolean;
}

export function parseCiWaitArgs(args: string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = {
    pr: null,
    branch: null,
    sha: null,
    repo: null,
    timeoutS: DEFAULT_TIMEOUT_S,
    intervalS: DEFAULT_INTERVAL_S,
    graceS: DEFAULT_GRACE_S,
    failFast: true,
    json: false,
    verbose: false,
  };
  const takeValue = (flag: string, i: number): string | { error: string } => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) return { error: `${flag} requires a value` };
    return v;
  };
  const takeSeconds = (flag: string, i: number): number | { error: string } => {
    const v = takeValue(flag, i);
    if (typeof v !== 'string') return v;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { error: `${flag} requires a non-negative number of seconds` };
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--pr': {
        const v = takeValue(a, i);
        if (typeof v !== 'string') return v;
        out.pr = v;
        i++;
        break;
      }
      case '--branch': {
        const v = takeValue(a, i);
        if (typeof v !== 'string') return v;
        out.branch = v;
        i++;
        break;
      }
      case '--sha': {
        const v = takeValue(a, i);
        if (typeof v !== 'string') return v;
        out.sha = v;
        i++;
        break;
      }
      case '--repo': {
        const v = takeValue(a, i);
        if (typeof v !== 'string') return v;
        out.repo = v;
        i++;
        break;
      }
      case '--timeout': {
        const v = takeSeconds(a, i);
        if (typeof v !== 'number') return v;
        out.timeoutS = v;
        i++;
        break;
      }
      case '--interval': {
        const v = takeSeconds(a, i);
        if (typeof v !== 'number') return v;
        out.intervalS = v;
        i++;
        break;
      }
      case '--grace': {
        const v = takeSeconds(a, i);
        if (typeof v !== 'number') return v;
        out.graceS = v;
        i++;
        break;
      }
      case '--fail-fast': // the default — accepted so a caller can state intent
        out.failFast = true;
        break;
      case '--no-fail-fast':
        out.failFast = false;
        break;
      case '--json':
        out.json = true;
        break;
      case '--verbose':
        out.verbose = true;
        break;
      default:
        return { error: `unknown option '${a}'` };
    }
  }
  const selectors = [out.pr, out.branch, out.sha].filter((s) => s !== null).length;
  if (selectors > 1) return { error: 'use at most ONE of --pr / --branch / --sha' };
  return out;
}

// ---------------------------------------------------------------------------
// Poll snapshot — one normalized view regardless of mode
// ---------------------------------------------------------------------------

interface Snapshot {
  /** null when the poll itself failed in a way that means "no data yet". */
  checks: CiCheck[] | null;
  pending: CiCheck[];
  passed: CiCheck[];
  failed: CiCheck[];
  /** stderr of a failed gh call, for diagnostics. */
  ghError: string | null;
}

function emptySnapshot(ghError: string | null): Snapshot {
  return { checks: null, pending: [], passed: [], failed: [], ghError };
}

function classify(checks: CiCheck[], pendingStates: Set<string>, passStates: Set<string>): Snapshot {
  const pending: CiCheck[] = [];
  const passed: CiCheck[] = [];
  const failed: CiCheck[] = [];
  for (const c of checks) {
    if (pendingStates.has(c.state)) pending.push(c);
    else if (passStates.has(c.state)) passed.push(c);
    else failed.push(c);
  }
  return { checks, pending, passed, failed, ghError: null };
}

/** PR mode: `gh pr checks` — parse stdout REGARDLESS of exit code (gh exits
 *  non-zero while checks are pending/failing, which is exactly the interesting
 *  case). Empty/unparseable stdout → "no data yet" (grace-period territory). */
function snapshotPr(gh: GhRunner, cwd: string, pr: string): Snapshot {
  const r = gh(['pr', 'checks', pr, '--json', 'name,state,bucket,link'], cwd);
  const text = r.stdout.trim();
  if (!text) return emptySnapshot(r.stderr.trim() || null);
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    return emptySnapshot(r.stderr.trim() || `unparseable gh pr checks output: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(rows)) return emptySnapshot('gh pr checks returned non-array JSON');
  const checks: CiCheck[] = rows.map((row) => {
    const o = row as Record<string, unknown>;
    return {
      name: String(o.name ?? o.state ?? 'unnamed'),
      state: String(o.bucket ?? '').toLowerCase(),
      link: typeof o.link === 'string' ? o.link : null,
    };
  });
  return classify(checks, PENDING_BUCKETS, PASS_BUCKETS);
}

/** Commit mode: the check-runs API (covers Actions + third-party check apps).
 *  `--paginate` may emit one JSON array per page — parse line-tolerantly. */
function snapshotCommit(gh: GhRunner, cwd: string, sha: string): Snapshot {
  const r = gh(
    [
      'api',
      `repos/{owner}/{repo}/commits/${sha}/check-runs`,
      '--paginate',
      '--jq',
      '[.check_runs[] | {name, status, conclusion, link: .html_url}]',
    ],
    cwd,
  );
  if (r.code !== 0) return emptySnapshot(r.stderr.trim() || `gh api exited ${r.code}`);
  const rows: Array<Record<string, unknown>> = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const page = JSON.parse(t);
      if (Array.isArray(page)) rows.push(...(page as Array<Record<string, unknown>>));
    } catch {
      // tolerate stray non-JSON lines; the pages we can parse still count
    }
  }
  if (rows.length === 0) return emptySnapshot(null); // no runs (yet) — grace territory
  const checks: CiCheck[] = rows.map((o) => {
    const status = String(o.status ?? '').toLowerCase();
    const conclusion = o.conclusion == null ? '' : String(o.conclusion).toLowerCase();
    return {
      name: String(o.name ?? 'unnamed'),
      // Non-completed → its status (queued/in_progress); completed → conclusion.
      state: status === 'completed' ? conclusion || 'unknown' : status,
      link: typeof o.link === 'string' ? o.link : null,
    };
  });
  return classify(checks, new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested']), PASS_CONCLUSIONS);
}

/** Resolve a branch name to its HEAD sha via the API (works without a local
 *  fetch — the wait is about the REMOTE's CI, not the local checkout). */
function resolveBranchSha(gh: GhRunner, cwd: string, branch: string): string | { error: string } {
  const r = gh(['api', `repos/{owner}/{repo}/commits/${branch}`, '--jq', '.sha'], cwd);
  const sha = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    return { error: `could not resolve branch '${branch}' to a sha: ${r.stderr.trim() || sha || 'no output'}` };
  }
  return sha;
}

/** The remote's default branch (API-first; no local git state required). */
function resolveDefaultBranch(gh: GhRunner, cwd: string): string | { error: string } {
  const r = gh(['api', 'repos/{owner}/{repo}', '--jq', '.default_branch'], cwd);
  const name = r.stdout.trim();
  if (r.code !== 0 || !name) {
    return { error: `could not resolve the default branch: ${r.stderr.trim() || 'no output'}` };
  }
  return name;
}

// ---------------------------------------------------------------------------
// The wait loop
// ---------------------------------------------------------------------------

export function runCiWait(args: string[], deps: CiWaitDeps = realDeps): number {
  const parsed = parseCiWaitArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`pipeline ci-wait: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const cwd = resolve(parsed.repo ?? process.cwd());
  if (deps.ghOk && !deps.ghOk()) {
    process.stderr.write("pipeline ci-wait: the 'gh' CLI is required but not invokable (install/auth gh)\n");
    return 2;
  }

  // Resolve the selector into a mode + a pinned target.
  let mode: 'pr' | 'commit';
  let ref: string;
  let sha: string | null = null;
  if (parsed.pr !== null) {
    mode = 'pr';
    ref = parsed.pr;
  } else if (parsed.sha !== null) {
    mode = 'commit';
    ref = parsed.sha;
    sha = parsed.sha;
  } else {
    mode = 'commit';
    let branch = parsed.branch;
    if (branch === null) {
      const def = resolveDefaultBranch(deps.gh, cwd);
      if (typeof def !== 'string') {
        process.stderr.write(`pipeline ci-wait: ${def.error}\n`);
        return 2;
      }
      branch = def;
    }
    ref = branch;
    const resolved = resolveBranchSha(deps.gh, cwd, branch);
    if (typeof resolved !== 'string') {
      process.stderr.write(`pipeline ci-wait: ${resolved.error}\n`);
      return 2;
    }
    sha = resolved;
  }

  const started = deps.now();
  const elapsedS = (): number => Math.round((deps.now() - started) / 1000);
  let polls = 0;
  let lastGhError: string | null = null;

  const result = (status: CiWaitStatus, snap: Snapshot | null, detail: string | null): CiWaitResult => ({
    status,
    mode,
    ref,
    sha,
    elapsed_s: elapsedS(),
    polls,
    total: snap?.checks?.length ?? 0,
    passed: snap?.passed.length ?? 0,
    failed: snap?.failed.length ?? 0,
    pending: snap?.pending.length ?? 0,
    failed_checks: snap?.failed ?? [],
    pending_checks: (snap?.pending ?? []).map((c) => c.name),
    detail,
  });

  const emit = (res: CiWaitResult): number => {
    if (parsed.json) {
      process.stdout.write(JSON.stringify(res) + '\n');
    } else {
      const target = mode === 'pr' ? `PR ${ref}` : `${ref}${sha && sha !== ref ? ` @ ${sha.slice(0, 10)}` : ''}`;
      const head =
        res.status === 'success'
          ? `success — ${res.passed}/${res.total} checks passed`
          : res.status === 'failure'
            ? `FAILURE — ${res.failed} failed: ${res.failed_checks.map((c) => `${c.name} (${c.state})`).join(', ')}`
            : res.status === 'timeout'
              ? `TIMEOUT after ${res.elapsed_s}s — still pending: ${res.pending_checks.join(', ') || '(unknown)'}`
              : `NO CHECKS appeared within the grace period${res.detail ? ` (${res.detail})` : ''}`;
      process.stdout.write(`ci-wait [${target}]: ${head} (${res.elapsed_s}s, ${res.polls} polls)\n`);
    }
    return res.status === 'success' ? 0 : res.status === 'failure' ? 1 : res.status === 'timeout' ? 3 : 4;
  };

  const heartbeat = (snap: Snapshot): void => {
    if (!parsed.verbose) return;
    const n = snap.checks?.length ?? 0;
    process.stderr.write(
      `ci-wait: poll ${polls} — ${snap.passed.length}/${n} passed, ${snap.pending.length} pending, ${snap.failed.length} failed (${elapsedS()}s)\n`,
    );
  };

  let sawChecks = false;
  for (;;) {
    polls++;
    const snap = mode === 'pr' ? snapshotPr(deps.gh, cwd, ref) : snapshotCommit(deps.gh, cwd, sha as string);
    if (snap.ghError) lastGhError = snap.ghError;

    if (snap.checks !== null && snap.checks.length > 0) {
      sawChecks = true;
      heartbeat(snap);
      if (parsed.failFast && snap.failed.length > 0) {
        return emit(result('failure', snap, snap.pending.length > 0 ? `fail-fast with ${snap.pending.length} checks still pending` : null));
      }
      if (snap.pending.length === 0) {
        return emit(result(snap.failed.length > 0 ? 'failure' : 'success', snap, null));
      }
    } else if (parsed.verbose) {
      process.stderr.write(`ci-wait: poll ${polls} — no checks reported yet (${elapsedS()}s)\n`);
    }

    const elapsed = elapsedS();
    if (!sawChecks && elapsed >= parsed.graceS) {
      return emit(result('no-checks', null, lastGhError));
    }
    if (elapsed >= parsed.timeoutS) {
      return emit(result('timeout', snap.checks !== null ? snap : null, lastGhError));
    }
    deps.sleep(parsed.intervalS * 1000);
  }
}
