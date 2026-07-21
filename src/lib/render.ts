// Lazy rendered shadow copies for AGENT steps (env-variables design 05 §5,
// D6 — P4/a5).
//
// When (and only when) a run has a frozen PP_* variable map AND the pipeline
// declares variables, the command layer calls renderActionSteps() at action-
// emission time. It produces a per-run substituted copy of the CURRENT step
// file(s) + PIPELINE.md under
//
//     <pipeline_root>/.runtime/<run-id>/rendered/<pipeline-slug>/
//
// mirroring the source layout, and the emitted ActionStep.path points at the
// rendered copy while source_path keeps the author-owned original. Rendering
// is LAZY — re-done from CURRENT source on every action — so mid-run improver
// edits are honored (F5/E3) and a deleted rendered tree self-heals on resume
// (F4).
//
// E12 mechanism (sibling refs) — option (a), full-tree mirror per action:
// only the current step file(s) + PIPELINE.md are SUBSTITUTED, but EVERY
// other non-dot file under the pipeline root (sibling steps, scripts/**,
// fixtures, context modules) is COPIED verbatim into the rendered tree on the
// same action, and stale entries are pruned. A rendered step's RELATIVE
// reference to a sibling (`scripts/notify.py`, `../conventions.md`, another
// step) therefore resolves inside the rendered tree instead of missing.
// Copies are plain file copies (never symlinks — win32, T5: rendered files
// inherit the trust of their sources and stay inside the run's own tree).
// Non-current step files are mirrored RAW (their `${PP_*}` tokens are only
// substituted when they become the dispatched step); an absolute reference
// back into the SOURCE tree likewise reaches raw placeholders — both are the
// documented E10/E12 limitation of per-action substitution.
//
// A small DENYLIST of entry names (.runtime, .feedback, .git, .stats) is
// excluded at every level — the mirror must never descend into .runtime (it
// CONTAINS the rendered tree) and run artifacts/VCS internals are not
// iteration content. It is deliberately NOT a blanket dot-exclusion:
// dot-prefixed content can be legitimate pipeline material (`targets/.common/`
// family-shared docs/scripts are an established convention; `.env.example`
// style fixtures exist) and must mirror so relative refs keep resolving.
//
// Atomicity (F10/T5): every write goes through a sibling temp file + rename,
// so a crash mid-render never leaves a half-substituted file at a path an
// executor might read; a failed rename removes its temp file.
//
// Occurrence re-check (04 §3, 07 P4 gate): before any write, THIS action's
// substitution surfaces are re-scanned against the frozen map. An improver
// may have added a `${PP_OPT}` occurrence (no inline default) for a variable
// left unresolved at init — run-init validation cannot have seen it, and
// substituteText would throw its invariant. The re-check reports every such
// occurrence as an F2-style error message instead (the command layer halts
// the run cleanly); the engine throw remains defense-in-depth only.
//
// Discipline: lib module — imports only lib/substitution + node builtins;
// never reads process.env (the frozen map is an injected parameter, D9).

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { scanOccurrences, substituteText, type ResolvedVars } from './substitution';

// Entry names excluded from the mirror at EVERY level (denylist, see module
// header): run-scoped artifact trees + VCS internals. `.runtime` is the hard
// invariant — the rendered tree lives inside it, so descending would recurse
// into our own output. Exact names only (`.gitignore` etc. still mirror).
const EXCLUDED_ENTRY_RE = /^\.(?:runtime|feedback|git|stats)$/;

function isExcludedEntry(name: string): boolean {
  return EXCLUDED_ENTRY_RE.test(name);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** The rendered tree root for one run:
 *  `<pipeline_root>/.runtime/<run-id>/rendered/<pipeline-slug>/` (05 §5).
 *  The slug is the pipeline folder's basename, so the rendered tree mirrors
 *  the source layout one level down and paths stay self-describing. */
export function renderedRootFor(pipelineRootAbs: string, runId: string): string {
  return join(pipelineRootAbs, '.runtime', runId, 'rendered', basename(pipelineRootAbs));
}

/** Inverse of renderedRootFor: if `p` points INTO this run's rendered tree
 *  (`<root>/.runtime/<run-id>/rendered/<slug>/…`), return its author-owned
 *  SOURCE counterpart `<root>/<rel>`; otherwise return `p` unchanged.
 *
 *  Why it exists: a step dispatched from its RENDERED copy has its executor read
 *  that copy, so a `## Next` link (`<pipeline-root>/steps/NN.md`) resolves
 *  RELATIVE to the rendered location and the reported `next_iteration` is a
 *  rendered path. Feeding that back verbatim (a) misses the plan step — plan
 *  steps key by SOURCE path, so the engine synthesizes an OFF-PLAN step — and
 *  (b) is judged out-of-root by relUnder (it lives under the `.runtime`
 *  denylist) and so is dispatched UNRENDERED with `${PP_*}` never substituted:
 *  the "multi-step pipeline with variables halts at step 2" defect. Mapping it
 *  back to the source restores the invariant that the engine's current_path /
 *  an ActionStep.source_path is ALWAYS an author source, so the next dispatch
 *  re-renders it normally. resolve()+relative() normalize separators and (win32)
 *  drive-letter case, so a `C:/…` next_iteration matches a `C:\…` root. A no-op
 *  for every path NOT under THIS run's rendered root: source paths, the
 *  PIPELINE_COMPLETE sentinel, and cross-pipeline (family/hub) hand-offs. */
export function sourcePathForRendered(pipelineRootAbs: string, runId: string, p: string): string {
  const rootAbs = resolve(pipelineRootAbs);
  const rel = relative(renderedRootFor(rootAbs, runId), resolve(p));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return p;
  return join(rootAbs, rel);
}

/** Relative path of `p` under `rootAbs`, or null when `p` is not inside the
 *  root OR crosses an excluded entry (runtime artifacts / VCS dirs are never
 *  mirrored, and `.runtime/...` must never be re-rendered into itself).
 *  Case-insensitive on win32 via node's path.relative. */
function relUnder(rootAbs: string, p: string): string | null {
  const rel = relative(rootAbs, resolve(p));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (rel.split(sep).some(isExcludedEntry)) return null;
  return rel;
}

/** POSIX-separated display form of a root-relative path (matches the plan /
 *  run-init lint labels: 'PIPELINE.md', 'steps/01-a.md'). */
function posixRel(rel: string): string {
  return rel.split(sep).join('/');
}

/** Case-normalized map key for a root-relative path (win32 paths compare
 *  case-insensitively — same rule as lib/next.ts samePath). */
function relKey(rel: string): string {
  const p = posixRel(rel);
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

// ---------------------------------------------------------------------------
// Frontmatter split (raw, byte-preserving)
// ---------------------------------------------------------------------------

// The exact frontmatter shape lib/frontmatter.ts parses — kept in lockstep so
// what the plan treats as frontmatter is exactly what rendering preserves RAW.
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Split a raw file text into its raw frontmatter block (both `---` fences
 *  included, byte-preserved — rendering NEVER substitutes frontmatter, D5)
 *  and the body (the substitution surface). No frontmatter ⇒ fm '' + whole
 *  text as body. */
export function splitRawFrontmatter(raw: string): { frontmatterRaw: string; body: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { frontmatterRaw: '', body: raw };
  return { frontmatterRaw: m[0], body: raw.slice(m[0].length) };
}

/** Newline count (CRLF-safe) — the body's line offset inside the file. */
function newlineCount(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** 1-based line of a UTF-16 offset (counts '\n'; CRLF-safe). */
function lineOf(text: string, index: number): number {
  let line = 1;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ---------------------------------------------------------------------------
// Render-time occurrence re-check (04 §3)
// ---------------------------------------------------------------------------

/** Occurrences in `body` that substituteText could NOT render from `vars` —
 *  i.e. no frozen value AND no inline default. Mirrors substituteText's own
 *  resolution test exactly (scan/substitute parity: both run the same
 *  single-pass grammar), so an empty return GUARANTEES the substitution below
 *  cannot throw. Returns formatted `file:line` bullet lines. */
function renderBlockers(
  body: string,
  bodyLineOffset: number,
  vars: ResolvedVars,
  fileLabel: string,
): string[] {
  const out: string[] = [];
  for (const occ of scanOccurrences(body, fileLabel)) {
    if (hasOwn(vars, occ.name) && typeof vars[occ.name] === 'string') continue;
    if (occ.inlineDefault !== undefined) continue;
    out.push(
      `  \`${occ.raw}\` at ${fileLabel}:${bodyLineOffset + lineOf(body, occ.index)} — ` +
        `\`${occ.name}\` has no frozen value and the occurrence carries no inline default`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Atomic writes (F10)
// ---------------------------------------------------------------------------

let tmpSeq = 0;

/** Temp-file + rename replace: a crash mid-write never leaves a partial file
 *  at `dest` (rename replaces atomically on both win32 and POSIX in node/bun
 *  — the lib/script-step.ts writeJsonAtomic pattern). The temp name carries a
 *  pid+sequence suffix: a fixed `.tmp` suffix would COLLIDE with a real
 *  source file named `<sibling>.tmp` mid-mirror (its fresh copy would be
 *  clobbered by the sibling's temp, readdir-order-dependently). A failed
 *  rename removes its temp file before rethrowing; a crashed temp has no
 *  source counterpart and is pruned on the next render pass. */
function atomicReplace(dest: string, produce: (tmp: string) => void): void {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}-${++tmpSeq}.render-tmp`;
  produce(tmp);
  try {
    renameSync(tmp, dest);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort — the leftover is pruned on the next render pass
    }
    throw e;
  }
}

function writeFileAtomic(dest: string, content: string): void {
  atomicReplace(dest, (tmp) => writeFileSync(tmp, content, 'utf8'));
}

function copyFileAtomic(src: string, dest: string): void {
  atomicReplace(dest, (tmp) => copyFileSync(src, tmp));
}

// ---------------------------------------------------------------------------
// Mirror walk + prune
// ---------------------------------------------------------------------------

/** stat() projected to the two facts the walkers need; null = missing/
 *  unreadable. Follows symlinks (statSync), so a symlinked file reports
 *  isFile — copy-by-content, never a symlink (win32, E12). */
function statKind(p: string): { isDir: boolean; isFile: boolean } | null {
  try {
    const st = statSync(p);
    return { isDir: st.isDirectory(), isFile: st.isFile() };
  } catch {
    return null;
  }
}

/** Recursively mirror `srcDir` into `destDir`, copying every non-excluded
 *  file verbatim EXCEPT the prepared substitution surfaces (written from
 *  `contentByKey` instead). Symlinked files are copied by content; symlinked
 *  directories are skipped (cycle safety — prefer copy over symlink, E12). */
function mirrorDir(
  srcDir: string,
  destDir: string,
  relDir: string,
  contentByKey: Map<string, string>,
): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (isExcludedEntry(entry.name)) continue;
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    const rel = relDir === '' ? entry.name : join(relDir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const st = statKind(srcPath);
      if (st === null) continue; // dangling symlink — nothing to mirror
      isDir = false; // never follow a directory symlink (cycle safety)
      isFile = st.isFile;
    }
    if (isDir) {
      mirrorDir(srcPath, destPath, rel, contentByKey);
      continue;
    }
    if (!isFile) continue;
    const prepared = contentByKey.get(relKey(rel));
    if (prepared !== undefined) writeFileAtomic(destPath, prepared);
    else copyFileAtomic(srcPath, destPath);
  }
}

/** Remove rendered-tree entries with no live source counterpart (a source
 *  file deleted mid-run must not linger as a stale ghost a relative ref could
 *  still resolve; leftover temp files from a crashed render die here too).
 *  Operates STRICTLY inside the CLI-owned rendered tree. */
function pruneDir(destDir: string, srcDir: string): void {
  let entries;
  try {
    entries = readdirSync(destDir, { withFileTypes: true });
  } catch {
    return; // nothing rendered yet
  }
  for (const entry of entries) {
    const destPath = join(destDir, entry.name);
    // Excluded names are stale by definition (the mirror never writes them).
    const srcStat = isExcludedEntry(entry.name) ? null : statKind(join(srcDir, entry.name));
    if (entry.isDirectory()) {
      if (srcStat?.isDir) pruneDir(destPath, join(srcDir, entry.name));
      else rmSync(destPath, { recursive: true, force: true });
    } else if (!srcStat?.isFile) {
      rmSync(destPath, { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface RenderStepsInput {
  /** Absolute pipeline root (the source tree). */
  pipelineRootAbs: string;
  runId: string;
  /** Absolute SOURCE paths of the agent step files this action dispatches
   *  (the substitution surfaces alongside PIPELINE.md). */
  stepSources: string[];
  /** The run's FROZEN PP_* map (never a live env read, D9/D11). */
  vars: ResolvedVars;
}

export type RenderStepsResult =
  | {
      ok: true;
      /** Rendered absolute path per stepSources entry (aligned by index);
       *  null = that source lies outside the pipeline root (off-plan
       *  hub/family step) and stays unrendered — the caller keeps
       *  `path === source_path` for it. */
      rendered: Array<string | null>;
    }
  | {
      ok: false;
      /** The complete F2-style halt text (names every blocking occurrence
       *  with file:line + the remedy) or the I/O failure description. */
      reason: string;
    };

/** Render this action's substitution surfaces + mirror the pipeline tree —
 *  see the module header for the full contract. Never throws: every failure
 *  (blocking occurrence, unreadable source, unwritable rendered dir) returns
 *  `{ok:false}` for the command layer to halt on cleanly. */
export function renderActionSteps(input: RenderStepsInput): RenderStepsResult {
  const rootAbs = resolve(input.pipelineRootAbs);
  // Defense in depth: a stepSource that is ITSELF a path into this run's
  // rendered tree (a rendered `next_iteration` that reached here, e.g. a
  // crash-resume replaying buggy persisted state) means its SOURCE counterpart
  // — map it back so relUnder classifies it INSIDE the root and it renders,
  // instead of being rejected as an out-of-root `.runtime` path and dispatched
  // UNRENDERED. A no-op for the normal case (stepSources are already source
  // paths — the command layer maps `next_iteration` back before the engine).
  const rels = input.stepSources.map((p) =>
    relUnder(rootAbs, sourcePathForRendered(rootAbs, input.runId, p)),
  );
  if (!rels.some((r) => r !== null)) {
    // Every dispatched file lives outside the pipeline root — nothing to
    // render, no tree work (the caller keeps source paths).
    return { ok: true, rendered: rels };
  }
  const renderedRoot = renderedRootFor(rootAbs, input.runId);

  // Substitution surfaces: PIPELINE.md + each in-root step file (deduped).
  const surfaceRels = new Map<string, string>(); // key -> rel
  surfaceRels.set(relKey('PIPELINE.md'), 'PIPELINE.md');
  for (const rel of rels) if (rel !== null) surfaceRels.set(relKey(rel), rel);

  // Read + re-check + substitute every surface BEFORE any write: a blocked or
  // unreadable surface fails the whole action with zero tree mutations.
  const contentByKey = new Map<string, string>(); // relKey -> rendered content
  const blockers: string[] = [];
  for (const [key, rel] of surfaceRels) {
    const label = posixRel(rel);
    let raw: string;
    try {
      raw = readFileSync(join(rootAbs, rel), 'utf8');
    } catch (e) {
      return {
        ok: false,
        reason: `rendered copy of ${label} could not be produced — source unreadable: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const { frontmatterRaw, body } = splitRawFrontmatter(raw);
    const fileBlockers = renderBlockers(body, newlineCount(frontmatterRaw), input.vars, label);
    if (fileBlockers.length) {
      blockers.push(...fileBlockers);
      continue;
    }
    try {
      // Frontmatter rides RAW (byte-preserved); only the body is substituted.
      contentByKey.set(key, frontmatterRaw + substituteText(body, input.vars));
    } catch (e) {
      // Unreachable by scan/substitute parity — defense in depth only.
      blockers.push(`  ${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (blockers.length) {
    return {
      ok: false,
      reason:
        'Unresolved pipeline variables at render time — the source gained occurrences after ' +
        "the run's variables were frozen (D11):\n" +
        blockers.join('\n') +
        '\n' +
        'Frozen values cannot change mid-run: add an inline default to the new occurrence ' +
        '(e.g. ${PP_X:-value}) and resume, or start a new run supplying the variable via ' +
        '--var / the environment.',
    };
  }

  // Prune stale entries first (shape changes, deleted sources, crashed .tmp
  // leftovers), then mirror the current tree (E12 mechanism (a)).
  try {
    pruneDir(renderedRoot, rootAbs);
    mkdirSync(renderedRoot, { recursive: true });
    mirrorDir(rootAbs, renderedRoot, '', contentByKey);
  } catch (e) {
    return {
      ok: false,
      reason: `rendered copies could not be written under ${renderedRoot}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return {
    ok: true,
    rendered: rels.map((rel) => (rel === null ? null : join(renderedRoot, rel))),
  };
}
