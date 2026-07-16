/**
 * winner-harvest-cross-client-isolation.test.ts — A-U11 CC-repo half,
 * criterion (h) (derived per the A-U6(f) precedent; see the sibling
 * winner-harvest-sweep-idempotent.test.ts header for why).
 *
 * A seeded TWO-CLIENT ledger set proves a card for client B is never
 * rendered or approvable on client A's box. CC does not rely on ONB's
 * `card_candidate_mismatch` backstop (that guard lives inside
 * `harvest_into_library`, which CC never calls) — CC's OWN structural
 * guarantee is stronger: `resolveHarvestClientId()` derives exactly ONE
 * client id from THIS box's own identity, and every ledger read/write in
 * this module is scoped to that one client's own `<client_id>/routing/
 * harvest-cards.json` file. A card belonging to a different client_id is
 * never even opened, let alone rendered or approved.
 *
 *   node --import tsx --test tests/unit/winner-harvest-cross-client-isolation.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_BOARD_HYGIENE;
delete process.env.DISABLE_BOARD_HYGIENE_WINNER_HARVEST;
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

const WORKSPACE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-winner-harvest-xclient-ws-'));
process.env.CLIENT_WORKSPACE_BASE_DIR = WORKSPACE_BASE;
// This box is scoped to ALPHA for the whole file.
process.env.CC_CLIENT_NAME = 'fixture-client-alpha';
delete process.env.COMPANY_NAME;

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { getDb, queryAll } from '../../src/lib/db';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';
import { approveHarvestCard, findHarvestCard } from '../../src/lib/winner-harvest';
import { fixtureCard, seedLedger, type FixtureCandidate } from './_winner-harvest-fixtures';
import { POST as approveRoute } from '../../src/app/api/harvest-cards/[id]/approve/route';

getDb();

const ALPHA = 'fixture-client-alpha';
const BETA = 'fixture-client-beta';

const alphaCandidate: FixtureCandidate = {
  client_id: ALPHA, skill: '06-ghl-install-pages', deliverable_type: 'lead',
  slug: 'spring-launch-optin', source_task_id: 'task-a1', qc_score: 9.4,
};
const betaCandidate: FixtureCandidate = {
  client_id: BETA, skill: '06-ghl-install-pages', deliverable_type: 'lead',
  slug: 'spring-launch-optin', source_task_id: 'task-b1', qc_score: 9.5,
};
const alphaCard = fixtureCard(alphaCandidate);
const betaCard = fixtureCard(betaCandidate);

test.before(() => {
  seedLedger(WORKSPACE_BASE, ALPHA, [alphaCard]);
  seedLedger(WORKSPACE_BASE, BETA, [betaCard]);
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function approveReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/harvest-cards/x/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('(h) the sweep on the ALPHA-scoped box surfaces ONLY alpha\'s card', async () => {
  const result = await runBoardHygiene();
  assert.equal(result.winnerHarvestCardsSurfaced, 1);
  assert.deepEqual(result.winnerHarvestCardsSurfacedIds, [alphaCard.card_id]);

  const events = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE type = 'winner_harvest_card_surfaced'`,
    [],
  );
  assert.equal(events.length, 1);
  assert.ok(events[0].message.startsWith(`${ALPHA}::`), 'the surfaced event names ALPHA, never BETA');
  assert.ok(!events[0].message.includes(BETA), 'BETA never appears in an alpha-box event');
});

test('(h) approveHarvestCard on the ALPHA box CANNOT reach beta\'s card (not found)', () => {
  // The library function is called with the box's OWN resolved client_id
  // (ALPHA) even though beta's card_id is presented — this is what "CC does
  // not rely on the ONB backstop" means in practice: CC structurally never
  // opens beta's ledger file to even LOOK for this card_id.
  const betaFileBefore = fs.readFileSync(path.join(WORKSPACE_BASE, BETA, 'routing', 'harvest-cards.json'), 'utf-8');

  const result = approveHarvestCard(WORKSPACE_BASE, ALPHA, betaCard.card_id, 'operator-fixture');
  assert.equal(result, null, 'beta\'s card id does not exist in alpha\'s own ledger');

  const betaFileAfter = fs.readFileSync(path.join(WORKSPACE_BASE, BETA, 'routing', 'harvest-cards.json'), 'utf-8');
  assert.equal(betaFileAfter, betaFileBefore, 'beta\'s ledger file is byte-UNCHANGED by an alpha-box approve attempt');

  const betaCardStillPending = findHarvestCard(WORKSPACE_BASE, BETA, betaCard.card_id)!;
  assert.equal(betaCardStillPending.status, 'pending_approval', 'beta\'s own card is untouched');
});

test('(h) the API route on the ALPHA box refuses betas card id with 404 — never accepts a client_id param', async () => {
  const res = await approveRoute(approveReq({ approvedBy: 'operator-fixture' }), ctx(betaCard.card_id));
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.match(json.error, /not found/i);
});

test('(h) the API route IGNORES a caller-supplied clientId in the body — still 404s on betas card', async () => {
  // A malicious or buggy caller passing clientId='fixture-client-beta' in the
  // body must NOT let an alpha-box request reach beta's ledger. client_id is
  // structurally derived from THIS box's own identity, never from request
  // input — this test would catch a regression that started trusting a
  // body-supplied clientId.
  const res = await approveRoute(
    approveReq({ approvedBy: 'operator-fixture', clientId: BETA }),
    ctx(betaCard.card_id),
  );
  assert.equal(res.status, 404);
  const betaCardStillPending = findHarvestCard(WORKSPACE_BASE, BETA, betaCard.card_id)!;
  assert.equal(betaCardStillPending.status, 'pending_approval', 'beta\'s card was never reached, let alone approved');
});

test('(h) the API route on the ALPHA box DOES approve alphas own card id', async () => {
  const res = await approveRoute(approveReq({ approvedBy: 'operator-fixture' }), ctx(alphaCard.card_id));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.card.status, 'approved');
  assert.equal(json.card.client_id, ALPHA);
});

test('(h) alpha and beta ledgers remain in disjoint on-disk directories', () => {
  const alphaDir = path.join(WORKSPACE_BASE, ALPHA);
  const betaDir = path.join(WORKSPACE_BASE, BETA);
  assert.notEqual(fs.realpathSync(alphaDir), fs.realpathSync(betaDir));
});
