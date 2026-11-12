/**
 * tests/unit/provider-probe-policy.test.ts
 *
 * U-05a — provider probes are cached, sourced and honest:
 *  - a configured provider is fetched at most once per ten minutes
 *  - a provider with no key is never fetched and never cached
 *  - MOONSHOT_BASE_URL overrides the documented international address
 *
 * `fetch` is stubbed; nothing here touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetProviderProbeCache,
  probeModelProviders,
} from '../../src/lib/probes/model-providers';

const PROVIDER_ENV_KEYS = [
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'ZAI_API_KEY',
  'MOONSHOT_API_KEY',
  'MINIMAX_API_KEY',
  'KIEAI_API_KEY',
  'FAL_API_KEY',
  'OLLAMA_API_KEY',
  'MOONSHOT_BASE_URL',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of PROVIDER_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  __resetProviderProbeCache();
});

afterEach(() => {
  for (const key of PROVIDER_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  __resetProviderProbeCache();
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('provider probe cache', () => {
  it('probes a configured provider once across two calls inside ten minutes', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const fetchMock = stubFetch();

    await probeModelProviders();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await probeModelProviders();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('performs zero fetches when no provider key is set', async () => {
    const fetchMock = stubFetch();

    const results = await probeModelProviders();
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(results.every((r) => r.status === 'unknown')).toBe(true);

    await probeModelProviders();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('honours MOONSHOT_BASE_URL over the documented international address', async () => {
    process.env.MOONSHOT_API_KEY = 'test-key';
    process.env.MOONSHOT_BASE_URL = 'https://moonshot.example/v1/';
    const fetchMock = stubFetch();

    await probeModelProviders();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain('https://moonshot.example/v1/models');
  });

  it('uses the documented international Moonshot address when the override is unset', async () => {
    process.env.MOONSHOT_API_KEY = 'test-key';
    const fetchMock = stubFetch();

    await probeModelProviders();

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain('https://api.moonshot.ai/v1/models');
  });
});
