# `-p` baseline: `--bare` vs. default, measured

**Claude Code version (measured, `claude --version`):** `2.1.227 (Claude Code)`
**Date measured:** 2026-08-11
**Host:** Windows 11 (win32), git-bash (POSIX `sh`) as the invoking shell
**Working directory for every run below:** `C:\tmp\ai-pipeline-worktrees\j1-bare-baseline--pipeline` (a worktree of `public/package/pipeline`, no project-level `.claude/` and — except where a run deliberately adds one — no `CLAUDE.md`)

This document is a measurement, not a recommendation. It records what the
installed binary actually did across eleven bounded probes. It proposes no
fix and changes no `driver` behavior — that is j2/j3/j4's job, per
`.taskflow/2026-08-03-execution-modes/02-standalone-executor.md`. Anywhere a
probe could not settle a question, that is stated explicitly rather than
filled in from documentation.

Every probe used a trivial, bounded prompt in place of a real step-executor
iteration, per this task's own instructions ("a trivial prompt is fine — you
are measuring the harness, not the model"). None of the eleven runs read or
wrote a file, called a tool, or ran for more than a few seconds of API time.

## Environment established before any probe ran

Checked with `printenv <NAME>` (a plain lookup with no shell expansion, so it
is unambiguous):

- `printenv ANTHROPIC_API_KEY` → exit code 1 (unset). **No API key was present
  for any probe unless that probe's command line says otherwise (only run 9
  sets one, deliberately, and only for that one invocation).**
- `printenv CLAUDE_CODE_OAUTH_TOKEN` → exit code 1 (unset).
- `printenv CLAUDE_PLUGIN_ROOT` → exit code 1 (unset).

So every successful, non-`--bare` run below authenticated some other way —
see Category 1.

## Run index

| # | Flags beyond the shared prefix | Exit | Outcome |
|---|---|---|---|
| 1 | *(none — the baseline pair, no-`--bare` side)* | 0 | Succeeded; replied `OK` |
| 2 | `--bare` | 1 | Failed before any model turn: `Not logged in · Please run /login` |
| 3 | `--agent pipeline:step-executor` | 0 | Agent resolved; replied `RESOLVED` |
| 4 | `--bare --agent pipeline:step-executor` | 1 | Refused at argv-parse time, **no `system/init` emitted at all** |
| 5 | `--bare --agent pipeline:step-executor --plugin-dir <installed plugin cache, backslash path>` | 1 | Same refusal as run 4 |
| 5b | `--bare --agent pipeline:step-executor --plugin-dir <installed plugin cache, forward-slash path>` | 1 | Same refusal as run 4 (path style ruled out as the cause) |
| 5c | `--bare --plugin-dir <installed plugin cache>` (no `--agent`) | 1 | Reached `system/init`; plugin's **skills** appear, its **agents** do not; then failed auth |
| 5d | `--bare --plugin-dir <installed plugin cache> --agent step-executor` (unprefixed) | 1 | Same refusal as run 4/5, unprefixed name also not found |
| 6 | `--bare --agent probe-agent --agents '{"probe-agent":{...}}'` | 1 | Agent resolved (`probe-agent` in the `agents` list of `system/init`); then failed auth |
| 7 | *(none)*, cwd has a temp `CLAUDE.md` with a marker | 0 | Model echoed the marker back correctly |
| 8 | `--bare`, same temp `CLAUDE.md` | 1 | Failed before any model turn — question left unsettled by direct observation (see Category 4) |
| 9 | `--bare`, `ANTHROPIC_API_KEY=sk-ant-fake-test-key-for-harness-probe-000` | 1 | Reached the model; failed as `Invalid API key · Fix external API key` (HTTP 401) — a *different* failure than runs 2/8 |

Runs 1 and 2 are **the pair the task asks for**: the same representative
step, same cwd, same everything else, differing only in `--bare`. Runs 3–9
are supplementary probes needed to settle agent resolution and CLAUDE.md
auto-discovery, which the base pair's plain prompt does not exercise.

## Full command lines (reproducible verbatim)

All run from `C:\tmp\ai-pipeline-worktrees\j1-bare-baseline--pipeline`.

**Run 1** (baseline, no `--bare`):
```
claude -p "This is a harness measurement probe, not a real task. Reply with exactly the single word OK and take no other action." --output-format stream-json --verbose
```

**Run 2** (baseline, `--bare`):
```
claude -p "This is a harness measurement probe, not a real task. Reply with exactly the single word OK and take no other action." --bare --output-format stream-json --verbose
```

**Run 3** (agent resolution, no `--bare`, no `--plugin-dir`):
```
claude -p "This is a harness measurement probe, not a real task. Do not read or write any files and do not look for iteration files. Just reply with the single word RESOLVED and stop." --agent pipeline:step-executor --output-format stream-json --verbose
```

**Run 4** (agent resolution, `--bare`, no `--plugin-dir`):
```
claude -p "This is a harness measurement probe, not a real task. Do not read or write any files. Just reply with the single word RESOLVED and stop." --bare --agent pipeline:step-executor --output-format stream-json --verbose
```

**Run 5 / 5b** (agent resolution, `--bare`, with `--plugin-dir`; run twice,
once with a backslash path and once with a forward-slash path, to rule out
path-syntax as the cause — both failed identically):
```
claude -p "This is a harness measurement probe, not a real task. Do not read or write any files. Just reply with the single word RESOLVED and stop." --bare --agent pipeline:step-executor --plugin-dir "C:\Users\IvanD\.claude\plugins\cache\pipeline\pipeline\0.94.0" --output-format stream-json --verbose

claude -p "This is a harness measurement probe, not a real task. Do not read or write any files. Just reply with the single word RESOLVED and stop." --bare --agent pipeline:step-executor --plugin-dir "C:/Users/IvanD/.claude/plugins/cache/pipeline/pipeline/0.94.0" --output-format stream-json --verbose
```
`C:\Users\IvanD\.claude\plugins\cache\pipeline\pipeline\0.94.0` is this
machine's already-installed, marketplace-cached copy of the `pipeline`
plugin (`name: "pipeline"` in its `.claude-plugin/plugin.json`, the same
plugin that ships `agents/step-executor.md`). It is read-only reference
material outside this task's own worktree; nothing was written to it.

**Run 5c** (does `--plugin-dir` alone, no `--agent`, surface the plugin at all?):
```
claude -p "Reply with the single word OK and stop. Do not use tools." --bare --plugin-dir "C:/Users/IvanD/.claude/plugins/cache/pipeline/pipeline/0.94.0" --output-format stream-json --verbose
```

**Run 5d** (agent resolution, `--bare`, with `--plugin-dir`, unprefixed agent name):
```
claude -p "Reply RESOLVED and stop. Do not use tools." --bare --agent step-executor --plugin-dir "C:/Users/IvanD/.claude/plugins/cache/pipeline/pipeline/0.94.0" --output-format stream-json --verbose
```

**Run 6** (`--agents <json>` as a plugin-free alternative):
```
claude -p "Reply RESOLVED and stop. Do not use tools." --bare --agent probe-agent --agents "{\"probe-agent\":{\"description\":\"probe agent for harness measurement\",\"prompt\":\"You are a smoke-test agent. Reply with the single word RESOLVED and take no other action.\"}}" --output-format stream-json --verbose
```

**Run 7** (CLAUDE.md auto-discovery, no `--bare`) — run with a temporary
`CLAUDE.md` at the worktree root containing:
```
# temp probe marker

BARE_BASELINE_MARKER_7f3a2c19
```
```
claude -p "If a file named CLAUDE.md was auto-loaded into your context for this project, reply with only the marker string it contains. Otherwise reply with only the word NONE. Do not use any tools." --output-format stream-json --verbose
```

**Run 8** (same CLAUDE.md marker test, `--bare`):
```
claude -p "If a file named CLAUDE.md was auto-loaded into your context for this project, reply with only the marker string it contains. Otherwise reply with only the word NONE. Do not use any tools." --bare --output-format stream-json --verbose
```
(The temporary `CLAUDE.md` used by runs 7–8 was deleted immediately after
these two probes; it never reached this repository's committed tree — see
"No file outside `docs/` is modified" in the Definition of Done.)

**Run 9** (does `--bare` actually read `ANTHROPIC_API_KEY` when one is present?):
```
ANTHROPIC_API_KEY=sk-ant-fake-test-key-for-harness-probe-000 claude -p "Reply with the single word OK and stop. Do not use tools." --bare --output-format stream-json --verbose
```
The key is a deliberately invalid placeholder — this probe exists to observe
*how the failure mode changes* (see Category 1), not to authenticate for real.

## Category 1 — Authentication

**Observed, not from documentation:**

- **Run 1 (no `--bare`) succeeded with zero credential env vars set.**
  Its `system/init` reports `"apiKeySource":"none"` — i.e. it authenticated
  through neither `ANTHROPIC_API_KEY` nor an `apiKeyHelper`. The only
  remaining path is the logged-in session (OAuth / stored credential), and
  the run's own `claude --version`-style self-description in `--help`
  independently corroborates this split (see below). This is real evidence
  that non-`--bare` reads a login credential neither `ANTHROPIC_API_KEY` nor
  `--bare` requires.
- **Run 2 (`--bare`, no key) failed before any model turn ran.** Exit code 1.
  The one `assistant` frame emitted is a synthesized error, not a model
  response: `"text":"Not logged in · Please run /login"`,
  `"error":"authentication_failed"`. The terminal `result` frame carries
  `"result":"Not logged in · Please run /login"`. **This directly answers
  "does a run succeed with no `ANTHROPIC_API_KEY` present" under `--bare`: no.**
- **Run 9 (`--bare`, with a deliberately invalid `ANTHROPIC_API_KEY`) failed
  differently.** `system/init`'s `apiKeySource` flips to `"ANTHROPIC_API_KEY"`
  (proving `--bare` *did* read the variable), and the failure becomes
  `"Invalid API key · Fix external API key"` with `"api_error_status":401` —
  an actual API-level rejection, not "not logged in." This is the clean,
  measured proof that **`--bare`'s auth ladder does consult
  `ANTHROPIC_API_KEY` when present, and never falls back to the session
  login that run 1 used when it is absent or invalid** — runs 2 and 9 fail
  for two different, distinguishable reasons, and neither reason is "the
  OAuth session was tried."
- Runs 5c and 6 (`--bare`, no key, but otherwise past the argv-parsing stage)
  both fail with the exact same `"Not logged in · Please run /login"` /
  `authentication_failed` as run 2 — confirming this is a hard floor under
  `--bare` with no key present, independent of `--agent`/`--agents`/`--plugin-dir`.
- The installed binary's own `claude -p --help` states this policy in its
  own words (quoted here as the tool's self-description, not as external
  documentation, and clearly distinguished from the measurements above):
  > `--bare` ... Anthropic auth is strictly `ANTHROPIC_API_KEY` or
  > `apiKeyHelper` via `--settings` (OAuth and keychain are never read). 3P
  > providers (Bedrock/Vertex/Foundry) use their own credentials.
  Every measured run above is consistent with this sentence; the sentence
  was not needed to reach the conclusions above, but it matches them exactly.

**Not settled:** whether a *valid* `ANTHROPIC_API_KEY` lets `--bare` complete
a full turn end-to-end. No real key was available in this environment (see
"Environment established" above), and creating a billable, working key was
out of scope for a measurement task. Run 9 settles that the key *is read*
and *is what gates the failure mode*, which is as far as this probe set can
go without a real credential.

## Category 2 — Tool surface

Directly from each run's `system/init.tools`:

- **Run 1 (no `--bare`):** 33 first-party tools plus 24
  `mcp__claude_ai_Gmail__*` / `mcp__claude_ai_Google_Calendar__*` /
  `mcp__claude_ai_Google_Drive__*` tools — the full set available to this
  operator's account, including `Grep`, `Glob`, `WebFetch`, `WebSearch`,
  `LSP`, and the Agent-tool (listed as `"Task"` in this build's tool names)
  it is used to answer "does the Agent tool disappear."
  **Caveat:** the MCP-derived Gmail/Calendar/Drive tools are this operator's
  personal, unrelated MCP servers, not anything `pipeline`-specific — they
  are reported here for completeness, but should not be read as part of what
  `driver` itself would ever see.
- **Run 2 (`--bare`):** exactly four tools —
  `["Bash","Edit","PowerShell","Read"]`. `Grep`, `Glob`, `WebFetch`,
  `WebSearch`, `LSP` and the Agent/`Task` tool are **absent**, confirming the
  documented claim by direct measurement. `mcp_servers` is `[]` (versus 4
  entries in run 1).
  **One measured detail beyond what the design doc's summary states:**
  `--bare`'s tool list on this Windows host also includes `PowerShell`,
  not just `Bash`/`Read`/`Edit`. Whether that is Windows-specific
  (`PowerShell` standing in for a POSIX shell that doesn't exist here) or a
  general fourth bare-mode tool was not something this probe set could
  determine — flagged here as an observed discrepancy from the three-tool
  description, not resolved.
- **Run 3 (no `--bare`, `--agent pipeline:step-executor`):** tools narrow to
  the agent's own declared frontmatter list —
  `["Read","Edit","Write","Bash","Glob","Grep","WebFetch","WebSearch","Skill","Task","LSP","ToolSearch","TaskCreate","TaskGet","TaskList","TaskUpdate"]`
  — which matches `step-executor.md`'s frontmatter (`tools: Read, Edit,
  Write, Bash, Glob, Grep, WebFetch, WebSearch, Skill, Agent, LSP,
  ToolSearch, TaskCreate, TaskGet, TaskList, TaskUpdate`) with `Agent`
  surfaced as `Task`.

## Category 3 — Agent resolution

- **Run 3 (no `--bare`, no `--plugin-dir`):** `--agent pipeline:step-executor`
  resolved cleanly (`system/init.agents` includes
  `"pipeline:pipeline-manager"`, `"pipeline:step-executor"`, etc.; the model
  replied `RESOLVED`). Plugin auto-discovery alone was sufficient — no
  `--plugin-dir` needed, because this operator already has the `pipeline`
  plugin installed (`"pipeline@pipeline"`, version `0.94.0`, in the
  `plugins` list).
- **Run 4 (`--bare`, no `--plugin-dir`):** hard failure **before**
  `system/init` is even emitted (stdout is empty; the whole story is in
  stderr):
  ```
  --agent 'pipeline:step-executor' not found. Available agents: claude, Explore, general-purpose, Plan, statusline-setup
  ```
  Exit code 1. This confirms the documented claim that plugin-provided agent
  names stop resolving under `--bare`.
- **Runs 5 / 5b (`--bare`, `--plugin-dir` pointing at the installed
  `pipeline` plugin's cache directory, both path styles):** **the exact same
  failure as run 4, byte-for-byte** —
  `--agent 'pipeline:step-executor' not found. Available agents: claude, Explore, general-purpose, Plan, statusline-setup`.
  **This measurement contradicts the design document's assumption that
  `--plugin-dir` restores `--agent pipeline:step-executor` resolution under
  `--bare`.** On Claude Code 2.1.227, it does not — not with the prefixed
  name.
- **Run 5c (`--bare`, `--plugin-dir`, no `--agent` at all)** narrows down
  *why*: `system/init` is reached this time, and its `plugins` array now
  includes the loaded plugin —
  `{"name":"pipeline","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\pipeline\\0.94.0","source":"pipeline@inline","version":"0.94.0"}`
  — and its `slash_commands`/`skills` arrays now include the plugin's
  **skills** (`pipeline:clone`, `pipeline:design`, `pipeline:dispatch`,
  `pipeline:find`, `pipeline:optimize`, `pipeline:run`). But `agents` is
  still exactly `["claude","Explore","general-purpose","Plan","statusline-setup"]`
  — **no `pipeline:`-prefixed agent appears at all.** So `--plugin-dir` did
  load the plugin (its skills prove that) but did **not** register its
  agents into the resolvable set on this version.
- **Run 5d (`--bare`, `--plugin-dir`, `--agent step-executor` — unprefixed):**
  same failure, same "Available agents" list, ruling out "maybe it needs the
  unprefixed name when loaded via `--plugin-dir`" as an explanation.
- **Run 6 (`--bare`, `--agents '{"probe-agent": {...}}'`, `--agent
  probe-agent`):** **this alternative worked.** `system/init.agents` is
  `["claude","Explore","general-purpose","Plan","probe-agent","statusline-setup"]`
  — `probe-agent` is present, meaning the CLI accepted and resolved the
  inline agent definition with **no plugin involved at all**. The run then
  failed with the same `Not logged in · Please run /login` as every other
  no-key `--bare` run (Category 1) — a *different, later* failure than runs
  4/5/5b/5d's *"not found"*, which never got past argv parsing. **This
  confirms the documented claim that `--agents <json>` is a working
  alternative that needs no plugin — measured up to the point where the
  (unrelated) authentication gap in this environment stops every `--bare`
  run regardless of agent source.**

## Category 4 — Hooks, skills, MCP, CLAUDE.md

- **Hooks:** Run 1's raw stream opens with two `system/hook_started` /
  `system/hook_response` pairs for `SessionStart:startup` before
  `system/init`. Run 2 (`--bare`) has **no hook frames at all** — its stream
  starts directly at `system/init`. Directly measured, not from docs.
- **Skills / slash commands:** Run 1's `slash_commands` includes the
  `pipeline:*` and `taskflow:*` entries (`pipeline:clone`, `pipeline:design`,
  …, `taskflow:taskflow-execute`, …). Run 2's `slash_commands` omits every
  plugin-namespaced entry, keeping only built-ins (`deep-research`,
  `design-sync`, `dataviz`, …). Run 5c shows `--plugin-dir` **can** restore a
  plugin's skills under `--bare` even though (Category 3) it does not
  restore its agents — the two are not gated together.
- **MCP:** Run 1's `mcp_servers` lists four servers (the `pipeline`
  plugin's `ai-pipeline-departments` MCP entry, plus this operator's
  personal Gmail/Calendar/Drive connections). Run 2's `mcp_servers` is `[]`.
  Directly measured.
- **CLAUDE.md:** **Settled for the non-`--bare` side, not settled for
  `--bare`.** Run 7 placed a `CLAUDE.md` with a unique marker
  (`BARE_BASELINE_MARKER_7f3a2c19`) at the worktree root and asked the model
  to recite it without using any tool; the model replied with exactly the
  marker string, proving it was auto-loaded into context (this is a live
  measurement, not an inference from `--help` text). Run 8 repeated the
  identical setup under `--bare` — and, like every other no-key `--bare`
  run, failed at the authentication step before a single model turn ran, so
  **no model response exists to confirm or refute CLAUDE.md loading under
  `--bare`.** This question is explicitly left unsettled by direct
  observation. The installed binary's own `--help` text states `--bare`
  skips "CLAUDE.md auto-discovery" among "hooks, LSP, plugin sync,
  attribution, auto-memory, background prefetches, keychain reads" — quoted
  here as the tool's self-description, clearly labeled as such and not
  conflated with a measured result.

## `system/init` — verbatim

### Run 1 (no `--bare`)

```json
{"type":"system","subtype":"init","cwd":"C:\\tmp\\ai-pipeline-worktrees\\j1-bare-baseline--pipeline","session_id":"a9989f29-c3a6-4ceb-9cfd-ad101a6bf9d8","tools":["Task","Bash","CronCreate","CronDelete","CronList","DesignSync","Edit","EnterWorktree","ExitWorktree","Glob","Grep","LSP","Monitor","NotebookEdit","PowerShell","PushNotification","Read","RemoteTrigger","ReportFindings","ScheduleWakeup","SendMessage","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","ToolSearch","WebFetch","WebSearch","Workflow","Write","mcp__claude_ai_Gmail__apply_sensitive_message_label","mcp__claude_ai_Gmail__apply_sensitive_thread_label","mcp__claude_ai_Gmail__create_draft","mcp__claude_ai_Gmail__create_label","mcp__claude_ai_Gmail__delete_label","mcp__claude_ai_Gmail__get_message","mcp__claude_ai_Gmail__get_thread","mcp__claude_ai_Gmail__label_message","mcp__claude_ai_Gmail__label_thread","mcp__claude_ai_Gmail__list_drafts","mcp__claude_ai_Gmail__list_labels","mcp__claude_ai_Gmail__search_threads","mcp__claude_ai_Gmail__unlabel_message","mcp__claude_ai_Gmail__unlabel_thread","mcp__claude_ai_Gmail__update_draft","mcp__claude_ai_Gmail__update_label","mcp__claude_ai_Google_Calendar__create_event","mcp__claude_ai_Google_Calendar__delete_event","mcp__claude_ai_Google_Calendar__get_event","mcp__claude_ai_Google_Calendar__list_calendars","mcp__claude_ai_Google_Calendar__list_events","mcp__claude_ai_Google_Calendar__respond_to_event","mcp__claude_ai_Google_Calendar__search_events","mcp__claude_ai_Google_Calendar__suggest_time","mcp__claude_ai_Google_Calendar__update_event","mcp__claude_ai_Google_Drive__copy_file","mcp__claude_ai_Google_Drive__create_file","mcp__claude_ai_Google_Drive__download_file_content","mcp__claude_ai_Google_Drive__get_file_metadata","mcp__claude_ai_Google_Drive__get_file_permissions","mcp__claude_ai_Google_Drive__list_recent_files","mcp__claude_ai_Google_Drive__read_file_content","mcp__claude_ai_Google_Drive__search_files"],"mcp_servers":[{"name":"plugin:pipeline:ai-pipeline-departments","status":"needs-auth"},{"name":"claude.ai Gmail","status":"connected"},{"name":"claude.ai Google Calendar","status":"connected"},{"name":"claude.ai Google Drive","status":"connected"}],"model":"claude-opus-5","permissionMode":"auto","slash_commands":["deep-research","frontend-design:frontend-design","taskflow:taskflow-execute","taskflow:taskflow-plan","taskflow:taskflow-review","taskflow:taskflow-tasks","pipeline:clone","pipeline:design","pipeline:dispatch","pipeline:find","pipeline:optimize","pipeline:run","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","schedule","claude-api","run","run-skill-generator","agents","autocompact","clear","color","compact","config","context","effort","fast","heapdump","init","mcp","import","model","__remote-workflow","workflow-launch-exec","reload-skills","rename","ultrareview","security-review","usage-credits","extra-usage","usage","insights","recap","goal","design","design-consent","design-revoke","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.227","output_style":"default","agents":["claude","Explore","general-purpose","pipeline:pipeline-disambiguator","pipeline:pipeline-improver","pipeline:pipeline-manager","pipeline:pipeline-script-creator","pipeline:step-executor","Plan","statusline-setup","taskflow:taskflow-implementer","taskflow:taskflow-reviewer"],"skills":["deep-research","frontend-design:frontend-design","taskflow:taskflow-execute","taskflow:taskflow-plan","taskflow:taskflow-review","taskflow:taskflow-tasks","pipeline:clone","pipeline:design","pipeline:dispatch","pipeline:find","pipeline:optimize","pipeline:run","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","schedule","claude-api","run","run-skill-generator"],"plugins":[{"name":"frontend-design","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\frontend-design\\unknown","source":"frontend-design@claude-plugins-official"},{"name":"pyright-lsp","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\pyright-lsp\\1.0.0","source":"pyright-lsp@claude-plugins-official","version":"1.0.0"},{"name":"taskflow","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\taskflow\\0.7.0","source":"taskflow@pipeline","version":"0.7.0"},{"name":"pipeline","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\pipeline\\0.94.0","source":"pipeline@pipeline","version":"0.94.0"}],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"8670f6d9-de71-4de2-aca1-5ec7b7a9d9c3","memory_paths":{"auto":"C:\\Users\\IvanD\\.claude\\projects\\C--Projects-AI-ai-pipeline--git-modules-public-package-pipeline\\memory\\"},"fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}
```

Followed by the assistant turn and terminal result:
```json
{"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011CdvpvdUoK5hqL4pwWxZ21","type":"message","role":"assistant","content":[{"type":"text","text":"OK"}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":8870,"cache_read_input_tokens":20668,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":8870},"output_tokens":1,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"a9989f29-c3a6-4ceb-9cfd-ad101a6bf9d8","uuid":"7d9d32da-cd6e-42fb-a7c7-01488794b0ad","timestamp":"2026-08-11T10:46:29.042Z","request_id":"req_011CdvpvcjetbXLoDFEDotqq"}
{"is_error":false,"duration_api_ms":1631,"num_turns":1,"stop_reason":"end_turn","session_id":"a9989f29-c3a6-4ceb-9cfd-ad101a6bf9d8","total_cost_usd":0.099144,"usage":{"input_tokens":2,"cache_creation_input_tokens":8870,"cache_read_input_tokens":20668,"output_tokens":4,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":8870,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":4,"cache_read_input_tokens":20668,"cache_creation_input_tokens":8870,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":8870},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-opus-5":{"inputTokens":2,"outputTokens":4,"cacheReadInputTokens":20668,"cacheCreationInputTokens":8870,"webSearchRequests":0,"costUSD":0.099144,"contextWindow":1000000,"maxOutputTokens":64000,"canonicalModel":"claude-opus-5","provider":"firstParty"}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subtype":"success","api_error_status":null,"result":"OK","ttft_ms":2821,"ttft_stream_ms":2082,"time_to_request_ms":1216,"type":"result","duration_ms":7113,"uuid":"859305be-2597-4b6e-86b1-a5bb5d451522"}
```

### Run 2 (`--bare`)

```json
{"type":"system","subtype":"init","cwd":"C:\\tmp\\ai-pipeline-worktrees\\j1-bare-baseline--pipeline","session_id":"d948f7ff-6799-49c6-9ac1-94dc89eede64","tools":["Bash","Edit","PowerShell","Read"],"mcp_servers":[],"model":"claude-opus-5","permissionMode":"auto","slash_commands":["deep-research","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","claude-api","run","run-skill-generator","agents","autocompact","clear","color","compact","config","context","effort","fast","heapdump","init","mcp","import","model","__remote-workflow","workflow-launch-exec","reload-skills","rename","security-review","usage","insights","recap","goal","design","design-consent","design-revoke","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.227","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["deep-research","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","claude-api","run","run-skill-generator"],"plugins":[{"name":"frontend-design","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\frontend-design\\unknown","source":"frontend-design@claude-plugins-official"},{"name":"pyright-lsp","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\pyright-lsp\\1.0.0","source":"pyright-lsp@claude-plugins-official","version":"1.0.0"},{"name":"taskflow","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\taskflow\\0.7.0","source":"taskflow@pipeline","version":"0.7.0"},{"name":"pipeline","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\pipeline\\0.94.0","source":"pipeline@pipeline","version":"0.94.0"}],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"b261511c-9ff9-432f-bf50-7ec51fe9eb14","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}
```

Followed by the synthesized auth-failure turn and terminal result:
```json
{"type":"assistant","message":{"id":"9ced1f8d-777c-41aa-bdb3-7531ca19d619","container":null,"model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":null,"iterations":null,"speed":null},"content":[{"type":"text","text":"Not logged in · Please run /login"}],"context_management":null},"parent_tool_use_id":null,"session_id":"d948f7ff-6799-49c6-9ac1-94dc89eede64","uuid":"a891e606-26b2-4940-99c5-65a93a48f53d","timestamp":"2026-08-11T10:47:05.886Z","error":"authentication_failed","is_api_error_message":true}
{"is_error":true,"duration_api_ms":0,"num_turns":1,"stop_reason":"stop_sequence","session_id":"d948f7ff-6799-49c6-9ac1-94dc89eede64","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"api_error","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subtype":"success","api_error_status":null,"result":"Not logged in · Please run /login","type":"result","duration_ms":9493,"uuid":"7a862513-4f39-4295-a9e7-00ca08cc2540"}
```

### Run 3 (no `--bare`, `--agent pipeline:step-executor`, no `--plugin-dir`)

```json
{"type":"system","subtype":"init","cwd":"C:\\tmp\\ai-pipeline-worktrees\\j1-bare-baseline--pipeline","session_id":"077bcd95-6a5b-432a-857e-15814b5460d3","tools":["Read","Edit","Write","Bash","Glob","Grep","WebFetch","WebSearch","Skill","Task","LSP","ToolSearch","TaskCreate","TaskGet","TaskList","TaskUpdate"],"mcp_servers":[{"name":"plugin:pipeline:ai-pipeline-departments","status":"needs-auth"}],"model":"claude-opus-5","permissionMode":"auto","slash_commands":["deep-research","frontend-design:frontend-design","taskflow:taskflow-execute","taskflow:taskflow-plan","taskflow:taskflow-review","taskflow:taskflow-tasks","pipeline:clone","pipeline:design","pipeline:dispatch","pipeline:find","pipeline:optimize","pipeline:run","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","schedule","claude-api","run","run-skill-generator","agents","autocompact","clear","color","compact","config","context","effort","fast","heapdump","init","mcp","import","model","__remote-workflow","workflow-launch-exec","reload-skills","rename","ultrareview","security-review","usage-credits","extra-usage","usage","insights","recap","goal","design","design-consent","design-revoke","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.227","output_style":"default","agents":["claude","Explore","general-purpose","pipeline:pipeline-disambiguator","pipeline:pipeline-improver","pipeline:pipeline-manager","pipeline:pipeline-script-creator","pipeline:step-executor","Plan","statusline-setup","taskflow:taskflow-implementer","taskflow:taskflow-reviewer"],"skills":["deep-research","frontend-design:frontend-design","taskflow:taskflow-execute","taskflow:taskflow-plan","taskflow:taskflow-review","taskflow:taskflow-tasks","pipeline:clone","pipeline:design","pipeline:dispatch","pipeline:find","pipeline:optimize","pipeline:run","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","schedule","claude-api","run","run-skill-generator"],"plugins":[{"name":"frontend-design","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\frontend-design\\unknown","source":"frontend-design@claude-plugins-official"},{"name":"pyright-lsp","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\pyright-lsp\\1.0.0","source":"pyright-lsp@claude-plugins-official","version":"1.0.0"},{"name":"taskflow","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\taskflow\\0.7.0","source":"taskflow@pipeline","version":"0.7.0"},{"name":"pipeline","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\pipeline\\0.94.0","source":"pipeline@pipeline","version":"0.94.0"}],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"d2857527-6096-4182-a334-e291817ec53c","memory_paths":{"auto":"C:\\Users\\IvanD\\.claude\\projects\\C--Projects-AI-ai-pipeline--git-modules-public-package-pipeline\\memory\\"},"fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}
```

Terminal result: `"result":"RESOLVED"`, `total_cost_usd":0.2966`.

### Run 4 (`--bare`, `--agent pipeline:step-executor`, no `--plugin-dir`)

**No `system/init` was emitted — stdout was empty.** The entire result is on
stderr, and the process exited 1 before reaching initialization:
```
--agent 'pipeline:step-executor' not found. Available agents: claude, Explore, general-purpose, Plan, statusline-setup
```

### Runs 5 and 5b (`--bare`, `--agent pipeline:step-executor`, `--plugin-dir` set, backslash then forward-slash path)

**No `system/init` emitted for either.** Both stderrs are byte-identical to
run 4's:
```
--agent 'pipeline:step-executor' not found. Available agents: claude, Explore, general-purpose, Plan, statusline-setup
```

### Run 5c (`--bare`, `--plugin-dir` set, no `--agent`)

```json
{"type":"system","subtype":"init","cwd":"C:\\tmp\\ai-pipeline-worktrees\\j1-bare-baseline--pipeline","session_id":"2de132c2-4272-4d77-a318-8f037b86baec","tools":["Bash","Edit","PowerShell","Read"],"mcp_servers":[],"model":"claude-opus-5","permissionMode":"auto","slash_commands":["deep-research","pipeline:clone","pipeline:design","pipeline:dispatch","pipeline:find","pipeline:optimize","pipeline:run","frontend-design:frontend-design","taskflow:taskflow-execute","taskflow:taskflow-plan","taskflow:taskflow-review","taskflow:taskflow-tasks","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","claude-api","run","run-skill-generator","agents","autocompact","clear","color","compact","config","context","effort","fast","heapdump","init","mcp","import","model","__remote-workflow","workflow-launch-exec","reload-skills","rename","security-review","usage","insights","recap","goal","design","design-consent","design-revoke","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.227","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["deep-research","pipeline:clone","pipeline:design","pipeline:dispatch","pipeline:find","pipeline:optimize","pipeline:run","frontend-design:frontend-design","taskflow:taskflow-execute","taskflow:taskflow-plan","taskflow:taskflow-review","taskflow:taskflow-tasks","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","claude-api","run","run-skill-generator"],"plugins":[{"name":"pipeline","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\pipeline\\0.94.0","source":"pipeline@inline","version":"0.94.0"},{"name":"frontend-design","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\frontend-design\\unknown","source":"frontend-design@claude-plugins-official"},{"name":"pyright-lsp","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\pyright-lsp\\1.0.0","source":"pyright-lsp@claude-plugins-official","version":"1.0.0"},{"name":"taskflow","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\taskflow\\0.7.0","source":"taskflow@pipeline","version":"0.7.0"}],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"0cb41e80-088e-4e58-86a4-1004e30919f1","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}
```

Note `plugins[0].source` is `"pipeline@inline"` here (versus `"pipeline@pipeline"`
in runs 1–3) — the CLI's own way of marking a `--plugin-dir`-loaded plugin as
distinct from a marketplace-installed one. `agents` still lists only the five
built-ins.

Terminal result (same auth failure as run 2):
```json
{"type":"assistant","message":{"id":"1f72afd5-2fd2-4d44-a2c9-69436213d2af","container":null,"model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":null,"iterations":null,"speed":null},"content":[{"type":"text","text":"Not logged in · Please run /login"}],"context_management":null},"parent_tool_use_id":null,"session_id":"2de132c2-4272-4d77-a318-8f037b86baec","uuid":"8341f9d9-7a80-42a5-8957-16c9b423acaa","timestamp":"2026-08-11T10:51:12.706Z","error":"authentication_failed","is_api_error_message":true}
{"is_error":true,"duration_api_ms":0,"num_turns":1,"stop_reason":"stop_sequence","session_id":"2de132c2-4272-4d77-a318-8f037b86baec","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"api_error","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subtype":"success","api_error_status":null,"result":"Not logged in · Please run /login","type":"result","duration_ms":2098,"uuid":"975f2247-2703-45e1-8e6c-90316ccd9ddc"}
```

### Run 5d (`--bare`, `--plugin-dir` set, `--agent step-executor` unprefixed)

**No `system/init` emitted.** stderr:
```
--agent 'step-executor' not found. Available agents: claude, Explore, general-purpose, Plan, statusline-setup
```

### Run 6 (`--bare`, `--agents '{"probe-agent": {...}}'`, `--agent probe-agent`)

```json
{"type":"system","subtype":"init","cwd":"C:\\tmp\\ai-pipeline-worktrees\\j1-bare-baseline--pipeline","session_id":"8a5188ca-5b8a-47cf-b000-f7e81738e5af","tools":["Bash","Edit","PowerShell","Read"],"mcp_servers":[],"model":"claude-opus-5","permissionMode":"auto","slash_commands":["deep-research","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","claude-api","run","run-skill-generator","agents","autocompact","clear","color","compact","config","context","effort","fast","heapdump","init","mcp","import","model","__remote-workflow","workflow-launch-exec","reload-skills","rename","security-review","usage","insights","recap","goal","design","design-consent","design-revoke","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.227","output_style":"default","agents":["claude","Explore","general-purpose","Plan","probe-agent","statusline-setup"],"skills":["deep-research","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","claude-api","run","run-skill-generator"],"plugins":[{"name":"frontend-design","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\frontend-design\\unknown","source":"frontend-design@claude-plugins-official"},{"name":"pyright-lsp","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\pyright-lsp\\1.0.0","source":"pyright-lsp@claude-plugins-official","version":"1.0.0"},{"name":"taskflow","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\taskflow\\0.7.0","source":"taskflow@pipeline","version":"0.7.0"},{"name":"pipeline","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\pipeline\\0.94.0","source":"pipeline@pipeline","version":"0.94.0"}],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"271f1b00-251c-4be3-bfd0-2d7edec0c211","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}
```

`agents` includes `"probe-agent"` — resolution succeeded. Terminal result is
the same `Not logged in · Please run /login` auth failure as every other
no-key `--bare` run (`duration_ms":34` — it failed immediately, before any
API call, exactly like the others).

### Run 7 (no `--bare`, CLAUDE.md marker test)

```json
{"type":"system","subtype":"init","cwd":"C:\\tmp\\ai-pipeline-worktrees\\j1-bare-baseline--pipeline","session_id":"6f5fa8e1-1659-4b03-8de4-b9e44b30d68c","tools":["Task","Bash","CronCreate","CronDelete","CronList","DesignSync","Edit","EnterWorktree","ExitWorktree","Glob","Grep","LSP","Monitor","NotebookEdit","PowerShell","PushNotification","Read","RemoteTrigger","ReportFindings","ScheduleWakeup","SendMessage","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","ToolSearch","WebFetch","WebSearch","Workflow","Write","mcp__claude_ai_Gmail__apply_sensitive_message_label","mcp__claude_ai_Gmail__apply_sensitive_thread_label","mcp__claude_ai_Gmail__create_draft","mcp__claude_ai_Gmail__create_label","mcp__claude_ai_Gmail__delete_label","mcp__claude_ai_Gmail__get_message","mcp__claude_ai_Gmail__get_thread","mcp__claude_ai_Gmail__label_message","mcp__claude_ai_Gmail__label_thread","mcp__claude_ai_Gmail__list_drafts","mcp__claude_ai_Gmail__list_labels","mcp__claude_ai_Gmail__search_threads","mcp__claude_ai_Gmail__unlabel_message","mcp__claude_ai_Gmail__unlabel_thread","mcp__claude_ai_Gmail__update_draft","mcp__claude_ai_Gmail__update_label","mcp__claude_ai_Google_Calendar__create_event","mcp__claude_ai_Google_Calendar__delete_event","mcp__claude_ai_Google_Calendar__get_event","mcp__claude_ai_Google_Calendar__list_calendars","mcp__claude_ai_Google_Calendar__list_events","mcp__claude_ai_Google_Calendar__respond_to_event","mcp__claude_ai_Google_Calendar__search_events","mcp__claude_ai_Google_Calendar__suggest_time","mcp__claude_ai_Google_Calendar__update_event","mcp__claude_ai_Google_Drive__copy_file","mcp__claude_ai_Google_Drive__create_file","mcp__claude_ai_Google_Drive__download_file_content","mcp__claude_ai_Google_Drive__get_file_metadata","mcp__claude_ai_Google_Drive__get_file_permissions","mcp__claude_ai_Google_Drive__list_recent_files","mcp__claude_ai_Google_Drive__read_file_content","mcp__claude_ai_Google_Drive__search_files"],"mcp_servers":[{"name":"plugin:pipeline:ai-pipeline-departments","status":"needs-auth"},{"name":"claude.ai Gmail","status":"connected"},{"name":"claude.ai Google Calendar","status":"connected"},{"name":"claude.ai Google Drive","status":"connected"}],"model":"claude-opus-5","permissionMode":"auto","slash_commands":["deep-research","frontend-design:frontend-design","taskflow:taskflow-execute","taskflow:taskflow-plan","taskflow:taskflow-review","taskflow:taskflow-tasks","pipeline:clone","pipeline:design","pipeline:dispatch","pipeline:find","pipeline:optimize","pipeline:run","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","schedule","claude-api","run","run-skill-generator","agents","autocompact","clear","color","compact","config","context","effort","fast","heapdump","init","mcp","import","model","__remote-workflow","workflow-launch-exec","reload-skills","rename","ultrareview","security-review","usage-credits","extra-usage","usage","insights","recap","goal","design","design-consent","design-revoke","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.227","output_style":"default","agents":["claude","Explore","general-purpose","pipeline:pipeline-disambiguator","pipeline:pipeline-improver","pipeline:pipeline-manager","pipeline:pipeline-script-creator","pipeline:step-executor","Plan","statusline-setup","taskflow:taskflow-implementer","taskflow:taskflow-reviewer"],"skills":["deep-research","frontend-design:frontend-design","taskflow:taskflow-execute","taskflow:taskflow-plan","taskflow:taskflow-review","taskflow:taskflow-tasks","pipeline:clone","pipeline:design","pipeline:dispatch","pipeline:find","pipeline:optimize","pipeline:run","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","schedule","claude-api","run","run-skill-generator"],"plugins":[{"name":"frontend-design","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\frontend-design\\unknown","source":"frontend-design@claude-plugins-official"},{"name":"pyright-lsp","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\pyright-lsp\\1.0.0","source":"pyright-lsp@claude-plugins-official","version":"1.0.0"},{"name":"taskflow","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\taskflow\\0.7.0","source":"taskflow@pipeline","version":"0.7.0"},{"name":"pipeline","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\pipeline\\0.94.0","source":"pipeline@pipeline","version":"0.94.0"}],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"f313deae-2b35-4e67-b4ca-aba5d739bd96","memory_paths":{"auto":"C:\\Users\\IvanD\\.claude\\projects\\C--Projects-AI-ai-pipeline--git-modules-public-package-pipeline\\memory\\"},"fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}
```

Terminal result: `"result":"BARE_BASELINE_MARKER_7f3a2c19"` — the model
recited the marker, proving the temporary `CLAUDE.md` was auto-loaded.

### Run 8 (`--bare`, CLAUDE.md marker test)

```json
{"type":"system","subtype":"init","cwd":"C:\\tmp\\ai-pipeline-worktrees\\j1-bare-baseline--pipeline","session_id":"46163ced-9542-4257-87ae-61c5cb594f66","tools":["Bash","Edit","PowerShell","Read"],"mcp_servers":[],"model":"claude-opus-5","permissionMode":"auto","slash_commands":["deep-research","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","claude-api","run","run-skill-generator","agents","autocompact","clear","color","compact","config","context","effort","fast","heapdump","init","mcp","import","model","__remote-workflow","workflow-launch-exec","reload-skills","rename","security-review","usage","insights","recap","goal","design","design-consent","design-revoke","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.227","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["deep-research","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","claude-api","run","run-skill-generator"],"plugins":[{"name":"frontend-design","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\frontend-design\\unknown","source":"frontend-design@claude-plugins-official"},{"name":"pyright-lsp","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\pyright-lsp\\1.0.0","source":"pyright-lsp@claude-plugins-official","version":"1.0.0"},{"name":"taskflow","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\taskflow\\0.7.0","source":"taskflow@pipeline","version":"0.7.0"},{"name":"pipeline","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\pipeline\\0.94.0","source":"pipeline@pipeline","version":"0.94.0"}],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"7f030475-2b46-4cdb-a478-4dda75ce3cde","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}
```

Terminal result: the same `Not logged in · Please run /login` as every other
no-key `--bare` run. **No model turn ran, so this run cannot confirm or
deny whether the marker would have been visible.**

### Run 9 (`--bare`, invalid `ANTHROPIC_API_KEY` present)

```json
{"type":"system","subtype":"init","cwd":"C:\\tmp\\ai-pipeline-worktrees\\j1-bare-baseline--pipeline","session_id":"fbc382ca-1c2f-4a8c-a083-fbfb9449b40b","tools":["Bash","Edit","PowerShell","Read"],"mcp_servers":[],"model":"claude-opus-5","permissionMode":"auto","slash_commands":["deep-research","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","claude-api","run","run-skill-generator","agents","autocompact","clear","color","compact","config","context","effort","fast","heapdump","init","mcp","import","model","__remote-workflow","workflow-launch-exec","reload-skills","rename","security-review","usage","insights","recap","goal","design","design-consent","design-revoke","team-onboarding"],"apiKeySource":"ANTHROPIC_API_KEY","claude_code_version":"2.1.227","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["deep-research","design-sync","dataviz","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","doctor","loop","claude-api","run","run-skill-generator"],"plugins":[{"name":"frontend-design","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\frontend-design\\unknown","source":"frontend-design@claude-plugins-official"},{"name":"pyright-lsp","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\claude-plugins-official\\pyright-lsp\\1.0.0","source":"pyright-lsp@claude-plugins-official","version":"1.0.0"},{"name":"taskflow","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\taskflow\\0.7.0","source":"taskflow@pipeline","version":"0.7.0"},{"name":"pipeline","path":"C:\\Users\\IvanD\\.claude\\plugins\\cache\\pipeline\\pipeline\\0.94.0","source":"pipeline@pipeline","version":"0.94.0"}],"capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"b689c597-5a27-493b-a0c4-2cd7fc3451c2","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required"}
```

Note `"apiKeySource":"ANTHROPIC_API_KEY"` — the one field that differs from
every other `--bare` run's `"apiKeySource":"none"`. Terminal result:
```json
{"type":"assistant","message":{"id":"dba933f0-778e-4711-a934-cc77d6d5b762","container":null,"model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":null,"iterations":null,"speed":null},"content":[{"type":"text","text":"Invalid API key · Fix external API key"}],"context_management":null},"parent_tool_use_id":null,"session_id":"fbc382ca-1c2f-4a8c-a083-fbfb9449b40b","uuid":"048b7e34-22cb-4cae-b9e5-0c6458f2343e","timestamp":"2026-08-11T10:54:47.566Z","error":"authentication_failed","request_id":"req_011CdvqZTbmKtp4f5CcBAjMt","is_api_error_message":true}
{"is_error":true,"duration_api_ms":0,"num_turns":1,"stop_reason":"stop_sequence","session_id":"fbc382ca-1c2f-4a8c-a083-fbfb9449b40b","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"api_error","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subtype":"success","api_error_status":401,"result":"Invalid API key · Fix external API key","type":"result","duration_ms":1624,"uuid":"dcf9033d-d95d-4b03-8013-d53dfbf3132e"}
```

## What could not be settled

1. **Whether `--bare` completes a full turn with a *valid* `ANTHROPIC_API_KEY`.**
   No real key existed in this environment. Run 9 proves the key is read and
   changes the failure mode from "not logged in" to "invalid key," which is
   the closest this probe set could get.
2. **Whether `CLAUDE.md` auto-discovery is disabled under `--bare`, by direct
   observation.** Run 8 never reached a model turn (blocked by the
   authentication gap above), so no model response exists to confirm or
   deny it. The installed binary's own `--help` text states it is skipped;
   that is recorded above as a labeled self-description, not as a
   measurement.
3. **Why `PowerShell` survives in `--bare`'s four-tool list** alongside
   `Bash`/`Read`/`Edit` — whether that is Windows-specific compensation for
   the absence of a POSIX shell, or a general fourth bare-mode tool on every
   platform. This probe set only ran on Windows and cannot distinguish the
   two.
4. **Why `--plugin-dir` restores a plugin's skills but not its agents**
   under `--bare` (runs 4, 5, 5b, 5c, 5d) — this document records the
   observed behavior precisely; it does not diagnose the CLI internals that
   produce it, per this task's scope (no remedy, no `driver` change).

## Definition of Done — how each item is satisfied

- **`docs/bare-baseline.md` exists, stamped with the exact Claude Code
  version and the date.** Top of this file: `2.1.227 (Claude Code)`,
  measured with `claude --version`; date `2026-08-11`.
- **Both runs are recorded, each with its full command line, so either is
  reproducible verbatim.** Runs 1 and 2 above are the required pair (plus
  nine supplementary probes needed to settle agent resolution and
  CLAUDE.md discovery, which the base pair's plain prompt does not touch).
  Every run's exact command line is under "Full command lines."
- **All six categories are answered from observation, not documentation.**
  Categories 1–4 above (version is the document's own stamp; the
  `system/init` category is the verbatim appendix). Every claim is tied to
  a specific run and, where a documentation sentence is quoted, it is
  explicitly labeled as such and kept separate from the measured claim.
- **Each run's `system/init` event is included verbatim.** See the
  "`system/init` — verbatim" section; the three runs that never reached
  initialization (4, 5, 5b, 5d) have that fact and their exact stderr
  recorded instead, since no `system/init` exists for them to quote.
- **No file outside `docs/` is modified.** The only new file in this change
  is `docs/bare-baseline.md`. The temporary `CLAUDE.md` used by runs 7–8 was
  created and deleted before any commit; `git status` shows a clean tree
  with only this document added.
