// `pipeline mesh notify [--interval-ms <n>] [--once] [--json]` — DEPRECATED
// alias for `pipeline department notify` (a11, simplified-onboarding —
// 08-terminology.md / D10 / D31: "mesh"/"fleet" are gone from the project).
//
// Kept so service definitions and scripts already written against `pipeline
// mesh notify` keep working — deliberately NOT listed in `cli.ts`'s
// `--help` (hidden), and every invocation warns on stderr and points at the
// new name before delegating to the exact same behavior in
// `./department-notify.ts`. There is no separate logic here to keep in sync;
// this file is a thin, permanent-until-a-tier-3-drop pass-through.

import {
  runDepartmentNotify,
  realDepartmentNotifyCliDeps,
  type DepartmentNotifyCliDeps,
} from './department-notify';

const USAGE =
  'Usage: pipeline mesh notify [--interval-ms <n>] [--once] [--json]\n' +
  '  DEPRECATED — use `pipeline department notify` instead. Kept working for\n' +
  '  existing service definitions and scripts; prints this notice on stderr on\n' +
  '  every call, then behaves identically to `pipeline department notify`.\n';

export async function runMesh(
  args: string[],
  deps: DepartmentNotifyCliDeps = realDepartmentNotifyCliDeps,
): Promise<number> {
  const sub = args[0];
  if (sub === '--help' || sub === '-h' || sub === undefined) {
    (sub === undefined ? deps.err : deps.out)(USAGE);
    return sub === undefined ? 2 : 0;
  }
  if (sub !== 'notify') {
    deps.err(`pipeline mesh: unknown subcommand '${sub}'\n${USAGE}`);
    return 2;
  }
  deps.err('pipeline mesh notify is deprecated — use `pipeline department notify` instead.\n');
  return runDepartmentNotify(args.slice(1), deps);
}
