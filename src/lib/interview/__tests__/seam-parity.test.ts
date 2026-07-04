/**
 * seam-parity.test.ts — Wave 5 / P3-7.
 *
 * Proves the TypeScript interview seam (src/lib/interview/seam.ts) computes
 * BYTE-IDENTICAL results to the onboarding Python enforcers on a SHARED fixture,
 * closing the risk-mitigation gap called out in the Wave 5 plan: "If [the seam]
 * reimplements canonical_decline.py's provenance + norm() rules in TS and the
 * Python later changes, the UI gate and the build gate diverge."
 *
 * The four mirrored surfaces:
 *   norm()                     <-> canonical_decline.norm  /  department-floor._norm
 *   computeExpectedDecisionIds <-> build-workforce._expected_decision_ids
 *   computeDecisionCoverage    <-> canonical_decline.decision_coverage
 *                                  + canonical_decline.canonical_decline_set / decline_rejections
 *   noUnprovenancedDeclines    <-> (canonical_decline.decline_rejections == [])
 *
 * The pinned golden values in ../__fixtures__/parity/golden.json are derived by
 * running that REAL Python on ../__fixtures__/parity/input.json. Regenerate with
 * `scripts/regen-seam-parity-golden.sh <onboarding-repo>` (sandboxed HOME) when the
 * Python changes; a diff here then flags the intended UI-gate update.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  norm,
  computeExpectedDecisionIds,
  computeDecisionCoverage,
  noUnprovenancedDeclines,
  type BuildState,
  type CanonicalDepartments,
} from '@/lib/interview/seam';

const fixtureDir = path.join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '__fixtures__',
  'parity',
);

interface NormGolden {
  in: string;
  out: string;
}
interface ExpectedSetGolden {
  name: string;
  tsCustomDeptIds: string[];
  tsImplicitYesCustomIds: string[];
  ids: string[];
}
interface DeclineGolden {
  name: string;
  expectedIds: string[];
  missing: string[];
  covered: string[];
  declinedNorm: string[];
  rejections: string[];
  noUnprovenancedDeclines: boolean;
}
interface Golden {
  meta: Record<string, unknown>;
  canonical: CanonicalDepartments;
  norm: NormGolden[];
  expectedSet: ExpectedSetGolden[];
  decline: DeclineGolden[];
}
interface DeclineInputCase {
  name: string;
  expectedIds: string[];
  buildState: BuildState;
}
interface FixtureInput {
  declineCases: DeclineInputCase[];
}

function load<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf-8')) as T;
}

const golden = load<Golden>('golden.json');
const input = load<FixtureInput>('input.json');

const sorted = (xs: string[]): string[] => [...xs].sort();

describe('seam <-> Python parity (P3-7)', () => {
  it('golden was generated against a canonical floor (sanity)', () => {
    expect(golden.norm.length).toBeGreaterThan(0);
    expect(golden.expectedSet.length).toBeGreaterThan(0);
    expect(golden.decline.length).toBeGreaterThan(0);
    expect(golden.canonical.mandatory.length).toBeGreaterThan(0);
  });

  describe('norm() == canonical_decline.norm / department-floor._norm', () => {
    for (const { in: input_, out } of golden.norm) {
      it(`norm(${JSON.stringify(input_)}) === ${JSON.stringify(out)}`, () => {
        expect(norm(input_)).toBe(out);
      });
    }
  });

  describe('computeExpectedDecisionIds() == build-workforce._expected_decision_ids', () => {
    for (const c of golden.expectedSet) {
      it(`expected-set "${c.name}" is byte-identical (order + membership)`, () => {
        const actual = computeExpectedDecisionIds(golden.canonical, {
          customDeptIds: c.tsCustomDeptIds,
          implicitYesCustomIds: c.tsImplicitYesCustomIds,
        });
        expect(actual).toEqual(c.ids);
      });
    }
  });

  describe('computeDecisionCoverage() / declines == canonical_decline.py', () => {
    const byName = new Map(input.declineCases.map((c) => [c.name, c]));
    for (const g of golden.decline) {
      it(`decline case "${g.name}" matches Python coverage + provenance`, () => {
        const src = byName.get(g.name);
        expect(src, `input.json missing declineCase "${g.name}"`).toBeTruthy();
        const bs = src!.buildState;
        const cov = computeDecisionCoverage(bs, g.expectedIds);

        // decision_coverage(build_state, expected_ids) -> (missing, covered), sorted.
        expect(sorted(cov.missing)).toEqual(g.missing);
        expect(sorted(cov.covered)).toEqual(g.covered);

        // canonical_decline_set -> normalized honored declines.
        expect(sorted(cov.declined.map(norm))).toEqual(g.declinedNorm);

        // decline_rejections -> un-provenanced declines the enforcer drops (gate #8).
        expect(sorted(cov.rejections)).toEqual(g.rejections);

        // noUnprovenancedDeclines <-> (rejections == []).
        expect(noUnprovenancedDeclines(bs)).toBe(g.noUnprovenancedDeclines);
        // internal consistency: the flag agrees with the rejection list.
        expect(noUnprovenancedDeclines(bs)).toBe(cov.rejections.length === 0);
      });
    }
  });
});
