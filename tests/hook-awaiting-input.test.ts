/**
 * Notification → `run.awaiting_input` — hooks/analytics_relay.ts (design 05).
 *
 *   bun test tests/hook-awaiting-input.test.ts
 *
 * Three things this pins:
 *   • the CLASSIFIER — structured `notification_type` wins when present, a
 *     narrow regex covers the (frequent) case where it is absent, and idle
 *     "finished responding" notifications never produce an event;
 *   • the HANDLER — event shape, excerpt cap, run-id resolution, and that an
 *     unresolvable run id still emits (ambient stream);
 *   • the GATE ORDERING — the load-bearing one: with the UI opted OUT the
 *     Notification branch STILL writes, because a blocked run is visible
 *     through `pipeline logs` with no daemon at all.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { classifyNotification, handleNotification } from "../../../hooks/analytics_relay.ts";

const HOOK_PATH = resolve(import.meta.dir, "../../../hooks/analytics_relay.ts");

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pipeline-awaiting-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.PIPELINE_RUN_ID;
});

function makeProject(): string {
  const root = mkdtempSync(join(tmpRoot, "proj-"));
  mkdirSync(join(root, ".pipeline", "demo", "steps"), { recursive: true });
  return root;
}

function journalPath(root: string): string {
  return join(root, ".pipeline", ".runtime", "events.jsonl");
}

function readEvents(root: string): Record<string, unknown>[] {
  const p = journalPath(root);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Spawn the hook and keep stderr — with debug on, the gate that stopped it
 *  names itself, which is how the ordering tests observe how far it got. */
function spawnHookVerbose(
  root: string,
  env: Record<string, string | undefined>,
  payload: Record<string, unknown>,
): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK_PATH], {
    cwd: root,
    env: { ...process.env, PIPELINE_JOURNAL_DEBUG: "1", ...env },
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

describe("classifyNotification", () => {
  test("structured notification_type is the primary discriminator", () => {
    expect(classifyNotification({ notification_type: "permission_prompt" })).toBe("permission");
    expect(classifyNotification({ notification_type: "agent_needs_input" })).toBe("input");
    expect(classifyNotification({ notification_type: "idle_prompt" })).toBeNull();
    // An unknown structured type is NOT guessed at from the message — the
    // field being present means the producer told us what this is.
    expect(
      classifyNotification({ notification_type: "something_new", message: "Claude needs your permission to use Bash" }),
    ).toBeNull();
  });

  test("regex fallback covers the (common) case where the field is absent", () => {
    const positives: [string, "permission" | "input"][] = [
      ["Claude needs your permission to use Bash", "permission"],
      ["Claude is waiting for your input", "input"],
      ["Approval needed to continue", "permission"],
      ["Claude needs your approval to edit src/app.ts", "permission"],
      ["Awaiting your response", "input"],
    ];
    for (const [message, kind] of positives) {
      expect(classifyNotification({ message })).toBe(kind);
    }
  });

  test("idle notifications and noise never classify as a wait", () => {
    for (const message of [
      "Claude has finished responding",
      "Claude is done with your task",
      "Task completed successfully",
      "",
    ]) {
      expect(classifyNotification({ message })).toBeNull();
    }
    expect(classifyNotification({})).toBeNull();
  });
});

describe("handleNotification", () => {
  test("writes one run.awaiting_input with kind, excerpt and the resolved run id", () => {
    const root = makeProject();
    process.env.PIPELINE_RUN_ID = "run-42";
    handleNotification(
      { message: "Claude needs your permission to use Bash", session_id: "sess-1" },
      root,
      null,
    );
    const events = readEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "run.awaiting_input",
      run_id: "run-42",
      session_id: "sess-1",
      data: { kind: "permission", message_excerpt: "Claude needs your permission to use Bash" },
    });
  });

  test("an unresolvable run id still emits — ambient, stream-only", () => {
    const root = makeProject();
    handleNotification({ message: "Claude is waiting for your input" }, root, null);
    const events = readEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]!.run_id).toBeNull();
    expect((events[0]!.data as Record<string, unknown>).kind).toBe("input");
  });

  test("the excerpt is capped at 200 chars", () => {
    const root = makeProject();
    handleNotification({ message: "Claude needs your permission to " + "x".repeat(500) }, root, null);
    const excerpt = (readEvents(root)[0]!.data as Record<string, unknown>).message_excerpt as string;
    expect(excerpt.length).toBe(200);
  });

  test("a non-wait notification writes nothing at all", () => {
    const root = makeProject();
    handleNotification({ message: "Claude has finished responding" }, root, null);
    expect(readEvents(root)).toHaveLength(0);
  });
});

describe("gate ordering (the load-bearing case)", () => {
  function spawnHook(root: string, env: Record<string, string | undefined>): number | null {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      cwd: root,
      env: { ...process.env, PIPELINE_RUN_ID: "run-gate", ...env },
      input: JSON.stringify({
        hook_event_name: "Notification",
        message: "Claude needs your permission to use Bash",
        session_id: "sess-gate",
      }),
      encoding: "utf-8",
      timeout: 30_000,
    });
    return r.status;
  }

  test("UI opted OUT + awaiting gate ON ⇒ the event is STILL written", () => {
    const root = makeProject();
    expect(spawnHook(root, { PIPELINE_JOURNAL_ENABLED: "0" })).toBe(0);
    const events = readEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("run.awaiting_input");
  });

  test("awaiting gate OFF ⇒ nothing is written, even with the UI on", () => {
    const root = makeProject();
    expect(spawnHook(root, { PIPELINE_AWAITING_INPUT_ENABLED: "0", PIPELINE_JOURNAL_ENABLED: "1" })).toBe(0);
    expect(readEvents(root)).toHaveLength(0);
  });

  test("default (both unset) ⇒ written", () => {
    const root = makeProject();
    expect(
      spawnHook(root, { PIPELINE_AWAITING_INPUT_ENABLED: undefined, PIPELINE_JOURNAL_ENABLED: undefined }),
    ).toBe(0);
    expect(readEvents(root)).toHaveLength(1);
  });

  test("outside a pipeline project ⇒ no journal is created", () => {
    const bare = mkdtempSync(join(tmpRoot, "bare-"));
    expect(spawnHook(bare, {})).toBe(0);
    expect(existsSync(journalPath(bare))).toBe(false);
  });
});

/**
 * The ordering has a SECOND requirement, easy to lose: the Notification branch
 * needs the payload before the UI gate, but the FILESYSTEM work must stay
 * behind it. `journalEnabled()` promises an opt-out costs ~zero per call,
 * and this hook runs twice per tool call — so an opted-out user must never pay
 * `resolveProjectRoot` + `hasPipelineDirUpTo`.
 *
 * Observable proof: with debug on, the gate that stopped the hook names itself.
 * Seeing the opt-out line WITHOUT the "no .pipeline from …" line means
 * the walk was never reached.
 */
describe("gate ordering — the opt-out short-circuit stays cheap", () => {
  const toolPayload = {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_response: {},
    session_id: "sess-cheap",
  };

  test("UI opted out ⇒ a tool event returns BEFORE any filesystem walk", () => {
    const bare = mkdtempSync(join(tmpRoot, "cheap-"));
    const r = spawnHookVerbose(bare, { PIPELINE_JOURNAL_ENABLED: "0" }, toolPayload);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("PIPELINE_JOURNAL_ENABLED explicitly opted out");
    // The cwd gate logs this line whenever it runs and finds nothing. Its
    // absence is the assertion: the walk never happened.
    expect(r.stderr).not.toContain("no .pipeline from");
  });

  test("UI enabled ⇒ the same event DOES reach the cwd gate", () => {
    const bare = mkdtempSync(join(tmpRoot, "cheap-on-"));
    const r = spawnHookVerbose(bare, { PIPELINE_JOURNAL_ENABLED: "1" }, toolPayload);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("no .pipeline from");
  });

  test("a Notification still reaches the walk with the UI opted out", () => {
    const root = makeProject();
    const r = spawnHookVerbose(
      root,
      { PIPELINE_JOURNAL_ENABLED: "0" },
      { hook_event_name: "Notification", message: "Claude needs your permission to use Bash" },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("PIPELINE_JOURNAL_ENABLED explicitly opted out");
    expect(readEvents(root)).toHaveLength(1);
  });
});
