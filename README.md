# `pipeline` CLI

A single local CLI that holds the **deterministic, LLM-free** work of the
Claude-Pipeline plugin. Agents shell out to it (or `import` it) so control-flow
work — enumerating steps, resolving models, building/validating the DAG, matching
tasks to pipelines, routing graph pipelines, driving the whole run loop, and
emitting UI events — costs **near-zero LLM tokens** instead of being done in an
agent's context. The one non-computation is `ui`, a thin launcher for the
dashboard daemon.

## Runtime

Written in TypeScript, run directly with **Bun** (no build step needed for the
plugin's own use, exactly like `apps/pipeline-ui/server.ts`):

```bash
bun "${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts" <command> [options]
```

For embedding in another local project you can either import the library API or
produce a Node-targeted bundle:

```bash
bun run build          # → dist/cli.mjs (Node-compatible ESM)
```

## Commands

### `plan` — compute the execution plan

```bash
bun src/cli.ts plan --root <abs-path-to-pipeline-root> [--default-model <m>]
```

Reads `PIPELINE.md` + every `steps/**/*.md` frontmatter (never bodies) and prints
a compact JSON plan: `mode` (sequential | parallel), `isolation`, resolved
`default_model`, the ordered `steps` (each with `step_id`, effective `model`,
`depends_on`), the DAG `layers` (parallel only), plus `errors` and `warnings`.

Exit code is `1` when `errors` is non-empty (caller should halt), `0` otherwise.

**Mode gate:** a pipeline runs in parallel/DAG mode **only** when `PIPELINE.md`
declares `execution: parallel`. Steps that declare `depends-on` without that flag
run sequentially and emit a warning. This keeps the common (sequential) case at
O(1) reads on a run start.

### `drive` — run an entire pipeline headless (EXPERIMENTAL)

```bash
bun src/cli.ts drive --root <pipeline_root> --run-id <id> --start <iteration-path>
  [--default-model <m>] [--model <step_id>=<m> ...]
  [--default-effort <level>] [--effort <step_id>=<level> ...]
  [--var NAME=value ...] [--vars-file <path>]
  [--answer <text> | --answer-file <path>]
  [--task <text> | --task-file <path>]
  [--executor-cmd <template>] [--json] [--resume]
```

The **headless executor**: an EXPERIMENTAL single-process runner that replaces the
pipeline-manager LLM. It executes an entire pipeline run using deterministic
control flow (no agent spawns), ideal for automation and testing.

**Executor retry environment (08.4):**
- Sets `CLAUDE_CODE_RETRY_WATCHDOG=1` (lifts retry cap for transient errors)
- Sets `CLAUDE_CODE_MAX_RETRIES=15` (hard cap for transient retries)
- Overridable by explicitly setting these env vars before the spawn
- Documented mechanism for unattended sessions (Claude Code 2.1.199+)

**Exit codes:**
- `0` completed
- `1` halted (includes provider-limit error info when present)
- `2` usage/argument error
- `3` blocked (awaiting nested blocker resolution)
- `4` awaiting-input (parked on a needs-input question)

**Needs-input (park/resume):**
- Each question carries a correlatable `question_id` (06.2.1) for cloud-dispatcher alignment
- Parks with `exit 4` and includes the question in the final JSON
- Resume with `--resume --answer <text>` to deliver the answer and continue the SAME session

**Provider limits (06.7):**
- Detects usage/rate-limit errors from the executor envelope
- Includes `provider_limit: {reason, retry_after_ms?}` in the exit-1 (halted) JSON
- Reason: `rate_limit_exceeded` | `overloaded`

### Library use

```ts
import { computePlan } from '@baizor/pipeline/plan';
const plan = computePlan('/abs/path/to/.claude/pipeline/my-pipeline');
```

### `match` — find the best-matching pipeline

```bash
bun src/cli.ts match --pipelines-dir <dir> (--task "<text>" | --issue <ref>) [--top N] [--neg-threshold N]
```

The BM25 pipeline matcher. Scores every `PIPELINE.md` under `--pipelines-dir` with
Okapi BM25 over the positive corpus (name + End State + Scope.In + Glossary) and
hard-filters on the negative corpus (Scope.Out) by keyword overlap. Prints
`{task, candidates, excluded}` JSON. Used by `/pipeline:find` and
`/pipeline:dispatch` tier 1.

### `event` — write a UI event / liveness / mirror binding

```bash
bun src/cli.ts event <type|write-liveness|clear-liveness|register-mirror-binding> [--project-root=/abs] [k=v ...]
```

The UI event writer. Appends one event envelope to
`<project>/.claude/pipeline/.runtime/events.jsonl` (or writes the per-run liveness
lockfile / mirror binding for the subcommands). `/pipeline:run` (lifecycle + liveness
+ mirror binding) and `pipeline-manager` (per-iteration events) call it. Always exits
0 (best-effort — never blocks the caller).

### `route` — decide the next step for a graph (Variant-A) pipeline

```bash
bun src/cli.ts route --root <pipeline_root> --run-id <id> --from <step_id> --flags '<json>' [--default-model <m>]
```

For a pipeline that opts into declarative routing — a `## Graph` JSON block in
`PIPELINE.md` mapping each `step_id` to conditional edges `{ when, goto | done,
max }` — this evaluates the graph + the result `--flags` the just-finished
`--from` step emitted + this run's per-edge counters (persisted at
`<pipeline_root>/.runtime/<run-id>/route.json`, gitignored) and prints the next
action: `{ action: "run", step_id, path, model }` / `{ action: "done" }` /
`{ action: "halt", reason }`. Exit 1 on `halt`.

This makes **bounded-retry loops** declarative — e.g. a `review` step that loops
back to `implement` up to `max: 3` times, then falls through to `package`:

```json
{
  "implement": { "goto": "review" },
  "review": [
    { "when": "changes_needed", "goto": "implement", "max": 3 },
    { "goto": "package" }
  ]
}
```

The counter/skip logic lives ONCE here, never duplicated across step bodies. A
pipeline with no `## Graph` section is untouched (legacy sequential/DAG).

### `next` — drive a whole run as a mechanical state machine

```bash
bun src/cli.ts next --root <pipeline_root> --run-id <id> [--start <iteration-path>] \
  [--default-model <m>] [--record '<json>'] [--resume]
```

The orchestration engine the `pipeline-manager` drives. Each call returns the
**next action** to perform, given the run's persisted state + the `--record` of
the action just performed. The manager loop is just:

```
action ← pipeline next --start <first-iteration>     # init (no --record)
loop: perform(action); action ← pipeline next --record '<outcome>'
```

It folds every deterministic control-flow decision — sequential advancement,
graph routing (reusing `route`'s counters), DAG-layer stepping, improver &
script-creator gating, and the end-of-run retrospective gate — into code, so the
manager only spawns, parses reports, merges worktrees, and emits events. Actions:

- `{ "action": "run-step", "concurrent": <bool>, "steps": [ { step_id, path, model, isolation, index }, … ] }` — run one step (`concurrent:false`, sequential/graph) or a whole DAG layer (`concurrent:true`, parallel).
- `{ "action": "merge", "branches": [ { step_id, branch, path }, … ] }` — merge parallel worktree branches (worktree isolation only).
- `{ "action": "run-improver", "iteration_path" }` — dispatch `pipeline-improver` for a step that emitted a brief.
- `{ "action": "run-script-creator", "iteration_path", "number", "of" }` — dispatch `pipeline-script-creator` for the i-th of the improver's `script_creation_briefs`.
- `{ "action": "retrospective" }` — run the Tier-2 end-of-run retrospective (only when `<root>/.feedback/<run-id>/` has files — the CLI counts them).
- `{ "action": "done" }` / `{ "action": "halt", "reason", "status" }` / `{ "action": "blocked" }` — terminate.

Records the manager sends back (`--record '<json>'`): `{kind:"step",…}`,
`{kind:"layer",results:[…]}`, `{kind:"merge",conflict,…}`,
`{kind:"improver",script_briefs:N}`, `{kind:"script",outcome}`,
`{kind:"retro",done:true}`. State persists at
`<pipeline_root>/.runtime/<run-id>/next.json` (gitignored). `--resume` (or any
no-record call on an existing run) re-enters at `--start` — used for nested-blocker
resumes and crashed-manager re-spawns. Exit code: `1` on a `halt` action, `0`
otherwise.

### `ui` — start / open the dashboard daemon

```bash
bun src/cli.ts ui [--open] [--json]
```

A thin launcher (NOT a daemon rewrite). Detects a running daemon via
`~/.claude/pipeline-ui/daemon.lock` + `/api/health`; if none is up it spawns the
**supervisor** (`apps/pipeline-ui/supervisor.ts`) detached, registers the current
project (`POST /api/register-cwd`) when it uses the pipeline plugin, and prints
the dashboard URL. `--open` also opens a browser; `--json` prints
`{url,host,port,pid,started,registered}`. Requires Bun (the daemon is a Bun
process). Locates the daemon via `${CLAUDE_PLUGIN_ROOT}` or by walking up from the
CLI's own directory, so it works both plugin-installed and embedded. The daemon's
single-instance / version-reconcile / liveness machinery is untouched — this only
launches it. `/pipeline:ui` routes through this command.

### `submodule bump` — record + push a guarded submodule-pointer change

```bash
bun src/cli.ts submodule bump --project-root <superproject> [--submodules a,b] \
  [--base <branch>] [--source-worktree <path>] [--dry-run] [--json]
```

A **guarded git primitive**: it records superproject submodule-pointer change(s)
on the base branch and pushes them, **isolation-safely** — the shared checkout is
NEVER `checkout`/`reset`/`switch`ed; its only mutation is `fetch` + `merge
--ff-only`. All branch/commit work happens in a throwaway worktree off
`origin/<base>`. This replaces AI-improvised "land a pointer bump" recipes with a
deterministic, tested command that **refuses** unsafe requests.

**Args**

- `--project-root <path>` (required) — the superproject checkout.
- `--submodules a,b` (optional) — the subset to consider; when omitted, drifted
  pointers are auto-detected from `<project-root>/.gitmodules`.
- `--base <branch>` (default `main`) — the branch to land onto.
- `--source-worktree <path>` (optional) — where the run's merged submodule state
  lives; when given, the run's intended pointer is read from that worktree
  (its submodule checkout HEAD, or the gitlink its HEAD records) rather than the
  superproject's live checkout.
- `--dry-run` — stage + capture the diff in the throwaway worktree, then STOP
  before push/PR/merge (mutates nothing on the base branch).
- `--json` / `--no-fetch` — JSON is always emitted; `--no-fetch` trusts the
  present remote-tracking refs (skips the read-only reachability fetch).

**Guards** (each maps to an incident it prevents):

- **fork-diff safety (#132)** — a pointer whose value differs only because the
  base advanced *past the run's fork* is NOT bumped/reverted.
- **conflict** — a pointer the base changed since the fork is skipped + surfaced,
  never clobbered.
- **reachability** — only bump to a commit reachable from the submodule's
  `origin/<default>` and strictly ahead of the recorded pointer.
- **pre-flight self-clean** — orphaned `land-*` throwaway worktrees + stale
  scratch branches from prior KILLED runs are reaped BEFORE anything is created
  (correctness never depends on a `finally`; idempotent under a mid-run kill).
- **STOP-on-error** — halts at the first error with a structured `halt_reason`
  and the exact manual recovery command; the post-merge reconcile of the shared
  checkout retries the transient index.lock / propagation-lag race, then halts.

**Output** — one JSON object:

```json
{
  "status": "committed|noop|dry-run|halted",
  "bumped":  [{ "path": "sub", "from": "<sha>", "to": "<sha>" }],
  "skipped": [{ "path": "sub", "reason": "<why>", "status": "unchanged-by-run|base-advanced-conflict|unreachable|…" }],
  "pr": "<url|null>", "infra_sha": "<sha|null>", "reconcile_status": "ff|skipped|failed|na",
  "merged_via_admin": false, "halt_reason": null
}
```

Exit code: `0` (committed / noop / dry-run) · `1` (halted) · `2` (usage / env —
bad args, not a git repo, or `gh` missing for a non-dry-run landing).

**GENERIC.** The command knows nothing about any specific project; config/args
drive everything. A project with no submodules resolves an empty candidate set →
noop. Assumes `git` + `gh` on PATH (like the pipeline's other git work); a missing
`gh` is a clean exit-2 env error.

## Tests

```bash
bun test tests/
```
