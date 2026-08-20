// read-handle-holder.ts — spawned as a REAL, separate OS process by
// tests/stats-atomic-write.test.ts.
//
// Opens an ordinary read handle on a file, signals that it holds it, keeps it
// for N ms, then closes and exits. That is all it takes to make a Windows
// rename over that path fail with EPERM (measured, Windows 11 / Bun 1.3.14) —
// no antivirus, no editor, nothing exotic. It exists so the retry budget in
// lib/atomic-write.ts can be proven against a REAL contending process rather
// than only against injected errno values.
//
// argv: <target> <holdMs> <readyMarker>

import { closeSync, openSync, writeFileSync } from 'node:fs';

const target = process.argv[2]!;
const holdMs = Number(process.argv[3]!);
const readyMarker = process.argv[4]!;

const fd = openSync(target, 'r');
writeFileSync(readyMarker, 'held');
// Synchronous hold — the parent must find the handle genuinely open for the
// whole window, not merely scheduled to be.
const until = Date.now() + holdMs;
while (Date.now() < until) {
  /* intentional busy-hold */
}
closeSync(fd);
