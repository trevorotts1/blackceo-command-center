import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { Workspace, WorkspaceStats, TaskStatus } from '@/lib/types';

// Helper to generate slug from name
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// GET /api/workspaces - List all workspaces with stats
export async function GET(request: NextRequest) {
  const includeStats = request.nextUrl.searchParams.get('stats') === 'true';

  try {
    const db = getDb();

    if (includeStats) {
      // Get workspaces with task counts and agent counts, ordered by sort_order
      const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY sort_order ASC, name ASC').all() as Workspace[];

      const stats: WorkspaceStats[] = workspaces.map(workspace => {
        // Get task counts by status
        const taskCounts = db.prepare(`
          SELECT status, COUNT(*) as count
          FROM tasks
          WHERE workspace_id = ?
          GROUP BY status
        `).all(workspace.id) as { status: TaskStatus; count: number }[];

        const counts: WorkspaceStats['taskCounts'] = {
          backlog: 0,
          in_progress: 0,
          review: 0,
          blocked: 0,
          done: 0,
          total: 0
        };

        taskCounts.forEach(tc => {
          if (tc.status in counts) {
            (counts as Record<string, number>)[tc.status] = tc.count;
          }
          counts.total += tc.count;
        });

        // Get agent count
        const agentCount = db.prepare(
          'SELECT COUNT(*) as count FROM agents WHERE workspace_id = ?'
        ).get(workspace.id) as { count: number };

        return {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          icon: workspace.icon,
          sort_order: workspace.sort_order,
          taskCounts: counts,
          agentCount: agentCount.count
        };
      });

      return NextResponse.json(stats);
    }

    const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY sort_order ASC, name ASC').all();
    return NextResponse.json(workspaces);
  } catch (error) {
    console.error('Failed to fetch workspaces:', error);
    return NextResponse.json({ error: 'Failed to fetch workspaces' }, { status: 500 });
  }
}

// PUT /api/workspaces - Bulk reorder workspaces
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { order } = body as { order: string[] };

    if (!Array.isArray(order) || order.length === 0) {
      return NextResponse.json({ error: 'order must be a non-empty array of workspace IDs' }, { status: 400 });
    }

    const db = getDb();

    // Update sort_order for each workspace in the given order
    const stmt = db.prepare('UPDATE workspaces SET sort_order = ?, updated_at = datetime(\'now\') WHERE id = ?');
    const updateAll = db.transaction(() => {
      for (let i = 0; i < order.length; i++) {
        stmt.run(i + 1, order[i]);
      }
    });
    updateAll();

    // Return updated workspaces in new order
    const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY sort_order ASC, name ASC').all();
    return NextResponse.json(workspaces);
  } catch (error) {
    console.error('Failed to reorder workspaces:', error);
    return NextResponse.json({ error: 'Failed to reorder workspaces' }, { status: 500 });
  }
}

// POST /api/workspaces - Create a new workspace
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, description, icon } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }

    const db = getDb();
    const id = crypto.randomUUID();
    const slug = generateSlug(name);

    // Check if slug already exists
    const existing = db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug);
    if (existing) {
      return NextResponse.json({ error: 'A workspace with this name already exists' }, { status: 400 });
    }

    // Get max sort_order and place new workspace at the end
    const maxOrder = db.prepare('SELECT MAX(sort_order) as max_order FROM workspaces').get() as { max_order: number | null };
    const nextOrder = (maxOrder.max_order || 0) + 10;

    db.prepare(`
      INSERT INTO workspaces (id, name, slug, description, icon, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name.trim(), slug, description || null, icon || '📁', nextOrder);

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    return NextResponse.json(workspace, { status: 201 });
  } catch (error) {
    console.error('Failed to create workspace:', error);
    return NextResponse.json({ error: 'Failed to create workspace' }, { status: 500 });
  }
}
