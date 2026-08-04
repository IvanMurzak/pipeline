import { test, expect, describe } from 'bun:test';
import {
  parseManifest,
  buildLayers,
  effectiveNeeds,
  resolveBody,
  bodyFiles,
  frozenBodyFiles,
  MANIFEST_SCHEMA,
} from '../src/lib/manifest';

/**
 * v2 manifest (`pipeline.yml`) — parsing, validation, layering, body
 * composition and the self-improve freeze. Pure: every case is a string in,
 * no filesystem.
 *
 * The through-line of these tests is that v2 REFUSES rather than falls back.
 * Every v1 "unknown X — treating as Y" warning is asserted here as an error,
 * because each one was a way for a pipeline to look configured while behaving
 * otherwise (`isolation: manager` ran with no isolation at all).
 */

const MINIMAL = `
schema: 2
name: demo
steps:
  - id: build
    body: steps/build.md
`;

function parse(yaml: string) {
  return parseManifest(yaml);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

describe('header', () => {
  test('a minimal manifest parses with documented defaults', () => {
    const m = parse(MINIMAL);
    expect(m.errors).toEqual([]);
    expect(m.name).toBe('demo');
    expect(m.schema).toBe(MANIFEST_SCHEMA);
    expect(m.execution).toBe('sequential');
    expect(m.isolation).toBe('none');
    expect(m.base_branch).toBe('main');
    expect(m.self_improve).toBe(true);
    expect(m.steps).toHaveLength(1);
  });

  test('schema is required — an unversioned manifest is refused', () => {
    const m = parse(`name: demo\nsteps:\n  - id: a\n    body: a.md\n`);
    expect(m.errors.some((e) => e.startsWith('schema:'))).toBe(true);
  });

  test('a future schema is refused rather than guessed at', () => {
    const m = parse(`schema: 99\nname: demo\nsteps:\n  - id: a\n    body: a.md\n`);
    expect(m.errors.some((e) => e.includes('not supported'))).toBe(true);
  });

  test('name is required', () => {
    const m = parse(`schema: 2\nsteps:\n  - id: a\n    body: a.md\n`);
    expect(m.errors).toContain('name: missing');
  });

  test('steps is required and must be non-empty', () => {
    expect(parse(`schema: 2\nname: d\n`).errors).toContain('steps: missing');
    expect(parse(`schema: 2\nname: d\nsteps: []\n`).errors).toContain('steps: the pipeline has no steps');
  });

  test('invalid YAML is reported as such, not as a missing field', () => {
    const m = parse(`schema: 2\nname: [unclosed\n`);
    expect(m.errors).toHaveLength(1);
    expect(m.errors[0]).toContain('not valid YAML');
  });

  test('parses the full header', () => {
    const m = parse(`
schema: 2
name: full
description: does things
execution: parallel
isolation: run
base_branch: next
self_improve: false
defaults:
  model: opus
  effort: high
submodules:
  - public/plugin/pipeline-claude
vars:
  root: C:/x
steps:
  - id: a
    body: a.md
`);
    expect(m.errors).toEqual([]);
    expect(m.execution).toBe('parallel');
    expect(m.isolation).toBe('run');
    expect(m.base_branch).toBe('next');
    expect(m.self_improve).toBe(false);
    expect(m.defaults).toEqual({ model: 'opus', effort: 'high' });
    expect(m.submodules).toEqual(['public/plugin/pipeline-claude']);
    expect(m.vars).toEqual({ root: 'C:/x' });
    expect(m.description).toBe('does things');
  });
});

// ---------------------------------------------------------------------------
// No silent fallbacks — the core v2 promise
// ---------------------------------------------------------------------------

describe('unknown values are errors, never fallbacks', () => {
  test("v1's `isolation: manager` is refused instead of downgraded", () => {
    const m = parse(`schema: 2\nname: d\nisolation: manager\nsteps:\n  - id: a\n    body: a.md\n`);
    expect(m.errors.some((e) => e.startsWith('isolation:') && e.includes('manager'))).toBe(true);
  });

  test('the retired v1 isolation vocabulary is refused too', () => {
    for (const old of ['worktree', 'manual', 'external']) {
      const m = parse(`schema: 2\nname: d\nisolation: ${old}\nsteps:\n  - id: a\n    body: a.md\n`);
      expect(m.errors.some((e) => e.startsWith('isolation:'))).toBe(true);
    }
  });

  test('unknown execution is refused', () => {
    const m = parse(`schema: 2\nname: d\nexecution: dag\nsteps:\n  - id: a\n    body: a.md\n`);
    expect(m.errors.some((e) => e.startsWith('execution:'))).toBe(true);
  });

  test('a mistyped scalar is reported with its path', () => {
    const m = parse(`schema: 2\nname: d\nself_improve: yes-please\nsteps:\n  - id: a\n    body: a.md\n`);
    expect(m.errors.some((e) => e.startsWith('self_improve:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Body composition
// ---------------------------------------------------------------------------

describe('body composition', () => {
  test('a bare string normalizes to a single unconditional include', () => {
    const m = parse(MINIMAL);
    expect(m.steps[0].body).toEqual([{ kind: 'include', use: 'steps/build.md', when: null }]);
    expect(resolveBody(m.steps[0])).toEqual(['steps/build.md']);
  });

  test('a list composes in declared order', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: a
    body:
      - _shared/preamble.md
      - steps/a.md
      - _shared/reporting.md
`);
    expect(m.errors).toEqual([]);
    expect(resolveBody(m.steps[0])).toEqual(['_shared/preamble.md', 'steps/a.md', '_shared/reporting.md']);
  });

  test('a conditional include appears only when its flag is set', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: a
    body:
      - steps/a.md
      - { use: _shared/retry.md, when: retry }
`);
    expect(m.errors).toEqual([]);
    expect(resolveBody(m.steps[0], {})).toEqual(['steps/a.md']);
    expect(resolveBody(m.steps[0], { retry: true })).toEqual(['steps/a.md', '_shared/retry.md']);
  });

  test('oneof takes the first matching option and only that one', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: a
    body:
      - _shared/pre.md
      - oneof:
          - { use: steps/a.plugin.md, when: is_plugin }
          - { use: steps/a.package.md, when: is_package }
          - { use: steps/a.md }
`);
    expect(m.errors).toEqual([]);
    const s = m.steps[0];
    expect(resolveBody(s, { is_plugin: true })).toEqual(['_shared/pre.md', 'steps/a.plugin.md']);
    expect(resolveBody(s, { is_package: true })).toEqual(['_shared/pre.md', 'steps/a.package.md']);
    expect(resolveBody(s, {})).toEqual(['_shared/pre.md', 'steps/a.md']);
    // Both flags set: declaration order decides, never both files.
    expect(resolveBody(s, { is_plugin: true, is_package: true })).toEqual(['_shared/pre.md', 'steps/a.plugin.md']);
  });

  test('oneof without a default is refused — it could compose an empty body', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: a
    body:
      - oneof:
          - { use: x.md, when: a }
          - { use: y.md, when: b }
`);
    expect(m.errors.some((e) => e.includes('no default option'))).toBe(true);
  });

  test('the default option must be last, because options are tried in order', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: a
    body:
      - oneof:
          - { use: fallback.md }
          - { use: special.md, when: special }
`);
    expect(m.errors.some((e) => e.includes('must be LAST'))).toBe(true);
  });

  test('bodyFiles lists every reachable file, resolveBody only the taken ones', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: a
    body:
      - oneof:
          - { use: x.md, when: f }
          - { use: y.md }
`);
    expect(bodyFiles(m.steps[0]).sort()).toEqual(['x.md', 'y.md']);
    expect(resolveBody(m.steps[0], {})).toEqual(['y.md']);
  });

  test('an agent step with no body is refused', () => {
    const m = parse(`schema: 2\nname: d\nsteps:\n  - id: a\n`);
    expect(m.errors.some((e) => e.includes("needs a 'body'"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// needs / layering
// ---------------------------------------------------------------------------

describe('needs and layering', () => {
  const LINEAR = `
schema: 2
name: d
steps:
  - id: a
    body: a.md
  - id: b
    body: b.md
  - id: c
    body: c.md
`;

  test('an absent needs inherits the previously declared step', () => {
    const m = parse(LINEAR);
    expect(m.errors).toEqual([]);
    const deps = effectiveNeeds(m.steps);
    expect(deps.get('a')).toEqual([]);
    expect(deps.get('b')).toEqual(['a']);
    expect(deps.get('c')).toEqual(['b']);
    expect(buildLayers(m.steps).layers).toEqual([['a'], ['b'], ['c']]);
  });

  test('an explicit empty needs joins the first layer — distinct from absent', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: a
    body: a.md
  - id: b
    body: b.md
    needs: []
`);
    expect(m.errors).toEqual([]);
    expect(effectiveNeeds(m.steps).get('b')).toEqual([]);
    expect(buildLayers(m.steps).layers).toEqual([['a', 'b']]);
  });

  test('fan-out and fan-in produce the expected layers', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: setup
    body: s.md
  - id: left
    body: l.md
    needs: [setup]
  - id: right
    body: r.md
    needs: [setup]
  - id: join
    body: j.md
    needs: [left, right]
`);
    expect(m.errors).toEqual([]);
    expect(buildLayers(m.steps).layers).toEqual([['setup'], ['left', 'right'], ['join']]);
  });

  test('layer order follows declaration order, so sequential runs are deterministic', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: zebra
    body: z.md
    needs: []
  - id: apple
    body: a.md
    needs: []
`);
    expect(buildLayers(m.steps).layers).toEqual([['zebra', 'apple']]);
  });

  test('a cycle is a hard error', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: a
    body: a.md
    needs: [b]
  - id: b
    body: b.md
    needs: [a]
`);
    expect(m.errors.some((e) => e.startsWith('cycle among steps'))).toBe(true);
  });

  test('a step cannot need itself', () => {
    const m = parse(`schema: 2\nname: d\nsteps:\n  - id: a\n    body: a.md\n    needs: [a]\n`);
    expect(m.errors.some((e) => e.includes('needs itself'))).toBe(true);
  });

  test('needs on an unknown step is a hard error', () => {
    const m = parse(`schema: 2\nname: d\nsteps:\n  - id: a\n    body: a.md\n    needs: [ghost]\n`);
    expect(m.errors.some((e) => e.includes("unknown step 'ghost'"))).toBe(true);
  });

  test('duplicate ids are refused', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: a
    body: a.md
  - id: a
    body: b.md
`);
    expect(m.errors.some((e) => e.includes("duplicate step id 'a'"))).toBe(true);
  });

  test('execution does not change the graph — only how much of it runs at once', () => {
    const seq = parse(`schema: 2\nname: d\nexecution: sequential\nsteps:\n  - id: a\n    body: a.md\n  - id: b\n    body: b.md\n    needs: []\n`);
    const par = parse(`schema: 2\nname: d\nexecution: parallel\nsteps:\n  - id: a\n    body: a.md\n  - id: b\n    body: b.md\n    needs: []\n`);
    expect(buildLayers(seq.steps).layers).toEqual(buildLayers(par.steps).layers);
  });
});

// ---------------------------------------------------------------------------
// Step types
// ---------------------------------------------------------------------------

describe('step types', () => {
  test('script steps carry script/params/timeout', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: verify
    type: script
    script: scripts/verify.py
    timeout: 180
    retries: 1
    on_failure: agent
    params:
      root: /x
`);
    expect(m.errors).toEqual([]);
    const s = m.steps[0];
    expect(s.type).toBe('script');
    expect(s.script).toBe('scripts/verify.py');
    expect(s.timeout).toBe(180);
    expect(s.retries).toBe(1);
    expect(s.on_failure).toBe('agent');
    expect(s.params).toEqual({ root: '/x' });
  });

  test('a pipeline step composes another pipeline as a node', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: release
    type: pipeline
    pipeline: ../release-package
    isolation: own
    args:
      package: protocol
`);
    expect(m.errors).toEqual([]);
    const s = m.steps[0];
    expect(s.type).toBe('pipeline');
    expect(s.pipeline).toBe('../release-package');
    expect(s.child_isolation).toBe('own');
    expect(s.args).toEqual({ package: 'protocol' });
  });

  test('each type requires its own key', () => {
    expect(parse(`schema: 2\nname: d\nsteps:\n  - id: a\n    type: script\n`).errors.some((e) => e.includes("needs 'script:'"))).toBe(true);
    expect(parse(`schema: 2\nname: d\nsteps:\n  - id: a\n    type: pipeline\n`).errors.some((e) => e.includes("needs 'pipeline:'"))).toBe(true);
  });

  test('a key belonging to another type is refused, not ignored', () => {
    const m = parse(`schema: 2\nname: d\nsteps:\n  - id: a\n    body: a.md\n    script: x.py\n`);
    expect(m.errors.some((e) => e.includes("add 'type: script'"))).toBe(true);
  });

  test('only a pipeline step may declare isolation — the header owns it otherwise', () => {
    const m = parse(`schema: 2\nname: d\nsteps:\n  - id: a\n    body: a.md\n    isolation: own\n`);
    expect(m.errors.some((e) => e.includes('only a'))).toBe(true);
  });

  test('an unknown step type is refused', () => {
    const m = parse(`schema: 2\nname: d\nsteps:\n  - id: a\n    type: wizard\n    body: a.md\n`);
    expect(m.errors.some((e) => e.includes('steps[0].type'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// self_improve
// ---------------------------------------------------------------------------

describe('self_improve', () => {
  test('defaults to true and is inherited by steps', () => {
    const m = parse(MINIMAL);
    expect(m.self_improve).toBe(true);
    expect(m.steps[0].self_improve).toBe(true);
  });

  test('a step overrides the pipeline in both directions', () => {
    const m = parse(`
schema: 2
name: d
self_improve: false
steps:
  - id: locked
    body: a.md
  - id: open
    body: b.md
    self_improve: true
`);
    expect(m.steps[0].self_improve).toBe(false);
    expect(m.steps[1].self_improve).toBe(true);
  });

  test('one veto freezes a shared file for every step that includes it', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: open
    body:
      - _shared/context.md
      - steps/open.md
  - id: locked
    body:
      - _shared/context.md
      - steps/locked.md
    self_improve: false
`);
    expect(m.errors).toEqual([]);
    const frozen = frozenBodyFiles(m);
    // The shared fragment is frozen even though `open` permits improvement —
    // otherwise it would be edited "through" open and rewrite locked's body.
    expect(frozen.has('_shared/context.md')).toBe(true);
    expect(frozen.has('steps/locked.md')).toBe(true);
    expect(frozen.has('steps/open.md')).toBe(false);
  });

  test('a frozen script step protects its script as well as its body', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: verify
    type: script
    script: scripts/verify.py
    self_improve: false
`);
    expect(frozenBodyFiles(m).has('scripts/verify.py')).toBe(true);
  });

  test('nothing is frozen when every step permits improvement', () => {
    const m = parse(MINIMAL);
    expect(frozenBodyFiles(m).size).toBe(0);
  });

  test('every option of a oneof is frozen, not only the one a run takes', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: a
    self_improve: false
    body:
      - oneof:
          - { use: x.md, when: f }
          - { use: y.md }
`);
    const frozen = frozenBodyFiles(m);
    expect(frozen.has('x.md')).toBe(true);
    expect(frozen.has('y.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// flow
// ---------------------------------------------------------------------------

describe('flow', () => {
  test('routing lives in the manifest and validates against step ids', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: implement
    body: i.md
  - id: review
    body: r.md
  - id: package
    body: p.md
flow:
  implement: { goto: review }
  review:
    - { when: changes_needed, goto: implement, max: 3 }
    - { goto: package }
  package: { done: true }
`);
    expect(m.errors).toEqual([]);
    expect(m.flow).not.toBeNull();
  });

  test('routing to an unknown step is a hard error', () => {
    const m = parse(`
schema: 2
name: d
steps:
  - id: a
    body: a.md
flow:
  a: { goto: nowhere }
`);
    expect(m.errors.length).toBeGreaterThan(0);
  });

  test('flow is absent by default — a pipeline without it is still valid', () => {
    expect(parse(MINIMAL).flow).toBeNull();
  });
});
