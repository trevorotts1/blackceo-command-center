import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CouncilSessionProjection } from '../../src/lib/council/events/types';
import {
  projectionToRoomView,
  type HydratedCouncilRoomCard,
} from '../../src/components/council/council-session-types';
import { SAMPLE_ROOM_VIEW } from '../../src/components/council/council-room-fixtures';
import { FIXTURE_SCOPE } from '../../src/components/council/council-session-fixtures';

const seatId = 'tiffany-aliche' as const;
const committedHash = 'a'.repeat(64);
const savedCard = SAMPLE_ROOM_VIEW.seats.find((seat) => seat.seatId === seatId)?.card;
if (!savedCard) throw new Error('test fixture must include a committed advisor card');

function projection(state = 'ROUND_3', status: 'completed' | 'queued' = 'completed'): CouncilSessionProjection {
  return {
    session_id: FIXTURE_SCOPE.session_id,
    scope: FIXTURE_SCOPE,
    mode: 'full',
    sample: false,
    state,
    state_version: 5,
    brief_revision: 1,
    seats: [{
      seat_id: seatId,
      status,
      last_card: status === 'completed'
        ? { round: 1, card_hash: committedHash, sequence: 4 }
        : null,
    }],
    activity: {
      completed_cards: status === 'completed' ? 1 : 0,
      total_seats: 9,
      last_event_sequence: 4,
      last_event_type: null,
      last_event_at: null,
    },
    verdict: null,
    updated_at: null,
  };
}

function hydrated(overrides: Partial<HydratedCouncilRoomCard> = {}): HydratedCouncilRoomCard {
  return {
    sessionId: FIXTURE_SCOPE.session_id,
    seatId,
    round: 1,
    cardHash: committedHash,
    card: savedCard!,
    ...overrides,
  };
}

describe('WER-015 committed card hydration boundary', () => {
  it('shows a current persisted card only when it matches the same session, seat, round and hash', () => {
    const room = projectionToRoomView(projection(), {
      decisionTitle: 'Evaluate a real option',
      hydratedCards: { [seatId]: hydrated() },
      committedCrux: 'Cash reserve versus demand',
    });
    assert.deepEqual(room.seats[0].card, savedCard);
    assert.equal(room.cruxLabel, 'Cash reserve versus demand');
    assert.equal(room.currentRound, 3, 'active ROUND_3 beats the old round 1 accepted card');
  });

  it('rejects a card from another session or stale round/hash', () => {
    for (const mismatch of [
      { sessionId: 'session-from-another-client' },
      { round: 2 },
      { cardHash: 'b'.repeat(64) },
      { seatId: 'oprah-winfrey' as const },
    ]) {
      const room = projectionToRoomView(projection(), {
        decisionTitle: 'Evaluate an option',
        hydratedCards: { [seatId]: hydrated(mismatch) },
      });
      assert.equal(room.seats[0].card, null);
    }
  });

  it('never displays a hydrated card for a seat whose journal says queued', () => {
    const room = projectionToRoomView(projection('QUEUED', 'queued'), {
      decisionTitle: 'Evaluate an option',
      hydratedCards: { [seatId]: hydrated() },
    });
    assert.equal(room.seats[0].card, null);
    assert.equal(room.currentRound, null);
  });

  it('uses last committed round when the session is paused, but otherwise prioritizes its active phase', () => {
    const paused = projectionToRoomView(projection('PAUSED'), { decisionTitle: 'D' });
    assert.equal(paused.currentRound, 1);
    const active = projectionToRoomView(projection('ROUND_2'), { decisionTitle: 'D' });
    assert.equal(active.currentRound, 2);
  });
});
