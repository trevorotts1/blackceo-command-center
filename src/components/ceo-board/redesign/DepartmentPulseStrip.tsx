'use client';

/**
 * DepartmentPulseStrip — PRD 2.10 rebuild
 *
 * Was calculateDeptScore(): fabricated a 72 score (and thus a fake letter
 * grade) for any department with zero tasks or a <10% done ratio — a direct
 * violation of the "never 72" doctrine documented in CompanyHeroCard.tsx and
 * DepartmentGradeCards.tsx. Now drives grade/score from /api/company-health
 * (the single grading source of truth, src/lib/grading.ts). grade === null
 * renders an explicit muted "Insufficient data" pill — never a fabricated
 * letter, never a fake trend arrow.
 */

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { gradeToLabel, isRealDepartment, type Grade } from '@/lib/grading';
import type { WorkspaceStats } from '@/lib/types';

// Client-side shape of one entry in /api/company-health's `departments` array
// (mirrors DepartmentGrade from grading.ts — only the fields this strip needs).
interface ClientDepartmentGrade {
  workspaceId: string;
  slug: string;
  name: string;
  score: number | null;
  grade: string | null;
}

interface ClientCompanyHealth {
  departments: ClientDepartmentGrade[];
}

interface PulseDept {
  id: string;
  name: string;
  emoji: string;
  grade: Grade | null;
  score: number | null;
}

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

const GRADE_BG: Record<Grade, string> = {
  A: 'bg-emerald-500',
  B: 'bg-emerald-400',
  C: 'bg-amber-500',
  D: 'bg-red-400',
  F: 'bg-red-600',
};

const GRADE_BORDER: Record<Grade, string> = {
  A: 'border-emerald-400',
  B: 'border-emerald-300',
  C: 'border-amber-400',
  D: 'border-red-300',
  F: 'border-red-500',
};

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.04 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, x: -10 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      duration: 0.3,
      ease: [0.4, 0, 0.2, 1] as [number, number, number, number],
    },
  },
};

function TrendArrow({ grade }: { grade: Grade | null }) {
  // Tier indicator derived from the REAL grade — never a fabricated trend.
  // null (insufficient data) gets a muted dash, not a color-coded guess.
  if (!grade) return <Minus className="h-3.5 w-3.5 text-gray-300" />;
  if (grade === 'A' || grade === 'B') {
    return <ArrowUp className="h-3.5 w-3.5 text-emerald-500" />;
  }
  if (grade === 'C') {
    return <Minus className="h-3.5 w-3.5 text-amber-500" />;
  }
  return <ArrowDown className="h-3.5 w-3.5 text-red-500" />;
}

export function DepartmentPulseStrip() {
  const router = useRouter();
  const [health, setHealth] = useState<ClientCompanyHealth | null>(null);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [healthRes, wsRes] = await Promise.all([
          fetch('/api/company-health'),
          fetch('/api/workspaces?stats=true'),
        ]);
        if (healthRes.ok) {
          setHealth(await healthRes.json());
        }
        if (wsRes.ok) {
          // Only used to look up each department's custom icon — grade/score
          // always come from /api/company-health, never derived from task counts.
          const data: WorkspaceStats[] = await wsRes.json();
          const iconMap: Record<string, string> = {};
          data
            .filter((d) => isRealDepartment(d.slug || d.id))
            .forEach((d) => {
              iconMap[d.id] = d.icon || DEPARTMENT_EMOJIS[d.slug] || '\u{1F3E2}';
            });
          setIcons(iconMap);
        }
      } catch {
        // handled by loading state
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const deptGrades = useMemo((): PulseDept[] => {
    if (!health) return [];
    return health.departments
      .map((d): PulseDept => ({
        id: d.workspaceId,
        name: d.name,
        emoji: icons[d.workspaceId] || DEPARTMENT_EMOJIS[d.slug] || '\u{1F3E2}',
        grade: (d.grade as Grade | null) ?? null,
        score: d.score,
      }))
      .sort((a, b) => {
        // Real grades sort best-to-worst; insufficient-data departments sort last
        // (never mixed in ranked among fabricated positions).
        if (a.grade === null && b.grade === null) return 0;
        if (a.grade === null) return 1;
        if (b.grade === null) return -1;
        const order: Grade[] = ['A', 'B', 'C', 'D', 'F'];
        return order.indexOf(a.grade) - order.indexOf(b.grade);
      });
  }, [health, icons]);

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="h-[72px] w-48 rounded-2xl bg-gray-200 animate-pulse flex-shrink-0"
          />
        ))}
      </div>
    );
  }

  if (deptGrades.length === 0) return null;

  return (
    <motion.div
      className="flex gap-3 overflow-x-auto pb-2 scrollbar scrollbar-thin scrollbar-thumb-indigo-400 scrollbar-track-indigo-100"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {deptGrades.map((dept) => (
        <motion.button
          key={dept.id}
          variants={itemVariants}
          onClick={() => router.push(`/ceo-board/${dept.id}`)}
          title={dept.grade ? gradeToLabel(dept.grade) : 'Insufficient data'}
          className={`flex items-center gap-3 p-4 rounded-2xl border-2 ${dept.grade ? GRADE_BORDER[dept.grade] : 'border-gray-200'} shadow-sm flex-shrink-0 cursor-pointer hover:shadow-md transition-shadow`}
          style={{
            backgroundColor: 'rgba(255,255,255,0.88)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        >
          {/* Dept emoji in rounded square */}
          <div
            className="flex h-9 w-9 items-center justify-center rounded-xl text-xl"
            style={{ backgroundColor: 'rgba(129,199,132,0.1)' }}
          >
            {dept.emoji}
          </div>

          {/* Center: dept name only, no grade label */}
          <span className="text-base font-semibold text-gray-900 whitespace-nowrap">
            {dept.name}
          </span>

          {/* Right: grade circle (or insufficient-data pill) + tier arrow */}
          <div className="flex flex-col items-center gap-0.5">
            {dept.grade ? (
              <div
                className={`flex h-12 w-12 items-center justify-center rounded-full ${GRADE_BG[dept.grade]}`}
              >
                <span className="text-xl font-black text-white">
                  {dept.grade}
                </span>
              </div>
            ) : (
              // never-72 doctrine: insufficient data renders a muted "—",
              // never a fabricated letter grade.
              <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-gray-200 bg-gray-50">
                <span className="text-lg font-bold text-gray-400">—</span>
              </div>
            )}
            <TrendArrow grade={dept.grade} />
          </div>
        </motion.button>
      ))}
    </motion.div>
  );
}
