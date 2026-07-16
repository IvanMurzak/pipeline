// T33 — `pipeline step run <iteration.md> [--param k=v ...] [--json]`, the
// author-facing dry-run tool for `type: script` steps (DESIGN.md §13).
//
// Exercised through the real CLI surface (spawnSync of cli.ts, same recipe as
// drive.test.ts / next.test.ts: controlled cwd + isolated HOME/USERPROFILE) so
// the exit codes, stdout, and — critically — the acceptance criterion that NO
// `.runtime/` or `.feedback/` state is created under the pipeline are all
// verified end-to-end. Fixture scripts are bun-runnable `.js` (the interpreter
// ladder maps `.js` → bun), matching script-exec-integration.test.ts.

import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}, 30000);

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// --- fixture scripts ---------------------------------------------------------

const ONE_JS = `console.log('a diagnostic log line');
console.log(JSON.stringify({ ok: true, summary: 'made pr', flags: { made: true }, output: { pr: 7 } }));
`;
// Reads the resolved params file and echoes pr_number back in output.
const TWO_JS = `const fs = require('node:fs');
const p = JSON.parse(fs.readFileSync(process.env.PIPELINE_STEP_PARAMS_FILE, 'utf8'));
console.log(JSON.stringify({ ok: true, output: { got: p.pr_number } }));
`;
// Echoes the WHOLE resolved params object back (statics/defaults coverage).
const ECHO_JS = `const fs = require('node:fs');
const p = JSON.parse(fs.readFileSync(process.env.PIPELINE_STEP_PARAMS_FILE, 'utf8'));
console.log(JSON.stringify({ ok: true, output: p }));
`;
const BAD_JS = `console.error('boom happened');
process.exit(3);
`;

// --- scaffolding -------------------------------------------------------------

function scriptStepMd(opts: { script: string; stepId: string; next?: string; params?: string }): string {
  const fm = ['---', 'type: script', `script: ${opts.script}`, `step_id: ${opts.stepId}`, '---'].join('\n');
  return [
    fm,
    `# ${opts.stepId}`,
    '## Goal',
    'g',
    '## Success Criteria',
    's',
    ...(opts.params ? ['## Params', '', '```json', opts.params, '```', ''] : []),
    '## Steps',
    `1. Run: \`bun ${opts.script}\` — deterministic work.`,
    '## Next',
    opts.next ?? 'Pipeline complete.',
    '',
  ].join('\n');
}

/** A pipeline with a script step (s1), a run-state-bound script step (s2), an
 *  agent step (a3), a crashing script step (bad), and a statics/defaults script
 *  step (echo). */
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'steprun-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  const steps = join(root, 'steps');
  const scripts = join(root, 'scripts');
  mkdirSync(steps, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'one.js'), ONE_JS);
  writeFileSync(join(scripts, 'two.js'), TWO_JS);
  writeFileSync(join(scripts, 'echo.js'), ECHO_JS);
  writeFileSync(join(scripts, 'bad.js'), BAD_JS);
  writeFileSync(join(steps, '01-one.md'), scriptStepMd({ script: 'scripts/one.js', stepId: 's1' }));
  writeFileSync(
    join(steps, '02-two.md'),
    scriptStepMd({
      script: 'scripts/two.js',
      stepId: 's2',
      params: '{ "pr_number": { "type": "number", "required": true, "from": "${steps.s1.output.pr}" } }',
    }),
  );
  writeFileSync(join(steps, '03-agent.md'), '---\nstep_id: a3\n---\n# a3\n## Goal\ng\n## Success Criteria\ns\n');
  writeFileSync(join(steps, '04-bad.md'), scriptStepMd({ script: 'scripts/bad.js', stepId: 'bad' }));
  writeFileSync(
    join(steps, '05-echo.md'),
    scriptStepMd({
      script: 'scripts/echo.js',
      stepId: 'echo',
      params:
        '{ "fail_fast": { "type": "boolean", "default": true }, "labels": { "type": "array", "value": ["release", "auto"] } }',
    }),
  );
  return root;
}

/** Run `pipeline step run` as a subprocess (isolated home; cwd = fixture). */
function stepRun(root: string, iterationRel: string, extra: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: root, HOME: root };
  delete env.PIPELINE_UI_RUN_ID;
  delete env.PIPELINE_UI_PARENT_RUN_ID;
  const args = [CLI, 'step', 'run', join(root, 'steps', iterationRel), ...extra];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: root, env });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* human output / usage errors are not JSON */
  }
  return { json, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// --- tests -------------------------------------------------------------------

test('step run: happy path executes the script and prints OK + the would-be step record', () => {
  const root = scaffold();
  const r = stepRun(root, '01-one.md');
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('Result:');
  expect(r.stdout).toContain('OK');
  expect(r.stdout).toContain('made pr'); // the script's summary
  expect(r.stdout).toContain('"pr": 7'); // the script's output
  expect(r.stdout).toContain('Would-be step record');
  expect(r.stdout).toContain('PIPELINE_COMPLETE'); // parsed ## Next
}, 30000);

test('step run --json: one JSON object with the documented shape', () => {
  const root = scaffold();
  const r = stepRun(root, '01-one.md', ['--json']);
  expect(r.status).toBe(0);
  expect(r.json).not.toBeNull();
  // Documented shape.
  for (const k of [
    'ok',
    'step_id',
    'iteration',
    'target',
    'class',
    'attempts',
    'ledger_reused',
    'duration_s',
    'params',
    'record',
    'flags',
    'output',
    'summary',
    'next_iteration',
    'failure',
    'feedback_category',
    'warnings',
  ]) {
    expect(r.json).toHaveProperty(k);
  }
  expect(r.json.ok).toBe(true);
  expect(r.json.step_id).toBe('s1');
  expect(r.json.class).toBeNull();
  expect(r.json.failure).toBeNull();
  expect(r.json.output).toEqual({ pr: 7 });
  expect(r.json.flags).toEqual({ made: true });
  expect(r.json.summary).toBe('made pr');
  // The would-be engine step record (synthesized §5.1).
  expect(r.json.record).toMatchObject({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' });
}, 30000);

test('step run: a ${steps…} binding with no --param is a usage error (exit 2) listing the missing param', () => {
  const root = scaffold();
  const r = stepRun(root, '02-two.md');
  expect(r.status).toBe(2);
  expect(r.json).toBeNull(); // usage errors go to stderr, not stdout JSON
  expect(r.stderr).toContain('pr_number');
  expect(r.stderr).toContain('${steps.s1.output.pr}');
  expect(r.stderr).toContain('--param');
  // Nothing executed → no state anywhere.
  expect(existsSync(join(root, '.runtime'))).toBe(false);
}, 30000);

test('step run --param: the override resolves the binding and reaches the script', () => {
  const root = scaffold();
  const r = stepRun(root, '02-two.md', ['--param', 'pr_number=42', '--json']);
  expect(r.status).toBe(0);
  expect(r.json.params).toEqual({ pr_number: 42 }); // JSON-parsed to a number
  expect(r.json.output).toEqual({ got: 42 }); // the script actually received it
}, 30000);

test('step run --param: a value that is not JSON is kept as a string; a type mismatch is a binding failure (exit 1)', () => {
  const root = scaffold();
  // pr_number is type number; "abc" is not JSON → string → type mismatch.
  const r = stepRun(root, '02-two.md', ['--param', 'pr_number=abc', '--json']);
  expect(r.status).toBe(1); // a real failure (class binding), NOT a usage error
  expect(r.json.ok).toBe(false);
  expect(r.json.class).toBe('binding');
  expect(r.json.record.outcome).toBe('halted');
}, 30000);

test('step run: statics + defaults resolve with no --param at all', () => {
  const root = scaffold();
  const r = stepRun(root, '05-echo.md', ['--json']);
  expect(r.status).toBe(0);
  // default (fail_fast) + static value (labels) both resolved and reached the script.
  expect(r.json.params).toEqual({ fail_fast: true, labels: ['release', 'auto'] });
  expect(r.json.output).toEqual({ fail_fast: true, labels: ['release', 'auto'] });
}, 30000);

test('step run: a type: agent step is refused with a clear exit-2 message', () => {
  const root = scaffold();
  const r = stepRun(root, '03-agent.md');
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('type: agent');
  expect(r.stderr).toContain('a3');
}, 30000);

test('step run: a crashing script fails with exit 1 + class crash + a halted would-be record', () => {
  const root = scaffold();
  const r = stepRun(root, '04-bad.md', ['--json']);
  expect(r.status).toBe(1);
  expect(r.json.ok).toBe(false);
  expect(r.json.class).toBe('crash');
  expect(r.json.failure.exit_code).toBe(3);
  expect(r.json.failure.stderr_tail).toContain('boom happened');
  expect(r.json.feedback_category).toBe('script-failure');
  expect(r.json.record).toMatchObject({ kind: 'step', outcome: 'halted' });
}, 30000);

test('step run: NEVER creates .runtime/ or .feedback/ under the pipeline (success OR failure)', () => {
  const root = scaffold();
  // A success and a failure both write their scratch state to a throwaway temp
  // dir, never the pipeline's own run state.
  expect(stepRun(root, '01-one.md').status).toBe(0);
  expect(stepRun(root, '04-bad.md').status).toBe(1);
  expect(existsSync(join(root, '.runtime'))).toBe(false);
  expect(existsSync(join(root, '.feedback'))).toBe(false);
}, 30000);

test('step run: usage errors — no iteration arg, missing file, not inside a pipeline', () => {
  const root = scaffold();
  // no positional arg
  const noArg = spawnSync(process.execPath, [CLI, 'step', 'run'], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, HOME: root, USERPROFILE: root },
  });
  expect(noArg.status).toBe(2);
  expect(noArg.stderr).toContain('iteration file path is required');

  // missing file
  const missing = stepRun(root, 'does-not-exist.md');
  expect(missing.status).toBe(2);
  expect(missing.stderr).toContain('not found');

  // a file that exists but has no PIPELINE.md ancestor
  const orphanDir = mkdtempSync(join(tmpdir(), 'steprun-orphan-'));
  created.push(orphanDir);
  const orphan = join(orphanDir, 'loose.md');
  writeFileSync(orphan, '---\ntype: script\nscript: x.js\n---\n# x\n');
  const r = spawnSync(process.execPath, [CLI, 'step', 'run', orphan], {
    encoding: 'utf8',
    cwd: orphanDir,
    env: { ...process.env, HOME: orphanDir, USERPROFILE: orphanDir },
  });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('no PIPELINE.md');
}, 30000);

test('step run: an unknown subcommand and unknown flag are exit-2 usage errors', () => {
  const root = scaffold();
  const badSub = spawnSync(process.execPath, [CLI, 'step', 'frobnicate'], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, HOME: root, USERPROFILE: root },
  });
  expect(badSub.status).toBe(2);
  expect(badSub.stderr).toContain("unknown subcommand 'frobnicate'");

  const badFlag = stepRun(root, '01-one.md', ['--bogus']);
  expect(badFlag.status).toBe(2);
  expect(badFlag.stderr).toContain('--bogus');
}, 30000);
