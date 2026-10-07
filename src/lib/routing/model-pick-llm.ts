/**
 * The box's own LLM path for the routing model pick (and the semantic tie-break).
 *
 * It reuses what the Command Center already uses in production for model calls (the QC judge in
 * qc-scorer.ts): the registered provider connectors' `chatCompletion`, the CLIENT-OWNED key found by
 * `resolveProviderApiKey` (process env, `.env.local`, `~/.openclaw/secrets/.env` and the other OpenClaw
 * stores), and the box's own configured model chain from openclaw.json (`resolveBoxDefaultModelChain`).
 * No provider, endpoint or key is chosen here and no new key exists. `TIEBREAK_MODEL`, when set, is tried first.
 *
 * Small and fast: among the models the box already has, a name that says flash / mini / lite / fast / small /
 * haiku / turbo is tried first. A router-prefixed or unknown-provider entry (e.g. `agnes/...`) is skipped.
 * `ollama/<x>:cloud` uses the client's Ollama Cloud key when one resolves, and otherwise the box's local
 * Ollama daemon (which is signed in to Ollama Cloud and needs no key); a plain local tag uses the daemon.
 *
 * Bounded: each attempt is raced against the caller's budget; on error or timeout the next candidate is tried
 * (at most 2 attempts inside the one budget), and then the caller falls to its next step. Never throws.
 */
import { resolveBoxDefaultModelChain } from '@/lib/runtime-model';
import type { TiebreakRequest } from './tiebreak-adapter';

const SMALL_FAST = /flash|mini|lite|fast|small|haiku|turbo/i;
const MAX_ATTEMPTS = 2;

export interface PickTarget { slug: string; native: string; modelId: string }

function isCloudTag(id: string): boolean {
  const s = id.trim().toLowerCase();
  return s.includes(':cloud') || s.endsWith('-cloud');
}

/** Candidate (provider, model) targets from the box's own configuration, small and fast first. */
export async function resolvePickTargets(env: NodeJS.ProcessEnv = process.env): Promise<PickTarget[]> {
  const { getProvider } = await import('@/lib/model-providers');
  const { resolveProviderApiKey } = await import('@/lib/provider-key-detection');
  const raw: string[] = [];
  const named = env.TIEBREAK_MODEL?.trim();
  if (named) raw.push(named);
  for (const m of resolveBoxDefaultModelChain()) if (!raw.includes(m)) raw.push(m);

  const usable = (slug: string): boolean => {
    const p = getProvider(slug);
    if (!p || typeof p.chatCompletion !== 'function') return false;
    const k = resolveProviderApiKey(p);
    return 'localEndpoint' in k || (k.found === true && !!k.value);
  };
  const out: PickTarget[] = [];
  const add = (slug: string, native: string) => {
    const modelId = `${slug}/${native}`;
    if (!out.some((t) => t.modelId === modelId) && usable(slug)) out.push({ slug, native, modelId });
  };
  for (const entry of raw) {
    const i = entry.indexOf('/');
    const head = i > 0 ? entry.slice(0, i) : '';
    const rest = i > 0 ? entry.slice(i + 1) : entry;
    if (head === 'ollama' || head === '' ) {
      if (isCloudTag(rest)) { add('ollama-cloud', rest); add('ollama-local', rest); } else add('ollama-local', rest);
    } else if (getProvider(head)) {
      add(head, rest);
    } else if (isCloudTag(entry.slice(entry.lastIndexOf('/') + 1))) {
      const leaf = entry.slice(entry.lastIndexOf('/') + 1);
      add('ollama-cloud', leaf); add('ollama-local', leaf);
    }
  }
  // Stable: small/fast names first, the box's own order otherwise.
  return [...out.filter((t) => SMALL_FAST.test(t.native)), ...out.filter((t) => !SMALL_FAST.test(t.native))];
}

/** The model id shown in permission and provenance (null when the box has no usable model). */
export async function resolvePickModel(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  try { return (await resolvePickTargets(env))[0]?.modelId ?? null; } catch { return null; }
}

/** `TiebreakRequest.complete` backed by the box's connectors. Throws only so the adapter can record why. */
export const completeViaBoxModels: NonNullable<TiebreakRequest['complete']> = async ({ messages, maxTokens, budgetMs }) => {
  const { getProvider } = await import('@/lib/model-providers');
  const { resolveProviderApiKey } = await import('@/lib/provider-key-detection');
  const targets = (await resolvePickTargets()).slice(0, MAX_ATTEMPTS);
  if (targets.length === 0) throw new Error('no usable model on this box');
  const deadline = Date.now() + budgetMs;
  let lastErr: unknown = null;
  for (const t of targets) {
    const left = deadline - Date.now();
    if (left <= 250) break;
    const provider = getProvider(t.slug)!;
    if (process.env.ROUTING_PICK_TRACE === '1') console.log(`[model-pick] via ${t.modelId}`);
    const k = resolveProviderApiKey(provider);
    const apiKey = 'found' in k && k.found ? (k.value ?? '') : '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const resp = await Promise.race([
        provider.chatCompletion!(apiKey, { model: t.native, messages, max_tokens: maxTokens, temperature: 0 }),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`model pick timed out after ${budgetMs}ms`)), left); }),
      ]);
      const text = resp.choices?.[0]?.message?.content?.trim();
      if (text) return text;
      lastErr = new Error(`empty reply from ${t.modelId}`);
    } catch (err) {
      lastErr = err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('model pick failed');
};
