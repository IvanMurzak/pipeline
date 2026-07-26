// `pipeline cloud connect [--server <url>] [--project <slug>] [--org <slug>]
//                         [--reauth] [--device] [--json]`
//
// Link the current project to the cloud control plane. The user is NEVER
// asked which authentication method to use (simplified-onboarding
// `04-cloud-auth.md` §4's selection ladder decides): a browser
// authorization_code + PKCE flow with a loopback redirect (RFC 8252) is the
// default, and it silently falls back to the legacy OAuth-style device flow
// (RFC 8628-shaped) — printing a one-line reason — when no browser is
// reachable, the loopback port can't be bound, `SSH_CONNECTION` is set with
// no X forwarding, the browser opener exits non-zero, or `--device` was
// passed explicitly. Either way the obtained token lands in the SECURE
// per-user credential store, then a NON-SECRET project↔cloud binding is
// recorded in `<cwd>/.claude/pipeline/cloud.json`.
//
// Server contract (read-only source of truth):
//   Device flow — apps/api/src/modules/auth/routes.ts:
//     POST /auth/device/start  → 200 { device_code, user_code, verification_uri,
//                                       verification_uri_complete, expires_in, interval }
//     POST /auth/device/token  { device_code } →
//          200 { access_token, token_type, expires_in, token_prefix }  (approved)
//          400 { error: "authorization_pending" }  → keep polling
//          400 { error: "slow_down" }              → widen the interval, keep polling
//          400 { error: "access_denied" }          → user denied — abort
//          400 { error: "expired_token" }          → code expired — abort
//   Browser flow — apps/api/src/modules/mesh-oauth/routes.ts:
//     GET  ${server}/oauth/authorize?client_id=ai-pipeline-cli&redirect_uri=
//          http://127.0.0.1:<port>/callback&response_type=code&code_challenge=
//          <S256 challenge>&code_challenge_method=S256&resource=${server}/api&
//          state=<state>   — opened in the system browser; the SPA at the SAME
//          origin renders the consent screen and eventually 302s the browser
//          to redirect_uri with `?code=&state=` (or `?error=&state=`).
//     POST ${server}/oauth/token  (form-urlencoded)
//          grant_type=authorization_code&code=&redirect_uri=&client_id=
//          ai-pipeline-cli&code_verifier=&resource=${server}/api →
//          200 { access_token, token_type, expires_in, refresh_token, scope }
//          — redirect_uri here MUST be byte-for-byte identical (port included)
//          to the one presented at /oauth/authorize (OAuth 2.1 §4.1.1/§4.1.3);
//          the RFC 8252 §7.3 loopback port exception applies only at
//          /oauth/authorize's registration check, never at this intra-flow
//          binding check. NO `scope` param on this resource — an `api`-
//          audience token carries none by design (mesh-oauth/resource.ts's
//          `scopesAllowedForResource("api")` is `[]`; a non-empty request is
//          refused).
//   Both flows — GET /api/v1/me  (Authorization: Bearer <token>) →
//        { user, orgs:[{id,slug,name,role}], selectedOrgId, selectedRole }
//        — the ONLY source of the org slug (neither token exchange carries
//        one for the browser flow's org selection step; org binding for the
//        *token itself* is separate and happens server-side at consent).
//
// Security invariants:
//   - cloud.json holds ONLY slugs/URLs — the token NEVER touches the project.
//   - the token is written to the per-user store with 0600 perms and is NEVER
//     printed to stdout/stderr (only its non-secret prefix, if shown at all).
//   - the loopback listener binds the IP LITERAL only (127.0.0.1 / [::1]),
//     never `localhost` (RFC 8252 §7.3); PKCE `S256` + `state` are both
//     mandatory and both drawn from a CSPRNG (see lib/loopback-oauth.ts); the
//     listener verifies `state` before anything else, rejects any path other
//     than `/callback`, enforces a short absolute timeout, and is closed on
//     EVERY exit path (success, wrong state, timeout, or an aborted attempt)
//     — simplified-onboarding `07-approval-policy.md` §8.
//
// Exit: 0 connected/updated · 1 auth/network/identity failure · 2 usage.
//
// Every side effect (HTTP, filesystem, clock, sleep, env, home dir, cwd,
// subprocess spawn, the loopback HTTP server) is injected via CloudDeps so
// tests drive the whole flow with zero real browser/OS interaction.

import { homedir } from 'node:os';
import type { Server } from 'node:http';
import {
  CloudError,
  DEFAULT_SERVER,
  SERVER_ENV,
  realFs,
  readCredentialStore,
  writeCredentialStore,
  readCloudBinding,
  writeCloudBinding,
  cloudJsonPath,
  credentialFilePath,
  normalizeServerUrl,
  slugify,
  defaultProjectSlug,
  type CloudFs,
  type CloudBinding,
  type StoredCredential,
} from '../lib/cloud-config';
import {
  bindLoopbackListener,
  buildAuthorizeUrl,
  buildOpenBrowserCommand,
  decidePreflightFallback,
  deriveChallengeS256,
  generateCodeVerifier,
  generateState,
  openBrowser,
  realSpawnBrowser,
  type SpawnFn,
} from '../lib/loopback-oauth';

// ---------------------------------------------------------------------------
// HTTP seam
// ---------------------------------------------------------------------------

export interface HttpResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HttpInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type FetchLike = (url: string, init: HttpInit) => Promise<HttpResponse>;

const realFetch: FetchLike = async (url, init) => {
  return (await fetch(url, init as RequestInit)) as unknown as HttpResponse;
};

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface CloudDeps {
  fetch: FetchLike;
  fs: CloudFs;
  /** Epoch ms — only used for deadlines + timestamps. */
  now: () => number;
  /** Resolves after `ms`; tests advance a fake clock here instead of waiting. */
  sleep: (ms: number) => Promise<void>;
  env: Record<string, string | undefined>;
  platform: string;
  homedir: string;
  cwd: string;
  /** Where human-facing lines go (stdout). NEVER receives the token. */
  out: (s: string) => void;
  /** Where errors/progress go (stderr). NEVER receives the token. */
  err: (s: string) => void;

  // ---- Loopback browser flow (a2) — all OPTIONAL. `realDeps` below needs no
  // changes: `loopback-oauth.ts`'s functions apply real defaults (node:http,
  // node:child_process, a real PATH scan) whenever these are `undefined`, so
  // only tests that specifically exercise the browser flow need to set them.

  /** Spawn the OS browser-opener subprocess. Defaults to `node:child_process.spawn`. */
  spawn?: SpawnFn;
  /** Factory for the loopback HTTP server. Defaults to `node:http.createServer`.
   *  Test seam for deterministically simulating an unbindable port. */
  createLoopbackServer?: () => Server;
  /** Whether a named command exists on `PATH` — the Linux opener-presence
   *  pre-flight check. Defaults to a real PATH scan. */
  commandExists?: (cmd: string) => boolean;
  /** Absolute timeout (ms) for the loopback listener. Defaults to 5 minutes
   *  in production; tests inject a small value to exercise the "late
   *  callback" path without a real multi-minute wait. */
  loopbackTimeoutMs?: number;
  /** Bounded grace period (ms) waiting for the browser-opener subprocess's
   *  own exit code before assuming it worked anyway. Defaults to 5 seconds
   *  in production; tests inject a small value to exercise a hung opener
   *  without a real wait. */
  openBrowserGraceMs?: number;
}

export const realDeps: CloudDeps = {
  fetch: realFetch,
  fs: realFs,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  cwd: process.cwd(),
  out: (s) => {
    process.stdout.write(s);
  },
  err: (s) => {
    process.stderr.write(s);
  },
};

// ---------------------------------------------------------------------------
// Server response shapes (subset we consume)
// ---------------------------------------------------------------------------

interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  token_prefix?: string;
  /** Browser flow only — device-grant tokens are refreshable too, but the
   *  device-flow branch below has never stored one, and a5 (credential-store
   *  refresh: single-flight rotation with family-reuse detection) owns
   *  actually persisting and rotating this. Out of scope here on purpose —
   *  see the module doc. */
  refresh_token?: string;
  scope?: string;
}

interface MeOrg {
  id: string;
  slug: string;
  name: string;
  role: string;
}

interface MeResponse {
  user?: { id: string; email?: string };
  orgs: MeOrg[];
  selectedOrgId: string | null;
}

const DEFAULT_INTERVAL_S = 5;
const DEFAULT_EXPIRES_S = 15 * 60;
const SLOW_DOWN_BUMP_S = 5;

/** Pre-registered public client id (cloud/apps/api/src/modules/mesh-oauth/
 *  clients.ts) — carries the loopback redirect patterns for the browser flow
 *  and has no `redirect_uri` use on the device grant. */
const CLI_CLIENT_ID = 'ai-pipeline-cli';
/** Short ABSOLUTE timeout for the loopback listener (07-approval-policy.md
 *  §8) — bounds the whole browser-flow attempt, not just the wait after the
 *  browser opens. 5 minutes covers a slow sign-in without leaving a loopback
 *  listener open indefinitely. */
const DEFAULT_LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;
/** See `CloudDeps.openBrowserGraceMs`'s doc comment. */
const DEFAULT_OPEN_BROWSER_GRACE_MS = 5000;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const USAGE =
  'Usage: pipeline cloud connect [--server <url>] [--project <slug>] [--org <slug>]\n' +
  '                              [--reauth] [--device] [--json]\n' +
  '  Authenticate and bind this project to the cloud control plane. Opens a\n' +
  '  browser by default (one approval, no typed code); falls back to a device\n' +
  '  code when no browser is reachable, or always with --device.\n' +
  '  Writes non-secret slugs to .claude/pipeline/cloud.json; the credential is\n' +
  '  stored separately in a secure per-user location (never in the project).\n';

export interface ConnectOptions {
  server?: string;
  project?: string;
  org?: string;
  reauth: boolean;
  /** Skip the browser flow and go straight to the device code, even when a
   *  browser would otherwise be reachable (04-cloud-auth.md §1.2's fifth
   *  fallback trigger). */
  device: boolean;
  json: boolean;
}

export function parseConnectArgs(args: string[]): ConnectOptions | { error: string } {
  const out: ConnectOptions = { reauth: false, device: false, json: false };
  const takeValue = (flag: string, i: number): string | { error: string } => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) return { error: `${flag} requires a value` };
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--server' || a.startsWith('--server=')) {
      if (a.startsWith('--server=')) out.server = a.slice('--server='.length);
      else {
        const v = takeValue('--server', i++);
        if (typeof v !== 'string') return v;
        out.server = v;
      }
    } else if (a === '--project' || a.startsWith('--project=')) {
      if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
      else {
        const v = takeValue('--project', i++);
        if (typeof v !== 'string') return v;
        out.project = v;
      }
    } else if (a === '--org' || a.startsWith('--org=')) {
      if (a.startsWith('--org=')) out.org = a.slice('--org='.length);
      else {
        const v = takeValue('--org', i++);
        if (typeof v !== 'string') return v;
        out.org = v;
      }
    } else if (a === '--reauth') {
      out.reauth = true;
    } else if (a === '--device') {
      out.device = true;
    } else if (a === '--json') {
      out.json = true;
    } else {
      return { error: `unknown argument '${a}'` };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function doFetch(deps: CloudDeps, url: string, init: HttpInit): Promise<HttpResponse> {
  try {
    return await deps.fetch(url, init);
  } catch (e) {
    throw new CloudError(`could not reach ${url} — ${(e as Error).message}`);
  }
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

/** Best-effort parse of an error body's `error` code (tolerant of non-JSON). */
async function errorCode(res: HttpResponse): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}

async function deviceStart(deps: CloudDeps, server: string): Promise<DeviceStartResponse> {
  const res = await doFetch(deps, `${server}/auth/device/start`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: '{}',
  });
  if (res.status !== 200) {
    const code = await errorCode(res);
    throw new CloudError(
      `device authorization request failed (HTTP ${res.status}${code ? `: ${code}` : ''})`,
    );
  }
  const body = (await res.json()) as DeviceStartResponse;
  if (!body || !body.device_code || !body.user_code || !body.verification_uri) {
    throw new CloudError('device authorization response was missing required fields');
  }
  return body;
}

/**
 * Poll the token endpoint until the user approves (200) or the flow ends
 * (denied/expired/deadline). Respects the server-provided poll `interval` and
 * `expires_in`, widening the interval on `slow_down`. Bounded — never loops
 * past the expiry deadline.
 */
async function pollForToken(
  deps: CloudDeps,
  server: string,
  start: DeviceStartResponse,
): Promise<TokenResponse> {
  let intervalMs =
    (start.interval && start.interval > 0 ? start.interval : DEFAULT_INTERVAL_S) * 1000;
  const expiresMs =
    (start.expires_in && start.expires_in > 0 ? start.expires_in : DEFAULT_EXPIRES_S) * 1000;
  const deadline = deps.now() + expiresMs;

  for (;;) {
    if (deps.now() >= deadline) {
      throw new CloudError(
        'timed out waiting for approval — the device code expired. Run `pipeline cloud connect` again',
      );
    }
    await deps.sleep(intervalMs);

    const res = await doFetch(deps, `${server}/auth/device/token`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ device_code: start.device_code }),
    });

    if (res.status === 200) {
      const body = (await res.json()) as TokenResponse;
      if (!body || !body.access_token) {
        throw new CloudError('token response was missing access_token');
      }
      return body;
    }

    const code = await errorCode(res);
    switch (code) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs += SLOW_DOWN_BUMP_S * 1000;
        continue;
      case 'access_denied':
        throw new CloudError('authorization was denied — nothing was connected');
      case 'expired_token':
        throw new CloudError(
          'the device code expired before it was approved — run `pipeline cloud connect` again',
        );
      default:
        throw new CloudError(
          `unexpected response from the token endpoint (HTTP ${res.status}${code ? `: ${code}` : ''})`,
        );
    }
  }
}

/** The legacy device flow's user-facing steps, extracted so both it and the
 *  browser flow's fallback path share one implementation. */
async function runDeviceFlow(deps: CloudDeps, server: string, say: (s: string) => void): Promise<TokenResponse> {
  const start = await deviceStart(deps, server);
  say('To authorize this device, open:\n');
  say(`  ${start.verification_uri_complete ?? start.verification_uri}\n`);
  say(`and enter the code:  ${start.user_code}\n`);
  say('Waiting for you to approve in the browser…\n');
  return await pollForToken(deps, server, start);
}

/**
 * `POST /oauth/token` (grant_type=authorization_code) — the browser flow's
 * token exchange. `redirect_uri` here MUST be byte-for-byte identical (port
 * included) to the one presented at `/oauth/authorize`: the server's
 * `handleAuthorizationCodeGrant` compares `row.redirect_uri !== redirectUri`
 * as an EXACT string match — the RFC 8252 §7.3 loopback port exception is a
 * REGISTRATION-time rule only (mesh-oauth/redirect-uri.ts's module doc), not
 * applied again here. `resource` mirrors what was sent at `/oauth/authorize`
 * — the `<server>/api` REST audience, never a scope (see this file's module
 * doc on why).
 */
async function exchangeAuthorizationCode(
  deps: CloudDeps,
  server: string,
  params: { code: string; redirectUri: string; codeVerifier: string; resource: string },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: CLI_CLIENT_ID,
    code_verifier: params.codeVerifier,
    resource: params.resource,
  }).toString();
  const res = await doFetch(deps, `${server}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (res.status !== 200) {
    const code = await errorCode(res);
    throw new CloudError(`authorization failed (HTTP ${res.status}${code ? `: ${code}` : ''})`);
  }
  const parsed = (await res.json()) as TokenResponse;
  if (!parsed || !parsed.access_token) {
    throw new CloudError('token response was missing access_token');
  }
  return parsed;
}

type BrowserFlowResult =
  | { kind: 'ok'; token: TokenResponse }
  /** A pre-flight or in-flight environment limitation — 04-cloud-auth.md
   *  §1.2's triggers. The caller falls through to the device flow silently
   *  (a one-line reason is still printed, when there is one — `--device`
   *  itself carries none, see `decidePreflightFallback`). */
  | { kind: 'fallback'; reason: string | null }
  /** The browser flow was actually ATTEMPTED (the listener bound and the
   *  browser opened) and then failed — wrong `state`, a declined consent, a
   *  timeout, or a token-exchange error. This is NEVER silently downgraded
   *  to the device flow (07-approval-policy.md §8: "never retried, never
   *  treated as a second chance") — it is a hard failure of this `connect`
   *  invocation. */
  | { kind: 'error'; error: CloudError };

/**
 * Attempt the browser authorization_code + PKCE loopback flow. Every exit
 * path — success, a fallback trigger discovered before/while binding, or a
 * hard error after the browser opened — closes the loopback listener before
 * returning (the `finally` below; `bindLoopbackListener`'s own request
 * handler already closes it on a settled outcome, and `session.close()` is
 * idempotent, so this is a belt-and-braces guarantee that covers a thrown
 * exception from the token exchange too).
 */
async function tryBrowserFlow(deps: CloudDeps, server: string, say: (s: string) => void): Promise<BrowserFlowResult> {
  const state = generateState();
  const verifier = generateCodeVerifier();
  const challenge = deriveChallengeS256(verifier);
  const timeoutMs = deps.loopbackTimeoutMs ?? DEFAULT_LOOPBACK_TIMEOUT_MS;

  const session = await bindLoopbackListener({
    state,
    timeoutMs,
    createServer: deps.createLoopbackServer,
  });
  if (!session) {
    return { kind: 'fallback', reason: 'Could not open a local callback port — falling back to a device code.' };
  }

  try {
    const resource = `${server}/api`;
    const authorizeUrl = buildAuthorizeUrl(server, {
      clientId: CLI_CLIENT_ID,
      redirectUri: session.redirectUri,
      codeChallenge: challenge,
      state,
      resource,
    });

    const openCmd = buildOpenBrowserCommand(deps.platform, authorizeUrl);
    if (!openCmd) {
      return { kind: 'fallback', reason: 'No browser available here — falling back to a device code.' };
    }

    say('Opening your browser to authorize…\n');
    // Bounded wait for the opener subprocess's own exit code. Real openers
    // (`open`/`xdg-open`/`cmd /c start`) return almost instantly — they only
    // launch the browser, they don't wait for it — but `xdg-open` is known
    // to occasionally hang (e.g. on a stuck D-Bus call). Without this race,
    // a hung opener would block forever on `openBrowser`'s promise, NEVER
    // reaching `session.outcome` — meaning the listener's own absolute
    // timeout would fire and close the socket, but the CLI process itself
    // would still hang indefinitely, which defeats the whole point of a
    // bounded listener. If the opener hasn't reported back within the grace
    // window, assume it worked (openers essentially never take this long)
    // and fall through to waiting on the listener, which is itself bounded.
    const openGraceMs = deps.openBrowserGraceMs ?? DEFAULT_OPEN_BROWSER_GRACE_MS;
    const opened = await Promise.race([
      openBrowser(deps.spawn ?? realSpawnBrowser, openCmd.cmd, openCmd.args),
      new Promise<{ ok: true; code: null }>((resolve) => setTimeout(() => resolve({ ok: true, code: null }), openGraceMs)),
    ]);
    if (!opened.ok) {
      return { kind: 'fallback', reason: 'Could not open your browser — falling back to a device code.' };
    }

    const outcome = await session.outcome;
    switch (outcome.kind) {
      case 'code':
        return {
          kind: 'ok',
          token: await exchangeAuthorizationCode(deps, server, {
            code: outcome.code,
            redirectUri: session.redirectUri,
            codeVerifier: verifier,
            resource,
          }),
        };
      case 'oauth_error':
        return {
          kind: 'error',
          error: new CloudError(
            outcome.error === 'access_denied'
              ? 'authorization was declined — nothing was connected'
              : `authorization failed (${outcome.error}${outcome.errorDescription ? `: ${outcome.errorDescription}` : ''})`,
          ),
        };
      case 'state_mismatch':
        return { kind: 'error', error: new CloudError('ignored an unexpected callback — re-run to try again') };
      case 'missing_code':
        return {
          kind: 'error',
          error: new CloudError('the browser callback was missing an authorization code — re-run to try again'),
        };
      case 'timeout':
        return { kind: 'error', error: new CloudError('timed out waiting for browser approval — re-run to try again') };
      case 'listener_error':
        return { kind: 'error', error: new CloudError(`the local callback listener failed — ${outcome.message}`) };
      default: {
        // Exhaustiveness guard: a new CallbackOutcome kind must be handled
        // above explicitly, never fall through silently.
        const _never: never = outcome;
        return { kind: 'error', error: new CloudError(`unexpected callback outcome: ${JSON.stringify(_never)}`) };
      }
    }
  } finally {
    await session.close();
  }
}

/**
 * The 04§4 selection ladder (minus `PIPELINE_MACHINE_TOKEN`, which is task
 * a4's client_credentials path and lives outside `connect`'s auth choice
 * entirely). The user is NEVER asked; every branch either succeeds or falls
 * through to the device flow with a printed reason — except an in-flight
 * browser-flow failure, which is a hard error (see `BrowserFlowResult`).
 */
async function obtainToken(
  deps: CloudDeps,
  server: string,
  opts: ConnectOptions,
  say: (s: string) => void,
): Promise<TokenResponse> {
  const preflight = decidePreflightFallback({
    env: deps.env,
    platform: deps.platform,
    device: opts.device,
    commandExists: deps.commandExists,
  });

  if (!preflight.fallback) {
    const result = await tryBrowserFlow(deps, server, say);
    if (result.kind === 'ok') return result.token;
    if (result.kind === 'error') throw result.error;
    if (result.reason) say(`${result.reason}\n`);
  } else if (preflight.reason) {
    say(`${preflight.reason}\n`);
  }

  return await runDeviceFlow(deps, server, say);
}

async function fetchMe(deps: CloudDeps, server: string, token: string): Promise<MeResponse> {
  const res = await doFetch(deps, `${server}/api/v1/me`, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new CloudError('the credential is no longer valid — re-run with --reauth to sign in again');
  }
  if (res.status !== 200) {
    throw new CloudError(`identity lookup failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as MeResponse;
  if (!body || !Array.isArray(body.orgs)) {
    throw new CloudError('identity response was malformed (no orgs list)');
  }
  return body;
}

/** Pick the org whose slug the binding will record. */
export function selectOrg(
  orgs: MeOrg[],
  orgFlag: string | undefined,
  selectedOrgId: string | null,
): MeOrg | { error: string } {
  if (orgs.length === 0) {
    return {
      error: 'your account has no organizations yet — create one in the web dashboard, then retry',
    };
  }
  if (orgFlag) {
    const match = orgs.find((o) => o.slug === orgFlag);
    if (!match) {
      return {
        error: `no organization with slug '${orgFlag}' (available: ${orgs.map((o) => o.slug).join(', ')})`,
      };
    }
    return match;
  }
  if (selectedOrgId) {
    const sel = orgs.find((o) => o.id === selectedOrgId);
    if (sel) return sel;
  }
  if (orgs.length === 1) return orgs[0]!;
  return {
    error: `you belong to multiple organizations — choose one with --org <slug> (available: ${orgs
      .map((o) => o.slug)
      .join(', ')})`,
  };
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

async function connect(deps: CloudDeps, opts: ConnectOptions): Promise<number> {
  const server = normalizeServerUrl(opts.server ?? deps.env[SERVER_ENV] ?? DEFAULT_SERVER);
  const homeCtx = { platform: deps.platform, env: deps.env, homedir: deps.homedir };
  const credPath = credentialFilePath(homeCtx);
  const store = readCredentialStore(deps.fs, credPath);
  const now = deps.now();

  // Interactive progress/prompts go to stderr in --json mode so stdout stays a
  // single clean JSON object; in human mode they go to stdout as usual.
  const say = (s: string): void => (opts.json ? deps.err(s) : deps.out(s));

  // --- Authenticate: reuse a live stored credential, else run the device flow.
  const existing: StoredCredential | undefined = store.servers[server];
  const reusable =
    existing !== undefined &&
    !opts.reauth &&
    (existing.expires_at === undefined || existing.expires_at > now);

  let token: string;
  if (reusable) {
    token = existing!.access_token;
    say(`Using the stored credential for ${server}.\n`);
  } else {
    const tok = await obtainToken(deps, server, opts, say);
    token = tok.access_token;
    // Persist the SECRET immediately, with restrictive perms, before anything
    // else can fail — so a verified auth is never thrown away.
    store.servers[server] = {
      access_token: tok.access_token,
      token_type: tok.token_type ?? 'bearer',
      token_prefix: tok.token_prefix,
      expires_at: tok.expires_in ? now + tok.expires_in * 1000 : undefined,
    };
    writeCredentialStore(deps.fs, credPath, store);
    say('Authenticated. Credential stored securely (not in this project).\n');
  }

  // --- Resolve the org slug from the identity endpoint (the only source).
  const me = await fetchMe(deps, server, token);
  const org = selectOrg(me.orgs, opts.org, me.selectedOrgId);
  if ('error' in org) throw new CloudError(org.error);

  // Enrich the stored credential with non-secret display fields (best-effort).
  const cred = store.servers[server];
  if (cred) {
    cred.org_slug = org.slug;
    if (me.user?.email) cred.user_email = me.user.email;
    writeCredentialStore(deps.fs, credPath, store);
  }

  // --- Determine the project slug (explicit flag, else the cwd's name).
  const project = opts.project && opts.project.length > 0 ? slugify(opts.project) : defaultProjectSlug(deps.cwd);
  if (!project) {
    throw new CloudError('could not derive a project slug from the directory — pass --project <slug>');
  }

  // --- Write the NON-SECRET binding (idempotent — updates an existing one).
  const cloudPath = cloudJsonPath(deps.cwd);
  const previous: CloudBinding | null = readCloudBinding(deps.fs, cloudPath);
  const binding: CloudBinding = {
    server,
    org: org.slug,
    project,
    connected_at: new Date(now).toISOString(),
  };
  writeCloudBinding(deps.fs, cloudPath, binding);

  const action = previous ? 'updated' : 'connected';
  if (opts.json) {
    deps.out(
      JSON.stringify({
        status: action,
        server,
        org: org.slug,
        project,
        cloud_json: cloudPath,
        credential_store: credPath,
      }) + '\n',
    );
  } else {
    if (previous) {
      deps.out(`Already connected — updating the binding for this project.\n`);
    }
    deps.out(`Connected: org '${org.slug}', project '${project}' on ${server}.\n`);
    deps.out(`  Binding (no secrets):  ${cloudPath}\n`);
    deps.out(`  Credential (secure):   ${credPath}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CLI shell
// ---------------------------------------------------------------------------

export async function runCloud(args: string[], deps: CloudDeps = realDeps): Promise<number> {
  const sub = args[0];
  if (sub === undefined) {
    deps.err(USAGE);
    return 2;
  }
  if (sub === '--help' || sub === '-h') {
    deps.out(USAGE);
    return 0;
  }
  if (sub !== 'connect') {
    deps.err(`pipeline cloud: unknown subcommand '${sub}'\n${USAGE}`);
    return 2;
  }

  const parsed = parseConnectArgs(args.slice(1));
  if ('error' in parsed) {
    deps.err(`pipeline cloud connect: ${parsed.error}\n${USAGE}`);
    return 2;
  }

  try {
    return await connect(deps, parsed);
  } catch (e) {
    if (e instanceof CloudError) {
      deps.err(`pipeline cloud connect: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
