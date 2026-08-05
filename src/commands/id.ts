// `pipeline id [--json]`
//
// Print ONE freshly minted id — RFC 9562 UUIDv7, canonical lowercase
// `8-4-4-4-12` (`src/lib/ids.ts#newId`). This is the ONLY sanctioned way to
// generate a run id (or a `child_run_id`) anywhere in this product; a prompt
// (`skills/run/SKILL.md`) must call this command rather than inventing a
// format of its own (ux-v2 b2 — "No Markdown file contains an
// id-generation recipe").
//
// Output format:
//   plain:  019fc762-5762-7000-a9bf-922ed8fa00be
//   --json: {"id":"019fc762-5762-7000-a9bf-922ed8fa00be"}
//
// Exit codes:
//   0: Success
//   2: Usage error (unknown flag)

import { newId } from '../lib/ids';

export function runId(args: string[]): number {
  let json = false;

  for (const a of args) {
    if (a === '--json') json = true;
    else {
      process.stderr.write(`pipeline id: unknown flag '${a}'\n`);
      return 2;
    }
  }

  const id = newId();
  if (json) {
    process.stdout.write(JSON.stringify({ id }) + '\n');
  } else {
    process.stdout.write(id + '\n');
  }
  return 0;
}
