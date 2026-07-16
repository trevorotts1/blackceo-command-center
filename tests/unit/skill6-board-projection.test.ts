/**
 * Unit tests for checkSkill6BoardProjection() — U27 / B-U13.
 *
 * Clones the Anthology A7 test pattern (tests/unit/deep-health.test.ts
 * `describe('anthology_board_projection', ...)`) for Skill 6's fail-soft
 * producer. Kept in its OWN file (rather than appended to deep-health.test.ts)
 * to avoid that file's documented shared-mock-registry gotcha (a `vi.doMock`
 * registered by an earlier suite is never un-registered by `vi.resetModules()`,
 * which only clears the module cache, not the mock registry).
 *
 * These tests exercise the check function directly against real on-disk
 * fixtures under a temp dir — no DB mocking is needed for the pure-local-
 * receipt scenarios (the SKILL.md:607-608 blindness itself never touches the
 * `tasks` table); the "landed then vanished" cross-check scenarios mock
 * `@/lib/db` the same way deep-health.test.ts does.
 *
 * The pure-local-receipt scenarios therefore load deep-checks.ts UNMOCKED, and
 * deep-checks.ts STATICALLY imports '@/lib/db' at its top — so merely importing
 * it (even via the dynamic `await import(...)` used below) reaches the DB
 * singleton and resolves its DB_PATH. This is the same latent C8 gap already
 * fixed in d8-company-config-hint.test.ts: invisible under the old
 * silent-fallback behavior, and undetected by the c8-db-isolation-guard.test.ts
 * scanner, which only follows STATIC import chains out of a test file and so
 * cannot see the DB reach behind this file's dynamic import of an intermediate
 * module. Isolate first so this suite never resolves — let alone opens — a real
 * database.
 */

import './_isolated-db';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill6-board-projection-test-'));
  // Pin the evidence-root resolution to an isolated, non-existent-by-default
  // path for every test so no test ever reads a real box's live
  // $HOME/clawd/skill6-fix tree.
  process.env.SKILL6_EVIDENCE_BASE_DIR = path.join(tmpDir, 'skill6-fix');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../../src/lib/health/deep-checks.js');
  vi.doUnmock('@/lib/health/deep-checks');
  vi.doUnmock('../../src/lib/db.js');
  vi.doUnmock('@/lib/db');
  delete process.env.SKILL6_EVIDENCE_BASE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadChecks() {
  vi.resetModules();
  return await import('../../src/lib/health/deep-checks.js') as typeof import('../../src/lib/health/deep-checks');
}

/** Write a v2-<runId> evidence root with an intake receipt (and, optionally,
 *  a board-ingest receipt — the U27 receipt ingest_task() now writes). */
function makeRun(
  baseDir: string,
  runId: string,
  opts: {
    withIntake?: boolean;
    boardReceipt?: { mission_control_url_set: boolean; ok: boolean; task_id: string | null; reason?: string } | null;
  } = {}
): string {
  const { withIntake = true, boardReceipt } = opts;
  const runDir = path.join(baseDir, `v2-${runId}`);
  const routingDir = path.join(runDir, 'routing');
  fs.mkdirSync(routingDir, { recursive: true });
  if (withIntake) {
    fs.writeFileSync(path.join(routingDir, 'intake-receipt.json'), JSON.stringify({ skipped: false }));
  }
  if (boardReceipt !== undefined && boardReceipt !== null) {
    fs.writeFileSync(path.join(routingDir, 'board-ingest-receipt.json'), JSON.stringify(boardReceipt));
  }
  return runDir;
}

function mockDbWithTaskIds(existingIds: string[]) {
  return {
    getDb: () => ({
      prepare: (_sql: string) => ({
        get: (id: string) => (existingIds.includes(id) ? { id } : undefined),
        all: () => [],
      }),
    }),
    getMigrationStatus: () => ({ applied: ['001'], pending: [] }),
    getDbPath: () => path.join(tmpDir, 'test.db'),
  };
}

describe('resolveSkill6EvidenceBaseDir — mirrors cc_board.py resolve_evidence_base() precedence', () => {
  it('SKILL6_EVIDENCE_BASE_DIR wins when set', async () => {
    process.env.SKILL6_EVIDENCE_BASE_DIR = '/custom/skill6/base';
    const { resolveSkill6EvidenceBaseDir } = await loadChecks();
    expect(resolveSkill6EvidenceBaseDir()).toBe('/custom/skill6/base');
  });

  it('falls back to $HOME/clawd/skill6-fix when unset', async () => {
    delete process.env.SKILL6_EVIDENCE_BASE_DIR;
    const home = process.env.HOME || os.homedir();
    const { resolveSkill6EvidenceBaseDir } = await loadChecks();
    expect(resolveSkill6EvidenceBaseDir()).toBe(path.join(home, 'clawd', 'skill6-fix'));
  });
});

describe('checkSkill6BoardProjection', () => {
  it('no evidence-root base directory at all → pass=true, NOT indeterminate (not provisioned)', async () => {
    // SKILL6_EVIDENCE_BASE_DIR (set in beforeEach) points at a directory that
    // was never created.
    const { checkSkill6BoardProjection } = await loadChecks();
    const result = checkSkill6BoardProjection();
    expect(result.pass).toBe(true);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/not applicable/i);
    // LEAK POSTURE: must not echo the resolved absolute base dir.
    expect(result.detail).not.toContain(tmpDir);
  });

  it('base dir exists but holds zero completed-intake runs → pass=true, healthy-idle', async () => {
    const base = path.join(tmpDir, 'skill6-fix');
    fs.mkdirSync(base, { recursive: true });
    const { checkSkill6BoardProjection } = await loadChecks();
    const result = checkSkill6BoardProjection();
    expect(result.pass).toBe(true);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/healthy-idle/i);
    expect(result.ledger_runs).toBe(0);
  });

  it('run with intake receipt but NO board-ingest receipt (legacy/unwired) → pass=true, never drift', async () => {
    const base = path.join(tmpDir, 'skill6-fix');
    makeRun(base, 'LEGACY', { withIntake: true, boardReceipt: null });
    const { checkSkill6BoardProjection } = await loadChecks();
    const result = checkSkill6BoardProjection();
    expect(result.pass).toBe(true);
    expect(result.drift_count).toBe(0);
    expect(result.unwired_count).toBe(1);
  });

  it('BINARY (a): MISSION_CONTROL_URL unset at ingest (board-ingest receipt says so) → CONFIRMED DRIFT', async () => {
    const base = path.join(tmpDir, 'skill6-fix');
    makeRun(base, 'SUPPRESSED', {
      withIntake: true,
      boardReceipt: { mission_control_url_set: false, ok: false, task_id: null, reason: 'MISSION_CONTROL_URL unset' },
    });
    const { checkSkill6BoardProjection } = await loadChecks();
    const result = checkSkill6BoardProjection();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).toBe(false);
    expect(result.drift_count).toBe(1);
    expect(result.detail).toMatch(/DRIFT/);
    expect(result.detail).toMatch(/Run:\s*cc_board\.py reconcile --json/);
  });

  it('board configured but ingest failed (ok=false with a task_id absent) → CONFIRMED DRIFT', async () => {
    const base = path.join(tmpDir, 'skill6-fix');
    makeRun(base, 'FAILED', {
      withIntake: true,
      boardReceipt: { mission_control_url_set: true, ok: false, task_id: null, reason: 'non-OK response (http=500)' },
    });
    const { checkSkill6BoardProjection } = await loadChecks();
    const result = checkSkill6BoardProjection();
    expect(result.pass).toBe(false);
    expect(result.drift_count).toBe(1);
  });

  it('BINARY (b): a landed + confirmed-on-board card → pass=true, zero drift, stable across 3 probes', async () => {
    const base = path.join(tmpDir, 'skill6-fix');
    makeRun(base, 'CLEAN', {
      withIntake: true,
      boardReceipt: { mission_control_url_set: true, ok: true, task_id: 'cc-task-clean' },
    });
    vi.doMock('@/lib/db', () => mockDbWithTaskIds(['cc-task-clean']));
    for (let i = 0; i < 3; i++) {
      const { checkSkill6BoardProjection } = await loadChecks();
      const result = checkSkill6BoardProjection();
      expect(result.pass).toBe(true);
      expect(result.drift_count).toBe(0);
      expect(result.board_landed).toBe(1);
    }
  });

  it('landed receipt but task_id no longer exists on the board (orphaned) → CONFIRMED DRIFT', async () => {
    const base = path.join(tmpDir, 'skill6-fix');
    makeRun(base, 'ORPHANED', {
      withIntake: true,
      boardReceipt: { mission_control_url_set: true, ok: true, task_id: 'cc-task-deleted' },
    });
    vi.doMock('@/lib/db', () => mockDbWithTaskIds([])); // task_id NOT found on the board
    const { checkSkill6BoardProjection } = await loadChecks();
    const result = checkSkill6BoardProjection();
    expect(result.pass).toBe(false);
    expect(result.drift_count).toBe(1);
    expect(result.detail).toMatch(/orphaned/i);
  });

  it("this box's own task DB is unreadable while confirming a landed card → pass=false, indeterminate=true (UNKNOWN)", async () => {
    const base = path.join(tmpDir, 'skill6-fix');
    makeRun(base, 'DBDOWN', {
      withIntake: true,
      boardReceipt: { mission_control_url_set: true, ok: true, task_id: 'cc-task-x' },
    });
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: () => ({
          get: () => { throw new Error('SQLITE_BUSY: database is locked'); },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: [], pending: [] }),
      getDbPath: () => path.join(tmpDir, 'test.db'),
    }));
    const { checkSkill6BoardProjection } = await loadChecks();
    const result = checkSkill6BoardProjection();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).toBe(true);
  });

  it('mixed run set: one clean + one drift → drift_count reflects only the bad run', async () => {
    const base = path.join(tmpDir, 'skill6-fix');
    makeRun(base, 'GOOD', {
      withIntake: true,
      boardReceipt: { mission_control_url_set: true, ok: true, task_id: 'cc-task-good' },
    });
    makeRun(base, 'BAD', {
      withIntake: true,
      boardReceipt: { mission_control_url_set: false, ok: false, task_id: null },
    });
    vi.doMock('@/lib/db', () => mockDbWithTaskIds(['cc-task-good']));
    const { checkSkill6BoardProjection } = await loadChecks();
    const result = checkSkill6BoardProjection();
    expect(result.pass).toBe(false);
    expect(result.ledger_runs).toBe(2);
    expect(result.drift_count).toBe(1);
    expect(result.board_landed).toBe(1);
  });

  it('a v2-* directory WITHOUT an intake receipt is not counted as a run at all', async () => {
    const base = path.join(tmpDir, 'skill6-fix');
    makeRun(base, 'NOINTAKE', { withIntake: false, boardReceipt: null });
    const { checkSkill6BoardProjection } = await loadChecks();
    const result = checkSkill6BoardProjection();
    expect(result.pass).toBe(true);
    expect(result.ledger_runs).toBe(0);
  });
});
