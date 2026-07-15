'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Header } from '@/components/Header';
import { AgentsSidebar } from '@/components/AgentsSidebar';
import { MissionQueue } from '@/components/MissionQueue';
import { useMissionControl } from '@/lib/store';
import { LiveFeed } from '@/components/LiveFeed';
import { SSEDebugPanel } from '@/components/SSEDebugPanel';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { useSSE } from '@/hooks/useSSE';
import { debug } from '@/lib/debug';
import { Breadcrumb } from '@/components/Breadcrumb';
import { resolveDepartment } from '@/lib/routing/resolve-department';
import { AnthologyBoardDriftBanner } from '@/components/anthology/BoardDriftBanner';
import { Skill6BoardDriftBanner } from '@/components/skill6/BoardDriftBanner';
import { unwrapAgents } from '@/lib/api-envelope';
import type { Task, Workspace } from '@/lib/types';

export default function WorkspacePage() {
  const params = useParams();
  const slug = params.slug as string;
  
  const {
    setAgents,
    setTasks,
    setEvents,
    setIsLoading,
    setSelectedDepartment,
    isLoading,
    selectedDepartment,
  } = useMissionControl();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [deptName, setDeptName] = useState<string | null>(null);
  const logoUrl = useLogoUrl();

  // Connect to SSE for real-time updates
  useSSE();

  // Load workspace data
  useEffect(() => {
    async function loadWorkspace() {
      setTasks([]);
      try {
        const res = await fetch(`/api/workspaces/${slug}`);
        if (res.ok) {
          const data = await res.json();
          setWorkspace(data);
          // Resolve department name for breadcrumb (same logic as /ceo-board/[dept])
          const resolved = await resolveDepartment(slug);
          setDeptName(resolved?.name || data.name || null);
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

        // Scope the fetch by the workspace_id FK — the only enforced
        // relationship between tasks and workspaces. Filtering by the
        // free-text department slug (the previous behaviour) silently
        // returned zero rows whenever tasks.department was NULL or carried a
        // display name / short-slug instead of the workspace slug. The CEO /
        // default workspace still fetches everything.
        const tasksUrl = routeDepartment === null
          ? '/api/tasks'
          : `/api/tasks?workspace_id=${encodeURIComponent(workspaceId)}`;

        const [agentsRes, tasksRes, eventsRes] = await Promise.all([
          fetch(`/api/agents?workspace_id=${workspaceId}`),
          fetch(tasksUrl),
          fetch('/api/events'),
        ]);

        if (agentsRes.ok) setAgents(unwrapAgents(await agentsRes.json()));
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

    loadData();

    // SSE is the primary real-time mechanism - these are fallback polls with longer intervals
    // to reduce server load while providing redundancy. (U47: this effect
    // previously also ran its own /api/workspaces health ping — on both
    // mount and a 30s interval below — writing to the now-retired global
    // `isOnline` flag. Removed, not replaced; overall health is sourced from
    // <HealthIndicator/> / /api/system/status, not a per-page data-fetch
    // side effect.)

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
        // Use the same workspace_id-scoped fetch as the initial load so the
        // department board never drifts back to all tasks (or to an empty
        // board when tasks.department doesn't byte-equal the slug).
        const pollUrl = routeDepartment === null
          ? '/api/tasks'
          : `/api/tasks?workspace_id=${encodeURIComponent(workspaceId)}`;
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

    return () => {
      clearInterval(eventPoll);
      clearInterval(taskPoll);
    };
  }, [workspace, selectedDepartment, setAgents, setTasks, setEvents, setIsLoading]);

  if (notFound) {
    return (
      <div className="min-h-screen bg-bcc-bg flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-4">🔍</div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Department Not Found</h1>
          <p className="text-gray-500 mb-6">
            The department &ldquo;{slug}&rdquo; doesn&apos;t exist.
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-6 py-3 bg-brand-600 text-white rounded-lg font-medium hover:bg-brand-700 transition-colors"
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
      <div className="min-h-screen bg-bcc-bg flex flex-col">
        {/* Header skeleton */}
        <div className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-4">
            <div className="h-8 w-8 bg-gray-200 rounded animate-pulse" />
            <div className="h-6 w-32 bg-gray-200 rounded animate-pulse" />
          </div>
          <div className="flex items-center gap-3">
            <div className="h-8 w-20 bg-gray-200 rounded-lg animate-pulse" />
            <div className="h-8 w-20 bg-gray-200 rounded-lg animate-pulse" />
          </div>
        </div>
        <div className="flex-1 flex">
          {/* Sidebar skeleton */}
          <div className="w-72 bg-white border-r border-gray-200 p-4 space-y-3 shrink-0">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 p-2.5">
                <div className="h-10 w-10 bg-gray-200 rounded-lg animate-pulse" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-24 bg-gray-200 rounded animate-pulse" />
                  <div className="h-3 w-16 bg-gray-100 rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
          {/* Board skeleton */}
          <div className="flex-1 p-8">
            <div className="flex gap-6 h-full">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="w-72 flex flex-col gap-4">
                  <div className="h-10 w-full bg-gray-200 rounded-full animate-pulse" />
                  {[1, 2].map((j) => (
                    <div key={j} className="bg-white rounded-2xl p-5 border border-gray-50 space-y-3">
                      <div className="h-4 w-3/4 bg-gray-200 rounded animate-pulse" />
                      <div className="h-3 w-1/2 bg-gray-100 rounded animate-pulse" />
                      <div className="h-3 w-full bg-gray-100 rounded animate-pulse" />
                      <div className="flex items-center gap-2 pt-3 border-t border-gray-50">
                        <div className="h-8 w-8 bg-gray-200 rounded-full animate-pulse" />
                        <div className="h-3 w-16 bg-gray-100 rounded animate-pulse ml-auto" />
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          {/* Feed skeleton */}
          <div className="w-80 bg-white border-l border-gray-200 p-4 space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-start gap-2.5 p-2.5">
                <div className="h-2 w-2 bg-gray-200 rounded-full mt-1.5 shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-full bg-gray-200 rounded animate-pulse" />
                  <div className="h-2 w-16 bg-gray-100 rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const isCEOWorkspace = workspace.slug === 'ceo' || workspace.slug === 'default';
  const routeDepartment = workspace.slug === 'default' || workspace.slug === 'ceo'
    ? null
    : workspace.slug;

  return (
    /* Shell contract (v4.66.0 bottom-cutoff fix) — see /tasks/all: dvh-sized
       shell + min-h-0 scroll chain so the board never clips unreachable rows. */
    <div className="min-h-dvh lg:h-dvh flex flex-col bg-bcc-bg lg:overflow-hidden">
      <Header workspace={workspace} onMenuClick={() => setSidebarOpen(!sidebarOpen)} sidebarOpen={sidebarOpen} />

      {/* Breadcrumb: shows Home > CEO Board > [Dept Name] > Focus View */}
      <div className="px-4 sm:px-6 lg:px-8 bg-white border-b border-gray-100 shrink-0">
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            ...(deptName
              ? [
                  { label: 'CEO Board', href: '/ceo-board' },
                  { label: deptName, href: `/ceo-board/${slug}` },
                  { label: 'Focus View' },
                ]
              : [
                  { label: 'CEO Board', href: '/ceo-board' },
                  { label: workspace?.name || slug },
                ]),
          ]}
        />
      </div>

      {/* A7 — board projection drift banner (Anthology board only). Read-only,
          fail-soft; renders nothing unless the ledger shows confirmed drift. */}
      {workspace.slug === 'anthology' && <AnthologyBoardDriftBanner />}

      {/* U27 / B-U13 — Skill-6 board projection drift banner (Web Development
          board — the one department slug Skill-6 funnel/website/survey cards
          actually resolve to today; see cc_board.py's department_slug routing
          comment). Read-only, fail-soft; renders nothing unless a run's board
          card is confirmed never-landed or orphaned. */}
      {workspace.slug === 'web-development' && <Skill6BoardDriftBanner />}

      {/* Department head banner — migration 028. Surfaces the agent designated
          as the head of this workspace so visitors immediately know who owns it. */}
      {workspace.head_agent_name && (
        <div className="border-b border-indigo-100 bg-indigo-50/60 px-4 py-2 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-lg shadow-sm">
              {workspace.head_agent_avatar || '🤖'}
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600">Department Head</p>
              <p className="text-sm font-semibold text-gray-900">{workspace.head_agent_name}</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col lg:flex-row lg:overflow-hidden">
        {/* Agents Sidebar — focus mode (scoped rail) for a single department,
            full all-departments list only on the CEO / default workspace. */}
        <AgentsSidebar
          workspaceId={workspace.id}
          focusSlug={routeDepartment ?? undefined}
          isOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        {/* Main Content Area — U57: the CEODashboard branch this ternary used
            to guard was unreachable dead code (showTaskBoard was hardcoded
            true; VERIFIED sole consumer of CEODashboard.tsx, now deleted).
            Always the task board; a department-scoped performance view lives
            at /ceo-board/[dept] instead. */}
        <MissionQueue
          workspaceId={workspace.id}
          departmentFilter={routeDepartment}
          boardKind={workspace.slug === 'bugs' ? 'bug' : 'task'}
        />

        {/* Live Feed */}
        <LiveFeed />
      </div>

      {/* Debug Panel - only shows when debug mode enabled */}
      <SSEDebugPanel />
    </div>
  );
}
