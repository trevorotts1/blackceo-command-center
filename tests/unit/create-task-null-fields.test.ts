/**
 * P2-03 — POST /api/tasks must accept the EXACT payload shape the real
 * TaskModal "New Task" form sends.
 *
 * Root cause (live reproduction, operator box class): TaskModal.handleSubmit()
 * (src/components/TaskModal.tsx) ALWAYS sends `assigned_agent_id: null` and
 * `due_date: null` in its create payload when those fields are left at their
 * default empty state (`form.assigned_agent_id || null`, `form.due_date ||
 * null`) — which is the NORMAL path for a brand-new task (no agent
 * pre-assigned, no due date picked). CreateTaskSchema
 * (src/lib/validation.ts), unlike UpdateTaskSchema, declared
 * `assigned_agent_id` / `due_date` as `z.string().uuid().optional()` /
 * `z.string().optional()` WITHOUT `.nullable()`. Zod's `.optional()` accepts a
 * MISSING key but rejects an explicit `null` value, so every create with
 * these two (extremely common) defaults 400'd with "Validation failed" —
 * exactly matching the operator's "[creating a task] doesn't really work"
 * report. The UI additionally showed NO error feedback for this case (a
 * second, related bug — see the Playwright regression lock and the
 * TaskModal submit-error banner change in the same fix).
 *
 * FAIL-FIRST: against the pre-fix CreateTaskSchema this test's first two
 * cases 400 (assert.equal(res.status, 201) fails). With the `.nullable()`
 * fix in validation.ts both pass.
 *
 * Strategy mirrors tests/unit/ingest-requester-stamp.test.ts: isolated temp
 * DB, seed the workspace(s) referenced, invoke the REAL POST handler
 * (src/app/api/tasks/route.ts) with a NextRequest — never a mock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

// ── Isolated DB (set BEFORE @/lib/db / the route module are imported) ───────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-create-task-null-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
// No embedding keys → SOP auto-suggest / persona selection stay on their
// deterministic, network-free fallback paths.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const SALES_WS_ID = `ws-sales-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/route');
let POST: RouteModule['POST'];

/** POST the EXACT shape TaskModal.handleSubmit() sends for a brand-new task
 *  with the agent/due-date fields left at their default (empty) state. */
function callCreate(overrides: Record<string, unknown> = {}): Promise<Response> {
  const payload = {
    title: `Untitled task ${RUN_ID}`,
    description: '',
    priority: 'medium',
    status: 'backlog',
    assigned_agent_id: null,
    due_date: null,
    workspace_id: SALES_WS_ID,
    ...overrides,
  };
  const req = new NextRequest('http://localhost/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return POST(req) as unknown as Promise<Response>;
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'sales', 'Sales', '💰', 'default', 1, ?, ?)`,
    [SALES_WS_ID, now, now],
  );

  const route = (await import('../../src/app/api/tasks/route')) as RouteModule;
  POST = route.POST;
});

test.after(() => {
  try {
    if (typeof closeDb === 'function') closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── The exact TaskModal minimal-create payload: assigned_agent_id AND
//    due_date both explicitly null (never omitted — TaskModal always sets
//    the key). This is the FAIL-FIRST case. ─────────────────────────────────
test('create with assigned_agent_id:null and due_date:null (TaskModal minimal-create shape) returns 201', async () => {
  const res = await callCreate();
  const bodyText = await res.clone().text();
  assert.equal(
    res.status,
    201,
    `expected 201, got ${res.status}. Body: ${bodyText}. This is the exact ` +
      `payload shape TaskModal sends for a "New Task" with no agent assigned ` +
      `and no due date set — the operator's default click-through path.`,
  );
  const body = (await res.json()) as { id: string; assigned_agent_id: string | null; due_date: string | null };
  assert.equal(body.assigned_agent_id, null);
  assert.equal(body.due_date, null);

  const row = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [body.id]);
  assert.ok(row, 'the created task must actually be persisted in the tasks table');
});

// ── Only assigned_agent_id explicitly null (due_date omitted) ───────────────
test('create with only assigned_agent_id:null returns 201', async () => {
  const res = await callCreate({ due_date: undefined, title: `Untitled B ${RUN_ID}` });
  const bodyText = await res.clone().text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
});

// ── Only due_date explicitly null (assigned_agent_id omitted) ───────────────
test('create with only due_date:null returns 201', async () => {
  const res = await callCreate({ assigned_agent_id: undefined, title: `Untitled C ${RUN_ID}` });
  const bodyText = await res.clone().text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
});

// ── A REAL uuid for assigned_agent_id + a real due_date must still work
//    (guards against an overly-broad fix that breaks the populated case). ───
test('create with a real assigned_agent_id and due_date still returns 201', async () => {
  const now = new Date().toISOString();
  const agentId = randomUUID();
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, specialist_type, workspace_id, created_at, updated_at)
     VALUES (?, 'Test Agent', 'Tester', '🤖', 'standby', 0, 'on-call', ?, ?, ?)`,
    [agentId, SALES_WS_ID, now, now],
  );
  const res = await callCreate({
    title: `Untitled D ${RUN_ID}`,
    assigned_agent_id: agentId,
    due_date: '2026-08-01T12:00:00.000Z',
  });
  const bodyText = await res.clone().text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
  const body = (await res.json()) as { assigned_agent_id: string | null; due_date: string | null };
  assert.equal(body.assigned_agent_id, agentId);
  assert.equal(body.due_date, '2026-08-01T12:00:00.000Z');
});

// ── An ACTUALLY invalid assigned_agent_id (not a uuid, not null) must still
//    400 — the fix must not turn off validation entirely. ───────────────────
test('create with a garbage (non-uuid, non-null) assigned_agent_id still 400s', async () => {
  const res = await callCreate({ title: `Untitled E ${RUN_ID}`, assigned_agent_id: 'not-a-uuid' });
  assert.equal(res.status, 400, 'a genuinely malformed assigned_agent_id must still be rejected');
});
