# Hooks under bare mode: what `driver` does

**Status:** decision document (task `j2-bare-hooks-decision`). No source change — a
later task implements whatever this decides. Builds on `docs/bare-baseline.md`
(j1's measured baseline, Claude Code 2.1.227) and
`.taskflow/2026-08-03-execution-modes/02-standalone-executor.md` (the
`standalone` design, which delegated this exact question to j2/j3/j4).

**Scope reminder:** this is about `driver` (`pipeline drive`,
`src/commands/drive.ts`), which spawns a fresh `claude -p` subprocess per step
via `DEFAULT_EXECUTOR_TEMPLATE` (`src/commands/drive.ts:416`). It is not about
`session`/`manager` (Agent-tool nesting inside one long-lived session) or
`standalone` (the Agent SDK executor, `src/lib/executors/sdk.ts`), which are
unaffected by `-p`'s bare default — `standalone` never shells `claude -p` at
all, and `session`/`manager` are excluded from the flip per
`02-standalone-executor.md`'s own framing ("only `driver`, since
`session`/`manager` use the Agent tool and `standalone` uses the SDK, whose
defaults are full").

## Decision

**Accept the loss.** None of the plugin's registered hooks are needed for a
step to be *correct* — every one of them is telemetry or convenience, and for
`driver` specifically, the telemetry categories are already substantially
duplicated by mechanisms `driver` runs natively, independent of Claude Code's
hook system. The residual gap is a narrower, delayed safety net for
`.pipeline/.stats/` reconciliation on an abnormal crash, plus two
cross-session convenience features that do not apply to a headless per-step
spawn in the first place. See "Recommendation and its cost" below for the
full accounting, and "What survives via `--settings`" for why the documented
alternative does not change this conclusion — it does not survive at all, by
direct measurement.

## 1. What the hooks do today, enumerated and classified

Source of truth: `public/plugin/pipeline-claude/hooks/hooks.json` and
`hooks/run-hook.sh` (read-only, superproject checkout). No `.claude/settings.json`
or other settings-level hooks exist in either this repository or the plugin
repository — checked with a recursive search for `settings*.json` in both
trees; none found. So the plugin's `hooks.json` is the *entire* enumeration;
there is no second, settings-defined source to add to it.

Seven hook registrations, five distinct relays (all now CLI subcommands —
`pipeline hook <name>` — not files in the plugin, per plugin-thin `p6`):

| Event | Matcher | Relay | What it does | Category |
|---|---|---|---|---|
| `Stop` | — | `analytics-relay` | token usage from transcript | telemetry |
| `Stop` | — | `stats-relay` | token + tool-failure enrichment into `.pipeline/.stats/` | telemetry |
| `SubagentStop` | `pipeline-manager` | `analytics-relay` | `manager.stopped` liveness signal | telemetry |
| `SubagentStop` | `pipeline-manager` | `stats-relay` | same `.stats/` enrichment, keyed to a manager subagent ending | telemetry |
| `SessionStart` | — | `session-relay` (`--loud`) | appends one `session.opened` line to `.pipeline/.runtime/events.jsonl` | telemetry |
| `SessionStart` | — | `department-notifier-relay` | ensures the `pipeline department notify` daemon is running; drains its pending-notification journal into `SessionStart` `additionalContext` | convenience |
| `PreToolUse` | `^(Agent\|Task\|TaskCreate)$` | `analytics-relay` | live mirror binding + run-level "bypass" `pipeline.started` synthesis for directly-spawned `pipeline-manager`s | telemetry |
| `PostToolUse` | — | `analytics-relay` | tool counts + agent spawns + bypass `pipeline.completed`/`halted` synthesis | telemetry |
| `UserPromptSubmit` | — | `prompt-match-relay` (opt-in, `PIPELINE_PROMPT_MATCH_ENABLED`, **default OFF**) | BM25-suggests a pipeline for the submitted prompt | convenience |
| `Notification` | — | `analytics-relay` | `run.awaiting_input` signal | telemetry |

**The correctness bucket is empty.** No hook here gates, validates, or
performs work that a step's `Success Criteria` depend on — `step-executor.md`
never reads a hook's output, and nothing in the hooks writes to a location an
iteration reads from. Every registration is either observability
(`analytics-relay`, `stats-relay`, `session-relay`) or a convenience surfaced
to a human in an interactive session (`department-notifier-relay`,
`prompt-match-relay`). This matches `docs/journal-and-hooks.md`'s own framing
of the hooks it documents ("The hooks never block Claude Code. They always
exit 0. The journal is the source of truth; every consumer of it is
downstream and optional" — `journal-and-hooks.md:85`).

A structural note that applies to four of the five relays: `analytics-relay`'s
`PreToolUse`/`PostToolUse` roles and `stats-relay`'s/`analytics-relay`'s
`SubagentStop` role are keyed to the **Agent tool** and to a
**`pipeline-manager` subagent** specifically (`SubagentStop`'s matcher is
literally `"pipeline-manager"`). `driver` never spawns through the Agent tool
and never spawns a `pipeline-manager` — it shells `claude -p` directly, once
per step (`DEFAULT_EXECUTOR_TEMPLATE`, `src/commands/drive.ts:416`). So most
of these registrations describe a mechanism that was already structurally
inapplicable to `driver` runs before bare mode enters the picture at all; the
bare flip removes something `driver` was never the intended consumer of.

## 2. What's already covered without a hook firing

Two independent things cover most of the telemetry loss, and they are not the
same thing:

### 2a. `stream-json` / `ExecutorExit.stream` (the design doc's own claim, verified against the type)

`DEFAULT_EXECUTOR_TEMPLATE` already passes `--output-format stream-json
--verbose` (`src/commands/drive.ts:416`), and `driver` folds every frame
through `ClaudeStreamParser` into a `StreamSummary`
(`src/lib/stream-json.ts:158-171`) carrying `tool_calls[]` (with
`parent_tool_use_id`/`depth`, i.e. subagent-spawn detection —
`stream-json.ts:130-141`), `tools_called`, `max_depth`, and the terminal
`envelope` (token usage + cost, from the `result` frame — never accumulated
from per-turn `assistant` frames, which would double-count). `ExecutorExit`
carries this as its `stream` field (`drive.ts:318-331`), folded at
`drive.ts:671`. This is exactly the raw material `analytics-relay`'s
`PostToolUse`/`Stop` roles and `stats-relay` reconstruct from a transcript —
`driver` already has it first-hand, per step, with no transcript-walk needed.

**Caveat, stated as j1 states its own:** whether `stream-json` keeps emitting
real `tool_use` frames under `--bare` with a *valid* key is not directly
measured by j1 or by this task — j1's "not settled" item 1 is exactly this
("whether `--bare` completes a full turn with a valid `ANTHROPIC_API_KEY`");
every `--bare` probe in this environment (mine included, see §3) fails
pre-turn on "Not logged in." Nothing in either probe set suggests
`--output-format`/`--verbose` interact with `--bare`'s tool/hook/auth
restrictions — they are documented as an *output* concern, orthogonal to
which tools or hooks are available — but this is an inference from the flags'
documented independence, not a direct observation with a real key.

### 2b. `driver`'s own native reconciliation — not stream-json, not a hook, already shipped

This is the load-bearing finding, and it is new evidence beyond what j1
gathered (j1 measured the `claude` binary; this is `driver`'s own source):

- **`enrichStats`** (`src/commands/drive.ts:1600-1635`) runs *inside*
  `driver` at every terminal action (halted, done, parked — call sites at
  `drive.ts:2571`, `2622`, `2755`, `2768`, `2782`). It folds pinned per-step
  session transcripts (`src/lib/step-transcripts.ts`) and prefers accumulated
  stream-json envelope usage when present — the same tokens/tool-counts/
  tool-failures `stats-relay` would have written, produced by `driver` itself,
  with **no dependency on any Claude Code hook firing**.
- `src/lib/stats-backfill.ts`'s own header names `runner === 'driver'` as a
  distinct source-select branch (lines ~22-30): a driver run's records fold
  from its pinned per-step transcripts using the exact precedence
  `drive.ts`'s own `enrichStats` uses — the shared core was written
  *knowing* `driver` supplies its own enrichment, not solely the hook's.
- **`statsRunInitKick`** (`src/commands/next.ts:862-880`) calls the same
  `backfillProject` core once per run-init specifically to "close E1 (a
  missed SubagentStop hook leaves an EARLIER run's record null forever) a
  little sooner than the next Stop/SubagentStop" — i.e. this reconciliation
  path already exists as a mitigation for the hook simply not firing, for
  reasons that predate bare mode entirely (an old CLI, `PIPELINE_STATS_ENABLED`
  off, a killed process). Bare mode adds one more cause to a list this code
  already handles.
- `pipeline stats backfill` (`src/commands/stats.ts:92`) is a manual,
  on-demand fourth rung over the identical core.
- `driver` also journals its own run/step lifecycle directly —
  `run.started` (`drive.ts:1424`), `step.started` (`drive.ts:2371`),
  `run.awaiting_input` (`drive.ts:2544`, `2593`) — via `emitEvent`/
  `emitEventJson` (`drive.ts:185`) into the **same** `.pipeline/.runtime/events.jsonl`
  journal `session-relay`'s `session.opened` line would also land in. This is
  what `pipeline logs` reads regardless of whether any hook fired.

### 2c. The plugin's own docs already flag this mechanism's shelf life

Two independent files in the plugin repository state, in near-identical
language, that the hook-dependent binding/analytics mechanism is understood
by its own authors to end at this exact flip:

> "**Shelf life is deliberate:** this whole mechanism depends on plugin hooks
> firing inside `claude -p`. When `-p` defaults to `--bare` they stop and it
> has nothing to attach to — a near-term improvement, not an architecture;
> the identity minting it propagates is the half that survives."
> — `public/plugin/pipeline-claude/docs/journal-and-hooks.md:83` (also
> `docs/events.md:531`, same sentence)

And, separately, the same document states the hook-emitted analytics were
already known to be a *secondary*, less trustworthy source next to the
transcript fold `driver` and `stats-backfill.ts` use:

> "**Per-run analytics are folded from the TRANSCRIPTS, not the hook
> events.** The hook-emitted `tool.called`/`turn.usage` are an unreliable
> stats source: ground-truth validation showed `turn.usage` (Stop hook,
> MAIN-transcript tail) never sees subagent tokens (per-run tokens came out
> ~0) and `tool.called` leaks ~half its events to `run_id=null`. The
> transcript fold reproduces ground truth exactly."
> — `journal-and-hooks.md:86`

So the mechanism this task is asked to weigh the loss of is, by the plugin's
own documentation, already the *less accurate* of the two paths that exist
today, and its replacement (the transcript fold) is what `driver` was already
built on.

## 3. What survives via `--settings` — measured, not assumed

`02-standalone-executor.md`'s insurance table states "Hooks / skills / MCP /
CLAUDE.md auto-discovery" is "Restored by: `--settings`, `--mcp-config`"
(`02-standalone-executor.md:107`). j1 never tested this directly — no probe
in `docs/bare-baseline.md` passes `--settings`. This task ran one, bounded,
to settle it rather than repeat the documentation's claim.

**Probe.** A minimal `settings.json` declaring one `SessionStart` hook that
appends a marker line to a file, passed via `--settings <path>`. `SessionStart`
was chosen because j1 already established it fires *before* any auth check
(`docs/bare-baseline.md`, run 1's raw stream: two `hook_started`/
`hook_response` pairs precede `system/init`), so the probe does not need a
valid `ANTHROPIC_API_KEY` to be conclusive either way.

**Environment for this probe (checked the same way j1 did):**
`printenv ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_PLUGIN_ROOT`
all exit 1 (unset). `claude --version` → **`2.1.228`** — one patch newer than
j1's `2.1.227` (the binary updated between the two tasks; noted here rather
than silently treated as the same build). Both runs from
`C:\tmp\ai-pipeline-worktrees\j2-bare-hooks-decision--pipeline`.

**Command A** (no `--bare`, baseline — confirms the mechanism works at all
in this environment before asking whether `--bare` changes it):
```
claude -p "This is a harness measurement probe, not a real task. Reply with exactly the single word OK and take no other action." --settings "<settings.json with a SessionStart hook>" --output-format stream-json --verbose
```
Result: **marker file written.** Raw stream opens with *three*
`hook_started`/`hook_response` pairs for `SessionStart:startup` (the plugin's
own two SessionStart entries — `session-relay`, `department-notifier-relay`
— plus the one this probe added via `--settings`), all `"exit_code":0,
"outcome":"success"`. `system/init.apiKeySource:"none"` (same
no-credential-env, session-login path as j1's run 1). Terminal result: `"OK"`.

**Command B** (`--bare`, identical settings file):
```
claude -p "This is a harness measurement probe, not a real task. Reply with exactly the single word OK and take no other action." --bare --settings "<same settings.json>" --output-format stream-json --verbose
```
Result: **marker file NOT written.** Raw stream starts directly at
`system/init` — **zero** `hook_started`/`hook_response` frames, byte-for-byte
the same shape as j1's run 2 (`docs/bare-baseline.md` Category 4). `tools`
narrows to the same four (`Bash`, `Edit`, `PowerShell`, `Read`),
`mcp_servers:[]`. The run then fails the same pre-turn "Not logged in ·
Please run /login" as every other no-key `--bare` run — consistent with, not
a confound of, the hook result, since the hook (or its absence) resolves
*before* that failure in the non-bare run too.

**Conclusion, directly measured on 2.1.228:** `--settings` does **not**
restore hook execution under `--bare` — not partially, not for a hook
declared explicitly in the file passed to the flag itself. The identical
settings document produces 3-for-3 hook firings without `--bare` and 0-for-1
with it. This is a stronger and different finding than "plugin hooks don't
auto-discover under bare" (which j1 already established) — it shows `--bare`
suppresses **all** hook execution, including one handed to it explicitly via
the flag the design document names as the restore path. The design
document's claim (`02-standalone-executor.md:107`) is not supported by this
measurement and should be treated as unverified going forward; whether it
describes a different Claude Code version, a different hook event, or was
simply the plan's untested assumption is not something this probe can
distinguish — only that on the installed 2.1.228 binary, for `SessionStart`,
it does not hold.

This also answers the task's DoD question about completeness directly: even
setting aside that reproducing `pipeline-claude`'s specific hook *definitions*
inside a `--settings` file would require `driver` to duplicate
`hooks/hooks.json`'s command lines (new surface to keep in lockstep with the
plugin, which already has a documented "bump version in lockstep" discipline
for far smaller changes) — the flag does not execute hooks under `--bare` at
all, on this measurement. `--settings` is not a partial answer for hook
restoration; on the one event tested, it is no answer.

## 4. Plugin-subagent frontmatter check — `step-executor`

Checked directly against `public/plugin/pipeline-claude/agents/step-executor.md`
(read-only, superproject). Its frontmatter, in full:

```yaml
---
name: step-executor
description: Internal pipeline worker — spawned per step by pipeline-manager or pipeline drive to execute one iteration file in a fresh context. Never invoke directly.
tools: Read, Edit, Write, Bash, Glob, Grep, WebFetch, WebSearch, Skill, Agent, LSP, ToolSearch, TaskCreate, TaskGet, TaskList, TaskUpdate
model: inherit
color: blue
---
```

**Result: no gap.** `step-executor` declares none of `hooks`, `mcpServers`,
or `permissionMode` — only `name`, `description`, `tools`, `model`, `color`.
The documented plugin-subagent limitation (those three fields are ignored
when an agent loads from a plugin) has nothing to bite on here, because
`step-executor` never asked for any of them in the first place. Checked the
same way against the plugin's other four agents for consistency
(`pipeline-manager.md`, `pipeline-improver.md`, `pipeline-script-creator.md`,
`pipeline-disambiguator.md`): none of the five declares `hooks`,
`mcpServers`, or `permissionMode` either. This is a plugin-wide pattern, not
an exception carved out for `step-executor`.

This is a different mechanism from the rest of this document — it is about
whether an *individual subagent definition* can carry its own hooks, and the
answer is "not applicable here" because none tries to. The hooks this
document is actually about are registered at the *plugin* level
(`hooks/hooks.json`), fire around whatever session/agent is running, and are
what §1-3 above cover. Both checks came back clean independently; neither
compounds the other.

## 5. Recommendation and its cost

**Recommended option: accept the loss, for every category above, without a
`driver`-side remedy.** Do not pass `--settings` to reconstruct the plugin's
hooks (§3 shows it would not work even if attempted), and do not make
`driver` refuse to run when a hook cannot be loaded (§1 shows there is
nothing in the correctness bucket to refuse over).

**Cost, stated plainly, category by category:**

- **`.pipeline/.stats/` reconciliation** (`stats-relay`, both events): the
  cost is a **narrowed, delayed safety net**, not a data loss. `driver`
  already writes its own enrichment at every terminal action (§2b); what
  disappears is the *redundant* hook-triggered rung that could catch a
  `driver` process killed before it reaches its own terminal `enrichStats`
  call (SIGKILL, host reboot, a hard process kill outside `driver`'s control).
  In that specific case, the record stays `tokens: null` until the *next*
  run's `statsRunInitKick`, a manual `pipeline stats backfill`, or the
  daemon sweep runs — the underlying data (pinned per-step session
  transcripts) is untouched on disk the whole time, so nothing is
  unrecoverable, only unreconciled for longer than today.
- **`analytics-relay`'s manager-nesting roles** (`PreToolUse`/`PostToolUse`/
  the `pipeline-manager`-matched `SubagentStop`, bypass-lifecycle synthesis):
  cost is effectively zero — these were already structurally inapplicable to
  `driver`, which never spawns through the Agent tool or a `pipeline-manager`
  subagent (§1).
- **`analytics-relay`'s `Notification` → `run.awaiting_input`**: cost is zero
  for `driver` specifically — `driver` already journals its own
  `run.awaiting_input`/`step.awaiting_input` directly (`drive.ts:2544`,
  `2593`, `2179`), independent of this hook.
- **`session-relay`'s `session.opened`**: cost is a narrower signal than what
  survives it — `driver` already journals `run.started`/`step.started` into
  the same file (§2b); what's lost is specifically the raw
  Claude-Code-process-boundary marker, which for `driver` fires once per
  *step* today (a `claude -p` per step) rather than once per human session,
  so its per-step firing was already a mismatch with what the event nominally
  means.
- **`department-notifier-relay`**: cost is zero to step correctness. It is
  cross-session, org-scoped background-task notification, unrelated to the
  pipeline currently running; `pipeline department status`/`pipeline logs`
  are independent read paths unaffected by this hook either way.
- **`prompt-match-relay`**: cost is zero. Default OFF already, and its job
  (suggest a pipeline for a freely-typed user prompt) does not apply to a
  `driver`-composed iteration prompt, which is already a specific,
  already-selected pipeline step, not a prompt to be matched against one.

**Why not the other two options named in this task's brief:**

- *Pass `--settings` explicitly from the executor template*: rejected on
  §3's direct measurement — it does not restore hook execution under
  `--bare` on the installed 2.1.228 binary, for the one event tested. Even
  optimistically, it would require `driver` to duplicate
  `pipeline-claude/hooks/hooks.json`'s command lines inside a
  `driver`-authored settings file (new surface to keep in lockstep with the
  plugin) to restore mostly-telemetry that §2 shows `driver` already
  reconstructs natively. The cost/benefit does not clear even before the
  measurement; the measurement removes the benefit entirely.
- *Make `driver` refuse to run when a hook it needs cannot be loaded*:
  rejected because there is no hook `driver` needs — §1's correctness bucket
  is empty. Refusing would fail every bare-mode `driver` run for zero
  correctness benefit, which is backwards from what bare mode exists for
  (the design doc's own framing: insurance for CI, BYOK, and hosted
  execution — see `02-standalone-executor.md`'s "Why this is worth building
  regardless").

## 6. What this document does not decide

- **Agent resolution** (`--agent pipeline:step-executor` failing to resolve
  under `--bare`, `--plugin-dir` not fixing it — j1 runs 4/5/5b/5d) is a
  separate, already-flagged problem. `DEFAULT_EXECUTOR_TEMPLATE` already
  passes `--plugin-dir {plugin_dir}` on the assumption it would keep
  `--agent pipeline:step-executor` resolvable once the default flips
  (`src/commands/drive.ts:96-101`) — j1's measurement contradicts that
  assumption. This document does not re-litigate it; it is evidence for
  whichever task owns agent resolution, not this one.
- **Whether `--bare` completes a full turn with a valid `ANTHROPIC_API_KEY`**
  remains unsettled by both j1 and this task (§2a's caveat) — no real key
  was available in either environment.
- **Whether `stream-json` behaves identically once a real turn runs under
  `--bare`** (tool_use frames, depth tracking) is inferred from the flags'
  documented independence, not directly observed with a real key.

## Definition of Done — how each item is satisfied

- **Enumerates today's hooks, classified correctness/telemetry/convenience.**
  §1's table; the correctness bucket is explicitly empty and the reasoning
  is stated, not just asserted.
- **States which categories `stream-json` and `--settings` cover, citing
  j1's evidence.** §2a cites j1's Category 2 tool-surface measurement and its
  own "not settled" item 1; §3 supersedes the design doc's `--settings` claim
  with a direct measurement (not j1's — this task's own, run the same way
  j1's probes were run and reported with the same rigor).
- **Recommends exactly one option, names its cost.** §5, category by
  category, plus the two rejected alternatives and why.
- **Plugin-subagent frontmatter limitation checked against `step-executor`,
  result recorded either way.** §4 — checked, no gap, plugin-wide pattern
  confirmed across all five agents.
- **No source file modified.** The only change in this diff is this file,
  `docs/bare-hooks.md`. `git diff --name-only` against `main` shows exactly
  one path.
