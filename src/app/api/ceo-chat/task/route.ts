/**
 * POST /api/ceo-chat/task (U60 / JM-U63d — My AI CEO Phase A: delegate-task control)
 *
 * The Delegate button/sheet's write path: create a task straight from the My AI
 * CEO chat with an explicit department pick, or hand routing to the same
 * auto-router the rest of the board uses. Every task this route creates is
 * DETERMINISTICALLY stamped `requester_channel='ceo-chat'` +
 * `requester_chat_id=<sessionId>` so the trust engine's ceo-chat channel
 * (P5-01 step 2 / J.0.7) reports ack/progress/done straight back into the
 * Operations Rail card this call creates — never Telegram.
 *
 * Body: `{ sessionId, title, detail?, departmentSlug | "auto" }`. `sessionId`
 * is the same My-AI-CEO session id every other `/api/ceo-chat/*` route takes
 * (message/history/upload) — it is what makes the requester stamp meaningful
 * and is what the Operations Rail's `GET /api/ceo-chat/history` scope
 * (`requester_channel='ceo-chat' AND requester_chat_id=sessionId`) already
 * filters on, so this route accepts it the same way its siblings do.
 *
 * Auto path (`departmentSlug` omitted or `"auto"`): calls `routeTask()` — the
 * SAME keyword/semantic classifier every other auto-routed task in this app
 * uses (`/api/tasks/ingest`'s bare-task path) — then resolves the winning
 * department's real workspace row. No match => the `general-task` catch-all,
 * mirroring the ingest route's fallback chain exactly, so a chat delegate
 * never lands in a nonexistent bucket.
 *
 * Explicit path (`departmentSlug` is a real slug): resolved DIRECTLY against
 * the `workspaces` table (same tier-1 lookup ingest's `resolveWorkspaceId`
 * uses) so the picked department is a hard pin — `createTaskCore` receives
 * both `workspace_id` and `department` already resolved, and
 * `department-router.ts`'s Step 1 (explicit department tag) returns
 * immediately on an exact slug/name match. An unrecognized explicit slug is a
 * 400, not a silent reroute — the explicit pick is "never floored, capped, or
 * re-routed" (spec (d)).
 *
 * Auth: same-origin `/api` route under the standard middleware contract (no
 * webhook/HMAC front door here — this is a browser-callable control, not a
 * machine ingest door; J.0.3 confirms the standard layers are the right fit).
 */
import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { createTaskCore } from '@/lib/tasks';
import { classify, assertTaskCreationAllowed } from '@/lib/intake';
import { routeTask } from '@/lib/routing/department-router';
import { isMyAiCeoBetaEnabled, CEO_CHAT_CHANNEL } from '@/lib/ceo-chat/config';
import type { TaskPriority } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_TITLE_CHARS = 500;
const MAX_DETAIL_CHARS = 8_000;

interface WorkspaceRow {
  id: string;
  slug: string | null;
  name: string;
}

/** Explicit-pick resolution: the SAME tier-1 lookup as ingest's resolveWorkspaceId. */
function resolveExplicitWorkspace(departmentSlug: string): WorkspaceRow | null {
  const slug = departmentSlug.toLowerCase();
  return (
    queryOne<WorkspaceRow>(
      'SELECT id, slug, name FROM workspaces WHERE lower(slug) = ? OR lower(id) = ? LIMIT 1',
      [slug, slug],
    ) ?? null
  );
}

function resolveGeneralTaskWorkspace(): WorkspaceRow | null {
  return (
    queryOne<WorkspaceRow>(
      `SELECT id, slug, name FROM workspaces
        WHERE lower(slug) IN ('general-task', 'dept-general-task', 'general')
           OR lower(name) IN ('general task', 'general')
        ORDER BY rowid ASC LIMIT 1`,
      [],
    ) ?? null
  );
}

export async function POST(request: NextRequest) {
  if (!isMyAiCeoBetaEnabled()) {
    return NextResponse.json({ ok: false, error: 'My AI CEO (BETA) is disabled on this box.' }, { status: 404 });
  }

  let body: { sessionId?: unknown; title?: unknown; detail?: unknown; departmentSlug?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'sessionId is required' }, { status: 400 });
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return NextResponse.json({ ok: false, error: 'title is required' }, { status: 400 });
  }
  if (title.length > MAX_TITLE_CHARS) {
    return NextResponse.json({ ok: false, error: `title must be ${MAX_TITLE_CHARS} characters or less` }, { status: 400 });
  }

  const detail =
    typeof body.detail === 'string' && body.detail.trim() ? body.detail.trim().slice(0, MAX_DETAIL_CHARS) : undefined;

  const rawDept = typeof body.departmentSlug === 'string' ? body.departmentSlug.trim() : '';

  // WIR-121 (spec 16.2 A11, 12.2 CEO-chat door): the Delegate button always
  // sends a TYPED command (sessionId + departmentSlug/detail), never raw
  // chat text (spec 4.2) — so only that typed shape creates here. A RAW
  // conversational message (no departmentSlug, no detail — e.g. a chat
  // bubble forwarded verbatim) goes through the EXISTING intake module:
  // classify() then assertTaskCreationAllowed, before any card exists.
  // Definite non-work verdicts (answer_only / social_conversation /
  // existing_task_control / clarification_response) return 200 created:false
  // with NO card, so createTaskCore (and everything downstream of its
  // INSERT — routeTaskDecision / commitIntakeAssignment / autoDispatchTask)
  // never runs. task_request / mixed_answer_and_task proceed through the
  // creation gate (which proves classify() ran on THIS text via the message
  // hash). unresolved falls through to card creation: an explicit delegate
  // call is a typed command, not raw chat text.
  if (!detail && !rawDept) {
    const classification = await classify(title);
    if (
      classification.intent === 'answer_only' ||
      classification.intent === 'social_conversation' ||
      classification.intent === 'existing_task_control' ||
      classification.intent === 'clarification_response'
    ) {
      return NextResponse.json(
        { ok: true, created: false, intent: classification.intent, task_id: null },
        { status: 200 },
      );
    }
    if (
      classification.intent === 'task_request' ||
      classification.intent === 'mixed_answer_and_task'
    ) {
      if (!classification.bypassAllowed || classification.controlProbe) {
        return NextResponse.json(
          { ok: false, error: 'control_probe_never_creates', intent: classification.intent },
          { status: 403 },
        );
      }
      assertTaskCreationAllowed({ kind: 'raw', message: title, classification });
    }
    // unresolved falls through to card creation: an explicit delegate call
    // is a typed command, not raw chat text (spec 4.2).
  }

  const isAuto = !rawDept || rawDept.toLowerCase() === 'auto';

  let workspaceId: string | null = null;
  let department: string | null = null;
  let resolvedBy: string;

  if (!isAuto) {
    // ── Explicit pick: a hard pin, never re-routed. ──────────────────────────
    const ws = resolveExplicitWorkspace(rawDept);
    if (!ws) {
      return NextResponse.json(
        { ok: false, error: `Unknown department "${rawDept}".` },
        { status: 400 },
      );
    }
    workspaceId = ws.id;
    department = ws.slug || ws.id;
    resolvedBy = `explicit:${department}`;
  } else {
    // ── Auto path: the same classifier every other auto-routed task uses. ────
    try {
      const routing = await routeTask({
        title,
        description: detail ?? '',
        priority: 'medium',
        workspace_id: undefined,
      });
      if (routing) {
        const resolvedWs = queryOne<WorkspaceRow>(
          `SELECT id, slug, name FROM workspaces WHERE lower(name) = ? OR lower(slug) = ? LIMIT 1`,
          [routing.department.toLowerCase(), routing.department.toLowerCase()],
        );
        if (resolvedWs) {
          workspaceId = resolvedWs.id;
          department = resolvedWs.slug || resolvedWs.id;
        } else {
          department = routing.department;
        }
        resolvedBy = `auto-route:${routing.department}`;
      } else {
        const general = resolveGeneralTaskWorkspace();
        if (general) {
          workspaceId = general.id;
          department = general.slug || general.id;
          resolvedBy = 'auto-route:general-task-fallback';
        } else {
          resolvedBy = 'auto-route:unrouted';
        }
      }
    } catch (err) {
      console.warn('[/api/ceo-chat/task] routeTask failed (non-fatal), falling back to general-task:', err);
      const general = resolveGeneralTaskWorkspace();
      workspaceId = general?.id ?? null;
      department = general ? general.slug || general.id : null;
      resolvedBy = general ? 'auto-route:general-task-fallback' : 'auto-route:unrouted';
    }
  }

  try {
    const result = await createTaskCore(
      {
        title,
        description: detail ?? null,
        status: 'backlog',
        priority: 'medium' as TaskPriority,
        assigned_agent_id: null,
        created_by_agent_id: null,
        workspace_id: workspaceId,
        department,
        // U60/JM-U63d — the deterministic requester stamp. Every task this
        // control creates is scoped back to the calling chat session so the
        // trust engine's ceo-chat channel reports back into THIS transcript.
        requester_channel: CEO_CHAT_CHANNEL,
        requester_chat_id: sessionId,
        // U94 (X.2.3) — this door is the ceo-chat half of the "Telegram/
        // CEO-chat ingest" enumerated door for the trust-coverage health
        // metric (checkTrustCoverage()). Always known-human: requester_chat_id
        // above is deterministic, never conditional, on this route.
        humanDoorId: 'ceo-chat',
        eventMessage: `Task captured via My AI CEO delegate control: ${title}`,
      },
      { origin: request.headers.get('origin') },
    );

    if (!result) {
      return NextResponse.json({ ok: false, error: 'Failed to create task' }, { status: 500 });
    }

    const { task } = result;
    return NextResponse.json(
      {
        ok: true,
        taskId: task.id,
        department: task.department ?? department,
        resolved_by: resolvedBy,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error('[/api/ceo-chat/task] createTaskCore failed:', err);
    return NextResponse.json({ ok: false, error: 'Failed to create task' }, { status: 500 });
  }
}
