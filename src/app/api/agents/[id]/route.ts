import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import { writeAgentFile, deleteAgentFolder, checkSharedFileSymlink, SharedFileSymlinkError } from '@/lib/agent-files';
import type { Agent, UpdateAgentRequest } from '@/lib/types';
export const dynamic = 'force-dynamic'; export const revalidate = 0;
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const { id } = await params; const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]); if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 }); return NextResponse.json(agent); } catch (error) { console.error('GET agent error:', error); return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 }); }
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params; const body: UpdateAgentRequest = await req.json();
    const existing = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!existing) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    const updates: string[] = []; const values: unknown[] = [];
    if (body.name !== undefined) { updates.push('name = ?'); values.push(body.name); }
    if (body.role !== undefined) { updates.push('role = ?'); values.push(body.role); }
    if (body.description !== undefined) { updates.push('description = ?'); values.push(body.description); }
    if (body.avatar_emoji !== undefined) { updates.push('avatar_emoji = ?'); values.push(body.avatar_emoji); }
    if (body.status !== undefined) { updates.push('status = ?'); values.push(body.status); run(`INSERT INTO events (id, type, agent_id, message, created_at) VALUES (?, ?, ?, ?, ?)`, [uuidv4(), 'agent_status_changed', id, `${existing.name} is now ${body.status}`, new Date().toISOString()]); }
    if (body.is_master !== undefined) { updates.push('is_master = ?'); values.push(body.is_master ? 1 : 0); }
    if (body.soul_md !== undefined) { updates.push('soul_md = ?'); values.push(body.soul_md); }
    if (body.user_md !== undefined) { updates.push('user_md = ?'); values.push(body.user_md); }
    if (body.agents_md !== undefined) { updates.push('agents_md = ?'); values.push(body.agents_md); }
    if (body.tools_md !== undefined) { updates.push('tools_md = ?'); values.push(body.tools_md); }
    if (body.memory_md !== undefined) { updates.push('memory_md = ?'); values.push(body.memory_md); }
    if (body.model !== undefined) { updates.push('model = ?'); values.push(body.model); }
    if ((body as any).specialist_type !== undefined) { updates.push('specialist_type = ?'); values.push((body as any).specialist_type); }
    if (updates.length === 0) return NextResponse.json({ error: 'No updates provided' }, { status: 400 });
    for (const field of ['agents_md', 'tools_md'] as const) { if (body[field] !== undefined && checkSharedFileSymlink(existing.name, field)) { return NextResponse.json({ error: 'Shared file conflict', message: `Cannot write "${field}" — symlink to shared template. Edit agents/_shared/ directly.`, field }, { status: 409 }); } }
    updates.push('updated_at = ?'); values.push(new Date().toISOString()); values.push(id);
    run(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`, values);
    for (const field of ['soul_md', 'user_md', 'agents_md', 'tools_md', 'memory_md'] as const) { if (body[field] !== undefined) writeAgentFile(existing.name, field, body[field] || ''); }
    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]); return NextResponse.json(agent);
  } catch (error) { if (error instanceof SharedFileSymlinkError) { return NextResponse.json({ error: 'Shared file conflict', message: error.message, field: error.column }, { status: 409 }); } console.error('PATCH agent error:', error); return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 }); }
}
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const { id } = await params; const e = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]); if (!e) return NextResponse.json({ error: 'Agent not found' }, { status: 404 }); run('DELETE FROM openclaw_sessions WHERE agent_id = ?', [id]); run('DELETE FROM events WHERE agent_id = ?', [id]); run('DELETE FROM messages WHERE sender_agent_id = ?', [id]); run('DELETE FROM conversation_participants WHERE agent_id = ?', [id]); run('UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?', [id]); run('UPDATE tasks SET created_by_agent_id = NULL WHERE created_by_agent_id = ?', [id]); run('UPDATE task_activities SET agent_id = NULL WHERE agent_id = ?', [id]); run('DELETE FROM agents WHERE id = ?', [id]); deleteAgentFolder(e.name); return NextResponse.json({ success: true }); } catch (error) { console.error('DELETE agent error:', error); return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 }); }
}
