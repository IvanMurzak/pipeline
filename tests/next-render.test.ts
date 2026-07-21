// next-render.test.ts — lazy rendered shadow copies for agent steps
// (env-variables design 05 §5/§8, D6 — P4/a5), via the command layer
// (invokeNext), which owns rendering:
//
//   - rendered tree layout under `.runtime/<run>/rendered/<slug>/` +
//     `source_path` correctness (path = rendered, source_path = source)
//   - PIPELINE.md body rendered, frontmatter RAW (byte-preserved)
//   - F5: lazy per-action re-render picks up mid-run source edits (and
//     self-heals a deleted rendered tree, F4)
//   - E12 mechanism (a): non-substituted siblings (scripts/**, other steps,
//     fixtures) are MIRRORED into the rendered tree so relative refs resolve;
//     stale entries (deleted sources, crashed .tmp files) are pruned
//   - E9 zero-change: no declarations ⇒ no rendered folder, path === source_path
//   - 07/08 P4 gate: the render-time occurrence re-check halts as an F2-style
//     run halt (never a substituteText throw)
//   - F10: an unwritable rendered dir fails the action cleanly (no partial tree)
//   - E11: script steps keep path === source_path — ledger/`## Next`/planStepFor
//     keying stays green in a mixed rendered run; events/stats label steps by
//     SOURCE path so started/completed pairs never de-pair

import { test, expect, afterEach } from 'bun:test';
import { invokeNext } from '../src/commands/next';
import type { NextState } from '../src/lib/next';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
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

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// World scaffolding (the script-exec-integration harness): a consumer project
// with one pipeline at <project>/.claude/pipeline/demo/, driven with cwd
// swapped to the project. The rendered slug is therefore 'demo'.
// ---------------------------------------------------------------------------

interface World {
  project: string;
  home: string;
  root: string;
  steps: string;
  scripts: string;
}

function mkWorld(manifest: string): World {
  const project = mkTmp('rend-proj-');
  const home = mkTmp('rend-home-');
  // A real .git dir pins resolveProjectRoot (lib/event.ts) to THIS project so
  // the event journal lands here, never in an enclosing repo.
  spawnSync('git', ['init', '-q'], { cwd: project });
  const root = join(project, '.claude', 'pipeline', 'demo');
  const steps = join(root, 'steps');
  const scripts = join(root, 'scripts');
  mkdirSync(steps, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), manifest);
  return { project, home, root, steps, scripts };
}

/** Swap cwd to the project + isolate HOME/USERPROFILE + clear the event
 *  writer's envelope vars + SCRUB every ambient PP_* env var (a stray value in
 *  the developer's shell must never satisfy or alter a fixture resolution). */
function inProject<T>(w: World, fn: () => T): T {
  const prevCwd = process.cwd();
  const keys = ['PIPELINE_UI_RUN_ID', 'PIPELINE_UI_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'PIPELINE_UI_DEBUG', 'USERPROFILE', 'HOME'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  const savedPp: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('PP_')) {
      savedPp[k] = process.env[k];
      delete process.env[k];
    }
  }
  try {
    process.chdir(w.project);
    delete process.env.PIPELINE_UI_RUN_ID;
    delete process.env.PIPELINE_UI_PARENT_RUN_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.PIPELINE_UI_DEBUG;
    process.env.USERPROFILE = w.home;
    process.env.HOME = w.home;
    return fn();
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const [k, v] of Object.entries(savedPp)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const stateOf = (w: World, runId: string): NextState => readJson(join(w.root, '.runtime', runId, 'next.json'));
const renderedRoot = (w: World, runId: string): string => join(w.root, '.runtime', runId, 'rendered', 'demo');

function readEvents(w: World): any[] {
  const f = join(w.project, '.claude', 'pipeline', '.runtime', 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l: string) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Manifest WITH frontmatter (must ride RAW into the rendered copy), a
 *  substitutable body line, and a ## Variables section. */
const VARS_MANIFEST = [
  '---',
  'runner: manager',
  '---',
  '# P',
  '',
  '## End State',
  'Release ${PP_SERVICE}.',
  '',
  '## Variables',
  '- PP_SERVICE (required) — service under release',
  '- PP_OPT — optional knob',
  '',
].join('\n');

const STEP1_SRC = [
  '---',
  'step_id: s1',
  '---',
  '# a',
  '',
  'Deploy ${PP_SERVICE}. Opt: ${PP_OPT:-none}. Literal: $${PP_SERVICE}.',
  'See scripts/notify.py.',
  '',
].join('\n');

const STEP1_RENDERED = [
  '---',
  'step_id: s1',
  '---',
  '# a',
  '',
  'Deploy payments. Opt: none. Literal: ${PP_SERVICE}.',
  'See scripts/notify.py.',
  '',
].join('\n');

const STEP2_SRC = ['---', 'step_id: s2', '---', '# b', '', 'Announce ${PP_SERVICE}.', ''].join('\n');

function scaffoldVarsWorld(): World {
  const w = mkWorld(VARS_MANIFEST);
  writeFileSync(join(w.steps, '01-a.md'), STEP1_SRC);
  writeFileSync(join(w.steps, '02-b.md'), STEP2_SRC);
  writeFileSync(join(w.scripts, 'notify.py'), 'print("hi")\n');
  return w;
}

// ---------------------------------------------------------------------------
// 1. Rendered tree layout, source_path, step + PIPELINE.md content
// ---------------------------------------------------------------------------

test('agent step renders into .runtime/<run>/rendered/<slug>/ — path/source_path split; step + PIPELINE.md bodies substituted, frontmatter raw', () => {
  const w = scaffoldVarsWorld();
  inProject(w, () => {
    const res = invokeNext({ root: w.root, runId: 'r1', cliVars: { PP_SERVICE: 'payments' } });
    expect(res.code).toBe(0);
    if (res.action.action !== 'run-step') throw new Error(`expected run-step, got ${res.action.action}`);
    const step = res.action.steps[0]!;

    // path = the rendered copy (absolute, worktree-safe E8); source_path = source.
    const expectedRendered = join(renderedRoot(w, 'r1'), 'steps', '01-a.md');
    expect(resolve(step.path)).toBe(resolve(expectedRendered));
    expect(resolve(step.source_path)).toBe(resolve(join(w.steps, '01-a.md')));
    expect(step.path).not.toBe(step.source_path);

    // Step: frontmatter byte-preserved, body substituted, $$ escape honored.
    expect(readFileSync(step.path, 'utf8')).toBe(STEP1_RENDERED);
    // Source untouched (sources stay authoritative, D6).
    expect(readFileSync(join(w.steps, '01-a.md'), 'utf8')).toBe(STEP1_SRC);

    // PIPELINE.md: frontmatter raw, body substituted, ## Variables intact.
    const manifest = readFileSync(join(renderedRoot(w, 'r1'), 'PIPELINE.md'), 'utf8');
    expect(manifest.startsWith('---\nrunner: manager\n---\n')).toBe(true);
    expect(manifest).toContain('Release payments.');
    expect(manifest).toContain('- PP_SERVICE (required)');

    // Atomic writes leave no temp files behind.
    expect(
      readdirSync(join(renderedRoot(w, 'r1'), 'steps')).some((n) => n.includes('render-tmp') || n.endsWith('.tmp')),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. F5 — lazy re-render picks up mid-run source edits (and F4 self-heal)
// ---------------------------------------------------------------------------

test('F5: improver-style source edits are re-rendered on the next action; a deleted rendered tree self-heals', () => {
  const w = scaffoldVarsWorld();
  inProject(w, () => {
    const first = invokeNext({ root: w.root, runId: 'r2', cliVars: { PP_SERVICE: 'payments' } });
    if (first.action.action !== 'run-step') throw new Error('expected run-step');
    const renderedPath = first.action.steps[0]!.path;
    expect(readFileSync(renderedPath, 'utf8')).toBe(STEP1_RENDERED);

    // Mid-run edit of the CURRENT step's source (Tier-1 improver, E3), then a
    // no-record auto-resume re-emits the dispatch: the copy MUST be fresh.
    writeFileSync(join(w.steps, '01-a.md'), '---\nstep_id: s1\n---\n# a\n\nIMPROVED ${PP_SERVICE}.\n');
    const again = invokeNext({ root: w.root, runId: 'r2' });
    if (again.action.action !== 'run-step') throw new Error('expected run-step');
    expect(again.action.steps[0]!.path).toBe(renderedPath);
    expect(readFileSync(renderedPath, 'utf8')).toBe('---\nstep_id: s1\n---\n# a\n\nIMPROVED payments.\n');

    // Edit the NEXT step's source before it is dispatched — its render is lazy,
    // so the executor sees the improvement AND the substitution (03 F5).
    writeFileSync(join(w.steps, '02-b.md'), '---\nstep_id: s2\n---\n# b\n\nAnnounce ${PP_SERVICE} loudly.\n');
    const second = invokeNext({
      root: w.root,
      runId: 'r2',
      record: { kind: 'step', outcome: 'completed', flags: null, next_iteration: join(w.steps, '02-b.md') },
    });
    if (second.action.action !== 'run-step') throw new Error('expected run-step');
    const step2 = second.action.steps[0]!;
    expect(resolve(step2.source_path)).toBe(resolve(join(w.steps, '02-b.md')));
    expect(readFileSync(step2.path, 'utf8')).toBe('---\nstep_id: s2\n---\n# b\n\nAnnounce payments loudly.\n');

    // F4: rendered files are disposable — delete the whole tree, resume, healed.
    rmSync(renderedRoot(w, 'r2'), { recursive: true, force: true });
    const healed = invokeNext({ root: w.root, runId: 'r2' });
    if (healed.action.action !== 'run-step') throw new Error('expected run-step');
    expect(readFileSync(healed.action.steps[0]!.path, 'utf8')).toContain('Announce payments loudly.');
  });
});

// ---------------------------------------------------------------------------
// 3. E12 — sibling mirror: relative refs from a rendered step resolve; prune
// ---------------------------------------------------------------------------

test('E12: non-substituted siblings are mirrored (copies, raw) so relative refs resolve; stale entries and crashed temp files are pruned', () => {
  const w = scaffoldVarsWorld();
  writeFileSync(join(w.root, 'conventions.md'), 'shared context\n');
  // Dot-prefixed content is legitimate pipeline material (targets/.common
  // convention, dotfile fixtures) — only the {.runtime,.feedback,.git,.stats}
  // denylist is excluded from the mirror.
  writeFileSync(join(w.root, '.env.example'), 'EXAMPLE=1\n');
  inProject(w, () => {
    const res = invokeNext({ root: w.root, runId: 'r3', cliVars: { PP_SERVICE: 'payments' } });
    if (res.action.action !== 'run-step') throw new Error('expected run-step');
    const renderedStep = res.action.steps[0]!.path;

    // A rendered step's RELATIVE ref to a non-rendered sibling resolves inside
    // the rendered tree (steps/01-a.md → ../scripts/notify.py).
    const viaRelativeRef = resolve(dirname(renderedStep), '..', 'scripts', 'notify.py');
    expect(existsSync(viaRelativeRef)).toBe(true);
    expect(readFileSync(viaRelativeRef, 'utf8')).toBe('print("hi")\n');
    // Root-level context modules mirror too — including dot-file fixtures.
    expect(readFileSync(join(renderedRoot(w, 'r3'), 'conventions.md'), 'utf8')).toBe('shared context\n');
    expect(readFileSync(join(renderedRoot(w, 'r3'), '.env.example'), 'utf8')).toBe('EXAMPLE=1\n');
    // A sibling STEP is mirrored RAW — its tokens are substituted only when it
    // becomes the dispatched step (documented E12 limitation).
    expect(readFileSync(join(renderedRoot(w, 'r3'), 'steps', '02-b.md'), 'utf8')).toBe(STEP2_SRC);
    // Run artifacts are never mirrored (denylist) — .runtime in particular,
    // or the mirror would recurse into its own output.
    expect(existsSync(join(renderedRoot(w, 'r3'), '.runtime'))).toBe(false);

    // Prune: a deleted source, a stale ghost, and a crashed render temp all
    // vanish on the next lazy render pass.
    rmSync(join(w.scripts, 'notify.py'));
    writeFileSync(join(renderedRoot(w, 'r3'), 'ghost.md'), 'stale\n');
    writeFileSync(join(renderedRoot(w, 'r3'), 'steps', '01-a.md.99-1.render-tmp'), 'half-written\n');
    const again = invokeNext({ root: w.root, runId: 'r3' });
    expect(again.action.action).toBe('run-step');
    expect(existsSync(viaRelativeRef)).toBe(false);
    expect(existsSync(join(renderedRoot(w, 'r3'), 'ghost.md'))).toBe(false);
    expect(existsSync(join(renderedRoot(w, 'r3'), 'steps', '01-a.md.99-1.render-tmp'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. E9 — zero-change without declarations
// ---------------------------------------------------------------------------

test('E9: a pipeline without declarations renders NOTHING — path === source_path, no rendered folder', () => {
  const w = mkWorld('# P\n\n## End State\nx\n');
  writeFileSync(join(w.steps, '01-a.md'), '# a\n');
  inProject(w, () => {
    const res = invokeNext({ root: w.root, runId: 'r4' });
    if (res.action.action !== 'run-step') throw new Error('expected run-step');
    const step = res.action.steps[0]!;
    expect(step.path).toBe(step.source_path);
    expect(resolve(step.path)).toBe(resolve(join(w.steps, '01-a.md')));
    expect(existsSync(join(w.root, '.runtime', 'r4', 'rendered'))).toBe(false);
    expect('variables' in stateOf(w, 'r4')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. 07/08 P4 gate — render-time occurrence re-check halts (never throws)
// ---------------------------------------------------------------------------

test('render-time re-check: a mid-run bare occurrence of an init-unresolved var halts as an F2-style run halt, not a throw', () => {
  const w = scaffoldVarsWorld();
  inProject(w, () => {
    // PP_OPT is declared, optional, unresolved at init — legal, because its
    // only occurrence carries an inline default (${PP_OPT:-none}).
    const first = invokeNext({ root: w.root, runId: 'r5', cliVars: { PP_SERVICE: 'payments' } });
    expect(first.action.action).toBe('run-step');

    // An improver adds a BARE ${PP_OPT} occurrence to the next step mid-run —
    // run-init validation is long gone and the frozen map has no value for it.
    writeFileSync(join(w.steps, '02-b.md'), '---\nstep_id: s2\n---\n# b\n\nOpt is ${PP_OPT}.\n');
    const res = invokeNext({
      root: w.root,
      runId: 'r5',
      record: { kind: 'step', outcome: 'completed', flags: null, next_iteration: join(w.steps, '02-b.md') },
    });
    expect(res.code).toBe(1);
    expect(res.action.action).toBe('halt');
    const reason = (res.action as { reason?: string }).reason ?? '';
    // F2-style: names the variable, the exact occurrence (file:line), and the remedy.
    expect(reason).toContain('render time');
    expect(reason).toContain('PP_OPT');
    expect(reason).toContain('steps/02-b.md:6');
    expect(reason).toContain('inline default');
    // The run parked TERMINAL through the engine's halt seam — clean, resumable-not.
    const st = stateOf(w, 'r5');
    expect(st.phase).toBe('terminal');
    expect(st.status).toBe('halted');
  });
});

// ---------------------------------------------------------------------------
// 6. F10 — unwritable rendered dir fails the action cleanly (no partial tree)
// ---------------------------------------------------------------------------

test('F10: an unwritable rendered location halts the action with the I/O error and writes no partial tree', () => {
  const w = scaffoldVarsWorld();
  inProject(w, () => {
    // Occupy the rendered parent with a FILE so mkdir/copy under it must fail.
    mkdirSync(join(w.root, '.runtime', 'r6'), { recursive: true });
    writeFileSync(join(w.root, '.runtime', 'r6', 'rendered'), 'not a dir');
    const res = invokeNext({ root: w.root, runId: 'r6', cliVars: { PP_SERVICE: 'payments' } });
    expect(res.code).toBe(1);
    expect(res.action.action).toBe('halt');
    expect((res.action as { reason?: string }).reason).toContain('rendered copies could not be written');
    // Nothing was partially handed out and the obstruction is untouched.
    expect(readFileSync(join(w.root, '.runtime', 'r6', 'rendered'), 'utf8')).toBe('not a dir');
  });
});

// ---------------------------------------------------------------------------
// 7. E11 — mixed run: script steps keep path === source_path; ledger/## Next/
//    planStepFor keying stays green; events label steps by SOURCE path
// ---------------------------------------------------------------------------

test('E11: script step in a variable-declaring run keeps source path (ledger + ## Next green); agent neighbors render; events carry source paths', () => {
  const w = mkWorld(VARS_MANIFEST);
  writeFileSync(join(w.steps, '01-a.md'), STEP1_SRC);
  writeFileSync(join(w.scripts, 'notify.py'), 'print("hi")\n');
  writeFileSync(
    join(w.scripts, 'echo.js'),
    'console.log(JSON.stringify({ ok: true, output: { svc: process.env.PP_SERVICE ?? null } }));\n',
  );
  const step3 = join(w.steps, '03-c.md');
  writeFileSync(
    join(w.steps, '02-wait.md'),
    [
      '---',
      'type: script',
      'script: scripts/echo.js',
      'step_id: s2',
      'timeout: 60',
      '---',
      '# wait',
      '## Goal',
      'g',
      '## Success Criteria',
      's',
      '## Next',
      step3,
      '',
    ].join('\n'),
  );
  writeFileSync(step3, '---\nstep_id: s3\n---\n# c\n\nShip ${PP_SERVICE}.\n');

  inProject(w, () => {
    const first = invokeNext({ root: w.root, runId: 'r7', cliVars: { PP_SERVICE: 'payments' } });
    if (first.action.action !== 'run-step') throw new Error('expected run-step');
    expect(first.action.steps[0]!.step_id).toBe('s1');

    // Recording s1 lets the CLI run the script IN-PROCESS (path === source_path
    // — its ## Next parse + planStepFor keying use the plan path) and advance
    // straight to the s3 agent dispatch, rendered.
    const res = invokeNext({
      root: w.root,
      runId: 'r7',
      record: { kind: 'step', outcome: 'completed', flags: null, next_iteration: join(w.steps, '02-wait.md') },
    });
    if (res.action.action !== 'run-step') throw new Error(`expected run-step, got ${res.action.action}`);
    const s3 = res.action.steps[0]!;
    expect(s3.step_id).toBe('s3');
    expect(resolve(s3.path)).toBe(resolve(join(renderedRoot(w, 'r7'), 'steps', '03-c.md')));
    expect(readFileSync(s3.path, 'utf8')).toContain('Ship payments.');

    // §8 ledger keyed (step_id, dispatch_index) — untouched by rendering.
    expect(readJson(join(w.root, '.runtime', 'r7', 'ledger', 's2-2.json')).phase).toBe('finished');
    // D10 env overlay delivered the frozen value to the script.
    expect(readJson(join(w.root, '.runtime', 'r7', 'outputs', 's2.json'))).toEqual({ svc: 'payments' });

    // Events label every step by SOURCE path — a rendered `.runtime/rendered/`
    // path in iteration.started would de-pair it from its completion (which is
    // keyed off engine state). The s1 started/completed pair must share the
    // source path.
    const evs = readEvents(w);
    const started = evs.filter((e) => e.type === 'iteration.started');
    expect(started.length).toBeGreaterThanOrEqual(2);
    for (const e of started) expect(String(e.data.iteration_path)).not.toContain('rendered');
    const s1Started = started.find((e) => String(e.data.iteration_path).endsWith('01-a.md'));
    expect(s1Started).toBeDefined();
    const s1Completed = evs.find(
      (e) => e.type === 'iteration.completed' && String(e.data.iteration_path).endsWith('01-a.md'),
    );
    expect(s1Completed).toBeDefined();
    expect(s1Completed!.data.iteration_path).toBe(s1Started!.data.iteration_path);
  });
});

// ---------------------------------------------------------------------------
// 8. Concurrent layer: every agent member renders
// ---------------------------------------------------------------------------

test('parallel layer: every agent member is rendered with its own source_path', () => {
  const manifest = [
    '---',
    'execution: parallel',
    'isolation: manual',
    '---',
    '# P',
    '',
    '## End State',
    'x',
    '',
    '## Variables',
    '- PP_SERVICE (required) — service',
    '',
  ].join('\n');
  const w = mkWorld(manifest);
  writeFileSync(join(w.steps, '01-setup.md'), '---\nstep_id: setup\n---\n# setup\n\nPrep ${PP_SERVICE}.\n');
  writeFileSync(join(w.steps, '02-x.md'), '---\nstep_id: x\ndepends-on: [setup]\n---\n# x\n\nBuild ${PP_SERVICE}.\n');
  writeFileSync(join(w.steps, '03-y.md'), '---\nstep_id: y\ndepends-on: [setup]\n---\n# y\n\nTest ${PP_SERVICE}.\n');

  inProject(w, () => {
    const first = invokeNext({ root: w.root, runId: 'r8', cliVars: { PP_SERVICE: 'payments' } });
    if (first.action.action !== 'run-step') throw new Error('expected run-step');
    const layer = invokeNext({
      root: w.root,
      runId: 'r8',
      record: { kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] },
    });
    if (layer.action.action !== 'run-step') throw new Error('expected run-step');
    expect(layer.action.concurrent).toBe(true);
    expect(layer.action.steps.length).toBe(2);
    for (const s of layer.action.steps) {
      expect(s.path).not.toBe(s.source_path);
      expect(resolve(s.path)).toBe(resolve(join(renderedRoot(w, 'r8'), 'steps', `0${s.step_id === 'x' ? 2 : 3}-${s.step_id}.md`)));
      expect(readFileSync(s.path, 'utf8')).toContain('payments');
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Off-plan step OUTSIDE the pipeline root: stays unrendered (documented)
// ---------------------------------------------------------------------------

test('an off-plan step outside the pipeline root keeps path === source_path (not renderable) and creates no rendered tree', () => {
  const w = scaffoldVarsWorld();
  const outside = join(w.project, 'external-step.md');
  writeFileSync(outside, '# external\n');
  inProject(w, () => {
    const res = invokeNext({ root: w.root, runId: 'r9', start: outside, cliVars: { PP_SERVICE: 'payments' } });
    if (res.action.action !== 'run-step') throw new Error(`expected run-step, got ${res.action.action}`);
    const step = res.action.steps[0]!;
    expect(resolve(step.path)).toBe(resolve(outside));
    expect(step.path).toBe(step.source_path);
    expect(existsSync(join(w.root, '.runtime', 'r9', 'rendered'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. Regression — a RENDERED next_iteration (the executor read the rendered
//     copy and resolved `## Next` relative to it) still dispatches the next
//     step RENDERED, not off-plan + unrendered.
//
// This is the real-world shape of a multi-step run: step 1 is dispatched from
// its rendered copy, so its executor reports next_iteration as a
// `.runtime/<run>/rendered/<slug>/steps/NN.md` path (NOT the source path the
// unit fixtures above hand-fed). Before the fix that rendered path missed the
// plan (findStepByPath keys by source), was synthesized off-plan with
// source_path pinned to the rendered path, and was judged out-of-root by
// relUnder (`.runtime` denylist) → dispatched UNRENDERED with ${PP_SERVICE}
// left raw — the "support-answer halts at step 2" defect.
// ---------------------------------------------------------------------------

test('regression: a rendered next_iteration path is mapped back to source — step 2 dispatches RENDERED (substituted), source_path is the author path, no .runtime/rendered leak', () => {
  const w = scaffoldVarsWorld();
  inProject(w, () => {
    const first = invokeNext({ root: w.root, runId: 'r10', cliVars: { PP_SERVICE: 'payments' } });
    if (first.action.action !== 'run-step') throw new Error('expected run-step');
    // Step 1 ran from its rendered copy; the executor's `## Next` resolves to a
    // RENDERED path for step 2 (this is exactly what a real drive records).
    const renderedNext = join(renderedRoot(w, 'r10'), 'steps', '02-b.md');

    const res = invokeNext({
      root: w.root,
      runId: 'r10',
      record: { kind: 'step', outcome: 'completed', flags: null, next_iteration: renderedNext },
    });
    if (res.action.action !== 'run-step') throw new Error(`expected run-step, got ${res.action.action}`);
    const step2 = res.action.steps[0]!;

    // The invariant is restored: source_path is the AUTHOR source (never a
    // `.runtime/rendered/` path), path is the rendered copy, and the body was
    // substituted. Pre-fix: source_path === path === the raw rendered copy and
    // the body still read `Announce ${PP_SERVICE}.`.
    expect(step2.step_id).toBe('s2');
    expect(resolve(step2.source_path)).toBe(resolve(join(w.steps, '02-b.md')));
    expect(step2.source_path).not.toContain('rendered');
    expect(resolve(step2.path)).toBe(resolve(join(renderedRoot(w, 'r10'), 'steps', '02-b.md')));
    expect(step2.path).not.toBe(step2.source_path);
    expect(readFileSync(step2.path, 'utf8')).toContain('Announce payments.');
    expect(readFileSync(step2.path, 'utf8')).not.toContain('${PP_SERVICE}');

    // Events label the step by its SOURCE path — no rendered path leaks into the
    // journal (the design's stated guarantee).
    const started = readEvents(w).filter((e) => e.type === 'iteration.started');
    for (const e of started) expect(String(e.data.iteration_path)).not.toContain('rendered');
  });
});
