# 01 — Retrieve candidates

## Goal

Produce a ranked list of the documentation files most relevant to
`${PP_QUESTION}`, using dependency-free BM25 retrieval over `${PP_DOCS_DIR}`, and
record it as this step's `output.candidates` for the next step to consume.

## Context

- Retrieval is done by a bundled, deterministic script — no LLM judgement, no
  network, no installs: `<pipeline-root>/scripts/bm25_retrieve.ts` (run with
  `bun`, which every plugin user has). Your run context gives you this pipeline's
  absolute root; `<pipeline-root>` below means that path.
- The script is READ-ONLY — it only reads the docs folder. Do not edit any file.
- `${PP_DOCS_DIR}` may be relative (the script resolves a relative value against
  the pipeline root, so the bundled `./sample-docs` corpus works out of the box).

## Inputs

- `${PP_QUESTION}` — the question to retrieve for.
- `${PP_DOCS_DIR}` — the docs folder to search.
- `${PP_TOP_K}` — how many candidates to return.

## Steps

1. Run the retrieval script (a single Bash command):
   `bun "<pipeline-root>/scripts/bm25_retrieve.ts" --docs "${PP_DOCS_DIR}" --question "${PP_QUESTION}" --top-k ${PP_TOP_K}`
   It prints a JSON object
   `{ "docs_dir": "<abs>", "candidates": [ { "file", "score", "snippet" }, ... ] }`
   on stdout (scores descending; each `file` is relative to `docs_dir`, so the
   real file is `<docs_dir>/<file>`). Exit 0 = success; exit 2 = a bad flag or a
   missing docs folder.
2. Parse that JSON. Record BOTH `docs_dir` and the `candidates` array verbatim as
   this step's structured `output`, so the next step can read them from the run's
   outputs store (the absolute `docs_dir` removes any cwd ambiguity downstream).
3. If `candidates` is empty (the question matches no docs), still record
   `output.candidates: []` (with `docs_dir`) — the selection step will handle
   "no relevant source".

## Success Criteria

- The script exited 0 and this step's `output` holds `docs_dir` plus the ranked
  `candidates` array it printed (possibly empty). No files were modified.

## Next

`<pipeline-root>/steps/02-select.md`
