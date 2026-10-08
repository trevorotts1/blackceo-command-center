/**
 * One short free-text completion through the intake chain's client-owned-key
 * providers (OpenRouter Luna, Ollama Cloud Minimax, Agnes). No new provider or
 * key. Throws when no step is available or every step fails / times out.
 */
import { getProvider } from '@/lib/model-providers';
import { agnesProvider } from '@/lib/model-providers/agnes';
import { minimaxProvider } from '@/lib/model-providers/minimax';
import { openrouterProvider } from '@/lib/model-providers/openrouter';
import {
  boxHasOllama, keyResolves, withTimeout,
  CHAIN_LUNA_MODEL, CHAIN_MINIMAX_MODEL, CHAIN_AGNES_MODEL, CHAIN_AGNES_FALLBACK_MODEL,
} from './chain';

export async function shortCompletion(system: string, user: string, timeoutMs = 20_000): Promise<string> {
  const cloud = getProvider('ollama-cloud');
  const steps: Array<{ baseUrl: string; models: string[]; key: string | null }> = [
    { baseUrl: 'https://openrouter.ai/api/v1', models: [CHAIN_LUNA_MODEL], key: keyResolves(openrouterProvider) },
    {
      baseUrl: 'https://ollama.com/v1', models: [CHAIN_MINIMAX_MODEL],
      key: boxHasOllama() && keyResolves(minimaxProvider) !== null && cloud ? keyResolves(cloud) : null,
    },
    { baseUrl: 'https://apihub.agnes-ai.com/v1', models: [CHAIN_AGNES_MODEL, CHAIN_AGNES_FALLBACK_MODEL], key: keyResolves(agnesProvider) },
  ];
  let lastErr: unknown = new Error('no provider key available');
  for (const s of steps) {
    if (!s.key) continue;
    for (const model of s.models) {
      try {
        const res = await withTimeout(
          fetch(`${s.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + s.key, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model, temperature: 0.2, max_tokens: 60,
              messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            }),
          }),
          timeoutMs,
        );
        if (!res.ok) throw new Error(`chat failed: ${res.status}`);
        const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const text = payload?.choices?.[0]?.message?.content?.trim();
        if (text) return text;
        throw new Error('empty completion');
      } catch (err) { lastErr = err; }
    }
  }
  throw lastErr;
}
