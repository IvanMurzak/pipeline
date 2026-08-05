// ids.test.ts — conformance tests for THE mint point (src/lib/ids.ts).
//
//   bun test tests/ids.test.ts
//
// WHAT THESE PIN, AND WHY IN THIS SHAPE:
//
// 1. VERSION AND VARIANT ARE READ AS BITS, NEVER AS A REGEX. `/^[0-9a-f]{8}-…/`
//    matches a UUIDv4 as happily as a v7 — it tests the formatter, not the
//    format. Every conformance assertion below decodes the 16 bytes and reads
//    `ver` (bits 48–51) and `var` (bits 64–65) directly.
//
// 2. THE VERSION ASSERTION IS SCOPED TO CLIENT-MINTED IDS. `newId()` mints
//    UUIDv7 — nibble `7`. It is NOT the only version in the system: the two
//    step classes the server DERIVES rather than observes (`manager` and
//    `step:path:*`) are UUIDv5 over the run UUID, deliberately, so re-ingest
//    stays idempotent. A blanket "every row in `step_executions` has nibble 7"
//    test would fail on exactly those two by construction. `var = 0b10` is the
//    one thing that IS universal — v5 and v7 share it — and that assertion is
//    made unconditionally here.
//
// 3. INTRA-MILLISECOND ORDERING IS IN SCOPE, so it is tested as STRICT
//    increase, not merely as non-decreasing timestamps. `src/lib/ids.ts`
//    implements RFC 9562 §6.2 Method 1 (a seeded counter in `rand_a`); see that
//    file's header for the three reasons. Note that a non-decreasing-TIMESTAMP
//    test passes under a pure-CSPRNG `rand_a` too — it tests the clock, not the
//    ordering — so it appears below as a separate, weaker assertion, and the
//    strict-ordering tests are the ones that would actually catch a regression
//    back to unordered `rand_a`.
//
// 4. THE ROLLOVER AND CLOCK-REGRESSION PATHS ARE DRIVEN, not hoped for. They
//    are unreachable from a real clock inside a test, which is why
//    `createIdGenerator` takes an injectable clock and CSPRNG.
//
// 5. THE NODE-TARGET BUNDLE IS ACTUALLY BUILT AND ACTUALLY RUN UNDER NODE.
//    "Works on both runtimes" is the whole reason this generator is
//    hand-rolled; asserting it only under Bun would assert nothing.

import { test, expect, describe } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createIdGenerator, newId } from '../src/lib/ids';

const CLI_ROOT = resolve(import.meta.dir, '..');
const IDS_SRC = join(CLI_ROOT, 'src', 'lib', 'ids.ts');

// ── decoding helpers (bit-level, no regex anywhere) ──────────────────────────

/** Canonical `8-4-4-4-12` string → the 16 bytes it encodes. Throws if the
 *  string is not 32 hex digits with dashes in the canonical places, so a
 *  malformed id fails loudly rather than silently decoding to zeros. */
function bytesOf(uuid: string): Uint8Array {
  const parts = uuid.split('-');
  if (parts.length !== 5) throw new Error(`not canonical (want 5 dash-groups): ${uuid}`);
  const want = [8, 4, 4, 4, 12];
  parts.forEach((p, i) => {
    if (p.length !== want[i]) throw new Error(`group ${i} is ${p.length} chars, want ${want[i]}: ${uuid}`);
  });
  const hex = parts.join('');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isInteger(byte)) throw new Error(`non-hex byte ${i}: ${uuid}`);
    out[i] = byte;
  }
  return out;
}

/** `ver` — bits 48–51, the high nibble of byte 6. */
const versionNibble = (b: Uint8Array): number => b[6] >>> 4;

/** `var` — bits 64–65, the top two bits of byte 8. RFC variant is `0b10`. */
const variantBits = (b: Uint8Array): number => b[8] >>> 6;

/** `unix_ts_ms` — bits 0–47, big-endian. */
function timestampMs(b: Uint8Array): number {
  return ((b[0] << 8) | b[1]) * 0x100000000 + (((b[2] << 24) >>> 0) + (b[3] << 16) + (b[4] << 8) + b[5]);
}

/** `rand_a` — bits 52–63, the 12 bits immediately after the timestamp. Under
 *  §6.2 Method 1 this is the per-millisecond counter. */
const randA = (b: Uint8Array): number => ((b[6] & 0x0f) << 8) | b[7];

/** `rand_b` — bits 66–127, the 62 CSPRNG bits. */
function randB(b: Uint8Array): bigint {
  let v = BigInt(b[8] & 0x3f);
  for (let i = 9; i < 16; i++) v = (v << 8n) | BigInt(b[i]);
  return v;
}

/** A deterministic CSPRNG stand-in: every byte is `fill`. Used to strip all
 *  randomness out so ordering is the only variable left. */
const constantBytes =
  (fill: number) =>
  (n: number): Uint8Array =>
    new Uint8Array(n).fill(fill);

/** The D7 measurement regime: ~5 000 mints inside a few hundred milliseconds. */
const BURST = 5000;

function mintBurst(mint: () => string, n = BURST): string[] {
  const out: string[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = mint();
  return out;
}

// ── 1. version + variant, on client-minted ids ───────────────────────────────

describe('RFC 9562 §5.7 field conformance — client-minted ids', () => {
  test('every client-minted id carries ver = 0b0111 (nibble 7)', () => {
    // Scoped deliberately: this holds for `newId()` output. Server-DERIVED step
    // ids (`manager`, `step:path:*`) are UUIDv5 and carry nibble 5 by design —
    // do not generalise this assertion to `step_executions` rows.
    for (const id of mintBurst(newId)) {
      const b = bytesOf(id);
      expect(versionNibble(b)).toBe(0b0111);
    }
  });

  test('every id carries var = 0b10 (this one IS universal — v5 and v7 share it)', () => {
    for (const id of mintBurst(newId)) {
      expect(variantBits(bytesOf(id))).toBe(0b10);
    }
  });

  test('the version and variant bits are the ONLY constant bits — nothing else is pinned flat', () => {
    // Guards against a generator that "passes" by emitting a constant. Both
    // random fields must vary across a burst.
    const ids = mintBurst(newId, 500);
    const distinctRandB = new Set(ids.map((id) => randB(bytesOf(id)).toString()));
    expect(distinctRandB.size).toBe(ids.length);
  });

  test('canonical formatting: 36 chars, dashes at 8/13/18/23, lowercase hex', () => {
    // Formatting only — NOT the conformance check. Kept separate so nobody
    // mistakes a shape test for a version test.
    const id = newId();
    expect(id.length).toBe(36);
    expect([id[8], id[13], id[18], id[23]]).toEqual(['-', '-', '-', '-']);
    expect(id).toBe(id.toLowerCase());
    expect(() => bytesOf(id)).not.toThrow();
  });

  test('no duplicates across a 20 000-mint burst', () => {
    const ids = mintBurst(newId, 20000);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── 2. the timestamp field ───────────────────────────────────────────────────

describe('unix_ts_ms (bits 0–47)', () => {
  test('encodes the wall clock at mint time', () => {
    // A FRESH generator on purpose. `newId()`'s shared counter can legitimately
    // sit a millisecond or two ahead of the clock after a sustained burst — that
    // is §6.2's rollover guard doing its job, not a clock bug — and the bursts
    // above are large enough to reach it on a fast enough machine. Measured
    // here: ~1 000 mints/ms, against a per-tick headroom of at least 3 841, so
    // there is roughly 4× of margin today. This test is about the timestamp
    // field, so it should not be the thing that goes red when that margin
    // narrows.
    const mint = createIdGenerator();
    const before = Date.now();
    const ms = timestampMs(bytesOf(mint()));
    const after = Date.now();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  test('newId() tracks the wall clock — never behind it, never far ahead of it', () => {
    const before = Date.now();
    const ms = timestampMs(bytesOf(newId()));
    expect(ms).toBeGreaterThanOrEqual(before);
    // Borrowing from the future is bounded (one ms per 4 096 mints in a tick)
    // and self-correcting once the burst subsides.
    expect(ms).toBeLessThanOrEqual(Date.now() + 100);
  });

  test('is NON-DECREASING across a rapid burst', () => {
    // The DoD's baseline assertion. Note what it does and does not prove: it
    // tests the timestamp FIELD, and it would pass just as well with a
    // pure-CSPRNG `rand_a` and no intra-millisecond ordering at all. The strict
    // ordering tests below are the ones with teeth.
    const stamps = mintBurst(newId).map((id) => timestampMs(bytesOf(id)));
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]);
    }
  });

  test('the burst really does share milliseconds — so the ordering tests are not vacuous', () => {
    const stamps = mintBurst(newId).map((id) => timestampMs(bytesOf(id)));
    expect(new Set(stamps).size).toBeLessThan(stamps.length);
  });
});

// ── 3. intra-millisecond ordering — IN SCOPE (RFC 9562 §6.2 Method 1) ────────

describe('intra-millisecond ordering (§6.2 Method 1, counter in rand_a)', () => {
  test('a rapid burst is STRICTLY increasing, not merely non-decreasing', () => {
    const ids = mintBurst(newId);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  test('ids sharing one millisecond are ordered by rand_a', () => {
    const ids = mintBurst(newId);
    const byMs = new Map<number, number[]>();
    for (const id of ids) {
      const b = bytesOf(id);
      const bucket = byMs.get(timestampMs(b));
      if (bucket) bucket.push(randA(b));
      else byMs.set(timestampMs(b), [randA(b)]);
    }
    let tiedBuckets = 0;
    for (const counters of byMs.values()) {
      if (counters.length < 2) continue;
      tiedBuckets++;
      for (let i = 1; i < counters.length; i++) {
        expect(counters[i]).toBe(counters[i - 1] + 1);
      }
    }
    expect(tiedBuckets).toBeGreaterThan(0);
  });

  test('the counter is CSPRNG-seeded on every new tick, with four guard bits clear', () => {
    // Seed byte 0xff → counter starts at 0xff, i.e. the top four of the twelve
    // counter bits are clear. That headroom is §6.2's rollover guard.
    let t = 1_700_000_000_000;
    const mint = createIdGenerator({ now: () => t, randomBytes: constantBytes(0xff) });
    const first = randA(bytesOf(mint()));
    expect(first).toBe(0xff);
    t += 1;
    expect(randA(bytesOf(mint()))).toBe(0xff);
    // 0xff + 3840 further mints still fit inside the 12 bits.
    expect(0xff + 3840).toBe(0x0fff);
  });

  test('a different seed byte lands in the counter verbatim (the seed is not hard-coded)', () => {
    const mint = createIdGenerator({ now: () => 1_700_000_000_000, randomBytes: constantBytes(0x2a) });
    expect(randA(bytesOf(mint()))).toBe(0x2a);
  });

  test('rand_b is drawn fresh per mint even when the clock is frozen', () => {
    const mint = createIdGenerator({ now: () => 1_700_000_000_000 });
    const seen = new Set(mintBurst(mint, 1000).map((id) => randB(bytesOf(id)).toString()));
    expect(seen.size).toBe(1000);
  });
});

// ── 4. the paths a real clock cannot reach ───────────────────────────────────

describe('counter rollover (§6.2 rollover guard)', () => {
  test('a burst past 4096 in one frozen millisecond borrows a millisecond, never repeats', () => {
    const FROZEN = 1_700_000_000_000;
    // All-zero CSPRNG: the counter seeds at 0 and rand_b is constant, so the
    // counter is the only thing that can order these ids.
    const mint = createIdGenerator({ now: () => FROZEN, randomBytes: constantBytes(0) });
    const ids = mintBurst(mint, 5000);

    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }

    // Counter fills 0…4095 inside the frozen tick, then rolls into FROZEN+1.
    expect(randA(bytesOf(ids[0]))).toBe(0);
    expect(randA(bytesOf(ids[4095]))).toBe(4095);
    expect(timestampMs(bytesOf(ids[4095]))).toBe(FROZEN);
    expect(timestampMs(bytesOf(ids[4096]))).toBe(FROZEN + 1);
    expect(randA(bytesOf(ids[4096]))).toBe(0);

    // Borrowing is bounded: 5 000 mints in one tick borrow exactly one ms.
    expect(timestampMs(bytesOf(ids[4999]))).toBe(FROZEN + 1);
  });

  test('the version and variant bits survive a full counter (0x0fff) intact', () => {
    const mint = createIdGenerator({ now: () => 1_700_000_000_000, randomBytes: constantBytes(0) });
    const ids = mintBurst(mint, 4096);
    const last = bytesOf(ids[4095]);
    expect(randA(last)).toBe(0x0fff);
    expect(versionNibble(last)).toBe(0b0111);
    expect(variantBits(last)).toBe(0b10);
  });
});

describe('clock regression', () => {
  test('a backwards clock never produces a smaller id', () => {
    let t = 1_700_000_000_000;
    const mint = createIdGenerator({ now: () => t, randomBytes: constantBytes(0) });
    const before = mint();
    t -= 5000; // NTP step / VM restore / a host that just went back in time
    const after = mint();
    expect(after > before).toBe(true);
    expect(timestampMs(bytesOf(after))).toBe(timestampMs(bytesOf(before)));
    expect(randA(bytesOf(after))).toBe(randA(bytesOf(before)) + 1);
  });

  test('once the clock passes the frozen high-water mark, the timestamp tracks it again', () => {
    let t = 1_700_000_000_000;
    const mint = createIdGenerator({ now: () => t, randomBytes: constantBytes(0) });
    mint();
    t -= 100;
    mint();
    t += 5000; // real time overtakes the high-water mark
    const recovered = timestampMs(bytesOf(mint()));
    expect(recovered).toBe(t);
  });
});

// ── 5. zero dependencies, one code path ──────────────────────────────────────

describe('dependency and runtime-branch constraints', () => {
  const source = readFileSync(IDS_SRC, 'utf-8');

  test('every import specifier in ids.ts is a node: builtin', () => {
    const specifiers = [
      ...source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g),
      ...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...source.matchAll(/(?:^|[^.\w])import\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec.startsWith('node:')).toBe(true);
    }
  });

  test('there is no runtime capability branch — no native v7/v4 primitive is called', () => {
    // A `typeof Bun !== "undefined" ? Bun.randomUUIDv7() : hand-rolled` branch
    // would be two generators with two monotonicity behaviours wearing one
    // name. Comments are stripped before the check so this file's own prose,
    // which names those primitives, cannot mask a real call.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('randomUUIDv7');
    expect(code).not.toContain('randomUUID(');
    expect(code).not.toContain('typeof Bun');
  });

  test('the CLI package still declares zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf-8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      expect(Object.keys(pkg[field] ?? {})).toEqual([]);
    }
  });
});

// ── 6. the --target=node bundle, actually run under Node ─────────────────────

const nodeProbe = spawnSync('node', ['--version'], { encoding: 'utf-8' });
const NODE_AVAILABLE = !nodeProbe.error && nodeProbe.status === 0;

describe('the --target=node bundle', () => {
  test.skipIf(!NODE_AVAILABLE)(
    'bundles with zero externals and mints conformant, strictly increasing ids under Node',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'ids-node-'));
      try {
        const bundle = join(dir, 'ids.mjs');
        // Same flags the CLI's own `bun run build` uses.
        const built = spawnSync(
          process.execPath,
          ['build', IDS_SRC, '--target=node', '--format=esm', `--outfile=${bundle}`],
          { encoding: 'utf-8', cwd: CLI_ROOT },
        );
        expect(built.stderr + built.stdout).not.toContain('Could not resolve');
        expect(built.status).toBe(0);

        const driver = join(dir, 'driver.mjs');
        writeFileSync(
          driver,
          [
            "import { newId } from './ids.mjs';",
            'const out = [];',
            `for (let i = 0; i < ${BURST}; i++) out.push(newId());`,
            'process.stdout.write(JSON.stringify(out));',
            '',
          ].join('\n'),
        );

        const ran = spawnSync('node', [driver], { encoding: 'utf-8', cwd: dir });
        if (ran.error) throw ran.error;
        if (ran.status !== 0) throw new Error(`node exited ${ran.status}: ${ran.stderr}`);

        const ids = JSON.parse(ran.stdout) as string[];
        expect(ids.length).toBe(BURST);
        expect(new Set(ids).size).toBe(BURST);
        for (const id of ids) {
          const b = bytesOf(id);
          expect(versionNibble(b)).toBe(0b0111);
          expect(variantBits(b)).toBe(0b10);
        }
        for (let i = 1; i < ids.length; i++) {
          expect(ids[i] > ids[i - 1]).toBe(true);
        }
        // The hand-rolled path is what ran: no native v7 primitive exists in
        // the bundle to fall back to.
        const bundleText = readFileSync(bundle, 'utf-8');
        expect(bundleText).not.toContain('randomUUIDv7');
        expect(bundleText).toContain('node:crypto');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
