// output-scrubber-sinks.test.ts — c2's STRUCTURAL half: "every sink reachable
// from `drive` is wrapped".
//
// `output-scrubber.test.ts` proves the behavioural half — that a registered
// value cannot survive `scrub`. That is necessary and not sufficient: a
// perfect scrubber protects nothing if one writer forgets to call it, and the
// writer that forgets will be a NEW one, added months from now by someone who
// never read c2's task spec. So this file ENUMERATES the sinks mechanically —
// it walks the module closure `src/commands/drive.ts` actually reaches, finds
// every stream write and every file write in it, and fails on any that does
// not route through the scrubber.
//
// It is a TRIPWIRE, exactly like `provider-key-ownership.test.ts`. The
// allowlist below is not a lint rule to be silenced: adding an entry is the
// deliberate act of declaring "this sink may write unredacted bytes", and it
// needs the same kind of stated reason the existing entries carry.
//
// ── THE ONE ENTRY THAT IS LOAD-BEARING IN THE OTHER DIRECTION ─────────────
//
// `src/lib/cloud-config.ts` is allowlisted, and it MUST STAY THAT WAY. It
// writes the per-user credential store — the file where a rung-4 provider key
// is SUPPOSED to land. Scrubbing that writer would replace the stored key with
// the redaction marker and silently destroy the user's credential, turning a
// security control into data loss. If a future change makes cloud-config route
// through `scrub`, this suite passing is not the good news it looks like.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const REPO = join(import.meta.dir, '..');
const ENTRY = join(REPO, 'src', 'commands', 'drive.ts');

// ---------------------------------------------------------------------------
// The closure — what `drive` can actually reach
// ---------------------------------------------------------------------------

/** Every `.ts` module reachable from `drive` through relative imports, keyed
 *  by repo-relative POSIX path. Deliberately follows `import type` too: a
 *  type-only edge costs nothing here and keeps the closure a superset of what
 *  executes, so the enumeration can only ever be too broad, never too narrow. */
function closure(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (abs: string): void => {
    const key = relative(REPO, abs).split(sep).join('/');
    if (out.has(key)) return;
    const text = readFileSync(abs, 'utf-8');
    out.set(key, text);
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const p = resolve(dirname(abs), m[1]);
      for (const cand of [p, `${p}.ts`, join(p, 'index.ts')]) {
        if (cand.endsWith('.ts') && existsSync(cand)) {
          walk(cand);
          break;
        }
      }
    }
  };
  walk(ENTRY);
  return out;
}

/** The balanced-paren text of the call whose `(` sits at `open`. */
function callText(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

interface SinkSite {
  file: string;
  line: number;
  /** The whole call, whitespace-collapsed. */
  call: string;
  scrubbed: boolean;
}

function sitesMatching(pattern: RegExp): SinkSite[] {
  const found: SinkSite[] = [];
  for (const [file, text] of closure()) {
    const re = new RegExp(pattern.source, 'g');
    for (const m of text.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const call = callText(text, open);
      found.push({
        file,
        line: text.slice(0, m.index).split('\n').length,
        call: call.replace(/\s+/g, ' '),
        scrubbed: call.includes('scrub('),
      });
    }
  }
  return found;
}

const STREAM_SINK = /(?:process\.(?:stdout|stderr)\.write|console\.(?:log|error|warn|info|debug|trace))\(/;
const FILE_SINK = /(?:appendFileSync|writeFileSync)\(/;

/** A short, line-number-free label so a failure names the offender usefully. */
const label = (s: SinkSite): string => `${s.file}: ${s.call.slice(0, 90)}`;

// ---------------------------------------------------------------------------
// The allowlist — sinks that write no run-derived text
// ---------------------------------------------------------------------------

interface Exemption {
  /** Repo-relative POSIX path. */
  file: string;
  /** A distinctive substring of the whitespace-collapsed call. Matched rather
   *  than a line number so an unrelated edit above cannot silently re-point an
   *  exemption at a different sink. */
  match: string;
  why: string;
}

const UNSCRUBBED_BY_DESIGN: Exemption[] = [
  {
    file: 'src/lib/cloud-config.ts',
    match: '(path: string, data: string, options?: { mode?: number })',
    why: 'the CloudFs INTERFACE DECLARATION — a type, not a call site',
  },
  {
    file: 'src/lib/cloud-config.ts',
    match: '(tmpPath, data, { mode })',
    why:
      'THE CREDENTIAL STORE. This is where a rung-4 provider key is SUPPOSED to be ' +
      'written. Scrubbing it would replace the stored key with the marker and destroy ' +
      "the user's credential. Never route this through scrub().",
  },
  {
    file: 'src/lib/cloud-config.ts',
    match: '(filePath, serialized)',
    why: 'the credential store again (non-atomic path) — same reason, same prohibition',
  },
  {
    file: 'src/commands/drive.ts',
    match: "(taskRefFile, JSON.stringify({ task_file: taskFile }), 'utf8')",
    why: 'a pointer to a path this process just composed; the task TEXT itself is scrubbed at its own writer',
  },
  {
    file: 'src/commands/drive.ts',
    match: "(usageFile, JSON.stringify(usageTotals), 'utf8')",
    why: 'token counts and a cost — numbers produced by our own fold, never free text',
  },
  {
    file: 'src/commands/drive.ts',
    match: "(cgi, '*\\n', 'utf8')",
    why: 'a fixed .gitignore stub — the literal `*`, with no run data in it',
  },
  {
    file: 'src/commands/next.ts',
    match: "(gi, '*\\n', 'utf8')",
    why: 'a fixed .gitignore stub — the literal `*`, with no run data in it',
  },
  {
    file: 'src/lib/generated-dir.ts',
    match: '(stub, STUB',
    why: 'the shared .gitignore stub constant — no run data',
  },
  {
    file: 'src/commands/telemetry-daemon.ts',
    match: 'lockPath',
    why: 'a daemon lock record: this process\'s own pid and an ISO timestamp',
  },
  {
    file: 'src/lib/compose-exec.ts',
    match: "'task-ref.json'",
    why: 'a pointer to a params/task file whose CONTENT is scrubbed at its own writer',
  },
];

function exemptionFor(site: SinkSite): Exemption | undefined {
  return UNSCRUBBED_BY_DESIGN.find((e) => e.file === site.file && site.call.includes(e.match));
}

// ---------------------------------------------------------------------------

describe('the sink enumeration is real', () => {
  test('the closure is actually walked and reaches the modules that write', () => {
    const files = [...closure().keys()];
    expect(files.length).toBeGreaterThan(30);
    for (const f of [
      'src/commands/drive.ts',
      'src/commands/next.ts',
      'src/lib/event.ts',
      'src/lib/stats.ts',
      'src/lib/script-step.ts',
      'src/lib/telemetry-outbox.ts',
      'src/lib/output-scrubber.ts',
    ]) {
      expect(files).toContain(f);
    }
  });

  test('the enumeration finds a non-trivial number of sinks (guard against a vacuous suite)', () => {
    expect(sitesMatching(STREAM_SINK).length).toBeGreaterThan(5);
    expect(sitesMatching(FILE_SINK).length).toBeGreaterThan(20);
  });

  test('every allowlist entry still matches a real sink — no stale exemptions', () => {
    const all = [...sitesMatching(STREAM_SINK), ...sitesMatching(FILE_SINK)];
    const unmatched = UNSCRUBBED_BY_DESIGN.filter(
      (e) => !all.some((s) => s.file === e.file && s.call.includes(e.match)),
    );
    expect(unmatched.map((e) => `${e.file}: ${e.match}`)).toEqual([]);
  });
});

describe('every sink reachable from drive is wrapped', () => {
  test('NO stream write in the closure passes unscrubbed text', () => {
    const unwrapped = sitesMatching(STREAM_SINK)
      .filter((s) => !s.scrubbed)
      .filter((s) => exemptionFor(s) === undefined);
    // A failure here names the offending call. Route it through `scrub(...)`,
    // or through a sink already wrapped by `scrubWriter` — do NOT add it to
    // UNSCRUBBED_BY_DESIGN unless it genuinely cannot carry run-derived text.
    expect(unwrapped.map(label)).toEqual([]);
  });

  test('NO file write in the closure persists unscrubbed text, except the declared exemptions', () => {
    const unwrapped = sitesMatching(FILE_SINK)
      .filter((s) => !s.scrubbed)
      .filter((s) => exemptionFor(s) === undefined);
    expect(unwrapped.map(label)).toEqual([]);
  });

  test('the exempted sinks are exactly the ones declared — nothing quietly joined them', () => {
    const exempted = [...sitesMatching(STREAM_SINK), ...sitesMatching(FILE_SINK)]
      .filter((s) => !s.scrubbed)
      .map((s) => s.file);
    expect([...new Set(exempted)].sort()).toEqual(
      [...new Set(UNSCRUBBED_BY_DESIGN.map((e) => e.file))].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// The wiring drive itself depends on
// ---------------------------------------------------------------------------

describe('drive wires the scrubber where it matters', () => {
  const drive = (): string => readFileSync(ENTRY, 'utf-8');

  test('both DriveDeps sinks are wrapped OUTSIDE the `??`, so an INJECTED sink is covered too', () => {
    const src = drive();
    // Wrapping only the default arm would leave every injected sink — tests,
    // commands/init.ts — writing raw bytes.
    expect(src).toContain('const out = scrubWriter(deps.out ??');
    expect(src).toContain('const err = scrubWriter(deps.err ??');
  });

  test("the child's stderr is relayed through the chunk-reassembling scrubber, not raw", () => {
    const src = drive();
    expect(src).toContain("child.stderr?.on('data', (d: unknown) => stderrRelay(String(d)));");
    // The raw relay this replaced must not come back.
    expect(src).not.toContain("child.stderr?.on('data', (d: unknown) => err(String(d)));");
  });

  test('the relay is flushed on EVERY terminal path — an unflushed carry is lost output', () => {
    const src = drive();
    // close, spawn-error, and the Windows shell retry that rebuilds it.
    expect([...src.matchAll(/stderrRelay\.flush\(\)/g)].length).toBe(3);
    // Rebuilt alongside the stream parser on the retry, so a half-read carry
    // cannot leak into the retry's output.
    expect(src).toContain('stderrRelay = scrubbedRelay(err);');
  });

  test('the improver and script-creator sessions share the same scrubbed err sink', () => {
    const src = drive();
    // All three spawn-templated sessions go through subprocessExecutor, which
    // takes `err` — the wrapped const — as its only output route.
    expect([...src.matchAll(/subprocessExecutor\(/g)].length).toBe(4); // 1 definition + 3 call sites
  });
});

describe('nothing in the closure can switch scrubbing off', () => {
  test('no module reads a scrub-disabling flag or environment variable', () => {
    const offenders: string[] = [];
    for (const [file, text] of closure()) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/\b(no|disable|skip)[-_]?scrub\b/i.test(code)) offenders.push(file);
      if (/\bscrub[-_]?(off|disabled?)\b/i.test(code)) offenders.push(file);
      if (/scrub\w*\s*(===|!==|==|!=)\s*(false|'0'|"0")/i.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test('no call site makes its scrub conditional', () => {
    // `cond ? scrub(x) : x` and `cond && scrub(x)` would each be an off switch
    // wearing a different hat.
    const offenders: string[] = [];
    for (const [file, text] of closure()) {
      if (/\?\s*scrub\(/.test(text)) offenders.push(`${file} (ternary)`);
      if (/&&\s*scrub\(/.test(text)) offenders.push(`${file} (guard)`);
    }
    expect(offenders).toEqual([]);
  });
});
