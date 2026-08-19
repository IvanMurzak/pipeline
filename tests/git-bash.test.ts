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
  gitBashWarningLines,
  gitBashWarningSummary,
  gitRelativeBashPath,
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

  test('rung 1: an override pointing nowhere is MISSING, not a fallthrough', () => {
    // Claude Code honours the variable, so a typo breaks the hooks exactly as
    // thoroughly as no Git Bash at all. Quietly reporting the Program Files
    // copy would hide the fault that is actually in effect.
    const custom = 'D:\\typo\\bash.exe';
    const p = probe({ env: { [GIT_BASH_PATH_ENV]: custom }, files: [PROGRAM_FILES_GIT_BASH] });
    expect(detectGitBash(p)).toEqual({ status: 'missing', configuredPath: custom });
    expect(p.probed).toEqual([custom]);
  });

  test('rung 1: a blank override counts as unset', () => {
    // The classic "configured but empty" CI mistake — same stance as
    // cloudStepDecision's blank PIPELINE_MACHINE_TOKEN.
    const p = probe({ env: { [GIT_BASH_PATH_ENV]: '   ' }, files: [PROGRAM_FILES_GIT_BASH] });
    expect(detectGitBash(p)).toEqual({
      status: 'found',
      path: PROGRAM_FILES_GIT_BASH,
      source: 'program-files',
    });
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

  test('nothing anywhere: missing, with no configuredPath', () => {
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
      configuredPath: 'D:\\nope\\bash.exe',
    };
    const text = gitBashWarningLines(d).join('\n');
    expect(text).toContain('D:\\nope\\bash.exe');
    expect(text).toContain('which does not exist');
    expect(gitBashWarningSummary(d)).toContain('D:\\nope\\bash.exe');
  });

  test('the --json summary is ONE line and says the same things', () => {
    const s = gitBashWarningSummary(missing);
    expect(s.includes('\n')).toBe(false);
    expect(s).toContain('https://git-scm.com/download/win');
    expect(s).toContain('winget install --id Git.Git -e --source winget');
    expect(s).toContain(GIT_BASH_PATH_ENV);
  });
});
