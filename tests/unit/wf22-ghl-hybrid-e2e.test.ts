/**
 * WF22 (GHL-022) Command Center side of the cross-lane integration pack.
 *
 * Consumes the shared fake scenario fixtures and drives the REAL, dependency-
 * free board modules (`taskToColumnId`, `isCreateTerminalStatus`,
 * `createSubmitStatus`, `normalizeBoardSource`, `isEngineOwnedBoardSource`,
 * `engineOwnedWaitingLabel`). No DB, no network, no owner notification.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  taskToColumnId,
  isCreateTerminalStatus,
  createSubmitStatus,
  STALE_COLUMN_ID,
} from '../../src/lib/board-projection';
import {
  RECOGNIZED_BOARD_SOURCES,
  normalizeBoardSource,
  isEngineOwnedBoardSource,
  engineOwnedWaitingLabel,
} from '../../src/lib/board-sources';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'ghl-hybrid');

function loadFixture(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, relativePath), 'utf8'));
}

const launch = loadFixture(path.join('scenarios', 'launch-fulfillment-board.json'));
const projection = loadFixture(path.join('scenarios', 'cc-projects-projection.json'));
const course = loadFixture(path.join('scenarios', 'course-group-post-access.json'));

const OUTCOME_VALUES = new Set([
  'planned', 'submitted', 'processing', 'verified', 'failed', 'blocked',
  'unknown_outcome', 'not_requested',
]);

test('A23: a card mirrors verified evidence, not create success', () => {
  assert.equal(launch.board.create_success_is_done, false);
  assert.equal(launch.board.card_state, 'in_progress');
  assert.ok(launch.board.receipt_id, 'a board card must cite a receipt');

  // A successful create cannot claim a terminal column at creation time.
  assert.equal(isCreateTerminalStatus('done'), true);
  assert.equal(isCreateTerminalStatus('review'), true);
  assert.equal(createSubmitStatus('done'), 'in_progress');
  assert.equal(createSubmitStatus('review'), 'assigned');

  // In-progress work stays in its real column.
  assert.equal(taskToColumnId({ status: 'in_progress' }), 'in_progress');
});

test('T-35: stale/unknown evidence is visible, never left looking healthy', () => {
  assert.equal(
    taskToColumnId({ status: 'in_progress', lifecycle: { state: 'unknown', column: null } }),
    STALE_COLUMN_ID,
  );
  assert.equal(
    taskToColumnId({ status: 'done', lifecycle: { state: 'stale', column: 'done' } }),
    STALE_COLUMN_ID,
  );
  // No lifecycle evidence falls back to the status map.
  assert.equal(taskToColumnId({ status: 'done', lifecycle: null }), 'done');
  assert.equal(launch.board.stale_and_unknown_visible, true);
});

test('A24/B22: old and new producer sources are both accepted, unknown is refused', () => {
  assert.equal(normalizeBoardSource('funnel'), 'funnel');
  assert.equal(normalizeBoardSource(' Funnel '), 'funnel');
  assert.equal(normalizeBoardSource('build_deck_phase'), 'build_deck_phase');
  assert.equal(normalizeBoardSource('presentation-interview-app'), 'presentation-interview-app');
  assert.equal(normalizeBoardSource('legacy_skill6'), null);
  assert.equal(normalizeBoardSource(undefined), null);
  assert.equal(launch.binding_formats.old.accepted, true);
  assert.equal(launch.binding_formats.new.accepted, true);
  assert.ok(RECOGNIZED_BOARD_SOURCES.has('funnel'));
});

test('engine-owned cards are never advertised as board-dispatched work', () => {
  assert.equal(isEngineOwnedBoardSource('build_deck_phase'), true);
  assert.equal(isEngineOwnedBoardSource('funnel'), false);
  assert.match(
    String(engineOwnedWaitingLabel('build_deck_phase', 'assigned')),
    /board does not dispatch/,
  );
  assert.equal(engineOwnedWaitingLabel('build_deck_phase', 'done'), null);
});

test('A22/B20: CC -> Projects projection is one-way with no echo loop', () => {
  assert.equal(projection.projection.direction, 'one_way');
  assert.equal(projection.projection.target, 'ghl_projects');
  assert.deepEqual(projection.projection.target_to_cc_events, []);
  assert.equal(projection.projection.echo_loop, false);
  assert.equal(projection.projection.replay_creates_duplicate, false);
  assert.equal(projection.projection.promotes_unverified_build_to_done, false);
  assert.equal(projection.cc_task.completion_authority, 'cc');

  const eventIds = projection.projection.events.map((event: any) => event.event_id);
  assert.equal(new Set(eventIds).size, eventIds.length);
  assert.equal(projection.expected.echo_events, 0);
  assert.equal(projection.expected.duplicates_on_replay, 0);
});

test('A24: board outage emits an outbox event and never repeats the GHL write', () => {
  assert.equal(launch.outage.board_available, false);
  assert.equal(launch.outage.outbox_event, 'board.outbox.card_pending');
  assert.equal(launch.outage.ghl_mutation_repeated, false);
  assert.equal(launch.outage.execution_continued, true);
});

test('receipt fixtures obey the shared contract invariants', () => {
  const scenarios = fs.readdirSync(path.join(FIXTURES, 'scenarios'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => loadFixture(path.join('scenarios', name)));
  assert.ok(scenarios.length >= 6);

  const seen = new Set<string>();
  for (const scenario of scenarios) {
    for (const receipt of scenario.operation_receipts ?? []) {
      assert.equal(receipt.schema_version, '1.0.0');
      assert.ok(OUTCOME_VALUES.has(receipt.outcome), receipt.outcome);
      assert.ok(!seen.has(receipt.receipt_id), `duplicate receipt_id ${receipt.receipt_id}`);
      seen.add(receipt.receipt_id);
      if (receipt.outcome === 'verified') {
        assert.equal(receipt.readback.state, 'matched');
      }
      if (receipt.outcome === 'unknown_outcome') {
        assert.notEqual(receipt.readback.state, 'matched');
      }
      assert.equal(receipt.company_id, scenario.tenant.company_id);
      assert.equal(receipt.location_id, scenario.tenant.location_id);
      assert.equal(receipt.run_id, scenario.tenant.run_id);
    }
  }
  assert.ok(seen.size > 0);
});

test('course fixture names a bound asset, not merely a listed plan', () => {
  const lesson = course.modules[0].lessons[0];
  assert.equal(lesson.content_bound, true);
  assert.ok(lesson.media_asset_ids.length > 0);
  const asset = course.asset_manifest.assets.find(
    (candidate: any) => candidate.asset_id === lesson.media_asset_ids[0],
  );
  assert.ok(asset, 'lesson media must exist in the asset manifest');
  assert.equal(asset.bound_to_lesson_id, lesson.course_lesson_id);
});
