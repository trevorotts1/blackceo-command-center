'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { LayoutGrid, BarChart3, Kanban, ArrowRight, Activity, Brain, Settings, Terminal, MessagesSquare, BookOpen, Mic, Sparkles } from 'lucide-react';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { useCompanyBrand } from '@/hooks/useCompanyBrand';
import { format } from 'date-fns';
import { Breadcrumb } from '@/components/Breadcrumb';
import {
  WORKSPACES_RETRY_MS,
  parseWorkspaceSlugs,
  buildWorkspacesFetchFailedEvent,
  selectProducerCardSlugs,
} from '@/lib/dashboard-workspaces';

const cardVariants = {
  hidden: { opacity: 0, y: 30, scale: 0.95 },
  visible: {
    opacity: 1, y: 0, scale: 1,
    transition: { type: 'spring' as const, stiffness: 100, damping: 15 },
  },
};

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.12, delayChildren: 0.05 } },
};

interface EntryCard {
  title: string;
  description: string;
  detail: string;
  icon: React.ReactNode;
  gradient: string;
  route: string;
  cta: string;
  /** P1-03 step 1: when true, this slot renders as a non-navigable degraded
   *  placeholder (not a real card) instead of a Link. Used ONLY for the
   *  producer-board "fetch failed" state — see loadWorkspaceSlugs below. */
  degraded?: boolean;
}

export default function HomePage() {
  const logoUrl = useLogoUrl();
  const brand = useCompanyBrand();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isOnline, setIsOnline] = useState(true);
  // PRD 3.7: initial state must be empty so white-label deployments never flash "BlackCEO".
  const [companyName, setCompanyName] = useState('');
  const [companyLoaded, setCompanyLoaded] = useState(false);
  // Slugs of the workspaces this deployment actually has seeded. Used to gate
  // producer-board cards (below) so a CC without a given engine never renders a
  // dead-link card. Empty until /api/workspaces resolves.
  const [presentSlugs, setPresentSlugs] = useState<Set<string>>(new Set());
  // P1-03 c.1: 'loading' until the first attempt settles; 'error' means the
  // most recent /api/workspaces attempt failed (network error or non-2xx) and
  // a retry is scheduled — the producer-card slot renders a visible degraded
  // state instead of silently showing nothing. 'ok' means the last attempt
  // succeeded (presentSlugs reflects real data, possibly empty).
  const [workspacesStatus, setWorkspacesStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  // P1-03 c.3: build-generation version stamp, read from GET /api/version.
  // Null until resolved; the footer renders nothing extra until then so a slow
  // read never shows a wrong/blank version string.
  const [ccVersion, setCcVersion] = useState<string | null>(null);
  // P5-01: the "My AI CEO" BETA surface only appears when the feature flag is on
  // for this box. Null until resolved so the card never flashes then vanishes.
  const [ceoBetaEnabled, setCeoBetaEnabled] = useState<boolean | null>(null);

  const hasBrand = brand.primaryColor && brand.secondaryColor;
  const cardBackground = hasBrand
    ? { background: `linear-gradient(135deg, ${brand.primaryLight}, ${brand.secondaryLight})` }
    : null;
  const headerGradient = hasBrand
    ? { background: `linear-gradient(135deg, ${brand.primaryColor}, ${brand.secondaryColor})` }
    : null;

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    async function fetchCompany() {
      try {
        const res = await fetch('/api/company', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          const name = data?.name || data?.company?.name || '';
          if (name) setCompanyName(name);
        }
      } catch {}
      finally {
        setCompanyLoaded(true);
      }
    }
    fetchCompany();
  }, []);

  useEffect(() => {
    async function checkConnection() {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timeoutId);
        setIsOnline(res.ok);
      } catch {
        setIsOnline(false);
      }
    }
    checkConnection();
    const interval = setInterval(checkConnection, 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    // Discover which workspaces this deployment has so producer-board cards only
    // render when their engine is actually present. /api/workspaces is a
    // same-origin board-read API (no bearer needed from the browser).
    //
    // P1-03 root-cause class 3: a fetch failure used to leave presentSlugs
    // empty and silently show NO producer cards — indistinguishable from "this
    // box just doesn't have that engine." Now: on failure we set
    // workspacesStatus='error' (the render below shows a visible degraded slot
    // with retry copy, never silent omission), log a
    // `dashboard_workspaces_fetch_failed` event so the failure has a durable
    // record, and retry automatically after WORKSPACES_RETRY_MS.
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function logFetchFailedEvent(reason: string) {
      // Fire-and-forget; a failure to log must never block the retry loop or
      // throw into the render path.
      fetch('/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildWorkspacesFetchFailedEvent(attempt, reason)),
      }).catch(() => {});
    }

    async function loadWorkspaceSlugs() {
      attempt += 1;
      try {
        const res = await fetch('/api/workspaces', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (cancelled) return;
        setPresentSlugs(parseWorkspaceSlugs(data));
        setWorkspacesStatus('ok');
      } catch (err) {
        if (cancelled) return;
        setWorkspacesStatus('error');
        logFetchFailedEvent(err instanceof Error ? err.message : 'unknown error');
        retryTimer = setTimeout(loadWorkspaceSlugs, WORKSPACES_RETRY_MS);
      }
    }

    loadWorkspaceSlugs();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    // P1-03 step 3: version stamp so build-generation drift ("you're on
    // v5.14.0, current is v5.17.0") is diagnosable at a glance. Best-effort —
    // a failed read just leaves the footer without a version chip.
    async function loadVersion() {
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data?.version === 'string' && data.version) {
          setCcVersion(data.version);
        }
      } catch {}
    }
    loadVersion();
  }, []);

  useEffect(() => {
    // P5-01: is the My AI CEO BETA surface enabled on this box? Best-effort — a
    // failed read just leaves the card hidden (fail-safe: never a dead BETA link).
    async function loadCeoBeta() {
      try {
        const res = await fetch('/api/ceo-chat/status', { cache: 'no-store' });
        if (!res.ok) {
          setCeoBetaEnabled(false);
          return;
        }
        const data = await res.json();
        setCeoBetaEnabled(data?.enabled === true);
      } catch {
        setCeoBetaEnabled(false);
      }
    }
    loadCeoBeta();
  }, []);

  // PRD 3.8 + v4.0.1 P0-1: landing layout. Operator Console is the 5th card.
  // F52: Conversational AI analytics is the 7th card (fills the next 3-col slot).
  const cards: EntryCard[] = [
    {
      title: 'View All Tasks',
      description: 'Master view with department sidebar',
      detail: 'Every active task across every department in one Kanban. Use the left sidebar to switch the focused department without losing the view.',
      icon: <Kanban className="w-7 h-7 text-white" />,
      gradient: 'from-indigo-500 via-purple-500 to-pink-500',
      route: '/tasks/all',
      cta: 'Open All Tasks',
    },
    {
      title: 'Departments',
      description: 'Focus mode, one department at a time',
      detail: 'Pick a department, get a department-only Kanban and department-only KPIs. Use the back button to return to the picker.',
      icon: <LayoutGrid className="w-7 h-7 text-white" />,
      gradient: 'from-emerald-400 via-teal-500 to-cyan-500',
      route: '/tasks/by-department',
      cta: 'Pick a Department',
    },
    {
      title: 'Performance Board',
      description: 'CEO Performance Overview',
      detail: 'Company-wide analytics, department grades, agent roster, KPIs, benchmarks, and strategic recommendations.',
      icon: <BarChart3 className="w-7 h-7 text-white" />,
      gradient: 'from-amber-400 via-orange-500 to-red-500',
      route: '/ceo-board',
      cta: 'View Performance',
    },
    {
      title: 'Conversational AI',
      description: 'Live conversation analytics',
      detail: 'Channel volume, conversations over time, sentiment, escalations, top objections, KB hit rate, and pixel-funnel performance across every messaging surface. Unlocks persona-tuned views once your AI Workforce interview is complete.',
      icon: <MessagesSquare className="w-7 h-7 text-white" />,
      gradient: 'from-fuchsia-500 via-pink-500 to-rose-500',
      route: '/conversational-ai',
      cta: 'View Conversations',
    },
    {
      title: 'Intelligence Settings',
      description: 'AI Configuration',
      detail: 'Manage which AI models and personas power each department and role. Fine-tune your workforce intelligence.',
      icon: <Brain className="w-7 h-7 text-white" />,
      gradient: 'from-violet-500 via-purple-500 to-fuchsia-500',
      route: '/settings/intelligence',
      cta: 'Configure AI',
    },
    {
      title: 'Operator Console',
      description: 'Your direct workspace',
      detail: 'Chat with operator-level AIs, generate media, take notes, track goals, journal, search your memory, run research, make voice calls, and dispatch the Web Agent.',
      icon: <Terminal className="w-7 h-7 text-white" />,
      gradient: 'from-cyan-500 via-sky-500 to-blue-600',
      route: '/operator',
      cta: 'Open Console',
    },
    {
      title: 'Company Settings',
      description: 'Company configuration',
      detail: 'Update company name, brand colors, logo, and white-label settings for this deployment.',
      icon: <Settings className="w-7 h-7 text-white" />,
      gradient: 'from-slate-500 via-gray-600 to-zinc-700',
      route: '/settings/company',
      cta: 'Open Settings',
    },
  ];

  // Producer-board cards. These are approval/production surfaces that exist ONLY
  // on a deployment whose matching workspace is seeded (e.g. the Anthology or
  // Podcast engine). They are gated on workspace-slug presence — NEVER hardcoded
  // on — so a Command Center without that engine shows no dead-link card. Add a
  // new entry here (slug must match the seeded workspace slug) to surface any
  // future producer board the same way.
  const producerBoardCandidates: Array<EntryCard & { slug: string }> = [
    {
      slug: 'anthology',
      title: 'Anthology',
      description: 'Producer approval board',
      detail: 'Review each chapter and the final assembly, then approve or send back for a rewrite. Participant progress (S0→S9), the gate panel, and sign-off in one place.',
      icon: <BookOpen className="w-7 h-7 text-white" />,
      gradient: 'from-teal-400 via-cyan-500 to-sky-500',
      route: '/workspace/anthology',
      cta: 'Open Producer Board',
    },
    {
      slug: 'podcast',
      title: 'Podcast',
      description: 'Episodes and production',
      detail: 'The Podcast department board — episodes moving through production, from planning to publish. Manage and approve podcast work in one Kanban.',
      icon: <Mic className="w-7 h-7 text-white" />,
      gradient: 'from-orange-400 via-amber-500 to-red-500',
      route: '/workspace/podcast',
      cta: 'Open Podcast Board',
    },
  ];

  // P1-03 c.1: when the workspaces fetch has FAILED, we don't know whether
  // Anthology/Podcast engines are present — render one visible degraded slot
  // instead of silently showing zero producer cards (the old fail-EMPTY
  // behavior). While loading (first attempt, not yet settled) or once it
  // succeeds, behave as before: gate strictly on presentSlugs. The selection
  // decision itself lives in the pure, unit-tested selectProducerCardSlugs()
  // (src/lib/dashboard-workspaces.ts) — this just maps its answer onto the
  // EntryCard shape this component renders.
  const selection = selectProducerCardSlugs(workspacesStatus, presentSlugs, producerBoardCandidates);
  const producerCards: EntryCard[] = selection.degraded
    ? [
        {
          title: 'Producer Boards',
          description: 'Board data unavailable — retrying',
          detail: `We couldn't confirm which producer boards this deployment has. Retrying automatically every ${WORKSPACES_RETRY_MS / 1000} seconds.`,
          icon: <Activity className="w-7 h-7 text-white" />,
          gradient: 'from-slate-500 via-gray-500 to-zinc-600',
          route: '',
          cta: 'Retrying…',
          degraded: true,
        },
      ]
    : producerBoardCandidates
        .filter((c) => selection.slugs.includes(c.slug))
        .map(({ slug: _slug, ...card }) => card);

  // Slot any present producer cards in right after Conversational AI, preserving
  // the core seven-card order. Falls back to appending if that card ever moves.
  const conversationalIdx = cards.findIndex((c) => c.route === '/conversational-ai');
  const insertAt = conversationalIdx >= 0 ? conversationalIdx + 1 : cards.length;
  const coreCards: EntryCard[] = producerCards.length
    ? [...cards.slice(0, insertAt), ...producerCards, ...cards.slice(insertAt)]
    : cards;

  // P5-01: the "My AI CEO" BETA card leads the grid (a prominent, deliberate
  // competitor to Telegram) — but ONLY when the flag is enabled on this box.
  const ceoCard: EntryCard = {
    title: 'My AI CEO',
    description: 'Talk directly to your agent · BETA',
    detail: 'Chat with your main AI agent in a clean UI — send requests, upload documents, images, and videos, and watch what happens live. A direct line, right here.',
    icon: <Sparkles className="w-7 h-7 text-white" />,
    // U60/JM-U63b — re-toned off the indigo/purple/fuchsia palette to the
    // brand-green scale in the same pass that re-skinned /my-ai-ceo itself.
    gradient: 'from-brand-500 via-brand-600 to-brand-700',
    route: '/my-ai-ceo',
    cta: 'Open My AI CEO',
  };
  const visibleCards: EntryCard[] = ceoBetaEnabled ? [ceoCard, ...coreCards] : coreCards;

  return (
    <div className="min-h-screen bg-bcc-bg flex flex-col">
      {/* Header */}
      <header className="h-16 bg-white border-b border-gray-200 px-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          {logoUrl ? (
            <img src={logoUrl} alt="Command Center" className="h-9 w-auto" />
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-9 h-9 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center">
                <BarChart3 className="w-5 h-5 text-white" />
              </div>
              {companyLoaded ? (
                companyName ? (
                  <span className="text-gray-900 font-bold text-xl tracking-tight">{companyName}</span>
                ) : null
              ) : (
                <span
                  aria-hidden="true"
                  className="inline-block h-5 w-32 rounded bg-gray-200 animate-pulse"
                />
              )}
            </div>
          )}
          <div className="h-6 w-px bg-gray-200 mx-2" />
          <h1 className="text-gray-900 font-semibold text-lg">Command Center</h1>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-gray-500 text-base font-mono">
            {format(currentTime, 'MMM d, HH:mm:ss')}
          </span>
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium ${
            isOnline
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}>
            <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
            {isOnline ? 'LIVE' : 'OFFLINE'}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 py-4">
        <div className="max-w-7xl w-full">
          <Breadcrumb items={[{ label: 'Home' }]} />
        </div>
        <motion.div
          className="max-w-7xl w-full"
          initial="hidden"
          animate="visible"
          variants={containerVariants}
        >
          {/* Title */}
          <motion.div className="text-center mb-12" variants={cardVariants}>
            <h2 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
              {companyLoaded ? (
                companyName ? `Welcome to ${companyName}` : 'Welcome to your Command Center'
              ) : (
                <span
                  aria-hidden="true"
                  className="inline-block h-10 sm:h-12 w-72 rounded bg-gray-200 animate-pulse align-middle"
                />
              )}
            </h2>
            <p className="text-gray-500 text-lg max-w-xl mx-auto">
              Choose where you want to go
            </p>
          </motion.div>

          {/* Entry Cards */}
          <motion.div
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 items-stretch"
            variants={containerVariants}
          >
            {visibleCards.map((card) => {
              // P1-03 c.1: degraded slot is NOT a navigable card — render the
              // same visual footprint (so the grid doesn't jump) with retry
              // copy and no Link, so a fetch failure is loud but not a
              // dead-link trap.
              if (card.degraded) {
                return (
                  <motion.div
                    key="producer-boards-degraded"
                    className="relative w-full h-full"
                    variants={cardVariants}
                    data-testid="producer-boards-degraded"
                  >
                    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-slate-500 via-gray-500 to-zinc-600 p-8 h-full min-h-[320px] flex flex-col shadow-xl shadow-gray-200/50">
                      <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/10 rounded-full blur-2xl" />
                      <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-black/5 rounded-full blur-xl" />
                      <div className="relative z-10 flex flex-col h-full">
                        <div className="w-12 h-12 bg-white/20 backdrop-blur-sm rounded-2xl flex items-center justify-center mb-5">
                          {card.icon}
                        </div>
                        <h3 className="text-white font-bold text-xl mb-1 leading-tight">{card.title}</h3>
                        <p className="text-white/70 text-sm font-semibold uppercase tracking-wider mb-4">{card.description}</p>
                        <p className="text-white/75 text-sm leading-relaxed flex-1">{card.detail}</p>
                        <div className="mt-6 flex items-center gap-2 text-white font-semibold text-sm">
                          <span className="w-2 h-2 rounded-full bg-white/70 animate-pulse" />
                          <span>{card.cta}</span>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              }

              return (
                <motion.div
                  key={card.route}
                  className="group relative w-full h-full"
                  variants={cardVariants}
                  whileHover={{ scale: 1.03, transition: { type: 'spring' as const, stiffness: 300, damping: 20 } }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Link href={card.route} className="block text-left h-full">
                    <div
                      className={`relative overflow-hidden rounded-2xl ${cardBackground ? '' : `bg-gradient-to-br ${card.gradient}`} p-8 h-full min-h-[320px] flex flex-col shadow-xl shadow-gray-200/50 group-hover:shadow-2xl group-hover:shadow-gray-300/50 transition-shadow duration-300`}
                      style={cardBackground || undefined}
                    >
                      {/* Decorative */}
                      <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/10 rounded-full blur-2xl" />
                      <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-black/5 rounded-full blur-xl" />

                      <div className="relative z-10 flex flex-col h-full">
                        {/* Icon */}
                        <div className="w-12 h-12 bg-white/20 backdrop-blur-sm rounded-2xl flex items-center justify-center mb-5">
                          {card.icon}
                        </div>

                        {/* Title + subtitle */}
                        <h3 className="text-white font-bold text-xl mb-1 leading-tight">{card.title}</h3>
                        <p className="text-white/70 text-sm font-semibold uppercase tracking-wider mb-4">{card.description}</p>

                        {/* Detail */}
                        <p className="text-white/75 text-sm leading-relaxed flex-1">{card.detail}</p>

                        {/* CTA */}
                        <div className="mt-6 flex items-center gap-2 text-white font-semibold text-sm">
                          <span>{card.cta}</span>
                          <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-200" />
                        </div>
                      </div>
                    </div>
                  </Link>
                </motion.div>
              );
            })}
          </motion.div>

          {/* Footer */}
          <motion.div className="mt-12 text-center" variants={cardVariants}>
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-full text-gray-500 text-sm">
              <Activity className="w-4 h-4 text-indigo-500" />
              <span>{isOnline ? 'All systems operational' : 'System check failed'}</span>
              {/* P1-03 step 3: version stamp — makes build-generation drift
                  diagnosable at a glance ("you're on v5.14.0, current is
                  v5.17.0"). Omitted entirely if /api/version hasn't resolved. */}
              {ccVersion ? (
                <>
                  <span className="text-gray-300" aria-hidden="true">·</span>
                  <span data-testid="cc-version-stamp" className="font-mono text-xs text-gray-400">
                    {ccVersion}
                  </span>
                </>
              ) : null}
            </div>
          </motion.div>
        </motion.div>
      </main>
    </div>
  );
}
