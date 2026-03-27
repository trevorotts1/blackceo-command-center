'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { scoreToGrade, gradeToLabel, type Grade } from '@/lib/grading';
import type { WorkspaceStats } from '@/lib/types';

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
  design: '\u2728',
  'customer-success': '\u{1F91D}',
  'account-management': '\u{1F511}',
  'business-development': '\u{1F4C8}',
  'content-marketing': '\u270D\u{FE0F}',
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

function calculateDeptScore(dept: WorkspaceStats): number {
  const total = dept.taskCounts?.total || 0;
  const done = dept.taskCounts?.done || 0;
  const inProgress = dept.taskCounts?.in_progress || 0;
  if (total === 0) return 72;
  const dr = done / total;
  if (dr < 0.1) return 72;
  return Math.round(((done + inProgress * 0.5) / total) * 100);
}

function TrendArrow({ grade }: { grade: Grade }) {
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
  const [departments, setDepartments] = useState<WorkspaceStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await fetch('/api/workspaces?stats=true');
        if (res.ok) {
          const data: WorkspaceStats[] = await res.json();
          setDepartments(
            data.filter((d) => {
              const slug = d.slug || d.id;
              return (
                slug !== 'default' && !slug.startsWith('acme-') && !slug.startsWith('zhw-')
              );
            })
          );
        }
      } catch {
        // handled
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const deptGrades = useMemo(() => {
    return departments
      .map((d) => {
        const score = calculateDeptScore(d);
        const grade = scoreToGrade(score);
        return {
          id: d.id,
          name: d.name,
          emoji: d.icon || DEPARTMENT_EMOJIS[d.slug] || '\u{1F3E2}',
          grade,
        };
      })
      .sort((a, b) => {
        const order: Grade[] = ['A', 'B', 'C', 'D', 'F'];
        return order.indexOf(a.grade) - order.indexOf(b.grade);
      });
  }, [departments]);

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
          className={`flex items-center gap-3 p-4 rounded-2xl border-2 ${GRADE_BORDER[dept.grade]} shadow-sm flex-shrink-0 cursor-pointer hover:shadow-md transition-shadow`}
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
          <span className="text-sm font-semibold text-[#1A1A1A] whitespace-nowrap">
            {dept.name}
          </span>

          {/* Right: grade circle + trend arrow */}
          <div className="flex flex-col items-center gap-0.5">
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-full ${GRADE_BG[dept.grade]}`}
            >
              <span className="text-lg font-black text-white">
                {dept.grade}
              </span>
            </div>
            <TrendArrow grade={dept.grade} />
          </div>
        </motion.button>
      ))}
    </motion.div>
  );
}
