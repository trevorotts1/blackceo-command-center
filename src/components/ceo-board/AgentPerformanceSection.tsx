'use client';

import { motion } from 'framer-motion';
import { Bot, Activity, CheckCircle, Clock } from 'lucide-react';

interface Agent {
  id: string;
  name: string;
  department: string;
  model: string;
  actionsCompleted: number;
  idlePercent: number;
  qualityScore: number;
  status: 'active' | 'idle';
}

const demoAgents: Agent[] = [
  {
    id: '1',
    name: 'Facebook Specialist',
    department: 'Marketing',
    model: 'Kimi 2.5',
    actionsCompleted: 47,
    idlePercent: 12,
    qualityScore: 91,
    status: 'active',
  },
  {
    id: '2',
    name: 'Email Specialist',
    department: 'Marketing',
    model: 'Sonnet 4.6',
    actionsCompleted: 31,
    idlePercent: 8,
    qualityScore: 88,
    status: 'active',
  },
  {
    id: '3',
    name: 'Sales Closer',
    department: 'Sales',
    model: 'GPT 5.4',
    actionsCompleted: 23,
    idlePercent: 22,
    qualityScore: 79,
    status: 'idle',
  },
  {
    id: '4',
    name: 'Content Creator',
    department: 'Creative',
    model: 'Kimi 2.5',
    actionsCompleted: 58,
    idlePercent: 5,
    qualityScore: 94,
    status: 'active',
  },
  {
    id: '5',
    name: 'Support Agent',
    department: 'Support',
    model: 'Kimi 2.5',
    actionsCompleted: 112,
    idlePercent: 3,
    qualityScore: 96,
    status: 'active',
  },
  {
    id: '6',
    name: 'Operations Manager',
    department: 'Operations',
    model: 'Sonnet 4.6',
    actionsCompleted: 19,
    idlePercent: 31,
    qualityScore: 72,
    status: 'idle',
  },
];

const departmentColors: Record<string, string> = {
  'Marketing': 'bg-purple-100 text-purple-700 border-purple-200',
  'Sales': 'bg-blue-100 text-blue-700 border-blue-200',
  'Creative': 'bg-pink-100 text-pink-700 border-pink-200',
  'Support': 'bg-teal-100 text-teal-700 border-teal-200',
  'Operations': 'bg-orange-100 text-orange-700 border-orange-200',
};

function getQualityColor(score: number): string {
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 60) return 'bg-amber-500';
  return 'bg-red-500';
}

function getQualityTextColor(score: number): string {
  if (score >= 80) return 'text-emerald-600';
  if (score >= 60) return 'text-amber-600';
  return 'text-red-600';
}

export function AgentPerformanceSection() {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-sm">
          <Bot className="h-5 w-5 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">Agent Performance</h2>
          <p className="text-sm text-gray-500">Real-time AI workforce metrics</p>
        </div>
      </div>

      {/* Agent Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {demoAgents.map((agent, index) => (
          <motion.div
            key={agent.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
            className="p-4 rounded-xl border border-gray-200 bg-white hover:border-indigo-300 hover:shadow-md transition-all"
          >
            {/* Top Row: Name, Department, Status */}
            <div className="flex items-start justify-between mb-3">
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-gray-900 truncate">
                  {agent.name}
                </h3>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium border ${
                      departmentColors[agent.department] ||
                      'bg-gray-100 text-gray-700 border-gray-200'
                    }`}
                  >
                    {agent.department}
                  </span>
                </div>
              </div>
              {/* Status Dot */}
              <div
                className={`flex h-2.5 w-2.5 rounded-full ${
                  agent.status === 'active' ? 'bg-emerald-500' : 'bg-gray-400'
                }`}
                title={agent.status === 'active' ? 'Active' : 'Idle'}
              />
            </div>

            {/* Model Pill */}
            <div className="mb-3">
              <span className="inline-flex items-center px-2 py-1 rounded-md bg-gray-800 text-gray-100 text-xs font-mono">
                {agent.model}
              </span>
            </div>

            {/* Stats Row */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="text-center p-2 rounded-lg bg-gray-50">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <CheckCircle className="h-3 w-3 text-gray-400" />
                </div>
                <p className="text-lg font-bold text-gray-900">{agent.actionsCompleted}</p>
                <p className="text-[10px] text-gray-500 uppercase tracking-wide">Actions</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-gray-50">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Clock className="h-3 w-3 text-gray-400" />
                </div>
                <p className="text-lg font-bold text-gray-900">{agent.idlePercent}%</p>
                <p className="text-[10px] text-gray-500 uppercase tracking-wide">Idle</p>
              </div>
              <div className="text-center p-2 rounded-lg bg-gray-50">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Activity className="h-3 w-3 text-gray-400" />
                </div>
                <p className={`text-lg font-bold ${getQualityTextColor(agent.qualityScore)}`}>
                  {agent.qualityScore}%
                </p>
                <p className="text-[10px] text-gray-500 uppercase tracking-wide">Quality</p>
              </div>
            </div>

            {/* Quality Progress Bar */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-500">Quality Score</span>
                <span className={`font-medium ${getQualityTextColor(agent.qualityScore)}`}>
                  {agent.qualityScore >= 80 ? 'Excellent' : agent.qualityScore >= 60 ? 'Good' : 'Needs Attention'}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${agent.qualityScore}%` }}
                  transition={{ duration: 0.8, delay: index * 0.1 }}
                  className={`h-full rounded-full ${getQualityColor(agent.qualityScore)}`}
                />
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}