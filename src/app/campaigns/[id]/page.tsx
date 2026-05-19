'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Loader2, AlertCircle, Target } from 'lucide-react';
import { Breadcrumb } from '@/components/Breadcrumb';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskStatus =
  | 'inbox' | 'backlog' | 'planning' | 'assigned' | 'pending_dispatch'
  | 'in_progress' | 'testing' | 'review' | 'blocked' | 'done';
type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

interface Campaign {
  id: string;
  name: string;
  description: string;
  status: string;
  department_ids: string;
  start_date: string | null;
  target_date: string | null;
}

interface CampaignTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  department_id: string | null;
  persona_id: string | null;
  persona_name: string | null;
  persona_mode: 'leadership' | 'coaching' | null;
  persona_score: number | null;
  secondary_persona_id: string | null;
  secondary_persona_name: string | null;
  assignedAgent?: { id: string; name: string; avatar_emoji: string } | null;
}

type KanbanColumn = 'new' | 'queued' | 'in_progress' | 'review' | 'done';

const KANBAN_COLUMNS: { key: KanbanColumn; label: string; color: string }[] = [
  { key: 'new',         label: 'New',         color: 'bg-slate-100'  },
  { key: 'queued',      label: 'Queued',      color: 'bg-blue-50'    },
  { key: 'in_progress', label: 'In Progress', color: 'bg-amber-50'   },
  { key: 'review',      label: 'Review',      color: 'bg-violet-50'  },
  { key: 'done',        label: 'Done',        color: 'bg-emerald-50' },
];

const STATUS_TO_COLUMN: Partial<Record<TaskStatus, KanbanColumn>> = {
  inbox: 'new', backlog: 'new', planning: 'queued', assigned: 'queued',
  pending_dispatch: 'queued', in_progress: 'in_progress', testing: 'in_progress',
  review: 'review', blocked: 'review', done: 'done',
};

const PRIORITY_STYLES: Record<TaskPriority, { bg: string; text: string; label: string }> = {
  critical: { bg: 'bg-red-100',    text: 'text-red-700',    label: 'Critical' },
  high:     { bg: 'bg-orange-100', text: 'text-orange-700', label: 'High'     },
  medium:   { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'Medium'   },
  low:      { bg: 'bg-gray-100',   text: 'text-gray-600',   label: 'Low'      },
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CampaignKanbanPage() {
  const router = useRouter();
  const params = useParams();
  const campaignId = params.id as string;

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [tasks, setTasks]       = useState<CampaignTask[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [deptFilter, setDeptFilter] = useState<string>('all');

  useEffect(() => {
    if (!campaignId) return;
    fetch(`/api/campaigns/${campaignId}`)
      .then(r => r.json())
      .then(data => setCampaign(data.campaign))
      .catch(() => setError('Failed to load campaign'));
  }, [campaignId]);

  const fetchTasks = useCallback(async () => {
    if (!campaignId) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/tasks?campaign_id=${campaignId}`);
      if (!res.ok) throw new Error('Failed to fetch tasks');
      const data: any = await res.json();
      const list: any[] = Array.isArray(data) ? data : (data.tasks || []);
      setTasks(list.map((t: any) => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority,
        department_id: t.department_id,
        persona_id: t.persona_id, persona_name: t.persona_name,
        persona_mode: t.persona_mode, persona_score: t.persona_score,
        secondary_persona_id: t.secondary_persona_id,
        secondary_persona_name: t.secondary_persona_name,
        assignedAgent: t.assigned_agent
          ? { id: t.assigned_agent.id, name: t.assigned_agent.name, avatar_emoji: t.assigned_agent.avatar_emoji }
          : null,
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const departments = useMemo(() => {
    const seen = new Set<string>();
    tasks.forEach(t => { if (t.department_id) seen.add(t.department_id); });
    return Array.from(seen);
  }, [tasks]);

  const filteredTasks = useMemo(() =>
    deptFilter === 'all' ? tasks : tasks.filter(t => t.department_id === deptFilter),
    [tasks, deptFilter]
  );

  const columns = useMemo(() => {
    const result: Record<KanbanColumn, CampaignTask[]> = {
      new: [], queued: [], in_progress: [], review: [], done: [],
    };
    for (const card of filteredTasks) {
      const col = STATUS_TO_COLUMN[card.status] ?? 'new';
      result[col].push(card);
    }
    return result;
  }, [filteredTasks]);

  const progress = useMemo(() => {
    if (tasks.length === 0) return 0;
    const done = tasks.filter(t => STATUS_TO_COLUMN[t.status] === 'done').length;
    return Math.round((done / tasks.length) * 100);
  }, [tasks]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-50 bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4">
        <button
          onClick={() => router.push('/ceo-board')}
          className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 text-white text-base font-semibold rounded-lg hover:bg-gray-800 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
          Back
        </button>

        <div className="h-8 w-px bg-gray-200" />

        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'CEO Board', href: '/ceo-board' },
            { label: campaign?.name || 'Campaign' },
          ]}
        />

        <div className="flex items-center gap-3 ml-auto">
          <Target className="h-5 w-5 text-indigo-500" />
          <h1 className="text-xl font-bold text-gray-900">
            {campaign?.name || 'Campaign'}
          </h1>
          <span className="text-sm text-gray-500">
            {tasks.length} task{tasks.length !== 1 ? 's' : ''}
          </span>
        </div>
      </header>

      <div className="bg-white border-b border-gray-100 px-6 py-3 flex items-center gap-6">
        <div className="flex items-center gap-3 flex-1 max-w-sm">
          <span className="text-xs text-gray-500 font-medium whitespace-nowrap">
            {progress}% complete
          </span>
          <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <span className="text-xs text-gray-400">Filter:</span>
          <button
            onClick={() => setDeptFilter('all')}
            className={`text-xs px-3 py-1 rounded-full font-medium transition-colors ${
              deptFilter === 'all'
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            All Departments
          </button>
          {departments.map(dept => (
            <button
              key={dept}
              onClick={() => setDeptFilter(dept)}
              className={`text-xs px-3 py-1 rounded-full font-medium capitalize transition-colors ${
                deptFilter === dept
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {dept}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <main className="p-6">
        {loading ? (
          <div className="flex items-center justify-center h-96">
            <Loader2 className="h-10 w-10 animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="flex gap-4 h-[calc(100vh-11rem)]">
            {KANBAN_COLUMNS.map(col => {
              const cards = columns[col.key];
              return (
                <div
                  key={col.key}
                  className={`flex flex-col flex-1 min-w-[14rem] rounded-xl ${col.color} border border-gray-200`}
                >
                  <div className="px-4 py-3 border-b border-gray-200/80 flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-700">{col.label}</span>
                    <span className="text-xs font-medium text-gray-500 bg-white/80 px-2.5 py-0.5 rounded-full">
                      {cards.length}
                    </span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    <AnimatePresence mode="popLayout">
                      {cards.length === 0 ? (
                        <div className="text-xs text-gray-400 text-center py-6">No tasks</div>
                      ) : (
                        cards.map(card => <CampaignTaskCard key={card.id} card={card} />)
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function CampaignTaskCard({ card }: { card: CampaignTask }) {
  const priorityStyle = PRIORITY_STYLES[card.priority];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm hover:shadow-md hover:border-gray-300 transition-shadow"
    >
      <p className="text-sm font-medium text-gray-900 leading-snug mb-2.5">{card.title}</p>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${priorityStyle.bg} ${priorityStyle.text}`}>
          {priorityStyle.label}
        </span>

        {card.department_id && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-700 capitalize">
            {card.department_id}
          </span>
        )}

        {card.persona_id ? (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
            card.persona_mode === 'coaching'
              ? 'bg-purple-100 text-purple-700 border-purple-200'
              : 'bg-blue-100 text-blue-700 border-blue-200'
          }`}>
            {card.persona_mode === 'coaching' ? '🗣' : '🎯'}{' '}{card.persona_name || card.persona_id}
          </span>
        ) : card.status === 'in_progress' ? (
          <span className="text-xs text-gray-300 italic">selecting persona...</span>
        ) : null}

        {card.secondary_persona_id && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border bg-purple-100 text-purple-700 border-purple-200">
            🗣 {card.secondary_persona_name || card.secondary_persona_id}
          </span>
        )}
        {card.secondary_persona_id && (
          <span className="text-xs text-gray-400">hybrid</span>
        )}
      </div>

      {card.assignedAgent && (
        <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-gray-100">
          <span className="text-base">{card.assignedAgent.avatar_emoji}</span>
          <span className="text-xs text-gray-600 font-medium">{card.assignedAgent.name}</span>
        </div>
      )}
    </motion.div>
  );
}
