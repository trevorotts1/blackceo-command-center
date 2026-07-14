'use client';

/**
 * NeedsAttentionSection — U55 single-source pass
 *
 * Renders `health.attentionItems` from `GET /api/company-health` verbatim —
 * no local re-classification. Before U55 this component computed its own
 * "needs attention" rule (`grade === 'F' | 'D'` or `blocked > 0`) from a
 * SEPARATE `/api/workspaces?stats=true` fetch, independently of the CEO
 * hero's inline rule; the two could (and did) diverge. Now both the hero's
 * count and this panel's list come from the ONE shared classification in
 * `src/lib/ceo-board/attention.ts`, computed once server-side — their
 * lengths cannot disagree because they are the same array.
 *
 * id="needs-attention-section" is the CompanyHeroCard's click-through
 * scroll target (scrollToNeedsAttention()).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ChevronRight, CheckCircle } from 'lucide-react';
import type { AttentionItem } from '@/lib/ceo-board/attention';
import { loadCompanyHeroData } from '@/lib/ceo-board/company-health-client';

const DEPARTMENT_EMOJIS: Record<string, string> = {
  marketing: '\u{1F4E2}',
  sales: '\u{1F4BC}',
  creative: '\u{1F3A8}',
  operations: '\u{2699}\u{FE0F}',
  billing: '\u{1F4B0}',
  support: '\u{1F3A7}',
  hr: '\u{1F465}',
  finance: '\u{1F4CA}',
  legal: '\u{2696}\u{FE0F}',
  product: '\u{1F4E6}',
  engineering: '\u{1F4BB}',
  design: '✨',
  'customer-success': '\u{1F91D}',
  'account-management': '\u{1F511}',
  'business-development': '\u{1F4C8}',
  'content-marketing': '✍\u{FE0F}',
  'social-media': '\u{1F4F1}',
};

const DEPT_COLORS: Record<string, string> = {
  marketing: '#7C4DFF',
  sales: '#00897B',
  creative: '#E91E63',
  operations: '#F57C00',
  billing: '#43A047',
  support: '#1E88E5',
  hr: '#8E24AA',
  finance: '#00ACC1',
  legal: '#6D4C41',
  product: '#5C6BC0',
  engineering: '#039BE5',
  design: '#D81B60',
};

function getDeptColor(slug: string): string {
  return DEPT_COLORS[slug] || '#78909C';
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.4,
      ease: [0.4, 0, 0.2, 1] as [number, number, number, number],
    },
  },
};

export function NeedsAttentionSection() {
  const router = useRouter();
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        // Same endpoint, same shared classification the hero card reads —
        // see loadCompanyHeroData in ./CompanyHeroCard (COMPANY_HEALTH_ENDPOINT).
        const health = await loadCompanyHeroData();
        if (!cancelled) setItems(health.attentionItems ?? []);
      } catch {
        // handled
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div id="needs-attention-section" className="scroll-mt-24">
        <div className="h-6 w-40 bg-gray-200 rounded animate-pulse mb-4" />
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-16 rounded-xl bg-gray-200 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      id="needs-attention-section"
      className="scroll-mt-24 rounded-2xl shadow-sm border-0 p-6"
      style={{
        backgroundColor: 'rgba(255,255,255,0.88)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      {/* Header — item count here is the SAME number the hero card shows
          (both read health.attentionItems from GET /api/company-health) */}
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-xl font-bold text-[#1A1A1A]">Needs Attention</h2>
        {items.length > 0 && (
          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
            {items.length}
          </span>
        )}
      </div>

      {/* Items — full list, no truncation (a cap here would make the hero's
          count and this list's length disagree for large N) */}
      {items.length === 0 ? (
        <motion.div
          className="flex items-center gap-3 p-4 bg-white rounded-xl"
          style={{ boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <CheckCircle className="h-5 w-5 text-emerald-500 flex-shrink-0" />
          <span className="text-base font-medium text-gray-700">
            All departments are healthy
          </span>
        </motion.div>
      ) : (
        <motion.div
          className="space-y-3"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          {items.map((item) => (
            <motion.div
              key={item.id}
              variants={itemVariants}
              onClick={() => router.push(`/ceo-board/${item.slug}`)}
              className="flex items-center gap-4 p-4 bg-white rounded-xl cursor-pointer hover:shadow-md transition-shadow"
              style={{
                boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
                borderLeft:
                  item.severity === 'urgent'
                    ? '4px solid #EF4444'
                    : '4px solid #F59E0B',
              }}
            >
              {/* Dept avatar circle */}
              <div
                className="flex h-9 w-9 items-center justify-center rounded-full flex-shrink-0"
                style={{ backgroundColor: getDeptColor(item.slug) }}
              >
                <span className="text-white text-xs font-semibold">
                  {getInitials(item.name)}
                </span>
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <span className="text-base font-medium text-gray-900">
                  {item.issue}
                </span>
              </div>

              {/* Time badge */}
              <span className="text-sm text-gray-500 flex-shrink-0">
                {item.timeContext}
              </span>

              {/* Chevron */}
              <ChevronRight className="h-4 w-4 text-gray-400 flex-shrink-0" />
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
