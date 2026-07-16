/**
 * winner-harvest-approve-roundtrip.test.ts — A-U11 CC-repo half, criteria
 * (f) and (g) (derived per the A-U6(f) precedent; see the sibling
 * winner-harvest-sweep-idempotent.test.ts header for why these criteria are
 * authored here rather than quoted from the spec).
 *
 * (f) The operator approve action writes status='approved' + non-empty
 *     approved_by + approved_at into the SAME ledger record — mutating
 *     ONLY those three fields, matching shared-utils/winner_harvest.py's
 *     `approve_card()` byte-for-byte — and the mutated record then clears
 *     ONB's `harvest_into_library` GATE (is_card_approved -> candidate_id
 *     match -> not-already-harvested), the round-trip that proves
 *     byte-compatibility. `onbHarvestGate()` below is a TEST-ONLY mirror of
 *     that gate (read verbatim off shared-utils/winner_harvest.py,
 *     harvest_into_library lines 294-308 at commit 89414746e68e) — CC does
 *     not ship this logic in production source; it never writes the
 *     exemplar pack itself (ONB-owned, explicitly out of scope for this leg).
 *
 * (g) No code path writes `approved` without a deliberate operator action:
 *     the sweep (winner-harvest surfacing Rule) only ever READS pending
 *     cards and writes board-signal events — it never calls
 *     `approveHarvestCard`. Proven behaviorally: a card seeded
 *     pending_approval stays pending_approval across repeated sweeps, and
 *     only `approveHarvestCard` (an explicit, separate call, requiring a
 *     non-empty operator identity) ever flips it.
 *
 *   node --import tsx --test tests/unit/winner-harvest-approve-roundtrip.test.ts
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

const WORKSPACE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-winner-harvest-approve-ws-'));
process.env.CLIENT_WORKSPACE_BASE_DIR = WORKSPACE_BASE;
process.env.CC_CLIENT_NAME = 'fixture-client-alpha';
delete process.env.COMPANY_NAME;

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../../src/lib/db';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';
import { approveHarvestCard, findHarvestCard, loadHarvestLedger } from '../../src/lib/winner-harvest';
import { fixtureCard, seedLedger, type FixtureCandidate } from './_winner-harvest-fixtures';

getDb();

const CLIENT_ID = 'fixture-client-alpha';

/**
 * TEST-ONLY mirror of shared-utils/winner_harvest.py's
 * `harvest_into_library` GATE (not the write — CC never writes exemplar
 * packs). Read verbatim from the ONB module at the pinned commit
 * (89414746e68e), harvest_into_library lines 294-308:
 *   if not is_card_approved(card): refuse card_not_approved
 *   if card.candidate_id != candidate_id(candidate): refuse card_candidate_mismatch
 *   if card.harvested: already_harvested (still gate-clear)
 *   else: gate-clear.
 */
function onbHarvestGate(
  card: { status: string; candidate_id: string; harvested: boolean } | null,
  candidateIdOfBuild: string,
): { cleared: boolean; reason: string } {
  if (!card || card.status !== 'approved') return { cleared: false, reason: 'card_not_approved' };
  if (card.candidate_id !== candidateIdOfBuild) return { cleared: false, reason: 'card_candidate_mismatch' };
  if (card.harvested) return { cleared: true, reason: 'already_harvested' };
  return { cleared: true, reason: 'ok' };
}

const candidate: FixtureCandidate = {
  client_id: CLIENT_ID,
  skill: '06-ghl-install-pages',
  deliverable_type: 'lead',
  slug: 'roundtrip-optin',
  source_task_id: 'task-rt-1',
  qc_score: 9.2,
};

test('(f) approveHarvestCard writes status/approved_by/approved_at and mutates NOTHING else', () => {
  const seeded = fixtureCard(candidate);
  seedLedger(WORKSPACE_BASE, CLIENT_ID, [seeded]);

  const before = findHarvestCard(WORKSPACE_BASE, CLIENT_ID, seeded.card_id)!;
  assert.equal(before.status, 'pending_approval');

  const approved = approveHarvestCard(WORKSPACE_BASE, CLIENT_ID, seeded.card_id, 'operator-fixture');
  assert.ok(approved, 'approve returns the updated card');
  assert.equal(approved!.status, 'approved');
  assert.equal(approved!.approved_by, 'operator-fixture');
  assert.match(approved!.approved_at as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'UTC %Y-%m-%dT%H:%M:%SZ, byte-identical format to ONB _ts()');

  // Every OTHER field carried through byte-for-byte — "nothing else may be
  // mutated" (the spec's own contract language for this action).
  for (const key of ['card_id', 'candidate_id', 'client_id', 'skill', 'deliverable_type', 'slug', 'qc_score', 'source_task_id', 'proposed_at', 'harvested', 'harvested_at'] as const) {
    assert.deepEqual(approved![key], before[key], `field '${key}' must be untouched by approval`);
  }

  // Persisted to DISK in that exact shape — read raw, bypassing CC's own
  // reader, so this proves the WRITE, not just the in-memory return value.
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(WORKSPACE_BASE, CLIENT_ID, 'routing', 'harvest-cards.json'), 'utf-8'),
  );
  const onDiskCard = onDisk.cards.find((c: { card_id: string }) => c.card_id === seeded.card_id);
  assert.equal(onDiskCard.status, 'approved');
  assert.equal(onDiskCard.approved_by, 'operator-fixture');

  // (f) round-trip: the mutated record now clears ONB's harvest gate.
  const gate = onbHarvestGate(approved, seeded.candidate_id);
  assert.equal(gate.cleared, true, 'the CC-approved record clears the ONB harvest_into_library gate');
});

test('(f) BEFORE approval, the same record is refused by the ONB gate (card_not_approved)', () => {
  const c: FixtureCandidate = { ...candidate, slug: 'pre-approval-check' };
  const seeded = fixtureCard(c);
  seedLedger(WORKSPACE_BASE, CLIENT_ID, [seeded]);
  const gate = onbHarvestGate(seeded, seeded.candidate_id);
  assert.equal(gate.cleared, false);
  assert.equal(gate.reason, 'card_not_approved');
});

test('approveHarvestCard requires a non-empty operator identity (mirrors ONB ValueError-on-empty)', () => {
  const c: FixtureCandidate = { ...candidate, slug: 'empty-approver-check' };
  const seeded = fixtureCard(c);
  seedLedger(WORKSPACE_BASE, CLIENT_ID, [seeded]);
  assert.throws(() => approveHarvestCard(WORKSPACE_BASE, CLIENT_ID, seeded.card_id, ''));
  assert.throws(() => approveHarvestCard(WORKSPACE_BASE, CLIENT_ID, seeded.card_id, '   '));

  const stillPending = findHarvestCard(WORKSPACE_BASE, CLIENT_ID, seeded.card_id)!;
  assert.equal(stillPending.status, 'pending_approval', 'a rejected empty-approver call never mutates the card');
});

test('approveHarvestCard never fabricates a card for an unknown card id', () => {
  const result = approveHarvestCard(WORKSPACE_BASE, CLIENT_ID, 'harvest-doesnotexist0000', 'operator-fixture');
  assert.equal(result, null);
});

test('(g) AUTO-APPROVE GUARD: the sweep never approves — a pending card stays pending across repeated sweeps', async () => {
  const c: FixtureCandidate = { ...candidate, slug: 'auto-approve-guard-check' };
  const seeded = fixtureCard(c);
  seedLedger(WORKSPACE_BASE, CLIENT_ID, [seeded]);

  for (let i = 0; i < 3; i++) {
    await runBoardHygiene();
  }

  const stillPending = findHarvestCard(WORKSPACE_BASE, CLIENT_ID, seeded.card_id)!;
  assert.equal(stillPending.status, 'pending_approval', 'the sweep surfaces cards but NEVER approves them');
  assert.equal(stillPending.approved_by, null);
  assert.equal(stillPending.approved_at, null);

  // Only the explicit approve call flips it — and once it does, a further
  // sweep must not un-approve it either (the sweep only ever reads).
  approveHarvestCard(WORKSPACE_BASE, CLIENT_ID, seeded.card_id, 'operator-fixture');
  await runBoardHygiene();
  const stillApproved = findHarvestCard(WORKSPACE_BASE, CLIENT_ID, seeded.card_id)!;
  assert.equal(stillApproved.status, 'approved');
});

test('sanity: loadHarvestLedger reflects the on-disk state read via the safe-fs rail', () => {
  const ledger = loadHarvestLedger(WORKSPACE_BASE, CLIENT_ID);
  assert.ok(Array.isArray(ledger.cards));
  assert.ok(ledger.cards.length > 0);
});
