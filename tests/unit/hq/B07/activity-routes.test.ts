/**
 * B07 focused behaviour tests — the two owned HQ activity routes.
 *
 * Acceptance (swarm-plan B07): "Q04 signature/company/size denial and Q08
 * cursor/pagination/tombstone shapes against contract fixtures."
 *
 * What is real here: BOTH route modules, their gate ORDER, their query shapes
 * against a real isolated SQLite database seeded with the S6 column set, and
 * the frozen P01 validators/responses. What is stubbed: the two paths other
 * lanes own and that do not exist in this worktree yet — `@/lib/hq/context`
 * (B02) and `@/lib/hq/activity` (B05). The stubs are test-only, injected
 * through a local resolver hook registered by `hq-stub-register.mjs`; product
 * code imports the declared contract names and ships no mock
 * (swarm-plan.base_policy).
 */
import '../../_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb } from '../../../../src/lib/db';
import type { HqProducerEvent } from '../../../../src/lib/hq/types';

const COMPANY_A = 'co-a';
const COMPANY_B = 'co-b';
const INST_A = 'inst-a';
const BEARER = 'test-bearer-value';
const WEBHOOK_SECRET = 'test-webhook-secret-value';

process.env.MC_API_TOKEN = BEARER;
process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.MC_COMPANY_ID = COMPANY_A;
process.env.MC_INSTALLATION_ID = INST_A;

type StubBag = {
  requireHqContext?: (request: unknown) => unknown;
  appendHqActivity?: (db: unknown, input: unknown) => unknown;
};
const stubs = (globalThis as unknown as { __B07_STUBS__?: StubBag }).__B07_STUBS__ ?? {};
(globalThis as unknown as { __B07_STUBS__?: StubBag }).__B07_STUBS__ = stubs;

function bootstrapSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS hq_activity (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      company_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      kind TEXT NOT NULL,
      task_id TEXT,
      actor_agent_id TEXT,
      recipient_agent_id TEXT,
      from_workspace_id TEXT,
      to_workspace_id TEXT,
      exchange_id TEXT,
      phase TEXT,
      payload_json TEXT NOT NULL,
      occurred_at TEXT,
      received_at TEXT NOT NULL,
      UNIQUE(company_id, source_key)
    );
    CREATE TABLE IF NOT EXISTS hq_activity_state (
      company_id TEXT PRIMARY KEY,
      high_seq INTEGER NOT NULL,
      pruned_through_seq INTEGER NOT NULL,
      capture_state TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT);
  `);
}

function seedActivity(companyId: string, seq: number, overrides: Record<string, unknown> = {}): void {
  getDb()
    .prepare(
      `INSERT INTO hq_activity (seq, id, company_id, source_key, content_hash, kind, task_id, actor_agent_id,
                                recipient_agent_id, exchange_id, phase, payload_json, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seq,
      (overrides.id as string) ?? `${companyId}-evt-${seq}`,
      companyId,
      (overrides.sourceKey as string) ?? `transition:audit-${companyId}-${seq}`,
      'a'.repeat(64),
      (overrides.kind as string) ?? 'task',
      (overrides.taskId as string | null) ?? null,
      (overrides.actorAgentId as string | null) ?? null,
      (overrides.recipientAgentId as string | null) ?? null,
      (overrides.exchangeId as string | null) ?? null,
      (overrides.phase as string) ?? 'created',
      (overrides.payloadJson as string) ?? JSON.stringify({ status: 'open', previousStatus: null }),
      (overrides.occurredAt as string | null) ?? null,
      (overrides.receivedAt as string) ?? '2026-10-04T00:00:00Z',
    );
}

function setCursorState(companyId: string, highSeq: number, prunedThroughSeq: number): void {
  getDb()
    .prepare(
      `INSERT INTO hq_activity_state (company_id, high_seq, pruned_through_seq, capture_state, updated_at)
       VALUES (?, ?, ?, 'ok', '2026-10-04T00:00:00Z')
       ON CONFLICT(company_id) DO UPDATE SET high_seq = excluded.high_seq, pruned_through_seq = excluded.pruned_through_seq`,
    )
    .run(companyId, highSeq, prunedThroughSeq);
}

function producerEvent(overrides: Partial<HqProducerEvent> = {}): HqProducerEvent {
  return {
    eventId: '2b0f5e2a-3d2e-4f4a-8f9b-3a2d4c5b6a70',
    sourceKey: 'transition:audit-1',
    installationId: INST_A,
    companyId: COMPANY_A,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    occurredAt: null,
    taskId: null,
    actorRuntimeId: null,
    recipientRuntimeId: null,
    fromWorkspaceId: null,
    toWorkspaceId: null,
    exchangeId: null,
    kind: 'task',
    phase: 'created',
    payload: { status: 'open', previousStatus: null },
    ...overrides,
  } as HqProducerEvent;
}

/** Canonical byte rules, re-derived locally so the route's recompute is cross-checked. */
function semanticHash(event: HqProducerEvent): string {
  const canonical = (value: unknown): string => {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${canonical(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  };
  return createHash('sha256').update(canonical(event), 'utf8').digest('hex');
}

function envelopeBody(event: HqProducerEvent, sentAt = new Date().toISOString()): string {
  return JSON.stringify({ schemaVersion: 1, sentAt, event, contentHash: semanticHash(event) });
}

async function postActivity(
  body: string,
  opts: { bearer?: string | null; signature?: string | null; host?: string } = {},
): Promise<Response> {
  const { POST } = await import('../../../../src/app/api/hq/activity/route');
  const bearer = opts.bearer === undefined ? BEARER : opts.bearer;
  const signature =
    opts.signature === undefined ? createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex') : opts.signature;
  const headers = new Headers({ 'content-type': 'application/json', host: opts.host ?? 'localhost' });
  if (bearer !== null) headers.set('authorization', `Bearer ${bearer}`);
  if (signature !== null) headers.set('x-webhook-signature', signature);
  return POST(
    new NextRequest('http://localhost/api/hq/activity', { method: 'POST', headers, body }),
  );
}

async function getActivity(query: string, host = 'localhost'): Promise<Response> {
  const { GET } = await import('../../../../src/app/api/hq/activity/route');
  return GET(new NextRequest(`http://localhost/api/hq/activity${query}`, { headers: { host } }));
}

async function getDetail(id: string, host = 'localhost'): Promise<Response> {
  const { GET } = await import('../../../../src/app/api/hq/activity/[id]/route');
  return GET(new NextRequest(`http://localhost/api/hq/activity/${id}`, { headers: { host } }), {
    params: Promise.resolve({ id }),
  });
}

const COMPANY_A_CONTEXT = { companyId: COMPANY_A, subject: 'owner-a', installationId: INST_A, kind: 'self' as const };
const COMPANY_B_CONTEXT = { companyId: COMPANY_B, subject: 'owner-b', installationId: 'inst-b', kind: 'self' as const };

bootstrapSchema();
stubs.requireHqContext = () => COMPANY_A_CONTEXT;
stubs.appendHqActivity = (_db, input) => ({
  status: 'appended',
  duplicate: false,
  eventId: (input as { event: HqProducerEvent }).event.eventId,
  seq: 1,
  evictedThroughSeq: null,
});

/* ---------------------------------------------------------------- *
 * Q04 — signature / company / size denial
 * ---------------------------------------------------------------- */

test('Q04: a missing or wrong bearer is refused and nothing is persisted', async () => {
  const body = envelopeBody(producerEvent({ eventId: '11111111-1111-4111-8111-111111111111' }));
  assert.equal((await postActivity(body, { bearer: null })).status, 401);
  assert.equal((await postActivity(body, { bearer: 'not-the-token' })).status, 401);
  const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM hq_activity WHERE company_id = ?`).get(COMPANY_A) as { n: number };
  assert.equal(rows.n, 0, 'a denied request must not reach the writer');
});

test('Q04: a missing or wrong x-webhook-signature is refused', async () => {
  const body = envelopeBody(producerEvent({ eventId: '22222222-2222-4222-8222-222222222222' }));
  assert.equal((await postActivity(body, { signature: null })).status, 401);
  assert.equal((await postActivity(body, { signature: 'f'.repeat(64) })).status, 401);
  // A signature computed over a DIFFERENT body must not verify: the check is
  // over the exact received bytes, not over a re-serialization.
  const other = envelopeBody(producerEvent({ eventId: '33333333-3333-4333-8333-333333333333' }));
  assert.equal((await postActivity(body, { signature: createHmac('sha256', WEBHOOK_SECRET).update(other).digest('hex') })).status, 401);
});

test('Q04: an unconfigured box refuses (503) rather than ingesting unauthenticated', async () => {
  const saved = process.env.WEBHOOK_SECRET;
  delete process.env.WEBHOOK_SECRET;
  try {
    const body = envelopeBody(producerEvent({ eventId: '44444444-4444-4444-8444-444444444444' }));
    assert.equal((await postActivity(body)).status, 503);
  } finally {
    process.env.WEBHOOK_SECRET = saved;
  }
});

test('Q04: oversize envelopes are refused with 413', async () => {
  const oversized = 'x'.repeat(131_073);
  const response = await postActivity(oversized, { signature: createHmac('sha256', WEBHOOK_SECRET).update(oversized).digest('hex') });
  assert.equal(response.status, 413);
});

test('Q04: duplicate object keys in the raw text are rejected before parse', async () => {
  const event = producerEvent({ eventId: '55555555-5555-4555-8555-555555555555' });
  const single = envelopeBody(event);
  const tampered = single.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
  const response = await postActivity(tampered, { signature: createHmac('sha256', WEBHOOK_SECRET).update(tampered).digest('hex') });
  assert.equal(response.status, 422);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'duplicate_object_keys');
});

test('Q04: an unknown envelope key is refused (strict object)', async () => {
  const event = producerEvent({ eventId: '66666666-6666-4666-8666-666666666666' });
  const parsed = JSON.parse(envelopeBody(event)) as Record<string, unknown>;
  parsed.rogueField = 'nope';
  const body = JSON.stringify(parsed);
  const response = await postActivity(body, { signature: createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex') });
  assert.equal(response.status, 422);
});

test('Q04: a forged company is refused by the writer BEFORE persistence', async () => {
  // The route passes the TRUSTED registered company down; B05 binds it against
  // the event body and returns foreign_source_id. The stub below reproduces that
  // binding so the route's mapping (403) is what is under test here.
  const event = producerEvent({ eventId: '77777777-7777-4777-8777-777777777777', companyId: COMPANY_B });
  const body = envelopeBody(event);
  stubs.appendHqActivity = (db, input) => {
    const typed = input as { companyId: string; event: { companyId: string } };
    if (typed.event.companyId !== typed.companyId) return { status: 'foreign_source_id', code: 'foreign_source_id' };
    return { status: 'appended', duplicate: false, eventId: 'unused', seq: 1, evictedThroughSeq: null };
  };
  const response = await postActivity(body);
  assert.equal(response.status, 403);
  const persisted = getDb().prepare(`SELECT COUNT(*) AS n FROM hq_activity`).get() as { n: number };
  assert.equal(persisted.n, 0, 'the forged event never reached the table');

  stubs.appendHqActivity = (_db, input) => ({
    status: 'appended',
    duplicate: false,
    eventId: (input as { event: HqProducerEvent }).event.eventId,
    seq: 1,
    evictedThroughSeq: null,
  });
});

test('Q04: the writer\'s expiry and capacity outcomes map to 410 / 422 / 429 / 413 / 503', async () => {
  const event = producerEvent({ eventId: '88888888-8888-4888-8888-888888888888' });
  const body = envelopeBody(event);
  const cases: Array<[Parameters<NonNullable<StubBag['appendHqActivity']>>[1], number]> = [
    [{ status: 'event_expired', code: 'event_expired' }, 410],
    [{ status: 'event_not_yet_valid', code: 'event_not_yet_valid' }, 422],
    [{ status: 'receipt_capacity', code: 'receipt_capacity' }, 429],
    [{ status: 'oversize', code: 'insufficient_retention_capacity' }, 413],
    [{ status: 'foreign_source_id', code: 'foreign_source_id' }, 403],
    [{ status: 'capture_failed', code: 'capture_failed', reason: 'engine offline' }, 503],
  ];
  for (const [outcome, expected] of cases) {
    stubs.appendHqActivity = () => outcome as ReturnType<NonNullable<StubBag['appendHqActivity']>>;
    const response = await postActivity(body);
    assert.equal(response.status, expected, `${outcome.status} must map to ${expected}`);
  }
  const retry = await (async () => {
    stubs.appendHqActivity = () => ({ status: 'receipt_capacity', code: 'receipt_capacity' });
    return postActivity(body);
  })();
  assert.equal(retry.headers.get('retry-after'), '60', 'S6 line 239 requires Retry-After on receipt capacity');

  stubs.appendHqActivity = (_db, input) => ({
    status: 'appended',
    duplicate: false,
    eventId: (input as { event: HqProducerEvent }).event.eventId,
    seq: 1,
    evictedThroughSeq: null,
  });
});

test('Q04: a tampered contentHash is refused', async () => {
  const event = producerEvent({ eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const parsed = JSON.parse(envelopeBody(event)) as Record<string, unknown>;
  parsed.contentHash = 'b'.repeat(64);
  const body = JSON.stringify(parsed);
  assert.equal((await postActivity(body, { signature: createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex') })).status, 422);
});

test('Q04: valid new / identical duplicate / conflicting content map to 201 / 200 / 409', async () => {
  const event = producerEvent({ eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sourceKey: 'transition:audit-dedupe' });
  const body = envelopeBody(event);

  stubs.appendHqActivity = (_db, input) => ({
    status: 'appended',
    duplicate: false,
    eventId: (input as { event: HqProducerEvent }).event.eventId,
    seq: 42,
    evictedThroughSeq: null,
  });
  const created = await postActivity(body);
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { duplicate: boolean; seq: number; schemaVersion: number };
  assert.equal(createdBody.duplicate, false);
  assert.equal(createdBody.seq, 42);
  assert.equal(createdBody.schemaVersion, 1);

  stubs.appendHqActivity = (_db, input) => ({
    status: 'duplicate',
    duplicate: true,
    originalSeq: 42,
    visible: false,
    eventId: (input as { event: HqProducerEvent }).event.eventId,
  });
  const duplicate = await postActivity(body);
  assert.equal(duplicate.status, 200);
  const duplicateBody = (await duplicate.json()) as { duplicate: boolean; originalSeq: number; visible: boolean };
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.originalSeq, 42);
  assert.equal(duplicateBody.visible, false);

  stubs.appendHqActivity = (_db, input) => ({
    status: 'conflict',
    code: 'content_conflict',
    eventId: (input as { event: HqProducerEvent }).event.eventId,
  });
  const conflict = await postActivity(body);
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as { error: { code: string } }).error.code, 'request_conflict');
});

/* ---------------------------------------------------------------- *
 * Q08 — cursor / pagination
 * ---------------------------------------------------------------- */

test('Q08: forward page returns same-company rows N < seq <= M ascending with hasMore and gaps legal', async () => {
  const db = getDb();
  db.exec(`DELETE FROM hq_activity; DELETE FROM hq_activity_state;`);
  // Deliberate global sequence GAPS: 3, 4, 9 for company A; 5, 6 for company B.
  seedActivity(COMPANY_A, 3);
  seedActivity(COMPANY_A, 4);
  seedActivity(COMPANY_B, 5);
  seedActivity(COMPANY_B, 6);
  seedActivity(COMPANY_A, 9);
  setCursorState(COMPANY_A, 9, 0);

  const response = await getActivity('?after=0&through=9&limit=2');
  assert.equal(response.status, 200);
  const page = (await response.json()) as {
    events: Array<{ seq: number; id: string }>;
    nextAfter: number;
    through: number;
    hasMore: boolean;
    resetRequired: boolean;
    prunedThroughSeq: number;
  };
  assert.deepEqual(page.events.map((event) => event.seq), [3, 4], 'ascending, N < seq <= M, company-scoped');
  assert.equal(page.hasMore, true);
  assert.equal(page.nextAfter, 4);
  assert.equal(page.through, 9);
  assert.equal(page.resetRequired, false);
  assert.equal(page.prunedThroughSeq, 0);

  const rest = (await (await getActivity('?after=4&through=9&limit=100')).json()) as {
    events: Array<{ seq: number }>;
    hasMore: boolean;
    nextAfter: number;
  };
  assert.deepEqual(rest.events.map((event) => event.seq), [9], 'the gap at 5-8 is legal, never an expiry');
  assert.equal(rest.hasMore, false);
  assert.equal(rest.nextAfter, 9, 'the final page reports nextAfter = through even with no further scoped rows');

  const empty = (await (await getActivity('?after=9&through=9&limit=100')).json()) as {
    events: Array<{ seq: number }>;
    nextAfter: number;
  };
  assert.deepEqual(empty.events, []);
  assert.equal(empty.nextAfter, 9);
});

test('Q08: after below prunedThroughSeq and after above highSeq both return resetRequired with no delta', async () => {
  setCursorState(COMPANY_A, 9, 4);

  // SPEC S8 line 322 resets on `after < prunedThroughSeq`; `after == pruned`
  // is a legal cursor (everything at or below it has been seen and evicted).
  const pruned = (await (await getActivity('?after=3&through=9&limit=100')).json()) as {
    events: unknown[];
    resetRequired: boolean;
    prunedThroughSeq: number;
  };
  assert.equal(pruned.resetRequired, true);
  assert.deepEqual(pruned.events, [], 'a reset must not ship a misleading delta');
  assert.equal(pruned.prunedThroughSeq, 4);

  const ahead = (await (await getActivity('?after=99&through=100&limit=100')).json()) as {
    events: unknown[];
    resetRequired: boolean;
  };
  assert.equal(ahead.resetRequired, true, 'a cursor ahead of the server high-water mark is a restore, not a delta');
  assert.deepEqual(ahead.events, []);
});

test('Q08: older history is descending and mutually exclusive with after/through', async () => {
  const older = (await (await getActivity('?before=9&limit=2')).json()) as {
    events: Array<{ seq: number }>;
    hasMore: boolean;
  };
  assert.deepEqual(older.events.map((event) => event.seq), [4, 3]);
  assert.equal(older.hasMore, false);

  assert.equal((await getActivity('?before=9&after=0')).status, 400, 'strict object rejects the mixed query');
  assert.equal((await getActivity('?through=9&limit=10')).status, 400, 'through without after is not a read mode');
  assert.equal((await getActivity('?limit=0')).status, 400, 'limit below the 1..200 range is refused');
  assert.equal((await getActivity('?after=0&through=9&limit=201')).status, 400);
});

test('Q08: a foreign company resolves to its OWN rows, never another company’s', async () => {
  stubs.requireHqContext = () => COMPANY_B_CONTEXT;
  try {
    const page = (await (await getActivity('?after=0&through=100&limit=100')).json()) as {
      events: Array<{ seq: number }>;
      companyId: string;
    };
    assert.equal(page.companyId, COMPANY_B);
    assert.deepEqual(page.events.map((event) => event.seq), [5, 6]);
  } finally {
    stubs.requireHqContext = () => COMPANY_A_CONTEXT;
  }
});

test('Q08: an unmigrated box answers 503, never a deceptive empty office', async () => {
  const db = getDb();
  // Clear cursor state so the reset branch cannot answer before storage is
  // consulted: on a real unmigrated box BOTH tables are absent (one migration).
  db.exec(`DELETE FROM hq_activity_state`);
  db.exec(`ALTER TABLE hq_activity RENAME TO hq_activity_hidden`);
  try {
    const response = await getActivity('?after=0&through=1&limit=10');
    assert.equal(response.status, 503);
  } finally {
    db.exec(`ALTER TABLE hq_activity_hidden RENAME TO hq_activity`);
  }
});

/* ---------------------------------------------------------------- *
 * Q08 — detail and tombstone
 * ---------------------------------------------------------------- */

test('Q08: detail returns a sanitized event and the exchange routing keys are stripped', async () => {
  const db = getDb();
  db.exec(`DELETE FROM hq_activity; DELETE FROM tasks; DELETE FROM agents;`);
  // `workspaces.company_id` is a real FK into `companies`, so the test company
  // must exist as a row before any scoped workspace/agent/task is seeded.
  // `companies.slug` is NOT NULL, and an OR IGNORE insert with a NULL there is
  // silently skipped (leaving the FK to fail later) — so slug is supplied.
  db.prepare(`INSERT OR REPLACE INTO companies (id, name, slug) VALUES (?, 'B07 Company A', 'b07-co-a')`).run(COMPANY_A);
  db.prepare(`INSERT OR REPLACE INTO companies (id, name, slug) VALUES (?, 'B07 Company B', 'b07-co-b')`).run(COMPANY_B);
  db.prepare(
    `INSERT OR REPLACE INTO workspaces (id, name, slug, company_id) VALUES ('ws-b07', 'B07 Test', 'b07-test', ?)`,
  ).run(COMPANY_A);
  db.prepare(`INSERT OR REPLACE INTO tasks (id, title, workspace_id) VALUES ('task-1', 'B07 detail task', 'ws-b07')`).run();
  db.prepare(`INSERT OR REPLACE INTO agents (id, name, role, workspace_id) VALUES ('agent-1', 'Ava', 'specialist', 'ws-b07')`).run();
  seedActivity(COMPANY_A, 11, {
    id: 'detail-exchange',
    sourceKey: `exchange:${'a'.repeat(64)}:replied`,
    kind: 'exchange',
    phase: 'replied',
    taskId: 'task-1',
    actorAgentId: 'agent-1',
    exchangeId: 'a'.repeat(64),
    payloadJson: JSON.stringify({
      message: 'Handoff confirmed',
      summary: 'Handoff confirmed',
      toolName: 'sessions_send',
      toolCallId: 'call-9',
      callerRunId: 'run-caller',
      targetRunId: 'run-target',
      callerSessionKey: 'agent:hq-head:main',
      targetSessionKey: 'agent:hq-specialist:main',
      sourceHook: 'after_tool_call',
      nativeStatus: 'ok',
      targetDisposition: null,
      correlationStatus: 'linked',
    }),
  });

  const response = await getDetail('detail-exchange');
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    event: { reference: string; actorLabel: string; payload: Record<string, unknown> };
    tombstone: unknown;
  };
  assert.equal(body.event.actorLabel, 'Ava');
  assert.equal(body.event.reference, `exchange:${'a'.repeat(64)}:replied`);
  assert.deepEqual(Object.keys(body.event.payload).sort(), ['message', 'summary']);
  for (const secret of ['toolCallId', 'callerRunId', 'targetRunId', 'callerSessionKey', 'targetSessionKey']) {
    assert.equal(JSON.stringify(body.event).includes(secret), false, `${secret} must not reach the public projection`);
  }
  assert.equal(body.tombstone, null);
});

test('Q08: unknown and foreign ids return the SAME 404 shape', async () => {
  seedActivity(COMPANY_B, 12, { id: 'foreign-detail' });
  const unknown = await getDetail('does-not-exist');
  const foreign = await getDetail('foreign-detail');
  assert.equal(unknown.status, 404);
  assert.equal(foreign.status, 404);
  const unknownBody = (await unknown.json()) as { error: { code: string; message: string }; requestId: string };
  const foreignBody = (await foreign.json()) as { error: { code: string; message: string } };
  assert.deepEqual(Object.keys(unknownBody).sort(), ['error', 'requestId']);
  assert.equal(unknownBody.error.message, foreignBody.error.message, 'the 404 may not leak whether another company holds the id');
});

test('Q08: a deleted source yields a tombstone with no retained target names', async () => {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO agents (id, name, role, workspace_id) VALUES ('agent-gone', 'Gone Name', 'specialist', 'ws-b07')`).run();
  seedActivity(COMPANY_A, 13, {
    id: 'tombstone-detail',
    taskId: 'task-removed',
    actorAgentId: 'agent-gone',
    payloadJson: JSON.stringify({ text: 'note to a removed task' }),
    kind: 'owner_note',
    phase: 'recorded',
  });
  db.prepare(`DELETE FROM agents WHERE id = 'agent-gone'`).run();

  const response = await getDetail('tombstone-detail');
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    event: unknown;
    tombstone: { removed: boolean; reference: string; reason: string } | null;
  };
  assert.equal(body.event, null, 'a tombstoned row returns no surviving payload');
  assert.ok(body.tombstone);
  assert.equal(body.tombstone!.removed, true);
  assert.equal(body.tombstone!.reference, 'transition:audit-co-a-13');
  assert.match(body.tombstone!.reason, /actor/);
  assert.equal(JSON.stringify(body).includes('Gone Name'), false, 'the tombstone retains no removed name');
});

test('Q08: an authenticated denial is mapped, not swallowed', async () => {
  stubs.requireHqContext = () => {
    const err = new Error('A verified tenant identity is required');
    (err as Error & { status?: number }).status = 403;
    throw err;
  };
  try {
    assert.equal((await getActivity('?after=0&through=1&limit=10')).status, 403);
    assert.equal((await getDetail('anything')).status, 403);
  } finally {
    stubs.requireHqContext = () => COMPANY_A_CONTEXT;
  }
});

test('Q08: the guard refusal keeps its SPEC-named code and retryable flag', async () => {
  // SPEC S7 line 265 (409 `company_not_bound`), line 269 (403
  // `hq_direct_origin_required`), S6 storage refusal (retryable). A route that
  // reads only `status` answers 401 'unauthorized' for all three.
  const denial = (status: number, code: string, message: string, retryable = false) => () => {
    const err = new Error(message);
    Object.assign(err, { status, code, retryable });
    throw err;
  };
  const cases: Array<[number, string, boolean]> = [
    [409, 'company_not_bound', false],
    [503, 'hq_storage_unavailable', true],
    [403, 'hq_direct_origin_required', false],
  ];
  for (const [status, code, retryable] of cases) {
    stubs.requireHqContext = denial(status, code, `${code} message`, retryable);
    try {
      for (const response of [
        await getActivity('?after=0&through=1&limit=10'),
        await getDetail('anything'),
      ]) {
        assert.equal(response.status, status);
        const body = (await response.json()) as { error: { code: string; retryable: boolean } };
        assert.equal(body.error.code, code, 'the SPEC-named code must survive the route mapping');
        assert.equal(body.error.retryable, retryable, 'the guard retryable flag must not be downgraded');
      }
    } finally {
      stubs.requireHqContext = () => COMPANY_A_CONTEXT;
    }
  }
});

test('Q08: a runtime-bound target resolves instead of tombstoning a live row', async () => {
  // The writer stores the envelope runtime binding verbatim and accepts it
  // against `agents.id OR agents.openclaw_agent_id`; a reader that resolves only
  // `agents.id` reports a LIVE runtime-bound actor as removed (event:null plus a
  // tombstone) and labels it null on the feed.
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO agents (id, name, role, workspace_id, openclaw_agent_id)
     VALUES ('agent-runtime', 'Runtime Ava', 'specialist', 'ws-b07', 'runtime-xyz')`,
  ).run();
  seedActivity(COMPANY_A, 14, {
    id: 'runtime-detail',
    kind: 'owner_note',
    phase: 'recorded',
    actorAgentId: 'runtime-xyz',
    recipientAgentId: 'runtime-xyz',
    payloadJson: JSON.stringify({ text: 'runtime-bound' }),
  });

  const detail = await getDetail('runtime-detail');
  const detailBody = (await detail.json()) as {
    event: { actorLabel: string | null; recipientLabel: string | null } | null;
    tombstone: unknown;
  };
  assert.equal(detailBody.tombstone, null, 'a LIVE runtime-bound target must not be tombstoned');
  assert.equal(detailBody.event?.actorLabel, 'Runtime Ava');
  assert.equal(detailBody.event?.recipientLabel, 'Runtime Ava');

  const feed = (await (await getActivity('?after=0&through=100&limit=100')).json()) as {
    events: Array<{ reference: string; actorLabel: string | null }>;
  };
  const row = feed.events.find((event) => event.reference === 'transition:audit-co-a-14');
  assert.equal(row?.actorLabel, 'Runtime Ava', 'the feed must label the accepted runtime-bound actor');

  // The control: a genuinely absent target still tombstones, so the widened read
  // scope did not make the S6 rule unreachable.
  seedActivity(COMPANY_A, 15, {
    id: 'absent-detail',
    kind: 'owner_note',
    phase: 'recorded',
    actorAgentId: 'runtime-not-there',
    payloadJson: JSON.stringify({ text: 'absent' }),
  });
  const absent = (await (await getDetail('absent-detail')).json()) as {
    event: unknown;
    tombstone: { removed: boolean } | null;
  };
  assert.equal(absent.event, null);
  assert.equal(absent.tombstone?.removed, true);
});
