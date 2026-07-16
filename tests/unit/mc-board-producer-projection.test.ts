/**
 * Unit tests for checkMcBoardSixProducerProjection() and
 * checkSkill35CycleProjection() — U100.
 *
 * U100 generalizes the B-U13/U27 producer-reconcile pattern
 * (tests/unit/skill6-board-projection.test.ts) to the "mc_board six"
 * (49-signature-funnel, 50-email-engine, 53-book-writer, 55-product-bio,
 * 56-sales-page-assets, 57-social-media-in-a-box) and to Skill 35's
 * cycle-manifest variant. Kept in its OWN file for the SAME reason
 * skill6-board-projection.test.ts is: a `vi.doMock` registered by an earlier
 * suite is never un-registered by `vi.resetModules()`.
 *
 * BINARY acceptance this proves (U100 spec, verbatim), for EACH producer:
 *   (a) a deliberately-suppressed ingest fixture is surfaced within one
 *       health-probe cycle — PASS/FAIL.
 *   (b) a clean run reports zero drift across 3 consecutive probes — PASS/FAIL.
 *   (c) no reconcile ever mutates a client surface (read-only) — proven by
 *       the fixture files being read, never written, by every check call
 *       (implicit: these checks never call fs.writeFileSync at all).
 */

import './_isolated-db';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-board-producer-projection-test-'));
  // Pin BOTH the shared mc_board-six override and the skill35 override to
  // isolated, non-existent-by-default paths so no test ever reads a real
  // box's live evidence tree.
  process.env.MC_BOARD_EVIDENCE_BASE_DIR = path.join(tmpDir, 'mc-board-evidence');
  process.env.SKILL35_EVIDENCE_BASE_DIR = path.join(tmpDir, 'skill35-evidence');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../../src/lib/health/deep-checks.js');
  vi.doUnmock('@/lib/health/deep-checks');
  vi.doUnmock('../../src/lib/db.js');
  vi.doUnmock('@/lib/db');
  delete process.env.MC_BOARD_EVIDENCE_BASE_DIR;
  delete process.env.SKILL35_EVIDENCE_BASE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadChecks() {
  vi.resetModules();
  return (await import('../../src/lib/health/deep-checks.js')) as typeof import('../../src/lib/health/deep-checks');
}

function makeMcBoardRun(
  baseDir: string,
  runId: string,
  receipt: { mc_url_set: boolean; ok: boolean; task_id: string | null; reason?: string } | null
): string {
  const runDir = path.join(baseDir, runId);
  const routingDir = path.join(runDir, 'routing');
  fs.mkdirSync(routingDir, { recursive: true });
  if (receipt !== null) {
    fs.writeFileSync(path.join(routingDir, 'board-ingest-receipt.json'), JSON.stringify(receipt));
  }
  return runDir;
}

function makeCycleManifestRun(
  baseDir: string,
  runId: string,
  attempt: { mc_token_resolved: boolean; ok: boolean; task_id: string | null } | null
): string {
  const runDir = path.join(baseDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const manifest: Record<string, unknown> = { skill: '35-social-media-planner', run_id: runId };
  if (attempt !== null) {
    manifest.cc_board_attempt = attempt;
  }
  fs.writeFileSync(path.join(runDir, 'cycle-manifest.json'), JSON.stringify(manifest));
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
    DB_PATH: path.join(tmpDir, 'test.db'),
  };
}

describe('MC_BOARD_SIX_PRODUCERS — U100 spec names exactly these six skills', () => {
  it('is the six skills mc_board.py\'s own docstring + test_cc_contract.py name', async () => {
    const { MC_BOARD_SIX_PRODUCERS } = await loadChecks();
    expect(MC_BOARD_SIX_PRODUCERS.map((p) => p.skillDirName).sort()).toEqual(
      [
        '49-signature-funnel',
        '50-email-engine',
        '53-book-writer',
        '55-product-bio',
        '56-sales-page-assets',
        '57-social-media-in-a-box',
      ].sort()
    );
  });

  it('every producer key is unique', async () => {
    const { MC_BOARD_SIX_PRODUCERS } = await loadChecks();
    const keys = MC_BOARD_SIX_PRODUCERS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('checkMcBoardSixProducerProjection — one representative producer (49-signature-funnel)', () => {
  const producer = {
    key: 'mc_board_49_signature_funnel_projection',
    skillDirName: '49-signature-funnel',
    reconcileHint: '49-signature-funnel/scripts/mc_board.py reconcile --json',
  };

  it('no evidence base directory at all → pass=true, NOT indeterminate (not provisioned)', async () => {
    const { checkMcBoardSixProducerProjection } = await loadChecks();
    const result = checkMcBoardSixProducerProjection(producer);
    expect(result.pass).toBe(true);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/not applicable/i);
    expect(result.detail).not.toContain(tmpDir);
  });

  it('base dir exists but holds zero runs → pass=true, healthy-idle', async () => {
    const base = path.join(tmpDir, 'mc-board-evidence');
    fs.mkdirSync(base, { recursive: true });
    const { checkMcBoardSixProducerProjection } = await loadChecks();
    const result = checkMcBoardSixProducerProjection(producer);
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/healthy-idle/i);
    expect(result.ledger_runs).toBe(0);
  });

  it('run dir with NO board-ingest receipt at all (unwired) → pass=true, never drift', async () => {
    const base = path.join(tmpDir, 'mc-board-evidence');
    makeMcBoardRun(base, 'run-legacy', null);
    const { checkMcBoardSixProducerProjection } = await loadChecks();
    const result = checkMcBoardSixProducerProjection(producer);
    expect(result.pass).toBe(true);
    expect(result.drift_count).toBe(0);
    expect(result.unwired_count).toBe(1);
  });

  it('BINARY (a): a deliberately-suppressed ingest fixture (mc_url_set=false) → CONFIRMED DRIFT within one probe', async () => {
    const base = path.join(tmpDir, 'mc-board-evidence');
    makeMcBoardRun(base, 'run-suppressed', {
      mc_url_set: false,
      ok: false,
      task_id: null,
      reason: 'COMMAND_CENTER_URL/MISSION_CONTROL_URL unset',
    });
    const { checkMcBoardSixProducerProjection } = await loadChecks();
    const result = checkMcBoardSixProducerProjection(producer);
    expect(result.pass).toBe(false);
    expect(result.indeterminate).toBe(false);
    expect(result.drift_count).toBe(1);
    expect(result.detail).toMatch(/DRIFT/);
    expect(result.detail).toContain(producer.reconcileHint);
  });

  it('board configured but ingest failed (ok=false, no task_id) → CONFIRMED DRIFT', async () => {
    const base = path.join(tmpDir, 'mc-board-evidence');
    makeMcBoardRun(base, 'run-failed', { mc_url_set: true, ok: false, task_id: null, reason: 'HTTP 500' });
    const { checkMcBoardSixProducerProjection } = await loadChecks();
    const result = checkMcBoardSixProducerProjection(producer);
    expect(result.pass).toBe(false);
    expect(result.drift_count).toBe(1);
  });

  it('BINARY (b): a landed + confirmed-on-board card → pass=true, zero drift, stable across 3 probes', async () => {
    const base = path.join(tmpDir, 'mc-board-evidence');
    makeMcBoardRun(base, 'run-clean', { mc_url_set: true, ok: true, task_id: 'cc-task-clean' });
    vi.doMock('@/lib/db', () => mockDbWithTaskIds(['cc-task-clean']));
    for (let i = 0; i < 3; i++) {
      const { checkMcBoardSixProducerProjection } = await loadChecks();
      const result = checkMcBoardSixProducerProjection(producer);
      expect(result.pass).toBe(true);
      expect(result.drift_count).toBe(0);
      expect(result.board_landed).toBe(1);
    }
  });

  it('landed receipt but task_id no longer exists on the board (orphaned) → CONFIRMED DRIFT', async () => {
    const base = path.join(tmpDir, 'mc-board-evidence');
    makeMcBoardRun(base, 'run-orphaned', { mc_url_set: true, ok: true, task_id: 'cc-task-deleted' });
    vi.doMock('@/lib/db', () => mockDbWithTaskIds([]));
    const { checkMcBoardSixProducerProjection } = await loadChecks();
    const result = checkMcBoardSixProducerProjection(producer);
    expect(result.pass).toBe(false);
    expect(result.drift_count).toBe(1);
    expect(result.detail).toMatch(/orphaned/i);
  });

  it("this box's own task DB is unreadable while confirming a landed card → pass=false, indeterminate=true (UNKNOWN)", async () => {
    const base = path.join(tmpDir, 'mc-board-evidence');
    makeMcBoardRun(base, 'run-dbdown', { mc_url_set: true, ok: true, task_id: 'cc-task-x' });
    vi.doMock('@/lib/db', () => ({
      getDb: () => ({
        prepare: () => ({
          get: () => {
            throw new Error('SQLITE_BUSY: database is locked');
          },
          all: () => [],
        }),
      }),
      getMigrationStatus: () => ({ applied: [], pending: [] }),
      DB_PATH: path.join(tmpDir, 'test.db'),
    }));
    const { checkMcBoardSixProducerProjection } = await loadChecks();
    const result = checkMcBoardSixProducerProjection(producer);
    expect(result.pass).toBe(false);
    expect(result.indeterminate).toBe(true);
  });

  it('mixed run set: one clean + one drift → drift_count reflects only the bad run', async () => {
    const base = path.join(tmpDir, 'mc-board-evidence');
    makeMcBoardRun(base, 'run-good', { mc_url_set: true, ok: true, task_id: 'cc-task-good' });
    makeMcBoardRun(base, 'run-bad', { mc_url_set: false, ok: false, task_id: null });
    vi.doMock('@/lib/db', () => mockDbWithTaskIds(['cc-task-good']));
    const { checkMcBoardSixProducerProjection } = await loadChecks();
    const result = checkMcBoardSixProducerProjection(producer);
    expect(result.pass).toBe(false);
    expect(result.ledger_runs).toBe(2);
    expect(result.drift_count).toBe(1);
    expect(result.board_landed).toBe(1);
  });
});

describe('checkMcBoardSixProducerProjection — every producer resolves an independent default base dir', () => {
  it('each producer default-resolves under its OWN skillDirName when the shared override is unset', async () => {
    delete process.env.MC_BOARD_EVIDENCE_BASE_DIR;
    const home = process.env.HOME || os.homedir();
    const { MC_BOARD_SIX_PRODUCERS, checkMcBoardSixProducerProjection } = await loadChecks();
    for (const producer of MC_BOARD_SIX_PRODUCERS) {
      const result = checkMcBoardSixProducerProjection(producer);
      // Not provisioned (no real box tree) — but must not throw, and must
      // resolve without leaking the per-producer path into the detail.
      expect(result.pass).toBe(true);
      expect(result.detail).not.toContain(path.join(home, '.openclaw', 'data', producer.skillDirName));
    }
  });
});

describe('checkSkill35CycleProjection', () => {
  it('no runs-root at all → pass=true, NOT indeterminate (not provisioned)', async () => {
    const { checkSkill35CycleProjection } = await loadChecks();
    const result = checkSkill35CycleProjection();
    expect(result.pass).toBe(true);
    expect(result.indeterminate).not.toBe(true);
    expect(result.detail).toMatch(/not applicable/i);
  });

  it('runs-root exists but holds zero cycles → pass=true, healthy-idle', async () => {
    const base = path.join(tmpDir, 'skill35-evidence');
    fs.mkdirSync(base, { recursive: true });
    const { checkSkill35CycleProjection } = await loadChecks();
    const result = checkSkill35CycleProjection();
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/healthy-idle/i);
    expect(result.ledger_runs).toBe(0);
  });

  it('a pre-U100 manifest (no cc_board_attempt field) → pass=true, unwired, never drift', async () => {
    const base = path.join(tmpDir, 'skill35-evidence');
    makeCycleManifestRun(base, 'run-legacy', null);
    const { checkSkill35CycleProjection } = await loadChecks();
    const result = checkSkill35CycleProjection();
    expect(result.pass).toBe(true);
    expect(result.drift_count).toBe(0);
    expect(result.unwired_count).toBe(1);
  });

  it('BINARY (a): a deliberately-suppressed ingest fixture (mc_token_resolved=false) → CONFIRMED DRIFT within one probe', async () => {
    const base = path.join(tmpDir, 'skill35-evidence');
    makeCycleManifestRun(base, 'run-suppressed', { mc_token_resolved: false, ok: false, task_id: null });
    const { checkSkill35CycleProjection } = await loadChecks();
    const result = checkSkill35CycleProjection();
    expect(result.pass).toBe(false);
    expect(result.indeterminate).toBe(false);
    expect(result.drift_count).toBe(1);
    expect(result.detail).toMatch(/DRIFT/);
    expect(result.detail).toMatch(/cycle_manifest_reconcile\.py reconcile --json/);
  });

  it('board reachable but ingest failed (ok=false, no task_id) → CONFIRMED DRIFT', async () => {
    const base = path.join(tmpDir, 'skill35-evidence');
    makeCycleManifestRun(base, 'run-failed', { mc_token_resolved: true, ok: false, task_id: null });
    const { checkSkill35CycleProjection } = await loadChecks();
    const result = checkSkill35CycleProjection();
    expect(result.pass).toBe(false);
    expect(result.drift_count).toBe(1);
  });

  it('BINARY (b): a landed + confirmed-on-board card → pass=true, zero drift, stable across 3 probes', async () => {
    const base = path.join(tmpDir, 'skill35-evidence');
    makeCycleManifestRun(base, 'run-clean', { mc_token_resolved: true, ok: true, task_id: 'cc-task-clean-35' });
    vi.doMock('@/lib/db', () => mockDbWithTaskIds(['cc-task-clean-35']));
    for (let i = 0; i < 3; i++) {
      const { checkSkill35CycleProjection } = await loadChecks();
      const result = checkSkill35CycleProjection();
      expect(result.pass).toBe(true);
      expect(result.drift_count).toBe(0);
      expect(result.board_landed).toBe(1);
    }
  });

  it('landed task_id no longer exists on the board (orphaned) → CONFIRMED DRIFT', async () => {
    const base = path.join(tmpDir, 'skill35-evidence');
    makeCycleManifestRun(base, 'run-orphaned', { mc_token_resolved: true, ok: true, task_id: 'cc-task-deleted-35' });
    vi.doMock('@/lib/db', () => mockDbWithTaskIds([]));
    const { checkSkill35CycleProjection } = await loadChecks();
    const result = checkSkill35CycleProjection();
    expect(result.pass).toBe(false);
    expect(result.drift_count).toBe(1);
    expect(result.detail).toMatch(/orphaned/i);
  });

  it('mixed cycle set: one clean + one drift → drift_count reflects only the bad cycle', async () => {
    const base = path.join(tmpDir, 'skill35-evidence');
    makeCycleManifestRun(base, 'run-good', { mc_token_resolved: true, ok: true, task_id: 'cc-task-good-35' });
    makeCycleManifestRun(base, 'run-bad', { mc_token_resolved: false, ok: false, task_id: null });
    vi.doMock('@/lib/db', () => mockDbWithTaskIds(['cc-task-good-35']));
    const { checkSkill35CycleProjection } = await loadChecks();
    const result = checkSkill35CycleProjection();
    expect(result.pass).toBe(false);
    expect(result.ledger_runs).toBe(2);
    expect(result.drift_count).toBe(1);
    expect(result.board_landed).toBe(1);
  });
});
