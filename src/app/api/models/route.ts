import { NextRequest, NextResponse } from 'next/server';
import {
  listModels,
  listProviders,
  getLatestRefreshPerProvider,
  MODEL_CAPABILITIES,
  type ModelCapability,
  type ModelStatus,
} from '@/lib/model-registry';

export const dynamic = 'force-dynamic';

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

    if (refreshParam === '1' || refreshParam === 'true') {
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
