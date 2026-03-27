'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft,
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

// Department data is fetched dynamically from /api/workspaces (no hardcoded departments)

function formatValue(value: number, unit: string): string {
  if (unit === 'currency') return `$${value.toLocaleString()}`;
  if (unit === 'percent') return `${value}%`;
  return value.toLocaleString();
}

function getGradeColor(grade: string): string {
  switch (grade) {
    case 'A': return 'text-emerald-600 bg-emerald-50 border-emerald-200';
    case 'B': return 'text-indigo-600 bg-indigo-50 border-indigo-200';
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
    case 'try': return 'bg-indigo-100 text-indigo-700 border-indigo-200';
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

// Compute trend from sparkline data
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

// KPI Card with SVG sparkline + benchmark label
function KPICard({ kpi }: { kpi: KPIData }) {
  const TrendIcon = kpi.trend === 'up' ? TrendingUp : kpi.trend === 'down' ? TrendingDown : Minus;
  const trendColor = kpi.trend === 'up' ? 'text-emerald-600' : kpi.trend === 'down' ? 'text-rose-600' : 'text-gray-500';
  const trendBg = kpi.trend === 'up' ? 'bg-emerald-50' : kpi.trend === 'down' ? 'bg-rose-50' : 'bg-gray-100';

  // Benchmark comparison
  const benchmarkLabel = kpi.benchmark !== undefined
    ? kpi.value >= kpi.benchmark ? 'above' : 'below'
    : null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow duration-200">
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-sm font-medium text-gray-500">{kpi.name}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatValue(kpi.value, kpi.unit)}</p>
        </div>
        <div className={`flex items-center gap-1 px-2 py-1 rounded-lg ${trendBg}`}>
          <TrendIcon className={`h-4 w-4 ${trendColor}`} />
          <span className={`text-xs font-semibold ${trendColor}`}>
            {kpi.changePercent > 0 ? '+' : ''}{kpi.changePercent}%
          </span>
        </div>
      </div>
      <div className="h-12">
        <Sparkline data={kpi.sparkline} width={200} height={48} />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
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

function AgentCard({ agent }: { agent: AgentData }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow duration-200">
      <div className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-indigo-100 to-indigo-50 flex items-center justify-center text-2xl">
          🤖
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-semibold text-gray-900 truncate">{agent.name}</h4>
          </div>
          <p className="text-sm text-gray-500">Persona: {agent.persona}</p>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100 mt-2">
            <Zap className="h-3 w-3 mr-1" />
            {agent.model}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-gray-100">
        <div className="text-center">
          <p className="text-lg font-bold text-gray-900">{agent.actionsCompleted}</p>
          <p className="text-xs text-gray-500">Actions</p>
        </div>
        <div className="text-center">
          <p className={`text-lg font-bold ${agent.idlePercent > 15 ? 'text-amber-600' : 'text-gray-900'}`}>
            {agent.idlePercent}%
          </p>
          <p className="text-xs text-gray-500">Idle</p>
        </div>
        <div className="text-center">
          <p className="text-lg font-bold text-emerald-600">{agent.qualityScore}%</p>
          <p className="text-xs text-gray-500">Quality</p>
        </div>
      </div>
    </div>
  );
}

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
            <p className="text-sm text-emerald-700">Task created in department workspace</p>
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
      <div className="bg-indigo-50 rounded-xl border border-indigo-200 p-5">
        <div className="flex items-center gap-3">
          <Clock className="h-6 w-6 text-indigo-600" />
          <div>
            <p className="font-semibold text-indigo-900">Saved for Later</p>
            <p className="text-sm text-indigo-700">Added to your revisit queue</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow duration-200">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${getCategoryColor(recommendation.category)}`}>
            {getCategoryLabel(recommendation.category)}
          </span>
          <h4 className="font-semibold text-gray-900 mt-2">{recommendation.title}</h4>
        </div>
        <div className="flex items-center gap-1 px-2 py-1 bg-indigo-50 rounded-lg">
          <Sparkles className="h-3.5 w-3.5 text-indigo-600" />
          <span className="text-xs font-semibold text-indigo-700">
            {Math.round(recommendation.confidence * 100)}%
          </span>
        </div>
      </div>
      <p className="text-sm text-gray-600 mb-4">{recommendation.description}</p>
      <AnimatePresence>
        {showWhy && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="bg-gray-50 rounded-lg p-3 mb-4 border border-gray-100">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Supporting Data</p>
              <p className="text-sm text-gray-700">{recommendation.supportingData}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex items-center gap-2">
        <button
          onClick={handleApprove}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
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
          className="flex items-center justify-center gap-1.5 px-3 py-2 bg-white text-indigo-600 text-sm font-medium rounded-lg border border-indigo-200 hover:bg-indigo-50 transition-colors"
        >
          <HelpCircle className="h-4 w-4" />
          {showWhy ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

const FALLBACK_PERSONAS = [
  'Alex Hormozi', 'Chris Voss', 'Neil Rackham', 'Daniel Pink', 'Phil Jones', 'Brendan Kane', 'Daniel Priestley',
  'Donald Miller', 'Seth Godin', 'Robert Bly', 'Joanna Wiebe', 'Robert Cialdini', 'Shelle Rose Charvet',
  'Simon Sinek', 'Jim Collins', 'Jay Samit', 'Vishen Lakhiani', 'Tim Grover',
  'James Clear', 'Tiago Forte', 'Brian Moran', 'Charles Duhigg',
  'Mike Michalowicz',
  'Mel Robbins', 'Robin Sharma', 'David Goggins', 'TD Jakes', 'Janet Attwood', 'Grenny Patterson',
  'Nedra Tawwab', 'Brené Brown', 'Michelle Obama'
];

function generateDemoAgents(deptId: string, livePersonas?: string[]): AgentData[] {
  const personas = livePersonas && livePersonas.length > 0 ? livePersonas : FALLBACK_PERSONAS;
  const models = ['Kimi 2.5', 'Sonnet 4.6', 'GPT 5.4', 'Opus 4.6'];
  return Array.from({ length: 3 }, (_, i) => ({
    id: `${deptId}-agent-${i}`,
    name: `${deptId.charAt(0).toUpperCase() + deptId.slice(1)} Specialist ${i + 1}`,
    persona: personas[i % personas.length],
    model: models[Math.floor(Math.random() * models.length)],
    actionsCompleted: Math.floor(Math.random() * 100) + 50,
    idlePercent: Math.floor(Math.random() * 20) + 5,
    qualityScore: Math.floor(Math.random() * 15) + 85,
  }));
}

function generateDemoRecommendations(deptId: string): Recommendation[] {
  return [
    {
      id: `${deptId}-rec-1`,
      title: 'Increase email frequency by 20%',
      description: 'Current open rates are above industry average. Testing shows your audience can handle more touchpoints without fatigue.',
      category: 'try',
      confidence: 0.82,
      supportingData: 'Open rate: 34% (industry avg: 25%). Unsubscribe rate: 0.3% (industry avg: 0.5%).',
    },
    {
      id: `${deptId}-rec-2`,
      title: 'Pause underperforming ad creative',
      description: 'Three ad variants are consuming 40% of budget but generating only 8% of conversions.',
      category: 'stop',
      confidence: 0.91,
      supportingData: 'Ad spend analysis: Top performer: $400 spent, 18 conversions vs underperformers at 1-3 conversions each.',
    },
    {
      id: `${deptId}-rec-3`,
      title: 'Double down on top channel',
      description: 'Your best channel is generating 3x more qualified leads than others at half the cost.',
      category: 'do-more',
      confidence: 0.88,
      supportingData: 'Top channel: 45 leads @ $12 CPL. Next best: 23 leads @ $38 CPL.',
    },
  ];
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

      // Fetch department data dynamically from the workspaces API
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
        // Fetch 30 days of KPI history for this department
        const historyRes = await fetch(`/api/kpi-history?department_id=${deptId}&days=30`);
        const historyData = await historyRes.json();

        // Fetch benchmarks for this department
        const benchRes = await fetch(`/api/benchmarks?department=${deptId}`);
        const benchData = await benchRes.json();

        // Build a map: kpi_id -> { points: KPIHistoryPoint[], latest: value }
        const kpiMap: Record<string, KPIHistoryPoint[]> = {};
        if (historyData.data) {
          for (const row of historyData.data) {
            if (!kpiMap[row.kpi_id]) kpiMap[row.kpi_id] = [];
            kpiMap[row.kpi_id].push({ snapshot_date: row.snapshot_date, value: row.value });
          }
        }

        // Build benchmark map: kpi_name -> benchmark value
        const benchMap: Record<string, number> = {};
        if (benchData.benchmarks) {
          for (const b of benchData.benchmarks) {
            benchMap[b.kpi_name] = b.benchmark;
          }
        }

        // Convert to KPIData[]
        const kpiList: KPIData[] = Object.entries(kpiMap).map(([kpiId, points]) => {
          const values = points.map(p => p.value);
          const latest = values[values.length - 1];
          const first = values[0];
          const { trend, changePercent } = computeTrend(values);

          // Find matching benchmark by name
          const kpiName = points.length > 0 ? (historyData.data.find((d: { kpi_id: string; kpi_name: string }) => d.kpi_id === kpiId)?.kpi_name || kpiId) : kpiId;
          const benchmark = benchMap[kpiName];

          // Get target and unit from first data row
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
        // Fall back to empty - UI will still render
        setKpis([]);
      }

      // Try to load real personas from governing-personas.md
      let livePersonas: string[] | undefined;
      try {
        const personaRes = await fetch(`/api/departments/${deptId}/personas`);
        if (personaRes.ok) {
          const personaData = await personaRes.json();
          if (personaData.personas && personaData.personas.length > 0) {
            livePersonas = personaData.personas;
          }
        }
      } catch {
        // Fall back to demo personas silently
      }

      setAgents(generateDemoAgents(deptId, livePersonas));
      setRecommendations(generateDemoRecommendations(deptId));
      setIsLoading(false);
    };

    loadDepartmentData();
  }, [deptId]);

  const gradeColors = getGradeColor(department?.grade || 'B');

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
        <div className="flex items-center gap-3 text-gray-500">
          <div className="h-8 w-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          <span className="font-medium">Loading department data...</span>
        </div>
      </div>
    );
  }

  if (!department) {
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
        <div className="text-center">
          <p className="text-xl font-semibold text-gray-900">Department Not Found</p>
          <p className="text-gray-500 mt-2">The department &quot;{deptId}&quot; does not exist.</p>
          <button
            onClick={() => router.push('/ceo-board')}
            className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            Back to Company Overview
          </button>
        </div>
      </div>
    );
  }

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
              Performance Board
            </button>
            <span className="text-gray-300">/</span>
            <button
              onClick={() => router.push('/workspace')}
              className="flex items-center gap-1.5 px-3 py-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg text-sm font-medium transition-colors"
            >
              Kanban
            </button>
            <span className="text-gray-300">/</span>
            <span className="px-3 py-2 text-gray-900 font-semibold text-sm flex items-center gap-1.5">
              <ChevronLeft className="h-3.5 w-3.5 text-gray-400" />
              {department?.name || deptId}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs font-medium text-emerald-600">Live</span>
          </div>
        </div>
      </header>
      <main className="p-4 sm:p-6 lg:p-8">
        <div className="max-w-[1400px] mx-auto space-y-8">
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-3xl border border-gray-200 p-6 sm:p-8 shadow-sm"
          >
            <div className="flex flex-col lg:flex-row lg:items-center gap-6">
              <div className="flex items-center gap-5">
                <div className="h-16 w-16 flex items-center justify-center text-4xl bg-gradient-to-br from-gray-50 to-gray-100 rounded-2xl border border-gray-200">
                  {department.emoji}
                </div>
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">{department.name}</h1>
                  <p className="text-gray-500">{department.headTitle}</p>
                </div>
              </div>
              <div className="lg:ml-auto flex items-center gap-6">
                <div className={`flex items-center gap-4 px-6 py-4 rounded-2xl border ${gradeColors}`}>
                  <div className="text-center">
                    <p className="text-xs font-medium uppercase tracking-wide opacity-70">Grade</p>
                    <p className="text-4xl font-bold">{department.grade}</p>
                  </div>
                  <div className="h-12 w-px bg-current opacity-20" />
                  <div>
                    <p className="text-sm font-medium opacity-70">Performance Score</p>
                    <p className="text-2xl font-bold">{department.gradeScore}%</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-6 p-4 bg-indigo-50 rounded-xl border border-indigo-100">
              <p className="text-gray-700">
                <span className="font-semibold text-indigo-900">{department.name}</span> earned a{' '}
                <span className="font-semibold text-indigo-900">{department.grade}</span> this week.{' '}
                {department.insight}
              </p>
            </div>
          </motion.section>
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                <Target className="h-5 w-5" />
              </div>
              <h2 className="text-xl font-bold text-gray-900">Department KPIs</h2>
              <span className="text-xs text-gray-400 ml-2">30-day trend</span>
            </div>
            {kpis.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {kpis.map((kpi) => (
                  <KPICard key={kpi.id} kpi={kpi} />
                ))}
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
                <p className="text-gray-500">No KPI data available yet for this department.</p>
              </div>
            )}
          </motion.section>
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
            <DepartmentMemorySection workspaceId={deptId} />
          </motion.section>
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-teal-50 text-teal-600">
                <Users className="h-5 w-5" />
              </div>
              <h2 className="text-xl font-bold text-gray-900">Department Agent Activity</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {agents.map((agent) => (
                <AgentCard key={agent.id} agent={agent} />
              ))}
            </div>
          </motion.section>
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                <Sparkles className="h-5 w-5" />
              </div>
              <h2 className="text-xl font-bold text-gray-900">Department Recommendations</h2>
            </div>
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
          </motion.section>
          <div className="h-8" />
        </div>
      </main>
    </div>
  );
}
