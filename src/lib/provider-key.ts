// provider-key.ts — THE ONE MODULE THAT OWNS THE PROVIDER API KEY (c1,
// 02-standalone-executor.md "Key handling (K-1, resolved)").
//
// `standalone` executes steps through the Agent SDK with an Anthropic API
// key. This module is the single place that key is resolved, held, and
// revealed. It is layer ONE of two: c2's output scrubber is layer two, and
// NEITHER substitutes for the other — this one keeps the key from ever
// entering ordinary code as a string, the scrubber catches what escapes
// through third-party code we do not control.
//
// ── THE LADDER (first match wins) ──────────────────────────────────────────
//
//   1. flag    an explicit `--api-key` on the invocation      we store nothing
//   2. helper  a user-configured HELPER COMMAND we run and    we store nothing
//              read the key from its stdout
//   3. env     `ANTHROPIC_API_KEY` in the environment         we store nothing
//   4. store   our existing per-user credential store         WE STORE IT
//
// THREE OF THE FOUR RUNGS MEAN WE NEVER HOLD A KEY AT ALL. Rung 4 exists
// because some users will configure nothing else, and refusing them is worse
// than storing it carefully.
//
// The ladder's SHAPE mirrors `commands/cloud.ts`'s 04§4 selection ladder,
// where a non-interactive credential outranks interactive discovery — there
// the real order is machine-token-first (`authenticateApi`), and the same
// principle applies here: the more explicit and the more ephemeral a source
// is, the higher it sits.
//
// Rung 2 mirrors Claude Code's own `apiKeyHelper`, which is the precedent for
// "the user owns the secret, we only ask for it": it composes with 1Password
// (`op read …`), `vault kv get …`, `aws secretsmanager get-secret-value …`,
// or anything else that prints a key on stdout.
//
// ── WHY A CONFIGURED-BUT-FAILING HELPER IS AN ERROR, NOT A FALLTHROUGH ─────
//
// If rung 2 is configured and the command fails, this module THROWS rather
// than quietly dropping to rung 3 or 4. A user who wired a vault helper and
// whose vault is locked must be told so, not silently switched onto a stale
// `ANTHROPIC_API_KEY` left in their shell profile — substituting one
// credential for another behind the user's back is a security event, not a
// convenience. Same posture as `cloud.ts`, where a present machine token's
// exchange failure is an error and never a fallback to the browser flow.
//
// ── THE HELPER'S STDOUT IS THE KEY, SO IT NEVER REACHES AN ERROR ──────────
//
// `runHelperRung` captures stdout and stderr and puts NEITHER into the error
// it surfaces. Not stdout, obviously — that is the key itself. And not
// stderr either: a helper that writes a diagnostic containing its own
// argument (`op: item "sk-…" not found`) would leak just as completely, and
// we cannot know which stream a third-party tool chose. The error carries the
// exit code and the command's FIRST TOKEN — a binary name, not a credential —
// and tells the user how to reproduce it themselves. Debuggability is
// deliberately traded for the guarantee; see `docs/provider-key.md`.
//
// ── THE OS-KEYCHAIN QUESTION, ANSWERED ────────────────────────────────────
//
// DECIDED: YES — a rung-4 provider key rides the SAME keychain path the
// refresh token already uses (`credential-keychain.ts`: macOS `security`,
// Linux `secret-tool`, Windows `none` by that module's documented finding
// that `cmdkey` cannot read an entry back), with the ACL/0600 file as the
// documented fallback. The reasoning, including the one place this module
// deliberately behaves differently from the refresh token, is written up in
// `docs/provider-key.md` §"Does a provider key ride the OS keychain?". The
// platform analysis is NOT re-derived here — it lives in
// `credential-keychain.ts`'s header and has not changed.
//
// ── WHAT "ONE MODULE OWNS IT" MEANS MECHANICALLY ──────────────────────────
//
// A resolved key is a `ProviderKey`, and the secret is NOT a property of that
// object — it lives in a module-private `WeakMap`, so the value is
// unreachable by `JSON.stringify`, `structuredClone`, `Object.entries`, a
// spread, a debugger's object dump, or any other whole-object serialisation
// some other layer might perform. `toJSON`/`toString`/`inspect` all return a
// fixed redaction marker.
//
// `revealProviderKey` is the ONE boundary where the string exists again.
// Every call site of it is a security decision, and
// `tests/provider-key-ownership.test.ts` enumerates the allowed ones as a
// tripwire: adding a file to that allowlist is the deliberate act of granting
// another module the plaintext.
//
// This package's own hard-won rule — "when inspecting a secrets file, print
// the LENGTH, never the content" — is the reason `describeProviderKey` exists
// and returns a byte count rather than anything derived from the value.
//
// ── HOW LAYER TWO LEARNS THE VALUES (c2) ──────────────────────────────────
//
// `lib/output-scrubber.ts` redacts values it KNOWS, so it has to be told them
// — and the ONE module allowed to know them is this one. So the arrow points
// OWNER → SCRUBBER: every construction path here calls `registerSecret`, and
// the scrubber neither imports this module nor mentions `revealProviderKey`.
// Had it been the other way round — the scrubber reaching in for the
// plaintext — c1's "exactly one module holds the key" property would be gone,
// and `tests/provider-key-ownership.test.ts` would have had to widen its
// allowlist to say so. It did not, and must not.
//
// The register is fed at CONSTRUCTION (the `ProviderKey` constructor below),
// which is the single funnel every rung passes through, plus the two places a
// plaintext exists without a holder: `persistProviderKey`'s argument, and the
// `ANTHROPIC_API_KEY` value a run can SEE even when a higher rung wins — 02
// asks for "every key the ladder can produce in one run, not only the one in
// use", and an environment key that lost to `--api-key` is still sitting in
// the environment of every subprocess we spawn.

import { spawnSync } from 'node:child_process';
import { registerSecret } from './output-scrubber';
import {
  credentialFilePath,
  readCredentialStore,
  writeCredentialStore,
  type CloudFs,
  type CredentialStore,
  type HomeContext,
  type StoredProviderKey,
} from './cloud-config';
import { protectCredentialFile, type ProtectDeps } from './credential-protect';
import {
  deleteFromKeychain,
  readFromKeychain,
  realRunKeychainCommand,
  storeInKeychain,
  type KeychainDeps,
} from './credential-keychain';

// ---------------------------------------------------------------------------
// Names — the ladder's user-visible surface
// ---------------------------------------------------------------------------

/** Rung 1 — the explicit flag. Parsed by `extractProviderKeyFlag` below and
 *  NOT by the command layer, so the plain string never exists as a variable
 *  outside this module. */
export const PROVIDER_KEY_FLAG = '--api-key';

/** Rung 2 — names the helper COMMAND (never the key). Mirrors Claude Code's
 *  `apiKeyHelper` setting; we take it from the environment (or an explicit
 *  option) rather than inventing a settings file this package does not have. */
export const PROVIDER_KEY_HELPER_ENV = 'PIPELINE_API_KEY_HELPER';

/** Rung 3 — the CI path. The same variable the Agent SDK and `claude --bare`
 *  read themselves (see `docs/bare-baseline.md` run 9). */
export const PROVIDER_KEY_ENV = 'ANTHROPIC_API_KEY';

/** Rung 4 — the provider this package stores a key for. `02`'s non-goals put
 *  other providers in the engine registry, not here; the store is keyed
 *  anyway so adding one is data, not a schema change. */
export const PROVIDER_ID = 'anthropic';

/** Rung 4 — the OS-keychain account a stored provider key is filed under.
 *  Deliberately NOT a server URL: `credential-refresh.ts` files refresh
 *  tokens under the control-plane URL, and a provider key belongs to no
 *  control plane at all, so a `provider:` prefix keeps the two namespaces
 *  from ever colliding in one keychain. */
export const PROVIDER_KEY_KEYCHAIN_ACCOUNT = `provider:${PROVIDER_ID}`;

/** How long a helper command may run before it is killed. A hung vault
 *  helper must fail the run, not wedge it forever. */
export const DEFAULT_HELPER_TIMEOUT_MS = 10_000;

/** What every stringification of a `ProviderKey` produces instead of the key. */
export const REDACTED = '[redacted provider key]';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A provider-key resolution failure surfaced to the user. NEVER carries the
 * key, a helper's stdout, or a helper's stderr — see this file's header.
 */
export class ProviderKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderKeyError';
  }
}

// ---------------------------------------------------------------------------
// The holder
// ---------------------------------------------------------------------------

export type ProviderKeySource = 'flag' | 'helper' | 'env' | 'store';

/** The secret half, off-object by construction. A `WeakMap` keyed by the
 *  holder means the string is not an own property, not an inherited one, and
 *  not reachable from the object at all — only this module holds the map. */
const SECRETS = new WeakMap<ProviderKey, string>();

/**
 * A resolved provider API key. Carries WHICH rung produced it (non-secret,
 * safe to log) and nothing else observable. Every stringification path is
 * overridden to produce {@link REDACTED}:
 *
 *   - `JSON.stringify(anything containing it)` → the marker, at any depth;
 *   - `` `${key}` ``, `String(key)`, `'' + key` → the marker;
 *   - `console.log(key)` / `util.inspect(key)` under Node/Bun → the marker.
 *
 * Construct it only inside this module; read it only via
 * {@link revealProviderKey}.
 */
export class ProviderKey {
  /** Which ladder rung produced this key. NOT a secret. */
  readonly source: ProviderKeySource;

  constructor(source: ProviderKeySource, secret: string) {
    this.source = source;
    SECRETS.set(this, secret);
    // Layer two, fed at the ONE funnel every rung passes through. A holder
    // that exists is a value the run can leak, whether or not the ladder
    // ended up selecting it, so registration is unconditional and happens
    // BEFORE the holder is returned to anyone.
    registerSecret(secret);
  }

  /** `JSON.stringify` calls this at ANY nesting depth, which is the whole
   *  point: a key that ends up inside a request body, a telemetry envelope or
   *  a debug dump serialises as the marker rather than as itself. */
  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  /** Covers `` `${key}` `` and `'' + key`, which do NOT go through `toJSON`. */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return 'ProviderKey';
  }

  /** `util.inspect` / `console.log` on Node and Bun. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

/**
 * THE ONE BOUNDARY. Returns the plaintext key.
 *
 * Every call site is a deliberate security decision and is enumerated by
 * `tests/provider-key-ownership.test.ts`'s allowlist — that test fails when a
 * new file calls this, on purpose. Callers must pass the value straight into
 * the sink that needs it (an SDK option, an env var for a child process) and
 * must not park it in a variable that outlives the call, put it on an object,
 * or log it.
 */
export function revealProviderKey(key: ProviderKey): string {
  const secret = SECRETS.get(key);
  if (secret === undefined) {
    throw new ProviderKeyError('not a provider key holder (or its value has been released)');
  }
  return secret;
}

/**
 * A safe, loggable description: the rung and the key's BYTE LENGTH. This
 * package's rule for inspecting a secrets file — print the length, never the
 * content — extends to this whole path, and this is the sanctioned way to
 * prove a key is present and plausible without printing any of it.
 */
export function describeProviderKey(key: ProviderKey): string {
  const secret = SECRETS.get(key);
  if (secret === undefined) return `provider key from ${key.source} (unavailable)`;
  return `provider key from ${key.source} (${Buffer.byteLength(secret, 'utf-8')} bytes)`;
}

// ---------------------------------------------------------------------------
// Rung 1 — the flag, extracted here so the command layer never sees a string
// ---------------------------------------------------------------------------

/**
 * Pull `--api-key <value>` / `--api-key=<value>` out of `argv` and wrap the
 * value immediately, returning the REMAINING argv for the command's own
 * parser.
 *
 * This lives here rather than in the command precisely because of the "one
 * module owns the key" rule: a command that parsed the flag itself would hold
 * the plaintext in one of its own locals, and from there it reaches an
 * options object that something else serialises. The command never sees it.
 *
 * KNOWN AND ACCEPTED: a value passed on the command line is visible to `ps`
 * and to the shell history for as long as the process lives — inherent to any
 * flag, not something this function can fix. `commands/cloud.ts` accepts and
 * documents the same trade-off for `--machine-token`, and points users at the
 * environment variable instead. Rungs 2 and 3 exist for people who care.
 *
 * The LAST occurrence wins, matching how a repeated flag behaves elsewhere in
 * this CLI, and every occurrence is removed from `rest`.
 */
export function extractProviderKeyFlag(argv: string[]): { rest: string[]; key?: ProviderKey } {
  const rest: string[] = [];
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === PROVIDER_KEY_FLAG) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) {
        throw new ProviderKeyError(`${PROVIDER_KEY_FLAG} requires a value`);
      }
      raw = v;
      i++;
      continue;
    }
    if (a.startsWith(`${PROVIDER_KEY_FLAG}=`)) {
      raw = a.slice(PROVIDER_KEY_FLAG.length + 1);
      continue;
    }
    rest.push(a);
  }
  if (raw === undefined) return { rest };
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ProviderKeyError(`${PROVIDER_KEY_FLAG} requires a value`);
  }
  return { rest, key: new ProviderKey('flag', trimmed) };
}

// ---------------------------------------------------------------------------
// Rung 2 — the helper command
// ---------------------------------------------------------------------------

export interface HelperCommandResult {
  /** Exit status; `null` when the process never exited cleanly (spawn
   *  failure, timeout kill) — the same signal shape
   *  `credential-keychain.ts`'s `KeychainCommandResult` uses. */
  status: number | null;
  /** SECRET — this is where the key arrives. Never logged, never surfaced. */
  stdout: string;
  /** Treated as secret too; see this file's header. */
  stderr: string;
  timedOut?: boolean;
}

export type RunHelperCommand = (
  command: string,
  opts: { platform: string; env: Record<string, string | undefined>; timeoutMs: number },
) => HelperCommandResult;

/**
 * Run `command` through the platform's shell — the helper is a COMMAND LINE
 * (`op read op://vault/anthropic/key`), exactly like Claude Code's
 * `apiKeyHelper`, not a bare executable path. stdin is `ignore`d so a helper
 * that decides to prompt fails on its timeout instead of blocking a
 * non-interactive run forever.
 *
 * Shell selection is keyed off the CALLER's injected platform, never the real
 * `process.platform` — the same discipline `credential-protect.ts` and
 * `credential-keychain.ts` already document, so every leg of the CI matrix
 * can assert both shells.
 */
export const realRunHelperCommand: RunHelperCommand = (command, opts) => {
  const [cmd, args] =
    opts.platform === 'win32'
      ? (['cmd.exe', ['/d', '/s', '/c', command]] as const)
      : (['/bin/sh', ['-c', command]] as const);
  const res = spawnSync(cmd, [...args], {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: opts.timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env as Record<string, string>,
  });
  if (res.error) {
    return { status: null, stdout: '', stderr: '', timedOut: res.signal !== null };
  }
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut: res.status === null,
  };
};

/** The command's first whitespace-delimited token — a binary name or path,
 *  which is not a credential, so it is the ONE thing from a helper invocation
 *  that is safe to name in an error. The rest of the command line is withheld
 *  because a user is perfectly capable of putting a secret in an argument. */
function helperLabel(command: string): string {
  const first = command.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : 'the configured helper';
}

/**
 * Run the helper and return its key. THROWS on every failure — see the header
 * for why a configured helper never falls through to a lower rung.
 *
 * The error text contains the exit code and {@link helperLabel} and NOTHING
 * captured from the process. `${PROVIDER_KEY_HELPER_ENV}` is named so the
 * user knows which setting to look at.
 */
function runHelperRung(
  command: string,
  run: RunHelperCommand,
  opts: { platform: string; env: Record<string, string | undefined>; timeoutMs: number },
): ProviderKey {
  let res: HelperCommandResult;
  try {
    res = run(command, opts);
  } catch {
    // An injected fake or a native spawn error both collapse to "the helper
    // did not produce a key" — and the thrown value is DISCARDED rather than
    // chained, because a spawn error's message can echo the whole command
    // line, argument values included.
    throw new ProviderKeyError(
      `the ${PROVIDER_KEY_HELPER_ENV} command (${helperLabel(command)}) could not be run; ` +
        'its output is withheld because it is a secret — run the command yourself to debug it',
    );
  }
  if (res.timedOut || res.status === null) {
    throw new ProviderKeyError(
      `the ${PROVIDER_KEY_HELPER_ENV} command (${helperLabel(command)}) did not finish within ` +
        `${opts.timeoutMs}ms; its output is withheld because it is a secret — ` +
        'run the command yourself to debug it',
    );
  }
  if (res.status !== 0) {
    throw new ProviderKeyError(
      `the ${PROVIDER_KEY_HELPER_ENV} command (${helperLabel(command)}) failed with exit ${res.status}; ` +
        'its output is withheld because it is a secret — run the command yourself to debug it',
    );
  }
  // A helper prints the key and usually a trailing newline; some print a
  // banner line first is NOT assumed — the FIRST non-empty line is the key,
  // which tolerates trailing blank lines without silently accepting a
  // multi-line blob as a credential.
  const line = res.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  const value = line?.trim() ?? '';
  if (value.length === 0) {
    throw new ProviderKeyError(
      `the ${PROVIDER_KEY_HELPER_ENV} command (${helperLabel(command)}) exited 0 but printed no key`,
    );
  }
  return new ProviderKey('helper', value);
}

// ---------------------------------------------------------------------------
// Rung 4 — our existing credential store, with its existing modes
// ---------------------------------------------------------------------------

export interface ProviderKeyDeps {
  platform: string;
  env: Record<string, string | undefined>;
  homedir: string;
  fs: CloudFs;
  /** Defaults to `realRunHelperCommand`; injected so tests assert the exact
   *  invocation and the exact error text without a real subprocess. */
  runHelper?: RunHelperCommand;
  /** Defaults to the real OS keychain runner, exactly as
   *  `credential-refresh.ts#resolveKeychainDeps` does. */
  keychain?: KeychainDeps;
  /** Defaults to `protectCredentialFile` — the same injectable seam
   *  `fingerprint-salt.ts` uses so non-Windows hosts can assert the ACL step. */
  protect?: (filePath: string, deps: ProtectDeps) => void;
  now?: () => number;
}

export interface ResolveProviderKeyOptions {
  /** Rung 1, already wrapped by {@link extractProviderKeyFlag}. */
  flagKey?: ProviderKey;
  /** Rung 2 override; when absent, `PIPELINE_API_KEY_HELPER` is consulted. */
  helperCommand?: string;
  helperTimeoutMs?: number;
}

function keychainDepsOf(deps: ProviderKeyDeps): KeychainDeps {
  return deps.keychain ?? { platform: deps.platform, runCommand: realRunKeychainCommand };
}

function homeCtxOf(deps: ProviderKeyDeps): HomeContext {
  return { platform: deps.platform, env: deps.env, homedir: deps.homedir };
}

/** Rung 4's read. Keychain-first when the stored entry says the value moved
 *  there (b14's `refresh_token_in_keychain` marker, applied to this key). */
function readStoreRung(deps: ProviderKeyDeps): ProviderKey | undefined {
  const path = credentialFilePath(homeCtxOf(deps));
  const store = readCredentialStore(deps.fs, path);
  const entry: StoredProviderKey | undefined = store.provider_keys?.[PROVIDER_ID];
  if (!entry) return undefined;
  if (entry.in_keychain) {
    const value = readFromKeychain(keychainDepsOf(deps), PROVIDER_KEY_KEYCHAIN_ACCOUNT);
    if (value !== undefined && value.length > 0) return new ProviderKey('store', value);
    // DELIBERATELY LOUD, and the one place this key behaves differently from
    // the refresh token. "Marked as keychain-resident but unreadable" means a
    // locked keychain, an absent `secret-tool`, or a deleted entry — and
    // reporting that as "no provider key is configured" would send a user who
    // definitely configured one hunting in the wrong place.
    throw new ProviderKeyError(
      `the stored ${PROVIDER_ID} API key lives in the OS keychain but could not be read ` +
        `(account ${PROVIDER_KEY_KEYCHAIN_ACCOUNT}) — unlock the keychain, or re-store the key`,
    );
  }
  const inline = entry.api_key?.trim();
  return inline && inline.length > 0 ? new ProviderKey('store', inline) : undefined;
}

/**
 * Write a provider key into THE EXISTING credential store — the same
 * per-user file outside the project, the same `0700` directory / `0600` file,
 * the same Windows ACL, the same atomic write-then-rename. No second store is
 * introduced: this is `writeCredentialStore` plus `protectCredentialFile`,
 * the identical pair every other writer of a secret in this package uses
 * (`commands/cloud.ts`, `credential-refresh.ts`, `fingerprint-salt.ts`).
 *
 * Prefers the OS keychain, exactly as `persistCredentialSecurely` does for a
 * refresh token; the file is the documented fallback wherever no backend
 * exists (Windows, a headless Linux box, a locked keychain).
 *
 * Takes the plaintext because this module is the one that owns it; callers
 * hand it straight from the CLI's input and keep no copy.
 */
export function persistProviderKey(
  deps: ProviderKeyDeps,
  secret: string,
): { path: string; backend: 'keychain' | 'file' } {
  const value = secret.trim();
  if (value.length === 0) throw new ProviderKeyError('refusing to store an empty API key');
  // A plaintext that never becomes a `ProviderKey` — it goes straight from the
  // CLI's input to the store — so the constructor's registration cannot cover
  // it. NOTE the one place this must NOT reach: `lib/cloud-config.ts`'s writers
  // are deliberately NOT scrubbed, because the credential store is where this
  // value is SUPPOSED to land. See tests/output-scrubber-sinks.test.ts.
  registerSecret(value);

  const path = credentialFilePath(homeCtxOf(deps));
  const store = readCredentialStore(deps.fs, path);
  const keychain = keychainDepsOf(deps);
  const storedAt = (deps.now ?? Date.now)();

  const inKeychain = storeInKeychain(keychain, PROVIDER_KEY_KEYCHAIN_ACCOUNT, value);
  if (!inKeychain) {
    // Hygiene: a previous keychain-backed key must not linger holding a stale
    // value once the file becomes authoritative again. Best-effort by
    // contract — nothing here depends on the delete landing.
    deleteFromKeychain(keychain, PROVIDER_KEY_KEYCHAIN_ACCOUNT);
  }

  const entry: StoredProviderKey = inKeychain
    ? { in_keychain: true, stored_at: storedAt }
    : { api_key: value, in_keychain: false, stored_at: storedAt };

  const next: CredentialStore = {
    ...store,
    provider_keys: { ...(store.provider_keys ?? {}), [PROVIDER_ID]: entry },
  };
  writeCredentialStore(deps.fs, path, next);
  (deps.protect ?? protectCredentialFile)(path, { platform: deps.platform, env: deps.env });
  return { path, backend: inKeychain ? 'keychain' : 'file' };
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/**
 * Walk the four rungs and return the first match, or `undefined` when no rung
 * produces a key at all (the caller decides whether that is fatal — for
 * `standalone` it is, for a mode that does not need a provider key it is not).
 *
 * THROWS `ProviderKeyError` only for a rung that is CONFIGURED and BROKEN: a
 * `--api-key` with no value, a helper that fails, a keychain-resident stored
 * key that cannot be read. An absent rung is never an error — that is what
 * "first match wins" means.
 */
export function resolveProviderKey(
  deps: ProviderKeyDeps,
  opts: ResolveProviderKeyOptions = {},
): ProviderKey | undefined {
  // Layer two, BEFORE the ladder runs: 02 asks the scrubber to cover "every
  // key the ladder can produce in one run, not only the one in use", and rung
  // 3's value is visible to this process — and inherited by every subprocess
  // it spawns — regardless of which rung wins. Reading it costs nothing and
  // cannot throw. Rungs 1/2/4 register through the `ProviderKey` constructor
  // as they are constructed; rung 4 is deliberately NOT probed here, because
  // reading the store does file I/O and can legitimately throw, and turning a
  // winning higher rung into an error would break "first match wins".
  const fromEnvSeen = (deps.env[PROVIDER_KEY_ENV] ?? '').trim();
  if (fromEnvSeen.length > 0) registerSecret(fromEnvSeen);

  // Rung 1 — the flag.
  if (opts.flagKey !== undefined) return opts.flagKey;

  // Rung 2 — the helper command.
  const helper = (opts.helperCommand ?? deps.env[PROVIDER_KEY_HELPER_ENV] ?? '').trim();
  if (helper.length > 0) {
    return runHelperRung(helper, deps.runHelper ?? realRunHelperCommand, {
      platform: deps.platform,
      env: deps.env,
      timeoutMs: opts.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS,
    });
  }

  // Rung 3 — the environment (already registered above, whichever rung wins).
  if (fromEnvSeen.length > 0) return new ProviderKey('env', fromEnvSeen);

  // Rung 4 — our credential store.
  return readStoreRung(deps);
}

/**
 * `resolveProviderKey`, but a missing key is the error the caller almost
 * always wants — one message that names all four rungs, so a user who has
 * configured none of them learns every way out at once.
 */
export function requireProviderKey(
  deps: ProviderKeyDeps,
  opts: ResolveProviderKeyOptions = {},
): ProviderKey {
  const key = resolveProviderKey(deps, opts);
  if (key !== undefined) return key;
  throw new ProviderKeyError(
    'no Anthropic API key is configured — supply one of:\n' +
      `  ${PROVIDER_KEY_FLAG} <key>            an explicit key on this invocation\n` +
      `  ${PROVIDER_KEY_HELPER_ENV}=<command>  a command that prints the key (1Password, vault, …)\n` +
      `  ${PROVIDER_KEY_ENV}=<key>          the standard environment variable\n` +
      '  a key stored in this machine\'s credential store',
  );
}
