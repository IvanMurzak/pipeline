// lib/run-vars.ts — the command-layer PP_* run-init seam (env-variables
// design 05 §3, a3): `--var` folding, the strict `--vars-file` loader, the
// declaration-line lookup, and initRunVariables' resolve→validate→F2-message
// composition over a1's pure engine. CLI-level integration lives in
// next.test.ts / drive-script-steps.test.ts / step-run.test.ts — this suite
// pins the unit contracts (especially the 09 error-quality bar) directly.

import { test, expect } from 'bun:test';
import {
  addVarFlag,
  collectRunVarsFiles,
  declarationLines,
  initRunVariables,
  loadVarsFile,
  mergeCliVars,
} from '../src/lib/run-vars';
import { parseVariablesSection, type VariableDecl } from '../src/lib/substitution';

// --- addVarFlag ---------------------------------------------------------------

test('addVarFlag: repeatable, first-= split, empty value kept, later same-name flag wins', () => {
  const out: { varFlags?: Record<string, string>; varsError?: string } = {};
  addVarFlag(out, 'PP_URL=a=b');
  addVarFlag(out, 'PP_EMPTY=');
  addVarFlag(out, 'PP_URL=second');
  expect(out.varsError).toBeUndefined();
  expect(out.varFlags).toEqual({ PP_URL: 'second', PP_EMPTY: '' });
});

test('addVarFlag: no `=`, empty name, or __proto__ set the loud usage error', () => {
  for (const bad of ['PP_X', '=v', '__proto__=x', '']) {
    const out: { varFlags?: Record<string, string>; varsError?: string } = {};
    addVarFlag(out, bad);
    expect(out.varsError).toContain('--var expects NAME=value');
  }
  const out: { varFlags?: Record<string, string>; varsError?: string } = {};
  addVarFlag(out, undefined);
  expect(out.varsError).toContain('--var expects NAME=value');
});

// --- loadVarsFile ---------------------------------------------------------------

test('loadVarsFile: dotenv niceties parse (comments, blanks, export prefix, quotes)', () => {
  const r = loadVarsFile('vars.env', () =>
    ['# release config', '', 'PP_A=1', 'export PP_B=two', 'PP_C="three four"', "PP_D='x'", 'PP_E='].join('\n'),
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.vars).toEqual({ PP_A: '1', PP_B: 'two', PP_C: 'three four', PP_D: 'x', PP_E: '' });
});

test('loadVarsFile: malformed lines are errors naming line NUMBERS only — content is never echoed', () => {
  const r = loadVarsFile('bad.env', () => 'PP_A=1\nsome-secret-blob\n# ok\n=nokey\n');
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected failure');
  expect(r.error).toContain('lines 2, 4');
  expect(r.error).not.toContain('some-secret-blob');
  expect(r.error).not.toContain('nokey');
});

test('loadVarsFile: a __proto__ line is reported as malformed, never silently dropped (T11)', () => {
  // '__proto__' cannot round-trip through a plain Record (the assignment hits
  // the prototype setter, creating NO own key), so without the guard the
  // entry would vanish with no error — the exact invisible misconfiguration
  // the strict loader forbids. parseVarAssignment rejects the same name on
  // --var.
  const r = loadVarsFile('proto.env', () => '__proto__=x\nPP_A=1\n');
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected failure');
  expect(r.error).toContain('line 1');
});

test('loadVarsFile: an unreadable file is a startup error', () => {
  const r = loadVarsFile('gone.env', () => {
    throw new Error('ENOENT: no such file');
  });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('expected failure');
  expect(r.error).toContain('could not be read');
  expect(r.error).toContain('gone.env');
});

// --- mergeCliVars ---------------------------------------------------------------

test('mergeCliVars: undefined when NEITHER source was passed; flags beat file entries', () => {
  expect(mergeCliVars(undefined, undefined)).toBeUndefined();
  expect(mergeCliVars({}, undefined)).toEqual({}); // an empty file still counts as "supplied"
  expect(mergeCliVars({ PP_A: 'file', PP_B: 'file' }, { PP_A: 'flag' })).toEqual({
    PP_A: 'flag',
    PP_B: 'file',
  });
});

// --- declarationLines -------------------------------------------------------------

test('declarationLines: file-true line numbers; fences opaque; section-bounded; backticks tolerated', () => {
  const manifest = [
    '---', // 1 (frontmatter — raw text is scanned, lines stay file-true)
    'execution: sequential', // 2
    '---', // 3
    '# P', // 4
    '', // 5
    '## Variables', // 6
    '- `PP_A` (required) — a', // 7
    '```', // 8
    '- PP_FENCED — inside a fence, ignored', // 9
    '```', // 10
    '- PP_B — b', // 11
    '', // 12
    '## Graph', // 13
    '- PP_OUTSIDE — after the section, ignored', // 14
  ].join('\n');
  const lines = declarationLines(manifest);
  expect(lines.get('PP_A')).toBe(7);
  expect(lines.get('PP_B')).toBe(11);
  expect(lines.has('PP_FENCED')).toBe(false);
  expect(lines.has('PP_OUTSIDE')).toBe(false);
});

// --- initRunVariables — resolve/validate/message -----------------------------------

const MANIFEST = [
  '# P',
  '',
  '## Variables',
  '- PP_REQ (required) — the required one',
  '- PP_OPT — the optional one',
  '- PP_DEF (default: dv) — defaulted',
  '',
].join('\n');

function decls(): VariableDecl[] {
  return parseVariablesSection(MANIFEST, 'PIPELINE.md').decls;
}

test('initRunVariables: clean resolution freezes CLI > env > default and reports no errors', () => {
  const files = [{ file: 'steps/01-a.md', raw: 'Use ${PP_REQ} and ${PP_OPT:-fallback}.\n' }];
  const r = initRunVariables(decls(), { PP_REQ: 'cli' }, { PP_REQ: 'env-loses', PP_OPT: 'env' }, files, MANIFEST);
  expect(r.errors).toEqual([]);
  expect(r.message).toBeNull();
  expect(r.resolved).toEqual({ PP_REQ: 'cli', PP_OPT: 'env', PP_DEF: 'dv' });
});

test('initRunVariables: the F2 message meets the 09 bar — declaration line, every occurrence, per-kind remedy, aggregated', () => {
  const files = [
    { file: 'steps/01-a.md', raw: 'Line one.\nDeploy ${PP_REQ}.\nOpt ${PP_OPT}.\n' },
    { file: 'steps/02-b.md', raw: 'Also ${PP_REQ} and ${PP_OPT:-covered}.\n' },
  ];
  const r = initRunVariables(decls(), {}, {}, files, MANIFEST);
  expect(r.errors.map((e) => e.kind).sort()).toEqual(['missing', 'missing']);
  const msg = r.message!;
  // Aggregated: both variables, one message.
  expect(msg).toContain('PP_REQ (required) — the required one');
  expect(msg).toContain('PP_OPT — the optional one');
  // Declaration lines (MANIFEST: PP_REQ on 4, PP_OPT on 5).
  expect(msg).toContain('PIPELINE.md:4');
  expect(msg).toContain('PIPELINE.md:5');
  // EVERY occurrence, not just the failing ones.
  expect(msg).toContain('steps/01-a.md:2, steps/02-b.md:1'); // PP_REQ
  expect(msg).toContain('steps/01-a.md:3, steps/02-b.md:1'); // PP_OPT (both occurrences)
  expect(msg).toContain('occurrences without an inline default: steps/01-a.md:3');
  // Per-kind remedies: the required block offers --var/env ONLY.
  const reqBlock = msg.slice(msg.indexOf('  PP_REQ'), msg.indexOf('  PP_OPT'));
  expect(reqBlock).toContain('--var PP_REQ=');
  expect(reqBlock).toContain('PP_REQ environment variable');
  expect(reqBlock.toLowerCase()).not.toContain('default');
  // The optional block additionally offers both default channels.
  const optBlock = msg.slice(msg.indexOf('  PP_OPT'));
  expect(optBlock).toContain('(default: ...)');
  expect(optBlock).toContain('${PP_OPT:-value}');
});

test('initRunVariables: an unresolved required var with ZERO occurrences still halts a full-run init', () => {
  const r = initRunVariables(decls(), {}, {}, [], MANIFEST);
  expect(r.errors.some((e) => e.kind === 'missing' && e.name === 'PP_REQ')).toBe(true);
  expect(r.message).toContain('used at: (no occurrences found)');
});

test('initRunVariables: scopeMissingToOccurrences (step run) demands only variables the given files use', () => {
  const files = [{ file: 'steps/02-impl.md', raw: 'Uses ${PP_DEF} only.\n' }];
  const r = initRunVariables(decls(), {}, {}, files, MANIFEST, { scopeMissingToOccurrences: true });
  // PP_REQ and PP_OPT are unresolved but occur nowhere in the given files.
  expect(r.errors).toEqual([]);
  expect(r.resolved).toEqual({ PP_DEF: 'dv' });
});

test('initRunVariables: L10 — unknown names error with PP_/non-PP_ specific hints; empty-string CLI value is RESOLVED', () => {
  const files = [{ file: 'steps/01-a.md', raw: 'Use ${PP_REQ}.\n' }];
  const r = initRunVariables(
    decls(),
    { PP_REQ: '', PP_TYPO: 'x', DATABASE_URL: 'postgres://u:hunter2@h/db' },
    {},
    files,
    MANIFEST,
  );
  // PP_REQ='' resolves (set-but-empty is a value, POSIX) — only L10s remain.
  expect(r.resolved.PP_REQ).toBe('');
  expect(r.errors.every((e) => e.kind === 'unknown-cli-var')).toBe(true);
  const msg = r.message!;
  expect(msg).toContain('Unknown variables supplied');
  expect(msg).toContain('PP_TYPO');
  expect(msg).toContain('declare it under ## Variables or fix the name');
  expect(msg).toContain('DATABASE_URL');
  expect(msg).toContain('PP_[A-Z0-9_]+');
  expect(msg).toContain('.env cannot be bulk-imported');
  expect(msg).not.toContain('hunter2'); // values never echoed
});

test('initRunVariables: an escaped $${PP_REQ} is not an occurrence; command:-line occurrences DO count (raw scan)', () => {
  const stepRaw = [
    '---',
    'type: script',
    'command: tool --svc ${PP_REQ}',
    '---',
    'Body documents `$${PP_REQ}` literally.',
    '',
  ].join('\n');
  const r = initRunVariables(decls(), {}, {}, [{ file: 'steps/01-s.md', raw: stepRaw }], MANIFEST);
  const req = r.errors.find((e) => e.kind === 'missing' && e.name === 'PP_REQ');
  expect(req).toBeDefined();
  // Exactly the command:-line occurrence (file line 3); the escaped body form
  // is documentation, not an occurrence.
  expect(r.message).toContain('used at: steps/01-s.md:3');
});

test('initRunVariables: an UNDECLARED token on a command: line surfaces via the Substitution errors bucket', () => {
  // Plan-time (a2) blanks the exempt command:/script: frontmatter lines from
  // its sweep, so an undeclared token there sails past the plan gate — the
  // run-init raw scan is the first (and only) place it can be caught. This
  // pins the formatter's non-missing/non-unknown bucket as REACHABLE.
  const stepRaw = ['---', 'type: script', 'command: tool --x ${PP_NOT_DECLARED}', '---', 'Body.', ''].join('\n');
  const r = initRunVariables(decls(), { PP_REQ: 'v' }, {}, [{ file: 'steps/01-s.md', raw: stepRaw }], MANIFEST);
  expect(r.errors.some((e) => e.kind === 'undeclared' && e.name === 'PP_NOT_DECLARED')).toBe(true);
  expect(r.message).toContain('Substitution errors:');
  expect(r.message).toContain('steps/01-s.md:3');
});

// --- collectRunVarsFiles -------------------------------------------------------------

test('collectRunVarsFiles: plan-style labels; PP_-less files skipped; manifest raw always returned', () => {
  const texts: Record<string, string> = {
    'ROOT/PIPELINE.md': MANIFEST, // decl bullets only — no ${PP_ tokens → not scanned
    'ROOT/steps/01-a.md': 'Uses ${PP_REQ}.\n',
    'ROOT/steps/02-b.md': 'No tokens here.\n',
  };
  const { files, manifestRaw } = collectRunVarsFiles(
    'ROOT',
    [
      { path: 'ROOT/steps/01-a.md', rel: '01-a.md' },
      { path: 'ROOT/steps/02-b.md', rel: '02-b.md' },
    ],
    (p) => {
      const t = texts[p.replace(/\\/g, '/')];
      if (t === undefined) throw new Error('ENOENT');
      return t;
    },
  );
  expect(manifestRaw).toBe(MANIFEST);
  expect(files.map((f) => f.file)).toEqual(['steps/01-a.md']);
});
