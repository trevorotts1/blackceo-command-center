'use client';

import { useEffect, useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { scoreToGrade, gradeToLabel, type Grade } from '@/lib/grading';
import type { WorkspaceStats, Agent } from '@/lib/types';

function calculateCompanyScore(departments: WorkspaceStats[]): number {
  const totalDone = departments.reduce((sum, d) => sum + (d.taskCounts?.done || 0), 0);
  const totalTasks = departments.reduce((sum, d) => sum + (d.taskCounts?.total || 0), 0);
  if (totalTasks === 0) return 72;
  const doneRate = totalDone / totalTasks;
  if (doneRate < 0.25) return 72;
  let totalScore = 0;
  let count = 0;
  for (const dept of departments) {
    const total = dept.taskCounts?.total || 0;
    const done = dept.taskCounts?.done || 0;
    const inProgress = dept.taskCounts?.in_progress || 0;
    if (total === 0) {
      totalScore += 72;
      count++;
      continue;
    }
    const dr = done / total;
    if (dr < 0.1) {
      totalScore += 72;
      count++;
      continue;
    }
    totalScore += Math.round(((done + inProgress * 0.5) / total) * 100);
    count++;
  }
  return count > 0 ? Math.round(totalScore / count) : 72;
}

export function CompanyHeroCard() {
  const [departments, setDepartments] = useState<WorkspaceStats[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [wsRes, agentsRes] = await Promise.all([
          fetch('/api/workspaces?stats=true'),
          fetch('/api/agents'),
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

  const { grade, label, totalTasks, activeAgents, completionRate } = useMemo(() => {
    const score = calculateCompanyScore(departments);
    const g = scoreToGrade(score);
    const total = departments.reduce((s, d) => s + (d.taskCounts?.total || 0), 0);
    const done = departments.reduce((s, d) => s + (d.taskCounts?.done || 0), 0);
    const active = agents.filter(
      (a) => a.status === 'active' || a.status === 'working'
    ).length;
    return {
      grade: g,
      label: gradeToLabel(g),
      totalTasks: total,
      activeAgents: active,
      completionRate: total > 0 ? Math.round((done / total) * 100) : 0,
    };
  }, [departments, agents]);

  const statusLine = useMemo(() => {
    const needsAttention = departments.filter((d) => {
      const total = d.taskCounts?.total || 0;
      const done = d.taskCounts?.done || 0;
      const blocked = d.taskCounts?.blocked || 0;
      if (total === 0) return false;
      const score = Math.round(
        ((done + (d.taskCounts?.in_progress || 0) * 0.5) / total) * 100
      );
      const g = scoreToGrade(score);
      return g === 'D' || g === 'F' || blocked > 0;
    }).length;

    if (needsAttention > 0) {
      return `Your company is performing ${label.toLowerCase()}. ${needsAttention} item${needsAttention > 1 ? 's' : ''} need${needsAttention === 1 ? 's' : ''} attention.`;
    }
    return 'Your company is performing well. All departments are on track.';
  }, [departments, label]);

  if (loading) {
    return (
      <div className="w-full rounded-2xl bg-gradient-to-br from-[#1B5E20] to-[#2E7D32] p-8 animate-pulse">
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
      className="w-full rounded-[20px] bg-gradient-to-br from-[#1B5E20] to-[#2E7D32] px-12 py-10 shadow-lg backdrop-blur-sm"
      style={{ backgroundColor: 'rgba(27, 94, 32, 0.92)' }}
      initial={{ scale: 0.96, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className="flex flex-col items-center gap-2">
        {/* Letter Grade */}
        <span
          className="font-mono text-[96px] font-black text-white leading-none"
        >
          {grade}
        </span>

        {/* Grade Label */}
        <span className="text-[#81C784] text-xl font-medium">{label}</span>

        {/* Status Line */}
        <p className="text-white/80 text-base text-center max-w-lg mt-1">
          {statusLine}
        </p>

        {/* Bottom Stat Pills */}
        <div className="flex gap-3 mt-6">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/20">
            <span className="text-white text-sm font-medium">{totalTasks}</span>
            <span className="text-white/70 text-xs">Total Tasks</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/20">
            <span className="text-white text-sm font-medium">{activeAgents}</span>
            <span className="text-white/70 text-xs">Active Agents</span>
          </div>
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/20">
            <span className="text-white text-sm font-medium">{completionRate}%</span>
            <span className="text-white/70 text-xs">Completion Rate</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
