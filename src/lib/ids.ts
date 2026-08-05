// ids — THE mint point. Every identity this product creates comes from here.
//
//   const runId = newId();   // "019fc762-5762-7000-a9bf-922ed8fa00be"
//
// ONE FUNCTION, ONE FORMAT FOR MINTING: `newId()` returns an RFC 9562 §5.7
// UUIDv7. There is no second mint site, no per-call format argument, and —
// deliberately — no runtime capability branch. See "WHY HAND-ROLLED" below.
//
// This file also hosts `uuidv5()` (RFC 9562 §5.5) — a DERIVATION, not a mint.
// It is additive, added by ux-v2 `b2`, for exactly one CLI-side caller:
// `hooks/analytics_relay.ts`'s `bypassRunIdFromToolUseId()` needs the SAME id
// out of PreToolUse and PostToolUse for one `tool_use_id`, computed twice, in
// two separate hook invocations, with NO shared state — the one case in this
// product where determinism beats randomness. See `hookIdFromToolUseId()`
// below. The SERVER-side v5 classes (`manager`, `step:path:*` — `04
// -subsystem-rules.md` §2) are a separate implementation living in
// `@baizor/pipeline-protocol` (ux-v2 `e2`'s deliverable, not this file) that
// MUST match this algorithm byte-for-byte; the pinned test vectors in
// `tests/ids.test.ts` exist so that implementation can be checked against
// this one without the two repos sharing code.
//
// WHY HAND-ROLLED (and not `Bun.randomUUIDv7()` / `crypto.randomUUID()`):
//   • `crypto.randomUUID()` is UUIDv4 (version nibble `4`). Wrong version, no
//     embedded timestamp, no index locality.
//   • `Bun.randomUUIDv7()` exists and IS reachable on the plugin-checkout path
//     (`apps/pipeline-cli/package.json` declares `engines.bun >= 1.3.14`), but
//     this same module also ships inside the `--target=node` bundle
//     (`bun build src/cli.ts --target=node`), where no native v7 primitive
//     exists below Node 26.1, and it is the format the runner
//     (`pipeline-runner/package.json`, `engines.node >= 1.0.0`) must agree
//     with. A `typeof Bun !== 'undefined' ? … : …` branch would mean two
//     generators with two monotonicity behaviours and two failure modes — i.e.
//     two mint points wearing one name. So there is exactly one code path, and
//     every runtime takes it.
//
// ZERO DEPENDENCIES: `node:crypto` and nothing else. The plugin's skills invoke
// this CLI straight out of the plugin's cached git checkout — a tree with no
// root `package.json` and no install step (`skills/run/SKILL.md`) — so ANY
// import of an external package reachable from `cli.ts` throws at import time
// for every plugin user on that path. Same constraint that forced
// `lib/vendor/privacy.ts` and `lib/vendor/transcript-walk.ts` to exist.
//
// ── INTRA-MILLISECOND ORDERING: IN SCOPE ─────────────────────────────────────
//
// This generator implements RFC 9562 §6.2 **Method 1 — Fixed-Length Dedicated
// Counter Bits**: `rand_a` (the 12 bits immediately after the timestamp, which
// is exactly where §6.2 requires the counter to sit) holds a per-millisecond
// counter, randomly seeded on every new tick, incremented on every mint inside
// the same tick.
//
// The alternative — a pure-CSPRNG `rand_a` — is conformant too, but leaves ids
// minted in the SAME millisecond mutually unordered. Three reasons this design
// wants the counter instead:
//
//   1. RFC 9562 §6.2 carries a SHOULD for implementations "concerned about
//      monotonicity with high-frequency UUID generation". This generator is in
//      that regime by measurement, not by speculation: the ux-v2 D7 evidence
//      recorded 5 000 mints inside ~256 ms (~20 mints per millisecond), so the
//      overwhelmingly common case is several ids sharing one tick.
//   2. The stated reason this product chose v7 over v4 at all is index
//      locality (ux-v2 `02-target-architecture.md`, trade-offs table). Locality
//      that stops at millisecond granularity only partly delivers that.
//   3. `07-security.md` T12 already ACCEPTS that a v7 id signals creation
//      order. The counter makes that accepted property actually true rather
//      than true-to-the-millisecond. It discloses nothing new beyond the
//      already-accepted millisecond timestamp: relative order among ids minted
//      by one process inside one millisecond.
//
// WHAT THE COUNTER DOES AND DOES NOT GUARANTEE:
//   • Within one process: ids are STRICTLY INCREASING as 128-bit big-endian
//     values and, equivalently, as lowercase canonical strings under plain
//     lexicographic comparison (the version nibble and variant bits are
//     constant, so they never perturb the ordering).
//   • Across processes or machines: NO ordering guarantee finer than the
//     millisecond timestamp. That is inherent to any counter-based v7 (RFC 9562
//     §6.2 says as much) and is not something this generator can fix.
//
// Uniqueness does not rest on the counter. Every id carries 62 CSPRNG bits in
// `rand_b`, drawn fresh per mint; the counter only orders ids that would
// otherwise tie.
//
// PURE LIBRARY: importing this module runs nothing but the module-level
// generator construction (which reads no clock and no entropy until the first
// `newId()` call).

import { randomBytes as nodeRandomBytes, createHash } from 'node:crypto';

// ── Bit layout (RFC 9562 §5.7) ───────────────────────────────────────────────
//
//   bits   0–47   unix_ts_ms   big-endian milliseconds since the Unix epoch
//   bits  48–51   ver          0b0111
//   bits  52–63   rand_a       12-bit counter, seeded per tick (§6.2 Method 1)
//   bits  64–65   var          0b10
//   bits  66–127  rand_b       62 CSPRNG bits
//
// As bytes: [ts0 ts1 ts2 ts3 ts4 ts5][ver|rand_a_hi][rand_a_lo][var|rand_b …]

/** `ver` field value — UUID version 7, placed in the high nibble of byte 6. */
const VERSION_7 = 0x70;

/** `var` field value — the RFC 4122/9562 variant `0b10`, in the top two bits of byte 8. */
const VARIANT_RFC = 0x80;

/** Widest value `rand_a` can hold (12 bits). */
const COUNTER_MAX = 0x0fff;

/**
 * Bits of CSPRNG seed loaded into the counter at the start of each new
 * millisecond. Eight of the twelve counter bits are seeded; the top four are
 * left clear as §6.2's "counter rollover guard", which reserves headroom so a
 * burst inside one tick cannot immediately overflow. Concretely: a fresh tick
 * starts somewhere in [0, 255] and can absorb at least 3 840 further mints in
 * that same millisecond before the rollover path is even reachable — two orders
 * of magnitude above the ~20/ms this generator is actually driven at.
 */
const COUNTER_SEED_MASK = 0xff;

/** `unix_ts_ms` is 48 bits. Reached in the year 10889; masked defensively so a
 *  nonsense clock can never corrupt the version nibble in the next byte. */
const MAX_UNIX_TS_MS = 0xffffffffffff;

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/** 16 bytes → canonical lowercase `8-4-4-4-12`. No Buffer, no dependency. */
function toCanonical(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < 16; i++) hex += HEX[bytes[i]];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Seams for the conformance tests ONLY — see `createIdGenerator`. */
export interface IdGeneratorOptions {
  /** Clock in epoch milliseconds. Default `Date.now`. */
  now?: () => number;
  /** CSPRNG. Must return at least `n` bytes. Default `node:crypto`'s `randomBytes`. */
  randomBytes?: (n: number) => Uint8Array;
}

/**
 * Build an independent UUIDv7 generator with an injectable clock and CSPRNG.
 *
 * **This is not a second mint point.** Product code calls `newId()`. This
 * factory is exported for exactly one reason: the counter-rollover and
 * clock-regression paths above are unreachable from a real clock in a test, and
 * an untested monotonicity guarantee is not a guarantee. Every generator owns
 * its own counter state, so a test can drive one without perturbing `newId()`.
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): () => string {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? nodeRandomBytes;

  // Highest timestamp this generator has emitted. Never moves backwards, so a
  // clock that jumps back (NTP step, VM restore, DST-unaware host) cannot make
  // this generator emit a smaller id than one it already handed out.
  let lastMs = -1;
  let counter = 0;

  return function mint(): string {
    const observed = now();
    const ms = Number.isFinite(observed) ? Math.max(0, Math.min(Math.trunc(observed), MAX_UNIX_TS_MS)) : 0;

    if (ms > lastMs) {
      // New tick: re-seed the counter (§6.2 Method 1 — the counter is random
      // per tick, not a global sequence, so it leaks no cross-tick volume).
      lastMs = ms;
      counter = random(1)[0] & COUNTER_SEED_MASK;
    } else {
      // Same tick, or the clock regressed. Either way `lastMs` is the timestamp
      // we keep, and the counter is what orders this id after the previous one.
      counter += 1;
      if (counter > COUNTER_MAX) {
        // §6.2 counter rollover guard: borrow a millisecond from the future
        // rather than emit a duplicate or a non-increasing id. Self-correcting
        // — the real clock catches up as soon as the burst subsides.
        lastMs = Math.min(lastMs + 1, MAX_UNIX_TS_MS);
        counter = random(1)[0] & COUNTER_SEED_MASK;
      }
    }

    const tsHi = Math.floor(lastMs / 0x100000000) & 0xffff; // bits 0–15
    const tsLo = lastMs % 0x100000000; // bits 16–47

    const bytes = new Uint8Array(16);
    bytes[0] = (tsHi >>> 8) & 0xff;
    bytes[1] = tsHi & 0xff;
    bytes[2] = (tsLo >>> 24) & 0xff;
    bytes[3] = (tsLo >>> 16) & 0xff;
    bytes[4] = (tsLo >>> 8) & 0xff;
    bytes[5] = tsLo & 0xff;
    bytes[6] = VERSION_7 | ((counter >>> 8) & 0x0f); // ver + rand_a high nibble
    bytes[7] = counter & 0xff; // rand_a low byte

    const entropy = random(8);
    bytes[8] = VARIANT_RFC | (entropy[0] & 0x3f); // var + rand_b top 6 bits
    for (let i = 1; i < 8; i++) bytes[8 + i] = entropy[i];

    return toCanonical(bytes);
  };
}

/** The process-wide generator backing `newId()`. */
const mintDefault = createIdGenerator();

/**
 * Mint a new identity. RFC 9562 UUIDv7, canonical lowercase `8-4-4-4-12`.
 *
 * This is the ONLY sanctioned way to create an id in this product — runs,
 * steps, requests, messages. Never derive one from a hash, never let a prompt
 * invent a format, never call `crypto.randomUUID()` (that is a v4).
 *
 * The deliberate exceptions are DERIVATIONS, never mints: the two step
 * classes the server derives rather than observes (`manager`, `step:path:*`)
 * are UUIDv**5** over the run UUID, so re-ingest stays idempotent (implemented
 * in `@baizor/pipeline-protocol`, not here), and this file's own
 * `hookIdFromToolUseId()` below, for the one CLI-side caller that needs
 * determinism instead of randomness. Conformance tests must assert the
 * version nibble per class — `7` for anything minted by this function, `5`
 * for those derived ones.
 */
export function newId(): string {
  return mintDefault();
}

// ── UUIDv5 (RFC 9562 §5.5) — derivation, not minting ─────────────────────────
//
// `newId()` above is the only MINT point. `uuidv5()` below is a pure
// DERIVATION: same (name, namespace) in, same id out, forever — the opposite
// property to `newId()`'s CSPRNG-backed uniqueness. It exists so
// `hooks/analytics_relay.ts` can compute the SAME run id from a PreToolUse and
// a PostToolUse invocation of the SAME `tool_use_id` — two separate hook
// processes, no shared state, only the input in common (`:1028`'s rationale
// for why the id must stay deterministic there).
//
// ARGUMENT ORDER IS NOT COSMETIC: `uuidv5(name, namespace)`, matching the
// prevailing JS convention (the `uuid` package's `v5(name, namespace)`).
// `namespace` MUST itself be a canonical UUID string — `parseUUID` below
// throws `TypeError('Invalid UUID')` when it is not. The taskflow for this
// work records a real prior bug from getting this backwards:
// `uuidv5(run_uuid, "manager")` passes the run UUID as `name` and the literal
// string `"manager"` as `namespace` — `"manager"` is not a UUID, so THAT call
// throws. The correct call is `uuidv5("manager", run_uuid)`.

/** Canonical `8-4-4-4-12` UUID string → its 16 bytes. Throws `TypeError('Invalid
 *  UUID')` — not a generic error — matching the `uuid` package's own contract,
 *  because `uuidv5`'s namespace argument relies on exactly this failure mode
 *  to catch a reversed argument order at the call site instead of silently
 *  hashing garbage. */
function parseUUID(uuid: string): Uint8Array {
  if (
    typeof uuid !== 'string' ||
    uuid.length !== 36 ||
    uuid[8] !== '-' ||
    uuid[13] !== '-' ||
    uuid[18] !== '-' ||
    uuid[23] !== '-'
  ) {
    throw new TypeError('Invalid UUID');
  }
  const hex = uuid.slice(0, 8) + uuid.slice(9, 13) + uuid.slice(14, 18) + uuid.slice(19, 23) + uuid.slice(24);
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new TypeError('Invalid UUID');
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * RFC 9562 §5.5 UUIDv5: a deterministic, name-based UUID — SHA-1 over
 * `namespace bytes ++ name bytes`, truncated to 16 bytes, with the version
 * nibble forced to `0101` and the variant bits to `0b10`. Pure function, zero
 * dependencies beyond `node:crypto`'s `createHash` (already imported above)
 * and the global `TextEncoder` (no import needed — keeps parity with this
 * file's zero-runtime-dependency contract, see `tests/ids.test.ts`).
 *
 * `namespace` must be a canonical UUID string or this throws
 * `TypeError('Invalid UUID')` — see the argument-order note above.
 */
export function uuidv5(name: string, namespace: string): string {
  const nsBytes = parseUUID(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(nsBytes.length + nameBytes.length);
  input.set(nsBytes, 0);
  input.set(nameBytes, nsBytes.length);

  const digest = createHash('sha1').update(input).digest();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = digest[i];
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // ver = 0b0101 (5)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // var = 0b10

  return toCanonical(bytes);
}

/**
 * Fixed namespace UUID for `hookIdFromToolUseId()` below — analogous to RFC
 * 9562's predefined DNS/URL/OID/X.500 namespaces, but private to this
 * product. A constant, not a secret: anyone can read it from this source
 * file, and that is fine — it buys NO security property, only a stable input
 * to a deterministic hash. Generated once (`crypto.randomUUID()`), pinned
 * here, and MUST NEVER change: changing it would silently decorrelate any
 * PreToolUse/PostToolUse pair that straddles a plugin upgrade mid-run.
 */
export const NAMESPACE_TOOL_USE = '10422061-094a-4a10-a3c5-c9edc54febb4';

/**
 * Deterministic id for `hooks/analytics_relay.ts`'s `bypassRunIdFromToolUseId`
 * — UUIDv5 of `tool_use_id` under `NAMESPACE_TOOL_USE`. NOT a mint site: it
 * exists because PreToolUse and PostToolUse are separate processes that must
 * independently compute the SAME id from the SAME `tool_use_id`, with no
 * channel between them to agree on a random one. Version nibble `5`, variant
 * `0b10` — see `tests/ids.test.ts` for the pinned test vector and the
 * two-process determinism test.
 */
export function hookIdFromToolUseId(toolUseId: string): string {
  return uuidv5(toolUseId, NAMESPACE_TOOL_USE);
}
