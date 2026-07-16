// Worktree-hook resolution + execution for `isolation: external` runs.
//
// The `pipeline next` COMMAND (commands/next.ts) uses these helpers to execute
// the consumer's convention-path worktree hooks (`worktree-create.*` /
// `worktree-destroy.*` under the plan's `worktree_hook_dir`) IN-PROCESS, so the
// pipeline-manager never actuates `provision-worktree`/`teardown-worktree`
// actions by hand. The state machine (lib/next.ts) stays PURE — all subprocess
// work lives here + in the command shell.
//
// The consumer-facing contract is FROZEN (existing hooks must work unmodified):
//   - inputs arrive as PIPELINE_WT_* environment variables,
//   - stdout is ONE JSON object (diagnostics on stderr),
//   - the create hook is idempotent per PIPELINE_WT_NAME,
//   - the destroy hook soft-fails via {"ok":false,"detail":"…"} + exit 0.
//
// The OPTIONAL, ADDITIVE `worktree-finalize` hook uses the same resolution +
// spawn machinery. It is the consumer's mandatory terminal hook (must return
// {"ok":true} or the run halts); WHAT it does is entirely the consumer's
// business — this module stays generic and only resolves + runs the script.

import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export type HookBase = 'worktree-create' | 'worktree-finalize' | 'worktree-destroy';

/** Deterministic, PLATFORM-AWARE extension preference when several hook
 *  variants coexist: win32 prefers native shells/interpreters (`.ps1`/`.py`/
 *  `.cmd`/`.bat`) before `.sh` (which needs a bash port); POSIX prefers
 *  `.sh`/`.py` before `.ps1` (which needs a PowerShell install). A bare,
 *  extensionless `<base>` file is the last resort (executed directly).
 *  Exported (with an injectable platform) so the ordering is testable purely. */
export function extPreference(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === 'win32'
    ? ['ps1', 'py', 'cmd', 'bat', 'js', 'mjs', 'ts', 'cjs', 'sh', 'exe']
    : ['sh', 'py', 'js', 'mjs', 'ts', 'cjs', 'ps1', 'cmd', 'bat', 'exe'];
}

/** Find `<hookDirAbs>/<base>.<ext>` by the platform-aware extension preference
 *  (then a bare `<base>` with no extension). Returns the absolute path of the
 *  first match, or null when the hook does not exist. */
export function resolveHookScript(hookDirAbs: string, base: HookBase): string | null {
  for (const ext of extPreference()) {
    const candidate = join(hookDirAbs, `${base}.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  const bare = join(hookDirAbs, base);
  return existsSync(bare) ? bare : null;
}

interface Interpreter {
  cmd: string;
  args: string[];
}

/** Cached pwsh-on-PATH probe (once per process). */
let pwshOnPath: boolean | null = null;

/** PowerShell command for `.ps1` hooks: prefer PowerShell 7+ (`pwsh`) when it
 *  is on PATH, else fall back to Windows PowerShell (`powershell`). Failures
 *  stay loud exactly as before — when neither exists, spawning the fallback
 *  surfaces as a spawn error on the hook result. */
function powershellCmd(): string {
  if (pwshOnPath === null) {
    try {
      const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5_000,
      });
      pwshOnPath = r.status === 0;
    } catch {
      pwshOnPath = false;
    }
  }
  return pwshOnPath ? 'pwsh' : 'powershell';
}

/** Map a hook script to the command + argv that runs it, cross-platform:
 *    .py            → python (win32) / python3 (POSIX), resolved via PATH
 *    .sh            → bash
 *    .ps1           → pwsh (when on PATH, else powershell)
 *                       -NoProfile -ExecutionPolicy Bypass -File <s>
 *    .js/.mjs/.ts/.cjs → process.execPath (the running bun/node binary)
 *    .cmd/.bat      → cmd /c <s> (win32 shells)
 *    .exe / none    → executed directly */
export function interpreterFor(scriptAbs: string): Interpreter {
  const ext = extname(scriptAbs).toLowerCase();
  switch (ext) {
    case '.py':
      return { cmd: process.platform === 'win32' ? 'python' : 'python3', args: [scriptAbs] };
    case '.sh':
      return { cmd: 'bash', args: [scriptAbs] };
    case '.ps1':
      return { cmd: powershellCmd(), args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptAbs] };
    case '.js':
    case '.mjs':
    case '.ts':
    case '.cjs':
      return { cmd: process.execPath, args: [scriptAbs] };
    case '.cmd':
    case '.bat':
      return { cmd: 'cmd', args: ['/c', scriptAbs] };
    default:
      // .exe or no extension → run directly.
      return { cmd: scriptAbs, args: [] };
  }
}

export interface HookRunResult {
  /** Process exit code; null when the process never exited cleanly (spawn
   *  error, timeout kill). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the run was killed by the timeout. */
  timedOut: boolean;
  /** Spawn-level error message (interpreter not found, …); absent otherwise. */
  error?: string;
}

/** The supervisor subprocess that owns the child's timeout + tree kill (see
 *  the header comment in hook-runner.ts for the full rationale). */
const HOOK_RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'hook-runner.ts');

/** Shape of the supervisor's stdout envelope. */
interface RunnerEnvelope {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

/** Spawn an arbitrary argv synchronously through the hook-runner.ts SUPERVISOR
 *  subprocess and decode its stdout envelope. Never throws. SINGLE source of
 *  the supervisor spawn — worktree hooks (runHook below) and script steps
 *  (lib/script-step.ts realProcessRunner) both run through it.
 *
 *  The supervisor exists so that a timeout reliably terminates the ENTIRE
 *  child process tree on both platforms (win32: `taskkill /pid <pid> /T /F`;
 *  POSIX: detached process group + SIGKILL) — a SIGTERM-trapping child can
 *  never hang the CLI, and a wrapper-chain child leaves no grandchildren
 *  racing the halt. Callers stay synchronous (invokeNext is a sync API).
 *  Verified under Bun explicitly.
 *
 *  `supervisorLabel` parameterizes only the no-envelope error message
 *  ('hook supervisor' vs 'script supervisor'). */
export function spawnViaHookRunner(
  argv: string[],
  opts: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
    supervisorLabel: string;
  },
): { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string } {
  const r = spawnSync(process.execPath, [HOOK_RUNNER, String(opts.timeoutMs), ...argv], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
    // The outer spawnSync timeout is a SIGKILL safety net for a wedged
    // supervisor only; the supervisor owns the real budget.
    timeout: opts.timeoutMs + 15_000,
    killSignal: 'SIGKILL',
    // The child's stdout/stderr arrive JSON-escaped inside the envelope, so
    // the outer buffer needs headroom over the per-stream caps (the old
    // 16 MiB hook cap / the 10 MB script stdout cap).
    maxBuffer: 48 * 1024 * 1024,
    windowsHide: true,
  });

  const errCode = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (r.error) {
    // The supervisor itself failed to spawn or blew the safety net.
    const timedOut = errCode === 'ETIMEDOUT';
    const out: HookRunResult = { code: null, stdout: '', stderr: r.stderr ?? '', timedOut };
    if (!timedOut) out.error = String(r.error.message ?? r.error);
    return out;
  }

  let envelope: RunnerEnvelope | null = null;
  try {
    const v: unknown = JSON.parse(r.stdout);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) envelope = v as RunnerEnvelope;
  } catch {
    // fall through to the no-envelope error below
  }
  if (!envelope) {
    return {
      code: null,
      stdout: '',
      stderr: r.stderr ?? '',
      timedOut: false,
      error: `${opts.supervisorLabel} produced no result envelope (exit ${r.status})`,
    };
  }

  const out: HookRunResult = {
    code: envelope.code ?? null,
    stdout: envelope.stdout ?? '',
    stderr: envelope.stderr ?? '',
    timedOut: envelope.timedOut === true,
  };
  if (envelope.error && !out.timedOut) out.error = envelope.error;
  return out;
}

/** Run a hook script synchronously with the given PIPELINE_WT_* env overlay
 *  (merged over process.env), cwd, and timeout. Never throws. Execution goes
 *  through the hook-runner.ts supervisor (spawnViaHookRunner above) so a
 *  timeout kills the whole hook process tree. */
export function runHook(
  scriptAbs: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): HookRunResult {
  const { cmd, args } = interpreterFor(scriptAbs);
  return spawnViaHookRunner([cmd, ...args], {
    cwd,
    env: { ...process.env, ...env },
    timeoutMs,
    supervisorLabel: 'hook supervisor',
  });
}

/** Parse the hook's stdout into a plain JSON object. Lenient: first try the
 *  whole trimmed stdout; else scan lines from the END for the last line that
 *  parses to a plain object (consumer hooks are supposed to keep stdout clean,
 *  but a stray log line must not kill the run); else null.
 *
 *  Deliberately NOT unified with lib/script-step.ts parseScriptStdout —
 *  precedence order differs per frozen contract (script: last-line-first;
 *  hook: whole-first); do not merge. */
export function parseHookJson(stdout: string): Record<string, unknown> | null {
  const tryObj = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      return v !== null && typeof v === 'object' && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const whole = tryObj(stdout.trim());
  if (whole) return whole;
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const obj = tryObj(line);
    if (obj) return obj;
  }
  return null;
}

/** Last `n` characters of a trimmed string — stderr tails for halt reasons. */
export function tail(s: string, n = 400): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(t.length - n);
}
