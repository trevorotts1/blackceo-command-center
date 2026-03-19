import { NextRequest, NextResponse } from 'next/server';

/**
 * Webhook endpoint that receives task creation events and forwards them
 * to the OpenClaw gateway for COM/CEO agent routing.
 * 
 * POST /api/webhooks/task-created
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
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
      const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
      
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
