---
step_id: open-pr
---

# 04 — Open (or reuse) the pull request

## Goal

Push the feature branch and ensure a GitHub PR into `${PP_BASE}` exists for it,
recording the PR number for the CI gate. This step MUTATES the remote — on
failure it HALTS; it is never auto-retried by an agent.

## Context

- `<pipeline-root>` is this pipeline's absolute root; `<run-id>` is the run id.
- Requires an authenticated `gh` CLI. This step is idempotent: the CI-red loop
  can re-enter it, so it must REUSE an existing PR rather than fail on a
  duplicate.

## Inputs

- The feature branch: read `<pipeline-root>/.runtime/<run-id>/outputs/implement.json`
  (`branch`).
- `${PP_BASE}` — the PR base branch.
- The run's task (source of the PR title and body).

## Steps

1. Push the feature branch to the remote (set upstream on first push):
   `git push -u origin <branch>`.
2. Check whether a PR already exists for this head branch:
   `gh pr list --head <branch> --base ${PP_BASE} --json number,url` (or
   `gh pr view <branch> --json number,url`). If one exists, REUSE it — capture
   its number and url; do not create a second.
3. Otherwise create it, deriving the title/body from the feature (the task):
   `gh pr create --base ${PP_BASE} --head <branch> --title "<title>" --body "<body>"`.
4. Record `output.pr_number` and `output.pr_url` for the CI gate and merge steps.

## Success Criteria

- A single PR for the feature branch targets `${PP_BASE}`, and `output.pr_number`
  (plus `output.pr_url`) is recorded.

## Failure handling

- This step mutates the remote. If `git push` or `gh pr create` fails, HALT with
  a clear reason (report `outcome: halted`). Do NOT retry blindly and do NOT
  fabricate a PR number — a human resumes after fixing the cause.

## Next

`<pipeline-root>/steps/05-ci-wait.md`

(Routing is governed by the `## Graph` in `PIPELINE.md`.)
