// provider-key.test.ts — c1: the four-rung provider-key ladder and its single
// owning module (`src/lib/provider-key.ts`,
// `.taskflow/2026-08-03-execution-modes/02-standalone-executor.md` "Key
// handling (K-1, resolved)").
//
// ⚠ NO REAL CREDENTIAL APPEARS ANYWHERE IN THIS FILE. Every value below is an
// obviously-synthetic placeholder built from `PLACEHOLDER-NOT-A-REAL-KEY-…`
// and deliberately carries NO provider key prefix, so it cannot be mistaken
// for a live credential by a human, a secret scanner, or a future reader
// copying a line out of here. The tests care about IDENTITY and ABSENCE of
// these strings, never about their shape.
//
// The structural half of "exactly one module holds the key" — that no OTHER
// file may call `revealProviderKey` — lives in
// `provider-key-ownership.test.ts`, because it is a source-tree assertion
// rather than a behavioural one.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_HELPER_TIMEOUT_MS,
  PROVIDER_ID,
  PROVIDER_KEY_ENV,
  PROVIDER_KEY_FLAG,
  PROVIDER_KEY_HELPER_ENV,
  PROVIDER_KEY_KEYCHAIN_ACCOUNT,
  ProviderKey,
  ProviderKeyError,
  REDACTED,
  describeProviderKey,
  extractProviderKeyFlag,
  persistProviderKey,
  requireProviderKey,
  resolveProviderKey,
  revealProviderKey,
  type HelperCommandResult,
  type ProviderKeyDeps,
  type RunHelperCommand,
} from '../src/lib/provider-key';
import { dirname } from 'node:path';
import {
  credentialFilePath,
  readCredentialStore,
  writeCredentialStore,
  type CloudFs,
  type HomeContext,
} from '../src/lib/cloud-config';
import type { KeychainCommandResult } from '../src/lib/credential-keychain';

// ---------------------------------------------------------------------------
// Synthetic values — see the file header
// ---------------------------------------------------------------------------

const FLAG_VALUE = 'PLACEHOLDER-NOT-A-REAL-KEY-from-the-flag';
const HELPER_VALUE = 'PLACEHOLDER-NOT-A-REAL-KEY-from-the-helper';
const ENV_VALUE = 'PLACEHOLDER-NOT-A-REAL-KEY-from-the-environment';
const STORE_VALUE = 'PLACEHOLDER-NOT-A-REAL-KEY-from-the-store';
const KEYCHAIN_VALUE = 'PLACEHOLDER-NOT-A-REAL-KEY-from-the-keychain';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface MemFs {
  fs: CloudFs;
  files: Map<string, string>;
  dirs: Set<string>;
  writes: Array<{ path: string; mode?: number }>;
  chmods: Array<{ path: string; mode: number }>;
  renames: Array<{ from: string; to: string }>;
  mkdirs: Array<{ path: string; mode?: number }>;
  reads: string[];
}

/** An in-memory `CloudFs` that records every mode, rename and mkdir — the
 *  same properties `cloud.test.ts`'s `recordingFs` asserts for the credential
 *  store, kept in memory here so a test can also assert on the exact BYTES
 *  that would land on disk. */
function memFs(seed: Record<string, string> = {}): MemFs {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  const m: MemFs = {
    files,
    dirs,
    writes: [],
    chmods: [],
    renames: [],
    mkdirs: [],
    reads: [],
    fs: {
      existsSync: (p) => files.has(p) || dirs.has(p),
      readFileSync: (p) => {
        m.reads.push(p);
        const v = files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
      },
      writeFileSync: (p, data, options) => {
        m.writes.push({ path: p, mode: options?.mode });
        files.set(p, data);
      },
      mkdirSync: (p, options) => {
        m.mkdirs.push({ path: p, mode: options.mode });
        dirs.add(p);
      },
      chmodSync: (p, mode) => {
        m.chmods.push({ path: p, mode });
      },
      renameSync: (from, to) => {
        m.renames.push({ from, to });
        const v = files.get(from);
        if (v === undefined) throw new Error(`ENOENT: ${from}`);
        files.set(to, v);
        files.delete(from);
      },
      unlinkSync: (p) => {
        files.delete(p);
      },
    },
  };
  return m;
}

const HOME = '/fake-home/claude-pipeline';

function homeCtx(platform = 'linux'): HomeContext {
  return { platform, env: { PIPELINE_CLOUD_HOME: HOME }, homedir: '/fake-home' };
}

/** The credential-store path every test asserts against — derived from the
 *  SAME function the cloud credential store uses, which is how "no second
 *  store" is asserted rather than assumed. */
function credPath(platform = 'linux'): string {
  return credentialFilePath(homeCtx(platform));
}

interface DepsOpts {
  platform?: string;
  env?: Record<string, string | undefined>;
  fsSeed?: Record<string, string>;
  runHelper?: RunHelperCommand;
  keychainRun?: (cmd: string, args: string[], opts?: { input?: string }) => KeychainCommandResult;
  keychainPlatform?: string;
}

interface Harness {
  deps: ProviderKeyDeps;
  mem: MemFs;
  helperCalls: Array<{ command: string; timeoutMs: number; platform: string }>;
  keychainCalls: Array<{ cmd: string; args: string[]; input?: string }>;
  protectCalls: Array<{ path: string; platform: string }>;
}

function harness(opts: DepsOpts = {}): Harness {
  const platform = opts.platform ?? 'linux';
  const mem = memFs(opts.fsSeed);
  const helperCalls: Harness['helperCalls'] = [];
  const keychainCalls: Harness['keychainCalls'] = [];
  const protectCalls: Harness['protectCalls'] = [];
  const env = { PIPELINE_CLOUD_HOME: HOME, ...(opts.env ?? {}) };
  const deps: ProviderKeyDeps = {
    platform,
    env,
    homedir: '/fake-home',
    fs: mem.fs,
    runHelper: (command, o) => {
      helperCalls.push({ command, timeoutMs: o.timeoutMs, platform: o.platform });
      if (!opts.runHelper) throw new Error('no runHelper scripted for this test');
      return opts.runHelper(command, o);
    },
    keychain: {
      platform: opts.keychainPlatform ?? platform,
      runCommand: (cmd, args, o) => {
        keychainCalls.push({ cmd, args, input: o?.input });
        return opts.keychainRun
          ? opts.keychainRun(cmd, args, o)
          : { status: 1, stdout: '', stderr: '' };
      },
    },
    protect: (path, d) => {
      protectCalls.push({ path, platform: d.platform });
    },
    now: () => 1_700_000_000_000,
  };
  return { deps, mem, helperCalls, keychainCalls, protectCalls };
}

/** Seed a credential store file holding an INLINE provider key (rung 4's
 *  file-backed shape). */
function seedInlineStore(value: string, platform = 'linux'): Record<string, string> {
  return {
    [credPath(platform)]:
      JSON.stringify(
        { version: 1, servers: {}, provider_keys: { [PROVIDER_ID]: { api_key: value, in_keychain: false } } },
        null,
        2,
      ) + '\n',
  };
}

const ok = (stdout: string): HelperCommandResult => ({ status: 0, stdout, stderr: '' });

// ---------------------------------------------------------------------------
// Every rung resolves
// ---------------------------------------------------------------------------

describe('the ladder — each of the four rungs resolves a key', () => {
  test('rung 1 — an explicit flag on the invocation', () => {
    const { deps } = harness();
    const { key } = extractProviderKeyFlag(['drive', PROVIDER_KEY_FLAG, FLAG_VALUE, '--json']);
    const resolved = resolveProviderKey(deps, { flagKey: key });
    expect(resolved?.source).toBe('flag');
    expect(revealProviderKey(resolved!)).toBe(FLAG_VALUE);
  });

  test('rung 2 — a helper command whose stdout is the key', () => {
    const h = harness({
      env: { [PROVIDER_KEY_HELPER_ENV]: 'op read op://Private/anthropic/credential' },
      runHelper: () => ok(`${HELPER_VALUE}\n`),
    });
    const resolved = resolveProviderKey(h.deps);
    expect(resolved?.source).toBe('helper');
    expect(revealProviderKey(resolved!)).toBe(HELPER_VALUE);
    expect(h.helperCalls).toEqual([
      { command: 'op read op://Private/anthropic/credential', timeoutMs: DEFAULT_HELPER_TIMEOUT_MS, platform: 'linux' },
    ]);
  });

  test('rung 3 — ANTHROPIC_API_KEY in the environment', () => {
    const { deps } = harness({ env: { [PROVIDER_KEY_ENV]: ENV_VALUE } });
    const resolved = resolveProviderKey(deps);
    expect(resolved?.source).toBe('env');
    expect(revealProviderKey(resolved!)).toBe(ENV_VALUE);
  });

  test('rung 4 — our credential store, inline', () => {
    const { deps } = harness({ fsSeed: seedInlineStore(STORE_VALUE) });
    const resolved = resolveProviderKey(deps);
    expect(resolved?.source).toBe('store');
    expect(revealProviderKey(resolved!)).toBe(STORE_VALUE);
  });

  test('rung 4 — our credential store, value held in the OS keychain', () => {
    const h = harness({
      fsSeed: {
        [credPath()]:
          JSON.stringify({ version: 1, servers: {}, provider_keys: { [PROVIDER_ID]: { in_keychain: true } } }) + '\n',
      },
      keychainRun: () => ({ status: 0, stdout: `${KEYCHAIN_VALUE}\n`, stderr: '' }),
    });
    const resolved = resolveProviderKey(h.deps);
    expect(resolved?.source).toBe('store');
    expect(revealProviderKey(resolved!)).toBe(KEYCHAIN_VALUE);
    // Read through the SAME keychain module the refresh token uses, under the
    // provider-scoped account name.
    expect(h.keychainCalls[0]?.cmd).toBe('secret-tool');
    expect(h.keychainCalls[0]?.args).toContain(PROVIDER_KEY_KEYCHAIN_ACCOUNT);
  });

  test('no rung configured at all → undefined, not an error', () => {
    const { deps } = harness();
    expect(resolveProviderKey(deps)).toBeUndefined();
  });

  test('requireProviderKey turns "nothing configured" into one message naming all four rungs', () => {
    const { deps } = harness();
    let msg = '';
    try {
      requireProviderKey(deps);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(PROVIDER_KEY_FLAG);
    expect(msg).toContain(PROVIDER_KEY_HELPER_ENV);
    expect(msg).toContain(PROVIDER_KEY_ENV);
    expect(msg).toContain('credential store');
  });
});

// ---------------------------------------------------------------------------
// First match wins — every ADJACENT pair, plus the full stack
// ---------------------------------------------------------------------------

describe('first match wins — precedence between adjacent rungs', () => {
  test('1 over 2 — the flag wins and the helper is NEVER RUN', () => {
    const h = harness({
      env: { [PROVIDER_KEY_HELPER_ENV]: 'op read op://Private/anthropic/credential' },
      runHelper: () => ok(HELPER_VALUE),
    });
    const { key } = extractProviderKeyFlag([PROVIDER_KEY_FLAG, FLAG_VALUE]);
    const resolved = resolveProviderKey(h.deps, { flagKey: key });
    expect(resolved?.source).toBe('flag');
    expect(revealProviderKey(resolved!)).toBe(FLAG_VALUE);
    // Not merely "the helper's value lost" — the subprocess never happened.
    expect(h.helperCalls).toHaveLength(0);
  });

  test('2 over 3 — the helper wins over ANTHROPIC_API_KEY', () => {
    const h = harness({
      env: { [PROVIDER_KEY_HELPER_ENV]: 'vault kv get -field=key secret/anthropic', [PROVIDER_KEY_ENV]: ENV_VALUE },
      runHelper: () => ok(HELPER_VALUE),
    });
    const resolved = resolveProviderKey(h.deps);
    expect(resolved?.source).toBe('helper');
    expect(revealProviderKey(resolved!)).toBe(HELPER_VALUE);
  });

  test('3 over 4 — the environment wins and the credential store is NEVER READ', () => {
    const h = harness({ env: { [PROVIDER_KEY_ENV]: ENV_VALUE }, fsSeed: seedInlineStore(STORE_VALUE) });
    const resolved = resolveProviderKey(h.deps);
    expect(resolved?.source).toBe('env');
    expect(revealProviderKey(resolved!)).toBe(ENV_VALUE);
    expect(h.mem.reads).toHaveLength(0);
  });

  test('all four configured → the flag, and neither the helper nor the store is touched', () => {
    const h = harness({
      env: { [PROVIDER_KEY_HELPER_ENV]: 'op read op://Private/anthropic/credential', [PROVIDER_KEY_ENV]: ENV_VALUE },
      runHelper: () => ok(HELPER_VALUE),
      fsSeed: seedInlineStore(STORE_VALUE),
    });
    const { key } = extractProviderKeyFlag([PROVIDER_KEY_FLAG, FLAG_VALUE]);
    const resolved = resolveProviderKey(h.deps, { flagKey: key });
    expect(revealProviderKey(resolved!)).toBe(FLAG_VALUE);
    expect(h.helperCalls).toHaveLength(0);
    expect(h.mem.reads).toHaveLength(0);
  });

  test('an ABSENT higher rung is skipped, never an error — 2 resolves with 1 unset', () => {
    const h = harness({
      env: { [PROVIDER_KEY_HELPER_ENV]: 'op read op://Private/anthropic/credential' },
      runHelper: () => ok(HELPER_VALUE),
      fsSeed: seedInlineStore(STORE_VALUE),
    });
    expect(resolveProviderKey(h.deps)?.source).toBe('helper');
  });

  test('an empty/whitespace value at a rung does not count as a match', () => {
    const h = harness({
      env: { [PROVIDER_KEY_HELPER_ENV]: '   ', [PROVIDER_KEY_ENV]: '  \t ' },
      fsSeed: seedInlineStore(STORE_VALUE),
    });
    const resolved = resolveProviderKey(h.deps);
    expect(resolved?.source).toBe('store');
    expect(h.helperCalls).toHaveLength(0);
  });

  test('an explicit helperCommand option outranks the env var that names one', () => {
    const h = harness({
      env: { [PROVIDER_KEY_HELPER_ENV]: 'should-not-run' },
      runHelper: () => ok(HELPER_VALUE),
    });
    resolveProviderKey(h.deps, { helperCommand: 'explicit-helper --stdout' });
    expect(h.helperCalls[0]?.command).toBe('explicit-helper --stdout');
  });
});

// ---------------------------------------------------------------------------
// Rung 1 — argv extraction lives in the owning module
// ---------------------------------------------------------------------------

describe('extractProviderKeyFlag — the command layer never sees a plain string', () => {
  test('--api-key <value> is removed from argv and wrapped', () => {
    const { rest, key } = extractProviderKeyFlag(['drive', '--json', PROVIDER_KEY_FLAG, FLAG_VALUE, 'run.md']);
    expect(rest).toEqual(['drive', '--json', 'run.md']);
    expect(revealProviderKey(key!)).toBe(FLAG_VALUE);
    // The returned argv — the ONLY thing the command parser sees — is free of it.
    expect(JSON.stringify(rest)).not.toContain(FLAG_VALUE);
  });

  test('--api-key=<value> is removed from argv and wrapped', () => {
    const { rest, key } = extractProviderKeyFlag(['drive', `${PROVIDER_KEY_FLAG}=${FLAG_VALUE}`, '--json']);
    expect(rest).toEqual(['drive', '--json']);
    expect(revealProviderKey(key!)).toBe(FLAG_VALUE);
  });

  test('no flag → no key, argv untouched', () => {
    const argv = ['drive', '--json'];
    const { rest, key } = extractProviderKeyFlag(argv);
    expect(rest).toEqual(argv);
    expect(key).toBeUndefined();
  });

  test('a missing value is a usage error, not a silently empty key', () => {
    expect(() => extractProviderKeyFlag(['drive', PROVIDER_KEY_FLAG])).toThrow(ProviderKeyError);
    expect(() => extractProviderKeyFlag(['drive', PROVIDER_KEY_FLAG, '--json'])).toThrow(ProviderKeyError);
    expect(() => extractProviderKeyFlag(['drive', `${PROVIDER_KEY_FLAG}=`])).toThrow(ProviderKeyError);
    expect(() => extractProviderKeyFlag(['drive', `${PROVIDER_KEY_FLAG}=   `])).toThrow(ProviderKeyError);
  });

  test('the last occurrence wins and every occurrence leaves argv', () => {
    const { rest, key } = extractProviderKeyFlag([
      PROVIDER_KEY_FLAG,
      'PLACEHOLDER-NOT-A-REAL-KEY-first',
      'drive',
      `${PROVIDER_KEY_FLAG}=${FLAG_VALUE}`,
    ]);
    expect(rest).toEqual(['drive']);
    expect(revealProviderKey(key!)).toBe(FLAG_VALUE);
    expect(rest.join(' ')).not.toContain('PLACEHOLDER-NOT-A-REAL-KEY-first');
  });
});

// ---------------------------------------------------------------------------
// Rung 2 — a failing helper never shows its output
// ---------------------------------------------------------------------------

describe('a failing helper surfaces an error that does NOT contain its stdout', () => {
  const HELPER_STDOUT_SECRET = 'PLACEHOLDER-NOT-A-REAL-KEY-leaked-on-stdout';
  const HELPER_STDERR_SECRET = 'PLACEHOLDER-NOT-A-REAL-KEY-leaked-on-stderr';
  const COMMAND = 'op read op://Private/anthropic/credential';

  /** Every assertion this suite makes about a thrown error: the key material
   *  is absent from the message, the name, and the stack. */
  function expectNoLeak(e: unknown): Error {
    const err = e as Error;
    const surfaced = `${err.name}\n${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`;
    expect(surfaced).not.toContain(HELPER_STDOUT_SECRET);
    expect(surfaced).not.toContain(HELPER_STDERR_SECRET);
    return err;
  }

  test('a non-zero exit throws, and neither stdout nor stderr reaches the error', () => {
    const h = harness({
      env: { [PROVIDER_KEY_HELPER_ENV]: COMMAND },
      runHelper: () => ({ status: 3, stdout: HELPER_STDOUT_SECRET, stderr: HELPER_STDERR_SECRET }),
    });
    let caught: unknown;
    try {
      resolveProviderKey(h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderKeyError);
    const err = expectNoLeak(caught);
    // What it DOES say: the exit code, the binary name, and where to look.
    expect(err.message).toContain('exit 3');
    expect(err.message).toContain('op');
    expect(err.message).toContain(PROVIDER_KEY_HELPER_ENV);
  });

  test('a timeout throws without the output it had already captured', () => {
    const h = harness({
      env: { [PROVIDER_KEY_HELPER_ENV]: COMMAND },
      runHelper: () => ({ status: null, stdout: HELPER_STDOUT_SECRET, stderr: HELPER_STDERR_SECRET, timedOut: true }),
    });
    let caught: unknown;
    try {
      resolveProviderKey(h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderKeyError);
    expect(expectNoLeak(caught).message).toContain('did not finish');
  });

  test('a spawn failure discards the thrown error rather than chaining it (its message can echo argv)', () => {
    const h = harness({
      env: { [PROVIDER_KEY_HELPER_ENV]: `secret-printer ${HELPER_STDOUT_SECRET}` },
      runHelper: () => {
        throw new Error(`spawn failed running: secret-printer ${HELPER_STDOUT_SECRET}`);
      },
    });
    let caught: unknown;
    try {
      resolveProviderKey(h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderKeyError);
    const err = expectNoLeak(caught);
    // The first token — a binary NAME — is the only part of the command line
    // that survives into the error.
    expect(err.message).toContain('secret-printer');
    expect(err.message).not.toContain(HELPER_STDOUT_SECRET);
  });

  test('exit 0 with no output is an error too, and says so plainly', () => {
    const h = harness({ env: { [PROVIDER_KEY_HELPER_ENV]: COMMAND }, runHelper: () => ok('\n  \n') });
    expect(() => resolveProviderKey(h.deps)).toThrow(/printed no key/);
  });

  test('a CONFIGURED-but-failing helper does NOT fall through to a lower rung', () => {
    const h = harness({
      env: { [PROVIDER_KEY_HELPER_ENV]: COMMAND, [PROVIDER_KEY_ENV]: ENV_VALUE },
      runHelper: () => ({ status: 1, stdout: '', stderr: HELPER_STDERR_SECRET }),
      fsSeed: seedInlineStore(STORE_VALUE),
    });
    // Substituting a stale environment key for the vault key the user asked
    // for, silently, would be a security event — so this throws instead.
    expect(() => resolveProviderKey(h.deps)).toThrow(ProviderKeyError);
    expect(h.mem.reads).toHaveLength(0);
  });
});

describe('a succeeding helper — how its stdout is read', () => {
  test('a trailing newline is trimmed (LF and CRLF)', () => {
    for (const eol of ['\n', '\r\n', '\n\n']) {
      const h = harness({ env: { [PROVIDER_KEY_HELPER_ENV]: 'h' }, runHelper: () => ok(`${HELPER_VALUE}${eol}`) });
      expect(revealProviderKey(resolveProviderKey(h.deps)!)).toBe(HELPER_VALUE);
    }
  });

  test('the FIRST non-empty line is the key — a leading blank line is tolerated', () => {
    const h = harness({ env: { [PROVIDER_KEY_HELPER_ENV]: 'h' }, runHelper: () => ok(`\n  \n  ${HELPER_VALUE}  \ntrailing junk\n`) });
    expect(revealProviderKey(resolveProviderKey(h.deps)!)).toBe(HELPER_VALUE);
  });

  test('the configured timeout is passed through to the runner', () => {
    const h = harness({ env: { [PROVIDER_KEY_HELPER_ENV]: 'h' }, runHelper: () => ok(HELPER_VALUE) });
    resolveProviderKey(h.deps, { helperTimeoutMs: 250 });
    expect(h.helperCalls[0]?.timeoutMs).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// Rung 2 — the REAL subprocess, on this machine's real shell
// ---------------------------------------------------------------------------

describe('realRunHelperCommand — the production path, actually spawned', () => {
  // Every test above injects `runHelper`, which is the right default (it
  // pins the exact error text deterministically on every CI leg). But the
  // shell that ships to users is then never exercised, and this package has
  // already been bitten by a Windows/POSIX subprocess divergence — see
  // `.github/workflows/ci.yml`'s note on the npm/bun shim. These few run for
  // real, on whichever shell this leg has.
  const win = process.platform === 'win32';
  const REAL_VALUE = 'PLACEHOLDER-NOT-A-REAL-KEY-from-a-real-subprocess';

  /** Deps WITHOUT an injected `runHelper`, so `realRunHelperCommand` is used. */
  function realDeps(command: string): ProviderKeyDeps {
    return {
      platform: process.platform,
      env: { ...process.env, PIPELINE_CLOUD_HOME: HOME, [PROVIDER_KEY_HELPER_ENV]: command },
      homedir: '/fake-home',
      fs: memFs().fs,
    };
  }

  test('a real helper that prints a key on stdout resolves it', () => {
    const key = resolveProviderKey(realDeps(`echo ${REAL_VALUE}`));
    expect(key?.source).toBe('helper');
    expect(revealProviderKey(key!)).toBe(REAL_VALUE);
  });

  test('a real helper that fails still never shows its stdout', () => {
    // Prints the "key" and THEN fails — the exact shape that would leak.
    const command = win ? `echo ${REAL_VALUE}& exit /b 3` : `echo ${REAL_VALUE}; exit 3`;
    let caught: unknown;
    try {
      resolveProviderKey(realDeps(command));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderKeyError);
    const err = caught as Error;
    expect(`${err.message}\n${err.stack ?? ''}`).not.toContain(REAL_VALUE);
    expect(err.message).toContain('exit 3');
  });

  test('a real command that does not exist fails without echoing the command line', () => {
    const command = `pipeline-no-such-helper-${Date.now()} ${REAL_VALUE}`;
    let caught: unknown;
    try {
      resolveProviderKey(realDeps(command));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderKeyError);
    expect((caught as Error).message).not.toContain(REAL_VALUE);
  });
});

// ---------------------------------------------------------------------------
// Exactly one module holds the key — the in-memory half
// ---------------------------------------------------------------------------

describe('the key is absent from any serialised object', () => {
  const key = new ProviderKey('flag', FLAG_VALUE);

  test('JSON.stringify redacts it at the top level', () => {
    expect(JSON.stringify(key)).toBe(JSON.stringify(REDACTED));
    expect(JSON.stringify(key)).not.toContain(FLAG_VALUE);
  });

  test('JSON.stringify redacts it at ANY nesting depth — the case that matters', () => {
    const payload = {
      request: { options: { apiKey: key }, headers: [{ auth: key }] },
      list: [[{ deep: key }]],
    };
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(FLAG_VALUE);
    expect(serialised).toContain(REDACTED);
  });

  test('string coercion redacts it — template literal, String(), concatenation', () => {
    expect(`${key}`).toBe(REDACTED);
    expect(String(key)).toBe(REDACTED);
    expect('' + key).toBe(REDACTED);
    expect([key].join(',')).toBe(REDACTED);
  });

  test('the secret is not an own property, so enumeration cannot reach it', () => {
    expect(Object.keys(key)).toEqual(['source']);
    expect(Object.getOwnPropertyNames(key)).toEqual(['source']);
    expect(Object.getOwnPropertySymbols(key)).toEqual([]);
    expect(JSON.stringify(Object.entries(key))).not.toContain(FLAG_VALUE);
    expect(JSON.stringify({ ...key })).not.toContain(FLAG_VALUE);
  });

  test('structuredClone cannot carry it across', () => {
    const cloned = structuredClone({ key }) as { key: { source: string } };
    expect(JSON.stringify(cloned)).not.toContain(FLAG_VALUE);
    expect(cloned.key.source).toBe('flag');
  });

  test('Bun/Node inspection redacts it', () => {
    expect(Bun.inspect(key)).not.toContain(FLAG_VALUE);
  });

  test('describeProviderKey prints the LENGTH, never the content', () => {
    const described = describeProviderKey(key);
    expect(described).not.toContain(FLAG_VALUE);
    expect(described).toContain(String(Buffer.byteLength(FLAG_VALUE, 'utf-8')));
    expect(described).toContain('flag');
  });

  test('revealProviderKey is the one boundary, and rejects a non-holder', () => {
    expect(revealProviderKey(key)).toBe(FLAG_VALUE);
    expect(() => revealProviderKey({ source: 'flag' } as unknown as ProviderKey)).toThrow(ProviderKeyError);
  });

  test('a ProviderKeyError never carries key material of its own', () => {
    const e = new ProviderKeyError('something went wrong');
    expect(JSON.stringify(e)).not.toContain(FLAG_VALUE);
    expect(e.message).not.toContain(FLAG_VALUE);
  });

  test('every rung produces the same holder guarantees', () => {
    for (const k of [
      new ProviderKey('helper', HELPER_VALUE),
      new ProviderKey('env', ENV_VALUE),
      new ProviderKey('store', STORE_VALUE),
    ]) {
      expect(JSON.stringify({ nested: { k } })).not.toContain(revealProviderKey(k));
      expect(`${k}`).toBe(REDACTED);
    }
  });
});

// ---------------------------------------------------------------------------
// Rungs 1–3 never write anything at all
// ---------------------------------------------------------------------------

describe('three of the four rungs mean we never hold a key', () => {
  test('resolving via the flag, the helper or the environment writes NOTHING to disk', () => {
    const cases: Array<() => void> = [
      () => {
        const h = harness();
        const { key } = extractProviderKeyFlag([PROVIDER_KEY_FLAG, FLAG_VALUE]);
        resolveProviderKey(h.deps, { flagKey: key });
        expect(h.mem.writes).toHaveLength(0);
        expect(h.mem.files.size).toBe(0);
      },
      () => {
        const h = harness({ env: { [PROVIDER_KEY_HELPER_ENV]: 'h' }, runHelper: () => ok(HELPER_VALUE) });
        resolveProviderKey(h.deps);
        expect(h.mem.writes).toHaveLength(0);
        expect(h.keychainCalls).toHaveLength(0);
      },
      () => {
        const h = harness({ env: { [PROVIDER_KEY_ENV]: ENV_VALUE } });
        resolveProviderKey(h.deps);
        expect(h.mem.writes).toHaveLength(0);
        expect(h.keychainCalls).toHaveLength(0);
      },
    ];
    for (const c of cases) c();
  });
});

// ---------------------------------------------------------------------------
// Rung 4 — the EXISTING credential store, with its existing modes
// ---------------------------------------------------------------------------

describe('rung 4 reuses the existing credential store — no second store', () => {
  test('the only file written is the credential store itself (plus its atomic temp sibling)', () => {
    const h = harness({ platform: 'linux', keychainPlatform: 'win32' }); // no keychain backend
    const res = persistProviderKey(h.deps, STORE_VALUE);
    expect(res.path).toBe(credPath());
    expect(res.backend).toBe('file');
    // Every path this write touched resolves to the credential store or its
    // same-directory temp file — never a new location. The directory is taken
    // from `credentialFilePath`'s OWN output rather than from `credentialDir`,
    // because only the former has been through `path.join` — comparing against
    // the raw `PIPELINE_CLOUD_HOME` string would compare `/` against `\` and
    // pass or fail by CI leg rather than by behaviour.
    const dir = dirname(credPath());
    const touched = [...h.mem.writes.map((w) => w.path), ...h.mem.renames.map((r) => r.to)];
    for (const p of touched) {
      expect(p.startsWith(dir)).toBe(true);
    }
    expect(h.mem.renames.map((r) => r.to)).toEqual([credPath()]);
    expect([...h.mem.files.keys()]).toEqual([credPath()]);
  });

  test('the existing modes are applied — 0700 directory, 0600 file, atomic rename, Windows ACL', () => {
    const h = harness({ platform: 'win32', keychainPlatform: 'win32' });
    persistProviderKey(h.deps, STORE_VALUE);
    expect(h.mem.mkdirs[0]?.mode).toBe(0o700);
    expect(h.mem.writes.every((w) => w.mode === 0o600)).toBe(true);
    expect(h.mem.chmods.every((c) => c.mode === 0o600)).toBe(true);
    expect(h.mem.renames).toHaveLength(1);
    // The Windows-only ACL step — the same `protectCredentialFile` seam every
    // other secret writer in this package calls.
    expect(h.protectCalls).toEqual([{ path: credPath('win32'), platform: 'win32' }]);
  });

  test('a stored key round-trips through resolveProviderKey as rung 4', () => {
    const h = harness({ keychainPlatform: 'win32' });
    persistProviderKey(h.deps, STORE_VALUE);
    const resolved = resolveProviderKey(h.deps);
    expect(resolved?.source).toBe('store');
    expect(revealProviderKey(resolved!)).toBe(STORE_VALUE);
  });

  test('an empty key is refused rather than stored', () => {
    const h = harness();
    expect(() => persistProviderKey(h.deps, '   ')).toThrow(ProviderKeyError);
    expect(h.mem.writes).toHaveLength(0);
  });

  test('persisting does not disturb the cloud credentials already in the same file', () => {
    const existing =
      JSON.stringify({
        version: 1,
        servers: { 'https://api.ai-pipeline.dev': { access_token: 'PLACEHOLDER-NOT-A-REAL-TOKEN', token_type: 'bearer' } },
      }) + '\n';
    const h = harness({ keychainPlatform: 'win32', fsSeed: { [credPath()]: existing } });
    persistProviderKey(h.deps, STORE_VALUE);
    const after = readCredentialStore(h.deps.fs, credPath());
    expect(after.servers['https://api.ai-pipeline.dev']?.access_token).toBe('PLACEHOLDER-NOT-A-REAL-TOKEN');
    expect(after.provider_keys?.[PROVIDER_ID]?.api_key).toBe(STORE_VALUE);
  });

  test('an UNRELATED writer round-tripping the store does not delete the provider key', () => {
    // The real hazard: every writer does read → mutate `servers` → write the
    // WHOLE object back, so a field `readCredentialStore` dropped would be
    // silently erased by the next `cloud connect` or token refresh.
    const h = harness({ keychainPlatform: 'win32' });
    persistProviderKey(h.deps, STORE_VALUE);

    const roundTripped = readCredentialStore(h.deps.fs, credPath());
    roundTripped.servers['https://api.ai-pipeline.dev'] = { access_token: 'PLACEHOLDER-NOT-A-REAL-TOKEN', token_type: 'bearer' };
    writeCredentialStore(h.deps.fs, credPath(), roundTripped);

    expect(revealProviderKey(resolveProviderKey(h.deps)!)).toBe(STORE_VALUE);
  });

  test('a store file with no provider key at all is not an error', () => {
    const h = harness({ fsSeed: { [credPath()]: JSON.stringify({ version: 1, servers: {} }) + '\n' } });
    expect(resolveProviderKey(h.deps)).toBeUndefined();
  });
});

describe('rung 4 and the OS keychain — the decision recorded in docs/provider-key.md', () => {
  test('where a backend exists the key goes to the keychain and NOT into the file', () => {
    const h = harness({ platform: 'linux', keychainRun: () => ({ status: 0, stdout: '', stderr: '' }) });
    const res = persistProviderKey(h.deps, KEYCHAIN_VALUE);
    expect(res.backend).toBe('keychain');

    // The store records that a value exists elsewhere — and the file itself
    // does not contain it.
    const onDisk = h.mem.files.get(credPath())!;
    expect(onDisk).not.toContain(KEYCHAIN_VALUE);
    expect(JSON.parse(onDisk).provider_keys[PROVIDER_ID]).toEqual({ in_keychain: true, stored_at: 1_700_000_000_000 });

    // Stored through `secret-tool store`, which reads the secret from STDIN
    // rather than argv — the property `credential-keychain.ts` already has.
    const store = h.keychainCalls.find((c) => c.args[0] === 'store');
    expect(store?.cmd).toBe('secret-tool');
    expect(store?.input).toBe(KEYCHAIN_VALUE);
    expect(store?.args.join(' ')).not.toContain(KEYCHAIN_VALUE);
  });

  test('where no backend exists the ACL/0600 file is the documented fallback', () => {
    const h = harness({ platform: 'win32', keychainPlatform: 'win32' });
    const res = persistProviderKey(h.deps, STORE_VALUE);
    expect(res.backend).toBe('file');
    expect(JSON.parse(h.mem.files.get(credPath('win32'))!).provider_keys[PROVIDER_ID].in_keychain).toBe(false);
  });

  test('falling back to the file clears any stale keychain entry', () => {
    const h = harness({ platform: 'linux', keychainRun: () => ({ status: 1, stdout: '', stderr: '' }) });
    persistProviderKey(h.deps, STORE_VALUE);
    expect(h.keychainCalls.some((c) => c.args[0] === 'clear')).toBe(true);
  });

  test('marked keychain-resident but unreadable fails LOUDLY, never as "no key configured"', () => {
    const h = harness({
      fsSeed: {
        [credPath()]:
          JSON.stringify({ version: 1, servers: {}, provider_keys: { [PROVIDER_ID]: { in_keychain: true } } }) + '\n',
      },
      keychainRun: () => ({ status: 1, stdout: '', stderr: 'the keychain is locked' }),
    });
    let msg = '';
    try {
      resolveProviderKey(h.deps);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('OS keychain');
    expect(msg).toContain(PROVIDER_KEY_KEYCHAIN_ACCOUNT);
  });
});
