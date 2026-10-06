/**
 * Retired Ollama Cloud model ids -> live successor. Ollama Cloud retired the
 * deepseek-v4-flash builds (`:cloud`, `:0731`, `:0731-cloud`, bare under an
 * ollama prefix) on 2026-09-25 (HTTP 410); `deepseek-v4.1-flash:cloud` is live.
 * DeepSeek DIRECT (`deepseek/…`, `ds/…`) and OpenRouter ids are other
 * providers and are NOT touched.
 */
export const LIVE_DEEPSEEK_FLASH_TAG = 'deepseek-v4.1-flash:cloud';

const RETIRED_RE = /^(?:(ollama-cloud|ollama)\/)?deepseek-v4-flash(?::(?:cloud|0731|0731-cloud))?$/i;

/** Returns the successor id (prefix preserved) when `id` is a retired Ollama deepseek-v4-flash id, else `id` unchanged. */
export function successorModelId<T extends string | null | undefined>(id: T): T | string {
  if (!id) return id;
  const t = id.trim();
  const m = RETIRED_RE.exec(t);
  if (!m) return id;
  const hasTag = t.includes(':');
  // bare `deepseek-v4-flash` with no ollama prefix and no tag is ambiguous (could be a direct id)
  if (!m[1] && !hasTag) return id;
  return `${m[1] ? `${m[1].toLowerCase()}/` : ''}${LIVE_DEEPSEEK_FLASH_TAG}`;
}

export function isRetiredOllamaDeepseekFlash(id: string | null | undefined): boolean {
  return !!id && successorModelId(id) !== id;
}
