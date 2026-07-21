// Template library for `pipeline clone`.
//
// `pipeline clone <name>` copies a bundled, ready-made pipeline TEMPLATE into a
// consumer project's `./.claude/pipeline/<name>/`. The templates SHIP INSIDE
// this package (apps/pipeline-cli/templates/<name>/…) so they are present both
// when the CLI runs from a plugin checkout AND from an installed npm tarball:
// the published `bin` points at `src/cli.ts` verbatim (no bundle step ships —
// see the note in src/cli.ts), so `src/lib/` and `templates/` sit exactly two
// directories apart in BOTH layouts. This module therefore resolves the
// templates dir relative to ITSELF (`import.meta.dir`), never the caller's cwd.
// (Package packaging: apps/pipeline-cli/package.json declares no `files`
// allowlist, so everything not git-ignored — including templates/ — ships;
// tests/packed-artifact.test.ts asserts the template is actually in the tarball
// so a future restrictive `files` field that dropped it would fail CI.)
//
// ADDING A TEMPLATE (e.g. the real `support-answer` pipeline, a later task):
//   1. drop a folder under `apps/pipeline-cli/templates/<name>/` containing a
//      valid `PIPELINE.md` + a `steps/` folder (mirror `example-minimal`);
//   2. add one { name, description } entry to the TEMPLATES array below.
// Because this is a `.ts` file, that registry edit trips CI — which runs the
// template-validity check in tests/clone.test.ts (every registered template
// must have a PIPELINE.md + steps/ and plan cleanly) and the clone tests.

import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface TemplateEntry {
  /** The clone id (`pipeline clone <name>`) AND the folder name under templates/. */
  name: string;
  /** One-line human description shown in `--help`, `--list`, and errors. */
  description: string;
}

/**
 * The bundled template library. `example-minimal` is a FIXTURE — the
 * smallest-valid pipeline, present so `clone` can be built and tested
 * end-to-end. Real ready-made templates (e.g. `support-answer`) join this list
 * exactly the same way (see the "ADDING A TEMPLATE" note above).
 */
export const TEMPLATES: readonly TemplateEntry[] = [
  {
    name: 'example-minimal',
    description: 'Smallest-valid two-step sequential pipeline skeleton to copy and adapt.',
  },
  {
    name: 'support-answer',
    description: 'Local support-desk RAG: BM25 retrieval over a docs folder, then a grounded, cited answer.',
  },
  {
    name: 'ship-feature',
    description: 'Flagship dev flow: plan → implement → bounded self-review loop → open a PR → wait for CI → merge on human approval.',
  },
] as const;

/** Absolute path to the bundled `templates/` directory — resolved relative to
 *  THIS module so it works identically from a source checkout and an npm/bun
 *  install (the published `bin` is `src/cli.ts`, so `src/lib` → `../../templates`
 *  in both). */
export const TEMPLATES_DIR = join(import.meta.dir, '..', '..', 'templates');

/** Absolute path to one template's source folder (existence not checked here). */
export function templateDir(name: string): string {
  return join(TEMPLATES_DIR, name);
}

/** The registered template with this exact name, or undefined. */
export function findTemplate(name: string): TemplateEntry | undefined {
  return TEMPLATES.find((t) => t.name === name);
}

/** A one-per-line "  <name> — <description>" listing for help/error output. */
export function formatTemplateList(): string {
  return TEMPLATES.map((t) => `  ${t.name} — ${t.description}`).join('\n');
}

/**
 * Copy a template's whole folder tree to `dest`. Cross-platform (node/bun `fs`
 * only — `cpSync` recursively copies the tree; the parent of `dest` is created
 * first). The caller owns the overwrite policy: `dest` must NOT already exist
 * (clone removes it first under `--force`), so a stale file from a prior clone
 * can never survive into the fresh copy.
 */
export function copyTemplateTree(name: string, dest: string): void {
  const src = templateDir(name);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}
