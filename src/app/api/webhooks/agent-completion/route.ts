import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { runQCOnReview } from '@/lib/qc-scorer';
import { recordStatusEvent } from '@/lib/task-lifecycle';
import { deterministicOpenclawSessionId } from '@/lib/task-dispatcher';
import type { Task, Agent, OpenClawSession } from '@/lib/types';

/**
 * B5: resolve the agent behind a completion `session_id` when the
 * openclaw_sessions row is missing/purged. The id is deterministic
 * (`mission-control-<agent-name-slug>`), so match it back to an agent by name.
 * A direct SQL match covers the common single-spaced case; a JS scan (using the
 * SAME derivation the dispatcher uses) covers irregular whitespace.
 */
function resolveAgentFromSessionId(sessionId: string): { id: string; name: string } | null {
  if (!sessionId || !sessionId.startsWith('mission-control-')) return null;
  const direct = queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM agents
      WHERE ('mission-control-' || lower(replace(name, ' ', '-'))) = ?
      LIMIT 1`,
    [sessionId],
  );
  if (direct) return direct;
  const all = queryAll<{ id: string; name: string }>('SELECT id, name FROM agents', []);
  for (const a of all) {
    if (deterministicOpenclawSessionId(a.name) === sessionId) return a;
  }
  return null;
}

/**
 * Re-fetch a task with joined agent fields and broadcast a `task_updated` SSE
 * event so the board advances the card instantly (B2). Without this the status
 * write lands in the DB but no client is told, so the card never moves until a
 * manual refresh.
 */
function broadcastTaskUpdate(taskId: string): void {
  const updated = queryOne<Task>(
    `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji
     FROM tasks t
     LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
     WHERE t.id = ?`,
    [taskId]
  );
  if (updated) {
    broadcast({ type: 'task_updated', payload: updated });
  }
}

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Verify HMAC-SHA256 signature of webhook request
 */
function verifyWebhookSignature(signature: string, rawBody: string): boolean {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    // Dev mode - skip validation
    return true;
  }

  if (!signature) {
    return false;
  }

  const expectedSignature = createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  return signature === expectedSignature;
}

/**
 * POST /api/webhooks/agent-completion
 * 
 * Receives completion notifications from agents.
 * Expected payload:
 * {
 *   "session_id": "mission-control-engineering",
 *   "message": "TASK_COMPLETE: Built the authentication system"
 * }
 * 
 * Or can be called with task_id directly:
 * {
 *   "task_id": "uuid",
 *   "summary": "Completed the task successfully"
 * }
 */
export async function POST(request: NextRequest) {
  try {
    // Read raw body for signature verification
    const rawBody = await request.text();
    
    // Verify webhook signature if WEBHOOK_SECRET is set
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = request.headers.get('x-webhook-signature');
      
      if (!signature || !verifyWebhookSignature(signature, rawBody)) {
        console.warn('[WEBHOOK] Invalid signature attempt');
        return NextResponse.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }
    }

    const body = JSON.parse(rawBody);
    const now = new Date().toISOString();

    // Handle direct task_id completion
    if (body.task_id) {
      const task = queryOne<Task & { assigned_agent_name?: string }>(
        `SELECT t.*, a.name as assigned_agent_name
         FROM tasks t
         LEFT JOIN agents a ON t.assigned_agent_id = a.id
         WHERE t.id = ?`,
        [body.task_id]
      );

      if (!task) {
        return NextResponse.json({ error: 'Task not found' }, { status: 404 });
      }

      // Only move to review if not already in review or done
      // (Don't overwrite user's approval)
      const movedToReview = task.status !== 'review' && task.status !== 'done';
      if (movedToReview) {
        // U99-RAW-STATUS-WRITER: two-column write, no CAS guard beyond the
        // movedToReview check above; audited immediately below via
        // recordStatusEvent (DISP-10).
        run(
          'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
          ['review', now, task.id]
        );
        // DISP-10: complete the task_events audit sink for this advance.
        recordStatusEvent(task.id, task.status, 'review', {
          actor: task.assigned_agent_id ?? 'agent-completion',
          reason: 'agent reported TASK_COMPLETE (webhook)',
        });
      }

      // Log completion
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'task_completed',
          task.assigned_agent_id,
          task.id,
          `${task.assigned_agent_name} completed: ${body.summary || 'Task finished'}`,
          now
        ]
      );

      // Set agent back to standby
      if (task.assigned_agent_id) {
        run(
          'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
          ['standby', now, task.assigned_agent_id]
        );
      }

      // Advance the card on the board instantly (B2).
      broadcastTaskUpdate(task.id);

      // Fire QC scorer when this call actually moved the task into review.
      if (movedToReview) {
        runQCOnReview(task.id).catch(err => console.error('[agent-completion] QC error:', err));
      }

      return NextResponse.json({
        success: true,
        task_id: task.id,
        new_status: 'review',
        message: 'Task moved to review for verification'
      });
    }

    // Handle session-based completion (from message parsing)
    if (body.session_id && body.message) {
      // Parse TASK_COMPLETE message
      const completionMatch = body.message.match(/TASK_COMPLETE:\s*(.+)/i);
      if (!completionMatch) {
        return NextResponse.json(
          { error: 'Invalid completion message format. Expected: TASK_COMPLETE: [summary]' },
          { status: 400 }
        );
      }

      const summary = completionMatch[1].trim();

      // Find agent by session
      const session = queryOne<OpenClawSession>(
        'SELECT * FROM openclaw_sessions WHERE openclaw_session_id = ? AND status = ?',
        [body.session_id, 'active']
      );

      // B5: the openclaw_sessions row can be purged/missing while a real turn is
      // live. The id is deterministic, so resolve the agent directly from it and
      // recreate the active row instead of 404-ing a genuine completion.
      let agentId: string | null = session?.agent_id ?? null;
      if (!agentId) {
        const agent = resolveAgentFromSessionId(body.session_id);
        if (agent) {
          agentId = agent.id;
          try {
            run(
              `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, created_at, updated_at)
               VALUES (?, ?, ?, 'mission-control', 'active', ?, ?)`,
              [uuidv4(), agent.id, body.session_id, now, now]
            );
          } catch {
            /* best-effort session recreate — attribution below still proceeds */
          }
        }
      }

      if (!agentId) {
        return NextResponse.json(
          { error: 'Session not found or inactive' },
          { status: 404 }
        );
      }

      // Find active task for this agent
      const task = queryOne<Task & { assigned_agent_name?: string }>(
        `SELECT t.*, a.name as assigned_agent_name
         FROM tasks t
         LEFT JOIN agents a ON t.assigned_agent_id = a.id
         WHERE t.assigned_agent_id = ?
           AND t.status = 'in_progress'
         ORDER BY t.updated_at DESC
         LIMIT 1`,
        [agentId]
      );

      if (!task) {
        return NextResponse.json(
          { error: 'No active task found for this agent' },
          { status: 404 }
        );
      }

      // Only move to review if not already in review or done
      // (Don't overwrite user's approval)
      const movedToReviewSession = task.status !== 'review' && task.status !== 'done';
      if (movedToReviewSession) {
        // U99-RAW-STATUS-WRITER: two-column write, no CAS guard beyond the
        // movedToReviewSession check above; audited immediately below via
        // recordStatusEvent (DISP-10).
        run(
          'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
          ['review', now, task.id]
        );
        // DISP-10: complete the task_events audit sink for this advance.
        recordStatusEvent(task.id, task.status, 'review', {
          actor: agentId ?? 'agent-completion',
          reason: 'agent reported TASK_COMPLETE (webhook, session path)',
        });
      }

      // Log completion with summary
      run(
        `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          'task_completed',
          agentId,
          task.id,
          `${task.assigned_agent_name} completed: ${summary}`,
          now
        ]
      );

      // Set agent back to standby
      run(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?',
        ['standby', now, agentId]
      );

      // Advance the card on the board instantly (B2).
      broadcastTaskUpdate(task.id);

      // Fire QC scorer when this call actually moved the task into review.
      if (movedToReviewSession) {
        runQCOnReview(task.id).catch(err => console.error('[agent-completion] QC error:', err));
      }

      return NextResponse.json({
        success: true,
        task_id: task.id,
        agent_id: agentId,
        summary,
        new_status: 'review',
        message: 'Task moved to review for verification'
      });
    }

    return NextResponse.json(
      { error: 'Invalid payload. Provide either task_id or session_id + message' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Agent completion webhook error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/webhooks/agent-completion
 * 
 * Returns webhook status and recent completions
 */
export async function GET() {
  try {
    const recentCompletions = queryAll(
      `SELECT e.*, a.name as agent_name, t.title as task_title
       FROM events e
       LEFT JOIN agents a ON e.agent_id = a.id
       LEFT JOIN tasks t ON e.task_id = t.id
       WHERE e.type = 'task_completed'
       ORDER BY e.created_at DESC
       LIMIT 10`
    );

    return NextResponse.json({
      status: 'active',
      recent_completions: recentCompletions,
      endpoint: '/api/webhooks/agent-completion'
    });
  } catch (error) {
    console.error('Failed to fetch completion status:', error);
    return NextResponse.json(
      { error: 'Failed to fetch status' },
      { status: 500 }
    );
  }
}
