/**
 * ghl-hybrid-receipts.test.ts — WF18 · Command Center receipt backend.
 *
 * Acceptance: A22 (company isolation, signed receipts, idempotency, parent
 * scope, engine ownership) and A23 (verified means read back; stale/unknown
 * stays visible).
 *
 * These drive the REAL POST/GET handlers of
 * /api/tasks/[id]/ghl-operations against an isolated SQLite file, plus the
 * store's pure decision/reduction rules. No network, no live GoHighLevel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf18-receipts-')), 'db');
process.env.DATABASE_PATH = DB;
process.env.MC_COMPANY_ID = 'default';
process.env.MC_API_TOKEN = 'wf18-token';
process.env.WEBHOOK_SECRET = 'wf18-secret';
process.env.GHL_ALLOWED_LOCATION_IDS = 'SYNTHETIC_GHL_LOCATION,loc-second';
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;

import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';

let dbMod: typeof import('../../src/lib/db');
let receipts: typeof import('../../src/lib/ghl-hybrid-receipts');
let validation: typeof import('../../src/lib/validation');
let post: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let get: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const COMPANY = 'default';
const OTHER_COMPANY = 'other-co';
const WS = 'ws-wf18';
const TASK = 'task-wf18-parent';
const CHILD = 'task-wf18-child';
const FOREIGN = 'task-wf18-foreign';

function hmac(body: string): string {
  return createHmac('sha256', process.env.WEBHOOK_SECRET as string).update(body).digest('hex');
}

function signed(body: unknown, opts: { token?: string | null; signature?: string | null } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.token === undefined ? 'wf18-token' : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const signature = opts.signature === undefined ? hmac(raw) : opts.signature;
  if (signature) headers['x-webhook-signature'] = signature;
  return { raw, headers };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: '1.0.0',
    receipt_id: uuidv4(),
    attempt_id: uuidv4(),
    event_sequence: 1,
    run_id: 'run-wf18',
    operation_key: 'course:launch101:lesson:welcome:intro:create',
    operation_id: 'courses.lessons.create',
    location_id: 'SYNTHETIC_GHL_LOCATION',
    task_id: TASK,
    skill: '06',
    department: 'courses',
    rail: 'public_rest',
    outcome: 'verified',
    requested_visibility: 'draft',
    actual_visibility: 'draft',
    request_hash: 'sha256:intent-fixture',
    object_refs: { course_lesson_id: 'lesson-synthetic' },
    readback: { state: 'matched', checked_fields: ['title', 'categoryId'] },
    evidence_refs: ['evidence/redacted-readback.json'],
    observed_at: '2026-11-08T12:00:00Z',
    ...overrides,
  };
}

function envelope(r: Record<string, unknown>, bodyOverrides: Record<string, unknown> = {}) {
  return { schema_version: '1.0.0', run_id: r.run_id, operation_receipt: r, ...bodyOverrides };
}

async function postReceipt(taskId: string, body: unknown, opts: Parameters<typeof signed>[1] = {}) {
  const { raw, headers } = signed(body, opts);
  const req = new NextRequest(`http://localhost/api/tasks/${taskId}/ghl-operations`, {
    method: 'POST',
    headers,
    body: raw,
  });
  return post(req, { params: Promise.resolve({ id: taskId }) });
}

async function getReceipts(taskId: string) {
  const req = new NextRequest(`http://localhost/api/tasks/${taskId}/ghl-operations`);
  return get(req, { params: Promise.resolve({ id: taskId }) });
}

test.before(async () => {
  dbMod = await import('../../src/lib/db');
  receipts = await import('../../src/lib/ghl-hybrid-receipts');
  validation = await import('../../src/lib/validation');
  const route = await import('../../src/app/api/tasks/[id]/ghl-operations/route');
  post = route.POST as never;
  get = route.GET as never;

  const db = dbMod.getDb(); // runs schema + migrations 179
  const now = new Date().toISOString();
  dbMod.run(
    "INSERT OR IGNORE INTO companies (id,name,slug,config,created_at,updated_at) VALUES ('default','D','d','{}',?,?)",
    [now, now],
  );
  dbMod.run(
    "INSERT OR IGNORE INTO companies (id,name,slug,config,created_at,updated_at) VALUES (?,?,'o','{}',?,?)",
    [OTHER_COMPANY, 'Other', now, now],
  );
  dbMod.run(
    "INSERT OR IGNORE INTO workspaces (id,slug,name,icon,company_id,sort_order,created_at,updated_at) VALUES (?,'general-task','General Task','G','default',1,?,?)",
    [WS, now, now],
  );
  const seedTask = (id: string, source: string | null, parent: string | null, company: string) => {
    const ws = `${id}-ws`;
    dbMod.run(
      "INSERT OR IGNORE INTO workspaces (id,slug,name,icon,company_id,sort_order,created_at,updated_at) VALUES (?,?,?,'G',?,1,?,?)",
      [ws, `slug-${id}`, id, company, now, now],
    );
    dbMod.run(
      `INSERT INTO tasks (id,title,description,status,priority,workspace_id,business_id,source,parent_task_id,created_at,updated_at)
       VALUES (?,?,'seed','backlog','medium',?,NULL,?,?,?,?)`,
      [id, `card ${id}`, ws, source, parent, now, now],
    );
  };
  seedTask(TASK, 'ghl-hybrid', null, COMPANY);
  seedTask(CHILD, 'ghl-hybrid', TASK, COMPANY);
  seedTask(FOREIGN, 'ghl-hybrid', null, OTHER_COMPANY);
  void db;
});

test.after(() => {
  try { dbMod?.closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(DB), { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Pure redaction / hashing ────────────────────────────────────────────────

test('[A22] redaction strips secrets and absolute private paths deterministically', () => {
  const payload = {
    note: 'ok',
    authorization: 'Bearer live-token',
    nested: { refreshToken: 'abc', cookie: 'sid=1', keep: 'value' },
    path: '/Users/someone/private/evidence.json',
    inline: 'read /private/tmp/x.json now',
    headers: { 'x-api-key': 'k-123' },
  };
  const once = receipts.redactGhlReceipt(payload);
  const twice = receipts.redactGhlReceipt(payload);
  assert.deepEqual(once, twice, 'redaction must be deterministic (idempotency depends on it)');
  const flat = JSON.stringify(once);
  assert.ok(!flat.includes('live-token'));
  assert.ok(!flat.includes('abc'));
  assert.ok(!flat.includes('k-123'));
  assert.ok(!flat.includes('/Users/someone'));
  assert.ok(flat.includes('[redacted-path]'));
  assert.equal((once as any).nested.keep, 'value', 'non-secret fields survive');
});

test('[A22] intent hash uses the producer request_hash, else intent fields only', () => {
  const r1 = receipt({ request_hash: 'sha256:given' });
  assert.equal(receipts.receiptIntentHash(r1 as never), 'sha256:given');
  const r2 = receipt({ request_hash: null });
  const r3 = receipt({ request_hash: null, evidence_refs: ['different/diagnostic.json'] });
  assert.equal(
    receipts.receiptIntentHash(r2 as never),
    receipts.receiptIntentHash(r3 as never),
    'diagnostics must not change intent identity',
  );
});

// ── Idempotency / monotonicity ──────────────────────────────────────────────

test('[A22] decision: identical replay acknowledged, changed bytes conflict, sequence must advance', () => {
  const id = uuidv4();
  const attempt = uuidv4();
  const stored = [{
    receipt_id: id,
    attempt_id: attempt,
    event_sequence: 1,
    outcome: 'verified',
    event_bytes_hash: 'hash-a',
  }];

  assert.equal(
    receipts.decideReceiptEvent(stored as never, {
      receipt_id: id, attempt_id: attempt, event_sequence: 1, outcome: 'verified', event_bytes_hash: 'hash-a',
    }).action,
    'replay',
  );
  assert.equal(
    receipts.decideReceiptEvent(stored as never, {
      receipt_id: id, attempt_id: attempt, event_sequence: 1, outcome: 'failed', event_bytes_hash: 'hash-b',
    }).action,
    'conflict',
  );
  assert.equal(
    receipts.decideReceiptEvent(stored as never, {
      receipt_id: uuidv4(), attempt_id: attempt, event_sequence: 1, outcome: 'verified', event_bytes_hash: 'hash-a',
    }).action,
    'conflict',
    'a different event cannot reuse a consumed sequence',
  );
  const staleEvent = receipts.decideReceiptEvent(stored as never, {
    receipt_id: uuidv4(), attempt_id: attempt, event_sequence: 0 as never, outcome: 'processing', event_bytes_hash: 'hash-c',
  });
  assert.equal(staleEvent.action, 'stale');
  assert.equal(
    receipts.decideReceiptEvent(stored as never, {
      receipt_id: uuidv4(), attempt_id: uuidv4(), event_sequence: 2, outcome: 'processing', event_bytes_hash: 'hash-d',
    }).action,
    'stale',
    'a later pending event from a DIFFERENT attempt cannot displace verified',
  );
  assert.equal(
    receipts.decideReceiptEvent(stored as never, {
      receipt_id: uuidv4(), attempt_id: attempt, event_sequence: 2, outcome: 'verified', event_bytes_hash: 'hash-e',
    }).action,
    'insert',
  );
});

test('[A23] verified requires a matched readback', () => {
  assert.equal(
    receipts.isVerifiableOutcome({ outcome: 'verified', readback: { state: 'matched' } } as never),
    true,
  );
  assert.equal(
    receipts.isVerifiableOutcome({ outcome: 'verified', readback: { state: 'not_run' } } as never),
    false,
  );
  assert.equal(
    receipts.isVerifiableOutcome({ outcome: 'verified', readback: null } as never),
    false,
  );
  assert.equal(
    receipts.isVerifiableOutcome({ outcome: 'submitted', readback: null } as never),
    true,
  );
});

// ── HTTP: auth, company isolation, location, provenance, parent scope ───────

test('[A22] unsigned / wrong-token receipts are refused', async () => {
  const body = envelope(receipt());
  assert.equal((await postReceipt(TASK, body, { signature: null })).status, 401);
  assert.equal((await postReceipt(TASK, body, { signature: 'deadbeef' })).status, 401);
  assert.equal((await postReceipt(TASK, body, { token: 'wrong' })).status, 401);
});

test('[A22] a valid receipt for a ghl-hybrid card is stored and readable', async () => {
  const r = receipt();
  const res = await postReceipt(TASK, envelope(r));
  const json = await res.json() as Record<string, unknown>;
  assert.equal(res.status, 200);
  assert.equal(json.status, 'inserted');
  assert.equal(json.receipt_id, r.receipt_id);

  const read = await getReceipts(TASK);
  const readJson = await read.json() as { operations: Array<Record<string, unknown>> };
  assert.equal(read.status, 200);
  const op = readJson.operations.find((o) => o.operation_key === r.operation_key);
  assert.ok(op, 'GET must list the stored operation');
  assert.equal(op?.outcome, 'verified');
  assert.equal(op?.event_count, 1);
});

test('[A22] identical replay is acknowledged; changed bytes at the same identity conflict', async () => {
  const r = receipt({ operation_key: 'course:launch101:module:welcome:create' });
  const body = envelope(r);
  assert.equal((await postReceipt(TASK, body)).status, 200);
  const replay = await postReceipt(TASK, body);
  const replayJson = await replay.json() as Record<string, unknown>;
  assert.equal(replay.status, 200);
  assert.equal(replayJson.status, 'replay');
  assert.equal(replayJson.applied, false);

  const changed = envelope(receipt({ ...r, outcome: 'failed', readback: { state: 'not_run' } }));
  const conflict = await postReceipt(TASK, changed);
  assert.equal(conflict.status, 409);
  assert.match(String((await conflict.json() as Record<string, unknown>).detail), /receipt_id_reused_with_different_bytes/);
});

test('[A22] a body company_id can never override server context', async () => {
  const r = receipt({ company_id: OTHER_COMPANY, operation_key: 'company:override' });
  const res = await postReceipt(TASK, envelope(r));
  assert.equal(res.status, 403);
  assert.match(String((await res.json() as Record<string, unknown>).detail), /company_mismatch/);
});

test('[A22] another company\'s task UUID is a 404, not a cross-tenant read', async () => {
  const res = await postReceipt(FOREIGN, envelope(receipt({ task_id: FOREIGN, operation_key: 'cross:tenant' })));
  assert.equal(res.status, 404);
  const read = await getReceipts(FOREIGN);
  assert.equal(read.status, 404);
});

test('[A22] a location outside the company allow-list is refused even when signed', async () => {
  const r = receipt({ location_id: 'UNAUTHORIZED_LOCATION', operation_key: 'loc:escape' });
  const res = await postReceipt(TASK, envelope(r));
  assert.equal(res.status, 403);
  const json = await res.json() as Record<string, unknown>;
  assert.match(String(json.detail), /location_not_allowed/);
});

test('[A22] source provenance: a non-ghl-hybrid card refuses receipts', async () => {
  const now = new Date().toISOString();
  dbMod.run(
    `INSERT INTO tasks (id,title,description,status,priority,workspace_id,business_id,source,created_at,updated_at)
     VALUES ('task-wf18-funnel','funnel card','x','backlog','medium',?,NULL,'funnel',?,?)`,
    [WS, now, now],
  );
  const res = await postReceipt('task-wf18-funnel', envelope(receipt({ task_id: 'task-wf18-funnel' })));
  assert.equal(res.status, 403);
  assert.match(String((await res.json() as Record<string, unknown>).error), /not a ghl-hybrid producer card/);
});

test('[A22] parent-child scope is enforced for the card and for the receipt', async () => {
  // A child may receipt its own parent.
  const ok = await postReceipt(CHILD, envelope(receipt({
    task_id: CHILD,
    parent_task_id: TASK,
    operation_key: 'child:own-parent',
  })));
  assert.equal(ok.status, 200);

  // A receipt naming an unrelated parent is refused.
  const bad = await postReceipt(CHILD, envelope(receipt({
    task_id: CHILD,
    parent_task_id: FOREIGN,
    operation_key: 'child:foreign-parent',
  })));
  assert.equal(bad.status, 403);
  assert.match(String((await bad.json() as Record<string, unknown>).detail), /receipt_parent_out_of_scope/);
});

test('[A23] verified without a matched readback is refused (a 2xx is not evidence)', async () => {
  const r = receipt({
    operation_key: 'course:unverified',
    readback: { state: 'not_run' },
  });
  const res = await postReceipt(TASK, envelope(r));
  assert.equal(res.status, 422);
  assert.match(String((await res.json() as Record<string, unknown>).detail), /verified_requires_matched_readback/);
});

test('[A23] unknown_outcome stays visible and is flagged for reconciliation', async () => {
  const r = receipt({
    operation_key: 'course:ambiguous-create',
    outcome: 'unknown_outcome',
    readback: { state: 'unknown' },
    event_sequence: 1,
    receipt_id: uuidv4(),
  });
  const res = await postReceipt(TASK, envelope(r));
  assert.equal(res.status, 200);
  const read = await getReceipts(TASK);
  const json = await read.json() as { operations: Array<Record<string, unknown>>; needs_reconciliation: boolean };
  const op = json.operations.find((o) => o.operation_key === 'course:ambiguous-create');
  assert.ok(op);
  assert.equal(op?.outcome, 'unknown_outcome');
  assert.equal(op?.needs_reconciliation, true);
  assert.equal(json.needs_reconciliation, true);
});

test('[A23] an older event never overwrites a later verified outcome', async () => {
  const runId = 'run-monotonic';
  const verified = receipt({ run_id: runId, operation_key: 'mono:op', event_sequence: 5, outcome: 'verified' });
  assert.equal((await postReceipt(TASK, envelope(verified))).status, 200);

  const older = receipt({
    run_id: runId,
    operation_key: 'mono:op',
    event_sequence: 4,
    outcome: 'processing',
    readback: { state: 'not_run' },
  });
  const res = await postReceipt(TASK, envelope(older));
  const json = await res.json() as Record<string, unknown>;
  assert.equal(res.status, 200);
  assert.equal(json.status, 'stale');
  assert.equal(json.applied, false);

  const read = await getReceipts(TASK);
  const ops = (await read.json() as { operations: Array<Record<string, unknown>> }).operations;
  assert.equal(ops.find((o) => o.operation_key === 'mono:op')?.outcome, 'verified');
});

test('[A22] stored receipt events are immutable at the database level', () => {
  assert.throws(
    () => dbMod.run("UPDATE ghl_operation_receipts SET outcome = 'failed' WHERE task_id = ?", [TASK]),
    /immutable/,
  );
});

test('[A22] receipt rows never carry unredacted secrets', () => {
  const rows = dbMod.queryAll<{ receipt_json: string }>(
    'SELECT receipt_json FROM ghl_operation_receipts WHERE company_id = ?',
    [COMPANY],
  );
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(!/Bearer |live-token|set-cookie/i.test(row.receipt_json));
  }
});

// ── WF18-CP01 fixture ───────────────────────────────────────────────────────

test('[WF18-CP01] the frozen request/response fixture validates against the shared schema', () => {
  const parsed = validation.GhlOperationIngestSchema.safeParse(receipts.GHL_RECEIPT_REQUEST_EXAMPLE);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? {} : parsed.error.issues));
  assert.equal(receipts.GHL_RECEIPT_RESPONSE_EXAMPLE.ok, true);
  assert.equal(receipts.GHL_RECEIPT_RESPONSE_EXAMPLE.status, 'inserted');

  const badRun = validation.GhlOperationIngestSchema.safeParse({
    ...receipts.GHL_RECEIPT_REQUEST_EXAMPLE,
    run_id: uuidv4(),
  });
  assert.equal(badRun.success, false, 'envelope run_id must equal receipt run_id');

  const badRail = validation.GhlOperationReceiptSchema.safeParse({
    ...receipts.GHL_RECEIPT_REQUEST_EXAMPLE.operation_receipt,
    rail: 'telepathy',
  });
  assert.equal(badRail.success, false, 'unknown rails are refused');
});
