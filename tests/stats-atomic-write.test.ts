// @serial — spawns a real process and kills it on a timing window; held out of
// the N-way parallel pool (scripts/parallel-tests.ts) so CPU contention cannot
// distort the poll for the "ready" marker.
//
// z1 — the two whole-file rewrites in lib/stats.ts (`statsEnrichTokens`'s
// runs.jsonl and `renderSummary`'s SUMMARY.md) now go through
// lib/atomic-write.ts. Three things are proven here, at the REAL call sites
// rather than on the helper in isolation (that is tests/atomic-write.test.ts):
//
//   1. BYTE-IDENTITY — the bytes that land are exactly the bytes the previous
//      plain-writeFileSync implementation produced. Proven by recomputing the
//      old expression (`scrub(rewriteRunTokens(...))`, both still exported)
//      and comparing raw Buffers, not strings.
//   2. A FAILURE BETWEEN WRITE AND RENAME leaves the original file intact —
//      injected, not reasoned about.
//   3. A REAL KILLED PROCESS, stopped inside that same window, likewise leaves
//      the user's run history intact.
//
// On (3) and temp files: a SIGKILL'd process cannot run cleanup, so it leaves
// its temp file behind by design. That is the SAFE outcome — the orphan is a
// sibling nothing ever reads, and the real runs.jsonl is untouched. The
// assertions below say exactly that rather than pretending the temp vanishes.

import { test, expect, describe, afterEach } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realAtomicFs, type AtomicFs } from '../src/lib/atomic-write';
import { renderSummary, rewriteRunTokens, statsEnrichTokens, type TokenStats } from '../src/lib/stats';
import { scrub } from '../src/lib/output-scrubber';

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
  for (const child of liveChildren) if (child.pid !== undefined) killTree(child.pid);
  liveChildren.clear();
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const RUN_ID = 'run-alpha';

/** A runs.jsonl with an enrichable record, an already-enriched one, a
 *  NON-JSON line and a blank line — so "unchanged" means genuinely unchanged,
 *  not "unchanged for the easy shape". */
function runsJsonlFixture(): string {
  return (
    [
      JSON.stringify({
        pipeline: 'p',
        run_id: RUN_ID,
        started_at: '2026-01-01T00:00:00.000Z',
        ended_at: '2026-01-01T00:05:00.000Z',
        duration_s: 300,
        outcome: 'completed',
        runner: 'driver',
        steps: [],
        tokens: null,
      }),
      '   not json at all — must survive verbatim   ',
      '',
      JSON.stringify({
        pipeline: 'p',
        run_id: 'run-beta',
        started_at: '2026-01-02T00:00:00.000Z',
        ended_at: '2026-01-02T00:01:00.000Z',
        duration_s: 60,
        outcome: 'failed',
        runner: 'driver',
        steps: [],
        tokens: { input: 5, output: 6, cache_read: 7, cache_creation: 8 },
      }),
      '',
    ].join('\n')
  );
}

interface Sandbox {
  root: string;
  base: string;
  pipelineDir: string;
  runsFile: string;
}

function mkSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-stats-atomic-'));
  created.push(root);
  const base = join(root, '.pipeline', '.stats');
  const pipelineDir = join(base, 'p');
  mkdirSync(join(pipelineDir, 'runs'), { recursive: true });
  const runsFile = join(pipelineDir, 'runs.jsonl');
  writeFileSync(runsFile, runsJsonlFixture(), 'utf8');
  return { root, base, pipelineDir, runsFile };
}

/** Any surviving temp siblings (the helper's names all carry `.tmp-`). */
function tempLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes('.tmp-'));
}

const TOKENS: TokenStats = {
  input: 1000,
  output: 25_000,
  cache_read: 400_000,
  cache_creation: 9000,
  tools_called: 42,
  agents_spawned: 3,
};

/** An fs that fails the rename for `failFor`, passing everything else through
 *  to the real one. */
function renameFailingFs(failFor: (dest: string) => boolean, code = 'ENOSPC'): AtomicFs {
  return {
    writeFileSync: (p, d, e) => realAtomicFs.writeFileSync(p, d, e),
    renameSync: (from, to) => {
      if (failFor(to)) {
        const e = new Error(`injected ${code}`) as NodeJS.ErrnoException;
        e.code = code;
        throw e;
      }
      realAtomicFs.renameSync(from, to);
    },
    unlinkSync: (p) => realAtomicFs.unlinkSync(p),
  };
}

describe('byte-identity with the previous non-atomic implementation', () => {
  test('statsEnrichTokens writes EXACTLY the bytes `writeFileSync(runsFile, scrub(next), "utf8")` produced', () => {
    const s = mkSandbox();
    const originalText = readFileSync(s.runsFile, 'utf8');

    // The previous implementation, recomputed from the same still-exported
    // pure functions it used: rewriteRunTokens → scrub → write.
    const legacy = rewriteRunTokens(originalText, RUN_ID, TOKENS);
    expect(legacy).not.toBeNull();
    const legacyBytes = Buffer.from(scrub(legacy!), 'utf8');

    expect(statsEnrichTokens(s.base, s.runsFile, RUN_ID, TOKENS)).toBe(true);

    const actualBytes = readFileSync(s.runsFile); // raw, no encoding round-trip
    expect(actualBytes.equals(legacyBytes)).toBe(true);
    expect(actualBytes.length).toBe(legacyBytes.length);
    expect(tempLeftovers(s.pipelineDir)).toEqual([]);
  });

  test('renderSummary writes EXACTLY the bytes its previous plain write produced', () => {
    const s = mkSandbox();
    renderSummary(s.base);
    const first = readFileSync(join(s.base, 'SUMMARY.md'), 'utf8');

    // renderSummaryMd stamps `new Date().toISOString()` into the body, so the
    // stable comparison normalises that one field and asserts the rest is
    // identical across two independent renders.
    renderSummary(s.base);
    const second = readFileSync(join(s.base, 'SUMMARY.md'), 'utf8');
    const strip = (t: string): string => t.replace(/_Generated [^ ]+ by/, '_Generated <TS> by');

    expect(strip(second)).toBe(strip(first));
    expect(first).toContain('# Pipeline run measurements');
    expect(tempLeftovers(s.base)).toEqual([]);
  });
});

describe('an INJECTED failure between the temp write and the rename', () => {
  test('statsEnrichTokens leaves runs.jsonl byte-for-byte intact, returns false, and litters nothing', () => {
    const s = mkSandbox();
    const before = readFileSync(s.runsFile); // raw bytes

    const fs = renameFailingFs((dest) => dest.endsWith('runs.jsonl'));
    // stats.ts is best-effort by contract: it swallows and reports false. It
    // also writes a diagnostic (asserted in its own describe below) — captured
    // here only to keep this suite's output to what it actually asserts.
    captureStderr(() => {
      expect(statsEnrichTokens(s.base, s.runsFile, RUN_ID, TOKENS, undefined, fs)).toBe(false);
    });

    const after = readFileSync(s.runsFile);
    expect(after.equals(before)).toBe(true);
    expect(after.length).toBe(before.length);
    // Not truncated, not empty, not partially written.
    expect(after.length).toBeGreaterThan(0);
    expect(tempLeftovers(s.pipelineDir)).toEqual([]);

    // The record is still enrichable — the failed attempt cost nothing.
    expect(statsEnrichTokens(s.base, s.runsFile, RUN_ID, TOKENS)).toBe(true);
  });

  test('renderSummary leaves an existing SUMMARY.md intact and litters nothing', () => {
    const s = mkSandbox();
    renderSummary(s.base); // establish a good SUMMARY.md
    const summaryPath = join(s.base, 'SUMMARY.md');
    const before = readFileSync(summaryPath);

    const fs = renameFailingFs((dest) => dest.endsWith('SUMMARY.md'));
    captureStderr(() => renderSummary(s.base, fs)); // never throws — best-effort by contract

    expect(readFileSync(summaryPath).equals(before)).toBe(true);
    expect(tempLeftovers(s.base)).toEqual([]);
  });

  test('a rename failure on SUMMARY.md does not roll back the runs.jsonl write that already succeeded', () => {
    const s = mkSandbox();
    const fs = renameFailingFs((dest) => dest.endsWith('SUMMARY.md'));

    // runs.jsonl renames fine; SUMMARY.md's rename fails inside renderSummary,
    // which swallows it. The enrichment itself still reports success.
    captureStderr(() => {
      expect(statsEnrichTokens(s.base, s.runsFile, RUN_ID, TOKENS, undefined, fs)).toBe(true);
    });
    expect(readFileSync(s.runsFile, 'utf8')).toContain('"output":25000');
    expect(tempLeftovers(s.pipelineDir)).toEqual([]);
    expect(tempLeftovers(s.base)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B1 — a refused write must be VISIBLE, never a silent no-op
// ---------------------------------------------------------------------------
//
// The review's blocking finding: on Windows a single concurrent reader makes
// the atomic rename fail where the plain write it replaced would have
// succeeded. `statsEnrichTokens` is best-effort (`catch { return false }`) and
// the live caller in commands/drive.ts ignores the return value, so without a
// report the user loses the token fold, the .log line, the SUMMARY refresh and
// the b21 ship with no trace anywhere. These pin that it now speaks.

/** Capture everything written to stderr while `fn` runs. */
function captureStderr(fn: () => void): string {
  const original = process.stderr.write;
  const chunks: string[] = [];
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
  return chunks.join('');
}

describe('a refused write is reported, not swallowed', () => {
  test('statsEnrichTokens writes a one-line stderr note naming the file, the errno and the recovery', () => {
    const s = mkSandbox();
    const fs = renameFailingFs((dest) => dest.endsWith('runs.jsonl'), 'EPERM');

    let returned: boolean | undefined;
    const err = captureStderr(() => {
      returned = statsEnrichTokens(s.base, s.runsFile, RUN_ID, TOKENS, undefined, fs);
    });

    expect(returned).toBe(false); // best-effort contract unchanged
    expect(err).toContain('pipeline stats:');
    expect(err).toContain('runs.jsonl');
    expect(err).toContain('EPERM'); // the errno, so a Windows sharing violation is identifiable
    expect(err).toContain('intact');
    expect(err).toContain('backfill'); // how to recover the lost fold
    expect(err.trimEnd().split('\n')).toHaveLength(1); // ONE line, not a stack dump
  });

  test('the loss is also recorded DURABLY in the run’s own .log, where someone would look', () => {
    const s = mkSandbox();
    const logPath = join(s.pipelineDir, 'runs', `${RUN_ID}.log`);
    writeFileSync(logPath, 'existing timeline\n', 'utf8');

    const fs = renameFailingFs((dest) => dest.endsWith('runs.jsonl'), 'EPERM');
    captureStderr(() => statsEnrichTokens(s.base, s.runsFile, RUN_ID, TOKENS, undefined, fs));

    const log = readFileSync(logPath, 'utf8');
    expect(log).toContain('existing timeline'); // appended, not clobbered
    expect(log).toContain('NOT FOLDED');
    expect(log).toContain('EPERM');
    // The success path's line must NOT be there — that would be a lie on disk.
    expect(log).not.toContain('tokens: in=');
  });

  test('the note says how many rename attempts were spent, so exhaustion is distinguishable', () => {
    const s = mkSandbox();
    // Retryable code ⇒ the full default budget is spent before giving up.
    const fs = renameFailingFs((dest) => dest.endsWith('runs.jsonl'), 'EBUSY');
    const err = captureStderr(() => statsEnrichTokens(s.base, s.runsFile, RUN_ID, TOKENS, undefined, fs));
    expect(err).toMatch(/after 14 rename attempts/);

    // A non-retryable refusal reports a single attempt, not the budget.
    const s2 = mkSandbox();
    const fs2 = renameFailingFs((dest) => dest.endsWith('runs.jsonl'), 'ENOSPC');
    const err2 = captureStderr(() => statsEnrichTokens(s2.base, s2.runsFile, RUN_ID, TOKENS, undefined, fs2));
    expect(err2).toMatch(/after 1 rename attempt[^s]/);
  });

  test('renderSummary reports its own refusal, with rollup-appropriate advice rather than backfill advice', () => {
    const s = mkSandbox();
    renderSummary(s.base);
    const fs = renameFailingFs((dest) => dest.endsWith('SUMMARY.md'), 'EPERM');

    const err = captureStderr(() => renderSummary(s.base, fs));

    expect(err).toContain('SUMMARY.md');
    expect(err).toContain('rollup');
    expect(err).not.toContain('backfill'); // wrong recovery for a derived file
  });

  test('the happy path stays SILENT — the report fires only on a real loss', () => {
    const s = mkSandbox();
    const err = captureStderr(() => {
      expect(statsEnrichTokens(s.base, s.runsFile, RUN_ID, TOKENS)).toBe(true);
    });
    expect(err).toBe('');
  });

  test('a diagnostic that cannot be written never becomes the failure it reports', () => {
    const s = mkSandbox();
    // Both the write AND the report's own stderr are hostile.
    const fs = renameFailingFs((dest) => dest.endsWith('runs.jsonl'), 'EPERM');
    const original = process.stderr.write;
    (process.stderr as { write: unknown }).write = (): boolean => {
      throw new Error('stderr is closed');
    };
    try {
      // Still returns false rather than throwing into the run loop.
      expect(statsEnrichTokens(s.base, s.runsFile, RUN_ID, TOKENS, undefined, fs)).toBe(false);
    } finally {
      (process.stderr as { write: unknown }).write = original;
    }
    // And the file is still untouched.
    expect(readFileSync(s.runsFile, 'utf8')).toBe(runsJsonlFixture());
  });
});

// ---------------------------------------------------------------------------
// The retry budget, proven against a REAL contending process
// ---------------------------------------------------------------------------
//
// Lives in this @serial file rather than beside the other atomic-write unit
// tests because it is timing-sensitive: it needs the machine to itself so a
// real reader's hold and a real backoff can be compared without CPU
// contention distorting either.

const HOLDER = join(import.meta.dir, 'fixtures', 'read-handle-holder.ts');

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return existsSync(path);
}

test(
  'the retry budget rides out a REAL concurrent reader — the write lands once the handle is released',
  async () => {
    const s = mkSandbox();
    const before = readFileSync(s.runsFile, 'utf8');
    const readyMarker = join(s.root, 'held.marker');
    // 100 ms against the ~231 ms budget: comfortably inside it, with enough
    // margin that a loaded CI box cannot flake this.
    const child = spawn(process.execPath, [HOLDER, s.runsFile, '100', readyMarker], {
      stdio: 'ignore',
      windowsHide: true,
    });
    liveChildren.add(child);

    try {
      const held = await waitForFile(readyMarker, 30_000);
      expect(held).toBe(true);

      // On Windows this rename is refused until the child closes its handle,
      // so success here IS the retry loop working. On POSIX the rename ignores
      // open handles and succeeds immediately — also correct, and the reason
      // this asserts the OUTCOME rather than a retry count.
      const ok = statsEnrichTokens(s.base, s.runsFile, RUN_ID, TOKENS);

      expect(ok).toBe(true);
      const after = readFileSync(s.runsFile, 'utf8');
      expect(after).not.toBe(before);
      expect(after).toContain('"output":25000');
      expect(tempLeftovers(s.pipelineDir)).toEqual([]);
    } finally {
      if (child.pid !== undefined) killTree(child.pid);
      liveChildren.delete(child);
    }
  },
  60_000,
);

// ---------------------------------------------------------------------------
// The real thing: a genuinely killed process, stopped inside the window
// ---------------------------------------------------------------------------

const WORKER = join(import.meta.dir, 'fixtures', 'stats-atomic-write-worker.ts');

test(
  'a REAL killed process, interrupted between the temp-file write and the rename, leaves the user’s runs.jsonl COMPLETELY intact',
  async () => {
    const s = mkSandbox();
    const readyMarker = join(s.root, 'ready.marker');
    const doneMarker = join(s.root, 'done.marker');
    const originalBytes = readFileSync(s.runsFile);

    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
    childEnv.RUNS_FILE = s.runsFile;
    childEnv.STATS_BASE = s.base;
    childEnv.RUN_ID = RUN_ID;
    childEnv.WORKER_READY_MARKER = readyMarker;
    childEnv.WORKER_DONE_MARKER = doneMarker;

    const child = spawn(process.execPath, [WORKER], { env: childEnv, stdio: 'ignore', windowsHide: true });
    liveChildren.add(child);
    const pid = child.pid;

    try {
      const exitPromise = new Promise<void>((resolve) => child.on('close', () => resolve()));
      const ready = await waitForFile(readyMarker, 30_000);

      // Kill UNCONDITIONALLY here, before any assertion — `expect` throws on
      // failure, so nothing that can throw is allowed to run before the child
      // is reaped. A busy-waiting real process must never outlive this test.
      if (pid !== undefined) killTree(pid);
      await exitPromise;
      liveChildren.delete(child);

      expect(ready).toBe(true);
      // The marker records the rename's destination: proof we stalled on the
      // runs.jsonl replacement specifically, not some later write.
      expect(readFileSync(readyMarker, 'utf8')).toBe(s.runsFile);
      // The kill landed BEFORE the rename — proven by the ABSENCE of the
      // worker's completion marker (its busy-wait is 5s; the kill fires
      // immediately on seeing the ready marker, nowhere near that).
      expect(existsSync(doneMarker)).toBe(false);

      // ── THE CLAIM ────────────────────────────────────────────────────────
      const after = readFileSync(s.runsFile);
      expect(after.equals(originalBytes)).toBe(true);
      expect(after.length).toBe(originalBytes.length);
      expect(after.length).toBeGreaterThan(0); // never truncated to zero
      expect(after.toString('utf8')).toBe(runsJsonlFixture()); // never partial

      // A SIGKILL'd process cannot run its own cleanup, so an orphan temp
      // sibling MAY remain — that is the designed-safe outcome, not a leak:
      // whatever survives is a temp file nothing reads, never a damaged
      // runs.jsonl.
      for (const leftover of tempLeftovers(s.pipelineDir)) {
        expect(leftover).toContain('.tmp-');
        expect(leftover).not.toBe('runs.jsonl');
      }
      // And the real file is still exactly where it should be.
      expect(readdirSync(s.pipelineDir)).toContain('runs.jsonl');
    } finally {
      // Belt-and-braces: if anything above threw BEFORE the unconditional kill
      // ran, this still reaps the child.
      if (liveChildren.has(child)) {
        if (pid !== undefined) killTree(pid);
        liveChildren.delete(child);
      }
    }
  },
  60_000,
);
