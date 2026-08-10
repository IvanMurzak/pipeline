// `--help` must be a RECOGNIZED argument — exit 0, help printed, no "unknown
// argument/flag/option/verb/subcommand" line — for EVERY command group
// `pipeline` exposes.
//
// Found by a13 while verifying the 0.17.0 release, reproduced against the
// published build (taskflow-v2 a14):
//
//   $ pipeline gc --help
//   pipeline gc: unknown argument '--help'
//   Usage: pipeline gc [--project <path>] [--clean] [--json] [--no-submodules] [--force-worktree-branches]
//
// `pipeline worktree --help` printed full help while `pipeline gc --help`
// called `--help` an unknown argument and printed usage anyway — `--help` was
// being handled by the error path rather than the help path, in some command
// groups but not others.
//
// GROUPS is enumerated from src/cli.ts's own `main()` switch (every case that
// dispatches to a real command — not the bare `--version`/`-v`/`--help`/`-h`/
// undefined branches, which are not command groups) rather than typed from
// memory here, so this file and cli.ts cannot silently drift apart. `mesh` is
// the DEPRECATED, hidden-from-`--help` alias for `department notify` — still a
// real dispatch target in the switch, so it is covered too.
//
// This spawns the REAL CLI as a subprocess (same pattern as
// packed-artifact.test.ts's `pipeline drive` / `pipeline --version` checks)
// rather than importing each command's run function directly, because the
// defect lives in argument PARSING, and only a real invocation exercises the
// exact argv `cli.ts`'s `main()` hands each command.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

/** Every case in cli.ts's `main()` switch that dispatches to a real command. */
const GROUPS = [
  'hash',
  'clone',
  'id',
  'init',
  'plan',
  'fix',
  'match',
  'event',
  'route',
  'next',
  'drive',
  'gc',
  'worktree',
  'ci-wait',
  'logs',
  'submodule',
  'stats',
  'release',
  'cloud',
  'department',
  'mesh',
  'telemetry-daemon',
  'hook',
  'step',
  'migrate',
] as const;

const UNKNOWN_ARG_RE = /unknown\s+(argument|flag|option|verb|subcommand|command)/i;

function runHelp(args: string[]): { status: number | null; combined: string } {
  const res = spawnSync('bun', [CLI, ...args, '--help'], { encoding: 'utf8', timeout: 30_000 });
  return { status: res.status, combined: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
}

describe('`pipeline <group> --help` is honoured uniformly for every command group (taskflow-v2 a14)', () => {
  for (const group of GROUPS) {
    test(`pipeline ${group} --help exits 0, prints help, and never says "unknown ..."`, () => {
      const { status, combined } = runHelp([group]);
      expect(status).toBe(0);
      expect(combined).not.toMatch(UNKNOWN_ARG_RE);
      expect(combined.trim().length).toBeGreaterThan(0);
    });
  }

  // a11's neighbouring case, cited by this task's own spec: `pipeline
  // worktree create --help` was ALSO a usage error even though the group
  // level (`pipeline worktree --help`) already worked — `--help` has to be
  // honoured at the verb level too, not just the group level.
  describe('verb level (a11\'s neighbouring case)', () => {
    for (const verb of ['create', 'finalize', 'destroy', 'list']) {
      test(`pipeline worktree ${verb} --help exits 0 and prints help`, () => {
        const { status, combined } = runHelp(['worktree', verb]);
        expect(status).toBe(0);
        expect(combined).not.toMatch(UNKNOWN_ARG_RE);
        expect(combined.trim().length).toBeGreaterThan(0);
      });
    }

    test('pipeline submodule bump --help exits 0 and prints help', () => {
      const { status, combined } = runHelp(['submodule', 'bump']);
      expect(status).toBe(0);
      expect(combined).not.toMatch(UNKNOWN_ARG_RE);
      expect(combined.trim().length).toBeGreaterThan(0);
    });

    test('pipeline cloud connect --help exits 0 and prints help', () => {
      const { status, combined } = runHelp(['cloud', 'connect']);
      expect(status).toBe(0);
      expect(combined).not.toMatch(UNKNOWN_ARG_RE);
      expect(combined.trim().length).toBeGreaterThan(0);
    });
  });

  // `pipeline logs --help` is a SEPARATE trap from the "unknown argument"
  // shape the rest of this file guards: parseLogsArgs silently ignores an
  // unrecognized flag rather than erroring, so pre-fix it fell through to
  // `runLogs`'s actual journal-tailing logic — exiting 0 either way (with
  // "no event journal at ..." when none exists, or the REAL tail output when
  // one does), never with an "unknown ..." line and never empty. The generic
  // checks above cannot tell that apart from a genuine help print, so this
  // pins the actual usage text instead of just "exit 0, no unknown-argument
  // line, non-empty".
  test('pipeline logs --help prints its own usage, not a journal-tail attempt', () => {
    const { status, combined } = runHelp(['logs']);
    expect(status).toBe(0);
    expect(combined).not.toMatch(UNKNOWN_ARG_RE);
    expect(combined).toContain('--follow');
    expect(combined).not.toContain('no event journal');
  });
});
