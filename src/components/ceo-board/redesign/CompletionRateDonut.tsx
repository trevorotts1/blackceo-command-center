'use client';

import { useEffect, useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import type { WorkspaceStats } from '@/lib/types';

export function CompletionRateDonut() {
  const [departments, setDepartments] = useState<WorkspaceStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await fetch('/api/workspaces?stats=true');
        if (res.ok) {
          const data: WorkspaceStats[] = await res.json();
          setDepartments(
            data.filter((d) => {
              const slug = d.slug || d.id;
              return (
                slug !== 'default' &&
                !slug.startsWith('acme-') &&
                !slug.startsWith('zhw-')
              );
            })
          );
        }
      } catch {
        // handled
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const { completionRate, label } = useMemo(() => {
    const total = departments.reduce(
      (s, d) => s + (d.taskCounts?.total || 0),
      0
    );
    const done = departments.reduce(
      (s, d) => s + (d.taskCounts?.done || 0),
      0
    );
    if (total === 0) return { completionRate: 0, label: 'No Data' };
    const rate = Math.round((done / total) * 100);
    return {
      completionRate: rate,
      label: rate >= 80 ? 'On Track' : rate >= 50 ? 'In Progress' : 'Needs Work',
    };
  }, [departments]);

  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (completionRate / 100) * circumference;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[200px]">
        <div className="w-32 h-32 rounded-full bg-gray-200 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center text-center py-2">
      <h3 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-4">
        Completion Rate
      </h3>
      <div className="relative w-40 h-40 flex items-center justify-center">
        <svg
          className="w-full h-full transform -rotate-90"
          viewBox="0 0 160 160"
        >
          {/* Background ring */}
          <circle
            cx="80"
            cy="80"
            r={radius}
            fill="transparent"
            stroke="#E5E7EB"
            strokeWidth="12"
          />
          {/* Progress ring */}
          <motion.circle
            cx="80"
            cy="80"
            r={radius}
            fill="transparent"
            stroke="#D4A843"
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 1.2, ease: 'easeOut', delay: 0.3 }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <motion.span
            className="text-4xl font-black font-mono text-gray-900"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.6 }}
          >
            {completionRate}%
          </motion.span>
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-tighter mt-0.5">
            Current Sprint
          </span>
        </div>
      </div>
      <span
        className={`text-sm font-semibold mt-2 ${
          completionRate >= 80
            ? 'text-emerald-600'
            : completionRate >= 50
              ? 'text-amber-600'
              : 'text-gray-500'
        }`}
      >
        {label}
      </span>
    </div>
  );
}
