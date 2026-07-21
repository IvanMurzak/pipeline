# example-minimal

## End State

Describe the finished, checkable result this pipeline produces. Replace this
with the concrete end state for your own workflow.

## Scope

In:
- What this pipeline is responsible for.

Out:
- What it deliberately does NOT do.

## Project Context

This is the `example-minimal` template — a smallest-valid, two-step sequential
pipeline you copy with `pipeline clone example-minimal` and then adapt. Rename
the folder, rewrite each `steps/*.md` iteration to your own workflow, and delete
this note.

## Invariants

- Two steps run in order: `01-prepare.md` then `02-finish.md`.
- `02-finish.md` is the terminal step (its `## Next` says the pipeline is complete).
