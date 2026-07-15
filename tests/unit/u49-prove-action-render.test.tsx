/**
 * U49 / U61 (H+L.7) — the "Prove" action's visible outcome on the real
 * <IntelligenceProviderList/> component.
 *
 * THE BUG THIS LOCKS DOWN: pre-U49, `handleProve()` awaited the POST to
 * `/api/models/provider-status/prove` without ever checking `res.ok`, and
 * its `catch` block was a comment-only swallow — every HTTP-level or
 * network-level failure was SILENT (the tile just stayed in whatever state
 * it was already in, with no indication the click did anything). This suite
 * renders the REAL component (react-dom via @testing-library/react + jsdom
 * — see vitest.component.config.ts) and proves all three outcomes are now
 * VISIBLE, never silent, and fail-closed (a failure never renders as if it
 * were a success):
 *   1. verify-PASS  — the prove route returns `{ok:true}` -> a visible
 *      emerald success message renders.
 *   2. verify-FAIL  — the prove route returns HTTP 200 with `{ok:false,...}`
 *      (the authenticated call itself failed, e.g. a rejected key) -> a
 *      visible red failure message renders, carrying the detail.
 *   3. HTTP-level failure — the prove route itself 500s -> a visible red
 *      failure message renders (the former silent swallow is gone).
 *   4. network-level failure — `fetch` throws -> a visible red failure
 *      message renders (fail-closed: a thrown error must never be read as
 *      an implicit success).
 *
 * npx vitest run --config vitest.component.config.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

import { IntelligenceProviderList } from '../../src/components/settings/IntelligenceProviderList';

afterEach(() => cleanup());

const CLIENTS_URL = '/api/clients';
const ENV_AUDIT_URL = '/api/models/env-audit';
const PROVIDER_STATUS_URL = '/api/models/provider-status';
const PROVE_URL = '/api/models/provider-status/prove';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function providerStatusFixture(overrides: Partial<{ configured: boolean; proven: boolean }> = {}) {
  return {
    providers: [
      {
        slug: 'replicate',
        displayName: 'Replicate',
        authType: 'api_key',
        configured: overrides.configured ?? true,
        foundEnvVar: 'REPLICATE_API_TOKEN',
        foundInStore: 'process.env',
        envCandidates: ['REPLICATE_API_TOKEN', 'REPLICATE_API_KEY'],
        authProof: {
          proven: overrides.proven ?? false,
          stale: false,
          method: null,
          provenAt: null,
        },
      },
    ],
    integrations: [],
    generated_at: '2026-07-15T00:00:00.000Z',
  };
}

/** Stub `fetch` for the mount-time calls every render needs, plus one
 * caller-supplied handler for the prove POST itself. Throws on anything
 * unlisted so a regression that adds/changes a call is caught loudly. */
function stubFetchForProveTest(proveHandler: () => Promise<Response> | Response): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith(CLIENTS_URL)) {
      return jsonResponse({ clients: [{ id: 'self', name: 'This box', is_self: true }], selected_id: 'self' });
    }
    if (url.startsWith(ENV_AUDIT_URL) && (!init || init.method === undefined)) {
      return jsonResponse({ suggestions: [] });
    }
    // PROVE_URL is a sub-path of PROVIDER_STATUS_URL
    // ('/api/models/provider-status/prove' startsWith
    // '/api/models/provider-status') — it MUST be checked first or every
    // prove POST would be silently misrouted to the status fixture.
    if (url.startsWith(PROVE_URL)) {
      return proveHandler();
    }
    if (url.startsWith(PROVIDER_STATUS_URL)) {
      return jsonResponse(providerStatusFixture());
    }
    throw new Error(`unstubbed fetch in U49 prove-action test: ${init?.method ?? 'GET'} ${url}`);
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

async function renderAndOpenProve() {
  render(<IntelligenceProviderList refreshLog={[]} providers={['replicate']} />);
  const proveButton = await screen.findByRole('button', { name: /prove/i });
  return proveButton;
}

describe('[U49] Prove action — every outcome is visible, never silently swallowed', () => {
  it('verify-PASS: prove route returns {ok:true} -> a visible success message renders', async () => {
    const restore = stubFetchForProveTest(() =>
      jsonResponse({ slug: 'replicate', ok: true, method: 'verify_key', modelId: null, detail: null, provenAt: '2026-07-15T00:00:00.000Z' }),
    );
    try {
      const proveButton = await renderAndOpenProve();
      fireEvent.click(proveButton);

      await waitFor(() => {
        expect(screen.getByText(/proven via verifyKey/i)).toBeTruthy();
      });
    } finally {
      restore();
    }
  });

  it('verify-FAIL: prove route returns HTTP 200 {ok:false} (rejected key) -> a visible failure message renders, never a silent success', async () => {
    const restore = stubFetchForProveTest(() =>
      jsonResponse({
        slug: 'replicate',
        ok: false,
        method: 'verify_key',
        modelId: null,
        detail: '401 Unauthorized — invalid token',
        provenAt: '2026-07-15T00:00:00.000Z',
      }),
    );
    try {
      const proveButton = await renderAndOpenProve();
      fireEvent.click(proveButton);

      await waitFor(() => {
        expect(screen.getByText(/401 Unauthorized/i)).toBeTruthy();
      });
      expect(screen.queryByText(/proven via/i)).toBeNull();
    } finally {
      restore();
    }
  });

  it('HTTP-level failure: prove route 500s -> a visible failure message renders (the former silent-swallow catch is gone)', async () => {
    const restore = stubFetchForProveTest(() => jsonResponse({ error: 'Prove failed', message: 'internal error' }, { status: 500 }));
    try {
      const proveButton = await renderAndOpenProve();
      fireEvent.click(proveButton);

      await waitFor(() => {
        expect(screen.getByText(/internal error/i)).toBeTruthy();
      });
    } finally {
      restore();
    }
  });

  it('network-level failure: fetch throws -> fail-closed, a visible failure message renders (never read as success)', async () => {
    const restore = stubFetchForProveTest(() => {
      throw new Error('network disabled for test');
    });
    try {
      const proveButton = await renderAndOpenProve();
      fireEvent.click(proveButton);

      await waitFor(() => {
        expect(screen.getByText(/network disabled for test/i)).toBeTruthy();
      });
      expect(screen.queryByText(/proven via/i)).toBeNull();
    } finally {
      restore();
    }
  });
});
