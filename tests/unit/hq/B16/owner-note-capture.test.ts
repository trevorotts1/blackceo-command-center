/**
 * B16 — owner task note capture (SPEC S5 capture boundaries; plan B16).
 *
 * Acceptance proven here (swarm-plan B16 check):
 *   Q04/Q10 duplicate-safe note, wrong-company rejection, and no private chat
 *   copied as company feed.
 *
 * The route under test is the EXISTING task-message writer
 * (`src/app/api/tasks/[id]/messages/route.ts`) — it is both the business write
 * and, per SPEC S5's capture-boundary table ("Owner task note → Existing task
 * message/activity writer"), the Headquarters capture point. Every check below
 * drives the REAL handler against a throwaway DB.
 *
 * The capture helper `@/lib/hq/activity` is owned by another in-flight build
 * unit (B05) and is NOT in this worktree's base, so these tests stand in for it
 * through the route's test seam (`globalThis.__ccHqActivityAppenderForTests`).
 * The seam records the exact envelope it is handed, so the assertions below are
 * about the ENVELOPE THIS ROUTE PRODUCES — source key, event id, text, company
 * — not about B05's storage rules, which are B05's own evidence. The production
 * path still resolves the real module; nothing here ships a mock (swarm-plan
 * base_policy: "use existing test mocks/private test stubs only for absent
 * implementations; never ship mocks").
 *
 * Fixture isolation: `_isolated-db` is imported FIRST and the resolved database
 * path is printed, per qc.md Q1 ("record the actual resolved database path
 * before running").
 */

import '../../_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

// A registered SELF installation for the test host, so the route's verified
// tenant resolution has something real to resolve against — the SAME gate the
// middleware applies to this route. Set BEFORE any project import (the registry
// is read per call, but the fixture db must come first regardless).
process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
  localhost: {
    kind: 'self',
    tenantId: 'b16-fixture-tenant',
    companyId: 'fixture-company-a',
    installationId: 'b16-fixture-install',
  },
});
// The box's own identity: `resolveActiveCompanyId()` (the board's company
// resolver) reads this, so the task-scope predicate and the sealed tenant
// registration agree on ONE company — the Fable-5 attribution-drift rule.
process.env.MC_COMPANY_ID = 'fixture-company-a';

// This route is bearer-gated by `src/middleware.ts` (it is listed in
// BEARER_REQUIRED_WRITE_ROUTES), and its real caller — ONB `scripts/mc-route.sh`
// — authenticates with `Authorization: Bearer $MC_API_TOKEN`. The fixture uses
// that same established path. The value is a throwaway test constant, never a
// real credential.
const FIXTURE_API_TOKEN = 'b16-fixture-token';
process.env.MC_API_TOKEN = FIXTURE_API_TOKEN;

import { getDb, getDbPath } from '@/lib/db';
import type { HqProducerEvent } from '@/lib/hq/types';
import { POST } from '../../../../src/app/api/tasks/[id]/messages/route';

/** Every request in this file is addressed to the registered host, as the real caller is. */
const REAL_CALLER_HEADERS = {
  host: 'localhost',
  authorization: `Bearer ${FIXTURE_API_TOKEN}`,
} as const;

/* ──────────────────────────────── fixtures ──────────────────────────────── */

const COMPANY_A = 'fixture-company-a';
const COMPANY_B = 'fixture-company-b';
const WS_A = 'fixture-ws-a';
const WS_B = 'fixture-ws-b';
const WS_PRIVATE_A = 'fixture-ws-a-private';

interface Captured {
  companyId: string;
  installationId: string;
  event: HqProducerEvent;
}

/** Envelopes the route handed to the capture helper, in order. */
let captured: Captured[] = [];

type SeamHost = {
  __ccHqActivityAppenderForTests?: (
    db: unknown,
    input: { companyId: string; installationId: string; event: HqProducerEvent },
  ) => unknown;
};

function installSeam(): void {
  (globalThis as SeamHost).__ccHqActivityAppenderForTests = (_db, input) => {
    captured.push({
      companyId: input.companyId,
      installationId: input.installationId,
      event: input.event,
    });
    return { status: 'appended', duplicate: false, eventId: input.event.eventId, seq: captured.length, evictedThroughSeq: null };
  };
}

function seed(): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO companies (id, name, slug) VALUES (?, ?, ?)`,
  ).run(COMPANY_A, 'Fixture Company A', 'fixture-company-a');
  db.prepare(
    `INSERT OR REPLACE INTO companies (id, name, slug) VALUES (?, ?, ?)`,
  ).run(COMPANY_B, 'Fixture Company B', 'fixture-company-b');
  for (const [id, company] of [
    [WS_A, COMPANY_A],
    [WS_B, COMPANY_B],
    [WS_PRIVATE_A, COMPANY_A],
  ] as const) {
    db.prepare(
      `INSERT OR REPLACE INTO workspaces (id, name, slug, description, icon, company_id, sort_order)
       VALUES (?, ?, ?, 'fixture', '📁', ?, 100)`,
    ).run(id, `Ws ${id}`, id, company);
  }
}

function seedTask(id: string, workspaceId: string, requesterChannel: string | null): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO tasks (id, title, description, status, priority, workspace_id, business_id, requester_channel)
       VALUES (?, ?, 'x', 'backlog', 'medium', ?, 'default', ?)`,
    )
    .run(id, `task ${id}`, workspaceId, requesterChannel);
}

function ownerNotePost(taskId: string, content: string, retryKey?: string): NextRequest {
  const url = `http://localhost/api/tasks/${taskId}/messages`;
  const headers = new Headers({ 'content-type': 'application/json', ...REAL_CALLER_HEADERS });
  if (retryKey) headers.set('idempotency-key', retryKey);
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content, sender: 'owner' }),
  });
}

function paramsFor(taskId: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: taskId }) };
}

function noteRows(taskId: string): Array<{ id: string; message: string }> {
  return getDb()
    .prepare(
      `SELECT id, message FROM task_activities
        WHERE task_id = ? AND activity_type = 'owner_message' ORDER BY created_at ASC, rowid ASC`,
    )
    .all(taskId) as Array<{ id: string; message: string }>;
}

test.before(() => {
  seed();
  installSeam();
  console.log(`[B16] isolated database resolved at: ${getDbPath()}`);
});

test.beforeEach(() => {
  captured = [];
  installSeam();
  const db = getDb();
  db.prepare('DELETE FROM task_activities').run();
  db.prepare('DELETE FROM tasks').run();
});

/* ───────────────────────────── known-good control ───────────────────────── */

test('CONTROL: an authorized owner note on an own-company task is captured once', async () => {
  seedTask('t-control', WS_A, null);

  const response = await POST(ownerNotePost('t-control', 'Please review the draft.'), paramsFor('t-control'));
  const body = await response.json();

  assert.equal(response.status, 200, 'the known-good control must succeed');
  const rows = noteRows('t-control');
  assert.equal(rows.length, 1, 'exactly one task_activities row');
  assert.equal(body.capture_health, null, 'healthy capture reports no degradation');

  assert.equal(captured.length, 1, 'exactly one envelope handed to the capture helper');
  const env = captured[0];
  assert.equal(env.companyId, COMPANY_A, 'captured under the task-owning company');
  assert.equal(env.event.kind, 'owner_note');
  assert.equal(env.event.phase, 'recorded');
  assert.equal(env.event.taskId, 't-control');
  assert.equal(env.event.payload.text, 'Please review the draft.');
  assert.equal(env.event.eventId, rows[0].id, 'eventId IS the existing activity row id');
  assert.equal(env.event.sourceKey, `activity:${rows[0].id}`, 'SPEC S5 source key format');
  assert.equal(env.event.occurredAt, env.event.issuedAt, 'minted together, then reused');
});

/* ────────────────── 1. duplicate-safe note (no second record) ───────────── */

test('Q04/Q10 duplicate-safe: re-sending the same note with the same retry key adds no second record', async () => {
  seedTask('t-dup', WS_A, null);

  const first = await POST(ownerNotePost('t-dup', 'Ship it Friday.', 'retry-key-1'), paramsFor('t-dup'));
  assert.equal(first.status, 200);
  const afterFirst = noteRows('t-dup');
  assert.equal(afterFirst.length, 1);

  const second = await POST(ownerNotePost('t-dup', 'Ship it Friday.', 'retry-key-1'), paramsFor('t-dup'));
  assert.equal(second.status, 200, 'a retry is not an error');
  const secondBody = await second.json();

  assert.equal(noteRows('t-dup').length, 1, 'STILL exactly one record — no duplicate row on retry');
  assert.equal(secondBody.duplicate, true, 'the retry is reported as a duplicate');
  assert.equal(secondBody.activity.id, afterFirst[0].id, 'the ORIGINAL record is returned');
  assert.equal(captured.length, 1, 'no second capture attempt for an already-recorded note');
});

test('two distinct notes are two records — identical text without a retry key is not collapsed', async () => {
  seedTask('t-two', WS_A, null);

  await POST(ownerNotePost('t-two', 'Same words.'), paramsFor('t-two'));
  await POST(ownerNotePost('t-two', 'Same words.'), paramsFor('t-two'));

  assert.equal(noteRows('t-two').length, 2, 'an owner saying the same thing twice did say it twice');
  assert.equal(captured.length, 2, 'each distinct note captures its own record');
  assert.notEqual(captured[0].event.sourceKey, captured[1].event.sourceKey, 'distinct source keys');
});

test('the source key is derived from the existing record, so the same note is never captured twice', async () => {
  seedTask('t-key', WS_A, null);
  await POST(ownerNotePost('t-key', 'One note.'), paramsFor('t-key'));

  assert.equal(captured.length, 1);
  const row = noteRows('t-key')[0];
  assert.equal(captured[0].event.sourceKey, `activity:${row.id}`);
  assert.match(captured[0].event.sourceKey, /^activity:[0-9a-f-]{36}$/, 'SPEC S5: activity:<existingId>');
});

/* ───────────────────── 2. wrong-company rejection ──────────────────────── */

test('wrong-company: a foreign company cannot read the task messages (404, indistinguishable from unknown)', async () => {
  seedTask('t-foreign', WS_B, null);

  // This process's active company is A, so a task owned by company B is foreign.
  const { GET } = await import('../../../../src/app/api/tasks/[id]/messages/route');
  const foreign = await GET(
    new NextRequest('http://localhost/api/tasks/t-foreign/messages', { headers: new Headers(REAL_CALLER_HEADERS) }),
    paramsFor('t-foreign'),
  );
  assert.equal(foreign.status, 404, 'foreign task is not readable');

  const unknown = await GET(
    new NextRequest('http://localhost/api/tasks/no-such-task/messages', { headers: new Headers(REAL_CALLER_HEADERS) }),
    paramsFor('no-such-task'),
  );
  assert.equal(unknown.status, 404, 'unknown task answers the same');

  assert.deepEqual(
    await foreign.json(),
    await unknown.json(),
    'foreign and unknown responses are the same shape — no existence leak',
  );
});

test('wrong-company: a foreign company cannot WRITE a note onto the task', async () => {
  seedTask('t-foreign-write', WS_B, null);

  const response = await POST(ownerNotePost('t-foreign-write', 'Not mine to write.'), paramsFor('t-foreign-write'));
  assert.equal(response.status, 404, 'foreign task write is refused');
  assert.equal(noteRows('t-foreign-write').length, 0, 'nothing was recorded');
  assert.equal(captured.length, 0, 'nothing was captured for a foreign company');
});

/* ─────────── 3. no private chat content reaches the company feed ────────── */

test('private chat: an hq-chat task note is never captured into the company feed', async () => {
  seedTask('t-hqchat', WS_PRIVATE_A, 'hq-chat');

  const response = await POST(ownerNotePost('t-hqchat', 'Private question to my head.'), paramsFor('t-hqchat'));
  assert.equal(response.status, 200, 'the private note is still recorded on the task');

  assert.equal(noteRows('t-hqchat').length, 1, 'the note exists on the task itself');
  assert.equal(captured.length, 0, 'NO company-feed capture for a private conversation');
});

test('private chat: a ceo-chat task note is never captured into the company feed', async () => {
  seedTask('t-ceochat', WS_PRIVATE_A, 'ceo-chat');

  await POST(ownerNotePost('t-ceochat', 'Private owner conversation text.'), paramsFor('t-ceochat'));

  assert.equal(noteRows('t-ceochat').length, 1, 'recorded on the task');
  assert.equal(captured.length, 0, 'excluded from company-wide activity (SPEC S5 capture-boundaries)');
});

test('privacy control: the identical note on an ordinary task IS captured', async () => {
  // The positive control for the two negative cases above: without it, a
  // broken capture path would look like working privacy filtering.
  seedTask('t-public', WS_A, null);
  await POST(ownerNotePost('t-public', 'Private owner conversation text.'), paramsFor('t-public'));

  assert.equal(captured.length, 1, 'an ordinary task note is captured — the filter discriminates');
  assert.equal(captured[0].event.payload.text, 'Private owner conversation text.');
});

/* ─────────────────── capture failure never breaks business ──────────────── */

test('capture failure is reported honestly and never rolls back the business write', async () => {
  seedTask('t-fail', WS_A, null);
  (globalThis as SeamHost).__ccHqActivityAppenderForTests = () => {
    throw new Error('telemetry exploded');
  };

  const response = await POST(ownerNotePost('t-fail', 'The note must survive.'), paramsFor('t-fail'));
  assert.equal(response.status, 200, 'the note still succeeded');
  const body = await response.json();

  assert.equal(noteRows('t-fail').length, 1, 'the business write survived the telemetry failure');
  assert.match(String(body.capture_health), /^capture_failed:/, 'degradation is reported, not hidden');
});

test('agent reports are not owner notes and are never captured', async () => {
  seedTask('t-agent', WS_A, null);
  const request = new NextRequest('http://localhost/api/tasks/t-agent/messages', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', ...REAL_CALLER_HEADERS }),
    body: JSON.stringify({ content: 'Agent status report.', sender: 'agent' }),
  });

  await POST(request, paramsFor('t-agent'));

  const rows = getDb()
    .prepare(`SELECT activity_type FROM task_activities WHERE task_id = ?`)
    .all('t-agent') as Array<{ activity_type: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].activity_type, 'agent_message');
  assert.equal(captured.length, 0, 'an agent report is not an owner task note');
});

/* ─────────────────────────── input validation ──────────────────────────── */

test('oversize note is rejected, never truncated', async () => {
  seedTask('t-big', WS_A, null);
  const response = await POST(ownerNotePost('t-big', 'x'.repeat(8001)), paramsFor('t-big'));

  assert.equal(response.status, 413);
  assert.equal(noteRows('t-big').length, 0, 'nothing recorded');
  assert.equal(captured.length, 0, 'nothing captured');
});

test('empty content is still rejected', async () => {
  seedTask('t-empty', WS_A, null);
  const response = await POST(ownerNotePost('t-empty', '   '), paramsFor('t-empty'));
  assert.equal(response.status, 400);
});
