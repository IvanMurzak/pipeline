# Pipeline: ship-feature

## End State

The run's task ships as a feature branch: implemented, self-reviewed with a
bounded fix loop, opened as a GitHub PR, and — once CI is green and a human
approves — squash-merged into the base.

## Scope

In: plan, implement, bounded self-review loop, open/reuse a PR, wait for CI,
human-approved merge. Out: deciding what to build (the task states it),
versioning, deploy.

## Project Context

- Root: the git repo this was cloned into (GitHub remote).
- Needs `git` and an authenticated `gh` on PATH, plus CI on the repo.
- The feature comes from the run's `--task`.

## Invariants

- Work stays on a feature branch off `${PP_BASE}`; the base is never edited directly.
- Mutating steps (open-pr, merge) HALT on failure — never auto-retried.
- Merge needs green CI AND human approval; both fix loops are graph-bounded (max 3).

## Variables

- PP_BASE (default: main) — the base branch to branch from and squash-merge into.

## Graph

```json
{
"plan":{"goto":"implement"},
"implement":{"goto":"review"},
"review":[{"when":"changes_requested","goto":"implement","max":3},{"goto":"open-pr"}],
"open-pr":{"goto":"ci-wait"},
"ci-wait":[{"when":"ci_green","goto":"merge"},{"goto":"implement","max":3}],
"merge":{"done":true}
}
```
