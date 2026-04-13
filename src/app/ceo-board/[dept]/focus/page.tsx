'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Loader2, AlertCircle } from 'lucide-react';
import type { Task, TaskPriority, TaskStatus } from '@/lib/types';
import { Breadcrumb } from '@/components/Breadcrumb';
import { resolveDepartment } from '@/lib/routing/resolve-department';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

interface KanbanCard {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgent?: {
    id: string;
    name: string;
    avatar_emoji: string;
  } | null;
  persona?: string;
}

type KanbanColumn = 'new' | 'queued' | 'in_progress' | 'review' | 'done';

const KANBAN_COLUMNS: { key: KanbanColumn; label: string; color: string }[] = [
  { key: 'new', label: 'New', color: 'bg-slate-100' },
  { key: 'queued', label: 'Queued', color: 'bg-blue-50' },
  { key: 'in_progress', label: 'In Progress', color: 'bg-amber-50' },
  { key: 'review', label: 'Review', color: 'bg-violet-50' },
  { key: 'done', label: 'Done', color: 'bg-emerald-50' },
];

const STATUS_TO_COLUMN: Partial<Record<TaskStatus, KanbanColumn>> = {
  inbox: 'new',
  backlog: 'new',
  planning: 'queued',
  assigned: 'queued',
  pending_dispatch: 'queued',
  in_progress: 'in_progress',
  testing: 'in_progress',
  review: 'review',
  blocked: 'review',
  done: 'done',
};

const PRIORITY_STYLES: Record<TaskPriority, { bg: string; text: string; label: string }> = {
  critical: { bg: 'bg-red-100', text: 'text-red-700', label: 'Critical' },
  high: { bg: 'bg-orange-100', text: 'text-orange-700', label: 'High' },
  medium: { bg: 'bg-yellow-100', text: 'text-yellow-700', label: 'Medium' },
  low: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Low' },
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function FocusedDepartmentPage() {
  const router = useRouter();
  const params = useParams();
  const deptId = params.dept as string;

  const [tasks, setTasks] = useState<KanbanCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deptName, setDeptName] = useState<string>('');
  const [deptIcon, setDeptIcon] = useState<string>('📁');

  // ---- Fetch department info (using shared resolution) ---------------------
  useEffect(() => {
    async function fetchDeptInfo() {
      const resolved = await resolveDepartment(deptId);
      if (resolved) {
        setDeptName(resolved.name);
        setDeptIcon(resolved.emoji);
      }
    }
    if (deptId) fetchDeptInfo();
  }, [deptId]);

  // ---- Fetch tasks --------------------------------------------------------
  const fetchTasks = useCallback(async () => {
    if (!deptId) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/tasks?department_id=${deptId}`);
      if (!res.ok) throw new Error('Failed to fetch tasks');
      const data: Task[] = await res.json();

      const cards: KanbanCard[] = data.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        assignedAgent: t.assigned_agent
          ? {
              id: t.assigned_agent.id,
              name: t.assigned_agent.name,
              avatar_emoji: t.assigned_agent.avatar_emoji,
            }
          : null,
        persona: t.assigned_agent?.persona,
      }));

      setTasks(cards);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [deptId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // ---- Organize into kanban columns ---------------------------------------
  const columns = useMemo(() => {
    const result: Record<KanbanColumn, KanbanCard[]> = {
      new: [],
      queued: [],
      in_progress: [],
      review: [],
      done: [],
    };
    for (const card of tasks) {
      const col = STATUS_TO_COLUMN[card.status] ?? 'new';
      result[col].push(card);
    }
    return result;
  }, [tasks]);

  // ---- Render -------------------------------------------------------------
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4">
        {/* Large Back Button */}
        <button
          onClick={() => router.push('/ceo-board/departments')}
          className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 text-white text-base font-semibold rounded-lg hover:bg-gray-800 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
          Back
        </button>

        <div className="h-8 w-px bg-gray-200" />

        {/* Breadcrumb */}
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'CEO Board', href: '/ceo-board' },
            { label: deptName || deptId, href: `/ceo-board/${deptId}` },
            { label: 'Focus View' },
          ]}
        />

        {/* Department Title */}
        <div className="flex items-center gap-3 ml-auto">
          <span className="text-3xl">{deptIcon}</span>
          <h1 className="text-xl font-bold text-gray-900">{deptName || deptId}</h1>
          <span className="text-sm text-gray-500">
            {tasks.length} task{tasks.length !== 1 ? 's' : ''}
          </span>
        </div>
      </header>

      {/* Error */}
      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Full-width Kanban */}
      <main className="p-6">
        {loading ? (
          <div className="flex items-center justify-center h-96">
            <Loader2 className="h-10 w-10 animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="flex gap-4 h-[calc(100vh-8rem)]">
            {KANBAN_COLUMNS.map((col) => {
              const cards = columns[col.key];
              return (
                <div
                  key={col.key}
                  className={`flex flex-col flex-1 min-w-[14rem] rounded-xl ${col.color} border border-gray-200`}
                >
                  {/* Column Header */}
                  <div className="px-4 py-3 border-b border-gray-200/80 flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-700">
                      {col.label}
                    </span>
                    <span className="text-xs font-medium text-gray-500 bg-white/80 px-2.5 py-0.5 rounded-full">
                      {cards.length}
                    </span>
                  </div>

                  {/* Cards */}
                  <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    <AnimatePresence mode="popLayout">
                      {cards.length === 0 ? (
                        <div className="text-xs text-gray-400 text-center py-6">
                          No tasks
                        </div>
                      ) : (
                        cards.map((card) => (
                          <FocusedKanbanCard key={card.id} card={card} />
                        ))
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

// ---------------------------------------------------------------------------
// Kanban Card (wider variant for focus view)
// ---------------------------------------------------------------------------

function FocusedKanbanCard({ card }: { card: KanbanCard }) {
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
      {/* Title */}
      <p className="text-sm font-medium text-gray-900 leading-snug mb-2.5">
        {card.title}
      </p>

      {/* Badges */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${priorityStyle.bg} ${priorityStyle.text}`}
        >
          {priorityStyle.label}
        </span>
        {card.persona && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-violet-100 text-violet-700">
            <span>🧠</span>
            {card.persona}
          </span>
        )}
      </div>

      {/* Assigned agent */}
      {card.assignedAgent && (
        <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-gray-100">
          <span className="text-base">{card.assignedAgent.avatar_emoji}</span>
          <span className="text-xs text-gray-600 font-medium">
            {card.assignedAgent.name}
          </span>
        </div>
      )}
    </motion.div>
  );
}
