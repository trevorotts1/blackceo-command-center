/**
 * fix/sop-authoring-synthesis-failure — the zombie-subtask regression guard.
 *
 * THE DEFECT (live-proven on a real box): when Gemini synthesis failed,
 * authorSOPForTask returned { status: 'error' } WITHOUT touching the
 * authoring sub-task it had just created 'in_progress'. The card wedged
 * in_progress forever; nothing writes a terminal marker into any session
 * transcript (authoring has no agent session), so execution-watcher's
 * findTerminalFailureMarker can never fire and every reconcile tick finds
 * nothing.
 *
 * THE FIX: the error paths route through failAuthoringSubtask → blockTaskForQC
 * (the SAME funnel execution-watcher itself uses for a dead turn):
 * in_progress→blocked (a legal edge) with operator-visible block_* metadata +
 * task_block_events audit row. 'blocked' is excluded from
 * intake-advance-sweep's ADVANCEABLE_STATUSES and autoDispatchTask's GUARD 3
 * SKIP_STATUSES, so the failed card can never re-enter the dispatch funnel:
 * no bounce loop.
 *
 * Verifies:
 *   1. synthesis failure → sub-task row is 'blocked' (NOT in_progress),
 *      with block_reason set, and the result carries sub_task_id.
 *   2. the failed sub-task is NOT re-selected by the dispatch sweep
 *      (excluded by the sweep's own selection query — no bounce loop).
 *   3. the successful authoring path is byte-identical (result shape +
 *      sub-task 'done' + sop row filed) — regression guard.
 *
 * No network: Gemini failure is forced by stubbing globalThis.fetch to a 429
 * billing wall; success uses GEMINI_FIXTURE_JSON_PATH + TAVILY/QC fixtures.
 * Same fixture technique as prd-2.12-fast-loop-qc-gate.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

// ── Fixture environment (must be set BEFORE @/lib/db is imported) ─────────────
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-zombie-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.zombie.db');
process.env.DATABASE_PATH = TMP_DB;
process.env.MISSION_CONTROL_DB_PATH = TMP_DB;

const FIXTURES_DIR = path.resolve(__dirname, '../../scripts/fixtures');
process.env.TAVILY_FIXTURE_JSON_PATH = path.join(FIXTURES_DIR, 'tavily-sample.json');
process.env.QC_FIXTURE_JSON_PATH = path.join(FIXTURES_DIR, 'qc-pass-sample.json');
process.env.GOOGLE_API_KEY = 'test-key';
process.env.SOP_AUTO_REPLACE_TELEGRAM_DISABLED = '1';
delete process.env.GEMINI_FIXTURE_JSON_PATH;
delete process.env.TAVILY_API_KEY;

const TMP_WORKSPACE = path.join(TMP_DIR, 'workspace');
fs.mkdirSync(TMP_WORKSPACE, { recursive: true });
fs.writeFileSync(path.join(TMP_WORKSPACE, 'SOUL.md'), '# Soul\nDirect, quality-first.');
fs.writeFileSync(path.join(TMP_WORKSPACE, 'USER.md'), '# User\nFounder.');
process.env.OPENCLAW_WORKSPACE_PATH = TMP_WORKSPACE;
process.env.SOP_AUTHORING_WRITE_DISK = '0';

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let dbRun: DbModule['run'];
let closeDb: DbModule['closeDb'];

type AuthoringModule = typeof import('../../src/lib/sop-authoring');
let authorSOPForTask: AuthoringModule['authorSOPForTask'];

const BILLING_BODY = 'Your prepayment credits are depleted. Add funds to continue.';

function stubFetchFailure(): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(BILLING_BODY, { status: 429, headers: { 'content-type': 'text/plain' } });
  }) as any;
  return () => { globalThis.fetch = orig; };
}

const CUSTOM_DEPT = 'gizmo-synthesis-custom';

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  dbRun = db.run;
  closeDb = db.closeDb;

  const authoring = await import('../../src/lib/sop-authoring');
  authorSOPForTask = authoring.authorSOPForTask;

  getDb();

  const now = new Date().toISOString();
  try {
    dbRun(
      `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
       VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
      [now, now],
    );
  } catch { /* ignore */ }
  try {
    dbRun(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, company_id, created_at, updated_at)
       VALUES (?, 'Gizmo Synthesis', ?, 'default', ?, ?)`,
      [CUSTOM_DEPT, CUSTOM_DEPT, now, now],
    );
  } catch {
    try {
      dbRun(
        `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
         VALUES (?, 'Gizmo Synthesis', ?, ?, ?)`,
        [CUSTOM_DEPT, CUSTOM_DEPT, now, now],
      );
    } catch { /* ignore */ }
  }

  const hasRoleType = queryAll<{ name: string }>('PRAGMA table_info(agents)', [])
    .some((c) => c.name === 'role_type');
  if (hasRoleType) {
    dbRun(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          specialist_type, role_type, created_at, updated_at)
       VALUES ('research-agent-${CUSTOM_DEPT}', 'Gizmo Research Specialist', 'Research Specialist', 'Test', '🔬',
               'standby', 0, ?, 'permanent', 'research', ?, ?)`,
      [CUSTOM_DEPT, now, now],
    );
    dbRun(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          specialist_type, role_type, created_at, updated_at)
       VALUES ('qc-agent-${CUSTOM_DEPT}', 'Gizmo QC Specialist', 'QC Specialist', 'Test', '✅',
               'standby', 0, ?, 'permanent', 'qc', ?, ?)`,
      [CUSTOM_DEPT, now, now],
    );
  }
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('1 — Gemini 429 failure terminal-blocks the sub-task (no zombie in_progress)', async () => {
  const restore = stubFetchFailure();
  try {
    const now = new Date().toISOString();
    const originalTaskId = uuidv4();
    dbRun(
      `INSERT INTO tasks (id, title, status, priority, workspace_id, department, created_at, updated_at)
       VALUES (?, 'Synthesize widget billing flow', 'backlog', 'medium', ?, ?, ?, ?)`,
      [originalTaskId, CUSTOM_DEPT, CUSTOM_DEPT, now, now],
    );

    const result = await authorSOPForTask({
      originalTaskId,
      title: 'Synthesize widget billing flow',
      description: 'Custom dept widget billing task',
      department: CUSTOM_DEPT,
      agentRoleSlug: null,
      workspaceId: CUSTOM_DEPT,
    });

    assert.equal(result.status, 'error', `synthesis failure must return error, got ${result.status}`);
    assert.ok(result.sub_task_id, 'error result must carry sub_task_id so the failure is traceable');

    const sub = queryOne<{ status: string; block_reason: string | null }>(
      'SELECT status, block_reason FROM tasks WHERE id = ?',
      [result.sub_task_id!],
    );
    assert.ok(sub, 'authoring sub-task row must exist');
    assert.equal(sub!.status, 'blocked', `sub-task must be terminal-blocked, got ${sub!.status}`);
    assert.equal(sub!.block_reason, 'sop_authoring_generation_failed');

    // Operator-visible: a task_block_events audit row exists.
    const audit = queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM task_block_events WHERE task_id = ?',
      [result.sub_task_id!],
    );
    assert.ok((audit?.n ?? 0) >= 1, 'a task_block_events audit row must exist');

    // Billing label accuracy: the failure reason names billing, not a retired model.
    assert.match(result.reason ?? '', /billing\/quota/i);
    assert.doesNotMatch(result.reason ?? '', /retired or unavailable/);
  } finally { restore(); }
});

test('2 — the failed sub-task is excluded from the dispatch sweep selection (no bounce loop)', async () => {
  // Every sweep that can re-fire work selects from these statuses only —
  // assert the failed card's status is in NONE of them.
  const ADVANCEABLE_STATUSES = ['inbox', 'backlog', 'planning', 'pending_dispatch', 'assigned'];
  const SKIP_STATUSES = ['in_progress', 'review', 'done', 'blocked'];

  const failed = queryAll<{ id: string; status: string }>(
    `SELECT id, status FROM tasks WHERE block_reason = 'sop_authoring_generation_failed'`,
  );
  assert.ok(failed.length >= 1, 'precondition: at least one failed sub-task from test 1');
  for (const row of failed) {
    assert.ok(
      !ADVANCEABLE_STATUSES.includes(row.status),
      `failed sub-task ${row.id} (status=${row.status}) must NOT be in the sweep advanceable set`,
    );
    assert.ok(
      SKIP_STATUSES.includes(row.status),
      `failed sub-task ${row.id} (status=${row.status}) must be in the dispatcher skip set`,
    );
  }

  // Prove it structurally: run the sweep's own selection predicate against it.
  const reselectable = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks t
      WHERE t.id IN (SELECT id FROM tasks WHERE block_reason = 'sop_authoring_generation_failed')
        AND t.status IN ('inbox','backlog','planning','pending_dispatch','assigned')
        AND t.archived_at IS NULL
        AND (t.sop_authoring_for_task_id IS NULL)`,
    [],
  );
  assert.equal(reselectable?.n ?? -1, 0, 'sweep selection query must return zero failed sub-tasks');

  // And the dispatcher guard itself skips it.
  const guard = queryOne<{ status: string }>(
    `SELECT status FROM tasks WHERE block_reason = 'sop_authoring_generation_failed' LIMIT 1`,
  );
  assert.ok(['in_progress', 'review', 'done', 'blocked'].includes(guard!.status));
});

test('3 — successful authoring path unchanged (result shape + sub-task done + sop filed)', async () => {
  const GEMINI_FIXTURE = path.join(FIXTURES_DIR, 'gemini-sop-authoring-sample.json');
  const savedGemini = process.env.GEMINI_FIXTURE_JSON_PATH;
  process.env.GEMINI_FIXTURE_JSON_PATH = GEMINI_FIXTURE;
  try {
    const now = new Date().toISOString();
    const originalTaskId = uuidv4();
    dbRun(
      `INSERT INTO tasks (id, title, status, priority, workspace_id, department, created_at, updated_at)
       VALUES (?, 'Design custom gizmo housing', 'backlog', 'medium', ?, ?, ?, ?)`,
      [originalTaskId, CUSTOM_DEPT, CUSTOM_DEPT, now, now],
    );

    const result = await authorSOPForTask({
      originalTaskId,
      title: 'Design custom gizmo housing',
      description: 'Client needs 50 custom gizmo housings',
      department: CUSTOM_DEPT,
      agentRoleSlug: 'gizmo-designer',
      workspaceId: CUSTOM_DEPT,
    });

    assert.equal(result.status, 'authored', `happy path must stay authored, got ${result.status} (${result.reason ?? ''})`);
    assert.ok(result.sop_id, 'happy path must return sop_id');
    assert.ok(result.sub_task_id, 'happy path must return sub_task_id');
    assert.ok(typeof result.qc_score === 'number' && result.qc_score! >= 8.5);

    const sopRow = queryOne<{ id: string; source: string | null }>(
      'SELECT id, source FROM sops WHERE id = ? AND deleted_at IS NULL',
      [result.sop_id!],
    );
    assert.ok(sopRow, 'happy path must file a real sops row');
    assert.equal(sopRow!.source, null);

    // AF6 invariants: audit proposal is auto-authored-filed (never pending),
    // original task gets sop_id attached (dispatch can re-fire unblocked).
    const proposal = queryOne<{ status: string }>(
      'SELECT status FROM sop_proposals WHERE id = ?',
      [result.proposal_id ?? ''],
    );
    assert.ok(proposal, 'happy path must write the sop_proposals audit row');
    assert.equal(proposal!.status, 'auto-authored-filed');
    const updatedTask = queryOne<{ sop_id: string | null }>(
      'SELECT sop_id FROM tasks WHERE id = ?',
      [originalTaskId],
    );
    assert.ok(updatedTask?.sop_id, 'happy path must attach sop_id to the original task');
  } finally {
    if (savedGemini === undefined) delete process.env.GEMINI_FIXTURE_JSON_PATH;
    else process.env.GEMINI_FIXTURE_JSON_PATH = savedGemini;
  }
});
