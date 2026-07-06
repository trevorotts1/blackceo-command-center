'use client';

/**
 * Main screen (v4.66.0 rebuild) — an operations overview, not a splash page.
 *
 * The previous landing was seven full-bleed gradient billboards with zero live
 * data: an operator opened the Command Center several times a day and learned
 * nothing from its first screen. This rebuild applies the patterns shared by
 * best-in-class operational dashboards (Linear / Stripe / Vercel):
 *
 *   • F-pattern hierarchy — the 4 numbers that matter sit top-left, set in the
 *     app's data face (JetBrains Mono, tabular) on quiet hairline cards.
 *   • Restrained color — neutral surfaces; the themeable brand-* accent and
 *     the semantic status colors are the only saturated elements. Per-view
 *     color appears only as a 10%-tint icon chip, never a full-card gradient.
 *   • Live pulse — departments render as chips with real working/idle dots;
 *     recent activity streams in from /api/events. Everything on this screen
 *     is real data or an honest empty state; nothing is fabricated.
 *   • Density with calm — all seven destinations remain one click away, in a
 *     compact grid that fits above the fold at 1440×900.
 *
 * White-label safe: every accent uses brand-* utilities (re-themed by
 * <BrandTheme/>) or --bcc-* variables; no hardcoded brand hues.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import {
  LayoutGrid,
  BarChart3,
  Kanban,
  ArrowRight,
  ArrowUpRight,
  Activity,
  Brain,
  Settings,
  Terminal,
  MessagesSquare,
  CircleAlert,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { format, formatDistanceToNow } from 'date-fns';
import type { Task, Agent } from '@/lib/types';

/* ── types for the lightweight fetches ─────────────────────────────────── */

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  icon: string;
}

interface EventRow {
  id: string;
  type: string;
  message: string;
  created_at: string;
  agent_name?: string | null;
}

interface ViewCard {
  title: string;
  description: string;
  icon: React.ReactNode;
  /** 10%-tint chip classes; color lives ONLY here (icon chip), never the card. */
  chip: string;
  route: string;
  badge?: number | null;
}

const OPEN_STATUSES = new Set([
  'backlog',
  'inbox',
  'planning',
  'pending_dispatch',
  'assigned',
  'in_progress',
  'review',
  'testing',
]);

function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Dot color for an activity event — semantic, worst-case-first. */
function eventTone(type: string): string {
  if (/(error|blocked|failed)/.test(type)) return 'bg-red-500';
  if (/(completed|done|success)/.test(type)) return 'bg-emerald-500';
  if (/(created|assigned|dispatch|started)/.test(type)) return 'bg-blue-500';
  return 'bg-gray-300';
}

export default function HomePage() {
  const logoUrl = useLogoUrl();
  const reduceMotion = useReducedMotion();

  const [now, setNow] = useState<Date | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [companyName, setCompanyName] = useState('');
  const [companyLoaded, setCompanyLoaded] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);

  /* clock — minute precision; no per-second re-render */
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  /* company name (PRD 3.7: never flash a default brand on white-label boxes) */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/company', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          const name = data?.name || data?.company?.name || '';
          if (!cancelled && name) setCompanyName(name);
        }
      } catch {}
      if (!cancelled) setCompanyLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* live overview data + health, refreshed every 60s */
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [tasksRes, agentsRes, wsRes, eventsRes] = await Promise.all([
          fetch('/api/tasks', { cache: 'no-store' }),
          fetch('/api/agents', { cache: 'no-store' }),
          fetch('/api/workspaces', { cache: 'no-store' }),
          fetch('/api/events', { cache: 'no-store' }),
        ]);
        if (cancelled) return;
        if (tasksRes.ok) setTasks(await tasksRes.json());
        if (agentsRes.ok) setAgents(await agentsRes.json());
        if (wsRes.ok) {
          const ws = await wsRes.json();
          setWorkspaces(Array.isArray(ws) ? ws : ws?.workspaces ?? []);
        }
        if (eventsRes.ok) {
          const ev = await eventsRes.json();
          if (Array.isArray(ev)) {
            // Internal plumbing events (backfills, dedup sweeps, heartbeats)
            // are real but not what an owner means by “activity”. Prefer
            // user-meaningful events; fall back to everything rather than
            // showing a false “no activity” empty state.
            const meaningful = ev.filter(
              (e: EventRow) => !/(backfill|dedup|reconcile|heartbeat|probe)/i.test(e.type)
            );
            setEvents((meaningful.length > 0 ? meaningful : ev).slice(0, 8));
          } else {
            setEvents([]);
          }
        }
      } catch {
        // network hiccup: keep last known data on screen
      } finally {
        if (!cancelled) setDataLoaded(true);
      }
    }

    async function health() {
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

    load();
    health();
    const interval = setInterval(() => {
      load();
      health();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  /* ── derived numbers (all real; no fabrication) ──────────────────────── */

  const stats = useMemo(() => {
    const active = tasks.filter((t) => OPEN_STATUSES.has(t.status));
    const inProgress = tasks.filter((t) => t.status === 'in_progress');
    const blocked = tasks.filter((t) => t.status === 'blocked');
    const done = tasks.filter((t) => t.status === 'done');
    const workingAgents = agents.filter((a) => a.status === 'working' || a.status === 'active');
    return {
      active: active.length,
      inProgress: inProgress.length,
      blocked: blocked.length,
      done: done.length,
      agentsTotal: agents.length,
      agentsWorking: workingAgents.length,
    };
  }, [tasks, agents]);

  /** Per-department live pulse: open tasks + whether any agent is working. */
  const deptPulse = useMemo(() => {
    const realWs = workspaces.filter((w) => w.slug !== 'default');
    return realWs.map((w) => {
      const open = tasks.filter(
        (t) => t.workspace_id === w.id && OPEN_STATUSES.has(t.status)
      ).length;
      const working = agents.some(
        (a) => a.workspace_id === w.id && (a.status === 'working' || a.status === 'active')
      );
      return { ...w, open, working };
    });
  }, [workspaces, tasks, agents]);

  const kpis = [
    { label: 'Active tasks', value: stats.active, sub: 'across all departments', href: '/tasks/all' },
    { label: 'In progress', value: stats.inProgress, sub: 'being worked right now', href: '/tasks/all' },
    { label: 'Completed', value: stats.done, sub: 'all time', href: '/tasks/all' },
    {
      label: 'Needs attention',
      value: stats.blocked,
      sub: stats.blocked > 0 ? 'blocked — action required' : 'nothing blocked',
      href: '/tasks/all',
      alert: stats.blocked > 0,
    },
  ];

  /* All seven destinations preserved (PRD 3.8 + F52), now as quiet cards. */
  const views: ViewCard[] = [
    {
      title: 'All Tasks',
      description: 'One Kanban, all departments',
      icon: <Kanban className="w-5 h-5" />,
      chip: 'bg-indigo-50 text-indigo-600',
      route: '/tasks/all',
      badge: dataLoaded ? stats.active : null,
    },
    {
      title: 'Departments',
      description: 'One department at a time',
      icon: <LayoutGrid className="w-5 h-5" />,
      chip: 'bg-emerald-50 text-emerald-600',
      route: '/tasks/by-department',
      badge: dataLoaded ? deptPulse.length : null,
    },
    {
      title: 'Performance Board',
      description: 'Analytics and grades',
      icon: <BarChart3 className="w-5 h-5" />,
      chip: 'bg-amber-50 text-amber-600',
      route: '/ceo-board',
    },
    {
      title: 'Conversational AI',
      description: 'Conversation analytics',
      icon: <MessagesSquare className="w-5 h-5" />,
      chip: 'bg-pink-50 text-pink-600',
      route: '/conversational-ai',
    },
    {
      title: 'Intelligence Settings',
      description: 'Models and personas',
      icon: <Brain className="w-5 h-5" />,
      chip: 'bg-violet-50 text-violet-600',
      route: '/settings/intelligence',
    },
    {
      title: 'Operator Console',
      description: 'Chat, media, research, web agent',
      icon: <Terminal className="w-5 h-5" />,
      chip: 'bg-sky-50 text-sky-600',
      route: '/operator',
    },
    {
      title: 'Company Settings',
      description: 'Name, brand, logo',
      icon: <Settings className="w-5 h-5" />,
      chip: 'bg-gray-100 text-gray-600',
      route: '/settings/company',
    },
  ];

  return (
    <div className="min-h-dvh bg-bcc-bg flex flex-col">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="h-14 bg-white border-b border-gray-200 px-4 sm:px-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {logoUrl ? (
            <img src={logoUrl} alt="Company logo" className="h-8 w-auto shrink-0" />
          ) : (
            <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center shrink-0">
              <BarChart3 className="w-4 h-4 text-white" />
            </div>
          )}
          <div className="min-w-0 flex items-baseline gap-2">
            {companyLoaded ? (
              companyName ? (
                <span className="text-gray-900 font-semibold text-[15px] truncate">
                  {companyName}
                </span>
              ) : null
            ) : (
              <span aria-hidden="true" className="inline-block h-4 w-24 rounded bg-gray-200 animate-pulse" />
            )}
            <span className="hidden sm:inline text-gray-400 text-[15px] shrink-0" aria-hidden="true">
              /
            </span>
            <span className="hidden sm:inline text-gray-500 text-[15px] font-medium shrink-0">
              Command Center
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {now && (
            <span className="hidden md:inline text-gray-500 text-sm font-mono tabular-nums">
              {format(now, 'EEE MMM d · HH:mm')}
            </span>
          )}
          <div
            role="status"
            aria-label={`Connection status: ${isOnline ? 'live' : 'offline'}`}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
              isOnline
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : 'bg-red-50 border-red-200 text-red-700'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}
            />
            {isOnline ? 'Live' : 'Offline'}
          </div>
        </div>
      </header>

      {/* ── Overview ────────────────────────────────────────────────────── */}
      <motion.main
        className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8"
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        {/* Greeting */}
        <div className="mb-6">
          <p className="text-sm text-gray-500 mb-0.5">
            {now ? format(now, 'EEEE, MMMM d') : ' '}
          </p>
          <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 tracking-tight leading-tight">
            {now ? greetingFor(now) : 'Welcome'}
            {companyName ? `, ${companyName}` : ''}
          </h1>
        </div>

        {/* KPI strip — the four numbers that matter, top-left first */}
        <section aria-label="Today's numbers" className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
          {kpis.map((kpi) => (
            <Link
              key={kpi.label}
              href={kpi.href}
              className="group bg-white border border-gray-200 rounded-xl p-4 hover:border-brand-300 hover:shadow-card transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-gray-500">{kpi.label}</span>
                {kpi.alert ? (
                  <CircleAlert className="w-3.5 h-3.5 text-red-500" aria-hidden="true" />
                ) : (
                  <ArrowUpRight
                    className="w-3.5 h-3.5 text-gray-300 group-hover:text-brand-500 transition-colors"
                    aria-hidden="true"
                  />
                )}
              </div>
              <div
                className={`font-mono text-[28px] leading-none font-semibold tabular-nums tracking-tight ${
                  kpi.alert ? 'text-red-600' : 'text-gray-900'
                }`}
              >
                {dataLoaded ? kpi.value : '–'}
              </div>
              <p className="text-xs text-gray-400 mt-1.5 truncate">{kpi.sub}</p>
            </Link>
          ))}
        </section>

        {/* Department pulse — live working/idle state per department */}
        {deptPulse.length > 0 && (
          <section aria-label="Department pulse" className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900">Departments</h2>
              <Link
                href="/tasks/by-department"
                className="text-xs font-medium text-brand-700 hover:text-brand-800 flex items-center gap-1"
              >
                View all
                <ArrowRight className="w-3 h-3" aria-hidden="true" />
              </Link>
            </div>
            <div className="flex flex-wrap gap-2">
              {deptPulse.map((d) => (
                <Link
                  key={d.id}
                  href={`/workspace/${d.slug}`}
                  className="flex items-center gap-2 pl-2.5 pr-3 py-2 bg-white border border-gray-200 rounded-lg hover:border-brand-300 hover:shadow-card transition-all min-h-[40px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
                >
                  <span className="text-base leading-none" aria-hidden="true">
                    {d.icon}
                  </span>
                  <span className="text-sm font-medium text-gray-800">{d.name}</span>
                  {d.open > 0 && (
                    <span className="text-xs font-mono tabular-nums font-medium text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">
                      {d.open}
                    </span>
                  )}
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      d.working ? 'bg-emerald-500 animate-pulse' : 'bg-gray-300'
                    }`}
                    title={d.working ? 'Agents working' : 'Idle'}
                  />
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Views — every destination, one click, no billboards */}
        <section aria-label="Views" className="mb-8">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Views</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {views.map((view) => (
              <Link
                key={view.route}
                href={view.route}
                className="group flex items-center gap-3 bg-white border border-gray-200 rounded-xl p-4 hover:border-brand-300 hover:shadow-card transition-all min-h-[72px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
              >
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${view.chip}`}
                  aria-hidden="true"
                >
                  {view.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-900 truncate">
                      {view.title}
                    </span>
                    {typeof view.badge === 'number' && view.badge > 0 && (
                      <span className="text-xs font-mono tabular-nums font-medium text-gray-500 bg-gray-100 rounded px-1.5 py-0.5 shrink-0">
                        {view.badge}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 truncate mt-0.5">{view.description}</p>
                </div>
                <ArrowUpRight
                  className="w-4 h-4 text-gray-300 group-hover:text-brand-500 transition-colors shrink-0"
                  aria-hidden="true"
                />
              </Link>
            ))}
          </div>
        </section>

        {/* Activity + system status */}
        <section aria-label="Recent activity" className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900">Recent activity</h2>
              <Link
                href="/tasks/all"
                className="text-xs font-medium text-brand-700 hover:text-brand-800 flex items-center gap-1"
              >
                Open board
                <ArrowRight className="w-3 h-3" aria-hidden="true" />
              </Link>
            </div>
            {!dataLoaded ? (
              <div className="flex items-center gap-2 py-6 justify-center text-gray-400 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                Loading activity…
              </div>
            ) : events.length === 0 ? (
              <div className="py-6 text-center">
                <p className="text-sm text-gray-500">No activity yet.</p>
                <p className="text-xs text-gray-400 mt-1">
                  Dispatch your first task from the board and your agents&rsquo; work will show up here.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {events.map((ev) => (
                  <li key={ev.id} className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
                    <span
                      className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${eventTone(ev.type)}`}
                      aria-hidden="true"
                    />
                    <p className="flex-1 min-w-0 text-sm text-gray-700 truncate">
                      {ev.message.replace(/^\[[A-Z0-9 _-]+\]\s*/, '')}
                    </p>
                    <span className="text-xs text-gray-400 shrink-0 whitespace-nowrap">
                      {formatDistanceToNow(new Date(ev.created_at), { addSuffix: true })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">System</h2>
            <ul className="space-y-2.5 flex-1">
              <li className="flex items-center justify-between gap-2">
                <span className="text-sm text-gray-600">Gateway</span>
                <span
                  className={`flex items-center gap-1.5 text-xs font-medium ${
                    isOnline ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {isOnline ? (
                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <CircleAlert className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                  {isOnline ? 'Operational' : 'Unreachable'}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-sm text-gray-600">Agents</span>
                <span className="text-xs font-mono tabular-nums font-medium text-gray-700">
                  {dataLoaded ? `${stats.agentsWorking} working / ${stats.agentsTotal}` : '–'}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span className="text-sm text-gray-600">Departments</span>
                <span className="text-xs font-mono tabular-nums font-medium text-gray-700">
                  {dataLoaded ? deptPulse.length : '–'}
                </span>
              </li>
            </ul>
            <Link
              href="/ceo-board"
              className="mt-4 flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-lg bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 min-h-[40px]"
            >
              <Activity className="w-4 h-4" aria-hidden="true" />
              Performance Board
            </Link>
          </div>
        </section>
      </motion.main>
    </div>
  );
}
