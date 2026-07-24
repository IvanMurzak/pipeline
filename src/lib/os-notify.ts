// os-notify.ts — best-effort, cross-platform OS-level notification for the
// mesh background notifier (department-mesh task a1, Q2). Fires a native
// toast/balloon so a parked task can "announce itself" even to a user who
// isn't looking at a terminal — never required for correctness (the
// SessionStart hook's additionalContext injection, apps/pipeline-cli/src/lib
// /mesh-notify.ts's pending-notification journal, is the durable fallback),
// so every path here is best-effort and MUST NOT throw.
//
// `buildOsNotifyCommand` is the pure, fully-tested half: platform -> exact
// argv, with no I/O. `sendOsNotification` is the thin, deliberately-untested
// (environment-dependent) half that actually spawns it.

import { spawn as nodeSpawn } from 'node:child_process';

/** The external command a notification would run, or null when the platform
 *  has no supported native mechanism (the caller falls back to the durable
 *  in-app channel only). */
export interface OsNotifyCommand {
  cmd: string;
  args: string[];
}

/** Escape a string for embedding inside a single-quoted AppleScript string
 *  literal (osascript -e). AppleScript has no escape char inside a plain
 *  string other than doubling the quote character itself is NOT how it
 *  works — AppleScript uses backslash escaping like most C-family languages
 *  for double-quoted strings, so this targets double-quoted delimiters. */
function osascriptQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Escape a string for embedding inside a single-quoted PowerShell string
 *  literal: PowerShell's single-quote escape is doubling the quote. */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Trim to a sane length so a verbose task title can never blow up an OS
 *  notification API (some have hard byte caps). */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

const MAX_TITLE = 120;
const MAX_BODY = 500;

/** Build the OS-specific command for a native notification. Pure — no
 *  spawning, so this is exhaustively unit-testable without touching the
 *  real OS. Returns null for an unrecognized platform (e.g. inside a
 *  container with no notification daemon at all — the caller's durable
 *  fallback channel still covers it). */
export function buildOsNotifyCommand(platform: string, title: string, body: string): OsNotifyCommand | null {
  const t = clip(title, MAX_TITLE);
  const b = clip(body, MAX_BODY);
  switch (platform) {
    case 'darwin':
      return {
        cmd: 'osascript',
        args: ['-e', `display notification "${osascriptQuote(b)}" with title "${osascriptQuote(t)}"`],
      };
    case 'linux':
      return { cmd: 'notify-send', args: [t, b] };
    case 'win32': {
      // A tray-balloon toast via System.Windows.Forms.NotifyIcon — built into
      // every Windows .NET install, no extra module (e.g. BurntToast) needed.
      // Disposed after a short wait so the process doesn't linger.
      const script =
        `Add-Type -AssemblyName System.Windows.Forms; ` +
        `$n = New-Object System.Windows.Forms.NotifyIcon; ` +
        `$n.Icon = [System.Drawing.SystemIcons]::Information; ` +
        `$n.Visible = $true; ` +
        `$n.ShowBalloonTip(5000, ${psQuote(t)}, ${psQuote(b)}, [System.Windows.Forms.ToolTipIcon]::Info); ` +
        `Start-Sleep -Seconds 6; ` +
        `$n.Dispose()`;
      return {
        cmd: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      };
    }
    default:
      return null;
  }
}

export interface OsNotifyDeps {
  platform: string;
  /** Fire-and-forget process spawn. MUST NOT throw synchronously for a
   *  missing binary — the real implementation swallows spawn errors. */
  spawn: (cmd: string, args: string[]) => void;
}

/** Fire a best-effort native OS notification. Never throws — a missing
 *  `notify-send` binary, a headless box, or any other environment quirk is
 *  swallowed, matching this whole subsystem's "never block, never crash the
 *  daemon" contract. */
export function sendOsNotification(deps: OsNotifyDeps, title: string, body: string): void {
  const spec = buildOsNotifyCommand(deps.platform, title, body);
  if (!spec) return;
  try {
    deps.spawn(spec.cmd, spec.args);
  } catch {
    // best-effort — see module doc.
  }
}

// ---------------------------------------------------------------------------
// Real spawn — detached, output discarded, errors swallowed.
// ---------------------------------------------------------------------------

export const realSpawn: OsNotifyDeps['spawn'] = (cmd, args) => {
  try {
    const child = nodeSpawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {
      // Missing binary (e.g. no notify-send on a minimal Linux box) — swallow.
    });
    child.unref();
  } catch {
    // best-effort — see module doc.
  }
};
