'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, ChevronRight, ChevronLeft, Zap, ZapOff, Loader2, ArrowLeft } from 'lucide-react';
import { useMissionControl } from '@/lib/store';

type FilterTab = 'all' | 'active' | 'idle';
/**
 * PRD Section 3.13: agent status states must include busy and degraded in
 * addition to standby, working, and offline. We aggregate the worst per
 * workspace and render the appropriate dot color and tooltip.
 */
type AgentStatus = 'standby' | 'working' | 'busy' | 'degraded' | 'offline';
type DepartmentStatus = 'active' | 'idle';

const AGENT_STATUS_STYLES: Record<AgentStatus, { dot: string; tooltip: string }> = {
  standby: { dot: 'bg-blue-500', tooltip: 'Idle, ready for tasks' },
  working: { dot: 'bg-emerald-500 animate-pulse', tooltip: 'Actively processing' },
  busy: { dot: 'bg-amber-500 animate-pulse', tooltip: 'High load, fully functional but strained' },
  degraded: { dot: 'bg-orange-500', tooltip: 'Some operations failing, intervention recommended' },
  offline: { dot: 'bg-gray-400', tooltip: 'Unreachable' },
};

/** Order from worst to best for aggregation across a workspace's agents. */
const STATUS_PRIORITY: AgentStatus[] = ['offline', 'degraded', 'busy', 'working', 'standby'];

function worstAgentStatus(statuses: AgentStatus[]): AgentStatus {
  for (const s of STATUS_PRIORITY) {
    if (statuses.includes(s)) return s;
  }
  return 'standby';
}

function normalizeAgentStatus(value: string | undefined | null): AgentStatus | null {
  if (
    value === 'standby' ||
    value === 'working' ||
    value === 'busy' ||
    value === 'degraded' ||
    value === 'offline'
  ) {
    return value;
  }
  return null;
}

interface Department {
  id: string;
  workspaceId: string;
  emoji: string;
  name: string;
  /** Name of the department's head agent, or null if none is assigned. */
  headName: string | null;
  status: DepartmentStatus;
  agentStatus: AgentStatus;
}

interface AgentsSidebarProps {
  workspaceId?: string;
  isOpen?: boolean;
  onClose?: () => void;
  /**
   * When true, selecting a department NAVIGATES to that department's Focus
   * View (/workspace/<slug>) instead of mutating the in-place filter. Used by
   * /tasks/all so a sidebar click deterministically opens the focused board
   * (the cross-department board ignores selectedDepartment, so an in-place
   * filter would silently do nothing).
   */
  navigateOnSelect?: boolean;
  /**
   * When set, the rail renders in FOCUS mode: instead of the full
   * all-departments list it shows a minimal focused context (a back-to-all
   * affordance + the single current department) so the Kanban board has the
   * stage to itself. The value is the slug of the focused department.
   */
  focusSlug?: string;
}

export function AgentsSidebar({ workspaceId, isOpen = false, onClose, navigateOnSelect = false, focusSlug }: AgentsSidebarProps) {
  const router = useRouter();
  const { agentOpenClawSessions, selectedDepartment, setSelectedDepartment } = useMissionControl();
  const [filter, setFilter] = useState<FilterTab>('all');
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(null);
  const [activeSubAgents, setActiveSubAgents] = useState(0);
  const [isMinimized, setIsMinimized] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);

  const toggleMinimize = () => setIsMinimized(!isMinimized);

  // Selecting a department: in /tasks/all we navigate to the Focus View so
  // the click is deterministic; elsewhere we keep the legacy in-place filter.
  const handleSelectDepartment = useCallback(
    (slug: string) => {
      if (navigateOnSelect) {
        router.push(`/workspace/${slug}`);
        onClose?.();
        return;
      }
      setSelectedDepartment(slug);
    },
    [navigateOnSelect, router, onClose, setSelectedDepartment],
  );

  // Load departments dynamically from the workspaces database. For each
  // workspace we also pull its agents so we can aggregate the worst agent
  // status (PRD 3.13) into the department's dot color.
  useEffect(() => {
    let cancelled = false;
    const loadDepartments = async () => {
      try {
        const res = await fetch('/api/workspaces');
        if (!res.ok) return;
        const workspaces = await res.json();
        if (!Array.isArray(workspaces)) return;

        const enriched = await Promise.all(
          workspaces.map(
            async (ws: { id: string; name: string; icon?: string; slug: string; head_agent_name?: string | null }) => {
              let agentStatus: AgentStatus = 'standby';
              try {
                const ar = await fetch(
                  `/api/agents?workspace_id=${encodeURIComponent(ws.id)}`,
                  { cache: 'no-store' }
                );
                if (ar.ok) {
                  const agents = (await ar.json()) as Array<{ status?: string }>;
                  if (Array.isArray(agents) && agents.length > 0) {
                    const statuses = agents
                      .map((a) => normalizeAgentStatus(a.status))
                      .filter((s): s is AgentStatus => !!s);
                    if (statuses.length > 0) {
                      agentStatus = worstAgentStatus(statuses);
                    }
                  }
                }
              } catch {
                // Non-fatal: leave at standby.
              }
              const deptStatus: DepartmentStatus =
                agentStatus === 'working' || agentStatus === 'busy' || agentStatus === 'degraded'
                  ? 'active'
                  : 'idle';
              return {
                id: ws.slug || ws.id,
                workspaceId: ws.id,
                emoji: ws.icon || '📁',
                name: ws.name,
                // Use the department's assigned head agent name. The /api/workspaces
                // response already includes head_agent_name via a LEFT JOIN on
                // workspaces.head_agent_id → agents.name (migration 028). Store null
                // if unset — the render layer shows "—" rather than repeating the
                // department name.
                headName: ws.head_agent_name || null,
                status: deptStatus,
                agentStatus,
              } as Department;
            }
          )
        );
        // Hard UI guarantee: hoist the CEO / master-orchestrator department to
        // the FRONT of the rail so it always renders first, regardless of
        // stored sort_order or drag-reorder history.  The canonical CEO slug is
        // `master-orchestrator`; legacy slugs `ceo` / `dept-ceo` and name
        // variants `ceo` / `master orchestrator` are also matched (fleet-wide
        // fix — previous code only matched `ceo` / `dept-ceo`, so every
        // canonical `master-orchestrator` workspace never hoisted).
        //
        // Additionally, PIN `general-task` ("General Tasks") to the BOTTOM so
        // the board always reads: CEO first … operational depts … General Tasks.
        //
        // Implementation:
        //   1. Extract the CEO item (may be absent on fresh/unseeded installs).
        //   2. Extract the General Tasks item (may be absent).
        //   3. Sandwich remaining depts between them.
        const isCeoItem = (d: Department): boolean => {
          const slug = (d.id || '').toLowerCase();
          const name = (d.name || '').toLowerCase();
          return (
            slug === 'master-orchestrator' ||
            slug === 'ceo' ||
            slug === 'dept-ceo' ||
            name === 'master orchestrator' ||
            name === 'ceo'
          );
        };
        const isGeneralTaskItem = (d: Department): boolean => {
          const slug = (d.id || '').toLowerCase();
          const name = (d.name || '').toLowerCase();
          return slug === 'general-task' || name === 'general tasks' || name === 'general task';
        };

        const ceoItem = enriched.find(isCeoItem);
        const generalTaskItem = enriched.find(isGeneralTaskItem);
        const middle = enriched.filter((d) => !isCeoItem(d) && !isGeneralTaskItem(d));

        const ordered = [
          ...(ceoItem ? [ceoItem] : []),
          ...middle,
          ...(generalTaskItem ? [generalTaskItem] : []),
        ];

        if (!cancelled) setDepartments(ordered);
      } catch {
        // Fall back silently to empty list.
      }
    };

    loadDepartments();
    // Refresh agent status every 30s to keep the sidebar in sync.
    const id = setInterval(loadDepartments, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
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

  const dotClassFor = (dept: Department, isSelected: boolean): string => {
    if (isSelected) return 'bg-brand-500';
    return AGENT_STATUS_STYLES[dept.agentStatus].dot;
  };

  // ── Focus mode rail ───────────────────────────────────────────────────────
  // In a single-department Focus View we deliberately do NOT render the full
  // all-departments list (that crowded the board and let the user wander out of
  // focus). Instead the rail is a minimal focused context: an obvious
  // "Back to All Departments" affordance + the one department in focus.
  if (focusSlug) {
    const current = departments.find((d) => d.id === focusSlug);
    return (
      <aside
        className={`bg-white border-r border-gray-200 flex flex-col transition-all duration-300 ease-in-out ${
          isMinimized ? 'w-12' : 'w-full lg:w-72'
        }`}
        aria-label="Department focus rail"
      >
        <div className="p-3 border-b border-gray-100 flex items-center">
          <button
            onClick={toggleMinimize}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
            aria-label={isMinimized ? 'Expand focus rail' : 'Minimize focus rail'}
          >
            {isMinimized ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
          {!isMinimized && <span className="text-sm font-semibold text-gray-900 ml-1">Focus</span>}
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {/* Back to All Departments — always available so the user is never stuck */}
          <button
            onClick={() => router.push('/tasks/all')}
            className={`w-full rounded-lg transition-colors text-left hover:bg-gray-50 ${
              isMinimized ? 'flex justify-center py-2' : ''
            }`}
            aria-label="Back to All Departments"
            title="Back to All Departments"
          >
            {isMinimized ? (
              <ArrowLeft className="w-4 h-4 text-gray-500" />
            ) : (
              <div className="flex items-center gap-2 p-2.5 text-gray-600">
                <ArrowLeft className="w-4 h-4 shrink-0" />
                <span className="text-sm font-medium">All Departments</span>
              </div>
            )}
          </button>

          {!isMinimized && <div className="border-t border-gray-100 my-1" />}

          {/* The single department in focus */}
          {!isMinimized && (
            <div className="w-full rounded-lg bg-brand-50 border border-brand-200 ring-1 ring-brand-200">
              <div className="flex items-center gap-3 p-2.5">
                <div className="text-2xl relative">
                  {current?.emoji || '📁'}
                  {current && (
                    <span
                      className={`absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-white ${dotClassFor(current, true)}`}
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate text-brand-900">
                    {current?.name || focusSlug}
                  </div>
                  <div className="text-sm truncate text-brand-600">In focus</div>
                </div>
                <span className="w-2 h-2 rounded-full bg-brand-500" />
              </div>
            </div>
          )}
          {isMinimized && (
            <div className="flex justify-center py-2" title={current?.name || focusSlug}>
              <span className="text-2xl">{current?.emoji || '📁'}</span>
            </div>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={`bg-white border-r border-gray-200 flex flex-col transition-all duration-300 ease-in-out ${
        isMinimized ? 'w-12' : 'w-full lg:w-72'
      }`}
      aria-label="All departments navigation"
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
                  className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                    filter === tab
                      ? 'bg-brand-600 text-white'
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
        {/* All Departments Option */}
        {!isMinimized && (
          <button
            onClick={() => setSelectedDepartment(null)}
            className={`w-full rounded-lg transition-colors text-left ${
              selectedDepartment === null
                ? 'bg-brand-50 border border-brand-200 ring-1 ring-brand-200'
                : 'hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center gap-3 p-2.5">
              <div className="text-2xl">🏢</div>
              <div className="flex-1 min-w-0">
                <div className={`font-medium text-sm truncate ${
                  selectedDepartment === null ? 'text-brand-900' : 'text-gray-900'
                }`}>
                  All Departments
                </div>
                <div className={`text-sm truncate ${
                  selectedDepartment === null ? 'text-brand-600' : 'text-gray-500'
                }`}>
                  View all tasks
                </div>
              </div>
              {selectedDepartment === null && (
                <span className="w-2 h-2 rounded-full bg-brand-500" />
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
                onClick={() => handleSelectDepartment(dept.id)}
                className={`flex justify-center py-2 w-full ${
                  isSelected ? 'bg-brand-50 rounded-lg' : ''
                }`}
              >
                <div
                  className="relative group"
                  title={`${dept.name} - ${AGENT_STATUS_STYLES[dept.agentStatus].tooltip}`}
                >
                  <span className="text-2xl">{dept.emoji}</span>
                  {/* Status indicator - reflects worst agent status (PRD 3.13) */}
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white ${dotClassFor(dept, isSelected)}`}
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
              onClick={() => handleSelectDepartment(dept.id)}
              className={`w-full rounded-lg transition-colors text-left ${
                isSelected
                  ? 'bg-brand-50 border border-brand-200 ring-1 ring-brand-200'
                  : 'hover:bg-gray-50'
              }`}
            >
              <div
                className="flex items-center gap-3 p-2.5"
                title={AGENT_STATUS_STYLES[dept.agentStatus].tooltip}
              >
                {/* Emoji */}
                <div className="text-2xl relative">
                  {dept.emoji}
                  <span
                    className={`absolute -bottom-1 -right-1 w-3 h-3 rounded-full border-2 border-white ${dotClassFor(dept, isSelected)}`}
                  />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className={`font-medium text-sm truncate ${
                    isSelected ? 'text-brand-900' : 'text-gray-900'
                  }`}>
                    {dept.name}
                  </div>
                  <div className={`text-sm truncate ${
                    isSelected ? 'text-brand-600' : 'text-gray-500'
                  }`}>
                    {dept.headName ?? '—'}
                  </div>
                </div>

                {/* Status or Selected indicator */}
                {isSelected ? (
                  <span className="w-2 h-2 rounded-full bg-brand-500" />
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
