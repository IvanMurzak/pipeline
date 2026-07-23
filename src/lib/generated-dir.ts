/**
 * One place that creates a MACHINE-GENERATED directory tree and marks it
 * git-ignored, so the ignore rule ships with the artifact instead of relying
 * on every consumer project remembering to add one.
 *
 * Why a nested `.gitignore` and not documentation: a pipeline writes its
 * runtime state INTO the user's repository (`.claude/pipeline/.runtime/`,
 * `<pipeline>/.feedback/`, `.claude/pipeline/.stats/`). Without a rule, the
 * first `git add -A` after a run sweeps session ids, per-run journals and
 * rendered shadow copies into a commit. A self-contained stub at the ROOT of
 * each generated tree works out of the box in any repo, including one whose
 * .gitignore we have never seen.
 *
 * Two properties make this safe to apply broadly:
 *   - it writes `*` at the tree ROOT only, never one stub per nested folder —
 *     `*` already covers everything beneath;
 *   - it NEVER overwrites an existing `.gitignore`, and a `.gitignore` cannot
 *     untrack files git is ALREADY tracking. A team that deliberately commits
 *     one of these trees keeps its history and can express that intent by
 *     leaving its own stub in place.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The stub body: ignore this whole generated tree, and say why. */
const STUB = '# Machine-generated pipeline artifacts — not source.\n*\n';

/**
 * Create `dir` (recursively) and make sure the generated tree it belongs to
 * carries a `.gitignore`.
 *
 * `ignoreRoot` is where the stub goes — pass the tree's ROOT when `dir` is a
 * subfolder of it (e.g. `.runtime/<run>/sessions` belongs to the `.runtime`
 * tree). Defaults to `dir` itself.
 *
 * Best-effort by contract: a read-only checkout or a permission error must
 * never fail the caller's real work, so every filesystem error is swallowed.
 * The directory creation itself is NOT swallowed — callers depend on it.
 */
export function ensureGeneratedDir(dir: string, ignoreRoot: string = dir): void {
  mkdirSync(dir, { recursive: true });
  try {
    const stub = join(ignoreRoot, '.gitignore');
    if (!existsSync(stub)) writeFileSync(stub, STUB, 'utf8');
  } catch {
    // best-effort: never fail a run because the ignore stub could not be written
  }
}
