'use client';

import { useState } from 'react';
import { Plus, GripVertical, Eye, AlertTriangle } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { X } from 'lucide-react';
import { triggerAutoDispatch, shouldTriggerAutoDispatch } from '@/lib/auto-dispatch';
import type { Task, TaskStatus } from '@/lib/types';
import { TaskModal } from './TaskModal';
import { MarketingPublishButton } from './MarketingPublishButton';
import { formatDistanceToNow } from 'date-fns';

interface MissionQueueProps {
  workspaceId?: string;
  departmentFilter?: string | null;
}

// ── Lean Kanban board model (Trevor-approved) ──────────────────────────────
//
// Columns:  Backlog → To-Do → In Progress → Review / QC → Done
// Side-state: Blocked (not a stage in the flow — a transient exception)
//
// Internal pipeline statuses that are NOT separate board columns:
//   assigned, pending_dispatch  → bucket into To-Do (routed-not-started)
//   inbox, planning             → bucket into To-Do (groomed-but-not-started)
//   testing                     → bucket into Review/QC (dev/web-dev sub-state)
//
// Gate rules:
//   Backlog → To-Do: Triad Rule (description + SOP + persona required)
//   Review / QC:     QC-agent auto-scorer fires on entry (src/lib/qc-scorer.ts)
//                    ≥8.5 → auto-approve to Done; <8.5 → kick back to In Progress
//
// TaskStatus enum still has all underlying statuses (inbox, planning, assigned,
// pending_dispatch, testing) — they're just not visible as separate board columns.
// This is intentionally a UI/column-mapping change, not a schema change.
const COLUMNS: { id: TaskStatus | 'todo'; label: string; gradient: string }[] = [
  { id: 'backlog',     label: 'Backlog',     gradient: 'column-pill-backlog' },
  { id: 'todo',        label: 'To-Do',       gradient: 'column-pill-backlog' },
  { id: 'in_progress', label: 'In Progress', gradient: 'column-pill-progress' },
  { id: 'review',      label: 'Review / QC', gradient: 'column-pill-review' },
  { id: 'blocked',     label: 'Blocked',     gradient: 'column-pill-blocked' },
  { id: 'done',        label: 'Done',        gradient: 'column-pill-done' },
];

const departmentEmojis: Record<string, string> = {
  'ceo-com': '👔', 'ceo': '👔',
  'marketing': '📢',
  'sales': '💰',
  'billing': '💳',
  'customer-support': '🎧', 'support': '🎧',
  'legal-compliance': '⚖️', 'legal': '⚖️',
  'web-development': '🌐', 'webdev': '🌐',
  'app-development': '📱', 'appdev': '📱',
  'graphics': '🎨',
  'video-production': '🎬', 'video': '🎬',
  'audio-production': '🎙️', 'audio': '🎙️',
  'research': '🔬',
  'communications': '📣', 'comms': '📣',
  'crm': '📇',
  'openclaw-maintenance': '🦾', 'openclaw': '🦾',
  'social-media': '📱', 'social': '📱',
  'paid-advertisement': '🎯', 'paid-ads': '🎯',
  'general-task': '🗂️', 'general': '🗂️',
};

const departmentNames: Record<string, string> = {
  'ceo-com': 'CEO / COM',
  'marketing': 'Marketing',
  'sales': 'Sales',
  'billing': 'Billing',
  'customer-support': 'Customer Support',
  'legal-compliance': 'Legal / Compliance',
  'web-development': 'Web Development',
  'app-development': 'App Development',
  'graphics': 'Graphics',
  'video-production': 'Video Production',
  'audio-production': 'Audio Production',
  'research': 'Research',
  'communications': 'Communications',
  'crm': 'CRM',
  'openclaw-maintenance': 'OpenClaw Maintenance',
  'social-media': 'Social Media',
  'paid-advertisement': 'Paid Advertisement',
  'general-task': 'General Task',
};

export function MissionQueue({ workspaceId, departmentFilter }: MissionQueueProps) {
  const { tasks, updateTaskStatus, addEvent, selectedDepartment, setSelectedDepartment } = useMissionControl();
  const effectiveDepartment = departmentFilter !== undefined ? departmentFilter : selectedDepartment;
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [activeFilter, setActiveFilter] = useState('total');

  // Focus View (single department) scopes by the workspace_id FK — the ONLY
  // relationship the schema enforces (tasks.workspace_id REFERENCES
  // workspaces.id). The free-text tasks.department column is unreliable: the
  // task-create flow only ever writes workspace_id (TaskModal sends no
  // department), the router stamps display NAMES, and seed scripts use short
  // slugs — so a slug-vs-name-vs-null mismatch silently empties the board.
  // When a workspaceId is passed (Focus View) we scope by it. The cross-
  // department /tasks/all view passes no workspaceId, so the legacy
  // department-slug selection (sidebar pill) still drives that board.
  const scopeByWorkspace = !!workspaceId && effectiveDepartment !== null && effectiveDepartment !== undefined;

  const matchesScope = (task: Task): boolean => {
    if (scopeByWorkspace) return task.workspace_id === workspaceId;
    if (effectiveDepartment) return task.department === effectiveDepartment;
    return true;
  };

  const getTasksByStatus = (statusId: string) => {
    const filteredByDept = tasks.filter(matchesScope);
    const byColumn = filteredByDept.filter((task) => {
      // Six-column mapping:
      //   backlog  → raw inbox (status === 'backlog')
      //   todo     → groomed (inbox / planning / assigned / pending_dispatch)
      //   review   → review/testing
      //   anything else: 1:1 match with status
      if (statusId === 'backlog') {
        return task.status === 'backlog';
      }
      if (statusId === 'todo') {
        return ['inbox', 'planning', 'assigned', 'pending_dispatch'].includes(task.status);
      }
      if (statusId === 'review') {
        return ['review', 'testing'].includes(task.status);
      }
      return task.status === statusId;
    });

    // Apply the active filter chip (was previously decorative).
    return byColumn.filter((task) => {
      switch (activeFilter) {
        case 'due':
          // Only tasks with a due date in the next 7 days OR overdue
          if (!task.due_date) return false;
          const due = new Date(task.due_date).getTime();
          const sevenDays = 7 * 24 * 60 * 60 * 1000;
          return due - Date.now() <= sevenDays;
        case 'agent':
          // Only tasks that have an assigned agent
          return !!task.assigned_agent_id;
        case 'completed':
          return task.status === 'done';
        case 'status':
        case 'total':
        default:
          return true;
      }
    });
  };

  const handleDragStart = (e: React.DragEvent, task: Task) => {
    setDraggedTask(task);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e: React.DragEvent, targetColumnId: TaskStatus | 'todo') => {
    e.preventDefault();
    // The "To-Do" column is a synthetic UI column — when a card lands there,
    // the actual underlying task status becomes 'assigned' (groomed/queued
    // but not started). The API enforces Triad Rule at the backlog → !backlog
    // boundary, so dropping into To-Do also triggers that check.
    const targetStatus: TaskStatus = targetColumnId === 'todo' ? 'assigned' : (targetColumnId as TaskStatus);

    if (!draggedTask || draggedTask.status === targetStatus) {
      setDraggedTask(null);
      return;
    }

    updateTaskStatus(draggedTask.id, targetStatus);

    try {
      const res = await fetch(`/api/tasks/${draggedTask.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: targetStatus }),
      });

      if (res.ok) {
        addEvent({
          id: crypto.randomUUID(),
          type: targetStatus === 'done' ? 'task_completed' : 'task_status_changed',
          task_id: draggedTask.id,
          message: `Task "${draggedTask.title}" moved to ${targetStatus}`,
          created_at: new Date().toISOString(),
        });

        if (shouldTriggerAutoDispatch(draggedTask.status, targetStatus, draggedTask.assigned_agent_id)) {
          const result = await triggerAutoDispatch({
            taskId: draggedTask.id,
            taskTitle: draggedTask.title,
            agentId: draggedTask.assigned_agent_id,
            agentName: draggedTask.assigned_agent?.name || 'Unknown Agent',
            workspaceId: draggedTask.workspace_id
          });

          if (!result.success) {
            console.error('Auto-dispatch failed:', result.error);
          }
        }
      } else if (res.status === 400) {
        // Triad incomplete — revert the optimistic update and surface the error.
        updateTaskStatus(draggedTask.id, draggedTask.status);
        try {
          const errBody = await res.json();
          if (errBody?.error === 'Triad incomplete' && Array.isArray(errBody.missing)) {
            // Open the task modal so the user can resolve the Triad inline.
            setEditingTask(draggedTask);
          }
        } catch {
          // ignore body parse errors
        }
      }
    } catch (error) {
      console.error('Failed to update task status:', error);
      updateTaskStatus(draggedTask.id, draggedTask.status);
    }

    setDraggedTask(null);
  };

  // Filter tasks by selected department/workspace for accurate counts.
  // Mirrors the scoping used by getTasksByStatus so the "By Total Tasks"
  // chip count matches what the columns actually render.
  const filteredTasks = tasks.filter(matchesScope);

  const filters = [
    { id: 'status', label: 'By Status' },
    { id: 'total', label: 'By Total Tasks', count: filteredTasks.length },
    { id: 'due', label: 'Tasks Due' },
    { id: 'agent', label: 'By Agent' },
    { id: 'completed', label: 'Completed' },
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bcc-bg">
      {/* Header */}
      <header className="bg-white h-auto lg:h-20 px-4 lg:px-8 py-3 lg:py-0 flex flex-col lg:flex-row items-start lg:items-center justify-between border-b border-gray-100 shrink-0 gap-3 lg:gap-0">
        <div className="flex items-center gap-3 w-full lg:w-auto">
          <h1 className="text-xl lg:text-2xl font-bold text-gray-900 tracking-tight">Task Board</h1>
          {effectiveDepartment && (
            <>
              <span className="hidden sm:block text-gray-300 mx-1">|</span>
              <div className="flex items-center gap-2 bg-brand-50 text-brand-700 px-2 lg:px-3 py-1 lg:py-1.5 rounded-lg border border-brand-100 ml-auto lg:ml-0">
                <span className="text-base lg:text-lg leading-none">{departmentEmojis[effectiveDepartment] || '📋'}</span>
                <span className="font-semibold text-sm hidden sm:inline">{departmentNames[effectiveDepartment] || effectiveDepartment}</span>
                <button 
                  onClick={() => setSelectedDepartment(null)}
                  className="ml-1 p-0.5 rounded-md hover:bg-brand-100 text-brand-400 hover:text-brand-900 transition-colors"
                  title="Clear filter"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 lg:gap-3 w-full lg:w-auto justify-end">
          <button
            data-walkthrough="new-task"
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 lg:gap-2 px-3 lg:px-5 py-2 lg:py-2.5 rounded-xl bg-brand-600 text-white font-semibold text-sm hover:bg-brand-700 transition-all shadow-md shadow-brand-200"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">New Task</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </header>

      {/* Filter Tabs */}
      <div data-walkthrough="filters" className="bg-white px-4 lg:px-8 py-3 lg:py-3.5 border-b border-gray-100 flex flex-col sm:flex-row items-start sm:items-center justify-between shrink-0 gap-3 sm:gap-0">
        <div className="flex items-center gap-1 lg:gap-2 overflow-x-auto w-full sm:w-auto pb-2 sm:pb-0 -mx-4 sm:mx-0 px-4 sm:px-0">
          {filters.map((filter) => (
            <button
              key={filter.id}
              onClick={() => setActiveFilter(filter.id)}
              className={`px-3 lg:px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-1.5 lg:gap-2 whitespace-nowrap ${
                activeFilter === filter.id
                  ? 'text-gray-900 bg-gray-100 font-semibold'
                  : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              <span className="hidden sm:inline">{filter.label}</span>
              <span className="sm:hidden">{filter.label.replace('By ', '').replace('Tasks ', '')}</span>
              {filter.count !== undefined && (
                <span className="px-1.5 lg:px-2 py-0.5 rounded-full bg-gray-200 text-badge font-bold text-gray-600">
                  {filter.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Kanban Columns */}
      <div className="flex-1 overflow-x-auto overflow-y-auto lg:overflow-y-hidden p-4 lg:p-8">
        <div className="flex flex-col lg:flex-row gap-6 h-full min-w-0 lg:min-w-max pb-4">
          {COLUMNS.map((column) => {
            const columnTasks = getTasksByStatus(column.id);
            return (
              <div
                key={column.id}
                data-walkthrough={`column-${column.id}`}
                className="w-full lg:w-80 flex flex-col gap-4 lg:gap-6"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, column.id)}
              >
                {/* Column Header */}
                <div className="flex items-center justify-between shrink-0">
                  <div className={`flex items-center gap-2 px-3 lg:px-4 py-2 lg:py-2.5 rounded-full text-white shadow-md ${column.gradient}`}>
                    <span className="text-badge font-bold bg-white/20 px-2 py-0.5 rounded-full">
                      {columnTasks.length}
                    </span>
                    <span className="text-sm font-bold">{column.label}</span>
                  </div>
                  <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-white border border-gray-100 text-gray-400 hover:text-gray-900 hover:shadow-sm transition-all">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>

                {/* Tasks */}
                <div className="flex flex-col gap-3 lg:gap-4 overflow-visible lg:overflow-y-auto pr-0 lg:pr-2">
                  {columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onDragStart={handleDragStart}
                      onClick={() => setEditingTask(task)}
                      isDragging={draggedTask?.id === task.id}
                      isCompleted={column.id === 'done'}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Modals */}
      {showCreateModal && (
        <TaskModal onClose={() => setShowCreateModal(false)} workspaceId={workspaceId} />
      )}
      {editingTask && (
        <TaskModal task={editingTask} onClose={() => setEditingTask(null)} workspaceId={workspaceId} />
      )}
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  onDragStart: (e: React.DragEvent, task: Task) => void;
  onClick: () => void;
  isDragging: boolean;
  isCompleted?: boolean;
}

function TaskCard({ task, onDragStart, onClick, isDragging, isCompleted }: TaskCardProps) {
  // Status pill styles
  const statusPillStyles: Record<string, string> = {
    backlog: 'bg-gray-100 text-gray-600',
    inbox: 'bg-gray-100 text-gray-600',
    planning: 'bg-gray-100 text-gray-600',
    assigned: 'bg-gray-100 text-gray-600',
    pending_dispatch: 'bg-gray-100 text-gray-600',
    in_progress: 'bg-blue-100 text-blue-700',
    review: 'bg-amber-100 text-amber-700',
    testing: 'bg-amber-100 text-amber-700',
    blocked: 'bg-red-100 text-red-700',
    done: 'bg-emerald-100 text-emerald-700',
  };

  const statusLabels: Record<string, string> = {
    backlog: 'Backlog',
    inbox: 'New',
    planning: 'Planning',
    assigned: 'Queued',
    pending_dispatch: 'Pending',
    in_progress: 'In Progress',
    review: 'Review',
    testing: 'Testing',
    blocked: 'Blocked',
    done: 'Done',
  };

  // Priority pill styles (for new pill tags)
  const priorityPillStyles: Record<string, string> = {
    critical: 'bg-red-100 text-red-700',
    high: 'bg-amber-100 text-amber-700',
    medium: 'bg-gray-100 text-gray-600',
    low: 'bg-blue-50 text-blue-500',
  };

  const priorityLabels: Record<string, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  };

  // Department emoji mapping
  // Get avatar gradient based on agent or task id
  const getAvatarGradient = (index: number) => {
    const gradients = [
      'avatar-gradient-1',
      'avatar-gradient-2',
      'avatar-gradient-3',
      'avatar-gradient-4',
      'avatar-gradient-5',
    ];
    return gradients[index % gradients.length];
  };

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task)}
      onClick={onClick}
      className={`bg-white rounded-xl lg:rounded-2xl p-4 lg:p-5 card-shadow card-hover cursor-pointer border border-gray-50 w-full ${
        isDragging ? 'opacity-50 scale-95' : ''
      } ${isCompleted ? 'opacity-75' : ''}`}
    >
      {/* Title */}
      <h3 className={`text-base font-semibold text-gray-900 mb-1 leading-snug ${isCompleted ? 'line-through text-gray-400' : ''}`}>
        {task.title}
      </h3>

      {/* Pill Tags Row */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {/* Status Pill */}
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          statusPillStyles[task.status] || 'bg-gray-100 text-gray-600'
        }`}>
          {statusLabels[task.status] || task.status}
        </span>

        {/* Persona Pill — typed fields from Task interface (Hop 10) */}
        {task.persona_name && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-brand-700"
            title={task.persona_mode ? `${task.persona_name} (${task.persona_mode})` : task.persona_name ?? undefined}
          >
            🧠 {task.persona_name}
            {task.persona_mode && task.persona_mode !== 'leadership' && (
              <span className="text-[10px] opacity-70">· {task.persona_mode}</span>
            )}
          </span>
        )}

        {/* Model Pill (v4.0.1 P0-7) — shows the model resolved at dispatch.
            If model_id is null, renders a dimmed "no model" placeholder. */}
        <ModelPill task={task} />


        {/* Priority Pill */}
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          priorityPillStyles[task.priority] || 'bg-gray-100 text-gray-600'
        }`}>
          {priorityLabels[task.priority] || task.priority}
        </span>

        {/* Department Pill */}
        {task.department && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
            {departmentEmojis[task.department.toLowerCase()] || '🏢'} {departmentNames[task.department.toLowerCase()] || task.department}
          </span>
        )}

        {/* Agent Pill */}
        {task.assigned_agent && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-700">
            {(task.assigned_agent as { name: string }).name}
          </span>
        )}

        {/* Skill 35 — Marketing-dept Publish button (no-op for non-marketing) */}
        <MarketingPublishButton task={task} />
      </div>

      {/* Sprint and Due Date */}
      {(task.sprint || task.due_date) && (
        <div className="flex flex-wrap items-center gap-2 mb-3 text-xs text-gray-400">
          {task.sprint && (
            <span className="flex items-center gap-1">
              <span>🏃</span> {task.sprint}
            </span>
          )}
          {task.sprint && task.due_date && (
            <span className="text-gray-300">|</span>
          )}
          {task.due_date && (
            <span className="flex items-center gap-1">
              <span>📅</span> {new Date(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          )}
        </div>
      )}

      {/* Description */}
      {task.description && (
        <p className={`text-sm line-clamp-2 leading-relaxed mb-4 ${isCompleted ? 'text-gray-400' : 'text-gray-500'}`}>
          {task.description}
        </p>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-4 border-t border-gray-50">
        {/* Avatar Stack */}
        <div className="flex -space-x-2">
          {task.assigned_agent ? (
            <>
              <div className={`w-8 h-8 rounded-full border-2 border-white ${getAvatarGradient(0)} flex items-center justify-center text-white text-xs font-bold`}>
                {(task.assigned_agent as { name: string }).name.charAt(0).toUpperCase()}
              </div>
            </>
          ) : ['backlog', 'inbox', 'planning'].includes(task.status) ? (
            <div className="w-8 h-8 rounded-full border-2 border-white bg-gray-200 flex items-center justify-center text-gray-400 text-xs font-bold">?</div>
          ) : (
            <div
              className="w-8 h-8 rounded-full border-2 border-white bg-orange-100 flex items-center justify-center text-orange-600"
              title="This task is in a working state but has no assigned agent"
              aria-label="Unassigned task warning"
            >
              <AlertTriangle className="w-4 h-4" />
            </div>
          )}
        </div>

        {/* Metrics */}
        <div className="flex items-center gap-3 text-gray-400 text-xs font-medium">
          <div className="flex items-center gap-1">
            <Eye className="w-3.5 h-3.5" />
            <span>{formatDistanceToNow(new Date(task.created_at), { addSuffix: false })}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Model pill (v4.0.1 P0-7).
 *
 * Sibling to the 🧠 persona pill. Renders 🤖 plus the model_registry label
 * (falls back to raw model_id, then to a dimmed "no model" placeholder when
 * the task has not been dispatched yet).
 *
 * IMPORTANT (B1): this shows the model the Command Center RESOLVED/INTENDED for
 * the dispatch, NOT a gateway-confirmed runtime model. The OpenClaw gateway
 * (verified against 2026.5.28) selects the agent's own configured model and
 * exposes no per-dispatch model override to the operator client, so the pill is
 * labeled "intended" to stay honest about what actually ran.
 *
 * Click navigates to /settings/intelligence?focus={model_id} so the operator
 * can drill into pricing/capabilities. Hover shows full name, provider, and
 * cost-per-million if those fields are joined in from model_registry.
 */
function ModelPill({ task }: { task: Task }) {
  const stop = (e: React.MouseEvent) => {
    // Don't let the click bubble up to the card click handler (which opens
    // the TaskModal). The pill is its own affordance.
    e.stopPropagation();
  };

  if (!task.model_id) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-400 italic"
        title="No intended model resolved yet. Dispatch the task to pin the model the Command Center will request."
      >
        🤖 no model
      </span>
    );
  }

  const label = task.model_label || task.model_id;

  const tooltipParts: string[] = [];
  tooltipParts.push('Intended model (CC-resolved; gateway runs the agent\'s configured model)');
  tooltipParts.push(task.model_label ? `${task.model_label} (${task.model_id})` : task.model_id);
  if (task.model_provider) tooltipParts.push(`Provider: ${task.model_provider}`);
  if (typeof task.model_input_cost_per_million === 'number') {
    tooltipParts.push(`Input: $${task.model_input_cost_per_million.toFixed(2)} / 1M tok`);
  }
  if (typeof task.model_output_cost_per_million === 'number') {
    tooltipParts.push(`Output: $${task.model_output_cost_per_million.toFixed(2)} / 1M tok`);
  }
  const tooltip = tooltipParts.join('\n');

  return (
    <a
      href={`/settings/intelligence?focus=${encodeURIComponent(task.model_id)}`}
      onClick={stop}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-violet-50 text-violet-700 hover:bg-violet-100 transition-colors no-underline"
      title={tooltip}
    >
      🤖 {label}
    </a>
  );
}
