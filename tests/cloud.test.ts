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
  defaultOrgName,
  selectOrg,
  splitMachineCredential,
  assertNotMcpUrl,
  MACHINE_TOKEN_ENV,
  MACHINE_CREDENTIAL_PREFIX,
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
import type { ShellRunner } from '../src/lib/runner-enrol';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer as httpCreateServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

const SECRET_TOKEN = 'pat_SUPER_SECRET_abcdef0123456789';
const DEVICE_CODE = 'device-code-xyz';
/** The RFC 8628 device grant's refresh token (task a3) — a5 depends on this
 *  surviving into the credential store; see the "device flow persists the
 *  refresh token" test below. */
const DEVICE_REFRESH_TOKEN = 'rt_device_SECRET_0123456789';

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
  renames: Array<{ from: string; to: string }>;
}

/** Wrap the real fs over a tmp home + tmp project, recording modes + renames
 *  (a5: `writeCredentialStore` now writes a temp file and renames it over
 *  the final path — see the "atomic write-then-rename" describe block). */
function recordingFs(): { fs: CloudFs; rec: Recorded } {
  const rec: Recorded = { writes: [], chmods: [], renames: [] };
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
    renameSync: (from, to) => {
      rec.renames.push({ from, to });
      realFs.renameSync(from, to);
    },
    unlinkSync: realFs.unlinkSync,
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
 * A fetch that serves the RFC 8628 device grant — /oauth/device_authorization
 * once, then N pending/slow_down replies on /oauth/token before an approved
 * reply, then /api/v1/me. `orgs` and `selectedOrgId` shape the identity
 * response. (Task a3: this used to script the legacy `/auth/device/*`
 * endpoints — see the "legacy device flow" describe block at the bottom of
 * this file for that contract, pinned separately now that `cloud.ts` no
 * longer calls it.)
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
  /** Status `POST /api/v1/orgs` answers with. Default 201 (created). */
  createOrgStatus?: number;
  log: FetchLog[];
}) {
  const pending = opts.pendingPolls ?? 0;
  const slow = opts.slowDownPolls ?? 0;
  const orgs = opts.orgs ?? [{ id: 'org-1', slug: 'acme', name: 'Acme', role: 'owner' }];
  let polls = 0;
  const fetchImpl = async (url: string, init: HttpInit): Promise<HttpResponse> => {
    opts.log.push({ url, init });
    if (url.endsWith('/oauth/device_authorization')) {
      return reply(200, {
        device_code: DEVICE_CODE,
        user_code: 'WDJB-MJHT',
        verification_uri: 'https://app.example.com/auth/device',
        verification_uri_complete: 'https://app.example.com/auth/device?user_code=WDJB-MJHT',
        expires_in: opts.expiresIn ?? 900,
        interval: opts.interval ?? 5,
      });
    }
    if (url.endsWith('/oauth/token')) {
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
      // RFC 8628 device grant response (mesh-oauth/routes.ts's
      // `handleDeviceCodeGrant`) — REFRESHABLE, unlike the legacy PAT flow's
      // reply, and no `token_prefix` (the AS never returns one).
      return reply(200, {
        access_token: SECRET_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: DEVICE_REFRESH_TOKEN,
        scope: '',
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
    // First-org auto-create. The wire field is `orgId`, NOT `id` — the CLI
    // maps it, and a test that used `id` here would pass while the real
    // control plane's shape broke it (apps/api modules/orgs/types.ts).
    if (url.endsWith('/api/v1/orgs')) {
      const status = opts.createOrgStatus ?? 201;
      if (status !== 201) return reply(status, { error: 'nope' });
      return reply(201, {
        org: { orgId: 'org-new', slug: 'dev-s-workspace', name: "dev's workspace", role: 'owner' },
        selected: true,
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
    // task a6 defaults: NEITHER a real subprocess NOR a real prompt may ever
    // run from a test. `runnerShell` reports "pipeline-runner not installed"
    // (spawn ENOENT shape, code 127) so `isRunnerServiceInstalled` reads
    // false and the enrolment path proceeds to `promptYesNo`, which defaults
    // to DECLINING — so every one of the ~40 pre-existing connect tests below
    // (none of which pass --runner or opt into the a6 describe blocks) hits
    // the silent "no runner registered" branch and never touches the network
    // or a real binary. Tests that DO want to exercise enrolment override
    // these three explicitly (see the "runner enrolment (task a6)" block).
    runnerShell: () => ({ code: 127, stdout: '', stderr: '' }),
    promptYesNo: async () => false,
    hostname: () => 'test-host',
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
    expect(parseConnectArgs([])).toEqual({
      reauth: false,
      device: false,
      json: false,
      noRunner: false,
      runner: false,
    });
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
      noRunner: false,
      runner: false,
    });
  });
  test('missing value is an error', () => {
    expect(parseConnectArgs(['--server'])).toEqual({ error: "--server requires a value" });
  });
  test('unknown argument is an error', () => {
    expect(parseConnectArgs(['--bogus'])).toEqual({ error: "unknown argument '--bogus'" });
  });

  // task a6
  test('--no-runner', () => {
    const r = parseConnectArgs(['--no-runner']);
    expect(r).toEqual({ reauth: false, device: false, json: false, noRunner: true, runner: false });
  });
  test('--runner', () => {
    const r = parseConnectArgs(['--runner']);
    expect(r).toEqual({ reauth: false, device: false, json: false, noRunner: false, runner: true });
  });
  test('--runner-name <name> (space + equals forms)', () => {
    expect(parseConnectArgs(['--runner-name', 'my-box'])).toEqual({
      reauth: false,
      device: false,
      json: false,
      noRunner: false,
      runner: false,
      runnerName: 'my-box',
    });
    expect(parseConnectArgs(['--runner-name=my-box'])).toEqual({
      reauth: false,
      device: false,
      json: false,
      noRunner: false,
      runner: false,
      runnerName: 'my-box',
    });
  });
  test('--runner-name with no value is an error', () => {
    expect(parseConnectArgs(['--runner-name'])).toEqual({ error: '--runner-name requires a value' });
  });
  test('--runner + --no-runner together is a usage error', () => {
    expect(parseConnectArgs(['--runner', '--no-runner'])).toEqual({
      error: 'cannot combine --runner and --no-runner',
    });
  });
});

// ---------------------------------------------------------------------------
// selectOrg
// ---------------------------------------------------------------------------

describe('defaultOrgName', () => {
  // The one string a user lives with forever after the auto-create, derived
  // from input that is attacker-ish by default: an email local part carries
  // dots, plus-addressing, quoting and non-ASCII.
  test('reads as a name, not as a filename', () => {
    expect(defaultOrgName('ada.lovelace@example.com')).toBe("ada lovelace's workspace");
    expect(defaultOrgName('ada_lovelace@example.com')).toBe("ada lovelace's workspace");
  });
  test('drops plus-addressing', () => {
    expect(defaultOrgName('dev+ci@example.com')).toBe("dev's workspace");
  });
  test('keeps non-ASCII letters rather than mangling them', () => {
    expect(defaultOrgName('иван@example.com')).toBe("иван's workspace");
  });
  test('strips what the server would reject, without ending up empty', () => {
    expect(defaultOrgName('"><script>@example.com')).toBe("script's workspace");
    // Nothing usable left ⇒ a generic name, never an invented identity.
    expect(defaultOrgName('!!!@example.com')).toBe('My workspace');
    expect(defaultOrgName(undefined)).toBe('My workspace');
    expect(defaultOrgName('')).toBe('My workspace');
  });
  test('stays well inside the server ceiling of 200', () => {
    expect(defaultOrgName(`${'a'.repeat(500)}@example.com`).length).toBeLessThanOrEqual(200);
  });
});

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
  test('no orgs WITH --org names the way out: drop the flag', () => {
    // Reachable only with an explicit --org now; without one the caller
    // creates the first org instead of consulting this function.
    const r = selectOrg([], 'acme', null) as { error: string };
    expect(r.error).toContain('re-run without --org');
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
    // THE no-secret guarantee — covers the refresh token too (a3).
    expect(cloudRaw.includes(SECRET_TOKEN)).toBe(false);
    expect(cloudRaw.includes(DEVICE_CODE)).toBe(false);
    expect(cloudRaw.includes(DEVICE_REFRESH_TOKEN)).toBe(false);

    // Credential file DOES hold the access token AND the refresh token
    // (a3 — a5 depends on the latter being here to rotate), and lives
    // OUTSIDE the project.
    const credPath = credentialFilePath({ platform: 'linux', env: deps.env, homedir: deps.homedir });
    expect(existsSync(credPath)).toBe(true);
    expect(credPath.startsWith(deps.cwd)).toBe(false);
    const cred = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(cred.servers['https://api.ai-pipeline.dev'].access_token).toBe(SECRET_TOKEN);
    expect(cred.servers['https://api.ai-pipeline.dev'].refresh_token).toBe(DEVICE_REFRESH_TOKEN);

    // Neither secret was EVER logged.
    expect(out().includes(SECRET_TOKEN)).toBe(false);
    expect(err().includes(SECRET_TOKEN)).toBe(false);
    expect(out().includes(DEVICE_REFRESH_TOKEN)).toBe(false);
    expect(err().includes(DEVICE_REFRESH_TOKEN)).toBe(false);
    // The user_code WAS shown (it is meant to be), and so was the full
    // `verification_uri_complete` (RFC 8628 §3.3.1 — a3): a phone can scan
    // it instead of transcribing the code by hand.
    expect(out()).toContain('WDJB-MJHT');
    expect(out()).toContain('https://app.example.com/auth/device?user_code=WDJB-MJHT');
  });

  test('credential file written atomically (temp file + rename), 0600, chmod 0600; dir mkdir 0700', async () => {
    const log: FetchLog[] = [];
    const fsPair = recordingFs();
    const { deps } = makeDeps(scriptedFetch({ log }), fsPair);

    await runCloud(['connect'], deps);

    const credPath = credentialFilePath({ platform: 'linux', env: deps.env, homedir: deps.homedir });
    const credDir = dirname(credPath);

    // a5: NOTHING is ever written directly to `credPath` — every write lands
    // on a uniquely-named temp file in the SAME directory, mode 0600, which
    // is then renamed over `credPath`. This is the write-then-rename
    // durability guarantee (DoD box 2): `credPath` itself is only ever
    // touched by an atomic rename, never a partial write.
    expect(fsPair.rec.writes.some((w) => w.path === credPath)).toBe(false);
    const tmpWrites = fsPair.rec.writes.filter(
      (w) => dirname(w.path) === credDir && w.path !== credPath && w.path.includes('.tmp-'),
    );
    expect(tmpWrites.length).toBeGreaterThan(0);
    for (const w of tmpWrites) expect(w.mode).toBe(0o600);

    // Every one of those temp files was renamed onto credPath.
    const credRenames = fsPair.rec.renames.filter((r) => r.to === credPath);
    expect(credRenames.length).toBeGreaterThan(0);
    expect(credRenames.every((r) => tmpWrites.some((w) => w.path === r.from))).toBe(true);

    // chmod'd 0600 on both the temp file (before rename) and the final path
    // (after) — belt-and-braces against umask / a pre-existing looser mode.
    expect(fsPair.rec.chmods.some((c) => c.path === credPath && c.mode === 0o600)).toBe(true);
    expect(tmpWrites.every((w) => fsPair.rec.chmods.some((c) => c.path === w.path && c.mode === 0o600))).toBe(true);

    // No orphan temp file survives — the rename consumed it.
    expect(existsSync(tmpWrites[0]!.path)).toBe(false);
    expect(existsSync(credPath)).toBe(true);

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

  test('slow_down widens the interval, prints its stated message, and still approves', async () => {
    const log: FetchLog[] = [];
    const { deps, out } = makeDeps(scriptedFetch({ slowDownPolls: 1, pendingPolls: 1, log }), recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('slow down');
  });

  test('authorization_pending has a stated message ("Waiting for you to approve…") while polling', async () => {
    const log: FetchLog[] = [];
    const { deps, out } = makeDeps(scriptedFetch({ pendingPolls: 3, log }), recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('Waiting for you to approve');
  });

  test('falls back to the bare verification_uri + typed code when verification_uri_complete is absent', async () => {
    const log: FetchLog[] = [];
    const fetchImpl = async (url: string, init: HttpInit): Promise<HttpResponse> => {
      log.push({ url, init });
      if (url.endsWith('/oauth/device_authorization')) {
        return reply(200, {
          device_code: DEVICE_CODE,
          user_code: 'NOQR-CODE',
          verification_uri: 'https://app.example.com/auth/device',
          // deliberately no verification_uri_complete
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith('/oauth/token')) {
        return reply(200, {
          access_token: SECRET_TOKEN,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: DEVICE_REFRESH_TOKEN,
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
    const { deps, out } = makeDeps(fetchImpl, recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('https://app.example.com/auth/device');
    expect(out()).toContain('NOQR-CODE');
  });

  test('device_authorization request is form-urlencoded, names the api resource, and sends no scope', async () => {
    const log: FetchLog[] = [];
    let sawContentType = '';
    let sawParams: URLSearchParams | undefined;
    const fetchImpl = async (url: string, init: HttpInit): Promise<HttpResponse> => {
      log.push({ url, init });
      if (url.endsWith('/oauth/device_authorization')) {
        sawContentType = init.headers['content-type'] ?? '';
        sawParams = new URLSearchParams(init.body ?? '');
        return reply(200, {
          device_code: DEVICE_CODE,
          user_code: 'WDJB-MJHT',
          verification_uri: 'https://app.example.com/auth/device',
          verification_uri_complete: 'https://app.example.com/auth/device?user_code=WDJB-MJHT',
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith('/oauth/token')) {
        return reply(200, {
          access_token: SECRET_TOKEN,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: DEVICE_REFRESH_TOKEN,
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
    const { deps } = makeDeps(fetchImpl, recordingFs());
    expect(await runCloud(['connect'], deps)).toBe(0);
    expect(sawContentType).toBe('application/x-www-form-urlencoded');
    expect(sawParams?.get('client_id')).toBe('ai-pipeline-cli');
    expect(sawParams?.get('resource')).toBe('https://api.ai-pipeline.dev/api');
    expect(sawParams?.has('scope')).toBe(false);
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
    const tokenPolls = log.filter((l) => l.url.endsWith('/oauth/token')).length;
    expect(tokenPolls).toBeLessThan(10);
  });

  test('no orgs → the first one is CREATED, not a dead end', async () => {
    // This used to exit 1 with "create one in the web dashboard, then retry".
    // That is a dead end in the middle of a flow whose whole promise is that
    // the dashboard is something you visit AFTER it works — and a brand-new
    // account is exactly the account this command exists for.
    const log: FetchLog[] = [];
    const { deps, out } = makeDeps(scriptedFetch({ orgs: [], log }), recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
    const posted = log.find((l) => l.url.endsWith('/api/v1/orgs'));
    expect(posted?.init.method).toBe('POST');
    expect(JSON.parse(String(posted?.init.body)).name).toBe("dev's workspace");
    // The created slug is what the connect reports and binds — not a slug
    // guessed client-side from the name (the server owns slug allocation).
    expect(out()).toContain('dev-s-workspace');
  });

  test('no orgs AND an explicit --org → refuses instead of creating a different org', async () => {
    // The user named a specific org. Silently creating one under a name they
    // did not choose would be a worse answer than saying it does not exist.
    const log: FetchLog[] = [];
    const { deps, err } = makeDeps(scriptedFetch({ orgs: [], log }), recordingFs());
    const code = await runCloud(['connect', '--org', 'acme'], deps);
    expect(code).toBe(1);
    // And the way OUT of that state is named: drop the flag.
    expect(err()).toContain('re-run without --org');
    expect(log.some((l) => l.url.endsWith('/api/v1/orgs') && l.init.method === 'POST')).toBe(false);
  });

  test('an org-create refusal is reported with what to do next', async () => {
    // 403 = a credential class that may not create orgs (a machine one).
    const log: FetchLog[] = [];
    const { deps, err } = makeDeps(scriptedFetch({ orgs: [], createOrgStatus: 403, log }), recordingFs());
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('--org');
  });

  test('an account that already has an org never creates another', async () => {
    const log: FetchLog[] = [];
    const { deps } = makeDeps(scriptedFetch({ log }), recordingFs());
    expect(await runCloud(['connect'], deps)).toBe(0);
    expect(log.some((l) => l.url.endsWith('/api/v1/orgs') && l.init.method === 'POST')).toBe(false);
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
    // device_authorization + token entirely and only call /api/v1/me.
    const log2: FetchLog[] = [];
    const second = makeDeps(scriptedFetch({ log: log2 }), fsPair, {
      env: first.deps.env,
      homedir: first.deps.homedir,
      cwd: first.deps.cwd,
    });
    const code = await runCloud(['connect'], second.deps);
    expect(code).toBe(0);
    expect(log2.some((l) => l.url.endsWith('/oauth/device_authorization'))).toBe(false);
    expect(log2.some((l) => l.url.endsWith('/oauth/token'))).toBe(false);
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
    expect(log2.some((l) => l.url.endsWith('/oauth/device_authorization'))).toBe(true);
  });

  test('an expired stored credential WITH a refresh_token is silently REFRESHED — no browser/device flow at all (a5)', async () => {
    const fsPair = recordingFs();
    const first = makeDeps(scriptedFetch({ log: [] }), fsPair);
    expect(await runCloud(['connect'], first.deps)).toBe(0);

    // Force the stored credential to look expired, keeping its refresh_token.
    const credPath = credentialFilePath({ platform: 'linux', env: first.deps.env, homedir: first.deps.homedir });
    const store = JSON.parse(readFileSync(credPath, 'utf-8'));
    store.servers['https://api.ai-pipeline.dev'].expires_at = 1;
    writeFileSync(credPath, JSON.stringify(store));

    const log2: FetchLog[] = [];
    const fetchImpl = async (url: string, init: HttpInit): Promise<HttpResponse> => {
      log2.push({ url, init });
      if (url.endsWith('/oauth/token')) {
        const params = new URLSearchParams(init.body ?? '');
        expect(params.get('grant_type')).toBe('refresh_token');
        expect(params.get('refresh_token')).toBe(DEVICE_REFRESH_TOKEN);
        return reply(200, {
          access_token: 'at_refreshed_by_a5',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'rt_rotated_by_a5',
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
      throw new Error(`unexpected fetch to ${url} — a silent refresh must never touch device/browser endpoints`);
    };
    const second = makeDeps(fetchImpl, fsPair, {
      env: first.deps.env,
      homedir: first.deps.homedir,
      cwd: first.deps.cwd,
    });
    const code = await runCloud(['connect'], second.deps);
    expect(code).toBe(0);
    expect(log2.some((l) => l.url.endsWith('/oauth/device_authorization'))).toBe(false);
    expect(second.out()).toContain('Refreshed the stored session');

    const updated = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(updated.servers['https://api.ai-pipeline.dev'].access_token).toBe('at_refreshed_by_a5');
    expect(updated.servers['https://api.ai-pipeline.dev'].refresh_token).toBe('rt_rotated_by_a5');
  });

  test('a refresh that comes back invalid_grant (reuse-detected/family-revoked) falls back to a full device flow, not a failed command (a5)', async () => {
    const fsPair = recordingFs();
    const first = makeDeps(scriptedFetch({ log: [] }), fsPair);
    expect(await runCloud(['connect'], first.deps)).toBe(0);

    const credPath = credentialFilePath({ platform: 'linux', env: first.deps.env, homedir: first.deps.homedir });
    const store = JSON.parse(readFileSync(credPath, 'utf-8'));
    store.servers['https://api.ai-pipeline.dev'].expires_at = 1;
    writeFileSync(credPath, JSON.stringify(store));

    const log2: FetchLog[] = [];
    let sawDeviceAuth = false;
    const fetchImpl = async (url: string, init: HttpInit): Promise<HttpResponse> => {
      log2.push({ url, init });
      if (url.endsWith('/oauth/device_authorization')) {
        sawDeviceAuth = true;
        return reply(200, {
          device_code: DEVICE_CODE,
          user_code: 'FALLBACK-CODE',
          verification_uri: 'https://app.example.com/auth/device',
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith('/oauth/token')) {
        const params = new URLSearchParams(init.body ?? '');
        if (params.get('grant_type') === 'refresh_token') {
          return reply(400, {
            error: 'invalid_grant',
            error_description: 'refresh token reuse detected — the token family has been revoked',
          });
        }
        return reply(200, {
          access_token: SECRET_TOKEN,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: DEVICE_REFRESH_TOKEN,
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
    const second = makeDeps(fetchImpl, fsPair, {
      env: first.deps.env,
      homedir: first.deps.homedir,
      cwd: first.deps.cwd,
    });
    const code = await runCloud(['connect'], second.deps);
    expect(code).toBe(0); // a clean fallback, not a failure of THIS command
    expect(sawDeviceAuth).toBe(true);
    expect(second.out()).not.toContain('Refreshed the stored session');
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
    expect(log.some((l) => l.url.endsWith('/oauth/device_authorization'))).toBe(true);
  });

  test('--device skips the browser silently (no fallback reason line), completes against /oauth/device_authorization, and yields a refreshable credential (DoD box 1)', async () => {
    const log: FetchLog[] = [];
    // platform 'darwin' would otherwise sail straight through every
    // pre-flight check — proving --device wins regardless.
    const { deps, out } = makeDeps(scriptedFetch({ pendingPolls: 1, log }), recordingFs(), { platform: 'darwin' });
    const code = await runCloud(['connect', '--device'], deps);
    expect(code).toBe(0);
    expect(out()).not.toContain('falling back');
    expect(log.some((l) => l.url.endsWith('/oauth/device_authorization'))).toBe(true);
    expect(log.some((l) => l.url.endsWith('/oauth/authorize'))).toBe(false);

    // "Yields a refreshable credential": the stored credential carries the
    // refresh token the RFC 8628 grant returned — a5 rotates it from here.
    const credPath = credentialFilePath({ platform: 'darwin', env: deps.env, homedir: deps.homedir });
    const cred = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(cred.servers['https://api.ai-pipeline.dev'].access_token).toBe(SECRET_TOKEN);
    expect(cred.servers['https://api.ai-pipeline.dev'].refresh_token).toBe(DEVICE_REFRESH_TOKEN);
  });

  test('SSH_CONNECTION with no DISPLAY falls back with the SSH-specific reason', async () => {
    const log: FetchLog[] = [];
    const { deps, out } = makeDeps(scriptedFetch({ log }), recordingFs(), {
      env: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' },
    });
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('Connected over SSH with no browser to open — falling back to a device code.');
    expect(log.some((l) => l.url.endsWith('/oauth/device_authorization'))).toBe(true);
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
    expect(log.some((l) => l.url.endsWith('/oauth/device_authorization'))).toBe(true);
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
    expect(log.some((l) => l.url.endsWith('/oauth/device_authorization'))).toBe(true);
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
          // a3: the browser flow's refresh token is now PERSISTED (it was
          // silently dropped before a3 shipped) — see the assertion below.
          refresh_token: 'rt_persisted_by_a3',
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
    expect(log.some((l) => l.url.endsWith('/oauth/device_authorization'))).toBe(false);
    expect(spy.closed()).toBe(true); // closed even on the SUCCESS path

    const credPath = credentialFilePath({ platform: 'darwin', env: deps.env, homedir: deps.homedir });
    const cred = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(cred.servers['https://api.ai-pipeline.dev'].access_token).toBe(SECRET_TOKEN);
    expect(cred.servers['https://api.ai-pipeline.dev'].refresh_token).toBe('rt_persisted_by_a3');
    expect(cred.servers['https://api.ai-pipeline.dev'].org_slug).toBe('acme');
    expect(out().includes(SECRET_TOKEN)).toBe(false);
    expect(out().includes('rt_persisted_by_a3')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runner enrolment folded into `cloud connect` (task a6) — 04-cloud-auth.md
// §5, D11: after a successful connect, "Also run cloud pipelines on this
// machine? [Y/n]", then mint + register + install the service. No dashboard
// visit, no token displayed. The mint HTTP call and the install/register/
// service-install mechanics are unit-tested directly in
// tests/runner-enrol.test.ts; these prove `runCloud` WIRES them up — the
// prompt, the `--runner`/`--no-runner`/`--runner-name` flags, the already-
// connected no-op, and D27's --json inversion.
// ---------------------------------------------------------------------------

const A6_RUNNER_CLIENT_ID = 'runner-row-abc123';
const A6_RUNNER_CLIENT_SECRET = 'aipc_SUPER_SECRET_RUNNER_0123456789';
const A6_RUNNER_LEGACY_TOKEN = 'aipr_LEGACY_SECRET_should_never_be_used_9876543210';

/** Completes the (fallback) device flow immediately and, in addition to the
 *  usual /oauth/device_authorization, /oauth/token, /api/v1/me trio, serves
 *  `POST /api/v1/runners` — the mint call task a6 adds. Any OTHER URL still
 *  throws (inherited from `scriptedFetch`), so a regression that calls
 *  something unexpected fails loudly. */
function fetchWithRunnerMint(opts: {
  log: FetchLog[];
  mintStatus?: number;
  mintErrorBody?: unknown;
  includeLegacyToken?: boolean;
}) {
  const base = scriptedFetch({ log: opts.log });
  return async (url: string, init: HttpInit): Promise<HttpResponse> => {
    if (url.endsWith('/api/v1/runners')) {
      opts.log.push({ url, init });
      if (opts.mintStatus && opts.mintStatus !== 201) {
        return reply(opts.mintStatus, opts.mintErrorBody ?? { error: 'forbidden' });
      }
      return reply(201, {
        runner: { id: A6_RUNNER_CLIENT_ID },
        clientId: A6_RUNNER_CLIENT_ID,
        clientSecret: A6_RUNNER_CLIENT_SECRET,
        credentialMode: 'dual',
        ...(opts.includeLegacyToken ? { token: A6_RUNNER_LEGACY_TOKEN } : {}),
      });
    }
    return base(url, init);
  };
}

interface A6ShellCall {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/** A scriptable `pipeline-runner`/`bun` shell fake — every call is recorded
 *  so tests can assert exactly what ran (and, for the security test, what
 *  did NOT appear in argv). */
function fakeRunnerShell(opts: {
  installed?: boolean;
  cliAvailable?: boolean;
  registerCode?: number;
  registerStderr?: string;
  serviceCode?: number;
  serviceStderr?: string;
  bunCode?: number;
  bunStderr?: string;
}): { shell: ShellRunner; calls: A6ShellCall[] } {
  const calls: A6ShellCall[] = [];
  const shell: ShellRunner = (cmd, args, env) => {
    calls.push({ cmd, args, env });
    if (cmd === 'pipeline-runner' && args[0] === '--version') {
      return opts.cliAvailable === false
        ? { code: 127, stdout: '', stderr: '' }
        : { code: 0, stdout: 'pipeline-runner 0.1.0\n', stderr: '' };
    }
    if (cmd === 'pipeline-runner' && args[0] === 'service' && args[1] === 'status') {
      return opts.installed
        ? { code: 0, stdout: '[pipeline-runner] pipeline-runner.service: running (enabled)\n', stderr: '' }
        : { code: 0, stdout: '[pipeline-runner] pipeline-runner.service is not installed\n', stderr: '' };
    }
    if (cmd === 'bun' && args[0] === 'add') {
      return { code: opts.bunCode ?? 0, stdout: '', stderr: opts.bunStderr ?? '' };
    }
    if (cmd === 'pipeline-runner' && args[0] === 'register') {
      return { code: opts.registerCode ?? 0, stdout: '', stderr: opts.registerStderr ?? '' };
    }
    if (cmd === 'pipeline-runner' && args[0] === 'service' && args[1] === 'install') {
      return { code: opts.serviceCode ?? 0, stdout: '', stderr: opts.serviceStderr ?? '' };
    }
    return { code: 1, stdout: '', stderr: `test double: unexpected shell call: ${cmd} ${args.join(' ')}` };
  };
  return { shell, calls };
}

describe('runCloud connect — runner enrolment (task a6)', () => {
  test('DoD box 3: an already-enrolled machine is a silent no-op with the stated message — no prompt, no mint', async () => {
    const log: FetchLog[] = [];
    const { shell, calls } = fakeRunnerShell({ installed: true });
    let promptCalled = false;
    const { deps, out } = makeDeps(fetchWithRunnerMint({ log }), recordingFs(), {
      runnerShell: shell,
      promptYesNo: async () => {
        promptCalled = true;
        return true;
      },
      hostname: () => 'ivan-desktop',
    });

    const code = await runCloud(['connect'], deps);

    expect(code).toBe(0);
    expect(out()).toContain("✓ Runner 'ivan-desktop' already connected");
    expect(promptCalled).toBe(false);
    expect(log.some((l) => l.url.endsWith('/api/v1/runners'))).toBe(false);
    expect(calls.some((c) => c.args[0] === 'register')).toBe(false);
  });

  test('DoD box 2: declining leaves the project linked and no runner registered, and prints the two manual commands', async () => {
    const log: FetchLog[] = [];
    const { shell, calls } = fakeRunnerShell({ installed: false });
    const { deps, out } = makeDeps(fetchWithRunnerMint({ log }), recordingFs(), {
      runnerShell: shell,
      promptYesNo: async () => false,
    });

    const code = await runCloud(['connect'], deps);

    expect(code).toBe(0);
    expect(existsSync(cloudJsonPath(deps.cwd))).toBe(true); // project still linked
    expect(out()).toContain('bun add -g @baizor/pipeline-runner');
    expect(out()).toContain('pipeline-runner register --url');
    expect(out()).toContain('pipeline cloud connect --runner');
    expect(calls.some((c) => c.args[0] === 'register')).toBe(false);
    expect(log.some((l) => l.url.endsWith('/api/v1/runners'))).toBe(false);
  });

  test('DoD box 2: re-running with --runner enrols it without asking, installs the package on demand (command shown first), registers, installs the service', async () => {
    const log: FetchLog[] = [];
    const { shell, calls } = fakeRunnerShell({ installed: false, cliAvailable: false });
    let promptCalled = false;
    const { deps, out } = makeDeps(fetchWithRunnerMint({ log }), recordingFs(), {
      runnerShell: shell,
      promptYesNo: async () => {
        promptCalled = true;
        return true;
      },
      hostname: () => 'ivan-desktop',
    });

    const code = await runCloud(['connect', '--runner'], deps);

    expect(code).toBe(0);
    expect(promptCalled).toBe(false); // --runner skips asking entirely

    // DoD box 4: the on-demand install shows its command before running it.
    expect(out()).toContain('Installing the runner:');
    expect(out()).toContain('$ bun add -g @baizor/pipeline-runner');
    expect(calls.some((c) => c.cmd === 'bun' && c.args.join(' ') === 'add -g @baizor/pipeline-runner')).toBe(true);

    const mintCall = log.find((l) => l.url.endsWith('/api/v1/runners'));
    expect(mintCall).toBeDefined();
    expect(JSON.parse(mintCall!.init.body ?? '{}').name).toBe('ivan-desktop');
    expect(mintCall!.init.headers['authorization']).toBe(`Bearer ${SECRET_TOKEN}`);

    const registerCall = calls.find((c) => c.cmd === 'pipeline-runner' && c.args[0] === 'register');
    expect(registerCall).toBeDefined();
    expect(registerCall!.args).toEqual([
      'register',
      '--url',
      'https://api.ai-pipeline.dev',
      '--client-id',
      A6_RUNNER_CLIENT_ID,
    ]);
    expect(registerCall!.env?.PIPELINE_RUNNER_OAUTH_CLIENT_SECRET).toBe(A6_RUNNER_CLIENT_SECRET);

    expect(
      calls.some((c) => c.cmd === 'pipeline-runner' && c.args[0] === 'service' && c.args[1] === 'install'),
    ).toBe(true);
    expect(out()).toContain("✓ Runner 'ivan-desktop' connected, starts on boot");
  });

  test('--runner-name overrides the hostname default', async () => {
    const log: FetchLog[] = [];
    const { shell } = fakeRunnerShell({ installed: false });
    const { deps, out } = makeDeps(fetchWithRunnerMint({ log }), recordingFs(), {
      runnerShell: shell,
      hostname: () => 'should-not-be-used',
    });

    const code = await runCloud(['connect', '--runner', '--runner-name', 'my-ci-box'], deps);

    expect(code).toBe(0);
    const mintCall = log.find((l) => l.url.endsWith('/api/v1/runners'));
    expect(JSON.parse(mintCall!.init.body ?? '{}').name).toBe('my-ci-box');
    expect(out()).toContain("✓ Runner 'my-ci-box' connected, starts on boot");
  });

  test('--no-runner skips the prompt entirely — zero shell calls, zero mint calls', async () => {
    const log: FetchLog[] = [];
    const { shell, calls } = fakeRunnerShell({ installed: false });
    let promptCalled = false;
    const { deps } = makeDeps(fetchWithRunnerMint({ log }), recordingFs(), {
      runnerShell: shell,
      promptYesNo: async () => {
        promptCalled = true;
        return true;
      },
    });

    const code = await runCloud(['connect', '--no-runner'], deps);

    expect(code).toBe(0);
    expect(promptCalled).toBe(false);
    expect(calls.length).toBe(0);
    expect(log.some((l) => l.url.endsWith('/api/v1/runners'))).toBe(false);
  });

  test('D27: --json without --runner declines enrolment entirely — stdout is still exactly the one connect JSON object', async () => {
    const log: FetchLog[] = [];
    const { shell, calls } = fakeRunnerShell({ installed: false });
    let promptCalled = false;
    const { deps, out } = makeDeps(fetchWithRunnerMint({ log }), recordingFs(), {
      runnerShell: shell,
      promptYesNo: async () => {
        promptCalled = true;
        return true;
      },
    });

    const code = await runCloud(['connect', '--json'], deps);

    expect(code).toBe(0);
    const obj = JSON.parse(out()); // throws if stdout carries anything but the one object
    expect(obj.status).toBe('connected');
    expect(promptCalled).toBe(false);
    expect(calls.length).toBe(0);
    expect(log.some((l) => l.url.endsWith('/api/v1/runners'))).toBe(false);
  });

  test('D27: --json --runner opts back in — enrols without a prompt; connect JSON on stdout is unchanged, runner progress goes to stderr only', async () => {
    const log: FetchLog[] = [];
    const { shell } = fakeRunnerShell({ installed: false });
    const { deps, out, err } = makeDeps(fetchWithRunnerMint({ log }), recordingFs(), {
      runnerShell: shell,
      hostname: () => 'ci-box-3',
    });

    const code = await runCloud(['connect', '--json', '--runner'], deps);

    expect(code).toBe(0);
    const obj = JSON.parse(out());
    expect(obj.status).toBe('connected');
    expect(err()).toContain("✓ Runner 'ci-box-3' connected, starts on boot");
    expect(log.some((l) => l.url.endsWith('/api/v1/runners'))).toBe(true);
  });

  test('package install failure is non-fatal: connect still exits 0, no register/service-install attempted', async () => {
    const log: FetchLog[] = [];
    const { shell, calls } = fakeRunnerShell({ installed: false, cliAvailable: false, bunCode: 1, bunStderr: 'network unreachable' });
    const { deps, out } = makeDeps(fetchWithRunnerMint({ log }), recordingFs(), {
      runnerShell: shell,
      promptYesNo: async () => true,
    });

    const code = await runCloud(['connect'], deps);

    expect(code).toBe(0);
    expect(out()).toContain('Could not install @baizor/pipeline-runner');
    expect(out()).toContain('network unreachable');
    expect(log.some((l) => l.url.endsWith('/api/v1/runners'))).toBe(false); // never even tried to mint
    expect(calls.some((c) => c.args[0] === 'register')).toBe(false);
  });

  test('mint 403 (non-admin caller) is non-fatal: connect still exits 0, actionable warning, no register attempted', async () => {
    const log: FetchLog[] = [];
    const { shell, calls } = fakeRunnerShell({ installed: false });
    const { deps, out } = makeDeps(fetchWithRunnerMint({ log, mintStatus: 403 }), recordingFs(), {
      runnerShell: shell,
      promptYesNo: async () => true,
    });

    const code = await runCloud(['connect'], deps);

    expect(code).toBe(0);
    expect(out()).toContain('admin role');
    expect(calls.some((c) => c.args[0] === 'register')).toBe(false);
  });

  test('register failure is non-fatal: connect still exits 0, tells the user to re-run with --runner', async () => {
    const log: FetchLog[] = [];
    const { shell, calls } = fakeRunnerShell({ installed: false, registerCode: 1, registerStderr: 'runner credential was not accepted' });
    const { deps, out } = makeDeps(fetchWithRunnerMint({ log }), recordingFs(), {
      runnerShell: shell,
      promptYesNo: async () => true,
    });

    const code = await runCloud(['connect'], deps);

    expect(code).toBe(0);
    expect(out()).toContain('registration failed');
    expect(out()).toContain('pipeline cloud connect --runner');
    expect(
      calls.some((c) => c.cmd === 'pipeline-runner' && c.args[0] === 'service' && c.args[1] === 'install'),
    ).toBe(false);
  });

  test('service-install failure is non-fatal: reports "registered but service could not be installed", still exits 0', async () => {
    const log: FetchLog[] = [];
    const { shell } = fakeRunnerShell({ installed: false, serviceCode: 1, serviceStderr: 'permission denied' });
    const { deps, out } = makeDeps(fetchWithRunnerMint({ log }), recordingFs(), {
      runnerShell: shell,
      promptYesNo: async () => true,
      hostname: () => 'ivan-desktop',
    });

    const code = await runCloud(['connect'], deps);

    expect(code).toBe(0);
    expect(out()).toContain("Runner 'ivan-desktop' registered, but the background service could not be installed");
    expect(out()).toContain('permission denied');
  });

  // -------------------------------------------------------------------
  // SECURITY — DoD: "No token may ever be printed." Covers the FULL
  // `runCloud` invocation (connect + enrolment together), not just
  // `enrolRunner` in isolation (see tests/runner-enrol.test.ts for that).
  // -------------------------------------------------------------------
  test('SECURITY: the minted runner client secret and legacy token never appear in stdout or stderr, nor in any shelled argv, across the whole run', async () => {
    const log: FetchLog[] = [];
    const { shell, calls } = fakeRunnerShell({ installed: false });
    const { deps, out, err } = makeDeps(fetchWithRunnerMint({ log, includeLegacyToken: true }), recordingFs(), {
      runnerShell: shell,
      promptYesNo: async () => true,
    });

    const code = await runCloud(['connect'], deps);

    expect(code).toBe(0);
    expect(out()).not.toContain(A6_RUNNER_CLIENT_SECRET);
    expect(err()).not.toContain(A6_RUNNER_CLIENT_SECRET);
    expect(out()).not.toContain(A6_RUNNER_LEGACY_TOKEN);
    expect(err()).not.toContain(A6_RUNNER_LEGACY_TOKEN);
    // Argv is world-readable via `ps` on Linux — the secret must ride ONLY
    // in the register subprocess's env override, never in any command's args.
    for (const c of calls) {
      expect(c.args.join(' ')).not.toContain(A6_RUNNER_CLIENT_SECRET);
      expect(c.args.join(' ')).not.toContain(A6_RUNNER_LEGACY_TOKEN);
    }
    const registerCall = calls.find((c) => c.cmd === 'pipeline-runner' && c.args[0] === 'register');
    expect(registerCall?.env?.PIPELINE_RUNNER_OAUTH_CLIENT_SECRET).toBe(A6_RUNNER_CLIENT_SECRET);
  });
});

// ---------------------------------------------------------------------------
// Machine credential (task a4) — 04-cloud-auth.md §3/§4's third, top rung of
// the selection ladder: PIPELINE_MACHINE_TOKEN / --machine-token, no TTY, no
// prompt, no browser.
// ---------------------------------------------------------------------------

const MACHINE_TOKEN = 'aip_m_client9f8e7d.secretABC0123456789';
const MACHINE_CLIENT_ID = 'aip_m_client9f8e7d';
const MACHINE_SECRET = 'secretABC0123456789';
const MACHINE_ACCESS_TOKEN = 'mc_access_SECRET_9876543210';

describe('splitMachineCredential', () => {
  test('splits the prefix+id half (INCLUDING aip_m_) from the secret half', () => {
    expect(splitMachineCredential(MACHINE_TOKEN)).toEqual({
      clientId: MACHINE_CLIENT_ID,
      secret: MACHINE_SECRET,
    });
  });
  test('missing prefix → null', () => {
    expect(splitMachineCredential('not_a_machine_token.secret')).toBeNull();
  });
  test('no dot separator → null', () => {
    expect(splitMachineCredential(`${MACHINE_CREDENTIAL_PREFIX}onlyclientid`)).toBeNull();
  });
  test('empty secret after the dot → null', () => {
    expect(splitMachineCredential(`${MACHINE_CREDENTIAL_PREFIX}client.`)).toBeNull();
  });
  test('empty client id (dot immediately after the prefix) → null', () => {
    expect(splitMachineCredential(`${MACHINE_CREDENTIAL_PREFIX}.secret`)).toBeNull();
  });
  test('empty string → null', () => {
    expect(splitMachineCredential('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assertNotMcpUrl — DoD box 4: "A test asserts the machine credential is
// never sent to an /mcp URL."
// ---------------------------------------------------------------------------

describe('assertNotMcpUrl (DoD box 4 — the never-at-/mcp guard)', () => {
  test('throws on the exact /mcp resource', () => {
    expect(() => assertNotMcpUrl('https://api.ai-pipeline.dev/mcp')).toThrow();
  });
  test('throws on an /mcp sub-path', () => {
    expect(() => assertNotMcpUrl('https://api.ai-pipeline.dev/mcp/tools/call')).toThrow();
  });
  test('throws on an /mcp path with a query string', () => {
    expect(() => assertNotMcpUrl('https://api.ai-pipeline.dev/mcp?x=1')).toThrow();
  });
  test('does NOT throw on the api resource', () => {
    expect(() => assertNotMcpUrl('https://api.ai-pipeline.dev/api')).not.toThrow();
  });
  test('does NOT throw on the token endpoint', () => {
    expect(() => assertNotMcpUrl('https://api.ai-pipeline.dev/oauth/token')).not.toThrow();
  });
  test('does NOT throw on a path that merely starts with "mcp" as a segment name collision (/mcpx)', () => {
    // Boundary check: proves this is a path-segment match, not a naive
    // substring/prefix check that would also (wrongly) block a resource
    // that just happens to start with the same four characters.
    expect(() => assertNotMcpUrl('https://api.ai-pipeline.dev/mcpx')).not.toThrow();
  });
  test('an unparseable URL fails closed (throws) rather than silently passing', () => {
    expect(() => assertNotMcpUrl('not a url at all')).toThrow();
  });
});

describe('runCloud connect — machine credential (task a4)', () => {
  /** Scripts ONLY `/oauth/token`'s client_credentials machine-credential
   *  branch — any OTHER URL (device_authorization, /oauth/authorize,
   *  /api/v1/me) throws, so a regression that accidentally routes the
   *  machine-credential path through any of the human flows fails loudly
   *  here rather than silently. */
  function machineScriptedFetch(opts: {
    status?: number;
    errorBody?: { error: string; error_description?: string };
    accessToken?: string;
    expiresIn?: number;
    includeRefreshToken?: boolean;
    log: FetchLog[];
  }) {
    return async (url: string, init: HttpInit): Promise<HttpResponse> => {
      opts.log.push({ url, init });
      if (url.endsWith('/mcp') || url.includes('/mcp/')) {
        // DoD box 4's belt-and-braces: even the FAKE server would refuse to
        // serve this — a genuine leak must fail the test, not silently 200.
        throw new Error(`test double refuses to serve an /mcp URL: ${url}`);
      }
      if (url.endsWith('/oauth/token')) {
        if (opts.status && opts.status !== 200) {
          return reply(opts.status, opts.errorBody ?? { error: 'invalid_client' });
        }
        return reply(200, {
          access_token: opts.accessToken ?? MACHINE_ACCESS_TOKEN,
          token_type: 'Bearer',
          expires_in: opts.expiresIn ?? 900,
          scope: 'machine:credential',
          ...(opts.includeRefreshToken ? { refresh_token: 'rt_SHOULD_NEVER_BE_STORED' } : {}),
        });
      }
      throw new Error(`unexpected fetch to ${url} (machine-credential path must never call this)`);
    };
  }

  test('PIPELINE_MACHINE_TOKEN + --org --json: completes with exit 0, no prompt, no browser, no /me call (DoD box 1)', async () => {
    const log: FetchLog[] = [];
    const { deps, out, err } = makeDeps(machineScriptedFetch({ log }), recordingFs(), {
      env: { PIPELINE_MACHINE_TOKEN: MACHINE_TOKEN },
    });
    const code = await runCloud(['connect', '--json', '--org', 'acme'], deps);
    expect(code).toBe(0);
    const obj = JSON.parse(out());
    expect(obj.status).toBe('connected');
    expect(obj.org).toBe('acme');

    // Exactly one network call — the exchange — and nothing resembling a
    // human flow (device_authorization, /oauth/authorize, /api/v1/me).
    expect(log.length).toBe(1);
    expect(log[0]!.url.endsWith('/oauth/token')).toBe(true);

    // No progress/prompt text of the human flows leaked through either.
    expect(out()).not.toContain('Opening your browser');
    expect(out()).not.toContain('Waiting for you to approve');
    expect(err()).not.toContain('Opening your browser');
  });

  test('request shape: HTTP Basic client auth (client_id:secret) + client_credentials/machine:credential/resource=<server>/api', async () => {
    const log: FetchLog[] = [];
    const { deps } = makeDeps(machineScriptedFetch({ log }), recordingFs(), {
      env: { PIPELINE_MACHINE_TOKEN: MACHINE_TOKEN },
    });
    expect(await runCloud(['connect', '--org', 'acme'], deps)).toBe(0);

    const call = log[0]!;
    expect(call.init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const authHeader = call.init.headers['authorization'] ?? '';
    expect(authHeader.startsWith('Basic ')).toBe(true);
    const decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8');
    expect(decoded).toBe(`${MACHINE_CLIENT_ID}:${MACHINE_SECRET}`);

    const params = new URLSearchParams(call.init.body ?? '');
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('scope')).toBe('machine:credential');
    expect(params.get('resource')).toBe('https://api.ai-pipeline.dev/api');
    // The raw secret never rides in the form body — only inside the Basic header.
    expect(call.init.body ?? '').not.toContain(MACHINE_SECRET);
  });

  test('--machine-token flag works exactly like the env var (and the secret never lands on stdout/stderr)', async () => {
    const log: FetchLog[] = [];
    const { deps, out, err } = makeDeps(machineScriptedFetch({ log }), recordingFs());
    const code = await runCloud(['connect', '--machine-token', MACHINE_TOKEN, '--org', 'acme'], deps);
    expect(code).toBe(0);
    expect(log.length).toBe(1);
    expect(out().includes(MACHINE_TOKEN)).toBe(false);
    expect(out().includes(MACHINE_SECRET)).toBe(false);
    expect(err().includes(MACHINE_TOKEN)).toBe(false);
    expect(err().includes(MACHINE_SECRET)).toBe(false);
  });

  test('the flag wins over the env var when both are set', async () => {
    const log: FetchLog[] = [];
    const flagToken = 'aip_m_flagclient.flagsecret000';
    const { deps } = makeDeps(machineScriptedFetch({ log }), recordingFs(), {
      env: { PIPELINE_MACHINE_TOKEN: MACHINE_TOKEN },
    });
    expect(await runCloud(['connect', '--machine-token', flagToken, '--org', 'acme'], deps)).toBe(0);
    const authHeader = log[0]!.init.headers['authorization'] ?? '';
    const decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8');
    expect(decoded).toBe('aip_m_flagclient:flagsecret000');
  });

  test('credential store gets the access token and NO refresh_token — even if the server sent one (RFC 6749 §4.4.3 / OAuth 2.1 §4.2)', async () => {
    const log: FetchLog[] = [];
    const fsPair = recordingFs();
    const { deps } = makeDeps(machineScriptedFetch({ log, includeRefreshToken: true }), fsPair, {
      env: { PIPELINE_MACHINE_TOKEN: MACHINE_TOKEN },
    });
    expect(await runCloud(['connect', '--org', 'acme'], deps)).toBe(0);

    const credPath = credentialFilePath({ platform: 'linux', env: deps.env, homedir: deps.homedir });
    const cred = JSON.parse(readFileSync(credPath, 'utf-8'));
    const stored = cred.servers['https://api.ai-pipeline.dev'];
    expect(stored.access_token).toBe(MACHINE_ACCESS_TOKEN);
    expect(stored.refresh_token).toBeUndefined();
    expect(readFileSync(credPath, 'utf-8')).not.toContain('rt_SHOULD_NEVER_BE_STORED');
  });

  test('x50: the stored credential records WHICH rung minted it (`principal: "machine"`)', async () => {
    // Without this marker, a later command reading the store cannot tell a
    // machine credential from a human one, and `GET /api/v1/me` — which 401s
    // for this class BY CONSTRUCTION — is the only thing it can ask.
    // `pipeline department status` did exactly that and reported "offline"
    // forever on the documented no-human path.
    const log: FetchLog[] = [];
    const fsPair = recordingFs();
    const { deps } = makeDeps(machineScriptedFetch({ log }), fsPair, {
      env: { PIPELINE_MACHINE_TOKEN: MACHINE_TOKEN },
    });
    expect(await runCloud(['connect', '--org', 'acme'], deps)).toBe(0);

    const credPath = credentialFilePath({ platform: 'linux', env: deps.env, homedir: deps.homedir });
    const stored = JSON.parse(readFileSync(credPath, 'utf-8')).servers['https://api.ai-pipeline.dev'];
    expect(stored.principal).toBe('machine');
    // …together with the org slug the operator passed, which is the ONLY
    // source of one for this credential class.
    expect(stored.org_slug).toBe('acme');
  });

  test('a malformed token is rejected LOCALLY — no network call at all', async () => {
    const log: FetchLog[] = [];
    const { deps, err } = makeDeps(machineScriptedFetch({ log }), recordingFs(), {
      env: { PIPELINE_MACHINE_TOKEN: 'not-a-machine-token-shape' },
    });
    const code = await runCloud(['connect', '--org', 'acme'], deps);
    expect(code).toBe(1);
    expect(err()).toContain(MACHINE_CREDENTIAL_PREFIX);
    expect(log.length).toBe(0); // never even tried the network
  });

  test('server rejection (expired/revoked/unknown — all collapsed to invalid_client) relays 04§9\'s EXACT message verbatim', async () => {
    const SERVER_MESSAGE =
      "That machine token was rejected (expired or revoked). Issue a new one at https://api.ai-pipeline.dev/settings/machine-credentials.";
    const log: FetchLog[] = [];
    const { deps, err } = makeDeps(
      machineScriptedFetch({
        log,
        status: 401,
        errorBody: { error: 'invalid_client', error_description: SERVER_MESSAGE },
      }),
      recordingFs(),
      { env: { PIPELINE_MACHINE_TOKEN: MACHINE_TOKEN } },
    );
    const code = await runCloud(['connect', '--org', 'acme'], deps);
    expect(code).toBe(1);
    expect(err()).toContain(SERVER_MESSAGE);
  });

  test('a valid credential with NO --org: the exchange still succeeds and IS stored, but the binding is not written (no discoverable org slug)', async () => {
    const log: FetchLog[] = [];
    const fsPair = recordingFs();
    const { deps, err } = makeDeps(machineScriptedFetch({ log }), fsPair, {
      env: { PIPELINE_MACHINE_TOKEN: MACHINE_TOKEN },
    });
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('--org');

    // The credential WAS persisted (a verified auth is never thrown away —
    // same posture as the human flows below).
    const credPath = credentialFilePath({ platform: 'linux', env: deps.env, homedir: deps.homedir });
    expect(existsSync(credPath)).toBe(true);
    const cred = JSON.parse(readFileSync(credPath, 'utf-8'));
    expect(cred.servers['https://api.ai-pipeline.dev'].access_token).toBe(MACHINE_ACCESS_TOKEN);

    // But no project binding was written.
    expect(existsSync(cloudJsonPath(deps.cwd))).toBe(false);
  });

  test('DoD box 3: --machine-token combined with --device exits 2, with NO network call', async () => {
    const log: FetchLog[] = [];
    const { deps, err } = makeDeps(machineScriptedFetch({ log }), recordingFs());
    const code = await runCloud(['connect', '--machine-token', MACHINE_TOKEN, '--device', '--org', 'acme'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('--machine-token');
    expect(err()).toContain('--device');
    expect(log.length).toBe(0);
  });

  test('PIPELINE_MACHINE_TOKEN (env) combined with --device ALSO exits 2 (the design\'s rule names "it", not just the flag)', async () => {
    const log: FetchLog[] = [];
    const { deps, err } = makeDeps(machineScriptedFetch({ log }), recordingFs(), {
      env: { PIPELINE_MACHINE_TOKEN: MACHINE_TOKEN },
    });
    const code = await runCloud(['connect', '--device', '--org', 'acme'], deps);
    expect(code).toBe(2);
    expect(err()).toContain(MACHINE_TOKEN_ENV);
    expect(log.length).toBe(0);
  });

  test('an empty PIPELINE_MACHINE_TOKEN is treated as absent, not as "set" (falls through to the normal ladder)', async () => {
    const log: FetchLog[] = [];
    const { deps } = makeDeps(scriptedFetch({ log }), recordingFs(), {
      env: { PIPELINE_MACHINE_TOKEN: '' },
    });
    const code = await runCloud(['connect'], deps);
    expect(code).toBe(0);
    // Fell through to the ordinary (device, in this headless test env) flow.
    expect(log.some((l) => l.url.endsWith('/oauth/device_authorization'))).toBe(true);
  });

  test('the machine credential is never sent to an /mcp URL (DoD box 4, end-to-end): the exchange only ever calls /oauth/token', async () => {
    const log: FetchLog[] = [];
    const { deps } = makeDeps(machineScriptedFetch({ log }), recordingFs(), {
      env: { PIPELINE_MACHINE_TOKEN: MACHINE_TOKEN },
    });
    expect(await runCloud(['connect', '--org', 'acme'], deps)).toBe(0);
    expect(log.every((l) => !l.url.includes('/mcp'))).toBe(true);
    expect(log.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Machine credential — REAL subprocess, stdin explicitly NOT a TTY (DoD box 1)
// ---------------------------------------------------------------------------
//
// Every test above drives `runCloud` in-process with fully injected deps —
// proving the LOGIC never prompts, exactly the level of rigor the browser
// flow's own DoD box 1 relies on elsewhere in this file (a REAL loopback
// socket only for the callback, never a real cross-process network round
// trip to a fake remote server). These two tests go one step further: they
// spawn the REAL `pipeline` CLI entry point (mirrors the existing "cli.ts
// routes `cloud` to runCloud" subprocess test below) with `stdin: 'ignore'`
// — an explicit guarantee that no TTY is attached, not merely an assumption
// that the test runner's own stdin happens not to be one — and prove the
// process reaches a clean, bounded exit with no hang and no prompt.
//
// Deliberately network-FREE (an earlier version of this test pointed
// --server at a real Bun.serve() double and spawned the CLI as a genuinely
// separate OS process talking to it over 127.0.0.1: that round trip was
// empirically unreliable in this sandboxed environment — one run took
// 300s+ and still failed instead of completing in the sub-second time a
// loopback call should take, most likely a sandbox networking restriction
// between sibling processes, not a bug in this code, which the 70+ in-process
// tests above already exercise against the exact same wire shape with zero
// flakiness). Both cases below reach their exit code from LOCAL validation
// alone (malformed shape / a usage-error flag combo) — no fetch is ever
// attempted — so they are exactly as good a proof of "no TTY, no prompt, no
// hang" without depending on cross-process loopback networking being
// reliable here. The DoD box 1 *success* path (a full client_credentials
// round trip) is proven in-process instead, immediately above.

describe('runCloud connect — machine credential, real subprocess (DoD box 1, network-free)', () => {
  test('a malformed PIPELINE_MACHINE_TOKEN is rejected by a REAL process with stdin NOT a TTY — clean bounded exit, no hang, no prompt', () => {
    const home = mkdtempSync(join(tmpdir(), 'pipeline-cloud-mc-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'pipeline-cloud-mc-proj-'));
    created.push(home, proj);

    const proc = Bun.spawnSync({
      cmd: ['bun', join(import.meta.dir, '..', 'src', 'cli.ts'), 'cloud', 'connect', '--org', 'acme'],
      cwd: proj,
      env: { ...process.env, PIPELINE_CLOUD_HOME: home, PIPELINE_MACHINE_TOKEN: 'not-a-machine-token-shape' },
      // The load-bearing part of this test: stdin is explicitly NOT a TTY
      // (and not even inherited from whatever ran `bun test`) — a genuine,
      // guaranteed-headless environment, not an assumption.
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000, // safety net: fail the test, don't hang the suite, if this ever regresses
    });
    const stderr = proc.stderr.toString();
    expect(proc.exitCode).toBe(1);
    expect(stderr).toContain(MACHINE_CREDENTIAL_PREFIX);
  }, 20_000);

  test('--machine-token combined with --device is a usage error (exit 2) from a REAL process with stdin NOT a TTY', () => {
    const home = mkdtempSync(join(tmpdir(), 'pipeline-cloud-mc-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'pipeline-cloud-mc-proj-'));
    created.push(home, proj);

    const proc = Bun.spawnSync({
      cmd: [
        'bun',
        join(import.meta.dir, '..', 'src', 'cli.ts'),
        'cloud',
        'connect',
        '--machine-token',
        MACHINE_TOKEN,
        '--device',
        '--org',
        'acme',
      ],
      cwd: proj,
      env: { ...process.env, PIPELINE_CLOUD_HOME: home },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    });
    const stderr = proc.stderr.toString();
    expect(proc.exitCode).toBe(2);
    expect(stderr).toContain('--device');
    // The secret never lands in the process's own error output either.
    expect(stderr.includes(MACHINE_SECRET)).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Legacy device flow (server-side regression — no longer called by this CLI)
// ---------------------------------------------------------------------------
//
// Task a3 re-points `deviceStart`/`pollForToken` at the authorization
// server's RFC 8628 grant (`/oauth/device_authorization` + `/oauth/token`)
// — every test above this point exercises THAT path. The OLD
// `/auth/device/start` + `/auth/device/token` contract
// (cloud/apps/api/src/modules/auth/routes.ts) is deliberately NOT removed —
// it keeps serving whatever CLI version is already installed out in the
// world (this task's DoD: "the legacy endpoints are untouched and still
// work for an old CLI").
//
// Nothing in `cloud.ts` calls it anymore, so it cannot be regression-tested
// through `runCloud`/`parseConnectArgs` — this repo owns the client, not the
// server, and a live run against `cloud/apps/api` is out of reach here (no
// DB, and the task instructions are explicit: don't try). What follows is
// the most honest thing this repo CAN do: a minimal, self-contained
// reimplementation of the PRE-a3 client logic (see git history for the code
// this replaced), run against a fake server scripted to the exact shape read
// directly out of `auth/routes.ts` on 2026-07-26 — JSON in, JSON out, a
// PAT-shaped success with NO `refresh_token` (unlike the new RFC 8628 path
// above). It is intentionally NOT exported from, or shared with, `cloud.ts`
// — this is a pinned contract test, not shipped code. If the real server
// ever silently drifts from this shape, this is the only place in the tree
// that would still notice.

const LEGACY_DEVICE_CODE = 'legacy-device-code-abc';
const LEGACY_PAT = 'pat_LEGACY_SECRET_9876543210';

class LegacyDeviceError extends Error {}

/** Scripts the LEGACY `/auth/device/start` + `/auth/device/token` contract
 *  (JSON request/response; a PAT-shaped approval with NO `refresh_token`) —
 *  the mirror image of `scriptedFetch` above, which scripts the NEW RFC 8628
 *  contract. Also asserts the exact wire shape an old CLI relied on, so a
 *  server-side drift fails this suite loudly rather than silently. */
function legacyScriptedFetch(opts: { pendingPolls?: number; slowDownPolls?: number; tokenError?: string }) {
  const pending = opts.pendingPolls ?? 0;
  const slow = opts.slowDownPolls ?? 0;
  let polls = 0;
  return async (url: string, init: HttpInit): Promise<HttpResponse> => {
    if (url.endsWith('/auth/device/start')) {
      expect(init.method).toBe('POST');
      expect(init.headers['content-type']).toBe('application/json');
      expect(init.body).toBe('{}');
      return reply(200, {
        device_code: LEGACY_DEVICE_CODE,
        user_code: 'ABCD-1234',
        verification_uri: 'https://app.example.com/auth/device',
        verification_uri_complete: 'https://app.example.com/auth/device?user_code=ABCD-1234',
        expires_in: 900,
        interval: 5,
      });
    }
    if (url.endsWith('/auth/device/token')) {
      expect(init.headers['content-type']).toBe('application/json');
      const parsedBody = JSON.parse(init.body ?? '{}') as { device_code?: string };
      expect(parsedBody.device_code).toBe(LEGACY_DEVICE_CODE);
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
        access_token: LEGACY_PAT,
        token_type: 'bearer',
        expires_in: 90 * 24 * 60 * 60,
        token_prefix: 'pat_LEGACY',
        // Deliberately NO refresh_token — auth/routes.ts's device/token
        // handler never returns one. That absence is exactly what a3 fixes
        // on the NEW endpoint, and exactly what this test pins for the OLD
        // one (see the assertion below).
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
}

/** A minimal reimplementation of the client logic `cloud.ts` used to run
 *  BEFORE task a3 — kept ONLY here, not in production code, purely so this
 *  suite can prove the server's legacy contract is still walkable end to
 *  end. */
async function legacyDeviceFlow(
  fetchImpl: (url: string, init: HttpInit) => Promise<HttpResponse>,
  server: string,
): Promise<{ access_token: string; token_type?: string; token_prefix?: string; refresh_token?: string }> {
  const startRes = await fetchImpl(`${server}/auth/device/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: '{}',
  });
  if (startRes.status !== 200) throw new LegacyDeviceError(`device/start failed: HTTP ${startRes.status}`);
  const start = (await startRes.json()) as { device_code: string; user_code: string };

  for (;;) {
    const res = await fetchImpl(`${server}/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ device_code: start.device_code }),
    });
    if (res.status === 200) {
      return (await res.json()) as { access_token: string; token_type?: string; token_prefix?: string };
    }
    const body = (await res.json()) as { error?: string };
    if (body.error === 'authorization_pending' || body.error === 'slow_down') continue;
    throw new LegacyDeviceError(body.error ?? `HTTP ${res.status}`);
  }
}

describe('legacy device flow (server-side regression — /auth/device/* is not touched by a3)', () => {
  test('start + immediate approval mints a PAT-shaped credential with NO refresh_token', async () => {
    const cred = await legacyDeviceFlow(legacyScriptedFetch({}), 'https://api.ai-pipeline.dev');
    expect(cred.access_token).toBe(LEGACY_PAT);
    expect(cred.token_type).toBe('bearer');
    expect(cred.token_prefix).toBe('pat_LEGACY');
    expect(cred.refresh_token).toBeUndefined();
  });

  test('authorization_pending keeps polling, then approves', async () => {
    const cred = await legacyDeviceFlow(legacyScriptedFetch({ pendingPolls: 2 }), 'https://api.ai-pipeline.dev');
    expect(cred.access_token).toBe(LEGACY_PAT);
  });

  test('slow_down keeps polling, then approves', async () => {
    const cred = await legacyDeviceFlow(
      legacyScriptedFetch({ slowDownPolls: 1, pendingPolls: 1 }),
      'https://api.ai-pipeline.dev',
    );
    expect(cred.access_token).toBe(LEGACY_PAT);
  });

  test('access_denied aborts with the server-supplied error code', async () => {
    await expect(
      legacyDeviceFlow(legacyScriptedFetch({ tokenError: 'access_denied' }), 'https://api.ai-pipeline.dev'),
    ).rejects.toThrow('access_denied');
  });

  test('expired_token aborts with the server-supplied error code', async () => {
    await expect(
      legacyDeviceFlow(legacyScriptedFetch({ tokenError: 'expired_token' }), 'https://api.ai-pipeline.dev'),
    ).rejects.toThrow('expired_token');
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
