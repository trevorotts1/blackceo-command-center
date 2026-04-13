'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { Focus, Loader2, AlertCircle, GripVertical } from 'lucide-react';
import type { Task, TaskPriority, TaskStatus, WorkspaceStats } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DepartmentItem {
  id: string;
  name: string;
  slug: string;
  icon: string;
  taskCount: number;
}

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
// Component
// ---------------------------------------------------------------------------

export function DepartmentBrowser() {
  const router = useRouter();

  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [activeDeptId, setActiveDeptId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<KanbanCard[]>([]);
  const [loadingDepts, setLoadingDepts] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Fetch departments --------------------------------------------------
  const fetchDepartments = useCallback(async () => {
    try {
      setLoadingDepts(true);
      setError(null);
      const res = await fetch('/api/workspaces?stats=true');
      if (!res.ok) throw new Error('Failed to fetch departments');
      const data: WorkspaceStats[] = await res.json();

      const items: DepartmentItem[] = data
        .filter((w) => w.id !== 'default')
        .map((w) => ({
          id: w.id,
          name: w.name,
          slug: w.slug,
          icon: w.icon || '📁',
          taskCount: w.taskCounts.total,
        }));

      setDepartments(items);
      // Auto-select first department if none selected
      if (items.length > 0 && !activeDeptId) {
        setActiveDeptId(items[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoadingDepts(false);
    }
  }, [activeDeptId]);

  // ---- Fetch tasks for active department ----------------------------------
  const fetchTasks = useCallback(async () => {
    if (!activeDeptId) {
      setTasks([]);
      return;
    }
    try {
      setLoadingTasks(true);
      const res = await fetch(`/api/tasks?department_id=${activeDeptId}`);
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
      setLoadingTasks(false);
    }
  }, [activeDeptId]);

  useEffect(() => {
    fetchDepartments();
  }, [fetchDepartments]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // ---- Organize tasks into kanban columns ---------------------------------
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

  const activeDept = departments.find((d) => d.id === activeDeptId);

  // ---- Render -------------------------------------------------------------
  return (
    <div className="flex h-full min-h-[calc(100vh-10rem)] rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* =========== LEFT PANEL =========== */}
      <aside className="w-64 flex-shrink-0 border-r border-gray-200 bg-gray-50/50 flex flex-col">
        {/* Sidebar Header */}
        <div className="px-4 py-4 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
            Departments
          </h2>
        </div>

        {/* Department List */}
        <div className="flex-1 overflow-y-auto py-2">
          {loadingDepts ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            </div>
          ) : departments.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              No departments found
            </div>
          ) : (
            <ul className="space-y-0.5 px-2">
              {departments.map((dept) => {
                const isActive = dept.id === activeDeptId;
                return (
                  <li key={dept.id}>
                    <button
                      onClick={() => setActiveDeptId(dept.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
                        isActive
                          ? 'bg-brand-50 text-brand-700 border border-brand-200'
                          : 'text-gray-700 hover:bg-gray-100 border border-transparent'
                      }`}
                    >
                      <span className="text-lg flex-shrink-0">{dept.icon}</span>
                      <span className="text-sm font-medium truncate flex-1">
                        {dept.name}
                      </span>
                      {dept.taskCount > 0 && (
                        <span
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            isActive
                              ? 'bg-brand-100 text-brand-700'
                              : 'bg-gray-200 text-gray-600'
                          }`}
                        >
                          {dept.taskCount}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* =========== RIGHT PANEL =========== */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Board Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {activeDept && (
              <>
                <span className="text-2xl">{activeDept.icon}</span>
                <h2 className="text-lg font-bold text-gray-900">
                  {activeDept.name}
                </h2>
                <span className="text-sm text-gray-500">
                  {tasks.length} task{tasks.length !== 1 ? 's' : ''}
                </span>
              </>
            )}
          </div>
          {activeDeptId && (
            <button
              onClick={() => router.push(`/ceo-board/${activeDeptId}/focus`)}
              className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-700 transition-colors"
            >
              <Focus className="h-4 w-4" />
              Focus View
            </button>
          )}
        </div>

        {/* Error State */}
        {error && (
          <div className="mx-6 mt-4 flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Kanban Board */}
        <div className="flex-1 overflow-x-auto p-6">
          {loadingTasks ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : !activeDeptId ? (
            <div className="flex items-center justify-center h-64 text-gray-400 text-base">
              Select a department to view tasks
            </div>
          ) : (
            <div className="flex gap-4 h-full min-h-[24rem]">
              {KANBAN_COLUMNS.map((col) => {
                const cards = columns[col.key];
                return (
                  <div
                    key={col.key}
                    className={`flex flex-col w-72 flex-shrink-0 rounded-xl ${col.color} border border-gray-200`}
                  >
                    {/* Column Header */}
                    <div className="px-3 py-2.5 border-b border-gray-200/80 flex items-center justify-between">
                      <span className="text-sm font-semibold text-gray-700">
                        {col.label}
                      </span>
                      <span className="text-xs font-medium text-gray-500 bg-white/80 px-2 py-0.5 rounded-full">
                        {cards.length}
                      </span>
                    </div>

                    {/* Cards */}
                    <div className="flex-1 overflow-y-auto p-2 space-y-2">
                      <AnimatePresence mode="popLayout">
                        {cards.length === 0 ? (
                          <div className="text-xs text-gray-400 text-center py-4">
                            No tasks
                          </div>
                        ) : (
                          cards.map((card) => (
                            <KanbanTaskCard key={card.id} card={card} />
                          ))
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kanban Task Card
// ---------------------------------------------------------------------------

function KanbanTaskCard({ card }: { card: KanbanCard }) {
  const priorityStyle = PRIORITY_STYLES[card.priority];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className="bg-white rounded-lg border border-gray-200 p-3 shadow-sm hover:shadow-md hover:border-gray-300 transition-shadow cursor-grab active:cursor-grabbing"
    >
      {/* Title */}
      <p className="text-sm font-medium text-gray-900 leading-snug mb-2 line-clamp-2">
        {card.title}
      </p>

      {/* Badges row */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* Priority badge */}
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold ${priorityStyle.bg} ${priorityStyle.text}`}
        >
          {priorityStyle.label}
        </span>

        {/* Persona pill */}
        {card.persona && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-violet-100 text-violet-700">
            <span>🧠</span>
            {card.persona}
          </span>
        )}
      </div>

      {/* Assigned agent */}
      {card.assignedAgent && (
        <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-gray-100">
          <span className="text-sm">{card.assignedAgent.avatar_emoji}</span>
          <span className="text-xs text-gray-600 font-medium truncate">
            {card.assignedAgent.name}
          </span>
        </div>
      )}
    </motion.div>
  );
}

export default DepartmentBrowser;
