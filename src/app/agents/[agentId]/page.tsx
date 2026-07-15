'use client';

/**
 * /agents/[agentId] — Individual-agent performance detail (U58, Skill 6
 * Blended-Persona Kanban v2 Stage 2 / exec-summary item 9).
 *
 * Fetches GET /api/agents/[agentId]/performance (@/lib/agents/performance's
 * on-read tasks x task_qc_results JOIN) and renders the completed count,
 * average QC score, pass rate, throughput, and the weekly trend series.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Loader2, CheckCircle2, Gauge, TrendingUp, Target } from 'lucide-react';
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

interface WeeklyTrendPoint {
  weekStart: string;
  completedCount: number;
  avgQcScore: number | null;
}

interface AgentPerformance {
  agentId: string;
  agentName: string;
  agentRole: string;
  completedCount: number;
  avgQcScore: number | null;
  qcSampleSize: number;
  passRate: number | null;
  throughputPerWeek: number;
  trend: WeeklyTrendPoint[];
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center gap-2 text-gray-400">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
    </div>
  );
}

export default function AgentPerformanceDetailPage() {
  const params = useParams();
  const agentId = params.agentId as string;

  const [data, setData] = useState<AgentPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setNotFound(false);
        setError(null);
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/performance`);
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as AgentPerformance;
        setData(json);
      } catch (err) {
        if (cancelled) return;
        console.error(err);
        setError('Failed to load agent performance.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

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
              <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
                <p className="mb-2 text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
                  Agent Performance
                </p>
                <h1 className="text-3xl font-bold text-gray-900 sm:text-4xl">{data.agentName}</h1>
                <p className="mt-2 text-base text-gray-500">{data.agentRole}</p>
              </section>

              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <StatCard icon={CheckCircle2} label="Completed" value={String(data.completedCount)} />
                <StatCard
                  icon={Gauge}
                  label="Avg QC score"
                  value={data.avgQcScore === null ? '—' : data.avgQcScore.toFixed(1)}
                />
                <StatCard
                  icon={Target}
                  label="Pass rate"
                  value={data.passRate === null ? '—' : `${data.passRate.toFixed(0)}%`}
                />
                <StatCard
                  icon={TrendingUp}
                  label="Throughput / wk"
                  value={data.throughputPerWeek.toFixed(1)}
                />
              </div>

              <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
                <h2 className="mb-4 text-lg font-bold text-gray-900">Weekly trend</h2>
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
