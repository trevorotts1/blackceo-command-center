/**
 * FIX 37 (W16a-B2) — widen the activity enum.
 *
 * PROOF (QC.md FIX 37): `POST /api/tasks/<id>/activities
 * {activity_type: comment, message: hi}` → 201 and a `task_activities` row.
 *
 * Drives the REAL POST handler of /api/tasks/[id]/activities against an
 * isolated DB (same pattern as fix5-stage-timings-ingest.test.ts). No network.
 *
 *  - every widened type (comment, progress, phase_started, phase_completed,
 *    error) returns 201 and lands its row in task_activities,
 *  - the legacy five types still pass (no regression at the gate),
 *  - negative control: a bogus activity_type still 400s (the enum is wider,
 *    not open).
 *  - `comment` is the proof case from the spec, asserted first.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';

const TASK_ID = `fix37-task-${Date.now()}`;

async function postActivity(body: Record<string, unknown>) {
  const { POST } = await import('../../src/app/api/tasks/[id]/activities/route');
  const req = new NextRequest(`http://localhost/api/tasks/${TASK_ID}/activities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req, { params: { id: TASK_ID } });
}

function countRows(type: string): number {
  const row = getDb()
    .prepare(
      'SELECT count(*) AS n FROM task_activities WHERE task_id = ? AND activity_type = ?',
    )
    .get(TASK_ID, type) as { n: number };
  return row.n;
}

beforeAll(() => {
  const db = getDb();
  // Same parent-row order as fix25-review-artifact-gate.test.ts: companies
  // first (workspaces.company_id REFERENCES companies(id), foreign_keys=ON),
  // then the workspace (tasks.workspace_id REFERENCES workspaces(id)), then
  // the task. A fresh isolated DB has no 'default' workspace — the reseed
  // creates canonical department slugs, not 'default'.
  if (!db.prepare('SELECT id FROM companies WHERE id = ?').get('default')) {
    db.prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)')
      .run('default', 'Default Company', 'default');
  }
  if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get('fix37')) {
    db.prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)')
      .run('fix37', 'FIX 37 proof', 'fix37-proof', '🧪', 999);
  }
  db.prepare(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, created_at, updated_at)
     VALUES (?, 'FIX 37 activity enum proof', 'in_progress', 'medium', 'fix37', datetime('now'), datetime('now'))`,
  ).run(TASK_ID);
});

afterAll(() => {
  const db = getDb();
  db.prepare('DELETE FROM task_activities WHERE task_id = ?').run(TASK_ID);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(TASK_ID);
});

describe('FIX 37 — POST /api/tasks/[id]/activities widened enum', () => {
  it('THE PROOF: {activity_type: comment, message: hi} → 201 and a task_activities row', async () => {
    const res = await postActivity({ activity_type: 'comment', message: 'hi' });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.activity_type).toBe('comment');
    expect(json.message).toBe('hi');
    expect(countRows('comment')).toBe(1);
  });

  it.each(['progress', 'phase_started', 'phase_completed', 'error'])(
    'accepts %s → 201 with a persisted row',
    async (type) => {
      const res = await postActivity({ activity_type: type, message: `fix37 ${type}` });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.activity_type).toBe(type);
      expect(countRows(type)).toBe(1);
    },
  );

  it.each(['spawned', 'updated', 'completed', 'file_created', 'status_changed'])(
    'legacy type %s still passes the gate (no regression)',
    async (type) => {
      const res = await postActivity({ activity_type: type, message: `fix37 legacy ${type}` });
      expect(res.status).toBe(201);
      expect(countRows(type)).toBe(1);
    },
  );

  it('negative control: a bogus activity_type still 400s (wider, not open)', async () => {
    const res = await postActivity({ activity_type: 'garbage_type_fix37', message: 'nope' });
    expect(res.status).toBe(400);
    expect(countRows('garbage_type_fix37')).toBe(0);
  });
});
