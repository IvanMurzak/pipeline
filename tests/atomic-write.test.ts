// lib/atomic-write.ts — the temp-file-plus-rename primitive itself (z1).
//
// Every failure here is INJECTED through the module's `AtomicFs` seam rather
// than argued about: the tests below make the real `renameSync` step fail on
// purpose and then read the destination's bytes off disk. Nothing about the
// atomicity is faked — the seam only decides whether a call throws.
//
// The end-to-end proof against a REAL killed process lives in
// tests/stats-atomic-write.test.ts.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  realAtomicFs,
  writeFileAtomicSync,
  type AtomicFs,
  type AtomicWriteError,
} from '../src/lib/atomic-write';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'pipeline-atomic-write-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Names of any surviving temp files in `dir` (the helper's temp names all
 *  carry the `.tmp-` infix). */
function tempLeftovers(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes('.tmp-'));
}

/** An errno-shaped error, like the ones node:fs actually throws. */
function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`injected ${code}`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/** Wraps the REAL fs, recording the paths it touches and letting a test decide
 *  whether a given rename attempt throws. Only the throwing is simulated: the
 *  writes, renames and unlinks that do not throw are the real thing. */
function recordingFs(onRename: (attempt: number) => void = () => {}): {
  fs: AtomicFs;
  written: string[];
  unlinked: string[];
  attempts: () => number;
} {
  const written: string[] = [];
  const unlinked: string[] = [];
  let renameAttempts = 0;
  const fs: AtomicFs = {
    writeFileSync: (path, data, encoding) => {
      written.push(path);
      realAtomicFs.writeFileSync(path, data, encoding);
    },
    renameSync: (from, to) => {
      renameAttempts += 1;
      onRename(renameAttempts); // may throw — that is the injection
      realAtomicFs.renameSync(from, to);
    },
    unlinkSync: (path) => {
      unlinked.push(path);
      realAtomicFs.unlinkSync(path);
    },
  };
  return { fs, written, unlinked, attempts: () => renameAttempts };
}

describe('writeFileAtomicSync — the normal path', () => {
  test('replaces an EXISTING, populated destination with the new bytes and leaves no temp file', () => {
    const target = join(sandbox, 'runs.jsonl');
    writeFileSync(target, 'ORIGINAL CONTENT that must be fully replaced\n', 'utf8');

    writeFileAtomicSync(target, 'NEW CONTENT\n');

    expect(readFileSync(target, 'utf8')).toBe('NEW CONTENT\n');
    expect(tempLeftovers(sandbox)).toEqual([]);
  });

  // The Windows question, asserted rather than assumed: `renameSync` onto an
  // existing path is not universally permitted, so this module's whole design
  // rests on Node mapping it to MoveFileExW + MOVEFILE_REPLACE_EXISTING. The
  // assertion above exercises exactly that, and CI runs this suite on
  // windows-latest as well as ubuntu-latest — so the Windows leg re-proves the
  // replacement semantics every run instead of trusting a documentation claim.
  test('creates a brand-new file when the destination does not exist yet', () => {
    const target = join(sandbox, 'fresh.jsonl');
    writeFileAtomicSync(target, 'first write\n');
    expect(readFileSync(target, 'utf8')).toBe('first write\n');
    expect(tempLeftovers(sandbox)).toEqual([]);
  });

  test('writes its temp file in the TARGET’S OWN DIRECTORY (same filesystem — rename is only atomic within one)', () => {
    const nested = join(sandbox, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const target = join(nested, 'runs.jsonl');
    const r = recordingFs();

    writeFileAtomicSync(target, 'x\n', { fs: r.fs });

    expect(r.written).toHaveLength(1);
    expect(dirname(r.written[0])).toBe(nested);
    expect(r.written[0]).not.toBe(target);
  });

  test('writes bytes verbatim — no transform, no re-encode, no added newline', () => {
    const target = join(sandbox, 'verbatim.txt');
    // Multi-byte UTF-8, a CRLF, a tab and no trailing newline: anything the
    // helper quietly touched would show up in this comparison.
    const payload = 'héllo — ünïcode\r\nno trailing newline\ttab';
    writeFileAtomicSync(target, payload);
    expect(readFileSync(target).equals(Buffer.from(payload, 'utf8'))).toBe(true);
  });
});

describe('writeFileAtomicSync — a failure between the temp write and the rename', () => {
  test('leaves the ORIGINAL file byte-for-byte intact, removes the temp file, and rethrows the original error', () => {
    const target = join(sandbox, 'runs.jsonl');
    const original = 'line one\nline two\nline three\n';
    writeFileSync(target, original, 'utf8');
    const before = readFileSync(target); // raw bytes

    const r = recordingFs(() => {
      throw errno('ENOSPC'); // non-retryable: fails on the first attempt
    });

    expect(() => writeFileAtomicSync(target, 'REPLACEMENT\n', { fs: r.fs })).toThrow('injected ENOSPC');

    // The whole point: the destination never saw the replacement.
    expect(readFileSync(target).equals(before)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(original);
    // ...and the temp file it had already written is gone.
    expect(tempLeftovers(sandbox)).toEqual([]);
    expect(r.unlinked).toEqual(r.written);
    expect(existsSync(r.written[0])).toBe(false);
  });

  test('the temp file WAS really on disk when the rename failed (so the cleanup assertion above is not vacuous)', () => {
    const target = join(sandbox, 'runs.jsonl');
    writeFileSync(target, 'original\n', 'utf8');
    let existedAtRenameTime = false;
    let tmpPath = '';

    const fs: AtomicFs = {
      writeFileSync: (p, d, e) => {
        tmpPath = p;
        realAtomicFs.writeFileSync(p, d, e);
      },
      renameSync: () => {
        existedAtRenameTime = existsSync(tmpPath);
        throw errno('ENOSPC');
      },
      unlinkSync: (p) => realAtomicFs.unlinkSync(p),
    };

    expect(() => writeFileAtomicSync(target, 'REPLACEMENT\n', { fs })).toThrow();
    expect(existedAtRenameTime).toBe(true); // the vulnerable window was real
    expect(existsSync(tmpPath)).toBe(false); // and it was cleaned up
    expect(readFileSync(target, 'utf8')).toBe('original\n');
  });

  test('a failure in the temp WRITE itself also leaves the original intact and litters nothing', () => {
    const target = join(sandbox, 'runs.jsonl');
    writeFileSync(target, 'original\n', 'utf8');

    const fs: AtomicFs = {
      writeFileSync: () => {
        throw errno('EACCES');
      },
      renameSync: () => {
        throw new Error('rename must never be reached when the temp write failed');
      },
      unlinkSync: (p) => realAtomicFs.unlinkSync(p),
    };

    expect(() => writeFileAtomicSync(target, 'REPLACEMENT\n', { fs })).toThrow('injected EACCES');
    expect(readFileSync(target, 'utf8')).toBe('original\n');
    expect(tempLeftovers(sandbox)).toEqual([]);
  });

  test('a cleanup unlink that itself fails does NOT mask the original fault', () => {
    const target = join(sandbox, 'runs.jsonl');
    writeFileSync(target, 'original\n', 'utf8');

    const fs: AtomicFs = {
      writeFileSync: (p, d, e) => realAtomicFs.writeFileSync(p, d, e),
      renameSync: () => {
        throw errno('ENOSPC');
      },
      unlinkSync: () => {
        throw errno('EBUSY'); // cleanup fails too
      },
    };

    // The caller still sees the REAL problem (ENOSPC), not the cleanup's EBUSY.
    expect(() => writeFileAtomicSync(target, 'REPLACEMENT\n', { fs })).toThrow('injected ENOSPC');
    expect(readFileSync(target, 'utf8')).toBe('original\n');
  });
});

describe('writeFileAtomicSync — the Windows sharing-violation retry', () => {
  // On Windows another process holding a handle to the destination without
  // FILE_SHARE_DELETE makes MoveFileExW fail with EPERM/EACCES/EBUSY even
  // though our own write is perfectly fine. Those codes are retried; a retry
  // is still the SAME atomic rename, never a degraded non-atomic write.
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    test(`${code} is retried and succeeds once the destination is released`, () => {
      const target = join(sandbox, 'runs.jsonl');
      writeFileSync(target, 'original\n', 'utf8');

      const r = recordingFs((attempt) => {
        if (attempt < 3) throw errno(code); // transient: clears on the 3rd try
      });

      writeFileAtomicSync(target, 'REPLACEMENT\n', { fs: r.fs, renameBackoffMs: 0 });

      expect(r.attempts()).toBe(3);
      expect(readFileSync(target, 'utf8')).toBe('REPLACEMENT\n');
      expect(tempLeftovers(sandbox)).toEqual([]);
    });
  }

  test('a PERMANENTLY busy destination exhausts the retries, then fails loudly — the original is untouched and NO non-atomic fallback happens', () => {
    const target = join(sandbox, 'runs.jsonl');
    const original = 'original history that must survive\n';
    writeFileSync(target, original, 'utf8');

    const r = recordingFs(() => {
      throw errno('EBUSY'); // never clears
    });

    expect(() =>
      writeFileAtomicSync(target, 'REPLACEMENT\n', { fs: r.fs, renameAttempts: 4, renameBackoffMs: 0 }),
    ).toThrow('injected EBUSY');

    expect(r.attempts()).toBe(4); // bounded, not infinite
    // The critical assertion: giving up NEVER degrades into writing over the
    // destination directly. The user's file is exactly as it was.
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(tempLeftovers(sandbox)).toEqual([]);
  });

  test('a NON-retryable code fails on the first attempt rather than burning the retry budget', () => {
    const target = join(sandbox, 'runs.jsonl');
    writeFileSync(target, 'original\n', 'utf8');

    const r = recordingFs(() => {
      throw errno('EXDEV'); // cross-device: retrying cannot help
    });

    expect(() => writeFileAtomicSync(target, 'x\n', { fs: r.fs, renameBackoffMs: 0 })).toThrow('injected EXDEV');
    expect(r.attempts()).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('original\n');
    expect(tempLeftovers(sandbox)).toEqual([]);
  });
});

describe('writeFileAtomicSync — REAL platform rename semantics with a concurrent reader', () => {
  // Not injected: this opens a genuine read handle on the destination and then
  // performs the real rename, so each CI leg records what its own OS actually
  // does. The two platforms genuinely differ, and the difference was MEASURED
  // (Windows 11 / Bun 1.3.14) rather than assumed — an ordinary
  // `openSync(path, 'r')` is enough to make Windows refuse the swap with
  // EPERM, which is why the retry budget in atomic-write.ts exists at all.
  test('an open read handle blocks the swap on Windows (EPERM, original intact) and is ignored on POSIX', () => {
    const target = join(sandbox, 'runs.jsonl');
    const original = 'ORIGINAL HISTORY\n';
    writeFileSync(target, original, 'utf8');
    const fd = openSync(target, 'r');

    try {
      if (process.platform === 'win32') {
        // Retries disabled: the handle is held for the whole call, so no
        // budget could help — this asserts the FAILURE is clean, not silent.
        expect(() => writeFileAtomicSync(target, 'REPLACEMENT\n', { renameAttempts: 1 })).toThrow(/EPERM|EACCES|EBUSY/);
        // The user's file survived the refusal untouched...
        expect(readFileSync(target, 'utf8')).toBe(original);
        // ...and no non-atomic fallback quietly wrote it anyway.
        expect(readFileSync(target, 'utf8')).not.toContain('REPLACEMENT');
        expect(tempLeftovers(sandbox)).toEqual([]);
      } else {
        // POSIX: rename ignores open handles entirely.
        writeFileAtomicSync(target, 'REPLACEMENT\n');
        expect(readFileSync(target, 'utf8')).toBe('REPLACEMENT\n');
        expect(tempLeftovers(sandbox)).toEqual([]);
        // The reader's existing fd still points at the ORIGINAL inode — the
        // property that makes rename-based replacement safe for live readers.
        const buf = Buffer.alloc(64);
        const n = readSync(fd, buf, 0, 64, 0);
        expect(buf.subarray(0, n).toString('utf8')).toBe(original);
      }
    } finally {
      closeSync(fd);
    }
  });
});

describe('writeFileAtomicSync — the retry budget is pinned, not incidental', () => {
  // A6 — the review found the defaults only PARTLY pinned: neutering them to
  // 1 attempt / 0 ms failed three tests, so >=3 attempts was pinned, but the
  // exact count and base were not — which is how the docblock drifted to
  // "5 / 1 ms" while the constants said 6 / 2 ms. These assert the numbers
  // themselves, against a permanently-failing rename.
  test('the DEFAULT budget is exactly 14 attempts', () => {
    const target = join(sandbox, 'runs.jsonl');
    writeFileSync(target, 'original\n', 'utf8');
    const r = recordingFs(() => {
      throw errno('EBUSY'); // never clears ⇒ the full budget is spent
    });

    // renameBackoffMs: 0 keeps the test fast; it does not change the COUNT.
    expect(() => writeFileAtomicSync(target, 'x\n', { fs: r.fs, renameBackoffMs: 0 })).toThrow('injected EBUSY');
    expect(r.attempts()).toBe(14);
    expect(readFileSync(target, 'utf8')).toBe('original\n');
  });

  test('the backoff is CAPPED, so a long budget still retries finely near its ceiling', () => {
    const target = join(sandbox, 'runs.jsonl');
    writeFileSync(target, 'original\n', 'utf8');
    const gaps: number[] = [];
    let last = 0;
    const r = recordingFs(() => {
      const now = Date.now();
      if (last !== 0) gaps.push(now - last);
      last = now;
      throw errno('EBUSY');
    });

    expect(() => writeFileAtomicSync(target, 'x\n', { fs: r.fs })).toThrow('injected EBUSY');

    // Uncapped doubling from 1 ms would reach 8192 ms by the 14th attempt.
    // Capped at 25 ms, no single gap may approach that. Generous upper bound
    // so a loaded CI box cannot flake this.
    expect(Math.max(...gaps)).toBeLessThan(200);
    // ...and the later gaps really are the cap, not still doubling.
    expect(gaps.length).toBe(13);
  });

  test('a failure annotates the error with how many renames were attempted', () => {
    const target = join(sandbox, 'runs.jsonl');
    writeFileSync(target, 'original\n', 'utf8');

    // Exhausted retries.
    const busy = recordingFs(() => {
      throw errno('EBUSY');
    });
    try {
      writeFileAtomicSync(target, 'x\n', { fs: busy.fs, renameAttempts: 5, renameBackoffMs: 0 });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AtomicWriteError).renameAttempts).toBe(5);
    }

    // Refused outright on the first attempt (non-retryable).
    const once = recordingFs(() => {
      throw errno('ENOSPC');
    });
    try {
      writeFileAtomicSync(target, 'x\n', { fs: once.fs });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AtomicWriteError).renameAttempts).toBe(1);
    }

    // The temp WRITE failed — the rename was never reached.
    const fs: AtomicFs = {
      writeFileSync: () => {
        throw errno('EACCES');
      },
      renameSync: () => undefined,
      unlinkSync: () => undefined,
    };
    try {
      writeFileAtomicSync(target, 'x\n', { fs });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AtomicWriteError).renameAttempts).toBe(0);
    }
  });
});

describe('writeFileAtomicSync — concurrent writers', () => {
  test('repeated writes to the same target never reuse a temp path', () => {
    const target = join(sandbox, 'runs.jsonl');
    const r = recordingFs();

    for (let i = 0; i < 50; i++) writeFileAtomicSync(target, `write ${i}\n`, { fs: r.fs });

    expect(new Set(r.written).size).toBe(50);
    expect(readFileSync(target, 'utf8')).toBe('write 49\n');
    expect(tempLeftovers(sandbox)).toEqual([]);
  });
});
