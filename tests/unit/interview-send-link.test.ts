/**
 * Unit tests for POST /api/interview/send-link — the OPERATOR-TRIGGERED
 * interview link delivery route. Runs under `npm run test:unit`.
 *
 * Strategy mirrors interview-nudge-sweep.test.ts + task-status-transition.test.ts:
 * isolated DATABASE_PATH + OPENCLAW_WORKSPACE_ROOT temp trees, env set BEFORE the
 * dynamic imports, OWNER_NOTIFY_TELEGRAM_DISABLED=1 so nothing real ever sends
 * (the route's 502 response still exposes the link + mode it WOULD have sent,
 * which is what we assert on).
 *
 * Verifies:
 *   1. Bearer auth: wrong/missing token → 401 (when MC_API_TOKEN set).
 *   2. Completed interview → 409 interview_complete (never re-invite).
 *   3. Fresh box (nothing answered) → START mode with the /interview link.
 *   4. Started interview (sessionId + handoff) → RESUME mode with the P0-7
 *      slug-contract link.
 *   5. Cooldown: a recorded send within the window → 409 cooldown; force:true
 *      bypasses it.
 *   6. Undeliverable owner → 502 owner_not_reachable and NO ledger row (retry
 *      is safe; no spam risk).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sendlink-ws-'));
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sendlink-db-')),
  'mission-control.test.db',
);

process.env.DATABASE_PATH = TMP_DB;
process.env.OPENCLAW_WORKSPACE_ROOT = WORKSPACE;
process.env.OPENCLAW_DASHBOARD_URL = 'https://acme.zerohumanworkforce.com';
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1'; // never send for real in tests
delete process.env.OPENCLAW_OWNER_CHAT_ID;

const MC_API_TOKEN = 'test-send-link-token';
process.env.MC_API_TOKEN = MC_API_TOKEN;

const SESSION_ID = 'sess-sendlink-1';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];

type RouteModule = typeof import('../../src/app/api/interview/send-link/route');
let POST: RouteModule['POST'];

function buildRequest(body?: unknown, token: string | null = MC_API_TOKEN): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest('http://localhost/api/interview/send-link', {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function writeBuildState(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(WORKSPACE, '.workforce-build-state.json'),
    JSON.stringify(extra, null, 2),
    'utf-8',
  );
}

function writeHandoff(): void {
  const dir = path.join(WORKSPACE, 'company-discovery');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'interview-handoff.md'),
    ['---', 'status: in_progress', 'next_question_number: 7', '---', ''].join('\n'),
    'utf-8',
  );
}

function clearWorkspace(): void {
  fs.rmSync(path.join(WORKSPACE, '.workforce-build-state.json'), { force: true });
  fs.rmSync(path.join(WORKSPACE, 'company-discovery'), { recursive: true, force: true });
}

function ledgerCount(): number {
  const row = queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM events WHERE type = 'interview_link_sent'`,
  );
  return row?.c ?? 0;
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  db.getDb(); // run migrations so the events table exists
  run = db.run;
  queryOne = db.queryOne;
  const mod = await import('../../src/app/api/interview/send-link/route');
  POST = mod.POST;
});

test.after(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
});

// ── 1. auth ───────────────────────────────────────────────────────────────────
test('rejects a missing/wrong bearer token with 401', async () => {
  clearWorkspace();
  const resMissing = await POST(buildRequest(undefined, null));
  assert.equal(resMissing.status, 401);
  const resWrong = await POST(buildRequest(undefined, 'nope'));
  assert.equal(resWrong.status, 401);
});

// ── 2. completed interview → 409 ─────────────────────────────────────────────
test('refuses to invite when the interview is already complete', async () => {
  writeBuildState({ interviewComplete: true });
  const res = await POST(buildRequest());
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'interview_complete');
  clearWorkspace();
});

// ── 3. START mode: fresh box → /interview link (send fails → 502, no ledger) ──
test('fresh box builds the START link and records nothing on a failed send', async () => {
  clearWorkspace();
  const before = ledgerCount();
  const res = await POST(buildRequest());
  assert.equal(res.status, 502, 'owner unreachable in tests (send disabled)');
  const body = await res.json();
  assert.equal(body.error, 'owner_not_reachable');
  assert.equal(body.mode, 'start');
  assert.equal(body.link, 'https://acme.zerohumanworkforce.com/interview');
  assert.equal(ledgerCount(), before, 'a failed send must not write the ledger');
});

// ── 4. RESUME mode: started interview → slug-contract resume link ────────────
test('started interview builds the P0-7 resume link', async () => {
  writeBuildState({ interviewSessionId: SESSION_ID });
  writeHandoff();
  const res = await POST(buildRequest());
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.mode, 'resume');
  assert.equal(
    body.link,
    `https://acme.zerohumanworkforce.com/onboarding/resume/${SESSION_ID}`,
  );
  clearWorkspace();
});

// ── 5. cooldown: a recent recorded send blocks; force bypasses ────────────────
test('cooldown blocks a re-send within the window; force:true bypasses', async () => {
  clearWorkspace();
  run(
    `INSERT INTO events (id, type, task_id, message, metadata, created_at)
     VALUES (?, 'interview_link_sent', NULL, 'test send', '{}', datetime('now'))`,
    [randomUUID()],
  );

  const blocked = await POST(buildRequest());
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.error, 'cooldown');

  // force:true bypasses the cooldown and proceeds to the (failing) send.
  const forced = await POST(buildRequest({ force: true }));
  assert.equal(forced.status, 502);
  const forcedBody = await forced.json();
  assert.equal(forcedBody.error, 'owner_not_reachable');
});
