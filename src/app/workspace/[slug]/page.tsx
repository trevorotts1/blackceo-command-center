'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Header } from '@/components/Header';
import { AgentsSidebar } from '@/components/AgentsSidebar';
import { MissionQueue } from '@/components/MissionQueue';
import { CEODashboard } from '@/components/CEODashboard';
import { useMissionControl } from '@/lib/store';
import { LiveFeed } from '@/components/LiveFeed';
import { SSEDebugPanel } from '@/components/SSEDebugPanel';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { useSSE } from '@/hooks/useSSE';
import { debug } from '@/lib/debug';
import type { Task, Workspace } from '@/lib/types';

export default function WorkspacePage() {
  const params = useParams();
  const slug = params.slug as string;
  
  const {
    setAgents,
    setTasks,
    setEvents,
    setIsOnline,
    setIsLoading,
    setSelectedDepartment,
    isLoading,
    selectedDepartment,
  } = useMissionControl();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const logoUrl = useLogoUrl();

  // Connect to SSE for real-time updates
  useSSE();

  // Load workspace data
  useEffect(() => {
    async function loadWorkspace() {
      try {
        const res = await fetch(`/api/workspaces/${slug}`);
        if (res.ok) {
          const data = await res.json();
          setWorkspace(data);
        } else if (res.status === 404) {
          setNotFound(true);
          setIsLoading(false);
          return;
        }
      } catch (error) {
        console.error('Failed to load workspace:', error);
        setNotFound(true);
        setIsLoading(false);
        return;
      }
    }

    loadWorkspace();
  }, [slug, setIsLoading]);

  // Lock the global department filter to the route.
  // Department routes must always stay scoped to that single department.
  useEffect(() => {
    if (!workspace) return;

    const routeDepartment = workspace.slug === 'default' || workspace.slug === 'ceo'
      ? null
      : workspace.slug;

    if (selectedDepartment !== routeDepartment) {
      setSelectedDepartment(routeDepartment);
    }
  }, [workspace, selectedDepartment, setSelectedDepartment]);

  // Load workspace-specific data
  useEffect(() => {
    if (!workspace) return;
    
    const workspaceId = workspace.id;
    const routeDepartment = workspace.slug === 'default' || workspace.slug === 'ceo'
      ? null
      : workspace.slug;

    async function loadData() {
      try {
        debug.api('Loading workspace data...', { workspaceId, routeDepartment, selectedDepartment });

        // Always derive the task filter from the route itself.
        // This prevents a race where a stale/null global selection briefly fetches all tasks
        // and overwrites the single-department board after navigation.
        const tasksUrl = routeDepartment === null
          ? '/api/tasks'
          : `/api/tasks?department=${routeDepartment}`;

        const [agentsRes, tasksRes, eventsRes] = await Promise.all([
          fetch(`/api/agents?workspace_id=${workspaceId}`),
          fetch(tasksUrl),
          fetch('/api/events'),
        ]);

        if (agentsRes.ok) setAgents(await agentsRes.json());
        if (tasksRes.ok) {
          const tasksData = await tasksRes.json();
          debug.api('Loaded tasks', { count: tasksData.length });
          setTasks(tasksData);
        }
        if (eventsRes.ok) setEvents(await eventsRes.json());
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
      }
    }

    // Check dashboard API health (data availability, not gateway connection)
    async function checkHealth() {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const res = await fetch('/api/workspaces', { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeoutId);
        setIsOnline(res.ok);
      } catch {
        setIsOnline(false);
      }
    }

    loadData();
    checkHealth();

    // SSE is the primary real-time mechanism - these are fallback polls with longer intervals
    // to reduce server load while providing redundancy

    // Poll for events every 30 seconds (SSE fallback - increased from 5s)
    const eventPoll = setInterval(async () => {
      try {
        const res = await fetch('/api/events?limit=20');
        if (res.ok) {
          setEvents(await res.json());
        }
      } catch (error) {
        console.error('Failed to poll events:', error);
      }
    }, 30000); // Increased from 5000 to 30000

    // Poll tasks as SSE fallback every 60 seconds (increased from 10s)
    const taskPoll = setInterval(async () => {
      try {
        // Use the route-derived filter here too so department pages never drift back to all tasks.
        const pollUrl = routeDepartment === null
          ? '/api/tasks'
          : `/api/tasks?department=${routeDepartment}`;
        const res = await fetch(pollUrl);
        if (res.ok) {
          const newTasks: Task[] = await res.json();
          const currentTasks = useMissionControl.getState().tasks;

          const hasChanges = newTasks.length !== currentTasks.length ||
            newTasks.some((t) => {
              const current = currentTasks.find(ct => ct.id === t.id);
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
    }, 60000); // Increased from 10000 to 60000

    // Check dashboard health every 30 seconds (data availability, not gateway)
    const connectionCheck = setInterval(async () => {
      try {
        const res = await fetch('/api/workspaces', { cache: 'no-store' });
        setIsOnline(res.ok);
      } catch {
        setIsOnline(false);
      }
    }, 30000);

    return () => {
      clearInterval(eventPoll);
      clearInterval(connectionCheck);
      clearInterval(taskPoll);
    };
  }, [workspace, selectedDepartment, setAgents, setTasks, setEvents, setIsOnline, setIsLoading]);

  if (notFound) {
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-4">🔍</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Workspace Not Found</h1>
          <p className="text-gray-500 mb-6">
            The workspace &ldquo;{slug}&rdquo; doesn&apos;t exist.
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (isLoading || !workspace) {
    return (
      <div className="min-h-screen bg-[#F8F9FB] flex items-center justify-center">
        <div className="text-center">
          <img
            src={logoUrl}
            alt="Loading"
            className="h-12 w-auto mb-4 animate-pulse"
          />
          <p className="text-gray-500">Loading {slug}...</p>
        </div>
      </div>
    );
  }

  const isCEOWorkspace = workspace.slug === 'ceo' || workspace.slug === 'default';
  // Show task board when a department is selected, even on CEO workspace
  const showTaskBoard = true;

  return (
    <div className="min-h-screen lg:h-screen flex flex-col bg-[#F8F9FB] lg:overflow-hidden">
      <Header workspace={workspace} onMenuClick={() => setSidebarOpen(!sidebarOpen)} sidebarOpen={sidebarOpen} />

      <div className="flex-1 flex flex-col lg:flex-row lg:overflow-hidden">
        {/* Agents Sidebar */}
        <AgentsSidebar workspaceId={workspace.id} isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        {/* Main Content Area */}
        {showTaskBoard ? (
          <MissionQueue workspaceId={workspace.id} />
        ) : (
          <CEODashboard workspace={workspace} />
        )}

        {/* Live Feed */}
        <LiveFeed />
      </div>

      {/* Debug Panel - only shows when debug mode enabled */}
      <SSEDebugPanel />
    </div>
  );
}
