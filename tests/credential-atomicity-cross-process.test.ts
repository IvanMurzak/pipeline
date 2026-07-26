// @serial — real process-kill timing; held out of the N-way parallel pool
// (scripts/parallel-tests.ts) so CPU contention can't distort the poll for
// the "ready" marker below.
//
// credential-atomicity-cross-process.test.ts — a5 DoD box 2, proven with a
// REAL killed process: "A killed process mid-write leaves a valid credential
// file (previous or new, never partial)."
//
// A REAL child process (tests/fixtures/atomic-write-worker.ts) runs the
// actual `writeCredentialStore` write-then-rename path against a real file.
// Its `renameSync` is wrapped to signal a "ready" marker the instant the temp
// file is fully written (BEFORE the rename), then busy-wait — giving this
// test a wide, reliable window to deliver a REAL kill (SIGKILL on POSIX,
// `taskkill /T /F` on Windows — the same tree-kill primitive
// `lib/hook-runner.ts` already uses elsewhere in this codebase) squarely
// inside the vulnerable window, deterministically, rather than hoping a race
// lands right by luck.
//
// The child is ALWAYS reaped — via an unconditional kill right after the
// ready-poll settles (success or timeout), a `try/finally` around the rest
// of the test body, and a module-level `afterEach` sweep as a last resort —
// so a bug or an unexpected timing miss here can never leave a busy-waiting
// real process running past this test's own lifetime (the same class of
// leaked-real-process defect a2's loopback listener hit once before).

import { test, expect, afterEach } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFs, credentialFilePath, writeCredentialStore, type HomeContext } from '../src/lib/cloud-config';

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
  // Last-resort sweep: whatever a test's own kill logic missed (e.g. a
  // thrown error before it ran) is still reaped here.
  for (const child of liveChildren) {
    if (child.pid !== undefined) killTree(child.pid);
  }
  liveChildren.clear();
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const WORKER = join(import.meta.dir, 'fixtures', 'atomic-write-worker.ts');

/** Poll for a file's existence, bounded — used to wait for the "ready"
 *  marker without a fixed sleep (the busy-wait inside the worker means a
 *  fixed guess could either miss the window or wait needlessly long). */
async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return existsSync(path);
}

test(
  'a REAL killed process, interrupted between the temp-file write and the rename, leaves the ORIGINAL credential file completely intact (never partial, never corrupt)',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'pipeline-cred-atomic-xproc-'));
    created.push(home);
    const readyMarker = join(home, 'ready.marker');
    const doneMarker = join(home, 'done.marker');

    const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
    const credPath = credentialFilePath(ctx);
    writeCredentialStore(realFs, credPath, {
      version: 1,
      servers: { 'https://example.test': { access_token: 'OLD_VALUE', token_type: 'bearer' } },
    });
    const originalRaw = readFileSync(credPath, 'utf-8');

    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
    childEnv.PIPELINE_CLOUD_HOME = home;
    childEnv.WORKER_READY_MARKER = readyMarker;
    childEnv.WORKER_DONE_MARKER = doneMarker;

    const child = spawn(process.execPath, [WORKER], { env: childEnv, stdio: 'ignore', windowsHide: true });
    liveChildren.add(child);
    const pid = child.pid;

    try {
      const exitPromise = new Promise<void>((resolve) => child.on('close', () => resolve()));

      // Bounded wait for "temp file written, about to rename" — worst case
      // (the marker never appears) this still returns within 10s, it just
      // returns `false`.
      const gotReady = await waitForFile(readyMarker, 10_000);

      // Kill UNCONDITIONALLY here, before any assertion — whether the
      // marker appeared (the expected path) or the worker is stuck/slow for
      // some other reason, this process must never be left running past
      // this point. `expect` throws on failure, so anything that could
      // throw stays AFTER the kill, never before it.
      if (pid !== undefined) killTree(pid);
      await exitPromise;
      liveChildren.delete(child);

      expect(gotReady).toBe(true); // the worker really did reach the vulnerable window

      // The kill landed BEFORE the worker's rename — proven by the ABSENCE
      // of its completion marker (the worker's busy-wait is 5s; the kill
      // above fires immediately on seeing the ready marker, nowhere near
      // that).
      expect(existsSync(doneMarker)).toBe(false);

      // The credential file is still fully valid JSON — never truncated,
      // never a half-written mix of old and new bytes — and its content is
      // BYTE-FOR-BYTE the ORIGINAL (the rename that would have swapped in
      // the new content never ran).
      expect(existsSync(credPath)).toBe(true);
      const rawAfter = readFileSync(credPath, 'utf-8');
      expect(rawAfter).toBe(originalRaw);
      const parsed = JSON.parse(rawAfter); // throws if corrupt — the real assertion
      expect(parsed.servers['https://example.test'].access_token).toBe('OLD_VALUE');
      expect(rawAfter).not.toContain('NEW_VALUE_should_never_be_observed');
    } finally {
      // Belt-and-braces: if anything above threw BEFORE the unconditional
      // kill ran (e.g. `waitForFile` itself throwing), this still reaps it.
      if (liveChildren.has(child)) {
        if (pid !== undefined) killTree(pid);
        liveChildren.delete(child);
      }
    }
  },
  20_000,
);
