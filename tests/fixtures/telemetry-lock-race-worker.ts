// telemetry-lock-race-worker.ts — spawned as a REAL, separate OS process by
// hook-telemetry-daemon-lock-cross-process.test.ts to prove the `wx` lock
// race fix (ux-v2 b11) with genuine OS-level concurrency.
//
// WHY A SEPARATE PROCESS IS THE ONLY WAY TO TEST THIS: `acquireTelemetryDaemonLock`
// is fully SYNCHRONOUS — no `await` anywhere inside it. Two calls made from
// the SAME JS thread (even wrapped in `Promise.all`) can never interleave:
// the second call always starts only after the first has already returned,
// so it always observes the first call's completed write. That is true of
// BOTH the fixed (`wx`) shape and the buggy (`existsSync`-then-plain-write)
// shape being fixed here — a same-process test literally cannot distinguish
// them (this was verified directly: reverting the `wx` flag and re-running a
// same-process "call it twice" test still passed, because there is no async
// gap between the two calls for a bug to hide in). The actual bug in
// `department_notifier_relay.ts` this task is fixing manifests ACROSS TWO
// SEPARATE HOOK SUBPROCESSES (Claude Code spawns one Bun process per hook
// invocation — `hooks/run-hook.sh`), where the OS scheduler CAN genuinely
// interleave two processes' syscalls. Only a real process boundary can prove
// or disprove that.
//
// SYNCHRONIZATION: both racing workers poll the SAME barrier file in a tight
// loop before calling `acquireTelemetryDaemonLock` — this lets both
// processes finish their own Bun startup + module resolution BEFORE the
// race begins, so the race is on the ACTUAL lock-acquisition syscalls, not
// on which process happened to boot faster. Bounded to 10s so a missing
// barrier (a test bug) fails fast with a clear message instead of hanging.
//
// LINGER AFTER ACQUIRING — NOT OPTIONAL, and the reason is load-bearing: a
// caller that acquires the lock and then exits IMMEDIATELY (as an earlier
// version of this fixture did) makes `isProcessAlive` correctly, HONESTLY
// report its pid as dead within a handful of milliseconds — which is not
// the race this test exists to prove or disprove, it is the DIFFERENT,
// already-documented "abandoned reservation" case
// (`hooks/analytics_relay.ts`'s `spawnTelemetryDaemon` comment: a hook that
// wins the reservation but never gets to `finalizeTelemetryDaemonLock`
// "self-heals" the instant it exits). In PRODUCTION the winner's pid in the
// lock is overwritten with a LONG-LIVED daemon's pid (`finalizeTelemetryDaemonLock`)
// within the same synchronous call chain, microseconds after acquiring — so
// a genuine racing loser almost always observes a pid that is very much
// still alive. This fixture models THAT by staying alive for
// `WORKER_LINGER_MS` after computing its result (written to disk
// immediately, so the test does not have to wait out the full linger to
// read it) before exiting.
//
// argv: none. Config via env:
//   WORKER_LOCK_PATH    the lock file both racing workers target
//   WORKER_BARRIER      the barrier file this worker polls for
//   WORKER_NOW           the fixed `now` (ms) both workers pass, so a result
//                        difference can only come from which `wx` create
//                        actually won, never from clock skew between them
//   WORKER_RESULT_PATH  where this worker writes its JSON result
//   WORKER_LINGER_MS    how long to stay alive after acquiring, before exit
//                        (default 2000)

import { existsSync, writeFileSync } from 'node:fs';
import { acquireTelemetryDaemonLock } from '../../../../hooks/analytics_relay.ts';

const lockPath = process.env.WORKER_LOCK_PATH!;
const barrier = process.env.WORKER_BARRIER!;
const now = Number(process.env.WORKER_NOW!);
const resultPath = process.env.WORKER_RESULT_PATH!;
const lingerMs = Number(process.env.WORKER_LINGER_MS ?? '2000');

const deadline = Date.now() + 10_000;
while (!existsSync(barrier)) {
  if (Date.now() > deadline) {
    writeFileSync(resultPath, JSON.stringify({ action: 'error', message: 'barrier never appeared' }));
    process.exit(1);
  }
  // Deliberately no sleep: minimizing the delay between "barrier appears"
  // and "this worker acts" is the whole point of the busy-wait.
}

const result = acquireTelemetryDaemonLock(lockPath, now, process.pid);
writeFileSync(resultPath, JSON.stringify(result));

// Stay alive so this process's pid (if it won) is genuinely, checkably
// alive for a realistic window — see the header comment. The test reads
// `resultPath` as soon as it exists; it does not wait for this process to
// exit (it force-kills both workers once results are in hand).
await new Promise((r) => setTimeout(r, lingerMs));
process.exit(0);
