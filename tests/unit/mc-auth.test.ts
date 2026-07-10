/**
 * mc-auth.test.ts — canonical task-API write-back auth (src/lib/mc-auth.ts).
 *
 * Proves the durable fix for the "carded-but-trapped" 401 defect at the source:
 *   • the write-back instruction block handed to EVERY dispatched agent carries
 *     `Authorization: Bearer $MC_API_TOKEN` on all three calls (activities,
 *     deliverables, PATCH status) — the single canonical way, shared by both
 *     dispatch paths so neither can drift back to the no-auth form; and
 *   • the FAIL-LOUD dispatch guard reports a clear, token-named reason when
 *     MC_API_TOKEN is missing on a box that would 401 the agent's write-back,
 *     so a task is never dispatched into a silent-401 trap.
 *
 *   node --import tsx --test tests/unit/mc-auth.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getMcApiToken,
  isInsecureOpenApi,
  missionControlAuthHeaders,
  checkTaskWriteAuth,
  isAuthFailureStatus,
  MissionControlWriteError,
  renderWriteBackInstructions,
} from '../../src/lib/mc-auth';

// Snapshot + restore the env keys these tests mutate.
const SAVED = {
  MC_API_TOKEN: process.env.MC_API_TOKEN,
  ALLOW_INSECURE_OPEN_API: process.env.ALLOW_INSECURE_OPEN_API,
  NODE_ENV: process.env.NODE_ENV,
};
function restoreEnv() {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string>)[k] = v;
  }
}

test('missionControlAuthHeaders: Bearer when set, empty when unset', () => {
  try {
    process.env.MC_API_TOKEN = 'test-mc-token-123';
    assert.equal(getMcApiToken(), 'test-mc-token-123');
    assert.deepEqual(missionControlAuthHeaders(), { Authorization: 'Bearer test-mc-token-123' });

    delete process.env.MC_API_TOKEN;
    assert.equal(getMcApiToken(), undefined);
    assert.deepEqual(missionControlAuthHeaders(), {});

    // Blank / whitespace token is treated as unset (never sends "Bearer ").
    process.env.MC_API_TOKEN = '   ';
    assert.equal(getMcApiToken(), undefined);
    assert.deepEqual(missionControlAuthHeaders(), {});
  } finally {
    restoreEnv();
  }
});

test('checkTaskWriteAuth: ok when token set', () => {
  try {
    process.env.MC_API_TOKEN = 'set';
    const r = checkTaskWriteAuth();
    assert.equal(r.ok, true);
  } finally {
    restoreEnv();
  }
});

test('checkTaskWriteAuth: FAILS LOUD when token unset and not insecure-open', () => {
  try {
    delete process.env.MC_API_TOKEN;
    delete process.env.ALLOW_INSECURE_OPEN_API;
    process.env.NODE_ENV = 'production';
    const r = checkTaskWriteAuth();
    assert.equal(r.ok, false, 'guard must fail when a dispatched agent could not authenticate');
    assert.match(r.reason, /MC_API_TOKEN/, 'reason names the missing credential');
    assert.match(r.reason, /401|write-back/i, 'reason explains the write-back would 401');
  } finally {
    restoreEnv();
  }
});

test('checkTaskWriteAuth: dev insecure-open passes without a token', () => {
  try {
    delete process.env.MC_API_TOKEN;
    process.env.NODE_ENV = 'test';
    process.env.ALLOW_INSECURE_OPEN_API = 'true';
    assert.equal(isInsecureOpenApi(), true);
    const r = checkTaskWriteAuth();
    assert.equal(r.ok, true, 'dev open mode: external writes pass, dispatch allowed');
  } finally {
    restoreEnv();
  }
});

test('insecure-open is hard-gated OFF in production (mirrors middleware)', () => {
  try {
    delete process.env.MC_API_TOKEN;
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_INSECURE_OPEN_API = 'true';
    assert.equal(isInsecureOpenApi(), false, 'production must never honor the open escape hatch');
    assert.equal(checkTaskWriteAuth().ok, false, 'production without a token still fails loud');
  } finally {
    restoreEnv();
  }
});

test('renderWriteBackInstructions: BOTH dispatch paths embed the Bearer header on all 3 calls', () => {
  for (const kind of ['file', 'artifact'] as const) {
    const msg = renderWriteBackInstructions('http://localhost:4000', 'task-abc', kind, `/out/x.${kind === 'file' ? 'html' : 'png'}`);
    // The header appears on activities, deliverables, and the PATCH status call.
    const bearerCount = (msg.match(/Authorization: Bearer \$MC_API_TOKEN/g) || []).length;
    assert.ok(bearerCount >= 3, `expected the auth header on all 3 write-back calls (got ${bearerCount}) for ${kind}`);
    assert.match(msg, /\/api\/tasks\/task-abc\/activities/, 'activities endpoint present');
    assert.match(msg, /\/api\/tasks\/task-abc\/deliverables/, 'deliverables endpoint present');
    assert.match(msg, /PATCH http:\/\/localhost:4000\/api\/tasks\/task-abc/, 'PATCH status endpoint present');
    assert.match(msg, new RegExp(`"deliverable_type": "${kind}"`), 'deliverable_type matches the dispatch path');
    // Explicitly steers AWAY from the wrong token (may wrap across a line).
    assert.match(msg, /OPENCLAW_GATEWAY_TOKEN/, 'warns off the wrong (bridge) token');
    assert.match(msg, /do NOT[\s\S]{0,10}use/i, 'phrased as a prohibition');
    // Tells the agent to surface a BLOCKED reason on 401/403 instead of silently finishing.
    assert.match(msg, /401\/403/, 'instructs the agent to stop + report on an auth rejection');
  }
});

test('MissionControlWriteError: auth statuses carry a token-named hint', () => {
  assert.equal(isAuthFailureStatus(401), true);
  assert.equal(isAuthFailureStatus(403), true);
  assert.equal(isAuthFailureStatus(500), false);

  const authErr = new MissionControlWriteError(401, 'http://x/api/tasks/1/activities', 'Unauthorized');
  assert.equal(authErr.status, 401);
  assert.match(authErr.message, /AUTH failure/);
  assert.match(authErr.message, /MC_API_TOKEN/);

  const otherErr = new MissionControlWriteError(500, 'http://x/api/tasks/1/activities', 'boom');
  assert.doesNotMatch(otherErr.message, /AUTH failure/, 'non-auth failures do not claim an auth problem');
});
