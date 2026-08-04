// A step's prompt is composed from the markdown its manifest entry declares.
//
//   bun test tests/body-composition.test.ts
//
// v1 had one file per step, so "the prompt" and "the file" were the same thing
// and every pipeline that shared a preamble copied it — the worktree/cwd
// preamble was duplicated verbatim into 7 steps × 3 pipelines. v2 lets a step
// name several files in order, and conditional ones, so the duplication has
// somewhere to go.
//
// The dispatched `path` points at the composed document, and a composed step is
// labelled `steps/<name>.md` — derived from its identity, never from a fragment
// it may share with other steps. A step declaring ONE file composes nothing and
// keeps `path === source_path`, byte-identically to a v1 dispatch.
//
// Composition also settles routing: once a prompt is several files there is no
// path a step could report as its successor, so a manifest-routed run advances
// by the manifest and a step that reports nothing no longer ends the run.

import { test, expect, describe, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeNext } from '../src/commands/next';
import type { NextAction } from '../src/lib/next';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function scaffold(manifest: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'compose-'));
  created.push(root);
  writeFileSync(join(root, 'pipeline.yml'), manifest.trim() + '\n');
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function step(action: NextAction) {
  if (action.action !== 'run-step') throw new Error(`expected run-step, got ${action.action}`);
  return action.steps[0];
}

/** Dispatch the first step of a fresh run. */
function firstDispatch(root: string, runId = 'r1') {
  const res = invokeNext({ root, runId });
  return step(res.action);
}

const PREAMBLE = '# Shared preamble\n\nAlways work inside the run worktree.\n';
const IMPLEMENT = '# Implement\n\n## Goal\nDo the task.\n';

describe('composing several files into one prompt', () => {
  test('the fragments are concatenated in DECLARED order, not filename order', () => {
    // `zz-preamble` sorts after `aa-body`: if order came from the file system
    // the two would swap, which is the whole reason order is declared.
    const root = scaffold(
      `
schema: 2
name: demo
steps:
  - name: implement
    body:
      - _shared/zz-preamble.md
      - steps/aa-body.md
`,
      { '_shared/zz-preamble.md': PREAMBLE, 'steps/aa-body.md': IMPLEMENT },
    );
    const s = firstDispatch(root);
    expect(s.path).not.toBe(s.source_path);
    const composed = readFileSync(s.path, 'utf8');
    expect(composed.indexOf('Shared preamble')).toBeLessThan(composed.indexOf('# Implement'));
    expect(composed).toContain('Always work inside the run worktree.');
    expect(composed).toContain('Do the task.');
  });

  test('a composed step is labelled by its NAME, never by a fragment it shares', () => {
    // `_shared/p.md` is the first fragment of both steps. Labelling by it would
    // give them the same name in the journal, in .stats and in the iteration
    // tree — so the label is derived from the step's own identity instead.
    const root = scaffold(
      `
schema: 2
name: demo
steps:
  - name: alpha
    body:
      - _shared/p.md
      - steps/alpha.md
  - name: beta
    body:
      - _shared/p.md
      - steps/beta.md
`,
      { '_shared/p.md': PREAMBLE, 'steps/alpha.md': IMPLEMENT, 'steps/beta.md': '# Beta\n' },
    );
    const s = firstDispatch(root);
    expect(s.source_path).toBe(join(root, 'steps', 'alpha.md'));
    expect(s.body).toEqual([join(root, '_shared', 'p.md'), join(root, 'steps', 'alpha.md')]);
    // …and the two steps do not collide.
    const { computePlan } = require('../src/lib/plan') as typeof import('../src/lib/plan');
    const labels = computePlan(root).steps.map((p) => p.rel);
    expect(labels).toEqual(['alpha.md', 'beta.md']);
  });

  test('a ONE-file body composes nothing — path === source_path, as in v1', () => {
    const root = scaffold('schema: 2\nname: demo\nsteps:\n  - name: a\n    body: steps/a.md\n', {
      'steps/a.md': IMPLEMENT,
    });
    const s = firstDispatch(root);
    expect(s.path).toBe(s.source_path);
    expect(s.path).toBe(join(root, 'steps', 'a.md'));
  });

  test("a fragment's stale v1 frontmatter is dropped, not stacked mid-document", () => {
    // In v2 the manifest owns model/type/order, so a leftover `---` block is
    // noise — and several of them stacked inside one prompt is worse than noise.
    const root = scaffold(
      'schema: 2\nname: demo\nsteps:\n  - name: a\n    body:\n      - _shared/p.md\n      - steps/a.md\n',
      {
        '_shared/p.md': '---\nmodel: opus\n---\n' + PREAMBLE,
        'steps/a.md': '---\nstep_id: legacy\n---\n' + IMPLEMENT,
      },
    );
    const composed = readFileSync(firstDispatch(root).path, 'utf8');
    expect(composed).not.toContain('model: opus');
    expect(composed).not.toContain('step_id: legacy');
    expect(composed).not.toContain('---');
    expect(composed).toContain('Shared preamble');
    expect(composed).toContain('# Implement');
  });

  test('a sibling reference inside a composed prompt still resolves', () => {
    // The composed document is written at the first fragment's own path inside
    // the shadow tree, and the tree mirrors the rest of the pipeline — so a
    // relative `scripts/notify.py` points at a file that exists.
    const root = scaffold(
      'schema: 2\nname: demo\nsteps:\n  - name: a\n    body:\n      - steps/a.md\n      - _shared/p.md\n',
      {
        'steps/a.md': IMPLEMENT + '\nRun `scripts/notify.py`.\n',
        '_shared/p.md': PREAMBLE,
        'scripts/notify.py': 'print("hi")\n',
      },
    );
    const s = firstDispatch(root);
    const mirrored = join(s.path, '..', '..', 'scripts', 'notify.py');
    expect(readFileSync(mirrored, 'utf8')).toContain('print("hi")');
  });
});

describe('conditional fragments read the run\'s flags', () => {
  const CONDITIONAL = `
schema: 2
name: demo
steps:
  - name: probe
    body: steps/probe.md
  - name: fix
    body:
      - steps/fix.md
      - use: _shared/retry.md
        when: needs_retry
`;
  const FILES = {
    'steps/probe.md': '# Probe\n',
    'steps/fix.md': '# Fix\n',
    '_shared/retry.md': '# Retry guidance\n\nThe previous attempt failed.\n',
  };

  /** Run step 1, reporting `flags`, and return step 2's dispatch. */
  function secondDispatch(flags: Record<string, unknown> | undefined) {
    const root = scaffold(CONDITIONAL, FILES);
    const first = invokeNext({ root, runId: 'r1' });
    const next = invokeNext({
      root,
      runId: 'r1',
      record: {
        kind: 'step',
        outcome: 'completed',
        next_iteration: join(root, 'steps', 'fix.md'),
        ...(flags ? { flags } : {}),
      },
    });
    void first;
    return { root, s: step(next.action) };
  }

  test('an unset flag leaves its fragment OUT', () => {
    const { s } = secondDispatch(undefined);
    // Nothing to compose ⇒ the single remaining fragment is dispatched as-is.
    expect(s.body).toHaveLength(1);
    expect(s.path).toBe(s.source_path);
    expect(readFileSync(s.path, 'utf8')).not.toContain('Retry guidance');
  });

  test('a flag reported by an EARLIER step pulls its fragment in', () => {
    const { s } = secondDispatch({ needs_retry: true });
    expect(s.body).toHaveLength(2);
    const composed = readFileSync(s.path, 'utf8');
    expect(composed).toContain('# Fix');
    expect(composed).toContain('The previous attempt failed.');
  });

  test('a falsy flag value does not pull the fragment in', () => {
    const { s } = secondDispatch({ needs_retry: false });
    expect(s.body).toHaveLength(1);
  });
});

describe('oneof picks exactly one variant', () => {
  const ONEOF = `
schema: 2
name: demo
steps:
  - name: probe
    body: steps/probe.md
  - name: ship
    body:
      - _shared/pre.md
      - oneof:
          - use: steps/ship.plugin.md
            when: is_plugin
          - use: steps/ship.md
`;
  const FILES = {
    'steps/probe.md': '# Probe\n',
    '_shared/pre.md': '# Pre\n',
    'steps/ship.plugin.md': '# Ship a plugin\n',
    'steps/ship.md': '# Ship\n',
  };

  function shipDispatch(flags: Record<string, unknown>) {
    const root = scaffold(ONEOF, FILES);
    invokeNext({ root, runId: 'r1' });
    const next = invokeNext({
      root,
      runId: 'r1',
      record: { kind: 'step', outcome: 'completed', next_iteration: join(root, 'steps', 'ship.md'), flags },
    });
    return readFileSync(step(next.action).path, 'utf8');
  }

  test('the matching variant wins', () => {
    const composed = shipDispatch({ is_plugin: true });
    expect(composed).toContain('# Ship a plugin');
    expect(composed).not.toContain('# Ship\n');
  });

  test('nothing matching falls to the default variant — never an empty body', () => {
    // The manifest REQUIRES a default and requires it last, so "nothing
    // matched" cannot compose an empty prompt (the same failure shape as v1's
    // missing next_iteration). This is that guarantee at runtime.
    const composed = shipDispatch({});
    expect(composed).toContain('# Ship');
    expect(composed).toContain('# Pre');
    expect(composed.trim()).not.toBe('');
  });
});

describe('a manifest-routed run follows the manifest, not a reported path', () => {
  const THREE = `
schema: 2
name: demo
steps:
  - name: one
    body: steps/one.md
  - name: two
    body: steps/two.md
  - name: three
    body: steps/three.md
`;
  const FILES = { 'steps/one.md': '# 1\n', 'steps/two.md': '# 2\n', 'steps/three.md': '# 3\n' };

  /** Complete the current step with `next_iteration` and return what runs next. */
  function complete(root: string, nextIteration: string | undefined) {
    return invokeNext({
      root,
      runId: 'r1',
      record: {
        kind: 'step',
        outcome: 'completed',
        ...(nextIteration === undefined ? {} : { next_iteration: nextIteration }),
      } as never,
    }).action;
  }

  test('a step that reports NOTHING still advances — the silent success is gone', () => {
    // v1's rule was "no next_iteration ⇒ the pipeline completed", so a step that
    // simply forgot its `## Next` line reported a successful run.
    const root = scaffold(THREE, FILES);
    invokeNext({ root, runId: 'r1' });
    expect(step(complete(root, undefined)).step_id).toBe('two');
  });

  test('a stale reported path is IGNORED — the manifest order wins', () => {
    const root = scaffold(THREE, FILES);
    invokeNext({ root, runId: 'r1' });
    // Points at step three, skipping two. The manifest says two.
    expect(step(complete(root, join(root, 'steps', 'three.md'))).step_id).toBe('two');
  });

  test('PIPELINE_COMPLETE still ends the run — ending early is the step\'s call', () => {
    const root = scaffold(THREE, FILES);
    invokeNext({ root, runId: 'r1' });
    const a = complete(root, 'PIPELINE_COMPLETE');
    expect(['done', 'run-improver', 'retrospective']).toContain(a.action);
    expect(a.action).not.toBe('run-step');
  });

  test('the run ends after the LAST manifest step', () => {
    const root = scaffold(THREE, FILES);
    invokeNext({ root, runId: 'r1' });
    expect(step(complete(root, undefined)).step_id).toBe('two');
    expect(step(complete(root, undefined)).step_id).toBe('three');
    expect(complete(root, undefined).action).not.toBe('run-step');
  });

  test('a v1 pipeline is untouched — it still routes on what its step reported', () => {
    const root = mkdtempSync(join(tmpdir(), 'v1route-'));
    created.push(root);
    writeFileSync(join(root, 'PIPELINE.md'), '# P\n');
    mkdirSync(join(root, 'steps'));
    for (const n of ['01-a.md', '02-b.md', '03-c.md']) writeFileSync(join(root, 'steps', n), `# ${n}\n`);
    invokeNext({ root, runId: 'r1' });
    // Skipping a step by reporting past it is exactly what v1 allows.
    expect(step(complete(root, join(root, 'steps', '03-c.md'))).step_id).toBe('03-c');
  });
});

describe('a v1 pipeline is told it is v1 — once, and with the remedy', () => {
  function initWithStderr(root: string) {
    const original = process.stderr.write.bind(process.stderr);
    let captured = '';
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      captured += s;
      return true;
    };
    try {
      invokeNext({ root, runId: 'r1' });
      return captured;
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
  }

  function v1Root() {
    const root = mkdtempSync(join(tmpdir(), 'v1dep-'));
    created.push(root);
    writeFileSync(join(root, 'PIPELINE.md'), '# P\n');
    mkdirSync(join(root, 'steps'));
    writeFileSync(join(root, 'steps', '01-a.md'), '# A\n');
    return root;
  }

  test('the notice names the command that fixes it, and says v1 keeps working', () => {
    const captured = initWithStderr(v1Root());
    expect(captured).toContain('defined the v1 way');
    expect(captured).toContain('migrate --to-manifest');
    expect(captured).toContain('keeps working meanwhile');
  });

  test('it fires at run INIT only — not on every loop call', () => {
    const root = v1Root();
    initWithStderr(root); // init
    const second = initWithStderr(root); // an existing run: no state === null
    expect(second).not.toContain('defined the v1 way');
  });

  test('a manifest pipeline is never nagged', () => {
    const root = scaffold('schema: 2\nname: demo\nsteps:\n  - name: a\n    body: steps/a.md\n', {
      'steps/a.md': '# A\n',
    });
    expect(initWithStderr(root)).not.toContain('defined the v1 way');
  });
});
