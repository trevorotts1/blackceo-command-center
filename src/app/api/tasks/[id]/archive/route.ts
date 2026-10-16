/**
 * POST   /api/tasks/[id]/archive — soft-archive a task (stamp archived_at).
 * DELETE /api/tasks/[id]/archive — un-archive it (clear archived_at).
 *
 * B8 / AUD-46. This is the FIRST HALF of the two-step the delete guard enforces,
 * and until now it did not exist as an API at all: `tasks.archived_at` (migration
 * 058) was only ever stamped by the weekly Done-clear job, and PATCH /api/tasks/[id]
 * does not accept the field. So there was no way to take a card off the board
 * WITHOUT destroying it — which is precisely why hard DELETE was reached for.
 *
 * Shipping the guard without this route would have made DELETE unreachable rather
 * than deliberate. A gate you cannot pass is a wall, not a gate.
 *
 * Soft-archive is LOSSLESS: the row and every child record survive, the board hides
 * the card (GET /api/tasks filters `archived_at IS NULL`), and `?includeArchived=true`
 * still returns it. Un-archiving puts it straight back.
 */

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getOpenClawClient } from '@/lib/openclaw/client';
import {
  findActiveExecutionForTask,
  buildKillNotice,
  recordKillAck,
} from '@/lib/task-kill';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // CANC-101 (finding 10): archive is the owner's CANCEL. Idempotent:
    // COALESCE keeps the ORIGINAL killed_at AND archived_at, so cancelling
    // twice never rewrites history and never double-writes. The kill field is
    // set FIRST — every fence (dispatch 409, claim UPDATEs, reserve fences,
    // persona-state, auto-route committer) refuses further work on the task
    // from this moment on, whether or not the live notice below delivers.
    // Un-archive (DELETE below) clears archived_at only — the kill stands.
    const now = new Date().toISOString();
    run(
      `UPDATE tasks
          SET killed_at = COALESCE(killed_at, ?),
              archived_at = COALESCE(archived_at, ?), updated_at = ?
        WHERE id = ?`,
      [now, now, now, id],
    );

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    const killedAt = (task as Task & { killed_at?: string | null })?.killed_at ?? now;

    // Live stop notice to the in-flight run, if any. Best-effort: delivery
    // failure must NOT fail the cancel — the kill fence above is already set.
    // No abort RPC exists on the gateway (client.ts exposes only
    // sessions.list, agents.list, chat.history, sessions.send,
    // sessions.create), so chat.send notice + kill fence ARE the stop
    // mechanism. The run cannot be killed by CC; the notice tells it to STOP.
    let executionFound = false;
    let noticeDelivered = false;
    let noticeError: string | null = null;
    try {
      const live = findActiveExecutionForTask(id);
      if (live) {
        executionFound = true;
        try {
          const client = getOpenClawClient();
          if (!client.isConnected()) await client.connect();
          await client.call('chat.send', {
            sessionKey: live.session_key,
            message: buildKillNotice(id, existing.title ?? id),
          });
          noticeDelivered = true;
        } catch (err) {
          noticeError = (err as Error).message ?? 'unknown delivery error';
        }
      }
    } catch (err) {
      noticeError = (err as Error).message ?? 'unknown lookup error';
    }

    // Presence boolean only — the session key is an internal handle and is
    // never written into events/messages rows.
    const hasLiveRun = executionFound ? 1 : 0;
    try {
      run(
        `INSERT INTO events (id, type, task_id, message, created_at)
         SELECT ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM events WHERE task_id = ? AND type = ?)`,
        [
          uuidv4(),
          'task_cancelled_owner_killed',
          id,
          `[task_cancelled_owner_killed] Task "${existing.title ?? id}" (${id}) CANCELLED by owner: ` +
            `killed_at=${killedAt}; live run present: ${executionFound ? 'yes' : 'no'}; ` +
            `stop notice ${noticeDelivered ? 'DELIVERED to the in-flight session' : 'NOT delivered' + (noticeError ? ` (${noticeError})` : ' (no live run or send failed)')}.`,
          now,
          id,
          'task_cancelled_owner_killed',
        ],
      );
    } catch {
      // Audit write is best-effort; the kill fence above already holds.
    }
    recordKillAck(id, killedAt, hasLiveRun === 1, noticeDelivered, noticeError);

    broadcast({ type: 'task_updated', payload: task as Task });

    const note =
      'Task CANCELLED and soft-archived — hidden from the board, row PRESERVED. ' +
      'killed_at is set: the task is terminal-for-dispatch and will not be ' +
      're-dispatched. Retrieve with ?includeArchived=true.' +
      (noticeDelivered
        ? ' A live STOP notice was delivered to the in-flight run.'
        : ' The live run could NOT be reached (' +
          (noticeError ?? 'no running agent session right now') +
          ') — it was already fenced out of any further dispatch; kill stands regardless.') +
      ' NOTE: the gateway has no abort RPC, so a run already inside the gateway ' +
      'cannot be force-stopped by the Command Center — the kill fence plus this ' +
      'notice are the stop mechanism.';

    return NextResponse.json({
      ok: true,
      id,
      archived_at: task?.archived_at ?? null,
      killed: true,
      killed_at: killedAt,
      execution: {
        found: executionFound,
        session_key: executionFound ? '[present]' : null,
        notice_delivered: noticeDelivered,
        notice_error: noticeError,
        aborted: false,
        abort_supported: false,
        note: noticeDelivered
          ? 'gateway has no abort RPC — kill fence + live notice delivered'
          : `kill fence set; live notice NOT delivered: ${noticeError ?? 'no running agent session'}`,
      },
      note,
    });
  } catch (error) {
    console.error('Failed to archive task:', error);
    return NextResponse.json({ error: 'Failed to archive task' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    run('UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?', [
      new Date().toISOString(),
      id,
    ]);

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
    broadcast({ type: 'task_updated', payload: task as Task });

    return NextResponse.json({ ok: true, id, archived_at: null, note: 'Task restored to the board.' });
  } catch (error) {
    console.error('Failed to un-archive task:', error);
    return NextResponse.json({ error: 'Failed to un-archive task' }, { status: 500 });
  }
}
