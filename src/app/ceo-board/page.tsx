'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Settings, ChevronDown } from 'lucide-react';

// Redesign Components
import { CompanyHeroCard } from '@/components/ceo-board/redesign/CompanyHeroCard';
import { KPIStatCards } from '@/components/ceo-board/redesign/KPIStatCards';
import { ActiveAgentsStrip } from '@/components/ceo-board/redesign/ActiveAgentsStrip';
import { DepartmentPulseStrip } from '@/components/ceo-board/redesign/DepartmentPulseStrip';
import { MonthlyActivityChart } from '@/components/ceo-board/redesign/MonthlyActivityChart';
import { CompletionRateDonut } from '@/components/ceo-board/redesign/CompletionRateDonut';
import { SystemPulseSection } from '@/components/ceo-board/redesign/SystemPulseSection';
import { PerformanceGaugeChart } from '@/components/ceo-board/redesign/PerformanceGaugeChart';
import { NeedsAttentionSection } from '@/components/ceo-board/redesign/NeedsAttentionSection';
import { RecommendationsRow } from '@/components/ceo-board/redesign/RecommendationsRow';
import { SectionContainer } from '@/components/ceo-board/redesign/SectionContainer';
import { Breadcrumb } from '@/components/Breadcrumb';

// Existing bottom sections (kept as-is)
import { DevilsAdvocateFeed } from '@/components/ceo-board/DevilsAdvocateFeed';
import { ExecutionQueueSection } from '@/components/ceo-board/ExecutionQueueSection';
import { ManualKPISection } from '@/components/ceo-board/ManualKPISection';

// Nav tabs - only functional ones
const NAV_TABS = ['Dashboard', 'Departments', 'Agents'];

// Page-level animation variants
const pageVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
      delayChildren: 0.1,
    },
  },
};

const sectionVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.6,
      ease: [0.4, 0, 0.2, 1] as [number, number, number, number],
    },
  },
};

export default function CEOPerformanceBoardPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('Dashboard');

  const currentDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <motion.div
      className="min-h-screen relative"
      style={{
        backgroundImage: `url('/holo-bg.png')`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }}
      variants={pageVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Navigation Header */}
      <motion.header
        variants={sectionVariants}
        className="sticky top-0 z-50 h-16 flex items-center justify-between px-6"
        style={{
          backgroundColor: '#F0F0F0',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
        }}
      >
        {/* LEFT - Company name pill */}
        <div className="flex items-center">
          <button
            onClick={() => router.push('/')}
            className="px-4 py-2 rounded-full bg-white hover:bg-gray-50 transition-colors"
            style={{ border: '1px solid #CCCCCC' }}
          >
            <span className="text-sm font-medium text-[#1A1A1A]">BlackCEO</span>
          </button>
        </div>

        {/* CENTER - Text-only pill tabs */}
        <nav className="flex items-center gap-1">
          {NAV_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab);
                if (tab === 'Departments') router.push('/ceo-board/departments');
                if (tab === 'Agents') router.push('/agent-roster');
              }}
              className={`px-4 py-2 text-sm transition-colors ${
                activeTab === tab
                  ? 'bg-[#1A1A1A] text-white rounded-full font-medium'
                  : 'text-[#666666] hover:text-[#1A1A1A]'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>

        {/* RIGHT - Date + separator + LIVE + settings + avatar */}
        <div className="flex items-center gap-4">
          <span className="text-base text-gray-500 hidden sm:block">
            {currentDate}
          </span>
          <div className="h-5 w-px bg-gray-300 hidden sm:block" />
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-medium text-emerald-600">Live</span>
          </div>
          <button
            disabled
            title="Settings coming soon"
            className="flex items-center justify-center w-10 h-10 rounded-full text-gray-300 cursor-not-allowed transition-colors"
          >
            <Settings className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-1">
            <div className="h-9 w-9 rounded-full bg-emerald-600 flex items-center justify-center">
              <span className="text-white text-sm font-semibold">TO</span>
            </div>
            <ChevronDown className="h-3 w-3 text-gray-400" />
          </div>
        </div>
      </motion.header>

      {/* Main Content */}
      <main className="relative z-10 p-8">
        <div className="max-w-[1600px] mx-auto space-y-6">
          {/* Breadcrumb */}
          <Breadcrumb
            items={[
              { label: 'Home', href: '/' },
              { label: 'CEO Board' },
            ]}
          />

          {/* Page Title + Strategic Framing */}
          <div className="mb-2">
            <h1 className="text-3xl font-black text-gray-900 tracking-tight">
              CEO Overview
            </h1>
            <p className="text-base text-gray-500 font-medium mt-1">
              Strategic performance &amp; execution roadmap
            </p>
          </div>

          {/* 1. Company Health Hero */}
          <motion.section variants={sectionVariants}>
            <CompanyHeroCard />
          </motion.section>

          {/* 2. KPI Stat Cards */}
          <motion.section variants={sectionVariants}>
            <KPIStatCards />
          </motion.section>

          {/* 3. Bento Grid: Monthly Activity (8col) + Completion Rate & System Pulse (4col) */}
          <motion.section variants={sectionVariants}>
            <div className="grid grid-cols-12 gap-6">
              {/* Monthly Activity Chart - 8 columns */}
              <div className="col-span-12 lg:col-span-8">
                <MonthlyActivityChart />
              </div>
              {/* Performance Sidebar - 4 columns, stacked */}
              <div className="col-span-12 lg:col-span-4 flex flex-col gap-6">
                {/* Completion Rate Donut */}
                <div
                  className="rounded-2xl shadow-sm border-0 p-6 flex-1 flex items-center justify-center"
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.88)',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                  }}
                >
                  <CompletionRateDonut />
                </div>
                {/* System Pulse */}
                <div
                  className="rounded-2xl shadow-sm border-0 p-6"
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.88)',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                  }}
                >
                  <SystemPulseSection />
                </div>
              </div>
            </div>
          </motion.section>

          {/* 4. Active Agents Strip */}
          <motion.section variants={sectionVariants}>
            <SectionContainer title="Active Agents" accentColor="bg-emerald-500">
              <ActiveAgentsStrip />
            </SectionContainer>
          </motion.section>

          {/* 5. Department Pulse Strip */}
          <motion.section variants={sectionVariants}>
            <SectionContainer title="Department Pulse" accentColor="bg-brand-500">
              <DepartmentPulseStrip />
            </SectionContainer>
          </motion.section>

          {/* 6. Performance Gauge + Chart */}
          <motion.section variants={sectionVariants}>
            <SectionContainer title="Performance" accentColor="bg-blue-500">
              <PerformanceGaugeChart />
            </SectionContainer>
          </motion.section>

          {/* 7. Bento Grid: Execution Queue (4col) + Needs Attention (4col) + Devil's Advocate (4col) */}
          <motion.section variants={sectionVariants}>
            <div className="grid grid-cols-12 gap-6">
              {/* Execution Queue */}
              <div className="col-span-12 lg:col-span-4">
                <ExecutionQueueSection />
              </div>
              {/* Needs Attention */}
              <div className="col-span-12 lg:col-span-4">
                <NeedsAttentionSection />
              </div>
              {/* Devil's Advocate */}
              <div className="col-span-12 lg:col-span-4">
                <DevilsAdvocateFeed />
              </div>
            </div>
          </motion.section>

          {/* 8. Recommendations */}
          <motion.section variants={sectionVariants}>
            <RecommendationsRow />
          </motion.section>

          {/* 9. Manual KPI Entry */}
          <motion.section variants={sectionVariants}>
            <ManualKPISection />
          </motion.section>

          {/* Footer Spacer */}
          <motion.div variants={sectionVariants} className="h-8" />
        </div>
      </main>
    </motion.div>
  );
}
