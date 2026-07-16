#!/usr/bin/env bun
// Parallel test runner — shard `bun test` FILES across worker processes.
//
// Why: `bun test` (1.3.x) runs test files sequentially in one process, and
// this repo's suites are dominated by I/O-heavy files (real git sandboxes in
// gc/submodule tests, temp-dir lifecycles) that parallelize cleanly. Bun's
// own `--concurrent` flag is NOT safe here — it interleaves tests inside one
// process, and our files share module-level `let sandbox` state and mutate
// `process.env` in beforeEach. Separate PROCESSES keep every file's isolation
// guarantees (own env, own module state, own tmp dirs) while using the cores.
//
// Usage: bun scripts/parallel-tests.ts [testsDir]
//   testsDir defaults to `tests`; discovery is recursive and matches every
//   name bun's own runner would pick up (*.test.* / *.spec.* / *_test.* /
//   *_spec.* with js/jsx/ts/tsx extensions) so a file `bun test tests/`
//   would run can never be silently skipped.
//   TEST_WORKERS=N overrides the worker count (default: cores-1, max 8).
//
// Serial files: a test file whose first kilobyte contains the `@serial`
// pragma (in a comment) is held OUT of the parallel pool and run
// one-at-a-time after it drains — for timing-sensitive e2e suites (real
// daemon boots with bounded health-waits) that flake under N-way CPU
// contention even though they are state-isolated. The pragma lives IN the
// flaky file, next to the reason, so a rename or a new flaky file can't
// silently desynchronize a flag list kept elsewhere.
//
// Output: each file's bun-test report is printed ATOMICALLY when it finishes
// (interleaving chunks from concurrent runs would be unreadable), followed by
// a one-line rollup. Exit 1 when any file fails.

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus } from 'node:os';

const USAGE = 'usage: bun scripts/parallel-tests.ts [testsDir]';
const argv = process.argv.slice(2);
let testsDirArg = 'tests';
{
  const positionals: string[] = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      console.error(`unknown option '${a}'\n${USAGE}`);
      process.exit(2);
    }
    positionals.push(a);
  }
  if (positionals.length > 1) {
    console.error(`expected at most one testsDir, got: ${positionals.join(' ')}\n${USAGE}`);
    process.exit(2);
  }
  if (positionals.length === 1) testsDirArg = positionals[0];
}

// Match bun's own test-file discovery so `bun run test` can never silently
// skip a file that `bun test tests/` (test:seq) would run.
const TEST_FILE_RE = /[._](test|spec)\.(ts|tsx|js|jsx)$/;

function findTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') out.push(...findTestFiles(p));
    } else if (TEST_FILE_RE.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

// The pragma must appear near the top (a header comment) — only the first
// kilobyte is scanned, so the word appearing deep in a test body is not a
// false positive.
const SERIAL_PRAGMA = '@serial';

const testsDir = resolve(testsDirArg);
const allFiles = findTestFiles(testsDir)
  // Largest files first is a decent proxy for longest-running — starting the
  // slow ones early keeps the tail short.
  .map((p) => ({ p, size: Bun.file(p).size }))
  .sort((a, b) => b.size - a.size)
  .map((x) => x.p);
const serialFiles: string[] = [];
const files: string[] = [];
for (const p of allFiles) {
  let head = '';
  try {
    head = await Bun.file(p).slice(0, 1024).text();
  } catch {
    // unreadable file — let bun test surface the error in the parallel pool
  }
  (head.includes(SERIAL_PRAGMA) ? serialFiles : files).push(p);
}

if (!allFiles.length) {
  console.error(`no test files under ${testsDir}`);
  process.exit(2);
}

const envWorkers = Number(process.env.TEST_WORKERS);
const workers = Math.max(
  1,
  Math.min(
    Number.isFinite(envWorkers) && envWorkers > 0 ? envWorkers : Math.min(cpus().length - 1, 8),
    Math.max(files.length, 1),
  ),
);

const started = Date.now();
const queue = [...files];
const failed: string[] = [];
const timings: Array<{ file: string; secs: number }> = [];

async function runOne(file: string): Promise<void> {
  const t0 = Date.now();
  // --timeout raises bun's 5s per-test DEFAULT (explicit test() timeouts still
  // win): under N-way parallel load a real-git test can take 2-3× its solo
  // time, and a load-induced timeout is a flake, not a finding.
  const proc = Bun.spawn(['bun', 'test', file, '--timeout', '30000'], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // bun test writes its report to stderr; print both, atomically per file.
  process.stdout.write(out + err);
  const rel = file.slice(testsDir.length + 1);
  timings.push({ file: rel, secs: (Date.now() - t0) / 1000 });
  if (code !== 0) failed.push(rel);
}

async function worker(): Promise<void> {
  while (queue.length) {
    await runOne(queue.shift()!);
  }
}

await Promise.all(Array.from({ length: workers }, worker));
// Serial phase: timing-sensitive (@serial) files get the machine to themselves.
for (const file of serialFiles) await runOne(file);

// Slowest files first — the top entry is the wall-clock floor no worker count
// can beat; when one file dominates, split it (see tests/_submodule-world.ts).
timings.sort((a, b) => b.secs - a.secs);
const slowest = timings
  .slice(0, 5)
  .map((t) => `${t.file} ${t.secs.toFixed(1)}s`)
  .join(' · ');
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\nparallel-tests: ${files.length} parallel + ${serialFiles.length} serial files, ${workers} workers, ${secs}s — ${
    failed.length ? `FAILED: ${failed.join(', ')}` : 'all passed'
  }\nslowest: ${slowest}`,
);
process.exit(failed.length ? 1 : 0);
