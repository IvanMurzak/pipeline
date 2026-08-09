// The BUILT-IN worktree provisioner AND its teardown — what `pipeline worktree
// create` / `destroy` do when the repository has authored NO `worktree-create.*`
// / `worktree-destroy.*` hook (taskflow-v2 a3 + a5; 02-target-architecture.md
// §4.2, 03-execution-flows.md F7, 04-subsystem-rules.md §3).
//
// It provisions the same three things a consumer create hook returns — a
// worktree, its branch, an env file — plus one worktree per declared submodule.
// It is a straight port of the reference hook this monorepo has run in
// production for months (`.pipeline/.hooks/worktree-create.py`), which is why
// the layout, the branch namespace and the env-file keys match it exactly: a
// repository that adopts the built-in provisioner and one that keeps the hook
// hand a worker the SAME shaped slot.
//
// ── WHAT IT MAKES, IT ALSO REAPS (a5 / F-7) ─────────────────────────────────
//
// a3 shipped the create half alone, which left a hook-less repository able to
// PROVISION a slot and unable to DESTROY it: `03-execution-flows.md` F7 step 4
// is `pipeline worktree destroy`, and `08-user-workflows.md`'s release gate is
// that no journey requires the user to write a hook. `teardownSlot` below
// closes that: it undoes exactly what `provisionSlot` did — the parent
// worktree, every submodule worktree, the `worktree-<name>` branch in each of
// those repositories when `delete_branches` says so, and the env file. Port
// reservations are released by the command (lib/port-alloc.ts owns them and
// the hook path releases them the same way).
//
// THE SYMMETRY RULE, and it is the command that enforces it: a slot record
// carries `provisioner: 'hook' | 'builtin'`, and the built-in teardown runs for
// a `builtin` slot ONLY. A hook provisioned its slot with bookkeeping this CLI
// cannot see — registrations, branches, env files it never wrote — so reaping
// one from here would silently orphan it. The reverse is equally true and is
// why a repository that grew a `worktree-destroy.*` after a built-in create
// gets the HOOK: whichever side is asked to tear a slot down must be the side
// that can describe what is there.
//
// ── D9: WHO MAY CALL THIS ───────────────────────────────────────────────────
//
// ONLY commands/worktree.ts — the standalone command. NOT the pipeline run
// path. On a run, a missing `worktree-create.*` still HALTS (commands/next.ts,
// via lib/worktree-hooks.ts), exactly as it did before this module existed, and
// a missing `worktree-destroy.*` still reports a failed teardown there rather
// than falling through to the built-in. Filling either branch would turn a loud
// failure into a silent one and change live behavior for every existing
// consumer, so this module is deliberately NOT imported by commands/next.ts or
// lib/worktree-hooks.ts, and tests/worktree-hook-module.test.ts asserts that
// absence in the source itself — for the teardown as well as the provisioner.
//
// A repository that HAS a create hook never reaches this module at all: the
// hook resolves, runs, and wins.
//
// ── R10: MULTI-CHECKOUT SUBMODULES, TREATED AS UNSUPPORTED-BUT-WORKING ──────
//
// git's own documentation calls multiple checkouts of a superproject
// experimental and its submodule support incomplete. A submodule's gitdir
// carries `core.worktree` pointing back at the MAIN checkout, and that config
// is SHARED with every linked worktree of that submodule — so the catastrophic
// failure mode is a slot that silently resolves back to the main checkout,
// where a worker's commits would land in the user's real tree.
//
// Two mitigations, both mandatory:
//
//   1. A MINIMUM GIT VERSION (`MIN_GIT_VERSION`), checked before anything is
//      created. Below it the command fails with a stated reason instead of
//      producing a broken slot.
//   2. A `rev-parse --show-toplevel` ASSERTION on every slot — the parent's and
//      each submodule's — before it is returned. A slot whose toplevel is not
//      the slot itself is REFUSED, never returned, and never deleted (deleting
//      a directory that resolves into the main checkout is precisely the
//      accident being guarded against).
//
// ── PORTS (a4) ──────────────────────────────────────────────────────────────
//
// A worktree isolates files, not TCP ports, so every slot also gets a
// contiguous block of free ones (lib/port-alloc.ts owns the allocator). They
// are written into the ENV FILE, which is the channel the frozen contract
// leaves for them — the create-hook JSON calls `ports`/`port_base`
// informational and the run path never reads them.
//
// ── THE ENV FILE'S GRAMMAR IS NARROWER THAN THE PARSER'S ────────────────────
//
// The file is read by TWO consumers: lib/env-file.ts's `parseEnvFile` (tolerant
// — it strips quotes and trims), and shell steps that do `set -a && source`
// (not tolerant at all). A value with a space, a quote or a backslash parses
// fine and then breaks the shell consumer, so every value written here must
// match `ENV_VALUE_RE`: unquoted, space-free, metacharacter-free. A value that
// cannot satisfy it FAILS the provision with a stated reason rather than being
// quoted, truncated, or silently dropped. That is also why paths are written
// with forward slashes on every platform — a backslash is an escape character
// to `source`.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { branchExists, iterWorktrees, type GitRunner } from './git';
import { allocatePorts, portEnvEntries, reservationDirFor, resolvePortRange } from './port-alloc';

// ---------------------------------------------------------------------------
// The git-version floor (R10)
// ---------------------------------------------------------------------------

/** Minimum git for the built-in provisioner: **2.20.0**.
 *
 *  Everything this module actually invokes is far older (`worktree add/list
 *  --porcelain/prune` are 2.5–2.7 era). The floor is set by the SUBMODULE
 *  multi-checkout arrangement instead: 2.20 is where git gained per-worktree
 *  configuration (`extensions.worktreeConfig` / `git config --worktree`), the
 *  mechanism by which a linked worktree stops inheriting the main checkout's
 *  `core.worktree` wholesale. Below that era a submodule slot's redirect back
 *  into the main checkout is the documented broken case, and this provisioner
 *  refuses rather than producing it.
 *
 *  It is a floor, not a guarantee — git still documents the arrangement as
 *  incomplete at every version — which is why `assertToplevel` runs on ANY
 *  version. */
export const MIN_GIT_VERSION: readonly [number, number, number] = [2, 20, 0];

export const MIN_GIT_VERSION_TEXT = MIN_GIT_VERSION.join('.');

const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?/;

/** Parse `git version 2.45.1.windows.1` → `[2,45,1]`; null when unparseable. */
export function parseGitVersion(raw: string): [number, number, number] | null {
  const m = VERSION_RE.exec(raw);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function ge(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

/** null when the installed git is new enough; otherwise the reason to fail.
 *  An UNPARSEABLE version is also a refusal: a provisioner that cannot tell
 *  whether it is above the floor must not gamble a slot on it. */
export function checkGitVersion(git: GitRunner): string | null {
  const r = git(['--version']);
  const raw = (r.stdout || r.stderr).trim();
  if (r.code !== 0) {
    return `could not run git --version (exit ${r.code}): ${raw || 'no output'}`;
  }
  const parsed = parseGitVersion(raw);
  if (!parsed) {
    return `could not parse the git version from '${raw}' — the built-in worktree provisioner requires git ${MIN_GIT_VERSION_TEXT} or newer`;
  }
  if (!ge(parsed, MIN_GIT_VERSION)) {
    return (
      `git ${parsed.join('.')} is older than the ${MIN_GIT_VERSION_TEXT} minimum the built-in worktree provisioner requires ` +
      `(git's multi-checkout support for submodules is incomplete below it, and a submodule slot can resolve back into the main checkout). ` +
      `Upgrade git, or author a worktree-create.* hook — a hook always wins over the provisioner.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// The env-file grammar (narrower than parseEnvFile's)
// ---------------------------------------------------------------------------

/** Keys must be shell-sourceable identifiers. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Values: an ALLOW-list, never a blocklist. Letters, digits, and the handful
 *  of punctuation characters a path/branch/port needs — `.` `_` `-` `/` `:`
 *  `+` `@` `,` `=` `~`. Excludes by construction: whitespace of any kind, `\`,
 *  quotes, `` ` ``, `$`, `;` `|` `&` `<` `>` `(` `)` `{` `}` `[` `]` `*` `?`
 *  `!` `#` `^` `%` and control characters — i.e. everything that changes
 *  meaning under `set -a && source`. Empty is legal (`KEY=`).
 *
 *  `~` is allowed INSIDE a value and refused at the two positions where a shell
 *  would expand it (see `TILDE_EXPANDS_RE`). Blanket-refusing it would make the
 *  provisioner unusable on Windows, whose 8.3 short paths — `RUNNER~1`,
 *  `PROGRA~1` — are everywhere, including on GitHub's Windows runners. */
export const ENV_VALUE_RE = /^[A-Za-z0-9._:/+@,~=-]*$/;

/** Where bash performs tilde expansion inside an ASSIGNMENT: at the start of
 *  the value, and immediately after a `:` (the PATH-style rule). `A~1` in the
 *  middle of a path segment is a literal, which is why 8.3 names survive. */
const TILDE_EXPANDS_RE = /(^~|:~)/;

/** null when `key`/`value` may be written unquoted; otherwise the reason. */
export function unsafeEnvEntry(key: string, value: string): string | null {
  if (!ENV_KEY_RE.test(key)) return `env key '${key}' is not a shell identifier`;
  if (!ENV_VALUE_RE.test(value)) {
    // Name the offender without echoing an unbounded value.
    const bad = [...value].find((c) => !ENV_VALUE_RE.test(c)) ?? '';
    const shown = bad === ' ' ? 'a space' : bad === '\\' ? 'a backslash' : `'${bad}'`;
    return (
      `env value for ${key} contains ${shown}, which cannot be written unquoted ` +
      `(the env file is also read with \`set -a && source\`)`
    );
  }
  if (TILDE_EXPANDS_RE.test(value)) {
    return `env value for ${key} contains a '~' where a shell would expand it (at the start, or after a ':')`;
  }
  return null;
}

/** Render the dotenv body. Ordered, one `KEY=VALUE` per line, values UNQUOTED
 *  on purpose — see the module header. */
export function renderEnvFile(values: ReadonlyArray<readonly [string, string]>): string {
  const lines = ['# generated by `pipeline worktree create` — do not edit by hand'];
  for (const [k, v] of values) lines.push(`${k}=${v}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Forward slashes on every platform: the env file is `source`d, where a
 *  backslash is an escape character. git accepts this spelling on win32. */
export function toPosixPath(p: string): string {
  return resolve(p).replace(/\\/g, '/');
}

/** Case-folded, separator-normalized form for path COMPARISON only. */
function norm(p: string): string {
  const r = toPosixPath(p).replace(/\/+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** True when `p` is `dir` or lives beneath it. */
export function isUnder(p: string, dir: string): boolean {
  const a = norm(p);
  const b = norm(dir);
  return a === b || a.startsWith(b + '/');
}

/** The OS's canonical spelling of `p`, resolved through the nearest ancestor
 *  that exists (so it works for a slot that has not been created yet).
 *
 *  `realpathSync.NATIVE`, not `realpathSync`, and the difference is the whole
 *  reason this function exists: on Windows a path can carry 8.3 short segments
 *  (`RUNNER~1`, `PROGRA~1` — GitHub's Windows runner hands out exactly that as
 *  TEMP), plain `realpathSync` leaves them alone, and **git always prints the
 *  long form**. Comparing our constructed path against git's answer would then
 *  mismatch on every slot: the reuse probe would never recognize its own slot,
 *  and the R10 toplevel assertion would refuse a perfectly good one.
 *
 *  Best-effort: any failure returns the path unchanged. */
function canonicalExisting(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return toPosixPath(abs); // nothing on this path exists
    tail.unshift(basename(cur));
    cur = parent;
  }
  try {
    return toPosixPath([realpathSync.native(cur), ...tail].join('/'));
  } catch {
    return toPosixPath(abs);
  }
}

/** `pipeline-protocol` → `PIPELINE_PROTOCOL` (the `SUBMODULE_DIR_<NAME>` key). */
function envKeyOf(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
}

/** Filesystem-safe form of a submodule basename. */
function slugOf(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** A repository-relative submodule path, allow-listed: letters, digits, `.`,
 *  `_`, `-` and `/` separators, no `..` segment, no leading `/`. null when the
 *  path is acceptable, else the reason. Refuses (by construction) drive
 *  letters, backslashes, whitespace and shell metacharacters — the entry
 *  becomes both a path under the project and an unquoted env-file value. */
export function invalidSubmodulePath(rel: string): string | null {
  if (!rel) return 'must not be empty';
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(rel)) {
    return "must match [A-Za-z0-9._][A-Za-z0-9._/-]* — a repository-relative path with '/' separators and no whitespace, backslashes or shell metacharacters";
  }
  if (rel.split('/').some((seg) => seg === '..' || seg === '')) return "must not contain a '..' or empty path segment";
  return null;
}

/** The directory EVERY project's slot root lives under — `PIPELINE_WT_ROOT`
 *  when set, else `C:/tmp/pipeline-worktrees` on Windows when `C:/tmp` exists
 *  (short, space-free), else the system temp dir's.
 *
 *  Machine-wide by default, which is what makes it the right home for the port
 *  reservation registry (lib/port-alloc.ts): the deterministic base is derived
 *  from the SLOT NAME alone, and slot names are task ids — two different
 *  projects both provisioning `a4` want the same first candidate block. A
 *  per-project registry would not see that; this one does. */
export function slotRootBase(): string {
  const override = (process.env.PIPELINE_WT_ROOT ?? '').trim();
  return canonicalExisting(
    override
      ? override
      : process.platform === 'win32' && existsSync('C:/tmp')
        ? 'C:/tmp/pipeline-worktrees'
        : `${tmpdir()}/pipeline-worktrees`,
  );
}

/** Where slots live: `<base>/<project-slug>/`.
 *
 *  OUTSIDE the repository, always — a worker's `node_modules`, build output and
 *  test droppings must never appear in the project folder (04 §2). The base is
 *  `PIPELINE_WT_ROOT` when set (the same variable the reference hook honors),
 *  else `C:/tmp` on Windows when it exists (short, space-free), else the system
 *  temp dir.
 *
 *  The `<project-slug>` segment — the project's basename plus 8 hex of a hash
 *  of its canonical path — is what keeps two DIFFERENT projects that both
 *  provision a slot called `a3` off each other's directory. */
export function slotRootFor(projectRoot: string): string {
  const base = slotRootBase();
  const canonical = norm(projectRoot);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 8);
  const label = slugOf(basename(canonical) || 'project').slice(0, 24) || 'project';
  return `${base}/${label}-${digest}`;
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface ProvisionRequest {
  /** The slot name — ALREADY validated by the command against SG6 before it
   *  reaches a path or a branch (T14). */
  name: string;
  /** `--base`: the branch the parent slot is cut from. */
  base_branch: string;
  /** `--submodules`: repository-relative submodule paths, as declared. */
  submodules: string[];
  /** The consumer project root (the command passes `process.cwd()`). */
  projectRoot: string;
  /** How many contiguous ports this slot gets (`--ports`, defaulted by the
   *  command). 0 provisions a slot with no ports at all — the env file then
   *  carries no `PORT_*` key rather than a zero one. */
  ports: number;
}

export interface ProvisionedSubmodule {
  /** The path as declared on `--submodules`. */
  path: string;
  /** Its basename — the `SUBMODULE_DIR_<NAME>` key stem. */
  name: string;
  /** The submodule's own slot directory. */
  dir: string;
  /** The submodule's INTEGRATION branch — what its slot was cut from and what
   *  its pull request targets. `next` where that branch exists, else the
   *  parent's base. */
  base: string;
}

export interface ProvisionOutcome {
  ok: boolean;
  /** The same three fields a create hook returns, so the command's JSON is one
   *  shape whichever produced it. null on failure. */
  provisioned: { worktree_path: string; branch: string; env_file: string } | null;
  submodule_slots: ProvisionedSubmodule[];
  /** The parent slot was already provisioned and was re-reported (idempotence
   *  per name, the same contract a create hook honors). */
  reused: boolean;
  /** The allocated port block, or null when `ports: 0` was asked for. The
   *  authoritative copy is in the ENV FILE — this is the same numbers, saved
   *  the caller a re-read. */
  ports: { base: number; ports: number[] } | null;
  detail: string | null;
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function refExists(git: GitRunner, repo: string, ref: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', ref], repo).code === 0;
}

/** The start point for a fresh branch: the fetched remote tip when there is
 *  one, else the local branch. Never the parent's pinned commit. */
function startPoint(git: GitRunner, repo: string, base: string): string | null {
  if (refExists(git, repo, `refs/remotes/origin/${base}`)) return `origin/${base}`;
  if (refExists(git, repo, `refs/heads/${base}`)) return base;
  return null;
}

/** Registered worktree paths of `repo`, normalized for comparison. */
function registered(git: GitRunner, repo: string): Set<string> {
  return new Set(iterWorktrees(git, repo).map((w) => norm(w.path)));
}

/** OPT-IN network. Off by default: `pipeline worktree create` must never hang
 *  on an unreachable or credential-prompting remote. `PIPELINE_WT_FETCH=1`
 *  turns it on for an orchestrator that wants the freshest tip. Best-effort
 *  either way — a failed fetch is not a failed provision. */
function maybeFetch(git: GitRunner, repo: string, refspec?: string): void {
  if ((process.env.PIPELINE_WT_FETCH ?? '').trim() !== '1') return;
  git(refspec ? ['fetch', '--quiet', 'origin', refspec] : ['fetch', '--quiet', 'origin'], repo);
}

/** R10's hard gate: the slot must BE its own working tree. A `core.worktree`
 *  inherited from a submodule's main checkout that resolves back into the
 *  project is the catastrophic case — a worker would commit into the user's
 *  real tree believing it was isolated. Returns the refusal reason, or null.
 *
 *  Nothing is deleted on refusal, deliberately: the suspect directory may BE
 *  the main checkout. */
function assertToplevel(git: GitRunner, slot: string, label: string): string | null {
  const r = git(['rev-parse', '--show-toplevel'], slot);
  const top = r.stdout.trim();
  if (r.code !== 0 || !top) {
    return `refusing the ${label} slot ${toPosixPath(slot)}: git could not resolve its working tree (${(r.stderr || r.stdout).trim() || `exit ${r.code}`})`;
  }
  if (norm(top) !== norm(slot)) {
    return (
      `refusing the ${label} slot ${toPosixPath(slot)}: it resolves to ${toPosixPath(top)} instead of itself ` +
      `(a core.worktree redirect into another checkout — git's submodule support for multiple checkouts is incomplete). Nothing was deleted.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// The provisioner
// ---------------------------------------------------------------------------

/** Provision (or re-report) the slot for `req.name`.
 *
 *  IDEMPOTENT per name, like the hook contract it stands in for: a slot that is
 *  already registered and on disk is reused and re-reported, and its env file
 *  is rewritten.
 *
 *  Failure NEVER deletes: a half-provisioned slot is evidence, a retry reuses
 *  what survived, and `pipeline gc` reaps the rest. */
export function provisionSlot(req: ProvisionRequest, git: GitRunner): ProvisionOutcome {
  const fail = (detail: string, submodule_slots: ProvisionedSubmodule[] = []): ProvisionOutcome => ({
    ok: false,
    provisioned: null,
    submodule_slots,
    reused: false,
    ports: null,
    detail,
  });

  // ---- preflight: git version (R10) ---------------------------------------
  const versionProblem = checkGitVersion(git);
  if (versionProblem) return fail(versionProblem);

  // ---- preflight: the project is a git repo, anchored on GIT's spelling ----
  // git prints the long canonical path; Windows hands out 8.3 short segments
  // that realpathSync does not expand, and every comparison below (and every
  // value in the env file) has to agree with `git worktree list`.
  const top = git(['rev-parse', '--show-toplevel'], req.projectRoot);
  if (top.code !== 0 || !top.stdout.trim()) {
    return fail(
      `not a git repository: ${toPosixPath(req.projectRoot)} — the built-in worktree provisioner needs one ` +
        `(a worktree-create.* hook, if you have one, is used instead and may not)`,
    );
  }
  const repoTop = toPosixPath(top.stdout.trim());

  // ---- preflight: the slot root ------------------------------------------
  const slotRoot = slotRootFor(repoTop);
  if (!isAbsolute(slotRoot)) return fail(`PIPELINE_WT_ROOT must be an absolute path (got '${slotRoot}')`);
  if (isUnder(slotRoot, repoTop)) {
    return fail(
      `refusing to provision inside the repository: the slot root ${slotRoot} is under ${repoTop}. ` +
        `Worktree slots live OUTSIDE the project so a worker's build artifacts never land in it — set PIPELINE_WT_ROOT elsewhere.`,
    );
  }
  // Both paths that reach the env file are checked BEFORE anything is created:
  // failing after `git worktree add` would leave a slot behind for a problem
  // known up front.
  const rootProblem = unsafeEnvEntry('WORKTREE_PATH', `${slotRoot}/${req.name}`);
  if (rootProblem) {
    return fail(
      `${rootProblem}. The slot root is ${slotRoot} — set PIPELINE_WT_ROOT to a path with no spaces or shell metacharacters.`,
    );
  }
  const topProblem = unsafeEnvEntry('PROJECT_ROOT', repoTop);
  if (topProblem) {
    return fail(
      `${topProblem}. The project is at ${repoTop} — the built-in provisioner cannot describe it in an unquoted env file; ` +
        `author a worktree-create.* hook (which wins over the provisioner) if the project must live at that path.`,
    );
  }

  const branch = `worktree-${req.name}`;
  const slotPath = `${slotRoot}/${req.name}`;
  const envFile = `${slotRoot}/${req.name}.env`;

  // ---- the parent slot ----------------------------------------------------
  git(['worktree', 'prune'], repoTop); // drop records from earlier crashed runs
  let reused = false;
  if (registered(git, repoTop).has(norm(slotPath)) && existsSync(slotPath)) {
    reused = true;
  } else {
    maybeFetch(git, repoTop, req.base_branch);
    mkdirSync(dirname(slotPath), { recursive: true });
    let add;
    if (branchExists(git, repoTop, branch)) {
      // Resume after a crash: the branch survived, the worktree did not.
      add = git(['worktree', 'add', slotPath, branch], repoTop);
    } else {
      const start = startPoint(git, repoTop, req.base_branch);
      if (start === null) {
        return fail(`base branch '${req.base_branch}' not found locally or on origin in ${repoTop}`);
      }
      add = git(['worktree', 'add', '-b', branch, slotPath, start], repoTop);
    }
    if (add.code !== 0) {
      return fail(`git worktree add failed (exit ${add.code}): ${(add.stderr || add.stdout).trim()}`);
    }
  }

  const parentProblem = assertToplevel(git, slotPath, 'worktree');
  if (parentProblem) return fail(parentProblem);

  // ---- one slot per declared submodule ------------------------------------
  const slots: ProvisionedSubmodule[] = [];
  for (const rel of req.submodules) {
    // T14's sibling: `--submodules` is untrusted text that becomes a path under
    // the project and a value in the env file. Allow-listed BEFORE it is joined
    // to anything — the hook path is untouched by this (a hook receives
    // PIPELINE_WT_SUBMODULES verbatim, exactly as it always has).
    const bad = invalidSubmodulePath(rel);
    if (bad) return fail(`invalid --submodules entry '${rel}': ${bad}`, slots);
  }
  for (const rel of req.submodules) {
    const r = provisionSubmodule(git, { repoTop, rel, slotRoot, name: req.name, branch, base: req.base_branch });
    if ('error' in r) return fail(r.error, slots);
    slots.push(r.slot);
  }

  // ---- ports (a4) ---------------------------------------------------------
  // AFTER the worktree exists, deliberately: the reservation a block is
  // claimed with names this slot's path as its liveness proof, and a
  // reservation pointing at a directory that does not exist yet would read as
  // stale to every other process the moment it was written.
  let portBlock: { base: number; ports: number[] } | null = null;
  if (req.ports > 0) {
    const range = resolvePortRange();
    if ('error' in range) return fail(range.error, slots);
    const alloc = allocatePorts({
      name: req.name,
      count: req.ports,
      reservationDir: reservationDirFor(slotRootBase()),
      livePath: slotPath,
      range,
    });
    if (!alloc.ok) return fail(alloc.detail, slots);
    portBlock = { base: alloc.base, ports: alloc.ports };
  }

  // ---- the env file -------------------------------------------------------
  const values: Array<[string, string]> = [
    // There is no run on this path; the slot name stands in, exactly as
    // PIPELINE_WT_RUN_ID does for the standalone command (commands/worktree.ts).
    ['RUN_ID', req.name],
    ['WORKTREE_NAME', req.name],
    ['WORKTREE_PATH', slotPath],
    ['WORKTREE_BRANCH', branch],
    ['PROJECT_ROOT', repoTop],
    ['BASE_BRANCH', req.base_branch],
  ];
  // The ports go in the FILE — that is the channel. The create-hook JSON calls
  // `ports`/`port_base` informational and the run path reads three keys that do
  // not include them (docs/worktree-hook-contract.md), so a slot's ports are
  // real exactly insofar as they are written here.
  if (portBlock) values.push(...portEnvEntries(portBlock.base, portBlock.ports.length));
  if (slots.length) {
    values.push(['SUBMODULE_COUNT', String(slots.length)]);
    slots.forEach((s, i) => {
      const n = i + 1;
      values.push([`SUBMODULE_${n}_PATH`, s.path]);
      values.push([`SUBMODULE_${n}_NAME`, s.name]);
      values.push([`SUBMODULE_${n}_DIR`, s.dir]);
      values.push([`SUBMODULE_${n}_BASE`, s.base]);
      // By-name lookup, so a step can use "$SUBMODULE_DIR_PIPELINE_PROTOCOL"
      // without knowing the provisioning order.
      values.push([`SUBMODULE_DIR_${envKeyOf(s.name)}`, s.dir]);
      values.push([`SUBMODULE_BASE_${envKeyOf(s.name)}`, s.base]);
    });
  }
  for (const [k, v] of values) {
    const problem = unsafeEnvEntry(k, v);
    if (problem) return fail(`${problem} — the env file is written unquoted, so the slot is refused rather than mis-written`, slots);
  }
  try {
    mkdirSync(dirname(envFile), { recursive: true });
    writeFileSync(envFile, renderEnvFile(values), 'utf8');
  } catch (e) {
    return fail(`could not write the env file ${envFile}: ${String((e as Error).message ?? e)}`, slots);
  }

  return {
    ok: true,
    provisioned: { worktree_path: slotPath, branch, env_file: envFile },
    submodule_slots: slots,
    reused,
    ports: portBlock,
    detail: null,
  };
}

/** One submodule slot.
 *
 *  `<repoTop>/<rel>` is a fully initialized submodule — its own repository with
 *  its own `origin` — so it gets a STANDALONE worktree of that repository, cut
 *  from ITS integration branch. Not `git submodule update` inside the parent
 *  slot (that yields a detached HEAD which cannot carry a branch or a pull
 *  request), and not the commit the parent pins (the pin trails the submodule,
 *  and the work is merged into the tip of what it targets). */
function provisionSubmodule(
  git: GitRunner,
  ctx: { repoTop: string; rel: string; slotRoot: string; name: string; branch: string; base: string },
): { slot: ProvisionedSubmodule } | { error: string } {
  const { repoTop, rel, slotRoot, name, branch, base } = ctx;
  const src = `${repoTop}/${rel}`;
  if (!existsSync(`${src}/.git`)) {
    return {
      error: `submodule '${rel}' is not initialised in ${repoTop} — run \`git submodule update --init -- ${rel}\` first`,
    };
  }
  const label = basename(rel);
  const dir = `${slotRoot}/${name}--${slugOf(label)}`;

  git(['worktree', 'prune'], src);
  // A full fetch, not just `base`: resolving the integration branch needs
  // `refs/remotes/origin/<integration>` to be present. Opt-in, like the parent.
  maybeFetch(git, src);

  const resolvedBase = integrationBranchFor(git, src, base);

  if (!(registered(git, src).has(norm(dir)) && existsSync(dir))) {
    mkdirSync(dirname(dir), { recursive: true });
    let add;
    if (branchExists(git, src, branch)) {
      add = git(['worktree', 'add', dir, branch], src);
    } else {
      const start = startPoint(git, src, resolvedBase);
      if (start === null) {
        return { error: `submodule '${rel}': branch '${resolvedBase}' not found locally or on origin in ${src}` };
      }
      add = git(['worktree', 'add', '-b', branch, dir, start], src);
    }
    if (add.code !== 0) {
      return { error: `submodule '${rel}': git worktree add failed (exit ${add.code}): ${(add.stderr || add.stdout).trim()}` };
    }
  }

  const problem = assertToplevel(git, dir, `submodule '${rel}'`);
  if (problem) return { error: problem };

  return { slot: { path: rel, name: label, dir, base: resolvedBase } };
}

/** The branch a submodule's work is cut from and merged back into.
 *
 *  `PIPELINE_WT_INTEGRATION_BRANCH` (default `next`) when the submodule HAS
 *  that branch, else the parent's base. Branch EXISTENCE is deliberately the
 *  switch, because it is also the owner's lever: a plugin repo whose
 *  marketplace installs from `main` gets `next` created in it, and every run's
 *  pull request is routed there instead — `main` moves only when the owner
 *  fast-forwards it. A package repo with no `next` targets `main` as usual.
 *
 *  Both `refs/remotes/origin/<b>` and `refs/heads/<b>` count: a submodule
 *  checkout that has never fetched still knows its own local branches. */
export function integrationBranchFor(git: GitRunner, submoduleRepo: string, base: string): string {
  const wanted = (process.env.PIPELINE_WT_INTEGRATION_BRANCH ?? '').trim() || 'next';
  if (wanted === base) return base;
  if (refExists(git, submoduleRepo, `refs/remotes/origin/${wanted}`)) return wanted;
  if (refExists(git, submoduleRepo, `refs/heads/${wanted}`)) return wanted;
  return base;
}

// ---------------------------------------------------------------------------
// The built-in TEARDOWN (a5 / F-7)
// ---------------------------------------------------------------------------

/** One submodule slot to reap: the declared path plus the directory the
 *  provisioner cut for it. The caller takes both from the SLOT RECORD rather
 *  than recomputing them, so a slot is reaped where it was made even if
 *  `PIPELINE_WT_ROOT` moved between create and destroy. */
export interface TeardownSubmodule {
  /** Repository-relative submodule path, as it was declared on `--submodules`. */
  path: string;
  /** That submodule's slot directory. */
  dir: string;
}

export interface TeardownRequest {
  /** The slot name — already SG6-validated by the command. */
  name: string;
  /** The parent slot's worktree, from the slot record. */
  worktreePath: string;
  /** The slot's branch, from the record. `worktree-<name>` when absent. */
  branch: string | null;
  /** The env file the provisioner wrote, from the record. */
  envFile: string | null;
  submodules: TeardownSubmodule[];
  /** The consumer project root (the command passes `process.cwd()`). */
  projectRoot: string;
  /** `PIPELINE_WT_DELETE_BRANCHES` in the frozen contract's terms: true on a
   *  COMPLETED teardown, false otherwise. */
  deleteBranches: boolean;
}

export interface TeardownOutcome {
  /** Everything asked for is gone. False leaves the slot record in place —
   *  a half-reaped slot must stay nameable, or it becomes a leak with no
   *  handle. */
  ok: boolean;
  /** Worktrees that WERE there and are not any more (parent first). A slot
   *  already gone is not listed — a retry must not claim a second removal. */
  removed_worktrees: string[];
  /** `<repo>: <branch>` per branch actually deleted. */
  removed_branches: string[];
  removed_env_file: string | null;
  /** What survived, and why. Non-empty exactly when `ok` is false. */
  kept: Array<{ path: string; reason: string }>;
  /** The refusal/failure summary; null when ok. */
  detail: string | null;
}

/** The branch namespace this teardown may delete in — the same one
 *  `provisionSlot` creates in. A record naming anything else describes a branch
 *  this module did not make, and it is kept rather than guessed at. */
const OWNED_BRANCH_RE = /^worktree-[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when two spellings name the same path. `norm` alone is not enough on
 *  Windows: git prints the LONG canonical path while a recorded 8.3 segment
 *  (`RUNNER~1` — GitHub's Windows TEMP) survives `resolve()` untouched, so a
 *  registered worktree would not be recognized as its own slot and the removal
 *  would silently miss. `realpathSync.native` is what expands it. */
function samePath(a: string, b: string): boolean {
  if (norm(a) === norm(b)) return true;
  const native = (p: string): string => {
    try {
      return norm(realpathSync.native(p));
    } catch {
      return norm(p);
    }
  };
  return native(a) === native(b);
}

/** True when `p` is too close to a filesystem root to be a slot.
 *
 *  A slot lives at `<slot root>/<project-slug>/<name>` — at least two segments
 *  below the root. The slot record is a plain JSON file on disk that a crash, a
 *  bad merge or a text editor can shorten, and `rmSync(recursive)` over `C:/`
 *  or `/home` on the strength of one is not a risk worth carrying when the
 *  check costs three lines.
 *
 *  EXPORTED for `pipeline gc` (a8), which reaps slots outside the repository
 *  too and must refuse on exactly this rule rather than on a second copy of
 *  it — a guard that exists twice is a guard that can disagree with itself. */
export function tooShallowToDelete(p: string): boolean {
  const body = toPosixPath(p)
    .replace(/^[A-Za-z]:\//, '')
    .replace(/^\/+/, '');
  return body.split('/').filter(Boolean).length < 2;
}

/** Remove ONE slot worktree from `repo` — the parent's, or a submodule's.
 *
 *  Three cases, in order:
 *    * registered with git → `git worktree remove --force` (the record and the
 *      directory die together, which `rmSync` alone cannot do);
 *    * a directory with no registration (crash debris, or a `worktree remove`
 *      that half-ran) → deleted directly;
 *    * neither → nothing to do, and NOT reported as a removal, so a retry after
 *      a partial failure does not claim work it did not perform.
 *
 *  `existed:false` distinguishes the third case for the caller. */
function removeSlotWorktree(
  git: GitRunner,
  repo: string,
  slotPath: string,
  repoTop: string,
  label: string,
): { ok: true; existed: boolean } | { ok: false; reason: string } {
  // Two refusals before anything is deleted. The built-in provisioner only ever
  // creates slots OUTSIDE the project (it fails the create otherwise), so a
  // record naming a path inside it describes something this module did not
  // make — and deleting the user's checkout is the one mistake with no undo.
  if (isUnder(slotPath, repoTop)) {
    return {
      ok: false,
      reason: `refusing to delete the ${label} ${toPosixPath(slotPath)}: it is inside the repository ${toPosixPath(repoTop)}, and the built-in provisioner never creates a slot there`,
    };
  }
  if (isUnder(process.cwd(), slotPath)) {
    return {
      ok: false,
      reason: `refusing to delete the ${label} ${toPosixPath(slotPath)}: it is (or contains) the current working directory`,
    };
  }
  if (tooShallowToDelete(slotPath)) {
    return {
      ok: false,
      reason: `refusing to delete the ${label} ${toPosixPath(slotPath)}: a slot lives at <root>/<project>/<name> and this path is too close to a filesystem root to be one`,
    };
  }

  git(['worktree', 'prune'], repo); // drop records whose directory already went
  const registered = iterWorktrees(git, repo).find((w) => samePath(w.path, slotPath));
  const onDisk = existsSync(slotPath);
  if (!registered && !onDisk) return { ok: true, existed: false };

  if (registered) {
    // `--force`: the slot is a machine-made scratch checkout and a worker's
    // uncommitted droppings must not strand it. Git still refuses when the
    // directory is LOCKED or in use — the Windows case — and that refusal is
    // returned rather than worked around.
    const rm = git(['worktree', 'remove', '--force', registered.path], repo);
    if (rm.code !== 0) {
      return {
        ok: false,
        reason: `git worktree remove failed for the ${label} ${toPosixPath(slotPath)} (exit ${rm.code}): ${(rm.stderr || rm.stdout).trim() || 'no output'}`,
      };
    }
  }
  if (existsSync(slotPath)) {
    try {
      rmSync(slotPath, { recursive: true, force: true });
    } catch (e) {
      return {
        ok: false,
        reason: `could not delete the ${label} directory ${toPosixPath(slotPath)}: ${String((e as Error).message ?? e)}`,
      };
    }
  }
  git(['worktree', 'prune'], repo);
  return { ok: true, existed: true };
}

/** Delete the slot's branch in `repo`, when `delete_branches` says so.
 *
 *  `-D`, not `-d`, and deliberately: a run branch is routinely SQUASH-merged,
 *  which reads as "unmerged" to git forever, so a safe delete could never reap
 *  a landed slot and DoD 1's "no branch left behind" would be unachievable. The
 *  blast radius is bounded instead — only the machine-owned `worktree-*`
 *  namespace this provisioner creates in, only on `--outcome completed` (a
 *  halted slot keeps its branch, which is the whole point of halting), and only
 *  after the worktree holding it was successfully removed. */
function deleteSlotBranch(git: GitRunner, repo: string, branch: string): { deleted: boolean; reason: string | null } {
  if (!OWNED_BRANCH_RE.test(branch)) {
    return { deleted: false, reason: `branch '${branch}' is outside the machine-owned worktree-* namespace — left alone` };
  }
  if (!branchExists(git, repo, branch)) return { deleted: false, reason: null };
  const del = git(['branch', '-D', branch], repo);
  if (del.code !== 0) {
    return { deleted: false, reason: `git branch -D ${branch} failed (exit ${del.code}): ${(del.stderr || del.stdout).trim() || 'no output'}` };
  }
  return { deleted: true, reason: null };
}

/** Reap the slot `provisionSlot` made.
 *
 *  BEST-EFFORT ACROSS PARTS, ALL-OR-NOTHING ABOUT THE RECORD: each worktree is
 *  attempted even if an earlier one failed (a slot half on disk is worse than a
 *  slot mostly gone), a branch is only deleted once its own worktree is
 *  actually gone, and the env file — the channel that DESCRIBES the slot — is
 *  removed only when nothing is left to describe. Any failure returns
 *  `ok: false`, which is the caller's signal to KEEP the slot record so the
 *  teardown can be retried by name.
 *
 *  It is idempotent: a second call over an already-reaped slot succeeds and
 *  reports no removals. */
export function teardownSlot(req: TeardownRequest, git: GitRunner): TeardownOutcome {
  const removed_worktrees: string[] = [];
  const removed_branches: string[] = [];
  const kept: Array<{ path: string; reason: string }> = [];
  let removed_env_file: string | null = null;

  const top = git(['rev-parse', '--show-toplevel'], req.projectRoot);
  if (top.code !== 0 || !top.stdout.trim()) {
    return {
      ok: false,
      removed_worktrees,
      removed_branches,
      removed_env_file,
      kept: [{ path: toPosixPath(req.projectRoot), reason: 'not a git repository' }],
      detail:
        `not a git repository: ${toPosixPath(req.projectRoot)} — the built-in worktree teardown needs one ` +
        `(a worktree-destroy.* hook, if you have one, is used instead and may not)`,
    };
  }
  const repoTop = toPosixPath(top.stdout.trim());
  const branch = req.branch ?? `worktree-${req.name}`;

  /** One repository's half of the teardown: its worktree, then its branch. */
  const reap = (repo: string, slotPath: string, label: string): void => {
    const r = removeSlotWorktree(git, repo, slotPath, repoTop, label);
    if (!r.ok) {
      kept.push({ path: toPosixPath(slotPath), reason: r.reason });
      return;
    }
    if (r.existed) removed_worktrees.push(toPosixPath(slotPath));
    if (!req.deleteBranches) return;
    const b = deleteSlotBranch(git, repo, branch);
    if (b.deleted) removed_branches.push(`${toPosixPath(repo)}: ${branch}`);
    else if (b.reason) kept.push({ path: `${toPosixPath(repo)}#${branch}`, reason: b.reason });
  };

  // The parent first — it is the slot a worker actually sat in, and the one an
  // operator watching a failed teardown cares most about.
  reap(repoTop, req.worktreePath, 'worktree');

  // Then one per submodule, each removed from THAT submodule's repository (a
  // submodule slot is a worktree of the submodule, not of the superproject —
  // `git worktree remove` run in the parent would not know it).
  for (const sub of req.submodules) {
    reap(`${repoTop}/${sub.path}`, sub.dir, `submodule '${sub.path}' slot`);
  }

  // The env file describes the slot. While any part of the slot survives, so
  // must its description.
  if (req.envFile !== null && kept.length === 0 && existsSync(req.envFile)) {
    if (isUnder(req.envFile, repoTop)) {
      // The built-in provisioner writes its env file beside the slot, outside
      // the repository. One inside it is not ours to delete.
      kept.push({
        path: toPosixPath(req.envFile),
        reason: `refusing to delete the env file: it is inside the repository ${repoTop}, and the built-in provisioner writes its env file beside the slot`,
      });
    } else {
      try {
        unlinkSync(req.envFile);
        removed_env_file = toPosixPath(req.envFile);
      } catch (e) {
        kept.push({
          path: toPosixPath(req.envFile),
          reason: `could not delete the env file: ${String((e as Error).message ?? e)}`,
        });
      }
    }
  }

  const ok = kept.length === 0;
  return {
    ok,
    removed_worktrees,
    removed_branches,
    removed_env_file,
    kept,
    detail: ok
      ? null
      : `the built-in teardown could not reap ${kept.length === 1 ? 'one part' : `${kept.length} parts`} of slot '${req.name}': ` +
        kept.map((k) => `${k.path} — ${k.reason}`).join('; ') +
        `. The slot record is kept so the teardown can be retried by name once the cause is cleared.`,
  };
}

/** Where `provisionSlot` would have put the slot directory of submodule `rel`
 *  for a slot whose PARENT worktree is `worktreePath`.
 *
 *  The fallback for slot records written before the submodule directories were
 *  recorded in them (a3's shape). Derived from the parent's own path rather
 *  than from `PIPELINE_WT_ROOT`, because the record is what the slot actually
 *  is and the environment variable is only what it would be today. */
export function derivedSubmoduleSlotDir(worktreePath: string, name: string, rel: string): string {
  return `${toPosixPath(dirname(worktreePath))}/${name}--${slugOf(basename(rel))}`;
}
