// Tests for `pipeline department new` + `pipeline department validate`
// (src/commands/department.ts — simplified-onboarding task a8).
//
// Organized around a8's Definition of Done:
//  1. `new` in a folder with existing content adds EXACTLY one file.
//  2. `new <name>`, `--force`, and `--from-pipeline` are each covered.
//  3. `validate` reproduces the design's own worked transcript byte-for-byte
//     on the error COUNT (05 §4 / 02 §4's "1 error, 1 warning" sample), exits
//     1, then 0 once the stated error is fixed.
//  4. An unknown top-level key validates with a warning and exit 0.
//  5. `--json`'s shape for both commands.
// Plus the negative controls each box needs to mean something (a `new` that
// always overwrote would trivially pass "adds one file"; a `validate` that
// never returned 1 would trivially pass "then 0 once fixed").

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDepartment, runDepartmentNew, runDepartmentValidate } from '../src/commands/department';
import { copyTemplateTree } from '../src/lib/templates';
import {
  DEPARTMENT_MANIFEST_FILENAME,
  ENGINES,
  parseDepartmentManifest,
  readDepartmentManifest,
} from '../src/lib/department-manifest';
// x51: the parity test below drives the SAME predicate `serve` binds on, so
// "validate says yes / serve says no" cannot come back for a second field.
import { runtimeBindingFor } from '../src/lib/department-serve';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const created: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'department-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

/** Every file under `root`, POSIX-relative, sorted — for "adds exactly one
 *  file" style assertions. */
function listFilesRel(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), childRel);
      else out.push(childRel);
    }
  };
  walk(root, '');
  return out.sort();
}

/** Capture stdout/stderr around a runXxx(args) call, like clone.test.ts does. */
function invoke(fn: (args: string[]) => number, args: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((s: string) => ((stdout += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((stderr += s), true)) as typeof process.stderr.write;
  try {
    const code = fn(args);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const newCmd = (args: string[]) => invoke(runDepartmentNew, args);
const validateCmd = (args: string[]) => invoke(runDepartmentValidate, args);

/** A PIPELINE.md whose `## Scope` uses the BULLETED `- In:`/`- Out:` marker
 *  form (as opposed to the bare `In:`/`Out:` form all three bundled templates
 *  use — both forms parse identically since x9). Used to exercise the
 *  Scope.In-driven half of `--from-pipeline`'s prefill.
 */
function writeScopedPipeline(pipelineRoot: string): void {
  mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
  writeFileSync(
    join(pipelineRoot, 'PIPELINE.md'),
    `# Pipeline: unity-review

## End State

A concise architectural review of the Unity project, with a prioritized list
of risks.

## Scope

- In: static analysis of C# scripts and prefabs, risk prioritization.
- Out: writing code changes, running the Unity editor.

## Project Context

- Root: the Unity project this pipeline runs in.

## Invariants

- Read-only: never edits project files.
`,
  );
  writeFileSync(
    join(pipelineRoot, 'steps', '01-scan.md'),
    `# Step: scan\n\n## Task\n\nScan the project.\n\n## Next\n\nPipeline complete.\n`,
  );
}

// ---------------------------------------------------------------------------
// `new` — DoD box 1: adds exactly one file
// ---------------------------------------------------------------------------

describe('pipeline department new — adds exactly one file', () => {
  test('in a folder with existing content, writes ONLY department.yml', () => {
    const proj = tempProject();
    writeFileSync(join(proj, 'README.md'), '# an existing project\n');
    mkdirSync(join(proj, 'src'), { recursive: true });
    writeFileSync(join(proj, 'src', 'index.ts'), 'export {};\n');
    const before = listFilesRel(proj);

    const { code } = newCmd(['--dir', proj]);
    expect(code).toBe(0);

    const after = listFilesRel(proj);
    const added = after.filter((f) => !before.includes(f));
    expect(added).toEqual([DEPARTMENT_MANIFEST_FILENAME]);
    // Untouched: the pre-existing files are byte-identical.
    expect(readFileSync(join(proj, 'README.md'), 'utf8')).toBe('# an existing project\n');
    expect(readFileSync(join(proj, 'src', 'index.ts'), 'utf8')).toBe('export {};\n');
  });

  test('creates NO .claude/, README, or starter agent (D3)', () => {
    const proj = tempProject();
    newCmd(['--dir', proj]);
    expect(existsSync(join(proj, '.claude'))).toBe(false);
    expect(listFilesRel(proj)).toEqual([DEPARTMENT_MANIFEST_FILENAME]);
  });

  test('the scaffold is 05 §2\'s minimum-viable-file SHAPE: apiVersion, name, description, one skill, runtime.engine — nothing else', () => {
    const proj = tempProject();
    newCmd(['--dir', proj]);
    const { manifest } = readDepartmentManifest(join(proj, DEPARTMENT_MANIFEST_FILENAME));
    expect(manifest).not.toBeNull();
    expect(manifest!.skills).toHaveLength(1);
    expect(manifest!.runtime.engine).toBe('claude-code');
    expect(manifest!.runtime.pipelineRoot).toBeUndefined();
    expect(manifest!.displayName).toBe(manifest!.name); // never written -> defaults to name
  });

  test('name is prefilled from the (slugified) folder name', () => {
    const proj = tempProject();
    const named = join(proj, 'My Unity Project');
    mkdirSync(named, { recursive: true });
    newCmd(['--dir', named]);
    const { manifest } = readDepartmentManifest(join(named, DEPARTMENT_MANIFEST_FILENAME));
    expect(manifest!.name).toBe('my-unity-project');
  });
});

// ---------------------------------------------------------------------------
// `new <name>`
// ---------------------------------------------------------------------------

describe('pipeline department new <name>', () => {
  test('creates ./<name>/department.yml with name prefilled from <name>', () => {
    const proj = tempProject();
    const { code, stdout } = newCmd(['unity-review', '--dir', proj]);
    expect(code).toBe(0);
    const manifestPath = join(proj, 'unity-review', DEPARTMENT_MANIFEST_FILENAME);
    expect(existsSync(manifestPath)).toBe(true);
    const { manifest } = readDepartmentManifest(manifestPath);
    expect(manifest!.name).toBe('unity-review');
    expect(stdout).toContain('department.yml created');
  });

  test('refuses to write into an already-occupied <name> folder without --force', () => {
    const proj = tempProject();
    mkdirSync(join(proj, 'unity-review'), { recursive: true });
    writeFileSync(join(proj, 'unity-review', 'UNRELATED.txt'), 'pre-existing');

    const { code, stderr } = newCmd(['unity-review', '--dir', proj]);
    expect(code).toBe(1);
    expect(stderr).toContain('not empty');
    expect(stderr).toContain('--force');
    expect(existsSync(join(proj, 'unity-review', DEPARTMENT_MANIFEST_FILENAME))).toBe(false);
  });

  test('--force writes into the occupied folder anyway, without touching its other content', () => {
    const proj = tempProject();
    mkdirSync(join(proj, 'unity-review'), { recursive: true });
    writeFileSync(join(proj, 'unity-review', 'UNRELATED.txt'), 'pre-existing');

    const { code } = newCmd(['unity-review', '--dir', proj, '--force']);
    expect(code).toBe(0);
    expect(existsSync(join(proj, 'unity-review', DEPARTMENT_MANIFEST_FILENAME))).toBe(true);
    expect(readFileSync(join(proj, 'unity-review', 'UNRELATED.txt'), 'utf8')).toBe('pre-existing');
  });

  test('the bare (no-name) `new` never applies this non-empty-folder refusal — only <name> does', () => {
    // Negative control for the asymmetry the header comment documents:
    // an ordinary project folder full of unrelated files must NOT be refused.
    const proj = tempProject();
    for (let i = 0; i < 5; i++) writeFileSync(join(proj, `file-${i}.txt`), 'x');
    expect(newCmd(['--dir', proj]).code).toBe(0);
  });

  test('a <name> colliding with an existing FILE (not a directory) is refused even with --force', () => {
    const proj = tempProject();
    writeFileSync(join(proj, 'unity-review'), 'i am a file, not a folder');
    const { code, stderr } = newCmd(['unity-review', '--dir', proj, '--force']);
    expect(code).toBe(1);
    expect(stderr).toContain('not a directory');
  });
});

// ---------------------------------------------------------------------------
// `--force` (overwriting an existing department.yml — 05 §3)
// ---------------------------------------------------------------------------

describe('pipeline department new --force', () => {
  test('refuses to overwrite an existing department.yml without --force', () => {
    const proj = tempProject();
    expect(newCmd(['--dir', proj]).code).toBe(0);
    writeFileSync(join(proj, DEPARTMENT_MANIFEST_FILENAME), 'name: hand-edited\n');

    const { code, stderr } = newCmd(['--dir', proj]);
    expect(code).toBe(1);
    expect(stderr).toContain('already exists');
    expect(stderr).toContain('--force');
    // Untouched.
    expect(readFileSync(join(proj, DEPARTMENT_MANIFEST_FILENAME), 'utf8')).toBe('name: hand-edited\n');
  });

  test('--force replaces it cleanly', () => {
    const proj = tempProject();
    expect(newCmd(['--dir', proj]).code).toBe(0);
    writeFileSync(join(proj, DEPARTMENT_MANIFEST_FILENAME), 'name: hand-edited\n');

    const { code } = newCmd(['--dir', proj, '--force']);
    expect(code).toBe(0);
    const text = readFileSync(join(proj, DEPARTMENT_MANIFEST_FILENAME), 'utf8');
    expect(text).not.toBe('name: hand-edited\n');
    expect(text).toContain('apiVersion:');
  });
});

// ---------------------------------------------------------------------------
// `--from-pipeline`
// ---------------------------------------------------------------------------

describe('pipeline department new --from-pipeline', () => {
  test('prefills description from End State, writes engine: pipeline + pipelineRoot + startIteration, and validates with ZERO errors', () => {
    const proj = tempProject();
    const pipelineRoot = join(proj, '.claude', 'pipeline', 'unity-review');
    writeScopedPipeline(pipelineRoot);

    const { code } = newCmd(['--from-pipeline', 'unity-review', '--dir', proj]);
    expect(code).toBe(0);

    const manifestPath = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    const { manifest, findings } = readDepartmentManifest(manifestPath);
    expect(manifest).not.toBeNull();
    expect(manifest!.description).toContain('prioritized list');
    expect(manifest!.runtime.engine).toBe('pipeline');
    expect(manifest!.runtime.pipelineRoot).toBe('.claude/pipeline/unity-review');
    expect(manifest!.runtime.startIteration).toBe('steps/01-scan.md');
    // A two-field runtime spec (05 §3): pipelineRoot + startIteration only —
    // no command/args/workingDirectory ever invented.
    expect(manifest!.runtime.command).toBeUndefined();
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);

    // Scope.In (bulleted form) drove the SKILL description specifically —
    // distinct from the department description (End State).
    expect(manifest!.skills[0]!.description).toContain('static analysis');
    expect(manifest!.skills[0]!.description).not.toBe(manifest!.description);

    // "no editing" — validate agrees.
    const v = validateCmd(['--file', manifestPath]);
    expect(v.code).toBe(0);
  });

  test('a bundled template (bare In:/Out: markers) drives the skill description from Scope.In, not End State (x9)', () => {
    const proj = tempProject();
    copyTemplateTree('support-answer', join(proj, '.claude', 'pipeline', 'support-answer'));

    const { code } = newCmd(['--from-pipeline', 'support-answer', '--dir', proj]);
    expect(code).toBe(0);
    const { manifest } = readDepartmentManifest(join(proj, DEPARTMENT_MANIFEST_FILENAME));
    expect(manifest!.description).toContain('grounded answer');
    // Since x9, support-answer's bare `In:` marker parses, so the skill
    // description comes from Scope.In (not the End-State fallback).
    expect(manifest!.skills[0]!.description).toContain('BM25 retrieval');
    expect(manifest!.skills[0]!.description).not.toBe(manifest!.description);
    // Validates cleanly.
    expect(validateCmd(['--file', join(proj, DEPARTMENT_MANIFEST_FILENAME)]).code).toBe(0);
  });

  test('gracefully falls back to End State for the skill description when a pipeline has no Scope section at all', () => {
    const proj = tempProject();
    const pipelineRoot = join(proj, '.claude', 'pipeline', 'no-scope');
    mkdirSync(join(pipelineRoot, 'steps'), { recursive: true });
    writeFileSync(
      join(pipelineRoot, 'PIPELINE.md'),
      `# Pipeline: no-scope\n\n## End State\n\nA concise architectural review, with a prioritized list of risks.\n\n## Project Context\n\n- Root: any project.\n`,
    );
    writeFileSync(
      join(pipelineRoot, 'steps', '01-scan.md'),
      `# Step: scan\n\n## Task\n\nScan the project.\n\n## Next\n\nPipeline complete.\n`,
    );

    const { code } = newCmd(['--from-pipeline', 'no-scope', '--dir', proj]);
    expect(code).toBe(0);
    const { manifest } = readDepartmentManifest(join(proj, DEPARTMENT_MANIFEST_FILENAME));
    expect(manifest!.description).toContain('prioritized list');
    // No `## Scope` section at all → scope_in is empty → true End-State fallback.
    expect(manifest!.skills[0]!.description).toBe(manifest!.description);
    // Validates cleanly — the fallback never leaves a schema hole.
    expect(validateCmd(['--file', join(proj, DEPARTMENT_MANIFEST_FILENAME)]).code).toBe(0);
  });

  test('an unknown pipeline name is refused (exit 1), nothing written', () => {
    const proj = tempProject();
    const { code, stderr } = newCmd(['--from-pipeline', 'does-not-exist', '--dir', proj]);
    expect(code).toBe(1);
    expect(stderr).toContain("no pipeline named 'does-not-exist'");
    expect(existsSync(join(proj, DEPARTMENT_MANIFEST_FILENAME))).toBe(false);
  });

  test('a positional <name> still controls the FOLDER + yaml name; --from-pipeline only supplies content', () => {
    const proj = tempProject();
    writeScopedPipeline(join(proj, '.claude', 'pipeline', 'unity-review'));
    const { code } = newCmd(['my-dept', '--from-pipeline', 'unity-review', '--dir', proj]);
    expect(code).toBe(0);
    const manifestPath = join(proj, 'my-dept', DEPARTMENT_MANIFEST_FILENAME);
    const { manifest } = readDepartmentManifest(manifestPath);
    expect(manifest!.name).toBe('my-dept');
    expect(manifest!.runtime.engine).toBe('pipeline');
    // pipelineRoot is relative to THIS manifest's own (nested) directory.
    expect(manifest!.runtime.pipelineRoot).toBe('../.claude/pipeline/unity-review');
  });

  test('a conflicting explicit --engine is a usage error (exit 2), nothing written', () => {
    const proj = tempProject();
    writeScopedPipeline(join(proj, '.claude', 'pipeline', 'unity-review'));
    const { code, stderr } = newCmd(['--from-pipeline', 'unity-review', '--engine', 'process', '--dir', proj]);
    expect(code).toBe(2);
    expect(stderr).toContain('--from-pipeline');
    expect(existsSync(join(proj, DEPARTMENT_MANIFEST_FILENAME))).toBe(false);
  });

  test('--engine pipeline (redundant, non-conflicting) is accepted', () => {
    const proj = tempProject();
    writeScopedPipeline(join(proj, '.claude', 'pipeline', 'unity-review'));
    const { code } = newCmd(['--from-pipeline', 'unity-review', '--engine', 'pipeline', '--dir', proj]);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// `--engine`
// ---------------------------------------------------------------------------

describe('pipeline department new --engine', () => {
  test('defaults to claude-code', () => {
    const proj = tempProject();
    newCmd(['--dir', proj]);
    const { manifest } = readDepartmentManifest(join(proj, DEPARTMENT_MANIFEST_FILENAME));
    expect(manifest!.runtime.engine).toBe('claude-code');
  });

  test('accepts every registered engine', () => {
    for (const engine of ['claude-code', 'pipeline', 'process', 'container']) {
      const proj = tempProject();
      const { code } = newCmd(['--dir', proj, '--engine', engine]);
      expect(code, engine).toBe(0);
      const { manifest } = readDepartmentManifest(join(proj, DEPARTMENT_MANIFEST_FILENAME));
      expect(manifest!.runtime.engine).toBe(engine);
    }
  });

  test('an unsupported engine is a usage error (exit 2) naming every supported engine', () => {
    const proj = tempProject();
    const { code, stderr } = newCmd(['--dir', proj, '--engine', 'codex']);
    expect(code).toBe(2);
    expect(stderr).toContain("unsupported --engine 'codex'");
    for (const engine of ['claude-code', 'pipeline', 'process', 'container']) expect(stderr).toContain(engine);
    expect(existsSync(join(proj, DEPARTMENT_MANIFEST_FILENAME))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `new` — usage / --json / --help
// ---------------------------------------------------------------------------

describe('pipeline department new — usage surface', () => {
  test('an unknown flag is a loud usage error (exit 2)', () => {
    const { code, stderr } = newCmd(['--bogus']);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown flag '--bogus'");
  });

  test('a second positional argument is a usage error (exit 2)', () => {
    const { code, stderr } = newCmd(['a', 'b']);
    expect(code).toBe(2);
    expect(stderr).toContain('unexpected extra argument');
  });

  test('--help prints usage and exits 0 without writing anything', () => {
    const proj = tempProject();
    const { code, stdout } = newCmd(['--dir', proj, '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: pipeline department new');
    expect(existsSync(join(proj, DEPARTMENT_MANIFEST_FILENAME))).toBe(false);
  });

  test('--json emits {created, path, name, engine, fromPipeline}', () => {
    const proj = tempProject();
    const { code, stdout } = newCmd(['--dir', proj, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      created: boolean;
      path: string;
      name: string;
      engine: string;
      fromPipeline: string | null;
    };
    expect(parsed.created).toBe(true);
    expect(parsed.path).toBe(join(proj, DEPARTMENT_MANIFEST_FILENAME));
    expect(parsed.engine).toBe('claude-code');
    expect(parsed.fromPipeline).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// `validate` — DoD: exits 1 on the design's sample manifest, 0 once fixed
// ---------------------------------------------------------------------------

/** 05 §4 / 02 §4's OWN worked `validate` transcript, reconstructed: 2 skills
 *  (the second missing a description), no `visibility` — which the design's
 *  transcript renders as exactly "1 error, 1 warning." */
const DESIGN_SAMPLE = `apiVersion: department.ai-pipeline.dev/v1
name: unity-review
description: >-
  Reviews Unity and C# architecture, identifies risks, and produces actionable
  refactoring plans.

skills:
  - id: unity-architecture-review
    name: Unity Architecture Review
    description: Review a Unity project or design proposal for architectural risk.
  - id: save-system-audit
    name: Save System Audit

runtime:
  engine: claude-code
`;

const DESIGN_SAMPLE_FIXED = DESIGN_SAMPLE.replace(
  '    name: Save System Audit\n',
  '    name: Save System Audit\n    description: Track save data across sessions and flag corruption risks.\n',
);

describe('pipeline department validate — the design\'s own sample manifest', () => {
  test('exits 1, reporting exactly 1 error and 1 warning', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(file, DESIGN_SAMPLE);

    const { code, stdout } = validateCmd(['--file', file]);
    expect(code).toBe(1);
    expect(stdout).toContain('1 error, 1 warning.');
    expect(stdout).toContain('skills[1]');
    expect(stdout).toContain('description missing');
    expect(stdout).toContain('visibility');
  });

  test('exits 0 once the stated error (the missing skill description) is fixed', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(file, DESIGN_SAMPLE_FIXED);

    const { code, stdout } = validateCmd(['--file', file]);
    expect(code).toBe(0);
    expect(stdout).toContain('0 errors, 1 warning.'); // visibility warning still stands, and doesn't gate exit
  });

  test('NEGATIVE CONTROL: a manifest with a genuinely set visibility AND both skill descriptions is fully clean (0 errors, 0 warnings)', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(file, `${DESIGN_SAMPLE_FIXED}visibility: organization\n`);

    const { code, stdout } = validateCmd(['--file', file]);
    expect(code).toBe(0);
    expect(stdout).toContain('0 errors, 0 warnings.');
  });
});

// ---------------------------------------------------------------------------
// `validate` — DoD: unknown top-level key -> warning, exit 0
// ---------------------------------------------------------------------------

describe('pipeline department validate — unknown top-level key', () => {
  test('warns and exits 0, never an error', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(
      file,
      `name: d
description: A department that does things for people, in detail.
skills:
  - id: s
    name: S
    description: Does the thing, thoroughly and reliably, every time.
runtime:
  engine: claude-code
futureFeature:
  enabled: true
`,
    );

    const { code, stdout } = validateCmd(['--file', file]);
    expect(code).toBe(0);
    expect(stdout).toContain('futureFeature');
    // Symbol used for warnings is ⚠, never ✗, for this finding specifically.
    expect(stdout).toMatch(/⚠ futureFeature/);
  });
});

// ---------------------------------------------------------------------------
// `validate` — file missing / unparseable -> exit 2
// ---------------------------------------------------------------------------

describe('pipeline department validate — exit 2 class', () => {
  test('a missing file exits 2 and names the fix', () => {
    const proj = tempProject();
    const { code, stderr } = validateCmd(['--file', join(proj, DEPARTMENT_MANIFEST_FILENAME)]);
    expect(code).toBe(2);
    expect(stderr).toContain('pipeline department new');
  });

  test('unparseable YAML exits 2, distinct from exit 1 (errors present)', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(file, 'name: [1, 2\n');
    const { code } = validateCmd(['--file', file]);
    expect(code).toBe(2);
  });

  test('an empty file exits 2', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(file, '');
    expect(validateCmd(['--file', file]).code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// `validate` — Coherence (05 §4 / department-mesh 06-registry §3.1)
// ---------------------------------------------------------------------------

describe('pipeline department validate — coherence', () => {
  test('acceptsMidTaskInput: true with engine: pipeline is an error (pipeline-drive has no stdin)', () => {
    const proj = tempProject();
    writeScopedPipeline(join(proj, '.claude', 'pipeline', 'unity-review'));
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(
      file,
      `name: d
description: A department that runs an existing pipeline for people.
skills:
  - id: s
    name: S
    description: Does the thing, thoroughly and reliably, every time.
runtime:
  engine: pipeline
  pipelineRoot: .claude/pipeline/unity-review
  startIteration: steps/01-scan.md
communication:
  acceptsMidTaskInput: true
`,
    );
    const { code, stdout } = validateCmd(['--file', file]);
    expect(code).toBe(1);
    expect(stdout).toContain('communication.acceptsMidTaskInput');
  });

  test('claude-code honestly declaring its own true capabilities is NOT an error', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(
      file,
      `name: d
description: A department that does things for people, in detail.
skills:
  - id: s
    name: S
    description: Does the thing, thoroughly and reliably, every time.
runtime:
  engine: claude-code
communication:
  acceptsMidTaskInput: true
  supportsStreaming: true
`,
    );
    expect(validateCmd(['--file', file]).code).toBe(0);
  });

  test('an engine with runtime-negotiated capabilities (process) is never flagged for an explicit true', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(
      file,
      `name: d
description: A department that does things for people, in detail.
skills:
  - id: s
    name: S
    description: Does the thing, thoroughly and reliably, every time.
runtime:
  engine: process
  command: ./bin/dept
communication:
  acceptsMidTaskInput: true
`,
    );
    expect(validateCmd(['--file', file]).code).toBe(0);
  });

  test("contextAffinity: required needs a per-context or daemon lifecycle", () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(
      file,
      `name: d
description: A department that does things for people, in detail.
skills:
  - id: s
    name: S
    description: Does the thing, thoroughly and reliably, every time.
runtime:
  engine: claude-code
  lifecycle: per-task
scheduling:
  contextAffinity: required
`,
    );
    const { code, stdout } = validateCmd(['--file', file]);
    expect(code).toBe(1);
    expect(stdout).toContain('scheduling.contextAffinity');

    const okFile = join(proj, 'ok.yml');
    writeFileSync(
      okFile,
      `name: d
description: A department that does things for people, in detail.
skills:
  - id: s
    name: S
    description: Does the thing, thoroughly and reliably, every time.
runtime:
  engine: claude-code
  lifecycle: per-context
scheduling:
  contextAffinity: required
`,
    );
    expect(validateCmd(['--file', okFile]).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// `validate` — Local (an engine: pipeline runtime that does/doesn't point at a real pipeline)
// ---------------------------------------------------------------------------

describe('pipeline department validate — local filesystem facts', () => {
  test('engine: pipeline with no pipelineRoot is an error', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(
      file,
      `name: d
description: A department that does things for people, in detail.
skills:
  - id: s
    name: S
    description: Does the thing, thoroughly and reliably, every time.
runtime:
  engine: pipeline
`,
    );
    const { code, stdout } = validateCmd(['--file', file]);
    expect(code).toBe(1);
    expect(stdout).toContain('runtime.pipelineRoot');
  });

  test('engine: pipeline pointing at a NONEXISTENT folder is an error', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(
      file,
      `name: d
description: A department that does things for people, in detail.
skills:
  - id: s
    name: S
    description: Does the thing, thoroughly and reliably, every time.
runtime:
  engine: pipeline
  pipelineRoot: .claude/pipeline/does-not-exist
`,
    );
    const { code, stdout } = validateCmd(['--file', file]);
    expect(code).toBe(1);
    expect(stdout).toContain('runtime.pipelineRoot');
    expect(stdout).toContain('does not exist');
  });

  test('engine: pipeline pointing at a REAL pipeline is clean', () => {
    const proj = tempProject();
    writeScopedPipeline(join(proj, '.claude', 'pipeline', 'unity-review'));
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(
      file,
      `name: d
description: A department that runs an existing pipeline for people.
skills:
  - id: s
    name: S
    description: Does the thing, thoroughly and reliably, every time.
runtime:
  engine: pipeline
  pipelineRoot: .claude/pipeline/unity-review
  startIteration: steps/01-scan.md
`,
    );
    expect(validateCmd(['--file', file]).code).toBe(0);
  });

  test('a startIteration that does not exist inside a real pipelineRoot is an error', () => {
    const proj = tempProject();
    writeScopedPipeline(join(proj, '.claude', 'pipeline', 'unity-review'));
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(
      file,
      `name: d
description: A department that runs an existing pipeline for people.
skills:
  - id: s
    name: S
    description: Does the thing, thoroughly and reliably, every time.
runtime:
  engine: pipeline
  pipelineRoot: .claude/pipeline/unity-review
  startIteration: steps/99-nope.md
`,
    );
    const { code, stdout } = validateCmd(['--file', file]);
    expect(code).toBe(1);
    expect(stdout).toContain('runtime.startIteration');
  });
});

// ---------------------------------------------------------------------------
// `validate` — Advisory: skill description length, .claude/ present/empty/absent
// ---------------------------------------------------------------------------

describe('pipeline department validate — advisory', () => {
  test('a skill description under 20 characters WARNS (not errors)', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(
      file,
      `name: d
description: A department that does things for people, in detail.
skills:
  - id: s
    name: S
    description: Too short.
runtime:
  engine: claude-code
`,
    );
    const { code, stdout } = validateCmd(['--file', file]);
    expect(code).toBe(0);
    expect(stdout).toContain('very short');
  });

  test('.claude/ absent is NEVER a warning', () => {
    const proj = tempProject();
    newCmd(['--dir', proj]);
    const { stdout } = validateCmd(['--file', join(proj, DEPARTMENT_MANIFEST_FILENAME)]);
    expect(stdout).not.toContain('.claude');
  });

  test('.claude/ present and empty WARNS', () => {
    const proj = tempProject();
    newCmd(['--dir', proj]);
    mkdirSync(join(proj, '.claude'), { recursive: true });
    const { code, stdout } = validateCmd(['--file', join(proj, DEPARTMENT_MANIFEST_FILENAME)]);
    expect(code).toBe(0);
    expect(stdout).toContain('.claude');
    expect(stdout).toContain('present but empty');
  });

  test('.claude/ present and non-empty is reported (found — counts), no warning', () => {
    const proj = tempProject();
    newCmd(['--dir', proj]);
    mkdirSync(join(proj, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(proj, '.claude', 'agents', 'reviewer.md'), '# reviewer\n');
    const { code, stdout } = validateCmd(['--file', join(proj, DEPARTMENT_MANIFEST_FILENAME)]);
    expect(code).toBe(0);
    expect(stdout).toContain('found — 1 agent, 0 skills, 0 pipelines');
    expect(stdout).not.toContain('present but empty');
  });
});

// ---------------------------------------------------------------------------
// `validate` — x51: what `validate` accepts, `serve` can bind
// ---------------------------------------------------------------------------

/** A `pipeline`-engine department whose pipeline really exists on disk, so the
 *  only thing under test is the FIELD, never a missing path. `omit` drops one
 *  `runtime:` key from the file. */
function pipelineDepartment(omit?: 'pipelineRoot' | 'startIteration'): string {
  const proj = tempProject();
  const root = join(proj, '.claude', 'pipeline', 'review');
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), '# Review\n\n## End State\nReviewed.\n');
  writeFileSync(join(root, 'steps', '01-plan.md'), '# Plan\n');
  const lines = [
    'apiVersion: department.ai-pipeline.dev/v1',
    'name: unity-review',
    'description: >-',
    '  Reviews Unity and C# architecture, identifies risks, and produces actionable',
    '  refactoring plans.',
    'visibility: organization',
    '',
    'skills:',
    '  - id: unity-architecture-review',
    '    name: Unity Architecture Review',
    '    description: Review a Unity project or design proposal for architectural risk.',
    '',
    'runtime:',
    '  engine: pipeline',
    ...(omit === 'pipelineRoot' ? [] : ['  pipelineRoot: .claude/pipeline/review']),
    ...(omit === 'startIteration' ? [] : ['  startIteration: steps/01-plan.md']),
    '',
  ];
  const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
  writeFileSync(file, lines.join('\n'));
  return file;
}

describe('validate — x51: a manifest validate accepts is one serve can bind', () => {
  test('a `pipeline` manifest with no runtime.startIteration is an ERROR, not "0 errors"', () => {
    // The reported bug verbatim: this file validated clean and was then
    // refused by `serve`, which needs `--start` to invoke `pipeline drive`.
    const file = pipelineDepartment('startIteration');
    const { code, stdout } = validateCmd(['--file', file]);
    expect(code).toBe(1);
    expect(stdout).toContain('runtime.startIteration');
    expect(stdout).not.toContain('0 errors');
  });

  test('the complete manifest is still clean — the check fires on absence, not on the engine', () => {
    const { code, stdout } = validateCmd(['--file', pipelineDepartment()]);
    expect(code).toBe(0);
    expect(stdout).toContain('0 errors, 0 warnings.');
  });

  test('every required field the registry declares is reported by BOTH validate and serve, with the same sentence', () => {
    // The general form of x51 (and the x32 shape it borrows): written over
    // `ENGINES` rather than over a list of fields, so a required field added
    // to any engine row is covered by this test the moment it lands — and
    // cannot be enforced by one command and ignored by the other.
    for (const def of ENGINES) {
      for (const required of def.requiredRuntimeFields) {
        const proj = tempProject();
        const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
        const runtimeLines = def.requiredRuntimeFields
          .filter((r) => r.field !== required.field)
          .map((r) => `  ${r.field}: ${r.field === 'command' ? './bin/dept' : 'x'}`);
        const text =
          'apiVersion: department.ai-pipeline.dev/v1\n' +
          'name: unity-review\n' +
          'description: A department used to check the required-field contract end to end.\n' +
          'visibility: organization\n\n' +
          'skills:\n' +
          '  - id: one\n' +
          '    name: One\n' +
          '    description: A skill description long enough not to trip the advisory.\n\n' +
          'runtime:\n' +
          `  engine: ${def.engine}\n` +
          (runtimeLines.length > 0 ? `${runtimeLines.join('\n')}\n` : '');
        writeFileSync(file, text);

        // 1. validate reports it, at the severity the registry declares, with
        //    the registry's own sentence.
        const { stdout } = validateCmd(['--file', file, '--json']);
        const parsed = JSON.parse(stdout) as { findings: Array<{ severity: string; field: string; message: string }> };
        const finding = parsed.findings.find((f) => f.field === `runtime.${required.field}`);
        expect(finding, `${def.engine}: validate said nothing about runtime.${required.field}`).toBeDefined();
        expect(finding!.severity).toBe(required.severity);
        expect(finding!.message).toBe(required.why);

        // 2. serve refuses it — whatever the severity — and says the same thing.
        const { manifest } = parseDepartmentManifest(text);
        expect(manifest).not.toBeNull();
        const binding = runtimeBindingFor(manifest!, { manifestDir: proj });
        expect(binding.ok, `${def.engine}: serve accepted a manifest missing runtime.${required.field}`).toBe(false);
        if (binding.ok) return;
        expect(binding.message).toContain(required.why);
      }
    }
  });

  test('validate states what it structurally cannot check, so "0 errors" is never read as "this will serve"', () => {
    const { code, stdout } = validateCmd(['--file', pipelineDepartment()]);
    expect(code).toBe(0);
    expect(stdout).toContain('Not checked here');
    expect(stdout).toContain('pipeline department serve');
    expect(stdout).toContain('pipeline-runner');
  });
});

// ---------------------------------------------------------------------------
// `validate` --json
// ---------------------------------------------------------------------------

describe('pipeline department validate --json', () => {
  test('emits {file, valid, errors, warnings, findings}', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(file, DESIGN_SAMPLE);

    const { code, stdout } = validateCmd(['--file', file, '--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as {
      file: string;
      valid: boolean;
      errors: number;
      warnings: number;
      findings: Array<{ severity: string; field: string; message: string }>;
    };
    expect(parsed.file).toBe(file);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toBe(1);
    expect(parsed.warnings).toBe(1);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings.some((f) => f.severity === 'error' && f.field === 'skills[1]')).toBe(true);
    expect(parsed.findings.some((f) => f.severity === 'warning' && f.field === 'visibility')).toBe(true);
  });

  test('a clean file emits valid:true, errors:0', () => {
    const proj = tempProject();
    const file = join(proj, DEPARTMENT_MANIFEST_FILENAME);
    writeFileSync(file, `${DESIGN_SAMPLE_FIXED}visibility: organization\n`);
    const { code, stdout } = validateCmd(['--file', file, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { valid: boolean; errors: number; warnings: number; notChecked: string[] };
    // x51: `notChecked` rides alongside — a clean file is still exactly
    // `valid: true, 0, 0, []`, but the document now also says what a clean
    // result does NOT establish.
    const { notChecked, ...shape } = parsed;
    expect(shape).toEqual({ file, valid: true, errors: 0, warnings: 0, findings: [] } as never);
    expect(notChecked.length).toBeGreaterThan(0);
  });

  test('the missing-file JSON shape matches the clean-parse shape (same 6 keys)', () => {
    const proj = tempProject();
    const { stdout } = validateCmd(['--file', join(proj, DEPARTMENT_MANIFEST_FILENAME), '--json']);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['errors', 'file', 'findings', 'notChecked', 'valid', 'warnings']);
  });
});

// ---------------------------------------------------------------------------
// `validate` — usage / --help
// ---------------------------------------------------------------------------

describe('pipeline department validate — usage surface', () => {
  test('an unknown flag is a loud usage error (exit 2)', () => {
    const { code, stderr } = validateCmd(['--bogus']);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown flag '--bogus'");
  });

  test('--help prints usage and exits 0', () => {
    const { code, stdout } = validateCmd(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: pipeline department validate');
  });
});

// ---------------------------------------------------------------------------
// The `department` dispatcher
// ---------------------------------------------------------------------------

/** The dispatcher became `async` when a9 added `serve` (the only verb that
 *  awaits anything). Same capture idiom as `invoke`, one `await` deeper. */
async function invokeAsync(
  fn: (args: string[]) => Promise<number>,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((s: string) => ((stdout += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((stderr += s), true)) as typeof process.stderr.write;
  try {
    const code = await fn(args);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('pipeline department — verb dispatch', () => {
  test('routes new/validate', async () => {
    const proj = tempProject();
    expect((await invokeAsync(runDepartment, ['new', '--dir', proj])).code).toBe(0);
    expect((await invokeAsync(runDepartment, ['validate', '--file', join(proj, DEPARTMENT_MANIFEST_FILENAME)])).code).toBe(
      0,
    );
  });

  test('no verb / unknown verb -> usage error (exit 2)', async () => {
    const err1 = await invokeAsync(runDepartment, []);
    expect(err1.code).toBe(2);
    expect(err1.stderr).toContain('a verb is required');

    const err2 = await invokeAsync(runDepartment, ['publish']);
    expect(err2.code).toBe(2);
    expect(err2.stderr).toContain("unknown verb 'publish'");
    // Every verb the dispatcher DOES route is named in the same line.
    expect(err2.stderr).toContain('serve');
  });

  test('routes serve (a9) — its usage errors come from serve itself', async () => {
    // `--bogus` is rejected before `serve` touches the filesystem, the network
    // or a subprocess, so this exercises the routing without any real I/O.
    const err = await invokeAsync(runDepartment, ['serve', '--bogus']);
    expect(err.code).toBe(2);
    expect(err.stderr).toContain('pipeline department serve: unknown flag');
  });
});

// ---------------------------------------------------------------------------
// Round-trip sanity: parseDepartmentManifest never trips on new's own output
// ---------------------------------------------------------------------------

describe('round-trip: new -> parseDepartmentManifest', () => {
  test('every value written survives a real Bun.YAML parse exactly', () => {
    const proj = tempProject();
    // Colons are illegal in a Windows path, so exercise the OTHER
    // YAML-hazardous characters a folder name can legitimately carry
    // (ampersand, quotes, unicode) without also testing filesystem legality.
    const weirdDir = join(proj, "Weird Name & — 'quotes' éè");
    mkdirSync(weirdDir, { recursive: true });
    const { code } = newCmd(['--dir', weirdDir]);
    expect(code).toBe(0);
    const text = readFileSync(join(weirdDir, DEPARTMENT_MANIFEST_FILENAME), 'utf8');
    const { manifest, findings } = parseDepartmentManifest(text);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(manifest!.name).toBe('weird-name-quotes');
  });
});
