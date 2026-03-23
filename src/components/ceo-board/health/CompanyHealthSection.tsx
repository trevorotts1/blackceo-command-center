'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { scoreToGrade, gradeToColor, gradeToLabel, type Grade } from '@/lib/grading';
import type { WorkspaceStats } from '@/lib/types';

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

interface DepartmentBadgeProps {
  id: string;
  name: string;
  score: number;
  emoji: string;
  onClick: () => void;
}

function DepartmentBadge({ name, score, emoji, onClick }: DepartmentBadgeProps) {
  const grade = scoreToGrade(score);
  const color = gradeToColor(grade);

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-full shadow-sm whitespace-nowrap hover:bg-gray-50 hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer"
    >
      <span className="text-lg">{emoji}</span>
      <span className="text-sm font-medium text-gray-700">{name}</span>
      <span
        className="text-sm font-bold px-2 py-0.5 rounded-full"
        style={{
          backgroundColor: `${color}20`,
          color: color,
        }}
      >
        {grade}
      </span>
    </button>
  );
}

interface GradeCircleProps {
  grade: Grade;
}

function GradeCircle({ grade }: GradeCircleProps) {
  const color = gradeToColor(grade);
  const label = gradeToLabel(grade);

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Large Grade Circle */}
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

      {/* Grade Label */}
      <span className="text-base font-semibold text-gray-600">
        {label}
      </span>
    </div>
  );
}

// Calculate department score with bootstrap logic
function calculateDepartmentScore(dept: WorkspaceStats): number {
  const total = dept.taskCounts?.total || 0;
  const done = dept.taskCounts?.done || 0;
  const inProgress = dept.taskCounts?.in_progress || 0;

  // No data yet - use bootstrap score
  if (total === 0) {
    return 72; // C+ baseline for new installs
  }

  const doneRate = done / total;

  // Bootstrap condition: tasks exist but completion is too low to be meaningful (< 10%)
  if (doneRate < 0.1) {
    return 72; // C+ baseline - not enough completed work to grade fairly
  }

  // Has real progress - use actual completion rate
  // Weight: done = full credit, in_progress = half credit
  const score = ((done + inProgress * 0.5) / total) * 100;
  return Math.round(score);
}

// Calculate company score with bootstrap logic
function calculateCompanyScore(departments: WorkspaceStats[]): number {
  const totalDone = departments.reduce((sum, dept) => sum + (dept.taskCounts?.done || 0), 0);
  const totalTasks = departments.reduce((sum, dept) => sum + (dept.taskCounts?.total || 0), 0);

  // No data yet - use bootstrap score
  if (totalTasks === 0) {
    return 72; // C+ baseline for new installs
  }

  const doneRate = totalDone / totalTasks;

  // Bootstrap condition: too early in deployment for meaningful company grade (< 25% done)
  if (doneRate < 0.25) {
    return 72; // C+ baseline - system is still ramping up
  }

  // Has real progress - use weighted completion rate
  let totalScore = 0;
  let deptCount = 0;

  for (const dept of departments) {
    const score = calculateDepartmentScore(dept);
    totalScore += score;
    deptCount++;
  }

  return deptCount > 0 ? Math.round(totalScore / deptCount) : 72;
}

export function CompanyHealthSection() {
  const router = useRouter();
  const [departments, setDepartments] = useState<WorkspaceStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadWorkspaceStats() {
      try {
        setLoading(true);

        const res = await fetch('/api/workspaces?stats=true');
        if (!res.ok) {
          throw new Error('Failed to load workspace stats');
        }

        const data: WorkspaceStats[] = await res.json();
        
        // Filter to only show workspaces belonging to the default company (Trevor's board)
        // Exclude ceo, default, and any seeded demo workspaces (acme-*, zhw-*)
        const filteredDepartments = data.filter(
          (item) => {
            const slug = item.slug || item.id;
            return slug !== 'default' && 
                   !slug.startsWith('acme-') && 
                   !slug.startsWith('zhw-');
          }
        );

        setDepartments(filteredDepartments);
      } catch (err) {
        console.error('Failed to load department stats:', err);
        setDepartments([]);
      } finally {
        setLoading(false);
      }
    }

    loadWorkspaceStats();
  }, []);

  const { companyScore, companyGrade, isBootstrap, sortedDepartments } = useMemo(() => {
    const score = calculateCompanyScore(departments);
    const grade = scoreToGrade(score);

    // Check if we're in bootstrap mode (no meaningful data yet)
    const totalTasks = departments.reduce((sum, dept) => sum + (dept.taskCounts?.total || 0), 0);
    const totalDone = departments.reduce((sum, dept) => sum + (dept.taskCounts?.done || 0), 0);
    const doneRate = totalTasks > 0 ? totalDone / totalTasks : 0;
    const isBootstrapMode = totalTasks === 0 || doneRate < 0.25;

    // Sort departments by score (highest first)
    const sorted = [...departments]
      .map(dept => ({
        id: dept.id,
        name: dept.name,
        score: calculateDepartmentScore(dept),
        emoji: dept.icon || DEPARTMENT_EMOJIS[dept.slug] || '🏢',
        slug: dept.slug,
      }))
      .sort((a, b) => b.score - a.score);

    return {
      companyScore: score,
      companyGrade: grade,
      isBootstrap: isBootstrapMode,
      sortedDepartments: sorted,
    };
  }, [departments]);

  // Find best and worst performing departments for the explanation
  const bestDept = sortedDepartments[0];
  const worstDept = sortedDepartments[sortedDepartments.length - 1];

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
        {/* Large Grade Display - First thing owner sees */}
        <motion.div variants={itemVariants}>
          <GradeCircle grade={companyGrade} />
        </motion.div>

        {/* One-sentence explanation */}
        <motion.p
          className="text-base text-gray-700 text-center max-w-xl leading-relaxed"
          variants={itemVariants}
        >
          {isBootstrap ? (
            <>
              Your AI workforce is getting started. Check back after agents complete their first tasks to see your performance grade.
            </>
          ) : (
            <>
              Your company earned a {companyGrade} this week.{' '}
              {bestDept && (
                <span className="font-medium text-gray-900">{bestDept.name}</span>
              )} is above industry average but{' '}
              {worstDept && worstDept !== bestDept && (
                <span className="font-medium text-gray-900">{worstDept.name}</span>
              )} needs attention.
            </>
          )}
        </motion.p>

        {/* Department Grade Badges Row */}
        {sortedDepartments.length > 0 && (
          <motion.div
            className="w-full mt-4"
            variants={itemVariants}
          >
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider text-center mb-3">
              Department Grades
            </p>
            <div className="flex gap-3 overflow-x-auto pb-2 justify-start lg:justify-center px-1 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent">
              {sortedDepartments.map((dept) => (
                <DepartmentBadge
                  key={dept.id}
                  id={dept.id}
                  name={dept.name}
                  score={dept.score}
                  emoji={dept.emoji}
                  onClick={() => router.push(`/ceo-board/${dept.id}`)}
                />
              ))}
            </div>
          </motion.div>
        )}
      </div>
    </motion.section>
  );
}
