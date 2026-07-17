import { test, expect, afterEach } from 'bun:test';
import { computePlan } from '../src/lib/plan';
import { invokeNext } from '../src/commands/next';
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

// --- env-variables design (a2): `## Variables` parse + plan-time lints -----
//
// Spec: .claude/design/env-variables/{04-substitution-engine-spec,
// 05-integration-spec,02-target-architecture}.md. computePlan composes a1's
// pure src/lib/substitution.ts engine (parseVariablesSection + validateRun) —
// these tests exercise the plan.ts SEAM (attaching plan.variables, folding
// issues into errors/warnings with file:line, the manifest-cap exemption, the
// zero-change guard), not the grammar/lint rules themselves (covered
// exhaustively by tests/substitution.test.ts).

test('`## Variables` section parses into plan.variables (all three bullet forms + backticks + prose ignored)', () => {
  const manifest =
    '---\n---\n# Pipeline\n\n## Variables\n' +
    'Some prose line that is not a bullet.\n' +
    '- `PP_NAME` (required) — the service name\n' +
    '- PP_REGION (default: us-east-1) — deploy region\n' +
    '- PP_NOTES — free text, optional\n' +
    '\n## End State\nDone.\n';
  const plan = computePlan(scaffold(manifest, { '01-a.md': '# A\n' }));
  expect(plan.errors).toEqual([]);
  expect(plan.variables).toEqual([
    { name: 'PP_NAME', description: 'the service name', required: true },
    { name: 'PP_REGION', description: 'deploy region', required: false, default: 'us-east-1' },
    { name: 'PP_NOTES', description: 'free text, optional', required: false },
  ]);
});

test('lint: L5 duplicate-decl is a PIPELINE.md error; the FIRST declaration wins in plan.variables', () => {
  const manifest = '---\n---\n## Variables\n- PP_X (default: a) — first\n- PP_X (default: b) — second\n';
  const plan = computePlan(scaffold(manifest, { '01-a.md': '# A\n' }));
  const hit = plan.errors.find((e) => e.includes('declared more than once'));
  expect(hit).toBeDefined();
  expect(hit).toMatch(/^PIPELINE\.md:\d+: /);
  expect(plan.variables).toEqual([{ name: 'PP_X', description: 'first', required: false, default: 'a' }]);
});

test('lint: L4 malformed-decl — (required) and (default: ...) together', () => {
  const manifest = '---\n---\n## Variables\n- PP_X (required) (default: a) — bad\n';
  const plan = computePlan(scaffold(manifest, { '01-a.md': '# A\n' }));
  const hit = plan.errors.find((e) => e.includes('mutually exclusive'));
  expect(hit).toBeDefined();
  expect(hit).toMatch(/^PIPELINE\.md:\d+: /);
});

test('lint: L4 malformed-decl — a non-uppercase declared name', () => {
  const manifest = '---\n---\n## Variables\n- PP_lower_name — bad case\n';
  const plan = computePlan(scaffold(manifest, { '01-a.md': '# A\n' }));
  const hit = plan.errors.find((e) => e.includes('not a valid variable name'));
  expect(hit).toBeDefined();
  expect(hit).toMatch(/^PIPELINE\.md:\d+: /);
});

test('lint: L1 undeclared — a valid ${PP_X} occurrence in a step body with no declarations at all', () => {
  const plan = computePlan(scaffold(null, { '01-a.md': '# A\n\nUse ${PP_SERVICE} here.\n' }));
  expect(plan.variables).toEqual([]);
  const hit = plan.errors.find((e) => e.includes('PP_SERVICE'));
  expect(hit).toBeDefined();
  expect(hit).toMatch(/^steps\/01-a\.md:3: /);
  expect(hit).toContain('not declared in PIPELINE.md ## Variables');
});

test('lint: L2 bad-name — a lowercase near-miss token in a step body', () => {
  const plan = computePlan(scaffold('---\n---\n', { '01-a.md': '# A\n\nDocument ${pp_x} here.\n' }));
  const hit = plan.errors.find((e) => e.includes('pp_x'));
  expect(hit).toBeDefined();
  expect(hit).toMatch(/^steps\/01-a\.md:3: /);
  expect(hit).toContain('not a valid variable token');
});

test('lint: L3 frontmatter — a PP_ token inside a NON-exempt step frontmatter field is banned', () => {
  const plan = computePlan(
    scaffold('---\n---\n', { '01-a.md': '---\nstep_id: ${PP_X}\n---\n# A\n' }),
  );
  const hit = plan.errors.find((e) => e.includes('not supported in frontmatter'));
  expect(hit).toBeDefined();
  expect(hit).toMatch(/^steps\/01-a\.md:2: /);
});

test('lint: L3 exemption — PP_ tokens inside command:/script: frontmatter keys are NOT banned (D5(c))', () => {
  const manifest = '---\n---\n## Variables\n- PP_SERVICE (required) — svc name\n';
  const plan = computePlan(
    scaffold(manifest, {
      '01-a.md':
        '---\ntype: script\nstep_id: a\ncommand: python notify.py --service ${PP_SERVICE}\n---\n' +
        '# A\n\n## Next\nPipeline complete.\n',
    }),
  );
  // No L3 (frontmatter-ban) error for the exempted command: key — and since
  // the token isn't in body text either, no error at all here.
  expect(plan.errors).toEqual([]);
  // a4 D5(c) surface sweep: command:/script: VALUES are swept like body text,
  // so a variable referenced ONLY there counts as USED — the a2-era false
  // "unused" warning is gone.
  expect(plan.warnings.filter((w) => w.includes('never used'))).toEqual([]);
});

// --- a4 D5(c) surface sweep: command:/script: values are lint surfaces ------

test('a4 surface sweep: an UNDECLARED ${PP_X} inside a command: value is an L1 plan ERROR (was run-init-only)', () => {
  const plan = computePlan(
    scaffold('---\n---\n', {
      '01-a.md':
        '---\ntype: script\nstep_id: a\ncommand: python notify.py --service ${PP_NOPE}\n---\n' +
        '# A\n\n## Next\nPipeline complete.\n',
    }),
  );
  const hit = plan.errors.find((e) => e.includes('PP_NOPE'));
  expect(hit).toBeDefined();
  // The issue carries the command: key's own file line (line 4 of the step).
  expect(hit).toMatch(/^steps\/01-a\.md:4: /);
  expect(hit).toContain('not declared in PIPELINE.md ## Variables');
});

test('a4 surface sweep: an undeclared token in a script: value and a near-miss are plan ERRORS', () => {
  const plan = computePlan(
    scaffold('---\n---\n', {
      '01-a.md':
        '---\ntype: script\nstep_id: a\nscript: scripts/${PP_MISSING_IMPL}.py\n---\n' +
        '# A\n\n## Next\nPipeline complete.\n',
      '02-b.md':
        '---\ntype: script\nstep_id: b\nscript: scripts/${pp_near}.py\n---\n' +
        '# B\n\n## Next\nPipeline complete.\n',
    }),
  );
  expect(plan.errors.some((e) => e.includes('PP_MISSING_IMPL') && e.includes('not declared'))).toBe(true);
  expect(plan.errors.some((e) => e.includes('pp_near') && e.includes('not a valid variable token'))).toBe(true);
});

test('a4 surface sweep: a token in command argv[0] is a plan ERROR — argv[0] is never a substitution surface (T3b)', () => {
  const manifest = '---\n---\n## Variables\n- PP_TOOL — tool to run\n';
  const plan = computePlan(
    scaffold(manifest, {
      '01-a.md':
        '---\ntype: script\nstep_id: a\ncommand: ${PP_TOOL} --version\n---\n' +
        '# A\n\n## Next\nPipeline complete.\n',
    }),
  );
  const hit = plan.errors.find((e) => e.includes('argv[0]'));
  expect(hit).toBeDefined();
  expect(hit).toContain('not allowed in the command program');
  // Exactly ONE argv[0] error, and the reference still counts as usage — no
  // contradictory L7 'never used' alongside it.
  expect(plan.errors.filter((e) => e.includes('argv[0]')).length).toBe(1);
  expect(plan.warnings.filter((w) => w.includes('never used'))).toEqual([]);
});

test('a4 surface sweep: an inline default with whitespace in a string-form command: warns (destroyed by tokenization, E2)', () => {
  const manifest = '---\n---\n## Variables\n- PP_X — a knob\n';
  const plan = computePlan(
    scaffold(manifest, {
      '01-a.md':
        '---\ntype: script\nstep_id: a\ncommand: tool --flag ${PP_X:-a b}\n---\n' +
        '# A\n\n## Next\nPipeline complete.\n',
    }),
  );
  const hit = plan.warnings.find((w) => w.includes('split apart by whitespace'));
  expect(hit).toBeDefined();
  expect(hit).toMatch(/^steps\/01-a\.md:4: /);
});

test('a4 surface sweep: array-form command values are swept too (usage + L1)', () => {
  const manifest = '---\n---\n## Variables\n- PP_SERVICE — svc\n';
  const plan = computePlan(
    scaffold(manifest, {
      '01-a.md':
        '---\ntype: script\nstep_id: a\ncommand:\n- notify.py\n- --service\n- ${PP_SERVICE}\n- ${PP_ELSE}\n---\n' +
        '# A\n\n## Next\nPipeline complete.\n',
    }),
  );
  // Undeclared PP_ELSE errors; declared PP_SERVICE counts as usage (no L7).
  expect(plan.errors.some((e) => e.includes('PP_ELSE') && e.includes('not declared'))).toBe(true);
  expect(plan.warnings.filter((w) => w.includes('never used'))).toEqual([]);
});

test('lint: L7 unused-decl warning for a declared-but-unreferenced variable', () => {
  // Regression: when NEITHER the manifest NOR any step file contains any
  // PP_-shaped text at all (the declaration bullet itself doesn't count —
  // it has no `${`), validateRun's fallbackFile must still resolve to
  // 'PIPELINE.md', never an empty string (which would render as a bare
  // leading-colon message with no location).
  const manifest = '---\n---\n## Variables\n- PP_UNUSED — never referenced\n';
  const plan = computePlan(scaffold(manifest, { '01-a.md': '# A\n' }));
  const hit = plan.warnings.find((w) => w.includes('PP_UNUSED') && w.includes('never used'));
  expect(hit).toBeDefined();
  expect(hit).toMatch(/^PIPELINE\.md: /);
  expect(plan.errors).toEqual([]);
});

test('lint regression: a CRLF-encoded manifest gets the SAME cap-exemption byte accounting as an LF one', () => {
  const varsBody =
    '## Variables\n' +
    Array.from(
      { length: 60 },
      (_, i) => `- PP_VAR_${i} — padding description text to bulk up the section considerably`,
    ).join('\n') +
    '\n';
  const lfManifest = '---\n---\n# Pipeline\n\n' + varsBody + '\n## End State\nSmall.\n';
  const crlfManifest = lfManifest.replace(/\n/g, '\r\n');
  const lfPlan = computePlan(scaffold(lfManifest, { '01-a.md': '# A\n' }));
  const crlfPlan = computePlan(scaffold(crlfManifest, { '01-a.md': '# A\n' }));
  expect(lfPlan.warnings.filter((w) => w.includes('cap ~'))).toEqual([]);
  expect(crlfPlan.warnings.filter((w) => w.includes('cap ~'))).toEqual([]);
});

test('lint regression: a zero-indent `command:` block-list (array form) is still exempt from L3 (D5(c))', () => {
  const manifest = '---\n---\n## Variables\n- PP_SERVICE (required) — svc name\n';
  const plan = computePlan(
    scaffold(manifest, {
      '01-a.md':
        '---\ntype: script\nstep_id: a\ncommand:\n- notify.py\n- --service\n- ${PP_SERVICE}\n---\n' +
        '# A\n\n## Next\nPipeline complete.\n',
    }),
  );
  expect(plan.errors).toEqual([]);
});

test('lint regression: command:/script: keys inside PIPELINE.md itself are NOT exempt (D5(c) is step-scoped)', () => {
  const manifest = '---\ncommand: ${PP_X}\n---\n## Variables\n- PP_X — a var\n';
  const plan = computePlan(scaffold(manifest, { '01-a.md': '# A\n' }));
  const hit = plan.errors.find((e) => e.includes('not supported in frontmatter'));
  expect(hit).toBeDefined();
  expect(hit).toMatch(/^PIPELINE\.md:\d+: /);
});

test('lint: L8 secretish-name warning for a declared name matching the D14 pattern', () => {
  const manifest = '---\n---\n## Variables\n- PP_API_TOKEN (required) — auth token\n';
  const plan = computePlan(scaffold(manifest, { '01-a.md': '# A\n\nUse ${PP_API_TOKEN} here.\n' }));
  expect(plan.warnings.some((w) => w.includes('PP_API_TOKEN') && w.includes('secret-like'))).toBe(true);
});

test('lint: L9 ineffective-default warning — an inline default on a required variable occurrence', () => {
  const manifest = '---\n---\n## Variables\n- PP_REQ (required) — must supply\n';
  const plan = computePlan(scaffold(manifest, { '01-a.md': '# A\n\nUse ${PP_REQ:-fallback} here.\n' }));
  const hit = plan.warnings.find((w) => w.includes('PP_REQ') && w.includes('ignored'));
  expect(hit).toBeDefined();
  expect(hit).toMatch(/^steps\/01-a\.md:3: /);
  // L6 (missing) is run-init-time, not plan.ts's job — no error here despite
  // PP_REQ never resolving to a value at plan time.
  expect(plan.errors).toEqual([]);
});

test('Params `from:` template accepts the PP_* root; an undeclared PP_ name there is an L1 error', () => {
  const manifest = '---\n---\n## Variables\n- PP_KNOWN — known var\n';
  const plan = computePlan(
    scaffold(manifest, {
      '01-a.md':
        '---\ntype: script\nstep_id: a\nscript: scripts/notify.py\n---\n# A\n\n## Params\n\n' +
        '```json\n{"target": {"type": "string", "from": "${PP_UNKNOWN}"}}\n```\n\n## Next\nPipeline complete.\n',
    }),
  );
  const hit = plan.errors.find((e) => e.includes('PP_UNKNOWN'));
  expect(hit).toBeDefined();
  expect(hit).toContain('not declared in PIPELINE.md ## Variables');
});

test('lint: D8 (REVISED) cap exemption — a large ## Variables section does NOT trip the manifest trim warning', () => {
  const bigVariablesSection =
    '## Variables\n' +
    Array.from(
      { length: 60 },
      (_, i) => `- PP_VAR_${i} — padding description text to bulk up the section considerably`,
    ).join('\n') +
    '\n';
  const manifest = '---\n---\n# Pipeline\n\n' + bigVariablesSection + '\n## End State\nSmall.\n';
  const plan = computePlan(scaffold(manifest, { '01-a.md': '# A\n' }));
  expect(plan.warnings.filter((w) => w.includes('cap ~'))).toEqual([]);
  expect(plan.variables.length).toBe(60);
});

test('zero-change: no ## Variables section and no PP_-shaped text anywhere → plan.variables empty, baseline untouched', () => {
  const plan = computePlan(
    scaffold('---\nexecution: parallel\nmodel: sonnet\n---\n# Pipeline\n\n## End State\nSmall.\n', {
      '01-build.md': '---\nstep_id: build\n---\n# Build\n\n## Steps\n- do one thing\n',
      '02-test.md': '---\nstep_id: test\ndepends-on: [build]\n---\n# Test\n\n## Steps\n- run tests\n',
    }),
  );
  expect(plan.variables).toEqual([]);
  expect(plan.warnings).toEqual([]);
  expect(plan.errors).toEqual([]);
});

test('zero-change caveat (principle 4): a PP_-shaped token with ZERO declarations is still an L1 error', () => {
  const plan = computePlan(scaffold(null, { '01-a.md': '# A\n\nMentions ${PP_ANYTHING} here.\n' }));
  expect(plan.variables).toEqual([]);
  expect(plan.errors.some((e) => e.includes('PP_ANYTHING') && e.includes('not declared'))).toBe(true);
});

// --- 07 P1 gate: lints halt runs end-to-end through commands/next.ts:1135 ---

test('07 P1 gate: an undeclared PP_ occurrence halts `pipeline next` before any action (end-to-end)', () => {
  const root = scaffold(null, { '01-a.md': '# A\n\nRun with ${PP_SERVICE}.\n' });
  const res = invokeNext({ root, runId: 'gate-undeclared' });
  expect(res.code).toBe(1);
  expect(res.action.action).toBe('halt');
  if (res.action.action !== 'halt') throw new Error('expected a halt action');
  expect(res.action.reason).toContain('plan errors');
  expect(res.action.reason).toContain('PP_SERVICE');
  expect(res.action.reason).toContain('not declared');
});

test('07 P1 gate: a PP_ token inside banned (non-exempt) frontmatter halts `pipeline next` (end-to-end)', () => {
  const root = scaffold('---\n---\n## Variables\n- PP_X — a var\n', {
    '01-a.md': '---\nstep_id: ${PP_X}\n---\n# A\n',
  });
  const res = invokeNext({ root, runId: 'gate-frontmatter' });
  expect(res.code).toBe(1);
  expect(res.action.action).toBe('halt');
  if (res.action.action !== 'halt') throw new Error('expected a halt action');
  expect(res.action.reason).toContain('plan errors');
  expect(res.action.reason).toContain('not supported in frontmatter');
});
