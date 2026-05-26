import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = getDb();
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(params.id);
  if (!campaign) {
    return NextResponse.json({ error: 'campaign not found' }, { status: 404 });
  }
  return NextResponse.json({ campaign });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const db = getDb();
  const body = await req.json();
  const allowed = ['name', 'description', 'status', 'department_ids', 'start_date', 'target_date'];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const key of allowed) {
    if (key in body) {
      sets.push(`${key} = ?`);
      vals.push(key === 'department_ids' && typeof body[key] !== 'string' ? JSON.stringify(body[key]) : body[key]);
    }
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 });
  }
  sets.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(params.id);

  const result = db.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  if (result.changes === 0) {
    return NextResponse.json({ error: 'campaign not found' }, { status: 404 });
  }
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(params.id);
  return NextResponse.json({ campaign });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = getDb();
  const result = db.prepare('DELETE FROM campaigns WHERE id = ?').run(params.id);
  if (result.changes === 0) {
    return NextResponse.json({ error: 'campaign not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
