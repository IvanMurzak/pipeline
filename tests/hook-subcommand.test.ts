/**
 * `pipeline hook <name>` — the dispatcher itself (plugin-thin `p6`).
 *
 *   bun test tests/hook-subcommand.test.ts
 *
 * The five relays each have their own suite (`hook-*.test.ts`, `mirror-*.test.ts`),
 * driving handlers directly and spawning the real subcommand. What NONE of
 * them covers is the seam this task created: that `pipeline hook <name>`
 * REACHES each relay at all, for every name, from a cold process.
 *
 * That gap is not hypothetical. A relay reached by nothing looks exactly like
 * a relay that works — every one of them is best-effort, silent, and exits 0
 * by contract, so a typo in the dispatch table produces no error anywhere. The
 * plugin's `hooks/hooks.json` would keep invoking a name that quietly does
 * nothing, and the journal — `ux-v2`'s telemetry source — would simply stop
 * being written.
 *
 * So every name is spawned as a REAL subprocess here, in a directory with no
 * `.pipeline/`, where each relay's own gate makes it a fast, side-effect-free
 * no-op. Exit 0 proves the module resolved, loaded, and ran its gate.
 *
 * The complementary half — that the names the PLUGIN invokes are these names —
 * needs both repositories on disk and lives in the parent monorepo's
 * `tests/cross-repo/hook-subcommand-parity.test.ts`.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { HOOK_NAMES } from '../src/commands/hook';
import { CLI_ENTRY, hookArgv } from './_hook-entry';

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

/** A directory with NO `.pipeline/` and a private HOME — every relay's first
 *  gate stops there, so a spawn costs a module load and nothing else, and no
 *  daemon can be started against the developer's real home. */
function sandbox(): { cwd: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'hook-subcommand-'));
  created.push(dir);
  return {
    cwd: dir,
    env: {
      ...process.env,
      HOME: dir,
      USERPROFILE: dir,
      // Belt and braces: the department notifier is the one relay whose gate
      // is NOT project-scoped (department tasks are org-scoped), so it is
      // gated explicitly rather than by the absent `.pipeline/`.
      PIPELINE_DEPARTMENT_NOTIFY_ENABLED: '0',
    } as Record<string, string>,
  };
}

function run(argv: string[], input = ''): { status: number | null; stdout: string; stderr: string } {
  const { cwd, env } = sandbox();
  const r = spawnSync(process.execPath, argv, { cwd, env, input, encoding: 'utf-8', timeout: 60_000 });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('every registered hook name dispatches', () => {
  // A `for` over HOOK_NAMES rather than five hand-written cases: adding a
  // sixth relay to the table and forgetting to test it is exactly the
  // omission this file exists to make impossible.
  for (const name of HOOK_NAMES) {
    test(`\`pipeline hook ${name}\` runs and exits 0`, () => {
      const r = run(hookArgv(name), JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }));
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    }, 60_000);
  }

  test('the underscore spelling of a relay name still resolves', () => {
    // The relays were `analytics_relay.ts` etc. as files. Accepting the old
    // spelling costs one `replace` and keeps a hand-typed invocation working.
    const r = run([CLI_ENTRY, 'hook', 'analytics_relay'], JSON.stringify({ hook_event_name: 'PostToolUse' }));
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  }, 60_000);
});

describe('the dispatch table matches what is on disk', () => {
  test('there is exactly one src/hooks/<name>.ts per registered name, and no orphans', () => {
    const dir = resolve(import.meta.dir, '..', 'src', 'hooks');
    const onDisk = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
    expect(onDisk).toEqual([...HOOK_NAMES].sort());
    for (const name of HOOK_NAMES) {
      expect(existsSync(join(dir, `${name}.ts`)), `src/hooks/${name}.ts is missing`).toBe(true);
    }
  });
});

describe('usage', () => {
  test('an unknown hook name exits 2 and lists the real ones', () => {
    const r = run([CLI_ENTRY, 'hook', 'no-such-relay']);
    expect(r.status).toBe(2);
    for (const name of HOOK_NAMES) expect(r.stderr).toContain(name);
  }, 60_000);

  test('a missing hook name exits 2 — a hooks.json entry that lost its argument is loud', () => {
    const r = run([CLI_ENTRY, 'hook']);
    expect(r.status).toBe(2);
  }, 60_000);

  test('`pipeline --help` advertises the command', () => {
    const r = run([CLI_ENTRY, '--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('hook <name>');
  }, 60_000);
});
