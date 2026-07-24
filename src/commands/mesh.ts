// `pipeline mesh notify [--interval-ms <n>] [--once] [--json]`
//
// The background mesh-task notifier's CLI entry (department-mesh task a1,
// Q2). Runs the poll loop from ../lib/mesh-notify.ts, firing a best-effort
// OS-level toast (../lib/os-notify.ts) for every newly-detected
// INPUT_REQUIRED/AUTH_REQUIRED or terminal transition, alongside writing it
// to the durable pending-notification journal that
// hooks/mesh_notifier_relay.ts drains at the next SessionStart (any
// project — mesh tasks are org-scoped, not project-scoped).
//
// Normally spawned DETACHED by hooks/mesh_notifier_relay.ts, not run
// interactively — but every path here also works standalone for `--once`
// smoke-testing (`pipeline mesh notify --once --json`) and manual debugging.
//
// Every side effect is injected (mirrors commands/cloud.ts's CloudDeps
// pattern) so the whole thing is unit-testable with zero real I/O, real
// network, or real OS notifications.

import { homedir } from 'node:os';
import {
  pollLoop,
  pollOnce,
  realMeshFetch,
  notificationTitle,
  notificationBody,
  type FetchLike,
  type MeshNotifyDeps,
  type TaskNotification,
} from '../lib/mesh-notify';
import { realFs, type CloudFs } from '../lib/cloud-config';
import { sendOsNotification, realSpawn, type OsNotifyDeps } from '../lib/os-notify';

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface MeshCliDeps {
  fetch: FetchLike;
  fs: CloudFs;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  env: Record<string, string | undefined>;
  platform: string;
  homedir: string;
  spawn: OsNotifyDeps['spawn'];
  out: (s: string) => void;
  err: (s: string) => void;
}

export const realMeshDeps: MeshCliDeps = {
  fetch: realMeshFetch,
  fs: realFs,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  spawn: realSpawn,
  out: (s) => {
    process.stdout.write(s);
  },
  err: (s) => {
    process.stderr.write(s);
  },
};

function meshNotifyDepsFrom(deps: MeshCliDeps): MeshNotifyDeps {
  return { fetch: deps.fetch, fs: deps.fs, now: deps.now, env: deps.env, platform: deps.platform, homedir: deps.homedir };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const USAGE =
  'Usage: pipeline mesh notify [--interval-ms <n>] [--once] [--json]\n' +
  '  Poll the caller\'s open department-mesh tasks (via the credential stored by\n' +
  "  `pipeline cloud connect`) and surface INPUT_REQUIRED/AUTH_REQUIRED and\n" +
  '  terminal transitions — an OS-level toast plus a durable pending-notification\n' +
  '  journal drained by the plugin\'s SessionStart hook. --once runs a single poll\n' +
  '  cycle and exits (no daemon loop) — useful for smoke-testing a connection.\n' +
  '  Default interval: 60000ms (floor 5000ms). Exit 0 always (--once) or on a\n' +
  '  clean shutdown signal; 2 usage.\n';

export const DEFAULT_INTERVAL_MS = 60_000;
export const MIN_INTERVAL_MS = 5_000;

export interface NotifyOptions {
  once: boolean;
  intervalMs: number;
  json: boolean;
}

export function parseNotifyArgs(args: string[]): NotifyOptions | { error: string } {
  const out: NotifyOptions = { once: false, intervalMs: DEFAULT_INTERVAL_MS, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--once') {
      out.once = true;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--interval-ms' || a.startsWith('--interval-ms=')) {
      let raw: string;
      if (a.startsWith('--interval-ms=')) {
        raw = a.slice('--interval-ms='.length);
      } else {
        const v = args[++i];
        if (v === undefined) return { error: '--interval-ms requires a value' };
        raw = v;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return { error: '--interval-ms must be a positive number' };
      out.intervalMs = Math.max(MIN_INTERVAL_MS, Math.trunc(n));
    } else {
      return { error: `unknown argument '${a}'` };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Human-readable formatting
// ---------------------------------------------------------------------------

function formatNotificationLine(n: TaskNotification): string {
  return `[mesh] ${notificationTitle(n)} — ${notificationBody(n)}`;
}

// ---------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------

async function emitNotification(deps: MeshCliDeps, n: TaskNotification, json: boolean): Promise<void> {
  sendOsNotification({ platform: deps.platform, spawn: deps.spawn }, notificationTitle(n), notificationBody(n));
  if (json) deps.out(JSON.stringify(n) + '\n');
  else deps.out(formatNotificationLine(n) + '\n');
}

async function runNotify(deps: MeshCliDeps, opts: NotifyOptions): Promise<number> {
  const notifyDeps = meshNotifyDepsFrom(deps);

  if (opts.once) {
    const result = await pollOnce(notifyDeps);
    for (const n of result.notifications) await emitNotification(deps, n, opts.json);
    for (const e of result.errors) deps.err(`pipeline mesh notify: ${e}\n`);
    if (opts.json) {
      deps.out(
        JSON.stringify({
          servers_polled: result.serversPolled,
          notifications: result.notifications.length,
          errors: result.errors,
        }) + '\n',
      );
    } else if (result.notifications.length === 0) {
      deps.out(`[mesh] polled ${result.serversPolled} server(s) — nothing new.\n`);
    }
    return 0;
  }

  await pollLoop(notifyDeps, {
    intervalMs: opts.intervalMs,
    sleep: deps.sleep,
    onNotification: (n) => emitNotification(deps, n, opts.json),
    onError: (message) => deps.err(`pipeline mesh notify: ${message}\n`),
  });
  return 0;
}

// ---------------------------------------------------------------------------
// CLI shell
// ---------------------------------------------------------------------------

export async function runMesh(args: string[], deps: MeshCliDeps = realMeshDeps): Promise<number> {
  const sub = args[0];
  if (sub === '--help' || sub === '-h' || sub === undefined) {
    (sub === undefined ? deps.err : deps.out)(USAGE);
    return sub === undefined ? 2 : 0;
  }
  if (sub !== 'notify') {
    deps.err(`pipeline mesh: unknown subcommand '${sub}'\n${USAGE}`);
    return 2;
  }
  const parsed = parseNotifyArgs(args.slice(1));
  if ('error' in parsed) {
    deps.err(`pipeline mesh notify: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  return runNotify(deps, parsed);
}
