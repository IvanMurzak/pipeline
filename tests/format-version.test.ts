// lib/format-version.ts — the `format: N` stamp + support-window guard (T1-17).

import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_FORMAT_VERSION,
  DEFAULT_FORMAT_VERSION,
  MIN_SUPPORTED_FORMAT_VERSION,
  minSupportedFor,
  classifyFormat,
  assertFormatSupported,
  parsePipelineFormat,
  readPipelineFormat,
  FormatVersionError,
  type FormatReaderIO,
} from '../src/lib/format-version';

// ── constants ────────────────────────────────────────────────────────────────

test('constants: current starts at 1, default is 1, min = current-2 floored at 1', () => {
  expect(CURRENT_FORMAT_VERSION).toBe(1);
  expect(DEFAULT_FORMAT_VERSION).toBe(1);
  expect(MIN_SUPPORTED_FORMAT_VERSION).toBe(minSupportedFor(CURRENT_FORMAT_VERSION));
  expect(MIN_SUPPORTED_FORMAT_VERSION).toBe(1);
});

test('minSupportedFor: 2 majors back, floored at 1', () => {
  expect(minSupportedFor(1)).toBe(1);
  expect(minSupportedFor(2)).toBe(1);
  expect(minSupportedFor(3)).toBe(1);
  expect(minSupportedFor(4)).toBe(2);
  expect(minSupportedFor(7)).toBe(5);
});

// ── classification matrix ────────────────────────────────────────────────────
// Drive the full matrix at a synthetic current=4 (min=2), so every branch is
// reachable — with the real CURRENT_FORMAT_VERSION=1 there is no valid
// older-or-too-old format (min valid format is 1 = current).

test('classifyFormat: current → supported', () => {
  const c = classifyFormat(4, 4);
  expect(c.kind).toBe('supported');
  expect(c.version).toBe(4);
  expect(c.current).toBe(4);
});

test('classifyFormat: current-1 and current-2 → upgrade-suggested (within window)', () => {
  for (const v of [3, 2]) {
    const c = classifyFormat(v, 4);
    expect(c.kind).toBe('upgrade-suggested');
    if (c.kind === 'upgrade-suggested') {
      expect(c.message).toContain('pipeline migrate --to 4');
      expect(c.message.toLowerCase()).toContain('persist the upgrade');
    }
  }
});

test('classifyFormat: < min supported → too-old (migrate up)', () => {
  const c = classifyFormat(1, 4); // min = 2
  expect(c.kind).toBe('too-old');
  if (c.kind === 'too-old') {
    expect(c.minSupported).toBe(2);
    expect(c.message).toContain('older than this engine supports');
    expect(c.message).toContain('pipeline migrate');
  }
});

test('classifyFormat: > current → too-new (hard upgrade-or-migrate-down message)', () => {
  const c = classifyFormat(5, 4);
  expect(c.kind).toBe('too-new');
  if (c.kind === 'too-new') {
    expect(c.message).toContain('newer pipeline format');
    expect(c.message.toLowerCase()).toContain('upgrade the plugin');
    expect(c.message).toContain('pipeline migrate --to 4');
  }
});

test('classifyFormat: defaults current to the engine CURRENT_FORMAT_VERSION', () => {
  expect(classifyFormat(CURRENT_FORMAT_VERSION).kind).toBe('supported');
  const tooNew = classifyFormat(CURRENT_FORMAT_VERSION + 1);
  expect(tooNew.kind).toBe('too-new');
});

test('classifyFormat: rejects non-positive-integer versions', () => {
  for (const bad of [0, -1, 1.5, NaN]) {
    expect(() => classifyFormat(bad, 4)).toThrow(FormatVersionError);
  }
});

// ── assertFormatSupported ────────────────────────────────────────────────────

test('assertFormatSupported: returns classification for supported / upgrade-suggested', () => {
  expect(assertFormatSupported(4, 4).kind).toBe('supported');
  expect(assertFormatSupported(2, 4).kind).toBe('upgrade-suggested');
});

test('assertFormatSupported: throws typed error on too-new', () => {
  try {
    assertFormatSupported(5, 4);
    throw new Error('expected throw');
  } catch (e) {
    expect(e).toBeInstanceOf(FormatVersionError);
    const err = e as FormatVersionError;
    expect(err.kind).toBe('too-new');
    expect(err.version).toBe(5);
    expect(err.current).toBe(4);
    expect(err.code).toBe('FORMAT_VERSION_UNSUPPORTED');
  }
});

test('assertFormatSupported: throws typed error on too-old (carries minSupported)', () => {
  try {
    assertFormatSupported(1, 4);
    throw new Error('expected throw');
  } catch (e) {
    expect(e).toBeInstanceOf(FormatVersionError);
    const err = e as FormatVersionError;
    expect(err.kind).toBe('too-old');
    expect(err.minSupported).toBe(2);
  }
});

// ── parsePipelineFormat (text-level) ─────────────────────────────────────────

test('parsePipelineFormat: reads an explicit stamp', () => {
  const md = ['---', 'format: 3', 'model: sonnet', '---', '# Body', ''].join('\n');
  expect(parsePipelineFormat(md)).toBe(3);
});

test('parsePipelineFormat: absent field → default 1', () => {
  const withFm = ['---', 'model: sonnet', '---', '# Body', ''].join('\n');
  expect(parsePipelineFormat(withFm)).toBe(DEFAULT_FORMAT_VERSION);
  // No frontmatter at all → still default 1.
  expect(parsePipelineFormat('# Just a body, no frontmatter\n')).toBe(1);
});

test('parsePipelineFormat: quoted integer stamp still parses', () => {
  const md = ['---', "format: '2'", '---', 'body'].join('\n');
  expect(parsePipelineFormat(md)).toBe(2);
});

test('parsePipelineFormat: malformed stamp → clear invalid error', () => {
  const cases = ['format: abc', 'format: 1.0', 'format: -1', 'format: 0', 'format:', 'format: [1, 2]'];
  for (const line of cases) {
    const md = ['---', line, '---', 'body'].join('\n');
    let thrown: unknown;
    try {
      parsePipelineFormat(md);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FormatVersionError);
    expect((thrown as FormatVersionError).kind).toBe('invalid');
    expect((thrown as FormatVersionError).message).toContain('format');
  }
});

// ── readPipelineFormat (accessor) ────────────────────────────────────────────

test('readPipelineFormat: injected IO — reads join(pipelineDir, PIPELINE.md)', () => {
  const seen: string[] = [];
  const io: FormatReaderIO = {
    exists: (p) => {
      seen.push(p);
      return p.endsWith(join('my-pipeline', 'PIPELINE.md'));
    },
    readFile: () => ['---', 'format: 2', '---', 'body'].join('\n'),
  };
  expect(readPipelineFormat('/repo/my-pipeline', { io })).toBe(2);
  expect(seen[0]).toBe(join('/repo/my-pipeline', 'PIPELINE.md'));
});

test('readPipelineFormat: missing PIPELINE.md → invalid error', () => {
  const io: FormatReaderIO = { exists: () => false, readFile: () => '' };
  let thrown: unknown;
  try {
    readPipelineFormat('/repo/nope', { io });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(FormatVersionError);
  expect((thrown as FormatVersionError).kind).toBe('invalid');
});

// Real-filesystem round-trip in a temp dir under the OS tmp.
const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function tempPipeline(manifest: string): string {
  const root = mkdtempSync(join(tmpdir(), 'fmt-'));
  created.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'PIPELINE.md'), manifest);
  return root;
}

test('readPipelineFormat: real dir with a format stamp', () => {
  const dir = tempPipeline(['---', 'format: 1', 'execution: sequential', '---', '# Pipe'].join('\n'));
  expect(readPipelineFormat(dir)).toBe(1);
});

test('readPipelineFormat: real dir lacking the field → default 1', () => {
  const dir = tempPipeline(['---', 'execution: sequential', '---', '# Pipe'].join('\n'));
  expect(readPipelineFormat(dir)).toBe(DEFAULT_FORMAT_VERSION);
});

test('readPipelineFormat: real dir with a malformed stamp → clear error', () => {
  const dir = tempPipeline(['---', 'format: banana', '---', '# Pipe'].join('\n'));
  expect(() => readPipelineFormat(dir)).toThrow(FormatVersionError);
});
