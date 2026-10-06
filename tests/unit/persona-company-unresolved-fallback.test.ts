/**
 * A task whose company is missing from MC_PERSONA_COMPANY_CONTEXTS_JSON used to
 * throw `persona_company_context_missing` out of resolvePersonaAndPin with NOTHING
 * pinned — every task in that company was born persona-less and parked by the
 * triad gate. It now pins the company-neutral house voice (never another
 * company's sticky/default) and records a loud `persona_company_context_missing`
 * event so the setup gap stays visible.
 */
import './_isolated-db'; // MUST be the first DB-reaching import (C8 guard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { resolvePersonaAndPin } from '../../src/lib/tasks';
import { DEFAULT_PERSONA_FALLBACK } from '../../src/lib/persona-selector';

getDb();

test('unwired company → house-voice fallback pinned + audit event (not a naked task)', async () => {
  delete process.env.PERSONA_FIXTURE_JSON;
  delete process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON;
  run(`INSERT INTO companies (id, name, slug, config) VALUES ('unwired-co', 'Unwired Co', 'unwired-co', '{}')`);
  run(`INSERT INTO workspaces (id, name, slug, company_id, sort_order) VALUES ('unwired-ws', 'Unwired', 'unwired-ws', 'unwired-co', 1)`);
  // A DIFFERENT company's sticky history must never be borrowed.
  run(
    `INSERT INTO persona_assignment (department_id, task_category, persona_id, persona_name, persona_mode, last_assigned_at)
     VALUES ('marketing', 'general', 'other-company-sticky', 'Other Company Sticky', 'leadership', ?)`,
    [new Date().toISOString()],
  );

  const id = uuidv4();
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, department, workspace_id, created_at, updated_at)
     VALUES (?, 'Draft the spring newsletter', 'backlog', 'marketing', 'unwired-ws', ?, ?)`,
    [id, now, now],
  );

  const pinned = await resolvePersonaAndPin(id, 'Draft the spring newsletter', 'marketing');

  assert.equal(pinned, DEFAULT_PERSONA_FALLBACK);
  const row = queryOne<{ persona_id: string | null; persona_fallback: number }>(
    'SELECT persona_id, persona_fallback FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(row?.persona_id, DEFAULT_PERSONA_FALLBACK);
  assert.equal(row?.persona_fallback, 1);
  const ev = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'persona_company_context_missing'`,
    [id],
  );
  assert.equal(ev?.n, 1);
});
