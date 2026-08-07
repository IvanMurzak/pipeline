// ux-v2 b19 — `step_name` on `iteration.started` for SEQUENTIAL steps, not
// only concurrent layers.
//
// Two `step_name` emission sites exist in commands/next.ts, feeding two
// DIFFERENT events:
//   - emitStartedEvents' `run-step` branch (the one this task edits) feeds
//     `iteration.started`. It used to be gated `if (action.concurrent ===
//     true)` — the old v4 `step_id` rule, which no longer holds under a v2
//     manifest where a step IS a named manifest entry. It now fires
//     unconditionally.
//   - emitCompletionEvents' `kind === 'layer'` branch feeds
//     `iteration.completed`, and only ever fires for a concurrent layer's
//     completion (kind 'layer' does not occur outside parallel mode). This
//     site is untouched by this task.
//
// This file proves three things per the task's own Definition of Done:
//   1. A sequential step's iteration.started now carries step_name.
//   2. A concurrent layer's iteration.started keeps carrying step_name too —
//      asserted, not assumed, so a future refactor of the (now-unconditional)
//      push can't silently regress the concurrent case.
//   3. The two step_name sites stay cleanly separated: fixing the started-side
//      site does not leak step_name onto a sequential iteration.completed
//      (which never carried it), and the completed-side site for a
//      concurrent layer still emits exactly one, correctly-attributed
//      step_name per member — no double-emission either within one event or
//      across the run.

import { test, expect, afterEach } from 'bun:test';
import { invokeNext } from '../src/commands/next';
import type { NextRecord } from '../src/lib/next';
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

interface World {
  project: string;
  home: string;
  root: string;
  steps: string;
}

/** Sequential (v2) world: 01-implement -> 02-ship, mirroring
 *  next-step-uuid.test.ts's mkWorld shape — deliberately duplicated rather
 *  than imported (this repo's test files are each self-contained). */
function mkSequentialWorld(): World {
  const project = mkdtempSync(join(tmpdir(), 'stepname-seq-proj-'));
  created.push(project);
  const home = mkdtempSync(join(tmpdir(), 'stepname-seq-home-'));
  created.push(home);
  spawnSync('git', ['init', '-q'], { cwd: project });
  const root = join(project, '.pipeline', 'demo');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  writeFileSync(join(steps, '01-implement.md'), '---\nstep_id: implement\n---\n# implement\n');
  writeFileSync(join(steps, '02-ship.md'), '---\nstep_id: ship\n---\n# ship\n');
  return { project, home, root, steps };
}

/** Parallel (v2) world: [setup] -> [x, y]. In parallel mode EVERY layer —
 *  even a lone-member one like [setup] — dispatches via dispatchLayer with
 *  concurrent:true (next.ts:1561), so 'setup' itself exercises the
 *  concurrent path here, alongside the genuine 2-member [x, y] layer. */
function mkParallelWorld(): World {
  const project = mkdtempSync(join(tmpdir(), 'stepname-par-proj-'));
  created.push(project);
  const home = mkdtempSync(join(tmpdir(), 'stepname-par-home-'));
  created.push(home);
  spawnSync('git', ['init', '-q'], { cwd: project });
  const root = join(project, '.pipeline', 'demo');
  const steps = join(root, 'steps');
  mkdirSync(steps, { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), '---\nexecution: parallel\n---\n# P\n\n## End State\nx\n');
  writeFileSync(join(steps, '01-setup.md'), '---\nstep_id: setup\n---\n# setup\n');
  writeFileSync(join(steps, '02-x.md'), '---\nstep_id: x\ndepends-on: [setup]\n---\n# x\n');
  writeFileSync(join(steps, '03-y.md'), '---\nstep_id: y\ndepends-on: [setup]\n---\n# y\n');
  return { project, home, root, steps };
}

function inProject<T>(w: World, fn: () => T): T {
  const prevCwd = process.cwd();
  const keys = ['PIPELINE_RUN_ID', 'PIPELINE_PARENT_RUN_ID', 'CLAUDE_SESSION_ID', 'USERPROFILE', 'HOME'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.chdir(w.project);
    delete process.env.PIPELINE_RUN_ID;
    delete process.env.PIPELINE_PARENT_RUN_ID;
    delete process.env.CLAUDE_SESSION_ID;
    process.env.USERPROFILE = w.home;
    process.env.HOME = w.home;
    return fn();
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function readEvents(w: World): any[] {
  const f = join(w.project, '.pipeline', '.runtime', 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// 1. DoD: a SEQUENTIAL step's iteration.started now carries step_name
// ---------------------------------------------------------------------------

test('b19: a sequential (non-concurrent) dispatch carries step_name on iteration.started', () => {
  const w = mkSequentialWorld();
  inProject(w, () => {
    const first = invokeNext({ root: w.root, runId: 'b19-seq' });
    if (first.action.action !== 'run-step') throw new Error(`expected run-step, got ${first.action.action}`);
    expect(first.action.concurrent).toBe(false); // pin the premise: this really is the non-concurrent path

    const started = readEvents(w).find((e) => e.type === 'iteration.started' && e.data?.index === 1);
    expect(started).toBeTruthy();
    // Previously ABSENT for a sequential dispatch — this is the DoD line.
    expect(started.data.step_name).toBe('implement');
  });
});

// ---------------------------------------------------------------------------
// 2. DoD: concurrent layers keep their existing behaviour (asserted, not
//    assumed)
// ---------------------------------------------------------------------------

test('b19: concurrent layer members keep carrying step_name on iteration.started, unchanged', () => {
  const w = mkParallelWorld();
  inProject(w, () => {
    const first = invokeNext({ root: w.root, runId: 'b19-par' }); // dispatches [setup]
    if (first.action.action !== 'run-step') throw new Error(`expected run-step, got ${first.action.action}`);
    expect(first.action.concurrent).toBe(true);

    const layer = invokeNext({
      root: w.root,
      runId: 'b19-par',
      record: { kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] } as NextRecord,
    }); // dispatches [x, y]
    if (layer.action.action !== 'run-step') throw new Error(`expected run-step, got ${layer.action.action}`);
    expect(layer.action.concurrent).toBe(true);
    expect(layer.action.steps.map((s) => s.step_id).sort()).toEqual(['x', 'y']);

    const started = readEvents(w).filter((e) => e.type === 'iteration.started');
    const setupStarted = started.find((e) => e.data?.index === 1);
    const xStarted = started.find((e) => e.data?.step_name === 'x');
    const yStarted = started.find((e) => e.data?.step_name === 'y');
    expect(setupStarted?.data.step_name).toBe('setup'); // lone-member layer: unchanged, was already concurrent pre-b19
    expect(xStarted).toBeTruthy();
    expect(yStarted).toBeTruthy();
    // Each member reports its OWN name — never swapped, never shared.
    expect(xStarted.data.index).not.toBe(yStarted.data.index);
    expect(xStarted.data.step_uuid).not.toBe(yStarted.data.step_uuid);
  });
});

// ---------------------------------------------------------------------------
// 3. DoD: no double-emission from the two step_name sites
// ---------------------------------------------------------------------------

test('b19: no double-emission — a sequential iteration.completed still omits step_name (the fix is started-side only)', () => {
  const w = mkSequentialWorld();
  inProject(w, () => {
    invokeNext({ root: w.root, runId: 'b19-nodup-seq' });
    invokeNext({
      root: w.root,
      runId: 'b19-nodup-seq',
      record: { kind: 'step', outcome: 'completed', next_iteration: join(w.steps, '02-ship.md') } as NextRecord,
    });
    const completed = readEvents(w).find((e) => e.type === 'iteration.completed');
    expect(completed).toBeTruthy();
    // emitCompletionEvents' 'step' branch (kind !== 'layer') never wrote
    // step_name before this task, and this task's fix touches ONLY
    // emitStartedEvents — so it must still be absent here. If it leaked in,
    // that would BE a double-emission of the step's name (once correctly on
    // iteration.started, once spuriously on iteration.completed).
    expect(completed.data.step_name).toBeUndefined();
  });
});

test('b19: no double-emission — a concurrent layer completion keeps exactly one, correctly-attributed step_name per member', () => {
  const w = mkParallelWorld();
  inProject(w, () => {
    invokeNext({ root: w.root, runId: 'b19-nodup-par' }); // [setup]
    invokeNext({
      root: w.root,
      runId: 'b19-nodup-par',
      record: { kind: 'layer', results: [{ step_id: 'setup', outcome: 'completed' }] } as NextRecord,
    }); // -> [x, y]
    invokeNext({
      root: w.root,
      runId: 'b19-nodup-par',
      record: {
        kind: 'layer',
        results: [
          { step_id: 'x', outcome: 'completed' },
          { step_id: 'y', outcome: 'completed' },
        ],
      } as NextRecord,
    }); // -> [z]

    const completed = readEvents(w).filter((e) => e.type === 'iteration.completed');
    const xCompleted = completed.filter((e) => e.data?.step_name === 'x');
    const yCompleted = completed.filter((e) => e.data?.step_name === 'y');
    // Exactly one each — emitCompletionEvents' layer branch (the OTHER site,
    // untouched by this task) still attributes one step_name per member, not
    // duplicated and not cross-attributed to its layer-mate.
    expect(xCompleted).toHaveLength(1);
    expect(yCompleted).toHaveLength(1);
    expect(xCompleted[0].data.step_name).not.toBe(yCompleted[0].data.step_name);
  });
});
