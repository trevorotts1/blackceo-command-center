/**
 * CC feature-wiring recovery (2026-10-21) — Devil's Advocate review fields.
 *
 * CHECKLIST.md "Devil's Advocate" open items at the 2026-10-19 train head:
 * "Risks and alternatives listed", "Recommended modifications shown", and
 * the four Review Types had NO storage (no da_challenges column, no POST
 * schema field, no feed section). Migration 173 (da_challenge_review_fields)
 * added the three columns; the paired producer change (openclaw-onboarding
 * shared-utils/devils-advocate*.py) now emits them on the wire. This test
 * proves the SCREEN half of that wiring end-to-end:
 *
 *   1. a challenge carrying the new fields renders the "Risks &
 *      alternatives" + "Recommended modifications" sections AND the
 *      review-type badge in the feed's detail view;
 *   2. a legacy challenge (pre-173 row or older producer — fields absent)
 *      renders an HONEST "Not provided by the generator" empty state,
 *      never fabricated content;
 *   3. an unknown review_type value still renders (badge shows the raw
 *      value, "deep-dive" is prettified) — the feed must never crash on a
 *      value written by a newer producer.
 *
 * npx vitest run --config vitest.component.config.ts tests/unit/cc-da-review-fields.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

import { DevilsAdvocateFeed } from '../../src/components/ceo-board/DevilsAdvocateFeed';

afterEach(() => cleanup());

const FEED_URL = '/api/da-challenges';

function stubFetch(challenges: Record<string, unknown>[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url !== FEED_URL) {
      throw new Error(`Unexpected fetch to unlisted URL in this test's stub: ${url}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ challenges }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function base(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'c-1',
    task_id: null, // no task fetch in the detail view — keeps the stub single-URL
    department_id: 'marketing',
    trigger_type: 'campaign-review',
    challenge: 'Why did ad spend rise 20% while leads grew only 8%?',
    specific_concern: null,
    assumptions: null,
    raw_response: null,
    severity: 'high',
    outcome: null,
    status: 'pending',
    created_at: new Date().toISOString(),
    resolved_at: null,
    ...over,
  };
}

async function openDetail(id: string) {
  await waitFor(() => screen.getByText('View details'));
  const buttons = screen.getAllByText('View details');
  // exactly one card in these fixtures — open it
  fireEvent.click(buttons[0]);
  void id;
  await waitFor(() => screen.getByTestId(`da-detail-${id}`));
}

describe('CC feature wiring — DA review fields reach the screen (migration 173, screen half)', () => {
  it('renders risks/alternatives + recommended modifications + review-type badge when the producer sent them', async () => {
    global.fetch = stubFetch([
      base({
        risks_alternatives:
          'The flagged spend-per-lead assumes stable CPM; a 15% CPM rise alone would explain the gap.\nAlternative: cap spend until CPM stabilizes.',
        recommended_modifications: 'Hold spend at last week\u2019s level for 7 days and re-measure CPM before scaling.',
        review_type: 'deep-dive',
      }),
    ]);

    render(<DevilsAdvocateFeed />);
    await openDetail('c-1');

    const detail = screen.getByTestId('da-detail-c-1');
    expect(detail.textContent).toContain('Risks & alternatives');
    expect(detail.textContent).toContain('The flagged spend-per-lead assumes stable CPM');
    expect(detail.textContent).toContain('Recommended modifications');
    expect(detail.textContent).toContain('Hold spend at last week\u2019s level for 7 days');
    // the review-type badge, prettified
    expect(screen.getByText('deep dive')).toBeTruthy();
  });

  it('renders an honest "Not provided" state for a legacy challenge — never fabricated content', async () => {
    // A pre-migration-173 row: SELECT * returns the new columns as NULL and
    // the interface's optional fields are simply absent here.
    global.fetch = stubFetch([base({})]);

    render(<DevilsAdvocateFeed />);
    await openDetail('c-1');

    const detail = screen.getByTestId('da-detail-c-1');
    expect(detail.textContent).toContain('Risks & alternatives');
    expect(detail.textContent).toContain('Not provided by the generator');
    expect(detail.textContent).toContain('Recommended modifications');
    // exactly two "Not provided" occurrences (one per section)
    const matches = detail.textContent!.split('Not provided by the generator').length - 1;
    expect(matches).toBe(2);
    // no review-type badge on a legacy row
    expect(screen.queryByText('deep dive')).toBeNull();
    expect(screen.queryByText('required')).toBeNull();
  });

  it('an unrecognized review_type still renders (badge shows the raw value, no crash)', async () => {
    global.fetch = stubFetch([
      base({
        review_type: 'monthly-recursive',
        risks_alternatives: 'x',
        recommended_modifications: 'y',
      }),
    ]);

    render(<DevilsAdvocateFeed />);
    await openDetail('c-1');
    expect(screen.getByText('monthly-recursive')).toBeTruthy();
    const detail = screen.getByTestId('da-detail-c-1');
    expect(detail.textContent).toContain('x');
    expect(detail.textContent).toContain('y');
  });
});
