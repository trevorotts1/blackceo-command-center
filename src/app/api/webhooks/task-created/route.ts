import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Verify the HMAC-SHA256 signature of the webhook request (DATA-09).
 *
 * Mirrors /api/webhooks/agent-completion: the caller signs the RAW request body
 * with WEBHOOK_SECRET and sends the hex digest in `x-webhook-signature`. The
 * middleware supplies the Bearer (MC_API_TOKEN) layer for external callers;
 * this HMAC is the per-request second factor so the route is never an
 * unauthenticated write surface (it forwards task-created events to the gateway
 * for COM/CEO routing) even if the middleware layer is bypassed.
 *
 * When WEBHOOK_SECRET is unset we skip (dev): safe because this route is now in
 * the middleware's WEBHOOK_SECRET_ROUTES fail-closed family, so a production box
 * without WEBHOOK_SECRET is refused at the gate (503) before reaching here.
 * Comparison is constant-time.
 */
function verifyWebhookSignature(signature: string | null, rawBody: string): boolean {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) return true;
  if (!signature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const sig = Buffer.from(signature);
  const exp = Buffer.from(expected);
  if (sig.length !== exp.length) return false;
  return timingSafeEqual(sig, exp);
}

/**
 * Webhook endpoint that receives task creation events and forwards them
 * to the OpenClaw gateway for COM/CEO agent routing.
 * 
 * POST /api/webhooks/task-created
 */
export async function POST(request: NextRequest) {
  try {
    // DATA-09: route-level HMAC auth (Bearer is enforced by middleware).
    const rawBody = await request.text();
    if (process.env.WEBHOOK_SECRET) {
      const signature = request.headers.get('x-webhook-signature');
      if (!signature || !verifyWebhookSignature(signature, rawBody)) {
        console.warn('[Webhook:task-created] Invalid webhook signature attempt');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }
    const body = JSON.parse(rawBody);
    const { taskId, title, description, department, priority, workspaceId } = body;

    // Validate required fields
    if (!taskId || !title) {
      return NextResponse.json(
        { error: 'Missing required fields: taskId and title are required' },
        { status: 400 }
      );
    }

    // Prepare message for COM agent
    const message = {
      type: 'task_created',
      payload: {
        taskId,
        title,
        description: description || '',
        department: department || null,
        priority: priority || 'medium',
        workspaceId: workspaceId || 'default',
        timestamp: new Date().toISOString(),
      },
    };

    // Forward to OpenClaw gateway
    try {
      // OPENCLAW_GATEWAY_URL may be a ws:// or wss:// URL (for the WebSocket
      // client). fetch() requires http:// / https://, so convert the scheme
      // here. The gateway's HTTP hooks port is the same as its WS port.
      const rawGatewayUrl = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
      const gatewayUrl = rawGatewayUrl
        .replace(/^wss:\/\//, 'https://')
        .replace(/^ws:\/\//, 'http://');

      const response = await fetch(`${gatewayUrl}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          target: 'com',
          message: `New task requires routing: "${title}"${department ? ` [${department}]` : ''}${priority ? ` (Priority: ${priority})` : ''}`,
          metadata: message.payload,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Webhook] Gateway returned error:', response.status, errorText);
        // Still return 200 to the caller - we don't want to fail the task creation
        return NextResponse.json(
          { 
            success: true, 
            forwarded: false,
            warning: 'Task created but failed to notify gateway',
            error: errorText 
          },
          { status: 200 }
        );
      }

      console.log('[Webhook] Successfully notified gateway for task:', taskId);
      return NextResponse.json(
        { success: true, forwarded: true },
        { status: 200 }
      );
    } catch (gatewayError) {
      console.error('[Webhook] Failed to connect to gateway:', gatewayError);
      // Return success anyway - don't fail the task creation
      return NextResponse.json(
        { 
          success: true, 
          forwarded: false,
          warning: 'Task created but gateway is unreachable',
          error: gatewayError instanceof Error ? gatewayError.message : 'Unknown error'
        },
        { status: 200 }
      );
    }
  } catch (error) {
    console.error('[Webhook] Error processing webhook:', error);
    return NextResponse.json(
      { error: 'Failed to process webhook' },
      { status: 500 }
    );
  }
}
