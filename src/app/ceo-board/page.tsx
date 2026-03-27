'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Settings, ChevronDown } from 'lucide-react';

// Redesign Components
import { CompanyHeroCard } from '@/components/ceo-board/redesign/CompanyHeroCard';
import { KPIStatCards } from '@/components/ceo-board/redesign/KPIStatCards';
import { ActiveAgentsStrip } from '@/components/ceo-board/redesign/ActiveAgentsStrip';
import { DepartmentPulseStrip } from '@/components/ceo-board/redesign/DepartmentPulseStrip';
import { PerformanceGaugeChart } from '@/components/ceo-board/redesign/PerformanceGaugeChart';
import { NeedsAttentionSection } from '@/components/ceo-board/redesign/NeedsAttentionSection';
import { RecommendationsRow } from '@/components/ceo-board/redesign/RecommendationsRow';
import { SectionContainer } from '@/components/ceo-board/redesign/SectionContainer';

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
  const [monthlyStats, setMonthlyStats] = useState({ tasksDone: 0, agentsActive: 0, tasksPerWeek: 0 });
  const [activeAgentCount, setActiveAgentCount] = useState(0);
  const [deptCount, setDeptCount] = useState(0);
  const [attentionCount, setAttentionCount] = useState(0);

  useEffect(() => {
    async function loadMonthlyStats() {
      try {
        const [wsRes, agentsRes] = await Promise.all([
          fetch('/api/workspaces?stats=true'),
          fetch('/api/agents'),
        ]);

        let departments: any[] = [];
        let agents: any[] = [];

        if (wsRes.ok) {
          departments = (await wsRes.json()).filter((d: any) => {
            const slug = d.slug || d.id;
            return slug !== 'default' && !slug.startsWith('acme-') && !slug.startsWith('zhw-');
          });
        }
        if (agentsRes.ok) agents = await agentsRes.json();

        const tasksDone = departments.reduce((s: number, d: any) => s + (d.taskCounts?.done || 0), 0);
        const agentsActive = agents.filter((a: any) => a.status === 'active' || a.status === 'working').length;
        const tasksPerWeek = tasksDone > 0 ? Math.max(1, Math.round(tasksDone / 4)) : 0;

        setMonthlyStats({ tasksDone, agentsActive, tasksPerWeek });
        setActiveAgentCount(agentsActive);
        setDeptCount(departments.length);

        // Count items needing attention
        let needsAttention = 0;
        for (const d of departments) {
          const total = d.taskCounts?.total || 0;
          const done = d.taskCounts?.done || 0;
          const blocked = d.taskCounts?.blocked || 0;
          const inProgress = d.taskCounts?.in_progress || 0;
          if (total === 0) continue;
          const score = Math.round(((done + inProgress * 0.5) / total) * 100);
          if (score < 60 || blocked > 0) needsAttention++;
        }
        setAttentionCount(needsAttention);
      } catch {
        // handled
      }
    }
    loadMonthlyStats();
  }, []);

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
          <button className="flex items-center justify-center w-10 h-10 rounded-full hover:bg-gray-200/60 transition-colors">
            <Settings className="h-5 w-5 text-gray-500" />
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
        <div className="max-w-[1600px] mx-auto space-y-12">
          {/* 1. Company Health Hero */}
          <motion.section variants={sectionVariants}>
            <CompanyHeroCard />
          </motion.section>

          {/* 2. KPI Stat Cards */}
          <motion.section variants={sectionVariants}>
            <KPIStatCards />
          </motion.section>

          {/* 2b. Monthly Activity Card */}
          <motion.section variants={sectionVariants}>
            <div className="bg-amber-50 rounded-2xl shadow-sm p-8 border-l-4 border-l-amber-400">
              <h3 className="text-xl font-bold text-gray-900 mb-6">Monthly Activity</h3>
              <div className="flex items-center justify-between">
                <div className="text-center flex-1">
                  <span className="text-kpi-value text-gray-900">{monthlyStats.tasksDone}</span>
                  <p className="text-base text-gray-600 mt-1">Tasks Done</p>
                </div>
                <div className="w-px h-16 bg-amber-200" />
                <div className="text-center flex-1">
                  <span className="text-kpi-value text-gray-900">{monthlyStats.agentsActive}</span>
                  <p className="text-base text-gray-600 mt-1">Agents Active</p>
                </div>
                <div className="w-px h-16 bg-amber-200" />
                <div className="text-center flex-1">
                  <span className="text-kpi-value text-gray-900">{monthlyStats.tasksPerWeek}</span>
                  <p className="text-base text-gray-600 mt-1">Tasks/Week</p>
                </div>
              </div>
            </div>
          </motion.section>

          {/* 3. Active Agents Strip */}
          <motion.section variants={sectionVariants}>
            <SectionContainer title="Active Agents" accentColor="bg-emerald-500" context={`${activeAgentCount} active`}>
              <ActiveAgentsStrip />
            </SectionContainer>
          </motion.section>

          {/* 4. Department Pulse Strip */}
          <motion.section variants={sectionVariants}>
            <SectionContainer title="Department Pulse" accentColor="bg-brand-500" context={`${deptCount} departments`}>
              <DepartmentPulseStrip />
            </SectionContainer>
          </motion.section>

          {/* 5. Performance Gauge + Chart */}
          <motion.section variants={sectionVariants}>
            <SectionContainer title="Performance" accentColor="bg-blue-500">
              <PerformanceGaugeChart />
            </SectionContainer>
          </motion.section>

          {/* 6. Needs Attention */}
          <motion.section variants={sectionVariants}>
            <NeedsAttentionSection />
          </motion.section>

          {/* 7. Recommendations */}
          <motion.section variants={sectionVariants}>
            <RecommendationsRow />
          </motion.section>

          {/* 8. Devil's Advocate Feed */}
          <motion.section variants={sectionVariants}>
            <DevilsAdvocateFeed />
          </motion.section>

          {/* 9. Execution Queue */}
          <motion.section variants={sectionVariants}>
            <ExecutionQueueSection />
          </motion.section>

          {/* 10. Manual KPI Entry */}
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
