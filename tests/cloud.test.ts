// cloud.test.ts — `pipeline cloud connect` device flow + binding.
//
// Everything is injected: a scripted fetch, a wrapped real fs (over a tmpdir)
// that RECORDS the mode of every write/chmod, a fake clock that the injected
// sleep advances (so timeouts are exercised with zero real waiting), and a
// captured out/err. No test touches the network, the real home dir, or the
// real project.

import { test, expect, afterEach, describe } from 'bun:test';
import {
  runCloud,
  parseConnectArgs,
  selectOrg,
  type CloudDeps,
  type HttpResponse,
  type HttpInit,
} from '../src/commands/cloud';
import {
  realFs,
  credentialFilePath,
  cloudJsonPath,
  type CloudFs,
} from '../src/lib/cloud-config';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET_TOKEN = 'pat_SUPER_SECRET_abcdef0123456789';
const DEVICE_CODE = 'device-code-xyz';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Recorded {
  writes: Array<{ path: string; mode?: number }>;
  chmods: Array<{ path: string; mode: number }>;
}

/** Wrap the real fs over a tmp home + tmp project, recording modes. */
function recordingFs(): { fs: CloudFs; rec: Recorded } {
  const rec: Recorded = { writes: [], chmods: [] };
  const fs: CloudFs = {
    existsSync: realFs.existsSync,
    readFileSync: realFs.readFileSync,
    mkdirSync: realFs.mkdirSync,
    writeFileSync: (p, data, options) => {
      rec.writes.push({ path: p, mode: options?.mode });
      realFs.writeFileSync(p, data, options);
    },
    chmodSync: (p, mode) => {
      rec.chmods.push({ path: p, mode });
      realFs.chmodSync(p, mode);
    },
  };
  return { fs, rec };
}

/** A single scripted HTTP reply. */
function reply(status: number, body: unknown): HttpResponse {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

interface FetchLog {
  url: string;
  init: HttpInit;
}

/**
 * A fetch that serves /auth/device/start once, then N pending replies on
 * /auth/device/token before an approved reply, then /api/v1/me. `orgs` and
 * `selectedOrgId` shape the identity response.
 */
function scriptedFetch(opts: {
  pendingPolls?: number;
  slowDownPolls?: number;
  tokenError?: string; // access_denied | expired_token — replaces the approval
  interval?: number;
  expiresIn?: number;
  orgs?: Array<{ id: string; slug: string; name: string; role: string }>;
  selectedOrgId?: string | null;
  meStatus?: number;
  log: FetchLog[];
}) {
  const pending = opts.pendingPolls ?? 0;
  const slow = opts.slowDownPolls ?? 0;
  const orgs = opts.orgs ?? [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'owner' }];
  let polls = 0;
  const fetchImpl = async (url: string, init: HttpInit): Promise<HttpResponse> => {
    opts.log.push({ url, init });
    if (url.endsWith('/auth/device/start')) {
      return reply(200, {
        device_code: DEVICE_CODE,
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://app.example.com/auth/device',
        verification_uri_complete: 'https://app.example.com/auth/device?user_code=WDJB-MJHT',
        expires_in: opts.expiresIn ?? 900,
        interval: opts.interval ?? 5,
      });
    }
    if (url.endsWith('/auth/device/token')) {
      if (polls < slow) {
        polls++;
        return reply(400, { error: 'slow_down' });
      }
      if (polls < slow + pending) {
        polls++;
        return reply(400, { error: 'authorization_pending' });
      }
      if (opts.tokenError) {
        return reply(400, { error: opts.tokenError });
      }
      return reply(200, {
        access_token: SECRET_TOKEN,
        token_type: 'bearer',
        expires_in: 90 * 24 * 60 * 60,
        token_prefix: 'pat_SUPER',
      });
    }
    if (url.endsWith('/api/v1/me')) {
      if (opts.meStatus && opts.meStatus !== 200) return reply(opts.meStatus, { error: 'nope' });
      return reply(200, {
        user: { id: 'u1', email: 'dev@example.com' },
        orgs,
        selectedOrgId: opts.selectedOrgId ?? null,
        selectedRole: null,
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  return fetchImpl;
}

/** Build deps over fresh tmp dirs + a fake clock advanced by sleep. */
function makeDeps(
  fetchImpl: CloudDeps['fetch'],
  fsPair: { fs: CloudFs; rec: Recorded },
  overrides: Partial<CloudDeps> = {},
): { deps: CloudDeps; out: () => string; err: () => string; clock: () => number } {
  const home = mkdtempSync(join(tmpdir(), 'pipeline-cloud-home-'));
  const proj = mkdtempSync(join(tmpdir(), 'pipeline-cloud-proj-'));
  created.push(home, proj);
  let outBuf = '';
  let errBuf = '';
  let clock = 1_000_000;
  const deps: CloudDeps = {
    fetch: fetchImpl,
    fs: fsPair.fs,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    env: { PIPELINE_CLOUD_HOME: home },
    platform: 'linux',
    homedir: home,
    cwd: proj,
    out: (s) => {
      outBuf += s;
    },
    err: (s) => {
      errBuf += s;
    },
    ...overrides,
  };
  return { deps, out: () => outBuf, err: () => errBuf, clock: () => clock };
}

// ---------------------------------------------------------------------------
// parseConnectArgs
// ---------------------------------------------------------------------------

describe('parseConnectArgs', () => {
  test('defaults', () => {
    expect(parseConnectArgs([])).toEqual({ reauth: false, json: false });
  });
  test('all flags (space + equals forms)', () => {
    expect(parseConnectArgs(['--server', 'https://x', '--project=p', '--org', 'o', '--reauth', '--json'])).toEqual({
      server: 'https://x',
      project: 'p',
      org: 'o',
      reauth: true,
      json: true,
    });
  });
  test('missing value is an error', () => {
    expect(parseConnectArgs(['--server'])).toEqual({ error: "--server requires a value" });
  });
  test('unknown argument is an error', () => {
    expect(parseConnectArgs(['--bogus'])).toEqual({ error: "unknown argument '--bogus'" });
  });
});

// ---------------------------------------------------------------------------
// selectOrg
// ---------------------------------------------------------------------------

describe('selectOrg', () => {
  const orgs = [
    { id: 'a', slug: 'acme', name: 'Acme', role: 'owner' },
    { id: 'b', slug: 'beta', name: 'Beta', role: 'member' },
  ];
  test('no orgs → actionable error', () => {
    const r = selectOrg([], undefined, null);
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('no organizations');
  });
  test('--org flag selects by slug', () => {
    expect(selectOrg(orgs, 'beta', null)).toEqual(orgs[1]);
  });
  test('--org with unknown slug lists the available ones', () => {
    const r = selectOrg(orgs, 'nope', null) as { error: string };
    expect(r.error).toContain('acme');
    expect(r.error).toContain('beta');
  });
  test('selectedOrgId is used when no flag', () => {
    expect(selectOrg(orgs, undefined, 'b')).toEqual(orgs[1]);
  });
  test('single org auto-selects', () => {
    expect(selectOrg([orgs[0]!], undefined, null)).toEqual(orgs[0]);
  });
  test('multiple orgs with no hint → error asking for --org', () => {
    const r = selectOrg(orgs, undefined, null) as { error: string };
    expect(r.error).toContain('--org');
  });
});

// ---------------------------------------------------------------------------
// runCloud — happy path
// ---------------------------------------------------------------------------

describe('runCloud connect — happy path', () => {
  test('pending → approved: writes binding + secure credential, prints no secret', async () => {
    const log: FetchLog[] = [];
    const fetchImpl = scriptedFetch({ pendingPolls: 2, log });
    const fsPair = recordingFs();
    const { deps, out, err } = makeDeps(fetchImpl, fsPair);

    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);

    // cloud.json has the slugs and NOT the token.
    const cloudPath = cloudJsonPath(deps.cwd);
    expect(existsSync(cloudPath)).toBe(true);
    const cloudRaw = readFileSync(cloudPath, 'utf-8');
    const cloud = JSON.parse(cloudRaw);
    expect(cloud.server).toBe('https://api.ai-pipeline.dev');
    expect(cloud.org).toBe('acme');
    expect(typeof cloud.project).toBe('string');
    expect(typeof cloud.connected_at).toBe('string');
    // THE no-secret guarantee.
    expect(cloudRaw.includes(SECRET_TOKEN)).toBe(false);
    expect(cloudRaw.includes(DEVICE_CODE)).toBe(false);

    // Credential file DOES hold the token and lives OUTSIDE the project.
    const credPath = credentialFilePath({ platform: 'linux', env: deps.env, homedir: deps.homedir });
    expect(existsSync(credPath)).toBe(true);
    expect(credPath.startsWith(deps.cwd)).toBe(false);
    const cred = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(cred.servers['https://api.ai-pipeline.dev'].access_token).toBe(SECRET_TOKEN);

    // The token was NEVER logged.
    expect(out().includes(SECRET_TOKEN)).toBe(false);
    expect(err().includes(SECRET_TOKEN)).toBe(false);
    // The user_code WAS shown (it is meant to be).
    expect(out()).toContain('WDJB-MJHT');
  });

  test('credential file written with 0600 and chmod 0600; dir mkdir 0700', async () => {
    const log: FetchLog[] = [];
    const fsPair = recordingFs();
    const { deps } = makeDeps(scriptedFetch({ log }), fsPair);

    await runCloud(['connect'], deps);

    const credPath = credentialFilePath({ platform: 'linux', env: deps.env, homedir: deps.homedir });
    const credWrites = fsPair.rec.writes.filter((w) => w.path === credPath);
    expect(credWrites.length).toBeGreaterThan(0);
    for (const w of credWrites) expect(w.mode).toBe(0o600);
    expect(fsPair.rec.chmods.some((c) => c.path === credPath && c.mode === 0o600)).toBe(true);

    // cloud.json is written WITHOUT a restrictive mode (it is meant to be committed).
    const cloudPath = cloudJsonPath(deps.cwd);
    const cloudWrite = fsPair.rec.writes.find((w) => w.path === cloudPath);
    expect(cloudWrite).toBeDefined();
    expect(cloudWrite!.mode).toBeUndefined();
  });

  test('--json emits a machine object with slugs (no secret)', async () => {
    const log: FetchLog[] = [];
    const { deps, out } = makeDeps(scriptedFetch({ log }), recordingFs());
    const code = await runCloud(['connect', '--json', '--project', 'My Cool App'], deps);
    expect(code).toBe(0);
    const obj = JSON.parse(out());
    expect(obj.status).toBe('connected');
    expect(obj.org).toBe('acme');
    expect(obj.project).toBe('my-cool-app'); // slugified
    expect(out().includes(SECRET_TOKEN)).toBe(false);
  });

  test('slow_down widens the interval and still approves', async () => {
    const log: FetchLog[] = [];
    const { deps } = makeDeps(scriptedFetch({ slowDownPolls: 1, pendingPolls: 1, log }), recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
  });

  test('--server flag overrides the default and keys the credential store', async () => {
    const log: FetchLog[] = [];
    const fsPair = recordingFs();
    const { deps } = makeDeps(scriptedFetch({ log }), fsPair);
    await runCloud(['connect', '--server', 'https://cp.acme.test/'], deps);
    // Trailing slash normalized; all calls hit the given base.
    expect(log.every((l) => l.url.startsWith('https://cp.acme.test/'))).toBe(true);
    const credPath = credentialFilePath({ platform: 'linux', env: deps.env, homedir: deps.homedir });
    const cred = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(cred.servers['https://cp.acme.test']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// runCloud — failure outcomes
// ---------------------------------------------------------------------------

describe('runCloud connect — failure outcomes', () => {
  test('access_denied → exit 1, no binding written', async () => {
    const log: FetchLog[] = [];
    const { deps, err } = makeDeps(scriptedFetch({ tokenError: 'access_denied', log }), recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('denied');
    expect(existsSync(cloudJsonPath(deps.cwd))).toBe(false);
  });

  test('expired_token → exit 1', async () => {
    const log: FetchLog[] = [];
    const { deps, err } = makeDeps(scriptedFetch({ tokenError: 'expired_token', log }), recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('expired');
  });

  test('poll deadline reached (always pending) → bounded timeout, exit 1', async () => {
    const log: FetchLog[] = [];
    // expires_in short, interval steps the fake clock; pending forever.
    const { deps, err } = makeDeps(
      scriptedFetch({ pendingPolls: 100000, expiresIn: 20, interval: 5, log }),
      recordingFs(),
    );
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('timed out');
    // Bounded: it stopped polling well before 100000 attempts.
    const tokenPolls = log.filter((l) => l.url.endsWith('/auth/device/token')).length;
    expect(tokenPolls).toBeLessThan(10);
  });

  test('no orgs → exit 1 with actionable message', async () => {
    const log: FetchLog[] = [];
    const { deps, err } = makeDeps(scriptedFetch({ orgs: [], log }), recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('no organizations');
  });

  test('multiple orgs without --org → exit 1 asking to choose', async () => {
    const log: FetchLog[] = [];
    const orgs = [
      { id: 'a', slug: 'acme', name: 'Acme', role: 'owner' },
      { id: 'b', slug: 'beta', name: 'Beta', role: 'member' },
    ];
    const { deps, err } = makeDeps(scriptedFetch({ orgs, log }), recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('--org');
  });

  test('me returns 401 → exit 1', async () => {
    const log: FetchLog[] = [];
    const { deps, err } = makeDeps(scriptedFetch({ meStatus: 401, log }), recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('--reauth');
  });

  test('network error is a clean exit 1 (not a crash)', async () => {
    const log: FetchLog[] = [];
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const { deps, err } = makeDeps(fetchImpl, recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('could not reach');
  });
});

// ---------------------------------------------------------------------------
// runCloud — idempotency + reuse
// ---------------------------------------------------------------------------

describe('runCloud connect — idempotency', () => {
  test('second connect reuses the stored credential (no device flow) and reports update', async () => {
    const fsPair = recordingFs();
    const log1: FetchLog[] = [];
    const first = makeDeps(scriptedFetch({ log: log1 }), fsPair);
    expect(await runCloud(['connect'], first.deps)).toBe(0);

    // Second run: SAME home + project + fs, fresh fetch log. Should skip
    // device/start + token entirely and only call /api/v1/me.
    const log2: FetchLog[] = [];
    const second = makeDeps(scriptedFetch({ log: log2 }), fsPair, {
      env: first.deps.env,
      homedir: first.deps.homedir,
      cwd: first.deps.cwd,
    });
    const code = await runCloud(['connect'], second.deps);
    expect(code).toBe(0);
    expect(log2.some((l) => l.url.endsWith('/auth/device/start'))).toBe(false);
    expect(log2.some((l) => l.url.endsWith('/auth/device/token'))).toBe(false);
    expect(log2.some((l) => l.url.endsWith('/api/v1/me'))).toBe(true);
    expect(second.out()).toContain('stored credential');
    expect(second.out()).toContain('updating the binding');
  });

  test('--reauth forces a fresh device flow even with a stored credential', async () => {
    const fsPair = recordingFs();
    const first = makeDeps(scriptedFetch({ log: [] }), fsPair);
    await runCloud(['connect'], first.deps);

    const log2: FetchLog[] = [];
    const second = makeDeps(scriptedFetch({ log: log2 }), fsPair, {
      env: first.deps.env,
      homedir: first.deps.homedir,
      cwd: first.deps.cwd,
    });
    expect(await runCloud(['connect', '--reauth'], second.deps)).toBe(0);
    expect(log2.some((l) => l.url.endsWith('/auth/device/start'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI shell + routing
// ---------------------------------------------------------------------------

describe('runCloud — shell', () => {
  test('no subcommand → usage on stderr, exit 2', async () => {
    const { deps, err } = makeDeps(scriptedFetch({ log: [] }), recordingFs());
    expect(await runCloud([], deps)).toBe(2);
    expect(err()).toContain('Usage: pipeline cloud connect');
  });
  test('unknown subcommand → exit 2', async () => {
    const { deps, err } = makeDeps(scriptedFetch({ log: [] }), recordingFs());
    expect(await runCloud(['bogus'], deps)).toBe(2);
    expect(err()).toContain("unknown subcommand 'bogus'");
  });
  test('--help → usage on stdout, exit 0', async () => {
    const { deps, out } = makeDeps(scriptedFetch({ log: [] }), recordingFs());
    expect(await runCloud(['--help'], deps)).toBe(0);
    expect(out()).toContain('Usage: pipeline cloud connect');
  });
  test('bad connect flag → exit 2', async () => {
    const { deps, err } = makeDeps(scriptedFetch({ log: [] }), recordingFs());
    expect(await runCloud(['connect', '--nope'], deps)).toBe(2);
    expect(err()).toContain("unknown argument '--nope'");
  });
});

// ---------------------------------------------------------------------------
// cli.ts dispatch routing
// ---------------------------------------------------------------------------

test('cli.ts routes `cloud` to runCloud (spawned subprocess)', async () => {
  const proc = Bun.spawnSync({
    cmd: ['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'cloud', '--help'],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = proc.stdout.toString();
  expect(proc.exitCode).toBe(0);
  expect(stdout).toContain('Usage: pipeline cloud connect');
});
