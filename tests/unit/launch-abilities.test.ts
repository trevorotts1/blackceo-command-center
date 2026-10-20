/**
 * launch-abilities.test.ts — proves the launch ability registration and its
 * contract validators (WF-CC). Pure modules only: NO database, NO filesystem,
 * NO network.
 *
 *   node --import tsx --test tests/unit/launch-abilities.test.ts
 *
 * What must hold:
 *   - exactly the five launch skills are registered (49/50/44/38/83);
 *   - every ability declares a unique, non-empty stage order and covers the
 *     launch-plan sections it owns;
 *   - progress scoring reuses the command center's receipt rule (a
 *     `not_authorized` close is never a pass);
 *   - the run-event validator accepts the frozen contract shape and rejects
 *     unknown fields, unknown stages and events that name no ability;
 *   - the progress-sample validator enforces the launch progress contract,
 *     including its awaiting-owner-approval clause.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAUNCH_ABILITIES,
  PROGRESS_SAMPLE_KEYS,
  abilitiesForPlanSection,
  computeLaunchProgress,
  getLaunchAbility,
  getLaunchAbilityBySlug,
  isLaunchStage,
  launchAbilitySkillNumbers,
  validateProgressSample,
} from '../../src/lib/launch-abilities';
import { validateLaunchRunEvent } from '../../src/lib/launch-run-events';

const EID = '11111111-1111-4111-8111-111111111111';
const RID = '22222222-2222-4222-8222-222222222222';
const EMITTED = '2026-10-20T12:00:00.000Z';

function stageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skill: 49,
    launch_id: 'elevation-2026-11',
    event_id: EID,
    run_id: RID,
    event_type: 'stage_closed',
    schema_version: '1.0',
    emitted_at: EMITTED,
    stage: 'intake',
    receipt_status: 'pass',
    closed_at: EMITTED,
    ...overrides,
  };
}

function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1.0',
    project_id: 'elevation-2026-11',
    room_id: 'launch',
    scope_version: 1,
    observed_at: EMITTED,
    build_percent: 40,
    batch_merge_percent: 0,
    batch_status: 'awaiting_owner_approval',
    hourly_net_pp: null,
    rate_window_minutes: 60,
    swarm_score: null,
    swarm_coverage: 0,
    active_agents: 0,
    eligible_capacity: 0,
    verified_task_ids: [],
    blocked_task_ids: [],
    decision_ids: [],
    next_task_ids: [],
    evidence_refs: [],
    ...overrides,
  };
}

test('registers exactly the five launch skills', () => {
  assert.deepEqual(launchAbilitySkillNumbers(), [49, 50, 44, 38, 83]);
  assert.equal(new Set(LAUNCH_ABILITIES.map((a) => a.slug)).size, LAUNCH_ABILITIES.length);
});

test('every ability has a unique stage order and resolves by number and slug', () => {
  for (const ability of LAUNCH_ABILITIES) {
    assert.ok(ability.stageOrder.length > 0, `skill ${ability.skill} has no stages`);
    assert.equal(new Set(ability.stageOrder).size, ability.stageOrder.length);
    assert.equal(getLaunchAbility(ability.skill)?.skill, ability.skill);
    assert.equal(getLaunchAbility(String(ability.skill))?.skill, ability.skill);
    assert.equal(getLaunchAbilityBySlug(ability.slug)?.skill, ability.skill);
    assert.ok(isLaunchStage(ability, ability.stageOrder[0]));
  }
  assert.equal(getLaunchAbility(999), null);
  assert.equal(getLaunchAbility('nope'), null);
  assert.equal(getLaunchAbility(null), null);
});

test('launch-plan sections map back to the abilities that produce them', () => {
  assert.deepEqual(abilitiesForPlanSection('pages').map((a) => a.skill), [49]);
  assert.deepEqual(abilitiesForPlanSection('email_sequences').map((a) => a.skill), [50]);
  assert.deepEqual(abilitiesForPlanSection('text_sets').map((a) => a.skill), [50]);
  assert.deepEqual(abilitiesForPlanSection('automations').map((a) => a.skill), [44]);
  assert.deepEqual(abilitiesForPlanSection('conversation_ai').map((a) => a.skill), [38]);
  assert.deepEqual(abilitiesForPlanSection('launch_calendar').map((a) => a.skill), [83]);
});

test('progress: nothing run is 0 percent and points at the first stage', () => {
  const ability = getLaunchAbility(49)!;
  const progress = computeLaunchProgress(ability, 'elevation-2026-11', []);
  assert.equal(progress.build_percent, 0);
  assert.equal(progress.stages_closed, 0);
  assert.equal(progress.stages_total, ability.stageOrder.length);
  assert.equal(progress.next_stage, 'intake');
});

test('progress: a not_authorized close never counts as closed', () => {
  const ability = getLaunchAbility(49)!;
  const progress = computeLaunchProgress(ability, 'elevation-2026-11', [
    { stage: 'intake', status: 'closed', receipt_status: 'pass' },
    { stage: 'launch_plan', status: 'closed', receipt_status: 'not_authorized' },
    { stage: 'approval', status: 'blocked', receipt_status: null },
  ]);
  assert.equal(progress.stages_closed, 1);
  assert.equal(progress.build_percent, Math.round((1 / ability.stageOrder.length) * 100));
  assert.deepEqual(progress.blocked_stages, ['approval']);
  assert.equal(progress.next_stage, 'launch_plan');
});

test('run events: the frozen contract shape is accepted', () => {
  const result = validateLaunchRunEvent(stageEvent());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.ability.skill, 49);
    assert.equal(result.event.skill, 49);
    assert.equal(result.event.stage, 'intake');
  }
});

test('run events: unknown fields, unknown stages and missing skill are rejected', () => {
  const unknownField = validateLaunchRunEvent(stageEvent({ prompt_text: 'secret copy' }));
  assert.equal(unknownField.ok, false);
  if (!unknownField.ok) assert.ok(unknownField.errors.some((e) => e.includes('unknown field: prompt_text')));

  const wrongStage49 = validateLaunchRunEvent(stageEvent({ skill: 83, stage: 'route_graph' }));
  assert.equal(wrongStage49.ok, false);
  if (!wrongStage49.ok) assert.ok(wrongStage49.errors.some((e) => e.includes('declared stage order')));

  const noSkill = validateLaunchRunEvent(stageEvent({ skill: undefined }));
  assert.equal(noSkill.ok, false);
  if (!noSkill.ok) assert.ok(noSkill.errors.some((e) => e.includes('registered launch abilities')));

  const missingReceipt = validateLaunchRunEvent(stageEvent({ receipt_status: undefined }));
  assert.equal(missingReceipt.ok, false);
  if (!missingReceipt.ok) assert.ok(missingReceipt.errors.some((e) => e.includes('stage_closed requires receipt_status')));
});

test('progress samples: the contract shape is accepted', () => {
  const result = validateProgressSample(sample());
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.sample.project_id, 'elevation-2026-11');
  assert.equal(PROGRESS_SAMPLE_KEYS.length, 19);
});

test('progress samples: contract violations are rejected', () => {
  const unknown = validateProgressSample(sample({ build_percent_actual: 90 }));
  assert.equal(unknown.ok, false);

  const missing = validateProgressSample(sample({ room_id: undefined }));
  assert.equal(missing.ok, false);

  const awaitingWithMerge = validateProgressSample(sample({ batch_merge_percent: 33 }));
  assert.equal(awaitingWithMerge.ok, false);
  if (!awaitingWithMerge.ok) {
    assert.ok(awaitingWithMerge.errors.some((e) => e.includes('awaiting_owner_approval')));
  }

  const badStatus = validateProgressSample(sample({ batch_status: 'shipped' }));
  assert.equal(badStatus.ok, false);
});
