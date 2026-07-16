// `pipeline plan --root <pipeline_root> [--default-model <m>] [--model <step_id>=<m> ...]
//   [--default-effort <level>] [--effort <step_id>=<level> ...]`
//
// Prints the execution plan as JSON to stdout. Exit code 1 when the plan has
// hard errors (so the caller can halt), 0 otherwise. Warnings never affect the
// exit code — they ride along in the JSON.

import { computePlan } from '../lib/plan';

export function runPlan(args: string[]): number {
  let root: string | undefined;
  let defaultModel: string | null | undefined;
  let modelOverrides: Record<string, string> | undefined;
  let defaultEffort: string | null | undefined;
  let effortOverrides: Record<string, string> | undefined;

  const asModel = (v: string | undefined): string | null =>
    v === undefined || v === '' || v === 'null' || v === 'inherit' ? null : v;

  const addOverride = (v: string | undefined): string | null => {
    const sep = v?.indexOf('=') ?? -1;
    const id = sep > 0 ? v!.slice(0, sep).trim() : '';
    const model = sep > 0 ? v!.slice(sep + 1).trim() : '';
    if (!id || !model) return `--model expects <step_id>=<model>, got '${v ?? ''}'`;
    (modelOverrides ??= {})[id] = model;
    return null;
  };

  const addEffortOverride = (v: string | undefined): string | null => {
    const sep = v?.indexOf('=') ?? -1;
    const id = sep > 0 ? v!.slice(0, sep).trim() : '';
    const effort = sep > 0 ? v!.slice(sep + 1).trim() : '';
    if (!id || !effort) return `--effort expects <step_id>=<level>, got '${v ?? ''}'`;
    (effortOverrides ??= {})[id] = effort;
    return null;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let overrideError: string | null = null;
    if (a === '--root') root = args[++i];
    else if (a.startsWith('--root=')) root = a.slice('--root='.length);
    else if (a === '--default-model') defaultModel = asModel(args[++i]);
    else if (a.startsWith('--default-model=')) defaultModel = asModel(a.slice('--default-model='.length));
    else if (a === '--model') overrideError = addOverride(args[++i]);
    else if (a.startsWith('--model=')) overrideError = addOverride(a.slice('--model='.length));
    else if (a === '--default-effort') defaultEffort = asModel(args[++i]);
    else if (a.startsWith('--default-effort=')) defaultEffort = asModel(a.slice('--default-effort='.length));
    else if (a === '--effort') overrideError = addEffortOverride(args[++i]);
    else if (a.startsWith('--effort=')) overrideError = addEffortOverride(a.slice('--effort='.length));
    if (overrideError !== null) {
      process.stderr.write(`pipeline plan: ${overrideError}\n`);
      return 2;
    }
  }
  if (!root) {
    process.stderr.write('pipeline plan: --root is required\n');
    return 2;
  }

  const plan = computePlan(root, {
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(modelOverrides === undefined ? {} : { modelOverrides }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    ...(effortOverrides === undefined ? {} : { effortOverrides }),
  });
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  return plan.errors.length ? 1 : 0;
}
