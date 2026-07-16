// Hook supervisor subprocess for runHook() (lib/hooks.ts).
//
// Why this exists: runHook must stay SYNCHRONOUS (invokeNext is a sync API the
// `pipeline drive` loop consumes), but a plain spawnSync `timeout` cannot kill a
// hook's process TREE — on POSIX a SIGTERM-trapping hook would hang the CLI
// forever, and killing only the direct child leaves wrapper-chain grandchildren
// (python → python → git — the shape of real consumer hooks) free to finish
// creating a worktree AFTER the run already halted "timed out". Behavior was
// verified under BUN explicitly (not assumed from Node parity).
//
// So runHook spawnSync's THIS file (via process.execPath), and this supervisor
// owns the real timeout: it async-spawns the hook, arms a timer, and on expiry
// kills the WHOLE tree —
//   win32: `taskkill /pid <pid> /T /F` (walks the parent chain),
//   POSIX: the child is spawned DETACHED (its own process group) and the group
//          gets SIGKILL via process.kill(-pid) (fallback: direct SIGKILL).
// It then reports ONE JSON envelope {code, stdout, stderr, timedOut, error?} on
// its own stdout (the hook's stdout/stderr are captured INSIDE the envelope,
// never interleaved) and exits 0.
//
// argv: <execPath> hook-runner.ts <timeoutMs> <cmd> [args...]

import { spawn, spawnSync } from 'node:child_process';

const timeoutMs = Math.max(1, Number(process.argv[2]) || 0);
const cmd = process.argv[3];
const args = process.argv.slice(4);

let stdout = '';
let stderr = '';
let timedOut = false;
let settled = false;

function report(code: number | null, error?: string): void {
  if (settled) return;
  settled = true;
  process.stdout.write(
    JSON.stringify({ code: timedOut ? null : code, stdout, stderr, timedOut, ...(error ? { error } : {}) }),
  );
  process.exit(0);
}

const child = spawn(cmd, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  // POSIX: a NEW process group so one SIGKILL reaps the whole tree. win32:
  // groups don't matter — taskkill /T walks parent-child relationships.
  detached: process.platform !== 'win32',
  windowsHide: true,
});
child.stdout?.setEncoding('utf8');
child.stderr?.setEncoding('utf8');
child.stdout?.on('data', (d: string) => {
  stdout += d;
});
child.stderr?.on('data', (d: string) => {
  stderr += d;
});

function killTree(): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // taskkill missing/failed — nothing more a supervisor can do; report anyway.
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL'); // the whole (detached) process group
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

const timer = setTimeout(() => {
  timedOut = true;
  killTree();
  // If a survivor somehow holds the stdio pipes, 'close' may never fire —
  // report the timeout after a short flush grace regardless.
  setTimeout(() => report(null), 2_000);
}, timeoutMs);

child.on('error', (e: Error) => {
  clearTimeout(timer);
  report(null, e.message || String(e));
});
child.on('close', (code: number | null) => {
  clearTimeout(timer);
  report(code);
});
