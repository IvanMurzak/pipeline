// `pipeline hash --root <pipeline_root> [--json] [--project <path> [--label <name>]]`
//
// Computes and outputs the pipeline content hash (D9) — a deterministic SHA-256
// over the pipeline's defining files (PIPELINE.md + steps/** + scripts/**).
//
// `--project <path>` (b15, 07-security.md T16/SG13) additionally computes the
// salted PROJECT FINGERPRINT for that path (`run-identity.ts`'s other half —
// see that file's module doc) and folds it into the `--json` output. THIS IS
// THE ONE REAL PRODUCTION CALL SITE for `computeRunIdentity`'s project-
// fingerprint half in this package today (`run.started` event emission is
// deliberately NOT wired — see `run-identity.ts`'s own module doc — it would
// drag in a lockstep event/records-contract bump that is out of scope here).
// The salt is resolved through the SAME precedence `run-identity.ts` documents
// (explicit → `PIPELINE_FINGERPRINT_SALT` env → per-install CSPRNG secret →
// public constant): this command reads the per-install secret via
// `fingerprint-salt.ts#loadOrCreateInstallSalt` (b14's at-rest-protected
// store) so a REAL `pipeline hash --project` invocation on a real machine
// fingerprints under that secret, not the dictionary-attackable public
// constant `DEFAULT_FINGERPRINT_SALT` documents about itself.
//
// Output format:
//   --json, no --project:  {"content_hash":"sha256:<hex>"}
//   --json, with --project: {"content_hash":"sha256:<hex>","project_fingerprint":"fp:<hex>"}
//   plain (no --project):  sha256:<hex>
//
// `--project` requires `--json` — there is no plain-text framing for a
// second value, so mixing them is a usage error rather than an invented
// ad hoc line format.
//
// Exit codes:
//   0: Success
//   2: Missing/invalid root, or other usage error

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { collectPipelineFiles, hashFileSet, PIPELINE_VERSION_PREFIX, computeRunIdentity } from '../lib/run-identity';
import { loadOrCreateInstallSalt } from '../lib/fingerprint-salt';
import { realFs, type CloudFs } from '../lib/cloud-config';

/** Real-environment deps, injectable so tests can point the per-install salt
 *  lookup at a scratch directory instead of this machine's actual
 *  `%APPDATA%\claude-pipeline` / `~/.config/claude-pipeline` — the SAME
 *  `{fs, platform, env, homedir}` shape `commands/cloud.ts`'s `realDeps` and
 *  every other command in this package already use for the same reason. */
export interface HashCommandDeps {
  fs: CloudFs;
  platform: string;
  env: Record<string, string | undefined>;
  homedir: string;
}

export const realHashDeps: HashCommandDeps = {
  fs: realFs,
  platform: process.platform,
  env: process.env,
  homedir: homedir(),
};

export function runHash(args: string[], deps: HashCommandDeps = realHashDeps): number {
  let root: string | undefined;
  let json = false;
  let project: string | undefined;
  let label: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') root = args[++i];
    else if (a.startsWith('--root=')) root = a.slice('--root='.length);
    else if (a === '--json') json = true;
    else if (a === '--project') project = args[++i];
    else if (a.startsWith('--project=')) project = a.slice('--project='.length);
    else if (a === '--label') label = args[++i];
    else if (a.startsWith('--label=')) label = a.slice('--label='.length);
    else {
      process.stderr.write(`pipeline hash: unknown flag '${a}'\n`);
      return 2;
    }
  }

  if (!root) {
    process.stderr.write('pipeline hash: --root is required\n');
    return 2;
  }
  if (label !== undefined && project === undefined) {
    process.stderr.write('pipeline hash: --label requires --project\n');
    return 2;
  }
  if (project !== undefined && !json) {
    process.stderr.write('pipeline hash: --project requires --json (no plain-text framing for two values)\n');
    return 2;
  }

  // Verify that the root is a valid directory
  try {
    const stat = statSync(root);
    if (!stat.isDirectory()) {
      process.stderr.write(`pipeline hash: --root must be a directory, got '${root}'\n`);
      return 2;
    }
  } catch (err) {
    process.stderr.write(`pipeline hash: --root does not exist or is not readable: '${root}'\n`);
    return 2;
  }

  try {
    const files = collectPipelineFiles(root);
    const contentHash = hashFileSet(root, files);
    const wireValue = PIPELINE_VERSION_PREFIX + contentHash;

    if (!json) {
      process.stdout.write(wireValue + '\n');
      return 0;
    }

    const result: { content_hash: string; project_fingerprint?: string } = { content_hash: wireValue };

    if (project !== undefined) {
      // b15 — resolve the per-install secret salt (never throws; undefined
      // falls back to the documented public constant, exactly per
      // `run-identity.ts#resolveSalt`'s precedence).
      const installSalt = loadOrCreateInstallSalt({
        fs: deps.fs,
        platform: deps.platform,
        env: deps.env,
        homedir: deps.homedir,
      });
      const identity = computeRunIdentity({
        pipelineRoot: root,
        projectPath: project,
        env: deps.env,
        installSalt,
        visibleLabel: label,
      });
      result.project_fingerprint = identity.project_fingerprint;
    }

    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pipeline hash: error computing hash: ${msg}\n`);
    return 2;
  }
}
