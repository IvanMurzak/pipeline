---
step_id: plan
---

# 01 — Plan the feature

## Goal

Turn the run's task (the feature request) into a short, concrete implementation
plan the next step can execute — which files to touch and how to verify the work.

## Context

- The feature to build is the run's `--task`. Read it from your run context (or,
  when running headless, from the run's `task.md`). Do NOT invent scope beyond it.
- `<pipeline-root>` below is this pipeline's absolute root, provided in your run
  context. This step is READ-ONLY — it plans, it does not edit code.

## Inputs

- The run's task text (the feature to implement).
- The project's own conventions (its `CLAUDE.md` / README / test command), if present.

## Steps

1. Read the task and restate the feature in one or two sentences.
2. Explore the repository enough to locate the files the feature will touch and
   the project's build/test command (read-only — do not modify anything).
3. Produce a concise plan: the files to change, the approach, and exactly how the
   result will be verified (the build/test command to run).
4. Record this step's structured `output`: `output.plan` (the plan text) and, if
   you identified them, `output.verify` (the build/test command) — so the
   implement step can read it from `<pipeline-root>/.runtime/<run-id>/outputs/plan.json`.

## Success Criteria

- A concrete plan exists that names the files to change and the verification
  command. No files in the project were modified.

## Next

`<pipeline-root>/steps/02-implement.md`

(Routing is governed by the `## Graph` in `PIPELINE.md`; this `## Next` is the
primary forward hint only.)
