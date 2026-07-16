// T33 (b) — proof that the headless `pipeline drive` runner inherits `type:
// script` steps correctly THROUGH invokeNext (the shared engine), with NO
// duplicated script logic in drive.ts.
//
// Runs runDrive IN-PROCESS through the DriveDeps seams (the drive.test.ts
// pattern): a FakeExecutorRunner writes prescribed records for AGENT steps and
// records every spawn; script steps must execute in-process (zero executor
// spawns). cwd + HOME/USERPROFILE are pointed at the sandbox for the duration
// so the engine's auto-emitted UI events + stats land inside the temp dir.
//
// What this proves:
//   1. mixed agent + script sequential run: the fake executor is spawned ONLY
//      for agent steps; the script step runs in-process (no records/<script>
//      file), its output lands in the outputs store, agent records land, and
//      the run's stats record + per-run log carry the script step.
//   2. a script whose declared `timeout:` exceeds the manager call budget is
//      NOT budget-limited under drive (callBudgetMs: Infinity — drive never
//      emits `continue`).
//   3. a script failure under `on-failure: agent` produces a REAL executor
//      spawn for the same step (the agent fallback), with the §6.2.1 failure
//      record written to disk for that executor to read, and the spawn prompt
//      carries the manager-documented fallback trigger line (DESIGN.md §6.3;
//      agents/pipeline-manager.md "Script-failure fallback run-step").

import { test, expect, afterEach } from 'bun:test';
import { runDrive, type ExecutorRunner } from '../src/commands/drive';
import type { GitRunner } from '../src/lib/git';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
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

// --- fixture scripts (bun-runnable via the interpreter ladder) ---------------

const ONE_JS = `console.log('working…');
console.log(JSON.stringify({ ok: true, summary: 'made pr', flags: { made: true }, output: { pr: 7 } }));
`;
const BAD_JS = `console.error('boom happened');
process.exit(3);
`;

// --- scaffolding -------------------------------------------------------------

interface World {
  project: string; // the consumer project root (git repo, cwd during the run)
  root: string; // the pipeline root, under <project>/.claude/pipeline/demo
  steps: string;
  scripts: string;
}

/** A consumer project holding one pipeline at <project>/.claude/pipeline/demo
 *  (so statsLocation resolves the .stats tree inside the sandbox). */
function mkWorld(manifest = '# P\n\n## End State\nx\n'): World {
  const project = mkdtempSync(join(tmpdir(), 'drivescript-'));
  created.push(project);
  spawnSync('git', ['init', '-q'], { cwd: project });
  const root = join(project, '.claude', 'pipeline', 'demo');
  const steps = join(root, 'steps');
  const scripts = join(root, 'scripts');
  mkdirSync(steps, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), manifest);
  return { project, root, steps, scripts };
}

function scriptStepMd(opts: { script: string; stepId: string; next: string; onFailure?: 'halt' | 'agent'; timeout?: number }): string {
  const fm = [
    '---',
    'type: script',
    `script: ${opts.script}`,
    `step_id: ${opts.stepId}`,
    ...(opts.timeout !== undefined ? [`timeout: ${opts.timeout}`] : []),
    ...(opts.onFailure ? [`on-failure: ${opts.onFailure}`] : []),
    '---',
  ].join('\n');
  return [fm, `# ${opts.stepId}`, '## Goal', 'g', '## Success Criteria', 's', '## Steps', `1. Run: \`bun ${opts.script}\``, '## Next', opts.next, ''].join('\n');
}

function agentStepMd(stepId: string): string {
  return `---\nstep_id: ${stepId}\n---\n# ${stepId}\n## Goal\ng\n## Success Criteria\ns\n`;
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));

interface SpawnCall {
  step_id: string;
  prompt: string;
  model: string | null;
}

/** Run runDrive in-process with a record-writing fake executor. Records every
 *  spawn (proving which steps reached the executor seam). No prescription for a
 *  step → exit 7 (halt), matching the subprocess fake. */
async function drive(
  w: World,
  runId: string,
  startPath: string,
  records: Record<string, unknown>,
  executorGuard?: () => void,
) {
  const calls: SpawnCall[] = [];
  const executor: ExecutorRunner = async (req) => {
    if (executorGuard) executorGuard();
    calls.push({ step_id: req.step_id, prompt: req.prompt, model: req.model });
    const rec = records[req.step_id];
    if (rec === undefined) return { code: 7 };
    writeFileSync(req.record_file, JSON.stringify(rec), 'utf8');
    return { code: 0 };
  };
  const git: GitRunner = () => ({ code: 1, stdout: '', stderr: 'git disabled in this test' });

  let outBuf = '';
  let errBuf = '';
  const prevCwd = process.cwd();
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['HOME', 'USERPROFILE', 'PIPELINE_UI_RUN_ID', 'PIPELINE_UI_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'PIPELINE_STATS_RUNNER'];
  for (const k of envKeys) savedEnv[k] = process.env[k];
  process.chdir(w.project);
  process.env.HOME = w.project;
  process.env.USERPROFILE = w.project;
  delete process.env.PIPELINE_UI_RUN_ID;
  delete process.env.PIPELINE_UI_PARENT_RUN_ID;
  delete process.env.CLAUDE_SESSION_ID;
  try {
    const code = await runDrive(['--root', w.root, '--run-id', runId, '--start', startPath, '--json'], {
      executor,
      git,
      out: (s) => (outBuf += s),
      err: (s) => (errBuf += s),
    });
    let json: any = null;
    try {
      json = JSON.parse(outBuf);
    } catch {
      /* error paths have empty stdout */
    }
    return { code, json, stderr: errBuf, calls };
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --- 1. mixed agent + script run: zero spawns for the script step -------------

test('drive: mixed agent+script run — script executes in-process (no executor spawn); records/outputs/stats land', async () => {
  const w = mkWorld();
  writeFileSync(join(w.scripts, 'one.js'), ONE_JS);
  const sPath = join(w.steps, '02-s.md');
  const bPath = join(w.steps, '03-b.md');
  writeFileSync(join(w.steps, '01-a.md'), agentStepMd('a'));
  writeFileSync(sPath, scriptStepMd({ script: 'scripts/one.js', stepId: 's', next: bPath }));
  writeFileSync(bPath, agentStepMd('b'));

  const run = 'mixed';
  const r = await drive(w, run, join(w.steps, '01-a.md'), {
    a: { kind: 'step', outcome: 'completed', next_iteration: sPath },
    b: { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' },
  });

  expect(r.code).toBe(0);
  expect(r.json.status).toBe('completed');
  // The fake executor was spawned ONLY for the two AGENT steps — never the script.
  expect(r.calls.map((c) => c.step_id)).toEqual(['a', 'b']);
  expect(r.stderr).not.toContain('cannot actuate');

  // The script ran in-process: its §10 output landed in the outputs store, and
  // NO executor record file was written for it (agent steps get one, it doesn't).
  expect(readJson(join(w.root, '.runtime', run, 'outputs', 's.json'))).toEqual({ pr: 7 });
  expect(existsSync(join(w.root, '.runtime', run, 'records', 'a.json'))).toBe(true);
  expect(existsSync(join(w.root, '.runtime', run, 'records', 'b.json'))).toBe(true);
  expect(existsSync(join(w.root, '.runtime', run, 'records', 's.json'))).toBe(false);
  // §8 ledger: the script's finished entry proves in-process execution.
  expect(readJson(join(w.root, '.runtime', run, 'ledger', 's-2.json')).phase).toBe('finished');

  // Stats: the run record + per-run log carry the script step (llm_steps counts
  // only the two agent dispatches).
  const runsFile = join(w.project, '.claude', 'pipeline', '.stats', 'demo', 'runs.jsonl');
  expect(existsSync(runsFile)).toBe(true);
  const rec = JSON.parse(readFileSync(runsFile, 'utf8').trim().split('\n')[0]);
  expect(rec.run_id).toBe(run);
  expect(rec.outcome).toBe('completed');
  expect(rec.runner).toBe('headless');
  expect(rec.steps_run).toBe(3);
  expect(rec.llm_steps).toBe(2); // only the two AGENT dispatches count
  // Exactly one recorded step is tagged step_type:script (the in-process step).
  const scriptStats = rec.steps.filter((s: any) => s.step_type === 'script');
  expect(scriptStats.length).toBe(1);
  const log = readFileSync(join(w.project, '.claude', 'pipeline', '.stats', 'demo', 'runs', `${run}.log`), 'utf8');
  expect(log).toContain('(script)');
}, 30000);

// --- 2. long-timeout script is NOT budget-limited under drive -----------------

test('drive: a script whose timeout exceeds the manager budget still runs in one shot (infinite budget seam)', async () => {
  // timeout 700s > CALL_BUDGET (480s) and > MANAGER_SAFE_TIMEOUT (420s): under
  // the manager this would run with a TRUNCATED deadline (~435s, the best a
  // window can give); drive passes callBudgetMs Infinity, so it runs with its
  // full declared timeout and completes.
  const w = mkWorld();
  writeFileSync(join(w.scripts, 'one.js'), ONE_JS);
  writeFileSync(join(w.steps, '01-slow.md'), scriptStepMd({ script: 'scripts/one.js', stepId: 'slow', next: 'Pipeline complete.', timeout: 700 }));

  let spawned = false;
  const r = await drive(w, 'longto', join(w.steps, '01-slow.md'), {}, () => {
    spawned = true;
  });

  expect(spawned).toBe(false); // never spawned an executor
  expect(r.code).toBe(0);
  expect(r.json.status).toBe('completed');
  // Drive never saw `continue` (it cannot actuate it) — a budget-limited run
  // would have surfaced that instead of completing.
  expect(r.stderr).not.toContain('cannot actuate');
  expect(r.stderr).not.toContain('continue');
  expect(readJson(join(w.root, '.runtime', 'longto', 'outputs', 'slow.json'))).toEqual({ pr: 7 });
}, 30000);

// --- 3. on-failure: agent → a REAL executor spawn for the fallback ------------

test('drive: a script failing under on-failure:agent re-dispatches as a REAL executor spawn; failure record on disk', async () => {
  const w = mkWorld();
  writeFileSync(join(w.scripts, 'bad.js'), BAD_JS);
  const afterPath = join(w.steps, '02-after.md');
  writeFileSync(join(w.steps, '01-flaky.md'), scriptStepMd({ script: 'scripts/bad.js', stepId: 'flaky', next: afterPath, onFailure: 'agent' }));
  writeFileSync(afterPath, agentStepMd('after'));

  const run = 'fallback';
  // The fallback executor "achieves the Goal manually" → completed → advances
  // to the next agent step; that one completes the run.
  const r = await drive(w, run, join(w.steps, '01-flaky.md'), {
    flaky: { kind: 'step', outcome: 'completed', next_iteration: afterPath },
    after: { kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' },
  });

  expect(r.code).toBe(0);
  expect(r.json.status).toBe('completed');
  // The failed script was NOT re-executed as a script — it re-dispatched as an
  // AGENT step, so the fake executor WAS spawned for it (a real spawn), then the
  // following agent step. The script never ran through the executor seam.
  expect(r.calls.map((c) => c.step_id)).toEqual(['flaky', 'after']);
  // The fallback spawn is an ordinary step-executor spawn prompt.
  expect(r.calls[0].prompt).toContain('Execute pipeline iteration');

  // §6.2.1 failure record written IN-PROCESS to the pipeline's run state — this
  // is the `failure_record` the fallback executor is meant to read (keyed
  // <step_id>-<dispatch_index>-<attempt>).
  const failurePath = join(w.root, '.runtime', run, 'failures', 'flaky-1-1.json');
  expect(existsSync(failurePath)).toBe(true);
  const failure = readJson(failurePath);
  expect(failure.class).toBe('crash');
  expect(existsSync(join(w.root, '.runtime', run, 'failures', 'flaky-1-1.log'))).toBe(true);

  // §6.3 — the fallback spawn's prompt carries the ONE manager-documented
  // trigger line (with the on-disk failure-record path), so the executor runs
  // its fallback protocol; the following normal agent spawn does NOT.
  expect(r.calls[0].prompt).toContain(
    `This step's script failed; failure record at ${failurePath}; achieve the iteration's Goal per your fallback protocol.`,
  );
  expect(r.calls[1].prompt).not.toContain('fallback protocol');
}, 30000);
