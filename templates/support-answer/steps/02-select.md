# 02 — Select the best source

## Goal

From the retrieved candidates, choose the SINGLE best source file to ground an
answer to `${PP_QUESTION}`, and record that choice with a brief rationale.

## Context

- The previous step (`01-retrieve`) recorded its results as output. Read them
  from the run's outputs store:
  `<pipeline-root>/.runtime/<run-id>/outputs/01-retrieve.json` — an absolute
  `docs_dir` and the `candidates` array (equivalently
  `${steps.01-retrieve.output.candidates}`). Your run context provides `<run-id>`
  and this pipeline's absolute root.
- Each candidate `file` is relative to `docs_dir`, so a candidate's real path is
  `<docs_dir>/<file>` — read it there (no cwd guessing).
- BM25 ranks by term overlap; the top hit is not always the best fit, which is
  exactly why a reading step follows retrieval. Read the candidates and judge.
- READ-ONLY: read files only; never modify anything.

## Inputs

- `docs_dir` and the `candidates` array from `01-retrieve` (`file`, `score`,
  `snippet` each; `file` relative to `docs_dir`).
- `${PP_QUESTION}` — the question the source must be able to answer.

## Steps

1. Read `docs_dir` and `candidates`. If `candidates` is empty, record
   `output.selected: null` (still carry `docs_dir`) with a one-line note that no
   local doc matched, and proceed (the answer step will say the docs do not cover
   the question).
2. Otherwise open the top few candidate files at `<docs_dir>/<file>` and read the
   passages around their snippets.
3. Pick the ONE file whose content best and most directly answers
   `${PP_QUESTION}`. Prefer a direct, on-topic source over a merely
   high-BM25-score one.
4. Record this step's `output`: `docs_dir` (carried through), `selected` (the
   chosen `file`, relative to `docs_dir`) and `reason` (one sentence on why).

## Success Criteria

- `output.selected` is exactly one candidate `file` (or `null` when there were no
  candidates), alongside `docs_dir` and a one-sentence `reason`. No files were
  modified.

## Next

`<pipeline-root>/steps/03-answer.md`
