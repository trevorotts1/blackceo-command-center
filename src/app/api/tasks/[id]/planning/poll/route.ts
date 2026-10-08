import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run, getDb } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { extractJSON, fetchMessagesFromOpenClaw, buildPlanContext, PLAN_CONTEXT_MARKER, PLANNING_REPROMPT } from '@/lib/planning-utils';
import { Task } from '@/lib/types';
import { recordStatusEvent } from '@/lib/task-lifecycle';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Planning timeout and poll interval configuration with validation
const PLANNING_TIMEOUT_MS = parseInt(process.env.PLANNING_TIMEOUT_MS || '30000', 10);
const PLANNING_POLL_INTERVAL_MS = parseInt(process.env.PLANNING_POLL_INTERVAL_MS || '2000', 10);

// Validate environment variables
if (isNaN(PLANNING_TIMEOUT_MS) || PLANNING_TIMEOUT_MS < 1000) {
  throw new Error('PLANNING_TIMEOUT_MS must be a valid number >= 1000ms');
}
if (isNaN(PLANNING_POLL_INTERVAL_MS) || PLANNING_POLL_INTERVAL_MS < 100) {
  throw new Error('PLANNING_POLL_INTERVAL_MS must be a valid number >= 100ms');
}

// Helper to handle planning completion. Planning creates NO agent rows: the
// planned roles stay in planning_agents and are folded into the task
// description, and the task is released (backlog, planning_complete=1) so
// intake-advance routes it to the department's real specialist.
async function handlePlanningCompletion(taskId: string, parsed: any, messages: any[]) {
  const db = getDb();
  const priorStatus = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])?.status ?? 'planning';
  const planContext = buildPlanContext(parsed);

  // U99-RAW-STATUS-WRITER: compound single-row UPDATE (plan fields must land
  // atomically with the status flip); audited via recordStatusEvent below.
  db.prepare(`
    UPDATE tasks
    SET planning_messages = ?,
        planning_spec = ?,
        planning_agents = ?,
        description = CASE WHEN instr(COALESCE(description,''), ?) > 0 THEN description
                           ELSE COALESCE(description,'') || char(10) || char(10) || ? END,
        status = 'backlog',
        planning_complete = 1,
        planning_dispatch_error = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    JSON.stringify(messages),
    JSON.stringify(parsed.spec),
    JSON.stringify(parsed.agents),
    PLAN_CONTEXT_MARKER,
    planContext,
    taskId
  );
  if (priorStatus !== 'backlog') {
    recordStatusEvent(taskId, priorStatus, 'backlog', {
      actor: 'planning-poll',
      reason: 'planning complete; routed by department',
    });
  }

  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }

  return { parsed, dispatchError: null as string | null };
}

// Ask the agent once more, in the same session, for the required JSON.
async function sendReprompt(taskId: string, sessionKey: string, messages: any[]) {
  const client = getOpenClawClient();
  if (!client.isConnected()) await client.connect();
  await client.call('chat.send', {
    sessionKey,
    message: PLANNING_REPROMPT,
    idempotencyKey: `planning-reprompt-${taskId}-${Date.now()}`,
  });
  messages.push({ role: 'user', content: PLANNING_REPROMPT, timestamp: Date.now(), reprompt: true });
  run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(messages), taskId]);
}

// POST /api/tasks/[id]/planning/poll - "Try again" after an unusable reply: re-prompt in the same session.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;
  const task = queryOne<{ planning_session_key?: string; planning_messages?: string; planning_complete?: number }>(
    'SELECT planning_session_key, planning_messages, planning_complete FROM tasks WHERE id = ?', [taskId]);
  if (!task?.planning_session_key || task.planning_complete) {
    return NextResponse.json({ error: 'Planning session not found' }, { status: 404 });
  }
  try {
    await sendReprompt(taskId, task.planning_session_key, task.planning_messages ? JSON.parse(task.planning_messages) : []);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to re-prompt planning agent:', error);
    return NextResponse.json({ error: 'Failed to reach your AI assistant', gatewayError: true }, { status: 502 });
  }
}

// GET /api/tasks/[id]/planning/poll - Check for new messages from OpenClaw
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      planning_messages?: string;
      planning_complete?: number;
      planning_dispatch_error?: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task || !task.planning_session_key) {
      return NextResponse.json({ error: 'Planning session not found' }, { status: 404 });
    }

    if (task.planning_complete) {
      return NextResponse.json({ hasUpdates: false, isComplete: true });
    }

    // Return dispatch error if present (allows user to see/ retry failed dispatch)
    if (task.planning_dispatch_error) {
      return NextResponse.json({
        hasUpdates: true,
        dispatchError: task.planning_dispatch_error,
      });
    }

    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    // Count only assistant messages for comparison, since OpenClaw only returns assistant messages
    const initialAssistantCount = messages.filter((m: any) => m.role === 'assistant').length;

    console.log('[Planning Poll] Task', taskId, 'has', messages.length, 'total messages,', initialAssistantCount, 'assistant messages');

    // Check OpenClaw for new messages (lightweight check, not a loop)
    let openclawMessages: Array<{ role: string; content: string }>;
    try {
      openclawMessages = await fetchMessagesFromOpenClaw(task.planning_session_key);
    } catch (err) {
      // Distinct from "no reply yet": the gateway could not be reached.
      console.error('[Planning Poll] Gateway unreachable:', err);
      return NextResponse.json({ hasUpdates: false, gatewayError: true });
    }

    console.log('[Planning Poll] Comparison: stored_assistant=', initialAssistantCount, 'openclaw_assistant=', openclawMessages.length);

    if (openclawMessages.length > initialAssistantCount) {
      let currentQuestion = null;
      const newMessages = openclawMessages.slice(initialAssistantCount);
      console.log('[Planning Poll] Processing', newMessages.length, 'new messages');

      // Find new assistant messages
      for (const msg of newMessages) {
        console.log('[Planning Poll] Processing new message, role:', msg.role, 'content length:', msg.content?.length || 0);

        if (msg.role === 'assistant') {
          const lastMessage = { role: 'assistant', content: msg.content, timestamp: Date.now() };
          messages.push(lastMessage);

          // Check if this message contains completion status or a question
          const parsed = extractJSON(msg.content) as {
            status?: string;
            question?: string;
            options?: Array<{ id: string; label: string }>;
            spec?: object;
            agents?: Array<{
              name: string;
              role: string;
              avatar_emoji?: string;
              soul_md?: string;
              instructions?: string;
            }>;
            execution_plan?: object;
          } | null;

          console.log('[Planning Poll] Parsed message content:', {
            hasStatus: !!parsed?.status,
            hasQuestion: !!parsed?.question,
            hasOptions: !!parsed?.options,
            status: parsed?.status,
            question: parsed?.question?.substring(0, 50),
            rawPreview: msg.content?.substring(0, 200)
          });

          if (parsed && parsed.status === 'complete') {
            // Handle completion
            console.log('[Planning Poll] Planning complete, handling...');
            const { parsed: fullParsed, dispatchError } = await handlePlanningCompletion(taskId, parsed, messages);

            return NextResponse.json({
              hasUpdates: true,
              complete: true,
              spec: fullParsed.spec,
              agents: fullParsed.agents,
              executionPlan: fullParsed.execution_plan,
              messages,
              autoDispatched: false,
              dispatchError,
            });
          }

          // Extract current question if present
          if (parsed && parsed.question && parsed.options) {
            console.log('[Planning Poll] Found question with', parsed.options.length, 'options');
            currentQuestion = parsed;
          }
        }
      }

      // The last new reply is neither a question nor completion: re-prompt
      // ONCE (unless we already did for the reply before it), else surface it.
      const lastReply = messages[messages.length - 1];
      if (!currentQuestion && lastReply?.role === 'assistant') {
        const prev = messages[messages.length - 2];
        if (!prev?.reprompt) {
          try {
            run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(messages), taskId]);
            await sendReprompt(taskId, task.planning_session_key, messages);
            return NextResponse.json({ hasUpdates: false, reprompted: true });
          } catch (err) {
            console.error('[Planning Poll] Re-prompt failed:', err);
            return NextResponse.json({ hasUpdates: false, gatewayError: true });
          }
        }
        run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(messages), taskId]);
        return NextResponse.json({
          hasUpdates: true, complete: false, messages, currentQuestion: null, malformedReply: lastReply.content,
        });
      }

      console.log('[Planning Poll] Returning updates: currentQuestion =', currentQuestion ? 'YES' : 'NO');

      // Update database
      run('UPDATE tasks SET planning_messages = ? WHERE id = ?', [JSON.stringify(messages), taskId]);

      return NextResponse.json({
        hasUpdates: true,
        complete: false,
        messages,
        currentQuestion,
      });
    }

    console.log('[Planning Poll] No new messages found');
    return NextResponse.json({ hasUpdates: false });
  } catch (error) {
    console.error('Failed to poll for updates:', error);
    return NextResponse.json({ error: 'Failed to poll for updates' }, { status: 500 });
  }
}
