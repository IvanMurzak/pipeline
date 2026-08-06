import { test, expect, afterEach, describe } from 'bun:test';
import { runHash, type HashCommandDeps } from '../src/commands/hash';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { realFs } from '../src/lib/cloud-config';
import { computeProjectFingerprint, resolveProjectIdentifier, DEFAULT_FINGERPRINT_SALT } from '../src/lib/run-identity';

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

// ===========================================================================
// `--project` — b15: the REAL production entry point for `computeRunIdentity`'s
// project-fingerprint half (07-security.md T16/SG13). Everything here goes
// through `runHash` itself — the actual dispatched command — not `resolveSalt`
// or `computeRunIdentity` directly, so a regression in the WIRING (not just
// the library) shows up here.
// ===========================================================================

/** Capture stdout/stderr around `fn`, always restoring the real writers. */
function capture(fn: () => number): { code: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((s: string) => {
    stdout += s;
    return true;
  }) as any;
  process.stderr.write = ((s: string) => {
    stderr += s;
    return true;
  }) as any;
  try {
    const code = fn();
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

/** A scratch per-install-salt home, isolated from this dev machine's REAL
 *  `%APPDATA%\claude-pipeline` — PIPELINE_CLOUD_HOME is the override every
 *  `cloud-config.ts#credentialDir` caller respects (see `fingerprint-
 *  salt.test.ts`'s own module doc for why this matters: omitting it once
 *  wrote a real file into this dev box's actual credential directory). */
function scratchDeps(home: string, overrides: Partial<HashCommandDeps> = {}): HashCommandDeps {
  return {
    fs: realFs,
    platform: 'linux',
    env: { PIPELINE_CLOUD_HOME: home },
    homedir: home,
    ...overrides,
  };
}

function mkScratchHome(): string {
  const d = mkdtempSync(join(TMP_ROOT, 'hash-salt-home-'));
  created.push(d);
  return d;
}

describe('hash command: --project (b15 real wiring)', () => {
  test('--project requires --json (usage error, exit 2)', () => {
    const root = makePipeline({ 'PIPELINE.md': '# m\n' });
    const { code, stderr } = capture(() => runHash(['--root', root, '--project', root]));
    expect(code).toBe(2);
    expect(stderr).toContain('--project requires --json');
  });

  test('--label without --project is a usage error, exit 2', () => {
    const root = makePipeline({ 'PIPELINE.md': '# m\n' });
    const { code, stderr } = capture(() => runHash(['--root', root, '--json', '--label', 'x']));
    expect(code).toBe(2);
    expect(stderr).toContain('--label requires --project');
  });

  test('--project --json includes project_fingerprint alongside content_hash', () => {
    const root = makePipeline({ 'PIPELINE.md': '# m\n' });
    const home = mkScratchHome();
    const { code, stdout, stderr } = capture(() =>
      runHash(['--root', root, '--project', root, '--json'], scratchDeps(home)),
    );
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const result = JSON.parse(stdout);
    expect(result.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.project_fingerprint).toMatch(/^fp:[0-9a-f]{64}$/);
  });

  test(
    'WIRING PROOF: the REAL entry point fingerprints under the per-install secret, ' +
      'not the public DEFAULT_FINGERPRINT_SALT — proven by comparing against an ' +
      'independent computation, not by reading resolveSalt internals',
    () => {
      const root = makePipeline({ 'PIPELINE.md': '# m\n' });
      const home = mkScratchHome();
      const { code, stdout } = capture(() =>
        runHash(['--root', root, '--project', root, '--json'], scratchDeps(home)),
      );
      expect(code).toBe(0);
      const result = JSON.parse(stdout);

      // Independently compute what the PUBLIC constant would have produced for
      // this exact project path — the CLI's own fallback, and what every prior
      // (pre-b15) release would have shipped.
      const identifier = resolveProjectIdentifier(root, { gitRemoteUrl: null });
      const publicConstantFingerprint =
        'fp:' + computeProjectFingerprint(identifier, DEFAULT_FINGERPRINT_SALT);

      // MUTATION-PROVABLE: if `runHash` stopped resolving/threading the
      // install salt (e.g. reverted to calling computeRunIdentity without
      // `installSalt`), this assertion is exactly what would go red.
      expect(result.project_fingerprint).not.toBe(publicConstantFingerprint);
    },
  );

  test('two different install-salt homes produce two different fingerprints for the SAME project', () => {
    const root = makePipeline({ 'PIPELINE.md': '# m\n' });
    const homeA = mkScratchHome();
    const homeB = mkScratchHome();
    const a = capture(() => runHash(['--root', root, '--project', root, '--json'], scratchDeps(homeA)));
    const b = capture(() => runHash(['--root', root, '--project', root, '--json'], scratchDeps(homeB)));
    expect(JSON.parse(a.stdout).project_fingerprint).not.toBe(JSON.parse(b.stdout).project_fingerprint);
  });

  test('the SAME install-salt home reuses the SAME fingerprint across invocations', () => {
    const root = makePipeline({ 'PIPELINE.md': '# m\n' });
    const home = mkScratchHome();
    const deps = scratchDeps(home);
    const first = capture(() => runHash(['--root', root, '--project', root, '--json'], deps));
    const second = capture(() => runHash(['--root', root, '--project', root, '--json'], deps));
    expect(JSON.parse(first.stdout).project_fingerprint).toBe(JSON.parse(second.stdout).project_fingerprint);
  });

  test('PIPELINE_FINGERPRINT_SALT env still wins over the per-install secret, through the real entry point', () => {
    const root = makePipeline({ 'PIPELINE.md': '# m\n' });
    const home = mkScratchHome();
    const deps = scratchDeps(home, { env: { PIPELINE_CLOUD_HOME: home, PIPELINE_FINGERPRINT_SALT: 'pinned-salt' } });
    const { stdout } = capture(() => runHash(['--root', root, '--project', root, '--json'], deps));
    const identifier = resolveProjectIdentifier(root, { gitRemoteUrl: null });
    const expected = 'fp:' + computeProjectFingerprint(identifier, 'pinned-salt');
    expect(JSON.parse(stdout).project_fingerprint).toBe(expected);
  });

  test('--label produces `fp:<label>:<hex>` through the real entry point', () => {
    const root = makePipeline({ 'PIPELINE.md': '# m\n' });
    const home = mkScratchHome();
    const { stdout } = capture(() =>
      runHash(['--root', root, '--project', root, '--json', '--label', 'acme-api'], scratchDeps(home)),
    );
    expect(JSON.parse(stdout).project_fingerprint).toMatch(/^fp:acme-api:[0-9a-f]{64}$/);
  });

  test('NEVER UPLOADED: the resolved install salt itself never appears in stdout', () => {
    const root = makePipeline({ 'PIPELINE.md': '# m\n' });
    const home = mkScratchHome();
    const deps = scratchDeps(home);
    // Prime the salt file first so we can read back the RAW secret and assert
    // its absence, independent of the command under test.
    const primed = capture(() => runHash(['--root', root, '--project', root, '--json'], deps));
    const saltFilePath = join(home, 'fingerprint-salt.json');
    const rawSalt = (JSON.parse(readFileSync(saltFilePath, 'utf-8')) as { salt: string }).salt;
    expect(rawSalt).toMatch(/^[0-9a-f]{64}$/);
    expect(primed.stdout).not.toContain(rawSalt);
  });

  test('when --project is omitted, output is unchanged (no project_fingerprint key at all)', () => {
    const root = makePipeline({ 'PIPELINE.md': '# m\n' });
    const { stdout } = capture(() => runHash(['--root', root, '--json']));
    const result = JSON.parse(stdout);
    expect(result).toEqual({ content_hash: result.content_hash });
    expect('project_fingerprint' in result).toBe(false);
  });
});
