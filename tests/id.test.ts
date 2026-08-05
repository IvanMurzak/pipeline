// id.test.ts — `pipeline id` (ux-v2 b2 mint-site conformance, site: skills/run/SKILL.md).
//
// SKILL.md used to embed its OWN id-generation recipe
// (`randomBytes(6).toString('hex')`) and a second, entirely unspecified one
// ("mint a child_run_id now"). Both now call this command instead — this test
// asserts the command actually mints THE product id (`newId()`'s UUIDv7),
// decoded at the bit level exactly like tests/ids.test.ts, not merely
// something 36-characters-long.

import { test, expect } from 'bun:test';
import { runId } from '../src/commands/id';

/** Canonical `8-4-4-4-12` string → its 16 bytes. Mirrors tests/ids.test.ts's
 *  bytesOf so a malformed id fails loudly rather than silently decoding to
 *  zeros. Duplicated (not imported) because it is test-only decode logic,
 *  not product code. */
function bytesOf(uuid: string): Uint8Array {
  const parts = uuid.split('-');
  expect(parts.length).toBe(5);
  const hex = parts.join('');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function withCapturedStdio(fn: () => number): { code: number; stdout: string; stderr: string } {
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

test('id command: plain output is a conformant UUIDv7 (ver=7, var=0b10)', () => {
  const { code, stdout, stderr } = withCapturedStdio(() => runId([]));
  expect(code).toBe(0);
  expect(stderr).toBe('');
  const id = stdout.trim();
  expect(id.length).toBe(36);
  const b = bytesOf(id);
  expect(b[6] >>> 4).toBe(0b0111);
  expect(b[8] >>> 6).toBe(0b10);
});

test('id command: --json outputs {"id": "<uuid>"}', () => {
  const { code, stdout, stderr } = withCapturedStdio(() => runId(['--json']));
  expect(code).toBe(0);
  expect(stderr).toBe('');
  const parsed = JSON.parse(stdout) as { id: string };
  expect(typeof parsed.id).toBe('string');
  const b = bytesOf(parsed.id);
  expect(b[6] >>> 4).toBe(0b0111);
});

test('id command: two calls never collide', () => {
  const a = withCapturedStdio(() => runId([])).stdout.trim();
  const b = withCapturedStdio(() => runId([])).stdout.trim();
  expect(a).not.toBe(b);
});

test('id command: unknown flag → exit 2', () => {
  const { code, stderr } = withCapturedStdio(() => runId(['--bogus']));
  expect(code).toBe(2);
  expect(stderr).toContain('unknown flag');
});
