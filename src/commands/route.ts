// `pipeline route --root <pipeline_root> --run-id <id> --from <step_id> --flags <json> [--default-model <m>]`
//
// The deterministic next-step decision for a Variant-A (graph) pipeline. Given
// the step that just finished (`--from`) and the result flags it emitted
// (`--flags`), evaluate the routing graph + this run's per-edge counters and
// print the next action as JSON:
//   { action: "run", step_id, path, model, transitions }
//   { action: "done" }
//   { action: "halt", reason }
//
// Per-run state lives at <pipeline_root>/.runtime/<run-id>/route.json (gitignored).
// Exit code: 1 on `halt` (the caller should stop), 0 otherwise.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { computePlan } from '../lib/plan';
import { routeNext, emptyRouteState, type RouteState } from '../lib/graph';

interface RouteArgs {
  root?: string;
  runId?: string;
  from?: string;
  flags: Record<string, unknown>;
  defaultModel?: string | null;
}

function parseArgs(args: string[]): RouteArgs {
  const out: RouteArgs = { flags: {} };
  const take = (i: number) => args[i + 1];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = (p: string) => (a.startsWith(p + '=') ? a.slice(p.length + 1) : undefined);
    if (a === '--root') out.root = take(i++);
    else if (eq('--root') !== undefined) out.root = eq('--root');
    else if (a === '--run-id') out.runId = take(i++);
    else if (eq('--run-id') !== undefined) out.runId = eq('--run-id');
    else if (a === '--from') out.from = take(i++);
    else if (eq('--from') !== undefined) out.from = eq('--from');
    else if (a === '--default-model') out.defaultModel = asModel(take(i++));
    else if (eq('--default-model') !== undefined) out.defaultModel = asModel(eq('--default-model'));
    else if (a === '--flags') out.flags = parseFlags(take(i++));
    else if (eq('--flags') !== undefined) out.flags = parseFlags(eq('--flags'));
  }
  return out;
}

function asModel(v: string | undefined): string | null {
  return v === undefined || v === '' || v === 'null' || v === 'inherit' ? null : v;
}

function parseFlags(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stateDir(root: string, runId: string): string {
  return join(root, '.runtime', runId);
}

function loadState(root: string, runId: string): RouteState {
  const f = join(stateDir(root, runId), 'route.json');
  if (!existsSync(f)) return emptyRouteState();
  try {
    const v = JSON.parse(readFileSync(f, 'utf8'));
    return {
      counters: v && typeof v.counters === 'object' && v.counters ? v.counters : {},
      transitions: Number.isInteger(v?.transitions) ? v.transitions : 0,
    };
  } catch {
    return emptyRouteState();
  }
}

function saveState(root: string, runId: string, state: RouteState): void {
  // Self-contained gitignore so route state never pollutes the consumer's commits.
  mkdirSync(join(root, '.runtime'), { recursive: true });
  const gi = join(root, '.runtime', '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '*\n', 'utf8');
  const dir = stateDir(root, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'route.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function runRoute(args: string[]): number {
  const a = parseArgs(args);
  if (!a.root || !a.runId || !a.from) {
    process.stderr.write('pipeline route: --root, --run-id, and --from are required\n');
    return 2;
  }

  const plan = computePlan(a.root, a.defaultModel === undefined ? {} : { defaultModel: a.defaultModel });
  if (!plan.graph) {
    process.stdout.write(
      JSON.stringify({ action: 'halt', reason: 'pipeline has no `## Graph` section — route is only for graph pipelines' }) + '\n',
    );
    return 1;
  }
  if (plan.errors.length) {
    process.stdout.write(JSON.stringify({ action: 'halt', reason: `plan errors: ${plan.errors.join('; ')}` }) + '\n');
    return 1;
  }

  const state = loadState(a.root, a.runId);
  const decision = routeNext(plan.graph, a.from, a.flags, state);
  saveState(a.root, a.runId, state);

  if (decision.action === 'run') {
    const step = plan.steps.find((s) => s.step_id === decision.target);
    if (!step) {
      process.stdout.write(
        JSON.stringify({ action: 'halt', reason: `graph routed to '${decision.target}' but no step has that step_id` }) + '\n',
      );
      return 1;
    }
    process.stdout.write(
      JSON.stringify(
        { action: 'run', step_id: step.step_id, path: step.path, model: step.model, transitions: state.transitions },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }

  process.stdout.write(JSON.stringify(decision, null, 2) + '\n');
  return decision.action === 'halt' ? 1 : 0;
}
