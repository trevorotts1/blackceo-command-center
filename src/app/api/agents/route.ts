import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { createAgentFolder } from '@/lib/agent-files';
import { resolveDepartment } from '@/lib/routing/resolve-department';
import type { Agent, CreateAgentRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/agents - List agents, optionally scoped to a workspace or department.
//
// U56 (E.2 / JM-U52) — the department detail page (`/ceo-board/[dept]`) calls
// this with `?department=<slug>` and reads the response's `agents` key. Before
// this fix the route only read `workspace_id` (an exact id match — the page's
// `deptId` route param is frequently a SLUG, not the workspace id) and
// returned a bare array, so `agentData.agents` was always `undefined` and the
// "Department Agents" section could never render real rows. `department`
// resolves through the SAME `resolveDepartment()` the page/`/workspace/[slug]`
// already use (slug-or-id → real workspace id), so it works for both forms.
// `workspace_id` keeps its original exact-id semantics for existing callers
// (`/workspace/[slug]`, `AgentsSidebar`) that already resolve the id upstream.
export async function GET(request: NextRequest) {
  try {
    const departmentParam = request.nextUrl.searchParams.get('department');
    const workspaceIdParam = request.nextUrl.searchParams.get('workspace_id');

    let agents: Agent[];
    if (departmentParam) {
      const resolved = await resolveDepartment(departmentParam);
      agents = resolved
        ? queryAll<Agent>(
            `SELECT * FROM agents WHERE workspace_id = ? ORDER BY is_master DESC, name ASC`,
            [resolved.id],
          )
        : [];
    } else if (workspaceIdParam) {
      agents = queryAll<Agent>(`
        SELECT * FROM agents WHERE workspace_id = ? ORDER BY is_master DESC, name ASC
      `, [workspaceIdParam]);
    } else {
      agents = queryAll<Agent>(`
        SELECT * FROM agents ORDER BY is_master DESC, name ASC
      `);
    }
    return NextResponse.json({ agents });
  } catch (error) {
    console.error('Failed to fetch agents:', error);
    return NextResponse.json({ error: 'Failed to fetch agents' }, { status: 500 });
  }
}

// POST /api/agents - Create a new agent
export async function POST(request: NextRequest) {
  try {
    const body: CreateAgentRequest = await request.json();

    if (!body.name || !body.role) {
      return NextResponse.json({ error: 'Name and role are required' }, { status: 400 });
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const workspaceId = (body as { workspace_id?: string }).workspace_id || 'default';
    // Master agents and department heads (assigned to a workspace) are permanent.
    // Only agents without a workspace assignment are on-call (likely spawned sub-agents).
    const specialistType = body.is_master || workspaceId !== 'default' ? 'permanent' : 'on-call';

    run(
      `INSERT INTO agents (id, name, role, description, avatar_emoji, is_master, workspace_id, soul_md, user_md, agents_md, tools_md, memory_md, model, specialist_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        body.name,
        body.role,
        body.description || null,
        body.avatar_emoji || '🤖',
        body.is_master ? 1 : 0,
        workspaceId,
        body.soul_md || null,
        body.user_md || null,
        body.agents_md || null,
        body.tools_md || null,
        body.memory_md || null,
        body.model || null,
        specialistType,
        now,
        now,
      ]
    );

    // Log event
    run(
      `INSERT INTO events (id, type, agent_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'agent_joined', id, `${body.name} joined the team`, now]
    );

    // Create agent folder with template files
    createAgentFolder(body.name, body.role, body.model || 'default');

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    return NextResponse.json(agent, { status: 201 });
  } catch (error) {
    console.error('Failed to create agent:', error);
    return NextResponse.json({ error: 'Failed to create agent' }, { status: 500 });
  }
}
