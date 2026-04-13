'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { LayoutGrid, BarChart3, Kanban, ArrowRight, Activity, Brain } from 'lucide-react';
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
  const [companyName, setCompanyName] = useState('BlackCEO');

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
          if (data.name) setCompanyName(data.name);
        }
      } catch {}
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

  const cards: EntryCard[] = [
    {
      title: `${companyName} Kanban`,
      description: 'Task Management Board',
      detail: 'See all active tasks, work in progress, and completed items across every department in one unified view. This is where work gets done.',
      icon: <Kanban className="w-7 h-7 text-white" />,
      gradient: 'from-indigo-500 via-purple-500 to-pink-500',
      route: '/workspace/default',
      cta: 'Open Kanban Board',
    },
    {
      title: `${companyName} Departments`,
      description: 'Department View',
      detail: 'Browse all departments. Click any department to open its dedicated Kanban board, agents, and live feed.',
      icon: <LayoutGrid className="w-7 h-7 text-white" />,
      gradient: 'from-emerald-400 via-teal-500 to-cyan-500',
      route: '/workspace',
      cta: 'View Departments',
    },
    {
      title: `${companyName} Performance`,
      description: 'CEO Performance Board',
      detail: 'Company-wide analytics, department grades, agent roster, KPIs, benchmarks, and strategic recommendations. Your executive overview.',
      icon: <BarChart3 className="w-7 h-7 text-white" />,
      gradient: 'from-amber-400 via-orange-500 to-red-500',
      route: '/ceo-board',
      cta: 'View Performance',
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
  ];

  return (
    <div className="min-h-screen bg-[#F8F9FB] flex flex-col">
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
              <span className="text-gray-900 font-bold text-xl tracking-tight">{companyName}</span>
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
        <div className="max-w-5xl w-full">
          <Breadcrumb items={[{ label: 'Home' }]} />
        </div>
        <motion.div
          className="max-w-5xl w-full"
          initial="hidden"
          animate="visible"
          variants={containerVariants}
        >
          {/* Title */}
          <motion.div className="text-center mb-12" variants={cardVariants}>
            <h2 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
              Welcome to {companyName}
            </h2>
            <p className="text-gray-500 text-lg max-w-xl mx-auto">
              Choose where you want to go
            </p>
          </motion.div>

          {/* Entry Cards */}
          <motion.div
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch"
            variants={containerVariants}
          >
            {cards.map((card) => (
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
