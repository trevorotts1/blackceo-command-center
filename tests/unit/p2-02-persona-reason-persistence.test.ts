/**
 * P2-02 — persona_reason PERSISTENCE, end-to-end.
 *
 * The sibling unit test (p2-02-task-modal-fields.test.ts) proves `buildPersonaReason`
 * in isolation. This integration test closes the OTHER half of the P2-02 (e) claim —
 * "verify persona_reason appears for a newly-created task end-to-end" — which a pure
 * unit test of the builder cannot: that the reason is actually WRITTEN to the
 * `tasks.persona_reason` column by a REAL pin path and then SURFACED by the real
 * `GET /api/tasks/[id]` handler the TaskModal consumes.
 *
 * It drives the real stack against a real temp SQLite DB (schema + all migrations,
 * so migration 099's persona_reason column exists):
 *   1. POST /api/persona-assignment (auto_assign) — one of the real pin paths listed
 *      in P2-02: it scores a persona and persists persona_reason via buildPersonaReason.
 *      The Python selector is stubbed by PERSONA_FIXTURE_JSON (no python spawn), so the
 *      pin logic runs exactly as in production.
 *   2. GET /api/tasks/[id] — the exact handler the modal calls — and assert the returned
 *      task carries a non-empty, single-sentence persona_reason.
 *
 * FAIL-FIRST: against a pre-P2-02 tree the persona_reason column, the migration, and
 * the pin-site write do not exist, so GET returns a task with no persona_reason and the
 * final assertions fail. With the P2-02 build they pass.
 *
 * DATABASE_PATH is set BEFORE the dynamic import of @/lib/db so its module-load-time
 * DB_PATH constant captures the temp DB. node --test runs each test FILE in its own
 * process, so this env never bleeds into a sibling suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

test('persona_reason is written by a real pin path (persona-assignment) and surfaced by GET /api/tasks/[id]', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-p2-02-persona-reason-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'mission-control.db');
  // Stub the Python persona selector: return a scored match without spawning python.
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'russell-brunson',
    persona_name: 'Russell Brunson',
    score: 0.82,
    interaction_mode: 'leadership',
  });

  // Import AFTER DATABASE_PATH is set so getDb() targets the temp DB.
  const { getDb } = await import('../../src/lib/db/index');
  const db = getDb();

  // Seed the minimal FK context: a workspace for the task's default workspace_id.
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, company_id) VALUES ('default','Default','default',NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, department, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', 'default', 'marketing', datetime('now'), datetime('now'))`,
  ).run('task-persona-reason', 'Landing page', 'Build a direct-response landing page');
  db.pragma('foreign_keys = ON');

  // Pre-condition: the freshly-inserted task has NO persona_reason yet.
  const before = db
    .prepare('SELECT persona_reason FROM tasks WHERE id = ?')
    .get('task-persona-reason') as { persona_reason: string | null };
  assert.equal(before.persona_reason, null, 'task must start with no persona_reason');

  // 1. Real pin path — POST /api/persona-assignment (auto_assign default true).
  const assignMod = await import('../../src/app/api/persona-assignment/route');
  const assignRes = await assignMod.POST(
    new Request('http://localhost/api/persona-assignment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task_id: 'task-persona-reason', auto_assign: true }),
    }),
  );
  assert.equal(assignRes.status, 200, 'persona assignment must succeed');
  const assignBody = (await assignRes.json()) as { assigned?: boolean; persona?: { persona_id?: string } };
  assert.equal(assignBody.assigned, true);
  assert.equal(assignBody.persona?.persona_id, 'russell-brunson');

  // 2. The modal's real read path — GET /api/tasks/[id].
  const taskMod = await import('../../src/app/api/tasks/[id]/route');
  const getRes = await taskMod.GET(
    new Request('http://localhost/api/tasks/task-persona-reason') as never,
    { params: Promise.resolve({ id: 'task-persona-reason' }) },
  );
  assert.equal(getRes.status, 200, 'GET /api/tasks/[id] must return the task');
  const task = (await getRes.json()) as { persona_id: string | null; persona_reason: string | null };

  // The modal-consumed task carries a persisted, non-empty, single-sentence WHY.
  assert.equal(task.persona_id, 'russell-brunson');
  assert.ok(task.persona_reason, 'GET /api/tasks/[id] must surface persona_reason end-to-end');
  assert.ok(
    !task.persona_reason!.includes('\n'),
    'persona_reason must be a single line (never a raw multi-line dump)',
  );
  assert.ok(task.persona_reason!.endsWith('.'), 'persona_reason must read as a sentence');
  assert.match(task.persona_reason!, /Russell Brunson/, 'the WHY must name the pinned persona');

  // And it is genuinely persisted in the column, not just assembled in the response.
  const persisted = db
    .prepare('SELECT persona_reason FROM tasks WHERE id = ?')
    .get('task-persona-reason') as { persona_reason: string | null };
  assert.equal(
    persisted.persona_reason,
    task.persona_reason,
    'the surfaced persona_reason must be the value persisted to the tasks column',
  );
});
