/**
 * U79 (GK-17) — Command Center leg: AnthologyBoardDriftBanner rewired to the
 * ONB leg's converging-repair signal.
 *
 * BINARY acceptance (spec GK-17, line 1996), CC leg's portion (the second
 * clause): "the banner renders ONLY when the repair path is deliberately
 * broken in the fixture." Concretely: the banner renders if and only if
 * `advisory.anthology_board_projection.board_reconcile_converged === false`
 * — never on `true`, `null`/absent, a fetch failure, or (critically, proving
 * the REWIRE actually happened) the old pre-U79 drift shape
 * (`pass:false`, `board_cards:0`) alone.
 *
 * Renders the REAL component (react-dom via @testing-library/react + jsdom
 * — see vitest.component.config.ts), never a hand-rolled restatement.
 * `global.fetch` is stubbed per test; every unlisted URL throws so a
 * regression that adds a second/different endpoint call is caught by the
 * component's actual effect, same convention as u47-health-indicator.test.tsx.
 *
 * npx vitest run --config vitest.component.config.ts tests/unit/u79-anthology-selfheal-banner.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

import { AnthologyBoardDriftBanner } from '../../src/components/anthology/BoardDriftBanner';

afterEach(() => cleanup());

const DEEP_HEALTH_URL = '/api/health/deep';

function stubFetch(handler: () => Promise<Response> | Response | 'error') {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url !== DEEP_HEALTH_URL) {
      throw new Error(`Unexpected fetch to unlisted URL in this test's stub: ${url}`);
    }
    const result = handler();
    if (result === 'error') throw new Error('simulated network failure');
    return result;
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

/** Asserts the banner never renders for the given advisory payload — polls
 *  briefly (the effect is async) then confirms the testid never appeared. */
async function expectNoBanner(advisory: unknown): Promise<void> {
  global.fetch = stubFetch(() => jsonResponse({ advisory })) as unknown as typeof fetch;
  render(<AnthologyBoardDriftBanner />);
  // Give the effect's fetch/then chain a real microtask/macrotask turn.
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 10));
  expect(screen.queryByTestId('anthology-selfheal-banner')).toBeNull();
}

describe('AnthologyBoardDriftBanner — U79/GK-17 converged-only gate', () => {
  it('renders nothing when advisory.anthology_board_projection is absent', async () => {
    await expectNoBanner(undefined);
  });

  it('renders nothing when board_reconcile_converged is true', async () => {
    await expectNoBanner({
      anthology_board_projection: {
        pass: true,
        detail: 'anthology_board_projection: OK — ledger holds 6 row(s), board shows 6 anthology card(s) (projecting)',
        board_reconcile_converged: true,
      },
    });
  });

  it('renders nothing when board_reconcile_converged is null (unknown — legacy runner / no report / stale)', async () => {
    await expectNoBanner({
      anthology_board_projection: {
        pass: true,
        detail: 'anthology_board_projection: OK — ledger holds 6 row(s), board shows 6 anthology card(s) (projecting)',
        board_reconcile_converged: null,
      },
    });
  });

  it('renders nothing when board_reconcile_converged is entirely absent from the advisory object', async () => {
    await expectNoBanner({
      anthology_board_projection: {
        pass: true,
        detail: 'anthology_board_projection: OK — Anthology Engine not provisioned on this box; not applicable',
      },
    });
  });

  // REWIRE proof (acceptance-critical): the pre-U79 shape (pass:false,
  // indeterminate:false, board_cards:0, ledger rows>0) used to be the banner's
  // ENTIRE gate. Post-rewire it must be COMPLETELY inert on its own — the
  // banner must key off board_reconcile_converged alone.
  it('renders NOTHING for the old pre-U79 drift shape (pass:false/board_cards:0) when board_reconcile_converged is true — proves the rewire', async () => {
    await expectNoBanner({
      anthology_board_projection: {
        pass: false,
        indeterminate: false,
        ledger_participants: 5,
        ledger_anthologies: 2,
        board_cards: 0,
        detail: 'anthology_board_projection: DRIFT — ledger holds 5 participant(s) + 2 anthology row(s) but the board shows 0 anthology card(s) (dead board, not idle). Run: mc_board.py reconcile --json',
        board_reconcile_converged: true,
      },
    });
  });

  it('renders NOTHING for the old pre-U79 drift shape when board_reconcile_converged is absent (no report yet)', async () => {
    await expectNoBanner({
      anthology_board_projection: {
        pass: false,
        indeterminate: false,
        ledger_participants: 5,
        ledger_anthologies: 2,
        board_cards: 0,
        detail: 'anthology_board_projection: DRIFT — ledger holds 5 participant(s) + 2 anthology row(s) but the board shows 0 anthology card(s) (dead board, not idle). Run: mc_board.py reconcile --json',
      },
    });
  });

  it('renders nothing on a fetch network failure (fail-soft, preserved)', async () => {
    global.fetch = stubFetch(() => 'error') as unknown as typeof fetch;
    render(<AnthologyBoardDriftBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('anthology-selfheal-banner')).toBeNull();
  });

  it('renders nothing on a non-ok HTTP response (fail-soft, preserved)', async () => {
    global.fetch = stubFetch(() => jsonResponse({}, false)) as unknown as typeof fetch;
    render(<AnthologyBoardDriftBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('anthology-selfheal-banner')).toBeNull();
  });

  it('renders the escalation banner ONLY when board_reconcile_converged is false — the fixture repair-path-broken case', async () => {
    global.fetch = stubFetch(() =>
      jsonResponse({
        advisory: {
          anthology_board_projection: {
            pass: false,
            indeterminate: false,
            ledger_participants: 5,
            ledger_anthologies: 0,
            board_cards: 4,
            detail:
              'anthology_board_projection: DRIFT — ledger holds 5 participant(s) + 0 anthology row(s) but the board shows 4 anthology card(s) (dead board, not idle). Run: mc_board.py reconcile --json',
            board_reconcile_converged: false,
            board_reconcile_status: 'unconverged',
            board_reconcile_age_seconds: 300,
          },
        },
      })
    ) as unknown as typeof fetch;

    render(<AnthologyBoardDriftBanner />);
    await waitFor(() => screen.getByTestId('anthology-selfheal-banner'));

    const banner = screen.getByTestId('anthology-selfheal-banner');
    const text = banner.textContent ?? '';

    // Escalation-only copy: acceptance requires the banner communicate that
    // the AUTOMATED repair ran and failed, never instruct manual remediation.
    expect(text.toLowerCase()).toMatch(/did not converge|not converge|failed to converge/);

    // Must NOT instruct the operator to hand-run the reconcile command —
    // that was the pre-U79 posture and contradicts "zero operator action".
    expect(text).not.toMatch(/Run:/);
    expect(text).not.toContain('mc_board.py');
    expect(text).not.toContain('reconcile --json');
  });
});
