// doc-contracts.test.ts — prose↔code lockstep contracts.
//
// The plugin's agent markdown files (agents/*.md), skills (skills/run/SKILL.md)
// and reference docs (docs/*.md) must agree with the CLI's action/record/event
// vocabulary (src/lib/next.ts). Historically that agreement was maintained only
// by "change in lockstep" prose notes. This suite pins the shared string
// literals so a rename on EITHER side fails CI instead of silently drifting.
//
// Design notes:
// - Action names and record kinds are INLINE string literals in the NextAction /
//   NextRecord type unions (src/lib/next.ts ~lines 134-193 and 197-258) — there
//   is no runtime constant to import. We hardcode them here, pin exhaustiveness
//   against the imported TYPES at compile time, and ALSO scan the next.ts source
//   text at runtime so a rename in the source fails this suite even under
//   transpile-only `bun test`.
// - src/lib/event.ts is a generic event WRITER (emitEvent(eventType, kv...)); it
//   defines no event-name literals of its own, so no doc contract is pinned
//   from it.
// - Assertions use plain `.includes()` on file text read once — no regexes.
// - Each failure message names BOTH sides of the contract.

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { NextAction, NextRecord } from '../src/lib/next';

// tests/ lives at <plugin-root>/apps/pipeline-cli/tests — plugin root is 3 up.
const PLUGIN_ROOT = resolve(import.meta.dir, '..', '..', '..');

function readDoc(rel: string): string {
  const p = join(PLUGIN_ROOT, ...rel.split('/'));
  expect(existsSync(p), `expected ${rel} to exist under the plugin root (${PLUGIN_ROOT})`).toBe(true);
  return readFileSync(p, 'utf-8');
}

// ---- files read once ------------------------------------------------------

const nextTs = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'next.ts'), 'utf-8');
const managerMd = readDoc('agents/pipeline-manager.md');
const executorMd = readDoc('agents/step-executor.md');
const improverMd = readDoc('agents/pipeline-improver.md');
const scriptCreatorMd = readDoc('agents/pipeline-script-creator.md');
const runSkillMd = readDoc('skills/run/SKILL.md');
const blockerDoc = readDoc('docs/nested-blocker-delegation.md');
const worktreeDoc = readDoc('docs/worktree-hook-contract.md');
const hooksJsonRaw = readDoc('hooks/hooks.json');

// ---- authoritative vocabulary (inline literals in src/lib/next.ts) ---------

// NextAction['action'] — src/lib/next.ts, the NextAction union (~line 134).
const ENGINE_ACTIONS = [
  'run-step',
  'merge',
  'run-improver',
  'run-script-creator',
  'retrospective',
  'provision-worktree',
  'finalize-worktree',
  'teardown-worktree',
  'done',
  'halt',
  'blocked',
] as const;

// NextRecord['kind'] — src/lib/next.ts, the record interfaces (~line 197).
const RECORD_KINDS = ['step', 'layer', 'merge', 'improver', 'script', 'retro', 'worktree'] as const;

// Compile-time exhaustiveness: renaming/adding an action or kind in next.ts
// makes these assignments a type error (visible under `tsc`/editor; the
// runtime source-scan below catches it under plain `bun test` too).
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _actionsExhaustive: AssertEqual<(typeof ENGINE_ACTIONS)[number], NextAction['action']> = true;
const _kindsExhaustive: AssertEqual<(typeof RECORD_KINDS)[number], NextRecord['kind']> = true;
void _actionsExhaustive;
void _kindsExhaustive;

describe('vocabulary lists match src/lib/next.ts source (runtime lockstep)', () => {
  for (const action of ENGINE_ACTIONS) {
    test(`next.ts defines action '${action}'`, () => {
      expect(
        nextTs.includes(`action: '${action}'`),
        `src/lib/next.ts must define an action literal '${action}' (NextAction union) — if it was renamed, update ENGINE_ACTIONS here AND every doc this suite checks`,
      ).toBe(true);
    });
  }
  for (const kind of RECORD_KINDS) {
    test(`next.ts defines record kind '${kind}'`, () => {
      expect(
        nextTs.includes(`kind: '${kind}'`),
        `src/lib/next.ts must define a record kind literal '${kind}' (NextRecord union) — if it was renamed, update RECORD_KINDS here AND every doc this suite checks`,
      ).toBe(true);
    });
  }
});

// ---- agents/pipeline-manager.md ↔ src/lib/next.ts ---------------------------

describe('agents/pipeline-manager.md ↔ src/lib/next.ts', () => {
  // Every action the engine can surface to the manager. 'finalize-worktree' is
  // deliberately EXCLUDED: the doc explains the CLI runs the finalize hook
  // in-process and the manager never receives that raw action (it only exists
  // under --manual-hooks), so the doc never spells the action name — the
  // finalize contract is pinned below via the halt-reason literals instead.
  const managerActions = ENGINE_ACTIONS.filter((a) => a !== 'finalize-worktree');
  for (const action of managerActions) {
    test(`mentions action '${action}'`, () => {
      expect(
        managerMd.includes(action),
        `agents/pipeline-manager.md must mention action '${action}' emitted by src/lib/next.ts (NextAction union)`,
      ).toBe(true);
    });
  }

  // Record kinds the manager sends back via `--record '{"kind":...}'`.
  // 'worktree' is deliberately EXCLUDED: since the CLI executes the worktree
  // hooks in-process, the manager no longer records {"kind":"worktree"} and the
  // doc does not spell it.
  const managerKinds = RECORD_KINDS.filter((k) => k !== 'worktree');
  for (const kind of managerKinds) {
    test(`mentions record kind '"kind":"${kind}"'`, () => {
      expect(
        managerMd.includes(`"kind":"${kind}"`),
        `agents/pipeline-manager.md must show the '--record' payload '"kind":"${kind}"' matching NextRecord kind '${kind}' in src/lib/next.ts`,
      ).toBe(true);
    });
  }

  // Record/action field names shared with src/lib/next.ts interfaces
  // (StepRecord / LayerRecord / ImproverRecord / the run-step action shape).
  const managerFields = [
    'next_iteration',
    'has_improvement_brief',
    'halt_reason',
    'script_briefs',
    'concurrent',
    'steps',
    'worktree_branch',
    'worktree_path',
    'script_path',
  ];
  for (const field of managerFields) {
    test(`mentions field '${field}'`, () => {
      expect(
        managerMd.includes(field),
        `agents/pipeline-manager.md must mention the field '${field}' from the src/lib/next.ts record/action shapes`,
      ).toBe(true);
    });
  }

  // Step/terminal outcome vocabulary (StepRecord.outcome / TerminalStatus).
  for (const outcome of ['blocked-delegating', 'depth-exhausted', 'halted', 'completed']) {
    test(`mentions outcome '${outcome}'`, () => {
      expect(
        managerMd.includes(outcome),
        `agents/pipeline-manager.md must mention outcome '${outcome}' from src/lib/next.ts (StepRecord.outcome / TerminalStatus)`,
      ).toBe(true);
    });
  }

  // Worktree-hook halt reasons: exact prefixes produced by src/lib/next.ts
  // (onProvisionPhase / onFinalizePhase) that the manager doc tells the manager
  // to quote in its Final Report. This is the finalize lockstep pin standing in
  // for the excluded 'finalize-worktree' action literal.
  for (const reason of ['worktree-create hook failed:', 'worktree-finalize hook failed:']) {
    test(`quotes halt-reason prefix '${reason}'`, () => {
      expect(
        nextTs.includes(`'${reason} '`),
        `src/lib/next.ts must build the halt reason with prefix '${reason}' (onProvisionPhase/onFinalizePhase)`,
      ).toBe(true);
      expect(
        managerMd.includes(reason),
        `agents/pipeline-manager.md must quote the halt-reason prefix '${reason}' produced by src/lib/next.ts`,
      ).toBe(true);
    });
  }

  test('references docs/worktree-hook-contract.md', () => {
    expect(
      managerMd.includes('docs/worktree-hook-contract.md'),
      "agents/pipeline-manager.md must reference 'docs/worktree-hook-contract.md' (the FROZEN consumer hook contract)",
    ).toBe(true);
  });
});

// ---- agents/step-executor.md ------------------------------------------------

describe('agents/step-executor.md contract strings', () => {
  const executorStrings = [
    // Report header + the sequential-advance sentinel consumed by next.ts
    // (advance(): `next === 'PIPELINE_COMPLETE'`).
    'Step Executor Final Report',
    'PIPELINE_COMPLETE',
    // Report fields the manager copies into its --record payloads.
    'result_flags',
    'improvement_brief',
    'blocker_delegation',
    'worktree_branch',
    'worktree_path',
  ];
  for (const s of executorStrings) {
    test(`contains '${s}'`, () => {
      expect(
        executorMd.includes(s),
        `agents/step-executor.md must contain '${s}' — the manager/next.ts side consumes this exact string from the executor's report`,
      ).toBe(true);
    });
  }

  // The six feedback categories, pinned via the canonical one-line enum in the
  // feedback-file template (precise needle: bare 'env' would match anything).
  test('lists the six feedback categories on one line', () => {
    expect(
      executorMd.includes('category: doc-flaw | ambiguity | script-candidate | project-issue | env | friction'),
      "agents/step-executor.md must list the feedback categories exactly as 'category: doc-flaw | ambiguity | script-candidate | project-issue | env | friction' — pipeline-improver.md and the retrospective consume these category names",
    ).toBe(true);
  });
  for (const cat of ['doc-flaw', 'ambiguity', 'script-candidate', 'project-issue', 'friction']) {
    test(`mentions feedback category '${cat}'`, () => {
      expect(
        executorMd.includes(cat),
        `agents/step-executor.md must mention feedback category '${cat}' (consumed by pipeline-improver.md / the retrospective)`,
      ).toBe(true);
    });
  }

  test('references docs/nested-blocker-delegation.md', () => {
    expect(
      executorMd.includes('docs/nested-blocker-delegation.md'),
      "agents/step-executor.md must reference 'docs/nested-blocker-delegation.md' (the blocker_delegation brief contract)",
    ).toBe(true);
  });
});

// ---- agents/pipeline-improver.md ---------------------------------------------

describe('agents/pipeline-improver.md contract strings', () => {
  test("contains 'script_creation_briefs'", () => {
    expect(
      improverMd.includes('script_creation_briefs'),
      "agents/pipeline-improver.md must contain 'script_creation_briefs' — pipeline-manager.md counts this list into the {\"kind\":\"improver\",\"script_briefs\":N} record consumed by src/lib/next.ts",
    ).toBe(true);
  });
  for (const cat of ['doc-flaw', 'ambiguity', 'script-candidate']) {
    test(`mentions doc-actionable category '${cat}'`, () => {
      expect(
        improverMd.includes(cat),
        `agents/pipeline-improver.md must mention doc-actionable feedback category '${cat}' produced by agents/step-executor.md`,
      ).toBe(true);
    });
  }
});

// ---- agents/pipeline-script-creator.md ---------------------------------------

describe('agents/pipeline-script-creator.md contract strings', () => {
  test("contains 'Script Creator Final Report'", () => {
    expect(
      scriptCreatorMd.includes('Script Creator Final Report'),
      "agents/pipeline-script-creator.md must contain 'Script Creator Final Report' — pipeline-manager.md parses this report into the {\"kind\":\"script\"} record consumed by src/lib/next.ts",
    ).toBe(true);
  });
});

// ---- skills/run/SKILL.md ------------------------------------------------------

describe('skills/run/SKILL.md contract strings', () => {
  test("contains 'Pipeline Manager Final Report'", () => {
    expect(
      runSkillMd.includes('Pipeline Manager Final Report'),
      "skills/run/SKILL.md must contain 'Pipeline Manager Final Report' — the supervisor acts on the structured report agents/pipeline-manager.md returns",
    ).toBe(true);
  });
  test("contains 'blocked-delegating'", () => {
    expect(
      runSkillMd.includes('blocked-delegating'),
      "skills/run/SKILL.md must contain 'blocked-delegating' — the TerminalStatus from src/lib/next.ts that triggers the supervisor's nested-blocker poll-wait",
    ).toBe(true);
  });
});

// ---- docs/nested-blocker-delegation.md ----------------------------------------

describe('docs/nested-blocker-delegation.md contract strings', () => {
  for (const field of ['blocker_target_repo', 'new_issue_body', 'partial_work_note']) {
    test(`contains brief field '${field}'`, () => {
      expect(
        blockerDoc.includes(field),
        `docs/nested-blocker-delegation.md must document blocker_delegation brief field '${field}' emitted by agents/step-executor.md`,
      ).toBe(true);
    });
  }
});

// ---- docs/worktree-hook-contract.md --------------------------------------------

describe('docs/worktree-hook-contract.md contract strings', () => {
  test("contains 'PIPELINE_WT_ACTION'", () => {
    expect(
      worktreeDoc.includes('PIPELINE_WT_ACTION'),
      "docs/worktree-hook-contract.md must document the 'PIPELINE_WT_ACTION' env var of the FROZEN PIPELINE_WT_* hook contract (src/lib/hooks.ts)",
    ).toBe(true);
  });
});

// ---- hooks/hooks.json -----------------------------------------------------------

describe('hooks/hooks.json', () => {
  test('parses as JSON and registers a SubagentStop entry with matcher "pipeline-manager"', () => {
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(hooksJsonRaw);
    }, 'hooks/hooks.json must parse as JSON').not.toThrow();
    const hooks = (parsed as { hooks?: Record<string, Array<{ matcher?: string }>> }).hooks;
    expect(hooks, "hooks/hooks.json must have a top-level 'hooks' object").toBeDefined();
    const subagentStop = hooks?.SubagentStop;
    expect(
      Array.isArray(subagentStop),
      "hooks/hooks.json must register a 'SubagentStop' hook array",
    ).toBe(true);
    expect(
      (subagentStop ?? []).some((e) => e.matcher === 'pipeline-manager'),
      "hooks/hooks.json SubagentStop must carry matcher 'pipeline-manager' — the agent name in agents/pipeline-manager.md frontmatter; renaming the agent must update this matcher",
    ).toBe(true);
  });
});
