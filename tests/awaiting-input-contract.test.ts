// e7 DEFECT-3 — CONTRACT test: the `awaiting_input` event `pipeline drive`
// journals at park time MUST match the shape the cloud consumes, exactly.
//
// PROVENANCE (the consumer's parsing expectations, copied here so a drift on
// either side fails this suite instead of silently un-parking nothing):
//
//  1. @baizor/pipeline-protocol `src/events/types.ts` → `AwaitingInputData`
//     (strict zod, spike-report §4.3 / G7):
//       data: {
//         run_id:      z.string()                          (required)
//         iteration:   z.number().int().nonnegative()      (required — the
//                      iteration INDEX, correlating with
//                      `iteration.started.index`)
//         question_id: z.string().min(1)                   (required, G3)
//         question:    QuestionSchema                      (required)
//       } .passthrough()  — additive fields tolerated.
//     `src/common/question.ts` → `QuestionSchema`:
//       { text: z.string().min(1) (required); context: string|null optional;
//         options: string[]|null optional; question_id: min-1 string optional;
//         approval: {required_role} optional } .passthrough()
//  2. @baizor/pipeline-protocol `src/events/envelope.ts` → the common envelope
//     every journal line shares: { schema: positive int, ts: ISO-8601 UTC,
//     project_root: min-1 string, worktree: string|null, run_id: string|null
//     (must be NON-NULL for a shippable event — G2), parent_run_id:
//     string|null, session_id: string|null } — plus `type` + `data`.
//  3. Control plane `cloud/apps/api/src/modules/runs/ingest.ts`
//     case "awaiting_input" (~509-535): reads `evt.data.question_id` and
//     `evt.data.iteration` for the step-detail merge, then parks the run
//     (`setRunState { status: 'awaiting_input' }`). Un-parking rides
//     `iteration.started`/`iteration.resumed` → `resumeFromAwaiting` — the
//     resume re-entry's `resumed: true` tag is covered in drive.test.ts.
//  4. Runner shipper `pipeline-runner/src/shipper/privacy.ts` metadata-tier
//     allowlist: `awaiting_input: { run_id, iteration, question_id, question }`
//     — exactly the four required fields; anything else is stripped at the
//     default privacy tier, which is why the REQUIRED fields must all be
//     present at the top level of `data`.

import { test, expect, afterEach } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}, 30000);

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// Minimal envelope-printing fake (subset of drive.test.ts's ENVELOPE_EXECUTOR).
const PARKING_EXECUTOR = `import { readFileSync } from 'node:fs';
const prompt = await Bun.stdin.text();
const rm = /^pipeline_root = (.+)$/m.exec(prompt);
if (!rm) process.exit(9);
process.stdout.write(readFileSync(rm[1].trim() + '/canned-envelope.json', 'utf8'));
process.exit(0);
`;

/**
 * Assert one journalled event satisfies EVERY consumer expectation listed in
 * the provenance header. Mirrors the zod requirements field-for-field —
 * update BOTH when the protocol's AwaitingInputData changes.
 */
function assertCloudConsumedShape(evt: any): void {
  // Envelope (protocol envelope.ts, base shape).
  expect(Number.isInteger(evt.schema)).toBe(true);
  expect(evt.schema).toBeGreaterThan(0);
  expect(typeof evt.ts).toBe('string');
  expect(Number.isNaN(Date.parse(evt.ts))).toBe(false);
  expect(evt.ts.endsWith('Z')).toBe(true); // ISO-8601 UTC
  expect(evt.type).toBe('awaiting_input');
  expect(typeof evt.project_root).toBe('string');
  expect(evt.project_root.length).toBeGreaterThan(0);
  expect(evt.worktree === null || typeof evt.worktree === 'string').toBe(true);
  // G2: a shippable event MUST carry a non-null envelope run_id.
  expect(typeof evt.run_id).toBe('string');
  expect(evt.run_id.length).toBeGreaterThan(0);
  expect(evt.parent_run_id === null || typeof evt.parent_run_id === 'string').toBe(true);
  expect(evt.session_id === null || typeof evt.session_id === 'string').toBe(true);

  // data (protocol AwaitingInputData — all four fields REQUIRED).
  const d = evt.data;
  expect(typeof d.run_id).toBe('string');
  expect(d.run_id.length).toBeGreaterThan(0);
  expect(Number.isInteger(d.iteration)).toBe(true);
  expect(d.iteration).toBeGreaterThanOrEqual(0);
  expect(typeof d.question_id).toBe('string');
  expect(d.question_id.length).toBeGreaterThan(0);

  // data.question (protocol QuestionSchema).
  const q = d.question;
  expect(q !== null && typeof q === 'object' && !Array.isArray(q)).toBe(true);
  expect(typeof q.text).toBe('string');
  expect(q.text.length).toBeGreaterThan(0);
  if (q.context !== undefined) expect(q.context === null || typeof q.context === 'string').toBe(true);
  if (q.options !== undefined && q.options !== null) {
    expect(Array.isArray(q.options)).toBe(true);
    for (const o of q.options) expect(typeof o).toBe('string');
  }
  if (q.question_id !== undefined) {
    expect(typeof q.question_id).toBe('string');
    expect(q.question_id.length).toBeGreaterThan(0);
  }
}

test('drive park journals awaiting_input in the exact cloud-consumed shape', () => {
  const root = mkdtempSync(join(tmpdir(), 'awaiting-contract-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'steps', '01-step.md'), '# step 01\n');
  writeFileSync(join(root, 'parking-executor.ts'), PARKING_EXECUTOR, 'utf8');
  writeFileSync(
    join(root, 'canned-envelope.json'),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'asking',
      session_id: 'contract-park-session',
      structured_output: {
        outcome: 'needs-input',
        question: { text: 'Which database?', context: 'found none configured', options: ['pg', 'sqlite'] },
      },
    }),
    'utf8',
  );
  const plan = computePlan(root);
  const run = 'contractpark';

  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: root, HOME: root };
  delete env.PIPELINE_UI_RUN_ID;
  delete env.PIPELINE_UI_PARENT_RUN_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.PIPELINE_DRIVE_EXECUTOR_CMD;
  const r = spawnSync(
    process.execPath,
    [
      CLI,
      'drive',
      '--root',
      root,
      '--run-id',
      run,
      '--start',
      plan.steps[0].path,
      '--executor-cmd',
      `bun ${join(root, 'parking-executor.ts')}`,
    ],
    { encoding: 'utf8', cwd: root, env },
  );
  expect(r.status).toBe(4);
  const finalJson = JSON.parse(r.stdout);
  expect(finalJson.status).toBe('awaiting-input');

  const journalPath = join(root, '.claude', 'pipeline', '.runtime', 'events.jsonl');
  expect(existsSync(journalPath)).toBe(true);
  const parks = readFileSync(journalPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'awaiting_input');
  expect(parks.length).toBe(1);
  const evt = parks[0];

  assertCloudConsumedShape(evt);

  // Cross-surface identity: the SAME question_id rides the exit-4 JSON (the
  // runner's needs_input frame source) and the journalled event (the shipper's
  // upload source) — one park, one id, two transports.
  expect(evt.data.question_id).toBe(finalJson.question_id);
  expect(evt.run_id).toBe(run);
  expect(evt.data.run_id).toBe(run);
  expect(evt.data.question.text).toBe('Which database?');
}, 60000);
