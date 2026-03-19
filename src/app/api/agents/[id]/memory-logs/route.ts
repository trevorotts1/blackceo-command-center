import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { writeAgentDailyLog } from '@/lib/agent-files';
import type { Agent, AgentMemoryLog } from '@/lib/types';

// GET /api/agents/[id]/memory-logs - List daily logs for an agent
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const limit = request.nextUrl.searchParams.get('limit') || '30';

    const logs = queryAll<AgentMemoryLog>(
      `SELECT * FROM agent_memory_logs WHERE agent_id = ? ORDER BY log_date DESC LIMIT ?`,
      [id, parseInt(limit)]
    );

    return NextResponse.json(logs);
  } catch (error) {
    console.error('Failed to fetch memory logs:', error);
    return NextResponse.json({ error: 'Failed to fetch memory logs' }, { status: 500 });
  }
}

// POST /api/agents/[id]/memory-logs - Create or update a daily log
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    if (!body.log_date || !body.content) {
      return NextResponse.json({ error: 'log_date and content are required' }, { status: 400 });
    }

    // Upsert: update if exists for this agent+date, insert if not
    const existing = queryOne<AgentMemoryLog>(
      `SELECT * FROM agent_memory_logs WHERE agent_id = ? AND log_date = ?`,
      [id, body.log_date]
    );

    const now = new Date().toISOString();

    // Get agent name for file sync
    const agent = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [id]);

    if (existing) {
      run(
        `UPDATE agent_memory_logs SET content = ?, updated_at = ? WHERE id = ?`,
        [body.content, now, existing.id]
      );
      // Sync to disk
      if (agent) writeAgentDailyLog(agent.name, body.log_date, body.content);
      const updated = queryOne<AgentMemoryLog>('SELECT * FROM agent_memory_logs WHERE id = ?', [existing.id]);
      return NextResponse.json(updated);
    } else {
      const logId = uuidv4();
      run(
        `INSERT INTO agent_memory_logs (id, agent_id, log_date, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [logId, id, body.log_date, body.content, now, now]
      );
      // Sync to disk
      if (agent) writeAgentDailyLog(agent.name, body.log_date, body.content);
      const created = queryOne<AgentMemoryLog>('SELECT * FROM agent_memory_logs WHERE id = ?', [logId]);
      return NextResponse.json(created, { status: 201 });
    }
  } catch (error) {
    console.error('Failed to save memory log:', error);
    return NextResponse.json({ error: 'Failed to save memory log' }, { status: 500 });
  }
}
