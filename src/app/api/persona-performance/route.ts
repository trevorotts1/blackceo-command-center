import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// Route reads runtime query params + runs SQLite queries at request time.
// Opt out of static prerender to avoid build-time DB execution.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const db = getDb();
  const { searchParams } = new URL(request.url);
  const period = searchParams.get('period') || '30d';
  const department = searchParams.get('department');

  let cutoff = "-30 days";
  if (period === '7d') cutoff = "-7 days";
  else if (period === '90d') cutoff = "-90 days";
  else if (period === 'all') cutoff = "-99999 days";

  let query = `
    SELECT persona_id,
           COUNT(*) AS tasks_completed,
           AVG(score_at_selection) AS avg_score,
           AVG(owner_rating) AS avg_rating,
           AVG(revision_count) AS avg_revisions,
           AVG(time_to_complete_seconds) AS avg_time_seconds
    FROM persona_performance
    WHERE completed_at >= datetime('now', ?)
  `;
  const params: any[] = [cutoff];
  if (department) {
    query += ' AND department_id = ?';
    params.push(department);
  }
  query += ' GROUP BY persona_id ORDER BY tasks_completed DESC';

  const rows = db.prepare(query).all(...params);
  return NextResponse.json({ period, department, rows });
}
