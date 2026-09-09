/**
 * PRES-038 (W3 WF12-B) — deliverables UI proves verification from evidence.
 *
 * node:test suite (runs under `npm run test:unit`). Drives the REAL GET
 * /api/presentations/[taskId]/deliverables handler against an isolated DB +
 * real fixture files, one test per TODO acceptance clause:
 *   1. Register then delete file → registered/unavailable, never verified.
 *   2. Register then corrupt (wrong magic) → produced false, no verified badge.
 *   3. Good verified receipt renders verified (shared cached verifier, cached:true on repeat).
 *   4. Updated file invalidates the receipt (hash-bound: re-probe, no stale verified).
 *   5. GHL upload succeeds but readback fails → uploaded/unconfirmed
 *      (ghl_delivered_url null, actionable retry), never false delivered.
 *   6. GHL readback ok on the CURRENT hash → delivered with link.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts --test \
 *     tests/unit/pres038-deliverables-verification.test.ts
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';
import { writeGhlLinkCheck } from '../../src/lib/presentation-verification';

// Unique-per-FILE-RUN fixture root AND task id: node:test runs every file in
// one process, and Date.now()/pid collide across the module body + all six
// tests within the same millisecond — every test would otherwise share one
// RUN dir and one task id and trample (delete/corrupt/rewrite) its siblings'
// files and rows mid-flight (all-absent ghost). Random suffixes isolate fully.
const RUNID = Math.random().toString(36).slice(2);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), `pres038-${process.pid}-${RUNID}-`));
// Base task id; each test derives its OWN task (taskFor(tag)) so rows,
// receipt PKs, ledgers, and file names never cross tests.
const TASK = `task-pres038-${process.pid}-${RUNID}`;
const taskFor = (tag: string) => `${TASK}-${tag}`;
// Same fixture convention as presentation-deliverables.test.ts: the suite's
// PROJECTS_PATH, so the run-dir fallback resolves per test.
process.env.PROJECTS_PATH = DIR;

const pdf = (size: number, magic = '%PDF-1.7\n') =>
  Buffer.concat([Buffer.from(magic, 'binary'), Buffer.alloc(Math.max(0, size - magic.length), 0x41)]);

// Workspace row once (shared across per-test tasks).
{
  const db = getDb();
  if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get('presentations')) {
    db.prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)').run(
      'presentations', 'Presentations', 'presentations', 'Presentation', 10,
    );
  }
}

// Unique deliverable ids per call: task_deliverables.id is the primary key.
let delivSeq = 0;
function seedDeliverable(tag: string, fp: string | null, size: number | null, sha: string | null, taskId: string) {
  const id = `${tag}-${delivSeq++}`;
  // Column list is EXPLICIT (id, task_id, type, title, path, description,
  // mime, size, sha): a positional VALUES without the description slot shifts
  // every trailing value one left and stores the FILE PATH in mime_type.
  getDb().prepare(
    `INSERT INTO task_deliverables (id,task_id,deliverable_type,title,path,description,mime_type,file_size_bytes,sha256,created_at)
     VALUES (?,?,?,?,?,?,?, ?,?, datetime('now'))`,
  ).run(id, taskId, 'artifact', path.basename(fp ?? id), fp, null, 'application/pdf', size, sha);
}

// Per-test task setup: task row + OWN run dir + deck rows + guide path.
// Same PRESENTER-GUIDE.pdf basename per test is SAFE — each test's bytes live
// in its own run dir, its own TASK rows, its own receipt PKs. No cross-test
// trampling, no shared created_at ties, no UNIQUE collisions (sequence ids).
function setupTest(tag: string) {
  const taskId = taskFor(tag);
  const runDir = path.join(DIR, `run-${tag}`);
  fs.mkdirSync(path.join(runDir, 'working', 'checkpoints'), { recursive: true });
  fs.mkdirSync(path.join(DIR, 'artifacts', taskId), { recursive: true });
  getDb().prepare(
    `INSERT INTO tasks (id,title,status,priority,workspace_id,department) VALUES (?,?,'backlog','medium','presentations','presentations')`,
  ).run(taskId, `PRES-038 proof task ${tag}`);
  const slug = `proofdeck-${RUNID}-${tag}`;
  const deckPdf = path.join(runDir, `${slug}-FINAL.pdf`);
  const deckPptx = path.join(runDir, `${slug}-FINAL.pptx`);
  const pptxMagic = 'PK\x03\x04';
  // deck_pptx floor is 1MB: the slug row is a real 1.1MB PK-zip so the probe
  // marks deck_pptx honestly; the *-FINAL.pdf names the same slug.
  fs.writeFileSync(deckPptx, Buffer.concat([Buffer.from(pptxMagic, 'binary'), Buffer.alloc(1_100_000, 0x41)]));
  seedDeliverable(`d-deck-${tag}`, deckPptx, 1_100_000, 'sha-deck', taskId);
  fs.writeFileSync(deckPdf, pdf(60_000));
  seedDeliverable(`d-deckpdf-${tag}`, deckPdf, 60_000, 'sha-deckpdf', taskId);
  return { taskId, runDir, guide: path.join(runDir, 'PRESENTER-GUIDE.pdf') };
}

async function callTask(taskId: string) {
  const { GET } = await import('../../src/app/api/presentations/[taskId]/deliverables/route');
  const res = await GET(new NextRequest(`http://localhost/api/presentations/${taskId}/deliverables`), {
    params: Promise.resolve({ taskId }),
  } as unknown as { params: Promise<{ taskId: string }> });
  assert.equal(res.status, 200);
  return (await res.json()) as {
    rows: Array<{
      key: string;
      verification: string;
      ghl_delivered_url: string | null;
      status: { registered: boolean; produced: boolean; qc_verified: boolean; uploaded: boolean; reachable: boolean; delivered: boolean; detail: string | null };
      ghl: { url: string | null; reachable: boolean | null };
      sha256: string | null;
    }>;
  };
}

const guideRow = (b: Awaited<ReturnType<typeof callTask>>) => b.rows.find((r) => r.key === 'guide_pdf')!;

test('PRES-038: register then delete file → registered/unavailable, never verified', async () => {
  const { taskId, guide } = setupTest('t1');
  fs.writeFileSync(guide, pdf(60_000));
  seedDeliverable('d-del', guide, 60_000, 'sha-reg', taskId);
  fs.rmSync(guide); // delete AFTER registration
  const g = guideRow(await callTask(taskId));
  assert.equal(g.verification === 'verified', false);
  assert.equal(g.status.registered, true);
  assert.equal(g.status.produced, false);
  assert.equal(g.status.delivered, false);
});

test('PRES-038: corrupt file (wrong magic) → produced false, no verified badge', async () => {
  const { taskId, guide } = setupTest('t2');
  fs.writeFileSync(guide, pdf(60_000, 'NOT-A-PDF!'));
  seedDeliverable('d-cor', guide, 60_000, 'sha-cor', taskId);
  const g = guideRow(await callTask(taskId));
  assert.equal(g.verification, 'size-only');
  assert.equal(g.status.produced, false);
});

test('PRES-038: good file renders verified; repeat read is receipt-cached', async () => {
  const { taskId, guide } = setupTest('t3');
  fs.writeFileSync(guide, pdf(60_000));
  seedDeliverable('d-good', guide, null, null, taskId);
  const first = guideRow(await callTask(taskId));
  assert.equal(first.verification, 'verified');
  assert.equal(first.status.produced, true);
  const receipt1 = getDb()
    .prepare(`SELECT status, checked_at FROM presentation_delivery_receipts WHERE task_id = ? AND artifact_key = 'guide_pdf'`)
    .get(taskId) as { status: string; checked_at: string };
  assert.equal(receipt1.status, 'verified');
  const second = guideRow(await callTask(taskId));
  assert.equal(second.verification, 'verified');
  const receipt2 = getDb()
    .prepare(`SELECT status, checked_at FROM presentation_delivery_receipts WHERE task_id = ? AND artifact_key = 'guide_pdf'`)
    .get(taskId) as { status: string; checked_at: string };
  assert.equal(receipt2.checked_at, receipt1.checked_at);
});

test('PRES-038: updated file invalidates the receipt (no stale verified)', async () => {
  const { taskId, guide } = setupTest('t4');
  fs.writeFileSync(guide, pdf(60_000));
  seedDeliverable('d-upd', guide, null, null, taskId);
  const g = guideRow(await callTask(taskId));
  assert.equal(g.verification, 'verified');
  assert.equal(g.status.produced, true);
  // Rewrite with different bytes (still valid PDF, different hash).
  fs.writeFileSync(guide, pdf(61_000));
  const gUpd = guideRow(await callTask(taskId));
  assert.equal(gUpd.verification, 'verified');
  // Now corrupt in place: the OLD good receipt must not survive.
  fs.writeFileSync(guide, pdf(60_000, 'NOT-A-PDF!'));
  const g2 = guideRow(await callTask(taskId));
  assert.equal(g2.verification === 'verified', false);
  assert.equal(g2.status.produced, false);
  const receipt = getDb()
    .prepare(`SELECT status FROM presentation_delivery_receipts WHERE task_id = ? AND artifact_key = 'guide_pdf'`)
    .get(taskId) as { status: string };
  assert.equal(receipt.status, 'failed');
});

test('PRES-038: GHL upload ok but readback fails → uploaded/unconfirmed retry, never delivered', async () => {
  const { taskId, runDir, guide } = setupTest('t5');
  fs.writeFileSync(guide, pdf(60_000));
  seedDeliverable('d-ghl', guide, null, null, taskId);
  const ledger = path.join(runDir, 'working', 'checkpoints', 'media_library.json');
  const url = 'https://ghl.example.com/guide.pdf';
  fs.writeFileSync(ledger, JSON.stringify({ uploaded: [{ local_path: guide, ghl_url: url }] }));
  // Readback FAILED for the current hash: prime the receipt first (one read
  // creates it), then bind the check to its live sha.
  await callTask(taskId);
  const liveFail = getDb()
    .prepare(`SELECT sha256 FROM presentation_delivery_receipts WHERE task_id = ? AND artifact_key = 'guide_pdf'`)
    .get(taskId) as { sha256: string };
  writeGhlLinkCheck(getDb(), taskId, 'guide_pdf', url, liveFail.sha256, false, 'readback 404');
  const g = guideRow(await callTask(taskId));
  assert.equal(g.status.uploaded, true);
  assert.equal(g.status.reachable, false);
  assert.equal(g.status.delivered, false);
  assert.equal(g.ghl_delivered_url, null);
  assert.equal(g.ghl.url, url);
});

test('PRES-038: GHL readback ok on current hash → delivered with link', async () => {
  const { taskId, runDir, guide } = setupTest('t6');
  fs.writeFileSync(guide, pdf(60_000));
  seedDeliverable('d-ghl2', guide, null, null, taskId);
  const ledger = path.join(runDir, 'working', 'checkpoints', 'media_library.json');
  const url = 'https://ghl.example.com/guide2.pdf';
  fs.writeFileSync(ledger, JSON.stringify({ uploaded: [{ local_path: guide, ghl_url: url }] }));
  // Bind the check to the RECEIPT hash (live bytes): prime the receipt
  // with one read first, then record the check against its live sha.
  await callTask(taskId);
  const liveReceipt = getDb()
    .prepare(`SELECT sha256 FROM presentation_delivery_receipts WHERE task_id = ? AND artifact_key = 'guide_pdf'`)
    .get(taskId) as { sha256: string };
  writeGhlLinkCheck(getDb(), taskId, 'guide_pdf', url, liveReceipt.sha256, true, 'readback 200');
  const g = guideRow(await callTask(taskId));
  assert.equal(g.status.uploaded, true);
  assert.equal(g.status.reachable, true);
  assert.equal(g.status.delivered, true);
  assert.equal(g.ghl_delivered_url, url);
  // Stale check (old hash) must NOT count: re-record against a wrong hash.
  writeGhlLinkCheck(getDb(), taskId, 'guide_pdf', url, 'deadbeef'.repeat(8), true, 'old revision');
  const g2 = guideRow(await callTask(taskId));
  assert.equal(g2.status.delivered, false);
  assert.equal(g2.ghl_delivered_url, null);
});

test('PRES-038: teardown fixture root', async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
});
