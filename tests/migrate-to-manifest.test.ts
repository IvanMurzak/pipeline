// `pipeline migrate --to-manifest` — a v1 pipeline becomes one pipeline.yml.
//
//   bun test tests/migrate-to-manifest.test.ts
//
// The migration is generated from the computed PLAN, not from the source files:
// the plan is what the v1 walk actually decided after reading PIPELINE.md, every
// step's frontmatter, the `## Graph` section and the filename order, so emitting
// from it is the only way to be sure the manifest says what the pipeline already
// does rather than what its files appear to say.
//
// Which is why the gate is EQUIVALENCE, not lint: the emitted manifest is parsed
// back and re-planned, and a migration that produces a valid pipeline which is
// not THIS pipeline writes nothing.

import { test, expect, describe, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrate } from '../src/commands/migrate';
import { parseManifest } from '../src/lib/manifest';
import { planFromManifest } from '../src/lib/manifest-plan';
import { computePlan } from '../src/lib/plan';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function scaffold(pipelineMd: string, steps: Record<string, string>, extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'tomanifest-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), pipelineMd);
  for (const [rel, content] of Object.entries({ ...steps, ...extra })) {
    const full = join(root, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function migrate(root: string, args: string[] = []) {
  let out = '';
  let err = '';
  const code = runMigrate(['--to-manifest', '--root', root, ...args], {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
  });
  return { code, out, err };
}

const LINEAR = {
  'steps/01-implement.md': '---\nmodel: opus\n---\n# Implement\n\n## Next\n- steps/02-review.md\n',
  'steps/02-review.md': '# Review\n\n## Next\n- Pipeline complete.\n',
};

describe('generating the manifest', () => {
  test('a linear v1 pipeline becomes a manifest that plans identically', () => {
    const root = scaffold('---\nexecution: sequential\nisolation: external\n---\n# P\n', LINEAR);
    const r = migrate(root);
    expect(r.code).toBe(0);
    expect(existsSync(join(root, 'pipeline.yml'))).toBe(true);

    const manifest = parseManifest(readFileSync(join(root, 'pipeline.yml'), 'utf8'));
    expect(manifest.errors).toEqual([]);
    const after = planFromManifest(manifest, root);
    expect(after.errors).toEqual([]);
    expect(after.steps.map((s) => s.step_id)).toEqual(['implement', 'review']);
    expect(after.steps.map((s) => s.model)).toEqual(['opus', null]);
    expect(after.isolation).toBe('external');
  });

  test('the ordering prefix is dropped, and the map says so', () => {
    // `01-implement` named a fact — its position — that the manifest's step list
    // now carries, so keeping it would leave the step named after nothing.
    const root = scaffold('# P\n', LINEAR);
    const r = migrate(root, ['--dry-run']);
    expect(r.out).toContain('01-implement -> implement');
    expect(r.out).toContain('ordering prefix dropped');
    expect(r.out).toContain('2 step(s) renamed');
  });

  test('an explicit step_id is kept — it was already a name, not a position', () => {
    const root = scaffold('# P\n', {
      'steps/01-a.md': '---\nstep_id: wait-ci\n---\n# A\n',
      'steps/02-b.md': '# B\n',
    });
    const r = migrate(root, ['--dry-run']);
    expect(r.out).toContain('wait-ci -> wait-ci');
  });

  test('two steps whose prefixes hid a collision keep their original ids', () => {
    // `01-build` and `02-build` both want to become `build`. Merging them would
    // be far worse than a clumsy name, so neither is renamed.
    const root = scaffold('# P\n', { 'steps/01-build.md': '# 1\n', 'steps/02-build.md': '# 2\n' });
    const r = migrate(root, ['--dry-run']);
    expect(r.out).toContain('01-build -> 01-build');
    expect(r.out).toContain('02-build -> 02-build');
    expect(r.out).not.toContain('renamed');
  });

  test('a `## Graph` section becomes `flow:`, with every reference renamed', () => {
    const root = scaffold(
      '# P\n\n## Graph\n```json\n{"01-a":{"goto":"02-b"},"02-b":[{"when":"retry","goto":"01-a","max":2},{"done":true}]}\n```\n',
      { 'steps/01-a.md': '# A\n', 'steps/02-b.md': '# B\n' },
    );
    const r = migrate(root);
    expect(r.code).toBe(0);
    const yaml = readFileSync(join(root, 'pipeline.yml'), 'utf8');
    const flow = yaml.slice(yaml.indexOf('flow:'));
    // Renamed on BOTH sides of every edge — a graph still pointing at `01-a`
    // would dangle against the new step names. (The `body:` paths keep the old
    // filenames, of course: those are files, and migration renames no files.)
    expect(flow).not.toContain('01-a');
    expect(flow).not.toContain('02-b');
    expect(flow).toContain('when: retry');
    expect(flow).toContain('max: 2');
    expect(planFromManifest(parseManifest(yaml), root).errors).toEqual([]);
  });

  test("a script step's frontmatter and `## Params` move into the manifest", () => {
    const root = scaffold('# P\n', {
      'steps/01-verify.md':
        '---\ntype: script\nscript: scripts/v.py\ntimeout: 180\nretries: 1\non-failure: agent\n---\n' +
        '# V\n\n## Params\n\n```json\n{"root":{"type":"string","required":true,"from":"${project.root}"}}\n```\n' +
        '\n## Output\n\n```json\n{"sha":{"type":"string"}}\n```\n' +
        '\n## Next\n- Pipeline complete.\n',
    });
    const r = migrate(root);
    expect(r.code).toBe(0);
    const after = planFromManifest(parseManifest(readFileSync(join(root, 'pipeline.yml'), 'utf8')), root);
    const spec = after.steps[0].script_spec!;
    expect(spec.script).toBe('scripts/v.py');
    expect(spec.timeoutS).toBe(180);
    expect(spec.retries).toBe(1);
    expect(spec.onFailure).toBe('agent');
    expect(spec.params).toEqual({ root: { type: 'string', required: true, from: '${project.root}' } });
    expect(spec.output).toEqual({ sha: { type: 'string' } });
  });

  test('v1 defaults are omitted, and the inert sequential worktree is called out', () => {
    const root = scaffold('# P\n', LINEAR);
    const printed = migrate(root, ['--dry-run']).out;
    // The manifest BODY only — the header comment names keys on purpose.
    const yaml = printed.slice(printed.indexOf('schema: 2'), printed.indexOf('Step names'));
    // Nothing gained from restating what the parser already defaults to…
    expect(yaml).not.toContain('base_branch:');
    expect(yaml).not.toContain('self_improve:');
    // …but the reader is told why `isolation: step` is there and means nothing.
    expect(printed).toContain('do nothing in a sequential run');
  });
});

describe('the equivalence gate', () => {
  test('the emitted manifest re-plans to the same pipeline', () => {
    const root = scaffold('---\nexecution: parallel\n---\n# P\n', {
      'steps/01-setup.md': '---\nstep_id: setup\n---\n# S\n',
      'steps/02-lint.md': '---\nstep_id: lint\ndepends-on: [setup]\n---\n# L\n',
      'steps/03-test.md': '---\nstep_id: test\ndepends-on: [setup]\n---\n# T\n',
    });
    expect(migrate(root).code).toBe(0);
    const before = computePlan(root); // now prefers the manifest
    expect(before.errors).toEqual([]);
    expect(before.layers).toEqual([['setup'], ['lint', 'test']]);
  });

  test('a v1 pipeline that does not plan cleanly is refused, not translated', () => {
    // Translating a broken pipeline would bake the ambiguity into the manifest.
    const root = scaffold('---\nexecution: parallel\n---\n# P\n', {
      'steps/01-a.md': '---\nstep_id: a\ndepends-on: [ghost]\n---\n# A\n',
    });
    const r = migrate(root);
    expect(r.code).toBe(1);
    expect(r.err).toContain('does not plan cleanly');
    expect(existsSync(join(root, 'pipeline.yml'))).toBe(false);
  });
});

describe('refusing to destroy work', () => {
  test('an existing pipeline.yml is not overwritten', () => {
    const root = scaffold('# P\n', LINEAR);
    writeFileSync(join(root, 'pipeline.yml'), '# hand-edited\n');
    const r = migrate(root);
    expect(r.code).toBe(1);
    expect(r.err).toContain('already exists');
    expect(readFileSync(join(root, 'pipeline.yml'), 'utf8')).toBe('# hand-edited\n');
  });

  test('--force regenerates from the MARKDOWN, not from the manifest it replaces', () => {
    const root = scaffold('# P\n', LINEAR);
    writeFileSync(join(root, 'pipeline.yml'), 'schema: 2\nname: stale\nsteps:\n  - name: gone\n    body: steps/01-implement.md\n');
    const r = migrate(root, ['--force']);
    expect(r.code).toBe(0);
    const yaml = readFileSync(join(root, 'pipeline.yml'), 'utf8');
    expect(yaml).not.toContain('gone');
    expect(yaml).toContain('name: implement');
  });

  test('--dry-run writes nothing', () => {
    const root = scaffold('# P\n', LINEAR);
    const r = migrate(root, ['--dry-run']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('[dry-run] no files written.');
    expect(existsSync(join(root, 'pipeline.yml'))).toBe(false);
  });

  test('a folder with no PIPELINE.md is a usage error, not an empty manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'notapipeline-'));
    created.push(root);
    expect(migrate(root).code).toBe(2);
  });

  test('--to and --to-manifest together are refused as the different migrations they are', () => {
    const root = scaffold('# P\n', LINEAR);
    let err = '';
    const code = runMigrate(['--to-manifest', '--to', '1', '--root', root], {
      stdout: () => {},
      stderr: (s) => (err += s),
    });
    expect(code).toBe(2);
    expect(err).toContain('different migrations');
  });
});

describe('what a v2 manifest cannot carry is reported, never dropped', () => {
  test("a script step's inline `command:` is named as unsupported", () => {
    const root = scaffold('# P\n', {
      'steps/01-x.md': '---\ntype: script\ncommand: python do.py\n---\n# X\n\n## Next\n- Pipeline complete.\n',
    });
    const r = migrate(root, ['--dry-run']);
    expect(r.err).toContain('command:');
    expect(r.err).toContain('cannot express');
  });

  test('a (required) variable is named as unsupported', () => {
    const root = scaffold(
      '# P\n\n## Variables\n- `PP_TOKEN` (required) — the API token.\n',
      { 'steps/01-a.md': '# A ${PP_TOKEN}\n' },
    );
    const r = migrate(root, ['--dry-run']);
    expect(r.err).toContain('PP_TOKEN');
    expect(r.err).toContain('required');
  });

  test('the JSON form carries the same facts for a script to act on', () => {
    const root = scaffold('# P\n', LINEAR);
    const r = migrate(root, ['--dry-run', '--json']);
    const j = JSON.parse(r.out) as {
      dryRun: boolean;
      wrote: string[];
      steps: number;
      renames: Array<{ from: string; to: string }>;
      unsupported: string[];
    };
    expect(j.dryRun).toBe(true);
    expect(j.wrote).toEqual([]);
    expect(j.steps).toBe(2);
    expect(j.renames).toEqual([
      { from: '01-implement', to: 'implement' },
      { from: '02-review', to: 'review' },
    ]);
    expect(j.unsupported).toEqual([]);
  });
});
