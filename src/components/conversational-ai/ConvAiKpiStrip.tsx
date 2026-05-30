'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  BookOpenCheck,
  Tag,
  Repeat,
  ShieldAlert,
  MoonStar,
} from 'lucide-react';
import type { ConvAiMetrics } from './types';

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

interface KpiCard {
  key: string;
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  available: boolean;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function ConvAiKpiStrip({ metrics }: { metrics?: Partial<ConvAiMetrics> }) {
  const cards: KpiCard[] = useMemo(() => {
    const esc = metrics?.escalationRate;
    const kb = metrics?.kbHitRate;
    const disc = metrics?.discountRedemptions;
    const fu = metrics?.followUpPerformance;
    const bot = metrics?.botSpamVolume;
    const quiet = metrics?.quietHoursImpact;

    return [
      {
        key: 'escalation',
        label: 'Escalation Rate',
        value: esc?.available ? pct(esc.data.rate) : '—',
        sub: esc?.available ? `${esc.data.escalated} of ${esc.data.total} conversations` : 'Not connected yet',
        icon: <AlertTriangle className="w-5 h-5" aria-hidden="true" />,
        available: !!esc?.available,
      },
      {
        key: 'kb',
        label: 'KB Hit Rate',
        value: kb?.available ? pct(kb.data.rate) : '—',
        sub: kb?.available ? `${kb.data.hits} of ${kb.data.total} lookups answered` : 'Not connected yet',
        icon: <BookOpenCheck className="w-5 h-5" aria-hidden="true" />,
        available: !!kb?.available,
      },
      {
        key: 'discount',
        label: 'Discount Redemptions',
        value: disc?.available ? `${disc.data.redeemed}` : '—',
        sub: disc?.available ? `${pct(disc.data.rate)} of ${disc.data.offered} offered` : 'Not connected yet',
        icon: <Tag className="w-5 h-5" aria-hidden="true" />,
        available: !!disc?.available,
      },
      {
        key: 'followup',
        label: 'Follow-up Writes',
        value: fu?.available ? `${fu.data.writes}` : '—',
        sub: fu?.available ? `across ${fu.data.contacts} contacts` : 'Not connected yet',
        icon: <Repeat className="w-5 h-5" aria-hidden="true" />,
        available: !!fu?.available,
      },
      {
        key: 'botspam',
        label: 'Bot / Spam Flagged',
        value: bot?.available ? `${bot.data.flaggedLines}` : '—',
        sub: bot?.available ? 'interactions flagged' : 'Not connected yet',
        icon: <ShieldAlert className="w-5 h-5" aria-hidden="true" />,
        available: !!bot?.available,
      },
      {
        key: 'quiet',
        label: 'Quiet-Hours Deferred',
        value: quiet?.available ? `${quiet.data.deferred}` : '—',
        sub: quiet?.available ? `${pct(quiet.data.rate)} of ${quiet.data.interrupts} interrupts` : 'Not connected yet',
        icon: <MoonStar className="w-5 h-5" aria-hidden="true" />,
        available: !!quiet?.available,
      },
    ];
  }, [metrics]);

  return (
    <motion.div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {cards.map((c) => (
        <motion.div
          key={c.key}
          variants={cardVariants}
          className="rounded-2xl p-5 min-h-[120px] flex flex-col justify-between border border-gray-100"
          style={{ backgroundColor: 'rgba(255,255,255,0.92)' }}
        >
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center justify-center w-9 h-9 rounded-xl ${
                c.available ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-400'
              }`}
            >
              {c.icon}
            </span>
            <span className="text-sm font-semibold text-gray-600">{c.label}</span>
          </div>
          <div>
            <span
              className="text-3xl font-black text-gray-900 leading-none"
              style={{ fontFamily: 'ui-monospace, monospace' }}
            >
              {c.value}
            </span>
            <p className="text-sm text-gray-500 mt-1">{c.sub}</p>
          </div>
        </motion.div>
      ))}
    </motion.div>
  );
}
