/**
 * CTR-165 — installation capability snapshot and readiness parity
 * (unexecuted here; Trevor owns the test run).
 *
 * Narrow regression for the non-trivial patterns in this lane:
 *   1. strict snapshot schema: unknown fields, duplicates, and another
 *      installation are refused;
 *   2. exact matching only: a whole-phrase name matches, shared vocabulary
 *      does not, and a department reference never matches a same-named skill;
 *   3. an absent snapshot is an explicit `not_provided` state and a present
 *      snapshot with no exact match is an explicit `unmatched` state;
 *   4. canonical readiness: a failed hard constraint on the recommended
 *      option and a blocking ratification state both block a GO.
 *
 * Run: node --import tsx --test tests/unit/ctr165-capability-snapshot.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSnapshotInstallation,
  buildCapabilityReportSection,
  CAPABILITY_SNAPSHOT_SCHEMA,
  CapabilitySnapshotError,
  matchCapabilitiesToPlan,
  validateCapabilitySnapshot,
} from '../../src/lib/council/capability-snapshot';
import {
  readScoredVerdict,
  summarizeConditions,
} from '../../src/lib/council/report-reading';

function snapshot(items: unknown[]) {
  return {
    schema_version: CAPABILITY_SNAPSHOT_SCHEMA,
    installation_id: 'install-a',
    captured_at: '2026-10-30',
    basis: 'at_export',
    items,
    limitations: ['Read from this installation only.'],
  };
}

const skill = {
  capability_id: 'skill:video-editor',
  kind: 'skill',
  name: 'Video Editor',
  description: 'Cuts and assembles video.',
  availability: 'available_now',
  source: 'openclaw.skills',
  recorded_reference_ids: [],
};

const department = {
  capability_id: 'department:dept-marketing',
  kind: 'department',
  name: 'Marketing',
  description: null,
  availability: 'available_now',
  source: 'openclaw.departments',
  recorded_reference_ids: [],
};

test('strict snapshot refuses unknown fields, duplicates, and another installation', () => {
  const parsed = validateCapabilitySnapshot(snapshot([skill, department]));
  assert.equal(parsed.items.length, 2);

  assert.throws(
    () =>
      validateCapabilitySnapshot(
        snapshot([{ ...skill, path: '/Users/client/.openclaw/skills/x' }]),
      ),
    (error: unknown) =>
      error instanceof CapabilitySnapshotError &&
      /unrecognized|unknown/i.test(error.message),
  );
  assert.throws(
    () => validateCapabilitySnapshot(snapshot([skill, skill])),
    (error: unknown) =>
      error instanceof CapabilitySnapshotError &&
      /duplicate/i.test(error.message),
  );
  assert.throws(
    () => assertSnapshotInstallation(parsed, 'install-b'),
    (error: unknown) =>
      error instanceof CapabilitySnapshotError &&
      /different installation/i.test(error.message),
  );
});

test('matching is exact: whole phrase only, no shared-word match', () => {
  const parsed = validateCapabilitySnapshot(snapshot([skill, department]));
  const exact = matchCapabilitiesToPlan(parsed, [
    {
      action_id: 'a1',
      title: 'Use the Video Editor on the launch cut',
      description: 'Assemble the final cut.',
    },
  ]);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].capability_id, 'skill:video-editor');
  assert.equal(exact[0].match_basis, 'named_in_step');

  const sharedWordsOnly = matchCapabilitiesToPlan(parsed, [
    {
      action_id: 'a2',
      title: 'Back up the source files before every render',
      description: 'Confirm the backup is complete.',
    },
  ]);
  assert.equal(sharedWordsOnly.length, 0);
});

test('a department reference never matches a same-named skill', () => {
  const sameNameSkill = {
    ...skill,
    capability_id: 'skill:dept-marketing',
    name: 'Dept Marketing',
  };
  const parsed = validateCapabilitySnapshot(
    snapshot([sameNameSkill, department]),
  );
  const matches = matchCapabilitiesToPlan(parsed, [
    {
      action_id: 'a1',
      title: 'Run the launch',
      description: 'Coordinate the launch.',
      department_id: 'dept-marketing',
    },
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, 'department');
  assert.equal(matches[0].capability_id, 'department:dept-marketing');
});

test('absent and unmatched inventory are explicit, never an assumed empty list', () => {
  const absent = buildCapabilityReportSection(null, [
    { action_id: 'a1', title: 'Build the page', description: 'Ship it.' },
  ]);
  assert.equal(absent.status, 'not_provided');
  assert.equal(absent.snapshot, null);
  assert.match(absent.note, /does not read another box/i);

  const parsed = validateCapabilitySnapshot(snapshot([skill]));
  const unmatched = buildCapabilityReportSection(parsed, [
    { action_id: 'a1', title: 'Build the page', description: 'Ship it.' },
  ]);
  assert.equal(unmatched.status, 'unmatched');
  assert.match(unmatched.no_match_note ?? '', /absence of an exact match/i);
  assert.equal(unmatched.matches.length, 0);
});

test('canonical readiness blocks on a recommended hard constraint and ratification', () => {
  const conditions = summarizeConditions({});
  const hard = readScoredVerdict({
    label: 'GO',
    recommended_option_label: 'Run the test',
    conditions,
    recommended_option_id: 'a',
    hard_findings: [
      {
        constraint_id: 'c1',
        option_id: 'a',
        result: 'fail',
        checker: 'finance',
      },
    ],
    ratification_status: 'ratified',
  });
  assert.equal(hard.readiness_status, 'blocked');
  assert.match(hard.blocked_reasons.join(' '), /hard constraint/i);

  const ratification = readScoredVerdict({
    label: 'GO_WITH_CONDITIONS',
    recommended_option_label: 'Run the test',
    conditions,
    recommended_option_id: 'a',
    hard_findings: [],
    ratification_status: 'pending',
  });
  assert.equal(ratification.readiness_status, 'blocked');
  assert.match(ratification.blocked_reasons.join(' '), /Ratification status pending/);

  const eligible = readScoredVerdict({
    label: 'GO',
    recommended_option_label: 'Run the test',
    conditions,
    recommended_option_id: 'a',
    hard_findings: [
      {
        constraint_id: 'c2',
        option_id: 'b',
        result: 'fail',
        checker: 'finance',
      },
    ],
    ratification_status: 'ratified',
  });
  assert.equal(eligible.readiness_status, 'ready_to_act');
});
