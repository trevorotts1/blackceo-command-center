/**
 * A-U12 acceptance (b)/(c) — PersonaGroundingBanner real render proof.
 *
 * Master spec §A-U12 ACCEPT: "(b) deleting the fixture company-config yields
 * the `persona_grounding_degraded` event + chip within one probe cycle; (c)
 * restoring it clears the chip."
 *
 * Renders the REAL component (react-dom via @testing-library/react + jsdom
 * — see vitest.component.config.ts), never a hand-rolled restatement.
 * `global.fetch` is stubbed per-test; the stub throws on any unlisted URL so
 * a regression that adds a second/different endpoint call is caught by the
 * ACTUAL component's actual effect (same discipline as
 * u47-health-indicator.test.tsx).
 *
 * The chip is LIVE-derived (renders from the current /api/health/deep
 * advisory, not from a persisted event) by design — see
 * PersonaGroundingBanner.tsx's file-header comment. Each of this file's
 * mount/unmount pairs below models exactly one probe cycle, so "chip appears
 * when degraded" / "chip clears when restored" is proven directly rather
 * than by advancing a fake timer through the component's live 30s poll
 * (which this suite also asserts is actually wired, separately, without
 * depending on fake-timer/act() interleaving).
 *
 * npx vitest run --config vitest.component.config.ts tests/unit/u12-a-persona-grounding-chip-render.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

import { PersonaGroundingBanner } from '../../src/components/skill6/PersonaGroundingBanner';

afterEach(() => cleanup());

const HEALTH_URL = '/api/health/deep';
const CHIP_TESTID = 'persona-grounding-degraded-chip';

function stubFetch(handler: () => Promise<Response> | Response) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url !== HEALTH_URL) {
      throw new Error(`Unexpected fetch to unlisted URL in this test's stub: ${url}`);
    }
    return handler();
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

function deepHealthBody(personaMatch: Record<string, unknown> | undefined) {
  return {
    pass: true,
    indeterminate: false,
    timestamp: '2026-07-16T00:00:00.000Z',
    checks: {},
    advisory: personaMatch ? { persona_match: personaMatch } : {},
  };
}

function degradedAdvisory(reasons: string[] = ['company-config missing']) {
  return {
    pass: false,
    indeterminate: false,
    detail: 'persona_match: grounding DEGRADED — 0 sample(s) in the match-score log, mean n/a (advisory only, non-gating)',
    persona_match: { count: 0, mean: null, buckets: { low: 0, mid: 0, high: 0 } },
    grounding: { degraded: true, event: 'persona_grounding_degraded', reasons },
  };
}

function healthyAdvisory() {
  return {
    pass: true,
    indeterminate: false,
    detail: 'persona_match: OK — 12 sample(s) in the match-score log, mean 0.82, grounding healthy',
    persona_match: { count: 12, mean: 0.82, buckets: { low: 1, mid: 3, high: 8 } },
    grounding: { degraded: false, event: 'persona_grounding_degraded', reasons: [] },
  };
}

function indeterminateAdvisory() {
  return {
    pass: true,
    indeterminate: true,
    detail: 'persona_match: probe script not found at /fake/path — not yet deployed on this box (UNKNOWN; non-gating)',
  };
}

describe('PersonaGroundingBanner — ACCEPT (b): deleted fixture company-config yields the chip', () => {
  it('renders the degraded chip when the advisory reports grounding.degraded=true', async () => {
    global.fetch = stubFetch(() => jsonResponse(deepHealthBody(degradedAdvisory(['company-config missing'])))) as unknown as typeof fetch;

    render(<PersonaGroundingBanner />);

    const chip = await screen.findByTestId(CHIP_TESTID);
    expect(chip.textContent).toMatch(/persona grounding degraded/i);
    expect(chip.textContent).toMatch(/company-config missing/);
    // Never claims to affect box health — advisory-only framing must survive.
    expect(chip.textContent).toMatch(/does not affect box health/i);
  });

  it('renders nothing when the advisory is absent (route not yet carrying the field)', async () => {
    global.fetch = stubFetch(() => jsonResponse(deepHealthBody(undefined))) as unknown as typeof fetch;

    render(<PersonaGroundingBanner />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId(CHIP_TESTID)).toBeNull();
  });

  it('renders nothing when the advisory is healthy (grounding.degraded=false)', async () => {
    global.fetch = stubFetch(() => jsonResponse(deepHealthBody(healthyAdvisory()))) as unknown as typeof fetch;

    render(<PersonaGroundingBanner />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId(CHIP_TESTID)).toBeNull();
  });

  it('renders nothing when the advisory is INDETERMINATE (probe unavailable is not a confirmed degrade)', async () => {
    global.fetch = stubFetch(() => jsonResponse(deepHealthBody(indeterminateAdvisory()))) as unknown as typeof fetch;

    render(<PersonaGroundingBanner />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId(CHIP_TESTID)).toBeNull();
  });

  it('fetch failure is fail-soft: renders nothing rather than throwing or crashing the board', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    render(<PersonaGroundingBanner />);

    // Give the effect a tick to run and swallow the rejection.
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId(CHIP_TESTID)).toBeNull();
  });
});

describe('PersonaGroundingBanner — ACCEPT (c): restoring the fixture clears the chip', () => {
  it('the SAME mounted instance clears the chip when a LATER poll reports healthy — real poll, real state transition, no remount', async () => {
    // A mount/remount pair would always start from a fresh useState(null),
    // so it can never prove the `else` branch (the one that actually clears
    // an EXISTING degraded state) runs — a deleted clear-on-restore branch
    // would still pass a mount-only test. Drive a REAL second poll on the
    // SAME instance instead, via the test-only pollIntervalMs override
    // (real timers, no fake-timer/act() interleaving risk).
    let call = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url !== HEALTH_URL) throw new Error(`Unexpected fetch to unlisted URL: ${url}`);
      call += 1;
      // Cycle 1: degraded (fixture company-config deleted). Cycle 2+: restored.
      return jsonResponse(deepHealthBody(call === 1 ? degradedAdvisory() : healthyAdvisory()));
    }) as unknown as typeof fetch;

    render(<PersonaGroundingBanner pollIntervalMs={15} />);

    // Cycle 1 lands: the chip renders.
    await screen.findByTestId(CHIP_TESTID);

    // Cycle 2 (the next poll tick, ~15ms later): the SAME instance must
    // clear the chip — this is the acceptance (c) proof.
    await waitFor(() => expect(screen.queryByTestId(CHIP_TESTID)).toBeNull(), { timeout: 2000 });
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it('MUTATION GUARD: an advisory that FAILS to flip degraded back to false is still caught — the restored-fixture assertion actually bites', async () => {
    // Sanity-check the fixture used above: a "restored" advisory that forgot
    // to flip `degraded` back to false must NOT pass this suite's guard —
    // proving the assertion in the test above is load-bearing, not vacuous.
    const brokenRestoreAdvisory = degradedAdvisory(); // deliberately still degraded
    global.fetch = stubFetch(() => jsonResponse(deepHealthBody(brokenRestoreAdvisory))) as unknown as typeof fetch;
    render(<PersonaGroundingBanner />);
    const chip = await screen.findByTestId(CHIP_TESTID);
    // The chip DOES render here — confirming the "clears" assertion in the
    // sibling test above would have failed had healthyAdvisory() not
    // actually flipped degraded to false.
    expect(chip).toBeTruthy();
  });
});

describe('PersonaGroundingBanner — polling is wired (chip can clear without a page reload)', () => {
  it('registers a recurring poll (setInterval) and clears it on unmount', async () => {
    global.fetch = stubFetch(() => jsonResponse(deepHealthBody(healthyAdvisory()))) as unknown as typeof fetch;

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const { unmount } = render(<PersonaGroundingBanner />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    // @testing-library's own `waitFor` polls via setInterval(fn, 50)
    // internally, so the spy sees calls that are not this component's —
    // isolate this component's OWN registration by its documented 30s
    // cadence rather than asserting every call the environment makes.
    const ownIntervalCalls = setIntervalSpy.mock.results
      .map((r, i) => ({ id: r.value, delay: setIntervalSpy.mock.calls[i][1] }))
      .filter((c) => c.delay === 30_000);
    expect(ownIntervalCalls.length).toBeGreaterThanOrEqual(1);

    unmount();
    const clearedIds = new Set(clearIntervalSpy.mock.calls.map((c) => c[0]));
    for (const { id } of ownIntervalCalls) {
      expect(clearedIds.has(id)).toBe(true);
    }

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
