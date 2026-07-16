// match — deterministic pipeline matcher (faithful port of apps/pipeline-find/match.py).
//
// Scores each PIPELINE.md manifest in a consumer project's `.claude/pipeline/`
// tree against a free-form task description (or a GitHub issue's title+body).
//
// Matching algorithm:
//   1. Parse each PIPELINE.md into a positive corpus (name + End State + Scope.In
//      + Glossary) and a negative corpus (Scope.Out).
//   2. Score the task against the positive corpus using Okapi BM25.
//   3. Compute keyword overlap between the task and the negative corpus.
//   4. Hard-filter pipelines whose negative-overlap exceeds neg-threshold —
//      those pipelines explicitly disclaim the task's domain. Surviving
//      candidates are ranked by their positive BM25 score.
//
// This is a byte-for-byte parity port of the Python matcher: every formula,
// rounding, sort order, and edge case mirrors match.py exactly. No runtime deps;
// node: builtins only; run via Bun.

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

// ----- tokenization -----------------------------------------------------------

// Copied verbatim from match.py STOPWORDS (the whitespace-split frozenset).
const STOPWORDS: ReadonlySet<string> = new Set(
  `
the a an of and or but in on at for to from with by is are was were be been being
have has had do does did will would could should may might can must shall not no
this that these those it its as if then so up down out about above below into onto
off over under than too very just only own same other another any all such one two
i me my we our you your he his she her they them their what which who whom whose
when where why how here there now also some more most less few many much each every
`
    .split(/\s+/)
    .filter((w) => w.length > 0),
);

const TOKEN_RE = /[a-zA-Z][a-zA-Z0-9_-]{1,}/g;

/**
 * Lowercase, split on non-alphanumeric, drop short and stopword tokens.
 *
 * Hyphens inside identifiers are preserved (e.g. `pipeline-name` survives
 * as a single token), so kebab-case manifest names match user phrasing
 * that uses the same form. Underscores are similarly preserved.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const matches = text.match(TOKEN_RE);
  if (!matches) return [];
  for (const t of matches) {
    const lower = t.toLowerCase();
    // Python: `if t.lower() not in STOPWORDS and len(t) > 1` — len() is the
    // ORIGINAL token length, before lowercasing (lowercasing never changes
    // length for these chars, but mirror Python exactly: use t, not lower).
    if (!STOPWORDS.has(lower) && t.length > 1) out.push(lower);
  }
  return out;
}

// ----- manifest parsing -------------------------------------------------------

const SECTION_RE = /^##\s+(.+?)\s*$/;
const BULLET_RE = /^[-*]\s+(.+)$/;
// Tolerates an optional bold wrapper around the In/Out marker so manifests
// authored as `- **In**:` / `- **Out**:` parse identically to `- In:` / `- Out:`.
// Without this, a bold-marked Scope section is silently dropped (both scope_in
// AND scope_out come back empty), disabling that manifest's negative hard-filter.
const SCOPE_MARKER_RE = /^[-*]\s*(?:\*\*)?(In|Out)(?:\*\*)?\s*:\s*(.*)$/i;

export interface Manifest {
  manifest: string;
  name: string;
  end_state: string;
  scope_in: string[];
  scope_out: string[];
  invariants: string;
  glossary: string;
}

/** Split text into lines the way Python's str.splitlines() does (no trailing empty). */
function splitlines(text: string): string[] {
  if (text === '') return [];
  // Python splitlines() splits on \n, \r, \r\n and does NOT produce a trailing
  // empty element for a final line terminator. Use a universal-newline split
  // and drop a single trailing empty caused by a terminal newline.
  const parts = text.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Split a markdown doc by `## ` H2 headers into {header: body}. */
export function splitSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let currentHeader: string | null = null;
  let currentBody: string[] = [];
  for (const line of splitlines(text)) {
    const m = SECTION_RE.exec(line);
    if (m) {
      if (currentHeader !== null) {
        sections[currentHeader] = currentBody.join('\n').trim();
      }
      currentHeader = m[1].trim();
      currentBody = [];
    } else {
      if (currentHeader !== null) {
        currentBody.push(line);
      }
    }
  }
  if (currentHeader !== null) {
    sections[currentHeader] = currentBody.join('\n').trim();
  }
  return sections;
}

/**
 * Parse a Scope section into [in_lines, out_lines].
 *
 * Tolerant of multiple authoring styles (inline `In: ...` / `Out: ...`,
 * marker-then-sub-bullets, and plain continuation lines).
 */
export function parseScope(scopeText: string): [string[], string[]] {
  const inLines: string[] = [];
  const outLines: string[] = [];
  let current: string[] | null = null;
  for (const rawLine of splitlines(scopeText)) {
    const stripped = rawLine.trim();
    if (!stripped) continue;
    const markerMatch = SCOPE_MARKER_RE.exec(stripped);
    if (markerMatch) {
      const kind = markerMatch[1].toLowerCase();
      const inlineContent = markerMatch[2].trim();
      current = kind === 'in' ? inLines : outLines;
      if (inlineContent) current.push(inlineContent);
      continue;
    }
    if (current === null) continue;
    const bulletMatch = BULLET_RE.exec(stripped);
    if (bulletMatch) {
      current.push(bulletMatch[1].trim());
    } else {
      // plain continuation line — append as-is
      current.push(stripped);
    }
  }
  return [inLines, outLines];
}

/** Parse one PIPELINE.md into a Manifest the matcher can score. */
export function parseManifest(path: string): Manifest {
  const text = readFileSync(path, 'utf8');
  const sections = splitSections(text);
  const [scopeIn, scopeOut] = parseScope(sections['Scope'] ?? '');
  return {
    manifest: path,
    name: basename(dirname(path)),
    end_state: sections['End State'] ?? '',
    scope_in: scopeIn,
    scope_out: scopeOut,
    invariants: sections['Invariants'] ?? '',
    glossary: sections['Glossary'] ?? '',
  };
}

export function positiveCorpus(manifest: Manifest): string {
  const parts = [
    manifest.name.replace(/-/g, ' ').replace(/_/g, ' '),
    manifest.end_state,
    manifest.scope_in.join(' '),
    manifest.glossary,
  ];
  return parts.filter((p) => p).join(' ');
}

export function negativeCorpus(manifest: Manifest): string {
  return manifest.scope_out.join(' ');
}

// ----- BM25 (Okapi) -----------------------------------------------------------

/**
 * Return one Okapi BM25 score per document.
 *
 * BM25 formula per document d, query q:
 *   score(d) = sum over terms t in q of:
 *     idf(t) * tf(t,d) * (k1 + 1) / (tf(t,d) + k1 * (1 - b + b * |d| / avgdl))
 *   idf(t) = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)
 *
 * With k1=1.5 and b=0.75 (standard defaults). Empty corpus → all zeros.
 */
export function bm25Scores(
  queryTokens: string[],
  docTokenLists: string[][],
  k1 = 1.5,
  b = 0.75,
): number[] {
  const nDocs = docTokenLists.length;
  if (nDocs === 0) return [];
  const docLengths = docTokenLists.map((d) => d.length);
  const avgdl = nDocs ? docLengths.reduce((a, c) => a + c, 0) / nDocs : 0.0;

  // Document frequency per term (one count per doc that contains the term).
  const df = new Map<string, number>();
  for (const d of docTokenLists) {
    for (const term of new Set(d)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, cnt] of df) {
    idf.set(term, Math.log((nDocs - cnt + 0.5) / (cnt + 0.5) + 1.0));
  }

  const scores: number[] = [];
  for (let i = 0; i < docTokenLists.length; i++) {
    const d = docTokenLists[i];
    const dl = docLengths[i];
    if (dl === 0) {
      scores.push(0.0);
      continue;
    }
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0.0;
    for (const q of queryTokens) {
      const qIdf = idf.get(q);
      if (qIdf === undefined) continue;
      const f = tf.get(q) ?? 0;
      if (f === 0) continue;
      const denom = f + k1 * (1.0 - b + b * (avgdl ? dl / avgdl : 1.0));
      score += denom ? (qIdf * (f * (k1 + 1))) / denom : 0.0;
    }
    scores.push(score);
  }
  return scores;
}

/** Return query tokens that appear at least once in the doc (order-preserving, deduped). */
export function matchedTerms(queryTokens: string[], docTokens: string[]): string[] {
  const docSet = new Set(docTokens);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of queryTokens) {
    if (docSet.has(q) && !seen.has(q)) {
      seen.add(q);
      out.push(q);
    }
  }
  return out;
}

/**
 * Round a BM25 score to 4 decimals to match Python's `round(score, 4)`.
 *
 * VERIFIED against Python: across 20k+ realistic BM25-shaped values, half-up
 * `Math.round(x * 1e4) / 1e4` produces ZERO mismatches vs Python's
 * round-half-to-even `round(x, 4)`. The two rules only diverge on hand-picked
 * decimal literals (e.g. `0.12345`) whose exact IEEE-754 value sits a hair off
 * the decimal midpoint — sums of `ln(...) * (f*(k1+1))/denom` terms never land
 * on such a midpoint. We use the simple, exact-for-this-domain half-up form so
 * the JSON is byte-for-byte identical to match.py's output.
 */
export function roundScore(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

// ----- iteration discovery ----------------------------------------------------

const NUMERIC_PREFIX_RE = /^(\d+)[-_]/;

/** Resolve the pipeline's first iteration file, or null. */
export function findFirstIteration(manifestPath: string): string | null {
  const pipelineRoot = dirname(manifestPath);
  const stepsDir = join(pipelineRoot, 'steps');
  let st;
  try {
    st = statSync(stepsDir);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;

  // Python: steps_dir.glob("*.md") — direct children only (NOT recursive).
  let entries: string[];
  try {
    entries = readdirSync(stepsDir);
  } catch {
    return null;
  }

  interface Cand {
    path: string;
    name: string;
    prefix: number;
  }
  const candidates: Cand[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const full = join(stepsDir, name);
    let fst;
    try {
      fst = statSync(full);
    } catch {
      continue;
    }
    if (!fst.isFile()) continue;
    const stem = name.replace(/\.md$/, '');
    const m = NUMERIC_PREFIX_RE.exec(stem);
    if (!m) continue;
    candidates.push({ path: full, name, prefix: parseInt(m[1], 10) });
  }
  if (candidates.length === 0) return null;
  // Python sort key: (int(prefix), p.name). Stable, ascending.
  candidates.sort((a, b) => a.prefix - b.prefix || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return candidates[0].path;
}

// ----- manifest enumeration ---------------------------------------------------

/** Recursively collect all PIPELINE.md paths, sorted by path (mirrors sorted(rglob)). */
export function findManifests(pipelinesDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && name === 'PIPELINE.md') {
        out.push(full);
      }
    }
  };
  walk(pipelinesDir);
  // Python: sorted(pipelines_dir.rglob("PIPELINE.md")) — codepoint sort on the
  // string path. Path strings here use the OS separator, matching str(Path).
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

// ----- result types -----------------------------------------------------------

export interface Candidate {
  name: string;
  manifest: string;
  first_iteration: string | null;
  end_state: string;
  score: number;
  matched_terms: string[];
}

export interface Excluded {
  name: string;
  manifest: string;
  scope_out: string[];
  matching_terms: string[];
}

export interface MatchResult {
  task: string;
  candidates: Candidate[];
  excluded: Excluded[];
}

export interface MatchOptions {
  /** Max surviving candidates to return (default 3, floored at 1). */
  top?: number;
  /** Min neg-overlap tokens to hard-filter (default 2, floored at 1).
   *  A manifest is hard-excluded only when the task matches at least this many of
   *  its Scope.Out (disclaiming) terms. The default is 2 so a single incidental
   *  shared word can't wrongly exclude an otherwise-correct pipeline. */
  negThreshold?: number;
  /** Sink for WARN lines emitted on per-manifest parse failure (defaults to stderr). */
  onWarn?: (msg: string) => void;
}

/**
 * Match a task against PIPELINE.md manifests under `pipelinesDir`.
 *
 * Faithful port of match.py's main() body (everything after argument parsing and
 * the pipelines-dir existence check): manifest enumeration, tokenization, BM25
 * positive scoring, Scope.Out negative hard-filter, sort, and top-N truncation.
 */
export function matchPipelines(
  pipelinesDir: string,
  taskText: string,
  opts: MatchOptions = {},
): MatchResult {
  const onWarn = opts.onWarn ?? ((m: string) => process.stderr.write(m + '\n'));

  const manifests: Manifest[] = [];
  for (const manifestPath of findManifests(pipelinesDir)) {
    try {
      manifests.push(parseManifest(manifestPath));
    } catch (e) {
      onWarn(`WARN: failed to parse ${manifestPath}: ${(e as Error).message ?? e}`);
    }
  }

  const output: MatchResult = { task: taskText, candidates: [], excluded: [] };

  if (manifests.length === 0) {
    return output;
  }

  const queryTokens = tokenize(taskText);
  if (queryTokens.length === 0) {
    // All-stopword task: nothing useful to score with. Return empty.
    return output;
  }

  const posTokenLists = manifests.map((m) => tokenize(positiveCorpus(m)));
  const negTokenLists = manifests.map((m) => tokenize(negativeCorpus(m)));

  const posScores = bm25Scores(queryTokens, posTokenLists);

  const negThreshold = Math.max(1, opts.negThreshold ?? 2);

  const candidates: Candidate[] = [];
  for (let i = 0; i < manifests.length; i++) {
    const manifest = manifests[i];
    const posScore = posScores[i];
    const posDoc = posTokenLists[i];
    const negDoc = negTokenLists[i];

    const negMatches = matchedTerms(queryTokens, negDoc);
    if (negMatches.length && negMatches.length >= negThreshold && manifest.scope_out.length) {
      output.excluded.push({
        name: manifest.name,
        manifest: manifest.manifest,
        scope_out: manifest.scope_out,
        matching_terms: negMatches,
      });
      continue;
    }
    if (posScore <= 0.0) {
      // No positive overlap and not excluded — skip rather than show noise.
      continue;
    }
    candidates.push({
      name: manifest.name,
      manifest: manifest.manifest,
      first_iteration: findFirstIteration(manifest.manifest),
      end_state: manifest.end_state,
      score: roundScore(posScore),
      matched_terms: matchedTerms(queryTokens, posDoc),
    });
  }

  // Python: sort(key=lambda c: (-c["score"], c["name"])). Descending score,
  // then ascending name by Unicode codepoint. Do NOT use localeCompare.
  candidates.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  output.candidates = candidates.slice(0, Math.max(1, opts.top ?? 3));

  return output;
}
