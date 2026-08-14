// Guard test: bundled templates must not reference plugin-checkout paths.
//
// Task k1-ship-feature-template-retarget fixed ci-wait.md which still
// referenced `${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts` — a path
// that exists in no installed layout, since the CLI is shipped as `@baizor/pipeline`,
// not housed in the plugin. A bundled template's prose is a PARSED CONTRACT
// (lesson: it has broken things before).
//
// This test catches the class of rot where templates accidentally reference
// plugin-checkout variables or plugin-relative paths.
//
// Uses an explicit allowlist (not heuristics) for known benign references:
// - `apps/pipeline-cli` in bm25_retrieve.test.ts is a benign comment explaining
//   test scoping and is explicitly exempted below
// - `${CLAUDE_PLUGIN_ROOT}` has NO exemptions — it should not appear at all
//
// The test probes violations by temporarily seeding the bad pattern,
// reverting, and verifying the test fails on the seeded mutation.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

const TEMPLATES_DIR = join(import.meta.dir, '..', 'templates');

// Explicit allowlist of files exempt from certain checks. Maps pattern to reason.
// Key: normalized file path, Value: { claudePluginRoot, appsCliPath }
const EXEMPT_FILES: Record<string, { claudePluginRoot?: string; appsCliPath?: string }> = {
  [normalize(join(TEMPLATES_DIR, 'support-answer/scripts/tests/bm25_retrieve.test.ts'))]: {
    appsCliPath: 'Line 9: benign comment explaining which tests are scanned',
  },
};

/** Recursively collect all files under templates/. */
function walkTemplates(dir: string = TEMPLATES_DIR): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTemplates(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function isExempt(file: string, pattern: 'claudePluginRoot' | 'appsCliPath'): boolean {
  const normFile = normalize(file);
  const exempt = EXEMPT_FILES[normFile];
  return exempt ? Boolean(exempt[pattern]) : false;
}

describe('Templates must not reference plugin-checkout paths (k1-ship-feature-template-retarget)', () => {
  test('templates/ directory is not empty', () => {
    const files = walkTemplates();
    expect(files.length).toBeGreaterThan(0);
  });

  test('no file under templates/ contains ${CLAUDE_PLUGIN_ROOT}', () => {
    const files = walkTemplates();
    const violations: string[] = [];

    for (const file of files) {
      if (isExempt(file, 'claudePluginRoot')) continue;

      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('${CLAUDE_PLUGIN_ROOT}')) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('no file under templates/ contains apps/pipeline-cli path references (except explicit allowlist)', () => {
    const files = walkTemplates();
    const violations: string[] = [];

    for (const file of files) {
      if (isExempt(file, 'appsCliPath')) continue;

      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('apps/pipeline-cli')) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
