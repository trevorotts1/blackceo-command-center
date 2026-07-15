'use client';

/**
 * DepartmentBlockersPanel — U57 / JM-U53 part (c).
 *
 * Operational stats row (blocked-task count + average velocity) and the
 * blockers panel itself (the actual blocked tasks, linked to the department's
 * kanban board) for the `/ceo-board/[dept]` detail page. Both numbers come
 * from `computeDepartmentOperationalStats()` (src/lib/ceo-board/) so the
 * rendered blockers list length always equals the rendered count — same
 * single-computation discipline as `attention.ts`'s hero-count/panel-length
 * guarantee (U55).
 *
 * Honesty doctrine: a department with zero tasks yet renders "Insufficient
 * data" for velocity (never a fabricated 0 that reads as "definitely no
 * work"); a real zero blocked count still renders "0" plainly (0 IS the
 * honest answer once there is task history).
 */

import Link from 'next/link';
import { AlertTriangle, Gauge, ShieldCheck } from 'lucide-react';
import type { DepartmentOperationalStats } from '@/lib/ceo-board/department-operational-stats';

interface DepartmentBlockersPanelProps {
  deptId: string;
  stats: DepartmentOperationalStats;
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffHours < 1) return 'Just now';
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays}d ago`;
}

export function DepartmentBlockersPanel({ deptId, stats }: DepartmentBlockersPanelProps) {
  const { blockedCount, blockedTasks, avgVelocity, windowDays } = stats;

  return (
    <div className="space-y-4">
      {/* Operational stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div
          className={`rounded-2xl border p-5 flex items-center justify-between ${
            blockedCount > 0
              ? 'bg-red-50 border-red-100'
              : 'bg-white border-gray-100 shadow-sm'
          }`}
        >
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-1">
              Blocked Tasks
            </p>
            <p
              className={`text-2xl font-extrabold ${
                blockedCount > 0 ? 'text-red-600' : 'text-gray-900'
              }`}
            >
              {blockedCount}
            </p>
          </div>
          <div className={`p-3 rounded-full ${blockedCount > 0 ? 'bg-red-100' : 'bg-gray-50'}`}>
            {blockedCount > 0 ? (
              <AlertTriangle className="h-5 w-5 text-red-600" />
            ) : (
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
            )}
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-1">
              Avg Velocity
            </p>
            {avgVelocity !== null ? (
              <p className="text-2xl font-extrabold text-gray-900">
                {avgVelocity}
                <span className="text-sm font-medium text-gray-400 ml-1">per week</span>
              </p>
            ) : (
              <p className="text-sm font-medium text-gray-400 mt-1">Insufficient data</p>
            )}
          </div>
          <div className="p-3 rounded-full bg-brand-50">
            <Gauge className="h-5 w-5 text-brand-600" />
          </div>
        </div>
      </div>

      {/* Blockers panel — length always equals blockedCount above (same array) */}
      {blockedCount > 0 && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-gray-900">
              Blockers <span className="text-gray-400 font-medium">({blockedCount})</span>
            </h3>
            <Link
              href={`/ceo-board/${deptId}/focus`}
              className="text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              View board →
            </Link>
          </div>
          <ul className="divide-y divide-gray-50">
            {blockedTasks.map((task) => (
              <li key={task.id}>
                <Link
                  href={`/ceo-board/${deptId}/focus`}
                  className="flex items-start justify-between gap-3 py-2.5 group"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate group-hover:text-brand-600">
                      {task.title}
                    </p>
                    <p className="text-xs text-red-500 mt-0.5">{task.reason}</p>
                  </div>
                  <span className="shrink-0 text-xs text-gray-400">
                    {formatUpdatedAt(task.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-gray-300">
        Velocity averaged over a rolling {windowDays}-day window.
      </p>
    </div>
  );
}
