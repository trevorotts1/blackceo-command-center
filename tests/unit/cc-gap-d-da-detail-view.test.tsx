/**
 * Gap D — PRD section 5 requires a Devil's Advocate challenge DETAIL view
 * (the challenge, the DA's feedback, the assumptions it attacked, the outcome,
 * resolution). The feed rendered only the card summary; assumptions,
 * raw_response and resolved_at were fetched (GET is SELECT *) and thrown away.
 *
 * npx vitest run --config vitest.component.config.ts tests/unit/cc-gap-d-da-detail-view.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

import { DevilsAdvocateFeed } from '../../src/components/ceo-board/DevilsAdvocateFeed';

afterEach(() => cleanup());

const row = {
  id: 'c1',
  department_id: 'marketing',
  trigger_type: 'campaign-review',
  challenge: 'Why did ad spend rise 20% while leads grew only 8%?',
  specific_concern: 'No attribution window was stated.',
  assumptions: 'Lead quality is constant across channels.',
  raw_response: 'FULL DA TEXT: spend efficiency fell; recommend capping paid social.',
  severity: 'high',
  outcome: 'Capped paid social at 30%.',
  status: 'approved',
  created_at: new Date().toISOString(),
  resolved_at: '2026-10-01T12:00:00.000Z',
};

function stub(rows: unknown[]) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ challenges: rows }),
  })) as unknown as typeof fetch;
}

describe("Devil's Advocate feed - challenge detail view (gap D)", () => {
  it('opens a detail view with assumptions, the full DA response, outcome and resolution, and closes it again', async () => {
    stub([row]);
    render(<DevilsAdvocateFeed />);
    await waitFor(() => screen.getByText('Marketing'));

    // Closed by default: nothing from the detail view leaks into the summary.
    expect(screen.queryByTestId('da-detail-c1')).toBeNull();
    expect(screen.queryByText(row.assumptions)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View details' }));

    const detail = screen.getByTestId('da-detail-c1');
    expect(detail.textContent).toContain(row.assumptions);
    expect(detail.textContent).toContain(row.raw_response);
    expect(detail.textContent).toContain('campaign-review');
    expect(detail.textContent).toContain(row.outcome);
    expect(detail.textContent).not.toContain('Not resolved yet');
    expect(screen.getByRole('button', { name: 'Hide details' }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(screen.queryByTestId('da-detail-c1')).toBeNull();
  });

  it('says plainly when a field was never recorded instead of inventing one', async () => {
    stub([{ ...row, assumptions: null, raw_response: null, outcome: null, resolved_at: null, status: 'pending' }]);
    render(<DevilsAdvocateFeed />);
    await waitFor(() => screen.getByText('Marketing'));

    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    const detail = screen.getByTestId('da-detail-c1');
    expect(detail.textContent).toContain('None recorded');
    expect(detail.textContent).toContain('Not resolved yet');
  });

  it('opens one card without opening the others', async () => {
    stub([row, { ...row, id: 'c2', assumptions: 'second card assumption' }]);
    render(<DevilsAdvocateFeed />);
    await waitFor(() => screen.getAllByRole('button', { name: 'View details' }));

    fireEvent.click(screen.getAllByRole('button', { name: 'View details' })[1]);
    expect(screen.queryByTestId('da-detail-c1')).toBeNull();
    expect(screen.getByTestId('da-detail-c2').textContent).toContain('second card assumption');
  });
});
