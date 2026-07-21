# Pipeline: support-answer

## End State

A concise, grounded answer to the user's question, drawn from a local folder of
docs and citing the exact source file it came from.

## Scope

In:
- BM25 retrieval over a local docs folder (read-only), agent selection of the
  best source, and a grounded answer with a citation.

Out:
- Writing to the docs or the user's code, network calls, and multi-source
  synthesis (each answer is grounded in a single best source).

## Project Context

- Root: the consumer project this pipeline was cloned into.
- Docs: a folder of `.md` / `.txt` files (`PP_DOCS_DIR`); a bundled
  `sample-docs/` corpus ships so a bare run works with zero config.
- Retrieval: `scripts/bm25_retrieve.ts` (Bun, stdlib-only, no network, no LLM);
  it self-tests via `bun test scripts/tests/` from this pipeline root.

## Invariants

- READ-ONLY: no step writes to the docs or the user's code; the pipeline touches
  nothing outside its own run state.
- Each answer is grounded in exactly ONE selected source file and cites it.
- No network and no external installs — pure local retrieval.

## Variables

- PP_DOCS_DIR (default: ./sample-docs) — docs folder to search; a relative value resolves against this pipeline root (so the default hits the bundled corpus), an absolute value points at your own docs.
- PP_QUESTION (default: How do I get started?) — the question to answer.
- PP_TOP_K (default: 5) — number of BM25 candidates to retrieve.
