/**
 * skill6-lifecycle-guard.test.ts
 *
 * Covers the two changes made to the Skill-6 producer path:
 *
 *  A. POST /api/tasks/[id]/status now routes its write through the shared
 *     lifecycle state machine (transition(), src/lib/task-lifecycle.ts) instead of
 *     a raw UPDATE. Before this, the route wrote ANY schema-valid status straight to
 *     the DB — so an external producer could drive a card along an ILLEGAL edge that
 *     the LEGAL_TRANSITIONS map forbids and that the operator PATCH path has always
 *     rejected. It now returns 409 and does NOT mutate.
 *
 *     The route passes operatorOverride:true, which skips ONLY the agent-assignment
 *     preconditions (in transition(), the legal-transition guard runs BEFORE
 *     checkPreconditions). Those preconditions assume a CC-internal, agent-driven
 *     workflow; the Skill-6 producer builds its own cards externally with no assigned
 *     CC agent, so enforcing them would 422 every legitimate update. These tests pin
 *     BOTH halves of that contract: illegal edges are still refused (409), and a legal
 *     edge on an agent-less producer card still succeeds (200).
 *
 *  B. 'done' remains hard-403 (FORBIDDEN_STATUSES) — a builder may never self-grade
 *     its own card. Pinned here as a security regression guard so the lifecycle
 *     refactor cannot quietly re-open the QC bypass.
 *
 * Harness mirrors task-status-transition.test.ts: throwaway temp DB + auth secrets
 * configured BEFORE @/lib/db and the route are imported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-s6guard-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const MC_API_TOKEN = 'test-mc-token-guard';
const WEBHOOK_SECRET = 'test-webhook-secret-guard';
process.env.MC_API_TOKEN = MC_API_TOKEN;
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const WS_ID = `ws-s6guard-${RUN_ID}`;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/tasks/[id]/status/route');
let POST: RouteModule['POST'];

function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

/** Drive the real POST handler with a fully-valid signed request. */
function callRoute(id: string, body: Record<string, unknown>): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const req = new NextRequest(`http://localhost/api/tasks/${id}/status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${MC_API_TOKEN}`,
      'x-webhook-signature': sign(rawBody),
    },
    body: rawBody,
  });
  return POST(req, { params: Promise.resolve({ id }) }) as unknown as Promise<Response>;
}

function currentStatus(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

/** Seed a Skill-6-marked card (the "Source: funnel" marker) in a given status. */
function seedCard(id: string, status: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'Skill6 guard card', 'Brief.\n\nSource: funnel', ?, 'high', ?, 'default', ?, ?)`,
    [id, status, WS_ID, now, now],
  );
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // full migration chain against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, 'S6 Guard', '🛡️', 'default', 1, ?, ?)`,
    [WS_ID, `s6guard-${RUN_ID}`, now, now],
  );

  const mod = (await import('../../src/app/api/tasks/[id]/status/route')) as RouteModule;
  POST = mod.POST;
});

test.after(() => {
  try { closeDb?.(); } catch { /* ignore */ }
});

// ── A. Illegal edge is now REFUSED (this is the whole point of the change) ────
test("illegal edge (backlog → review) is refused with 409 and does NOT mutate the card", async () => {
  const id = `s6-illegal-${RUN_ID}`;
  seedCard(id, 'backlog'); // LEGAL_TRANSITIONS.backlog does NOT include 'review'

  const res = await callRoute(id, { status: 'review' });

  assert.equal(res.status, 409, 'an illegal lifecycle edge must be rejected with 409');
  const body = (await res.json()) as { code?: string };
  assert.equal(body.code, 'ILLEGAL_TRANSITION');
  // The card must be untouched — before the fix, the raw UPDATE would have written it.
  assert.equal(currentStatus(id), 'backlog', 'REGRESSION: the illegal status was persisted');
});

// ── A. Legal edge on an AGENT-LESS producer card still succeeds ───────────────
// This is the half that operatorOverride:true protects. transition()'s
// 'in_progress' precondition demands assigned_agent_id; a Skill-6 producer card has
// none. Without the override this 422s and the producer breaks in production.
test("legal edge (backlog → in_progress) succeeds on an agent-less producer card", async () => {
  const id = `s6-legal-${RUN_ID}`;
  seedCard(id, 'backlog'); // no assigned_agent_id — exactly like a real producer card

  const res = await callRoute(id, { status: 'in_progress' });

  assert.equal(
    res.status,
    200,
    'a legal edge on an agent-less producer card must still succeed (operatorOverride skips the agent precondition)',
  );
  assert.equal(currentStatus(id), 'in_progress');
});

// ── A. The lifecycle guard writes the audit row exactly once ──────────────────
test("a successful transition writes exactly ONE legacy 'events' audit row (no double-count)", async () => {
  const id = `s6-audit-${RUN_ID}`;
  seedCard(id, 'backlog');

  const res = await callRoute(id, { status: 'in_progress' });
  assert.equal(res.status, 200);

  // transition() writes the legacy `events` row. The route no longer writes its own,
  // so exactly one must exist — two would mean the audit is double-counted.
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type IN ('task_status_changed','task_completed')`,
    [id],
  );
  assert.equal(row?.n, 1, `expected exactly 1 status audit event, got ${row?.n}`);
});

// ── B. SECURITY REGRESSION GUARD: 'done' is still hard-403 ───────────────────
test("SECURITY: status='done' is still hard-403 and does NOT mutate (QC bypass stays closed)", async () => {
  const id = `s6-done-${RUN_ID}`;
  seedCard(id, 'review'); // review → done IS a legal edge, so only the 403 can stop it

  const res = await callRoute(id, { status: 'done' });

  assert.equal(res.status, 403, "'done' must remain forbidden on the producer path");
  assert.equal(
    currentStatus(id),
    'review',
    'REGRESSION: the producer self-graded its own card to done — QC bypass re-opened',
  );
});
