import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DEPARTMENTS_CONFIG_PATH = join(process.cwd(), 'config', 'departments.json');

// Helper to remove workspace from departments.json
async function removeWorkspaceFromDepartments(slug: string) {
  try {
    const raw = await readFile(DEPARTMENTS_CONFIG_PATH, 'utf-8');
    const departments = JSON.parse(raw) as Array<{
      id: string;
      emoji: string;
      name: string;
      headTitle: string;
      workspacePath?: string;
    }>;

    const filtered = departments.filter((d) => d.id !== slug);

    if (filtered.length < departments.length) {
      await writeFile(DEPARTMENTS_CONFIG_PATH, JSON.stringify(filtered, null, 2), 'utf-8');
      console.log(`[Workspaces API] Removed workspace "${slug}" from departments.json`);
    }
  } catch (err) {
    console.error('[Workspaces API] Failed to remove from departments.json:', err);
    // Don't throw - workspace deletion should succeed even if sync fails
  }
}

// GET /api/workspaces/[id] - Get a single workspace
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const db = getDb();

    // Try to find by ID or slug
    const workspace = db.prepare(
      'SELECT * FROM workspaces WHERE id = ? OR slug = ?'
    ).get(id, id);

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Failed to fetch workspace:', error);
    return NextResponse.json({ error: 'Failed to fetch workspace' }, { status: 500 });
  }
}

// PATCH /api/workspaces/[id] - Update a workspace
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { name, description, icon } = body;

    const db = getDb();

    // Check workspace exists and get current data
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as { id: string; slug: string; name: string; icon?: string | null } | undefined;
    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Build update query dynamically
    const updates: string[] = [];
    const values: unknown[] = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (icon !== undefined) {
      updates.push('icon = ?');
      values.push(icon);
    }
    if (body.sort_order !== undefined) {
      updates.push('sort_order = ?');
      values.push(body.sort_order);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`
      UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);

    // Sync update to departments.json if name or icon changed
    if (name !== undefined || icon !== undefined) {
      try {
        const raw = await readFile(DEPARTMENTS_CONFIG_PATH, 'utf-8');
        const departments = JSON.parse(raw) as Array<{
          id: string;
          emoji: string;
          name: string;
          headTitle: string;
          workspacePath?: string;
        }>;

        const deptIndex = departments.findIndex((d) => d.id === existing.slug);
        if (deptIndex >= 0) {
          if (name !== undefined) departments[deptIndex].name = name;
          if (icon !== undefined) departments[deptIndex].emoji = icon;
          await writeFile(DEPARTMENTS_CONFIG_PATH, JSON.stringify(departments, null, 2), 'utf-8');
        }
      } catch (err) {
        console.error('[Workspaces API] Failed to sync update to departments.json:', err);
      }
    }

    // Fetch updated workspace
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Failed to update workspace:', error);
    return NextResponse.json({ error: 'Failed to update workspace' }, { status: 500 });
  }
}

// DELETE /api/workspaces/[id] - Delete a workspace
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const db = getDb();

    // Don't allow deleting the default workspace
    if (id === 'default') {
      return NextResponse.json({ error: 'Cannot delete the default workspace' }, { status: 400 });
    }

    // Check workspace exists
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as { slug: string } | undefined;
    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Check if workspace has tasks or agents
    const taskCount = db.prepare(
      'SELECT COUNT(*) as count FROM tasks WHERE workspace_id = ?'
    ).get(id) as { count: number };

    const agentCount = db.prepare(
      'SELECT COUNT(*) as count FROM agents WHERE workspace_id = ?'
    ).get(id) as { count: number };

    if (taskCount.count > 0 || agentCount.count > 0) {
      return NextResponse.json({
        error: 'Cannot delete workspace with existing tasks or agents',
        taskCount: taskCount.count,
        agentCount: agentCount.count
      }, { status: 400 });
    }

    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);

    // Remove from departments.json
    await removeWorkspaceFromDepartments(existing.slug);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete workspace:', error);
    return NextResponse.json({ error: 'Failed to delete workspace' }, { status: 500 });
  }
}
