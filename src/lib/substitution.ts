// Pure PP_* variable substitution engine (env-variables design, doc 04 — normative).
//
// This module IS the feature's security boundary:
//   - T1 grammar anchoring: only `${PP_[A-Z0-9_]+}` tokens are ever expanded.
//     Arbitrary environment variables are unreachable by construction — any
//     other `${...}` text passes through as literal text.
//   - T4 inertness: substitution is ONE left-to-right `String.replace` pass;
//     replacement text (resolved values and inline defaults) is NEVER
//     re-scanned, so a value containing `${PP_OTHER}` / `${steps.x.y}` /
//     `$${PP_X}` stays literal. Calling substituteText twice on its own
//     output is deliberately NOT idempotent-safe — the engine calls it once.
//
// Discipline (load-bearing, asserted by tests):
//   - Pure: no I/O, no imports from commands/* (lib rule, see script-step.ts).
//   - NEVER reads the ambient process environment — `env` is an injected
//     parameter, so the single real environment read happens at run-init
//     freeze time in the command layer, keeping every later expansion
//     auditable from next.json.
//
// Grammar (04 §1):
//   occurrence    := "${" name inlineDefault? "}"
//   name          := "PP_" [A-Z0-9_]+
//   inlineDefault := (":-" | "-") defaultText   ; defaultText = any chars except "}"
//   escape        := "$$"                       ; "$$" -> "$" uniformly (compose-style)
//
// Colon semantics (POSIX/compose, OQ5=a): `${PP_X:-d}` substitutes `d` when
// PP_X is UNSET or EMPTY; `${PP_X-d}` (no colon) substitutes `d` when PP_X is
// UNSET only (an empty value is kept). When PP_X is unset, BOTH forms default.
//
// Multi-dollar: `$$` collapses to `$` everywhere (so `$${PP_X}` renders the
// literal `${PP_X}` — the D13 escape — and `$$${PP_X}` renders a literal `$`
// followed by the substituted value). Inline-default text is inserted
// VERBATIM (never collapsed or re-scanned).

// ----- reference regexes (04 §1, normative) ------------------------------------

// Grammar building blocks — the SINGLE SOURCE every regex below derives from,
// so the name charset and token shape can never drift between the exported
// reference regexes and the private engine pass (a test pins the exported
// composites to the exact 04 §1 spec literals).
const NAME_GRAMMAR = String.raw`PP_[A-Z0-9_]+`;
const TOKEN_GRAMMAR = String.raw`\$\{(${NAME_GRAMMAR})(?:(:)?-([^}]*))?\}`;
const NEARMISS_GRAMMAR = String.raw`\$\{\s*[Pp][Pp]_[^}]*\}`;

/** Strict variable-name grammar. */
export const PP_NAME_RE = new RegExp(`^${NAME_GRAMMAR}$`);
// matches BOTH escaped ($$) and plain occurrences.
// group 1 = "$" iff escaped; 2 = name; 3 = ":" iff colon-form (default on UNSET-or-EMPTY);
// 4 = inline default text (present iff a "-"/":-" operator is used; "-" alone = UNSET-only).
// NOTE: group 1 exists for SPAN SUBTRACTION (near-miss lint); it is not an
// authority on escaped-ness for multi-dollar runs — the uniform `$$` collapse
// decides that (e.g. `$$${PP_X}` DOES expand). Use scanOccurrences for the
// real classification.
export const PP_TOKEN_RE = new RegExp(String.raw`(\$)?` + TOKEN_GRAMMAR, 'g');
// near-miss detector for lints (anything PP-ish that is not a valid token)
export const PP_NEARMISS_RE = new RegExp(NEARMISS_GRAMMAR, 'g');

// Private twins for internal scanning: the exported /g regexes are shared
// mutable objects — an external `.test()`/`.exec()` leaves a stale lastIndex
// which matchAll SEEDS INTO ITS CLONE, silently corrupting scans. Internal
// code must only ever scan with these (never with the exported instances).
const TOKEN_SCAN_RE = new RegExp(PP_TOKEN_RE.source, 'g');
const NEARMISS_SCAN_RE = new RegExp(NEARMISS_GRAMMAR, 'g');

// The single-pass scanner used by BOTH scanning and substitution: the token
// grammar (groups 2..4 identical to PP_TOKEN_RE, by construction) preceded by
// a `$$` collapse alternative. Alternation order makes a `$$` pair consume
// BEFORE a token can start, which is exactly compose semantics decided in one
// left-to-right pass:
//        `$${PP_X}`   -> "$$" + literal "{PP_X}"      (D13 escape)
//        `$$${PP_X}`  -> "$$" + real token            (literal `$` + value)
//        `$$$${PP_X}` -> "$$" + "$$" + literal "{PP_X}"
// scanOccurrences and substituteText share this regex so validation sees
// EXACTLY the set of tokens substitution will expand (scan/substitute parity —
// the property the whole fail-fast design leans on).
const SUBST_PASS_RE = new RegExp(String.raw`(\$\$)|` + TOKEN_GRAMMAR, 'g');

/** D14: secret-looking declaration names get an L8 warning (never an error —
 *  names like PP_KEYBOARD_LAYOUT legitimately contain "KEY"). Deliberately a
 *  separate list from script-types.ts SECRET_ENV_PATTERN: D14 normatively
 *  fixes THIS word set (adds PASSWD; no /i needed — PP names are uppercase by
 *  grammar), and coupling the two would let script-step changes silently
 *  reshape the D14 lint. */
const SECRETISH_NAME_RE = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PASSWD)/;

// ----- core model (02) ---------------------------------------------------------

/** One `## Variables` bullet declaration. */
export interface VariableDecl {
  /** Canonical name — always matches PP_NAME_RE. */
  name: string;
  description: string;
  /** `(required)` marker — the operator MUST supply the value via --var or
   *  env; manifest defaults are rejected at parse and inline defaults are
   *  ignored at resolution (D1.2). */
  required: boolean;
  /** `(default: ...)` marker; mutually exclusive with `required`. May be ''
   *  (`(default: )`) — an empty default is a RESOLVED value. */
  default?: string;
}

/** The frozen name→value map computed once at run init. */
export type ResolvedVars = Record<string, string>;

/** One valid, non-escaped token occurrence in a body. `index` is the UTF-16
 *  code-unit offset of the token's `${` in the scanned text. `inlineDefault`
 *  is present iff a `-`/`:-` operator was used (may be ''). */
export interface Occurrence {
  name: string;
  inlineDefault?: string;
  index: number;
  raw: string;
}

/** Lint/validation issue kinds (02 core model + `unknown-cli-var` per 04 §3
 *  and `ineffective-default` per the 04 §4 lint table, L9/L10). */
export type SubstitutionIssueKind =
  | 'undeclared' // L1: valid token whose name is not declared
  | 'missing' // L6: unresolved var with a bare occurrence, or unresolved required var
  | 'bad-name' // L2: near-miss token failing the strict grammar
  | 'frontmatter' // L3: token or near-miss inside frontmatter (v1 ban)
  | 'duplicate-decl' // L5: same name declared twice
  | 'secretish-name' // L8: declared name looks like a secret (D14)
  | 'unused-decl' // L7: declared, zero occurrences anywhere
  | 'malformed-decl' // L4: unparsable `- PP_*` bullet; required+default conflict
  | 'ineffective-default' // L9: inline default on an occurrence of a required var
  | 'unknown-cli-var'; // L10: supplied --var/--vars-file name not in decls

export interface SubstitutionIssue {
  kind: SubstitutionIssueKind;
  severity: 'error' | 'warning';
  file: string;
  line?: number;
  name?: string;
  message: string;
}

// ----- small shared helpers ----------------------------------------------------

/** 1-based line number of a UTF-16 offset (counts '\n'; CRLF-safe). */
function lineOf(text: string, index: number): number {
  let line = 1;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ----- parsing: `## Variables` manifest section (04 §2) -------------------------

// Section heading per the repo's H2 convention (match.ts SECTION_RE).
const VARIABLES_HEADING_RE = /^##\s+Variables\s*$/;
const H2_RE = /^##\s+/;
// Fenced-code-block delimiter: lines inside a fence are opaque — a fenced
// `## Heading` must not end the section and a fenced `- PP_DEMO` example must
// not parse as a declaration.
const FENCE_RE = /^\s*(?:```|~~~)/;
// A bullet is a DECLARATION CANDIDATE iff it starts with `- PP_` or `* PP_`
// (optionally backtick-wrapped; `[-*]` per the match.ts BULLET_RE precedent —
// a `*`-bulleted declaration must not be silently dropped as prose). Anything
// else in the section is prose and is ignored.
const DECL_GATE_RE = /^\s*[-*]\s+`?PP_/;
// Tolerant head parse: candidate name chars (validated against PP_NAME_RE
// after the fact so `- PP_lower` reports a helpful malformed-decl) + rest.
const DECL_HEAD_RE = /^\s*[-*]\s+`?(PP_[A-Za-z0-9_]*)`?\s*(.*)$/;
// Separator before the description: em-dash, hyphen, or colon (author-friendly).
const DESC_SEP_RE = /^(?:—|-|:)\s*/;

/** Parse the `## Variables` section out of a PIPELINE.md BODY (text after
 *  frontmatter). Missing section => no declarations (the zero-change path).
 *  Emits L4 `malformed-decl` (incl. the required+default conflict, D1.2) and
 *  L5 `duplicate-decl` issues; on a duplicate the FIRST declaration wins. */
export function parseVariablesSection(
  manifestBody: string,
  file: string,
): { decls: VariableDecl[]; issues: SubstitutionIssue[] } {
  const decls: VariableDecl[] = [];
  const issues: SubstitutionIssue[] = [];
  const seen = new Map<string, number>(); // name -> first decl line
  const lines = manifestBody.split(/\r\n|\r|\n/);
  let inSection = false;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence; // toggle-approximation, no full markdown parser here
      continue;
    }
    if (inFence) continue; // fenced content is opaque to the section parser
    if (VARIABLES_HEADING_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && H2_RE.test(line)) {
      inSection = false; // next H2 ends the section (H3+ stays inside as prose)
      continue;
    }
    if (!inSection || !DECL_GATE_RE.test(line)) continue;
    parseDeclLine(line, i + 1, file, decls, issues, seen);
  }
  return { decls, issues };
}

function parseDeclLine(
  line: string,
  lineNo: number,
  file: string,
  decls: VariableDecl[],
  issues: SubstitutionIssue[],
  seen: Map<string, number>,
): void {
  const malformed = (detail: string, name?: string): void => {
    issues.push({
      kind: 'malformed-decl',
      severity: 'error',
      file,
      line: lineNo,
      ...(name !== undefined ? { name } : {}),
      message: `malformed variable declaration: ${detail}`,
    });
  };

  const head = DECL_HEAD_RE.exec(line);
  if (!head) {
    malformed(`cannot parse ${JSON.stringify(line.trim())}`);
    return;
  }
  const name = head[1]!;
  if (!PP_NAME_RE.test(name)) {
    malformed(`\`${name}\` is not a valid variable name (names match PP_[A-Z0-9_]+)`, name);
    return;
  }

  let rest = (head[2] ?? '').trim();
  let required = false;
  let def: string | undefined;
  while (rest.startsWith('(')) {
    const close = rest.indexOf(')');
    if (close === -1) {
      malformed(`unclosed \`(\` marker on \`${name}\``, name);
      return;
    }
    const marker = rest.slice(1, close).trim();
    if (marker.toLowerCase() === 'required') {
      required = true;
    } else if (/^default\s*:/i.test(marker)) {
      def = marker.replace(/^default\s*:/i, '').trim();
    } else {
      malformed(
        `unrecognized marker \`(${marker})\` on \`${name}\` (expected \`(required)\` or \`(default: ...)\`)`,
        name,
      );
      return;
    }
    rest = rest.slice(close + 1).trimStart();
  }

  if (required && def !== undefined) {
    issues.push({
      kind: 'malformed-decl',
      severity: 'error',
      file,
      line: lineNo,
      name,
      message:
        `\`${name}\` declares both (required) and (default: ...) — they are mutually exclusive: ` +
        `required means the operator must supply the value (D1.2)`,
    });
    def = undefined; // required wins; the error above already halts the run
  }

  let description = '';
  if (rest !== '') {
    const sep = DESC_SEP_RE.exec(rest);
    if (!sep) {
      malformed(`expected \`—\`, \`-\` or \`:\` before the description on \`${name}\``, name);
      return;
    }
    description = rest.slice(sep[0].length).trim();
  }

  const prev = seen.get(name);
  if (prev !== undefined) {
    issues.push({
      kind: 'duplicate-decl',
      severity: 'error',
      file,
      line: lineNo,
      name,
      message: `\`${name}\` is declared more than once (first declared on line ${prev})`,
    });
    return; // first declaration wins
  }
  seen.set(name, lineNo);
  const decl: VariableDecl = { name, description, required };
  if (def !== undefined) decl.default = def;
  decls.push(decl);
}

// ----- scanning (lint support) ---------------------------------------------------

/** All valid, NON-ESCAPED token occurrences in `text`. Uses the same
 *  single-pass scanner as substituteText, so the returned set is exactly the
 *  set of tokens substitution would expand (`$${PP_X}` is consumed as a `$$`
 *  collapse + literal text and yields NO occurrence; `$$${PP_X}` yields one). */
export function scanOccurrences(text: string, _file: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (const m of text.matchAll(SUBST_PASS_RE)) {
    if (m[1] !== undefined) continue; // `$$` collapse — consumes escape prefixes
    const occ: Occurrence = { name: m[2]!, index: m.index!, raw: m[0] };
    if (m[4] !== undefined) occ.inlineDefault = m[4];
    out.push(occ);
  }
  return out;
}

/** L2 `bad-name` detection. PP_NEARMISS_RE is the ONLY near-miss regex; its
 *  matches are reported AFTER subtracting spans contained in a PP_TOKEN_RE
 *  match (valid tokens and their `$$`-escaped forms). A near-miss is
 *  UNESCAPABLE by design (D13 escapes only grammar-valid tokens): prose that
 *  documents `${pp_x}` is a hard error — rewrite it without the `${...}`. */
export function scanNearMisses(text: string, file: string): SubstitutionIssue[] {
  const covered: Array<[number, number]> = [];
  for (const m of text.matchAll(TOKEN_SCAN_RE)) {
    covered.push([m.index!, m.index! + m[0].length]);
  }
  const issues: SubstitutionIssue[] = [];
  for (const m of text.matchAll(NEARMISS_SCAN_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (covered.some(([cs, ce]) => start >= cs && end <= ce)) continue;
    issues.push({
      kind: 'bad-name',
      severity: 'error',
      file,
      line: lineOf(text, start),
      message: `\`${m[0]}\` is not a valid variable token (names match PP_[A-Z0-9_]+)`,
    });
  }
  return issues;
}

/** L3 frontmatter ban (D5, v1): any valid token OR near-miss inside raw
 *  frontmatter text is an error. Escaped forms (`$${PP_X}`) are allowed —
 *  they are documentation, not occurrences. NOTE: the D5 carve-out for the
 *  `command:`/`script:` frontmatter keys (declared substitution surfaces) is
 *  the CALLER's job — integration strips those two keys' lines before calling. */
export function scanFrontmatter(fmRaw: string, file: string): SubstitutionIssue[] {
  const issues: SubstitutionIssue[] = [];
  for (const occ of scanOccurrences(fmRaw, file)) {
    issues.push({
      kind: 'frontmatter',
      severity: 'error',
      file,
      line: lineOf(fmRaw, occ.index),
      name: occ.name,
      message: `\`${occ.raw}\` — variables are not supported in frontmatter (v1)`,
    });
  }
  for (const near of scanNearMisses(fmRaw, file)) {
    issues.push({
      ...near,
      kind: 'frontmatter',
      message: `${near.message}; variables are not supported in frontmatter (v1)`,
    });
  }
  return issues;
}

// ----- resolution (D1/D2) --------------------------------------------------------

/** Build the frozen map. Precedence per declared variable (D2):
 *  CLI `--var`/`--vars-file` (already merged by the caller: file first, flags
 *  win) > injected env > manifest default. An EMPTY CLI/env value is a
 *  RESOLVED empty string — distinct from unresolved (POSIX set-but-empty).
 *  `required` vars never consume a manifest default (D1.2 — parse already
 *  rejects the combination; this is defense in depth). Returns:
 *    - resolved:   name -> value for every declared var that got a value
 *    - unresolved: declared names with no value (validateRun turns these into
 *                  L6 `missing` errors when occurrences demand a value)
 *    - unknown:    supplied cliVars names NOT in decls — the L10 feed; a
 *                  typo'd override or a stray `--vars-file` entry (non-PP_ or
 *                  undeclared) is REJECTED, never silently dropped/loaded. */
export function resolveVariables(
  decls: VariableDecl[],
  cliVars: Record<string, string>,
  env: Record<string, string | undefined>,
): { resolved: ResolvedVars; unresolved: string[]; unknown: string[] } {
  const declared = new Set(decls.map((d) => d.name));
  const unknown = Object.keys(cliVars).filter((k) => !declared.has(k));
  const resolved: ResolvedVars = {};
  const unresolved: string[] = [];
  for (const d of decls) {
    if (hasOwn(cliVars, d.name) && typeof cliVars[d.name] === 'string') {
      resolved[d.name] = cliVars[d.name]!;
    } else if (typeof env[d.name] === 'string') {
      resolved[d.name] = env[d.name]!;
    } else if (!d.required && d.default !== undefined) {
      resolved[d.name] = d.default;
    } else {
      unresolved.push(d.name);
    }
  }
  return { resolved, unresolved, unknown };
}

/** Split one `--var NAME=value` argument on the FIRST `=` ONLY (the value may
 *  itself contain `=`: `PP_URL=a=b` -> value `a=b`). `NAME=` yields an
 *  explicit EMPTY value (resolved-empty, per POSIX set-but-empty). Returns
 *  null when there is no `=` or the name part is empty — the caller reports
 *  the usage error. Names are NOT validated here: undeclared/non-PP_ names
 *  flow through resolveVariables().unknown into L10. */
export function parseVarAssignment(raw: string): { name: string; value: string } | null {
  const eq = raw.indexOf('=');
  if (eq <= 0) return null;
  const name = raw.slice(0, eq);
  // '__proto__' cannot round-trip through a Record (plain-object assignment
  // hits the prototype setter and creates NO own key), so the override would
  // bypass the L10 unknown-name rejection and be SILENTLY dropped — exactly
  // what L10/T11 forbid. Reject it as malformed instead.
  if (name === '__proto__') return null;
  return { name, value: raw.slice(eq + 1) };
}

// ----- validation (fail-fast aggregate) --------------------------------------------

/** Run-init validation: aggregates EVERY issue across EVERY file (fail-fast,
 *  all-at-once — a run never starts half-configured). Any 'error' severity
 *  issue means the run must not start.
 *
 *  Emits: L1 undeclared, L2 bad-name, L3 frontmatter, L6 missing (unresolved
 *  var with >=1 occurrence lacking an inline default; ANY unresolved required
 *  var — inline defaults never satisfy `required`, D1.2), L7 unused-decl,
 *  L8 secretish-name (D14), L9 ineffective-default (inline default on a
 *  required var's occurrence is dead text), L10 unknown-cli-var (from
 *  `unknownNames`, the resolveVariables().unknown feed). L4/L5 come from
 *  parseVariablesSection — the caller concatenates both issue lists.
 *
 *  `unknownNames` is REQUIRED (a documented addition to the 04 §3 signature
 *  sketch, which predates L10): were it optional, a caller coded to the
 *  4-param sketch would silently skip L10 and a typo'd --var would be
 *  dropped without error — the exact invisible misconfiguration T11 forbids.
 *  Callers with nothing to report pass []. */
export function validateRun(
  decls: VariableDecl[],
  resolved: ResolvedVars,
  unresolvedNames: string[],
  files: Array<{ file: string; frontmatterRaw: string; body: string }>,
  unknownNames: string[],
): SubstitutionIssue[] {
  const issues: SubstitutionIssue[] = [];
  const declByName = new Map(decls.map((d) => [d.name, d]));
  const fallbackFile = files[0]?.file ?? '';
  const occAt = new Map<string, Array<{ file: string; line: number; occ: Occurrence }>>();

  for (const f of files) {
    issues.push(...scanFrontmatter(f.frontmatterRaw, f.file));
    issues.push(...scanNearMisses(f.body, f.file));
    for (const occ of scanOccurrences(f.body, f.file)) {
      const at = { file: f.file, line: lineOf(f.body, occ.index), occ };
      let list = occAt.get(occ.name);
      if (!list) occAt.set(occ.name, (list = []));
      list.push(at);
      const decl = declByName.get(occ.name);
      if (!decl) {
        issues.push({
          kind: 'undeclared',
          severity: 'error',
          file: f.file,
          line: at.line,
          name: occ.name,
          message: `\`${occ.raw}\` used in ${f.file}:${at.line} but not declared in PIPELINE.md ## Variables`,
        });
      } else if (decl.required && occ.inlineDefault !== undefined) {
        issues.push({
          kind: 'ineffective-default',
          severity: 'warning',
          file: f.file,
          line: at.line,
          name: occ.name,
          message:
            `inline default on required variable \`${occ.name}\` is ignored ` +
            `(${f.file}:${at.line}) — required variables must be supplied via --var or the environment (D1.2)`,
        });
      }
    }
  }

  // L6 missing — one aggregated issue per unresolved variable.
  for (const name of unresolvedNames) {
    const decl = declByName.get(name);
    const occs = occAt.get(name) ?? [];
    if (decl?.required) {
      const where = occs.map((o) => `${o.file}:${o.line}`).join(', ');
      const first = occs[0];
      issues.push({
        kind: 'missing',
        severity: 'error',
        file: first?.file ?? fallbackFile,
        ...(first ? { line: first.line } : {}),
        name,
        message:
          `required variable \`${name}\` is unresolved — supply it via \`--var ${name}=...\` ` +
          `or the ${name} environment variable` +
          (decl.description ? ` (${decl.description})` : '') +
          (where ? `; used at ${where}` : ''),
      });
    } else {
      // Optional unresolved: only occurrences WITHOUT an inline default block.
      const bare = occs.filter((o) => o.occ.inlineDefault === undefined);
      if (bare.length === 0) continue;
      const where = bare.map((o) => `${o.file}:${o.line}`).join(', ');
      issues.push({
        kind: 'missing',
        severity: 'error',
        file: bare[0]!.file,
        line: bare[0]!.line,
        name,
        message:
          `variable \`${name}\` is unresolved and has occurrences without an inline default: ${where} — ` +
          `supply it via \`--var ${name}=...\`, the ${name} environment variable, or a manifest (default: ...)`,
      });
    }
  }

  // L7 unused-decl + L8 secretish-name (decl-level).
  for (const d of decls) {
    if (!occAt.has(d.name)) {
      issues.push({
        kind: 'unused-decl',
        severity: 'warning',
        file: fallbackFile,
        name: d.name,
        message: `variable \`${d.name}\` is declared in ## Variables but never used`,
      });
    }
    if (SECRETISH_NAME_RE.test(d.name)) {
      issues.push({
        kind: 'secretish-name',
        severity: 'warning',
        file: fallbackFile,
        name: d.name,
        message:
          `variable name \`${d.name}\` looks secret-like — PP_* values are visible in rendered ` +
          `files, logs, events, and AI context; do not carry secrets (D4)`,
      });
    }
  }

  // L10 unknown-cli-var — a typo'd override must NOT be silently dropped.
  for (const name of unknownNames) {
    issues.push({
      kind: 'unknown-cli-var',
      severity: 'error',
      file: fallbackFile,
      name,
      message: `\`--var ${name}\` supplied but \`${name}\` is not declared in PIPELINE.md ## Variables`,
    });
  }

  return issues;
}

// ----- substitution -----------------------------------------------------------------

/** Substitute a BODY text in one single left-to-right pass:
 *    - `$$` -> `$` uniformly (compose-style; makes `$${PP_X}` the D13 escape)
 *    - `${PP_X}` / `${PP_X-d}` / `${PP_X:-d}` -> value per POSIX colon rules
 *  Replacement text is inserted verbatim and NEVER re-scanned (T4 inertness).
 *  Throws on a non-escaped token that is neither resolved nor carrying an
 *  inline default — defense in depth only: validateRun (and the render-time
 *  per-file re-check) reject that state before substitution is reachable. */
export function substituteText(text: string, vars: ResolvedVars): string {
  return text.replace(
    SUBST_PASS_RE,
    (
      raw: string,
      dollars: string | undefined,
      name: string | undefined,
      colon: string | undefined,
      inlineDefault: string | undefined,
    ): string => {
      if (dollars !== undefined) return '$';
      const varName = name!;
      if (hasOwn(vars, varName) && typeof vars[varName] === 'string') {
        const value = vars[varName]!;
        // POSIX/compose: `:-` swaps the default in for an EMPTY value too;
        // plain `-` keeps the empty (set-but-empty is a value). The
        // `inlineDefault !== undefined` clause is type-narrowing only — by
        // the grammar, the colon group can only capture when the default
        // group matched.
        if (value === '' && colon === ':' && inlineDefault !== undefined) return inlineDefault;
        return value;
      }
      // Unset: both `-` and `:-` forms fall back to the inline default.
      if (inlineDefault !== undefined) return inlineDefault;
      throw new Error(
        `unresolvable variable token \`${raw}\` — \`${varName}\` has no value and no inline ` +
          `default (run-init validation should have rejected this before substitution)`,
      );
    },
  );
}

/** Substitute argv PER ELEMENT (E2/T3): each element goes through ONE
 *  substituteText pass; elements are never joined or re-split, so a value
 *  containing spaces/metacharacters stays exactly one argument and an
 *  empty-string value keeps its argv slot. */
export function substituteArgv(argv: string[], vars: ResolvedVars): string[] {
  return argv.map((el) => substituteText(el, vars));
}

/** Zero-change guard: a pipeline with no declarations takes the byte-identical
 *  legacy path (no rendering, no new files). */
export function hasDeclarations(decls: VariableDecl[]): boolean {
  return decls.length > 0;
}
