// cloud-config.ts — filesystem + path helpers for `pipeline cloud connect`.
//
// TWO stores, deliberately separate (the load-bearing security split of T1-16):
//
//  1. The project binding — `<cwd>/.claude/pipeline/cloud.json`. Holds ONLY
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
} from 'node:fs';
import { dirname, join, basename } from 'node:path';

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
}

export const realFs: CloudFs = {
  existsSync: fsExistsSync,
  readFileSync: (p, enc) => fsReadFileSync(p, enc),
  writeFileSync: (p, data, options) => fsWriteFileSync(p, data, options),
  mkdirSync: (p, options) => {
    fsMkdirSync(p, options);
  },
  chmodSync: fsChmodSync,
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
  /** Epoch ms when the token expires (absent = unknown/non-expiring). */
  expires_at?: number;
  /** Non-secret display fields captured at connect time. */
  org_slug?: string;
  user_email?: string;
}

export interface CredentialStore {
  version: 1;
  /** Keyed by normalized control-plane base URL — one credential per server. */
  servers: Record<string, StoredCredential>;
}

/** Non-secret — safe to commit. Written to `<cwd>/.claude/pipeline/cloud.json`. */
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

/** The project binding path — resolved against the consumer project's cwd. */
export function cloudJsonPath(cwd: string): string {
  return join(cwd, '.claude', 'pipeline', 'cloud.json');
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
 * Persist the credential store with restrictive perms: the directory is created
 * 0700 and the file written 0600, then chmod'd 0600 again to defeat umask and
 * to tighten a pre-existing file. (On Windows the mode is a near-no-op but the
 * call is harmless — tests assert the requested mode regardless of OS.)
 */
export function writeCredentialStore(
  fs: CloudFs,
  filePath: string,
  store: CredentialStore,
): void {
  const dir = dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
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
