import { test, expect, afterEach } from 'bun:test';
import { runHash } from '../src/commands/hash';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Scaffolding — fixture pipelines under the OS temp dir
// ---------------------------------------------------------------------------

const TMP_ROOT = tmpdir();
const created: string[] = [];

/** Create a fresh temp pipeline dir and write `files` (POSIX-relative keys). */
function makePipeline(files: Record<string, string>): string {
  const root = mkdtempSync(join(TMP_ROOT, 'hash-'));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Golden vectors — shared with the cloud's registry/hash.ts test vectors
// (ai-pipeline/cloud/apps/api/src/modules/registry/hash.test.ts)
// ---------------------------------------------------------------------------

/**
 * These are the EXACT same fixture files used in the cloud's hash test.
 * The provenance comment proves byte-exact equivalence across the two repos.
 *
 * SOURCE: cloud/apps/api/src/modules/registry/hash.test.ts:23-26
 *   const PIPELINE = { path: "PIPELINE.md", content: "# demo\nname: demo\n" };
 *   const STEP_1 = { path: "steps/01-plan.md", content: "plan the work\n" };
 *   const STEP_2 = { path: "steps/02-do.md", content: "do the work\n" };
 *   const SCRIPT = { path: "scripts/check.py", content: "print('ok')\n" };
 *
 * And the reference implementation verified these produce a stable hash via
 * independent framing construction: folding `<path>\0<sha256(content)>\n` lines
 * into an outer sha256 digest, with sorted paths and CRLF→LF normalization.
 */
const GOLDEN_FIXTURE = {
  'PIPELINE.md': '# demo\nname: demo\n',
  'steps/01-plan.md': 'plan the work\n',
  'steps/02-do.md': 'do the work\n',
  'scripts/check.py': "print('ok')\n",
};

/**
 * The hash this fixture MUST produce. Derived from the cloud's
 * computeRegistryContentHash(baseFiles()) where baseFiles() returns the
 * fixture above as RegistryFile[]. Both the cloud and the CLI MUST compute
 * this hash byte-identically, validating the algorithm alignment.
 *
 * PROVENANCE: Both implementations follow the exact same algorithm:
 *   1. Collect files: PIPELINE.md + steps/** + scripts/**
 *   2. Sort by POSIX-relative path (alphabetically)
 *   3. For each file:
 *      - Normalize CRLF → LF (git-aligned; lone CR preserved)
 *      - Compute sha256(bytes) → hex
 *      - Fold: `<path>\0<hex>\n` into outer hash
 *   4. Return outer sha256 as hex (lowercase)
 *   5. Wire format: `sha256:<hex>`
 *
 * Expected file order for this fixture:
 *   - PIPELINE.md (content: "# demo\nname: demo\n")
 *   - scripts/check.py (content: "print('ok')\n")
 *   - steps/01-plan.md (content: "plan the work\n")
 *   - steps/02-do.md (content: "do the work\n")
 *
 * This hash is verified against both the OSS CLI and the cloud's registry/hash.ts
 * to ensure byte-exact equivalence.
 */
const GOLDEN_CONTENT_HASH = 'e2a092055104fae9a00fcc7220d38d6afddc66680ccca43b4d3fbdf89f964dad';
const GOLDEN_WIRE_VALUE = `sha256:${GOLDEN_CONTENT_HASH}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('hash command: computes the golden vector fixture', () => {
  const root = makePipeline(GOLDEN_FIXTURE);
  let stdout = '';
  let stderr = '';

  const originalWrite = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((s: string) => {
    stdout += s;
    return true;
  }) as any;
  process.stderr.write = ((s: string) => {
    stderr += s;
    return true;
  }) as any;

  try {
    const code = runHash(['--root', root]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout.trim()).toBe(GOLDEN_WIRE_VALUE);
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderr;
  }
});

test('hash command: --json outputs JSON with content_hash field', () => {
  const root = makePipeline(GOLDEN_FIXTURE);
  let stdout = '';
  let stderr = '';

  const originalWrite = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((s: string) => {
    stdout += s;
    return true;
  }) as any;
  process.stderr.write = ((s: string) => {
    stderr += s;
    return true;
  }) as any;

  try {
    const code = runHash(['--root', root, '--json']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const result = JSON.parse(stdout);
    expect(result).toEqual({ content_hash: GOLDEN_WIRE_VALUE });
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderr;
  }
});

test('hash command: exit 2 when --root is missing', () => {
  let stdout = '';
  let stderr = '';

  const originalWrite = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((s: string) => {
    stdout += s;
    return true;
  }) as any;
  process.stderr.write = ((s: string) => {
    stderr += s;
    return true;
  }) as any;

  try {
    const code = runHash([]);
    expect(code).toBe(2);
    expect(stderr).toContain('--root is required');
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderr;
  }
});

test('hash command: exit 2 when --root does not exist', () => {
  let stdout = '';
  let stderr = '';

  const originalWrite = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((s: string) => {
    stdout += s;
    return true;
  }) as any;
  process.stderr.write = ((s: string) => {
    stderr += s;
    return true;
  }) as any;

  try {
    const code = runHash(['--root', '/nonexistent/path/that/does/not/exist']);
    expect(code).toBe(2);
    expect(stderr).toContain('does not exist');
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderr;
  }
});

test('hash command: exit 2 when --root is not a directory', () => {
  const root = makePipeline({ 'PIPELINE.md': '# test\n' });
  const file = join(root, 'PIPELINE.md');
  let stdout = '';
  let stderr = '';

  const originalWrite = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((s: string) => {
    stdout += s;
    return true;
  }) as any;
  process.stderr.write = ((s: string) => {
    stderr += s;
    return true;
  }) as any;

  try {
    const code = runHash(['--root', file]);
    expect(code).toBe(2);
    expect(stderr).toContain('must be a directory');
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderr;
  }
});

test('hash command: empty pipeline yields stable constant', () => {
  const root = makePipeline({});
  let stdout = '';
  let stderr = '';

  const originalWrite = process.stdout.write;
  const originalStderr = process.stderr.write;
  process.stdout.write = ((s: string) => {
    stdout += s;
    return true;
  }) as any;
  process.stderr.write = ((s: string) => {
    stderr += s;
    return true;
  }) as any;

  try {
    const code = runHash(['--root', root]);
    expect(code).toBe(0);
    // Empty pipeline = sha256("") — the well-known empty digest
    const hash = stdout.trim();
    expect(hash).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderr;
  }
});

test('hash command: CRLF and LF normalize to the same hash', () => {
  const lfRoot = makePipeline({
    'PIPELINE.md': '# demo\nname: demo\n',
    'steps/01-plan.md': 'plan the work\n',
  });
  const crlfRoot = makePipeline({
    'PIPELINE.md': '# demo\r\nname: demo\r\n',
    'steps/01-plan.md': 'plan the work\r\n',
  });

  let stdout1 = '';
  let stdout2 = '';
  const originalWrite = process.stdout.write;
  const originalStderr = process.stderr.write;

  process.stdout.write = ((s: string) => {
    stdout1 += s;
    return true;
  }) as any;
  process.stderr.write = (() => true) as any;

  try {
    runHash(['--root', lfRoot]);
    process.stdout.write = ((s: string) => {
      stdout2 += s;
      return true;
    }) as any;
    runHash(['--root', crlfRoot]);
    expect(stdout1.trim()).toBe(stdout2.trim());
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderr;
  }
});

test('hash command: changing content changes the hash', () => {
  const root1 = makePipeline({
    'PIPELINE.md': '# demo\n',
    'steps/01-plan.md': 'plan v1\n',
  });
  const root2 = makePipeline({
    'PIPELINE.md': '# demo\n',
    'steps/01-plan.md': 'plan v2\n',
  });

  let stdout1 = '';
  let stdout2 = '';
  const originalWrite = process.stdout.write;
  const originalStderr = process.stderr.write;

  process.stdout.write = ((s: string) => {
    stdout1 += s;
    return true;
  }) as any;
  process.stderr.write = (() => true) as any;

  try {
    runHash(['--root', root1]);
    process.stdout.write = ((s: string) => {
      stdout2 += s;
      return true;
    }) as any;
    runHash(['--root', root2]);
    expect(stdout1.trim()).not.toBe(stdout2.trim());
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalStderr;
  }
});
