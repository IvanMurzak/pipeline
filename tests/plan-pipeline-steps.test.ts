// T3-09 — `type: pipeline` (composition) parsing + plan lints: the step
// declaration + `## Params` bindings (mirroring script steps exactly),
// reference resolution, reference-graph cycle detection, and the depth cap.
// Fixture pipelines live in real temp sandboxes, same style as plan.test.ts /
// plan-script-steps.test.ts (the established pattern for computePlan
// integration); the pure graph lint is ALSO unit-tested over an in-memory
// ComposeFs in tests/compose.test.ts.

import { test, expect, afterEach } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import { MAX_COMPOSITION_DEPTH } from '../src/lib/compose';
import { MANIFEST_FILENAME } from '../src/lib/manifest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const created: string[] = [];

interface PipelineFixture {
  manifest?: string;
  /** A SCHEMA-2 pipeline: `pipeline.yml` INSTEAD of a PIPELINE.md, which is
   *  what a migrated pipeline looks like on disk — the v1 header is gone. */
  yml?: string;
  steps: Record<string, string | ((base: string) => string)>;
}

/** Scaffold a PROJECT base dir holding one or more sibling pipelines (each a
 *  `<base>/<name>/{PIPELINE.md,steps/…}` tree — names may nest, e.g.
 *  'a/targets/x'). Returns the base; computePlan targets `join(base, name)`. */
function scaffoldProject(pipelines: Record<string, PipelineFixture>): string {
  const base = mkdtempSync(join(tmpdir(), 'plan-compose-'));
  created.push(base);
  for (const [name, p] of Object.entries(pipelines)) {
    const root = join(base, ...name.split('/'));
    mkdirSync(join(root, 'steps'), { recursive: true });
    if (p.yml !== undefined) writeFileSync(join(root, MANIFEST_FILENAME), p.yml);
    else writeFileSync(join(root, 'PIPELINE.md'), p.manifest ?? '---\n---\n');
    for (const [file, content] of Object.entries(p.steps)) {
      const full = join(root, 'steps', file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, typeof content === 'function' ? content(base) : content);
    }
  }
  return base;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

function fm(fields: Record<string, string>): string {
  return (
    '---\n' +
    Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n') +
    '\n---\n'
  );
}

/** A well-formed `type: pipeline` iteration document — same body sections as
 *  the script-step docs (## Params / ## Output / ## Next). `next` defaults to
 *  `Pipeline complete.`; pass null to omit the section entirely. */
function pipelineStepDoc(opts: {
  fm: Record<string, string>;
  params?: unknown;
  output?: unknown;
  next?: string | null;
}): string {
  const parts = [fm(opts.fm), '# Step\n', '## Goal\nRun the child pipeline.\n'];
  if (opts.params !== undefined) parts.push('## Params\n\n' + jsonBlock(opts.params) + '\n');
  if (opts.output !== undefined) parts.push('## Output\n\n' + jsonBlock(opts.output) + '\n');
  parts.push('## Success Criteria\n- child run completed\n');
  if (opts.next !== null) parts.push('## Next\n' + (opts.next ?? 'Pipeline complete.') + '\n');
  return parts.join('\n');
}

/** Minimal script-step doc (for producer/consumer binding fixtures). */
function scriptStepDoc(opts: {
  fm: Record<string, string>;
  params?: unknown;
  output?: unknown;
  next?: string | null;
}): string {
  const parts = [fm(opts.fm), '# Step\n', '## Goal\nDo the thing.\n'];
  if (opts.params !== undefined) parts.push('## Params\n\n' + jsonBlock(opts.params) + '\n');
  if (opts.output !== undefined) parts.push('## Output\n\n' + jsonBlock(opts.output) + '\n');
  parts.push('## Steps\n1. Run: `python scripts/x.py` — does the thing.\n');
  if (opts.next !== null) parts.push('## Next\n' + (opts.next ?? 'Pipeline complete.') + '\n');
  return parts.join('\n');
}

/** A minimal valid leaf pipeline (one agent step). */
const LEAF: PipelineFixture = { steps: { '01-a.md': '# A\n\n## Steps\n- do the thing\n' } };

/** A pipeline whose only step composes `ref`. The `## Next` section matters
 *  only when the pipeline is the linted ENTRY (children are read statically —
 *  frontmatter only). */
function composer(ref: string): PipelineFixture {
  return {
    steps: {
      '01-run.md': `---\ntype: pipeline\npipeline: ${ref}\n---\n# Run\n\n## Next\nPipeline complete.\n`,
    },
  };
}

// ---------------------------------------------------------------------------
// Declaration + param bindings (mirror of script-step ## Params)
// ---------------------------------------------------------------------------

test('happy path: type: pipeline + sibling ref + ## Params parse into pipeline_spec, zero lints', () => {
  const base = scaffoldProject({
    main: {
      steps: {
        '01-prep.md': (b) =>
          scriptStepDoc({
            fm: { type: 'script', script: 'scripts/prep.py', timeout: '60', step_id: 'prep' },
            output: { sha: { type: 'string' } },
            next: join(b, 'main', 'steps', '02-deploy.md'),
          }),
        '02-deploy.md': pipelineStepDoc({
          fm: { type: 'pipeline', pipeline: 'child', step_id: 'deploy' },
          params: {
            sha: { type: 'string', required: true, from: '${steps.prep.output.sha}' },
            env: { type: 'string', value: 'prod' },
          },
        }),
      },
    },
    child: LEAF,
  });
  const plan = computePlan(join(base, 'main'));
  expect(plan.errors).toEqual([]);
  expect(plan.warnings).toEqual([]);
  const step = plan.steps[1];
  expect(step.type).toBe('pipeline');
  expect(step.script_spec).toBeNull();
  expect(step.pipeline_spec).toEqual({
    pipeline: 'child',
    resolved_root: join(base, 'child'),
    params: {
      sha: { type: 'string', required: true, from: '${steps.prep.output.sha}' },
      env: { type: 'string', value: 'prod' },
    },
    output: null,
  });
  // Non-pipeline steps carry pipeline_spec: null (additive field, no behavior change).
  expect(plan.steps[0].pipeline_spec).toBeNull();
});

test("type: pipeline without a 'pipeline:' reference is a plan ERROR", () => {
  const base = scaffoldProject({
    main: { steps: { '01-run.md': pipelineStepDoc({ fm: { type: 'pipeline', step_id: 'run' } }) } },
  });
  const plan = computePlan(join(base, 'main'));
  expect(plan.errors).toEqual([
    "steps/01-run.md: type: pipeline requires a 'pipeline:' frontmatter reference (the name or relative path of another pipeline)",
  ]);
});

test('an unresolvable pipeline reference is a plan ERROR naming the probed locations', () => {
  const base = scaffoldProject({
    main: {
      steps: { '01-run.md': pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'ghost', step_id: 'run' } }) },
    },
  });
  const plan = computePlan(join(base, 'main'));
  expect(plan.errors.length).toBe(1);
  expect(plan.errors[0]).toContain("steps/01-run.md: pipeline reference 'ghost' does not resolve");
  // Both spellings are named: a schema-2 child needs no PIPELINE.md, so a
  // message that mentioned only the v1 header sent the reader hunting for a
  // file the child is not required to have.
  expect(plan.errors[0]).toContain('no pipeline.yml or PIPELINE.md at any of:');
  expect(plan.errors[0]).toContain(join(base, 'ghost'));
});

test('reference resolution bases: child under own root, explicit relative, and .pipeline by name', () => {
  // Child under the referencing pipeline's own root (family-target style).
  const child = scaffoldProject({
    main: {
      steps: { '01-run.md': pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'targets/x', step_id: 'run' } }) },
    },
    'main/targets/x': LEAF,
  });
  const childPlan = computePlan(join(child, 'main'));
  expect(childPlan.errors).toEqual([]);
  expect(childPlan.steps[0].pipeline_spec?.resolved_root).toBe(join(child, 'main', 'targets', 'x'));

  // Explicit relative traversal.
  const rel = scaffoldProject({
    main: {
      steps: { '01-run.md': pipelineStepDoc({ fm: { type: 'pipeline', pipeline: '../sibling', step_id: 'run' } }) },
    },
    sibling: LEAF,
  });
  const relPlan = computePlan(join(rel, 'main'));
  expect(relPlan.errors).toEqual([]);
  expect(relPlan.steps[0].pipeline_spec?.resolved_root).toBe(join(rel, 'sibling'));

  // By name from a NESTED pipeline via the enclosing `.pipeline` dir.
  const base = mkdtempSync(join(tmpdir(), 'plan-compose-'));
  created.push(base);
  const pipelines = join(base, '.pipeline');
  const nested = join(pipelines, 'family', 'targets', 't');
  mkdirSync(join(nested, 'steps'), { recursive: true });
  writeFileSync(join(nested, 'PIPELINE.md'), '---\n---\n');
  writeFileSync(
    join(nested, 'steps', '01-run.md'),
    pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'toplevel', step_id: 'run' } }),
  );
  const top = join(pipelines, 'toplevel');
  mkdirSync(join(top, 'steps'), { recursive: true });
  writeFileSync(join(top, 'PIPELINE.md'), '---\n---\n');
  writeFileSync(join(top, 'steps', '01-a.md'), '# A\n');
  const nestedPlan = computePlan(nested);
  expect(nestedPlan.errors).toEqual([]);
  expect(nestedPlan.steps[0].pipeline_spec?.resolved_root).toBe(top);
});

test('## Params vocabulary lints apply to pipeline steps exactly as to script steps', () => {
  const doc = (params: unknown) =>
    pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'child', step_id: 'run' }, params });

  const valueAndFrom = computePlan(
    join(
      scaffoldProject({
        main: { steps: { '01-run.md': doc({ p: { type: 'string', value: 'x', from: '${env.CI_BASE_URL}' } }) } },
        child: LEAF,
      }),
      'main',
    ),
  );
  expect(valueAndFrom.errors).toEqual([
    "steps/01-run.md: ## Params 'p' sets both 'value' and 'from' — they are mutually exclusive",
  ]);

  const unknownType = computePlan(
    join(
      scaffoldProject({
        main: { steps: { '01-run.md': doc({ p: { type: 'uuid' } }) } },
        child: LEAF,
      }),
      'main',
    ),
  );
  expect(unknownType.errors.some((e) => e.includes("'p' has unknown type 'uuid'"))).toBe(true);

  const secret = computePlan(
    join(
      scaffoldProject({
        main: { steps: { '01-run.md': doc({ p: { type: 'string', from: 'Bearer ${env.GH_TOKEN}' } }) } },
        child: LEAF,
      }),
      'main',
    ),
  );
  expect(secret.errors).toEqual([]);
  expect(secret.warnings.length).toBe(1);
  expect(secret.warnings[0]).toContain('${env.GH_TOKEN} looks like a secret');

  const malformed = computePlan(
    join(
      scaffoldProject({
        main: { steps: { '01-run.md': doc({ p: { type: 'string', from: '${steps.prep}' } }) } },
        child: LEAF,
      }),
      'main',
    ),
  );
  expect(malformed.errors).toEqual([
    "steps/01-run.md ## Params 'p': malformed reference ${steps.prep} — expected ${steps.<step_id>.output.<path>}",
  ]);
});

test('sequential mode: a pipeline step ${steps.x…} binding must reference an EARLIER step', () => {
  const base = scaffoldProject({
    main: {
      steps: {
        '01-run.md': (b) =>
          pipelineStepDoc({
            fm: { type: 'pipeline', pipeline: 'child', step_id: 'run' },
            params: { x: { type: 'string', from: '${steps.later.output.sha}' } }, // forward ref
            next: join(b, 'main', 'steps', '02-later.md'),
          }),
        '02-later.md': scriptStepDoc({
          fm: { type: 'script', script: 'scripts/later.py', timeout: '60', step_id: 'later' },
          output: { sha: { type: 'string' } },
        }),
      },
    },
    child: LEAF,
  });
  const plan = computePlan(join(base, 'main'));
  expect(plan.errors.length).toBe(1);
  expect(plan.errors[0]).toContain("does not reference a topological ancestor of 'run'");
});

test('a pipeline step is a valid ## Output PRODUCER: downstream bindings are field-checked against it', () => {
  const producer = (b: string) =>
    pipelineStepDoc({
      fm: { type: 'pipeline', pipeline: 'child', step_id: 'p' },
      output: { result: { type: 'string' } },
      next: join(b, 'main', 'steps', '02-c.md'),
    });
  const consumer = (from: string) =>
    scriptStepDoc({
      fm: { type: 'script', script: 'scripts/c.py', timeout: '60', step_id: 'c' },
      params: { x: { type: 'string', from } },
    });

  const ok = computePlan(
    join(
      scaffoldProject({
        main: { steps: { '01-p.md': producer, '02-c.md': consumer('${steps.p.output.result}') } },
        child: LEAF,
      }),
      'main',
    ),
  );
  expect(ok.errors).toEqual([]);

  const undeclared = computePlan(
    join(
      scaffoldProject({
        main: { steps: { '01-p.md': producer, '02-c.md': consumer('${steps.p.output.bogus}') } },
        child: LEAF,
      }),
      'main',
    ),
  );
  expect(undeclared.errors).toEqual([
    "steps/02-c.md ## Params 'x': step 'p' declares ## Output without field 'bogus'",
  ]);
});

test('## Next lint applies to sequential pipeline steps (and is skipped in graph mode)', () => {
  const missing = computePlan(
    join(
      scaffoldProject({
        main: {
          steps: {
            '01-run.md': pipelineStepDoc({
              fm: { type: 'pipeline', pipeline: 'child', step_id: 'run' },
              next: null,
            }),
          },
        },
        child: LEAF,
      }),
      'main',
    ),
  );
  expect(missing.errors.length).toBe(1);
  expect(missing.errors[0]).toContain('## Next of a sequential pipeline step');

  const graphManifest =
    '---\n---\n# P\n\n## Graph\n\n' + jsonBlock({ run: { done: true } }) + '\n';
  const graphMode = computePlan(
    join(
      scaffoldProject({
        main: {
          manifest: graphManifest,
          steps: {
            '01-run.md': pipelineStepDoc({
              fm: { type: 'pipeline', pipeline: 'child', step_id: 'run' },
              next: null,
            }),
          },
        },
        child: LEAF,
      }),
      'main',
    ),
  );
  expect(graphMode.graph).not.toBeNull();
  expect(graphMode.errors).toEqual([]);
});

test('script-only frontmatter on a pipeline step warns and is ignored; pipeline: on an agent step warns', () => {
  const base = scaffoldProject({
    main: {
      steps: {
        '01-run.md': pipelineStepDoc({
          fm: { type: 'pipeline', pipeline: 'child', step_id: 'run', script: 'scripts/x.py', timeout: '60' },
        }),
        '02-agent.md': '---\nstep_id: agent\npipeline: child\n---\n# Agent\n',
      },
    },
    child: LEAF,
  });
  const plan = computePlan(join(base, 'main'));
  expect(plan.errors).toEqual([]);
  expect(plan.warnings).toEqual([
    'steps/01-run.md: script-step field(s) script, timeout ignored on a type: pipeline step (the child pipeline owns its own execution)',
    "steps/02-agent.md: 'pipeline:' ignored on an agent step (add 'type: pipeline' to compose another pipeline)",
  ]);
  expect(plan.steps[1].type).toBe('agent');
  expect(plan.steps[1].pipeline_spec).toBeNull();
});

test('pipeline steps keep the model/effort ladder and participate in DAG mode like any step', () => {
  const base = scaffoldProject({
    main: {
      manifest: '---\nexecution: parallel\nmodel: sonnet\n---\n',
      steps: {
        '01-a.md': '---\nstep_id: a\n---\n# A\n',
        '02-run.md': pipelineStepDoc({
          fm: { type: 'pipeline', pipeline: 'child', step_id: 'run', 'depends-on': '[a]', model: 'opus' },
          next: null,
        }),
      },
    },
    child: LEAF,
  });
  const plan = computePlan(join(base, 'main'));
  expect(plan.errors).toEqual([]);
  expect(plan.warnings).toEqual([]);
  expect(plan.layers).toEqual([['a'], ['run']]);
  expect(plan.steps[1].model).toBe('opus');
});

// ---------------------------------------------------------------------------
// Reference-graph cycle detection
// ---------------------------------------------------------------------------

test('self-reference is a composition cycle ERROR naming the pipeline', () => {
  const base = scaffoldProject({
    main: {
      steps: { '01-run.md': pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'main', step_id: 'run' } }) },
    },
  });
  const plan = computePlan(join(base, 'main'));
  expect(plan.errors.length).toBe(1);
  expect(plan.errors[0]).toContain('composition cycle detected: main → main');
});

test('A→B→A is a composition cycle ERROR naming the cycle path', () => {
  const base = scaffoldProject({
    a: {
      steps: { '01-run.md': pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'b', step_id: 'run' } }) },
    },
    b: composer('a'),
  });
  const plan = computePlan(join(base, 'a'));
  expect(plan.errors.length).toBe(1);
  expect(plan.errors[0]).toContain('composition cycle detected: a → b → a');
  expect(plan.errors[0]).toContain("'type: pipeline' references must form a DAG");
});

test('a longer cycle (A→B→C→A) is reported with the full path', () => {
  const base = scaffoldProject({
    a: {
      steps: { '01-run.md': pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'b', step_id: 'run' } }) },
    },
    b: composer('c'),
    c: composer('a'),
  });
  const plan = computePlan(join(base, 'a'));
  expect(plan.errors.length).toBe(1);
  expect(plan.errors[0]).toContain('composition cycle detected: a → b → c → a');
});

test('a valid composition DAG (diamond) lints clean — shared children are not cycles', () => {
  const base = scaffoldProject({
    a: {
      steps: {
        '01-b.md': (bs) =>
          pipelineStepDoc({
            fm: { type: 'pipeline', pipeline: 'b', step_id: 'run-b' },
            next: join(bs, 'a', 'steps', '02-c.md'),
          }),
        '02-c.md': pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'c', step_id: 'run-c' } }),
      },
    },
    b: composer('d'),
    c: composer('d'),
    d: LEAF,
  });
  const plan = computePlan(join(base, 'a'));
  expect(plan.errors).toEqual([]);
  expect(plan.warnings).toEqual([]);
});

test("a child pipeline's own broken reference surfaces in the parent's lint, labeled", () => {
  const missingRef = scaffoldProject({
    main: {
      steps: { '01-run.md': pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'b', step_id: 'run' } }) },
    },
    b: { steps: { '01-x.md': '---\ntype: pipeline\npipeline: ghost\n---\n# X\n' } },
  });
  const unresolvable = computePlan(join(missingRef, 'main'));
  expect(unresolvable.errors.length).toBe(1);
  expect(unresolvable.errors[0]).toContain("composition: 'b' steps/01-x.md: pipeline reference 'ghost' does not resolve");

  const noKey = scaffoldProject({
    main: {
      steps: { '01-run.md': pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'b', step_id: 'run' } }) },
    },
    b: { steps: { '01-x.md': '---\ntype: pipeline\n---\n# X\n' } },
  });
  const missing = computePlan(join(noKey, 'main'));
  expect(missing.errors.length).toBe(1);
  expect(missing.errors[0]).toContain(
    "composition: 'b' steps/01-x.md: type: pipeline requires a 'pipeline:' frontmatter reference",
  );
});

// ---------------------------------------------------------------------------
// Depth cap
// ---------------------------------------------------------------------------

/** Fixture: a linear chain p1 → p2 → … → pN (pN is a leaf). */
function chain(n: number): Record<string, PipelineFixture> {
  const out: Record<string, PipelineFixture> = {};
  for (let i = 1; i < n; i++) out[`p${i}`] = composer(`p${i + 1}`);
  out[`p${n}`] = LEAF;
  return out;
}

test(`a chain at the default cap (${MAX_COMPOSITION_DEPTH} pipelines) lints clean; one deeper is an ERROR`, () => {
  const ok = computePlan(join(scaffoldProject(chain(MAX_COMPOSITION_DEPTH)), 'p1'));
  expect(ok.errors).toEqual([]);

  const over = computePlan(join(scaffoldProject(chain(MAX_COMPOSITION_DEPTH + 1)), 'p1'));
  expect(over.errors.length).toBe(1);
  expect(over.errors[0]).toContain(
    `composition depth ${MAX_COMPOSITION_DEPTH + 1} exceeds the cap (${MAX_COMPOSITION_DEPTH})`,
  );
  expect(over.errors[0]).toContain('p1 → p2 → p3 → p4 → p5 → p6 → p7');
});

test('maxCompositionDepth overrides the cap; invalid values warn and use the default', () => {
  const base = scaffoldProject(chain(4));
  const capped = computePlan(join(base, 'p1'), { maxCompositionDepth: 3 });
  expect(capped.errors.length).toBe(1);
  expect(capped.errors[0]).toContain('composition depth 4 exceeds the cap (3)');

  const loosened = computePlan(join(base, 'p1'), { maxCompositionDepth: 4 });
  expect(loosened.errors).toEqual([]);

  const invalid = computePlan(join(base, 'p1'), { maxCompositionDepth: 0 });
  expect(invalid.errors).toEqual([]); // depth 4 ≤ default 6
  expect(invalid.warnings).toEqual([
    `maxCompositionDepth 0 is invalid (positive integer required) — using the default ${MAX_COMPOSITION_DEPTH}`,
  ]);
});

// ---------------------------------------------------------------------------
// Backward compatibility (regression)
// ---------------------------------------------------------------------------

test('backward compat: a non-composed pipeline (agent + script steps) lints exactly as before', () => {
  const base = scaffoldProject({
    main: {
      manifest: '---\nexecution: parallel\nmodel: sonnet\n---\n# Pipeline\n\n## End State\nSmall.\n',
      steps: {
        '01-build.md': '---\nstep_id: build\n---\n# Build\n\n## Steps\n- do one thing\n',
        '02-test.md': scriptStepDoc({
          fm: { type: 'script', script: 'scripts/t.py', timeout: '60', step_id: 'test', 'depends-on': '[build]' },
          next: null,
        }),
      },
    },
  });
  const plan = computePlan(join(base, 'main'));
  expect(plan.errors).toEqual([]);
  expect(plan.warnings).toEqual([]);
  expect(plan.layers).toEqual([['build'], ['test']]);
  expect(plan.steps.map((s) => s.type)).toEqual(['agent', 'script']);
  expect(plan.steps.map((s) => s.pipeline_spec)).toEqual([null, null]);
});

test("backward compat: unknown type: values still warn and default to agent ('pipeline' is now recognized)", () => {
  const base = scaffoldProject({
    main: {
      steps: {
        '01-a.md': '---\ntype: robot\n---\n# A\n',
      },
    },
  });
  const plan = computePlan(join(base, 'main'));
  expect(plan.steps[0].type).toBe('agent');
  expect(plan.warnings).toEqual(["steps/01-a.md: unknown type 'robot' — treating as agent"]);
});

// ---------------------------------------------------------------------------
// SCHEMA-2 composition — resolution and the graph lint over real trees
//
// Two halves of one hole. `resolvePipelineRef` probed PIPELINE.md only, so a
// migrated child was reported as a broken reference; and the graph lint ran
// only on the v1 walk, so a schema-2 plan checked that each reference RESOLVED
// and nothing else — a cycle between two manifests planned clean and produced
// a run that descends until the runtime depth fail-safe trips.
// ---------------------------------------------------------------------------

/** A leaf schema-2 pipeline: one agent step, no composition. */
function ymlLeaf(name: string): PipelineFixture {
  return {
    yml: `schema: 2\nname: ${name}\nsteps:\n  - name: a\n    body: steps/01-a.md\n`,
    steps: { '01-a.md': '# A\n\n## Steps\n- do the thing\n' },
  };
}

/** A schema-2 pipeline whose only step composes `ref`. */
function ymlComposer(name: string, ref: string): PipelineFixture {
  return {
    yml: `schema: 2\nname: ${name}\nsteps:\n  - name: run\n    type: pipeline\n    pipeline: ${ref}\n`,
    steps: {},
  };
}

test('a v1 pipeline resolves a SCHEMA-2 child — a pipeline.yml is a pipeline root', () => {
  const base = scaffoldProject({
    main: {
      steps: { '01-run.md': pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'child', step_id: 'run' } }) },
    },
    child: ymlLeaf('child'),
  });
  const plan = computePlan(join(base, 'main'));
  expect(plan.errors).toEqual([]);
  expect(plan.steps[0].pipeline_spec?.resolved_root).toBe(join(base, 'child'));
});

test('a SCHEMA-2 plan detects a cycle between two manifests (A→B→A)', () => {
  const base = scaffoldProject({ a: ymlComposer('a', 'b'), b: ymlComposer('b', 'a') });
  const plan = computePlan(join(base, 'a'));
  expect(plan.errors.length).toBe(1);
  expect(plan.errors[0]).toContain('composition cycle detected: a → b → a');
  expect(plan.errors[0]).toContain("'type: pipeline' references must form a DAG");
});

test('a SCHEMA-2 plan detects a self-reference', () => {
  const base = scaffoldProject({ a: ymlComposer('a', 'a') });
  const plan = computePlan(join(base, 'a'));
  expect(plan.errors.length).toBe(1);
  expect(plan.errors[0]).toContain('composition cycle detected: a → a');
});

test('a SCHEMA-2 chain one deeper than the cap is an ERROR; at the cap it is clean', () => {
  const chainOf = (n: number): Record<string, PipelineFixture> => {
    const out: Record<string, PipelineFixture> = {};
    for (let i = 1; i < n; i++) out[`p${i}`] = ymlComposer(`p${i}`, `p${i + 1}`);
    out[`p${n}`] = ymlLeaf(`p${n}`);
    return out;
  };

  const over = computePlan(join(scaffoldProject(chainOf(MAX_COMPOSITION_DEPTH + 1)), 'p1'));
  expect(over.errors.length).toBe(1);
  expect(over.errors[0]).toContain(
    `composition depth ${MAX_COMPOSITION_DEPTH + 1} exceeds the cap (${MAX_COMPOSITION_DEPTH})`,
  );
  expect(over.errors[0]).toContain('p1 → p2 → p3 → p4 → p5 → p6 → p7');

  expect(computePlan(join(scaffoldProject(chainOf(MAX_COMPOSITION_DEPTH)), 'p1')).errors).toEqual([]);
});

test('maxCompositionDepth overrides the cap on the SCHEMA-2 path too, and warns when invalid', () => {
  const base = scaffoldProject({
    p1: ymlComposer('p1', 'p2'),
    p2: ymlComposer('p2', 'p3'),
    p3: ymlLeaf('p3'),
  });
  const capped = computePlan(join(base, 'p1'), { maxCompositionDepth: 2 });
  expect(capped.errors.length).toBe(1);
  expect(capped.errors[0]).toContain('composition depth 3 exceeds the cap (2)');

  expect(computePlan(join(base, 'p1'), { maxCompositionDepth: 3 }).errors).toEqual([]);

  const invalid = computePlan(join(base, 'p1'), { maxCompositionDepth: 0 });
  expect(invalid.errors).toEqual([]);
  expect(invalid.warnings).toContain(
    `maxCompositionDepth 0 is invalid (positive integer required) — using the default ${MAX_COMPOSITION_DEPTH}`,
  );
});

test('a MIXED cycle is detected from either end (v1 ↔ schema-2)', () => {
  const fromV1 = scaffoldProject({
    a: {
      steps: { '01-run.md': pipelineStepDoc({ fm: { type: 'pipeline', pipeline: 'b', step_id: 'run' } }) },
    },
    b: ymlComposer('b', 'a'),
  });
  expect(computePlan(join(fromV1, 'a')).errors[0]).toContain('composition cycle detected: a → b → a');

  const fromV2 = scaffoldProject({ a: ymlComposer('a', 'b'), b: composer('a') });
  expect(computePlan(join(fromV2, 'a')).errors[0]).toContain('composition cycle detected: a → b → a');
});

test('a SCHEMA-2 composition DAG (diamond) lints clean — the lint does not fire on valid graphs', () => {
  const base = scaffoldProject({
    a: {
      yml:
        'schema: 2\nname: a\nsteps:\n' +
        '  - name: run-b\n    type: pipeline\n    pipeline: b\n' +
        '  - name: run-c\n    type: pipeline\n    pipeline: c\n',
      steps: {},
    },
    b: ymlComposer('b', 'd'),
    c: ymlComposer('c', 'd'),
    d: ymlLeaf('d'),
  });
  const plan = computePlan(join(base, 'a'));
  expect(plan.errors).toEqual([]);
  expect(plan.warnings).toEqual([]);
});

test('a non-composed SCHEMA-2 pipeline is untouched by the lint', () => {
  const base = scaffoldProject({ solo: ymlLeaf('solo') });
  const plan = computePlan(join(base, 'solo'));
  expect(plan.errors).toEqual([]);
  expect(plan.warnings).toEqual([]);
  expect(plan.steps.map((s) => s.pipeline_spec)).toEqual([null]);
});
