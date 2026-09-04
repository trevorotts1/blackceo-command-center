/**
 * fix36-board-sources.test.ts — FIX 36 (MASTER Part 8 / 01-FIX-PLAN FIX 23).
 *
 * PROBLEM: the Presentations engine mints per-phase CHILD cards via
 * /api/tasks/ingest with source="build_deck_phase" and the interview app mints
 * its own cards with source="presentation-interview-app". Neither was in the
 * status route's RECOGNIZED_BOARD_SOURCES set, so EVERY child status change
 * 403'd with "not a signed board-producer card" (13 such 200-parent/403-child
 * pairs in one live receipt).
 *
 * PROOF REQUIRED (QC.md FIX 36):
 *   • ingest a card with source: build_deck_phase →
 *     POST /api/tasks/<id>/status {status: in_progress} with bearer + HMAC → 200
 *   • same with source: presentation-interview-app → 200
 *   • same with a garbage source → 403 (fail-closed kept)
 *
 * Harness mirrors tests/unit/u030-build-deck-board-source.test.ts (temp DB +
 * auth secrets configured BEFORE @/lib/db and the route are imported).
 * Also pins the FIX 36 refactor itself: the set is the SINGLE canonical copy
 * exported from src/lib/board-sources.ts, and the ingest route lowercases the
 * stamped tasks.source so mixed-case producer input still matches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fix36-')), 'db');
process.env.DATABASE_PATH = DB;
process.env.MC_API_TOKEN = 't36';
process.env.WEBHOOK_SECRET = 's36';

function hmac(b: string): string {
  return createHmac('sha256', 's36').update(b).digest('hex');
}
function signedPost(id: string, body: Record<string, unknown>): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest(`http://localhost/api/tasks/${id}/status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer t36',
      'x-webhook-signature': hmac(raw),
    },
    body: raw,
  });
}

let run: Function;
let q1: Function;
let qAll: Function;
let close: Function;
let POST: Function;
let WSID: string;

function st(id: string): string | undefined {
  return q1('SELECT status FROM tasks WHERE id=?', [id])?.status;
}
function src(id: string): string | undefined {
  return q1('SELECT source FROM tasks WHERE id=?', [id])?.source;
}

/**
 * Ingest through the REAL /api/tasks/ingest POST handler so the immutable
 * tasks.source stamp is exercised end-to-end (the QC proof starts "Ingest a
 * card with source: <v>"), then drive the status route against it.
 */
async function ingest(source: unknown, extra: Record<string, unknown> = {}): Promise<{ id: string; status: number }> {
  const raw = JSON.stringify({ title: 'FIX 36 card', description: 'seed', source, ...extra });
  const req = new NextRequest('http://localhost/api/tasks/ingest', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer t36',
      'x-webhook-signature': hmac(raw),
    },
    body: raw,
  });
  const mod = await import('../../src/app/api/tasks/ingest/route');
  const res = (await (mod as any).POST(req)) as unknown as Response;
  const bodyJson = (await res.json()) as { task_id?: string; id?: string };
  return { id: String(bodyJson.task_id ?? bodyJson.id ?? ''), status: res.status };
}

async function statusPost(id: string, body: Record<string, unknown>): Promise<Response> {
  return POST(signedPost(id, body), { params: Promise.resolve({ id }) }) as unknown as Promise<Response>;
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  q1 = db.queryOne;
  qAll = db.queryAll;
  close = db.closeDb;
  db.getDb();
  const n = new Date().toISOString();
  WSID = 'ws-fix36-' + Math.random().toString(36).slice(2, 8);
  run(
    "INSERT OR IGNORE INTO companies(id,name,slug,config,created_at,updated_at) VALUES ('default','D','d','{}',?,?)",
    [n, n],
  );
  run(
    "INSERT OR IGNORE INTO workspaces(id,slug,name,icon,company_id,sort_order,created_at,updated_at) VALUES (?,'fix36','FIX36','🔧','default',1,?,?)",
    [WSID, n, n],
  );
  POST = (await import('../../src/app/api/tasks/[id]/status/route')).POST;
});
test.after(() => {
  try { close?.(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(DB), { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── The canonical module itself ────────────────────────────────────────────────
test('normalizeBoardSource recognizes both engine sources + legacy set, fail-closed on garbage', async () => {
  const { RECOGNIZED_BOARD_SOURCES, normalizeBoardSource } = await import('../../src/lib/board-sources');
  assert.equal(normalizeBoardSource('build_deck_phase'), 'build_deck_phase');
  assert.equal(normalizeBoardSource('presentation-interview-app'), 'presentation-interview-app');
  assert.equal(normalizeBoardSource('  Build_Deck_Phase '), 'build_deck_phase', 'trim + lowercase');
  for (const legacy of ['funnel', 'survey', 'web-development', 'anthology', 'build_deck', 'presentations']) {
    assert.equal(normalizeBoardSource(legacy), legacy, `legacy source ${legacy} still recognized`);
  }
  assert.equal(normalizeBoardSource('garbage'), null);
  assert.equal(normalizeBoardSource(''), null);
  assert.equal(normalizeBoardSource(null), null);
  assert.equal(normalizeBoardSource(42), null);
  assert.equal(RECOGNIZED_BOARD_SOURCES.size, 8);
});

// ── QC.md FIX 36 proof, over the REAL ingest → status round trip ──────────────
test('ingest source build_deck_phase → status in_progress via signed POST → 200', async () => {
  const { id } = await ingest('build_deck_phase');
  assert.ok(id, 'ingest must return a task id');
  assert.equal(src(id), 'build_deck_phase', 'immutable tasks.source stamped from ingest body');
  const res = await statusPost(id, { status: 'in_progress', note: 'P4-COPY start' });
  assert.equal(res.status, 200, `build_deck_phase child must transition (was the 403 bug)`);
  assert.equal(st(id), 'in_progress');
});

test('ingest source presentation-interview-app → status in_progress via signed POST → 200', async () => {
  const { id } = await ingest('presentation-interview-app');
  assert.ok(id, 'ingest must return a task id');
  const res = await statusPost(id, { status: 'in_progress' });
  assert.equal(res.status, 200, 'interview-app card must transition (was the 403 bug)');
  assert.equal(st(id), 'in_progress');
});

test('ingest source garbage → status in_progress via signed POST → 403 (fail-closed)', async () => {
  const { id } = await ingest('garbage');
  assert.ok(id, 'ingest itself is not source-gated — the card still exists');
  const res = await statusPost(id, { status: 'in_progress' });
  assert.equal(res.status, 403, 'garbage source must stay rejected with 403');
  // TEMP DIAGNOSTIC (CI-only intermittent failure, unreproducible locally —
  // see PR #293): dump the full row + its events BEFORE the assertion so the
  // cause is visible in CI logs even when this fails. Remove once root-caused.
  const diagRow = q1<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [id]);
  const diagEvents = qAll<Record<string, unknown>>(
    'SELECT type, message, created_at FROM events WHERE task_id = ? ORDER BY created_at',
    [id],
  );
  console.error('[DIAG fix36] row:', JSON.stringify(diagRow));
  console.error('[DIAG fix36] events:', JSON.stringify(diagEvents));
  assert.equal(st(id), 'backlog', 'and the card must NOT move');
});

test('mixed-case producer input Build_Deck_Phase still transitions (ingest lowercases the stamp)', async () => {
  const { id } = await ingest('Build_Deck_Phase');
  assert.equal(src(id), 'build_deck_phase', 'ingest normalizes case before stamping');
  const res = await statusPost(id, { status: 'in_progress' });
  assert.equal(res.status, 200);
});

// ── The panel label map covers the new sources and stays on the shared set ────
test('engineSourceLabel labels build_deck_phase and presentation-interview-app', async () => {
  const m = await import('../../src/components/TaskOverviewPanels');
  assert.equal(
    m.engineSourceLabel({ source: 'build_deck_phase', description: null }),
    'a presentations deck phase build',
  );
  assert.equal(
    m.engineSourceLabel({ source: 'presentation-interview-app', description: null }),
    'the presentations interview app',
  );
  // Legacy behavior pinned: telegram is not a producer source → null.
  assert.equal(m.engineSourceLabel({ source: 'telegram', description: null }), null);
  assert.equal(m.engineSourceLabel({ source: 'funnel', description: null }), 'a Skill 6 funnel build');
});
