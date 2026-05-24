'use client';

/**
 * /kanban — Cross-department All-Tasks Kanban view.
 *
 * Replaces the broken `/workspace/default` route that the homepage's
 * "Main Kanban" card used to point at. There is no workspace with slug
 * "default" on a client install (workspaces are seeded as ceo / marketing /
 * sales / etc.), so the old route 404'd. This page is the actual
 * "see every task in every department in one unified view" surface that
 * the homepage CTA copy promises.
 *
 * Pattern mirrors /workspace/[slug]/page.tsx but with no workspace fetch:
 *   - Loads all agents (no workspace_id filter)
 *   - Loads all tasks (no department filter)
 *   - Loads events
 *   - Passes departmentFilter={null} to MissionQueue, which short-circuits
 *     its dept filter and shows the entire `tasks` array (MissionQueue.tsx
 *     line 73-76).
 *   - Header receives no workspace prop; its UI already handles that case
 *     (Header.tsx line 26: workspace?: Workspace, line 180: ternary).
 *   - AgentsSidebar gets no workspaceId; it loads workspaces dynamically
 *     and shows all agents.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Header } from '@/components/Header';
import { AgentsSidebar } from '@/components/AgentsSidebar';
import { MissionQueue } from '@/components/MissionQueue';
import { useMissionControl } from '@/lib/store';
import { LiveFeed } from '@/components/LiveFeed';
import { SSEDebugPanel } from '@/components/SSEDebugPanel';
import { useSSE } from '@/hooks/useSSE';
import { debug } from '@/lib/debug';
import { Breadcrumb } from '@/components/Breadcrumb';

export default function AllTasksKanbanPage() {
  const {
    setAgents,
    setTasks,
    setEvents,
    setIsOnline,
    setIsLoading,
    setSelectedDepartment,
    isLoading,
  } = useMissionControl();

  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Connect to SSE for real-time updates
  useSSE();

  // Clear any sticky single-department filter from the global store so the
  // board renders cross-department on entry.
  useEffect(() => {
    setSelectedDepartment(null);
  }, [setSelectedDepartment]);

  // Load all data (no filters)
  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        debug.api('Loading all-tasks kanban data');
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
        console.error('Failed to load all-tasks data:', error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    // Light health check — keeps the connection indicator accurate
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
        {/* AgentsSidebar with no workspaceId — loads workspaces dynamically + shows full agent roster */}
        <AgentsSidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        {/* MissionQueue with departmentFilter={null} → cross-department view */}
        <MissionQueue departmentFilter={null} />

        {/* Live Feed */}
        <LiveFeed />
      </div>

      <SSEDebugPanel />
    </div>
  );
}
