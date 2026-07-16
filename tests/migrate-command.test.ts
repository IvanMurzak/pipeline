// T1-18 — the `pipeline migrate` command: --dry-run writes nothing, the
// plan-lint gate ABORTS with no partial write, successful migrations write
// atomically and pass real plan-lint, and the subcommand routes through cli.ts.

import { test, expect, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrate, type MigrateDeps } from '../src/commands/migrate';
import { EXAMPLE_MIGRATIONS, EXAMPLE_CURRENT } from '../src/lib/migrate/example-transform';
import type { PipelineFiles } from '../src/lib/migrate';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const PIPE_V1 = [
  '---',
  'format: 1',
  'execution: sequential',
  'x-legacy-flag: enabled',
  'title: Example Migration Corpus',
  '---',
  '# Example Migration Corpus',
  '',
  'A synthetic pipeline used only by T1-18 migration tests.',
  '',
].join('\n');

const STEP = ['---', 'step_id: only-step', '---', '# Only Step', '', 'Do the thing.', ''].join('\n');

function makePipeline(manifest = PIPE_V1): string {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-migrate-'));
  created.push(root);
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), manifest);
  writeFileSync(join(root, 'steps', '01-only-step.md'), STEP);
  return root;
}

const olderMap = (): PipelineFiles => ({ 'PIPELINE.md': PIPE_V1, 'steps/01-only-step.md': STEP });

/** Run runMigrate with captured stdout/stderr. */
function run(args: string[], deps: MigrateDeps = {}): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = runMigrate(args, { stdout: (s) => (out += s), stderr: (s) => (err += s), ...deps });
  return { code, out, err };
}

const example = { registry: EXAMPLE_MIGRATIONS, current: EXAMPLE_CURRENT };

// ── usage (exit 2) ───────────────────────────────────────────────────────────

test('usage: --to is required', () => {
  const r = run(['--root', makePipeline()]);
  expect(r.code).toBe(2);
  expect(r.err).toContain('--to <N> is required');
});

test('usage: unknown argument', () => {
  const r = run(['--to', '1', '--bogus']);
  expect(r.code).toBe(2);
  expect(r.err).toContain("unknown argument '--bogus'");
});

test('usage: non-integer --to', () => {
  const r = run(['--to', 'abc', '--root', makePipeline()]);
  expect(r.code).toBe(2);
  expect(r.err).toContain('--to expects a positive integer');
});

test('usage: dir without a PIPELINE.md (injected exists=false) is exit 2', () => {
  const r = run(['--to', '1', '--root', '/no/pipeline/here'], { exists: () => false });
  expect(r.code).toBe(2);
  expect(r.err).toContain('no PIPELINE.md');
});

// ── nothing-to-do / guards through the real command ──────────────────────────

test('nothing-to-do: --to 1 on a format-1 pipeline (empty production ladder) exits 0, writes nothing', () => {
  const root = makePipeline();
  const before = readFileSync(join(root, 'PIPELINE.md'), 'utf8');
  const r = run(['--to', '1', '--root', root]);
  expect(r.code).toBe(0);
  expect(r.out).toContain('already at format 1');
  expect(readFileSync(join(root, 'PIPELINE.md'), 'utf8')).toBe(before);
});

test('guard: --to a too-new format (production current=1) is exit 1 with a clear message', () => {
  const root = makePipeline();
  const r = run(['--to', '2', '--root', root]);
  expect(r.code).toBe(1);
  expect(r.err.toLowerCase()).toContain('newer pipeline format');
  expect(readFileSync(join(root, 'PIPELINE.md'), 'utf8')).toBe(PIPE_V1); // untouched
});

// ── --dry-run writes NOTHING ─────────────────────────────────────────────────

test('--dry-run: prints the diff and writes nothing (real fs unchanged)', () => {
  const root = makePipeline();
  const before = readFileSync(join(root, 'PIPELINE.md'), 'utf8');
  const r = run(['--to', '3', '--dry-run', '--root', root], example);
  expect(r.code).toBe(0);
  expect(r.out).toContain('--- a/PIPELINE.md');
  expect(r.out).toContain('x-final-flag');
  expect(r.out).toContain('[dry-run] no files written');
  // Byte-for-byte unchanged on disk.
  expect(readFileSync(join(root, 'PIPELINE.md'), 'utf8')).toBe(before);
});

test('--dry-run: never calls the write seam (injected fs stays untouched)', () => {
  const r = run(['--to', '3', '--dry-run', '--root', '/virtual'], {
    ...example,
    exists: () => true,
    loadFiles: () => olderMap(),
    lint: () => ({ errors: [], warnings: [] }),
    writeFiles: () => {
      throw new Error('write seam must not run during --dry-run');
    },
  });
  expect(r.code).toBe(0);
  expect(r.out).toContain('[dry-run] no files written');
});

test('--dry-run --json: machine-readable, no writes', () => {
  const r = run(['--to', '3', '--dry-run', '--json', '--root', makePipeline()], example);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.dryRun).toBe(true);
  expect(j.from).toBe(1);
  expect(j.to).toBe(3);
  expect(j.wrote).toEqual([]);
  expect(j.applied.map((a: any) => `${a.from}->${a.to}`)).toEqual(['1->2', '2->3']);
});

// ── successful migration: atomic write + passes REAL plan-lint ────────────────

test('migrate: writes the migrated tree atomically and passes real plan-lint', () => {
  const root = makePipeline();
  const stepBefore = readFileSync(join(root, 'steps', '01-only-step.md'), 'utf8');
  const r = run(['--to', '3', '--root', root], example);
  expect(r.code).toBe(0);
  expect(r.out).toContain('wrote 1 file');

  const after = readFileSync(join(root, 'PIPELINE.md'), 'utf8');
  expect(after).toContain('format: 3');
  expect(after).toContain('x-final-flag: enabled');
  expect(after).toContain('x-v2-extra: default');
  expect(after).not.toContain('x-legacy-flag');
  // The untouched step file is byte-identical, and no .tmp residue is left.
  expect(readFileSync(join(root, 'steps', '01-only-step.md'), 'utf8')).toBe(stepBefore);
  expect(existsSync(join(root, 'PIPELINE.md.pipeline-migrate.tmp'))).toBe(false);
});

// ── plan-lint gate ABORTS with no partial write ──────────────────────────────

test('plan-lint abort: a result that fails real plan-lint aborts, writing nothing', () => {
  const root = makePipeline();
  const before = readFileSync(join(root, 'PIPELINE.md'), 'utf8');
  // A bad rung whose `up` deletes the only step → computePlan reports an error.
  const badReg = [
    {
      from: 1,
      to: 2,
      up: (f: PipelineFiles) => {
        const c = { ...f };
        delete c['steps/01-only-step.md'];
        return c;
      },
      down: (f: PipelineFiles) => f,
    },
  ];
  const r = run(['--to', '2', '--root', root], { registry: badReg, current: 2 });
  expect(r.code).toBe(1);
  expect(r.err).toContain('ABORTED');
  expect(r.err.toLowerCase()).toContain('plan-lint');
  // Nothing was written or deleted: manifest untouched, step still present.
  expect(readFileSync(join(root, 'PIPELINE.md'), 'utf8')).toBe(before);
  expect(existsSync(join(root, 'steps', '01-only-step.md'))).toBe(true);
});

test('plan-lint abort: never reaches the write seam (injected lint failure)', () => {
  const r = run(['--to', '3', '--root', '/virtual'], {
    ...example,
    exists: () => true,
    loadFiles: () => olderMap(),
    lint: () => ({ errors: ['synthetic lint failure'], warnings: [] }),
    writeFiles: () => {
      throw new Error('write seam must not run after a lint abort');
    },
  });
  expect(r.code).toBe(1);
  expect(r.err).toContain('ABORTED');
  expect(r.err).toContain('synthetic lint failure');
});

// ── cli.ts routing (subprocess) ──────────────────────────────────────────────

test('cli routing: `pipeline migrate` with no --to is a usage error (exit 2)', () => {
  const r = spawnSync(process.execPath, [CLI, 'migrate'], { encoding: 'utf8' });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain('--to <N> is required');
}, 30000);

test('cli routing: `pipeline migrate --to 1` on a format-1 pipeline exits 0 (noop)', () => {
  const root = makePipeline();
  const r = spawnSync(process.execPath, [CLI, 'migrate', '--to', '1', '--root', root], {
    encoding: 'utf8',
    cwd: root,
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('already at format 1');
}, 30000);

test('cli routing: `migrate` appears in the top-level usage', () => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('migrate --to <N>');
}, 30000);
