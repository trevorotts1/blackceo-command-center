/**
 * U-15 (fourth pass) — report-back messages: one sender, right order, no loops,
 * no server paths.
 *
 * Nine cases, one per finding this unit closes:
 *   1. a done task gets the Done text ONCE and every earlier stamp is covered
 *   2. a task first seen in_progress sends progress once, with the ack covered
 *   3. a blocked reminder wakes nobody at night, and can re-send when due
 *   4. a repeatable stamp (phase progress) claims against its PRIOR value
 *   5. quiet hours are read on the named client clock, not the box clock
 *   6. a deliverable path is never leaked to the client, a link is passed through
 *   7. department codes read as plain words, and banned words are gone
 *   8. a muted / held gateway is not a loop: no claim, no event, no release
 *   9. the owner-report funnel stands down when the trust engine sends
 */

import './_isolated-db'; // PRES-022: the gate chain reaches @/lib/db transitively — isolate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-trust-fourth-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.TZ = 'UTC';
delete process.env.DISABLE_TRUST_ENGINE;
delete process.env.TRUST_ENGINE_TIMEZONE;

type DbModule = typeof import('../../src/lib/db');
type EngineModule = typeof import('../../src/lib/jobs/trust-engine');
type OwnerReportsModule = typeof import('../../src/lib/owner-reports');
type TrustTaskRow = import('../../src/lib/jobs/trust-engine').TrustTaskRow;

let db: DbModule;
let engine: EngineModule;
let ownerReports: OwnerReportsModule;

/** 2:00 PM Eastern (EST) and 2:00 AM Eastern on the same day. */
const TWO_PM_ET = new Date('2026-11-12T19:00:00.000Z');
const TWO_AM_ET = new Date('2026-11-12T07:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

const noDeliverable = () => null;

function mkRow(over: Partial<TrustTaskRow>): TrustTaskRow {
  return {
    id: over.id ?? 'row-x',
    title: over.title ?? 'Sample task',
    status: over.status ?? 'backlog',
    department: over.department ?? 'sales',
    assigned_agent_name: over.assigned_agent_name ?? null,
    created_at: over.created_at ?? TWO_PM_ET.toISOString(),
    requester_channel: 'requester_channel' in over ? (over.requester_channel ?? null) : 'telegram',
    requester_chat_id: 'requester_chat_id' in over ? (over.requester_chat_id ?? null) : '12345',
    requester_session_key:
      'requester_session_key' in over ? (over.requester_session_key ?? null) : null,
    ack_sent_at: over.ack_sent_at ?? null,
    progress_last_sent_at: over.progress_last_sent_at ?? null,
    completion_sent_at: over.completion_sent_at ?? null,
    block_audience: over.block_audience ?? null,
    block_needs: over.block_needs ?? null,
    blocked_notice_sent_at: over.blocked_notice_sent_at ?? null,
    phase_progress_sent_at: over.phase_progress_sent_at ?? null,
    last_reported_phase_label: over.last_reported_phase_label ?? null,
    process_certificate_sha: over.process_certificate_sha ?? null,
    source: over.source ?? null,
  };
}

function insertTask(o: {
  id: string;
  title?: string;
  status: string;
  requesterChatId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}): void {
  const now = o.createdAt ?? TWO_PM_ET.toISOString();
  db.run(
    `INSERT INTO tasks (id, title, status, priority, requester_channel, requester_chat_id,
        created_at, updated_at, workspace_id)
     VALUES (?, ?, ?, 'medium', 'telegram', ?, ?, ?, 'default')`,
    [o.id, o.title ?? `Task ${o.id}`, o.status,
      'requesterChatId' in o ? (o.requesterChatId ?? null) : '9000',
      now, o.updatedAt ?? now],
  );
}

test.before(async () => {
  db = await import('../../src/lib/db');
  engine = await import('../../src/lib/jobs/trust-engine');
  ownerReports = await import('../../src/lib/owner-reports');
  db.getDb();

  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('default', 'Default', 'default', 'Default ws', '📁', 'default', 0, ?, ?)`,
    [now, now],
  );
});

test.after(() => {
  try { db.closeDb(); } catch { /* ignore */ }
});

// ── 1. DONE is the only message a finished task gets ─────────────────────────

test('case 1: a done task sends ONE Done message, covers the earlier stamps, and never sends again', () => {
  insertTask({ id: 'four-1', title: 'Finished deck', status: 'done' });

  const sent1: string[] = [];
  const r1 = engine.runTrustEngineSweep({
    taskId: 'four-1',
    now: TWO_PM_ET,
    send: (chat, msg) => { sent1.push(`${chat}:${msg}`); return true; },
    escalate: () => {},
  });
  assert.equal(sent1.length, 1, 'exactly one send');
  assert.match(sent1[0], /^9000:✅ Done: "Finished deck"/);

  const row = db.queryOne<{
    ack_sent_at: string | null;
    progress_last_sent_at: string | null;
    completion_sent_at: string | null;
  }>('SELECT ack_sent_at, progress_last_sent_at, completion_sent_at FROM tasks WHERE id = ?', ['four-1']);
  assert.ok(row?.completion_sent_at, 'completion_sent_at set');
  assert.ok(row?.ack_sent_at, 'ack_sent_at covered by the Done claim');
  assert.ok(row?.progress_last_sent_at, 'progress_last_sent_at covered by the Done claim');
  assert.equal(r1.sent, 1);

  const sent2: string[] = [];
  engine.runTrustEngineSweep({
    taskId: 'four-1',
    now: TWO_PM_ET,
    send: (chat, msg) => { sent2.push(`${chat}:${msg}`); return true; },
    escalate: () => {},
  });
  assert.equal(sent2.length, 0, 'second sweep sends nothing — no late acknowledgement');
});

// ── 2. First sight of in_progress covers the ack ─────────────────────────────

test('case 2: a task first seen in_progress sends the progress text once and covers the ack', () => {
  insertTask({ id: 'four-2', title: 'Moving task', status: 'in_progress' });

  const sent1: string[] = [];
  engine.runTrustEngineSweep({
    taskId: 'four-2',
    now: TWO_PM_ET,
    send: (chat, msg) => { sent1.push(`${chat}:${msg}`); return true; },
    escalate: () => {},
  });
  assert.equal(sent1.length, 1, 'one send');
  assert.match(sent1[0], /is in progress with/);

  const row = db.queryOne<{ ack_sent_at: string | null }>(
    'SELECT ack_sent_at FROM tasks WHERE id = ?', ['four-2'],
  );
  assert.ok(row?.ack_sent_at, 'ack_sent_at is covered by the progress claim');

  const sent2: string[] = [];
  engine.runTrustEngineSweep({
    taskId: 'four-2',
    now: TWO_PM_ET,
    send: (chat, msg) => { sent2.push(`${chat}:${msg}`); return true; },
    escalate: () => {},
  });
  assert.equal(sent2.length, 0, 'no acknowledgement on the next sweep');
});

// ── 3. A blocked reminder wakes nobody; a due one re-sends ───────────────────

test('case 3: a blocked reminder re-sends when due by day, holds its stamp at night, and first notice always goes', () => {
  const sevenHoursBefore = new Date(TWO_PM_ET.getTime() - 7 * HOUR_MS).toISOString();
  const base = {
    id: 'four-3',
    status: 'blocked',
    block_audience: 'OWNER',
    block_needs: 'the signed contract',
    ack_sent_at: new Date(TWO_PM_ET.getTime() - 10 * HOUR_MS).toISOString(),
    progress_last_sent_at: new Date(TWO_PM_ET.getTime() - 10 * HOUR_MS).toISOString(),
  };

  // 2:00 PM Eastern: due (7h > 6h), so one send and the stamp moves forward.
  db.run(
    `INSERT INTO tasks (id, title, status, priority, requester_channel, requester_chat_id,
        block_audience, block_needs, blocked_notice_sent_at, ack_sent_at, progress_last_sent_at,
        created_at, updated_at, workspace_id)
     VALUES ('four-3', 'Blocked task', 'blocked', 'medium', 'telegram', '9003',
        'OWNER', 'the signed contract', ?, ?, ?, ?, ?, 'default')`,
    [sevenHoursBefore, base.ack_sent_at, base.progress_last_sent_at, sevenHoursBefore, sevenHoursBefore],
  );
  const dayPlans = engine.planSends([mkRow({ ...base, blocked_notice_sent_at: sevenHoursBefore })], {
    now: TWO_PM_ET,
    deliverableFor: noDeliverable,
  });
  assert.equal(dayPlans.length, 1, 'a blocked reminder past the interval is due by day');
  assert.equal(dayPlans[0].stamps[0].guardColumn, 'blocked_notice_sent_at');
  const sent: string[] = [];
  engine.executeSends(dayPlans, {
    now: TWO_PM_ET,
    send: (chat, msg) => { sent.push(`${chat}:${msg}`); return true; },
    escalate: () => {},
  });
  assert.equal(sent.length, 1);
  const moved = db.queryOne<{ blocked_notice_sent_at: string | null }>(
    'SELECT blocked_notice_sent_at FROM tasks WHERE id = ?', ['four-3'],
  );
  assert.equal(moved?.blocked_notice_sent_at, TWO_PM_ET.toISOString(), 'the stamp moved forward');

  // 2:00 AM Eastern: the same row is held and its stamp is untouched.
  const nightPlans = engine.planSends([mkRow({ ...base, blocked_notice_sent_at: sevenHoursBefore })], {
    now: TWO_AM_ET,
    deliverableFor: noDeliverable,
  });
  assert.equal(nightPlans.length, 0, 'a night reminder wakes nobody');
  db.run('UPDATE tasks SET blocked_notice_sent_at = ? WHERE id = ?', [sevenHoursBefore, 'four-3']);
  engine.executeSends(nightPlans, {
    now: TWO_AM_ET,
    send: () => { throw new Error('must not send'); },
    escalate: () => {},
  });
  const untouched = db.queryOne<{ blocked_notice_sent_at: string | null }>(
    'SELECT blocked_notice_sent_at FROM tasks WHERE id = ?', ['four-3'],
  );
  assert.equal(untouched?.blocked_notice_sent_at, sevenHoursBefore, 'the stamp is unchanged');

  // A first notice (no stamp yet) goes out at any hour.
  const firstPlans = engine.planSends([mkRow({ ...base, id: 'four-3-first', blocked_notice_sent_at: null })], {
    now: TWO_AM_ET,
    deliverableFor: noDeliverable,
  });
  assert.equal(firstPlans.length, 1, 'a first blocked notice is never held');
});

// ── 4. A repeatable stamp claims against its prior value ────────────────────

test('case 4: phase progress claims against the prior stamp and updates the label', () => {
  const twoHoursBefore = new Date(TWO_PM_ET.getTime() - 2 * HOUR_MS).toISOString();
  const threeHoursBefore = new Date(TWO_PM_ET.getTime() - 3 * HOUR_MS).toISOString();
  db.run(
    `INSERT INTO tasks (id, title, status, priority, requester_channel, requester_chat_id,
        ack_sent_at, progress_last_sent_at, phase_progress_sent_at, last_reported_phase_label,
        created_at, updated_at, workspace_id)
     VALUES ('four-4', 'Phase task', 'in_progress', 'medium', 'telegram', '9004',
        ?, ?, ?, 'Outline', ?, ?, 'default')`,
    [threeHoursBefore, threeHoursBefore, twoHoursBefore, threeHoursBefore, threeHoursBefore],
  );
  const row = mkRow({
    id: 'four-4',
    title: 'Phase task',
    status: 'in_progress',
    ack_sent_at: threeHoursBefore,
    progress_last_sent_at: threeHoursBefore,
    phase_progress_sent_at: twoHoursBefore,
    last_reported_phase_label: 'Outline',
  });
  const plans = engine.planSends([row], {
    now: TWO_PM_ET,
    deliverableFor: noDeliverable,
    phaseFor: () => ({ label: 'Slides', budgetMs: 10 * 60 * 1000, doneCount: 2, totalCount: 5 }),
  });
  assert.equal(plans.length, 1, 'a stale, advanced phase is due');
  assert.equal(plans[0].stamps[0].expectedPrior, twoHoursBefore, 'the claim expects the prior value');
  const sent: string[] = [];
  engine.executeSends(plans, {
    now: TWO_PM_ET,
    send: (chat, msg) => { sent.push(`${chat}:${msg}`); return true; },
    escalate: () => {},
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Slides/);
  const after = db.queryOne<{ last_reported_phase_label: string | null; phase_progress_sent_at: string | null }>(
    'SELECT last_reported_phase_label, phase_progress_sent_at FROM tasks WHERE id = ?', ['four-4'],
  );
  assert.equal(after?.last_reported_phase_label, 'Slides', 'the label moved');
  assert.equal(after?.phase_progress_sent_at, TWO_PM_ET.toISOString(), 'the stamp moved');
});

// ── 5. Quiet hours on a named clock ─────────────────────────────────────────

test('case 5: quiet hours are read in the configured client zone even when the box clock is UTC', () => {
  assert.equal(process.env.TZ, 'UTC', 'the box clock is UTC for this proof');
  assert.equal(engine.isQuietHour(new Date('2026-11-12T03:30:00.000Z')), true, '10:30 PM Eastern is quiet');
  assert.equal(engine.isQuietHour(new Date('2026-11-12T15:00:00.000Z')), false, '10:00 AM Eastern is not');

  process.env.TRUST_ENGINE_TIMEZONE = 'Not/AZone';
  try {
    assert.equal(engine.isQuietHour(new Date('2026-11-12T03:30:00.000Z')), true, 'bad zone falls back to Eastern');
    assert.equal(engine.isQuietHour(new Date('2026-11-12T15:00:00.000Z')), false, 'bad zone falls back to Eastern');
  } finally {
    delete process.env.TRUST_ENGINE_TIMEZONE;
  }
});

// ── 6. No server paths in a client message ──────────────────────────────────

test('case 6: a file deliverable reports its basename only; a link is passed through', () => {
  const filePlans = engine.planSends([mkRow({ id: 'four-6', status: 'done', title: 'Deck' })], {
    now: TWO_PM_ET,
    deliverableFor: () => ({ location: '/data/x/artifacts/abc/deck.pdf', summary: "Here's the deck." }),
  });
  assert.equal(filePlans.length, 1);
  assert.match(filePlans[0].message, /deck\.pdf/);
  assert.doesNotMatch(filePlans[0].message, /\/data/);
  assert.equal(filePlans[0].stamps[0].extraSets.result_location, '/data/x/artifacts/abc/deck.pdf',
    'the operator record keeps the full path');

  const linkPlans = engine.planSends([mkRow({ id: 'four-6b', status: 'done', title: 'Page' })], {
    now: TWO_PM_ET,
    deliverableFor: () => ({ location: 'https://example.org/d', summary: 'Here is the page.' }),
  });
  assert.equal(linkPlans.length, 1);
  assert.match(linkPlans[0].message, /https:\/\/example\.org\/d/);
});

// ── 7. Plain words, no jargon ───────────────────────────────────────────────

test('case 7: department codes read as plain words and the banned jargon is gone', () => {
  const webAck = engine.planSends(
    [mkRow({ id: 'four-7a', status: 'assigned', department: 'web-development' })],
    { now: TWO_PM_ET, deliverableFor: noDeliverable },
  );
  assert.match(webAck[0].message, /the web development team/);

  const generalAck = engine.planSends(
    [mkRow({ id: 'four-7b', status: 'assigned', department: 'general-task' })],
    { now: TWO_PM_ET, deliverableFor: noDeliverable },
  );
  assert.match(generalAck[0].message, /our general team/);

  // Every message this file can build, in one place.
  const old = new Date(TWO_PM_ET.getTime() - 11 * 60 * 1000).toISOString();
  const allPlans = [
    ...engine.planSends([mkRow({ id: 'j1', status: 'backlog', created_at: old, requester_chat_id: '7701' })], {
      now: TWO_PM_ET, deliverableFor: noDeliverable,
    }),
    ...engine.planSends([mkRow({ id: 'j2', status: 'assigned', department: 'web-development', requester_chat_id: '7702' })], {
      now: TWO_PM_ET, deliverableFor: noDeliverable,
    }),
    ...engine.planSends([mkRow({ id: 'j3', status: 'in_progress', requester_chat_id: '7703' })], {
      now: TWO_PM_ET, deliverableFor: noDeliverable,
    }),
    ...engine.planSends([mkRow({ id: 'j4', status: 'blocked', block_audience: 'OWNER', block_needs: 'the logo', requester_chat_id: '7704' })], {
      now: TWO_PM_ET, deliverableFor: noDeliverable,
    }),
    ...engine.planSends([mkRow({ id: 'j5', status: 'done', requester_chat_id: '7705' })], {
      now: TWO_PM_ET, deliverableFor: () => ({ location: '/data/deck.pdf', summary: "Here's the deck." }),
    }),
  ];
  assert.ok(allPlans.length >= 5, 'every message kind was built');
  for (const plan of allPlans) {
    assert.doesNotMatch(plan.message, /grooming/i, `banned word "grooming" in: ${plan.message}`);
    assert.doesNotMatch(plan.message, /department/i, `banned word "department" in: ${plan.message}`);
  }
});

// ── 8. A muted gateway is not a loop ────────────────────────────────────────

test('case 8: a muted gateway leaves the row untouched and reports the same row held each sweep', () => {
  const created = '2020-01-01T00:00:00.000Z';
  insertTask({ id: 'four-8', status: 'assigned', createdAt: created, updatedAt: created });

  for (let i = 0; i < 3; i += 1) {
    const r = engine.runTrustEngineSweep({ taskId: 'four-8', now: TWO_PM_ET, escalate: () => {} });
    assert.equal(r.held, 1, `sweep ${i + 1} reports the row held`);
    assert.equal(r.sent, 0, `sweep ${i + 1} sends nothing`);
  }

  const events = db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = 'four-8'
      AND type IN ('trust_ack', 'trust_progress', 'trust_done', 'trust_phase_progress')`,
  );
  assert.equal(events?.n, 0, 'no trust_* event rows were written');
  const row = db.queryOne<{ updated_at: string }>('SELECT updated_at FROM tasks WHERE id = ?', ['four-8']);
  assert.equal(row?.updated_at, created, 'updated_at is untouched');
});

// ── 9. One sender: the owner-report funnel stands down ──────────────────────

test('case 9: the report funnel stands down for a requester task, and still sends when the engine is off', () => {
  insertTask({ id: 'four-9', status: 'assigned', requesterChatId: '9009' });

  const skipped = ownerReports.deliverTaskReport('four-9', 'your task is complete', { kind: 'done' });
  assert.equal(skipped.delivered, false);
  assert.ok(skipped.skipped && /trust engine/.test(skipped.skipped), 'the skip names the single sender');

  process.env.DISABLE_TRUST_ENGINE = '1';
  try {
    const sent = ownerReports.deliverTaskReport('four-9', 'your task is complete', { kind: 'done' });
    assert.equal(sent.skipped, undefined, 'with the engine off the funnel sends as before');
  } finally {
    delete process.env.DISABLE_TRUST_ENGINE;
  }

  // A task with no requester address keeps the owner lane.
  insertTask({ id: 'four-9-owner', status: 'assigned', requesterChatId: null });
  const owner = ownerReports.deliverTaskReport('four-9-owner', 'owner report', { kind: 'done' });
  assert.equal(owner.destination.lane, 'owner', 'no requester → owner lane, unchanged');
});
