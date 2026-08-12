# The residual SDK delta, measured (K-3 / `d3-sdk-delta-measurement`)

**Agent SDK version installed for this measurement:** `@anthropic-ai/claude-agent-sdk@0.3.228` (the exact version `src/lib/executors/sdk.ts`'s `VERIFIED_SDK_VERSION` was checked against, and the floor its `peerDependencies` requires).
**Claude Code version it bundles:** `2.1.228` — matches `claude --version` for the binary already on this host's `PATH`, and matches `j2`'s/`j3`'s/`j4`'s measured version (one patch ahead of `j1`'s `2.1.227`).
**Install footprint (measured, not the header comment's estimate):** `bun install` reported **101 packages installed**, and the resulting `node_modules` measured **321 MB** — both numbers corroborate, rather than merely repeat, `sdk.ts`'s own header comment ("101 packages and ~315 MB").
**Date measured:** 2026-08-11.
**Host:** Windows 11 (win32), git-bash as the invoking shell, from `C:\tmp\ai-pipeline-worktrees\d3-sdk-delta-measurement--pipeline` (this task's own worktree of `public/package/pipeline`).

This document is a measurement, not a recommendation, in the same sense `j1`–`j4`
are: it records what the installed SDK actually did across a bounded set of
real, run probes. It changes no source in this repository. Anywhere a probe
could not settle a question, that is stated explicitly rather than filled in
from documentation — see "What this task could not measure" at the end.

## Scope reminder

K-3 is deliberately small. E9
(`.taskflow/2026-08-03-execution-modes/01-modes.md`) replaced the original
premise — *"under Claude Code a step can reach the user's own agents and the
plugin's; under the SDK only what we supply exists"* — with a narrower one: the
gap is between **locations**, not executors, and what's left to measure is
exactly three things, quoting `02-standalone-executor.md`'s own framing of what
K-3 owes:

> "the Agent tool requires `\"Agent\"` in `allowedTools` for intra-step helpers
> to exist, that plugins load via the `plugins` option, and that a
> `settingSources: [\"project\"]` runner behaves as intended on a real
> checkout."

This document measures those three, against the real package, not the design
doc's prose about it.

## How this was measured

`@anthropic-ai/claude-agent-sdk` is an **optional peer dependency** —
`package.json` installs with zero runtime dependencies, and the SDK is loaded
through a runtime `import()` the bundler cannot see
(`src/lib/executors/sdk.ts:367-394`, `loadSdkQuery`). Taking real measurements
meant actually installing it:

1. `package.json`'s `dependencies` gained a temporary, non-ranged
   `"@anthropic-ai/claude-agent-sdk": "0.3.228"` entry (a plain `peerDependencies`
   bump does not force an install for an *optional* peer — confirmed by trying
   that first: `bun add` silently rewrote the peer range to `""` and installed
   nothing).
2. `bun install` pulled 101 packages / 321 MB, including the win32-x64 native
   binary (`@anthropic-ai/claude-agent-sdk-win32-x64`, 283 MB alone — matches
   `sdk.ts`'s own figure).
3. Every probe below ran against that real install, from small standalone
   scripts under a `.tmp-probes/` directory inside this worktree (so Node/Bun
   module resolution found the real `node_modules`), each bounded by a 15–20s
   `AbortController` timeout and a trivial, side-effect-free prompt — the same
   "you are measuring the harness, not the model" discipline `j1` used.
4. Afterward, `package.json` was restored **byte-identical** to its committed
   form (diffed against a saved copy to confirm), and `node_modules/`,
   `bun.lock`, and the `.tmp-probes/` scripts were all deleted before this
   change was committed. `git diff --name-only` against `main` shows exactly
   one path in this change: this document.

### A confound found and routed around: this environment bridges into the invoking Claude Code session

The first probe run produced a **73-entry** tool list — `Task`, `Bash`,
`CronCreate`, `DesignSync`, `SendMessage`, `Workflow`, plus dozens of
`mcp__claude_ai_Gmail__*` / `Google_Calendar__*` / `Google_Drive__*` MCP
tools — with `apiKeySource: "none"`, and the probe *succeeded*, replying `OK`.
That is not a standalone Claude Code default tool set; it is this specific
operator's own live tool surface, the same one available to the Claude Code
session that is executing this very taskflow task.

This is not a new problem — **`j1` already hit and named it**
(`docs/bare-baseline.md`, Category 2, Run 1: *"the MCP-derived Gmail/Calendar/
Drive tools are this operator's personal, unrelated MCP servers"*) for the
plain `claude -p` (no `--bare`) case. What's new here is confirming it
independently reaches the **Agent SDK path**, and characterizing it precisely
enough to route around it:

- **Stripping every `CLAUDE_CODE_*`/`CLAUDECODE`/`AI_AGENT` environment
  variable before invoking the probe does not stop it.** (`env -u
  CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_CODE_SESSION_ID -u ... bun
  probe.mjs` — same 73-tool result.)
- **Invoking the SDK's own bundled binary directly** —
  `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe --print
  "reply OK" --output-format stream-json --verbose`, bypassing the SDK's JS
  `query()` wrapper entirely — **still bridges**, and additionally fires real
  `SessionStart` hooks (`hook_started`/`hook_response` frames for
  `SessionStart:startup`, matching `pipeline-claude`'s own registered hooks).
  So the detection lives in the CLI binary itself, not in the SDK's JS layer.
- **`--bare` on that same bundled binary does suppress it**: `tools` drops to
  exactly `["Bash","Edit","PowerShell","Read"]` — `j1`'s and `j4`'s measured
  bare floor, byte-identical — `mcp_servers` empties, and no `hook_started`
  frame appears before `system/init`.
- **The Agent SDK's `Options` type has no `bare` field at all** (checked
  directly: `grep -i bare` against the shipped `sdk.d.ts` turns up nothing but
  an unrelated docstring). `driver`'s escape hatch from ambient-session bleed
  is a CLI flag; `standalone` has no equivalent lever exposed through the SDK
  API a caller like `sdk.ts` could set. The workaround used here — strip env,
  call the raw binary, pass `--bare` directly to it — is not something
  `ExecutorRequest`/`SdkExecutorOptions` exposes to a real caller either.

**Practical consequence for this document, and for reproducing it later:** any
probe run **without an explicit `tools:` override**, from **inside a live
Claude Code session** (which a taskflow worker always is), reflects that
session's bridged tool surface, not the SDK's own default. Every other
mechanism tested below — `settingSources`, the `plugins` option, `resolveSettings()`
, and an **explicit** `tools:`/`allowedTools:` array — tracked exactly what was
passed, with no bridge interference (shown per-section below). Only "what
tools exist when nothing at all is configured" stayed unmeasurable from here;
see "What this task could not measure."

## 1. The Agent tool: does `allowedTools` control whether it exists?

### What `sdk.ts` does today

`REQUIRED_TOOLS` (`src/lib/executors/sdk.ts:222-228`) unconditionally injects
`'Agent'` into `options.allowedTools`, and `buildSdkOptions` (`sdk.ts:340-343`)
merges it ahead of any caller-supplied entries. The comment above it states the
rationale: *"The Agent tool, which MUST be allowed or intra-step helpers cannot
exist... this is unconditional: callers ADD to it and cannot remove it."*
`sdk.ts` never sets `options.tools` (the *base tool set* option) at all — only
`allowedTools`.

### What the SDK's own type declarations say `allowedTools` actually does

Quoting `sdk.d.ts` directly (not summarized):

> `allowedTools?: string[];` — *"List of tool names that are auto-allowed
> without prompting for permission. These tools will execute automatically
> without asking the user for approval. **To restrict which tools are
> available, use the `tools` option instead.**"*

> `tools?: string[] | { type: 'preset'; preset: 'claude_code' };` — *"Specify
> the base set of available built-in tools. `string[]` - Array of specific
> tool names... `[]` (empty array) - Disable all built-in tools..."*

These two option names are **not synonyms** for "whether a tool exists" — only
`tools` is. `allowedTools` is a pre-approval / auto-allow list layered on top
of whatever `tools` resolves to.

### The probe

Five runs, `settingSources: []` throughout (isolating the result from the
bridge's config side — see below), 15s abort, prompt `"...Reply with exactly
the single word OK..."`, reading `system/init.tools` from each:

```
A: {}                                             → 73 tools, includes "Task", NOT "Agent" by that name
B: { allowedTools: ['Read'] }                     → 73 tools, includes "Task" — IDENTICAL to A
C: { allowedTools: ['Read','Agent'] }              → 73 tools, includes "Task" — IDENTICAL to A
D: { tools: ['Read','Edit','Bash'] }               → 3 tools: ["Bash","Edit","Read"] — "Task" ABSENT
E: { tools: [] }                                   → 41 tools (all mcp__* — the bridge's MCP servers), no built-ins, "Task" ABSENT
```

(Full command lines and raw JSON are in this task's worktree history; the
counts above were computed programmatically from the captured output, not
eyeballed.)

**A/B/C are confounded by the bridge** (identical 73-tool list regardless of
`allowedTools` content — that list is the operator's own session surface, per
above), so they cannot answer "what does the SDK's own default include." But
**D and E are not confounded**: passing an explicit `tools:` array is honored
exactly, every time, bridge or not — `D` returns precisely the three tools
named, `E` returns precisely zero built-ins. That is the clean signal, and it
is unambiguous: **`allowedTools` never changed the tool list, in any of five
runs; `tools` changed it every time it was set.**

### The measured answer

**Passing or omitting `'Agent'` in `allowedTools` has no observable effect on
whether the Agent tool exists.** Not "silently absent," not an error —
**inert**. Existence is governed exclusively by the separate `tools` option
(or, when that is omitted entirely, whatever the SDK's own undocumented
default base set is — see below). `sdk.ts`'s `REQUIRED_TOOLS` mechanism, which
only ever touches `allowedTools`, therefore **guarantees pre-approval** (no
permission prompt blocking a headless run when the Agent tool is used) — it
does **not**, and by this measurement **cannot**, guarantee the tool's
*existence*. Today that gap is not live — `sdk.ts` never sets `options.tools`
at all, so the base set is left at whatever the SDK defaults to — but the
comment's own claim ("MUST be allowed or intra-step helpers cannot exist") is,
per this measurement, describing the wrong lever. If a future caller ever adds
a `tools:` restriction to `SdkExecutorOptions` without including `'Agent'`,
`REQUIRED_TOOLS`'s `allowedTools` injection would not rescue it.

This is worth stating precisely against `j4`'s adjacent finding for
`driver`/`--bare`, so the two are not conflated: `j4` found the **CLI flag**
`--allowedTools` can *narrow* `--bare`'s four-tool floor but never restore a
tool `--bare` removed — a real effect, just a one-directional one. This
measurement finds the **SDK option** `allowedTools` has **no effect on tool
existence in either direction** — narrowing or restoring — because the SDK
routes existence through an entirely different option. Same flag name,
different code path, different mechanism, different answer; neither
generalizes to the other.

### Intra-step helpers spawning under the SDK executor

`sdk.ts`'s stream parser (`ClaudeStreamParser`, shared with the CLI path) is
already exercised against a **real, injected `system/init` + tool-call frame
sequence** naming the Agent tool by its build-internal name
(`tests/sdk-executor.test.ts:338-356`, `"the real shape of an intra-step
helper: the step-executor calls Agent"`), and asserts `allowedTools` always
contains `'Agent'`, that a caller's own list is merged rather than replaced,
and that a simulated Agent tool call is correctly tracked at depth. Re-ran that
suite for real during this task: **34 of 35 tests passed**; the one failure was
a pre-existing, unrelated `bun test` timeout on an end-to-end drive test under
local parallel load (documented project-wide as a flaky pattern, not something
this task's changes touch or explain). This is real evidence that the code
path recognizes and records an Agent-tool call correctly — it is not, and does
not substitute for, a live model turn actually invoking the tool through a
standalone credential; see "What this task could not measure."

## 2. Plugin loading via the `plugins` option

`02-standalone-executor.md` states plugins load through `Options.plugins`
rather than by discovery, and the task brief asks specifically that
`pipeline:step-executor` be confirmed to resolve that way, plus that the
plugin-subagent frontmatter limitation (`hooks`/`mcpServers`/`permissionMode`
ignored) be confirmed to apply here too, not just for `driver`.

### `pipeline-claude` resolves cleanly

```js
plugins: [{ type: 'local', path: 'C:/Projects/AI/ai-pipeline/public/plugin/pipeline-claude' }]
```

against the real, read-only checkout of the plugin repository, with
`settingSources: []` (so nothing but this explicit option could be the
source). Result, from `system/init`:

- `agents`: `["claude","Explore","general-purpose","pipeline:pipeline-disambiguator","pipeline:pipeline-improver","pipeline:pipeline-manager","pipeline:pipeline-script-creator","pipeline:step-executor","Plan","statusline-setup"]`
  — **all five plugin agents resolve**, `pipeline:`-qualified, exactly matching
  the five `j2` already enumerated by reading the plugin's `agents/` directory.
- `plugins`: `[{"name":"pipeline","path":"...pipeline-claude","source":"pipeline@inline","version":"0.95.1"}]`
  — the plugin's own `plugin.json` `name`/`version` came through verbatim.
- `mcp_servers` gained `{"name":"plugin:pipeline:ai-pipeline-departments","status":"needs-auth"}`
  — the plugin-*level* `mcpServers` entry from `plugin.json` **does** merge in.
  (`needs-auth` because no credential was supplied — expected, and itself
  confirms the server was actually reached, not stubbed.)

This directly answers "confirm `pipeline:step-executor` resolves that way":
it does, by the same `plugins` option mechanism used for the whole plugin, not
some special case.

### The frontmatter limitation, measured against a fixture — not inferred from `j2`'s "no gap"

`j2` checked the plugin's five *real* agents and found none declares `hooks`,
`mcpServers`, or `permissionMode` — a clean but *negative* result ("nothing to
observe because nothing tries"). To get a *positive* measurement of what
happens when a subagent *does* declare those fields, this task built a small
fixture plugin (`probe`, one subagent `probe-sub`) whose frontmatter
deliberately declares all three:

```yaml
---
name: probe-sub
tools: Read
permissionMode: bypassPermissions
hooks:
  SessionStart:
    - hooks: [{ type: command, command: "echo this-should-never-fire" }]
mcpServers:
  probe-mcp: { type: http, url: "https://example.invalid/mcp" }
---
```

Loaded via `plugins: [{ type: 'local', path: <fixture> }]`:

- **It loads without error.** `agents` includes `"probe:probe-sub"` alongside
  the built-ins; `plugins` reports it (`name: "probe"`, version `0.0.1`) — the
  unsupported keys do not fail parsing, they are silently tolerated.
- **`mcp_servers` never gains `probe-mcp`**, in any of four probe
  configurations (fixture alone, fixture + `pipeline-claude` together, and
  with the fixture set as the *active* main-thread agent via `agent:
  'probe:probe-sub'`) — only the bridge's own three servers (or
  `pipeline`'s, when that plugin is also loaded) ever appear.
- **Activating `probe-sub` as the main-thread agent** (`agent: 'probe:probe-sub'`,
  the SDK's equivalent of `--agent`) makes the contrast sharp, in one probe:
  - `permissionMode` in `system/init` stays `"default"` — the frontmatter's
    `bypassPermissions` **is ignored**.
  - `tools` narrows to exactly `["Read"]` — the frontmatter's own `tools:
    Read` **is honored**. (A genuinely different mechanism from the plugin's
    own JSON-level `mcpServers`, which also works — see above.)
  - No marker file the fixture's `SessionStart` hook was supposed to write
    ever appeared — the frontmatter's `hooks` **is ignored**.

**Measured conclusion, for the SDK/`standalone` path specifically:** a plugin
subagent's `hooks`, `mcpServers`, and `permissionMode` frontmatter fields are
silently dropped on load — no error, no warning, no observable effect —
while `tools` (and the plugin's own top-level `mcpServers` in `plugin.json`,
a different field at a different scope) are genuinely honored. Combined with
`j2`'s finding for the `driver`/CLI path (same three fields, same "ignored"
behavior, confirmed there by the absence of any real agent that uses them),
this is **not an SDK peculiarity** — it is a Claude Code plugin-subagent
parsing limitation that reproduces identically across both code paths this
board has now tested it against. `session`/`manager` were not independently
probed here (both load plugins through the same host Claude Code process the
CLI and the SDK bundle, and both `j2` and this document find the same
frontmatter subset silently dropped on that shared parsing path), so "every
mode" rests on: two modes measured directly (`driver` via `j2`, `standalone`
via this document) sharing the same underlying plugin-loading code with
`session`/`manager`, not four independent measurements.

## 3. `settingSources: ["project"]` on a real checkout

### The fixture

A small directory outside any repository (`.../scratchpad/d3-probes/settingsrc-fixture/`),
containing exactly:

- `CLAUDE.md` with one marker line: `PROJECT_MARKER_CLAUDE_MD_LOADED_7f3a9c`
- `.claude/settings.json`: `{ "model": "haiku" }`
- `.claude/agents/fixture-project-agent.md`: a trivial project-scoped custom agent

This operator's **real** `~/.claude/settings.json` independently declares
`"model": "opus"` and a real `mcpServers.playwright` entry (npx-spawned) —
which made two things useful and one thing risky. Useful: `model` gives a
clean, distinguishable signal for "did user-scope apply." Risky: a live
`query()` run with `'user'` in scope could genuinely spawn that MCP server or
fire this operator's real `Notification`/`StopFailure` hooks (a Windows
`wscript.exe` notification) — a real side effect on the operator's own
machine, not a sandboxed artifact. So the safe tool for the `'user'`-inclusive
comparisons is `resolveSettings()`, which the SDK's own doc states
*"resolve[s] the effective Claude Code settings... using the same merge
engine as the CLI, **without spawning the Claude CLI**"* — a real measurement
with no process spawned, no hook fired, no MCP server contacted. Live
`query()` was used only for the two scopes that cannot touch the operator's
real config (`['project']` and `[]`).

### `resolveSettings()` — four scopes, real filesystem cascade

| `settingSources` | `effective.model` | `provenance.model.source` | `sources[]` |
| --- | --- | --- | --- |
| *(omitted — default)* | `"haiku"` | `project` | `user` (`~/.claude/settings.json`) **and** `project` (fixture) |
| `['project']` | `"haiku"` | `project` | `project` only |
| `[]` | `undefined` | `undefined` | *(empty)* |
| `['user']` | `"opus"` | `user` | `user` only |

Every row is a real call into the SDK's own settings-merge engine against a
real checkout. `['project']` cleanly excludes the operator's real `~/.claude`
(the default row proves it would otherwise be included — `project` wins on
precedence, but `user`'s path still appears in `sources[]` when not excluded);
`['user']` cleanly excludes the fixture. `[]` loads nothing at all, matching
the SDK's own doc for that value (*"Pass `[]` to disable filesystem settings
(SDK isolation mode)"*).

### Live `query()` cross-check — `['project']` vs `[]`, the two safe scopes

```
settingSources: ['project']  → model: "claude-haiku-4-5-20251001"  (alias resolved from the fixture's own settings.json)
                                agents: [...,"fixture-project-agent",...]  (fixture's .claude/agents/ picked up)
settingSources: []           → model: "claude-opus-5[1m]"           (SDK's own unconfigured default — NOT this operator's opus)
                                agents: [...] (fixture-project-agent ABSENT)
```

### CLAUDE.md — the one thing `resolveSettings()` cannot show

`resolveSettings()`'s `Settings` object is about `settings.json`-shaped
configuration; it says nothing about `CLAUDE.md` content reaching the model.
The SDK's own doc for `settingSources` states *"Must include `'project'` to
load `CLAUDE.md` files"* — a documentation claim, so it was tested rather than
trusted, with a real single-turn prompt (bounded, 20s abort, no tool use):

```
prompt: "...If your context includes a line starting with PROJECT_MARKER_CLAUDE_MD_LOADED,
         reply with exactly that line... If it does not, reply NO MARKER PRESENT..."

settingSources: ['project']  → reply: "PROJECT_MARKER_CLAUDE_MD_LOADED_7f3a9c"
settingSources: []           → reply: "NO MARKER PRESENT"
```

**Measured, decisively, not inferred:** `settingSources: ['project']` on a
real checkout loads that checkout's `CLAUDE.md` into the model's context, its
`.claude/settings.json`, and its `.claude/agents/`; excludes the operator's
own `~/.claude`; and `settingSources: []` excludes everything, including
`CLAUDE.md`, and falls back to the SDK's own unconfigured default model. This
is exactly the configuration `f1` (hosted runner selection) is meant to pin,
and `f1` itself already recorded that `drive` currently exposes no flag or env
var to set `settingSources` at all — this document is the evidence that
future task will need once it does.

## Summary — the difference, stated, not implied parity

| | Governs existence | Governs pre-approval only | Silently ignored |
| --- | --- | --- | --- |
| Agent tool | `tools` (unset by `sdk.ts` today → SDK default, not independently measurable from this environment) | `allowedTools` (what `sdk.ts`'s `REQUIRED_TOOLS` actually sets) | — |
| Plugin loading | the `plugins` option (works, confirmed for `pipeline:step-executor` and a fixture plugin) | — | a subagent's own `hooks`/`mcpServers`/`permissionMode` frontmatter, in every mode this board has tested |
| Config scope | `settingSources` (confirmed: `['project']` loads `CLAUDE.md` + `.claude/settings.json` + `.claude/agents/` from the checkout, excludes `~/.claude` entirely; `[]` excludes everything) | — | — |

None of this should be read as the four modes being equivalent. `standalone`
is the only one of the four with **no** `--bare`-style escape from an ambient
Claude Code session bleeding into a measurement of it — a real, structural gap
this task found while trying to measure cleanly, not a documentation claim.
The Agent tool's *existence* is governed by an option (`tools`) `sdk.ts`
never sets, while the option it *does* set (`allowedTools`) turned out, by
direct measurement, to govern something else entirely (permission
pre-approval). And the plugin-subagent frontmatter gap is real, reproduces
identically on the SDK path, and has nothing to do with `settingSources` or
locations at all — it is a parsing limitation, orthogonal to E9's whole
reframing.

## What this task could not measure

- **The SDK's true, unmodified default `tools` list**, i.e. whether `'Task'`
  (the Agent tool) is present when neither `tools` nor `allowedTools` is set
  at all, absent this environment's session-bridging. Every probe run from
  inside this Claude Code session — the only kind of environment this task
  had access to — reflects the bridged surface once no explicit `tools:`
  override is given (see "A confound found and routed around," above).
  Settling this would need either a genuinely detached process (no Claude
  Code ancestor in its process tree — not available from within a taskflow
  worker) or Anthropic documentation on the default explicitly, which this
  task deliberately did not substitute for a measurement.
- **What happens when the model actually attempts to invoke the Agent tool
  under a live, credentialed run** (a permission-prompt stall vs. a clean
  denial vs. success) was not exercised live. Doing so safely would have
  required either a real `ANTHROPIC_API_KEY` (none was available or created —
  out of scope for a measurement task, the same call `j1` made) or accepting
  the side-effect risk of a real nested-agent spawn through this
  environment's session bridge, which was deliberately avoided. The existing,
  already-merged `tests/sdk-executor.test.ts` fake-stream coverage
  (re-run for real during this task, 34/35 passing) is the closest available
  evidence for the code path's correctness, and is reported as exactly that —
  not as a substitute for a live turn.
- **`session`/`manager` were not independently probed** for the
  plugin-subagent frontmatter limitation; the "every mode" conclusion in
  section 2 rests on `driver` (`j2`) and `standalone` (this document) sharing
  the same plugin-loading code that `session`/`manager` also use, not on four
  separate measurements.

## Definition of Done — how each item is satisfied

- **All three measured against a real run, not inferred from documentation.**
  A real `@anthropic-ai/claude-agent-sdk@0.3.228` was installed and used for
  every probe in sections 1–3; `package.json` was restored byte-identical
  afterward and nothing besides this document is in `git diff --name-only`
  against `main`.
- **Behaviour with `Agent` missing from `allowedTools` is recorded
  explicitly.** Section 1: measured to have **no effect** on tool existence,
  in either direction — existence is governed by the separate `tools` option,
  which `sdk.ts` never sets.
- **The plugin-subagent frontmatter limitation is documented as applying to
  every mode, not just the SDK path.** Section 2, with the "every mode" claim's
  actual evidentiary basis stated precisely (two code paths measured directly,
  `session`/`manager` inferred from sharing the same loader) in "What this
  task could not measure."
- **`settingSources: ["project"]` behaviour on a real checkout is recorded.**
  Section 3: `resolveSettings()` across four scopes plus a live `query()`
  cross-check plus a direct `CLAUDE.md`-content echo test — all real, on a
  real fixture checkout.
- **The result lands in the CLI's user-facing docs, not only in
  `.taskflow/`.** This file, `docs/sdk-delta-measurement.md`, alongside
  `bare-baseline.md`, `bare-hooks.md`, `bare-auth.md`, `bare-tool-surface.md`,
  and `provider-key.md`.
- **Nothing in the docs implies the modes are equivalent.** See "Summary"
  above, stated as a difference, not a parity claim, and "What this task could
  not measure" names the gaps this document itself could not close rather than
  rounding them off.
