import { NextResponse } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';

/**
 * GET /api/openclaw/status — Bridge connection status.
 *
 * Returns a CLEAR connected/not signal plus, when the connection is failing,
 * a precise diagnosis the operator can act on:
 *   - `pairing_pending: true` + the exact `openclaw devices approve` hint when
 *     the gateway rejected the device handshake (the device is not approved).
 *   - a transport error + the resolved gateway URL when the gateway is simply
 *     unreachable (wrong URL / gateway down / not on loopback).
 * The local `device_id` is always included so the operator knows which device
 * to approve on the gateway host.
 */
export async function GET() {
  try {
    const client = getOpenClawClient();
    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || DEFAULT_GATEWAY_URL;
    const deviceId = client.getDeviceId();

    if (!client.isConnected()) {
      try {
        // Self-heal a pairing-pending failure on the local gateway by
        // auto-approving this device, then retrying — instead of returning the
        // raw red "pairing pending" error on first load.
        await client.connectWithAutoPair();
      } catch {
        const last = client.getLastConnectError();
        const message = last?.message ?? 'Failed to connect to the backend gateway';
        // A rejected device handshake = pairing not yet approved on the gateway.
        const pairingPending = /pairing|device|Authentication failed/i.test(message);
        return NextResponse.json({
          connected: false,
          error: pairingPending ? 'Device pairing pending approval on the gateway' : 'Failed to connect to the backend gateway',
          detail: message,
          pairing_pending: pairingPending,
          device_id: deviceId,
          gateway_url: gatewayUrl,
          ...(pairingPending && deviceId
            ? {
                remediation:
                  `Approve this command-center device on the gateway host, then reload: ` +
                  `run \`openclaw devices list\` to find the pending requestId for device ${deviceId}, ` +
                  `then \`openclaw devices approve <requestId>\`. See docs/OPENCLAW_BRIDGE_PAIRING.md.`,
              }
            : {}),
        });
      }
    }

    // If we self-healed a pairing failure on this connect, surface a clean
    // one-time note instead of any prior red error.
    const autoApprovedNote = client.getPairingAutoApprovedNote();

    // Connected: verify by listing sessions.
    try {
      const sessions = await client.listSessions();
      return NextResponse.json({
        connected: true,
        sessions_count: sessions.length,
        sessions,
        device_id: deviceId,
        gateway_url: gatewayUrl,
        ...(autoApprovedNote ? { pairing_auto_approved: autoApprovedNote } : {}),
      });
    } catch {
      return NextResponse.json({
        connected: true,
        error: 'Connected but failed to list sessions',
        device_id: deviceId,
        gateway_url: gatewayUrl,
        ...(autoApprovedNote ? { pairing_auto_approved: autoApprovedNote } : {}),
      });
    }
  } catch (error) {
    console.error('OpenClaw status check failed:', error);
    return NextResponse.json(
      {
        connected: false,
        error: 'Internal server error',
      },
      { status: 500 },
    );
  }
}
