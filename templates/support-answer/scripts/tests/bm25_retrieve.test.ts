// Tests for the support-answer BM25 retrieval script — stdlib `bun:test`, no
// network, no filesystem writes. Exercises the pure ranking/tokenization logic
// directly (the CLI `main()` is guarded by `import.meta.main`, so importing here
// never runs it).
//
// NOTE: this file ships inside the cloned template so a user who adapts the
// script can re-verify it (`bun test scripts/tests/` from their pipeline root).
// It is NOT part of the pipeline-cli test suite — that suite runs `bun test
// tests/`, which scans only apps/pipeline-cli/tests/, never templates/.

import { describe, expect, test } from 'bun:test';
import { tokenize, bm25Rank, bestSnippet, parseArgs, type Doc } from '../bm25_retrieve';

const CORPUS: Doc[] = [
  { file: 'getting-started.md', text: 'Getting started guide. To get started, create a note. Getting started is quick.' },
  { file: 'installation.md', text: 'Install Nimbus Notes on Windows, macOS, and Linux. Download the installer.' },
  { file: 'billing.md', text: 'Plans and billing. Upgrade to Pro. Refunds within 14 days — request a refund.' },
];

describe('tokenize', () => {
  test('lowercases, splits, drops stop-words and single chars', () => {
    expect(tokenize('How do I GET Started?')).toEqual(['get', 'started']);
  });
  test('empty / punctuation-only text yields no tokens', () => {
    expect(tokenize('  --- ,. !? ')).toEqual([]);
  });
});

describe('bm25Rank', () => {
  test('ranks the on-topic doc first for the default question', () => {
    const ranked = bm25Rank(CORPUS, 'How do I get started?', 5);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.file).toBe('getting-started.md');
    // score-descending
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });

  test('routes a distinctive query to the right doc', () => {
    const ranked = bm25Rank(CORPUS, 'request a refund', 3);
    expect(ranked[0]!.file).toBe('billing.md');
  });

  test('respects top-k and drops zero-score docs', () => {
    const ranked = bm25Rank(CORPUS, 'install windows', 5);
    // Only installation.md contains these terms.
    expect(ranked.map((c) => c.file)).toEqual(['installation.md']);
  });

  test('a query with no matching terms yields no candidates', () => {
    expect(bm25Rank(CORPUS, 'quantum chromodynamics', 5)).toEqual([]);
  });

  test('deterministic: identical inputs give identical scores', () => {
    const a = bm25Rank(CORPUS, 'get started', 5);
    const b = bm25Rank(CORPUS, 'get started', 5);
    expect(a).toEqual(b);
  });
});

describe('bestSnippet', () => {
  test('picks the line richest in query terms', () => {
    const text = 'Intro line.\nTo get started, create a note.\nUnrelated footer.';
    expect(bestSnippet(text, new Set(['get', 'started']))).toBe('To get started, create a note.');
  });
  test('falls back to the first non-blank line when nothing matches', () => {
    const text = '\n\nFirst real line.\nSecond line.';
    expect(bestSnippet(text, new Set(['nomatch']))).toBe('First real line.');
  });
});

describe('parseArgs', () => {
  test('defaults', () => {
    expect(parseArgs([])).toEqual({ docs: './sample-docs', question: 'How do I get started?', topK: 5 });
  });
  test('--flag value and --flag=value both parse', () => {
    expect(parseArgs(['--docs', 'x', '--top-k', '3', '--question=hi'])).toEqual({ docs: 'x', question: 'hi', topK: 3 });
  });
  test('--help returns null', () => {
    expect(parseArgs(['--help'])).toBeNull();
  });
  test('bad --top-k throws', () => {
    expect(() => parseArgs(['--top-k', '0'])).toThrow();
  });
  test('unknown flag throws', () => {
    expect(() => parseArgs(['--bogus'])).toThrow();
  });
});
