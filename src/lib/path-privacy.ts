// path-privacy.ts — SG4: no absolute machine path, and no OS account name,
// reaches a telemetry payload (ux-v2 `b22`, `07-security.md` §4.1/SG4).
//
// ── THE RULE, AND WHY THE DEFECT SURVIVED FOR WEEKS ─────────────────────────
//
// The vendored allowlist (`vendor/privacy.ts`) has exactly one disposition for
// a machine path: `fingerprint`. It applies it to the fields it RECOGNISES as
// paths — `project_root`, `worktree`, `pipeline_root`, `worktree_path`,
// `env_file`, `hook_dir` — and `keep`s the "step identity" path fields
// VERBATIM: `iteration_path`, `next_iteration_path`, `first_iteration_path`,
// `parent_iteration_path`, `script_path`. That is deliberate, and the reason
// is written into the filter's own module doc:
//
//     "Pipeline-RELATIVE step identity (`iteration_path`, `step_name` …
//      `script_path`, pipeline/branch names, tool names) is metadata"
//
// The load-bearing word is RELATIVE — and it is an ASSUMPTION ABOUT THE
// EMITTER, not a property the filter enforces. In this CLI the assumption is
// false. `PlanStep.path` is documented "Absolute path to the iteration file"
// (`lib/plan.ts`) and the plan enumerator builds it absolute, so every emitter
// that labels an event from engine state hands the filter an absolute path and
// `keep` ships it verbatim:
//
//   `commands/next.ts:emitStartedEvents`     → `ActionStep.source_path`  (= PlanStep.path)
//   `commands/next.ts:emitCompletionEvents`  → `currentStepPath()`       (= PlanStep.path)
//                                            → `record.next_iteration`   (a resolved path)
//   `commands/drive.ts`                      → the same values, re-emitted
//
// NOTHING RELATIVIZES ANYTHING, ANYWHERE. The production sample that LOOKED
// filtered — `iteration_path: "01-prepare.md"`, i1 2026-08-07, wire event #1 —
// was never filtered: it is the raw `--start 01-prepare.md` argv token, carried
// through un-resolved because the deprecated path form of `--start` did not
// match a plan step and `lib/next.ts:synthesizeStep` built an off-plan step
// whose `path` IS that argv string. The SAME step's `iteration.completed`,
// eight seconds later in the same run (wire event #6), carried
// `C:\Users\<account>\…\.pipeline\i1-e2e-probe\steps\01-prepare.md`, because
// THAT label came from the plan. One step, one run, two values.
//
// So the discriminator is the string's PROVENANCE — raw caller argv versus
// engine/plan state — not any filtering rule. Every path the engine itself
// resolves is absolute by construction and ships absolute. A fix that
// relativized `iteration_path` and `next_iteration_path` at their emit sites
// would leave the rule untouched and the next `keep`-classified path field
// (`first_iteration_path`, `script_path`, `parent_iteration_path`, or one added
// next quarter) leaking on day one.
//
// The conformance tests missed it for the same reason a spot check does: BOTH
// of them plant absolute paths only in fields the filter already fingerprints
// (`project_root`, `worktree_path`) and plant `iteration_path` as an already-
// relative `'steps/03-review.md'`, then assert it SURVIVES — encoding the false
// assumption as the contract. See `tests/vendor-privacy.test.ts` and
// `tests/telemetry-outbox.test.ts`, both amended by `b22`.
//
// ── WHAT THIS MODULE DOES ──────────────────────────────────────────────────
//
// It makes the shape of the VALUE the rule, instead of the name of the field:
//
//   1. RELATIVIZE. A path under one of the run's own roots (`worktree`,
//      `project_root`, `pipeline_root`, `worktree_path` — read from the
//      payload itself, plus any root the caller knows) becomes the
//      POSIX-separated remainder. This is what the design wanted all along
//      (`.pipeline/<pipeline>/steps/01-prepare.md`), it keeps every consumer
//      working — `pipeline logs` renders the basename, the control plane's
//      `pathStepUuid`/step correlation keys on the value — and it makes
//      `iteration.started` and `iteration.completed` finally AGREE on a label,
//      which absolute-vs-argv never did.
//
//   2. FAIL CLOSED. Anything still path-shaped after step 1 — a path outside
//      every known root, an embedded path inside a free-text `halt_reason`, a
//      relativized remainder that still carries an account name — becomes the
//      filter's own deterministic `fp:<sha256-16>` fingerprint. Correlatable,
//      disclosing nothing. There is no branch that returns a raw absolute path.
//
// The arbiter is not a regex invented here: {@link SG4_PATH_RE} is transcribed
// verbatim from `scripts/i1-production-e2e/check-sg4.mjs` in the parent
// monorepo — the check that found this defect against production — so "the
// scrub is done" and "the production check is clean" are the same statement.
//
// ── WHY IT IS NOT IN `vendor/privacy.ts` ───────────────────────────────────
//
// That file is a BYTE-IDENTICAL vendored copy of
// `pipeline-runner/src/shipper/privacy.ts`, guarded in the parent monorepo's
// CI by `scripts/check-privacy-filter-drift.mjs`, which today compares THREE
// copies (runner original, `pipeline-protocol/src/privacy/privacy.ts`, and the
// plugin's vendored CLI copy). Editing the copy in place would either break
// that check or force it to be weakened, and `b22`'s specification forbids
// both: the rule belongs UPSTREAM first, as its own change in its own
// repository. Until that lands, this module is composed OVER the vendored
// filter at the CLI's two filtering seams — `TelemetryOutbox.filterPayload`
// (before a byte reaches the queue file) and `filterForWire` (before a byte
// reaches the socket) — which are the CLI's actual trust boundary. Everything
// here is pure and injectable precisely so it can be lifted into the filter
// verbatim when upstream is ready.
//
// ── TIER ───────────────────────────────────────────────────────────────────
//
// This runs at the `metadata` tier — the default, the fail-closed degradation
// target, and the tier every production run to date has shipped at. The
// opt-in `events`/`full` tiers pass the envelope VERBATIM by contract
// (`vendor/privacy.ts:463`), which is already how `project_root` itself
// behaves there (`telemetry-upload.ts:statsEnvelope`, `b21`): at those tiers
// the TIER is the control, not any one field. `b22` did not change that, and
// it is called out here rather than left to be discovered.

import { basename } from 'node:path';
import { homedir } from 'node:os';
import { fingerprintString } from './vendor/privacy';

/**
 * THE ARBITER. Transcribed verbatim from the parent monorepo's
 * `scripts/i1-production-e2e/check-sg4.mjs` (`PATH_RE`) — the SG4 check that
 * found this defect in the production `events` table. A payload is compliant
 * exactly when this expression matches no string in it, at any depth.
 *
 * The leading `(^|[^A-Za-z0-9])` guard is load-bearing and deliberately kept:
 * without it `https://host/x` matches the drive-letter branch on `s:/`.
 */
export const SG4_PATH_RE =
  /(^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\\\\[A-Za-z0-9_.-]+\\)/;

/** A value that IS a path, in any of the three absolute forms. Broader than
 *  {@link SG4_PATH_RE} on purpose: a bare POSIX `/opt/proj/steps/01.md` does
 *  not trip the arbiter but is still a machine path we would rather relativize
 *  than ship. `//` is excluded from the POSIX branch so a protocol-relative
 *  URL is not mistaken for a UNC share. */
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;
const UNC_ABS_RE = /^[\\/]{2}[^\\/]+[\\/]/;
const POSIX_ABS_RE = /^\/(?!\/)/;

/** Absolute-path runs EMBEDDED in a longer string (a truncated `halt_reason`,
 *  a summary). Same three shapes as the arbiter, with the same guard, plus a
 *  bounded tail charset so a path inside prose stops at whitespace or a quote.
 *  Group 1 is the guard character and is preserved; group 2 is the path. */
const EMBEDDED_PATH_RE =
  /(^|[^A-Za-z0-9])((?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9_.-]+\\|\/Users\/|\/home\/)[^\s"'`<>|]*)/g;

/** Whether a string is shaped like a path at all (used to bound the
 *  account-name sweep — see {@link hasAccountNameSegment}). */
function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

/** Whether the WHOLE value is an absolute path. */
export function looksAbsolutePath(value: string): boolean {
  return WINDOWS_ABS_RE.test(value) || UNC_ABS_RE.test(value) || POSIX_ABS_RE.test(value);
}

// ---------------------------------------------------------------------------
// The OS account name
// ---------------------------------------------------------------------------

/**
 * Every name this machine's OS account could appear under in a path —
 * `USERNAME`/`USER`/`LOGNAME` and the basename of the home directory
 * (`C:\Users\IvanD` → `IvanD`, `/home/ivan` → `ivan`, `/Users/ivan` → `ivan`).
 *
 * Injectable, and resolved through a `try` on every source, because this is
 * called on a hot path in a process that must never throw for a telemetry
 * reason. Names shorter than two characters are dropped: a one-character
 * account name would match half the world's path segments and the
 * absolute-path rule already covers the disclosure that matters.
 */
export function defaultAccountNames(
  env: Record<string, string | undefined> = process.env,
  home: string | null = safeHomedir(),
): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined | null): void => {
    const v = (value ?? '').trim();
    if (v.length >= 2) out.add(v.toLowerCase());
  };
  add(env.USERNAME);
  add(env.USER);
  add(env.LOGNAME);
  if (home) {
    try {
      add(basename(home.replace(/[\\/]+$/, '')));
    } catch {
      /* unusable home — the absolute-path rule still applies */
    }
  }
  return [...out];
}

function safeHomedir(): string | null {
  try {
    return homedir();
  } catch {
    return null;
  }
}

/**
 * Whether a PATH-LIKE string carries an account name as a whole segment.
 *
 * Scoped to path-like strings on purpose, and the boundary is stated rather
 * than hidden: the disclosure SG4 names is "absolute paths carrying the OS
 * username", i.e. the filesystem layout. A bare token that happens to equal
 * the account name with no path around it (a step named `runner` on a CI box
 * whose account is `runner`) is not a layout disclosure, and redacting it
 * would silently corrupt step identity for every consumer downstream.
 */
function hasAccountNameSegment(value: string, accountNames: readonly string[]): boolean {
  if (accountNames.length === 0 || !isPathLike(value)) return false;
  for (const seg of value.split(/[\\/]+/)) {
    if (seg && accountNames.includes(seg.toLowerCase())) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

/** Envelope-level fields that name a machine root. */
const ENVELOPE_ROOT_KEYS = ['project_root', 'worktree'] as const;
/** `data`-level fields that name a machine root. */
const DATA_ROOT_KEYS = ['pipeline_root', 'worktree_path', 'hook_dir'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The roots an absolute path in THIS payload may legitimately be made relative
 * to — read out of the payload itself (so the rule is self-sufficient and
 * lifts upstream unchanged) plus whatever the caller knows.
 *
 * Read from the UNFILTERED payload: by the time the allowlist has run,
 * `project_root` is already `fp:<hash>` and names nothing.
 *
 * Sorted longest-first so the most specific root wins — a worktree nested
 * inside the project root must relativize against the worktree.
 */
export function collectPathRoots(
  payload: unknown,
  extra: readonly (string | null | undefined)[] = [],
): string[] {
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const v = value.replace(/[\\/]+$/, '');
    if (v.length > 0 && looksAbsolutePath(v)) seen.add(v);
  };
  for (const v of extra) add(v);
  if (isRecord(payload)) {
    for (const k of ENVELOPE_ROOT_KEYS) add(payload[k]);
    const data = payload.data;
    if (isRecord(data)) for (const k of DATA_ROOT_KEYS) add(data[k]);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/** Normalize separators for comparison; the emitted form is always POSIX. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * `path` expressed relative to `root`, or null when it is not under it.
 *
 * Deliberately string-wise rather than `node:path.relative`: a Windows-shaped
 * path is routinely scrubbed on a Linux CI runner (and vice versa), where
 * `path.relative` would apply the wrong platform's rules. Comparison is
 * case-insensitive in both directions — on NTFS that is correct, and on a
 * case-sensitive filesystem the only effect is that we relativize slightly
 * MORE often, which is the safe direction.
 */
function relativeUnder(path: string, root: string): string | null {
  const p = toPosix(path);
  const r = toPosix(root).replace(/\/+$/, '');
  if (r.length === 0) return null;
  const pl = p.toLowerCase();
  const rl = r.toLowerCase();
  if (pl === rl) return '.';
  if (!pl.startsWith(`${rl}/`)) return null;
  const rest = p.slice(r.length + 1).replace(/^\/+/, '');
  return rest.length > 0 ? rest : '.';
}

// ---------------------------------------------------------------------------
// The scrub
// ---------------------------------------------------------------------------

export interface PathScrubOptions {
  /** Roots an absolute path may be relativized against, longest-first. */
  roots?: readonly string[];
  /** Names that must never survive as a path segment. Defaults to
   *  {@link defaultAccountNames}. */
  accountNames?: readonly string[];
  /** The salt the surrounding filter fingerprints with, so a path that cannot
   *  be relativized correlates with the same run's other fingerprints. */
  fingerprintSalt?: string;
}

interface ResolvedOptions {
  roots: readonly string[];
  accountNames: readonly string[];
  salt: string;
}

function resolveOptions(options: PathScrubOptions): ResolvedOptions {
  return {
    roots: options.roots ?? [],
    accountNames: options.accountNames ?? defaultAccountNames(),
    salt: options.fingerprintSalt ?? '',
  };
}

/** Is this string safe to ship as-is? The arbiter, plus the account-name rule. */
function isShippable(value: string, opts: ResolvedOptions): boolean {
  return !SG4_PATH_RE.test(value) && !hasAccountNameSegment(value, opts.accountNames);
}

/** One absolute path → the value that ships in its place. Relativized under
 *  the most specific root that contains it and still passes {@link isShippable};
 *  otherwise the filter's own fingerprint. Never returns the input. */
function transformPath(path: string, opts: ResolvedOptions): string {
  for (const root of opts.roots) {
    const rel = relativeUnder(path, root);
    if (rel !== null && isShippable(rel, opts)) return rel;
  }
  return fingerprintString(path, opts.salt);
}

/**
 * Scrub ONE string. Three cases, in order:
 *
 *   1. the whole value is an absolute path  → {@link transformPath};
 *   2. the value CONTAINS absolute paths    → each run transformed in place
 *      (a truncated `halt_reason` quoting a stack frame);
 *   3. otherwise                            → unchanged.
 *
 * Then the fail-closed post-condition: whatever came out of 1–3 must satisfy
 * {@link isShippable}, or the WHOLE string is replaced by a fingerprint. There
 * is no path through this function that returns a value the SG4 arbiter would
 * flag.
 */
function scrubResolved(value: string, opts: ResolvedOptions): string {
  let out: string;
  if (looksAbsolutePath(value) && !value.includes('\n')) {
    out = transformPath(value, opts);
  } else if (SG4_PATH_RE.test(value)) {
    out = value.replace(
      EMBEDDED_PATH_RE,
      (_m, guard: string, path: string) => `${guard}${transformPath(path, opts)}`,
    );
  } else {
    out = value;
  }
  return isShippable(out, opts) ? out : fingerprintString(value, opts.salt);
}

/** {@link scrubResolved} with the caller's options resolved first. */
export function scrubPathString(value: string, options: PathScrubOptions = {}): string {
  return scrubResolved(value, resolveOptions(options));
}

/**
 * Scrub every STRING VALUE in a payload, at any depth, preserving structure.
 *
 * Values only, never keys — keys come from the allowlists and are fixed, and
 * the SG4 check itself only ever inspects string leaves (`scanStrings` in
 * `check-sg4.mjs` recurses into values).
 *
 * The options are resolved ONCE and the resolved form is threaded down, which
 * is not only a performance choice: `ResolvedOptions` names the salt `salt`
 * while `PathScrubOptions` names it `fingerprintSalt`, so re-entering the
 * public entry point per string would silently drop `b18`'s required salt and
 * fingerprint under the empty key. Hence `scrubResolved` exists at all.
 */
export function scrubPayloadPaths<T>(payload: T, options: PathScrubOptions = {}): T {
  const opts = resolveOptions(options);
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return scrubResolved(node, opts);
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(payload) as T;
}

/**
 * The call the two filtering seams make: scrub `filtered` using the roots
 * named by the ORIGINAL (pre-allowlist) payload, plus any the caller knows.
 *
 * Idempotent — a relativized value is not absolute and a `fp:<hash>` is not
 * path-shaped, so the second pass at the wire is a no-op over the first pass
 * at the queue file.
 */
export function scrubFilteredPayload<T>(
  filtered: T,
  original: unknown,
  options: { fingerprintSalt: string; extraRoots?: readonly (string | null | undefined)[] },
): T {
  return scrubPayloadPaths(filtered, {
    roots: collectPathRoots(original, options.extraRoots ?? []),
    fingerprintSalt: options.fingerprintSalt,
  });
}
