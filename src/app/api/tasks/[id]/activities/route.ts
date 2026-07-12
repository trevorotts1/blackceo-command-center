/**
 * Task Activities API
 * Endpoints for logging and retrieving task activities
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { CreateActivitySchema } from '@/lib/validation';
import type { TaskActivity } from '@/lib/types';
import { TRUST_EVENT_TYPES, trustEventToActivity, type TrustEventRow } from '@/lib/trust-activity';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/tasks/[id]/activities
 * Retrieve all activities for a task
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    const db = getDb();

    // Get activities with agent info
    const activities = db.prepare(`
      SELECT 
        a.*,
        ag.id as agent_id,
        ag.name as agent_name,
        ag.avatar_emoji as agent_avatar_emoji
      FROM task_activities a
      LEFT JOIN agents ag ON a.agent_id = ag.id
      WHERE a.task_id = ?
      ORDER BY a.created_at DESC
    `).all(taskId) as any[];

    // Transform to include agent object
    const result: TaskActivity[] = activities.map(row => ({
      id: row.id,
      task_id: row.task_id,
      agent_id: row.agent_id,
      activity_type: row.activity_type,
      message: row.message,
      metadata: row.metadata,
      created_at: row.created_at,
      agent: row.agent_id ? {
        id: row.agent_id,
        name: row.agent_name,
        avatar_emoji: row.agent_avatar_emoji,
        role: '',
        status: 'working' as const,
        is_master: false,
        workspace_id: 'default',
        description: '',
        created_at: '',
        updated_at: '',
      } : undefined,
    }));

    // P2-02 step 4 — fold in the trust engine's report-back trail so the client
    // sees the ack → in-progress → done communication history in the Activity
    // tab. The trust engine (P1-04) records each send as an `events` row typed
    // trust_ack / trust_progress / trust_done (a DIFFERENT table from
    // task_activities), so without this merge the trail is written but never
    // shown. Best-effort: a very old box with no `events` table must never 500
    // the activity feed — the whole block is wrapped so a query failure just
    // omits the trust rows.
    try {
      const hasEvents = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'")
        .get();
      if (hasEvents) {
        const placeholders = TRUST_EVENT_TYPES.map(() => '?').join(', ');
        const trustRows = db
          .prepare(
            `SELECT id, type, task_id, message, created_at
               FROM events
              WHERE task_id = ? AND type IN (${placeholders})`,
          )
          .all(taskId, ...TRUST_EVENT_TYPES) as TrustEventRow[];
        for (const r of trustRows) result.push(trustEventToActivity(r));
      }
    } catch (err) {
      console.warn('[activities] trust-event merge skipped (non-fatal):', (err as Error).message);
    }

    // Newest-first, matching the task_activities ORDER BY above, now that the two
    // sources are interleaved.
    result.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching activities:', error);
    return NextResponse.json(
      { error: 'Failed to fetch activities' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/tasks/[id]/activities
 * Log a new activity for a task
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    const body = await request.json();
    
    // Validate input with Zod
    const validation = CreateActivitySchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { activity_type, message, agent_id, metadata } = validation.data;

    const db = getDb();
    const id = crypto.randomUUID();

    // Insert activity
    db.prepare(`
      INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId,
      agent_id || null,
      activity_type,
      message,
      metadata ? JSON.stringify(metadata) : null
    );

    // Get the created activity with agent info
    const activity = db.prepare(`
      SELECT 
        a.*,
        ag.id as agent_id,
        ag.name as agent_name,
        ag.avatar_emoji as agent_avatar_emoji
      FROM task_activities a
      LEFT JOIN agents ag ON a.agent_id = ag.id
      WHERE a.id = ?
    `).get(id) as any;

    const result: TaskActivity = {
      id: activity.id,
      task_id: activity.task_id,
      agent_id: activity.agent_id,
      activity_type: activity.activity_type,
      message: activity.message,
      metadata: activity.metadata,
      created_at: activity.created_at,
      agent: activity.agent_id ? {
        id: activity.agent_id,
        name: activity.agent_name,
        avatar_emoji: activity.agent_avatar_emoji,
        role: '',
        status: 'working' as const,
        is_master: false,
        workspace_id: 'default',
        description: '',
        created_at: '',
        updated_at: '',
      } : undefined,
    };

    // Broadcast to SSE clients
    broadcast({
      type: 'activity_logged',
      payload: result,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error('Error creating activity:', error);
    return NextResponse.json(
      { error: 'Failed to create activity' },
      { status: 500 }
    );
  }
}
