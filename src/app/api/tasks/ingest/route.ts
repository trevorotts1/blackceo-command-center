import { NextRequest, NextResponse } from 'next/server';
import { createHmac, createHash } from 'crypto';
import { queryOne, getDb } from '@/lib/db';
import { runMigrations } from '@/lib/db/migrations';
import { createTaskCore } from '@/lib/tasks';
import { routeTask } from '@/lib/routing/department-router';
import type { TaskPriority } from '@/lib/types';
import { notifyOwnerAssigned, notifyOwnerSchemaError } from '@/lib/owner-reports';
import { getSelfClient } from '@/lib/clients';
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
 *   "idempotency_key": "sha256(...)"                         // optional; primary dedupe key
 * }
 */

interface IngestPayload {
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
}

const VALID_PRIORITIES = new Set<TaskPriority>(['low', 'medium', 'high', 'critical']);

function verifyWebhookSignature(signature: string | null, rawBody: string): boolean {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (!webhookSecret) return true; // Dev mode — skip validation.
  if (!signature) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return signature === expected;
}

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
function isWorkforceProvisioned(): { provisioned: boolean; reason: string } {
  // (2) Materialized, non-shell departments with a live specialist agent.
  const materialized = queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT w.id) AS n
       FROM workspaces w
       JOIN agents a
         ON a.workspace_id = w.id
        AND a.is_master = 0
        AND a.status != 'offline'
      WHERE lower(w.slug) NOT IN
              ('master-orchestrator', 'ceo', 'dept-ceo',
               'general-task', 'dept-general-task', 'general')
        AND lower(w.name) NOT IN
              ('ceo', 'master orchestrator', 'general task', 'general')`,
    [],
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
function resolveWorkspaceId(
  departmentSlug: string | undefined,
  persona: string | undefined
): { workspaceId: string | null; resolvedBy: string } {
  // 1. department_slug → workspaces.slug (or id).
  if (departmentSlug) {
    const slug = departmentSlug.toLowerCase();
    const bySlug = queryOne<{ id: string }>(
      'SELECT id FROM workspaces WHERE lower(slug) = ? OR lower(id) = ? LIMIT 1',
      [slug, slug]
    );
    if (bySlug) return { workspaceId: bySlug.id, resolvedBy: `department_slug:${departmentSlug}` };
  }

  // 2. persona → workspaces.name (case-insensitive). Lets a caller route by the
  //    department head/persona name without knowing the slug.
  if (persona) {
    const byName = queryOne<{ id: string }>(
      'SELECT id FROM workspaces WHERE lower(name) = ? LIMIT 1',
      [persona.toLowerCase()]
    );
    if (byName) return { workspaceId: byName.id, resolvedBy: `persona:${persona}` };
  }

  // INGEST-06 — EXPLICIT-but-unrecognized department slug.
  // When the caller EXPLICITLY supplied a department_slug that resolved to no
  // workspace (tier 1 missed) and no persona rescued it (tier 2 missed), we must
  // NOT let it soft-fall into the CEO catch-all or the first arbitrary workspace
  // below (P4 misroute): that silently drops a mis-tagged task onto a real,
  // unrelated department and makes it look correctly routed. Instead route it to
  // the honest `general-task` catch-all — tagged `unrecognized-slug->general` so a
  // QC sweep can flag the mis-tag — or, if this box has no general-task workspace,
  // leave workspace_id NULL (FK-safe; the card is still captured and visible in the
  // All Tasks view) rather than guessing a department. `general-task` is the "we
  // could not route this" bucket; it is NOT an arbitrary department.
  if (departmentSlug) {
    const general = queryOne<{ id: string }>(
      `SELECT id FROM workspaces
        WHERE lower(slug) IN ('general-task', 'dept-general-task', 'general')
           OR lower(name) IN ('general task', 'general')
        ORDER BY rowid ASC LIMIT 1`,
      [],
    );
    if (general) return { workspaceId: general.id, resolvedBy: 'unrecognized-slug->general' };
    return { workspaceId: null, resolvedBy: 'unrecognized-slug->unrouted' };
  }

  // 3. CEO catch-all. Match all canonical CEO/master-orchestrator slugs.
  //    The canonical slug is `master-orchestrator` (migration 051 rewrites
  //    legacy `ceo` / `dept-ceo` slugs on first boot), so we include all
  //    three to work on both migrated and legacy databases.  Display name
  //    is free text (the client's main-agent persona), so we match only
  //    'ceo' and 'master orchestrator' as name fallbacks.
  const ceo = queryOne<{ id: string }>(
    `SELECT id FROM workspaces
      WHERE lower(slug) IN ('master-orchestrator', 'ceo', 'dept-ceo')
         OR lower(name) IN ('ceo', 'master orchestrator')
      ORDER BY sort_order ASC LIMIT 1`,
    []
  );
  if (ceo) return { workspaceId: ceo.id, resolvedBy: 'ceo-fallback' };

  // 4. General-task workspace — the correct catch-all when no CEO is seeded.
  //    Bare tasks that cannot be semantically routed land here rather than
  //    erroring out.
  const general = queryOne<{ id: string }>(
    `SELECT id FROM workspaces
      WHERE lower(slug) IN ('general-task', 'dept-general-task', 'general')
         OR lower(name) IN ('general task', 'general')
      ORDER BY rowid ASC LIMIT 1`,
    []
  );
  if (general) return { workspaceId: general.id, resolvedBy: 'general-task-fallback' };

  // 5. ANY workspace — last real resort so we never pass a nonexistent sentinel.
  //    A bare install with at least one workspace seeded will always reach this.
  const anyWs = queryOne<{ id: string }>(
    `SELECT id FROM workspaces ORDER BY rowid ASC LIMIT 1`,
    []
  );
  if (anyWs) return { workspaceId: anyWs.id, resolvedBy: 'first-workspace-fallback' };

  // 6. Truly empty install (no workspaces at all) — pass null so createTaskCore
  //    inserts without a workspace FK rather than crashing on a nonexistent id.
  //    The task will be visible in the All Tasks board view.
  return { workspaceId: null, resolvedBy: 'no-workspace-fallback' };
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
    const allowInsecure = process.env.ALLOW_INSECURE_OPEN_API === 'true';
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
         WHERE t.id = ?
         LIMIT 1`,
        [existingTaskId],
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
           WHERE t.id = ? AND a.is_master = 0
           LIMIT 1`,
          [embeddedTaskId],
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
    const source = typeof body.source === 'string' ? body.source.trim() : undefined;
    const sourceRef = typeof body.source_ref === 'string' ? body.source_ref.trim() : undefined;
    const departmentSlug =
      typeof body.department_slug === 'string' ? body.department_slug.trim() : undefined;
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

    const priorityRaw = typeof body.priority === 'string' ? body.priority.trim() : undefined;
    const priority: TaskPriority | undefined =
      priorityRaw && VALID_PRIORITIES.has(priorityRaw as TaskPriority)
        ? (priorityRaw as TaskPriority)
        : undefined;

    // Deterministic dedupe key: idempotency_key wins, else source_ref, else a
    // synthesized intrinsic key.
    // NOTE: The actual idempotency check lives in createTaskCore (Layer 1). We
    // pass the key through so createTaskCore embeds it in the event message AND
    // checks it before inserting.
    //
    // INGEST-01 — a bare retry that supplies NEITHER an idempotency_key NOR a
    // source_ref previously reached createTaskCore with no Layer-1 anchor, so two
    // identical posts (a Telegram/backfill retry) each created a card. INGEST-02 —
    // Layer 2's title window is workspace-scoped, so a retry that routed to a
    // DIFFERENT workspace evaded it too. Synthesizing
    // sha256(title | source | external_session_id) gives Layer 1 a
    // workspace-INDEPENDENT anchor for every ingest, so an identical retry
    // collapses onto the first card regardless of which workspace routing picked.
    // Layer 2 in createTaskCore stays intact for other keyless callers (UI, plain
    // Telegram) — this synthesis is scoped to the ingest front door only.
    const syntheticDedupeKey =
      'auto:' +
      createHash('sha256')
        .update(`${title}|${source ?? ''}|${externalSessionId ?? ''}`)
        .digest('hex');
    const dedupeKey = idempotencyKey || sourceRef || syntheticDedupeKey;

    let { workspaceId, resolvedBy }: { workspaceId: string | null; resolvedBy: string } = resolveWorkspaceId(departmentSlug, persona);
    let resolvedDepartment: string | undefined = departmentSlug;
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
          workspace_id: undefined,
        });
        if (pin) {
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
          console.warn(
            `[INGEST] Owner named specialist "${targetAgent}" but no matching agent was ` +
              `found — falling back to normal routing.`,
          );
        }
      } catch (pinErr) {
        console.warn(
          '[INGEST] Specialist-pin resolution failed (non-fatal), continuing with normal routing:',
          (pinErr as Error).message,
        );
      }
    }

    // ── W3.1: INTERVIEW-COMPLETED routing gate (spec §3) ──────────────────────
    // Automatic department routing is an obligation ONLY for a provisioned
    // zero-human company (completed interview + materialized departments).
    // An interview-incomplete / shell box is EXEMPT: the task is still captured,
    // but we do NOT force it through department classification.
    const provisioning = isWorkforceProvisioned();
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
    if (!departmentSlug && !pinnedAgentId && provisioning.provisioned) {
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
        });
        if (routing) {
          // Override the CEO/default workspace with the resolved department
          // workspace so the task lands on the right Kanban column.
          const resolvedWs = queryOne<{ id: string }>(
            `SELECT id FROM workspaces
              WHERE lower(name) = ? OR lower(slug) = ?
              LIMIT 1`,
            [routing.department.toLowerCase(), routing.department.toLowerCase()],
          );
          if (resolvedWs) {
            workspaceId = resolvedWs.id;
            resolvedBy = `auto-route:${routing.department}`;
          }
          resolvedDepartment = routing.department;
          console.log(
            `[INGEST] Auto-routed "${title}" → department "${routing.department}" (${routing.reason})`,
          );
        } else {
          // routeTask returned null — no confident match; fall back to
          // 'general-task' slug so the task is never left unrouted in backlog.
          const generalWs = queryOne<{ id: string }>(
            `SELECT id FROM workspaces
              WHERE lower(slug) IN ('general-task', 'dept-general-task')
                 OR lower(name) IN ('general task', 'general')
              LIMIT 1`,
            [],
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
    if (sourceRef) provenanceLines.push(`Ref: ${sourceRef}`);
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
        eventMessage,
        // Pass idempotency key through so createTaskCore embeds it in the
        // task_created event AND checks it before writing a new row.
        idempotency_key: dedupeKey ?? null,
      },
      { origin: request.headers.get('origin') }
    );

    if (!result) {
      return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
    }

    const { task, deduped } = result;

    // W5.2 — ASSIGNMENT owner notification (spec §5): fires when a department was
    // resolved, so the owner knows "I'm sending this task to the [Dept] department."
    // Best-effort; gateway-routed; deduped tasks skip since they were already notified.
    if (!deduped && resolvedDepartment) {
      try { notifyOwnerAssigned(task.id, { department: resolvedDepartment }); } catch { /* non-fatal */ }
    }

    // Deduped tasks are returned as 200 (not 201) so callers can distinguish.
    if (deduped) {
      return NextResponse.json(
        {
          ok: true,
          deduped: true,
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
        task_id: task.id,
        workspace_id: workspaceId,
        resolved_by: resolvedBy,
        status: task.status,
      },
      { status: 201 }
    );
  } catch (error) {
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
      return NextResponse.json(
        {
          error: 'Command Center schema is out of date on this box — task NOT captured.',
          detail: msg,
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
    },
  });
}
