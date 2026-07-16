// `pipeline ui [--open] [--json]`
//
// Thin launcher for the Pipeline UI dashboard daemon. It:
//   1. Detects a running daemon (~/.claude/pipeline-ui/daemon.lock + a live pid),
//   2. Spawns the supervisor detached if none is up (the supervisor owns the
//      worker + crash recovery + version handoffs — we do NOT touch it),
//   3. Registers the current project (POST /api/register-cwd) when the cwd is
//      inside a project that uses the pipeline plugin,
//   4. Prints the dashboard URL (and optionally opens a browser).
//
// IMPORTANT: this is ONLY a launcher. The daemon's single-instance bind,
// version-reconcile, supervisor handoff, and liveness machinery are load-bearing
// and live in apps/pipeline-ui/{supervisor,server}.ts — this command must not
// duplicate or disturb them. It just starts the supervisor (the same script the
// SessionStart hook launches) and points the user at the URL. The daemon is a
// Bun process, so `pipeline ui` requires Bun even when the CLI itself was bundled
// for Node.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

export interface UiArgs {
  open: boolean;
  json: boolean;
  restart: boolean;
}

export interface DaemonLock {
  pid: number;
  port: number;
  host: string;
  plugin_root?: string;
  supervisor_pid?: number;
}

/** True when the UI server system is enabled via PIPELINE_UI_ENABLED. The UI is
 *  OFF BY DEFAULT (the same master switch the hooks honor); set the var to any
 *  non-empty, non-falsy value (anything other than 0/false/no/off) to opt in. */
export function uiEnabled(): boolean {
  const v = (process.env.PIPELINE_UI_ENABLED ?? '').trim().toLowerCase();
  if (v === '') return false;
  return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

export function parseUiArgs(args: string[]): UiArgs {
  const out: UiArgs = { open: false, json: false, restart: false };
  for (const a of args) {
    if (a === '--open') out.open = true;
    else if (a === '--no-open') out.open = false;
    else if (a === '--json') out.json = true;
    else if (a === '--restart') out.restart = true;
  }
  return out;
}

/** Build the dashboard URL from a daemon lock. */
export function daemonUrl(lock: { host?: string; port: number }): string {
  const host = lock.host || '127.0.0.1';
  return `http://${host}:${lock.port}/`;
}

/** Per-user daemon bookkeeping dir (~/.claude/pipeline-ui). Reads env first so
 *  tests can redirect the home dir, matching apps/pipeline-cli/src/lib/event.ts. */
function userHomeRuntime(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  return join(home, '.claude', 'pipeline-ui');
}

function lockPath(): string {
  return join(userHomeRuntime(), 'daemon.lock');
}

/**
 * Resolve the absolute path to apps/pipeline-ui/supervisor.ts.
 *   1. ${CLAUDE_PLUGIN_ROOT}/apps/pipeline-ui/supervisor.ts when the env var is set
 *      (the normal plugin-install case).
 *   2. Otherwise walk up from this module's dir looking for
 *      apps/pipeline-ui/supervisor.ts (the embed-in-another-project / source case).
 * Returns null when neither resolves to an existing file.
 *
 * Pure (takes env + start dir) so it is unit-testable without a real install.
 */
export function resolveSupervisorScript(
  pluginRootEnv: string | undefined,
  startDir: string,
): string | null {
  const rel = join('apps', 'pipeline-ui', 'supervisor.ts');
  if (pluginRootEnv) {
    const candidate = join(pluginRootEnv, rel);
    if (existsSync(candidate)) return candidate;
  }
  // Walk up from startDir (…/apps/pipeline-cli/src/commands) to the plugin root.
  let cur = resolve(startDir);
  for (let i = 0; i < 16; i++) {
    const candidate = join(cur, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/** True when `.claude/pipeline` exists at `start` or any ancestor — i.e. the cwd
 *  is inside a project that uses the pipeline plugin. */
export function hasPipelineDir(start: string): boolean {
  let cur = resolve(start);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, '.claude', 'pipeline'))) return true;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

function readLock(): DaemonLock | null {
  const p = lockPath();
  if (!existsSync(p)) return null;
  try {
    const txt = readFileSync(p, 'utf-8').trim();
    if (!txt) return null;
    return JSON.parse(txt) as DaemonLock;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn the supervisor detached, mirroring hooks/pipeline_ui_relay.ts:spawnDaemon.
 *  Uses a Bun binary (process.execPath when we're running under Bun, else `bun`
 *  from PATH) since the daemon is TypeScript and requires Bun. */
function spawnSupervisor(script: string): void {
  const home = userHomeRuntime();
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    /* ignore */
  }
  const stdoutLog = join(home, 'daemon.stdout.log');
  const stderrLog = join(home, 'daemon.stderr.log');
  try {
    writeFileSync(stdoutLog, '');
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(stderrLog, '');
  } catch {
    /* ignore */
  }
  let outFd: number | null = null;
  let errFd: number | null = null;
  try {
    outFd = openSync(stdoutLog, 'a');
  } catch {
    /* ignore */
  }
  try {
    errFd = openSync(stderrLog, 'a');
  } catch {
    /* ignore */
  }
  // Under Bun, process.execPath IS the bun binary — use it so the detached child
  // doesn't depend on `bun` being on PATH (matches the SessionStart hook). When
  // the CLI was bundled for Node, fall back to a `bun` on PATH.
  const runner = (process as { versions?: { bun?: string } }).versions?.bun
    ? process.execPath
    : 'bun';
  try {
    const child = spawn(runner, [script], {
      detached: true,
      stdio: ['ignore', outFd ?? 'ignore', errFd ?? 'ignore'],
      env: { ...process.env },
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* the wait loop below will report the failure */
  }
  if (outFd !== null) {
    try {
      closeSync(outFd);
    } catch {
      /* ignore */
    }
  }
  if (errFd !== null) {
    try {
      closeSync(errFd);
    } catch {
      /* ignore */
    }
  }
}

/** Wait up to maxMs for a lock with a live pid to appear. */
async function waitForDaemon(maxMs = 6000): Promise<DaemonLock | null> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const lock = readLock();
    if (lock && isProcessAlive(lock.pid)) return lock;
    await sleep(100);
  }
  return null;
}

async function healthOk(lock: DaemonLock): Promise<boolean> {
  try {
    const res = await fetch(daemonUrl(lock) + 'api/health', {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** POST /api/restart — the daemon hands off to the newest installed plugin
 *  version when one is pending, else re-execs from its current root. */
async function requestRestart(lock: DaemonLock): Promise<boolean> {
  try {
    const res = await fetch(daemonUrl(lock) + 'api/restart', {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Wait for a healthy daemon whose pid differs from `oldPid` — i.e. the
 *  successor after a handoff (which reclaims the same port, so open tabs
 *  reconnect; only the pid changes). */
async function waitForSuccessor(oldPid: number, maxMs = 15000): Promise<DaemonLock | null> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const lock = readLock();
    if (lock && lock.pid !== oldPid && isProcessAlive(lock.pid) && (await healthOk(lock))) {
      return lock;
    }
    await sleep(200);
  }
  return null;
}

async function registerCwd(lock: DaemonLock, cwd: string): Promise<boolean> {
  try {
    const res = await fetch(daemonUrl(lock) + 'api/register-cwd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Best-effort: open `url` in the default browser. Never throws. */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      // `start` is a cmd builtin; the empty title arg avoids it eating the URL.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, windowsHide: true }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true }).unref();
    }
  } catch {
    /* ignore — the URL is printed regardless */
  }
}

export async function runUi(args: string[]): Promise<number> {
  const opts = parseUiArgs(args);

  // Master switch: the UI server system is OFF BY DEFAULT (mirrors the hooks,
  // which no-op unless opted in). Refuse to spawn the daemon unless
  // PIPELINE_UI_ENABLED is set — and tell the user exactly how to turn it on,
  // since an empty dashboard (daemon up but hooks disabled) would be useless.
  // Exit 0 so callers/scripts aren't broken.
  if (!uiEnabled()) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ enabled: false }) + '\n');
    } else {
      process.stderr.write(
        'pipeline ui: the dashboard is disabled by default.\n' +
          '  Enable it by setting  PIPELINE_UI_ENABLED=1  (e.g. in .claude/settings.json "env",\n' +
          '  or in the shell before launching Claude Code), then re-run.\n' +
          '  Tip: `pipeline logs -f` tails events in the terminal with no daemon.\n',
      );
    }
    return 0;
  }

  // 1. Detect a running daemon. `started` (did we spawn this time) is just !alive.
  let lock = readLock();
  const alive = Boolean(lock && isProcessAlive(lock.pid) && (await healthOk(lock)));

  // 1b. --restart: ask the live daemon to hand off (to the newest installed
  // plugin version when one is pending, else to itself) and wait for the
  // successor. With no live daemon a restart degenerates to a normal start.
  let restarted = false;
  if (opts.restart && alive && lock) {
    const oldPid = lock.pid;
    if (!(await requestRestart(lock))) {
      process.stderr.write('pipeline ui: the daemon rejected POST /api/restart.\n');
      return 1;
    }
    const successor = await waitForSuccessor(oldPid);
    if (!successor) {
      process.stderr.write(
        'pipeline ui: no healthy daemon came back within 15s of the restart; ' +
          'see ~/.claude/pipeline-ui/daemon.stderr.log.\n',
      );
      return 1;
    }
    lock = successor;
    restarted = true;
  }

  // 2. Start the supervisor if none is up.
  if (!alive) {
    const script = resolveSupervisorScript(process.env.CLAUDE_PLUGIN_ROOT, import.meta.dir);
    if (!script) {
      process.stderr.write(
        'pipeline ui: could not locate apps/pipeline-ui/supervisor.ts ' +
          '(set CLAUDE_PLUGIN_ROOT or run from inside the plugin).\n',
      );
      return 1;
    }
    spawnSupervisor(script);
    lock = await waitForDaemon();
    if (!lock) {
      process.stderr.write(
        'pipeline ui: the dashboard daemon did not start within 6s. ' +
          'The UI requires Bun (https://bun.sh); see ~/.claude/pipeline-ui/daemon.stderr.log.\n',
      );
      return 1;
    }
  }

  // 3. Register the current project (best-effort) when it uses the pipeline plugin.
  const cwd = process.cwd();
  const inPipelineProject = hasPipelineDir(cwd);
  let registered = false;
  if (lock && inPipelineProject) {
    registered = await registerCwd(lock, cwd);
  }

  // 4. Report.
  const url = daemonUrl(lock!);
  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { url, host: lock!.host || '127.0.0.1', port: lock!.port, pid: lock!.pid, started: !alive, restarted, registered },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(`▶ Pipeline UI${restarted ? ' (restarted)' : ''}:  ${url}\n`);
    if (!inPipelineProject) {
      process.stdout.write(
        '  (this project has no .claude/pipeline yet — nothing will appear until you run /pipeline:design or /pipeline:run)\n',
      );
    }
  }

  if (opts.open) openBrowser(url);
  return 0;
}
