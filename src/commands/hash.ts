// `pipeline hash --root <pipeline_root> [--json]`
//
// Computes and outputs the pipeline content hash (D9) — a deterministic SHA-256
// over the pipeline's defining files (PIPELINE.md + steps/** + scripts/**).
//
// Output format:
//   --json: {"content_hash":"sha256:<hex>"}
//   plain:  sha256:<hex>
//
// Exit codes:
//   0: Success
//   2: Missing/invalid root or other usage error

import { existsSync } from 'node:fs';
import { statSync } from 'node:fs';
import { collectPipelineFiles, hashFileSet, PIPELINE_VERSION_PREFIX } from '../lib/run-identity';

export function runHash(args: string[]): number {
  let root: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') root = args[++i];
    else if (a.startsWith('--root=')) root = a.slice('--root='.length);
    else if (a === '--json') json = true;
    else {
      process.stderr.write(`pipeline hash: unknown flag '${a}'\n`);
      return 2;
    }
  }

  if (!root) {
    process.stderr.write('pipeline hash: --root is required\n');
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

    if (json) {
      const result = { content_hash: wireValue };
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      process.stdout.write(wireValue + '\n');
    }

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`pipeline hash: error computing hash: ${msg}\n`);
    return 2;
  }
}
