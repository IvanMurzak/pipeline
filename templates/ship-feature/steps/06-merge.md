---
step_id: merge
---

# 06 — Merge on human approval

## Goal

With CI green, get an explicit human go-ahead and then squash-merge the PR into
`${PP_BASE}`. This is the terminal step. It MUTATES the remote — on failure it
HALTS; it is never auto-retried by an agent.

## Context

- `<pipeline-root>` is this pipeline's absolute root; `<run-id>` is the run id.
- The `## Graph` only routes here when the CI gate reported `ci_green: true`, so
  CI is green by construction — but the MERGE still requires a human decision.
- HUMAN-IN-THE-LOOP: the approval uses the `needs-input` outcome, which parks the
  run for an answer. **`needs-input` works ONLY under the headless runner
  (`pipeline drive`).** Under a manager-driven run there is no parking — in that
  case, HALT with the approval question as the halt reason so a human approves and
  resumes with `pipeline next --resume --start <this step>`.

## Inputs

- The PR: read `<pipeline-root>/.runtime/<run-id>/outputs/open-pr.json`
  (`pr_number`, `pr_url`).
- `${PP_BASE}` — the branch the PR merges into.

## Steps

1. Ask the human to approve the merge:
   - Headless run: report `outcome: needs-input` with
     `question.text` = "CI is green and the review passed — merge PR
     #<pr_number> into ${PP_BASE}? [merge / hold]",
     `question.options` = ["merge", "hold"], and `question.context` summarizing
     the feature, the PR url, and the CI result. The run parks; you resume with
     the answer.
   - Manager-driven run (no headless parking): HALT with that same question as
     the halt reason. Do not merge without an explicit approval.
2. On the answer:
   - "merge" → squash-merge and delete the branch:
     `gh pr merge <pr_number> --squash --delete-branch`.
   - "hold" (or any non-approval) → HALT with reason "human held the merge"; do
     NOT merge.

## Success Criteria

- On approval, `gh pr merge --squash` succeeded and the PR is merged into
  `${PP_BASE}`. On "hold", the run halted without merging.

## Failure handling

- This step mutates the remote. If `gh pr merge` fails, HALT with a clear reason
  (report `outcome: halted`); do NOT retry blindly.

## Next

Pipeline complete.
