/**
 * CWE-032 - council room logic, node:test (runs under npm run test:unit).
 *
 * Covers the pure contracts the room components are built on:
 * - Stable slot order: rendering order is the roster order no matter what
 *   arrival order committed events delivered the seats in (Section 22.4).
 * - The roster mirrors the CWE-003 canonical SEAT_IDS exactly, and the
 *   CWE-031 locked slot geometry covers exactly those nine IDs in the
 *   same order (drift between the three sources fails here).
 * - Honest state labels (Sections 14.1, 18.4): a queued seat is waiting,
 *   never "thinking"; stance labels appear only with a committed card.
 * - Accessible names carry advisor, responsibility, and current state
 *   (Section 23.1).
 * - The 44px touch-target token is declared once in the CWE-031 token
 *   layer and consumed by seat, button, and reading-row rules; seat names
 *   take the 16px --council-text-name floor (Sections 22.3, 23).
 * - Fixtures are labeled synthetic with provenance (Section 17.5).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  COUNCIL_SEAT_IDS,
  COUNCIL_SEAT_ROSTER,
  orderSeatsByRoster,
  seatSlot,
  seatStatusLabel,
  seatAccessibleName,
  roomModeBadge,
  type CouncilSeatView,
} from '../../src/components/council/council-room-types';
import { COUNCIL_SEAT_SLOTS } from '../../src/components/council/council-theme';
import {
  SAMPLE_ROOM_VIEW,
  QUEUED_ROOM_VIEW,
  FIXTURE_PROVENANCE,
} from '../../src/components/council/council-room-fixtures';

const CANONICAL_SEAT_IDS = [
  'simon-sinek',
  'td-jakes',
  'oprah-winfrey',
  'tiffany-aliche',
  'russell-brunson',
  'michelle-obama',
  'brene-brown',
  'dennis-kimbro',
  'les-brown',
];

describe('council roster mirrors the canonical contracts', () => {
  it('seat IDs equal the CWE-003 SEAT_IDS in roster order', () => {
    assert.deepEqual([...COUNCIL_SEAT_IDS], CANONICAL_SEAT_IDS);
    assert.deepEqual(
      COUNCIL_SEAT_ROSTER.map((s) => s.seatId),
      CANONICAL_SEAT_IDS,
    );
  });

  it('locked CWE-031 slot geometry covers exactly the roster, in order', () => {
    assert.deepEqual(
      COUNCIL_SEAT_SLOTS.map((s) => s.seatId),
      CANONICAL_SEAT_IDS,
    );
    for (const id of CANONICAL_SEAT_IDS) {
      const slot = seatSlot(id as CouncilSeatView['seatId']);
      assert.ok(slot.xPct >= 0 && slot.xPct <= 100, `${id} xPct in frame`);
      assert.ok(slot.yPct >= 0 && slot.yPct <= 100, `${id} yPct in frame`);
    }
  });

  it('roster names are full names, never initials-only identity', () => {
    const names = COUNCIL_SEAT_ROSTER.map((s) => s.displayName);
    assert.deepEqual(names, [
      'Simon Sinek',
      'T. D. Jakes',
      'Oprah Winfrey',
      'Tiffany Aliche',
      'Russell Brunson',
      'Michelle Obama',
      'Brené Brown',
      'Dr. Dennis Kimbro',
      'Les Brown',
    ]);
    for (const seat of COUNCIL_SEAT_ROSTER) {
      assert.ok(seat.displayName.length > 3, `${seat.seatId} has a full name`);
      assert.ok(seat.profileLabel.includes(seat.displayName));
      assert.ok(seat.profileLabel.includes('Not the individual and not an endorsement.'));
      assert.ok(seat.medallion.altText.includes('not a photograph'));
    }
  });
});

describe('stable slot order under out-of-order arrival', () => {
  it('fixture seats arrive scrambled but order back to the roster', () => {
    const arrival = SAMPLE_ROOM_VIEW.seats.map((s) => s.seatId);
    assert.notDeepEqual(arrival, CANONICAL_SEAT_IDS, 'fixture must arrive scrambled');
    const ordered = orderSeatsByRoster(SAMPLE_ROOM_VIEW.seats).map((s) => s.seatId);
    assert.deepEqual(ordered, CANONICAL_SEAT_IDS);
  });

  it('reversed arrival still renders roster order', () => {
    const reversed = [...SAMPLE_ROOM_VIEW.seats].reverse();
    assert.deepEqual(
      orderSeatsByRoster(reversed).map((s) => s.seatId),
      CANONICAL_SEAT_IDS,
    );
  });

  it('ordering does not mutate the input array', () => {
    const input = [...SAMPLE_ROOM_VIEW.seats];
    const before = input.map((s) => s.seatId);
    orderSeatsByRoster(input);
    assert.deepEqual(
      input.map((s) => s.seatId),
      before,
    );
  });
});

describe('honest state labels (Sections 14.1, 18.4)', () => {
  const seat = (partial: Partial<CouncilSeatView>): CouncilSeatView => ({
    seatId: 'simon-sinek',
    status: 'queued',
    card: null,
    ...partial,
  });

  it('a queued seat is waiting, never thinking', () => {
    const label = seatStatusLabel(seat({ status: 'queued' }));
    assert.equal(label, 'Waiting in queue');
    assert.ok(!/think/i.test(label));
  });

  it('no seat label ever claims thinking', () => {
    for (const s of [...SAMPLE_ROOM_VIEW.seats, ...QUEUED_ROOM_VIEW.seats]) {
      assert.ok(!/think/i.test(seatStatusLabel(s)), `${s.seatId} label must not say thinking`);
    }
  });

  it('started means a real operation began, stated plainly', () => {
    assert.equal(seatStatusLabel(seat({ status: 'started' })), 'In progress');
  });

  it('failed is explicit', () => {
    assert.equal(seatStatusLabel(seat({ status: 'failed' })), 'Did not complete');
  });

  it('stance labels come only from a committed card', () => {
    assert.equal(seatStatusLabel(seat({ status: 'completed', card: null })), 'Completed');
    const withCard = seat({
      status: 'completed',
      card: {
        stance: 'oppose',
        preferredOptionLabel: null,
        decisiveArguments: ['x'],
        strongestObjection: 'y',
        conditions: [],
        criticalUnknowns: [],
        changeMyMind: 'z',
        evidenceStrength: 'low',
        minorityPosition: null,
      },
    });
    assert.equal(seatStatusLabel(withCard), 'Opposes');
  });

  it('mode badges are persistent and honest', () => {
    assert.equal(roomModeBadge('live'), 'Live');
    assert.equal(roomModeBadge('replay'), 'Recorded replay');
    assert.equal(roomModeBadge('sample'), 'Fictional sample');
  });
});

describe('accessible names (Section 23.1)', () => {
  it('include advisor, responsibility, and current state', () => {
    const queued = QUEUED_ROOM_VIEW.seats.find((s) => s.seatId === 'tiffany-aliche')!;
    const name = seatAccessibleName(queued);
    assert.ok(name.includes('Tiffany Aliche'));
    assert.ok(name.includes('financial stability and sustainable commitments'));
    assert.ok(name.includes('Waiting in queue'));
  });

  it('preserve the accented spelling for Brené Brown', () => {
    const seat = QUEUED_ROOM_VIEW.seats.find((s) => s.seatId === 'brene-brown')!;
    assert.ok(seatAccessibleName(seat).startsWith('Brené Brown,'));
  });
});

describe('design token consumption (Sections 22.3, 23)', () => {
  const css = readFileSync(
    path.resolve(__dirname, '../../src/components/council/council-theme.css'),
    'utf8',
  );
  const roomCss = readFileSync(
    path.resolve(__dirname, '../../src/components/council/council-room.css'),
    'utf8',
  );

  it('the 44px touch target token is declared once in the token layer', () => {
    const declarations = css.match(/--council-touch-target:\s*44px/g) ?? [];
    assert.equal(declarations.length, 1);
  });

  it('seats, buttons, and reading rows consume the touch-target token', () => {
    assert.ok(css.includes('.council-btn') && css.includes('min-height: var(--council-touch-target)'));
    const seatRule = css.slice(css.indexOf('.council-seat {'), css.indexOf('.council-seat-name'));
    assert.ok(seatRule.includes('min-height: var(--council-touch-target)'));
    const rowRule = css.slice(css.indexOf('.council-reading-row {'));
    assert.ok(rowRule.includes('min-height: var(--council-touch-target)'));
  });

  it('seat names take the 16px name token, never a smaller size', () => {
    assert.ok(css.includes('--council-text-name: 1rem;'));
    const nameRule = css.slice(
      css.indexOf('.council-seat-name'),
      css.indexOf('.council-seat-role'),
    );
    assert.ok(nameRule.includes('font-size: var(--council-text-name)'));
  });

  it('council CSS never touches global :root colors', () => {
    for (const sheet of [css, roomCss]) {
      assert.ok(!/(^|\n)\s*:root\s*\{/.test(sheet), 'no global :root rule');
      assert.ok(sheet.includes('.council-theme'), 'rules are council-scoped');
    }
  });

  it('reduced motion collapses transitions without removing content', () => {
    assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.ok(block.includes('transition-duration: 0.01ms !important'));
    assert.ok(!block.includes('display: none'), 'reduced motion must not hide information');
  });

  it('narrow rooms become a grid instead of scaling the table', () => {
    assert.ok(roomCss.includes('@container (max-width: 919px)'));
    assert.ok(roomCss.includes('grid-template-columns: repeat(3, minmax(0, 1fr))'));
    assert.ok(roomCss.includes('@container (max-width: 640px)'));
    assert.ok(roomCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'));
  });
});

describe('fixture honesty (Section 17.5)', () => {
  it('fixtures are labeled synthetic with provenance and sample mode', () => {
    assert.ok(/synthetic fixture/i.test(FIXTURE_PROVENANCE));
    assert.equal(SAMPLE_ROOM_VIEW.mode, 'sample');
    assert.equal(QUEUED_ROOM_VIEW.mode, 'sample');
  });
});
