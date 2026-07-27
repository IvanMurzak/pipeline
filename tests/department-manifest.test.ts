// department-manifest.test.ts — unit tests for lib/department-manifest.ts
// (simplified-onboarding task a7): the `department.yml` schema, `apiVersion`,
// the advertised/local split, and the digest.
//
// Everything here is pure: no filesystem, no network. The one function that
// reads a file takes an injected reader.
//
// The suite is organized around a7's Definition of Done, plus the negative
// controls each box needs to mean anything — a digest that never changes would
// pass "stable across reformatting" trivially, and an advertised subset that is
// empty would pass "contains no runtime.command".

import { test, expect, describe } from 'bun:test';
import {
  DEPARTMENT_API_VERSION_V1,
  DEPARTMENT_MANIFEST_FILENAME,
  DIGEST_PREFIX,
  DepartmentManifestError,
  ENGINES,
  LOCAL_ONLY_FIELD_NAMES,
  SUPPORTED_ENGINES,
  adapterIdForEngine,
  advertisedManifest,
  assertNoLocalFields,
  buildRegistrationRequest,
  canonicalJson,
  canonicalizeAdvertised,
  engineDefinition,
  hasErrors,
  manifestDigest,
  parseDepartmentManifest,
  readDepartmentManifest,
  type DepartmentManifest,
  type ManifestFinding,
} from '../src/lib/department-manifest';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Parse and assert the document was at least a mapping. */
function parseOk(yaml: string): { manifest: DepartmentManifest; findings: ManifestFinding[] } {
  const result = parseDepartmentManifest(yaml);
  expect(result.manifest, `expected a manifest for:\n${yaml}`).not.toBeNull();
  return { manifest: result.manifest as DepartmentManifest, findings: result.findings };
}

/** Parse and assert zero errors (warnings allowed). */
function parseClean(yaml: string): DepartmentManifest {
  const { manifest, findings } = parseOk(yaml);
  const errors = findings.filter((f) => f.severity === 'error');
  expect(errors, `unexpected errors: ${JSON.stringify(errors)}`).toEqual([]);
  return manifest;
}

function errorFields(findings: readonly ManifestFinding[]): string[] {
  return findings.filter((f) => f.severity === 'error').map((f) => f.field);
}

function warningFields(findings: readonly ManifestFinding[]): string[] {
  return findings.filter((f) => f.severity === 'warning').map((f) => f.field);
}

/** Every key name appearing anywhere in a JSON-ish value. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

/** 05 §2's "minimum viable file", verbatim. */
const MINIMUM_VIABLE = `apiVersion: department.ai-pipeline.dev/v1
name: unity-review
description: >-
  Reviews Unity and C# architecture, identifies risks, and produces actionable
  refactoring plans.

skills:
  - id: unity-architecture-review
    name: Unity Architecture Review
    description: Review a Unity project or design proposal for architectural risk.

runtime:
  engine: claude-code
`;

/** 05 §2's full reference, minus the commented-out engine-specific blocks. */
const FULL_REFERENCE = `apiVersion: department.ai-pipeline.dev/v1
name: unity-review
displayName: Unity Review
description: >-
  Reviews Unity and C# architecture, identifies risks, and produces actionable
  refactoring plans.
version: 1.2.0
visibility: organization

skills:
  - id: unity-architecture-review
    name: Unity Architecture Review
    description: Review a Unity project for architectural risk.
    tags: [unity, csharp]
    inputModes:  [text/plain]
    outputModes: [text/markdown]

runtime:
  engine: claude-code
  lifecycle: per-task
  startupTimeoutSeconds: 60
  gracefulShutdownSeconds: 15

communication:
  acceptsMidTaskInput: true
  supportsCancellation: true
  supportsStreaming: true

scheduling:
  requiredLabels: [linux, x64]
  requiredIsolation: process
  maxConcurrency: 2
  contextAffinity: preferred

limits:
  taskTimeout: 2h
  parkExpiry: 7d
  maxArtifactBytes: 1048576

retention:
  cloudMessages: 90d
  artifacts: 30d
`;

// ---------------------------------------------------------------------------
// Parsing + defaults
// ---------------------------------------------------------------------------

describe('parseDepartmentManifest — the design docs own examples', () => {
  test("05 §2's minimum viable file parses with no errors and every default resolved", () => {
    const m = parseClean(MINIMUM_VIABLE);
    expect(m.apiVersion).toBe(DEPARTMENT_API_VERSION_V1);
    expect(m.name).toBe('unity-review');
    expect(m.displayName).toBe('unity-review'); // defaults to name
    expect(m.description).toContain('Reviews Unity and C# architecture');
    expect(m.visibility).toBe('organization');
    expect(m.runtime.engine).toBe('claude-code');
    expect(m.runtime.lifecycle).toBe('per-task');
    expect(m.scheduling).toEqual({ requiredLabels: [], contextAffinity: 'none' });
    expect(m.limits).toEqual({});
    expect(m.retention).toEqual({});
    expect(m.skills).toHaveLength(1);
    expect(m.skills[0]!.inputModes).toEqual(['text/plain']);
    expect(m.skills[0]!.outputModes).toEqual(['text/markdown']);
  });

  test("communication defaults follow the engine's declared capabilities", () => {
    const claude = parseClean(MINIMUM_VIABLE);
    expect(claude.communication).toEqual({
      acceptsMidTaskInput: true,
      supportsCancellation: true,
      supportsStreaming: true,
      supportsCheckpoint: false,
    });

    const pipeline = parseClean(MINIMUM_VIABLE.replace('claude-code', 'pipeline'));
    // `pipeline-drive` has no stdin and buffers stdout — advertising either
    // would be rejected by the cloud's own coherence check.
    expect(pipeline.communication.acceptsMidTaskInput).toBe(false);
    expect(pipeline.communication.supportsStreaming).toBe(false);
  });

  test('an engine whose capabilities are negotiated at runtime defaults NOTHING', () => {
    const yaml = MINIMUM_VIABLE.replace('claude-code', 'process');
    const m = parseClean(yaml);
    expect(m.communication).toEqual({});
    // …and therefore advertises nothing, rather than inventing a `true` the
    // child process never negotiated for.
    expect(advertisedManifest(m).communication).toBeUndefined();
  });

  test('an explicit communication value overrides the engine default', () => {
    const m = parseClean(`${MINIMUM_VIABLE}
communication:
  supportsStreaming: false
`);
    expect(m.communication.supportsStreaming).toBe(false);
    expect(m.communication.acceptsMidTaskInput).toBe(true); // still the default
  });

  test("05 §2's full reference parses cleanly, every field landing where documented", () => {
    const m = parseClean(FULL_REFERENCE);
    expect(m.displayName).toBe('Unity Review');
    expect(m.version).toBe('1.2.0');
    expect(m.skills[0]!.tags).toEqual(['unity', 'csharp']);
    expect(m.runtime.startupTimeoutSeconds).toBe(60);
    expect(m.runtime.gracefulShutdownSeconds).toBe(15);
    expect(m.scheduling.requiredLabels).toEqual(['linux', 'x64']);
    expect(m.scheduling.requiredIsolation).toBe('process');
    expect(m.scheduling.maxConcurrency).toBe(2);
    expect(m.scheduling.contextAffinity).toBe('preferred');
    expect(m.limits).toEqual({ taskTimeout: '2h', parkExpiry: '7d', maxArtifactBytes: 1048576 });
    expect(m.retention).toEqual({ cloudMessages: '90d', artifacts: '30d' });
  });
});

describe('parseDepartmentManifest — required fields and formats', () => {
  test('name, description, skills and runtime.engine are each required', () => {
    const { findings } = parseOk('visibility: private\n');
    expect(errorFields(findings).sort()).toEqual(
      ['description', 'name', 'runtime.engine', 'skills'].sort(),
    );
  });

  test('name must be a slug', () => {
    const { findings } = parseOk(MINIMUM_VIABLE.replace('name: unity-review', 'name: Unity Review'));
    expect(errorFields(findings)).toContain('name');
  });

  test('an empty runtime block still reports the missing engine', () => {
    const { findings } = parseOk(MINIMUM_VIABLE.replace('  engine: claude-code\n', ''));
    expect(errorFields(findings)).toContain('runtime.engine');
  });

  test('an unsupported engine names every engine that exists', () => {
    const { findings } = parseOk(MINIMUM_VIABLE.replace('claude-code', 'codex'));
    const finding = findings.find((f) => f.field === 'runtime.engine');
    expect(finding?.severity).toBe('error');
    for (const engine of SUPPORTED_ENGINES) expect(finding?.message).toContain(engine);
  });

  test('enum fields reject unknown values', () => {
    const { findings } = parseOk(
      FULL_REFERENCE.replace('visibility: organization', 'visibility: world')
        .replace('lifecycle: per-task', 'lifecycle: forever')
        .replace('requiredIsolation: process', 'requiredIsolation: vm')
        .replace('contextAffinity: preferred', 'contextAffinity: always'),
    );
    const fields = errorFields(findings);
    expect(fields).toContain('visibility');
    expect(fields).toContain('runtime.lifecycle');
    expect(fields).toContain('scheduling.requiredIsolation');
    expect(fields).toContain('scheduling.contextAffinity');
  });

  test("durations use the runner's grammar, and a bad one is caught here not days later", () => {
    const { findings } = parseOk(FULL_REFERENCE.replace('parkExpiry: 7d', "parkExpiry: 'a week'"));
    const finding = findings.find((f) => f.field === 'limits.parkExpiry');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('7d');
    // The accepted forms all parse.
    for (const value of ['30s', '45m', '2h', '7d', '600']) {
      const m = parseClean(FULL_REFERENCE.replace('parkExpiry: 7d', `parkExpiry: '${value}'`));
      expect(m.limits.parkExpiry).toBe(value);
    }
  });

  test('a YAML-implicit number in a string field is coerced, not rejected', () => {
    // `taskTimeout: 600` and `version: 1.2` arrive as numbers; the cloud
    // requires strings and would answer 400 on a file the author wrote exactly
    // as the docs show.
    const m = parseClean(
      FULL_REFERENCE.replace('taskTimeout: 2h', 'taskTimeout: 600').replace(
        'version: 1.2.0',
        'version: 1.2',
      ),
    );
    expect(m.limits.taskTimeout).toBe('600');
    expect(m.version).toBe('1.2');
  });

  test('skills need an id and a name; a duplicate id is a warning', () => {
    const { findings } = parseOk(`name: d
description: A department that does things for people.
runtime:
  engine: claude-code
skills:
  - id: a
    name: A
  - name: B
  - id: a
    name: A again
`);
    expect(errorFields(findings)).toContain('skills[1].id');
    expect(warningFields(findings)).toContain('skills[2].id');
  });

  test('positive-integer fields reject zero, negatives and fractions', () => {
    for (const value of ['0', '-1', '1.5']) {
      const { findings } = parseOk(
        FULL_REFERENCE.replace('maxConcurrency: 2', `maxConcurrency: ${value}`),
      );
      expect(errorFields(findings), `maxConcurrency: ${value}`).toContain('scheduling.maxConcurrency');
    }
  });
});

describe('parseDepartmentManifest — documents that are not a manifest at all', () => {
  // 05 §4's exit-2 class: "file missing or unparseable". `manifest: null` is
  // how this module says "there is nothing here to validate".
  test('invalid YAML yields no manifest', () => {
    const result = parseDepartmentManifest('name: [1, 2\n');
    expect(result.manifest).toBeNull();
    expect(hasErrors(result.findings)).toBe(true);
  });

  test('an empty file yields no manifest', () => {
    expect(parseDepartmentManifest('').manifest).toBeNull();
    expect(parseDepartmentManifest('# just a comment\n').manifest).toBeNull();
  });

  test('a bare scalar yields no manifest', () => {
    expect(parseDepartmentManifest('unity-review\n').manifest).toBeNull();
  });

  test('a multi-document stream is refused rather than half-read', () => {
    // Bun's YAML returns an ARRAY of documents here; silently taking [0] would
    // publish half a file.
    const result = parseDepartmentManifest(`${MINIMUM_VIABLE}---\nname: other\n`);
    expect(result.manifest).toBeNull();
    expect(result.findings[0]!.message).toContain('single YAML document');
  });

  test('a UTF-8 BOM does not swallow the first key', () => {
    // Windows editors write BOMs by default and the YAML parser does not strip
    // one — without the guard, `name:` arrives as `﻿name` and the
    // department silently has no name.
    const m = parseClean(`﻿${MINIMUM_VIABLE}`);
    expect(m.name).toBe('unity-review');
  });

  test('CRLF line endings parse identically to LF', () => {
    const lf = parseClean(FULL_REFERENCE);
    const crlf = parseClean(FULL_REFERENCE.replace(/\n/g, '\r\n'));
    expect(manifestDigest(crlf)).toBe(manifestDigest(lf));
  });
});

// ---------------------------------------------------------------------------
// DoD: apiVersion (D22)
// ---------------------------------------------------------------------------

describe('apiVersion (D22)', () => {
  test('absent defaults to v1', () => {
    const m = parseClean(MINIMUM_VIABLE.replace(/^apiVersion:.*\n/m, ''));
    expect(m.apiVersion).toBe(DEPARTMENT_API_VERSION_V1);
  });

  test('an unknown apiVersion is an ERROR that names what this CLI can read', () => {
    const { findings } = parseOk(
      MINIMUM_VIABLE.replace(DEPARTMENT_API_VERSION_V1, 'department.ai-pipeline.dev/v2'),
    );
    const finding = findings.find((f) => f.field === 'apiVersion');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain(DEPARTMENT_API_VERSION_V1);
  });

  test('an unknown top-level key WARNS and still parses', () => {
    const result = parseDepartmentManifest(`${MINIMUM_VIABLE}
futureFeature:
  enabled: true
`);
    expect(result.manifest).not.toBeNull();
    expect(hasErrors(result.findings)).toBe(false);
    expect(warningFields(result.findings)).toContain('futureFeature');
    // …and it never reaches the cloud, because the advertised subset is an
    // allow-list.
    const request = buildRegistrationRequest(result.manifest as DepartmentManifest);
    expect(allKeys(request)).not.toContain('futureFeature');
  });

  test('an unknown NESTED key warns too, under its dotted path', () => {
    const result = parseDepartmentManifest(`${MINIMUM_VIABLE}
scheduling:
  requiredLabels: [linux]
  preferredRegion: eu
`);
    expect(hasErrors(result.findings)).toBe(false);
    expect(warningFields(result.findings)).toContain('scheduling.preferredRegion');
  });

  test('apiVersion presence or absence does NOT change the digest', () => {
    const withVersion = parseClean(MINIMUM_VIABLE);
    const without = parseClean(MINIMUM_VIABLE.replace(/^apiVersion:.*\n/m, ''));
    expect(manifestDigest(without)).toBe(manifestDigest(withVersion));
    // Belt: it is not in the advertised subset either.
    expect(allKeys(advertisedManifest(withVersion))).not.toContain('apiVersion');
  });
});

// ---------------------------------------------------------------------------
// DoD: the digest is byte-stable across reordering and reformatting
// ---------------------------------------------------------------------------

describe('digest — stable across key reordering and reformatting', () => {
  /** The same department, written four ways an author might plausibly write it. */
  const REORDERED = `# a department, keys in a different order
runtime:
  engine: claude-code
  lifecycle: per-task
  gracefulShutdownSeconds: 15
  startupTimeoutSeconds: 60
retention:
  artifacts: 30d
  cloudMessages: 90d
limits:
  maxArtifactBytes: 1048576
  parkExpiry: 7d
  taskTimeout: 2h
scheduling:
  contextAffinity: preferred
  maxConcurrency: 2
  requiredIsolation: process
  requiredLabels: [x64, linux]        # set-valued: order is not meaning
communication:
  supportsStreaming: true
  supportsCancellation: true
  acceptsMidTaskInput: true
skills:
  - name: Unity Architecture Review
    outputModes: ["text/markdown"]
    inputModes: ["text/plain"]
    tags: [csharp, unity]
    description: 'Review a Unity project for architectural risk.'
    id: unity-architecture-review
visibility: organization
version: "1.2.0"
description: "Reviews Unity and C# architecture, identifies risks, and produces actionable refactoring plans."
displayName: "Unity Review"
name: unity-review
apiVersion: department.ai-pipeline.dev/v1
`;

  test('reordering keys, requoting scalars and adding comments leaves the digest identical', () => {
    const a = parseClean(FULL_REFERENCE);
    const b = parseClean(REORDERED);
    expect(canonicalizeAdvertised(advertisedManifest(b))).toBe(
      canonicalizeAdvertised(advertisedManifest(a)),
    );
    expect(manifestDigest(b)).toBe(manifestDigest(a));
  });

  test('blank lines and comments between blocks do not move it', () => {
    // Insert a comment and a blank line before every top-level key. (Blank
    // lines INSIDE the folded `description: >-` scalar are not formatting —
    // they are paragraph breaks in the text — so they are correctly excluded.)
    const noisy = FULL_REFERENCE.split('\n')
      .map((line) => (/^[a-zA-Z]/.test(line) ? `\n# section: ${line.split(':')[0]}\n${line}` : line))
      .join('\n');
    expect(noisy).not.toBe(FULL_REFERENCE);
    expect(manifestDigest(parseClean(noisy))).toBe(manifestDigest(parseClean(FULL_REFERENCE)));
  });

  test('the digest is a real sha256 of the canonical bytes', () => {
    const advertised = advertisedManifest(parseClean(FULL_REFERENCE));
    const digest = manifestDigest(parseClean(FULL_REFERENCE));
    expect(digest.startsWith(DIGEST_PREFIX)).toBe(true);
    expect(digest.slice(DIGEST_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/);
    const expected = new Bun.CryptoHasher('sha256')
      .update(canonicalizeAdvertised(advertised), 'utf8')
      .digest('hex');
    expect(digest).toBe(DIGEST_PREFIX + expected);
  });

  test('NEGATIVE CONTROL: a change to any advertised field DOES move the digest', () => {
    const base = manifestDigest(parseClean(FULL_REFERENCE));
    const mutations: Array<[string, string]> = [
      ['name: unity-review', 'name: unity-audit'],
      ['displayName: Unity Review', 'displayName: Unity Audit'],
      ['version: 1.2.0', 'version: 1.3.0'],
      ['visibility: organization', 'visibility: private'],
      ['maxConcurrency: 2', 'maxConcurrency: 3'],
      ['requiredIsolation: process', 'requiredIsolation: container'],
      ['contextAffinity: preferred', 'contextAffinity: required'],
      ['requiredLabels: [linux, x64]', 'requiredLabels: [linux, arm64]'],
      ['parkExpiry: 7d', 'parkExpiry: 14d'],
      ['artifacts: 30d', 'artifacts: 60d'],
      ['supportsStreaming: true', 'supportsStreaming: false'],
      ['id: unity-architecture-review', 'id: unity-arch-review'],
      ['tags: [unity, csharp]', 'tags: [unity, csharp, editor]'],
    ];
    for (const [from, to] of mutations) {
      const mutated = FULL_REFERENCE.replace(from, to);
      expect(mutated, `mutation '${from}' did not apply`).not.toBe(FULL_REFERENCE);
      expect(manifestDigest(parseClean(mutated)), `'${from}' -> '${to}'`).not.toBe(base);
    }
  });

  test('NEGATIVE CONTROL: changing a LOCAL field does not move the digest', () => {
    // Editing the command line is a local change: it alters nothing the cloud
    // was told, so it must not re-arm an admin's approval.
    const base = `name: d
description: A department that does things for people.
skills:
  - id: s
    name: S
runtime:
  engine: process
  command: ./bin/dept
  args: ["serve", "--stdio"]
  workingDirectory: .
`;
    const edited = base
      .replace('./bin/dept', './bin/dept-v2')
      .replace('"serve", "--stdio"', '"serve", "--stdio", "--verbose"');
    expect(manifestDigest(parseClean(edited))).toBe(manifestDigest(parseClean(base)));
  });

  test('canonicalJson sorts keys, omits undefined and preserves array order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ z: { y: 1, x: [{ b: 1, a: 2 }] } })).toBe('{"z":{"x":[{"a":2,"b":1}],"y":1}}');
  });
});

// ---------------------------------------------------------------------------
// DoD: the advertised/local split
// ---------------------------------------------------------------------------

describe('the advertised/local split', () => {
  /** A manifest carrying every LOCAL-ONLY field the design names. */
  const WITH_LOCAL_FIELDS = `apiVersion: department.ai-pipeline.dev/v1
name: unity-review
displayName: Unity Review
description: Reviews Unity and C# architecture and produces refactoring plans.
skills:
  - id: unity-architecture-review
    name: Unity Architecture Review
    description: Review a Unity project for architectural risk.
runtime:
  engine: process
  lifecycle: per-task
  command: ./bin/unity-department
  args: ["serve", "--stdio"]
  workingDirectory: /home/ivan/secret-project
  environment:
    allow: [PATH, HOME]
    values:
      MODE: production
      API_KEY: hunter2
scheduling:
  requiredLabels: [linux, x64]
  requiredIsolation: container
  contextAffinity: required
`;

  test('a manifest containing runtime.command produces a request with no such field', () => {
    const m = parseClean(WITH_LOCAL_FIELDS);
    // It IS parsed — `serve` needs it for the local runtime binding.
    expect(m.runtime.command).toBe('./bin/unity-department');
    expect(m.runtime.args).toEqual(['serve', '--stdio']);
    expect(m.runtime.environment?.values?.['API_KEY']).toBe('hunter2');

    const request = buildRegistrationRequest(m);
    const keys = allKeys(request);
    for (const forbidden of [
      'command',
      'args',
      'workingDirectory',
      'environment',
      'runtime',
      'engine',
      'adapterId',
      'apiVersion',
      'pipelineRoot',
      'startIteration',
      'workspace',
      'path',
    ]) {
      expect(keys, `request must not carry '${forbidden}'`).not.toContain(forbidden);
    }
    // And no local VALUE survives either, under any key.
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('unity-department');
    expect(serialized).not.toContain('secret-project');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('jsonl-process');
  });

  test('the advertised subset is exactly 05 §2s "Sent to the cloud" list', () => {
    const advertised = advertisedManifest(parseClean(FULL_REFERENCE));
    expect(Object.keys(advertised).sort()).toEqual(
      [
        'communication',
        'description',
        'displayName',
        'limits',
        'name',
        'retention',
        'scheduling',
        'skills',
        'version',
        'visibility',
      ].sort(),
    );
  });

  test('the request uses the SERVER field names: yml name -> slug, displayName -> name', () => {
    const request = buildRegistrationRequest(parseClean(FULL_REFERENCE));
    expect(request.slug).toBe('unity-review');
    expect(request.name).toBe('Unity Review');
    expect(request.manifest_digest).toBe(manifestDigest(parseClean(FULL_REFERENCE)));
  });

  test('scheduler inputs ARE sent — the cloud cannot honour what it is not told', () => {
    const request = buildRegistrationRequest(parseClean(FULL_REFERENCE));
    expect(request.scheduling).toEqual({
      requiredLabels: ['linux', 'x64'],
      requiredIsolation: 'process',
      maxConcurrency: 2,
      contextAffinity: 'preferred',
    });
    expect(request.limits).toEqual({ taskTimeout: '2h', parkExpiry: '7d', maxArtifactBytes: 1048576 });
    expect(request.retention).toEqual({ cloudMessages: '90d', artifacts: '30d' });
  });

  test("contextAffinity 'none' is expressed by absence, not by the word", () => {
    // The cloud's enum is `preferred | required`; sending `none` would 400 on a
    // manifest written exactly as 05 §2 documents it.
    const m = parseClean(FULL_REFERENCE.replace('contextAffinity: preferred', 'contextAffinity: none'));
    expect(m.scheduling.contextAffinity).toBe('none');
    const request = buildRegistrationRequest(m);
    expect(request.scheduling?.contextAffinity).toBeUndefined();
    // …and it is the same advertisement as writing nothing at all.
    const omitted = parseClean(FULL_REFERENCE.replace(/^  contextAffinity: preferred\n/m, ''));
    expect(manifestDigest(m)).toBe(manifestDigest(omitted));
  });

  test('empty blocks are omitted rather than sent as {}', () => {
    const request = buildRegistrationRequest(parseClean(MINIMUM_VIABLE));
    expect(request.limits).toBeUndefined();
    expect(request.retention).toBeUndefined();
    expect(request.scheduling).toBeUndefined();
  });

  test('assertNoLocalFields is the alarm, not the guarantee', () => {
    // Hand-built bodies that a future regression could produce.
    expect(() => assertNoLocalFields({ slug: 'd', runtime: { adapter: 'x' } })).toThrow(
      DepartmentManifestError,
    );
    expect(() => assertNoLocalFields({ slug: 'd', workspace: { path: '/srv' } })).toThrow(
      DepartmentManifestError,
    );
    expect(() => assertNoLocalFields({ skills: [{ id: 'a', command: 'rm -rf /' }] })).toThrow(
      /skills\[0\]\.command/,
    );
    expect(() => assertNoLocalFields({ slug: 'd', name: 'D' })).not.toThrow();
    for (const name of LOCAL_ONLY_FIELD_NAMES) {
      expect(() => assertNoLocalFields({ [name]: 'x' }), name).toThrow(DepartmentManifestError);
    }
  });

  test('a real request survives its own alarm', () => {
    expect(() => buildRegistrationRequest(parseClean(FULL_REFERENCE))).not.toThrow();
    expect(() => buildRegistrationRequest(parseClean(WITH_LOCAL_FIELDS))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Engines (06 §2)
// ---------------------------------------------------------------------------

describe('engine -> adapterId (06 §2)', () => {
  test("the mapping is 06 §2's table", () => {
    expect(adapterIdForEngine('claude-code')).toBe('claude-code');
    expect(adapterIdForEngine('pipeline')).toBe('pipeline-drive');
    expect(adapterIdForEngine('process')).toBe('jsonl-process');
    expect(adapterIdForEngine('container')).toBe('container');
    expect(adapterIdForEngine('codex')).toBeUndefined();
  });

  test('every engine maps to exactly one adapter, and no two share one', () => {
    const adapterIds = ENGINES.map((e) => e.adapterId);
    expect(new Set(adapterIds).size).toBe(adapterIds.length);
    for (const engine of SUPPORTED_ENGINES) {
      expect(engineDefinition(engine)?.adapterId).toBeTruthy();
    }
  });

  test('no user-facing text ever says adapterId (06 §2)', () => {
    // Every finding this module can produce, from a file that gets everything
    // wrong at once.
    const { findings } = parseOk(`apiVersion: department.ai-pipeline.dev/v9
name: Not A Slug
skills: []
runtime:
  engine: codex
  lifecycle: forever
limits:
  parkExpiry: a week
mystery: 1
`);
    expect(findings.length).toBeGreaterThan(5);
    for (const f of findings) {
      expect(f.message.toLowerCase(), f.field).not.toContain('adapter');
    }
  });
});

// ---------------------------------------------------------------------------
// readDepartmentManifest — the module's only I/O
// ---------------------------------------------------------------------------

describe('readDepartmentManifest', () => {
  test('reads through the injected reader and parses', () => {
    const result = readDepartmentManifest('/anywhere/department.yml', {
      readFile: () => MINIMUM_VIABLE,
    });
    expect(result.manifest?.name).toBe('unity-review');
  });

  test('a missing file is a thrown error naming the fix, not a finding', () => {
    expect(() =>
      readDepartmentManifest('/nope/department.yml', {
        readFile: () => {
          const e = new Error('ENOENT') as NodeJS.ErrnoException;
          e.code = 'ENOENT';
          throw e;
        },
      }),
    ).toThrow(/pipeline department new/);
  });

  test('an unreadable file surfaces the underlying reason', () => {
    expect(() =>
      readDepartmentManifest('/locked/department.yml', {
        readFile: () => {
          const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          e.code = 'EACCES';
          throw e;
        },
      }),
    ).toThrow(/permission denied/);
  });

  test('the filename is the one the design fixed (D8)', () => {
    expect(DEPARTMENT_MANIFEST_FILENAME).toBe('department.yml');
  });
});

// ---------------------------------------------------------------------------
// Injectable YAML seam
// ---------------------------------------------------------------------------

describe('the YAML seam', () => {
  test('the schema layer can be driven with a plain object', () => {
    const result = parseDepartmentManifest('ignored', {
      yaml: () => ({
        name: 'd',
        description: 'A department that does things for people.',
        skills: [{ id: 's', name: 'S' }],
        runtime: { engine: 'claude-code' },
      }),
    });
    expect(hasErrors(result.findings)).toBe(false);
    expect(result.manifest?.name).toBe('d');
  });

  test('a parser that throws becomes an unparseable-file finding, never a crash', () => {
    const result = parseDepartmentManifest('whatever', {
      yaml: () => {
        throw new Error('boom');
      },
    });
    expect(result.manifest).toBeNull();
    expect(result.findings[0]!.message).toContain('boom');
  });

  test('a __proto__ key in environment.values does not touch a prototype', () => {
    const result = parseDepartmentManifest('ignored', {
      yaml: () => ({
        name: 'd',
        description: 'A department that does things for people.',
        skills: [{ id: 's', name: 'S' }],
        runtime: {
          engine: 'process',
          environment: { values: JSON.parse('{"__proto__": "polluted", "MODE": "production"}') },
        },
      }),
    });
    const values = result.manifest?.runtime.environment?.values;
    expect(values?.['MODE']).toBe('production');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});
