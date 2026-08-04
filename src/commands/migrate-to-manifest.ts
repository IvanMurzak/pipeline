// `pipeline migrate --to-manifest` — generate a v2 `pipeline.yml` from a v1
// pipeline.
//
// A sibling of the format-version ladder in ./migrate.ts, not a rung on it. The
// ladder stamps `format: N` into PIPELINE.md and walks adjacent versions with
// paired up/down transforms; this migration REPLACES PIPELINE.md's role
// entirely, has nowhere to put that stamp, and has no honest inverse (a step's
// frontmatter and its `## Next` chain both collapse into the manifest, and
// nothing reconstructs which came from where).
//
// THE GATE IS EQUIVALENCE, NOT LINT. The emitted manifest is parsed back and
// re-planned, and every field that decides what runs — order, names modulo the
// rename, model, effort, type, every step spec — must match the v1 plan before
// anything is written. A migration that produces a valid pipeline which is not
// THIS pipeline is the failure worth guarding against, and "it lints" would not
// catch it.

import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MANIFEST_BASENAME, type PipelineFiles } from '../lib/migrate';
import { MANIFEST_FILENAME, parseManifest } from '../lib/manifest';
import { emitManifest } from '../lib/manifest-emit';
import { planFromManifest } from '../lib/manifest-plan';
import { computePlanFromMarkdownFor, findEnclosingPipelineRoot, type Plan } from '../lib/plan';

/** The subset of the migrate command's args this mode reads. */
export interface ToManifestArgs {
  root?: string;
  dryRun: boolean;
  json: boolean;
  force: boolean;
}

/** The injectable seams this mode uses (a subset of MigrateDeps). */
export interface ToManifestDeps {
  cwd?: string;
  exists?: (path: string) => boolean;
  loadFiles?: (root: string) => PipelineFiles;
}

/**
 * The fields a migration must preserve EXACTLY.
 *
 * Step names are compared through the rename map: dropping an `NN-` ordering
 * prefix is the whole point, and anything else moving is a bug. Everything the
 * plan derives but does not decide — `path`, `rel`, `index` — is deliberately
 * absent: those are labels, and v2 labels a composed step differently on
 * purpose.
 */
function planFingerprint(plan: Plan, rename?: Map<string, string>): string {
  const id = (v: string): string => rename?.get(v) ?? v;
  return JSON.stringify({
    mode: plan.mode,
    isolation: plan.isolation,
    base_branch: plan.base_branch,
    submodules: plan.submodules,
    default_model: plan.default_model,
    default_effort: plan.default_effort,
    layers: plan.layers?.map((l) => l.map(id)) ?? null,
    steps: plan.steps.map((s) => ({
      name: id(s.step_id),
      type: s.type,
      model: s.model,
      effort: s.effort,
      retries: s.retries,
      script: s.script_spec && {
        script: s.script_spec.script,
        timeoutS: s.script_spec.timeoutS,
        retries: s.script_spec.retries,
        onFailure: s.script_spec.onFailure,
        params: s.script_spec.params,
        output: s.script_spec.output,
      },
      pipeline: s.pipeline_spec && {
        pipeline: s.pipeline_spec.pipeline,
        params: s.pipeline_spec.params,
        output: s.pipeline_spec.output,
      },
      gate: s.gate_spec,
    })),
  });
}

export function runToManifest(
  parsed: ToManifestArgs,
  out: (s: string) => void,
  err: (s: string) => void,
  emitUsageErr: (msg: string) => number,
  deps: ToManifestDeps = {},
): number {
  const cwd = deps.cwd ?? process.cwd();
  const exists = deps.exists ?? existsSync;
  const root = parsed.root ?? findEnclosingPipelineRoot(cwd) ?? cwd;

  if (!exists(join(root, MANIFEST_BASENAME))) {
    return emitUsageErr(
      `no ${MANIFEST_BASENAME} found at ${root} — point --root at a v1 pipeline folder`,
    );
  }
  const target = join(root, MANIFEST_FILENAME);
  if (exists(target) && !parsed.force) {
    err(
      `pipeline migrate: ${MANIFEST_FILENAME} already exists at ${root}.\n` +
        'It is hand-edited once written, so this refuses rather than overwrite it — ' +
        'pass --force if you mean to regenerate it.\n',
    );
    return 1;
  }

  // Read the MARKDOWN definition specifically: under --force the pipeline
  // already has a manifest, and re-planning that one would migrate the output
  // of the last migration instead of the pipeline.
  const before = computePlanFromMarkdownFor(root);
  if (before.errors.length) {
    err(
      'pipeline migrate: the v1 pipeline does not plan cleanly — fix that first, ' +
        'so the migration has something unambiguous to translate:\n  ' +
        before.errors.join('\n  ') +
        '\n',
    );
    return 1;
  }

  const bodyRelByStepId: Record<string, string> = {};
  for (const s of before.steps) bodyRelByStepId[s.step_id] = `steps/${s.rel}`;

  const emitted = emitManifest({ plan: before, pipelineName: basename(root), bodyRelByStepId });

  // Checked BEFORE the parse gate, because some of these leave the manifest not
  // merely lossy but INVALID — a `command:` step emits no `script:` — and
  // "generated manifest does not parse" would then blame the generator for a
  // limitation the pipeline ran into. Reported either way; a real run refuses.
  if (emitted.unsupported.length) {
    err(`pipeline migrate: ${emitted.unsupported.length} thing(s) a v2 manifest cannot express:\n`);
    for (const u of emitted.unsupported) err(`  - ${u}\n`);
    if (!parsed.dryRun) {
      err(
        'Nothing written. Writing a manifest that silently drops these would hand you a ' +
          'pipeline that looks migrated and runs differently — resolve them in the v1 ' +
          'pipeline first, or re-run with --dry-run to see what the rest would become.\n',
      );
      return 1;
    }
    err('[dry-run] shown below anyway, so you can see what the rest becomes.\n\n');
  }

  const parsedManifest = parseManifest(emitted.yaml);
  if (parsedManifest.errors.length) {
    err(
      `pipeline migrate: the generated ${MANIFEST_FILENAME} does not parse. ` +
        'That is a bug in the generator, not in your pipeline:\n  ' +
        parsedManifest.errors.join('\n  ') +
        '\n',
    );
    return 1;
  }
  const after = planFromManifest(parsedManifest, root);
  const rename = new Map(emitted.renames.map((r) => [r.from, r.to] as const));
  const beforePrint = planFingerprint(before, rename);
  const afterPrint = planFingerprint(after);
  if (after.errors.length || beforePrint !== afterPrint) {
    err(
      `pipeline migrate: the generated ${MANIFEST_FILENAME} would run a DIFFERENT ` +
        'pipeline — nothing written.\n' +
        (after.errors.length ? `  plan errors: ${after.errors.join('; ')}\n` : '') +
        `  before: ${beforePrint}\n` +
        `  after:  ${afterPrint}\n`,
    );
    return 1;
  }

  const renamed = emitted.renames.filter((r) => r.from !== r.to);

  if (parsed.json) {
    out(
      JSON.stringify({
        root,
        wrote: parsed.dryRun ? [] : [MANIFEST_FILENAME],
        dryRun: parsed.dryRun,
        steps: before.steps.length,
        renames: emitted.renames,
        unsupported: emitted.unsupported,
      }) + '\n',
    );
  } else {
    const prefix = parsed.dryRun ? '[dry-run] ' : '';
    out(`${prefix}${MANIFEST_FILENAME} for ${basename(root)} (${before.steps.length} steps)\n\n`);
    out(emitted.yaml);
    out('\nStep names (old -> new):\n');
    for (const r of emitted.renames) {
      out(`  ${r.from} -> ${r.to}${r.from === r.to ? '' : '   (ordering prefix dropped)'}\n`);
    }
    if (renamed.length) {
      out(
        `\n${renamed.length} step(s) renamed. Anything that names a step by its OLD id — ` +
          'a `--start`, a saved resume command, a reference you kept in prose — has to ' +
          'use the new name.\n',
      );
    }
  }

  if (parsed.dryRun) {
    // The JSON form already said `dryRun: true, wrote: []` — appending prose to
    // it would leave the caller with output that is not JSON.
    if (!parsed.json) out('\n[dry-run] no files written.\n');
    return 0;
  }
  try {
    writeFileSync(target, emitted.yaml);
  } catch (e) {
    err(`pipeline migrate: could not write ${target}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  out(`\nWrote ${target}\n`);
  out(
    `${MANIFEST_BASENAME} is left in place — it is prose for humans now and is no longer ` +
      'parsed. The `## Next` sections in the step files are dead too: the manifest decides ' +
      'the order.\n',
  );
  return 0;
}
