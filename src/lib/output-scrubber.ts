// output-scrubber.ts — LAYER TWO OF THE KEY DEFENCE (c2,
// 02-standalone-executor.md "Key handling (K-1, resolved)").
//
// `provider-key.ts` is layer one: it keeps the provider API key from ever
// entering ordinary code as a string. This module is layer two: it keeps the
// key out of anything WRITTEN — stdout, stderr, a log file, a journal, the
// telemetry outbox — no matter which code path produced the text.
//
// NEITHER LAYER SUBSTITUTES FOR THE OTHER. Layer one cannot govern an SDK
// error that echoes its own request, a stack trace built by third-party code,
// a subprocess that prints its environment, or a model that quotes a key back
// at us. Those all arrive as a plain string at a sink, and this module is the
// only thing standing between that string and the disk.
//
// ── WHY THIS IS THE ONLY DEFENCE ON THE TELEMETRY PATH ────────────────────
//
// `lib/vendor/privacy.ts` is a genuine positive allowlist, but it is BYPASSED
// above the `metadata` tier, and the fields it does allow carry free text up
// to 256 characters — `halt_reason` on `iteration.completed`, `pipeline.halted`
// and `run.halted`, `department.failed.reason`. A key quoted inside a halt
// reason fits comfortably inside 256 characters, and the post-allowlist sweep
// looks only for absolute paths and OS account names. There is no credential
// detector and no entropy detector anywhere in that path. So the journal
// writer (`lib/event.ts`), the stats writers (`lib/stats.ts`) and the outbox
// (`lib/telemetry-outbox.ts`) all route their bytes through `scrub` here.
//
// ── REDACTION IS VALUE-BASED, NEVER SHAPE-BASED ───────────────────────────
//
// We redact a value we KNOW. We never try to recognise "things that look like
// keys": a shape detector gives false negatives exactly on the case that
// matters (a rotated prefix, a different provider, a key pasted into a task
// description) and false positives on ordinary text (a git SHA, a UUID, a
// base64 blob), and a false positive here silently corrupts a user's logs.
//
// The register is therefore fed by the module that OWNS the secret: the
// provider-key module calls `registerSecret` as it resolves each rung. THIS
// MODULE IMPORTS NOTHING — not that module, not its reveal boundary, not the
// node stdlib. The arrow points owner → scrubber and never back, which is what
// keeps c1's "exactly one module holds the key" property true without widening
// the allowlist in `tests/provider-key-ownership.test.ts`. (That test scans
// source TEXT, so this comment deliberately does not spell the name of the
// reveal boundary either — mentioning it here would be indistinguishable from
// calling it.)
//
// ── THERE IS NO WAY TO TURN THIS OFF ──────────────────────────────────────
//
// No flag, no environment variable, no debug mode, no "verbose" escape hatch,
// and no way to REMOVE a value once registered. This module reads
// `process.env` nowhere — deliberately, and `tests/output-scrubber.test.ts`
// asserts it. A scrubber with an off switch is a scrubber that is off on the
// day it mattered, and "I turned it off to debug a thing" is precisely how
// this package's existing rule was learned: when inspecting a secrets file,
// print the LENGTH, never the content. This is that rule applied to the whole
// output path.
//
// The register is APPEND-ONLY for the same reason. Registering more values can
// only ever redact more; there is no `unregister`, no `clear`, and no reset —
// not even one marked "for tests".
//
// ── THE MARKER IS FIXED-WIDTH ─────────────────────────────────────────────
//
// A marker that varied with the secret (`***…` sized to the value, a
// `[redacted 108 bytes]`) would publish the key's LENGTH, which is a real
// distinguisher between providers, between key generations, and between a
// live key and a placeholder. {@link REDACTION_MARKER} is one constant string,
// so two secrets of different lengths in otherwise identical text produce
// BYTE-IDENTICAL output.

/**
 * What every occurrence of a registered secret becomes. One constant, of one
 * fixed width, for every secret of every length — see the header.
 *
 * Contains no quote, backslash or control character, so substituting it into
 * an already-serialised JSON document leaves that document valid JSON. Every
 * `.jsonl` sink on the drive path depends on that.
 */
export const REDACTION_MARKER = '[redacted]';

/**
 * Values shorter than this are NOT accepted into the register.
 *
 * Not a guess about key formats — a guard against catastrophic redaction. A
 * short value ("test", "abc123") occurs inside ordinary prose and file paths
 * by coincidence, and redacting it would shred a user's logs while protecting
 * nothing: no provider issues an 8-character API key. A caller that hands us
 * something shorter is told so by the return value rather than silently
 * getting a scrubber that eats its output.
 */
export const MIN_SECRET_LENGTH = 8;

/**
 * The register. Module-private and APPEND-ONLY — nothing exported can remove
 * an entry or empty it. Holds each secret plus the encodings below, so a value
 * that reaches a sink already transformed is still caught.
 */
const SECRETS = new Set<string>();

/**
 * Encodings a secret can wear by the time it reaches a sink. Each is derived
 * from the raw value and registered alongside it:
 *
 *   - JSON string-escaped — what `JSON.stringify` writes for a value carrying
 *     a quote or a backslash. Every `.jsonl` sink on this path writes through
 *     `JSON.stringify`, so without this a key with one awkward character would
 *     pass straight through a journal line.
 *   - percent-encoded — a key that ends up in a URL or a form body.
 *   - base64 — a key folded into an `Authorization: Basic` header, or dumped
 *     by an HTTP client that prints its request that way.
 *
 * All are ≥ the raw length, so none can slip under {@link MIN_SECRET_LENGTH},
 * and all are drawn from alphabets narrow enough that a coincidental match on
 * a value this long does not happen.
 */
function encodings(value: string): string[] {
  const out = [value];
  const push = (v: string): void => {
    if (v.length >= MIN_SECRET_LENGTH && !out.includes(v)) out.push(v);
  };
  // `JSON.stringify` wraps in quotes; the escaped BODY is what appears inside
  // a serialised document.
  const json = JSON.stringify(value);
  push(json.slice(1, -1));
  try {
    push(encodeURIComponent(value));
  } catch {
    // A lone surrogate is not encodable — the raw form is still registered.
  }
  try {
    push(Buffer.from(value, 'utf-8').toString('base64'));
  } catch {
    // No Buffer (an exotic runtime) — the raw form is still registered.
  }
  return out;
}

/**
 * Teach the scrubber a value it must never let through.
 *
 * Called by the module that owns the secret — see the header. Idempotent, and
 * irreversible by design: there is no way to take a value back out.
 *
 * @returns `true` when the value was accepted; `false` when it was empty or
 *          shorter than {@link MIN_SECRET_LENGTH}. The VALUE is never returned,
 *          logged or thrown, on any path.
 */
export function registerSecret(value: string): boolean {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (raw.length < MIN_SECRET_LENGTH) return false;
  for (const form of encodings(raw)) SECRETS.add(form);
  return true;
}

/**
 * How many entries the register holds — a COUNT, never a value. Exists so a
 * test (and a future `pipeline doctor`) can prove registration happened
 * without printing anything. The count exceeds the number of distinct secrets
 * because each carries its encodings.
 */
export function registeredSecretCount(): number {
  return SECRETS.size;
}

/** Longest first, so a secret that CONTAINS another (a key and its base64
 *  form, two keys sharing a prefix) is redacted whole rather than leaving the
 *  outer value's tail behind as plaintext. */
function orderedSecrets(): string[] {
  return [...SECRETS].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/** Longest registered entry, for the relay's carry bound. 0 when empty. */
function longestSecretLength(): number {
  let n = 0;
  for (const s of SECRETS) if (s.length > n) n = s.length;
  return n;
}

/**
 * Replace every occurrence of every registered secret with
 * {@link REDACTION_MARKER}.
 *
 * Pure, total and idempotent. With an empty register it returns its argument
 * unchanged and costs nothing, which is what makes it safe to wrap every sink
 * on the drive path — a run that never resolves a provider key pays for a
 * single `Set.size` check per write.
 */
export function scrub(text: string): string {
  if (SECRETS.size === 0) return text;
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const secret of orderedSecrets()) {
    if (out.includes(secret)) out = out.replaceAll(secret, REDACTION_MARKER);
  }
  return out;
}

/** A text sink: the shape `DriveDeps.out` / `DriveDeps.err` already use. */
export type Sink = (s: string) => void;

/**
 * Wrap a sink so nothing reaches it unscrubbed.
 *
 * Applied at the TOP of a command, around the caller-injectable sink AND its
 * default, so an injected `out`/`err` (tests, `commands/init.ts`) is covered
 * by exactly the same guarantee as the real stream.
 */
export function scrubWriter(sink: Sink): Sink {
  return (s: string) => sink(scrub(s));
}

/**
 * A sink that also reassembles chunk boundaries. Callable like a {@link Sink};
 * `flush()` releases whatever is still held.
 */
export interface ScrubbedRelay extends Sink {
  /** Emit the held partial line. MUST be called when the source ends, or its
   *  tail is lost. */
  flush(): void;
}

/** How much unterminated text the relay will hold before it gives up waiting
 *  for a newline and emits. Bounds memory against a child that prints a
 *  gigabyte on one line. */
const MAX_CARRY = 64 * 1024;

/**
 * The relay for a sink fed by ARBITRARY CHUNKS rather than whole writes — a
 * child process's stdout/stderr, where the OS decides where one `data` event
 * ends and the next begins.
 *
 * This exists because per-chunk scrubbing has a real hole: a key straddling a
 * chunk boundary matches neither half, and both halves reach the sink as
 * plaintext. Nothing about the boundary is under our control, so the relay
 * holds back the trailing PARTIAL LINE and emits only through the last
 * newline. A credential is a single-line token — no provider issues a key
 * containing a newline — so a value can only ever be split WITHIN a line, and
 * a line-complete prefix is therefore always safe to scrub and release.
 *
 * Progress output is not delayed by this: every write this package originates
 * ends in `\n`, so it flushes immediately. Only a child's mid-line fragment
 * waits, and only for the rest of its own line.
 *
 * If a single line grows past {@link MAX_CARRY} the relay emits all but the
 * last (longest-secret − 1) characters — still short enough that no registered
 * value can be split across the seam.
 */
export function scrubbedRelay(sink: Sink): ScrubbedRelay {
  let carry = '';
  const relay = ((chunk: string) => {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    carry += chunk;
    const nl = carry.lastIndexOf('\n');
    if (nl >= 0) {
      const head = carry.slice(0, nl + 1);
      carry = carry.slice(nl + 1);
      sink(scrub(head));
    }
    if (carry.length > MAX_CARRY) {
      const keep = Math.min(Math.max(longestSecretLength() - 1, 0), MAX_CARRY);
      const head = carry.slice(0, carry.length - keep);
      carry = carry.slice(carry.length - keep);
      if (head.length > 0) sink(scrub(head));
    }
  }) as ScrubbedRelay;
  relay.flush = (): void => {
    if (carry.length === 0) return;
    const tail = carry;
    carry = '';
    sink(scrub(tail));
  };
  return relay;
}
