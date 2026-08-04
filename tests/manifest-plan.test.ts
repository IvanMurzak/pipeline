// planFromManifest — the v2 manifest translated into the engine's Plan.
//
//   bun test tests/manifest-plan.test.ts
//
// The contract these tests hold is EQUIVALENCE, not novelty: a plan built from
// `pipeline.yml` must dispatch exactly like the v1 plan it replaces. So the
// assertions are mostly about things NOT changing — step order, model
// resolution, the mode the engine picks, whether a layer list exists — plus the
// handful of places where v2 says something v1 could not.

import { test, expect, describe } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFromManifest } from '../src/lib/manifest-plan';
import { parseManifest } from '../src/lib/manifest';
import { pickMode } from '../src/lib/next';
import { DEFAULT_SCRIPT_TIMEOUT_S } from '../src/lib/script-types';

// An absolute root on both platforms. Nothing is read from disk — the
// translation only joins paths — so the directory need not exist.
const ROOT = join(tmpdir(), 'pipeline-plan-demo', '.pipeline', 'demo');

function plan(yaml: string, options = {}) {
  const manifest = parseManifest(yaml.trim() + '\n');
  return planFromManifest(manifest, ROOT, options);
}

/** A three-step linear pipeline — the shape every local pipeline actually has. */
const LINEAR = `
schema: 2
name: demo
defaults:
  model: sonnet
steps:
  - name: implement
    body: steps/01-implement.md
    model: opus
  - name: review
    body: steps/02-review.md
  - name: ship
    body: steps/03-ship.md
    model: haiku
`;

describe('the shape the engine consumes', () => {
  test('steps keep declaration order, and each one is identified by its name', () => {
    const p = plan(LINEAR);
    expect(p.errors).toEqual([]);
    expect(p.steps.map((s) => s.step_id)).toEqual(['implement', 'review', 'ship']);
    expect(p.steps.map((s) => s.index)).toEqual([1, 2, 3]);
  });

  test('an absent `needs` inherits the previous step, so a linear chain wires itself', () => {
    const p = plan(LINEAR);
    expect(p.steps.map((s) => s.depends_on)).toEqual([[], ['implement'], ['review']]);
  });

  test('model resolves step → pipeline default → inherit', () => {
    const p = plan(LINEAR);
    expect(p.steps.map((s) => s.model)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(p.default_model).toBe('sonnet');
  });

  test('a per-run override beats the step and the default; `inherit` forces the session model', () => {
    const p = plan(LINEAR, { modelOverrides: { implement: 'haiku', review: null } });
    expect(p.steps[0].model).toBe('haiku');
    // Key PRESENCE wins, not value truthiness — null means "inherit", and must
    // not fall through to the pipeline default.
    expect(p.steps[1].model).toBeNull();
    expect(p.model_overrides).toEqual({ implement: 'haiku', review: null });
  });

  test('an invalid override warns and is dropped rather than pinning a bad model', () => {
    const p = plan(LINEAR, { modelOverrides: { implement: 'gpt-9' } });
    expect(p.steps[0].model).toBe('opus');
    expect(p.warnings.some((w) => w.includes('invalid model'))).toBe(true);
  });

  test("a step's own invalid model warns and inherits — it never silently picks a tier", () => {
    const p = plan(`
schema: 2
name: demo
steps:
  - name: a
    body: a.md
    model: sonnet-ish
`);
    expect(p.steps[0].model).toBeNull();
    expect(p.warnings.some((w) => w.includes("step 'a'") && w.includes('invalid model'))).toBe(true);
  });

  test('a sequential pipeline carries NO layers, so the engine picks the same mode as v1', () => {
    const p = plan(LINEAR);
    expect(p.mode).toBe('sequential');
    expect(p.layers).toBeNull();
    expect(pickMode(p)).toBe('sequential');
  });

  test('a parallel pipeline carries its topological layers', () => {
    const p = plan(`
schema: 2
name: demo
execution: parallel
steps:
  - name: setup
    body: a.md
  - name: lint
    body: b.md
    needs: [setup]
  - name: test
    body: c.md
    needs: [setup]
  - name: package
    body: d.md
    needs: [lint, test]
`);
    expect(p.errors).toEqual([]);
    expect(p.mode).toBe('parallel');
    expect(p.layers).toEqual([['setup'], ['lint', 'test'], ['package']]);
    expect(pickMode(p)).toBe('parallel');
  });

  test('a declared flow becomes the routing graph, and the engine switches to graph mode', () => {
    const p = plan(`
schema: 2
name: demo
steps:
  - name: build
    body: a.md
  - name: review
    body: b.md
flow:
  build:
    goto: review
  review:
    - when: changes_requested
      goto: build
      max: 3
    - done: true
`);
    expect(p.errors).toEqual([]);
    expect(p.graph).not.toBeNull();
    expect(pickMode(p)).toBe('graph');
  });

  test('manifest errors flow onto the plan — one list decides whether to halt', () => {
    const p = plan(`schema: 2\nname: demo\nsteps:\n  - name: a\n    body: a.md\n    needs: [ghost]\n`);
    expect(p.errors.some((e) => e.includes("needs unknown step 'ghost'"))).toBe(true);
  });
});

describe('isolation is a scope, translated to the mechanism the engine implements', () => {
  test.each([
    ['none', 'manual'],
    ['step', 'worktree'],
    ['run', 'external'],
  ])('isolation: %s → %s', (scope, mechanism) => {
    const p = plan(`schema: 2\nname: demo\nisolation: ${scope}\nsteps:\n  - name: a\n    body: a.md\n`);
    expect(p.errors).toEqual([]);
    expect(p.isolation).toBe(mechanism as never);
  });

  test('the default is no worktree at all', () => {
    expect(plan(LINEAR).isolation).toBe('manual');
  });
});

describe('step bodies and the path the engine keys on', () => {
  test('a body path is resolved against the pipeline root, and rel drops the steps/ prefix', () => {
    const p = plan(LINEAR);
    expect(p.steps[0].path).toBe(join(ROOT, 'steps', '01-implement.md'));
    expect(p.steps[0].rel).toBe('01-implement.md');
  });

  test('a body OUTSIDE steps/ keeps its pipeline-root-relative label', () => {
    const p = plan(`schema: 2\nname: demo\nsteps:\n  - name: a\n    body: _shared/preamble.md\n`);
    expect(p.steps[0].rel).toBe('_shared/preamble.md');
  });

  test('a COMPOSED step is labelled by its name, not by a fragment it may share', () => {
    // The composed prompt is written at this label inside the run's shadow
    // tree; a shared `_shared/preamble.md` is the first fragment of many steps,
    // so labelling by it would name them all the same thing.
    const p = plan(`
schema: 2
name: demo
steps:
  - name: a
    body:
      - _shared/preamble.md
      - steps/01-a.md
`);
    expect(p.steps[0].path).toBe(join(ROOT, 'steps', 'a.md'));
    expect(p.steps[0].rel).toBe('a.md');
    // The fragments themselves ride the declaration, resolved per dispatch.
    expect(p.steps[0].body.map((e) => (e.kind === 'include' ? e.use : ''))).toEqual([
      join(ROOT, '_shared', 'preamble.md'),
      join(ROOT, 'steps', '01-a.md'),
    ]);
  });

  test('a manifest plan advances by the manifest; a v1 walk by what a step reports', () => {
    expect(plan(LINEAR).advance).toBe('manifest');
  });

  test('a bodyless step still gets a stable key — nothing reads it, but the engine compares it', () => {
    const p = plan(`
schema: 2
name: demo
steps:
  - name: verify
    type: script
    script: scripts/verify.py
`);
    expect(p.errors).toEqual([]);
    expect(p.steps[0].path).toBe(join(ROOT, 'steps', 'verify.md'));
    expect(p.steps[0].rel).toBe('verify.md');
  });

  test('two steps never share a key, because a name is unique and a duplicate is an error', () => {
    const p = plan(`schema: 2\nname: demo\nsteps:\n  - name: a\n    body: x.md\n  - name: a\n    body: y.md\n`);
    expect(p.errors.some((e) => e.includes("duplicate step name 'a'"))).toBe(true);
  });
});

describe('script steps', () => {
  const SCRIPT = `
schema: 2
name: demo
steps:
  - name: build
    type: script
    script: scripts/build.py
    timeout: 180
    retries: 2
    on_failure: agent
    params:
      root:
        type: string
        required: true
        from: \${project.root}
    output:
      sha:
        type: string
`;

  test('the spec comes from the manifest keys v1 read out of `## Params` and frontmatter', () => {
    const p = plan(SCRIPT);
    expect(p.errors).toEqual([]);
    const spec = p.steps[0].script_spec!;
    expect(spec.script).toBe('scripts/build.py');
    expect(spec.timeoutS).toBe(180);
    expect(spec.retries).toBe(2);
    expect(spec.onFailure).toBe('agent');
    expect(spec.params).toEqual({
      root: { type: 'string', required: true, from: '${project.root}' },
    });
    expect(spec.output).toEqual({ sha: { type: 'string' } });
  });

  test('omitted knobs take the frozen defaults, not zero', () => {
    const p = plan(`schema: 2\nname: demo\nsteps:\n  - name: b\n    type: script\n    script: s.py\n`);
    const spec = p.steps[0].script_spec!;
    expect(spec.timeoutS).toBe(DEFAULT_SCRIPT_TIMEOUT_S);
    expect(spec.retries).toBe(0);
    expect(spec.onFailure).toBe('halt');
    expect(spec.params).toBeNull();
    expect(spec.output).toBeNull();
  });

  test('a timeout the manager cannot honor warns — the outer call would kill it first', () => {
    const p = plan(`schema: 2\nname: demo\nsteps:\n  - name: b\n    type: script\n    script: s.py\n    timeout: 900\n`);
    expect(p.warnings.some((w) => w.includes("step 'b'") && w.includes('manager-safe'))).toBe(true);
  });

  test('a script step carries no AGENT retry budget — its own lives on the spec', () => {
    const p = plan(SCRIPT);
    expect(p.steps[0].retries).toBe(0);
    expect(p.steps[0].script_spec!.retries).toBe(2);
  });

  test("an agent step's retries land on the step, where the engine's re-dispatch reads them", () => {
    const p = plan(`schema: 2\nname: demo\nsteps:\n  - name: a\n    body: a.md\n    retries: 3\n`);
    expect(p.steps[0].retries).toBe(3);
    expect(p.steps[0].script_spec).toBeNull();
  });
});

describe('gate steps', () => {
  test('a gate carries its role and its prompt, both declared in the manifest', () => {
    const p = plan(`
schema: 2
name: demo
steps:
  - name: build
    body: a.md
  - name: ship
    type: gate
    required_role: admin
    message: Deploy to production?
`);
    expect(p.errors).toEqual([]);
    const gate = p.steps[1];
    expect(gate.type).toBe('gate');
    expect(gate.gate_spec).toEqual({ required_role: 'admin', message: 'Deploy to production?' });
    // A gate executes nothing, so it has neither of the other specs.
    expect(gate.script_spec).toBeNull();
    expect(gate.pipeline_spec).toBeNull();
  });

  test('a gate with no message falls back to the runtime default prompt', () => {
    const p = plan(`schema: 2\nname: demo\nsteps:\n  - name: ship\n    type: gate\n    required_role: owner\n`);
    expect(p.steps[0].gate_spec).toEqual({ required_role: 'owner', message: null });
  });
});

describe('pipeline steps', () => {
  const stubResolver = (ref: string) =>
    ref === '../release'
      ? { root: join(tmpdir(), 'pipeline-plan-demo', '.pipeline', 'release'), tried: [] }
      : { root: null, tried: ['a', 'b'] };

  test("the child's inputs come from `args:`, in the same vocabulary as a script's params", () => {
    const p = plan(
      `
schema: 2
name: demo
steps:
  - name: release
    type: pipeline
    pipeline: ../release
    args:
      package:
        type: string
        value: protocol
`,
      { resolvePipeline: stubResolver },
    );
    expect(p.errors).toEqual([]);
    const spec = p.steps[0].pipeline_spec!;
    expect(spec.pipeline).toBe('../release');
    expect(spec.resolved_root).toBe(join(tmpdir(), 'pipeline-plan-demo', '.pipeline', 'release'));
    expect(spec.params).toEqual({ package: { type: 'string', value: 'protocol' } });
  });

  test('an unresolvable reference is a plan ERROR, naming where it looked', () => {
    const p = plan(
      `schema: 2\nname: demo\nsteps:\n  - name: r\n    type: pipeline\n    pipeline: ../ghost\n`,
      { resolvePipeline: stubResolver },
    );
    expect(p.errors.some((e) => e.includes("'../ghost' does not resolve") && e.includes('a, b'))).toBe(true);
  });
});

describe('the pipeline header', () => {
  test('submodules and base_branch reach the worktree hooks unchanged', () => {
    const p = plan(`
schema: 2
name: demo
isolation: run
base_branch: develop
submodules:
  - public/package/one
  - public/package/two
steps:
  - name: a
    body: a.md
`);
    expect(p.base_branch).toBe('develop');
    expect(p.submodules).toEqual(['public/package/one', 'public/package/two']);
    expect(p.worktree_hook_dir).toBe('.pipeline/.hooks');
  });

  test('vars become variable declarations carrying their defaults', () => {
    const p = plan(`
schema: 2
name: demo
vars:
  PP_REGION: eu
  PP_RETRIES: 3
steps:
  - name: a
    body: a.md
`);
    expect(p.variables).toEqual([
      { name: 'PP_REGION', description: '', required: false, default: 'eu' },
      { name: 'PP_RETRIES', description: '', required: false, default: '3' },
    ]);
  });
});

describe('binding lints — the same checks v1 ran over `## Params`', () => {
  const producerAndConsumer = (from: string, output = 'sha:\n        type: string') => `
schema: 2
name: demo
steps:
  - name: build
    type: script
    script: build.py
    output:
      ${output}
  - name: ship
    type: script
    script: ship.py
    params:
      ref:
        type: string
        from: ${from}
`;

  test('a binding to an earlier step and a declared field is clean', () => {
    const p = plan(producerAndConsumer('${steps.build.output.sha}'));
    expect(p.errors).toEqual([]);
  });

  test('a field the producer never declares is caught before the run starts', () => {
    const p = plan(producerAndConsumer('${steps.build.output.tag}'));
    expect(p.errors.some((e) => e.includes("without field 'tag'"))).toBe(true);
  });

  test('a reference to a step that does not exist is an error', () => {
    const p = plan(producerAndConsumer('${steps.ghost.output.sha}'));
    expect(p.errors.some((e) => e.includes('names no step in this pipeline'))).toBe(true);
  });

  test('a reference to a LATER step is an error — it cannot have produced anything yet', () => {
    const p = plan(`
schema: 2
name: demo
steps:
  - name: first
    type: script
    script: a.py
    params:
      ref:
        type: string
        from: \${steps.second.output.sha}
  - name: second
    type: script
    script: b.py
    output:
      sha:
        type: string
`);
    expect(p.errors.some((e) => e.includes("does not run before 'first'"))).toBe(true);
  });

  test('a malformed reference errors with the message the runtime would use', () => {
    const p = plan(producerAndConsumer('${steps.build}'));
    expect(p.errors.some((e) => e.includes('malformed reference'))).toBe(true);
    // The ancestor/field checks are skipped — a reference that never resolves
    // has nothing further to check, and two messages for one typo is noise.
    expect(p.errors.filter((e) => e.includes("param 'ref'"))).toHaveLength(1);
  });

  test('a secret-looking env binding warns rather than failing the plan', () => {
    const p = plan(producerAndConsumer('${env.GITHUB_TOKEN}'));
    expect(p.errors).toEqual([]);
    expect(p.warnings.some((w) => w.includes('looks like a secret'))).toBe(true);
  });

  test('graph mode skips the ancestor check — order is decided at runtime there', () => {
    const p = plan(`
schema: 2
name: demo
steps:
  - name: build
    type: script
    script: a.py
    params:
      ref:
        type: string
        from: \${steps.verify.output.sha}
  - name: verify
    type: script
    script: b.py
    output:
      sha:
        type: string
flow:
  build:
    goto: verify
  verify:
    - when: retry
      goto: build
      max: 2
    - done: true
`);
    expect(p.errors).toEqual([]);
  });

  test("a pipeline step's args are linted exactly like a script step's params", () => {
    const p = plan(
      `
schema: 2
name: demo
steps:
  - name: build
    type: script
    script: a.py
    output:
      sha:
        type: string
  - name: release
    type: pipeline
    pipeline: ../release
    args:
      ref:
        type: string
        from: \${steps.build.output.nope}
`,
      { resolvePipeline: () => ({ root: '/somewhere', tried: [] }) },
    );
    expect(p.errors.some((e) => e.includes("without field 'nope'"))).toBe(true);
  });
});
