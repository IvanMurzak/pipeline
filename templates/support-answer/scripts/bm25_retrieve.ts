// support-answer / 01-retrieve: dependency-free BM25 retrieval over a local
// folder of docs.
//
// Ranks the files in a docs directory against a natural-language question using
// Okapi BM25 (pure stdlib — no pip/npm installs, no network, no LLM).
//
// STDOUT IS THE SCRIPT-STEP RESULT OBJECT (docs/script-steps.md §3.5) — step
// 01 is `type: script`, so the command layer, not an agent, reads this:
//
//   {
//     "ok": true,
//     "summary": "3 candidate(s) for \"How do I get started?\"",
//     "flags":   { "has_candidates": true },
//     "output":  {
//       "docs_dir": "<absolute path the docs were read from>",
//       "candidates": [ { "file": "<path relative to docs_dir>", "score": <number>, "snippet": "<text>" }, ... ]
//     }
//   }
//
// `output` is what the runtime persists to
// `<pipeline-root>/.runtime/<run-id>/outputs/01-retrieve.json`, which is the
// exact file steps 02/03 already read — so the envelope is a wrapper around the
// SAME payload this script has always produced, never a different one.
//
// `file` is relative to `docs_dir`, so a consumer resolves the real file as
// `<docs_dir>/<file>` with no cwd ambiguity.
//
// **`ok:false` means "this script could not do its job" — NEVER "the answer is
// no".** A question that matches nothing is `ok:true` with `candidates: []`
// (§3.6): step 02 is what decides how to handle "no source", and an `ok:false`
// there would halt the whole run instead.
//
// It is READ-ONLY: it reads the docs directory and writes nothing anywhere.
//
// Interpreter: Bun (the plugin's guaranteed runtime — every user who installs
// `@baizor/pipeline` has Bun; Python3 is not guaranteed, esp. on Windows). Uses
// only `node:fs` / `node:path`, so it runs identically on Windows and Linux.
//
// Usage:
//   bun scripts/bm25_retrieve.ts --docs ./sample-docs --question "How do I get started?" --top-k 5
//   bun scripts/bm25_retrieve.ts --help
//
// Every input has three sources, in precedence order: an explicit FLAG, then the
// matching pipeline variable in the ENVIRONMENT (`PP_DOCS_DIR` / `PP_QUESTION` /
// `PP_TOP_K` — the runtime puts every resolved `PP_*` into the child environment,
// docs/script-steps.md §2.5/§3.1), then the built-in default. That is why the
// step file passes no arguments at all: running under `pipeline next`, the
// variables arrive through the environment on their own.
//
// A RELATIVE docs path is resolved against this pipeline's root (the folder
// holding this scripts/ dir), so the bundled `./sample-docs` corpus works out of
// the box regardless of the caller's cwd (the runtime's cwd is the PROJECT root,
// not this folder). An ABSOLUTE path is used verbatim — point it at your corpus.
//
// Exit codes:
//   0 - ranking printed (0 candidates is still success — an empty corpus prints [])
//   2 - the docs directory does not exist (class `env`), or a usage error (bad
//       flag / bad --top-k, class `bug`). Both still print an `ok:false` result
//       object on stdout so the runtime gets a CLASSIFIED failure rather than a
//       bare non-zero exit it can only call `crash`.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { isAbsolute, join, resolve, relative, dirname } from 'node:path';

/** BM25 hyper-parameters — the standard Okapi defaults. */
const K1 = 1.5;
const B = 0.75;

/** Doc extensions treated as text. */
const TEXT_EXTS = new Set(['.md', '.txt', '.markdown', '.mdx', '.rst']);

/** A small, conservative English stop-word set. BM25's IDF already discounts
 *  ubiquitous terms; dropping these mainly keeps snippets focused on the
 *  meaningful query words (e.g. "how do i get started" → get / started). */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'of',
  'on', 'or', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'we', 'what', 'when', 'where', 'which', 'who', 'why',
  'will', 'with', 'you', 'your',
]);

/** Lowercase, split on non-alphanumerics, drop empties, stop-words and
 *  single-character tokens. Deterministic and locale-independent. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

export interface Doc {
  /** Stable identifier (relative POSIX path within the corpus). */
  file: string;
  text: string;
}

export interface Candidate {
  file: string;
  score: number;
  snippet: string;
}

/** Pick the most relevant ~single-line snippet from a doc for the query: the
 *  non-blank line containing the most DISTINCT query terms (first such line on a
 *  tie — deterministic), whitespace-collapsed and truncated. Falls back to the
 *  doc's first non-blank line when no query term appears. */
export function bestSnippet(text: string, queryTerms: Set<string>, maxLen = 200): string {
  let best: string | null = null;
  let bestHits = 0;
  let firstNonBlank: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (firstNonBlank === null) firstNonBlank = line;
    const lineTerms = new Set(tokenize(line));
    let hits = 0;
    for (const t of queryTerms) if (lineTerms.has(t)) hits++;
    if (hits > bestHits) {
      bestHits = hits;
      best = line;
    }
  }
  const chosen = (bestHits > 0 ? best : firstNonBlank) ?? '';
  const collapsed = chosen.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen - 1).trimEnd() + '…' : collapsed;
}

/** Round to 4 decimals so output is byte-stable across platforms. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Rank `docs` against `query` with Okapi BM25; returns the top-`topK`
 *  candidates, score-descending, ties broken by `file` ascending (deterministic).
 *  Docs with a non-positive score are dropped. */
export function bm25Rank(docs: Doc[], query: string, topK: number): Candidate[] {
  const queryTerms = tokenize(query);
  const queryTermSet = new Set(queryTerms);
  const N = docs.length;
  if (N === 0 || queryTerms.length === 0) return [];

  // Per-doc term frequencies + lengths.
  const tf: Array<Map<string, number>> = [];
  const lengths: number[] = [];
  for (const doc of docs) {
    const toks = tokenize(doc.text);
    const counts = new Map<string, number>();
    for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
    tf.push(counts);
    lengths.push(toks.length);
  }
  const avgdl = lengths.reduce((a, b) => a + b, 0) / N || 1;

  // Document frequency per UNIQUE query term.
  const df = new Map<string, number>();
  for (const t of queryTermSet) {
    let n = 0;
    for (const counts of tf) if (counts.has(t)) n++;
    df.set(t, n);
  }
  // IDF (BM25's non-negative "plus-one" variant: ln(1 + (N-n+0.5)/(n+0.5))).
  const idf = new Map<string, number>();
  for (const t of queryTermSet) {
    const n = df.get(t) ?? 0;
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const scored: Candidate[] = [];
  for (let i = 0; i < N; i++) {
    const counts = tf[i]!;
    const dl = lengths[i]!;
    let score = 0;
    for (const t of queryTermSet) {
      const f = counts.get(t) ?? 0;
      if (f === 0) continue;
      const denom = f + K1 * (1 - B + (B * dl) / avgdl);
      score += (idf.get(t) ?? 0) * ((f * (K1 + 1)) / denom);
    }
    if (score > 0) {
      scored.push({
        file: docs[i]!.file,
        score: round4(score),
        snippet: bestSnippet(docs[i]!.text, queryTermSet),
      });
    }
  }

  scored.sort((a, b) => (b.score - a.score) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return scored.slice(0, topK);
}

// --- CLI ---------------------------------------------------------------------

const HELP = `bm25_retrieve — dependency-free BM25 retrieval over a local docs folder.

Usage:
  bun scripts/bm25_retrieve.ts [--docs <dir>] [--question <text>] [--top-k <n>]

Options:
  --docs <dir>        Folder of .md/.txt docs to search. Relative paths resolve
                      against the pipeline root; default "./sample-docs".
  --question <text>   The question to rank docs against. Default "How do I get started?".
  --top-k <n>         Number of candidates to return. Default 5.
  --help              Show this help.

Each option also reads its pipeline variable from the environment when the flag
is absent: PP_DOCS_DIR, PP_QUESTION, PP_TOP_K (flag > environment > default).

Prints the script-step result object on stdout:
{"ok":true,"summary":…,"flags":{"has_candidates":…},
 "output":{"docs_dir":…,"candidates":[{"file","score","snippet"}]}}  (score-descending)
Read-only; no network; no LLM. Exit 0 on success, 2 on a usage/dir error.`;

interface Args {
  docs: string;
  question: string;
  topK: number;
}

/** Built-in defaults — the LAST tier of `flag > environment > default`. Kept
 *  byte-identical to the `## Variables` defaults in PIPELINE.md, so running the
 *  script by hand and running it through the pipeline agree. */
const DEFAULTS: Args = { docs: './sample-docs', question: 'How do I get started?', topK: 5 };

/** The environment names of this pipeline's declared `PP_*` variables. */
const ENV_NAMES = { docs: 'PP_DOCS_DIR', question: 'PP_QUESTION', topK: 'PP_TOP_K' } as const;

/** Validate a top-k value from any tier. Throws a usage string (the caller
 *  turns it into an `ok:false` / class `bug` result). `src` names the tier so a
 *  bad `PP_TOP_K` in the environment does not read as a bad flag. */
function parseTopK(raw: string, src: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw `${src} must be a positive integer (got '${raw}')`;
  return n;
}

/** Parse argv (supports `--flag value` and `--flag=value`) over `env`. Throws a
 *  string on a usage error; returns null when `--help` was requested.
 *
 *  Precedence is `flag > environment > default`, matching the CLI's own
 *  variable resolution (`--var` > environment > manifest default) so a value
 *  reaches this script the same way whichever path invoked it. An EMPTY
 *  environment value is treated as absent — the runtime only exports variables
 *  it actually resolved, and an empty `PP_DOCS_DIR` would otherwise resolve the
 *  docs dir to the pipeline root itself. */
export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): Args | null {
  const fromEnv = (name: string): string | undefined => {
    const v = env[name];
    return v !== undefined && v.trim() !== '' ? v : undefined;
  };
  const envTopK = fromEnv(ENV_NAMES.topK);
  const args: Args = {
    docs: fromEnv(ENV_NAMES.docs) ?? DEFAULTS.docs,
    question: fromEnv(ENV_NAMES.question) ?? DEFAULTS.question,
    topK: envTopK !== undefined ? parseTopK(envTopK, ENV_NAMES.topK) : DEFAULTS.topK,
  };
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i]!;
    let inlineVal: string | undefined;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq !== -1) {
      inlineVal = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    const takeVal = (): string => {
      if (inlineVal !== undefined) return inlineVal;
      const v = argv[++i];
      if (v === undefined) throw `missing value for ${flag}`;
      return v;
    };
    switch (flag) {
      case '--help':
      case '-h':
        return null;
      case '--docs':
        args.docs = takeVal();
        break;
      case '--question':
        args.question = takeVal();
        break;
      case '--top-k':
      case '--topk':
        args.topK = parseTopK(takeVal(), '--top-k');
        break;
      default:
        throw `unknown flag '${flag}'`;
    }
  }
  return args;
}

/** Collect readable text files (recursively) under `dir` as Docs keyed by their
 *  POSIX path relative to `dir`. Deterministic (sorted). */
export function loadCorpus(dir: string): Doc[] {
  const docs: Doc[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const dot = name.lastIndexOf('.');
        const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
        if (!TEXT_EXTS.has(ext)) continue;
        docs.push({ file: relative(dir, full).split('\\').join('/'), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(dir);
  docs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return docs;
}

// --- The script-step result object (docs/script-steps.md §3.5) ---------------

/** A successful result. `output` is the payload the runtime persists to the
 *  outputs store — the RESOLVED absolute `docs_dir` travels with the candidates
 *  so a consumer reads each file as `<docs_dir>/<file>`, never depending on its
 *  own cwd or on re-deriving where a relative docs path pointed.
 *
 *  `has_candidates` is a routing flag: it is not used by this pipeline's linear
 *  graph, but it is the hook to add a "no source found" branch without touching
 *  any step body — routing lives in PIPELINE.md's `## Graph`. */
export function successResult(docsDir: string, candidates: Candidate[], question: string) {
  const q = question.length > 60 ? `${question.slice(0, 59)}…` : question;
  return {
    ok: true as const,
    summary: `${candidates.length} candidate(s) for "${q}" in ${docsDir}`,
    flags: { has_candidates: candidates.length > 0 },
    output: { docs_dir: docsDir, candidates },
  };
}

/** A failure result. `class` is the script's own self-classification, which the
 *  runtime TRUSTS (§5.1): `env` = this machine/config is wrong (halts without
 *  burning an agent on it), `bug` = this invocation was malformed. Never
 *  `transient` — nothing here retries usefully, there is no network. */
export function failureResult(cls: 'env' | 'bug', detail: string) {
  return { ok: false as const, summary: `bm25_retrieve failed (${cls})`, error: { class: cls, detail } };
}

/** stdout carries the result object and NOTHING else; every human-facing line
 *  goes to stderr (§3.5 — the runtime takes the last stdout line that parses as
 *  a JSON object, and diagnostics on stdout are what break that). */
function emit(result: unknown, exitCode: number): never {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(exitCode);
}

function main(): void {
  let args: Args | null;
  try {
    args = parseArgs(Bun.argv.slice(2), process.env);
  } catch (e) {
    process.stderr.write(`bm25_retrieve: ${String(e)}\n\n${HELP}\n`);
    emit(failureResult('bug', String(e)), 2);
  }
  if (args === null) {
    // `--help` is a human asking a question; it is not a pipeline invocation,
    // so it prints help (not a result object) and succeeds.
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  // Resolve the docs dir: absolute as-is; relative against the pipeline root
  // (this file lives in <pipeline-root>/scripts/), so the bundled ./sample-docs
  // works from any cwd.
  const pipelineRoot = dirname(import.meta.dir);
  const docsDir = isAbsolute(args.docs) ? args.docs : resolve(pipelineRoot, args.docs);
  if (!existsSync(docsDir) || !statSync(docsDir).isDirectory()) {
    const detail = `docs directory not found: ${docsDir}`;
    process.stderr.write(`bm25_retrieve: ${detail}\n`);
    emit(failureResult('env', detail), 2);
  }

  const corpus = loadCorpus(docsDir);
  const candidates = bm25Rank(corpus, args.question, args.topK);
  // A question that matches nothing is a SUCCESS with an empty list (§3.6) —
  // "no local doc covers this" is a domain answer for step 02 to handle, not a
  // failure of retrieval.
  emit(successResult(docsDir, candidates, args.question), 0);
}

if (import.meta.main) main();
