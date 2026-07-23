/**
 * Generated-tree ignore stubs — src/lib/generated-dir.ts.
 *
 *   bun test tests/generated-dir.test.ts
 *
 * A pipeline writes its runtime state into the USER's repository. Without a
 * rule shipped alongside it, the first `git add -A` after a run sweeps session
 * ids, journals and rendered copies into their commit. These tests pin the two
 * properties that make writing the rule automatically safe: it lands once at
 * the tree root, and it never overrides what the project already decided.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureGeneratedDir } from '../src/lib/generated-dir';

let tmpRoot: string;
let seq = 0;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'pipeline-gendir-'));
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const fresh = (): string => join(tmpRoot, `t-${seq++}`);

describe('ensureGeneratedDir', () => {
  test('creates the directory and marks it ignored', () => {
    const dir = fresh();
    ensureGeneratedDir(dir);
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('*');
  });

  test('creates nested paths and puts the stub at the TREE ROOT, not per folder', () => {
    const root = fresh();
    const deep = join(root, 'run-1', 'sessions');
    ensureGeneratedDir(deep, root);
    expect(existsSync(deep)).toBe(true);
    expect(existsSync(join(root, '.gitignore'))).toBe(true);
    // `*` at the root already covers everything beneath — a stub in every
    // nested folder would just be litter in the user's repo.
    expect(existsSync(join(deep, '.gitignore'))).toBe(false);
  });

  test('NEVER overwrites a .gitignore the project already has', () => {
    const root = fresh();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.gitignore'), '!keep-me\n', 'utf8');
    ensureGeneratedDir(join(root, 'nested'), root);
    // A team that deliberately commits this tree keeps its own rule.
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('!keep-me\n');
  });

  test('is idempotent — repeated calls leave one unchanged stub', () => {
    const dir = fresh();
    ensureGeneratedDir(dir);
    const first = readFileSync(join(dir, '.gitignore'), 'utf8');
    ensureGeneratedDir(dir);
    ensureGeneratedDir(join(dir, 'child'), dir);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(first);
  });

  test('the stub explains itself rather than being a bare glob', () => {
    const dir = fresh();
    ensureGeneratedDir(dir);
    const body = readFileSync(join(dir, '.gitignore'), 'utf8');
    expect(body.split('\n')[0]).toMatch(/^#/); // a reader learns why it is here
    expect(body).toContain('\n*\n');
  });
});
