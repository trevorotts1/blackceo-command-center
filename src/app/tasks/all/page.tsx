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
import { unwrapAgents } from '@/lib/api-envelope';
import type { Task } from '@/lib/types';

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

        if (agentsRes.ok) setAgents(unwrapAgents(await agentsRes.json()));
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

    // SSE-fallback task refetch (mirrors src/app/workspace/[slug]/page.tsx):
    // this page previously had no polling fallback at all for tasks — only
    // the 60s /api/health ping above — so if SSE was blocked (proxy/firewall)
    // the cross-department board would go stale indefinitely with no way to
    // self-heal short of a manual reload. Reconcile the store only when the
    // fetched set actually differs (count or any status) to avoid needless
    // re-renders.
    const taskPoll = setInterval(async () => {
      try {
        const res = await fetch('/api/tasks');
        if (res.ok) {
          const newTasks: Task[] = await res.json();
          const currentTasks = useMissionControl.getState().tasks;

          const hasChanges =
            newTasks.length !== currentTasks.length ||
            newTasks.some((t) => {
              const current = currentTasks.find((ct) => ct.id === t.id);
              return !current || current.status !== t.status;
            });

          if (hasChanges) {
            debug.api('[FALLBACK] Task changes detected via polling, updating store');
            setTasks(newTasks);
          }
        }
      } catch (error) {
        console.error('Failed to poll tasks:', error);
      }
    }, 60000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(taskPoll);
    };
  }, [setAgents, setTasks, setEvents, setIsOnline, setIsLoading]);

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
            { label: 'All Tasks' },
          ]}
        />
      </div>

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row lg:overflow-hidden">
        <AgentsSidebar navigateOnSelect isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <MissionQueue departmentFilter={null} />
        <LiveFeed />
      </div>

      <SSEDebugPanel />
    </div>
  );
}
