/**
 * `pipeline hook session-relay` — the SessionStart journal relay.
 *
 * WHERE THIS RUNS. A CLI SUBCOMMAND, invoked by `pipeline-claude`'s
 * `hooks/hooks.json` through `hooks/run-hook.sh` (plugin-thin `p6`).
 *
 * Fires whenever Claude Code starts a session anywhere inside a project that
 * has a `.pipeline/` directory, and does exactly ONE thing: append a
 * `session.opened` event to that project's `.pipeline/.runtime/events.jsonl`.
 *
 * ## Why this file exists at all
 *
 * This is what is LEFT of `hooks/pipeline_ui_relay.ts` after the local
 * dashboard was deleted (plugin-thin `01-remove-local-ui.md`, task `p3`). That
 * hook did four things: spawn the daemon, reconcile the daemon's plugin
 * version, register the project with the daemon, and write `session.opened`.
 * The first three died with the daemon. The fourth is a JOURNAL WRITE, and the
 * journal is not the UI's — it is `ux-v2`'s telemetry source, so its writers
 * stay.
 *
 * `session.opened` has live consumers on the surviving side of that deletion:
 *
 *   - `pipeline logs` renders it (`commands/logs.ts`), and for a user who has
 *     declined the cloud entirely that terminal tail is now the ONLY view of
 *     the journal there is.
 *   - `ux-v2` `b20` made it the worked example of an EXPECTED EXCLUSION in the
 *     telemetry outbox — a run_id-less line that must never be counted or
 *     reported as data loss (`lib/telemetry-outbox.ts`'s
 *     `EXPECTED_RUNLESS_TYPES`). It is deliberately never uploaded.
 *
 * So this stays local, stays cheap, and stays daemon-free: no spawn, no
 * network, no lockfile, no `~/.claude` bookkeeping of any kind.
 *
 * Never blocks Claude Code — always exits 0. All errors are silent unless
 * PIPELINE_JOURNAL_DEBUG=1.
 */

import { existsSync, mkdirSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

const DEBUG = process.env.PIPELINE_JOURNAL_DEBUG === "1";
const log = (msg: string) => DEBUG && console.error(`[session-relay] ${msg}`);

/** Master enable switch. The journal/analytics system is ON BY DEFAULT — this
 *  hook runs UNLESS the user has explicitly opted OUT by setting
 *  PIPELINE_JOURNAL_ENABLED to a falsy value (0/false/no/off); unset/empty (and any
 *  other value) leaves it enabled. When opted out it writes nothing. (The Bun
 *  process still launches because the registration lives in hooks.json, but it
 *  exits immediately. To remove the spawn entirely, disable the plugin.)
 *  Mirrors src/hooks/analytics-relay.ts. */
function journalEnabled(): boolean {
  const v = (process.env.PIPELINE_JOURNAL_ENABLED ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** The main working tree recorded in a submodule's module directory.
 *
 *  A worktree of a SUBMODULE resolves its commondir to `<repo>/.git/modules/
 *  <name>`, which is not a working tree at all — git records the submodule's
 *  checkout there as `core.worktree`. Without this, every worktree of a
 *  submodule resolves to a project root inside `.git`.
 *
 *  COPY of src/lib/event.ts:submoduleWorktreeOf — hooks
 *  cannot import from a sibling .ts at runtime.
 *  <superrepo>/tests/cross-repo/resolve-parity.test.ts fails on drift. */
function submoduleWorktreeOf(commonDir: string): string | null {
  try {
    const config = readFileSync(join(commonDir, "config"), "utf-8");
    let inCore = false;
    for (const rawLine of config.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("[")) {
        inCore = line.toLowerCase().startsWith("[core");
        continue;
      }
      if (!inCore) continue;
      const m = /^worktree\s*=\s*(.+)$/i.exec(line);
      if (m?.[1]) return resolve(commonDir, m[1].trim());
    }
  } catch {
    /* unreadable config → not a submodule module dir we can resolve */
  }
  return null;
}

function resolveProjectRoot(start: string): { project_root: string; worktree: string | null } {
  let cur = resolve(start);
  for (let i = 0; i < 64; i++) {
    const git = join(cur, ".git");
    if (existsSync(git)) {
      const s = statSync(git);
      if (s.isDirectory()) return { project_root: cur, worktree: null };
      if (s.isFile()) {
        try {
          const content = readFileSync(git, "utf-8").trim();
          if (content.startsWith("gitdir:")) {
            const gitdir = resolve(cur, content.slice(7).trim());
            const commondirFile = join(gitdir, "commondir");
            if (existsSync(commondirFile)) {
              const commondir = readFileSync(commondirFile, "utf-8").trim();
              const common = resolve(gitdir, commondir);
              if (common.endsWith(".git")) return { project_root: dirname(common), worktree: cur };
              // Submodule worktree: common is `<repo>/.git/modules/<name>`.
              const checkout = submoduleWorktreeOf(common);
              if (checkout) return { project_root: checkout, worktree: cur };
              // Unknown parent — treat this worktree as its own project rather
              // than reporting a path inside `.git`.
              return { project_root: cur, worktree: null };
            }
          }
        } catch (e) {
          log(`failed to read .git file: ${e}`);
        }
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { project_root: resolve(start), worktree: null };
}

/** True when a `.pipeline` directory exists at `start` or any ancestor up to
 *  and including `stopAt` (the resolved project root). Mirrors the same helper
 *  in src/hooks/analytics-relay.ts — keep them in sync. Depth- and
 *  worktree-independent so a session started anywhere inside a pipeline
 *  project (root, deep in `.pipeline/…`, or a worktree under
 *  `.claude/worktrees/<name>/`) still emits session.opened. Bounded at the git
 *  root so a stray `.pipeline` far up the tree can't classify unrelated
 *  projects. */
function hasPipelineDirUpTo(start: string, stopAt: string): boolean {
  let cur = resolve(start);
  const stop = resolve(stopAt);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, ".pipeline"))) return true;
    if (cur === stop) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

function appendSessionOpened(projectRoot: string, worktree: string | null): void {
  const runtime = join(projectRoot, ".pipeline", ".runtime");
  try {
    mkdirSync(runtime, { recursive: true });
  } catch (e) {
    log(`runtime mkdir failed: ${e}`);
    return;
  }
  const journal = join(runtime, "events.jsonl");
  const evt = {
    // Keep in sync with src/lib/event.ts (v2).
    schema: 2,
    ts: new Date().toISOString(),
    type: "session.opened",
    project_root: projectRoot,
    worktree,
    run_id: null,
    parent_run_id: null,
    session_id: process.env.CLAUDE_SESSION_ID ?? null,
    data: { claude_pid: process.pid },
  };
  try {
    appendFileSync(journal, JSON.stringify(evt) + "\n", "utf-8");
  } catch (e) {
    log(`journal append failed: ${e}`);
  }
}

async function main(): Promise<void> {
  if (!journalEnabled()) {
    log("PIPELINE_JOURNAL_ENABLED explicitly opted out (0/false/no/off) — not writing session.opened");
    return;
  }
  // Read (and discard) the hook payload from stdin — Claude Code's hook
  // protocol writes one; CWD is the only signal this hook needs.
  try {
    process.stdin.resume();
    process.stdin.on("data", () => {});
    setTimeout(() => process.stdin.pause(), 50);
  } catch {}

  const cwd = process.cwd();

  // Resolve the project root first (maps a git worktree to its MAIN repo and
  // records the worktree tag), then gate by walking up from cwd for ANY
  // `.pipeline` ancestor. A session may be started or resumed at the root,
  // deep inside `.pipeline/<name>/…`, or inside a worktree under
  // `.claude/worktrees/<name>/`; the walk-up makes session.opened depth- and
  // worktree-independent. Gating on a single `cwd/.pipeline` (or
  // `project_root/.pipeline`) would skip those nested cases.
  const { project_root, worktree } = resolveProjectRoot(cwd);

  if (!hasPipelineDirUpTo(cwd, project_root)) {
    log(`no .pipeline from ${cwd} up to project root ${project_root}, skipping`);
    return;
  }

  appendSessionOpened(project_root, worktree);
}

export { journalEnabled, resolveProjectRoot, hasPipelineDirUpTo, appendSessionOpened };

/**
 * `pipeline hook session-relay` — the subcommand entry point.
 *
 * ALWAYS RESOLVES 0: this relay must never block a session from starting.
 */
export async function runSessionRelay(): Promise<number> {
  try {
    await main();
  } catch (e) {
    log(`top-level: ${e}`);
  }
  return 0;
}
