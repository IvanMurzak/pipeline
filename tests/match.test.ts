import { test, expect, afterEach } from 'bun:test';
import {
  matchPipelines,
  tokenize,
  bm25Scores,
  matchedTerms,
  splitSections,
  parseScope,
  roundScore,
  findFirstIteration,
} from '../src/lib/match';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const created: string[] = [];

/**
 * Build a pipelines tree under a fresh temp dir.
 * `pipelines` maps a pipeline folder name to { manifest, steps }.
 */
function scaffold(
  pipelines: Record<string, { manifest: string; steps?: string[] }>,
): string {
  const root = mkdtempSync(join(tmpdir(), 'match-'));
  created.push(root);
  for (const [name, spec] of Object.entries(pipelines)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PIPELINE.md'), spec.manifest);
    if (spec.steps && spec.steps.length) {
      const stepsDir = join(dir, 'steps');
      mkdirSync(stepsDir, { recursive: true });
      for (const fname of spec.steps) {
        const full = join(stepsDir, fname);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, `# ${fname}\n`);
      }
    }
  }
  return root;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures shared by several golden cases
// ---------------------------------------------------------------------------

function threePipelines(): string {
  return scaffold({
    'auth-refactor': {
      manifest: [
        '# Auth Refactor',
        '',
        '## End State',
        'The authentication and login flow uses OAuth tokens and refresh rotation.',
        '',
        '## Scope',
        '- In: authentication login oauth token refresh',
        '- Out: database schema migration',
        '',
        '## Glossary',
        'oauth token session cookie',
        '',
      ].join('\n'),
      steps: ['02-next.md', '01-start.md'],
    },
    'db-migrate': {
      manifest: [
        '# DB Migrate',
        '',
        '## End State',
        'The database schema migration runs cleanly with versioned migrations.',
        '',
        '## Scope',
        '- In: database schema migration versioned',
        '- Out: authentication login changes',
        '',
        '## Glossary',
        'migration schema postgres',
        '',
      ].join('\n'),
      steps: ['01-plan.md'],
    },
    'ui-polish': {
      manifest: [
        '# UI Polish',
        '',
        '## End State',
        'The dashboard buttons and layout look polished and consistent.',
        '',
        '## Scope',
        '- In: dashboard buttons layout css styling',
        '- Out:',
        '',
        '## Glossary',
        'css layout flexbox',
        '',
      ].join('\n'),
      steps: ['03-z.md', '01-a.md'],
    },
  });
}

// ===========================================================================
// PURE-TS GOLDEN ASSERTIONS (run with no Python — CI bun-only still verifies)
// ===========================================================================

test('tokenize: lowercases, drops stopwords + short tokens, keeps hyphens/underscores', () => {
  expect(tokenize('The Quick-Brown fox_jumps a I X')).toEqual(['quick-brown', 'fox_jumps']);
  // "a", "I", "X" dropped: stopword / length<=1.
  expect(tokenize('')).toEqual([]);
  expect(tokenize('the a an of and or')).toEqual([]);
  // digits-leading tokens are not matched (regex requires a leading letter).
  expect(tokenize('abc123 9foo b2b')).toEqual(['abc123', 'foo', 'b2b']);
});

test('splitSections: H2 split, body trimmed', () => {
  const s = splitSections('intro\n## A\nbody a\nmore\n## B\n\nbody b\n');
  expect(s).toEqual({ A: 'body a\nmore', B: 'body b' });
});

test('parseScope: inline + bullet styles', () => {
  const [inL, outL] = parseScope(
    ['- In: alpha beta', '- Out:', '  - gamma', '  - delta', 'plain-cont'].join('\n'),
  );
  expect(inL).toEqual(['alpha beta']);
  expect(outL).toEqual(['gamma', 'delta', 'plain-cont']);
});

test('bm25Scores: empty corpus → []', () => {
  expect(bm25Scores(['x'], [])).toEqual([]);
});

test('bm25Scores: empty doc → 0, matches known formula sign', () => {
  const scores = bm25Scores(['cat'], [[], ['cat', 'cat', 'dog']]);
  expect(scores[0]).toBe(0);
  expect(scores[1]).toBeGreaterThan(0);
});

test('matchedTerms: order-preserving, deduped, doc-membership', () => {
  expect(matchedTerms(['a', 'b', 'a', 'c'], ['a', 'c', 'z'])).toEqual(['a', 'c']);
});

test('roundScore matches Python round(x,4) on the fixture scores', () => {
  expect(roundScore(7.9199999999)).toBe(7.92);
  expect(roundScore(5.94365432)).toBe(5.9437);
  expect(roundScore(6.17455)).toBe(6.1746);
});

test('golden: clear single match, sorted excluded, first_iteration resolved', () => {
  const root = threePipelines();
  const out = matchPipelines(root, 'update the authentication login flow with oauth token refresh');
  expect(out.candidates.length).toBe(1);
  const c = out.candidates[0];
  expect(c.name).toBe('auth-refactor');
  expect(c.first_iteration).toBe(join(root, 'auth-refactor', 'steps', '01-start.md'));
  expect(c.matched_terms).toEqual(['authentication', 'login', 'flow', 'oauth', 'token', 'refresh']);
  expect(c.score).toBeGreaterThan(0);
  // db-migrate is excluded by its Scope.Out (authentication/login overlap).
  expect(out.excluded.map((e) => e.name)).toEqual(['db-migrate']);
  expect(out.excluded[0].matching_terms).toEqual(['authentication', 'login']);
});

test('golden: no-match task → empty candidates + empty excluded', () => {
  const root = threePipelines();
  const out = matchPipelines(root, 'completely unrelated quantum gardening');
  expect(out.candidates).toEqual([]);
  expect(out.excluded).toEqual([]);
});

test('golden: all-stopword task → empty result', () => {
  const root = threePipelines();
  const out = matchPipelines(root, 'the a an of and or but');
  expect(out.candidates).toEqual([]);
  expect(out.excluded).toEqual([]);
});

test('golden: --top floors at 1', () => {
  const root = threePipelines();
  const out = matchPipelines(root, 'dashboard buttons layout css', { top: 0 });
  expect(out.candidates.length).toBe(1);
});

test('golden: empty pipelines dir → empty result, no throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'match-empty-'));
  created.push(root);
  const out = matchPipelines(root, 'anything at all');
  expect(out).toEqual({ task: 'anything at all', candidates: [], excluded: [] });
});

test('golden: candidate sort is descending score then codepoint name (no localeCompare)', () => {
  // Two pipelines with byte-identical corpora EXCEPT the folder name, chosen so
  // the names tokenize to equal-length tokens → genuinely TIED BM25 score
  // (verified 0.2605 each against Python). The tie must break on the raw name
  // by Unicode codepoint: 'Zzz' (Z=0x5A) sorts BEFORE 'aaa' (a=0x61). A
  // case-insensitive localeCompare would (wrongly) put 'aaa' first — this test
  // is the regression guard against using localeCompare.
  const root = scaffold({
    Zzz: {
      manifest: '## End State\nwidget gamma\n\n## Scope\n- In: widget gamma\n',
      steps: ['01-x.md'],
    },
    aaa: {
      manifest: '## End State\nwidget gamma\n\n## Scope\n- In: widget gamma\n',
      steps: ['01-x.md'],
    },
  });
  const out = matchPipelines(root, 'widget');
  expect(out.candidates.map((c) => c.score)).toEqual([0.2605, 0.2605]);
  expect(out.candidates.map((c) => c.name)).toEqual(['Zzz', 'aaa']);
});

test('findFirstIteration: numeric-prefix only, sorted by (int prefix, name), non-recursive', () => {
  const root = scaffold({
    p: { manifest: '## End State\nx\n', steps: ['10-late.md', '2-mid.md', '01-early.md', 'README.md'] },
  });
  const manifest = join(root, 'p', 'PIPELINE.md');
  // 01-early < 2-mid < 10-late by integer prefix; README has no numeric prefix.
  expect(findFirstIteration(manifest)).toBe(join(root, 'p', 'steps', '01-early.md'));
});

// ===========================================================================
// Bug 1 — bold `**In**:` / `**Out**:` scope markers parse like plain In:/Out:
// ===========================================================================

test('Bug 1 — parseScope: bold **In**/**Out** markers parse identically to plain In/Out', () => {
  const bold = parseScope(['- **In**: alpha beta', '- **Out**:', '  - gamma', '  - delta'].join('\n'));
  const plain = parseScope(['- In: alpha beta', '- Out:', '  - gamma', '  - delta'].join('\n'));
  // The two authoring styles must be byte-for-byte equivalent.
  expect(bold).toEqual(plain);
  expect(bold[0]).toEqual(['alpha beta']);
  expect(bold[1]).toEqual(['gamma', 'delta']);
  // Pre-fix the bold form matched NEITHER marker, so the whole Scope (both
  // scope_in AND scope_out) was silently dropped — assert both are non-empty.
  expect(bold[0].length).toBeGreaterThan(0);
  expect(bold[1].length).toBeGreaterThan(0);
  // Inline content on a bold marker is captured too (`- **Out**: foo`).
  const inline = parseScope('- **Out**: database migration');
  expect(inline[1]).toEqual(['database migration']);
});

test('Bug 1 — end-to-end: a bold-marker Scope.Out still hard-excludes (scope parsed, filter active)', () => {
  const root = scaffold({
    'db-migrate': {
      manifest: [
        '# DB Migrate',
        '',
        '## End State',
        'versioned database migrations run cleanly.',
        '',
        '## Scope',
        '- **In**: database schema migration versioned',
        '- **Out**: authentication login session',
        '',
      ].join('\n'),
      steps: ['01-plan.md'],
    },
  });
  // Pre-fix: the bold Scope.Out was dropped → empty scope_out → the manifest
  // could never be hard-excluded. Now it parses, so a 2+ token overlap excludes.
  const out = matchPipelines(root, 'rework the authentication login session handling');
  expect(out.excluded.map((e) => e.name)).toEqual(['db-migrate']);
  expect(out.excluded[0].matching_terms).toEqual(['authentication', 'login', 'session']);
});

// ===========================================================================
// Bug 2 — default neg-threshold is 2 (a single incidental shared word can't
// wrongly exclude an otherwise-correct pipeline).
// ===========================================================================

test('Bug 2 — default neg-threshold=2: ONE shared Scope.Out token does NOT exclude; TWO does', () => {
  const make = () =>
    scaffold({
      widget: {
        manifest: [
          '# Widget',
          '',
          '## End State',
          'the widget feature ships.',
          '',
          '## Scope',
          '- In: widget feature build',
          '- Out: database migration',
          '',
        ].join('\n'),
        steps: ['01-a.md'],
      },
    });

  // ONE shared Scope.Out token ("database") → survives as a candidate (NOT excluded).
  let out = matchPipelines(make(), 'build the widget feature and touch the database once');
  expect(out.excluded).toEqual([]);
  expect(out.candidates.map((c) => c.name)).toEqual(['widget']);

  // TWO shared Scope.Out tokens ("database migration") → hard-excluded.
  out = matchPipelines(make(), 'run the database migration for the widget feature');
  expect(out.excluded.map((e) => e.name)).toEqual(['widget']);

  // The footgun is still reachable for callers that explicitly opt into the old
  // aggressive behavior — a single shared token excludes when negThreshold=1.
  out = matchPipelines(make(), 'build the widget feature and touch the database once', { negThreshold: 1 });
  expect(out.excluded.map((e) => e.name)).toEqual(['widget']);
});
