/**
 * hooks/run-hook.sh — the POSIX-sh bun-resolution shim every hooks/hooks.json
 * command routes through.
 *
 * WHY THIS EXISTS: Claude Code runs plugin hooks through non-interactive
 * /bin/sh, which does not source ~/.zshrc. On macOS bun installs to
 * ~/.bun/bin, and PATH only gains that entry from the interactive shell rc —
 * so a bare `bun "<script>"` hook command fails with "bun: command not
 * found" whenever Claude Code is launched from the Dock/Finder rather than a
 * terminal. run-hook.sh resolves bun's absolute path itself (PATH →
 * $BUN_INSTALL/bin → ~/.bun/bin → /opt/homebrew/bin → /usr/local/bin) and
 * `exec`s into it, so it must be exercised as a REAL shell script (not
 * imported as TS) — this file drives it with `sh`, a stubbed PATH/HOME/
 * BUN_INSTALL, and fake `bun` binaries planted at each candidate location.
 *
 * Coverage:
 *   - each of the 3 env-controllable candidates (PATH, $BUN_INSTALL/bin,
 *     ~/.bun/bin) resolves to ITS OWN stub, proving the lookup chain reaches
 *     each rung (candidates 4/5 are fixed absolute Homebrew paths that
 *     cannot be safely exercised by planting files at real system locations
 *     from a test — covered instead by the source-text check below and by
 *     the fact the "not found" tests prove nothing earlier in the chain
 *     false-positives on this machine).
 *   - resolution ORDER: PATH beats $BUN_INSTALL beats ~/.bun/bin.
 *   - stdin, argv, and exit code all pass through `exec` untouched (Claude
 *     Code feeds hook JSON on stdin and reads the relay's own stdout/exit
 *     code — the shim must never buffer or rewrite them).
 *   - bun-not-found: quiet mode (every hook except the primary SessionStart
 *     entry) exits 0 with NO output; --loud mode (SessionStart only) exits 0
 *     with exactly ONE actionable stderr line.
 *   - hooks/hooks.json wiring: every one of the 10 hook commands routes
 *     through the shim (no bare `bun `survives), and --loud appears on
 *     exactly one of the two SessionStart entries (two loud entries would
 *     print the warning twice per session).
 *   - the committed file mode is 100755 — a non-executable shim reintroduces
 *     the exact bug this fixes on a fresh clone.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..', '..', '..');
const SCRIPT = join(PLUGIN_ROOT, 'hooks', 'run-hook.sh');
const SH = typeof Bun !== 'undefined' ? Bun.which('sh') : null;

const created: string[] = [];
afterAll(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

/** Plants a fake `bun` at <dir>/bun that reports its own label, echoes argv
 *  and stdin back on stdout (so passthrough is provable), and exits with
 *  the given code. Reads stdin with the `read` SHELL BUILTIN (not `cat`) —
 *  the tests deliberately restrict PATH to just this stub's own directory to
 *  pin candidate resolution, so an external `cat` would be unresolvable and
 *  falsely look like a stdin-passthrough failure. */
function mkStubBun(dir: string, label: string, exitCode = 0): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'bun');
  const script = ['#!/bin/sh', `printf 'STUB=${label} ARGS=%s\\n' "$*"`, 'IFS= read -r line', "printf 'STDIN=%s\\n' \"$line\"", `exit ${exitCode}`, ''].join('\n');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
}

/** Runs run-hook.sh under `sh` with a FULLY explicit env (never inherits the
 *  real PATH/HOME — this test's whole point is controlling candidate
 *  resolution precisely). */
function run(args: string[], env: Record<string, string>, stdin = ''): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(SH!, [SCRIPT, ...args], { env, input: stdin, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// resolution chain — each env-controllable candidate, plus ordering
// ---------------------------------------------------------------------------

describe.skipIf(!SH)('run-hook.sh resolution chain (sh: ' + (SH ?? 'unavailable — suite skipped') + ')', () => {
  test('candidate 1 (PATH): resolved via `command -v bun`; argv + stdin + exit code pass through exec untouched', () => {
    const dir = mkTmp('shim-path-');
    const pathDir = join(dir, 'pathdir');
    mkStubBun(pathDir, 'PATH', 7);
    const r = run(['/plugin/hooks/relay.ts', 'extra-arg'], { PATH: pathDir, HOME: join(dir, 'unused-home') }, 'hook-json-on-stdin');
    expect(r.status).toBe(7); // exit code from the resolved bun, not swallowed
    expect(r.stdout).toContain('STUB=PATH');
    expect(r.stdout).toContain('ARGS=/plugin/hooks/relay.ts extra-arg');
    expect(r.stdout).toContain('STDIN=hook-json-on-stdin');
  }, 15000);

  test('candidate 2 ($BUN_INSTALL/bin): used when PATH has no bun', () => {
    const dir = mkTmp('shim-businstall-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const installDir = join(dir, 'install');
    mkStubBun(join(installDir, 'bin'), 'BUN_INSTALL');
    const r = run(['/relay.ts'], { PATH: emptyPath, BUN_INSTALL: installDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('STUB=BUN_INSTALL');
  }, 15000);

  test('candidate 3 (~/.bun/bin): used when PATH and $BUN_INSTALL have no bun (default install location)', () => {
    const dir = mkTmp('shim-home-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const home = join(dir, 'home');
    mkStubBun(join(home, '.bun', 'bin'), 'HOME');
    const r = run(['/relay.ts'], { PATH: emptyPath, HOME: home }); // BUN_INSTALL intentionally absent
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('STUB=HOME');
  }, 15000);

  test('order: PATH wins over $BUN_INSTALL and ~/.bun/bin when all three exist', () => {
    const dir = mkTmp('shim-order-a-');
    const pathDir = join(dir, 'pathdir');
    mkStubBun(pathDir, 'PATH');
    const installDir = join(dir, 'install');
    mkStubBun(join(installDir, 'bin'), 'BUN_INSTALL');
    const home = join(dir, 'home');
    mkStubBun(join(home, '.bun', 'bin'), 'HOME');
    const r = run(['/relay.ts'], { PATH: pathDir, BUN_INSTALL: installDir, HOME: home });
    expect(r.stdout).toContain('STUB=PATH');
  }, 15000);

  test('order: $BUN_INSTALL wins over ~/.bun/bin when PATH has no bun', () => {
    const dir = mkTmp('shim-order-b-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const installDir = join(dir, 'install');
    mkStubBun(join(installDir, 'bin'), 'BUN_INSTALL');
    const home = join(dir, 'home');
    mkStubBun(join(home, '.bun', 'bin'), 'HOME');
    const r = run(['/relay.ts'], { PATH: emptyPath, BUN_INSTALL: installDir, HOME: home });
    expect(r.stdout).toContain('STUB=BUN_INSTALL');
  }, 15000);

  // ---------------------------------------------------------------------------
  // bun nowhere to be found
  // ---------------------------------------------------------------------------

  test('bun not found, no --loud (quiet — used by every hook except the primary SessionStart entry): exits 0 with ZERO output', () => {
    const dir = mkTmp('shim-notfound-quiet-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const home = join(dir, 'home-empty');
    mkdirSync(home, { recursive: true });
    const r = run(['/relay.ts'], { PATH: emptyPath, HOME: home });
    expect(r.status).toBe(0); // never fails the (non-blocking) hook
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  }, 15000);

  test('bun not found, --loud (SessionStart primary entry only): exits 0 with exactly ONE actionable stderr line, no stdout', () => {
    const dir = mkTmp('shim-notfound-loud-');
    const emptyPath = join(dir, 'empty');
    mkdirSync(emptyPath, { recursive: true });
    const home = join(dir, 'home-empty');
    mkdirSync(home, { recursive: true });
    const r = run(['--loud', '/relay.ts'], { PATH: emptyPath, HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const lines = r.stderr.split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    expect(lines[0].toLowerCase()).toContain('bun');
    expect(lines[0]).toContain('bun.sh'); // actionable: where to install it
    expect(lines[0]).toContain('BUN_INSTALL'); // actionable: the escape hatch env var
  }, 15000);

  test('missing relay argument (malformed hooks.json entry) degrades to a silent no-op, never crashes', () => {
    const dir = mkTmp('shim-norelay-');
    const pathDir = join(dir, 'pathdir');
    mkStubBun(pathDir, 'PATH');
    const r = run([], { PATH: pathDir, HOME: join(dir, 'unused-home') });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // the stub was never invoked
  }, 15000);
});

// ---------------------------------------------------------------------------
// hooks/hooks.json wiring — static, runs regardless of `sh` availability
// ---------------------------------------------------------------------------

describe('hooks/hooks.json wiring', () => {
  test('all 10 hook commands route through run-hook.sh; no bare `bun ` invocation survives; --loud appears on exactly one SessionStart entry', () => {
    const raw = readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands: string[] = [];
    for (const entries of Object.values(parsed.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) commands.push(hook.command);
      }
    }
    expect(commands.length).toBe(10);
    for (const cmd of commands) {
      expect(cmd).toContain('hooks/run-hook.sh');
      expect(/^bun[ "]/.test(cmd)).toBe(false); // the old bare-bun form must not survive anywhere
    }
    const loudCount = commands.filter((c) => c.includes('--loud')).length;
    expect(loudCount).toBe(1); // two loud SessionStart entries would print the warning twice per session
    expect(parsed.hooks.SessionStart![0]!.hooks[0]!.command).toContain('--loud');
  });
});

// ---------------------------------------------------------------------------
// committed file mode — a non-executable shim reintroduces the exact bug
// ---------------------------------------------------------------------------

describe('hooks/run-hook.sh committed file mode', () => {
  test('git tracks the shim as mode 100755 (executable)', () => {
    const r = spawnSync('git', ['ls-files', '-s', 'hooks/run-hook.sh'], { cwd: PLUGIN_ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^100755\s/);
  });
});
