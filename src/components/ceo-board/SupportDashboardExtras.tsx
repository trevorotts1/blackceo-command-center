'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  MessageSquare,
  CheckCircle2,
  Star,
  Lightbulb,
  TrendingUp,
  Clock,
  Zap,
  Shield,
  ArrowRight,
} from 'lucide-react';

// --- Types ---

interface TaskItem {
  id: string;
  title: string;
  status: string;
  priority: string;
  created_at: string;
  assigned_agent?: { name: string; avatar_emoji: string };
}

interface AgentItem {
  id: string;
  name: string;
  avatar_emoji: string;
  quality_score?: number;
  actions_completed?: number;
  status: string;
}

// --- Priority Pulse ---

const priorityConfig: Record<string, { label: string; color: string; bgColor: string; barColor: string; icon: typeof AlertTriangle }> = {
  critical: { label: 'Escalated', color: 'text-rose-700', bgColor: 'bg-rose-50', barColor: 'bg-rose-500', icon: AlertTriangle },
  high: { label: 'Urgent', color: 'text-amber-700', bgColor: 'bg-amber-50', barColor: 'bg-amber-500', icon: Zap },
  in_progress: { label: 'Ongoing', color: 'text-indigo-700', bgColor: 'bg-indigo-50', barColor: 'bg-indigo-500', icon: MessageSquare },
  inbox: { label: 'Pending', color: 'text-teal-700', bgColor: 'bg-teal-50', barColor: 'bg-teal-500', icon: Clock },
};

function PriorityPulse({ tasks }: { tasks: TaskItem[] }) {
  // Pick the most important active items
  const escalated = tasks.filter(t => t.priority === 'critical' && t.status !== 'done').slice(0, 1);
  const urgent = tasks.filter(t => t.priority === 'high' && t.status !== 'done').slice(0, 1);
  const ongoing = tasks.filter(t => t.status === 'in_progress').slice(0, 1);
  const pending = tasks.filter(t => t.status === 'inbox' || t.status === 'backlog').slice(0, 1);

  const items = [
    ...escalated.map(t => ({ ...t, displayCategory: 'critical' as const })),
    ...urgent.map(t => ({ ...t, displayCategory: 'high' as const })),
    ...ongoing.map(t => ({ ...t, displayCategory: 'in_progress' as const })),
    ...pending.map(t => ({ ...t, displayCategory: 'inbox' as const })),
  ].slice(0, 3);

  if (items.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h4 className="text-base font-bold text-gray-900 mb-4 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Priority Pulse
        </h4>
        <div className="text-center py-4">
          <CheckCircle2 className="h-8 w-8 text-emerald-400 mx-auto mb-2" />
          <p className="text-sm text-gray-500">All clear. No active priorities.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h4 className="text-base font-bold text-gray-900 mb-4 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        Priority Pulse
      </h4>
      <div className="space-y-3">
        {items.map((item, idx) => {
          const config = priorityConfig[item.displayCategory] || priorityConfig.inbox;
          const Icon = config.icon;
          return (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.08 }}
              className={`flex items-center gap-3 p-3 rounded-lg ${config.bgColor} border border-gray-100`}
            >
              <div className={`w-1 h-10 rounded-full ${config.barColor} flex-shrink-0`} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">{config.label}</p>
                <p className="text-sm font-semibold text-gray-900 truncate">{item.title}</p>
              </div>
              <Icon className={`h-4 w-4 ${config.color} flex-shrink-0`} />
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// --- Top Performers ---

function TopPerformers({ agents }: { agents: AgentItem[] }) {
  const sorted = [...agents]
    .filter(a => a.status !== 'offline')
    .sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0))
    .slice(0, 4);

  if (sorted.length === 0) {
    return null;
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h4 className="text-base font-bold text-gray-900 mb-4 flex items-center gap-2">
        <Star className="h-4 w-4 text-amber-500 fill-amber-500" />
        Top Performers
      </h4>
      <div className="space-y-4">
        {sorted.map((agent, idx) => {
          const score = agent.quality_score || 0;
          const scoreColor = score >= 90 ? 'text-emerald-600' : score >= 75 ? 'text-amber-600' : 'text-gray-500';
          return (
            <motion.div
              key={agent.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.08 }}
              className="flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-gray-100 to-gray-50 flex items-center justify-center text-lg flex-shrink-0">
                  {agent.avatar_emoji || '🤖'}
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900">{agent.name}</p>
                  <p className="text-[11px] text-gray-400 uppercase font-semibold tracking-wider">
                    {agent.actions_completed ? `${agent.actions_completed} actions` : 'Active'}
                  </p>
                </div>
              </div>
              <span className={`text-sm font-bold ${scoreColor}`}>{score}%</span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// --- AI Insights ---

const insightPool = [
  {
    icon: TrendingUp,
    title: 'Resolution Insight',
    text: 'Reducing initial response time by just 4 minutes historically leads to an 8% increase in CSAT.',
    action: 'Enable Auto-Pilot',
  },
  {
    icon: Shield,
    title: 'Quality Gate',
    text: 'Agents with structured escalation paths resolve 34% more tickets on first contact.',
    action: 'Review Escalation Rules',
  },
  {
    icon: Zap,
    title: 'Efficiency Boost',
    text: 'Teams that batch-process similar tickets see a 22% reduction in average handle time.',
    action: 'Enable Smart Batching',
  },
  {
    icon: Clock,
    title: 'Peak Hours',
    text: 'Support volume spikes between 10-11 AM. Consider scheduling proactive outreach outside this window.',
    action: 'Adjust Schedule',
  },
];

function AIInsights({ kpiCount }: { kpiCount: number }) {
  // Pick one based on a simple hash of kpi count
  const insight = insightPool[kpiCount % insightPool.length];
  const Icon = insight.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
      className="bg-gradient-to-br from-gray-900 to-gray-800 text-white rounded-xl p-6 relative overflow-hidden group"
    >
      <div className="relative z-10">
        <Icon className="h-5 w-5 text-amber-400 mb-3" />
        <h4 className="text-base font-bold mb-1">{insight.title}</h4>
        <p className="text-sm text-white/70 leading-relaxed mb-4 italic">&ldquo;{insight.text}&rdquo;</p>
        <button className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-white/60 hover:text-white border-b border-white/20 hover:border-white pb-0.5 transition-all">
          {insight.action}
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
      <div className="absolute -right-4 -bottom-4 opacity-10 group-hover:opacity-20 transition-opacity">
        <Lightbulb className="text-[120px]" />
      </div>
    </motion.div>
  );
}

// --- Main Export ---

interface SupportDashboardExtrasProps {
  workspaceId: string;
  kpiCount: number;
}

export default function SupportDashboardExtras({ workspaceId, kpiCount }: SupportDashboardExtrasProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const [taskRes, agentRes] = await Promise.all([
          fetch(`/api/tasks?workspace_id=${workspaceId}&status=inbox,in_progress,backlog,assigned,review,blocked`),
          fetch(`/api/agents?department=${workspaceId}`),
        ]);

        if (taskRes.ok) {
          const taskData = await taskRes.json();
          setTasks(Array.isArray(taskData) ? taskData : []);
        }

        if (agentRes.ok) {
          const agentData = await agentRes.json();
          const raw = agentData.agents || agentData || [];
          setAgents(Array.isArray(raw) ? raw : []);
        }
      } catch (err) {
        console.error('Failed to load support extras:', err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [workspaceId]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {[1, 2, 3].map(i => (
          <div key={i} className="bg-gray-100 rounded-xl h-48 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <PriorityPulse tasks={tasks} />
      <TopPerformers agents={agents} />
      <AIInsights kpiCount={kpiCount} />
    </div>
  );
}
