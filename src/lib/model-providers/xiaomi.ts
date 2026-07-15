/**
 * Xiaomi (MiMo) provider connector per PRD Section 5.2.
 *
 * Xiaomi's MiMo family does not publish a public catalog discovery endpoint
 * of the OpenAI-compatible shape used by other connectors, so `fetchModels`
 * returns a curated, manually-maintained list. The weekly refresh job will
 * keep this aligned after a manual roll, which is acceptable because
 * Xiaomi's published catalog turns over slowly.
 *
 * `chatCompletion` is registered as a stub. Xiaomi has not published a
 * stable, openly-documented chat completion base URL across regions at the
 * time this connector was written, so calling it raises a clearly-marked
 * not-implemented error. The connector remains discoverable via the
 * registry so the catalog still surfaces in admin UIs.
 *
 * Auth: Bearer token in the Authorization header (when wired).
 * Env:  XIAOMI_API_KEY
 *
 * U50/H+L.8 — SWALLOW-AUDIT, explicit documented decision (not a defect).
 * `fetchModels()` below never calls `fetch()` at all — there is no live
 * catalog endpoint to swallow a failure from (see the file-top note), so
 * the "dead key silently re-stamps a stale catalog `active`" mirage the
 * swallow-audit closes structurally cannot occur here (a bad
 * `XIAOMI_API_KEY` cannot make this function lie, because nothing here
 * ever checks the key against a live call — `chatCompletion` also isn't
 * wired, so there is no authenticated proof path for this connector at
 * all yet). `status: 'active'` on the single curated row is therefore a
 * conscious, standing decision made because Xiaomi genuinely has no
 * discovery endpoint to verify against, not an unverified live-call
 * result. Revisit if Xiaomi ships a stable chat/catalog endpoint.
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ModelCapability,
  ModelProvider,
  ProviderModel,
} from './types';

const PROVIDER_SLUG = 'xiaomi';
const PROVIDER_DISPLAY_NAME = 'Xiaomi';

/**
 * `isConfigured` checks the operator-supplied env var. Surfaced for callers
 * (refresh job, admin UI) that want to skip this provider when credentials
 * are absent. The core `ModelProvider` contract does not require this hook,
 * so it lives as a named export rather than on the registered object.
 */
export function isConfigured(): boolean {
  return Boolean(process.env.XIAOMI_API_KEY);
}

/**
 * Curated catalog for the Xiaomi MiMo family. Capabilities reflect the
 * documented behaviors for each variant. Costs are unknown at the time of
 * writing, so `pricing_source` is `manual` and the per-million-token fields
 * are left undefined. The registry CRUD layer writes NULL for those.
 */
const CURATED_MODELS: Array<{
  id: string;
  ctx: number;
  caps: ModelCapability[];
  family: string;
}> = [
  {
    id: 'mimo-v2-pro',
    ctx: 200_000,
    caps: ['text', 'vision', 'reasoning', 'tool_use', 'long_context', 'streaming'],
    family: 'mimo-v2',
  },
];

function normalizeCurated(entry: {
  id: string;
  ctx: number;
  caps: ModelCapability[];
  family: string;
}): ProviderModel {
  return {
    model_id: `${PROVIDER_SLUG}/${entry.id}`,
    label: entry.id,
    provider: PROVIDER_SLUG,
    family: entry.family,
    context_window: entry.ctx > 0 ? entry.ctx : undefined,
    pricing_model: 'per_token',
    pricing_source: 'manual',
    capabilities: entry.caps,
    status: 'active',
    raw_metadata: { source: 'curated' },
  };
}

export async function fetchModels(_apiKey: string): Promise<ProviderModel[]> {
  // Xiaomi has no public catalog API. The apiKey is intentionally unused
  // for the curated path; we keep it in the signature for parity with the
  // `ModelProvider` contract and so future API-backed implementations can
  // drop in without touching call sites.
  void _apiKey;
  return CURATED_MODELS.map(normalizeCurated);
}

export async function chatCompletion(
  _apiKey: string,
  _request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  void _apiKey;
  void _request;
  throw new Error(
    'Xiaomi chatCompletion is not implemented: no stable public chat endpoint is wired in this connector yet'
  );
}

export const xiaomiProvider: ModelProvider = {
  slug: PROVIDER_SLUG,
  displayName: PROVIDER_DISPLAY_NAME,
  fetchModels,
  chatCompletion,
};

export default xiaomiProvider;
