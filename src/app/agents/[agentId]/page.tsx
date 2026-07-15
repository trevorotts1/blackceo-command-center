'use client';

/**
 * /agents/[agentId] — Individual-agent performance detail (U58, Skill 6
 * Blended-Persona Kanban v2 Stage 2 / exec-summary item 9).
 *
 * Fetches GET /api/agents/[id]/performance?window= (@/lib/agents/performance's
 * getAgentGrade — windowed, gated, DepartmentGrade-shaped) and renders the
 * grade + window, the throughput and QC-pass-rate inputs (each honestly
 * "Insufficient data" + reason below its sample gate — never a number),
 * windowed completion, blocked-task count with the blocking tasks listed,
 * velocity, and the all-time weekly trend series.
 *
 * (The API route's segment is named [id] to match its pre-existing
 * src/app/api/agents/[id]/ siblings; this page's own segment stays
 * [agentId] — separate route tree, unaffected. The fetch URL below is
 * just a string and needs no change.)
 */

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Loader2, Gauge, TrendingUp, AlertTriangle, ShieldCheck } from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { Header } from '@/components/Header';
import { gradeToColor, gradeToLabel } from '@/lib/grading';

// Re-declared locally so the client bundle doesn't pull in better-sqlite3 —
// same convention as DepartmentGradeCards.tsx's ClientDepartmentGrade.
type GradeInputKey = 'throughput' | 'qcPassRate' | 'sopCoverage' | 'kpiAttainment';

interface ClientInputScore {
  key: GradeInputKey;
  score: number | null;
  sampleSize: number;
  detail: string;
}

interface WeeklyTrendPoint {
  weekStart: string;
  completedCount: number;
  avgQcScore: number | null;
}

interface BlockedTaskSummary {
  id: string;
  title: string;
  reason: string;
  updatedAt: string;
}

interface AgentGrade {
  agentId: string;
  agentName: string;
  agentRole: string;
  windowDays: number;
  inputs: Record<GradeInputKey, ClientInputScore>;
  score: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  sufficientData: boolean;
  windowedCompletionRate: number | null;
  blockedCount: number;
  blockedTasks: BlockedTaskSummary[];
  velocity: number | null;
  completedCount: number;
  trend: WeeklyTrendPoint[];
}

const WINDOW_OPTIONS = [7, 30, 90] as const;

const INPUT_LABELS: Record<GradeInputKey, string> = {
  throughput: 'Throughput',
  qcPassRate: 'QC Pass Rate',
  sopCoverage: 'SOP Coverage',
  kpiAttainment: 'KPI Attainment',
};

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

function InputStatCard({ input }: { input: ClientInputScore }) {
  const label = INPUT_LABELS[input.key];
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4" title={input.detail}>
      <div className="mb-2 flex items-center gap-2 text-gray-400">
        <Gauge className="h-4 w-4" />
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
      </div>
      {input.score === null ? (
        <>
          <div className="text-lg font-bold text-gray-400">Insufficient data</div>
          <p className="mt-1 text-xs text-gray-400">{input.detail}</p>
        </>
      ) : (
        <>
          <div className="text-2xl font-bold text-gray-900">{input.score}%</div>
          <p className="mt-1 text-xs text-gray-500">{input.detail}</p>
        </>
      )}
    </div>
  );
}

function PlainStatCard({
  icon: Icon,
  label,
  value,
  mutedNote,
}: {
  icon: typeof Gauge;
  label: string;
  value: string;
  mutedNote?: string;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2 text-gray-400">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
      </div>
      {mutedNote ? (
        <div className="text-lg font-bold text-gray-400">Insufficient data</div>
      ) : (
        <div className="text-2xl font-bold text-gray-900">{value}</div>
      )}
      {mutedNote && <p className="mt-1 text-xs text-gray-400">{mutedNote}</p>}
    </div>
  );
}

export default function AgentPerformanceDetailPage() {
  const params = useParams();
  const agentId = params.agentId as string;

  const [windowDays, setWindowDays] = useState<number>(30);
  const [data, setData] = useState<AgentGrade | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        setLoading(true);
        setNotFound(false);
        setError(null);
        const res = await fetch(
          `/api/agents/${encodeURIComponent(agentId)}/performance?window=${windowDays}`,
          { signal },
        );
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as AgentGrade;
        setData(json);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        console.error(err);
        setError('Failed to load agent performance.');
      } finally {
        setLoading(false);
      }
    },
    [agentId, windowDays],
  );

  useEffect(() => {
    if (!agentId) return;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [agentId, windowDays, load]);

  const gradeColor = data?.grade ? gradeToColor(data.grade) : '#9CA3AF';
  const gradeLabel = data?.grade ? gradeToLabel(data.grade) : 'Insufficient data';

  return (
    <div className="flex h-screen flex-col bg-bcc-bg">
      <Header />
      <main className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
        <div className="mx-auto w-full max-w-5xl space-y-6">
          <Link
            href="/agents"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-900"
          >
            <ChevronLeft className="h-4 w-4" />
            All agents
          </Link>

          {loading && (
            <div className="flex min-h-[200px] items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50">
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
              <span className="ml-2 text-sm text-gray-500">Loading performance...</span>
            </div>
          )}

          {!loading && notFound && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-5 text-sm text-amber-900">
              No agent found with id &ldquo;{agentId}&rdquo;.
            </div>
          )}

          {!loading && error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-5 text-sm text-red-700">
              {error}
            </div>
          )}

          {!loading && !notFound && !error && data && (
            <>
              {/* Hero: name/role + grade badge + window selector */}
              <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
                      Agent Performance
                    </p>
                    <h1 className="text-3xl font-bold text-gray-900 sm:text-4xl">{data.agentName}</h1>
                    <p className="mt-2 text-base text-gray-500">{data.agentRole}</p>
                  </div>

                  <div className="flex flex-col items-start gap-2 sm:items-end">
                    <div className="flex items-center gap-3">
                      {data.grade ? (
                        <div
                          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full shadow-sm"
                          style={{
                            background: `linear-gradient(135deg, ${gradeColor}20, ${gradeColor}40)`,
                            border: `2px solid ${gradeColor}`,
                          }}
                        >
                          <span className="text-2xl font-bold" style={{ color: gradeColor }}>
                            {data.grade}
                          </span>
                        </div>
                      ) : (
                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-400">
                          <span className="text-sm font-medium">—</span>
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-semibold text-gray-900">
                          {data.sufficientData ? gradeLabel : 'Insufficient data'}
                        </p>
                        <p className="text-xs text-gray-400">
                          {data.windowDays}-day window
                          {data.score !== null ? ` · ${Math.round(data.score)}/100` : ''}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 rounded-full bg-gray-100 p-1">
                      {WINDOW_OPTIONS.map((w) => (
                        <button
                          key={w}
                          type="button"
                          onClick={() => setWindowDays(w)}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                            windowDays === w
                              ? 'bg-gray-900 text-white'
                              : 'text-gray-500 hover:text-gray-900'
                          }`}
                        >
                          {w}d
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {/* Gated PRD inputs: throughput + QC pass rate (the two the spec calls out by name) */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <InputStatCard input={data.inputs.throughput} />
                <InputStatCard input={data.inputs.qcPassRate} />
              </div>

              {/* Windowed completion + velocity + blocked count */}
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <PlainStatCard
                  icon={TrendingUp}
                  label="Windowed completion"
                  value={data.windowedCompletionRate === null ? '—' : `${data.windowedCompletionRate}%`}
                  mutedNote={
                    data.windowedCompletionRate === null
                      ? 'No tasks created in this window'
                      : undefined
                  }
                />
                <PlainStatCard
                  icon={Gauge}
                  label="Velocity"
                  value={data.velocity === null ? '—' : `${data.velocity}/wk`}
                  mutedNote={data.velocity === null ? 'No tasks yet' : undefined}
                />
                <div
                  className={`rounded-2xl border p-4 ${
                    data.blockedCount > 0 ? 'border-red-100 bg-red-50' : 'border-gray-200 bg-white'
                  }`}
                >
                  <div className="mb-2 flex items-center gap-2 text-gray-400">
                    {data.blockedCount > 0 ? (
                      <AlertTriangle className="h-4 w-4 text-red-500" />
                    ) : (
                      <ShieldCheck className="h-4 w-4" />
                    )}
                    <span className="text-xs font-semibold uppercase tracking-wide">Blocked</span>
                  </div>
                  <div
                    className={`text-2xl font-bold ${data.blockedCount > 0 ? 'text-red-600' : 'text-gray-900'}`}
                  >
                    {data.blockedCount}
                  </div>
                </div>
                <PlainStatCard
                  icon={TrendingUp}
                  label="Completed (all time)"
                  value={String(data.completedCount)}
                />
              </div>

              {/* Blockers list — length always equals blockedCount above */}
              {data.blockedCount > 0 && (
                <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
                  <h2 className="mb-4 text-lg font-bold text-gray-900">
                    Blockers <span className="font-medium text-gray-400">({data.blockedCount})</span>
                  </h2>
                  <ul className="divide-y divide-gray-50">
                    {data.blockedTasks.map((task) => (
                      <li key={task.id} className="flex items-start justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-gray-900">{task.title}</p>
                          <p className="mt-0.5 text-xs text-red-500">{task.reason}</p>
                        </div>
                        <span className="shrink-0 text-xs text-gray-400">
                          {formatUpdatedAt(task.updatedAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Weekly trend — all-time */}
              <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
                <h2 className="mb-4 text-lg font-bold text-gray-900">Weekly trend (all time)</h2>
                {data.trend.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    No completed tasks yet — the trend will populate once this agent finishes work.
                  </p>
                ) : (
                  <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.trend}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis dataKey="weekStart" tick={{ fontSize: 11 }} />
                        <YAxis yAxisId="count" tick={{ fontSize: 11 }} allowDecimals={false} />
                        <Tooltip />
                        <Line
                          yAxisId="count"
                          type="monotone"
                          dataKey="completedCount"
                          name="Completed"
                          stroke="#4f46e5"
                          strokeWidth={2}
                          dot={{ r: 3 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
