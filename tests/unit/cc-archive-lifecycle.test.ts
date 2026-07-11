/**
 * A8 — workspace/task ARCHIVE LIFECYCLE. Covers AUD-16 (C6) + AUD-46 (B8-guard).
 *
 * The two items share one story and one surface, so they share one test file.
 *
 * AUD-16 / C6 — THE ELIMINATE PATH.
 *   C1 (canonical_decline.py) taught the system to CLASSIFY a provenanced NO as
 *   "declined". Nothing ever CONSUMED that. A department the owner said NO to kept
 *   its workspace row and kept rendering as a live Kanban column — the board lied.
 *   ACCEPTANCE: seed 3 DECLINED department trees → their workspaces are
 *   SOFT-ARCHIVED, HIDDEN from the board, their rows are PRESERVED, and the
 *   `chosen == provisioned == displayed` converge assertion holds.
 *
 * AUD-46 / B8-guard — DELETE REQUIRES A PRIOR SOFT-ARCHIVE.
 *   Preventive, NOT the restore (that is a separate gated decision this touches in
 *   no way). It protects the operator's deliberately-clean board from the NEXT
 *   accidental hard purge.
 *   ACCEPTANCE: a hard DELETE issued WITHOUT a prior soft-archive is REJECTED.
 *
 * The board-hiding and the DELETE rejection are both proven through the REAL route
 * handlers (invoked with a real NextRequest), not through a re-description of them.
 */

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { getDb } from '../../src/lib/db';
import {
  DECLINED_REASON,
  archiveWorkspace,
  unarchiveWorkspace,
  isWorkspaceArchived,
  hasWorkspaceArchiveColumn,
  syncDeclinedWorkspaceArchive,
  assertConvergeParity,
  listProvisionedWorkspaceIds,
} from '../../src/lib/workspaces/archive';
import { listDisplayedWorkspaceIds, boardWhereClause } from '../../src/lib/workspaces/board-query';
import { TEST_RESIDUE_WORKSPACE_SLUGS } from '../../src/lib/test-residue';
import {
  assertArchivedBeforeHardDelete,
  HardDeleteWithoutArchiveError,
  isArchived,
} from '../../src/lib/delete-guard';
import { computeDecisionCoverage } from '../../src/lib/interview/seam';

import { GET as workspacesGET } from '../../src/app/api/workspaces/route';
import { DELETE as workspaceDELETE } from '../../src/app/api/workspaces/[id]/route';
import { POST as workspaceARCHIVE } from '../../src/app/api/workspaces/[id]/archive/route';
import { DELETE as taskDELETE } from '../../src/app/api/tasks/[id]/route';
import { POST as taskARCHIVE } from '../../src/app/api/tasks/[id]/archive/route';

/* ─────────────────────────────── fixtures ─────────────────────────────────── */

// 3 departments the owner CHOSE, 3 the owner DECLINED. Generic ids — no client or
// roster names anywhere in this fixture.
const CHOSEN = ['marketing', 'engineering', 'quality-control'];
const DECLINED = ['legal', 'logistics', 'facilities'];

function seedWorkspace(id: string) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO workspaces (id, name, slug, description, icon, company_id, sort_order)
       VALUES (?, ?, ?, ?, '📁', 'default', 100)`,
    )
    .run(id, `${id} department`, id, `${id} workspace`);
}

/** A fully-provenanced decision object — the shape record-dept-decision.sh writes. */
function provenanced(decision: 'yes' | 'no') {
  return {
    decision,
    source: 'owner-interview',
    decidedAt: '2026-07-11T00:00:00Z',
    decidedBy: 'owner@example.test',
    sessionId: 'session-1',
  };
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * Seed the 6 departments fresh (3 chosen + 3 declined), all un-archived.
 *
 * The boot auto-seed populates workspaces from departments.json and hangs trio
 * agents off them, so a bare `DELETE FROM workspaces` trips the agents/tasks
 * foreign keys. Drop the dependents first, with FK enforcement off for the reset
 * itself, then restore it — the guard under test depends on FKs being ON.
 */
function seedAllSix() {
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM agents').run();
  db.prepare('DELETE FROM workspaces').run();
  for (const id of [...CHOSEN, ...DECLINED]) seedWorkspace(id);
  db.pragma('foreign_keys = ON');
}

/* ══════════════════════ AUD-16 / C6 — soft-archive declined ═══════════════════ */

test('C6 pre-flight: migration 095 gave workspaces an archived_at column', () => {
  assert.ok(
    hasWorkspaceArchiveColumn(getDb()),
    'workspaces.archived_at must exist — without it the decline has nowhere to land',
  );
});

test('C6 ACCEPTANCE: 3 DECLINED dept trees → soft-archived, hidden from board, rows PRESERVED, parity holds', async () => {
  const db = getDb();
  seedAllSix();

  // Pre-state: all 6 provisioned, all 6 displayed. The board currently lies.
  assert.equal(listProvisionedWorkspaceIds(db).length, 6, 'all 6 seeded');
  assert.equal(listDisplayedWorkspaceIds(db, null).length, 6, 'all 6 on the board pre-decline');

  // ── The eliminate path: honor the 3 declines. ──
  const result = syncDeclinedWorkspaceArchive(db, DECLINED);

  assert.deepEqual(result.archived.sort(), [...DECLINED].sort(), 'exactly the 3 declined archived');
  assert.equal(result.unarchived.length, 0);
  assert.equal(result.noWorkspace.length, 0);

  // 1. SOFT-ARCHIVED — archived_at stamped, reason = 'declined'.
  for (const id of DECLINED) {
    const row = db
      .prepare('SELECT archived_at, archived_reason FROM workspaces WHERE id = ?')
      .get(id) as { archived_at: string | null; archived_reason: string | null };
    assert.ok(row.archived_at, `${id} must carry archived_at`);
    assert.equal(row.archived_reason, DECLINED_REASON, `${id} must be archived AS a decline`);
  }

  // 2. ROWS PRESERVED — soft, never hard. All 6 rows still exist.
  const total = (db.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number }).c;
  assert.equal(total, 6, 'ALL 6 rows must survive — a decline archives, it never deletes');

  // 3. HIDDEN FROM THE BOARD — through the REAL board query.
  const displayed = listDisplayedWorkspaceIds(db, null);
  assert.deepEqual(displayed.sort(), [...CHOSEN].sort(), 'board shows ONLY the chosen 3');
  for (const id of DECLINED) {
    assert.ok(!displayed.includes(id), `${id} must NOT be on the board`);
  }

  // 3b. HIDDEN THROUGH THE REAL ROUTE HANDLER (not a re-implementation of it).
  const res = await workspacesGET(new NextRequest('http://localhost/api/workspaces'));
  const body = (await res.json()) as { id: string }[];
  const ids = body.map((w) => w.id).sort();
  assert.deepEqual(ids, [...CHOSEN].sort(), 'GET /api/workspaces must hide the 3 declined');

  // 3c. ESCAPE HATCH — archived departments remain fully RETRIEVABLE.
  const resAll = await workspacesGET(
    new NextRequest('http://localhost/api/workspaces?includeArchived=true'),
  );
  const bodyAll = (await resAll.json()) as { id: string }[];
  assert.equal(bodyAll.length, 6, '?includeArchived=true returns all 6 — hidden, not gone');

  // 4. THE CONVERGE ASSERTION: chosen == provisioned == displayed.
  const parity = assertConvergeParity({
    chosen: CHOSEN,
    provisioned: listProvisionedWorkspaceIds(db),
    displayed: listDisplayedWorkspaceIds(db, null),
  });
  assert.equal(parity.ok, true, `parity must hold: ${JSON.stringify(parity)}`);
  assert.deepEqual(parity.unexpectedlyProvisioned, [], 'no declined dept may hold a lane');
  assert.deepEqual(parity.missingFromProvisioned, [], 'every chosen dept must have a lane');
  assert.deepEqual(parity.provisionedNotDisplayed, [], 'no live lane may be invisible');
  assert.deepEqual(parity.displayedNotProvisioned, [], 'no phantom column');
});

test('C6: the parity assertion FAILS LOUD when a declined dept still holds a lane (the gate is real)', () => {
  // A gate that cannot fail is not a gate. Prove it detects the exact bug C6 exists
  // to kill: 'legal' was declined, but its lane is still provisioned + displayed.
  const parity = assertConvergeParity({
    chosen: CHOSEN,
    provisioned: [...CHOSEN, 'legal'],
    displayed: [...CHOSEN, 'legal'],
  });
  assert.equal(parity.ok, false, 'parity MUST fail when a declined dept is still provisioned');
  assert.deepEqual(parity.unexpectedlyProvisioned, ['legal']);
});

test('C6: parity also catches a chosen dept with NO lane, and a phantom column', () => {
  const noLane = assertConvergeParity({
    chosen: CHOSEN,
    provisioned: ['marketing', 'engineering'],
    displayed: ['marketing', 'engineering'],
  });
  assert.equal(noLane.ok, false);
  assert.deepEqual(noLane.missingFromProvisioned, ['quality-control']);

  const phantom = assertConvergeParity({
    chosen: CHOSEN,
    provisioned: CHOSEN,
    displayed: [...CHOSEN, 'ghost-dept'],
  });
  assert.equal(phantom.ok, false);
  assert.deepEqual(phantom.displayedNotProvisioned, ['ghost-dept']);
});

test('C6: the archive is IDEMPOTENT — a second converge changes nothing', () => {
  const db = getDb();
  seedAllSix();

  const first = syncDeclinedWorkspaceArchive(db, DECLINED);
  assert.equal(first.archived.length, 3);

  const stamps = DECLINED.map(
    (id) =>
      (db.prepare('SELECT archived_at FROM workspaces WHERE id = ?').get(id) as {
        archived_at: string;
      }).archived_at,
  );

  const second = syncDeclinedWorkspaceArchive(db, DECLINED);
  assert.equal(second.archived.length, 0, 'second run archives nothing new');
  assert.deepEqual(second.alreadyArchived.sort(), [...DECLINED].sort());

  // The original timestamps survive — re-archiving must never rewrite history to a
  // fresher, less honest time.
  const stamps2 = DECLINED.map(
    (id) =>
      (db.prepare('SELECT archived_at FROM workspaces WHERE id = ?').get(id) as {
        archived_at: string;
      }).archived_at,
  );
  assert.deepEqual(stamps2, stamps, 'archived_at must not be restamped');
});

test('C6: owner flips NO → YES → the department comes BACK (soft-archive is reversible)', () => {
  const db = getDb();
  seedAllSix();

  syncDeclinedWorkspaceArchive(db, DECLINED);
  assert.ok(isWorkspaceArchived(db, 'legal'));

  // 'legal' is no longer declined — the owner changed their mind.
  const flipped = syncDeclinedWorkspaceArchive(db, ['logistics', 'facilities']);
  assert.deepEqual(flipped.unarchived, ['legal'], 'legal must be un-archived');
  assert.equal(isWorkspaceArchived(db, 'legal'), false);
  assert.ok(listDisplayedWorkspaceIds(db, null).includes('legal'), 'legal back on the board');

  // ...and the other two stay archived.
  assert.ok(isWorkspaceArchived(db, 'logistics'));
  assert.ok(isWorkspaceArchived(db, 'facilities'));
});

test('C6: a converge NEVER un-archives an OPERATOR archive (reason-scoped reversal)', () => {
  const db = getDb();
  seedAllSix();

  // The operator manually archives a department that was never declined.
  archiveWorkspace(db, 'marketing', 'operator');
  assert.ok(isWorkspaceArchived(db, 'marketing'));

  // A converge runs. 'marketing' is not in the declined set — but it must NOT be
  // resurrected, because the operator archived it for their own reasons.
  const r = syncDeclinedWorkspaceArchive(db, DECLINED);
  assert.ok(!r.unarchived.includes('marketing'), 'operator archive must survive converge');
  assert.equal(isWorkspaceArchived(db, 'marketing'), true);
});

test('C6: an UN-PROVENANCED "no" is a REJECTION, not a decline — it can never archive a department', () => {
  // Gate #8. A bare-string decline is a fabrication vector: it must never shrink the
  // floor. This is the provenance rule canonical_decline.py enforces, and the honored
  // declined set this feature consumes is derived from exactly this function.
  const coverage = computeDecisionCoverage(
    {
      canonicalReconciliation: {
        decisions: {
          legal: provenanced('no'), // honored decline
          logistics: 'no', // BARE STRING — un-provenanced
          facilities: { decision: 'no', source: 'owner-interview' }, // missing decidedAt/By
          marketing: provenanced('yes'),
        },
      },
    } as never,
    [],
  );

  assert.deepEqual(coverage.declined, ['legal'], 'ONLY the provenanced NO is an honored decline');
  assert.deepEqual(
    coverage.rejections.sort(),
    ['facilities', 'logistics'],
    'un-provenanced NOs are rejections — they must NOT archive anything',
  );

  // And prove the consequence end-to-end: feeding the honored set archives ONLY legal.
  const db = getDb();
  seedAllSix();
  syncDeclinedWorkspaceArchive(db, coverage.declined);

  assert.ok(isWorkspaceArchived(db, 'legal'));
  assert.equal(isWorkspaceArchived(db, 'logistics'), false, 'bare-string NO must not archive');
  assert.equal(isWorkspaceArchived(db, 'facilities'), false, 'partial-provenance NO must not archive');
});

test('C6: board WHERE clause composes correctly with AND without a company scope', () => {
  // The trap this guards: concatenating a bare `AND …` onto an ABSENT WHERE.
  const RESIDUE = [...TEST_RESIDUE_WORKSPACE_SLUGS];

  const unbranded = boardWhereClause(null);
  assert.ok(unbranded.sql.startsWith('WHERE'), 'must still emit a WHERE for the archive filter');
  assert.ok(unbranded.sql.includes('archived_at IS NULL'));
  assert.deepEqual(unbranded.params, RESIDUE);

  const branded = boardWhereClause('acme');
  assert.ok(branded.sql.includes('company_id'));
  assert.ok(branded.sql.includes('AND w.archived_at IS NULL'));
  assert.deepEqual(branded.params, ['acme', ...RESIDUE]);

  const all = boardWhereClause('acme', { includeArchived: true });
  assert.ok(!all.sql.includes('archived_at'), 'escape hatch drops the archive filter');
});

test('C8 survives the C6 refactor: residue slugs are excluded UNCONDITIONALLY', () => {
  // Regression guard for the cc-c8-c10 <-> cc-archive-lifecycle merge. C8's
  // fixture-residue exclusion used to live in an inline `companyScopeClause` in
  // /api/workspaces. C6 REPLACED that function with the shared `boardWhereClause`,
  // which would have SILENTLY DROPPED the C8 filter had it not been folded in.
  // Residue is never legitimately viewable, so `includeArchived` must NOT expose it.
  for (const clause of [
    boardWhereClause(null),
    boardWhereClause('acme'),
    boardWhereClause('acme', { includeArchived: true }),
    boardWhereClause(null, { includeArchived: true }),
  ]) {
    assert.ok(clause.sql.includes('w.slug NOT IN'), 'residue exclusion must always be present');
    for (const slug of TEST_RESIDUE_WORKSPACE_SLUGS) {
      assert.ok(clause.params.includes(slug), `residue slug ${slug} must be bound`);
    }
  }
});

/* ═══════════════ AUD-46 / B8 — hard DELETE requires a soft-archive ════════════ */

function seedTask(id: string): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO tasks (id, title, description, status, priority, workspace_id, business_id)
       VALUES (?, ?, 'x', 'backlog', 'medium', 'marketing', 'default')`,
    )
    .run(id, `task ${id}`);
}

test('B8 ACCEPTANCE: hard DELETE /api/tasks/[id] WITHOUT a prior soft-archive is REJECTED (409)', async () => {
  const db = getDb();
  seedAllSix();
  seedTask('t-guard-1');

  assert.equal(isArchived(db, 'tasks', 't-guard-1'), false, 'task starts un-archived');

  const res = await taskDELETE(
    new NextRequest('http://localhost/api/tasks/t-guard-1', { method: 'DELETE' }),
    ctx('t-guard-1'),
  );

  assert.equal(res.status, 409, 'un-archived hard DELETE must be REFUSED with 409');
  const body = (await res.json()) as { error: string; remedy: string };
  assert.equal(body.error, 'hard_delete_requires_soft_archive');
  assert.ok(body.remedy.includes('archive'), 'the refusal must tell the caller how to proceed');

  // THE ROW SURVIVED. This is the whole point — the purge did not happen.
  const still = db.prepare('SELECT id FROM tasks WHERE id = ?').get('t-guard-1');
  assert.ok(still, 'the task MUST still exist after the refused delete');
});

test('B8: soft-archive FIRST, then the same hard DELETE is PERMITTED (the gate is passable)', async () => {
  const db = getDb();
  seedAllSix();
  seedTask('t-guard-2');

  // Step 1 — soft-archive through the real archive route.
  const archRes = await taskARCHIVE(
    new NextRequest('http://localhost/api/tasks/t-guard-2/archive', { method: 'POST' }),
    ctx('t-guard-2'),
  );
  assert.equal(archRes.status, 200);
  assert.equal(isArchived(db, 'tasks', 't-guard-2'), true, 'now soft-archived');

  // The archived card is off the board but the row is intact.
  assert.ok(db.prepare('SELECT id FROM tasks WHERE id = ?').get('t-guard-2'));

  // Step 2 — NOW the hard delete is allowed.
  const delRes = await taskDELETE(
    new NextRequest('http://localhost/api/tasks/t-guard-2', { method: 'DELETE' }),
    ctx('t-guard-2'),
  );
  assert.equal(delRes.status, 200, 'an ARCHIVED task may be hard-deleted');
  assert.equal(
    db.prepare('SELECT id FROM tasks WHERE id = ?').get('t-guard-2'),
    undefined,
    'row is gone after the deliberate two-step',
  );
});

test('B8 ACCEPTANCE: hard DELETE /api/workspaces/[id] WITHOUT a prior soft-archive is REJECTED (409)', async () => {
  const db = getDb();
  seedAllSix();
  // The workspace DELETE route refuses any workspace holding tasks/agents, so use a
  // clean one — this isolates the ARCHIVE guard as the thing doing the rejecting.
  db.prepare('DELETE FROM tasks WHERE workspace_id = ?').run('facilities');

  const res = await workspaceDELETE(
    new NextRequest('http://localhost/api/workspaces/facilities', { method: 'DELETE' }),
    ctx('facilities'),
  );

  assert.equal(res.status, 409, 'un-archived workspace hard DELETE must be REFUSED');
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'hard_delete_requires_soft_archive');

  assert.ok(
    db.prepare('SELECT id FROM workspaces WHERE id = ?').get('facilities'),
    'the workspace MUST survive the refused delete',
  );
});

test('B8: workspace archive → then hard DELETE is PERMITTED', async () => {
  const db = getDb();
  seedAllSix();
  db.prepare('DELETE FROM tasks WHERE workspace_id = ?').run('facilities');
  db.prepare('DELETE FROM agents WHERE workspace_id = ?').run('facilities');

  const archRes = await workspaceARCHIVE(
    new NextRequest('http://localhost/api/workspaces/facilities/archive', { method: 'POST' }),
    ctx('facilities'),
  );
  assert.equal(archRes.status, 200);
  assert.ok(isWorkspaceArchived(db, 'facilities'));

  const delRes = await workspaceDELETE(
    new NextRequest('http://localhost/api/workspaces/facilities', { method: 'DELETE' }),
    ctx('facilities'),
  );
  assert.equal(delRes.status, 200, 'an ARCHIVED workspace may be hard-deleted');
  assert.equal(db.prepare('SELECT id FROM workspaces WHERE id = ?').get('facilities'), undefined);
});

test('B8: the guard throws HardDeleteWithoutArchiveError at the library chokepoint', () => {
  const db = getDb();
  seedAllSix();
  seedTask('t-guard-3');

  assert.throws(
    () => assertArchivedBeforeHardDelete(db, 'tasks', 't-guard-3'),
    (err: unknown) => {
      assert.ok(err instanceof HardDeleteWithoutArchiveError);
      assert.equal(err.code, 'hard_delete_requires_soft_archive');
      assert.equal(err.table, 'tasks');
      assert.equal(err.rowId, 't-guard-3');
      return true;
    },
  );

  // After a soft-archive it stops throwing.
  db.prepare("UPDATE tasks SET archived_at = datetime('now') WHERE id = ?").run('t-guard-3');
  assert.doesNotThrow(() => assertArchivedBeforeHardDelete(db, 'tasks', 't-guard-3'));
});

test('B8: the guard FAILS CLOSED when the table has no archived_at column', async () => {
  // A gate that fails open is not a gate. On a DB that cannot PROVE a soft-archive
  // happened, the delete is REFUSED — not waved through.
  const Database = (await import('better-sqlite3')).default;
  const bare = new Database(':memory:');
  bare.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT)');
  bare.prepare("INSERT INTO tasks (id, title) VALUES ('x', 'no archive column here')").run();

  assert.throws(
    () => assertArchivedBeforeHardDelete(bare, 'tasks', 'x'),
    (err: unknown) => {
      assert.ok(err instanceof HardDeleteWithoutArchiveError);
      assert.match(err.message, /no tasks\.archived_at column/);
      return true;
    },
    'a pre-migration DB must REFUSE the delete, never silently purge',
  );
  bare.close();
});

test('B8: a SANCTIONED internal reaper may hard-delete without an archive (named + closed set)', () => {
  const db = getDb();
  seedAllSix();
  seedTask('t-dupe');

  // The de-dup reaper collapses duplicate rows onto a survivor — no unique work dies.
  // The bypass must be EXPLICIT and NAMED, never implicit.
  assert.doesNotThrow(() =>
    assertArchivedBeforeHardDelete(db, 'tasks', 't-dupe', {
      sanctionedReason: 'duplicate-row-reaper',
    }),
  );

  // An INVENTED reason is refused — the union is closed, so no ad-hoc bypass exists.
  assert.throws(
    () =>
      assertArchivedBeforeHardDelete(db, 'tasks', 't-dupe', {
        sanctionedReason: 'because-i-said-so' as never,
      }),
    HardDeleteWithoutArchiveError,
  );
});

test('B8: deleting a row that does not exist is a permitted no-op (nothing to destroy)', () => {
  assert.doesNotThrow(() =>
    assertArchivedBeforeHardDelete(getDb(), 'tasks', 'does-not-exist-anywhere'),
  );
});

test('B8: archive/unarchive round-trip preserves the workspace row', () => {
  const db = getDb();
  seedAllSix();

  assert.equal(archiveWorkspace(db, 'legal', DECLINED_REASON), true);
  assert.equal(archiveWorkspace(db, 'legal', DECLINED_REASON), false, 'idempotent');
  assert.ok(db.prepare('SELECT id FROM workspaces WHERE id = ?').get('legal'), 'row preserved');

  assert.equal(unarchiveWorkspace(db, 'legal'), true);
  assert.equal(unarchiveWorkspace(db, 'legal'), false, 'idempotent');
  assert.equal(isWorkspaceArchived(db, 'legal'), false);
});
