// telemetry-daemon-lock-parity.test.ts — pins the two DELIBERATELY
// DUPLICATED pieces of `hooks/analytics_relay.ts`'s telemetry-daemon-ensure
// block against `src/commands/telemetry-daemon.ts`, the module they must
// stay byte-for-byte in agreement with (ux-v2 b11).
//
// WHY THE DUPLICATION EXISTS AT ALL: `hooks/analytics_relay.ts` fires on
// every Agent/Task spawn Claude Code makes and must add no measurable
// latency; `commands/telemetry-daemon.ts` pulls in the outbox/upload/
// vendor-privacy chain at module scope, real (if small) cost a hot hook
// should not pay just to decide "is a daemon already running". So the hook
// does not import that module — it duplicates the ONE-LINE lock-path formula
// and the stale-reclaim age bound. See both files' own header comments.
//
// WHAT THIS TEST GUARDS: a future edit to either copy that forgets the other.
// If the hook's `TELEMETRY_LOCK_STALE_AGE_MS` ever drifted BELOW the
// daemon's real `LOCK_STALE_AGE_MS`, the hook could reclaim a live,
// spec-compliant daemon's lock out from under it (spawning a second one). If
// it drifted the other way by a lot, a genuinely dead daemon's lock would sit
// unreclaimed for longer than necessary. Either the path formula or the age
// constant disagreeing is a silent bug this test turns into a red CI run.

import { describe, expect, test } from 'bun:test';
import {
  LOCK_STALE_AGE_MS as DAEMON_LOCK_STALE_AGE_MS,
  telemetryDaemonLockPath as daemonLockPath,
} from '../src/commands/telemetry-daemon';
import {
  TELEMETRY_LOCK_STALE_AGE_MS as HOOK_LOCK_STALE_AGE_MS,
  telemetryDaemonLockPath as hookLockPath,
} from '../../../hooks/analytics_relay.ts';

describe('hook <-> daemon parity (the duplication this task\'s header explains)', () => {
  test('the stale-lock-reclaim age bound agrees', () => {
    expect(HOOK_LOCK_STALE_AGE_MS).toBe(DAEMON_LOCK_STALE_AGE_MS);
  });

  test('the lock-path formula agrees for an arbitrary project root', () => {
    const sampleRoots = ['/tmp/some-project', '/tmp/some-project/with spaces', 'C:\\Users\\me\\proj'];
    for (const root of sampleRoots) {
      expect(hookLockPath(root)).toBe(daemonLockPath(root));
    }
  });
});
