import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getDb, run, queryOne, closeDb } from '../../src/lib/db';
import { NextRequest } from 'next/server';

let POST: any;
let taskCounter = 0;
function nextId(p: string) { return `${p}-${++taskCounter}-${Date.now()}`; }

function insertParkedReviewTask(id: string) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, department, status, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
    [id, `Fixture ${id}`, 'marketing', 'review', now, now],
  );
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, 'url', ?, ?, ?)`,
    [`d-${id}`, id, `Deliverable for ${id}`, 'https://example.invalid/p', now],
  );
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'qc_review', ?, ?, ?)`,
    [`e-${id}`, id, '[QC-HEURISTIC] no judge key configured — parked for a human', now],
  );
}

function currentStatus(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

beforeAll(async () => { getDb(); const m = await import('../../src/app/api/tasks/[id]/promote/route'); POST = m.POST; });
afterAll(() => { try { closeDb(); } catch {} });
beforeEach(() => { delete process.env.CC_PROMOTE_ALLOW_UNVERIFIED; });

async function callPromote(taskId: string, email?: string | null) {
  const init: any = { method: 'POST' };
  if (email !== undefined && email !== null) init.headers = { 'cf-access-authenticated-user-email': email };
  return POST(new NextRequest(`http://localhost/api/tasks/${taskId}/promote`, init), { params: Promise.resolve({ id: taskId }) });
}

describe('U032 — promote identity gate', () => {
  it('refuses a parked review card with no cf-access header', async () => {
    const id = nextId('no-hdr');
    insertParkedReviewTask(id);
    const res = await callPromote(id);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe('operator_identity_required');
    expect(currentStatus(id)).toBe('review');
  });

  it('refuses a parked review card with whitespace-only header', async () => {
    const id = nextId('blank');
    insertParkedReviewTask(id);
    const res = await callPromote(id, '   ');
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe('operator_identity_required');
    expect(currentStatus(id)).toBe('review');
  });

  it('promotes a parked review card with a non-empty header', async () => {
    const id = nextId('ok');
    insertParkedReviewTask(id);
    const res = await callPromote(id, 'operator@example.invalid');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('done');
    expect(currentStatus(id)).toBe('done');
  });

  it('refuses an in_progress card with status message (gate 1 first)', async () => {
    const id = nextId('ws');
    const now = new Date().toISOString();
    run(
      `INSERT INTO tasks (id, title, department, status, workspace_id, business_id, created_at, updated_at)
       VALUES (?, ?, ?, 'in_progress', NULL, NULL, ?, ?)`,
      [id, `Fixture ${id}`, 'marketing', now, now],
    );
    const res = await callPromote(id, 'operator@example.invalid');
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toMatch(/in_progress/);
    expect(currentStatus(id)).toBe('in_progress');
  });

  it('refuses a review card with no marker (gate 2 before gate 3)', async () => {
    const id = nextId('nm');
    const now = new Date().toISOString();
    run(
      `INSERT INTO tasks (id, title, department, status, workspace_id, business_id, created_at, updated_at)
       VALUES (?, ?, ?, 'review', NULL, NULL, ?, ?)`,
      [id, `Fixture ${id}`, 'marketing', now, now],
    );
    const res = await callPromote(id, 'operator@example.invalid');
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error).toMatch(/heuristic-parked/);
    expect(currentStatus(id)).toBe('review');
  });

  it('allows promotion without identity when CC_PROMOTE_ALLOW_UNVERIFIED=true', async () => {
    process.env.CC_PROMOTE_ALLOW_UNVERIFIED = 'true';
    const id = nextId('eh');
    insertParkedReviewTask(id);
    const res = await callPromote(id);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('done');
    expect(currentStatus(id)).toBe('done');
  });

  it('refuses with CC_PROMOTE_ALLOW_UNVERIFIED set to "false"', async () => {
    process.env.CC_PROMOTE_ALLOW_UNVERIFIED = 'false';
    const id = nextId('ehf');
    insertParkedReviewTask(id);
    const res = await callPromote(id);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe('operator_identity_required');
    expect(currentStatus(id)).toBe('review');
  });
});
