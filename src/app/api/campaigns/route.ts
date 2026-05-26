import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const db = getDb();
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get('workspace_id');

  let query = 'SELECT * FROM campaigns';
  const params: any[] = [];
  if (workspaceId) {
    query += ' WHERE workspace_id = ?';
    params.push(workspaceId);
  }
  query += ' ORDER BY created_at DESC';

  const campaigns = db.prepare(query).all(...params);
  return NextResponse.json({ campaigns });
}

export async function POST(request: NextRequest) {
  const db = getDb();
  const body = await request.json();

  if (!body.name || typeof body.name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const id = body.id || crypto.randomUUID();

  db.prepare(`
    INSERT INTO campaigns (id, name, description, status, department_ids, start_date, target_date, workspace_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    body.name,
    body.description || '',
    'planning',
    JSON.stringify(body.department_ids || []),
    body.start_date || null,
    body.target_date || null,
    body.workspace_id || null,
    now,
    now,
  );

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  return NextResponse.json({ campaign }, { status: 201 });
}
