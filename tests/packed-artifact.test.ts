// Regression guard for a release-blocking npm-packaging bug (found by the
// env-variables design's live e2e gate): the published @baizor/pipeline
// tarball crashed `pipeline drive` at import time because
// lib/step-transcripts.ts reached OUTSIDE the package root into the sibling
// apps/pipeline-ui app — a directory the npm tarball never contains (`bin`
// points at `src/cli.ts` verbatim; only apps/pipeline-cli itself is
// published). The fix vendors the needed pipeline-ui functions into
// lib/vendor/transcript-walk.ts (see its header for the lockstep contract).
//
// This test packs the CLI for real (`bun pm pack`) and extracts it OUTSIDE
// this repo entirely (a fresh os.tmpdir() dir, never a subdirectory of the
// monorepo) so no relative import can accidentally resolve back into the
// checkout — the same way an npm-installed user's `node_modules` would look.
// It is the ONLY test in the suite that exercises the actual published
// artifact rather than the source tree; keep it in its own file (slow: packs
// + spawns two `bun` subprocesses) so a regression here can't hide inside an
// otherwise-green fast unit file.
//
// If you ever reintroduce a package-escaping relative import anywhere in
// this CLI's import graph, THIS test is what turns that red — the source
// tree the rest of the suite runs is not restrictive enough to catch it, and
// CI running from a full checkout is exactly why the bug shipped unnoticed.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

const PKG_ROOT = join(import.meta.dir, '..');
const PKG_JSON = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
  version: string;
};

let workDir: string;
/** The packed artifact's root (the tarball's `package/` dir) — OUTSIDE the
 *  repo tree, so it stands in for a real npm/bun global install. */
let extractedRoot: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pipeline-cli-pack-'));

  const pack = spawnSync('bun', ['pm', 'pack', '--quiet', '--destination', workDir], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
  });
  if (pack.status !== 0) {
    throw new Error(`bun pm pack failed (exit ${pack.status}):\n${pack.stdout}\n${pack.stderr}`);
  }
  const tarball = readdirSync(workDir).find((f) => f.endsWith('.tgz'));
  if (!tarball) {
    throw new Error(`bun pm pack produced no .tgz in ${workDir}. stdout:\n${pack.stdout}\nstderr:\n${pack.stderr}`);
  }

  const extract = spawnSync('tar', ['-xzf', tarball], { cwd: workDir, encoding: 'utf8' });
  if (extract.status !== 0) {
    throw new Error(`tar extraction failed (exit ${extract.status}):\n${extract.stdout}\n${extract.stderr}`);
  }
  // npm/bun tarballs always nest their content under a top-level `package/`.
  extractedRoot = join(workDir, 'package');
}, 60_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** Every relative `from '...'` specifier in a `.ts` file's import/export
 *  statements, resolved against that file's own directory. Regex-based (not a
 *  full parser) is fine here: it only needs to catch the `../../../pipeline-ui`
 *  shape, and false negatives on exotic syntax just mean this static check is
 *  belt-and-suspenders on top of the dynamic load in the tests below. */
function relativeImportSpecs(fileText: string): string[] {
  const specs: string[] = [];
  const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fileText)) !== null) specs.push(m[1]);
  return specs;
}

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
}

describe('packed npm artifact (@baizor/pipeline)', () => {
  test('no shipped source file has a relative import escaping the package root', () => {
    // The actual bug class this whole test file guards against: a relative
    // import specifier that resolves OUTSIDE extractedRoot (like the old
    // `'../../../pipeline-ui/transcript-stats'` from src/lib/step-transcripts.ts)
    // 404s for every npm/bun install, since the tarball contains nothing but
    // this package. Statically scanning every shipped .ts file catches this
    // class of regression ANYWHERE in the import graph — not just in the one
    // command path (`drive`) the dynamic checks below happen to exercise.
    const files: string[] = [];
    walkTsFiles(join(extractedRoot, 'src'), files);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const spec of relativeImportSpecs(text)) {
        const resolved = resolve(dirname(file), spec);
        const relToRoot = relative(extractedRoot, resolved);
        if (relToRoot === '..' || relToRoot.startsWith(`..${sep}`)) {
          offenders.push(`${relative(extractedRoot, file)}: '${spec}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the vendored transcript-walk module shipped in the tarball', () => {
    expect(existsSync(join(extractedRoot, 'src', 'lib', 'vendor', 'transcript-walk.ts'))).toBe(true);
  });

  test('the bundled clone templates shipped in the tarball', () => {
    // `pipeline clone` reads templates from `<pkg>/templates/…` at runtime
    // (src/lib/templates.ts resolves them relative to its own dir). The package
    // declares no `files` allowlist, so they ship by default — but if a future
    // restrictive `files` field ever dropped them, `clone` would 404 for every
    // npm/bun install. This asserts the example template is actually present in
    // the packed artifact, exactly where clone will look for it.
    const tmplRoot = join(extractedRoot, 'templates', 'example-minimal');
    expect(existsSync(join(tmplRoot, 'PIPELINE.md'))).toBe(true);
    expect(existsSync(join(tmplRoot, 'steps'))).toBe(true);
    expect(readdirSync(join(tmplRoot, 'steps')).some((f) => f.endsWith('.md'))).toBe(true);
  });

  test("the support-answer template's scripts/ and sample-docs/ shipped in the tarball", () => {
    // support-answer is the first template with scripts/ and sample-docs/
    // subtrees — asset kinds example-minimal has none of. `clone` copies the
    // WHOLE folder, so a bare `pipeline clone support-answer` run must find the
    // BM25 script AND the bundled corpus it defaults to; a future restrictive
    // `files` field (or a stray .gitignore) that dropped either would break the
    // turnkey run while the example-minimal check above stayed green. Assert
    // both subtrees are present exactly where clone + the script will look.
    const root = join(extractedRoot, 'templates', 'support-answer');
    expect(existsSync(join(root, 'PIPELINE.md'))).toBe(true);
    expect(existsSync(join(root, 'scripts', 'bm25_retrieve.ts'))).toBe(true);
    const docs = readdirSync(join(root, 'sample-docs')).filter((f) => f.endsWith('.md'));
    expect(docs.length).toBeGreaterThan(0);
  });

  test('`pipeline --version` reports package.json\'s version from the packed artifact', () => {
    const res = spawnSync('bun', [join(extractedRoot, 'src', 'cli.ts'), '--version'], {
      cwd: extractedRoot,
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(PKG_JSON.version);
  });

  test('`pipeline drive`\'s import graph loads outside the repo (fails on usage, not module resolution)', () => {
    // No --root/--run-id: runDrive's own arg validation is the very FIRST
    // thing it does once invoked — reaching it proves every static import at
    // the top of commands/drive.ts (including lib/step-transcripts.ts's
    // transitive import of lib/vendor/transcript-walk.ts) resolved cleanly.
    // Before the fix this crashed with "Cannot find module
    // '../../../pipeline-ui/transcript-stats'" and never reached here.
    const res = spawnSync('bun', [join(extractedRoot, 'src', 'cli.ts'), 'drive'], {
      cwd: extractedRoot,
      encoding: 'utf8',
    });
    expect(res.stderr).not.toContain('Cannot find module');
    expect(res.stderr).toContain('--root and --run-id are required');
    expect(res.status).toBe(2);
  });
});
