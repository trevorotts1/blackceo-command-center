/**
 * A-U12 — persona match/grounding observability probe (CC half).
 *
 * Master spec `skill6-blended-persona-kanban-MASTER-SPEC-v2-2026-07-13.md`
 * §A-U12 ACCEPT: (a) the deep-health response contains a `persona_match`
 * advisory object with `{count, mean, buckets}` (schema-validated) and the
 * box's health status is UNCHANGED by any value of it (non-gating proven by
 * test); (b) deleting the fixture company-config yields the
 * `persona_grounding_degraded` event + chip within one probe cycle; (c)
 * restoring it clears the chip.
 *
 * This file covers acceptance (a) end to end: the check-function contract
 * (checkPersonaGrounding, deep-checks.ts) AND the route-level non-gating
 * proof (the exact A7 regression-guard pattern in deep-health.test.ts,
 * replicated here rather than appended there per that file's documented
 * shared-mock-registry gotcha — see skill6-board-projection.test.ts, which
 * established the same own-file convention).
 *
 * Acceptance (b)/(c) — the event + chip clearing on restore — are covered by
 * tests/unit/persona-grounding-sweep.test.ts (event/cooldown, real DB) and
 * tests/unit/u12-a-persona-grounding-chip-render.test.tsx (real render,
 * jsdom) respectively.
 *
 * No real python3 script from the ONB side is used or required — every test
 * here spawns a TINY throwaway fixture script that emits the probe's
 * documented `--json` contract, pointed at via PERSONA_GROUNDING_HEALTH_
 * SCRIPT (the same env-var-override escape hatch EMBEDDING_HEALTH_SCRIPT
 * established for shared-utils/embedding_health.py in
 * src/app/api/health/route.ts). This never depends on the real ONB probe
 * being deployed on the box running the suite.
 *
 * Run: npx vitest run tests/unit/u12-a-persona-grounding-health.test.ts
 */

import './_isolated-db';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u12-persona-grounding-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PERSONA_GROUNDING_HEALTH_SCRIPT;
  delete process.env.OPENCLAW_ROOT;
  delete process.env.OPENCLAW_PLATFORM;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── fixture python scripts ──────────────────────────────────────────────────

/** Write a fixture probe script that always prints the given JSON literal to
 *  stdout, ignoring argv (matches the real probe accepting `--json`). */
function writeFixtureProbe(dir: string, name: string, jsonBody: Record<string, unknown>): string {
  const scriptPath = path.join(dir, name);
  const body = JSON.stringify(jsonBody).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  fs.writeFileSync(scriptPath, `import sys\nprint('${body}')\n`);
  return scriptPath;
}

function healthyFixtureBody() {
  return {
    probe: 'persona_grounding_health_probe',
    box: 'test-fixture',
    advisory_only: true,
    persona_match: {
      count: 12,
      mean: 0.82,
      min: 0.41,
      max: 0.97,
      buckets: { low: 1, mid: 3, high: 8 },
    },
    grounding: {
      degraded: false,
      event: 'persona_grounding_degraded',
      reasons: [],
      layers: { '1': 'ok', '2': 'ok', '3': 'ok' },
    },
  };
}

function degradedFixtureBody() {
  return {
    probe: 'persona_grounding_health_probe',
    box: 'test-fixture',
    advisory_only: true,
    persona_match: {
      count: 0,
      mean: null,
      min: null,
      max: null,
      buckets: { low: 0, mid: 0, high: 0 },
    },
    grounding: {
      degraded: true,
      event: 'persona_grounding_degraded',
      reasons: ['company-config missing'],
      layers: { '1': 'neutral-floor', '2': 'neutral-floor', '3': 'neutral-floor' },
    },
  };
}

/** Write a fixture script that prints valid JSON but with a malformed
 *  persona_match (count is a string, buckets missing entirely). */
function writeMalformedSchemaProbe(dir: string): string {
  const scriptPath = path.join(dir, 'malformed-schema.py');
  fs.writeFileSync(
    scriptPath,
    `print('{"persona_match": {"count": "oops"}, "grounding": {"degraded": true}}')\n`,
  );
  return scriptPath;
}

/** Write a fixture script that prints non-JSON garbage. */
function writeGarbageProbe(dir: string): string {
  const scriptPath = path.join(dir, 'garbage.py');
  fs.writeFileSync(scriptPath, `print('not json at all')\n`);
  return scriptPath;
}

/** Write a fixture script that crashes (models a broken probe / bad python3
 *  install — the real probe always exits 0, but this exercises the
 *  execFileAsync-throws path so it can never bubble to the caller). */
function writeCrashingProbe(dir: string): string {
  const scriptPath = path.join(dir, 'crashing.py');
  fs.writeFileSync(scriptPath, `import sys\nsys.exit(1)\n`);
  return scriptPath;
}

async function loadChecks() {
  vi.resetModules();
  return (await import('../../src/lib/health/deep-checks.js')) as typeof import('../../src/lib/health/deep-checks');
}

// ── resolvePersonaGroundingHealthScript ─────────────────────────────────────

describe('resolvePersonaGroundingHealthScript — mirrors resolveOpenClawRoot() precedent (persona-selector.ts)', () => {
  it('PERSONA_GROUNDING_HEALTH_SCRIPT override wins over every other resolution', async () => {
    process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = '/custom/probe.py';
    process.env.OPENCLAW_ROOT = '/should/be/ignored';
    const { resolvePersonaGroundingHealthScript } = await loadChecks();
    expect(resolvePersonaGroundingHealthScript()).toBe('/custom/probe.py');
  });

  it('OPENCLAW_ROOT set → resolves under <root>/skills/shared-utils/persona_grounding_health_probe.py', async () => {
    process.env.OPENCLAW_ROOT = '/openclaw-root';
    const { resolvePersonaGroundingHealthScript } = await loadChecks();
    expect(resolvePersonaGroundingHealthScript()).toBe(
      path.join('/openclaw-root', 'skills', 'shared-utils', 'persona_grounding_health_probe.py'),
    );
  });

  it('OPENCLAW_PLATFORM=vps (no OPENCLAW_ROOT) → resolves under /data/.openclaw', async () => {
    delete process.env.OPENCLAW_ROOT;
    process.env.OPENCLAW_PLATFORM = 'vps';
    const { resolvePersonaGroundingHealthScript } = await loadChecks();
    expect(resolvePersonaGroundingHealthScript()).toBe(
      path.join('/data/.openclaw', 'skills', 'shared-utils', 'persona_grounding_health_probe.py'),
    );
  });

  it('neither set → falls back to $HOME/.openclaw (Mac default), a SIBLING of skills/23-ai-workforce-blueprint', async () => {
    delete process.env.OPENCLAW_ROOT;
    delete process.env.OPENCLAW_PLATFORM;
    const { resolvePersonaGroundingHealthScript } = await loadChecks();
    const expected = path.join(os.homedir(), '.openclaw', 'skills', 'shared-utils', 'persona_grounding_health_probe.py');
    expect(resolvePersonaGroundingHealthScript()).toBe(expected);
  });
});

// ── checkPersonaGrounding ────────────────────────────────────────────────────

describe('checkPersonaGrounding — pure, non-gating advisory read', () => {
  it('script not found (not yet deployed on this box) → indeterminate, pass=true, never throws', async () => {
    process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = path.join(tmpDir, 'does-not-exist.py');
    const { checkPersonaGrounding } = await loadChecks();
    const result = await checkPersonaGrounding();
    expect(result.pass).toBe(true);
    expect(result.indeterminate).toBe(true);
    expect(result.detail).toMatch(/not yet deployed/i);
  });

  it('healthy fixture → schema-valid persona_match {count, mean, buckets}, grounding.degraded=false, pass=true', async () => {
    process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = writeFixtureProbe(tmpDir, 'healthy.py', healthyFixtureBody());
    const { checkPersonaGrounding } = await loadChecks();
    const result = await checkPersonaGrounding();
    expect(result.indeterminate).not.toBe(true);
    expect(result.pass).toBe(true);
    expect(result.persona_match).toBeDefined();
    expect(typeof result.persona_match?.count).toBe('number');
    expect(result.persona_match?.count).toBe(12);
    expect(result.persona_match?.mean).toBe(0.82);
    expect(result.persona_match?.buckets).toEqual({ low: 1, mid: 3, high: 8 });
    expect(result.grounding?.degraded).toBe(false);
  });

  it('degraded fixture (deleted company-config simulated) → grounding.degraded=true, advisory pass=false (its OWN value only)', async () => {
    process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = writeFixtureProbe(tmpDir, 'degraded.py', degradedFixtureBody());
    const { checkPersonaGrounding } = await loadChecks();
    const result = await checkPersonaGrounding();
    expect(result.indeterminate).not.toBe(true);
    expect(result.pass).toBe(false);
    expect(result.grounding?.degraded).toBe(true);
    expect(result.grounding?.reasons).toEqual(['company-config missing']);
    expect(result.persona_match?.count).toBe(0);
    expect(result.persona_match?.mean).toBeNull();
    expect(result.detail).toMatch(/DEGRADED/);
  });

  it('malformed schema (count is a string, buckets missing) → degrades to indeterminate, never fabricates a distribution', async () => {
    process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = writeMalformedSchemaProbe(tmpDir);
    const { checkPersonaGrounding } = await loadChecks();
    const result = await checkPersonaGrounding();
    expect(result.pass).toBe(true);
    expect(result.indeterminate).toBe(true);
    expect(result.persona_match).toBeUndefined();
    expect(result.detail).toMatch(/schema validation/i);
  });

  it('non-JSON probe output → degrades to indeterminate, never throws', async () => {
    process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = writeGarbageProbe(tmpDir);
    const { checkPersonaGrounding } = await loadChecks();
    const result = await checkPersonaGrounding();
    expect(result.pass).toBe(true);
    expect(result.indeterminate).toBe(true);
  });

  it('probe crashes (non-zero exit) → degrades to indeterminate, NEVER keys on exit code, never throws to the caller', async () => {
    process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = writeCrashingProbe(tmpDir);
    const { checkPersonaGrounding } = await loadChecks();
    const result = await checkPersonaGrounding();
    expect(result.pass).toBe(true);
    expect(result.indeterminate).toBe(true);
  });
});

// ── A-U12 acceptance (a): route-level non-gating proof ──────────────────────
//
// Clones the A7 regression-guard pattern verbatim (tests/unit/deep-health.test.ts
// 'A7 regression: a CONFIRMED board drift is ADVISORY only'): drive the REAL
// route handler with all 7 gating checks forced green, inject the fixture
// probe via the env-var override, and assert the top-level pass/indeterminate
// verdict is IDENTICAL regardless of the advisory's value.

/** Create a minimal .next build tree so the gating asset/html checks pass. */
function makeGatingGreenNextBuild(dir: string): void {
  const nextDir = path.join(dir, '.next');
  fs.mkdirSync(nextDir, { recursive: true });
  fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'abc123test');
  const relPath = 'static/chunks/main-abc123.js';
  const diskPath = path.join(nextDir, relPath);
  fs.mkdirSync(path.dirname(diskPath), { recursive: true });
  fs.writeFileSync(diskPath, '// placeholder js');
  const manifest = { pages: { '/': [relPath], '/_app': [relPath] }, polyfillFiles: [], lowPriorityFiles: [] };
  fs.writeFileSync(path.join(nextDir, 'build-manifest.json'), JSON.stringify(manifest));

  const serverDir = path.join(nextDir, 'server', 'pages');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(
    path.join(serverDir, 'index.html'),
    '<!DOCTYPE html><html><head><title>Summit Retail Enterprises</title></head><body></body></html>',
  );
}

function greenGatingDbMock() {
  return {
    getDb: () => ({
      prepare: (sql: string) => ({
        get: () => {
          if (sql.includes('sqlite_master')) return { name: 'companies' };
          if (sql.includes('SELECT name FROM companies')) return { name: 'Summit Retail Enterprises' };
          return undefined;
        },
        all: () => [],
      }),
    }),
    getMigrationStatus: () => ({ applied: ['001'], pending: [] }),
    getDbPath: () => path.join(tmpDir, 'test.db'),
  };
}

describe('A-U12 acceptance (a): /api/health/deep — persona_match is non-gating on the REAL route', () => {
  let savedAppUrl: string | undefined;
  let savedPubUrl: string | undefined;
  let savedDbPath: string | undefined;

  beforeEach(() => {
    makeGatingGreenNextBuild(tmpDir);
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    savedPubUrl = process.env.CC_PUBLIC_URL;
    savedDbPath = process.env.DATABASE_PATH;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.CC_PUBLIC_URL;
    delete process.env.DATABASE_PATH;
    vi.doMock('@/lib/db', () => greenGatingDbMock());
  });

  afterEach(() => {
    if (savedAppUrl !== undefined) process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
    if (savedPubUrl !== undefined) process.env.CC_PUBLIC_URL = savedPubUrl;
    if (savedDbPath !== undefined) process.env.DATABASE_PATH = savedDbPath;
  });

  async function callRoute(diskFreeBytes: number) {
    vi.doMock('../../src/lib/health/deep-checks.js', async () => {
      const actual = (await vi.importActual('../../src/lib/health/deep-checks.js')) as typeof import(
        '../../src/lib/health/deep-checks'
      );
      // Preserve every real export (INCLUDING the real checkPersonaGrounding,
      // which will spawn the fixture probe via the env override set above) —
      // only diskReader is overridden, exactly like the A7 test's pattern.
      return { ...actual, diskReader: { readFreeBytes: () => diskFreeBytes } };
    });
    vi.resetModules();
    const mod = (await import('../../src/app/api/health/deep/route.js')) as { GET?: () => Promise<Response> };
    if (!mod.GET) throw new Error('route module has no GET export');
    const response = await mod.GET();
    return (await response.json()) as {
      pass: boolean;
      indeterminate: boolean;
      checks: Record<string, unknown>;
      advisory?: {
        persona_match?: {
          pass: boolean;
          indeterminate?: boolean;
          detail: string;
          persona_match?: { count: number; mean: number | null; buckets: { low: number; mid: number; high: number } };
          grounding?: { degraded: boolean; reasons?: string[] };
        };
      };
    };
  }

  it('ACCEPT (a): healthy probe — persona_match advisory present with schema-valid {count,mean,buckets}, box stays GREEN', async () => {
    process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = writeFixtureProbe(tmpDir, 'healthy.py', healthyFixtureBody());
    const body = await callRoute(20 * 1024 ** 3);

    const pm = body.advisory?.persona_match;
    expect(pm).toBeDefined();
    expect(pm?.persona_match?.count).toBe(12);
    expect(typeof pm?.persona_match?.mean).toBe('number');
    expect(pm?.persona_match?.buckets).toEqual({ low: 1, mid: 3, high: 8 });
    expect(pm?.grounding?.degraded).toBe(false);

    // Box stays green.
    expect(body.pass).toBe(true);
    expect(body.indeterminate).toBe(false);
    expect(body.checks).not.toHaveProperty('persona_match');
  });

  it('ACCEPT (a): DEGRADED probe — box health is UNCHANGED by ANY value of the advisory (non-gating proven end-to-end)', async () => {
    process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = writeFixtureProbe(tmpDir, 'degraded.py', degradedFixtureBody());
    const body = await callRoute(20 * 1024 ** 3);

    const pm = body.advisory?.persona_match;
    expect(pm).toBeDefined();
    expect(pm?.grounding?.degraded).toBe(true);
    expect(pm?.pass).toBe(false); // the advisory's OWN value reflects the degrade

    // ...but the BOX verdict is completely unaffected — this is the acceptance
    // (a) proof. Identical assertions to the healthy-probe test above.
    expect(body.pass).toBe(true);
    expect(body.indeterminate).toBe(false);
    expect(body.checks).not.toHaveProperty('persona_match');
  });

  it('ACCEPT (a): probe not yet deployed (script missing) — advisory degrades to indeterminate, box stays GREEN', async () => {
    process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = path.join(tmpDir, 'nope.py');
    const body = await callRoute(20 * 1024 ** 3);

    expect(body.advisory?.persona_match?.indeterminate).toBe(true);
    expect(body.pass).toBe(true);
    expect(body.indeterminate).toBe(false);
  });

  it('MUTATION GUARD: a broken schema-validator (accepting a malformed distribution) would be caught — sanity-check the fixture itself is malformed', async () => {
    // This test exists to prove the malformed-schema fixture used in the
    // check-function suite above really IS malformed against the real probe
    // contract (not a mistakenly-valid fixture that would make that earlier
    // test vacuous). count must be a number per the schema; the fixture sets
    // it to a string.
    const malformed = JSON.parse('{"persona_match": {"count": "oops"}, "grounding": {"degraded": true}}');
    expect(typeof malformed.persona_match.count).not.toBe('number');
  });
});
