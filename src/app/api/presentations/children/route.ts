/**
 * GET /api/presentations/children?parent_id=<id>
 *
 * WI-15b (D1 Option B — NESTED subtasks): returns the child tasks for a
 * presentation department parent run, plus aggregate phase progress derived
 * from the children's task_activities and the parent's own activity feed.
 *
 * Each child corresponds to one of the 7 PHASE_LABELS. A child's status is
 * the literal tasks.status of that child row. Aggregate progress (X of N)
 * is computed from children whose status is 'done'.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  childPhaseLabel,
  computePhaseProgress,
  PHASE_LABELS,
} from '@/lib/presentation-phases';
import { resolveActiveCompanyId } from '@/lib/company';
import { boardWhereClause } from '@/lib/workspaces/board-query';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const parentId = searchParams.get('parent_id');

    if (!parentId) {
      return NextResponse.json(
        { error: 'parent_id query parameter is required' },
        { status: 400 },
      );
    }

    const db = getDb();

    // ── Company scope (closes cross-company read) ────────────────────────
    // tasks carry no direct company_id — only workspaces.company_id does —
    // so parent ownership is checked by joining through workspaces and
    // applying the SAME boardWhereClause the Kanban board itself uses, via
    // the SAME resolveActiveCompanyId + boardWhereClause convention
    // /api/performance already established for task-scoped queries. A task
    // whose workspace_id is NULL is the box's own unattributed data and
    // stays visible (matches boardWhereClause's own posture); a task whose
    // workspace resolves to an OUT-OF-SCOPE workspace (foreign company /
    // archived / residue) is treated as not found, same as a parent_id that
    // does not exist at all. Children are fetched below by parent_task_id,
    // so verifying the PARENT here closes the read for its whole child set.
    const activeCompanyId = resolveActiveCompanyId(db);
    const scope = boardWhereClause(activeCompanyId);
    const scopedWorkspaceIds = (
      db.prepare(`SELECT w.id FROM workspaces w ${scope.sql}`).all(...scope.params) as { id: string }[]
    ).map((w) => w.id);
    const scopeIdList = scopedWorkspaceIds.length > 0 ? scopedWorkspaceIds : ['__no_workspace__'];
    const scopePlaceholders = scopeIdList.map(() => '?').join(',');

    // Fetch parent row (company-scoped)
    const parent = db
      .prepare(
        `SELECT id, title, status, priority, department,
                process_certificate_sha, created_at
         FROM tasks
        WHERE id = ? AND (workspace_id IS NULL OR workspace_id IN (${scopePlaceholders}))`,
      )
      .get(parentId, ...scopeIdList) as Record<string, unknown> | undefined;

    if (!parent) {
      return NextResponse.json(
        { error: 'Parent task not found' },
        { status: 404 },
      );
    }

    // Fetch children keyed to this parent, ordered by their phase label
    // (stored in the child's title or department metadata). Children are
    // matched by parent_task_id.
    //
    // FIX 52 (W18a-B3): stage_slug is read CO-OPERATIONALLY — the column does
    // not exist on every box until W16a's migration 130 lands, so the SELECT
    // first probes the schema. On a pre-migration DB the query runs without
    // the column and every child just reports stage_slug: null (label then
    // falls back to the child's own activities/title, never to a title-only
    // guess where a real phase id exists).
    let children: Array<Record<string, unknown>>;
    const hasStageSlug = (
      db.prepare(
        `SELECT count(*) AS n FROM pragma_table_info('tasks') WHERE name = 'stage_slug'`,
      ).get() as { n: number }
    ).n > 0;
    if (hasStageSlug) {
      children = db
        .prepare(
          `SELECT id, title, status, priority, parent_task_id, stage_slug, created_at, updated_at
           FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC`,
        )
        .all(parentId) as Array<Record<string, unknown>>;
    } else {
      children = db
        .prepare(
          `SELECT id, title, status, priority, parent_task_id, created_at, updated_at
           FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC`,
        )
        .all(parentId) as Array<Record<string, unknown>>;
    }

    // For each child, fetch its task_activities so the PhaseStepper can
    // derive per-label status from the 26 manifest phase ids.
    const childrenWithPhases = children.map((child) => {
      const activities = db
        .prepare(
          'SELECT activity_type, metadata FROM task_activities WHERE task_id = ?',
        )
        .all(child.id as string) as Array<{
        activity_type: string;
        metadata?: string | null;
      }>;

      // FIX 50b — SELECT path alongside deliverable_type: the teleprompter is
      // detected by the basename of the registered path
      // (presenter-teleprompter.html), not by its type — the registration
      // contract's deliverable_type enum has no 'teleprompter' value.
      const deliverables = db
        .prepare(
          'SELECT deliverable_type, path FROM task_deliverables WHERE task_id = ?',
        )
        .all(child.id as string) as Array<{
        deliverable_type: string;
        path: string | null;
      }>;

      const progress = computePhaseProgress(activities, deliverables);

      // FIX 52 (W18a-B3): the child's canonical phase label — from its
      // explicit stage_slug (producer phase id) when known, else its own
      // activities' phase_id, else the legacy title match. Never the bare
      // title: 'P4-COPY' shows Script regardless of what the child is called.
      const phaseLabel =
        childPhaseLabel({
          stage_slug: (child.stage_slug as string | null | undefined) ?? null,
          activities,
          title: (child.title as string | null | undefined) ?? null,
        }) ?? (typeof child.title === 'string' ? child.title : null);

      return {
        id: child.id,
        title: child.title,
        status: child.status,
        priority: child.priority,
        created_at: child.created_at,
        updated_at: child.updated_at,
        stage_slug: (child.stage_slug as string | null | undefined) ?? null,
        phase_label: phaseLabel,
        phases: progress.phases.map((p) => ({
          label: p.label,
          status: p.status,
        })),
        unmapped: progress.unmapped,
      };
    });

    // Aggregate progress across all children: count children whose status is
    // 'done' (or 'in_progress') to derive X of N for the parent card.
    // F26: 'review' is NOT done — a child in review is awaiting QC verification,
    // and counting it as complete makes the parent show finished while phases
    // are still unverified.
    const doneCount = children.filter((c) => c.status === 'done').length;
    const inProgressCount = children.filter(
      (c) => c.status === 'in_progress',
    ).length;
    const totalChildren = children.length;

    // Derive the current phase label from the first child that is in_progress,
    // or the last child that is done/review.
    //
    // FIX 52 (W18a-B3): label resolution now goes through childPhaseLabel —
    // stage_slug / activity phase_id first, title substring only as the last
    // resort — so a child ingested with `phase_id: P4-COPY` and an arbitrary
    // title still drives the aggregate to Script.
    const labelOfChild = (child: Record<string, unknown>) =>
      childPhaseLabel({
        stage_slug: (child.stage_slug as string | null | undefined) ?? null,
        title: (child.title as string | null | undefined) ?? null,
      });
    let currentPhase: typeof PHASE_LABELS[number] | null = null;
    for (const child of children) {
      if (child.status === 'in_progress') {
        const label = labelOfChild(child);
        if (label) {
          currentPhase = label;
          break;
        }
      }
    }
    if (!currentPhase && children.length > 0) {
      // Fallback: use the last done/review child's label. F26 note: 'review'
      // still identifies the CURRENT phase position here — this loop locates
      // where the run is, it does not claim completion.
      for (let i = children.length - 1; i >= 0; i--) {
        if (
          children[i].status === 'done' ||
          children[i].status === 'review'
        ) {
          const label = labelOfChild(children[i]);
          if (label) {
            currentPhase = label;
            break;
          }
        }
      }
    }
    if (!currentPhase && children.length > 0) {
      // FIX 52 critic retry — a freshly ingested phase child lands in status
      // 'backlog' (src/app/api/tasks/ingest/route.ts:1070). Neither tier
      // above matches it, so a run whose only phase signal was an explicit
      // `phase_id` (stage_slug) still fell through to PHASE_LABELS[0]
      // ('Intake'). Final tier: the first child — in ingest order via the
      // stage_slug/activity/title chain labelOfChild resolves — whose status
      // is anything OTHER than a completed state ('done'/'review' excluded
      // so finished phases never masquerade as the current one; those are
      // the only terminal states the 10-status manifest in validation.ts
      // defines for this pointer). A P4-COPY child ingested moments ago now
      // drives the aggregate to Script even while it is still backlog and
      // dispatchable.
      for (const child of children) {
        if (child.status === 'done' || child.status === 'review') continue;
        const label = labelOfChild(child);
        if (label) {
          currentPhase = label;
          break;
        }
      }
    }

    return NextResponse.json({
      parent: {
        id: parent.id,
        title: parent.title,
        status: parent.status,
        priority: parent.priority,
        department: parent.department,
        process_certificate_sha: parent.process_certificate_sha,
        created_at: parent.created_at,
      },
      children: childrenWithPhases,
      aggregate: {
        total: totalChildren,
        done: doneCount,
        in_progress: inProgressCount,
        not_started: totalChildren - doneCount - inProgressCount,
        current_phase: currentPhase ?? PHASE_LABELS[0],
      },
    });
  } catch (error) {
    console.error(
      '[WI-15b] GET /api/presentations/children error:',
      error,
    );
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
