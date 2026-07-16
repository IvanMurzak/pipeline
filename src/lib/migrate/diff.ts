// A small, dependency-free unified-ish DIFF renderer for `pipeline migrate`
// (T1-18). Pure: takes the before/after files maps and returns a human-readable
// diff string. Used by the command to show WHAT a migration would change before
// it touches anything (`--dry-run` prints this and writes nothing).

import type { PipelineFiles } from './types';

/** LCS-based line diff of two line arrays → unified `+`/`-`/` ` op list. */
function lineDiff(a: string[], b: string[]): { op: ' ' | '-' | '+'; text: string }[] {
  const n = a.length;
  const m = b.length;
  // LCS length table (files are small; O(n*m) is fine).
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: { op: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: '-', text: a[i] });
      i++;
    } else {
      out.push({ op: '+', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

/** Render a single file's diff with a `--- / +++` header, or '' when unchanged. */
function renderFileDiff(path: string, before: string | undefined, after: string | undefined): string {
  if (before === after) return '';
  const header = [`--- a/${path}`, `+++ b/${path}`];
  if (before === undefined) return [...header, `@@ file added @@`, ...after!.split('\n').map((l) => `+${l}`)].join('\n');
  if (after === undefined) return [...header, `@@ file removed @@`, ...before.split('\n').map((l) => `-${l}`)].join('\n');
  const ops = lineDiff(before.split('\n'), after.split('\n'));
  return [...header, ...ops.map((o) => `${o.op}${o.text}`)].join('\n');
}

/**
 * Render a unified-ish diff between two pipeline files maps. Files are visited
 * in sorted path order; unchanged files are skipped. Returns '' when the two
 * maps are byte-identical.
 */
export function renderDiff(before: PipelineFiles, after: PipelineFiles): string {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const blocks: string[] = [];
  for (const p of paths) {
    const block = renderFileDiff(p, before[p], after[p]);
    if (block) blocks.push(block);
  }
  return blocks.join('\n');
}

/** Count changed / added / removed files between two maps (for summaries). */
export function diffStat(before: PipelineFiles, after: PipelineFiles): {
  changed: number;
  added: number;
  removed: number;
} {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const p of paths) {
    const b = before[p];
    const a = after[p];
    if (b === a) continue;
    if (b === undefined) added++;
    else if (a === undefined) removed++;
    else changed++;
  }
  return { changed, added, removed };
}
