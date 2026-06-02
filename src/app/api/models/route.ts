import { NextRequest, NextResponse } from 'next/server';
import {
  listModels,
  listProviders,
  getLatestRefreshPerProvider,
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ModelStatus,
} from '@/lib/model-registry';
import { refreshModels } from '@/lib/jobs/refresh-models';
import { hydrateProviderEnvForSelectedClient } from '@/lib/studio/provider-discovery';

export const dynamic = 'force-dynamic';

/**
 * Debounce window for the `?refresh=1` auto-refresh (E4). Walking every
 * provider's `fetchModels()` is rate-limit sensitive, so a burst of page loads
 * (or a parallel settings + models fetch) must not fan out into a refresh per
 * request. We remember the last refresh start time in module scope (the route
 * is long-lived within a server instance) and skip if it was recent. A manual
 * "Refresh now" button still bypasses this via POST /api/cron/refresh-models.
 */
const REFRESH_DEBOUNCE_MS = 6 * 60 * 60 * 1000; // 6 hours
let lastRefreshStartedAt = 0;
let inFlightRefresh: Promise<unknown> | null = null;

/**
 * Kick a model-registry refresh scoped to the SELECTED client, but only when
 * the registry is empty (fresh install) or the debounce window has elapsed.
 * Awaited only when the registry is empty so a brand-new install returns a
 * populated catalog on the first paint; otherwise it runs in the background so
 * the request stays fast. Never throws.
 */
async function maybeRefresh(registryIsEmpty: boolean): Promise<void> {
  const now = Date.now();
  const stale = now - lastRefreshStartedAt > REFRESH_DEBOUNCE_MS;
  if (!registryIsEmpty && !stale) return;
  if (inFlightRefresh) {
    // A refresh is already running; only block on it for an empty registry.
    if (registryIsEmpty) await inFlightRefresh.catch(() => {});
    return;
  }

  lastRefreshStartedAt = now;
  const run = (async () => {
    try {
      // Source provider keys from the SELECTED client, not the CC's own env.
      await hydrateProviderEnvForSelectedClient();
      await refreshModels();
    } catch (err) {
      console.error('[/api/models] background refresh failed:', err);
    } finally {
      inFlightRefresh = null;
    }
  })();
  inFlightRefresh = run;

  // Block ONLY on an empty registry so the catalog is non-empty on first load.
  if (registryIsEmpty) await run.catch(() => {});
}

/**
 * GET /api/models
 *
 * Dynamic model catalog from the `model_registry` table (PRD Section 5.1).
 * Replaces the hardcoded AVAILABLE_MODELS array as the source of truth.
 *
 * Query parameters (all optional, all AND-combined):
 *   - provider:   exact provider slug (for example, `openrouter`, `anthropic-direct`)
 *   - capability: capability tag (text, vision, image_generation, ...)
 *   - status:     model status filter. Defaults to `active`. Pass `all` to
 *                 disable the filter entirely. Pass `deprecated` etc. for a
 *                 specific status.
 *   - family:     exact family name (for example, `claude-4`, `gemini-3`)
 *   - refresh:    when set to `1`, includes the latest refresh log entry per
 *                 provider on the response (used by the Intelligence Settings
 *                 "last refreshed" badge).
 *   - limit:      page size (default unlimited)
 *   - offset:     pagination offset
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;

    const provider = params.get('provider') || undefined;
    const family = params.get('family') || undefined;
    const capabilityParam = params.get('capability') || undefined;
    const statusParam = params.get('status');
    const refreshParam = params.get('refresh');
    const limitParam = params.get('limit');
    const offsetParam = params.get('offset');

    // Validate capability against the known vocabulary so consumers get a
    // helpful 400 instead of a silently empty result set.
    let capability: ModelCapability | undefined;
    if (capabilityParam) {
      if (!(MODEL_CAPABILITIES as readonly string[]).includes(capabilityParam)) {
        return NextResponse.json(
          {
            error: 'Invalid capability',
            message: `capability must be one of: ${MODEL_CAPABILITIES.join(', ')}`,
          },
          { status: 400 }
        );
      }
      capability = capabilityParam as ModelCapability;
    }

    // status=all explicitly disables the default 'active' filter. A bare
    // missing param uses the listModels default ('active'). Any other value
    // is treated as a literal status string and validated.
    let statusFilter: ModelStatus | null | undefined;
    if (statusParam === 'all') {
      statusFilter = null;
    } else if (statusParam) {
      const valid: ModelStatus[] = ['active', 'deprecated', 'preview', 'unavailable'];
      if (!valid.includes(statusParam as ModelStatus)) {
        return NextResponse.json(
          { error: 'Invalid status', message: `status must be one of: ${valid.join(', ')}, all` },
          { status: 400 }
        );
      }
      statusFilter = statusParam as ModelStatus;
    }

    const limit = limitParam ? Number(limitParam) : undefined;
    const offset = offsetParam ? Number(offsetParam) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
      return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
    }
    if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
      return NextResponse.json({ error: 'Invalid offset' }, { status: 400 });
    }

    const wantRefresh = refreshParam === '1' || refreshParam === 'true';

    // E4: `?refresh=1` must ACTUALLY refresh. The previous behavior only
    // appended the refresh LOG to the response and never re-pulled the catalog.
    // We now trigger a debounced, selected-client-scoped refresh. A fresh
    // (empty) registry blocks so the first paint is populated; otherwise the
    // refresh runs in the background and this request returns the current rows.
    if (wantRefresh) {
      try {
        const registryIsEmpty = listModels({ status: null, limit: 1 }).length === 0;
        await maybeRefresh(registryIsEmpty);
      } catch (err) {
        // Never let a refresh failure break the catalog read.
        console.error('[/api/models] refresh trigger failed:', err);
      }
    }

    const models = listModels({
      provider,
      family,
      capability,
      status: statusFilter,
      limit,
      offset,
    });

    const body: Record<string, unknown> = {
      total: models.length,
      models,
      providers: listProviders(),
      generated_at: new Date().toISOString(),
    };

    if (wantRefresh) {
      body.refresh_log = getLatestRefreshPerProvider();
    }

    return NextResponse.json(body);
  } catch (err) {
    console.error('[/api/models] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load models', message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
