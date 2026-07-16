import { test, expect, afterEach } from 'bun:test';
import {
  bumpSemver,
  resolvePluginRoot,
  performRelease,
  runRelease,
} from '../src/commands/release';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function makePluginDir(manifestText: string): string {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-release-'));
  created.push(root);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), manifestText);
  return root;
}

const MANIFEST = [
  '{',
  '  "name": "pipeline",',
  '  "version": "0.56.0",',
  '  "description": "Long-chain AI workflows",',
  '  "keywords": [',
  '    "pipeline",',
  '    "workflow"',
  '  ]',
  '}',
  '',
].join('\n');

/** Capture process.stdout/stderr writes around a call. */
function captured(fn: () => number): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: (s: string | Uint8Array) => boolean }).write = (s) => {
    out += String(s);
    return true;
  };
  (process.stderr as { write: (s: string | Uint8Array) => boolean }).write = (s) => {
    err += String(s);
    return true;
  };
  try {
    return { code: fn(), out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ---------------------------------------------------------------------------
// bumpSemver
// ---------------------------------------------------------------------------

test('bumpSemver: patch bumps the last component', () => {
  expect(bumpSemver('0.56.0', 'patch')).toBe('0.56.1');
  expect(bumpSemver('1.2.9', 'patch')).toBe('1.2.10');
});

test('bumpSemver: minor bumps the middle component and zeroes patch', () => {
  expect(bumpSemver('0.56.3', 'minor')).toBe('0.57.0');
  expect(bumpSemver('1.9.9', 'minor')).toBe('1.10.0');
});

test('bumpSemver: major bumps the first component and zeroes the rest', () => {
  expect(bumpSemver('0.56.3', 'major')).toBe('1.0.0');
  expect(bumpSemver('12.4.7', 'major')).toBe('13.0.0');
});

test('bumpSemver: throws on non-semver input', () => {
  expect(() => bumpSemver('1.2', 'patch')).toThrow('not a semver');
  expect(() => bumpSemver('1.2.3-beta.1', 'patch')).toThrow('not a semver');
  expect(() => bumpSemver('v1.2.3', 'patch')).toThrow('not a semver');
  expect(() => bumpSemver('abc', 'minor')).toThrow('not a semver');
  expect(() => bumpSemver('', 'major')).toThrow('not a semver');
});

// ---------------------------------------------------------------------------
// resolvePluginRoot
// ---------------------------------------------------------------------------

test('resolvePluginRoot: explicit --plugin-root wins when it holds a manifest', () => {
  const root = makePluginDir(MANIFEST);
  expect(resolvePluginRoot(root, undefined, '/nowhere')).toBe(root);
});

test('resolvePluginRoot: explicit root without a manifest resolves to null (no fallback)', () => {
  const empty = mkdtempSync(join(tmpdir(), 'pipeline-release-empty-'));
  created.push(empty);
  const real = makePluginDir(MANIFEST);
  // Even with a valid env fallback available, explicit is used as-is.
  expect(resolvePluginRoot(empty, real, real)).toBeNull();
});

test('resolvePluginRoot: falls back to CLAUDE_PLUGIN_ROOT env', () => {
  const root = makePluginDir(MANIFEST);
  expect(resolvePluginRoot(undefined, root, '/nowhere')).toBe(root);
});

test('resolvePluginRoot: walks up from startDir when explicit + env are absent', () => {
  const root = makePluginDir(MANIFEST);
  const deep = join(root, 'apps', 'pipeline-cli', 'src', 'commands');
  mkdirSync(deep, { recursive: true });
  expect(resolvePluginRoot(undefined, undefined, deep)).toBe(root);
});

test('resolvePluginRoot: null when nothing resolves', () => {
  const empty = mkdtempSync(join(tmpdir(), 'pipeline-release-none-'));
  created.push(empty);
  expect(resolvePluginRoot(undefined, undefined, empty)).toBeNull();
});

// ---------------------------------------------------------------------------
// performRelease (filesystem)
// ---------------------------------------------------------------------------

test('performRelease: patch bump rewrites ONLY the version value, preserving formatting', () => {
  const root = makePluginDir(MANIFEST);
  const report = performRelease(root, 'patch', false);
  expect(report).toEqual({
    status: 'bumped',
    old_version: '0.56.0',
    new_version: '0.56.1',
    plugin_json: join(root, '.claude-plugin', 'plugin.json'),
  });
  const after = readFileSync(report.plugin_json, 'utf-8');
  // Byte-identical apart from the version value: 2-space indent, key order,
  // and the trailing newline all survive.
  expect(after).toBe(MANIFEST.replace('"version": "0.56.0"', '"version": "0.56.1"'));
  expect(after.endsWith('\n')).toBe(true);
});

test('performRelease: minor and major levels', () => {
  const root = makePluginDir(MANIFEST);
  expect(performRelease(root, 'minor', false).new_version).toBe('0.57.0');
  expect(performRelease(root, 'major', false).new_version).toBe('1.0.0');
});

test('performRelease: --dry-run reports the bump but writes nothing', () => {
  const root = makePluginDir(MANIFEST);
  const report = performRelease(root, 'minor', true);
  expect(report.status).toBe('dry-run');
  expect(report.old_version).toBe('0.56.0');
  expect(report.new_version).toBe('0.57.0');
  expect(readFileSync(report.plugin_json, 'utf-8')).toBe(MANIFEST);
});

test('performRelease: non-semver version is a clean error', () => {
  const root = makePluginDir(MANIFEST.replace('0.56.0', '0.56.0-rc.1'));
  expect(() => performRelease(root, 'patch', false)).toThrow('not semver');
});

test('performRelease: missing version field is a clean error', () => {
  const root = makePluginDir('{\n  "name": "pipeline"\n}\n');
  expect(() => performRelease(root, 'patch', false)).toThrow("no string 'version'");
});

test('performRelease: invalid JSON is a clean error', () => {
  const root = makePluginDir('{ nope');
  expect(() => performRelease(root, 'patch', false)).toThrow('invalid JSON');
});

// ---------------------------------------------------------------------------
// runRelease (the real command function)
// ---------------------------------------------------------------------------

test('runRelease: human mode prints the version line + checklist and edits the file', () => {
  const root = makePluginDir(MANIFEST);
  const r = captured(() => runRelease(['patch', '--plugin-root', root]));
  expect(r.code).toBe(0);
  expect(r.out).toContain('version: 0.56.0 -> 0.56.1');
  expect(r.out).toContain('Commit & push in the plugin repo');
  expect(r.out).toContain('submodule pointer');
  const after = readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf-8');
  expect(after).toContain('"version": "0.56.1"');
});

test('runRelease: --json emits the single report object', () => {
  const root = makePluginDir(MANIFEST);
  const r = captured(() => runRelease(['minor', '--plugin-root', root, '--json']));
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toEqual({
    status: 'bumped',
    old_version: '0.56.0',
    new_version: '0.57.0',
    plugin_json: join(root, '.claude-plugin', 'plugin.json'),
  });
});

test('runRelease: --dry-run --json reports without writing', () => {
  const root = makePluginDir(MANIFEST);
  const r = captured(() => runRelease(['major', '--plugin-root=' + root, '--dry-run', '--json']));
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).status).toBe('dry-run');
  expect(JSON.parse(r.out).new_version).toBe('1.0.0');
  expect(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf-8')).toBe(MANIFEST);
});

test('runRelease: missing bump level is a usage error (exit 2)', () => {
  const root = makePluginDir(MANIFEST);
  const r = captured(() => runRelease(['--plugin-root', root]));
  expect(r.code).toBe(2);
  expect(r.err).toContain('a bump level is required');
  expect(r.err).toContain('Usage: pipeline release');
});

test('runRelease: unknown argument is a usage error (exit 2)', () => {
  const r = captured(() => runRelease(['patch', '--bogus']));
  expect(r.code).toBe(2);
  expect(r.err).toContain("unknown argument '--bogus'");
});

test('runRelease: non-semver current version is a clean exit-2 error, file untouched', () => {
  const bad = MANIFEST.replace('0.56.0', 'one.two.three');
  const root = makePluginDir(bad);
  const r = captured(() => runRelease(['patch', '--plugin-root', root]));
  expect(r.code).toBe(2);
  expect(r.err).toContain('not semver');
  expect(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf-8')).toBe(bad);
});

test('runRelease: --plugin-root without a manifest is exit 2', () => {
  const empty = mkdtempSync(join(tmpdir(), 'pipeline-release-noman-'));
  created.push(empty);
  const r = captured(() => runRelease(['patch', '--plugin-root', empty]));
  expect(r.code).toBe(2);
  expect(r.err).toContain('no .claude-plugin/plugin.json');
  expect(existsSync(join(empty, '.claude-plugin', 'plugin.json'))).toBe(false);
});
