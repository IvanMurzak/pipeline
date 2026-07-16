import { test, expect, afterEach } from 'bun:test';
import {
  computeRunIdentity,
  computePipelineContentHash,
  computeProjectFingerprint,
  resolveProjectIdentifier,
  canonicalizeGitRemote,
  collectPipelineFiles,
  formatFingerprint,
  DEFAULT_FINGERPRINT_SALT,
  FINGERPRINT_SALT_ENV,
} from '../src/lib/run-identity';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Scaffolding — fixture pipelines under the OS temp dir (portable across the
// Windows dev box and the Linux CI runner; never hardcode a platform path).
// ---------------------------------------------------------------------------

const TMP_ROOT = tmpdir();
const created: string[] = [];

/** Create a fresh temp pipeline dir and write `files` (POSIX-relative keys). */
function makePipeline(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(TMP_ROOT, 'run-identity-'));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** The POSIX-normalized absolute path (what the fingerprint falls back to). */
function posixAbs(p: string): string {
  return resolve(p).split(sep).join('/');
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

const HEX64 = /^[0-9a-f]{64}$/;

// ===========================================================================
// Pipeline content hash — determinism
// ===========================================================================

test('content hash: deterministic — same tree hashes the same, twice', () => {
  const root = makePipeline({
    'PIPELINE.md': '# manifest\n',
    'steps/01-a.md': 'step a\n',
    'steps/02-b.md': 'step b\n',
    'scripts/run.py': 'print("hi")\n',
  });
  const h1 = computePipelineContentHash(root);
  const h2 = computePipelineContentHash(root);
  expect(h1).toBe(h2);
  expect(h1).toMatch(HEX64);
});

test('content hash: two byte-identical trees (created independently) hash equal', () => {
  const spec = {
    'PIPELINE.md': '# m\n',
    'steps/01-a.md': 'a\n',
    'scripts/x.py': 'x\n',
  };
  expect(computePipelineContentHash(makePipeline(spec))).toBe(
    computePipelineContentHash(makePipeline(spec)),
  );
});

// ===========================================================================
// Order-independence — enumeration order must not affect the hash
// ===========================================================================

test('content hash: order-independent (fs enumeration order is irrelevant)', () => {
  const root = makePipeline({
    'PIPELINE.md': '# m\n',
    'steps/01-a.md': 'a\n',
    'steps/02-b.md': 'b\n',
    'scripts/z.py': 'z\n',
    'scripts/a.py': 'aa\n',
  });
  const files = collectPipelineFiles(root); // absolute, already sorted
  const forward = computePipelineContentHash(root, { listFiles: () => [...files] });
  const reversed = computePipelineContentHash(root, { listFiles: () => [...files].reverse() });
  const shuffled = computePipelineContentHash(root, {
    listFiles: () => [files[2]!, files[0]!, files[4]!, files[1]!, files[3]!],
  });
  expect(forward).toBe(reversed);
  expect(forward).toBe(shuffled);
  // ...and equals the default fs-walk hash.
  expect(forward).toBe(computePipelineContentHash(root));
});

// ===========================================================================
// Sensitivity — content, rename, and scripts/ additions all change the hash
// ===========================================================================

test('content hash: editing a step file changes the hash', () => {
  const a = makePipeline({ 'PIPELINE.md': 'm', 'steps/01.md': 'version one' });
  const b = makePipeline({ 'PIPELINE.md': 'm', 'steps/01.md': 'version two' });
  expect(computePipelineContentHash(a)).not.toBe(computePipelineContentHash(b));
});

test('content hash: editing PIPELINE.md changes the hash', () => {
  const a = makePipeline({ 'PIPELINE.md': 'manifest v1', 'steps/01.md': 's' });
  const b = makePipeline({ 'PIPELINE.md': 'manifest v2', 'steps/01.md': 's' });
  expect(computePipelineContentHash(a)).not.toBe(computePipelineContentHash(b));
});

test('content hash: adding a scripts/ file changes the hash', () => {
  const base = makePipeline({ 'PIPELINE.md': 'm', 'steps/01.md': 's' });
  const withScript = makePipeline({
    'PIPELINE.md': 'm',
    'steps/01.md': 's',
    'scripts/new.py': 'print(1)',
  });
  expect(computePipelineContentHash(base)).not.toBe(computePipelineContentHash(withScript));
});

test('content hash: a rename (same bytes, different path) changes the hash', () => {
  const a = makePipeline({ 'PIPELINE.md': 'm', 'steps/01-old.md': 'identical body' });
  const b = makePipeline({ 'PIPELINE.md': 'm', 'steps/01-new.md': 'identical body' });
  expect(computePipelineContentHash(a)).not.toBe(computePipelineContentHash(b));
});

test('content hash: moving a file between steps/ and scripts/ changes the hash', () => {
  const a = makePipeline({ 'PIPELINE.md': 'm', 'steps/helper.py': 'x' });
  const b = makePipeline({ 'PIPELINE.md': 'm', 'scripts/helper.py': 'x' });
  expect(computePipelineContentHash(a)).not.toBe(computePipelineContentHash(b));
});

// ===========================================================================
// CRLF/LF — normalization is ON by default (OS/checkout stability); documented
// escape hatch to hash raw bytes.
// ===========================================================================

test('content hash: CRLF and LF hash EQUAL by default (line-ending-stable)', () => {
  const lf = makePipeline({ 'PIPELINE.md': 'a\nb\n', 'steps/01.md': 'x\ny\n' });
  const crlf = makePipeline({ 'PIPELINE.md': 'a\r\nb\r\n', 'steps/01.md': 'x\r\ny\r\n' });
  expect(computePipelineContentHash(lf)).toBe(computePipelineContentHash(crlf));
});

test('content hash: normalizeEol:false makes CRLF and LF hash DIFFERENTLY', () => {
  const lf = makePipeline({ 'PIPELINE.md': 'a\nb\n' });
  const crlf = makePipeline({ 'PIPELINE.md': 'a\r\nb\r\n' });
  expect(computePipelineContentHash(lf, { normalizeEol: false })).not.toBe(
    computePipelineContentHash(crlf, { normalizeEol: false }),
  );
});

test('content hash: a lone CR (no LF) is preserved even when normalizing', () => {
  // Only CRLF collapses; a stray 0x0D not followed by 0x0A must survive, so a
  // file that differs ONLY by a lone CR still hashes differently.
  const withCr = makePipeline({ 'PIPELINE.md': 'a\rb' });
  const without = makePipeline({ 'PIPELINE.md': 'ab' });
  expect(computePipelineContentHash(withCr)).not.toBe(computePipelineContentHash(without));
});

// ===========================================================================
// Empty pipeline root — stable constant, never a throw
// ===========================================================================

test('content hash: an empty pipeline root yields a stable constant (no throw)', () => {
  const e1 = makePipeline({});
  const e2 = makePipeline({});
  const h = computePipelineContentHash(e1);
  expect(h).toMatch(HEX64);
  expect(h).toBe(computePipelineContentHash(e2));
  // Hash of the empty manifest == sha256("") — the well-known empty digest.
  expect(h).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

// ===========================================================================
// collectPipelineFiles — exactly the defining trees, sorted by POSIX rel path
// ===========================================================================

test('collectPipelineFiles: PIPELINE.md + steps/** + scripts/**, sorted by rel', () => {
  const root = makePipeline({
    'PIPELINE.md': 'm',
    'steps/02-b.md': 'b',
    'steps/01-a.md': 'a',
    'steps/sub/03-c.md': 'c',
    'scripts/z.py': 'z',
    'README.md': 'ignored — not a defining file',
    'notes.md': 'ignored — sits at root, not a defining tree',
  });
  const rels = collectPipelineFiles(root).map((abs) => abs.slice(root.length + 1).split(sep).join('/'));
  expect(rels).toEqual([
    'PIPELINE.md',
    'scripts/z.py',
    'steps/01-a.md',
    'steps/02-b.md',
    'steps/sub/03-c.md',
  ]);
});

// ===========================================================================
// Project fingerprint — determinism, salt/identifier sensitivity, non-leakage
// ===========================================================================

test('fingerprint: deterministic for the same (identifier, salt)', () => {
  const id = 'github.com/acme/private-api';
  expect(computeProjectFingerprint(id, 'salt-A')).toBe(computeProjectFingerprint(id, 'salt-A'));
});

test('fingerprint: salt-sensitive — a different salt yields a different hash', () => {
  const id = 'github.com/acme/private-api';
  expect(computeProjectFingerprint(id, 'salt-A')).not.toBe(computeProjectFingerprint(id, 'salt-B'));
});

test('fingerprint: identifier-sensitive — a different project yields a different hash', () => {
  expect(computeProjectFingerprint('proj-one', 'k')).not.toBe(computeProjectFingerprint('proj-two', 'k'));
});

test('fingerprint: non-leaking — the raw path/name never appears in the output', () => {
  const secretPath = 'C:/Users/topsecret/clients/acme-private-repo';
  const fp = computeProjectFingerprint(secretPath, 'k');
  expect(fp).toMatch(HEX64);
  expect(fp).not.toContain('topsecret');
  expect(fp).not.toContain('acme-private-repo');
  expect(fp).not.toContain(secretPath);
});

// ===========================================================================
// formatFingerprint — the `fp:` framing + label sanitization
// ===========================================================================

test('formatFingerprint: bare `fp:<hex>` with no label', () => {
  expect(formatFingerprint('a'.repeat(64))).toBe('fp:' + 'a'.repeat(64));
});

test('formatFingerprint: `fp:<label>:<hex>` and label sanitization (delimiter-safe)', () => {
  const hex = 'b'.repeat(64);
  // A stray colon (our delimiter) or whitespace in the label cannot break the
  // `fp:<label>:<hex>` framing — collapsed to `-`.
  expect(formatFingerprint(hex, 'Acme Corp: api')).toBe(`fp:Acme-Corp-api:${hex}`);
  expect(formatFingerprint(hex, 'acme-api')).toBe(`fp:acme-api:${hex}`);
});

// ===========================================================================
// resolveProjectIdentifier — git remote (canonicalized) else absolute path
// ===========================================================================

test('canonicalizeGitRemote: scp-like and https forms canonicalize identically', () => {
  const canon = 'github.com/org/name';
  expect(canonicalizeGitRemote('git@github.com:Org/Name.git')).toBe(canon);
  expect(canonicalizeGitRemote('https://github.com/Org/Name.git')).toBe(canon);
  expect(canonicalizeGitRemote('ssh://git@github.com/Org/Name.git')).toBe(canon);
  // Embedded credentials are stripped (privacy) — never travel into the id.
  expect(canonicalizeGitRemote('https://user:token@github.com/Org/Name.git')).toBe(canon);
});

test('resolveProjectIdentifier: injected remote is used and canonicalized', () => {
  expect(resolveProjectIdentifier('C:/proj', { gitRemoteUrl: 'git@github.com:o/n.git' })).toBe(
    'github.com/o/n',
  );
});

test('resolveProjectIdentifier: canonicalize:false keeps the raw remote', () => {
  expect(
    resolveProjectIdentifier('C:/proj', {
      gitRemoteUrl: 'git@github.com:o/n.git',
      canonicalize: false,
    }),
  ).toBe('git@github.com:o/n.git');
});

test('resolveProjectIdentifier: reads origin url from injected .git/config text', () => {
  const cfg = '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:o/n.git\n\tfetch = +refs\n';
  expect(resolveProjectIdentifier('C:/proj', { readGitConfig: () => cfg })).toBe('github.com/o/n');
});

test('resolveProjectIdentifier: no remote → POSIX-normalized absolute path fallback', () => {
  expect(resolveProjectIdentifier('C:/proj/sub', { gitRemoteUrl: null })).toBe(posixAbs('C:/proj/sub'));
  // A missing config (reader returns null) also falls back to the path.
  expect(resolveProjectIdentifier('C:/proj/sub', { readGitConfig: () => null })).toBe(
    posixAbs('C:/proj/sub'),
  );
});

// ===========================================================================
// computeRunIdentity — the composed entry: wire round-trip, determinism, salt
// ===========================================================================

function fixture(): string {
  return makePipeline({
    'PIPELINE.md': '# manifest\n',
    'steps/01-a.md': 'a\n',
    'steps/02-b.md': 'b\n',
    'scripts/run.py': 'print(1)\n',
  });
}

test('computeRunIdentity: wire fields match the cloud shapes + length caps', () => {
  const id = computeRunIdentity({ pipelineRoot: fixture(), projectIdentifier: 'github.com/o/n', salt: 'k' });

  // pipeline_version === runs.pipeline_version (<=200): `sha256:<64hex>`.
  expect(id.pipeline_version).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(id.pipeline_version.length).toBeLessThanOrEqual(200);
  expect(id.pipeline_version).toBe('sha256:' + id.pipelineContentHash);

  // project_fingerprint === runs.project_fingerprint (<=500): `fp:<64hex>`.
  expect(id.project_fingerprint).toMatch(/^fp:[0-9a-f]{64}$/);
  expect(id.project_fingerprint.length).toBeLessThanOrEqual(500);
  expect(id.project_fingerprint).toBe(id.projectFingerprint);
  expect(id.project_fingerprint).toBe(formatFingerprint(id.projectFingerprintHash));

  // The hashed file list is the sorted defining set.
  expect(id.hashedFiles).toEqual(['PIPELINE.md', 'scripts/run.py', 'steps/01-a.md', 'steps/02-b.md']);
});

test('computeRunIdentity: deterministic for identical inputs', () => {
  const root = fixture();
  const a = computeRunIdentity({ pipelineRoot: root, projectIdentifier: 'id', salt: 'k' });
  const b = computeRunIdentity({ pipelineRoot: root, projectIdentifier: 'id', salt: 'k' });
  expect(a).toEqual(b);
});

test('computeRunIdentity: fingerprint non-leaking through the composed entry', () => {
  const secret = 'C:/Users/topsecret/private-thing';
  const id = computeRunIdentity({ pipelineRoot: fixture(), projectIdentifier: secret, salt: 'k' });
  expect(id.project_fingerprint.startsWith('fp:')).toBe(true);
  expect(id.project_fingerprint).not.toContain('topsecret');
  expect(id.project_fingerprint).not.toContain(secret);
});

test('computeRunIdentity: optional visibleLabel produces `fp:<label>:<hex>`', () => {
  const id = computeRunIdentity({
    pipelineRoot: fixture(),
    projectIdentifier: 'github.com/acme/api',
    salt: 'k',
    visibleLabel: 'acme-api',
  });
  expect(id.project_fingerprint).toMatch(/^fp:acme-api:[0-9a-f]{64}$/);
  // The label is cosmetic framing only — the underlying hash is label-independent.
  const bare = computeRunIdentity({
    pipelineRoot: fixture(),
    projectIdentifier: 'github.com/acme/api',
    salt: 'k',
  });
  expect(id.projectFingerprintHash).toBe(bare.projectFingerprintHash);
});

test('computeRunIdentity: salt precedence — explicit > env > default constant', () => {
  const root = fixture();
  const idn = 'github.com/o/n';

  // env salt is used when no explicit salt is given.
  const viaEnv = computeRunIdentity({
    pipelineRoot: root,
    projectIdentifier: idn,
    env: { [FINGERPRINT_SALT_ENV]: 'env-salt' },
  });
  expect(viaEnv.projectFingerprintHash).toBe(computeProjectFingerprint(idn, 'env-salt'));

  // explicit salt overrides env.
  const viaExplicit = computeRunIdentity({
    pipelineRoot: root,
    projectIdentifier: idn,
    salt: 'real-salt',
    env: { [FINGERPRINT_SALT_ENV]: 'env-salt' },
  });
  expect(viaExplicit.projectFingerprintHash).toBe(computeProjectFingerprint(idn, 'real-salt'));

  // neither → the documented default constant.
  const viaDefault = computeRunIdentity({ pipelineRoot: root, projectIdentifier: idn, env: {} });
  expect(viaDefault.projectFingerprintHash).toBe(computeProjectFingerprint(idn, DEFAULT_FINGERPRINT_SALT));
});

test('computeRunIdentity: resolves the identifier from projectPath when none is given', () => {
  const id = computeRunIdentity({
    pipelineRoot: fixture(),
    projectPath: 'C:/proj',
    salt: 'k',
    identifier: { gitRemoteUrl: 'git@github.com:o/n.git' },
  });
  expect(id.projectIdentifier).toBe('github.com/o/n');
  expect(id.projectFingerprintHash).toBe(computeProjectFingerprint('github.com/o/n', 'k'));
});
