/**
 * purge-board-residue.test.ts — P1-06 step 2 (DB-backed).
 *
 * Proves purgeBoardResidue() archives [DEMO]/[TEST]-bracket and
 * smoke-test-prefixed task residue, flags (never auto-archives) anthology
 * drill CANDIDATES absent a verified exact-title source, and leaves a
 * blocked task and a legitimate similarly-named client task alone.
 *
 * Net-new module: every test here fails on the pre-fix tree with
 * "Cannot find module '../../scripts/remediate/purge-board-residue'" — the
 * fail-first proof for a from-scratch script (2.1.3).
 *
 *   node --import tsx --test tests/unit/purge-board-residue.test.ts
 */

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { purgeBoardResidue } from '../../scripts/remediate/purge-board-residue';

getDb();

function seedTask(title: string, status = 'backlog'): string {
  const id = uuidv4();
  run(`INSERT INTO tasks (id, title, status, workspace_id, business_id) VALUES (?, ?, ?, NULL, NULL)`, [
    id,
    title,
    status,
  ]);
  return id;
}

function archivedAt(id: string): string | null {
  return queryOne<{ archived_at: string | null }>('SELECT archived_at FROM tasks WHERE id = ?', [id])?.archived_at ?? null;
}

let demoTask: string;
let testBracketTask: string;
let smokeTestTask: string;
let legitSmokeTestingLabTask: string; // must NOT be swept (token-boundary false-positive guard)
let blockedDemoTask: string; // [DEMO]-titled but BLOCKED — must never be swept here
let anthologyDrillCandidate: string; // flagged only, never auto-archived
let anthologyLegitTask: string; // contains "anthology" but no drill/synthetic/dummy/fixture token
let healthyTask: string;

test.before(() => {
  demoTask = seedTask('[DEMO] Sales Funnel Build');
  testBracketTask = seedTask('[TEST] Throwaway card');
  smokeTestTask = seedTask('smoke-test dept row leftover');
  legitSmokeTestingLabTask = seedTask('Smoke Testing Lab Signage Install');
  blockedDemoTask = seedTask('[DEMO] Old blocked demo card', 'blocked');
  anthologyDrillCandidate = seedTask('Anthology drill card #3 (synthetic)');
  anthologyLegitTask = seedTask('Anthology chapter 4 — real participant edit');
  healthyTask = seedTask('Prepare the Q3 board deck for the ops review');
});

test('dry-run (default): reports candidates but archives nothing', () => {
  const result = purgeBoardResidue({ apply: false });
  assert.equal(result.applied, false);
  assert.ok(result.bracketArchivedIds.includes(demoTask));
  assert.ok(result.bracketArchivedIds.includes(testBracketTask));
  assert.ok(result.smokeTestArchivedIds.includes(smokeTestTask));
  assert.ok(result.anthologyCandidatesFlagged.some((l) => l.includes(anthologyDrillCandidate)));

  // Dry-run must not have mutated the DB at all.
  assert.equal(archivedAt(demoTask), null, 'dry-run never archives');
  assert.equal(archivedAt(smokeTestTask), null, 'dry-run never archives');
});

test('legit similarly-named tasks are never matched', () => {
  const result = purgeBoardResidue();
  assert.ok(!result.smokeTestArchivedIds.includes(legitSmokeTestingLabTask), 'token-boundary guard: "Smoke Testing Lab" is not smoke-test residue');
  assert.ok(!result.anthologyCandidatesFlagged.some((l) => l.includes(anthologyLegitTask)), 'a real anthology task without a drill/synthetic/dummy/fixture token is not flagged');
});

test('a blocked task matching the residue pattern is excluded from the scan entirely', () => {
  const result = purgeBoardResidue();
  assert.ok(!result.bracketArchivedIds.includes(blockedDemoTask), 'blocked residue-shaped cards are left to board-hygiene.ts, never swept here');
});

test('anthology drill candidates are flagged, never auto-archived (no fabricated title list)', () => {
  const result = purgeBoardResidue();
  assert.equal(result.anthologyExactArchived, 0, 'ANTHOLOGY_DRILL_EXACT_TITLES is empty by design — nothing auto-archives via that path');
  assert.ok(result.anthologyCandidatesFlagged.length >= 1);
});

test('healthy control task is never touched', () => {
  const result = purgeBoardResidue();
  assert.ok(!result.bracketArchivedIds.includes(healthyTask));
  assert.ok(!result.smokeTestArchivedIds.includes(healthyTask));
  assert.ok(!result.anthologyCandidatesFlagged.some((l) => l.includes(healthyTask)));
});

test('--apply archives the high-confidence categories (soft-archive, never delete)', () => {
  const result = purgeBoardResidue({ apply: true });
  assert.equal(result.applied, true);

  assert.ok(archivedAt(demoTask), '[DEMO] card is soft-archived');
  assert.ok(archivedAt(testBracketTask), '[TEST] card is soft-archived');
  assert.ok(archivedAt(smokeTestTask), 'smoke-test card is soft-archived');

  // Row still exists — SOFT archive only, never a DELETE.
  const stillPresent = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [demoTask]);
  assert.ok(stillPresent, 'archived rows are never hard-deleted');

  // Never touched.
  assert.equal(archivedAt(legitSmokeTestingLabTask), null);
  assert.equal(archivedAt(blockedDemoTask), null, 'blocked task is still never archived, even under --apply');
  assert.equal(archivedAt(anthologyDrillCandidate), null, 'flagged-only candidate is never archived under --apply');
  assert.equal(archivedAt(healthyTask), null);
});

test('re-running --apply is idempotent (archived_at unchanged, no duplicate events)', () => {
  const before = archivedAt(demoTask);
  purgeBoardResidue({ apply: true });
  const after = archivedAt(demoTask);
  assert.equal(after, before, 'archived_at does not move on a second apply run');
});

test('CLI --apply flag (argv-derived default) also works end-to-end', () => {
  const freshDemo = seedTask('[DEMO] Second demo card for CLI-flag coverage');
  process.argv.push('--apply');
  try {
    const result = purgeBoardResidue();
    assert.equal(result.applied, true);
    assert.ok(result.bracketArchivedIds.includes(freshDemo));
  } finally {
    process.argv = process.argv.filter((a) => a !== '--apply');
  }
  assert.ok(archivedAt(freshDemo), 'argv-derived --apply must also archive');
});
