'use client';

import { useEffect, useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import type { WorkspaceStats } from '@/lib/types';

/* Horizontal Progress Bars replacing SemiGauge */
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
        <p className="text-sm text-gray-400">No data yet</p>
        <div className="w-full space-y-3 mt-2">
          {[
            { label: 'Completed', count: 0, color: '#2D5A27' },
            { label: 'In Progress', count: 0, color: '#D97706' },
            { label: 'Pending', count: 0, color: '#9CA3AF' },
          ].map((row) => (
            <div key={row.label} className="flex items-center gap-3 w-full">
              <span className="text-sm text-gray-500 w-24 shrink-0">{row.label}</span>
              <div className="flex-1 h-6 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{ width: '0%', backgroundColor: row.color }}
                />
              </div>
              <span className="text-sm text-gray-400 w-12 text-right tabular-nums">0</span>
              <span className="text-sm text-gray-400 w-10 text-right tabular-nums">0%</span>
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
      {/* Large KPI percentage */}
      <p
        style={{ fontSize: '56px', fontWeight: 900, fontFamily: 'ui-monospace, monospace' }}
        className="text-[#2D5A27]"
      >
        {Math.round(completionRate * animPct)}%
      </p>
      <p className="text-sm text-gray-500 -mt-2 mb-2">Completion Rate</p>

      {/* Stacked horizontal bars */}
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

/* Paired Vertical Bar Chart (7 days, 2 bars each) */
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function PairedBarChart({
  departments,
}: {
  departments: WorkspaceStats[];
}) {
  const [hoveredDay, setHoveredDay] = useState<number | null>(null);
  const [animated, setAnimated] = useState(false);

  const dayData = useMemo(() => {
    const total = departments.reduce(
      (s, d) => s + (d.taskCounts?.total || 0),
      0
    );
    const done = departments.reduce(
      (s, d) => s + (d.taskCounts?.done || 0),
      0
    );

    const today = new Date().getDay();

    return DAY_LABELS.map((_, i) => {
      const isPastOrToday = i <= today;
      if (!isPastOrToday) {
        return { left: 0, right: 0, isPending: true };
      }
      if (total === 0) {
        return { left: 0, right: 0, isPending: false };
      }
      const base = Math.round((done / total) * 100);
      return { left: base, right: base, isPending: false };
    });
  }, [departments]);

  const maxHeight = 180;
  const barWidth = 26;
  const pairGap = 4;

  useEffect(() => {
    const timer = setTimeout(() => setAnimated(true), 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex items-end justify-around h-full px-2 pb-8 pt-8 relative">
      {dayData.map((day, i) => {
        const leftH = animated ? (day.left / 100) * maxHeight : 0;
        const rightH = animated ? (day.right / 100) * maxHeight : 0;
        const isHovered = hoveredDay === i;
        const tallest = Math.max(leftH, rightH);

        return (
          <div
            key={i}
            className="flex flex-col items-center gap-2 relative"
            onMouseEnter={() => setHoveredDay(i)}
            onMouseLeave={() => setHoveredDay(null)}
          >
            {/* Tooltip */}
            {isHovered && (
              <div
                className="absolute z-10 left-1/2 -translate-x-1/2"
                style={{ top: `-${tallest + 44}px` }}
              >
                <div className="bg-white rounded-lg shadow-md px-2.5 py-1 text-xs font-medium text-gray-900 relative">
                  {day.right}%
                  <div
                    className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white rotate-45"
                    style={{ boxShadow: '2px 2px 4px rgba(0,0,0,0.1)' }}
                  />
                </div>
              </div>
            )}

            {/* Paired bars container */}
            <div className="flex items-end" style={{ gap: `${pairGap}px` }}>
              {/* Left bar - hatched */}
              <div
                style={{
                  width: barWidth,
                  height: `${leftH}px`,
                  borderTopLeftRadius: 8,
                  borderTopRightRadius: 8,
                  transition: `height 0.6s cubic-bezier(0.4, 0, 0.2, 1) ${i * 0.05}s`,
                  background: day.isPending
                    ? 'repeating-linear-gradient(45deg, #D1D5DB 0px, #D1D5DB 1.5px, transparent 1.5px, transparent 8px)'
                    : 'repeating-linear-gradient(45deg, #2D5A27 0px, #2D5A27 2.5px, transparent 2.5px, transparent 5px)',
                }}
              />

              {/* Right bar - solid */}
              <div
                style={{
                  width: barWidth,
                  height: `${rightH}px`,
                  borderTopLeftRadius: 8,
                  borderTopRightRadius: 8,
                  backgroundColor: day.isPending ? '#D1D5DB' : '#3D7A3A',
                  transition: `height 0.6s cubic-bezier(0.4, 0, 0.2, 1) ${i * 0.05}s`,
                }}
              />
            </div>

            {/* Hover dot */}
            {isHovered && (
              <div
                className="absolute w-3 h-3 rounded-full bg-white border-2 border-emerald-500"
                style={{
                  top: `-${tallest + 8}px`,
                  left: '50%',
                  transform: 'translateX(-50%)',
                }}
              />
            )}

            {/* Day label */}
            <span className="text-xs text-gray-400 mt-1">{DAY_LABELS[i]}</span>
          </div>
        );
      })}
    </div>
  );
}

/* Main Export */
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
      return (
        slug !== 'default' && !slug.startsWith('acme-') && !slug.startsWith('zhw-')
      );
    });
    const done = filtered.reduce((s, d) => s + (d.taskCounts?.done || 0), 0);
    const ip = filtered.reduce(
      (s, d) => s + (d.taskCounts?.in_progress || 0),
      0
    );
    const blocked = filtered.reduce(
      (s, d) => s + (d.taskCounts?.blocked || 0),
      0
    );
    const review = filtered.reduce(
      (s, d) => s + (d.taskCounts?.review || 0),
      0
    );
    const backlog = filtered.reduce(
      (s, d) => s + (d.taskCounts?.backlog || 0),
      0
    );
    if (done === 0 && ip === 0 && blocked === 0 && review === 0 && backlog === 0) {
      return { completed: 0, inProgress: 0, pending: 0 };
    }
    return {
      completed: done,
      inProgress: ip,
      pending: blocked + review + backlog,
    };
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

      {/* Right: Paired Vertical Bar Chart (60%) */}
      <motion.div
        className="lg:col-span-3 rounded-2xl shadow-sm border-0 p-6"
        style={{
          backgroundColor: 'rgba(255,255,255,0.88)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.1 }}
      >
        <PairedBarChart departments={departments} />
      </motion.div>
    </div>
  );
}
