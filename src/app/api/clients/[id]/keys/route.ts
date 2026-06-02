import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@/lib/clients';
import {
  writeClientProviderKey,
  hydrateProviderEnvForSelectedClient,
} from '@/lib/studio/provider-discovery';
import { refreshModels } from '@/lib/jobs/refresh-models';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/clients/[id]/keys  (E5)
 *
 * Add/replace a provider API key for one client's OpenClaw env, then re-run the
 * model-registry refresh so the previously-failing provider lights up.
 *
 * Body: { provider: string, value: string, refresh?: boolean }
 *   - `provider` is a provider slug (e.g. "openai") OR an explicit env-var name
 *     (e.g. "OPENAI_API_KEY"). It is normalized to `<SLUG>_API_KEY`.
 *   - `value`    is the secret. It is written into the client's OpenClaw env
 *     (local openclaw.json for self; remote openclaw.json over SSH otherwise)
 *     and NEVER echoed back in the response.
 *   - `refresh`  defaults to true: re-pull the catalog with the new key.
 *
 * The response contains only the env-var NAME that was written and the refresh
 * outcome — never the secret value.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const client = getClient(params.id);
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const value = typeof body.value === 'string' ? body.value : '';
    const doRefresh = body.refresh !== false;

    if (!provider) {
      return NextResponse.json({ error: 'provider is required' }, { status: 400 });
    }
    if (!value.trim()) {
      return NextResponse.json({ error: 'value (the API key) is required' }, { status: 400 });
    }

    const write = await writeClientProviderKey(client, provider, value);
    if (!write.ok) {
      return NextResponse.json(
        { error: 'Failed to save key', message: write.error, env_var: write.envVar },
        { status: 502 },
      );
    }

    let refreshOutcomes: unknown = null;
    if (doRefresh) {
      try {
        // Pull keys (including the one just written) for this client into env,
        // then re-pull the catalog so the failing provider recovers.
        await hydrateProviderEnvForSelectedClient(client);
        refreshOutcomes = await refreshModels();
      } catch (err) {
        // The key WAS saved; surface the refresh failure separately so the UI
        // can tell the operator the key is stored but the catalog needs a retry.
        return NextResponse.json({
          ok: true,
          env_var: write.envVar,
          target: write.target,
          refreshed: false,
          refresh_error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json({
      ok: true,
      env_var: write.envVar,
      target: write.target,
      refreshed: doRefresh,
      outcomes: refreshOutcomes,
    });
  } catch (err) {
    console.error('[POST /api/clients/[id]/keys] failed:', err);
    return NextResponse.json(
      { error: 'Failed to add key', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
