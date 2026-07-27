// department-manifest.ts — `department.yml`: the schema, the advertised/local
// split, and the digest. (simplified-onboarding design, task a7; refs 05 §2, 06 §2.)
//
// A department is a project folder whose only required file is `department.yml`
// (D8). This module is the parser and canonicalizer every other department
// command builds on — `department new` (a8) writes the shape defined here,
// `department validate` (a8) renders the findings produced here, and
// `department serve` (a9) publishes exactly `buildRegistrationRequest()`'s
// output and nothing else.
//
// ── The load-bearing security boundary ──────────────────────────────────────
//
// A manifest is PUBLISHED to the cloud and then drives what a runner EXECUTES
// on the operator's machine. Those are two different audiences, so the file has
// two halves:
//
//   ADVERTISED — what the cloud may store: identity, the skills callers choose
//     from, the capabilities a scheduler must honour, and the plan-relevant
//     limits. `advertisedManifest()` builds it by ALLOW-LIST: a field reaches
//     the cloud because it is named here, never because it merely failed to be
//     named somewhere else. A field added to `department.yml` in a later
//     version is local until someone deliberately adds it to that projection.
//
//   LOCAL — everything the machine needs and the cloud must never learn: the
//     engine, the command line, its arguments, its working directory, its
//     environment, and the pipeline paths. `runtime:` is local IN FULL — the
//     cloud is told what the department CAN DO (`communication`), never HOW it
//     is implemented.
//
// The API already rejects `command` / `args` / `workingDirectory` /
// `environment` / `workspace.path` with a 400
// (`cloud/apps/api/src/modules/mesh-registry/manifest.ts:44-45,117-126`). We do
// not rely on that. `assertNoLocalFields()` re-checks the built request against
// a deny-list of key NAMES at any depth, so a future edit that widens the
// allow-list by accident fails a local unit test instead of shipping a request
// that only a server-side 400 stands between and disclosure. Belt and braces:
// the allow-list is the guarantee, the deny-list is the alarm.
//
// ── The digest ──────────────────────────────────────────────────────────────
//
// `sha256:<hex>` over the canonicalized ADVERTISED subset, so the digest an
// admin approves attests to exactly the bytes the cloud was sent — nothing
// more, nothing less. It must be stable across key order, quoting, comments and
// whitespace, because a digest change re-arms install approval (07 §6) and a
// re-approval prompted by a reformat teaches operators to click through them.
//
// ⚠ Changing `canonicalizeAdvertised()` or the DEFAULTS resolved in
// `parseDepartmentManifest()` changes every existing department's digest and
// therefore re-arms approval for every install in every org at once,
// indistinguishably from an operator edit. That is precisely the failure
// `apiVersion` exists to make distinguishable (D22): such a change MUST come
// with a new `apiVersion` value.
//
// ── `apiVersion` ────────────────────────────────────────────────────────────
//
// Optional, defaulting to `department.ai-pipeline.dev/v1` so hand-written files
// keep working; EXCLUDED from the digest so adding it re-arms nothing; an
// unrecognized value is an ERROR (we cannot honour a schema we do not know);
// and unknown keys are a WARNING, never an error, so a file written by a newer
// CLI stays readable by an older one. All four rules are D22.
//
// ── What this module is NOT ─────────────────────────────────────────────────
//
// Only the Schema and Version check classes of 05 §4. Coherence (does the
// engine support the declared capabilities), Engine installation, Advisory, and
// Local path existence need the machine and belong to `department validate`
// (a8) — they are I/O or policy, and this file stays pure so every rule in it
// is exhaustively unit-testable. `readDepartmentManifest()` is the one function
// that touches the filesystem, and it does nothing but read bytes.

import { readFileSync as fsReadFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The file, at the project root. Owner decision 2026-07-25 (D8). */
export const DEPARTMENT_MANIFEST_FILENAME = 'department.yml';

/** The only `apiVersion` this CLI understands. */
export const DEPARTMENT_API_VERSION_V1 = 'department.ai-pipeline.dev/v1';

/** Every recognized `apiVersion`, newest last. Named in the error message for
 *  an unrecognized value so the user learns what this CLI can read. */
export const SUPPORTED_API_VERSIONS: readonly string[] = [DEPARTMENT_API_VERSION_V1];

/** Wire framing for the digest — `sha256:` + 64 hex = 71 chars, comfortably
 *  under the cloud's 200-char `manifest_digest` cap. Mirrors the framing
 *  `lib/run-identity.ts` already uses for `pipeline_version`. */
export const DIGEST_PREFIX = 'sha256:';

/** Caps mirrored from the server's own validator so a bad field is a local
 *  `validate` finding with a readable message instead of a 400 at `serve`
 *  time (`mesh-registry/manifest.ts:29-38`). */
const MAX_SLUG_LEN = 60;
const MAX_NAME_LEN = 200;
const MAX_DESCRIPTION_LEN = 4000;
const MAX_VERSION_LEN = 50;
const MAX_SKILLS = 64;
const MAX_SKILL_ID_LEN = 200;
const MAX_LABEL_LEN = 100;
const MAX_STRING_LEN = 200;
/** Local-only strings (a command line, an argv entry, a path) are never sent
 *  anywhere, so their cap exists only to keep a runaway file readable. */
const MAX_LOCAL_STRING_LEN = 2000;

/** The department slug: the cloud lowercases and re-validates it identically. */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** The manifest duration grammar, byte-identical to the runner's one parser
 *  (`pipeline-runner/src/core/duration.ts`): `Nd`/`Nh`/`Nm`/`Ns`, or a bare
 *  non-negative integer meaning seconds. Validated here so `parkExpiry: "a
 *  week"` is caught while the operator is still looking at the file, rather
 *  than silently becoming `null` inside a supervisor days later. */
const DURATION_RE = /^(?:\d+[dhms]|\d+)$/;

/** Skill defaults (05 §2's full reference). */
const DEFAULT_INPUT_MODES: readonly string[] = ['text/plain'];
const DEFAULT_OUTPUT_MODES: readonly string[] = ['text/markdown'];

// ---------------------------------------------------------------------------
// Engines (06 §2) — `engine:` is the user-facing name for `adapterId`
// ---------------------------------------------------------------------------

/** The four capabilities an engine may declare (06 §3). They are the ONLY
 *  runtime-derived facts the cloud is told, because a scheduler cannot honour
 *  what it is not told — but it never needs to know which engine produced
 *  them. */
export interface EngineCapabilities {
  acceptsMidTaskInput: boolean;
  supportsCancellation: boolean;
  supportsStreaming: boolean;
  supportsCheckpoint: boolean;
}

export interface EngineDefinition {
  /** The word a user types in `runtime.engine`. */
  engine: string;
  /** The internal `RuntimeConfig.adapterId` the supervisor resolves against
   *  (`pipeline-runner/src/cli.ts:546-550`). NEVER shown to a user — 06 §2:
   *  "a user never types `adapterId`, and no user-facing text … should use
   *  one". The CLI performs the translation at this boundary and nowhere else. */
  adapterId: string;
  /** What this engine can honour, or `null` when the answer is negotiated at
   *  runtime by the engine's own child process and therefore unknowable while
   *  authoring. `null` means we default NOTHING and advertise NOTHING: silence
   *  makes the cloud offer no capability, whereas an invented `true` would have
   *  it offer mid-task input to a process that never negotiated for it. Under-
   *  advertising degrades; over-advertising hangs a task. */
  capabilities: EngineCapabilities | null;
  /**
   * The lifecycles this engine can actually run, or `null` when it can run any
   * of them. A restriction here is a COHERENCE rule (05 §4), enforced by
   * `department validate` (a8) and therefore by `serve` (a9), which runs
   * validate in full before it registers anything.
   *
   * ⚠ This is not redundant with the cloud's own coherence check — it is the
   * ONLY place the rule can still fire. `validateManifestCoherence()`
   * (`mesh-registry/manifest.ts`) keys every one of its rules off
   * `runtime.adapter`, and `advertisedManifest()` above never sends `runtime`
   * at all (a7's allow-list — the whole `runtime:` block is local). The server
   * therefore sees `adapter: undefined`, returns `[]`, and its
   * `pipeline-drive` restrictions are structurally unreachable. Keeping the
   * equivalent rule HERE — locally, and earlier — is what stops a manifest the
   * cloud would have rejected from being published, bound, and only then
   * failing at task time.
   */
  supportedLifecycles: readonly DepartmentLifecycle[] | null;
  /** True when this engine legitimately carries the LOCAL-ONLY exec fields
   *  (`command`, `args`, `workingDirectory`, `environment`). Informational for
   *  a8's validate — the advertised projection is an allow-list either way. */
  takesLocalExecFields: boolean;
}

/**
 * The engine registry (06 §2's table). Adding an engine is one row here plus a
 * module in the runner — no change to `department.yml`'s shape, the CLI's
 * commands, the wire protocol, or any existing department.
 *
 * `claude-code`'s capabilities are 06 §3's table. `pipeline` advertises no
 * streaming and no mid-task input because `pipeline-drive` has no stdin and
 * buffers stdout until close (07-runtime-contract §2.1) — the cloud enforces
 * exactly that coherence rule server-side, so any other default here would
 * produce a 400 on a manifest the user never mistyped.
 */
export const ENGINES: readonly EngineDefinition[] = [
  {
    engine: 'claude-code',
    adapterId: 'claude-code',
    capabilities: {
      acceptsMidTaskInput: true,
      supportsCancellation: true,
      supportsStreaming: true,
      supportsCheckpoint: false,
    },
    supportedLifecycles: null,
    takesLocalExecFields: false,
  },
  {
    engine: 'pipeline',
    adapterId: 'pipeline-drive',
    capabilities: {
      acceptsMidTaskInput: false,
      supportsCancellation: true,
      // 06 §3 calls streaming "partial" for `pipeline`; the wire has no third
      // value and 07 §2.1 says stdout is buffered until close, so the honest
      // advertisement is `false`.
      supportsStreaming: false,
      supportsCheckpoint: false,
    },
    // 07-runtime-contract §2.1: `pipeline drive` exits after every invocation
    // and holds nothing between them, so it can only ever be `per-task`. The
    // cloud says the same thing (`manifest.ts`'s `validateManifestCoherence`)
    // and can no longer enforce it — see `supportedLifecycles`' doc.
    supportedLifecycles: ['per-task'],
    takesLocalExecFields: false,
  },
  {
    engine: 'process',
    adapterId: 'jsonl-process',
    // Negotiated: `jsonl-process` learns the child's capabilities from its
    // `initialize` frame at task start. Nothing to default at authoring time.
    capabilities: null,
    supportedLifecycles: null,
    takesLocalExecFields: true,
  },
  {
    engine: 'container',
    adapterId: 'container',
    capabilities: null,
    supportedLifecycles: null,
    takesLocalExecFields: true,
  },
];

/** Every engine name, in registry order — the list `validate`'s
 *  unsupported-engine error names in full (06 §1: name every engine that
 *  exists, not just one). */
export const SUPPORTED_ENGINES: readonly string[] = ENGINES.map((e) => e.engine);

export function engineDefinition(engine: string): EngineDefinition | undefined {
  return ENGINES.find((e) => e.engine === engine);
}

/** `engine:` → `adapterId`, the one place the translation happens.
 *  `undefined` for an unknown engine (already reported as a parse error). */
export function adapterIdForEngine(engine: string): string | undefined {
  return engineDefinition(engine)?.adapterId;
}

// ---------------------------------------------------------------------------
// The parsed manifest (both halves)
// ---------------------------------------------------------------------------

export type DepartmentVisibility = 'organization' | 'private';
export type DepartmentLifecycle = 'per-task' | 'per-context' | 'daemon';
export type DepartmentIsolation = 'process' | 'container';
/** `none` is the DEFAULT and means "no affinity constraint". The cloud's
 *  scheduling enum has only `preferred` | `required`
 *  (`mesh-registry/manifest.ts:201`), so `none` is expressed on the wire by
 *  ABSENCE — see `advertisedManifest()`. */
export type DepartmentContextAffinity = 'none' | 'preferred' | 'required';

export interface DepartmentSkill {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
}

/** The LOCAL half in full. Not one field of this object is ever sent. */
export interface DepartmentRuntime {
  engine: string;
  lifecycle: DepartmentLifecycle;
  startupTimeoutSeconds?: number;
  gracefulShutdownSeconds?: number;
  /** `engine: process | container` only — the executed command line. LOCAL. */
  command?: string;
  args?: string[];
  workingDirectory?: string;
  environment?: { allow?: string[]; values?: Record<string, string> };
  /** `engine: pipeline` only — filesystem paths into the operator's project. LOCAL. */
  pipelineRoot?: string;
  startIteration?: string;
}

export interface DepartmentScheduling {
  requiredLabels: string[];
  requiredIsolation?: DepartmentIsolation;
  maxConcurrency?: number;
  contextAffinity: DepartmentContextAffinity;
}

export interface DepartmentLimits {
  taskTimeout?: string;
  parkExpiry?: string;
  maxArtifactBytes?: number;
}

export interface DepartmentRetention {
  cloudMessages?: string;
  artifacts?: string;
}

/**
 * A parsed `department.yml` with every default resolved. Defaults are resolved
 * HERE rather than at request-build time so that the digest, the request, and
 * the local binding all derive from one settled object — a default applied in
 * two places is a digest that disagrees with what was published.
 */
export interface DepartmentManifest {
  /** Always populated (defaulted to v1 when absent). Never advertised, never
   *  in the digest. */
  apiVersion: string;
  /** The slug. Becomes `slug` on the wire — NOT `name`. */
  name: string;
  /** Defaults to `name`. Becomes `name` on the wire. */
  displayName: string;
  description: string;
  version?: string;
  visibility: DepartmentVisibility;
  skills: DepartmentSkill[];
  runtime: DepartmentRuntime;
  /** Resolved from the author's `communication:` block over the engine's
   *  declared capabilities. Empty for an engine whose capabilities are
   *  negotiated and whose author declared none. */
  communication: Partial<EngineCapabilities>;
  scheduling: DepartmentScheduling;
  limits: DepartmentLimits;
  retention: DepartmentRetention;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type FindingSeverity = 'error' | 'warning';

export interface ManifestFinding {
  severity: FindingSeverity;
  /** Dotted path of the offending field (`skills[1].description`), or `$` for
   *  the document itself. What `validate` prints in its left column. */
  field: string;
  message: string;
}

export interface ParseResult {
  /**
   * `null` ONLY when the document is not a YAML mapping at all — unparseable,
   * empty, a bare scalar, or a multi-document stream. That is 05 §4's exit-2
   * class ("file missing or unparseable"); every other problem yields a
   * best-effort manifest plus findings, so `validate` can report ALL of them in
   * one pass instead of one-error-at-a-time.
   */
  manifest: DepartmentManifest | null;
  findings: ManifestFinding[];
}

export function hasErrors(findings: readonly ManifestFinding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

/** A programming error or an unreadable file — never a user's schema mistake
 *  (those are findings). Thrown by `assertNoLocalFields` and by
 *  `readDepartmentManifest` when the bytes cannot be read. */
export class DepartmentManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DepartmentManifestError';
  }
}

// ---------------------------------------------------------------------------
// YAML seam
// ---------------------------------------------------------------------------

export type YamlParser = (text: string) => unknown;

/**
 * The default parser: Bun's built-in YAML.
 *
 * Deliberate dependency choice. This package has zero npm dependencies and
 * `frontmatter.ts` sets a precedent for hand-rolled parsing — but frontmatter
 * is five flat keys, while `department.yml` needs block scalars, nested maps,
 * sequences of maps, flow maps, and quoting. A partial hand-rolled YAML parser
 * is the single most likely place for a subtle misread in a file that decides
 * what a machine executes, so this uses a real one. Bun is a hard prerequisite
 * product-wide (D32), which makes `Bun.YAML` free where an npm parser would not
 * be.
 *
 * Cost, stated plainly: `Bun.YAML` needs a newer Bun than `package.json`'s
 * nominal `engines.bun: ">=1.0.0"`, hence the explicit guard rather than a
 * `TypeError: undefined is not an object` in a user's terminal.
 */
export const bunYamlParser: YamlParser = (text: string): unknown => {
  const yaml = (globalThis as { Bun?: { YAML?: { parse(s: string): unknown } } }).Bun?.YAML;
  if (!yaml) {
    throw new DepartmentManifestError(
      `reading ${DEPARTMENT_MANIFEST_FILENAME} needs Bun's built-in YAML parser — upgrade Bun (\`bun upgrade\`) and retry`,
    );
  }
  return yaml.parse(text);
};

export interface ParseOptions {
  /** Injectable so tests can drive the schema layer with plain objects and so
   *  a future non-Bun host can supply its own parser. */
  yaml?: YamlParser;
}

// ---------------------------------------------------------------------------
// Scalar coercion helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A string-typed field, tolerant of YAML's implicit typing.
 *
 * `taskTimeout: 600`, `version: 1.2` and `maxArtifactBytes: 1048576` all look
 * like strings to the author, but YAML hands us numbers for the first two. The
 * cloud's validator requires strings and would answer 400. Implicit typing is a
 * formatting artifact of an unquoted scalar, not authoring intent, so numbers
 * and booleans are coerced to their canonical string form silently. Anything
 * structural (a map, a list, `null`) is a type error the author must see.
 */
function coerceString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/** A record with NO prototype. `environment.values` is keyed by author-supplied
 *  strings; assigning `__proto__` onto a plain object literal walks
 *  `Object.prototype`'s setter and mutates the object's prototype. A
 *  null-prototype record makes that key an ordinary own property. */
function nullProtoRecord(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = [
  'apiVersion',
  'name',
  'displayName',
  'description',
  'version',
  'visibility',
  'skills',
  'runtime',
  'communication',
  'scheduling',
  'limits',
  'retention',
] as const;

const RUNTIME_KEYS = [
  'engine',
  'lifecycle',
  'startupTimeoutSeconds',
  'gracefulShutdownSeconds',
  'command',
  'args',
  'workingDirectory',
  'environment',
  'pipelineRoot',
  'startIteration',
] as const;

const SKILL_KEYS = ['id', 'name', 'description', 'tags', 'inputModes', 'outputModes'] as const;
const COMMUNICATION_KEYS = [
  'acceptsMidTaskInput',
  'supportsCancellation',
  'supportsStreaming',
  'supportsCheckpoint',
] as const;
const SCHEDULING_KEYS = [
  'requiredLabels',
  'requiredIsolation',
  'maxConcurrency',
  'contextAffinity',
] as const;
const LIMITS_KEYS = ['taskTimeout', 'parkExpiry', 'maxArtifactBytes'] as const;
const RETENTION_KEYS = ['cloudMessages', 'artifacts'] as const;

/** Collects findings so every rule reads as a straight-line assertion. */
class Findings {
  readonly list: ManifestFinding[] = [];
  error(field: string, message: string): void {
    this.list.push({ severity: 'error', field, message });
  }
  warn(field: string, message: string): void {
    this.list.push({ severity: 'warning', field, message });
  }

  /** Unknown keys are a WARNING, never an error (D22) — a file written by a
   *  newer CLI must stay readable by an older one. Applied at every level, not
   *  just the top, for one consistent rule. */
  unknownKeys(obj: Record<string, unknown>, known: readonly string[], path: string): void {
    for (const key of Object.keys(obj)) {
      if ((known as readonly string[]).includes(key)) continue;
      this.warn(
        path === '$' ? key : `${path}.${key}`,
        `unknown key — ignored by this CLI (it may belong to a newer ${DEPARTMENT_MANIFEST_FILENAME} schema)`,
      );
    }
  }

  /** A required string field with a length cap. */
  requiredString(
    obj: Record<string, unknown>,
    key: string,
    max: number,
    path: string,
  ): string | undefined {
    const raw = obj[key];
    if (raw === undefined || raw === null) {
      this.error(fieldPath(path, key), 'is required');
      return undefined;
    }
    const s = coerceString(raw);
    if (s === undefined) {
      this.error(fieldPath(path, key), 'must be text');
      return undefined;
    }
    if (s.length < 1 || s.length > max) {
      this.error(fieldPath(path, key), `must be 1–${max} characters (got ${s.length})`);
      return undefined;
    }
    return s;
  }

  optionalString(
    obj: Record<string, unknown>,
    key: string,
    max: number,
    path: string,
  ): string | undefined {
    const raw = obj[key];
    if (raw === undefined || raw === null) return undefined;
    const s = coerceString(raw);
    if (s === undefined) {
      this.error(fieldPath(path, key), 'must be text');
      return undefined;
    }
    if (s.length < 1 || s.length > max) {
      this.error(fieldPath(path, key), `must be 1–${max} characters (got ${s.length})`);
      return undefined;
    }
    return s;
  }

  optionalEnum<T extends string>(
    obj: Record<string, unknown>,
    key: string,
    allowed: readonly T[],
    path: string,
  ): T | undefined {
    const raw = obj[key];
    if (raw === undefined || raw === null) return undefined;
    const s = coerceString(raw);
    if (s === undefined || !(allowed as readonly string[]).includes(s)) {
      this.error(fieldPath(path, key), `must be one of: ${allowed.join(', ')}`);
      return undefined;
    }
    return s as T;
  }

  optionalBool(obj: Record<string, unknown>, key: string, path: string): boolean | undefined {
    const raw = obj[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'boolean') {
      this.error(fieldPath(path, key), 'must be true or false');
      return undefined;
    }
    return raw;
  }

  /** A positive integer (concurrency, byte cap, timeout seconds). */
  optionalPositiveInt(
    obj: Record<string, unknown>,
    key: string,
    path: string,
  ): number | undefined {
    const raw = obj[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
      this.error(fieldPath(path, key), 'must be a whole number of at least 1');
      return undefined;
    }
    return raw;
  }

  optionalStringList(
    obj: Record<string, unknown>,
    key: string,
    itemMax: number,
    path: string,
  ): string[] | undefined {
    const raw = obj[key];
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) {
      this.error(fieldPath(path, key), 'must be a list');
      return undefined;
    }
    const out: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const s = coerceString(raw[i]);
      if (s === undefined || s.length === 0 || s.length > itemMax) {
        this.error(`${fieldPath(path, key)}[${i}]`, `must be text of 1–${itemMax} characters`);
        continue;
      }
      out.push(s);
    }
    return out;
  }

  /** A duration in the runner's grammar. */
  optionalDuration(
    obj: Record<string, unknown>,
    key: string,
    path: string,
  ): string | undefined {
    const raw = obj[key];
    if (raw === undefined || raw === null) return undefined;
    const s = coerceString(raw);
    if (s === undefined || !DURATION_RE.test(s.trim())) {
      this.error(
        fieldPath(path, key),
        "must be a duration like '30s', '45m', '2h', '7d' (or a whole number of seconds)",
      );
      return undefined;
    }
    return s.trim();
  }

  /** A nested block. `key:` with nothing under it parses as `null` in YAML and
   *  is treated as absent — an empty block is not a mistake worth a finding. */
  optionalBlock(
    obj: Record<string, unknown>,
    key: string,
    path: string,
  ): Record<string, unknown> | undefined {
    const raw = obj[key];
    if (raw === undefined || raw === null) return undefined;
    if (!isRecord(raw)) {
      this.error(fieldPath(path, key), 'must be a block of settings');
      return undefined;
    }
    return raw;
  }
}

function fieldPath(path: string, key: string): string {
  return path === '$' ? key : `${path}.${key}`;
}

/**
 * Parse `department.yml` text into a manifest plus findings. Pure — the only
 * argument is the file's text.
 *
 * Never throws on user input: a malformed document yields `manifest: null`, and
 * every other problem is a finding. The one exception is a missing YAML parser,
 * which is an environment failure rather than a manifest failure.
 */
export function parseDepartmentManifest(text: string, opts: ParseOptions = {}): ParseResult {
  const f = new Findings();
  const parse = opts.yaml ?? bunYamlParser;

  // A UTF-8 BOM is NOT stripped by the YAML parser: it becomes part of the
  // first key, so `name:` silently arrives as `﻿name` and the department
  // has no name. Windows editors write BOMs by default, so this is a real path,
  // not a theoretical one.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  let doc: unknown;
  try {
    doc = parse(source);
  } catch (e) {
    return {
      manifest: null,
      findings: [
        { severity: 'error', field: '$', message: `is not valid YAML — ${(e as Error).message}` },
      ],
    };
  }

  if (Array.isArray(doc)) {
    // A `---` separator turns the file into a multi-document stream. Silently
    // taking the first document would publish half a file.
    return {
      manifest: null,
      findings: [
        {
          severity: 'error',
          field: '$',
          message: `must be a single YAML document — remove the '---' separator so ${DEPARTMENT_MANIFEST_FILENAME} describes one department`,
        },
      ],
    };
  }
  if (!isRecord(doc)) {
    return {
      manifest: null,
      findings: [
        {
          severity: 'error',
          field: '$',
          message: doc === null || doc === undefined ? 'is empty' : 'must be a block of settings',
        },
      ],
    };
  }

  f.unknownKeys(doc, TOP_LEVEL_KEYS, '$');

  // ---- apiVersion (D22) ----------------------------------------------------
  // Optional; defaults to v1; an unrecognized value is an ERROR because a
  // schema we cannot read is one we must not guess at, digest and all.
  let apiVersion = DEPARTMENT_API_VERSION_V1;
  const rawApiVersion = doc['apiVersion'];
  if (rawApiVersion !== undefined && rawApiVersion !== null) {
    const s = coerceString(rawApiVersion);
    if (s === undefined || !SUPPORTED_API_VERSIONS.includes(s)) {
      f.error(
        'apiVersion',
        `'${s ?? String(rawApiVersion)}' is not recognized — this CLI reads: ${SUPPORTED_API_VERSIONS.join(', ')}. Upgrade the CLI, or set it to ${DEPARTMENT_API_VERSION_V1}.`,
      );
    } else {
      apiVersion = s;
    }
  }

  // ---- identity ------------------------------------------------------------
  const name = f.requiredString(doc, 'name', MAX_SLUG_LEN, '$');
  if (name !== undefined && !SLUG_RE.test(name)) {
    f.error(
      'name',
      'must be a slug: lowercase letters, digits and internal hyphens (e.g. unity-review)',
    );
  }
  const displayName = f.optionalString(doc, 'displayName', MAX_NAME_LEN, '$');
  const description = f.requiredString(doc, 'description', MAX_DESCRIPTION_LEN, '$');
  const version = f.optionalString(doc, 'version', MAX_VERSION_LEN, '$');
  const visibility =
    f.optionalEnum(doc, 'visibility', ['organization', 'private'] as const, '$') ?? 'organization';

  // ---- skills --------------------------------------------------------------
  const skills = parseSkills(doc, f);

  // ---- runtime (LOCAL in full) --------------------------------------------
  const runtime = parseRuntime(doc, f);

  // ---- communication -------------------------------------------------------
  const communication = parseCommunication(doc, runtime.engine, f);

  // ---- scheduling / limits / retention ------------------------------------
  const scheduling = parseScheduling(doc, f);
  const limits = parseLimits(doc, f);
  const retention = parseRetention(doc, f);

  const manifest: DepartmentManifest = {
    apiVersion,
    name: name ?? '',
    displayName: displayName ?? name ?? '',
    description: description ?? '',
    ...(version !== undefined ? { version } : {}),
    visibility,
    skills,
    runtime,
    communication,
    scheduling,
    limits,
    retention,
  };

  return { manifest, findings: f.list };
}

function parseSkills(doc: Record<string, unknown>, f: Findings): DepartmentSkill[] {
  const raw = doc['skills'];
  if (raw === undefined || raw === null) {
    f.error('skills', 'is required — at least one skill, or callers have nothing to choose from');
    return [];
  }
  if (!Array.isArray(raw)) {
    f.error('skills', 'must be a list');
    return [];
  }
  if (raw.length === 0) {
    f.error('skills', 'must list at least one skill');
    return [];
  }
  if (raw.length > MAX_SKILLS) {
    f.error('skills', `must have at most ${MAX_SKILLS} entries (got ${raw.length})`);
  }

  const out: DepartmentSkill[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const path = `skills[${i}]`;
    const entry = raw[i];
    if (!isRecord(entry)) {
      f.error(path, 'must be a block with id, name and description');
      continue;
    }
    f.unknownKeys(entry, SKILL_KEYS, path);
    const id = f.requiredString(entry, 'id', MAX_SKILL_ID_LEN, path);
    const name = f.requiredString(entry, 'name', MAX_NAME_LEN, path);
    const description = f.optionalString(entry, 'description', MAX_DESCRIPTION_LEN, path);
    if (id !== undefined) {
      // Duplicate ids make the advertised subset ambiguous about which skill a
      // caller invoked. 05 §4 files this under Advisory, so: warning.
      if (seen.has(id)) f.warn(`${path}.id`, `duplicates an earlier skill id ('${id}')`);
      seen.add(id);
    }
    if (id === undefined || name === undefined) continue;
    out.push({
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      tags: f.optionalStringList(entry, 'tags', MAX_LABEL_LEN, path) ?? [],
      inputModes: f.optionalStringList(entry, 'inputModes', MAX_STRING_LEN, path) ?? [
        ...DEFAULT_INPUT_MODES,
      ],
      outputModes: f.optionalStringList(entry, 'outputModes', MAX_STRING_LEN, path) ?? [
        ...DEFAULT_OUTPUT_MODES,
      ],
    });
  }
  return out;
}

function parseRuntime(doc: Record<string, unknown>, f: Findings): DepartmentRuntime {
  const block = f.optionalBlock(doc, 'runtime', '$');
  if (block === undefined) {
    // Absent, or present-but-empty (`runtime:` with nothing under it parses as
    // `null`). Either way the engine was never named. A `runtime:` that is
    // present but the wrong TYPE already produced its own finding.
    const raw = doc['runtime'];
    if (raw === undefined || raw === null) f.error('runtime.engine', 'is required');
    return { engine: '', lifecycle: 'per-task' };
  }
  f.unknownKeys(block, RUNTIME_KEYS, 'runtime');

  const engine = f.requiredString(block, 'engine', MAX_STRING_LEN, 'runtime');
  if (engine !== undefined && engineDefinition(engine) === undefined) {
    // Names EVERY engine that exists, not just one (06 §1) — and never the
    // word `adapterId`.
    f.error(
      'runtime.engine',
      `'${engine}' is not supported yet — supported: ${SUPPORTED_ENGINES.join(', ')}`,
    );
  }

  const runtime: DepartmentRuntime = {
    engine: engine ?? '',
    lifecycle:
      f.optionalEnum(
        block,
        'lifecycle',
        ['per-task', 'per-context', 'daemon'] as const,
        'runtime',
      ) ?? 'per-task',
  };

  const startupTimeoutSeconds = f.optionalPositiveInt(block, 'startupTimeoutSeconds', 'runtime');
  if (startupTimeoutSeconds !== undefined) runtime.startupTimeoutSeconds = startupTimeoutSeconds;
  const gracefulShutdownSeconds = f.optionalPositiveInt(
    block,
    'gracefulShutdownSeconds',
    'runtime',
  );
  if (gracefulShutdownSeconds !== undefined) runtime.gracefulShutdownSeconds = gracefulShutdownSeconds;

  // ── The LOCAL-ONLY half ──────────────────────────────────────────────────
  // Parsed so `serve` can write the machine's runtime binding (a9/b1), and
  // named in `LOCAL_ONLY_FIELD_NAMES` so it can never reach a request.
  const command = f.optionalString(block, 'command', MAX_LOCAL_STRING_LEN, 'runtime');
  if (command !== undefined) runtime.command = command;
  const args = f.optionalStringList(block, 'args', MAX_LOCAL_STRING_LEN, 'runtime');
  if (args !== undefined) runtime.args = args;
  const workingDirectory = f.optionalString(
    block,
    'workingDirectory',
    MAX_LOCAL_STRING_LEN,
    'runtime',
  );
  if (workingDirectory !== undefined) runtime.workingDirectory = workingDirectory;
  const environment = parseEnvironment(block, f);
  if (environment !== undefined) runtime.environment = environment;
  const pipelineRoot = f.optionalString(block, 'pipelineRoot', MAX_LOCAL_STRING_LEN, 'runtime');
  if (pipelineRoot !== undefined) runtime.pipelineRoot = pipelineRoot;
  const startIteration = f.optionalString(block, 'startIteration', MAX_LOCAL_STRING_LEN, 'runtime');
  if (startIteration !== undefined) runtime.startIteration = startIteration;

  return runtime;
}

function parseEnvironment(
  runtimeBlock: Record<string, unknown>,
  f: Findings,
): { allow?: string[]; values?: Record<string, string> } | undefined {
  const block = f.optionalBlock(runtimeBlock, 'environment', 'runtime');
  if (block === undefined) return undefined;
  f.unknownKeys(block, ['allow', 'values'], 'runtime.environment');

  const out: { allow?: string[]; values?: Record<string, string> } = {};
  const allow = f.optionalStringList(block, 'allow', MAX_STRING_LEN, 'runtime.environment');
  if (allow !== undefined) out.allow = allow;

  const rawValues = block['values'];
  if (rawValues !== undefined && rawValues !== null) {
    if (!isRecord(rawValues)) {
      f.error('runtime.environment.values', 'must be a block of NAME: value pairs');
    } else {
      const values = nullProtoRecord();
      for (const [k, v] of Object.entries(rawValues)) {
        const s = coerceString(v);
        if (s === undefined) {
          f.error(`runtime.environment.values.${k}`, 'must be text');
          continue;
        }
        values[k] = s;
      }
      out.values = values;
    }
  }
  return out;
}

function parseCommunication(
  doc: Record<string, unknown>,
  engine: string,
  f: Findings,
): Partial<EngineCapabilities> {
  const declared = engineDefinition(engine)?.capabilities ?? null;
  // Defaults follow the engine's declared capabilities (05 §2). An engine that
  // negotiates them at runtime has none to follow, so nothing is defaulted —
  // see `EngineDefinition.capabilities`.
  const out: Partial<EngineCapabilities> = declared ? { ...declared } : {};

  const block = f.optionalBlock(doc, 'communication', '$');
  if (block === undefined) return out;
  f.unknownKeys(block, COMMUNICATION_KEYS, 'communication');

  for (const key of COMMUNICATION_KEYS) {
    const value = f.optionalBool(block, key, 'communication');
    if (value !== undefined) out[key] = value;
  }
  // Whether the ENGINE can actually honour what the author declared is 05 §4's
  // Coherence class and belongs to `department validate` (a8), which has the
  // engine registry from this module to check against.
  return out;
}

function parseScheduling(doc: Record<string, unknown>, f: Findings): DepartmentScheduling {
  const block = f.optionalBlock(doc, 'scheduling', '$');
  if (block === undefined) return { requiredLabels: [], contextAffinity: 'none' };
  f.unknownKeys(block, SCHEDULING_KEYS, 'scheduling');

  const out: DepartmentScheduling = {
    requiredLabels: f.optionalStringList(block, 'requiredLabels', MAX_LABEL_LEN, 'scheduling') ?? [],
    contextAffinity:
      f.optionalEnum(
        block,
        'contextAffinity',
        ['none', 'preferred', 'required'] as const,
        'scheduling',
      ) ?? 'none',
  };
  const requiredIsolation = f.optionalEnum(
    block,
    'requiredIsolation',
    ['process', 'container'] as const,
    'scheduling',
  );
  if (requiredIsolation !== undefined) out.requiredIsolation = requiredIsolation;
  const maxConcurrency = f.optionalPositiveInt(block, 'maxConcurrency', 'scheduling');
  if (maxConcurrency !== undefined) out.maxConcurrency = maxConcurrency;
  return out;
}

function parseLimits(doc: Record<string, unknown>, f: Findings): DepartmentLimits {
  const block = f.optionalBlock(doc, 'limits', '$');
  if (block === undefined) return {};
  f.unknownKeys(block, LIMITS_KEYS, 'limits');
  const out: DepartmentLimits = {};
  const taskTimeout = f.optionalDuration(block, 'taskTimeout', 'limits');
  if (taskTimeout !== undefined) out.taskTimeout = taskTimeout;
  const parkExpiry = f.optionalDuration(block, 'parkExpiry', 'limits');
  if (parkExpiry !== undefined) out.parkExpiry = parkExpiry;
  const maxArtifactBytes = f.optionalPositiveInt(block, 'maxArtifactBytes', 'limits');
  if (maxArtifactBytes !== undefined) out.maxArtifactBytes = maxArtifactBytes;
  return out;
}

function parseRetention(doc: Record<string, unknown>, f: Findings): DepartmentRetention {
  const block = f.optionalBlock(doc, 'retention', '$');
  if (block === undefined) return {};
  f.unknownKeys(block, RETENTION_KEYS, 'retention');
  const out: DepartmentRetention = {};
  const cloudMessages = f.optionalDuration(block, 'cloudMessages', 'retention');
  if (cloudMessages !== undefined) out.cloudMessages = cloudMessages;
  const artifacts = f.optionalDuration(block, 'artifacts', 'retention');
  if (artifacts !== undefined) out.artifacts = artifacts;
  return out;
}

// ---------------------------------------------------------------------------
// Reading the file (the ONLY I/O in this module)
// ---------------------------------------------------------------------------

export interface ReadOptions extends ParseOptions {
  readFile?: (path: string) => string;
}

/**
 * Read and parse `department.yml`. Throws `DepartmentManifestError` when the
 * bytes cannot be read — 05 §4's exit-2 class, same as an unparseable file, and
 * distinct from a file that parsed but has errors (exit 1).
 */
export function readDepartmentManifest(filePath: string, opts: ReadOptions = {}): ParseResult {
  const read = opts.readFile ?? ((p: string) => fsReadFileSync(p, 'utf-8'));
  let text: string;
  try {
    text = read(filePath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new DepartmentManifestError(
      code === 'ENOENT'
        ? `no ${DEPARTMENT_MANIFEST_FILENAME} at ${filePath} — run \`pipeline department new\` to create one`
        : `could not read ${filePath}: ${(e as Error).message}`,
    );
  }
  return parseDepartmentManifest(text, opts);
}

// ---------------------------------------------------------------------------
// The advertised subset — the allow-list
// ---------------------------------------------------------------------------

export interface AdvertisedSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AdvertisedScheduling {
  requiredLabels?: string[];
  requiredIsolation?: DepartmentIsolation;
  maxConcurrency?: number;
  /** `none` is never advertised — see `advertisedManifest()`. */
  contextAffinity?: 'preferred' | 'required';
}

export interface AdvertisedManifest {
  /** The slug. Becomes the request's `slug`. */
  name: string;
  /** Becomes the request's `name`. */
  displayName: string;
  description: string;
  version?: string;
  visibility: DepartmentVisibility;
  skills: AdvertisedSkill[];
  communication?: Partial<EngineCapabilities>;
  scheduling?: AdvertisedScheduling;
  limits?: DepartmentLimits;
  retention?: DepartmentRetention;
}

/** Sort + dedupe a set-valued list. `requiredLabels: [linux, x64]` and
 *  `[x64, linux]` are the same scheduling constraint, so they must produce the
 *  same digest — a re-approval prompted by reordering two tags is a
 *  re-approval for nothing. Skills keep author order: that IS the order callers
 *  see, so reordering them is a real change. */
function normalizeSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function omitIfEmpty<T extends object>(obj: T): T | undefined {
  return Object.keys(obj).length === 0 ? undefined : obj;
}

/**
 * Project a manifest onto the subset the cloud may see (05 §2's "Sent to the
 * cloud" list, verbatim).
 *
 * **This function is the security boundary.** It names every field that leaves
 * the machine; anything it does not name stays local by construction. In
 * particular there is no `runtime` here at all: the cloud is told what the
 * department can do (`communication`) and what a scheduler must honour
 * (`scheduling`), never which engine implements it, where it runs, or what it
 * executes. `apiVersion` is likewise absent — by D22 it must not move the
 * digest.
 */
export function advertisedManifest(manifest: DepartmentManifest): AdvertisedManifest {
  const skills: AdvertisedSkill[] = manifest.skills.map((s) => ({
    id: s.id,
    name: s.name,
    ...(s.description !== undefined ? { description: s.description } : {}),
    ...(s.tags.length > 0 ? { tags: normalizeSet(s.tags) } : {}),
    ...(s.inputModes.length > 0 ? { inputModes: normalizeSet(s.inputModes) } : {}),
    ...(s.outputModes.length > 0 ? { outputModes: normalizeSet(s.outputModes) } : {}),
  }));

  const scheduling: AdvertisedScheduling = {
    ...(manifest.scheduling.requiredLabels.length > 0
      ? { requiredLabels: normalizeSet(manifest.scheduling.requiredLabels) }
      : {}),
    ...(manifest.scheduling.requiredIsolation !== undefined
      ? { requiredIsolation: manifest.scheduling.requiredIsolation }
      : {}),
    ...(manifest.scheduling.maxConcurrency !== undefined
      ? { maxConcurrency: manifest.scheduling.maxConcurrency }
      : {}),
    // `none` means "no affinity constraint" and the cloud's enum has no such
    // value (`mesh-registry/manifest.ts:201`): absence IS `none`. Sending the
    // word would be a 400 on a manifest the user wrote exactly as documented.
    ...(manifest.scheduling.contextAffinity !== 'none'
      ? { contextAffinity: manifest.scheduling.contextAffinity }
      : {}),
  };

  // An all-empty block is omitted rather than sent as `{}` — the cloud treats
  // an absent block and an empty one identically, and omitting keeps the
  // canonical form (and therefore the digest) free of noise.
  const communication = omitIfEmpty({ ...manifest.communication });
  const limits = omitIfEmpty({ ...manifest.limits });
  const retention = omitIfEmpty({ ...manifest.retention });

  return {
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description,
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
    visibility: manifest.visibility,
    skills,
    ...(communication !== undefined ? { communication } : {}),
    ...(omitIfEmpty(scheduling) !== undefined ? { scheduling } : {}),
    ...(limits !== undefined ? { limits } : {}),
    ...(retention !== undefined ? { retention } : {}),
  };
}

// ---------------------------------------------------------------------------
// Canonicalization + digest
// ---------------------------------------------------------------------------

/**
 * Canonical JSON: object keys sorted, absent fields omitted (never `null`),
 * array order preserved, no insignificant whitespace. Deterministic for a given
 * advertised subset regardless of how the YAML that produced it was written.
 *
 * Deliberately NOT Unicode-normalized. Two files whose descriptions differ only
 * in NFC/NFD really are different bytes in git, and silently equating them
 * would let one machine's `serve` claim a digest another machine's file does
 * not produce.
 *
 * ⚠ Changing this function changes every department's digest and re-arms
 * approval org-wide. Pair any change with a new `apiVersion` (D22).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DepartmentManifestError('cannot canonicalize a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  if (isRecord(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new DepartmentManifestError(`cannot canonicalize a value of type ${typeof value}`);
}

/** The exact bytes hashed — exported so `validate --json` and any future
 *  "why did my digest change?" tooling can show them. */
export function canonicalizeAdvertised(advertised: AdvertisedManifest): string {
  return canonicalJson(advertised);
}

/** `sha256:<hex>` over the canonicalized advertised subset. Always computed,
 *  never authored (D15) — a documented placeholder teaches users to defeat the
 *  approval control it exists to arm. */
export function computeManifestDigest(advertised: AdvertisedManifest): string {
  return DIGEST_PREFIX + createHash('sha256').update(canonicalizeAdvertised(advertised), 'utf8').digest('hex');
}

/** Convenience: manifest → digest, via the advertised projection. */
export function manifestDigest(manifest: DepartmentManifest): string {
  return computeManifestDigest(advertisedManifest(manifest));
}

// ---------------------------------------------------------------------------
// The registration request + the deny-list alarm
// ---------------------------------------------------------------------------

/**
 * The body of `POST /api/v1/departments` (and of the `PATCH` that follows a
 * digest change). Field names are the SERVER's, which differ from the file's in
 * one place worth stating loudly:
 *
 *   department.yml `name`        → request `slug`
 *   department.yml `displayName` → request `name`
 *
 * The file calls the slug `name` because that is what an author types once and
 * rarely thinks about again; the cloud separates slug from display name.
 */
export interface DepartmentRegistrationRequest {
  slug: string;
  name: string;
  description: string;
  version?: string;
  visibility: DepartmentVisibility;
  skills: AdvertisedSkill[];
  communication?: Partial<EngineCapabilities>;
  scheduling?: AdvertisedScheduling;
  limits?: DepartmentLimits;
  retention?: DepartmentRetention;
  manifest_digest: string;
}

/**
 * Key names that must never appear at any depth of a request body. The cloud
 * rejects these itself (`mesh-registry/manifest.ts:44-45`); this is the local
 * half of the same guarantee, so a widening of `advertisedManifest()` fails a
 * unit test here rather than being caught — or not — by a 400 in production.
 *
 * `path` is on the list although v1 has no `workspace` block, so that adding
 * one later cannot quietly ship a local filesystem path to the control plane.
 */
export const LOCAL_ONLY_FIELD_NAMES: readonly string[] = [
  'apiVersion',
  'runtime',
  'engine',
  'adapterId',
  'command',
  'args',
  'workingDirectory',
  'environment',
  'pipelineRoot',
  'startIteration',
  'workspace',
  'path',
  'lifecycle',
];

/**
 * Throw if any local-only key name appears anywhere in `body`. A programming
 * error, not a user error — hence a throw rather than a finding.
 */
export function assertNoLocalFields(body: unknown, path = '$'): void {
  if (Array.isArray(body)) {
    body.forEach((item, i) => assertNoLocalFields(item, `${path}[${i}]`));
    return;
  }
  if (!isRecord(body)) return;
  for (const [key, value] of Object.entries(body)) {
    if (LOCAL_ONLY_FIELD_NAMES.includes(key)) {
      throw new DepartmentManifestError(
        `refusing to send ${path === '$' ? key : `${path}.${key}`} to the control plane — ` +
          `${DEPARTMENT_MANIFEST_FILENAME}'s runtime half never leaves this machine`,
      );
    }
    assertNoLocalFields(value, path === '$' ? key : `${path}.${key}`);
  }
}

/**
 * Build the request `serve` sends. The digest is computed over the same
 * advertised object that becomes the body, so what an admin approves is
 * literally what was published, and the deny-list is re-checked on the way out.
 */
export function buildRegistrationRequest(
  manifest: DepartmentManifest,
): DepartmentRegistrationRequest {
  const advertised = advertisedManifest(manifest);
  const request: DepartmentRegistrationRequest = {
    slug: advertised.name,
    name: advertised.displayName,
    description: advertised.description,
    ...(advertised.version !== undefined ? { version: advertised.version } : {}),
    visibility: advertised.visibility,
    skills: advertised.skills,
    ...(advertised.communication !== undefined ? { communication: advertised.communication } : {}),
    ...(advertised.scheduling !== undefined ? { scheduling: advertised.scheduling } : {}),
    ...(advertised.limits !== undefined ? { limits: advertised.limits } : {}),
    ...(advertised.retention !== undefined ? { retention: advertised.retention } : {}),
    manifest_digest: computeManifestDigest(advertised),
  };
  assertNoLocalFields(request);
  return request;
}
