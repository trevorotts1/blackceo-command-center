/**
 * archify-runs-route.test.ts — the HTTP contract of the Skill 69 archify board
 * door: POST/GET /api/archify-runs + PATCH/GET /api/archify-runs/[id].
 *
 * The lib suite (archify-runs.test.ts) proves the board semantics; this suite
 * proves the DOOR: auth parity with /api/tasks/ingest (HMAC over the exact
 * bytes received), strict body validation, and the status-code contract
 * (400 / 401 / 404 / 409 / 422 / 201-200) the producer's fail-soft caller
 * depends on. It drives the REAL route handlers, not a re-implementation.
 *
 * './_isolated-db' MUST stay the FIRST import (see its header): the handlers
 * write board rows, and without it DB_PATH would freeze to the live
 * mission-control.db.
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST, GET } from '../../src/app/api/archify-runs/route';
import {
  PATCH,
  GET as GET_BY_ID,
} from '../../src/app/api/archify-runs/[id]/route';

const ARTIFACT_URL = 'https://example.invalid/renders/architecture.html';

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function postReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/archify-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function patchReq(
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`http://localhost/api/archify-runs/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function sign(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function createBody(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    run_id: runId,
    title: 'Route Contract Run',
    diagram_type: 'architecture',
    external_run_id: 'ext-route-1',
    ...overrides,
  };
}

test('POST creates a run (201) and echoes run_id, campaign_id and external_run_id', async () => {
  const runId = `route-${uuidv4()}`;
  const res = await POST(postReq(createBody(runId)));
  assert.equal(res.status, 201);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.created, true);
  assert.equal(body.run_id, runId);
  assert.equal(body.campaign_id, runId, 'producer-parity alias for the grouping id');
  assert.equal(body.external_run_id, 'ext-route-1', 'caller-supplied external id echoed');
  assert.ok(body.parent_id);
  assert.equal((body.phases as unknown[]).length, 5);
});

test('POST replay returns 200 {created:false}; a conflicting replay returns 409', async () => {
  const runId = `route-${uuidv4()}`;
  assert.equal((await POST(postReq(createBody(runId)))).status, 201);

  const replay = await POST(postReq(createBody(runId)));
  assert.equal(replay.status, 200, 'idempotent replay is not an error');
  assert.equal(((await replay.json()) as { created: boolean }).created, false);

  const conflict = await POST(postReq(createBody(runId, { title: 'A Different Title' })));
  assert.equal(conflict.status, 409);
  const conflictBody = (await conflict.json()) as { code?: string };
  assert.equal(conflictBody.code, 'IDEMPOTENCY_CONFLICT');
});

test('POST rejects a malformed body (400) and an unknown diagram type (400)', async () => {
  const bad = await POST(postReq('{not json'));
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: string }).error, 'Invalid JSON body');

  const missing = await POST(postReq({ title: 'No diagram type' }));
  assert.equal(missing.status, 400);

  const badType = await POST(
    postReq({ run_id: `route-${uuidv4()}`, title: 'Typo type', diagram_type: 'architecure' }),
  );
  assert.equal(badType.status, 400, 'a typo in diagram_type must not create a grouping');

  // Zod issue detail is returned so the producer can log an actionable reason.
  const detail = (await badType.json()) as { details?: unknown[] };
  assert.ok(Array.isArray(detail.details) && detail.details.length > 0);
});

test('HMAC auth: wrong signature 401, correct signature accepted, unset secret = dev no-op', async () => {
  const runId = `route-${uuidv4()}`;
  const raw = JSON.stringify(createBody(runId));
  const priorSecret = process.env.WEBHOOK_SECRET;

  try {
    // WEBHOOK_SECRET unset (dev mode): the check no-ops, exactly like the
    // ad-campaigns / ingest routes.
    delete process.env.WEBHOOK_SECRET;
    assert.equal((await POST(postReq(createBody(`route-${uuidv4()}`)))).status, 201);

    process.env.WEBHOOK_SECRET = 'route-test-secret';

    const unsigned = await POST(postReq(createBody(runId)));
    assert.equal(unsigned.status, 401, 'configured secret + no header is refused');

    const wrong = await POST(postReq(createBody(runId), { 'x-webhook-signature': 'deadbeef' }));
    assert.equal(wrong.status, 401);

    const wrongLength = await POST(
      postReq(createBody(runId), { 'x-webhook-signature': sign('other-secret', raw) }),
    );
    assert.equal(wrongLength.status, 401, 'a valid-length but wrong digest is refused');

    // Signed over the EXACT bytes sent.
    const signed = await POST(
      postReq(createBody(runId), { 'x-webhook-signature': sign('route-test-secret', raw) }),
    );
    assert.equal(signed.status, 201, 'a correctly signed request is accepted');

    // A body mutation after signing must fail — proof the check is over the
    // received bytes, not a re-serialization.
    const tampered = JSON.stringify(createBody(`route-${uuidv4()}`));
    const tamperedRes = await POST(
      postReq(tampered, { 'x-webhook-signature': sign('route-test-secret', raw) }),
    );
    assert.equal(tamperedRes.status, 401);

    // PATCH is behind the same gate.
    const unsignedPatch = await PATCH(
      patchReq(runId, { phase_slug: 'received', status: 'in_progress' }),
      params(runId),
    );
    assert.equal(unsignedPatch.status, 401);
  } finally {
    if (priorSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = priorSecret;
  }
});

test('GET collection requires an id (400), 404s an unknown id, returns a known run', async () => {
  const noParam = await GET(new NextRequest('http://localhost/api/archify-runs'));
  assert.equal(noParam.status, 400);

  const unknown = await GET(
    new NextRequest(`http://localhost/api/archify-runs?run_id=route-${uuidv4()}`),
  );
  assert.equal(unknown.status, 404);

  const runId = `route-${uuidv4()}`;
  const externalId = `ext-${uuidv4()}`;
  await POST(postReq(createBody(runId, { external_run_id: externalId })));

  const byId = await GET(new NextRequest(`http://localhost/api/archify-runs?run_id=${runId}`));
  assert.equal(byId.status, 200);
  const byIdBody = (await byId.json()) as { campaign: unknown; cards: unknown[]; phases: unknown[] };
  assert.ok(byIdBody.campaign);
  assert.equal(byIdBody.cards.length, 6);
  assert.equal(byIdBody.phases.length, 5);

  // The producer can also poll by its OWN external id (deterministic lookup).
  const byExternal = await GET(
    new NextRequest(`http://localhost/api/archify-runs?external_run_id=${externalId}`),
  );
  assert.equal(byExternal.status, 200);
  const extBody = (await byExternal.json()) as { campaign: { id: string } };
  assert.equal(extBody.campaign.id, runId);

  const unknownExternal = await GET(
    new NextRequest('http://localhost/api/archify-runs?external_run_id=never-created'),
  );
  assert.equal(unknownExternal.status, 404);
});

test('PATCH moves a phase and answers 200; unknown id/phase 404; illegal move 409', async () => {
  const runId = `route-${uuidv4()}`;
  await POST(postReq(createBody(runId)));

  const moved = await PATCH(
    patchReq(runId, { phase_slug: 'authoring', status: 'in_progress', note: 'started' }),
    params(runId),
  );
  assert.equal(moved.status, 200);
  const movedBody = (await moved.json()) as { task: { status: string } };
  assert.equal(movedBody.task.status, 'in_progress');

  const unknownPhase = await PATCH(
    patchReq(runId, { phase_slug: 'p9-nope', status: 'in_progress' }),
    params(runId),
  );
  assert.equal(unknownPhase.status, 404);

  const unknownRun = await PATCH(
    patchReq(`route-${uuidv4()}`, { phase_slug: 'received', status: 'in_progress' }),
    params(`route-${uuidv4()}`),
  );
  assert.equal(unknownRun.status, 404);

  const illegal = await PATCH(
    patchReq(runId, { phase_slug: 'epic', status: 'done' }),
    params(runId),
  );
  assert.equal(illegal.status, 409, 'backlog -> done is not on the legal map');

  const badBody = await PATCH(patchReq(runId, { phase_slug: 'authoring', status: 'shipped' }), params(runId));
  assert.equal(badBody.status, 400, 'a status outside ArchifyCardStatus is refused');
});

test('PATCH registers artifact evidence so review/done clear the canonical gates', async () => {
  const runId = `route-${uuidv4()}`;
  await POST(postReq(createBody(runId)));

  // No artifact → the FIX 25 gate refuses with the actionable 422.
  const noEvidence = await PATCH(
    patchReq(runId, { phase_slug: 'validate', status: 'review' }),
    params(runId),
  );
  assert.equal(noEvidence.status, 422);
  const refusal = (await noEvidence.json()) as { code?: string; error: string };
  assert.equal(refusal.code, 'PRECONDITION_EVIDENCE');
  assert.match(refusal.error, /deliverables/, 'refusal names the remedy');

  // With the artifact → review and then done.
  await PATCH(patchReq(runId, { phase_slug: 'received', status: 'in_progress' }), params(runId));
  const review = await PATCH(
    patchReq(runId, { phase_slug: 'received', status: 'review', artifact_url: ARTIFACT_URL }),
    params(runId),
  );
  assert.equal(review.status, 200);
  const done = await PATCH(
    patchReq(runId, { phase_slug: 'received', status: 'done' }),
    params(runId),
  );
  assert.equal(done.status, 200);

  // A bogus artifact is a 400, never a fabricated evidence row.
  const bogus = await PATCH(
    patchReq(runId, { phase_slug: 'deliver', status: 'in_progress', artifact_url: 'not-a-url' }),
    params(runId),
  );
  assert.equal(bogus.status, 400);
  const bogusBody = (await bogus.json()) as { code?: string };
  assert.equal(bogusBody.code, 'INVALID_ARTIFACT_URL');

  // blocked without its structured gates is a 400 (schema-level, same rule as cards).
  const blocked = await PATCH(
    patchReq(runId, { phase_slug: 'deliver', status: 'blocked' }),
    params(runId),
  );
  assert.equal(blocked.status, 400);
});

test('GET by id returns the run; unknown id 404s', async () => {
  const runId = `route-${uuidv4()}`;
  await POST(postReq(createBody(runId)));

  const res = await GET_BY_ID(
    new NextRequest(`http://localhost/api/archify-runs/${runId}`),
    params(runId),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { campaign: { id: string }; phases: unknown[] };
  assert.equal(body.campaign.id, runId);
  assert.equal(body.phases.length, 5);

  const missing = await GET_BY_ID(
    new NextRequest('http://localhost/api/archify-runs/nope'),
    params('nope'),
  );
  assert.equal(missing.status, 404);
});

test('no response leaks the webhook secret or a stack trace', async () => {
  const runId = `route-${uuidv4()}`;
  process.env.WEBHOOK_SECRET = 'route-test-secret';
  try {
    const res = await POST(postReq(createBody(runId)));
    const text = await res.clone().text();
    assert.ok(!text.includes('route-test-secret'), 'secret never echoed');
    assert.equal(res.status, 401);
  } finally {
    delete process.env.WEBHOOK_SECRET;
  }

  const bad = await POST(postReq({ title: 'x', diagram_type: 'nope' }));
  const badText = await bad.text();
  assert.ok(!/at .*\.ts:\d+/.test(badText), 'no stack frames in an error body');
});
