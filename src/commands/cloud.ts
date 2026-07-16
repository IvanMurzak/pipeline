// `pipeline cloud connect [--server <url>] [--project <slug>] [--org <slug>]
//                         [--reauth] [--json]`
//
// Link the current project to the cloud control plane. Runs the OAuth-style
// device flow (RFC 8628-shaped) against the control-plane API, stores the
// obtained session token in the SECURE per-user credential store, then records
// a NON-SECRET project↔cloud binding in `<cwd>/.claude/pipeline/cloud.json`.
//
// Server contract (apps/api/src/modules/auth/routes.ts, read-only source of truth):
//   POST /auth/device/start  → 200 { device_code, user_code, verification_uri,
//                                     verification_uri_complete, expires_in, interval }
//   POST /auth/device/token  { device_code } →
//        200 { access_token, token_type, expires_in, token_prefix }  (approved)
//        400 { error: "authorization_pending" }  → keep polling
//        400 { error: "slow_down" }              → widen the interval, keep polling
//        400 { error: "access_denied" }          → user denied — abort
//        400 { error: "expired_token" }          → code expired — abort
//   GET  /api/v1/me  (Authorization: Bearer <PAT>) →
//        { user, orgs:[{id,slug,name,role}], selectedOrgId, selectedRole }
//        — the ONLY source of the org slug (the token exchange carries none).
//
// Security invariants:
//   - cloud.json holds ONLY slugs/URLs — the token NEVER touches the project.
//   - the token is written to the per-user store with 0600 perms and is NEVER
//     printed to stdout/stderr (only its non-secret prefix, if shown at all).
//
// Exit: 0 connected/updated · 1 auth/network/identity failure · 2 usage.
//
// Every side effect (HTTP, filesystem, clock, sleep, env, home dir, cwd) is
// injected via CloudDeps so tests drive the whole flow with zero real I/O.

import { homedir } from 'node:os';
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

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const USAGE =
  'Usage: pipeline cloud connect [--server <url>] [--project <slug>] [--org <slug>]\n' +
  '                              [--reauth] [--json]\n' +
  '  Authenticate via device flow and bind this project to the cloud control plane.\n' +
  '  Writes non-secret slugs to .claude/pipeline/cloud.json; the credential is\n' +
  '  stored separately in a secure per-user location (never in the project).\n';

export interface ConnectOptions {
  server?: string;
  project?: string;
  org?: string;
  reauth: boolean;
  json: boolean;
}

export function parseConnectArgs(args: string[]): ConnectOptions | { error: string } {
  const out: ConnectOptions = { reauth: false, json: false };
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
    const start = await deviceStart(deps, server);
    say('To authorize this device, open:\n');
    say(`  ${start.verification_uri_complete ?? start.verification_uri}\n`);
    say(`and enter the code:  ${start.user_code}\n`);
    say('Waiting for you to approve in the browser…\n');
    const tok = await pollForToken(deps, server, start);
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
