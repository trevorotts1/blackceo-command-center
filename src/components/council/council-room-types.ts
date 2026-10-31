/**
 * council-room-types.ts (CWE-032, Skill 77 Council of Wise Elders)
 *
 * Typed inputs for the room shell, seats, and accessible reading view.
 * These types mirror the CWE-003 canonical contracts (the single source in
 * the onboarding runtime: runtime/src/contracts/enums.ts and schemas.ts):
 *
 * - CouncilSeatId is the canonical SEAT_IDS list, in approved roster order.
 * - CouncilStance is the canonical STANCES list from a committed AdvisorCard.
 * - CouncilSeatStatus is derived ONLY from committed seat events
 *   (Section 18.1: seat.queued, seat.started, seat.completed, seat.failed).
 *   It is a display projection of committed event state, never a guess:
 *   a queued seat is waiting, not thinking (Sections 14.1, 18.4).
 * - CouncilSeatCardView carries the display fields of a validated,
 *   committed AdvisorCard (stance, preferred option, decisive arguments,
 *   strongest objection, conditions, critical unknowns, what would change
 *   the seat's mind, evidence strength). A seat with no committed card has
 *   `card: null`; the UI must say so plainly instead of inventing content.
 *
 * Roster identity data (names, responsibilities, profile labels, medallion
 * alt text, file references) is consumed from the CWE-031 portrait manifest
 * (onboarding 77-council-of-wise-elders/assets/portrait-manifest.json at
 * commit d3bdcfe1). The medallion SVGs vendored under ./portraits/ are
 * byte-identical copies of the canonical CWE-031 assets; their SHA-256
 * hashes match the manifest entries (recorded in the CWE-032 build
 * report). CWE-045 owns the final generated-consumer parity check.
 *
 * No data is fetched at module import; every value here is static roster
 * data or a pure function of its arguments.
 */

import { COUNCIL_SEAT_SLOTS } from './council-theme';

/* ── Canonical seat IDs (CWE-003 SEAT_IDS), approved roster order ─────── */
export const COUNCIL_SEAT_IDS = [
  'simon-sinek',
  'td-jakes',
  'oprah-winfrey',
  'tiffany-aliche',
  'russell-brunson',
  'michelle-obama',
  'brene-brown',
  'dennis-kimbro',
  'les-brown',
] as const;
export type CouncilSeatId = (typeof COUNCIL_SEAT_IDS)[number];

/** Canonical card stances (CWE-003 STANCES). */
export type CouncilStance = 'support' | 'conditional' | 'oppose' | 'abstain';

/**
 * Honest per-seat lifecycle, projected from committed seat events only
 * (Section 18.4). There is deliberately no "thinking" state.
 */
export type CouncilSeatStatus = 'queued' | 'started' | 'completed' | 'failed';

/** How the room's data should be badged (Section 18.4, T101). */
export type CouncilRoomMode = 'live' | 'replay' | 'sample' | 'idle';

export interface CouncilMedallionRef {
  /** Canonical manifest file reference, master variant (240x240). */
  file: string;
  /** Canonical manifest file reference, small variant (96x96). */
  smallFile: string;
  /** Alt text from the CWE-031 portrait manifest, verbatim. */
  altText: string;
}

export interface CouncilSeatIdentity {
  seatId: CouncilSeatId;
  /** Full display name, exactly as in the manifest (accents preserved). */
  displayName: string;
  /** Short responsibility, exactly as in the manifest role field. */
  responsibility: string;
  /** Section 7.1 attribution label, from the manifest profile_label. */
  profileLabel: string;
  medallion: CouncilMedallionRef;
}

/**
 * The nine seat identities, in roster order, consumed from the CWE-031
 * portrait manifest. Medallion file references are the manifest's own
 * `portraits/<seat>.svg` paths inside the canonical asset folder.
 */
export const COUNCIL_SEAT_ROSTER: readonly CouncilSeatIdentity[] = [
  {
    seatId: 'simon-sinek',
    displayName: 'Simon Sinek',
    responsibility: 'purpose and strategic alignment',
    profileLabel:
      'AI perspective inspired by the published work of Simon Sinek. Not the individual and not an endorsement.',
    medallion: {
      file: 'portraits/simon-sinek.svg',
      smallFile: 'portraits/simon-sinek-sm.svg',
      altText:
        'Illustrative medallion for Simon Sinek, the purpose and strategic alignment seat: a colored ring around a warm tinted disc with three concentric circles and the initials SS. A designed symbol, not a photograph of Simon Sinek.',
    },
  },
  {
    seatId: 'td-jakes',
    displayName: 'T. D. Jakes',
    responsibility: 'instinct, reinvention, and communication',
    profileLabel:
      'AI perspective inspired by the published work of T. D. Jakes. Not the individual and not an endorsement.',
    medallion: {
      file: 'portraits/td-jakes.svg',
      smallFile: 'portraits/td-jakes-sm.svg',
      altText:
        'Illustrative medallion for T. D. Jakes, the instinct, reinvention, and communication seat: a colored ring around a warm tinted disc with a microphone and the initials TJ. A designed symbol, not a photograph of T. D. Jakes.',
    },
  },
  {
    seatId: 'oprah-winfrey',
    displayName: 'Oprah Winfrey',
    responsibility: 'intention, significance, and human connection',
    profileLabel:
      'AI perspective inspired by the published work of Oprah Winfrey. Not the individual and not an endorsement.',
    medallion: {
      file: 'portraits/oprah-winfrey.svg',
      smallFile: 'portraits/oprah-winfrey-sm.svg',
      altText:
        'Illustrative medallion for Oprah Winfrey, the intention, significance, and human connection seat: a colored ring around a warm tinted disc with an open book beneath a small sun and the initials OW. A designed symbol, not a photograph of Oprah Winfrey.',
    },
  },
  {
    seatId: 'tiffany-aliche',
    displayName: 'Tiffany Aliche',
    responsibility: 'financial stability and sustainable commitments',
    profileLabel:
      'AI perspective inspired by the published work of Tiffany Aliche. Not the individual and not an endorsement.',
    medallion: {
      file: 'portraits/tiffany-aliche.svg',
      smallFile: 'portraits/tiffany-aliche-sm.svg',
      altText:
        'Illustrative medallion for Tiffany Aliche, the financial stability and sustainable commitments seat: a colored ring around a warm tinted disc with a pediment over three columns, a foundation and the initials TA. A designed symbol, not a photograph of Tiffany Aliche.',
    },
  },
  {
    seatId: 'russell-brunson',
    displayName: 'Russell Brunson',
    responsibility: 'offers, acquisition, and conversion',
    profileLabel:
      'AI perspective inspired by the published work of Russell Brunson. Not the individual and not an endorsement.',
    medallion: {
      file: 'portraits/russell-brunson.svg',
      smallFile: 'portraits/russell-brunson-sm.svg',
      altText:
        'Illustrative medallion for Russell Brunson, the offers, acquisition, and conversion seat: a colored ring around a warm tinted disc with a funnel and the initials RB. A designed symbol, not a photograph of Russell Brunson.',
    },
  },
  {
    seatId: 'michelle-obama',
    displayName: 'Michelle Obama',
    responsibility: 'grounded leadership, identity, and community',
    profileLabel:
      'AI perspective inspired by the published work of Michelle Obama. Not the individual and not an endorsement.',
    medallion: {
      file: 'portraits/michelle-obama.svg',
      smallFile: 'portraits/michelle-obama-sm.svg',
      altText:
        'Illustrative medallion for Michelle Obama, the grounded leadership, identity, and community seat: a colored ring around a warm tinted disc with a sunrise over two horizon lines and the initials MO. A designed symbol, not a photograph of Michelle Obama.',
    },
  },
  {
    seatId: 'brene-brown',
    displayName: 'Brené Brown',
    responsibility: 'courage, trust, and accountable behavior',
    profileLabel:
      'AI perspective inspired by the published work of Brené Brown. Not the individual and not an endorsement.',
    medallion: {
      file: 'portraits/brene-brown.svg',
      smallFile: 'portraits/brene-brown-sm.svg',
      altText:
        'Illustrative medallion for Brené Brown, the courage, trust, and accountable behavior seat: a colored ring around a warm tinted disc with a heart outline and the initials BB. A designed symbol, not a photograph of Brené Brown.',
    },
  },
  {
    seatId: 'dennis-kimbro',
    displayName: 'Dr. Dennis Kimbro',
    responsibility: 'ownership, wealth creation, and achievement',
    profileLabel:
      'AI perspective inspired by the published work of Dr. Dennis Kimbro. Not the individual and not an endorsement.',
    medallion: {
      file: 'portraits/dennis-kimbro.svg',
      smallFile: 'portraits/dennis-kimbro-sm.svg',
      altText:
        'Illustrative medallion for Dr. Dennis Kimbro, the ownership, wealth creation, and achievement seat: a colored ring around a warm tinted disc with a key and the initials DK. A designed symbol, not a photograph of Dr. Dennis Kimbro.',
    },
  },
  {
    seatId: 'les-brown',
    displayName: 'Les Brown',
    responsibility: 'self-belief, resilience, and committed action',
    profileLabel:
      'AI perspective inspired by the published work of Les Brown. Not the individual and not an endorsement.',
    medallion: {
      file: 'portraits/les-brown.svg',
      smallFile: 'portraits/les-brown-sm.svg',
      altText:
        'Illustrative medallion for Les Brown, the self-belief, resilience, and committed action seat: a colored ring around a warm tinted disc with a rising arrow over a ground line and the initials LB. A designed symbol, not a photograph of Les Brown.',
    },
  },
] as const;

const ROSTER_INDEX: ReadonlyMap<string, number> = new Map(
  COUNCIL_SEAT_IDS.map((id, i) => [id, i]),
);

const IDENTITY_BY_ID: ReadonlyMap<CouncilSeatId, CouncilSeatIdentity> = new Map(
  COUNCIL_SEAT_ROSTER.map((s) => [s.seatId, s]),
);

export function seatIdentity(seatId: CouncilSeatId): CouncilSeatIdentity {
  const identity = IDENTITY_BY_ID.get(seatId);
  if (!identity) throw new Error(`Unknown council seat id: ${seatId}`);
  return identity;
}

/* ── Committed card display fields (subset of the canonical AdvisorCard) ─ */
export interface CouncilSeatCardView {
  stance: CouncilStance;
  /** Label of the seat's preferred option, shown only from a validated card. */
  preferredOptionLabel: string | null;
  decisiveArguments: readonly string[];
  strongestObjection: string;
  conditions: readonly string[];
  criticalUnknowns: readonly string[];
  /** The card's own "what would change my mind" text. */
  changeMyMind: string;
  evidenceStrength: 'low' | 'medium' | 'high';
  minorityPosition: string | null;
}

/** One seat as the room renders it: identity plus committed state. */
export interface CouncilSeatView {
  seatId: CouncilSeatId;
  status: CouncilSeatStatus;
  /** Present only when a validated card has been committed for this seat. */
  card: CouncilSeatCardView | null;
}

/** The whole room as the shell renders it. */
export interface CouncilRoomView {
  decisionTitle: string;
  /** Ordinary-language phase, e.g. "Round 2 of 3: Challenge". */
  phaseLabel: string;
  /** Round number 1-3 for the stepper; null before the run starts. */
  currentRound: 1 | 2 | 3 | null;
  /** The current crux, when one has been committed; otherwise null. */
  cruxLabel: string | null;
  mode: CouncilRoomMode;
  /**
   * Seats in ARRIVAL order (the order committed events delivered them).
   * Rendering always re-orders by roster slot; see orderSeatsByRoster.
   */
  seats: readonly CouncilSeatView[];
}

/**
 * Stable slot order: seats are always laid out by roster slot, keyed to the
 * stable seat ID, never by arrival order, score, or model (Section 22.4).
 * Unknown seat IDs sort after the known roster, in input order.
 */
export function orderSeatsByRoster<T extends { seatId: string }>(
  seats: readonly T[],
): T[] {
  return seats
    .map((seat, i) => ({ seat, i }))
    .sort((a, b) => {
      const ai = ROSTER_INDEX.get(a.seat.seatId) ?? Number.MAX_SAFE_INTEGER;
      const bi = ROSTER_INDEX.get(b.seat.seatId) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi || a.i - b.i;
    })
    .map(({ seat }) => seat);
}

/** Slot geometry for a seat, from the locked CWE-031 geometry table. */
export function seatSlot(seatId: CouncilSeatId): { xPct: number; yPct: number } {
  const slot = COUNCIL_SEAT_SLOTS.find((s) => s.seatId === seatId);
  if (!slot) throw new Error(`No locked slot for council seat id: ${seatId}`);
  return slot;
}

/* ── Honest state labels (Sections 14.1, 18.4) ─────────────────────────── */

export const STANCE_LABELS: Readonly<Record<CouncilStance, string>> = {
  support: 'Supports',
  conditional: 'Conditional',
  oppose: 'Opposes',
  abstain: 'Abstains',
};

/**
 * The one honest status line for a seat. A queued seat is waiting, never
 * "thinking"; a started seat has a real operation in progress; stance
 * labels appear only when a validated card has been committed.
 */
export function seatStatusLabel(seat: CouncilSeatView): string {
  switch (seat.status) {
    case 'queued':
      return 'Waiting in queue';
    case 'started':
      return 'In progress';
    case 'failed':
      return 'Did not complete';
    case 'completed':
      return seat.card ? STANCE_LABELS[seat.card.stance] : 'Completed';
  }
}

/** Accessible name for a seat control (Section 23.1): name, role, state. */
export function seatAccessibleName(seat: CouncilSeatView): string {
  const identity = seatIdentity(seat.seatId);
  return `${identity.displayName}, ${identity.responsibility}, current state: ${seatStatusLabel(seat)}`;
}

/** Persistent badge text for the room mode (Section 18.4, T101). */
export function roomModeBadge(mode: CouncilRoomMode): string | null {
  switch (mode) {
    case 'live':
      return 'Live';
    case 'replay':
      return 'Recorded replay';
    case 'sample':
      return 'Fictional sample';
    case 'idle':
      // The pre-sitting chamber: the room is open, nothing has started.
      return 'Chamber open';
  }
}
