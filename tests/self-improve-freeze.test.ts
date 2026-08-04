// `self_improve: false` — which prompts an automated pass may not rewrite.
//
//   bun test tests/self-improve-freeze.test.ts
//
// Two rules, and the second is the one that is easy to get wrong:
//
//   * A frozen step's brief never reaches the improver. Not a flag the agent is
//     asked to respect — the engine simply does not queue the work.
//   * A file is frozen when ANY step including it is frozen. Per-step
//     permission is leaky once bodies compose: a `_shared/` fragment included
//     by both a permitted and a forbidden step would otherwise be edited
//     THROUGH the permitted one, silently rewriting the protected step's
//     prompt. One veto freezes the file.
//
// Freezing does not SILENCE a step's problems — the brief still exists and the
// retrospective still reads it. Forbidding the edit and losing the report would
// be the worst of both: you would stop hearing about a defect precisely in the
// step you trusted least to fix itself.

import { test, expect, describe, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNext, type NextAction, type NextOpts } from '../src/lib/next';
import { computePlan } from '../src/lib/plan';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const OPTS: NextOpts = { feedbackCount: 0 };

function scaffold(manifest: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'freeze-'));
  created.push(root);
  writeFileSync(join(root, 'pipeline.yml'), manifest.trim() + '\n');
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** Dispatch step 1, then complete it WITH an improvement brief. */
function completeWithBrief(root: string): NextAction {
  const plan = computePlan(root);
  const first = computeNext(plan, null, null, OPTS);
  return computeNext(plan, first.state, { kind: 'step', outcome: 'completed', has_improvement_brief: true }, OPTS)
    .action;
}

const TWO = (frozen: boolean) => `
schema: 2
name: demo
steps:
  - name: work
    body: steps/work.md
    ${frozen ? 'self_improve: false' : ''}
  - name: after
    body: steps/after.md
`;
const FILES = { 'steps/work.md': '# Work\n', 'steps/after.md': '# After\n' };

describe('a frozen step is not queued for improvement', () => {
  test('an ordinary step with a brief runs the improver', () => {
    const a = completeWithBrief(scaffold(TWO(false), FILES));
    expect(a.action).toBe('run-improver');
  });

  test('a frozen step with a brief goes straight on to the next step', () => {
    // The engine does not queue it — this does not depend on the improver
    // agent choosing to honour anything.
    const a = completeWithBrief(scaffold(TWO(true), FILES));
    expect(a.action).toBe('run-step');
    if (a.action !== 'run-step') throw new Error('expected run-step');
    expect(a.steps[0].step_id).toBe('after');
  });

  test('the pipeline-level default applies to every step', () => {
    const root = scaffold(
      'schema: 2\nname: demo\nself_improve: false\nsteps:\n  - name: work\n    body: steps/work.md\n  - name: after\n    body: steps/after.md\n',
      FILES,
    );
    expect(computePlan(root).steps.every((s) => s.self_improve === false)).toBe(true);
    expect(completeWithBrief(root).action).toBe('run-step');
  });

  test('a step overrides the pipeline default', () => {
    const root = scaffold(
      'schema: 2\nname: demo\nself_improve: false\nsteps:\n  - name: work\n    body: steps/work.md\n    self_improve: true\n  - name: after\n    body: steps/after.md\n',
      FILES,
    );
    expect(computePlan(root).steps[0].self_improve).toBe(true);
    expect(completeWithBrief(root).action).toBe('run-improver');
  });
});

describe('one veto freezes the file', () => {
  test('a fragment shared with a frozen step is frozen for everyone', () => {
    // `_shared/p.md` is in both bodies. Without this rule the improver would
    // reach it through `open`, and rewrite what `locked` reads.
    const root = scaffold(
      `
schema: 2
name: demo
steps:
  - name: open
    body:
      - _shared/p.md
      - steps/open.md
  - name: locked
    self_improve: false
    body:
      - _shared/p.md
      - steps/locked.md
`,
      { '_shared/p.md': '# P\n', 'steps/open.md': '# O\n', 'steps/locked.md': '# L\n' },
    );
    const frozen = computePlan(root).frozen_body_files;
    expect(frozen).toContain(join(root, '_shared', 'p.md'));
    expect(frozen).toContain(join(root, 'steps', 'locked.md'));
    // …but the permitted step's OWN body stays editable.
    expect(frozen).not.toContain(join(root, 'steps', 'open.md'));
  });

  test('every branch a frozen `oneof` could take is frozen, not just the default', () => {
    // Which branch runs depends on flags that are not known when the freeze is
    // computed, so freezing only the taken one would leave the others editable
    // on exactly the runs that did not take them.
    const root = scaffold(
      `
schema: 2
name: demo
steps:
  - name: locked
    self_improve: false
    body:
      - oneof:
          - use: steps/a.md
            when: is_a
          - use: steps/b.md
`,
      { 'steps/a.md': '# A\n', 'steps/b.md': '# B\n' },
    );
    const frozen = computePlan(root).frozen_body_files;
    expect(frozen).toContain(join(root, 'steps', 'a.md'));
    expect(frozen).toContain(join(root, 'steps', 'b.md'));
  });

  test("a frozen script step freezes its SCRIPT, which is the thing that runs", () => {
    const root = scaffold(
      'schema: 2\nname: demo\nsteps:\n  - name: verify\n    type: script\n    script: scripts/v.py\n    self_improve: false\n',
      { 'scripts/v.py': 'print(1)\n' },
    );
    expect(computePlan(root).frozen_body_files).toContain(join(root, 'scripts', 'v.py'));
  });
});

describe('the manifest is never self-edited', () => {
  test('it is frozen even when no step froze anything', () => {
    // A self-editing control file is a different risk class from self-editing
    // prose: prose changes what a step is TOLD, the manifest changes `timeout`,
    // `needs`, `isolation` — what the run DOES.
    const root = scaffold(TWO(false), FILES);
    expect(computePlan(root).frozen_body_files).toEqual([join(root, 'pipeline.yml')]);
  });

  test('a v1 pipeline freezes nothing — it had no way to say otherwise', () => {
    const root = mkdtempSync(join(tmpdir(), 'freeze-v1-'));
    created.push(root);
    writeFileSync(join(root, 'PIPELINE.md'), '# P\n');
    mkdirSync(join(root, 'steps'));
    writeFileSync(join(root, 'steps', '01-a.md'), '# A\n');
    const plan = computePlan(root);
    expect(plan.frozen_body_files).toEqual([]);
    expect(plan.steps[0].self_improve).toBe(true);
  });
});

describe('the improver is also TOLD what it may not touch', () => {
  test('the run-improver action carries the frozen list', () => {
    const root = scaffold(
      `
schema: 2
name: demo
steps:
  - name: work
    body: steps/work.md
  - name: locked
    self_improve: false
    body: steps/after.md
`,
      FILES,
    );
    const a = completeWithBrief(root);
    expect(a.action).toBe('run-improver');
    if (a.action !== 'run-improver') throw new Error('expected run-improver');
    expect(a.frozen_files).toContain(join(root, 'steps', 'after.md'));
    expect(a.frozen_files).toContain(join(root, 'pipeline.yml'));
  });
});
