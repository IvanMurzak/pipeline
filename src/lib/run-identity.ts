// run-identity — the deterministic "which pipeline, which project" identity a
// run should emit at start, computed locally with zero LLM and zero network.
//
// Two opaque ids come out of here, matched to the cloud eval schema so the
// emitted values round-trip into the ingest store VERBATIM (private repo,
// ai-pipeline):
//
//   • pipeline CONTENT HASH  → cloud `pipeline_version`   (a.k.a. registry /
//     lease `content_hash`): SHA-256 over the pipeline's DEFINING files
//     (`PIPELINE.md` + `steps/**` + `scripts/**`). The self-improvement loop
//     edits pipelines between runs, so results from different content must never
//     be pooled — the hash IS the pipeline version identity shared across evals,
//     the registry, and composition. Wire format: `sha256:<hex>`.
//       evidence: apps/api/src/db/migrations/003_runs.sql:116-118 (column +
//       "content hash over PIPELINE.md + steps/** + scripts/**"),
//       apps/api/src/modules/runs/ingest.ts:606 (`pipeline_version`, alias
//       `pipeline_hash`), packages/protocol/src/wire/server.ts:38-41
//       (`content_hash`), ARCHITECTURE.md §Evaluation.
//
//   • salted PROJECT FINGERPRINT → cloud `project_fingerprint`: an HMAC-SHA-256
//     of a STABLE project identifier (git remote if present, else the absolute
//     project path) keyed by a salt. Privacy-preserving and non-reversible: the
//     cloud groups analytics per-project without ever learning the raw path or
//     private repo name. Wire format: `fp:<hex>` (or `fp:<label>:<hex>` when the
//     caller opts a PUBLIC label in).
//       evidence: apps/api/src/db/migrations/003_runs.sql:120-121,
//       apps/api/src/modules/runs/ingest.ts:607 (`project_fingerprint`),
//       apps/api/src/modules/runs/ingest.test.ts:57 (`"fp:acme-api:9a8b7c"`),
//       ARCHITECTURE.md §Evaluation ("salted hash for private repos").
//
// This is a PURE LIBRARY. Importing it runs nothing — every function is inert
// until called. Emission wiring (into `pipeline next`, skills, hooks) is
// deliberately NOT here; it would drag in a lockstep event/records contract and
// a plugin.json bump. Node stdlib only (no deps): node:crypto, node:fs, node:path.

import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, resolve, isAbsolute } from 'node:path';

// ── Wire/format constants (the cloud-aligned framing) ────────────────────────

/** Hash algorithm for both ids — the `sha256:`/`fp:` framings assume this. */
export const HASH_ALGO = 'sha256';

/** Prefix on the pipeline content hash to form the cloud `pipeline_version` /
 *  registry `content_hash` value (e.g. `sha256:2f7c9a…`). Matches the values
 *  seen in ai-pipeline (`ingest.test.ts` `"sha256:2f7c9a"`, `server.test.ts`
 *  `"sha256:abc"`). Cloud column caps `pipeline_version` at 200 chars; ours is
 *  `sha256:` + 64 hex = 71 chars, well under. */
export const PIPELINE_VERSION_PREFIX = 'sha256:';

/** Prefix on the project fingerprint to form the cloud `project_fingerprint`
 *  value. `fp:<hex>` by default; `fp:<label>:<hex>` when a public label is given
 *  (matches `"fp:acme-api:9a8b7c"`). Cloud column caps it at 500 chars. */
export const FINGERPRINT_PREFIX = 'fp:';

/** Env var read as the fingerprint salt when the caller passes none. Set this to
 *  a per-INSTALL secret for real privacy (see DEFAULT_FINGERPRINT_SALT). */
export const FINGERPRINT_SALT_ENV = 'PIPELINE_FINGERPRINT_SALT';

/**
 * Fallback salt when neither an explicit salt nor `PIPELINE_FINGERPRINT_SALT` is
 * present. A PUBLIC constant only guarantees a STABLE, well-framed fingerprint —
 * it is NOT a privacy secret (anyone with this repo could hash a guessed
 * remote/path under it). For unlinkable fingerprints on private repos, supply a
 * per-install secret salt via the env var or the `salt` argument. Documented,
 * not defended against here (the raw path/name still never leaves the machine —
 * only its keyed hash does).
 */
export const DEFAULT_FINGERPRINT_SALT = 'claude-pipeline/run-identity/v1';

// ── Public result shape ──────────────────────────────────────────────────────

/**
 * The identity a run emits at start. The snake_case keys are EXACTLY the cloud
 * wire fields (spread them straight into a `run.started` event `data`); the
 * camelCase keys are ergonomic aliases / raw components.
 *
 * Mapping (round-trips into ai-pipeline ingest):
 *   pipeline_version    === PIPELINE_VERSION_PREFIX + pipelineContentHash
 *   project_fingerprint === projectFingerprint (=== FINGERPRINT_PREFIX + [label:] + projectFingerprintHash)
 */
export interface RunIdentity {
  /** CLOUD `runs.pipeline_version` (registry/lease `content_hash`): `sha256:<hex>`. */
  pipeline_version: string;
  /** CLOUD `runs.project_fingerprint`: `fp:<hex>` or `fp:<label>:<hex>`. */
  project_fingerprint: string;
  /** Bare lowercase hex of the pipeline content hash (no `sha256:` prefix). */
  pipelineContentHash: string;
  /** Ergonomic alias of `project_fingerprint` (identical string). */
  projectFingerprint: string;
  /** Bare lowercase hex of the fingerprint (no `fp:`/label framing). */
  projectFingerprintHash: string;
  /** The stable project identifier the fingerprint was computed over, AFTER
   *  canonicalization — a git remote like `github.com/org/name`, or the
   *  POSIX-normalized absolute project path when no remote was found. Exposed
   *  for debugging ONLY: it MAY contain the raw path, so it is never emitted. */
  projectIdentifier: string;
  /** Sorted POSIX-relative paths of every file folded into the content hash. */
  hashedFiles: string[];
}

// ── Content hash ─────────────────────────────────────────────────────────────

export interface ContentHashOptions {
  /**
   * Normalize CRLF → LF before hashing (default TRUE). The repo (and most
   * consumer projects) is `.gitattributes` LF-normalized, but a Windows checkout
   * without that config would store CRLF and hash DIFFERENTLY for byte-identical
   * logical content. Normalizing CRLF→LF makes the version hash stable across
   * OS/checkout line-ending differences — a line-ending-only diff is not a
   * semantic pipeline change. Only CRLF is collapsed (git-aligned); a lone CR is
   * preserved, so a stray 0x0D in a rare binary asset is not silently rewritten.
   */
  normalizeEol?: boolean;
  /** Injectable byte reader (default `readFileSync`) — lets tests avoid real fs. */
  readFile?: (absPath: string) => Buffer;
  /** Injectable file enumerator (default: fs walk of PIPELINE.md + steps/** +
   *  scripts/**), returning ABSOLUTE paths. Order does not matter — the hash
   *  sorts by relative path itself. */
  listFiles?: (pipelineRoot: string) => string[];
}

/** CRLF → LF only (git-aligned). Binary-preserving for every non-CR byte and for
 *  lone CRs; returns the input untouched when it contains no CR at all. */
function normalizeEolBytes(buf: Buffer): Buffer {
  if (!buf.includes(0x0d)) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // Drop a CR only when it is immediately followed by LF (i.e. a CRLF pair).
    if (b === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) continue;
    out[j++] = b;
  }
  return out.subarray(0, j);
}

function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

/** Recursively push every regular file under `dir` (any extension, incl. dot
 *  files) into `out`. Missing dir / unreadable entries are skipped, never
 *  thrown — a pipeline without a `scripts/` tree simply contributes nothing. */
function walkFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(full, out);
    else if (st.isFile()) out.push(full);
  }
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Enumerate the pipeline's DEFINING files — `PIPELINE.md` at the root plus every
 * file under `steps/**` and `scripts/**` — as absolute paths, sorted by their
 * POSIX-relative path (so enumeration order is deterministic and OS-independent).
 * Nothing inside those trees is excluded. A custom `listFiles` overrides the fs
 * walk (its output is still sorted by relative path here).
 */
export function collectPipelineFiles(
  pipelineRoot: string,
  listFiles?: (root: string) => string[],
): string[] {
  const files: string[] = [];
  if (listFiles) {
    files.push(...listFiles(pipelineRoot));
  } else {
    const manifest = join(pipelineRoot, 'PIPELINE.md');
    if (isRegularFile(manifest)) files.push(manifest);
    walkFiles(join(pipelineRoot, 'steps'), files);
    walkFiles(join(pipelineRoot, 'scripts'), files);
  }
  return files.sort((a, b) => {
    const ra = toPosixRel(pipelineRoot, a);
    const rb = toPosixRel(pipelineRoot, b);
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}

/**
 * Hash a fixed set of files into one manifest digest. For each file (in sorted
 * relative-path order) we fold a `"<relpath>\0<sha256(bytes)>\n"` line into the
 * outer hash:
 *   - SORTED relative paths ⇒ ORDER-INDEPENDENT (fs enumeration order is moot).
 *   - the relative PATH is part of every line ⇒ a rename changes the hash.
 *   - the per-file content DIGEST is fixed-length hex delimited by `\0`/`\n`
 *     (a relpath can hold neither) ⇒ no boundary ambiguity can collide two
 *     different file sets.
 *   - paths are POSIX-normalized ⇒ the same tree hashes identically on any OS.
 */
function hashFileSet(
  pipelineRoot: string,
  absFiles: string[],
  options: ContentHashOptions = {},
): string {
  const readFile = options.readFile ?? ((p: string) => readFileSync(p));
  const normalize = options.normalizeEol !== false; // default on
  const manifest = createHash(HASH_ALGO);
  for (const abs of absFiles) {
    const rel = toPosixRel(pipelineRoot, abs);
    let bytes = readFile(abs);
    if (normalize) bytes = normalizeEolBytes(bytes);
    const fileDigest = createHash(HASH_ALGO).update(bytes).digest('hex');
    manifest.update(rel, 'utf8');
    manifest.update('\0', 'utf8');
    manifest.update(fileDigest, 'utf8');
    manifest.update('\n', 'utf8');
  }
  return manifest.digest('hex');
}

/**
 * The pipeline content hash — a deterministic lowercase-hex SHA-256 over
 * `PIPELINE.md` + `steps/**` + `scripts/**` under `pipelineRoot`. Prefix with
 * `PIPELINE_VERSION_PREFIX` to get the cloud `pipeline_version` wire value.
 *
 * Deterministic, order-independent, rename-sensitive, and OS-stable (see
 * `hashFileSet` / `ContentHashOptions.normalizeEol`). A root with no defining
 * files yields the hash of the empty manifest (a stable constant), never a throw.
 */
export function computePipelineContentHash(
  pipelineRoot: string,
  options: ContentHashOptions = {},
): string {
  return hashFileSet(pipelineRoot, collectPipelineFiles(pipelineRoot, options.listFiles), options);
}

// ── Project fingerprint ──────────────────────────────────────────────────────

export interface ResolveIdentifierOptions {
  /** Supply the git remote URL directly (skips all fs). `null` forces the
   *  path fallback; `undefined` (absent) triggers the default `.git/config` read. */
  gitRemoteUrl?: string | null;
  /** Injectable `.git/config` reader (given the project dir → config text or
   *  null). Default reads `<projectPath>/.git/config`, resolving a `.git` FILE
   *  (worktree/submodule) via its `gitdir:`/`commondir` pointers. */
  readGitConfig?: (projectPath: string) => string | null;
  /** Which remote to prefer (default `origin`). */
  remoteName?: string;
  /** Canonicalize the remote URL for clone-method stability (default TRUE): the
   *  same repo cloned via SSH or HTTPS yields ONE identifier, and embedded
   *  credentials are stripped. */
  canonicalize?: boolean;
}

/**
 * Canonicalize a git remote URL to `host/path` (no scheme, no credentials, no
 * trailing `.git`), lowercased for stability. Handles both scheme URLs
 * (`https://user:pw@github.com/org/name.git`) and scp-like shorthand
 * (`git@github.com:org/name.git`). Falls back to the trimmed input if it parses
 * as neither.
 */
export function canonicalizeGitRemote(url: string): string {
  const raw = url.trim();
  let host = '';
  let path = '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    // Scheme URL — parse with the stdlib URL (drops any user:pass automatically
    // once we read only `.host`).
    try {
      const u = new URL(raw);
      host = u.host;
      path = u.pathname;
    } catch {
      return stripDotGit(raw).toLowerCase();
    }
  } else {
    // scp-like: [user@]host:path  (no `//`).
    const m = /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(raw);
    if (m) {
      host = m[1];
      path = m[2];
    } else {
      return stripDotGit(raw).toLowerCase();
    }
  }
  const cleanPath = stripDotGit(path).replace(/^\/+/, '').replace(/\/+$/, '');
  return `${host}/${cleanPath}`.replace(/\/+/g, '/').toLowerCase();
}

function stripDotGit(s: string): string {
  return s.replace(/\.git$/i, '');
}

/** Parse the first `url = …` under `[remote "<name>"]` from `.git/config` text. */
function parseGitRemoteUrl(configText: string, remoteName = 'origin'): string | null {
  let inSection = false;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = /^\[remote\s+"([^"]+)"\]$/.exec(line);
    if (header) {
      inSection = header[1] === remoteName;
      continue;
    }
    if (line.startsWith('[')) {
      inSection = false;
      continue;
    }
    if (inSection) {
      const m = /^url\s*=\s*(.+)$/.exec(line);
      if (m) return m[1].trim();
    }
  }
  return null;
}

/** Best-effort `.git/config` reader. Handles a `.git` DIRECTORY (normal clone)
 *  and a `.git` FILE (worktree/submodule — `gitdir:` pointer, then `commondir`
 *  where the shared config lives). Any failure ⇒ null (caller falls back to the
 *  path). Purely fs, no `git` subprocess. */
function defaultReadGitConfig(projectPath: string): string | null {
  try {
    const dotGit = join(projectPath, '.git');
    if (!existsSync(dotGit)) return null;
    let gitDir = dotGit;
    if (statSync(dotGit).isFile()) {
      const pointer = readFileSync(dotGit, 'utf8');
      const m = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
      if (!m) return null;
      let gd = m[1].trim();
      if (!isAbsolute(gd)) gd = resolve(projectPath, gd);
      gitDir = gd;
      const commonPath = join(gitDir, 'commondir');
      if (existsSync(commonPath)) {
        let cd = readFileSync(commonPath, 'utf8').trim();
        if (!isAbsolute(cd)) cd = resolve(gitDir, cd);
        gitDir = cd;
      }
    }
    const cfgPath = join(gitDir, 'config');
    return existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a STABLE project identifier for `projectPath`: the git remote URL when
 * one is discoverable (canonicalized by default), else the POSIX-normalized
 * absolute project path. Deterministic and fully injectable — pass
 * `gitRemoteUrl` or `readGitConfig` so tests never touch a real repo.
 *
 * NOTE: the returned string MAY be the raw path — it is the fingerprint's INPUT,
 * not its output. Only its keyed hash is ever emitted.
 */
export function resolveProjectIdentifier(
  projectPath: string,
  options: ResolveIdentifierOptions = {},
): string {
  const abs = resolve(projectPath);
  let remote: string | null | undefined = options.gitRemoteUrl;
  if (remote === undefined) {
    const read = options.readGitConfig ?? defaultReadGitConfig;
    const cfg = read(abs);
    remote = cfg ? parseGitRemoteUrl(cfg, options.remoteName ?? 'origin') : null;
  }
  if (remote) {
    return options.canonicalize === false ? remote.trim() : canonicalizeGitRemote(remote);
  }
  return abs.split(sep).join('/');
}

/**
 * The salted project fingerprint CORE (bare lowercase hex): HMAC-SHA-256 of the
 * identifier keyed by the salt. HMAC is a keyed, non-reversible construction —
 * the identifier (path/remote) cannot be recovered from the digest without the
 * salt. Deterministic: same (identifier, salt) ⇒ same hex; a different salt ⇒ a
 * fully different hex (salt-sensitivity). Frame it with `formatFingerprint` (or
 * use `computeRunIdentity`) to get the `fp:` wire value.
 */
export function computeProjectFingerprint(identifier: string, salt: string): string {
  return createHmac(HASH_ALGO, salt).update(identifier, 'utf8').digest('hex');
}

/** A caller-supplied PUBLIC label is an explicit choice to expose a name (e.g.
 *  an org-visible `org/name`). Strip our `:` delimiter + whitespace and cap the
 *  length so it can never break the `fp:<label>:<hex>` framing or blow the cloud
 *  500-char column. */
function sanitizeLabel(label: string): string {
  return label
    .replace(/[\s:]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

/** Frame a bare fingerprint hex into the cloud `fp:<hex>` / `fp:<label>:<hex>`
 *  wire value. */
export function formatFingerprint(fingerprintHex: string, visibleLabel?: string): string {
  const label = visibleLabel ? sanitizeLabel(visibleLabel) : '';
  return FINGERPRINT_PREFIX + (label ? `${label}:` : '') + fingerprintHex;
}

/** Salt precedence: explicit `salt` → `env[PIPELINE_FINGERPRINT_SALT]` →
 *  `DEFAULT_FINGERPRINT_SALT`. Empty strings are treated as absent. */
function resolveSalt(salt: string | undefined, env: Record<string, string | undefined>): string {
  if (salt !== undefined && salt !== '') return salt;
  const fromEnv = env[FINGERPRINT_SALT_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return DEFAULT_FINGERPRINT_SALT;
}

// ── Composed run identity ────────────────────────────────────────────────────

export interface RunIdentityOptions {
  /** Pipeline root (holds `PIPELINE.md` + `steps/` [+ `scripts/`]). */
  pipelineRoot: string;
  /**
   * The project's stable identifier, supplied directly (fully pure — tests use
   * this). When omitted it is resolved from `projectPath` via
   * `resolveProjectIdentifier`.
   */
  projectIdentifier?: string;
  /**
   * The project directory, used to resolve `projectIdentifier` (git remote →
   * absolute path) when `projectIdentifier` is absent. Defaults to
   * `process.cwd()` (read at CALL time only — importing this module reads
   * nothing).
   */
  projectPath?: string;
  /** Fingerprint salt (see `resolveSalt` precedence). */
  salt?: string;
  /** OPTIONAL public label for the fingerprint (`fp:<label>:<hex>`) — an
   *  explicit org-visible name for a PUBLIC repo. NEVER pass the raw local path;
   *  omitted ⇒ fully opaque `fp:<hex>`. */
  visibleLabel?: string;
  /** Forwarded to the content hash (EOL normalization, injectable fs/list). */
  contentHash?: ContentHashOptions;
  /** Forwarded to `resolveProjectIdentifier` (git-config injection) when
   *  `projectIdentifier` is not supplied. */
  identifier?: ResolveIdentifierOptions;
  /** Environment for the salt default (injectable; defaults to `process.env`). */
  env?: Record<string, string | undefined>;
}

/**
 * Compute the full run identity to emit at run start. Pure and deterministic for
 * a given set of inputs. The returned snake_case keys (`pipeline_version`,
 * `project_fingerprint`) are the exact ai-pipeline ingest fields; spread them
 * into a `run.started` event `data` and they round-trip verbatim.
 */
export function computeRunIdentity(options: RunIdentityOptions): RunIdentity {
  const { pipelineRoot } = options;

  const absFiles = collectPipelineFiles(pipelineRoot, options.contentHash?.listFiles);
  const pipelineContentHash = hashFileSet(pipelineRoot, absFiles, options.contentHash ?? {});
  const hashedFiles = absFiles.map((abs) => toPosixRel(pipelineRoot, abs));

  const projectIdentifier =
    options.projectIdentifier ??
    resolveProjectIdentifier(options.projectPath ?? process.cwd(), options.identifier);

  const salt = resolveSalt(options.salt, options.env ?? process.env);
  const projectFingerprintHash = computeProjectFingerprint(projectIdentifier, salt);
  const projectFingerprint = formatFingerprint(projectFingerprintHash, options.visibleLabel);

  return {
    pipeline_version: PIPELINE_VERSION_PREFIX + pipelineContentHash,
    project_fingerprint: projectFingerprint,
    pipelineContentHash,
    projectFingerprint,
    projectFingerprintHash,
    projectIdentifier,
    hashedFiles,
  };
}
