'use client';

import { motion } from 'framer-motion';
import { Target, Gauge, Lightbulb } from 'lucide-react';
import { SectionContainer } from '@/components/ceo-board/redesign/SectionContainer';
import { PixelFunnel } from './PixelFunnel';
import { EmptyState } from './EmptyState';
import type { EnrichedResponse } from './types';

/**
 * Layer-2 (persona-tuned) block. Rendered only when the interview is complete
 * and the enriched payload is unlocked. Each sub-panel handles its own empty
 * state so a freshly-completed interview with no historical data still renders
 * cleanly.
 */
export function Layer2Section({ enriched }: { enriched: EnrichedResponse }) {
  const priorityStyle: Record<string, string> = {
    high: 'bg-red-50 text-red-700 border-red-200',
    medium: 'bg-amber-50 text-amber-700 border-amber-200',
    low: 'bg-gray-50 text-gray-600 border-gray-200',
  };

  return (
    <motion.div
      className="space-y-6"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-wide">
          <Target className="w-3.5 h-3.5" aria-hidden="true" />
          Persona-tuned · Layer 2
        </span>
        {enriched.industry && (
          <span className="text-sm text-gray-500">Industry: {enriched.industry}</span>
        )}
      </div>

      {/* Business-specific KPIs */}
      <SectionContainer title="Business KPIs" accentColor="bg-indigo-500">
        {enriched.businessKPIs && enriched.businessKPIs.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {enriched.businessKPIs.map((k) => (
              <div key={k.id} className="rounded-xl border border-gray-100 p-4" style={{ backgroundColor: 'rgba(255,255,255,0.92)' }}>
                <p className="text-sm font-semibold text-gray-600">{k.name}</p>
                <p className="text-2xl font-black text-gray-900 mt-1" style={{ fontFamily: 'ui-monospace, monospace' }}>
                  {k.target}
                  <span className="text-base font-semibold text-gray-400 ml-1">{k.unit}</span>
                </p>
                <p className="text-xs text-gray-400 mt-1">target</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No business KPIs configured" hint="KPIs from your interview will appear here." />
        )}
      </SectionContainer>

      {/* Journey-template funnel */}
      <SectionContainer title="Journey-Template Funnel" accentColor="bg-blue-500" context={enriched.industry}>
        <PixelFunnel
          metric={
            enriched.journeyFunnel
              ? { available: enriched.journeyFunnel.available, data: enriched.journeyFunnel.stages }
              : undefined
          }
          emptyTitle="Journey funnel has no events yet"
          emptyHint="Your funnel re-contextualizes existing pixel events using your industry's journey template."
        />
      </SectionContainer>

      {/* Industry benchmarks */}
      <SectionContainer title="Industry Benchmarks" accentColor="bg-emerald-500">
        {enriched.benchmarks && enriched.benchmarks.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {enriched.benchmarks.map((b) => (
              <div key={b.metric} className="rounded-xl border border-gray-100 p-4" style={{ backgroundColor: 'rgba(255,255,255,0.92)' }}>
                <div className="flex items-center gap-2">
                  <Gauge className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                  <p className="text-sm font-semibold text-gray-600">{b.label}</p>
                </div>
                <p className="text-2xl font-black text-gray-900 mt-1" style={{ fontFamily: 'ui-monospace, monospace' }}>
                  {b.benchmark}
                  <span className="text-base font-semibold text-gray-400 ml-1">{b.unit}</span>
                </p>
                <p className="text-xs text-gray-400 mt-1">{b.note}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No benchmarks available" />
        )}
      </SectionContainer>

      {/* Recommended actions */}
      <SectionContainer title="Recommended Actions" accentColor="bg-amber-500">
        {enriched.recommendations && enriched.recommendations.length > 0 ? (
          <ul className="space-y-3">
            {enriched.recommendations.map((r) => (
              <li key={r.id} className="rounded-xl border border-gray-100 p-4 flex items-start gap-3" style={{ backgroundColor: 'rgba(255,255,255,0.92)' }}>
                <Lightbulb className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-base font-semibold text-gray-900">{r.title}</p>
                    <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded border ${priorityStyle[r.priority]}`}>
                      {r.priority} priority
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1 leading-relaxed">{r.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No recommendations yet" hint="Recommendations generate as Layer-1 signals accumulate." />
        )}
      </SectionContainer>
    </motion.div>
  );
}
