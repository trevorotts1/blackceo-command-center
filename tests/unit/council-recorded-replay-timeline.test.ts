import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CouncilWireEvent } from '../../src/lib/council/events/types';
import {
  advanceReplayClock,
  buildRecordedCouncilReplay,
  CouncilReplayError,
  replayAtElapsedMs,
} from '../../src/components/council/council-replay-timeline';
import {
  FIXTURE_EVENT_CREATED,
  FIXTURE_EVENT_CARD_SINEK,
  FIXTURE_EVENT_CARD_ALICHE,
  FIXTURE_SESSION_ID,
} from '../../src/components/council/council-session-fixtures';

const events = [
  FIXTURE_EVENT_CREATED,
  FIXTURE_EVENT_CARD_SINEK,
  FIXTURE_EVENT_CARD_ALICHE,
] as const;

describe('WER-020 recorded replay timeline contract', () => {
  it('reconstructs original saved seats without provider or task calls', () => {
    const timeline = buildRecordedCouncilReplay(FIXTURE_SESSION_ID, events);
    assert.equal(timeline.frames.length, 3);
    assert.equal(timeline.durationMs, 120000);
    const first = replayAtElapsedMs(timeline, 0);
    assert.equal(first.appliedEvents, 1);
    assert.equal(first.projection?.activity.completed_cards, 0);
    const second = replayAtElapsedMs(timeline, 60000);
    assert.equal(second.appliedEvents, 2);
    assert.equal(second.projection?.activity.completed_cards, 1);
    const final = replayAtElapsedMs(timeline, 120000);
    assert.equal(final.appliedEvents, 3);
    assert.equal(final.projection?.activity.completed_cards, 2);
    assert.equal(final.finished, true);
    assert.equal(replayAtElapsedMs(timeline, 0).projection?.activity.completed_cards, 0);
  });

  it('supports pause, seek backwards, 0.5x/1x/2x/4x and recorded natural finish', () => {
    const timeline = buildRecordedCouncilReplay(FIXTURE_SESSION_ID, events);
    assert.equal(advanceReplayClock(timeline, 0, 30000, 0.5).elapsedMs, 15000);
    assert.equal(advanceReplayClock(timeline, 0, 30000, 1).elapsedMs, 30000);
    assert.equal(advanceReplayClock(timeline, 0, 30000, 2).appliedEvents, 2);
    assert.equal(advanceReplayClock(timeline, 0, 30000, 4).finished, true);
    assert.equal(replayAtElapsedMs(timeline, -100).elapsedMs, 0);
    assert.equal(replayAtElapsedMs(timeline, 999999).elapsedMs, timeline.durationMs);
  });

  it('rejects missing, duplicate, foreign or non-journal events and false wall-clock timing', () => {
    assert.throws(() => buildRecordedCouncilReplay(FIXTURE_SESSION_ID, []), CouncilReplayError);
    const replace = (i: number, values: Partial<CouncilWireEvent>) =>
      events.map((v, index) => index === i ? { ...v, ...values } : v);
    for (const bad of [
      replace(1, { sequence: 5 }),
      replace(1, { event_id: events[0].event_id }),
      replace(1, { session_id: 'other-client-session' }),
      replace(1, { origin: 'external' as CouncilWireEvent['origin'] }),
      replace(1, { occurred_at: '2026-10-14T10:02:00' }),
      replace(1, { occurred_at: '2026-10-14T11:00:00.000Z' }),
      replace(1, {
        scope: { ...events[1].scope, company_id: 'company-other-tenant' },
      }),
    ]) {
      assert.throws(() => buildRecordedCouncilReplay(FIXTURE_SESSION_ID, bad), CouncilReplayError);
    }
  });

  it('rejects non-finite seek or fake negative timer durations', () => {
    const timeline = buildRecordedCouncilReplay(FIXTURE_SESSION_ID, events);
    assert.throws(() => replayAtElapsedMs(timeline, NaN), CouncilReplayError);
    assert.throws(() => advanceReplayClock(timeline, 0, -1, 1), CouncilReplayError);
    assert.throws(() => advanceReplayClock(timeline, 0, Infinity, 1), CouncilReplayError);
    assert.throws(() => advanceReplayClock(timeline, 0, 1000, 99 as never), CouncilReplayError);
  });
});
