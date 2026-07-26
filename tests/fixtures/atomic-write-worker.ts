// atomic-write-worker.ts — spawned as a REAL, separate OS process by
// credential-atomicity-cross-process.test.ts (a5 DoD box 2: "a killed
// process mid-write leaves a valid credential file (previous or new, never
// partial)").
//
// Wraps the real fs so that, INSIDE the rename step of `writeCredentialStore`
// (write-temp-then-rename — cloud-config.ts's `writeFileAtomic`), it first
// touches a "ready" marker file and then busy-waits — giving the PARENT test
// a reliable window to observe "the temp file exists, the rename has not
// happened yet" and deliver a REAL kill (SIGKILL / taskkill /F) exactly
// inside that window, deterministically, rather than hoping a race lands
// right. This targets the SAME renameSync the real code path calls — nothing
// about atomicity itself is faked, only the timing is widened so a test can
// hit it on purpose instead of by luck.
//
// argv: none. Config via env: PIPELINE_CLOUD_HOME, WORKER_READY_MARKER,
// WORKER_DONE_MARKER.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { credentialFilePath, writeCredentialStore, type CloudFs, type HomeContext } from '../../src/lib/cloud-config';

const home = process.env.PIPELINE_CLOUD_HOME!;
const readyMarker = process.env.WORKER_READY_MARKER!;
const doneMarker = process.env.WORKER_DONE_MARKER!;

const delayedFs: CloudFs = {
  existsSync,
  readFileSync: (p, enc) => readFileSync(p, enc),
  writeFileSync: (p, data, options) => writeFileSync(p, data, options),
  mkdirSync: (p, options) => {
    mkdirSync(p, options);
  },
  chmodSync,
  renameSync: (from, to) => {
    // The temp file (write half of write-then-rename) is already fully
    // flushed to disk by the time control reaches here — writeFileAtomic
    // calls writeFileSync + chmodSync BEFORE renameSync. Signal readiness,
    // then stall (synchronously — this whole call chain is deliberately
    // sync, matching production) so the parent has a wide, reliable window
    // to kill this process before the rename below ever runs.
    writeFileSync(readyMarker, 'ready');
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      /* intentional busy-wait — the parent kills us well before this elapses */
    }
    renameSync(from, to);
  },
  unlinkSync,
};

const ctx: HomeContext = { platform: 'linux', env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
const credPath = credentialFilePath(ctx);

writeCredentialStore(delayedFs, credPath, {
  version: 1,
  servers: { 'https://example.test': { access_token: 'NEW_VALUE_should_never_be_observed', token_type: 'bearer' } },
});

// Reached only if the parent did NOT kill us in time — lets the test tell
// "kill missed the window" apart from "kill worked as intended".
writeFileSync(doneMarker, 'done');
