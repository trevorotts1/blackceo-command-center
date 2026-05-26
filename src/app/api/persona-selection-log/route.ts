import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const department = searchParams.get('department');
  const limit = parseInt(searchParams.get('limit') || '20', 10);

  const db = getDb();
  let query = `
    SELECT psl.*, t.title as task_title
    FROM persona_selection_log psl
    LEFT JOIN tasks t ON t.id = psl.task_id
  `;
  const params: any[] = [];
  if (department) {
    query += ' WHERE psl.department_id = ?';
    params.push(department);
  }
  query += ' ORDER BY psl.selected_at DESC LIMIT ?';
  params.push(limit);

  const entries = db.prepare(query).all(...params) as any[];
  return NextResponse.json({
    entries: entries.map((e) => ({
      ...e,
      layer_scores: e.layer_scores ? JSON.parse(e.layer_scores) : {},
    })),
  });
}
