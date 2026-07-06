'use client';

/**
 * CompanyHeroCard — PRD 2.10 rebuild
 *
 * Drives grade + label from /api/company-health (the single grading source of
 * truth). score===null → explicit "Insufficient data" state, never 72 or 0.
 * Stat pills (total tasks, active agents, completion rate) read from real counts
 * via existing /api/workspaces and /api/agents endpoints.
 */

import { useEffect, useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { gradeToLabel, isRealDepartment } from '@/lib/grading';
import type { Grade } from '@/lib/grading';
import type { WorkspaceStats, Agent } from '@/lib/types';

// Client-side shape from /api/company-health
interface ClientCompanyHealth {
  score: number | null;
  grade: string | null;
  departments: unknown[];
  worstTrending: unknown[];
  generatedAt: string;
}

const GRADE_COLORS: Record<string, string> = {
  A: '#10B981',
  B: '#10B981',
  C: '#F59E0B',
  D: '#EF4444',
  F: '#EF4444',
};

function gradeColor(grade: string | null): string {
  if (!grade) return '#9CA3AF';
  return GRADE_COLORS[grade] ?? '#9CA3AF';
}

export function CompanyHeroCard() {
  const [health, setHealth] = useState<ClientCompanyHealth | null>(null);
  const [departments, setDepartments] = useState<WorkspaceStats[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [healthRes, wsRes, agentsRes] = await Promise.all([
          fetch('/api/company-health'),
          fetch('/api/workspaces?stats=true'),
          fetch('/api/agents'),
        ]);
        if (healthRes.ok) {
          setHealth(await healthRes.json());
        }
        if (wsRes.ok) {
          const data: WorkspaceStats[] = await wsRes.json();
          setDepartments(data.filter((d) => isRealDepartment(d.slug || d.id)));
        }
        if (agentsRes.ok) {
          setAgents(await agentsRes.json());
        }
      } catch {
        // handled by loading state
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const { totalTasks, activeAgents, completionRate } = useMemo(() => {
    const total = departments.reduce((s, d) => s + (d.taskCounts?.total || 0), 0);
    const done = departments.reduce((s, d) => s + (d.taskCounts?.done || 0), 0);
    // Agent status enum is standby/working/offline (DB CHECK constraint) —
    // 'active' never matches a real row, so counting it was dead code that
    // silently overstated nothing but misled readers of this filter. Count
    // 'working' only; the "Active Agents" label describes agents currently
    // working, not a distinct 'active' status.
    const active = agents.filter((a) => a.status === 'working').length;
    return {
      totalTasks: total,
      activeAgents: active,
      completionRate: total > 0 ? Math.round((done / total) * 100) : 0,
    };
  }, [departments, agents]);

  const grade = health?.grade ?? null;
  const color = gradeColor(grade);
  const label = grade ? gradeToLabel(grade as Grade) : null;
  const sufficientData = health !== null && health.score !== null;

  const statusLine = useMemo(() => {
    if (!sufficientData) {
      return 'Your AI workforce is getting started. Check back after agents complete their first tasks to see your performance grade.';
    }
    const needsAttention = departments.filter((d) => {
      const total = d.taskCounts?.total || 0;
      const done = d.taskCounts?.done || 0;
      const blocked = d.taskCounts?.blocked || 0;
      if (total === 0) return false;
      const rate = Math.round(((done + (d.taskCounts?.in_progress || 0) * 0.5) / total) * 100);
      return rate < 60 || blocked > 0;
    }).length;
    if (needsAttention > 0) {
      return `Your company is performing ${(label ?? '').toLowerCase()}. ${needsAttention} item${needsAttention > 1 ? 's' : ''} need${needsAttention === 1 ? 's' : ''} attention.`;
    }
    return 'Your company is performing well. All departments are on track.';
  }, [sufficientData, departments, label]);

  if (loading) {
    return (
      <div className="w-full rounded-2xl p-8 animate-pulse"
        style={{ background: 'linear-gradient(135deg, var(--brand-900), var(--brand-800))' }}>
        <div className="flex flex-col items-center gap-4">
          <div className="h-24 w-24 rounded-full bg-white/20" />
          <div className="h-5 w-40 rounded bg-white/20" />
          <div className="h-4 w-64 rounded bg-white/20" />
          <div className="flex gap-4 mt-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 w-28 rounded-full bg-white/20" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      className="w-full rounded-[20px] px-6 py-8 sm:px-12 sm:py-10 shadow-lg"
      style={{ background: 'linear-gradient(135deg, var(--brand-900), var(--brand-800))' }}
      initial={{ scale: 0.96, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className="flex flex-col items-center gap-2">
        {/* Grade display — real letter or insufficient-data state */}
        {sufficientData && grade ? (
          <>
            <span className="font-mono text-[96px] font-black text-white leading-none">
              {grade}
            </span>
            <span className="text-xl font-medium text-brand-300">
              {label}
            </span>
          </>
        ) : (
          <>
            {/* Explicit insufficient-data state — never shows 72 or a fake grade */}
            <div className="w-24 h-24 rounded-full border-4 border-white/30 flex items-center justify-center">
              <span className="font-mono text-4xl font-bold text-white/50">—</span>
            </div>
            <span className="text-white/60 text-lg font-medium mt-1">Insufficient data</span>
          </>
        )}

        {/* Status line */}
        <p className="text-white/80 text-base text-center max-w-lg mt-1">{statusLine}</p>

        {/* Bottom stat pills — always real counts, never fabricated */}
        <div className="flex flex-wrap justify-center gap-2 sm:gap-3 mt-6">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/20">
            <span className="text-white text-base font-semibold">{totalTasks}</span>
            <span className="text-white/70 text-sm">Total Tasks</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/20">
            <span className="text-white text-base font-semibold">{activeAgents}</span>
            <span className="text-white/70 text-sm">Active Agents</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/20">
            <span className="text-white text-base font-semibold">{completionRate}%</span>
            <span className="text-white/70 text-sm">Completion Rate</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
