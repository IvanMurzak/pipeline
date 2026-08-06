// credential-refresh.ts — single-flight, cross-process refresh of the
// credential store's access/refresh token pair (a5, 04-cloud-auth.md §6).
//
// THE THREAT THIS FILE EXISTS TO PREVENT: the shipped authorization server
// implements refresh-token-FAMILY reuse detection that revokes the WHOLE
// family the instant a rotated token is presented a second time — read
// directly (not assumed) from
// `cloud/apps/api/src/modules/mesh-oauth/routes.ts`'s `handleRefreshTokenGrant`:
//   - an unknown/already-revoked token          → 400 invalid_grant
//     ("refresh token reuse detected — the token family has been revoked"),
//     AND `store.revokeRefreshTokenFamily(row.family_id, now)` runs — every
//     descendant of the original grant dies, not just this one row;
//   - `store.revokeRefreshToken` is a compare-and-swap: if it returns
//     `false` (a CONCURRENT request already rotated this exact token between
//     this handler's read and its write), the family is ALSO revoked — this
//     is the closer race the "already revoked" check alone cannot catch.
// Both paths return the SAME `invalid_grant` error code — the server gives
// no oracle distinguishing "genuinely expired" from "reuse detected, family
// revoked" (see `REAUTH_REQUIRED_MESSAGE` below).
//
// One credential file is shared by the interactive CLI (`commands/cloud.ts`),
// the always-on `pipeline department notify` daemon (`lib/department-notify.ts`
// — the "always-on supervisor" 04§6 names), and any concurrent `department
// serve`/`status` this product ships later. `ensureFreshCredential` below is
// the ONLY code in this package allowed to call the refresh grant — every
// caller MUST route through it rather than hand-rolling its own POST.
//
// MECHANISM:
//   1. Fast path, NO lock: if this process's own read of the store already
//      looks fresh (no expiry, or expiry comfortably outside the refresh
//      buffer), return it immediately. Keeps the common case lock-free.
//   2. Otherwise take the cross-process advisory lock
//      (`credential-lock.ts`) around the WHOLE read-refresh-write cycle, per
//      04§6's requirement.
//   3. RE-READ the store AFTER acquiring the lock — the only read this
//      function trusts for the actual refresh decision. If it is fresh NOW
//      (an earlier holder already rotated it while this process waited),
//      return THAT credential — zero network calls from this process. This
//      is the "await the one in-flight refresh and re-read its result"
//      requirement, not "serialize into two sequential refreshes".
//   4. Only if the store is STILL stale under the lock does this process
//      call the refresh grant itself, then persist the rotated pair with an
//      atomic write-then-rename (`cloud-config.ts`'s `writeCredentialStore`)
//      and the per-platform file protection before releasing the lock.
//   5. `invalid_grant` from the refresh grant is never a crash: it throws a
//      `CloudError` carrying 04-cloud-auth.md §9's exact stated message.
//      Every existing caller already maps a thrown `CloudError` to a clean
//      exit — see `commands/cloud.ts`'s `runCloud` and this module's own
//      callers in `lib/department-notify.ts`.

import {
  CloudError,
  credentialFilePath,
  credentialLockPath,
  readCredentialStore,
  writeCredentialStore,
  type CloudFs,
  type CredentialStore,
  type HomeContext,
  type StoredCredential,
} from './cloud-config';
import { acquireLock, realLockDeps, type LockDeps } from './credential-lock';
import { protectCredentialFile } from './credential-protect';
import { readFromKeychain, storeInKeychain, realRunKeychainCommand, type KeychainDeps } from './credential-keychain';

// ---------------------------------------------------------------------------
// HTTP seam — deliberately local (mirrors commands/cloud.ts's near-identical
// shape); lib/ must not depend on commands/ — see department-notify.ts's own
// note on why it duplicates rather than imports.
// ---------------------------------------------------------------------------

export interface HttpResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface HttpInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type FetchLike = (url: string, init: HttpInit) => Promise<HttpResponse>;

export const realRefreshFetch: FetchLike = async (url, init) => {
  return (await fetch(url, init as RequestInit)) as unknown as HttpResponse;
};

/** Pre-registered public client id — mirrors `commands/cloud.ts`'s
 *  `CLI_CLIENT_ID` byte-for-byte (duplicated rather than imported, same
 *  lib-must-not-depend-on-commands rule as `department-notify.ts`). The refresh
 *  grant handler does not actually validate `client_id` server-side today
 *  (`handleRefreshTokenGrant` reads only `body.refresh_token`), but sending
 *  it keeps this request shaped like every other grant this CLI makes. */
const CLI_CLIENT_ID = 'ai-pipeline-cli';

const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };

/** How long before real expiry a credential is treated as "needs refresh".
 *  Access tokens are minted with a 15-minute TTL server-side
 *  (`mesh-oauth/jwt.ts`'s `ACCESS_TOKEN_TTL_S`); 60s comfortably covers a
 *  lock wait plus one refresh HTTP round trip without risking a caller
 *  observing a token that expires moments after this function returns it. */
const REFRESH_BUFFER_MS = 60_000;

/**
 * b14 — RFC 9700 §4.14.2 SHOULD ("refresh tokens SHOULD expire if the client
 * has been inactive for some time"), the CLI-side half; `f3` is the
 * server-side half (`cloud/apps/api/src/modules/auth/refresh-token-
 * policy.ts#REFRESH_TOKEN_INACTIVITY_WINDOW_S`). SAME NUMBER, duplicated
 * rather than imported — this package cannot import the private `cloud/`
 * tree (the same constraint this file's module doc and `CLI_CLIENT_ID`
 * already document), and `07-security.md` §3.1 records this exact value as
 * the one `b14` MUST use for its own local check.
 */
export const REFRESH_TOKEN_INACTIVITY_WINDOW_S = 14 * 24 * 60 * 60; // 14 days

/**
 * True when `lastUsedAt` (epoch ms — `StoredCredential.last_used_at`) is more
 * than `windowS` in the past. Mirrors the server's `isRefreshTokenInactive`
 * with one deliberate difference: `lastUsedAt === undefined` returns `false`
 * rather than falling back to a creation timestamp. A credential written by
 * a pre-b14 CLI has no local activity history at all — treating "no history"
 * as "definitely stale" would force every already-connected user into an
 * immediate re-login the moment they upgrade, which is not what a SHOULD is
 * for. `ensureFreshCredential` backfills `last_used_at` on the very next
 * successful refresh either way, so the local clock starts from the first
 * observation instead of guessing at one that was never recorded.
 */
export function isRefreshInactive(
  lastUsedAt: number | undefined,
  now: number,
  windowS: number = REFRESH_TOKEN_INACTIVITY_WINDOW_S,
): boolean {
  if (lastUsedAt === undefined) return false;
  return now - lastUsedAt > windowS * 1000;
}

/** 04-cloud-auth.md §9's EXACT wording for "Refresh lost a rotation race" —
 *  used for every `invalid_grant` a refresh attempt receives. The server
 *  gives no distinguishable error code between "genuinely expired" and
 *  "reuse detected, family revoked" (both are `invalid_grant`; see this
 *  file's module doc), so every refresh-time `invalid_grant` maps to this
 *  ONE message rather than inventing a distinction the server deliberately
 *  does not make. */
export const REAUTH_REQUIRED_MESSAGE = 'Your session was refreshed elsewhere. Re-run to sign in again.';

interface RefreshTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface RefreshDeps {
  fetch: FetchLike;
  fs: CloudFs;
  now: () => number;
  platform: string;
  env: Record<string, string | undefined>;
  homedir: string;
  /** Injected so tests control lock acquisition (timing/pid/hostname, or a
   *  scripted failure) without a real cross-process race; production always
   *  uses `realLockDeps` (the default when omitted). */
  lock?: LockDeps;
  /** Bounded wait for the cross-process lock — see `credential-lock.ts`. */
  lockTimeoutMs?: number;
  /** b14 — injected so tests script the OS keychain backend (available/
   *  unavailable, a scripted failure) without a real Keychain/Secret Service
   *  to observe it against. Production always resolves to
   *  `{ platform: deps.platform, runCommand: realRunKeychainCommand }` (the
   *  default when omitted) — see `credential-keychain.ts`. */
  keychain?: KeychainDeps;
}

/** `expires_at === undefined` means "never expires" (matches
 *  `commands/cloud.ts`'s pre-existing `reusable` check) — such a credential
 *  is never refreshed automatically. */
function needsRefresh(cred: StoredCredential | undefined, now: number): boolean {
  if (!cred) return false;
  if (cred.expires_at === undefined) return false;
  return cred.expires_at <= now + REFRESH_BUFFER_MS;
}

async function callRefreshGrant(
  deps: RefreshDeps,
  server: string,
  refreshToken: string,
): Promise<RefreshTokenResponse> {
  let res: HttpResponse;
  try {
    res = await deps.fetch(`${server}/oauth/token`, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLI_CLIENT_ID,
        resource: `${server}/api`,
      }).toString(),
    });
  } catch (e) {
    throw new CloudError(`could not reach ${server} to refresh the session — ${(e as Error).message}`);
  }
  if (res.status !== 200) {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: unknown };
      code = typeof body.error === 'string' ? body.error : undefined;
    } catch {
      // tolerate a non-JSON error body
    }
    if (code === 'invalid_grant') {
      throw new CloudError(REAUTH_REQUIRED_MESSAGE);
    }
    throw new CloudError(`session refresh failed (HTTP ${res.status}${code ? `: ${code}` : ''})`);
  }
  const body = (await res.json()) as RefreshTokenResponse;
  if (!body || !body.access_token) {
    throw new CloudError('refresh response was missing access_token');
  }
  return body;
}

function resolveKeychainDeps(deps: { platform: string; keychain?: KeychainDeps }): KeychainDeps {
  return deps.keychain ?? { platform: deps.platform, runCommand: realRunKeychainCommand };
}

/**
 * Persist `store` and apply BOTH b14 protections in one call: the OS
 * keychain for `server`'s refresh token where available (this function's own
 * addition), and the pre-existing per-platform file protection
 * (`writeCredentialStore`'s `chmod 0600` plus `protectCredentialFile`'s
 * Windows ACL). Every writer of the credential store — `ensureFreshCredential`
 * below and `commands/cloud.ts`'s `persistCredential` — MUST go through this
 * rather than calling `writeCredentialStore` directly, exactly the same
 * "no write site can forget the protection step" reasoning
 * `commands/cloud.ts`'s own `persistCredential` doc comment already states
 * for the Windows ACL alone.
 *
 * IDEMPOTENT AND SELF-CORRECTING: it inspects `store.servers[server]` fresh
 * on every call, so it does not matter whether the in-memory `refresh_token`
 * field is already keychain-backed, freshly rotated, or plain — this
 * function always decides for itself where the SERIALIZED copy's secret
 * belongs, and strips it from the file when (and only when) the keychain
 * write just now succeeded. A keychain write failure is silently the
 * documented fallback: the refresh token stays in the file, precisely as it
 * did before this task, and `refresh_token_in_keychain` is left false so a
 * later read never mistakes the file's own copy for a stale one.
 */
export function persistCredentialSecurely(
  deps: { fs: CloudFs; platform: string; env: Record<string, string | undefined>; keychain?: KeychainDeps },
  filePath: string,
  store: CredentialStore,
  server: string,
): void {
  const keychainDeps = resolveKeychainDeps(deps);
  const cred = store.servers[server];
  let toPersist = store;
  if (cred?.refresh_token) {
    const stored = storeInKeychain(keychainDeps, server, cred.refresh_token);
    const updatedCred: StoredCredential = stored
      ? { ...cred, refresh_token: undefined, refresh_token_in_keychain: true }
      : { ...cred, refresh_token_in_keychain: false };
    toPersist = { ...store, servers: { ...store.servers, [server]: updatedCred } };
  }
  writeCredentialStore(deps.fs, filePath, toPersist);
  protectCredentialFile(filePath, { platform: deps.platform, env: deps.env });
}

/**
 * Return a credential for `server` that is safe to use right now, refreshing
 * it first if it is missing/expiring — single-flight across every process on
 * this machine sharing the credential store (see this file's module doc).
 *
 * Throws `CloudError`:
 *   - `REAUTH_REQUIRED_MESSAGE` — the refresh grant returned `invalid_grant`
 *     (expired, unknown, or a reuse-detected family revocation).
 *   - "no stored credential for …" — nothing stored for `server` at all.
 *   - "…cannot be refreshed automatically…" — expired with no
 *     `refresh_token` to rotate (e.g. a machine credential, or a legacy PAT
 *     minted before a3).
 * Never throws for a credential that is already valid — that is the fast,
 * lock-free path.
 */
export async function ensureFreshCredential(deps: RefreshDeps, server: string): Promise<StoredCredential> {
  const ctx: HomeContext = { platform: deps.platform, env: deps.env, homedir: deps.homedir };
  const credPath = credentialFilePath(ctx);

  const fastRead = readCredentialStore(deps.fs, credPath);
  const fast = fastRead.servers[server];
  if (!fast) {
    throw new CloudError(`no stored credential for ${server} — run \`pipeline cloud connect\``);
  }
  if (!needsRefresh(fast, deps.now())) {
    return fast; // fast path — no lock needed
  }

  const lockDeps = deps.lock ?? realLockDeps;
  const handle = await acquireLock(credentialLockPath(ctx), lockDeps, { timeoutMs: deps.lockTimeoutMs });
  try {
    // The ONLY read this function trusts for the actual refresh decision —
    // whatever the fast path saw is now stale by definition (time passed
    // while waiting for the lock).
    const store = readCredentialStore(deps.fs, credPath);
    const current = store.servers[server];
    if (!current) {
      throw new CloudError(`no stored credential for ${server} — run \`pipeline cloud connect\``);
    }
    if (!needsRefresh(current, deps.now())) {
      // Someone else refreshed it while this process waited for the lock —
      // use THEIR result. Zero network calls from here: the single-flight
      // hand-off 04§6 requires ("await the one in-flight refresh and
      // re-read its result", not "serialize into two sequential refreshes").
      return current;
    }
    if (!current.refresh_token && !current.refresh_token_in_keychain) {
      throw new CloudError(
        `the stored credential for ${server} is expired and cannot be refreshed automatically — ` +
          'run `pipeline cloud connect --reauth`',
      );
    }
    // b14 — the local mirror of the server's RFC 9700 §4.14.2 SHOULD
    // (`f3`'s `REFRESH_TOKEN_INACTIVITY_WINDOW_S`). Checked BEFORE resolving
    // the actual refresh-token value (which, for a keychain-backed
    // credential, costs a real subprocess call) and before touching the
    // network at all: a credential this stale is refused locally, on the
    // same 14-day number the server would refuse it on anyway, rather than
    // spending a round trip to learn what this process can already tell.
    if (isRefreshInactive(current.last_used_at, deps.now())) {
      throw new CloudError(
        `the stored credential for ${server} has been inactive for more than ` +
          `${Math.floor(REFRESH_TOKEN_INACTIVITY_WINDOW_S / 86_400)} days and can no longer be refreshed ` +
          'automatically — run `pipeline cloud connect --reauth`',
      );
    }
    const keychainDeps = resolveKeychainDeps(deps);
    const refreshToken = current.refresh_token ?? readFromKeychain(keychainDeps, server);
    if (!refreshToken) {
      // The marker said the keychain holds it, but the lookup came back
      // empty (backend went unavailable since it was written, the entry was
      // removed out-of-band, …) — fail exactly like "no refresh_token at
      // all" rather than crash: the file's own protection never claimed to
      // survive the keychain disappearing out from under it.
      throw new CloudError(
        `the stored credential for ${server} is expired and cannot be refreshed automatically — ` +
          'run `pipeline cloud connect --reauth`',
      );
    }
    const tok = await callRefreshGrant(deps, server, refreshToken);
    const updated: StoredCredential = {
      ...current,
      access_token: tok.access_token,
      token_type: tok.token_type ?? current.token_type ?? 'bearer',
      refresh_token: tok.refresh_token ?? refreshToken,
      expires_at: tok.expires_in ? deps.now() + tok.expires_in * 1000 : undefined,
      last_used_at: deps.now(),
      refresh_token_in_keychain: undefined,
    };
    store.servers[server] = updated;
    persistCredentialSecurely(
      { fs: deps.fs, platform: deps.platform, env: deps.env, keychain: keychainDeps },
      credPath,
      store,
      server,
    );
    return updated;
  } finally {
    handle.release();
  }
}
