// PORT ALLOCATION for a provisioned worktree slot (taskflow-v2 a4;
// 02-target-architecture.md §4.2 item 3, 04-subsystem-rules.md §3).
//
// A worktree isolates FILES. It does not isolate a TCP port. Two workers that
// each start a dev server on 3000 do not fail cleanly — one binds, the other
// gets EADDRINUSE (or, worse, talks to the first one's server and reports a
// green suite it never ran). Neither worker can diagnose that, because neither
// knows the other exists. Handing every slot its own block of free ports is
// therefore the single capability that makes file-level isolation SUFFICIENT
// for parallel execution.
//
// ── THE BLOCK IS DERIVED, THEN PROBED, THEN RESERVED ────────────────────────
//
//  1. DERIVED — the first candidate base is a hash of the SLOT NAME. Slot `a4`
//     re-provisioned tomorrow lands on the ports it had today instead of
//     drifting, so a worker's notes, a bookmarked URL and a `.env` a human
//     copied out all keep meaning something. Determinism is a FEATURE of the
//     first candidate only; a name whose ports are busy moves on.
//
//  2. PROBED — every port of a candidate block is bind-tested on the wildcard
//     AND on both loopback addresses, because "is this port free" answers
//     differently per address family and per platform: on Windows a bind to
//     `0.0.0.0:P` SUCCEEDS while another process holds `127.0.0.1:P` (verified,
//     not assumed), so a wildcard-only probe would hand out a port that is
//     already serving. Only EADDRINUSE/EACCES count as occupied; EADDRNOTAVAIL
//     from an address family this host does not have is inconclusive, never a
//     reason to skip a perfectly good block.
//
//  3. RESERVED — and this is the part the probe alone cannot do. A slot that
//     has been ALLOCATED ports but has not yet STARTED anything looks exactly
//     like a slot with free ports: nothing is bound. Two `worktree create`
//     processes racing (R6 — and the orchestrator's serialization is
//     explicitly not something this may depend on) would both probe the same
//     block, both find it free, and both write it. So the winning candidate is
//     claimed with an EXCLUSIVE-CREATE file per port (`wx`, atomic on every
//     platform this ships to) before it is returned. The loser's claim fails
//     and it advances to the next candidate.
//
//     Reservations are per PORT, not per block: `--ports 2` and `--ports 8`
//     produce differently-sized blocks that can PARTIALLY overlap, and a
//     block-keyed claim would not see it.
//
//     They are also SELF-HEALING and never authoritative on their own: a
//     reservation naming a slot whose worktree is gone from disk is stale and
//     gets taken over, and any filesystem failure in this layer degrades to
//     probe-only rather than failing a provision. A stale lock that outlives
//     its slot would otherwise slowly eat the range with nobody able to say
//     why.
//
// ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
//
// No port is ever INFERRED BY THE WORKER (04 §3). The worker is TOLD its ports
// through the env file; it does not scan, it does not retry on collision, and
// it does not get to pick. That is the whole point: a worker that searches for
// a free port re-introduces the race this module exists to remove.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The range and the block
// ---------------------------------------------------------------------------

/** Block size when `--ports` is not given. Four covers what a worker actually
 *  starts — an app, an API, a stub/database, one spare — while still leaving
 *  the default range room for thousands of slots. */
export const DEFAULT_PORT_COUNT = 4;

/** The default range, **20000-32767**.
 *
 *  Above the ports local toolchains squat on by convention (3000, 5173, 8080,
 *  9229…) and BELOW 32768, where Linux's default ephemeral range begins
 *  (`net.ipv4.ip_local_port_range` is 32768-60999); Windows' dynamic range
 *  (49152-65535) is further up still. Allocating out of an ephemeral range
 *  would hand a worker a port the kernel may itself assign to an outbound
 *  socket a second later — a collision with no owner to blame. */
export const PORT_RANGE_MIN = 20000;
export const PORT_RANGE_MAX = 32767;

/** Operator override, `min-max`. Exists because "which ports may I use" is a
 *  host policy question (a firewall rule, a corporate range, a container's
 *  published span) that this module cannot answer for anyone. */
export const PORT_RANGE_ENV = 'PIPELINE_WT_PORT_RANGE';

export interface PortRange {
  min: number;
  max: number;
}

/** `PIPELINE_WT_PORT_RANGE` when set and well-formed, else the default range;
 *  `{error}` when set and malformed — a mistyped range must be a stated
 *  refusal, never a silent fall back to ports the operator excluded. */
export function resolvePortRange(raw: string | undefined = process.env[PORT_RANGE_ENV]): PortRange | { error: string } {
  const text = (raw ?? '').trim();
  if (!text) return { min: PORT_RANGE_MIN, max: PORT_RANGE_MAX };
  const m = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(text);
  if (!m) {
    return { error: `${PORT_RANGE_ENV} must look like '${PORT_RANGE_MIN}-${PORT_RANGE_MAX}' (got '${text}')` };
  }
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (min < 1 || max > 65535 || min > max) {
    return { error: `${PORT_RANGE_ENV}='${text}' is not a usable port range (1-65535, and min must not exceed max)` };
  }
  return { min, max };
}

// ---------------------------------------------------------------------------
// The env-file keys (the CHANNEL — the JSON is informational, the file is not)
// ---------------------------------------------------------------------------

export const PORT_BASE_KEY = 'PORT_BASE';
export const PORT_COUNT_KEY = 'PORT_COUNT';

/** `PORT_1` … `PORT_N`, 1-based to match the `SUBMODULE_1_*` keys the same
 *  file already carries. */
export function portKey(index1: number): string {
  return `PORT_${index1}`;
}

/** The env-file entries for a block. Ordered, all values plain digits — they
 *  satisfy the provisioner's unquoted-value grammar by construction, which is
 *  asserted rather than assumed at the write site. */
export function portEnvEntries(base: number, count: number): Array<[string, string]> {
  const out: Array<[string, string]> = [
    [PORT_BASE_KEY, String(base)],
    [PORT_COUNT_KEY, String(count)],
  ];
  for (let i = 0; i < count; i++) out.push([portKey(i + 1), String(base + i)]);
  return out;
}

const NUMBERED_PORT_RE = /^PORT_\d+$/;

/** Read a parsed env file BACK as ports — the direction `--json` reports in.
 *
 *  Recognises this allocator's own keys (`PORT_BASE`, `PORT_1`…) and the
 *  `<ROLE>_PORT` spelling the frozen contract's own example uses
 *  (`{"ports": {"BACKEND_PORT": 5103}}`), so a consumer hook's file reports as
 *  faithfully as ours does. `PORT_COUNT` is a count, not a port, and is
 *  excluded; so is any value that is not a legal port number. */
export function readPortsFromEnv(values: Record<string, string>): {
  port_base: number | null;
  ports: Record<string, number>;
} {
  const ports: Record<string, number> = {};
  let port_base: number | null = null;
  for (const [k, raw] of Object.entries(values)) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) continue;
    if (k === PORT_COUNT_KEY) continue;
    if (k === PORT_BASE_KEY) {
      port_base = n;
      continue;
    }
    if (NUMBERED_PORT_RE.test(k) || k.endsWith('_PORT')) ports[k] = n;
  }
  return { port_base, ports };
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

interface BunSocketServer {
  stop(closeActiveConnections?: boolean): void;
}
interface BunListenLike {
  listen(opts: { hostname: string; port: number; socket: Record<string, unknown> }): BunSocketServer;
}

/** Wildcard first (catches a dual-stack server in one call on Linux), then
 *  both loopbacks — a Windows bind to `0.0.0.0:P` succeeds while another
 *  process holds `127.0.0.1:P`, so the wildcard alone is not an answer there. */
const PROBE_HOSTS = ['0.0.0.0', '127.0.0.1', '::1'] as const;

function bunApi(): BunListenLike | undefined {
  return (globalThis as { Bun?: BunListenLike }).Bun;
}

/** null when this runtime can bind-probe synchronously, else why it cannot.
 *
 *  The probe has to be SYNCHRONOUS — `provisionSlot` and the whole `worktree`
 *  command are — and `node:net` offers no synchronous bind. Bun does, and Bun
 *  is what runs this CLI (`package.json` `engines.bun`, `bin` → `src/cli.ts`).
 *  The `--target=node` bundle is the one runtime that reaches this without it,
 *  and it gets a STATED refusal rather than an unprobed block: handing out
 *  ports nobody checked is precisely the failure this module exists to
 *  prevent. */
export function probeUnavailable(): string | null {
  return bunApi()
    ? null
    : 'cannot allocate ports: this runtime provides no synchronous bind probe (the pipeline CLI runs on Bun — see package.json `engines.bun`). ' +
        'Re-run under Bun, or pass --ports 0 to provision a slot without ports.';
}

/** True when `port` can be bound on every address family this host has.
 *
 *  Occupied is EADDRINUSE or a permission refusal (EACCES/EPERM — a port we
 *  are not allowed to bind is not a port we can hand a worker). Anything else
 *  — EADDRNOTAVAIL from a missing IPv6 stack, for instance — is inconclusive
 *  and does NOT condemn the block. */
export function isPortFree(port: number): boolean {
  const bun = bunApi();
  if (!bun) return false; // unreachable through allocatePorts (probeUnavailable gates it)
  for (const hostname of PROBE_HOSTS) {
    let server: BunSocketServer;
    try {
      server = bun.listen({ hostname, port, socket: { data() {} } });
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (code === 'EADDRINUSE' || code === 'EACCES' || code === 'EPERM') return false;
      continue;
    }
    try {
      server.stop(true);
    } catch {
      // best-effort: the probe socket is closing either way
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reservations — one exclusive-create file per port
// ---------------------------------------------------------------------------

/** Where port reservations live, given the slot-root BASE (not one project's
 *  slot root).
 *
 *  Machine-wide on purpose. The deterministic base is derived from the slot
 *  NAME alone, and slot names are task ids — two different projects both
 *  provisioning `a4` ask for the same first candidate block, and a per-project
 *  registry would not notice. */
export function reservationDirFor(slotRootBase: string): string {
  return `${slotRootBase}/.ports`;
}

interface Reservation {
  /** The slot that holds this port. Its OWN reservations are never obstacles. */
  name: string;
  base: number;
  count: number;
  /** The on-disk proof the slot still exists. Gone → the reservation is stale
   *  and may be taken over; that is what stops a crashed run from eating the
   *  range forever. */
  path: string;
  at: string;
}

const RESERVATION_RE = /^(\d+)\.json$/;

function reservationFile(dir: string, port: number): string {
  return `${dir}/${port}.json`;
}

function readReservation(file: string): Reservation | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Reservation>;
    if (typeof raw.name !== 'string' || typeof raw.path !== 'string') return null;
    return { name: raw.name, path: raw.path, base: Number(raw.base) || 0, count: Number(raw.count) || 0, at: String(raw.at ?? '') };
  } catch {
    return null;
  }
}

/** The reservation directory, created; null when it cannot be — the caller
 *  then allocates on the probe alone rather than failing a provision over
 *  bookkeeping. */
function ensureReservationDir(dir: string | null): string | null {
  if (dir === null) return null;
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

/** Drop every reservation held by `name`. Called before a re-allocation so a
 *  slot never holds two blocks (the deterministic base can move when the ports
 *  it wanted became busy, and the abandoned claim must not survive). */
export function releaseReservations(dir: string, name: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!RESERVATION_RE.test(entry)) continue;
    const file = `${dir}/${entry}`;
    const rec = readReservation(file);
    if (rec === null || rec.name !== name) continue;
    try {
      unlinkSync(file);
    } catch {
      // best-effort
    }
  }
}

type ClaimResult = 'claimed' | 'taken';

function claimPort(dir: string, port: number, rec: Reservation): ClaimResult {
  const file = reservationFile(dir, port);
  const body = JSON.stringify(rec) + '\n';
  try {
    // `wx` — the atomic step, and the ONLY thing that makes two concurrent
    // allocations of the same candidate block mutually exclusive.
    writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' });
    return 'claimed';
  } catch {
    const other = readReservation(file);
    if (other === null) return 'taken'; // unreadable: assume someone owns it
    if (other.name === rec.name) return 'claimed'; // our own, re-taken
    if (other.path && existsSync(other.path)) return 'taken'; // a live slot holds it
    // Stale: the slot it names is gone from disk. Take it over — and if
    // another process wins that race, the `wx` below fails and we move on.
    try {
      unlinkSync(file);
      writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' });
      return 'claimed';
    } catch {
      return 'taken';
    }
  }
}

/** Claim every port of a block, or none of it. */
function claimBlock(dir: string, base: number, count: number, rec: Reservation): boolean {
  const mine: number[] = [];
  for (let p = base; p < base + count; p++) {
    if (claimPort(dir, p, rec) === 'claimed') {
      mine.push(p);
      continue;
    }
    for (const held of mine) {
      try {
        unlinkSync(reservationFile(dir, held));
      } catch {
        // best-effort
      }
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/** How many starting ports a block of `count` can occupy inside `range`. */
function spanOf(range: PortRange, count: number): number {
  return range.max - range.min + 1 - (count - 1);
}

/** The FIRST candidate base for `name` — a hash of the slot name alone (04 §3:
 *  "a deterministic base derived from the slot name"), never of the project or
 *  the clock, so the same name is stable across re-provisions and across
 *  processes that cannot see each other. */
export function deterministicBase(name: string, count: number, range: PortRange = { min: PORT_RANGE_MIN, max: PORT_RANGE_MAX }): number {
  const span = spanOf(range, count);
  if (span <= 0) return range.min;
  const digest = createHash('sha256').update(name, 'utf8').digest();
  return range.min + (digest.readUInt32BE(0) % span);
}

/** Candidate bases in probe order: the deterministic one, then every other
 *  block-sized step, wrapping through the range exactly once. */
function* candidateBases(first: number, count: number, range: PortRange): Generator<number> {
  const span = spanOf(range, count);
  const tries = Math.max(1, Math.ceil(span / count));
  for (let k = 0; k < tries; k++) {
    yield range.min + (((first - range.min + k * count) % span) + span) % span;
  }
}

export interface AllocateRequest {
  /** The slot name — the ONLY input to the deterministic base. */
  name: string;
  /** Block size. Callers skip allocation entirely at 0. */
  count: number;
  /** Where reservations live; null disables the reservation layer. */
  reservationDir: string | null;
  /** The path whose existence proves this slot is live (its worktree). */
  livePath: string;
  range: PortRange;
  /** Test seam. Injecting it also bypasses the runtime probe check. */
  isFree?: (port: number) => boolean;
}

export type PortAllocation = { ok: true; base: number; ports: number[] } | { ok: false; detail: string };

/** Allocate a contiguous block of `count` free ports for `name`.
 *
 *  Failure is a STATED refusal naming the range that was tried — never a
 *  crash, and never a slot that quietly ends up with no ports at all. */
export function allocatePorts(req: AllocateRequest): PortAllocation {
  const { name, count, range } = req;
  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, detail: `port count must be a positive integer (got ${count})` };
  }
  const span = spanOf(range, count);
  if (span <= 0) {
    return {
      ok: false,
      detail: `cannot allocate ${count} contiguous ports: the range ${range.min}-${range.max} holds only ${range.max - range.min + 1}`,
    };
  }
  if (!req.isFree) {
    const why = probeUnavailable();
    if (why) return { ok: false, detail: why };
  }
  const isFree = req.isFree ?? isPortFree;

  const dir = ensureReservationDir(req.reservationDir);
  if (dir !== null) releaseReservations(dir, name);

  const first = deterministicBase(name, count, range);
  const rec: Reservation = { name, base: 0, count, path: req.livePath, at: new Date().toISOString() };
  let tried = 0;
  for (const base of candidateBases(first, count, range)) {
    tried++;
    let free = true;
    for (let p = base; p < base + count; p++) {
      if (!isFree(p)) {
        free = false;
        break;
      }
    }
    if (!free) continue;
    if (dir !== null && !claimBlock(dir, base, count, { ...rec, base })) continue;
    const ports: number[] = [];
    for (let i = 0; i < count; i++) ports.push(base + i);
    return { ok: true, base, ports };
  }
  return {
    ok: false,
    detail:
      `no free block of ${count} contiguous ports in ${range.min}-${range.max} for slot '${name}': ` +
      `tried ${tried} candidate block${tried === 1 ? '' : 's'} from ${first}, and every one had a port already in use or reserved by another live slot. ` +
      `Free some ports, or widen ${PORT_RANGE_ENV} (default ${PORT_RANGE_MIN}-${PORT_RANGE_MAX}).`,
  };
}
