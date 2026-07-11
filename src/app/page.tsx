'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { LayoutGrid, BarChart3, Kanban, ArrowRight, Activity, Brain, Settings, Terminal, MessagesSquare, BookOpen, Mic } from 'lucide-react';
import { useLogoUrl } from '@/hooks/useLogoUrl';
import { useCompanyBrand } from '@/hooks/useCompanyBrand';
import { format } from 'date-fns';
import { Breadcrumb } from '@/components/Breadcrumb';

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
    // same-origin board-read API (no bearer needed from the browser); on any
    // failure we leave presentSlugs empty and simply show no producer cards.
    async function loadWorkspaceSlugs() {
      try {
        const res = await fetch('/api/workspaces', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const list: Array<{ slug?: string }> = Array.isArray(data) ? data : [];
        setPresentSlugs(
          new Set(
            list
              .map((w) => String(w?.slug ?? '').toLowerCase())
              .filter(Boolean),
          ),
        );
      } catch {}
    }
    loadWorkspaceSlugs();
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

  const producerCards: EntryCard[] = producerBoardCandidates
    .filter((c) => presentSlugs.has(c.slug))
    .map(({ slug: _slug, ...card }) => card);

  // Slot any present producer cards in right after Conversational AI, preserving
  // the core seven-card order. Falls back to appending if that card ever moves.
  const conversationalIdx = cards.findIndex((c) => c.route === '/conversational-ai');
  const insertAt = conversationalIdx >= 0 ? conversationalIdx + 1 : cards.length;
  const visibleCards: EntryCard[] = producerCards.length
    ? [...cards.slice(0, insertAt), ...producerCards, ...cards.slice(insertAt)]
    : cards;

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
            {visibleCards.map((card) => (
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
            ))}
          </motion.div>

          {/* Footer */}
          <motion.div className="mt-12 text-center" variants={cardVariants}>
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-full text-gray-500 text-sm">
              <Activity className="w-4 h-4 text-indigo-500" />
              <span>{isOnline ? 'All systems operational' : 'System check failed'}</span>
            </div>
          </motion.div>
        </motion.div>
      </main>
    </div>
  );
}
