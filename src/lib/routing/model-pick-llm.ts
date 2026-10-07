/**
 * The box's own LLM path for the routing model pick (and the semantic tie-break).
 *
 * A FIXED provider chain (Trevor 2026-10-07), each hop used only when the box has that provider configured
 * with its OWN key (resolveProviderApiKey: process env, `.env.local`, `~/.openclaw/secrets/.env` and the other
 * OpenClaw stores), through the registered provider connectors' `chatCompletion`:
 *   1. glm-5.3-flash:cloud via Ollama Cloud (the client's Ollama Cloud key when one resolves, otherwise the
 *      box's local Ollama daemon, which is signed in to Ollama Cloud and needs no key: still ONE hop);
 *   2. the OpenRouter equivalent, z-ai/glm-5.3-flash;
 *   3. the latest Agnes, agnes-3.0-flash (bump PICK_CHAIN when a newer one ships).
 * Then the caller falls to General Task. No name-based reordering, no model list read from openclaw.json, no
 * operator key. `TIEBREAK_MODEL`, when set, is an override tried FIRST (provider/model, or an Ollama tag).
 *
 * Timing: GLM-5.3-Flash is slow (about 3.3 s to first token, 51 tok/s), so each hop gets PICK_HOP.timeoutMs
 * (8 s). A failed hop (error, HTTP failure, empty reply, timeout) moves to the next at once. The total is the
 * caller's budget (MODEL_PICK_TIMEOUT_MS = 3 hops x 8 s = 24 s; the model pick runs on the background dispatch
 * path, and a hop that fails fast, such as a missing key, costs nothing). Never throws past `complete`.
 * `ROUTING_PICK_TRACE=1` logs which hop answered.
 */
import type { TiebreakRequest } from './tiebreak-adapter';

/** Per-hop bound (env override is for tests). */
export const PICK_HOP = { timeoutMs: Number(process.env.PICK_HOP_TIMEOUT_MS) || 8_000 };

export interface PickTarget { slug: string; native: string; modelId: string }

/** The fixed chain, in Trevor's order. `slugs` are tried in order inside ONE hop (cloud with a key, else the local daemon). */
export const PICK_CHAIN: { slugs: string[]; native: string }[] = [
  { slugs: ['ollama-cloud', 'ollama-local'], native: 'glm-5.3-flash:cloud' },
  { slugs: ['openrouter'], native: 'z-ai/glm-5.3-flash' },
  { slugs: ['agnes'], native: 'agnes-3.0-flash' },
];

/** Usable targets, one per hop, from the box's own providers and keys. */
export async function resolvePickTargets(env: NodeJS.ProcessEnv = process.env): Promise<PickTarget[]> {
  const { getProvider } = await import('@/lib/model-providers');
  const { resolveProviderApiKey } = await import('@/lib/provider-key-detection');
  const usable = (slug: string): boolean => {
    const p = getProvider(slug);
    if (!p || typeof p.chatCompletion !== 'function') return false;
    const k = resolveProviderApiKey(p);
    return 'localEndpoint' in k || (k.found === true && !!k.value);
  };
  const out: PickTarget[] = [];
  const add = (slug: string, native: string) => { if (usable(slug)) out.push({ slug, native, modelId: `${slug}/${native}` }); };
  const named = env.TIEBREAK_MODEL?.trim();
  if (named) {
    const i = named.indexOf('/');
    const head = i > 0 ? named.slice(0, i) : '';
    const rest = i > 0 ? named.slice(i + 1) : named;
    if (head && head !== 'ollama' && getProvider(head)) add(head, rest);
    else for (const slug of rest.includes(':cloud') ? ['ollama-cloud', 'ollama-local'] : ['ollama-local']) { const n = out.length; add(slug, rest); if (out.length > n) break; }
  }
  for (const hop of PICK_CHAIN) {
    const n = out.length;
    for (const slug of hop.slugs) { add(slug, hop.native); if (out.length > n) break; }
  }
  return out.filter((t, i) => out.findIndex((u) => u.modelId === t.modelId) === i);
}

/** The model id shown in permission and provenance (null when the box has no usable model). */
export async function resolvePickModel(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try { return (await resolvePickTargets(env))[0]?.modelId ?? null; } catch { return null; }
}

/** `TiebreakRequest.complete` backed by the box's connectors. Throws only so the adapter can record why. */
export const completeViaBoxModels: NonNullable<TiebreakRequest['complete']> = async ({ messages, maxTokens, budgetMs }) => {
  const { getProvider } = await import('@/lib/model-providers');
  const { resolveProviderApiKey } = await import('@/lib/provider-key-detection');
  const targets = await resolvePickTargets();
  if (targets.length === 0) throw new Error('no usable model on this box');
  const deadline = Date.now() + budgetMs;
  let lastErr: unknown = null;
  for (const t of targets) {
    const left = Math.min(deadline - Date.now(), PICK_HOP.timeoutMs);
    if (left <= 250) break;
    const provider = getProvider(t.slug)!;
    if (process.env.ROUTING_PICK_TRACE === '1') console.log(`[model-pick] via ${t.modelId}`);
    const k = resolveProviderApiKey(provider);
    const apiKey = 'found' in k && k.found ? (k.value ?? '') : '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const resp = await Promise.race([
        provider.chatCompletion!(apiKey, { model: t.native, messages, max_tokens: maxTokens, temperature: 0 }),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`model pick hop ${t.modelId} timed out after ${left}ms`)), left); }),
      ]);
      const text = resp.choices?.[0]?.message?.content?.trim();
      if (text) { if (process.env.ROUTING_PICK_TRACE === '1') console.log(`[model-pick] answered by ${t.modelId}`); return text; }
      lastErr = new Error(`empty reply from ${t.modelId}`);
    } catch (err) {
      lastErr = err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('model pick failed');
};
