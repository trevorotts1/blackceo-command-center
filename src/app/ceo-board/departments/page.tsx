'use client';

import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ChevronLeft } from 'lucide-react';
import { DepartmentPerformanceSection } from '@/components/ceo-board/DepartmentPerformanceSection';
import { Breadcrumb } from '@/components/Breadcrumb';

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

export default function DepartmentBreakdownsPage() {
  const router = useRouter();

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
          {/* Left - Back Button & Breadcrumb/Title */}
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push('/ceo-board')}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 text-sm font-medium"
            >
              <ChevronLeft className="h-4 w-4" />
              Back to CEO Board
            </button>
            <div>
              <Breadcrumb
                items={[
                  { label: 'Home', href: '/' },
                  { label: 'CEO Board', href: '/ceo-board' },
                  { label: 'Departments' },
                ]}
              />
              <h1 className="text-page-title text-gray-900 mt-1">Departments</h1>
            </div>
          </div>

          {/* Right - Subtitle */}
          <div className="hidden sm:block">
            <p className="text-base text-gray-500">Performance overview by department</p>
          </div>
        </div>
      </motion.header>

      {/* Main Content */}
      <main className="p-4 sm:p-6 lg:p-8">
        <div className="max-w-[1600px] mx-auto">
          <motion.section variants={sectionVariants}>
            <DepartmentPerformanceSection />
          </motion.section>

          {/* Footer Spacer */}
          <motion.div variants={sectionVariants} className="h-8" />
        </div>
      </main>
    </motion.div>
  );
}
