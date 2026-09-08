/**
 * u031-cert-gate-all-done-paths.test.ts — U031: the presentations certificate
 * registration gate applies to EVERY path to done through transition(), not only
 * the PATCH route.
 *
 * Runs via the Node built-in test runner under tsx (npm run test:unit).
 * Uses _isolated-db helper — throwaway SQLite, no network, no shared state.
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run, getDb } from '../../src/lib/db';
import { runMigrations } from '../../src/lib/db/migrations';
import { transition, TransitionError } from '../../src/lib/task-lifecycle';
import {
  requiresRegisteredCertificate,
  evaluatePresentationsDoneGate,
} from '../../src/lib/presentations-cert-gate';
import {
  registerVerifiedReceipt,
  getReceiptHistory,
} from '../../src/lib/presentation-proof-registry';

// ── Pure-function tests (no DB) ───────────────────────────────────────────

test('requiresRegisteredCertificate rejects presentations task with no stored cert', () => {
  const r = requiresRegisteredCertificate({
    department: 'presentations',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: null,
  });
  assert.equal(r.applies, true);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'process_certificate_required');
});

test('requiresRegisteredCertificate passes with a stored cert', () => {
  const r = requiresRegisteredCertificate({
    department: 'presentations',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: 'a'.repeat(64),
  });
  assert.equal(r.applies, true);
  assert.equal(r.ok, true);
});

test('requiresRegisteredCertificate returns applies:false for non-terminal target', () => {
  const r = requiresRegisteredCertificate({
    department: 'presentations',
    currentStatus: 'in_progress',
    targetStatus: 'review',
    storedCert: null,
  });
  assert.equal(r.applies, false);
  assert.equal(r.ok, true);
});

test('requiresRegisteredCertificate returns applies:false for non-presentations department', () => {
  const r = requiresRegisteredCertificate({
    department: 'marketing',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: null,
  });
  assert.equal(r.applies, false);
  assert.equal(r.ok, true);
});

test('requiresRegisteredCertificate returns applies:false for sop-authoring sub-task', () => {
  const r = requiresRegisteredCertificate({
    department: 'presentations',
    currentStatus: 'in_progress',
    targetStatus: 'done',
    storedCert: null,
    sopAuthoringForTaskId: 'parent-task-id',
  });
  assert.equal(r.applies, false);
  assert.equal(r.ok, true);
});

test('requiresRegisteredCertificate canonicalizes department display name "Presentations"', () => {
  const r = requiresRegisteredCertificate({
    department: 'Presentations',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: null,
  });
  assert.equal(r.applies, true);
  assert.equal(r.ok, false);
});

test('evaluatePresentationsDoneGate is unchanged', () => {
  const SHA_A = 'a'.repeat(64);
  const r = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'review',
    targetStatus: 'done',
    storedCert: null,
    providedCert: SHA_A,
  });
  assert.equal(r.applies, true);
  assert.equal(r.ok, true);
  assert.equal(r.persistCert, SHA_A);
});

// ── DB-backed integration tests ────────────────────────────────────────────

const db = getDb();
runMigrations(db);

function nowISO(): string {
  return new Date().toISOString();
}

function insertTask(opts: {
  id?: string;
  title?: string;
  department?: string | null;
  status?: string;
  processCertificateSha?: string | null;
  sopAuthoringForTaskId?: string | null;
}): string {
  const id = opts.id ?? 'u031-test-' + uuidv4();
  run(
    'INSERT INTO tasks (id, title, department, status, workspace_id, created_at, updated_at, ' +
    'process_certificate_sha, sop_authoring_for_task_id) ' +
    'VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)',
    [
      id,
      opts.title ?? 'U031 test task',
      opts.department ?? null,
      opts.status ?? 'review',
      nowISO(),
      nowISO(),
      opts.processCertificateSha ?? null,
      opts.sopAuthoringForTaskId ?? null,
    ],
  );
  return id;
}

function insertDeliverable(taskId: string): void {
  run(
    'INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at) ' +
    "VALUES (?, ?, 'url', 'probe', 'https://example.invalid/p', ?)",
    ['d-' + taskId + '-' + uuidv4().slice(0, 8), taskId, nowISO()],
  );
}

test('DB: presentations review to done with no cert throws PRECONDITION_PROCESS_CERTIFICATE', async () => {
  const id = insertTask({ department: 'presentations', status: 'review', processCertificateSha: null });
  insertDeliverable(id);
  try {
    await transition(id, 'done', { actor: 'qc' });
    assert.fail('Expected TransitionError');
  } catch (e: any) {
    assert.ok(e instanceof TransitionError);
    assert.equal(e.code, 'PRECONDITION_PROCESS_CERTIFICATE');
  }
});

test('DB: operatorOverride does NOT waive the certificate gate', async () => {
  const id = insertTask({ department: 'presentations', status: 'review', processCertificateSha: null });
  insertDeliverable(id);
  try {
    await transition(id, 'done', { actor: 'operator', operatorOverride: true, expectedFrom: 'review' });
    assert.fail('Expected TransitionError');
  } catch (e: any) {
    assert.ok(e instanceof TransitionError);
    assert.equal(e.code, 'PRECONDITION_PROCESS_CERTIFICATE');
  }
});

test('DB: presentations task with stored cert + VERIFIED receipt transitions successfully', async () => {
  const id = insertTask({
    department: 'presentations',
    status: 'review',
    processCertificateSha: 'a'.repeat(64),
  });
  insertDeliverable(id);
  // PRES-022: a stored bare sha is only an identifier. The transition also
  // requires an ACTIVE VERIFIED receipt — register one through the registry
  // (server-recomputed path; the QC receipt is engine-trusted only, so seed
  // the qc_review event the registry reads).
  run(
    `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'qc_review', ?, ?, ?)`,
    ['u031-qc-' + uuidv4(), id, '[QC-AUTO] Score: 9.0/10 PASS — registry test receipt', nowISO()],
  );
  const reg = registerVerifiedReceipt({ taskId: id, attempt: 1 });
  assert.equal(reg.ok, true, `receipt registration failed: ${reg.error}`);
  const result = await transition(id, 'done', { actor: 'qc' });
  assert.equal(result.status, 'done');
});

test('DB: presentations task with a stored BARE sha and NO receipt is refused (PRES-022)', async () => {
  const id = insertTask({
    department: 'presentations',
    status: 'review',
    processCertificateSha: 'b'.repeat(64),
  });
  insertDeliverable(id);
  try {
    await transition(id, 'done', { actor: 'qc' });
    assert.fail('Expected TransitionError: a bare sha256 no longer completes a presentations task');
  } catch (e: any) {
    assert.ok(e instanceof TransitionError);
    assert.equal(e.code, 'PRECONDITION_PROCESS_CERTIFICATE');
    assert.match(e.message, /VERIFIED completion proof/);
  }
});

test('DB: repaired deck registers FRESH proof under a NEW attempt and completes (repair no deadlock)', async () => {
  const id = insertTask({
    department: 'presentations',
    status: 'review',
    processCertificateSha: 'c'.repeat(64),
  });
  insertDeliverable(id);
  run(
    `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'qc_review', ?, ?, ?)`,
    ['u031-qc1-' + uuidv4(), id, '[QC-AUTO] Score: 9.0/10 PASS — first receipt', nowISO()],
  );
  const r1 = registerVerifiedReceipt({ taskId: id, attempt: 1 });
  assert.equal(r1.ok, true);
  // Repair: new proof under attempt 2 — the prior approval is invalidated,
  // history retained, and the task can complete on the fresh revision.
  const r2 = registerVerifiedReceipt({ taskId: id, attempt: 2 });
  assert.equal(r2.ok, true, `repair registration failed: ${r2.error}`);
  const history = getReceiptHistory(id);
  assert.equal(history.filter((h) => h.status === 'invalidated').length, 1, 'prior approval must be invalidated, not deleted');
  assert.equal(history.filter((h) => h.status === 'active').length, 1, 'exactly one active receipt');
  const result = await transition(id, 'done', { actor: 'qc' });
  assert.equal(result.status, 'done');
});

test('DB: STALE worker cannot re-register a superseded revision (PRES-022 CAS)', async () => {
  const id = insertTask({
    department: 'presentations',
    status: 'review',
    processCertificateSha: null,
  });
  insertDeliverable(id);
  run(
    `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'qc_review', ?, ?, ?)`,
    ['u031-qcs-' + uuidv4(), id, '[QC-AUTO] Score: 9.0/10 PASS — stale-worker receipt', nowISO()],
  );
  const r2 = registerVerifiedReceipt({ taskId: id, attempt: 2 });
  assert.equal(r2.ok, true);
  const stale = registerVerifiedReceipt({ taskId: id, attempt: 1 });
  assert.equal(stale.ok, false, 'a stale worker must not replace newer proof');
  assert.equal(stale.code, 'stale_revision');
});

test('DB: random 64-hex presented at done with NO receipt never registers (identifier is not proof)', async () => {
  const id = insertTask({
    department: 'presentations',
    status: 'review',
    processCertificateSha: null,
  });
  insertDeliverable(id);
  // The PATCH route's presented-cert persistence path writes the anti-spoof
  // slot, but the registry still holds NO receipt: the transition must refuse.
  run('UPDATE tasks SET process_certificate_sha = ? WHERE id = ?', ['d'.repeat(64), id]);
  try {
    await transition(id, 'done', { actor: 'qc' });
    assert.fail('Expected TransitionError');
  } catch (e: any) {
    assert.ok(e instanceof TransitionError);
    assert.equal(e.code, 'PRECONDITION_PROCESS_CERTIFICATE');
  }
});

test('DB: marketing task with no cert transitions successfully', async () => {
  const id = insertTask({ department: 'marketing', status: 'review', processCertificateSha: null });
  insertDeliverable(id);
  const result = await transition(id, 'done', { actor: 'qc' });
  assert.equal(result.status, 'done');
});

test('DB: presentations sop-authoring sub-task with no cert transitions (exemption)', async () => {
  const id = insertTask({
    department: 'presentations',
    status: 'review',
    processCertificateSha: null,
    sopAuthoringForTaskId: 'parent-task-id-123',
  });
  insertDeliverable(id);
  const result = await transition(id, 'done', { actor: 'qc' });
  assert.equal(result.status, 'done');
});

test('DB: department display name "Presentations" still gated', async () => {
  const id = insertTask({ department: 'Presentations', status: 'review', processCertificateSha: null });
  insertDeliverable(id);
  try {
    await transition(id, 'done', { actor: 'qc' });
    assert.fail('Expected TransitionError');
  } catch (e: any) {
    assert.ok(e instanceof TransitionError);
    assert.equal(e.code, 'PRECONDITION_PROCESS_CERTIFICATE');
  }
});
