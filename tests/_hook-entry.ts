// _hook-entry.ts — how a hook relay is SPAWNED, for the tests that spawn one.
//
// Not a test file (no `.test.ts` suffix), so neither `bun test tests/` nor
// `scripts/parallel-tests.ts` tries to run it.
//
// The relays used to be standalone scripts inside `pipeline-claude/hooks/`,
// and every subprocess test here spawned one as `bun <hooks/x_relay.ts>`.
// Since plugin-thin `p6` they are CLI subcommands: the plugin's
// `hooks/hooks.json` invokes `pipeline hook <name>` through
// `hooks/run-hook.sh`, and these tests reproduce that — same binary, same
// argv, hook JSON on stdin.
//
// Single-sourced here rather than restated per file so the invocation shape
// cannot drift between the twelve tests that use it. The IMPORT half cannot
// come from here (a module specifier is a literal), so files that also import
// a relay's exported handlers spell `../src/hooks/<name>` in their own import
// lines.

import { resolve } from 'node:path';
import type { HookName } from '../src/commands/hook';

/** This package's CLI entry point, as a spawnable absolute path. */
export const CLI_ENTRY = resolve(import.meta.dir, '..', 'src', 'cli.ts');

/** argv for `spawnSync(process.execPath, hookArgv('analytics-relay'), …)` —
 *  exactly what `run-hook.sh` execs, minus the binary resolution it does for
 *  a non-interactive shell. */
export function hookArgv(name: HookName, ...rest: string[]): string[] {
  return [CLI_ENTRY, 'hook', name, ...rest];
}
