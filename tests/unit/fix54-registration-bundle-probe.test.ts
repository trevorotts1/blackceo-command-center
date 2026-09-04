/**
 * FIX 54 — Bundle floors enforced at registration.
 *
 * Spec: `deliverables/route.ts` runs the bundle probe on bundle-shaped paths
 * and refuses with 422 naming the same reason the done gate would give.
 * PROOF: a 10-byte PRESENTER-GUIDE.pdf → 422 UNDER_THRESHOLD; a 60 KB %PDF
 * file named PRESENTER-GUIDE.pdf → 201.
 *
 * Drives the REAL POST /api/tasks/[id]/deliverables handler on an isolated DB
 * (_isolated-db first import). No network. Rollback: the FIX 28 flag
 * PRESENTATION_BUNDLE_REVERIFY=0 restores the pre-FIX-54 behavior (the
 * existence gate FIX 27 still applies).
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
let stubGuide: string;
let realGuide: string;

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix54-'));
  taskId = `fix54-task-${Date.now()}`;
  stubGuide = path.join(fixtureDir, 'PRESENTER-GUIDE.pdf');
  fs.writeFileSync(stubGuide, Buffer.from('0123456789', 'binary')); // 10 bytes
  realGuide = path.join(fixtureDir, 'PRESENTER-GUIDE-60K.pdf');
  fs.writeFileSync(realGuide, Buffer.concat([Buffer.from('%PDF-1.7\n', 'binary'), Buffer.alloc(60 * 1024, 0x41)]));

  const db = getDb();
  if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get('presentations')) {
    db.prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)')
      .run('presentations', 'Presentations', 'presentations', 'Presentation', 10);
  }
  db.prepare("INSERT INTO tasks (id,title,status,priority,workspace_id,department) VALUES (?,?,'backlog','medium','presentations','presentations')")
    .run(taskId, 'FIX 54 Registration Probe Task');
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
  delete process.env.PRESENTATION_BUNDLE_REVERIFY;
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

describe('FIX 54 — bundle-shaped under-floor registrations refused (422, no row)', () => {
  it('a 10-byte PRESENTER-GUIDE.pdf is rejected 422 UNDER_THRESHOLD', async () => {
    const res = await postDeliverable({ deliverable_type: 'file', title: 'Presenter Guide', path: stubGuide });
    expect(res.status).toBe(422);
    const json = await res.json() as { error?: string; status?: string };
    expect(json.status).toBe('UNDER_THRESHOLD');
    expect(json.error).toContain('UNDER_THRESHOLD');
    expect(json.error).toContain('PRESENTER-GUIDE.pdf');
    expect(rowCount()).toBe(0);
  });

  it('the same refusal applies to artifact and image deliverable types', async () => {
    for (const deliverable_type of ['artifact', 'image']) {
      const res = await postDeliverable({ deliverable_type, title: `Guide ${deliverable_type}`, path: stubGuide });
      expect(res.status).toBe(422);
      expect(rowCount()).toBe(0);
    }
  });

  it('a decoy PDF at a wrong-type name is refused WRONG_TYPE', async () => {
    const png = path.join(fixtureDir, 'infographic.png');
    fs.writeFileSync(png, Buffer.concat([Buffer.from('%PDF-1.7\n', 'binary'), Buffer.alloc(150 * 1024, 0x41)]));
    const res = await postDeliverable({ deliverable_type: 'file', title: 'Infographic', path: png });
    expect(res.status).toBe(422);
    const json = await res.json() as { status?: string };
    expect(json.status).toBe('WRONG_TYPE');
    expect(rowCount()).toBe(0);
  });
});

describe('FIX 54 — honest bundle registrations still succeed (201)', () => {
  it('a 60 KB %PDF PRESENTER-GUIDE.pdf registers 201 with size + sha', async () => {
    const res = await postDeliverable({ deliverable_type: 'file', title: 'Presenter Guide Real', path: realGuide });
    expect(res.status).toBe(201);
    const json = await res.json() as { file_size_bytes?: number; sha256?: string };
    expect(json.file_size_bytes).toBe(fs.statSync(realGuide).size);
    expect(json.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rowCount()).toBe(1);
  });

  it('a NON bundle-shaped file keeps the FIX 27 existence rule only', async () => {
    const plain = path.join(fixtureDir, 'notes.txt');
    fs.writeFileSync(plain, 'tiny', 'utf-8');
    const res = await postDeliverable({ deliverable_type: 'file', title: 'Notes', path: plain });
    expect(res.status).toBe(201);
    expect(rowCount()).toBe(1);
  });
});

describe('FIX 54 — rollback path', () => {
  it('PRESENTATION_BUNDLE_REVERIFY=0 restores the pre-FIX-54 behavior (201 warn era not required; 27 still gates)', async () => {
    process.env.PRESENTATION_BUNDLE_REVERIFY = '0';
    const res = await postDeliverable({ deliverable_type: 'file', title: 'Stub Rollback', path: stubGuide });
    // The FIX 27 existence gate passes (file exists); FIX 54 no longer runs.
    expect(res.status).toBe(201);
    expect(rowCount()).toBe(1);
  });
});
