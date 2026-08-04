// A step's identity is its NAME, not the path of its body.
//
//   bun test tests/next-identity.test.ts
//
// v1 keyed the engine on file paths: the persisted cursor was `current_path`,
// every lookup was a path comparison, and `--start` took a path. That coupled a
// step's identity to where its markdown happened to live — so renaming a body
// file re-identified the step, two steps could not share one, and a step with
// no body at all (a script, a gate) had no identity to speak of.
//
// These tests hold the new rule from both ends: the name is what the engine
// resolves on, and a body file moving underneath a parked run no longer strands
// it.

import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNext, startResolvedByPath, type NextOpts, type NextState } from '../src/lib/next';
import { computePlan } from '../src/lib/plan';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const OPTS: NextOpts = { feedbackCount: 0 };

/** A v2 pipeline: three named steps whose bodies live under steps/. */
function scaffold(bodies = ['steps/01-a.md', 'steps/02-b.md', 'steps/03-c.md']): string {
  const root = mkdtempSync(join(tmpdir(), 'identity-'));
  created.push(root);
  const names = ['implement', 'review', 'ship'];
  writeFileSync(
    join(root, 'pipeline.yml'),
    ['schema: 2', 'name: demo', 'steps:', ...names.map((n, i) => `  - name: ${n}\n    body: ${bodies[i]}`), ''].join('\n'),
  );
  for (const b of bodies) {
    const full = join(root, ...b.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, `# ${b}\n`);
  }
  return root;
}

function firstStep(root: string, opts: Partial<NextOpts> = {}) {
  const plan = computePlan(root);
  const r = computeNext(plan, null, null, { ...OPTS, ...opts });
  return { plan, action: r.action, state: r.state };
}

function dispatchedName(action: { action: string; steps?: Array<{ step_id: string }> }): string {
  return action.action === 'run-step' ? (action.steps?.[0]?.step_id ?? '(none)') : action.action;
}

describe('--start names a step', () => {
  test('a NAME dispatches that step', () => {
    const { action } = firstStep(scaffold(), { start: 'review' });
    expect(dispatchedName(action)).toBe('review');
  });

  test('a name that names no step halts — it never silently restarts at step 1', () => {
    // The failure v1's path-keyed lookup could not distinguish from a legitimate
    // off-plan hand-off, so it synthesized a step out of the typo instead.
    const { action, state } = firstStep(scaffold(), { start: 'reviw' });
    expect(action.action).toBe('halt');
    // …and names the steps that do exist, because the mistake is in the
    // command, not in the pipeline.
    expect(state.halt_reason).toContain("'reviw' matches no step");
    expect(state.halt_reason).toContain('implement, review, ship');
  });

  test('a PATH still resolves, and reports itself as the deprecated form', () => {
    const root = scaffold();
    const bodyPath = join(root, 'steps', '02-b.md');
    const { plan, action } = firstStep(root, { start: bodyPath });
    expect(dispatchedName(action)).toBe('review');
    // What the command layer turns into "use the name 'review'".
    expect(startResolvedByPath(plan, bodyPath)?.step_id).toBe('review');
  });

  test('a NAME is not reported as the deprecated path form', () => {
    const plan = computePlan(scaffold());
    expect(startResolvedByPath(plan, 'review')).toBeNull();
    expect(startResolvedByPath(plan, undefined)).toBeNull();
  });
});

describe('the cursor survives what the file system does to the body', () => {
  test('a parked run resumes by name after its body file is renamed', () => {
    // The whole point of the move. Under path identity this run resumed at
    // step 1: the cursor pointed at a file that no longer existed, so the
    // lookup missed and the ladder fell through to steps[0] — silently
    // re-running work that had already been done.
    const root = scaffold();
    const parked = firstStep(root, { start: 'review' });
    expect(dispatchedName(parked.action)).toBe('review');

    renameSync(join(root, 'steps', '02-b.md'), join(root, 'steps', 'review-body.md'));
    writeFileSync(
      join(root, 'pipeline.yml'),
      [
        'schema: 2',
        'name: demo',
        'steps:',
        '  - name: implement\n    body: steps/01-a.md',
        '  - name: review\n    body: steps/review-body.md',
        '  - name: ship\n    body: steps/03-c.md',
        '',
      ].join('\n'),
    );

    const resumed = computeNext(computePlan(root), parked.state, null, { ...OPTS, resume: true });
    expect(dispatchedName(resumed.action)).toBe('review');
  });

  test('the persisted cursor is the name, and carries no path for a planned step', () => {
    const { state } = firstStep(scaffold(), { start: 'ship' });
    expect(state.current_step_id).toBe('ship');
    expect(state.current_off_plan_path).toBeNull();
    expect(Object.hasOwn(state, 'current_path')).toBe(false);
  });

  test('two steps may share one body file and stay distinct', () => {
    // Impossible under path identity: the second step would resolve to the
    // first on every lookup.
    const root = scaffold(['steps/shared.md', 'steps/shared.md', 'steps/03-c.md']);
    const plan = computePlan(root);
    expect(plan.errors).toEqual([]);
    expect(plan.steps.map((s) => s.step_id)).toEqual(['implement', 'review', 'ship']);
    const { action, state } = firstStep(root, { start: 'review' });
    expect(dispatchedName(action)).toBe('review');
    expect(state.current_step_id).toBe('review');
  });
});

describe('a run persisted by an older CLI', () => {
  /** next.json as the path-keyed engine wrote it: a `current_path` cursor. */
  function legacyState(root: string): NextState {
    const { state } = firstStep(root, { start: 'implement' });
    const legacy = { ...state, current_path: join(root, 'steps', '01-a.md') } as NextState & {
      current_path: string;
    };
    delete (legacy as { current_off_plan_path?: unknown }).current_off_plan_path;
    return legacy;
  }

  test('refuses to resume, and says why', () => {
    const root = scaffold();
    const r = computeNext(computePlan(root), legacyState(root), null, { ...OPTS, resume: true });
    expect(r.action.action).toBe('halt');
    if (r.action.action !== 'halt') throw new Error('expected halt');
    expect(r.action.reason).toContain('older CLI');
    expect(r.action.reason).toContain('cannot be resumed');
    // The remedy is stated, and it is not "edit your pipeline".
    expect(r.action.reason).toContain('fresh run');
  });

  test('refuses on a plain loop call too, not only on --resume', () => {
    // A crashed manager re-enters without --resume; it must hit the same wall
    // rather than dispatching against a cursor the engine cannot read.
    const root = scaffold();
    const r = computeNext(computePlan(root), legacyState(root), null, OPTS);
    expect(r.action.action).toBe('halt');
  });

  test('a state written by THIS engine resumes normally', () => {
    const root = scaffold();
    const { state } = firstStep(root, { start: 'implement' });
    const r = computeNext(computePlan(root), state, null, { ...OPTS, resume: true });
    expect(dispatchedName(r.action)).toBe('implement');
  });
});
