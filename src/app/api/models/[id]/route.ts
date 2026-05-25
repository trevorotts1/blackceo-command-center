import { NextRequest, NextResponse } from 'next/server';
import { getModel, getModelByPk } from '@/lib/model-registry';

export const dynamic = 'force-dynamic';

/**
 * GET /api/models/[id]
 *
 * Returns a single `model_registry` row, capabilities and raw_metadata
 * already JSON-decoded.
 *
 * `id` can be either:
 *   - the provider-scoped string `model_id` (the natural key, for example
 *     `anthropic/claude-sonnet-4.6`)
 *   - the numeric surrogate primary key (when called from admin tooling that
 *     stores the integer id)
 *
 * Returns 404 when nothing matches.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }

    const decoded = decodeURIComponent(id);

    // Try the natural key first (the common case from the Intelligence
    // Settings UI). Fall back to the numeric pk when the string parses
    // cleanly as a positive integer and the natural-key lookup missed.
    let model = getModel(decoded);
    if (!model && /^\d+$/.test(decoded)) {
      model = getModelByPk(Number(decoded));
    }

    if (!model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    return NextResponse.json(model);
  } catch (err) {
    console.error('[/api/models/[id]] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load model', message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
