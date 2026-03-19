'use client';

import { useState, useEffect, useCallback } from 'react';
import { Plus, ChevronRight, ChevronLeft, Zap, ZapOff, Loader2 } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { OpenClawSession } from '@/lib/types';

type FilterTab = 'all' | 'active' | 'idle';
type DepartmentStatus = 'active' | 'idle';

interface Department {
  id: string;
  emoji: string;
  name: string;
  headTitle: string;
  status: DepartmentStatus;
}

const DEPARTMENTS: Department[] = [
  { id: 'exec', emoji: '👔', name: 'Executive', headTitle: 'Chief Executive Officer', status: 'active' },
  { id: 'ops', emoji: '⚙️', name: 'Operations', headTitle: 'Chief Operating Officer', status: 'active' },
  { id: 'marketing', emoji: '📢', name: 'Marketing', headTitle: 'Chief Marketing Officer', status: 'active' },
  { id: 'sales', emoji: '💰', name: 'Sales', headTitle: 'Chief Revenue Officer', status: 'idle' },
  { id: 'product', emoji: '📦', name: 'Product', headTitle: 'Chief Product Officer', status: 'active' },
  { id: 'tech', emoji: '💻', name: 'Technology', headTitle: 'Chief Technology Officer', status: 'active' },
  { id: 'finance', emoji: '💵', name: 'Finance', headTitle: 'Chief Financial Officer', status: 'idle' },
  { id: 'hr', emoji: '👥', name: 'Human Resources', headTitle: 'Chief People Officer', status: 'idle' },
  { id: 'legal', emoji: '⚖️', name: 'Legal', headTitle: 'General Counsel', status: 'idle' },
  { id: 'cs', emoji: '🎧', name: 'Customer Success', headTitle: 'VP Customer Success', status: 'active' },
  { id: 'design', emoji: '🎨', name: 'Design', headTitle: 'Chief Design Officer', status: 'active' },
  { id: 'content', emoji: '✍️', name: 'Content', headTitle: 'Chief Content Officer', status: 'idle' },
  { id: 'data', emoji: '📊', name: 'Data & Analytics', headTitle: 'Chief Data Officer', status: 'idle' },
  { id: 'security', emoji: '🔒', name: 'Security', headTitle: 'Chief Security Officer', status: 'idle' },
  { id: 'bd', emoji: '🤝', name: 'Business Development', headTitle: 'VP Business Development', status: 'idle' },
  { id: 'research', emoji: '🔬', name: 'Research', headTitle: 'Chief Research Officer', status: 'idle' },
  { id: 'facilities', emoji: '🏢', name: 'Facilities', headTitle: 'VP Facilities', status: 'idle' },
];

interface AgentsSidebarProps {
  workspaceId?: string;
}

export function AgentsSidebar({ workspaceId }: AgentsSidebarProps) {
  const { agentOpenClawSessions } = useMissionControl();
  const [filter, setFilter] = useState<FilterTab>('all');
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(null);
  const [activeSubAgents, setActiveSubAgents] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);
  const [departments, setDepartments] = useState<Department[]>(DEPARTMENTS);

  const toggleMinimize = () => setIsMinimized(!isMinimized);

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

      {/* Department List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredDepartments.map((dept) => {
          if (isMinimized) {
            // Minimized view - just emoji
            return (
              <div key={dept.id} className="flex justify-center py-2">
                <div
                  className="relative group"
                  title={`${dept.name} - ${dept.headTitle}`}
                >
                  <span className="text-2xl">{dept.emoji}</span>
                  {/* Status indicator */}
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white ${
                      dept.status === 'active' ? 'bg-emerald-500' : 'bg-gray-400'
                    }`}
                  />
                  {/* Tooltip */}
                  <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 shadow-lg">
                    {dept.name}
                  </div>
                </div>
              </div>
            );
          }

          // Expanded view - full department card
          return (
            <div
              key={dept.id}
              className="w-full rounded-lg hover:bg-gray-50 transition-colors"
            >
              <div className="w-full flex items-center gap-3 p-2.5 text-left">
                {/* Emoji */}
                <div className="text-2xl relative">
                  {dept.emoji}
                  <span
                    className={`absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-white ${
                      dept.status === 'active' ? 'bg-emerald-500' : 'bg-gray-400'
                    }`}
                  />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm text-gray-900 truncate">
                    {dept.name}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {dept.headTitle}
                  </div>
                </div>

                {/* Status */}
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium uppercase ${getStatusBadge(
                    dept.status
                  )}`}
                >
                  {dept.status}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
