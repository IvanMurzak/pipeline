// cloud-config.ts — filesystem + path helpers for `pipeline cloud connect`.
//
// TWO stores, deliberately separate (the load-bearing security split of T1-16):
//
//  1. The project binding — `<cwd>/.pipeline/cloud.json`. Holds ONLY
//     non-secret slugs/URLs (control-plane base URL, org slug, project slug).
//     Safe to commit to the consumer's repo. NEVER a token/cookie/device_code.
//
//  2. The credential store — a per-USER file OUTSIDE the project
//     (`%APPDATA%\claude-pipeline\credentials.json` on Windows, or
//     `$XDG_CONFIG_HOME/claude-pipeline/credentials.json` — falling back to
//     `~/.config/...` — elsewhere). Holds the session PAT and is written with
//     restrictive perms (dir 0700, file 0600). This is the secret half.
//
// All I/O goes through the injectable `CloudFs` seam so tests never touch the
// real home dir or the real project — and can assert the exact file modes.

import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  mkdirSync as fsMkdirSync,
  chmodSync as fsChmodSync,
  renameSync as fsRenameSync,
  unlinkSync as fsUnlinkSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

/** The control-plane API base used when neither --server nor env names one. */
export const DEFAULT_SERVER = 'https://api.ai-pipeline.dev';

/** Env var that overrides the control-plane API base (below --server). */
export const SERVER_ENV = 'PIPELINE_CLOUD_API';

/** Env var that overrides the per-user credential/config directory (tests + power users). */
export const HOME_ENV = 'PIPELINE_CLOUD_HOME';

/**
 * A single connect failure surfaced to the user as a clean exit-1 message
 * (never a stack trace). Thrown throughout the connect path so the CLI shell
 * can map it to a friendly one-liner + a non-zero exit.
 */
export class CloudError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudError';
  }
}

// ---------------------------------------------------------------------------
// Injectable filesystem seam
// ---------------------------------------------------------------------------

export interface CloudFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, data: string, options?: { mode?: number }): void;
  mkdirSync(path: string, options: { recursive: boolean; mode?: number }): void;
  chmodSync(path: string, mode: number): void;
  /** Atomic rename — the durability primitive DoD box 2 (a5) depends on:
   *  same-filesystem rename is an OS-atomic metadata swap on both NTFS and
   *  every POSIX filesystem, so a process killed before it completes leaves
   *  the ORIGINAL file untouched, and one killed after leaves the NEW file
   *  fully intact — `filePath` itself is never observed half-written. */
  renameSync(oldPath: string, newPath: string): void;
  /** Best-effort cleanup of an orphaned temp file (`writeFileAtomic` below).
   *  Callers must tolerate ENOENT — the temp file may already be gone. */
  unlinkSync(path: string): void;
}

export const realFs: CloudFs = {
  existsSync: fsExistsSync,
  readFileSync: (p, enc) => fsReadFileSync(p, enc),
  writeFileSync: (p, data, options) => fsWriteFileSync(p, data, options),
  mkdirSync: (p, options) => {
    fsMkdirSync(p, options);
  },
  chmodSync: fsChmodSync,
  renameSync: fsRenameSync,
  unlinkSync: fsUnlinkSync,
};

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/** Secret — lives ONLY in the per-user credential store, never in the project. */
export interface StoredCredential {
  /** The session/personal-access token (a SECRET). */
  access_token: string;
  token_type: string;
  /** Non-secret display prefix (e.g. `pat_ab12…`) — safe to show. */
  token_prefix?: string;
  /** The OAuth refresh token (a SECRET) — present when the credential came
   *  from the browser authorization_code flow (a2) or the RFC 8628 device
   *  grant (a3); absent for a credential minted by the legacy PAT-issuing
   *  device flow, or a machine credential (a4, `client_credentials` never
   *  returns one), which never returns one. Rotated by `lib/credential-
   *  refresh.ts`'s `ensureFreshCredential` (a5) — single-flight across every
   *  process sharing this file, cross-process advisory lock, atomic
   *  write-then-rename. */
  refresh_token?: string;
  /** Epoch ms when the token expires (absent = unknown/non-expiring). */
  expires_at?: number;
  /** b14 — epoch ms of the last successful `/oauth/token` refresh-grant use
   *  (mint counts too). The CLI-side mirror of the server's
   *  `oauth_refresh_tokens.last_used_at` (migration 038): "no successful
   *  refresh call in the window", not "the row is old" — see
   *  `credential-refresh.ts`'s `isRefreshInactive`. Absent means "no local
   *  activity history yet" (a credential written before this field existed) —
   *  deliberately NOT treated as expired; see `isRefreshInactive`'s doc for
   *  why forcing an immediate re-login on upgrade day is the wrong call. */
  last_used_at?: number;
  /** b14 — `true` when `refresh_token` has been moved OUT of this file and
   *  into the OS keychain (`lib/credential-keychain.ts`), keyed by this
   *  entry's server URL. Absent/`false` means `refresh_token` (if any) lives
   *  inline here, exactly as it did before this field existed — the
   *  documented fallback for a platform/host with no available keychain
   *  backend. Written and consumed exclusively by
   *  `credential-refresh.ts#persistCredentialSecurely`. */
  refresh_token_in_keychain?: boolean;
  /**
   * x50 — WHICH rung of the 04§4 ladder minted this credential, and therefore
   * whether a human identity exists behind it at all. `machine` is written
   * only by `cloud connect`'s machine-credential branch; ABSENT means `user`
   * (every credential written before this field existed, and every human one
   * since).
   *
   * It exists because the difference is not observable from the token: a
   * machine credential's bearer makes `GET /api/v1/me` 401 BY CONSTRUCTION
   * (its `auth.userId` is a `machine_credentials` row id, never a `users`
   * one), so a command that resolves its org through `/me` — as `department
   * status` did — reads "no identity" as "offline" forever. Recording the
   * rung at connect time is what lets a later command skip a call it already
   * knows the answer to, instead of guessing from a 401.
   */
  principal?: 'user' | 'machine';
  /** Non-secret display fields captured at connect time. */
  org_slug?: string;
  user_email?: string;
}

export interface CredentialStore {
  version: 1;
  /** Keyed by normalized control-plane base URL — one credential per server. */
  servers: Record<string, StoredCredential>;
}

/** Non-secret — safe to commit. Written to `<cwd>/.pipeline/cloud.json`. */
export interface CloudBinding {
  /** Control-plane API base URL. */
  server: string;
  /** Org slug (non-secret identifier). */
  org: string;
  /** Project slug (non-secret identifier). */
  project: string;
  /** ISO-8601 timestamp of the (re)binding. */
  connected_at: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Strip a trailing slash (and whitespace) so URL joins are unambiguous. */
export function normalizeServerUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * A conservative slug: lowercase, non-alphanumerics collapsed to single dashes,
 * leading/trailing dashes trimmed. Used to derive a default project slug from
 * the working-directory name and to sanitize an explicit --project value.
 */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Inputs needed to locate the per-user credential directory (all injectable). */
export interface HomeContext {
  platform: string;
  env: Record<string, string | undefined>;
  homedir: string;
}

/**
 * The per-user config directory that holds the credential store. Resolution:
 *   1. `PIPELINE_CLOUD_HOME` when set (explicit override / test seam);
 *   2. Windows → `%APPDATA%\claude-pipeline` (falling back to the standard
 *      Roaming path under the home dir);
 *   3. otherwise → `$XDG_CONFIG_HOME/claude-pipeline`, or `~/.config/claude-pipeline`.
 * Deliberately OUTSIDE any project tree — this is the secret half.
 */
export function credentialDir(ctx: HomeContext): string {
  const override = ctx.env[HOME_ENV];
  if (override && override.length > 0) return override;
  if (ctx.platform === 'win32') {
    const appData = ctx.env.APPDATA;
    if (appData && appData.length > 0) return join(appData, 'claude-pipeline');
    return join(ctx.homedir, 'AppData', 'Roaming', 'claude-pipeline');
  }
  const xdg = ctx.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(ctx.homedir, '.config');
  return join(base, 'claude-pipeline');
}

/** The credential-store file path (secret; per-user). */
export function credentialFilePath(ctx: HomeContext): string {
  return join(credentialDir(ctx), 'credentials.json');
}

/** The cross-process advisory lock guarding the credential store's whole
 *  read-refresh-write cycle (a5, 04-cloud-auth.md §6). Lives beside the
 *  store in the same per-user directory — see `lib/credential-lock.ts` for
 *  the locking mechanism and `lib/credential-refresh.ts` for the one code
 *  path allowed to use it. */
export function credentialLockPath(ctx: HomeContext): string {
  return join(credentialDir(ctx), 'credentials.lock');
}

/** b15 — the per-install fingerprint-salt file (07-security.md T16/SG13):
 *  a CSPRNG secret that replaces `run-identity.ts`'s public
 *  `DEFAULT_FINGERPRINT_SALT` when available, closing the dictionary-attack
 *  gap the public constant documents about itself. Lives beside the
 *  credential store in the SAME per-user directory — one protected location,
 *  not a second one — and is written/protected exactly like it (see
 *  `lib/fingerprint-salt.ts#loadOrCreateInstallSalt`, which reuses
 *  `writeSecretFileAtomic` and `credential-protect.ts#protectCredentialFile`
 *  verbatim). */
export function fingerprintSaltFilePath(ctx: HomeContext): string {
  return join(credentialDir(ctx), 'fingerprint-salt.json');
}

/** The project binding path — resolved against the consumer project's cwd. */
export function cloudJsonPath(cwd: string): string {
  return join(cwd, '.pipeline', 'cloud.json');
}

/** Default project slug when --project is omitted: the cwd's directory name. */
export function defaultProjectSlug(cwd: string): string {
  return slugify(basename(cwd));
}

// ---------------------------------------------------------------------------
// Credential store I/O (the SECRET half — restrictive perms)
// ---------------------------------------------------------------------------

export function readCredentialStore(fs: CloudFs, filePath: string): CredentialStore {
  if (!fs.existsSync(filePath)) return { version: 1, servers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    throw new CloudError(
      `credential store at ${filePath} is corrupt (invalid JSON) — inspect or delete it, then retry`,
    );
  }
  const obj = parsed as Partial<CredentialStore> | null;
  const servers =
    obj && typeof obj === 'object' && obj.servers && typeof obj.servers === 'object'
      ? (obj.servers as Record<string, StoredCredential>)
      : {};
  return { version: 1, servers };
}

/**
 * Write `data` durably: create a uniquely-named temp file IN THE SAME
 * DIRECTORY (same filesystem — required for `renameSync` to be atomic; a
 * cross-filesystem rename can silently fall back to copy+delete on some
 * platforms, which would reopen the exact half-written-file window this
 * exists to close) and rename it over `filePath`. A process killed at any
 * point either: never created the temp file (original untouched), created
 * it but never renamed (original untouched, an orphan temp file left
 * behind — harmless, never read by anything), or completed the rename (new
 * file fully in place). `filePath` itself is NEVER observed half-written
 * (a5 DoD box 2).
 */
function writeFileAtomic(fs: CloudFs, filePath: string, data: string, mode: number): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.${basename(filePath)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tmpPath, data, { mode });
    fs.chmodSync(tmpPath, mode); // defeat umask before the rename makes it visible under the real name
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup only — surface the ORIGINAL error either way
    }
    throw e;
  }
}

/**
 * Persist ANY secret file durably and with restrictive perms: the directory
 * is created 0700, the content lands via `writeFileAtomic` (write temp +
 * rename — a5 DoD box 2), and the final path is chmod'd 0600 again to defeat
 * umask and to tighten a pre-existing file at this path. On Windows, `chmod`
 * only ever toggles the read-only DOS attribute — it does NOT restrict which
 * OTHER accounts can read the file (NTFS uses ACLs, not POSIX mode bits).
 * That is a SEPARATE, Windows-only control — see `lib/credential-
 * protect.ts`'s `protectCredentialFile`, which every writer of a secret file
 * (`commands/cloud.ts`, `lib/credential-refresh.ts`, b15's `lib/fingerprint-
 * salt.ts`) calls explicitly right after this function, keyed off the
 * CALLER's injected platform rather than the real OS — this function
 * intentionally does not do it itself, so it stays a pure, always-safe-to-
 * call primitive with no implicit dependency on `process.platform`.
 *
 * ONE storage mechanism for every secret this package persists at rest —
 * `writeCredentialStore` below is just this function plus JSON framing, and
 * b15's per-install fingerprint salt reuses it directly rather than
 * inventing a second write path.
 */
export function writeSecretFileAtomic(fs: CloudFs, filePath: string, data: string): void {
  const dir = dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(fs, filePath, data, 0o600);
  fs.chmodSync(filePath, 0o600);
}

/**
 * Persist the credential store durably and with restrictive perms — see
 * `writeSecretFileAtomic` for the mechanism; this is just that function plus
 * the store's JSON framing. On Windows, `chmod` only ever toggles the
 * read-only DOS attribute — it does NOT restrict which OTHER accounts can
 * read the file (NTFS uses ACLs, not POSIX mode bits). That is a SEPARATE,
 * Windows-only control — see `lib/credential-protect.ts`'s
 * `protectCredentialFile`, which every writer of this store
 * (`commands/cloud.ts`, `lib/credential-refresh.ts`) calls explicitly right
 * after this function, keyed off the CALLER's injected platform rather than
 * the real OS — this function intentionally does not do it itself, so it
 * stays a pure, always-safe-to-call primitive with no implicit dependency on
 * `process.platform`.
 */
export function writeCredentialStore(
  fs: CloudFs,
  filePath: string,
  store: CredentialStore,
): void {
  writeSecretFileAtomic(fs, filePath, JSON.stringify(store, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Project binding I/O (the NON-SECRET half — safe to commit)
// ---------------------------------------------------------------------------

export function readCloudBinding(fs: CloudFs, filePath: string): CloudBinding | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CloudBinding;
    if (obj && typeof obj === 'object' && typeof obj.server === 'string') return obj;
  } catch {
    // A malformed existing binding is treated as "not connected" — connect
    // overwrites it with a well-formed one rather than failing.
  }
  return null;
}

/**
 * Write the non-secret project binding. Guards, as defense-in-depth, that no
 * obviously-secret field ever reaches this file — the binding type has no such
 * field, so this only fires on a programming error.
 */
export function writeCloudBinding(fs: CloudFs, filePath: string, binding: CloudBinding): void {
  const serialized = JSON.stringify(binding, null, 2) + '\n';
  const dir = dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, serialized);
}
