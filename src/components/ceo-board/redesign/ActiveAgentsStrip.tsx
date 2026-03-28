'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { Agent, Task } from '@/lib/types';

// Unique avatar colors per agent
const AGENT_COLORS = [
  '#F48FB1', // pink
  '#A5D6A7', // green
  '#CE93D8', // purple
  '#80CBC4', // teal
  '#FFAB91', // orange
  '#90CAF9', // blue
  '#FFE082', // yellow
  '#B39DDB', // lavender
];

function getAgentColor(index: number): string {
  return AGENT_COLORS[index % AGENT_COLORS.length];
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

interface AgentWithTask extends Agent {
  currentTask?: string;
  taskStatus?: 'Completed' | 'In Progress' | 'Pending';
}

const statusConfig: Record<
  string,
  { bg: string; label: string }
> = {
  Completed: { bg: 'bg-[#F0A0A0]', label: 'Completed' },
  'In Progress': { bg: 'bg-[#A8D5A0]', label: 'In Progress' },
  Pending: { bg: 'bg-[#F5E6A0]', label: 'Pending' },
};

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, x: -10 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      duration: 0.3,
      ease: [0.4, 0, 0.2, 1] as [number, number, number, number],
    },
  },
};

export function ActiveAgentsStrip() {
  const [agents, setAgents] = useState<AgentWithTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [agentsRes, tasksRes] = await Promise.all([
          fetch('/api/agents'),
          fetch('/api/tasks'),
        ]);

        let agentsData: Agent[] = [];
        let tasksData: Task[] = [];

        if (agentsRes.ok) agentsData = await agentsRes.json();
        if (tasksRes.ok) tasksData = await tasksRes.json();

        // Map active agents to their current task
        const enriched: AgentWithTask[] = agentsData
          .filter((a) => a.status === 'active' || a.status === 'working')
          .map((agent) => {
            const task = tasksData.find(
              (t) =>
                t.assigned_agent_id === agent.id &&
                (t.status === 'in_progress' || t.status === 'assigned' || t.status === 'planning')
            );
            return {
              ...agent,
              currentTask: task?.title || 'Idle',
              taskStatus: task
                ? task.status === 'in_progress'
                  ? 'In Progress'
                  : 'Pending'
                : 'Pending',
            };
          });

        setAgents(enriched);
      } catch {
        // handled
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto p-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-50/60 flex-shrink-0" style={{ minWidth: '260px' }}>
            <div className="h-10 w-10 rounded-full bg-gray-200 animate-pulse" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-24 bg-gray-200 rounded animate-pulse" />
              <div className="h-3 w-32 bg-gray-100 rounded animate-pulse" />
            </div>
            <div className="h-6 w-16 bg-gray-200 rounded-full animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 px-6 bg-white rounded-2xl">
        <span className="text-sm text-gray-500">All agents are idle</span>
      </div>
    );
  }

  return (
    <motion.div
      className="rounded-2xl shadow-sm border-0 p-6"
      style={{
        backgroundColor: 'rgba(255,255,255,0.88)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollbarWidth: 'thin' }}>
        {agents.map((agent, index) => {
          const sc = statusConfig[agent.taskStatus || 'Pending'];
          return (
            <motion.div
              key={agent.id}
              variants={itemVariants}
              className="flex items-center gap-3 py-3 px-4 rounded-xl bg-gray-50/60 flex-shrink-0"
              style={{ minWidth: '260px' }}
            >
              {/* Avatar circle */}
              <div
                className="flex h-10 w-10 items-center justify-center rounded-full flex-shrink-0"
                style={{ backgroundColor: getAgentColor(index) }}
              >
                <span
                  className="text-white font-semibold"
                  style={{ fontSize: '14px' }}
                >
                  {getInitials(agent.name)}
                </span>
              </div>

              {/* Name + task line */}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-[#1A1A1A] truncate">
                  {agent.name}
                </div>
                <div className="text-[12px] truncate">
                  <span className="text-gray-500">Working on </span>
                  <span className="font-semibold text-[#1A1A1A]">
                    {agent.currentTask}
                  </span>
                </div>
              </div>

              {/* Status badge */}
              <span
                className={`text-[11px] font-medium px-2 py-1 rounded-full ${sc.bg} text-gray-800 flex-shrink-0`}
              >
                {sc.label}
              </span>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}
