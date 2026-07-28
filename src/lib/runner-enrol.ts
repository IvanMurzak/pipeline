// runner-enrol.ts — the mechanics behind `pipeline cloud connect`'s runner
// enrolment (task a6, 04-cloud-auth.md §5, D11): mint a runner credential
// from the cloud, install `@baizor/pipeline-runner` on demand, register it,
// and install the supervisor service — all by SHELLING OUT to the
// `pipeline-runner` binary, never by writing its config store directly.
//
// WHY SHELL OUT (D11, task a6's scope note): `cloud-config.ts`'s credential
// store and pipeline-runner's own `core/config.ts` are two independently-
// released packages' config files, in two different formats, with no shared
// library between them. Writing the runner's config from here would couple
// them through a file format neither package owns. So every action below is
// either an HTTP call to the control plane (to MINT the credential — the one
// thing only a browser-session-holding CLI can do) or a subprocess spawn of
// `pipeline-runner <args>` / `bun add -g <pkg>` — never a `fs.writeFileSync`
// into pipeline-runner's own directories.
//
// SECRET HANDLING: the cloud mints a fresh, single-use-shown
// `clientSecret` (POST /api/v1/runners — see `mintRunner` below). It is
// passed to the child `pipeline-runner register` process via an ENVIRONMENT
// VARIABLE (`PIPELINE_RUNNER_OAUTH_CLIENT_SECRET`, pipeline-runner's own
// documented name — cli.ts's `CLIENT_SECRET_ENV`), never as a `--client-
// secret` argv flag: argv is world-readable via `ps` on Linux, the same
// posture this package's OWN `PIPELINE_MACHINE_TOKEN` already takes
// (commands/cloud.ts's module doc). `--client-id` (the runner's row id) is
// NOT a secret — it identifies the runner, but authenticates nothing without
// the paired secret — so it rides on argv like `--url` does. The secret is
// NEVER logged, NEVER included in a failure's relayed detail (verified by
// reading pipeline-runner's own `runRegister`: on a missing/rejected
// credential it only ever names WHICH field/env-var was consulted, never the
// value — see `registerRunner`'s doc below), and NEVER retained after the
// `register` subprocess exits.
//
// REUSABLE CHECK (task a6 scope note; `a9` converges on the same rule for
// `pipeline department serve`, 10-decisions.md D26): `isRunnerServiceInstalled`
// is the ONE place "does this machine already run a supervisor service?" is
// answered — a LOCAL, network-free check, because "one supervisor service per
// machine" is a machine-level fact, not an org-scoped one. Callers (this
// task's `commands/cloud.ts`, and later `commands/department.ts`) MUST check
// it themselves before calling `enrolRunner` — this file does not re-check
// internally, so it never shells `service status` twice per invocation.

import { spawnSync } from 'node:child_process';
import { CloudError } from './cloud-config';

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs an external command. `envOverride` is MERGED over the ambient
 * environment for ONLY this one invocation — the mechanism `registerRunner`
 * uses to hand the child process a fresh secret without ever putting it in
 * `args` (see this file's module doc).
 */
export type ShellRunner = (cmd: string, args: string[], envOverride?: Record<string, string>) => ShellResult;

/** The real subprocess spawner (child_process.spawnSync — SYNCHRONOUS, same
 *  idiom as `commands/init.ts`'s `realClaudeCli` and pipeline-runner's own
 *  `service/types.ts#nodeServiceExec`). `register` (without `--store-only`)
 *  validates connectivity before returning, so this call can legitimately
 *  block for up to ~30s (pipeline-runner's `REGISTER_ONCE_TIMEOUT_MS`) —
 *  acceptable for a one-time enrolment step, consistent with this package's
 *  existing synchronous-subprocess conventions. */
export const realShell: ShellRunner = (cmd, args, envOverride) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: envOverride ? { ...process.env, ...envOverride } : process.env,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1;
    return { code, stdout: r.stdout ?? '', stderr: String((r.error as Error).message ?? r.error) };
  }
  return { code: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// HTTP seam — deliberately local (mirrors credential-refresh.ts's own note):
// lib/ must not depend on commands/, so this duplicates cloud.ts's near-
// identical shape rather than importing it.
export interface HttpResponse {
  status: number;
  json(): Promise<unknown>;
}
export interface HttpInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}
export type FetchLike = (url: string, init: HttpInit) => Promise<HttpResponse>;

export interface RunnerEnrolDeps {
  shell: ShellRunner;
  fetch: FetchLike;
  /** Progress/result lines. Callers route these to stdout in human mode and
   *  to stderr in `--json` mode (mirrors commands/cloud.ts's `say()`) — this
   *  file has no opinion on which stream, it only ever calls `out`/`err`. */
  out: (s: string) => void;
  err: (s: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNNER_CLI_BIN = 'pipeline-runner';
export const RUNNER_PACKAGE = '@baizor/pipeline-runner';

/** Mirrors pipeline-runner's OWN `cli.ts#CLIENT_SECRET_ENV` byte-for-byte —
 *  the env var its `register` command reads the OAuth client secret from
 *  when `--client-id` is present but `--client-secret` is not (see this
 *  file's module doc on why the secret never rides on argv). */
export const RUNNER_OAUTH_CLIENT_SECRET_ENV = 'PIPELINE_RUNNER_OAUTH_CLIENT_SECRET';

// ---------------------------------------------------------------------------
// Reusable machine-level check (a6; a9 converges on the same rule)
// ---------------------------------------------------------------------------

/** True iff `pipeline-runner` itself resolves on PATH (`--version` exits 0).
 *  Used to decide whether the on-demand install step is needed. */
export function isRunnerCliAvailable(deps: Pick<RunnerEnrolDeps, 'shell'>): boolean {
  return deps.shell(RUNNER_CLI_BIN, ['--version']).code === 0;
}

/**
 * "One supervisor service per machine" (04-cloud-auth.md §5 / D26) — does a
 * pipeline-runner service ALREADY exist on this machine, in ANY state
 * (running or stopped)? Local-only: shells `pipeline-runner service status`
 * and reads its human-readable summary line. Every backend
 * (systemd/launchd/Windows SCM — verified against pipeline-runner's
 * `service/{systemd,launchd,windows}.ts`) renders the "nothing installed yet"
 * case with the exact substring "not installed", exits 0 either way (`status`
 * only ever exits non-zero for an unsupported platform — essentially
 * unreachable on a real user machine, since this package ships for exactly
 * the three platforms pipeline-runner's own backends cover), and never
 * throws internally. A missing `pipeline-runner` binary (spawn ENOENT →
 * `code === 127`, mirroring pipeline-runner's own `ServiceExec` convention)
 * is, naturally, also "not installed". Any OTHER, unexpected failure is
 * treated the SAME as "not installed" — never silently claim an
 * already-connected machine when the check itself could not confirm one
 * exists; a downstream step (mint/register/service-install) then surfaces
 * the real problem with an actionable message instead of this function
 * masking it behind a false checkmark. Re-running `service install` on a
 * machine that DOES already have one is not destructive either way — every
 * backend targets the SAME fixed service name (`pipeline-runner`), so a
 * false negative here overwrites/re-registers that one service rather than
 * forking a rival.
 *
 * CALLERS MUST CHECK THIS FIRST. `enrolRunner` below does not re-check it —
 * this is the one place the fact is established, so a caller (this task's
 * `commands/cloud.ts`, later `commands/department.ts` per D26) shells
 * `service status` exactly once per invocation rather than twice.
 *
 * **This answers "may I skip `service install`?", NOT "is a supervisor
 * running?"** — a `stopped` service is installed. Anything that wants to make
 * a claim about a department actually taking work must use
 * `readRunnerServiceState` below (x13).
 */
export function isRunnerServiceInstalled(deps: Pick<RunnerEnrolDeps, 'shell'>): boolean {
  return readRunnerServiceState(deps) !== 'not-installed';
}

/**
 * The SAME four states pipeline-runner's own `ServiceState`
 * (`service/types.ts`) models — mirrored, not imported, because the two
 * packages ship on independent versions (the same one-directional mirroring
 * rule `lib/department-journal.ts` keeps for the execution journal).
 *
 * `unknown` is pipeline-runner's OWN fourth state (a backend that found the
 * service but could not classify its state — e.g. `sc query` output that
 * matches neither `RUNNING` nor `STOPPED`), plus this reader's own "the line
 * did not parse" case. It is deliberately NOT collapsed into `stopped`:
 * "I know it is down" and "I could not tell" are different things to say to a
 * user, and x13 exists because they were being collapsed into "online".
 */
export type RunnerServiceState = 'running' | 'stopped' | 'not-installed' | 'unknown';

/**
 * x13: **installed is not running.** `isRunnerServiceInstalled` above answers
 * exactly one question — may `serve` skip `service install`? — and every state
 * except `not-installed` answers it "yes". That is correct for the install
 * decision and catastrophic as evidence of liveness: the machine that failed
 * the `e2` gate had a supervisor that was `stopped (auto-start)`, which is
 * "installed", and `serve` printed `● online` on the strength of it.
 *
 * This reader keeps the full state. It parses the one summary line every
 * backend prints (`pipeline-runner`'s `printResult` prefixes each with
 * `[pipeline-runner] `):
 *
 *   systemd   `pipeline-runner.service: running (enabled)`
 *   launchd   `com.ivanmurzak.pipeline-runner: stopped (not loaded)`
 *   windows   `service 'pipeline-runner': stopped (auto-start)`
 *   any       `<name> is not installed`
 *
 * Rules, in order, chosen so an unreadable answer can never become a claim:
 *  - a non-zero exit is `not-installed` — byte-for-byte the pre-existing
 *    behaviour (missing binary → 127, unsupported platform → 1), and the
 *    conservative answer for the install decision, which is the caller that
 *    depends on it;
 *  - the literal `not installed`, in either stream, is `not-installed`;
 *  - `: <state> (` is the shape all three backends render, so the state word
 *    is read from THERE rather than by scanning the whole line for the word
 *    `running` — the service is literally called `pipeline-runner`, and a
 *    bare substring search over a line that contains its own name is the kind
 *    of check that works until it does not;
 *  - anything else is `unknown`, never a guess.
 *
 * ONE shell per call, like `isRunnerServiceInstalled` — callers that need both
 * the install decision and the liveness evidence call THIS once and derive the
 * first from the result (a6's "ask the machine-level question exactly once per
 * invocation" rule).
 */
export function readRunnerServiceState(deps: Pick<RunnerEnrolDeps, 'shell'>): RunnerServiceState {
  const r = deps.shell(RUNNER_CLI_BIN, ['service', 'status']);
  if (r.code !== 0) return 'not-installed';
  const combined = `${r.stdout}\n${r.stderr}`;
  if (combined.toLowerCase().includes('not installed')) return 'not-installed';
  const m = /:\s*(running|stopped|unknown)\s*\(/i.exec(combined);
  if (m === null) return 'unknown';
  const word = m[1]!.toLowerCase();
  return word === 'running' ? 'running' : word === 'stopped' ? 'stopped' : 'unknown';
}

/** What this machine's `pipeline-runner` identity says about itself — the
 *  non-secret half only. `runnerId` is the server-assigned row id persisted
 *  from `register_ack`; it is exactly what the install claim needs
 *  (`mesh-registry/routes.ts`'s `runner_id`, a UUID). */
export interface RunnerIdentity {
  runnerId: string | null;
  baseUrl: string | null;
}

/**
 * Read this machine's runner identity by shelling `pipeline-runner status`
 * (task a9 / D26: another package's config store is READ through its own CLI,
 * never by parsing its files from here — the same rule that makes `register`
 * and `bind` shell-outs).
 *
 * `status` prints `describeIdentity()`'s JSON — every secret field replaced by
 * the literal `<redacted>` before it is ever written, so this call cannot
 * surface a credential even by accident. It exits 1 with a stated message when
 * no identity is configured, which is the ordinary "this machine has never
 * been enrolled" case and returns `null` here rather than an error.
 *
 * `runnerId` is `null` when an identity exists but has never completed a
 * register round trip (`register --store-only`, or a `register` whose
 * connection failed): there is a config file, but no server-assigned id to
 * claim an install with. Callers must treat that as "not enrolled yet",
 * because it is.
 */
export function readRunnerIdentity(deps: Pick<RunnerEnrolDeps, 'shell'>): RunnerIdentity | null {
  const r = deps.shell(RUNNER_CLI_BIN, ['status']);
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as { runner_id?: unknown; base_url?: unknown };
    return {
      runnerId: typeof parsed.runner_id === 'string' && parsed.runner_id.length > 0 ? parsed.runner_id : null,
      baseUrl: typeof parsed.base_url === 'string' && parsed.base_url.length > 0 ? parsed.base_url : null,
    };
  } catch {
    // A `status` that exited 0 but printed something we cannot read is the
    // same actionable state as no identity at all: the caller re-enrols, and
    // `register` overwrites the unreadable file with a good one.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mint (POST /api/v1/runners)
// ---------------------------------------------------------------------------

export interface MintedRunner {
  runnerId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * `POST <server>/api/v1/runners` — mint a runner + its OAuth client
 * credentials (cloud/apps/api/src/modules/runners/routes.ts, read directly,
 * not guessed). Requires an `admin`-role bearer (`requireRole(c, "admin")`);
 * a `member`/`viewer` caller gets a 403, surfaced here as an actionable
 * `CloudError` rather than a raw stack.
 *
 * The response ALWAYS carries `clientId`/`clientSecret` (the d5/c15 OAuth
 * client-credentials pair) and CONDITIONALLY a legacy plaintext `token`
 * (present only when the server's credential-rotation window still issues
 * one). This function deliberately uses ONLY `clientId`/`clientSecret` —
 * the modern, always-present, short-lived-exchange pair — never the legacy
 * `token`, so this NEW enrolment path never has to branch on the server's
 * rotation-window mode and never puts a long-lived plaintext secret in this
 * process's memory at all (the same direction 04-cloud-auth.md's D12
 * revision already took for `PIPELINE_MACHINE_TOKEN`).
 *
 * `orgId` (a UUID), when supplied, rides as `X-Org-Id` — required for a
 * device-grant access token (not org-bound in its own claims;
 * auth/middleware.ts's `resolveOrgSelection`) and harmless for a browser-flow
 * token (already org-bound; the header only has to AGREE, and it always does
 * here since the caller derived it from the same `/api/v1/me` response).
 * Omitted for the machine-credential path, whose token carries its own
 * `org_id` claim and for which no org UUID is available locally (only the
 * org SLUG the operator passed via `--org`).
 */
async function mintRunner(
  deps: Pick<RunnerEnrolDeps, 'fetch'>,
  server: string,
  accessToken: string,
  orgId: string | undefined,
  name: string,
): Promise<MintedRunner> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
  };
  if (orgId) headers['x-org-id'] = orgId;

  let res: HttpResponse;
  try {
    res = await deps.fetch(`${server}/api/v1/runners`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, labels: [] }),
    });
  } catch (e) {
    throw new CloudError(`could not reach ${server} to connect a runner — ${(e as Error).message}`);
  }

  if (res.status === 403) {
    throw new CloudError(
      'connecting a runner needs the admin role in this org — ask an org admin to run ' +
        '`pipeline cloud connect --runner`, or mint one yourself at the dashboard (Runners → New ' +
        'runner) and run `pipeline-runner register --url <url> --token <token>`',
    );
  }
  if (res.status !== 201) {
    let detail: string | undefined;
    try {
      const body = (await res.json()) as { error?: unknown };
      detail = typeof body.error === 'string' ? body.error : undefined;
    } catch {
      // tolerate a non-JSON error body
    }
    throw new CloudError(`could not connect a runner (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
  }

  const body = (await res.json()) as {
    runner?: { id?: unknown };
    clientId?: unknown;
    clientSecret?: unknown;
  };
  const clientId = typeof body.clientId === 'string' ? body.clientId : undefined;
  const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret : undefined;
  const runnerId = typeof body.runner?.id === 'string' ? body.runner.id : clientId;
  if (!clientId || !clientSecret || !runnerId) {
    throw new CloudError('runner creation response was missing clientId/clientSecret');
  }
  return { runnerId, clientId, clientSecret };
}

// ---------------------------------------------------------------------------
// Composition: install (on demand) → mint → register → service install
// ---------------------------------------------------------------------------

export type RunnerEnrolStatus =
  | 'connected'
  | 'connected-no-service'
  | 'install-failed'
  | 'mint-failed'
  | 'register-failed';

export interface RunnerEnrolOutcome {
  status: RunnerEnrolStatus;
  name: string;
  /** The server-assigned runner id, present on every outcome that got as far
   *  as a successful mint. `pipeline department serve` (a9) needs it: the
   *  install claim is `POST /departments/:id/installs { runner_id, … }`
   *  (`mesh-registry/routes.ts`), so without it a freshly-enrolled machine has
   *  nothing to claim with — which is the whole reason D26 folds enrolment
   *  into `serve` at all. */
  runnerId?: string;
  /** Human-readable failure detail. NEVER contains a secret — see this
   *  file's module doc; every failure path below relays only the CHILD
   *  process's own stderr/stdout (which pipeline-runner itself never prints
   *  a secret into — verified by reading `cli.ts#runRegister`) or a
   *  `CloudError` message this file itself composed. */
  detail?: string;
}

export interface EnrolRunnerParams {
  server: string;
  /** A valid, unexpired bearer for `server`'s `api` audience — the SAME
   *  token `cloud connect` just used for `/api/v1/me` (or, for the
   *  machine-credential path, the token `/oauth/token`'s client_credentials
   *  exchange returned). This file never refreshes or re-obtains it. */
  accessToken: string;
  orgId?: string;
  name: string;
  /**
   * Whether to install the supervisor SERVICE as part of enrolment. Default
   * `true` — `cloud connect` (a6) enrols and installs in one step.
   *
   * `pipeline department serve` (a9) passes `false`: 05 §5 splits these into
   * two steps (5 enrol, 7 ensure the supervisor) precisely because a machine
   * may already have a service and must get "a binding, not a rival service"
   * (D26). Re-running `service install` there is not merely redundant — every
   * backend targets the SAME fixed service name, so it would rewrite a unit
   * the operator may have adjusted, for no gain. `serve` therefore checks
   * `isRunnerServiceInstalled()` itself and installs only when there is none.
   */
  installService?: boolean;
}

/**
 * Install `@baizor/pipeline-runner` on demand (showing the command before
 * running it — 04-cloud-auth.md §5), mint a runner credential, register it,
 * and install the supervisor service. Callers MUST have already established
 * `!isRunnerServiceInstalled(deps)` — see that function's doc.
 *
 * Every failure is returned, never thrown: enrolment is an OPTIONAL upgrade
 * layered on an ALREADY-successful `cloud connect`, so a caller can report a
 * warning and still exit 0 for the connect itself.
 */
export async function enrolRunner(deps: RunnerEnrolDeps, params: EnrolRunnerParams): Promise<RunnerEnrolOutcome> {
  const { name } = params;

  if (!isRunnerCliAvailable(deps)) {
    deps.out(`  Installing the runner:\n`);
    deps.out(`    $ bun add -g ${RUNNER_PACKAGE}\n`);
    const install = deps.shell('bun', ['add', '-g', RUNNER_PACKAGE]);
    if (install.code !== 0) {
      return {
        status: 'install-failed',
        name,
        detail: (install.stderr || install.stdout || `exit ${install.code}`).trim(),
      };
    }
  }

  let minted: MintedRunner;
  try {
    minted = await mintRunner(deps, params.server, params.accessToken, params.orgId, name);
  } catch (e) {
    return { status: 'mint-failed', name, detail: e instanceof Error ? e.message : String(e) };
  }

  const register = registerRunner(deps, params.server, minted);
  if (register.code !== 0) {
    return {
      status: 'register-failed',
      name,
      runnerId: minted.runnerId,
      detail: (register.stderr || register.stdout || `exit ${register.code}`).trim(),
    };
  }

  // a9: `serve` owns the service decision itself (see `installService`'s doc).
  // Reported as `connected-no-service` so the ONE success status keeps meaning
  // "registered AND supervised" for every caller that asked for both.
  if (params.installService === false) {
    return { status: 'connected-no-service', name, runnerId: minted.runnerId };
  }

  const service = deps.shell(RUNNER_CLI_BIN, ['service', 'install']);
  if (service.code !== 0) {
    return {
      status: 'connected-no-service',
      name,
      runnerId: minted.runnerId,
      detail: (service.stderr || service.stdout || `exit ${service.code}`).trim(),
    };
  }

  return { status: 'connected', name, runnerId: minted.runnerId };
}

/**
 * `pipeline-runner register --url <server> --client-id <clientId>` with the
 * secret delivered via `PIPELINE_RUNNER_OAUTH_CLIENT_SECRET` (env, not
 * argv — see this file's module doc). `--client-id` alone is enough to make
 * pipeline-runner's own `register` read that env var (its `oauthRequested`
 * gate is "either flag present", `cli.ts:183-191`); the secret itself never
 * appears in `args`, so it never appears in `ps` output either. Never passes
 * `--token` (the legacy plaintext credential) and never passes
 * `--store-only` — DoD box 1 wants an ONLINE runner, and `register` without
 * `--store-only` validates connectivity before returning (see `realShell`'s
 * doc for the ~30s bound this implies).
 */
function registerRunner(deps: Pick<RunnerEnrolDeps, 'shell'>, server: string, minted: MintedRunner): ShellResult {
  return deps.shell(RUNNER_CLI_BIN, ['register', '--url', server, '--client-id', minted.clientId], {
    [RUNNER_OAUTH_CLIENT_SECRET_ENV]: minted.clientSecret,
  });
}
