'use client';

/**
 * PerformanceGaugeChart — PRD 2.10 rebuild
 *
 * Left panel: HorizontalBars (completion/in-progress/pending) — real counts,
 *   unchanged.
 *
 * Right panel: replaced the fabricated PairedBarChart (which repeated done/total
 *   for every past day — invented history) with a real per-department grade
 *   sparkline row driven by /api/company-health.
 *
 * No fabricated time series. Departments with insufficient data show a grey
 * "no data" row, not a fake bar or a zero.
 */

import { useEffect, useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Sparkline } from '@/components/ceo-board/Sparkline';
import { gradeToColor, scoreToGrade } from '@/lib/grading';
import type { WorkspaceStats } from '@/lib/types';

// ---------------------------------------------------------------------------
// HorizontalBars (unchanged from original — reads real counts)
// ---------------------------------------------------------------------------

function HorizontalBars({
  completed,
  inProgress,
  pending,
  loading,
}: {
  completed: number;
  inProgress: number;
  pending: number;
  loading: boolean;
}) {
  const total = completed + inProgress + pending;
  const hasData = total > 0;
  const completionRate = hasData ? Math.round((completed / total) * 100) : 0;
  const inProgressRate = hasData ? Math.round((inProgress / total) * 100) : 0;
  const pendingRate = hasData ? Math.round((pending / total) * 100) : 0;

  const [animPct, setAnimPct] = useState(0);

  useEffect(() => {
    if (loading || !hasData) return;
    const start = performance.now();
    const duration = 1000;
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

    function animate(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      setAnimPct(easeOut(progress));
      if (progress < 1) requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  }, [hasData, loading]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center w-full">
        <div className="w-24 h-14 bg-gray-200 rounded-lg animate-pulse mb-4" />
        <div className="w-full space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 bg-gray-200 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="flex flex-col items-center justify-center w-full gap-4 py-4">
        <p
          style={{ fontSize: '56px', fontWeight: 900, fontFamily: 'ui-monospace, monospace' }}
          className="text-gray-300"
        >
          0%
        </p>
        <p className="text-sm text-gray-500">No data yet</p>
        <div className="w-full space-y-3 mt-2">
          {[
            { label: 'Completed', count: 0, color: '#2D5A27' },
            { label: 'In Progress', count: 0, color: '#D97706' },
            { label: 'Pending', count: 0, color: '#9CA3AF' },
          ].map((row) => (
            <div key={row.label} className="flex items-center gap-3 w-full">
              <span className="text-sm text-gray-600 w-24 shrink-0">{row.label}</span>
              <div className="flex-1 h-6 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ width: '0%', backgroundColor: row.color }} />
              </div>
              <span className="text-sm text-gray-500 w-12 text-right tabular-nums">0</span>
              <span className="text-sm text-gray-500 w-10 text-right tabular-nums">0%</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const bars = [
    { label: 'Completed', count: completed, pct: completionRate, color: '#2D5A27' },
    { label: 'In Progress', count: inProgress, pct: inProgressRate, color: '#D97706' },
    { label: 'Pending', count: pending, pct: pendingRate, color: '#9CA3AF' },
  ];

  return (
    <div className="flex flex-col items-center justify-center w-full gap-3 py-2">
      <p
        style={{ fontSize: '56px', fontWeight: 900, fontFamily: 'ui-monospace, monospace' }}
        className="text-[#2D5A27]"
      >
        {Math.round(completionRate * animPct)}%
      </p>
      <p className="text-sm text-gray-500 -mt-2 mb-2">Completion Rate</p>

      <div className="w-full space-y-3">
        {bars.map((row) => {
          const barWidth = hasData ? Math.max(row.pct * animPct, row.count > 0 ? 4 : 0) : 0;
          return (
            <div key={row.label} className="flex items-center gap-3 w-full">
              <span className="text-sm text-gray-600 w-24 shrink-0 font-medium">{row.label}</span>
              <div className="flex-1 h-7 bg-gray-100 rounded-full overflow-hidden">
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: row.color, width: `${barWidth}%` }}
                  initial={{ width: 0 }}
                  transition={{ duration: 0.8, ease: 'easeOut' }}
                />
              </div>
              <span className="text-sm text-gray-600 w-12 text-right tabular-nums font-medium">
                {row.count}
              </span>
              <span className="text-sm text-gray-400 w-10 text-right tabular-nums">
                {row.pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Department Grade Sparklines (replaces fabricated PairedBarChart)
// PRD 2.10: real per-dept scores from /api/company-health.
// Insufficient data → grey "no data" row, never a fake bar.
// ---------------------------------------------------------------------------

interface ClientInputScore {
  key: string;
  score: number | null;
  sampleSize: number;
  detail: string;
}

interface ClientDept {
  workspaceId: string;
  slug: string;
  name: string;
  inputs: Record<string, ClientInputScore>;
  score: number | null;
  grade: string | null;
  sufficientData: boolean;
}

interface ClientCompanyHealth {
  score: number | null;
  grade: string | null;
  departments: ClientDept[];
  worstTrending: unknown[];
  generatedAt: string;
}

function DeptGradeRow({ dept }: { dept: ClientDept }) {
  const color = dept.grade ? gradeToColor(dept.grade as Parameters<typeof gradeToColor>[0]) : '#D1D5DB';

  // Build mini sparkline data from the four inputs (null → excluded from sparkline)
  const inputScores = ['throughput', 'qcPassRate', 'sopCoverage', 'kpiAttainment']
    .map((k) => dept.inputs[k]?.score)
    .filter((s): s is number => s !== null && s !== undefined);

  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
      {/* Dept name */}
      <span className="text-sm text-gray-700 w-28 shrink-0 truncate font-medium">
        {dept.name}
      </span>

      {/* Sparkline — real input scores; gaps when inputs are null */}
      <div className="flex-1">
        {inputScores.length >= 2 ? (
          <Sparkline
            data={inputScores}
            width={100}
            height={28}
            color={color}
            strokeWidth={1.5}
          />
        ) : (
          // Fewer than 2 data points — show explicit no-data treatment
          <span className="text-xs text-gray-300 italic">no data</span>
        )}
      </div>

      {/* Grade pill */}
      {dept.grade && dept.sufficientData ? (
        <span
          className="text-xs font-bold px-2 py-0.5 rounded-full shrink-0"
          style={{ backgroundColor: `${color}20`, color }}
        >
          {dept.grade}
        </span>
      ) : (
        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-300 shrink-0">
          —
        </span>
      )}

      {/* Score number */}
      {dept.score !== null ? (
        <span className="text-xs tabular-nums text-gray-500 w-10 text-right shrink-0">
          {Math.round(dept.score)}
        </span>
      ) : (
        <span className="text-xs tabular-nums text-gray-200 w-10 text-right shrink-0">
          n/a
        </span>
      )}
    </div>
  );
}

function DeptGradeSparklines({ loading }: { loading: boolean }) {
  const [health, setHealth] = useState<ClientCompanyHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/company-health');
        if (res.ok) setHealth(await res.json());
      } catch {
        // best-effort
      } finally {
        setHealthLoading(false);
      }
    }
    load();
  }, []);

  if (loading || healthLoading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-8 bg-gray-100 rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (!health || health.departments.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <p className="text-sm text-gray-400">No department data yet</p>
      </div>
    );
  }

  // Sort by score desc (nulls last)
  const sorted = [...health.departments].sort((a, b) => {
    if (a.score !== null && b.score !== null) return b.score - a.score;
    if (a.score !== null) return -1;
    if (b.score !== null) return 1;
    return 0;
  });

  return (
    <div className="flex flex-col px-2 py-2 overflow-y-auto max-h-[280px]">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 px-1">
        Department Scores
      </p>
      {sorted.map((dept) => (
        <DeptGradeRow key={dept.workspaceId} dept={dept} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

export function PerformanceGaugeChart() {
  const [departments, setDepartments] = useState<WorkspaceStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await fetch('/api/workspaces?stats=true');
        if (res.ok) {
          setDepartments(await res.json());
        }
      } catch {
        // handled
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const { completed, inProgress, pending } = useMemo(() => {
    const filtered = departments.filter((d) => {
      const slug = d.slug || d.id;
      return slug !== 'default' && !slug.startsWith('acme-') && !slug.startsWith('zhw-');
    });
    const done = filtered.reduce((s, d) => s + (d.taskCounts?.done || 0), 0);
    const ip = filtered.reduce((s, d) => s + (d.taskCounts?.in_progress || 0), 0);
    const blocked = filtered.reduce((s, d) => s + (d.taskCounts?.blocked || 0), 0);
    const review = filtered.reduce((s, d) => s + (d.taskCounts?.review || 0), 0);
    const backlog = filtered.reduce((s, d) => s + (d.taskCounts?.backlog || 0), 0);
    if (done === 0 && ip === 0 && blocked === 0 && review === 0 && backlog === 0) {
      return { completed: 0, inProgress: 0, pending: 0 };
    }
    return { completed: done, inProgress: ip, pending: blocked + review + backlog };
  }, [departments]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-2 h-[320px] rounded-2xl bg-gray-200 animate-pulse" />
        <div className="lg:col-span-3 h-[320px] rounded-2xl bg-gray-200 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      {/* Left: Horizontal Bars (40%) */}
      <motion.div
        className="lg:col-span-2 rounded-2xl shadow-sm border-0 p-6 flex items-center justify-center"
        style={{
          backgroundColor: 'rgba(255,255,255,0.88)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <HorizontalBars
          completed={completed}
          inProgress={inProgress}
          pending={pending}
          loading={loading}
        />
      </motion.div>

      {/* Right: Department Grade Sparklines (60%) — real data, no fabrication */}
      <motion.div
        className="lg:col-span-3 rounded-2xl shadow-sm border-0 p-4"
        style={{
          backgroundColor: 'rgba(255,255,255,0.88)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.1 }}
      >
        <DeptGradeSparklines loading={loading} />
      </motion.div>
    </div>
  );
}
