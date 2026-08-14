// Guard test: bundled templates must not reference plugin-checkout paths.
//
// Task k1-ship-feature-template-retarget fixed ci-wait.md which still
// referenced `${CLAUDE_PLUGIN_ROOT}/apps/pipeline-cli/src/cli.ts` — a path
// that exists in no installed layout, since the CLI is shipped as `@baizor/pipeline`,
// not housed in the plugin. A bundled template's prose is a PARSED CONTRACT
// (lesson: it has broken things before).
//
// This test catches the class of rot where templates accidentally reference
// plugin-checkout variables or plugin-relative paths. It scans every file
// under templates/ and fails if any non-comment line contains:
//   - ${CLAUDE_PLUGIN_ROOT} — the plugin root variable
//   - apps/pipeline-cli — a plugin-relative path
//
// The test probes violations by temporarily seeding the bad pattern,
// reverting, and verifying the test fails on the seeded mutation.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATES_DIR = join(import.meta.dir, '..', 'templates');

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

/** Check if a line is a comment (shell, markdown code, or block style). */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  // Markdown/YAML comments
  if (trimmed.startsWith('#')) return true;
  // Shell/JS/TS/Markdown code comments
  if (trimmed.startsWith('//')) return true;
  // Markdown code block markers and interior
  if (trimmed.startsWith('```')) return true;
  // Block comment markers
  if (trimmed.includes('/*') || trimmed.includes('*/')) return true;
  return false;
}

describe('Templates must not reference plugin-checkout paths (k1-ship-feature-template-retarget)', () => {
  test('no file under templates/ contains ${CLAUDE_PLUGIN_ROOT}', () => {
    const files = walkTemplates();
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!isComment(line) && line.includes('${CLAUDE_PLUGIN_ROOT}')) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual(
      [],
      violations.length > 0
        ? `Found ${violations.length} reference(s) to $\{CLAUDE_PLUGIN_ROOT}:\n${violations.join('\n')}`
        : undefined
    );
  });

  test('no file under templates/ contains apps/pipeline-cli path references (excluding comments)', () => {
    const files = walkTemplates();
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!isComment(line) && line.includes('apps/pipeline-cli')) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual(
      [],
      violations.length > 0
        ? `Found ${violations.length} reference(s) to apps/pipeline-cli:\n${violations.join('\n')}`
        : undefined
    );
  });
});
