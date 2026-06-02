import { NextRequest, NextResponse } from 'next/server';
import { setSelectedClient, getClientContext, toPublicClient } from '@/lib/clients';

export const dynamic = 'force-dynamic';

/**
 * GET /api/clients/select
 * Returns the currently selected client (cookie-derived, defaults to self).
 * Used by the ConversationalAI page to show the correct gateway label in the
 * ConnectionStatusBar without leaking secrets.
 */
export async function GET() {
  try {
    const selected = getClientContext();
    return NextResponse.json({
      ok: true,
      selected: selected ? toPublicClient(selected) : null,
    });
  } catch (err) {
    console.error('[GET /api/clients/select] failed:', err);
    return NextResponse.json({ error: 'Failed to get selected client' }, { status: 500 });
  }
}

/**
 * POST /api/clients/select  { id }
 * Sets the `selectedClientId` cookie so every subsequent request resolves
 * OpenClaw / keys / memory / analytics against THAT client's box. Returns the
 * now-selected client (secrets stripped).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const ok = setSelectedClient(id);
    if (!ok) {
      return NextResponse.json({ error: 'Unknown client id' }, { status: 404 });
    }

    const selected = getClientContext();
    return NextResponse.json({
      ok: true,
      selected: selected ? toPublicClient(selected) : null,
    });
  } catch (err) {
    console.error('[POST /api/clients/select] failed:', err);
    return NextResponse.json({ error: 'Failed to select client' }, { status: 500 });
  }
}
