// department-serve.ts — the mechanics behind `pipeline department serve`
// (simplified-onboarding design, task a9; refs 05 §5, 04 §5, 07 §4, D14/D26).
//
// `serve` is nine steps (05 §5): validate, authenticate, digest, register or
// update, enrol this machine as a runner, bind the runtime locally, ensure the
// supervisor, claim the install, report. This module owns the steps that talk
// to something outside this process — the control plane over HTTP and
// `pipeline-runner` over argv — plus the pure functions that decide what to
// send. The ORCHESTRATION and every printed line live in
// `commands/department.ts`, mirroring how `commands/cloud.ts` sits on top of
// `lib/runner-enrol.ts`.
//
// ── Three rules this module exists to keep ──────────────────────────────────
//
// 1. **Never write another package's config store.** The local runtime binding
//    lives in `pipeline-runner`'s OWN config dir (`departments.json`), so
//    writing it from here would be exactly what 05 §5 step 5 forbids ("it
//    never writes another package's config store directly"). Task `b1` added
//    the `bind` / `unbind` / `bindings` verbs precisely so another package can
//    obey that rule; `bindRuntime()` below shells out to `pipeline-runner
//    bind`. The same rule already governs enrolment (`register`, via
//    `lib/runner-enrol.ts`) and identity reads (`status`).
//
// 2. **The `runtime:` half never leaves this machine.** `buildRegistrationRequest()`
//    (a7) is an ALLOW-LIST projection and re-checks its own output against a
//    deny-list (`assertNoLocalFields`), so the request this module PUTs on the
//    wire structurally cannot carry `command`, `args`, `workingDirectory`,
//    `environment`, or the engine name. This module never constructs a request
//    body by hand for that reason.
//
// 3. **The cloud's coherence check can no longer fire, so ours must.**
//    `validateManifestCoherence()` (`mesh-registry/manifest.ts`) keys every
//    rule off `runtime.adapter`; rule 2 means the server never receives one,
//    so it evaluates an empty shape and returns `[]` — structurally
//    unreachable, for every department, forever. The equivalent rules are
//    enforced LOCALLY and EARLIER by `department validate` (a8) over a7's
//    engine registry (`EngineDefinition.capabilities` /
//    `.supportedLifecycles`), and `serve` runs validate IN FULL before it
//    registers anything (05 §5 step 1). Nothing in this file duplicates that
//    machinery — it is a precondition of calling into it.
//
// ── Idempotent and resumable, with no local state file ──────────────────────
//
// Every step below re-derives its state from the two authorities that already
// hold it — the control plane (does a department with this slug exist? at
// which digest? is this machine's install claimed?) and the local
// `pipeline-runner` (does this machine have an identity? a service? a
// binding?). `serve` therefore writes NOTHING into the department folder: no
// state file, no `.claude/pipeline/cloud.json` (which would pin a clonable
// repo to one org and one server — a9's scope note), nothing but what the user
// authored. Re-running after an interruption converges because each step asks
// "is this already true?" rather than "did I do this?".

import { resolve } from 'node:path';
import type { DepartmentManifest, DepartmentRegistrationRequest } from './department-manifest';
import { adapterIdForEngine, engineDefinition, ENGINES } from './department-manifest';
import type { ShellRunner } from './runner-enrol';

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The narrow response shape this module consumes. Structurally satisfied by
 *  `commands/cloud.ts`'s `HttpResponse` (which also has `text()`), so the same
 *  injected `fetch` serves both. */
export interface ServeHttpResponse {
  status: number;
  json(): Promise<unknown>;
}

export interface ServeHttpInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type ServeFetch = (url: string, init: ServeHttpInit) => Promise<ServeHttpResponse>;

export interface ServeDeps {
  fetch: ServeFetch;
  /** Shells `pipeline-runner <args>` — the ONLY way this module touches that
   *  package (see rule 1 in the module doc). */
  shell: ShellRunner;
}

/** Everything the control-plane calls need, resolved once by step 2. */
export interface CloudContext {
  /** Normalized control-plane base URL. */
  server: string;
  /** SECRET — never printed, never passed on argv. */
  accessToken: string;
  orgSlug: string;
  /** The org UUID, when known (absent on the machine-credential path — see
   *  `commands/cloud.ts`'s `ApiAuth`). Rides as `X-Org-Id`, which a
   *  device-grant token REQUIRES (its own claims carry no org) and an
   *  org-bound token merely agrees with. */
  orgId?: string;
}

const RUNNER_CLI_BIN = 'pipeline-runner';

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * The dashboard origin for a control-plane API base — `https://api.example.dev`
 * → `https://example.dev`. 07 §4's transcripts print
 * `https://ai-pipeline.dev/departments/<slug>` while the CLI talks to
 * `https://api.ai-pipeline.dev`, and no endpoint tells the CLI the app origin,
 * so it is derived: strip a leading `api.` label, leave every other host
 * (localhost, a bare custom domain, an IP) exactly as it is. A wrong guess
 * here costs a mistyped link in one message, never a misdirected request —
 * this value is only ever printed.
 */
export function appOriginFor(server: string): string {
  try {
    const url = new URL(server);
    if (url.hostname.startsWith('api.') && url.hostname.length > 'api.'.length) {
      url.hostname = url.hostname.slice('api.'.length);
    }
    url.pathname = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return server;
  }
}

/** Where an admin approves this department's pending install (07 §4). */
export function departmentUrlFor(server: string, slug: string): string {
  return `${appOriginFor(server)}/departments/${slug}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface JsonResult {
  status: number;
  /** Parsed body, or `null` when the response carried none / unparseable JSON
   *  (an error page from an intermediary, a 204). */
  body: Record<string, unknown> | null;
  /** Set when the request never reached the server at all — 05 §5's
   *  "Offline" precondition, which must read as "nothing was registered",
   *  never as a broken product. */
  networkError?: string;
}

/**
 * One authenticated control-plane call. Never throws: a transport failure is
 * returned as `networkError` so the caller can produce 05 §5's offline
 * refusal, and a non-2xx is returned with its body so the caller can relay the
 * server's own D29-named message (the plan ceilings from `c8` put the entire
 * user-facing sentence in `error`).
 */
export async function cloudRequest(
  deps: ServeDeps,
  ctx: CloudContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResult> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${ctx.accessToken}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ctx.orgId) headers['x-org-id'] = ctx.orgId;

  let res: ServeHttpResponse;
  try {
    res = await deps.fetch(`${ctx.server}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { status: 0, body: null, networkError: (e as Error).message };
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const json = await res.json();
    if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
      parsed = json as Record<string, unknown>;
    }
  } catch {
    // A body we cannot read is not itself an error — `status` still decides.
  }
  return { status: res.status, body: parsed };
}

/** The server's own message for a failed call, when it supplied one. Every
 *  D29 ceiling and every registry 4xx puts the whole user-facing sentence in
 *  `error`, so relaying it verbatim is correct rather than lazy — inventing a
 *  second wording would mean two sources of truth for one limit. */
export function serverError(result: JsonResult): string | undefined {
  const raw = result.body?.['error'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Step 4 — register or update
// ---------------------------------------------------------------------------

export interface DepartmentRecord {
  id: string;
  slug: string;
  /** The digest the CLOUD currently holds for this department. */
  manifestDigest: string | null;
  enabled: boolean;
  retired: boolean;
}

function toRecord(raw: unknown): DepartmentRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || typeof r['slug'] !== 'string') return null;
  return {
    id: r['id'],
    slug: r['slug'],
    manifestDigest: typeof r['manifestDigest'] === 'string' ? r['manifestDigest'] : null,
    enabled: r['enabled'] !== false,
    retired: r['retired'] === true,
  };
}

export type RegisterOutcome =
  | { ok: true; action: 'created' | 'updated' | 'unchanged'; department: DepartmentRecord }
  | { ok: false; message: string };

/**
 * Step 4 (05 §5): `POST /api/v1/departments` on first serve, `PATCH` when the
 * digest changed, a no-op when it is equal.
 *
 * The existing department is discovered by LISTING the org's departments and
 * matching on slug, rather than by remembering an id locally. That is what
 * makes `serve` resumable from any partial state (a run interrupted after the
 * POST has nothing to remember) AND what keeps the department folder free of
 * CLI-written files. It is also what "several machines serving one department"
 * (05 §5) requires: machine B has never seen machine A's id.
 *
 * Retired departments are deliberately absent from that list
 * (`mesh-registry/service.ts`: "DELETE is final, not a filterable state"), so
 * a slug held by a retired department shows up as a 409 on the POST — 05 §5's
 * "slug taken" row, whose message this reproduces.
 */
export async function registerOrUpdateDepartment(
  deps: ServeDeps,
  ctx: CloudContext,
  request: DepartmentRegistrationRequest,
): Promise<RegisterOutcome> {
  const list = await cloudRequest(deps, ctx, 'GET', '/api/v1/departments');
  if (list.networkError !== undefined) {
    return { ok: false, message: offlineMessage(ctx.server, list.networkError) };
  }
  if (list.status !== 200) {
    return { ok: false, message: describeHttpFailure('list the departments in this org', list) };
  }
  const rawList = list.body?.['departments'];
  const existing = (Array.isArray(rawList) ? rawList : [])
    .map(toRecord)
    .find((d): d is DepartmentRecord => d !== null && d.slug === request.slug && !d.retired);

  if (existing === undefined) {
    const created = await cloudRequest(deps, ctx, 'POST', '/api/v1/departments', request);
    if (created.networkError !== undefined) {
      return { ok: false, message: offlineMessage(ctx.server, created.networkError) };
    }
    if (created.status === 409) {
      return {
        ok: false,
        message:
          `A department named '${request.slug}' already exists in ${ctx.orgSlug}.\n` +
          `  It is not visible to serve, which means it was retired. Rename this department in ` +
          `department.yml, or ask an owner to remove the retired one.`,
      };
    }
    if (created.status !== 201) {
      // 402 (a plan ceiling from c8) and 403 (role) both land here and both
      // carry the server's own named message — see `serverError`.
      return { ok: false, message: describeHttpFailure(`register '${request.slug}'`, created) };
    }
    const department = toRecord(created.body?.['department']);
    if (department === null) return { ok: false, message: 'the registration response was malformed' };
    return { ok: true, action: 'created', department };
  }

  if (existing.manifestDigest === request.manifest_digest) {
    return { ok: true, action: 'unchanged', department: existing };
  }

  const patched = await cloudRequest(deps, ctx, 'PATCH', `/api/v1/departments/${existing.id}`, request);
  if (patched.networkError !== undefined) {
    return { ok: false, message: offlineMessage(ctx.server, patched.networkError) };
  }
  if (patched.status === 403) {
    return {
      ok: false,
      message:
        `department.yml changed, but updating '${request.slug}' in ${ctx.orgSlug} needs the admin role ` +
        `(POST /api/v1/departments is member+, PATCH is admin+).\n` +
        `  Ask an org admin to run \`pipeline department serve\`, or serve an unchanged manifest.`,
    };
  }
  if (patched.status !== 200) {
    return { ok: false, message: describeHttpFailure(`update '${request.slug}'`, patched) };
  }
  const department = toRecord(patched.body?.['department']);
  if (department === null) return { ok: false, message: 'the update response was malformed' };
  return { ok: true, action: 'updated', department };
}

/** 05 §5's offline refusal, worded so it cannot read as a broken product:
 *  nothing was registered, and local pipelines are unaffected. Names the API
 *  host that was actually unreachable (`api.ai-pipeline.dev` in the design's
 *  own wording), never the dashboard origin — the user needs to know which
 *  name failed to resolve. */
export function offlineMessage(server: string, detail: string): string {
  let host = server;
  try {
    host = new URL(server).host;
  } catch {
    // Not a parseable URL — print whatever was configured, verbatim.
  }
  return (
    `Could not reach ${host} — nothing was registered. ` +
    `Your local pipelines are unaffected.\n  (${detail})`
  );
}

function describeHttpFailure(what: string, result: JsonResult): string {
  const detail = serverError(result);
  return detail !== undefined ? `could not ${what}: ${detail}` : `could not ${what} (HTTP ${result.status})`;
}

// ---------------------------------------------------------------------------
// Step 6 — the local runtime binding
// ---------------------------------------------------------------------------

/**
 * The adapters `pipeline-runner` actually registers today — its `cli.ts`
 * constructs exactly `JsonlProcessAdapter` (`jsonl-process`),
 * `ContainerAdapter` (`container`) and `PipelineDriveAdapter`
 * (`pipeline-drive`), and `DepartmentManager` resolves an offer by looking
 * `RuntimeConfig.adapterId` up in that registry.
 *
 * The binding STORE would accept any adapter id (b1 validates shape, not
 * existence), so serving an engine with no module would produce a department
 * that registers, binds, and then rejects every task it is offered — the
 * "why isn't my department working" trap this design exists to remove.
 * `serve` therefore refuses BEFORE registering anything, and says which
 * engines this machine can actually run.
 *
 * `claude-code` — `department new`'s own default — is deliberately absent: its
 * engine module is task `b3`, and inventing a command line for it here would
 * be fabricating a contract that task has not written yet (D23 already
 * constrains it to `--mcp-config` + a `headersHelper`, which no `bind` flag
 * can express). One honest refusal beats a half-live department.
 */
export const SERVABLE_ADAPTER_IDS: readonly string[] = ['jsonl-process', 'container', 'pipeline-drive'];

/** The local runtime spec for one department — exactly what `pipeline-runner
 *  bind` will store, and nothing that ever reaches the cloud. */
export interface RuntimeBinding {
  adapterId: string;
  command: string;
  args: string[];
  cwd: string;
  lifecycle?: string;
  /** Nested spec fields no flag can carry (`pipelineDrive`, `container`) —
   *  handed to `bind --spec <json>`, which the flags then layer on top of. */
  spec: Record<string, unknown>;
  /** Non-fatal facts the operator should hear about this binding (e.g. a
   *  manifest field this machine's supervisor cannot honour). */
  warnings: string[];
}

export interface RuntimeBindingOptions {
  /** Absolute path of the folder holding `department.yml` — every relative
   *  path in the manifest resolves against it, and it is the department's
   *  working directory (05 §1: "every arriving task runs a session rooted in
   *  this folder"). */
  manifestDir: string;
  /** Overrides the executable an `engine: pipeline` department runs. Defaults
   *  to `pipeline` on PATH, which is what `pipeline-runner`'s own dispatch
   *  path uses (`dispatch/matcher.ts`'s `pipelineBin`). */
  runtimeCommand?: string;
}

export type RuntimeBindingResult = { ok: true; binding: RuntimeBinding } | { ok: false; message: string };

/**
 * Translate the manifest's LOCAL `runtime:` half into the runner's
 * `RuntimeConfig` shape. Pure — no I/O, no clock — so every engine's mapping
 * is unit-testable without a runner on the machine.
 *
 * `engine:` → `adapterId` goes through a7's registry
 * (`adapterIdForEngine`), which is the single place that translation exists;
 * 06 §2 is explicit that a user never types `adapterId` and no user-facing
 * text may print one.
 */
export function runtimeBindingFor(
  manifest: DepartmentManifest,
  opts: RuntimeBindingOptions,
): RuntimeBindingResult {
  const adapterId = adapterIdForEngine(manifest.runtime.engine);
  if (adapterId === undefined) {
    // Unreachable in `serve` (validate refuses an unknown engine first), kept
    // so this function is total for any caller.
    return { ok: false, message: `unknown engine '${manifest.runtime.engine}'` };
  }
  if (!SERVABLE_ADAPTER_IDS.includes(adapterId)) {
    return {
      ok: false,
      message:
        `no engine module for '${manifest.runtime.engine}' ships in pipeline-runner yet, so this machine could not ` +
        `execute a single task for it.\n  Servable engines today: ${SERVABLE_ENGINES.join(', ')}. ` +
        `A department authored for '${manifest.runtime.engine}' comes online as soon as its engine module ships — ` +
        'no change to department.yml.',
    };
  }

  const warnings: string[] = [];
  const spec: Record<string, unknown> = {};
  let command: string;
  let args: string[] = [];
  let cwd = opts.manifestDir;

  if (adapterId === 'pipeline-drive') {
    // The engine runs `<command> drive --root <pipelineRoot> …`
    // (`pipeline-runner`'s `PipelineDriveAdapter` over `buildDriveArgs`), so
    // `command` is this CLI itself and the pipeline paths ride in the nested
    // `pipelineDrive` spec. `pipelineRoot` is made ABSOLUTE here: the
    // supervisor's working directory is its own, not the department's, so a
    // repo-relative path would resolve somewhere else entirely.
    command = opts.runtimeCommand ?? 'pipeline';
    const pipelineRoot = manifest.runtime.pipelineRoot;
    const startIteration = manifest.runtime.startIteration;
    if (!pipelineRoot) {
      return { ok: false, message: 'engine: pipeline needs runtime.pipelineRoot — there is no pipeline to run' };
    }
    if (!startIteration) {
      return {
        ok: false,
        message:
          'engine: pipeline needs runtime.startIteration (the first iteration file, relative to pipelineRoot) — ' +
          "the supervisor passes it to `pipeline drive --start` and refuses a binding without it",
      };
    }
    spec['pipelineDrive'] = {
      pipelineRoot: resolve(opts.manifestDir, pipelineRoot),
      // Deliberately NOT resolved: `--start` is matched against the plan's own
      // root-relative step paths (`lib/next.ts`'s `selectStep`), so an
      // absolute path here would be an off-plan "synthesized" step.
      startIteration,
    };
  } else {
    // `process` / `container` / any future engine that names its own command.
    const declared = manifest.runtime.command;
    if (!declared) {
      return {
        ok: false,
        message: `engine: ${manifest.runtime.engine} needs runtime.command — the supervisor has nothing to start`,
      };
    }
    command = declared;
    args = manifest.runtime.args ?? [];
    if (manifest.runtime.workingDirectory) cwd = resolve(opts.manifestDir, manifest.runtime.workingDirectory);
    if (manifest.runtime.environment !== undefined) {
      // `narrowRuntimeConfig` (pipeline-runner's `department/config.ts`) has no
      // `env` field, so the binding store cannot carry one — dropping it
      // silently would mean a department whose manifest says `environment:`
      // runs without it and nobody is told.
      warnings.push(
        "runtime.environment is not conveyed by `pipeline-runner bind` — this machine's supervisor will start the " +
          'engine with its own environment. Set the variables where the supervisor service is defined.',
      );
    }
  }

  return {
    ok: true,
    binding: {
      adapterId,
      command,
      args,
      cwd,
      ...(manifest.runtime.lifecycle !== undefined ? { lifecycle: manifest.runtime.lifecycle } : {}),
      spec,
      warnings,
    },
  };
}

/** The exact argv for `pipeline-runner bind`. Pure, and exported so a test can
 *  pin it: this is a cross-package contract (b1's `runBind` parses it), and a
 *  silent drift on either side would surface as a department that registers
 *  and never runs. The secret-free property is structural — nothing in a
 *  binding is a credential. */
export function buildBindArgs(departmentId: string, binding: RuntimeBinding): string[] {
  const args = ['bind', '--department', departmentId, '--adapter', binding.adapterId, '--command', binding.command];
  for (const a of binding.args) args.push('--arg', a);
  args.push('--cwd', binding.cwd);
  if (binding.lifecycle !== undefined) args.push('--lifecycle', binding.lifecycle);
  if (Object.keys(binding.spec).length > 0) args.push('--spec', JSON.stringify(binding.spec));
  return args;
}

export type BindOutcome = { ok: true; detail: string } | { ok: false; message: string };

/**
 * Step 6: hand the binding to `pipeline-runner bind`, which writes its own
 * file-backed store (b1) and signals a RUNNING supervisor to reload it — the
 * reason 05 §5's transcript can end in `● online` instead of "restart the
 * supervisor". This function never touches `departments.json` itself; see
 * rule 1 in the module doc.
 */
export function bindRuntime(deps: ServeDeps, departmentId: string, binding: RuntimeBinding): BindOutcome {
  const r = deps.shell(RUNNER_CLI_BIN, buildBindArgs(departmentId, binding));
  if (r.code !== 0) {
    // 05 §5's step-6 failure row: name the store and the reason. b1's `bind`
    // already prints `could not write the runtime binding: <path> (<reason>)`
    // when the store refuses, so its stderr IS the recovery-bearing text.
    const detail = (r.stderr || r.stdout || `exit ${r.code}`).trim();
    return {
      ok: false,
      message:
        r.code === 127
          ? 'Could not write the runtime binding: `pipeline-runner` is not installed on this machine.'
          : `Could not write the runtime binding: ${detail}`,
    };
  }
  return { ok: true, detail: (r.stdout || '').trim() };
}

// ---------------------------------------------------------------------------
// Step 7 — the supervisor service
// ---------------------------------------------------------------------------

export type SupervisorOutcome =
  | { ok: true; action: 'installed' | 'already-installed' }
  | { ok: false; message: string };

/**
 * Step 7: "one supervisor per machine, shared with cloud pipeline dispatch — a
 * machine already running one gets a binding, not a second service" (05 §5,
 * D26). The already-installed check is `lib/runner-enrol.ts`'s
 * `isRunnerServiceInstalled`, the one place that machine-level fact is
 * established; this function takes the ANSWER rather than re-shelling
 * `service status`, so `serve` asks exactly once per invocation.
 */
export function ensureSupervisor(deps: ServeDeps, alreadyInstalled: boolean): SupervisorOutcome {
  if (alreadyInstalled) return { ok: true, action: 'already-installed' };
  const r = deps.shell(RUNNER_CLI_BIN, ['service', 'install']);
  if (r.code !== 0) {
    return {
      ok: false,
      message: `the supervisor could not be installed: ${(r.stderr || r.stdout || `exit ${r.code}`).trim()}`,
    };
  }
  return { ok: true, action: 'installed' };
}

// ---------------------------------------------------------------------------
// Step 8 — claim the install
// ---------------------------------------------------------------------------

export interface InstallClaim {
  id: string;
  /** True while an admin still has to approve this digest (07 §4's second
   *  transcript). Read from `install.pendingApproval`, NOT from
   *  `auto_approved` — the latter reports whether THIS call activated the
   *  claim and is false on a repeat serve of an already-live department
   *  (`mesh-registry/routes.ts` says so in as many words). */
  pendingApproval: boolean;
  /** The org's approval policy, as the server resolved it. */
  policy?: string;
  /** Whether this call changed anything — false on an idempotent re-serve. */
  changed: boolean;
}

export type ClaimOutcome = { ok: true; claim: InstallClaim } | { ok: false; message: string };

/** Step 8: `POST /api/v1/departments/:id/installs` with this machine's runner
 *  id and the digest it is serving. `member+` (D13/c9), so the operator who
 *  published can also claim. */
export async function claimInstall(
  deps: ServeDeps,
  ctx: CloudContext,
  departmentId: string,
  runnerId: string,
  manifestDigest: string,
): Promise<ClaimOutcome> {
  const res = await cloudRequest(deps, ctx, 'POST', `/api/v1/departments/${departmentId}/installs`, {
    runner_id: runnerId,
    manifest_digest: manifestDigest,
  });
  if (res.networkError !== undefined) {
    return { ok: false, message: `the install could not be claimed: ${res.networkError}` };
  }
  if (res.status !== 200) {
    const detail = serverError(res);
    return {
      ok: false,
      message: `the install could not be claimed${detail !== undefined ? `: ${detail}` : ` (HTTP ${res.status})`}`,
    };
  }
  const install = res.body?.['install'];
  if (typeof install !== 'object' || install === null || Array.isArray(install)) {
    return { ok: false, message: 'the install could not be claimed: the response was malformed' };
  }
  const row = install as Record<string, unknown>;
  const policy = res.body?.['approval_policy'];
  return {
    ok: true,
    claim: {
      id: typeof row['id'] === 'string' ? row['id'] : '',
      pendingApproval: row['pendingApproval'] === true,
      ...(typeof policy === 'string' ? { policy } : {}),
      changed: res.body?.['changed'] === true,
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting vocabulary (step 9)
// ---------------------------------------------------------------------------

/**
 * What `serve` ended up being able to say. The first three are 05 §5/§6's own
 * vocabulary; `not-registered` is the machine-readable form of "we stopped
 * before step 4 succeeded", which the human path renders as an error message
 * rather than a status line.
 *
 * A department that is registered but cannot take work is
 * `registered-not-serving` and says why — never a bare `online`, which is the
 * exact lie 05 §5's closing line forbids.
 */
export type ServeState = 'online' | 'waiting-approval' | 'registered-not-serving' | 'not-registered';

/** The one-line status marker for each state, matching 05 §5's transcript
 *  (`● unity-review — online, ready for work`) and §5's closing rule
 *  (`○ registered — not serving`). */
export function renderState(state: ServeState, slug: string, reason?: string): string {
  switch (state) {
    case 'online':
      return `● ${slug} — online, ready for work`;
    case 'waiting-approval':
      return `⏸ ${slug} — waiting for an admin to approve`;
    case 'registered-not-serving':
      return `○ ${slug} — registered — not serving${reason ? ` (${reason})` : ''}`;
    case 'not-registered':
      return `✗ ${slug} — not registered${reason ? ` (${reason})` : ''}`;
  }
}

/** True when this engine's module exists in the supervisor that would run it
 *  (see `SERVABLE_ADAPTER_IDS`). */
export function engineIsServable(engine: string): boolean {
  const adapterId = engineDefinition(engine)?.adapterId;
  return adapterId !== undefined && SERVABLE_ADAPTER_IDS.includes(adapterId);
}

/** The engine NAMES a user may type today, in registry order — never adapter
 *  ids, which 06 §2 forbids in user-facing text. */
export const SERVABLE_ENGINES: readonly string[] = ENGINES.filter((e) =>
  SERVABLE_ADAPTER_IDS.includes(e.adapterId),
).map((e) => e.engine);
