import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import { writeAgentFile, deleteAgentFolder, checkSharedFileSymlink } from '@/lib/agent-files';
import type { Agent, UpdateAgentRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const { id } = await params; const a = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]); if (!a) return NextResponse.json({ error: 'Agent not found' }, { status: 404 }); return NextResponse.json(a); } catch (e) { console.error('GET:', e); return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 }); }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body: UpdateAgentRequest = await req.json();
    const ex = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!ex) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const u: string[] = [];
    const v: unknown[] = [];
    if (body.name !== undefined) { u.push('name = ?'); v.push(body.name); }
    if (body.role !== undefined) { u.push('role = ?'); v.push(body.role); }
    if (body.description !== undefined) { u.push('description = ?'); v.push(body.description); }
    if (body.avatar_emoji !== undefined) { u.push('avatar_emoji = ?'); v.push(body.avatar_emoji); }
    if (body.status !== undefined) { u.push('status = ?'); v.push(body.status); run('INSERT INTO events (id, type, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?)', [uuidv4(), 'agent_status_changed', id, `${ex.name} is now ${body.status}`, new Date().toISOString()]); }
    if (body.is_master !== undefined) { u.push('is_master = ?'); v.push(body.is_master ? 1 : 0); }
    if (body.soul_md !== undefined) { u.push('soul_md = ?'); v.push(body.soul_md); }
    if (body.user_md !== undefined) { u.push('user_md = ?'); v.push(body.user_md); }
    if (body.agents_md !== undefined) { u.push('agents_md = ?'); v.push(body.agents_md); }
    if (body.tools_md !== undefined) { u.push('tools_md = ?'); v.push(body.tools_md); }
    if (body.memory_md !== undefined) { u.push('memory_md = ?'); v.push(body.memory_md); }
    if (body.model !== undefined) { u.push('model = ?'); v.push(body.model); }
    if ((body as any).specialist_type !== undefined) { u.push('specialist_type = ?'); v.push((body as any).specialist_type); }

    if (u.length === 0) return NextResponse.json({ error: 'No updates provided' }, { status: 400 });

    // U088 preflight: reject shared-field symlink writes before DB update
    for (const f of ['agents_md', 'tools_md'] as const) {
      if (body[f] !== undefined && checkSharedFileSymlink(ex.name, f)) {
        const fn = f === 'agents_md' ? 'AGENTS.md' : 'TOOLS.md';
        return NextResponse.json({ error: 'shared_file_conflict', message: `Cannot write "${fn}" — symlink to shared template. Edit agents/_shared/ directly.`, column: f, filename: fn, agent: ex.name }, { status: 409 });
      }
    }

    u.push('updated_at = ?'); v.push(new Date().toISOString()); v.push(id);
    run(`UPDATE agents SET ${u.join(', ')} WHERE id = ?`, v);

    for (const f of ['soul_md', 'agents_md', 'tools_md', 'memory_md'] as const) {
      if (body[f] !== undefined) writeAgentFile(ex.name, f, body[f] || '');
    }

    const a = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    return NextResponse.json(a);
  } catch (e) { console.error('PATCH:', e); return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 }); }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ex = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!ex) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    run('DELETE FROM openclaw_sessions WHERE agent_id = ?', [id]);
    run('DELETE FROM events WHERE agent_id = ?', [id]);
    run('DELETE FROM messages WHERE sender_agent_id = ?', [id]);
    run('DELETE FROM conversation_participants WHERE agent_id = ?', [id]);
    run('UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?', [id]);
    run('UPDATE tasks SET created_by_agent_id = NULL WHERE created_by_agent_id = ?', [id]);
    run('UPDATE task_activities SET agent_id = NULL WHERE agent_id = ?', [id]);
    run('DELETE FROM agents WHERE id = ?', [id]);
    deleteAgentFolder(ex.name);
    return NextResponse.json({ success: true });
  } catch (e) { console.error('DELETE:', e); return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 }); }
}
