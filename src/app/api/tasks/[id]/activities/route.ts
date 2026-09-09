/**
 * Task Activities API
 * Endpoints for logging and retrieving task activities
 */

import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { CreateActivitySchema } from '@/lib/validation';
import type { TaskActivity } from '@/lib/types';
import { TRUST_EVENT_TYPES, trustEventToActivity, type TrustEventRow } from '@/lib/trust-activity';
import { isPersonaUsedReport, recordPersonaUsedAndCompare } from '@/lib/persona-mismatch';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/tasks/[id]/activities
 * Retrieve all activities for a task
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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
 *
 * PRES-040 (W3 WF12-B) — structured phase events are first-class, never
 * silently strippable:
 *   - `scores` (structured QC grades) is ACCEPTED and persisted to
 *     task_activities.scores (migration 141); unknown-key 400/422 fallbacks
 *     in producers must no longer drop it to report success.
 *   - `metadata.event_id` + `metadata.schema_version` carry the producer's
 *     event identity. The (task_id, event_id) key is claimed in
 *     task_activity_events: a replay of the same key returns the ORIGINAL
 *     activity (replay-once, no duplicate phase event). A changed payload on
 *     the same key is a 409 conflict. Text notes without event_id are never
 *     deduped — a human note is always a new row.
 *   - Response echoes `structured_ack` (the event key claim) separately from
 *     the note write, so a producer can distinguish "text landed" from
 *     "structured event acknowledged" instead of conflating them.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

    const { activity_type, message, agent_id, metadata, scores } = validation.data;

    const db = getDb();

    // Normalize metadata to ONE JSON string for storage regardless of which
    // accepted shape arrived (object — the real-world shape every caller
    // sends — or a pre-stringified string; never double-encode the latter).
    const metadataStr =
      metadata == null ? null : typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
    const scoresStr =
      scores == null ? null : typeof scores === 'string' ? scores : JSON.stringify(scores);

    // PRES-040 — derive the producer event identity from metadata WITHOUT
    // trusting its shape: malformed JSON or a non-object yields no key (the
    // row still writes as a plain text note).
    let eventId: string | null = null;
    if (typeof metadata === 'object' && metadata !== null) {
      const v = (metadata as Record<string, unknown>).event_id;
      if (typeof v === 'string' && v.length > 0 && v.length <= 128) eventId = v;
    } else if (typeof metadataStr === 'string') {
      try {
        const parsed = JSON.parse(metadataStr) as unknown;
        if (parsed && typeof parsed === 'object') {
          const v = (parsed as Record<string, unknown>).event_id;
          if (typeof v === 'string' && v.length > 0 && v.length <= 128) eventId = v;
        }
      } catch { /* malformed — no key */ }
    }
    const eventHash = (() => {
      try {
        return createHash('sha256').update(JSON.stringify({ activity_type, message, metadata: metadataStr, scores: scoresStr })).digest('hex');
      } catch {
        return '';
      }
    })();

    const hasScoresCol = (() => {
      try {
        return (
          db.prepare(`SELECT count(*) AS n FROM pragma_table_info('task_activities') WHERE name = 'scores'`).get() as { n: number }
        ).n > 0;
      } catch {
        return false;
      }
    })();
    const hasEventLedger = (() => {
      try {
        return (
          db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='task_activity_events'`).get() as { n: number }
        ).n > 0;
      } catch {
        return false;
      }
    })();

    // Replay-once: the same (task, event) key returns the original row.
    if (eventId && hasEventLedger) {
      const prior = db
        .prepare(`SELECT activity_id, event_hash FROM task_activity_events WHERE task_id = ? AND event_id = ?`)
        .get(taskId, eventId) as { activity_id: string; event_hash: string } | undefined;
      if (prior) {
        if (prior.event_hash && eventHash && prior.event_hash !== eventHash) {
          return NextResponse.json(
            { error: `conflicting replay for activity event ${eventId}: payload differs from the acknowledged event` },
            { status: 409 },
          );
        }
        const original = db
          .prepare(`SELECT * FROM task_activities WHERE id = ?`)
          .get(prior.activity_id) as Record<string, unknown> | undefined;
        if (original) {
          return NextResponse.json(
            { ...(original as object), structured_ack: { event_id: eventId, status: 'duplicate' } },
            { status: 200 },
          );
        }
      }
    }

    const id = crypto.randomUUID();

    // Insert activity (transactional with the event-key claim so a crash
    // between the two can never orphan a key or double-claim it).
    const insertActivity = hasScoresCol
      ? db.prepare(`
        INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, scores)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      : db.prepare(`
        INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
    const claimEvent = hasEventLedger
      ? db.prepare(`
        INSERT INTO task_activity_events (task_id, event_id, activity_id, event_hash)
        VALUES (?,?,?,?)
      `)
      : null;
    const writeTx = db.transaction(() => {
      if (hasScoresCol) {
        insertActivity.run(id, taskId, agent_id || null, activity_type, message, metadataStr, scoresStr);
      } else {
        insertActivity.run(id, taskId, agent_id || null, activity_type, message, metadataStr);
      }
      if (claimEvent && eventId) claimEvent.run(taskId, eventId, id, eventHash);
    });
    writeTx();

    // B-U6 / U20 — declared-vs-used comparator. Only a `kind: 'persona_used'`
    // metadata payload (the onboarding producer's report of the personas it
    // actually wrote copy with) triggers this; every other activity type/
    // metadata shape is untouched. Best-effort: never fails the activity POST
    // that carries it (recordPersonaUsedAndCompare itself never throws).
    let parsedMetadataForCompare: unknown = null;
    if (typeof metadata === 'object' && metadata !== null) {
      parsedMetadataForCompare = metadata;
    } else if (typeof metadataStr === 'string') {
      try {
        parsedMetadataForCompare = JSON.parse(metadataStr);
      } catch {
        parsedMetadataForCompare = null;
      }
    }
    if (isPersonaUsedReport(parsedMetadataForCompare)) {
      recordPersonaUsedAndCompare(taskId, parsedMetadataForCompare);
    }

    // Get the created activity with agent info. SELECT names every column
    // explicitly — `a.*` on a pre-migration box has no scores column and a
    // `scores` key must still be present (null) so producers parsing the ACK
    // never branch on box version.
    const activity = db.prepare(`
      SELECT
        a.id, a.task_id, a.agent_id, a.activity_type, a.message, a.metadata,
        a.created_at,
        ${hasScoresCol ? 'a.scores,' : 'NULL AS scores,'}
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

    // PRES-040 — the structured ACK rides ALONGSIDE the row (never instead
    // of it): event_id echoes the claimed key, status 'accepted' marks the
    // first claim. A producer holding this response knows BOTH the note
    // landed AND the structured event is durable — the conflation that let
    // stripped fallbacks report success is structurally impossible.
    return NextResponse.json(
      {
        ...result,
        scores: (activity as { scores?: string | null }).scores ?? null,
        structured_ack: eventId ? { event_id: eventId, status: 'accepted' } : null,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error('Error creating activity:', error);
    return NextResponse.json(
      { error: 'Failed to create activity' },
      { status: 500 }
    );
  }
}
