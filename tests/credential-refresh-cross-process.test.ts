// @serial — real inter-process timing (two real `bun` processes racing for
// a real cross-process lock); the parallel-tests.ts runner holds this file
// out of the N-way worker pool so CPU contention from unrelated suites can't
// distort the race window. See scripts/parallel-tests.ts's module doc.
//
// credential-refresh-cross-process.test.ts — a5 DoD box 1, proven with REAL
// PROCESSES, not mocks: "Two processes refreshing concurrently perform
// exactly one refresh; the other observes the result."
//
// WHY THIS SHAPE (and not a real Bun.serve() loopback double): a4's
// cross-process test that spawned subprocesses talking to a real
// `Bun.serve()` loopback double proved unreliable in this sandbox (300s+
// then failure). This test proves the SAME property — genuine cross-process
// single-flight — with NO network stack anywhere: both real child processes
// import the actual `ensureFreshCredential` (the actual lock in
// credential-lock.ts, the actual atomic write-then-rename in
// cloud-config.ts) against a REAL shared credential store file, and the only
// thing swapped out is the injected `fetch` seam — replaced by a local
// function (tests/fixtures/cred-refresh-worker.ts) that appends to a shared
// log file instead of making an HTTP call. That log file is the one channel
// that can prove "how many real refresh attempts happened across BOTH
// processes" — no in-memory counter in either process could ever answer
// that, since there is no shared memory between two OS processes. This is
// exactly the kind of "file-based, HTTP-free double" the task brief asks for
// when a real network loopback is unreliable here.
//
// What this DOES prove: the lock (open(O_EXCL) exclusive creation + release)
// and the refresh-result hand-off (re-read under the lock, return the
// winner's persisted value) are genuinely exercised across two independent
// OS processes with no shared JS heap — the property a same-process
// Promise.all test (credential-refresh.test.ts) cannot fully establish,
// because a same-process test can never rule out an accidental reliance on
// shared in-memory state that would silently break across a real process
// boundary.

import { test, expect, afterEach } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFs, credentialFilePath, writeCredentialStore, type HomeContext } from '../src/lib/cloud-config';

const created: string[] = [];

// Every spawned child is tracked here for the LIFE OF THE PROCESS, not just
// one test — `afterEach` sweeps whatever is still in it. This is the
// belt-and-braces net: `runWorker`'s own internal watchdog (below) is what
// actually kills a hung worker DURING a test, but if a test throws before
// that watchdog even fires (or bun's own per-test timeout abandons the test
// function mid-`await` — a real risk here, since bun cannot truly cancel a
// suspended async function, only report the test as failed and move on), a
// child left in this set is still reaped once the file's `afterEach` runs
// for that test. A leaked real subprocess is exactly the "leaked-listener"
// class of defect a2 already hit once — every exit path here closes it.
const liveChildren = new Set<ChildProcess>();

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL'); // process GROUP first — see spawnDetached below
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

afterEach(() => {
  for (const child of liveChildren) {
    if (child.pid !== undefined) killTree(child.pid);
  }
  liveChildren.clear();
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const WORKER = join(import.meta.dir, 'fixtures', 'cred-refresh-worker.ts');
const SERVER = 'https://api.ai-pipeline.dev';

/** Bounds how long a single worker may run before `runWorker` gives up on it
 *  AND kills it — this worker does at most one refresh call plus a short
 *  injected delay (WORKER_DELAY_MS), so anything near this bound is already
 *  wrong; the point is that the process is ALWAYS reaped, not that this
 *  number is tight. */
const WORKER_TIMEOUT_MS = 15_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the worker and ALWAYS settle + ALWAYS reap the child — on a clean
 * exit, on a spawn error, or on a watchdog timeout. Nothing here waits
 * unboundedly on a real OS process: a hung/stuck child (a bug in the lock,
 * unexpected CPU contention from other agents sharing this machine, etc.)
 * is force-killed at `WORKER_TIMEOUT_MS` rather than left to run past the
 * test's own lifetime.
 */
function runWorker(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX: own process group so killTree's `process.kill(-pid, ...)`
      // reaps the whole tree, not just this one process — mirrors
      // lib/hook-runner.ts's proven tree-kill convention.
      detached: process.platform !== 'win32',
    });
    liveChildren.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      if (child.pid !== undefined) killTree(child.pid);
      reject(new Error(`worker did not exit within ${WORKER_TIMEOUT_MS}ms — killed. stderr so far: ${stderr}`));
    }, WORKER_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (stdout += d));
    child.stderr?.on('data', (d: string) => (stderr += d));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

test(
  'two REAL bun processes refreshing the same credential store concurrently: exactly ONE network refresh happens; the other process re-reads and returns the SAME rotated result',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'pipeline-cred-xproc-'));
    created.push(home);
    const callsLog = join(home, 'refresh-calls.log');

    // Seed a credential that unambiguously needs a refresh (expired), with a
    // refresh_token both processes will race to use.
    const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
    writeCredentialStore(realFs, credentialFilePath(ctx), {
      version: 1,
      servers: { [SERVER]: { access_token: 'at-old', refresh_token: 'rt-old', token_type: 'bearer', expires_at: 1 } },
    });

    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
    delete childEnv.PIPELINE_MACHINE_TOKEN;
    childEnv.PIPELINE_CLOUD_HOME = home;
    childEnv.WORKER_SERVER = SERVER;
    childEnv.WORKER_CALLS_LOG = callsLog;
    childEnv.WORKER_DELAY_MS = '150';

    // Launch BOTH real processes essentially simultaneously.
    const [a, b] = await Promise.all([runWorker(childEnv), runWorker(childEnv)]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    if (a.code !== 0 || b.code !== 0) {
      // Surface stderr in the failure output rather than a bare "expected 0".
      throw new Error(`worker stderr — a: ${a.stderr}\nb: ${b.stderr}`);
    }

    // THE core proof: exactly one line in the shared log, meaning the fake
    // refresh grant was invoked exactly once ACROSS BOTH real processes.
    const logLines = existsSync(callsLog)
      ? readFileSync(callsLog, 'utf-8').split('\n').filter((l) => l.length > 0)
      : [];
    expect(logLines).toHaveLength(1);

    // Both processes report the IDENTICAL rotated token pair — the loser
    // awaited the lock and RE-READ the winner's result rather than minting
    // (or worse, presenting a second, already-rotated token for) its own.
    const outA = JSON.parse(a.stdout);
    const outB = JSON.parse(b.stdout);
    expect(outA.access_token).toBe(outB.access_token);
    expect(outA.refresh_token).toBe(outB.refresh_token);
    expect(outA.access_token).toMatch(/^at-new-/);
    expect(outA.refresh_token).toMatch(/^rt-new-/);
    expect(outA.access_token).not.toBe('at-old');

    // The store on disk matches what both processes reported — no
    // desynchronized third value hiding on disk.
    const onDisk = JSON.parse(readFileSync(credentialFilePath(ctx), 'utf-8'));
    expect(onDisk.servers[SERVER].access_token).toBe(outA.access_token);
    expect(onDisk.servers[SERVER].refresh_token).toBe(outA.refresh_token);

    // No lock file left behind — a future call is never wedged by this run.
    expect(existsSync(join(home, 'credentials.lock'))).toBe(false);
  },
  20_000,
);

test(
  'sanity check: the log-based double genuinely counts real invocations (a SINGLE process still logs exactly once)',
  async () => {
    // Guards against a vacuously-true box-1 test: if this sanity check ever
    // showed 0 or 2+ lines for one worker, the log mechanism itself would be
    // untrustworthy and the "exactly one" assertion above would prove
    // nothing. Kept as an explicit, separate assertion rather than folded
    // into the race test so a regression in the double is caught on its own.
    const home = mkdtempSync(join(tmpdir(), 'pipeline-cred-xproc-solo-'));
    created.push(home);
    const callsLog = join(home, 'refresh-calls.log');
    const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
    writeCredentialStore(realFs, credentialFilePath(ctx), {
      version: 1,
      servers: { [SERVER]: { access_token: 'at-old', refresh_token: 'rt-old', token_type: 'bearer', expires_at: 1 } },
    });
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
    delete childEnv.PIPELINE_MACHINE_TOKEN;
    childEnv.PIPELINE_CLOUD_HOME = home;
    childEnv.WORKER_SERVER = SERVER;
    childEnv.WORKER_CALLS_LOG = callsLog;
    childEnv.WORKER_DELAY_MS = '10';

    const result = await runWorker(childEnv);
    expect(result.code).toBe(0);
    const logLines = readFileSync(callsLog, 'utf-8').split('\n').filter((l) => l.length > 0);
    expect(logLines).toHaveLength(1);
  },
  20_000,
);
