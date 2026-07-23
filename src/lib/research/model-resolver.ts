/**
 * Research model resolver (U086).
 *
 * Resolve which model_id to pass to a research provider. The caller supplies the
 * provider slug and the provider's documented default model. When the model
 * registry has an exact match for the default we return it; otherwise the
 * substitution is **restricted to models the registry records as
 * web-search-capable**.
 *
 * THE DEFECT THIS ISOLATES
 * -------------------------
 * Pre-U086, `resolveModel()` fell through to `active[0]` with no capability
 * check. A chat/embeddings-only model promoted for an unrelated reason
 * (cheapest, newest, or sole active row) would silently become the research
 * model, and the search route presented its output as grounded research. Live
 * web search is a property of particular models, not of the provider.
 *
 * Extracted from `src/app/api/operator/research/search/route.ts` so it can be
 * imported in test suites without pulling the Next.js route module resolver.
 */

import { listModels } from '@/lib/model-registry';
import type { ResearchProviderSlug } from '@/lib/research/provider-discovery';

export function resolveResearchModel(slug: ResearchProviderSlug, fallback: string): string {
  try {
    const active = listModels({ provider: slug, status: 'active' });
    const exact = active.find(
      (m) => m.model_id === fallback || m.model_id.endsWith("/" + fallback),
    );
    if (exact) {
      return exact.model_id.includes('/')
        ? exact.model_id.split('/').slice(1).join('/')
        : exact.model_id;
    }
    // No exact match -- restrict substitution to web-search-capable models.
    const searchCapable = active.filter((m) =>
      m.capabilities.includes('web_search'),
    );
    if (searchCapable.length > 0) {
      const id = searchCapable[0].model_id;
      return id.includes('/') ? id.split('/').slice(1).join('/') : id;
    }
  } catch {
    // registry may be empty on fresh installs; fall through to default.
  }
  return fallback;
}
