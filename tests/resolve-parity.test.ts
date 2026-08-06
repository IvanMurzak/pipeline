/**
 * Parity test — every copy of resolveProjectRoot MUST return the same result
 * for the same input.
 *
 * Why copies exist at all: each hook is spawned by Claude Code as a standalone
 * bun script (see CLAUDE.md and the comment block in analytics_relay.ts), and
 * apps/pipeline-cli publishes standalone to npm — neither may import a sibling
 * .ts at runtime. So the same resolver is copied into
 * apps/pipeline-cli/src/lib/event.ts, hooks/session_relay.ts,
 * hooks/analytics_relay.ts and hooks/prompt_match_relay.ts.
 *
 * The CANONICAL copy is now the CLI's (`lib/event.ts`) — it is the one the
 * published package carries and the one every other copy is annotated as a
 * copy OF. It used to be `apps/pipeline-ui/lib.ts`, deleted with the local
 * dashboard (plugin-thin `p3`); nothing about the resolver was UI-specific,
 * only its address.
 *
 * Three of the four export their copy, so this test runs the REAL code. The
 * one that does not (analytics_relay.ts) is reimplemented verbatim below; the
 * last test in this file greps all four sources so a copy cannot be silently
 * forgotten.
 *
 *   bun test tests/resolve-parity.test.ts
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { resolveProjectRoot as cliCopy } from "../src/lib/event.ts";
import { resolveProjectRoot as promptMatchCopy } from "../../../hooks/prompt_match_relay.ts";
import { resolveProjectRoot as sessionCopy } from "../../../hooks/session_relay.ts";

// --- Reimplementation copied verbatim from the hook file that does not export
//     its copy (analytics_relay.ts). Update this when (and only when) that
//     file changes.

function submoduleWorktreeOfCopy(commonDir: string): string | null {
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
    /* unreadable config */
  }
  return null;
}

function resolveFromHookCopy(start: string): { project_root: string; worktree: string | null } {
  let cur = resolve(start);
  for (let i = 0; i < 64; i++) {
    const git = join(cur, ".git");
    try {
      const s = statSync(git);
      if (s.isDirectory()) return { project_root: cur, worktree: null };
      if (s.isFile()) {
        try {
          const content = readFileSync(git, "utf-8").trim();
          if (content.startsWith("gitdir:")) {
            const gitdir = resolve(cur, content.slice(7).trim());
            const commondirFile = join(gitdir, "commondir");
            try {
              const commondir = readFileSync(commondirFile, "utf-8").trim();
              const common = resolve(gitdir, commondir);
              if (common.endsWith(".git")) return { project_root: dirname(common), worktree: cur };
              const checkout = submoduleWorktreeOfCopy(common);
              if (checkout) return { project_root: checkout, worktree: cur };
              return { project_root: cur, worktree: null };
            } catch {
              /* no commondir */
            }
          }
        } catch {
          /* unreadable */
        }
      }
    } catch {
      /* no .git here */
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { project_root: resolve(start), worktree: null };
}

/** Every implementation, run over the same input. */
function allCopies(cwd: string): Array<{ project_root: string; worktree: string | null }> {
  return [cliCopy(cwd), promptMatchCopy(cwd), sessionCopy(cwd), resolveFromHookCopy(cwd)];
}

// --- Fixtures

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pipe-resolve-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveProjectRoot parity (all copies must agree)", () => {
  test("plain repo: .git is a directory", () => {
    const proj = join(root, "plain");
    mkdirSync(join(proj, ".git", "objects"), { recursive: true });
    mkdirSync(join(proj, "src"), { recursive: true });

    const cwd = join(proj, "src");
    const expected = { project_root: resolve(proj), worktree: null };
    for (const got of allCopies(cwd)) expect(got).toEqual(expected);
  });

  test("worktree: .git is a file with gitdir + commondir", () => {
    const main = join(root, "main");
    mkdirSync(join(main, ".git"), { recursive: true });
    writeFileSync(join(main, ".git", "HEAD"), "ref: refs/heads/main");

    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });
    const gitdir = join(main, ".git", "worktrees", "wt");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..");
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}`);

    const expected = { project_root: resolve(main), worktree: resolve(wt) };
    for (const got of allCopies(wt)) expect(got).toEqual(expected);
  });

  // Regression: a worktree of a SUBMODULE resolves its commondir to
  // <repo>/.git/modules/<name>, which is not a working tree. Every copy used to
  // return that path, so each worktree of a submodule registered as its own
  // project — under a path inside .git — instead of folding into the submodule
  // it belongs to. Seen live: two such projects in a 174-entry registry.
  test("submodule worktree: folds into the submodule's own checkout", () => {
    const parent = join(root, "parent");
    const checkout = join(parent, "public", "sub");
    const moduleDir = join(parent, ".git", "modules", "public", "sub");
    mkdirSync(checkout, { recursive: true });
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(
      join(moduleDir, "config"),
      [
        "[core]",
        "\trepositoryformatversion = 0",
        "\tworktree = ../../../../public/sub",
        '[remote "origin"]',
        "\turl = https://example.invalid/sub",
      ].join("\n"),
    );

    const wt = join(root, "sub-worktree");
    mkdirSync(wt, { recursive: true });
    const gitdir = join(moduleDir, "worktrees", "sub-worktree");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..");
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}`);

    const expected = { project_root: resolve(checkout), worktree: resolve(wt) };
    for (const got of allCopies(wt)) expect(got).toEqual(expected);
  });

  test("submodule worktree with no core.worktree: stands alone, never a path inside .git", () => {
    const parent = join(root, "parent2");
    const moduleDir = join(parent, ".git", "modules", "orphan");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, "config"), "[core]\n\tbare = false\n");

    const wt = join(root, "orphan-worktree");
    mkdirSync(wt, { recursive: true });
    const gitdir = join(moduleDir, "worktrees", "orphan-worktree");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..");
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}`);

    for (const got of allCopies(wt)) {
      expect(got).toEqual({ project_root: resolve(wt), worktree: null });
      expect(got.project_root).not.toContain(`.git${sep}modules`);
    }
  });

  test("no .git anywhere: returns the start path", () => {
    const proj = join(root, "no-git");
    mkdirSync(proj, { recursive: true });

    const expected = { project_root: resolve(proj), worktree: null };
    for (const got of allCopies(proj)) expect(got).toEqual(expected);
  });
});

describe("no copy is left behind", () => {
  const pluginRoot = resolve(import.meta.dir, "..", "..", "..");
  const copies = [
    "apps/pipeline-cli/src/lib/event.ts",
    "hooks/session_relay.ts",
    "hooks/analytics_relay.ts",
    "hooks/prompt_match_relay.ts",
  ];

  test("every source carrying a resolver also carries the submodule branch", () => {
    for (const rel of copies) {
      const src = readFileSync(join(pluginRoot, rel), "utf-8");
      expect(src).toContain("function submoduleWorktreeOf");
      expect(src).toContain("Submodule worktree: common is");
    }
  });
});
