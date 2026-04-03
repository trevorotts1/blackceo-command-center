'use client';

import { useMemo, useState } from 'react';
import {
  DragDropContext,
  Draggable,
  Droppable,
  type DraggableProvidedDragHandleProps,
  type DropResult,
} from '@hello-pangea/dnd';
import { Plus, GripVertical, Eye, AlertTriangle, X } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { triggerAutoDispatch, shouldTriggerAutoDispatch } from '@/lib/auto-dispatch';
import type { Task, TaskStatus } from '@/lib/types';
import { TaskModal } from './TaskModal';
import { formatDistanceToNow } from 'date-fns';

interface MissionQueueProps {
  workspaceId?: string;
  departmentFilter?: string | null;
}

type ColumnId = 'backlog' | 'in_progress' | 'review' | 'blocked' | 'done';

const COLUMNS: { id: ColumnId; label: string; gradient: string }[] = [
  { id: 'backlog', label: 'Backlog / To-Do', gradient: 'column-pill-backlog' },
  { id: 'in_progress', label: 'In Progress', gradient: 'column-pill-progress' },
  { id: 'review', label: 'Review / QC', gradient: 'column-pill-review' },
  { id: 'blocked', label: 'Blocked', gradient: 'column-pill-blocked' },
  { id: 'done', label: 'Done', gradient: 'column-pill-done' },
];

const COLUMN_STATUS_MAP: Record<ColumnId, TaskStatus[]> = {
  backlog: ['backlog', 'inbox', 'planning', 'assigned', 'pending_dispatch'],
  in_progress: ['in_progress'],
  review: ['review', 'testing'],
  blocked: ['blocked'],
  done: ['done'],
};

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

function sortTasks(tasks: Task[]) {
  return [...tasks].sort((a, b) => {
    const positionDiff = (a.position ?? 0) - (b.position ?? 0);
    if (positionDiff !== 0) return positionDiff;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

function getColumnId(status: TaskStatus): ColumnId {
  if (COLUMN_STATUS_MAP.backlog.includes(status)) return 'backlog';
  if (COLUMN_STATUS_MAP.review.includes(status)) return 'review';
  if (status === 'blocked') return 'blocked';
  if (status === 'done') return 'done';
  return 'in_progress';
}

function getDropStatus(columnId: ColumnId): TaskStatus {
  switch (columnId) {
    case 'backlog':
      return 'backlog';
    case 'review':
      return 'review';
    case 'blocked':
      return 'blocked';
    case 'done':
      return 'done';
    default:
      return 'in_progress';
  }
}

export function MissionQueue({ workspaceId, departmentFilter }: MissionQueueProps) {
  const {
    tasks,
    setTasks,
    addEvent,
    selectedDepartment,
    setSelectedDepartment,
  } = useMissionControl();

  const effectiveDepartment = departmentFilter !== undefined ? departmentFilter : selectedDepartment;
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [activeFilter, setActiveFilter] = useState('total');
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [isSavingOrder, setIsSavingOrder] = useState(false);

  const filteredTasks = useMemo(() => (
    effectiveDepartment
      ? tasks.filter((task) => task.department === effectiveDepartment)
      : tasks
  ), [effectiveDepartment, tasks]);

  const tasksByColumn = useMemo(() => {
    const grouped: Record<ColumnId, Task[]> = {
      backlog: [],
      in_progress: [],
      review: [],
      blocked: [],
      done: [],
    };

    for (const task of filteredTasks) {
      grouped[getColumnId(task.status)].push(task);
    }

    for (const column of COLUMNS) {
      grouped[column.id] = sortTasks(grouped[column.id]);
    }

    return grouped;
  }, [filteredTasks]);

  const filters = [
    { id: 'status', label: 'By Status' },
    { id: 'total', label: 'By Total Tasks', count: filteredTasks.length },
    { id: 'due', label: 'Tasks Due' },
    { id: 'agent', label: 'By Agent' },
    { id: 'completed', label: 'Completed' },
  ];

  const handleDragEnd = async (result: DropResult) => {
    setDraggingTaskId(null);

    if (!result.destination) return;

    const sourceColumn = result.source.droppableId as ColumnId;
    const destinationColumn = result.destination.droppableId as ColumnId;
    const sourceIndex = result.source.index;
    const destinationIndex = result.destination.index;

    if (sourceColumn === destinationColumn && sourceIndex === destinationIndex) {
      return;
    }

    const previousTasks = tasks;
    const sourceTasks = sortTasks(tasksByColumn[sourceColumn]);
    const destinationTasks = sourceColumn === destinationColumn
      ? sourceTasks
      : sortTasks(tasksByColumn[destinationColumn]);

    const changedTasks = new Map<string, { position: number; status?: TaskStatus }>();
    let movedTask: Task | undefined;
    let previousStatus: TaskStatus | undefined;
    let nextStatus: TaskStatus | undefined;

    if (sourceColumn === destinationColumn) {
      const reordered = [...sourceTasks];
      const [removed] = reordered.splice(sourceIndex, 1);
      if (!removed) return;
      movedTask = removed;
      previousStatus = removed.status;
      nextStatus = removed.status;
      reordered.splice(destinationIndex, 0, removed);

      reordered.forEach((task, index) => {
        changedTasks.set(task.id, { position: index });
      });
    } else {
      const nextSourceTasks = [...sourceTasks];
      const nextDestinationTasks = [...destinationTasks];
      const [removed] = nextSourceTasks.splice(sourceIndex, 1);
      if (!removed) return;

      previousStatus = removed.status;
      nextStatus = getDropStatus(destinationColumn);
      movedTask = { ...removed, status: nextStatus };
      nextDestinationTasks.splice(destinationIndex, 0, movedTask);

      nextSourceTasks.forEach((task, index) => {
        changedTasks.set(task.id, { position: index });
      });

      nextDestinationTasks.forEach((task, index) => {
        changedTasks.set(task.id, {
          position: index,
          status: task.id === movedTask?.id ? nextStatus : task.status,
        });
      });
    }

    if (!movedTask || !previousStatus || !nextStatus) {
      return;
    }

    const optimisticTasks = tasks.map((task) => {
      const update = changedTasks.get(task.id);
      return update ? { ...task, ...update } : task;
    });

    setTasks(optimisticTasks);
    setIsSavingOrder(true);

    try {
      const response = await fetch('/api/tasks', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: Array.from(changedTasks.entries()).map(([id, update]) => ({
            id,
            position: update.position,
            status: update.status,
          })),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to persist task order');
      }

      if (previousStatus !== nextStatus) {
        addEvent({
          id: crypto.randomUUID(),
          type: nextStatus === 'done' ? 'task_completed' : 'task_status_changed',
          task_id: movedTask.id,
          message: `Task "${movedTask.title}" moved to ${nextStatus}`,
          created_at: new Date().toISOString(),
        });

        if (shouldTriggerAutoDispatch(previousStatus, nextStatus, movedTask.assigned_agent_id)) {
          const dispatchResult = await triggerAutoDispatch({
            taskId: movedTask.id,
            taskTitle: movedTask.title,
            agentId: movedTask.assigned_agent_id,
            agentName: movedTask.assigned_agent?.name || 'Unknown Agent',
            workspaceId: movedTask.workspace_id,
          });

          if (!dispatchResult.success) {
            console.error('Auto-dispatch failed:', dispatchResult.error);
          }
        }
      }
    } catch (error) {
      console.error('Failed to reorder tasks:', error);
      setTasks(previousTasks);
    } finally {
      setIsSavingOrder(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bcc-bg">
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
          {isSavingOrder && (
            <span className="text-xs font-medium text-brand-600 animate-pulse">Saving order...</span>
          )}
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 lg:gap-2 px-3 lg:px-5 py-2 lg:py-2.5 rounded-xl bg-brand-600 text-white font-semibold text-sm hover:bg-brand-700 transition-all shadow-md shadow-brand-200"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">New Task</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </header>

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
                <span className="px-1.5 lg:px-2 py-0.5 rounded-full bg-gray-200 text-badge font-bold text-gray-600">
                  {filter.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-auto lg:overflow-y-hidden p-4 lg:p-8">
        <DragDropContext
          onDragStart={(start) => setDraggingTaskId(start.draggableId)}
          onDragEnd={handleDragEnd}
        >
          <div className="flex flex-col lg:flex-row gap-6 h-full min-w-0 lg:min-w-max pb-4">
            {COLUMNS.map((column) => {
              const columnTasks = tasksByColumn[column.id];
              return (
                <div key={column.id} className="w-full lg:w-80 flex flex-col gap-4 lg:gap-6">
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

                  <Droppable droppableId={column.id}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.droppableProps}
                        className={`flex flex-col gap-3 lg:gap-4 overflow-visible lg:overflow-y-auto pr-0 lg:pr-2 min-h-[120px] rounded-2xl transition-all ${
                          snapshot.isDraggingOver ? 'bg-brand-50/70 ring-2 ring-brand-200 p-2 -m-2' : ''
                        }`}
                      >
                        {columnTasks.map((task, index) => (
                          <Draggable key={task.id} draggableId={task.id} index={index}>
                            {(draggableProvided, draggableSnapshot) => (
                              <div
                                ref={draggableProvided.innerRef}
                                {...draggableProvided.draggableProps}
                                style={draggableProvided.draggableProps.style}
                              >
                                <TaskCard
                                  task={task}
                                  onClick={() => setEditingTask(task)}
                                  dragHandleProps={draggableProvided.dragHandleProps}
                                  isDragging={draggableSnapshot.isDragging || draggingTaskId === task.id}
                                  isCompleted={column.id === 'done'}
                                />
                              </div>
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}
                      </div>
                    )}
                  </Droppable>
                </div>
              );
            })}
          </div>
        </DragDropContext>
      </div>

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
  onClick: () => void;
  dragHandleProps?: DraggableProvidedDragHandleProps | null;
  isDragging: boolean;
  isCompleted?: boolean;
}

function TaskCard({ task, onClick, dragHandleProps, isDragging, isCompleted }: TaskCardProps) {
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
      onClick={() => {
        if (!isDragging) onClick();
      }}
      className={`bg-white rounded-xl lg:rounded-2xl p-4 lg:p-5 card-shadow card-hover cursor-pointer border w-full transition-all duration-200 ${
        isDragging
          ? 'border-brand-300 shadow-2xl shadow-brand-100 rotate-[1deg] scale-[1.02] opacity-95'
          : 'border-gray-50'
      } ${isCompleted ? 'opacity-75' : ''}`}
    >
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className={`text-base font-semibold text-gray-900 leading-snug ${isCompleted ? 'line-through text-gray-400' : ''}`}>
          {task.title}
        </h3>
        <div
          {...dragHandleProps}
          onClick={(event) => event.stopPropagation()}
          className="shrink-0 rounded-lg border border-gray-100 bg-gray-50 p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 cursor-grab active:cursor-grabbing"
          title="Drag to reorder"
          aria-label="Drag to reorder task"
        >
          <GripVertical className="w-4 h-4" />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          statusPillStyles[task.status] || 'bg-gray-100 text-gray-600'
        }`}>
          {statusLabels[task.status] || task.status}
        </span>

        {(task as any).persona && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-brand-50 text-brand-700">
            🧠 {(task as any).persona}
          </span>
        )}

        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          priorityPillStyles[task.priority] || 'bg-gray-100 text-gray-600'
        }`}>
          {priorityLabels[task.priority] || task.priority}
        </span>

        {task.department && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
            {departmentEmojis[task.department.toLowerCase()] || '🏢'} {departmentNames[task.department.toLowerCase()] || task.department}
          </span>
        )}

        {task.assigned_agent && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-700">
            {(task.assigned_agent as { name: string }).name}
          </span>
        )}
      </div>

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

      {task.description && (
        <p className={`text-sm line-clamp-2 leading-relaxed mb-4 ${isCompleted ? 'text-gray-400' : 'text-gray-500'}`}>
          {task.description}
        </p>
      )}

      <div className="flex items-center justify-between pt-4 border-t border-gray-50">
        <div className="flex -space-x-2">
          {task.assigned_agent ? (
            <div className={`w-8 h-8 rounded-full border-2 border-white ${getAvatarGradient(0)} flex items-center justify-center text-white text-xs font-bold`}>
              {(task.assigned_agent as { name: string }).name.charAt(0).toUpperCase()}
            </div>
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
