// The BUILT-IN worktree provisioner — what `pipeline worktree create` does when
// the repository has authored NO `worktree-create.*` hook (taskflow-v2 a3;
// 02-target-architecture.md §4.2, 04-subsystem-rules.md §3).
//
// It provisions the same three things a consumer create hook returns — a
// worktree, its branch, an env file — plus one worktree per declared submodule.
// It is a straight port of the reference hook this monorepo has run in
// production for months (`.pipeline/.hooks/worktree-create.py`), which is why
// the layout, the branch namespace and the env-file keys match it exactly: a
// repository that adopts the built-in provisioner and one that keeps the hook
// hand a worker the SAME shaped slot.
//
// ── D9: WHO MAY CALL THIS ───────────────────────────────────────────────────
//
// ONLY commands/worktree.ts — the standalone command. NOT the pipeline run
// path. On a run, a missing `worktree-create.*` still HALTS (commands/next.ts,
// via lib/worktree-hooks.ts), exactly as it did before this module existed.
// Filling that branch would turn a loud halt into a silent provision and change
// live behavior for every existing consumer, so this module is deliberately
// NOT imported by commands/next.ts or lib/worktree-hooks.ts, and
// tests/worktree-hook-module.test.ts asserts that absence in the source itself.
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { branchExists, iterWorktrees, type GitRunner } from './git';

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
  const override = (process.env.PIPELINE_WT_ROOT ?? '').trim();
  const base = override
    ? toPosixPath(override)
    : process.platform === 'win32' && existsSync('C:/tmp')
      ? 'C:/tmp/pipeline-worktrees'
      : `${toPosixPath(tmpdir())}/pipeline-worktrees`;
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
