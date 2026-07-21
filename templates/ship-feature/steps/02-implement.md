---
step_id: implement
---

# 02 — Implement the feature

## Goal

Implement the feature on a dedicated branch off `${PP_BASE}`, commit it, and
leave the project building/testing green. This step is also the loop-back target
for the review and CI-red fix loops (see the `## Graph`).

## Context

- `<pipeline-root>` is this pipeline's absolute root (from your run context);
  `<run-id>` is the current run id.
- This step runs on a FEATURE BRANCH, never on `${PP_BASE}` directly. A run
  worktree is NOT provisioned, so you manage the branch yourself with `git`.
- This step may run more than once in a run: the review step can loop back here
  with change requests, and the CI gate can loop back here on a red build. On a
  loop-back you AMEND the same branch and address the recorded notes — you do NOT
  start over.

## Inputs

- The plan from step 01: read `<pipeline-root>/.runtime/<run-id>/outputs/plan.json`
  (`plan`, and `verify` if present) when it exists.
- Change requests from a review loop-back: read
  `<pipeline-root>/.runtime/<run-id>/outputs/review.json` (`notes`) when it exists —
  its presence means the reviewer asked for changes; address every note.
- A prior branch name: read `<pipeline-root>/.runtime/<run-id>/outputs/implement.json`
  (`branch`) when it exists — reuse that exact branch across loop-backs.
- `${PP_BASE}` — the base branch to branch from.

## Steps

1. Determine the feature branch:
   - If `outputs/implement.json` has a `branch`, `git switch <branch>` to it.
   - Otherwise derive a short, stable kebab-case name from the task
     (e.g. `feature/<slug>`) and create it off the base:
     `git switch -c feature/<slug> ${PP_BASE}` (fetch/resolve `${PP_BASE}` first
     if it is a remote branch). Record it as `output.branch`.
2. If this is a review loop-back (a `review.json` with `notes` exists), read those
   notes and address every requested change. Otherwise implement from the plan/task.
3. Make the code changes to satisfy the feature (or the review notes).
4. Run the project's build/test command (the `verify` from step 01, or the
   project's standard one). Fix failures until it passes.
5. Stage and commit on the feature branch, following the project's commit
   conventions. Re-record `output.branch` (unchanged) so downstream steps have it.

## Success Criteria

- The changes are committed on the feature branch (off `${PP_BASE}`), the build/test
  command passes locally, and `output.branch` holds the branch name.

## Next

`<pipeline-root>/steps/03-review.md`

(Routing is governed by the `## Graph` in `PIPELINE.md`.)
