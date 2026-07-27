// loopback-oauth.ts — the browser authorization_code + PKCE flow's low-level,
// independently-testable pieces: PKCE/state generation (CSPRNG), the RFC 8252
// loopback HTTP listener that catches exactly one redirect, the OS browser
// opener, and the pre-flight fallback-trigger decision.
//
// Threat posture this file implements — simplified-onboarding design
// `07-approval-policy.md` §8 ("The loopback listener"), NOT reinvented here:
//   - `state` is generated per attempt from a CSPRNG and VERIFIED before a
//     code is ever accepted.
//   - Any path other than `/callback` is rejected (but does not abort the
//     attempt — see `attachCallbackHandler`'s doc comment for why).
//   - The listener has a short ABSOLUTE timeout, independent of how many
//     stray requests it fielded.
//   - The listener is bound only for the duration of one attempt and closed
//     immediately once the real callback (or the timeout) settles it (RFC
//     8252 §8.3) — on EVERY exit path: success, wrong state, an OAuth
//     `error=`, timeout, or the caller aborting before any callback arrives.
//   - A callback that fails `state` is ignored with a message; the WHOLE
//     attempt ends there (closed, not retried) — it does not silently keep
//     listening as if nothing happened, and it does not throw a scary crash
//     either. See `CallbackOutcome`'s `state_mismatch` case.
//
// `127.0.0.1` / `::1` only, NEVER `localhost` (RFC 8252 §7.3 — a hostname
// can be rebound or resolve differently than the implementer assumes; the IP
// literal cannot). This is the client half of the server-side exception
// implemented in cloud/apps/api/src/modules/mesh-oauth/redirect-uri.ts,
// which the CLI's `redirect_uri` must match in every component EXCEPT port.

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { createServer as nodeCreateServer, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter as pathDelimiter, sep as pathSep } from 'node:path';

// ---------------------------------------------------------------------------
// PKCE + state (CSPRNG only — RFC 7636 / RFC 8252 §8.9; the AS REQUIRES both,
// see mesh-oauth/routes.ts:331,334-341, and refuses `plain` outright).
// ---------------------------------------------------------------------------

/**
 * 32 random bytes -> 43-char base64url, which lands squarely inside RFC 7636
 * §4.1's `43-128` char `code_verifier` alphabet (base64url's `[A-Za-z0-9_-]`
 * is a strict subset of the verifier's `[A-Za-z0-9-._~]`). CSPRNG source is
 * `node:crypto`'s `randomBytes` (OS entropy) — never `Math.random`, which is
 * not cryptographically secure and must never generate a security-critical
 * value.
 */
export function generateCodeVerifier(randomBytesFn: (n: number) => Buffer = nodeRandomBytes): string {
  return randomBytesFn(32).toString('base64url');
}

/** Same CSPRNG source and encoding as the verifier; `state` has no format
 *  requirement from the server (RFC 8252 §8.9 opaque value), 32 bytes gives
 *  it the same unguessability margin. */
export function generateState(randomBytesFn: (n: number) => Buffer = nodeRandomBytes): string {
  return randomBytesFn(32).toString('base64url');
}

/**
 * `code_challenge = BASE64URL(SHA256(code_verifier))` — RFC 7636 §4.2,
 * bit-for-bit the same algorithm as the server's
 * `mesh-oauth/pkce.ts#deriveChallengeS256`, verified independently here
 * against RFC 7636 Appendix B's worked example in the test file. Pure (no
 * randomness) so it's fully deterministic and testable.
 */
export function deriveChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

// ---------------------------------------------------------------------------
// Loopback listener
// ---------------------------------------------------------------------------

/** The two loopback literals RFC 8252 §7.3 recommends binding, in the order
 *  attempted. IPv6's URL host form keeps its brackets (matches the server's
 *  registered `http://[::1]/callback` pattern and `URL#hostname` behavior —
 *  see redirect-uri.ts's module doc on the server side). */
const LOOPBACK_HOSTS: ReadonlyArray<{ bindHost: string; uriHost: string }> = [
  { bindHost: '127.0.0.1', uriHost: '127.0.0.1' },
  { bindHost: '::1', uriHost: '[::1]' },
];

export type CallbackOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'oauth_error'; error: string; errorDescription?: string }
  | { kind: 'state_mismatch' }
  | { kind: 'missing_code' }
  | { kind: 'timeout' }
  | { kind: 'listener_error'; message: string };

export interface LoopbackSession {
  /** `http://<loopback-literal>:<port>/callback` — the exact redirect_uri to
   *  send to the authorization server, echoed byte-for-byte (port included)
   *  at the token exchange per OAuth 2.1 §4.1.1/§4.1.3. */
  redirectUri: string;
  port: number;
  /** Resolves exactly once, after the listener has ALREADY been closed (see
   *  module doc — every path closes before this settles). */
  outcome: Promise<CallbackOutcome>;
  /** Force-close before any callback arrives (e.g. the browser opener itself
   *  failed to spawn). Idempotent — safe to call again after `outcome`
   *  already settled; a no-op in that case. Also settles `outcome` (with
   *  `listener_error`) if it had not already, so no caller is ever left
   *  awaiting a promise that will never resolve. */
  close(): Promise<void>;
}

export interface BindLoopbackOptions {
  /** Per-attempt `state` (already generated — see module doc on why this is
   *  threaded in at bind time rather than after: it closes the window where
   *  the socket is accepting connections but has no state to check them
   *  against). */
  state: string;
  /** Short ABSOLUTE timeout (ms) for the whole attempt, counted from bind. */
  timeoutMs: number;
  /** Test seam: defaults to `node:http.createServer()`. Used to simulate an
   *  unbindable port deterministically without exhausting real OS ports. */
  createServer?: () => Server;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

const TERMINAL_PAGE = (message: string, ok: boolean) =>
  `<!doctype html><html><head><title>ai-pipeline</title></head><body ` +
  `style="font-family:system-ui,sans-serif;padding:2rem;color:${ok ? '#1a7f37' : '#b42318'}">` +
  `<p>${message}</p></body></html>`;

/**
 * Try each loopback literal in turn (RFC 8252 §7.3: "attempt to bind... using
 * both IPv4 and IPv6 and use whichever is available") and, on the FIRST one
 * that binds, wire up the one-shot callback handler and start the absolute
 * timeout. Returns `null` (never throws) when NEITHER family can be bound —
 * the caller's fallback trigger ("the loopback port cannot be bound on
 * either family", 04-cloud-auth.md §1.2).
 */
export async function bindLoopbackListener(opts: BindLoopbackOptions): Promise<LoopbackSession | null> {
  const createServer = opts.createServer ?? (() => nodeCreateServer());
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;

  for (const host of LOOPBACK_HOSTS) {
    const server = createServer();
    const bound = await tryListen(server, host.bindHost);
    if (!bound) continue;

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const redirectUri = `http://${host.uriHost}:${port}/callback`;

    const sockets = new Set<Socket>();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    let settled = false;
    let resolveOutcome!: (o: CallbackOutcome) => void;
    const outcome = new Promise<CallbackOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    const closeNow = (): Promise<void> =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });

    const settle = (o: CallbackOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeoutFn(timer);
      resolveOutcome(o);
    };

    const timer = setTimeoutFn(() => {
      if (settled) return;
      void closeNow().then(() => settle({ kind: 'timeout' }));
    }, opts.timeoutMs);

    attachCallbackHandler(server, opts.state, (o) => {
      void closeNow().then(() => settle(o));
    });

    return {
      redirectUri,
      port,
      outcome,
      close: async () => {
        await closeNow();
        settle({ kind: 'listener_error', message: 'closed before a callback arrived' });
      },
    };
  }

  return null;
}

function tryListen(server: Server, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(0, host, () => resolve(true));
  });
}

/**
 * The one-shot request handler. Deliberately does NOT end the attempt on a
 * wrong PATH — only on a `/callback` request, because a real browser can
 * (and sometimes does) fire an incidental request for something else (e.g.
 * `/favicon.ico`) around the actual redirect; killing the whole attempt on
 * that would be a false-positive DoS against the legitimate flow. A wrong
 * path is answered 404 and the listener keeps waiting for the real
 * `/callback` — that IS "rejecting" it (RFC 8252 §8.3 talks about closing on
 * receiving THE redirect, i.e. this one), just without discarding an
 * in-progress legitimate attempt over an unrelated stray request.
 *
 * A `/callback` request is where `state` is verified BEFORE anything else is
 * inspected (07-approval-policy.md §8) — an OAuth `error=` param or a missing
 * `code` are only looked at once `state` has already matched.
 */
function attachCallbackHandler(server: Server, expectedState: string, onSettle: (o: CallbackOutcome) => void): void {
  server.on('request', (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://loopback.invalid');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
      return;
    }

    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }

    const presentedState = url.searchParams.get('state') ?? '';
    // Constant-time-ish is not the point here (state is single-use, ≤ the
    // listener's own short timeout, and not a long-lived secret — same
    // rationale the server's own PKCE verifier comparison gives) — a plain
    // compare is fine; verifying it FIRST, before anything else, is the
    // load-bearing property.
    if (presentedState !== expectedState) {
      respondAndSettle(
        res,
        400,
        TERMINAL_PAGE('Ignored an unexpected callback. Close this tab and re-run to try again.', false),
        { kind: 'state_mismatch' },
        onSettle,
      );
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      respondAndSettle(
        res,
        200,
        TERMINAL_PAGE('Authorization was declined. You can close this tab.', false),
        { kind: 'oauth_error', error, errorDescription: url.searchParams.get('error_description') ?? undefined },
        onSettle,
      );
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      respondAndSettle(
        res,
        400,
        TERMINAL_PAGE('Missing authorization code. Close this tab and re-run to try again.', false),
        { kind: 'missing_code' },
        onSettle,
      );
      return;
    }

    respondAndSettle(res, 200, TERMINAL_PAGE('Connected. You can close this tab.', true), { kind: 'code', code }, onSettle);
  });
}

/**
 * Write the terminal page and settle the attempt only once Node has actually
 * handed the response off to the OS for transmission (`res`'s `finish`
 * event — NOT the `res.end()` call itself, which only QUEUES the write).
 * This matters because `settle()` triggers `closeNow()`, which force-
 * `destroy()`s every tracked socket, INCLUDING the one this very response is
 * riding on — `Writable#destroy()` explicitly documents that data queued but
 * not yet flushed can be silently discarded. Settling one tick too early
 * would risk the browser getting a truncated page or a connection reset
 * instead of "Connected. You can close this tab." Closing still happens as
 * soon as humanly possible after that (RFC 8252 §8.3) — this just makes sure
 * "as soon as possible" isn't "before the OS has the bytes".
 */
function respondAndSettle(
  res: ServerResponse,
  status: number,
  html: string,
  outcome: CallbackOutcome,
  onSettle: (o: CallbackOutcome) => void,
): void {
  res.writeHead(status, { 'content-type': 'text/html' });
  res.on('finish', () => onSettle(outcome));
  res.end(html);
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  /** `<issuer>/api` — c4's REST audience. Deliberately no `scope` param:
   *  `scopesAllowedForResource("api")` is `[]` by design (mesh-oauth/
   *  resource.ts) and the AS refuses ANY non-empty scope request against
   *  this resource, so one must never be sent. */
  resource: string;
}

/** `server` is already the normalized (no trailing slash) control-plane
 *  base — the SAME origin serves the SPA that renders the consent screen
 *  and the API `/oauth/authorize` itself accepts (mesh-oauth/routes.ts's
 *  module doc: "the SAME origin serves the SPA, the REST API... and the
 *  OAuth AS"). */
export function buildAuthorizeUrl(server: string, params: AuthorizeUrlParams): string {
  const url = new URL(`${server}/oauth/authorize`);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', params.resource);
  url.searchParams.set('state', params.state);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Browser opener
// ---------------------------------------------------------------------------

export interface OpenBrowserCommand {
  cmd: string;
  args: string[];
}

/** Pure: platform -> the OS-native "open this URL" command. `null` means
 *  "no known opener for this platform" (never applies to darwin/win32 — both
 *  ship a system opener; Linux is the platform where an opener can genuinely
 *  be absent, which is why the pre-flight check below probes for it there). */
export function buildOpenBrowserCommand(platform: string, url: string): OpenBrowserCommand | null {
  switch (platform) {
    case 'darwin':
      return { cmd: 'open', args: [url] };
    case 'win32':
      // `cmd /c start "" <url>` — the empty title argument stops `start`
      // from treating a quoted URL as the window title.
      //
      // `&` MUST be escaped as `^&` here. `cmd.exe` re-parses this whole
      // argument list as a command line, and `&` is ITS command separator
      // (`a & b` runs `a` then `b`) — not something `start`/the URL ever
      // sees. Every authorize URL this builds carries `client_id`,
      // `redirect_uri`, `code_challenge`, `code_challenge_method`,
      // `resource` and `state` joined by literal `&`, so this branch is
      // reached on EVERY real invocation, not just an edge case: unescaped,
      // `cmd` truncates the URL at the first `&` and tries to run the next
      // `key=value` pair as its own command, which fails and exits non-zero
      // — silently degrading the whole flow to the device-code fallback on
      // every Windows run. `^` is `cmd`'s own escape character, so `^&`
      // reaches `start`/the URL as a literal `&`. Two alternatives were
      // tried and rejected: quoting the URL (`start "" "<url>"`) makes the
      // child hang instead of exiting, and `explorer.exe <url>` never exits
      // at all — both break the "wait for the exit code" contract
      // `openBrowser` depends on. No other cmd metacharacter (`|<>()"^%`)
      // can occur here: `client_id`/`response_type`/`code_challenge_method`
      // are fixed literals, `code_challenge`/`state` are unpadded base64url
      // (`[A-Za-z0-9_-]` only), and `redirect_uri`/`resource` are
      // percent-encoded by `URLSearchParams` before this ever runs, so any
      // `%XX` that reaches `cmd` is plain hex digits — verified live against
      // this exact `spawn('cmd.exe', ['/c', ...])` shape that stray `%3A`-
      // style sequences pass through unexpanded (no coincidentally-matching
      // env var) and round-trip byte-for-byte.
      return { cmd: 'cmd.exe', args: ['/c', 'start', '', url.replace(/&/g, '^&')] };
    case 'linux':
      return { cmd: 'xdg-open', args: [url] };
    default:
      return null;
  }
}

export interface SpawnFn {
  (cmd: string, args: string[]): ChildProcess;
}

export const realSpawnBrowser: SpawnFn = (cmd, args) =>
  nodeSpawn(cmd, args, { stdio: 'ignore', windowsHide: true });

export interface OpenBrowserResult {
  ok: boolean;
  code: number | null;
  message?: string;
}

/**
 * Spawn the opener and WAIT for it to exit (unlike the fire-and-forget
 * `os-notify.ts` pattern) — one of the design's fallback triggers is "the
 * browser opener returns non-zero", which is only observable by waiting.
 * Openers (`open`/`xdg-open`/`start`) return almost immediately after
 * launching the browser; this does not wait for the browser ITSELF to close.
 */
export function openBrowser(spawnFn: SpawnFn, cmd: string, args: string[]): Promise<OpenBrowserResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(cmd, args);
    } catch (e) {
      resolve({ ok: false, code: null, message: (e as Error).message });
      return;
    }
    let settled = false;
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, code: null, message: e.message });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      resolve({ ok: code === 0, code });
    });
  });
}

// ---------------------------------------------------------------------------
// Pre-flight fallback decision (04-cloud-auth.md §1.2)
// ---------------------------------------------------------------------------

export interface PreflightDeps {
  env: Record<string, string | undefined>;
  platform: string;
  /** `--device` was passed explicitly — the one trigger that is a deliberate
   *  user choice, not an environment limitation, so it carries no reason
   *  line (04§1.2 lists it as a trigger; it just isn't a "mysterious"
   *  change since the user typed it themselves). */
  device: boolean;
  /** Whether a named command exists on PATH — Linux-only opener presence
   *  check. Defaults to a real PATH scan (see `realCommandExists`). */
  commandExists?: (cmd: string) => boolean;
}

export type PreflightDecision =
  | { fallback: true; reason: string | null }
  | { fallback: false };

/** The FIRST four rungs of 04§4's selection ladder that this task owns
 *  (the fifth, `PIPELINE_MACHINE_TOKEN`, is task a4's client_credentials
 *  path and is not implemented here). Order matters: `--device` short-
 *  circuits before any environment probing. */
export function decidePreflightFallback(deps: PreflightDeps): PreflightDecision {
  if (deps.device) return { fallback: true, reason: null };

  if (deps.env.SSH_CONNECTION && !deps.env.DISPLAY) {
    return { fallback: true, reason: 'Connected over SSH with no browser to open — falling back to a device code.' };
  }

  if (deps.platform === 'linux') {
    const noDisplay = !deps.env.DISPLAY && !deps.env.WAYLAND_DISPLAY;
    const commandExists = deps.commandExists ?? realCommandExists;
    const noOpener = !commandExists('xdg-open');
    if (noDisplay || noOpener) {
      return { fallback: true, reason: 'No browser available here — falling back to a device code.' };
    }
  }

  return { fallback: false };
}

/** True when `cmd` resolves to an existing file on some `PATH` directory.
 *  Pure decision over injected inputs — see `realCommandExists` for the real
 *  `process.env.PATH` / `node:fs` wiring. Deliberately does not check the
 *  executable bit (POSIX's `X_OK`) — presence is enough to distinguish "not
 *  installed" (the case this exists for) from everything else. */
export function isOnPath(
  cmd: string,
  deps: { pathEnv: string | undefined; existsSync: (p: string) => boolean; sep: string; delimiter: string },
): boolean {
  const dirs = (deps.pathEnv ?? '').split(deps.delimiter).filter((d) => d.length > 0);
  return dirs.some((dir) => deps.existsSync(`${dir}${deps.sep}${cmd}`));
}

export function realCommandExists(cmd: string): boolean {
  return isOnPath(cmd, { pathEnv: process.env.PATH, existsSync, sep: pathSep, delimiter: pathDelimiter });
}
