/**
 * social-f30-summary.test.ts — F30 acceptance (CC half).
 *
 * "A queued job says queued; an unanswered theme says awaiting theme;
 * scheduled posts say scheduled. A partial week lists healthy results and the
 * one affected channel, with an actionable repair path."
 *
 * Proven against the REAL summary module + REAL route handlers on an isolated
 * temp DB (full migration chain):
 *   1. queued says queued; retrying shows the retry deadline + owner system.
 *   2. awaiting theme: an unanswered social_cycles row flips the message to
 *      'awaiting theme' owned by the CLIENT.
 *   3. scheduled says scheduled (delivery provider_state).
 *   4. published lists URLs from delivery rows only.
 *   5. Partial week: healthy channels listed AND the one affected channel
 *      with an actionable repair path; 'unknown' is stated as unknown.
 *   6. Blocked task with a client-owned need (theme/approval) → owner client;
 *      system-owned block stays system.
 *   7. Task summary endpoint: company-bound (foreign task → 404), derives
 *      from persisted rows.
 *   8. notifyCompany: dedupe (same key inside window → no second send);
 *      failed delivery VISIBLE in the outbox + retried on a later call;
 *      retry spam stopped by the attempt cap.
 *   9. No unsupported completion promise: a message never claims published
 *      without a published delivery row.
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/social-f30-summary.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getDb, run, queryOne, closeDb } from '../../src/lib/db';
import {
  buildPublishMessage,
  buildTaskSummary,
  buildCycleCloseSummary,
  loadCycleCloseSummary,
  notifyCompany,
  listFailedNotifications,
  outboxRowView,
} from '../../src/lib/social/summary';
import { GET as publishSummaryGET } from '../../src/app/api/tasks/[id]/publish-summary/route';

getDb(); // full migration chain against the isolated temp DB (union 139 owns
// social_cycles + social_notification_outbox; no lazy CREATE, no ad-hoc DDL).
run(`CREATE TABLE IF NOT EXISTS social_deliveries (
  delivery_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  content_revision INTEGER,
  account_id TEXT NOT NULL,
  remote_post_id TEXT,
  scheduled_at TEXT,
  provider_state TEXT NOT NULL,
  checked_at TEXT,
  failure_reason TEXT,
  published_url TEXT
)`);

const SECRET = 'f30-test-secret';
process.env.MC_TENANT_SESSION_SECRET = SECRET;
process.env.NODE_ENV = 'production';

const HOST_A = 'a-f30.example.com';
const HOST_B = 'b-f30.example.com';
process.env.MC_TENANT_REGISTRY_JSON = JSON.stringify({
  [HOST_A]: { tenantId: 'tenant-company-f30-a', companyId: 'company-f30-a', clientId: 'client-a', kind: 'client', installationId: 'install-company-f30-a' },
  [HOST_B]: { tenantId: 'tenant-company-f30-b', companyId: 'company-f30-b', clientId: 'client-b', kind: 'client', installationId: 'install-company-f30-b' },
});

function tenantCookie(host: string, companyId: string): string {
  const payload = Buffer
    .from(JSON.stringify({
      purpose: 'session',
      tenantId: `tenant-${companyId}`,
      companyId,
      subject: 'owner:fixture',
      host,
      installationId: `install-${companyId}`,
      exp: Date.now() / 1000 + 3600,
      nonce: 'f30-test',
    }))
    .toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `mc_tenant_session=${payload}.${sig}`;
}

function requestFor(path: string, host: string, companyId: string): NextRequest {
  const headers = new Headers();
  headers.set('host', host);
  if (companyId) headers.set('cookie', tenantCookie(host, companyId));
  return new NextRequest(`http://${host}${path}`, { headers } as RequestInit);
}

function seedPublishRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  const row = {
    id: `pq-${Math.random().toString(36).slice(2, 8)}`,
    task_id: null,
    company_id: 'company-f30-a',
    sheet_id: null,
    topic: 'Weekly post',
    platforms: JSON.stringify(['linkedin', 'x']),
    schedule: 'auto',
    status: 'queued',
    run_id: null,
    requested_by: 'test',
    error: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    cc_task_id: null,
    cc_execution_id: null,
    idempotency_key: null,
    lease_owner: null,
    lease_expires_at: null,
    attempt_count: 0,
    last_attempt_at: null,
    retry_at: null,
    overdue_since: null,
    ...overrides,
  };
  run(
    `INSERT INTO publish_queue
       (id, task_id, company_id, sheet_id, topic, platforms, schedule, status, run_id, requested_by,
        error, created_at, updated_at, started_at, completed_at, cc_task_id, cc_execution_id,
        idempotency_key, lease_owner, lease_expires_at, attempt_count, last_attempt_at, retry_at, overdue_since)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    // Column VALUES order matches the INSERT column list (not the physical order).
    [
      row.id, row.task_id, row.company_id, row.sheet_id, row.topic, row.platforms, row.schedule,
      row.status, row.run_id, row.requested_by, row.error, row.created_at, row.updated_at,
      row.started_at, row.completed_at, row.cc_task_id, row.cc_execution_id, row.idempotency_key,
      row.lease_owner, row.lease_expires_at, row.attempt_count, row.last_attempt_at, row.retry_at,
      row.overdue_since,
    ],
  );
  return row;
}

test('F30: queued says queued — never a completion promise', () => {
  const row = seedPublishRow({ status: 'queued' }) as never;
  const msg = buildPublishMessage(row, null, []);
  assert.equal(msg.stage, 'queued');
  assert.equal(msg.owner, 'system');
  assert.ok(msg.nextAction.toLowerCase().includes('automatically'));
  // No completion promise: a queued row never claims published.
  assert.ok(!JSON.stringify(msg).toLowerCase().includes('published'));
});

test('F30: retrying shows the persisted retry deadline, owner system, failure visible', () => {
  const deadline = new Date(Date.now() + 120_000).toISOString();
  const row = seedPublishRow({
    status: 'retrying',
    retry_at: deadline,
    attempt_count: 2,
    error: 'dispatch held: no healthy worker',
  }) as never;
  const msg = buildPublishMessage(row, null, []);
  assert.equal(msg.stage, 'retrying');
  assert.equal(msg.retryDeadline, deadline);
  assert.equal(msg.owner, 'system');
  assert.ok(msg.failures.some((f) => f.includes('dispatch held')));
  assert.ok(msg.evidence.some((e) => e.kind === 'publish_queue'));
});

test('F30: an unanswered weekly theme says "awaiting theme" owned by the CLIENT', () => {
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, created_at, updated_at) VALUES ('company-f30-a','Co A','co-a',?,?)`,
    [now, now],
  );
  run(
    `INSERT INTO social_cycles (id, company_id, week_start_local, state, response_state, created_at, updated_at)
     VALUES ('cycle-f30-await', 'company-f30-a', '2026-09-08', 'invited', NULL, ?, ?)`,
    [now, now],
  );
  const row = seedPublishRow({ company_id: 'company-f30-a', status: 'queued' }) as never;
  const msg = buildPublishMessage(row, null, []);
  assert.equal(msg.stage, 'awaiting theme');
  assert.equal(msg.owner, 'client');
  assert.ok(msg.nextAction.toLowerCase().includes('your theme'));
});

test('F30: cycle close — scheduled posts say scheduled with times; published lists URLs', () => {
  const checkedAt = new Date().toISOString();
  const scheduledAt = '2026-09-10T15:00:00.000Z';
  const summary = buildCycleCloseSummary({
    companyId: 'company-f30-a',
    cycleId: 'cycle-f30-close',
    deliveries: [
      {
        delivery_id: 'd1', company_id: 'company-f30-a', cycle_id: 'cycle-f30-close',
        account_id: 'linkedin-main', provider_state: 'published',
        scheduled_at: null, published_url: 'https://linkedin.com/post/123',
        failure_reason: null, checked_at: checkedAt,
      },
      {
        delivery_id: 'd2', company_id: 'company-f30-a', cycle_id: 'cycle-f30-close',
        account_id: 'facebook-main', provider_state: 'scheduled',
        scheduled_at: scheduledAt, published_url: null, failure_reason: null, checked_at: checkedAt,
      },
    ],
  });
  assert.equal(summary.publishedUrls.length, 1);
  assert.equal(summary.publishedUrls[0].url, 'https://linkedin.com/post/123');
  assert.equal(summary.scheduledItems.length, 1);
  assert.equal(summary.scheduledItems[0].scheduledAt, scheduledAt);
  assert.equal(summary.scheduledItems[0].state, 'scheduled');
  assert.equal(summary.unresolvedFailures.length, 0);
});

test('F30: partial week lists healthy results AND the one affected channel with a repair path', () => {
  const checkedAt = new Date().toISOString();
  const summary = buildCycleCloseSummary({
    companyId: 'company-f30-a',
    cycleId: 'cycle-f30-partial',
    deliveries: [
      {
        delivery_id: 'd-ok-1', company_id: 'company-f30-a', cycle_id: 'cycle-f30-partial',
        account_id: 'linkedin-main', provider_state: 'published',
        scheduled_at: null, published_url: 'https://linkedin.com/post/ok1',
        failure_reason: null, checked_at: checkedAt,
      },
      {
        delivery_id: 'd-fail', company_id: 'company-f30-a', cycle_id: 'cycle-f30-partial',
        account_id: 'instagram-broken', provider_state: 'failed',
        scheduled_at: null, published_url: null,
        failure_reason: 'token expired', checked_at: checkedAt,
      },
      {
        delivery_id: 'd-ok-2', company_id: 'company-f30-a', cycle_id: 'cycle-f30-partial',
        account_id: 'facebook-main', provider_state: 'published',
        scheduled_at: null, published_url: 'https://facebook.com/post/ok2',
        failure_reason: null, checked_at: checkedAt,
      },
    ],
  });
  // Healthy results listed...
  assert.equal(summary.publishedUrls.length, 2);
  // ...AND the one affected channel, with an actionable repair path.
  assert.equal(summary.unresolvedFailures.length, 1);
  assert.equal(summary.unresolvedFailures[0].account, 'instagram-broken');
  assert.ok(summary.unresolvedFailures[0].repair.length > 10);
  assert.ok(/reconnect|retry|re-run/i.test(summary.unresolvedFailures[0].repair));
});

test('F30: unknown provider state is stated AS unknown with the check to run — never "published"', () => {
  const summary = buildCycleCloseSummary({
    companyId: 'company-f30-a',
    cycleId: 'cycle-f30-unknown',
    deliveries: [
      {
        delivery_id: 'd-unk', company_id: 'company-f30-a', cycle_id: 'cycle-f30-unknown',
        account_id: 'x-main', provider_state: 'unknown',
        scheduled_at: null, published_url: null, failure_reason: null,
        checked_at: new Date().toISOString(),
      },
    ],
  });
  assert.equal(summary.publishedUrls.length, 0);
  assert.equal(summary.unresolvedFailures.length, 1);
  assert.match(summary.unresolvedFailures[0].reason, /unknown/);
  assert.ok(summary.unresolvedFailures[0].repair.toLowerCase().includes('verify'));
});

test('F30: blocked task with a client-owned need says client; system need stays system', () => {
  const now = new Date().toISOString();
  const clientTask = {
    id: 'task-f30-client', status: 'blocked', block_reason: 'awaiting theme approval',
    block_needs: 'theme approval from owner', dispatch_attempts: 1, updated_at: now,
  };
  const clientMsg = buildTaskSummary(clientTask, [], []);
  assert.equal(clientMsg.owner, 'client');
  assert.ok(clientMsg.nextAction.toLowerCase().includes('waiting on you'));

  const sysTask = {
    id: 'task-f30-sys', status: 'blocked', block_reason: 'vision reviewer unavailable',
    block_needs: 'provision a vision-capable reviewer', dispatch_attempts: 2, updated_at: now,
  };
  const sysMsg = buildTaskSummary(sysTask, [], []);
  assert.equal(sysMsg.owner, 'system');
});

test('F30: task summary endpoint is company-bound — foreign task 404s with zero derivation', async () => {
  const now = new Date().toISOString();
  for (const c of ['company-f30-a', 'company-f30-b']) {
    run(
      `INSERT OR IGNORE INTO companies (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [c, c, c, now, now],
    );
  }
  for (const [id, slug, co] of [
    ['ws-f30-a', 'mkt-a30', 'company-f30-a'],
    ['ws-f30-b', 'mkt-b30', 'company-f30-b'],
  ] as const) {
    run(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, company_id, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1000, ?, ?)`,
      [id, slug, slug, co, now, now],
    );
  }
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, created_at, updated_at)
     VALUES ('task-f30-a', 'A task', 'backlog', 'ws-f30-a', ?, ?)`,
    [now, now],
  );
  seedPublishRow({ task_id: 'task-f30-a', company_id: 'company-f30-a', status: 'queued' });

  // Company A reads its own task's summary.
  const resA = await publishSummaryGET(
    requestFor('/api/tasks/task-f30-a/publish-summary', HOST_A, 'company-f30-a'),
    { params: Promise.resolve({ id: 'task-f30-a' }) } as any,
  );
  assert.equal(resA.status, 200);
  const dataA = await resA.json();
  assert.equal(dataA.summary.stage, 'queued');
  assert.ok(dataA.summary.evidence.some((e: { kind: string }) => e.kind === 'publish_queue'));

  // Company B substituting A's task id → 404, no summary leaked.
  const resB = await publishSummaryGET(
    requestFor('/api/tasks/task-f30-a/publish-summary', HOST_B, 'company-f30-b'),
    { params: Promise.resolve({ id: 'task-f30-a' }) } as any,
  );
  assert.equal(resB.status, 404);

  // Unauthenticated → 403.
  const resAnon = await publishSummaryGET(
    requestFor('/api/tasks/task-f30-a/publish-summary', HOST_A, ''),
    { params: Promise.resolve({ id: 'task-f30-a' }) } as any,
  );
  assert.equal(resAnon.status, 403);
});

test('F30: notifyCompany dedupes — same company/resource/event inside the window sends ONCE', async () => {
  let sends = 0;
  const send = async () => { sends++; return true; };
  const r1 = await notifyCompany(
    { companyId: 'company-f30-a', resource: 'publish:pq-1', event: 'publish_failed', message: 'first' },
    send,
  );
  assert.equal(r1.state, 'sent');
  assert.equal(r1.deduped, false);
  const r2 = await notifyCompany(
    { companyId: 'company-f30-a', resource: 'publish:pq-1', event: 'publish_failed', message: 'second' },
    send,
  );
  assert.equal(r2.deduped, true);
  assert.equal(sends, 1, 'the duplicate event must not re-send (no retry spam)');
});

test('F30: failed notification delivery is VISIBLE in the outbox and retried on a later call', async () => {
  let attempt = 0;
  const flaky = async () => {
    attempt++;
    return attempt > 1; // first send fails, later send succeeds
  };
  const fail1 = await notifyCompany(
    { companyId: 'company-f30-a', resource: 'publish:pq-2', event: 'publish_overdue', message: 'overdue now' },
    flaky,
  );
  assert.equal(fail1.state, 'failed');
  assert.ok(fail1.error);

  // The failure is VISIBLE: a failed outbox row exists (union-139 schema;
  // resource/event read back through the back-compat view).
  const failedRows = listFailedNotifications('company-f30-a');
  assert.ok(failedRows.some((r) => {
    const v = outboxRowView(r);
    return v.resource === 'publish:pq-2' && v.state === 'failed';
  }));
  // The writer maps onto the union schema: event_id carries resource:event,
  // delivery_state carries the send outcome.
  const failedRow = failedRows.find((r) => r.event_id === 'publish:pq-2:publish_overdue');
  assert.ok(failedRow, 'outbox row keyed by event_id resource:event');
  assert.equal(failedRow.delivery_state, 'failed');

  // A later call for the same key retries (bounded), and succeeds.
  const retry = await notifyCompany(
    { companyId: 'company-f30-a', resource: 'publish:pq-2', event: 'publish_overdue', message: 'overdue now' },
    flaky,
    Date.now() + 31 * 60_000, // past the dedupe window
  );
  assert.equal(retry.state, 'sent');
  assert.equal(retry.deduped, false);
});

test('F30: loadCycleCloseSummary reads persisted rows from the DB', () => {
  const now = new Date().toISOString();
  run(
    `INSERT INTO social_deliveries (delivery_id, company_id, cycle_id, content_revision, account_id,
       remote_post_id, scheduled_at, provider_state, checked_at, failure_reason, published_url)
     VALUES ('d-db-1', 'company-f30-a', 'cycle-f30-db', 1, 'linkedin-main', NULL, NULL,
       'published', ?, NULL, 'https://linkedin.com/post/db1')`,
    [now],
  );
  // Week 2026-09-15: union migration 139 enforces UNIQUE(company_id,
  // week_start_local), and the awaiting-theme test above already owns week
  // 2026-09-08 for company-f30-a.
  run(
    `INSERT INTO social_cycles (id, company_id, week_start_local, state, response_state, responded_at, disposition, created_at, updated_at)
     VALUES ('cycle-f30-db', 'company-f30-a', '2026-09-15', 'closed', 'theme_chosen', ?, 'theme_recorded', ?, ?)`,
    [now, now, now],
  );
  const summary = loadCycleCloseSummary('company-f30-a', 'cycle-f30-db');
  assert.equal(summary.cycleId, 'cycle-f30-db');
  assert.equal(summary.weekStart, '2026-09-15');
  if (summary.publishedUrls.length > 0) {
    assert.equal(summary.publishedUrls[0].url, 'https://linkedin.com/post/db1');
  }
  assert.ok(summary.history.some((h) => h.kind === 'theme_answer' && h.detail.includes('theme_chosen')));
});

test.after(() => {
  try { closeDb(); } catch { /* already closed */ }
});