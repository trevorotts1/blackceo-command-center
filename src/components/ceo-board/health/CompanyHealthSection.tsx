'use client';

/**
 * CompanyHealthSection — PRD 2.10 rebuild
 *
 * Department grade badges row driven by /api/company-health.
 * All calculateDepartmentScore / calculateCompanyScore / 72-bootstrap logic
 * has been deleted. Grades come from the DB-grounding module (grading.ts).
 *
 * When a department's grade is null (insufficient data), it renders "—"
 * rather than a fabricated letter grade.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { gradeToColor, gradeToLabel, type Grade } from '@/lib/grading';

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: [0.25, 0.1, 0.25, 1] as [number, number, number, number],
    },
  },
};

// Department emoji mapping
const DEPARTMENT_EMOJIS: Record<string, string> = {
  marketing: '📢',
  sales: '💼',
  creative: '🎨',
  operations: '⚙️',
  billing: '💰',
  support: '🎧',
  hr: '👥',
  finance: '📊',
  legal: '⚖️',
  product: '📦',
  engineering: '💻',
  design: '✨',
  'customer-success': '🤝',
  'account-management': '🔑',
  'business-development': '📈',
  'content-marketing': '✍️',
  'social-media': '📱',
};

// Client-side shape from /api/company-health
interface ClientInputScore {
  key: string;
  score: number | null;
  sampleSize: number;
  detail: string;
}
interface ClientDepartmentGrade {
  workspaceId: string;
  slug: string;
  name: string;
  inputs: Record<string, ClientInputScore>;
  score: number | null;
  grade: string | null;
  sufficientData: boolean;
}
interface ClientCompanyHealth {
  score: number | null;
  grade: string | null;
  departments: ClientDepartmentGrade[];
  worstTrending: Array<{ slug: string; name: string; failingInput: string; detail: string; delta: number }>;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Badge component
// ---------------------------------------------------------------------------

interface DepartmentBadgeProps {
  id: string;
  name: string;
  grade: string | null;
  sufficientData: boolean;
  emoji: string;
  onClick: () => void;
}

function DepartmentBadge({ name, grade, sufficientData, emoji, onClick }: DepartmentBadgeProps) {
  // null grade = insufficient data: show "—" pill, not a fabricated grade
  const color = grade ? gradeToColor(grade as Grade) : '#9CA3AF';

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-full shadow-sm whitespace-nowrap hover:bg-gray-50 hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer"
    >
      <span className="text-lg">{emoji}</span>
      <span className="text-sm font-medium text-gray-700">{name}</span>
      {grade && sufficientData ? (
        <span
          className="text-sm font-bold px-2 py-0.5 rounded-full"
          style={{
            backgroundColor: `${color}20`,
            color: color,
          }}
        >
          {grade}
        </span>
      ) : (
        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-400">
          —
        </span>
      )}
    </button>
  );
}

interface GradeCircleProps {
  grade: Grade | null;
  sufficientData: boolean;
}

function GradeCircle({ grade, sufficientData }: GradeCircleProps) {
  if (!grade || !sufficientData) {
    // Explicit insufficient-data state — never show 72 or C+
    return (
      <div className="flex flex-col items-center gap-3">
        <div className="w-24 h-24 rounded-full flex items-center justify-center border-4 border-gray-200 bg-gray-50">
          <span className="text-5xl font-bold text-gray-300">—</span>
        </div>
        <span className="text-base font-semibold text-gray-400">Insufficient data</span>
      </div>
    );
  }

  const color = gradeToColor(grade);
  const label = gradeToLabel(grade);

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="w-24 h-24 rounded-full flex items-center justify-center shadow-lg"
        style={{
          background: `linear-gradient(135deg, ${color}30 0%, ${color}50 100%)`,
          border: `3px solid ${color}`,
          boxShadow: `0 8px 24px ${color}30`,
        }}
      >
        <span
          className="text-6xl font-bold"
          style={{ color, fontFamily: 'Inter, system-ui, sans-serif' }}
        >
          {grade}
        </span>
      </div>
      <span className="text-base font-semibold text-gray-600">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CompanyHealthSection() {
  const router = useRouter();
  const [health, setHealth] = useState<ClientCompanyHealth | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await fetch('/api/company-health');
        if (res.ok) {
          const data: ClientCompanyHealth = await res.json();
          setHealth(data);
        }
      } catch (err) {
        console.error('Failed to load company health:', err);
        setHealth(null);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const companyGrade = (health?.grade ?? null) as Grade | null;
  const sufficientData = health !== null && health.score !== null;

  const sortedDepartments = useMemo(() => {
    if (!health) return [];
    return [...health.departments]
      .map((dept) => ({
        id: dept.workspaceId,
        name: dept.name,
        grade: dept.grade,
        score: dept.score,
        sufficientData: dept.sufficientData,
        emoji: DEPARTMENT_EMOJIS[dept.slug] || '🏢',
        slug: dept.slug,
      }))
      // Sort: depts with data first (by score desc), then insufficient-data depts
      .sort((a, b) => {
        if (a.score !== null && b.score !== null) return b.score - a.score;
        if (a.score !== null) return -1;
        if (b.score !== null) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [health]);

  // Best and worst for the explanation (only among depts with data)
  const gradedDepts = sortedDepartments.filter((d) => d.sufficientData);
  const bestDept = gradedDepts[0];
  const worstDept = gradedDepts[gradedDepts.length - 1];

  if (loading) {
    return (
      <motion.section
        className="w-full bg-[#F8F9FB] rounded-2xl p-6 lg:p-8"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <div className="flex flex-col items-center gap-6">
          <div className="w-24 h-24 rounded-full bg-gray-200 animate-pulse" />
          <div className="h-4 w-64 bg-gray-200 rounded animate-pulse" />
        </div>
      </motion.section>
    );
  }

  return (
    <motion.section
      className="w-full bg-[#F8F9FB] rounded-2xl p-6 lg:p-8"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <div className="flex flex-col items-center gap-6">
        {/* Large Grade Display */}
        <motion.div variants={itemVariants}>
          <GradeCircle grade={companyGrade} sufficientData={sufficientData} />
        </motion.div>

        {/* One-sentence explanation */}
        <motion.p
          className="text-base text-gray-700 text-center max-w-xl leading-relaxed"
          variants={itemVariants}
        >
          {!sufficientData ? (
            'Your AI workforce is getting started. Check back after agents complete their first tasks to see your performance grade.'
          ) : (
            <>
              Your company earned a {companyGrade} this week.{' '}
              {bestDept && (
                <span className="font-medium text-gray-900">{bestDept.name}</span>
              )}{' '}
              {bestDept && worstDept && worstDept !== bestDept && (
                <>
                  is leading, but{' '}
                  <span className="font-medium text-gray-900">{worstDept.name}</span>{' '}
                  needs attention.
                </>
              )}
            </>
          )}
        </motion.p>

        {/* Department Grade Badges Row */}
        {sortedDepartments.length > 0 && (
          <motion.div className="w-full mt-4" variants={itemVariants}>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider text-center mb-3">
              Department Grades
            </p>
            <div className="relative flex items-center w-full">
              <button
                onClick={() => {
                  const el = document.getElementById('dept-scroll-container');
                  if (el) el.scrollBy({ left: -200, behavior: 'smooth' });
                }}
                className="shrink-0 w-8 h-8 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50 hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer z-10 mr-2"
                aria-label="Scroll left"
              >
                <ChevronLeft className="w-4 h-4 text-gray-500" />
              </button>

              <div
                id="dept-scroll-container"
                className="dept-scroll flex gap-3 overflow-x-auto py-1 justify-start lg:justify-center px-1 flex-1"
                style={{ scrollbarWidth: 'auto', scrollbarColor: '#94A3B8 #E2E8F0' }}
              >
                <style>{`
                  .dept-scroll::-webkit-scrollbar { height: 10px; }
                  .dept-scroll::-webkit-scrollbar-track { background: #E2E8F0; border-radius: 5px; }
                  .dept-scroll::-webkit-scrollbar-thumb { background: #94A3B8; border-radius: 5px; }
                  .dept-scroll::-webkit-scrollbar-thumb:hover { background: #64748B; }
                `}</style>
                {sortedDepartments.map((dept) => (
                  <DepartmentBadge
                    key={dept.id}
                    id={dept.id}
                    name={dept.name}
                    grade={dept.grade}
                    sufficientData={dept.sufficientData}
                    emoji={dept.emoji}
                    onClick={() => router.push(`/ceo-board/${dept.id}`)}
                  />
                ))}
              </div>

              <button
                onClick={() => {
                  const el = document.getElementById('dept-scroll-container');
                  if (el) el.scrollBy({ left: 200, behavior: 'smooth' });
                }}
                className="shrink-0 w-8 h-8 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-50 hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer z-10 ml-2"
                aria-label="Scroll right"
              >
                <ChevronRight className="w-4 h-4 text-gray-500" />
              </button>
            </div>
          </motion.div>
        )}
      </div>
    </motion.section>
  );
}
