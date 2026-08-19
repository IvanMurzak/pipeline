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
// ── THE LADDER IS THE CONSUMER'S, NOT A PLAUSIBLE ONE ──────────────────────
// Every rule below was read out of the shipped dispatcher rather than guessed,
// and the details that look like nitpicks are the ones that decide whether
// this check tells the truth:
//
//   1. `CLAUDE_CODE_GIT_BASH_PATH`, accepted only when BOTH the file exists
//      AND its basename is one of bash.exe / sh.exe / bash / sh. A path that
//      exists but is named something else — `git-bash.exe`, the launcher at a
//      portable install's root, which is the icon users actually call "Git
//      Bash" — is REJECTED there, so accepting it here would be a false
//      "found": we would go silent while all ten hooks throw.
//   2. `C:\Program Files\Git\bin\bash.exe`
//   3. `C:\Program Files (x86)\Git\bin\bash.exe`
//   4. `<dirname(dirname(where.exe git))>\bin\bash.exe`
//
// A BAD OVERRIDE FALLS THROUGH — it does not stop the ladder. The dispatcher
// logs `CLAUDE_CODE_GIT_BASH_PATH "…" not found` (or `is not a bash/sh
// binary`) `; falling back to auto-detection` and carries on into rungs 2-4.
// So a stale variable on a machine with a normal `C:\Program Files\Git`
// install is a machine whose hooks WORK, and reporting `missing` for it would
// send the user to reinstall software they already have — and hand any script
// gating on the `--json` field a false negative on a healthy machine. The bad
// override is still worth surfacing, so it rides along as `ignoredOverride`:
// a note, never the verdict.
//
// ── PREFIX-BASED, NOT PATH-BASED ───────────────────────────────────────────
// The obvious implementation, "is `bash` on PATH?", is worse than no check at
// all. A bare `bash` on a Windows PATH is very often WSL's or MSYS2's, neither
// of which Claude Code will ever select; a check that greens on one of those
// retires the user's only warning while leaving every hook just as broken.
// (Rung 4 does consult PATH — but through `where.exe git`, to locate GIT, and
// it then requires a bash beside it. That is the consumer's rule, not a PATH
// lookup for bash.)
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
// path decision uses `node:path`'s **win32** flavour explicitly — as the
// dispatcher itself does, binding `path/win32` — so the ladder is exercisable
// (and exercised) on the Linux CI runner.

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

/** The only basenames the consumer accepts for an override. Anything else —
 *  `git-bash.exe` above all — is rejected there and must be rejected here. */
const BASH_BASENAMES = new Set(['bash.exe', 'sh.exe', 'bash', 'sh']);

/** How long `where.exe git` may take before we give up on rung 4. It walks
 *  every PATH entry, and one dead UNC entry stalls it for tens of seconds —
 *  which, on the `init` path, is a blank screen with no explanation. */
const WHERE_TIMEOUT_MS = 5_000;

/** Which rung of the ladder answered — carried so a report can say *why* a
 *  machine is considered fine, not just that it is. */
export type GitBashSource = 'env' | 'program-files' | 'program-files-x86' | 'git-relative';

/** Why an override was not usable — the same two cases the dispatcher's own
 *  log line distinguishes, and worth distinguishing here because they send the
 *  user to different fixes (fix the path vs point it at a real bash). */
export type OverrideFault = 'not-found' | 'not-a-bash-binary';

export interface IgnoredOverride {
  path: string;
  reason: OverrideFault;
}

export type GitBashDetection =
  /** Not Windows — `bash` is always present, so the check does not run. */
  | { status: 'not-applicable' }
  /** `ignoredOverride` means: a bad `CLAUDE_CODE_GIT_BASH_PATH` was set and
   *  auto-detection answered anyway. Hooks WORK — this is a note, not a
   *  warning, and never changes the status. */
  | { status: 'found'; path: string; source: GitBashSource; ignoredOverride?: IgnoredOverride }
  /** The whole ladder came up empty. `ignoredOverride` (when present) says a
   *  bad override contributed, so the user is not told to install something
   *  they may only have mis-pointed at. */
  | { status: 'missing'; ignoredOverride?: IgnoredOverride };

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

/** The basename half of rung 1's two-part predicate. */
export function looksLikeBashBinary(p: string): boolean {
  return BASH_BASENAMES.has(winPath.basename(p).toLowerCase());
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
 * Note what this deliberately does NOT do: consult `PATH` for `bash`. See the
 * module header.
 */
export function detectGitBash(probe: GitBashProbe): GitBashDetection {
  if (probe.platform !== 'win32') return { status: 'not-applicable' };

  // The RAW value, untrimmed: the dispatcher does not trim, and Windows strips
  // trailing spaces from a path but not leading ones — so ` C:\…\bash.exe` is
  // rejected there and must not be silently repaired into a `found` here.
  // Empty/whitespace-only still counts as unset (the classic "configured but
  // empty" CI mistake): the dispatcher would reject such a value on its
  // basename and fall through, which is exactly what treating it as unset
  // does, minus a nonsense note about a variable full of spaces.
  const raw = probe.env[GIT_BASH_PATH_ENV];
  const configured = raw !== undefined && raw.trim() !== '' ? raw : undefined;

  let ignoredOverride: IgnoredOverride | undefined;
  if (configured !== undefined) {
    // BOTH conditions, not just existence — see BASH_BASENAMES.
    const exists = probe.fileExists(configured);
    if (exists && looksLikeBashBinary(configured)) {
      return { status: 'found', path: configured, source: 'env' };
    }
    // Rejected — but NOT terminal. The dispatcher warns and falls back to
    // auto-detection, so this is a note carried down the remaining rungs.
    // `not-found` wins when both are wrong, matching the dispatcher's own
    // message precedence.
    ignoredOverride = { path: configured, reason: exists ? 'not-a-bash-binary' : 'not-found' };
  }

  const foundAt = (path: string, source: GitBashSource): GitBashDetection =>
    ignoredOverride ? { status: 'found', path, source, ignoredOverride } : { status: 'found', path, source };

  if (probe.fileExists(PROGRAM_FILES_GIT_BASH)) return foundAt(PROGRAM_FILES_GIT_BASH, 'program-files');
  if (probe.fileExists(PROGRAM_FILES_X86_GIT_BASH)) return foundAt(PROGRAM_FILES_X86_GIT_BASH, 'program-files-x86');

  const gitExe = probe.gitExePath();
  if (gitExe) {
    const guess = gitRelativeBashPath(gitExe);
    if (guess && probe.fileExists(guess)) return foundAt(guess, 'git-relative');
  }

  return ignoredOverride ? { status: 'missing', ignoredOverride } : { status: 'missing' };
}

// ---------------------------------------------------------------------------
// The warning (missing) and the note (found despite a bad override)
// ---------------------------------------------------------------------------

const INSTALL_URL = 'https://git-scm.com/download/win';
const INSTALL_WINGET = 'winget install --id Git.Git -e --source winget';

/** The consequence, in one clause, phrased so it reads correctly after an
 *  em-dash. Shared by the human block and the one-line `--json` summary so the
 *  two can never drift into naming different consequences. */
const CONSEQUENCE = "the Pipeline plugin's Claude Code hooks will not run";

/** What is wrong with the override, in the dispatcher's own two flavours. */
function overrideFault(o: IgnoredOverride): string {
  return o.reason === 'not-found'
    ? `${GIT_BASH_PATH_ENV} points at ${o.path}, which does not exist.`
    : `${GIT_BASH_PATH_ENV} points at ${o.path}, which is not a bash/sh binary.`;
}

/** The remedies, identical in both variants: the two install routes, then the
 *  override for a non-standard install. Indented as continuation lines. */
const REMEDY_LINES: string[] = [
  `    Install it:  ${INSTALL_URL}`,
  `             or  ${INSTALL_WINGET}`,
  `    Already installed somewhere non-standard? Set ${GIT_BASH_PATH_ENV} to its bash.exe.`,
];

/** The human-facing block for a MISSING Git Bash, as lines WITHOUT leading
 *  indentation (the caller owns its own indent). ONE warning: what is wrong,
 *  what it breaks, why, and the two ways to fix it. Kept under ~95 columns per
 *  line so a default terminal does not re-wrap it into soup. */
export function gitBashWarningLines(d: Extract<GitBashDetection, { status: 'missing' }>): string[] {
  const override = d.ignoredOverride
    ? [
        `    ${overrideFault(d.ignoredOverride)}`,
        '    Claude Code ignores a bad override and auto-detects — and that found nothing either.',
      ]
    : [];
  return [
    `⚠ Git Bash not found — ${CONSEQUENCE}.`,
    ...override,
    '    Every hook is pinned to bash; on Windows Claude Code runs bash hooks with Git Bash.',
    ...REMEDY_LINES,
  ];
}

/** The INFORMATIONAL note for a machine whose hooks are fine but whose
 *  override is junk. No warning glyph and no exit-code change: auto-detection
 *  answered, so the machine works — the user is told only so a stale variable
 *  does not stay invisible forever. */
export function gitBashOverrideNoteLines(
  d: Extract<GitBashDetection, { status: 'found' }> & { ignoredOverride: IgnoredOverride },
): string[] {
  return [
    `ℹ ${overrideFault(d.ignoredOverride)}`,
    `    Claude Code ignores it and auto-detects, so hooks will use ${d.path}. Unset the`,
    '    variable, or point it at that path, to silence this.',
  ];
}

/** The missing-case warning as ONE line, for `--json`'s `warnings[]` array
 *  (mirrors the `cloud: …` / `claude not found …` entries beside it). */
export function gitBashWarningSummary(d: Extract<GitBashDetection, { status: 'missing' }>): string {
  const override = d.ignoredOverride ? `${overrideFault(d.ignoredOverride)} Auto-detection found nothing either. ` : '';
  return (
    `git-bash: Git Bash not found. ${override}Without it ${CONSEQUENCE} — install from ${INSTALL_URL} ` +
    `or run \`${INSTALL_WINGET}\`, or set ${GIT_BASH_PATH_ENV} to an existing bash.exe`
  );
}

/** The found-despite-a-bad-override note as ONE line, for `warnings[]`. Says
 *  plainly that hooks are fine, so no script mistakes it for a failure. */
export function gitBashOverrideNoteSummary(
  d: Extract<GitBashDetection, { status: 'found' }> & { ignoredOverride: IgnoredOverride },
): string {
  return (
    `git-bash: ${overrideFault(d.ignoredOverride)} Claude Code ignores it and auto-detects, ` +
    `so hooks will use ${d.path} — nothing is broken; unset the variable to silence this`
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

/**
 * Pick the usable `git` out of `where.exe git`'s stdout — pure, so the one
 * piece of parsing in this module is pinned by tests rather than by a single
 * manual Windows run.
 *
 * Two filters, both the dispatcher's:
 *   - the path must still exist (`where` reports stale PATH entries);
 *   - a hit INSIDE the current directory is SKIPPED. `pipeline init` runs in
 *     whatever directory the user chose — commonly a repo they just cloned —
 *     and a `git.exe` sitting there is attacker-supplied, not the system git.
 * First survivor wins.
 */
export function parseWhereOutput(stdout: string, deps: { cwd: string; fileExists: (p: string) => boolean }): string | null {
  // Trailing separator stripped so the `startsWith(cwd + sep)` test cannot
  // match a sibling directory whose name merely starts with the cwd's.
  const cwd = winPath.resolve(deps.cwd).toLowerCase().replace(/[\\/]+$/, '');
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!deps.fileExists(line)) continue;
    if (winPath.resolve(line).toLowerCase().startsWith(cwd + winPath.sep)) continue;
    return line;
  }
  return null;
}

/** `where.exe git`, resolved ABSOLUTELY. Never a bare `'where.exe'`: libuv's
 *  Windows spawn searches the CURRENT DIRECTORY before PATH, and this runs in
 *  a directory the user picked, so a bare name is a binary-planting vector.
 *  Never throws — a machine with no `git` at all is an ordinary answer here,
 *  not an error (a timeout arrives as `r.error` and reads the same way). */
function realGitExePath(): string | null {
  const systemRoot = process.env.SYSTEMROOT || process.env.SystemRoot || 'C:\\Windows';
  const whereExe = winPath.join(systemRoot, 'System32', 'where.exe');
  const r = spawnSync(whereExe, ['git'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: WHERE_TIMEOUT_MS,
  });
  if (r.error || (r.status ?? 1) !== 0) return null;
  return parseWhereOutput(r.stdout ?? '', { cwd: process.cwd(), fileExists: realFileExists });
}

export function realGitBashProbe(): GitBashProbe {
  return {
    platform: process.platform,
    env: process.env,
    fileExists: realFileExists,
    gitExePath: realGitExePath,
  };
}
