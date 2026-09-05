import { NextRequest, NextResponse } from 'next/server';
import { TaskContextError, TaskRequestConflict, taskRequestFingerprint, taskRequestCompany } from '@/lib/task-request-identity';
import { queryOne, getDb, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from '@/lib/db/migrations';
import { createTaskCore, validateProducerPersonaBundle } from '@/lib/tasks';
import type { PersonaBundle } from '@/lib/types';
import { routeTask } from '@/lib/routing/department-router';
import type { TaskPriority } from '@/lib/types';
import { notifyOwnerSchemaError } from '@/lib/owner-reports';
import { getSelfClient } from '@/lib/clients';
// WEBCHAT-REQUESTER-ROUTE — validates a candidate gateway session key at the
// front door so only an ADDRESSABLE key is ever stamped as a requester address.
import { normalizeRequesterSessionKey } from '@/lib/requester-session';
// WI-15b (D1 Option B — NESTED subtasks) — parent_task_id validation reuses
// the SAME company-scope convention PR #262 established for
// /api/presentations/children and /api/presentations/[taskId]/phases, so a
// child card can never be attached to a parent outside the active company.
// ANTHOLOGY-CC — pure, framework-free helper that surfaces the anthology
// sole-writer subject key onto the card's `Ref:` line (see below). Import-safe
// server-side: anthology-card.ts has no React / client-only imports.
import { resolveIngestSourceRef } from '@/components/anthology/anthology-card';
// FIX 56 — constant-time HMAC-SHA256 verification (shared with
// /api/presentations/stage-timings and /api/tasks/[id]/status). Replaces this
// route's local `===` digest compare, which leaked first-difference timing and
// returned a 401 only after a length-mismatched compare could not happen.
import { verifyWebhookSignature } from '@/lib/webhook-signature';
// queryOne is still used for workspace resolution below.

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * INGEST-07 — request-time schema self-heal guard.
 *
 * The self-heal path (POST catch block) calls runMigrations() when a request
 * hits a schema error. runMigrations applies ALL pending migrations — INCLUDING
 * the DESTRUCTIVE dedup migrations 081 (canonical-workspace merge) and 082 (reap
 * duplicate "Author SOP" tasks). Running those while the box is serving live
 * ingest races data mutations against fresh inserts, so we harden the self-heal:
 *
 *   1. A process-level mutex/latch (`selfHealState`) so the self-heal migrate
 *      runs AT MOST ONCE per process and is never re-entered. runMigrations is
 *      fully synchronous, so this ALSO guarantees it never overlaps another
 *      self-heal in the same worker (the event loop cannot interleave two
 *      synchronous migrate runs). On failure the latch re-arms so a later request
 *      can retry a transient failure.
 *   2. Set OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY=1 for the duration of the
 *      call so the destructive dedup migrations can be gated to explicit offline
 *      runs. The wiring that makes migrations 081/082 honour this flag lives in
 *      src/lib/db/migrations.ts (owned by the migrations lane) — see the L7
 *      cross-lane note. Setting it here is harmless until that gate lands and
 *      makes the two lanes compose.
 */
let selfHealState: 'idle' | 'running' | 'done' = 'idle';

/**
 * POST /api/tasks/ingest — Universal task-capture front door.
 *
 * The Command Center half of "anywhere the agent is told to do something, it
 * lands on the Kanban." An external caller (an OpenClaw agent via its
 * TASK-CAPTURE playbook, the Telegram bridge, a backfill script) posts a
 * friendly external shape; this endpoint resolves it onto the board through the
 * SAME canonical write path (`createTaskCore`) the operator UI uses.
 *
 * Auth: identical HMAC-SHA256 scheme to /api/webhooks/agent-completion —
 * `x-webhook-signature` = HMAC(WEBHOOK_SECRET, rawBody). WEBHOOK_SECRET is
 * REQUIRED in production (W3.5): when unset in production the route fail-loud
 * 503s rather than accepting unauthenticated writes. Only in development is the
 * signature check skipped (zero-config dev path).
 *
 * Agent-FK safety: `assigned_agent_id` / `created_by_agent_id` are `.uuid()` +
 * FK columns into `agents`. An external OpenClaw payload cannot carry a CC
 * agent UUID, so we NEVER pass external ids into those columns — they stay
 * NULL. Provenance (source/persona/session) is recorded in the description and
 * the `task_created` event message instead.
 *
 * Idempotency: when `idempotency_key` (or `source_ref`) is supplied we embed a
 * deterministic `[ingest:<key>]` marker in the task_created event message and
 * dedupe on it before inserting, so a Telegram retry or a backfill re-run can't
 * create duplicates. No schema column required.
 *
 * Expected payload:
 * {
 *   "title": "Follow up with the lead from this morning",   // required
 *   "description": "...",                                    // optional
 *   "priority": "low|medium|high|critical",                 // optional, default medium
 *   "source": "telegram|bridge|agent|backfill",             // optional provenance
 *   "source_ref": "telegram:msg:12345",                     // optional provenance / dedupe fallback
 *   "department_slug": "sales",                              // optional; resolves the workspace
 *   "persona": "Candace",                                    // optional; resolves the workspace by name
 *   "target_agent": "Candace",                               // optional; owner-direct specialist pin (alias: specialist)
 *   "external_session_id": "agent:main:telegram:direct:123",// optional provenance
 *   "requester_session_key": "agent:main:webchat-42",       // optional; the gateway
 *                                                            // session to report back
 *                                                            // into when there is no
 *                                                            // requester_chat_id
 *   "idempotency_key": "sha256(...)",                        // optional; primary dedupe key
 *   "context_refs": ["path/to/doc.md"],                      // optional; FIX 56 (W4.1) — doc pointers
 *                                                              // the CEO attaches; folded onto the card
 *                                                              // and carried into the dispatch ContextPack
 *   "parent_task_id": "<uuid>"                                // optional; WI-15b — creates a per-phase
 *                                                              // CHILD card under this parent deck-run
 *                                                              // task (validated: same-company only)
 * }
 */

interface IngestPayload {
  persona_bundle?: unknown;
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  source?: unknown;
  source_ref?: unknown;
  department_slug?: unknown;
  persona?: unknown;
  external_session_id?: unknown;
  idempotency_key?: unknown;
  /**
   * FIX 3 — re-ingest loop gate.
   *
   * If a caller (typically the main/CEO orchestrator forwarding a task it
   * received) supplies an existing_task_id, and that task already exists AND
   * is assigned to a non-main specialist agent, we reject the ingest with 409.
   *
   * This prevents the infinite loop:
   *   dispatch(specialist) → main receives → main calls ingest → new task
   *   → routes to main again → dispatch → main receives → ∞
   */
  existing_task_id?: unknown;
  /**
   * WI-15b (D1 Option B — NESTED subtasks, migration 124) — the parent deck
   * run's task id. When present, this ingest call creates a per-phase CHILD
   * card rather than a standalone/parent task. Validated below (must exist
   * AND be in the SAME company scope as the box's active company — a child
   * card must never cross companies) before it is ever passed to
   * createTaskCore; an invalid/foreign parent_task_id rejects the whole
   * ingest with 400 rather than silently dropping the link or attaching to
   * the wrong company's row.
   */
  parent_task_id?: unknown;
  /**
   * W4.1 — optional doc-pointer references the CEO/caller attaches so the
   * receiving specialist knows where specific docs live. Accepted as a JSON
   * array of strings or a single string; passed through to the ContextPack
   * assembler at dispatch time.
   */
  context_refs?: unknown;
  /**
   * W3.2 — owner-direct specialist pin (spec §3 owner-direct exception).
   *
   * When the OWNER names a specific AI/agent, the CEO routes STRAIGHT to it:
   * we resolve this name (or id/persona) to a real CC agent, pin
   * `assigned_agent_id`, and BYPASS pickBestAgent + all department
   * classification. `specialist` is accepted as an alias. The value is an
   * agent NAME/persona the owner typed — we resolve it internally to the CC
   * agent UUID, so this never violates the agent-FK safety rule (external ids
   * are still never written into the FK columns).
   */
  target_agent?: unknown;
  specialist?: unknown;
  /**
   * P1-04 (trust engine) — the ORIGINATING client channel + chat id. When the CEO
   * routes a task that came from a client message it passes these so the trust
   * engine can report acknowledge -> in-progress -> done back INTO that channel.
   * `requester_chat_id` is the client's chat id; `requester_channel` defaults to
   * 'telegram' when a chat id is present but no channel is named.
   */
  requester_channel?: unknown;
  requester_chat_id?: unknown;
  /**
   * WEBCHAT-REQUESTER-ROUTE — the OpenClaw gateway session key of the
   * conversation this request came from (`agent:<agentId>:<peer>`). A WEBCHAT
   * requester has no chat id at all, so this is the only address the trust
   * engine can reach them on. Captured whenever it is available, regardless of
   * channel or source; `external_session_id` is honoured as a fallback source
   * for the same value (it is the field already documented to carry a session
   * key) but ONLY when it actually holds an addressable gateway key — its live
   * traffic is mostly producer run ids, which are provenance, not addresses.
   */
  requester_session_key?: unknown;
  /**
   * B-U7 (ingest parity) — OPTIONAL producer-supplied persona-bundle identity,
   * the SAME field vocabulary cc_board.py's report_persona_used posts back
   * later (B-U6). The producer already resolved this bundle before creating
   * the card (B-U1's threaded/cc/local rungs) — voice_persona_id GATES the
   * whole group; when present, createTaskCore pins these directly instead of
   * spawning its own selector match. Absent → today's async selector pin,
   * unchanged.
   */
  voice_persona_id?: unknown;
  topic_persona_id?: unknown;
  task_persona_ids?: unknown;
  bundle_sha?: unknown;
  /**
   * FIX 52 (MASTER Part 8 / [R5A §H5]) — presentation deck-run slide count.
   * The producer (cc_board.py / presentation_job.py) knows the deck size when
   * it ingests each per-phase child card, so it sends the number here and the
   * route stamps it onto the task row (migration 130 `tasks.slide_count`).
   * Accepted as a finite non-negative integer; anything else (missing, non-
   * numeric, negative, fractional) is dropped rather than 400'd — an absent
   * count is the normal case for non-presentation ingest, and a malformed one
   * must not block capture.
   */
  slide_count?: unknown;
  /**
   * FIX 52 (MASTER Part 8 / [R5A §H5]) — the explicit manifest phase id a
   * presentation producer stamps on its per-phase CHILD card ("P4-COPY",
   * "P4-RENDER", …). Persisted into the existing `tasks.stage_slug` column
   * (migration 074; additive, presentation reuses it) so the children route's
   * FIX 52 label resolver (childPhaseLabel, presentation-phases.ts) can derive
   * the client-facing phase label ("Script") from DATA instead of guessing it
   * from the child's title text — a child titled "anything" with phase_id
   * P4-COPY must label Script.
   *
   * Accepted as a trimmed non-empty string (≤ 128 chars, matching
   * UpdateTaskSchema.phase_id's bound). Anything else (missing, blank, wrong
   * type, over-long) is dropped rather than 400'd — the phase id is
   * decoration on a card that must never block capture. NOT a foreign key and
   * NOT validated against PHASE_TO_LABEL here: an id the reducer does not
   * know still deserves to be stored verbatim (childPhaseLabel falls back to
   * the activity/title signals for unknown ids).
   */
  phase_id?: unknown;
  /**
   * FIX 52 — the phase id under its cc_board.py canonical key. The engine's
   * per-phase producer stamps `stage` (ingest_child_task payload.stage =
   * phase_id); `phase_id` is the accepted alias. Same validation as
   * phase_id: trimmed non-empty string ≤ 128 chars, else dropped — never a
   * 400. Declared here only so the parser's two-key read type-checks; the
   * IngestPayload interface deliberately stays loose (unknown) because every
   * field is validated inline before use.
   */
  stage?: unknown;
}

const VALID_PRIORITIES = new Set<TaskPriority>(['low', 'medium', 'high', 'critical']);

/**
 * W3.1 — INTERVIEW-COMPLETED ROUTING GATE (spec §3).
 *
 * "Task routing applies ONLY to owners who COMPLETED the interview (have a
 * Zero Human Company with roles+SOPs). Not-completed = exempt (no routing
 * obligation)." A box is "workforce-provisioned" when it has BOTH:
 *
 *   1. A completed AI-Workforce interview (DB-backed self-client flag), AND
 *   2. Materialized, non-shell departments (per N37): at least one department
 *      workspace — not the CEO/master or the general catch-all — that has a
 *      live, non-master agent. A fresh/shell install has only the CEO shell and
 *      no specialist roster, so it is exempt: there is nowhere to route into.
 *
 * Fail-safe on the interview flag: when the self-client row is ABSENT (a legacy
 * box that predates the clients table) we cannot read the flag, so we defer to
 * the materialized-departments signal alone rather than wrongly exempting a box
 * that is clearly built out. When the row EXISTS we honour its flag exactly.
 *
 * When NOT provisioned, the CEO answers directly with NO routing obligation —
 * the ingest still captures the task (nothing is lost) but does NOT force it
 * through automatic department classification.
 */
function isWorkforceProvisioned(companyId: string): { provisioned: boolean; reason: string } {
  // (2) Materialized, non-shell departments with a live specialist agent.
  const materialized = queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT w.id) AS n
       FROM workspaces w
       JOIN agents a
         ON a.workspace_id = w.id
        AND a.is_master = 0
        AND a.status != 'offline'
      WHERE w.company_id = ? AND lower(w.slug) NOT IN
              ('master-orchestrator', 'ceo', 'dept-ceo',
               'general-task', 'dept-general-task', 'general')
        AND lower(w.name) NOT IN
              ('ceo', 'master orchestrator', 'general task', 'general')`,
    [companyId],
  );
  const hasMaterializedDepts = (materialized?.n ?? 0) > 0;

  // (1) Interview completion — DB-backed self-client flag (null when no row).
  let interviewComplete: boolean | null = null;
  try {
    const self = getSelfClient();
    interviewComplete = self ? self.interview_complete : null;
  } catch {
    // clients table absent / unreadable on a legacy box — treat as unknown.
    interviewComplete = null;
  }

  // Unknown interview flag → defer to the materialized-departments signal.
  const interviewOk = interviewComplete === null ? hasMaterializedDepts : interviewComplete;
  const provisioned = hasMaterializedDepts && interviewOk;

  const reason =
    `interview=${interviewComplete === null ? 'unknown' : interviewComplete}, ` +
    `materialized_depts=${hasMaterializedDepts}`;
  return { provisioned, reason };
}

/**
 * Resolve the target workspace id. Tries department_slug, then persona/name,
 * then falls back to the CEO workspace — the CEO agent runs all other
 * departments, so it is the correct catch-all owner for unrouted work. Returns
 * { workspaceId, resolvedBy } so the caller can record how routing happened.
 *
 * BARE-TASK RESILIENCE (v4.44.0 — BARE-INGEST-001):
 * When no slug is supplied and the CEO/master-orchestrator workspace is not yet
 * seeded (fresh install), we used to return workspaceId='default' which is a
 * sentinel string that has NO row in the workspaces table. createTaskCore would
 * then fail the FK constraint and the whole ingest route would 500.
 *
 * The fix: resolve the first real workspace we can find from the DB so we always
 * hand off a real workspace_id (or null, which createTaskCore handles gracefully).
 * We NEVER return the bare 'default' literal unless it actually has a DB row.
 */
function resolveWorkspaceId(departmentSlug: string | undefined, persona: string | undefined, companyId: string): {workspaceId:string|null;resolvedBy:string} {
  const rows = getDb().prepare('SELECT id,slug,name FROM workspaces WHERE company_id=? AND archived_at IS NULL ORDER BY sort_order,id')
    .all(companyId) as {id:string;slug:string;name:string}[];
  const match = departmentSlug ? rows.filter(w => w.slug.toLowerCase()===departmentSlug.toLowerCase() || w.id.toLowerCase()===departmentSlug.toLowerCase()) : [];
  if (match.length===1) return {workspaceId:match[0].id,resolvedBy:`department_slug:${departmentSlug}`};
  if (!departmentSlug && persona) {
    const named=rows.filter(w => w.name.toLowerCase()===persona.toLowerCase());
    if(named.length===1) return {workspaceId:named[0].id,resolvedBy:`persona:${persona}`};
  }
  const namedGeneral=rows.filter(w => w.name.trim().toLowerCase()==='general task');
  const general=rows.find(w => ['general-task','dept-general-task','general'].includes(w.slug.toLowerCase())) || (namedGeneral.length===1 ? namedGeneral[0] : undefined);
  if(departmentSlug) return {workspaceId:general?.id??null,resolvedBy:general?'unrecognized-slug->general':'unrecognized-slug->unrouted'};
  const ceo=rows.find(w => ['master-orchestrator','ceo','dept-ceo'].includes(w.slug.toLowerCase()));
  return {workspaceId:general?.id??ceo?.id??null,resolvedBy:general?'general-task-fallback':ceo?'ceo-fallback':'no-workspace-fallback'};
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();

    // Auth — HMAC-SHA256, same scheme as /api/webhooks/agent-completion.
    //
    // W3.5 — WEBHOOK_SECRET is REQUIRED to authenticate the CEO-only routing
    // front door. An unset secret leaves ingest unauthenticated, so in
    // PRODUCTION we fail-loud (503) rather than silently accepting unsigned
    // writes — the CEO-only routing invariant is then cryptographically
    // enforced at the HTTP layer. In development we keep the zero-config path
    // but warn loudly so it never ships unset.
    const webhookSecret = process.env.WEBHOOK_SECRET;
    // ALLOW_INSECURE_OPEN_API=true restores legacy open behavior for e2e test
    // environments. The middleware already enforces the WEBHOOK_SECRET gate at
    // the HTTP layer (src/middleware.ts WEBHOOK_SECRET_ROUTES) and only lets
    // requests reach here when either: (a) the secret IS set (normal case), or
    // (b) ALLOW_INSECURE_OPEN_API=true is explicitly set by the operator (test
    // harness escape hatch). We honour that escape hatch here so the route-level
    // redundant 503 does not fire when the middleware already passed the request.
    //
    // INGEST-05: mirror src/middleware.ts's ALLOW_INSECURE_OPEN_API neuter —
    // NODE_ENV !== 'production' is required in addition to the raw env var, so
    // this route-level check can never diverge from the middleware and honor
    // the escape hatch in production even if the middleware's copy of the flag
    // is somehow bypassed or the two checks drift.
    const allowInsecure =
      process.env.NODE_ENV !== 'production' && process.env.ALLOW_INSECURE_OPEN_API === 'true';
    if (!webhookSecret) {
      if (process.env.NODE_ENV === 'production' && !allowInsecure) {
        console.error(
          '[INGEST] WEBHOOK_SECRET is not set — refusing UNAUTHENTICATED ingest in production. ' +
            'Set WEBHOOK_SECRET on this box to enable the task front door.',
        );
        return NextResponse.json(
          { error: 'WEBHOOK_SECRET not configured — ingest is disabled until this box sets it.' },
          { status: 503 },
        );
      }
      if (allowInsecure) {
        console.warn(
          '[INGEST] WEBHOOK_SECRET unset + ALLOW_INSECURE_OPEN_API=true — signature check skipped ' +
            '(test/dev escape hatch). Do NOT set this in production.',
        );
      } else {
        console.warn(
          '[INGEST] WEBHOOK_SECRET unset — DEV mode, signature check skipped. ' +
            'Set WEBHOOK_SECRET before production.',
        );
      }
    } else {
      const signature = request.headers.get('x-webhook-signature');
      // FIX 56 — constant-time compare via the shared lib; a wrong-length
      // signature is a clean false → 401 (no throw, no timing leak).
      if (!verifyWebhookSignature(signature, rawBody)) {
        console.warn('[INGEST] Invalid signature attempt');
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    let body: IngestPayload;
    try {
      body = JSON.parse(rawBody) as IngestPayload;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }
    if (title.length > 500) {
      return NextResponse.json({ error: 'title must be 500 characters or less' }, { status: 400 });
    }

    const ingestCompanyId = taskRequestCompany(getDb(), null, process.env.MC_COMPANY_ID);

    // FIX 3 — re-ingest loop gate.
    // When a caller passes existing_task_id and that task already exists with a
    // non-master assigned agent, reject immediately.  This is the hard stop for
    // the CEO/main orchestrator re-ingest loop: main receives a dispatch message
    // that includes Task ID, tries to re-ingest it, and is blocked here.
    const existingTaskId = typeof body.existing_task_id === 'string' ? body.existing_task_id.trim() : null;
    if (existingTaskId) {
      const existingTask = queryOne<{ id: string; assigned_agent_id: string | null; title: string }>(
        `SELECT t.id, t.assigned_agent_id, t.title
         FROM tasks t
         WHERE t.id = ? AND (EXISTS (SELECT 1 FROM workspaces w WHERE w.id=t.workspace_id AND w.company_id=?) OR EXISTS (SELECT 1 FROM task_request_keys k WHERE k.task_id=t.id AND k.company_id=?))
         LIMIT 1`,
        [existingTaskId, ingestCompanyId, ingestCompanyId],
      );
      if (existingTask) {
        // If assigned to any agent (specialist or master), this task already exists —
        // return the existing record instead of creating a duplicate.
        console.warn(
          `[INGEST] FIX3 re-ingest loop gate: existing_task_id="${existingTaskId}" already exists ` +
          `(assigned_agent_id=${existingTask.assigned_agent_id ?? 'null'}) — rejecting ingest to prevent loop.`,
        );
        return NextResponse.json(
          {
            ok: true,
            deduped: true,
            loop_gate: true,
            task_id: existingTask.id,
            message: 'Task already exists — re-ingest rejected to prevent orchestrator loop.',
          },
          { status: 409 },
        );
      }
    }

    // Secondary loop guard: detect if the payload description contains the
    // canonical dispatch marker "**Task ID:** <uuid>" and that uuid references an
    // existing task assigned to a non-master agent.  This catches main forwarding
    // the raw dispatch message body without setting existing_task_id explicitly.
    const descriptionRaw = typeof body.description === 'string' ? body.description : '';
    if (descriptionRaw) {
      const taskIdMarkerMatch = descriptionRaw.match(/\*{0,2}Task ID:\*{0,2}\s*([0-9a-f-]{36})/i);
      if (taskIdMarkerMatch?.[1]) {
        const embeddedTaskId = taskIdMarkerMatch[1];
        const embeddedTask = queryOne<{ id: string; assigned_agent_id: string | null }>(
          `SELECT t.id, t.assigned_agent_id
           FROM tasks t
           LEFT JOIN agents a ON t.assigned_agent_id = a.id
           WHERE t.id = ? AND a.is_master = 0 AND (EXISTS (SELECT 1 FROM workspaces w WHERE w.id=t.workspace_id AND w.company_id=?) OR EXISTS (SELECT 1 FROM task_request_keys k WHERE k.task_id=t.id AND k.company_id=?))
           LIMIT 1`,
          [embeddedTaskId, ingestCompanyId, ingestCompanyId],
        );
        if (embeddedTask) {
          console.warn(
            `[INGEST] FIX3 secondary loop gate: description embeds Task ID "${embeddedTaskId}" ` +
            `which is already assigned to a specialist (agent=${embeddedTask.assigned_agent_id}) — rejecting re-ingest.`,
          );
          return NextResponse.json(
            {
              ok: true,
              deduped: true,
              loop_gate: true,
              task_id: embeddedTask.id,
              message: 'Task already assigned to specialist — re-ingest rejected to prevent orchestrator loop.',
            },
            { status: 409 },
          );
        }
      }
    }

    const description = typeof body.description === 'string' ? body.description : undefined;
    // FIX 36 — the ingest route has never been source-GATED (producers tag
    // provenance like 'telegram' | 'backfill' here, and Skill-6 callers may
    // send a department-slug override), so unrecognized values still pass
    // through untouched — they simply stamp a tasks.source the status route's
    // gate will refuse to act on. What changes per FIX 36 is CASE: the value
    // is lowercased here so the immutable tasks.source stamp is CANONICAL —
    // a producer that sends "Build_Deck_Phase" (the Presentations engine's
    // cc_board.py child-card source; "presentation-interview-app" is the
    // interview app's) stamps exactly what src/lib/board-sources.ts recognizes,
    // instead of a mixed-case near-miss the gate would 403. The membership
    // check itself lives in normalizeBoardSource() and runs at the status
    // route (fail-closed there, 403 for unknown values like "garbage").
    const source = typeof body.source === 'string' ? body.source.trim().toLowerCase() : undefined;
    const sourceRef = typeof body.source_ref === 'string' ? body.source_ref.trim() : undefined;
    const departmentSlug =
      typeof body.department_slug === 'string' ? body.department_slug.trim() : undefined;

    // Parent ownership must be proven by its workspace or durable creation identity.
    // An unassigned workspace is not evidence that a task belongs to this company.
    const parentTaskIdRaw =
      typeof body.parent_task_id === 'string' ? body.parent_task_id.trim() : undefined;
    let parentTaskId: string | null = null;
    // FIX 57 — the parent's description is fetched alongside its id because the
    // parent's run identity (its `Ref:` provenance line, written by this route
    // from the producer's source_ref) lives there. The mismatch hold below
    // pairs the child's `Session:` line against it BEFORE any card is created.
    let parentDescription: string | null = null;
    if (parentTaskIdRaw) {
      const db = getDb();
      const parent = db.prepare(`SELECT t.id, t.description FROM tasks t
        WHERE t.id = ? AND (
          EXISTS (SELECT 1 FROM workspaces w WHERE w.id=t.workspace_id AND w.company_id=?) OR
          EXISTS (SELECT 1 FROM task_request_keys k WHERE k.task_id=t.id AND k.company_id=?)
        )`).get(parentTaskIdRaw, ingestCompanyId, ingestCompanyId) as
        | { id: string; description: string | null }
        | undefined;
      if (!parent) {
        console.warn(
          `[INGEST] WI-15b: parent_task_id="${parentTaskIdRaw}" not found or not in the active ` +
            'company scope — rejecting child ingest rather than attaching cross-company.',
        );
        return NextResponse.json(
          {
            error: 'parent_task_id does not reference a task in this company\'s scope',
            detail: 'parent_not_found_or_out_of_scope',
          },
          { status: 400 },
        );
      }
      parentTaskId = parent.id;
      parentDescription = parent.description ?? null;
    }

    // ── FIX 57 (MASTER Part 8 / [R5B §E.4, §F10]) — per-run parent identity: ──
    // a child phase card whose run identity disagrees with its parent's is
    // HELD at the door, never silently attached.
    //
    // THE LIVE DEFECT: 47 of 49 child cards of a second deck job pointed at
    // the FIRST job's parent. The producer cached parent_task_id
    // process-wide instead of per run, so the second run's children ingested
    // under the first run's parent id and the two runs' phases interleaved on
    // one deck card. cc_board.py now caches parent_task_id per run_id and
    // stamps every child's external_session_id (the card's `Session:`
    // provenance line) with its OWN run's id, while the parent's source_ref
    // (its `Ref:` line) is that same run id — so the pairing is checkable
    // from the board itself, here, at ingest time.
    //
    // THE HOLD RULE — only fires on a FACT this request itself carries:
    //   child source = build_deck_phase (the engine's per-phase child card),
    //   child Session line present,
    //   parent Ref line present,
    //   and the two differ.
    // When ANY input to the comparison is absent the hold stays silent — an
    // absent identity is undeterminable here, never evidence of a mismatch
    // (the same posture as task-dispatcher.ts's GUARD 4c deckPhaseRunIsInitialized:
    // block only on what the board can establish, never on what it cannot
    // observe). The legacy pairing (producer without run_id: child Session =
    // `<parent_task_id>:<phase_id>`) also passes: it names its own parent,
    // which is exactly the identity it is attached to.
    //
    // WHAT THE HOLD DOES: the child card is NOT created — creating it attached
    // to the wrong run's parent is the defect itself, and a blocked orphan
    // on the wrong deck would still be wrong parentage. Instead the ingest is
    // rejected 409 (fail-soft on the producer side: it logs "non-OK" and the
    // run continues) and ONE deduped `deck_run_identity_mismatch` event is
    // recorded on the PARENT card so the operator sees which deck is being
    // targeted by a foreign run's children.
    const isDeckPhaseChild = source === 'build_deck_phase';
    // externalSessionId is parsed below (line ~730, provenance section); the
    // hold reads the raw body field directly so the check can run here, before
    // any write, in the WI-15b parent-validation block where the parent row is
    // already in hand.
    const childSession =
      typeof body.external_session_id === 'string' && body.external_session_id.trim() !== ''
        ? body.external_session_id.trim()
        : undefined;
    const parentRefLine = (() => {
      if (!parentDescription) return null;
      const m = parentDescription.match(/^Ref:\s*(\S.*?)\s*$/m);
      return m ? m[1] : null;
    })();
    if (isDeckPhaseChild && parentTaskId && childSession && parentRefLine && childSession !== parentRefLine) {
      // Legacy pairing escape hatch: `<parent_task_id>:<phase_id>` — the child
      // session names the very parent it is attached to, so the two values
      // differing is EXPECTED (one is a run id, one is a parent-scoped phase
      // anchor) and is not a mismatch.
      const legacyPrefix = `${parentTaskId}:`;
      if (!childSession.startsWith(legacyPrefix)) {
        const mismatchDetail = `child session "${childSession}" does not match parent run ref "${parentRefLine}"`;
        console.warn(
          `[INGEST] FIX 57 deck_run_identity_mismatch: ${mismatchDetail} — child card for ` +
            `parent_task_id="${parentTaskId}" HELD at ingest (not created, not patched).`,
        );
        try {
          const db = getDb();
          const now = new Date().toISOString();
          const holdMsg =
            `[deck_run_identity_mismatch] A child phase card naming session \`${childSession}\` was ` +
            `offered against this deck (Ref: \`${parentRefLine}\`) and HELD at ingest — the child's ` +
            `run identity does not match this deck's run. The card was not created and not patched. ` +
            `If this child belongs here, re-ingest it with external_session_id = this deck's run id ` +
            `(\`${parentRefLine}\`); if it belongs to another run, its producer is caching parent ` +
            `task ids across runs and must be re-run from its own run directory.`;
          run(
            `INSERT INTO events (id, type, task_id, message, created_at)
             SELECT ?, 'deck_run_identity_mismatch', ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM events WHERE task_id = ? AND type = 'deck_run_identity_mismatch')`,
            [uuidv4(), parentTaskId, holdMsg, now, parentTaskId],
          );
        } catch (holdEventErr) {
          // The hold itself is enforced by the 409 below; the event write is
          // observability and must never turn into a 500.
          console.error(
            '[INGEST] deck_run_identity_mismatch event write failed (non-fatal):',
            holdEventErr,
          );
        }
        return NextResponse.json(
          {
            ok: false,
            error:
              'Child phase card held: its Session (run identity) does not match the parent deck\'s Ref line.',
            detail: 'deck_run_identity_mismatch',
            parent_task_id: parentTaskId,
          },
          { status: 409 },
        );
      }
    }

    // ── Skill-6 survey job-type mapping (zero-migration) ──────────────────────
    // cc_board.py (and callers like it) may post department_slug='survey', 'form',
    // or 'quiz' to describe a GoHighLevel web-builder task. There is no 'survey'
    // workspace in the standard CC schema, and the 'survey' keyword that DOES exist
    // in departments.config.ts maps to the Research department — the wrong semantic
    // for a build task. Without this remap the card falls through to the CEO
    // catch-all and is effectively invisible to the department that must build it.
    //
    // Zero-migration fix: remap these job types to 'web-development', the one
    // department that reliably resolves today, so the card lands in the right
    // workspace.
    //
    // NOTE (operator): a dedicated 'surveys' department is a fast-follow once survey
    // volume justifies its own Kanban column. When that department is added, its SOP
    // MUST carry `success_criteria` so runQCOnReview auto-scores the build instead of
    // parking at 7.5 for human sign-off.
    const SKILL6_SURVEY_SLUGS = new Set(['survey', 'form', 'quiz']);
    const resolvedDeptSlug =
      departmentSlug && SKILL6_SURVEY_SLUGS.has(departmentSlug.toLowerCase())
        ? 'web-development'
        : departmentSlug;

    const persona = typeof body.persona === 'string' ? body.persona.trim() : undefined;
    // W3.2 — owner-direct specialist pin. `target_agent` wins; `specialist` is
    // an accepted alias. Empty strings collapse to undefined.
    const targetAgent =
      (typeof body.target_agent === 'string' && body.target_agent.trim()) ||
      (typeof body.specialist === 'string' && body.specialist.trim()) ||
      undefined;
    const externalSessionId =
      typeof body.external_session_id === 'string' ? body.external_session_id.trim() : undefined;
    const idempotencyKey =
      typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : undefined;

    // FIX 56 (W4.1) — context_refs FINALLY reaches createTaskCore. The field was
    // declared on IngestPayload (and promised by context-pack.ts's W4.1
    // integration note) but never read: a CEO/caller attaching doc pointers had
    // them silently dropped. Accepted as a JSON array of strings or a single
    // string; blank entries are dropped and the list is capped at 20 refs —
    // pointers are decoration and must never block capture (same posture as
    // slide_count / phase_id above: malformed → dropped, never a 400).
    const contextRefsRaw = body.context_refs;
    const contextRefs = (
      Array.isArray(contextRefsRaw) ? contextRefsRaw : [contextRefsRaw]
    )
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .map((r) => r.trim())
      .slice(0, 20);

    // P1-04 (trust engine) — capture the originating client chat so the report-back
    // engine can acknowledge/progress/done into it. A chat id with no explicit
    // channel defaults to 'telegram' (the only client-facing channel today).
    const requesterChatId =
      typeof body.requester_chat_id === 'string' && body.requester_chat_id.trim()
        ? body.requester_chat_id.trim()
        : undefined;
    const requesterChannel = requesterChatId
      ? (typeof body.requester_channel === 'string' && body.requester_channel.trim()
          ? body.requester_channel.trim()
          : 'telegram')
      : undefined;

    // WEBCHAT-REQUESTER-ROUTE — the SECOND requester address, captured
    // unconditionally: no channel gate, no source gate, and no dependency on
    // requester_chat_id. A webchat request has no chat id, which is exactly the
    // case this exists for; a Telegram request that happens to carry a session
    // key keeps both (the chat id still wins at delivery).
    //
    // An explicit `requester_session_key` is authoritative. Otherwise we read
    // `external_session_id` — the field whose own documentation (above) shows a
    // session key — but only through normalizeRequesterSessionKey, so the
    // producer run ids that dominate that field in live traffic
    // (`pres-mta0y199-qj40j3`, `<task-id>:P4-COPY`) are NOT mistaken for
    // addresses. Storing one of those would hand the trust engine a session the
    // gateway cannot resolve, converting today's honest silence into a
    // guaranteed failed send.
    const requesterSessionKey =
      normalizeRequesterSessionKey(body.requester_session_key) ??
      normalizeRequesterSessionKey(externalSessionId) ??
      undefined;

    const priorityRaw = typeof body.priority === 'string' ? body.priority.trim() : undefined;
    const priority: TaskPriority | undefined =
      priorityRaw && VALID_PRIORITIES.has(priorityRaw as TaskPriority)
        ? (priorityRaw as TaskPriority)
        : undefined;

    // FIX 52 (migration 130) — presentation slide count. Accept only a finite,
    // non-negative INTEGER; any other shape (string, float, negative, NaN,
    // Infinity) is dropped, never a 400 — an absent/malformed count must not
    // block task capture, it only loses the decoration.
    const slideCountRaw = body.slide_count;
    let slideCount: number | null = null;
    if (
      typeof slideCountRaw === 'number' &&
      Number.isFinite(slideCountRaw) &&
      Number.isInteger(slideCountRaw) &&
      slideCountRaw >= 0
    ) {
      slideCount = slideCountRaw;
    } else if (typeof slideCountRaw === 'string' && slideCountRaw.trim() !== '') {
      const parsed = Number(slideCountRaw.trim());
      if (Number.isInteger(parsed) && parsed >= 0) {
        slideCount = parsed;
      }
    }
    if (slideCount !== null) {
      console.log(`[INGEST] slide_count=${slideCount} captured for "${title}" (FIX 52)`);
    }

    // FIX 52 (MASTER Part 8) — presentation phase id. The engine's per-phase
    // producer (cc_board.py, ingest_child_task) stamps the manifest phase on
    // the child payload as `stage` (its canonical key since the R5A rewrite);
    // `phase_id` is the explicitly accepted alias (UpdateTaskSchema/route
    // parity). Two shapes are honoured for a DIFFERENT reason than slide_count:
    // the phase id is not decoration — it is the child's identity — but a
    // malformed one must still NEVER block capture (the card exists either
    // way; the label resolver falls back to activity metadata / title).
    // Accepted as a trimmed non-empty string, max 128 (matching
    // UpdateTaskSchema.phase_id's bound). Anything else -> null.
    const phaseIdRaw =
      typeof body.phase_id === 'string' && body.phase_id.trim() !== ''
        ? body.phase_id.trim()
        : typeof body.stage === 'string' && body.stage.trim() !== ''
          ? body.stage.trim()
          : undefined;
    const phaseId =
      phaseIdRaw !== undefined && phaseIdRaw.length <= 128 ? phaseIdRaw : undefined;
    if (phaseId) {
      console.log(`[INGEST] phase_id="${phaseId}" captured for "${title}" (FIX 52)`);
    }

    // B-U7 — ingest parity. voice_persona_id GATES the whole group (mirrors
    // cc_board.py's own gate, and report_persona_used's voice-required rule):
    // a caller sending topic/task/sha with no voice has nothing worth pinning,
    // so the whole group is dropped rather than handed to createTaskCore as a
    // half-formed bundle it could misread as authoritative.
    const voicePersonaIdRaw =
      typeof body.voice_persona_id === 'string' ? body.voice_persona_id.trim() : '';
    const topicPersonaId =
      voicePersonaIdRaw && typeof body.topic_persona_id === 'string' && body.topic_persona_id.trim()
        ? body.topic_persona_id.trim()
        : undefined;
    const taskPersonaIds =
      voicePersonaIdRaw && Array.isArray(body.task_persona_ids)
        ? body.task_persona_ids
            .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
            .map((p) => p.trim())
        : undefined;
    const bundleSha =
      voicePersonaIdRaw && typeof body.bundle_sha === 'string' && body.bundle_sha.trim()
        ? body.bundle_sha.trim()
        : undefined;
    const voicePersonaId = voicePersonaIdRaw || undefined;

    // New occurrences must remain distinct. Producers preserve operation IDs across retries.
    const headerKey = request.headers.get('idempotency-key')?.trim();
    if (headerKey && idempotencyKey && headerKey !== idempotencyKey) {
      return NextResponse.json({ error: 'conflicting_idempotency_keys' }, { status: 400 });
    }
    const dedupeKey = headerKey || idempotencyKey || sourceRef || uuidv4();
    if (dedupeKey.length > 512) return NextResponse.json({ error: 'idempotency_key_too_long' }, { status: 400 });
    const { idempotency_key: _operationKey, ...semanticPayload } = body;
    const requestFingerprint = taskRequestFingerprint(semanticPayload);

    let { workspaceId, resolvedBy }: { workspaceId: string | null; resolvedBy: string } = resolveWorkspaceId(resolvedDeptSlug, persona, ingestCompanyId);
    let routingHoldReason: string | null = resolvedBy.startsWith('unrecognized-slug') ? `Requested department ${resolvedDeptSlug} is unavailable in this company.` : null;
    const producerBundle = body.persona_bundle as PersonaBundle | undefined;
    if (producerBundle && (!voicePersonaId || typeof producerBundle !== 'object' || Array.isArray(producerBundle))) {
      return NextResponse.json({error:'invalid_persona_bundle'}, {status:400});
    }
    if (voicePersonaId) {
      try { validateProducerPersonaBundle({voice_persona_id:voicePersonaId,topic_persona_id:topicPersonaId,task_persona_ids:taskPersonaIds,bundle_sha:bundleSha,persona_bundle:producerBundle}, ingestCompanyId); }
      catch (error) { return NextResponse.json({error:'invalid_persona_bundle',message:error instanceof Error?error.message:'Invalid persona decision'}, {status:400}); }
    }
    let resolvedDepartment: string | undefined = resolvedDeptSlug;
    // INGEST-06 — the explicit slug was unrecognized and got redirected to the
    // general-task catch-all (or left unrouted). Report the department we ACTUALLY
    // landed in so the W5.2 owner-assignment notice never announces a department
    // this box does not have.
    if (resolvedBy.startsWith('unrecognized-slug')) {
      resolvedDepartment = workspaceId ? 'general-task' : undefined;
    }

    // ── W3.2: Owner-direct specialist pin (spec §3 owner-direct exception) ─────
    // When the OWNER names a specific AI/agent, the CEO routes STRAIGHT to it —
    // bypassing department classification + pickBestAgent. We resolve the named
    // specialist (name/persona/id) to a real CC agent and pin assigned_agent_id;
    // createTaskCore then skips its own in-process routing because the agent is
    // already set. This honours the named specialist regardless of whether the
    // box is provisioned (it is an explicit owner instruction, not forced
    // routing) and regardless of any department_slug.
    let pinnedAgentId: string | null = null;
    if (targetAgent) {
      try {
        const pin = await routeTask({
          title,
          description: description ?? '',
          priority: priority ?? 'medium',
          target_agent: targetAgent,
          company_id: ingestCompanyId,
          workspace_id: undefined,
        });
        if (pin) {
          routingHoldReason = null;
          pinnedAgentId = pin.agentId;
          resolvedDepartment = pin.department;
          resolvedBy = `owner-direct-specialist:${targetAgent}`;
          // Land the card in the pinned specialist's own workspace/lane.
          const pinnedWs = queryOne<{ workspace_id: string }>(
            `SELECT workspace_id FROM agents WHERE id = ? LIMIT 1`,
            [pin.agentId],
          );
          if (pinnedWs?.workspace_id) workspaceId = pinnedWs.workspace_id;
          console.log(
            `[INGEST] Owner-direct specialist pin "${targetAgent}" → agent ${pin.agentName} ` +
              `(${pin.department}); bypassing department routing.`,
          );
        } else {
          routingHoldReason = `The requested specialist ${targetAgent} is not available in this company.`;
          console.warn(
            `[INGEST] Owner named specialist "${targetAgent}" but no matching agent was ` +
              `found — holding for an explicit assignment.`,
          );
        }
      } catch (pinErr) {
        routingHoldReason = `The requested specialist ${targetAgent} could not be verified.`;
        console.warn(
          '[INGEST] Specialist-pin resolution failed; holding for a verified assignment:',
          (pinErr as Error).message,
        );
      }
    }

    // ── W3.1: INTERVIEW-COMPLETED routing gate (spec §3) ──────────────────────
    // Automatic department routing is an obligation ONLY for a provisioned
    // zero-human company (completed interview + materialized departments).
    // An interview-incomplete / shell box is EXEMPT: the task is still captured,
    // but we do NOT force it through department classification.
    const provisioning = isWorkforceProvisioned(ingestCompanyId);
    if (!provisioning.provisioned) {
      console.log(
        `[INGEST] Routing gate: box NOT workforce-provisioned (${provisioning.reason}) — ` +
          `EXEMPT from forced routing. Capturing "${title}" without department classification.`,
      );
    }

    // ── Auto-route bare tasks (no department_slug) ────────────────────────────
    // When the caller does not supply a department_slug, run the keyword +
    // semantic resolver (routeTask / comDispatch) against the task title and
    // description so the task lands in the right workspace rather than always
    // falling through to the CEO / default bucket.
    //
    // Gated by W3.1 (only provisioned boxes carry the routing obligation) and
    // skipped when an owner-direct specialist pin already resolved the target.
    // If routeTask() cannot resolve with confidence it returns null, and the
    // behaviour introduced above (CEO / default fallback) is preserved exactly.
    // Tagged-task behaviour (department_slug present) is unchanged — we skip
    // this block entirely.
    if (!departmentSlug && !pinnedAgentId && !routingHoldReason && provisioning.provisioned) {
      try {
        const routing = await routeTask({
          title,
          // Use the raw description (without provenance block) for semantic
          // routing — provenance lines would skew keyword/embedding scores.
          description: description ?? '',
          priority: priority ?? 'medium',
          // Do NOT pass the resolved CEO/'default' workspace as a scope here.
          // For a bare task the only correct routing universe is ALL
          // departments — a scoped workspace would pre-filter the agent roster
          // (and a zero-agent 'default'/unseeded-CEO workspace would blank out
          // routing). routeTask treats workspace_id only as a hint, so leaving
          // it undefined forces full keyword+semantic resolution over every
          // department. (resolveWorkspaceId's value is still kept as the
          // fallback for when routeTask returns null.)
          workspace_id: undefined,
          company_id: ingestCompanyId,
        });
        if (routing) {
          // Override the CEO/default workspace with the resolved department
          // workspace so the task lands on the right Kanban column.
          workspaceId = routing.workspaceId ?? null;
          resolvedBy = `auto-route:${routing.department}`;
          resolvedDepartment = routing.department;
          console.log(
            `[INGEST] Auto-routed "${title}" → department "${routing.department}" (${routing.reason})`,
          );
        } else {
          // routeTask returned null — no confident match; fall back to
          // 'general-task' slug so the task is never left unrouted in backlog.
          const generalWs = queryOne<{ id: string }>(
            `SELECT id FROM workspaces
              WHERE company_id = ? AND archived_at IS NULL AND (lower(slug) IN ('general-task', 'dept-general-task')
                 OR lower(name) IN ('general task', 'general'))
              LIMIT 1`,
            [ingestCompanyId],
          );
          if (generalWs) {
            workspaceId = generalWs.id;
            resolvedBy = 'auto-route:general-task-fallback';
            resolvedDepartment = 'general-task';
            console.log(`[INGEST] Auto-route returned null for "${title}" — falling back to general-task`);
          } else {
            console.log(`[INGEST] Auto-route returned null for "${title}" — no general-task workspace; keeping CEO/default fallback`);
          }
        }
      } catch (routeErr) {
        // Non-fatal: log and continue with the CEO/default workspace already resolved above.
        console.warn('[INGEST] Auto-route failed (non-fatal), keeping CEO/default workspace:', (routeErr as Error).message);
      }
    }

    // Build a provenance-rich description so the source survives even though we
    // intentionally leave the agent FK columns NULL.
    const provenanceLines: string[] = [];
    if (source) provenanceLines.push(`Source: ${source}`);
    if (persona) provenanceLines.push(`From persona: ${persona}`);
    if (externalSessionId) provenanceLines.push(`Session: ${externalSessionId}`);
    // FIX 56 (W4.1) — fold the caller's context_refs into the description as a
    // "Context refs:" provenance line. The dispatch-time ContextPack
    // assembler (src/lib/task-dispatcher.ts → buildContextPack) reads
    // task.description; pointers captured at ingest must survive on the card to
    // reach the receiving specialist, exactly like the Source/Session/Ref lines.
    if (contextRefs.length > 0) provenanceLines.push(`Context refs: ${contextRefs.join(', ')}`);
    // ANTHOLOGY-CC: surface the anthology sole-writer subject key on the card.
    // The board's card parsers (extractSubject / resolveAnthologyAssembly) read
    // the anthology_id ONLY from this `Ref:` line. An explicit source_ref wins;
    // otherwise an anthology-subject idempotency_key (`anthology:assembly:<aid>` /
    // `anthology:card:<pk>`, as mc_board.py sends it) is surfaced so the aid
    // reaches the card even when no separate source_ref was provided.
    const effectiveSourceRef = resolveIngestSourceRef(sourceRef, idempotencyKey);
    if (effectiveSourceRef) provenanceLines.push(`Ref: ${effectiveSourceRef}`);
    const provenanceBlock = provenanceLines.length
      ? `\n\n— Captured via task-ingest —\n${provenanceLines.join('\n')}`
      : '';
    const finalDescription = `${description ?? ''}${provenanceBlock}`.trim() || undefined;

    // Event message carries the human-readable provenance + the dedupe marker.
    const eventMessageParts = [`Task captured via ${source || 'ingest'}: ${title}`];
    if (dedupeKey) eventMessageParts.push(`[ingest:${dedupeKey}]`);
    const eventMessage = eventMessageParts.join(' ');

    const result = await createTaskCore(
      {
        title,
        description: finalDescription,
        status: 'backlog',
        priority,
        // Agent FKs intentionally NULL — external ids are not CC agent UUIDs.
        // EXCEPTION (W3.2): the owner-direct specialist pin resolves the owner's
        // named specialist to a REAL CC agent UUID above, so it is FK-safe to
        // pin here. A non-null assigned_agent_id also makes createTaskCore skip
        // its own in-process routing, preserving the owner's explicit choice.
        assigned_agent_id: pinnedAgentId,
        created_by_agent_id: null,
        workspace_id: workspaceId,
        department: resolvedDepartment ?? null,
        // WI-15b: pre-validated (existence + company-scope) above; NULL for a
        // parent/flat task, the parent row id for a per-phase child.
        parent_task_id: parentTaskId,
        eventMessage,
        // Pass idempotency key through so createTaskCore embeds it in the
        // task_created event AND checks it before writing a new row.
        idempotency_key: dedupeKey,
        idempotency_payload_hash: requestFingerprint,
        idempotency_company_id: ingestCompanyId,
        routing_hold_reason: routingHoldReason,
        persona_bundle: producerBundle,
        // INGEST-10: stamp the immutable tasks.source column from this
        // VALIDATED ingest source (line ~435: trimmed string or undefined —
        // never raw/unvalidated caller text). This is the authoritative,
        // non-forgeable scope key /api/tasks/[id]/status's resolveBoardSource()
        // now reads first, before falling back to the legacy (forgeable)
        // description marker for pre-migration rows.
        source: source ?? null,
        // P1-04: the originating client channel so the trust engine reports back.
        requester_channel: requesterChannel ?? null,
        requester_chat_id: requesterChatId ?? null,
        // WEBCHAT-REQUESTER-ROUTE: the fallback address the trust engine uses
        // when there is no chat id to report into.
        requester_session_key: requesterSessionKey ?? null,
        // U94 (X.2.3) — this ingest call declared itself human-initiated by
        // supplying requester_chat_id; tag it as the "Telegram/CEO-chat
        // ingest" enumerated door for the trust-coverage health metric
        // (checkTrustCoverage()). A producer/backfill call that omits
        // requester_chat_id entirely is deliberately NOT tagged here — it
        // correctly stays outside the coverage denominator (operator-digest
        // fallback, never a client-facing send).
        humanDoorId: requesterChatId ? 'telegram-ingest' : null,
        // B-U7: producer-supplied persona-bundle identity (voice_persona_id
        // gates the whole group — see parsing above). undefined/absent here
        // is createTaskCore's byte-identical legacy path.
        voice_persona_id: voicePersonaId ?? null,
        topic_persona_id: topicPersonaId ?? null,
        task_persona_ids: taskPersonaIds ?? null,
        bundle_sha: bundleSha ?? null,
        // FIX 56 (W4.1) — the validated context_refs list, so createTaskCore can
        // surface it on the card and the ContextPack assembler can carry the
        // pointers into the dispatch handoff (buildContextPack input.contextRefs).
        context_refs: contextRefs.length > 0 ? contextRefs : null,
      },
      { origin: request.headers.get('origin') }
    );

    if (!result) {
      return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
    }

    const { task, deduped } = result;

    // FIX 52 (migration 130) — stamp the presentation slide count onto the
    // freshly created card. Done as a follow-up UPDATE rather than inside
    // createTaskCore's INSERT because slide_count is presentation-specific
    // decoration, not part of the canonical write path shared with the UI and
    // every other ingest caller. Runs ONLY on a genuinely new card (deduped
    // retries return the prior row untouched); a failed write is logged, never
    // fatal — the card exists either way.
    if (slideCount !== null && !deduped) {
      try {
        run('UPDATE tasks SET slide_count = ?, updated_at = updated_at WHERE id = ?', [
          slideCount,
          task.id,
        ]);
      } catch (slideErr) {
        console.error(
          '[INGEST] slide_count write failed (non-fatal, migration 130 may not be applied yet):',
          slideErr,
        );
      }
    }

    // FIX 52 — stamp the presentation phase id onto the freshly created card as
    // `tasks.stage_slug` (column from migration 074; presentation reuses it —
    // it is the same "current stage" slot the department stages use, and the
    // children route's FIX 52 label resolver childPhaseLabel reads it FIRST).
    // Same shape as slide_count: follow-up UPDATE (createTaskCore's INSERT is
    // the canonical shared write path and does not carry this field), only on
    // a genuinely new card (deduped retries keep the prior row untouched), and
    // a failed write is logged, never fatal — the card exists either way. A
    // null phaseId means "producer sent nothing usable" and skips the write.
    if (phaseId !== undefined && !deduped) {
      try {
        run('UPDATE tasks SET stage_slug = ?, updated_at = updated_at WHERE id = ?', [
          phaseId,
          task.id,
        ]);
      } catch (stageErr) {
        console.error(
          '[INGEST] stage_slug write failed (non-fatal; migration 074 column missing on an ' +
            'out-of-date schema):',
          stageErr,
        );
      }
    }

    // TICKET 2 Fix A (L-14/L-18): the trust-coverage design (see the
    // humanDoorId comment above) treats an omitted requester_chat_id as
    // CORRECT for a producer/backfill call — it deliberately falls outside
    // the coverage denominator. That design has no way to tell that
    // legitimate omission apart from a LIVE client-channel caller (source
    // 'telegram' | 'bridge' | 'agent' — an OpenClaw agent fanning out on
    // behalf of a real conversation, e.g. `main`'s own ingest fan-out) that
    // simply forgot to pass it — exactly what happened to this incident's 3
    // task cards, silently, with no error and no signal anywhere except a
    // manual DB read. 'backfill' is the one source value that is explicitly
    // historical/non-live, so it is the only one exempted here. This does
    // NOT block task creation — it makes the gap queryable in events/
    // task_activities instead of invisible.
    //
    // WEBCHAT-REQUESTER-ROUTE: a task with NO chat id but a captured session
    // key is NOT unreachable — the trust engine addresses it over the gateway
    // session instead. Warning on it would be false, and silence would hide
    // which lane a client is being reported on, so it gets its own queryable
    // event naming the route that closed the gap.
    if (!requesterChatId && requesterSessionKey) {
      const sessionRouteMsg =
        `[requester_session_route_captured] Task "${task.title}" (${task.id}) was ingested with ` +
        `source=${source ?? '(none)'} and NO requester chat id, but carries an addressable gateway ` +
        `session key — the trust engine will report ACK/PROGRESS/DONE into that session instead of ` +
        `a chat. This is the webchat lane, not a gap.`;
      try {
        run(
          `INSERT INTO events (id, type, task_id, message, created_at)
           VALUES (?, 'requester_session_route_captured', ?, ?, ?)`,
          [uuidv4(), task.id, sessionRouteMsg, new Date().toISOString()],
        );
      } catch (writeErr) {
        console.error('[INGEST] requester_session_route_captured event write failed (non-fatal):', writeErr);
      }
    } else if (!requesterChatId && source !== 'backfill') {
      const missingChatIdMsg =
        `[requester_chat_id_missing] Task "${task.title}" (${task.id}) was ingested with ` +
        `source=${source ?? '(none)'} but no requester_chat_id — this task has no way to reach ` +
        `whoever requested it (no ACK/PROGRESS/DONE trust-engine message can be addressed). If ` +
        `this was a live client-facing request, the caller needs to supply requester_chat_id.`;
      try {
        run(
          `INSERT INTO events (id, type, task_id, message, created_at)
           VALUES (?, 'requester_chat_id_missing', ?, ?, ?)`,
          [uuidv4(), task.id, missingChatIdMsg, new Date().toISOString()],
        );
      } catch (writeErr) {
        console.error('[INGEST] requester_chat_id_missing event write failed (non-fatal):', writeErr);
      }
      console.warn(`[INGEST] ${missingChatIdMsg}`);
    }

    // Owner assignment notification now lives in createTaskCore (MR-36) so both
    // the UI create path and the ingest path share a single fire site.

    // Deduped tasks are returned as 200 (not 201) so callers can distinguish.
    if (deduped) {
      return NextResponse.json(
        {
          ok: true,
          deduped: true,
          operation_id: dedupeKey,
          task_id: task.id,
          workspace_id: task.workspace_id ?? workspaceId,
          resolved_by: resolvedBy,
          status: task.status,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        deduped: false,
        operation_id: dedupeKey,
        task_id: task.id,
        workspace_id: workspaceId,
        resolved_by: resolvedBy,
        status: task.status,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof TaskContextError) return NextResponse.json({error:error.message}, {status:error.status});
    if (error instanceof TaskRequestConflict) return NextResponse.json({ error: 'idempotency_conflict', message: error.message }, { status: 409 });
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[INGEST] Failed to ingest task:', error);

    // RESILIENCE (F6): a "no column named <x>" / "no such table" SqliteError means
    // this box's schema is behind — migrations have not run, or ran partially. The
    // canonical example is "table tasks has no column named sop_id" (fixed by
    // migration 056). Instead of an opaque 500 we (a) attempt to self-heal by
    // running pending migrations once (so future requests succeed), (b) escalate
    // to the owner via gateway so a human knows the box needs attention, and
    // (c) return a CLEAR, actionable 503 so the caller knows to retry after
    // migrations run. We never silently drop work.
    //
    // BUILD-SAFE NOTE: task-field variables (title, finalDescription, priority, etc.)
    // are declared INSIDE the try block and are NOT in scope here — a full
    // createTaskCore retry cannot compile. Self-heal only brings the schema current
    // for future requests; the caller must retry.
    const isSchemaError = /SqliteError|no column named|no such column|no such table/i.test(msg);
    if (isSchemaError) {
      console.error(`[INGEST] SCHEMA error detected ("${msg}") — attempting one-shot self-heal migrate.`);
      // INGEST-07 — run the self-heal migrate AT MOST ONCE per process, never
      // re-entered, and never concurrently with a live-ingest destructive dedup.
      if (selfHealState === 'idle') {
        selfHealState = 'running';
        const prevAdditiveFlag = process.env.OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY;
        process.env.OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY = '1';
        try {
          runMigrations(getDb());
          selfHealState = 'done';
          console.warn(
            '[INGEST] Self-heal migrate succeeded — future requests should clear. ' +
              'Returning 503 for this request so the caller can retry.',
          );
        } catch (migrateErr) {
          // Re-arm so a later request can retry a transient migrate failure.
          selfHealState = 'idle';
          console.error(
            '[INGEST] Self-heal migrate FAILED:',
            migrateErr instanceof Error ? migrateErr.message : String(migrateErr),
          );
        } finally {
          // Restore the flag exactly. runMigrations is synchronous, so no other
          // request observed this env mutation during the call.
          if (prevAdditiveFlag === undefined) delete process.env.OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY;
          else process.env.OPENCLAW_MIGRATE_SELF_HEAL_ADDITIVE_ONLY = prevAdditiveFlag;
        }
      } else {
        console.warn(
          `[INGEST] Self-heal already ${selfHealState} in this process — not re-running migrations; ` +
            'returning 503 so the caller can retry.',
        );
      }
      try {
        notifyOwnerSchemaError(msg);
      } catch {
        /* non-fatal — the clear 503 below is still returned to the caller */
      }
      // INGEST-08: do NOT echo the raw SqliteError text (`msg`) in the response
      // body — it leaks column/table names and internal schema shape to any
      // caller. It is already logged server-side above and sent to the owner.
      // Return a stable, static detail token instead.
      return NextResponse.json(
        {
          error: 'Command Center schema is out of date on this box — task NOT captured.',
          detail: 'schema_out_of_date',
          remediation:
            'Run database migrations on this box (restart the app, or `npm run db:seed`) and retry. ' +
            'The owner has been notified.',
          schema_error: true,
        },
        { status: 503 },
      );
    }

    return NextResponse.json({ error: 'Internal server error', detail: msg }, { status: 500 });
  }
}

/**
 * GET /api/tasks/ingest — describe the endpoint (no data, universal).
 */
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/tasks/ingest',
    method: 'POST',
    auth: 'x-webhook-signature: HMAC-SHA256(WEBHOOK_SECRET, rawBody) — REQUIRED in production (503 when unset); skipped only in development',
    accepts: {
      title: 'string (required)',
      description: 'string (optional)',
      priority: 'low|medium|high|critical (optional, default medium)',
      source: 'string (optional provenance)',
      source_ref: 'string (optional provenance / dedupe fallback)',
      department_slug: 'string (optional; resolves workspace, default CEO)',
      persona: 'string (optional; resolves workspace by name)',
      target_agent: 'string (optional; owner-direct specialist pin — routes straight to the named AI, alias: specialist)',
      external_session_id: 'string (optional provenance)',
      idempotency_key: 'string (optional; primary dedupe key)',
      context_refs: 'string | string[] (optional; FIX 56 W4.1 — doc-pointer references the CEO attaches; blank entries dropped, max 20; folded onto the card and carried into the dispatch ContextPack)',
      parent_task_id: 'string (optional; WI-15b — attaches this task as a per-phase CHILD of the named parent deck-run task. Validated: parent must exist AND be in this box\'s active company scope, else 400.)',
      requester_channel: 'string (optional; P1-04 trust engine — originating client channel, default telegram when requester_chat_id is present)',
      requester_chat_id: 'string (optional; P1-04 trust engine — client chat id the report-back loop acks/progress/done into)',
      requester_session_key:
        'string (optional; WEBCHAT-REQUESTER-ROUTE — OpenClaw gateway session key `agent:<agentId>:<peer>` of the originating conversation; the fallback address the report-back loop uses when there is no chat id. Falls back to external_session_id when that carries a real gateway key)',
      voice_persona_id: 'string (optional; B-U7 ingest parity — producer-resolved VOICE persona id. GATES the group below: pins directly instead of a fresh selector match; absent = async selector pin, unchanged)',
      topic_persona_id: 'string (optional; B-U7 — producer-resolved topic/craft-hint persona id. Ignored unless voice_persona_id is also present)',
      task_persona_ids: 'string[] (optional; B-U7 — producer-resolved task-slot persona ids. Ignored unless voice_persona_id is also present)',
      bundle_sha: 'string (optional; B-U7 — sha of the bundle the producer used. Ignored unless voice_persona_id is also present)',
    },
  });
}
