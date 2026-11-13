/**
 * Model provider probes — confirms each configured external LLM provider is
 * reachable. We only check providers whose API key is set in the environment.
 * Providers without keys are surfaced as `unknown` so the operator can see
 * what is configured at a glance without false-red alarms.
 *
 * Each `pingUrl` is a GET address documented by the provider itself that either
 * lists models or reports health; the documentation link sits on the line above
 * it. A provider that documents neither has no `pingUrl` at all and reports
 * `unknown` with `probe: 'not available for this provider'` instead of guessing
 * an address (it still never turns the status panel red).
 *
 * Per PRD 3.12: OpenRouter, Anthropic, OpenAI, Google, Z.AI, Moonshot,
 * MiniMax, Kie.ai, Fal.ai, Ollama Cloud.
 */

import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

interface ProviderSpec {
  component: string;
  label: string;
  keyEnv: string;
  // Documented GET address (models list or health), or absent when the
  // provider documents neither. A function is used where the address can be
  // overridden at call time (Moonshot's base URL).
  pingUrl?: string | (() => string);
  // How to format the auth header when a key is present.
  authHeader?: (key: string) => Record<string, string>;
}

/** Configured-provider results are reused for ten minutes (CC-009). */
const CACHE_TTL_MS = 10 * 60 * 1000;
const probeCache = new Map<string, { at: number; result: ProbeResult }>();

/** Test-only: drop the per-provider memo. */
export function __resetProviderProbeCache(): void {
  probeCache.clear();
}

const PROVIDERS: ProviderSpec[] = [
  {
    component: 'provider_openrouter',
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    // Docs: https://openrouter.ai/docs/api-reference/list-available-models
    pingUrl: 'https://openrouter.ai/api/v1/models',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    component: 'provider_anthropic',
    label: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    // Docs: https://platform.claude.com/docs/en/api/models-list
    pingUrl: 'https://api.anthropic.com/v1/models',
    authHeader: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
  },
  {
    component: 'provider_openai',
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    // Docs: https://platform.openai.com/docs/api-reference/models/list
    pingUrl: 'https://api.openai.com/v1/models',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    component: 'provider_google',
    label: 'Google',
    keyEnv: 'GOOGLE_API_KEY',
    // Docs: https://ai.google.dev/api/models (models.list)
    pingUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    authHeader: (k) => ({ 'x-goog-api-key': k }),
  },
  {
    // No models-list or health GET is documented: the API reference shows only
    // POST chat completions and the OpenAPI spec has no /models or /health.
    // Docs checked: https://docs.z.ai/api-reference
    component: 'provider_zai',
    label: 'Z.AI',
    keyEnv: 'ZAI_API_KEY',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    component: 'provider_moonshot',
    label: 'Moonshot',
    keyEnv: 'MOONSHOT_API_KEY',
    // Docs: https://platform.kimi.ai/docs/api/models — GET /v1/models on the
    // international base https://api.moonshot.ai/v1. MOONSHOT_BASE_URL, when
    // set, is that same API base (version path included) and wins.
    pingUrl: () => {
      const base = process.env.MOONSHOT_BASE_URL;
      if (!base) return 'https://api.moonshot.ai/v1/models';
      return `${base.replace(/\/+$/, '')}/models`;
    },
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    component: 'provider_minimax',
    label: 'MiniMax',
    keyEnv: 'MINIMAX_API_KEY',
    // Docs: https://platform.minimax.io/docs/api-reference/models/openai/list-models
    pingUrl: 'https://api.minimax.io/v1/models',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    // No health or models-list GET is documented: the API index lists task,
    // upload and credit endpoints only. Docs checked: https://docs.kie.ai/
    component: 'provider_kieai',
    label: 'Kie.ai',
    keyEnv: 'KIEAI_API_KEY',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    component: 'provider_falai',
    label: 'Fal.ai',
    keyEnv: 'FAL_API_KEY',
    // Docs: https://fal.ai/docs/platform-apis/v1/models
    pingUrl: 'https://api.fal.ai/v1/models',
    authHeader: (k) => ({ Authorization: `Key ${k}` }),
  },
  {
    component: 'provider_ollama_cloud',
    label: 'Ollama Cloud',
    keyEnv: 'OLLAMA_API_KEY',
    // Docs: https://docs.ollama.com/api/tags — cloud base https://ollama.com/api
    pingUrl: 'https://ollama.com/api/tags',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
];

async function probeOne(spec: ProviderSpec): Promise<ProbeResult> {
  const start = Date.now();
  const key = process.env[spec.keyEnv];

  // The "no key" path is never cached: a key added later must be seen at once.
  if (!key) {
    return {
      component: spec.component,
      label: spec.label,
      status: 'unknown',
      latencyMs: null,
      detail: { configured: false, keyEnv: spec.keyEnv },
      probedAt: new Date().toISOString(),
    };
  }

  const cached = probeCache.get(spec.component);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  const remember = (result: ProbeResult): ProbeResult => {
    probeCache.set(spec.component, { at: Date.now(), result });
    return result;
  };

  const pingUrl =
    typeof spec.pingUrl === 'function' ? spec.pingUrl() : spec.pingUrl;
  if (!pingUrl) {
    return remember({
      component: spec.component,
      label: spec.label,
      status: 'unknown',
      latencyMs: null,
      detail: { configured: true, probe: 'not available for this provider' },
      probedAt: new Date().toISOString(),
    });
  }

  return remember(
    await withTimeout<ProbeResult>(
      async () => {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS - 100);
          const headers = spec.authHeader ? spec.authHeader(key) : {};
          let res: Response;
          try {
            res = await fetch(pingUrl, {
              method: 'GET',
              headers,
              signal: controller.signal,
            });
          } finally {
            clearTimeout(t);
          }

          const latencyMs = Date.now() - start;
          // 2xx is live, 401/403 means reachable but key is invalid (degraded),
          // 5xx and 429 from upstream are degraded, anything else is live since
          // the host responded.
          let status: ProbeResult['status'] = 'live';
          let error: string | undefined;
          if (res.status === 401 || res.status === 403) {
            status = 'degraded';
            error = `auth rejected (HTTP ${res.status})`;
          } else if (res.status === 429) {
            status = 'busy';
            error = 'rate limited';
          } else if (res.status >= 500) {
            status = 'degraded';
            error = `upstream HTTP ${res.status}`;
          }

          return {
            component: spec.component,
            label: spec.label,
            status,
            latencyMs,
            error,
            detail: {
              configured: true,
              httpStatus: res.status,
            },
            probedAt: new Date().toISOString(),
          };
        } catch (err) {
          return {
            component: spec.component,
            label: spec.label,
            status: 'offline',
            latencyMs: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
            detail: { configured: true },
            probedAt: new Date().toISOString(),
          };
        }
      },
      PROBE_TIMEOUT_MS,
      () => ({
        component: spec.component,
        label: spec.label,
        status: 'offline',
        latencyMs: Date.now() - start,
        error: 'probe timed out',
        detail: { configured: true },
        probedAt: new Date().toISOString(),
      })
    )
  );
}

export async function probeModelProviders(): Promise<ProbeResult[]> {
  return Promise.all(PROVIDERS.map(probeOne));
}
