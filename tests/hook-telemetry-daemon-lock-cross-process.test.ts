// @serial — real inter-process timing race for a real `wx` lock; held out of
// the parallel test pool (scripts/parallel-tests.ts) so CPU contention from
// unrelated suites can't distort the race window.
//
// hook-telemetry-daemon-lock-cross-process.test.ts — ux-v2 b11's DoD box
// "two simultaneous starts produce exactly one daemon", proven with REAL
// PROCESSES, not two in-process calls.
//
// WHY THIS FILE EXISTS ON TOP OF hook-telemetry-daemon-lock.test.ts's own
// (same-process) race test: `acquireTelemetryDaemonLock` is fully
// synchronous, so two calls made back-to-back in one JS thread can NEVER
// interleave — the second always observes the first's completed write,
// regardless of whether the write used `wx` or a plain `writeFileSync`. That
// was verified directly during this task's mutation check: reverting the
// `wx` flag and re-running the same-process race test left it PASSING
// (see fixtures/telemetry-lock-race-worker.ts's header for the full
// explanation, and the PR body for the recorded mutation-check trace). A
// same-process test proves the DECISION LOGIC (already-running / stale /
// acquire) is correct; it cannot prove the RACE is fixed, because it never
// exercises genuine concurrent access to the lock file. Only two real OS
// processes, whose syscalls the OS scheduler can actually interleave, can
// do that — the exact scenario `hooks/run-hook.sh` produces in production
// (Claude Code spawns one Bun process per hook invocation).
//
// Mirrors this repo's own precedent for exactly this shape:
// tests/credential-refresh-cross-process.test.ts (a5) races two real
// processes for `lib/credential-lock.ts`'s `wx` lock the same way.
//
// The workers LINGER after acquiring (fixtures/telemetry-lock-race-worker.ts's
// own header explains why: an immediately-exiting winner would make the
// loser's liveness check honestly — and correctly — see the winner's pid as
// dead, which is the DIFFERENT "abandoned reservation" case, not the race
// this file is proving). So this test polls for the RESULT FILES rather than
// waiting for either process to exit, then force-kills both.

import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { telemetryDaemonLockPath } from '../../../hooks/analytics_relay.ts';

const created: string[] = [];
const liveChildren = new Set<ChildProcess>();

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

afterEach(() => {
  for (const child of liveChildren) {
    if (child.pid !== undefined) killTree(child.pid);
  }
  liveChildren.clear();
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

const WORKER = join(import.meta.dir, 'fixtures', 'telemetry-lock-race-worker.ts');

/** Poll for a file's existence, bounded — used to wait for each worker's
 *  result without a fixed sleep. */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return existsSync(path);
}

test(
  'two REAL bun processes racing acquireTelemetryDaemonLock for the SAME lock file: exactly ONE reports "acquired", the other "already-running" or "skip" — never both, never neither',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'telemetry-lock-xproc-'));
    created.push(root);
    mkdirSync(join(root, '.pipeline', '.runtime', 'telemetry'), { recursive: true });
    const lockPath = telemetryDaemonLockPath(root);
    const barrier = join(root, 'go.barrier');
    const resultA = join(root, 'result-a.json');
    const resultB = join(root, 'result-b.json');
    const now = 1_000_000;

    const envBase: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) envBase[k] = v;
    envBase.WORKER_LOCK_PATH = lockPath;
    envBase.WORKER_BARRIER = barrier;
    envBase.WORKER_NOW = String(now);
    // Long enough that a genuine loser's liveness check (a handful of ms
    // after the winner writes) reliably lands on a still-alive winner, short
    // enough this test does not linger unreasonably.
    envBase.WORKER_LINGER_MS = '3000';

    const a = spawn(process.execPath, [WORKER], {
      env: { ...envBase, WORKER_RESULT_PATH: resultA },
      stdio: 'ignore',
      windowsHide: true,
    });
    const b = spawn(process.execPath, [WORKER], {
      env: { ...envBase, WORKER_RESULT_PATH: resultB },
      stdio: 'ignore',
      windowsHide: true,
    });
    liveChildren.add(a);
    liveChildren.add(b);

    try {
      // Give both children time to finish Bun startup + module resolution
      // and reach their busy-wait on the barrier, THEN release them
      // together — this is what makes the race land on the actual
      // acquisition syscalls rather than on which process happened to boot
      // faster.
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(barrier, 'go');

      const [gotA, gotB] = await Promise.all([waitForFile(resultA, 10_000), waitForFile(resultB, 10_000)]);
      expect(gotA).toBe(true);
      expect(gotB).toBe(true);

      const outA = JSON.parse(readFileSync(resultA, 'utf-8'));
      const outB = JSON.parse(readFileSync(resultB, 'utf-8'));

      const outcomes = [outA, outB];
      const acquired = outcomes.filter((o) => o.action === 'acquired');
      // The LOSER's outcome depends on exactly where the race landed
      // relative to `acquireTelemetryDaemonLock`'s internal fast-path read
      // (see that function's doc comment): if the loser's OWN snapshot read
      // happened after the winner had already finished writing, it takes
      // the "already-running" fast path; if the loser's `wx` create attempt
      // itself lost to the winner's, it gets "skip". Both are CORRECT,
      // non-acquiring outcomes — the invariant under test is "exactly one
      // acquired", not which shape the other one takes.
      const nonAcquired = outcomes.filter((o) => o.action === 'already-running' || o.action === 'skip');

      // THE CORE PROOF: across two REAL, independently-scheduled OS
      // processes racing for the SAME lock, exactly one wins. Two
      // `acquired` here would mean two telemetry daemons got spawned for
      // one project; zero would mean neither did (a wedge — `skip`+`skip`,
      // which this assertion also catches since `nonAcquired` would have
      // length 2 while `acquired` has length 0).
      expect(acquired).toHaveLength(1);
      expect(nonAcquired).toHaveLength(1);

      // The lock on disk names the WINNER's pid, once — not a mix of both.
      const onDisk = JSON.parse(readFileSync(lockPath, 'utf-8'));
      expect([a.pid, b.pid]).toContain(onDisk.pid);
    } finally {
      if (a.pid !== undefined) killTree(a.pid);
      if (b.pid !== undefined) killTree(b.pid);
      liveChildren.delete(a);
      liveChildren.delete(b);
    }
  },
  20_000,
);
