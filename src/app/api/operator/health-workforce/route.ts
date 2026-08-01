/**
 * GET /api/operator/health-workforce
 *
 * MR-08: Single-pane workforce health endpoint. Returns stuck-task counters,
 * per-agent connectivity, a dispatch-failure sparkline, and SLA violations.
 *
 * Everything is computed on-read from existing SQLite rows. No mutations,
 * no provider calls — a pure read-only probe.
 *
 * Response shape: WorkforceHealthPayload
 *   {
 *     computedAt: ISO-8601,
 *     stuckTasks: { blocked, blockedByOwner, blockedSystem, dispatchStuck, reviewStuck, inProgressStale },
 *     agents: [{ agentId, agentName, agentRole, avatarEmoji, status, currentTaskCount, completedCount, lastActiveAt, idleMinutes, health }],
 *     dispatchSparkline: [{ hour, dispatched, failed, held }],
 *     slaViolations: { blockedPastOwnerReping, blockedPastEscalate, reviewPastUnscored, backlogPastNudge }
 *   }
 */

import { NextResponse } from 'next/server';
import { getWorkforceHealth } from '@/lib/operator/workforce-health';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const payload = getWorkforceHealth();
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('[/api/operator/health-workforce] failed:', err);
    return NextResponse.json(
      {
        computedAt: new Date().toISOString(),
        stuckTasks: { blocked: 0, blockedByOwner: 0, blockedSystem: 0, dispatchStuck: 0, reviewStuck: 0, inProgressStale: 0 },
        agents: [],
        dispatchSparkline: [],
        slaViolations: { blockedPastOwnerReping: 0, blockedPastEscalate: 0, reviewPastUnscored: 0, backlogPastNudge: 0 },
        error: err instanceof Error ? err.message : 'unknown',
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
