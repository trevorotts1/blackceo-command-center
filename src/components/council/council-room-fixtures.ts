/**
 * council-room-fixtures.ts (CWE-032, Skill 77)
 *
 * SYNTHETIC FIXTURES for component tests and rendered evidence only.
 *
 * Provenance: invented by the CWE-032 builder on 2026-10-14 for component
 * construction and testing, following the directive's fixture rule
 * (Sections 17.5 and 34.2: build the room against visibly synthetic typed
 * fixtures; CWE-032 build step 3: visibly mark all sample state). The
 * decision, cards, and wording are fictional, modeled on the directive's
 * own fictional reveal scenario (Section 36.4: a coaching-business choice
 * between keeping the current offer, a bounded paid pilot, and a broad
 * launch). No real client, session, or model output appears here.
 *
 * The room built from these fixtures always carries mode: 'sample', which
 * renders the persistent "Fictional sample" badge. Sample state can never
 * create production work, and no test may present these fixtures as live
 * product evidence.
 */

import {
  COUNCIL_SEAT_ROSTER,
  type CouncilRoomView,
  type CouncilSeatView,
} from './council-room-types';

export const FIXTURE_PROVENANCE =
  'Synthetic fixture invented by CWE-032 (2026-10-14) for component tests and screenshots. Fictional decision and cards; not a real session, client, or model output.';

/** seatId -> medallion URL maps for the fixture, given a URL base prefix. */
export function fixtureMedallionSrcs(base: string): {
  small: Record<string, string>;
  large: Record<string, string>;
} {
  const small: Record<string, string> = {};
  const large: Record<string, string> = {};
  for (const seat of COUNCIL_SEAT_ROSTER) {
    small[seat.seatId] = `${base}/${seat.medallion.smallFile.split('/').pop()}`;
    large[seat.seatId] = `${base}/${seat.medallion.file.split('/').pop()}`;
  }
  return { small, large };
}

const PILOT = 'B. Pilot the revised offer with new clients';

function completedSeat(
  seatId: CouncilSeatView['seatId'],
  card: CouncilSeatView['card'],
): CouncilSeatView {
  return { seatId, status: 'completed', card };
}

/**
 * The sample room. Seats are deliberately listed in scrambled ARRIVAL
 * order (the order committed events might deliver them), never roster
 * order: rendering must still place every seat in its locked roster slot.
 * Six seats have committed cards, one has started, two are still queued.
 */
export const SAMPLE_ROOM_VIEW: CouncilRoomView = {
  decisionTitle: 'Pilot the revised coaching offer with new clients next month?',
  phaseLabel: 'Round 2 of 3: Challenge',
  currentRound: 2,
  cruxLabel: 'demand evidence versus delivery capacity',
  mode: 'sample',
  seats: [
    {
      seatId: 'les-brown',
      status: 'queued',
      card: null,
    },
    completedSeat('tiffany-aliche', {
      stance: 'oppose',
      preferredOptionLabel: PILOT,
      decisiveArguments: [
        'A broad launch commits cash before delivery capacity is proven; the bounded pilot prices that risk in advance.',
      ],
      strongestObjection:
        'Delivery capacity is unproven at twice the volume, and the reserve does not cover a failed broad launch.',
      conditions: ['Confirm the cash reserve covers the full pilot cost before launch.'],
      criticalUnknowns: ['Actual delivery hours available per week.'],
      changeMyMind: 'A measured pilot showing delivery hours per client at the revised price.',
      evidenceStrength: 'medium',
      minorityPosition: null,
    }),
    completedSeat('simon-sinek', {
      stance: 'support',
      preferredOptionLabel: PILOT,
      decisiveArguments: [
        'The pilot tests the revised offer without breaking the promise the current offer already makes to clients.',
      ],
      strongestObjection: 'If the pilot is framed as a discount rather than a purpose-led test, it dilutes the WHY.',
      conditions: [],
      criticalUnknowns: [],
      changeMyMind: 'Evidence that the revised offer contradicts the stated purpose.',
      evidenceStrength: 'medium',
      minorityPosition: null,
    }),
    { seatId: 'dennis-kimbro', status: 'queued', card: null },
    completedSeat('oprah-winfrey', {
      stance: 'support',
      preferredOptionLabel: PILOT,
      decisiveArguments: [
        'New clients experience the revised offer first, so the people affected by the change are the ones who chose it.',
      ],
      strongestObjection: 'Existing clients must hear the intention plainly, or the pilot reads as favoritism.',
      conditions: ['Tell existing clients why the pilot starts with new clients.'],
      criticalUnknowns: [],
      changeMyMind: 'Feedback that existing clients experience the pilot as exclusion.',
      evidenceStrength: 'low',
      minorityPosition: null,
    }),
    { seatId: 'michelle-obama', status: 'started', card: null },
    completedSeat('russell-brunson', {
      stance: 'support',
      preferredOptionLabel: PILOT,
      decisiveArguments: [
        'A capped pilot produces real conversion evidence instead of another forecast.',
      ],
      strongestObjection: 'Without a cap, early demand can oversell seats the team cannot deliver.',
      conditions: ['Cap pilot seats at what the team can actually deliver.'],
      criticalUnknowns: ['Conversion rate of the revised price page.'],
      changeMyMind: 'Pilot conversion data showing the revised price underperforms the current offer.',
      evidenceStrength: 'medium',
      minorityPosition: null,
    }),
    completedSeat('brene-brown', {
      stance: 'conditional',
      preferredOptionLabel: PILOT,
      decisiveArguments: [
        'The pilot works only if the team can say plainly what is being tested and what would stop it.',
      ],
      strongestObjection: 'Unclear stop conditions turn a bounded test into quiet overcommitment.',
      conditions: ['Write the pilot stop conditions down before launch.'],
      criticalUnknowns: [],
      changeMyMind: 'A team agreement on explicit stop conditions and honest reporting.',
      evidenceStrength: 'low',
      minorityPosition: null,
    }),
    completedSeat('td-jakes', {
      stance: 'conditional',
      preferredOptionLabel: PILOT,
      decisiveArguments: [
        'The message has to fit the moment: a test offered with confidence, not an apology for changing.',
      ],
      strongestObjection: 'If the announcement sounds uncertain, new clients will hear risk instead of intention.',
      conditions: ['Rewrite the announcement so the reason for the pilot leads.'],
      criticalUnknowns: [],
      changeMyMind: 'A message test showing the current announcement already lands clearly.',
      evidenceStrength: 'low',
      minorityPosition: null,
    }),
  ],
};

/** Every seat still queued: the honest pre-run room. */
export const QUEUED_ROOM_VIEW: CouncilRoomView = {
  decisionTitle: 'Pilot the revised coaching offer with new clients next month?',
  phaseLabel: 'Waiting to start',
  currentRound: null,
  cruxLabel: null,
  mode: 'sample',
  seats: COUNCIL_SEAT_ROSTER.map((s) => ({
    seatId: s.seatId,
    status: 'queued' as const,
    card: null,
  })),
};
