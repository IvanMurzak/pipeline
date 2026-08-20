// stats-atomic-write-worker.ts — spawned as a REAL, separate OS process by
// tests/stats-atomic-write.test.ts (z1: "a process death mid-write cannot
// truncate the user's runs.jsonl").
//
// Runs the ACTUAL `statsEnrichTokens` path against a real runs.jsonl. Its
// `renameSync` is wrapped so that, once the temp file is fully written but
// BEFORE the rename happens, it drops a "ready" marker (whose contents are the
// rename's destination, so the parent can confirm it stalled on the runs.jsonl
// write and not some later one) and then busy-waits — giving the parent a
// wide, reliable window to deliver a REAL kill squarely inside the vulnerable
// window, deterministically, rather than hoping a race lands right by luck.
//
// Only the TIMING is widened. The write, the rename and the file are all the
// real ones; nothing about the atomicity itself is faked.
//
// Same shape, and the same reasoning, as
// tests/fixtures/atomic-write-worker.ts (a5, the credential store).
//
// argv: none. Config via env: RUNS_FILE, STATS_BASE, RUN_ID,
// WORKER_READY_MARKER, WORKER_DONE_MARKER.

import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AtomicFs } from '../../src/lib/atomic-write';
import { statsEnrichTokens } from '../../src/lib/stats';

const runsFile = process.env.RUNS_FILE!;
const base = process.env.STATS_BASE!;
const runId = process.env.RUN_ID!;
const readyMarker = process.env.WORKER_READY_MARKER!;
const doneMarker = process.env.WORKER_DONE_MARKER!;

const stallingFs: AtomicFs = {
  writeFileSync: (path, data, encoding) => writeFileSync(path, data, encoding),
  renameSync: (from, to) => {
    // The temp file is already fully written and closed by the time control
    // reaches here — writeFileAtomicSync calls writeFileSync BEFORE
    // renameSync. Signal readiness (recording WHICH file we are about to
    // replace), then stall synchronously — matching production, which is
    // sync all the way down — so the parent can kill us before the rename.
    writeFileSync(readyMarker, to);
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      /* intentional busy-wait — the parent kills us well before this elapses */
    }
    renameSync(from, to);
  },
  unlinkSync: (path) => unlinkSync(path),
};

statsEnrichTokens(
  base,
  runsFile,
  runId,
  { input: 111, output: 222, cache_read: 333, cache_creation: 444 },
  undefined,
  stallingFs,
);

// Reached only if the parent did NOT kill us in time — lets the test tell
// "the kill missed the window" apart from "the kill worked as intended".
writeFileSync(doneMarker, 'done');
