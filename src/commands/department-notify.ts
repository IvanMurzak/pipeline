// `pipeline department notify [--interval-ms <n>] [--once] [--json]`
//
// The background department-task notifier's CLI entry (department-mesh task
// a1, Q2). Runs the poll loop from ../lib/department-notify.ts, firing a
// best-effort OS-level toast (../lib/os-notify.ts) for every newly-detected
// INPUT_REQUIRED/AUTH_REQUIRED or terminal transition, alongside writing it
// to the durable pending-notification journal that
// hooks/department_notifier_relay.ts drains at the next SessionStart (any
// project — department tasks are org-scoped, not project-scoped).
//
// RENAME NOTE (a11, simplified-onboarding — 08-terminology.md / D10 / D31):
// this file was `commands/mesh.ts` and the command was `pipeline mesh
// notify`. The old surface is KEPT as a hidden, warning alias —
// `commands/mesh.ts` now just delegates here — so existing service
// definitions and scripts written against `pipeline mesh notify` keep
// working; it is deliberately not listed in `cli.ts`'s `--help`.
//
// Normally spawned DETACHED by hooks/department_notifier_relay.ts, not run
// interactively — but every path here also works standalone for `--once`
// smoke-testing (`pipeline department notify --once --json`) and manual
// debugging.
//
// Every side effect is injected (mirrors commands/cloud.ts's CloudDeps
// pattern) so the whole thing is unit-testable with zero real I/O, real
// network, or real OS notifications.

import { homedir } from 'node:os';
import {
  pollLoop,
  pollOnce,
  realDepartmentNotifyFetch,
  notificationTitle,
  notificationBody,
  type FetchLike,
  type DepartmentNotifyDeps,
  type TaskNotification,
} from '../lib/department-notify';
import { realFs, type CloudFs } from '../lib/cloud-config';
import { sendOsNotification, realSpawn, type OsNotifyDeps } from '../lib/os-notify';

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface DepartmentNotifyCliDeps {
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

export const realDepartmentNotifyCliDeps: DepartmentNotifyCliDeps = {
  fetch: realDepartmentNotifyFetch,
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

function departmentNotifyDepsFrom(deps: DepartmentNotifyCliDeps): DepartmentNotifyDeps {
  return { fetch: deps.fetch, fs: deps.fs, now: deps.now, env: deps.env, platform: deps.platform, homedir: deps.homedir };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const USAGE =
  'Usage: pipeline department notify [--interval-ms <n>] [--once] [--json]\n' +
  "  Poll the caller's open department tasks (via the credential stored by\n" +
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
  return `[department] ${notificationTitle(n)} — ${notificationBody(n)}`;
}

// ---------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------

async function emitNotification(deps: DepartmentNotifyCliDeps, n: TaskNotification, json: boolean): Promise<void> {
  sendOsNotification({ platform: deps.platform, spawn: deps.spawn }, notificationTitle(n), notificationBody(n));
  if (json) deps.out(JSON.stringify(n) + '\n');
  else deps.out(formatNotificationLine(n) + '\n');
}

/** The poll-or-loop core, given already-parsed options. Exported so the
 *  deprecated `pipeline mesh notify` alias (`commands/mesh.ts`) can run the
 *  exact same behavior after printing its own warning, rather than
 *  duplicating this logic. */
export async function runNotify(deps: DepartmentNotifyCliDeps, opts: NotifyOptions): Promise<number> {
  const notifyDeps = departmentNotifyDepsFrom(deps);

  if (opts.once) {
    const result = await pollOnce(notifyDeps);
    for (const n of result.notifications) await emitNotification(deps, n, opts.json);
    for (const e of result.errors) deps.err(`pipeline department notify: ${e}\n`);
    if (opts.json) {
      deps.out(
        JSON.stringify({
          servers_polled: result.serversPolled,
          notifications: result.notifications.length,
          errors: result.errors,
        }) + '\n',
      );
    } else if (result.notifications.length === 0) {
      deps.out(`[department] polled ${result.serversPolled} server(s) — nothing new.\n`);
    }
    return 0;
  }

  await pollLoop(notifyDeps, {
    intervalMs: opts.intervalMs,
    sleep: deps.sleep,
    onNotification: (n) => emitNotification(deps, n, opts.json),
    onError: (message) => deps.err(`pipeline department notify: ${message}\n`),
  });
  return 0;
}

// ---------------------------------------------------------------------------
// CLI entry — `pipeline department notify`
// ---------------------------------------------------------------------------

/**
 * Entry for the `notify` verb of `pipeline department` (`commands/
 * department.ts`'s dispatcher already consumed the `notify` word, so `args`
 * here holds only `notify`'s own flags — no leading subcommand to parse).
 */
export async function runDepartmentNotify(
  args: string[],
  deps: DepartmentNotifyCliDeps = realDepartmentNotifyCliDeps,
): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    deps.out(USAGE);
    return 0;
  }
  const parsed = parseNotifyArgs(args);
  if ('error' in parsed) {
    deps.err(`pipeline department notify: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  return runNotify(deps, parsed);
}
