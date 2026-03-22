'use client';

import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { LayoutDashboard, Calendar, ChevronLeft } from 'lucide-react';

// CEO Board Components
import { CompanyHealthSection } from '@/components/ceo-board/health';
import { DepartmentPerformanceSection } from '@/components/ceo-board/DepartmentPerformanceSection';
import { AnalyticsSection } from '@/components/ceo-board/AnalyticsSection';
import { BenchmarkingSection } from '@/components/ceo-board/BenchmarkingSection';
import { RecommendationsSection } from '@/components/ceo-board/RecommendationsSection';
import { ManualKPISection } from '@/components/ceo-board/ManualKPISection';
import { DevilsAdvocateFeed } from '@/components/ceo-board/DevilsAdvocateFeed';
import { AgentPerformanceSection } from '@/components/ceo-board/AgentPerformanceSection';
import { ExecutionQueueSection } from '@/components/ceo-board/ExecutionQueueSection';

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
  const currentDate = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <motion.div
      className="min-h-screen bg-[#F8F9FB]"
      variants={pageVariants}
      initial="hidden"
      animate="visible"
    >
      {/* Header */}
      <motion.header
        variants={sectionVariants}
        className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-gray-200 px-4 sm:px-6 lg:px-8"
      >
        <div className="h-16 flex items-center justify-between">
          {/* Left - Back Button & Title */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push('/workspace/default')}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 text-sm font-medium"
            >
              <ChevronLeft className="h-4 w-4" />
              Back to Dashboard
            </button>
            <div className="flex items-center gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-sm">
                <LayoutDashboard className="h-5 w-5 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">
                  CEO Performance Board
                </h1>
                <p className="text-xs text-gray-500 hidden sm:block">
                  Real-time AI workforce intelligence
                </p>
              </div>
            </div>
          </div>

          {/* Right - Date & Actions */}
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2 text-sm text-gray-500">
              <Calendar className="h-4 w-4" />
              <span>{currentDate}</span>
            </div>
            <div className="h-6 w-px bg-gray-200 hidden sm:block" />
            <div className="flex items-center gap-2">
              <div className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-medium text-emerald-600">Live</span>
            </div>
          </div>
        </div>
      </motion.header>

      {/* Main Content */}
      <main className="p-4 sm:p-6 lg:p-8">
        <div className="max-w-[1600px] mx-auto space-y-6">
          {/* Company Health Section */}
          <motion.section variants={sectionVariants}>
            <CompanyHealthSection />
          </motion.section>

          {/* Agent Performance Section */}
          <motion.section variants={sectionVariants}>
            <AgentPerformanceSection />
          </motion.section>

          {/* Two-Column Layout: Departments + Analytics */}
          <motion.section
            variants={sectionVariants}
            className="grid grid-cols-1 xl:grid-cols-2 gap-6"
          >
            {/* Left Column - Department Performance */}
            <div className="xl:col-span-1">
              <DepartmentPerformanceSection />
            </div>

            {/* Right Column - Analytics */}
            <div className="xl:col-span-1">
              <AnalyticsSection />
            </div>
          </motion.section>

          {/* Benchmarking Section */}
          <motion.section variants={sectionVariants}>
            <BenchmarkingSection />
          </motion.section>

          {/* Devil's Advocate Feed */}
          <motion.section variants={sectionVariants}>
            <DevilsAdvocateFeed />
          </motion.section>

          {/* Recommendations Section */}
          <motion.section variants={sectionVariants}>
            <RecommendationsSection />
          </motion.section>

          {/* Execution Queue Section */}
          <motion.section variants={sectionVariants}>
            <ExecutionQueueSection />
          </motion.section>

          {/* Manual KPI Entry Section */}
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