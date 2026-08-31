import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { createHmac } from 'crypto';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { runQCOnReview } from '@/lib/qc-scorer';
import { transition, TransitionError } from '@/lib/task-lifecycle';
import { collectCompletionEvidence } from '@/lib/completion-evidence';
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

/**
 * FIX 25 — uniform refusal contract for a zero/unreachable-evidence completion.
 * The shared task-lifecycle gate now throws PRECONDITION_EVIDENCE for review;
 * this webhook must NOT paper over it: no `task_completed` self-congratulation,
 * no agent freed to standby, no success-shaped body. The MR-18
 * `review_no_evidence` audit event stays (operators still see the attempt);
 * only its "proceed regardless" text changes. Flag mirrors the lifecycle gate:
 * PRESENTATION_REVIEW_EVIDENCE_GATE (default ON, =0 full rollback).
 */
function reviewEvidenceRefusalResponse(taskId: string, evidencePath: string): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: 'Completion refused: no reachable deliverable registered for this task.',
      code: 'PRECONDITION_EVIDENCE',
      task_id: taskId,
      remedy: `Register evidence via ${evidencePath} (a 'url' type pointing at where the work landed is sufficient), then re-send the completion.`,
    },
    { status: 422 },
  );
}

/** FIX 25 — mirrors task-lifecycle's presentationReviewEvidenceGate(). */
function reviewEvidenceGateEnabled(): boolean {
  return process.env.PRESENTATION_REVIEW_EVIDENCE_GATE !== '0';
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
      // FIX 25 — pre-check evidence BEFORE touching anything else, so a
      // zero-evidence completion is refused up front (no MR-18 text claiming
      // "proceed regardless", no success body). The gate flag mirrors the
      // lifecycle gate; =0 restores the soft MR-18 path verbatim.
      const directRefused = movedToReview && reviewEvidenceGateEnabled()
        && !collectCompletionEvidence(task.id).hasEvidence;
      if (directRefused) {
        // MR-18 soft-audit KEPT (reworded — the task no longer proceeds), then
        // refuse without logging completion, freeing the agent, or claiming review.
        try {
          run(
            `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              'review_no_evidence',
              task.assigned_agent_id,
              task.id,
              `[MR-18/FIX 25] Agent reported completion for "${task.title}" with no reachable deliverable registered. Problems: ${collectCompletionEvidence(task.id).problems.join('; ') || 'no deliverable rows at all'}. COMPLETION REFUSED — the task stays in its current status; register deliverables and re-send.`,
              now,
            ],
          );
        } catch {
          /* events audit is best-effort */
        }
        broadcastTaskUpdate(task.id);
        return reviewEvidenceRefusalResponse(task.id, `/api/tasks/${task.id}/deliverables`);
      }
      if (movedToReview) {
        try {
          // MR-04: route through transition() instead of raw SQL so the
          // legal-transition guard, preconditions, and CAS all run.
          await transition(task.id, 'review', {
            actor: task.assigned_agent_id ?? 'agent-completion',
            reason: 'agent reported TASK_COMPLETE (webhook)',
            expectedFrom: task.status as 'in_progress',
            // MR-12: exempt from the review-column WIP limit — an agent's
            // finished work must reach QC even when the column is full; the
            // limit gates operator moves, not the completion pipeline.
            operatorOverride: true,
          });
        } catch (err) {
          // FIX 25: PRECONDITION_EVIDENCE here is a REFUSAL, not a concurrency
          // footnote — surface it (422) instead of falling through to the
          // success-shaped epilogue. CAS/illegal remain non-fatal.
          if (err instanceof TransitionError && err.code === 'PRECONDITION_EVIDENCE') {
            broadcastTaskUpdate(task.id);
            return reviewEvidenceRefusalResponse(task.id, `/api/tasks/${task.id}/deliverables`);
          }
          if (err instanceof Error && !err.message.includes('CAS_CONFLICT')) {
            console.warn('[agent-completion] transition failed for task', task.id, err);
          }
        }
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

      // Find agent by session.
      // MR-05: filter deleted_at IS NULL so a soft-deleted row is never
      // returned live, but a later missed-filter hard-purge still degrades
      // to the B5 deterministic fallback instead of 404-ing.
      const session = queryOne<OpenClawSession>(
        'SELECT * FROM openclaw_sessions WHERE openclaw_session_id = ? AND status = ? AND deleted_at IS NULL',
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

      // MR-05: use the session's stored task_id for DIRECT attribution. The
      // dispatcher writes task_id on the session row at dispatch time; reading
      // it here closes the gap where a hard-deleted session row lost the
      // attribution and the webhook picked the wrong (newest) in_progress task
      // via the agent scan. The stored task_id is the definitive answer.
      let task: (Task & { assigned_agent_name?: string }) | null | undefined = null;
      if (session?.task_id) {
        task = queryOne<Task & { assigned_agent_name?: string }>(
          `SELECT t.*, a.name as assigned_agent_name
           FROM tasks t
           LEFT JOIN agents a ON t.assigned_agent_id = a.id
           WHERE t.id = ?`,
          [session.task_id]
        );
        if (!task) {
          // Stale task_id (task was deleted, etc.) — fall through to agent scan.
          console.warn(`[agent-completion] session task_id ${session.task_id} not found, falling back to agent scan`);
        }
      }

      // Fallback: find active task for this agent (preserved for the
      // missing/purged session row path, or when stored task_id is stale).
      if (!task) {
        task = queryOne<Task & { assigned_agent_name?: string }>(
          `SELECT t.*, a.name as assigned_agent_name
           FROM tasks t
           LEFT JOIN agents a ON t.assigned_agent_id = a.id
           WHERE t.assigned_agent_id = ?
             AND t.status = 'in_progress'
           ORDER BY t.updated_at DESC
           LIMIT 1`,
          [agentId]
        );
      }

      if (!task) {
        return NextResponse.json(
          { error: 'No active task found for this agent' },
          { status: 404 }
        );
      }

      // Only move to review if not already in review or done
      // (Don't overwrite user's approval)
      const movedToReviewSession = task.status !== 'review' && task.status !== 'done';
      // FIX 25 — identical refusal contract to the direct path above.
      const sessionRefused = movedToReviewSession && reviewEvidenceGateEnabled()
        && !collectCompletionEvidence(task.id).hasEvidence;
      if (sessionRefused) {
        // MR-18 soft-audit KEPT (reworded — the task no longer proceeds).
        try {
          run(
            `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              'review_no_evidence',
              agentId,
              task.id,
              `[MR-18/FIX 25] Agent reported completion for "${task.title}" with no reachable deliverable registered. Problems: ${collectCompletionEvidence(task.id).problems.join('; ') || 'no deliverable rows at all'}. COMPLETION REFUSED — the task stays in its current status; register deliverables and re-send.`,
              now,
            ],
          );
        } catch {
          /* events audit is best-effort */
        }
        broadcastTaskUpdate(task.id);
        return reviewEvidenceRefusalResponse(task.id, `/api/tasks/${task.id}/deliverables`);
      }
      if (movedToReviewSession) {
        try {
          // MR-04: route through transition() instead of raw SQL so the
          // legal-transition guard, preconditions, and CAS all run.
          await transition(task.id, 'review', {
            actor: agentId ?? 'agent-completion',
            reason: 'agent reported TASK_COMPLETE (webhook, session path)',
            expectedFrom: task.status as 'in_progress',
            // MR-12: exempt from the review-column WIP limit (see sibling call).
            operatorOverride: true,
          });
        } catch (err) {
          // FIX 25: the evidence refusal (defense-in-depth vs the pre-check)
          // becomes a 422, not a warn-and-succeed epilogue.
          if (err instanceof TransitionError && err.code === 'PRECONDITION_EVIDENCE') {
            broadcastTaskUpdate(task.id);
            return reviewEvidenceRefusalResponse(task.id, `/api/tasks/${task.id}/deliverables`);
          }
          if (err instanceof Error && !err.message.includes('CAS_CONFLICT')) {
            console.warn('[agent-completion] transition failed for task', task.id, err);
          }
        }
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
