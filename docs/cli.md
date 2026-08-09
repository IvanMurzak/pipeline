# `pipeline` CLI — telemetry, opt-out and the uploader; the `worktree` and `submodule` command groups

`pipeline --help` (and `pipeline <command> --help`) is the command reference and
is generated from the code that runs. This page covers three things a `--help`
screen cannot explain in a paragraph:

- **Telemetry** (below): what the CLI uploads on your behalf, how to stop it,
  where it keeps things on disk, and the lifecycle of the background process
  that does the sending.
- **[`pipeline worktree`](#pipeline-worktree--the-worktree-hook-lifecycle-without-a-run)**
  (near the bottom of this page): the worktree-hook lifecycle run without a
  pipeline — `create`/`finalize`/`destroy`/`list`, the built-in provisioner and
  teardown, ports, and the standalone hook-context.
- **[`pipeline submodule bump`](#pipeline-submodule-bump--the-guarded-pointer-bump-and-its-elevation-switch)**
  (last on this page): the guarded submodule-pointer bump, and the one flag on
  this CLI that decides whether it may **bypass branch protection on your
  repository**.

Two companion pages live in the plugin repository:

- **[Privacy tiers](https://github.com/IvanMurzak/pipeline-claude/blob/main/docs/privacy-tiers.md)** — the field-by-field allowlist of what is uploaded.
- **[Connecting to the cloud](https://github.com/IvanMurzak/pipeline-claude/blob/main/docs/cloud-connect.md)** — `pipeline cloud connect`, history upload, retention and deletion.

---

## `pipeline stats telemetry [--drain] [--json]`

One command, one screen, seven answers: is telemetry on, which account, is it
streaming right now, how much is queued, how much was dropped, what went wrong
last, and where to look.

```console
$ pipeline stats telemetry
Telemetry  on
Account    acme @ api.ai-pipeline.dev
Streaming  idle (no active run)
Queued     2 runs (oldest 14 min ago)
Dropped    0
Last error could not reach the server — 14 min ago
Dashboard  https://api.ai-pipeline.dev/acme/runs

Retry now: pipeline stats telemetry --drain
```

Reading the lines:

| Line | Meaning |
| --- | --- |
| **Telemetry** | `on`, or `off (PIPELINE_SYNC_LOCAL_STATS=0)`. |
| **Account** | The org and host from `.pipeline/cloud.json`, or a line telling you to run `pipeline cloud connect`. |
| **Streaming** | `active — uploading (daemon pid N)` when the uploader is alive for this project; otherwise `idle`. |
| **Queued** | Distinct **runs** waiting to be sent — not records — plus the age of the oldest. |
| **Dropped** | Everything that left the send path and is not coming back on its own: queue-bound evictions, records with no usable run id, malformed lines, lock contention, and quarantined records. |
| **Last error** | The last real network attempt's outcome, described from its status code (`could not reach the server`, `HTTP 429 — rate limited`, …). Never a response body — the uploader never decodes one. |
| **Dashboard** | Where to go and look, or `—` when not connected. |

Two extra lines appear only when they mean something: a count of records queued
under a **different org** (held, never sent — reconnect to that org to release
them), and the `Retry now:` hint when the queue is non-empty.

An **expected** exclusion is never reported as a drop. `session.opened` carries
no run id by design, so it is counted separately as `excluded.not_applicable`
and left out of the drop total — a healthy run should not read as lossy.

### `--drain`

Attempts **one bounded flush right now** and then prints the report, so what you
see is the state after the attempt. It is safe to run inline because it is an
explicit, user-initiated command — unlike the run path, which never carries
network latency. A failed drain simply shows an unchanged queue and a fresh
`Last error` line.

### `--json`

Emits the same facts machine-readably. The shape:

```jsonc
{
  "enabled": true,
  "connected": true,
  "server": "https://api.ai-pipeline.dev",
  "org": "acme",
  "project": "acme-api",
  "dashboard_url": "https://api.ai-pipeline.dev/acme/runs",
  "streaming": { "active": false, "pid": null },
  "queue": {
    "sendable": 34,          // records ready to send, this org
    "sendable_runs": 2,      // distinct run ids among them
    "oldest_at": "2026-08-07T11:46:00.000Z",
    "blocked": 0             // queued under a DIFFERENT org — never sent
  },
  "dropped": {
    "total": 0,
    "bound": 0, "no_run_id": 0, "malformed": 0, "lock_contention": 0,
    "quarantined": 0, "quarantine_depth": 0,
    "last_drop_at": null, "last_drop_reason": null
  },
  "excluded": { "not_applicable": 3 },
  "last_error": {
    "schema": 1, "at": 1786000000000, "outcome": "retry",
    "status": 0, "requests": 1, "records_sent": 0, "records_quarantined": 0
  }
}
```

`oldest_at`, `last_drop_at` and `last_error` are `null` rather than fabricated
when there is nothing to report.

Exit code is `0`; `2` on an unknown flag.

---

## Turning it off

### `PIPELINE_SYNC_LOCAL_STATS=0` — the master switch

Set it to any falsy value (`0`, `false`, `no`, `off`) and the upload subsystem
is **absent**, not merely quiet:

- nothing is filtered, nothing is queued, no queue file is created;
- the uploader is not spawned, and a running one exits at its next cycle
  (the switch is re-read every cycle, so it takes effect mid-life);
- `pipeline drive` prints no dashboard link;
- `pipeline cloud connect` skips the history scan and says telemetry is off.

Your runs are unaffected in every other way. The local journal
(`.pipeline/.runtime/events.jsonl`) and the local measurements
(`.pipeline/.stats/`) are still written, so `pipeline logs`, `pipeline logs
--chat` and `pipeline stats` all keep working offline.

Set it per project in `.claude/settings.json`:

```jsonc
{ "env": { "PIPELINE_SYNC_LOCAL_STATS": "0" } }
```

…or export it in the shell before launching anything.

### The other switches, and what each one actually gates

| Variable | Default | Gates |
| --- | --- | --- |
| `PIPELINE_SYNC_LOCAL_STATS` | on | **Uploading.** Nothing leaves the machine when off. |
| `PIPELINE_PRIVACY_TIER` | `metadata` | How much of each record survives filtering. `events`/`full` ship the stream **verbatim**. Fails closed: an unrecognised value degrades to `metadata` and warns. |
| `PIPELINE_PRIVACY_SALT` | unset | Hardens the deterministic path fingerprints. Never uploaded. |
| `PIPELINE_JOURNAL_ENABLED` | on | The journal and the hook relays — i.e. whether events are recorded **at all**, locally included. |
| `PIPELINE_STATS_ENABLED` | on | The per-run measurement files under `.pipeline/.stats/`. |

`pipeline cloud optout` is a **different** control: it governs your
organisation's contribution to cross-org aggregate statistics, not your own
runs. See [Connecting to the cloud][connect].

[connect]: https://github.com/IvanMurzak/pipeline-claude/blob/main/docs/cloud-connect.md

---

## Where things live on disk

Everything the telemetry subsystem writes is under one directory, per project:

```
<project>/.pipeline/.runtime/telemetry/
├── outbox.jsonl       the durable queue — ALREADY FILTERED
├── state.json         the journal cursor + the drop/quarantine counters
├── quarantine.jsonl   records the server permanently rejected
├── upload.json        the retry schedule (backoff), persistent across flushes
├── last-flush.json    the last network attempt's outcome — status + counters only
├── drain.lock         the enqueue/drain mutex
└── daemon.lock        the single-instance guard: {pid, started_at}
```

`.pipeline/.runtime/` carries its own `.gitignore` containing `*`, written on
first use, so a `git add -A` after a run cannot sweep any of this into a commit.

**The queue file is the honest answer to "what will be sent".** The privacy
filter runs inside the *enqueue*, not at upload time, precisely because
`outbox.jsonl` sits inside your repository, survives reboots and is read by a
detached process. If a value is in your journal but not in `outbox.jsonl`, it is
not going anywhere.

```bash
cat .pipeline/.runtime/telemetry/outbox.jsonl
```

Each line is `{ org, run_id, seq, kind, payload }`. The `org` tag is the control
that stops telemetry queued under one organisation being delivered to another
after you reconnect elsewhere.

Related, outside this directory:

| Path | What |
| --- | --- |
| `<project>/.pipeline/cloud.json` | the non-secret binding: `server`, `org`, `project`, `connected_at`. Safe to commit. |
| `%APPDATA%\claude-pipeline\` (Windows) · `$XDG_CONFIG_HOME/claude-pipeline/` | `credentials.json` (the access/refresh tokens) and `fingerprint-salt.json` (the per-install salt). Both `0600`, per **user** not per project. Never printed, never in the repository, never uploaded. |
| `<project>/.pipeline/.runtime/events.jsonl` | the local journal the uploader tails. Never truncated by the uploader; rotates at 50 MB. |

---

## The uploader — lifecycle

Uploading is done by a **detached, per-project process**. Nothing on a run's
critical path ever waits on the network for telemetry — no hook, no step, and
nothing inside `pipeline drive`.

Exactly two commands flush inline, both because you asked them to and both
bounded: `pipeline stats telemetry --drain`, and `pipeline cloud connect`'s
one attempt at delivering the history it just queued. Neither is on a run's
path.

**How it starts.** At a run's start — `pipeline drive`, or the plugin's
`analytics-relay` hook when a pipeline-manager is spawned — the CLI does three
cheap local things: check the switch, check that `.pipeline/cloud.json` exists,
and try to take an exclusive (`wx`) lock at
`.pipeline/.runtime/telemetry/daemon.lock`. Only if the lock is *acquired* does
it spawn `pipeline telemetry-daemon --project-root <path>` detached. With no
cloud binding it spawns nothing at all, which is why an unconnected project pays
one `existsSync` and no more.

A lock whose pid is dead, or older than **35 minutes**, is reclaimed.

**What it does while alive.** It polls, every **5 seconds** by default: take a
batch from the queue, POST it to `/api/v1/ingest`, apply the outcome, sleep.
Records are grouped by run — one request never mixes two runs — and capped at
**100 records** each. A flush makes at most **20 requests** by default, each
with a 5-second timeout, and the whole flush is bounded at **20 seconds**.

**How it ends.** Two independent caps, plus one immediate exit:

| Condition | Effect |
| --- | --- |
| Nothing to do for **2 minutes** of wall clock | exit (idle) |
| **30 minutes** since it started, busy or not | exit (wall clock) |
| `PIPELINE_SYNC_LOCAL_STATS` turned off — re-read every cycle | exit immediately |

On a clean exit it releases its own lock, so the very next run can spawn a fresh
one without waiting out the stale-lock window. A run that outlives the 30-minute
cap is not stranded: the next step's hook spawns a replacement.

**What happens to a record.**

| Response | Outcome |
| --- | --- |
| 2xx | acknowledged and removed from the queue |
| 5xx, or the request never arrived | **kept**, retried with exponential backoff (1 s base, 30 s cap) persisted in `upload.json` |
| 401, 403, 408, 425, 429 | **kept** — these describe the credential, the clock or the rate limiter, never a bad record, so the same bytes can succeed later |
| any other 4xx | **quarantined** — appended to `quarantine.jsonl` *before* being removed from the queue, so a crash mid-move duplicates (harmless — the wire is idempotent) rather than loses |
| the queue is full (10 000 records) | the **oldest** records are dropped and counted; a lost tail is recoverable, a run that cannot start is not |

Every one of those is counted durably and surfaced by `pipeline stats
telemetry`. Nothing is ever lost silently.

**Replay is safe.** Each record carries `(run_id, seq)`, and the server treats a
repeat as a no-op — so flushing a backlog after a week offline produces exactly
one run, not a duplicate.

You can run the daemon by hand for diagnosis, though nothing needs you to:

```bash
pipeline telemetry-daemon --project-root . --once
```

`--once` runs a single poll cycle and exits.

---

## What the CLI never does with telemetry

- It never blocks, delays or fails a run because of cloud state.
- It never opens a browser from the upload path.
- It never logs a response body, a payload, or the bearer token — the transport
  returns a status code and nothing else, so there is no string to leak.
- It never prompts mid-run for consent.

---

## `pipeline worktree` — the worktree-hook lifecycle without a run

```console
$ pipeline worktree create   [--name <slot>] [--base <branch>] [--submodules a,b]
                             [--hook-dir <path>] [--ports <n>] [--json]
$ pipeline worktree finalize --name <slot> [--base <branch>] [--submodules a,b]
                             [--hook-dir <path>] [--json]
$ pipeline worktree destroy  --name <slot> [--outcome completed|halted]
                             [--hook-dir <path>] [--json]
$ pipeline worktree list     [--json]
```

`pipeline worktree --help` prints the full reference (usage, every flag, every
environment variable, the exit codes) verbatim from the code — every command,
flag and JSON key documented below was checked against a **live run** of the
CLI (a scratch git repository, with and without hooks present), not read off
the source alone.

For an orchestrator that needs a **slot** — a worktree, its branch, its env
file — but has no pipeline run to hang it on (dispatching several parallel
workers, for instance). It runs the consumer's `worktree-create` /
`worktree-finalize` / `worktree-destroy` hooks under `<project>/.pipeline/.hooks`
(override: `--hook-dir`) through the **exact same code path**
(`src/lib/worktree-hooks.ts`) a pipeline run uses for `isolation: run` — never a
second copy of the frozen `PIPELINE_WT_*` assembly. Run it from the project
root: `PIPELINE_WT_PROJECT_ROOT` is `process.cwd()`, exactly as on the run path.

The frozen, authoritative env-var/JSON contract for hook **authors** lives in
the plugin repository, not here — see
["The frozen contract document"](#the-frozen-contract-document) below.

### The four subcommands

#### `create`

Provisions (or re-provisions) a slot.

| Flag | Default | Notes |
| --- | --- | --- |
| `--name <slot>` | a fresh UUIDv7 (the identifier `pipeline id` mints) | must pass SG6 validation — see "Exit codes", below |
| `--base <branch>` | `main` | the branch the slot is cut from |
| `--submodules a,b` | none | comma-separated, repository-relative submodule paths |
| `--hook-dir <path>` | `.pipeline/.hooks` | where `worktree-create.*` is resolved from |
| `--ports <n>` | `4` | contiguous free-port block size; `0` for none — see [Ports](#ports) |
| `--json` | off | machine-readable output |

Creation is **idempotent per name**, by frozen contract: a second `create` for
the same `--name` reuses the existing slot instead of provisioning a second
one, and reports `status: "reused"`. An orchestrator should read `reused: true`
as a duplicate dispatch, not an error.

`--json` output (field-for-field, from a live `create` with no hooks present):

```jsonc
{
  "command": "worktree create",
  "name": "a4",
  "base_branch": "main",
  "submodules": [],
  "hook_dir": ".pipeline/.hooks",
  "ports_requested": 4,
  "provisioner": "builtin",           // "hook" | "builtin" — who made the slot
  "submodule_slots": [],              // populated only on the builtin path — see below
  "ok": true,
  "status": "created",                // "created" | "reused" | "failed"
  "reused": false,
  "reused_evidence": null,            // "registry" | "git-worktree" | null
  "worktree_path": "C:/tmp/pipeline-worktrees/myproj-18946a9b/a4",
  "branch": "worktree-a4",
  "env_file": "C:/tmp/pipeline-worktrees/myproj-18946a9b/a4.env",
  "ports": { "PORT_1": 31561, "PORT_2": 31562, "PORT_3": 31563, "PORT_4": 31564 },
  "port_base": 31561,
  "ports_source": "builtin",          // "builtin" | "hook" | "none"
  "detail": null
}
```

On failure (`ok: false`, `status: "failed"`), `worktree_path`/`branch`/`env_file`
are `null`, `ports` is `{}`, and `detail` states the reason — nothing is torn
down on a failed create (a partial slot is evidence; a retry reuses what
survived).

`submodule_slots` is populated **only** on the built-in-provisioner path — one
entry per `--submodules` path it actually cut a worktree for:
`{ path, name, dir, base }` (`base` is the submodule's own resolved integration
branch). It is always `[]` on the hook path: the frozen contract does not
report submodule slots, and this command does not invent them on the hook's
behalf.

#### `finalize`

Runs the slot's mandatory terminal hook. **Strict must-succeed**: only an
explicit `{"ok":true}` on a clean exit passes; anything else — a non-zero exit,
a timeout, malformed stdout, or a missing hook where one is required — fails.
`--base`/`--submodules` default to what `create` recorded for the slot (pass
the flags to override).

```jsonc
{
  "command": "worktree finalize",
  "ok": true,
  "name": "a4",
  "worktree_path": "C:/tmp/pipeline-worktrees/myproj-18946a9b/a4",
  "outcome": "completed",             // finalize has no other outcome
  "finalized_by": "builtin",          // "hook" | "builtin"
  "provisioner": "builtin",
  "detail": "no .pipeline/.hooks/worktree-finalize.* hook found — the built-in finalize is a NO-OP: nothing was committed, pushed, merged or tagged, and the slot is unchanged. …"
}
```

See ["The built-in finalize is a deliberate no-op"](#the-built-in-finalize-is-a-deliberate-no-op)
for what `finalized_by: "builtin"` means and — importantly — does not mean.

#### `destroy`

Tears a slot down.

| Flag | Default | Notes |
| --- | --- | --- |
| `--name <slot>` | — required | |
| `--outcome completed\|halted` | `completed` | `completed` **reaps**; `halted` **preserves** |
| `--hook-dir <path>` | the slot's recorded hook dir | |
| `--json` | off | |

`--outcome` drives `PIPELINE_WT_DELETE_BRANCHES` exactly as it does on the run
path: `1` on `completed` (the work is done; the branch dies with the
worktree), `0` on `halted` (preserved for post-mortem/resume).

```jsonc
{
  "command": "worktree destroy",
  "ok": true,
  "name": "a4",
  "worktree_path": "C:/tmp/pipeline-worktrees/myproj-18946a9b/a4",
  "outcome": "completed",
  "delete_branches": true,
  "reaped": true,                     // the slot record was dropped
  "preserved": false,                 // == !reaped
  "teardown_by": "builtin",           // "hook" | "builtin" | "none"
  "provisioner": "builtin",           // who PROVISIONED it, from the slot record
  "removed_worktrees": ["C:/tmp/pipeline-worktrees/myproj-18946a9b/a4"],
  "removed_branches": ["C:/path/to/myproj: worktree-a4"],
  "removed_env_file": "C:/tmp/pipeline-worktrees/myproj-18946a9b/a4.env",
  "detail": "no .pipeline/.hooks/worktree-destroy.* hook found — the built-in teardown reaped this slot (the built-in provisioner made it)"
}
```

`--outcome halted` returns `ok: true`, `reaped: false`, `preserved: true`, and
leaves everything untouched — worktree, branch, env file, and the port
reservation all survive so the slot can be resumed or inspected. Re-run with
`--outcome completed` later to reap it.

A `destroy` of a slot that cannot be safely torn down here — no slot record
**and** no destroy hook, or a hook-provisioned slot with no destroy hook —
returns `ok: false`, `teardown_by: "none"`, exit `1`, and `detail` names which
case it is. See ["The symmetry rule"](#the-symmetry-rule).

#### `list`

```jsonc
{
  "command": "worktree list",
  "project_root": "C:\\path\\to\\project",
  "slots": [
    {
      "name": "a4",
      "worktree_path": "...", "branch": "...", "env_file": "...",
      "base_branch": "main", "submodules": [], "submodule_slots": [],
      "hook_dir": ".pipeline/.hooks",
      "ports_requested": 4, "port_base": 31561,
      "provisioner": "builtin",
      "created_at": "2026-08-09T02:06:03.695Z",
      "updated_at": "2026-08-09T02:06:11.560Z",
      "outcome": null, "finalized": false,
      "finalized_by": null,           // "hook" | "builtin" | null — see below
      "exists": true                  // is the recorded worktree_path still on disk
    }
  ]
}
```

`list` reports only the slots **this command's own registry** knows about —
one JSON file per slot under `<project>/.pipeline/.runtime/worktrees/<name>.json`,
written by `create`. It is not a filesystem scan of where slots live. Finding
worktrees, branches and slots this command's registry can no longer name is
`pipeline gc`'s job — including the built-in slot root outside the repository;
see ["Who reaps a built-in slot"](#who-reaps-a-built-in-slot).

### Exit codes (all four subcommands)

| Code | Meaning |
| --- | --- |
| `0` | the action succeeded |
| `1` | the hook (or its built-in equivalent) failed — soft (`{"ok":false,"detail":…}` + hook exit 0) or hard (a required hook missing, non-zero exit, timeout, spawn error, non-JSON stdout). `detail` says which; the exit code deliberately does not distinguish soft from hard — both mean "the slot is not in the state you asked for" |
| `2` | usage error — unknown flag/verb, a missing required value, an invalid `--name` (SG6), an invalid `--outcome`, an invalid `--ports` |

**SG6** — `--name` is validated (`[A-Za-z0-9][A-Za-z0-9._-]*`, max 64
characters, no `..`, no trailing `.`, no Windows reserved device name — `CON`,
`PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`) **before** it touches a
filesystem path, a branch name, the slot registry, or a hook's environment. It
is an allow-list, never a blocklist: the name reaches an unaudited consumer
hook as both a directory name and a git branch name, so anything not
explicitly allowed is refused with exit `2` up front. Verified: `--name a/b`
and `--name -x` are both refused before anything is created.

---

### D9 — the built-in provisioner and teardown are reachable from `pipeline worktree` only

When `<hook-dir>/worktree-create.*` does not exist, `pipeline worktree create`
provisions the slot itself:

- a `git worktree add -b worktree-<name>` off `--base`, **outside the
  repository** (so a worker's build output, `node_modules`, test droppings,
  etc. never land inside the project folder);
- one additional worktree per `--submodules` entry, cut from **that
  submodule's own integration branch** (`next` when the submodule has it, else
  `--base` — never the commit the parent superproject happens to pin, which
  trails the submodule's own tip);
- a contiguous block of free ports (see [Ports](#ports));
- an env file next to the slot (see the constraints below).

Symmetrically, when `<hook-dir>/worktree-destroy.*` does not exist,
`destroy --outcome completed` reaps everything the built-in provisioner made —
every worktree it created, the `worktree-<name>` branch in each of those
repositories, the env file, the port reservation, and the slot record — and
`--outcome halted` preserves all of it.

**This fallback exists only inside `pipeline worktree create` / `destroy`.** A
**pipeline run** (`pipeline next` / `pipeline drive`, on a pipeline with
`isolation: run`) that hits a repository with no `worktree-create.*` still
**halts**, exactly as it always has — `src/lib/worktree-hooks.ts` (what the run
path calls) neither imports nor knows about `src/lib/worktree-provision.ts`
(where the built-in provisioner and teardown live), and a test in this
repository asserts that absence directly against the source. A run whose
repository has no `worktree-destroy.*` still reports a **failed** teardown, not
a silent built-in reap.

**Do not read "the CLI now ships a built-in worktree provisioner" as "the run
path now self-provisions." It does not — that boundary is deliberate (D9), and
nothing about a pipeline run's own worktree-hook requirements has changed.**

### The symmetry rule

Every slot record carries `provisioner: "hook" | "builtin"` — who made it. This
is the rule that decides every teardown edge case:

1. **A `worktree-destroy.*` hook, where one exists, always wins** — including
   over a slot the built-in provisioner made. `destroy`'s JSON then reports
   `teardown_by: "hook"` together with `provisioner: "builtin"`, and `detail`
   states explicitly that a destroy hook appeared after the fact and ran
   instead of the built-in teardown.
2. **The built-in teardown reaps a `builtin`-provisioned slot only.** A slot a
   hook provisioned carries bookkeeping (its own registrations, branches, env
   files) this CLI never wrote; reaping it from here would silently orphan
   that bookkeeping. A hook-provisioned slot with **no** destroy hook is
   **refused** (`ok: false`, `teardown_by: "none"`, exit `1`, `detail` explains
   why) rather than guessed at.
3. **Unknown provenance reads as `hook`, conservatively** — a slot record
   written before this field existed, or no record at all, is treated as
   though a hook made it, so the built-in teardown never reaches for a slot it
   cannot be sure it owns.

Verified directly, both directions:

- A slot created via a hook, then `destroy` run with **no** destroy hook
  present: refused, exit `1`, `detail` names the reason
  (`"slot 'x' was provisioned by a .../worktree-create.* hook, and there is
  no .../worktree-destroy.* hook to reap it. The built-in teardown REFUSES…"`).
- A slot created by the **built-in provisioner**, then a destroy hook added
  afterward and `destroy` run: the hook tears it down —
  `"teardown_by": "hook"`, `"provisioner": "builtin"`, and `detail` states both
  facts (`"this slot was provisioned by the built-in provisioner, but
  .../worktree-destroy.* exists and a hook always wins — the HOOK tore it
  down"`).

### The built-in finalize is a deliberate no-op

With no `worktree-finalize.*` hook, `finalize` on a **builtin-provisioned**
slot returns `ok: true`, `finalized_by: "builtin"`, and a `detail` that states
plainly: nothing was committed, pushed, merged or tagged, and the slot is
unchanged.

This is a considered choice, not a stub. On a pipeline run, `finalize` is where
a consumer commits and pushes — and there is no defensible default for *which*
remote, *which* branch, *what* commit message, whether to sign, whether to open
a pull request. A wrong worktree is a directory `destroy` reaps; a wrong push
is somebody else's git history — an irreversible mistake the create path's
analogous defaults never risk. Refusing instead (`ok: false`) was the other
candidate and was rejected: it would re-break `create → finalize → destroy` in
a hook-less repository, exactly the asymmetry the built-in finalize shipped to
close.

**It applies only to slots the built-in provisioner made.** A repository that
has a `worktree-create.*` hook but no `worktree-finalize.*` still **fails
loudly** — `finalize` returns `ok: false` with
`no <hook-dir>/worktree-finalize.* hook found`, exactly as it did before the
built-in finalize existed. `finalized_by` in the JSON is exactly how a caller
tells the two cases apart; never read a `finalize`'s `ok: true` as "my branch
is pushed" without checking it.

**`finalized_by` is PERSISTED into the slot record on a successful finalize**,
not just returned in that one `finalize` call's own JSON — so `pipeline
worktree list` (`--json` and human output alike) can tell a builtin no-op
finalize apart from a hook's, for a slot resumed later or inspected by a
different process, without re-running `finalize` (which is strict
must-succeed and not idempotent-safe to re-invoke just to check). A slot not
yet finalized reports `finalized_by: null` — never guessed as one of the two —
and so does a slot record written before this field existed, even though its
`finalized: true` still reads back fine: provenance genuinely unknown is
reported as unknown, not as a coin flip.

### Ports

Every slot gets its own contiguous block of free TCP ports. A worktree
isolates *files*, not ports — two workers each starting a dev server on the
same port is a real, silent failure mode (one binds, the other gets
`EADDRINUSE`, or worse, talks to the first one's server). Ports are written
into the slot's **env file** — never returned through a hook's JSON stdout,
which the frozen contract calls informational only:

```
PORT_BASE=31561
PORT_COUNT=4
PORT_1=31561
PORT_2=31562
PORT_3=31563
PORT_4=31564
```

- `--ports <n>` sizes the block (default `4`); `--ports 0` provisions a slot
  with **no** ports at all — no `PORT_*` keys are written, never a zero-filled
  placeholder.
- The **base is deterministic per slot name** (a hash of the name alone — never
  of the project or the clock): re-provisioning the same `--name` returns the
  same ports while they remain free, so a bookmarked URL or a hand-copied
  `.env` keeps meaning something across re-creates.
- Occupied ports are skipped — bind-probed on the wildcard address and both
  loopback addresses (Windows can bind `0.0.0.0:P` successfully even while
  another process holds `127.0.0.1:P`, so a wildcard-only probe would hand out
  a port that is already serving) — and a candidate block is reserved via an
  exclusive-create file the instant it is chosen, so two concurrent `create`s
  can never be handed overlapping blocks.
- The range defaults to **20000-32767**; override with
  `PIPELINE_WT_PORT_RANGE=<min>-<max>`.
- Exhaustion is a **stated failure** (`ok: false`, `detail` names the range
  that was tried) — never a slot that silently ends up with no ports.

#### D14 — the per-field port precedence rule (read this if you author a `worktree-create.*` hook)

**If your `worktree-create.*` hook does not implement ports** — it returns no
`ports`/`port_base` fields at all, or returns them empty/zero
(`{"port_base": 0, "ports": {}}`, which is exactly what this package's own
reference hook has always returned) — **the CLI still gives your slot a port
block.** It is appended into the env file **your hook itself named** in its
`env_file` response field. Your hook answering "no ports" does **not** opt the
slot out of the CLI's allocation.

**If your hook returns a non-empty `ports` object, or a non-zero `port_base`,
that answer wins completely** — the CLI allocates nothing on top of it, and
whatever block it would otherwise have written is skipped entirely. This is a
per-field rule about the *pair*: `ports` and `port_base` describe one
allocation together, and the CLI never fills in half of an allocation your
hook already answered.

Two things worth knowing if you are debugging a slot's ports:

- If your hook reports no `env_file` (`"env_file": null`), there is nowhere
  for the CLI to publish a block — the `create` still succeeds, `ports_source`
  reads `"none"` in `--json`, and `detail` explains why (verified:
  `"the worktree-create hook returned no env_file, so there is nowhere to
  publish ports — 4 were not allocated"`).
- `--json`'s `ports`/`port_base` fields are always **read back from the env
  file itself**, not from either side's in-memory answer — the file is the
  channel a script step actually `source`s, so that is what gets reported as
  ground truth.

`ports_source` in `--json` tells you which side ultimately won: `"builtin"`
(the CLI's own allocator — including the D14 fill-in case above), `"hook"`
(your hook's own values stood as reported), or `"none"` (no ports at all —
`--ports 0`, or a block that could not be published).

### The standalone hook context

The `PIPELINE_WT_*` contract is **frozen** — every consumer hook, whether
invoked by a pipeline run or by this standalone command, sees the same
variable names. Two of them have no natural value outside a run, and getting
this exactly right matters enough to spell out precisely — an earlier draft of
this documentation stated it backwards:

- **`PIPELINE_WT_PIPELINE_ROOT` and `PIPELINE_WT_PIPELINE_NAME` are the empty
  string.** There is no pipeline folder in play outside a run, so both are
  *present-and-empty* rather than absent (`PIPELINE_WT_PIPELINE_NAME` is
  derived as `basename(PIPELINE_WT_PIPELINE_ROOT)`, and `basename('')` is
  `''`).
- **`PIPELINE_WT_NAME` is NOT emptied.** ⚠ It is the *slot* identity — `--name`
  (or the auto-generated UUIDv7), unchanged. The frozen contract makes the
  create hook "idempotent per `PIPELINE_WT_NAME`" and derives the worktree
  directory, the `worktree-<name>` branch, and the hook's own registry key
  from it; emptying it would collapse every standalone slot onto one nameless
  slot and make `--name` inert. **Do not confuse `PIPELINE_WT_NAME` (the slot
  name, always populated) with `PIPELINE_WT_PIPELINE_NAME` (the pipeline name,
  empty outside a run) — they are two different variables.**
- **`PIPELINE_WT_RUN_ID` carries the slot name too.** There is no run id
  outside a run; on the run path the two variables have always carried equal
  values, so a hook that reads either one sees the value it already expects.
- **No run-scoped journal event is written** (`worktree.created` /
  `.finalized` / `.destroyed`). A standalone invocation has no run to attach
  history to, and fabricating a run-scoped event for a run that does not exist
  would be worse than writing nothing.

Verified with a hook that dumps its own environment during `create`:

```
PIPELINE_WT_ACTION=create
PIPELINE_WT_BASE_BRANCH=main
PIPELINE_WT_NAME=hookslot1
PIPELINE_WT_PIPELINE_NAME=
PIPELINE_WT_PIPELINE_ROOT=
PIPELINE_WT_PROJECT_ROOT=C:\path\to\proj
PIPELINE_WT_RUN_ID=hookslot1
PIPELINE_WT_SUBMODULES=
```

### Env-file value constraints

The env file `create` writes (and fills ports into, per D14) is dotenv-shaped —
but its grammar is **narrower** than what this package's own `parseEnvFile`
tolerates, because the file has a **second reader**: a shell step that does
`set -a && source <file>`. That reader does no quote-stripping and no
trimming — a value with a space, a quote, or a backslash parses fine under this
CLI's own tolerant parser and then **breaks the shell consumer silently**, in a
way this CLI itself never sees or reports.

So every value the built-in provisioner writes must be:

- **unquoted** — never wrapped in `'…'` or `"…"`;
- **space-free**;
- **free of shell metacharacters** — no backslash, no `` ` ``, `$`, `;`, `|`,
  `&`, `<`, `>`, `(`, `)`, `{`, `}`, `[`, `]`, `*`, `?`, `!`, `#`, `^`, `%`, or
  control characters (an allow-list of letters, digits, and `. _ - / : + @ , ~
  =`, never a blocklist);
- paths are written with **forward slashes on every platform, including
  Windows** — a backslash is a shell escape character to `source`.

A value that cannot satisfy this **fails the create with a stated reason**
rather than being quoted, truncated, or silently dropped — a mis-written env
file that "mostly works" until a shell script reads it is a worse failure mode
than a create that refuses up front.

**This is also why a project whose path contains a space (or another
disallowed character) is refused outright by the built-in provisioner** — e.g.
`C:\Program Files (x86)\…` — because `PROJECT_ROOT` itself is one of the values
that has to go into that file unquoted. Verified against a real repository
checked out under a path with a space:

```jsonc
{
  "ok": false,
  "status": "failed",
  "detail": "env value for PROJECT_ROOT contains a space, which cannot be written unquoted (the env file is also read with `set -a && source`). The project is at C:/.../proj with space — the built-in provisioner cannot describe it in an unquoted env file; author a worktree-create.* hook (which wins over the provisioner) if the project must live at that path."
}
```

A repository at such a path is not stuck — authoring a `worktree-create.*` hook
(which always wins over the built-in provisioner, per D9) can lay the slot out
however that hook likes; only the built-in provisioner is constrained by this
grammar.

---

### Who reaps a built-in slot

Two commands, and they own different halves — deliberately.

**`pipeline worktree destroy --name <slot>` reaps a slot you can still name.**
It is the ordinary path: the slot record under
`.pipeline/.runtime/worktrees/<name>.json` says where the slot is, what branch
it carries and which submodule slots it cut, and the built-in teardown undoes
exactly that.

**`pipeline gc` is the janitor for a slot nobody can name any more.** It scans
`<project>/.claude/worktrees/` **and** the built-in slot root — `PIPELINE_WT_ROOT`
(default: `C:/tmp/pipeline-worktrees` on Windows when `C:/tmp` exists, else the
system temp directory's `pipeline-worktrees`) plus this project's
`<basename>-<hash>` segment, which is where the built-in provisioner puts its
slots so a worker's build output never lands inside the project. What it reaps
there is narrow and stated in the report, one reason per entry:

| under the slot root | `gc` | why |
| --- | --- | --- |
| a directory **no slot record names** | **reaps** under `--clean` | nothing can reach it by name, so no `destroy` can |
| a record whose **worktree is already gone** | **reaps** under `--clean` | its branch, env file and port reservation are stranded |
| a record whose worktree **is on disk** | reports, keeps | `pipeline worktree destroy --name <n>` owns it |
| a record saying `provisioner: "hook"` | reports, keeps | the symmetry rule — a hook's bookkeeping is not this CLI's to guess at |
| a slot preserved by `destroy --outcome halted` | reports, keeps | halting exists to keep the slot |
| a path inside the repository, at/inside the cwd, fewer than two segments below a filesystem root, or outside this project's slot root | **refuses**, with the reason | a command that deletes outside the repository states where it declines |

A reap goes through the same built-in teardown `destroy` uses (parent worktree,
every submodule worktree, the env file), then drops the stale slot record and
hands the slot's port reservations back. It does **not** delete the slot's
branch: plain `--clean` never force-deletes a branch, so removing the worktree
detaches `worktree-<name>` and `gc`'s ordinary branch policy takes it from there
— safe-deleted when merged, kept with a reason when not (a squash-merged run
branch reads as unmerged forever; `--force-worktree-branches` is the opt-in).

⚠ **`gc --clean` over the slot root is a quiescent-point operation.** A slot
being provisioned right now has a directory for the few seconds before its
record is written, and would read as record-less. Run `--clean` between dispatch
rounds (or after the last one), not during. Plain `gc` reports and changes
nothing, always.

### One known limitation

**A project path containing a space or a shell metacharacter is refused by the
built-in provisioner** (see [Env-file value constraints](#env-file-value-constraints)
above), because `PROJECT_ROOT` has to be written into the slot's env file
unquoted. This notably affects anything checked out under Windows' `C:\Program
Files\` or `C:\Program Files (x86)\`. It does **not** affect a
hook-provisioned slot — a `worktree-create.*` hook always wins and can write
its own env file however it likes.

---

### The frozen contract document

`worktree-hook-contract.md` — the authoritative, frozen reference for hook
**authors** (every `PIPELINE_WT_*` variable, every hook's stdout JSON shape,
the timeouts) — lives in the plugin repository, not here:
[`pipeline-claude/docs/worktree-hook-contract.md`](https://github.com/IvanMurzak/pipeline-claude/blob/main/docs/worktree-hook-contract.md).

**That document is currently stale in one respect.** It instructs an editor to
"update `apps/pipeline-cli/src/lib/hooks.ts`, `apps/pipeline-cli/src/commands/next.ts`
… in lockstep" — paths that predate this CLI's extraction into its own
repository (this package, `@baizor/pipeline`). The current paths are
`src/lib/hooks.ts` and `src/commands/next.ts`, with no `apps/pipeline-cli/`
prefix. Fixing that document is out of scope for this page — its disposition
belongs to the `plugin-thin` taskflow (`02-extract-cli.md`), which is doing the
broader pass over exactly this class of stale path across the plugin
repository. This note exists so a reader who follows the link above is not
left thinking the path mismatch is something they got wrong.

---

## `pipeline submodule bump` — the guarded pointer bump and its elevation switch

```console
$ pipeline submodule bump --project-root <path> [--submodules a,b] [--base <branch>]
                          [--source-worktree <path>] [--dry-run] [--json]
                          [--no-fetch] [--no-admin]
```

Records superproject submodule-pointer change(s) on the base branch and pushes
them **isolation-safely**: all branch and commit work happens in a throwaway
worktree cut from `origin/<base>`, and the only mutation ever performed on the
shared checkout is `git fetch` + `git merge --ff-only` — never a `checkout`, a
`reset`, or a force. Drifted pointers are auto-detected when `--submodules` is
omitted. One JSON object is printed on stdout; exit `0`
(`committed`/`noop`/`dry-run`), `1` (`halted`), `2` (usage or environment).

The change is landed **through a pull request**, not pushed straight at the base
branch. That is what makes the next section matter.

### `--no-admin` — refuse to bypass branch protection

The landing PR is merged with:

```console
gh pr merge <pr> --squash --delete-branch
```

**By default**, if GitHub refuses that merge — a required review, a required
check, any protection rule — the command retries **once** with `--admin`:

```console
gh pr merge <pr> --squash --delete-branch --admin
```

`--admin` is GitHub's administrator bypass. It merges the PR *despite* the rule
that refused it, and it only succeeds at all when the credentials `gh` is using
carry admin rights on the repository. This is the single point in the CLI where
a rule you configured on your own repository can be overridden on your behalf.

`--no-admin` turns that fallback off. With it:

- the plain merge is attempted **once**;
- if GitHub refuses it, the refusal is **reported and the command halts** —
  `status: "halted"`, `merge_outcome: "refused"`, `halt_reason` naming the PR,
  `stderr` carrying GitHub's own refusal text, exit code `1`;
- `gh` is **never invoked with `--admin`** at all.

Nothing is lost when a merge is refused this way. The scratch branch and its
commit are already on `origin` and the PR is open; the pointer bump is merged by
satisfying whatever gate refused it, exactly like any other pull request.

**The orchestrator is expected to pass `--no-admin`.** An automated driver that
lands pointer bumps on your behalf must not be able to silently overrule your
branch protection, so the Taskflow orchestrator passes this flag on every
invocation — the flag is what makes "a merge GitHub refuses is reported, never
retried with elevation" a property of the command rather than a promise in a
document.

**The default is deliberately still the fallback**, i.e. *on*. Flipping it would
change the behaviour of every existing caller without their asking — the class
of silent change this project avoids on principle. So the elevation is opt-out,
not opt-in, and the burden of opting out sits with the automated caller that
made the promise. Interactive use is unaffected: run it by hand and you get the
same behaviour you always did.

### The three merge outcomes in `--json`

`merge_outcome` is the machine-readable discriminator — a refused merge is
otherwise distinguishable from any other halt only by reading `halt_reason`
prose, which is not a contract.

| `merge_outcome` | `merged_via_admin` | `status` | What happened |
| --- | --- | --- | --- |
| `"plain"` | `false` | `committed` | `gh pr merge` succeeded as-is. Nothing was bypassed. |
| `"admin"` | `true` | `committed` | The plain merge was refused; the `--admin` retry succeeded. **Branch protection was bypassed.** Only reachable without `--no-admin`. |
| `"refused"` | `false` | `halted` | The merge did not happen and was reported. With `--no-admin` this is terminal and no `--admin` call was made; without it, it means even the elevated retry failed. |
| `null` | `false` | `noop` / `dry-run` / `halted` | The merge step was never reached — nothing had drifted, `--dry-run` stopped before it, or an earlier step (fetch, push, `gh pr create`) halted. |

`status` alone does not answer the question. A PR that merged perfectly well —
plainly or via `--admin` — still reports `halted` when the *shared checkout*
afterwards could not be fast-forwarded to it (`reconcile_status: "failed"`); the
bump landed on `origin` either way. `merge_outcome` is the only field that says
what happened to the merge itself.

`merged_via_admin` predates `merge_outcome` and is kept unchanged for existing
consumers; it answers only "was the bypass used", not "did the merge happen".

`--dry-run` reports the plan without pushing anything, and its
`planned_actions` state which merge would be attempted — the `gh pr merge` line
reads `(with --admin fallback)` only when the fallback is live, so a dry run is
also the cheapest way to confirm the flag reached the command.
