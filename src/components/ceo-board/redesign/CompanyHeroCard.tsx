'use client';

/**
 * CompanyHeroCard — PRD 2.10 rebuild, U55 single-source pass
 *
 * ONE data source: `GET /api/company-health`, via `loadCompanyHeroData`
 * (`src/lib/ceo-board/company-health-client.ts` — a pure, framework-free
 * module, NO React, imported by this component and by
 * `NeedsAttentionSection.tsx`). Every headline number (grade, windowed
 * completion, all-time completion, tasks created, active agents, the
 * attention count, the four-input breakdown) comes from that single
 * response — this component itself never calls `fetch` a second time for
 * headline numbers (U55 acceptance (f) — see
 * tests/unit/company-health-client.test.ts for the contract test).
 *
 * score===null → explicit "Insufficient data" state, never 72 or 0 (never-72
 * doctrine). Same discipline applies to every windowed/breakdown figure.
 */

import { useEffect, useState, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { gradeToLabel } from '@/lib/grading';
import type { Grade, GradeInputKey } from '@/lib/grading';
import {
  loadCompanyHeroData,
  type ClientCompanyHealth,
} from '@/lib/ceo-board/company-health-client';

const GRADE_COLORS: Record<string, string> = {
  A: '#10B981',
  B: '#10B981',
  C: '#F59E0B',
  D: '#EF4444',
  F: '#EF4444',
};

function gradeColor(grade: string | null): string {
  if (!grade) return '#9CA3AF';
  return GRADE_COLORS[grade] ?? '#9CA3AF';
}

const INPUT_ORDER: GradeInputKey[] = ['throughput', 'qcPassRate', 'sopCoverage', 'kpiAttainment'];

/** Scrolls to the Needs Attention panel — same anchor pattern as the header's
 *  "Agents" tab (ceo-board/page.tsx handleTabClick / #agents-section). */
function scrollToNeedsAttention() {
  document.getElementById('needs-attention-section')?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
}

export function CompanyHeroCard() {
  const [health, setHealth] = useState<ClientCompanyHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        const data = await loadCompanyHeroData();
        if (!cancelled) setHealth(data);
      } catch {
        // handled by loading/null-health state
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const grade = health?.grade ?? null;
  const color = gradeColor(grade);
  const label = grade ? gradeToLabel(grade as Grade) : null;
  const sufficientData = health !== null && health.score !== null;

  const attentionItems = health?.attentionItems ?? [];
  const attentionCount = health?.attentionCount ?? attentionItems.length;

  const statusLine = useMemo(() => {
    if (!sufficientData) {
      return 'Your AI workforce is getting started. Check back after agents complete their first tasks to see your performance grade.';
    }
    if (attentionCount > 0) {
      return `Your company is performing ${(label ?? '').toLowerCase()}.`;
    }
    return 'Your company is performing well. All departments are on track.';
  }, [sufficientData, attentionCount, label]);

  const handleAttentionClick = useCallback(() => {
    scrollToNeedsAttention();
  }, []);

  if (loading) {
    return (
      <div className="w-full rounded-2xl p-8 animate-pulse"
        style={{ background: 'linear-gradient(135deg, var(--brand-900), var(--brand-800))' }}>
        <div className="flex flex-col items-center gap-4">
          <div className="h-24 w-24 rounded-full bg-white/20" />
          <div className="h-5 w-40 rounded bg-white/20" />
          <div className="h-4 w-64 rounded bg-white/20" />
          <div className="flex gap-4 mt-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 w-28 rounded-full bg-white/20" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const windowDays = health?.windowDays ?? 30;
  const windowedCompletion = health?.windowedCompletionRate ?? null;
  const allTimeCompletion = health?.allTime?.completionRate ?? null;
  const windowedCreated = health?.windowedTaskCounts?.created ?? 0;
  const activeAgents = health?.activeAgentCount ?? 0;

  return (
    <motion.div
      className="w-full rounded-[20px] px-6 py-8 sm:px-12 sm:py-10 shadow-lg"
      style={{ background: 'linear-gradient(135deg, var(--brand-900), var(--brand-800))' }}
      initial={{ scale: 0.96, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
    >
      <div className="flex flex-col items-center gap-2">
        {/* Grade display — real letter or insufficient-data state */}
        {sufficientData && grade ? (
          <>
            <span className="font-mono text-[96px] font-black text-white leading-none">
              {grade}
            </span>
            <span className="text-xl font-medium text-brand-300">
              {label}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-white/50 px-2 py-0.5 rounded-full bg-white/10">
              Last {windowDays} days
            </span>
          </>
        ) : (
          <>
            {/* Explicit insufficient-data state — never shows 72 or a fake grade */}
            <div className="w-24 h-24 rounded-full border-4 border-white/30 flex items-center justify-center">
              <span className="font-mono text-4xl font-bold text-white/50">—</span>
            </div>
            <span className="text-white/60 text-lg font-medium mt-1">Insufficient data</span>
          </>
        )}

        {/* Status line + click-through attention count (U55: ONE shared
            definition — see src/lib/ceo-board/attention.ts. The count here
            and the Needs Attention panel's rendered list length are
            guaranteed equal: both read health.attentionItems from this
            same /api/company-health response.) */}
        <p className="text-white/80 text-base text-center max-w-lg mt-1">
          {statusLine}{' '}
          {sufficientData && attentionCount > 0 && (
            <button
              type="button"
              onClick={handleAttentionClick}
              className="underline decoration-white/40 hover:decoration-white font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 rounded"
              aria-label={`${attentionCount} item${attentionCount === 1 ? '' : 's'} need attention — jump to Needs Attention`}
            >
              {attentionCount} item{attentionCount === 1 ? '' : 's'} need{attentionCount === 1 ? 's' : ''} attention.
            </button>
          )}
        </p>

        {/* Bottom stat pills — windowed headline numbers, each with a window
            badge (U55c). All-time completion is a secondary stat only. */}
        <div className="flex flex-wrap justify-center gap-2 sm:gap-3 mt-6">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/20">
            <span className="text-white text-base font-semibold">{windowedCreated}</span>
            <span className="text-white/70 text-sm">Tasks Created</span>
            <span className="text-white/50 text-[10px] font-semibold uppercase tracking-wide">
              {windowDays}d
            </span>
          </div>
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/20">
            <span className="text-white text-base font-semibold">{activeAgents}</span>
            <span className="text-white/70 text-sm">Active Agents</span>
            <span className="text-white/50 text-[10px] font-semibold uppercase tracking-wide">
              Live
            </span>
          </div>
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/20">
            {windowedCompletion !== null ? (
              <span className="text-white text-base font-semibold">{windowedCompletion}%</span>
            ) : (
              <span className="text-white/50 text-sm font-medium">Insufficient data</span>
            )}
            <span className="text-white/70 text-sm">Completion Rate</span>
            <span className="text-white/50 text-[10px] font-semibold uppercase tracking-wide">
              {windowDays}d
            </span>
          </div>
        </div>

        {/* All-time completion — secondary stat only, sourced from the same
            response (U55b). This is deliberately NOT a headline number: it
            can differ sharply from the windowed rate above (e.g. a young
            department with a bad backlog but a clean recent window). */}
        {allTimeCompletion !== null && (
          <p className="text-white/50 text-xs mt-2">
            All time: {allTimeCompletion}% completion ({health?.allTime?.completedTasks ?? 0} of{' '}
            {health?.allTime?.totalTasks ?? 0} tasks)
          </p>
        )}

        {/* "What drives this grade" — expandable four-input breakdown (U55c) */}
        {health && (
          <div className="w-full max-w-lg mt-4">
            <button
              type="button"
              onClick={() => setBreakdownOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 transition-colors text-white/80 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
              aria-expanded={breakdownOpen}
            >
              <span>What drives this grade</span>
              <span className="text-white/50">{breakdownOpen ? '−' : '+'}</span>
            </button>
            {breakdownOpen && (
              <div className="mt-2 rounded-xl bg-white/10 p-4 space-y-3">
                {INPUT_ORDER.map((key) => {
                  const entry = health.companyInputBreakdown?.[key];
                  if (!entry) return null;
                  return (
                    <div key={key} className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-white text-sm font-semibold">{entry.label}</p>
                        <p className="text-white/50 text-xs">
                          Weight {Math.round(entry.weight * 100)}%
                        </p>
                      </div>
                      <div className="text-right">
                        {entry.score !== null ? (
                          <p className="text-white text-sm font-semibold">{entry.score}%</p>
                        ) : (
                          <p className="text-white/50 text-xs max-w-[180px]">{entry.detail}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
