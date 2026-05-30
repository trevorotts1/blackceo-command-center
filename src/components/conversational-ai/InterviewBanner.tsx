'use client';

import { motion } from 'framer-motion';
import { Lock, Sparkles } from 'lucide-react';
import Link from 'next/link';

/**
 * Layer-2 gate banner. Shown ONLY when the interview is not yet complete.
 * Explains what unlocks and links to the AI Workforce settings. It is an
 * informational status, never an error.
 *
 * Accessibility: not color-only — the lock icon + explicit copy carry the
 * meaning. role="status" announces it politely.
 */
export function InterviewBanner() {
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5 flex items-start gap-4"
    >
      <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-indigo-100 text-indigo-700 shrink-0">
        <Lock className="w-5 h-5" aria-hidden="true" />
      </span>
      <div className="flex-1">
        <h3 className="text-base font-bold text-indigo-900 flex items-center gap-2">
          <Sparkles className="w-4 h-4" aria-hidden="true" />
          Persona-tuned views are locked
        </h3>
        <p className="text-sm text-indigo-800/90 mt-1 leading-relaxed">
          Complete your AI Workforce interview to unlock persona-aligned funnels,
          business-specific KPIs, journey-template funnels, industry benchmarks,
          and a recommended-actions panel. Your universal analytics below keep
          working in the meantime — and your history is preserved, not reset, when
          Layer 2 turns on.
        </p>
        <Link
          href="/settings/intelligence"
          className="inline-flex items-center mt-3 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors min-h-[44px]"
        >
          Complete the AI Workforce interview
        </Link>
      </div>
    </motion.div>
  );
}
