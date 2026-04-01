'use client';

import { useEffect, useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import type { WorkspaceStats, Agent } from '@/lib/types';

function AnimatedBar({
  value,
  color,
  delay = 0,
}: {
  value: number;
  color: string;
  delay?: number;
}) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setWidth(Math.min(value, 100)), 100 + delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return (
    <div className="w-full bg-gray-100 h-1.5 rounded-full overflow-hidden">
      <motion.div
        className="h-full rounded-full"
        style={{ backgroundColor: color }}
        initial={{ width: '0%' }}
        animate={{ width: `${width}%` }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
      />
    </div>
  );
}

export function SystemPulseSection() {
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
                slug !== 'default' &&
                !slug.startsWith('acme-') &&
                !slug.startsWith('zhw-')
              );
            })
          );
        }
        if (agentsRes.ok) setAgents(await agentsRes.json());
      } catch {
        // handled
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const metrics = useMemo(() => {
    const activeAgents = agents.filter(
      (a) => a.status === 'active' || a.status === 'working'
    ).length;
    const totalAgents = agents.length;
    const totalTasks = departments.reduce(
      (s, d) => s + (d.taskCounts?.total || 0),
      0
    );
    const doneTasks = departments.reduce(
      (s, d) => s + (d.taskCounts?.done || 0),
      0
    );
    const blockedTasks = departments.reduce(
      (s, d) => s + (d.taskCounts?.blocked || 0),
      0
    );

    // Agent utilization: active / total
    const agentUtil =
      totalAgents > 0 ? Math.round((activeAgents / totalAgents) * 100) : 0;

    // Task throughput: done / total
    const taskThroughput =
      totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

    // System health: inverse of blocked ratio
    const blockedRatio =
      totalTasks > 0 ? Math.round((blockedTasks / totalTasks) * 100) : 0;
    const systemHealth = Math.max(0, 100 - blockedRatio * 5);

    return [
      {
        label: 'Agent Utilization',
        value: agentUtil,
        display: `${agentUtil}%`,
        color: '#D4A843',
      },
      {
        label: 'Task Throughput',
        value: taskThroughput,
        display: `${taskThroughput}%`,
        color: '#2D5A27',
      },
      {
        label: 'System Health',
        value: systemHealth,
        display: `${systemHealth}%`,
        color: systemHealth >= 80 ? '#2D5A27' : systemHealth >= 50 ? '#D4A843' : '#DC2626',
      },
    ];
  }, [departments, agents]);

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <div className="h-4 w-32 bg-gray-200 rounded animate-pulse" />
            <div className="h-1.5 w-full bg-gray-200 rounded-full animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-xs font-black text-gray-500 uppercase tracking-widest mb-5">
        System Pulse
      </h3>
      <div className="space-y-5">
        {metrics.map((metric, i) => (
          <div key={metric.label} className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-600">
                {metric.label}
              </span>
              <span className="text-sm font-bold text-gray-900 tabular-nums">
                {metric.display}
              </span>
            </div>
            <AnimatedBar
              value={metric.value}
              color={metric.color}
              delay={i * 150}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
