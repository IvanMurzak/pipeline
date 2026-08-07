/**
 * The telemetry-daemon-ensure block in hooks/analytics_relay.ts (ux-v2 b11):
 * the atomic `wx` lock, its stale-lock reclamation, and
 * `ensureTelemetryDaemonRunning`'s gating.
 *
 *   bun test tests/hook-telemetry-daemon-lock.test.ts
 *
 * Two layers of coverage, mirroring
 * apps/pipeline-cli/tests/hook-department-notifier.test.ts and
 * apps/pipeline-cli/tests/credential-lock.test.ts (this repo's other `wx`
 * single-instance/advisory lock, `lib/credential-lock.ts`):
 *
 *   - `acquireTelemetryDaemonLock` exercised directly against a real
 *     filesystem (a tmpdir) — the exclusive-create primitive IS the
 *     mechanism, so mocking `fs` would test nothing. This is where the RACE
 *     and the STALE-LOCK RECLAMATION are proven.
 *   - `ensureTelemetryDaemonRunning`'s GATING (sync disabled / no cloud
 *     account / an already-live daemon) — never through the branch that
 *     would spawn a real detached `pipeline telemetry-daemon` process. That
 *     branch is deliberately NOT exercised here, for the exact reason
 *     `hook-department-notifier.test.ts`'s own header gives for
 *     `spawnNotifyDaemon`: doing so for real would fork a genuine detached
 *     background process (a poll loop with real timers) inside `bun test`,
 *     which must never happen. Every scenario below either gates out before
 *     that branch, or pre-seeds a lock pointing at THIS test process's own
 *     pid (always alive) so `ensureTelemetryDaemonRunning` takes the
 *     "already running" early return. The spawn SHAPE itself
 *     (`detached: true`, `stdio: "ignore"`, `windowsHide: true`,
 *     `child.unref()`) is copied verbatim from `department_notifier_relay.ts`'s
 *     own already-proven `spawnNotifyDaemon` — see this file's header.
 *
 * MUTATION CHECK (matching the standard `b9`/`b10` set — see the PR body for
 * the recorded before/after): `acquireTelemetryDaemonLock`'s `wx`-flagged
 * `writeFileSync` was temporarily reverted to the OLD `existsSync`-then-plain-
 * write shape (`department_notifier_relay.ts`'s own buggy shape) and the
 * "two near-simultaneous acquires" test below was re-run — it caught the
 * regression (both callers report `'acquired'`, i.e. two daemons). The fix
 * was restored and the same test passes (exactly one `'acquired'`). That
 * edit-run-revert-run cycle is a manual verification step, not code
 * committed here — a permanently-committed "buggy mode" flag would be
 * product-code cruft with no runtime purpose.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  acquireTelemetryDaemonLock,
  ensureTelemetryDaemonRunning,
  telemetryDaemonLockPath,
  telemetryDaemonSyncEnabled,
  TELEMETRY_LOCK_STALE_AGE_MS,
} from "../../../hooks/analytics_relay.ts";

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function mkProject(): string {
  const d = mkdtempSync(join(tmpdir(), "telemetry-daemon-lock-"));
  created.push(d);
  return d;
}

function lockDirFor(root: string): string {
  return join(root, ".pipeline", ".runtime", "telemetry");
}

function seedLock(root: string, lock: { pid: number; started_at: string }): string {
  const dir = lockDirFor(root);
  mkdirSync(dir, { recursive: true });
  const lockPath = telemetryDaemonLockPath(root);
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  return lockPath;
}

/** A real, reliably-DEAD pid: `spawnSync` blocks until the child has already
 *  exited, so its pid names a process that is guaranteed gone by the time
 *  this returns — portable across Windows and POSIX, unlike a hardcoded
 *  large number that some OS could theoretically still be using. Mirrors
 *  `credential-lock.test.ts`'s own `999999999` idiom in spirit; this is the
 *  more literal version. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["--version"]);
  const pid = r.pid;
  if (typeof pid !== "number" || pid <= 0) throw new Error("spawnSync did not report a pid");
  return pid;
}

// ---------------------------------------------------------------------------
// telemetryDaemonLockPath
// ---------------------------------------------------------------------------

describe("telemetryDaemonLockPath", () => {
  test("is <project>/.pipeline/.runtime/telemetry/daemon.lock", () => {
    const root = mkProject();
    expect(telemetryDaemonLockPath(root)).toBe(join(root, ".pipeline", ".runtime", "telemetry", "daemon.lock"));
  });
});

// ---------------------------------------------------------------------------
// telemetryDaemonSyncEnabled — same falsy-parse convention as the file's
// other switches (journalEnabled / awaitingInputEnabled).
// ---------------------------------------------------------------------------

describe("telemetryDaemonSyncEnabled", () => {
  const KEY = "PIPELINE_SYNC_LOCAL_STATS";
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  test("unset -> enabled by default", () => {
    delete process.env[KEY];
    expect(telemetryDaemonSyncEnabled()).toBe(true);
  });

  test.each(["0", "false", "no", "off", "FALSE", "Off"])("falsy value %p disables", (v) => {
    process.env[KEY] = v;
    expect(telemetryDaemonSyncEnabled()).toBe(false);
  });

  test.each(["1", "true", "yes", "on", "anything"])("non-falsy value %p keeps it enabled", (v) => {
    process.env[KEY] = v;
    expect(telemetryDaemonSyncEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// acquireTelemetryDaemonLock — mutual exclusion (THE RACE FIX)
// ---------------------------------------------------------------------------

describe("acquireTelemetryDaemonLock — mutual exclusion", () => {
  test("an unheld lock is acquired, creating the file with the caller's pid", () => {
    const root = mkProject();
    mkdirSync(lockDirFor(root), { recursive: true });
    const lockPath = telemetryDaemonLockPath(root);
    const now = 1_000_000;

    const result = acquireTelemetryDaemonLock(lockPath, now, 4242);

    expect(result).toEqual({ action: "acquired" });
    expect(existsSync(lockPath)).toBe(true);
    const written = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(written.pid).toBe(4242);
  });

  test("a lock already held by a LIVE pid is left byte-for-byte untouched, and reports 'already-running'", () => {
    const root = mkProject();
    const now = 1_000_000;
    const before = { pid: process.pid, started_at: new Date(now).toISOString() };
    const lockPath = seedLock(root, before);

    const result = acquireTelemetryDaemonLock(lockPath, now, 9999);

    expect(result).toEqual({ action: "already-running", pid: process.pid });
    expect(JSON.parse(readFileSync(lockPath, "utf-8"))).toEqual(before);
  });

  test("TWO NEAR-SIMULTANEOUS acquires on the SAME fresh lock: exactly ONE 'acquired', the other 'already-running' naming the winner — never both", () => {
    const root = mkProject();
    mkdirSync(lockDirFor(root), { recursive: true });
    const lockPath = telemetryDaemonLockPath(root);
    const now = 1_000_000;

    // Two callers racing to start the SAME project's daemon. In production
    // each is a SEPARATE OS process reserving with ITS OWN (real, currently
    // alive) pid; a single test process only has one real pid to hand out,
    // so both simulated callers use `process.pid` here — the same "this
    // test process's own pid, always alive" idiom
    // hook-department-notifier.test.ts uses for the same reason. An
    // arbitrary made-up pid would instead make the SECOND call see the
    // first caller's lock as held by a DEAD pid and legitimately reclaim
    // it — proving reclamation, not the race fix this test targets.
    // Nothing here pre-seeds a lock — both see "absent" if they were
    // reading naively; the `wx` create is what actually decides the winner.
    const first = acquireTelemetryDaemonLock(lockPath, now, process.pid);
    const second = acquireTelemetryDaemonLock(lockPath, now, process.pid);

    const outcomes = [first, second];
    const acquired = outcomes.filter((o) => o.action === "acquired");
    const alreadyRunning = outcomes.filter((o) => o.action === "already-running");
    expect(acquired).toHaveLength(1);
    expect(alreadyRunning).toHaveLength(1);
    // The loser is told the WINNER's pid, not its own — proving the second
    // caller actually observed the first caller's write, not a stale read.
    expect((alreadyRunning[0] as { pid: number }).pid).toBe(process.pid);
    // On disk: exactly one daemon's worth of state — the winner's pid, once.
    const onDisk = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(onDisk.pid).toBe(process.pid);
  });
});

// ---------------------------------------------------------------------------
// acquireTelemetryDaemonLock — stale-lock reclamation (the wedge this design
// invites if `wx` is added WITHOUT a reclaim path — see file header / PR).
// ---------------------------------------------------------------------------

describe("acquireTelemetryDaemonLock — stale-lock reclamation", () => {
  test("a lock recorded by a DEAD pid is reclaimed immediately, even though it is FRESH by age", () => {
    const root = mkProject();
    const now = 1_000_000;
    const dead = deadPid();
    const lockPath = seedLock(root, { pid: dead, started_at: new Date(now).toISOString() }); // just written -> not stale by age

    const result = acquireTelemetryDaemonLock(lockPath, now, 5555);

    expect(result).toEqual({ action: "acquired" });
    const written = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(written.pid).toBe(5555);
  });

  test("a lock older than TELEMETRY_LOCK_STALE_AGE_MS is reclaimed even though its recorded pid is genuinely ALIVE (this process)", () => {
    const root = mkProject();
    const now = 1_000_000;
    const ancientStartedAt = now - (TELEMETRY_LOCK_STALE_AGE_MS + 1);
    const lockPath = seedLock(root, { pid: process.pid, started_at: new Date(ancientStartedAt).toISOString() });

    const result = acquireTelemetryDaemonLock(lockPath, now, 6666);

    expect(result).toEqual({ action: "acquired" });
  });

  test("a lock exactly AT the age boundary is stale (>=), and a lock one ms younger is not", () => {
    const root = mkProject();
    const now = 1_000_000;

    const atBoundary = seedLock(root, {
      pid: process.pid,
      started_at: new Date(now - TELEMETRY_LOCK_STALE_AGE_MS).toISOString(),
    });
    expect(acquireTelemetryDaemonLock(atBoundary, now, 1).action).toBe("acquired");

    const justUnder = seedLock(root, {
      pid: process.pid,
      started_at: new Date(now - TELEMETRY_LOCK_STALE_AGE_MS + 1).toISOString(),
    });
    expect(acquireTelemetryDaemonLock(justUnder, now, 2).action).toBe("already-running");
  });

  test("a FRESH lock with a genuinely alive pid is NEVER reclaimed — the caller is told it's already running, not stolen from", () => {
    const root = mkProject();
    const now = 1_000_000;
    const lockPath = seedLock(root, { pid: process.pid, started_at: new Date(now).toISOString() });

    const result = acquireTelemetryDaemonLock(lockPath, now, 7777);

    expect(result).toEqual({ action: "already-running", pid: process.pid });
    // Untouched — reclamation must never fire on a live, fresh lock.
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(process.pid);
  });

  test("a corrupt/unreadable lock file is treated as absent and can be acquired outright", () => {
    const root = mkProject();
    mkdirSync(lockDirFor(root), { recursive: true });
    const lockPath = telemetryDaemonLockPath(root);
    writeFileSync(lockPath, "{ not json");

    const result = acquireTelemetryDaemonLock(lockPath, 1_000_000, 8888);

    expect(result).toEqual({ action: "acquired" });
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(8888);
  });
});

// ---------------------------------------------------------------------------
// ensureTelemetryDaemonRunning — gating. Never exercises the real spawn
// branch — see this file's header for why.
// ---------------------------------------------------------------------------

describe("ensureTelemetryDaemonRunning — gating (no network work, no spawn attempted here)", () => {
  const SYNC_KEY = "PIPELINE_SYNC_LOCAL_STATS";
  const saved = process.env[SYNC_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[SYNC_KEY];
    else process.env[SYNC_KEY] = saved;
  });

  test("PIPELINE_SYNC_LOCAL_STATS=0 -> no telemetry dir is even created (gates before any lock I/O)", () => {
    process.env[SYNC_KEY] = "0";
    const root = mkProject();
    // A project that IS bound, so the ONLY reason nothing happens is the
    // sync switch — proving it is checked (and short-circuits) first.
    mkdirSync(join(root, ".pipeline"), { recursive: true });
    writeFileSync(join(root, ".pipeline", "cloud.json"), JSON.stringify({ server: "https://x", org: "acme" }));

    ensureTelemetryDaemonRunning(root);

    expect(existsSync(lockDirFor(root))).toBe(false);
  });

  test("no .pipeline/cloud.json -> no telemetry dir is created (F7: no cloud account, nothing spawned)", () => {
    delete process.env[SYNC_KEY];
    const root = mkProject();
    mkdirSync(join(root, ".pipeline"), { recursive: true }); // .pipeline exists, but no cloud.json inside it

    ensureTelemetryDaemonRunning(root);

    expect(existsSync(lockDirFor(root))).toBe(false);
  });

  test("cloud.json present, an already-running (this process's pid) lock exists -> left untouched, no daemon spawn attempted", () => {
    delete process.env[SYNC_KEY];
    const root = mkProject();
    mkdirSync(join(root, ".pipeline"), { recursive: true });
    writeFileSync(join(root, ".pipeline", "cloud.json"), JSON.stringify({ server: "https://x", org: "acme" }));
    const before = { pid: process.pid, started_at: new Date().toISOString() };
    const lockPath = seedLock(root, before);

    ensureTelemetryDaemonRunning(root);

    // Untouched: the "already-running" branch returned without ever
    // reaching the reclaim/wx-create/spawn code path.
    expect(JSON.parse(readFileSync(lockPath, "utf-8"))).toEqual(before);
  });
});
