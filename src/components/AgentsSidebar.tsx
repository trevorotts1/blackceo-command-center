'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, ChevronRight, ChevronLeft, Zap, ZapOff, Loader2, BarChart3, Sparkles } from 'lucide-react';
import { useMissionControl } from '@/lib/store';

type FilterTab = 'all' | 'active' | 'idle';
type DepartmentStatus = 'active' | 'idle';

interface Department {
  id: string;
  emoji: string;
  name: string;
  headTitle: string;
  status: DepartmentStatus;
}

interface AgentsSidebarProps {
  workspaceId?: string;
  isOpen?: boolean;
  onClose?: () => void;
}

export function AgentsSidebar({ workspaceId, isOpen = false, onClose }: AgentsSidebarProps) {
  const { agentOpenClawSessions, selectedDepartment, setSelectedDepartment } = useMissionControl();
  const [filter, setFilter] = useState<FilterTab>('all');
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(null);
  const [activeSubAgents, setActiveSubAgents] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);

  const toggleMinimize = () => setIsMinimized(!isMinimized);

  // Load departments dynamically from the workspaces database
  useEffect(() => {
    const loadDepartments = async () => {
      try {
        const res = await fetch('/api/workspaces');
        if (res.ok) {
          const workspaces = await res.json();
          if (Array.isArray(workspaces)) {
            setDepartments(
              workspaces.map((ws: { id: string; name: string; icon?: string; slug: string }) => ({
                id: ws.slug || ws.id,
                emoji: ws.icon || '📁',
                name: ws.name,
                headTitle: ws.name,
                status: 'active' as DepartmentStatus,
              }))
            );
          }
        }
      } catch {
        // Fall back silently to empty list
      }
    };

    loadDepartments();
  }, []);

  // Load active sub-agent count
  useEffect(() => {
    const loadSubAgentCount = async () => {
      try {
        const res = await fetch('/api/openclaw/sessions?session_type=subagent&status=active');
        if (res.ok) {
          const sessions = await res.json();
          setActiveSubAgents(sessions.length);
        }
      } catch (error) {
        console.error('Failed to load sub-agent count:', error);
      }
    };

    loadSubAgentCount();

    // Poll every 30 seconds
    const interval = setInterval(loadSubAgentCount, 30000);
    return () => clearInterval(interval);
  }, []);

  const filteredDepartments = departments.filter((dept) => {
    if (filter === 'all') return true;
    return dept.status === filter;
  });

  const getStatusBadge = (status: DepartmentStatus) => {
    const styles = {
      active: 'status-active',
      idle: 'status-idle',
    };
    return styles[status] || 'status-idle';
  };

  return (
    <aside
      className={`bg-white border-r border-gray-200 flex flex-col transition-all duration-300 ease-in-out ${
        isMinimized ? 'w-12' : 'w-72'
      }`}
    >
      {/* Header */}
      <div className="p-3 border-b border-gray-100">
        <div className="flex items-center">
          <button
            onClick={toggleMinimize}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
            aria-label={isMinimized ? 'Expand departments' : 'Minimize departments'}
          >
            {isMinimized ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>
          {!isMinimized && (
            <>
              <span className="text-sm font-semibold text-gray-900 ml-1">Departments</span>
              <span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full ml-2 font-medium">
                {departments.length}
              </span>
            </>
          )}
        </div>

        {!isMinimized && (
          <>
            {/* Active Sub-Agents Counter */}
            {activeSubAgents > 0 && (
              <div className="mb-3 mt-3 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-emerald-500">●</span>
                  <span className="text-gray-700">Active Sub-Agents:</span>
                  <span className="font-semibold text-emerald-600">{activeSubAgents}</span>
                </div>
              </div>
            )}

            {/* Filter Tabs */}
            <div className="flex gap-1 mt-3">
              {(['all', 'active', 'idle'] as FilterTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setFilter(tab)}
                  className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                    filter === tab
                      ? 'bg-indigo-600 text-white'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`}
                >
                  {tab.toUpperCase()}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Performance Board Button — distinctly different from department tabs */}
      {!isMinimized && (
        <div className="px-3 pt-3 pb-1">
          <button
            onClick={() => window.location.href = '/ceo-board'}
            className="group w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-gradient-to-r from-indigo-500 via-violet-500 to-purple-600 text-white shadow-md hover:shadow-xl hover:shadow-indigo-200/50 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] relative overflow-hidden"
          >
            {/* Animated shimmer effect */}
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />

            {/* Pulse dot */}
            <div className="relative flex-shrink-0">
              <BarChart3 className="w-5 h-5" />
              <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            </div>

            {/* Text */}
            <div className="flex-1 text-left">
              <div className="font-bold text-sm flex items-center gap-1.5">
                Performance Board
                <Sparkles className="w-3.5 h-3.5 text-amber-300 animate-pulse" />
              </div>
              <div className="text-[10px] text-white/70 mt-0.5">CEO Dashboard &bull; Analytics</div>
            </div>

            {/* Arrow */}
            <ChevronRight className="w-4 h-4 text-white/60 group-hover:text-white group-hover:translate-x-0.5 transition-all duration-200" />
          </button>
        </div>
      )}

      {/* Minimized Performance Board — just icon */}
      {isMinimized && (
        <div className="px-2 pt-3">
          <button
            onClick={() => window.location.href = '/ceo-board'}
            className="w-full flex justify-center py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 hover:shadow-md transition-all duration-200"
            title="Performance Board"
          >
            <div className="relative">
              <BarChart3 className="w-5 h-5 text-white" />
              <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            </div>
          </button>
        </div>
      )}

      {/* Department List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {/* All Departments Option */}
        {!isMinimized && (
          <button
            onClick={() => setSelectedDepartment(null)}
            className={`w-full rounded-lg transition-colors text-left ${
              selectedDepartment === null
                ? 'bg-indigo-50 border border-indigo-200 ring-1 ring-indigo-200'
                : 'hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center gap-3 p-2.5">
              <div className="text-2xl">🏢</div>
              <div className="flex-1 min-w-0">
                <div className={`font-medium text-sm truncate ${
                  selectedDepartment === null ? 'text-indigo-900' : 'text-gray-900'
                }`}>
                  All Departments
                </div>
                <div className={`text-xs truncate ${
                  selectedDepartment === null ? 'text-indigo-600' : 'text-gray-500'
                }`}>
                  View all tasks
                </div>
              </div>
              {selectedDepartment === null && (
                <span className="w-2 h-2 rounded-full bg-indigo-500" />
              )}
            </div>
          </button>
        )}

        {/* Divider */}
        {!isMinimized && <div className="border-t border-gray-100 my-2" />}

        {filteredDepartments.map((dept) => {
          const isSelected = selectedDepartment === dept.id;

          if (isMinimized) {
            // Minimized view - just emoji
            return (
              <button
                key={dept.id}
                onClick={() => setSelectedDepartment(dept.id)}
                className={`flex justify-center py-2 w-full ${
                  isSelected ? 'bg-indigo-50 rounded-lg' : ''
                }`}
              >
                <div
                  className="relative group"
                  title={`${dept.name} - ${dept.headTitle}`}
                >
                  <span className="text-2xl">{dept.emoji}</span>
                  {/* Status indicator */}
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white ${
                      isSelected ? 'bg-indigo-500' : dept.status === 'active' ? 'bg-emerald-500' : 'bg-gray-400'
                    }`}
                  />
                  {/* Tooltip */}
                  <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 shadow-lg">
                    {dept.name}
                  </div>
                </div>
              </button>
            );
          }

          // Expanded view - full department card
          return (
            <button
              key={dept.id}
              onClick={() => setSelectedDepartment(dept.id)}
              className={`w-full rounded-lg transition-colors text-left ${
                isSelected
                  ? 'bg-indigo-50 border border-indigo-200 ring-1 ring-indigo-200'
                  : 'hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-3 p-2.5">
                {/* Emoji */}
                <div className="text-2xl relative">
                  {dept.emoji}
                  <span
                    className={`absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-white ${
                      isSelected ? 'bg-indigo-500' : dept.status === 'active' ? 'bg-emerald-500' : 'bg-gray-400'
                    }`}
                  />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className={`font-medium text-sm truncate ${
                    isSelected ? 'text-indigo-900' : 'text-gray-900'
                  }`}>
                    {dept.name}
                  </div>
                  <div className={`text-xs truncate ${
                    isSelected ? 'text-indigo-600' : 'text-gray-500'
                  }`}>
                    {dept.headTitle}
                  </div>
                </div>

                {/* Status or Selected indicator */}
                {isSelected ? (
                  <span className="w-2 h-2 rounded-full bg-indigo-500" />
                ) : (
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium uppercase ${getStatusBadge(
                      dept.status
                    )}`}
                  >
                    {dept.status}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
