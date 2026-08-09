// PORT ALLOCATION — the CONSUMER side (taskflow-v2 f4, x2).
//
// tests/worktree-ports.test.ts covers the ALLOCATOR: it probes and reserves.
// Its own probe (port-alloc.ts `isPortFree`) binds ONE socket per address,
// then immediately releases it before moving to the next address/candidate —
// that is enough to answer "is this port free right now", but it is a
// different assertion from what a real consumer does: a worktree slot's
// worker starts an app, an API, a stub/database and a spare all at once, and
// holds every one of those sockets open for the lifetime of the process. This
// file proves THAT contract — that a block the allocator hands out can
// actually be bound, all at once, by whoever receives it — end to end from
// the consumer's position.
//
// The two addresses port-alloc.ts's own header calls decisive (wildcard and
// loopback) are exercised explicitly rather than assumed to agree: on Windows
// a bind to 0.0.0.0:P succeeds even while another process holds 127.0.0.1:P,
// so a consumer that only ever tried the wildcard would not have proven the
// port is available on loopback too (verified empirically against this
// module's own header, not merely quoted from it).

import { test, expect, afterEach } from 'bun:test';
import { cleanupCreated, mkTmp } from './_git-sandbox';
import {
  allocatePorts,
  deterministicBase,
  isPortFree,
  releaseReservations,
  reservationDirFor,
  type PortRange,
} from '../src/lib/port-alloc';

// A private range this file owns outright: outside every range the rest of
// this suite uses (tests/worktree-ports.test.ts, tests/gc-slot-root.test.ts,
// tests/worktree-teardown.test.ts sweep 21400-24399; this file alone gets
// 27000-27099), and — like the whole default range — well clear of the ports
// local dev toolchains squat on (3000, 5173, 8080, 9229…) so a developer's
// running services are never at risk of colliding with this test.
const RANGE: PortRange = { min: 27000, max: 27099 };
const BLOCK = 4;

interface HeldServer {
  stop(closeActiveConnections?: boolean): void;
}
interface BunListen {
  listen(opts: { hostname: string; port: number; socket: Record<string, unknown> }): HeldServer;
}
const bun = (globalThis as unknown as { Bun: BunListen }).Bun;

const held: HeldServer[] = [];

/** Bind `hostname:port` for real and keep it open — the consumer's hold, not
 *  the allocator's probe-and-release. null on success, the failure code
 *  otherwise, so a caller can assert without the test aborting mid-loop and
 *  leaking whatever it already opened (afterEach closes those too, but a
 *  named assertion is a better failure message than an uncaught throw). */
function bindHeld(hostname: string, port: number): string | null {
  try {
    held.push(bun.listen({ hostname, port, socket: { data() {} } }));
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

/** Every listener is closed on both the pass and the failure path — bun:test
 *  runs afterEach even when the test body threw. */
afterEach(() => {
  while (held.length) {
    try {
      held.pop()!.stop(true);
    } catch {
      // best-effort: the socket is going away either way
    }
  }
  cleanupCreated();
});

/** Two slot names whose FIRST candidate base collides — without this, two
 *  arbitrary names land on different bases by construction (23-ish candidate
 *  blocks fit in a 100-wide/4-port range) and "the second slot's block is
 *  disjoint from the first" would be true by luck, never because the
 *  consumer's physical hold forced the allocator's probe to move on. */
function sameBaseNames(prefix: string, count: number, range: PortRange): [string, string] {
  const buckets = new Map<number, string[]>();
  for (let i = 0; i < 8000; i++) {
    const name = `${prefix}-${i}`;
    const base = deterministicBase(name, count, range);
    const list = buckets.get(base) ?? [];
    list.push(name);
    buckets.set(base, list);
    if (list.length >= 2) return [list[0]!, list[1]!];
  }
  throw new Error(`could not find 2 names sharing a base in ${range.min}-${range.max}`);
}

test(
  'a consumer binds every port of an allocated block simultaneously, on the wildcard and on loopback, ' +
    'and a second slot allocated while the first is physically held lands on a disjoint, equally bindable block',
  () => {
    const registryDir = reservationDirFor(mkTmp('port-consumer-registry-'));
    const liveA = mkTmp('port-consumer-slot-a-');
    const liveB = mkTmp('port-consumer-slot-b-');

    // Two names that hash to the SAME first candidate block, so slot B's
    // allocation is forced to contend with slot A's — the case this test
    // exists to cover.
    const [nameA, nameB] = sameBaseNames('consumer', BLOCK, RANGE);
    const base = deterministicBase(nameA, BLOCK, RANGE);
    expect(deterministicBase(nameB, BLOCK, RANGE)).toBe(base);

    // Not vacuous, and not at the mercy of whatever else this machine
    // happens to be running: both the shared first candidate and the block
    // one tile along must start genuinely free.
    for (let p = base; p < base + 2 * BLOCK; p++) expect(`${p}: ${isPortFree(p)}`).toBe(`${p}: true`);

    // ---- (1) allocate slot A through the SAME public entry point the ------
    // ---- provisioner uses (src/lib/worktree-provision.ts calls this -------
    // ---- function directly, after the worktree exists) --------------------
    const a = allocatePorts({ name: nameA, count: BLOCK, reservationDir: registryDir, livePath: liveA, range: RANGE });
    if (!a.ok) throw new Error(`slot A allocation failed: ${a.detail}`);
    expect(a.base).toBe(base);
    expect(a.ports).toEqual([base, base + 1, base + 2, base + 3]);

    // ---- (2) the CONSUMER side: bind every port in the block AT ONCE, -----
    // ---- on the wildcard, and hold them open (not probe-and-release) ------
    for (const port of a.ports) {
      expect(`0.0.0.0:${port} bound=${bindHeld('0.0.0.0', port) === null}`).toBe(`0.0.0.0:${port} bound=true`);
    }
    expect(held.length).toBe(BLOCK); // all four of slot A's ports, open simultaneously

    // ---- (3) release slot A's RESERVATION only — its sockets stay bound. --
    // ---- What must now keep slot B off these ports is the physical hold, --
    // ---- not the reservation registry. ------------------------------------
    expect(releaseReservations(registryDir, nameA, liveA)).toBe(BLOCK);

    // ---- (4) allocate slot B while slot A's ports are still bound and -----
    // ---- unreserved. Its first candidate IS slot A's block (same base), ---
    // ---- so this only proves anything because the probe has to see the ----
    // ---- live sockets and move on — a coincidence-free pass would not. ----
    const b = allocatePorts({ name: nameB, count: BLOCK, reservationDir: registryDir, livePath: liveB, range: RANGE });
    if (!b.ok) throw new Error(`slot B allocation failed: ${b.detail}`);
    expect(b.base).toBe(base + BLOCK); // the very next tile — the probe advanced, it did not scatter
    expect(b.ports).toEqual([base + BLOCK, base + BLOCK + 1, base + BLOCK + 2, base + BLOCK + 3]);

    // Disjoint, asserted directly rather than inferred from the two base
    // values above.
    const overlap = b.ports.filter((p) => a.ports.includes(p));
    expect(overlap).toEqual([]);

    // ---- (5) slot B is LIKEWISE bindable — every one of its ports, at -----
    // ---- once — while slot A's block is still held. ------------------------
    for (const port of b.ports) {
      expect(`0.0.0.0:${port} bound=${bindHeld('0.0.0.0', port) === null}`).toBe(`0.0.0.0:${port} bound=true`);
    }
    expect(held.length).toBe(2 * BLOCK); // both slots' blocks, all 8 ports, open at once

    // ---- (6) the OTHER decisive address: release the wildcard hold and ----
    // ---- rebind every port of BOTH blocks on loopback, simultaneously. ----
    // ---- Skipped entirely, this test would only ever have proven the ------
    // ---- wildcard case — exactly the assumption port-alloc.ts's header ----
    // ---- warns is not safe to make. ---------------------------------------
    while (held.length) {
      try {
        held.pop()!.stop(true);
      } catch {
        // best-effort
      }
    }
    const allPorts = [...a.ports, ...b.ports];
    for (const port of allPorts) {
      expect(`127.0.0.1:${port} bound=${bindHeld('127.0.0.1', port) === null}`).toBe(`127.0.0.1:${port} bound=true`);
    }
    expect(held.length).toBe(allPorts.length);
  },
  30000,
);
