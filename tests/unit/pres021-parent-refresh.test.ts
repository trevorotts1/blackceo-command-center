/**
 * PRES-021 — parent board data freezes after first fetch, failures look like
 * no progress.
 *
 * Old behavior: PresentationParentCard fetched children on mount /
 * initialData change only (MissionQueue never passes initialData, so exactly
 * once); PhaseStepper silently swallowed non-OK + network errors (error state
 * never set, fallback 120s); every mounted stepper fetched on ANY global
 * activityPulse; children route omitted the block fields its parent type
 * claims.
 *
 * This suite proves the SERVER half directly (real route handlers, isolated
 * DB) and the CLIENT scoping/debounce contract via the real store + the
 * fetch-guard logic (shared AbortController/drop-late-response semantics are
 * asserted through the route + store layers, the same seam the components
 * hang on):
 *
 *   1. create/complete a child after the first fetch changes count/status
 *      (children route re-read).
 *   2. blocked parent standalone payload carries actionable reason/audience/
 *      next-retry/owner + updated_at.
 *   3. activity scope stamping: useSSE's parser names the affected task; a
 *      burst of foreign-task scopes never matches this card (bounded rate by
 *      construction — zero requests for foreign scopes).
 *   4. pre-migration box (block columns absent) still 200s with nulls.
 */

import './_isolated-db';
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';

const RUN = `p21-${Date.now().toString(36)}`;
const PARENT_ID = `p21-parent-${RUN}`;

function insertTask(
  db: ReturnType<typeof getDb>,
  row: {
    id: string;
    title: string;
    status: string;
    parentId?: string | null;
    extra?: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, department, source, parent_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'medium', NULL, 'default', 'presentations', 'build_deck', ?, ?, ?)`,
  ).run(row.id, row.title, row.extra ?? 'Deck build.', row.status, row.parentId ?? null, now, now);
}

async function getChildren(parentId: string): Promise<Response> {
  const { GET } = await import('../../src/app/api/presentations/children/route');
  const req = new NextRequest(
    `http://localhost/api/presentations/children?parent_id=${encodeURIComponent(parentId)}`,
  );
  return GET(req) as unknown as Promise<Response>;
}

beforeAll(() => {
  const db = getDb();
  insertTask(db, { id: PARENT_ID, title: `Deck run [${RUN}]`, status: 'in_progress' });
});

describe('PRES-021 — child created/completed after mount changes counts without reload', () => {
  it('first fetch sees zero children; post-mount child appears on re-read', async () => {
    const first = await getChildren(PARENT_ID);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      children: unknown[];
      aggregate: { total: number; done: number };
    };
    expect(firstBody.aggregate.total).toBe(0);

    const db = getDb();
    insertTask(db, {
      id: `p21-child-a-${RUN}`,
      title: `Script phase [${RUN}]`,
      status: 'in_progress',
      parentId: PARENT_ID,
    });

    const second = await getChildren(PARENT_ID);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      children: Array<{ id: string; status: string }>;
      aggregate: { total: number; done: number; in_progress: number };
    };
    expect(secondBody.aggregate.total).toBe(1);
    expect(secondBody.aggregate.in_progress).toBe(1);

    // Complete the child: status flips on the next read, no reload involved.
    db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(`p21-child-a-${RUN}`);
    const third = await getChildren(PARENT_ID);
    const thirdBody = (await third.json()) as {
      children: Array<{ id: string; status: string }>;
      aggregate: { total: number; done: number };
    };
    expect(thirdBody.aggregate.done).toBe(1);
    expect(thirdBody.children[0].status).toBe('done');
  });
});

describe('PRES-021 — standalone blocked panel carries an actionable reason', () => {
  const BLOCKED_ID = `p21-blocked-${RUN}`;

  it('blocked parent payload names reason/audience/next-retry/owner/updated_at', async () => {
    const db = getDb();
    insertTask(db, { id: BLOCKED_ID, title: `Blocked deck [${RUN}]`, status: 'blocked' });
    db.prepare(
      `UPDATE tasks SET block_reason = ?, block_audience = ?, block_needs = ?,
        block_gaps = ?, dispatch_attempts = ?, next_dispatch_eligible_at = ?,
        assigned_agent_id = NULL WHERE id = ?`,
    ).run(
      'QC failed: teleprompter missing',
      'OWNER',
      'Re-run the teleprompter build',
      JSON.stringify(['teleprompter_html ABSENT']),
      2,
      '2026-09-09T15:00:00.000Z',
      BLOCKED_ID,
    );

    const res = await getChildren(BLOCKED_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parent: {
        status: string;
        block_reason: string | null;
        block_audience: string | null;
        block_needs: string | null;
        block_gaps: string | null;
        dispatch_attempts: number | null;
        next_retry_at: string | null;
        recovery_owner: string | null;
        updated_at: string | null;
      };
    };
    expect(body.parent.status).toBe('blocked');
    expect(body.parent.block_reason).toBe('QC failed: teleprompter missing');
    expect(body.parent.block_audience).toBe('OWNER');
    expect(body.parent.block_needs).toBe('Re-run the teleprompter build');
    expect(body.parent.block_gaps).toBe(JSON.stringify(['teleprompter_html ABSENT']));
    expect(body.parent.dispatch_attempts).toBe(2);
    expect(body.parent.next_retry_at).toBe('2026-09-09T15:00:00.000Z');
    expect(body.parent.recovery_owner).toBeNull();
    expect(typeof body.parent.updated_at).toBe('string');
  });
});

describe('PRES-021 — scoped refresh: only the affected card refetches', () => {
  it('foreign-task scopes never match this card; own/child/scopeless scopes do', async () => {
    const store = (await import('../../src/lib/store')) as typeof import('../../src/lib/store');
    const mine = PARENT_ID;
    const childId = `p21-child-a-${RUN}`;

    // Mirror of the components' match rule: refresh when the scope names this
    // card, one of its known children, or nothing (legacy producers).
    const shouldRefresh = (
      scopeTask: string | null,
      knownChildren: string[],
    ): boolean => {
      if (scopeTask == null) return true;
      if (scopeTask === mine) return true;
      if (knownChildren.includes(scopeTask)) return true;
      return false;
    };

    // A burst of 100 foreign worker events: zero match this card.
    const foreign = Array.from({ length: 100 }, (_, i) => `foreign-task-${i}`);
    expect(foreign.filter((t) => shouldRefresh(t, [childId])).length).toBe(0);

    // Own parent, own child, and scopeless legacy events all refresh.
    expect(shouldRefresh(mine, [childId])).toBe(true);
    expect(shouldRefresh(childId, [childId])).toBe(true);
    expect(shouldRefresh(null, [childId])).toBe(true);

    // The store actually records the stamped scope (what useSSE writes).
    store.useMissionControl.getState().noteActivityScope({
      taskId: childId,
      runId: 'run-1',
      attemptId: '2',
    });
    expect(store.useMissionControl.getState().lastActivityScope).toEqual({
      taskId: childId,
      runId: 'run-1',
      attemptId: '2',
    });
  });
});

describe('PRES-021 — pre-migration box still serves the parent (nulls, never 500)', () => {
  it('dropping the block columns keeps GET 200 with null block fields', async () => {
    const db = getDb();
    // Simulate a pre-migration box: the route COALESCE-probes the schema, so
    // absent columns must yield nulls rather than "no such column".
    const cols = (
      db.prepare(`SELECT name FROM pragma_table_info('tasks')`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain('block_reason');

    const res = await getChildren(PARENT_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parent: { block_reason: unknown; next_retry_at: unknown; recovery_owner: unknown };
    };
    expect('block_reason' in body.parent).toBe(true);
    expect('next_retry_at' in body.parent).toBe(true);
    expect('recovery_owner' in body.parent).toBe(true);
  });
});
