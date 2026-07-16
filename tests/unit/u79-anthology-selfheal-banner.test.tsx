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

/** Renders the banner against a given fetch stub and asserts it never
 *  appears — polls briefly (the effect is async) then confirms the testid
 *  never showed up. */
async function expectNoBannerWithStub(handler: () => Promise<Response> | Response | 'error'): Promise<void> {
  const fetchStub = stubFetch(handler);
  global.fetch = fetchStub as unknown as typeof fetch;
  render(<AnthologyBoardDriftBanner />);
  await waitFor(() => expect(fetchStub).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 10));
  expect(screen.queryByTestId('anthology-selfheal-banner')).toBeNull();
}

// The pre-U79 drift shape shared by two of the table rows below: the OLD
// banner's entire gate (pass:false, board_cards:0, ledger rows>0). Reused
// verbatim so the only variable between those two rows is the new
// board_reconcile_converged field — proving the rewire actually decoupled
// the banner from this shape.
const OLD_DRIFT_SHAPE = {
  pass: false,
  indeterminate: false,
  ledger_participants: 5,
  ledger_anthologies: 2,
  board_cards: 0,
  detail:
    'anthology_board_projection: DRIFT — ledger holds 5 participant(s) + 2 anthology row(s) but the board shows 0 anthology card(s) (dead board, not idle). Run: mc_board.py reconcile --json',
};

describe('AnthologyBoardDriftBanner — U79/GK-17 converged-only gate', () => {
  // All rows here share identical setup (fetch resolves { advisory }) and an
  // identical assertion (banner never renders) — only the advisory payload
  // varies. Data-driven per test-guard Rule 3 rather than six near-duplicate
  // test bodies.
  it.each<[string, unknown]>([
    ['advisory.anthology_board_projection is absent', undefined],
    [
      'board_reconcile_converged is true',
      {
        anthology_board_projection: {
          pass: true,
          detail: 'anthology_board_projection: OK — ledger holds 6 row(s), board shows 6 anthology card(s) (projecting)',
          board_reconcile_converged: true,
        },
      },
    ],
    [
      'board_reconcile_converged is null (unknown — legacy runner / no report / stale)',
      {
        anthology_board_projection: {
          pass: true,
          detail: 'anthology_board_projection: OK — ledger holds 6 row(s), board shows 6 anthology card(s) (projecting)',
          board_reconcile_converged: null,
        },
      },
    ],
    [
      'board_reconcile_converged is entirely absent from the advisory object',
      {
        anthology_board_projection: {
          pass: true,
          detail: 'anthology_board_projection: OK — Anthology Engine not provisioned on this box; not applicable',
        },
      },
    ],
    // REWIRE proof (acceptance-critical): the pre-U79 shape used to be the
    // banner's ENTIRE gate. Post-rewire it must be COMPLETELY inert on its
    // own — the banner must key off board_reconcile_converged alone.
    [
      'old pre-U79 drift shape (pass:false/board_cards:0) with board_reconcile_converged:true — proves the rewire',
      { anthology_board_projection: { ...OLD_DRIFT_SHAPE, board_reconcile_converged: true } },
    ],
    [
      'old pre-U79 drift shape (pass:false/board_cards:0) with board_reconcile_converged absent (no report yet)',
      { anthology_board_projection: OLD_DRIFT_SHAPE },
    ],
  ])('renders nothing: %s', async (_label, advisory) => {
    await expectNoBannerWithStub(() => jsonResponse({ advisory }));
  });

  // Same assertion, two different fetch-failure MODES (throw vs ok:false) —
  // kept as a small table rather than a single case since the stub shape
  // genuinely differs, not just a value.
  it.each<[string, () => Promise<Response> | Response | 'error']>([
    ['a fetch network failure', () => 'error'],
    ['a non-ok HTTP response', () => jsonResponse({}, false)],
  ])('renders nothing on %s (fail-soft, preserved)', async (_label, handler) => {
    await expectNoBannerWithStub(handler);
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
