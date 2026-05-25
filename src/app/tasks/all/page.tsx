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

import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { AgentsSidebar } from '@/components/AgentsSidebar';
import { MissionQueue } from '@/components/MissionQueue';
import { useMissionControl } from '@/lib/store';
import { LiveFeed } from '@/components/LiveFeed';
import { SSEDebugPanel } from '@/components/SSEDebugPanel';
import { useSSE } from '@/hooks/useSSE';
import { debug } from '@/lib/debug';
import { Breadcrumb } from '@/components/Breadcrumb';

export default function AllTasksPage() {
  const {
    setAgents,
    setTasks,
    setEvents,
    setIsOnline,
    setIsLoading,
    setSelectedDepartment,
  } = useMissionControl();

  const [sidebarOpen, setSidebarOpen] = useState(false);

  useSSE();

  useEffect(() => {
    setSelectedDepartment(null);
  }, [setSelectedDepartment]);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        debug.api('Loading /tasks/all data');
        const [agentsRes, tasksRes, eventsRes] = await Promise.all([
          fetch('/api/agents'),
          fetch('/api/tasks'),
          fetch('/api/events'),
        ]);

        if (cancelled) return;

        if (agentsRes.ok) setAgents(await agentsRes.json());
        if (tasksRes.ok) {
          const tasksData = await tasksRes.json();
          debug.api('Loaded all tasks', { count: tasksData.length });
          setTasks(tasksData);
        }
        if (eventsRes.ok) setEvents(await eventsRes.json());
      } catch (error) {
        console.error('Failed to load /tasks/all data:', error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    async function checkHealth() {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeoutId);
        if (!cancelled) setIsOnline(res.ok);
      } catch {
        if (!cancelled) setIsOnline(false);
      }
    }

    loadData();
    checkHealth();
    const interval = setInterval(checkHealth, 60000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [setAgents, setTasks, setEvents, setIsOnline, setIsLoading]);

  return (
    <div className="min-h-screen lg:h-screen flex flex-col bg-[#F8F9FB] lg:overflow-hidden">
      <Header onMenuClick={() => setSidebarOpen(!sidebarOpen)} sidebarOpen={sidebarOpen} />

      <div className="px-4 sm:px-6 lg:px-8 bg-white border-b border-gray-100">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'All Tasks' },
          ]}
        />
      </div>

      <div className="flex-1 flex flex-col lg:flex-row lg:overflow-hidden">
        <AgentsSidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <MissionQueue departmentFilter={null} />
        <LiveFeed />
      </div>

      <SSEDebugPanel />
    </div>
  );
}
