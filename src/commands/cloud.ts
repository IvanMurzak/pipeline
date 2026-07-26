// `pipeline cloud connect [--server <url>] [--project <slug>] [--org <slug>]
//                         [--reauth] [--device] [--json]`
//
// Link the current project to the cloud control plane. The user is NEVER
// asked which authentication method to use (simplified-onboarding
// `04-cloud-auth.md` §4's selection ladder decides): a browser
// authorization_code + PKCE flow with a loopback redirect (RFC 8252) is the
// default, and it silently falls back to the authorization server's RFC 8628
// Device Authorization Grant — printing a one-line reason — when no browser
// is reachable, the loopback port can't be bound, `SSH_CONNECTION` is set
// with no X forwarding, the browser opener exits non-zero, or `--device` was
// passed explicitly. Either way the obtained token lands in the SECURE
// per-user credential store, then a NON-SECRET project↔cloud binding is
// recorded in `<cwd>/.claude/pipeline/cloud.json`.
//
// Server contract (read-only source of truth):
//   Device flow — apps/api/src/modules/mesh-oauth/routes.ts (task a3 — the
//   AS's RFC 8628 grant; this file used to call a legacy PAT-issuing device
//   flow instead, see "Legacy device flow" below):
//     POST /oauth/device_authorization  (form-urlencoded)
//          client_id=ai-pipeline-cli&resource=<server>/api →
//          200 { device_code, user_code, verification_uri,
//                verification_uri_complete, expires_in, interval }
//          — NO `scope`: the `api` audience carries none by design (same
//          rule the browser flow's token exchange obeys, below).
//     POST /oauth/token  (form-urlencoded)
//          grant_type=urn:ietf:params:oauth:grant-type:device_code&
//          device_code=&client_id=ai-pipeline-cli →
//          200 { access_token, token_type, expires_in, refresh_token, scope }
//               (approved — REFRESHABLE, unlike the legacy PAT this
//               replaces; persisted below in the credential store for a5's
//               rotation to use)
//          400 { error: "authorization_pending" }  → keep polling
//          400 { error: "slow_down" }              → widen the interval, keep polling
//          400 { error: "access_denied" }          → user denied — abort
//          400 { error: "expired_token" }          → code expired, or the
//                                                      code was already
//                                                      redeemed — abort
//   Legacy device flow — apps/api/src/modules/auth/routes.ts — STILL SERVED,
//   unchanged, so a CLI published before this migration keeps working:
//   `POST /auth/device/start` + `POST /auth/device/token`, minting a
//   non-refreshable PAT. This file no longer calls it (see git history for
//   the prior implementation); `tests/cloud.test.ts`'s "legacy device flow
//   (server-side regression)" suite pins the exact wire contract so a
//   silent server-side drift is still caught even though nothing HERE
//   exercises it at runtime.
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
//        *token itself* is separate and happens server-side at consent — and
//        the device grant's token is deliberately NOT org-bound at all,
//        matching the legacy PAT's shape; see mesh-oauth/routes.ts's
//        `handleDeviceCodeGrant`).
//   Machine credential — apps/api/src/modules/mesh-oauth/routes.ts's
//   `issueMachineCredentialToken` (task a4, depends on the server-side c7
//   machine-credentials module — read there, not guessed, on 2026-07-26):
//     POST /oauth/token  (form-urlencoded, HTTP Basic client auth — mirrors
//          pipeline-runner's core/mesh-oauth.ts, the sibling repo's OWN
//          client_credentials caller)
//          Authorization: Basic base64(<client-id>:<secret>)  — split from
//          the `aip_m_<client-id>.<secret>` string carried in
//          PIPELINE_MACHINE_TOKEN / --machine-token (splitMachineCredential
//          below mirrors machine-credentials/service.ts's
//          `splitMachineCredentialToken` byte-for-byte; this package cannot
//          import the private cloud/ tree, same constraint as
//          lib/mesh-notify.ts's duplicated task-state vocabulary)
//          grant_type=client_credentials&scope=machine:credential&
//          resource=<server>/api  — the resource check runs BEFORE the
//          secret is even looked up server-side (routes.ts's own doc
//          comment), so only this exact scope+resource pair is ever sent.
//          200 { access_token, token_type, expires_in, scope } — NO
//               refresh_token (RFC 6749 §4.4.3 / OAuth 2.1 §4.2 forbid one
//               for client_credentials); this branch never tries to persist
//               one even if a server response ever included it.
//          401 { error: "invalid_client", error_description: "That machine
//               token was rejected (expired or revoked). Issue a new one at
//               <appOrigin>/settings/machine-credentials." } — EVERY reject
//               reason (unknown secret, client_id/secret mismatch, revoked,
//               expired) collapses to this ONE string server-side
//               (issueMachineCredentialToken's own doc: "no oracle for a
//               caller to learn WHICH of those it was") — this file relays
//               it verbatim rather than inventing a distinction the server
//               deliberately refuses to make.
//   GAP FOUND READING THE SERVER (not in the design doc's illustrative
//   transcript): a machine-credential token has no human identity behind
//   it — auth/middleware.ts's `resolveMachineCredentialBearer` sets
//   `userId: <machine_credentials row id>`, and `GET /api/v1/me`
//   (auth/routes.ts) does `store.getUserById(auth.userId)`, which looks the
//   id up in the `users` table and finds nothing — a machine credential's
//   row lives in a DIFFERENT table and is never a `users.id`. So `/me` 401s
//   for this token class BY CONSTRUCTION, and there is no server endpoint
//   that maps a machine credential to an org SLUG (only the opaque org_id
//   UUID rides in the token's own claims, and only client_id/secret —
//   never `org` — is sent to /oauth/token, so there is also no server-side
//   "wrong org" oracle to distinguish from "wrong credential"). This branch
//   therefore never calls /api/v1/me: org resolution for a machine-credential
//   connect is `--org <slug>`, supplied by the operator who minted the
//   credential from that org's dashboard, not auto-discovered. See
//   `connectWithMachineCredential` below and the PR description for the
//   full reasoning.
//
// Security invariants:
//   - cloud.json holds ONLY slugs/URLs — neither the access token nor the
//     refresh token ever touches the project.
//   - the access token AND the refresh token are written to the per-user
//     store with 0600 perms and are NEVER printed to stdout/stderr (only the
//     access token's non-secret prefix, if the server ever supplies one).
//   - the loopback listener binds the IP LITERAL only (127.0.0.1 / [::1]),
//     never `localhost` (RFC 8252 §7.3); PKCE `S256` + `state` are both
//     mandatory and both drawn from a CSPRNG (see lib/loopback-oauth.ts); the
//     listener verifies `state` before anything else, rejects any path other
//     than `/callback`, enforces a short absolute timeout, and is closed on
//     EVERY exit path (success, wrong state, timeout, or an aborted attempt)
//     — simplified-onboarding `07-approval-policy.md` §8.
//   - a machine credential (PIPELINE_MACHINE_TOKEN / --machine-token, task
//     a4) authenticates the REST `api` audience ONLY and is NEVER attached
//     to a request targeting `/mcp` — `assertNotMcpUrl` below is a throwing
//     guard on every request that carries machine-credential material (the
//     raw secret at exchange time; there is no later bearer-reuse call site
//     today, but the guard exists so a future refactor cannot add one
//     silently). MCP authorization spec MUST: "servers MUST only accept
//     tokens that are valid for use with their own resources"; a
//     department's /mcp credential is always the per-execution token of
//     department-mesh 13-mcp-authorization.md §12, never this credential.
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
  /** Legacy-flow-only: the OLD `/auth/device/token` response carries a
   *  display prefix for the PAT it mints. Neither the RFC 8628 device grant
   *  nor the browser flow's token endpoint returns one (undefined on both,
   *  as of a3). */
  token_prefix?: string;
  /** Both the browser flow (a2) and the RFC 8628 device grant (a3) return
   *  one; `connect()` below persists it in the credential store for either
   *  path. a5 owns ROTATING it (single-flight refresh with family-reuse
   *  detection) — this task only makes sure it is never discarded. */
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

// ---------------------------------------------------------------------------
// Machine credential (task a4) — 04-cloud-auth.md §3/§4, D12
// ---------------------------------------------------------------------------

/** The documented form (04§3: "PIPELINE_MACHINE_TOKEN is the documented
 *  form"). `--machine-token` also works (see `parseConnectArgs`) but is
 *  deliberately not advertised as the recommended path — argv is
 *  world-readable in `ps` on Linux, the same posture
 *  `PIPELINE_RUNNER_OAUTH_CLIENT_SECRET` already takes in the sibling
 *  pipeline-runner repo's `cli.ts`. */
export const MACHINE_TOKEN_ENV = 'PIPELINE_MACHINE_TOKEN';

/** "aip_m_" — mirrors `machine-credentials/service.ts#MACHINE_CREDENTIAL_PREFIX`
 *  byte-for-byte. Deliberately not `pk_live_` (Stripe's *publishable*,
 *  non-secret key shape) — this prefix marks a SECRET. */
export const MACHINE_CREDENTIAL_PREFIX = 'aip_m_';

/** The one scope `04-cloud-auth.md` §3's machine-credential exchange ever
 *  requests (mesh-oauth/routes.ts's `MACHINE_CREDENTIAL_SCOPE`). */
const MACHINE_CREDENTIAL_SCOPE = 'machine:credential';

/**
 * Split a presented `aip_m_<client-id>.<secret>` string into its OAuth
 * `client_id` (everything up to the first `.`, INCLUDING the `aip_m_`
 * prefix — the prefix is part of the opaque client_id, not stripped from
 * it) and `secret` halves. Mirrors
 * `machine-credentials/service.ts#splitMachineCredentialToken` exactly —
 * never throws, so a malformed value is always a clean, locally-detected
 * rejection rather than a server round trip. Exported for direct testing
 * (DoD box 2's "malformed" case, which has no server oracle to test
 * against).
 */
export function splitMachineCredential(raw: string): { clientId: string; secret: string } | null {
  if (!raw.startsWith(MACHINE_CREDENTIAL_PREFIX)) return null;
  const dot = raw.indexOf('.');
  if (dot === -1) return null;
  const clientId = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (clientId.length <= MACHINE_CREDENTIAL_PREFIX.length || secret.length === 0) return null;
  return { clientId, secret };
}

/**
 * Defense-in-depth for 04-cloud-auth.md §3's MCP MUST ("a machine credential
 * … is never presented at /mcp … a department's /mcp credential is always
 * the per-execution token"). Every request that carries machine-credential
 * material MUST pass its target URL through this first — it throws rather
 * than silently sending the credential, so a future refactor that threads a
 * machine-credential-derived value into some OTHER call cannot leak it to
 * the `/mcp` resource by accident. `tests/cloud.test.ts`'s "never at /mcp"
 * suite (DoD box 4) asserts this directly, independent of any specific
 * call site.
 */
export function assertNotMcpUrl(url: string): void {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not a parseable absolute URL — fail closed rather than let an
    // unparseable target slip past the check.
    throw new CloudError(`refusing to use a machine credential against an unparseable URL: ${url}`);
  }
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
    throw new CloudError(`refusing to send a machine credential to an /mcp URL: ${url}`);
  }
}

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
  '                              [--machine-token <token>]\n' +
  '  Authenticate and bind this project to the cloud control plane. Opens a\n' +
  '  browser by default (one approval, no typed code); falls back to a device\n' +
  '  code when no browser is reachable, or always with --device.\n' +
  `  ${MACHINE_TOKEN_ENV}=<aip_m_…> is the documented no-human path (bots, CI,\n` +
  '  agents): it suppresses every prompt and browser attempt — no TTY needed.\n' +
  '  --machine-token works the same way but keeps the secret out of argv by\n' +
  `  preferring ${MACHINE_TOKEN_ENV}. Combining either with --device is a usage error.\n` +
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
  /** The `aip_m_<client-id>.<secret>` machine credential (task a4). Argv is
   *  world-readable in `ps` on Linux — `PIPELINE_MACHINE_TOKEN` is the
   *  documented form; this flag exists and works but is never the
   *  recommended path (see USAGE / MACHINE_TOKEN_ENV's doc comment). */
  machineToken?: string;
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
    } else if (a === '--machine-token' || a.startsWith('--machine-token=')) {
      if (a.startsWith('--machine-token=')) out.machineToken = a.slice('--machine-token='.length);
      else {
        const v = takeValue('--machine-token', i++);
        if (typeof v !== 'string') return v;
        out.machineToken = v;
      }
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

/** Form-urlencoded — every RFC 6749/RFC 8628 endpoint on the AS
 *  (`/oauth/device_authorization`, `/oauth/token`) reads `c.req.parseBody()`,
 *  never JSON (mesh-oauth/routes.ts's `readFormBody`). */
const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
/** RFC 8628 §3.4's registered grant-type URN for the device access token request. */
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Best-effort parse of an error body's `error` code (tolerant of non-JSON). */
async function errorCode(res: HttpResponse): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort parse of an error body's `error_description` (RFC 6749 §5.2).
 *  Used ONLY by the machine-credential exchange below: mesh-oauth/routes.ts's
 *  `issueMachineCredentialToken` puts the ENTIRE user-facing message here
 *  (04-cloud-auth.md §9's exact wording, reissue URL included) — every
 *  reject reason collapses to this one string server-side, so relaying it
 *  verbatim is correct, not a shortcut. */
async function errorDescription(res: HttpResponse): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error_description?: unknown };
    return typeof body.error_description === 'string' ? body.error_description : undefined;
  } catch {
    return undefined;
  }
}

/**
 * RFC 8628 §3.1 device authorization request, against the AS's real grant
 * (mesh-oauth/routes.ts's `POST /oauth/device_authorization`) — task a3's
 * migration off the legacy PAT-issuing `/auth/device/start` this function
 * used to call (see git history / the module doc's "Legacy device flow"
 * note). `resource` names the SAME `<issuer>/api` REST audience the browser
 * flow requests (`tryBrowserFlow`, below) — deliberately NO `scope`: the
 * `api` audience carries none by design (mesh-oauth/resource.ts's
 * `scopesAllowedForResource("api")` is `[]`; the AS refuses any non-empty
 * scope request against it, mirroring the browser flow's own token exchange).
 */
async function deviceStart(deps: CloudDeps, server: string): Promise<DeviceStartResponse> {
  const body = new URLSearchParams({
    client_id: CLI_CLIENT_ID,
    resource: `${server}/api`,
  }).toString();
  const res = await doFetch(deps, `${server}/oauth/device_authorization`, {
    method: 'POST',
    headers: FORM_HEADERS,
    body,
  });
  if (res.status !== 200) {
    const code = await errorCode(res);
    throw new CloudError(
      `device authorization request failed (HTTP ${res.status}${code ? `: ${code}` : ''})`,
    );
  }
  const parsed = (await res.json()) as DeviceStartResponse;
  if (!parsed || !parsed.device_code || !parsed.user_code || !parsed.verification_uri) {
    throw new CloudError('device authorization response was missing required fields');
  }
  return parsed;
}

/**
 * Poll the token endpoint until the user approves (200) or the flow ends
 * (denied/expired/deadline). Respects the server-provided poll `interval` and
 * `expires_in`, widening the interval on `slow_down`. Bounded — never loops
 * past the expiry deadline.
 *
 * RE-POINTED, NOT REWRITTEN (task a3): the request now targets the AS's real
 * `POST /oauth/token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`,
 * form-urlencoded, per RFC 8628 §3.4) instead of the legacy
 * `/auth/device/token`'s JSON body — but the timing/retry state machine
 * below (the deadline check, the sleep-then-poll order, the interval
 * widening, which error codes continue vs. abort) is untouched: it was
 * already RFC 8628 §3.5 conformant before this task, and the new endpoint's
 * error vocabulary (`authorization_pending`/`slow_down`/`access_denied`/
 * `expired_token`) is byte-identical to the legacy one's, so the `switch`
 * below needed no logic changes — only a `say()` call added to the
 * `slow_down` arm so that state has a stated, testable message too (04-05
 * DoD).
 */
async function pollForToken(
  deps: CloudDeps,
  server: string,
  start: DeviceStartResponse,
  say: (s: string) => void,
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

    const res = await doFetch(deps, `${server}/oauth/token`, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: start.device_code,
        client_id: CLI_CLIENT_ID,
      }).toString(),
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
        say('The server asked us to slow down — waiting a bit longer between checks.\n');
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

/** The RFC 8628 device flow's user-facing steps (the browser flow's
 *  fallback path, or `--device`'s direct target). Prefers
 *  `verification_uri_complete` (RFC 8628 §3.3.1) when the server supplies
 *  one — turning approval from a phone into a scan rather than a
 *  transcription — falling back to the bare `verification_uri` + typed code
 *  otherwise. */
async function runDeviceFlow(deps: CloudDeps, server: string, say: (s: string) => void): Promise<TokenResponse> {
  const start = await deviceStart(deps, server);
  say('To authorize this device, open:\n');
  say(`  ${start.verification_uri_complete ?? start.verification_uri}\n`);
  say(`and enter the code:  ${start.user_code}\n`);
  say('Waiting for you to approve in the browser…\n');
  return await pollForToken(deps, server, start, say);
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

// ---------------------------------------------------------------------------
// Machine credential exchange (task a4) — 04-cloud-auth.md §3/§4's THIRD
// rung of the selection ladder, checked before any of the browser/device
// logic below ever runs (see `connect()`).
// ---------------------------------------------------------------------------

/**
 * `POST /oauth/token` (grant_type=client_credentials, scope=machine:credential,
 * resource=<server>/api) — the machine-credential exchange
 * (mesh-oauth/routes.ts's `issueMachineCredentialToken`, read directly, see
 * this file's module doc). HTTP Basic client auth with the split
 * `client_id`/`secret` halves, mirroring `parseBasicAuth` server-side and the
 * sibling pipeline-runner repo's own `core/mesh-oauth.ts#basicAuthHeader`
 * convention for every other `client_credentials` caller in this product.
 *
 * `assertNotMcpUrl` runs before the request is built, on both URLs this
 * function ever touches — defense in depth (DoD box 4): even though
 * `resource`/the token endpoint are hardcoded constants today, a future edit
 * that parameterized either could not silently start sending this
 * credential's secret to `/mcp` without this guard firing first.
 */
async function exchangeMachineCredential(
  deps: CloudDeps,
  server: string,
  rawToken: string,
): Promise<TokenResponse> {
  const split = splitMachineCredential(rawToken);
  if (!split) {
    throw new CloudError(
      `the machine token is not in the expected ${MACHINE_CREDENTIAL_PREFIX}<client-id>.<secret> shape ` +
        `— check ${MACHINE_TOKEN_ENV} (or --machine-token)`,
    );
  }

  const tokenUrl = `${server}/oauth/token`;
  const resource = `${server}/api`;
  assertNotMcpUrl(tokenUrl);
  assertNotMcpUrl(resource);

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: MACHINE_CREDENTIAL_SCOPE,
    resource,
  }).toString();
  const basic = `Basic ${Buffer.from(`${split.clientId}:${split.secret}`, 'utf8').toString('base64')}`;
  const res = await doFetch(deps, tokenUrl, {
    method: 'POST',
    headers: { ...FORM_HEADERS, authorization: basic },
    body,
  });
  if (res.status !== 200) {
    // 04§9's "Machine token rejected" wording, relayed verbatim from the
    // server's error_description when present (it always is for
    // invalid_client — see issueMachineCredentialToken's doc). Falling back
    // to a generic message only covers a response the server itself never
    // actually sends today (e.g. a network intermediary mangling the body).
    const description = await errorDescription(res);
    if (description) throw new CloudError(description);
    const code = await errorCode(res);
    throw new CloudError(`machine credential was rejected (HTTP ${res.status}${code ? `: ${code}` : ''})`);
  }
  const parsed = (await res.json()) as TokenResponse;
  if (!parsed || !parsed.access_token) {
    throw new CloudError('machine credential token response was missing access_token');
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

/**
 * The tail shared by every auth path once a credential is in hand and an org
 * slug is known: derive the project slug, write the non-secret binding
 * (idempotent), and print/emit the result. Factored out so the
 * machine-credential branch (which never runs `fetchMe`/`selectOrg` — see
 * `connectWithMachineCredential`'s doc) does not duplicate it.
 */
function writeBindingAndReport(
  deps: CloudDeps,
  opts: ConnectOptions,
  server: string,
  credPath: string,
  orgSlug: string,
  now: number,
): number {
  const project = opts.project && opts.project.length > 0 ? slugify(opts.project) : defaultProjectSlug(deps.cwd);
  if (!project) {
    throw new CloudError('could not derive a project slug from the directory — pass --project <slug>');
  }

  const cloudPath = cloudJsonPath(deps.cwd);
  const previous: CloudBinding | null = readCloudBinding(deps.fs, cloudPath);
  const binding: CloudBinding = {
    server,
    org: orgSlug,
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
        org: orgSlug,
        project,
        cloud_json: cloudPath,
        credential_store: credPath,
      }) + '\n',
    );
  } else {
    if (previous) {
      deps.out(`Already connected — updating the binding for this project.\n`);
    }
    deps.out(`Connected: org '${orgSlug}', project '${project}' on ${server}.\n`);
    deps.out(`  Binding (no secrets):  ${cloudPath}\n`);
    deps.out(`  Credential (secure):   ${credPath}\n`);
  }
  return 0;
}

/**
 * The machine-credential branch of the connect flow (task a4,
 * 04-cloud-auth.md §3/§4's THIRD, top rung — checked in `connect()` before
 * ANY of the reuse/browser/device logic below it runs). No TTY, no prompt,
 * no browser: `exchangeMachineCredential` is the only network call before
 * the binding is written, besides the credential-store write itself.
 *
 * Deliberately does NOT call `fetchMe`/`selectOrg` — see this file's module
 * doc "GAP FOUND READING THE SERVER": a machine credential has no human
 * identity, so `/api/v1/me` 401s for it by construction, and the server
 * gives the CLI no other way to map the credential to an org SLUG (only an
 * opaque org_id UUID rides in the token's claims). `--org <slug>` is
 * therefore how the operator — who minted the credential from that org's
 * dashboard — tells the CLI what to write locally; it is not verified
 * against the server (there is nothing to verify it against).
 */
async function connectWithMachineCredential(
  deps: CloudDeps,
  opts: ConnectOptions,
  server: string,
  machineToken: string,
): Promise<number> {
  const homeCtx = { platform: deps.platform, env: deps.env, homedir: deps.homedir };
  const credPath = credentialFilePath(homeCtx);
  const store = readCredentialStore(deps.fs, credPath);
  const now = deps.now();
  const say = (s: string): void => (opts.json ? deps.err(s) : deps.out(s));

  const tok = await exchangeMachineCredential(deps, server, machineToken);

  // Persist the secret immediately, before anything else (e.g. a missing
  // --org) can fail — same "a verified auth is never thrown away" posture
  // as the human paths below. RFC 6749 §4.4.3 / OAuth 2.1 §4.2: NO refresh
  // token accompanies client_credentials — `tok.refresh_token` is never read
  // here, even if a response somehow carried one; on the next expiry this
  // branch just re-exchanges PIPELINE_MACHINE_TOKEN itself, exactly like the
  // runner's own `client_credentials` client (pipeline-runner's
  // execution-token-manager.ts) always does.
  store.servers[server] = {
    access_token: tok.access_token,
    token_type: tok.token_type ?? 'bearer',
    expires_at: tok.expires_in ? now + tok.expires_in * 1000 : undefined,
  };
  writeCredentialStore(deps.fs, credPath, store);
  say('Authenticated with a machine credential. Credential stored securely (not in this project).\n');

  if (!opts.org) {
    throw new CloudError(
      'a machine credential has no discoverable organization — pass --org <slug> (the org it was issued for)',
    );
  }
  const orgSlug = opts.org;

  const cred = store.servers[server];
  if (cred) {
    cred.org_slug = orgSlug;
    writeCredentialStore(deps.fs, credPath, store);
  }

  return writeBindingAndReport(deps, opts, server, credPath, orgSlug, now);
}

async function connect(deps: CloudDeps, opts: ConnectOptions, machineToken: string | undefined): Promise<number> {
  const server = normalizeServerUrl(opts.server ?? deps.env[SERVER_ENV] ?? DEFAULT_SERVER);

  // 04§4's selection ladder, THIRD and topmost rung: a machine credential's
  // presence wins over everything below — no reused human credential, no
  // browser, no device code (`runCloud` has already rejected combining it
  // with --device as a usage error before `connect` is ever reached).
  if (machineToken !== undefined) {
    return await connectWithMachineCredential(deps, opts, server, machineToken);
  }

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
    // Persist the SECRET(s) immediately, with restrictive perms, before
    // anything else can fail — so a verified auth is never thrown away.
    // `refresh_token` is present on BOTH the browser flow (a2) and the RFC
    // 8628 device grant (a3) as of this task — a5 depends on it being here
    // to rotate, so it must never be dropped on the floor.
    store.servers[server] = {
      access_token: tok.access_token,
      token_type: tok.token_type ?? 'bearer',
      token_prefix: tok.token_prefix,
      refresh_token: tok.refresh_token,
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

  return writeBindingAndReport(deps, opts, server, credPath, org.slug, now);
}

// ---------------------------------------------------------------------------
// CLI shell
// ---------------------------------------------------------------------------

/** The machine credential, from whichever source named it — the flag first
 *  (an explicit, deliberate choice), else the documented env var. Blank
 *  values (env set but empty) are treated as absent. */
function resolveMachineToken(opts: ConnectOptions, env: Record<string, string | undefined>): string | undefined {
  const fromFlag = opts.machineToken?.trim();
  if (fromFlag) return fromFlag;
  const fromEnv = env[MACHINE_TOKEN_ENV]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

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

  // 04§3: "Ambiguity is an error, not a guess: combining it with --device
  // exits 2." Checked here — before any I/O — so it is a clean usage error
  // regardless of whether the machine token came from the flag or the env
  // var (DoD box 3 names the flag; the design's own rule names either).
  const machineToken = resolveMachineToken(parsed, deps.env);
  if (machineToken !== undefined && parsed.device) {
    deps.err(
      `pipeline cloud connect: --machine-token (or ${MACHINE_TOKEN_ENV}) cannot be combined with --device\n${USAGE}`,
    );
    return 2;
  }

  try {
    return await connect(deps, parsed, machineToken);
  } catch (e) {
    if (e instanceof CloudError) {
      deps.err(`pipeline cloud connect: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
