/**
 * FIX 27 — Reject nonexistent deliverable paths at registration.
 *
 * Spec: registration fails (4xx) if the path/URL isn't reachable at register
 * time; capture size/sha only on real files. Rollback: set
 * DELIVERABLE_PATH_VALIDATION=0 to restore the old warn-and-201 behavior.
 *
 * RED: bogus file/artifact paths currently return 201+warning -> this suite
 * fails before the fix. GREEN: after the fix every case passes.
 *
 * Drives the REAL POST /api/tasks/[id]/deliverables handler. DB-backed
 * vitest suite via _isolated-db; no network — url cases are validated
 * syntactically (spec's reachability rule for url: valid http(s) URL).
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';

let fixtureDir: string;
let taskId: string;
let existingFile: string;
let nonexistentPath: string;

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix27-'));
  taskId = `fix27-task-${Date.now()}`;
  existingFile = path.join(fixtureDir, 'real-file.txt');
  fs.writeFileSync(existingFile, 'hello fix27 content', 'utf-8');
  nonexistentPath = path.join(fixtureDir, 'does-not-exist.pptx');

  const db = getDb();
  if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get('presentations')) {
    db.prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)')
      .run('presentations', 'Presentations', 'presentations', 'Presentation', 10);
  }
  db.prepare("INSERT INTO tasks (id,title,status,priority,workspace_id,department) VALUES (?,?,'backlog','medium','presentations','presentations')")
    .run(taskId, 'FIX 27 Test Task');
});

afterAll(() => {
  const db = getDb();
  db.prepare('DELETE FROM task_deliverables WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ok */ }
});

beforeEach(() => {
  getDb().prepare('DELETE FROM task_deliverables WHERE task_id = ?').run(taskId);
});

afterEach(() => {
  delete process.env.DELIVERABLE_PATH_VALIDATION;
});

async function postDeliverable(body: Record<string, unknown>) {
  const { POST } = await import('../../src/app/api/tasks/[id]/deliverables/route');
  const req = new NextRequest(`http://localhost/api/tasks/${taskId}/deliverables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req, { params: { id: taskId } });
}

function rowCount(): number {
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM task_deliverables WHERE task_id = ?').get(taskId) as { n: number };
  return r.n;
}

describe('FIX 27 — unreachable paths rejected at registration (4xx, no row)', () => {
  it('rejects a file deliverable at a nonexistent path with 4xx', async () => {
    const res = await postDeliverable({ deliverable_type: 'file', title: 'Bogus File', path: nonexistentPath });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(rowCount()).toBe(0);
  });

  it('rejects an artifact deliverable at a nonexistent path with 4xx', async () => {
    const res = await postDeliverable({ deliverable_type: 'artifact', title: 'Bogus Artifact', path: nonexistentPath });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(rowCount()).toBe(0);
  });

  it('rejects a file deliverable with NO path (nothing can be reachable)', async () => {
    const res = await postDeliverable({ deliverable_type: 'file', title: 'No Path File' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(rowCount()).toBe(0);
  });

  it('expands ~ and rejects a nonexistent home-relative path', async () => {
    const res = await postDeliverable({ deliverable_type: 'artifact', title: 'Tilde Bogus', path: '~/fix27-definitely-not-here-9x7.pptx' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(rowCount()).toBe(0);
  });

  it('rejects a url deliverable whose path is not a valid http(s) URL', async () => {
    const res = await postDeliverable({ deliverable_type: 'url', title: 'Not A URL', path: 'not-a-url-at-all' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(rowCount()).toBe(0);
  });
});

describe('FIX 27 — reachable registrations still succeed', () => {
  it('accepts an existing file, capturing size + sha256', async () => {
    const res = await postDeliverable({ deliverable_type: 'file', title: 'Real File', path: existingFile });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.file_size_bytes).toBe(fs.statSync(existingFile).size);
    expect(json.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rowCount()).toBe(1);
  });

  it('accepts a valid https url deliverable', async () => {
    const res = await postDeliverable({ deliverable_type: 'url', title: 'Real URL', path: 'https://example.com/decision' });
    expect(res.status).toBe(201);
    expect(rowCount()).toBe(1);
  });

  it('size/sha are null for a directory-backed artifact (not a regular file)', async () => {
    const dirPath = path.join(fixtureDir, 'adir');
    fs.mkdirSync(dirPath, { recursive: true });
    const res = await postDeliverable({ deliverable_type: 'artifact', title: 'Dir Artifact', path: dirPath });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.sha256).toBeNull();
    expect(json.file_size_bytes).toBeNull();
  });
});

describe('FIX 27 — documented rollback path', () => {
  it('DELIVERABLE_PATH_VALIDATION=0 restores warn-and-201 for nonexistent paths', async () => {
    process.env.DELIVERABLE_PATH_VALIDATION = '0';
    const res = await postDeliverable({ deliverable_type: 'file', title: 'Bogus File Rollback', path: nonexistentPath });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.warning).toBeTruthy();
    expect(rowCount()).toBe(1);
  });
});
