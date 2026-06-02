import { NextRequest, NextResponse } from 'next/server';
import { listClients, createClient, toPublicClient, getSelectedClientId } from '@/lib/clients';

// Runtime route — reads/writes the clients tenant table.
export const dynamic = 'force-dynamic';

/**
 * GET /api/clients
 * List all managed clients (self + remote). Secrets are stripped — only a
 * has_gateway_token / has_cf_access boolean is exposed.
 */
export async function GET() {
  try {
    const clients = listClients().map(toPublicClient);
    // Expose which client is currently selected so client-scoped UIs (e.g. the
    // E5 "Add API key" action) target the SAME box the refresh runs against,
    // not just the self client.
    const selected_id = getSelectedClientId();
    return NextResponse.json({ clients, selected_id });
  } catch (err) {
    console.error('[GET /api/clients] failed:', err);
    return NextResponse.json({ error: 'Failed to list clients' }, { status: 500 });
  }
}

/**
 * POST /api/clients
 * Create a remote client. Body:
 *   { name, gateway_url?, gateway_token?, cf_access_client_id?,
 *     cf_access_client_secret?, workspace_root?, ssh_target?, interview_complete? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const gatewayUrl = typeof body.gateway_url === 'string' ? body.gateway_url.trim() : '';
    if (gatewayUrl && !/^wss?:\/\//i.test(gatewayUrl)) {
      return NextResponse.json(
        { error: 'gateway_url must be a ws:// or wss:// URL' },
        { status: 400 },
      );
    }

    const client = createClient({
      name,
      gateway_url: gatewayUrl || undefined,
      gateway_token: typeof body.gateway_token === 'string' ? body.gateway_token : null,
      cf_access_client_id: typeof body.cf_access_client_id === 'string' ? body.cf_access_client_id : null,
      cf_access_client_secret: typeof body.cf_access_client_secret === 'string' ? body.cf_access_client_secret : null,
      workspace_root: typeof body.workspace_root === 'string' ? body.workspace_root : null,
      ssh_target: typeof body.ssh_target === 'string' ? body.ssh_target : null,
      interview_complete: body.interview_complete === true,
    });

    return NextResponse.json({ client: toPublicClient(client) }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/clients] failed:', err);
    return NextResponse.json({ error: 'Failed to create client' }, { status: 500 });
  }
}
