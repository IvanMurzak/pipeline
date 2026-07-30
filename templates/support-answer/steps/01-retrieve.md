---
# type: script — this whole step is deterministic software (BM25 over local
# files), so it runs IN-PROCESS with NO agent and NO LLM tokens. The command
# layer spawns the script, reads its stdout result object, and persists
# `output` to the run's outputs store; step 02 reads that file exactly as
# before. See docs/script-steps.md.
type: script
script: scripts/bm25_retrieve.ts
# The script takes no arguments here: the run's resolved PP_* variables arrive
# in the child environment on their own (script-steps.md §2.5/§3.1), and the
# script reads flag > environment > default.
timeout: 120
# Nothing here is transient — no network, no locks — so a mechanical re-run
# would only repeat the same result. retries stays at its default 0.
on-failure: halt
---

# 01 — Retrieve candidates

## Goal

Produce a ranked list of the documentation files most relevant to
`${PP_QUESTION}`, using dependency-free BM25 retrieval over `${PP_DOCS_DIR}`, and
record it as this step's `output.candidates` for the next step to consume.

## Context

- Retrieval is done by a bundled, deterministic script — no LLM judgement, no
  network, no installs: `<pipeline-root>/scripts/bm25_retrieve.ts` (run with
  `bun`, which every plugin user has).
- The script is READ-ONLY — it only reads the docs folder.
- `${PP_DOCS_DIR}` may be relative (the script resolves a relative value against
  the pipeline root, so the bundled `./sample-docs` corpus works out of the box
  — the runtime's cwd is the PROJECT root, not this folder).
- **A question that matches nothing is a SUCCESS**, not a failure: the script
  returns `ok:true` with `candidates: []`. `ok:false` is reserved for "retrieval
  could not run at all" (e.g. the docs folder does not exist), which halts the
  run with a classified failure record rather than handing step 02 a lie.
- **Why `on-failure: halt` and not `agent`:** the realistic failure here is a
  missing docs folder or a broken interpreter — class `env`, which halts
  regardless of this setting, because an agent cannot fix a broken machine and
  would only burn tokens re-doing deterministic work. The failure record and
  the feedback file are written either way.

## Inputs

- `${PP_QUESTION}` — the question to retrieve for.
- `${PP_DOCS_DIR}` — the docs folder to search.
- `${PP_TOP_K}` — how many candidates to return.

All three reach the script through the environment as `PP_QUESTION` /
`PP_DOCS_DIR` / `PP_TOP_K`; no wiring in this file is needed.

## Output

```json
{
  "docs_dir": {
    "type": "string",
    "required": true,
    "description": "Absolute path the docs were actually read from — carried forward so downstream steps resolve `<docs_dir>/<file>` with no cwd ambiguity."
  },
  "candidates": {
    "type": "array",
    "required": true,
    "description": "Ranked {file, score, snippet} objects, score-descending; `file` is relative to docs_dir. EMPTY when nothing matched — a valid, successful result."
  }
}
```

## Steps

1. Run: `bun "<pipeline-root>/scripts/bm25_retrieve.ts"` — ranks the docs and
   prints `{"ok":true,"output":{"docs_dir":…,"candidates":[…]}}` on stdout.
   (This line is what an older runtime that does not understand `type: script`
   would execute as a plain agent step; the current runtime never reads it.)

## Success Criteria

- The script exited 0 and this step's `output` holds `docs_dir` plus the ranked
  `candidates` array it printed (possibly empty). No files were modified.

## Next

`<pipeline-root>/steps/02-select.md`

(Routing is declared in `PIPELINE.md`'s `## Graph`; this line documents the
sequence and is what an older runtime would follow.)
