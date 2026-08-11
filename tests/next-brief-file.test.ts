// `pipeline next --brief-file` (E5, execution-modes/01-modes.md; taskflow task
// b1-next-brief-file): writes the full action `pipeline next` would otherwise
// print to a file under `.runtime/<run-id>/briefs/`, and prints only the
// three-key control signal `{action, brief_file, phase}` on stdout. Scoped to
// `session` mode in the sense that the context saving is real there — nothing
// here restricts the flag to it.
//
// This file proves the task's Definition of Done:
//   1. Absent the flag, stdout is byte-for-byte the plain action JSON — no
//      brief_file/phase leak (a regression this exact change could introduce).
//   2. EVERY action kind round-trips under the flag — run-step, merge,
//      run-improver, run-script-creator, retrospective, the worktree
//      lifecycle (provision/finalize/teardown), continue, done, halt,
//      blocked — proving the flag changes DELIVERY only, never WHICH action
//      the engine produced.
//   3. The brief file alone carries everything a step executor needs — driven
//      end-to-end from the file's own contents, not asserted from memory.
//   4. USAGE documents the flag and its `session`-mode scope.
//
// Two driving strategies, matching this repo's own precedent:
//   - True CLI subprocess (spawnSync through src/cli.ts) for every action kind
//     reachable through ordinary flags — exercises the REAL parseArgs wiring,
//     matching next.test.ts's / record-file.test.ts's own CLI helpers.
//   - Direct `invokeNext` + the exported `writeBriefFile` for `continue`
//     ONLY: the §7 call-budget hand-off needs `callBudgetMs`, a test seam on
//     `InvokeNextArgs` that `pipeline next`'s argv never exposes (mirrors
//     script-exec-integration.test.ts's own `continue` coverage). This still
//     exercises the real production `writeBriefFile` against a genuine
//     engine-produced `{action, out}` pair — never a hand-rolled fake.

import { test, expect, afterEach } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import { invokeNext, writeBriefFile } from '../src/commands/next';
import type { NextRecord } from '../src/lib/next';
import type { ProcessRunner } from '../src/lib/script-step';
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
});

// ---------------------------------------------------------------------------
// Scaffolding — deliberately duplicated from next.test.ts rather than
// imported (this repo's test files are each self-contained; see
// next-step-name.test.ts's identical note).
// ---------------------------------------------------------------------------

function scaffoldSequential(n = 3): string {
  const root = mkdtempSync(join(tmpdir(), 'brief-seq-'));
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

function scaffoldExternal(n = 1, opts: { finalize?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'brief-ext-'));
  created.push(root);
  const fin = opts.finalize ? `\nfinalize: true` : '';
  writeFileSync(join(root, 'PIPELINE.md'), `---\nisolation: external${fin}\n---\n# P\n\n## End State\nx\n`);
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(2, '0');
    writeFileSync(join(steps, `${id}-step.md`), `# step ${id}\n`);
  }
  return root;
}

// A fan-out/join parallel shape: [setup] -> [x, y] -> [z], worktree isolation
// (plan.ts's default for `execution: parallel`) — the merge action's fixture.
function scaffoldParallel(): string {
  const root = mkdtempSync(join(tmpdir(), 'brief-par-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), `---\nexecution: parallel\n---\n# P\n\n## End State\nx\n`);
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(steps, '01-setup.md'), '---\nstep_id: setup\n---\n# setup\n');
  writeFileSync(join(steps, '02-x.md'), '---\nstep_id: x\ndepends-on: [setup]\n---\n# x\n');
  writeFileSync(join(steps, '03-y.md'), '---\nstep_id: y\ndepends-on: [setup]\n---\n# y\n');
  writeFileSync(join(steps, '04-z.md'), '---\nstep_id: z\ndepends-on: [x, y]\n---\n# z\n');
  return root;
}

// ---------------------------------------------------------------------------
// CLI subprocess helper — mirrors next.test.ts's `next()` / record-file.
// test.ts's `nextRaw()`: controlled cwd + env so auto-emitted UI events land
// inside the temp dir, never the repo or the real ~/.claude.
// ---------------------------------------------------------------------------

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

function nextRaw(root: string, runId: string, extra: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PIPELINE_RUN_ID;
  delete env.PIPELINE_PARENT_RUN_ID;
  delete env.CLAUDE_SESSION_ID;
  for (const k of Object.keys(env)) if (k.startsWith('PP_')) delete env[k];
  env.USERPROFILE = root;
  env.HOME = root;
  // process.execPath (the real bun binary), NOT the string 'bun': with an npm
  // shim install, spawnSync('bun', …) defeats Bun's self-spawn special case.
  return spawnSync(process.execPath, [CLI, 'next', '--root', root, '--run-id', runId, ...extra], {
    encoding: 'utf8',
    cwd: root,
    env,
  });
}

function next(root: string, runId: string, extra: string[]) {
  const r = nextRaw(root, runId, extra);
  return { json: r.stdout.trim() ? JSON.parse(r.stdout) : null, status: r.status, stderr: r.stderr };
}

const record = (r: object) => ['--record', JSON.stringify(r)];

/** Assert `control` is EXACTLY the three-key shape the design mandates — no
 *  more, no less (an extra field defeats the flag's purpose). */
function expectControlShape(control: any, expectedAction: string) {
  expect(Object.keys(control).sort()).toEqual(['action', 'brief_file', 'phase']);
  expect(control.action).toBe(expectedAction);
  expect(typeof control.brief_file).toBe('string');
  expect(typeof control.phase).toBe('string');
}

/** Read + parse a brief file, asserting it lives under the run's
 *  `.runtime/<run-id>/briefs/` home and is named `<NN>.json`. */
function readBrief(root: string, runId: string, briefFile: string): any {
  const norm = (p: string) => p.replace(/\\/g, '/');
  expect(norm(briefFile)).toContain(norm(join(root, '.runtime', runId, 'briefs')));
  expect(briefFile).toMatch(/\d+\.json$/);
  expect(existsSync(briefFile)).toBe(true);
  return JSON.parse(readFileSync(briefFile, 'utf8'));
}

// ---------------------------------------------------------------------------
// 1. Absent the flag, stdout is unchanged (no brief_file/phase leak)
// ---------------------------------------------------------------------------

test('absent --brief-file: stdout is the plain action JSON, no brief_file/phase key ever appears', () => {
  const root = scaffoldSequential(2);
  const run = 'noflag';
  const plan = computePlan(root);

  let r = next(root, run, []);
  expect(r.json.action).toBe('run-step');
  expect(r.json.steps[0].path).toBe(plan.steps[0].path);
  expect(Object.keys(r.json).sort()).toEqual(['action', 'concurrent', 'mode', 'steps'].sort());
  expect(r.json.brief_file).toBeUndefined();
  expect(r.json.phase).toBeUndefined();

  r = next(root, run, record({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path }));
  expect(r.json.action).toBe('run-step');
  expect(Object.keys(r.json).sort()).toEqual(['action', 'concurrent', 'mode', 'steps'].sort());

  r = next(root, run, record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }));
  expect(r.json.action).toBe('done');
  expect(r.status).toBe(0);
  expect(Object.keys(r.json).sort()).toEqual(['action', 'mode'].sort());
});

// ---------------------------------------------------------------------------
// 2. USAGE documents the flag and its session-mode scope
// ---------------------------------------------------------------------------

test('USAGE documents --brief-file and states it is scoped to session mode', () => {
  const r = spawnSync(process.execPath, [CLI, 'next', '--help'], { encoding: 'utf8' });
  expect(r.stdout).toContain('--brief-file');
  expect(r.stdout.toLowerCase()).toContain('session');
});

// ---------------------------------------------------------------------------
// 3. run-step + done: the everyday sequential loop, and DoD #3 — driving a
//    step FROM THE BRIEF FILE ALONE (no field consulted outside it).
// ---------------------------------------------------------------------------

test('run-step under --brief-file: the file alone carries everything a step executor needs, and driving from it alone completes the run', () => {
  const root = scaffoldSequential(2);
  const run = 'drivefromfile';
  const plan = computePlan(root);

  let r = next(root, run, ['--brief-file']);
  expect(r.status).toBe(0);
  expectControlShape(r.json, 'run-step');
  expect(r.json.phase).toBe('await-step');
  const briefFile1 = r.json.brief_file;

  const brief1 = readBrief(root, run, r.json.brief_file);
  // Everything a step executor needs, present in the FILE (never read from
  // r.json — the caller never saw any of this on stdout).
  expect(brief1.action).toBe('run-step');
  expect(brief1.concurrent).toBe(false);
  const step1 = brief1.steps[0];
  expect(typeof step1.step_id).toBe('string');
  expect(typeof step1.path).toBe('string');
  expect(typeof step1.source_path).toBe('string');
  expect(typeof step1.step_uuid).toBe('string');
  expect(typeof step1.index).toBe('number');
  expect(step1.type).toBe('agent');
  expect('model' in step1).toBe(true);
  expect('effort' in step1).toBe(true);

  // "Drive the step": read ONLY what the brief gave us, confirm the prompt
  // file it points at is real and on disk (the executor's own next act).
  expect(existsSync(step1.path)).toBe(true);
  expect(step1.path).toBe(plan.steps[0].path);
  expect(readFileSync(step1.path, 'utf8')).toContain('step 01');

  // Report completion (the manager's own knowledge of the chain — the SAME
  // shape a real executor reports today, brief-file or not) → step 2.
  r = next(root, run, ['--brief-file', ...record({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path })]);
  expectControlShape(r.json, 'run-step');
  const brief2 = readBrief(root, run, r.json.brief_file);
  expect(brief2.steps[0].step_id).not.toBe(step1.step_id);
  expect(brief2.steps[0].path).toBe(plan.steps[1].path);
  // A fresh brief file, not an overwrite of the first — both still readable.
  expect(r.json.brief_file).not.toBe(briefFile1);
  expect(existsSync(briefFile1)).toBe(true);
  expect(readBrief(root, run, briefFile1)).toEqual(brief1);

  // Finish the run purely off what the second brief said.
  r = next(
    root,
    run,
    ['--brief-file', ...record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' })],
  );
  expectControlShape(r.json, 'done');
  expect(r.json.phase).toBe('terminal');
  expect(r.status).toBe(0);
  const brief3 = readBrief(root, run, r.json.brief_file);
  expect(brief3).toEqual({ action: 'done', mode: 'sequential' });
});

// ---------------------------------------------------------------------------
// 4. blocked
// ---------------------------------------------------------------------------

test('blocked under --brief-file round-trips', () => {
  const root = scaffoldSequential(1);
  const run = 'blockedbrief';
  next(root, run, []); // init → step 1 (no --brief-file: proves the flag is per-call, not sticky)

  const r = next(root, run, ['--brief-file', ...record({ kind: 'step', outcome: 'blocked-delegating' })]);
  expectControlShape(r.json, 'blocked');
  expect(r.json.phase).toBe('blocked');
  const brief = readBrief(root, run, r.json.brief_file);
  expect(brief).toEqual({ action: 'blocked', mode: 'sequential' });
});

// ---------------------------------------------------------------------------
// 5. halt
// ---------------------------------------------------------------------------

test('halt under --brief-file round-trips (exit 1 preserved)', () => {
  const root = scaffoldSequential(1);
  const run = 'haltbrief';
  next(root, run, []); // init → step 1

  const r = next(root, run, ['--brief-file', ...record({ kind: 'step', outcome: 'halted', halt_reason: 'boom' })]);
  expect(r.status).toBe(1); // the exit code is UNCHANGED by the flag
  expectControlShape(r.json, 'halt');
  expect(r.json.phase).toBe('terminal');
  const brief = readBrief(root, run, r.json.brief_file);
  expect(brief.action).toBe('halt');
  expect(brief.reason).toBe('boom');
});

// ---------------------------------------------------------------------------
// 6. run-improver + run-script-creator
// ---------------------------------------------------------------------------

test('run-improver and run-script-creator under --brief-file round-trip', () => {
  const root = scaffoldSequential(2);
  const run = 'improverbrief';
  const plan = computePlan(root);
  next(root, run, []); // init → step 1

  let r = next(root, run, [
    '--brief-file',
    ...record({ kind: 'step', outcome: 'completed', next_iteration: plan.steps[1].path, has_improvement_brief: true }),
  ]);
  expectControlShape(r.json, 'run-improver');
  expect(r.json.phase).toBe('await-improver');
  let brief = readBrief(root, run, r.json.brief_file);
  expect(brief.action).toBe('run-improver');
  expect(brief.iteration_path).toBe(plan.steps[0].path);
  expect(typeof brief.step_uuid).toBe('string');

  r = next(root, run, ['--brief-file', ...record({ kind: 'improver', script_briefs: 2 })]);
  expectControlShape(r.json, 'run-script-creator');
  expect(r.json.phase).toBe('await-script');
  brief = readBrief(root, run, r.json.brief_file);
  expect(brief.action).toBe('run-script-creator');
  expect(brief.number).toBe(1);
  expect(brief.of).toBe(2);

  r = next(root, run, ['--brief-file', ...record({ kind: 'script', outcome: 'created' })]);
  expectControlShape(r.json, 'run-script-creator');
  brief = readBrief(root, run, r.json.brief_file);
  expect(brief.number).toBe(2);

  // Finish this script-creator batch → advances to step 2.
  r = next(root, run, ['--brief-file', ...record({ kind: 'script', outcome: 'created' })]);
  expectControlShape(r.json, 'run-step');
  brief = readBrief(root, run, r.json.brief_file);
  expect(brief.steps[0].path).toBe(plan.steps[1].path);
});

// ---------------------------------------------------------------------------
// 7. retrospective
// ---------------------------------------------------------------------------

test('retrospective under --brief-file round-trips (feedback-gated)', () => {
  const root = scaffoldSequential(1);
  const run = 'retrobrief';
  // A feedback file makes the retrospective gate fire on the terminal step.
  const fbDir = join(root, '.feedback', run);
  mkdirSync(fbDir, { recursive: true });
  writeFileSync(join(fbDir, 'note.md'), '# something worth reviewing\n');

  next(root, run, []); // init → step 1

  let r = next(root, run, [
    '--brief-file',
    ...record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' }),
  ]);
  expectControlShape(r.json, 'retrospective');
  expect(r.json.phase).toBe('await-retro');
  const brief = readBrief(root, run, r.json.brief_file);
  expect(brief).toEqual({ action: 'retrospective', mode: 'sequential' });

  r = next(root, run, ['--brief-file', ...record({ kind: 'retro', done: true })]);
  expectControlShape(r.json, 'done');
  expect(r.status).toBe(0);
});

// ---------------------------------------------------------------------------
// 8. merge (parallel + worktree isolation)
// ---------------------------------------------------------------------------

test('merge under --brief-file round-trips (parallel fan-out/join, worktree isolation)', () => {
  const root = scaffoldParallel();
  const run = 'mergebrief';

  let r = next(root, run, ['--brief-file']); // → [setup]
  expectControlShape(r.json, 'run-step');
  let brief = readBrief(root, run, r.json.brief_file);
  expect(brief.steps.map((s: any) => s.step_id)).toEqual(['setup']);

  // ANY worktree-isolated layer completion carrying a branch triggers 'merge'
  // FIRST, even a lone-member layer like [setup] — not only the fan-in join
  // (lib/next.ts's onLayerRecord merges committed branches before advancing,
  // unconditionally in worktree mode; see next.test.ts's completeLayer()
  // helper, which resolves this same merge on every layer transparently).
  r = next(root, run, [
    '--brief-file',
    ...record({ kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed', worktree_branch: 'wt-setup', worktree_path: '/wt/setup' }] }),
  ]); // → merge (of [setup]'s own branch)
  expectControlShape(r.json, 'merge');
  brief = readBrief(root, run, r.json.brief_file);
  expect(brief.branches.map((b: any) => b.branch)).toEqual(['wt-setup']);

  r = next(root, run, ['--brief-file', ...record({ kind: 'merge', conflict: false })]); // → [x, y]
  expectControlShape(r.json, 'run-step');
  brief = readBrief(root, run, r.json.brief_file);
  expect(brief.steps.map((s: any) => s.step_id).sort()).toEqual(['x', 'y']);
  expect(brief.steps.every((s: any) => s.isolation === 'worktree')).toBe(true);

  r = next(root, run, [
    '--brief-file',
    ...record({
      kind: 'layer',
      results: [
        { step_id: 'x', outcome: 'completed', worktree_branch: 'wt-x', worktree_path: '/wt/x' },
        { step_id: 'y', outcome: 'completed', worktree_branch: 'wt-y', worktree_path: '/wt/y' },
      ],
    }),
  ]); // → merge
  expectControlShape(r.json, 'merge');
  expect(r.json.phase).toBe('await-merge');
  brief = readBrief(root, run, r.json.brief_file);
  expect(brief.action).toBe('merge');
  expect(brief.branches.map((b: any) => b.branch).sort()).toEqual(['wt-x', 'wt-y']);

  r = next(root, run, ['--brief-file', ...record({ kind: 'merge', conflict: false })]); // → [z]
  expectControlShape(r.json, 'run-step');
  brief = readBrief(root, run, r.json.brief_file);
  expect(brief.steps.map((s: any) => s.step_id)).toEqual(['z']);
});

// ---------------------------------------------------------------------------
// 9. provision-worktree / finalize-worktree / teardown-worktree
//    (--manual-hooks surfaces the raw actions — mirrors next.test.ts's own
//    "(--manual-hooks): external run drives provision → step → teardown →
//    done" and "finalize:true …" CLI tests, plus --brief-file.)
// ---------------------------------------------------------------------------

test('the external worktree lifecycle (provision/teardown) round-trips under --brief-file + --manual-hooks', () => {
  const root = scaffoldExternal(1);
  const run = 'extbrief';
  const plan = computePlan(root);

  let r = next(root, run, ['--manual-hooks', '--brief-file']);
  expectControlShape(r.json, 'provision-worktree');
  expect(r.json.phase).toBe('await-provision');
  let brief = readBrief(root, run, r.json.brief_file);
  expect(brief.action).toBe('provision-worktree');
  expect(brief.run_id).toBe(run);
  expect(brief.name).toBe(run);
  expect(brief.hook_dir).toBe('.pipeline/.hooks');

  const prov = { kind: 'worktree', phase: 'provisioned', worktree_path: '/wt/extbrief', branch: 'worktree-extbrief', env_file: null };
  r = next(root, run, ['--manual-hooks', '--brief-file', ...record(prov)]);
  expectControlShape(r.json, 'run-step');
  brief = readBrief(root, run, r.json.brief_file);
  expect(brief.steps[0].path).toBe(plan.steps[0].path);
  expect(brief.steps[0].external_worktree).toBe(true);
  expect(brief.steps[0].worktree_path).toBe('/wt/extbrief');

  r = next(root, run, ['--manual-hooks', '--brief-file', ...record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' })]);
  expectControlShape(r.json, 'teardown-worktree');
  expect(r.json.phase).toBe('await-teardown');
  brief = readBrief(root, run, r.json.brief_file);
  expect(brief.action).toBe('teardown-worktree');
  expect(brief.worktree_path).toBe('/wt/extbrief');

  r = next(root, run, ['--manual-hooks', '--brief-file', ...record({ kind: 'worktree', phase: 'torn-down', ok: true })]);
  expectControlShape(r.json, 'done');
  expect(r.status).toBe(0);
});

test('finalize-worktree round-trips under --brief-file + --manual-hooks (finalize: true)', () => {
  const root = scaffoldExternal(1, { finalize: true });
  const run = 'finbrief';

  let r = next(root, run, ['--manual-hooks', '--brief-file']);
  expectControlShape(r.json, 'provision-worktree');

  const prov = { kind: 'worktree', phase: 'provisioned', worktree_path: '/wt/finbrief', branch: 'b', env_file: null };
  r = next(root, run, ['--manual-hooks', '--brief-file', ...record(prov)]);
  expectControlShape(r.json, 'run-step');

  r = next(root, run, ['--manual-hooks', '--brief-file', ...record({ kind: 'step', outcome: 'completed', next_iteration: 'PIPELINE_COMPLETE' })]);
  expectControlShape(r.json, 'finalize-worktree');
  expect(r.json.phase).toBe('await-finalize');
  let brief = readBrief(root, run, r.json.brief_file);
  expect(brief.action).toBe('finalize-worktree');
  expect(brief.worktree_path).toBe('/wt/finbrief');
  expect(brief.run_id).toBe(run);

  r = next(root, run, ['--manual-hooks', '--brief-file', ...record({ kind: 'worktree', phase: 'finalized', ok: true })]);
  expectControlShape(r.json, 'teardown-worktree');

  r = next(root, run, ['--manual-hooks', '--brief-file', ...record({ kind: 'worktree', phase: 'torn-down', ok: true })]);
  expectControlShape(r.json, 'done');
  expect(r.status).toBe(0);
});

// ---------------------------------------------------------------------------
// 10. continue (§7 call-budget hand-off) — driven via invokeNext + the
//     exported writeBriefFile directly (callBudgetMs is not CLI-exposed).
//     Fixture mirrors script-exec-integration.test.ts's own `continue`
//     coverage (duplicated here per this repo's self-contained-file rule).
// ---------------------------------------------------------------------------

function scriptStepMd(opts: { script: string; stepId: string; next?: string; timeout?: number }): string {
  const fm = ['---', 'type: script', `script: ${opts.script}`, `step_id: ${opts.stepId}`, `timeout: ${opts.timeout ?? 60}`, '---'].join('\n');
  return [fm, `# ${opts.stepId}`, '## Goal', 'g', '## Success Criteria', 's', '## Steps', `1. Run: \`bun ${opts.script}\`.`, ...(opts.next ? ['## Next', opts.next] : []), ''].join('\n');
}

function fakeRunner(results: Array<{ stdout: string; sleepMs?: number }>): { runner: ProcessRunner; calls: () => number } {
  let n = 0;
  const runner: ProcessRunner = () => {
    const r = results[Math.min(n, results.length - 1)];
    n += 1;
    if (r.sleepMs) {
      const end = Date.now() + r.sleepMs;
      while (Date.now() < end) {
        // deterministic wall-clock advance for the §7 budget check
      }
    }
    return { code: 0, stdout: r.stdout, stderr: '', timedOut: false };
  };
  return { runner, calls: () => n };
}

const okStdout = (extra: Record<string, unknown> = {}) => JSON.stringify({ ok: true, ...extra });

test('continue under --brief-file round-trips (§7 call-budget hand-off, driven via invokeNext + writeBriefFile directly)', () => {
  const project = mkdtempSync(join(tmpdir(), 'brief-cont-proj-'));
  created.push(project);
  spawnSync('git', ['init', '-q'], { cwd: project });
  const root = join(project, '.pipeline', 'demo');
  const steps = join(root, 'steps');
  const scripts = join(root, 'scripts');
  mkdirSync(steps, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  const twoAbs = join(steps, '02-b.md');
  writeFileSync(join(steps, '01-a.md'), scriptStepMd({ script: 'scripts/a.js', stepId: 'a', next: twoAbs, timeout: 10 }));
  writeFileSync(twoAbs, scriptStepMd({ script: 'scripts/b.js', stepId: 'b', next: 'Pipeline complete.', timeout: 28 }));

  // budget = margin + a 30s fresh window; script 'a' busy-waits 4s (>10% of
  // the fresh window), so 'b' (declared 28s) no longer fits the ~26s left AND
  // a fresh window is materially better → park + {action:'continue'}.
  const budget = 45_000 + 30_000;
  const fake = fakeRunner([{ stdout: okStdout(), sleepMs: 4_000 }, { stdout: okStdout() }]);

  const prevCwd = process.cwd();
  const home = mkdtempSync(join(tmpdir(), 'brief-cont-home-'));
  created.push(home);
  const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.chdir(project);
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const res = invokeNext({ root, runId: 'contbrief', callBudgetMs: budget, scriptRunner: fake.runner });
    expect(res.action.action).toBe('continue');
    expect(res.out.action).toBe('continue');

    // The exported production function — the SAME one runNext calls under
    // --brief-file — against a genuine engine-produced result.
    const control = writeBriefFile(root, 'contbrief', res.out, res.action);
    expectControlShape(control, 'continue');
    expect(control.phase).toBe('await-step'); // the pending script dispatch was already parked here
    const brief = readBrief(root, 'contbrief', control.brief_file);
    expect(brief).toEqual(res.out); // byte-identical to what would've printed without the flag
  } finally {
    process.chdir(prevCwd);
    if (savedEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = savedEnv.HOME;
    if (savedEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedEnv.USERPROFILE;
  }
}, 30_000);
