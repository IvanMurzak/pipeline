// telemetry-tail.test.ts — `tailProjectJournal` (src/lib/telemetry-tail.ts,
// ux-v2 `b12`), the LOCAL-ONLY drain shared by `pipeline drive` and
// `pipeline next`'s step-boundary flush.
//
// Until `b18` this file had NO direct test coverage at all — it was only
// exercised indirectly through `drive.ts`/`next.ts` integration tests that
// never inspected the outbox's filtered output. That gap is exactly the
// shape of defect `b18` closes: this is one of the FIVE `TelemetryOutbox`
// construction sites that used to default `fingerprintSalt` to `''`
// (07-security.md T16/SG13) — the ONLY drain path for a `pipeline next`/
// `pipeline drive` run that never spawns the detached daemon in-process, so
// its filtered records are exactly what a later daemon poll uploads
// verbatim.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFs, fingerprintSaltFilePath } from '../src/lib/cloud-config';
import { journalPath, telemetryDir, TelemetryOutbox } from '../src/lib/telemetry-outbox';
import { tailProjectJournal, type TailProjectJournalDeps } from '../src/lib/telemetry-tail';

const created: string[] = [];
afterAll(() => {
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function mkProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'tail-proj-'));
  created.push(d);
  mkdirSync(join(d, '.pipeline', '.runtime'), { recursive: true });
  return d;
}

function writeBinding(root: string, binding: Record<string, unknown>): void {
  mkdirSync(join(root, '.pipeline'), { recursive: true });
  writeFileSync(join(root, '.pipeline', 'cloud.json'), JSON.stringify(binding), 'utf-8');
}

function bound(root: string, org = 'acme'): void {
  writeBinding(root, { server: 'https://api.example.test', org, project: 'p', connected_at: 'x' });
}

/** Shape mirrors telemetry-daemon.test.ts's own `journalEvent()` — the
 *  minimum a real journal line needs to survive `drainJournal`'s parse and
 *  privacy filter and be enqueued under a real `run_id`. `project_root` is a
 *  `fingerprint`-rule envelope field (`vendor/privacy.ts`'s
 *  `ENVELOPE_ALLOWLIST`), which is what makes it the right probe for salt
 *  wiring. */
function journalEvent(runId: string, type = 'tool.called'): Record<string, unknown> {
  return {
    schema: 5,
    ts: new Date().toISOString(),
    type,
    project_root: 'C:/proj',
    worktree: null,
    run_id: runId,
    parent_run_id: null,
    session_id: 'sess-1',
    data: {},
  };
}

function appendJournal(root: string, e: Record<string, unknown>): void {
  writeFileSync(journalPath(root), `${JSON.stringify(e)}\n`, { flag: 'a' });
}

/** `homedir` doubles as the project root, exactly like the daemon/stats
 *  telemetry suites' own `home()` helpers. */
function tailDeps(root: string, overrides: Partial<TailProjectJournalDeps> = {}): TailProjectJournalDeps {
  return {
    env: { PIPELINE_CLOUD_HOME: join(root, 'cfg') },
    fs: realFs,
    platform: 'linux',
    homedir: root,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Baseline: the "absent, not merely inert" gates, and that this never throws
// ---------------------------------------------------------------------------

describe('tailProjectJournal — gates (F7, opt-out) and D2 (never throws)', () => {
  test('no cloud.json binding -> no-op, no telemetry dir created', () => {
    const root = mkProject();
    expect(() => tailProjectJournal(root, tailDeps(root))).not.toThrow();
    expect(readdirSync(join(root, '.pipeline', '.runtime')).includes('telemetry')).toBe(false);
  });

  test('PIPELINE_SYNC_LOCAL_STATS=0 -> no-op even when bound', () => {
    const root = mkProject();
    bound(root);
    appendJournal(root, journalEvent('run-off'));
    tailProjectJournal(root, tailDeps(root, { env: { PIPELINE_CLOUD_HOME: join(root, 'cfg'), PIPELINE_SYNC_LOCAL_STATS: '0' } }));
    expect(readdirSync(join(root, '.pipeline', '.runtime')).includes('telemetry')).toBe(false);
  });

  test('a malformed/org-less cloud.json degrades to a no-op rather than throwing', () => {
    const root = mkProject();
    writeBinding(root, { server: 'https://api.example.test', project: 'p', connected_at: 'x' }); // no org
    appendJournal(root, journalEvent('run-noorg'));
    expect(() => tailProjectJournal(root, tailDeps(root))).not.toThrow();
    expect(readdirSync(join(root, '.pipeline', '.runtime')).includes('telemetry')).toBe(false);
  });

  test('bound + journal present -> drains without throwing, and the record lands on disk', () => {
    const root = mkProject();
    bound(root);
    appendJournal(root, journalEvent('run-basic'));
    expect(() => tailProjectJournal(root, tailDeps(root))).not.toThrow();
    const outbox = new TelemetryOutbox({ projectRoot: root, org: 'acme', fingerprintSalt: 'irrelevant-read-only-probe' });
    expect(outbox.counters().queued).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// b18 wiring proof — the salt this drain filters with is the REAL
// per-install secret, not an unresolved/empty one.
// ---------------------------------------------------------------------------

describe('tailProjectJournal — the fingerprint salt is REAL, not empty (ux-v2 b18)', () => {
  test('WIRING PROOF: two different installs produce DIFFERENT fingerprints for the identical project_root', () => {
    const rootA = mkProject();
    bound(rootA);
    appendJournal(rootA, journalEvent('run-wire-a'));
    tailProjectJournal(rootA, tailDeps(rootA));
    const outboxA = new TelemetryOutbox({ projectRoot: rootA, org: 'acme', fingerprintSalt: 'irrelevant-read-only-probe' });
    const [recA] = outboxA.readAll();
    expect(recA.payload.project_root).toMatch(/^fp:[0-9a-f]{16}$/);

    const rootB = mkProject();
    bound(rootB);
    appendJournal(rootB, journalEvent('run-wire-b'));
    tailProjectJournal(rootB, tailDeps(rootB));
    const outboxB = new TelemetryOutbox({ projectRoot: rootB, org: 'acme', fingerprintSalt: 'irrelevant-read-only-probe' });
    const [recB] = outboxB.readAll();

    // MUTATION-PROVABLE: if `tailProjectJournal` stopped resolving/threading
    // the install salt (reverted to the pre-b18 `new TelemetryOutbox({
    // projectRoot, org, env })` shape), this construction would throw
    // (empty-salt guard) — or, under the OLD `?? ''` default, both installs
    // would silently collapse onto the SAME empty-string key, making these
    // two values equal despite being different "installs".
    expect(recA.payload.project_root).not.toBe(recB.payload.project_root);
  });

  test('the SAME install reuses the SAME fingerprint across two separate tail calls', () => {
    const root = mkProject();
    bound(root);
    appendJournal(root, journalEvent('run-stable-1'));
    tailProjectJournal(root, tailDeps(root));

    appendJournal(root, journalEvent('run-stable-2'));
    tailProjectJournal(root, tailDeps(root));

    const outbox = new TelemetryOutbox({ projectRoot: root, org: 'acme', fingerprintSalt: 'irrelevant-read-only-probe' });
    const records = outbox.readAll();
    expect(records.length).toBe(2);
    expect(records[0].payload.project_root).toBe(records[1].payload.project_root);
  });

  test('NEVER UPLOADED: the raw per-install salt never appears in the queued outbox file on disk', () => {
    const root = mkProject();
    bound(root);
    appendJournal(root, journalEvent('run-leak-check'));
    tailProjectJournal(root, tailDeps(root));

    const saltPath = fingerprintSaltFilePath({ platform: 'linux', env: { PIPELINE_CLOUD_HOME: join(root, 'cfg') }, homedir: root });
    const rawSalt = (JSON.parse(readFileSync(saltPath, 'utf-8')) as { salt: string }).salt;
    expect(rawSalt).toMatch(/^[0-9a-f]{64}$/);

    const dir = telemetryDir(root);
    for (const name of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, name), 'utf-8');
      expect(bytes).not.toContain(rawSalt);
    }
  });

  // b15's constraint 2, carried forward: an install that could never persist
  // a salt file (read-only credential dir) must fall back to the documented
  // public constant, NOT error — the drain must still complete.
  test('predates-salt fallback (b15 constraint 2): a read-only credential dir still lets the drain complete, never throws', () => {
    const root = mkProject();
    bound(root);
    appendJournal(root, journalEvent('run-fallback'));
    mkdirSync(join(root, 'cfg'), { recursive: true });
    const brokenFs = {
      ...realFs,
      writeFileSync: () => {
        throw new Error('EACCES: read-only credential directory (simulated)');
      },
    };
    expect(() => tailProjectJournal(root, tailDeps(root, { fs: brokenFs }))).not.toThrow();
    const outbox = new TelemetryOutbox({ projectRoot: root, org: 'acme', fingerprintSalt: 'irrelevant-read-only-probe' });
    // The record still made it through — fingerprinted under the public
    // DEFAULT_FINGERPRINT_SALT fallback rather than lost or crashed on.
    expect(outbox.counters().queued).toBe(1);
  });
});
