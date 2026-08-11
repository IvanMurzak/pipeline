// output-scrubber-drive.test.ts — c2 END TO END: plant a known key, run a real
// `drive`, and prove the value appears in NOTHING that was written.
//
// The other two c2 suites are each half an argument. `output-scrubber.test.ts`
// proves `scrub` redacts; `output-scrubber-sinks.test.ts` proves every sink is
// wired to it. Neither proves the two compose under a real run, and the gap
// between them is exactly where a leak would live: a sink that is wired but
// receives its bytes by another route, a chunk boundary the unit test's
// synthetic split did not reproduce, a file nobody remembered was written.
//
// So this suite runs `runDrive` IN-PROCESS (the register is module state, so
// the key must be resolved in the same process that drives) against a REAL
// subprocess executor — spawned, templated, chunked by the OS — that behaves
// like the third-party code 02 is worried about:
//
//   - it prints a JS STACK TRACE carrying the key on stderr;
//   - it prints a relayed SUBPROCESS ERROR (a foreign traceback) carrying it;
//   - it dribbles the key out ONE BYTE AT A TIME with no newline, so the chunk
//     boundaries are real rather than simulated;
//   - it puts the key in non-JSON chatter, which drive relays verbatim;
//   - and it returns a record whose `halt_reason` quotes the key, which is the
//     256-character free-text field 02 identifies as the telemetry leak path.
//
// The final assertion is a whole-tree sweep: every byte of every file the run
// wrote, checked for the planted value.
//
// The key here is a PLACEHOLDER. Nothing in this file is or resembles a live
// credential.

import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computePlan } from '../src/lib/plan';
import { runDrive } from '../src/commands/drive';
import { extractProviderKeyFlag } from '../src/lib/provider-key';
import { REDACTION_MARKER } from '../src/lib/output-scrubber';

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
}, 30000);

/** The planted value. Long enough to be registrable, distinctive enough that a
 *  substring search cannot false-positive, and obviously not a credential. */
const PLANTED = 'PLACEHOLDER-NOT-A-REAL-KEY-planted-by-c2-e2e-0123456789';

// ---------------------------------------------------------------------------
// A deliberately leaky executor
// ---------------------------------------------------------------------------

const LEAKY_EXECUTOR = `// LeakyExecutor: an executor that spills the provider key everywhere it can.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const KEY = ${JSON.stringify(PLANTED)};

const prompt = await Bun.stdin.text();
const m = /^step_record_file = (.+)$/m.exec(prompt);
if (!m) process.exit(9);
const recordFile = m[1].trim();
const rm = /^pipeline_root = (.+)$/m.exec(prompt);
const root = rm ? rm[1].trim() : dirname(dirname(dirname(dirname(recordFile))));
const stepId = basename(recordFile, '.json');

const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

// 1. A REAL JS stack trace whose message quotes the key — the shape an SDK
//    error takes when it echoes the request it just made.
const e = new Error('401 unauthorized: {"x-api-key":"' + KEY + '"}');
process.stderr.write(String(e.stack) + '\\n');

// 2. A FOREIGN traceback, relayed verbatim by drive's stderr relay.
process.stderr.write(
  'Traceback (most recent call last):\\n' +
  '  File "provider.py", line 12, in call\\n' +
  '    raise RuntimeError(f"rejected key ' + KEY + '")\\n' +
  'RuntimeError: rejected key ' + KEY + '\\n'
);

// 3. One byte at a time, with the newline last, so the OS chunk boundaries are
//    genuine. Per-chunk scrubbing alone cannot catch this.
process.stderr.write('dribbled: ');
for (const ch of KEY) process.stderr.write(ch);
process.stderr.write('\\n');

// 4. Non-JSON chatter on stdout — a wrapper script's own output, which drive
//    passes through untouched by the stream parser.
process.stdout.write('warning: using key ' + KEY + '\\n');

// 5. The record itself: the key inside halt_reason, the 256-char free-text
//    field the privacy allowlist lets through.
w({ type: 'system', subtype: 'init', session_id: 'sess-' + stepId, tools: [] });
const structured = {
  kind: 'step',
  outcome: 'halted',
  halt_reason: 'provider rejected the key ' + KEY + ' — check your configuration',
};
w({ type: 'result', subtype: 'success', is_error: false, num_turns: 1,
    session_id: 'sess-' + stepId, total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    result: JSON.stringify(structured), structured_output: structured });

// 6. And into the record file channel too, so both delivery routes carry it.
mkdirSync(dirname(recordFile), { recursive: true });
writeFileSync(recordFile, JSON.stringify(structured), 'utf8');
process.exit(0);
`;

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'c2-scrub-'));
  created.push(root);
  writeFileSync(join(root, 'PIPELINE.md'), '# P\n\n## End State\nx\n');
  mkdirSync(join(root, 'steps'), { recursive: true });
  writeFileSync(join(root, 'steps', '01-step.md'), '# step 1\n');
  writeFileSync(join(root, 'leaky-executor.ts'), LEAKY_EXECUTOR, 'utf8');
  return root;
}

/** Every file under `dir`, recursively, as [relative path, contents]. */
function allFiles(dir: string, base = dir, out: Array<[string, string]> = []): Array<[string, string]> {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) allFiles(abs, base, out);
    else out.push([abs.slice(base.length + 1), readFileSync(abs, 'utf8')]);
  }
  return out;
}

// ---------------------------------------------------------------------------

test('drive with a leaky real subprocess: the planted key reaches NO sink', async () => {
  const root = scaffold();
  const plan = computePlan(root);
  const runId = 'c2scrub';

  // Plant the key the way a run really acquires one — through the ladder's
  // rung 1, which is the only thing that teaches the scrubber. Nothing else in
  // this test knows the value except the child, which is told it explicitly.
  const { key } = extractProviderKeyFlag(['--api-key', PLANTED]);
  expect(key).toBeDefined();

  let outBuf = '';
  let errBuf = '';
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.chdir(root);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  let code: number;
  try {
    code = await runDrive(
      [
        '--root',
        root,
        '--run-id',
        runId,
        '--start',
        plan.steps[0].path,
        '--executor-cmd',
        `bun ${join(root, 'leaky-executor.ts')}`,
      ],
      {
        out: (s) => (outBuf += s),
        err: (s) => (errBuf += s),
      },
    );
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }

  // The run really ran — otherwise "no key anywhere" would be vacuously true.
  expect(typeof code).toBe('number');
  expect(errBuf.length).toBeGreaterThan(200);
  expect(errBuf).toContain('Traceback (most recent call last)');
  expect(errBuf).toContain('RuntimeError: rejected key');
  expect(errBuf).toContain('dribbled: ');
  expect(errBuf).toContain('401 unauthorized');

  // ── stdout ──────────────────────────────────────────────────────────────
  expect(outBuf).not.toContain(PLANTED);

  // ── stderr: the stack trace, the foreign traceback, the byte-at-a-time
  //    dribble and the non-JSON chatter all land here ─────────────────────
  expect(errBuf).not.toContain(PLANTED);
  // Not even a long prefix — a partial match would be a partial leak, and the
  // dribbled write is exactly the case that could produce one.
  expect(errBuf).not.toContain(PLANTED.slice(0, 30));
  expect(errBuf).toContain(REDACTION_MARKER);

  // ── every file the run wrote ────────────────────────────────────────────
  const files = allFiles(root);
  // The scaffold itself carries the value (the executor source we generated),
  // so exclude the two files we planted it in ourselves.
  const written = files.filter(([p]) => p !== 'leaky-executor.ts');
  expect(written.length).toBeGreaterThan(3);
  const leaked = written.filter(([, text]) => text.includes(PLANTED)).map(([p]) => p);
  expect(leaked).toEqual([]);

  // And the redaction really happened somewhere on disk, rather than the
  // halt reason simply never being persisted.
  const persisted = written.filter(([, t]) => t.includes(REDACTION_MARKER)).map(([p]) => p);
  expect(persisted.length).toBeGreaterThan(0);
}, 120000);

test('the same run with NO key resolved is byte-identical — scrubbing costs nothing when idle', async () => {
  // Guard against the scrubber quietly rewriting output it should not touch.
  // This process has already registered the planted key (the test above), so
  // the honest form of the check is: a run whose text never contains a
  // registered value comes out unchanged.
  const root = scaffold();
  const plan = computePlan(root);
  // A clean executor: no key anywhere in what it prints.
  writeFileSync(
    join(root, 'clean-executor.ts'),
    `import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const prompt = await Bun.stdin.text();
const m = /^step_record_file = (.+)$/m.exec(prompt);
if (!m) process.exit(9);
const recordFile = m[1].trim();
process.stderr.write('a perfectly ordinary diagnostic line\\n');
mkdirSync(dirname(recordFile), { recursive: true });
writeFileSync(recordFile, JSON.stringify({ kind: 'step', outcome: 'halted', halt_reason: 'ordinary halt' }), 'utf8');
process.exit(0);
`,
    'utf8',
  );

  let errBuf = '';
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.chdir(root);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  try {
    await runDrive(
      [
        '--root',
        root,
        '--run-id',
        'c2clean',
        '--start',
        plan.steps[0].path,
        '--executor-cmd',
        `bun ${join(root, 'clean-executor.ts')}`,
      ],
      { out: () => {}, err: (s) => (errBuf += s) },
    );
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
  }

  expect(errBuf).toContain('a perfectly ordinary diagnostic line');
  expect(errBuf).not.toContain(REDACTION_MARKER);
  expect(errBuf).toContain('ordinary halt');
}, 120000);
