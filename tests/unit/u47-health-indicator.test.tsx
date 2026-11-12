/**
 * U47 — ONE <HealthIndicator/>, operator/client variants, mobile-visible.
 * U-06 (CC-004, CC-020, CC-022, CC-036) — the client variant speaks plain
 * English: a button that opens a small reasons panel; the operator drawer is
 * no longer reachable from the shared Header.
 *
 * Renders the REAL components (react-dom via @testing-library/react +
 * jsdom — see vitest.component.config.ts), never a hand-rolled restatement.
 * `global.fetch` is stubbed per-test; every stub throws on an unlisted URL so
 * a regression that adds a second/different endpoint call is caught by the
 * ACTUAL component's actual effect.
 *
 * Acceptance covered:
 *   (a) exactly one [data-testid="health-indicator"] node per tree;
 *   (b) the client surface leaks no probe id / component name / error string;
 *   (c) the badge never applies a `hidden` class at any tier;
 *   U-06 — clean payload reads "All systems working"; a gateway outage reads
 *   "Needs attention" and names the gateway in plain words after a click;
 *   Header renders the client variant and nothing with
 *   data-viewer-role="operator".
 *
 * npx vitest run --config vitest.component.config.ts
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent, act } from '@testing-library/react';

import { HealthIndicator } from '../../src/components/HealthIndicator';
import { Header } from '../../src/components/Header';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

afterEach(() => { cleanup(); vi.useRealTimers(); });

const STATUS_URL = '/api/system/status';
const FEED_URL = '/api/events/client-feed?limit=1';

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
    if (url === '/api/health' && !handlers[url]) return jsonResponse({ status: 'ok', embeddings: { status: 'ok', degraded: false } });
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

describe('HealthIndicator — client variant (U-06)', () => {
  it('reads "All systems working" for a clean payload and opens the all-normal panel', async () => {
    global.fetch = stubFetch({
      [STATUS_URL]: () => jsonResponse(fixturePayload('live')),
    }) as unknown as typeof fetch;

    render(<HealthIndicator viewerRole="client" />);

    await waitFor(() => expect(screen.getByTestId('health-indicator').textContent).toBe('All systems working'));

    const nodes = screen.getAllByTestId('health-indicator');
    expect(nodes).toHaveLength(1);
    const button = nodes[0];
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    const dialog = screen.getByRole('dialog', { name: 'System status details' });
    expect(within(dialog).getByText('Everything is running normally.')).toBeTruthy();
    expect(within(dialog).getByText(/^Checked at /)).toBeTruthy();
  });

  it('reads "Needs attention" and names the gateway in plain words when that row is offline', async () => {
    const status = fixturePayload('degraded');
    status.components[1].status = 'offline';
    status.components[1].error = 'unauthorized_401: gateway rejected token';
    global.fetch = stubFetch({ [STATUS_URL]: () => jsonResponse(status) }) as unknown as typeof fetch;

    render(<HealthIndicator viewerRole="client" />);

    await waitFor(() => expect(screen.getByTestId('health-indicator').textContent).toBe('Needs attention'));
    fireEvent.click(screen.getByTestId('health-indicator'));

    const dialog = screen.getByRole('dialog', { name: 'System status details' });
    expect(within(dialog).getByText("Your AI team can't be reached right now")).toBeTruthy();
    expect(
      within(dialog).getByText('New tasks will wait safely and start on their own once the connection is back.')
    ).toBeTruthy();

    // Never a probe id, component name, or raw error string.
    const text = (screen.getByTestId('health-indicator').parentElement?.textContent ?? '') + dialog.textContent;
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
  });

  it('closes the panel on Escape', async () => {
    global.fetch = stubFetch({ [STATUS_URL]: () => jsonResponse(fixturePayload('live')) }) as unknown as typeof fetch;
    render(<HealthIndicator viewerRole="client" />);
    await waitFor(() => screen.getByText('All systems working'));

    fireEvent.click(screen.getByTestId('health-indicator'));
    expect(screen.getByRole('dialog', { name: 'System status details' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'System status details' })).toBeNull());
  });

  it('never applies a `hidden` class at any of the three health tiers (acceptance c)', async () => {
    for (const overall of ['live', 'degraded', 'offline'] as const) {
      global.fetch = stubFetch({ [STATUS_URL]: () => jsonResponse(fixturePayload(overall)) }) as unknown as typeof fetch;

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

  it('never opens the operator drawer', async () => {
    global.fetch = stubFetch({ [STATUS_URL]: () => jsonResponse(fixturePayload('live')) }) as unknown as typeof fetch;
    render(<HealthIndicator viewerRole="client" />);
    await waitFor(() => screen.getByText('All systems working'));

    fireEvent.click(screen.getByTestId('health-indicator'));
    expect(screen.queryByText('System Status')).toBeNull();
  });
});

describe('Header — the client badge, never the operator drawer (U-06)', () => {
  it('renders the client variant and no data-viewer-role="operator" element', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === STATUS_URL) return jsonResponse(fixturePayload('live'));
      if (url === '/api/health') return jsonResponse({ status: 'ok', embeddings: { status: 'ok', degraded: false } });
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const { container } = render(<Header />);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="health-indicator"]')?.textContent).toBe('All systems working');
    });
    expect(container.querySelector('[data-viewer-role="client"]')).not.toBeNull();
    expect(container.querySelector('[data-viewer-role="operator"]')).toBeNull();
  });
});

describe('HealthIndicator — operator variant', () => {
  it('is clickable and opens the drawer, grouped by Critical / Auxiliary / Model Providers (U46 tier)', async () => {
    global.fetch = stubFetch({
      [STATUS_URL]: () => jsonResponse(fixturePayload('offline')),
      [FEED_URL]: () => jsonResponse({ events: [], client: null, source: 'local_db' }),
    }) as unknown as typeof fetch;

    render(<HealthIndicator viewerRole="operator" />);
    await waitFor(() => screen.getByText('Unavailable'));

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

  it('keeps the operator wording and never applies a `hidden` class at any tier (acceptance c)', async () => {
    for (const overall of ['live', 'degraded', 'offline'] as const) {
      global.fetch = stubFetch({ [STATUS_URL]: () => jsonResponse(fixturePayload(overall)) }) as unknown as typeof fetch;

      const { unmount } = render(<HealthIndicator viewerRole="operator" />);
      await waitFor(() => {
        const node = screen.getByTestId('health-indicator');
        expect(node.className).not.toMatch(/(^|\s)hidden(\s|$)/);
      });
      unmount();
      cleanup();
    }
  });
});

describe('FIX47 — readiness is truthful across client and board indicators', () => {
  const ready = { status: 'ok', embeddings: { status: 'ok', degraded: false } };
  for (const [name, system, health, expected] of [
    ['healthy', fixturePayload('live'), ready, 'All systems working'],
    ['embedding degradation in HTTP 200', fixturePayload('live'), { status: 'ok', embeddings: { status: 'degraded', degraded: true } }, 'Needs attention'],
    ['migration degradation', fixturePayload('live'), { ...ready, status: 'degraded' }, 'Needs attention'],
    ['disconnected gateway', fixturePayload('offline'), ready, 'Offline'],
    ['unknown overall', { ...fixturePayload('live'), overall: 'unknown' }, ready, 'Status not available'],
    ['malformed status', {}, ready, 'Status not available'],
    ['empty subsystem results', { ...fixturePayload('live'), components: [] }, ready, 'Status not available'],
    ['missing embedding result', fixturePayload('live'), { status: 'ok' }, 'Status not available'],
  ] as const) {
    it(name, async () => {
      global.fetch = stubFetch({ [STATUS_URL]: () => jsonResponse(system), '/api/health': () => jsonResponse(health) }) as typeof fetch;
      render(<><HealthIndicator viewerRole="client" /><HealthIndicator viewerRole="client" /><HealthIndicator viewerRole="operator" /></>);
      await waitFor(() => {
        const indicators = screen.getAllByTestId('health-indicator');
        expect(indicators).toHaveLength(3);
        expect(indicators[0].textContent).toBe(expected);
        expect(indicators[1].textContent).toBe(expected);
      });
      expect(screen.queryByText('All systems operational')).toBeNull();
    });
  }

  it('does not trust live overall when a returned required subsystem is degraded', async () => {
    const status = fixturePayload('live');
    status.components[1].status = 'degraded';
    global.fetch = stubFetch({ [STATUS_URL]: () => jsonResponse(status) }) as typeof fetch;
    render(<HealthIndicator viewerRole="client" />);
    await waitFor(() => expect(screen.getByTestId('health-indicator').textContent).toBe('Needs attention'));
  });

  it('clears stale healthy state on an HTTP error and recovers only on a verified result', async () => {
    vi.useFakeTimers();
    let response = jsonResponse(fixturePayload('live'));
    global.fetch = stubFetch({ [STATUS_URL]: () => response }) as typeof fetch;
    await act(async () => { render(<HealthIndicator viewerRole="client" />); });
    expect(screen.getByTestId('health-indicator').textContent).toBe('All systems working');
    response = jsonResponse({}, false);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByTestId('health-indicator').textContent).toBe('Offline');
    response = jsonResponse({});
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByTestId('health-indicator').textContent).toBe('Status not available');
    response = jsonResponse(fixturePayload('live'));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByTestId('health-indicator').textContent).toBe('All systems working');
  });

  it('times out a hanging response, ignores its late success, then recovers on the next poll', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    let hanging = true;
    const slow = new Promise<Response>((resolve) => { finish = resolve; });
    global.fetch = stubFetch({ [STATUS_URL]: () => hanging ? slow : jsonResponse(fixturePayload('live')) }) as typeof fetch;
    await act(async () => { render(<HealthIndicator viewerRole="client" />); });
    expect(screen.getByTestId('health-indicator').textContent).toBe('Checking…');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByTestId('health-indicator').textContent).toBe('Offline');
    await act(async () => { finish(jsonResponse(fixturePayload('live'))); });
    expect(screen.getByTestId('health-indicator').textContent).toBe('Offline');
    hanging = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByTestId('health-indicator').textContent).toBe('All systems working');
  });

  it('does not clear degraded readiness until the embedding check also recovers', async () => {
    vi.useFakeTimers();
    let resolveHealth!: (response: Response) => void;
    let health: Response | Promise<Response> = jsonResponse({ status: 'ok', embeddings: { status: 'degraded', degraded: true } });
    global.fetch = stubFetch({ [STATUS_URL]: () => jsonResponse(fixturePayload('live')), '/api/health': () => health }) as typeof fetch;
    await act(async () => { render(<HealthIndicator viewerRole="client" />); });
    expect(screen.getByTestId('health-indicator').textContent).toBe('Needs attention');
    health = new Promise<Response>((resolve) => { resolveHealth = resolve; });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByTestId('health-indicator').textContent).toBe('Needs attention');
    await act(async () => { resolveHealth(jsonResponse(ready)); });
    expect(screen.getByTestId('health-indicator').textContent).toBe('All systems working');
  });

  it('reports network errors without claiming healthy', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    render(<HealthIndicator viewerRole="client" />);
    await waitFor(() => expect(screen.getByTestId('health-indicator').textContent).toBe('Offline'));
  });
});
