// `pipeline hook <name>` — the Claude Code hook relays, as CLI subcommands.
//
// WHY THIS COMMAND EXISTS (plugin-thin `p6`). The five relays used to be
// standalone `.ts` scripts inside `pipeline-claude/hooks/`, spawned as
// `bun <relay>.ts` and reaching sideways into the CLI copy the plugin
// shipped (`hooks/stats_relay.ts` imported `apps/pipeline-cli/src/lib/stats`
// and `lib/stats-backfill`). Two things were wrong with that:
//
//   1. A user with a globally installed `@baizor/pipeline` had TWO copies of
//      the same code at potentially different versions, and the hooks always
//      ran the plugin's. Nothing detected the divergence.
//   2. The relays broke the moment `apps/pipeline-cli` was deleted — which is
//      the whole point of the plugin-thin work.
//
// Moving them here makes the hook's version the CLI's version BY
// CONSTRUCTION. There is one copy, it is the installed one, and the plugin
// ships instructions rather than code.
//
// HOW THE PLUGIN REACHES IT. `hooks/hooks.json` invokes
// `"$CLAUDE_PLUGIN_ROOT/hooks/run-hook.sh" hook <name>`. That shim (which
// SURVIVES, and must: see its own header) resolves an absolute `pipeline`
// binary — Claude Code runs hooks through a non-interactive `/bin/sh` that
// never sources `~/.zshrc`, so a Dock- or Start-menu-launched session cannot
// see `~/.bun/bin` — and `exec`s straight into it, so stdin, stdout and the
// exit code pass through untouched. Claude Code feeds hook JSON on stdin and
// reads the relay's own stdout; nothing in this path may buffer or rewrite
// either.
//
// EXIT CODES. Every relay resolves 0, always, by contract — a non-zero exit
// from PreToolUse blocks the tool call and from UserPromptSubmit blocks the
// prompt, and no failure inside a best-effort journal writer justifies that.
// The only non-zero this command produces is 2 for a name it does not know,
// which is a malformed `hooks.json` rather than a runtime condition. The
// parent monorepo's `tests/cross-repo/hook-subcommand-parity.test.ts` asserts
// that every name the plugin's `hooks.json` invokes is one of the names
// below, so that 2 cannot be reached by a shipped plugin.
//
// LAZY IMPORTS, one per relay, deliberately. `analytics-relay` fires on
// nearly every tool call; it must not pay module-load cost for the BM25
// matcher (`prompt-match-relay`) or the credential store
// (`department-notifier-relay`). Each `import()` below pulls in exactly one
// relay's graph.

/** Every hook relay this CLI implements, in `hooks.json` registration order.
 *  Exported so tests (here and in the parent's cross-repo suite) can assert
 *  the set rather than restate it. */
export const HOOK_NAMES = [
  'analytics-relay',
  'stats-relay',
  'session-relay',
  'department-notifier-relay',
  'prompt-match-relay',
] as const;

export type HookName = (typeof HOOK_NAMES)[number];

/** `analytics_relay` → `analytics-relay`. The relays were named with
 *  underscores while they were files; the subcommands are kebab-case like
 *  every other `pipeline` verb. Accepting both costs one `replace` and means
 *  a hand-typed `pipeline hook stats_relay` does the obvious thing instead of
 *  printing usage. */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, '-');
}

export function hookUsage(): string {
  return (
    'pipeline hook <name>\n' +
    '\n' +
    "  Run one Claude Code hook relay. Reads the hook's JSON payload on stdin\n" +
    '  and writes any hook output (additionalContext, …) on stdout. Always\n' +
    '  exits 0 — a relay must never block the session it observes.\n' +
    '\n' +
    '  Not meant to be run by hand. The Pipeline plugin registers these in\n' +
    "  hooks/hooks.json and invokes them through hooks/run-hook.sh, which\n" +
    '  resolves this binary for a non-interactive shell.\n' +
    '\n' +
    '  Names:\n' +
    HOOK_NAMES.map((n) => `    ${n}\n`).join('') +
    '\n' +
    '  Exit 0 always · 2 unknown or missing name.\n'
  );
}

export async function runHook(argv: string[]): Promise<number> {
  const raw = argv[0];
  if (raw === undefined || raw === '--help' || raw === '-h') {
    // No name at all is a usage error, not a silent no-op: a hooks.json entry
    // that lost its argument should be loud in a terminal. `--help` prints the
    // same text on stdout and succeeds.
    const help = raw !== undefined;
    (help ? process.stdout : process.stderr).write(hookUsage());
    return help ? 0 : 2;
  }

  switch (normalize(raw)) {
    case 'analytics-relay': {
      const { runAnalyticsRelay } = await import('../hooks/analytics-relay');
      return runAnalyticsRelay();
    }
    case 'stats-relay': {
      const { runStatsRelay } = await import('../hooks/stats-relay');
      return runStatsRelay();
    }
    case 'session-relay': {
      const { runSessionRelay } = await import('../hooks/session-relay');
      return runSessionRelay();
    }
    case 'department-notifier-relay': {
      const { runDepartmentNotifierRelay } = await import('../hooks/department-notifier-relay');
      return runDepartmentNotifierRelay();
    }
    case 'prompt-match-relay': {
      const { runPromptMatchRelay } = await import('../hooks/prompt-match-relay');
      return runPromptMatchRelay();
    }
    default:
      process.stderr.write(`pipeline hook: unknown hook '${raw}'\n\n` + hookUsage());
      return 2;
  }
}
