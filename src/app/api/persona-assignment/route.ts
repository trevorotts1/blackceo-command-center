import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { selectPersonaForTask } from '@/lib/persona-selector';

/**
 * POST /api/persona-assignment
 *
 * Auto-suggest + attach a persona to a single task. Used by the TaskModal's
 * "Auto-suggest persona" CTA when the backend's Triad gate refuses a task
 * for missing persona_id.
 *
 * Body: { task_id: string, auto_assign?: boolean }
 *  - When auto_assign=true (the dashboard's default), the chosen persona_id
 *    is written back to the tasks row so the next status PATCH satisfies
 *    the Triad Rule.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const taskId = body?.task_id as string | undefined;
    const autoAssign = body?.auto_assign !== false;
    if (!taskId) {
      return NextResponse.json({ error: 'task_id is required' }, { status: 400 });
    }

    const db = getDb();
    const task = db.prepare(
      'SELECT id, title, description, department FROM tasks WHERE id = ?'
    ).get(taskId) as
      | { id: string; title: string; description: string | null; department: string | null }
      | undefined;
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const textForScoring = [task.title, task.description].filter(Boolean).join('\n\n');
    const result = await selectPersonaForTask(task.id, textForScoring, task.department);

    if (!result || !result.persona_id) {
      return NextResponse.json(
        { error: 'No persona match found', result },
        { status: 422 }
      );
    }

    if (autoAssign) {
      db.prepare(
        `UPDATE tasks
          SET persona_id = ?, persona_name = ?, persona_mode = ?, persona_score = ?,
              persona_selected_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`
      ).run(
        result.persona_id,
        result.persona_name,
        result.interaction_mode,
        result.score,
        task.id
      );
    }

    return NextResponse.json({
      success: true,
      task_id: task.id,
      persona: result,
      assigned: autoAssign,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * GET /api/persona-assignment
 *
 * Returns the live persona_assignment table — which persona is governing
 * each (department, task_category) pair right now.
 *
 * Optional query params:
 *   ?department=<id>     filter to one department
 *   ?limit=<n>           cap rows (default 200)
 *   ?include_verification=true  include verification_json blob per row
 *
 * Wave 4 of the post-analysis remediation. Phase 11 CC4 scored 5.0 because
 * the API/DB tables existed but no code wrote to them. After Wave 4.1
 * (persona-selector-v2.py auto-writes), this endpoint has live data to
 * surface.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const department = url.searchParams.get('department');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
    const includeVerification = url.searchParams.get('include_verification') === 'true';

    const db = getDb();

    // Be tolerant: persona_assignment was added in migration 019. If the
    // dashboard is running against an older DB, return an empty result with
    // a hint instead of 500.
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='persona_assignment'"
    ).all();
    if (tables.length === 0) {
      return NextResponse.json({
        success: true,
        assignments: [],
        message: 'persona_assignment table missing — run migrations to upgrade.',
      });
    }

    // Pull column list once so we can include verification fields only if
    // present (added in Wave 4 — verify-persona-adherence.py creates them
    // lazily on first verification write).
    const cols = db.prepare("PRAGMA table_info(persona_assignment)").all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    const hasVerification = colNames.has('verification_json');

    const baseFields = [
      'id', 'department_id', 'task_category', 'persona_id', 'persona_name',
      'persona_mode', 'persona_version', 'last_score', 'last_assigned_at',
      'switch_count',
    ];
    const verificationFields = ['verification_last_score', 'verification_count'];
    if (hasVerification && includeVerification) verificationFields.push('verification_json');

    const selectFields = [
      ...baseFields,
      ...(hasVerification ? verificationFields : []),
    ].join(', ');

    let rows: Array<Record<string, unknown>>;
    if (department) {
      rows = db.prepare(
        `SELECT ${selectFields} FROM persona_assignment
          WHERE department_id = ? OR department_id = ?
          ORDER BY last_assigned_at DESC LIMIT ?`
      ).all(department, `dept-${department}`, limit) as Array<Record<string, unknown>>;
    } else {
      rows = db.prepare(
        `SELECT ${selectFields} FROM persona_assignment
          ORDER BY last_assigned_at DESC LIMIT ?`
      ).all(limit) as Array<Record<string, unknown>>;
    }

    // Parse verification_json (string) → object for client convenience
    if (hasVerification && includeVerification) {
      for (const r of rows) {
        const raw = r.verification_json;
        if (typeof raw === 'string' && raw.length > 0) {
          try {
            r.verification = JSON.parse(raw);
          } catch {
            r.verification = null;
          }
          delete r.verification_json;
        }
      }
    }

    return NextResponse.json({
      success: true,
      assignments: rows,
      count: rows.length,
      verification_available: hasVerification,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
