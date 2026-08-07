// SG4 — no absolute machine path, and no OS account name, reaches a payload
// (ux-v2 `b22`, moved upstream by `b23`; `07-security.md` §4.1 and gate SG4).
//
// WHAT THIS PROVES, AND WHY IT IS NOT A SPOT CHECK.
//
// SG4 was violated in production from 2026-07-19 until `b22`, and the reason it
// survived is that it is INCONSISTENT: the same step's `iteration.started`
// carried a relative `01-prepare.md` while its `iteration.completed`, seconds
// later, carried `C:\Users\<account>\…\steps\01-prepare.md`. A spot check finds
// the first one and concludes the filter works.
//
// The rule, in one line: the vendored allowlist used to dispose of a path by
// the NAME of its field, so the `keep`-classified step-identity fields shipped
// whatever the emitter handed them — and `PlanStep.path` is absolute by
// construction (`lib/plan.ts`). Nothing relativized anything; the "good"
// production value was the raw `--start 01-prepare.md` argv token, not a
// filtered one. Since `b23` the SHAPE of the value is the rule, and it lives in
// `src/lib/vendor/privacy.ts` — read that file's header for the derivation.
//
// ── WHY THIS FILE STILL EXISTS, AND WHAT CHANGED IN IT ──────────────────────
//
// `b22` could not edit the vendored filter: its specification required the rule
// to land upstream first, and this package's copy must stay byte-identical to
// `pipeline-runner`'s (the parent monorepo's
// `scripts/check-privacy-filter-drift.mjs` compares them). So `b22` composed
// `src/lib/path-privacy.ts` OVER the filter at this CLI's two filtering seams.
//
// `b23` landed the rule in `pipeline-runner`, re-vendored the copy, and DELETED
// that module. This file is retargeted at `filterEventForTier` and
// `filterStatsRecordMetadata` — the filter ALONE, with nothing composed over
// it. That is the point: if the rule had been duplicated rather than moved,
// deleting `path-privacy.ts` would have turned this file red. It did not.
//
//   §1  the rule in isolation — every `keep`-classified path field, the two
//       fields no `*_path` name rule could reach (`stats.failures[].step`,
//       `steps[].id`), a path inside free text, and the three absolute shapes;
//   §2  THE PRODUCTION REPRODUCTION, in `tests/sg4-production-repro.test.ts` —
//       the exact wire envelopes driven through the REAL outbox and uploader;
//   §3  the OS account name of the machine running this test — planted live
//       from `os.userInfo()`, so the assertion is about a real identity;
//   §4  the metadata that must SURVIVE, so the fix cannot pass by shipping
//       nothing.

import { describe, expect, test } from 'bun:test';
import { userInfo } from 'node:os';
import {
  SG4_PATH_RE,
  collectPathRoots,
  defaultAccountNames,
  filterEventForTier,
  filterStatsRecordMetadata,
  looksAbsolutePath,
  scrubPathString,
} from '../src/lib/vendor/privacy';

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

function envelope(type: string, data: Record<string, unknown>, root = WIN_ROOT): Record<string, unknown> {
  return {
    schema: 5,
    ts: '2026-08-07T10:58:39.207Z',
    type,
    project_root: root,
    worktree: null,
    run_id: 'r1',
    parent_run_id: null,
    session_id: null,
    data,
  };
}

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
      // The FILTER ALONE — nothing composed over it. That is what `b23` moved.
      const filtered = filterEventForTier(envelope(type, data), 'metadata', { fingerprintSalt: SALT });
      const findings = sg4Findings(filtered);
      report.push(`  ${findings.length ? 'LEAK  ' : 'clean '} ${type}`);
      expect(`${type}: ${findings.join(' | ') || 'clean'}`).toBe(`${type}: clean`);

      // …and not by deleting the field: it still names the step, relative to
      // the run's own root.
      const out = filtered.data as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        if (!key.endsWith('_path')) continue;
        expect(`${type}.${key} = ${String(out[key])}`).toBe(
          `${type}.${key} = ${key === 'script_path' ? '.pipeline/p/scripts/build.ts' : `.pipeline/p/steps/${key === 'next_iteration_path' ? '02' : '01'}.md`}`,
        );
      }
    }
    console.log(`\n[b22 §1 keep-field sweep]\n${report.join('\n')}\n`);
  });

  test('`stats.failures[].step` and `steps[].id` are scrubbed — neither is `*_path`-named', () => {
    // The two a field-NAME patch would have missed entirely, and the ones
    // `b21`'s run-exit ship path carries.
    const abs = `${WIN_ROOT}\\.pipeline\\p\\steps\\02-build.md`;
    const record: Record<string, unknown> = {
      run_id: 'r1',
      pipeline: 'workflows/release',
      outcome: 'halted',
      steps: [{ id: abs, seconds: 4, outcome: 'FAIL' }],
      failures: [{ ts: '2026-08-07T10:00:00.000Z', tool: 'Bash', step: abs }],
    };

    // Wrapped in an envelope, the root comes from the envelope.
    const wrapped = filterEventForTier(envelope('stats.run_record', record), 'metadata', {
      fingerprintSalt: SALT,
    });
    const wrappedData = wrapped.data as Record<string, unknown>;
    expect((wrappedData.failures as Array<Record<string, unknown>>)[0]?.step).toBe(
      '.pipeline/p/steps/02-build.md',
    );
    expect((wrappedData.steps as Array<Record<string, unknown>>)[0]?.id).toBe(
      '.pipeline/p/steps/02-build.md',
    );
    expect(sg4Findings(wrapped)).toEqual([]);

    // A BARE record has no root field of its own — which is why the outbox's
    // `stats` seam passes its project root in as `pathRoots`.
    expect(
      (
        filterStatsRecordMetadata(record, { fingerprintSalt: SALT, pathRoots: [WIN_ROOT] })
          .failures as Array<Record<string, unknown>>
      )[0]?.step,
    ).toBe('.pipeline/p/steps/02-build.md');
    // …and with no root at all it fails closed rather than shipping raw.
    const noRoot = filterStatsRecordMetadata(record, { fingerprintSalt: SALT });
    expect((noRoot.failures as Array<Record<string, unknown>>)[0]?.step).toMatch(/^fp:[0-9a-f]{16}$/);
    expect((noRoot.steps as Array<Record<string, unknown>>)[0]?.id).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(sg4Findings(noRoot)).toEqual([]);
  });

  test('a path in a field NOBODY allowlisted as a path is still scrubbed — the shape is the rule', () => {
    // `halt_reason` is a `summary` field: free text, truncated but KEPT. It is
    // exactly where a stack frame or a command line drags a path onto the wire,
    // and no field-name rule would ever catch it.
    const scrubbed = filterEventForTier(
      envelope('iteration.completed', {
        outcome: 'halted',
        halt_reason: `build failed: cannot open ${WIN_ROOT}\\.pipeline\\p\\steps\\01.md (ENOENT)`,
      }),
      'metadata',
      { fingerprintSalt: SALT },
    );
    expect(sg4Findings(scrubbed)).toEqual([]);
    // The prose survives; only the path inside it is rewritten.
    expect((scrubbed.data as Record<string, unknown>).halt_reason).toBe(
      'build failed: cannot open .pipeline/p/steps/01.md (ENOENT)',
    );
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
      // …through the filter, with that root on the envelope.
      const filtered = filterEventForTier(envelope('iteration.started', { iteration_path: abs }, root), 'metadata', {
        fingerprintSalt: SALT,
      });
      expect((filtered.data as Record<string, unknown>).iteration_path).toBe('.pipeline/p/steps/01.md');
      expect(sg4Findings(filtered)).toEqual([]);
    }
  });

  test('a path under NO known root FAILS CLOSED to a fingerprint — never passes through raw', () => {
    const orphan = 'C:\\Users\\IvanD\\Documents\\other-client\\secret.md';
    const filtered = filterEventForTier(
      envelope('iteration.completed', { iteration_path: orphan, outcome: 'completed' }, POSIX_ROOT),
      'metadata',
      { fingerprintSalt: SALT },
    );
    const out = (filtered.data as Record<string, unknown>).iteration_path as string;
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
    // …and through the filter, with the account name injected so the assertion
    // is about the RULE rather than about whoever runs the suite.
    const filtered = filterEventForTier(
      envelope('iteration.started', { iteration_path: 'C:\\Users\\IvanD\\proj\\steps\\01.md' }, 'C:\\Users'),
      'metadata',
      { fingerprintSalt: SALT, accountNames: ['ivand'] },
    );
    expect((filtered.data as Record<string, unknown>).iteration_path).toMatch(/^fp:[0-9a-f]{16}$/);
    // A bare token that merely EQUALS the account name, with no path around it,
    // is NOT a layout disclosure and is left alone — redacting it would corrupt
    // step identity for every consumer downstream.
    expect(scrubPathString('ivand', { accountNames: ['ivand'], fingerprintSalt: SALT })).toBe('ivand');
  });

  test('the `b18` salt reaches the fingerprint through the DEEP walk, not only the single-string entry point', () => {
    // The resolved options name the salt `salt` while the public option names
    // it `fingerprintSalt`; a deep walk that re-entered the public entry point
    // per string would drop it and hash under the empty key — weaker than the
    // public constant `b15` retired.
    const orphan = 'C:\\elsewhere\\hand-off\\01.md';
    const fp = (salt: string): unknown =>
      (
        filterEventForTier(envelope('iteration.started', { iteration_path: orphan }), 'metadata', {
          fingerprintSalt: salt,
        }).data as Record<string, unknown>
      ).iteration_path;
    expect(fp('salt-a')).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(fp('salt-a')).not.toBe(fp('salt-b'));
    expect(fp('salt-a')).not.toBe(fp(''));
    // …and it is the SAME value the single-string entry point produces.
    expect(fp('salt-a')).toBe(scrubPathString(orphan, { fingerprintSalt: 'salt-a' }));
  });

  test('the scrub is IDEMPOTENT — the wire pass is a no-op over the queue pass', () => {
    // This is what makes this CLI's TWO filtering seams safe: `b9`'s
    // `filterPayload` runs before the queue file, `filterForWire` runs again
    // before the socket.
    const once = filterEventForTier(
      envelope('iteration.completed', {
        iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
        next_iteration_path: 'C:\\elsewhere\\x.md',
        outcome: 'completed',
      }),
      'metadata',
      { fingerprintSalt: SALT },
    );
    // By the wire pass, `project_root` is already `fp:…` and names nothing —
    // which is exactly why `filterForWire` passes the roots it knows.
    const twice = filterEventForTier(once, 'metadata', { fingerprintSalt: SALT, pathRoots: [WIN_ROOT] });
    expect(twice.data).toEqual(once.data);
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
    const payload = { project_root: WIN_ROOT, worktree: null, data: { pipeline_root: `${WIN_ROOT}\\.pipeline\\p` } };
    expect(collectPathRoots(payload)).toEqual([`${WIN_ROOT}\\.pipeline\\p`, WIN_ROOT]);
    // What the filter leaves behind names nothing, which is why the filter
    // collects roots BEFORE the allowlist runs.
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
    const filtered = filterEventForTier(
      envelope('iteration.started', { iteration_path: planted }, root),
      'metadata',
      { fingerprintSalt: SALT },
    );
    expect((filtered.data as Record<string, unknown>).iteration_path).toBe(
      '.pipeline/probe/steps/01-prepare.md',
    );
    expect(JSON.stringify(filtered).toLowerCase()).not.toContain(account.toLowerCase());

    // …and with no root to relativize against, it is still gone.
    const orphaned = filterEventForTier(
      envelope('iteration.started', { iteration_path: planted }, POSIX_ROOT),
      'metadata',
      { fingerprintSalt: SALT },
    );
    expect((orphaned.data as Record<string, unknown>).iteration_path).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(JSON.stringify(orphaned).toLowerCase()).not.toContain(account.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// §4 — the metadata that must SURVIVE
// ---------------------------------------------------------------------------

describe('b22 §4 — the fix cannot pass by shipping nothing', () => {
  test('relative labels, step names, tool names, URLs and counts all survive untouched', () => {
    const filtered = filterEventForTier(
      envelope('iteration.completed', {
        iteration_path: 'steps/03-review.md',
        next_iteration_path: 'PIPELINE_COMPLETE',
        outcome: 'completed',
        step_name: 'review',
        step_type: 'llm',
        terminal: true,
      }),
      'metadata',
      { fingerprintSalt: SALT },
    );
    expect(filtered.data).toEqual({
      iteration_path: 'steps/03-review.md',
      next_iteration_path: 'PIPELINE_COMPLETE',
      outcome: 'completed',
      step_name: 'review',
      step_type: 'llm',
      terminal: true,
    });
    // A blocker URL is a `keep` field and must not be mangled by the scrub.
    const blocker = filterEventForTier(
      envelope('blocker.polling', {
        blocker_issue_url: 'https://github.com/IvanMurzak/pipeline/issues/1',
        pr_state: 'open',
      }),
      'metadata',
      { fingerprintSalt: SALT },
    );
    expect((blocker.data as Record<string, unknown>).blocker_issue_url).toBe(
      'https://github.com/IvanMurzak/pipeline/issues/1',
    );
    // …and the envelope still correlates by fingerprint.
    expect(filtered.project_root).toMatch(/^fp:[0-9a-f]{16}$/);
  });

  test('`events` and `full` still pass VERBATIM — at those tiers the TIER is the control', () => {
    const event = envelope('iteration.started', {
      iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
    });
    for (const tier of ['events', 'full'] as const) {
      expect(filterEventForTier(event, tier)).toBe(event);
    }
  });
});
