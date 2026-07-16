/**
 * The escalation must reach a HUMAN — not just the database.
 *
 * WHY THIS FILE EXISTS. The QC scorer's terminal [QC-JUDGE-FAILED-FINAL] state
 * writes an event and a console.warn, and that is ALL it does. The operator PAGE
 * for the sibling no-key hatch does not come from the scorer either — it comes
 * from board-hygiene's terminal-review scan, which matched ONLY
 * '%[QC-HEURISTIC-FINAL]%'. So a new terminal marker that this scan does not
 * match is a hatch into a soundproof room: bounded, terminal, correctly
 * diagnosed... and still silent. That is the six-day defect rebuilt one layer
 * up, and an event nobody receives is not an escalation.
 *
 * These tests prove a real alert LEAVES THE PROCESS:
 *   1. board-hygiene pages (notifySystem → the Rescue Rangers escalation
 *      webhook) for a task the scorer escalated, carrying the scorer's verbatim
 *      diagnosis — so the page says the judge is FAILING, not "provider down".
 *   2. It pages ONCE, not per sweep tick — the alert-storm fear that got the
 *      provider-down lane left unbounded in the first place is answered by a
 *      bound plus a cooldown, not by silence.
 *   3. board-hygiene never force-rescores an escalated task (that would restore
 *      the retry loop the bound exists to kill).
 *   4. A still-working deferral does NOT page (alarming on every blip is noise).
 *
 * The webhook POST is exercised for real via the documented escape hatch
 * (OWNER_NOTIFY_ALLOW_SEND_IN_TEST=1 coupled with a fetch double), so nothing
 * can leave the process while we still assert the exact page body.
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.QC_JUDGE_MODEL;
delete process.env.OLLAMA_CLOUD_API_KEY;
delete process.env.OLLAMA_API_KEY;
delete process.env.DISABLE_BOARD_HYGIENE;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-judgepage-ws-'));

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryAll } from '../../src/lib/db';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';

// Only the review lane is under test; silence the rest so their alerts cannot
// be mistaken for ours.
process.env.DISABLE_BOARD_HYGIENE_BLOCKED = '1';
process.env.DISABLE_BOARD_HYGIENE_DONE = '1';
process.env.DISABLE_BOARD_HYGIENE_STALE = '1';
process.env.DISABLE_BOARD_HYGIENE_TRIAD = '1';
process.env.DISABLE_BOARD_HYGIENE_BLEND_REGRESSION = '1';
process.env.DISABLE_BOARD_HYGIENE_BLEND_INVARIANT = '1';

const FINAL_MARKER = '[QC-JUDGE-FAILED-FINAL]';
const DEFER_MARKER = '[QC-DEFERRED-PROVIDER-DOWN]';

/** The scorer's real escalation text, as written by qc-scorer.ts. */
const SCORER_ESCALATION =
  `${FINAL_MARKER} Score: 8.0/10 | QC judge FAILED 12 consecutive times — this is NOT a transient ` +
  `blip. OBSERVED FAILURE: judge answered but content was EMPTY (provider is UP). Judge model ` +
  `"ollama-cloud/deepseek-v4-flash:cloud" called at https://ollama.com/v1/chat/completions. ` +
  `FIX: raise QC_JUDGE_MAX_TOKENS (default 2048), or configure a non-reasoning judge model.`;

// ── The fetch double: captures the page, guarantees no packet leaves ─────────
let pages: Array<{ url: string; body: Record<string, unknown> }> = [];
const realFetch = globalThis.fetch;

function installFetchDouble() {
  pages = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    pages.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
}

function seedEscalatedTask(title: string, marker: string): string {
  const id = uuidv4();
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'A finished deliverable.', 'review', 'medium', NULL, NULL, ?, ?)`,
    [id, title, now, now],
  );
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'qc_review', ?, ?, datetime('now'))`,
    [uuidv4(), id, marker],
  );
  return id;
}

const eventTypes = (taskId: string): string[] =>
  queryAll<{ type: string }>(`SELECT type FROM events WHERE task_id = ?`, [taskId]).map((r) => r.type);

test.before(() => {
  getDb();
  // Opt IN to the webhook rung — safe ONLY because the fetch double is installed.
  process.env.RESCUE_RANGERS_WEBHOOK_URL = 'https://rescue.invalid/hook';
  process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST = '1';
});

test.after(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
  delete process.env.OWNER_NOTIFY_ALLOW_SEND_IN_TEST;
  try { fs.rmSync(process.env.OPENCLAW_WORKSPACE_PATH!, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── 1: the page actually fires, and says the RIGHT thing ────────────────────
test('[PAGE-1] a [QC-JUDGE-FAILED-FINAL] task PAGES a human, carrying the scorer verbatim diagnosis', async () => {
  installFetchDouble();
  const id = seedEscalatedTask('Draft the launch brief', SCORER_ESCALATION);

  const result = await runBoardHygiene();

  assert.ok(
    result.qcJudgeFailedIds.includes(id),
    'board-hygiene must surface the escalated task — a terminal state it does not scan is silent',
  );

  // The alarm must have LEFT the process, not merely been written to a table.
  assert.equal(pages.length, 1, `exactly one page must be dispatched (got ${pages.length})`);
  const body = pages[0].body as { message?: string; action?: string };
  assert.equal(body.action, 'qc_judge_failed', 'the page must be attributed to the judge-failed action');
  const msg = String(body.message);

  assert.ok(msg.includes(id), 'the page must name the stuck task');
  assert.ok(/judge FAILING/i.test(msg), 'the page must say the judge is FAILING');
  assert.ok(/needs a human/i.test(msg), 'the page must say a human is required');
  // The verbatim scorer diagnosis must ride along — a page that re-derives its
  // own guess is how a healthy provider got blamed for six days.
  assert.ok(msg.includes('content was EMPTY (provider is UP)'), 'the page must carry the OBSERVED failure');
  assert.ok(msg.includes('QC_JUDGE_MAX_TOKENS'), 'the page must carry the fix that matches the failure');
  assert.ok(!/provider is down/i.test(msg), 'the page must never claim the provider is down — it was UP');

  // And an audit row is written so the cooldown has something to key on.
  assert.ok(eventTypes(id).includes('qc_judge_failed'), 'an audit event must record that we paged');
});

// ── 2: once, not per tick ───────────────────────────────────────────────────
test('[PAGE-2] the page fires ONCE, not on every hygiene tick (the alert-storm fear, answered)', async () => {
  installFetchDouble();
  const id = seedEscalatedTask('Write the onboarding email', SCORER_ESCALATION);

  const first = await runBoardHygiene();
  assert.ok(first.qcJudgeFailedIds.includes(id), 'first tick pages');
  const afterFirst = pages.length;

  const second = await runBoardHygiene();
  assert.ok(
    !second.qcJudgeFailedIds.includes(id),
    'the SECOND tick must NOT re-page the same task — a bounded retry that pages once is the ' +
      'answer to the alert-storm fear, not a repeat of it',
  );
  assert.equal(pages.length, afterFirst, 'no additional page may be dispatched on the second tick');

  const paged = eventTypes(id).filter((t) => t === 'qc_judge_failed');
  assert.equal(paged.length, 1, 'exactly one qc_judge_failed audit event, ever');
});

// ── 3: an escalated task is never force-rescored ────────────────────────────
test('[PAGE-3] board-hygiene never force-rescores an escalated task (that would restore the retry loop)', async () => {
  installFetchDouble();
  const id = seedEscalatedTask('Build the pricing page', SCORER_ESCALATION);

  const result = await runBoardHygiene();

  assert.ok(
    !result.reviewForceScoredIds.includes(id),
    'a [QC-JUDGE-FAILED-FINAL] task must be excluded from the force-score scan — re-scoring it ' +
      'would corrupt the deferral counter and quietly restore the silent loop the bound exists to kill',
  );
  const qcReviewEvents = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'qc_review'`,
    [id],
  );
  assert.equal(qcReviewEvents.length, 1, 'no new qc_review event may be written for an escalated task');
});

// ── 4: a task merely still working does NOT page ────────────────────────────
test('[PAGE-4] a still-retrying [QC-DEFERRED-PROVIDER-DOWN] task does NOT page — alarming on a blip is noise', async () => {
  installFetchDouble();
  const id = seedEscalatedTask('Record the welcome video', `${DEFER_MARKER} Score: 8.0/10 | auto-rescoring.`);

  const result = await runBoardHygiene();

  assert.ok(
    !result.qcJudgeFailedIds.includes(id),
    'a task that is still auto-recovering must never page a human',
  );
  assert.ok(!eventTypes(id).includes('qc_judge_failed'), 'no judge-failed audit event for a live deferral');
});
