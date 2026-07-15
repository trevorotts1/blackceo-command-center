/**
 * U47 — ONE <HealthIndicator/>, operator/client variants, mobile-visible.
 *
 * Renders the REAL components (react-dom via @testing-library/react +
 * jsdom — see vitest.component.config.ts), never a hand-rolled restatement.
 * `global.fetch` is stubbed per-test; every stub throws on an unlisted URL
 * so a regression that adds a second/different endpoint call is caught by
 * the ACTUAL component's actual effect.
 *
 * Binary acceptance covered (spec H+L.1.2 / U47):
 *   (a) exactly one health affordance — proven by (1) rendering the client
 *       and operator variants and confirming each is the ONLY
 *       [data-testid="health-indicator"] node in its tree, and (2) a
 *       source-scan in u47-health-single-source.test.ts confirming
 *       Header.tsx renders <HealthIndicator/> exactly once and no longer
 *       references the retired SystemStatusPill / "Gateway Online/Offline"
 *       strings.
 *   (b) client-variant render contains none of the strings `OpenClaw`,
 *       `Cloudflare`, `unauthorized_401`, or any probe id.
 *   (c) indicator visible at 375px width — proven by asserting the root
 *       node's className never contains the Tailwind `hidden` token, at
 *       every one of the three health tiers.
 *   (e) "Re-run bootstrap" drawer action still works.
 *
 * npx vitest run --config vitest.component.config.ts
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';

import { HealthIndicator } from '../../src/components/HealthIndicator';

// jsdom does not implement scrollIntoView; SystemStatusDrawer's (unchanged,
// pre-existing) BootstrapModal calls it on every log update. Polyfill so
// the "Re-run bootstrap" real-render test below can exercise that flow.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => cleanup());

const STATUS_URL = '/api/system/status';
const FORCE_STATUS_URL = '/api/system/status?force=1';
const FEED_URL = '/api/events/client-feed?limit=1';
const BOOTSTRAP_URL = '/api/system/bootstrap';

interface FixtureComponent {
  component: string;
  label: string;
  status: string;
  latencyMs: number | null;
  error?: string;
  detail?: Record<string, unknown>;
  probedAt: string;
  tier: 'critical' | 'auxiliary';
}

function fixturePayload(overall: 'live' | 'degraded' | 'offline'): {
  overall: string;
  probedAt: string;
  components: FixtureComponent[];
  fromCache: boolean;
  cacheAgeMs: number | null;
} {
  const now = '2026-07-15T00:00:00.000Z';
  const components: FixtureComponent[] = [
    {
      component: 'database',
      label: 'Database',
      status: 'live',
      latencyMs: 5,
      probedAt: now,
      tier: 'critical',
    },
    {
      component: 'openclaw_gateway',
      label: 'OpenClaw Gateway',
      status: overall === 'offline' ? 'offline' : 'live',
      latencyMs: 12,
      error: overall === 'offline' ? 'unauthorized_401: gateway rejected token' : undefined,
      probedAt: now,
      tier: 'critical',
    },
    {
      component: 'cloudflare_tunnel',
      label: 'Cloudflare Tunnel',
      status: overall === 'degraded' ? 'degraded' : 'live',
      latencyMs: 30,
      probedAt: now,
      tier: 'auxiliary',
    },
    {
      component: 'provider_anthropic',
      label: 'Anthropic',
      status: 'live',
      latencyMs: 8,
      probedAt: now,
      tier: 'auxiliary',
    },
  ];
  return { overall, probedAt: now, components, fromCache: false, cacheAgeMs: null };
}

/** A fetch stub that throws on any URL not in `handlers`, proving the
 *  component never issues an undocumented request. */
function stubFetch(handlers: Record<string, () => Promise<Response> | Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const handler = handlers[url];
    if (!handler) {
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

beforeEach(() => {
  vi.useRealTimers();
});

describe('HealthIndicator — client variant', () => {
  it('renders a dot + one plain word, is non-interactive, and leaks no probe/component/error strings (acceptance b)', async () => {
    global.fetch = stubFetch({
      [STATUS_URL]: () => jsonResponse(fixturePayload('offline')),
    }) as unknown as typeof fetch;

    render(<HealthIndicator viewerRole="client" />);

    await waitFor(() => screen.getByText('Offline'));

    const nodes = screen.getAllByTestId('health-indicator');
    expect(nodes).toHaveLength(1);
    const node = nodes[0];

    // Non-interactive: no button, no click handler role.
    expect(node.tagName).not.toBe('BUTTON');
    expect(node.getAttribute('role')).toBe('status');

    // Never leaks internal detail — the exact strings named in the spec's
    // binary acceptance (b), plus every raw component id in the fixture.
    const text = node.textContent ?? '';
    for (const banned of [
      'OpenClaw',
      'Cloudflare',
      'unauthorized_401',
      'database',
      'openclaw_gateway',
      'cloudflare_tunnel',
      'provider_anthropic',
      'gateway rejected token',
    ]) {
      expect(text).not.toContain(banned);
    }
    expect(text).toBe('Offline');
  });

  it('never applies a `hidden` class at any of the three health tiers (acceptance c)', async () => {
    for (const overall of ['live', 'degraded', 'offline'] as const) {
      global.fetch = stubFetch({
        [STATUS_URL]: () => jsonResponse(fixturePayload(overall)),
      }) as unknown as typeof fetch;

      const { unmount } = render(<HealthIndicator viewerRole="client" />);
      await waitFor(() => {
        const node = screen.getByTestId('health-indicator');
        expect(node.className).not.toMatch(/(^|\s)hidden(\s|$)/);
        expect(node.className).not.toMatch(/hidden\s+sm:flex/);
      });
      unmount();
      cleanup();
    }
  });

  it('does not open a drawer or expose a click handler', async () => {
    global.fetch = stubFetch({
      [STATUS_URL]: () => jsonResponse(fixturePayload('live')),
    }) as unknown as typeof fetch;

    render(<HealthIndicator viewerRole="client" />);
    await waitFor(() => screen.getByText('Online'));

    // SystemStatusDrawer renders a "System Status" heading when open. It
    // must never appear for the client variant, no matter what.
    expect(screen.queryByText('System Status')).toBeNull();
  });
});

describe('HealthIndicator — operator variant', () => {
  it('is clickable and opens the drawer, grouped by Critical / Auxiliary / Model Providers (U46 tier)', async () => {
    global.fetch = stubFetch({
      [STATUS_URL]: () => jsonResponse(fixturePayload('offline')),
      [FEED_URL]: () => jsonResponse({ events: [], client: null, source: 'local_db' }),
    }) as unknown as typeof fetch;

    render(<HealthIndicator viewerRole="operator" />);
    await waitFor(() => screen.getByText('Offline'));

    const button = screen.getByTestId('health-indicator');
    expect(button.tagName).toBe('BUTTON');
    fireEvent.click(button);

    await waitFor(() => screen.getByText('System Status'));

    // Grouped by tier, not the old hand-maintained component-id allowlist.
    const criticalHeading = screen.getByText('Critical');
    const auxHeading = screen.getByText('Auxiliary');
    const providersHeading = screen.getByText('Model Providers');

    const criticalSection = criticalHeading.closest('section') as HTMLElement;
    expect(within(criticalSection).getByText('Database')).toBeTruthy();
    expect(within(criticalSection).getByText('OpenClaw Gateway')).toBeTruthy();
    // Providers must NOT double up under Critical/Auxiliary.
    expect(within(criticalSection).queryByText('Anthropic')).toBeNull();

    const providersSection = providersHeading.closest('section') as HTMLElement;
    expect(within(providersSection).getByText('Anthropic')).toBeTruthy();

    const auxSection = auxHeading.closest('section') as HTMLElement;
    expect(within(auxSection).getByText('Cloudflare Tunnel')).toBeTruthy();

    // U47: the Live Feed dot folded into the drawer as an auxiliary row.
    await waitFor(() => {
      expect(within(auxSection).getByText('Live Feed')).toBeTruthy();
    });
  });

  it('never applies a `hidden` class at any of the three health tiers (acceptance c)', async () => {
    for (const overall of ['live', 'degraded', 'offline'] as const) {
      global.fetch = stubFetch({
        [STATUS_URL]: () => jsonResponse(fixturePayload(overall)),
      }) as unknown as typeof fetch;

      const { unmount } = render(<HealthIndicator viewerRole="operator" />);
      await waitFor(() => {
        const node = screen.getByTestId('health-indicator');
        expect(node.className).not.toMatch(/(^|\s)hidden(\s|$)/);
      });
      unmount();
      cleanup();
    }
  });

  it('"Re-run bootstrap" still works after the drawer\'s regrouping change (acceptance e)', async () => {
    const bootstrapFetchCalls: { method?: string }[] = [];

    // Minimal SSE-shaped ReadableStream reader: one `complete` event, then
    // done. Matches the exact parsing BootstrapModal.startStream() does
    // (split on the blank-line SSE separator).
    const sseText =
      'event: stdout\ndata: [bootstrap] starting...\n\n' +
      'event: complete\ndata: {"exitCode":0,"durationMs":42}\n\n';
    const encoder = new TextEncoder();
    const chunk = encoder.encode(sseText);
    let served = false;
    const reader = {
      read: async () => {
        if (!served) {
          served = true;
          return { value: chunk, done: false };
        }
        return { value: undefined, done: true };
      },
    };

    global.fetch = stubFetch({
      [STATUS_URL]: () => jsonResponse(fixturePayload('live')),
      [FEED_URL]: () => jsonResponse({ events: [], client: null, source: 'local_db' }),
      [BOOTSTRAP_URL]: () => {
        bootstrapFetchCalls.push({ method: 'POST' });
        return {
          ok: true,
          body: { getReader: () => reader },
        } as unknown as Response;
      },
    }) as unknown as typeof fetch;

    render(<HealthIndicator viewerRole="operator" />);
    await waitFor(() => screen.getByText('Online'));
    fireEvent.click(screen.getByTestId('health-indicator'));
    await waitFor(() => screen.getByText('System Status'));

    const rerunButton = screen.getByRole('button', { name: /re-run bootstrap/i });
    fireEvent.click(rerunButton);

    await waitFor(() => {
      expect(bootstrapFetchCalls.length).toBe(1);
    });
    await waitFor(() => {
      expect(screen.getByText(/Bootstrap completed in/)).toBeTruthy();
    });
  });
});
