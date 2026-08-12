// executors/sdk.ts — the `standalone` mode's ExecutorRunner, over the Agent SDK
// (c3, 02-standalone-executor.md E6).
//
// THIS IS A SECOND IMPLEMENTATION OF AN EXISTING SEAM, NOT A NEW SUBSYSTEM.
// `ExecutorRunner` is already declared, already injectable, and already has a
// production implementation driving `claude -p` (`commands/drive.ts`'s
// `subprocessExecutor`). Everything below fills in that same type; the
// interface is not changed, extended, or re-declared here. `drive` keeps its
// recovery ladder, its record contract and its progress reporting exactly as
// they are — only the thing that produces an `ExecutorExit` differs.
//
// ── WHY THE SDK IS NOT A STATIC IMPORT ────────────────────────────────────
//
// `@baizor/pipeline` ships with ZERO runtime dependencies and no install
// step, and `@anthropic-ai/claude-agent-sdk` is not a small addition to that:
// measured at 0.3.228, the package itself is 4.3 MB but it declares three
// REQUIRED peer dependencies (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`,
// `zod`) and eight per-platform optional dependencies that are the Claude Code
// binary itself — the win32-x64 one alone is 283 MB, and a real install came
// to 101 packages and ~315 MB. Making every user of this CLI pay that so that
// the minority who select `standalone` can avoid one install command is the
// wrong trade, so:
//
//   1. the dependency is declared as an OPTIONAL PEER (`peerDependencies` +
//      `peerDependenciesMeta.optional`), the one form neither npm nor bun
//      auto-installs — `optionalDependencies` would NOT achieve this, since
//      "optional" there means "tolerate an install failure", not "skip";
//   2. it is loaded through a RUNTIME import the bundler cannot see (see
//      {@link loadSdkQuery}), so `bun build`'s static graph never reaches it
//      and `dist/cli.mjs` does not try to inline a 283 MB binary;
//   3. {@link SdkExecutorOptions.query} makes the whole SDK injectable, so
//      this module's tests — and any other executor conformance test — run
//      with the SDK absent. `bun test` needs nothing installed.
//
// The types below are therefore a deliberate STRUCTURAL SUBSET of the SDK's
// own, declared locally rather than imported, so that this file typechecks in
// a checkout where the optional peer was never installed. They were verified
// field-by-field against {@link VERIFIED_SDK_VERSION}; `tests/sdk-executor.test.ts`
// re-checks them against the real package whenever it IS present and skips
// when it is not, which is the drift tripwire.
//
// ── THE KEY DOES NOT LIVE HERE, AND THAT IS DELIBERATE ────────────────────
//
// `standalone` needs an Anthropic API key, and c1's ladder resolves one. This
// module nonetheless does NOT import that module, does not name its
// environment variable, and never touches its reveal boundary — the tripwire
// in `tests/provider-key-ownership.test.ts` stays as narrow as c1 left it.
//
// Instead {@link SdkExecutorOptions.env} is an OPAQUE environment overlay
// handed to the SDK. The caller that selects this executor is the one that
// resolves a key and builds that overlay, so the plaintext exists in exactly
// one place — the selection site — and this runner passes an already-sealed
// map through without ever knowing which entry is a credential. That keeps the
// "exactly one module holds the key" property true for a runner that
// nevertheless gets the key where it needs to go, and it puts the decision to
// widen c1's allowlist in the commit that actually needs it rather than this
// one.
//
// ── OUTPUT ────────────────────────────────────────────────────────────────
//
// Nothing here writes to a stream or a file. The only output route is the
// caller's injected `err` sink — `drive` wraps that with c2's `scrubWriter`
// before it ever reaches us — and the SDK's own stderr is relayed through
// `scrubbedRelay`, exactly as `subprocessExecutor` relays a child's stderr, so
// a secret split across two chunk boundaries cannot slip between them.

import { dirname } from 'node:path';
import { ClaudeStreamParser, type StreamToolCall } from '../stream-json';
import { scrubbedRelay } from '../output-scrubber';
import type { ExecutorExit, ExecutorRequest, ExecutorRunner } from '../../commands/drive';

// ---------------------------------------------------------------------------
// The SDK surface we depend on — a verified structural subset
// ---------------------------------------------------------------------------

/** The module specifier, kept as a value so {@link loadSdkQuery} can import it
 *  without a literal the bundler would follow. */
export const SDK_MODULE_ID = '@anthropic-ai/claude-agent-sdk';

/** The SDK release every type and every field mapping below was checked
 *  against. That release bundles Claude Code 2.1.228 (its `claudeCodeVersion`
 *  field), which is NOT necessarily the `claude` on the user's PATH — 02's K-2
 *  warns that model-alias resolution moves with the binary, so a conformance
 *  run comparing `driver` against `standalone` must pin full model IDs rather
 *  than aliases. */
export const VERIFIED_SDK_VERSION = '0.3.228';

/** `SettingSource` — the filesystem settings tiers. Verified: the SDK's own
 *  union is exactly these three. */
export type SdkSettingSource = 'user' | 'project' | 'local';

/** `PermissionMode`. Verified against the SDK's union; `ExecutorRequest`
 *  carries a free `string | null`, so {@link asPermissionMode} narrows. */
export const SDK_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const;
export type SdkPermissionMode = (typeof SDK_PERMISSION_MODES)[number];

/** `EffortLevel`. NOTE the asymmetry, which is real and easy to trip over: an
 *  `AgentDefinition.effort` also accepts a number, but `Options.effort` — the
 *  one this runner sets — is the named union ALONE. */
export const SDK_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type SdkEffortLevel = (typeof SDK_EFFORT_LEVELS)[number];

/** `SdkPluginConfig`. Plugins load through this option; there is no
 *  auto-discovery to rely on (02 K-3). */
export interface SdkPluginConfig {
  type: 'local';
  path: string;
  skipMcpDiscovery?: boolean;
}

/** `JsonSchemaOutputFormat` — the SDK's `OutputFormat` union has exactly this
 *  one member, and it is what produces `structured_output`. */
export interface SdkJsonSchemaOutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
}

/** The slice of `Options` this runner sets. Every key was verified to exist on
 *  the real type at {@link VERIFIED_SDK_VERSION}. */
export interface SdkOptions {
  model?: string;
  effort?: SdkEffortLevel;
  permissionMode?: SdkPermissionMode;
  /** Fresh spawn. The SDK forbids pairing this with `resume` unless
   *  `forkSession` is set, so the two are mutually exclusive below. */
  sessionId?: string;
  /** Answer delivery — the same session continues. */
  resume?: string;
  additionalDirectories?: string[];
  allowedTools?: string[];
  settingSources?: SdkSettingSource[];
  plugins?: SdkPluginConfig[];
  /** The main-thread agent — the SDK's equivalent of `claude -p --agent`. */
  agent?: string;
  outputFormat?: SdkJsonSchemaOutputFormat;
  cwd?: string;
  env?: Record<string, string>;
  maxTurns?: number;
  stderr?: (data: string) => void;
  abortController?: AbortController;
}

/** One streamed message. Typed as an open record because this runner
 *  DISCRIMINATES rather than destructures — `lib/stream-json.ts` owns the
 *  `(type, subtype)` rules for both executors and tolerates anything. */
export type SdkMessage = Record<string, unknown>;

/** `query()`. The real signature also accepts an async-iterable prompt; this
 *  runner only ever sends one string, which is what `ExecutorRequest.prompt`
 *  is. The returned `Query` is an `AsyncGenerator<SDKMessage, void>` with
 *  extra control methods we do not use, and it is assignable to this. */
export type SdkQuery = (params: { prompt: string; options?: SdkOptions }) => AsyncIterable<SdkMessage>;

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/**
 * `ExecutorExit.code` values this runner produces.
 *
 * There is no subprocess here, so these are OUR codes, not a child's — but
 * they occupy the same field for the same reason `drive` reads it: as
 * diagnostic detail in `noRecordReason` when no channel produced a record.
 * `drive`'s recovery ladder does NOT gate on the code, which is what makes it
 * safe to report a non-zero code and still expect the lower rungs to run.
 *
 * `null` stays reserved for its documented meaning — "the process could not be
 * spawned" — which here is "the SDK could not be loaded or `query()` threw".
 */
export const SDK_EXIT = {
  /** A `success` result carrying a usable `structured_output` object. */
  ok: 0,
  /** The stream ended with no terminal `result` at all (aborted mid-turn).
   *  Not an error by itself — the CLI runner's SIGTERM case behaves the same. */
  noResult: 1,
  /** A `result` frame reporting failure (`is_error`, or an `error_*` subtype
   *  such as `error_max_structured_output_retries`). */
  resultError: 2,
  /** Subtype `success`, but no usable `structured_output`. See
   *  {@link sdkExecutor} — this is a FAILURE, deliberately. */
  noStructuredOutput: 3,
} as const;

// ---------------------------------------------------------------------------
// Narrowing — `ExecutorRequest` carries strings, the SDK carries unions
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Narrow a configured effort onto the SDK's union. An unrecognised value is
 *  DROPPED (inherit the default) rather than forwarded: the CLI executor can
 *  hand `--effort whatever` to claude and let it complain, but the SDK would
 *  reject the whole call, turning a bad config value into a dead run. */
export function asEffortLevel(v: string | null | undefined): SdkEffortLevel | undefined {
  return typeof v === 'string' && (SDK_EFFORT_LEVELS as readonly string[]).includes(v)
    ? (v as SdkEffortLevel)
    : undefined;
}

/** Narrow a resolved permission mode onto the SDK's union; unrecognised values
 *  are dropped for the same reason as {@link asEffortLevel} (null already
 *  means "inherit machine settings" on `ExecutorRequest`). */
export function asPermissionMode(v: string | null | undefined): SdkPermissionMode | undefined {
  return typeof v === 'string' && (SDK_PERMISSION_MODES as readonly string[]).includes(v)
    ? (v as SdkPermissionMode)
    : undefined;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The Agent tool, which MUST be allowed or intra-step helpers cannot exist
 * (02 K-3). A step-executor that cannot spawn a helper is a different product
 * from the one the other three modes run, so this is unconditional: callers
 * ADD to it and cannot remove it.
 */
export const REQUIRED_TOOLS: readonly string[] = ['Agent'];

export interface SdkExecutorOptions {
  /**
   * The already-scrubbed stderr sink — `drive`'s `err`. Receives the SDK's own
   * stderr and this runner's warnings. Absent = discard.
   */
  err?: (s: string) => void;
  /** Per-tool-call progress, the same hook `subprocessExecutor` takes. */
  onToolCall?: (req: ExecutorRequest, call: StreamToolCall) => void;
  /**
   * The step-record JSON Schema, as an OBJECT (the CLI executor passes the
   * same schema as a compact string because a command template is
   * whitespace-split; that constraint does not exist here). Absent ⇒ no
   * `outputFormat`, so no `structured_output` — and every result then falls
   * to the retained fallback rung.
   */
  schema?: Record<string, unknown> | null;
  /**
   * E9 — configuration is set BY LOCATION and this is where that is chosen.
   *
   * Leave it UNSET locally: the key is then omitted from the SDK options
   * entirely, the SDK loads all three tiers as the CLI does, and the user
   * keeps their own agents, skills, MCP servers and memory. Taking that away
   * from someone running on their own machine removes control they already
   * have.
   *
   * The hosted runner pins `['project']` instead — its own task. This runner
   * only guarantees the setting is REACHABLE and that the default is
   * "omitted"; it hardcodes neither.
   */
  settingSources?: SdkSettingSource[];
  /** The main-thread agent, e.g. the plugin's step-executor. */
  agent?: string | null;
  /**
   * The permission mode to use when the REQUEST does not carry one (c4).
   *
   * `ExecutorRequest.permission_mode` is the step path's channel and it wins
   * whenever it narrows. The fallback exists for the seams whose CLI template
   * hardcodes the flag instead of spelling `{permissions}` — the improver and
   * the script-creator both pass `--permission-mode acceptEdits` literally and
   * build their request with `permission_mode: null`. Without this, that
   * hardcoded flag would have no SDK-side equivalent and those sessions would
   * silently run under the SDK's default mode.
   *
   * Absent ⇒ unchanged c3 behaviour: a null/unrecognised request value leaves
   * the key off entirely and the SDK inherits machine settings.
   */
  permissionMode?: SdkPermissionMode;
  /** Plugins to load. There is no auto-discovery — 02 K-3. */
  plugins?: SdkPluginConfig[];
  /** Tools to allow IN ADDITION TO {@link REQUIRED_TOOLS}. */
  allowedTools?: string[];
  /** Directories to grant beyond the record drop dir. */
  additionalDirectories?: string[];
  cwd?: string;
  /**
   * An opaque environment overlay for the SDK process. This is the seam a
   * provider credential travels through — see this file's header for why the
   * key is resolved by the CALLER and never by this module.
   */
  env?: Record<string, string>;
  maxTurns?: number;
  abortController?: AbortController;
  /** Injected SDK entry point. Absent ⇒ {@link loadSdkQuery}. */
  query?: SdkQuery;
}

/**
 * Map one {@link ExecutorRequest} onto SDK `Options`.
 *
 * Exported because it is the honest unit of test for "every field is
 * honoured": asserting the option object is a direct check, where asserting
 * behaviour through a fake `query` would only prove the fake was called.
 *
 * Two mappings are worth reading twice:
 *
 *   - **session.** `sessionId` and `resume` are MUTUALLY EXCLUSIVE — the SDK
 *     rejects both together unless `forkSession` is also set, and forking is
 *     precisely what an answer delivery must not do. So a fresh spawn sets
 *     `sessionId` and a resume sets `resume`, mirroring the CLI template's
 *     `--session-id` → `--resume` swap.
 *   - **the record grant.** `additionalDirectories` carries the drop
 *     directory, which is what `--add-dir` buys the CLI executor: under
 *     headless `acceptEdits` a write under `.claude/` is auto-denied and no
 *     allow rule overrides it, while a granted tmp directory stays writable.
 *     Like `drive`, the grant is for STEP spawns only — the improver and
 *     script-creator record files are `drive`'s own writes.
 */
export function buildSdkOptions(req: ExecutorRequest, opts: SdkExecutorOptions = {}): SdkOptions {
  const options: SdkOptions = {};

  if (req.model !== null) options.model = req.model;

  const effort = asEffortLevel(req.effort);
  if (effort !== undefined) options.effort = effort;

  // The request wins where it narrows; the caller's fallback covers the seams
  // whose template hardcoded the flag (see SdkExecutorOptions.permissionMode).
  const permissionMode = asPermissionMode(req.permission_mode) ?? opts.permissionMode;
  if (permissionMode !== undefined) options.permissionMode = permissionMode;

  if (req.session.resume) options.resume = req.session.id;
  else options.sessionId = req.session.id;

  const grants = [...(opts.additionalDirectories ?? [])];
  if ((req.kind ?? 'step') === 'step' && req.record_file) {
    const dir = dirname(req.record_file);
    if (!grants.includes(dir)) grants.unshift(dir);
  }
  if (grants.length > 0) options.additionalDirectories = grants;

  // The Agent tool first, then the caller's additions, de-duplicated.
  const tools = [...REQUIRED_TOOLS];
  for (const t of opts.allowedTools ?? []) if (!tools.includes(t)) tools.push(t);
  options.allowedTools = tools;

  if (opts.schema) options.outputFormat = { type: 'json_schema', schema: opts.schema };

  // E9: ABSENT means absent. Never `settingSources: undefined` — the key must
  // not appear at all, so the SDK applies its own "load every tier" default.
  if (opts.settingSources !== undefined) options.settingSources = [...opts.settingSources];

  if (opts.agent) options.agent = opts.agent;
  if (opts.plugins && opts.plugins.length > 0) options.plugins = [...opts.plugins];
  if (opts.cwd) options.cwd = opts.cwd;
  if (opts.env) options.env = { ...opts.env };
  if (opts.maxTurns !== undefined) options.maxTurns = opts.maxTurns;
  if (opts.abortController) options.abortController = opts.abortController;

  return options;
}

// ---------------------------------------------------------------------------
// Loading the SDK
// ---------------------------------------------------------------------------

/**
 * Import the SDK AT RUNTIME, through a specifier the bundler cannot resolve.
 *
 * The indirection is the point: `import('@anthropic-ai/claude-agent-sdk')`
 * with a literal is a static edge that `bun build` would follow into a 283 MB
 * platform package. Reading the specifier out of a value defeats that, so the
 * bundle keeps a real runtime `import()` and the dependency stays optional in
 * fact as well as in `package.json`.
 *
 * A missing package is reported as a MISSING INSTALL, not as a stack trace —
 * it is the expected state for every user who never selects this mode.
 */
export async function loadSdkQuery(): Promise<SdkQuery> {
  const specifier: string = SDK_MODULE_ID;
  let mod: unknown;
  try {
    mod = (await import(/* @vite-ignore */ specifier)) as unknown;
  } catch {
    throw new Error(
      `the ${SDK_MODULE_ID} package is not installed — the 'standalone' executor needs it. ` +
        `Install it with \`bun add ${SDK_MODULE_ID}\`. It is an OPTIONAL peer dependency, so ` +
        'the other execution modes never download it.',
    );
  }
  const q = isRecord(mod) ? mod.query : undefined;
  if (typeof q !== 'function') {
    throw new Error(`${SDK_MODULE_ID} loaded but exports no query() — expected version ${VERIFIED_SDK_VERSION} or compatible`);
  }
  return q as SdkQuery;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The `standalone` {@link ExecutorRunner}: run ONE step through the Agent SDK
 * and resolve when its stream ends. Never throws — every failure resolves as
 * an `ExecutorExit`, exactly as `subprocessExecutor` does, because `drive`'s
 * ladder is what decides whether a run can continue.
 *
 * ── WHY `stream` IS POPULATED AND `stdout` IS NOT ─────────────────────────
 *
 * `envelopeOf` prefers `exit.stream` and only replays `exit.stdout` when there
 * is none. The SDK hands us discriminated frames, so re-serialising them into
 * a fake stdout just to have it parsed back would be strictly worse: the
 * summary here is built from the SAME parser, live, one frame at a time, so
 * tool calls, subagent depth and the frame tallies are first-class instead of
 * reconstructed. `stdout` is therefore deliberately left absent — there is no
 * captured text, and inventing some would only create a second, lower-fidelity
 * source of truth for the same facts.
 *
 * ── THE LADDER NARROWS BUT DOES NOT COLLAPSE ──────────────────────────────
 *
 * The SDK returns the record directly, which makes the CLI path's tmp-drop and
 * legacy-file rungs unnecessary in the happy case — but NOT removable. A
 * result can end with subtype `success` and carry no `structured_output` at
 * all, and the SDK has a dedicated `error_max_structured_output_retries`
 * subtype for the case where it kept failing validation. Both are treated here
 * as FAILURES ({@link SDK_EXIT.noStructuredOutput} / `resultError`) rather than
 * as an empty success — and, critically, the envelope is still returned intact
 * so `drive`'s remaining rungs (the record file the step wrote into the granted
 * drop directory, then the final-response text) still run. Reporting a
 * non-zero code does not skip them: the ladder reads the code only when every
 * channel has already failed, to explain why.
 */
export function sdkExecutor(opts: SdkExecutorOptions = {}): ExecutorRunner {
  return async (req: ExecutorRequest): Promise<ExecutorExit> => {
    const err = opts.err ?? ((): void => {});
    // Chunk reassembly on top of redaction — the same pairing `drive` applies
    // to a child's stderr, for the same reason: the SDK decides where one
    // stderr chunk ends, so a secret can straddle the seam and match neither
    // half. Flushed on EVERY terminal path below; an unflushed carry is lost
    // output.
    const relay = scrubbedRelay(err);
    const parser = new ClaudeStreamParser({
      onToolCall: (call) => opts.onToolCall?.(req, call),
      onNonJson: (line) => err(line + '\n'),
    });

    let query: SdkQuery;
    try {
      query = opts.query ?? (await loadSdkQuery());
    } catch (e) {
      relay.flush();
      return { code: null, error: errorText(e) };
    }

    const options = buildSdkOptions(req, opts);
    options.stderr = (data: string) => relay(String(data));

    let sawResult = false;
    try {
      for await (const message of query({ prompt: req.prompt, options })) {
        if (!isRecord(message)) continue;
        // ONE parser for both executors — it owns the (type, subtype) rules,
        // the subagent-depth walk and the tallies, and it tolerates every
        // frame shape the union grows.
        parser.pushFrame(message);
        if (message.type === 'result') sawResult = true;
      }
    } catch (e) {
      // A stream that dies mid-flight still has everything it managed to
      // parse, and that partial summary is worth more to the ladder than
      // nothing — a step that ran for ten minutes and then lost its transport
      // still names the tool calls it made.
      parser.end();
      relay.flush();
      return { code: null, error: errorText(e), stream: parser.summary() };
    }

    parser.end();
    relay.flush();
    const stream = parser.summary();
    const envelope = stream.envelope;

    if (!sawResult || envelope === null) {
      return { code: SDK_EXIT.noResult, error: 'the SDK stream ended with no terminal result frame', stream };
    }
    if (envelope.is_error || (envelope.subtype !== null && envelope.subtype !== 'success')) {
      return {
        code: SDK_EXIT.resultError,
        error: `the SDK reported ${envelope.subtype ?? 'an error'}`,
        stream,
      };
    }
    if (envelope.structured_output === null) {
      // Subtype `success`, nothing structured. NOT a success: treating it as
      // one would hand `drive` an empty record and skip the channels that
      // still hold the real one.
      return {
        code: SDK_EXIT.noStructuredOutput,
        error: 'the SDK reported success but returned no structured output',
        stream,
      };
    }
    return { code: SDK_EXIT.ok, stream };
  };
}
