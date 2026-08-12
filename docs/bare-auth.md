# `--bare` and the Max/Pro subscriber: the owner's decision

**Status:** DECIDED, 2026-08-12. Task `j3-bare-auth-answer` originally laid out
the options below with their real costs, recommended one, and stated plainly —
in three places — that the recommendation was not a decision: the choice
belonged to the owner and had **not** been made by this document's author.
**The owner has since made it** — see §5. `driver`'s fate as a mode is still
**not** decided by this document; that question is named in Option D below and
remains open, per this task's own scope boundary, and §5 confirms it is
unaffected by today's decision.

Builds on two documents already merged on this branch:

- **`docs/bare-baseline.md`** (`j1`, Claude Code 2.1.227) — the measured
  authentication baseline: under `--bare`, no OAuth and no keychain; with no
  `ANTHROPIC_API_KEY`, a run fails pre-turn (`"Not logged in · Please run
  /login"`); with a key present (even an invalid one), `apiKeySource` flips to
  `"ANTHROPIC_API_KEY"` and the failure changes shape (`"Invalid API key"`).
- **`docs/bare-hooks.md`** (`j2`, Claude Code 2.1.228) — measured that a
  `SessionStart` hook declared via `--settings` does **not** fire under `--bare`
  (3-for-3 without, 0-for-1 with). That finding is about hooks, not
  `apiKeyHelper`; §2 below runs the adjacent probe `j2` didn't, specifically for
  `apiKeyHelper`.

**Scope reminder, same as `j2`'s:** this is about `driver` (`pipeline drive`,
`src/commands/drive.ts`), the only mode affected once `-p` defaults to `--bare`
(`01-modes.md` E12). `session`/`manager` run inside the user's own interactive
Claude Code session and use the Agent tool; `standalone` uses the Agent SDK,
whose defaults are full. Neither is touched by `-p`'s default changing.

## 1. The problem, restated precisely

`driver` is, today, the only mode that runs a non-interactive loop on a
subscription — `claude -p` currently reads OAuth credentials and the system
keychain, so a Max/Pro subscriber with no `ANTHROPIC_API_KEY` can drive an
unattended pipeline (cron, a scheduled task, a script) and it authenticates the
same way an interactive session would. `--bare` removes exactly that path:
`"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings
(OAuth and keychain are never read)"` (installed CLI's own `--help`, quoted
verbatim in `j1`'s Category 1 and reconfirmed in §3 below on 2.1.228).

`standalone` cannot rescue these users — it requires the Agent SDK, which
requires an API key by policy, not by technical limit (`02-standalone-executor.md`,
"Why Claude Code stays": *"A large share of Claude Code users are on Max or Pro
and have no API key at all. Requiring one asks them to pay a second time for the
same tokens. That is not friction, it is a refusal at the door."*). So the
question `ux-v2` risk R9 delegated here, and `E12` deliberately left open, is:
**what happens to this population once the flip lands**, not whether `driver`
survives it in general (it does, for other populations — see Option C).

## 2. The options

### Option A — `manager`/`session` as the migration path

Both run inside the user's own interactive Claude Code session
(`01-modes.md`: `session` — *"The main session calls `pipeline next` itself and
spawns one step-executor subagent per action"*; `manager` — *"The main session
mints the run… then spawns a manager subagent that runs the loop"*). Neither
shells a fresh `claude -p` process, so neither is touched by `-p`'s default
flipping; subscription auth (OAuth/keychain) is exactly what an interactive
session already uses today, flip or no flip.

**Who it serves:** every Max/Pro subscriber with no API key, without
exception — this is the only option in this list that requires nothing new of
the user at all. No key, no helper, no organizational cloud-provider account.

**Cost, stated plainly:** the user loses the property they chose `driver` for.
`01-modes.md` names it directly — `driver` is recommended *"for CI and
scripts. Zero models in the orchestration. Resumable, scriptable,
machine-readable"* — none of that survives the move to `session`/`manager`,
both of which require a live interactive Claude Code session to be present.
A subscriber who scheduled a nightly `pipeline drive` run on their own machine
(cron, Task Scheduler, a script left running unattended) cannot do the
equivalent with `session`/`manager`, because both need a human-launched session
to exist. This is not a smaller version of what `driver` offered; it is a
different shape of usage entirely.

### Option B — `apiKeyHelper` via `--settings`

This task's brief flagged that `j2` found a `SessionStart` hook declared via
`--settings` does **not** fire under `--bare`, and that this is adjacent
evidence, not a refutation, for `apiKeyHelper` specifically — `j2` tested
hooks, not authentication. I ran the bounded probe `j2` didn't.

**Probe.** A minimal `settings.json`:

```json
{
  "apiKeyHelper": "echo sk-ant-fake-test-key-for-harness-probe-000"
}
```

(The same deliberately-invalid placeholder key `j1`'s run 9 used, chosen for
the same reason: this probe exists to observe *whether the helper's output is
read and used*, not to authenticate for real.)

**Command A** (no `--bare`, control):
```
claude -p "This is a harness measurement probe, not a real task. Reply with exactly the single word OK and take no other action." --settings "<path to the settings.json above>" --output-format stream-json --verbose
```
Result: `system/init.apiKeySource` = `"apiKeyHelper"`. Terminal result:
`"Invalid API key · Fix external API key"`, `api_error_status: 401` — the
expected failure for a syntactically key-shaped but invalid value, i.e. the
helper's stdout was read and passed to the API.

**Command B** (`--bare`, identical settings file):
```
claude -p "This is a harness measurement probe, not a real task. Reply with exactly the single word OK and take no other action." --bare --settings "<same settings.json>" --output-format stream-json --verbose
```
Result: **identical** — `system/init.apiKeySource` = `"apiKeyHelper"`.
Terminal result: the same `"Invalid API key · Fix external API key"`,
`api_error_status: 401`, `duration_ms` in the same low-single-second range as
Command A. Both run from `C:\tmp\ai-pipeline-worktrees\j3-bare-auth-answer--pipeline`
on Claude Code **2.1.228**, `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`
unset, no project `.claude/` or `CLAUDE.md` present (checked before running).

**Conclusion, directly measured:** unlike the `SessionStart` hook `j2` tested,
**`apiKeyHelper` via `--settings` does survive `--bare`.** The two runs are
symmetric — same `apiKeySource`, same failure mode, same shape — where `j2`'s
hook probe was asymmetric (3-for-3 without `--bare`, 0-for-1 with it). This is
consistent with, and now directly confirms rather than merely repeats, the
installed binary's own `--help` sentence quoted in `j1` and reconfirmed in §3.

**Who it serves, and the honest limit of this option:** `apiKeyHelper` changes
*how* a key is supplied (a helper command instead of a raw environment
variable — 1Password, a vault, a cloud secrets manager), it does not change
*whether* one is needed. A Max/Pro subscriber with genuinely no API key is not
rescued by this option any more than by setting `ANTHROPIC_API_KEY` directly —
they would still need to obtain and pay for a key. This option's real
population is subscribers **or** organizations who already hold an API key (or
can obtain one readily, e.g. an org's shared key) and who value keeping
`driver`'s non-interactive property enough to configure a helper and accept
paying for those tokens separately from their subscription.

**Cost, stated plainly:** the user must acquire an API key (the exact "refusal
at the door" `02-standalone-executor.md` names for `standalone`) and configure
a helper command via `--settings`, which for `driver` means either hand-editing
`DEFAULT_EXECUTOR_TEMPLATE`'s invocation or `driver` growing a way to pass
`--settings` through — a small but real surface, not yet built.

### Option C — Bedrock / Google Cloud Agent Platform / Microsoft Foundry

Established, not assumed, from the codebase and the installed binary's own
description, rather than from documentation alone:

- The installed CLI's own `--help` (both `j1`'s 2.1.227 capture and my own
  2.1.228 capture, §3 below) states: *"3P providers (Bedrock/Vertex/Foundry)
  use their own credentials"* under `--bare` — this is Claude Code's own
  behavior, not anything `driver` or this product configures.
- **This product has no Bedrock/Vertex/Foundry-specific surface anywhere.**
  Searched `public/package/pipeline` (`src/`, `docs/`, `tests/`) and the
  superproject's `docs/` and `cloud/docs/` for `bedrock`/`vertex`/`foundry`
  (case-insensitive): the only hits are `docs/bare-baseline.md` (this task's
  own sibling, quoting the CLI's `--help`) and two comments in
  `tests/model-conformance.test.ts` / `tests/_model-conformance.ts` about
  model-ID *shape* for conformance testing (`anthropic.claude-…-v1:0` for
  Bedrock), unrelated to authentication. No flag, no config key, no
  onboarding doc, no environment-variable wiring for any of the three exists
  in this product. Whatever a user gets from these providers, they get from
  Claude Code itself reading its own upstream environment variables — this
  product neither enables nor is aware of it.

**Who it serves:** organizations that already route their Claude Code usage
through Bedrock, Vertex, or Foundry — an enterprise procurement and billing
relationship, not an individual subscription. This matters for sizing the
overlap with the affected population: **Bedrock/Vertex/Foundry access and a
personal Max/Pro subscription are different billing tracks.** A user actually
authenticating through one of these three providers is, by construction, not
a "Max/Pro subscriber with no API key" — they were never on the affected path
to begin with. So this option is not a migration path *for* the population
this task is about; it is evidence that a *different*, enterprise population is
structurally unaffected by the flip.

**What could not be established — stated plainly rather than invented:** the
*size* of that enterprise population, among either all Claude Code users or
specifically among users of this product's `driver` mode. This codebase carries
no telemetry that records which auth backend a user authenticates through —
`stats.ts`/`RunRecord` record `runner` (the mode) and token/tool counts, never
provider identity — and no customer-analytics source was available to this
task. **This is not knowable from here.** Any specific percentage would be
invented; the honest bound is structural (enterprise vs. individual billing are
different tracks) rather than numeric.

### Option D — accept that post-flip `driver` requires a key

Stated as an explicit acceptance rather than left as a silent default. This is,
functionally, "do nothing beyond documenting the requirement" — a subscriber
without a key simply cannot use `driver` once the flip lands, full stop.

**Cost, stated plainly, per this task's own instruction not to decide it:**
this collapses the distinction between `driver` and `standalone` — both would
require an API key, at which point `driver` is strictly the weaker of the two:
it still lacks `standalone`'s first-class step metrics
(`02-standalone-executor.md` reason 3) and its horizontal fan-out
(`02-standalone-executor.md` reason 4, `01-modes.md` E13), while offering
nothing `standalone` doesn't already do once both require a key. **Whether
`driver` should then continue to exist as a fourth mode is a separate
question, and this document does not answer it** — consistent with this
task's explicit boundary ("Do not decide the fate of `driver` as a mode").

## 3. The opt-out-flag question

**`j1` did not settle this.** Its eleven probes measure authentication, tool
surface, agent resolution, and CLAUDE.md discovery under `--bare` as it exists
*today* (opt-in via the flag); no probe in `docs/bare-baseline.md` asks about a
flag to reverse a *future* default flip, and none of its "not settled" items
name one either. So per this task's instruction, the installed CLI's own
`--help` was checked directly rather than asserting from `02-standalone-executor.md`'s
prose claim ("no opt-out flag is documented, and no date is published").

**Command run:**
```
claude -p --help
```
(Claude Code **2.1.228**, the same installed version `j2` measured against,
one patch ahead of `j1`'s 2.1.227.) The full flag list was captured and
searched for anything that would restore pre-flip behavior once `-p` defaults
to `--bare` — a `--no-bare`, `--full`, `--legacy`, or similarly-named flag.

**Result: no such flag exists.** The only bare-related entry in the current
flag list is `--bare` itself — the flag that opts *into* bare mode, which is
today's opt-in default-off behavior, not a way to opt *out* once bare becomes
the default. `--bare`'s own help text does state it *"Sets
`CLAUDE_CODE_SIMPLE=1`"* — the one detail that hints at an internal
implementation (an environment variable gating the behavior) — but nothing in
`--help`, and no probe available to this task, confirms whether that variable
is documented as user-settable to reverse a post-flip default, or is purely an
internal signal. This is flagged as an open, unconfirmed detail rather than
treated as an answer: the installed binary has not undergone the flip
(`-p` is still full-featured by default today), so no probe run against it can
observe post-flip behavior directly — only today's flag surface, which
confirms the design document's claim rather than assuming it. **Conclusion:
confirmed by direct inspection, not assumed from documentation — no opt-out
flag exists on the installed version (2.1.228), and a plan resting on one
existing would be rebuilt on nothing.**

## 4. Recommendation

**Recommended: Option A (`manager`/`session` as the documented migration path)
as the primary answer, with Options B and C recorded as already-available,
zero-additional-product-work paths for the sub-populations they actually
serve.**

Reasoning, stated plainly:

- Option A is the only option that rescues the **entire** affected population
  (Max/Pro, no key) without asking anything new of the user — which matches
  `02-standalone-executor.md`'s own existing lean: *"for a Max/Pro subscriber
  the migration path is `manager`/`session`, not `standalone`"* (same sentence
  that named this exact population). This document's job was to check that
  lean against real costs and the alternatives, not invent a new answer — it
  holds up.
- Option B is real (§2 now proves `apiKeyHelper` survives `--bare`, which
  `02-standalone-executor.md` only asserted) but does not reach subscribers
  with **no** key at all — its population is "already has, or can readily
  get, a key," which is a strict subset of, not the same as, the population
  this task is about. It is worth documenting as an option for that subset,
  not as the primary answer.
- Option C serves a population that was never affected in the first place; it
  belongs in the documentation as "if you're on Bedrock/Vertex/Foundry, you
  don't need to do anything," not as a remedy for anyone.
- Option D is what happens by default if no documentation work is done at
  all — worth stating outright so it isn't silently what ships.

**The cost of this recommendation, restated:** every Max/Pro subscriber who
chose `driver` specifically for its non-interactive, scriptable,
unattended-machine property loses that property. Nothing in this document
makes that cost smaller than it is; Option A trades the property away in full,
in exchange for reaching every affected user rather than a subset.

**This was written as a recommendation, not a decision — the choice among
these four options belonged to the owner.** See §5: the owner has since
accepted this recommendation (Option A, with B and C recorded as secondary
paths for the sub-populations they serve) and additionally decided the cost
explicitly, rather than leaving it implicit.

## 5. The owner's decision (2026-08-12)

**The owner accepts this document's recommendation: Option A (`manager`/
`session` as the migration path) for the Max/Pro-subscriber-with-no-key
population.** Beyond accepting the recommendation, the owner additionally
decided the cost explicitly — closing the question `ux-v2` risk R9 delegated
to this task and that `E12` deliberately left open:

> When Claude Code flips `-p` to bare by default, `driver` stops supporting
> subscription authentication altogether. Its only remaining auth surfaces are
> an API key or an auth token. Max/Pro subscribers holding neither lose
> `driver` outright — knowingly, with no mitigation planned — and their
> documented path is `manager` or `session`, both of which run inside the
> user's own interactive Claude Code session and are therefore unaffected.

**What this decides, precisely:**

- **The migration path is `manager`/`session` (Option A) — not a hybrid, and
  not Option D by default.** The reasoning in §4 for Option A — it is the only
  option that reaches the entire affected population without asking anything
  new of the user — is now the accepted basis for this product's guidance to
  these users, not a recommendation still awaiting a choice.
- **The subscriber loss is deliberate and accepted, not an open risk.**
  `driver`'s "for CI and scripts… resumable, scriptable, machine-readable"
  property (§2 Option A, quoting `01-modes.md`) is knowingly given up for this
  population, with no mitigation planned beyond documenting the migration
  path. §1 already quoted `02-standalone-executor.md`'s framing of asking
  these same users for a key as *"not friction, it is a refusal at the
  door"* — the owner has read that framing and accepted the cost in those
  terms. It is recorded here plainly: neither softened into a smaller loss
  than what was decided, nor sharpened into more than was decided.
- **`driver` as a mode is not retired by this decision.** It continues to
  exist for the population that does hold an API key or an auth token —
  Option B's population, unaffected by this decision. Whether `driver` should
  continue to exist as a fourth mode *at all* remains the separate, still-open
  question named in §6's first bullet (formerly this section, before today's
  decision); this decision does not touch it.

### Verifying the auth-token lever

The owner's decision names two auth surfaces: "an API key or an auth token."
§2 Option B and §3 already establish `ANTHROPIC_API_KEY` and `apiKeyHelper`
via `--settings` as confirmed, `--bare`-surviving mechanisms. The installed
CLI's own `--bare` help text, however, names only those two — *"Anthropic auth
is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings"* (`claude -p
--help`, 2.1.228, quoted already in §1) — it does not name a distinct
auth-token variable by itself. Rather than write a variable name into this
document on the strength of the owner's phrasing alone, it was confirmed
directly, in two steps:

**1. Confirmed to exist, and distinct from `ANTHROPIC_API_KEY`.**
`ANTHROPIC_AUTH_TOKEN` is a real, first-party environment variable recognized
by the installed binary (2.1.228, `C:\Users\IvanD\.local\bin\claude.exe`) —
found by searching the binary's own strings directly (`strings claude.exe |
grep -o "ANTHROPIC_[A-Z_]*" | sort -u`), which lists `ANTHROPIC_AUTH_TOKEN`
alongside `ANTHROPIC_API_KEY` among the binary's other recognized `ANTHROPIC_*`
variables. Context around the hits shows it used as a distinct auth source: an
internal error message enumerates `"ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
CLAUDE_CODE_…"` as alternative auth sources, and it is sent as a different HTTP
header from an API key — one string hit spells this out directly: *"Both
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` set — the SDK sends both headers
and the API rejects the request."*

**2. Confirmed to survive `--bare` — by direct probe, the same method §2
Option B used, not by reading `--help` alone** (whose `--bare` sentence does
not name this variable):

```
ANTHROPIC_AUTH_TOKEN=fake-auth-token-for-harness-probe-000 claude -p "This is a
harness measurement probe, not a real task. Reply with exactly the single word
OK and take no other action." --output-format stream-json --verbose
```
Result (no `--bare`): terminal `"Failed to authenticate. API Error: 401 Invalid
bearer token"`, `api_error_status: 401`, `duration_ms: 1445`.

```
ANTHROPIC_AUTH_TOKEN=fake-auth-token-for-harness-probe-000 claude -p "This is a
harness measurement probe, not a real task. Reply with exactly the single word
OK and take no other action." --bare --output-format stream-json --verbose
```
Result (`--bare`): **identical** terminal message, `"Failed to authenticate.
API Error: 401 Invalid bearer token"`, `api_error_status: 401`, `duration_ms:
8721` (the gap from the control is ordinary run-to-run latency — both are
low-single-digit seconds — not a behavioral difference). Both runs from
`C:\tmp\ai-pipeline-worktrees\record-bare-auth-decision--pipeline`, Claude Code
2.1.228, no other `ANTHROPIC_*`/`CLAUDE_CODE_OAUTH_TOKEN*` variable set, no
project `.claude/` or `CLAUDE.md` present (checked before running).

The two runs are symmetric — same distinctive "Invalid bearer token" 401 in
both — the same shape of evidence §2 Option B used for `apiKeyHelper`, and it
differs categorically from the no-auth-at-all failure mode `bare-baseline.md`
(`j1`) measured under `--bare` (`"Not logged in · Please run /login"`). A
silently-ignored variable would fail the same way the no-auth case does; it
did not — both runs attempted bearer authentication and failed on the
placeholder token's validity, not its absence. (`system/init.apiKeySource`
reported `"none"` in both runs rather than naming the source; that field
appears not to classify a bearer token the way it classifies an API key or
`apiKeyHelper` — the terminal error message is the reliable signal here, and
it is unambiguous and identical across both runs.)

**What is and is not confirmed, stated precisely:**

- **Confirmed by direct measurement:** `ANTHROPIC_AUTH_TOKEN` exists in the
  installed 2.1.228 binary as a distinct, first-party auth lever from
  `ANTHROPIC_API_KEY`, and it survives `--bare` — read and used identically
  with and without the flag.
- **Not confirmed by the installed CLI's own `--help` text specifically:** the
  `--bare` flag's own help sentence names only `ANTHROPIC_API_KEY` and
  `apiKeyHelper`; it does not name `ANTHROPIC_AUTH_TOKEN`. This is a gap
  between that sentence and measured behavior, not a contradiction resolved in
  either direction — flagged here rather than silently resolved, per this
  task's own instruction to separate measured fact from inference.
- **Not established by this task:** whether Anthropic documents
  `ANTHROPIC_AUTH_TOKEN` as a stable, user-facing lever versus treating it as
  an internal implementation detail (its typical use, visible in the string
  evidence, reads as SDK/gateway credential-passing rather than end-user
  setup) — no public Anthropic documentation was consulted for this task, only
  the installed binary's own strings and measured behavior. The decision above
  is recorded in the owner's own terms ("an API key or an auth token") for
  exactly this reason: the concrete lever is confirmed to exist and to work
  under `--bare`, but its publication status upstream is not established here.

## 6. What this document does not decide

- **`driver`'s continued existence as a fourth mode**, which Option D's cost
  section surfaces but does not resolve, and which §5 explicitly declines to
  touch. Named explicitly here so it is not mistaken for settled: it is a
  separate question this task was scoped not to answer, and today's decision
  does not answer it either.
- **When the flip lands.** No date is published upstream (confirmed absent
  from the installed `--help`, same as `j1`/`j2`'s "no opt-out flag"/"no date"
  observations); `01-modes.md` E12 already commits to "we use the feature for
  as long as Anthropic permits" and this document does not revisit that.
- **Whether `driver` should grow a `--settings`/`apiKeyHelper` passthrough** if
  Option B is chosen — that is an implementation task downstream of an owner
  decision, not something to build here.
- **Whether `--bare`'s tool-surface and agent-resolution gaps** (`j1` runs
  4/5/5b/5d; the missing `Grep`/`Glob`/`WebFetch`/Agent tool) get remedied —
  out of scope for an authentication-only decision document; `j1`/`j2` already
  cover that ground and this document does not re-litigate it.

## Definition of Done — how each item is satisfied

- **States each option with its cost and who it serves.** §2, Options A–D,
  each with an explicit "who it serves" and "cost, stated plainly."
- **The size of the Bedrock/Vertex/Foundry slice is established, not
  assumed.** §2 Option C: established that this product has zero
  Bedrock/Vertex/Foundry surface (searched and cited); established that the
  population is structurally disjoint from Max/Pro subscribers by billing
  track; stated plainly that the *size* of that population is not knowable
  from this codebase, rather than inventing a number.
- **Whether an opt-out flag exists is answered from `j1`'s evidence.** §3:
  `j1` did not test this (stated explicitly, not glossed over); the installed
  CLI's own `--help` was checked directly (`claude -p --help`, Claude Code
  2.1.228) and confirms no such flag exists today.
- **One option is recommended, and the document originally stated the choice
  was the owner's and had not been made by its author** in its opening
  paragraph, in §4's closing paragraph, and in this list — **and now records
  that the owner has made it.** §5: Option A accepted, with the cost of the
  Max/Pro-subscriber loss decided explicitly (deliberate, accepted, no
  mitigation planned) rather than left implicit.
- **No source file is modified and no mode's fate is decided unilaterally.**
  The only file in this change is `docs/bare-auth.md`; `driver`'s continued
  existence as a fourth mode is explicitly left open in §6, first bullet, and
  §5 confirms today's decision does not touch it.
