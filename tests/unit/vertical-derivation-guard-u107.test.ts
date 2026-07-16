/**
 * U107 (E5-2; closes G2a) — Vertical NEVER force-added to a client who is not
 * that vertical. Command Center leg.
 *
 * THE DEFECT THIS CLOSES: loadDepartments() (src/lib/routing/departments.config.ts)
 * step 3 fired `return DEFAULT_DEPARTMENTS;` whenever the workspaces table was
 * empty or the DB query threw — handing a client all 25 seed departments,
 * including three vertical-pack departments (client-coaches, course-creator
 * personal-pro-dev; community-management content-creator) that the interview
 * may never have declared. That is a vertical force-added onto a client who is
 * not that vertical.
 *
 * Proves the spec's BINARY acceptance (master spec line 2409) on the CC
 * surface, generalized over the packs CC actually ships (personal-pro-dev,
 * content-creator) rather than the spec's literal real-estate example — CC has
 * no real-estate department, so a real-estate-only fixture would pass
 * vacuously while the three real offenders survived. A real-estate case is
 * still included (below) to prove an unrelated declared vertical grants
 * nothing:
 *   (a) zero declared verticals -> zero vertical-specific departments in the
 *       fallback floor, receipt verdict PASS.
 *   (b) a declared vertical -> that vertical's departments ARE in the floor
 *       (no false negative), receipt verdict PASS.
 *   (c) a seeded force-add attempt for a non-declared vertical department is
 *       refused with the named VERTICAL_NOT_DECLARED error, never silently
 *       added.
 *
 * Plus a parity harness against golden.json — the REAL Python
 * vertical-derivation-guard.py's check_add() run on the same input, generated
 * by scripts/vertical-derivation-golden.py (regenerate via
 * scripts/regen-vertical-derivation-golden.sh when department-naming-map.json
 * changes) — closing the "TS reimplementation silently drifts from the Python"
 * risk the same way src/lib/interview/__tests__/seam-parity.test.ts does for
 * the sibling P3-7 harness.
 *
 * MUST import _isolated-db FIRST (before any '@/lib/db' import, transitively
 * pulled in by loadDepartments()'s wiring test) so getDb() opens a throwaway
 * DB, never the real mission-control.db.
 */
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DEPARTMENTS,
  VERTICAL_PACK_DEPARTMENTS,
  checkAddDepartmentSync,
  getDefaultFloorDepartments,
  evaluateDefaultFloorVerticalDerivation,
  isVerticalDerivationGuardEnabled,
  loadDepartments,
} from '../../src/lib/routing/departments.config';
import { declaredVerticalPacks } from '../../src/lib/interview/seam';

const fixtureDir = path.join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'src',
  'lib',
  'routing',
  '__fixtures__',
  'vertical-derivation',
);

interface GoldenCaseResult {
  deptId: string;
  allowed: boolean;
  error: string | null;
}
interface GoldenCase {
  name: string;
  declaredPacks: string[];
  results: GoldenCaseResult[];
}
interface Golden {
  meta: Record<string, unknown>;
  packMembership: Record<string, { pack: string; universalPrimary: boolean } | null>;
  cases: GoldenCase[];
}

const golden = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'golden.json'), 'utf-8')) as Golden;

const REAL_HOME = process.env.HOME;
const REAL_WS_ROOT = process.env.OPENCLAW_WORKSPACE_ROOT;
const REAL_FLAG = process.env.VERTICAL_DERIVATION_GUARD_ENABLED;

function restoreEnv() {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  if (REAL_WS_ROOT === undefined) delete process.env.OPENCLAW_WORKSPACE_ROOT;
  else process.env.OPENCLAW_WORKSPACE_ROOT = REAL_WS_ROOT;
  if (REAL_FLAG === undefined) delete process.env.VERTICAL_DERIVATION_GUARD_ENABLED;
  else process.env.VERTICAL_DERIVATION_GUARD_ENABLED = REAL_FLAG;
}

test.after(() => restoreEnv());

// ─────────────────────────────────────────────────────────────────────────
// Sanity — the golden fixture actually loaded and pins the 3 known offenders
// ─────────────────────────────────────────────────────────────────────────
test('golden fixture sanity: pins client-coaches/course-creator (personal-pro-dev) + community-management (content-creator)', () => {
  assert.equal(golden.packMembership['client-coaches']?.pack, 'personal-pro-dev');
  assert.equal(golden.packMembership['client-coaches']?.universalPrimary, false);
  assert.equal(golden.packMembership['course-creator']?.pack, 'personal-pro-dev');
  assert.equal(golden.packMembership['course-creator']?.universalPrimary, false);
  assert.equal(golden.packMembership['community-management']?.pack, 'content-creator');
  assert.equal(golden.packMembership['community-management']?.universalPrimary, false);
  // presentations/podcast ARE pack departments but universal_primary — never gated.
  assert.equal(golden.packMembership['presentations']?.universalPrimary, true);
  assert.equal(golden.packMembership['podcast']?.universalPrimary, true);
  assert.ok(golden.cases.length >= 5, 'golden must carry every declaredCases scenario');
});

// ─────────────────────────────────────────────────────────────────────────
// checkAddDepartmentSync() <-> Python check_add() parity (drift detector)
// ─────────────────────────────────────────────────────────────────────────
test('checkAddDepartmentSync() matches VERTICAL_PACK_DEPARTMENTS pack membership from the live naming map', () => {
  for (const [deptId, expected] of Object.entries(golden.packMembership)) {
    const tsPack = VERTICAL_PACK_DEPARTMENTS[deptId];
    if (!expected || expected.universalPrimary) {
      // Not gated (either not a pack dept, or universal-primary) -> must be ABSENT from the TS table.
      assert.equal(
        tsPack,
        undefined,
        `${deptId}: golden says not-gated (universalPrimary=${expected?.universalPrimary}) but TS table has pack '${tsPack}'`,
      );
    } else {
      assert.equal(
        tsPack,
        expected.pack,
        `${deptId}: TS table says pack '${tsPack}', live naming map says '${expected.pack}' — VERTICAL_PACK_DEPARTMENTS has drifted`,
      );
    }
  }
});

for (const c of golden.cases) {
  test(`checkAddDepartmentSync() parity — declared case "${c.name}" (${JSON.stringify(c.declaredPacks)})`, () => {
    for (const r of c.results) {
      const verdict = checkAddDepartmentSync(r.deptId, c.declaredPacks);
      assert.equal(
        verdict.allowed,
        r.allowed,
        `${r.deptId} under declared=${JSON.stringify(c.declaredPacks)}: TS says allowed=${verdict.allowed}, Python golden says allowed=${r.allowed}`,
      );
      if (!r.allowed) {
        assert.ok(verdict.error, `${r.deptId} refused but TS emitted no error`);
        assert.match(verdict.error!, /^VERTICAL_NOT_DECLARED:/);
      } else {
        assert.equal(verdict.error, null);
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// BINARY acceptance (a) — zero declared verticals -> zero vertical-specific
// departments in the floor; receipt verdict PASS.
// ─────────────────────────────────────────────────────────────────────────
test('(a) no declared verticals -> the default floor carries ZERO vertical-specific departments', () => {
  const floor = getDefaultFloorDepartments([]);
  const floorIds = new Set(floor.map((d) => d.id));
  for (const gated of Object.keys(VERTICAL_PACK_DEPARTMENTS)) {
    assert.ok(!floorIds.has(gated), `${gated} must NOT be in the floor with zero declared verticals`);
  }
  // Mandatory/universal-primary departments are unaffected (regression: this is
  // not "drop everything", only the 3 gated ids are excluded).
  assert.equal(floor.length, DEFAULT_DEPARTMENTS.length - 3);
  assert.ok(floorIds.has('presentations'), 'universal-primary presentations must survive');
  assert.ok(floorIds.has('podcast'), 'universal-primary podcast must survive');
  assert.ok(floorIds.has('general-task'), 'mandatory general-task must survive');

  const verdict = evaluateDefaultFloorVerticalDerivation([]);
  assert.equal(verdict.verdict, 'PASS');
  assert.deepEqual(verdict.provisionedVerticalDepartments, []);
  assert.deepEqual(verdict.violations, []);
});

// ─────────────────────────────────────────────────────────────────────────
// BINARY acceptance (b) — a declared vertical provisions THAT vertical's set
// (positive case, no false negative). Also proves an UNRELATED declared
// vertical (real-estate, the spec's literal example — CC ships no real-estate
// department) grants nothing extra, so the guard isn't accidentally "any
// non-empty declared list unlocks everything".
// ─────────────────────────────────────────────────────────────────────────
test('(b) declaring personal-pro-dev provisions client-coaches + course-creator (no false negative)', () => {
  const floor = getDefaultFloorDepartments(['personal-pro-dev']);
  const floorIds = new Set(floor.map((d) => d.id));
  assert.ok(floorIds.has('client-coaches'), 'declared personal-pro-dev must provision client-coaches');
  assert.ok(floorIds.has('course-creator'), 'declared personal-pro-dev must provision course-creator');
  // community-management belongs to content-creator, NOT declared here.
  assert.ok(!floorIds.has('community-management'), 'undeclared content-creator dept must stay excluded');

  const verdict = evaluateDefaultFloorVerticalDerivation(['personal-pro-dev']);
  assert.equal(verdict.verdict, 'PASS');
  assert.deepEqual(
    verdict.provisionedVerticalDepartments.map((p) => p.id).sort(),
    ['client-coaches', 'course-creator'],
  );
});

test('(b) declaring content-creator provisions community-management (no false negative)', () => {
  const floor = getDefaultFloorDepartments(['content-creator']);
  const floorIds = new Set(floor.map((d) => d.id));
  assert.ok(floorIds.has('community-management'));
  assert.ok(!floorIds.has('client-coaches'));
  assert.ok(!floorIds.has('course-creator'));
});

test('(b) an UNRELATED declared vertical (real-estate, the spec fixture example) grants nothing — no false positive', () => {
  const floor = getDefaultFloorDepartments(['real-estate']);
  const floorIds = new Set(floor.map((d) => d.id));
  for (const gated of Object.keys(VERTICAL_PACK_DEPARTMENTS)) {
    assert.ok(!floorIds.has(gated), `${gated} must stay excluded — real-estate was declared, not its owning pack`);
  }
  const verdict = evaluateDefaultFloorVerticalDerivation(['real-estate']);
  assert.equal(verdict.verdict, 'PASS');
  assert.deepEqual(verdict.provisionedVerticalDepartments, []);
});

// ─────────────────────────────────────────────────────────────────────────
// BINARY acceptance (c) — a seeded force-add attempt for a non-declared
// vertical is refused with a NAMED error, never silently added.
// ─────────────────────────────────────────────────────────────────────────
test('(c) a seeded force-add of client-coaches with nothing declared is refused with a named error', () => {
  const verdict = checkAddDepartmentSync('client-coaches', []);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.error!, /^VERTICAL_NOT_DECLARED: refusing to add department 'client-coaches'/);
  assert.match(verdict.error!, /vertical pack 'personal-pro-dev'/);
});

test('(c) a seeded force-add of community-management with only personal-pro-dev declared is refused', () => {
  const verdict = checkAddDepartmentSync('community-management', ['personal-pro-dev']);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.error!, /^VERTICAL_NOT_DECLARED:/);
  assert.match(verdict.error!, /vertical pack 'content-creator'/);
});

test('(c) a non-vertical (mandatory) department is never refused, declared or not', () => {
  const verdict = checkAddDepartmentSync('marketing', []);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.error, null);
});

// ─────────────────────────────────────────────────────────────────────────
// Revert path — the spec's "revert = flip the flag" clause.
// ─────────────────────────────────────────────────────────────────────────
test('VERTICAL_DERIVATION_GUARD_ENABLED=false restores the pre-U107 unfiltered floor (revert path)', () => {
  process.env.VERTICAL_DERIVATION_GUARD_ENABLED = 'false';
  try {
    assert.equal(isVerticalDerivationGuardEnabled(), false);
    const floor = getDefaultFloorDepartments([]);
    assert.equal(floor.length, DEFAULT_DEPARTMENTS.length);
    assert.ok(floor.some((d) => d.id === 'client-coaches'), 'flag off must restore ALL 25, including the 3 gated ids');
  } finally {
    restoreEnv();
  }
  assert.equal(isVerticalDerivationGuardEnabled(), true, 'flag restored to default ON after the test');
});

// ─────────────────────────────────────────────────────────────────────────
// declaredVerticalPacks() — the seam.ts reader, fail-closed on absence.
// ─────────────────────────────────────────────────────────────────────────
test('declaredVerticalPacks() reads verticalPacks.detectedPacks from build-state; absence fails closed to []', () => {
  assert.deepEqual(declaredVerticalPacks(null), []);
  assert.deepEqual(declaredVerticalPacks({}), []);
  assert.deepEqual(
    declaredVerticalPacks({
      verticalPacks: { detectedPacks: [{ pack: 'personal-pro-dev', matchedKeywords: ['coach'] }] },
    }),
    ['personal-pro-dev'],
  );
  // Garbage entries are ignored, not fatal.
  assert.deepEqual(
    declaredVerticalPacks({
      // @ts-expect-error -- deliberately malformed input, proving the reader degrades safely
      verticalPacks: { detectedPacks: [{ notAPack: true }, { pack: '' }, { pack: 'content-creator' }] },
    }),
    ['content-creator'],
  );
});

// ─────────────────────────────────────────────────────────────────────────
// WIRING proof — loadDepartments() itself (not just the pure helpers) takes
// the guarded path on a real empty-workspaces-table fallback. This is the
// call site the vulnerability actually lived at; testing only the pure
// helpers would leave the wiring unproven (exactly the "tests were decoration"
// failure mode the campaign flagged elsewhere).
// ─────────────────────────────────────────────────────────────────────────
test('loadDepartments() step-3 fallback excludes undeclared vertical departments end-to-end (empty workspaces table, no build-state)', async () => {
  const db = (await import('../../src/lib/db')) as typeof import('../../src/lib/db');
  db.getDb(); // migrate the isolated temp DB; leaves `workspaces` empty (no auto-seed)

  const nonexistentHome = path.join(os.tmpdir(), `u107-nohome-${process.pid}-${Date.now()}`);
  process.env.HOME = nonexistentHome; // resolveWorkspaceDir() -> a dir that has no build-state file
  delete process.env.OPENCLAW_WORKSPACE_ROOT;
  try {
    const depts = loadDepartments();
    const ids = new Set(depts.map((d) => d.id));
    assert.ok(!ids.has('client-coaches'), 'loadDepartments() wiring must exclude client-coaches with no interview signal');
    assert.ok(!ids.has('course-creator'), 'loadDepartments() wiring must exclude course-creator with no interview signal');
    assert.ok(!ids.has('community-management'), 'loadDepartments() wiring must exclude community-management with no interview signal');
    assert.ok(ids.has('marketing'), 'mandatory departments still present');
  } finally {
    restoreEnv();
  }
});

test('loadDepartments() step-3 fallback INCLUDES a declared vertical\'s departments end-to-end (positive case via build-state fixture)', async () => {
  const db = (await import('../../src/lib/db')) as typeof import('../../src/lib/db');
  db.getDb();

  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'u107-ws-'));
  fs.writeFileSync(
    path.join(wsRoot, '.workforce-build-state.json'),
    JSON.stringify({
      interviewComplete: true,
      verticalPacks: { detectedPacks: [{ pack: 'personal-pro-dev', matchedKeywords: ['coach', 'course'] }] },
    }),
  );
  process.env.OPENCLAW_WORKSPACE_ROOT = wsRoot;
  try {
    const depts = loadDepartments();
    const ids = new Set(depts.map((d) => d.id));
    assert.ok(ids.has('client-coaches'), 'declared personal-pro-dev must flow through loadDepartments() end-to-end');
    assert.ok(ids.has('course-creator'), 'declared personal-pro-dev must flow through loadDepartments() end-to-end');
    assert.ok(!ids.has('community-management'), 'undeclared content-creator dept must stay excluded');
  } finally {
    restoreEnv();
    fs.rmSync(wsRoot, { recursive: true, force: true });
  }
});
