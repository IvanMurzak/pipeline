// loopback-oauth.test.ts — the browser authorization_code + PKCE flow's
// low-level pieces, tested in isolation from `pipeline cloud connect`:
//
//   - PKCE/state generation (CSPRNG properties + an RFC 7636 known vector).
//   - The loopback HTTP listener: REAL localhost network I/O (no fake
//     sockets) proving `state` verification, path rejection, the absolute
//     timeout, and — the security-critical property — that the listener is
//     closed on EVERY exit path (a subsequent request to the same
//     redirect_uri is refused once `outcome` has settled).
//   - The browser-opener command builder + exit-code handling.
//   - The pre-flight fallback-trigger decision matrix (04-cloud-auth.md
//     §1.2).
//
// What this file does NOT and cannot prove: an actual OS browser window
// opening, or a real human clicking "Approve" against the production
// authorization server. See cloud.test.ts's browser-flow tests for the
// higher-level, still-fake-browser-but-full-pipeline proof, and the PR
// description for which DoD boxes remain "awaiting a live run".

import { test, expect, describe } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import {
  bindLoopbackListener,
  buildAuthorizeUrl,
  buildOpenBrowserCommand,
  decidePreflightFallback,
  deriveChallengeS256,
  generateCodeVerifier,
  generateState,
  isOnPath,
  openBrowser,
  type SpawnFn,
} from '../src/lib/loopback-oauth';

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/; // RFC 7636 §4.1
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/; // RFC 7636 §4.2 (base64url sha256, no padding)

describe('generateCodeVerifier', () => {
  test('well-formed per RFC 7636 §4.1', () => {
    const v = generateCodeVerifier();
    expect(VERIFIER_RE.test(v)).toBe(true);
  });
  test('drawn from a CSPRNG — never two equal in a row, over many samples', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateCodeVerifier());
    expect(seen.size).toBe(200);
  });
  test('honors an injected byte source (still base64url-encodes it)', () => {
    const fixed = Buffer.alloc(32, 7);
    const v = generateCodeVerifier(() => fixed);
    expect(v).toBe(fixed.toString('base64url'));
    expect(VERIFIER_RE.test(v)).toBe(true);
  });
});

describe('generateState', () => {
  test('non-empty, URL-safe, unique over many samples', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = generateState();
      expect(s.length).toBeGreaterThan(20);
      expect(/^[A-Za-z0-9_-]+$/.test(s)).toBe(true);
      seen.add(s);
    }
    expect(seen.size).toBe(200);
  });
});

describe('deriveChallengeS256', () => {
  test('matches RFC 7636 Appendix B\'s worked example', () => {
    // The RFC's own verifier/challenge pair — independent proof this CLI's
    // derivation is bit-for-bit the same algorithm the server implements in
    // mesh-oauth/pkce.ts#deriveChallengeS256 (BASE64URL(SHA256(verifier))).
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = deriveChallengeS256(verifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(CHALLENGE_RE.test(challenge)).toBe(true);
  });
  test('deterministic and well-formed for a generated verifier', () => {
    const v = generateCodeVerifier();
    const c1 = deriveChallengeS256(v);
    const c2 = deriveChallengeS256(v);
    expect(c1).toBe(c2);
    expect(CHALLENGE_RE.test(c1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAuthorizeUrl
// ---------------------------------------------------------------------------

describe('buildAuthorizeUrl', () => {
  test('carries every required param and NO scope', () => {
    const url = new URL(
      buildAuthorizeUrl('https://api.example.com', {
        clientId: 'ai-pipeline-cli',
        redirectUri: 'http://127.0.0.1:54321/callback',
        codeChallenge: 'CHALLENGE',
        state: 'STATE',
        resource: 'https://api.example.com/api',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://api.example.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('ai-pipeline-cli');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:54321/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe('https://api.example.com/api');
    expect(url.searchParams.get('state')).toBe('STATE');
    // c4's decision: an `api`-audience token carries no scope vocabulary; a
    // non-empty scope request against it is refused server-side, so the CLI
    // must never send one.
    expect(url.searchParams.has('scope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Browser opener
// ---------------------------------------------------------------------------

describe('buildOpenBrowserCommand', () => {
  test('darwin -> open', () => {
    expect(buildOpenBrowserCommand('darwin', 'https://x')).toEqual({ cmd: 'open', args: ['https://x'] });
  });
  test('linux -> xdg-open', () => {
    expect(buildOpenBrowserCommand('linux', 'https://x')).toEqual({ cmd: 'xdg-open', args: ['https://x'] });
  });
  test('win32 -> cmd /c start "" <url>', () => {
    expect(buildOpenBrowserCommand('win32', 'https://x')).toEqual({
      cmd: 'cmd.exe',
      args: ['/c', 'start', '', 'https://x'],
    });
  });
  test('unknown platform -> null', () => {
    expect(buildOpenBrowserCommand('sunos', 'https://x')).toBeNull();
  });
});

/** A minimal fake child process: enough of Node's `ChildProcess` surface for
 *  `openBrowser` (`.on('error', …)` / `.on('exit', …)`), nothing more. */
function fakeChild(): EventEmitter {
  return new EventEmitter();
}

describe('openBrowser', () => {
  test('exit 0 -> ok', async () => {
    const spawnFn: SpawnFn = () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('exit', 0));
      return child as never;
    };
    const result = await openBrowser(spawnFn, 'open', ['https://x']);
    expect(result).toEqual({ ok: true, code: 0 });
  });
  test('non-zero exit -> not ok, code preserved (the "opener returns non-zero" trigger)', async () => {
    const spawnFn: SpawnFn = () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('exit', 1));
      return child as never;
    };
    const result = await openBrowser(spawnFn, 'xdg-open', ['https://x']);
    expect(result).toEqual({ ok: false, code: 1 });
  });
  test('spawn error event (e.g. ENOENT) -> not ok', async () => {
    const spawnFn: SpawnFn = () => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('error', new Error('spawn xdg-open ENOENT')));
      return child as never;
    };
    const result = await openBrowser(spawnFn, 'xdg-open', ['https://x']);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ENOENT');
  });
  test('spawnFn throws synchronously -> not ok, never crashes', async () => {
    const spawnFn: SpawnFn = () => {
      throw new Error('boom');
    };
    const result = await openBrowser(spawnFn, 'xdg-open', ['https://x']);
    expect(result).toEqual({ ok: false, code: null, message: 'boom' });
  });
});

// ---------------------------------------------------------------------------
// isOnPath
// ---------------------------------------------------------------------------

describe('isOnPath', () => {
  test('found in one of several PATH dirs', () => {
    const exists = (p: string) => p === '/usr/bin/xdg-open';
    const found = isOnPath('xdg-open', { pathEnv: '/usr/local/bin:/usr/bin:/bin', existsSync: exists, sep: '/', delimiter: ':' });
    expect(found).toBe(true);
  });
  test('not found anywhere on PATH', () => {
    const found = isOnPath('xdg-open', { pathEnv: '/usr/local/bin:/bin', existsSync: () => false, sep: '/', delimiter: ':' });
    expect(found).toBe(false);
  });
  test('empty/undefined PATH -> false, never throws', () => {
    expect(isOnPath('xdg-open', { pathEnv: undefined, existsSync: () => true, sep: '/', delimiter: ':' })).toBe(false);
    expect(isOnPath('xdg-open', { pathEnv: '', existsSync: () => true, sep: '/', delimiter: ':' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decidePreflightFallback — 04-cloud-auth.md §1.2's triggers
// ---------------------------------------------------------------------------

describe('decidePreflightFallback', () => {
  test('--device short-circuits everything, with NO reason line (deliberate, not mysterious)', () => {
    const d = decidePreflightFallback({ env: { DISPLAY: ':0' }, platform: 'darwin', device: true });
    expect(d).toEqual({ fallback: true, reason: null });
  });
  test('SSH_CONNECTION set with no DISPLAY -> fallback, names SSH', () => {
    const d = decidePreflightFallback({ env: { SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22' }, platform: 'linux', device: false });
    expect(d.fallback).toBe(true);
    expect((d as { reason: string }).reason).toContain('SSH');
  });
  test('SSH_CONNECTION set but DISPLAY also set (X forwarding) -> not an SSH-specific fallback', () => {
    const d = decidePreflightFallback({
      env: { SSH_CONNECTION: '1.2.3.4 22 5.6.7.8 22', DISPLAY: ':10.0' },
      platform: 'linux',
      device: false,
      commandExists: () => true,
    });
    expect(d).toEqual({ fallback: false });
  });
  test('headless Linux (no DISPLAY, no WAYLAND_DISPLAY) -> fallback', () => {
    const d = decidePreflightFallback({ env: {}, platform: 'linux', device: false, commandExists: () => true });
    expect(d.fallback).toBe(true);
  });
  test('Linux with a display but no xdg-open on PATH -> fallback', () => {
    const d = decidePreflightFallback({ env: { DISPLAY: ':0' }, platform: 'linux', device: false, commandExists: () => false });
    expect(d.fallback).toBe(true);
  });
  test('Linux with a display AND an opener -> no fallback', () => {
    const d = decidePreflightFallback({ env: { DISPLAY: ':0' }, platform: 'linux', device: false, commandExists: () => true });
    expect(d).toEqual({ fallback: false });
  });
  test('darwin/win32 never trip the Linux-only opener/display checks', () => {
    expect(decidePreflightFallback({ env: {}, platform: 'darwin', device: false })).toEqual({ fallback: false });
    expect(decidePreflightFallback({ env: {}, platform: 'win32', device: false })).toEqual({ fallback: false });
  });
});

// ---------------------------------------------------------------------------
// bindLoopbackListener — REAL localhost network, no fakes below the socket.
// ---------------------------------------------------------------------------
//
// Every test in this block that reaches an `outcome` other than "still
// pending" must also prove the listener actually closed: a fetch to the same
// redirect_uri AFTER `outcome` settles must fail (connection refused),
// because a leaked listener on a user's loopback interface is exactly the
// vulnerability 07-approval-policy.md §8 exists to avoid.

async function expectClosed(redirectUri: string): Promise<void> {
  let threw = false;
  try {
    await fetch(redirectUri);
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}

describe('bindLoopbackListener — real network', () => {
  test('binds a real loopback literal (never localhost) with an ephemeral port', async () => {
    const session = await bindLoopbackListener({ state: 's', timeoutMs: 5000 });
    expect(session).not.toBeNull();
    expect(session!.redirectUri).toMatch(/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\/callback$/);
    expect(session!.redirectUri).not.toContain('localhost');
    await session!.close();
  });

  test('correct /callback + correct state + code -> resolves "code", serves a terminal page, closes', async () => {
    const session = await bindLoopbackListener({ state: 'abc123', timeoutMs: 5000 });
    expect(session).not.toBeNull();
    const res = await fetch(`${session!.redirectUri}?code=THE_CODE&state=abc123`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.toLowerCase()).toContain('connected');

    const outcome = await session!.outcome;
    expect(outcome).toEqual({ kind: 'code', code: 'THE_CODE' });

    await expectClosed(session!.redirectUri);
  });

  test('wrong path is rejected (404) WITHOUT ending the attempt — the real callback still succeeds after', async () => {
    const session = await bindLoopbackListener({ state: 'xyz', timeoutMs: 5000 });
    expect(session).not.toBeNull();

    const stray = await fetch(session!.redirectUri.replace('/callback', '/favicon.ico'));
    expect(stray.status).toBe(404);

    // The attempt is still alive — `outcome` has not settled from the stray
    // request. Race it against a short timer to prove that.
    const stillPending = await Promise.race([
      session!.outcome.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100)),
    ]);
    expect(stillPending).toBe(true);

    // The REAL callback, sent afterward, still completes normally.
    const real = await fetch(`${session!.redirectUri}?code=OK&state=xyz`);
    expect(real.status).toBe(200);
    const outcome = await session!.outcome;
    expect(outcome).toEqual({ kind: 'code', code: 'OK' });

    await expectClosed(session!.redirectUri);
  });

  test('wrong state is rejected AND ends the whole attempt — never retried, never a second chance', async () => {
    const session = await bindLoopbackListener({ state: 'expected-state', timeoutMs: 5000 });
    expect(session).not.toBeNull();

    const res = await fetch(`${session!.redirectUri}?code=SOMETHING&state=WRONG`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body.toLowerCase()).toContain('unexpected callback');

    const outcome = await session!.outcome;
    expect(outcome).toEqual({ kind: 'state_mismatch' });

    // Closed immediately (RFC 8252 §8.3) — even a SUBSEQUENT correct-looking
    // callback is refused, because the listener is gone.
    await expectClosed(`${session!.redirectUri}?code=SOMETHING&state=expected-state`);
  });

  test('an OAuth error= param (consent declined) is reported and closes', async () => {
    const session = await bindLoopbackListener({ state: 's1', timeoutMs: 5000 });
    expect(session).not.toBeNull();
    const res = await fetch(`${session!.redirectUri}?error=access_denied&state=s1`);
    expect(res.status).toBe(200); // not the user's fault — a calm terminal page, not a scary 4xx
    const outcome = await session!.outcome;
    expect(outcome).toEqual({ kind: 'oauth_error', error: 'access_denied' });
    await expectClosed(session!.redirectUri);
  });

  test('a /callback with correct state but no code is rejected and closes', async () => {
    const session = await bindLoopbackListener({ state: 's2', timeoutMs: 5000 });
    expect(session).not.toBeNull();
    const res = await fetch(`${session!.redirectUri}?state=s2`);
    expect(res.status).toBe(400);
    const outcome = await session!.outcome;
    expect(outcome).toEqual({ kind: 'missing_code' });
    await expectClosed(session!.redirectUri);
  });

  test('late callback: absolute timeout fires and closes the listener with NO request ever sent', async () => {
    const session = await bindLoopbackListener({ state: 's3', timeoutMs: 150 });
    expect(session).not.toBeNull();
    const outcome = await session!.outcome;
    expect(outcome).toEqual({ kind: 'timeout' });
    await expectClosed(session!.redirectUri);
  });

  test('a callback arriving AFTER the timeout has already fired is refused (connection closed)', async () => {
    const session = await bindLoopbackListener({ state: 's4', timeoutMs: 100 });
    expect(session).not.toBeNull();
    const redirectUri = session!.redirectUri;
    await session!.outcome; // wait for the timeout to settle + close
    let threw = false;
    try {
      await fetch(`${redirectUri}?code=TOO_LATE&state=s4`);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('explicit close() before any callback arrives settles outcome and releases the port', async () => {
    const session = await bindLoopbackListener({ state: 's5', timeoutMs: 5000 });
    expect(session).not.toBeNull();
    await session!.close();
    const outcome = await session!.outcome;
    expect(outcome.kind).toBe('listener_error');
    await expectClosed(session!.redirectUri);
  });

  test('close() is idempotent — calling it again after settling is a safe no-op', async () => {
    const session = await bindLoopbackListener({ state: 's6', timeoutMs: 5000 });
    expect(session).not.toBeNull();
    await fetch(`${session!.redirectUri}?code=X&state=s6`);
    await session!.outcome;
    await session!.close(); // must not throw, must not hang
    await session!.close();
  });

  test('when neither family can bind, returns null (both-families-unbindable fallback trigger)', async () => {
    class FailingServer extends EventEmitter {
      listening = false;
      listen(): this {
        queueMicrotask(() => this.emit('error', new Error('EADDRNOTAVAIL (simulated)')));
        return this;
      }
      address(): null {
        return null;
      }
      close(cb?: () => void): this {
        cb?.();
        return this;
      }
    }
    const session = await bindLoopbackListener({
      state: 's7',
      timeoutMs: 5000,
      createServer: () => new FailingServer() as unknown as Server,
    });
    expect(session).toBeNull();
  });

  test('falls back to the second family when the first fails to bind', async () => {
    class FailingServer extends EventEmitter {
      listen(): this {
        queueMicrotask(() => this.emit('error', new Error('simulated v4 failure')));
        return this;
      }
      close(cb?: () => void): this {
        cb?.();
        return this;
      }
    }
    class FakeSucceedingServer extends EventEmitter {
      listening = true;
      listen(_port: number, _host: string, cb?: () => void): this {
        queueMicrotask(() => cb?.());
        return this;
      }
      address() {
        return { address: '::1', family: 'IPv6', port: 54999 };
      }
      close(cb?: () => void): this {
        this.listening = false;
        cb?.();
        return this;
      }
    }
    let call = 0;
    const session = await bindLoopbackListener({
      state: 's8',
      timeoutMs: 5000,
      createServer: () => (call++ === 0 ? (new FailingServer() as unknown as Server) : (new FakeSucceedingServer() as unknown as Server)),
    });
    expect(session).not.toBeNull();
    expect(session!.redirectUri).toBe('http://[::1]:54999/callback');
    await session!.close();
  });
});
