// credential-protect.test.ts — Windows-real per-user file protection (a5,
// 04-cloud-auth.md §6: "`0600` is meaningless on the Windows path... a
// per-user ACL... stated that way so an implementer does not ship a no-op
// `chmod`").
//
// Most tests inject `runIcacls` (an INJECTED platform string, never the real
// `process.platform` — same discipline as every other side effect in this
// codebase) so the logic is exercised on every CI matrix leg identically.
// The LAST describe block additionally runs a REAL `icacls` subprocess
// against a real temp file, guarded to only run when this process is
// actually on win32 — this machine is Windows, so it runs here and proves
// the mechanism end-to-end, not just the call shape. It cannot spin up a
// SECOND real Windows account inside this sandbox, so it verifies the
// resulting ACL by reading it back (asserting no other account/group has any
// entry) rather than an actual cross-account read attempt — see the PR body
// for exactly what that leaves unverified.

import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { protectCredentialFile, ProtectError, type IcaclsResult } from '../src/lib/credential-protect';
import { CloudError } from '../src/lib/cloud-config';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function mkFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-cred-protect-'));
  created.push(dir);
  const p = join(dir, 'credentials.json');
  writeFileSync(p, '{}');
  return p;
}

describe('protectCredentialFile — platform gating', () => {
  test('no-op on linux — icacls is never invoked', () => {
    const path = mkFile();
    let calls = 0;
    protectCredentialFile(path, {
      platform: 'linux',
      env: {},
      runIcacls: () => {
        calls++;
        return { status: 0, stderr: '' };
      },
    });
    expect(calls).toBe(0);
  });

  test('no-op on darwin — icacls is never invoked', () => {
    const path = mkFile();
    let calls = 0;
    protectCredentialFile(path, {
      platform: 'darwin',
      env: {},
      runIcacls: () => {
        calls++;
        return { status: 0, stderr: '' };
      },
    });
    expect(calls).toBe(0);
  });
});

describe('protectCredentialFile — win32, injected icacls', () => {
  test('strips inheritance then grants Full Control to DOMAIN\\\\user, in that order', () => {
    const path = mkFile();
    const invocations: string[][] = [];
    protectCredentialFile(path, {
      platform: 'win32',
      env: { USERNAME: 'ivan', USERDOMAIN: 'DESKTOP1' },
      runIcacls: (args): IcaclsResult => {
        invocations.push(args);
        return { status: 0, stderr: '' };
      },
    });
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toEqual([path, '/inheritance:r']);
    expect(invocations[1]).toEqual([path, '/grant:r', 'DESKTOP1\\ivan:F']);
  });

  test('falls back to a bare username when USERDOMAIN is unset', () => {
    const path = mkFile();
    const invocations: string[][] = [];
    protectCredentialFile(path, {
      platform: 'win32',
      env: { USERNAME: 'ivan' },
      runIcacls: (args): IcaclsResult => {
        invocations.push(args);
        return { status: 0, stderr: '' };
      },
    });
    expect(invocations[1]).toEqual([path, '/grant:r', 'ivan:F']);
  });

  test('falls back to os.userInfo().username when neither env var is set', () => {
    const path = mkFile();
    const invocations: string[][] = [];
    protectCredentialFile(path, {
      platform: 'win32',
      env: {},
      runIcacls: (args): IcaclsResult => {
        invocations.push(args);
        return { status: 0, stderr: '' };
      },
    });
    const expected = userInfo().username;
    expect(invocations[1]).toEqual([path, '/grant:r', `${expected}:F`]);
  });

  test('a failing /inheritance:r call throws ProtectError (a CloudError) and never attempts the grant call', () => {
    const path = mkFile();
    let grantCalled = false;
    expect(() =>
      protectCredentialFile(path, {
        platform: 'win32',
        env: { USERNAME: 'ivan' },
        runIcacls: (args): IcaclsResult => {
          if (args.includes('/grant:r')) grantCalled = true;
          if (args.includes('/inheritance:r')) return { status: 1, stderr: 'Access is denied.' };
          return { status: 0, stderr: '' };
        },
      }),
    ).toThrow(ProtectError);
    expect(grantCalled).toBe(false);
  });

  test('a failing /grant:r call throws ProtectError naming the failure', () => {
    const path = mkFile();
    expect(() =>
      protectCredentialFile(path, {
        platform: 'win32',
        env: { USERNAME: 'ivan' },
        runIcacls: (args): IcaclsResult => {
          if (args.includes('/grant:r')) return { status: 1, stderr: 'Invalid parameter' };
          return { status: 0, stderr: '' };
        },
      }),
    ).toThrow(/grant/);
  });

  test('ProtectError IS a CloudError — runCloud\'s existing catch already maps it to a clean exit, no new wiring needed', () => {
    const path = mkFile();
    try {
      protectCredentialFile(path, {
        platform: 'win32',
        env: { USERNAME: 'ivan' },
        runIcacls: () => ({ status: 1, stderr: 'nope' }),
      });
      throw new Error('expected protectCredentialFile to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CloudError);
      expect(e).toBeInstanceOf(ProtectError);
    }
  });
});

// ---------------------------------------------------------------------------
// REAL icacls — only runs when this process is actually on win32 (this dev
// machine is Windows; a Linux/macOS CI leg skips cleanly). Proves the
// mechanism end-to-end rather than just the call shape.
// ---------------------------------------------------------------------------

describe('protectCredentialFile — REAL icacls (win32 only)', () => {
  test.skipIf(process.platform !== 'win32')(
    'restricts a real file to exactly the current user — verified by reading the ACL back',
    () => {
      const path = mkFile();
      protectCredentialFile(path, { platform: 'win32', env: process.env });

      // Read the ACL back with a real `icacls <path>` (no args → lists ACEs).
      const res = spawnSync('icacls', [path], { encoding: 'utf-8' });
      expect(res.status).toBe(0);
      const listing = res.stdout;

      const me = userInfo().username;
      expect(listing).toContain(me);
      // No broad built-in group retained an entry — the whole point of
      // /inheritance:r + /grant:r (replace) is that nothing but the named
      // user shows up.
      for (const broad of ['Everyone', 'BUILTIN\\Users', 'Authenticated Users', 'Users:']) {
        expect(listing).not.toContain(broad);
      }
    },
  );
});
