// Dotenv-style KEY=VALUE parsing — the ONE grammar shared by the worktree
// env-file reader (lib/script-step.ts, historical home of this helper) and the
// strict `--vars-file` loader (lib/run-vars.ts). Relocated to its own lib
// neighbor per the env-variables design (05 §3 / 08 risk table) so command
// modules can compose it without importing the whole script-step machinery,
// and so exactly one dotenv grammar exists (two grammars would drift).

/** Parse a dotenv-style env file: KEY=VALUE lines, `#` comments ignored,
 *  optional `export ` prefix and surrounding quotes tolerated — NEVER
 *  shell-sourced (script-steps §4).
 *
 *  `onSkipped` (optional) fires for every non-blank, non-comment line the
 *  parser DISCARDS (no `=`, or an empty key) with its 1-based line number.
 *  The worktree env-file reader passes nothing (historical tolerant behavior,
 *  byte-identical); the `--vars-file` loader turns skips into startup errors.
 *  Deliberately NO line text in the callback: a malformed line in a
 *  mistakenly-pointed-at secrets file could BE a secret — callers report the
 *  line number only, never the content. */
export function parseEnvFile(
  text: string,
  onSkipped?: (lineNo: number) => void,
): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) {
      onSkipped?.(i + 1);
      continue;
    }
    // `key` is always non-empty here: `line` is trimmed, so its first char is
    // non-whitespace and eq > 0 puts it inside the slice (the only empty-key
    // shape, `=value`, has eq === 0 and took the guard above).
    const key = line.slice(0, eq).trim();
    // '__proto__' cannot round-trip through a plain Record (assignment hits
    // the prototype setter and creates NO own key), so the entry would be
    // SILENTLY ignored — the exact invisible misconfiguration the strict
    // --vars-file loader forbids (T11; parseVarAssignment rejects the same
    // name on --var). Report it as a skipped line. The tolerant worktree
    // reader (no callback) keeps its historical behavior: the line was
    // already a no-op before this guard existed.
    if (key === '__proto__') {
      onSkipped?.(i + 1);
      continue;
    }
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}
