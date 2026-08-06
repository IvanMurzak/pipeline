/**
 * Scope-discipline regression (issue #11 invariant #2).
 *
 *   bun test tests/mirror-scope-discipline.test.ts
 *
 * Goal: an ordinary terminal Claude session in a pipeline project —
 * one that NEVER spawns a pipeline-executor — must NEVER get a mirror
 * binding written for it. A binding is what names a session's transcript
 * path to the rest of the system, so "no binding" is the point at which
 * an unrelated session's transcript stops being reachable at all.
 *
 * Why a dedicated test: this is a load-bearing privacy invariant, and it
 * OUTLIVED the thing it was written for. It originally coupled the hook
 * side (handlePostToolUse only binds for pipeline-executor spawns) to the
 * daemon side (the local dashboard's MirrorService only tailed bound
 * transcripts). The dashboard is gone (plugin-thin `p3`) and the daemon
 * half of this file went with it — but the bindings registry did not: it
 * is now `ux-v2` `b7`'s session→(run, step) correlation source, read by
 * `analytics_relay.ts` itself to decide which run an event belongs to.
 * The hook half of the invariant is therefore still exactly as
 * load-bearing as it was, and is what this file now pins.
 *
 * The two deleted cases asserted MirrorService behaviour (an empty
 * bindings file never tails a transcript on disk); they are named in the
 * PR that removed them rather than silently dropped.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handlePostToolUse } from "../../../hooks/analytics_relay.ts";

let tmpRoot: string;
let homeDir: string;
let projectRoot: string;
let bindingsPath: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "scope-discipline-"));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("HOME", prevHome);
  restore("USERPROFILE", prevUserProfile);
});

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpRoot, "home-"));
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
  mkdirSync(join(projectRoot, ".pipeline", ".runtime"), { recursive: true });
  bindingsPath = join(homeDir, ".claude", "pipeline-ui", "active-mirror-bindings.jsonl");
});

function makePayload(opts: { toolName: string; toolInput?: object; toolResponse?: object }): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    tool_name: opts.toolName,
    tool_input: opts.toolInput ?? {},
    tool_response: opts.toolResponse ?? { content: "ok" },
    tool_use_id: `toolu_${Math.random().toString(36).slice(2, 10)}`,
  };
}

describe("scope-discipline invariant", () => {
  test("Read/Edit/Bash tools never write a mirror binding", () => {
    handlePostToolUse(makePayload({ toolName: "Read", toolInput: { file_path: "/x" } }), projectRoot, null);
    handlePostToolUse(makePayload({ toolName: "Edit", toolInput: { file_path: "/x", old_string: "a", new_string: "b" } }), projectRoot, null);
    handlePostToolUse(makePayload({ toolName: "Bash", toolInput: { command: "ls" } }), projectRoot, null);
    handlePostToolUse(makePayload({ toolName: "Write", toolInput: { file_path: "/x", content: "" } }), projectRoot, null);
    handlePostToolUse(makePayload({ toolName: "Grep", toolInput: { pattern: "foo" } }), projectRoot, null);
    expect(existsSync(bindingsPath)).toBe(false);
  });

  test("Agent spawn of non-pipeline-executor subagent does NOT write a binding", () => {
    // Subagents that aren't pipeline-executor are typed differently
    // (general-purpose, Explore, code-reviewer, etc.). None of these
    // should bind — those are ordinary coding-session subagents that
    // happen to fire inside a project that also uses the pipeline
    // plugin.
    for (const subagentType of [
      "general-purpose",
      "Explore",
      "code-reviewer",
      "Plan",
      "pipeline-improver",
    ]) {
      handlePostToolUse(
        makePayload({
          toolName: "Agent",
          toolInput: {
            subagent_type: subagentType,
            prompt: "do an ordinary research task",
          },
        }),
        projectRoot,
        null,
      );
    }
    expect(existsSync(bindingsPath)).toBe(false);
  });

  test("Even pipeline-executor without an iteration path does NOT bind", () => {
    // Some odd usage: someone hand-invokes pipeline-executor with a
    // freeform prompt. parseExecutorSpawn returns null. No binding.
    handlePostToolUse(
      makePayload({
        toolName: "Agent",
        toolInput: {
          subagent_type: "pipeline-executor",
          prompt: "do whatever you think is right",
        },
      }),
      projectRoot,
      null,
    );
    expect(existsSync(bindingsPath)).toBe(false);
  });

  test("Full mix: 50 non-executor PostToolUse calls still bind NOTHING", () => {
    // Replay 50 ordinary tool calls of the kind an unrelated coding session
    // fires constantly. Not one of them may name a session to the bindings
    // registry — which is what would make its transcript reachable.
    for (let i = 0; i < 50; i++) {
      handlePostToolUse(makePayload({ toolName: i % 2 === 0 ? "Bash" : "Read" }), projectRoot, null);
    }
    expect(existsSync(bindingsPath)).toBe(false);
  });
});
