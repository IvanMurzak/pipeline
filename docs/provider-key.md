# The provider API key: where it comes from, and where it rests

Companion to `src/lib/provider-key.ts` — the one module that owns the
Anthropic API key `standalone` executes steps with. Task `c1` of the
`execution-modes` taskflow; the design page is
`.taskflow/2026-08-03-execution-modes/02-standalone-executor.md`, "Key
handling (K-1, resolved)".

This page exists to answer one question in writing that the task specification
left open, and to record the reasoning behind two choices a reader would
otherwise have to reverse-engineer from the code.

## The ladder

Four rungs, first match wins. **Three of the four mean we never hold a key at
all.**

| Rung | Source | How you configure it | Do we store it? |
| --- | --- | --- | --- |
| 1 | An explicit flag on the invocation | `--api-key <key>` | No |
| 2 | A helper command whose stdout is the key | `PIPELINE_API_KEY_HELPER=<command>` | No |
| 3 | The standard environment variable | `ANTHROPIC_API_KEY=<key>` | No |
| 4 | Our credential store | `persistProviderKey(...)` | **Yes** |

Rung 4 exists because some users will configure nothing else, and refusing
them is worse than storing carefully.

**Rung 2 is the interesting one.** It mirrors Claude Code's own `apiKeyHelper`,
which is the precedent for "the user owns the secret, we only ask for it". It
composes with anything that prints a key on stdout:

```sh
export PIPELINE_API_KEY_HELPER='op read op://Private/anthropic/credential'
export PIPELINE_API_KEY_HELPER='vault kv get -field=key secret/anthropic'
export PIPELINE_API_KEY_HELPER='aws secretsmanager get-secret-value --secret-id anthropic --query SecretString --output text'
```

The ladder's *shape* — the more explicit and the more ephemeral a source is,
the higher it sits — is the shape `commands/cloud.ts` already uses for
control-plane auth, where a non-interactive machine credential outranks
interactive browser/device discovery (`authenticateApi`: machine token →
browser → device).

## Does a provider key ride the OS keychain? — **Yes**

The narrow question the task left open. `src/lib/credential-keychain.ts`
already ships keychain storage for the control plane's *refresh token*: macOS
via `security`, Linux via `secret-tool`, and Windows deliberately
`platform: 'none'` because `cmdkey` can write a Credential Manager entry but
cannot read one back. **That platform analysis is not re-derived here** — it
lives in that module's header and has not changed.

### The answer

**A rung-4 provider key rides the same path, with the ACL/`0600` file as the
documented fallback.** `persistProviderKey` calls `storeInKeychain` first and
falls back to an inline `api_key` in `credentials.json` exactly the way
`persistCredentialSecurely` already falls back for a refresh token; the store
records which happened in `provider_keys.anthropic.in_keychain`, the same
marker `refresh_token_in_keychain` uses.

### Why

1. **The threat is the one the keychain was added for, only worse.** The file
   modes stop *another local account*; they do nothing about a copy of the
   file — a backup, a synced folder, a stolen disk image. That is exactly the
   gap `credential-keychain.ts` was written to close.

2. **A provider key is strictly less recoverable than a refresh token.** A
   refresh token is ours: it rotates, it expires, reuse detection revokes the
   whole family, and a 14-day inactivity window kills it locally before the
   server is even asked. A leaked provider key does none of that — it is
   long-lived, it does not rotate, and **we cannot revoke it at all**; only the
   user can, in the Anthropic console, once they notice. If the keychain was
   worth it for the revocable secret, it is worth more for the one nobody can
   revoke.

3. **It costs nothing new.** No dependency, no new module, no new platform
   analysis — `storeInKeychain`/`readFromKeychain` already exist, already have
   the never-throws fallback contract, and are already tested.

### The two honest costs, and what is done about them

**Cost 1 — Windows gets nothing.** `keychainBackendFor('win32')` is `none`, so
on the platform much of this project's development happens on, the key lands
in the ACL-protected file. That is a real, partial answer, and it is the same
partial answer the refresh token already lives with. It is not a reason to
skip the platforms that *do* have a backend.

**Cost 2 — a keychain read is a subprocess, and can fail.** Reading the key
costs a `security`/`secret-tool` spawn, and on macOS a locked keychain can
prompt or deny. Two things keep that from being a problem:

- **It is read once.** The whole point of the owning module is that resolution
  happens once and the value is held in one place, not re-read per step.
- **It fails LOUDLY**, and this is the one place a provider key deliberately
  behaves *differently* from the refresh token. When the store says
  `in_keychain: true` and the read comes back empty, `resolveProviderKey`
  throws — it does not return "no key configured" and it does not fall off the
  end of the ladder. A user who definitely stored a key must not be sent
  hunting for one they never lost. (`readFromKeychain` itself still never
  throws; the decision to treat *this* empty result as fatal is made here, by
  the caller, which is what its fallback contract asks of callers.)

### What was rejected

- **File only, no keychain.** Rejected: it declines a hardening step that is
  already built and paid for, for the secret that most needs it.
- **Keychain only, no file fallback.** Rejected: it would leave Windows, every
  headless Linux host and every container with no rung 4 at all — which is the
  "just make it work" rung, so removing it removes the reason rung 4 exists.
- **A new, provider-key-specific store.** Rejected explicitly by the task, and
  rightly: `writeSecretFileAtomic` + `protectCredentialFile` is already the one
  mechanism every secret in this package rests under (the credential store, and
  `fingerprint-salt.ts`'s per-install salt). A second one is a second thing to
  get right and a second thing to forget.

## Why a failing helper never shows you its output

`runHelperRung` puts **neither stdout nor stderr** into the error it surfaces.

stdout is obvious — it is the key. stderr is withheld for a less obvious
reason: a helper that echoes its own arguments in a diagnostic
(`op: item "sk-…" not found`) leaks just as completely, and we cannot know
which stream a third-party tool chose to write to. So the error carries the
exit code and the command's **first token** — a binary name or path, which is
not a credential — and tells the user to run the command themselves.

This trades debuggability for a guarantee, deliberately. The alternative,
"print stderr but not stdout", is the kind of rule that holds until the first
helper that writes to the wrong stream, and by then the key is in a log file.

The same reasoning covers the `catch` around the spawn itself: the thrown
error is **discarded, not chained**, because a spawn failure's message can
contain the whole command line, argument values included.

## Why a configured-but-failing helper is an error, not a fallthrough

If `PIPELINE_API_KEY_HELPER` is set and the command fails, resolution stops
with an error. It does *not* quietly drop to `ANTHROPIC_API_KEY` or to the
stored key.

Silently substituting one credential for another behind the user's back is a
security event, not a convenience: someone who wired a vault helper and whose
vault is locked would otherwise find their run billed to a stale key left in a
shell profile months ago, with nothing on screen to say so. `commands/cloud.ts`
takes the same posture — a present machine token that fails to exchange is an
error, never a fallback to the browser flow.

An **absent** rung is of course not an error. That is what "first match wins"
means.

## Why the flag is parsed inside the owning module

`extractProviderKeyFlag` pulls `--api-key` out of `argv` and returns the
remaining arguments for the command's own parser. That looks like an odd place
for argv handling until you notice the alternative: a command that parsed the
flag itself would hold the plaintext in one of its own locals, and from there
it reaches an options object, and from there something serialises it. The
command layer never sees the string at all.

What this does **not** fix: a value on the command line is visible to `ps` and
to shell history for the life of the process. That is inherent to any flag —
`commands/cloud.ts` accepts and documents the same trade-off for
`--machine-token`. Rungs 2 and 3 exist for users who care, and rung 2 is the
one to recommend.

## How the key is held in memory

The secret is **not a property of the `ProviderKey` object**. It lives in a
module-private `WeakMap` keyed by the holder, so it is unreachable by
`JSON.stringify`, `structuredClone`, `Object.entries`, a spread, or any other
whole-object serialisation some other layer performs on an object that happens
to carry a key. `toJSON`, `toString`, `Symbol.toPrimitive` and Node's
`inspect.custom` all return `[redacted provider key]`.

`revealProviderKey` is the one boundary where the string exists again.
`tests/provider-key-ownership.test.ts` enumerates the files allowed to call it
and fails when a new one does — adding a file to that allowlist is the
deliberate act of granting another module the plaintext.

`describeProviderKey` returns the rung and the key's **byte length**, which is
the sanctioned way to prove a key is present and plausible without printing any
of it. That is this repository's own rule, learned from a real leak: when
inspecting a secret, print the length, never the content.

**This is layer one of two.** c2's output scrubber is layer two, and neither
substitutes for the other: this module keeps the key from entering ordinary
code, the scrubber catches what escapes through third-party code we do not
control. The design page is explicit that the telemetry privacy filter is
*not* a third layer — it is bypassed above the `metadata` tier, and its
allowlisted free-text fields carry up to 256 characters with no credential or
entropy detector behind them.
