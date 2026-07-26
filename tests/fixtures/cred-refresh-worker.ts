// cred-refresh-worker.ts — spawned as a REAL, separate OS process by
// credential-refresh-cross-process.test.ts (a5 DoD box 1: "two processes
// refreshing concurrently perform exactly one refresh; the other observes
// the result. Test with real processes, not mocks.").
//
// No real network involved, and deliberately NOT a real Bun.serve() loopback
// double (that pattern proved unreliable — 300s+ then failure — for a4's
// cross-process test in this same sandbox). Instead, `ensureFreshCredential`'s
// injected `fetch` is replaced with a local function that appends a marker
// line to a file whose path is passed via env EVERY time it is actually
// invoked. That log file is the one channel that can prove "how many times
// across BOTH real processes was the refresh grant really called" — there is
// no shared memory between two OS processes, so an in-memory counter in
// either process could never answer that question; a shared file can.
//
// Each invocation also mints a RANDOM token pair (not a fixed constant), so
// if single-flight were broken and both processes called the fake refresh,
// their two outputs would ALSO disagree — a second, independent signal of
// the same bug, not just the log line count.
//
// argv: none. Config entirely via env — PIPELINE_CLOUD_HOME already resolves
// the credential/lock file paths exactly the way production does.

import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureFreshCredential, type RefreshDeps, type HttpResponse } from '../../src/lib/credential-refresh';
import { realFs } from '../../src/lib/cloud-config';

const server = process.env.WORKER_SERVER!;
const callsLog = process.env.WORKER_CALLS_LOG!;
const home = process.env.PIPELINE_CLOUD_HOME!;
const delayMs = Number(process.env.WORKER_DELAY_MS ?? '150');

function reply(status: number, body: unknown): HttpResponse {
  return { status, json: async () => body };
}

const deps: RefreshDeps = {
  fetch: async (url) => {
    // Real cross-process evidence: one line per ACTUAL invocation, across
    // however many processes call this file.
    appendFileSync(callsLog, `${process.pid} ${url}\n`);
    // Widens the race window so both processes are genuinely contending for
    // the lock, not accidentally serialized by process-startup skew.
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const nonce = randomUUID().slice(0, 8);
    return reply(200, {
      access_token: `at-new-${nonce}`,
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: `rt-new-${nonce}`,
    });
  },
  fs: realFs,
  now: () => Date.now(),
  platform: 'linux', // Windows ACL protection is proven separately (credential-protect.test.ts) — kept out of this timing-sensitive race
  env: { PIPELINE_CLOUD_HOME: home },
  homedir: home,
};

const cred = await ensureFreshCredential(deps, server);
process.stdout.write(JSON.stringify({ access_token: cred.access_token, refresh_token: cred.refresh_token }));
process.exit(0);
