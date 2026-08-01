'use client';

/**
 * /operator/health — Workforce Health Dashboard (MR-08).
 *
 * Single pane for assessing workforce health at a glance:
 *   - Stuck-task counters (blocked, dispatch-stuck, review-stuck, stale in-progress)
 *   - Agent connectivity grid (status, idle time, current load)
 *   - Dispatch failure sparkline (last 48 hours, hourly)
 *   - SLA violation counters (per board-slas config)
 */

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Clock,
  RefreshCw,
  Users,
  Zap,
  Shield,
} from 'lucide-react';
import type { WorkforceHealthPayload } from '@/lib/operator/workforce-health';

const POLL_INTERVAL_MS = 30 * 1000;
const SPARKLINE_HOURS = 48;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Color-map for agent health states. */
const AGENT_HEALTH_MAP = {
  healthy: { dot: 'bg-emerald-500', label: 'Healthy', text: 'text-emerald-700' },
  idle: { dot: 'bg-amber-400', label: 'Idle', text: 'text-amber-700' },
  stale: { dot: 'bg-orange-500', label: 'Stale', text: 'text-orange-700' },
  offline: { dot: 'bg-red-500', label: 'Offline', text: 'text-red-700' },
} as const;

function StatTile({
  label,
  value,
  subtitle,
  icon,
  accent = 'text-bcc-text',
  warn = false,
  critical = false,
}: {
  label: string;
  value: number | string;
  subtitle?: string;
  icon: React.ReactNode;
  accent?: string;
  warn?: boolean;
  critical?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        critical
          ? 'border-red-200 bg-red-50'
          : warn
          ? 'border-amber-200 bg-amber-50'
          : 'border-bcc-border bg-bcc-white'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs uppercase tracking-[0.15em] text-bcc-text-muted font-semibold">
          {label}
        </span>
        <span className={critical ? 'text-red-500' : warn ? 'text-amber-500' : 'text-bcc-text-muted'}>
          {icon}
        </span>
      </div>
      <div className={`mt-1 text-kpi-value ${accent}`}>{value}</div>
      {subtitle && <p className="mt-1 text-xs text-bcc-text-secondary">{subtitle}</p>}
    </div>
  );
}

function AgentGridRow({ agent }: { agent: WorkforceHealthPayload['agents'][number] }) {
  const h = AGENT_HEALTH_MAP[agent.health];
  return (
    <Link
      href={`/agents/${agent.agentId}`}
      className="flex items-center gap-3 py-2.5 px-3 rounded-lg border border-bcc-border hover:bg-bcc-border-light transition-colors"
    >
      <span className="text-xl" role="img" aria-label={agent.agentName}>
        {agent.avatarEmoji}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-bcc-text truncate">{agent.agentName}</div>
        <div className="text-xs text-bcc-text-muted truncate">{agent.agentRole}</div>
      </div>
      <div className="flex items-center gap-3 text-right">
        <div>
          <div className="text-xs text-bcc-text-muted">Tasks</div>
          <div className="text-sm font-semibold text-bcc-text">{agent.currentTaskCount}</div>
        </div>
        <div>
          <div className="text-xs text-bcc-text-muted">Done</div>
          <div className="text-sm font-semibold text-bcc-text">{agent.completedCount}</div>
        </div>
        <div className="flex items-center gap-1.5 min-w-[72px] justify-end">
          <span className={`w-2 h-2 rounded-full ${h.dot}`} />
          <span className={`text-xs font-medium ${h.text}`}>{h.label}</span>
          {agent.idleMinutes !== null && agent.health !== 'offline' && (
            <span className="text-[11px] text-bcc-text-muted">
              {agent.idleMinutes < 60
                ? `${agent.idleMinutes}m`
                : `${Math.round(agent.idleMinutes / 60)}h`}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

function DispatchSparkline({ points }: { points: WorkforceHealthPayload['dispatchSparkline'] }) {
  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-bcc-text-muted">
        No dispatch activity in the last {SPARKLINE_HOURS}h.
      </div>
    );
  }

  // Normalize to 48 buckets (one per hour)
  const maxVal = Math.max(1, ...points.map((p) => p.dispatched + p.failed + p.held));
  const barWidth = 4;
  const barGap = 1;
  const totalWidth = SPARKLINE_HOURS * (barWidth + barGap);

  return (
    <div className="overflow-x-auto">
      <svg
        width={totalWidth}
        height={40}
        viewBox={`0 0 ${totalWidth} 40`}
        className="block"
        aria-label="Dispatch activity sparkline: last 48 hours"
        role="img"
      >
        {points.map((p, i) => {
          const x = i * (barWidth + barGap);
          const total = p.dispatched + p.failed + p.held;
          const totalH = Math.max(1, (total / maxVal) * 36);
          const dispatchedH = total > 0 ? (p.dispatched / total) * totalH : 0;
          const failedH = total > 0 ? (p.failed / total) * totalH : 0;
          const heldH = total > 0 ? (p.held / total) * totalH : 0;
          const y0 = 40 - totalH;

          return (
            <g key={p.hour}>
              {/* Dispatched (success) */}
              {dispatchedH > 0 && (
                <rect
                  x={x}
                  y={y0}
                  width={barWidth}
                  height={dispatchedH}
                  fill="#10B981"
                  rx={1}
                >
                  <title>{`${p.hour}: ${p.dispatched} dispatched`}</title>
                </rect>
              )}
              {/* Failed */}
              {failedH > 0 && (
                <rect
                  x={x}
                  y={y0 + dispatchedH}
                  width={barWidth}
                  height={failedH}
                  fill="#EF4444"
                  rx={1}
                >
                  <title>{`${p.hour}: ${p.failed} failed`}</title>
                </rect>
              )}
              {/* Held (triad gate) */}
              {heldH > 0 && (
                <rect
                  x={x}
                  y={y0 + dispatchedH + failedH}
                  width={barWidth}
                  height={heldH}
                  fill="#F59E0B"
                  rx={1}
                >
                  <title>{`${p.hour}: ${p.held} held`}</title>
                </rect>
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-4 mt-1.5 text-[11px] text-bcc-text-muted">
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
          Dispatched
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm bg-red-500" />
          Failed
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm bg-amber-500" />
          Held
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OperatorHealthPage() {
  const [data, setData] = useState<WorkforceHealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/operator/health-workforce', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as WorkforceHealthPayload);
      setError(null);
    } catch (err) {
      // Keep prior data visible on transient error
      if (!data) setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [data]);

  useEffect(() => {
    fetchHealth();
    const id = setInterval(fetchHealth, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchHealth]);

  const s = data?.stuckTasks;
  const sla = data?.slaViolations;

  const hasBlocked = (s?.blocked ?? 0) > 0;
  const hasSlaEscalate = (sla?.blockedPastEscalate ?? 0) > 0;
  const hasReviewStuck = (s?.reviewStuck ?? 0) > 0;
  const hasDispatchStuck = (s?.dispatchStuck ?? 0) > 0;

  return (
    <div className="space-y-8">
      <header>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
              Operator Console
            </div>
            <h1 className="mt-2 text-page-title text-bcc-text">
              Workforce Health
            </h1>
          </div>
          <button
            onClick={() => { setLoading(true); fetchHealth(); }}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-bcc-border bg-bcc-white text-sm text-bcc-text-secondary hover:bg-bcc-border-light disabled:opacity-50 transition-colors"
            title="Refresh workforce health"
            aria-label="Refresh workforce health"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[720px]">
          Single-pane view of agent connectivity, stuck-task counts, dispatch
          failures, and SLA violations. Updated every 30 seconds.
        </p>
      </header>

      {error && !data && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <p className="text-sm text-red-700">Failed to load workforce health: {error}</p>
        </div>
      )}

      {/* ---- Stuck-task counters ---- */}
      <section>
        <h2 className="text-section text-bcc-text flex items-center gap-2">
          <AlertTriangle size={20} className="text-bcc-text-muted" />
          Stuck Tasks
        </h2>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatTile
            label="Blocked"
            value={s?.blocked ?? '—'}
            subtitle={hasBlocked ? `${s?.blockedByOwner ?? 0} owner, ${s?.blockedSystem ?? 0} system` : undefined}
            icon={<Shield size={18} />}
            critical={hasBlocked}
          />
          <StatTile
            label="Dispatch Stuck"
            value={s?.dispatchStuck ?? '—'}
            subtitle="pending &gt;2h"
            icon={<Zap size={18} />}
            warn={hasDispatchStuck}
          />
          <StatTile
            label="Review Stuck"
            value={s?.reviewStuck ?? '—'}
            subtitle="unscored &gt;24h"
            icon={<Clock size={18} />}
            warn={hasReviewStuck}
          />
          <StatTile
            label="In-Progress Stale"
            value={s?.inProgressStale ?? '—'}
            subtitle="no update &gt;48h"
            icon={<Clock size={18} />}
          />
          <StatTile
            label="SLA: Blocked Escalate"
            value={sla?.blockedPastEscalate ?? '—'}
            subtitle="past operator threshold"
            icon={<AlertTriangle size={18} />}
            critical={hasSlaEscalate}
          />
          <StatTile
            label="SLA: Backlog Nudge"
            value={sla?.backlogPastNudge ?? '—'}
            subtitle="past stale threshold"
            icon={<Clock size={18} />}
          />
        </div>
      </section>

      {/* ---- Agent connectivity grid ---- */}
      <section>
        <h2 className="text-section text-bcc-text flex items-center gap-2">
          <Users size={20} className="text-bcc-text-muted" />
          Agent Fleet
        </h2>
        <p className="mt-1 text-sm text-bcc-text-secondary">
          {data?.agents.length ?? 0} agents. Click any row to open the agent detail page.
        </p>
        <div className="mt-3 space-y-1">
          {data?.agents.map((a) => (
            <AgentGridRow key={a.agentId} agent={a} />
          ))}
          {data && data.agents.length === 0 && (
            <div className="text-sm text-bcc-text-muted py-4 text-center">
              No agents registered.
            </div>
          )}
        </div>
      </section>

      {/* ---- Dispatch failure sparkline ---- */}
      <section>
        <h2 className="text-section text-bcc-text flex items-center gap-2">
          <Zap size={20} className="text-bcc-text-muted" />
          Dispatch Activity
        </h2>
        <p className="mt-1 text-sm text-bcc-text-secondary">
          Last {SPARKLINE_HOURS} hours. Green = dispatched, Red = failed, Amber = held at triad gate.
        </p>
        <div className="mt-3 rounded-xl border border-bcc-border bg-bcc-white p-4">
          <DispatchSparkline points={data?.dispatchSparkline ?? []} />
        </div>
      </section>

      {/* ---- Last computed ---- */}
      {data && (
        <footer className="text-[11px] text-bcc-text-muted">
          Snapshot computed at {new Date(data.computedAt).toLocaleString()}.
        </footer>
      )}
    </div>
  );
}
