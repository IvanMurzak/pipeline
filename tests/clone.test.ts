// Tests for `pipeline clone <name>` (src/commands/clone.ts) + the bundled
// template library (src/lib/templates.ts).
//
// Two kinds of coverage:
//  1. clone behavior — copies the tree, refuses overwrite without --force,
//     replaces cleanly WITH --force, unknown/missing template errors, --list.
//     Plus one real-subprocess run from a temp CWD (the default-target path,
//     which the in-process tests exercise via --dir).
//  2. TEMPLATE VALIDITY — EVERY registered template must resolve to a folder
//     with a PIPELINE.md + a non-empty steps/ that PLANS cleanly (computePlan
//     errors empty). This is what makes a future template PR (which edits the
//     .ts registry) trip CI if the template it adds is malformed.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClone } from '../src/commands/clone';
import { TEMPLATES, TEMPLATES_DIR, templateDir } from '../src/lib/templates';
import { computePlan } from '../src/lib/plan';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const created: string[] = [];

/** A fresh empty temp dir that stands in for a consumer project root. */
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clone-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

/** Run runClone(args) capturing stdout/stderr + the exit code. */
function invoke(args: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((s: string) => ((stdout += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((stderr += s), true)) as typeof process.stderr.write;
  try {
    const code = runClone(args);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ---------------------------------------------------------------------------
// clone behavior
// ---------------------------------------------------------------------------

describe('pipeline clone', () => {
  test('copies the template tree into ./.claude/pipeline/<name>/', () => {
    const proj = tempProject();
    const { code, stdout } = invoke(['example-minimal', '--dir', proj]);
    expect(code).toBe(0);

    const dest = join(proj, '.claude', 'pipeline', 'example-minimal');
    expect(existsSync(join(dest, 'PIPELINE.md'))).toBe(true);
    expect(existsSync(join(dest, 'steps', '01-prepare.md'))).toBe(true);
    expect(existsSync(join(dest, 'steps', '02-finish.md'))).toBe(true);
    // Copied content is byte-identical to the bundled source.
    expect(readFileSync(join(dest, 'PIPELINE.md'), 'utf8')).toBe(
      readFileSync(join(templateDir('example-minimal'), 'PIPELINE.md'), 'utf8'),
    );
    expect(stdout).toContain('Cloned template');
  });

  test('refuses to overwrite an existing target without --force (exit 1)', () => {
    const proj = tempProject();
    expect(invoke(['example-minimal', '--dir', proj]).code).toBe(0);

    // Drop a marker so we can prove the second clone touched nothing.
    const dest = join(proj, '.claude', 'pipeline', 'example-minimal');
    const marker = join(dest, 'MY-EDIT.md');
    writeFileSync(marker, 'do not clobber me');

    const { code, stderr } = invoke(['example-minimal', '--dir', proj]);
    expect(code).toBe(1);
    expect(stderr).toContain('already exists');
    expect(stderr).toContain('--force');
    // The existing tree is left completely untouched.
    expect(existsSync(marker)).toBe(true);
  });

  test('--force replaces the target cleanly (stale files are gone)', () => {
    const proj = tempProject();
    expect(invoke(['example-minimal', '--dir', proj]).code).toBe(0);
    const dest = join(proj, '.claude', 'pipeline', 'example-minimal');
    const stale = join(dest, 'steps', 'STALE.md');
    writeFileSync(stale, 'left over from a prior clone');

    const { code } = invoke(['example-minimal', '--dir', proj, '--force']);
    expect(code).toBe(0);
    expect(existsSync(join(dest, 'PIPELINE.md'))).toBe(true);
    // rm-before-copy: the stale file must NOT survive the forced re-clone.
    expect(existsSync(stale)).toBe(false);
  });

  test('unknown template errors (exit 2) and lists the available templates', () => {
    const proj = tempProject();
    const { code, stderr } = invoke(['does-not-exist', '--dir', proj]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown template 'does-not-exist'");
    for (const t of TEMPLATES) expect(stderr).toContain(t.name);
    // Nothing was written on the failure path.
    expect(existsSync(join(proj, '.claude'))).toBe(false);
  });

  test('missing template name errors (exit 2) and lists the available templates', () => {
    const { code, stderr } = invoke([]);
    expect(code).toBe(2);
    expect(stderr).toContain('a template <name> is required');
    for (const t of TEMPLATES) expect(stderr).toContain(t.name);
  });

  test('an unknown flag is a loud usage error (exit 2)', () => {
    const { code, stderr } = invoke(['example-minimal', '--bogus']);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown flag '--bogus'");
  });

  test('--list prints every template and exits 0 without writing anything', () => {
    const { code, stdout } = invoke(['--list']);
    expect(code).toBe(0);
    for (const t of TEMPLATES) expect(stdout).toContain(t.name);
  });

  test('--json emits the machine result shape', () => {
    const proj = tempProject();
    const { code, stdout } = invoke(['example-minimal', '--dir', proj, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { cloned: boolean; template: string; files: string[] };
    expect(parsed.cloned).toBe(true);
    expect(parsed.template).toBe('example-minimal');
    expect(parsed.files).toContain('PIPELINE.md');
    expect(parsed.files).toContain('steps/01-prepare.md');
  });

  test('default target is the CURRENT working directory (real subprocess)', () => {
    // The in-process tests all pass --dir; this proves the no-flag default
    // resolves against the process cwd, exactly as a user runs it.
    const proj = tempProject();
    // process.execPath is the bun binary running this test — robust whether or
    // not `bun` is on PATH (spawnSync('bun', …) would need it on PATH).
    const res = spawnSync(process.execPath, [CLI, 'clone', 'example-minimal'], { cwd: proj, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(existsSync(join(proj, '.claude', 'pipeline', 'example-minimal', 'PIPELINE.md'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Template-library validity — guards every FUTURE template PR
// ---------------------------------------------------------------------------

describe('bundled template library', () => {
  test('the registry is non-empty', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
  });

  for (const t of TEMPLATES) {
    describe(`template '${t.name}'`, () => {
      const dir = templateDir(t.name);

      test('lives under the bundled templates/ dir with a valid PIPELINE.md', () => {
        expect(dir.startsWith(TEMPLATES_DIR)).toBe(true);
        expect(existsSync(dir)).toBe(true);
        const manifest = join(dir, 'PIPELINE.md');
        expect(existsSync(manifest)).toBe(true);
        expect(readFileSync(manifest, 'utf8').trim().length).toBeGreaterThan(0);
      });

      test('has a non-empty steps/ folder', () => {
        const steps = join(dir, 'steps');
        expect(existsSync(steps) && statSync(steps).isDirectory()).toBe(true);
        const stepFiles = readdirSync(steps).filter((f) => f.endsWith('.md'));
        expect(stepFiles.length).toBeGreaterThan(0);
      });

      test('plans cleanly (computePlan errors empty, at least one step)', () => {
        const plan = computePlan(dir);
        expect(plan.errors).toEqual([]);
        expect(plan.steps.length).toBeGreaterThan(0);
      });
    });
  }

  test('the description is a non-empty one-liner', () => {
    for (const t of TEMPLATES) {
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(t.description).not.toContain('\n');
    }
  });
});
