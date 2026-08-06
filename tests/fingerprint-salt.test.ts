// fingerprint-salt.test.ts — b15: the per-install secret salt that replaces
// `run-identity.ts`'s public `DEFAULT_FINGERPRINT_SALT` when available
// (07-security.md T16/SG13). Every DoD claim is proven, not just exercised:
// CSPRNG generation, reuse-on-reread, the b14 at-rest machinery being the
// SAME mechanism (not a second one), no-throw fallback on every failure
// mode, and that the salt never rides along in anything `computeRunIdentity`
// returns (the "never uploaded" claim).

import { test, expect, afterEach, describe } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes as realRandomBytes } from 'node:crypto';
import { loadOrCreateInstallSalt, type InstallSaltDeps } from '../src/lib/fingerprint-salt';
import { realFs, credentialDir, fingerprintSaltFilePath, type HomeContext } from '../src/lib/cloud-config';
import type { ProtectDeps } from '../src/lib/credential-protect';
import {
  computeRunIdentity,
  computeProjectFingerprint,
  DEFAULT_FINGERPRINT_SALT,
  FINGERPRINT_SALT_ENV,
} from '../src/lib/run-identity';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function mkHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'pipeline-fp-salt-'));
  created.push(d);
  return d;
}

const HEX64 = /^[0-9a-f]{64}$/;

function baseDeps(home: string, overrides: Partial<InstallSaltDeps> = {}): InstallSaltDeps {
  return {
    fs: realFs,
    platform: 'linux', // protectCredentialFile is a no-op off win32 by default — real ACL path covered separately below
    env: { PIPELINE_CLOUD_HOME: home },
    homedir: home,
    ...overrides,
  };
}

function ctxFor(home: string): HomeContext {
  return { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
}

// ===========================================================================
// Generation — CSPRNG, persisted under b14's directory, protect() invoked
// ===========================================================================

describe('loadOrCreateInstallSalt — first call generates and persists', () => {
  test('returns a 64-hex-char salt and persists it as version:1 JSON', () => {
    const home = mkHome();
    const salt = loadOrCreateInstallSalt(baseDeps(home));
    expect(salt).toMatch(HEX64);

    const path = fingerprintSaltFilePath(ctxFor(home));
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    expect(onDisk).toEqual({ version: 1, salt });
  });

  test('is written to the SAME per-user directory as the credential store (b14 reuse, not a second location)', () => {
    const home = mkHome();
    loadOrCreateInstallSalt(baseDeps(home));
    const saltPath = fingerprintSaltFilePath(ctxFor(home));
    // credentialDir(ctx) === dirname(credentialFilePath(ctx)) === dirname(fingerprintSaltFilePath(ctx))
    expect(join(saltPath, '..')).toBe(credentialDir(ctxFor(home)));
  });

  test('file lands with 0600 perms on POSIX (same durable-write primitive as the credential store)', () => {
    if (process.platform === 'win32') return; // POSIX mode bits are meaningless on NTFS — see credential-protect.ts
    const home = mkHome();
    loadOrCreateInstallSalt(baseDeps(home));
    const path = fingerprintSaltFilePath(ctxFor(home));
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('calls protect() with the salt file path — the SAME Windows ACL step the credential store gets', () => {
    const home = mkHome();
    const calls: Array<{ filePath: string; deps: ProtectDeps }> = [];
    loadOrCreateInstallSalt(
      baseDeps(home, {
        platform: 'win32',
        protect: (filePath, deps) => {
          calls.push({ filePath, deps });
        },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.filePath).toBe(fingerprintSaltFilePath(ctxFor(home)));
    expect(calls[0]!.deps.platform).toBe('win32');
  });

  test('uses the injected CSPRNG source, not Math.random — MUTATION: a fixed-byte generator produces the exact expected hex', () => {
    const home = mkHome();
    const fixedBytes = Buffer.from('11'.repeat(32), 'hex');
    const salt = loadOrCreateInstallSalt(baseDeps(home, { randomBytes: () => fixedBytes }));
    expect(salt).toBe('11'.repeat(32));
  });

  test('the REAL default generator (node:crypto randomBytes) — two installs get two DIFFERENT salts', () => {
    const homeA = mkHome();
    const homeB = mkHome();
    const saltA = loadOrCreateInstallSalt(baseDeps(homeA)); // no randomBytes override -> real CSPRNG
    const saltB = loadOrCreateInstallSalt(baseDeps(homeB));
    expect(saltA).toMatch(HEX64);
    expect(saltB).toMatch(HEX64);
    expect(saltA).not.toBe(saltB);
    // MUTATION-PROVABLE: the generated salt is never the public constant.
    expect(saltA).not.toBe(DEFAULT_FINGERPRINT_SALT);
  });
});

// ===========================================================================
// Reuse — a second call reads the SAME persisted salt back, no regeneration
// ===========================================================================

describe('loadOrCreateInstallSalt — reuse on a later call', () => {
  test('a second call returns the identical salt and does not call randomBytes again', () => {
    const home = mkHome();
    let genCalls = 0;
    const deps = baseDeps(home, {
      randomBytes: (n: number) => {
        genCalls++;
        return realRandomBytes(n);
      },
    });
    const first = loadOrCreateInstallSalt(deps);
    const second = loadOrCreateInstallSalt(deps);
    expect(second).toBe(first);
    expect(genCalls).toBe(1); // MUTATION: if reuse broke, this would be 2
  });

  test('a second call does not re-invoke protect() — the ACL step only runs at the moment of writing', () => {
    const home = mkHome();
    let protectCalls = 0;
    const deps = baseDeps(home, { protect: () => { protectCalls++; } });
    loadOrCreateInstallSalt(deps);
    loadOrCreateInstallSalt(deps);
    expect(protectCalls).toBe(1);
  });
});

// ===========================================================================
// Self-healing — corrupt / foreign content at the salt path is regenerated
// ===========================================================================

describe('loadOrCreateInstallSalt — corrupt or foreign file content', () => {
  test('invalid JSON at the salt path is regenerated rather than returned or thrown', () => {
    const home = mkHome();
    const path = fingerprintSaltFilePath(ctxFor(home));
    mkdirSync(join(home, 'claude-pipeline'), { recursive: true });
    writeFileSync(path, 'not json at all');
    const salt = loadOrCreateInstallSalt(baseDeps(home));
    expect(salt).toMatch(HEX64);
    expect(JSON.parse(readFileSync(path, 'utf-8')).salt).toBe(salt);
  });

  test('valid JSON with a non-hex64 "salt" field is regenerated', () => {
    const home = mkHome();
    const path = fingerprintSaltFilePath(ctxFor(home));
    mkdirSync(join(home, 'claude-pipeline'), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, salt: 'too-short' }));
    const salt = loadOrCreateInstallSalt(baseDeps(home));
    expect(salt).toMatch(HEX64);
    expect(salt).not.toBe('too-short');
  });
});

// ===========================================================================
// The no-throw fallback contract — every failure mode returns undefined
// ===========================================================================

describe('loadOrCreateInstallSalt — never throws; absence falls back cleanly', () => {
  test('a read failure on an existing file returns undefined, never throws', () => {
    const home = mkHome();
    const fakeFs = {
      ...realFs,
      existsSync: () => true,
      readFileSync: () => {
        throw new Error('EPERM: permission denied');
      },
    };
    expect(() => loadOrCreateInstallSalt(baseDeps(home, { fs: fakeFs }))).not.toThrow();
    expect(loadOrCreateInstallSalt(baseDeps(home, { fs: fakeFs }))).toBeUndefined();
  });

  test('a write failure (e.g. a read-only disk) returns undefined, never throws', () => {
    const home = mkHome();
    // `home` already exists (mkdtempSync created it) and IS the resolved
    // credentialDir here (PIPELINE_CLOUD_HOME override) — so `mkdirSync`
    // would never even be called; fail the actual write call instead, the
    // step every "disk went read-only mid-write" failure funnels through.
    const fakeFs = {
      ...realFs,
      writeFileSync: () => {
        throw new Error('EROFS: read-only file system');
      },
    };
    expect(() => loadOrCreateInstallSalt(baseDeps(home, { fs: fakeFs }))).not.toThrow();
    expect(loadOrCreateInstallSalt(baseDeps(home, { fs: fakeFs }))).toBeUndefined();
    expect(existsSync(fingerprintSaltFilePath(ctxFor(home)))).toBe(false);
  });

  test('a write failure via a missing parent dir that also fails to create returns undefined', () => {
    // A genuinely fresh, never-created home dir (unlike `mkHome()`, which
    // pre-creates it) — this time `credentialDir` truly does not exist yet,
    // so `mkdirSync` IS the call that fails.
    const home = join(tmpdir(), `pipeline-fp-salt-nonexistent-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const fakeFs = {
      ...realFs,
      mkdirSync: () => {
        throw new Error('EROFS: read-only file system');
      },
    };
    expect(() => loadOrCreateInstallSalt(baseDeps(home, { fs: fakeFs }))).not.toThrow();
    expect(loadOrCreateInstallSalt(baseDeps(home, { fs: fakeFs }))).toBeUndefined();
  });

  test(
    'a failing protect() (Windows ACL call) returns undefined, never throws, AND removes the ' +
      'just-written file rather than leaving an unprotected secret on disk',
    () => {
      const home = mkHome();
      const path = fingerprintSaltFilePath(ctxFor(home));
      const deps = baseDeps(home, {
        platform: 'win32',
        protect: () => {
          throw new Error('icacls failed: Access is denied.');
        },
      });
      expect(() => loadOrCreateInstallSalt(deps)).not.toThrow();
      const salt = loadOrCreateInstallSalt(deps);
      expect(salt).toBeUndefined();
      expect(existsSync(path)).toBe(false); // MUTATION: without the rollback, this would be true
    },
  );

  test('after a protect() failure, the NEXT call retries cleanly (self-heals once protect works again)', () => {
    const home = mkHome();
    let shouldFail = true;
    const deps = baseDeps(home, {
      platform: 'win32',
      protect: () => {
        if (shouldFail) throw new Error('icacls failed');
      },
    });
    expect(loadOrCreateInstallSalt(deps)).toBeUndefined();
    shouldFail = false;
    const salt = loadOrCreateInstallSalt(deps);
    expect(salt).toMatch(HEX64);
  });
});

// ===========================================================================
// Integration with run-identity.ts — precedence, no-error fallback, no leak
// ===========================================================================

describe('run-identity.ts integration — installSalt precedence and non-leakage', () => {
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'fp-salt-pipeline-'));
    created.push(root);
    writeFileSync(join(root, 'PIPELINE.md'), '# m\n');
    return root;
  }

  test('installSalt is used when neither explicit salt nor env is set', () => {
    const home = mkHome();
    const installSalt = loadOrCreateInstallSalt(baseDeps(home));
    const id = computeRunIdentity({
      pipelineRoot: fixture(),
      projectIdentifier: 'github.com/o/n',
      env: {},
      installSalt,
    });
    expect(id.projectFingerprintHash).toBe(computeProjectFingerprint('github.com/o/n', installSalt!));
    // MUTATION: proves the install salt is NOT silently ignored in favor of the constant.
    expect(id.projectFingerprintHash).not.toBe(
      computeProjectFingerprint('github.com/o/n', DEFAULT_FINGERPRINT_SALT),
    );
  });

  test('PIPELINE_FINGERPRINT_SALT still wins over installSalt (env pins deliberately)', () => {
    const home = mkHome();
    const installSalt = loadOrCreateInstallSalt(baseDeps(home));
    const id = computeRunIdentity({
      pipelineRoot: fixture(),
      projectIdentifier: 'github.com/o/n',
      env: { [FINGERPRINT_SALT_ENV]: 'pinned-salt' },
      installSalt,
    });
    expect(id.projectFingerprintHash).toBe(computeProjectFingerprint('github.com/o/n', 'pinned-salt'));
  });

  test('an explicit salt still wins over installSalt', () => {
    const home = mkHome();
    const installSalt = loadOrCreateInstallSalt(baseDeps(home));
    const id = computeRunIdentity({
      pipelineRoot: fixture(),
      projectIdentifier: 'github.com/o/n',
      salt: 'explicit-salt',
      env: {},
      installSalt,
    });
    expect(id.projectFingerprintHash).toBe(computeProjectFingerprint('github.com/o/n', 'explicit-salt'));
  });

  test('absent installSalt (undefined) falls back to DEFAULT_FINGERPRINT_SALT with no error', () => {
    expect(() =>
      computeRunIdentity({
        pipelineRoot: fixture(),
        projectIdentifier: 'github.com/o/n',
        env: {},
        installSalt: undefined,
      }),
    ).not.toThrow();
    const id = computeRunIdentity({
      pipelineRoot: fixture(),
      projectIdentifier: 'github.com/o/n',
      env: {},
      installSalt: undefined,
    });
    expect(id.projectFingerprintHash).toBe(
      computeProjectFingerprint('github.com/o/n', DEFAULT_FINGERPRINT_SALT),
    );
  });

  test('NEVER UPLOADED: the resolved salt never appears anywhere in the serialized RunIdentity', () => {
    const home = mkHome();
    const installSalt = loadOrCreateInstallSalt(baseDeps(home));
    expect(installSalt).toBeDefined();
    const id = computeRunIdentity({
      pipelineRoot: fixture(),
      projectIdentifier: 'github.com/acme/private-repo',
      env: {},
      installSalt,
    });
    const serialized = JSON.stringify(id);
    expect(serialized).not.toContain(installSalt!);
    // ...and every individual field, not just the JSON blob as a whole.
    for (const value of Object.values(id)) {
      const asText = Array.isArray(value) ? value.join(',') : String(value);
      expect(asText).not.toContain(installSalt!);
    }
  });
});

// ===========================================================================
// REAL icacls — only runs when this process is actually on win32, mirroring
// credential-protect.test.ts's own end-to-end guard.
// ===========================================================================

describe('loadOrCreateInstallSalt — REAL protectCredentialFile (win32 only)', () => {
  test.skipIf(process.platform !== 'win32')(
    'end-to-end: the salt file is ACL-restricted to exactly the current user',
    () => {
      const home = mkHome();
      // PIPELINE_CLOUD_HOME MUST be set — without it `credentialDir` falls
      // through to the REAL `%APPDATA%\claude-pipeline` (keyed off env, not
      // `homedir`), which would write a real file into this dev machine's
      // actual credential directory instead of the disposable temp one.
      const salt = loadOrCreateInstallSalt({
        fs: realFs,
        platform: 'win32',
        env: { ...process.env, PIPELINE_CLOUD_HOME: home },
        homedir: home,
      });
      expect(salt).toMatch(HEX64);
      const path = fingerprintSaltFilePath(ctxFor(home));
      const res = spawnSync('icacls', [path], { encoding: 'utf-8' });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(userInfo().username);
      for (const broad of ['Everyone', 'BUILTIN\\Users', 'Authenticated Users', 'Users:']) {
        expect(res.stdout).not.toContain(broad);
      }
    },
  );
});
