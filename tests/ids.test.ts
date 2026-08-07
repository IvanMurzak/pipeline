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
import { createIdGenerator, newId, uuidv5, hookIdFromToolUseId, NAMESPACE_TOOL_USE } from '../src/lib/ids';

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

// ── 7. UUIDv5 (RFC 9562 §5.5) — derivation, not minting (ux-v2 b2) ──────────
//
// `uuidv5` is additive: it exists so `hooks/analytics_relay.ts` can derive a
// DETERMINISTIC id from `tool_use_id` (see `hookIdFromToolUseId` below and
// `<plugin-root>/tests/hook-bypass-id-determinism.test.ts` for the
// cross-PROCESS version of the determinism check — calling a function twice
// in one test process proves less than it looks like it proves).
//
// CROSS-REPO CONTRACT: `@baizor/pipeline-protocol` (ux-v2 `e2`) ships an
// INDEPENDENT UUIDv5 implementation for the server-derived `manager` /
// `step:path:*` step classes (`04-subsystem-rules.md` §2). Both
// implementations must produce byte-identical output for the same
// (name, namespace) pair — they are pinned to the SAME external ground
// truth below (the RFC 4122/9562 worked example, independently reproducible
// via Python's `uuid.uuid5(uuid.NAMESPACE_DNS, "www.example.com")`) rather
// than to each other, and the `manager`/`step:path:` vectors exist so a
// change on either side is caught without the two repos sharing code.

describe('uuidv5 (RFC 9562 §5.5) — RFC ground-truth vector', () => {
  test('the RFC 4122/9562 worked example: DNS namespace + "www.example.com"', () => {
    // namespace DNS = 6ba7b810-9dad-11d1-80b4-00c04fd430c8 (RFC 9562 Appendix A).
    // Cross-checked against Python's uuid.uuid5(uuid.NAMESPACE_DNS,
    // "www.example.com") and an independent node:crypto SHA-1 computation.
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  test('output carries ver = 0b0101 (nibble 5) and var = 0b10', () => {
    const id = uuidv5('anything', '6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    const b = bytesOf(id);
    expect(versionNibble(b)).toBe(0b0101);
    expect(variantBits(b)).toBe(0b10);
  });

  test('is a pure function: same (name, namespace) in, same id out, every time', () => {
    const ns = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const first = uuidv5('stable-name', ns);
    for (let i = 0; i < 50; i++) expect(uuidv5('stable-name', ns)).toBe(first);
  });

  test('different names under the same namespace never collide (spot check)', () => {
    const ns = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const ids = new Set(Array.from({ length: 200 }, (_, i) => uuidv5(`name-${i}`, ns)));
    expect(ids.size).toBe(200);
  });
});

describe('uuidv5 argument order (name, namespace) — NOT cosmetic', () => {
  // 04-subsystem-rules.md §2.1 pins the call shape `uuidv5("manager", run_uuid)`
  // and records a REAL prior bug from getting it backwards.
  const RUN_UUID = '019fc762-5762-7000-a9bf-922ed8fa00be';

  test('correct order succeeds: uuidv5("manager", run_uuid)', () => {
    expect(() => uuidv5('manager', RUN_UUID)).not.toThrow();
  });

  test('reversed order throws TypeError(\'Invalid UUID\') — the exact prior bug', () => {
    // uuidv5(run_uuid, "manager"): "manager" is not a UUID, so it cannot be
    // a namespace. This is the taskflow's recorded regression, reproduced
    // and pinned so it can never silently return again.
    expect(() => uuidv5(RUN_UUID, 'manager')).toThrow(TypeError);
    expect(() => uuidv5(RUN_UUID, 'manager')).toThrow('Invalid UUID');
  });

  test('a malformed namespace (wrong dash positions, non-hex, wrong length) always throws', () => {
    for (const bad of ['', 'not-a-uuid', RUN_UUID.replace(/-/g, ''), RUN_UUID.slice(0, 35), `${RUN_UUID}x`]) {
      expect(() => uuidv5('name', bad)).toThrow(TypeError);
    }
  });
});

describe('uuidv5 — server-derived step-class vectors (parity with @baizor/pipeline-protocol e2)', () => {
  // These pin the EXACT inputs 04-subsystem-rules.md §2 names for the two
  // server-derived step classes, over a fixed run UUID, so pipeline-protocol's
  // independent implementation can be checked against these same numbers.
  const RUN_UUID = '019fc762-5762-7000-a9bf-922ed8fa00be';

  test('"manager" class: uuidv5("manager", run_uuid)', () => {
    expect(uuidv5('manager', RUN_UUID)).toBe('6f9a18f1-018b-5d3e-a60e-8865d5f9d110');
  });

  test('"step:path:*" class: uuidv5("step:path:<iterationPath>", run_uuid)', () => {
    expect(uuidv5('step:path:/abs/example/.pipeline/demo/steps/01-x.md', RUN_UUID)).toBe(
      '13deb24c-d758-5425-a40a-1fce371ff1e9',
    );
  });

  test('idempotent over re-ingest: computing either vector twice never drifts', () => {
    expect(uuidv5('manager', RUN_UUID)).toBe(uuidv5('manager', RUN_UUID));
  });
});

// ── 8. hookIdFromToolUseId — the ONE CLI-side v5 caller ──────────────────────

describe('hookIdFromToolUseId (hooks/analytics_relay.ts bypassRunIdFromToolUseId)', () => {
  test('pinned test vector', () => {
    expect(hookIdFromToolUseId('toolu_01H8XJZ7K9M2NPQR3STUVWXYZ0')).toBe(
      '5e429d42-e46c-5bfb-9fb4-6d56bae76e01',
    );
  });

  test('is exactly uuidv5(toolUseId, NAMESPACE_TOOL_USE)', () => {
    expect(hookIdFromToolUseId('toolu_abc')).toBe(uuidv5('toolu_abc', NAMESPACE_TOOL_USE));
  });

  test('carries ver = 0b0101 (nibble 5), never 0b0111 (newId()\'s nibble 7)', () => {
    const b = bytesOf(hookIdFromToolUseId('toolu_any'));
    expect(versionNibble(b)).toBe(0b0101);
    expect(variantBits(b)).toBe(0b10);
  });

  test('deterministic within a process: same tool_use_id, same id, every call', () => {
    const first = hookIdFromToolUseId('toolu_repeat_check');
    for (let i = 0; i < 20; i++) expect(hookIdFromToolUseId('toolu_repeat_check')).toBe(first);
  });

  test('different tool_use_ids never collide (spot check)', () => {
    const ids = new Set(Array.from({ length: 200 }, (_, i) => hookIdFromToolUseId(`toolu_${i}`)));
    expect(ids.size).toBe(200);
  });

  // NOTE: the test that actually matters for the DoD — "a PreToolUse/
  // PostToolUse pair for the same tool_use_id still resolves to the same
  // id" across two SEPARATE PROCESSES with no shared state — lives in
  // <plugin-root>/tests/hook-bypass-id-determinism.test.ts. A same-process
  // determinism test (above) is necessary but not sufficient: it would pass
  // even if the real hook relied on in-process module state that does not
  // survive across the two independent hook invocations Claude Code performs.
});
