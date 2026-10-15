/**
 * council-verdict-label-render.test.tsx — CWE-050 item 8, CWE-034's
 * carried check on the COMPOSED session page surface: the Section 7
 * attribution label line appears wherever seat-attributed verdict
 * content renders.
 *
 * The label is exact and standing (Section 7.1): "AI perspective
 * inspired by the published work of [name]. Not the individual and
 * not an endorsement." Two render sites carry seat-attributed
 * verdict content in CouncilVerdict — the consult result heading
 * and the scored detailed-rounds rows — and this suite pins both:
 *
 *   1. Scored verdict: every seat-attributed detail row renders its
 *      own seat's exact profile label, and every rendered label
 *      matches the Section 7 form verbatim.
 *   2. Consult verdict: the single-seat result renders the seat's
 *      exact profile label directly under the seat heading.
 *
 * Runs under vitest.component.config.ts (jsdom), registered beside
 * the other council render suites.
 */

import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CouncilVerdict } from '../../src/components/council/CouncilVerdict';
import { seatIdentity } from '../../src/components/council/council-room-types';
import {
  FIXTURE_BRIEF,
  FIXTURE_CARDS,
  FIXTURE_OPTION_LABELS,
  FIXTURE_SESSION_ID,
  FIXTURE_SHA_A,
  FIXTURE_SHA_B,
  FIXTURE_SHA_C,
  FIXTURE_VERDICT_READ,
} from '../../src/components/council/council-session-fixtures';

afterEach(() => {
  cleanup();
});

const SECTION_7_FORM =
  /^AI perspective inspired by the published work of .+\. Not the individual and not an endorsement\.$/;

describe('Section 7 label on the composed verdict surface', () => {
  it('scored verdict: every seat-attributed detail row carries its own seat label, verbatim', () => {
    render(
      <CouncilVerdict
        verdictRead={FIXTURE_VERDICT_READ}
        optionLabels={FIXTURE_OPTION_LABELS}
        cards={FIXTURE_CARDS}
        brief={FIXTURE_BRIEF}
        mode="live"
        sessionId={FIXTURE_SESSION_ID}
      />,
    );
    const labels = screen.getAllByTestId('verdict-seat-label');
    assertLabelsVerbatim(labels.map((el) => el.textContent ?? ''));

    // Each fixture card's seat label is present among the rows.
    const advisorSeats = new Set(
      FIXTURE_CARDS.filter((c) => c.card_kind === 'advisor').map((c) => c.seat_id),
    );
    assert.ok(advisorSeats.size >= 2, 'the fixture exercises more than one seat');
    for (const seatId of advisorSeats) {
      const expected = seatIdentity(seatId).profileLabel;
      assert.ok(
        labels.some((el) => el.textContent === expected),
        `the detail rows render ${seatId}'s exact Section 7 label`,
      );
    }
    // At least one label per seat-attributed card row.
    assert.ok(labels.length >= FIXTURE_CARDS.length);
  });

  it('consult verdict: the single-seat result carries the seat label under its heading', () => {
    const consultCard = {
      schema_version: 'wise-elders.card/v1',
      session_id: FIXTURE_SESSION_ID,
      brief_revision: 1,
      seat_id: 'brene-brown',
      input_manifest_sha256: FIXTURE_SHA_B,
      pack_version: 'pack-fixture-1.0.0',
      card_kind: 'consult',
      answer: 'Start with the smallest honest version of the pilot.',
      framework_applications: [],
      evidence_ids: [],
      assumptions: [],
      limits: [],
      next_step: 'Name the pilot owner this week.',
      host: {
        scope: {
          tenant_id: 'tenant-a',
          company_id: 'company-a',
          installation_id: 'install-a',
          owner_subject: null,
        },
        operation_id: 'op-consult-fixture',
        route_id: 'route-fixture-1',
        session_id: FIXTURE_SESSION_ID,
        stamped_at: '2026-10-14T12:00:00.000Z',
        source_status: 'unverified',
      },
    };
    const consultVerdict = {
      schema_version: 'wise-elders.verdict/v1',
      result_kind: 'consult',
      session_id: FIXTURE_SESSION_ID,
      verdict_revision: 1,
      consult_card: consultCard,
      next_step: 'Name the pilot owner this week.',
      validation_status: 'valid',
      brief_sha256: FIXTURE_SHA_A,
      content_sha256: FIXTURE_SHA_C,
    };
    render(
      <CouncilVerdict
        verdictRead={{
          session_id: FIXTURE_SESSION_ID,
          verdict_state: 'validated',
          verdict: consultVerdict,
        }}
        optionLabels={FIXTURE_OPTION_LABELS}
        brief={FIXTURE_BRIEF}
        mode="live"
        sessionId={FIXTURE_SESSION_ID}
      />,
    );
    const label = screen.getByTestId('verdict-seat-label');
    assert.equal(
      label.textContent,
      'AI perspective inspired by the published work of Brené Brown. Not the individual and not an endorsement.',
    );
    assert.equal(label.textContent, seatIdentity('brene-brown').profileLabel);
  });
});

function assertLabelsVerbatim(texts: string[]): void {
  assert.ok(texts.length > 0, 'at least one seat label rendered');
  for (const text of texts) {
    assert.match(text, SECTION_7_FORM);
  }
}
