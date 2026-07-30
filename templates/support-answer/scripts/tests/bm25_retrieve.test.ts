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
import {
  tokenize,
  bm25Rank,
  bestSnippet,
  parseArgs,
  successResult,
  failureResult,
  type Candidate,
  type Doc,
} from '../bm25_retrieve';

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

// ---------------------------------------------------------------------------
// Pipeline variables from the environment. Under `pipeline next` this step is a
// `type: script` step invoked with NO arguments — every value arrives as a
// `PP_*` entry the runtime puts in the child environment. These tests pin the
// precedence that makes that work: flag > environment > default.
// ---------------------------------------------------------------------------

describe('parseArgs: PP_* environment tier', () => {
  const ENV = { PP_DOCS_DIR: '/corpus', PP_QUESTION: 'from env', PP_TOP_K: '9' };

  test('reads every value from the environment when no flag is given', () => {
    expect(parseArgs([], ENV)).toEqual({ docs: '/corpus', question: 'from env', topK: 9 });
  });

  test('an explicit flag beats the environment, per value', () => {
    // Only --question is passed: the other two must still come from the env,
    // so this proves precedence is per-value and not all-or-nothing.
    expect(parseArgs(['--question', 'from flag'], ENV)).toEqual({
      docs: '/corpus',
      question: 'from flag',
      topK: 9,
    });
  });

  test('an absent environment falls through to the built-in defaults', () => {
    expect(parseArgs([], {})).toEqual(parseArgs([]));
  });

  test('an EMPTY environment value is treated as absent, not as an empty path', () => {
    // A blank PP_DOCS_DIR would otherwise resolve the docs dir to the pipeline
    // root itself and silently rank the pipeline's own files.
    expect(parseArgs([], { PP_DOCS_DIR: '', PP_QUESTION: '  ' })).toEqual(parseArgs([]));
  });

  test('a malformed PP_TOP_K throws, naming the variable rather than a flag', () => {
    expect(() => parseArgs([], { PP_TOP_K: 'abc' })).toThrow('PP_TOP_K');
  });
});

// ---------------------------------------------------------------------------
// The script-step result object (docs/script-steps.md §3.5/§3.6). stdout IS the
// contract now: the command layer reads it, so its shape is load-bearing.
// ---------------------------------------------------------------------------

describe('result object', () => {
  const CANDIDATES: Candidate[] = [{ file: 'a.md', score: 1.5, snippet: 's' }];

  test('success carries ok, the routing flag, and the persisted output payload', () => {
    const r = successResult('/docs', CANDIDATES, 'q?');
    expect(r.ok).toBe(true);
    expect(r.flags).toEqual({ has_candidates: true });
    // `output` is EXACTLY what lands in .runtime/<run-id>/outputs/01-retrieve.json
    // and what steps 02/03 read — no extra keys, no renames.
    expect(Object.keys(r.output).sort()).toEqual(['candidates', 'docs_dir']);
    expect(r.output).toEqual({ docs_dir: '/docs', candidates: CANDIDATES });
  });

  test('NO MATCH IS A SUCCESS — ok stays true with an empty list (§3.6)', () => {
    // The load-bearing rule: `ok:false` means retrieval could not run, never
    // "the docs do not cover this". Returning false here would halt the run
    // instead of letting step 02 report "no local doc matched".
    const r = successResult('/docs', [], 'nothing matches this');
    expect(r.ok).toBe(true);
    expect(r.output.candidates).toEqual([]);
    expect(r.flags.has_candidates).toBe(false);
  });

  test('summary is one line and truncates a long question', () => {
    const r = successResult('/docs', [], 'x'.repeat(200));
    expect(r.summary).not.toInclude('\n');
    expect(r.summary.length).toBeLessThan(200);
  });

  test('failure self-classifies so the runtime need not guess', () => {
    // The runtime TRUSTS error.class (§5.1); `env` halts without spending an
    // agent on a machine/config problem.
    const r = failureResult('env', 'docs directory not found: /nope');
    expect(r.ok).toBe(false);
    expect(r.error.class).toBe('env');
    expect(r.error.detail).toInclude('/nope');
  });
});
