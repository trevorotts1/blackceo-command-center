/**
 * ilj004-skipped-server-persistence.test.ts — ILJ-004 server-side skip marks.
 *
 * Defect: skips lived only in InterviewClient sessionStorage, so a device
 * switch lost them. Fix: tenant_interview_skips table (server) + the state
 * route's POST writer / GET reader + mergeSkippedIds client merge.
 *
 *   T1  pure: sanitizeSkippedIds drops unknown/answered/dupes, deck order
 *   T2  pure: mergeSkippedIds unions server + local sets, answers win
 *   T3  pure: skippedQuestionNumbers maps ids to 1-based card numbers
 *   T4  pure: computeStructuredResume `skippedIds` is additive — omitted arg
 *       behaves exactly like the pre-ILJ-004 two-arg call; skips advance the
 *       forward resume index but stay in the deck (remainingIds)
 *   T5  server: POST records a skip; GET (client branch) returns the skipped
 *       set — the cross-device resume proof (second-device fetch)
 *   T6  server: POST refuses unknown ids (400), self tenants (400), skips for
 *       answered questions (409); answering wins over a stored skip
 *   T7  server: skip storage never touches the answers table (no fabricated
 *       transcript-shaped rows)
 *
 * Run: node --import tsx --test tests/unit/ilj004-skipped-server-persistence.test.ts
 */
import '../unit/_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { getDb, run, queryAll } from '../../src/lib/db';
import { ensureTenantInterview, tenantAnswers, queueInterviewOperation } from '../../src/lib/interview/remote-store';
import {
  sanitizeSkippedIds,
  mergeSkippedIds,
  skippedQuestionNumbers,
  computeStructuredResume,
} from '../../src/lib/interview/structured-progress';
import { INTERVIEW_QUESTIONS } from '../../src/lib/interview-questions';

process.env.MC_API_TOKEN = 'ilj004-fixture-token';
process.env.MC_INTERVIEW_SECRET = 'ilj004-encryption-key';
process.env.MC_INTERVIEW_COOKIE_SECRET = 'ilj004-cookie-key';
process.env.OPENCLAW_WORKSPACE_ROOT = process.env.CC_TEST_FIXTURE_ROOT!;
process.env.OPENCLAW_SKILL23_SCRIPTS = path.join(process.env.CC_TEST_FIXTURE_ROOT!, 'absent-scripts');
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;

const registry = {
  'skip-a.example': { tenantId: 'skip-tenant-a', companyId: 'skip-company-a', kind: 'client', clientId: 'skip-client-a', installationId: 'skip-install-a' },
  'skip-b.example': { tenantId: 'skip-tenant-b', companyId: 'skip-company-b', kind: 'client', clientId: 'skip-client-b', installationId: 'skip-install-b' },
  'skip-self.example': { tenantId: 'skip-operator', companyId: 'skip-company-self', kind: 'self', installationId: 'skip-install-self' },
};
process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify(registry);

getDb();
run('INSERT OR IGNORE INTO companies(id,name,slug) VALUES(?,?,?)', ['skip-company-a', 'skip-company-a', 'skip-company-a']);
run('INSERT OR IGNORE INTO companies(id,name,slug) VALUES(?,?,?)', ['skip-company-b', 'skip-company-b', 'skip-company-b']);
run('INSERT OR IGNORE INTO companies(id,name,slug) VALUES(?,?,?)', ['skip-company-self', 'skip-company-self', 'skip-company-self']);
run('INSERT OR IGNORE INTO clients(id,name,is_self) VALUES(?,?,0)', ['skip-client-a', 'skip-client-a']);
run('INSERT OR IGNORE INTO clients(id,name,is_self) VALUES(?,?,0)', ['skip-client-b', 'skip-client-b']);

let GET: typeof import('../../src/app/api/interview/state/route')['GET'];
let POST: typeof import('../../src/app/api/interview/state/route')['POST'];
test.before(async () => {
  ({ GET, POST } = await import('../../src/app/api/interview/state/route'));
});

const QS = INTERVIEW_QUESTIONS;
const KNOWN = [QS[0].id, QS[1].id, QS[2].id];

function req(host: string, method: 'GET' | 'POST', body?: unknown): NextRequest {
  const init: RequestInit & { headers: Record<string, string> } = {
    method,
    headers: { host, authorization: 'Bearer ilj004-fixture-token' },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return new NextRequest(`https://${host}/api/interview/state`, init);
}

async function clientCtx(host: string) {
  const { resolveTenantContext } = await import('../../src/lib/auth/tenant-context');
  return resolveTenantContext(
    new NextRequest(`https://${host}/api/interview/state`, {
      headers: { host, authorization: 'Bearer ilj004-fixture-token' },
    }),
  );
}

// ── pure helpers ────────────────────────────────────────────────────────────

test('T1: sanitizeSkippedIds drops unknown/answered/dupes, returns deck order', () => {
  const out = sanitizeSkippedIds(QS, [KNOWN[2], 'nope', KNOWN[0], KNOWN[0], 42, null], [KNOWN[0]]);
  assert.deepEqual(out, [KNOWN[2]], 'unknown + answered + dupes + non-strings dropped');
  const ordered = sanitizeSkippedIds(QS, [KNOWN[2], KNOWN[1]]);
  assert.deepEqual(ordered, [KNOWN[1], KNOWN[2]], 'deck order, not insertion order');
});

test('T2: mergeSkippedIds unions server + local sets, answers always win', () => {
  const out = mergeSkippedIds(QS, [KNOWN[0]], [KNOWN[1], KNOWN[0]], [KNOWN[0]]);
  assert.deepEqual(out, [KNOWN[1]], 'answered id cleared from both sides');
  const union = mergeSkippedIds(QS, [KNOWN[0]], [KNOWN[1]]);
  assert.deepEqual(union, [KNOWN[0], KNOWN[1]], 'union in deck order');
});

test('T3: skippedQuestionNumbers maps ids to 1-based card numbers', () => {
  assert.deepEqual(skippedQuestionNumbers(QS, [KNOWN[0], KNOWN[2]]), [1, 3]);
  assert.deepEqual(skippedQuestionNumbers(QS, []), []);
});

test('T4: computeStructuredResume skippedIds is additive — omitted arg is the old behavior', () => {
  const answered = [KNOWN[0]];
  const legacy = computeStructuredResume(QS, answered);
  const explicit = computeStructuredResume(QS, answered, []);
  assert.deepEqual(explicit, legacy, 'empty skippedIds === pre-ILJ-004 two-arg call');
  // Skip the next card: forward resume advances PAST it, but it stays in deck.
  const withSkip = computeStructuredResume(QS, answered, [KNOWN[1]]);
  assert.equal(withSkip.nextIndex, 2, 'resume advances past the skipped card');
  assert.ok(withSkip.remainingIds.includes(KNOWN[1]), 'skipped card stays in deck for circle-back');
  assert.ok(!withSkip.complete, 'skips alone never complete the deck');
  // Skipping EVERYTHING: no forward card, deck not complete (circle-back owns it).
  const allSkipped = computeStructuredResume(QS, [], QS.map((q) => q.id));
  assert.equal(allSkipped.nextIndex, null, 'no unskipped card left to advance to');
  assert.equal(allSkipped.complete, false, 'skips are not answers');
});

// ── server round-trip (cross-device proof) ──────────────────────────────────

test('T5: POST records a skip; a second-device GET returns the skipped set', async () => {
  const post = await POST(req('skip-a.example', 'POST', { questionId: KNOWN[1] }));
  assert.equal(post.status, 200, JSON.stringify(await post.clone().json()));
  const posted = (await post.json()) as { ok: boolean; questionId: string; skippedIds: string[] };
  assert.equal(posted.ok, true);
  assert.ok(posted.skippedIds.includes(KNOWN[1]));

  // Second device: a fresh GET (no sessionStorage) carries the same skip set.
  const get = await GET(req('skip-a.example', 'GET'));
  assert.equal(get.status, 200);
  const body = (await get.json()) as {
    structured: { skippedIds: string[]; nextIndex: number | null; remainingIds: string[] };
  };
  assert.ok(body.structured.skippedIds.includes(KNOWN[1]), 'skip survived the device switch');
  assert.ok(body.structured.remainingIds.includes(KNOWN[1]), 'skipped card still in deck');
  assert.notEqual(body.structured.nextIndex, 1, 'resume does not plant the owner back on the skipped card');
});

test('T6: POST refuses unknown ids, self tenants, and skips for answered questions', async () => {
  const unknown = await POST(req('skip-a.example', 'POST', { questionId: 'not-a-question' }));
  assert.equal(unknown.status, 400);
  const self = await POST(req('skip-self.example', 'POST', { questionId: KNOWN[0] }));
  assert.equal(self.status, 400);

  // Answer KNOWN[2] for tenant B, then try to skip it → 409, and a stored skip
  // for an answered question never surfaces in GET.
  const ctxB = await clientCtx('skip-b.example');
  queueInterviewOperation(ctxB, 'answer', { questionId: KNOWN[2], prompt: 'q', answer: 'a' }, 'ilj004-op-answer-1');
  const conflict = await POST(req('skip-b.example', 'POST', { questionId: KNOWN[2] }));
  assert.equal(conflict.status, 409, 'an answer wins over a skip');

  // Stored skip cleared by a later answer: seed skip, answer, GET must drop it.
  const ctxA = await clientCtx('skip-a.example');
  const interview = ensureTenantInterview(ctxA.tenantId);
  run(
    "INSERT OR IGNORE INTO tenant_interview_skips (tenant_id, interview_id, question_id, created_at) VALUES (?, ?, ?, datetime('now'))",
    [ctxA.tenantId, interview.interview_id, KNOWN[0]],
  );
  queueInterviewOperation(ctxA, 'answer', { questionId: KNOWN[0], prompt: 'q', answer: 'a' }, 'ilj004-op-answer-2');
  const get = await GET(req('skip-a.example', 'GET'));
  const body = (await get.json()) as { structured: { skippedIds: string[] } };
  assert.ok(!body.structured.skippedIds.includes(KNOWN[0]), 'answering clears the skip');
});

test('T7: skip storage never touches the answers table', async () => {
  const answersBefore = tenantAnswers('skip-tenant-a').length;
  const post = await POST(req('skip-a.example', 'POST', { questionId: KNOWN[2] }));
  assert.equal(post.status, 200);
  assert.equal(tenantAnswers('skip-tenant-a').length, answersBefore, 'no transcript-shaped rows fabricated');
  const skipRows = queryAll<{ question_id: string }>(
    'SELECT question_id FROM tenant_interview_skips WHERE tenant_id = ?',
    ['skip-tenant-a'],
  );
  assert.ok(skipRows.some((r) => r.question_id === KNOWN[2]), 'mark landed in the skip store');
});
