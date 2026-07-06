'use client';

import { useState, useEffect, useCallback } from 'react';
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
import { DepartmentGradeCards } from '@/components/ceo-board/redesign/DepartmentGradeCards';
import { Breadcrumb } from '@/components/Breadcrumb';

// Existing bottom sections (kept as-is)
import { DevilsAdvocateFeed } from '@/components/ceo-board/DevilsAdvocateFeed';
import { ExecutionQueueSection } from '@/components/ceo-board/ExecutionQueueSection';
import { PersonaGovernanceBoard } from '@/components/ceo-board/PersonaGovernanceBoard';
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
  const [companyName, setCompanyName] = useState('Command Center');
  const [showCampaignModal, setShowCampaignModal] = useState(false);
  const [campaignForm, setCampaignForm] = useState({
    name: '',
    description: '',
    department_ids: [] as string[],
    start_date: '',
    target_date: '',
  });
  const [campaignSubmitting, setCampaignSubmitting] = useState(false);
  const [availableDepartments, setAvailableDepartments] = useState<string[]>([]);

  // Load company name from config
  useEffect(() => {
    async function loadConfig() {
      try {
        const res = await fetch('/api/company/config');
        if (res.ok) {
          const config = await res.json();
          if (config.companyName) setCompanyName(config.companyName);
        }
      } catch {
        // fallback to default
      }
    }
    loadConfig();
    async function loadDepartments() {
      try {
        const res = await fetch('/api/departments');
        if (res.ok) {
          const data = await res.json();
          const names = (data.departments || []).map((d: any) => d.id || d.name).filter(Boolean);
          setAvailableDepartments(names);
        }
      } catch {
        // fallback: leave empty, user can still type department names manually
      }
    }
    loadDepartments();
  }, []);

  async function handleCreateCampaign(e: React.FormEvent) {
    e.preventDefault();
    if (!campaignForm.name.trim()) return;
    setCampaignSubmitting(true);
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: campaignForm.name.trim(),
          description: campaignForm.description.trim(),
          department_ids: campaignForm.department_ids,
          start_date: campaignForm.start_date || null,
          target_date: campaignForm.target_date || null,
        }),
      });
      if (!res.ok) throw new Error('Failed to create campaign');
      const { campaign } = await res.json();
      setShowCampaignModal(false);
      setCampaignForm({ name: '', description: '', department_ids: [], start_date: '', target_date: '' });
      router.push(`/campaigns/${campaign.id}`);
    } catch (err) {
      console.error('[campaign-create]', err);
    } finally {
      setCampaignSubmitting(false);
    }
  }

  // Shared by the desktop pill nav and the mobile tab-scroll row (below md).
  const handleTabClick = useCallback((tab: string) => {
    setActiveTab(tab);
    if (tab === 'Departments') {
      router.push('/ceo-board/departments');
      return;
    }
    if (tab === 'Agents') {
      // '/agent-roster' does not exist (404). This page already renders an
      // "Active Agents" section further down (Agent Performance lens) — jump
      // to it instead of navigating to a dead route.
      document.getElementById('agents-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [router]);

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
        className="sticky top-0 z-50 h-16 flex items-center justify-between gap-2 px-4 sm:px-6 bg-gray-100 shadow-sm"
      >
        {/* LEFT - Company name pill */}
        <div className="flex items-center min-w-0">
          <button
            onClick={() => router.push('/')}
            className="px-4 py-2 rounded-full bg-white border border-gray-300 hover:bg-gray-50 transition-colors truncate"
          >
            <span className="text-sm font-medium text-gray-900">{companyName}</span>
          </button>
        </div>

        {/* CENTER - Text-only pill tabs (desktop). Below md this collides
            with the left/right clusters, so it's hidden in favor of the
            horizontally-scrollable tab row rendered under the header. */}
        <nav className="hidden md:flex items-center gap-1">
          {NAV_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => handleTabClick(tab)}
              className={`px-4 py-2 text-sm transition-colors ${
                activeTab === tab
                  ? 'bg-gray-900 text-white rounded-full font-medium'
                  : 'text-gray-500 hover:text-gray-900'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>

        {/* RIGHT - New Campaign + Date + separator + LIVE + settings + avatar */}
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
            {/* New Campaign button — icon-only below sm to make room for the
                rest of the cluster. */}
            <button
              onClick={() => setShowCampaignModal(true)}
              aria-label="New Campaign"
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
            >
              <span className="text-base leading-none">+</span>
              <span className="hidden sm:inline">New Campaign</span>
            </button>
          <span className="text-base text-gray-500 hidden sm:block">
            {currentDate}
          </span>
          <div className="h-5 w-px bg-gray-300 hidden sm:block" />
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-medium text-emerald-600">Live</span>
          </div>
          {/* E25: route to /settings/intelligence (same destination as the main
               Intelligence settings card and the model pill in the kanban). */}
          <button
            onClick={() => router.push('/settings/intelligence')}
            title="Intelligence settings"
            aria-label="Open Intelligence settings"
            className="flex items-center justify-center w-10 h-10 rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
          >
            <Settings className="h-5 w-5" />
          </button>
          <div className="hidden sm:flex items-center gap-1">
            <div className="h-9 w-9 rounded-full bg-emerald-600 flex items-center justify-center">
              <span className="text-white text-sm font-semibold">TO</span>
            </div>
            <ChevronDown className="h-3 w-3 text-gray-400" />
          </div>
        </div>
      </motion.header>

      {/* Mobile tab row (md:hidden) — same tabs as the desktop center pill
          nav, in a horizontally-scrollable strip so they never collide with
          the header's left/right clusters below 768px. */}
      <div className="md:hidden flex items-center gap-2 overflow-x-auto px-4 py-2 bg-white border-b border-gray-200">
        {NAV_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => handleTabClick(tab)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              activeTab === tab
                ? 'bg-gray-900 text-white'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

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

          {/* ============================================================ */}
          {/* LENS 1: Business Operations KPIs                              */}
          {/* ============================================================ */}
          <motion.div variants={sectionVariants}>
            <div className="flex items-center gap-3 mb-4 mt-2">
              <div className="w-1.5 h-8 rounded-full bg-indigo-500 flex-shrink-0" />
              <div>
                <h2 className="text-xl font-bold text-gray-900 tracking-tight">Business Operations KPIs</h2>
                <p className="text-sm text-gray-500">Key performance indicators across your organization</p>
              </div>
            </div>
          </motion.div>

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

          {/* 5. Department Pulse Strip */}
          <motion.section variants={sectionVariants}>
            <SectionContainer title="Department Pulse" accentColor="bg-brand-500">
              <DepartmentPulseStrip />
            </SectionContainer>
          </motion.section>

          {/* ============================================================ */}
          {/* LENS 2: Agent Performance                                     */}
          {/* ============================================================ */}
          <motion.div variants={sectionVariants}>
            <div className="flex items-center gap-3 mb-4 mt-2">
              <div className="w-1.5 h-8 rounded-full bg-emerald-500 flex-shrink-0" />
              <div>
                <h2 className="text-xl font-bold text-gray-900 tracking-tight">Agent Performance</h2>
                <p className="text-sm text-gray-500">AI workforce activity, models, and execution metrics</p>
              </div>
            </div>
          </motion.div>

          {/* 4. Active Agents Strip — anchor target for the header's "Agents"
              tab (that tab used to router.push('/agent-roster'), a route
              that doesn't exist; it now scrolls here instead). scroll-mt-24
              offsets the sticky header so the section isn't tucked under it. */}
          <motion.section id="agents-section" variants={sectionVariants} className="scroll-mt-24">
            <SectionContainer title="Active Agents" accentColor="bg-emerald-500">
              <ActiveAgentsStrip />
            </SectionContainer>
          </motion.section>

          {/* 6. Performance Gauge + Chart */}
          <motion.section variants={sectionVariants}>
            <SectionContainer title="Performance" accentColor="bg-blue-500">
              <PerformanceGaugeChart />
            </SectionContainer>
          </motion.section>

          {/* 6b. Department Grade Cards (PRD 2.10 — real grading module) */}
          <motion.section variants={sectionVariants}>
            <SectionContainer title="Department Grades" accentColor="bg-indigo-500">
              <DepartmentGradeCards />
            </SectionContainer>
          </motion.section>

          {/* ============================================================ */}
          {/* LENS 3: Proactive Intelligence                                */}
          {/* ============================================================ */}
          <motion.div variants={sectionVariants}>
            <div className="flex items-center gap-3 mb-4 mt-2">
              <div className="w-1.5 h-8 rounded-full bg-amber-500 flex-shrink-0" />
              <div>
                <h2 className="text-xl font-bold text-gray-900 tracking-tight">Proactive Intelligence</h2>
                <p className="text-sm text-gray-500">Forward-looking insights, challenges, and recommendations</p>
              </div>
            </div>
          </motion.div>

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

          {/* 7b. Persona Governance (Wave 4 — live persona_assignment table) */}
          <motion.section variants={sectionVariants}>
            <PersonaGovernanceBoard />
          </motion.section>

          {/* 8. Recommendations */}
          <motion.section variants={sectionVariants}>
            <RecommendationsRow />
          </motion.section>

          {/* 9. Manual KPI Entry */}
          <motion.section variants={sectionVariants}>
            <ManualKPISection />
          </motion.section>

          {/* Campaign Creation Modal */}
          {showCampaignModal && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center">
              {/* Backdrop */}
              <div
                className="absolute inset-0 bg-black/40"
                onClick={() => setShowCampaignModal(false)}
              />
              {/* Modal panel */}
              <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 p-6">
                <h2 className="text-lg font-bold text-gray-900 mb-1">New Campaign</h2>
                <p className="text-sm text-gray-500 mb-5">
                  Create a cross-department initiative. Tasks from any department can be assigned to it.
                </p>

                <form onSubmit={handleCreateCampaign} className="space-y-4">
                  {/* Campaign name */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Campaign Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Q3 Book Launch"
                      value={campaignForm.name}
                      onChange={e => setCampaignForm(f => ({ ...f, name: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>

                  {/* Description */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description
                    </label>
                    <textarea
                      rows={2}
                      placeholder="What is this campaign trying to achieve?"
                      value={campaignForm.description}
                      onChange={e => setCampaignForm(f => ({ ...f, description: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                    />
                  </div>

                  {/* Department multi-select */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Departments Involved
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {availableDepartments.map(dept => {
                        const selected = campaignForm.department_ids.includes(dept);
                        return (
                          <button
                            key={dept}
                            type="button"
                            onClick={() =>
                              setCampaignForm(f => ({
                                ...f,
                                department_ids: selected
                                  ? f.department_ids.filter(d => d !== dept)
                                  : [...f.department_ids, dept],
                              }))
                            }
                            className={`text-xs px-3 py-1 rounded-full font-medium capitalize transition-colors ${
                              selected
                                ? 'bg-indigo-600 text-white'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}
                          >
                            {dept}
                          </button>
                        );
                      })}
                      {availableDepartments.length === 0 && (
                        <span className="text-xs text-gray-400">No departments loaded</span>
                      )}
                    </div>
                  </div>

                  {/* Date range */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Start Date
                      </label>
                      <input
                        type="date"
                        value={campaignForm.start_date}
                        onChange={e => setCampaignForm(f => ({ ...f, start_date: e.target.value }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Target Date
                      </label>
                      <input
                        type="date"
                        value={campaignForm.target_date}
                        onChange={e => setCampaignForm(f => ({ ...f, target_date: e.target.value }))}
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex justify-end gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowCampaignModal(false)}
                      className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={campaignSubmitting || !campaignForm.name.trim()}
                      className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {campaignSubmitting ? 'Creating...' : 'Create Campaign'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Footer Spacer */}
          <motion.div variants={sectionVariants} className="h-8" />
        </div>
      </main>
    </motion.div>
  );
}
