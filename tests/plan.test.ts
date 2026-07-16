import { test, expect, afterEach } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const created: string[] = [];

function scaffold(manifest: string | null, steps: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'plan-'));
  created.push(root);
  if (manifest !== null) writeFileSync(join(root, 'PIPELINE.md'), manifest);
  const stepsDir = join(root, 'steps');
  mkdirSync(stepsDir, { recursive: true });
  for (const [name, content] of Object.entries(steps)) {
    const full = join(stepsDir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

test('sequential by default when no frontmatter present', () => {
  const plan = computePlan(scaffold(null, { '01-a.md': '# A\n', '02-b.md': '# B\n' }));
  expect(plan.mode).toBe('sequential');
  expect(plan.layers).toBeNull();
  expect(plan.steps.map((s) => s.step_id)).toEqual(['01-a', '02-b']);
  expect(plan.errors).toEqual([]);
});

test('execution: parallel builds topological layers', () => {
  const plan = computePlan(
    scaffold('---\nexecution: parallel\n---\n', {
      '01-build.md': '---\nstep_id: build\n---\n',
      '02-lint.md': '---\nstep_id: lint\ndepends-on: [build]\n---\n',
      '03-test.md': '---\nstep_id: test\ndepends-on: [build]\n---\n',
    }),
  );
  expect(plan.mode).toBe('parallel');
  expect(plan.layers).toEqual([['build'], ['lint', 'test']]);
  expect(plan.errors).toEqual([]);
});

test('depends-on without execution: parallel → sequential + warning (the gate)', () => {
  const plan = computePlan(
    scaffold('---\n---\n', {
      '01-a.md': '---\nstep_id: a\n---\n',
      '02-b.md': '---\nstep_id: b\ndepends-on: [a]\n---\n',
    }),
  );
  expect(plan.mode).toBe('sequential');
  expect(plan.layers).toBeNull();
  expect(plan.warnings.some((w) => w.includes('execution: parallel'))).toBe(true);
});

test('cycle is reported as an error', () => {
  const plan = computePlan(
    scaffold('---\nexecution: parallel\n---\n', {
      '01-a.md': '---\nstep_id: a\ndepends-on: [b]\n---\n',
      '02-b.md': '---\nstep_id: b\ndepends-on: [a]\n---\n',
    }),
  );
  expect(plan.errors.some((e) => e.toLowerCase().includes('cycle'))).toBe(true);
});

test('dangling depends-on id is reported', () => {
  const plan = computePlan(
    scaffold('---\nexecution: parallel\n---\n', {
      '01-a.md': '---\nstep_id: a\ndepends-on: [ghost]\n---\n',
    }),
  );
  expect(plan.errors.some((e) => e.includes('ghost'))).toBe(true);
});

test('model resolution: step overrides pipeline default, alias passthrough', () => {
  const plan = computePlan(
    scaffold('---\nmodel: sonnet\n---\n', {
      '01-a.md': '---\n---\n',
      '02-b.md': '---\nmodel: opus\n---\n',
    }),
  );
  expect(plan.default_model).toBe('sonnet');
  expect(plan.steps[0].model).toBe('sonnet');
  expect(plan.steps[1].model).toBe('opus');
});

test('supplied defaultModel option overrides the manifest model', () => {
  const plan = computePlan(scaffold('---\nmodel: sonnet\n---\n', { '01-a.md': '---\n---\n' }), {
    defaultModel: 'haiku',
  });
  expect(plan.default_model).toBe('haiku');
  expect(plan.steps[0].model).toBe('haiku');
});

test('effort resolution: step overrides pipeline default; inherit/absent → null', () => {
  const plan = computePlan(
    scaffold('---\neffort: high\n---\n', {
      '01-a.md': '---\n---\n',
      '02-b.md': '---\neffort: max\n---\n',
      '03-c.md': '---\neffort: inherit\n---\n',
    }),
  );
  expect(plan.default_effort).toBe('high');
  expect(plan.steps[0].effort).toBe('high');
  expect(plan.steps[1].effort).toBe('max');
  // Explicit inherit falls through to the pipeline default (same ladder as model).
  expect(plan.steps[2].effort).toBe('high');
  // No effort anywhere → null.
  const bare = computePlan(scaffold(null, { '01-a.md': '# A\n' }));
  expect(bare.default_effort).toBeNull();
  expect(bare.steps[0].effort).toBeNull();
});

test('effort: invalid values warn and fall back to inherit; overrides beat frontmatter', () => {
  const plan = computePlan(
    scaffold('---\neffort: turbo\n---\n', {
      '01-a.md': '---\neffort: warp\n---\n',
      '02-b.md': '---\neffort: low\n---\n',
    }),
    { effortOverrides: { '02-b': 'xhigh', '01-a': 'bogus', ghost: 'max' } },
  );
  expect(plan.default_effort).toBeNull();
  expect(plan.warnings.some((w) => w.includes("invalid effort 'turbo'"))).toBe(true);
  expect(plan.warnings.some((w) => w.includes("invalid effort 'warp'"))).toBe(true);
  // Invalid override value → warned + dropped (frontmatter would have won, but it's invalid too → null).
  expect(plan.warnings.some((w) => w.includes('--effort 01-a=bogus'))).toBe(true);
  expect(plan.steps[0].effort).toBeNull();
  // Valid override beats the step's own frontmatter.
  expect(plan.steps[1].effort).toBe('xhigh');
  expect(plan.effort_overrides).toEqual({ '02-b': 'xhigh', ghost: 'max' });
  // Off-plan override key warns but is kept.
  expect(plan.warnings.some((w) => w.includes("--effort ghost=…"))).toBe(true);
});

test('supplied defaultEffort option overrides the manifest effort', () => {
  const plan = computePlan(scaffold('---\neffort: low\n---\n', { '01-a.md': '---\n---\n' }), {
    defaultEffort: 'max',
  });
  expect(plan.default_effort).toBe('max');
  expect(plan.steps[0].effort).toBe('max');
});

test('isolation: manual is surfaced in parallel mode', () => {
  const plan = computePlan(
    scaffold('---\nexecution: parallel\nisolation: manual\n---\n', {
      '01-a.md': '---\nstep_id: a\n---\n',
    }),
  );
  expect(plan.isolation).toBe('manual');
});

test('isolation: external is recognized and surfaced', () => {
  const plan = computePlan(
    scaffold('---\nisolation: external\n---\n', { '01-a.md': '---\n---\n' }),
  );
  expect(plan.isolation).toBe('external');
  expect(plan.warnings).toEqual([]);
});

test('unknown isolation still warns and falls back to worktree', () => {
  const plan = computePlan(
    scaffold('---\nisolation: bogus\n---\n', { '01-a.md': '---\n---\n' }),
  );
  expect(plan.isolation).toBe('worktree');
  expect(plan.warnings.some((w) => w.includes("unknown isolation 'bogus'"))).toBe(true);
});

test('parallel + external degrades to manual with a warning', () => {
  const plan = computePlan(
    scaffold('---\nexecution: parallel\nisolation: external\n---\n', {
      '01-a.md': '---\nstep_id: a\n---\n',
    }),
  );
  expect(plan.mode).toBe('parallel');
  expect(plan.isolation).toBe('manual');
  expect(
    plan.warnings.some((w) => w.includes('isolation: external is sequential-only')),
  ).toBe(true);
});

test('submodules: inline list and block list parse to the same array', () => {
  const inline = computePlan(
    scaffold('---\nisolation: external\nsubmodules: [AI-Game-Dev-App, Unity-MCP]\n---\n', {
      '01-a.md': '---\n---\n',
    }),
  );
  const block = computePlan(
    scaffold(
      '---\nisolation: external\nsubmodules:\n  - AI-Game-Dev-App\n  - Unity-MCP\n---\n',
      { '01-a.md': '---\n---\n' },
    ),
  );
  expect(inline.submodules).toEqual(['AI-Game-Dev-App', 'Unity-MCP']);
  expect(block.submodules).toEqual(['AI-Game-Dev-App', 'Unity-MCP']);
  expect(inline.submodules).toEqual(block.submodules);
});

test('submodules defaults to empty array when absent', () => {
  const plan = computePlan(scaffold('---\nisolation: external\n---\n', { '01-a.md': '---\n---\n' }));
  expect(plan.submodules).toEqual([]);
});

test('finalize: true frontmatter opts into the finalize stage; absent/other defaults to false', () => {
  const on = computePlan(
    scaffold('---\nisolation: external\nfinalize: true\n---\n', { '01-a.md': '---\n---\n' }),
  );
  const off = computePlan(
    scaffold('---\nisolation: external\n---\n', { '01-a.md': '---\n---\n' }),
  );
  const explicitOff = computePlan(
    scaffold('---\nisolation: external\nfinalize: false\n---\n', { '01-a.md': '---\n---\n' }),
  );
  expect(on.finalize).toBe(true);
  expect(off.finalize).toBe(false);
  expect(explicitOff.finalize).toBe(false);
  expect(on.warnings).toEqual([]);
});

test('finalize defaults false with no PIPELINE.md at all', () => {
  const plan = computePlan(scaffold(null, { '01-a.md': '# A\n' }));
  expect(plan.finalize).toBe(false);
});

test('delete_branches: false frontmatter opts out; absent/true defaults to true', () => {
  const off = computePlan(
    scaffold('---\nisolation: external\ndelete_branches: false\n---\n', { '01-a.md': '---\n---\n' }),
  );
  const absent = computePlan(scaffold('---\nisolation: external\n---\n', { '01-a.md': '---\n---\n' }));
  const explicitOn = computePlan(
    scaffold('---\nisolation: external\ndelete_branches: true\n---\n', { '01-a.md': '---\n---\n' }),
  );
  expect(off.delete_branches).toBe(false);
  expect(absent.delete_branches).toBe(true);
  expect(explicitOn.delete_branches).toBe(true);
  expect(off.warnings).toEqual([]);
});

test('delete_branches defaults true with no PIPELINE.md at all', () => {
  const plan = computePlan(scaffold(null, { '01-a.md': '# A\n' }));
  expect(plan.delete_branches).toBe(true);
});

test('base_branch: frontmatter overrides; defaults to main (with or without a manifest); blank keeps main', () => {
  const overridden = computePlan(
    scaffold('---\nisolation: external\nbase_branch: develop\n---\n', { '01-a.md': '---\n---\n' }),
  );
  const defaulted = computePlan(
    scaffold('---\nisolation: external\n---\n', { '01-a.md': '---\n---\n' }),
  );
  const blank = computePlan(
    scaffold('---\nisolation: external\nbase_branch:\n---\n', { '01-a.md': '---\n---\n' }),
  );
  const noManifest = computePlan(scaffold(null, { '01-a.md': '# A\n' }));
  expect(overridden.base_branch).toBe('develop');
  expect(overridden.warnings).toEqual([]);
  expect(defaulted.base_branch).toBe('main');
  expect(blank.base_branch).toBe('main');
  expect(noManifest.base_branch).toBe('main');
});

test('worktree_hook_dir parses an override and defaults otherwise', () => {
  const overridden = computePlan(
    scaffold('---\nisolation: external\nworktree_hook_dir: custom/.hooks\n---\n', {
      '01-a.md': '---\n---\n',
    }),
  );
  const defaulted = computePlan(
    scaffold('---\nisolation: external\n---\n', { '01-a.md': '---\n---\n' }),
  );
  expect(overridden.worktree_hook_dir).toBe('custom/.hooks');
  expect(defaulted.worktree_hook_dir).toBe('.claude/pipeline/.hooks');
});

test('no iteration files → error', () => {
  const plan = computePlan(scaffold('---\n---\n', {}));
  expect(plan.errors.some((e) => e.includes('No iteration files'))).toBe(true);
});

test('runner defaults to manager when absent (and with no PIPELINE.md at all)', () => {
  const withManifest = computePlan(scaffold('---\n---\n', { '01-a.md': '---\n---\n' }));
  const withoutManifest = computePlan(scaffold(null, { '01-a.md': '# A\n' }));
  expect(withManifest.runner).toBe('manager');
  expect(withoutManifest.runner).toBe('manager');
  expect(withManifest.warnings).toEqual([]);
});

test('runner: headless is parsed and surfaced', () => {
  const plan = computePlan(
    scaffold('---\nrunner: headless\n---\n', { '01-a.md': '---\n---\n' }),
  );
  expect(plan.runner).toBe('headless');
  expect(plan.warnings).toEqual([]);
});

test('runner: manager is accepted explicitly without a warning', () => {
  const plan = computePlan(
    scaffold('---\nrunner: manager\n---\n', { '01-a.md': '---\n---\n' }),
  );
  expect(plan.runner).toBe('manager');
  expect(plan.warnings).toEqual([]);
});

test('unknown runner warns and falls back to manager', () => {
  const plan = computePlan(
    scaffold('---\nrunner: bogus\n---\n', { '01-a.md': '---\n---\n' }),
  );
  expect(plan.runner).toBe('manager');
  expect(plan.warnings.some((w) => w.includes("unknown runner 'bogus', using manager"))).toBe(true);
});

test('lint: iteration file over the ~1500-token budget warns with the estimate', () => {
  // 8000 bytes ≈ 2000 estimated tokens — well over the 1500 budget.
  const big = '# A\n\n## Context\n' + 'x'.repeat(8000) + '\n';
  const plan = computePlan(scaffold(null, { '01-a.md': big, '02-b.md': '# B\n' }));
  const hit = plan.warnings.filter((w) => w.includes('budget ~1500'));
  expect(hit.length).toBe(1);
  expect(hit[0]).toMatch(/^steps\/01-a\.md is ~\d+ tokens \(budget ~1500\) — consider splitting or extracting Steps to a script$/);
  expect(plan.errors).toEqual([]);
});

test('lint: PIPELINE.md over the ~300-token cap warns with the estimate', () => {
  const manifest = '---\n---\n# Pipeline\n' + 'y'.repeat(2000) + '\n';
  const plan = computePlan(scaffold(manifest, { '01-a.md': '# A\n' }));
  const hit = plan.warnings.filter((w) => w.includes('cap ~300'));
  expect(hit.length).toBe(1);
  expect(hit[0]).toMatch(/^PIPELINE\.md is ~\d+ tokens \(cap ~300\)/);
  expect(plan.errors).toEqual([]);
});

test('lint: >=10 consecutive imperative lines in ## Steps → one script-extraction warning per file', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `${i + 1}. run step number ${i + 1}`);
  const content = '# A\n\n## Steps\n\n' + lines.join('\n') + '\n\n## Success Criteria\n- done\n';
  const plan = computePlan(scaffold(null, { '01-a.md': content }));
  const hit = plan.warnings.filter((w) => w.includes('procedural block'));
  expect(hit.length).toBe(1);
  expect(hit[0]).toBe(
    'steps/01-a.md § Steps has a ~12-line procedural block — script-extraction candidate (see pipeline-script-creator)',
  );
});

test('lint: procedural heuristic counts $-prompt and backticked-command lines', () => {
  const lines = Array.from({ length: 10 }, (_, i) =>
    i % 2 === 0 ? '$ git status' : 'then run `bun test tests/plan.test.ts` and check',
  );
  const content = '## Steps\n' + lines.join('\n') + '\n';
  const plan = computePlan(scaffold(null, { '01-a.md': content }));
  expect(plan.warnings.some((w) => w.includes('~10-line procedural block'))).toBe(true);
});

test('lint: procedural heuristic is conservative — short blocks, broken runs, and non-Steps sections stay silent', () => {
  // 9 consecutive lines: under the 10-line threshold.
  const nine = '## Steps\n' + Array.from({ length: 9 }, (_, i) => `${i + 1}. do thing`).join('\n') + '\n';
  // 12 imperative lines but a blank line breaks the run at 6+6.
  const broken =
    '## Steps\n' +
    Array.from({ length: 6 }, (_, i) => `- item ${i}`).join('\n') +
    '\n\n' +
    Array.from({ length: 6 }, (_, i) => `- item ${i + 6}`).join('\n') +
    '\n';
  // 12 imperative lines but outside any ## Steps section.
  const elsewhere = '## Context\n' + Array.from({ length: 12 }, (_, i) => `- item ${i}`).join('\n') + '\n';
  const plan = computePlan(
    scaffold(null, { '01-nine.md': nine, '02-broken.md': broken, '03-elsewhere.md': elsewhere }),
  );
  expect(plan.warnings).toEqual([]);
});

test('lint-free pipeline still produces zero warnings (byte-identical baseline)', () => {
  const plan = computePlan(
    scaffold('---\nexecution: parallel\nmodel: sonnet\n---\n# Pipeline\n\n## End State\nSmall.\n', {
      '01-build.md': '---\nstep_id: build\n---\n# Build\n\n## Steps\n- do one thing\n',
      '02-test.md': '---\nstep_id: test\ndepends-on: [build]\n---\n# Test\n\n## Steps\n- run tests\n',
    }),
  );
  expect(plan.warnings).toEqual([]);
  expect(plan.errors).toEqual([]);
  expect(plan.runner).toBe('manager');
});

test('nested sub-step folders are enumerated in path order', () => {
  const plan = computePlan(
    scaffold(null, {
      '01-a.md': '# A\n',
      '02-group/01-x.md': '# X\n',
      '02-group/02-y.md': '# Y\n',
      '03-z.md': '# Z\n',
    }),
  );
  expect(plan.steps.map((s) => s.rel)).toEqual([
    '01-a.md',
    '02-group/01-x.md',
    '02-group/02-y.md',
    '03-z.md',
  ]);
});

// --- target-family manifest-cap carve-out ---

test('lint: a family HUB (has targets/ subfolder) is exempt from the manifest cap', () => {
  const manifest = '---\n---\n# Pipeline\n' + 'y'.repeat(2000) + '\n';
  const root = scaffold(manifest, { '01-a.md': '# A\n' });
  mkdirSync(join(root, 'targets'), { recursive: true });
  const plan = computePlan(root);
  expect(plan.warnings.filter((w) => w.includes('cap ~'))).toEqual([]);
  expect(plan.errors).toEqual([]);
});

test('lint: a family TARGET (under targets/) gets the ~1500-token cap instead of ~300', () => {
  const base = mkdtempSync(join(tmpdir(), 'plan-'));
  created.push(base);
  const root = join(base, 'targets', 'foo');
  mkdirSync(join(root, 'steps'), { recursive: true });
  // ~500 estimated tokens: over the leaf cap, under the family-target cap → silent.
  writeFileSync(join(root, 'PIPELINE.md'), '---\n---\n# Pipeline\n' + 'y'.repeat(2000) + '\n');
  writeFileSync(join(root, 'steps', '01-a.md'), '# A\n');
  const quiet = computePlan(root);
  expect(quiet.warnings.filter((w) => w.includes('cap ~'))).toEqual([]);
  // ~2000 estimated tokens: over the family-target cap → warns with the family cap.
  writeFileSync(join(root, 'PIPELINE.md'), '---\n---\n# Pipeline\n' + 'y'.repeat(8000) + '\n');
  const loud = computePlan(root);
  const hit = loud.warnings.filter((w) => w.includes('cap ~1500 for a family target'));
  expect(hit.length).toBe(1);
});
