// telemetry-upload.ts — the flush half of the telemetry subsystem (ux-v2 `b10`).
//
// WHAT THIS IS. `b9` (`telemetry-outbox.ts`) tails the project journal, filters
// every payload through the vendored privacy allowlist, tags each record with
// the org it was queued under, and appends it to a bounded on-disk queue. This
// module is the other half: it takes batches OFF that queue, refuses anything
// that does not belong to the current org, filters again at the wire, and POSTs
// `{ run_id, events: [{ seq, payload }] }` to `POST /api/v1/ingest`.
//
// ── WHERE THIS RUNS, AND WHAT BOUNDS IT ─────────────────────────────────────
//
// NOT on the run's critical path — not in a hook, not inline in `drive`, not in
// any code a pipeline step awaits. `04` §6 is explicit: *"The hook only ensures
// the uploader is running — no network work in the hook"*. The only intended
// caller of `flushOnce()` is the DETACHED uploader daemon (`b11`), spawned
// `detached: true`, `stdio: 'ignore'`, `windowsHide: true`, `child.unref()` —
// a process the run neither waits for nor shares a stdio pipe with. A run that
// finishes while a flush is in flight simply exits; the daemon keeps its own
// idle/wall-clock bounds.
//
// That placement is what makes "cannot fail, delay, or alter a local run" true,
// but it is not the whole guarantee, because a wedged daemon would still stop
// telemetry moving and could hold the drain lock. So the flush is bounded too,
// three ways, and the bounds compose:
//
//   1. EVERY request carries `AbortSignal.timeout(requestTimeoutMs)` (default
//      5 s). There is no such thing as an unbounded request here — the runner's
//      HTTP transport has no timeout at all today (`upload-transport.ts:150`),
//      which is exactly the hazard this avoids.
//   2. EVERY flush carries a wall-clock deadline (`flushDeadlineMs`, default
//      20 s) measured from entry. It is checked before every request, and every
//      backoff sleep is CLAMPED to the time remaining — a retry loop can
//      therefore never outlive it.
//   3. At most `maxRequests` requests happen per flush (default 20), so even a
//      server that answers instantly cannot turn one flush into an unbounded
//      loop over a huge queue. The rest of the queue waits for the next poll.
//
//   ⇒ `flushOnce()` resolves in at most `flushDeadlineMs` plus the tail of one
//     in-flight request, i.e. `flushDeadlineMs + requestTimeoutMs` worst case,
//     for ANY server behaviour: refusing connections, hanging forever, dribbling
//     bytes, or answering with a gigabyte of garbage.
//
// ── THE ORG REFUSAL (F4 / threat T3) ────────────────────────────────────────
//
// A user who queues telemetry offline under org A and reconnects under org B
// must not have A's telemetry land in B's dashboard — a leak no deletion window
// repairs. There are two INDEPENDENT gates, because this control's entire
// purpose is refusal and a single point of failure is not good enough:
//
//   Gate 1 — `outbox.takeBatch()` (`b9`) partitions the queue against the
//            outbox's own org and hands foreign records back as `blocked`.
//   Gate 2 — `buildIngestBody()` here, the ONLY function in this module that
//            produces wire bytes, throws `OrgRefusalError` if ANY record in the
//            batch carries a different org. It runs AFTER filtering and
//            IMMEDIATELY before `JSON.stringify`, so there is no path from a
//            cross-org record to a request body that does not pass through it.
//
// "Current org" is the org THE CREDENTIAL authenticates to, not the one
// `.pipeline/cloud.json` happens to name. The server takes the org from the
// bearer (`requireOrg`, `modules/runs/routes.ts:137`) and never from the body,
// so a stale binding pointed at org A with a credential for org B would post
// A-tagged records into B — the leak itself. `resolveUploadTarget` therefore
// prefers `credential.org_slug` and falls back to the binding only when the
// credential does not name one.
//
// Blocked records are NOT deleted. Reconnecting to the original org releases
// them, exactly as `b9` intended.
//
// ── THE WIRE FILTER, AND WHY IT RUNS A SECOND TIME ──────────────────────────
//
// `b9` already filtered every payload before it touched disk. This module
// filters AGAIN, immediately before serialization, with the VENDORED copy
// (`vendor/privacy.ts`) — byte-identical to the runner source and guarded in
// CI by `a1`'s drift check. Not `@baizor/pipeline-protocol`: this package is
// invoked straight out of the plugin's cached git checkout, which has no
// `package.json` and no install step, so any external import reachable from
// `cli.ts` throws at import time for every plugin user (`01` §5). `b9` reached
// the same conclusion for the same reason.
//
// The second application is not belt-and-braces theatre. `outbox.jsonl` is a
// plain file inside the user's repository: it can be hand-edited, restored from
// a backup written by an older build, or planted by a hostile commit. Filtering
// at the wire means the queue file is untrusted input to the uploader rather
// than a trusted intermediate, and `tests/telemetry-upload.test.ts` proves the
// difference by planting secrets DIRECTLY into the queue file — bypassing `b9`
// entirely — and scanning the bytes the HTTP layer would put on the wire.
//
// Filtering twice has one hazard worth naming: `fingerprint` is the only rule
// in the allowlist that is not idempotent (`fingerprintString(fp:abc…)` is a
// different fingerprint again). Double-fingerprinting would not leak anything —
// it is strictly more opaque — but it would silently break correlation between
// the queue file and the wire, and between the CLI and runner paths. So
// `filterForWire` undoes exactly that one transformation, provably: a value is
// restored only when the ORIGINAL was already a well-formed `fp:<16 hex>` AND
// the filtered value is precisely `fingerprintString(original, salt)`. Nothing
// else is ever put back. Idempotence is asserted by test over the whole planted
// corpus.
//
// ── OUTCOME RULES (`04` §4) ─────────────────────────────────────────────────
//
//   2xx                → drop the record (`outbox.ack`)
//   5xx, network error → KEEP — retry with backoff
//   4xx                → QUARANTINE — never hot-loop on a permanently
//                        malformed record (`outbox.quarantine`, which writes
//                        `quarantine.jsonl` BEFORE removing anything and counts
//                        into `b9`'s own `state.json`, not a parallel ledger)
//   any exception      → swallowed. This module never throws into the run (D2)
//
// Four 4xx statuses are deliberately KEPT rather than quarantined —
// `KEEP_NOT_QUARANTINE_STATUSES` — and the reasoning is on that constant. In
// short: 401/403/408/425/429 describe the CREDENTIAL, the CLOCK or the RATE
// LIMITER, never a malformed record, so retrying the same bytes later can
// succeed. There is no hot loop because the retry schedule is persistent across
// flushes (`upload.json`), not per-call.
//
// ── NO PAYLOAD CONTENT IN LOGS OR METRICS (`07` §4.6, matrix 29) ────────────
//
// Structural, not disciplinary. `UploadFetch` returns `{ status }` and NOTHING
// else: the response body is never decoded, never stringified, never attached
// to an error, and therefore cannot be logged even by a careless future edit.
// The log sink receives a fixed-shape `FlushResult` of counters and a status
// code. The bearer token appears in exactly one place — the `authorization`
// header — and in no log line, error message or result field.

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CloudError,
  SERVER_ENV,
  cloudJsonPath,
  credentialFilePath,
  normalizeServerUrl,
  readCloudBinding,
  realFs,
  type CloudFs,
  type HomeContext,
} from './cloud-config';
import { ensureFreshCredential, type FetchLike, type RefreshDeps } from './credential-refresh';
import { telemetryDir, telemetrySyncEnabled, type OutboxRecord, type TelemetryOutbox } from './telemetry-outbox';
import {
  filterEventForTier,
  fingerprintString,
  stripStatsFailureExcerpts,
  type PrivacyTier,
} from './vendor/privacy';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The control-plane ingest route (`cloud/apps/api/src/modules/runs/routes.ts:136`).
 *  Mirrors the runner's `HTTP_INGEST_PATH` so both producers speak one path. */
export const INGEST_PATH = '/api/v1/ingest';

/** Per-request wall clock. Small on purpose: a flush is a background chore, and
 *  a slow control plane must cost a poll interval, never a stuck process. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/** Whole-flush wall clock, measured from entry to `flushOnce`. */
export const DEFAULT_FLUSH_DEADLINE_MS = 20_000;

/** Records per request. Mirrors the runner's `DEFAULT_BATCH_MAX_EVENTS`. */
export const DEFAULT_BATCH_SIZE = 100;

/** Requests per flush. Bounds the fast-server case the deadline does not. */
export const DEFAULT_MAX_REQUESTS = 20;

/** In-flush attempts for one batch before it is left queued for the next poll. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Exponential backoff, same shape as the runner's `DEFAULT_BACKOFF`
 *  (`pipeline-runner/src/core/backoff.ts`): 1 s base, ×2, 30 s cap, ±25 %
 *  jitter so a fleet of machines does not resynchronize onto one server. */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_CAP_MS = 30_000;
const BACKOFF_FACTOR = 2;
const BACKOFF_JITTER = 0.25;

/**
 * The 4xx statuses that are KEPT and retried rather than quarantined.
 *
 * `04` §4's table says "4xx ⇒ quarantine", and its stated reason is the whole
 * of it: *"never hot-loop on a permanently malformed record"*. These five are
 * not statements about the record at all:
 *
 *   401 — the access token expired or was rotated elsewhere. `b9`'s queue is
 *         perfectly good; a refreshed credential sends the same bytes.
 *   403 — no org selected / not a member / viewer-role. An authorization
 *         condition of the CALLER, fixed by `pipeline cloud connect`.
 *   408 — the server itself calls it a timeout.
 *   425 — "too early", explicitly a retry-later signal.
 *   429 — the rate limiter saying "later", not "never".
 *
 * Quarantining on these would discard a healthy queue on a token blip. The
 * hot-loop the rule guards against cannot happen anyway: a kept batch schedules
 * a PERSISTENT backoff in `upload.json`, so the next flush is refused outright
 * until it elapses.
 */
export const KEEP_NOT_QUARANTINE_STATUSES: ReadonlySet<number> = new Set([401, 403, 408, 425, 429]);

/** `upload.json` schema — retry SCHEDULING only. Drop/quarantine accounting
 *  stays in `b9`'s `state.json`; there is one ledger, not two. */
export const UPLOAD_STATE_SCHEMA = 1;
const UPLOAD_STATE_FILE = 'upload.json';

/** A well-formed fingerprint produced by the vendored filter. */
const FINGERPRINT_RE = /^fp:[0-9a-f]{16}$/;

/** The synthetic event type the control plane derives stats records from
 *  (`cloud/apps/api/src/modules/runs/ingest.ts:732`, and the runner's
 *  `shipper/stats.ts:65`). One taxonomy, two producers. */
const STATS_EVENT_TYPE = 'stats.run_record';

/** Envelope `schema` used when wrapping a stats record, matching the runner's
 *  `statsRecordEvent` (`shipper/stats.ts:240`). */
const STATS_ENVELOPE_SCHEMA = 4;

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

export interface UploadRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  /** The exact bytes that go on the wire. */
  body: string;
  /** Hard per-request bound. Implementations MUST honour it. */
  timeoutMs: number;
}

/**
 * A response, reduced to the ONE thing the outcome rules need.
 *
 * The body is deliberately absent from this type. `04` §4 keys every action on
 * the status alone, and `07` §4.6 forbids payload content in logs — so the
 * seam simply cannot carry a body, and a hostile server's response can never be
 * buffered, parsed, attached to an error, or printed. `status: 0` means no HTTP
 * response happened at all (connection refused, DNS failure, timeout, abort) —
 * classified with 5xx as retryable.
 */
export interface UploadResponse {
  status: number;
}

export type UploadFetch = (req: UploadRequest) => Promise<UploadResponse>;

/**
 * The real transport. Two properties beyond "call fetch":
 *
 *  - `AbortSignal.timeout` bounds the request, so an unreachable or hanging
 *    server costs `timeoutMs`, not forever.
 *  - the response body is CANCELLED, never read. A hostile server answering
 *    with a gigabyte cannot make this process buffer it, and there is nothing
 *    to accidentally log. The cancel happens under the same abort signal, so
 *    even that cannot hang.
 */
export const realUploadFetch: UploadFetch = async (req) => {
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(req.timeoutMs),
      // A redirect would re-send the bearer token to a server the credential
      // was not minted for. Never follow one.
      redirect: 'manual',
    });
    try {
      await res.body?.cancel();
    } catch {
      /* already closed, or aborted — either way there is nothing to release */
    }
    return { status: res.status };
  } catch {
    // Network error, DNS failure, TLS failure, timeout. Deliberately opaque:
    // the error object can carry a server-controlled string.
    return { status: 0 };
  }
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Where a flush sends, and as whom. */
export interface UploadTarget {
  /** Control-plane API base, e.g. `https://api.ai-pipeline.dev`. */
  server: string;
  /** The org the CREDENTIAL authenticates to — see this module's header for
   *  why it is not simply the binding's org. Records tagged with anything else
   *  are refused. */
  org: string;
  /** The org's UUID, when known, sent as `X-Org-Id`. Usually absent: a
   *  `cloud connect` credential is org-bound in its own claims, and the server
   *  403s a header that disagrees with the token (`modules/auth/
   *  middleware.ts:423-456`), so asserting nothing is both correct and safer.
   *  A slug is NOT accepted here — the header must be a UUID. */
  orgId?: string;
  /** Bearer credential — SECRET. Never logged, never returned, never in an
   *  error message. */
  token: string;
}

export class OrgRefusalError extends Error {
  constructor(
    readonly expected: string,
    readonly found: string,
  ) {
    // Org SLUGS are non-secret identifiers (they already sit in a committed
    // `cloud.json`), so naming them is safe and is what makes the refusal
    // diagnosable.
    super(`refusing to send telemetry queued under org '${found}' to org '${expected}'`);
    this.name = 'OrgRefusalError';
  }
}

/** The result of one flush. Counters and a status code — no payload, no body,
 *  no token, no path. This is the shape the log sink receives. */
export interface FlushResult {
  outcome:
    | 'disabled'
    | 'backoff'
    | 'idle'
    | 'sent'
    | 'retry'
    | 'quarantined'
    | 'deadline'
    | 'error';
  requests: number;
  records_sent: number;
  records_kept: number;
  records_quarantined: number;
  /** Records refused because they were queued under a different org (F4). */
  records_refused_org: number;
  /** Distinct statuses observed, for diagnosis. Numbers only. */
  statuses: number[];
  deadline_hit: boolean;
  duration_ms: number;
}

export interface TelemetryUploaderOptions {
  /** The `b9` queue. Its `org` should equal `target.org`; if it does not, the
   *  two gates intersect to nothing and the flush sends nothing — fail-safe by
   *  construction rather than by an assertion someone can remove. */
  outbox: TelemetryOutbox;
  target: UploadTarget;
  fetch?: UploadFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  batchSize?: number;
  maxRequests?: number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  flushDeadlineMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  env?: Record<string, string | undefined>;
  /** Content-free diagnostics sink. Defaults to a no-op: the uploader is a
   *  background chore and has no terminal to write to. */
  log?: (result: FlushResult) => void;
}

// ---------------------------------------------------------------------------
// The wire filter
// ---------------------------------------------------------------------------

/**
 * Apply the vendored allowlist to a payload that is ABOUT to be serialized,
 * without double-fingerprinting.
 *
 * See this module's header for why it runs a second time. The restoration rule
 * is deliberately narrow: a key is put back to its pre-filter value only when
 * that value was already a well-formed `fp:<16 hex>` AND the filter's output
 * for it is exactly `fingerprintString(thatValue, salt)`. Any other difference
 * — a dropped field, a placeholder, a truncation — stands.
 */
export function filterForWire(
  payload: Record<string, unknown>,
  tier: PrivacyTier,
  salt: string,
): Record<string, unknown> {
  const filtered = filterEventForTier(payload, tier, { fingerprintSalt: salt });
  return undoDoubleFingerprint(payload, filtered, salt) as Record<string, unknown>;
}

function undoDoubleFingerprint(before: unknown, after: unknown, salt: string): unknown {
  if (typeof before === 'string' && typeof after === 'string') {
    if (FINGERPRINT_RE.test(before) && after === fingerprintString(before, salt)) return before;
    return after;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return after.map((v, i) => (i < before.length ? undoDoubleFingerprint(before[i], v, salt) : v));
  }
  if (isRecord(before) && isRecord(after)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(after)) {
      out[k] = k in before ? undoDoubleFingerprint(before[k], v, salt) : v;
    }
    return out;
  }
  return after;
}

/**
 * The journal-shaped envelope a `kind: 'stats'` record travels in.
 *
 * The control plane derives stats from an event whose `type` is
 * `stats.run_record` (`ingest.ts:732`), so the queue's bare record has to be
 * wrapped. The envelope carries NO machine path: `project_root` is omitted
 * outright rather than fingerprinted, because at flush time the raw path is not
 * in hand (`b9` never queued it on this record) and inventing one would be the
 * only way a path could re-enter here.
 *
 * `stripStatsFailureExcerpts` runs here as well as in `b9`, because D16 / `07`
 * G-sec-2 requires failure excerpts gone at EVERY tier and the tier filter
 * alone does not deliver that: at `events` and `full`, `filterEventForTier`
 * passes the envelope verbatim, so a record that reached the queue file
 * unfiltered would carry its stack traces onto the wire.
 */
export function statsEnvelope(record: OutboxRecord, fallbackTs: string): Record<string, unknown> {
  const endedAt = record.payload.ended_at;
  return {
    schema: STATS_ENVELOPE_SCHEMA,
    ts: typeof endedAt === 'string' && endedAt ? endedAt : fallbackTs,
    type: STATS_EVENT_TYPE,
    worktree: null,
    run_id: record.run_id,
    parent_run_id: null,
    session_id: null,
    data: stripStatsFailureExcerpts(record.payload),
  };
}

/**
 * Build ONE ingest request body. The only function in this module that produces
 * wire bytes — which is why the org gate lives here, after filtering and
 * immediately before `JSON.stringify`.
 *
 * @throws OrgRefusalError if any record was queued under a different org.
 */
export function buildIngestBody(
  runId: string,
  records: readonly OutboxRecord[],
  org: string,
  tier: PrivacyTier,
  salt: string,
  fallbackTs: string,
): string {
  for (const rec of records) {
    if (rec.org !== org) throw new OrgRefusalError(org, rec.org);
    if (rec.run_id !== runId) throw new TypeError('batch mixes run_ids — ingest is per-run');
  }
  const events = records.map((rec) => ({
    seq: rec.seq,
    payload: filterForWire(
      rec.kind === 'stats' ? statsEnvelope(rec, fallbackTs) : rec.payload,
      tier,
      salt,
    ),
  }));
  return JSON.stringify({ run_id: runId, events });
}

// ---------------------------------------------------------------------------
// Persistent retry schedule
// ---------------------------------------------------------------------------

interface UploadState {
  schema: number;
  /** Consecutive retryable failures. Drives the backoff exponent. */
  attempt: number;
  /** Epoch ms before which a flush declines to do anything. */
  next_attempt_at: number;
}

function emptyUploadState(): UploadState {
  return { schema: UPLOAD_STATE_SCHEMA, attempt: 0, next_attempt_at: 0 };
}

/** `<project>/.pipeline/.runtime/telemetry/upload.json`. */
export function uploadStatePath(projectRoot: string): string {
  return join(telemetryDir(projectRoot), UPLOAD_STATE_FILE);
}

/** Exponential backoff with ±25 % jitter, capped. */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number,
): number {
  const raw = Math.min(capMs, baseMs * Math.pow(BACKOFF_FACTOR, Math.max(0, attempt - 1)));
  const jitter = raw * BACKOFF_JITTER * (random() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

// ---------------------------------------------------------------------------
// The uploader
// ---------------------------------------------------------------------------

export class TelemetryUploader {
  private readonly outbox: TelemetryOutbox;
  private readonly target: UploadTarget;
  private readonly doFetch: UploadFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly batchSize: number;
  private readonly maxRequests: number;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly flushDeadlineMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly env: Record<string, string | undefined>;
  private readonly log: (result: FlushResult) => void;
  private readonly statePath: string;

  constructor(opts: TelemetryUploaderOptions) {
    this.outbox = opts.outbox;
    this.target = opts.target;
    this.doFetch = opts.fetch ?? realUploadFetch;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
    this.maxRequests = Math.max(1, opts.maxRequests ?? DEFAULT_MAX_REQUESTS);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.requestTimeoutMs = Math.max(1, opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.flushDeadlineMs = Math.max(1, opts.flushDeadlineMs ?? DEFAULT_FLUSH_DEADLINE_MS);
    this.backoffBaseMs = Math.max(0, opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS);
    this.backoffCapMs = Math.max(0, opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS);
    this.env = opts.env ?? process.env;
    this.log = opts.log ?? (() => {});
    this.statePath = uploadStatePath(this.outbox.projectRoot);
  }

  /** The endpoint one batch is POSTed to. */
  get url(): string {
    return `${normalizeServerUrl(this.target.server)}${INGEST_PATH}`;
  }

  /**
   * Take what is sendable off the queue and try to deliver it, ONCE, within
   * the bounds documented at the top of this file.
   *
   * NEVER throws (D2). Every failure — a hostile server, an unreadable queue,
   * a filter that blows up on a hand-edited record — resolves to a
   * `FlushResult` with `outcome: 'error'`.
   */
  async flushOnce(): Promise<FlushResult> {
    const started = this.now();
    const result: FlushResult = {
      outcome: 'idle',
      requests: 0,
      records_sent: 0,
      records_kept: 0,
      records_quarantined: 0,
      records_refused_org: 0,
      statuses: [],
      deadline_hit: false,
      duration_ms: 0,
    };
    const deadline = started + this.flushDeadlineMs;
    const remaining = (): number => Math.max(0, deadline - this.now());

    try {
      if (!telemetrySyncEnabled(this.env)) {
        result.outcome = 'disabled';
        return this.finish(result, started);
      }
      const state = this.loadState();
      if (state.next_attempt_at > this.now()) {
        // A previous flush hit a retryable failure and scheduled this one out.
        // Refusing here — rather than inside the request loop — is what makes
        // the "never hot-loop" property hold across process boundaries.
        result.outcome = 'backoff';
        return this.finish(result, started);
      }

      // Gate 1 (b9): partition against the outbox's own org.
      const { sendable, blocked } = this.outbox.takeBatch(this.batchSize * this.maxRequests);
      result.records_refused_org += blocked.length;
      // Gate 2, part one: an independent partition against the TARGET's org.
      // The pair matters when the outbox and the target disagree — then the
      // intersection is empty and nothing is sent, which is the safe answer.
      const mine: OutboxRecord[] = [];
      for (const rec of sendable) {
        if (rec.org === this.target.org) mine.push(rec);
        else result.records_refused_org += 1;
      }
      if (mine.length === 0) return this.finish(result, started);

      const tier = this.outbox.tier;
      const salt = this.outbox.fingerprintSalt;
      let sawRetryable = false;

      for (const batch of chunkByRun(mine, this.batchSize)) {
        if (result.requests >= this.maxRequests) break;
        // A FAST PATH, not an independent guard. `deliver`'s own check would
        // reach the same conclusion one step later, so removing this line
        // alone changes no outcome (mutation M8b is deliberately uncaught by
        // the suite). What it saves is real work: building a body means
        // filtering every record in the batch, and there is no point paying
        // that to discover the deadline has already passed.
        if (remaining() <= 0) {
          result.deadline_hit = true;
          break;
        }
        const outcome = await this.deliver(batch, tier, salt, result, remaining);
        if (outcome === 'deadline') {
          result.deadline_hit = true;
          break;
        }
        if (outcome === 'retryable') {
          sawRetryable = true;
          // A server that is down for one batch is down for the rest. Stop
          // here rather than burning the deadline proving it.
          break;
        }
      }

      if (sawRetryable) {
        this.scheduleBackoff(state);
      } else if (result.records_sent > 0 || result.records_quarantined > 0) {
        this.clearBackoff(state);
      }

      result.outcome = result.deadline_hit
        ? 'deadline'
        : sawRetryable
          ? 'retry'
          : result.records_quarantined > 0 && result.records_sent === 0
            ? 'quarantined'
            : result.records_sent > 0
              ? 'sent'
              : 'idle';
      return this.finish(result, started);
    } catch {
      // D2. Nothing that happens in a background chore is allowed to surface.
      result.outcome = 'error';
      return this.finish(result, started);
    }
  }

  /** One batch, with in-flush retries. Returns how the batch settled. */
  private async deliver(
    batch: { runId: string; records: OutboxRecord[] },
    tier: PrivacyTier,
    salt: string,
    result: FlushResult,
    remaining: () => number,
  ): Promise<'sent' | 'quarantined' | 'retryable' | 'refused' | 'deadline'> {
    let body: string;
    try {
      // Gate 2, part two: the hard refusal, on the bytes themselves.
      body = buildIngestBody(
        batch.runId,
        batch.records,
        this.target.org,
        tier,
        salt,
        new Date(this.now()).toISOString(),
      );
    } catch (e) {
      if (e instanceof OrgRefusalError) {
        result.records_refused_org += batch.records.length;
        return 'refused';
      }
      // A record so malformed the filter could not process it. Leaving it
      // queued would wedge every later record behind it, so it is set aside
      // exactly like a server rejection — counted, on disk, never re-sent.
      result.records_quarantined += this.outbox.quarantine(batch.records);
      return 'quarantined';
    }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const left = remaining();
      if (left <= 0) return 'deadline';
      const res = await this.doFetch({
        url: this.url,
        method: 'POST',
        headers: this.headers(),
        body,
        timeoutMs: Math.min(this.requestTimeoutMs, left),
      });
      result.requests += 1;
      if (!result.statuses.includes(res.status)) result.statuses.push(res.status);

      if (res.status >= 200 && res.status < 300) {
        result.records_sent += this.outbox.ack(batch.records);
        return 'sent';
      }
      if (res.status >= 400 && res.status < 500 && !KEEP_NOT_QUARANTINE_STATUSES.has(res.status)) {
        result.records_quarantined += this.outbox.quarantine(batch.records);
        return 'quarantined';
      }
      // 5xx, 1xx/3xx (a control plane never answers these — treat as broken),
      // 0 (network/timeout), and the kept 4xx set: the records stay queued.
      if (attempt === this.maxAttempts) break;
      const delay = Math.min(
        backoffDelayMs(attempt, this.backoffBaseMs, this.backoffCapMs, this.random),
        remaining(),
      );
      if (delay <= 0) break;
      await this.sleep(delay);
    }
    result.records_kept += batch.records.length;
    return 'retryable';
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${this.target.token}`,
    };
    if (this.target.orgId) h['x-org-id'] = this.target.orgId;
    return h;
  }

  private finish(result: FlushResult, started: number): FlushResult {
    result.duration_ms = Math.max(0, this.now() - started);
    try {
      this.log(result);
    } catch {
      /* a diagnostics sink must never fail the caller */
    }
    return result;
  }

  // ── retry schedule ────────────────────────────────────────────────────────

  /** Read `upload.json`; anything unrecognized reads as "no schedule", which
   *  is the permissive direction and cannot lose data. */
  loadState(): UploadState {
    try {
      if (!existsSync(this.statePath)) return emptyUploadState();
      const parsed: unknown = JSON.parse(readFileSync(this.statePath, 'utf-8'));
      if (!isRecord(parsed) || parsed.schema !== UPLOAD_STATE_SCHEMA) return emptyUploadState();
      const attempt = typeof parsed.attempt === 'number' && parsed.attempt >= 0 ? Math.floor(parsed.attempt) : 0;
      const next =
        typeof parsed.next_attempt_at === 'number' && Number.isFinite(parsed.next_attempt_at)
          ? parsed.next_attempt_at
          : 0;
      return { schema: UPLOAD_STATE_SCHEMA, attempt, next_attempt_at: next };
    } catch {
      return emptyUploadState();
    }
  }

  private saveState(state: UploadState): void {
    try {
      // Best-effort by contract: losing the schedule degrades to "try again
      // next poll", never to a failure.
      writeJsonAtomic(this.statePath, state);
    } catch {
      /* never fail a flush over a scheduling hint */
    }
  }

  private scheduleBackoff(state: UploadState): void {
    const attempt = state.attempt + 1;
    const delay = backoffDelayMs(attempt, this.backoffBaseMs, this.backoffCapMs, this.random);
    this.saveState({ schema: UPLOAD_STATE_SCHEMA, attempt, next_attempt_at: this.now() + delay });
  }

  private clearBackoff(state: UploadState): void {
    if (state.attempt === 0 && state.next_attempt_at === 0) return;
    this.saveState(emptyUploadState());
  }
}

// ---------------------------------------------------------------------------
// Credential resolution — SILENT (never prompts, never opens a browser)
// ---------------------------------------------------------------------------

export interface ResolveTargetDeps {
  /** The consumer project root, whose `.pipeline/cloud.json` names the server. */
  cwd: string;
  platform: string;
  env: Record<string, string | undefined>;
  homedir: string;
  fs?: CloudFs;
  now?: () => number;
  /** Injected for tests; the default is bounded by `refreshTimeoutMs`. */
  fetch?: FetchLike;
  /** Bound on the one network call this function can make (a token refresh). */
  refreshTimeoutMs?: number;
}

/** A refresh transport with the timeout `credential-refresh.ts`'s own default
 *  lacks — the uploader must not inherit an unbounded call. */
export function boundedRefreshFetch(timeoutMs: number): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, { ...(init as RequestInit), signal: AbortSignal.timeout(timeoutMs) });
    return res as unknown as Awaited<ReturnType<FetchLike>>;
  };
}

/**
 * Resolve where telemetry should go, using only what is already on disk.
 *
 * SILENT by contract (`07` §4.7, and the task's "credential resolution is
 * silent"): no prompt, no browser, no device code, no interactive re-auth. The
 * one network call it can make is a refresh-token grant, which
 * `ensureFreshCredential` performs headlessly — and only when a stored
 * credential is actually expiring. Any failure at all returns `null`, meaning
 * "there is nothing to upload to", which is `03` F7's stance: with no account
 * the subsystem is ABSENT, not merely inert.
 *
 * "Current org" is the credential's own `org_slug` when it has one. See this
 * module's header: the server routes by credential, so a stale
 * `.pipeline/cloud.json` naming a different org must not be believed.
 */
export async function resolveUploadTarget(deps: ResolveTargetDeps): Promise<UploadTarget | null> {
  try {
    const fs = deps.fs ?? realFs;
    const binding = readCloudBinding(fs, cloudJsonPath(deps.cwd));
    if (!binding) return null;
    const server = normalizeServerUrl(
      (deps.env[SERVER_ENV] ?? '').trim() || binding.server || '',
    );
    if (!server) return null;

    const ctx: HomeContext = { platform: deps.platform, env: deps.env, homedir: deps.homedir };
    if (!fs.existsSync(credentialFilePath(ctx))) return null;

    const timeoutMs = deps.refreshTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const refreshDeps: RefreshDeps = {
      fetch: deps.fetch ?? boundedRefreshFetch(timeoutMs),
      fs,
      now: deps.now ?? (() => Date.now()),
      platform: deps.platform,
      env: deps.env,
      homedir: deps.homedir,
    };
    const cred = await ensureFreshCredential(refreshDeps, server);
    if (!cred.access_token) return null;

    const org = (cred.org_slug ?? '').trim() || (binding.org ?? '').trim();
    if (!org) return null;
    return { server, org, token: cred.access_token };
  } catch (e) {
    // `CloudError` is the expected shape (no credential, re-auth required,
    // server unreachable); anything else is equally not-a-reason-to-throw.
    void (e instanceof CloudError);
    return null;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Group records by `run_id` and chunk each group — ingest is a PER-RUN batch
 * (`{ run_id, events }`), so a batch that mixed runs could not be expressed.
 * Insertion order is preserved within a run, which keeps `seq` ascending on the
 * wire even though the server dedups on `(run_id, seq)` regardless.
 */
export function chunkByRun(
  records: readonly OutboxRecord[],
  batchSize: number,
): Array<{ runId: string; records: OutboxRecord[] }> {
  const byRun = new Map<string, OutboxRecord[]>();
  for (const rec of records) {
    const bucket = byRun.get(rec.run_id);
    if (bucket) bucket.push(rec);
    else byRun.set(rec.run_id, [rec]);
  }
  const out: Array<{ runId: string; records: OutboxRecord[] }> = [];
  for (const [runId, group] of byRun) {
    for (let i = 0; i < group.length; i += batchSize) {
      out.push({ runId, records: group.slice(i, i + batchSize) });
    }
  }
  return out;
}

/** Temp file + rename, the same primitive (and the same reasoning) as
 *  `telemetry-outbox.ts`'s `writeFileAtomic`. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, 'utf-8');
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}
