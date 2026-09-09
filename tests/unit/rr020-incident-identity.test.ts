/**
 * tests/unit/rr020-incident-identity.test.ts — RR-020 CC projection identity.
 *
 * Proves the Command Center's incident identity rules on the pure projection
 * module (src/lib/rescue/incident-identity.ts):
 *   1. two tenants sharing one display label stay SEPARATE
 *   2. two boxes of the same client failing identically stay independently
 *      actionable (per-resource dedup, not per-person)
 *   3. the same incident repeated DEDUPES onto the immutable runtime id
 *   4. an ambiguous alias lookup, an unknown client and a spoofed returnTo
 *      can never cross contexts — they route to isolated operator triage and
 *      never choose a foreign delivery target
 *   5. person notification budget is separate from incident dedup
 *   6. routing keys: enrollment-bound identity + runtime incident id allowed;
 *      display name and caller return address forbidden (policy predicate)
 *   7. the RR-017 read-only dashboard contract still holds (dependency intact)
 *
 * Run: npx tsx --test tests/unit/rr020-incident-identity.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  incidentIdOf,
  incidentFingerprintOf,
  personBudgetKeyOf,
  routeIdentity,
  projectionPolicy,
} from '../../src/lib/rescue/incident-identity';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// 1. two tenants, same display label -> separate
// ---------------------------------------------------------------------------
test('RR-020 case 1: two tenants sharing one display label stay separate', () => {
  const rows = [
    { box_slug: 'rescue-tenant-one', client_label: 'same label co', aliases: null },
    { box_slug: 'rescue-tenant-two', client_label: 'same label co', aliases: null },
  ];
  // A label-only claim is a SUGGESTION at best: it must never pick one.
  const labelOnly = routeIdentity({ clientLabel: 'same label co' }, rows);
  assert.equal(labelOnly.kind, 'ambiguous');
  assert.equal(labelOnly.route, 'operator-triage');
  assert.equal((labelOnly as { candidates: unknown[] }).candidates.length, 2);
  // Exact slug claims DO resolve, each to its own enrollment identity.
  const one = routeIdentity({ boxSlug: 'rescue-tenant-one' }, rows);
  assert.equal(one.kind, 'exact');
  const two = routeIdentity({ boxSlug: 'rescue-tenant-two' }, rows);
  assert.equal(two.kind, 'exact');
  assert.notEqual((one as { boxSlug: string }).boxSlug, (two as { boxSlug: string }).boxSlug);
});

// ---------------------------------------------------------------------------
// 2. two boxes of one client, same failure -> independently actionable
// ---------------------------------------------------------------------------
test('RR-020 case 2: same failure on two boxes of one client yields two distinct fingerprints', () => {
  const problem = 'gateway down after config change on 2026-09-08 (0xdeadbeef)';
  const boxA = incidentFingerprintOf({
    ticketId: 'RR-000001', person: 'dana', client: 'dana co', box: 'rescue-dana-mac',
    problem, failureClass: 'gateway',
  });
  const boxB = incidentFingerprintOf({
    ticketId: 'RR-000002', person: 'dana', client: 'dana co', box: 'rescue-dana-vps',
    problem, failureClass: 'gateway',
  });
  assert.notEqual(`${boxA.boxSlug}::${boxA.signature}`, `${boxB.boxSlug}::${boxB.signature}`,
    'box slug is part of the fingerprint (dedup key = boxSlug::signature)');
  assert.equal(boxA.personBudgetKey, boxB.personBudgetKey, 'one person, one notification budget');
  assert.notEqual(boxA.incidentId, boxB.incidentId, 'each box keeps its own incident');
});

// ---------------------------------------------------------------------------
// 3. repeated same incident dedupes onto the immutable runtime id
// ---------------------------------------------------------------------------
test('RR-020 case 3: a repeat of the same incident folds onto the same runtime incident id', () => {
  const first = incidentFingerprintOf({
    ticketId: 'RR-000123', person: 'dana', client: 'dana co', box: 'rescue-dana-mac',
    problem: 'agent re-ran the same tool call 5 times', failureClass: 'loop',
  });
  const replay = incidentFingerprintOf({
    ticketId: 'RR-000123', person: 'dana', client: 'dana co', box: 'rescue-dana-mac',
    problem: 'agent re-ran the same tool call 5 times (12, 2026-09-08T10:00:00Z)',
    failureClass: 'loop',
  });
  assert.equal(incidentIdOf({ ticketId: 'RR-000123' }), 'RR-000123');
  assert.equal(replay.incidentId, first.incidentId, 'immutable runtime incident id');
  assert.equal(replay.signature, first.signature, 'volatile tokens stripped, wording matches');
  assert.equal(replay.personBudgetKey, first.personBudgetKey);
});

// ---------------------------------------------------------------------------
// 4. ambiguity / unknown / spoofed returnTo never cross contexts
// ---------------------------------------------------------------------------
test('RR-020 case 4: ambiguous alias, unknown client, spoofed returnTo all land in triage, never a foreign target', () => {
  const rows = [
    { box_slug: 'rescue-genuine-a', client_label: 'genuine co', aliases: 'genuine|genuineco' },
    { box_slug: 'rescue-genuine-b', client_label: 'genuine co', aliases: 'genuine|genuineco' },
  ];
  // ambiguous alias hit: two rows carry the alias -> suggestion only, no choice
  const ambiguous = routeIdentity({ boxSlug: 'genuine' }, rows);
  assert.equal(ambiguous.kind, 'ambiguous');
  assert.equal(ambiguous.route, 'operator-triage');
  const amb = ambiguous as { candidates: Array<{ boxSlug: string }> };
  assert.ok(amb.candidates.every((c) => c.boxSlug.startsWith('rescue-genuine-')),
    'candidates are suggestions, never a silently chosen target');

  // unknown client: unknown identity -> isolated triage with a stable key
  const unknown = routeIdentity({ boxSlug: 'rescue-who-dis', clientLabel: 'who dis' }, rows);
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.route, 'operator-triage');
  assert.match((unknown as { triageKey: string }).triageKey, /^unknown:rescue-who-dis$/);

  // spoofed returnTo with a foreign box claim: the return address is NEVER a
  // routing key; the unknown box claim still lands in triage, not delivery
  const spoofed = routeIdentity({ boxSlug: '', clientLabel: '', returnTo: '555000111' }, rows);
  assert.equal(spoofed.kind, 'unknown');
  assert.equal(spoofed.route, 'operator-triage');
  assert.notEqual((spoofed as { triageKey: string }).triageKey, '555000111');

  // a client_label match alone is a suggestion, never a delivery decision
  const labelOnly = routeIdentity({ clientLabel: 'genuine co' }, rows);
  assert.equal(labelOnly.kind, 'ambiguous');
  assert.equal(labelOnly.route, 'operator-triage');
});

// ---------------------------------------------------------------------------
// 5. person budget vs incident dedup are orthogonal
// ---------------------------------------------------------------------------
test('RR-020 case 5: notification budget keys on the person; dedup keys on box + signature', () => {
  const budgetA = personBudgetKeyOf({ person: 'dana', client: 'dana co', box: 'rescue-dana-mac' });
  const budgetB = personBudgetKeyOf({ person: 'dana', client: 'dana co', box: 'rescue-dana-vps' });
  assert.equal(budgetA, budgetB, 'one person, one notification budget across boxes');
  const unbound1 = personBudgetKeyOf({ person: null, client: null, box: 'rescue-unknown-x' });
  const unbound2 = personBudgetKeyOf({ person: null, client: null, box: 'rescue-unknown-y' });
  assert.notEqual(unbound1, unbound2, 'unbound identities degrade DISTINCT, never merge');
});

// ---------------------------------------------------------------------------
// 6. the routing-key policy is pinned in code, not prose
// ---------------------------------------------------------------------------
test('RR-020 case 6: policy predicate forbids display-name and return-address routing', () => {
  const policy = projectionPolicy();
  assert.equal(policy.clientSeesForeignRows, false);
  assert.equal(policy.clientSeesTriage, false);
  assert.ok(policy.routingKeysAllowed.includes('company enrollment runtime incident id'));
  assert.ok(policy.routingKeysForbidden.includes('display name'));
  assert.ok(policy.routingKeysForbidden.includes('caller return address'));
});

// ---------------------------------------------------------------------------
// 7. RR-017 dependency intact: dashboard stays read-only, tombstone intact
// ---------------------------------------------------------------------------
test('RR-020 case 7: RR-017 read-only dashboard contract still holds', () => {
  const db = fs.readFileSync(path.join(REPO, 'src', 'lib', 'rescue', 'db.ts'), 'utf8');
  assert.ok(db.includes('readonly: true'), 'dashboard still opens the store read-only');
  assert.ok(!/INSERT INTO|UPDATE tickets|DELETE FROM/.test(db), 'no write SQL crept into the reader');
  const mod = fs.readFileSync(path.join(REPO, 'src', 'lib', 'rescue', 'incident-identity.ts'), 'utf8');
  assert.ok(!/Database|sqlite/i.test(mod.replace(/\* |\*\/|THIS ENCODES|import type/g, '')),
    'the projection module is pure: no database handle, no credentials');
  assert.ok(!/RESCUE_PUSH_SECRET|RESCUE_RANGERS_WEBHOOK_SECRET/.test(mod),
    'no credential name is read by the projection module');
});
