'use client';

import { useState } from 'react';
import { Plus, GripVertical, MessageSquare, Eye } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { X } from 'lucide-react';
import { triggerAutoDispatch, shouldTriggerAutoDispatch } from '@/lib/auto-dispatch';
import type { Task, TaskStatus } from '@/lib/types';
import { TaskModal } from './TaskModal';
import { formatDistanceToNow } from 'date-fns';

interface MissionQueueProps {
  workspaceId?: string;
}

const COLUMNS: { id: TaskStatus; label: string; gradient: string }[] = [
  { id: 'backlog', label: 'Backlog / To-Do', gradient: 'column-pill-backlog' },
  { id: 'in_progress', label: 'In Progress', gradient: 'column-pill-progress' },
  { id: 'review', label: 'Review / QC', gradient: 'column-pill-review' },
  { id: 'blocked', label: 'Blocked', gradient: 'column-pill-blocked' },
  { id: 'done', label: 'Done', gradient: 'column-pill-done' },
];

const departmentEmojis: Record<string, string> = {
  'ceo-com': '👔', 'ceo': '👔',
  'marketing': '📢',
  'sales': '💰',
  'billing': '💳',
  'customer-support': '🎧', 'support': '🎧',
  'operations': '⚙️',
  'creative': '✍️',
  'hr-people': '👥', 'hr': '👥',
  'legal-compliance': '⚖️', 'legal': '⚖️',
  'it-tech': '🖥️', 'it': '🖥️',
  'web-development': '🌐', 'webdev': '🌐',
  'app-development': '📱', 'appdev': '📱',
  'graphics': '🎨',
  'video-production': '🎬', 'video': '🎬',
  'audio-production': '🎙️', 'audio': '🎙️',
  'research': '🔬',
  'communications': '📣', 'comms': '📣',
};

const departmentNames: Record<string, string> = {
  'ceo-com': 'CEO / COM',
  'marketing': 'Marketing',
  'sales': 'Sales',
  'billing': 'Billing',
  'customer-support': 'Customer Support',
  'operations': 'Operations',
  'creative': 'Creative',
  'hr-people': 'HR / People',
  'legal-compliance': 'Legal / Compliance',
  'it-tech': 'IT / Tech',
  'web-development': 'Web Development',
  'app-development': 'App Development',
  'graphics': 'Graphics',
  'video-production': 'Video Production',
  'audio-production': 'Audio Production',
  'research': 'Research',
  'communications': 'Communications',
};

export function MissionQueue({ workspaceId }: MissionQueueProps) {
  const { tasks, updateTaskStatus, addEvent, selectedDepartment, setSelectedDepartment } = useMissionControl();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [activeFilter, setActiveFilter] = useState('total');

  const getTasksByStatus = (statusId: string) => {
    const filteredByDept = selectedDepartment
      ? tasks.filter((task) => task.department === selectedDepartment)
      : tasks;
    return filteredByDept.filter((task) => {
      if (statusId === 'backlog') {
        return ['backlog', 'inbox', 'planning', 'assigned', 'pending_dispatch'].includes(task.status);
      }
      if (statusId === 'review') {
        return ['review', 'testing'].includes(task.status);
      }
      return task.status === statusId;
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

  const handleDrop = async (e: React.DragEvent, targetStatus: TaskStatus) => {
    e.preventDefault();
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
      }
    } catch (error) {
      console.error('Failed to update task status:', error);
      updateTaskStatus(draggedTask.id, draggedTask.status);
    }

    setDraggedTask(null);
  };

  const filters = [
    { id: 'status', label: 'By Status' },
    { id: 'total', label: 'By Total Tasks', count: tasks.length },
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
          {selectedDepartment && (
            <>
              <span className="hidden sm:block text-gray-300 mx-1">|</span>
              <div className="flex items-center gap-2 bg-indigo-50 text-indigo-700 px-2 lg:px-3 py-1 lg:py-1.5 rounded-lg border border-indigo-100 ml-auto lg:ml-0">
                <span className="text-base lg:text-lg leading-none">{departmentEmojis[selectedDepartment] || '📋'}</span>
                <span className="font-semibold text-sm hidden sm:inline">{departmentNames[selectedDepartment] || selectedDepartment}</span>
                <button 
                  onClick={() => setSelectedDepartment(null)}
                  className="ml-1 p-0.5 rounded-md hover:bg-indigo-100 text-indigo-400 hover:text-indigo-900 transition-colors"
                  title="Clear filter"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 lg:gap-3 w-full lg:w-auto justify-end">
          <button className="p-2 lg:p-2.5 rounded-xl border border-gray-100 hover:bg-gray-50 text-gray-500 transition-all">
            <svg className="w-4 lg:w-5 h-4 lg:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
          <button className="hidden sm:block px-4 lg:px-5 py-2 lg:py-2.5 rounded-xl bg-indigo-50 text-indigo-700 font-semibold text-sm hover:bg-indigo-100 transition-all">
            Share Board
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 lg:gap-2 px-3 lg:px-5 py-2 lg:py-2.5 rounded-xl bg-bcc-primary text-white font-semibold text-sm hover:bg-bcc-primary-hover transition-all shadow-md shadow-indigo-200"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">New Task</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </header>

      {/* Filter Tabs */}
      <div className="bg-white px-4 lg:px-8 py-3 lg:py-3.5 border-b border-gray-100 flex flex-col sm:flex-row items-start sm:items-center justify-between shrink-0 gap-3 sm:gap-0">
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
                <span className="px-1.5 lg:px-2 py-0.5 rounded-full bg-gray-200 text-[10px] lg:text-[11px] font-bold text-gray-600">
                  {filter.count}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="hidden sm:flex items-center gap-2 text-sm text-gray-500 font-medium">
          <span className="opacity-60">Sort By:</span>
          <button className="flex items-center gap-1.5 text-gray-900 font-semibold">
            Newest
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
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
                className="w-full lg:w-80 flex flex-col gap-4 lg:gap-6"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, column.id)}
              >
                {/* Column Header */}
                <div className="flex items-center justify-between shrink-0">
                  <div className={`flex items-center gap-2 px-3 lg:px-4 py-2 lg:py-2.5 rounded-full text-white shadow-md ${column.gradient}`}>
                    <span className="text-[11px] font-bold bg-white/20 px-2 py-0.5 rounded-full">
                      {columnTasks.length}
                    </span>
                    <span className="text-xs lg:text-sm font-bold">{column.label}</span>
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
    inbox: 'Inbox',
    planning: 'Planning',
    assigned: 'Assigned',
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
      <h3 className={`text-[15px] font-semibold text-gray-900 mb-1 leading-snug ${isCompleted ? 'line-through text-gray-400' : ''}`}>
        {task.title}
      </h3>

      {/* Description */}
      {task.description && (
        <p className="text-xs text-gray-500 mb-3 leading-relaxed">
          {task.description}
        </p>
      )}

      {/* Pill Tags Row */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {/* Status Pill */}
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          statusPillStyles[task.status] || 'bg-gray-100 text-gray-600'
        }`}>
          {statusLabels[task.status] || task.status}
        </span>

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

        {/* Persona Pill */}
        {(task as any).persona && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">
            🧠 {(task as any).persona}
          </span>
        )}
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
        <p className={`text-[13px] line-clamp-2 leading-relaxed mb-4 ${isCompleted ? 'text-gray-400' : 'text-gray-500'}`}>
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
          ) : (
            <div className={`w-8 h-8 rounded-full border-2 border-white ${getAvatarGradient(1)}`} />
          )}
        </div>

        {/* Metrics */}
        <div className="flex items-center gap-3 text-gray-400 text-xs font-medium">
          <div className="flex items-center gap-1">
            <MessageSquare className="w-3.5 h-3.5" />
            <span>{Math.floor(Math.random() * 50)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Eye className="w-3.5 h-3.5" />
            <span>{formatDistanceToNow(new Date(task.created_at), { addSuffix: false })}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
