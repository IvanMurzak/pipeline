// cloud-optout.test.ts — `pipeline cloud optout` (task j2, OPTOUT-1 CLI half).
//
// Every test injects a scripted fetch that throws on any URL it does not
// explicitly script — the same "unexpected fetch" posture cloud.test.ts's
// own `machineScriptedFetch` uses — so a regression that accidentally routes
// this command through the interactive ladder (`/oauth/device_authorization`,
// `/oauth/authorize`) fails loudly here instead of silently opening a
// browser. No test sets `spawn`/`createLoopbackServer`/`commandExists` at
// all: if `resolveSilentApiAuth` ever reached `tryBrowserFlow`/
// `runDeviceFlow`, those calls would throw on the missing seam rather than
// quietly doing nothing.

import { test, expect, afterEach, describe } from 'bun:test';
import {
  runCloud,
  runCloudOptout,
  parseOptOutArgs,
  MACHINE_TOKEN_ENV,
  type CloudDeps,
  type HttpResponse,
  type HttpInit,
} from '../src/commands/cloud';
import {
  realFs,
  credentialFilePath,
  writeCredentialStore,
  type HomeContext,
  type StoredCredential,
} from '../src/lib/cloud-config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER = 'https://api.ai-pipeline.dev';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness — mirrors cloud.test.ts's own `recordingFs`/`makeDeps`/`reply`
// shapes exactly, trimmed to what this file needs.
// ---------------------------------------------------------------------------

function reply(status: number, body: unknown): HttpResponse {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

interface FetchLog {
  url: string;
  init: HttpInit;
}

function mkHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'pipeline-cloud-optout-home-'));
  created.push(d);
  return d;
}

/** Seed a stored credential for `SERVER`, exactly like
 *  credential-refresh.test.ts's own `seed` helper. */
function seedCredential(home: string, fields: Partial<StoredCredential> & { access_token: string }): void {
  const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
  const path = credentialFilePath(ctx);
  writeCredentialStore(realFs, path, { version: 1, servers: { [SERVER]: { token_type: 'bearer', ...fields } } });
}

function makeDeps(
  home: string,
  fetchImpl: CloudDeps['fetch'],
  envOverride: Record<string, string | undefined> = {},
): { deps: CloudDeps; out: () => string; err: () => string } {
  let outBuf = '';
  let errBuf = '';
  const deps: CloudDeps = {
    fetch: fetchImpl,
    fs: realFs,
    now: () => 2_000_000,
    sleep: async () => {
      throw new Error('must not sleep — the silent ladder never polls or waits');
    },
    env: { PIPELINE_CLOUD_HOME: home, ...envOverride },
    platform: 'linux',
    homedir: home,
    cwd: home,
    out: (s) => {
      outBuf += s;
    },
    err: (s) => {
      errBuf += s;
    },
  };
  return { deps, out: () => outBuf, err: () => errBuf };
}

/** Scripts `/api/v1/me` and the opt-out endpoint (both verbs) for the human
 *  rung. Any other URL throws — see this file's header comment. */
function humanScriptedFetch(opts: {
  log: FetchLog[];
  orgs?: Array<{ id: string; slug: string; name: string; role: string }>;
  selectedOrgId?: string | null;
  meStatus?: number;
  optOutGetStatus?: number;
  optOutGetBody?: unknown;
  optOutPutStatus?: number;
  optOutPutBody?: unknown;
}) {
  const orgs = opts.orgs ?? [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'owner' }];
  return async (url: string, init: HttpInit): Promise<HttpResponse> => {
    opts.log.push({ url, init });
    if (url.endsWith('/api/v1/me')) {
      if (opts.meStatus && opts.meStatus !== 200) return reply(opts.meStatus, { error: 'nope' });
      return reply(200, { user: { id: 'u1', email: 'dev@example.com' }, orgs, selectedOrgId: opts.selectedOrgId ?? null });
    }
    if (url.endsWith('/api/v1/fleet-telemetry/optout')) {
      if (init.method === 'GET') {
        return reply(opts.optOutGetStatus ?? 200, opts.optOutGetBody ?? { optedOut: false, optedOutAt: null });
      }
      if (init.method === 'PUT') {
        return reply(opts.optOutPutStatus ?? 200, opts.optOutPutBody ?? { optedOut: true, optedOutAt: '2026-08-05T12:00:00.000Z' });
      }
    }
    throw new Error(`unexpected fetch to ${url} (${init.method})`);
  };
}

// ---------------------------------------------------------------------------
// parseOptOutArgs
// ---------------------------------------------------------------------------

describe('parseOptOutArgs', () => {
  test('bare form: read only', () => {
    expect(parseOptOutArgs([])).toEqual({ json: false, help: false });
  });
  test('--set (space + equals forms)', () => {
    expect(parseOptOutArgs(['--set', 'true'])).toEqual({ json: false, help: false, setRaw: 'true' });
    expect(parseOptOutArgs(['--set=false'])).toEqual({ json: false, help: false, setRaw: 'false' });
  });
  test('--org / --server / --machine-token / --json all parse', () => {
    expect(
      parseOptOutArgs(['--org', 'acme', '--server', 'https://x', '--machine-token', 'tok', '--json']),
    ).toEqual({ json: true, help: false, org: 'acme', server: 'https://x', machineToken: 'tok' });
  });
  test('unknown flag is captured, not thrown', () => {
    expect(parseOptOutArgs(['--bogus']).unknownFlag).toBe('--bogus');
  });
  test('a stray positional is captured as extra', () => {
    expect(parseOptOutArgs(['nope']).extra).toBe('nope');
  });
});

// ---------------------------------------------------------------------------
// The unauthenticated path — DoD: "a clear, actionable message"
// ---------------------------------------------------------------------------

describe('runCloudOptout — unauthenticated', () => {
  test('nothing stored at all: exit 1, names `pipeline cloud connect`, touches the network zero times', async () => {
    const home = mkHome();
    const log: FetchLog[] = [];
    const fetchImpl = async (url: string, init: HttpInit): Promise<HttpResponse> => {
      log.push({ url, init });
      throw new Error(`must not be called — nothing is stored, this must fail before any network call: ${url}`);
    };
    const { deps, err, out } = makeDeps(home, fetchImpl);

    const code = await runCloudOptout([], deps);
    expect(code).toBe(1);
    expect(err()).toContain('pipeline cloud optout:');
    expect(err()).toContain('run `pipeline cloud connect`');
    expect(out()).toBe('');
    expect(log.length).toBe(0);
  });

  test('same refusal under --json — same message on stderr, nothing on stdout, no browser/device-flow call', async () => {
    const home = mkHome();
    const fetchImpl = async (url: string): Promise<HttpResponse> => {
      throw new Error(`must not be called: ${url}`);
    };
    const { deps, err, out } = makeDeps(home, fetchImpl);

    const code = await runCloudOptout(['--json'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('run `pipeline cloud connect`');
    expect(out()).toBe('');
  });

  test('an expired credential with no refresh token gets the SAME treatment as nothing stored (still no interactive fallback)', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'stale', expires_at: 1 }); // already expired, no refresh_token
    const fetchImpl = async (url: string): Promise<HttpResponse> => {
      throw new Error(`must not be called: ${url}`);
    };
    const { deps, err } = makeDeps(home, fetchImpl);

    const code = await runCloudOptout([], deps);
    expect(code).toBe(1);
    expect(err()).toContain('pipeline cloud optout:');
    expect(err()).toContain('cannot be refreshed automatically');
    expect(err()).toContain('--reauth');
  });
});

// ---------------------------------------------------------------------------
// The non-admin path — DoD: a clear refusal, never a stack trace, never a
// silent no-op. The server enforces ADMIN+ (`requireRole`); this command
// must render that outcome honestly.
// ---------------------------------------------------------------------------

describe('runCloudOptout — non-admin write refusal', () => {
  test('--set on a viewer/member credential: exit 1, relays the server\'s OWN role sentence, points at the read-only escape hatch', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const log: FetchLog[] = [];
    const fetchImpl = humanScriptedFetch({
      log,
      orgs: [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'member' }],
      optOutPutStatus: 403,
      optOutPutBody: { error: 'this action requires the admin role (your role: member)' },
    });
    const { deps, err, out } = makeDeps(home, fetchImpl);

    const code = await runCloudOptout(['--set', 'true'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('pipeline cloud optout:');
    // The server's exact sentence, not a paraphrase.
    expect(err()).toContain('this action requires the admin role (your role: member)');
    // Names the way anyone in the org CAN still use this command.
    expect(err()).toContain('pipeline cloud optout');
    expect(out()).toBe('');

    // The PUT really was attempted (this is a rendering test, not a
    // pre-emptive client-side role check — the CLI has no role of its own to
    // check against; the server is the sole authority).
    expect(log.some((l) => l.init.method === 'PUT')).toBe(true);
  });

  test('reading still works for the very same non-admin credential (asymmetry is real, not just documented)', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const log: FetchLog[] = [];
    const fetchImpl = humanScriptedFetch({
      log,
      orgs: [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'viewer' }],
      optOutGetBody: { optedOut: false, optedOutAt: null },
    });
    const { deps, out } = makeDeps(home, fetchImpl);

    const code = await runCloudOptout([], deps);
    expect(code).toBe(0);
    expect(out()).toContain('contributing');
  });
});

// ---------------------------------------------------------------------------
// Happy paths — read, and set both directions
// ---------------------------------------------------------------------------

describe('runCloudOptout — read', () => {
  test('plain text: prints org + current state', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const fetchImpl = humanScriptedFetch({ log: [], optOutGetBody: { optedOut: false, optedOutAt: null } });
    const { deps, out } = makeDeps(home, fetchImpl);

    expect(await runCloudOptout([], deps)).toBe(0);
    expect(out()).toContain('org: acme');
    expect(out()).toContain('contributing');
  });

  test('plain text, opted out: shows the timestamp', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const fetchImpl = humanScriptedFetch({
      log: [],
      optOutGetBody: { optedOut: true, optedOutAt: '2026-08-01T00:00:00.000Z' },
    });
    const { deps, out } = makeDeps(home, fetchImpl);

    expect(await runCloudOptout([], deps)).toBe(0);
    expect(out()).toContain('opted OUT');
    expect(out()).toContain('2026-08-01T00:00:00.000Z');
  });

  test('--json: {ok, org, optedOut, optedOutAt}, GET only (never PUT)', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const log: FetchLog[] = [];
    const fetchImpl = humanScriptedFetch({ log, optOutGetBody: { optedOut: true, optedOutAt: '2026-08-01T00:00:00.000Z' } });
    const { deps, out } = makeDeps(home, fetchImpl);

    expect(await runCloudOptout(['--json'], deps)).toBe(0);
    expect(JSON.parse(out())).toEqual({
      ok: true,
      org: 'acme',
      optedOut: true,
      optedOutAt: '2026-08-01T00:00:00.000Z',
    });
    expect(log.every((l) => l.init.method === 'GET')).toBe(true);
  });

  test('X-Org-Id rides on the request when the human rung resolved an org id', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const log: FetchLog[] = [];
    const fetchImpl = humanScriptedFetch({ log });
    const { deps } = makeDeps(home, fetchImpl);

    await runCloudOptout([], deps);
    const call = log.find((l) => l.url.endsWith('/fleet-telemetry/optout'))!;
    expect(call.init.headers['x-org-id']).toBe('org-1');
    expect(call.init.headers['authorization']).toBe('Bearer at1');
  });
});

describe('runCloudOptout — set', () => {
  test('--set true: PUT {optedOut:true}, human line confirms opting OUT', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const log: FetchLog[] = [];
    const fetchImpl = humanScriptedFetch({
      log,
      optOutPutBody: { optedOut: true, optedOutAt: '2026-08-06T00:00:00.000Z' },
    });
    const { deps, out } = makeDeps(home, fetchImpl);

    expect(await runCloudOptout(['--set', 'true'], deps)).toBe(0);
    const put = log.find((l) => l.init.method === 'PUT')!;
    expect(JSON.parse(put.init.body ?? '{}')).toEqual({ optedOut: true });
    expect(put.init.headers['content-type']).toBe('application/json');
    expect(out()).toContain('opted OUT');
    // Never a bare read after a write — one round trip.
    expect(log.filter((l) => l.url.endsWith('/fleet-telemetry/optout')).length).toBe(1);
  });

  test('--set false: PUT {optedOut:false}, human line confirms opting back IN', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const log: FetchLog[] = [];
    const fetchImpl = humanScriptedFetch({ log, optOutPutBody: { optedOut: false, optedOutAt: null } });
    const { deps, out } = makeDeps(home, fetchImpl);

    expect(await runCloudOptout(['--set', 'false'], deps)).toBe(0);
    const put = log.find((l) => l.init.method === 'PUT')!;
    expect(JSON.parse(put.init.body ?? '{}')).toEqual({ optedOut: false });
    expect(out()).toContain('back IN');
  });

  test('--set with an invalid value is a usage error (exit 2), before any network call', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const fetchImpl = async (url: string): Promise<HttpResponse> => {
      throw new Error(`must not be called: ${url}`);
    };
    const { deps, err } = makeDeps(home, fetchImpl);

    const code = await runCloudOptout(['--set', 'yes'], deps);
    expect(code).toBe(2);
    expect(err()).toContain("--set takes 'true' or 'false'");
  });

  test('--set --json: JSON shape matches the read form (no extra "changed" field to special-case)', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const fetchImpl = humanScriptedFetch({ log: [], optOutPutBody: { optedOut: true, optedOutAt: '2026-08-06T00:00:00.000Z' } });
    const { deps, out } = makeDeps(home, fetchImpl);

    expect(await runCloudOptout(['--set', 'true', '--json'], deps)).toBe(0);
    expect(JSON.parse(out())).toEqual({
      ok: true,
      org: 'acme',
      optedOut: true,
      optedOutAt: '2026-08-06T00:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// Org resolution — reuses `selectOrg`, so the same rules as `cloud connect`
// ---------------------------------------------------------------------------

describe('runCloudOptout — org resolution', () => {
  test('multiple orgs, no --org: refuses with the same "choose one with --org" message `selectOrg` gives connect', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const fetchImpl = humanScriptedFetch({
      log: [],
      orgs: [
        { id: 'a', slug: 'acme', name: 'Acme', role: 'owner' },
        { id: 'b', slug: 'beta', name: 'Beta', role: 'admin' },
      ],
    });
    const { deps, err } = makeDeps(home, fetchImpl);

    const code = await runCloudOptout([], deps);
    expect(code).toBe(1);
    expect(err()).toContain('--org');
    expect(err()).toContain('acme');
    expect(err()).toContain('beta');
  });

  test('--org picks the named one even when it is not the single/selected org', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1' });
    const log: FetchLog[] = [];
    const fetchImpl = humanScriptedFetch({
      log,
      orgs: [
        { id: 'a', slug: 'acme', name: 'Acme', role: 'owner' },
        { id: 'b', slug: 'beta', name: 'Beta', role: 'admin' },
      ],
      selectedOrgId: 'a',
    });
    const { deps, out } = makeDeps(home, fetchImpl);

    expect(await runCloudOptout(['--org', 'beta'], deps)).toBe(0);
    expect(out()).toContain('org: beta');
    const call = log.find((l) => l.url.endsWith('/fleet-telemetry/optout'))!;
    expect(call.init.headers['x-org-id']).toBe('b');
  });

  test('a machine-principal credential with no --org and no stored org_slug: same actionable message as `cloud connect`', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1', principal: 'machine' }); // no org_slug recorded
    const fetchImpl = async (url: string): Promise<HttpResponse> => {
      throw new Error(`must not be called: ${url}`);
    };
    const { deps, err } = makeDeps(home, fetchImpl);

    const code = await runCloudOptout([], deps);
    expect(code).toBe(1);
    expect(err()).toContain('no discoverable organization');
    expect(err()).toContain('--org');
  });

  test('a machine-principal credential WITH a stored org_slug resolves silently (no /me call — 401 by construction)', async () => {
    const home = mkHome();
    seedCredential(home, { access_token: 'at1', principal: 'machine', org_slug: 'acme' });
    const log: FetchLog[] = [];
    const fetchImpl = async (url: string, init: HttpInit): Promise<HttpResponse> => {
      log.push({ url, init });
      if (url.endsWith('/fleet-telemetry/optout') && init.method === 'GET') {
        return reply(200, { optedOut: false, optedOutAt: null });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };
    const { deps, out } = makeDeps(home, fetchImpl);

    expect(await runCloudOptout([], deps)).toBe(0);
    expect(out()).toContain('org: acme');
    expect(log.length).toBe(1); // no /api/v1/me
  });
});

// ---------------------------------------------------------------------------
// The machine-credential rung — PIPELINE_MACHINE_TOKEN / --machine-token
// ---------------------------------------------------------------------------

describe('runCloudOptout — machine credential rung', () => {
  const MACHINE_TOKEN = 'aip_m_optoutclient.optoutsecret0123456789';

  function machineScriptedFetch(opts: { log: FetchLog[]; getBody?: unknown }) {
    return async (url: string, init: HttpInit): Promise<HttpResponse> => {
      opts.log.push({ url, init });
      if (url.endsWith('/oauth/token')) {
        return reply(200, { access_token: 'mc_access', token_type: 'Bearer', expires_in: 900, scope: 'machine:credential' });
      }
      if (url.endsWith('/fleet-telemetry/optout') && init.method === 'GET') {
        return reply(200, opts.getBody ?? { optedOut: false, optedOutAt: null });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };
  }

  test('PIPELINE_MACHINE_TOKEN + --org --json: no /me call, no prompt, no browser', async () => {
    const home = mkHome();
    const log: FetchLog[] = [];
    const { deps, out, err } = makeDeps(home, machineScriptedFetch({ log }), { [MACHINE_TOKEN_ENV]: MACHINE_TOKEN });

    const code = await runCloudOptout(['--org', 'acme', '--json'], deps);
    expect(code).toBe(0);
    expect(JSON.parse(out())).toEqual({ ok: true, org: 'acme', optedOut: false, optedOutAt: null });
    expect(log.map((l) => l.url)).toEqual([`${SERVER}/oauth/token`, `${SERVER}/api/v1/fleet-telemetry/optout`]);
    expect(err()).not.toContain('Opening your browser');
  });

  test('--machine-token flag works the same as the env var', async () => {
    const home = mkHome();
    const log: FetchLog[] = [];
    const { deps } = makeDeps(home, machineScriptedFetch({ log }), {});
    expect(await runCloudOptout(['--machine-token', MACHINE_TOKEN, '--org', 'acme'], deps)).toBe(0);
    expect(log.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// --help and dispatch wiring
// ---------------------------------------------------------------------------

describe('runCloudOptout — --help', () => {
  test('prints usage, exit 0, no network', async () => {
    const home = mkHome();
    const fetchImpl = async (url: string): Promise<HttpResponse> => {
      throw new Error(`must not be called: ${url}`);
    };
    const { deps, out } = makeDeps(home, fetchImpl);
    expect(await runCloudOptout(['--help'], deps)).toBe(0);
    expect(out()).toContain('Usage: pipeline cloud optout');
    expect(out()).toContain('--set');
  });
});

describe('runCloud — dispatches `optout` to runCloudOptout', () => {
  test('`pipeline cloud optout --help` routes through runCloud', async () => {
    const home = mkHome();
    const fetchImpl = async (url: string): Promise<HttpResponse> => {
      throw new Error(`must not be called: ${url}`);
    };
    const { deps, out } = makeDeps(home, fetchImpl);
    expect(await runCloud(['optout', '--help'], deps)).toBe(0);
    expect(out()).toContain('Usage: pipeline cloud optout');
  });

  test('bare `pipeline cloud` (no subcommand) usage now ALSO mentions optout', async () => {
    const home = mkHome();
    const fetchImpl = async (url: string): Promise<HttpResponse> => {
      throw new Error(`must not be called: ${url}`);
    };
    const { deps, err } = makeDeps(home, fetchImpl);
    expect(await runCloud([], deps)).toBe(2);
    expect(err()).toContain('Usage: pipeline cloud connect');
    expect(err()).toContain('optout');
  });
});
