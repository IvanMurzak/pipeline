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
import type { SpawnFn } from '../src/lib/loopback-oauth';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpCreateServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

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
  // `env` is merged (not replaced) so a test overriding just e.g.
  // SSH_CONNECTION doesn't lose PIPELINE_CLOUD_HOME — every OTHER override
  // key still fully replaces the default, as before.
  const { env: envOverride, ...restOverrides } = overrides;
  const deps: CloudDeps = {
    fetch: fetchImpl,
    fs: fsPair.fs,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    env: { PIPELINE_CLOUD_HOME: home, ...envOverride },
    // Default platform is 'linux' with no DISPLAY set, which — by design —
    // already trips the browser flow's pre-flight fallback for every EXISTING
    // device-flow test below (a real, deliberate consequence of a2: those
    // tests now implicitly also cover "headless environment falls back to
    // the device code"). Tests that want to exercise the browser flow itself
    // override `platform` to 'darwin'/'win32' (see the "browser loopback
    // flow" describe block) to bypass the Linux-specific checks.
    platform: 'linux',
    homedir: home,
    cwd: proj,
    out: (s) => {
      outBuf += s;
    },
    err: (s) => {
      errBuf += s;
    },
    ...restOverrides,
  };
  return { deps, out: () => outBuf, err: () => errBuf, clock: () => clock };
}

/** Wraps `node:http.createServer` so a test can assert the loopback listener
 *  was actually closed — the security-critical guarantee this task's DoD
 *  calls out by name ("the listener is closed on every exit path"). */
function spyLoopbackServer(): { createServer: () => Server; closed: () => boolean } {
  let didClose = false;
  const createServer = (): Server => {
    const real = httpCreateServer();
    const originalClose = real.close.bind(real);
    real.close = ((cb?: (err?: Error) => void) => {
      didClose = true;
      return originalClose(cb);
    }) as typeof real.close;
    return real;
  };
  return { createServer, closed: () => didClose };
}

/** A minimal fake child process satisfying just what `openBrowser` uses
 *  (`.on('error', …)` / `.on('exit', …)`) — cast to `SpawnFn`'s return type
 *  at the call site, same pattern as loopback-oauth.test.ts. */
function fakeChild(): EventEmitter {
  return new EventEmitter();
}

// ---------------------------------------------------------------------------
// parseConnectArgs
// ---------------------------------------------------------------------------

describe('parseConnectArgs', () => {
  test('defaults', () => {
    expect(parseConnectArgs([])).toEqual({ reauth: false, device: false, json: false });
  });
  test('all flags (space + equals forms)', () => {
    expect(
      parseConnectArgs(['--server', 'https://x', '--project=p', '--org', 'o', '--reauth', '--device', '--json']),
    ).toEqual({
      server: 'https://x',
      project: 'p',
      org: 'o',
      reauth: true,
      device: true,
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
// runCloud — browser loopback (PKCE) flow + the selection ladder (a2)
// ---------------------------------------------------------------------------
//
// The low-level listener (state/path/timeout rejection, closure on every
// exit path) is tested exhaustively against a REAL loopback socket in
// loopback-oauth.test.ts. These tests prove the higher layer: `runCloud`
// actually WIRES that listener up, picks browser vs. device correctly per
// 04-cloud-auth.md §1.2/§4, prints the documented one-line reasons, and —
// for the one full happy-path test — that a real PKCE round trip against a
// scripted token endpoint produces a stored, working credential.
//
// The "fake browser" in these tests is the injected `spawn`: instead of
// launching a real OS browser, it performs a REAL `fetch()` back to the
// CLI's own real loopback listener, exactly as a browser completing the
// OAuth redirect would. This proves every piece EXCEPT an actual OS window
// opening and an actual human clicking Approve against production — see the
// PR description for exactly which DoD boxes that leaves as "awaiting a
// live run".

describe('runCloud connect — browser flow selection ladder', () => {
  test('default test env (linux, no DISPLAY) falls back to device flow with the documented reason', async () => {
    const log: FetchLog[] = [];
    const { deps, out } = makeDeps(scriptedFetch({ log }), recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('No browser available here — falling back to a device code.');
    expect(log.some((l) => l.url.endsWith('/auth/device/start'))).toBe(true);
  });

  test('--device skips the browser silently (no fallback reason line) and uses the device flow', async () => {
    const log: FetchLog[] = [];
    // platform 'darwin' would otherwise sail straight through every
    // pre-flight check — proving --device wins regardless.
    const { deps, out } = makeDeps(scriptedFetch({ log }), recordingFs(), { platform: 'darwin' });
    const code = await runCloud(['connect', '--device'], deps);
    expect(code).toBe(0);
    expect(out()).not.toContain('falling back');
    expect(log.some((l) => l.url.endsWith('/auth/device/start'))).toBe(true);
    expect(log.some((l) => l.url.endsWith('/oauth/authorize'))).toBe(false);
  });

  test('SSH_CONNECTION with no DISPLAY falls back with the SSH-specific reason', async () => {
    const log: FetchLog[] = [];
    const { deps, out } = makeDeps(scriptedFetch({ log }), recordingFs(), {
      env: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' },
    });
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('Connected over SSH with no browser to open — falling back to a device code.');
    expect(log.some((l) => l.url.endsWith('/auth/device/start'))).toBe(true);
  });

  test('an unbindable loopback port falls back with the documented message', async () => {
    const log: FetchLog[] = [];
    class FailingServer extends EventEmitter {
      listen(): this {
        queueMicrotask(() => this.emit('error', new Error('EADDRNOTAVAIL (simulated)')));
        return this;
      }
      close(cb?: () => void): this {
        cb?.();
        return this;
      }
    }
    const { deps, out } = makeDeps(scriptedFetch({ log }), recordingFs(), {
      platform: 'darwin', // bypass the Linux-only pre-flight checks entirely
      createLoopbackServer: () => new FailingServer() as unknown as Server,
    });
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('Could not open a local callback port — falling back to a device code.');
    expect(log.some((l) => l.url.endsWith('/auth/device/start'))).toBe(true);
  });

  test('a browser opener that exits non-zero falls back, prints why, and closes the listener it had already bound', async () => {
    const log: FetchLog[] = [];
    const spawnFn: SpawnFn = () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('exit', 1));
      return child as unknown as ReturnType<SpawnFn>;
    };
    const spy = spyLoopbackServer();
    const { deps, out } = makeDeps(scriptedFetch({ log }), recordingFs(), {
      platform: 'darwin',
      spawn: spawnFn,
      createLoopbackServer: spy.createServer,
    });
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('Could not open your browser — falling back to a device code.');
    expect(log.some((l) => l.url.endsWith('/auth/device/start'))).toBe(true);
    expect(spy.closed()).toBe(true);
  });

  test('a browser opener that hangs (never emits exit/error) does not hang the CLI forever', async () => {
    // Simulates the known real-world `xdg-open` failure mode: the launcher
    // subprocess never reports back. `openBrowserGraceMs` bounds the wait,
    // and `loopbackTimeoutMs` bounds the subsequent wait on the listener —
    // together the command still reaches a clean terminal state instead of
    // hanging indefinitely.
    const spawnFn: SpawnFn = () => fakeChild() as unknown as ReturnType<SpawnFn>; // never emits anything
    const spy = spyLoopbackServer();
    const { deps, err } = makeDeps(scriptedFetch({ log: [] }), recordingFs(), {
      platform: 'darwin',
      spawn: spawnFn,
      createLoopbackServer: spy.createServer,
      openBrowserGraceMs: 30,
      loopbackTimeoutMs: 30,
    });
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('timed out waiting for browser approval');
    expect(spy.closed()).toBe(true);
  });

  test('a wrong-state callback from the "browser" is a hard failure, NOT a silent fallback to device', async () => {
    // Simulates a stray/malicious local request racing the real browser:
    // the "browser" hits the CLI's REAL loopback listener but with the
    // wrong `state`. 07-approval-policy.md §8: this ends the whole attempt
    // rather than silently retrying or downgrading to the device flow.
    const spawnFn: SpawnFn = (_cmd, args) => {
      const child = fakeChild();
      const url = new URL(args[args.length - 1]!);
      const redirectUri = url.searchParams.get('redirect_uri')!;
      queueMicrotask(async () => {
        try {
          await fetch(`${redirectUri}?code=X&state=WRONG_STATE`);
        } finally {
          child.emit('exit', 0);
        }
      });
      return child as unknown as ReturnType<SpawnFn>;
    };
    const { deps, err } = makeDeps(scriptedFetch({ log: [] }), recordingFs(), {
      platform: 'darwin',
      spawn: spawnFn,
    });
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('ignored an unexpected callback');
  });

  test('full browser flow: fake browser drives the REAL loopback listener + a genuine PKCE round trip', async () => {
    const log: FetchLog[] = [];
    let capturedRedirectUri = '';
    let capturedCodeChallenge = '';

    const spawnFn: SpawnFn = (_cmd, args) => {
      const child = fakeChild();
      const url = new URL(args[args.length - 1]!);
      capturedRedirectUri = url.searchParams.get('redirect_uri')!;
      capturedCodeChallenge = url.searchParams.get('code_challenge')!;
      const state = url.searchParams.get('state')!;
      // (`scope` absence is asserted independently and safely in
      // loopback-oauth.test.ts's `buildAuthorizeUrl` suite — an assertion
      // failure THIS deep inside the spawn callback would be swallowed by
      // `openBrowser`'s own try/catch rather than surfacing as a clean test
      // failure, so it deliberately isn't duplicated here.)
      queueMicrotask(async () => {
        try {
          await fetch(`${capturedRedirectUri}?code=FAKE_AUTH_CODE&state=${encodeURIComponent(state)}`);
        } finally {
          child.emit('exit', 0);
        }
      });
      return child as unknown as ReturnType<SpawnFn>;
    };

    const fetchImpl = async (url: string, init: HttpInit): Promise<HttpResponse> => {
      log.push({ url, init });
      if (url.endsWith('/oauth/token')) {
        const params = new URLSearchParams(init.body ?? '');
        expect(params.get('grant_type')).toBe('authorization_code');
        expect(params.get('code')).toBe('FAKE_AUTH_CODE');
        expect(params.get('client_id')).toBe('ai-pipeline-cli');
        expect(params.get('redirect_uri')).toBe(capturedRedirectUri);
        expect(params.get('resource')).toBe('https://api.ai-pipeline.dev/api');
        // Genuine PKCE binding: re-derive S256(verifier) and confirm it
        // equals the challenge actually sent to /oauth/authorize.
        const verifier = params.get('code_verifier') ?? '';
        const rederived = createHash('sha256').update(verifier, 'ascii').digest('base64url');
        expect(rederived).toBe(capturedCodeChallenge);
        return reply(200, {
          access_token: SECRET_TOKEN,
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'rt_should_be_ignored_by_a2',
          scope: '',
        });
      }
      if (url.endsWith('/api/v1/me')) {
        return reply(200, {
          user: { id: 'u1', email: 'dev@example.com' },
          orgs: [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'owner' }],
          selectedOrgId: null,
          selectedRole: null,
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };

    const fsPair = recordingFs();
    const spy = spyLoopbackServer();
    const { deps, out } = makeDeps(fetchImpl, fsPair, {
      platform: 'darwin',
      spawn: spawnFn,
      createLoopbackServer: spy.createServer,
    });

    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('Opening your browser to authorize');
    expect(log.some((l) => l.url.endsWith('/oauth/token'))).toBe(true);
    expect(log.some((l) => l.url.endsWith('/auth/device/start'))).toBe(false);
    expect(spy.closed()).toBe(true); // closed even on the SUCCESS path

    const credPath = credentialFilePath({ platform: 'darwin', env: deps.env, homedir: deps.homedir });
    const cred = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(cred.servers['https://api.ai-pipeline.dev'].access_token).toBe(SECRET_TOKEN);
    expect(cred.servers['https://api.ai-pipeline.dev'].org_slug).toBe('acme');
    expect(out().includes(SECRET_TOKEN)).toBe(false);
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
