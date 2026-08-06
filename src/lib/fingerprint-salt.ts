// fingerprint-salt.ts — the per-install secret salt for the project
// fingerprint (b15, 07-security.md T16/SG13, ROADMAP `SALT-1`: "ship a
// per-install secret").
//
// WHY THIS EXISTS. `run-identity.ts`'s `DEFAULT_FINGERPRINT_SALT` is a
// PUBLIC constant, and the file says so about itself: "anyone with this repo
// could hash a guessed remote/path under it" — the fingerprint is
// dictionary-attackable for any guessable git remote or project path (T16).
// A per-install secret salt closes that: the same identifier now hashes to a
// value nobody outside this machine can reproduce without ALSO exfiltrating
// this file. It does not make the fingerprint anonymous — it is, at best,
// pseudonymous even with a strong salt, because the cloud can still group
// every run from one install together. It removes the GUESSING attack, not
// the linkability the fingerprint exists to provide.
//
// STORAGE reuses b14's at-rest machinery EXACTLY — no second mechanism, no
// second protection path:
//   - the same atomic write-then-rename + chmod 0600 dance as the credential
//     store (`cloud-config.ts#writeSecretFileAtomic`, extracted FROM
//     `writeCredentialStore` specifically so this file can reuse it byte for
//     byte instead of duplicating the durability logic);
//   - the same Windows ACL lockdown as the credential store
//     (`credential-protect.ts#protectCredentialFile`), called explicitly
//     right after the write — the same "every writer of a secret file calls
//     this itself" discipline `credential-refresh.ts` already documents;
//   - the same per-user directory as the credential store
//     (`cloud-config.ts#credentialDir` / `fingerprintSaltFilePath`) — one
//     protected directory, one ACL surface, not a second location to reason
//     about.
//
// GENERATION is CSPRNG only (`node:crypto`'s `randomBytes` — NEVER
// `Math.random`, which is not cryptographically secure and must not key an
// HMAC meant to resist a guessing attack). Generated ONCE per install, on
// first use if the file does not yet exist, then persisted so every later
// run reuses the SAME salt — a fingerprint that changed every run would
// defeat the per-project grouping it exists to support.
//
// THE FALLBACK CONTRACT mirrors `credential-keychain.ts`'s documented one:
// `loadOrCreateInstallSalt` NEVER throws. A pre-b15 install, a read-only
// home directory, a corrupt salt file, or a failed Windows ACL call all
// collapse to the SAME outcome — `undefined` — which `run-identity.ts`'s
// `resolveSalt` treats as "no per-install salt available" and falls back to
// `DEFAULT_FINGERPRINT_SALT`, exactly as every install behaved before this
// file existed. An optional hardening layer must not become a new way for an
// ordinary run to fail outright.
//
// NEVER UPLOADED: the resolved salt only ever keys an HMAC
// (`run-identity.ts#computeProjectFingerprint`) — it never becomes a field of
// `RunIdentity` or any other returned/emitted value, so there is no return
// value, event payload, or telemetry record it could leak through even by
// accident. This module has no knowledge of, and no path to, the telemetry
// upload pipeline at all.
//
// THE FINGERPRINT DISCONTINUITY THIS CAUSES IS ACCEPTED, NOT MIGRATED: a
// project fingerprinted under the retired public constant before this task
// will fingerprint differently after it generates its install salt. Owner
// decision (SALT-1, 2026-08-06) — production holds 8 runs and zero users, so
// there is no correlation history worth preserving, and "migrating" would
// mean carrying the retired, dictionary-attackable constant forward as if it
// still deserved trust.

import { randomBytes } from 'node:crypto';
import {
  fingerprintSaltFilePath,
  writeSecretFileAtomic,
  type CloudFs,
  type HomeContext,
} from './cloud-config';
import { protectCredentialFile, type ProtectDeps } from './credential-protect';

const CURRENT_VERSION = 1;

interface SaltFile {
  version: 1;
  /** Lowercase hex, always 64 chars (32 CSPRNG bytes — see `SALT_BYTES`). */
  salt: string;
}

/** 32 bytes (256 bits) — matches the key material an HMAC-SHA-256 can use in
 *  full (`computeProjectFingerprint`); more would not add resistance, less
 *  would leave security on the table for a value this cheap to generate. */
const SALT_BYTES = 32;

const HEX64 = /^[0-9a-f]{64}$/;

/** Injectable so tests never depend on real entropy or its timing; always
 *  `node:crypto`'s `randomBytes` in production — the CSPRNG this task
 *  requires (`Math.random` must never be used to key an HMAC). */
export type RandomBytesFn = (size: number) => Buffer;

export interface InstallSaltDeps {
  fs: CloudFs;
  platform: string;
  env: Record<string, string | undefined>;
  homedir: string;
  /** Defaults to `node:crypto`'s `randomBytes`. */
  randomBytes?: RandomBytesFn;
  /** Defaults to `protectCredentialFile` — injected so non-Windows and test
   *  platforms can assert the ACL step without a real NTFS ACL system, the
   *  same seam `credential-refresh.ts` already uses for the same function. */
  protect?: (filePath: string, deps: ProtectDeps) => void;
}

function parseSaltFile(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const obj = parsed as Partial<SaltFile> | null;
  if (obj && typeof obj === 'object' && typeof obj.salt === 'string' && HEX64.test(obj.salt)) {
    return obj.salt;
  }
  return undefined;
}

/**
 * Read the existing per-install salt, or generate one with a CSPRNG and
 * persist it under b14's at-rest protection, then return it. NEVER throws —
 * every failure mode (a permission error reading or writing, a corrupt or
 * foreign file at this path, a failed Windows ACL call) is swallowed and
 * `undefined` is returned; `run-identity.ts#resolveSalt` reads that as "no
 * per-install salt available" and falls back to `DEFAULT_FINGERPRINT_SALT`
 * with no error surfaced anywhere.
 *
 * A write that succeeds but whose FOLLOW-UP `protectCredentialFile` call
 * fails is treated as a total failure, not a partial success: the just-
 * written file is best-effort deleted and `undefined` is returned. Returning
 * the salt anyway would persist an UNPROTECTED secret that this function
 * would then keep silently reusing forever (existence alone short-circuits
 * every later call before it ever re-attempts the ACL step) — worse than the
 * public-constant fallback it was meant to improve on. Deleting it instead
 * means the NEXT call retries the whole thing from a clean slate.
 */
export function loadOrCreateInstallSalt(deps: InstallSaltDeps): string | undefined {
  const ctx: HomeContext = { platform: deps.platform, env: deps.env, homedir: deps.homedir };
  const filePath = fingerprintSaltFilePath(ctx);

  try {
    if (deps.fs.existsSync(filePath)) {
      const existing = parseSaltFile(deps.fs.readFileSync(filePath, 'utf-8'));
      if (existing) return existing;
      // Corrupt or foreign content at this path — fall through and
      // regenerate rather than wedging every future run on a bad file.
    }
  } catch {
    // Could not even READ an existing file (e.g. permission denied) — do not
    // also attempt to overwrite it; just report "unavailable this run".
    return undefined;
  }

  try {
    const gen = deps.randomBytes ?? randomBytes;
    const salt = gen(SALT_BYTES).toString('hex');
    const file: SaltFile = { version: CURRENT_VERSION, salt };
    writeSecretFileAtomic(deps.fs, filePath, JSON.stringify(file, null, 2) + '\n');
    const protect = deps.protect ?? protectCredentialFile;
    try {
      protect(filePath, { platform: deps.platform, env: deps.env });
    } catch {
      try {
        deps.fs.unlinkSync(filePath);
      } catch {
        // best-effort cleanup only — the outer `undefined` return is what matters
      }
      return undefined;
    }
    return salt;
  } catch {
    return undefined;
  }
}
