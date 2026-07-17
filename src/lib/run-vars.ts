// PP_* run-init variable plumbing — the command-layer composition seam of the
// env-variables design (05 §3, P2). This module owns everything BETWEEN the
// pure engine (lib/substitution.ts, a1 — grammar/resolution/validation) and
// the commands that expose the flags (`pipeline next` / `drive` / `step run`):
//
//   - `--var NAME=value` folding (repeatable; first-`=` split via a1's
//     parseVarAssignment) and the strict `--vars-file` loader (dotenv grammar
//     shared with the worktree env-file reader via lib/env-file.ts; malformed
//     lines are STARTUP ERRORS naming the line number — never silently
//     skipped, and never echoing line CONTENT, which could be a secret from a
//     mistakenly-pointed-at .env).
//   - run-init resolution + validation (L6 `missing` / L10 `unknown-cli-var`
//     are run-init lints — they depend on live flags/environment; L1–L5/L7–L9
//     already ran at plan time, a2) over every substitution surface.
//   - the F2 halt message (03 F2 template + the 09 error-quality bar): every
//     error names the variable, its DECLARATION line + file, EVERY occurrence
//     (file:line), and the per-kind remedy — a `required` var offers
//     `--var`/env ONLY (inline/manifest defaults never satisfy required,
//     D1.2); an optional-missing var additionally offers defaults. Aggregated,
//     never first-error-only.
//
// Discipline: lib module — no imports from commands/*; NEVER reads
// process.env (the env map is an injected parameter; the single real
// environment read lives in the command layer at freeze time, D9/D11).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvFile } from './env-file';
import {
  PP_NAME_RE,
  hasDeclarations,
  parseVarAssignment,
  resolveVariables,
  scanOccurrences,
  validateRun,
  type ResolvedVars,
  type SubstitutionIssue,
  type VariableDecl,
} from './substitution';

// ---------------------------------------------------------------------------
// CLI flag folding (`--var` / `--vars-file`)
// ---------------------------------------------------------------------------

/** Fold one `--var NAME=value` onto `out.varFlags` (repeatable; FIRST-`=`
 *  split — the value may itself contain `=`). Malformed values (no `=`, empty
 *  name, `__proto__`) set `out.varsError` — a loud usage error, mirroring the
 *  addModelOverride contract; a typo'd override must never be silently
 *  dropped (L10/T11). Names are NOT validated here: undeclared/non-PP_ names
 *  flow through resolveVariables().unknown into L10. */
export function addVarFlag(
  out: { varFlags?: Record<string, string>; varsError?: string },
  raw: string | undefined,
): void {
  const parsed = parseVarAssignment(raw ?? '');
  if (parsed === null) {
    out.varsError = `--var expects NAME=value, got '${raw ?? ''}'`;
    return;
  }
  (out.varFlags ??= {})[parsed.name] = parsed.value;
}

/** Load a `--vars-file` (dotenv format via the ONE shared parseEnvFile
 *  grammar). STRICT: an unreadable file, or any non-blank/non-comment line
 *  that does not parse as KEY=VALUE, is a startup error naming the offending
 *  line NUMBER (F10) — the content is never echoed (it could be a secret).
 *  Key REJECTION (non-PP_/undeclared, T11) is not done here — those names
 *  flow through resolveVariables().unknown into L10 so a project `.env`
 *  can never be silently bulk-imported. */
export function loadVarsFile(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): { ok: true; vars: Record<string, string> } | { ok: false; error: string } {
  let text: string;
  try {
    text = read(path);
  } catch (e) {
    return { ok: false, error: `--vars-file ${path} could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const badLines: number[] = [];
  const vars = parseEnvFile(text, (lineNo) => badLines.push(lineNo));
  if (badLines.length) {
    return {
      ok: false,
      error:
        `--vars-file ${path} is malformed: line${badLines.length > 1 ? 's' : ''} ` +
        `${badLines.join(', ')} ${badLines.length > 1 ? 'are' : 'is'} not KEY=VALUE ` +
        `(dotenv format: KEY=VALUE, '#' comments, optional 'export ' prefix)`,
    };
  }
  return { ok: true, vars };
}

/** Merge the two CLI sources into the ONE cliVars map resolveVariables takes:
 *  vars-file entries first, repeated `--var` flags win (D2 — the file is the
 *  bulk channel, an explicit flag is the operator's last word). Returns
 *  undefined when NEITHER flag was passed — the "no variables supplied"
 *  signal the frozen-resume check keys on (an empty file/`--var` set still
 *  counts as supplied). */
export function mergeCliVars(
  fileVars: Record<string, string> | undefined,
  varFlags: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (fileVars === undefined && varFlags === undefined) return undefined;
  return { ...(fileVars ?? {}), ...(varFlags ?? {}) };
}

// ---------------------------------------------------------------------------
// Run-init file collection
// ---------------------------------------------------------------------------

/** One substitution-surface file for run-init validation. `raw` is the WHOLE
 *  file text (frontmatter included): plan-time (a2) already banned tokens in
 *  every frontmatter value except the declared `command:`/`script:` surfaces
 *  (D5(c)) — so scanning the raw text here (a) yields file-TRUE line numbers
 *  with no offset bookkeeping and (b) correctly counts `command:`/`script:`
 *  occurrences toward L6 (a required var used only in a script command line
 *  must still halt the run). */
export interface RunVarsFile {
  file: string;
  raw: string;
}

// Cheap pre-filter (the a2 zero-change pattern): both the token and near-miss
// grammars require `${` + case-insensitive `pp_`, so a file failing this test
// contributes nothing to any scan.
const PP_ISH_RE = /\$\{\s*[Pp][Pp]_/;

/** Collect the run-init validation surfaces: PIPELINE.md + every enumerated
 *  step file, labeled exactly like the plan lints ('PIPELINE.md',
 *  'steps/<rel>') so run-init messages and plan messages read alike. Files
 *  with no PP_-ish text are skipped (they cannot contain occurrences);
 *  unreadable files are skipped too (computePlan already surfaced them).
 *  `manifestRaw` is returned regardless (declaration-line lookup). */
export function collectRunVarsFiles(
  pipelineRoot: string,
  steps: Array<{ path: string; rel: string }>,
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): { files: RunVarsFile[]; manifestRaw: string } {
  const files: RunVarsFile[] = [];
  let manifestRaw = '';
  try {
    manifestRaw = read(join(pipelineRoot, 'PIPELINE.md'));
  } catch {
    // no manifest — computePlan already errored; nothing to scan
  }
  if (PP_ISH_RE.test(manifestRaw)) files.push({ file: 'PIPELINE.md', raw: manifestRaw });
  for (const s of steps) {
    try {
      const raw = read(s.path);
      if (PP_ISH_RE.test(raw)) files.push({ file: `steps/${s.rel}`, raw });
    } catch {
      // unreadable step — the executor/plan fails loudly, not us
    }
  }
  return { files, manifestRaw };
}

// ---------------------------------------------------------------------------
// Run-init resolve → validate → F2 message
// ---------------------------------------------------------------------------

export interface RunVarsInit {
  /** The frozen map (name → value) — valid ONLY when `errors` is empty. */
  resolved: ResolvedVars;
  /** Error-severity issues (L6 missing, L10 unknown-cli-var; defensively any
   *  other error the sweep finds on the declared surfaces). Warnings are
   *  dropped here — the plan-time sweep (a2) already surfaces them. */
  errors: SubstitutionIssue[];
  /** The aggregated F2 halt text (03 F2 / 09 quality bar); null when clean. */
  message: string | null;
}

interface OccurrenceAt {
  file: string;
  line: number;
  hasInlineDefault: boolean;
}

/** 1-based line of a UTF-16 offset (counts '\n'; CRLF-safe). */
function lineOf(text: string, index: number): number {
  let line = 1;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Declaration line numbers, name → 1-based line in PIPELINE.md (raw text, so
 *  lines are file-true). Mirrors parseVariablesSection's section walk (H2
 *  boundary, fence opacity) WITHOUT re-deriving decl semantics — this is a
 *  display lookup for the 09 quality bar ("every error names the declaration
 *  line"), tolerant by design: a name it cannot find simply reports the bare
 *  file. */
export function declarationLines(manifestRaw: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = manifestRaw.split(/\r\n|\r|\n/);
  let inSection = false;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s+Variables\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const m = /^\s*[-*]\s+`?(PP_[A-Z0-9_]+)/.exec(line);
    if (m && !out.has(m[1]!)) out.set(m[1]!, i + 1);
  }
  return out;
}

/** Resolve + validate the run's variables ONCE (fail-fast, all-at-once).
 *
 *  `env` is injected — this module never touches process.env; the caller
 *  performs the single real environment read (D9/D11).
 *
 *  `scopeMissingToOccurrences` (the `pipeline step run` mode): L6 `missing`
 *  fires only for variables that OCCUR in the given files — a dry run of one
 *  step must not demand values the step never uses. The full-run init leaves
 *  it off: an unresolved required var halts even with zero occurrences. */
export function initRunVariables(
  decls: VariableDecl[],
  cliVars: Record<string, string>,
  env: Record<string, string | undefined>,
  files: RunVarsFile[],
  manifestRaw: string,
  opts: { scopeMissingToOccurrences?: boolean } = {},
): RunVarsInit {
  const { resolved, unresolved, unknown } = resolveVariables(decls, cliVars, env);

  // Occurrence index (name → every file:line) — powers the "used at" listing
  // of the F2 message. Scanned over the same raw texts validateRun sees, so
  // both line-number sets are file-true and identical.
  const occAt = new Map<string, OccurrenceAt[]>();
  for (const f of files) {
    for (const occ of scanOccurrences(f.raw, f.file)) {
      let list = occAt.get(occ.name);
      if (!list) occAt.set(occ.name, (list = []));
      list.push({
        file: f.file,
        line: lineOf(f.raw, occ.index),
        hasInlineDefault: occ.inlineDefault !== undefined,
      });
    }
  }

  const unresolvedScoped = opts.scopeMissingToOccurrences
    ? unresolved.filter((n) => occAt.has(n))
    : unresolved;

  const issues = validateRun(
    decls,
    resolved,
    unresolvedScoped,
    files.map((f) => ({ file: f.file, frontmatterRaw: '', body: f.raw })),
    unknown,
  );
  const errors = issues.filter((i) => i.severity === 'error');
  return {
    resolved,
    errors,
    message: errors.length ? formatRunVarsHalt(errors, decls, occAt, declarationLines(manifestRaw)) : null,
  };
}

/** The aggregated F2 halt message (03 F2 template, 09 quality bar). Values
 *  are never echoed — names, locations, and remedies only. */
export function formatRunVarsHalt(
  errors: SubstitutionIssue[],
  decls: VariableDecl[],
  occAt: Map<string, OccurrenceAt[]>,
  declLines: Map<string, number>,
): string {
  const declByName = new Map(decls.map((d) => [d.name, d]));
  const missing = errors.filter((i) => i.kind === 'missing');
  const unknown = errors.filter((i) => i.kind === 'unknown-cli-var');
  const other = errors.filter((i) => i.kind !== 'missing' && i.kind !== 'unknown-cli-var');

  const lines: string[] = [];
  if (missing.length) {
    lines.push('Unresolved pipeline variables:');
    for (const issue of missing) {
      const name = issue.name ?? '<unknown>';
      const decl = declByName.get(name);
      const head =
        `  ${name}${decl?.required ? ' (required)' : ''}` +
        (decl?.description ? ` — ${decl.description}` : '');
      lines.push(head);
      const dl = declLines.get(name);
      lines.push(`    declared in PIPELINE.md ## Variables${dl !== undefined ? ` (PIPELINE.md:${dl})` : ''}`);
      const occs = occAt.get(name) ?? [];
      if (occs.length) {
        lines.push(`    used at: ${occs.map((o) => `${o.file}:${o.line}`).join(', ')}`);
      } else {
        lines.push('    used at: (no occurrences found)');
      }
      if (decl?.required) {
        // D1.2: required = the operator must supply it. NEVER offer a
        // manifest/inline default here — it would not satisfy the var.
        lines.push(`    provide it via --var ${name}=<value> or the ${name} environment variable`);
      } else {
        const bare = occs.filter((o) => !o.hasInlineDefault);
        if (bare.length) {
          lines.push(
            `    occurrences without an inline default: ${bare.map((o) => `${o.file}:${o.line}`).join(', ')}`,
          );
        }
        lines.push(
          `    provide it via --var ${name}=<value>, the ${name} environment variable, ` +
            `a (default: ...) on its ## Variables bullet, or an inline default like \${${name}:-value}`,
        );
      }
    }
  }
  if (unknown.length) {
    lines.push('Unknown variables supplied (not declared in PIPELINE.md ## Variables):');
    for (const issue of unknown) {
      const name = issue.name ?? '<unknown>';
      const hint = PP_NAME_RE.test(name)
        ? 'declare it under ## Variables or fix the name'
        : 'pipeline variables must be named PP_[A-Z0-9_]+ and declared under ## Variables — a project .env cannot be bulk-imported';
      lines.push(`  ${name} (via --var/--vars-file) — ${hint}`);
    }
  }
  if (other.length) {
    lines.push('Substitution errors:');
    for (const issue of other) {
      const loc = issue.line !== undefined ? `${issue.file}:${issue.line}` : issue.file;
      lines.push(`  ${loc}: ${issue.message}`);
    }
  }
  return lines.join('\n');
}

// Re-exported so command modules compose the run-init seam from ONE import.
export { hasDeclarations };
export type { ResolvedVars, VariableDecl };
