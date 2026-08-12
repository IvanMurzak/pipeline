# The reduced bare tool surface vs. what `step-executor` needs

**Status:** audit document (task `j4-bare-tool-surface`). No source change — a
later task decides what, if anything, `driver` does about this. Builds on three
documents already merged on this branch:

- **`docs/bare-baseline.md`** (`j1`, Claude Code 2.1.227) — under `--bare` the
  tool surface is exactly `["Bash","Edit","PowerShell","Read"]`; `Grep`, `Glob`,
  `WebFetch`, `WebSearch`, `LSP` and the Agent/`Task` tool are absent;
  `--plugin-dir` restores a plugin's **skills** under `--bare` but not its
  **agents**; `--agent pipeline:step-executor` fails to resolve under `--bare`
  even with `--plugin-dir`; `--agents <json>` works as an agent-resolution
  alternative with no plugin involved.
- **`docs/bare-hooks.md`** (`j2`, Claude Code 2.1.228) — `--settings`-declared
  hooks do not fire under `--bare` (3-for-3 without, 0-for-1 with); `step-executor`
  declares none of `hooks`/`mcpServers`/`permissionMode`, so the plugin-subagent
  frontmatter limitation has nothing to bite on for it specifically.
- **`docs/bare-auth.md`** (`j3`, Claude Code 2.1.228) — `apiKeyHelper` via
  `--settings` **does** survive `--bare` (unlike hooks), so no flag's bare-mode
  behavior can be inferred by analogy from another flag; each has to be tested.

**Scope reminder, same as `j2`'s/`j3`'s:** this is about `driver` (`pipeline
drive`, `src/commands/drive.ts`), the only mode affected by `-p`'s bare default,
since `session`/`manager` use the Agent tool from inside an interactive session
and `standalone` uses the Agent SDK. Writes only `docs/bare-tool-surface.md`; no
source file and no template under the plugin's `agents/` (group C's domain) is
touched.

**Claude Code version (measured, `claude --version`):** `2.1.228 (Claude Code)`
— matches `j2`/`j3`, one patch ahead of `j1`'s `2.1.227`. Noted per this task's
own instruction rather than conflated with `j1`'s dataset.
**Date measured:** 2026-08-11 (session clock into 2026-08-12 UTC for the final
probes; see raw timestamps below).
**Working directory for every probe below:**
`C:\tmp\ai-pipeline-worktrees\j4-bare-tool-surface--pipeline` (this task's own
worktree of `public/package/pipeline`).
**Environment before any probe** (checked the same way `j1`/`j2`/`j3` did):
`printenv ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `CLAUDE_PLUGIN_ROOT`
all exit 1 (unset) — every probe below authenticates nothing and fails at
"Not logged in" *after* `system/init` is emitted, which is exactly what makes
the tool surface observable without a real API key (the same property `j1`'s
Category 2 relied on).

## 1. Two different lists — declared vs. actually used

### 1a. `step-executor`'s declared tools (frontmatter, verbatim)

Checked directly against
`public/plugin/pipeline-claude/agents/step-executor.md` (read-only,
superproject):

```yaml
tools: Read, Edit, Write, Bash, Glob, Grep, WebFetch, WebSearch, Skill, Agent, LSP, ToolSearch, TaskCreate, TaskGet, TaskList, TaskUpdate
```

Sixteen entries: `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`, `WebFetch`,
`WebSearch`, `Skill`, `Agent`, `LSP`, `ToolSearch`, `TaskCreate`, `TaskGet`,
`TaskList`, `TaskUpdate`.

### 1b. Tools steps actually use, from the bundled templates

The declared list is what the agent *could* reach for. What a real iteration's
`## Steps` actually directs it to do is the separate, narrower thing the task
brief calls "the real requirement." Read every step file in this repo's three
bundled templates (`templates/example-minimal/`, `templates/ship-feature/`,
`templates/support-answer/` — eleven step files total) rather than guessing:

| Step file | What it actually does | Tool(s) implied |
| --- | --- | --- |
| `example-minimal/{prepare,finish}.md` | Placeholder prose ("First concrete action", "An observable condition") — a scaffold template, not real usage evidence | none — excluded from the tally below |
| `ship-feature/plan.md` | "Explore the repository enough to locate the files the feature will touch and the project's build/test command (read-only)" | Read; the kind of task `Grep`/`Glob` mechanically serve, though the step prose names an outcome, not a literal tool call (consistent with this plugin's authoring style — the executor picks the concrete tool) |
| `ship-feature/implement.md` | `git switch`/`git switch -c`, makes code changes, runs the project's build/test command, stages and commits | **Bash** (git + build/test), **Edit/Write** (code changes), Read (reads prior step outputs) — `permission-mode: bypassPermissions` is set specifically because this step shells out |
| `ship-feature/review.md` | `git diff ${PP_BASE}...HEAD`; **"For a large diff you MAY spawn ONE synchronous, read-only `Explore` helper to locate affected call sites and fold its findings into your review — do NOT spawn a `general-purpose` agent"** | Bash (git diff, read-only), **Agent** — the one bundled step that names intra-step fan-out explicitly and by tool |
| `ship-feature/open-pr.md` | `git push -u origin`, `gh pr list`/`gh pr view`/`gh pr create` | **Bash** — `permission-mode: bypassPermissions` for the same reason |
| `ship-feature/ci-wait.md` | Shells the bundled `pipeline ci-wait --pr <n> --json` gate in one call | **Bash** — `permission-mode: bypassPermissions` |
| `ship-feature/merge.md` | `gh pr merge --squash --delete-branch` on human approval | **Bash** — `permission-mode: bypassPermissions` |
| `support-answer/retrieve.md` | `type: script` — runs `scripts/bm25_retrieve.ts` **in-process, with no agent and no LLM tokens at all** | none — a structurally different execution path, not a `step-executor` invocation, and therefore not affected by the bare tool surface at all |
| `support-answer/select.md` | Reads candidate files at `<docs_dir>/<file>`, picks the best one | Read |
| `support-answer/answer.md` | Reads the one selected source file, composes the answer as its own output text | Read |

**Tally.** Across the ten real (non-placeholder) steps: **Bash** is the
dominant tool — four of six `ship-feature` steps declare
`permission-mode: bypassPermissions` specifically because they shell out
(`git`, `gh`, the bundled `pipeline` CLI). **Read** is used by every
information-gathering step. **Edit/Write** (code changes) is used by exactly
one step (`implement.md`). **Agent** is used by exactly one step, explicitly
and by name (`review.md`'s `Explore` helper — the intra-step fan-out case the
task brief calls out). **No bundled step names `Grep`, `Glob`, `WebFetch`,
`WebSearch`, `Skill`, `LSP`, `ToolSearch`, or any `Task*` tool** — their
absence from real usage doesn't mean they're never needed (a step author could
write one that does), but it does mean the two lists are exactly as different
as the task brief predicted: sixteen declared, and a working set of
`{Bash, Read, Edit/Write, Agent}` observed in practice, with `Grep`/`Glob`
implied by "explore the repository" but never named as a literal tool call.

## 2. Present or absent under `--bare` — cross-referenced against `j1`

`j1`'s measured bare floor (`docs/bare-baseline.md`, Run 2, Claude Code
2.1.227, reconfirmed identical on 2.1.228 by every probe in this document —
see §3): **exactly `["Bash","Edit","PowerShell","Read"]`.**

| Declared tool | Present under `--bare`? | Used by a real step (§1b)? |
| --- | --- | --- |
| `Read` | **Present** | Yes — every info-gathering step |
| `Edit` | **Present** | Yes — `implement.md` |
| `Write` | **Absent** — see note below | Yes — `implement.md` (code changes may include new files) |
| `Bash` | **Present** (plus a bonus `PowerShell`, not declared by `step-executor` at all) | Yes — the dominant tool in `ship-feature` |
| `Glob` | Absent | Implied by `plan.md`'s "explore the repository", not named literally |
| `Grep` | Absent | Implied by `plan.md`'s "explore the repository", not named literally |
| `WebFetch` | Absent | Not used by any bundled step |
| `WebSearch` | Absent | Not used by any bundled step |
| `Skill` | Absent | Not used by any bundled step |
| `Agent` | **Absent** — see §4 | **Yes, explicitly** — `review.md`'s `Explore` helper |
| `LSP` | Absent | Not used by any bundled step |
| `ToolSearch` | Absent | Not used by any bundled step (notable: this is the mechanism that would otherwise load a missing deferred tool at runtime — see §5) |
| `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` | Absent | Not used by any bundled step |

**Result: of `step-executor`'s 16 declared tool entries, only 3 (`Read`,
`Edit`, `Bash`) survive under `--bare`.** 13 of 16 are gone. Cross-referencing
against §1b's real-usage tally: the surviving three cover most of
`ship-feature`'s actual step bodies (Bash-heavy git/`gh` work, reading prior
outputs), but the one step that names a tool explicitly for a purpose no other
tool substitutes — `review.md`'s `Agent`-based `Explore` fan-out — loses it
entirely.

**New finding beyond `j1`'s own summary: `Write` is absent, and `j1` never
named it.** `docs/bare-baseline.md`'s Category 2 prose lists what's missing as
"`Grep`, `Glob`, `WebFetch`, `WebSearch`, `LSP` and the Agent/`Task` tool" —
`Write` isn't in that sentence, even though `j1`'s own quoted `system/init`
JSON for Run 2 (`"tools":["Bash","Edit","PowerShell","Read"]`) plainly omits
it. `j1`'s task wasn't scoped to cross-reference against any specific agent's
declared tool list, so this had no reason to surface there. It matters here
because `step-executor` declares `Write` as a **separate** entry from `Edit`,
and `implement.md`'s "make the code changes to satisfy the feature" step can
mean creating a new file, not just modifying an existing one. The practical
cost is partial, not total — `Bash`/`PowerShell` are both present under
`--bare` and either can create a file (a heredoc, `Set-Content`, a shell
redirect) — but that's a structurally different mechanism than the `Write`
tool (no diff preview, no edit-tool safety framing), not the same capability
restored.

## 3. The crux — does `--allowedTools` restore a tool, or only pre-approve one that already exists? Settled by test.

The design document this task audits against states the tool-surface loss is
"Restored by: `--allowedTools`, **to be verified**"
(`.taskflow/2026-08-03-execution-modes/02-standalone-executor.md:105`). No
probe in `j1`, `j2`, or `j3` tests `--allowedTools`. This task ran the bounded
probes below to settle it by direct observation rather than repeating the
design document's unverified claim — the same discipline `j2` applied to
`--settings` and `j3` applied to `apiKeyHelper`.

### Probe A — does `--allowedTools` add the missing tools back?

```
claude -p "This is a harness measurement probe, not a real task. Reply with exactly the single word OK and take no other action." --bare --allowedTools "Grep,Glob,WebFetch,WebSearch,Agent" --output-format stream-json --verbose
```

Result: `system/init.tools` is **`["Bash","Edit","PowerShell","Read"]`** —
byte-identical to plain `--bare` with no `--allowedTools` at all
(`j1`'s Run 2). None of `Grep`, `Glob`, `WebFetch`, `WebSearch`, `Agent` were
added. `apiKeySource:"none"`; terminal result the same
`"Not logged in · Please run /login"` every no-key `--bare` run produces.
Session id `def8998f-f210-48bd-9991-7923b64e1df0`.

### Control probe B — does the flag mechanism affect `system/init.tools` at all?

A null result from Probe A is only meaningful if `--allowedTools`/
`--disallowedTools` are known to actually touch the tools array in this
version — otherwise the flag could simply be inert as an output signal, and
Probe A would prove nothing. Tested directly:

```
claude -p "This is a harness measurement probe, not a real task. Reply with exactly the single word OK and take no other action." --bare --disallowedTools "Edit" --output-format stream-json --verbose
```

Result: `system/init.tools` is **`["Bash","PowerShell","Read"]`** — `Edit`
removed. **This confirms the flag mechanism does operate directly on
`system/init.tools`** — Probe A's null result is a real finding, not an
artifact of an inert flag. Session id `7e979f66-03b9-46c0-a50b-f0512d17f26f`.

### Probe C — naming mismatch ruled out

`j1`'s Run 3 (`system/init` under a resolved `--agent`) shows the Agent tool
rendered as `"Task"` in the tools array, not `"Agent"`. Re-ran Probe A passing
the internal name instead, in case `--allowedTools` expects it:

```
claude -p "This is a harness measurement probe, not a real task. Reply with exactly the single word OK and take no other action." --bare --allowedTools "Task" --output-format stream-json --verbose
```

Result: `system/init.tools` is again **`["Bash","Edit","PowerShell","Read"]`**
— unchanged. Naming is not the explanation. Session id
`01461add-eae4-4922-8b65-3e013a6082d4`.

### Probes D/E — does an agent's own `tools:` declaration fare any better than the flag?

`--allowedTools` is one lever; a custom agent's own frontmatter `tools:` field
is a different one (this is what `step-executor.md` itself uses, and what
`j1`'s Run 6 showed *can* resolve an agent's *name* under `--bare` via inline
`--agents <json>`, with no plugin). Tested whether a custom agent's declared
tool list survives intact under `--bare`, using the same `--agents` mechanism
`j1` proved works for name resolution:

```
claude -p "Reply RESOLVED and stop. Do not use tools." --bare --agent probe-agent --agents "{\"probe-agent\":{\"description\":\"probe agent for harness measurement\",\"prompt\":\"You are a smoke-test agent. Reply with the single word RESOLVED and take no other action.\",\"tools\":[\"Read\",\"Grep\",\"Glob\"]}}" --output-format stream-json --verbose
```

Result: `system/init.agents` includes `"probe-agent"` (name resolution
succeeded, matching `j1`'s Run 6), but **`system/init.tools` is
`["Read"]`** — only the one entry that is in *both* the agent's declared list
*and* `--bare`'s floor. `Grep` and `Glob` (declared, not in the floor) were
dropped; `Bash`/`Edit`/`PowerShell` (in the floor, not declared by this agent)
were **also** excluded. Session id `418d011a-0810-4d23-8bce-0843816edf5d`.

A second run targeted the Agent tool specifically:

```
claude -p "Reply RESOLVED and stop. Do not use tools." --bare --agent probe-agent2 --agents "{\"probe-agent2\":{\"description\":\"probe agent for harness measurement\",\"prompt\":\"You are a smoke-test agent. Reply with the single word RESOLVED and take no other action.\",\"tools\":[\"Bash\",\"Read\",\"Agent\"]}}" --output-format stream-json --verbose
```

Result: **`system/init.tools` is `["Bash","Read"]`** — `Bash` and `Read`
(both in the floor and declared) survive; `Agent` (declared, not in the
floor) is dropped. Session id `7b2b490b-aff4-4080-b71c-5212f243416d`.

### Conclusion, directly measured on 2.1.228

**`--allowedTools` does not restore a tool removed by `--bare`; it can only
narrow within whatever `--bare` already exposes.** Five probes converge on one
shape: Probe A shows the flag adds nothing; Probe B shows the flag mechanism
is real (it can subtract); Probe C rules out a naming mismatch; Probes D/E
show the identical intersection behavior at the *agent-definition* level, not
just the flag level — even a custom agent that declares `Grep`/`Glob`/`Agent`
among its own tools gets exactly the intersection of its declared list and
`--bare`'s four-tool floor, never more. **This is the test the task asked
for, not an inference: `--bare` removes tools from the surface itself, not
from a permission/approval layer sitting on top of a larger surface** — so no
combination of `--allowedTools`, `--disallowedTools`, or an agent's own
`tools:` frontmatter can bring `Grep`/`Glob`/`WebFetch`/`WebSearch`/`Agent`
back. This matches the pattern `j1` found for `--plugin-dir` (restores skills,
not agents) and `j2` found for `--settings` (does not restore hooks even when
handed the hook explicitly): a flag that looks on paper like it should
restore bare-mode behavior, and does not, on this measurement. The design
document's insurance-table claim
(`02-standalone-executor.md:105`, "Restored by: `--allowedTools`, to be
verified") **is not supported by direct measurement and should be treated as
unverified going forward**, exactly as `j2` concluded for `--settings`.

## 4. The Agent-tool case, explicitly

The task brief asks this to be called out on its own, separate from the
general tool-surface table, because it is the one loss with no substitute
tool (`Grep`→Bash `grep`, `Glob`→Bash `find`/PowerShell `Get-ChildItem` are at
least mechanically approximable; nothing under `--bare` substitutes for
spawning a helper).

**Confirmed absent from `--bare`'s floor in every configuration tested in
this document and in `j1`:** the default persona with no flags (`j1` Run 2),
`--allowedTools "Agent"` (§3 Probe A), `--allowedTools "Task"` (§3 Probe C), a
custom agent's own `tools:` array naming `Agent` explicitly (§3 Probe E), and
resolving an agent by name at all — `--agent pipeline:step-executor` simply
fails to resolve under `--bare` in the first place (`j1` Runs 4/5/5b/5d), a
separate, already-flagged agent-resolution problem this document does not
re-litigate.

**Is "the agent list" delivered under `--bare`? Two different things go by
that name, and they get different answers:**

- **The CLI's own `system/init.agents` bookkeeping array — confirmed
  delivered under `--bare` by direct measurement.** `j1` Run 6 and both of
  this document's §3 Probes D/E show `system/init.agents` populated correctly
  under `--bare` (`"probe-agent"`, `"probe-agent2"` both appear, alongside the
  built-in `claude`/`Explore`/`general-purpose`/`Plan`/`statusline-setup`
  every `--bare` run carries). This list is delivered regardless of whether
  the Agent/`Task` **tool** itself is present in `system/init.tools` — the two
  fields are independent, the same way `j1`'s Category 4 found skills and
  hooks are gated independently under `--plugin-dir`.
- **The Agent/`Task` tool's own function-schema description text, as sent to
  the model inside its tool definition — not directly observable by this
  probe set.** `stream-json` exposes `system/init`'s JSON fields and the
  conversation turns; it does not expose the literal tool-definition payload
  the API receives, so whether that description text still references an
  agent list (correctly or not) is not something any probe in `j1`–`j4` can
  see. Stated explicitly as unsettled rather than glossed over, the same way
  `j1` flagged the `CLAUDE.md`-under-`--bare` question as unsettled by direct
  observation.
- **In practice, this distinction is moot.** The Agent/`Task` tool is absent
  from `system/init.tools` under every tested `--bare` configuration, so
  there is no tool, and therefore no tool-definition description, for an
  agent list to be embedded in or omitted from in the first place.

**The documented Claude Code fix, found and dated.** The task brief names it
verbatim; searched the upstream `anthropics/claude-code` `CHANGELOG.md`
directly (`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`,
fetched and grepped locally rather than trusting a summarized web search,
which returned nothing precise on the first two attempts) and found the exact
line:

> "Fixed the Agent tool description referencing an agent list that is never
> delivered when running with `--bare` or with attachments disabled"

This entry falls in the **`## 2.1.152`** changelog section (between the
`## 2.1.153` heading above it and `## 2.1.150` below it in the file's
reverse-chronological ordering). **2.1.152 is 76 patch releases behind the
2.1.228 installed here** — this fix shipped long before `j1`'s 2.1.227 or any
probe in this document, so it does not explain, contradict, or need
reconciling with anything measured above; it is old, already-shipped context,
not a live variable. What it does establish: the historical bug was about the
Agent tool's *description text* falsely promising a delivered agent list
while the tool was otherwise present-but-broken under `--bare` — a materially
different situation from what's measured here on 2.1.228, where the Agent
tool is not offered at all under `--bare`, in any configuration tested. The
fix and the current absence are two different eras of the same tool's
`--bare` story, not the same fact restated.

## 5. Remedy table — every missing capability, named or explicitly none

| Missing capability | Remedy | Basis |
| --- | --- | --- |
| `Write` (new-file creation) | **Partial remedy**: `Bash` or `PowerShell` (both present) can create a file via a heredoc / `Set-Content` / shell redirect. Not the same tool — no diff preview, none of `Write`'s safety framing — but the underlying capability (a step can end up with a new file on disk) is not blocked. | §2 |
| `Glob` (directory/pattern listing) | **No remedy via any tested flag** (§3). Practical workaround: Bash `find` / PowerShell `Get-ChildItem`, since `Bash`/`PowerShell` are present — extra turns, different ergonomics, not a restoration. | §3 |
| `Grep` (content search) | **No remedy via any tested flag** (§3). Practical workaround: Bash `grep` / PowerShell `Select-String` — this document's own probes used exactly this substitution to search files during the audit. | §3 |
| `WebFetch` | **No remedy.** Nothing under `--bare`'s floor (`Bash`, `Edit`, `PowerShell`, `Read`) can fetch a URL's rendered content; a step that needs one has no path under `--bare` in the current version. | §2 |
| `WebSearch` | **No remedy.** Same reasoning as `WebFetch`. | §2 |
| `Skill` (the tool, not skill auto-discovery) | **No remedy tested.** No bundled step uses it, so the practical cost against the templates audited here is zero, but the tool itself has no substitute under `--bare`. | §2 |
| **`Agent`** | **No remedy — the crux finding.** §3/§4 show no flag, no `--agents`-declared `tools:` field, and no naming variant restores it; it is removed from the surface, not gated by permission. The one bundled step that names it (`review.md`'s `Explore` fan-out for a large diff) simply cannot do that under `--bare`; the step would have to review the whole diff in-context instead, with no structural fallback `driver` can supply on its own. The only sidestep is architectural, not a `driver` fix: `session`/`manager` never shell a bare `claude -p` at all (same reasoning `j3` used for the authentication gap), so migrating off `driver` for steps that need intra-step fan-out avoids the loss entirely rather than working around it. | §3, §4 |
| `LSP` | **No remedy tested.** Not used by any bundled step. | §2 |
| `ToolSearch` | **No remedy tested — and notably, no self-service escape hatch either.** `ToolSearch` is the mechanism a full session uses to load a missing deferred tool at runtime; its own absence under `--bare` means a step can't even ask for more capability once it discovers it's short. | §2 |
| `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` | **No remedy tested.** Not used by any bundled step; likely low practical cost against real usage (§1b), but no substitute exists under `--bare` if a step were written to need them. | §2 |

**Summary, stated plainly and without deciding `driver`'s fate (out of this
task's scope, same boundary `j2`/`j3` observed):** of `step-executor`'s 16
declared tools, 3 survive `--bare` intact (`Read`, `Edit`, `Bash`, plus a
bonus `PowerShell`), 1 has a partial shell-based workaround (`Write`), 2 have
a mechanical-but-lesser Bash/PowerShell substitute (`Grep`, `Glob`), and 10
have no remedy of any kind that this task's probes could find — including the
one, `Agent`, that a real bundled step (`review.md`) names explicitly. This
compounds, rather than duplicates, `j2`'s hook loss ("accept the loss, nothing
in the correctness bucket") and `j3`'s authentication gap (Max/Pro subscribers
with no key): even a subscriber who solves auth via `apiKeyHelper` (`j3`
Option B) still loses `Grep`/`Glob`/`WebFetch`/`WebSearch`/`Agent` and the rest
of this table, because none of those losses are auth-shaped — they are tool
inventory, and `--allowedTools` cannot buy any of them back.

## Definition of Done — how each item is satisfied

- **Lists `step-executor`'s declared tools and the tools steps actually use,
  separately.** §1a (frontmatter, verbatim) and §1b (all ten real steps
  across the three bundled templates, read individually — not guessed).
- **Each is marked present or absent under bare, from `j1`'s observation.**
  §2's table, cross-referencing `j1`'s measured floor
  (`["Bash","Edit","PowerShell","Read"]`) against all 16 declared entries,
  plus a new finding (`Write`'s absence) `j1`'s own prose never named.
- **The `--allowedTools` question is answered by test, not by inference.**
  §3: five direct probes (add-attempt, subtract-control, naming-variant,
  two agent-definition-level checks) on the installed 2.1.228, full command
  lines and verbatim `system/init.tools` results for each, converging on one
  conclusion — the flag subtracts within the floor, never adds beyond it.
- **The Agent-tool case is called out explicitly, including whether the agent
  list is delivered.** §4: confirmed absent in every tested configuration;
  the CLI-level `system/init.agents` list is confirmed delivered under
  `--bare` by direct measurement, the tool-schema-level description text is
  explicitly flagged as unobservable by this probe set (not glossed over),
  and the historical CHANGELOG fix is found, quoted, dated to 2.1.152, and
  shown to predate and not explain the current (2.1.228) absence.
- **Every missing capability has either a named remedy or an explicit "no
  remedy exists."** §5's table, one row per declared tool, each resolved one
  way or the other with its basis cited.
- **No file outside `docs/` is modified.** The only file in this change is
  this document. `git diff --name-only` against `main` (see the worker's
  report) shows exactly one path.
