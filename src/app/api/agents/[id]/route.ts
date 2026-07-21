import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import {
  writeAgentFile,
  deleteAgentFolder,
  sharedFileTarget,
  inheritedFields,
  SharedFileError,
} from '@/lib/agent-files';
import type { Agent, UpdateAgentRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/agents/[id] - Get a single agent
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // CC-SHARED-001: name the fields whose file is inherited (a symlink into
    // agents/_shared). The editor renders those read-only rather than offering
    // a save that the update route will refuse.
    return NextResponse.json({ ...agent, inherited_fields: inheritedFields(agent.name) });
  } catch (error) {
    console.error('Failed to fetch agent:', error);
    return NextResponse.json({ error: 'Failed to fetch agent' }, { status: 500 });
  }
}

// PATCH /api/agents/[id] - Update an agent
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body: UpdateAgentRequest = await request.json();

    const existing = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!existing) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // CC-SHARED-001 (T1-04 / T0-43): PREFLIGHT the shared fields BEFORE the
    // database write. Previously the database was updated first and the disk
    // sync ran afterwards, so a refusal here would have left the database and
    // the disk disagreeing. Every column the interface exposes is checked, so a
    // save either changes both the record and the file or changes neither.
    const MD_FIELDS = ['soul_md', 'user_md', 'agents_md', 'tools_md', 'memory_md'] as const;
    const inherited = MD_FIELDS.filter(
      (field) => body[field] !== undefined && sharedFileTarget(existing.name, field) !== null
    );
    if (inherited.length > 0) {
      const first = inherited[0];
      return NextResponse.json(
        {
          error:
            `${first} is inherited: every agent shares this file, so an agent-scoped save cannot change it. ` +
            `Editing it here would rewrite the same file for every agent in the company. ` +
            `Change it once, deliberately, as a shared file.`,
          code: 'SHARED_FILE',
          fields: inherited,
          shared_targets: Object.fromEntries(
            inherited.map((field) => [field, sharedFileTarget(existing.name, field)])
          ),
        },
        { status: 409 }
      );
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.role !== undefined) {
      updates.push('role = ?');
      values.push(body.role);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(body.description);
    }
    if (body.avatar_emoji !== undefined) {
      updates.push('avatar_emoji = ?');
      values.push(body.avatar_emoji);
    }
    if (body.status !== undefined) {
      updates.push('status = ?');
      values.push(body.status);

      // Log status change event
      const now = new Date().toISOString();
      run(
        `INSERT INTO events (id, type, agent_id, message, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'agent_status_changed', id, `${existing.name} is now ${body.status}`, now]
      );
    }
    if (body.is_master !== undefined) {
      updates.push('is_master = ?');
      values.push(body.is_master ? 1 : 0);
    }
    if (body.soul_md !== undefined) {
      updates.push('soul_md = ?');
      values.push(body.soul_md);
    }
    if (body.user_md !== undefined) {
      updates.push('user_md = ?');
      values.push(body.user_md);
    }
    if (body.agents_md !== undefined) {
      updates.push('agents_md = ?');
      values.push(body.agents_md);
    }
    if (body.tools_md !== undefined) {
      updates.push('tools_md = ?');
      values.push(body.tools_md);
    }
    if (body.memory_md !== undefined) {
      updates.push('memory_md = ?');
      values.push(body.memory_md);
    }
    if (body.model !== undefined) {
      updates.push('model = ?');
      values.push(body.model);
    }
    if ((body as { specialist_type?: string }).specialist_type !== undefined) {
      updates.push('specialist_type = ?');
      values.push((body as { specialist_type: string }).specialist_type);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No updates provided' }, { status: 400 });
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    run(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`, values);

    // Sync .md files to disk. The preflight above already refused every
    // inherited field, so a SharedFileError here means the filesystem changed
    // under the request — surface it rather than reporting a save that the disk
    // did not take.
    for (const field of MD_FIELDS) {
      if (body[field] !== undefined) {
        writeAgentFile(existing.name, field, body[field] || '');
      }
    }

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    return NextResponse.json({ ...agent, inherited_fields: inheritedFields(existing.name) });
  } catch (error) {
    if (error instanceof SharedFileError) {
      console.error('Refused an agent-scoped write through a shared file:', error.message);
      return NextResponse.json(
        {
          error: error.message,
          code: 'SHARED_FILE',
          fields: [error.column],
          shared_targets: { [error.column]: error.sharedTarget },
        },
        { status: 409 }
      );
    }
    console.error('Failed to update agent:', error);
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
  }
}

// DELETE /api/agents/[id] - Delete an agent
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);

    if (!existing) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Delete or nullify related records first (foreign key constraints)
    run('DELETE FROM openclaw_sessions WHERE agent_id = ?', [id]);
    run('DELETE FROM events WHERE agent_id = ?', [id]);
    run('DELETE FROM messages WHERE sender_agent_id = ?', [id]);
    run('DELETE FROM conversation_participants WHERE agent_id = ?', [id]);
    run('UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?', [id]);
    run('UPDATE tasks SET created_by_agent_id = NULL WHERE created_by_agent_id = ?', [id]);
    run('UPDATE task_activities SET agent_id = NULL WHERE agent_id = ?', [id]);

    // Now delete the agent
    run('DELETE FROM agents WHERE id = ?', [id]);

    // Remove agent folder from disk
    deleteAgentFolder(existing.name);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete agent:', error);
    return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 });
  }
}
