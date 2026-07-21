// render-source-mapping.test.ts — the rendered-shadow → SOURCE inverse mapping
// (env-variables design 05 §5, a5). Regression coverage for the "multi-step
// pipeline that declares ${PP_*} halts at step 2" defect:
//
//   A step dispatched from its RENDERED copy has its executor read that copy,
//   so a `## Next` link (`<pipeline-root>/steps/NN.md`) resolves relative to the
//   rendered tree and the reported `next_iteration` is a
//   `.runtime/<run>/rendered/<slug>/…` path. That path IS physically inside the
//   pipeline root, but under the `.runtime` denylist, so relUnder classified it
//   "outside the pipeline root" and the next step was dispatched UNRENDERED
//   (${PP_*} never substituted). sourcePathForRendered maps it back to the
//   author source so the classification is INSIDE-root and the step renders.
//
// UNIT level, hermetic (no LLM, no `pipeline drive`) — runs on windows-latest.

import { test, expect, afterEach } from 'bun:test';
import { renderActionSteps, renderedRootFor, sourcePathForRendered } from '../src/lib/render';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

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

function mkRoot(): string {
  const project = mkdtempSync(join(tmpdir(), 'rsm-proj-'));
  created.push(project);
  const root = join(project, '.claude', 'pipeline', 'demo');
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(
    join(root, 'PIPELINE.md'),
    ['---', 'runner: manager', '---', '# P', '', '## Variables', '- PP_X (required) — x', ''].join('\n'),
  );
  writeFileSync(join(root, 'steps', '01-a.md'), '---\nstep_id: s1\n---\n# a\n\nDeploy ${PP_X}.\n');
  writeFileSync(join(root, 'steps', '02-b.md'), '---\nstep_id: s2\n---\n# b\n\nAnnounce ${PP_X}.\n');
  return root;
}

// ---------------------------------------------------------------------------
// 1. sourcePathForRendered — the inverse of renderedRootFor
// ---------------------------------------------------------------------------

test('sourcePathForRendered maps a rendered iteration path back to its author source (native + forward-slash separators)', () => {
  const root = mkRoot();
  const runId = 'run1';
  const source = join(root, 'steps', '02-b.md');
  const renderedNative = join(renderedRootFor(root, runId), 'steps', '02-b.md');

  // Native separators.
  expect(resolve(sourcePathForRendered(root, runId, renderedNative))).toBe(resolve(source));

  // Forward-slash form — exactly what an executor reports on Windows
  // (`C:/…/rendered/demo/steps/02-b.md`); identical to native on POSIX. Proves
  // the containment seam is separator-normalized (resolve()+relative()), not
  // separator-sensitive: BOTH map to the same source.
  const renderedFwd = renderedNative.split(sep).join('/');
  expect(resolve(sourcePathForRendered(root, runId, renderedFwd))).toBe(resolve(source));
});

test('sourcePathForRendered is a no-op for source paths, PIPELINE_COMPLETE, another run, and outside-root paths', () => {
  const root = mkRoot();
  const source = join(root, 'steps', '02-b.md');

  // Already a source path — unchanged (nothing under .runtime/<run>/rendered/).
  expect(sourcePathForRendered(root, 'run1', source)).toBe(source);

  // Sequential-complete sentinel — never a path.
  expect(sourcePathForRendered(root, 'run1', 'PIPELINE_COMPLETE')).toBe('PIPELINE_COMPLETE');

  // A DIFFERENT run's rendered tree is not this run's — left verbatim (only the
  // matching <run-id> segment is stripped).
  const otherRendered = join(renderedRootFor(root, 'run2'), 'steps', '02-b.md');
  expect(sourcePathForRendered(root, 'run1', otherRendered)).toBe(otherRendered);

  // A sibling family/hub path outside the root stays put.
  const outside = join(root, '..', 'other-pipeline', 'steps', '01.md');
  expect(sourcePathForRendered(root, 'run1', outside)).toBe(outside);
});

// ---------------------------------------------------------------------------
// 2. renderActionSteps containment — the rendered path is classified INSIDE the
//    root and RENDERED (substituted), not dispatched unrendered.
// ---------------------------------------------------------------------------

test('renderActionSteps: a rendered iteration path is classified INSIDE the root and rendered (substituted), not dispatched unrendered', () => {
  const root = mkRoot();
  const runId = 'run1';
  const vars = { PP_X: 'payments' };

  // First action renders step 1 and mirrors the whole tree — step 2's rendered
  // copy now exists RAW under `.runtime/<run>/rendered/demo/steps/02-b.md`.
  const first = renderActionSteps({ pipelineRootAbs: root, runId, stepSources: [join(root, 'steps', '01-a.md')], vars });
  expect(first.ok).toBe(true);

  // The exact scenario the executor produces: next_iteration is the RENDERED
  // path of step 2 (it resolved `## Next` relative to the rendered step-1 file).
  const renderedNext = join(renderedRootFor(root, runId), 'steps', '02-b.md');

  const res = renderActionSteps({ pipelineRootAbs: root, runId, stepSources: [renderedNext], vars });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.reason);

  // FIX: the rendered path is recognized as its source counterpart, so the step
  // is rendered (a non-null rendered path) with ${PP_X} substituted — NOT null
  // (which was the "dispatched unrendered" bug). Pre-fix: res.rendered[0] was
  // null and the raw copy still read `Announce ${PP_X}.`.
  const out = res.rendered[0];
  expect(out).not.toBeNull();
  expect(resolve(out!)).toBe(resolve(join(renderedRootFor(root, runId), 'steps', '02-b.md')));
  const body = readFileSync(out!, 'utf8');
  expect(body).toContain('Announce payments.');
  expect(body).not.toContain('${PP_X}');
});
