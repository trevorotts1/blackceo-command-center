/**
 * winner-harvest-sweep-idempotent.test.ts — A-U11 CC-repo half, criterion
 * (e) (derived per the A-U6(f) precedent — see the unit's build notes: the
 * spec's A-U11 acceptance (a)-(d) is entirely ONB-side and already proven by
 * shared-utils/test_winner_harvest.py; A-U11 was never split into ONB/CC
 * halves the way A-U4/A-U5/A-U6/A-U7 were, so this criterion is authored
 * here following A-U6(f)'s exact pattern).
 *
 * From a SEEDED `harvest-cards.json` fixture (a tempdir standing in for the
 * client workspace — no ONB run, no live box): a card with
 * status='pending_approval' surfaces as EXACTLY ONE operator-approval board
 * signal (event-ledger dedupe, the board-hygiene pattern), and repeated
 * sweeps raise ZERO additional cards — idempotent across 3 repeat runs.
 * An already-approved sibling card in the SAME ledger must never be
 * re-surfaced (selectivity, not "any row present").
 *
 *   node --import tsx --test tests/unit/winner-harvest-sweep-idempotent.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_BOARD_HYGIENE;
delete process.env.DISABLE_BOARD_HYGIENE_WINNER_HARVEST;
// Isolate to ONLY the winner-harvest sweep — every other lane has nothing to
// match against this seed anyway, but disabling them keeps this a
// single-condition proof (same discipline as the sibling blend-invariant test).
process.env.DISABLE_BOARD_HYGIENE_BLOCKED = '1';
process.env.DISABLE_BOARD_HYGIENE_REVIEW = '1';
process.env.DISABLE_BOARD_HYGIENE_DONE = '1';
process.env.DISABLE_BOARD_HYGIENE_STALE = '1';
process.env.DISABLE_BOARD_HYGIENE_TRIAD = '1';
process.env.DISABLE_BOARD_HYGIENE_BLEND_REGRESSION = '1';
process.env.DISABLE_BOARD_HYGIENE_BLEND_INVARIANT = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-winner-harvest-sweep-ws-'));
process.env.CLIENT_WORKSPACE_BASE_DIR = WORKSPACE_BASE;
process.env.CC_CLIENT_NAME = 'fixture-client-alpha';
delete process.env.COMPANY_NAME;

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, queryAll } from '../../src/lib/db';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';
import { fixtureCard, seedLedger } from './_winner-harvest-fixtures';

getDb(); // apply full migration chain (events table)

const CLIENT_ID = 'fixture-client-alpha';

const pendingCandidate = {
  client_id: CLIENT_ID,
  skill: '06-ghl-install-pages',
  deliverable_type: 'lead',
  slug: 'spring-launch-optin',
  source_task_id: 'task-1',
  qc_score: 9.4,
};
const pendingCard = fixtureCard(pendingCandidate); // status: pending_approval

const alreadyApprovedCandidate = {
  client_id: CLIENT_ID,
  skill: '06-ghl-install-pages',
  deliverable_type: 'lead',
  slug: 'already-approved-slug',
  source_task_id: 'task-0',
  qc_score: 9.6,
};
const alreadyApprovedCard = fixtureCard(alreadyApprovedCandidate, {
  status: 'approved',
  approved_by: 'prior-operator',
  approved_at: '2026-07-15T12:00:00Z',
});

test.before(() => {
  seedLedger(WORKSPACE_BASE, CLIENT_ID, [pendingCard, alreadyApprovedCard]);
});

test('(e) a SEEDED pending_approval card surfaces as EXACTLY ONE operator-approval board signal', async () => {
  const result = await runBoardHygiene();

  assert.equal(result.winnerHarvestCardsSurfaced, 1, 'only the ONE pending card surfaces this run');
  assert.deepEqual(result.winnerHarvestCardsSurfacedIds, [pendingCard.card_id]);

  const events = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE type = 'winner_harvest_card_surfaced'`,
    [],
  );
  assert.equal(events.length, 1, 'exactly one board-signal event on the lane');
  assert.match(events[0].message, new RegExp(`^${CLIENT_ID}::${pendingCard.card_id}$`));
});

test('(e) an ALREADY-APPROVED sibling card is never surfaced (selectivity)', () => {
  const events = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE type = 'winner_harvest_card_surfaced' AND message = ?`,
    [`${CLIENT_ID}::${alreadyApprovedCard.card_id}`],
  );
  assert.equal(events.length, 0);
});

test('(e) idempotent across 3 REPEATED sweeps — zero additional cards raised', async () => {
  const before = queryAll(`SELECT id FROM events WHERE type = 'winner_harvest_card_surfaced'`, []).length;
  assert.equal(before, 1, 'sanity: one event already on the lane from the first sweep');

  for (let i = 0; i < 3; i++) {
    const result = await runBoardHygiene();
    assert.equal(result.winnerHarvestCardsSurfaced, 0, `repeat sweep #${i + 1} raises zero NEW cards`);
  }

  const after = queryAll(`SELECT id FROM events WHERE type = 'winner_harvest_card_surfaced'`, []).length;
  assert.equal(after, 1, 'still exactly ONE event total after 3 repeated sweeps — never duplicated');
});
