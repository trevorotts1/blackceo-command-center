/**
 * Model provider probes — confirms each configured external LLM provider is
 * reachable. We only check providers whose API key is set in the environment.
 * Providers without keys are surfaced as `unknown` so the operator can see
 * what is configured at a glance without false-red alarms.
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
  // URL that returns 200 (or 401 with a valid key shape) when reachable.
  pingUrl: string;
  // How to format the auth header when a key is present.
  authHeader?: (key: string) => Record<string, string>;
}

const PROVIDERS: ProviderSpec[] = [
  {
    component: 'provider_openrouter',
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    pingUrl: 'https://openrouter.ai/api/v1/models',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    component: 'provider_anthropic',
    label: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    pingUrl: 'https://api.anthropic.com/v1/models',
    authHeader: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
  },
  {
    component: 'provider_openai',
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    pingUrl: 'https://api.openai.com/v1/models',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    component: 'provider_google',
    label: 'Google',
    keyEnv: 'GOOGLE_API_KEY',
    pingUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    authHeader: (k) => ({ 'x-goog-api-key': k }),
  },
  {
    component: 'provider_zai',
    label: 'Z.AI',
    keyEnv: 'ZAI_API_KEY',
    pingUrl: 'https://api.z.ai/v1/models',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    component: 'provider_moonshot',
    label: 'Moonshot',
    keyEnv: 'MOONSHOT_API_KEY',
    pingUrl: 'https://api.moonshot.cn/v1/models',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    component: 'provider_minimax',
    label: 'MiniMax',
    keyEnv: 'MINIMAX_API_KEY',
    pingUrl: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    component: 'provider_kieai',
    label: 'Kie.ai',
    keyEnv: 'KIEAI_API_KEY',
    pingUrl: 'https://api.kie.ai/v1/health',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    component: 'provider_falai',
    label: 'Fal.ai',
    keyEnv: 'FAL_API_KEY',
    pingUrl: 'https://fal.run/health',
    authHeader: (k) => ({ Authorization: `Key ${k}` }),
  },
  {
    component: 'provider_ollama_cloud',
    label: 'Ollama Cloud',
    keyEnv: 'OLLAMA_API_KEY',
    pingUrl: 'https://ollama.com/api/version',
    authHeader: (k) => ({ Authorization: `Bearer ${k}` }),
  },
];

async function probeOne(spec: ProviderSpec): Promise<ProbeResult> {
  const start = Date.now();
  const key = process.env[spec.keyEnv];

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

  return withTimeout<ProbeResult>(
    async () => {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS - 100);
        const headers = spec.authHeader ? spec.authHeader(key) : {};
        let res: Response;
        try {
          res = await fetch(spec.pingUrl, {
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
  );
}

export async function probeModelProviders(): Promise<ProbeResult[]> {
  return Promise.all(PROVIDERS.map(probeOne));
}
