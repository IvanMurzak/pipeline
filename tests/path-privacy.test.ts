// SG4 — no absolute machine path, and no OS account name, reaches a payload
// (ux-v2 `b22`; `07-security.md` §4.1 and gate SG4).
//
// WHAT THIS PROVES, AND WHY IT IS NOT A SPOT CHECK.
//
// SG4 was violated in production from 2026-07-19 until this fix, and the reason
// it survived is that it is INCONSISTENT: the same step's `iteration.started`
// carried a relative `01-prepare.md` while its `iteration.completed`, seconds
// later, carried `C:\Users\<account>\…\steps\01-prepare.md`. A spot check finds
// the first one and concludes the filter works.
//
// The rule is stated in full in `src/lib/path-privacy.ts`'s header. In one
// line: the vendored allowlist disposes of a path by the NAME of its field, so
// the `keep`-classified step-identity fields ship whatever the emitter hands
// them — and `PlanStep.path` is absolute by construction. Nothing relativizes
// anything; the "good" production value was the raw `--start 01-prepare.md`
// argv token, not a filtered one.
//
// So this suite tests the RULE, not the two fields i1 happened to observe:
//
//   §1  the rule in isolation — every `keep`-classified path field, an absolute
//       path planted in a field that did not exist when the fix was written,
//       and the three absolute-path shapes (drive, UNC, POSIX);
//   §2  THE PRODUCTION REPRODUCTION — the exact wire envelopes from
//       `scripts/i1-production-e2e/evidence/wire-payloads.jsonl`, driven
//       through the REAL outbox and the REAL uploader, checked with the SAME
//       regex `check-sg4.mjs` used against production;
//   §3  the OS account name of the machine running this test — planted live
//       from `os.userInfo()`, so the assertion is about a real identity rather
//       than a fixture string;
//   §4  the metadata that must SURVIVE, so the fix cannot pass by shipping
//       nothing.

import { describe, expect, test } from 'bun:test';
import { userInfo } from 'node:os';
import {
  SG4_PATH_RE,
  collectPathRoots,
  defaultAccountNames,
  looksAbsolutePath,
  scrubPathString,
  scrubPayloadPaths,
} from '../src/lib/path-privacy';
import { filterEventForTier } from '../src/lib/vendor/privacy';

const SALT = 'test-salt-b22';

/** Every string leaf of a payload, with its dotted location — the same walk
 *  `check-sg4.mjs:scanStrings` performs against the production rows. */
export function stringLeaves(node: unknown, at = 'payload'): Array<[string, string]> {
  if (typeof node === 'string') return [[at, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => stringLeaves(v, `${at}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => stringLeaves(v, `${at}.${k}`));
  }
  return [];
}

/** The SG4 verdict on a payload, as a list of `location -> value` findings.
 *  Returned rather than asserted so a failure NAMES the field and the value. */
export function sg4Findings(payload: unknown): string[] {
  return stringLeaves(payload)
    .filter(([, v]) => SG4_PATH_RE.test(v))
    .map(([at, v]) => `${at} -> ${JSON.stringify(v.slice(0, 140))}`);
}

// ---------------------------------------------------------------------------
// §1 — the rule, in isolation
// ---------------------------------------------------------------------------

/** The user's home, in each of the three shapes, with a recognisable account
 *  name. Fixture values (not this machine's) so §1 is deterministic; §3 uses
 *  the real one. */
const WIN_ROOT = 'C:\\Users\\IvanD\\AppData\\Local\\Temp\\claude\\proj-i1-e2e';
const POSIX_ROOT = '/home/ivand/work/proj-i1-e2e';
const UNC_ROOT = '\\\\fileserver\\team\\ivand\\proj-i1-e2e';

describe('b22 §1 — the RULE: an absolute path never survives, whatever field carries it', () => {
  test('every `keep`-classified path field in the allowlist is scrubbed, not just the two i1 saw', () => {
    // The full set of fields `vendor/privacy.ts` maps to `keep` and whose value
    // is a path. Enumerated from DATA_ALLOWLISTS, not from the defect report:
    // fixing only `iteration_path`/`next_iteration_path` would leave the rest.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['iteration.started', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`, index: 1 }],
      [
        'iteration.completed',
        {
          iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
          next_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\02.md`,
          outcome: 'completed',
        },
      ],
      ['iteration.resumed', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['pipeline.started', { first_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['run.started', { first_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['pipeline.halted', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['run.halted', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['improver.started', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['improver.completed', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['script_creator.started', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      [
        'script_creator.completed',
        {
          iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
          script_path: `${WIN_ROOT}\\.pipeline\\p\\scripts\\build.ts`,
        },
      ],
      ['blocker.delegated', { parent_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
    ];

    const report: string[] = [];
    for (const [type, data] of cases) {
      const envelope = {
        schema: 5,
        ts: '2026-08-07T10:58:39.207Z',
        type,
        project_root: WIN_ROOT,
        worktree: null,
        run_id: 'r1',
        parent_run_id: null,
        session_id: null,
        data,
      };
      const filtered = filterEventForTier(envelope, 'metadata', { fingerprintSalt: SALT });
      const scrubbed = scrubPayloadPaths(filtered, {
        roots: collectPathRoots(envelope),
        fingerprintSalt: SALT,
      });
      const findings = sg4Findings(scrubbed);
      report.push(`  ${findings.length ? 'LEAK  ' : 'clean '} ${type}`);
      expect(`${type}: ${findings.join(' | ') || 'clean'}`).toBe(`${type}: clean`);

      // …and not by deleting the field: it still names the step, relative to
      // the run's own root.
      const out = (scrubbed as Record<string, unknown>).data as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        if (!key.endsWith('_path')) continue;
        expect(`${type}.${key} = ${String(out[key])}`).toBe(
          `${type}.${key} = ${key === 'script_path' ? '.pipeline/p/scripts/build.ts' : `.pipeline/p/steps/${key === 'next_iteration_path' ? '02' : '01'}.md`}`,
        );
      }
    }
    console.log(`\n[b22 §1 keep-field sweep]\n${report.join('\n')}\n`);
  });

  test('a path in a field NOBODY allowlisted as a path is still scrubbed — the shape is the rule', () => {
    // `halt_reason` is a `summary` field: free text, truncated but KEPT. It is
    // exactly where a stack frame or a command line drags a path onto the wire,
    // and no field-name rule would ever catch it.
    const envelope = {
      schema: 5,
      ts: '2026-08-07T10:58:39.207Z',
      type: 'iteration.completed',
      project_root: WIN_ROOT,
      worktree: null,
      run_id: 'r1',
      parent_run_id: null,
      session_id: null,
      data: {
        outcome: 'halted',
        halt_reason: `build failed: cannot open ${WIN_ROOT}\\.pipeline\\p\\steps\\01.md (ENOENT)`,
      },
    };
    const scrubbed = scrubPayloadPaths(
      filterEventForTier(envelope, 'metadata', { fingerprintSalt: SALT }),
      { roots: collectPathRoots(envelope), fingerprintSalt: SALT },
    );
    expect(sg4Findings(scrubbed)).toEqual([]);
    const reason = ((scrubbed as Record<string, unknown>).data as Record<string, unknown>).halt_reason;
    // The prose survives; only the path inside it is rewritten.
    expect(reason).toBe('build failed: cannot open .pipeline/p/steps/01.md (ENOENT)');
  });

  test('all three absolute-path shapes are recognised, and a relative value is untouched', () => {
    expect(looksAbsolutePath(`${WIN_ROOT}\\x.md`)).toBe(true);
    expect(looksAbsolutePath(`${POSIX_ROOT}/x.md`)).toBe(true);
    expect(looksAbsolutePath(`${UNC_ROOT}\\x.md`)).toBe(true);
    expect(looksAbsolutePath('steps/01-prepare.md')).toBe(false);
    expect(looksAbsolutePath('01-prepare.md')).toBe(false);
    // A URL is not a path — `blocker_issue_url` is a `keep` field and must not
    // be mangled. (`https://` contains `s:/`, which is why the arbiter's
    // leading-guard is load-bearing.)
    expect(looksAbsolutePath('https://github.com/IvanMurzak/pipeline/issues/1')).toBe(false);
    expect(scrubPathString('https://github.com/IvanMurzak/pipeline/issues/1', { fingerprintSalt: SALT })).toBe(
      'https://github.com/IvanMurzak/pipeline/issues/1',
    );
    expect(scrubPathString('steps/01-prepare.md', { fingerprintSalt: SALT })).toBe('steps/01-prepare.md');

    for (const root of [WIN_ROOT, POSIX_ROOT, UNC_ROOT]) {
      const sep = root.includes('/') ? '/' : '\\';
      const abs = `${root}${sep}.pipeline${sep}p${sep}steps${sep}01.md`;
      expect(scrubPathString(abs, { roots: [root], fingerprintSalt: SALT })).toBe('.pipeline/p/steps/01.md');
    }
  });

  test('a path under NO known root FAILS CLOSED to a fingerprint — never passes through raw', () => {
    const orphan = 'C:\\Users\\IvanD\\Documents\\other-client\\secret.md';
    const out = scrubPathString(orphan, { roots: [POSIX_ROOT], fingerprintSalt: SALT });
    expect(out).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(SG4_PATH_RE.test(out)).toBe(false);
    // Deterministic, so telemetry still correlates on it.
    expect(scrubPathString(orphan, { roots: [], fingerprintSalt: SALT })).toBe(out);
  });

  test('a relativized remainder that would STILL carry the account name is refused', () => {
    // Root is the home directory itself, so the remainder would be
    // `IvanD/proj/steps/01.md` — root-free, but still naming the account.
    const out = scrubPathString('C:\\Users\\IvanD\\proj\\steps\\01.md', {
      roots: ['C:\\Users'],
      accountNames: ['ivand'],
      fingerprintSalt: SALT,
    });
    expect(out).toMatch(/^fp:[0-9a-f]{16}$/);
  });

  test('the `b18` salt reaches the fingerprint through the DEEP walk, not only the single-string entry point', () => {
    // `ResolvedOptions.salt` and `PathScrubOptions.fingerprintSalt` are
    // different names for the same thing; a deep walk that re-entered the
    // public entry point per string would drop the salt and hash under the
    // empty key — weaker than the public constant `b15` retired.
    const payload = { data: { iteration_path: 'C:\\elsewhere\\hand-off\\01.md' } };
    const a = scrubPayloadPaths(payload, { fingerprintSalt: 'salt-a' });
    const b = scrubPayloadPaths(payload, { fingerprintSalt: 'salt-b' });
    const unsalted = scrubPayloadPaths(payload, {});
    const fp = (o: typeof payload): string => o.data.iteration_path;
    expect(fp(a)).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(fp(a)).not.toBe(fp(b));
    expect(fp(a)).not.toBe(fp(unsalted));
    // …and it is the SAME value the single-string entry point produces.
    expect(fp(a)).toBe(scrubPathString('C:\\elsewhere\\hand-off\\01.md', { fingerprintSalt: 'salt-a' }));
  });

  test('the scrub is IDEMPOTENT — the wire pass is a no-op over the queue pass', () => {
    const once = scrubPathString(`${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`, {
      roots: [WIN_ROOT],
      fingerprintSalt: SALT,
    });
    expect(scrubPathString(once, { roots: [WIN_ROOT], fingerprintSalt: SALT })).toBe(once);
    const fp = scrubPathString('C:\\elsewhere\\x.md', { roots: [], fingerprintSalt: SALT });
    expect(scrubPathString(fp, { roots: [], fingerprintSalt: SALT })).toBe(fp);
  });

  test('the most SPECIFIC root wins — a worktree nested in the project root', () => {
    const worktree = `${WIN_ROOT}\\.worktrees\\run-1`;
    const roots = collectPathRoots({ project_root: WIN_ROOT, worktree });
    expect(roots[0]).toBe(worktree); // longest-first
    expect(
      scrubPathString(`${worktree}\\.pipeline\\p\\steps\\01.md`, { roots, fingerprintSalt: SALT }),
    ).toBe('.pipeline/p/steps/01.md');
  });

  test('roots are read from the UNFILTERED payload — after the allowlist `project_root` is a fingerprint', () => {
    const envelope = { project_root: WIN_ROOT, worktree: null, data: { pipeline_root: `${WIN_ROOT}\\.pipeline\\p` } };
    expect(collectPathRoots(envelope)).toEqual([`${WIN_ROOT}\\.pipeline\\p`, WIN_ROOT]);
    // What the filter leaves behind names nothing, which is why the seams pass
    // the ORIGINAL payload in.
    expect(collectPathRoots({ project_root: 'fp:d00eb2c5706c9640' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §3 — the OS account name of THIS machine
// ---------------------------------------------------------------------------

describe('b22 §3 — the OS account name of the machine running this test does not ship', () => {
  test('a path built from the live account name is scrubbed', () => {
    const account = userInfo().username;
    expect(account.length).toBeGreaterThan(0);
    expect(defaultAccountNames().includes(account.toLowerCase())).toBe(true);

    // The production shape, with THIS machine's identity in it.
    const root = `C:\\Users\\${account}\\AppData\\Local\\Temp\\claude\\proj`;
    const planted = `${root}\\.pipeline\\probe\\steps\\01-prepare.md`;
    const scrubbed = scrubPathString(planted, { roots: [root], fingerprintSalt: SALT });
    expect(scrubbed).toBe('.pipeline/probe/steps/01-prepare.md');
    expect(scrubbed.toLowerCase()).not.toContain(account.toLowerCase());

    // …and with no root to relativize against, it is still gone.
    const orphaned = scrubPathString(planted, { fingerprintSalt: SALT });
    expect(orphaned).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(orphaned.toLowerCase()).not.toContain(account.toLowerCase());
  });
});
