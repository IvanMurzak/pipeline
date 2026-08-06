/**
 * hook-bypass-id-determinism.test.ts — the DoD's cross-process trap
 * (ux-v2 b2): "A PreToolUse/PostToolUse pair for the same tool_use_id
 * still resolves to the same id."
 *
 *   bun test tests/hook-bypass-id-determinism.test.ts
 *
 * `bypassRunIdFromToolUseId` (hooks/analytics_relay.ts) exists BECAUSE
 * PreToolUse and PostToolUse are two separate hook invocations — real,
 * independent OS processes Claude Code spawns fresh each time, sharing NO
 * memory (the ":1028" rationale in analytics_relay.ts). A regression that
 * swaps the deterministic derivation for `newId()` (random per call) would
 * still pass a same-PROCESS determinism check (two calls in one `bun test`
 * run share the SAME module state) — hook-pretool-binding.test.ts's
 * "is deterministic for the same tool_use_id" test calls the function twice
 * in-process and would NOT catch that regression. This file spawns two
 * genuinely separate `bun` processes to close that gap.
 */

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOKS_FILE = resolve(import.meta.dir, "..", "..", "..", "hooks", "analytics_relay.ts");

/** Runs `bypassRunIdFromToolUseId(toolUseId)` in a FRESH bun process (not a
 *  fresh import in the current one) and returns the printed id, trimmed.
 *  Uses `process.execPath` — the actual running bun binary — rather than the
 *  string `'bun'`: with an npm shim install (bun.ps1/.cmd) on Windows,
 *  spawning the literal string 'bun' can defeat Bun's self-spawn special
 *  case (see tests/next.test.ts's `next()` helper for the same note). */
function mintInFreshProcess(dir: string, toolUseId: string): string {
  const driver = join(dir, `driver-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    driver,
    [
      `import { bypassRunIdFromToolUseId } from ${JSON.stringify(HOOKS_FILE)};`,
      `process.stdout.write(bypassRunIdFromToolUseId(${JSON.stringify(toolUseId)}));`,
      "",
    ].join("\n"),
  );
  const ran = spawnSync(process.execPath, [driver], { encoding: "utf-8", cwd: dir });
  if (ran.error) throw ran.error;
  if (ran.status !== 0) throw new Error(`bun exited ${ran.status}: ${ran.stderr}`);
  return ran.stdout.trim();
}

test(
  "bypassRunIdFromToolUseId: two SEPARATE processes derive the SAME id for the same tool_use_id",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-bypass-id-"));
    try {
      const toolUseId = "toolu_cross_process_check_001";
      const a = mintInFreshProcess(dir, toolUseId);
      const b = mintInFreshProcess(dir, toolUseId);
      expect(a).toBe(b);
      // Canonical UUID shape, version nibble 5 (RFC 9562 §5.5 UUIDv5) and
      // variant bits 0b10 — NOT the random RFC 9562 §5.7 UUIDv7 `newId()`
      // would produce.
      expect(a.length).toBe(36);
      const hex6 = Number.parseInt(a.slice(14, 16), 16); // byte 6: ver in high nibble
      expect(hex6 >>> 4).toBe(0b0101);
      const hex8 = Number.parseInt(a.slice(19, 21), 16); // byte 8: var in top 2 bits
      expect(hex8 >>> 6).toBe(0b10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  "bypassRunIdFromToolUseId: two SEPARATE processes derive DIFFERENT ids for different tool_use_ids",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-bypass-id-"));
    try {
      const a = mintInFreshProcess(dir, "toolu_cross_process_a");
      const b = mintInFreshProcess(dir, "toolu_cross_process_b");
      expect(a).not.toBe(b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

test(
  "bypassRunIdFromToolUseId: the null/empty fallback is genuinely random ACROSS processes too",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-bypass-id-"));
    try {
      const a = mintInFreshProcess(dir, "");
      const b = mintInFreshProcess(dir, "");
      expect(a).not.toBe(b);
      // newId() — RFC 9562 UUIDv7, version nibble 7.
      const hex6 = Number.parseInt(a.slice(14, 16), 16);
      expect(hex6 >>> 4).toBe(0b0111);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
