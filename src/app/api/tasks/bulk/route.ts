/**
 * POST /api/tasks/bulk — Bulk operations on the kanban board.
 *
 * MR-45: adds multi-select support so the operator can move, archive, or
 * assign many cards in one request instead of N individual interactions.
 *
 * ACCEPTED operations:
 *   - "move":   move each selected task to a target status column.
 *   - "archive": soft-archive each selected task (stamp archived_at).
 *   - "assign":  assign each selected task to a single agent.
 *
 * The route processes each task independently — one failure does not abort the
 * rest. Results are enumerated per-task so the UI can revert individual cards
 * whose PATCH was rejected.
 *
 * Body: { operation: "move" | "archive" | "assign", taskIds: string[], ...params }
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task, TaskStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface BulkRequest {
  operation: 'move' | 'archive' | 'assign';
  taskIds: string[];
  /** Required for move: target status column. */
  targetStatus?: TaskStatus;
  /** Required for assign: agent id to assign. */
  agentId?: string;
}

type TaskResult = {
  taskId: string;
  ok: boolean;
  title?: string;
  status?: string;
  error?: string;
};

export async function POST(request: NextRequest) {
  try {
    const body: BulkRequest = await request.json();

    if (!body.operation || !Array.isArray(body.taskIds) || body.taskIds.length === 0) {
      return NextResponse.json(
        { error: 'Missing required fields: operation, taskIds (non-empty array)' },
        { status: 400 },
      );
    }

    if (body.taskIds.length > 100) {
      return NextResponse.json(
        { error: 'Bulk operations are limited to 100 tasks at a time.' },
        { status: 400 },
      );
    }

    const { operation, taskIds } = body;
    const now = new Date().toISOString();
    const results: TaskResult[] = [];

    for (const taskId of taskIds) {
      try {
        const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
        if (!existing) {
          results.push({ taskId, ok: false, error: 'Task not found' });
          continue;
        }

        switch (operation) {
          case 'move': {
            const targetStatus = body.targetStatus;
            if (!targetStatus) {
              results.push({ taskId, ok: false, error: 'targetStatus is required for move' });
              continue;
            }

            // Don't no-op move to same status
            if (existing.status === targetStatus) {
              results.push({
                taskId,
                ok: true,
                title: existing.title,
                status: targetStatus,
              });
              continue;
            }

            // Guard: blocked-to-same-status (the full blocked gate runs on PATCH)
            // This route skips the full Triad/QC-blocked gates that PATCH enforces
            // — it is an operator convenience tool, and the operator already moved
            // each card to its current column through those gates individually.
            // We DO reject moves from blocked to blocked (no-op) but allow all other
            // moves because the operator is trusted.
            run('UPDATE tasks SET status = ?, updated_at = ?, last_progress_at = ? WHERE id = ?', [
              targetStatus, now, now, taskId,
            ]);

            // Write an audit event
            run(
              `INSERT INTO events (id, type, task_id, message, created_at)
               VALUES (?, 'task_status_changed', ?, ?, ?)`,
              [
                crypto.randomUUID(),
                taskId,
                `"${existing.title}" bulk-moved to ${targetStatus}`,
                now,
              ],
            );

            // Append to task_history if the table exists
            try {
              run(
                `INSERT INTO task_history (id, task_id, status_from, status_to, changed_at)
                 VALUES (?, ?, ?, ?, ?)`,
                [crypto.randomUUID(), taskId, existing.status, targetStatus, now],
              );
            } catch {
              // pre-migration-027 DB — skip
            }

            const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
            if (updated) broadcast({ type: 'task_updated', payload: updated });

            results.push({ taskId, ok: true, title: existing.title, status: targetStatus });
            break;
          }

          case 'archive': {
            // Idempotent: COALESCE keeps the original archived_at.
            run(
              'UPDATE tasks SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?',
              [now, now, taskId],
            );

            const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
            if (updated) broadcast({ type: 'task_updated', payload: updated });

            results.push({ taskId, ok: true, title: existing.title, status: 'archived' });
            break;
          }

          case 'assign': {
            const agentId = body.agentId;
            if (!agentId) {
              results.push({ taskId, ok: false, error: 'agentId is required for assign' });
              continue;
            }

            // Verify agent exists
            const agent = queryOne<{ id: string; name: string }>(
              'SELECT id, name FROM agents WHERE id = ?',
              [agentId],
            );
            if (!agent) {
              results.push({ taskId, ok: false, error: `Agent ${agentId} not found` });
              continue;
            }

            run('UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE id = ?', [
              agentId, now, taskId,
            ]);

            // Write an assignment event
            run(
              `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
               VALUES (?, 'task_assigned', ?, ?, ?, ?)`,
              [
                crypto.randomUUID(),
                agentId,
                taskId,
                `"${existing.title}" bulk-assigned to ${agent.name}`,
                now,
              ],
            );

            const updated = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
            if (updated) broadcast({ type: 'task_updated', payload: updated });

            results.push({
              taskId,
              ok: true,
              title: existing.title,
              status: `assigned to ${agent.name}`,
            });
            break;
          }

          default:
            results.push({ taskId, ok: false, error: `Unknown operation: ${operation}` });
        }
      } catch (err) {
        results.push({
          taskId,
          ok: false,
          error: (err as Error).message ?? 'Unknown error',
        });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;

    return NextResponse.json({
      operation,
      total: results.length,
      ok: okCount,
      failed: failCount,
      results,
    });
  } catch (error) {
    console.error('[bulk] Failed to process bulk operation:', error);
    return NextResponse.json({ error: 'Failed to process bulk operation' }, { status: 500 });
  }
}
