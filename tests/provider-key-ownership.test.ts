// provider-key-ownership.test.ts — c1's STRUCTURAL half: "exactly one module
// holds the key".
//
// `provider-key.test.ts` proves the behavioural half — that a `ProviderKey`
// cannot be serialised, coerced or enumerated into plaintext. That is
// necessary and not sufficient: nothing in it stops a future module from
// calling `revealProviderKey`, parking the string on an options object, and
// handing it to a logger. THIS file is the control for that, and it is a
// TRIPWIRE by design.
//
// The allowlists below are not a lint rule to be silenced. Adding a file to
// one is the deliberate act of granting that module the plaintext provider
// key, and it should happen in a commit whose message says so — the SDK
// runner (`src/lib/executors/sdk.ts`, task c-series) and c2's output scrubber
// are the two files expected to earn a place here, and both for a stated
// reason:
//
//   - the SDK runner, because the key has to reach the Agent SDK somehow;
//   - the scrubber, because redacting a value requires knowing it.
//
// Everything else that "just needs the key" is a design mistake being
// reported early. That is the whole point.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

/** The owning module — `src/lib/provider-key.ts`, in repo-relative POSIX form
 *  so the assertion reads the same on both legs of the CI matrix. */
const OWNER = 'src/lib/provider-key.ts';

/** Where the at-rest SHAPE is declared. `StoredProviderKey` /
 *  `CredentialStore.provider_keys` live with the rest of the credential
 *  store's types; only the owner may read or write the field. */
const STORE_SHAPE = 'src/lib/cloud-config.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      walk(abs, out);
    } else if (abs.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/** Every `.ts` file under `src/`, keyed by its repo-relative POSIX path. */
function sources(): Array<{ path: string; text: string }> {
  return walk(SRC).map((abs) => ({
    path: relative(join(import.meta.dir, '..'), abs).split(sep).join('/'),
    text: readFileSync(abs, 'utf-8'),
  }));
}

/** Files whose TEXT contains `needle`. */
function filesMentioning(needle: string): string[] {
  return sources()
    .filter((f) => f.text.includes(needle))
    .map((f) => f.path)
    .sort();
}

describe('exactly one module holds the provider key', () => {
  test('the source tree is actually being scanned (guard against a vacuous suite)', () => {
    const all = sources();
    expect(all.length).toBeGreaterThan(50);
    expect(all.map((f) => f.path)).toContain(OWNER);
  });

  test('revealProviderKey — the one boundary — is called from NO other module', () => {
    // Adding a path here grants that module the plaintext key. Read this
    // file's header before you do.
    const ALLOWED = [OWNER];
    expect(filesMentioning('revealProviderKey')).toEqual(ALLOWED);
  });

  test('the key never leaves the owner as a plain string: no other module imports its holder API', () => {
    const importers = sources()
      .filter((f) => f.path !== OWNER && /from '\.[./]*(?:lib\/)?provider-key'/.test(f.text))
      .map((f) => f.path);
    // Nothing imports it yet — the executor that will is a later task. When
    // one appears, this assertion is where the reviewer is told to check WHAT
    // it imports: `resolveProviderKey`/`ProviderKey` are fine, the reveal
    // boundary is the one the test above governs.
    expect(importers).toEqual([]);
  });

  test('the at-rest field is read and written by the owner alone', () => {
    expect(filesMentioning('provider_keys')).toEqual([STORE_SHAPE, OWNER].sort());
    expect(filesMentioning('StoredProviderKey')).toEqual([STORE_SHAPE, OWNER].sort());
  });

  test('the OS-keychain account for a provider key is derived in one place', () => {
    expect(filesMentioning('PROVIDER_KEY_KEYCHAIN_ACCOUNT')).toEqual([OWNER]);
  });

  test('each ladder rung has exactly one reader in src/', () => {
    // Rung 3's variable is the one to watch: `ANTHROPIC_API_KEY` is a name
    // any module could reach for out of convenience, and a second reader is
    // a second place the key becomes a plain string.
    expect(filesMentioning('ANTHROPIC_API_KEY')).toEqual([OWNER]);
    expect(filesMentioning('PIPELINE_API_KEY_HELPER')).toEqual([OWNER]);
  });
});

describe('no key material is committed', () => {
  test('neither the owner nor its tests contain a provider-key-shaped literal', () => {
    // The live Anthropic key prefix (assembled below rather than written out,
    // so this assertion is not itself the match it forbids) must appear in no
    // file this task touched — not in a fixture, not in a doc example, not in
    // a comment. (Other suites in this repo deliberately carry a SYNTHETIC
    // key-shaped string to exercise the privacy filter; this assertion is
    // scoped to c1's own files rather than the whole tree so it pins THIS
    // task's discipline without duplicating theirs.)
    const files = [
      'src/lib/provider-key.ts',
      'tests/provider-key.test.ts',
      'tests/provider-key-ownership.test.ts',
      'docs/provider-key.md',
    ];
    for (const rel of files) {
      const text = readFileSync(join(import.meta.dir, '..', rel), 'utf-8');
      // Split so this assertion does not itself become the match it forbids.
      expect(text.includes(['sk', 'ant', ''].join('-'))).toBe(false);
    }
  });
});
