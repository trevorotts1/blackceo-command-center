'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Home,
  Target,
  Users,
  Sparkles,
  CheckCircle,
  XCircle,
  Clock,
  HelpCircle,
  TrendingUp,
  TrendingDown,
  Minus,
  ChevronDown,
  ChevronUp,
  Zap,
} from 'lucide-react';
import { Sparkline } from '@/components/ceo-board/Sparkline';
import DepartmentMemorySection from '@/components/ceo-board/DepartmentMemorySection';
import { SectionContainer } from '@/components/ceo-board/redesign/SectionContainer';

// Types
interface DepartmentData {
  id: string;
  name: string;
  emoji: string;
  headTitle: string;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  gradeScore: number;
  insight: string;
}

interface KPIHistoryPoint {
  snapshot_date: string;
  value: number;
}

interface KPIData {
  id: string;
  kpiId: string;
  name: string;
  value: number;
  target: number;
  unit: 'currency' | 'percent' | 'count';
  trend: 'up' | 'down' | 'flat';
  changePercent: number;
  sparkline: number[];
  benchmark?: number;
}

interface AgentData {
  id: string;
  name: string;
  persona: string;
  model: string;
  actionsCompleted: number;
  idlePercent: number;
  qualityScore: number;
}

interface Recommendation {
  id: string;
  title: string;
  description: string;
  category: 'do-more' | 'stop' | 'watch' | 'try';
  confidence: number;
  supportingData: string;
}

function formatValue(value: number, unit: string): string {
  if (unit === 'currency') return `$${value.toLocaleString()}`;
  if (unit === 'percent') return `${value}%`;
  return value.toLocaleString();
}

function getGradeColor(grade: string): string {
  switch (grade) {
    case 'A': return 'text-emerald-600 bg-emerald-50 border-emerald-200';
    case 'B': return 'text-brand-700 bg-brand-50 border-brand-200';
    case 'C': return 'text-amber-600 bg-amber-50 border-amber-200';
    case 'D': return 'text-orange-600 bg-orange-50 border-orange-200';
    case 'F': return 'text-rose-600 bg-rose-50 border-rose-200';
    default: return 'text-gray-600 bg-gray-50 border-gray-200';
  }
}

function getCategoryColor(category: string): string {
  switch (category) {
    case 'do-more': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
    case 'stop': return 'bg-rose-100 text-rose-700 border-rose-200';
    case 'watch': return 'bg-amber-100 text-amber-700 border-amber-200';
    case 'try': return 'bg-brand-100 text-brand-700 border-brand-200';
    default: return 'bg-gray-100 text-gray-700 border-gray-200';
  }
}

function getCategoryLabel(category: string): string {
  switch (category) {
    case 'do-more': return 'Do More';
    case 'stop': return 'Stop Doing';
    case 'watch': return 'Watch';
    case 'try': return 'Try This';
    default: return category;
  }
}

function computeTrend(data: number[]): { trend: 'up' | 'down' | 'flat'; changePercent: number } {
  if (data.length < 2) return { trend: 'flat', changePercent: 0 };
  const first = data[0];
  const last = data[data.length - 1];
  if (first === 0) return { trend: 'flat', changePercent: 0 };
  const pct = Math.round(((last - first) / first) * 100);
  return {
    trend: pct > 2 ? 'up' : pct < -2 ? 'down' : 'flat',
    changePercent: pct,
  };
}

// --- Loading Skeletons ---

function PageSkeleton() {
  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-gray-200 px-4 sm:px-6 lg:px-8">
        <div className="h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-5 w-12 bg-gray-200 rounded animate-pulse" />
            <div className="text-gray-300">/</div>
            <div className="h-5 w-28 bg-gray-200 rounded animate-pulse" />
            <div className="text-gray-300">/</div>
            <div className="h-5 w-24 bg-gray-200 rounded animate-pulse" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-gray-200 animate-pulse" />
            <div className="h-4 w-8 bg-gray-200 rounded animate-pulse" />
          </div>
        </div>
      </header>
      <main className="p-8">
        <div className="max-w-[1400px] mx-auto space-y-12">
          {/* Hero skeleton */}
          <div className="bg-white rounded-3xl border border-gray-200 p-8 shadow-sm">
            <div className="flex flex-col lg:flex-row lg:items-center gap-6">
              <div className="flex items-center gap-5">
                <div className="h-16 w-16 bg-gray-200 rounded-2xl animate-pulse" />
                <div className="space-y-2">
                  <div className="h-8 w-48 bg-gray-200 rounded animate-pulse" />
                  <div className="h-5 w-32 bg-gray-100 rounded animate-pulse" />
                </div>
              </div>
              <div className="lg:ml-auto">
                <div className="h-24 w-48 bg-gray-200 rounded-2xl animate-pulse" />
              </div>
            </div>
            <div className="mt-6 h-16 bg-gray-100 rounded-xl animate-pulse" />
          </div>
          {/* KPI skeleton */}
          <div>
            <div className="flex items-center gap-3 mb-6">
              <div className="h-10 w-10 bg-gray-200 rounded-xl animate-pulse" />
              <div className="h-6 w-36 bg-gray-200 rounded animate-pulse" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="rounded-2xl p-8 min-h-[200px] flex flex-col justify-between bg-gray-100 animate-pulse">
                  <div className="h-4 w-24 bg-gray-200 rounded" />
                  <div className="h-14 w-24 bg-gray-200 rounded mt-4" />
                  <div className="h-3 w-36 bg-gray-200 rounded mt-4" />
                  <div className="h-8 w-full bg-gray-200 rounded mt-4" />
                </div>
              ))}
            </div>
          </div>
          {/* Agent skeleton */}
          <div className="rounded-2xl bg-white/90 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <div className="h-6 w-32 bg-gray-200 rounded animate-pulse" />
            </div>
            <div className="p-6">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <div className="h-12 w-12 rounded-full bg-gray-200 animate-pulse" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-32 bg-gray-200 rounded animate-pulse" />
                    <div className="h-3 w-48 bg-gray-100 rounded animate-pulse" />
                  </div>
                  <div className="h-6 w-20 bg-gray-200 rounded-full animate-pulse" />
                </div>
              ))}
            </div>
          </div>
          {/* Rec skeleton */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="rounded-xl bg-gray-100 p-5 animate-pulse min-h-[180px]">
                <div className="h-5 w-20 bg-gray-200 rounded-full mb-3" />
                <div className="h-5 w-3/4 bg-gray-200 rounded mb-3" />
                <div className="h-4 w-full bg-gray-200 rounded mb-2" />
                <div className="h-4 w-2/3 bg-gray-200 rounded" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

// --- KPI Card ---

function KPICard({ kpi, dark }: { kpi: KPIData; dark?: boolean }) {
  const TrendIcon = kpi.trend === 'up' ? TrendingUp : kpi.trend === 'down' ? TrendingDown : Minus;
  const trendColor = kpi.trend === 'up' ? 'text-emerald-600' : kpi.trend === 'down' ? 'text-rose-600' : 'text-gray-500';
  const trendBg = kpi.trend === 'up' ? 'bg-emerald-50' : kpi.trend === 'down' ? 'bg-rose-50' : 'bg-gray-100';

  const benchmarkLabel = kpi.benchmark !== undefined
    ? kpi.value >= kpi.benchmark ? 'above' : 'below'
    : null;

  if (dark) {
    return (
      <div className="bg-brand-800 rounded-2xl shadow-md p-8 hover:shadow-lg transition-shadow duration-200">
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-sm font-medium text-white/70">{kpi.name}</p>
            <p className="text-kpi-value text-white mt-1">{formatValue(kpi.value, kpi.unit)}</p>
          </div>
          <div className={`flex items-center gap-1 px-2 py-1 rounded-lg ${kpi.trend === 'up' ? 'bg-emerald-500/20' : kpi.trend === 'down' ? 'bg-rose-500/20' : 'bg-white/10'}`}>
            <TrendIcon className={`h-4 w-4 ${kpi.trend === 'up' ? 'text-emerald-300' : kpi.trend === 'down' ? 'text-rose-300' : 'text-white/50'}`} />
            <span className={`text-sm font-semibold ${kpi.trend === 'up' ? 'text-emerald-300' : kpi.trend === 'down' ? 'text-rose-300' : 'text-white/50'}`}>
              {kpi.changePercent > 0 ? '+' : ''}{kpi.changePercent}%
            </span>
          </div>
        </div>
        <div className="h-12">
          <Sparkline data={kpi.sparkline} width={200} height={48} />
        </div>
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-white/50">Target: {formatValue(kpi.target, kpi.unit)}</span>
          {benchmarkLabel && (
            <span className={`font-medium ${benchmarkLabel === 'above' ? 'text-emerald-300' : 'text-amber-300'}`}>
              {benchmarkLabel === 'above' ? '↑' : '↓'} vs avg ({formatValue(kpi.benchmark!, kpi.unit)})
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-md p-8 hover:shadow-lg transition-shadow duration-200">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-base font-medium text-gray-500">{kpi.name}</p>
          <p className="text-kpi-value text-gray-900 mt-1">{formatValue(kpi.value, kpi.unit)}</p>
        </div>
        <div className={`flex items-center gap-1 px-2 py-1 rounded-lg ${trendBg}`}>
          <TrendIcon className={`h-4 w-4 ${trendColor}`} />
          <span className={`text-sm font-semibold ${trendColor}`}>
            {kpi.changePercent > 0 ? '+' : ''}{kpi.changePercent}%
          </span>
        </div>
      </div>
      <div className="h-12">
        <Sparkline data={kpi.sparkline} width={200} height={48} />
      </div>
      <div className="mt-3 flex items-center justify-between text-sm">
        <span className="text-gray-400">Target: {formatValue(kpi.target, kpi.unit)}</span>
        {benchmarkLabel && (
          <span className={`font-medium ${benchmarkLabel === 'above' ? 'text-emerald-600' : 'text-amber-600'}`}>
            {benchmarkLabel === 'above' ? '↑' : '↓'} vs industry avg ({formatValue(kpi.benchmark!, kpi.unit)})
          </span>
        )}
      </div>
    </div>
  );
}

// --- Agent Card (inline row style) ---

function AgentRow({ agent }: { agent: AgentData }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50/50 transition-colors">
      <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-brand-100 to-brand-50 flex items-center justify-center text-2xl flex-shrink-0">
        🤖
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h4 className="text-base font-semibold text-gray-900 truncate">{agent.name}</h4>
        </div>
        <p className="text-sm text-gray-500 truncate">Persona: {agent.persona}</p>
      </div>
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-badge font-medium bg-brand-50 text-brand-700 border border-brand-100 flex-shrink-0">
        <Zap className="h-3 w-3 mr-1" />
        {agent.model}
      </span>
      <div className="flex items-center gap-4 flex-shrink-0">
        <div className="text-center">
          <p className="text-base font-bold text-gray-900">{agent.actionsCompleted}</p>
          <p className="text-sm text-gray-500">Actions</p>
        </div>
        <div className="text-center">
          <p className={`text-base font-bold ${agent.idlePercent > 15 ? 'text-amber-600' : 'text-gray-900'}`}>
            {agent.idlePercent}%
          </p>
          <p className="text-sm text-gray-500">Idle</p>
        </div>
        <div className="text-center">
          <p className="text-base font-bold text-emerald-600">{agent.qualityScore}%</p>
          <p className="text-sm text-gray-500">Quality</p>
        </div>
      </div>
    </div>
  );
}

// --- Recommendation Card ---

function RecommendationCard({
  recommendation,
  onApprove,
  onDismiss,
  onSave,
}: {
  recommendation: Recommendation;
  onApprove: () => void;
  onDismiss: () => void;
  onSave: () => void;
}) {
  const [showWhy, setShowWhy] = useState(false);
  const [status, setStatus] = useState<'pending' | 'approved' | 'dismissed' | 'saved'>('pending');

  const handleApprove = async () => {
    setStatus('approved');
    try {
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: recommendation.title,
          description: recommendation.description,
          priority: 'high',
          status: 'backlog',
        }),
      });
    } catch (error) {
      console.error('Failed to create task:', error);
    }
    onApprove();
  };

  const handleDismiss = () => {
    setStatus('dismissed');
    onDismiss();
  };

  const handleSave = () => {
    setStatus('saved');
    onSave();
  };

  if (status === 'approved') {
    return (
      <div className="bg-emerald-50 rounded-xl border border-emerald-200 p-5">
        <div className="flex items-center gap-3">
          <CheckCircle className="h-6 w-6 text-emerald-600" />
          <div>
            <p className="font-semibold text-emerald-900">Approved</p>
            <p className="text-sm text-emerald-700">Task created in department</p>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'dismissed') {
    return (
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-5">
        <div className="flex items-center gap-3">
          <XCircle className="h-6 w-6 text-gray-400" />
          <div>
            <p className="font-semibold text-gray-700">Dismissed</p>
            <p className="text-sm text-gray-500">This recommendation has been archived</p>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'saved') {
    return (
      <div className="bg-brand-50 rounded-xl border border-brand-200 p-5">
        <div className="flex items-center gap-3">
          <Clock className="h-6 w-6 text-brand-600" />
          <div>
            <p className="font-semibold text-brand-900">Saved for Later</p>
            <p className="text-sm text-brand-700">Added to your revisit queue</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-gray-50/80 p-5 hover:bg-gray-100/80 transition-colors">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-badge font-medium border ${getCategoryColor(recommendation.category)}`}>
            {getCategoryLabel(recommendation.category)}
          </span>
          <h4 className="text-lg font-bold text-gray-900 mt-2">{recommendation.title}</h4>
        </div>
        <div className="flex items-center gap-1 px-2 py-1 bg-brand-50 rounded-lg">
          <Sparkles className="h-4 w-4 text-brand-600" />
          <span className="text-sm font-semibold text-brand-700">
            {Math.round(recommendation.confidence * 100)}%
          </span>
        </div>
      </div>
      <p className="text-base text-gray-600 mb-4">{recommendation.description}</p>
      <AnimatePresence>
        {showWhy && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="bg-white rounded-lg p-3 mb-4 border border-gray-100">
              <p className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-1">Supporting Data</p>
              <p className="text-base text-gray-700">{recommendation.supportingData}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex items-center gap-2">
        <button
          onClick={handleApprove}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 transition-colors"
        >
          <CheckCircle className="h-4 w-4" />
          Approve
        </button>
        <button
          onClick={handleDismiss}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
        >
          <XCircle className="h-4 w-4" />
          Dismiss
        </button>
        <button
          onClick={handleSave}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
        >
          <Clock className="h-4 w-4" />
          Later
        </button>
        <button
          onClick={() => setShowWhy(!showWhy)}
          className="flex items-center justify-center gap-1.5 px-3 py-2 bg-white text-brand-600 text-sm font-medium rounded-lg border border-brand-200 hover:bg-brand-50 transition-colors"
        >
          <HelpCircle className="h-4 w-4" />
          {showWhy ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

// --- No hardcoded fallbacks: empty array when API has no data ---

function getDefaultAgents(_deptId: string): AgentData[] {
  return [];
}

// Main Page Component
export default function DepartmentSubBoardPage() {
  const router = useRouter();
  const params = useParams();
  const deptId = params.dept as string;

  const [department, setDepartment] = useState<DepartmentData | null>(null);
  const [kpis, setKpis] = useState<KPIData[]>([]);
  const [agents, setAgents] = useState<AgentData[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadDepartmentData = async () => {
      setIsLoading(true);

      let dept: DepartmentData | undefined;

      try {
        const wsRes = await fetch('/api/workspaces');
        if (wsRes.ok) {
          const workspaces = await wsRes.json();
          const ws = workspaces.find((w: { id: string; slug?: string; name: string; icon?: string; description?: string }) =>
            w.id === deptId || w.slug === deptId
          );
          if (ws) {
            dept = {
              id: ws.id,
              name: ws.name,
              emoji: ws.icon || '🏢',
              headTitle: `Head of ${ws.name}`,
              grade: 'B',
              gradeScore: 75,
              insight: ws.description || `${ws.name} department is active and operational.`,
            };
          }
        }
      } catch (e) {
        console.error('Failed to fetch workspace for dept page:', e);
      }

      if (!dept) {
        setIsLoading(false);
        return;
      }

      setDepartment(dept);

      try {
        const historyRes = await fetch(`/api/kpi-history?department_id=${deptId}&days=30`);
        const historyData = await historyRes.json();

        const benchRes = await fetch(`/api/benchmarks?department=${deptId}`);
        const benchData = await benchRes.json();

        const kpiMap: Record<string, KPIHistoryPoint[]> = {};
        if (historyData.data) {
          for (const row of historyData.data) {
            if (!kpiMap[row.kpi_id]) kpiMap[row.kpi_id] = [];
            kpiMap[row.kpi_id].push({ snapshot_date: row.snapshot_date, value: row.value });
          }
        }

        const benchMap: Record<string, number> = {};
        if (benchData.benchmarks) {
          for (const b of benchData.benchmarks) {
            benchMap[b.kpi_name] = b.benchmark;
          }
        }

        const kpiList: KPIData[] = Object.entries(kpiMap).map(([kpiId, points]) => {
          const values = points.map(p => p.value);
          const latest = values[values.length - 1];
          const { trend, changePercent } = computeTrend(values);
          const kpiName = points.length > 0 ? (historyData.data.find((d: { kpi_id: string; kpi_name: string }) => d.kpi_id === kpiId)?.kpi_name || kpiId) : kpiId;
          const benchmark = benchMap[kpiName];
          const dataRow = historyData.data?.find((d: { kpi_id: string }) => d.kpi_id === kpiId);

          return {
            id: `${deptId}-${kpiId}`,
            kpiId,
            name: kpiName,
            value: Math.round(latest * 100) / 100,
            target: dataRow?.target || 0,
            unit: dataRow?.unit || 'count',
            trend,
            changePercent,
            sparkline: values.slice(-30),
            benchmark,
          };
        });

        setKpis(kpiList);
      } catch (err) {
        console.error('Failed to load KPI data:', err);
        setKpis([]);
      }

      // Load agents from API, fall back to static defaults (no random)
      try {
        const agentRes = await fetch(`/api/agents?department=${deptId}`);
        if (agentRes.ok) {
          const agentData = await agentRes.json();
          if (agentData.agents && agentData.agents.length > 0) {
            setAgents(agentData.agents.map((a: { id: string; name: string; persona?: string; model?: string; actions_completed?: number; idle_percent?: number; quality_score?: number }) => ({
              id: a.id,
              name: a.name,
              persona: a.persona || 'General',
              model: a.model || 'Sonnet 4.6',
              actionsCompleted: a.actions_completed || 0,
              idlePercent: a.idle_percent || 0,
              qualityScore: a.quality_score || 0,
            })));
          } else {
            setAgents(getDefaultAgents(deptId));
          }
        } else {
          setAgents(getDefaultAgents(deptId));
        }
      } catch {
        setAgents(getDefaultAgents(deptId));
      }

      // Load recommendations from API, fall back to empty
      try {
        const recRes = await fetch(`/api/recommendations?department=${deptId}`);
        if (recRes.ok) {
          const recData = await recRes.json();
          if (recData.recommendations && recData.recommendations.length > 0) {
            setRecommendations(recData.recommendations);
          } else {
            setRecommendations([]);
          }
        } else {
          setRecommendations([]);
        }
      } catch {
        setRecommendations([]);
      }

      setIsLoading(false);
    };

    loadDepartmentData();
  }, [deptId]);

  const gradeColors = getGradeColor(department?.grade || 'B');

  if (isLoading) {
    return <PageSkeleton />;
  }

  if (!department) {
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
        <div className="text-center">
          <p className="text-xl font-semibold text-gray-900">Department Not Found</p>
          <p className="text-gray-500 mt-2">The department &quot;{deptId}&quot; does not exist.</p>
          <button
            onClick={() => router.push('/ceo-board')}
            className="mt-4 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"
          >
            Back to Company Overview
          </button>
        </div>
      </div>
    );
  }

  const sectionVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0 },
  };

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-gray-200 px-4 sm:px-6 lg:px-8">
        <div className="h-16 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <button
              onClick={() => router.push('/')}
              className="flex items-center gap-1.5 px-3 py-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg text-sm font-medium transition-colors"
            >
              <Home className="h-4 w-4" />
              Home
            </button>
            <span className="text-gray-300">/</span>
            <button
              onClick={() => router.push('/ceo-board')}
              className="flex items-center gap-1.5 px-3 py-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg text-sm font-medium transition-colors"
            >
              CEO Board
            </button>
            <span className="text-gray-300">/</span>
            <span className="px-3 py-2 text-gray-900 font-semibold text-sm">
              {department?.name || deptId}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-medium text-emerald-600">Live</span>
          </div>
        </div>
      </header>
      <main className="p-8">
        <div className="max-w-[1400px] mx-auto space-y-12">
          {/* Hero Section */}
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-gradient-to-br from-brand-900 to-brand-800 rounded-3xl p-6 sm:p-8 shadow-lg"
          >
            <div className="flex flex-col lg:flex-row lg:items-center gap-6">
              <div className="flex items-center gap-5">
                <div className="h-16 w-16 flex items-center justify-center text-4xl bg-white/10 rounded-2xl">
                  {department.emoji}
                </div>
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-white">{department.name}</h1>
                  <p className="text-white/70">{department.headTitle}</p>
                </div>
              </div>
              <div className="lg:ml-auto flex items-center gap-6">
                <div className="flex items-center gap-4 px-6 py-4 rounded-2xl bg-white/10">
                  <div className="text-center">
                    <p className="text-sm font-medium uppercase tracking-wide text-white/70">Grade</p>
                    <p className="text-display text-white">{department.grade}</p>
                  </div>
                  <div className="h-12 w-px bg-white/20" />
                  <div>
                    <p className="text-sm font-medium text-white/70">Performance Score</p>
                    <p className="text-kpi-value text-white">{department.gradeScore}%</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-6 p-4 bg-white/10 rounded-xl">
              <p className="text-white/90">
                <span className="font-semibold text-white">{department.name}</span> earned a{' '}
                <span className="font-semibold text-white">{department.grade}</span> this week.{' '}
                {department.insight}
              </p>
            </div>
          </motion.section>

          {/* KPIs */}
          <motion.section variants={sectionVariants} initial="hidden" animate="visible" transition={{ delay: 0.1 }}>
            <SectionContainer
              title="Department KPIs"
              accentColor="bg-brand-500"
              context={kpis.length > 0 ? `${kpis.length} metrics` : undefined}
            >
              {kpis.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {kpis.map((kpi, idx) => (
                    <KPICard key={kpi.id} kpi={kpi} dark={idx === 0} />
                  ))}
                </div>
              ) : (
                <div className="bg-gray-50 rounded-xl p-8 text-center">
                  <p className="text-gray-500">No KPI data available yet for this department.</p>
                </div>
              )}
            </SectionContainer>
          </motion.section>

          {/* Department Memory */}
          <motion.section variants={sectionVariants} initial="hidden" animate="visible" transition={{ delay: 0.15 }}>
            <DepartmentMemorySection workspaceId={deptId} />
          </motion.section>

          {/* Agent Activity */}
          <motion.section variants={sectionVariants} initial="hidden" animate="visible" transition={{ delay: 0.2 }}>
            <SectionContainer
              title="Department Agents"
              accentColor="bg-emerald-500"
              context={agents.length > 0 ? `${agents.length} active` : undefined}
            >
              {agents.length > 0 ? (
                <div className="divide-y divide-gray-100">
                  {agents.map((agent) => (
                    <AgentRow key={agent.id} agent={agent} />
                  ))}
                </div>
              ) : (
                <div className="bg-gray-50 rounded-xl p-8 text-center">
                  <p className="text-gray-500">No agents assigned to this department.</p>
                </div>
              )}
            </SectionContainer>
          </motion.section>

          {/* Recommendations */}
          {recommendations.length > 0 && (
            <motion.section variants={sectionVariants} initial="hidden" animate="visible" transition={{ delay: 0.3 }}>
              <SectionContainer
                title="Department Recommendations"
                accentColor="bg-amber-500"
                context={`${recommendations.length} suggestions`}
              >
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  {recommendations.map((rec) => (
                    <RecommendationCard
                      key={rec.id}
                      recommendation={rec}
                      onApprove={() => {}}
                      onDismiss={() => {}}
                      onSave={() => {}}
                    />
                  ))}
                </div>
              </SectionContainer>
            </motion.section>
          )}

          <div className="h-8" />
        </div>
      </main>
    </div>
  );
}
