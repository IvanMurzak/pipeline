// git-bash.ts — "is there a Git Bash on this Windows machine?", answered the
// way the consumer that needs it actually answers it.
//
// WHY THIS EXISTS. Since plugin 0.98.0 every Claude Code hook the Pipeline
// plugin registers is pinned to `"shell": "bash"`. On Windows Claude Code
// resolves that pin to Git Bash and — because of the pin — throws before
// spawning when it cannot find one. That throw is classified
// `non_blocking_error`, so the tool call still proceeds: the user is not
// stopped, they are simply shown an error, once per hook. On a machine with no
// Git Bash EVERY one of the plugin's ten hooks fails that way, so the symptom
// a user actually meets is a wall of errors — or, worse, hooks that look
// installed and quietly never run.
//
// `pipeline init` is the surface that reaches a Windows user before any hook
// ever fires, and it already preflights prerequisites, so that is where this
// gets used (see `commands/init.ts`).
//
// ── PREFIX-BASED, NOT PATH-BASED — the whole point ─────────────────────────
// The obvious implementation, "is `bash` on PATH?", is worse than no check at
// all. A bare `bash` on a Windows PATH is very often WSL's or MSYS2's, neither
// of which Claude Code will ever select; a check that greens on one of those
// retires the user's only warning while leaving every hook just as broken. So
// this walks the SAME candidate ladder the consumer walks —
// `CLAUDE_CODE_GIT_BASH_PATH`, `C:\Program Files\Git\bin\bash.exe`, the
// `(x86)` variant, then a `where.exe git`-relative guess — and reports `found`
// only when one of THOSE files exists.
//
// ⚠ The remedy this must never suggest is `"shell": "powershell"`. Claude
// Code's own error text suggests it; for this plugin it re-opens the very
// fail-open the bash pin closes. Install Git Bash, or point
// `CLAUDE_CODE_GIT_BASH_PATH` at an existing one — those are the only two
// remedies this module names.
//
// Shape follows `lib/loopback-oauth.ts`'s `decidePreflightFallback`: a pure
// decision over injected inputs (`detectGitBash`), plus a thin real-wiring
// factory (`realGitBashProbe`) that is the only part touching the OS. Every
// path decision uses `node:path`'s **win32** flavour explicitly, so the ladder
// is exercisable — and exercised — on the Linux CI runner.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { win32 as winPath } from 'node:path';

/** The env var Claude Code reads to override Git Bash discovery. */
export const GIT_BASH_PATH_ENV = 'CLAUDE_CODE_GIT_BASH_PATH';

/** The two fixed-prefix locations a default Git for Windows install uses.
 *  Deliberately literal rather than derived from `%ProgramFiles%`: these are
 *  the paths the consumer probes, and matching it exactly is the point. */
export const PROGRAM_FILES_GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
export const PROGRAM_FILES_X86_GIT_BASH = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe';

/** Which rung of the ladder answered — carried so a report can say *why* a
 *  machine is considered fine, not just that it is. */
export type GitBashSource = 'env' | 'program-files' | 'program-files-x86' | 'git-relative';

export type GitBashDetection =
  /** Not Windows — `bash` is always present, so the check does not run. */
  | { status: 'not-applicable' }
  | { status: 'found'; path: string; source: GitBashSource }
  /** `configuredPath` is set only when `CLAUDE_CODE_GIT_BASH_PATH` named a
   *  path that does not exist — a typo'd override, which deserves a different
   *  sentence than "you never installed it". */
  | { status: 'missing'; configuredPath?: string };

export interface GitBashProbe {
  /** `process.platform` shape ('win32' | 'darwin' | 'linux' | …). */
  platform: string;
  env: Record<string, string | undefined>;
  /** True iff the path names an existing FILE (not a directory). */
  fileExists: (p: string) => boolean;
  /** Absolute path of `git` as `where.exe git` resolves it, or null. Called
   *  ONLY as the last rung — the fixed prefixes answer the common case with
   *  no subprocess at all. */
  gitExePath: () => string | null;
}

/** `…\Git\cmd\git.exe` → `…\Git\bin\bash.exe`. Windows path semantics are
 *  applied explicitly (`path.win32`) rather than inherited from the host, so
 *  this splits backslashes correctly when the unit tests run on Linux. */
export function gitRelativeBashPath(gitExePath: string): string | null {
  const binDir = winPath.dirname(gitExePath); // …\Git\cmd
  const gitRoot = winPath.dirname(binDir); // …\Git
  // dirname() is idempotent at a filesystem root ('C:\' → 'C:\'), which is the
  // one case where the guess would be nonsense.
  if (!gitRoot || gitRoot === binDir) return null;
  return winPath.join(gitRoot, 'bin', 'bash.exe');
}

/**
 * The ladder, in order. Pure over `probe`, so every rung — and the non-Windows
 * no-op — is testable with no filesystem and no `where.exe`.
 *
 * Note what this deliberately does NOT do: consult `PATH`. See the module
 * header — a PATH hit is usually a bash Claude Code will not select.
 */
export function detectGitBash(probe: GitBashProbe): GitBashDetection {
  if (probe.platform !== 'win32') return { status: 'not-applicable' };

  const configured = probe.env[GIT_BASH_PATH_ENV]?.trim();
  if (configured) {
    // An override that points nowhere does NOT fall through to the defaults.
    // Claude Code honours the variable, so a wrong value breaks the hooks just
    // as thoroughly as no Git Bash at all — and silently reporting the Program
    // Files copy instead would hide the typo that is the actual fault.
    if (probe.fileExists(configured)) return { status: 'found', path: configured, source: 'env' };
    return { status: 'missing', configuredPath: configured };
  }

  if (probe.fileExists(PROGRAM_FILES_GIT_BASH)) {
    return { status: 'found', path: PROGRAM_FILES_GIT_BASH, source: 'program-files' };
  }
  if (probe.fileExists(PROGRAM_FILES_X86_GIT_BASH)) {
    return { status: 'found', path: PROGRAM_FILES_X86_GIT_BASH, source: 'program-files-x86' };
  }

  const gitExe = probe.gitExePath();
  if (gitExe) {
    const guess = gitRelativeBashPath(gitExe);
    if (guess && probe.fileExists(guess)) return { status: 'found', path: guess, source: 'git-relative' };
  }

  return { status: 'missing' };
}

// ---------------------------------------------------------------------------
// The warning
// ---------------------------------------------------------------------------

const INSTALL_URL = 'https://git-scm.com/download/win';
const INSTALL_WINGET = 'winget install --id Git.Git -e --source winget';

/** The consequence, in one clause, phrased so it reads correctly after both
 *  an em-dash and "Without it ". Shared by the human block and the one-line
 *  `--json` summary so the two can never drift into naming different
 *  consequences. */
const CONSEQUENCE = "the Pipeline plugin's Claude Code hooks will not run";

/** What is wrong, when `CLAUDE_CODE_GIT_BASH_PATH` is the thing that is
 *  wrong. A typo'd override deserves a different sentence from "you never
 *  installed it" — otherwise the user goes and re-installs a Git Bash they
 *  already have. */
function overrideFault(configuredPath: string): string {
  return `Git Bash not found — ${GIT_BASH_PATH_ENV} points at ${configuredPath}, which does not exist.`;
}

/** The remedies, identical in both variants: the two install routes, then the
 *  override for a non-standard install. Indented as continuation lines. */
const REMEDY_LINES: string[] = [
  `    Install it:  ${INSTALL_URL}`,
  `             or  ${INSTALL_WINGET}`,
  `    Already installed somewhere non-standard? Set ${GIT_BASH_PATH_ENV} to its bash.exe.`,
];

/** The human-facing block, as lines WITHOUT leading indentation (the caller
 *  owns its own indent). ONE warning: what is wrong, what it breaks, why, and
 *  the two ways to fix it. Kept under ~95 columns per line so a default
 *  terminal does not re-wrap it into soup. */
export function gitBashWarningLines(d: Extract<GitBashDetection, { status: 'missing' }>): string[] {
  const head = d.configuredPath
    ? [`⚠ ${overrideFault(d.configuredPath)}`, `    Without it ${CONSEQUENCE}.`]
    : [`⚠ Git Bash not found — ${CONSEQUENCE}.`];
  return [
    ...head,
    '    Every hook is pinned to bash; on Windows Claude Code runs bash hooks with Git Bash.',
    ...REMEDY_LINES,
  ];
}

/** The same warning as ONE line, for `--json`'s `warnings[]` array (mirrors
 *  the `cloud: …` / `claude not found …` entries beside it). */
export function gitBashWarningSummary(d: Extract<GitBashDetection, { status: 'missing' }>): string {
  const fault = d.configuredPath ? overrideFault(d.configuredPath) : 'Git Bash not found.';
  return (
    `git-bash: ${fault} Without it ${CONSEQUENCE} — install from ${INSTALL_URL} ` +
    `or run \`${INSTALL_WINGET}\`, or set ${GIT_BASH_PATH_ENV} to an existing bash.exe`
  );
}

// ---------------------------------------------------------------------------
// Real wiring (the only part that touches the OS)
// ---------------------------------------------------------------------------

function realFileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `where.exe git`, first hit only. Never throws — a machine with no `git` at
 *  all is an ordinary answer here, not an error. */
function realGitExePath(): string | null {
  const r = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
  if (r.error || (r.status ?? 1) !== 0) return null;
  const first = (r.stdout ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  return first ?? null;
}

export function realGitBashProbe(): GitBashProbe {
  return {
    platform: process.platform,
    env: process.env,
    fileExists: realFileExists,
    gitExePath: realGitExePath,
  };
}
