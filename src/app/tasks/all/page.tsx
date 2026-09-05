'use client';

/**
 * /tasks/all - Master view with departments in the left sidebar.
 *
 * PRD 3.8: replaces the old /kanban route. Cross-department Kanban with a
 * persistent sidebar listing every department + task counts. Clicking a
 * department in the sidebar swaps the focused Kanban without leaving the
 * page. Sidebar stays so you can switch quickly.
 *
 * Implementation note: the existing AgentsSidebar already renders the
 * workspace list with task counts (it loads workspaces dynamically when
 * mounted without a workspaceId prop), and MissionQueue already
 * short-circuits its dept filter when departmentFilter is null. So this
 * page reuses the same component composition the old /kanban route used
 * and simply lives at the new path.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { checkedJson } from '@/lib/checked-json';
import { Header } from '@/components/Header';
import { AgentsSidebar } from '@/components/AgentsSidebar';
import { MissionQueue } from '@/components/MissionQueue';
import { useDueDateWindowDays } from '@/hooks/useDueDateWindowDays';
import { useMissionControl } from '@/lib/store';
import { LiveFeed } from '@/components/LiveFeed';
import { SSEDebugPanel } from '@/components/SSEDebugPanel';
import { useSSE } from '@/hooks/useSSE';
import { Breadcrumb } from '@/components/Breadcrumb';
import { unwrapAgents } from '@/lib/api-envelope';
import type { Task } from '@/lib/types';

export default function AllTasksPage() {
  const {
    setAgents,
    setTasks,
    setEvents,
    setIsLoading,
    setSelectedDepartment,
  } = useMissionControl();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const refreshRequest = useRef<AbortController | null>(null);
  const refreshGeneration = useRef(0);

  // MR-44 (fix2): this board is cross-department (departmentFilter={null}), so
  // it resolves the GLOBAL "Tasks Due" filter window (env override / fleet
  // default) from the board-SLA config rather than a hardcoded 7.
  const dueDateWindowDays = useDueDateWindowDays(null);

  useSSE();

  useEffect(() => {
    setSelectedDepartment(null);
  }, [setSelectedDepartment]);

  const loadData = useCallback(async () => {
    refreshRequest.current?.abort();
    const controller = new AbortController();
    refreshRequest.current = controller;
    const generation = ++refreshGeneration.current;
    const results = await Promise.allSettled([
      checkedJson<unknown>('/api/agents', controller.signal),
      checkedJson<Task[]>('/api/tasks', controller.signal),
      checkedJson<Parameters<typeof setEvents>[0]>('/api/events', controller.signal),
    ]);
    if (controller.signal.aborted || generation !== refreshGeneration.current) return;
    const errors: string[] = [];
    const labels = ['Agents', 'Tasks', 'Activity'];
    results.forEach((result, index) => {
      if (result.status === 'rejected') errors.push(`${labels[index]}: ${result.reason instanceof Error ? result.reason.message : 'Refresh failed. Please retry.'}`);
    });
    if (results[0].status === 'fulfilled') {
      try { setAgents(unwrapAgents(results[0].value)); } catch { errors.push('Agents: invalid response.'); }
    }
    if (results[1].status === 'fulfilled') {
      if (Array.isArray(results[1].value)) {
        setTasks(results[1].value);
        setLastRefresh(new Date().toLocaleTimeString());
      } else errors.push('Tasks: invalid response. Existing cards have been preserved.');
    }
    if (results[2].status === 'fulfilled') {
      if (Array.isArray(results[2].value)) setEvents(results[2].value);
      else errors.push('Activity: invalid response.');
    }
    setLoadError(errors.length ? errors.join(' ') : null);
    setIsLoading(false);
    setRetrying(false);
  }, [setAgents, setTasks, setEvents, setIsLoading]);

  useEffect(() => {
    void loadData();
    const timer = setInterval(() => { void loadData(); }, 60_000);
    return () => { clearInterval(timer); refreshRequest.current?.abort(); ++refreshGeneration.current; };
  }, [loadData]);

  const handleRetry = () => {
    if (retrying) return;
    setRetrying(true);
    void loadData();
  };

  return (
    /* Shell contract (v4.66.0 bottom-cutoff fix):
       • lg:h-dvh — dynamic viewport height, so mobile-Safari/short-window
         chrome never hides the last row (100vh over-measured the viewport).
       • min-h-0 on the flex row — without it the board region's flex children
         keep min-height:auto and silently overflow the h-dvh shell, clipping
         the bottom of the columns with no way to reach it.
       • Below lg the page is a normal min-h-dvh document scroll. */
    <div className="min-h-dvh lg:h-dvh flex flex-col bg-bcc-bg lg:overflow-hidden">
      <Header onMenuClick={() => setSidebarOpen(!sidebarOpen)} sidebarOpen={sidebarOpen} />

      <div className="px-4 sm:px-6 lg:px-8 bg-white border-b border-gray-100 shrink-0">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Task Board' },
          ]}
        />
      </div>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row lg:overflow-hidden">
        <AgentsSidebar navigateOnSelect isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <MissionQueue
          departmentFilter={null}
          loadError={loadError ? `${loadError} ${lastRefresh ? `Displayed data may be stale. Last task refresh: ${lastRefresh}.` : 'No successful task refresh yet.'}` : null}
          onRetry={() => handleRetry()}
          dueDateWindowDays={dueDateWindowDays}
        />
        <LiveFeed />
      </div>

      <SSEDebugPanel />
    </div>
  );
}
