/**
 * T0-01 follow-through — the SOP-authoring sub-task completes UNDER the
 * completion-evidence gate, not around it.
 *
 * ── WHAT THIS FILE PROVES ─────────────────────────────────────────────────────
 * PR #228 installed the completion-evidence precondition (src/lib/completion-
 * evidence.ts) in `transition()` and in the PATCH route, and named ONE remaining
 * writer of `status='done'` that did not pass through it: the raw
 * `UPDATE tasks SET status='done'` in src/lib/sop-authoring.ts, which completes
 * the pipeline's own synthetic "Author SOP" sub-task. It was scoped out because
 * that sub-task had no registered deliverable — NOT because it was safe.
 *
 * These tests assert the rule, not the mechanism:
 *
 *   1. On the happy path the authoring sub-task reaches `done` AND carries a
 *      registered, REACHABLE deliverable (the how-to.md it wrote). Before the fix
 *      it reached `done` with ZERO deliverable rows — a durable completion record
 *      with nothing behind it. This assertion therefore fails on unfixed code.
 *
 *   2. When the SOP file does NOT land (SOP_AUTHORING_WRITE_DISK='0', or an
 *      unwritable workspace), the sub-task is NOT marked done. Before the fix it
 *      was marked done unconditionally — the exact false-completion the gate
 *      exists to prevent. This assertion also fails on unfixed code.
 *      Authoring itself must still succeed (`status: 'authored'`, real sops row):
 *      holding the sub-task card must not block the SOP.
 *
 *   3. The whole-DB invariant: EVERY task row that reads `done` has evidence.
 *      This is the claim the gate makes; it is asserted over the tasks this file
 *      actually produced through the real code path.
 *
 * FALSIFICATION NOTE: each assertion above was run against unfixed origin/main
 * first and observed to FAIL there (tests 1 and 2 both fail; test 3 fails).
 * An assertion that passes against both the broken and the fixed code proves
 * nothing, so none of these are phrased as "the write is guarded" — they are
 * phrased as observable facts about the rows the pipeline leaves behind.
 *
 * Run: node --import tsx --test tests/unit/t0-sop-authoring-completion-evidence.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

// ── Fixture environment (must be set BEFORE @/lib/db is imported) ─────────────
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-t0-sop-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.t0sop.db');
process.env.DATABASE_PATH = TMP_DB;
process.env.MISSION_CONTROL_DB_PATH = TMP_DB;

const FIXTURES_DIR = path.resolve(__dirname, '../../scripts/fixtures');
process.env.TAVILY_FIXTURE_JSON_PATH = path.join(FIXTURES_DIR, 'tavily-sample.json');
process.env.GEMINI_FIXTURE_JSON_PATH = path.join(FIXTURES_DIR, 'gemini-sop-authoring-sample.json');
process.env.QC_FIXTURE_JSON_PATH = path.join(FIXTURES_DIR, 'qc-pass-sample.json');
process.env.SOP_AUTO_REPLACE_TELEGRAM_DISABLED = '1';

const TMP_WORKSPACE = path.join(TMP_DIR, 'workspace');
fs.mkdirSync(TMP_WORKSPACE, { recursive: true });
fs.writeFileSync(path.join(TMP_WORKSPACE, 'SOUL.md'), '# Soul\nDirect, quality-first. Custom accessory business.');
fs.writeFileSync(path.join(TMP_WORKSPACE, 'USER.md'), '# User\nFounder. Hates wasted tokens.');
process.env.OPENCLAW_WORKSPACE_PATH = TMP_WORKSPACE;
process.env.SOP_AUTHORING_WRITE_DISK = '1';

delete process.env.DISABLE_SOP_FAST_LOOP;

// ── Module bindings (populated in before()) ───────────────────────────────────

type DbModule = typeof import('../../src/lib/db');
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let dbRun: DbModule['run'];
let closeDb: DbModule['closeDb'];

type AuthoringModule = typeof import('../../src/lib/sop-authoring');
let authorSOPForTask: AuthoringModule['authorSOPForTask'];

type EvidenceModule = typeof import('../../src/lib/completion-evidence');
let collectCompletionEvidence: EvidenceModule['collectCompletionEvidence'];

const CUSTOM_DEPT = 'lampshade-restoration';
let researchAgentId: string;
let qcAgentId: string;

test.before(async () => {
  const db = await import('../../src/lib/db');
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  dbRun = db.run;
  closeDb = db.closeDb;

  const authoring = await import('../../src/lib/sop-authoring');
  authorSOPForTask = authoring.authorSOPForTask;

  const evidence = await import('../../src/lib/completion-evidence');
  collectCompletionEvidence = evidence.collectCompletionEvidence;

  db.getDb(); // run the migration chain

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
       VALUES (?, 'Lampshade Restoration', ?, 'default', ?, ?)`,
      [CUSTOM_DEPT, CUSTOM_DEPT, now, now],
    );
  } catch {
    try {
      dbRun(
        `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
         VALUES (?, 'Lampshade Restoration', ?, ?, ?)`,
        [CUSTOM_DEPT, CUSTOM_DEPT, now, now],
      );
    } catch { /* ignore */ }
  }

  researchAgentId = `research-agent-${CUSTOM_DEPT}`;
  qcAgentId = `qc-agent-${CUSTOM_DEPT}`;

  const hasRoleType = queryAll<{ name: string }>('PRAGMA table_info(agents)', [])
    .some((c) => c.name === 'role_type');

  if (hasRoleType) {
    try {
      dbRun(
        `INSERT OR IGNORE INTO agents
           (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
            specialist_type, role_type, created_at, updated_at)
         VALUES (?, 'Lampshade Research Specialist', 'Research Specialist', 'Test', '🔬',
                 'standby', 0, ?, 'permanent', 'research', ?, ?)`,
        [researchAgentId, CUSTOM_DEPT, now, now],
      );
      dbRun(
        `INSERT OR IGNORE INTO agents
           (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
            specialist_type, role_type, created_at, updated_at)
         VALUES (?, 'Lampshade QC Specialist', 'QC Specialist', 'Test', '✅',
                 'standby', 0, ?, 'permanent', 'qc', ?, ?)`,
        [qcAgentId, CUSTOM_DEPT, now, now],
      );
    } catch { /* ignore */ }
  } else {
    try {
      dbRun(
        `INSERT OR IGNORE INTO agents
           (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
            specialist_type, created_at, updated_at)
         VALUES (?, 'Lampshade Research Specialist', 'Research Specialist', 'Test', '🔬',
                 'standby', 0, ?, 'permanent', ?, ?)`,
        [researchAgentId, CUSTOM_DEPT, now, now],
      );
    } catch { /* ignore */ }
  }
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Seed a backlog task and run the authoring fast loop against it. */
async function authorFor(title: string, roleSlug: string) {
  const now = new Date().toISOString();
  const originalTaskId = uuidv4();
  dbRun(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, department, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', ?, ?, ?, ?)`,
    [originalTaskId, title, CUSTOM_DEPT, CUSTOM_DEPT, now, now],
  );
  const result = await authorSOPForTask({
    originalTaskId,
    title,
    description: `${title} — fixture-backed authoring run`,
    department: CUSTOM_DEPT,
    agentRoleSlug: roleSlug,
    workspaceId: CUSTOM_DEPT,
  });
  return { originalTaskId, result };
}

// ── Test 1 ────────────────────────────────────────────────────────────────────

test('1 — a done authoring sub-task carries registered, reachable completion evidence', async () => {
  const { result } = await authorFor(
    'Restore a mid-century fiberglass lampshade for a client showroom',
    'lampshade-restorer',
  );

  assert.equal(
    result.status,
    'authored',
    `authoring must still succeed on the happy path, got: ${result.status} (${result.reason ?? ''})`,
  );
  assert.ok(result.sub_task_id, 'authoring must return the sub_task_id it created');

  const subTaskId = result.sub_task_id!;
  const sub = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [subTaskId]);
  assert.ok(sub, 'the authoring sub-task row must exist');

  assert.equal(
    sub!.status,
    'done',
    `on the happy path (SOP file written) the sub-task must complete, got: ${sub!.status}`,
  );

  // THE POINT. Before the fix this sub-task reached `done` with ZERO rows here.
  const rows = queryAll<{ deliverable_type: string; path: string | null }>(
    'SELECT deliverable_type, path FROM task_deliverables WHERE task_id = ?',
    [subTaskId],
  );
  assert.ok(
    rows.length > 0,
    'a done authoring sub-task must have at least one registered deliverable — ' +
    'the SOP file it wrote. Zero rows means `done` was written with no evidence, ' +
    'which is the exact defect the completion-evidence gate exists to stop.',
  );

  const ev = collectCompletionEvidence(subTaskId);
  assert.equal(
    ev.hasEvidence,
    true,
    `the registered deliverable must be REACHABLE (existing, non-empty file or valid url). ` +
    `problems: ${ev.problems.join('; ') || '(none reported)'}`,
  );

  // The registered path must be the SOP file that was actually written.
  const filePath = rows[0].path!;
  assert.ok(
    fs.existsSync(filePath) && fs.statSync(filePath).size > 0,
    `the registered deliverable path must exist and be non-empty on disk: ${filePath}`,
  );
  assert.ok(
    filePath.startsWith(TMP_WORKSPACE),
    `the deliverable must point at the SOP the run wrote inside the workspace, got: ${filePath}`,
  );
});

// ── Test 2 ────────────────────────────────────────────────────────────────────

test('2 — no SOP file on disk → sub-task is NOT marked done (gate holds, authoring still succeeds)', async () => {
  const prev = process.env.SOP_AUTHORING_WRITE_DISK;
  process.env.SOP_AUTHORING_WRITE_DISK = '0'; // the file never lands
  let result: Awaited<ReturnType<typeof authorFor>>['result'];
  try {
    ({ result } = await authorFor(
      'Rewire a 1960s brass floor lamp harp assembly',
      'lamp-rewirer',
    ));
  } finally {
    if (prev === undefined) delete process.env.SOP_AUTHORING_WRITE_DISK;
    else process.env.SOP_AUTHORING_WRITE_DISK = prev;
  }

  // Authoring itself must NOT be blocked by the held sub-task card.
  assert.equal(
    result.status,
    'authored',
    `holding the sub-task must not block authoring, got: ${result.status} (${result.reason ?? ''})`,
  );
  assert.ok(result.sop_id, 'the sops row must still be filed when the sub-task is held');
  const sopRow = queryOne<{ id: string }>(
    'SELECT id FROM sops WHERE id = ? AND deleted_at IS NULL',
    [result.sop_id!],
  );
  assert.ok(sopRow, 'the authored SOP must still exist in the sops table');

  assert.ok(result.sub_task_id, 'authoring must return the sub_task_id it created');
  const subTaskId = result.sub_task_id!;

  const ev = collectCompletionEvidence(subTaskId);
  assert.equal(
    ev.hasEvidence,
    false,
    'precondition of this test: with the disk write disabled there is no reachable deliverable',
  );

  const sub = queryOne<{ status: string; completed_at: string | null }>(
    'SELECT status, completed_at FROM tasks WHERE id = ?',
    [subTaskId],
  );
  assert.ok(sub, 'the authoring sub-task row must exist');
  assert.notEqual(
    sub!.status,
    'done',
    'with NO completion evidence the authoring sub-task must not be recorded done. ' +
    'A `done` row plus its task_completed event is durable evidence the work landed; ' +
    'writing it for a SOP file that was never produced is a false completion.',
  );
  assert.equal(
    sub!.completed_at,
    null,
    'a held sub-task must not carry a completed_at stamp',
  );
});

// ── Test 3 ────────────────────────────────────────────────────────────────────

test('3 — invariant: every task this pipeline left in `done` has completion evidence', () => {
  const doneTasks = queryAll<{ id: string; title: string }>(
    "SELECT id, title FROM tasks WHERE status = 'done'",
    [],
  );

  const naked = doneTasks.filter((t) => !collectCompletionEvidence(t.id).hasEvidence);

  assert.deepEqual(
    naked.map((t) => `${t.title} (${t.id})`),
    [],
    'these tasks read `done` with no registered, reachable deliverable — ' +
    'every one of them is a completion record with nothing behind it',
  );
});
