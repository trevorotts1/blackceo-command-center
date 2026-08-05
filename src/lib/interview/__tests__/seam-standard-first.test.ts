/**
 * seam-standard-first.test.ts — AI Workforce standard-first (PHASE 6 QC pin).
 *
 * Pins the `computeExpectedDecisionIds` standardFirst branch (the gate #3
 * relaxation introduced in PHASE 6 item 3) INDEPENDENTLY of the E2E
 * (playwright.interview-lock.spec.ts) and of the Python-parity golden harness
 * (seam-parity.test.ts only exercises the legacy lane — none of its golden
 * `expectedSet` cases pass `standardFirst: true`).
 *
 * The two invariants this test locks, mirroring build-workforce's
 * `_enforce_decision_coverage_or_refuse` standard-first branch:
 *
 *   1. RECORDED DECLINE STAYS EXPECTED — a floor dept the owner explicitly
 *      declined (id present in `recordedDeclineIds`) stays in the expected set
 *      so its provenance is still demanded. Gate #8 stays strict on it; the
 *      relaxation never swallows a real "no".
 *
 *   2. UNRECORDED FLOOR DEPT IS IMPLICIT KEEP — a floor dept with NO recorded
 *      decision is EXCLUDED from the expected set. Silence = keep = the safe
 *      direction; the owner is not forced to re-confirm an already-prebuilt
 *      floor.
 *
 * Customs (owner-added non-floor depts) stay expected in BOTH lanes — the
 * relaxation only touches the floor. The legacy lane is also re-asserted here
 * as a byte-identical regression guard so a future edit to the branch cannot
 * silently flip the default.
 */
import { describe, it, expect } from 'vitest';

import {
  computeExpectedDecisionIds,
  norm,
  type CanonicalDepartments,
} from '@/lib/interview/seam';

/** Minimal canonical floor fixture — three mandatory + two universal-primary.
 *  Hand-built (not loaded from the parity golden) so this suite stays
 *  independent of the Python-regenerated fixture and of the live naming map. */
const canonical: CanonicalDepartments = {
  source: 'test-fixture',
  naming_map_version: 'test',
  mandatory_count: 3,
  mandatory: [
    { id: 'marketing', display_name: 'Marketing', one_liner: '' },
    { id: 'sales', display_name: 'Sales', one_liner: '' },
    { id: 'billing-finance', display_name: 'Billing & Finance', one_liner: '' },
  ],
  universal_primary_count: 2,
  universal_primary_vertical: [
    { id: 'executive', display_name: 'Executive', one_liner: '' },
    { id: 'operations', display_name: 'Operations', one_liner: '' },
  ],
  floor: 5,
};

const floorIds = [
  ...canonical.mandatory.map((d) => d.id),
  ...canonical.universal_primary_vertical.map((d) => d.id),
];

const byNorm = (ids: string[]) => new Set(ids.map(norm));

describe('computeExpectedDecisionIds — standardFirst branch (PHASE 6 gate #3 relaxation)', () => {
  describe('legacy lane (standardFirst absent / false) — byte-identical regression guard', () => {
    it('every floor dept is expected when standardFirst is absent', () => {
      const expected = computeExpectedDecisionIds(canonical);
      expect(byNorm(expected)).toEqual(byNorm(floorIds));
    });

    it('every floor dept is expected when standardFirst is false', () => {
      const expected = computeExpectedDecisionIds(canonical, { standardFirst: false });
      expect(byNorm(expected)).toEqual(byNorm(floorIds));
    });

    it('customs are added and implicit-YES customs are excluded (legacy)', () => {
      const expected = computeExpectedDecisionIds(canonical, {
        customDeptIds: ['custom-a', 'custom-b'],
        implicitYesCustomIds: ['custom-b'],
      });
      expect(byNorm(expected)).toEqual(byNorm([...floorIds, 'custom-a']));
    });
  });

  describe('standard-first lane — unrecorded floor dept is implicit KEEP', () => {
    it('an empty recordedDeclineIds excludes the ENTIRE floor', () => {
      const expected = computeExpectedDecisionIds(canonical, {
        standardFirst: true,
        recordedDeclineIds: [],
      });
      expect(expected).toEqual([]);
    });

    it('omitting recordedDeclineIds excludes the entire floor', () => {
      const expected = computeExpectedDecisionIds(canonical, { standardFirst: true });
      expect(expected).toEqual([]);
    });

    it('a floor dept with no recorded decision is NOT expected', () => {
      // Only 'sales' was declined; every other floor dept is an implicit KEEP.
      const expected = computeExpectedDecisionIds(canonical, {
        standardFirst: true,
        recordedDeclineIds: ['sales'],
      });
      expect(byNorm(expected)).toEqual(byNorm(['sales']));
      // The four unrecorded floor depts are absent.
      for (const id of ['marketing', 'billing-finance', 'executive', 'operations']) {
        expect(expected.map(norm)).not.toContain(norm(id));
      }
    });
  });

  describe('standard-first lane — RECORDED decline stays expected (gate #8 stays strict)', () => {
    it('a recorded decline keeps that floor dept in the expected set', () => {
      const expected = computeExpectedDecisionIds(canonical, {
        standardFirst: true,
        recordedDeclineIds: ['marketing', 'operations'],
      });
      expect(byNorm(expected)).toEqual(byNorm(['marketing', 'operations']));
    });

    it('norm-matching lands the recorded decline on the right floor dept (case/slug-insensitive)', () => {
      // 'Billing & Finance' normalized == 'billingfinance'; a recorded decline
      // under a differently-cased/symbolled id still pins the same dept.
      const expected = computeExpectedDecisionIds(canonical, {
        standardFirst: true,
        recordedDeclineIds: ['Billing_Finance'],
      });
      expect(expected.map(norm)).toContain(norm('billing-finance'));
      expect(expected).toHaveLength(1);
    });

    it('every recorded decline is preserved; non-declined floor depts stay implicit', () => {
      const declined = ['marketing', 'sales', 'executive'];
      const expected = computeExpectedDecisionIds(canonical, {
        standardFirst: true,
        recordedDeclineIds: declined,
      });
      expect(byNorm(expected)).toEqual(byNorm(declined));
      // The two unrecorded floor depts are NOT expected.
      for (const id of ['billing-finance', 'operations']) {
        expect(expected.map(norm)).not.toContain(norm(id));
      }
    });
  });

  describe('standard-first lane — customs behave identically to legacy', () => {
    it('custom depts are expected on top of the (relaxed) floor', () => {
      const expected = computeExpectedDecisionIds(canonical, {
        standardFirst: true,
        recordedDeclineIds: ['sales'],
        customDeptIds: ['custom-a', 'custom-b'],
      });
      expect(byNorm(expected)).toEqual(byNorm(['sales', 'custom-a', 'custom-b']));
    });

    it('implicit-YES customs are excluded in the standard-first lane too', () => {
      const expected = computeExpectedDecisionIds(canonical, {
        standardFirst: true,
        recordedDeclineIds: [],
        customDeptIds: ['custom-a', 'custom-b'],
        implicitYesCustomIds: ['custom-a'],
      });
      expect(byNorm(expected)).toEqual(byNorm(['custom-b']));
    });

    it('a custom dept id that collides (norm-wise) with a floor id is deduped, not doubled', () => {
      const expected = computeExpectedDecisionIds(canonical, {
        standardFirst: true,
        recordedDeclineIds: ['sales'],
        customDeptIds: ['Sales'], // same norm as the floor 'sales'
      });
      expect(expected.map(norm)).toEqual([norm('sales')]);
      expect(expected).toHaveLength(1);
    });
  });

  describe('standard-first lane — relaxation only touches the floor, never gates #2/#8', () => {
    // This is a logical pin (not a coverage-call assertion): the expected set
    // is the ONLY input computeDecisionCoverage consumes for gate #3, so a
    // correct expected set IS the gate #3 relaxation contract. Gates #2 (real
    // transcript) and #8 (no un-provenanced declines) are computed from the
    // raw decisions map, independent of the expected set — so shrinking the
    // expected set here cannot relax them. We assert the shape that keeps
    // that separation true: a recorded decline stays expected (so #8 still
    // gets to demand its provenance), and an unrecorded floor dept is dropped
    // (so #3 stops demanding a decision the prebuild already satisfied).
    it('a recorded decline stays expected so its provenance is still demanded', () => {
      const expected = computeExpectedDecisionIds(canonical, {
        standardFirst: true,
        recordedDeclineIds: ['marketing'],
      });
      expect(expected.map(norm)).toContain(norm('marketing'));
    });

    it('an unrecorded floor dept is dropped so gate #3 stops demanding it', () => {
      const expected = computeExpectedDecisionIds(canonical, {
        standardFirst: true,
        recordedDeclineIds: ['marketing'],
      });
      expect(expected.map(norm)).not.toContain(norm('sales'));
    });
  });
});