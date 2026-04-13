'use client';

import { useEffect, useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import type { WorkspaceStats, Agent } from '@/lib/types';

interface CompanyKpiConfig {
  id: string;
  name: string;
  target: number;
  unit: string;
  icon?: string;
}

interface KPICardData {
  label: string;
  value: number;
  trend: 'up' | 'down' | 'neutral';
  trendLabel: string;
  dark?: boolean;
  isZeroAgents?: boolean;
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [wsRes, agentsRes, configRes] = await Promise.all([
          fetch('/api/workspaces?stats=true'),
          fetch('/api/agents'),
          fetch('/api/company/config'),
        ]);
        if (wsRes.ok) {
          const data: WorkspaceStats[] = await wsRes.json();
          setDepartments(
            data.filter((d) => {
              const slug = d.slug || d.id;
              return (
                slug !== 'default' && !slug.startsWith('acme-') && !slug.startsWith('zhw-')
              );
            })
          );
        }
        if (agentsRes.ok) setAgents(await agentsRes.json());
        if (configRes.ok) {
          const config = await configRes.json();
          if (Array.isArray(config.companyKPIs) && config.companyKPIs.length > 0) {
            setCompanyKPIs(config.companyKPIs);
          }
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
    const activeCount = agents.filter(
      (a) => a.status === 'active' || a.status === 'working'
    ).length;
    const velocity = totalDone > 0 ? Math.max(1, Math.round(totalDone / 4)) : 0;

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
        trend: 'up' as const,
        trendLabel: 'Increased from last week',
        dark: true,
        sparkline: [], // No hardcoded sparkline — real KPI history needed
      },
      {
        label: 'Active Agents',
        value: activeCount,
        trend: activeCount > 0 ? ('up' as const) : ('neutral' as const),
        trendLabel: activeCount > 0 ? `${activeCount} working now` : 'No active agents',
        isZeroAgents: activeCount === 0,
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
        trend: 'up' as const,
        trendLabel: 'tasks per week',
        sparkline: [],
      },
    ];
  }, [departments, agents, companyKPIs]);

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

          {/* Trend row */}
          <div className="flex items-center gap-1.5 mt-2">
            {card.isZeroAgents ? (
              <>
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-gray-50">
                  <Minus className="h-2.5 w-2.5 text-gray-400" />
                </span>
                <span className="text-xs text-gray-600">No active agents</span>
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
