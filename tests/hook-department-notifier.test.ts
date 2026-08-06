/**
 * SessionStart department-notifier relay — hooks/department_notifier_relay.ts.
 *
 *   bun test tests/hook-department-notifier.test.ts
 *
 * RENAME NOTE (a11, simplified-onboarding — 08-terminology.md / D10 / D31):
 * this file was tests/hook-mesh-notifier.test.ts, testing
 * hooks/mesh_notifier_relay.ts's meshNotifyEnabled(). The hook, its gate
 * function, and the env var it reads are all renamed; PIPELINE_MESH_NOTIFY_ENABLED
 * is still READ as a fallback (with a deprecation warning) and is covered
 * below.
 *
 * Two layers of coverage, mirroring hook-prompt-match.test.ts:
 *   • unit tests over the exported pure/near-pure helpers (gate, context
 *     building, the "already running" branch of ensureDaemonRunning);
 *   • end-to-end subprocess tests that spawn the hook exactly the way
 *     Claude Code does (bun <hook> with the SessionStart payload on stdin).
 *
 * Deliberately NOT covered here: the actual `spawnNotifyDaemon` code path
 * (when no live daemon lock exists). Exercising it for real would fork a
 * genuine detached `pipeline department notify` background process — a poll
 * loop hitting the network forever — which must never happen inside
 * `bun test`. Every scenario below either gates out before that branch (no
 * credential store) or pre-seeds a lock pointing at THIS test process's own
 * pid (always alive), so `ensureDaemonRunning` takes the "already running"
 * early return. The real spawn path is smoke-tested manually / proven at the
 * `e3` gate, same deferral the deleted dashboard's launcher hook made.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  departmentNotifyEnabled,
  buildAdditionalContext,
  ensureDaemonRunning,
} from "../../../hooks/department_notifier_relay.ts";
import { notifyLockPath, notifyJournalPath, type TaskNotification } from "../src/lib/department-notify";
import { credentialFilePath, writeCredentialStore, realFs, type HomeContext } from "../src/lib/cloud-config";

const HOOK_PATH = resolve(import.meta.dir, "../../../hooks/department_notifier_relay.ts");

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    try {
      rmSync(created.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function mkHome(): string {
  const d = mkdtempSync(join(tmpdir(), "department-notify-hook-home-"));
  created.push(d);
  return d;
}

function ctxFor(home: string): HomeContext {
  return { platform: process.platform, env: { PIPELINE_CLOUD_HOME: home }, homedir: home };
}

function sampleNotification(overrides: Partial<TaskNotification> = {}): TaskNotification {
  return {
    server: "https://api.example.com",
    orgSlug: "acme",
    taskId: "task-1",
    contextId: "ctx-1",
    departmentId: "dep-1",
    previousState: null,
    state: "INPUT_REQUIRED",
    updatedAt: "2026-07-24T00:00:00.000Z",
    detectedAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// departmentNotifyEnabled
// ---------------------------------------------------------------------------

describe("departmentNotifyEnabled", () => {
  const KEY = "PIPELINE_DEPARTMENT_NOTIFY_ENABLED";
  const LEGACY_KEY = "PIPELINE_MESH_NOTIFY_ENABLED";
  const saved = process.env[KEY];
  const savedLegacy = process.env[LEGACY_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    if (savedLegacy === undefined) delete process.env[LEGACY_KEY];
    else process.env[LEGACY_KEY] = savedLegacy;
  });

  test("both unset → enabled by default", () => {
    delete process.env[KEY];
    delete process.env[LEGACY_KEY];
    expect(departmentNotifyEnabled()).toBe(true);
  });

  test.each(["0", "false", "no", "off", "FALSE", "Off"])("falsy value %p on the new var disables", (v) => {
    delete process.env[LEGACY_KEY];
    process.env[KEY] = v;
    expect(departmentNotifyEnabled()).toBe(false);
  });

  test.each(["1", "true", "yes", "on", "anything"])("non-falsy value %p on the new var keeps it enabled", (v) => {
    delete process.env[LEGACY_KEY];
    process.env[KEY] = v;
    expect(departmentNotifyEnabled()).toBe(true);
  });

  test("new var unset, legacy var falsy → disables (fallback still honored)", () => {
    delete process.env[KEY];
    process.env[LEGACY_KEY] = "0";
    expect(departmentNotifyEnabled()).toBe(false);
  });

  test("new var unset, legacy var truthy → enabled (fallback still honored)", () => {
    delete process.env[KEY];
    process.env[LEGACY_KEY] = "1";
    expect(departmentNotifyEnabled()).toBe(true);
  });

  test("both set → the new var wins", () => {
    process.env[KEY] = "1";
    process.env[LEGACY_KEY] = "0";
    expect(departmentNotifyEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAdditionalContext
// ---------------------------------------------------------------------------

describe("buildAdditionalContext", () => {
  test("a single notification: singular wording, mentions task/department/org", () => {
    const ctx = buildAdditionalContext([sampleNotification()]);
    expect(ctx).toContain("You have 1 department task update since");
    expect(ctx).toContain("task-1");
    expect(ctx).toContain("dep-1");
    expect(ctx).toContain("/mcp");
  });

  test("multiple notifications: plural wording, one line each", () => {
    const ctx = buildAdditionalContext([
      sampleNotification({ taskId: "task-1" }),
      sampleNotification({ taskId: "task-2", state: "COMPLETED" }),
    ]);
    expect(ctx).toContain("You have 2 department task updates since");
    expect(ctx).toContain("task-1");
    expect(ctx).toContain("task-2");
  });

  test("more than 10 notifications: shows 10 lines plus an 'and N more' trailer", () => {
    const many = Array.from({ length: 13 }, (_, i) => sampleNotification({ taskId: `task-${i}` }));
    const ctx = buildAdditionalContext(many);
    expect(ctx).toContain("You have 13 department task updates since");
    expect(ctx).toContain("…and 3 more.");
    for (let i = 0; i < 10; i++) expect(ctx).toContain(`task-${i}`);
    expect(ctx).not.toContain("task-10");
  });
});

// ---------------------------------------------------------------------------
// ensureDaemonRunning — "already alive" branch ONLY (see file header)
// ---------------------------------------------------------------------------

describe("ensureDaemonRunning", () => {
  test("a lock pointing at a LIVE pid (this test process) is left untouched — no respawn attempted", () => {
    const home = mkHome();
    const ctx = ctxFor(home);
    const lockPath = notifyLockPath(ctx);
    const before = { pid: process.pid, started_at: "2020-01-01T00:00:00.000Z" };
    writeFileSync(lockPath, JSON.stringify(before, null, 2) + "\n");

    ensureDaemonRunning(ctx);

    const after = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// End-to-end subprocess — exactly how Claude Code invokes the hook
// ---------------------------------------------------------------------------

describe("subprocess", () => {
  function runHook(env: Record<string, string | undefined>, stdinPayload: object): { stdout: string; stderr: string; status: number | null } {
    const r = spawnSync(process.execPath, [HOOK_PATH], {
      input: JSON.stringify(stdinPayload),
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
  }

  test("disabled via the new env var → silent, exit 0", () => {
    const home = mkHome();
    const r = runHook(
      { PIPELINE_DEPARTMENT_NOTIFY_ENABLED: "0", PIPELINE_CLOUD_HOME: home },
      { session_id: "s1", cwd: home, hook_event_name: "SessionStart", source: "startup" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("disabled via the deprecated legacy env var → still honored, silent, exit 0", () => {
    const home = mkHome();
    const r = runHook(
      { PIPELINE_MESH_NOTIFY_ENABLED: "0", PIPELINE_CLOUD_HOME: home },
      { session_id: "s1b", cwd: home, hook_event_name: "SessionStart", source: "startup" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  test("no credential store yet ('pipeline cloud connect' never run) → silent, exit 0, no daemon spawn attempted", () => {
    const home = mkHome();
    const r = runHook(
      { PIPELINE_CLOUD_HOME: home },
      { session_id: "s2", cwd: home, hook_event_name: "SessionStart", source: "startup" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
    // Nothing was created at all — the gate short-circuited before any lock
    // or journal file could be touched.
    expect(existsSync(notifyLockPath(ctxFor(home)))).toBe(false);
  });

  test("credential present, journal has pending notifications → additionalContext JSON on stdout; journal drained", () => {
    const home = mkHome();
    const ctx = ctxFor(home);
    writeCredentialStore(realFs, credentialFilePath(ctx), {
      version: 1,
      servers: { "https://api.example.com": { access_token: "tok", token_type: "bearer" } },
    });
    // Seed the pending-notification journal directly (bypassing a real poll).
    writeFileSync(
      notifyJournalPath(ctx),
      JSON.stringify({ version: 1, seen: {}, pending: [sampleNotification()] }, null, 2) + "\n",
    );
    // Pre-seed a lock at THIS process's own pid so the hook's "already
    // running" branch fires — no real daemon is spawned by this subprocess.
    writeFileSync(notifyLockPath(ctx), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));

    const r = runHook(
      { PIPELINE_CLOUD_HOME: home },
      { session_id: "s3", cwd: home, hook_event_name: "SessionStart", source: "startup" },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("task-1");

    // Drained: a second invocation finds nothing pending and stays silent.
    const r2 = runHook(
      { PIPELINE_CLOUD_HOME: home },
      { session_id: "s4", cwd: home, hook_event_name: "SessionStart", source: "startup" },
    );
    expect(r2.status).toBe(0);
    expect(r2.stdout.trim()).toBe("");
  });
});
