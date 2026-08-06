/**
 * Hook gate + project resolution — hooks/analytics_relay.ts.
 *
 *   bun test tests/hook-cwd-gate.test.ts
 *
 * The analytics + SessionStart hooks must fire whenever the session is
 * ANYWHERE inside a pipeline project — at the root, deep inside
 * `.pipeline/<name>/steps/…` (hand-orchestrating a pipeline from a
 * terminal), OR inside a git worktree checked out under
 * `.claude/worktrees/<name>/` (Claude Code spawns subagents there). The
 * gate (`hasPipelineDirUpTo`) walks up from cwd to the resolved project
 * root; routing (`resolveProjectRoot`) maps a worktree to its MAIN repo.
 *
 * Regression guard for the bug where a hook gating on `cwd/.pipeline`
 * silently dropped every event the moment the agent cd'd below the root.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  hasPipelineDirUpTo,
  resolveProjectRoot,
} from "../../../hooks/analytics_relay.ts";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-gate-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Create a project with `.pipeline/<name>/steps/` and return its root. */
function makeProject(): string {
  const root = mkdtempSync(join(tmpRoot, "proj-"));
  mkdirSync(join(root, ".pipeline", "demo", "steps"), { recursive: true });
  return root;
}

describe("hasPipelineDirUpTo", () => {
  test("fires when cwd IS the project root", () => {
    const root = makeProject();
    expect(hasPipelineDirUpTo(root, root)).toBe(true);
  });

  test("fires when cwd is deep inside .pipeline/<name>/steps", () => {
    const root = makeProject();
    const deep = join(root, ".pipeline", "demo", "steps");
    expect(hasPipelineDirUpTo(deep, root)).toBe(true);
  });

  test("fires when cwd is inside a worktree under .claude/worktrees/<name>", () => {
    const root = makeProject();
    const wt = join(root, ".claude", "worktrees", "feature-x", "src", "sub");
    mkdirSync(wt, { recursive: true });
    // Walk-up from the worktree's deep cwd, bounded at the MAIN repo root,
    // still discovers <root>/.pipeline.
    expect(hasPipelineDirUpTo(wt, root)).toBe(true);
  });

  test("does NOT fire for a project with no .pipeline", () => {
    const root = mkdtempSync(join(tmpRoot, "plain-"));
    mkdirSync(join(root, "src"), { recursive: true });
    expect(hasPipelineDirUpTo(join(root, "src"), root)).toBe(false);
  });

  test("does NOT fire when .pipeline is ABOVE the project root (bounded)", () => {
    // outer/.pipeline exists, but the resolved project root is
    // outer/inner (no pipeline) — the walk must stop at inner and not leak
    // upward into outer (prevents a stray $HOME/.pipeline from
    // classifying every nested project).
    const outer = mkdtempSync(join(tmpRoot, "outer-"));
    mkdirSync(join(outer, ".pipeline"), { recursive: true });
    const inner = join(outer, "inner");
    mkdirSync(join(inner, "work"), { recursive: true });
    expect(hasPipelineDirUpTo(join(inner, "work"), inner)).toBe(false);
  });
});

describe("resolveProjectRoot maps a .claude/worktrees git worktree to its main repo", () => {
  test("project_root = main repo, worktree = the worktree dir", () => {
    const main = mkdtempSync(join(tmpRoot, "main-"));
    // Main repo: a real .git directory + a worktree admin dir with commondir.
    mkdirSync(join(main, ".git", "worktrees", "feature-x"), { recursive: true });
    writeFileSync(join(main, ".git", "worktrees", "feature-x", "commondir"), "../..\n", "utf-8");
    mkdirSync(join(main, ".pipeline", "demo", "steps"), { recursive: true });

    // Worktree under .claude/worktrees/<name> with a .git FILE pointing at
    // the admin dir (exactly how `git worktree add` lays it out).
    const wt = join(main, ".claude", "worktrees", "feature-x");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(
      join(wt, ".git"),
      `gitdir: ${join(main, ".git", "worktrees", "feature-x")}\n`,
      "utf-8",
    );

    const cwd = join(wt, "src");
    const { project_root, worktree } = resolveProjectRoot(cwd);
    expect(project_root).toBe(main);
    expect(worktree).toBe(wt);

    // And the gate, bounded at the resolved main-repo root, still fires.
    expect(hasPipelineDirUpTo(cwd, project_root)).toBe(true);
  });
});
