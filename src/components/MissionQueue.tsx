'use client';

import { useState } from 'react';
import { Plus, GripVertical, MessageSquare, Eye } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
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

export function MissionQueue({ workspaceId }: MissionQueueProps) {
  const { tasks, updateTaskStatus, addEvent } = useMissionControl();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [activeFilter, setActiveFilter] = useState('total');

  const getTasksByStatus = (status: TaskStatus) =>
    tasks.filter((task) => task.status === status);

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
      <header className="bg-white h-20 px-8 flex items-center justify-between border-b border-gray-100 shrink-0">
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Task Board</h1>
        <div className="flex items-center gap-3">
          <button className="p-2.5 rounded-xl border border-gray-100 hover:bg-gray-50 text-gray-500 transition-all">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
          <button className="px-5 py-2.5 rounded-xl bg-indigo-50 text-indigo-700 font-semibold text-sm hover:bg-indigo-100 transition-all">
            Share Board
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-bcc-primary text-white font-semibold text-sm hover:bg-bcc-primary-hover transition-all shadow-md shadow-indigo-200"
          >
            <Plus className="w-4 h-4" />
            New Task
          </button>
        </div>
      </header>

      {/* Filter Tabs */}
      <div className="bg-white px-8 py-3.5 border-b border-gray-100 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          {filters.map((filter) => (
            <button
              key={filter.id}
              onClick={() => setActiveFilter(filter.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                activeFilter === filter.id
                  ? 'text-gray-900 bg-gray-100 font-semibold'
                  : 'text-gray-500 hover:bg-gray-50'
              }`}
            >
              {filter.label}
              {filter.count !== undefined && (
                <span className="px-2 py-0.5 rounded-full bg-gray-200 text-[11px] font-bold text-gray-600">
                  {filter.count}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-500 font-medium">
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
      <div className="flex-1 overflow-x-auto p-8">
        <div className="flex gap-6 h-full min-w-max pb-4">
          {COLUMNS.map((column) => {
            const columnTasks = getTasksByStatus(column.id);
            return (
              <div
                key={column.id}
                className="w-80 flex flex-col gap-6"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, column.id)}
              >
                {/* Column Header */}
                <div className="flex items-center justify-between shrink-0">
                  <div className={`flex items-center gap-2 px-4 py-2.5 rounded-full text-white shadow-md ${column.gradient}`}>
                    <span className="text-[11px] font-bold bg-white/20 px-2 py-0.5 rounded-full">
                      {columnTasks.length}
                    </span>
                    <span className="text-sm font-bold">{column.label}</span>
                  </div>
                  <button className="w-8 h-8 flex items-center justify-center rounded-lg bg-white border border-gray-100 text-gray-400 hover:text-gray-900 hover:shadow-sm transition-all">
                    <Plus className="w-4 h-4" />
                  </button>
                </div>

                {/* Tasks */}
                <div className="flex flex-col gap-4 overflow-y-auto pr-2">
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
  // Enhanced priority pill styles with icons
  const priorityConfig: Record<string, { style: string; icon: string; label: string }> = {
    critical: { 
      style: 'bg-gradient-to-r from-red-500 to-rose-500 text-white shadow-red-200', 
      icon: '🔴',
      label: 'Critical'
    },
    high: { 
      style: 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-amber-200', 
      icon: '🟠',
      label: 'High'
    },
    medium: { 
      style: 'bg-gradient-to-r from-blue-500 to-indigo-500 text-white shadow-blue-200', 
      icon: '🔵',
      label: 'Medium'
    },
    low: { 
      style: 'bg-gray-100 text-gray-600 border border-gray-200', 
      icon: '⚪',
      label: 'Low'
    },
  };

  // Department emoji and color mapping
  const departmentConfig: Record<string, { emoji: string; color: string }> = {
    marketing: { emoji: '📢', color: 'bg-pink-100 text-pink-700 border-pink-200' },
    sales: { emoji: '💰', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    engineering: { emoji: '⚙️', color: 'bg-slate-100 text-slate-700 border-slate-200' },
    product: { emoji: '📦', color: 'bg-violet-100 text-violet-700 border-violet-200' },
    design: { emoji: '🎨', color: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200' },
    operations: { emoji: '⚡', color: 'bg-amber-100 text-amber-700 border-amber-200' },
    finance: { emoji: '💵', color: 'bg-green-100 text-green-700 border-green-200' },
    hr: { emoji: '👥', color: 'bg-cyan-100 text-cyan-700 border-cyan-200' },
    legal: { emoji: '⚖️', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
    support: { emoji: '🎧', color: 'bg-teal-100 text-teal-700 border-teal-200' },
    executive: { emoji: '👑', color: 'bg-amber-100 text-amber-800 border-amber-300' },
  };

  // Get avatar gradient based on agent name
  const getAvatarGradient = (name: string) => {
    const gradients = [
      'avatar-gradient-1',
      'avatar-gradient-2',
      'avatar-gradient-3',
      'avatar-gradient-4',
      'avatar-gradient-5',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return gradients[Math.abs(hash) % gradients.length];
  };

  const priority = priorityConfig[task.priority] || priorityConfig.medium;
  const deptKey = task.department?.toLowerCase() || '';
  const dept = departmentConfig[deptKey] || { emoji: '🏢', color: 'bg-gray-100 text-gray-600 border-gray-200' };
  
  // Safe agent name access for demo reliability
  const agentName = task.assigned_agent ? (task.assigned_agent as { name: string }).name : null;
  const agentInitial = agentName ? agentName.charAt(0).toUpperCase() : '?';

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task)}
      onClick={onClick}
      className={`bg-white rounded-2xl p-5 card-shadow card-hover cursor-pointer border border-gray-100 ${
        isDragging ? 'opacity-50 scale-95' : ''
      } ${isCompleted ? 'opacity-70' : ''}`}
    >
      {/* Top row: Priority pill */}
      <div className="flex items-center justify-between mb-3">
        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide shadow-sm ${priority.style}`}>
          <span>{priority.icon}</span>
          {priority.label}
        </span>
        
        {/* Due date indicator */}
        {task.due_date && (
          <span className="text-[11px] text-gray-400 font-medium">
            {new Date(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>

      {/* Title */}
      <h3 className={`text-[15px] font-semibold text-gray-900 mb-3 leading-snug ${isCompleted ? 'line-through text-gray-400' : ''}`}>
        {task.title}
      </h3>

      {/* Pill Tags Row - Department and Agent */}
      <div className="flex flex-wrap gap-2 mb-4">
        {/* Department Pill */}
        {task.department && (
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border ${dept.color}`}>
            <span>{dept.emoji}</span>
            <span className="capitalize">{task.department}</span>
          </span>
        )}

        {/* Agent Pill */}
        {agentName ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-teal-50 text-teal-700 border border-teal-200">
            <span className="w-4 h-4 rounded-full bg-teal-500 text-white text-[8px] flex items-center justify-center font-bold">
              {agentInitial}
            </span>
            <span className="max-w-[80px] truncate">{agentName}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-gray-50 text-gray-400 border border-gray-200">
            <span className="w-4 h-4 rounded-full bg-gray-300 text-white text-[8px] flex items-center justify-center font-bold">?</span>
            Unassigned
          </span>
        )}
      </div>

      {/* Sprint badge */}
      {task.sprint && (
        <div className="mb-3">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-purple-50 text-purple-600 border border-purple-100">
            <span>🏃</span> {task.sprint}
          </span>
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
        {/* Avatar */}
        <div className="flex items-center gap-2">
          {agentName ? (
            <div className={`w-7 h-7 rounded-full ${getAvatarGradient(agentName)} flex items-center justify-center text-white text-xs font-bold shadow-sm`}>
              {agentInitial}
            </div>
          ) : (
            <div className="w-7 h-7 rounded-full bg-gray-100 border-2 border-dashed border-gray-300 flex items-center justify-center">
              <span className="text-gray-300 text-xs">?</span>
            </div>
          )}
        </div>

        {/* Metrics */}
        <div className="flex items-center gap-3 text-gray-400 text-xs font-medium">
          <div className="flex items-center gap-1 hover:text-gray-600 transition-colors">
            <MessageSquare className="w-3.5 h-3.5" />
            <span>{Math.floor(Math.random() * 20)}</span>
          </div>
          <div className="flex items-center gap-1 hover:text-gray-600 transition-colors" title={new Date(task.created_at).toLocaleString()}>
            <Eye className="w-3.5 h-3.5" />
            <span>{formatDistanceToNow(new Date(task.created_at), { addSuffix: false })}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
