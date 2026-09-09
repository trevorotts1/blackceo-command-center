/**
 * UNION-139 PROOF — runs the pristine social-f07-cycle.test.ts suite (copied verbatim from its home
 * worktree, only import depths adjusted) against THIS worktree's union
 * migration 139. It proves the single superset migration satisfies that
 * task's contract. Do not edit the tests below; edit the migration.
 */
/**
 * social-f07-cycle.test.ts — F07 acceptance (CC service layer).
 *
 * "Each new week gets one invitation, bounded reminders and a visible
 * disposition. A late answer cannot overwrite another week or create
 * duplicate posts." — proven against an isolated temp DB (full migration
 * chain incl. 139) with a fake clock.
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/f07-union-139.test.ts
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, getDb } from '../../src/lib/db';
import {
  MAX_REMINDERS,
  advanceCycle,
  applyResponse,
  ensureCycle,
  getCycle,
  nextWeekStart,
  sendDueReminder,
  sendInvitation,
  weekStartLocal,
} from '../../src/lib/social/cycle-service';
import {
  claimEngineOwnership,
  isEngineOwner,
  runSocialCycleSweep,
  verifyEngineOwnership,
} from '../../src/lib/jobs/social-cycle';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// 2026-09-06T12:00:00Z — a Sunday (client-local week start), America/New_York.
const T1 = 1788696000000;

function recorder(fail = false) {
  const sent: Array<Record<string, unknown>> = [];
  const fn = (payload: unknown) => {
    if (fail) return { delivered: false };
    sent.push(payload as Record<string, unknown>);
    return { delivered: true };
  };
  return { sent, fn };
}

test.after(() => {
  try { closeDb(); } catch { /* already closed */ }
});

test('F07: four unanswered weeks — one invitation per company/week, bounded reminders, visible disposition', async () => {
  const { sent, fn } = recorder();
  const t0 = T1;
  const weeks: string[] = [];
  for (let i = 0; i < 4; i++) {
    const t = t0 + i * 7 * DAY;
    const ws = weekStartLocal(t, { timezone: 'America/New_York' });
    weeks.push(ws);
    const r = await advanceCycle('co-a', t, { send: fn, timezone: 'America/New_York' });
    assert.equal(r.action, 'invite', `week ${i}: ${JSON.stringify(r)}`);
    // A second advance in the same week never re-invites.
    const r2 = await advanceCycle('co-a', t + 5 * 60_000, { send: fn, timezone: 'America/New_York' });
    assert.ok(r2.action === 'none' || r2.action === 'retry', r2.action);
    // Reminders: fire every cadence tick up to the bound.
    for (let k = 0; k < 10; k++) {
      await sendDueReminder('co-a', ws, fn, t + (8 + k * 8) * HOUR);
    }
    const weekMsgs = sent.filter((p) => p.weekStart === ws).length;
    assert.equal(weekMsgs, 1 + MAX_REMINDERS, `week ${i}: ${weekMsgs}`);
    // Cutoff closes with a visible draft disposition.
    const cr = await advanceCycle('co-a', t + 36 * HOUR, { send: fn, timezone: 'America/New_York' });
    assert.ok(cr.action === 'cutoff' || cr.action === 'next_cycle', cr.action);
    const cyc = getCycle('co-a', ws)!;
    assert.equal(cyc.state, 'closed');
    assert.ok(cyc.disposition && cyc.disposition.includes('draft'), cyc.disposition ?? '');
  }
  assert.equal(new Set(weeks).size, 4);
});

test('F07: DST change — the local week boundary follows the zone', async () => {
  const { fn } = recorder();
  // DST ends 2026-11-01 (America/New_York). Sundays 10-25 and 11-01.
  const before = 1792929600000; // 2026-10-25T12:00:00Z
  assert.equal(weekStartLocal(before, { timezone: 'America/New_York' }), '2026-10-25');
  const after = before + 7 * DAY;
  assert.equal(weekStartLocal(after, { timezone: 'America/New_York' }), '2026-11-01');
  // The DST instant itself stays in the same local week.
  assert.equal(weekStartLocal(after + 5 * HOUR, { timezone: 'America/New_York' }), '2026-11-01');
  const r1 = await advanceCycle('co-dst', before, { send: fn, timezone: 'America/New_York' });
  const r2 = await advanceCycle('co-dst', after, { send: fn, timezone: 'America/New_York' });
  assert.equal(r1.action, 'invite');
  assert.equal(r2.action, 'invite');
  assert.notEqual(
    getCycle('co-dst', '2026-10-25')!.id,
    getCycle('co-dst', '2026-11-01')!.id,
  );
});

test('F07: service restart — the durable row prevents a duplicate invitation', async () => {
  const { sent, fn } = recorder();
  const t = T1;
  const ws = weekStartLocal(t, { timezone: 'America/New_York' });
  await advanceCycle('co-r', t, { send: fn, timezone: 'America/New_York' });
  // "Restart": the sweep runs again (fresh in-process tick; same DB).
  await runSocialCycleSweep({
    send: fn,
    companies: [{ id: 'co-r' }],
    nowMs: t + 3 * HOUR,
  });
  const invites = sent.filter((p) => p.weekStart === ws);
  assert.equal(invites.length, 1, 'restart must not re-invite the same week');
});

test('F07: late reply records on its own cycle — never overwrites another week', async () => {
  const { fn } = recorder();
  const t = T1;
  const ws1 = weekStartLocal(t, { timezone: 'America/New_York' });
  const r1 = await advanceCycle('co-l', t, { send: fn, timezone: 'America/New_York' });
  await advanceCycle('co-l', t + 36 * HOUR, { send: fn, timezone: 'America/New_York' });
  const closed = getCycle('co-l', ws1)!;
  assert.equal(closed.state, 'closed');
  const t2 = t + 7 * DAY;
  const ws2 = weekStartLocal(t2, { timezone: 'America/New_York' });
  await advanceCycle('co-l', t2, { send: fn, timezone: 'America/New_York' });
  const late = applyResponse(closed.id, { kind: 'theme', theme: 'Autumn' }, t2 + DAY);
  assert.ok(late.ok);
  const w2 = getCycle('co-l', ws2)!;
  assert.equal(w2.state, 'invited', 'week 2 untouched by the late answer');
  const w1 = getCycle('co-l', ws1)!;
  assert.equal(w1.disposition, 'late_theme_recorded');
});

test('F07: skip closes only that cycle — next week still invited', async () => {
  const { fn } = recorder();
  const t = T1;
  const ws1 = weekStartLocal(t, { timezone: 'America/New_York' });
  const r = await advanceCycle('co-s', t, { send: fn, timezone: 'America/New_York' });
  const rr = applyResponse(r.cycleId, { kind: 'skip' }, t + HOUR);
  assert.equal((rr as { effect: string }).effect, 'skipped_this_week_only');
  const t2 = t + 7 * DAY;
  const ws2 = weekStartLocal(t2, { timezone: 'America/New_York' });
  const r2 = await advanceCycle('co-s', t2, { send: fn, timezone: 'America/New_York' });
  assert.equal(r2.action, 'invite', 'next week created independently of the skip');
  assert.notEqual(r2.cycleId, r.cycleId);
  assert.equal(getCycle('co-s', ws1)!.state, 'skipped');
  assert.equal(getCycle('co-s', ws2)!.state, 'invited');
});

test('F07: pause-reminders is an explicit preference', async () => {
  const { fn } = recorder();
  const t = T1;
  const ws = weekStartLocal(t, { timezone: 'America/New_York' });
  const r = await advanceCycle('co-p', t, { send: fn, timezone: 'America/New_York' });
  // Silence does NOT pause: the due reminder still fires.
  const rr = await sendDueReminder('co-p', ws, fn, t + 9 * HOUR);
  assert.equal(rr.action, 'sent');
  // Explicit pause: reminders stop.
  applyResponse(r.cycleId, { kind: 'pause' }, t + 10 * HOUR);
  const rr2 = await sendDueReminder('co-p', ws, fn, t + 17 * HOUR);
  assert.equal(rr2.action, 'skip');
  assert.equal(rr2.reason, 'paused');
});

test('F07: evergreen only with recorded standing approval — else draft + ask again', async () => {
  const { fn } = recorder();
  const t = T1;
  const ws = weekStartLocal(t, { timezone: 'America/New_York' });
  const r = await advanceCycle('co-e', t, { send: fn, timezone: 'America/New_York' });
  const rr = applyResponse(r.cycleId, { kind: 'evergreen' }, t + HOUR);
  assert.equal((rr as { effect: string }).effect, 'draft_prepared_ask_again');
  // Next week is still created (the ask repeats).
  const t2 = t + 7 * DAY;
  const ws2 = weekStartLocal(t2, { timezone: 'America/New_York' });
  const r2 = await advanceCycle('co-e', t2, { send: fn, timezone: 'America/New_York' });
  assert.equal(r2.action, 'invite');
  // Record standing approval on the week-2 cycle, then evergreen publishes.
  const db = getDb();
  db.prepare(`UPDATE social_cycles SET standing_approval = 'evergreen' WHERE id = ?`).run(r2.cycleId);
  const rr2 = applyResponse(r2.cycleId, { kind: 'evergreen' }, t2 + HOUR);
  assert.equal((rr2 as { effect: string }).effect, 'evergreen_published');
  assert.equal(getCycle('co-e', ws2)!.disposition, 'evergreen_published');
  void ws;
});

test('F07: unique(company, week) — double ensure collapses to one cycle', async () => {
  const t = T1;
  const ws = weekStartLocal(t, { timezone: 'America/New_York' });
  const a = ensureCycle('co-u', ws, {});
  const b = ensureCycle('co-u', ws, {});
  assert.equal(a.cycleId, b.cycleId);
  assert.equal(b.created, false);
  assert.equal(nextWeekStart(ws), '2026-09-13');
});

test('F17: engine ownership — one active owner per company, legacy superseded', () => {
  claimEngineOwnership('co-own', '2030-01-01T00:00:00Z');
  assert.ok(isEngineOwner('co-own'));
  // A second claim is idempotent (same active row updated).
  const second = claimEngineOwnership('co-own', '2030-01-01T01:00:00Z');
  const db = getDb();
  const active = db.prepare(
    `SELECT COUNT(*) AS n FROM social_engine_ownership WHERE company_id = ? AND state = 'active'`,
  ).get('co-own') as { n: number };
  assert.equal(active.n, 1);
  assert.ok(second.ownerRow.length > 0);
  const v = verifyEngineOwnership();
  assert.ok(v.ok, JSON.stringify(v));
  for (const r of (db.prepare(`SELECT company_id, COUNT(*) n FROM social_engine_ownership WHERE state='active' GROUP BY company_id`).all() as Array<{ company_id: string; n: number }>)) {
    assert.equal(r.n, 1, `company ${r.company_id} must have exactly one active owner`);
  }
});

test('F17: sweep with no companies is a clean no-op', async () => {
  const r = await runSocialCycleSweep({ companies: [], nowMs: T1 });
  assert.equal(r.scanned, 0);
  assert.equal(r.errors, 0);
});