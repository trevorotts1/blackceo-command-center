import { getOpenClawClient } from './openclaw/client';

// Maximum input length for extractJSON to prevent ReDoS attacks
const MAX_EXTRACT_JSON_LENGTH = 1_000_000; // 1MB

/**
 * Extract JSON from a response that might have markdown code blocks or surrounding text.
 * Handles various formats:
 * - Direct JSON
 * - Markdown code blocks (```json ... ``` or ``` ... ```)
 * - JSON embedded in text (first { to last })
 */
export function extractJSON(text: string): object | null {
  // Security: Prevent ReDoS on massive inputs
  if (text.length > MAX_EXTRACT_JSON_LENGTH) {
    console.warn('[Planning Utils] Input exceeds maximum length for JSON extraction:', text.length);
    return null;
  }

  // First, try direct parse
  try {
    return JSON.parse(text.trim());
  } catch {
    // Continue to other methods
  }

  // Try to extract from markdown code block (```json ... ``` or ``` ... ```)
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // Continue
    }
  }

  // Try to find JSON object in the text (first { to last })
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // Continue
    }
  }

  return null;
}

/**
 * The whole planning protocol, inline. The planning prompt carries this text
 * itself: client boxes have no PLANNING.md, so nothing may depend on a file.
 */
export const PLANNING_PROTOCOL = `PLANNING PROTOCOL (everything you need is in this message):
1. Ask ONE multiple-choice question at a time, specific to THIS task. Always include an "Other" option. Reply with ONLY this JSON, no other text:
{
  "question": "Your question here?",
  "options": [
    {"id": "A", "label": "First option"},
    {"id": "B", "label": "Second option"},
    {"id": "other", "label": "Other"}
  ]
}
2. After each answer, either ask your next question in the same format, or finish once you have enough information (usually 3 to 6 questions).
3. To finish, reply with ONLY this JSON ("status": "complete"):
{
  "status": "complete",
  "spec": {
    "title": "Task title",
    "summary": "What needs to be done",
    "deliverables": ["Each deliverable"],
    "success_criteria": ["How we know it is done"],
    "constraints": {}
  },
  "agents": [
    {"name": "Role name", "role": "Role", "avatar_emoji": "🎯", "soul_md": "Personality", "instructions": "What this role does"}
  ],
  "execution_plan": {"approach": "How to execute", "steps": ["Step 1", "Step 2"]}
}
The spec holds the title, summary, deliverables, success criteria and constraints. "agents" lists the planned roles that will work on it.`;

/** Plain-text plan appended to the task description so the department's specialist sees it. */
export const PLAN_CONTEXT_MARKER = '--- Planning Mode plan ---';
export function buildPlanContext(parsed: {
  spec?: { summary?: string; deliverables?: string[]; success_criteria?: string[] } | null;
  agents?: Array<{ name?: string; role?: string; instructions?: string }> | null;
  execution_plan?: { approach?: string; steps?: string[] } | null;
}): string {
  const list = (xs?: string[]) => (xs || []).map((x) => `- ${x}`).join('\n');
  const parts = [PLAN_CONTEXT_MARKER];
  if (parsed.spec?.summary) parts.push(`Summary: ${parsed.spec.summary}`);
  if (parsed.spec?.deliverables?.length) parts.push(`Deliverables:\n${list(parsed.spec.deliverables)}`);
  if (parsed.spec?.success_criteria?.length) parts.push(`Success criteria:\n${list(parsed.spec.success_criteria)}`);
  if (parsed.agents?.length) {
    parts.push(`Planned roles:\n${parsed.agents.map((a) => `- ${a.name || a.role}${a.role && a.name ? ` (${a.role})` : ''}${a.instructions ? `: ${a.instructions}` : ''}`).join('\n')}`);
  }
  if (parsed.execution_plan?.approach) parts.push(`Approach: ${parsed.execution_plan.approach}`);
  if (parsed.execution_plan?.steps?.length) parts.push(`Steps:\n${list(parsed.execution_plan.steps)}`);
  return parts.join('\n');
}

/** Sent once, in the same session, when the agent's reply was not the required JSON. */
export const PLANNING_REPROMPT = `Your last reply was not valid JSON in the required format, so it could not be used. Resend your reply now as ONLY the JSON (no other text): either your next question in the format {"question": "...", "options": [{"id": "A", "label": "..."}, {"id": "other", "label": "Other"}]}, or, if planning is finished, the {"status": "complete", "spec": {...}, "agents": [...], "execution_plan": {...}} JSON.`;

/**
 * Get assistant messages from the OpenClaw session. THROWS when the gateway
 * cannot be reached, so callers can tell "no reply yet" from "cannot reach".
 */
export async function fetchMessagesFromOpenClaw(
  sessionKey: string
): Promise<Array<{ role: string; content: string }>> {
  const client = getOpenClawClient();
  if (!client.isConnected()) {
    await client.connect();
  }

  const result = await client.call<{
    messages: Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;
  }>('chat.history', {
    sessionKey,
    limit: 50,
  });

  const messages: Array<{ role: string; content: string }> = [];
  for (const msg of result.messages || []) {
    if (msg.role === 'assistant') {
      const textContent = msg.content?.find((c) => c.type === 'text');
      if (textContent?.text) {
        messages.push({ role: 'assistant', content: textContent.text });
      }
    }
  }
  return messages;
}

/** Best-effort variant for callers that treat an unreachable gateway as "nothing yet". */
export async function getMessagesFromOpenClaw(
  sessionKey: string
): Promise<Array<{ role: string; content: string }>> {
  try {
    return await fetchMessagesFromOpenClaw(sessionKey);
  } catch (err) {
    console.error('[Planning Utils] Failed to get messages from OpenClaw:', err);
    return [];
  }
}
