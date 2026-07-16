// `pipeline next --record-file <path>` — the file-based twin of `--record`.
// The command reads the file as UTF-8, parses it with the SAME parseRecord path
// as an inline `--record`, and never deletes or modifies the file. Unreadable
// file / invalid JSON / combining it with `--record` are all loud exit-2 usage
// errors (matching the malformed-`--record` behavior in next.test.ts).

import { test, expect, afterEach } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function scaffoldSequential(n = 3): string {
  const root = mkdtempSync(join(tmpdir(), 'recfile-seq-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(2, '0');
    writeFileSync(join(steps, `${id}-step.md`), `# step ${id}\n`);
  }
  return root;
}

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

/** Raw invocation (no JSON.parse) — usable on the error paths where stdout is
 *  empty. Same controlled cwd/env as next.test.ts so auto-emitted UI events
 *  land inside the temp dir, never the repo or the real ~/.claude. */
function nextRaw(root: string, runId: string, extra: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PIPELINE_UI_RUN_ID;
  delete env.PIPELINE_UI_PARENT_RUN_ID;
  delete env.CLAUDE_SESSION_ID;
  env.USERPROFILE = root;
  env.HOME = root;
  // process.execPath (the real bun binary), NOT the string 'bun': with an npm
  // shim install (bun.ps1/.cmd), spawnSync('bun', …, { env }) defeats Bun's
  // self-spawn special case and stdout comes back null.
  return spawnSync(process.execPath, [CLI, 'next', '--root', root, '--run-id', runId, ...extra], { encoding: 'utf8', cwd: root, env });
}

function next(root: string, runId: string, extra: string[]) {
  const r = nextRaw(root, runId, extra);
  return { json: JSON.parse(r.stdout), status: r.status, stderr: r.stderr };
}

test('pipeline next CLI: --record-file advances the run exactly like inline --record, and preserves the file', () => {
  const root = scaffoldSequential(2);
  const run = 'recfilehappy';
  const plan = computePlan(root);

  // init → step 1
  let r = next(root, run, []);
  expect(r.json.action).toBe('run-step');
  expect(r.json.steps[0].path).toBe(plan.steps[0].path);

  // record step 1 completed via a FILE → step 2 (identical to the inline path)
  const recordFile = join(root, 'step1-record.json');
  const content = JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path });
  writeFileSync(recordFile, content, 'utf8');
  r = next(root, run, ['--record-file', recordFile]);
  expect(r.json.action).toBe('run-step');
  expect(r.json.steps[0].path).toBe(plan.steps[1].path);
  expect(r.status).toBe(0);
  // The record file is read-only to the command: still present, byte-identical.
  expect(existsSync(recordFile)).toBe(true);
  expect(readFileSync(recordFile, 'utf8')).toBe(content);

  // terminal record via the --record-file=<path> equals form → done (exit 0)
  const termFile = join(root, 'step2-record.json');
  writeFileSync(termFile, JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }), 'utf8');
  r = next(root, run, [`--record-file=${termFile}`]);
  expect(r.json.action).toBe('done');
  expect(r.status).toBe(0);
  expect(existsSync(termFile)).toBe(true);
});

test('pipeline next CLI: a missing --record-file is a LOUD exit-2 error naming the path (state untouched)', () => {
  const root = scaffoldSequential(2);
  const run = 'recfilemissing';
  const plan = computePlan(root);
  next(root, run, []); // init → step 1, state persisted

  const missing = join(root, 'no-such-record.json');
  const bad = nextRaw(root, run, ['--record-file', missing]);
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('--record-file');
  expect(bad.stderr).toContain(missing);
  expect(bad.stdout.trim()).toBe(''); // returned BEFORE computeNext → no action emitted

  // State was not advanced or swallowed: a subsequent valid record for step 1
  // still advances to step 2 (the manager's retry path).
  const ok = next(root, run, [
    '--record',
    JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }),
  ]);
  expect(ok.json.action).toBe('run-step');
  expect(ok.json.steps[0].path).toBe(plan.steps[1].path);
});

test('pipeline next CLI: a --record-file with invalid JSON is a LOUD exit-2 error naming the path; the file survives', () => {
  const root = scaffoldSequential(2);
  const run = 'recfilebadjson';
  next(root, run, []); // init → step 1

  const recordFile = join(root, 'garbage-record.json');
  const garbage = '{"kind":"step","outcome":'; // truncated — unparseable even after backslash normalization
  writeFileSync(recordFile, garbage, 'utf8');
  const bad = nextRaw(root, run, ['--record-file', recordFile]);
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain(recordFile);
  expect(bad.stderr).toContain('not valid JSON');
  expect(bad.stdout.trim()).toBe('');
  // The file is never deleted or modified on the error path.
  expect(existsSync(recordFile)).toBe(true);
  expect(readFileSync(recordFile, 'utf8')).toBe(garbage);
});

test('pipeline next CLI: --record and --record-file together are rejected (exit 2, mutual exclusion)', () => {
  const root = scaffoldSequential(2);
  const run = 'recfileboth';
  next(root, run, []); // init → step 1

  const recordFile = join(root, 'both-record.json');
  const rec = JSON.stringify({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
  writeFileSync(recordFile, rec, 'utf8');
  const bad = nextRaw(root, run, ['--record', rec, '--record-file', recordFile]);
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('mutually exclusive');
  expect(bad.stdout.trim()).toBe('');

  // Neither record was consumed — the run is still parked on step 1: the same
  // record delivered via ONE flag now advances to done.
  const ok = next(root, run, ['--record-file', recordFile]);
  expect(ok.json.action).toBe('done');
  expect(ok.status).toBe(0);
});
