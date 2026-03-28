'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Bot, Activity, CheckCircle, Clock } from 'lucide-react';
import type { Agent } from '@/lib/types';

/** Map full model IDs to short display labels */
function getModelLabel(model: string | null | undefined): string {
  if (!model) return 'No Model';
  const m = model.toLowerCase();
  if (m.includes('kimi') || m.includes('moonshot')) return 'Kimi K2.5';
  if (m.includes('gpt') || m.includes('openai') || m.includes('codex')) return 'GPT-5.4';
  if (m.includes('sonnet')) return 'Sonnet 4.6';
  if (m.includes('opus')) return 'Opus 4.6';
  if (m.includes('minimax')) return 'MiniMax';
  if (m.includes('perplexity')) return 'Perplexity';
  if (m.includes('gemini')) return 'Gemini';
  return model;
}

/** Pill color styles based on model */
function getModelPillStyle(model: string | null | undefined): string {
  if (!model) return 'bg-gray-50 border-gray-200 text-gray-500';
  const m = model.toLowerCase();
  if (m.includes('kimi') || m.includes('moonshot')) return 'bg-indigo-50 border-indigo-200 text-indigo-700';
  if (m.includes('gpt') || m.includes('openai') || m.includes('codex')) return 'bg-green-50 border-green-200 text-green-700';
  if (m.includes('sonnet') || m.includes('opus')) return 'bg-blue-50 border-blue-200 text-blue-700';
  if (m.includes('minimax')) return 'bg-violet-50 border-violet-200 text-violet-700';
  return 'bg-gray-50 border-gray-200 text-gray-500';
}

/** Dot color for the model indicator */
function getModelDotColor(model: string | null | undefined): string {
  if (!model) return 'bg-gray-300';
  const m = model.toLowerCase();
  if (m.includes('kimi') || m.includes('moonshot')) return 'bg-indigo-400';
  if (m.includes('gpt') || m.includes('openai') || m.includes('codex')) return 'bg-green-400';
  if (m.includes('sonnet') || m.includes('opus')) return 'bg-blue-400';
  if (m.includes('minimax')) return 'bg-violet-400';
  return 'bg-gray-300';
}

const departmentColors: Record<string, string> = {
  marketing: 'bg-purple-100 text-purple-700 border-purple-200',
  sales: 'bg-blue-100 text-blue-700 border-blue-200',
  creative: 'bg-pink-100 text-pink-700 border-pink-200',
  support: 'bg-teal-100 text-teal-700 border-teal-200',
  operations: 'bg-orange-100 text-orange-700 border-orange-200',
  billing: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  hr: 'bg-rose-100 text-rose-700 border-rose-200',
  legal: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  it: 'bg-slate-100 text-slate-700 border-slate-200',
  webdev: 'bg-lime-100 text-lime-700 border-lime-200',
  appdev: 'bg-amber-100 text-amber-700 border-amber-200',
  graphics: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200',
  video: 'bg-red-100 text-red-700 border-red-200',
  audio: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  research: 'bg-sky-100 text-sky-700 border-sky-200',
  comms: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  ceo: 'bg-gray-100 text-gray-700 border-gray-200',
};

const DEPT_LABELS: Record<string, string> = {
  marketing: 'Marketing',
  sales: 'Sales',
  creative: 'Creative',
  support: 'Support',
  operations: 'Operations',
  billing: 'Billing',
  hr: 'HR',
  legal: 'Legal',
  it: 'IT',
  webdev: 'Web Dev',
  appdev: 'App Dev',
  graphics: 'Graphics',
  video: 'Video',
  audio: 'Audio',
  research: 'Research',
  comms: 'Comms',
  ceo: 'CEO',
};

export function AgentPerformanceSection() {
  const router = useRouter();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAgents() {
      try {
        const res = await fetch('/api/agents');
        if (res.ok) {
          const data: Agent[] = await res.json();

          const filtered = data
            // Remove QC and standup agents
            .filter((a) => !a.id.startsWith('qc-') && !a.id.startsWith('standup-'))
            // A. Filter out agents with no model assigned
            .filter((a) => a.model && a.model.trim() !== '' && a.model.toLowerCase() !== 'no model')
            // B. Filter out agents tagged to "default" department (system agents)
            .filter((a) => {
              const dept = (a.workspace_id || 'default').toLowerCase();
              return dept !== 'default';
            })
            // D. Remove "Orchestrator" with no model (extra safety)
            .filter((a) => {
              const name = a.name.toLowerCase();
              if (name === 'orchestrator' && (!a.model || a.model.trim() === '')) return false;
              return true;
            });

          // C. If both "CEO" and "Master Orchestrator" exist, keep only the CEO
          const hasCEO = filtered.some((a) => a.name.toLowerCase() === 'ceo');
          const deduped = hasCEO
            ? filtered.filter((a) => a.name.toLowerCase() !== 'master orchestrator')
            : filtered;

          // F. Sort agents by department name alphabetically
          const sorted = deduped.sort((a, b) => {
            const deptA = DEPT_LABELS[(a.workspace_id || '').toLowerCase()] || a.workspace_id || 'zzz';
            const deptB = DEPT_LABELS[(b.workspace_id || '').toLowerCase()] || b.workspace_id || 'zzz';
            return deptA.localeCompare(deptB);
          });

          setAgents(sorted);
        }
      } catch (err) {
        console.error('Failed to load agents:', err);
      } finally {
        setLoading(false);
      }
    }
    loadAgents();
  }, []);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-sm">
          <Bot className="h-5 w-5 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">Agent Roster</h2>
          <p className="text-sm text-gray-500">AI workforce with model assignments</p>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="p-4 rounded-xl border border-gray-100 bg-gray-50 animate-pulse h-32" />
          ))}
        </div>
      ) : (
        /* Agent Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent, index) => {
            const dept = agent.workspace_id || 'default';
            const deptLabel = DEPT_LABELS[dept] || dept;
            const deptColorClass = departmentColors[dept] || 'bg-gray-100 text-gray-700 border-gray-200';
            const modelLabel = getModelLabel(agent.model);
            const pillStyle = getModelPillStyle(agent.model);
            const dotColor = getModelDotColor(agent.model);
            const isActive = (agent.status as string) === 'working' || (agent.status as string) === 'active';

            return (
              <motion.div
                key={agent.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.04 }}
                onClick={() => router.push(`/workspace/${dept}`)}
                className="p-4 rounded-xl border border-gray-200 bg-white hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer"
              >
                {/* Top Row: Emoji + Name + Status */}
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="text-xl">{agent.avatar_emoji || '🤖'}</span>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-semibold text-gray-900 truncate">
                        {agent.name}
                      </h3>
                      <p className="text-xs text-gray-400 truncate">{agent.role}</p>
                      {agent.description && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{agent.description}</p>
                      )}
                    </div>
                  </div>
                  {/* Status Dot */}
                  <div
                    className={`flex-shrink-0 h-2.5 w-2.5 rounded-full mt-1 ${
                      isActive ? 'bg-emerald-500' : 'bg-gray-300'
                    }`}
                    title={agent.status}
                  />
                </div>

                {/* Department Pill + Specialist Type */}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs font-medium border cursor-pointer hover:opacity-80 ${deptColorClass}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/workspace/${dept}`);
                    }}
                    title={`Go to ${deptLabel} department`}
                  >
                    {deptLabel}
                  </span>
                  {(agent as any).specialist_type && (
                    <span className={`px-2 py-0.5 rounded-full text-badge font-medium border ${
                      (agent as any).specialist_type === 'permanent'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                        : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}>
                      {(agent as any).specialist_type === 'permanent' ? 'Full-time' : 'On-call'}
                    </span>
                  )}
                  {agent.role && /chief|head|director|general|coordinator|lead/i.test(agent.role) && (
                    <span className="px-2 py-0.5 rounded-full text-badge font-medium border bg-amber-50 border-amber-200 text-amber-700">
                      Dept Head
                    </span>
                  )}
                </div>

                {/* Model Pill + Persona */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium ${pillStyle}`}
                    style={{ fontSize: '12px' }}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
                    {modelLabel}
                  </span>
                  {(agent as any).persona && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-violet-200 bg-violet-50 text-violet-700 text-[11px] font-medium">
                      🧠 {(agent as any).persona}
                    </span>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
