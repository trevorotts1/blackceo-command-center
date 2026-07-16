/**
 * SINGLE SOURCE OF TRUTH for the Ollama Cloud OpenAI-compatible base URL.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * Two call sites read the SAME env var (`OLLAMA_CLOUD_BASE_URL`) but fell back
 * to DIFFERENT defaults:
 *
 *   - `model-providers/ollama-cloud.ts`  ->  'https://ollama.com'      (correct)
 *   - `research/providers.ts`            ->  'https://ollama.com/api'  (404)
 *
 * Every consumer appends `/v1/...`, so the `/api` variant resolves to
 * `https://ollama.com/api/v1/chat/completions`, which upstream answers with
 * 404 `{"error":"path \"/api/v1/models\" not found"}`. Verified live
 * 2026-07-16: `/api/v1/models` -> HTTP 404, `/v1/models` -> HTTP 200.
 *
 * The divergence WAS the defect: one file got fixed, its twin did not. Both now
 * resolve through this module, so the class of bug cannot recur.
 *
 * WHY THE DEFAULT IS THE HOSTED URL AND NOT THE LOCAL DAEMON
 * ---------------------------------------------------------
 * A signed-in local Ollama daemon on 127.0.0.1:11434 IS a legitimate way to
 * reach Ollama Cloud: it is the authenticated conduit, and `:cloud`-tagged
 * models execute cloud-side through it (the daemon signs the request with the
 * ollama.com session; a process on 127.0.0.1 does NOT mean on-device
 * inference). Boxes that want that route set `OLLAMA_CLOUD_BASE_URL` to the
 * daemon and it works — that override is fully supported here.
 *
 * But it must NOT be the DEFAULT, because most fleet boxes are Docker/VPS with
 * no daemon at all: defaulting to loopback there yields
 * `ECONNREFUSED 127.0.0.1:11434` on every call. The safe default is the hosted
 * host, which works anywhere a key is present; the daemon stays opt-in.
 *
 * NORMALIZATION
 * -------------
 * A legacy `/api` suffix is stripped from any configured value, because every
 * consumer appends `/v1/...`. This self-heals boxes carrying the historical
 * `https://ollama.com/api` value (which `.env.example` used to recommend) and
 * is equally correct for a daemon URL: the daemon's OpenAI-compatible surface
 * is `/v1/...`, while `/api/...` is its native (non-OpenAI) surface.
 */

/** The hosted Ollama Cloud OpenAI-compatible host. Verified 200 on /v1/models. */
export const OLLAMA_CLOUD_DEFAULT_BASE_URL = 'https://ollama.com';

/**
 * Normalize a configured base URL: strip trailing slashes and a trailing
 * `/api`, since callers append `/v1/...`. An empty/blank value yields the
 * default.
 */
export function normalizeOllamaCloudBaseUrl(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return OLLAMA_CLOUD_DEFAULT_BASE_URL;

  // Strip trailing slashes, then a single trailing `/api`, then any slashes it exposed.
  const withoutApi = trimmed.replace(/\/+$/, '').replace(/\/api$/i, '').replace(/\/+$/, '');
  return withoutApi || OLLAMA_CLOUD_DEFAULT_BASE_URL;
}

/**
 * Resolve the Ollama Cloud base URL for this box: `OLLAMA_CLOUD_BASE_URL` when
 * set (normalized), else the hosted default. Pass `raw` to test without
 * mutating process.env.
 */
export function resolveOllamaCloudBaseUrl(raw: string | null | undefined = process.env.OLLAMA_CLOUD_BASE_URL): string {
  return normalizeOllamaCloudBaseUrl(raw);
}
