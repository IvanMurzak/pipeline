// os-notify.test.ts — pure command-construction tests for the mesh
// notifier's best-effort OS-level toast (department-mesh task a1, Q2).
// buildOsNotifyCommand is pure (no I/O); sendOsNotification is exercised
// against an injected fake spawn that never touches a real process.

import { test, expect, describe } from 'bun:test';
import { buildOsNotifyCommand, sendOsNotification } from '../src/lib/os-notify';

describe('buildOsNotifyCommand', () => {
  test('darwin → osascript display notification with escaped title/body', () => {
    const cmd = buildOsNotifyCommand('darwin', 'Mesh task needs your input', 'Task "abc" is now INPUT_REQUIRED.');
    expect(cmd).not.toBeNull();
    expect(cmd!.cmd).toBe('osascript');
    expect(cmd!.args[0]).toBe('-e');
    expect(cmd!.args[1]).toContain('display notification');
    expect(cmd!.args[1]).toContain('with title');
    // Embedded double quote must be escaped, not left raw (would break the
    // AppleScript string literal).
    expect(cmd!.args[1]).toContain('\\"abc\\"');
  });

  test('linux → notify-send with title/body as two plain argv entries (no shell involved)', () => {
    const cmd = buildOsNotifyCommand('linux', 'Mesh task finished', 'Task x is now COMPLETED.');
    expect(cmd).toEqual({ cmd: 'notify-send', args: ['Mesh task finished', 'Task x is now COMPLETED.'] });
  });

  test('win32 → powershell NotifyIcon balloon, single-quoted literals with doubled internal quotes', () => {
    const cmd = buildOsNotifyCommand('win32', "It's ready", 'Body text');
    expect(cmd).not.toBeNull();
    expect(cmd!.cmd).toBe('powershell.exe');
    expect(cmd!.args).toContain('-NoProfile');
    expect(cmd!.args).toContain('-Command');
    const script = cmd!.args[cmd!.args.length - 1]!;
    expect(script).toContain('ShowBalloonTip');
    // PowerShell single-quote escaping: an embedded ' becomes ''.
    expect(script).toContain("'It''s ready'");
  });

  test('an unrecognized platform returns null (caller falls back to the durable channel only)', () => {
    expect(buildOsNotifyCommand('sunos', 'x', 'y')).toBeNull();
    expect(buildOsNotifyCommand('freebsd', 'x', 'y')).toBeNull();
  });

  test('very long title/body are clipped so no OS API call ever receives unbounded text', () => {
    const longTitle = 'T'.repeat(500);
    const longBody = 'B'.repeat(2000);
    const cmd = buildOsNotifyCommand('linux', longTitle, longBody);
    expect(cmd!.args[0]!.length).toBeLessThan(200);
    expect(cmd!.args[1]!.length).toBeLessThan(600);
    expect(cmd!.args[0]!.endsWith('…')).toBe(true);
    expect(cmd!.args[1]!.endsWith('…')).toBe(true);
  });
});

describe('sendOsNotification', () => {
  test('invokes the injected spawn with the platform-built command', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    sendOsNotification({ platform: 'linux', spawn: (cmd, args) => calls.push({ cmd, args }) }, 'Title', 'Body');
    expect(calls).toEqual([{ cmd: 'notify-send', args: ['Title', 'Body'] }]);
  });

  test('an unsupported platform never calls spawn at all', () => {
    let called = false;
    sendOsNotification({ platform: 'plan9', spawn: () => { called = true; } }, 'Title', 'Body');
    expect(called).toBe(false);
  });

  test('a throwing spawn is swallowed — never propagates (best-effort contract)', () => {
    expect(() =>
      sendOsNotification(
        {
          platform: 'linux',
          spawn: () => {
            throw new Error('ENOENT: notify-send not found');
          },
        },
        'Title',
        'Body',
      ),
    ).not.toThrow();
  });
});
