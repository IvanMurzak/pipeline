// credential-refresh.test.ts — ensureFreshCredential's decision logic: the
// fast (no-lock) path, the refresh-under-lock path, invalid_grant → the
// exact §9 message, and an IN-PROCESS concurrent-call proof that two calls
// racing on the SAME lock path perform exactly one network refresh and the
// loser re-reads the winner's result. (The genuine CROSS-PROCESS version of
// that same proof — real `bun` subprocesses, no in-memory sharing possible —
// lives in credential-refresh-cross-process.test.ts; DoD box 1 rests on
// THAT file, not this one.)

import { test, expect, afterEach, describe } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureFreshCredential,
  isRefreshInactive,
  persistCredentialSecurely,
  REAUTH_REQUIRED_MESSAGE,
  REFRESH_TOKEN_INACTIVITY_WINDOW_S,
  type RefreshDeps,
  type HttpResponse,
  type HttpInit,
} from '../src/lib/credential-refresh';
import {
  realFs,
  credentialFilePath,
  credentialLockPath,
  readCredentialStore,
  writeCredentialStore,
  CloudError,
  type HomeContext,
} from '../src/lib/cloud-config';
import type { KeychainDeps } from '../src/lib/credential-keychain';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function mkHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'pipeline-cred-refresh-'));
  created.push(d);
  return d;
}

const SERVER = 'https://api.ai-pipeline.dev';

function reply(status: number, body: unknown): HttpResponse {
  return { status, json: async () => body };
}

function seed(
  home: string,
  fields: {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    token_type?: string;
    last_used_at?: number;
    refresh_token_in_keychain?: boolean;
  },
): string {
  const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
  const path = credentialFilePath(ctx);
  writeCredentialStore(realFs, path, {
    version: 1,
    servers: { [SERVER]: { token_type: 'bearer', ...fields } },
  });
  return path;
}

function baseDeps(home: string, fetchImpl: RefreshDeps['fetch'], now = () => 2_000_000): RefreshDeps {
  return {
    fetch: fetchImpl,
    fs: realFs,
    now,
    platform: 'linux',
    env: { PIPELINE_CLOUD_HOME: home },
    homedir: home,
  };
}

describe('ensureFreshCredential — fast path (no lock, no network)', () => {
  test('a credential with no expires_at (never expires) is returned as-is', async () => {
    const home = mkHome();
    seed(home, { access_token: 'at1' });
    let calls = 0;
    const deps = baseDeps(home, async () => {
      calls++;
      throw new Error('must not be called');
    });
    const cred = await ensureFreshCredential(deps, SERVER);
    expect(cred.access_token).toBe('at1');
    expect(calls).toBe(0);
    // No lock left behind for a fast-path call.
    const ctx: HomeContext = { platform: 'linux', env: deps.env, homedir: home };
    expect(existsSync(credentialLockPath(ctx))).toBe(false);
  });

  test('a credential expiring comfortably outside the refresh buffer is returned as-is', async () => {
    const home = mkHome();
    seed(home, { access_token: 'at1', refresh_token: 'rt1', expires_at: 2_000_000 + 10 * 60 * 1000 });
    let calls = 0;
    const deps = baseDeps(home, async () => {
      calls++;
      throw new Error('must not be called');
    });
    const cred = await ensureFreshCredential(deps, SERVER);
    expect(cred.access_token).toBe('at1');
    expect(calls).toBe(0);
  });

  test('no stored credential for the server → CloudError naming `pipeline cloud connect`', async () => {
    const home = mkHome();
    const deps = baseDeps(home, async () => reply(200, {}));
    await expect(ensureFreshCredential(deps, SERVER)).rejects.toThrow(/pipeline cloud connect/);
  });
});

describe('ensureFreshCredential — refresh under the lock', () => {
  test('a credential inside the buffer is refreshed: new access+refresh token stored atomically, old refresh_token gone', async () => {
    const home = mkHome();
    const credPath = seed(home, { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 2_030_000 });
    const calls: HttpInit[] = [];
    const deps = baseDeps(home, async (url, init) => {
      expect(url).toBe(`${SERVER}/oauth/token`);
      calls.push(init);
      const params = new URLSearchParams(init.body ?? '');
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('rt-old');
      expect(params.get('client_id')).toBe('ai-pipeline-cli');
      expect(params.get('resource')).toBe(`${SERVER}/api`);
      return reply(200, {
        access_token: 'at-new',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'rt-new',
        scope: '',
      });
    });

    const cred = await ensureFreshCredential(deps, SERVER);
    expect(cred.access_token).toBe('at-new');
    expect(cred.refresh_token).toBe('rt-new');
    expect(cred.expires_at).toBe(2_000_000 + 900 * 1000);
    expect(calls).toHaveLength(1);

    // Persisted to disk — not just returned in memory.
    const onDisk = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(onDisk.servers[SERVER].access_token).toBe('at-new');
    expect(onDisk.servers[SERVER].refresh_token).toBe('rt-new');
    expect(JSON.stringify(onDisk)).not.toContain('at-old');
    expect(JSON.stringify(onDisk)).not.toContain('rt-old');

    // The lock is released — nothing left behind to wedge a later call.
    const ctx: HomeContext = { platform: 'linux', env: deps.env, homedir: home };
    expect(existsSync(credentialLockPath(ctx))).toBe(false);
  });

  test('org_slug/user_email/token_prefix survive a refresh (only the token pair + expiry change)', async () => {
    const home = mkHome();
    const credPath = seed(home, { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 2_030_000 });
    // Manually enrich with display fields the way connect() does.
    const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
    const store = JSON.parse(readFileSync(credPath, 'utf-8'));
    store.servers[SERVER].org_slug = 'acme';
    store.servers[SERVER].user_email = 'dev@example.com';
    writeCredentialStore(realFs, credPath, store);

    const deps = baseDeps(home, async () =>
      reply(200, { access_token: 'at-new', token_type: 'Bearer', expires_in: 900, refresh_token: 'rt-new' }),
    );
    const cred = await ensureFreshCredential(deps, SERVER);
    expect(cred.org_slug).toBe('acme');
    expect(cred.user_email).toBe('dev@example.com');
  });

  test('an expired credential with NO refresh_token cannot be refreshed automatically — clean CloudError, never a crash', async () => {
    const home = mkHome();
    seed(home, { access_token: 'at-old', expires_at: 1_000 }); // long past `now`
    let calls = 0;
    const deps = baseDeps(home, async () => {
      calls++;
      throw new Error('must not be called — no refresh_token to use');
    });
    await expect(ensureFreshCredential(deps, SERVER)).rejects.toThrow(/cannot be refreshed automatically/);
    expect(calls).toBe(0);
  });

  test('a network error during refresh is a clean CloudError, never a raw exception leaking through', async () => {
    const home = mkHome();
    seed(home, { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 1_000 });
    const deps = baseDeps(home, async () => {
      throw new Error('ECONNRESET');
    });
    await expect(ensureFreshCredential(deps, SERVER)).rejects.toThrow(/could not reach/);
    // Lock still released despite the failure — `finally` ran.
    const ctx: HomeContext = { platform: 'linux', env: deps.env, homedir: home };
    expect(existsSync(credentialLockPath(ctx))).toBe(false);
  });

  test('a non-invalid_grant HTTP failure (e.g. 500) is a clean CloudError naming the status', async () => {
    const home = mkHome();
    seed(home, { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 1_000 });
    const deps = baseDeps(home, async () => reply(500, { error: 'server_error' }));
    await expect(ensureFreshCredential(deps, SERVER)).rejects.toThrow(/HTTP 500/);
  });
});

describe('ensureFreshCredential — invalid_grant (DoD: "produces the §9 message and exits cleanly, never a crash")', () => {
  test('a plain expired/unknown refresh token → the EXACT §9 message', async () => {
    const home = mkHome();
    seed(home, { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 1_000 });
    const deps = baseDeps(home, async () =>
      reply(400, { error: 'invalid_grant', error_description: 'refresh token expired' }),
    );
    try {
      await ensureFreshCredential(deps, SERVER);
      throw new Error('expected ensureFreshCredential to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CloudError);
      expect((e as Error).message).toBe(REAUTH_REQUIRED_MESSAGE);
    }
  });

  test('a REUSE-DETECTED (family-revoked) response is INDISTINGUISHABLE at this layer — same exact message', async () => {
    // Mirrors cloud/apps/api/src/modules/mesh-oauth/routes.ts's
    // handleRefreshTokenGrant: both "unknown/expired" and "reuse detected —
    // the token family has been revoked" are `invalid_grant`. This client
    // does not (and per the server's own doc comment, CANNOT) tell them
    // apart — both must produce identically the §9 message, not a
    // different one that implies a distinction the server never makes.
    const home = mkHome();
    seed(home, { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 1_000 });
    const deps = baseDeps(home, async () =>
      reply(400, {
        error: 'invalid_grant',
        error_description: 'refresh token reuse detected — the token family has been revoked',
      }),
    );
    await expect(ensureFreshCredential(deps, SERVER)).rejects.toThrow(REAUTH_REQUIRED_MESSAGE);
  });
});

describe('ensureFreshCredential — IN-PROCESS concurrent single-flight (complements the real cross-process proof)', () => {
  test('two calls racing on the same store: exactly one network refresh; the loser re-reads the winner\'s result', async () => {
    const home = mkHome();
    seed(home, { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 2_030_000 });
    let networkCalls = 0;
    const deps = baseDeps(home, async () => {
      networkCalls++;
      // A tiny real delay widens the window in which the second caller's
      // lock-poll retry could (wrongly) also decide to refresh.
      await new Promise((r) => setTimeout(r, 15));
      return reply(200, {
        access_token: 'at-new',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'rt-new',
      });
    });

    const [a, b] = await Promise.all([ensureFreshCredential(deps, SERVER), ensureFreshCredential(deps, SERVER)]);
    expect(networkCalls).toBe(1);
    expect(a.access_token).toBe('at-new');
    expect(b.access_token).toBe('at-new');
    expect(a.refresh_token).toBe('rt-new');
    expect(b.refresh_token).toBe('rt-new');
  });
});

// ---------------------------------------------------------------------------
// b14 — OS keychain wiring (07-security.md §3.3's "OS keychain where
// available, with a documented fallback"). A scripted `KeychainDeps` stands
// in for a real Keychain/Secret Service — this machine (and the CI matrix,
// `ubuntu-latest`/`windows-latest` only) has neither for real; see
// `credential-keychain.test.ts` for the backend's own command-shape proof.
// ---------------------------------------------------------------------------

/** A trivial in-memory keychain used to prove `persistCredentialSecurely` and
 *  `ensureFreshCredential` round-trip through WHATEVER `KeychainDeps` they
 *  are given — "available" is entirely the test's choice, never a real OS
 *  call. */
function fakeKeychain(available: boolean): { deps: KeychainDeps; store: Map<string, string> } {
  const backing = new Map<string, string>();
  // Asserts through the SAME `KeychainDeps.runCommand` seam
  // `credential-keychain.ts`'s real functions call, emulating exactly what
  // `security` would do for the macOS backend — this exercises
  // `persistCredentialSecurely`/`ensureFreshCredential`'s OWN call shape
  // (`storeInKeychain`/`readFromKeychain`), not a re-implementation of them.
  const deps: KeychainDeps = {
    platform: 'darwin', // any backend-bearing platform — the fake ignores it
    runCommand: (cmd, args) => {
      if (!available) return { status: null, stdout: '', stderr: 'ENOENT' };
      if (cmd === 'security' && args.includes('add-generic-password')) {
        const account = args[args.indexOf('-a') + 1]!;
        const secret = args[args.indexOf('-w') + 1]!;
        backing.set(account, secret);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'security' && args.includes('find-generic-password')) {
        const account = args[args.indexOf('-a') + 1]!;
        const value = backing.get(account);
        return value !== undefined
          ? { status: 0, stdout: `${value}\n`, stderr: '' }
          : { status: 44, stdout: '', stderr: 'not found' };
      }
      if (cmd === 'security' && args.includes('delete-generic-password')) {
        const account = args[args.indexOf('-a') + 1]!;
        backing.delete(account);
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`fakeKeychain: unexpected invocation ${cmd} ${args.join(' ')}`);
    },
  };
  return { deps, store: backing };
}

describe('b14 — persistCredentialSecurely: keychain AVAILABLE strips refresh_token from the file', () => {
  test('a refresh_token present in the store is moved into the keychain; the on-disk file has neither the token nor a truthy value for it', () => {
    const home = mkHome();
    const credPath = seed(home, { access_token: 'at1', refresh_token: 'rt-should-move' });
    const { deps: keychain, store: backing } = fakeKeychain(true);

    const store = readCredentialStore(realFs, credPath);
    persistCredentialSecurely({ fs: realFs, platform: 'linux', env: {}, keychain }, credPath, store, SERVER);

    const onDisk = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(onDisk.servers[SERVER].refresh_token).toBeUndefined();
    expect(JSON.stringify(onDisk)).not.toContain('rt-should-move');
    expect(onDisk.servers[SERVER].refresh_token_in_keychain).toBe(true);
    expect(backing.get(SERVER)).toBe('rt-should-move');
  });

  test('keychain UNAVAILABLE (the documented fallback): refresh_token stays inline, exactly as before this task', () => {
    const home = mkHome();
    const credPath = seed(home, { access_token: 'at1', refresh_token: 'rt-stays-in-file' });
    const { deps: keychain } = fakeKeychain(false);

    const store = readCredentialStore(realFs, credPath);
    persistCredentialSecurely({ fs: realFs, platform: 'linux', env: {}, keychain }, credPath, store, SERVER);

    const onDisk = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(onDisk.servers[SERVER].refresh_token).toBe('rt-stays-in-file');
    expect(onDisk.servers[SERVER].refresh_token_in_keychain).toBeFalsy();
  });
});

describe('b14 — ensureFreshCredential round-trips a keychain-backed refresh token', () => {
  test('a credential whose refresh_token lives ONLY in the keychain still refreshes successfully, and the rotated token is placed back in the keychain', async () => {
    const home = mkHome();
    const credPath = seed(home, { access_token: 'at-old', expires_at: 2_030_000, refresh_token_in_keychain: true });
    const { deps: keychain, store: backing } = fakeKeychain(true);
    backing.set(SERVER, 'rt-from-keychain');

    const calls: HttpInit[] = [];
    const deps: RefreshDeps = {
      ...baseDeps(home, async (url, init) => {
        calls.push(init);
        const params = new URLSearchParams(init.body ?? '');
        expect(params.get('refresh_token')).toBe('rt-from-keychain');
        return reply(200, { access_token: 'at-new', token_type: 'Bearer', expires_in: 900, refresh_token: 'rt-new' });
      }),
      keychain,
    };

    const cred = await ensureFreshCredential(deps, SERVER);
    expect(cred.access_token).toBe('at-new');
    expect(calls).toHaveLength(1);

    // The rotated token was placed back in the (fake) keychain, and the file
    // still carries no plaintext refresh_token.
    expect(backing.get(SERVER)).toBe('rt-new');
    const onDisk = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(onDisk.servers[SERVER].refresh_token).toBeUndefined();
    expect(onDisk.servers[SERVER].refresh_token_in_keychain).toBe(true);
  });

  test('the marker says keychain, but the entry is gone (lookup returns nothing) — clean CloudError, never a crash', async () => {
    const home = mkHome();
    seed(home, { access_token: 'at-old', expires_at: 2_030_000, refresh_token_in_keychain: true });
    const { deps: keychain } = fakeKeychain(true); // available, but nothing was ever stored under SERVER

    const deps: RefreshDeps = {
      ...baseDeps(home, async () => {
        throw new Error('must not reach the network — there is no token to refresh with');
      }),
      keychain,
    };
    await expect(ensureFreshCredential(deps, SERVER)).rejects.toThrow(/cannot be refreshed automatically/);
  });
});

// ---------------------------------------------------------------------------
// b14 — refresh-token inactivity expiry, the CLI-side mirror of the server's
// RFC 9700 §4.14.2 SHOULD (`f3`'s `REFRESH_TOKEN_INACTIVITY_WINDOW_S`, same
// 14-day number, duplicated per this file's own module doc).
// ---------------------------------------------------------------------------

describe('isRefreshInactive — the pure decision', () => {
  test('exactly at the window boundary is NOT yet inactive (strictly greater-than, mirrors the server)', () => {
    const now = 1_000_000_000;
    expect(isRefreshInactive(now - REFRESH_TOKEN_INACTIVITY_WINDOW_S * 1000, now)).toBe(false);
  });
  test('one second past the window IS inactive', () => {
    const now = 1_000_000_000;
    expect(isRefreshInactive(now - REFRESH_TOKEN_INACTIVITY_WINDOW_S * 1000 - 1000, now)).toBe(true);
  });
  test('undefined lastUsedAt (no local history yet) is NOT treated as inactive', () => {
    expect(isRefreshInactive(undefined, 1_000_000_000)).toBe(false);
  });
  test('the exported window constant is exactly 14 days, matching f3', () => {
    expect(REFRESH_TOKEN_INACTIVITY_WINDOW_S).toBe(14 * 24 * 60 * 60);
  });
});

describe('ensureFreshCredential — local inactivity expiry', () => {
  test('a refresh_token idle for more than 14 days is refused LOCALLY — no network call at all', async () => {
    const home = mkHome();
    const now = 2_000_000_000;
    seed(home, {
      access_token: 'at-old',
      refresh_token: 'rt-old',
      expires_at: 1_000, // needs refresh
      last_used_at: now - (REFRESH_TOKEN_INACTIVITY_WINDOW_S * 1000 + 60_000), // 15 days idle
    });
    let networkCalls = 0;
    const deps = baseDeps(
      home,
      async () => {
        networkCalls++;
        throw new Error('must not be called — the credential is locally inactive');
      },
      () => now,
    );
    await expect(ensureFreshCredential(deps, SERVER)).rejects.toThrow(/inactive/);
    await expect(ensureFreshCredential(deps, SERVER)).rejects.toThrow(/pipeline cloud connect --reauth/);
    expect(networkCalls).toBe(0);
  });

  test('a refresh_token used 13 days ago (inside the window) still refreshes normally', async () => {
    const home = mkHome();
    const now = 2_000_000_000;
    seed(home, {
      access_token: 'at-old',
      refresh_token: 'rt-old',
      expires_at: 1_000,
      last_used_at: now - 13 * 24 * 60 * 60 * 1000,
    });
    const deps = baseDeps(
      home,
      async () => reply(200, { access_token: 'at-new', token_type: 'Bearer', expires_in: 900, refresh_token: 'rt-new' }),
      () => now,
    );
    const cred = await ensureFreshCredential(deps, SERVER);
    expect(cred.access_token).toBe('at-new');
  });

  test('a credential with NO last_used_at at all (pre-b14) is not punished — it refreshes, and gains a fresh last_used_at', async () => {
    const home = mkHome();
    const now = 2_000_000_000;
    const credPath = seed(home, { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 1_000 });
    const deps = baseDeps(
      home,
      async () => reply(200, { access_token: 'at-new', token_type: 'Bearer', expires_in: 900, refresh_token: 'rt-new' }),
      () => now,
    );
    const cred = await ensureFreshCredential(deps, SERVER);
    expect(cred.access_token).toBe('at-new');
    expect(cred.last_used_at).toBe(now);
    const onDisk = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(onDisk.servers[SERVER].last_used_at).toBe(now);
  });

  test('a successful refresh re-authorizes cleanly afterward: the re-auth error names the exact remedy, and a fresh connect (simulated by re-seeding) then refreshes fine', async () => {
    const home = mkHome();
    const now = 2_000_000_000;
    const credPath = seed(home, {
      access_token: 'at-old',
      refresh_token: 'rt-old',
      expires_at: 1_000,
      last_used_at: now - (REFRESH_TOKEN_INACTIVITY_WINDOW_S * 1000 + 1),
    });
    const deadDeps = baseDeps(home, async () => {
      throw new Error('must not be called');
    }, () => now);
    let threw: unknown;
    try {
      await ensureFreshCredential(deadDeps, SERVER);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(CloudError);
    expect((threw as Error).message).toContain('pipeline cloud connect --reauth');

    // Simulate what `pipeline cloud connect --reauth` does: mint a whole new
    // credential (fresh last_used_at), overwriting the stale one.
    writeCredentialStore(realFs, credPath, {
      version: 1,
      servers: { [SERVER]: { access_token: 'at-fresh', refresh_token: 'rt-fresh', token_type: 'bearer', expires_at: 1_000, last_used_at: now } },
    });
    const liveDeps = baseDeps(
      home,
      async () => reply(200, { access_token: 'at-newer', token_type: 'Bearer', expires_in: 900, refresh_token: 'rt-newer' }),
      () => now,
    );
    const cred = await ensureFreshCredential(liveDeps, SERVER);
    expect(cred.access_token).toBe('at-newer');
  });
});
