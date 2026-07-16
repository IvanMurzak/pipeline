// T3-09 — unit tests for the composition seam (lib/compose.ts): `pipeline:`
// reference resolution and the cross-pipeline reference-graph lint (cycles,
// depth cap), driven ENTIRELY over an in-memory ComposeFs — no real tree.
// computePlan integration (real temp sandboxes, the established plan-test
// pattern) lives in tests/plan-pipeline-steps.test.ts.

import { test, expect } from 'bun:test';
import {
  lintComposition,
  resolvePipelineRef,
  MAX_COMPOSITION_DEPTH,
  type ComposeFs,
  type CompositionEdge,
} from '../src/lib/compose';
import { resolve, join, sep } from 'node:path';

/** In-memory ComposeFs over a path → contents map (keys normalized with
 *  resolve so fixtures are platform-agnostic). */
function memFs(files: Record<string, string>): ComposeFs {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(files)) map.set(resolve(k), v);
  return {
    exists: (p) => map.has(resolve(p)),
    readFile: (p) => {
      const v = map.get(resolve(p));
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    listMarkdownFiles: (dir) => {
      const prefix = resolve(dir) + sep;
      return [...map.keys()]
        .filter((k) => k.startsWith(prefix) && k.endsWith('.md'))
        .sort();
    },
  };
}

const P = resolve('/proj/.claude/pipeline');
const pipe = (name: string) => join(P, ...name.split('/'));
const manifest = (name: string) => join(pipe(name), 'PIPELINE.md');
const stepRef = (child: string) => `---\ntype: pipeline\npipeline: ${child}\n---\n# Step\n`;

/** Fixture builder: each entry is either a leaf pipeline (null) or the name of
 *  the pipeline its single `type: pipeline` step references. */
function world(pipelines: Record<string, string | null>): ComposeFs {
  const files: Record<string, string> = {};
  for (const [name, ref] of Object.entries(pipelines)) {
    files[manifest(name)] = '---\n---\n';
    files[join(pipe(name), 'steps', '01-a.md')] = ref === null ? '# A\n' : stepRef(ref);
  }
  return memFs(files);
}

const edge = (root: string): CompositionEdge => ({ rel: '01-a.md', root });

// ---------------------------------------------------------------------------
// resolvePipelineRef — candidate bases and ordering
// ---------------------------------------------------------------------------

test('resolution prefers a child under the referencing root over a same-named sibling', () => {
  const fs = memFs({
    [join(pipe('main'), 'x', 'PIPELINE.md')]: '---\n---\n',
    [manifest('x')]: '---\n---\n',
  });
  const r = resolvePipelineRef('x', pipe('main'), fs);
  expect(r.root).toBe(join(pipe('main'), 'x'));
  expect(r.tried).toEqual([join(pipe('main'), 'x')]);
});

test('a plain name falls through to the sibling base (the common flat layout)', () => {
  const fs = memFs({ [manifest('y')]: '---\n---\n' });
  const r = resolvePipelineRef('y', pipe('main'), fs);
  expect(r.root).toBe(pipe('y'));
  expect(r.tried).toEqual([join(pipe('main'), 'y'), pipe('y')]);
});

test('a nested pipeline resolves top-level names via the enclosing .claude/pipeline dir', () => {
  const fs = memFs({ [manifest('top')]: '---\n---\n' });
  const r = resolvePipelineRef('top', pipe('fam/targets/t'), fs);
  expect(r.root).toBe(pipe('top'));
});

test('an unresolvable reference reports every distinct candidate probed', () => {
  const fs = memFs({});
  const r = resolvePipelineRef('z', pipe('main'), fs);
  expect(r.root).toBeNull();
  // Candidate 2 (sibling) and candidate 3 (.claude/pipeline) coincide here —
  // deduped, so exactly two probes.
  expect(r.tried).toEqual([join(pipe('main'), 'z'), pipe('z')]);
});

test('relative traversal (../name) resolves against the referencing root', () => {
  const fs = memFs({ [manifest('sib')]: '---\n---\n' });
  const r = resolvePipelineRef('../sib', pipe('main'), fs);
  expect(r.root).toBe(pipe('sib'));
});

// ---------------------------------------------------------------------------
// lintComposition — cycles
// ---------------------------------------------------------------------------

test('self-reference is a cycle naming the pipeline twice', () => {
  const fs = world({ a: 'a' });
  const errors = lintComposition(pipe('a'), [edge(pipe('a'))], { fs });
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain('composition cycle detected: a → a');
});

test('A→B→A and longer cycles are reported with the full path', () => {
  const two = lintComposition(pipe('a'), [edge(pipe('b'))], { fs: world({ a: 'b', b: 'a' }) });
  expect(two.length).toBe(1);
  expect(two[0]).toContain('composition cycle detected: a → b → a');

  const three = lintComposition(pipe('a'), [edge(pipe('b'))], {
    fs: world({ a: 'b', b: 'c', c: 'a' }),
  });
  expect(three.length).toBe(1);
  expect(three[0]).toContain('composition cycle detected: a → b → c → a');
});

test('a diamond DAG (shared grandchild) is NOT a cycle', () => {
  const fs = world({ b: 'd', c: 'd', d: null });
  const errors = lintComposition(pipe('a'), [edge(pipe('b')), edge(pipe('c'))], { fs });
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// lintComposition — depth cap
// ---------------------------------------------------------------------------

test('the default depth cap allows a chain of MAX_COMPOSITION_DEPTH and rejects one deeper', () => {
  const names = Array.from({ length: MAX_COMPOSITION_DEPTH + 1 }, (_, i) => `p${i + 1}`);
  const chain: Record<string, string | null> = {};
  names.forEach((n, i) => (chain[n] = i < names.length - 1 ? names[i + 1] : null));

  // p1 … p7 (7 pipelines) — depth 7 > 6.
  const over = lintComposition(pipe('p1'), [edge(pipe('p2'))], { fs: world(chain) });
  expect(over.length).toBe(1);
  expect(over[0]).toContain(
    `composition depth ${MAX_COMPOSITION_DEPTH + 1} exceeds the cap (${MAX_COMPOSITION_DEPTH})`,
  );

  // Trim the last link: p1 … p6 — exactly at the cap, clean.
  const atCap: Record<string, string | null> = { ...chain };
  atCap[`p${MAX_COMPOSITION_DEPTH}`] = null;
  delete atCap[`p${MAX_COMPOSITION_DEPTH + 1}`];
  expect(lintComposition(pipe('p1'), [edge(pipe('p2'))], { fs: world(atCap) })).toEqual([]);
});

test('maxDepth overrides the cap; invalid overrides fall back to the default', () => {
  const fs = world({ a: 'b', b: 'c', c: null });
  const capped = lintComposition(pipe('a'), [edge(pipe('b'))], { fs, maxDepth: 2 });
  expect(capped.length).toBe(1);
  expect(capped[0]).toContain('composition depth 3 exceeds the cap (2)');
  expect(capped[0]).toContain('a → b → c');

  expect(lintComposition(pipe('a'), [edge(pipe('b'))], { fs, maxDepth: 3 })).toEqual([]);
  // Invalid (0 / fractional) → default cap, which a 3-chain satisfies.
  expect(lintComposition(pipe('a'), [edge(pipe('b'))], { fs, maxDepth: 0 })).toEqual([]);
  expect(lintComposition(pipe('a'), [edge(pipe('b'))], { fs, maxDepth: 2.5 })).toEqual([]);
});

// ---------------------------------------------------------------------------
// lintComposition — child reference problems surface labeled
// ---------------------------------------------------------------------------

test("a child's unresolvable or missing 'pipeline:' reference is a labeled error", () => {
  const unresolvable = lintComposition(pipe('a'), [edge(pipe('b'))], {
    fs: world({ a: 'b', b: 'ghost' }),
  });
  expect(unresolvable.length).toBe(1);
  expect(unresolvable[0]).toContain("composition: 'b' steps/01-a.md: pipeline reference 'ghost' does not resolve");

  const missingKey = lintComposition(pipe('a'), [edge(pipe('b'))], {
    fs: memFs({
      [manifest('b')]: '---\n---\n',
      [join(pipe('b'), 'steps', '01-a.md')]: '---\ntype: pipeline\n---\n# X\n',
    }),
  });
  expect(missingKey.length).toBe(1);
  expect(missingKey[0]).toContain(
    "composition: 'b' steps/01-a.md: type: pipeline requires a 'pipeline:' frontmatter reference",
  );
});

test('non-pipeline steps in children contribute no edges (agent/script/unknown types are skipped)', () => {
  const fs = memFs({
    [manifest('b')]: '---\n---\n',
    [join(pipe('b'), 'steps', '01-agent.md')]: '# plain agent step\n',
    [join(pipe('b'), 'steps', '02-script.md')]: '---\ntype: script\nscript: s.py\n---\n# S\n',
    [join(pipe('b'), 'steps', '03-odd.md')]: '---\ntype: robot\npipeline: ghost\n---\n# R\n',
  });
  expect(lintComposition(pipe('a'), [edge(pipe('b'))], { fs })).toEqual([]);
});
