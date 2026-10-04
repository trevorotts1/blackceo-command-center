/**
 * B10 — authenticated HQ chat route family (owned behaviour: the HTTP boundary only).
 *
 * Scope: identity resolution → strict body validation → ownership gate → service
 * outcome → response envelope. The durable turn state machine itself (lease/CAS,
 * dedupe, expiration, retry eligibility) is B09's, and the gateway is B11's; both are
 * absent on this branch by design, so they are reached through the private test stubs in
 * `_stubs/` wired by `tsconfig.b10.json` (swarm-plan `base_policy`: consumers use
 * private test stubs only for absent implementations, never shipping a mock).
 *
 * Acceptance covered here (swarm-plan B10 `check`, SPEC S8/S9):
 *   • Q07 foreign-before-dedupe — a foreign/unknown session is refused BEFORE any
 *     duplicate-path read of the request id, and both refusals share one shape.
 *   • message cap → 413, before ownership or storage, never truncated.
 *   • turn conflict → 409 `request_conflict` / `turn_in_progress`, draft preserved.
 *   • expiration → 410 for an expired owned session and for content-expired turns.
 *   • fixture responses match the frozen P01 contract exactly (key sets, envelope).
 *
 * Isolation: no database, no gateway, no network. The stubs are the only I/O.
 * Run (from the unit worktree root):
 *   TSX_TSCONFIG_PATH=tests/unit/hq/B10/tsconfig.b10.json \
 *     ../../node_modules/.bin/tsx --test tests/unit/hq/B10/routes.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { POST as createSession } from '../../../../src/app/api/hq/chat/sessions/route';
import { GET as getSession } from '../../../../src/app/api/hq/chat/sessions/[id]/route';
import { POST as createTurn } from '../../../../src/app/api/hq/chat/sessions/[id]/turns/route';
import { GET as getTurn } from '../../../../src/app/api/hq/chat/sessions/[id]/turns/[turnId]/route';
import { POST as retryTurn } from '../../../../src/app/api/hq/chat/sessions/[id]/turns/[turnId]/retry/route';

import { HqContextError, __hqContextControl, type HqContext } from './_stubs/context';
import { __hqChatControl, __hqChatPush, type HqChatServiceResult } from './_stubs/chat';
import type { HqChatSession, HqChatTurn } from '@/lib/hq/types';

const CTX: HqContext = {
  companyId: 'company-a',
  installationId: 'install-a',
  subject: 'owner:subject-a',
  host: 'hq.example.test',
  kind: 'self',
};

const SESSION: HqChatSession = {
  id: 'ses-1',
  headAgentId: 'agent-head-1',
  createdAt: '2026-10-04T00:00:00.000Z',
  lastActivityAt: '2026-10-04T00:00:01.000Z',
  closedAt: null,
};

const TURN: HqChatTurn = {
  id: 'turn-1',
  sessionId: 'ses-1',
  state: 'queued',
  message: 'hello head',
  reply: null,
  partial: false,
  attempts: 0,
  taskId: null,
  errorCode: null,
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:00.000Z',
  terminalAt: null,
};

/** Frozen P01 key sets — a route that leaks (or drops) a field fails here. */
const SESSION_KEYS = ['id', 'headAgentId', 'createdAt', 'lastActivityAt', 'closedAt'];
const TURN_KEYS = [
  'id', 'sessionId', 'state', 'message', 'reply', 'partial', 'attempts',
  'taskId', 'errorCode', 'createdAt', 'updatedAt', 'terminalAt',
];

function resetStubs(): void {
  __hqContextControl.calls = 0;
  __hqContextControl.next = null;
  __hqChatControl.calls = [];
  for (const key of Object.keys(__hqChatControl.queue) as (keyof typeof __hqChatControl.queue)[]) {
    __hqChatControl.queue[key] = [];
  }
}

function armContext(next: HqContext | HqContextError): void {
  __hqContextControl.next = next;
}

function arm(fn: Parameters<typeof __hqChatPush>[0], ...results: HqChatServiceResult[]): void {
  for (const result of results) __hqChatPush(fn, result);
}

function post(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://hq.example.test${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

function get(path: string): NextRequest {
  return new NextRequest(`http://hq.example.test${path}`);
}

const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

/** The stub is the only thing that can observe call order — that is the point. */
const calledFns = () => __hqChatControl.calls.map((entry) => entry.fn);

test.beforeEach(resetStubs);

test('Q07 foreign-before-dedupe: a foreign session is refused without touching the turn service', async () => {
  armContext(CTX);
  // If the route consulted createHqTurn first, this queued 409 would surface instead.
  arm('getHqSession', { ok: false, status: 404, code: 'not_found', message: 'Session not found.' });
  arm('createHqTurn', { ok: false, status: 409, code: 'request_conflict', message: 'request id reused with different content' });

  const res = await createTurn(post('/api/hq/chat/sessions/ses-foreign/turns', { clientRequestId: 'req-1', message: 'hi' }), params({ id: 'ses-foreign' }));

  assert.equal(res.status, 404);
  assert.deepEqual(calledFns(), ['getHqSession']);
  const body = await res.json();
  assert.equal(body.error.code, 'not_found');
  assert.equal(typeof body.error.retryable, 'boolean');
  assert.equal(typeof body.requestId, 'string');
});

test('foreign and unknown sessions return one indistinguishable shape (no existence leak)', async () => {
  armContext(CTX);
  arm('getHqSession', { ok: false, status: 404, code: 'not_found', message: 'Session not found.' });
  const foreign = await (await getSession(get('/api/hq/chat/sessions/ses-foreign'), params({ id: 'ses-foreign' }))).json();

  resetStubs();
  armContext(CTX);
  arm('getHqSession', { ok: false, status: 404, code: 'not_found', message: 'Session not found.' });
  const unknown = await (await getSession(get('/api/hq/chat/sessions/ses-missing'), params({ id: 'ses-missing' }))).json();

  assert.deepEqual(foreign.error, unknown.error);
});

test('message cap: oversize is 413 before ownership or storage, and is never truncated', async () => {
  armContext(CTX);
  const oversize = 'x'.repeat(32001);
  const res = await createTurn(post('/api/hq/chat/sessions/ses-1/turns', { clientRequestId: 'req-1', message: oversize }), params({ id: 'ses-1' }));

  assert.equal(res.status, 413);
  assert.deepEqual(calledFns(), [], 'no service call for an oversize body');
  const body = await res.json();
  assert.equal(body.error.code, 'message_too_large');
});

test('message cap: the schema trims first, so whitespace padding cannot smuggle an oversize message', async () => {
  armContext(CTX);
  arm('getHqSession', { ok: true, session: SESSION });
  arm('createHqTurn', { ok: true, turn: TURN, duplicate: false });

  const res = await createTurn(
    post('/api/hq/chat/sessions/ses-1/turns', { clientRequestId: 'req-1', message: `  ${'x'.repeat(32000)}  ` }),
    params({ id: 'ses-1' }),
  );

  assert.equal(res.status, 201);
  const [, , received] = __hqChatControl.calls.find((entry) => entry.fn === 'createHqTurn')!.args as [HqContext, string, { message: string }];
  assert.equal(received.message.length, 32000);
  assert.equal(received.message.startsWith(' '), false);
});

test('strict body: unknown keys are rejected, not ignored', async () => {
  armContext(CTX);
  const res = await createTurn(post('/api/hq/chat/sessions/ses-1/turns', { clientRequestId: 'req-1', message: 'hi', extra: true }), params({ id: 'ses-1' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_request');
  assert.deepEqual(calledFns(), []);
});

test('turn conflict: 409 request_conflict and 409 turn_in_progress pass through with the draft preserved', async () => {
  armContext(CTX);
  arm('getHqSession', { ok: true, session: SESSION });
  arm('createHqTurn', { ok: false, status: 409, code: 'request_conflict', message: 'request id reused with different content' });

  const conflict = await createTurn(post('/api/hq/chat/sessions/ses-1/turns', { clientRequestId: 'req-1', message: 'changed' }), params({ id: 'ses-1' }));
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.error.code, 'request_conflict');
  assert.equal('turn' in conflictBody, false);

  resetStubs();
  armContext(CTX);
  arm('getHqSession', { ok: true, session: SESSION });
  arm('createHqTurn', { ok: false, status: 409, code: 'turn_in_progress', message: 'a turn is already active in this session' });

  const inProgress = await createTurn(post('/api/hq/chat/sessions/ses-1/turns', { clientRequestId: 'req-2', message: 'second' }), params({ id: 'ses-1' }));
  assert.equal(inProgress.status, 409);
  assert.equal((await inProgress.json()).error.code, 'turn_in_progress');
});

test('duplicate turn: an identical re-send returns the existing turn, not a second one', async () => {
  armContext(CTX);
  arm('getHqSession', { ok: true, session: SESSION });
  arm('createHqTurn', { ok: true, turn: { ...TURN, attempts: 1, state: 'sending' }, duplicate: true });

  const res = await createTurn(post('/api/hq/chat/sessions/ses-1/turns', { clientRequestId: 'req-1', message: 'hello head' }), params({ id: 'ses-1' }));
  assert.equal(res.status, 200, 'duplicate is 200; only a new turn is 201');
  const body = await res.json();
  assert.equal(body.duplicate, true);
  assert.equal(body.turn.id, 'turn-1');
});

test('expiration: an expired owned session is 410 on read, turn create and retry alike', async () => {
  for (const call of [
    () => getSession(get('/api/hq/chat/sessions/ses-1'), params({ id: 'ses-1' })),
    () => createTurn(post('/api/hq/chat/sessions/ses-1/turns', { clientRequestId: 'req-1', message: 'hi' }), params({ id: 'ses-1' })),
    () => retryTurn(post('/api/hq/chat/sessions/ses-1/turns/turn-1/retry'), params({ id: 'ses-1', turnId: 'turn-1' })),
  ]) {
    resetStubs();
    armContext(CTX);
    arm('getHqSession', { ok: false, status: 410, code: 'session_expired', message: 'This conversation has expired.' });
    const res = await call();
    assert.equal(res.status, 410);
    assert.equal((await res.json()).error.code, 'session_expired');
  }
});

test('expiration: a content-expired turn is 410 on read and on retry, never re-sent empty', async () => {
  armContext(CTX);
  arm('getHqSession', { ok: true, session: SESSION });
  arm('getHqTurn', { ok: false, status: 410, code: 'content_expired', message: 'This message has expired.' });
  const read = await getTurn(get('/api/hq/chat/sessions/ses-1/turns/turn-1'), params({ id: 'ses-1', turnId: 'turn-1' }));
  assert.equal(read.status, 410);
  assert.equal((await read.json()).error.code, 'content_expired');

  resetStubs();
  armContext(CTX);
  arm('getHqSession', { ok: true, session: SESSION });
  arm('retryHqTurn', { ok: false, status: 410, code: 'content_expired', message: 'This message has expired.' });
  const retried = await retryTurn(post('/api/hq/chat/sessions/ses-1/turns/turn-1/retry'), params({ id: 'ses-1', turnId: 'turn-1' }));
  assert.equal(retried.status, 410);
});

test('retry: only the existing turn is retried — a caller body can never change the content', async () => {
  armContext(CTX);
  arm('getHqSession', { ok: true, session: SESSION });
  arm('retryHqTurn', { ok: true, turn: { ...TURN, attempts: 2, state: 'sending' } });

  const res = await retryTurn(
    post('/api/hq/chat/sessions/ses-1/turns/turn-1/retry', { message: 'different text', clientRequestId: 'req-other' }),
    params({ id: 'ses-1', turnId: 'turn-1' }),
  );
  assert.equal(res.status, 200);
  const retryCall = __hqChatControl.calls.find((entry) => entry.fn === 'retryHqTurn')!;
  assert.deepEqual(retryCall.args, [CTX, 'ses-1', 'turn-1'], 'no body reaches the retry service');
});

test('identity: context refusals keep their own status and code and never reach the service', async () => {
  armContext(new HqContextError(403, 'hq_direct_origin_required', 'Headquarters must be opened from its own origin.'));
  const direct = await createSession(post('/api/hq/chat/sessions', { headAgentId: 'agent-head-1' }));
  assert.equal(direct.status, 403);
  const body = await direct.json();
  assert.equal(body.error.code, 'hq_direct_origin_required');
  assert.equal(body.error.retryable, false);
  assert.deepEqual(calledFns(), []);

  resetStubs();
  armContext(new HqContextError(401, 'unauthenticated', 'A verified tenant identity is required.'));
  const anon = await getSession(get('/api/hq/chat/sessions/ses-1'), params({ id: 'ses-1' }));
  assert.equal(anon.status, 401);
  assert.deepEqual(calledFns(), []);
});

test('runtime unavailable: session create reports 409 in the error envelope', async () => {
  armContext(CTX);
  arm('createHqSession', { ok: false, status: 409, code: 'runtime_unavailable', message: 'That head has no runtime binding.' });
  const res = await createSession(post('/api/hq/chat/sessions', { headAgentId: 'agent-head-1' }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'runtime_unavailable');
});

test('fixture responses match the frozen contract: envelope + exact field sets, never a gateway key', async () => {
  armContext(CTX);
  arm('createHqSession', { ok: true, session: SESSION });
  const created = await createSession(post('/api/hq/chat/sessions', { headAgentId: 'agent-head-1' }));
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.schemaVersion, 1);
  assert.equal(createdBody.companyId, CTX.companyId);
  assert.equal(typeof createdBody.generatedAt, 'string');
  assert.deepEqual(Object.keys(createdBody.session).sort(), [...SESSION_KEYS].sort());
  assert.deepEqual(createdBody.session, SESSION);

  resetStubs();
  armContext(CTX);
  arm('getHqSession', { ok: true, session: SESSION });
  arm('listHqTurns', { ok: true, turns: [{ ...TURN, partial: true, state: 'awaiting_reply' }], hasMore: false, nextBefore: null });
  const sessionRead = await getSession(get('/api/hq/chat/sessions/ses-1?limit=10'), params({ id: 'ses-1' }));
  const sessionBody = await sessionRead.json();
  assert.equal(sessionBody.schemaVersion, 1);
  assert.deepEqual(Object.keys(sessionBody.session).sort(), [...SESSION_KEYS].sort());
  assert.deepEqual(Object.keys(sessionBody.turns[0]).sort(), [...TURN_KEYS].sort());
  assert.equal(sessionBody.turns[0].partial, true, 'partial text stays labelled on the read path');

  resetStubs();
  armContext(CTX);
  arm('getHqSession', { ok: true, session: SESSION });
  arm('getHqTurn', { ok: true, turn: { ...TURN, state: 'replied', reply: 'answered', terminalAt: '2026-10-04T00:00:02.000Z' } });
  const turnRead = await getTurn(get('/api/hq/chat/sessions/ses-1/turns/turn-1'), params({ id: 'ses-1', turnId: 'turn-1' }));
  const turnBody = await turnRead.json();
  assert.deepEqual(Object.keys(turnBody.turn).sort(), [...TURN_KEYS].sort());
  assert.equal(turnBody.turn.reply, 'answered');

  const serialized = JSON.stringify([createdBody, sessionBody, turnBody]);
  assert.equal(/gateway_session_key|gatewaySessionKey|runtime_agent_id/i.test(serialized), false, 'no gateway key on any browser-facing view');
});

test('page bounds: an out-of-range limit is refused instead of being silently clamped', async () => {
  armContext(CTX);
  arm('getHqSession', { ok: true, session: SESSION });
  const res = await getSession(get('/api/hq/chat/sessions/ses-1?limit=0'), params({ id: 'ses-1' }));
  assert.equal(res.status, 400);
  assert.deepEqual(calledFns(), ['getHqSession'], 'the read page is never requested with an invalid bound');
});
