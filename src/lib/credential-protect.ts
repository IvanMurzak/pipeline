// credential-protect.ts — Windows-real per-user file protection for the
// credential store (a5, 04-cloud-auth.md §6): "`0600` is meaningless on the
// Windows path — NTFS uses ACLs... a per-user ACL (or DPAPI) on Windows...
// stated that way so an implementer does not ship a no-op `chmod`."
//
// `cloud-config.ts`'s `writeCredentialStore` already does the POSIX half
// (`chmod 0600`, untouched by this file — `fs.chmodSync` on win32 only ever
// toggles the read-only DOS attribute, which gates WRITE access for the SAME
// user, not READ access for OTHER accounts; it is a documented no-op against
// the actual threat this task exists to close). This file is ONLY the
// Windows half: it shells out to `icacls` (shipped with every supported
// Windows version — no new dependency) to replace the file's ACL with
// exactly one entry, the current user, Full Control.
//
// Called EXPLICITLY by every writer of the credential store
// (`commands/cloud.ts`, `lib/credential-refresh.ts`) right after
// `writeCredentialStore`, keyed off the CALLER's injected platform — never
// invoked implicitly off the real `process.platform`, so it stays fully
// testable with a fake platform string exactly like every other side effect
// in this codebase (see `cloud.test.ts`'s `platform: 'linux'`/`'darwin'`
// convention).

import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { CloudError } from './cloud-config';

export interface IcaclsResult {
  status: number | null;
  stderr: string;
}

export interface ProtectDeps {
  platform: string;
  env: Record<string, string | undefined>;
  /** Runs `icacls <args>`. Defaults to a real subprocess (`realRunIcacls`);
   *  injectable so non-Windows hosts and unit tests can assert the exact
   *  invocation without a real NTFS ACL system to observe it against. */
  runIcacls?: (args: string[]) => IcaclsResult;
}

/** A `ProtectDeps` failure IS a `CloudError` — `runCloud`'s existing
 *  `instanceof CloudError` catch already maps it to a clean exit-1 message,
 *  never a raw stack trace, with no extra wiring at any call site. A
 *  security control that fails open (silently leaving a looser, inherited
 *  ACL in place) is worse than one that fails loud, so this throws rather
 *  than swallowing an `icacls` failure. */
export class ProtectError extends CloudError {
  constructor(message: string) {
    super(message);
    this.name = 'ProtectError';
  }
}

export const realRunIcacls = (args: string[]): IcaclsResult => {
  const res = spawnSync('icacls', args, { windowsHide: true, encoding: 'utf-8' });
  return { status: res.status, stderr: res.stderr ?? (res.error ? String(res.error) : '') };
};

/** `DOMAIN\user`, or bare `user` when no domain is set (the common case on a
 *  personal machine) — both forms are accepted by `icacls`'s `/grant`
 *  syntax. Falls back to `os.userInfo()` only when neither env var is
 *  present (a child process with a scrubbed environment); on real Windows
 *  this should not happen, but must not crash if it does. */
function resolveCurrentUser(env: Record<string, string | undefined>): string {
  const user = env.USERNAME;
  const domain = env.USERDOMAIN;
  if (user && domain) return `${domain}\\${user}`;
  if (user) return user;
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

/**
 * Restrict `filePath` to the CURRENT user only. No-op on every platform
 * except `win32` (POSIX gets its restriction from `chmod 0600`, done by the
 * caller via `writeCredentialStore`). Two `icacls` calls:
 *   1. `/inheritance:r` — strip every ACE the file inherited from its parent
 *      directory (which, depending on the parent's own ACL, could include
 *      broader groups like "Users" or "Authenticated Users").
 *   2. `/grant:r <user>:F` — REPLACE every explicit ACE with exactly one:
 *      the current user, Full Control.
 * After both, no other Windows account (besides an Administrator taking
 * ownership — no ACL on Windows survives that) has any access entry on the
 * file at all. Throws `ProtectError` on failure (missing `icacls`, an
 * unresolvable current user, or either call exiting non-zero).
 */
export function protectCredentialFile(filePath: string, deps: ProtectDeps): void {
  if (deps.platform !== 'win32') return;
  const runIcacls = deps.runIcacls ?? realRunIcacls;
  const user = resolveCurrentUser(deps.env);
  if (!user) {
    throw new ProtectError(
      `could not determine the current Windows account to restrict ${filePath} to (USERNAME unset)`,
    );
  }
  const strip = runIcacls([filePath, '/inheritance:r']);
  if (strip.status !== 0) {
    throw new ProtectError(
      `icacls /inheritance:r failed for ${filePath}: ${strip.stderr.trim() || `exit ${strip.status}`}`,
    );
  }
  const grant = runIcacls([filePath, '/grant:r', `${user}:F`]);
  if (grant.status !== 0) {
    throw new ProtectError(
      `icacls /grant:r failed for ${filePath}: ${grant.stderr.trim() || `exit ${grant.status}`}`,
    );
  }
}
