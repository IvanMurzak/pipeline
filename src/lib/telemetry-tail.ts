// telemetry-tail.ts — the LOCAL-ONLY, no-network journal tail shared by
// `pipeline drive` (ux-v2 `b12`, drive.ts) and `pipeline next`'s own
// step-boundary flush (`b12`, next.ts's `invokeNext`).
//
// WHAT THIS IS NOT: an uploader. `TelemetryOutbox.drainJournal()` (`b9`) only
// moves events from the project journal into the durable outbox queue — it
// makes ZERO network calls. Uploading stays EXCLUSIVELY the detached
// daemon's job: `telemetry-upload.ts`'s own header is explicit that
// `flushOnce()` is "NOT on the run's critical path — not in a hook, not
// inline in `drive`, not in any code a pipeline step awaits... The only
// intended caller of `flushOnce()` is the DETACHED uploader daemon (`b11`)".
// Calling it from here — or from drive.ts or next.ts directly — would
// violate that invariant AND `b12`'s own ≤15 ms run-start/run-exit budget: a
// flush can block for up to a request timeout plus backoff, which a local
// journal drain never does.
//
// WHY A SHARED HELPER: drive.ts (already long-lived, tails after every step
// and at run start/exit) and next.ts's `invokeNext` (the step-boundary flush
// used by BOTH the `pipeline next` CLI — the pipeline-manager-driven path —
// and drive's own in-process loop, which calls `invokeNext` directly per
// step) need the IDENTICAL gate and construction: telemetry sync enabled,
// a CONNECTED project (`.pipeline/cloud.json` present — `03` F7: "no cloud
// account ⇒ the subsystem is ABSENT, not merely inert"), and the outbox's org
// tag drawn from the SAME non-secret source the run link is composed from.
// Neither caller is a hot per-tool-call hook (that constraint applies only to
// `hooks/analytics_relay.ts`), so importing the outbox chain here costs
// nothing neither of them wasn't already about to pay for its own reasons.
//
// COEXISTENCE WITH A CONCURRENTLY-RUNNING DAEMON: `drainJournal()` already
// takes the outbox's own `drain.lock` for its whole read-modify-write cycle
// (`telemetry-outbox.ts`), which is the SAME lock `enqueue`/`quarantine`/
// (as of `b12`) `ack` take — so this tail coexists safely with a daemon
// flushing the SAME project concurrently: whichever side wins the lock runs
// to completion first, the other's operation either waits briefly or is
// deferred (never corrupted, never lost — a deferred drain retries on the
// NEXT tail call; a deferred ack leaves the record queued for the next
// flush, which the server's `(run_id, seq)` dedup makes harmless to repeat).
// See `telemetry-outbox.ts`'s `ack()` for the fix that made this true (before
// `b12` nothing but the single, self-serialized daemon ever called it, so the
// missing lock there was latent).

import { existsSync } from 'node:fs';
import { cloudJsonPath, readCloudBinding, realFs } from './cloud-config';
import { telemetrySyncEnabled, TelemetryOutbox } from './telemetry-outbox';

/**
 * Best-effort, LOCAL-ONLY drain of one project's journal into its outbox.
 *
 * No-ops — touching nothing beyond one `existsSync` — when telemetry sync is
 * disabled or the project has never connected (`03` F7): the "absent, not
 * merely inert" contract every telemetry entry point in this package shares.
 * A malformed or org-less `cloud.json` degrades the same way (nothing to tag
 * records with, so nothing is drained) rather than throwing.
 *
 * NEVER throws (D2) — telemetry can never affect the run that calls it.
 */
export function tailProjectJournal(
  projectRoot: string,
  env: Record<string, string | undefined> = process.env,
): void {
  try {
    if (!telemetrySyncEnabled(env)) return;
    const bindingPath = cloudJsonPath(projectRoot);
    if (!existsSync(bindingPath)) return;
    const binding = readCloudBinding(realFs, bindingPath);
    const org = binding?.org?.trim();
    if (!org) return;
    new TelemetryOutbox({ projectRoot, org, env }).drainJournal();
  } catch {
    /* best-effort — D2: telemetry never affects the run */
  }
}
