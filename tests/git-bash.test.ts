// Tests for src/lib/git-bash.ts — the Windows-only Git Bash preflight
// (x2-init-git-bash-preflight; how `pipeline init` composes it lives in
// tests/init.test.ts).
//
// EVERYTHING here is driven through the injected `GitBashProbe`: platform,
// filesystem and `where.exe` are all fakes. That is not merely tidy — this
// suite runs on ubuntu-latest as well as windows-latest (see
// .github/workflows/ci.yml's matrix), so a test that touched a real
// `C:\Program Files` would be a test that only ever ran on one of the two.
// `detectGitBash` is pure over the probe, and every path decision inside it
// uses `node:path`'s win32 flavour explicitly, so a Windows ladder is exact
// on a Linux host.

import { describe, expect, test } from 'bun:test';
import {
  detectGitBash,
  gitBashOverrideNoteLines,
  gitBashOverrideNoteSummary,
  gitBashWarningLines,
  gitBashWarningSummary,
  gitRelativeBashPath,
  looksLikeBashBinary,
  parseWhereOutput,
  GIT_BASH_PATH_ENV,
  PROGRAM_FILES_GIT_BASH,
  PROGRAM_FILES_X86_GIT_BASH,
  type GitBashDetection,
  type GitBashProbe,
} from '../src/lib/git-bash';

/** A fake probe. `files` is the whole filesystem; `probed` records every path
 *  asked about, so a test can assert the LADDER ORDER and not just its
 *  answer. */
function probe(opts: {
  platform?: string;
  env?: Record<string, string | undefined>;
  files?: string[];
  gitExe?: string | null;
}): GitBashProbe & { probed: string[]; gitExeCalls: number } {
  const files = new Set(opts.files ?? []);
  const probed: string[] = [];
  const state = { gitExeCalls: 0 };
  return {
    platform: opts.platform ?? 'win32',
    env: opts.env ?? {},
    fileExists: (p) => {
      probed.push(p);
      return files.has(p);
    },
    gitExePath: () => {
      state.gitExeCalls++;
      return opts.gitExe ?? null;
    },
    probed,
    get gitExeCalls() {
      return state.gitExeCalls;
    },
  };
}

const GIT_CMD_EXE = 'C:\\Program Files\\Git\\cmd\\git.exe';

// ---------------------------------------------------------------------------
// Non-Windows: the check does not run at all
// ---------------------------------------------------------------------------

describe('non-Windows', () => {
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    test(`${platform}: not-applicable, and NOTHING is probed`, () => {
      // `bash` is always present on these; the check must not merely return a
      // benign answer, it must not do any work (or spawn `where.exe`, which
      // does not even exist there).
      const p = probe({ platform, files: [] });
      expect(detectGitBash(p)).toEqual({ status: 'not-applicable' });
      expect(p.probed).toEqual([]);
      expect(p.gitExeCalls).toBe(0);
    });
  }

  test('an override env var does not resurrect the check off Windows', () => {
    const p = probe({
      platform: 'linux',
      env: { [GIT_BASH_PATH_ENV]: '/usr/bin/bash' },
      files: ['/usr/bin/bash'],
    });
    expect(detectGitBash(p)).toEqual({ status: 'not-applicable' });
  });
});

// ---------------------------------------------------------------------------
// The ladder, in order
// ---------------------------------------------------------------------------

describe('the detection ladder on win32', () => {
  test('rung 1: CLAUDE_CODE_GIT_BASH_PATH is honoured, and short-circuits', () => {
    const custom = 'D:\\tools\\Git\\bin\\bash.exe';
    const p = probe({
      env: { [GIT_BASH_PATH_ENV]: custom },
      // Program Files also has one — the override must still win, and the
      // default must never even be probed.
      files: [custom, PROGRAM_FILES_GIT_BASH],
    });
    expect(detectGitBash(p)).toEqual({ status: 'found', path: custom, source: 'env' });
    expect(p.probed).toEqual([custom]);
    expect(p.gitExeCalls).toBe(0);
  });

  test('rung 1: an override pointing nowhere FALLS THROUGH — the machine still works', () => {
    // The dispatcher does NOT honour the variable unconditionally: it logs
    // `CLAUDE_CODE_GIT_BASH_PATH "…" not found; falling back to
    // auto-detection` and carries on. So a stale variable on a machine with a
    // normal Program Files install is a machine whose hooks WORK — reporting
    // `missing` there would send the user to reinstall what they already have,
    // and hand a --json consumer a false negative on a healthy box.
    const custom = 'D:\\typo\\bash.exe';
    const p = probe({ env: { [GIT_BASH_PATH_ENV]: custom }, files: [PROGRAM_FILES_GIT_BASH] });
    expect(detectGitBash(p)).toEqual({
      status: 'found',
      path: PROGRAM_FILES_GIT_BASH,
      source: 'program-files',
      // …and the bad variable is still surfaced, as a note rather than a verdict.
      ignoredOverride: { path: custom, reason: 'not-found' },
    });
    expect(p.probed).toEqual([custom, PROGRAM_FILES_GIT_BASH]);
  });

  test('rung 1: a bad override plus an empty ladder is MISSING, and says both', () => {
    const custom = 'D:\\typo\\bash.exe';
    const p = probe({ env: { [GIT_BASH_PATH_ENV]: custom }, files: [] });
    expect(detectGitBash(p)).toEqual({
      status: 'missing',
      ignoredOverride: { path: custom, reason: 'not-found' },
    });
  });

  test('rung 1: an EXISTING file whose basename is not a bash is REJECTED', () => {
    // THE false-found case, reachable by following our own remedy line. A
    // portable Git ships `git-bash.exe` at its root — an existing file, and
    // the icon users actually call "Git Bash". The dispatcher requires the
    // basename to be one of bash.exe / sh.exe / bash / sh, rejects this, and
    // falls back; accepting it here would report `found` while all ten hooks
    // throw.
    const launcher = 'D:\\PortableGit\\git-bash.exe';
    const p = probe({ env: { [GIT_BASH_PATH_ENV]: launcher }, files: [launcher] });
    expect(detectGitBash(p)).toEqual({
      status: 'missing',
      ignoredOverride: { path: launcher, reason: 'not-a-bash-binary' },
    });
  });

  test('rung 1: every basename the dispatcher accepts, case-insensitively', () => {
    for (const name of ['bash.exe', 'sh.exe', 'bash', 'sh', 'BASH.EXE', 'Sh']) {
      const path = `D:\\tools\\${name}`;
      expect(looksLikeBashBinary(path)).toBe(true);
      expect(detectGitBash(probe({ env: { [GIT_BASH_PATH_ENV]: path }, files: [path] }))).toEqual({
        status: 'found',
        path,
        source: 'env',
      });
    }
    for (const name of ['git-bash.exe', 'bash.cmd', 'bashx.exe', 'sh.bat', 'git.exe']) {
      expect(looksLikeBashBinary(`D:\\tools\\${name}`)).toBe(false);
    }
  });

  test('rung 1: the value is used RAW — a leading space is not trimmed away', () => {
    // The dispatcher does not trim, and Windows strips trailing spaces from a
    // path but not leading ones. Silently repairing the value here would
    // report `found` for a value the consumer rejects — the false-found
    // direction again.
    const raw = ' D:\\tools\\Git\\bin\\bash.exe';
    const p = probe({ env: { [GIT_BASH_PATH_ENV]: raw }, files: ['D:\\tools\\Git\\bin\\bash.exe'] });
    expect(detectGitBash(p)).toEqual({
      status: 'missing',
      ignoredOverride: { path: raw, reason: 'not-found' },
    });
    expect(p.probed[0]).toBe(raw); // asked about the untrimmed string
  });

  test('rung 1: a blank override counts as unset — no note, no noise', () => {
    // The classic "configured but empty" CI mistake — same stance as
    // cloudStepDecision's blank PIPELINE_MACHINE_TOKEN. The dispatcher would
    // reject it on its basename and fall through, which is what treating it as
    // unset does, minus a nonsense note about a variable full of spaces.
    const p = probe({ env: { [GIT_BASH_PATH_ENV]: '   ' }, files: [PROGRAM_FILES_GIT_BASH] });
    expect(detectGitBash(p)).toEqual({
      status: 'found',
      path: PROGRAM_FILES_GIT_BASH,
      source: 'program-files',
    });
    expect(p.probed).toEqual([PROGRAM_FILES_GIT_BASH]); // the blank value was never probed
  });

  test('rung 2: the default Program Files install', () => {
    const p = probe({ files: [PROGRAM_FILES_GIT_BASH] });
    expect(detectGitBash(p)).toEqual({
      status: 'found',
      path: PROGRAM_FILES_GIT_BASH,
      source: 'program-files',
    });
    expect(p.gitExeCalls).toBe(0); // no subprocess for the common case
  });

  test('rung 3: the (x86) install', () => {
    const p = probe({ files: [PROGRAM_FILES_X86_GIT_BASH] });
    expect(detectGitBash(p)).toEqual({
      status: 'found',
      path: PROGRAM_FILES_X86_GIT_BASH,
      source: 'program-files-x86',
    });
    expect(p.probed).toEqual([PROGRAM_FILES_GIT_BASH, PROGRAM_FILES_X86_GIT_BASH]);
  });

  test('rung 4: derived from where.exe git — a non-default install location', () => {
    // Git on D:, so neither fixed prefix answers; the only thing that finds it
    // is <dirname(dirname(git))>\bin\bash.exe.
    const p = probe({ gitExe: 'D:\\dev\\Git\\cmd\\git.exe', files: ['D:\\dev\\Git\\bin\\bash.exe'] });
    expect(detectGitBash(p)).toEqual({
      status: 'found',
      path: 'D:\\dev\\Git\\bin\\bash.exe',
      source: 'git-relative',
    });
    // …and only after both fixed prefixes came up empty.
    expect(p.probed).toEqual([PROGRAM_FILES_GIT_BASH, PROGRAM_FILES_X86_GIT_BASH, 'D:\\dev\\Git\\bin\\bash.exe']);
    expect(p.gitExeCalls).toBe(1);
  });

  test('rung 4: a git with no sibling bash is still MISSING', () => {
    // e.g. the WindowsApps `git.exe` shim, or a git installed without the
    // Git Bash component.
    const p = probe({ gitExe: 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\git.exe', files: [] });
    expect(detectGitBash(p)).toEqual({ status: 'missing' });
  });

  test('a bad override rides along all the way down to rung 4', () => {
    const p = probe({
      env: { [GIT_BASH_PATH_ENV]: 'D:\\typo\\bash.exe' },
      gitExe: 'D:\\dev\\Git\\cmd\\git.exe',
      files: ['D:\\dev\\Git\\bin\\bash.exe'],
    });
    expect(detectGitBash(p)).toEqual({
      status: 'found',
      path: 'D:\\dev\\Git\\bin\\bash.exe',
      source: 'git-relative',
      ignoredOverride: { path: 'D:\\typo\\bash.exe', reason: 'not-found' },
    });
  });

  test('nothing anywhere: missing, with no ignoredOverride', () => {
    const p = probe({ files: [], gitExe: null });
    expect(detectGitBash(p)).toEqual({ status: 'missing' });
    expect(p.probed).toEqual([PROGRAM_FILES_GIT_BASH, PROGRAM_FILES_X86_GIT_BASH]);
  });
});

// ---------------------------------------------------------------------------
// The rule that makes the check worth having
// ---------------------------------------------------------------------------

describe('detection is prefix-based, NOT a PATH lookup', () => {
  test('a WSL/MSYS bash on PATH does not count as found', () => {
    // This is the whole point of the task: Claude Code will never select
    // these, so greening on one would retire the user's only warning while
    // leaving all ten hooks just as broken.
    const p = probe({
      env: {
        PATH: 'C:\\msys64\\usr\\bin;C:\\Windows\\System32',
        Path: 'C:\\msys64\\usr\\bin;C:\\Windows\\System32',
      },
      files: ['C:\\msys64\\usr\\bin\\bash.exe', 'C:\\Windows\\System32\\bash.exe'],
    });
    expect(detectGitBash(p)).toEqual({ status: 'missing' });
    // And it never even looked at a PATH directory.
    expect(p.probed).toEqual([PROGRAM_FILES_GIT_BASH, PROGRAM_FILES_X86_GIT_BASH]);
  });
});

// ---------------------------------------------------------------------------
// gitRelativeBashPath
// ---------------------------------------------------------------------------

describe('gitRelativeBashPath', () => {
  test('<dirname(dirname(git))>\\bin\\bash.exe', () => {
    expect(gitRelativeBashPath(GIT_CMD_EXE)).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(gitRelativeBashPath('D:\\portable\\Git\\mingw64\\bin\\git.exe')).toBe(
      'D:\\portable\\Git\\mingw64\\bin\\bash.exe',
    );
  });

  test('windows semantics regardless of the host running the test', () => {
    // On Linux, posix dirname() would return '.' for a backslash path and the
    // guess would be garbage. The implementation pins path.win32 for exactly
    // this reason, so assert it here rather than trusting it.
    expect(gitRelativeBashPath('C:\\a\\b\\git.exe')).toBe('C:\\a\\bin\\bash.exe');
  });

  test('a git at a filesystem root yields no guess', () => {
    expect(gitRelativeBashPath('C:\\git.exe')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseWhereOutput — the module's only parsing logic, and the one place a
// binary-planting hit could slip through
// ---------------------------------------------------------------------------

describe('parseWhereOutput', () => {
  const CWD = 'C:\\Users\\dev\\project';
  const withFiles = (...files: string[]) => ({ cwd: CWD, fileExists: (p: string) => files.includes(p) });

  test('first surviving line, CRLF and blank lines tolerated', () => {
    const out = 'C:\\Program Files\\Git\\cmd\\git.exe\r\nC:\\other\\git.exe\r\n\r\n';
    expect(parseWhereOutput(out, withFiles('C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\other\\git.exe'))).toBe(
      'C:\\Program Files\\Git\\cmd\\git.exe',
    );
  });

  test('a stale PATH entry is skipped, the next real one wins', () => {
    // `where` happily reports a path whose file has since been deleted.
    const out = 'C:\\gone\\git.exe\nC:\\real\\git.exe\n';
    expect(parseWhereOutput(out, withFiles('C:\\real\\git.exe'))).toBe('C:\\real\\git.exe');
  });

  test('a hit INSIDE the current directory is skipped — binary planting', () => {
    // `pipeline init` runs in a directory the user chose, commonly a repo they
    // have just cloned. A `git.exe` sitting there is attacker-supplied, and
    // the dispatcher skips exactly this.
    const planted = `${CWD}\\git.exe`;
    const out = `${planted}\nC:\\Program Files\\Git\\cmd\\git.exe\n`;
    expect(parseWhereOutput(out, withFiles(planted, 'C:\\Program Files\\Git\\cmd\\git.exe'))).toBe(
      'C:\\Program Files\\Git\\cmd\\git.exe',
    );
  });

  test('a planted hit in a SUBdirectory of the cwd is skipped too', () => {
    const planted = `${CWD}\\node_modules\\.bin\\git.exe`;
    expect(parseWhereOutput(`${planted}\n`, withFiles(planted))).toBeNull();
  });

  test('the cwd test is case-insensitive and separator-normalised', () => {
    const planted = 'c:/users/dev/project/git.exe';
    expect(parseWhereOutput(`${planted}\n`, withFiles(planted))).toBeNull();
  });

  test('a sibling directory whose name merely starts with the cwd is NOT skipped', () => {
    // `C:\Users\dev\project-tools` is not inside `C:\Users\dev\project`; a
    // naive startsWith without the separator would drop it.
    const sibling = 'C:\\Users\\dev\\project-tools\\git.exe';
    expect(parseWhereOutput(`${sibling}\n`, withFiles(sibling))).toBe(sibling);
  });

  test('empty / all-filtered output is null', () => {
    expect(parseWhereOutput('', withFiles())).toBeNull();
    expect(parseWhereOutput('\r\n\r\n', withFiles())).toBeNull();
    expect(parseWhereOutput('C:\\gone\\git.exe\n', withFiles())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The warning text — a contract, because it is the only thing the user sees
// ---------------------------------------------------------------------------

describe('the warning', () => {
  const missing: Extract<GitBashDetection, { status: 'missing' }> = { status: 'missing' };

  test('names the consequence and BOTH install routes plus the override', () => {
    const text = gitBashWarningLines(missing).join('\n');
    expect(text).toContain("the Pipeline plugin's Claude Code hooks will not run");
    expect(text).toContain('https://git-scm.com/download/win');
    expect(text).toContain('winget install --id Git.Git -e --source winget');
    expect(text).toContain(GIT_BASH_PATH_ENV);
  });

  test('NEVER suggests "shell": "powershell"', () => {
    // Claude Code's own error text suggests it. For this plugin it re-opens
    // the fail-open the bash pin closes, so neither surface may repeat it.
    expect(gitBashWarningLines(missing).join('\n').toLowerCase()).not.toContain('powershell');
    expect(gitBashWarningSummary(missing).toLowerCase()).not.toContain('powershell');
  });

  test('a typo\'d override is named, with what is wrong with it', () => {
    const d: Extract<GitBashDetection, { status: 'missing' }> = {
      status: 'missing',
      ignoredOverride: { path: 'D:\\nope\\bash.exe', reason: 'not-found' },
    };
    const text = gitBashWarningLines(d).join('\n');
    expect(text).toContain('D:\\nope\\bash.exe');
    expect(text).toContain('which does not exist');
    // …and that the override was ignored rather than obeyed, so the user does
    // not go hunting for a variable problem that is not the whole story.
    expect(text).toContain('auto-detect');
    expect(gitBashWarningSummary(d)).toContain('D:\\nope\\bash.exe');
  });

  test('a wrong-basename override is described as such, not as "does not exist"', () => {
    const d: Extract<GitBashDetection, { status: 'missing' }> = {
      status: 'missing',
      ignoredOverride: { path: 'D:\\PortableGit\\git-bash.exe', reason: 'not-a-bash-binary' },
    };
    const text = gitBashWarningLines(d).join('\n');
    expect(text).toContain('is not a bash/sh binary');
    expect(text).not.toContain('does not exist');
  });

  test('the --json summary is ONE line and says the same things', () => {
    const s = gitBashWarningSummary(missing);
    expect(s.includes('\n')).toBe(false);
    expect(s).toContain('https://git-scm.com/download/win');
    expect(s).toContain('winget install --id Git.Git -e --source winget');
    expect(s).toContain(GIT_BASH_PATH_ENV);
  });
});

// ---------------------------------------------------------------------------
// The NOTE — found despite a bad override. A different thing from a warning.
// ---------------------------------------------------------------------------

describe('the ignored-override note', () => {
  const d = {
    status: 'found' as const,
    path: PROGRAM_FILES_GIT_BASH,
    source: 'program-files' as const,
    ignoredOverride: { path: 'D:\\nope\\bash.exe', reason: 'not-found' as const },
  };

  test('names the bad variable AND the path actually in use, without a warning glyph', () => {
    const text = gitBashOverrideNoteLines(d).join('\n');
    expect(text).toContain('D:\\nope\\bash.exe');
    expect(text).toContain(PROGRAM_FILES_GIT_BASH);
    // Not a warning: hooks work. `⚠` is reserved for the case where they do not.
    expect(text).not.toContain('⚠');
    // And it must NOT claim the hooks are broken.
    expect(text).not.toContain('will not run');
  });

  test('the one-line summary says plainly that nothing is broken', () => {
    const s = gitBashOverrideNoteSummary(d);
    expect(s.includes('\n')).toBe(false);
    expect(s).toContain('nothing is broken');
    expect(s.toLowerCase()).not.toContain('powershell');
  });
});
