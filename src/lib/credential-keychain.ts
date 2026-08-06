// credential-keychain.ts — OS keychain storage for the refresh token half of
// the credential store (b14, 07-security.md §3.3: "OS keychain where
// available, with a documented fallback").
//
// WHY THIS EXISTS. `credential-protect.ts` / `cloud-config.ts#writeCredentialStore`
// already stop OTHER LOCAL ACCOUNTS from reading `credentials.json` (chmod
// 0600 + a Windows ACL). That is necessary but not sufficient against the
// file-theft case `07-security.md` §3.3 weighs honestly: a copy of the file
// itself (a backup, a synced folder, a stolen disk image) still hands over
// the 30-day refresh token verbatim. Moving the refresh token OUT of the file
// and into the platform's own secret-storage service closes that gap for the
// two platforms that have a scriptable one:
//
//   - macOS:  the login Keychain, via the `security` CLI (ships with every
//             Mac — no new dependency).
//   - Linux:  the freedesktop Secret Service, via `secret-tool` (part of
//             `libsecret-tools` / `gnome-keyring` — commonly present on a
//             desktop, but NOT guaranteed, e.g. a headless server or a
//             minimal container has neither the binary nor a running
//             Service).
//   - Windows: NO scriptable read-back exists without a new dependency.
//             `cmdkey` can WRITE a Credential Manager entry but cannot read
//             one back (`cmdkey /list` shows metadata only, never the
//             secret); DPAPI is reachable from PowerShell but that is a
//             per-blob encryption primitive, not a keyed secret-storage
//             service, and 04-cloud-auth.md §6 already names the ACL path
//             ("a per-user ACL (or DPAPI) on Windows") as satisfying the
//             FILE-PROTECTION requirement, which `credential-protect.ts`
//             ships today. So Windows is `platform: 'none'` here BY DESIGN,
//             not an oversight — its documented fallback is that existing,
//             already-shipped, already-tested ACL-protected file.
//
// THE FALLBACK CONTRACT: every function below returns a plain success/failure
// signal and NEVER throws for "the backend isn't available or the call
// failed" — an absent binary (ENOENT), no running Secret Service, a locked
// keychain, or simply running on win32/an unknown platform are all the SAME
// outcome to a caller: keep the secret in the permission-protected file
// exactly as this package already did before this task. A thrown exception
// here would turn an optional hardening layer into a new way for `pipeline
// cloud connect` to fail outright, which is the wrong trade for a SHOULD-level
// control.
//
// Gated on the CALLER's injected `platform` string, never the real
// `process.platform` — the same discipline `credential-protect.ts` already
// documents and tests (`platform: 'linux'/'darwin'` in test deps, never a
// real-OS branch hidden inside production logic).

import { spawnSync } from 'node:child_process';

export interface KeychainCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface KeychainDeps {
  platform: string;
  /** Runs `cmd args…`, optionally piping `input` to stdin (used by
   *  `secret-tool store`, which reads the secret from stdin rather than
   *  argv — deliberately, so it never shows up in `ps`). Defaults to a real
   *  subprocess (`realRunKeychainCommand`); injectable so every other
   *  platform's tests can assert the exact invocation without a real OS
   *  keychain to observe it against. */
  runCommand?: (cmd: string, args: string[], opts?: { input?: string }) => KeychainCommandResult;
}

/** A command that does not exist on PATH (ENOENT) is the expected shape of
 *  "this backend isn't installed", not an exceptional condition — `status:
 *  null` mirrors `credential-protect.ts`'s `IcaclsResult` treatment of a
 *  spawn failure, so callers have one signal ("non-zero/null status") to
 *  check rather than a try/catch around every call site. */
export const realRunKeychainCommand = (
  cmd: string,
  args: string[],
  opts?: { input?: string },
): KeychainCommandResult => {
  const res = spawnSync(cmd, args, { windowsHide: true, encoding: 'utf-8', input: opts?.input });
  if (res.error) {
    return { status: null, stdout: '', stderr: String(res.error) };
  }
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

/** The one service name every entry this package ever writes is filed under
 *  — a stable string so `find`/`lookup`/`clear` always target exactly what
 *  `store` created. */
const SERVICE = 'ai-pipeline-cli-credential';

export type KeychainBackend = 'macos' | 'linux-secret-service' | 'none';

/**
 * Which backend applies to `platform` — pure, and the single place the
 * platform→backend mapping is decided (every function below routes through
 * it, so the "Windows has no keychain here" decision lives in exactly one
 * spot).
 */
export function keychainBackendFor(platform: string): KeychainBackend {
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux-secret-service';
  return 'none';
}

function runner(deps: KeychainDeps): (cmd: string, args: string[], opts?: { input?: string }) => KeychainCommandResult {
  return deps.runCommand ?? realRunKeychainCommand;
}

/**
 * Store `secret` under `account` in the platform's OS keychain. Returns
 * `true` only on a confirmed successful write; `false` for EVERY other
 * outcome (unsupported platform, missing binary, a locked keychain, no
 * Secret Service session, any non-zero exit) — the documented fallback case,
 * never a throw (see module doc).
 */
export function storeInKeychain(deps: KeychainDeps, account: string, secret: string): boolean {
  const backend = keychainBackendFor(deps.platform);
  const run = runner(deps);
  try {
    if (backend === 'macos') {
      // `-U` = update in place if an entry for this account+service already
      // exists, rather than failing with "already exists" on a second
      // connect. The secret must be an argv value — the `security` CLI has
      // no stdin form for `-w` — so it is BRIEFLY visible to `ps` on this
      // one call, the same documented trade-off `commands/cloud.ts` already
      // accepts for `--machine-token`.
      const res = run('security', ['add-generic-password', '-a', account, '-s', SERVICE, '-w', secret, '-U']);
      return res.status === 0;
    }
    if (backend === 'linux-secret-service') {
      // `secret-tool store` reads the secret from STDIN, never argv.
      const res = run(
        'secret-tool',
        ['store', '--label', `${SERVICE} (${account})`, 'service', SERVICE, 'account', account],
        { input: secret },
      );
      return res.status === 0;
    }
    return false;
  } catch {
    // Belt-and-braces: `runCommand` is caller-injectable and this function's
    // whole contract is "never throws" — a broken injected fake or an
    // unexpected native error both collapse to "unavailable, use the file".
    return false;
  }
}

/**
 * Read the secret back. Returns `undefined` for every non-success outcome —
 * identical fallback contract to {@link storeInKeychain}: a missing entry, a
 * missing binary, or an unsupported platform are indistinguishable to the
 * caller, which always has the file-based value to fall back to.
 */
export function readFromKeychain(deps: KeychainDeps, account: string): string | undefined {
  const backend = keychainBackendFor(deps.platform);
  const run = runner(deps);
  try {
    if (backend === 'macos') {
      const res = run('security', ['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
      if (res.status !== 0) return undefined;
      const value = res.stdout.replace(/\r?\n$/, '');
      return value.length > 0 ? value : undefined;
    }
    if (backend === 'linux-secret-service') {
      const res = run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
      if (res.status !== 0) return undefined;
      const value = res.stdout.replace(/\r?\n$/, '');
      return value.length > 0 ? value : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort removal of a stored entry. Never throws and its result is not
 * observable to callers — used only as hygiene (e.g. so a superseded entry
 * does not linger); nothing in this package's correctness depends on a
 * delete actually landing.
 */
export function deleteFromKeychain(deps: KeychainDeps, account: string): void {
  const backend = keychainBackendFor(deps.platform);
  const run = runner(deps);
  try {
    if (backend === 'macos') {
      run('security', ['delete-generic-password', '-a', account, '-s', SERVICE]);
    } else if (backend === 'linux-secret-service') {
      run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
    }
  } catch {
    // best-effort only
  }
}
