// T11 — `type: script` step parsing + plan lints (roadmap/script-steps/DESIGN.md
// §2 declaration, §3 Params/Output/bindings, §7 manager call-budget lint).
// Fixture pipelines live in real temp sandboxes, same style as plan.test.ts.

import { test, expect, afterEach } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import { DEFAULT_SCRIPT_TIMEOUT_S, MANAGER_SAFE_TIMEOUT_S } from '../src/lib/script-types';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const created: string[] = [];

/** Step contents may be a function of the pipeline root so `## Next` can carry
 *  a real absolute path into the fixture. */
function scaffold(
  manifest: string | null,
  steps: Record<string, string | ((root: string) => string)>,
): string {
  const root = mkdtempSync(join(tmpdir(), 'plan-script-'));
  created.push(root);
  if (manifest !== null) writeFileSync(join(root, 'PIPELINE.md'), manifest);
  const stepsDir = join(root, 'steps');
  mkdirSync(stepsDir, { recursive: true });
  for (const [name, content] of Object.entries(steps)) {
    const full = join(stepsDir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'function' ? content(root) : content);
  }
  return root;
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

/** A well-formed script-step iteration document (§2.2 body sections). `next`
 *  defaults to `Pipeline complete.`; pass null to omit the section entirely. */
function scriptStepDoc(opts: {
  fm: Record<string, string>;
  params?: unknown;
  output?: unknown;
  next?: string | null;
}): string {
  const parts = [fm(opts.fm), '# Step\n', '## Goal\nDo the thing.\n'];
  if (opts.params !== undefined) parts.push('## Params\n\n' + jsonBlock(opts.params) + '\n');
  if (opts.output !== undefined) parts.push('## Output\n\n' + jsonBlock(opts.output) + '\n');
  parts.push('## Success Criteria\n- done\n');
  parts.push('## Steps\n1. Run: `python scripts/x.py` — does the thing.\n');
  if (opts.next !== null) parts.push('## Next\n' + (opts.next ?? 'Pipeline complete.') + '\n');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

test('backward compat: a type-less pipeline parses as agent steps, script_spec null, zero new lints', () => {
  const plan = computePlan(
    scaffold('---\nexecution: parallel\nmodel: sonnet\n---\n# Pipeline\n\n## End State\nSmall.\n', {
      '01-build.md': '---\nstep_id: build\n---\n# Build\n\n## Steps\n- do one thing\n',
      '02-test.md': '---\nstep_id: test\ndepends-on: [build]\n---\n# Test\n\n## Steps\n- run tests\n',
    }),
  );
  expect(plan.errors).toEqual([]);
  expect(plan.warnings).toEqual([]);
  expect(plan.mode).toBe('parallel');
  expect(plan.layers).toEqual([['build'], ['test']]);
  expect(plan.steps.map((s) => s.step_id)).toEqual(['build', 'test']);
  expect(plan.steps.map((s) => s.model)).toEqual(['sonnet', 'sonnet']);
  expect(plan.steps.map((s) => s.type)).toEqual(['agent', 'agent']);
  expect(plan.steps.map((s) => s.script_spec)).toEqual([null, null]);
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test('happy path: script variant — frontmatter + ## Params/## Output parse into script_spec, zero lints', () => {
  const root = scaffold('---\n---\n', {
    '01-create-pr.md': (r) =>
      scriptStepDoc({
        fm: { type: 'script', script: 'scripts/create-pr.py', timeout: '120', step_id: 'create-pr' },
        output: { pr_number: { type: 'number' } },
        next: join(r, 'steps', '02-wait-ci.md'),
      }),
    '02-wait-ci.md': scriptStepDoc({
      fm: {
        type: 'script',
        script: 'scripts/wait-ci.py',
        timeout: '300',
        retries: '2',
        'on-failure': 'agent',
        step_id: 'wait-ci',
      },
      params: {
        pr_number: { type: 'number', required: true, from: '${steps.create-pr.output.pr_number}' },
        fail_fast: { type: 'boolean', default: true },
        labels: { type: 'array', value: ['release', 'auto'] },
      },
    }),
  });
  const plan = computePlan(root);
  expect(plan.errors).toEqual([]);
  expect(plan.warnings).toEqual([]);
  const [s1, s2] = plan.steps;
  expect(s1.type).toBe('script');
  expect(s1.script_spec).toEqual({
    script: 'scripts/create-pr.py',
    command: null,
    timeoutS: 120,
    retries: 0,
    onFailure: 'halt',
    params: null,
    output: { pr_number: { type: 'number' } },
  });
  expect(s2.type).toBe('script');
  expect(s2.script_spec).toEqual({
    script: 'scripts/wait-ci.py',
    command: null,
    timeoutS: 300,
    retries: 2,
    onFailure: 'agent',
    params: {
      pr_number: { type: 'number', required: true, from: '${steps.create-pr.output.pr_number}' },
      fail_fast: { type: 'boolean', default: true },
      labels: { type: 'array', value: ['release', 'auto'] },
    },
    output: null,
  });
  expect(s2.model).toBeNull();
  expect(s2.effort).toBeNull();
});

test('happy path: command variant — whitespace-split string and inline list both become argv', () => {
  const str = computePlan(
    scaffold('---\n---\n', {
      '01-a.md': scriptStepDoc({
        fm: { type: 'script', command: 'gh run list --limit 5', timeout: '60', step_id: 'a' },
      }),
    }),
  );
  expect(str.errors).toEqual([]);
  expect(str.warnings).toEqual([]);
  expect(str.steps[0].script_spec?.command).toEqual(['gh', 'run', 'list', '--limit', '5']);
  expect(str.steps[0].script_spec?.script).toBeNull();

  const list = computePlan(
    scaffold('---\n---\n', {
      '01-a.md': scriptStepDoc({
        fm: { type: 'script', command: '[gh, run, list]', timeout: '60', step_id: 'a' },
      }),
    }),
  );
  expect(list.errors).toEqual([]);
  expect(list.steps[0].script_spec?.command).toEqual(['gh', 'run', 'list']);
});

// ---------------------------------------------------------------------------
// Frontmatter rules (§2.1)
// ---------------------------------------------------------------------------

test('type: script with neither or both of script:/command: is a plan ERROR', () => {
  const neither = computePlan(
    scaffold('---\n---\n', {
      '01-a.md': scriptStepDoc({ fm: { type: 'script', timeout: '60', step_id: 'a' } }),
    }),
  );
  expect(neither.errors.some((e) => e.includes("exactly one of 'script:' or 'command:'"))).toBe(true);

  const both = computePlan(
    scaffold('---\n---\n', {
      '01-a.md': scriptStepDoc({
        fm: { type: 'script', script: 'scripts/a.py', command: 'gh run list', timeout: '60', step_id: 'a' },
      }),
    }),
  );
  expect(both.errors.some((e) => e.includes('mutually exclusive'))).toBe(true);
});

test("unknown type: warns and defaults to agent; explicit 'agent' is silent", () => {
  const plan = computePlan(
    scaffold(null, {
      '01-a.md': '---\ntype: robot\n---\n# A\n',
      '02-b.md': '---\ntype: agent\n---\n# B\n',
    }),
  );
  expect(plan.steps[0].type).toBe('agent');
  expect(plan.steps[0].script_spec).toBeNull();
  expect(plan.steps[1].type).toBe('agent');
  expect(plan.warnings).toEqual(["steps/01-a.md: unknown type 'robot' — treating as agent"]);
});

test('model/effort/permission-mode on a script step warn and resolve to null (no inheritance)', () => {
  const plan = computePlan(
    scaffold('---\nmodel: sonnet\neffort: high\n---\n', {
      '01-a.md': '---\nstep_id: a\n---\n# A\n',
      '02-b.md': scriptStepDoc({
        fm: {
          type: 'script',
          script: 'scripts/b.py',
          timeout: '60',
          step_id: 'b',
          model: 'opus',
          effort: 'max',
          'permission-mode': 'acceptEdits',
        },
      }),
    }),
  );
  expect(plan.errors).toEqual([]);
  expect(plan.steps[0].model).toBe('sonnet');
  expect(plan.steps[0].effort).toBe('high');
  expect(plan.steps[1].model).toBeNull();
  expect(plan.steps[1].effort).toBeNull();
  expect(plan.warnings).toEqual([
    'steps/02-b.md: model, effort, permission-mode ignored on a type: script step (a script spawns no agent)',
  ]);
});

test('script-only frontmatter on an agent step warns and is ignored; its ## Params block is not parsed', () => {
  const content =
    '---\nscript: scripts/a.py\ntimeout: 60\nretries: 3\non-failure: agent\n---\n# A\n\n## Params\n\n' +
    jsonBlock({ p: { type: 'wtf', value: 1, from: '${steps.ghost.output.x}' } }) +
    '\n';
  const plan = computePlan(scaffold(null, { '01-a.md': content }));
  expect(plan.steps[0].type).toBe('agent');
  expect(plan.steps[0].script_spec).toBeNull();
  // The malformed Params vocabulary is script-step machinery — not parsed here.
  expect(plan.errors).toEqual([]);
  expect(plan.warnings).toEqual([
    "steps/01-a.md: script-step field(s) script, timeout, retries, on-failure ignored on an agent step (add 'type: script' to use them)",
  ]);
});

test('invalid timeout/retries/on-failure warn and fall back to defaults (600s / 0 / halt)', () => {
  const plan = computePlan(
    scaffold('---\nrunner: headless\n---\n', {
      '01-a.md': scriptStepDoc({
        fm: {
          type: 'script',
          script: 'scripts/a.py',
          timeout: 'soon',
          retries: '-1',
          'on-failure': 'retry',
          step_id: 'a',
        },
      }),
    }),
  );
  const spec = plan.steps[0].script_spec!;
  expect(spec.timeoutS).toBe(DEFAULT_SCRIPT_TIMEOUT_S);
  expect(spec.retries).toBe(0);
  expect(spec.onFailure).toBe('halt');
  expect(plan.warnings.some((w) => w.includes("invalid timeout 'soon'"))).toBe(true);
  expect(plan.warnings.some((w) => w.includes("invalid retries '-1'"))).toBe(true);
  expect(plan.warnings.some((w) => w.includes("unknown on-failure 'retry'"))).toBe(true);
  expect(plan.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// §7 — manager call-budget lint
// ---------------------------------------------------------------------------

test('manager-safe timeout lint: >420s (explicit OR the 600s default) warns on runner: manager only', () => {
  const explicit = computePlan(
    scaffold(null, {
      '01-a.md': scriptStepDoc({
        fm: { type: 'script', script: 'scripts/a.py', timeout: '500', step_id: 'a' },
      }),
    }),
  );
  expect(explicit.warnings).toEqual([
    `steps/01-a.md: script timeout 500s exceeds the manager-safe ${MANAGER_SAFE_TIMEOUT_S}s — use runner: headless or split the step`,
  ]);

  // No timeout: frontmatter ⇒ the 600s default, which ALSO cannot be honored
  // inside a manager's 10-minute Bash window (§7 deadline inversion).
  const defaulted = computePlan(
    scaffold(null, {
      '01-a.md': scriptStepDoc({ fm: { type: 'script', script: 'scripts/a.py', step_id: 'a' } }),
    }),
  );
  expect(defaulted.warnings.some((w) => w.includes(`manager-safe ${MANAGER_SAFE_TIMEOUT_S}s`))).toBe(true);

  const headless = computePlan(
    scaffold('---\nrunner: headless\n---\n', {
      '01-a.md': scriptStepDoc({
        fm: { type: 'script', script: 'scripts/a.py', timeout: '500', step_id: 'a' },
      }),
    }),
  );
  expect(headless.warnings).toEqual([]);

  const atCap = computePlan(
    scaffold(null, {
      '01-a.md': scriptStepDoc({
        fm: { type: 'script', script: 'scripts/a.py', timeout: String(MANAGER_SAFE_TIMEOUT_S), step_id: 'a' },
      }),
    }),
  );
  expect(atCap.warnings).toEqual([]);
});

// ---------------------------------------------------------------------------
// §3.1 / §3.3 — Params/Output vocabulary lints
// ---------------------------------------------------------------------------

test('## Params/## Output block lints: malformed JSON, missing fence, non-object, unknown type, value+from', () => {
  const doc = (body: string) =>
    '---\ntype: script\nscript: scripts/a.py\ntimeout: 60\nstep_id: a\n---\n# A\n\n' +
    body +
    '\n## Next\nPipeline complete.\n';

  const malformed = computePlan(
    scaffold(null, { '01-a.md': doc('## Params\n\n```json\n{ nope\n```\n') }),
  );
  expect(malformed.errors.some((e) => e.includes('## Params JSON is invalid'))).toBe(true);

  const noFence = computePlan(scaffold(null, { '01-a.md': doc('## Params\n\njust prose\n') }));
  expect(noFence.errors.some((e) => e.includes('has no ```json code block'))).toBe(true);

  const nonObject = computePlan(
    scaffold(null, { '01-a.md': doc('## Params\n\n' + jsonBlock([1, 2]) + '\n') }),
  );
  expect(nonObject.errors.some((e) => e.includes('must be a JSON object'))).toBe(true);

  const unknownType = computePlan(
    scaffold(null, { '01-a.md': doc('## Params\n\n' + jsonBlock({ p: { type: 'uuid' } }) + '\n') }),
  );
  expect(unknownType.errors.some((e) => e.includes("'p' has unknown type 'uuid'"))).toBe(true);

  const valueAndFrom = computePlan(
    scaffold(null, {
      '01-a.md': doc(
        '## Params\n\n' +
          jsonBlock({ p: { type: 'string', value: 'x', from: '${env.CI_BASE_URL}' } }) +
          '\n',
      ),
    }),
  );
  expect(valueAndFrom.errors.some((e) => e.includes("sets both 'value' and 'from'"))).toBe(true);

  // ## Output shares the vocabulary and its checks (§3.4 "same vocabulary").
  const badOutput = computePlan(
    scaffold(null, { '01-a.md': doc('## Output\n\n' + jsonBlock({ o: { type: 'uuid' } }) + '\n') }),
  );
  expect(badOutput.errors.some((e) => e.includes("## Output 'o' has unknown type 'uuid'"))).toBe(true);
});

// ---------------------------------------------------------------------------
// §2.2 — ## Next mechanical rule (sequential mode only)
// ---------------------------------------------------------------------------

const NEXT_ERR = '## Next of a sequential script step';

function nextStep(next: string | null): string {
  return scriptStepDoc({
    fm: { type: 'script', script: 'scripts/a.py', timeout: '60', step_id: 'a' },
    next,
  });
}

test('## Next lint: Pipeline complete., a single absolute path, and a bulleted absolute path all pass', () => {
  const complete = computePlan(scaffold(null, { '01-a.md': nextStep('Pipeline complete.') }));
  expect(complete.errors).toEqual([]);

  const abs = computePlan(
    scaffold(null, {
      '01-a.md': (r) => nextStep(join(r, 'steps', '02-b.md')),
      '02-b.md': '# B\n',
    }),
  );
  expect(abs.errors).toEqual([]);

  const bullet = computePlan(
    scaffold(null, {
      '01-a.md': (r) => nextStep('- ' + join(r, 'steps', '02-b.md')),
      '02-b.md': '# B\n',
    }),
  );
  expect(bullet.errors).toEqual([]);
});

test('## Next lint: a backticked absolute path (plain or bulleted) is lint-clean — shared normalizeNextLine grammar with the runtime', () => {
  // The runtime parser (parseNextSection) has always unwrapped one backtick
  // pair; the lint now normalizes with the SAME helper, so a backticked path
  // is no longer a false plan ERROR.
  const ticked = computePlan(
    scaffold(null, {
      '01-a.md': (r) => nextStep('`' + join(r, 'steps', '02-b.md') + '`'),
      '02-b.md': '# B\n',
    }),
  );
  expect(ticked.errors).toEqual([]);

  const bulletTicked = computePlan(
    scaffold(null, {
      '01-a.md': (r) => nextStep('- `' + join(r, 'steps', '02-b.md') + '`'),
      '02-b.md': '# B\n',
    }),
  );
  expect(bulletTicked.errors).toEqual([]);
});

test('## Next lint: missing section, prose, multiple paths, and relative paths are plan ERRORs', () => {
  const missing = computePlan(scaffold(null, { '01-a.md': nextStep(null) }));
  expect(missing.errors.some((e) => e.includes(NEXT_ERR))).toBe(true);

  const prose = computePlan(
    scaffold(null, { '01-a.md': nextStep('If CI is green, continue to the release step.') }),
  );
  expect(prose.errors.some((e) => e.includes(NEXT_ERR))).toBe(true);

  const multiple = computePlan(
    scaffold(null, {
      '01-a.md': (r) => nextStep(join(r, 'steps', '02-b.md') + '\n' + join(r, 'steps', '03-c.md')),
      '02-b.md': '# B\n',
      '03-c.md': '# C\n',
    }),
  );
  expect(multiple.errors.some((e) => e.includes(NEXT_ERR))).toBe(true);

  const relative = computePlan(scaffold(null, { '01-a.md': nextStep('steps/02-b.md') }));
  expect(relative.errors.some((e) => e.includes(NEXT_ERR))).toBe(true);
});

test('## Next lint is skipped in graph mode and in DAG mode (agent-step ## Next stays unlinted everywhere)', () => {
  // Graph mode: routing comes from flags + ## Graph — no ## Next required.
  const manifest =
    '---\n---\n# P\n\n## Graph\n\n' +
    jsonBlock({ a: [{ when: 'again', goto: 'a', max: 2 }, { done: true }] }) +
    '\n';
  const graphMode = computePlan(
    scaffold(manifest, {
      '01-a.md': scriptStepDoc({
        fm: { type: 'script', script: 'scripts/a.py', timeout: '60', step_id: 'a' },
        next: null,
      }),
    }),
  );
  expect(graphMode.graph).not.toBeNull();
  expect(graphMode.errors).toEqual([]);

  // DAG mode: layers advance in the engine — next_iteration unused.
  const dag = computePlan(
    scaffold('---\nexecution: parallel\n---\n', {
      '01-a.md': scriptStepDoc({
        fm: { type: 'script', script: 'scripts/a.py', timeout: '60', step_id: 'a' },
        next: null,
      }),
    }),
  );
  expect(dag.errors).toEqual([]);

  // Agent steps never get the ## Next lint (their executor reads it with judgment).
  const agent = computePlan(scaffold(null, { '01-a.md': '# A\n\n## Next\nsome prose here\n' }));
  expect(agent.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// §3.3 — topological-ancestor binding lint
// ---------------------------------------------------------------------------

test('sequential mode: ${steps.x…} must reference an EARLIER enumerated step', () => {
  const plan = computePlan(
    scaffold(null, {
      '01-a.md': (r) =>
        scriptStepDoc({
          fm: { type: 'script', script: 'scripts/a.py', timeout: '60', step_id: 'a' },
          params: { x: { type: 'string', from: '${steps.b.output.sha}' } }, // forward ref
          next: join(r, 'steps', '02-b.md'),
        }),
      '02-b.md': scriptStepDoc({
        fm: { type: 'script', script: 'scripts/b.py', timeout: '60', step_id: 'b' },
        params: { y: { type: 'string', from: '${steps.a.output.sha}' } }, // backward ref: fine
      }),
    }),
  );
  expect(plan.errors.length).toBe(1);
  expect(plan.errors[0]).toContain("does not reference a topological ancestor of 'a'");
});

test('DAG mode: ${steps.x…} must be a transitive depends-on ancestor (effective-deps rule)', () => {
  const mk = (id: string, deps: string | null, from?: string) =>
    scriptStepDoc({
      fm: {
        type: 'script',
        script: `scripts/${id}.py`,
        timeout: '60',
        step_id: id,
        ...(deps ? { 'depends-on': deps } : {}),
      },
      ...(from ? { params: { x: { type: 'string', from } } } : {}),
      next: null,
    });

  const transitive = computePlan(
    scaffold('---\nexecution: parallel\n---\n', {
      '01-a.md': mk('a', null),
      '02-b.md': mk('b', '[a]'),
      '03-c.md': mk('c', '[b]', '${steps.a.output.sha}'), // a is a transitive ancestor of c
    }),
  );
  expect(transitive.errors).toEqual([]);

  const descendant = computePlan(
    scaffold('---\nexecution: parallel\n---\n', {
      '01-a.md': mk('a', null, '${steps.c.output.sha}'), // c is a DESCENDANT of a
      '02-b.md': mk('b', '[a]'),
      '03-c.md': mk('c', '[b]'),
    }),
  );
  expect(descendant.errors.length).toBe(1);
  expect(descendant.errors[0]).toContain("does not reference a topological ancestor of 'a'");

  // A step with no depends-on effectively depends on the previous step.
  const implicit = computePlan(
    scaffold('---\nexecution: parallel\n---\n', {
      '01-a.md': mk('a', null),
      '02-b.md': mk('b', null, '${steps.a.output.sha}'),
    }),
  );
  expect(implicit.errors).toEqual([]);
});

test('graph mode skips the static ancestor check (order is dynamic)', () => {
  const manifest =
    '---\n---\n# P\n\n## Graph\n\n' + jsonBlock({ a: { done: true } }) + '\n';
  const plan = computePlan(
    scaffold(manifest, {
      '01-a.md': scriptStepDoc({
        fm: { type: 'script', script: 'scripts/a.py', timeout: '60', step_id: 'a' },
        params: { x: { type: 'string', from: '${steps.ghost.output.x}' } },
        next: null,
      }),
    }),
  );
  expect(plan.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// §3.4 — declared-Output field check
// ---------------------------------------------------------------------------

test('## Output field-check: undeclared field errors; nested paths check the first segment; producers without the block are runtime-only', () => {
  const producer = (output?: unknown) => (r: string) =>
    scriptStepDoc({
      fm: { type: 'script', script: 'scripts/p.py', timeout: '60', step_id: 'p' },
      ...(output !== undefined ? { output } : {}),
      next: join(r, 'steps', '02-c.md'),
    });
  const consumer = (from: string) =>
    scriptStepDoc({
      fm: { type: 'script', script: 'scripts/c.py', timeout: '60', step_id: 'c' },
      params: { x: { type: 'string', from } },
    });

  const declaredOk = computePlan(
    scaffold(null, {
      '01-p.md': producer({ sha: { type: 'string' } }),
      '02-c.md': consumer('${steps.p.output.sha}'),
    }),
  );
  expect(declaredOk.errors).toEqual([]);

  const nested = computePlan(
    scaffold(null, {
      '01-p.md': producer({ sha: { type: 'object' } }),
      '02-c.md': consumer('${steps.p.output.sha.short}'),
    }),
  );
  expect(nested.errors).toEqual([]);

  const undeclared = computePlan(
    scaffold(null, {
      '01-p.md': producer({ sha: { type: 'string' } }),
      '02-c.md': consumer('${steps.p.output.bogus}'),
    }),
  );
  expect(undeclared.errors).toEqual([
    "steps/02-c.md ## Params 'x': step 'p' declares ## Output without field 'bogus'",
  ]);

  const noBlock = computePlan(
    scaffold(null, {
      '01-p.md': producer(),
      '02-c.md': consumer('${steps.p.output.bogus}'),
    }),
  );
  expect(noBlock.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// §3.3 / §11 — secret-looking env bindings
// ---------------------------------------------------------------------------

test('secret-looking ${env.NAME} bindings warn; benign names stay silent', () => {
  const step = (from: string) =>
    scriptStepDoc({
      fm: { type: 'script', script: 'scripts/a.py', timeout: '60', step_id: 'a' },
      params: { x: { type: 'string', from } },
    });

  const secret = computePlan(scaffold(null, { '01-a.md': step('Bearer ${env.GH_TOKEN}') }));
  expect(secret.errors).toEqual([]);
  expect(secret.warnings.length).toBe(1);
  expect(secret.warnings[0]).toContain('${env.GH_TOKEN} looks like a secret');

  const benign = computePlan(scaffold(null, { '01-a.md': step('${env.CI_BASE_URL}/run') }));
  expect(benign.warnings).toEqual([]);
});

// ---------------------------------------------------------------------------
// Interaction with existing lints
// ---------------------------------------------------------------------------

test('the script-extraction procedural lint does not fire on type: script steps', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `${i + 1}. run step number ${i + 1}`);
  const doc =
    '---\ntype: script\nscript: scripts/a.py\ntimeout: 60\nstep_id: a\n---\n# A\n\n## Steps\n' +
    lines.join('\n') +
    '\n\n## Next\nPipeline complete.\n';
  const plan = computePlan(scaffold(null, { '01-a.md': doc }));
  expect(plan.warnings).toEqual([]);
  expect(plan.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// §3.4 — declared-Output field check uses own-property semantics (not `in`)
// ---------------------------------------------------------------------------

test('## Output field-check uses own-property semantics: an inherited name (toString) is NOT a declared field', () => {
  // `toString` lives on Object.prototype, so `outputField in declared` would
  // pass the lint though the producer never declared it. Object.hasOwn catches it.
  const producer = (r: string) =>
    scriptStepDoc({
      fm: { type: 'script', script: 'scripts/p.py', timeout: '60', step_id: 'p' },
      output: { sha: { type: 'string' } },
      next: join(r, 'steps', '02-c.md'),
    });
  const consumer = scriptStepDoc({
    fm: { type: 'script', script: 'scripts/c.py', timeout: '60', step_id: 'c' },
    params: { x: { type: 'string', from: '${steps.p.output.toString}' } },
  });
  const plan = computePlan(scaffold(null, { '01-p.md': producer, '02-c.md': consumer }));
  expect(plan.errors).toEqual([
    "steps/02-c.md ## Params 'x': step 'p' declares ## Output without field 'toString'",
  ]);
});

// ---------------------------------------------------------------------------
// §3.2 — malformed ${steps…} binding shapes ERROR at plan time
// ---------------------------------------------------------------------------

test('malformed ${steps…} shape (whole-output ref, bare step ref) is a plan ERROR mirroring resolveRef', () => {
  const producer = (r: string) =>
    scriptStepDoc({
      fm: { type: 'script', script: 'scripts/p.py', timeout: '60', step_id: 'p' },
      output: { sha: { type: 'string' } },
      next: join(r, 'steps', '02-c.md'),
    });
  const consumer = (from: string) =>
    scriptStepDoc({
      fm: { type: 'script', script: 'scripts/c.py', timeout: '60', step_id: 'c' },
      params: { x: { type: 'string', from } },
    });

  // `${steps.p.output}` — no trailing `.field`.
  const wholeOutput = computePlan(
    scaffold(null, { '01-p.md': producer, '02-c.md': consumer('${steps.p.output}') }),
  );
  expect(wholeOutput.errors).toEqual([
    'steps/02-c.md ## Params \'x\': malformed reference ${steps.p.output} — expected ${steps.<step_id>.output.<path>}',
  ]);

  // Bare `${steps.nope}` — pointing at a NON-ancestor: the malformed error is
  // pushed and the ancestor/field checks are skipped (exactly ONE error).
  const bareStep = computePlan(
    scaffold(null, { '01-p.md': producer, '02-c.md': consumer('${steps.nope}') }),
  );
  expect(bareStep.errors).toEqual([
    'steps/02-c.md ## Params \'x\': malformed reference ${steps.nope} — expected ${steps.<step_id>.output.<path>}',
  ]);

  // Positive: a well-formed `${steps.p.output.sha}` triggers NO malformed lint.
  const valid = computePlan(
    scaffold(null, { '01-p.md': producer, '02-c.md': consumer('${steps.p.output.sha}') }),
  );
  expect(valid.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// §2.1 — per-run --model/--effort override on a type: script step
// ---------------------------------------------------------------------------

test('a --model/--effort override targeting a type: script step warns (never silently swallowed)', () => {
  const root = scaffold(null, {
    '01-a.md': scriptStepDoc({
      fm: { type: 'script', script: 'scripts/a.py', timeout: '60', step_id: 'a' },
    }),
  });
  const expected = [
    "steps/01-a.md: --model/--effort override ignored on a 'type: script' step (a script spawns no agent)",
  ];

  const modelOverride = computePlan(root, { modelOverrides: { a: 'opus' } });
  expect(modelOverride.errors).toEqual([]);
  expect(modelOverride.warnings).toEqual(expected);
  expect(modelOverride.steps[0].model).toBeNull(); // override routed nowhere

  const effortOverride = computePlan(root, { effortOverrides: { a: 'high' } });
  expect(effortOverride.errors).toEqual([]);
  expect(effortOverride.warnings).toEqual(expected);
  expect(effortOverride.steps[0].effort).toBeNull();
});

// ---------------------------------------------------------------------------
// §3.1 — non-array `enum` in the Params/Output vocabulary
// ---------------------------------------------------------------------------

test('non-array enum in ## Params / ## Output is a plan ERROR (a string enum crashes the runtime)', () => {
  const doc = (body: string) =>
    '---\ntype: script\nscript: scripts/a.py\ntimeout: 60\nstep_id: a\n---\n# A\n\n' +
    body +
    '\n## Next\nPipeline complete.\n';

  const params = computePlan(
    scaffold(null, {
      '01-a.md': doc(
        '## Params\n\n' + jsonBlock({ env: { type: 'string', enum: 'prod|staging' } }) + '\n',
      ),
    }),
  );
  expect(params.errors.some((e) => e.includes("## Params 'env' has a non-array 'enum'"))).toBe(true);

  const output = computePlan(
    scaffold(null, {
      '01-a.md': doc('## Output\n\n' + jsonBlock({ mode: { type: 'string', enum: 'a|b' } }) + '\n'),
    }),
  );
  expect(output.errors.some((e) => e.includes("## Output 'mode' has a non-array 'enum'"))).toBe(true);

  // A proper JSON-array enum is accepted (no error).
  const ok = computePlan(
    scaffold(null, {
      '01-a.md': doc(
        '## Params\n\n' + jsonBlock({ env: { type: 'string', enum: ['prod', 'staging'] } }) + '\n',
      ),
    }),
  );
  expect(ok.errors).toEqual([]);
});
