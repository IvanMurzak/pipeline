/**
 * UserPromptSubmit prompt-match relay — hooks/prompt_match_relay.ts.
 *
 *   bun test tests/hook-prompt-match.test.ts
 *
 * The hook is OFF BY DEFAULT (PIPELINE_PROMPT_MATCH_ENABLED gate, same
 * semantics as PIPELINE_UI_ENABLED) and must NEVER block a prompt: every
 * path exits 0, and only a CONFIDENT single BM25 match (exactly one
 * candidate, or top1/top2 score ratio ≥ 2.0 — the /pipeline:dispatch
 * ambiguity threshold) produces stdout, in the documented
 * hookSpecificOutput.additionalContext JSON shape.
 *
 * Two layers of coverage:
 *   • unit tests over the exported helpers (skip rules, confidence rule);
 *   • end-to-end subprocess tests that spawn the hook exactly the way
 *     Claude Code does (bun <hook> with the UserPromptSubmit payload on
 *     stdin, cwd = an arbitrary consumer project dir) — this also proves
 *     the hook's file-relative import of lib/match.ts resolves from a cwd
 *     OUTSIDE the plugin directory.
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  AMBIGUITY_RATIO,
  MIN_PROMPT_LENGTH,
  buildContextLine,
  findPipelineDirUpTo,
  pickConfidentMatch,
  promptFromPayload,
  shouldSkipPrompt,
} from "../../../hooks/prompt_match_relay.ts";
import type { Candidate, MatchResult } from "../src/lib/match";

const HOOK_PATH = resolve(import.meta.dir, "../../../hooks/prompt_match_relay.ts");

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const created: string[] = [];
afterAll(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  created.push(d);
  return d;
}

/** Write one pipeline (PIPELINE.md + steps/01-*.md) under <root>/.claude/pipeline/. */
function writePipeline(root: string, name: string, endState: string, scopeIn: string): string {
  const pipelineRoot = join(root, ".claude", "pipeline", name);
  mkdirSync(join(pipelineRoot, "steps"), { recursive: true });
  writeFileSync(
    join(pipelineRoot, "PIPELINE.md"),
    [
      `# ${name}`,
      "",
      "## End State",
      endState,
      "",
      "## Scope",
      `- In: ${scopeIn}`,
      "- Out:",
      "",
      "## Project Context",
      "Test fixture.",
      "",
      "## Invariants",
      "- none",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(join(pipelineRoot, "steps", "01-start.md"), "# Step 1\n", "utf-8");
  return pipelineRoot;
}

/** A consumer project with ONE distinctive pipeline → confident match. */
function makeConfidentProject(): { root: string; pipelineRoot: string } {
  const root = mkTmp("pm-confident-");
  const pipelineRoot = writePipeline(
    root,
    "deploy-service",
    "The service is deployed to production with release notes published.",
    "deploy service production release rollout publish",
  );
  return { root, pipelineRoot };
}

/** A consumer project with TWO near-identical pipelines → ambiguous match. */
function makeAmbiguousProject(): string {
  const root = mkTmp("pm-ambiguous-");
  writePipeline(
    root,
    "deploy-service-alpha",
    "The service is deployed to production with release notes published.",
    "deploy service production release rollout publish",
  );
  writePipeline(
    root,
    "deploy-service-beta",
    "The service is deployed to production with release notes published.",
    "deploy service production release rollout publish",
  );
  return root;
}

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the hook exactly like Claude Code does: `bun <hook>` with the
 *  payload on stdin. `enabled` controls the PIPELINE_PROMPT_MATCH_ENABLED
 *  gate; `envValue` lets the falsy-value cases override it. */
function runHook(
  cwd: string,
  payload: Record<string, unknown>,
  opts: { envValue?: string } = {},
): HookRun {
  const env = { ...process.env };
  delete env.PIPELINE_PROMPT_MATCH_ENABLED;
  if (opts.envValue !== undefined) env.PIPELINE_PROMPT_MATCH_ENABLED = opts.envValue;
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    cwd,
    env,
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function promptPayload(cwd: string, promptText: string): Record<string, unknown> {
  return {
    session_id: "test-session",
    transcript_path: join(cwd, "transcript.jsonl"),
    cwd,
    permission_mode: "default",
    hook_event_name: "UserPromptSubmit",
    prompt_text: promptText,
  };
}

const CONFIDENT_PROMPT =
  "Deploy the service to production and publish the release notes for the rollout";

// ---------------------------------------------------------------------------
// Unit: prompt extraction + skip rules
// ---------------------------------------------------------------------------

describe("promptFromPayload", () => {
  test("reads the documented prompt_text field", () => {
    expect(promptFromPayload({ prompt_text: "hello world" })).toBe("hello world");
  });

  test("falls back to the legacy prompt field", () => {
    expect(promptFromPayload({ prompt: "hello world" })).toBe("hello world");
  });

  test("returns empty string when neither is present", () => {
    expect(promptFromPayload({})).toBe("");
  });
});

describe("shouldSkipPrompt", () => {
  test("skips slash commands", () => {
    expect(shouldSkipPrompt("/pipeline:run some long enough argument text")).toBe(true);
  });

  test("skips prompts shorter than the minimum length", () => {
    expect(shouldSkipPrompt("fix bug")).toBe(true);
    expect(shouldSkipPrompt("x".repeat(MIN_PROMPT_LENGTH - 1))).toBe(true);
  });

  test("skips empty/whitespace prompts", () => {
    expect(shouldSkipPrompt("")).toBe(true);
    expect(shouldSkipPrompt("   \n  ")).toBe(true);
  });

  test("accepts a normal task-length prompt", () => {
    expect(shouldSkipPrompt(CONFIDENT_PROMPT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: confidence rule (mirrors /pipeline:dispatch's 2.0 ratio gate)
// ---------------------------------------------------------------------------

function cand(name: string, score: number): Candidate {
  return {
    name,
    manifest: join("proj", ".claude", "pipeline", name, "PIPELINE.md"),
    first_iteration: join("proj", ".claude", "pipeline", name, "steps", "01-start.md"),
    end_state: "done",
    score,
    matched_terms: [],
  };
}

function res(...candidates: Candidate[]): MatchResult {
  return { task: "t", candidates, excluded: [] };
}

describe("pickConfidentMatch", () => {
  test("0 candidates → null", () => {
    expect(pickConfidentMatch(res())).toBeNull();
  });

  test("exactly 1 candidate → confident", () => {
    expect(pickConfidentMatch(res(cand("a", 0.5)))?.name).toBe("a");
  });

  test("ratio exactly 2.0 → confident top match (dispatch's >= threshold)", () => {
    expect(AMBIGUITY_RATIO).toBe(2.0);
    expect(pickConfidentMatch(res(cand("a", 2.0), cand("b", 1.0)))?.name).toBe("a");
  });

  test("ratio below 2.0 → ambiguous → null", () => {
    expect(pickConfidentMatch(res(cand("a", 1.9), cand("b", 1.0)))).toBeNull();
    expect(pickConfidentMatch(res(cand("a", 1.0), cand("b", 1.0)))).toBeNull();
  });
});

describe("buildContextLine", () => {
  test("names the pipeline, its root, and both run entry points", () => {
    const c = cand("deploy-service", 1.0);
    const line = buildContextLine(c);
    expect(line).toContain("'deploy-service'");
    expect(line).toContain(join("proj", ".claude", "pipeline", "deploy-service"));
    expect(line).toContain(`/pipeline:run ${c.first_iteration}`);
    expect(line).toContain("/pipeline:dispatch");
  });

  test("omits /pipeline:run when the pipeline has no first iteration", () => {
    const c = { ...cand("deploy-service", 1.0), first_iteration: null };
    const line = buildContextLine(c);
    expect(line).not.toContain("/pipeline:run");
    expect(line).toContain("/pipeline:dispatch");
  });
});

describe("findPipelineDirUpTo", () => {
  test("finds .claude/pipeline from a nested cwd", () => {
    const { root } = makeConfidentProject();
    const deep = join(root, ".claude", "pipeline", "deploy-service", "steps");
    expect(findPipelineDirUpTo(deep, root)).toBe(join(root, ".claude", "pipeline"));
  });

  test("returns null when no pipeline dir exists up to the root", () => {
    const root = mkTmp("pm-plain-");
    mkdirSync(join(root, "src"), { recursive: true });
    expect(findPipelineDirUpTo(join(root, "src"), root)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: spawn the hook as Claude Code does
// ---------------------------------------------------------------------------

describe("prompt_match_relay end-to-end", () => {
  test("disabled gate (env unset) → exit 0, no output, no filesystem effects", () => {
    const { root } = makeConfidentProject();
    const r = runHook(root, promptPayload(root, CONFIDENT_PROMPT));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("disabled gate (falsy values) → exit 0, no output", () => {
    const { root } = makeConfidentProject();
    for (const v of ["0", "false", "no", "off", ""]) {
      const r = runHook(root, promptPayload(root, CONFIDENT_PROMPT), { envValue: v });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  test("slash-command prompt → exit 0, no output", () => {
    const { root } = makeConfidentProject();
    const r = runHook(
      root,
      promptPayload(root, "/pipeline:run some long enough argument"),
      { envValue: "1" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("short prompt → exit 0, no output", () => {
    const { root } = makeConfidentProject();
    const r = runHook(root, promptPayload(root, "deploy service"), { envValue: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("no .claude/pipeline dir → exit 0, no output", () => {
    const root = mkTmp("pm-nopipe-");
    mkdirSync(join(root, "src"), { recursive: true });
    const r = runHook(root, promptPayload(root, CONFIDENT_PROMPT), { envValue: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("confident match → exit 0 + hookSpecificOutput.additionalContext line", () => {
    const { root, pipelineRoot } = makeConfidentProject();
    const r = runHook(root, promptPayload(root, CONFIDENT_PROMPT), { envValue: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toBe("");
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("Task may match the pre-authored pipeline 'deploy-service'");
    expect(ctx).toContain(pipelineRoot);
    expect(ctx).toContain(`/pipeline:run ${join(pipelineRoot, "steps", "01-start.md")}`);
    expect(ctx).toContain("/pipeline:dispatch");
    // ONE line only — never a multi-line context dump.
    expect(ctx).not.toContain("\n");
  });

  test("confident match works with the legacy `prompt` field name too", () => {
    const { root } = makeConfidentProject();
    const payload = promptPayload(root, CONFIDENT_PROMPT);
    delete payload.prompt_text;
    payload.prompt = CONFIDENT_PROMPT;
    const r = runHook(root, payload, { envValue: "1" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("'deploy-service'");
  });

  test("ambiguous match (two near-identical pipelines) → exit 0, no output", () => {
    const root = makeAmbiguousProject();
    const r = runHook(root, promptPayload(root, CONFIDENT_PROMPT), { envValue: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("malformed stdin → exit 0, no output (never blocks the prompt)", () => {
    const { root } = makeConfidentProject();
    const env = { ...process.env, PIPELINE_PROMPT_MATCH_ENABLED: "1" };
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      cwd: root,
      env,
      input: "this is not json {{{",
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});
