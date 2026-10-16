/**
 * qc-auto-route-self-call.test.ts
 *
 * THE DEFECT (live, client box): after a QC FAIL the scorer re-routed the card
 * by HTTP-ing the box it was already running on —
 * `fetch(`${baseUrl}/api/webhooks/auto-route`)` with NO credentials. That path
 * is in the middleware's WEBHOOK_SECRET_ROUTES family, which is deliberately
 * EXCLUDED from the same-origin passthrough, so the call was rejected at the
 * gate before the handler ever ran:
 *
 *     [QCScorer] Auto-route returned 401 for task <id> — stays in backlog
 *
 * and every QC-failed card waited out the 5-minute ceo-delegation sweep.
 *
 * Proven here:
 *   1. The routing decision is a CALLABLE and runs under a fail-closed posture
 *      (WEBHOOK_SECRET and MC_API_TOKEN both set) with no credentials of its
 *      own — there is no request, so no 401 is reachable.
 *   2. CONTROL — the webhook route is still fail-closed for EXTERNAL callers:
 *      an unsigned POST gets 401, and a correctly signed one does not. Without
 *      this the first proof could be passing on a route that stopped checking.
 *   3. The scorer no longer fetches that path at all.
 *
 * No network: every case ends before dispatch is fired.
 *
 *   node --import tsx --test tests/unit/qc-auto-route-self-call.test.ts
 */

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

// The fail-closed posture the live box runs: both secrets present, so the
// middleware gate and the route's HMAC are BOTH armed.
process.env.WEBHOOK_SECRET = 'test-webhook-secret';
process.env.MC_API_TOKEN = 'test-mc-api-token';
// Keep routeTask on keyword scoring — no embedding provider, no network.
for (const k of ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY']) {
  delete process.env[k];
}

import { getDb, run } from '../../src/lib/db';
import { autoRouteTask } from '../../src/lib/routing/auto-route';

getDb(); // run the migration chain

// ── 1. The callable needs no credentials ───────────────────────────────────

test('autoRouteTask reports a missing task instead of a 401', async () => {
  const result = await autoRouteTask(`ghost-${uuidv4()}`);
  assert.equal(result.routed, false);
  assert.equal(!result.routed && result.failure, 'task-not-found');
  // The old path could not tell these apart: the middleware rejected the call
  // before the handler could look the task up, so EVERY outcome was 401.
  assert.match(!result.routed ? result.reason : '', /Task not found/);
});

test('autoRouteTask runs the real router and reports "no agent" honestly', async () => {
  // A workspace with NO agents: routeTask reaches its decision and returns null.
  // This exercises the whole routing path — company resolution, department load,
  // agent scoring — under the fail-closed posture, with no credentials passed.
  const wsId = `ws-empty-${uuidv4()}`;
  const taskId = uuidv4();
  run(`INSERT OR IGNORE INTO companies (id, name, slug) VALUES ('default', 'Default', 'default')`);
  run(
    `INSERT INTO workspaces (id, slug, name, icon, company_id, sort_order) VALUES (?, ?, ?, '📋', 'default', 900)`,
    [wsId, `empty-${uuidv4().slice(0, 8)}`, 'Empty Workspace'],
  );
  run(`INSERT INTO tasks (id, title, workspace_id, status, priority) VALUES (?, ?, ?, 'backlog', 'medium')`, [
    taskId,
    'A task nobody can take',
    wsId,
  ]);

  const result = await autoRouteTask(taskId, wsId);
  assert.equal(result.routed, false);
  assert.equal(!result.routed && result.failure, 'no-agent-available');
  // The task is still in backlog and still unassigned — the caller's documented
  // fallback (the ceo-delegation sweep) remains correct for this outcome.
  const row = getDb().prepare('SELECT status, assigned_agent_id FROM tasks WHERE id = ?').get(taskId) as {
    status: string;
    assigned_agent_id: string | null;
  };
  assert.equal(row.status, 'backlog');
  assert.equal(row.assigned_agent_id, null);
});

// ── 2. CONTROL: the HTTP door is still shut on external callers ────────────

async function postToWebhook(body: unknown, signature?: string) {
  const { POST } = await import('../../src/app/api/webhooks/auto-route/route');
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature) headers['x-webhook-signature'] = signature;
  const { NextRequest } = await import('next/server');
  return POST(
    new NextRequest('http://localhost/api/webhooks/auto-route', { method: 'POST', headers, body: raw }),
  );
}

function sign(body: unknown): string {
  return createHmac('sha256', process.env.WEBHOOK_SECRET!).update(JSON.stringify(body)).digest('hex');
}

test('an UNSIGNED external POST is still rejected with 401', async () => {
  const body = { taskId: `ghost-${uuidv4()}` };
  const resp = await postToWebhook(body);
  assert.equal(resp.status, 401);
});

test('a WRONGLY signed external POST is still rejected with 401', async () => {
  const body = { taskId: `ghost-${uuidv4()}` };
  const resp = await postToWebhook(body, createHmac('sha256', 'not-the-secret').update(JSON.stringify(body)).digest('hex'));
  assert.equal(resp.status, 401);
});

test('a CORRECTLY signed external POST reaches the shared routing logic', async () => {
  // Positive control for the two 401s above: the route is shut to bad callers,
  // not simply broken. A ghost task id gets the handler's 404, which only the
  // shared callable can produce.
  const body = { taskId: `ghost-${uuidv4()}` };
  const resp = await postToWebhook(body, sign(body));
  assert.equal(resp.status, 404);
  assert.match(((await resp.json()) as { error: string }).error, /Task not found/);
});

// ── 3. The scorer stopped HTTP-ing itself ──────────────────────────────────

test('the QC scorer calls the routing logic in process, never over HTTP', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/qc-scorer.ts'), 'utf8');
  // Strip comments first: the call site still NAMES the old route in the
  // comment explaining why it is gone, and that prose must not satisfy — or
  // fail — this check. What must be absent is a fetch of it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/api\/webhooks\/auto-route/.test(code),
    'the scorer must not call the webhook route — that self-call is what 401d',
  );
  assert.match(src, /import \{ autoRouteTask \} from '@\/lib\/routing\/auto-route';/);
  assert.match(src, /autoRouteTask\(taskId, task\.workspace_id\)/);
});

test('the webhook route delegates to the same callable it shares with the scorer', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/app/api/webhooks/auto-route/route.ts'), 'utf8');
  assert.match(src, /import \{ autoRouteTask \} from '@\/lib\/routing\/auto-route';/);
  // the auth layers stay exactly where they were
  assert.match(src, /verifyWebhookSignature/);
  assert.match(src, /status: 401/);
});
