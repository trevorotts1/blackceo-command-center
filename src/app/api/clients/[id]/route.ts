import { NextRequest, NextResponse } from 'next/server';
import { getClient, updateClient, toPublicClient } from '@/lib/clients';

export const dynamic = 'force-dynamic';

/** GET /api/clients/[id] — one client (secrets stripped). */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const client = getClient(params.id);
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    }
    return NextResponse.json({ client: toPublicClient(client) });
  } catch (err) {
    console.error('[GET /api/clients/[id]] failed:', err);
    return NextResponse.json({ error: 'Failed to load client' }, { status: 500 });
  }
}

/**
 * PATCH /api/clients/[id] — update connection fields and/or interview_complete.
 * Only the provided fields are changed.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const existing = getClient(params.id);
    if (!existing) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));

    if (body.gateway_url !== undefined) {
      if (typeof body.gateway_url !== 'string' || !/^wss?:\/\//i.test(body.gateway_url)) {
        return NextResponse.json(
          { error: 'gateway_url must be a ws:// or wss:// URL' },
          { status: 400 },
        );
      }
    }

    const updated = updateClient(params.id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      gateway_url: typeof body.gateway_url === 'string' ? body.gateway_url : undefined,
      gateway_token: body.gateway_token !== undefined ? body.gateway_token : undefined,
      cf_access_client_id: body.cf_access_client_id !== undefined ? body.cf_access_client_id : undefined,
      cf_access_client_secret: body.cf_access_client_secret !== undefined ? body.cf_access_client_secret : undefined,
      workspace_root: body.workspace_root !== undefined ? body.workspace_root : undefined,
      ssh_target: body.ssh_target !== undefined ? body.ssh_target : undefined,
      interview_complete: body.interview_complete !== undefined ? body.interview_complete === true : undefined,
    });

    if (!updated) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 });
    }
    return NextResponse.json({ client: toPublicClient(updated) });
  } catch (err) {
    console.error('[PATCH /api/clients/[id]] failed:', err);
    return NextResponse.json({ error: 'Failed to update client' }, { status: 500 });
  }
}
