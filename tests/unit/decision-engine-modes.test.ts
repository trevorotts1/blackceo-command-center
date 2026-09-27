/**
 * JEV-234 (CC D34) mode/compatibility adapter tests (offline only).
 *
 * Pure policy interpretation: no spawn, no network, no database, no keys.
 * Spec 3.6 (mode semantics), 3.8 (capability is not permission), 3.9
 * (shadow read-only), 14.8 (two-repo compatibility), 17.3/17.4
 * (activation/rollback). Acceptance A43, A53, A59-A63.
 *
 * Covers:
 *  1. off/legacy: identical normalized no-JEV decisions, zero probe/JEV/
 *     shadow permission (A62).
 *  2. auto denied by policy: truthful no-JEV fallback, distinct skip
 *     reasons, never mislabeled as missing credentials (A59).
 *  3. Mode/policy change fences uncommitted recommendations; committed
 *     snapshots are never rewritten (A63).
 *  4. Paired ONB/CC cohort activation: exact-SHA pair + compat + evidence
 *     required; drift or half-promotion blocks (A53, A43).
 *  5. parseConfiguredMode: explicit client settings survive; unknown input
 *     falls back without crashing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkPairedCohortActivation,
  fenceStaleRecommendations,
  isRecommendationFenced,
  parseConfiguredMode,
  resolveEffectivePath,
  type CapabilityState,
  type ModeResolutionInput,
  type PolicyGate,
} from '../../src/lib/decision-engine/index';

const COMPAT: CapabilityState = { compatible: true, coreVersion: '1.1.0' };
const ABSENT: CapabilityState = { compatible: false, reason: 'core_absent' };
const GATE_OK: PolicyGate = { spendAuthorized: true, dataPermitted: true, policyVersion: 'decision-policy-v1' };

function input(over: Partial<ModeResolutionInput> = {}): ModeResolutionInput {
  return {
    configuredMode: 'auto',
    capability: COMPAT,
    gate: GATE_OK,
    configRevision: 'cfg-1',
    shadowAllowanceApproved: false,
    ...over,
  };
}

// 1. off/legacy: same no-JEV engine, zero JEV/probe/shadow traffic (A62).
test('off and legacy yield equivalent normalized no-JEV decisions', () => {
  const off = resolveEffectivePath(input({ configuredMode: 'off' }));
  const legacy = resolveEffectivePath(input({ configuredMode: 'legacy' }));
  for (const r of [off, legacy]) {
    assert.equal(r.effectivePath, 'no_jev');
    assert.equal(r.useJev, false);
    assert.equal(r.jevCallsAllowed, false);
    assert.equal(r.probeAllowed, false);
    assert.equal(r.shadowAllowed, false);
    assert.equal(r.configRevision, 'cfg-1');
    assert.equal(r.policyVersion, 'decision-policy-v1');
  }
  assert.equal(off.skipReason, 'mode_off');
  assert.equal(legacy.skipReason, 'mode_legacy');
  // Apart from mode/diagnostic labels, the authoritative decision is the same.
  assert.equal(off.effectivePath, legacy.effectivePath);
  assert.equal(off.useJev, legacy.useJev);
  assert.equal(off.jevCallsAllowed, legacy.jevCallsAllowed);
  assert.equal(off.probeAllowed, legacy.probeAllowed);
  assert.equal(off.shadowAllowed, legacy.shadowAllowed);
});

test('off/legacy issue zero probe permission even with compatible core and full policy', () => {
  const off = resolveEffectivePath(
    input({ configuredMode: 'off', capability: COMPAT, gate: GATE_OK }),
  );
  assert.equal(off.probeAllowed, false, 'off must skip probeInstalledCore too');
  const legacy = resolveEffectivePath(
    input({ configuredMode: 'legacy', capability: COMPAT, gate: GATE_OK }),
  );
  assert.equal(legacy.probeAllowed, false, 'legacy must skip probeInstalledCore too');
});

// 2. auto denied: truthful fallback, denial not mislabeled (A59).
test('auto with incompatible core reports core reason, not policy denial', () => {
  const r = resolveEffectivePath(input({ capability: ABSENT }));
  assert.equal(r.effectivePath, 'no_jev');
  assert.equal(r.useJev, false);
  assert.equal(r.skipReason, 'core_absent');
});

test('auto denied by spend policy reports not_authorized, claims no JEV activity', () => {
  const r = resolveEffectivePath(
    input({ gate: { ...GATE_OK, spendAuthorized: false } }),
  );
  assert.equal(r.effectivePath, 'no_jev');
  assert.equal(r.useJev, false);
  assert.equal(r.skipReason, 'not_authorized');
  assert.notEqual(r.skipReason, 'core_absent');
  assert.ok(r.effectiveLabel.includes('no_jev'));
  assert.ok(!r.effectiveLabel.includes('JEV active'));
});

test('auto denied by data policy reports data_not_permitted', () => {
  const r = resolveEffectivePath(
    input({ gate: { ...GATE_OK, dataPermitted: false } }),
  );
  assert.equal(r.effectivePath, 'no_jev');
  assert.equal(r.skipReason, 'data_not_permitted');
  assert.notEqual(r.skipReason, 'core_absent');
});

test('auto eligible commits JEV; shadow never commits and needs allowance', () => {
  const auto = resolveEffectivePath(input());
  assert.equal(auto.effectivePath, 'jev');
  assert.equal(auto.useJev, true);
  assert.equal(auto.shadowAllowed, false);
  assert.equal(auto.skipReason, null);

  const shadowNoAllowance = resolveEffectivePath(input({ configuredMode: 'shadow' }));
  assert.equal(shadowNoAllowance.effectivePath, 'no_jev');
  assert.equal(shadowNoAllowance.useJev, false);
  assert.equal(shadowNoAllowance.shadowAllowed, false);
  assert.equal(shadowNoAllowance.skipReason, 'no_shadow_allowance');

  const shadow = resolveEffectivePath(
    input({ configuredMode: 'shadow', shadowAllowanceApproved: true }),
  );
  assert.equal(shadow.effectivePath, 'no_jev');
  assert.equal(shadow.useJev, false, 'shadow recommendations cannot commit');
  assert.equal(shadow.shadowAllowed, true);
  assert.equal(shadow.probeAllowed, true);

  const shadowDenied = resolveEffectivePath(
    input({
      configuredMode: 'shadow',
      shadowAllowanceApproved: true,
      gate: { ...GATE_OK, spendAuthorized: false },
    }),
  );
  assert.equal(shadowDenied.shadowAllowed, false);
  assert.equal(shadowDenied.skipReason, 'not_authorized');
});

// 3. Fencing: recommendations only, snapshots never rewritten (A63).
test('config revision change fences stale uncommitted recommendations', () => {
  assert.equal(isRecommendationFenced('cfg-1', 'cfg-1'), false);
  assert.equal(isRecommendationFenced('cfg-1', 'cfg-2'), true);
  assert.equal(isRecommendationFenced('cfg-1', 'cfg-1', 'p1', 'p1'), false);
  assert.equal(isRecommendationFenced('cfg-1', 'cfg-1', 'p1', 'p2'), true);
});

test('fenceStaleRecommendations splits kept from fenced without rewriting', () => {
  const recs = [
    { id: 'a', configRevision: 'cfg-2' },
    { id: 'b', configRevision: 'cfg-1' },
    { id: 'c', configRevision: 'cfg-2', policyVersion: 'p2' },
  ];
  const { kept, fenced } = fenceStaleRecommendations(recs, 'cfg-2', 'p1');
  assert.deepEqual(kept.map((r) => r.id), ['a']);
  assert.deepEqual(fenced.map((r) => r.id), ['b', 'c']);
  // Inputs untouched: fence drops, never rewrites.
  assert.equal(recs[1].configRevision, 'cfg-1');
});

test('auto to off transition resolves off with probe fenced', () => {
  const before = resolveEffectivePath(input());
  assert.equal(before.useJev, true);
  const after = resolveEffectivePath(input({ configuredMode: 'off' }));
  assert.equal(after.useJev, false);
  assert.equal(after.probeAllowed, false);
  assert.equal(after.skipReason, 'mode_off');
  assert.ok(isRecommendationFenced('cfg-1', 'cfg-2'));
});

// 4. Paired cohort activation (A53, A43).
test('cohort activates only on exact pair, both compatible, evidence present', () => {
  const pair = {
    ccSha: 'cc-aaa',
    onbSha: 'onb-bbb',
    ccExpectedSha: 'cc-aaa',
    onbExpectedSha: 'onb-bbb',
    ccCompatible: true,
    onbCompatible: true,
    cohortEvidencePresent: true,
  };
  const ok = checkPairedCohortActivation(pair);
  assert.equal(ok.activatable, true);
  assert.deepEqual(ok.reasons, []);
});

test('SHA drift, incompatibility, or missing evidence each block activation', () => {
  const base = {
    ccSha: 'cc-aaa',
    onbSha: 'onb-bbb',
    ccExpectedSha: 'cc-aaa',
    onbExpectedSha: 'onb-bbb',
    ccCompatible: true,
    onbCompatible: true,
    cohortEvidencePresent: true,
  };
  const drifted = checkPairedCohortActivation({ ...base, ccSha: 'cc-NEW' });
  assert.equal(drifted.activatable, false);
  assert.ok(drifted.reasons.some((r) => r.includes('cc SHA drift')));

  const halfPromoted = checkPairedCohortActivation({
    ...base,
    onbCompatible: false,
    onbCompatDetail: 'schema major mismatch',
  });
  assert.equal(halfPromoted.activatable, false);
  assert.ok(halfPromoted.reasons.some((r) => r.includes('onb side incompatible')));

  const noEvidence = checkPairedCohortActivation({ ...base, cohortEvidencePresent: false });
  assert.equal(noEvidence.activatable, false);
  assert.ok(noEvidence.reasons.some((r) => r.includes('cohort evidence absent')));
});

// 5. parseConfiguredMode preserves explicit client settings.
test('parseConfiguredMode keeps explicit modes, falls back safely', () => {
  assert.equal(parseConfiguredMode('off'), 'off');
  assert.equal(parseConfiguredMode('LEGACY'), 'legacy');
  assert.equal(parseConfiguredMode(' shadow '), 'shadow');
  assert.equal(parseConfiguredMode('auto'), 'auto');
  // Unknown input never crashes and never invents a restrictive override.
  assert.equal(parseConfiguredMode('turbo', 'auto'), 'auto');
  assert.equal(parseConfiguredMode(undefined, 'legacy'), 'legacy');
});
