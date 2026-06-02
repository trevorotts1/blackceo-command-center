'use client';

import { motion } from 'framer-motion';
import { Lock, Sparkles } from 'lucide-react';
import Link from 'next/link';

/**
 * E2 — Layer-2 gate banner. Shown ONLY when the interview is definitively not
 * yet complete (E3: hidden when status is unknown so an already-onboarded
 * client is never nagged). Explains in plain English what the bottom section of
 * this page is and exactly what the operator needs to do to turn it on.
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
        {/* E2: plain-English heading — no jargon, no "locked" without context */}
        <h3 className="text-base font-bold text-indigo-900 flex items-center gap-2">
          <Sparkles className="w-4 h-4" aria-hidden="true" />
          A second analytics section is waiting below — complete the AI Workforce interview to turn it on
        </h3>
        <p className="text-sm text-indigo-800/90 mt-1 leading-relaxed">
          The bottom section of this page shows analytics tuned specifically to your business: your own
          KPI targets, a funnel built around your industry&apos;s customer journey, how your numbers compare
          to industry benchmarks, and a recommended-actions panel. It stays hidden until you have
          completed the AI Workforce interview, which is how the system learns your business context.
          All of your existing analytics above keep working right now — nothing resets when you
          complete the interview.
        </p>
        <Link
          href="/settings/intelligence"
          className="inline-flex items-center mt-3 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 transition-colors min-h-[44px]"
        >
          Go to AI Workforce interview
        </Link>
      </div>
    </motion.div>
  );
}
