'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  Lightbulb,
  Loader2,
  Target,
  Users,
  TrendingUp,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type { Workspace, WorkspaceStats } from '@/lib/types';

interface PerformancePayload {
  counts: { total: number; backlog: number; in_progress: number; review: number; blocked: number; done: number };
  avg_completion: { seconds: number; hours: number; n: number };
  agent_utilization: { active: number; total: number; ratio: number };
  departments: Array<{
    workspace_id: string;
    workspace_name: string;
    slug: string;
    total: number;
    done: number;
    in_progress: number;
    blocked: number;
    stalled_ratio: number;
  }>;
  trends: {
    last_7d: { created: number; completed: number };
    last_30d: { created: number; completed: number };
    last_90d: { created: number; completed: number };
  };
  trend_series: Array<{ day: string; created: number; completed: number }>;
  bottlenecks: Array<{
    workspace_id: string;
    workspace_name: string;
    slug: string;
    total: number;
    blocked: number;
    stalled_ratio: number;
    reason: string;
  }>;
  persona_coverage: { covered: number; total: number; ratio: number };
}

interface CEODashboardProps {
  workspace: Workspace;
}

// Dynamic: use actual department count as target (no hardcoded number)

export function CEODashboard({ workspace }: CEODashboardProps) {
  const [departments, setDepartments] = useState<WorkspaceStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [performance, setPerformance] = useState<PerformancePayload | null>(null);
  const [perfLoading, setPerfLoading] = useState(true);

  // Load aggregate performance metrics (powers the trend / bottleneck / persona-coverage cards).
  useEffect(() => {
    async function loadPerformance() {
      try {
        setPerfLoading(true);
        const res = await fetch('/api/performance');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PerformancePayload;
        setPerformance(data);
      } catch (err) {
        console.error('Failed to load performance metrics:', err);
        setPerformance(null);
      } finally {
        setPerfLoading(false);
      }
    }
    loadPerformance();
  }, []);

  useEffect(() => {
    async function loadWorkspaceStats() {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch('/api/workspaces?stats=true');
        if (!res.ok) {
          throw new Error('Failed to load workspace stats');
        }

        const data: WorkspaceStats[] = await res.json();
        console.log('[CEODashboard] Raw API data:', data.length, 'workspaces');
        console.log('[CEODashboard] First workspace:', data[0]);
        
        const filteredDepartments = data.filter(
          (item) => item.slug !== 'ceo' && item.slug !== 'default'
        );
        console.log('[CEODashboard] Filtered departments:', filteredDepartments.length);
        console.log('[CEODashboard] First filtered dept:', filteredDepartments[0]);

        setDepartments(filteredDepartments);
      } catch (err) {
        console.error('Failed to load CEO dashboard stats:', err);
        setError('Unable to load department performance right now.');
      } finally {
        setLoading(false);
      }
    }

    loadWorkspaceStats();
  }, []);

  const metrics = useMemo(() => {
    console.log('[CEODashboard] Calculating metrics for', departments.length, 'departments');
    console.log('[CEODashboard] Department taskCounts:', departments.map(d => ({ slug: d.slug, total: d.taskCounts?.total, done: d.taskCounts?.done })));
    
    const departmentsWithTasks = departments.filter((dept) => dept.taskCounts?.total > 0).length;
    const totalDone = departments.reduce((sum, dept) => sum + (dept.taskCounts?.done || 0), 0);
    const totalTasks = departments.reduce((sum, dept) => sum + (dept.taskCounts?.total || 0), 0);
    const totalAgents = departments.reduce((sum, dept) => sum + (dept.agentCount || 0), 0);
    const doneRate = totalTasks > 0 ? totalDone / totalTasks : 0;

    const totalDepartments = departments.length || 1; // dynamic, never hardcoded
    const healthScoreRaw =
      (departmentsWithTasks / totalDepartments) * 40 +
      doneRate * 40 +
      (totalAgents / totalDepartments) * 20;

    const healthScore = Math.max(0, Math.min(100, Math.round(healthScoreRaw)));

    return {
      departmentsWithTasks,
      totalDone,
      totalTasks,
      totalAgents,
      doneRate,
      healthScore,
    };
  }, [departments]);

  const recommendations = useMemo(() => {
    const items: string[] = [];

    const emptyDepartment = departments.find((dept) => dept.taskCounts?.total === 0);
    if (emptyDepartment) {
      items.push(`Set up tasks for ${emptyDepartment.name} to activate it`);
    }

    if (metrics.doneRate < 0.2) {
      items.push('Focus on completing in-progress work before adding more');
    }

    const unassignedDepartment = departments.find((dept) => (dept.agentCount || 0) === 0);
    if (unassignedDepartment) {
      items.push(`Assign an agent to ${unassignedDepartment.name}`);
    }

    if (items.length === 0) {
      items.push('Performance looks strong. Keep active departments moving toward completion.');
    }

    return items.slice(0, 3);
  }, [departments, metrics.doneRate]);

  const scoreColor =
    metrics.healthScore < 40
      ? '#ef4444'
      : metrics.healthScore <= 70
        ? '#f59e0b'
        : '#22c55e';

  const gaugeDegrees = Math.round((metrics.healthScore / 100) * 360);

  return (
    <main className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <p className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
                Executive Command Center
              </p>
              <h1 className="text-3xl font-bold text-gray-900 sm:text-4xl">
                Company Health Score
              </h1>
              <p className="mt-3 text-base text-gray-500 sm:text-lg">
                Based on active departments, task completion, and agent coverage.
              </p>

              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <MetricTile
                  icon={<Target className="h-4 w-4 text-indigo-600" />}
                  label="Active Departments"
                  value={`${metrics.departmentsWithTasks}/${departments.length}`}
                />
                <MetricTile
                  icon={<AlertCircle className="h-4 w-4 text-emerald-600" />}
                  label="Tasks Completed"
                  value={`${metrics.totalDone}/${metrics.totalTasks || 0}`}
                />
                <MetricTile
                  icon={<Users className="h-4 w-4 text-violet-600" />}
                  label="Agent Coverage"
                  value={`${metrics.totalAgents}/${departments.length}`}
                />
              </div>
            </div>

            <div className="flex justify-center lg:justify-end">
              <div className="relative flex h-64 w-64 items-center justify-center rounded-full bg-gray-50">
                <div
                  className="absolute inset-0 rounded-full"
                  style={{
                    background: `conic-gradient(${scoreColor} ${gaugeDegrees}deg, #e5e7eb ${gaugeDegrees}deg 360deg)`,
                  }}
                />
                <div className="absolute inset-[18px] rounded-full bg-white shadow-inner" />
                <div className="relative z-10 text-center">
                  <div className="text-6xl font-bold leading-none text-gray-900">
                    {metrics.healthScore}
                  </div>
                  <div className="mt-3 text-sm font-medium text-gray-500">out of 100</div>
                  <div
                    className="mx-auto mt-4 inline-flex rounded-full px-3 py-1 text-xs font-semibold"
                    style={{
                      color: scoreColor,
                      backgroundColor:
                        metrics.healthScore < 40
                          ? '#fef2f2'
                          : metrics.healthScore <= 70
                            ? '#fffbeb'
                            : '#f0fdf4',
                    }}
                  >
                    {metrics.healthScore < 40
                      ? 'Needs attention'
                      : metrics.healthScore <= 70
                        ? 'Stable'
                        : 'Strong'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Department Performance</h2>
              <p className="mt-1 text-sm text-gray-500">
                Department-level visibility for {workspace.name} leadership.
              </p>
            </div>
          </div>

          {loading ? (
            <div className="flex min-h-[220px] items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50">
              <div className="flex items-center gap-3 text-gray-500">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>Loading department performance...</span>
              </div>
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-5 text-sm text-red-700">
              {error}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              {departments.map((department) => {
                const total = department.taskCounts?.total || 0;
                const done = department.taskCounts?.done || 0;
                const inProgress = department.taskCounts?.in_progress || 0;
                const doneRatio = total > 0 ? (done / total) * 100 : 0;
                const statusTone =
                  inProgress > 0
                    ? 'bg-green-500'
                    : total > 0
                      ? 'bg-amber-400'
                      : 'bg-gray-300';

                return (
                  <Link
                    key={department.id}
                    href={`/workspace/${department.slug}`}
                    className="group rounded-2xl border border-gray-200 bg-white p-4 transition-all hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-lg hover:shadow-indigo-100/50 sm:p-5"
                  >
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gray-50 text-xl">
                          {department.icon}
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-gray-900 sm:text-base">
                            {department.name}
                          </h3>
                          <p className="text-xs text-gray-400">/{department.slug}</p>
                        </div>
                      </div>
                      <span className={`mt-1 h-3 w-3 rounded-full ${statusTone}`} />
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center">
                      <DepartmentStat label="In Progress" value={inProgress} tone="indigo" />
                      <DepartmentStat label="Done" value={done} tone="green" />
                      <DepartmentStat label="Backlog" value={department.taskCounts?.backlog || 0} tone="gray" />
                    </div>

                    <div className="mt-4">
                      <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                        <span>Completion</span>
                        <span>{Math.round(doneRatio)}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className="h-full rounded-full bg-indigo-600 transition-all"
                          style={{ width: `${doneRatio}%` }}
                        />
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* ─── Performance Review: Trends, Bottlenecks, Persona Coverage ─── */}
        {!perfLoading && performance && (
          <>
            <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
              <div className="mb-6 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">Task Throughput Trends</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Created vs. completed tasks over the last 14 days. Buckets:{' '}
                    <strong>7d</strong> {performance.trends.last_7d.completed}/{performance.trends.last_7d.created} ·{' '}
                    <strong>30d</strong> {performance.trends.last_30d.completed}/{performance.trends.last_30d.created} ·{' '}
                    <strong>90d</strong> {performance.trends.last_90d.completed}/{performance.trends.last_90d.created}.
                  </p>
                </div>
                <div className="hidden rounded-xl bg-indigo-50 p-2 sm:flex">
                  <TrendingUp className="h-5 w-5 text-indigo-600" />
                </div>
              </div>

              {performance.trend_series.length === 0 ? (
                <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50 text-sm text-gray-400">
                  Not enough history yet — trends will populate as tasks are completed.
                </div>
              ) : (
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={performance.trend_series}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                      <XAxis dataKey="day" stroke="#9ca3af" fontSize={11} />
                      <YAxis stroke="#9ca3af" fontSize={11} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{
                          background: 'white',
                          border: '1px solid #e5e7eb',
                          borderRadius: '0.75rem',
                          fontSize: 12,
                        }}
                      />
                      <Line type="monotone" dataKey="created" stroke="#6366f1" strokeWidth={2} dot={false} name="Created" />
                      <Line type="monotone" dataKey="completed" stroke="#10b981" strokeWidth={2} dot={false} name="Completed" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <PerfTile
                  label="Avg completion time"
                  value={
                    performance.avg_completion.n === 0
                      ? '—'
                      : `${performance.avg_completion.hours.toFixed(1)}h`
                  }
                  hint={`Across ${performance.avg_completion.n} completed tasks`}
                />
                <PerfTile
                  label="Agent utilization"
                  value={`${Math.round(performance.agent_utilization.ratio * 100)}%`}
                  hint={`${performance.agent_utilization.active} of ${performance.agent_utilization.total} agents active`}
                />
                <PerfTile
                  label="Persona coverage"
                  value={`${Math.round(performance.persona_coverage.ratio * 100)}%`}
                  hint={`${performance.persona_coverage.covered} of ${performance.persona_coverage.total} tasks tagged`}
                  icon={<Sparkles className="h-4 w-4 text-violet-500" />}
                />
              </div>
            </section>

            {/* Bottlenecks card — top 3 stalled-task clusters */}
            <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
              <div className="mb-6 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">Bottlenecks</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Departments where more than 40% of tasks are blocked or stalled.
                  </p>
                </div>
                <div className="hidden rounded-xl bg-rose-50 p-2 sm:flex">
                  <AlertTriangle className="h-5 w-5 text-rose-600" />
                </div>
              </div>

              {performance.bottlenecks.length === 0 ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-5 text-sm font-medium text-emerald-800">
                  No bottlenecks detected. Every department is moving.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {performance.bottlenecks.map((b) => (
                    <Link
                      key={b.workspace_id}
                      href={`/workspace/${b.slug}`}
                      className="rounded-2xl border border-rose-200 bg-rose-50 p-4 transition-all hover:border-rose-300 hover:shadow-md"
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <h3 className="text-sm font-bold text-rose-900">{b.workspace_name}</h3>
                        <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-rose-700">
                          {Math.round(b.stalled_ratio * 100)}%
                        </span>
                      </div>
                      <p className="text-xs text-rose-800">{b.reason}</p>
                      <p className="mt-2 text-[11px] text-rose-700">
                        {b.blocked} blocked · {b.total} total
                      </p>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-gray-900">Quick Recommendations</h2>
            <p className="mt-1 text-sm text-gray-500">
              Immediate next steps based on current department coverage.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            {recommendations.map((recommendation) => (
              <div
                key={recommendation}
                className="rounded-2xl border border-amber-200 bg-amber-50 p-4 transition-all hover:border-amber-300 hover:shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-xl bg-white p-2 text-amber-500 shadow-sm">
                    <Lightbulb className="h-5 w-5" />
                  </div>
                  <p className="text-sm font-medium leading-6 text-amber-900">{recommendation}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function PerfTile({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
        {icon}
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-gray-500">{hint}</p>}
    </div>
  );
}

function MetricTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-4">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-white shadow-sm">
        {icon}
      </div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-gray-900">{value}</p>
    </div>
  );
}

function DepartmentStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'indigo' | 'green' | 'gray';
}) {
  const toneClasses = {
    indigo: 'text-indigo-600 bg-indigo-50',
    green: 'text-emerald-600 bg-emerald-50',
    gray: 'text-gray-600 bg-gray-100',
  };

  return (
    <div className={`rounded-xl px-2 py-3 ${toneClasses[tone]}`}>
      <p className="text-lg font-bold leading-none">{value}</p>
      <p className="mt-1 text-[11px] font-medium leading-tight">{label}</p>
    </div>
  );
}
