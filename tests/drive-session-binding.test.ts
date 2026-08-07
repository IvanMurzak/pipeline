// `pipeline drive` — the session→(run, step) binding PRE-WRITE (ux-v2 b7).
//
// Every step drive runs is a headless `claude -p` with a session id drive pins
// itself. The plugin's hooks fire inside that child and have no way to know
// which run — let alone which step — it belongs to: `PIPELINE_RUN_ID` is not
// exported into it, and before b7 nothing was keyed by the child's session.
//
// So drive writes the binding FIRST and spawns SECOND. The order is the whole
// mechanism, and it is what this suite pins: the fake executor snapshots
// ~/.claude/pipeline-ui/active-mirror-bindings.jsonl at the instant it is
// spawned, and the assertions read that snapshot — not the file as it looks
// after the run, which a late write would also satisfy.
//
// The READ half (the hook recovering { run_id, step_uuid } from this record)
// lives in apps/pipeline-cli/tests/hook-step-binding.test.ts, which also
// round-trips this writer against the hook.

import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}, 30000);

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

/** Fake executor that SNAPSHOTS the bindings journal before doing anything
 *  else, so the assertions can prove the binding predates the spawn. Also
 *  records the argv it was handed (drive appends `--session-id <uuid>` to a
 *  template with no {session} token) so the record's session_id can be checked
 *  against the id the child was actually pinned to. */
const SNAPSHOT_EXECUTOR = `import { copyFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const prompt = await Bun.stdin.text();
const m = /^step_record_file = (.+)$/m.exec(prompt);
if (!m) process.exit(9);
const recordFile = m[1].trim();
const rm = /^pipeline_root = (.+)$/m.exec(prompt);
const root = rm ? rm[1].trim() : dirname(dirname(dirname(dirname(recordFile))));
const stepId = basename(recordFile, '.json');
const canned = join(root, 'canned');
mkdirSync(canned, { recursive: true });

// THE ASSERTION SUBJECT: the bindings journal as it exists at spawn time.
const home = process.env.USERPROFILE ?? process.env.HOME;
const bindings = join(home, '.claude', 'pipeline-ui', 'active-mirror-bindings.jsonl');
writeFileSync(
  join(canned, 'spawn-' + stepId + '.json'),
  JSON.stringify({
    argv: process.argv.slice(2),
    bindings: existsSync(bindings) ? readFileSync(bindings, 'utf8') : '',
  }),
);

const rec = join(canned, stepId + '.json');
if (!existsSync(rec)) process.exit(7);
copyFileSync(rec, recordFile);
process.exit(0);
`;

function scaffold(n = 2): string {
  const root = mkdtempSync(join(tmpdir(), 'drive-bind-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(2, '0');
    writeFileSync(join(steps, `${id}-step.md`), `# step ${id}\n`);
  }
  writeFileSync(join(root, 'snapshot-executor.ts'), SNAPSHOT_EXECUTOR, 'utf8');
  return root;
}

function canned(root: string, stepId: string, record: unknown): void {
  mkdirSync(join(root, 'canned'), { recursive: true });
  writeFileSync(join(root, 'canned', `${stepId}.json`), JSON.stringify(record), 'utf8');
}

/** What the executor saw at the moment it was spawned. */
function spawnSnapshot(root: string, stepId: string): { argv: string[]; bindings: string } {
  const f = join(root, 'canned', `spawn-${stepId}.json`);
  expect(existsSync(f), `executor for ${stepId} never ran`).toBe(true);
  return JSON.parse(readFileSync(f, 'utf8'));
}

function bindingRecords(text: string): Record<string, any>[] {
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function journal(root: string): Record<string, any>[] {
  // HOME is set to `root`, and the pipeline root IS `root` — drive resolves the
  // project root from cwd, so the journal lands under <root>/.pipeline/.runtime.
  const f = join(root, '.pipeline', '.runtime', 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function drive(root: string, runId: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PIPELINE_RUN_ID;
  delete env.PIPELINE_PARENT_RUN_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.PIPELINE_DRIVE_EXECUTOR_CMD;
  delete env.PIPELINE_DRIVE_SELF_IMPROVE;
  delete env.PIPELINE_JOURNAL_ENABLED;
  env.USERPROFILE = root;
  env.HOME = root;
  Object.assign(env, extraEnv);
  // The project root must contain a .pipeline dir or the journal lands
  // elsewhere; drive's own emitter resolves it from cwd exactly as the hooks do.
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  const r = spawnSync(
    process.execPath,
    [
      CLI,
      'drive',
      '--root',
      root,
      '--run-id',
      runId,
      '--start',
      join(root, 'steps', '01-step.md'),
      '--executor-cmd',
      `bun ${join(root, 'snapshot-executor.ts')}`,
    ],
    { encoding: 'utf8', cwd: root, env },
  );
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* error paths have empty stdout */
  }
  return { json, status: r.status, stderr: r.stderr };
}

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Prescribe a straight 2-step run: 01 → 02 → PIPELINE_COMPLETE. */
function cannedChain(root: string): void {
  canned(root, '01-step', {
    kind: 'step',
    outcome: 'completed',
    next_iteration: join(root, 'steps', '02-step.md'),
  });
  canned(root, '02-step', { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
}

test('drive PRE-writes a session binding carrying the run AND the step, before the executor spawns', () => {
  const root = scaffold(2);
  cannedChain(root);
  const runId = 'run-bind-1';
  const r = drive(root, runId);
  expect(r.status).toBe(0);
  expect(r.json.status).toBe('completed');

  for (const stepId of ['01-step', '02-step']) {
    const snap = spawnSnapshot(root, stepId);
    // The session drive pinned on THIS child (appended by buildExecutorArgv
    // because the test template carries no {session} token).
    const sessIdx = snap.argv.indexOf('--session-id');
    expect(sessIdx, `${stepId}: no --session-id in argv`).toBeGreaterThanOrEqual(0);
    const sessionId = snap.argv[sessIdx + 1];

    // ...was already bound, at spawn time, to this run and a step.
    const rec = bindingRecords(snap.bindings).find((b) => b.session_id === sessionId);
    expect(rec, `${stepId}: no binding for session ${sessionId} existed when the executor spawned`).toBeDefined();
    expect(rec!.run_id).toBe(runId);
    expect(rec!.kind).toBe('drive-session');
    expect(rec!.event).toBe('bound');
    expect(rec!.step_uuid).toMatch(UUID_V7_RE);
    // Pointer-free: the child's transcript does not exist yet, and binding a
    // guessed path would widen what the daemon mirrors (issue #11).
    expect(rec!.transcript_path).toBeNull();
  }
}, 60000);

test("the bound step_uuid is the step's own — the same value iteration.started carries", () => {
  const root = scaffold(2);
  cannedChain(root);
  const runId = 'run-bind-2';
  expect(drive(root, runId).status).toBe(0);

  const started = journal(root).filter((e) => e.type === 'iteration.started');
  expect(started.length).toBe(2);

  const boundUuids = ['01-step', '02-step'].map((s) => {
    const snap = spawnSnapshot(root, s);
    const sessionId = snap.argv[snap.argv.indexOf('--session-id') + 1];
    return bindingRecords(snap.bindings).find((b) => b.session_id === sessionId)!.step_uuid;
  });

  // Same set, and DISTINCT per step — a step uuid identifies one execution, so
  // two steps in one run must never share it.
  expect(new Set(boundUuids).size).toBe(2);
  expect(boundUuids.sort()).toEqual(started.map((e) => e.data.step_uuid).sort());
}, 60000);

test("every binding shares the run's id, so the run's terminal event retires them all", () => {
  const root = scaffold(2);
  cannedChain(root);
  const runId = 'run-bind-3';
  expect(drive(root, runId).status).toBe(0);

  const bindingsFile = join(root, '.claude', 'pipeline-ui', 'active-mirror-bindings.jsonl');
  const recs = bindingRecords(readFileSync(bindingsFile, 'utf8'));
  const mine = recs.filter((b) => b.kind === 'drive-session');
  // One per step session, no terminal records: the run's own
  // pipeline.completed/halted is what terminates them (see the hook suite).
  expect(mine.length).toBe(2);
  expect(mine.every((b) => b.run_id === runId)).toBe(true);
  expect(recs.some((b) => b.event === 'terminal')).toBe(false);
}, 60000);

test('PIPELINE_JOURNAL_ENABLED=0 writes no binding — the master opt-out still means no bindings', () => {
  const root = scaffold(1);
  canned(root, '01-step', { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  const r = drive(root, 'run-bind-off', { PIPELINE_JOURNAL_ENABLED: '0' });
  expect(r.status).toBe(0);

  const snap = spawnSnapshot(root, '01-step');
  expect(bindingRecords(snap.bindings).length).toBe(0);
  expect(existsSync(join(root, '.claude', 'pipeline-ui', 'active-mirror-bindings.jsonl'))).toBe(false);
}, 60000);

test('a step that never produces a record still bound exactly one session to one step', () => {
  // No prescription → the fake exits 7 with no record on every attempt, so the
  // step burns its whole crash budget on ONE pinned session. The binding must
  // be written per SESSION, not per attempt: a re-bind that minted a new step
  // identity each retry would scatter one execution across several uuids.
  const root = scaffold(1);
  const runId = 'run-bind-resume';
  const r = drive(root, runId);
  expect(r.status).not.toBe(0); // the step could not complete — that is the point

  const bindingsFile = join(root, '.claude', 'pipeline-ui', 'active-mirror-bindings.jsonl');
  const mine = bindingRecords(readFileSync(bindingsFile, 'utf8')).filter((b) => b.kind === 'drive-session');
  expect(mine.length).toBeGreaterThanOrEqual(1);
  expect(new Set(mine.map((b) => b.session_id)).size).toBe(1);
  const steps = new Set(mine.map((b) => b.step_uuid));
  expect(steps.size).toBe(1);
  expect([...steps][0]).toMatch(UUID_V7_RE);
}, 60000);
