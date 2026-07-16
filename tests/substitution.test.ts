// Pure PP_* substitution engine — the full 04 §6 P0 test plan (env-variables
// design). Covers: grammar (CRLF, BOF/EOF, adjacent tokens, multi-byte),
// T4 inertness (single-pass; smuggled tokens stay literal — the P0 security
// gate), `## Variables` declarations (all three bullet forms, backticks,
// duplicates, required+default conflict), resolution precedence (D2: CLI >
// env > manifest default), edge semantics (multi-dollar, first-`=` split,
// per-occurrence inline defaults), the POSIX colon-default matrix (OQ5=a),
// validateRun aggregation + L7/L8/L9/L10, and substituteArgv element
// preservation. Plus the module-discipline greps (no process.env read, no
// commands/* import) as an executable invariant.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  PP_NAME_RE,
  PP_TOKEN_RE,
  PP_NEARMISS_RE,
  parseVariablesSection,
  scanOccurrences,
  scanNearMisses,
  scanFrontmatter,
  resolveVariables,
  parseVarAssignment,
  validateRun,
  substituteText,
  substituteArgv,
  hasDeclarations,
} from '../src/lib/substitution';
import type { VariableDecl, ResolvedVars, SubstitutionIssue } from '../src/lib/substitution';

const decl = (name: string, extra: Partial<VariableDecl> = {}): VariableDecl => ({
  name,
  description: '',
  required: false,
  ...extra,
});

const kinds = (issues: SubstitutionIssue[]): string[] => issues.map((i) => i.kind);
const ofKind = (issues: SubstitutionIssue[], kind: SubstitutionIssue['kind']): SubstitutionIssue[] =>
  issues.filter((i) => i.kind === kind);
const errors = (issues: SubstitutionIssue[]): SubstitutionIssue[] =>
  issues.filter((i) => i.severity === 'error');

// ----- reference regexes (04 §1) -----------------------------------------------

describe('reference regexes', () => {
  test('PP_NAME_RE accepts canonical names and rejects everything else', () => {
    for (const ok of ['PP_X', 'PP_A1_B2', 'PP_0', 'PP__', 'PP_LONG_NAME_9']) {
      expect(PP_NAME_RE.test(ok)).toBe(true);
    }
    for (const bad of ['pp_x', 'PP_', 'P_X', 'PP_a', 'PP_X ', ' PP_X', 'XPP_X', 'PP-X', '']) {
      expect(PP_NAME_RE.test(bad)).toBe(false);
    }
  });

  test('PP_TOKEN_RE group semantics: escape marker, name, colon marker, inline default', () => {
    const esc = [...'$${PP_X:-d}'.matchAll(PP_TOKEN_RE)];
    expect(esc.length).toBe(1);
    expect(esc[0]![1]).toBe('$'); // group 1 = "$" iff escaped
    expect(esc[0]![2]).toBe('PP_X');
    expect(esc[0]![3]).toBe(':'); // group 3 = ":" iff colon-form
    expect(esc[0]![4]).toBe('d');

    const plainDash = [...'${PP_X-d}'.matchAll(PP_TOKEN_RE)];
    expect(plainDash[0]![1]).toBeUndefined();
    expect(plainDash[0]![3]).toBeUndefined(); // "-" alone = UNSET-only form
    expect(plainDash[0]![4]).toBe('d');

    const bare = [...'${PP_X}'.matchAll(PP_TOKEN_RE)];
    expect(bare[0]![4]).toBeUndefined(); // no operator => no default text
  });

  test('PP_NEARMISS_RE matches PP-ish junk', () => {
    for (const near of ['${pp_x}', '${PP_}', '${ PP_X }', '${Pp_x}', '${pp_ bad}']) {
      expect([...near.matchAll(PP_NEARMISS_RE)].length).toBe(1);
    }
    expect([...'${steps.a.b}'.matchAll(PP_NEARMISS_RE)].length).toBe(0);
  });

  test('exported regex sources match the 04 §1 spec literals exactly', () => {
    expect(PP_NAME_RE.source).toBe('^PP_[A-Z0-9_]+$');
    expect(PP_TOKEN_RE.source).toBe('(\\$)?\\$\\{(PP_[A-Z0-9_]+)(?:(:)?-([^}]*))?\\}');
    expect(PP_TOKEN_RE.flags).toBe('g');
    expect(PP_NEARMISS_RE.source).toBe('\\$\\{\\s*[Pp][Pp]_[^}]*\\}');
    expect(PP_NEARMISS_RE.flags).toBe('g');
  });

  test('scanners are immune to external lastIndex mutation of the exported /g regexes', () => {
    // matchAll seeds its internal clone from the regex's CURRENT lastIndex,
    // so scanning with a shared exported /g regex after an external .test()
    // would silently skip tokens — the module must scan with private twins.
    PP_TOKEN_RE.lastIndex = 5;
    PP_NEARMISS_RE.lastIndex = 5;
    try {
      expect(scanNearMisses('${PP_X}', 't.md')).toEqual([]);
      expect(scanOccurrences('${PP_X}', 't.md').length).toBe(1);
    } finally {
      PP_TOKEN_RE.lastIndex = 0;
      PP_NEARMISS_RE.lastIndex = 0;
    }
  });
});

// ----- grammar / scanOccurrences -------------------------------------------------

describe('scanOccurrences (grammar)', () => {
  test('valid token: name, index, raw; no inline default property', () => {
    const occs = scanOccurrences('use ${PP_X} here', 't.md');
    expect(occs.length).toBe(1);
    expect(occs[0]!.name).toBe('PP_X');
    expect(occs[0]!.index).toBe(4);
    expect(occs[0]!.raw).toBe('${PP_X}');
    expect(occs[0]!.inlineDefault).toBeUndefined();
  });

  test('inline defaults: plain, empty, `-` form, `:-` inside the default text', () => {
    expect(scanOccurrences('${PP_X:-hello}', 't.md')[0]!.inlineDefault).toBe('hello');
    expect(scanOccurrences('${PP_X:-}', 't.md')[0]!.inlineDefault).toBe('');
    expect(scanOccurrences('${PP_X-}', 't.md')[0]!.inlineDefault).toBe('');
    expect(scanOccurrences('${PP_X:-a:-b}', 't.md')[0]!.inlineDefault).toBe('a:-b');
    expect(scanOccurrences('${PP_X-:-b}', 't.md')[0]!.inlineDefault).toBe(':-b');
  });

  test('`}` terminates the token — a default can never contain `}`', () => {
    const occs = scanOccurrences('${PP_X:-a}b}', 't.md');
    expect(occs.length).toBe(1);
    expect(occs[0]!.raw).toBe('${PP_X:-a}');
    expect(substituteText('${PP_X:-a}b}', {})).toBe('ab}');
  });

  test('adjacent tokens both scan', () => {
    const occs = scanOccurrences('${PP_A}${PP_B}', 't.md');
    expect(occs.map((o) => o.name)).toEqual(['PP_A', 'PP_B']);
    expect(occs.map((o) => o.index)).toEqual([0, 7]);
  });

  test('token at BOF and EOF', () => {
    expect(scanOccurrences('${PP_X} tail', 't.md')[0]!.index).toBe(0);
    const atEof = scanOccurrences('head ${PP_Y}', 't.md');
    expect(atEof[0]!.index + atEof[0]!.raw.length).toBe('head ${PP_Y}'.length);
  });

  test('escaped tokens yield NO occurrence; odd-dollar runs yield a real one (scan/substitute parity)', () => {
    expect(scanOccurrences('$${PP_X}', 't.md').length).toBe(0);
    expect(scanOccurrences('$$$${PP_X}', 't.md').length).toBe(0); // even: literal
    const odd = scanOccurrences('$$${PP_X}', 't.md'); // odd: `$$` collapse + real token
    expect(odd.length).toBe(1);
    expect(odd[0]!.index).toBe(2);
  });

  test('CRLF text (win32 sources) scans and substitutes cleanly', () => {
    const text = 'a\r\n${PP_X}\r\nb';
    const occs = scanOccurrences(text, 't.md');
    expect(occs.length).toBe(1);
    expect(substituteText(text, { PP_X: 'v' })).toBe('a\r\nv\r\nb');
  });

  test('multi-byte/emoji surroundings: UTF-16 indexing, values expand intact', () => {
    const occs = scanOccurrences('🚀${PP_X}🎉', 't.md');
    expect(occs.length).toBe(1);
    expect(occs[0]!.index).toBe(2); // the surrogate pair is 2 code units
    expect(substituteText('🚀${PP_X}🎉', { PP_X: '→v' })).toBe('🚀→v🎉');
  });
});

// ----- near-misses (L2 feed) ------------------------------------------------------

describe('scanNearMisses', () => {
  test('lowercase, bare PP_, and embedded-space forms are bad-name errors', () => {
    for (const text of ['${pp_x}', '${PP_}', '${ PP_X }', '${Pp_x:-d}']) {
      const issues = scanNearMisses(text, 't.md');
      expect(kinds(issues)).toEqual(['bad-name']);
      expect(issues[0]!.severity).toBe('error');
      expect(issues[0]!.file).toBe('t.md');
    }
  });

  test('valid and escaped tokens are subtracted; near-misses next to them still report', () => {
    expect(scanNearMisses('${PP_OK} and $${PP_ESC}', 't.md').length).toBe(0);
    expect(scanNearMisses('$$$${PP_X}', 't.md').length).toBe(0); // even-dollar literal form
    const mixed = scanNearMisses('ok ${PP_OK} bad ${pp_bad}', 't.md');
    expect(mixed.length).toBe(1);
    expect(mixed[0]!.message).toContain('${pp_bad}');
  });

  test('a near-miss is UNESCAPABLE (D13 escapes only grammar-valid tokens)', () => {
    const issues = scanNearMisses('$$${pp_x}', 't.md');
    expect(kinds(issues)).toEqual(['bad-name']);
  });

  test('nesting is flagged: the enclosing junk is a near-miss, the inner token still scans', () => {
    const text = '${PP_A${PP_B}}';
    expect(kinds(scanNearMisses(text, 't.md'))).toEqual(['bad-name']);
    expect(scanOccurrences(text, 't.md').map((o) => o.name)).toEqual(['PP_B']);
  });

  test('line numbers are 1-based and CRLF-safe', () => {
    expect(scanNearMisses('a\nb\n${pp_x}', 't.md')[0]!.line).toBe(3);
    expect(scanNearMisses('a\r\n${pp_x}', 't.md')[0]!.line).toBe(2);
  });
});

// ----- frontmatter ban (L3, D5) ---------------------------------------------------

describe('scanFrontmatter', () => {
  test('valid token in frontmatter is a frontmatter error even when resolvable', () => {
    const issues = scanFrontmatter('model: ${PP_M}\n', 's.md');
    expect(kinds(issues)).toEqual(['frontmatter']);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.name).toBe('PP_M');
    expect(issues[0]!.line).toBe(1);
  });

  test('near-miss in frontmatter is also a frontmatter error', () => {
    const issues = scanFrontmatter('x: ${pp_y}\n', 's.md');
    expect(kinds(issues)).toEqual(['frontmatter']);
  });

  test('escaped tokens and clean frontmatter pass', () => {
    expect(scanFrontmatter('note: $${PP_X}\n', 's.md').length).toBe(0);
    expect(scanFrontmatter('model: opus\n', 's.md').length).toBe(0);
  });
});

// ----- `## Variables` declarations (04 §2) ----------------------------------------

describe('parseVariablesSection', () => {
  test('all three bullet forms, backticks, all three separators, prose ignored', () => {
    const body = [
      '# Demo',
      '',
      '## Variables',
      '',
      'These knobs configure the run.',
      '',
      '- PP_REQ (required) — the required one',
      '- `PP_DEF` (default: v1) - has a default',
      '- PP_OPT : optional, no default',
      '- also prose, not a declaration bullet',
      '',
      '## Next',
      '',
      '- PP_AFTER (required) — outside the section, ignored',
    ].join('\n');
    const { decls, issues } = parseVariablesSection(body, 'PIPELINE.md');
    expect(issues).toEqual([]);
    expect(decls).toEqual([
      { name: 'PP_REQ', description: 'the required one', required: true },
      { name: 'PP_DEF', description: 'has a default', required: false, default: 'v1' },
      { name: 'PP_OPT', description: 'optional, no default', required: false },
    ]);
  });

  test('missing section => zero declarations, zero issues (zero-change path)', () => {
    const out = parseVariablesSection('# P\n\n## End State\nx\n', 'PIPELINE.md');
    expect(out.decls).toEqual([]);
    expect(out.issues).toEqual([]);
  });

  test('empty default `(default: )` is a RESOLVED empty string, distinct from no default', () => {
    const { decls } = parseVariablesSection('## Variables\n- PP_E (default: ) — empty\n', 'P.md');
    expect(decls[0]!.default).toBe('');
    const { resolved, unresolved } = resolveVariables(decls, {}, {});
    expect(resolved.PP_E).toBe('');
    expect(unresolved).toEqual([]);
  });

  test('default value: split on the marker colon only, inner colons/equals kept, trimmed', () => {
    const { decls } = parseVariablesSection(
      '## Variables\n- PP_URL (default:  http://h:80/p?a=b ) — url\n',
      'P.md',
    );
    expect(decls[0]!.default).toBe('http://h:80/p?a=b');
  });

  test('duplicate declaration: first wins, duplicate-decl error emitted', () => {
    const { decls, issues } = parseVariablesSection(
      '## Variables\n- PP_X — first\n- PP_X — second\n',
      'P.md',
    );
    expect(decls.length).toBe(1);
    expect(decls[0]!.description).toBe('first');
    expect(kinds(issues)).toEqual(['duplicate-decl']);
    expect(issues[0]!.line).toBe(3);
  });

  test('required + default is a malformed-decl error (D1.2); the default is dropped', () => {
    const { decls, issues } = parseVariablesSection(
      '## Variables\n- PP_B (required) (default: x) — conflicted\n',
      'P.md',
    );
    expect(kinds(issues)).toEqual(['malformed-decl']);
    expect(issues[0]!.severity).toBe('error');
    expect(decls[0]!.required).toBe(true);
    expect(decls[0]!.default).toBeUndefined();
  });

  test('malformed bullets: bad name, bare PP_, unknown marker, unclosed marker, missing separator', () => {
    const cases = [
      '- PP_lower — lowercase tail',
      '- PP_ — bare prefix',
      '- PP_X (weird) — unknown marker',
      '- PP_X (default: v — unclosed',
      '- PP_X junk without a separator',
    ];
    for (const line of cases) {
      const { decls, issues } = parseVariablesSection(`## Variables\n${line}\n`, 'P.md');
      expect(kinds(issues)).toEqual(['malformed-decl']);
      expect(decls).toEqual([]);
    }
  });

  test('description is optional; a bare `- PP_X` declares with an empty description', () => {
    const { decls, issues } = parseVariablesSection('## Variables\n- PP_X\n', 'P.md');
    expect(issues).toEqual([]);
    expect(decls).toEqual([{ name: 'PP_X', description: '', required: false }]);
  });

  test('H3 subheadings stay inside the section; the next H2 ends it', () => {
    const body = '## Variables\n### group\n- PP_A — a\n## Done\n- PP_B — b\n';
    const { decls } = parseVariablesSection(body, 'P.md');
    expect(decls.map((d) => d.name)).toEqual(['PP_A']);
  });

  test('`*` bullets declare too — a star-bulleted declaration is not silently dropped', () => {
    const { decls, issues } = parseVariablesSection(
      '## Variables\n* PP_TARGET (required) — the target\n* just prose\n',
      'P.md',
    );
    expect(issues).toEqual([]);
    expect(decls).toEqual([{ name: 'PP_TARGET', description: 'the target', required: true }]);
  });

  test('fenced code blocks are opaque: no phantom decls, no premature section end', () => {
    const body = [
      '## Variables',
      '- PP_REAL — real',
      '```',
      '## Example',
      '- PP_DEMO (required) — sample, must NOT parse',
      '```',
      '- PP_AFTER — still inside the section',
      '## Next',
      '',
    ].join('\n');
    const { decls, issues } = parseVariablesSection(body, 'P.md');
    expect(issues).toEqual([]);
    expect(decls.map((d) => d.name)).toEqual(['PP_REAL', 'PP_AFTER']);
  });

  test('a fence opened OUTSIDE the section hides a fenced `## Variables` heading', () => {
    const body = '## Docs\n```\n## Variables\n- PP_FAKE — inside a fence\n```\n';
    const { decls, issues } = parseVariablesSection(body, 'P.md');
    expect(decls).toEqual([]);
    expect(issues).toEqual([]);
  });

  test('CRLF manifest bodies parse', () => {
    const { decls, issues } = parseVariablesSection(
      '## Variables\r\n- PP_C (default: x) — c\r\n',
      'P.md',
    );
    expect(issues).toEqual([]);
    expect(decls[0]).toEqual({ name: 'PP_C', description: 'c', required: false, default: 'x' });
  });
});

// ----- resolution (D1/D2) ----------------------------------------------------------

describe('resolveVariables', () => {
  test('precedence D2: CLI > env > manifest default', () => {
    const decls = [decl('PP_X', { default: 'dflt' })];
    expect(resolveVariables(decls, { PP_X: 'cli' }, { PP_X: 'env' }).resolved.PP_X).toBe('cli');
    expect(resolveVariables(decls, {}, { PP_X: 'env' }).resolved.PP_X).toBe('env');
    expect(resolveVariables(decls, {}, {}).resolved.PP_X).toBe('dflt');
  });

  test('empty CLI value and empty env value are RESOLVED-empty, not unresolved', () => {
    const decls = [decl('PP_X')];
    for (const out of [
      resolveVariables(decls, { PP_X: '' }, {}),
      resolveVariables(decls, {}, { PP_X: '' }),
    ]) {
      expect(out.resolved.PP_X).toBe('');
      expect(out.unresolved).toEqual([]);
    }
  });

  test('empty CLI value still beats env and default (it IS a value)', () => {
    const decls = [decl('PP_X', { default: 'dflt' })];
    expect(resolveVariables(decls, { PP_X: '' }, { PP_X: 'env' }).resolved.PP_X).toBe('');
  });

  test('optional var with no source ends unresolved (not resolved-empty)', () => {
    const out = resolveVariables([decl('PP_X')], {}, {});
    expect('PP_X' in out.resolved).toBe(false);
    expect(out.unresolved).toEqual(['PP_X']);
  });

  test('required resolves from CLI or env; never from a manifest default (D1.2 defense in depth)', () => {
    const req = decl('PP_R', { required: true });
    expect(resolveVariables([req], { PP_R: 'cli' }, {}).resolved.PP_R).toBe('cli');
    expect(resolveVariables([req], {}, { PP_R: 'env' }).resolved.PP_R).toBe('env');
    // A required decl carrying a default (parse rejects it, but defend anyway):
    const smuggled = decl('PP_R', { required: true, default: 'x' });
    const out = resolveVariables([smuggled], {}, {});
    expect(out.unresolved).toEqual(['PP_R']);
  });

  test('unknown = supplied names not in decls (typo\'d PP_ names AND non-PP names)', () => {
    const out = resolveVariables([decl('PP_X')], { PP_X: 'v', PP_TYPO: 'v', PATH: 'evil' }, {});
    expect(out.unknown.sort()).toEqual(['PATH', 'PP_TYPO']);
    expect(out.resolved).toEqual({ PP_X: 'v' });
  });

  test('an env entry explicitly set to undefined counts as unset', () => {
    const out = resolveVariables([decl('PP_X')], {}, { PP_X: undefined });
    expect(out.unresolved).toEqual(['PP_X']);
  });

  test('vars-file + flags merge order: file first, flags win (caller contract)', () => {
    const file = ['PP_A=file', 'PP_B=file'].map((s) => parseVarAssignment(s)!);
    const flags = ['PP_B=flag'].map((s) => parseVarAssignment(s)!);
    const cliVars: Record<string, string> = {};
    for (const { name, value } of [...file, ...flags]) cliVars[name] = value;
    const out = resolveVariables([decl('PP_A'), decl('PP_B')], cliVars, {});
    expect(out.resolved).toEqual({ PP_A: 'file', PP_B: 'flag' });
  });
});

describe('parseVarAssignment (first-`=` split)', () => {
  test('splits on the FIRST `=` only — the value may contain `=`', () => {
    expect(parseVarAssignment('PP_URL=a=b')).toEqual({ name: 'PP_URL', value: 'a=b' });
    expect(parseVarAssignment('PP_X=--flag=1=2')).toEqual({ name: 'PP_X', value: '--flag=1=2' });
  });

  test('`NAME=` is an explicit EMPTY value (resolved-empty, not unresolved)', () => {
    expect(parseVarAssignment('PP_X=')).toEqual({ name: 'PP_X', value: '' });
  });

  test('no `=` or empty name is rejected (null) — the caller reports usage', () => {
    expect(parseVarAssignment('PP_X')).toBeNull();
    expect(parseVarAssignment('=v')).toBeNull();
    expect(parseVarAssignment('')).toBeNull();
  });

  test('`__proto__` is rejected: it cannot round-trip a Record, so it would dodge L10', () => {
    expect(parseVarAssignment('__proto__=evil')).toBeNull();
    // Other prototype-ish names DO round-trip as own keys and flow to L10:
    const out = resolveVariables([decl('PP_X')], { constructor: 'x', hasOwnProperty: 'y' }, {});
    expect(out.unknown.sort()).toEqual(['constructor', 'hasOwnProperty']);
  });
});

// ----- substitution core + POSIX colon-default matrix (OQ5=a) ----------------------

describe('substituteText', () => {
  test('basic replacement, repeated occurrences', () => {
    expect(substituteText('run ${PP_SVC} for ${PP_SVC}', { PP_SVC: 'api' })).toBe(
      'run api for api',
    );
  });

  test('POSIX colon-default matrix: unset/empty/non-empty × plain/`-`/`:-`', () => {
    const unset: ResolvedVars = {};
    const empty: ResolvedVars = { PP_X: '' };
    const value: ResolvedVars = { PP_X: 'v' };
    // unset: plain throws; both operator forms default
    expect(() => substituteText('${PP_X}', unset)).toThrow(/PP_X/);
    expect(substituteText('${PP_X-d}', unset)).toBe('d');
    expect(substituteText('${PP_X:-d}', unset)).toBe('d');
    // empty: kept by plain and `-`; `:-` swaps in the default (unset OR empty)
    expect(substituteText('${PP_X}', empty)).toBe('');
    expect(substituteText('${PP_X-d}', empty)).toBe('');
    expect(substituteText('${PP_X:-d}', empty)).toBe('d');
    // non-empty: always the value
    expect(substituteText('${PP_X}', value)).toBe('v');
    expect(substituteText('${PP_X-d}', value)).toBe('v');
    expect(substituteText('${PP_X:-d}', value)).toBe('v');
  });

  test('per-occurrence inline defaults: the SAME unresolved var renders different fallbacks', () => {
    expect(substituteText('${PP_X:-a} ${PP_X:-b}', {})).toBe('a b');
  });

  test('`$$` -> `$` uniformly (compose-style), everywhere in the text', () => {
    expect(substituteText('cost $$5 and $$', {})).toBe('cost $5 and $');
    expect(substituteText('a$b stays, $100 stays, $ at end stays: $', {})).toBe(
      'a$b stays, $100 stays, $ at end stays: $',
    );
  });

  test('D13 escape: `$${PP_X}` renders the literal `${PP_X}` even when resolved', () => {
    expect(substituteText('$${PP_X}', { PP_X: 'v' })).toBe('${PP_X}');
    expect(substituteText('$${PP_X:-d}', { PP_X: 'v' })).toBe('${PP_X:-d}');
    expect(substituteText('$${PP_MISSING}', {})).toBe('${PP_MISSING}'); // escape never throws
  });

  test('multi-dollar runs: odd expands with a literal `$` prefix, even stays literal', () => {
    expect(substituteText('$$${PP_X}', { PP_X: 'v' })).toBe('$v');
    expect(substituteText('$$$${PP_X}', { PP_X: 'v' })).toBe('$${PP_X}');
    expect(substituteText('$$$$${PP_X}', { PP_X: 'v' })).toBe('$$v');
  });

  test('throws on an unresolvable non-escaped token (defense in depth), naming the variable', () => {
    expect(() => substituteText('x ${PP_NOPE} y', { PP_OTHER: 'v' })).toThrow(/PP_NOPE/);
  });

  test('a rogue undefined entry in vars is treated as unresolved, never stringified', () => {
    const vars = { PP_X: undefined } as unknown as ResolvedVars;
    expect(substituteText('${PP_X-d}', vars)).toBe('d');
    expect(() => substituteText('${PP_X}', vars)).toThrow(/PP_X/);
  });

  test('inline default text is inserted VERBATIM (no `$$` collapse, no re-scan)', () => {
    expect(substituteText('${PP_X:-a$$b}', {})).toBe('a$$b');
  });
});

// ----- T4 inertness (P0 security gate) ---------------------------------------------

describe('T4 inertness: replacement text is never re-scanned', () => {
  test('a value containing `${PP_OTHER}` stays literal even though PP_OTHER is resolved', () => {
    const vars: ResolvedVars = { PP_A: '${PP_OTHER}', PP_OTHER: 'leaked' };
    expect(substituteText('${PP_A}', vars)).toBe('${PP_OTHER}');
  });

  test('a value containing `${steps.a.output.b}` stays literal', () => {
    expect(substituteText('${PP_A}', { PP_A: '${steps.a.output.b}' })).toBe(
      '${steps.a.output.b}',
    );
  });

  test('a value containing `$${PP_X}` stays literal (not collapsed)', () => {
    expect(substituteText('${PP_A}', { PP_A: '$${PP_X}', PP_X: 'v' })).toBe('$${PP_X}');
  });

  test('replacement/source boundary cannot synthesize a token', () => {
    // PP_A's value ends with '$'; the source continues with '{PP_X}'. A
    // re-scanning engine would see '${PP_X}' and expand it — ours must not.
    expect(substituteText('${PP_A}{PP_X}', { PP_A: '$', PP_X: 'v' })).toBe('${PP_X}');
  });

  test('single-pass is deliberately NOT idempotent-safe: a second call WOULD expand smuggled tokens', () => {
    const vars: ResolvedVars = { PP_A: '${PP_B}', PP_B: 'x' };
    const once = substituteText('${PP_A}', vars);
    expect(once).toBe('${PP_B}');
    // Documented hazard: this is why the engine substitutes exactly once.
    expect(substituteText(once, vars)).toBe('x');
    expect(substituteText(once, vars)).not.toBe(once);
  });
});

// ----- validateRun (fail-fast aggregate) --------------------------------------------

describe('validateRun', () => {
  const file = (name: string, body: string, fm = ''): { file: string; frontmatterRaw: string; body: string } => ({
    file: name,
    frontmatterRaw: fm,
    body,
  });

  test('clean run: declared, resolved, used — zero issues', () => {
    const issues = validateRun([decl('PP_X')], { PP_X: 'v' }, [], [file('s.md', 'run ${PP_X}')], []);
    expect(issues).toEqual([]);
  });

  test('L1 undeclared: any valid token whose name is not declared is an error', () => {
    const issues = validateRun([], {}, [], [file('steps/01.md', 'x ${PP_X} y')], []);
    expect(kinds(issues)).toEqual(['undeclared']);
    expect(issues[0]!).toMatchObject({
      severity: 'error',
      file: 'steps/01.md',
      line: 1,
      name: 'PP_X',
    });
  });

  test('aggregates across files — every problem reported at once, not just the first', () => {
    const issues = validateRun(
      [decl('PP_OK')],
      { PP_OK: 'v' },
      [],
      [
        file('a.md', '${PP_UNDECLARED_1} ${PP_OK}'),
        file('b.md', '${PP_UNDECLARED_2}', 'fm: ${PP_OK}\n'),
      ],
      [],
    );
    expect(ofKind(issues, 'undeclared').length).toBe(2);
    expect(ofKind(issues, 'frontmatter').length).toBe(1);
    expect(new Set(issues.map((i) => i.file))).toEqual(new Set(['a.md', 'b.md']));
  });

  test('L3 frontmatter ban fires per file; L2 near-misses in bodies are errors', () => {
    const issues = validateRun(
      [decl('PP_M')],
      { PP_M: 'v' },
      [],
      [file('s.md', 'body ${pp_near} and ${PP_M}', 'model: ${PP_M}\n')],
      [],
    );
    expect(ofKind(issues, 'frontmatter').length).toBe(1);
    expect(ofKind(issues, 'bad-name').length).toBe(1);
  });

  test('escaped tokens are NOT occurrences: no L1/L6, and the decl counts as unused (L7)', () => {
    const issues = validateRun([decl('PP_X')], { PP_X: 'v' }, [], [file('s.md', 'doc: $${PP_X}')], []);
    expect(kinds(issues)).toEqual(['unused-decl']);
    expect(issues[0]!.severity).toBe('warning');
  });

  test('L6 missing: unresolved optional var with a bare occurrence — lists only the bare spots', () => {
    const issues = validateRun(
      [decl('PP_X')],
      {},
      ['PP_X'],
      [file('s.md', 'a\n${PP_X}\nb ${PP_X:-d}')],
      [],
    );
    const missing = ofKind(issues, 'missing');
    expect(missing.length).toBe(1);
    expect(missing[0]!).toMatchObject({ severity: 'error', name: 'PP_X', file: 's.md', line: 2 });
    expect(missing[0]!.message).toContain('s.md:2');
    expect(missing[0]!.message).not.toContain('s.md:3');
  });

  test('L6 not fired: unresolved optional var whose every occurrence carries an inline default', () => {
    const issues = validateRun(
      [decl('PP_X')],
      {},
      ['PP_X'],
      [file('s.md', '${PP_X:-a} and ${PP_X-b}')],
      [],
    );
    expect(ofKind(issues, 'missing')).toEqual([]);
  });

  test('L6 required: unresolved required var errors even when all occurrences have inline defaults (D1.2), plus L9 per occurrence', () => {
    const issues = validateRun(
      [decl('PP_REQ', { required: true, description: 'the target' })],
      {},
      ['PP_REQ'],
      [file('s.md', '${PP_REQ:-fallback}')],
      [],
    );
    const missing = ofKind(issues, 'missing');
    expect(missing.length).toBe(1);
    expect(missing[0]!.severity).toBe('error');
    expect(missing[0]!.message).toContain('--var PP_REQ=');
    expect(missing[0]!.message).toContain('the target'); // provenance hint
    expect(ofKind(issues, 'ineffective-default').length).toBe(1);
  });

  test('L6 required with zero occurrences still errors (plus L7 unused)', () => {
    const issues = validateRun(
      [decl('PP_REQ', { required: true })],
      {},
      ['PP_REQ'],
      [file('s.md', 'no tokens here')],
      [],
    );
    expect(kinds(errors(issues))).toEqual(['missing']);
    expect(kinds(issues)).toContain('unused-decl');
  });

  test('L7 unused-decl: declared, zero occurrences anywhere — warning', () => {
    const issues = validateRun(
      [decl('PP_USED'), decl('PP_UNUSED')],
      { PP_USED: 'v', PP_UNUSED: 'v' },
      [],
      [file('s.md', '${PP_USED}')],
      [],
    );
    const unused = ofKind(issues, 'unused-decl');
    expect(unused.length).toBe(1);
    expect(unused[0]!).toMatchObject({ severity: 'warning', name: 'PP_UNUSED' });
  });

  test('L8 secretish-name (D14): TOKEN/SECRET/KEY/PASSWORD/CREDENTIAL/PASSWD warn — including KEY-substring names', () => {
    const decls = [
      decl('PP_API_TOKEN'),
      decl('PP_PASSWD'),
      decl('PP_KEYBOARD_LAYOUT'), // contains KEY — warning, not error, BY DESIGN
      decl('PP_TIMEOUT'),
    ];
    const resolved: ResolvedVars = {
      PP_API_TOKEN: 'v',
      PP_PASSWD: 'v',
      PP_KEYBOARD_LAYOUT: 'v',
      PP_TIMEOUT: 'v',
    };
    const body = '${PP_API_TOKEN} ${PP_PASSWD} ${PP_KEYBOARD_LAYOUT} ${PP_TIMEOUT}';
    const issues = validateRun(decls, resolved, [], [file('s.md', body)], []);
    const secretish = ofKind(issues, 'secretish-name');
    expect(secretish.map((i) => i.name).sort()).toEqual([
      'PP_API_TOKEN',
      'PP_KEYBOARD_LAYOUT',
      'PP_PASSWD',
    ]);
    expect(secretish.every((i) => i.severity === 'warning')).toBe(true);
    expect(secretish[0]!.message).toContain('D4');
  });

  test('L9 ineffective-default: inline default on a RESOLVED required var is still dead text', () => {
    const issues = validateRun(
      [decl('PP_REQ', { required: true })],
      { PP_REQ: 'v' },
      [],
      [file('s.md', '${PP_REQ:-x} and ${PP_REQ}')],
      [],
    );
    const ineffective = ofKind(issues, 'ineffective-default');
    expect(ineffective.length).toBe(1);
    expect(ineffective[0]!).toMatchObject({ severity: 'warning', name: 'PP_REQ', line: 1 });
    expect(errors(issues)).toEqual([]); // warning only — the run may start
  });

  test('L10 unknown-cli-var: typo\'d --var and stray --vars-file entries are rejected, never dropped', () => {
    const { unknown } = resolveVariables(
      [decl('PP_X')],
      { PP_X: 'v', PP_TYPO: 'v', SOME_SECRET: 'v' },
      {},
    );
    const issues = validateRun([decl('PP_X')], { PP_X: 'v' }, [], [file('s.md', '${PP_X}')], unknown);
    const l10 = ofKind(issues, 'unknown-cli-var');
    expect(l10.map((i) => i.name).sort()).toEqual(['PP_TYPO', 'SOME_SECRET']);
    expect(l10.every((i) => i.severity === 'error')).toBe(true);
    expect(l10[0]!.message).toContain('not declared');
  });

  test('line numbers stay correct in CRLF bodies', () => {
    const issues = validateRun([], {}, [], [file('s.md', 'a\r\nb\r\n${PP_X}')], []);
    expect(issues[0]!.line).toBe(3);
  });
});

// ----- substituteArgv (E2: per-element, post-tokenization) --------------------------

describe('substituteArgv', () => {
  test('a value with spaces stays exactly ONE argv element', () => {
    const out = substituteArgv(['--msg', '${PP_M}'], { PP_M: 'a b  c' });
    expect(out).toEqual(['--msg', 'a b  c']);
    expect(out.length).toBe(2);
  });

  test('an empty-string value keeps its argv slot (never drops the element)', () => {
    expect(substituteArgv(['run', '${PP_E}', 'tail'], { PP_E: '' })).toEqual(['run', '', 'tail']);
  });

  test('mixed literal + token inside one element', () => {
    expect(substituteArgv(['--url=${PP_U}/x'], { PP_U: 'http://h' })).toEqual([
      '--url=http://h/x',
    ]);
  });

  test('elements are never joined or re-split; untouched elements pass through byte-identical', () => {
    const argv = ['a b', '$${PP_X}', 'plain'];
    expect(substituteArgv(argv, { PP_X: 'v' })).toEqual(['a b', '${PP_X}', 'plain']);
  });

  test('an unresolvable token in any element throws (same contract as substituteText)', () => {
    expect(() => substituteArgv(['ok', '${PP_NOPE}'], {})).toThrow(/PP_NOPE/);
  });
});

// ----- misc API ---------------------------------------------------------------------

describe('hasDeclarations', () => {
  test('zero-change guard', () => {
    expect(hasDeclarations([])).toBe(false);
    expect(hasDeclarations([decl('PP_X')])).toBe(true);
  });
});

// ----- module discipline (07 secrets rule 2 + lib import rule) ----------------------

describe('module discipline', () => {
  const src = readFileSync(new URL('../src/lib/substitution.ts', import.meta.url), 'utf8');

  test('never reads process.env (env is an injected parameter)', () => {
    expect(src).not.toMatch(/process\.env/);
  });

  test('no imports from commands/* and no node builtins — pure module', () => {
    expect(src).not.toMatch(/from\s+'[^']*commands\//);
    expect(src).not.toMatch(/from\s+'node:/);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  test('exported from src/index.ts', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(index).toMatch(/from '\.\/lib\/substitution'/);
    for (const name of [
      'parseVariablesSection',
      'scanOccurrences',
      'scanNearMisses',
      'scanFrontmatter',
      'resolveVariables',
      'validateRun',
      'substituteText',
      'substituteArgv',
      'hasDeclarations',
    ]) {
      expect(index).toContain(name);
    }
  });
});
