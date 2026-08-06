// `pipeline telemetry-daemon --project-root <path>` — the detached uploader
// daemon (ux-v2 `b11`).
//
// WHAT THIS IS. `b9` (`telemetry-outbox.ts`) queues; `b10`
// (`telemetry-upload.ts`) flushes ONE batch and returns — its own header says
// outright: *"the only intended caller of `flushOnce()` is the DETACHED
// uploader daemon (`b11`)."* This file is that caller: a small poll loop that
// calls `flushOnce()` on an interval, for exactly ONE project, until there is
// nothing left to do (idle) or it has run long enough (wall-clock), then
// exits. Nothing here does its own retry/backoff arithmetic — that is `b10`'s
// job, driven by `upload.json`; this loop only decides WHEN to ask again and
// WHEN to stop asking.
//
// ── ONE DAEMON PER PROJECT, STARTED CHEAPLY, EXITING ON ITS OWN ────────────
//
// "Started cheaply" is the OTHER half of this task and it does NOT live here
// — it lives in `hooks/analytics_relay.ts`'s `ensureTelemetryDaemonRunning`,
// which is called once per pipeline-manager spawn (a run's start). That is a
// deliberate split, not an oversight:
//
//   - The hook fires on a HOT path (every Agent/Task spawn Claude Code makes)
//     and must add no measurable latency. THIS module pulls in the full
//     outbox/upload/`vendor/privacy.ts` chain at top level — fine for a
//     process whose entire job is to poll and flush, but real (if small)
//     parse-and-eval cost a hot hook should not pay just to decide "is a
//     daemon already running". So the hook does NOT import this file at all.
//     It duplicates the ONE-LINE lock path formula (`telemetryDaemonLockPath`
//     below) and implements its own copy of the acquire/reclaim/spawn
//     sequence, exactly the way `hooks/analytics_relay.ts`'s own header
//     already duplicates `submoduleWorktreeOf` from `lib/event.ts`
//     rather than importing it — "hooks cannot import a sibling at runtime"
//     is that file's own stated reason; the reason here is the same shape
//     (keep a hot path's import graph light), applied to a heavier
//     dependency (this whole module, not a single function).
//   - `tests/telemetry-daemon-lock-parity.test.ts` pins the ONE constant that
//     must not drift between the two copies — `LOCK_STALE_AGE_MS` — by
//     importing both this module and the hook and asserting equality, so a
//     future edit to either side that forgets the other fails a test instead
//     of silently reclaiming a live daemon's lock (or never reclaiming a
//     dead one).
//
// So THIS file owns: what the daemon does once it exists (poll, flush, decide
// idle/wall-clock exit, release its own lock on a clean exit) and the CLI
// surface (`pipeline telemetry-daemon`) the hook spawns. It does not own
// acquiring the lock that guards against spawning two of itself — that
// guard runs BEFORE this process exists, in the hook, on the caller's side of
// the `spawn()` call, which is the only place a check-then-act race can
// actually be made atomic (see that file's own header for the full
// `wx`/stale-reclaim scheme).
//
// ── THE TWO BOUNDS (matrix 22) ──────────────────────────────────────────────
//
// `department-notify.ts`'s `pollLoop` is `for (;;)` with no real exit — the
// only stop condition (`maxIterations`) is documented "Test-only". Copying
// that shape here would mean a telemetry daemon runs forever once spawned,
// one per project, accumulating without bound. Two independent caps instead:
//
//   IDLE EXIT — once a poll cycle finds nothing to do (`'idle'`: the queue is
//   empty, or every record was filtered out) for `idleExitMs` of WALL CLOCK
//   (not iteration count — the poll interval is a tuning knob, the idle
//   BUDGET should not silently change if that knob does), the daemon exits.
//   Anything else — `'sent'`, `'retry'`, `'quarantined'`, `'deadline'`,
//   `'error'`, or `'backoff'` (a schedule exists, meaning there IS a queue
//   waiting for its retry window) — resets the idle clock: there is a real
//   job here, so stay alive for it.
//
//   MAX WALL CLOCK — a hard cap from the daemon's own start, independent of
//   activity. A project that never stops producing telemetry (a very long
//   pipeline run, or several back-to-back ones) must not pin one uploader
//   process alive indefinitely; it exits at the cap regardless, and the next
//   `pipeline-manager` spawn's hook check spawns a fresh one. Checked BEFORE
//   the idle bound on every cycle, so an ever-busy daemon still retires.
//
//   `'disabled'` (`PIPELINE_SYNC_LOCAL_STATS` turned off, checked fresh every
//   cycle — this can change mid-life) exits immediately, bypassing both
//   bounds: there is structurally nothing this daemon could ever do.
//
// `runTelemetryDaemonLoop` takes an injected `now`/`sleep` so both bounds are
// provable without waiting on a real 30-minute clock — see
// `tests/telemetry-daemon.test.ts`, which ALSO includes one small REAL-TIME
// run (genuine `setTimeout` sleep, genuine `Date.now()`, bounds measured in
// tens of milliseconds) precisely because an injected clock proves the
// LOGIC, not that the actual `for (;;)` below truly returns control to the
// process. Both are documented there as what they are.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { telemetryDir, telemetrySyncEnabled, TelemetryOutbox } from '../lib/telemetry-outbox';
import { resolveOutboxFingerprintSalt } from '../lib/fingerprint-salt';
import { cloudJsonPath, realFs, type CloudFs } from '../lib/cloud-config';
import { resolveUploadTarget, TelemetryUploader, type UploadFetch, type UploadTarget } from '../lib/telemetry-upload';
import type { FetchLike } from '../lib/credential-refresh';
import { recordLastFlush } from '../lib/telemetry-status';

// ---------------------------------------------------------------------------
// The lock path — the ONE thing the hook must agree with this module about.
// ---------------------------------------------------------------------------

/** `<project>/.pipeline/.runtime/telemetry/daemon.lock`.
 *
 *  DUPLICATED (not imported) in `hooks/analytics_relay.ts` — see this file's
 *  header. Both copies resolve to the same path because both build it from
 *  the same three literal segments; `tests/telemetry-daemon-lock-parity.test.ts`
 *  asserts the two functions agree on a sample path so that guarantee is
 *  checked, not just asserted in prose. */
export function telemetryDaemonLockPath(projectRoot: string): string {
  return join(telemetryDir(projectRoot), 'daemon.lock');
}

/** Best-effort release on a CLEAN exit (idle or wall-clock) — lets the very
 *  next `pipeline-manager` spawn's hook check spawn a fresh daemon
 *  immediately, rather than waiting out `LOCK_STALE_AGE_MS` for a pid-liveness
 *  reclaim it doesn't need. Never throws: if this fails (permissions, the
 *  file already gone), the NEXT hook invocation reclaims the lock anyway —
 *  the pid it names is (by then, or very soon) genuinely dead, so the
 *  primary stale-lock signal still fires. One extra `existsSync` is the only
 *  cost of skipping this step, never a wedge. */
export function releaseDaemonLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* best effort — see doc comment */
  }
}

// ---------------------------------------------------------------------------
// Ensure-running (ux-v2 `b12`) — the headless-drive counterpart of
// `hooks/analytics_relay.ts`'s own `ensureTelemetryDaemonRunning`.
//
// WHY THIS EXISTS HERE TOO, AND WHY IT IS A SEPARATE COPY: `pipeline drive`
// is a headless, hookless process. None of the PreToolUse/Agent-spawn
// machinery that spawns the daemon for a Claude-Code-driven run
// (`pipeline-manager`) ever fires for it, because `drive` never spawns a
// `pipeline-manager` subagent itself — it IS the orchestrator, spawning
// `step-executor` sessions directly. Something has to take over "make sure
// an uploader exists for this project" for a driven run, and THIS module —
// which already owns `telemetryDaemonLockPath`/`releaseDaemonLock`, and
// which `commands/drive.ts` already imports for those — is the natural home:
// unlike the hook, `drive.ts` is not a hot per-tool-call path (this function
// runs at most twice per run: start and exit), so paying this module's own
// outbox/upload/vendor-privacy import cost is not a concern here — drive.ts
// pays it anyway, for its own in-process journal tail (`lib/telemetry-tail.ts`).
//
// The acquire/reclaim/spawn SHAPE below is the SAME argument as the hook's
// own copy (see that file's header): atomic `wx` create is the only
// race-free primitive for "did I win the right to spawn", and a lock is
// reclaimed on a dead pid (immediate) or once it outlives `LOCK_STALE_AGE_MS`
// (the pid-reuse defense). `tests/telemetry-daemon-ensure.test.ts` exercises
// the race + reclaim directly against this copy; the hook's own copy is
// proven by `apps/pipeline-cli/tests/hook-telemetry-daemon-lock*.test.ts`, and
// the ONE constant both copies must agree on is pinned by
// `tests/telemetry-daemon-lock-parity.test.ts` above.
// ---------------------------------------------------------------------------

interface DaemonLockRecord {
  pid: number;
  started_at: string;
}

/** Same EPERM-is-alive fix as `lib/credential-lock.ts`'s own `isProcessAlive`
 *  (a5) and the hook's copy: EPERM means the process exists but this one
 *  lacks permission to signal it — still alive. */
function isDaemonProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readDaemonLockRecord(lockPath: string): DaemonLockRecord | null {
  if (!existsSync(lockPath)) return null;
  try {
    const txt = readFileSync(lockPath, 'utf-8').trim();
    if (!txt) return null;
    const parsed = JSON.parse(txt) as Partial<DaemonLockRecord>;
    if (typeof parsed.pid !== 'number') return null;
    return { pid: parsed.pid, started_at: String(parsed.started_at ?? '') };
  } catch {
    return null;
  }
}

function daemonLockAgeMs(rec: DaemonLockRecord, now: number): number {
  const t = Date.parse(rec.started_at);
  return Number.isFinite(t) ? Math.max(0, now - t) : Number.POSITIVE_INFINITY;
}

/** A lock is stale when its pid is dead (immediate signal) OR it has
 *  outlived any correct daemon's own wall-clock cap plus grace — see
 *  `LOCK_STALE_AGE_MS`'s own doc comment. */
function isDaemonLockStale(rec: DaemonLockRecord, now: number): boolean {
  if (!isDaemonProcessAlive(rec.pid)) return true;
  return daemonLockAgeMs(rec, now) >= LOCK_STALE_AGE_MS;
}

/** The ONE atomic operation this scheme rests on: create `lockPath` with
 *  `wx`, or fail if anything is there right now. Any failure (EEXIST,
 *  permissions, a vanished parent dir) returns `false` — never spawn on an
 *  uncertain lock state. */
function tryCreateDaemonLock(lockPath: string, pid: number, now: number): boolean {
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid, started_at: new Date(now).toISOString() } satisfies DaemonLockRecord) + '\n',
      { flag: 'wx' },
    );
    return true;
  } catch {
    return false;
  }
}

export type DaemonAcquireResult =
  | { action: 'already-running'; pid: number }
  | { action: 'acquired' }
  | { action: 'skip' };

/** Same order as the hook's `acquireTelemetryDaemonLock` (and
 *  `lib/credential-lock.ts`'s `acquireLock`): try-create FIRST, on every
 *  call, with no preceding read; the reclaim path only ever consults a FRESH
 *  read taken immediately before its own unlink+retry. Exported for
 *  `tests/telemetry-daemon-ensure.test.ts` — the race and the stale-lock
 *  reclaim are proven directly against a real filesystem, mirroring
 *  `apps/pipeline-cli/tests/hook-telemetry-daemon-lock.test.ts`'s coverage of
 *  the hook's own copy. */
export function acquireDaemonLock(lockPath: string, now: number, selfPid: number): DaemonAcquireResult {
  const snapshot = readDaemonLockRecord(lockPath);
  if (snapshot !== null && !isDaemonLockStale(snapshot, now)) {
    return { action: 'already-running', pid: snapshot.pid };
  }

  if (tryCreateDaemonLock(lockPath, selfPid, now)) return { action: 'acquired' };

  const current = readDaemonLockRecord(lockPath);
  if (current !== null && !isDaemonLockStale(current, now)) {
    return { action: 'already-running', pid: current.pid };
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone, or a concurrent reclaimer beat us to it */
  }
  if (tryCreateDaemonLock(lockPath, selfPid, now)) return { action: 'acquired' };
  return { action: 'skip' };
}

export interface DaemonStatus {
  /** The lock names a live, non-stale pid — see `isDaemonLockStale`'s own
   *  criteria (dead pid, or older than `LOCK_STALE_AGE_MS`). */
  active: boolean;
  pid: number | null;
}

/**
 * READ-ONLY daemon-liveness check for `pipeline stats telemetry` (`b13`, `08`
 * J6's "streaming state"). Deliberately NOT `acquireDaemonLock` — that
 * function's whole contract is "create the lock if none exists", which would
 * make a stats-reporting command falsely claim ownership of a daemon slot it
 * never spawned. This reuses the SAME staleness criteria
 * (`isDaemonLockStale`) without ever writing to `lockPath`.
 */
export function daemonStatus(lockPath: string, now: number = Date.now()): DaemonStatus {
  const rec = readDaemonLockRecord(lockPath);
  if (rec === null || isDaemonLockStale(rec, now)) return { active: false, pid: null };
  return { active: true, pid: rec.pid };
}

function finalizeDaemonLock(lockPath: string, pid: number, now: number): void {
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid, started_at: new Date(now).toISOString() } satisfies DaemonLockRecord) + '\n',
    );
  } catch {
    /* best effort — see releaseDaemonLock's own reasoning for the self-heal path */
  }
}

/** `apps/pipeline-cli/src/cli.ts` — resolved relative to THIS module, not
 *  CLAUDE_PLUGIN_ROOT: unlike the hook (which lives at the repo root and must
 *  cross a package boundary to find it), this module already lives inside
 *  `apps/pipeline-cli/src/commands/`, one directory below `cli.ts`, so the
 *  relative path is fixed regardless of install location (plugin checkout or
 *  a standalone npm install). */
const DAEMON_CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts');

/** Spawn `pipeline telemetry-daemon` detached — the SAME shape as the hook's
 *  `spawnTelemetryDaemon` (`detached: true`, `stdio: 'ignore'`,
 *  `windowsHide: true`, `child.unref()`), using `process.execPath` rather
 *  than a bare `bun`/`pipeline` on PATH for the same Windows-shim reason that
 *  file documents. Only called after `acquireDaemonLock` has already
 *  returned `'acquired'`. */
function spawnDaemonProcess(lockPath: string, projectRoot: string, reservedAt: number): void {
  if (!existsSync(DAEMON_CLI_ENTRY)) return;
  try {
    const child = spawn(
      process.execPath,
      [DAEMON_CLI_ENTRY, 'telemetry-daemon', '--project-root', projectRoot],
      { detached: true, stdio: 'ignore', env: { ...process.env }, windowsHide: true },
    );
    child.unref();
    if (typeof child.pid === 'number') {
      finalizeDaemonLock(lockPath, child.pid, reservedAt);
    }
    // No pid to finalize with: the lock stays reserved under THIS process's
    // own pid, which self-heals — this process exits within milliseconds of
    // returning, at which point isDaemonProcessAlive(lock.pid) answers false
    // and the very next ensure-running call reclaims the lock and retries.
  } catch {
    /* best effort */
  }
}

/**
 * Ensure this project's telemetry daemon is running, spawning at most ONE if
 * the lock is absent, stale, or points at a dead pid (ux-v2 `b12`). See this
 * block's header for why `drive.ts` calls this copy rather than the hook's.
 *
 * Gated exactly like the hook's own copy (`03` F7 / matrix 4): telemetry
 * sync must be enabled, AND the project must have a `.pipeline/cloud.json`
 * binding — a project that never ran `pipeline cloud connect` gets no
 * daemon, because `resolveUploadTarget` would reach the same "nothing to
 * upload to" conclusion over the network path this function must never take.
 *
 * Best-effort and NEVER throws (D2): no network work happens here, only
 * local fs checks and, at most once, a detached spawn — matching `08` J2's
 * "no network work in the hook" rule extended to drive's own equivalent.
 */
export function ensureTelemetryDaemonRunning(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
): void {
  try {
    if (!telemetrySyncEnabled(env)) return;
    if (!existsSync(cloudJsonPath(projectRoot))) return;

    const lockPath = telemetryDaemonLockPath(projectRoot);
    mkdirSync(dirname(lockPath), { recursive: true });
    const now = Date.now();
    const result = acquireDaemonLock(lockPath, now, process.pid);
    if (result.action !== 'acquired') return;
    spawnDaemonProcess(lockPath, projectRoot, now);
  } catch {
    /* best-effort — never affect the run */
  }
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** How often the daemon asks `flushOnce()` whether there is anything to do. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Wall-clock with nothing to do before the daemon retires itself. Short on
 *  purpose — telemetry is a background chore, not a service; the next run
 *  start respawns one cheaply if there is more to upload later. */
export const DEFAULT_IDLE_EXIT_MS = 2 * 60_000; // 2 minutes

/** Hard cap on one daemon's life, activity or not. */
export const DEFAULT_MAX_WALL_CLOCK_MS = 30 * 60_000; // 30 minutes

/** The hook's stale-lock reclaim bound — comfortably ABOVE
 *  `DEFAULT_MAX_WALL_CLOCK_MS` (5 extra minutes of grace for shutdown +
 *  `releaseDaemonLock` to run) so a live, spec-compliant daemon's lock is
 *  NEVER reclaimed out from under it purely by age; age-based reclaim exists
 *  only for the pid-reuse case pid-liveness alone cannot catch. See
 *  `hooks/analytics_relay.ts`'s duplicate of this same value and
 *  `tests/telemetry-daemon-lock-parity.test.ts`, which pins the two equal. */
export const LOCK_STALE_AGE_MS = DEFAULT_MAX_WALL_CLOCK_MS + 5 * 60_000; // 35 minutes

// ---------------------------------------------------------------------------
// The loop — pure control flow, no fs/network of its own.
// ---------------------------------------------------------------------------

export type TelemetryDaemonPollOutcome = 'active' | 'idle' | 'disabled';

export type TelemetryDaemonExitReason = 'idle' | 'wall-clock' | 'disabled' | 'max-iterations';

export interface TelemetryDaemonLoopOptions {
  pollIntervalMs: number;
  idleExitMs: number;
  maxWallClockMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** One poll cycle, reduced to the three-way signal the loop reacts to.
   *  Injected so the loop itself never touches fs/network — see
   *  `pollProjectOnce` below for the real implementation. */
  poll: () => Promise<TelemetryDaemonPollOutcome>;
  onExit?: (reason: TelemetryDaemonExitReason, iterations: number) => void;
  /** Test-only escape hatch, mirroring `department-notify.ts`'s `pollLoop` —
   *  but UNLIKE that one, this is not the only way out: idle and wall-clock
   *  are real, non-test exit paths. This just lets a test bound how many
   *  cycles it waits through before asserting mid-loop state. Production
   *  never sets it. */
  maxIterations?: number;
}

/**
 * The daemon's main body. Returns the reason it stopped rather than exiting
 * the process directly, so the CLI wrapper (and tests) can observe it.
 */
export async function runTelemetryDaemonLoop(opts: TelemetryDaemonLoopOptions): Promise<TelemetryDaemonExitReason> {
  const startedAt = opts.now();
  let idleSince = startedAt;
  let iteration = 0;
  for (;;) {
    iteration++;
    const outcome = await opts.poll();
    const now = opts.now();

    if (outcome === 'disabled') {
      opts.onExit?.('disabled', iteration);
      return 'disabled';
    }
    if (outcome !== 'idle') {
      idleSince = now;
    }

    // Wall-clock is checked before idle: a daemon that is always "active" (a
    // permanently backed-off or ever-busy queue) must still retire at the cap.
    if (now - startedAt >= opts.maxWallClockMs) {
      opts.onExit?.('wall-clock', iteration);
      return 'wall-clock';
    }
    if (now - idleSince >= opts.idleExitMs) {
      opts.onExit?.('idle', iteration);
      return 'idle';
    }
    if (opts.maxIterations !== undefined && iteration >= opts.maxIterations) {
      opts.onExit?.('max-iterations', iteration);
      return 'max-iterations';
    }
    await opts.sleep(opts.pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// One real poll cycle — the only place this module touches fs/network.
// ---------------------------------------------------------------------------

export interface TelemetryDaemonPollDeps {
  fs: CloudFs;
  env: Record<string, string | undefined>;
  platform: string;
  homedir: string;
  now: () => number;
  /** The ingest POST transport (`lib/telemetry-upload.ts`'s `UploadFetch`).
   *  Defaults to the real one; tests inject a capturing/scripted fake so
   *  `pollProjectOnce` never makes a real network call. */
  fetch?: UploadFetch;
  /** The credential-refresh transport (`credential-refresh.ts`'s
   *  `FetchLike`) `resolveUploadTarget` uses ONLY when a stored credential is
   *  actually expiring. Left undefined by default (its own bounded default
   *  applies); tests that seed a non-expiring credential never need it. */
  refreshFetch?: FetchLike;
}

/**
 * Resolve where to send, and try to send. Mapped down to the three-way
 * `TelemetryDaemonPollOutcome` the loop above reacts to:
 *
 *   'disabled' — `PIPELINE_SYNC_LOCAL_STATS` is off. Checked FRESH every
 *                cycle (not cached at daemon start) — it is cheap and an
 *                immediate exit is strictly better than riding out the idle
 *                bound for a switch that was already flipped.
 *   'idle'     — telemetry is on, but there is either no cloud target to
 *                send to yet (F7: no account ⇒ nothing to do, not an error)
 *                or `flushOnce()` itself found nothing sendable.
 *   'active'   — `flushOnce()` did something, or backed off something —
 *                `'sent' | 'retry' | 'quarantined' | 'deadline' | 'error' |
 *                'backoff'` all count: each means a queue exists and this
 *                daemon is the thing moving it (or waiting out its own
 *                backoff on purpose), so the idle clock must not run out
 *                from under it.
 *
 * A fresh `TelemetryOutbox` + `TelemetryUploader` is built EVERY cycle,
 * deliberately not cached across polls: `resolveUploadTarget` re-resolves the
 * credential (refreshing it if it is expiring) and the org it names, so a
 * reconnect to a different org mid-daemon-life is picked up on the very next
 * cycle rather than sending under a stale target until the daemon happens to
 * restart. The cost is two small JSON reads per cycle — negligible next to an
 * HTTP round trip.
 *
 * DRAINS THE JOURNAL FIRST (ux-v2 `b17`). `b12` wired `drainJournal()` into
 * `drive` and into `next.ts`'s step-boundary flush, but a manager-driven run
 * (`/pipeline:run`, no `drive` process at all) never goes through either of
 * those — this poll cycle was its ONLY path back to the outbox, and it never
 * took it. Without this call a manager-driven run queues nothing: the
 * uploader has an empty outbox to flush and reports `'idle'` forever, even
 * while the project journal fills up with un-drained events. Same instance,
 * same project, called BEFORE `flushOnce()` so anything newly drained this
 * cycle is eligible to send in the same cycle rather than waiting one more
 * `pollIntervalMs`.
 *
 * CONCURRENCY (see `telemetry-outbox-interleaving.test.ts`, `b12`):
 * `drainJournal()` takes `drain.lock` with a ZERO-wait attempt — it never
 * blocks. If a concurrently-running `drive` (or another daemon poll, though
 * there is only ever one live daemon per project by `daemon.lock`) holds the
 * lock at this instant, this call returns `skipped_locked: true` immediately
 * and touches nothing; the journal cursor is untouched, so the NEXT poll
 * cycle (`pollIntervalMs` later) drains the same bytes exactly once. So
 * neither of the two risks the task called out is live here: a deadlock
 * would require this call to block, and it structurally cannot; a
 * double-enqueue would require two callers to advance the SAME persisted
 * cursor/seq state without the lock, and the lock plus loading state fresh
 * from disk on every call rules that out. See `pollProjectOnce — journal
 * drain` below for the daemon-level proof (not just the lower-level
 * `TelemetryOutbox` one `telemetry-outbox-interleaving.test.ts` already
 * carried before this daemon caller existed).
 */
export async function pollProjectOnce(deps: TelemetryDaemonPollDeps, projectRoot: string): Promise<TelemetryDaemonPollOutcome> {
  if (!telemetrySyncEnabled(deps.env)) return 'disabled';

  const target: UploadTarget | null = await resolveUploadTarget({
    cwd: projectRoot,
    platform: deps.platform,
    env: deps.env,
    homedir: deps.homedir,
    fs: deps.fs,
    now: deps.now,
    fetch: deps.refreshFetch,
  });
  if (target === null) return 'idle';

  const outbox = new TelemetryOutbox({
    projectRoot,
    org: target.org,
    env: deps.env,
    now: deps.now,
    // b18: the per-install salt (b15) — see fingerprint-salt.ts. This is the
    // outbox whose `drainJournal()` filters every manager-driven run's event
    // (b17), and whose `fingerprintSalt` `flushOnce()` reuses at wire time —
    // the two places T16/SG13's actual uploaded fingerprints come from.
    fingerprintSalt: resolveOutboxFingerprintSalt({
      fs: deps.fs,
      platform: deps.platform,
      env: deps.env,
      homedir: deps.homedir,
    }),
  });
  outbox.drainJournal();
  const uploader = new TelemetryUploader({
    outbox,
    target,
    env: deps.env,
    now: deps.now,
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
  });
  const result = await uploader.flushOnce();
  // `b13`: persist the ONLY evidence `pipeline stats telemetry`'s "Last
  // error" line has to read — see `lib/telemetry-status.ts`'s header, point
  // 3. Gated to real-problem outcomes only: 'sent'/'idle'/'disabled' carry
  // nothing worth overwriting a genuine prior error with, and 'backoff'
  // means no NEW request was even attempted this cycle (nothing new to
  // record — the prior entry already describes the ongoing issue).
  if (
    result.outcome === 'retry' ||
    result.outcome === 'quarantined' ||
    result.outcome === 'deadline' ||
    result.outcome === 'error'
  ) {
    recordLastFlush(projectRoot, result, deps.now());
  }
  return result.outcome === 'idle' ? 'idle' : 'active';
}

// ---------------------------------------------------------------------------
// CLI wrapper — `pipeline telemetry-daemon`
// ---------------------------------------------------------------------------

export interface TelemetryDaemonCliDeps {
  fs: CloudFs;
  env: Record<string, string | undefined>;
  platform: string;
  homedir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  out: (s: string) => void;
  err: (s: string) => void;
  /** Test seam — see `TelemetryDaemonPollDeps`. Undefined in production. */
  fetch?: UploadFetch;
  /** Test seam — see `TelemetryDaemonPollDeps`. Undefined in production. */
  refreshFetch?: FetchLike;
}

export const realTelemetryDaemonCliDeps: TelemetryDaemonCliDeps = {
  fs: realFs,
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  out: (s) => {
    process.stdout.write(s);
  },
  err: (s) => {
    process.stderr.write(s);
  },
};

const USAGE =
  'Usage: pipeline telemetry-daemon --project-root <path> [--poll-interval-ms <n>]\n' +
  '           [--idle-exit-ms <n>] [--max-wall-clock-ms <n>] [--once]\n' +
  '  The detached telemetry uploader for ONE project (ux-v2 b11). Not meant to\n' +
  '  be run by hand — spawned detached by hooks/analytics_relay.ts, which holds\n' +
  '  the `wx` single-instance lock BEFORE spawning. Polls `flushOnce()`\n' +
  '  (lib/telemetry-upload.ts) on an interval and exits on its own once the\n' +
  '  queue has been idle for --idle-exit-ms or --max-wall-clock-ms has elapsed,\n' +
  '  whichever comes first. --once runs a single poll cycle and exits — useful\n' +
  '  for smoke-testing a project without waiting on either bound.\n';

export interface TelemetryDaemonOptions {
  projectRoot: string;
  pollIntervalMs: number;
  idleExitMs: number;
  maxWallClockMs: number;
  once: boolean;
}

export function parseTelemetryDaemonArgs(
  args: string[],
  cwd: string = process.cwd(),
): TelemetryDaemonOptions | { error: string } {
  const out: TelemetryDaemonOptions = {
    projectRoot: '',
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    idleExitMs: DEFAULT_IDLE_EXIT_MS,
    maxWallClockMs: DEFAULT_MAX_WALL_CLOCK_MS,
    once: false,
  };
  let sawProjectRoot = false;
  const positiveNumber = (flag: string, raw: string | undefined): number | { error: string } => {
    if (raw === undefined) return { error: `${flag} requires a value` };
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return { error: `${flag} must be a positive number` };
    return n;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const eq = (prefix: string): string | undefined => (a.startsWith(`${prefix}=`) ? a.slice(prefix.length + 1) : undefined);
    if (a === '--once') {
      out.once = true;
    } else if (a === '--project-root') {
      const v = args[++i];
      if (v === undefined) return { error: '--project-root requires a value' };
      out.projectRoot = resolve(cwd, v);
      sawProjectRoot = true;
    } else if (eq('--project-root') !== undefined) {
      out.projectRoot = resolve(cwd, eq('--project-root')!);
      sawProjectRoot = true;
    } else if (a === '--poll-interval-ms' || eq('--poll-interval-ms') !== undefined) {
      const raw = a === '--poll-interval-ms' ? args[++i] : eq('--poll-interval-ms');
      const n = positiveNumber('--poll-interval-ms', raw);
      if (typeof n !== 'number') return n;
      out.pollIntervalMs = n;
    } else if (a === '--idle-exit-ms' || eq('--idle-exit-ms') !== undefined) {
      const raw = a === '--idle-exit-ms' ? args[++i] : eq('--idle-exit-ms');
      const n = positiveNumber('--idle-exit-ms', raw);
      if (typeof n !== 'number') return n;
      out.idleExitMs = n;
    } else if (a === '--max-wall-clock-ms' || eq('--max-wall-clock-ms') !== undefined) {
      const raw = a === '--max-wall-clock-ms' ? args[++i] : eq('--max-wall-clock-ms');
      const n = positiveNumber('--max-wall-clock-ms', raw);
      if (typeof n !== 'number') return n;
      out.maxWallClockMs = n;
    } else {
      return { error: `unknown argument '${a}'` };
    }
  }
  if (!sawProjectRoot || out.projectRoot.length === 0) return { error: '--project-root is required' };
  return out;
}

/** Entry for `pipeline telemetry-daemon`. Never spawns anything itself — the
 *  hook already decided this process should exist by winning the `wx` lock
 *  before spawning it; this function just runs the loop and releases the
 *  lock (best-effort) on a clean exit. */
export async function runTelemetryDaemon(
  args: string[],
  deps: TelemetryDaemonCliDeps = realTelemetryDaemonCliDeps,
): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    deps.out(USAGE);
    return 0;
  }
  const parsed = parseTelemetryDaemonArgs(args);
  if ('error' in parsed) {
    deps.err(`pipeline telemetry-daemon: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  if (!existsSync(parsed.projectRoot)) {
    deps.err(`pipeline telemetry-daemon: --project-root does not exist: ${parsed.projectRoot}\n`);
    return 2;
  }

  const pollDeps: TelemetryDaemonPollDeps = {
    fs: deps.fs,
    env: deps.env,
    platform: deps.platform,
    homedir: deps.homedir,
    now: deps.now,
    fetch: deps.fetch,
    refreshFetch: deps.refreshFetch,
  };

  if (parsed.once) {
    const outcome = await pollProjectOnce(pollDeps, parsed.projectRoot);
    deps.out(`[telemetry-daemon] poll: ${outcome}\n`);
    return 0;
  }

  const reason = await runTelemetryDaemonLoop({
    pollIntervalMs: parsed.pollIntervalMs,
    idleExitMs: parsed.idleExitMs,
    maxWallClockMs: parsed.maxWallClockMs,
    now: deps.now,
    sleep: deps.sleep,
    poll: () => pollProjectOnce(pollDeps, parsed.projectRoot),
  });
  releaseDaemonLock(telemetryDaemonLockPath(parsed.projectRoot));
  deps.out(`[telemetry-daemon] exiting (${reason})\n`);
  return 0;
}
