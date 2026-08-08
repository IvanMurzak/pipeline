# `pipeline` CLI — telemetry, opt-out and the uploader

`pipeline --help` is the command reference and is generated from the code that
runs. This page covers the part `--help` cannot explain in a paragraph: what the
CLI uploads on your behalf, how to stop it, where it keeps things on disk, and
the lifecycle of the background process that does the sending.

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
| **Account** | The org and host from `.pipeline/cloud.json`, or `not connected — run \`pipeline cloud connect\``. |
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
