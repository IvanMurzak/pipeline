---
step_id: ci-wait
---

# 05 — Wait for CI

## Goal

Block until the pull request's CI reaches a terminal state, then report the
factual result flag `ci_green` so the `## Graph` can route: green → `06-merge`,
red → back to `02-implement` (bounded to 3) to fix and re-push.

## Context

- `<pipeline-root>` is this pipeline's absolute root; `<run-id>` is the run id.
- Use the bundled CI gate — a SINGLE blocking call that polls `gh` in-process,
  fails fast on the first failed check, and times out on stuck CI. Do NOT
  hand-roll a sleep-and-poll loop and do NOT wait on CI by reading `gh pr checks`
  tables in a loop yourself.

## Inputs

- The PR number: read `<pipeline-root>/.runtime/<run-id>/outputs/open-pr.json`
  (`pr_number`); if that is unavailable, resolve it with
  `gh pr view <branch> --json number` for the feature branch.

## Steps

1. Run the bundled gate in ONE Bash call (set the Bash timeout at or above the
   gate's `--timeout`, default 1800s):
   `pipeline ci-wait --pr <pr_number> --json`
   If `pipeline` is not on PATH, use the plugin copy:
   `bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" ci-wait --pr <pr_number> --json`.
2. Branch on the exit code (do not re-parse the wait yourself):
   - `0` → all checks passed. Report `ci_green: true`.
   - `1` (a check failed), `3` (timeout), or `4` (no checks appeared) → report
     `ci_green: false`. Capture the gate's JSON `detail` / `failed_checks` into
     `output.ci` so the implement loop knows what failed.
3. Record `output.ci` (the gate's JSON result) for the loop-back / merge steps.

## Success Criteria

- The gate ran to a terminal state and `ci_green` is reported as a fact
  (`true` only on exit code 0). No files were modified.

## Next

`<pipeline-root>/steps/06-merge.md`

(Routing is governed by the `## Graph` in `PIPELINE.md`: `ci_green:true` proceeds
to `06-merge`; otherwise it loops back to `02-implement`, bounded to 3.)
