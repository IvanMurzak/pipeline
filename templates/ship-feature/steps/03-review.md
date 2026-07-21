---
step_id: review
---

# 03 — Self-review the diff

## Goal

Review the feature branch's diff against `${PP_BASE}` and decide, as a factual
boolean, whether changes must be applied before opening a PR. This step DRIVES
the bounded fix loop: if it requests changes, the `## Graph` routes back to
`02-implement` (up to 3 times), otherwise it falls through to `04-open-pr`.

## Context

- `<pipeline-root>` is this pipeline's absolute root; `<run-id>` is the run id.
- This step is READ-ONLY: it reviews and records notes; it never edits code and
  never runs git-mutating commands.
- No `code-reviewer` agent ships with this plugin, so the review is done INLINE
  in this step. For a large diff you MAY spawn ONE synchronous, read-only
  `Explore` helper to locate affected call sites and fold its findings into your
  review — do NOT spawn a `general-purpose` agent, and never let a helper edit.

## Inputs

- The feature branch: read `<pipeline-root>/.runtime/<run-id>/outputs/implement.json`
  (`branch`).
- `${PP_BASE}` — the base to diff against.
- The run's task (the feature the diff is supposed to deliver).

## Steps

1. Read the diff: `git diff ${PP_BASE}...HEAD` on the feature branch (and
   `git diff --stat` for scope).
2. Review it against the task and the project's conventions: correctness,
   obvious bugs, missing tests, and anything that must change before this is
   PR-ready. Keep it to genuine blockers — do not invent nitpicks.
3. Decide the outcome:
   - If there are blocking changes, write them into this step's
     `output.notes` (a concrete, actionable list) and report the result flag
     `changes_requested: true`.
   - If the diff is PR-ready, report `changes_requested: false` (no notes needed).

## Success Criteria

- The diff was reviewed and the result flag `changes_requested` is reported as a
  fact: `true` (with `output.notes` listing the required changes) or `false`. No
  files were modified.

## Next

`<pipeline-root>/steps/04-open-pr.md`

(Routing is governed by the `## Graph` in `PIPELINE.md`: `changes_requested:true`
loops back to `02-implement` — bounded to 3 — otherwise it proceeds here.)
