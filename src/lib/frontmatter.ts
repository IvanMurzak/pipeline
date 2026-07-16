// Minimal, dependency-free YAML-frontmatter reader.
//
// The pipeline only puts a handful of simple keys in frontmatter
// (`model`, `execution`, `isolation`, `step_id`, `depends-on`), so a full YAML
// parser is overkill. This handles exactly what we author:
//   - `key: value`           → string
//   - `key: [a, b, c]`       → string[]  (inline flow list)
//   - `key:` + `  - a` lines → string[]  (block list)
// Quoted values are unwrapped. Comment lines and indented continuation lines
// that are not block-list items are ignored. Mirrors the tolerance of the
// stdlib parser in apps/pipeline-find/match.py.

export type FrontmatterValue = string | string[];

export interface ParsedFrontmatter {
  fields: Record<string, FrontmatterValue>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === "'" && s[s.length - 1] === "'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { fields: {}, body: text };

  const block = match[1];
  const body = text.slice(match[0].length);
  const fields: Record<string, FrontmatterValue> = {};
  const lines = block.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    // Only top-level (non-indented) keys; indented lines are handled as
    // block-list items by the key that owns them.
    if (/^\s/.test(line)) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();

    if (rawValue === '') {
      // Possible block list: collect following `  - item` lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(stripQuotes(lines[j].replace(/^\s*-\s+/, '').trim()));
        j++;
      }
      if (items.length) {
        fields[key] = items;
        i = j - 1;
      } else {
        fields[key] = '';
      }
      continue;
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1).trim();
      fields[key] =
        inner === ''
          ? []
          : inner
              .split(',')
              .map((s) => stripQuotes(s.trim()))
              .filter((s) => s.length > 0);
      continue;
    }

    fields[key] = stripQuotes(rawValue);
  }

  return { fields, body };
}
