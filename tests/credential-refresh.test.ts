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
  REAUTH_REQUIRED_MESSAGE,
  type RefreshDeps,
  type HttpResponse,
  type HttpInit,
} from '../src/lib/credential-refresh';
import {
  realFs,
  credentialFilePath,
  credentialLockPath,
  writeCredentialStore,
  CloudError,
  type HomeContext,
} from '../src/lib/cloud-config';

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
  fields: { access_token: string; refresh_token?: string; expires_at?: number; token_type?: string },
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
