/**
 * GET  /api/bugs             -- list bug tickets (optionally filtered by workspace_id, status)
 * POST /api/bugs             -- create a bug ticket; defaults status='REPORTED'; emits bug_ticket_events row
 *
 * T3-001: Dedicated Bugs Department board.  All persistence is in bug_tickets / bug_ticket_events --
 * the tasks table and its status enum are never touched.
 */

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { BugTicket, CreateBugTicketRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const BugSeverityEnum = z.enum([
  'P0 run-dead',
  'P1 degraded',
  'P2 cosmetic or latent',
  'P3 improvement',
]);

const CreateBugTicketSchema = z.object({
  reporter_department: z.string().min(1, 'reporter_department is required'),
  symptom: z.string().min(1, 'symptom is required'),
  severity: BugSeverityEnum.optional(),
  reporter_specialist: z.string().optional(),
  reporter_run_id: z.string().optional(),
  suspected_layer: z.string().optional(),
  client_slug: z.string().optional(),
  evidence_paths: z.string().optional(), // JSON array string
  workspace_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// GET /api/bugs
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id');
    const status = searchParams.get('status');

    let sql = 'SELECT * FROM bug_tickets WHERE 1=1';
    const params: unknown[] = [];

    if (workspaceId) {
      sql += ' AND workspace_id = ?';
      params.push(workspaceId);
    }

    if (status) {
      const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        sql += ' AND status = ?';
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        sql += ` AND status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      }
    }

    sql += ' ORDER BY created_at DESC';

    const bugs = queryAll<BugTicket>(sql, params);
    return NextResponse.json({ bugs });
  } catch (err) {
    console.error('[GET /api/bugs]', err);
    return NextResponse.json({ error: 'Failed to list bug tickets' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/bugs -- REPORTED entry point
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable bug ID: BUG-YYYYMMDD-NNN.
 * NNN is a zero-padded sequence within the calendar day (restarts each day).
 */
function generateBugId(): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `BUG-${today}-`;

  // Count existing tickets created today to derive the next sequence number
  const row = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM bug_tickets WHERE id LIKE ?`,
    [`${prefix}%`],
  );
  const seq = ((row?.cnt ?? 0) + 1).toString().padStart(3, '0');
  return `${prefix}${seq}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as CreateBugTicketRequest;
    const parsed = CreateBugTicketSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = parsed.data;
    const id = generateBugId();
    const now = new Date().toISOString();
    const eventId = uuidv4();
    const workspaceId = data.workspace_id ?? 'bugs';

    run(
      `INSERT INTO bug_tickets (
        id, workspace_id, reporter_department, reporter_specialist,
        reporter_run_id, symptom, severity, suspected_layer, client_slug,
        status, evidence_paths, reported_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REPORTED', ?, ?, ?, ?)`,
      [
        id,
        workspaceId,
        data.reporter_department,
        data.reporter_specialist ?? null,
        data.reporter_run_id ?? null,
        data.symptom,
        data.severity ?? 'P1 degraded',
        data.suspected_layer ?? null,
        data.client_slug ?? null,
        data.evidence_paths ?? null,
        now,
        now,
        now,
      ],
    );

    // Write the REPORTED entry event (from_status=null signals the ticket was just created)
    run(
      `INSERT INTO bug_ticket_events (id, bug_id, from_status, to_status, actor, reason, created_at)
       VALUES (?, ?, NULL, 'REPORTED', 'intake-clerk', 'Bug ticket created', ?)`,
      [eventId, id, now],
    );

    const created = queryOne<BugTicket>('SELECT * FROM bug_tickets WHERE id = ?', [id]);

    broadcast({ type: 'bug_created', payload: created as never });

    return NextResponse.json({ bug: created }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/bugs]', err);
    return NextResponse.json({ error: 'Failed to create bug ticket' }, { status: 500 });
  }
}
