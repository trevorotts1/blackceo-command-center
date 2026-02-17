# Components - BlackCEO Command Center

## AgentsSidebar
**File:** `src/components/AgentsSidebar.tsx`
**Description:** Left sidebar showing list of agents with filter tabs and status indicators.

```tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, ChevronRight, ChevronLeft, Zap, ZapOff, Loader2 } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Agent, AgentStatus, OpenClawSession } from '@/lib/types';
import { AgentModal } from './AgentModal';

type FilterTab = 'all' | 'working' | 'standby';

interface AgentsSidebarProps {
  workspaceId?: string;
}

export function AgentsSidebar({ workspaceId }: AgentsSidebarProps) {
  const { agents, selectedAgent, setSelectedAgent, agentOpenClawSessions, setAgentOpenClawSession } = useMissionControl();
  const [filter, setFilter] = useState<FilterTab>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(null);
  const [activeSubAgents, setActiveSubAgents] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);

  const toggleMinimize = () => setIsMinimized(!isMinimized);

  const filteredAgents = agents.filter((agent) => {
    if (filter === 'all') return true;
    return agent.status === filter;
  });

  const getStatusBadge = (status: AgentStatus) => {
    const styles = {
      standby: 'status-standby',
      working: 'status-working',
      offline: 'status-offline',
    };
    return styles[status] || styles.standby;
  };

  return (
    <aside
      className={`bg-mc-bg-secondary border-r border-mc-border flex flex-col transition-all duration-300 ease-in-out ${
        isMinimized ? 'w-12' : 'w-64'
      }`}
    >
      {/* Header */}
      <div className="p-3 border-b border-mc-border">
        <div className="flex items-center">
          <button
            onClick={toggleMinimize}
            className="p-1 rounded hover:bg-mc-bg-tertiary text-mc-text-secondary hover:text-mc-text transition-colors"
          >
            {isMinimized ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
          {!isMinimized && (
            <>
              <span className="text-sm font-medium uppercase tracking-wider">Agents</span>
              <span className="bg-mc-bg-tertiary text-mc-text-secondary text-xs px-2 py-0.5 rounded ml-2">
                {agents.length}
              </span>
            </>
          )}
        </div>

        {!isMinimized && (
          <>
            {activeSubAgents > 0 && (
              <div className="mb-3 mt-3 px-3 py-2 bg-green-500/10 border border-green-500/20 rounded-lg">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-green-400">●</span>
                  <span className="text-mc-text">Active Sub-Agents:</span>
                  <span className="font-bold text-green-400">{activeSubAgents}</span>
                </div>
              </div>
            )}

            {/* Filter Tabs */}
            <div className="flex gap-1">
              {(['all', 'working', 'standby'] as FilterTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setFilter(tab)}
                  className={`px-3 py-1 text-xs rounded uppercase ${
                    filter === tab
                      ? 'bg-mc-accent text-mc-bg font-medium'
                      : 'text-mc-text-secondary hover:bg-mc-bg-tertiary'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Agent List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredAgents.map((agent) => {
          const openclawSession = agentOpenClawSessions[agent.id];

          return (
            <div
              key={agent.id}
              className={`w-full rounded hover:bg-mc-bg-tertiary transition-colors ${
                selectedAgent?.id === agent.id ? 'bg-mc-bg-tertiary' : ''
              }`}
            >
              <button
                onClick={() => {
                  setSelectedAgent(agent);
                  setEditingAgent(agent);
                }}
                className="w-full flex items-center gap-3 p-2 text-left"
              >
                <div className="text-2xl relative">
                  {agent.avatar_emoji}
                  {openclawSession && (
                    <span className="absolute -bottom-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-mc-bg-secondary" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{agent.name}</span>
                    {!!agent.is_master && <span className="text-xs text-mc-accent-yellow">★</span>}
                  </div>
                  <div className="text-xs text-mc-text-secondary truncate">{agent.role}</div>
                </div>

                <span className={`text-xs px-2 py-0.5 rounded uppercase ${getStatusBadge(agent.status)}`}>
                  {agent.status}
                </span>
              </button>

              {!!agent.is_master && (
                <div className="px-2 pb-2">
                  <button
                    className={`w-full flex items-center justify-center gap-2 px-2 py-1 rounded text-xs transition-colors ${
                      openclawSession
                        ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                        : 'bg-mc-bg text-mc-text-secondary hover:bg-mc-bg-tertiary hover:text-mc-text'
                    }`}
                  >
                    {openclawSession ? (
                      <>
                        <Zap className="w-3 h-3" />
                        <span>Command Center Connected</span>
                      </>
                    ) : (
                      <>
                        <ZapOff className="w-3 h-3" />
                        <span>Connect to Command Center</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add Agent Button */}
      {!isMinimized && (
        <div className="p-3 border-t border-mc-border">
          <button
            onClick={() => setShowCreateModal(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-mc-bg-tertiary hover:bg-mc-border rounded text-sm text-mc-text-secondary hover:text-mc-text transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Agent
          </button>
        </div>
      )}
    </aside>
  );
}
```

## LiveFeed
**File:** `src/components/LiveFeed.tsx`
**Description:** Right sidebar showing real-time event stream.

```tsx
'use client';

import { useState } from 'react';
import { ChevronRight, ChevronLeft, Clock } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Event } from '@/lib/types';
import { formatDistanceToNow } from 'date-fns';

type FeedFilter = 'all' | 'tasks' | 'agents';

export function LiveFeed() {
  const { events } = useMissionControl();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [isMinimized, setIsMinimized] = useState(false);

  const toggleMinimize = () => setIsMinimized(!isMinimized);

  const getEventIcon = (type: string) => {
    switch (type) {
      case 'task_created': return '📋';
      case 'task_assigned': return '👤';
      case 'task_status_changed': return '🔄';
      case 'task_completed': return '✅';
      case 'message_sent': return '💬';
      case 'agent_joined': return '🎉';
      case 'agent_status_changed': return '🔔';
      case 'system': return '⚙️';
      default: return '📌';
    }
  };

  return (
    <aside
      className={`bg-mc-bg-secondary border-l border-mc-border flex flex-col transition-all duration-300 ease-in-out ${
        isMinimized ? 'w-12' : 'w-80'
      }`}
    >
      <div className="p-3 border-b border-mc-border">
        <div className="flex items-center">
          <button
            onClick={toggleMinimize}
            className="p-1 rounded hover:bg-mc-bg-tertiary text-mc-text-secondary hover:text-mc-text transition-colors"
          >
            {isMinimized ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          {!isMinimized && (
            <span className="text-sm font-medium uppercase tracking-wider">Live Feed</span>
          )}
        </div>

        {!isMinimized && (
          <div className="flex gap-1 mt-3">
            {(['all', 'tasks', 'agents'] as FeedFilter[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`px-3 py-1 text-xs rounded uppercase ${
                  filter === tab
                    ? 'bg-mc-accent text-mc-bg font-medium'
                    : 'text-mc-text-secondary hover:bg-mc-bg-tertiary'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        )}
      </div>

      {!isMinimized && (
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {events.length === 0 ? (
            <div className="text-center py-8 text-mc-text-secondary text-sm">No events yet</div>
          ) : (
            events.map((event) => (
              <div key={event.id} className="p-2 rounded border-l-2 animate-slide-in bg-transparent border-transparent hover:bg-mc-bg-tertiary">
                <div className="flex items-start gap-2">
                  <span className="text-sm">{getEventIcon(event.type)}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-mc-text">{event.message}</p>
                    <div className="flex items-center gap-1 mt-1 text-xs text-mc-text-secondary">
                      <Clock className="w-3 h-3" />
                      {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </aside>
  );
}
```

## MissionQueue
**File:** `src/components/MissionQueue.tsx`
**Description:** Kanban board with columns for task statuses, draggable task cards.

```tsx
'use client';

import { useState } from 'react';
import { Plus, ChevronRight, GripVertical } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Task, TaskStatus } from '@/lib/types';
import { TaskModal } from './TaskModal';
import { formatDistanceToNow } from 'date-fns';

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: 'planning', label: '📋 PLANNING', color: 'border-t-mc-accent-purple' },
  { id: 'inbox', label: 'INBOX', color: 'border-t-mc-accent-pink' },
  { id: 'assigned', label: 'ASSIGNED', color: 'border-t-mc-accent-yellow' },
  { id: 'in_progress', label: 'IN PROGRESS', color: 'border-t-mc-accent' },
  { id: 'testing', label: 'TESTING', color: 'border-t-mc-accent-cyan' },
  { id: 'review', label: 'REVIEW', color: 'border-t-mc-accent-purple' },
  { id: 'done', label: 'DONE', color: 'border-t-mc-accent-green' },
];

export function MissionQueue({ workspaceId }: { workspaceId?: string }) {
  const { tasks } = useMissionControl();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);

  const getTasksByStatus = (status: TaskStatus) => tasks.filter((task) => task.status === status);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-3 border-b border-mc-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ChevronRight className="w-4 h-4 text-mc-text-secondary" />
          <span className="text-sm font-medium uppercase tracking-wider">Mission Queue</span>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-mc-accent-pink text-mc-bg rounded text-sm font-medium hover:bg-mc-accent-pink/90"
        >
          <Plus className="w-4 h-4" />
          New Task
        </button>
      </div>

      {/* Kanban Columns */}
      <div className="flex-1 flex gap-3 p-3 overflow-x-auto">
        {COLUMNS.map((column) => {
          const columnTasks = getTasksByStatus(column.id);
          return (
            <div
              key={column.id}
              className={`flex-1 min-w-[220px] max-w-[300px] flex flex-col bg-mc-bg rounded-lg border border-mc-border/50 border-t-2 ${column.color}`}
            >
              <div className="p-2 border-b border-mc-border flex items-center justify-between">
                <span className="text-xs font-medium uppercase text-mc-text-secondary">{column.label}</span>
                <span className="text-xs bg-mc-bg-tertiary px-2 py-0.5 rounded text-mc-text-secondary">
                  {columnTasks.length}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-2">
                {columnTasks.map((task) => (
                  <TaskCard key={task.id} task={task} onClick={() => setEditingTask(task)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const priorityStyles = {
    low: 'text-mc-text-secondary',
    normal: 'text-mc-accent',
    high: 'text-mc-accent-yellow',
    urgent: 'text-mc-accent-red',
  };

  const priorityDots = {
    low: 'bg-mc-text-secondary/40',
    normal: 'bg-mc-accent',
    high: 'bg-mc-accent-yellow',
    urgent: 'bg-mc-accent-red',
  };

  return (
    <div
      onClick={onClick}
      className="group bg-mc-bg-secondary border border-mc-border/50 rounded-lg cursor-pointer transition-all hover:shadow-lg hover:shadow-black/20 hover:border-mc-accent/40"
    >
      <div className="flex items-center justify-center py-1.5 border-b border-mc-border/30 opacity-0 group-hover:opacity-100 transition-opacity">
        <GripVertical className="w-4 h-4 text-mc-text-secondary/50 cursor-grab" />
      </div>
      <div className="p-4">
        <h4 className="text-sm font-medium leading-snug line-clamp-2 mb-3">{task.title}</h4>
        
        {task.assigned_agent && (
          <div className="flex items-center gap-2 mb-3 py-1.5 px-2 bg-mc-bg-tertiary/50 rounded">
            <span className="text-base">{(task.assigned_agent as any).avatar_emoji}</span>
            <span className="text-xs text-mc-text-secondary truncate">{(task.assigned_agent as any).name}</span>
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-mc-border/20">
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${priorityDots[task.priority]}`} />
            <span className={`text-xs capitalize ${priorityStyles[task.priority]}`}>{task.priority}</span>
          </div>
          <span className="text-[10px] text-mc-text-secondary/60">
            {formatDistanceToNow(new Date(task.created_at), { addSuffix: true })}
          </span>
        </div>
      </div>
    </div>
  );
}
```

## WorkspaceDashboard
**File:** `src/components/WorkspaceDashboard.tsx`
**Description:** Workspace selection screen with workspace cards grid.

```tsx
'use client';

import { useState, useEffect } from 'react';
import { Plus, ArrowRight, Folder, Users, CheckSquare, Trash2 } from 'lucide-react';
import Link from 'next/link';
import type { WorkspaceStats } from '@/lib/types';

export function WorkspaceDashboard() {
  const [workspaces, setWorkspaces] = useState<WorkspaceStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen bg-mc-bg flex items-center justify-center">
        <div className="text-center">
          <img 
            src="https://storage.googleapis.com/msgsndr/Mct54Bwi1KlNouGXQcDX/media/bbda8c9f-425b-45cd-a081-797689289593.png" 
            alt="Loading" 
            className="h-12 w-auto mb-4 animate-pulse"
          />
          <p className="text-mc-text-secondary">Loading workspaces...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-mc-bg">
      {/* Header */}
      <header className="border-b border-mc-border bg-mc-bg-secondary">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img 
                src="https://storage.googleapis.com/msgsndr/Mct54Bwi1KlNouGXQcDX/media/bbda8c9f-425b-45cd-a081-797689289593.png" 
                alt="BlackCEO Command Center" 
                className="h-10 w-auto"
              />
            </div>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-2 px-4 py-2 bg-mc-accent text-mc-bg rounded-lg font-medium hover:bg-mc-accent/90"
            >
              <Plus className="w-4 h-4" />
              New Workspace
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h2 className="text-2xl font-bold mb-2">All Workspaces</h2>
          <p className="text-mc-text-secondary">Select a workspace to view its mission queue and agents</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {workspaces.map((workspace) => (
            <Link key={workspace.id} href={`/workspace/${workspace.slug}`}>
              <div className="bg-mc-bg-secondary border border-mc-border rounded-xl p-6 hover:border-mc-accent/50 transition-all hover:shadow-lg cursor-pointer group">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{workspace.icon}</span>
                    <div>
                      <h3 className="font-semibold text-lg group-hover:text-mc-accent transition-colors">
                        {workspace.name}
                      </h3>
                      <p className="text-sm text-mc-text-secondary">/{workspace.slug}</p>
                    </div>
                  </div>
                  <ArrowRight className="w-5 h-5 text-mc-text-secondary group-hover:text-mc-accent transition-colors" />
                </div>
                <div className="flex items-center gap-4 text-sm text-mc-text-secondary mt-4">
                  <div className="flex items-center gap-1">
                    <CheckSquare className="w-4 h-4" />
                    <span>{workspace.taskCounts.total} tasks</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Users className="w-4 h-4" />
                    <span>{workspace.agentCount} agents</span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
          
          {/* Add workspace card */}
          <button
            onClick={() => setShowCreateModal(true)}
            className="border-2 border-dashed border-mc-border rounded-xl p-6 hover:border-mc-accent/50 transition-colors flex flex-col items-center justify-center gap-3 min-h-[200px]"
          >
            <div className="w-12 h-12 rounded-full bg-mc-bg-tertiary flex items-center justify-center">
              <Plus className="w-6 h-6 text-mc-text-secondary" />
            </div>
            <span className="text-mc-text-secondary font-medium">Add Workspace</span>
          </button>
        </div>
      </main>
    </div>
  );
}
```
