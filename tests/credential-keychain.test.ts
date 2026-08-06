// credential-keychain.test.ts — b14: OS keychain storage for the refresh
// token half of the credential store (07-security.md §3.3 — "OS keychain
// where available, with a documented fallback").
//
// Every test injects `runCommand` (never a real `security`/`secret-tool`
// subprocess) so the exact invocation shape is asserted deterministically on
// every CI leg — the SAME discipline `credential-protect.test.ts` already
// uses for `icacls`. This machine (and every current CI runner — see
// `.github/workflows/ci.yml`'s `[ubuntu-latest, windows-latest]` matrix) has
// no macOS Keychain and no running Linux Secret Service, so the REAL
// backends cannot be exercised end-to-end here — see the PR description for
// exactly what that leaves unverified.

import { test, expect, describe } from 'bun:test';
import {
  storeInKeychain,
  readFromKeychain,
  deleteFromKeychain,
  keychainBackendFor,
  type KeychainCommandResult,
} from '../src/lib/credential-keychain';

describe('keychainBackendFor — platform → backend mapping', () => {
  test('darwin → macos', () => {
    expect(keychainBackendFor('darwin')).toBe('macos');
  });
  test('linux → linux-secret-service', () => {
    expect(keychainBackendFor('linux')).toBe('linux-secret-service');
  });
  test('win32 → none (documented: no scriptable read-back without a new dependency)', () => {
    expect(keychainBackendFor('win32')).toBe('none');
  });
  test('an unknown platform string → none (fail closed, not a crash)', () => {
    expect(keychainBackendFor('freebsd')).toBe('none');
  });
});

describe('storeInKeychain / readFromKeychain / deleteFromKeychain — win32 (or any "none" platform) is always a no-op', () => {
  test('storeInKeychain returns false without invoking runCommand', () => {
    let calls = 0;
    const ok = storeInKeychain(
      { platform: 'win32', runCommand: () => ((calls++), { status: 0, stdout: '', stderr: '' }) },
      'https://api.ai-pipeline.dev',
      'rt-secret',
    );
    expect(ok).toBe(false);
    expect(calls).toBe(0);
  });

  test('readFromKeychain returns undefined without invoking runCommand', () => {
    let calls = 0;
    const value = readFromKeychain(
      { platform: 'win32', runCommand: () => ((calls++), { status: 0, stdout: 'x', stderr: '' }) },
      'https://api.ai-pipeline.dev',
    );
    expect(value).toBeUndefined();
    expect(calls).toBe(0);
  });

  test('deleteFromKeychain is a silent no-op', () => {
    let calls = 0;
    deleteFromKeychain(
      { platform: 'win32', runCommand: () => ((calls++), { status: 0, stdout: '', stderr: '' }) },
      'https://api.ai-pipeline.dev',
    );
    expect(calls).toBe(0);
  });
});

describe('storeInKeychain — macOS, injected `security`', () => {
  test('calls `security add-generic-password -a <account> -s <service> -w <secret> -U`, returns true on exit 0', () => {
    const invocations: string[][] = [];
    const ok = storeInKeychain(
      {
        platform: 'darwin',
        runCommand: (cmd, args): KeychainCommandResult => {
          invocations.push([cmd, ...args]);
          return { status: 0, stdout: '', stderr: '' };
        },
      },
      'https://api.ai-pipeline.dev',
      'rt-secret-value',
    );
    expect(ok).toBe(true);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]![0]).toBe('security');
    expect(invocations[0]).toContain('add-generic-password');
    expect(invocations[0]).toContain('-a');
    expect(invocations[0]).toContain('https://api.ai-pipeline.dev');
    expect(invocations[0]).toContain('-w');
    expect(invocations[0]).toContain('rt-secret-value');
    expect(invocations[0]).toContain('-U'); // update-in-place — a second connect must not fail with "already exists"
  });

  test('a non-zero exit (e.g. keychain locked) returns false, never throws', () => {
    const ok = storeInKeychain(
      { platform: 'darwin', runCommand: () => ({ status: 1, stdout: '', stderr: 'User interaction is not allowed.' }) },
      'https://api.ai-pipeline.dev',
      'rt',
    );
    expect(ok).toBe(false);
  });

  test('a missing `security` binary (ENOENT ⇒ status: null) returns false, never throws', () => {
    const ok = storeInKeychain(
      { platform: 'darwin', runCommand: () => ({ status: null, stdout: '', stderr: 'ENOENT' }) },
      'https://api.ai-pipeline.dev',
      'rt',
    );
    expect(ok).toBe(false);
  });
});

describe('readFromKeychain — macOS, injected `security`', () => {
  test('calls `security find-generic-password -a <account> -s <service> -w`, returns trimmed stdout', () => {
    const invocations: string[][] = [];
    const value = readFromKeychain(
      {
        platform: 'darwin',
        runCommand: (cmd, args): KeychainCommandResult => {
          invocations.push([cmd, ...args]);
          return { status: 0, stdout: 'rt-secret-value\n', stderr: '' };
        },
      },
      'https://api.ai-pipeline.dev',
    );
    expect(value).toBe('rt-secret-value');
    expect(invocations[0]).toContain('find-generic-password');
    expect(invocations[0]).toContain('-w');
  });

  test('exit 44 (item not found) returns undefined', () => {
    const value = readFromKeychain(
      { platform: 'darwin', runCommand: () => ({ status: 44, stdout: '', stderr: 'could not be found' }) },
      'https://api.ai-pipeline.dev',
    );
    expect(value).toBeUndefined();
  });
});

describe('storeInKeychain / readFromKeychain — Linux, injected `secret-tool`', () => {
  test('store pipes the secret over STDIN (never argv) via `secret-tool store … service <svc> account <acct>`', () => {
    const invocations: { args: string[]; input?: string }[] = [];
    const ok = storeInKeychain(
      {
        platform: 'linux',
        runCommand: (cmd, args, opts): KeychainCommandResult => {
          invocations.push({ args: [cmd, ...args], input: opts?.input });
          return { status: 0, stdout: '', stderr: '' };
        },
      },
      'https://api.ai-pipeline.dev',
      'rt-secret-value',
    );
    expect(ok).toBe(true);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.args[0]).toBe('secret-tool');
    expect(invocations[0]!.args).toContain('store');
    expect(invocations[0]!.args).toContain('service');
    expect(invocations[0]!.args).toContain('account');
    expect(invocations[0]!.args).toContain('https://api.ai-pipeline.dev');
    // The secret is NEVER in argv for the Linux backend.
    expect(invocations[0]!.args.join(' ')).not.toContain('rt-secret-value');
    expect(invocations[0]!.input).toBe('rt-secret-value');
  });

  test('lookup returns trimmed stdout on exit 0', () => {
    const value = readFromKeychain(
      { platform: 'linux', runCommand: () => ({ status: 0, stdout: 'rt-secret-value\n', stderr: '' }) },
      'https://api.ai-pipeline.dev',
    );
    expect(value).toBe('rt-secret-value');
  });

  test('no Secret Service session (secret-tool exits non-zero) → undefined, the documented fallback trigger', () => {
    const value = readFromKeychain(
      {
        platform: 'linux',
        runCommand: () => ({ status: 1, stdout: '', stderr: 'No such secret\n' }),
      },
      'https://api.ai-pipeline.dev',
    );
    expect(value).toBeUndefined();
  });

  test('a missing `secret-tool` binary (ENOENT) → store returns false, never throws', () => {
    const ok = storeInKeychain(
      { platform: 'linux', runCommand: () => ({ status: null, stdout: '', stderr: 'ENOENT' }) },
      'https://api.ai-pipeline.dev',
      'rt',
    );
    expect(ok).toBe(false);
  });
});

describe('deleteFromKeychain — best-effort, both backends', () => {
  test('macOS: `security delete-generic-password -a <account> -s <service>`', () => {
    const invocations: string[][] = [];
    deleteFromKeychain(
      { platform: 'darwin', runCommand: (cmd, args): KeychainCommandResult => {
        invocations.push([cmd, ...args]);
        return { status: 0, stdout: '', stderr: '' };
      } },
      'https://api.ai-pipeline.dev',
    );
    expect(invocations[0]).toContain('delete-generic-password');
  });

  test('Linux: `secret-tool clear service <svc> account <acct>`', () => {
    const invocations: string[][] = [];
    deleteFromKeychain(
      { platform: 'linux', runCommand: (cmd, args): KeychainCommandResult => {
        invocations.push([cmd, ...args]);
        return { status: 0, stdout: '', stderr: '' };
      } },
      'https://api.ai-pipeline.dev',
    );
    expect(invocations[0]).toContain('clear');
  });

  test('a thrown runCommand never propagates out of deleteFromKeychain', () => {
    expect(() =>
      deleteFromKeychain(
        {
          platform: 'darwin',
          runCommand: () => {
            throw new Error('boom');
          },
        },
        'https://api.ai-pipeline.dev',
      ),
    ).not.toThrow();
  });
});

describe('storeInKeychain / readFromKeychain — a throwing injected runCommand never propagates (the "never throws" contract)', () => {
  test('store', () => {
    expect(() =>
      storeInKeychain(
        {
          platform: 'darwin',
          runCommand: () => {
            throw new Error('boom');
          },
        },
        'a',
        's',
      ),
    ).not.toThrow();
  });
  test('read', () => {
    expect(() =>
      readFromKeychain(
        {
          platform: 'linux',
          runCommand: () => {
            throw new Error('boom');
          },
        },
        'a',
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// REAL backend — only runs on the platform it targets. This dev/CI matrix is
// win32 + ubuntu-latest only (no macOS runner exists — see ci.yml), so the
// macOS block below can never execute here; it is included for the day a
// macOS leg is added, mirroring credential-protect.test.ts's own
// `test.skipIf(process.platform !== 'win32')` convention for its real-icacls
// block. The Linux block DOES run on ubuntu-latest, but `secret-tool` is not
// installed on that image by default, so it exercises the real "ENOENT ⇒
// unavailable ⇒ false/undefined, never throws" fallback path end-to-end
// rather than a real Secret Service round trip.
// ---------------------------------------------------------------------------

describe('REAL backend — same-platform only', () => {
  test.skipIf(process.platform !== 'darwin')('macOS: store then read round-trips through the real Keychain', () => {
    const account = `pipeline-cli-b14-test-${Date.now()}`;
    const ok = storeInKeychain({ platform: 'darwin' }, account, 'round-trip-secret');
    expect(ok).toBe(true);
    const value = readFromKeychain({ platform: 'darwin' }, account);
    expect(value).toBe('round-trip-secret');
    deleteFromKeychain({ platform: 'darwin' }, account);
    expect(readFromKeychain({ platform: 'darwin' }, account)).toBeUndefined();
  });

  test.skipIf(process.platform !== 'linux')(
    'Linux: no `secret-tool` on this image ⇒ real ENOENT fallback, not a throw',
    () => {
      const ok = storeInKeychain({ platform: 'linux' }, 'pipeline-cli-b14-test', 'x');
      // Either genuinely unavailable (ENOENT/no session — the expected CI
      // shape) or, on a desktop image that does have it, a real store
      // succeeds — either outcome must be a clean boolean, never a throw.
      expect(typeof ok).toBe('boolean');
    },
  );
});
