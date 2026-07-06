'use client';

/**
 * KPIStatCards — PRD 2.10 honesty pass
 *
 * Was: hardcoded trend:'up' / trendLabel:'Increased from last week' on the
 * Tasks Completed card regardless of reality, plus an "Avg Velocity" derived
 * from totalDone/4 — a lifetime cumulative count divided by an arbitrary
 * constant, mislabeled as a weekly rate. Both violated the "never 72" /
 * never-fabricate doctrine (see CompanyHeroCard.tsx, DepartmentGradeCards.tsx).
 *
 * Now: Tasks Completed's trend is a REAL week-over-week comparison built from
 * /api/performance's daily trend_series (last 7 days vs the prior 7). Avg
 * Velocity is a REAL per-week rate averaged over the last 30 days (the same
 * rolling window the grading engine in src/lib/grading.ts uses) — clearly
 * labeled as such. When /api/performance doesn't have enough history to
 * support either metric, the card shows an honest muted note instead of a
 * trend — never a fabricated one.
 */

import { useEffect, useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { isRealDepartment } from '@/lib/grading';
import type { WorkspaceStats, Agent } from '@/lib/types';

interface CompanyKpiConfig {
  id: string;
  name: string;
  target: number;
  unit: string;
  icon?: string;
}

interface PerformanceTrendPoint {
  day: string;
  created: number;
  completed: number;
}

// Minimal client-side shape of /api/performance — only the fields this
// component needs for the real week-over-week trend and velocity.
interface PerformancePayload {
  trends: {
    last_30d: { created: number; completed: number };
  };
  trend_series: PerformanceTrendPoint[];
}

interface KPICardData {
  label: string;
  value: number;
  trend: 'up' | 'down' | 'neutral';
  trendLabel: string;
  dark?: boolean;
  /**
   * Honest "not enough data" note shown instead of a trend badge/label when
   * there isn't enough real history to support one. Never fill this gap with
   * a fabricated trend — this is the null-gating equivalent for KPI cards.
   */
  mutedNote?: string;
  sparkline: number[];
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: [0.4, 0, 0.2, 1] as [number, number, number, number],
    },
  },
};

function TrendBadge({
  trend,
  dark,
}: {
  trend: 'up' | 'down' | 'neutral';
  dark?: boolean;
}) {
  const Icon = trend === 'up' ? ArrowUp : trend === 'down' ? ArrowDown : Minus;
  const bg = dark
    ? 'bg-white/20'
    : trend === 'up'
      ? 'bg-green-50'
      : trend === 'down'
        ? 'bg-red-50'
        : 'bg-gray-50';

  return (
    <span
      className={`inline-flex items-center justify-center w-7 h-7 rounded-md ${bg}`}
    >
      <Icon
        className={`h-4 w-4 ${
          dark
            ? 'text-white/80'
            : trend === 'up'
              ? 'text-emerald-600'
              : trend === 'down'
                ? 'text-red-500'
                : 'text-gray-400'
        }`}
      />
    </span>
  );
}

export function KPIStatCards() {
  const [departments, setDepartments] = useState<WorkspaceStats[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [companyKPIs, setCompanyKPIs] = useState<CompanyKpiConfig[]>([]);
  const [performance, setPerformance] = useState<PerformancePayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [wsRes, agentsRes, configRes, perfRes] = await Promise.all([
          fetch('/api/workspaces?stats=true'),
          fetch('/api/agents'),
          fetch('/api/company/config'),
          fetch('/api/performance'),
        ]);
        if (wsRes.ok) {
          const data: WorkspaceStats[] = await wsRes.json();
          setDepartments(data.filter((d) => isRealDepartment(d.slug || d.id)));
        }
        if (agentsRes.ok) setAgents(await agentsRes.json());
        if (configRes.ok) {
          const config = await configRes.json();
          if (Array.isArray(config.companyKPIs) && config.companyKPIs.length > 0) {
            setCompanyKPIs(config.companyKPIs);
          }
        }
        if (perfRes.ok) {
          setPerformance(await perfRes.json());
        }
      } catch {
        // handled by loading
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const cards: KPICardData[] = useMemo(() => {
    const totalDone = departments.reduce((s, d) => s + (d.taskCounts?.done || 0), 0);
    const totalBlocked = departments.reduce(
      (s, d) => s + (d.taskCounts?.blocked || 0),
      0
    );
    // Agent status enum is standby/working/offline (DB CHECK constraint) —
    // 'active' never matches a real row. Count 'working' only.
    const activeCount = agents.filter((a) => a.status === 'working').length;

    // Real week-over-week completed-task trend from /api/performance's daily
    // trend_series (never a hardcoded "Increased from last week").
    let completedTrend: 'up' | 'down' | 'neutral' = 'neutral';
    let completedTrendLabel = '';
    let completedMutedNote: string | undefined;
    if (performance) {
      const now = Date.now();
      const day7Ago = now - 7 * 86_400_000;
      const day14Ago = now - 14 * 86_400_000;
      let current7 = 0;
      let prev7 = 0;
      for (const point of performance.trend_series) {
        const t = new Date(point.day).getTime();
        if (Number.isNaN(t)) continue;
        if (t > day7Ago) current7 += point.completed;
        else if (t > day14Ago) prev7 += point.completed;
      }
      if (current7 === 0 && prev7 === 0) {
        completedMutedNote = 'Not enough history yet';
      } else if (prev7 === 0) {
        completedTrend = 'up';
        completedTrendLabel = `${current7} completed this week (0 last week)`;
      } else {
        const pct = Math.round(((current7 - prev7) / prev7) * 100);
        completedTrend = current7 > prev7 ? 'up' : current7 < prev7 ? 'down' : 'neutral';
        completedTrendLabel = `${pct > 0 ? '+' : ''}${pct}% vs last week (${current7} vs ${prev7})`;
      }
    } else {
      completedMutedNote = 'Not enough history yet';
    }

    // Real avg velocity: completed tasks per week, averaged over the last 30
    // days (same rolling window the grading engine defaults to — see
    // GRADING_THRESHOLDS / computeCompanyHealth in src/lib/grading.ts).
    // Never lifetime-total-divided-by-4.
    let velocity = 0;
    let velocityMutedNote: string | undefined;
    if (performance) {
      velocity = Math.round((performance.trends.last_30d.completed / 30) * 7);
    } else {
      velocityMutedNote = 'Not enough history yet';
    }

    // Use configured KPIs if available, otherwise default task-based KPIs
    if (companyKPIs.length > 0) {
      return companyKPIs.map((kpi) => ({
        label: kpi.name,
        value: 0, // Value will be populated from KPI snapshot API when wired
        trend: 'neutral' as const,
        trendLabel: 'No data yet',
        sparkline: [],
      }));
    }

    // Default cards based on real workspace stats
    return [
      {
        label: 'Tasks Completed',
        value: totalDone,
        trend: completedTrend,
        trendLabel: completedTrendLabel,
        mutedNote: completedMutedNote,
        dark: true,
        sparkline: [], // No hardcoded sparkline — real KPI history needed
      },
      {
        label: 'Active Agents',
        value: activeCount,
        trend: activeCount > 0 ? ('up' as const) : ('neutral' as const),
        trendLabel: activeCount > 0 ? `${activeCount} working now` : '',
        mutedNote: activeCount === 0 ? 'No active agents' : undefined,
        sparkline: [],
      },
      {
        label: 'Blocked Tasks',
        value: totalBlocked,
        trend: totalBlocked > 0 ? ('down' as const) : ('up' as const),
        trendLabel:
          totalBlocked > 0
            ? `${totalBlocked} need attention`
            : 'No blocked tasks',
        sparkline: [],
      },
      {
        label: 'Avg Velocity',
        value: velocity,
        trend: 'neutral' as const,
        trendLabel: 'per week, 30d avg',
        mutedNote: velocityMutedNote,
        sparkline: [],
      },
    ];
  }, [departments, agents, companyKPIs, performance]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-[160px] rounded-2xl bg-gray-200 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <motion.div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {cards.map((card) => (
        <motion.div
          key={card.label}
          variants={cardVariants}
          className={`relative rounded-2xl p-6 min-h-[160px] flex flex-col justify-between ${
            card.dark
              ? 'bg-[#1B5E20] text-white'
              : 'border-0 shadow-sm'
          }`}
          style={card.dark ? undefined : {
            backgroundColor: 'rgba(255,255,255,0.88)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        >
          {/* Circle drill-down - decorative (drill-down coming soon) */}
          <div
            className={`absolute top-4 right-4 w-9 h-9 rounded-full border-2 flex items-center justify-center ${
              card.dark ? 'border-white/20' : 'border-gray-200'
            }`}
            title="Drill-down coming soon"
          >
            <ArrowUpRight
              className={`h-4 w-4 ${card.dark ? 'text-white/40' : 'text-gray-300'}`}
            />
          </div>

          {/* Label */}
          <span
            className={`text-sm font-medium ${
              card.dark ? 'text-white/70' : 'text-gray-500'
            }`}
          >
            {card.label}
          </span>

          {/* Number */}
          <span
            className={`text-kpi-value leading-none mt-1 ${
              card.dark ? 'text-white' : 'text-gray-900'
            }`}
            style={{ fontFamily: 'ui-monospace, monospace' }}
          >
            {card.value}
          </span>

          {/* Trend row — mutedNote wins when there isn't enough real data */}
          <div className="flex items-center gap-1.5 mt-2">
            {card.mutedNote ? (
              <>
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-gray-50">
                  <Minus className="h-2.5 w-2.5 text-gray-400" />
                </span>
                <span className="text-xs text-gray-600">{card.mutedNote}</span>
              </>
            ) : (
              <>
                <TrendBadge trend={card.trend} dark={card.dark} />
                <span
                  className={`text-xs ${
                    card.dark
                      ? 'text-white/80'
                      : card.trend === 'up'
                        ? 'text-emerald-600'
                        : card.trend === 'down'
                          ? 'text-red-500'
                          : 'text-gray-400'
                  }`}
                >
                  {card.trendLabel}
                </span>
              </>
            )}
          </div>

          {/* Mini sparkline — only show when real KPI history data is available */}
          {card.sparkline.length > 0 && (
            <div className="mt-2 w-full" style={{ height: 32 }}>
              <ResponsiveContainer width="100%" height={32}>
                <LineChart data={card.sparkline.map((v) => ({ v }))}>
                  <Line
                    type="monotone"
                    dataKey="v"
                    stroke={card.dark ? 'rgba(255,255,255,0.3)' : '#34d399'}
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </motion.div>
      ))}
    </motion.div>
  );
}
