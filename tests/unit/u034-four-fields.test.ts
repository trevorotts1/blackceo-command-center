/**
 * u034-four-fields.test.ts — U034: Accept and persist the four fields
 * eight producers have been sending all along.
 *
 * Runs against a THROWAWAY DB — enforced HERE, in the file itself.
 *
 * LOOP-FIX-20260827: a PATCH into `review` synchronously fires runQCOnReview,
 * and this file's seeded tasks (mkTask, dept 'marketing') carry no department
 * SOP — post-fix, QC classifies them 'no-criteria' (un-reroutable) and now
 * blocks them IMMEDIATELY instead of leaving a silent event, which broke this
 * file's PATCH-mechanics assertions (idempotent-PATCH status, description
 * truncation length) in ways that have nothing to do with QC. Disabled here
 * so this file keeps testing only the four-fields PATCH contract; the new QC
 * behavior itself is covered by qc-loop-close.test.ts and
 * loop-fix-20260827-block-and-loop-detector.test.ts.
 */
process.env.DISABLE_QC_AUTO_SCORER = '1';

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '../../src/lib/db';
import { UpdateTaskSchema } from '../../src/lib/validation';
import { runMigrations } from '../../src/lib/db/migrations';
import { transition } from '../../src/lib/task-lifecycle';
import { getDb } from '../../src/lib/db';

// ── Helpers ──────────────────────────────────────────────────────────────

function mkTask(opts?: { dept?: string; status?: string; workspace_id?: string }) {
  const db = getDb();
  runMigrations(db);
  const id = 'u034t-' + uuidv4();
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, department, status, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, 'U034 test task', 'seed description', opts?.dept ?? 'marketing', opts?.status ?? 'in_progress', opts?.workspace_id ?? null, now, now],
  );
  return { id, db };
}

// ── Schema tests — no DB needed ──────────────────────────────────────────

test('UpdateTaskSchema accepts row1 producer payload with all four fields present in .data', () => {
  const input = {
    phase_id: 'copy',
    status: 'review',
    note: 'done copy',
    deliverable_url: 'https://example.invalid/a.pdf',
  };
  const r = UpdateTaskSchema.safeParse(input);
  assert.ok(r.success, `expected success, got: ${JSON.stringify(r.error?.issues)}`);
  assert.ok(r.data!.phase_id === 'copy', 'phase_id must survive');
  assert.ok(r.data!.note === 'done copy', 'note must survive');
  assert.ok(r.data!.deliverable_url === 'https://example.invalid/a.pdf', 'deliverable_url must survive');
  assert.ok(r.data!.status === 'review', 'status must survive');
});

test('UpdateTaskSchema accepts row9 producer payload with five keys including qc_scores', () => {
  const input = {
    phase_id: 'P9-DELIVER',
    status: 'review',
    note: 'deck built',
    process_certificate_sha: 'd'.repeat(64),
    qc_scores: {
      gates_graded: 3,
      overall_pass: true,
      min_average: 8.7,
      autofails_total: 0,
      gates: [{ report: 'a.json', gate: 'typo', average: 9.1, pass: true, autofails_count: 0 }],
    },
  };
  const r = UpdateTaskSchema.safeParse(input);
  assert.ok(r.success, `expected success, got: ${JSON.stringify(r.error?.issues)}`);
  assert.ok(r.data!.phase_id === 'P9-DELIVER', 'phase_id must survive');
  assert.ok(r.data!.note === 'deck built', 'note must survive');
  assert.ok(r.data!.qc_scores !== undefined, 'qc_scores must survive');
  assert.ok(r.data!.qc_scores!.min_average === 8.7, 'min_average must survive');
});

test('unknown key is still ACCEPTED and stripped (strict-did-not-land guard)', () => {
  const input = { status: 'review', totally_unknown: 'x' };
  const r = UpdateTaskSchema.safeParse(input);
  assert.ok(r.success, 'unknown key must still be accepted');
  assert.ok(!('totally_unknown' in (r.data as Record<string, unknown>)), 'unknown key must be stripped');
  assert.ok(r.data!.status === 'review');
});

test('deliverable_url javascript: scheme is REJECTED', () => {
  const input = { status: 'review', deliverable_url: 'javascript:alert(1)' };
  const r = UpdateTaskSchema.safeParse(input);
  assert.ok(!r.success, 'javascript: URL must be rejected');
});

test('qc_scores .passthrough() allows extra keys', () => {
  const input = { status: 'review', qc_scores: { gates_graded: 1, min_average: 5, brand_new_key: 1 } };
  const r = UpdateTaskSchema.safeParse(input);
  assert.ok(r.success, 'qc_scores with extra key must be accepted');
  assert.ok(r.data!.qc_scores!.min_average === 5);
});

test('qc_scores gates array is max 64', () => {
  const input = { status: 'review', qc_scores: { gates_graded: 65, min_average: 5, gates: Array(65).fill({ report: 'x.json' }) } };
  const r = UpdateTaskSchema.safeParse(input);
  assert.ok(!r.success, 'gates array exceeding 64 must be rejected');
});

// ── Persistence tests — throwaway DB ─────────────────────────────────────

test('deliverable_url PATCH creates exactly one task_deliverables row with deliverable_type = url', async () => {
  const { id } = mkTask();
  const { PATCH } = await import('../../src/app/api/tasks/[id]/route');
  const url = 'https://example.invalid/test-deck.pdf';
  const req = {
    json: async () => ({ status: 'review', deliverable_url: url }),
    headers: { get: () => null },
  } as unknown as Request;
  const res = await PATCH(req, { params: Promise.resolve({ id }) });
  assert.equal(res.status, 200);
  const rows = queryAll('SELECT deliverable_type, path FROM task_deliverables WHERE task_id = ?', [id]);
  assert.equal(rows.length, 1, 'must have exactly one deliverable row');
  assert.equal(rows[0].deliverable_type, 'url');
  assert.equal(rows[0].path, url);
});

test('deliverable_url is idempotent — second identical PATCH creates no second row', async () => {
  const { id } = mkTask();
  const { PATCH } = await import('../../src/app/api/tasks/[id]/route');
  const url = 'https://example.invalid/deck.pdf';
  const req = (payload: Record<string, unknown>) => ({
    json: async () => payload,
    headers: { get: () => null },
  }) as unknown as Request;
  const r1 = await PATCH(req({ status: 'review', deliverable_url: url }), { params: Promise.resolve({ id }) });
  assert.equal(r1.status, 200);
  const r2 = await PATCH(req({ status: 'review', deliverable_url: url }), { params: Promise.resolve({ id }) });
  assert.equal(r2.status, 200);
  const rows = queryAll('SELECT id FROM task_deliverables WHERE task_id = ?', [id]);
  assert.equal(rows.length, 1, 'must still have exactly one deliverable row after duplicate');
});

test('deliverable_url on a card with no other artifact allows transition to done', async () => {
  // Create a task at 'review' status so done is reachable, with no deliverables
  const { id } = mkTask({ status: 'review' });
  const { PATCH } = await import('../../src/app/api/tasks/[id]/route');
  const url = 'https://example.invalid/only-evidence.pdf';
  const req = {
    json: async () => ({ status: 'review', deliverable_url: url }),
    headers: { get: () => null },
  } as unknown as Request;
  const res = await PATCH(req, { params: Promise.resolve({ id }) });
  assert.equal(res.status, 200);

  // Now transition to done — must succeed because a url deliverable exists
  const result = await transition(id, 'done', { actor: 'test', reason: 'U034 test' });
  assert.equal(result.status, 'done');
});

test('qc_scores scalars are persisted to task_qc_results', async () => {
  const { id } = mkTask();
  const { PATCH } = await import('../../src/app/api/tasks/[id]/route');
  const req = {
    json: async () => ({
      status: 'in_progress',
      qc_scores: { gates_graded: 2, overall_pass: false, min_average: 7.5, autofails_total: 1 },
    }),
    headers: { get: () => null },
  } as unknown as Request;
  const res = await PATCH(req, { params: Promise.resolve({ id }) });
  assert.equal(res.status, 200);
  // Filter by scoring_path so runQCOnReview's async write does not pollute the count
  const rows = queryAll(
    "SELECT score, passed, scoring_path FROM task_qc_results WHERE task_id = ? AND scoring_path = 'producer-reported'",
    [id],
  );
  assert.equal(rows.length, 1, 'must have exactly one producer-reported qc_results row');
  assert.equal(rows[0].score, 7.5);
  assert.equal(rows[0].passed, 0);
  assert.equal(rows[0].scoring_path, 'producer-reported');
});

test('qc_scores with null min_average writes NO row and still returns 200', async () => {
  const { id } = mkTask();
  const { PATCH } = await import('../../src/app/api/tasks/[id]/route');
  const req = {
    json: async () => ({
      status: 'in_progress',
      qc_scores: { gates_graded: 0, overall_pass: false, min_average: null },
    }),
    headers: { get: () => null },
  } as unknown as Request;
  const res = await PATCH(req, { params: Promise.resolve({ id }) });
  assert.equal(res.status, 200);
  // Filter by scoring_path so runQCOnReview's async write does not pollute the count
  const rows = queryAll(
    "SELECT id FROM task_qc_results WHERE task_id = ? AND scoring_path = 'producer-reported'",
    [id],
  );
  assert.equal(rows.length, 0, 'must have no producer-reported qc_results row when min_average is null');
});

test('note AND description in same payload keeps BOTH with SET description once', async () => {
  const { id } = mkTask();
  // FIX 25 (review-evidence gate, default ON): review requires a registered,
  // reachable deliverable — seed one (fixture data, not a relaxation).
  run(`INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path) VALUES ('u034-ev-${Math.random().toString(36).slice(2,8)}', ?, 'url', 'U034 four-fields evidence', 'https://example.invalid/evidence.pdf')`, [id]);
  const { PATCH } = await import('../../src/app/api/tasks/[id]/route');
  const req = {
    json: async () => ({
      status: 'review',
      description: 'brand new body',
      note: 'and the note',
    }),
    headers: { get: () => null },
  } as unknown as Request;
  const res = await PATCH(req, { params: Promise.resolve({ id }) });
  assert.equal(res.status, 200);
  const row = queryOne<{ description: string }>('SELECT description FROM tasks WHERE id = ?', [id]);
  assert.ok(/brand new body/.test(row!.description), 'description must contain new body');
  assert.ok(/and the note/.test(row!.description), 'description must contain note');
});

test('12000-char append trims oldest text, keeps note line at end', async () => {
  const { id } = mkTask();
  // FIX 25 (review-evidence gate, default ON): review requires a registered,
  // reachable deliverable — seed one (fixture data, not a relaxation).
  run(`INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path) VALUES ('u034-ev-${Math.random().toString(36).slice(2,8)}', ?, 'url', 'U034 four-fields evidence', 'https://example.invalid/evidence.pdf')`, [id]);
  // Create a task with a large existing description
  const longDesc = 'X'.repeat(8000);
  run('UPDATE tasks SET description = ? WHERE id = ?', [longDesc, id]);
  const { PATCH } = await import('../../src/app/api/tasks/[id]/route');
  const noteText = 'END-OF-APPEND-MARKER';
  // 8000 + separator(\n\n) + ~50-char note line + 2000-char note = should exceed 10000
  // note max is 2000, so the full note payload must be <= 2000 chars
  const longNote = 'N'.repeat(1977);  // 1977 + 'END-OF-APPEND-MARKER'.length(22) + ' '.length(1) = 2000
  const req = {
    json: async () => ({
      status: 'review',
      note: noteText + ' ' + longNote,
    }),
    headers: { get: () => null },
  } as unknown as Request;
  const res = await PATCH(req, { params: Promise.resolve({ id }) });
  assert.equal(res.status, 200);
  const row = queryOne<{ description: string }>('SELECT description FROM tasks WHERE id = ?', [id]);
  assert.equal(row!.description.length, 10000, 'description must be capped at 10000');
  assert.ok(row!.description.endsWith(longNote.slice(-20)), 'description must end with the note text (trimmed from start)');
  assert.ok(/END-OF-APPEND-MARKER/.test(row!.description), 'note marker must be present');
});
