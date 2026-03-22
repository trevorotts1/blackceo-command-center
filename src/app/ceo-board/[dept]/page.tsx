'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronLeft,
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
import { LineChart, Line, ResponsiveContainer } from 'recharts';

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

interface KPIData {
  id: string;
  name: string;
  value: number;
  target: number;
  unit: 'currency' | 'percent' | 'count';
  trend: 'up' | 'down' | 'flat';
  changePercent: number;
  sparkline: { value: number }[];
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

// Demo data
const DEPARTMENTS: Record<string, DepartmentData> = {
  marketing: {
    id: 'marketing',
    name: 'Marketing',
    emoji: '📢',
    headTitle: 'Chief Marketing Officer',
    grade: 'B',
    gradeScore: 82,
    insight: 'Email open rates hit 34%, highest in 60 days. Ad spend efficiency improved 12%. One area to watch: social media engagement dropped 8%.',
  },
  sales: {
    id: 'sales',
    name: 'Sales',
    emoji: '💰',
    headTitle: 'Chief Sales Officer',
    grade: 'A',
    gradeScore: 91,
    insight: 'Conversion rates are 23% above industry benchmark. Lead response time improved to under 5 minutes. Pipeline velocity up 18% this week.',
  },
  billing: {
    id: 'billing',
    name: 'Billing / Finance',
    emoji: '💳',
    headTitle: 'Chief Financial Officer',
    grade: 'C',
    gradeScore: 68,
    insight: 'Invoice processing is on track, but payment collection lagged 3 days this week. Consider automated follow-up sequences.',
  },
  support: {
    id: 'support',
    name: 'Customer Support',
    emoji: '🎧',
    headTitle: 'Chief Customer Officer',
    grade: 'A',
    gradeScore: 89,
    insight: 'Ticket resolution time down 25%. Customer satisfaction scores at 94%. First response time averaging under 2 minutes.',
  },
  operations: {
    id: 'operations',
    name: 'Operations',
    emoji: '⚙️',
    headTitle: 'Chief Operating Officer',
    grade: 'B',
    gradeScore: 78,
    insight: 'Process automation increased 15%. Two workflows need attention: vendor onboarding and inventory alerts.',
  },
  creative: {
    id: 'creative',
    name: 'Creative',
    emoji: '✍️',
    headTitle: 'Chief Creative Officer',
    grade: 'B',
    gradeScore: 84,
    insight: 'Content output increased 20% with same agent count. Quality scores steady at 92%. Brand consistency improved.',
  },
  hr: {
    id: 'hr',
    name: 'HR / People',
    emoji: '👥',
    headTitle: 'Chief People Officer',
    grade: 'C',
    gradeScore: 65,
    insight: 'Recruitment pipeline healthy but onboarding completion rate dropped. Review new hire experience this week.',
  },
  legal: {
    id: 'legal',
    name: 'Legal / Compliance',
    emoji: '⚖️',
    headTitle: 'General Counsel',
    grade: 'A',
    gradeScore: 94,
    insight: 'All compliance checks passed. Contract review turnaround time best in 90 days. Zero escalations this week.',
  },
  it: {
    id: 'it',
    name: 'IT / Tech',
    emoji: '🖥️',
    headTitle: 'Chief Technology Officer',
    grade: 'B',
    gradeScore: 80,
    insight: 'System uptime 99.9%. Security scan completed with zero critical issues. Two minor patches pending deployment.',
  },
  webdev: {
    id: 'webdev',
    name: 'Web Development',
    emoji: '🌐',
    headTitle: 'Chief Web Officer',
    grade: 'A',
    gradeScore: 88,
    insight: 'Deployment frequency up 30%. Zero failed builds this week. Page load times improved 12% through optimization.',
  },
  appdev: {
    id: 'appdev',
    name: 'App Development',
    emoji: '📱',
    headTitle: 'Chief App Officer',
    grade: 'B',
    gradeScore: 76,
    insight: 'Feature delivery on schedule. Bug fix velocity increased. Testing coverage improved to 87%.',
  },
  graphics: {
    id: 'graphics',
    name: 'Graphics',
    emoji: '🎨',
    headTitle: 'Chief Graphics Officer',
    grade: 'A',
    gradeScore: 90,
    insight: 'Design output exceeded targets by 15%. Brand guideline adherence at 98%. Client approval rate up 8%.',
  },
  video: {
    id: 'video',
    name: 'Video',
    emoji: '🎬',
    headTitle: 'Chief Video Officer',
    grade: 'B',
    gradeScore: 79,
    insight: 'Video production volume steady. Average render time down 20%. Two projects awaiting client feedback.',
  },
  audio: {
    id: 'audio',
    name: 'Audio',
    emoji: '🎙️',
    headTitle: 'Chief Audio Officer',
    grade: 'C',
    gradeScore: 71,
    insight: 'Podcast editing on schedule. Voiceover quality scores high. Consider upgrading microphone for one agent.',
  },
  research: {
    id: 'research',
    name: 'Research',
    emoji: '🔬',
    headTitle: 'Chief Research Officer',
    grade: 'B',
    gradeScore: 83,
    insight: 'Market analysis reports delivered ahead of schedule. Competitor tracking comprehensive. Two insights led to strategy shifts.',
  },
  comms: {
    id: 'comms',
    name: 'Communications',
    emoji: '📣',
    headTitle: 'Chief Communications Officer',
    grade: 'B',
    gradeScore: 81,
    insight: 'Internal communications response rate at 78%. Town hall prep on track. Media mentions increased 25% this week.',
  },
  ceo: {
    id: 'ceo',
    name: 'CEO / COM',
    emoji: '👔',
    headTitle: 'Chief Executive Officer',
    grade: 'A',
    gradeScore: 92,
    insight: 'Strategic planning on track. Board presentation ready 2 days early. Cross-department coordination improved 15%.',
  },
};

function generateDemoKPIs(deptId: string): KPIData[] {
  const deptKPIs: Record<string, KPIData[]> = {
    marketing: [
      { id: 'mkt-1', name: 'Cost Per Lead', value: 22.5, target: 25, unit: 'currency', trend: 'down', changePercent: -10, sparkline: Array.from({ length: 7 }, () => ({ value: 25 + Math.random() * 5 })) },
      { id: 'mkt-2', name: 'Conversion Rate', value: 24, target: 20, unit: 'percent', trend: 'up', changePercent: 20, sparkline: Array.from({ length: 7 }, () => ({ value: 18 + Math.random() * 8 })) },
      { id: 'mkt-3', name: 'Email Open Rate', value: 34, target: 30, unit: 'percent', trend: 'up', changePercent: 13, sparkline: Array.from({ length: 7 }, () => ({ value: 28 + Math.random() * 10 })) },
      { id: 'mkt-4', name: 'Social Reach', value: 45200, target: 40000, unit: 'count', trend: 'up', changePercent: 13, sparkline: Array.from({ length: 7 }, () => ({ value: 35000 + Math.random() * 15000 })) },
    ],
    sales: [
      { id: 'sales-1', name: 'Lead Response Time', value: 4.5, target: 5, unit: 'count', trend: 'down', changePercent: -25, sparkline: Array.from({ length: 7 }, () => ({ value: 6 + Math.random() * 4 })) },
      { id: 'sales-2', name: 'Conversion Rate', value: 23, target: 20, unit: 'percent', trend: 'up', changePercent: 15, sparkline: Array.from({ length: 7 }, () => ({ value: 18 + Math.random() * 8 })) },
      { id: 'sales-3', name: 'Deals Closed', value: 12, target: 10, unit: 'count', trend: 'up', changePercent: 20, sparkline: Array.from({ length: 7 }, () => ({ value: 6 + Math.random() * 8 })) },
      { id: 'sales-4', name: 'Pipeline Value', value: 285000, target: 250000, unit: 'currency', trend: 'up', changePercent: 14, sparkline: Array.from({ length: 7 }, () => ({ value: 200000 + Math.random() * 100000 })) },
    ],
    support: [
      { id: 'support-1', name: 'Avg Resolution Time', value: 18, target: 24, unit: 'count', trend: 'down', changePercent: -25, sparkline: Array.from({ length: 7 }, () => ({ value: 24 + Math.random() * 12 })) },
      { id: 'support-2', name: 'First Response Time', value: 1.8, target: 5, unit: 'count', trend: 'down', changePercent: -64, sparkline: Array.from({ length: 7 }, () => ({ value: 4 + Math.random() * 3 })) },
      { id: 'support-3', name: 'CSAT Score', value: 94, target: 90, unit: 'percent', trend: 'up', changePercent: 4, sparkline: Array.from({ length: 7 }, () => ({ value: 85 + Math.random() * 12 })) },
      { id: 'support-4', name: 'Tickets Resolved', value: 187, target: 150, unit: 'count', trend: 'up', changePercent: 25, sparkline: Array.from({ length: 7 }, () => ({ value: 120 + Math.random() * 80 })) },
    ],
  };

  const defaultKPIs: KPIData[] = [
    { id: 'default-1', name: 'Tasks Completed', value: 45, target: 40, unit: 'count', trend: 'up', changePercent: 12, sparkline: Array.from({ length: 7 }, () => ({ value: 30 + Math.random() * 20 })) },
    { id: 'default-2', name: 'Efficiency Score', value: 87, target: 85, unit: 'percent', trend: 'up', changePercent: 2, sparkline: Array.from({ length: 7 }, () => ({ value: 75 + Math.random() * 15 })) },
    { id: 'default-3', name: 'Quality Rating', value: 4.6, target: 4.5, unit: 'count', trend: 'up', changePercent: 2, sparkline: Array.from({ length: 7 }, () => ({ value: 4 + Math.random() * 1 })) },
    { id: 'default-4', name: 'On-Time Delivery', value: 92, target: 90, unit: 'percent', trend: 'up', changePercent: 2, sparkline: Array.from({ length: 7 }, () => ({ value: 80 + Math.random() * 15 })) },
  ];

  return deptKPIs[deptId] || defaultKPIs;
}

function generateDemoAgents(deptId: string): AgentData[] {
  const personas = ['Alex Hormozi', 'Gary Vee', 'Seth Godin', 'Simon Sinek', 'Brené Brown', 'Ray Dalio'];
  const models = ['Kimi 2.5', 'Sonnet 4.6', 'GPT 5.4', 'Opus 4.6'];

  return Array.from({ length: 3 }, (_, i) => ({
    id: `${deptId}-agent-${i}`,
    name: `${deptId.charAt(0).toUpperCase() + deptId.slice(1)} Specialist ${i + 1}`,
    persona: personas[Math.floor(Math.random() * personas.length)],
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
      supportingData: 'Open rate: 34% (industry avg: 25%). Unsubscribe rate: 0.3% (industry avg: 0.5%). Engagement has increased 12% over past 14 days.',
    },
    {
      id: `${deptId}-rec-2`,
      title: 'Pause underperforming ad creative',
      description: 'Three ad variants are consuming 40% of budget but generating only 8% of conversions.',
      category: 'stop',
      confidence: 0.91,
      supportingData: 'Ad spend analysis: Variant A ($1,200 spent, 2 conversions), Variant B ($980 spent, 1 conversion), Variant C ($890 spent, 3 conversions). Compare to top performer: $400 spent, 18 conversions.',
    },
    {
      id: `${deptId}-rec-3`,
      title: 'Double down on LinkedIn content',
      description: 'LinkedIn posts are generating 3x more qualified leads than other platforms at half the cost.',
      category: 'do-more',
      confidence: 0.88,
      supportingData: 'LinkedIn: 45 leads @ $12 CPL. Instagram: 23 leads @ $38 CPL. Twitter: 12 leads @ $52 CPL. LinkedIn leads also showing 40% higher conversion to sales calls.',
    },
  ];
}

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

// Sub-components
function KPICard({ kpi }: { kpi: KPIData }) {
  const TrendIcon = kpi.trend === 'up' ? TrendingUp : kpi.trend === 'down' ? TrendingDown : Minus;
  const trendColor = kpi.trend === 'up' ? 'text-emerald-600' : kpi.trend === 'down' ? 'text-rose-600' : 'text-gray-500';
  const trendBg = kpi.trend === 'up' ? 'bg-emerald-50' : kpi.trend === 'down' ? 'bg-rose-50' : 'bg-gray-100';

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
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={kpi.sparkline}>
            <Line
              type="monotone"
              dataKey="value"
              stroke={kpi.trend === 'up' ? '#10B981' : kpi.trend === 'down' ? '#EF4444' : '#6366F1'}
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-gray-400">Target: {formatValue(kpi.target, kpi.unit)}</span>
        <span className={kpi.value >= kpi.target ? 'text-emerald-600 font-medium' : 'text-amber-600 font-medium'}>
          {kpi.value >= kpi.target ? 'On Target' : 'Below Target'}
        </span>
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
    setIsLoading(true);
    setTimeout(() => {
      const dept = DEPARTMENTS[deptId];
      if (dept) {
        setDepartment(dept);
        setKpis(generateDemoKPIs(deptId));
        setAgents(generateDemoAgents(deptId));
        setRecommendations(generateDemoRecommendations(deptId));
      }
      setIsLoading(false);
    }, 500);
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
          <button
            onClick={() => router.push('/ceo-board')}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 text-sm font-medium transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
            Back to Company Overview
          </button>
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
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {kpis.map((kpi) => (
                <KPICard key={kpi.id} kpi={kpi} />
              ))}
            </div>
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