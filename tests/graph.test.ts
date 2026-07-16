import { test, expect, afterEach } from 'bun:test';
import {
  extractGraph,
  validateGraph,
  routeNext,
  emptyRouteState,
  nodeEdges,
  type Graph,
} from '../src/lib/graph';
import { computePlan } from '../src/lib/plan';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const BOUNDED_RETRY: Graph = {
  implement: { goto: 'review' },
  review: [
    { when: 'changes_needed', goto: 'implement', max: 3 },
    { goto: 'package' },
  ],
};

// ---------------------------------------------------------------------------
// extractGraph
// ---------------------------------------------------------------------------

test('extractGraph: no ## Graph section → null, no error', () => {
  const r = extractGraph('# Title\n\n## Scope\n- In: x\n');
  expect(r.graph).toBeNull();
  expect(r.error).toBeNull();
});

test('extractGraph: parses a fenced json block under ## Graph', () => {
  const body = '## Graph\n\n```json\n{"a":{"goto":"b"}}\n```\n';
  const r = extractGraph(body);
  expect(r.error).toBeNull();
  expect(r.graph).toEqual({ a: { goto: 'b' } });
});

test('extractGraph: malformed JSON → error', () => {
  const r = extractGraph('## Graph\n```json\n{ not json }\n```\n');
  expect(r.graph).toBeNull();
  expect(r.error).toContain('invalid');
});

test('extractGraph: section without a json fence → error', () => {
  const r = extractGraph('## Graph\n\nsome prose, no fence\n');
  expect(r.error).toContain('no ```json');
});

// ---------------------------------------------------------------------------
// validateGraph
// ---------------------------------------------------------------------------

test('validateGraph: clean graph → no errors', () => {
  expect(validateGraph(BOUNDED_RETRY, new Set(['implement', 'review', 'package']))).toEqual([]);
});

test('validateGraph: dangling goto + unknown node + bad max + goto-and-done', () => {
  const bad: Graph = {
    review: [
      { when: 'x', goto: 'ghost' }, // dangling
      { goto: 'package', done: true } as never, // both goto and done
      { goto: 'package', max: 0 }, // bad max
    ],
    orphan: { goto: 'review' }, // orphan not a step
  };
  const errs = validateGraph(bad, new Set(['review', 'package']));
  expect(errs.some((e) => e.includes("unknown step 'ghost'"))).toBe(true);
  expect(errs.some((e) => e.includes("'orphan' is not a known step_id"))).toBe(true);
  expect(errs.some((e) => e.includes('invalid max'))).toBe(true);
  expect(errs.some((e) => e.includes("exactly one of 'goto' or 'done'"))).toBe(true);
});

// ---------------------------------------------------------------------------
// nodeEdges
// ---------------------------------------------------------------------------

test('nodeEdges: shorthand forms normalize to edge lists', () => {
  expect(nodeEdges({ goto: 'x' })).toEqual([{ goto: 'x' }]);
  expect(nodeEdges({ done: true })).toEqual([{ done: true }]);
  expect(nodeEdges([{ when: 'a', goto: 'b' }])).toEqual([{ when: 'a', goto: 'b' }]);
});

// ---------------------------------------------------------------------------
// routeNext
// ---------------------------------------------------------------------------

test('routeNext: unconditional goto', () => {
  const s = emptyRouteState();
  expect(routeNext(BOUNDED_RETRY, 'implement', {}, s)).toEqual({ action: 'run', target: 'review' });
  expect(s.transitions).toBe(1);
});

test('routeNext: a step absent from the graph is terminal', () => {
  expect(routeNext(BOUNDED_RETRY, 'package', {}, emptyRouteState())).toEqual({ action: 'done' });
});

test('routeNext: default edge taken when the when-flag is false', () => {
  const s = emptyRouteState();
  expect(routeNext(BOUNDED_RETRY, 'review', { changes_needed: false }, s)).toEqual({
    action: 'run',
    target: 'package',
  });
});

test('routeNext: bounded retry — loops back exactly `max` times then falls through', () => {
  // The user's exact case: review loops to implement up to 3 times, then skips to package.
  const s = emptyRouteState();
  const loop = () => routeNext(BOUNDED_RETRY, 'review', { changes_needed: true }, s);
  expect(loop()).toEqual({ action: 'run', target: 'implement' }); // 1
  expect(loop()).toEqual({ action: 'run', target: 'implement' }); // 2
  expect(loop()).toEqual({ action: 'run', target: 'implement' }); // 3
  // 4th time the changes are STILL needed, but the budget is spent → fall through to package.
  expect(loop()).toEqual({ action: 'run', target: 'package' });
  expect(s.counters['review#0']).toBe(3);
});

test('routeNext: done edge terminates', () => {
  const g: Graph = { last: [{ done: true }] };
  expect(routeNext(g, 'last', {}, emptyRouteState())).toEqual({ action: 'done' });
});

test('routeNext: no matching edge (no default) → halt', () => {
  const g: Graph = { x: [{ when: 'never', goto: 'y' }] };
  const r = routeNext(g, 'x', { never: false }, emptyRouteState());
  expect(r.action).toBe('halt');
});

test('routeNext: transition cap backstops an unbounded loop', () => {
  const g: Graph = { a: [{ goto: 'a' }] }; // self-loop with no max
  const s = emptyRouteState();
  let last = routeNext(g, 'a', {}, s);
  for (let i = 0; i < 2000 && last.action === 'run'; i++) last = routeNext(g, 'a', {}, s);
  expect(last.action).toBe('halt');
  expect((last as { reason: string }).reason).toContain('cap');
});

// ---------------------------------------------------------------------------
// computePlan integration
// ---------------------------------------------------------------------------

function scaffoldGraphPipeline(graphJson: string): string {
  const root = mkdtempSync(join(tmpdir(), 'graph-'));
  created.push(root);
  writeFileSync(
    join(root, 'PIPELINE.md'),
    `# P\n\n## End State\nx\n\n## Graph\n\n\`\`\`json\n${graphJson}\n\`\`\`\n`,
  );
  const stepsDir = join(root, 'steps');
  mkdirSync(stepsDir, { recursive: true });
  for (const [n, id] of [['01-implement', 'implement'], ['02-review', 'review'], ['03-package', 'package']]) {
    writeFileSync(join(stepsDir, `${n}.md`), `---\nstep_id: ${id}\n---\n# ${id}\n`);
  }
  return root;
}

test('computePlan: surfaces a valid graph, no errors', () => {
  const plan = computePlan(scaffoldGraphPipeline(JSON.stringify(BOUNDED_RETRY)));
  expect(plan.graph).toEqual(BOUNDED_RETRY);
  expect(plan.errors).toEqual([]);
});

test('computePlan: a graph with a dangling goto is a hard error', () => {
  const plan = computePlan(scaffoldGraphPipeline('{"review":[{"when":"x","goto":"ghost"},{"goto":"package"}]}'));
  expect(plan.errors.some((e) => e.includes('ghost'))).toBe(true);
});

test('computePlan: no graph section → plan.graph is null', () => {
  const root = mkdtempSync(join(tmpdir(), 'nograph-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n## End State\nx\n');
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'steps', '01-a.md'), '# a\n');
  expect(computePlan(root).graph).toBeNull();
});

// ---------------------------------------------------------------------------
// `pipeline route` CLI — state persists across calls (the real loop)
// ---------------------------------------------------------------------------

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

function route(root: string, runId: string, from: string, flags: object) {
  const r = spawnSync(
    'bun',
    [CLI, 'route', '--root', root, '--run-id', runId, '--from', from, '--flags', JSON.stringify(flags)],
    { encoding: 'utf8' },
  );
  return { json: JSON.parse(r.stdout), status: r.status };
}

test('pipeline route CLI: drives the bounded-retry loop with on-disk state', () => {
  const root = scaffoldGraphPipeline(JSON.stringify(BOUNDED_RETRY));
  const run = 'run01';
  // review with changes 3× → implement each time; 4th → package.
  expect(route(root, run, 'review', { changes_needed: true }).json.step_id).toBe('implement');
  expect(route(root, run, 'review', { changes_needed: true }).json.step_id).toBe('implement');
  expect(route(root, run, 'review', { changes_needed: true }).json.step_id).toBe('implement');
  const fourth = route(root, run, 'review', { changes_needed: true });
  expect(fourth.json.step_id).toBe('package');
  expect(fourth.json.action).toBe('run');
  // state + gitignore landed under the pipeline's .runtime
  expect(existsSync(join(root, '.runtime', '.gitignore'))).toBe(true);
  const state = JSON.parse(readFileSync(join(root, '.runtime', run, 'route.json'), 'utf8'));
  expect(state.counters['review#0']).toBe(3);
});

test('pipeline route CLI: package (terminal) → done', () => {
  const root = scaffoldGraphPipeline(JSON.stringify(BOUNDED_RETRY));
  const r = route(root, 'run02', 'package', {});
  expect(r.json.action).toBe('done');
  expect(r.status).toBe(0);
});
