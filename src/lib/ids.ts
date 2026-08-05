// ids — THE mint point. Every identity this product creates comes from here.
//
//   const runId = newId();   // "019fc762-5762-7000-a9bf-922ed8fa00be"
//
// ONE FUNCTION, ONE FORMAT: `newId()` returns an RFC 9562 §5.7 UUIDv7. There is
// no second mint site, no per-call format argument, and — deliberately — no
// runtime capability branch. See "WHY HAND-ROLLED" below.
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

import { randomBytes as nodeRandomBytes } from 'node:crypto';

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
 * The one deliberate exception lives server-side: the two step classes the
 * server derives rather than observes (`manager`, `step:path:*`) are UUIDv**5**
 * over the run UUID, so re-ingest stays idempotent. Those do not come from
 * here, and conformance tests must assert the version nibble per class — `7`
 * for anything minted by this function, `5` for those two.
 */
export function newId(): string {
  return mintDefault();
}
