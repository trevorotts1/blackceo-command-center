import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyStateIdentity,
  type StateIdentityContext,
  type StateIdentityVerdict,
} from '../../src/lib/interview/state-identity';

/**
 * BU-35 (WF-051) — the link sender uses the same identity rule as the Command
 * Center, Command Center half.
 *
 * The three-way rule is driven by ONE fixture file,
 * tests/fixtures/state-identity-cases.json. The onboarding repository's
 * scripts/test_interview_completion_identity.py reads the SAME bytes (same
 * sha256, re-copied whenever either side changes), so the Python link sender
 * and this classifier cannot disagree about the same build-state.
 *
 * The fixture records the onboarding word under `class` and the Command
 * Center verdict under `commandCenterClass`; both must name the same case.
 */

interface FixtureCase {
  name: string;
  stamps: Record<string, string>;
  class: 'matched' | 'legacy' | 'mismatched';
  commandCenterClass: StateIdentityVerdict;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'state-identity-cases.json'), 'utf-8'),
) as { version: number; context: StateIdentityContext; cases: FixtureCase[] };

type BuildStateLike = Parameters<typeof classifyStateIdentity>[0];
const asState = (value: unknown): BuildStateLike => value as BuildStateLike;

/** The onboarding three-way word for each Command Center verdict. */
const WORD_TO_VERDICT: Record<FixtureCase['class'], StateIdentityVerdict> = {
  matched: 'scoped',
  legacy: 'unstamped',
  mismatched: 'mismatched',
};

test('[BU-35] the shared fixture covers the three identity cases', () => {
  assert.equal(fixture.version, 1);
  assert.equal(fixture.cases.length, 5);
  const classes = new Set(fixture.cases.map((entry) => entry.class));
  assert.deepEqual([...classes].sort(), ['legacy', 'matched', 'mismatched']);
});

test('[BU-35] classifyStateIdentity answers the class the onboarding rule answers', () => {
  for (const entry of fixture.cases) {
    assert.equal(
      classifyStateIdentity(asState(entry.stamps), fixture.context),
      entry.commandCenterClass,
      entry.name,
    );
    assert.equal(WORD_TO_VERDICT[entry.class], entry.commandCenterClass, entry.name);
  }
});

test('[BU-35] only a present-and-different stamp fails closed', () => {
  const context = fixture.context;
  assert.equal(classifyStateIdentity(asState({}), context), 'unstamped');
  assert.equal(classifyStateIdentity(asState(context), context), 'scoped');
  assert.equal(classifyStateIdentity(asState({ companyId: 'foreign' }), context), 'mismatched');
  assert.equal(
    classifyStateIdentity(
      asState({ companyId: context.companyId, installationId: context.installationId, tenantId: 'foreign' }),
      context,
    ),
    'mismatched',
  );
});
