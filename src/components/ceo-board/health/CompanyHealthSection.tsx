'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Edit3, Check } from 'lucide-react';
import { scoreToGrade, gradeToColor, gradeToLabel, type Grade } from '@/lib/grading';
import { KPIEntryPanel } from '@/components/ceo-board/KPIEntryPanel';

// Demo department data
const demoDepartments = [
  { name: 'Marketing', score: 91, emoji: '📢' },
  { name: 'Sales', score: 74, emoji: '💼' },
  { name: 'Creative', score: 88, emoji: '🎨' },
  { name: 'Operations', score: 79, emoji: '⚙️' },
  { name: 'Billing', score: 95, emoji: '💰' },
  { name: 'Support', score: 67, emoji: '🎧' },
];

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

interface DepartmentBadgeProps {
  name: string;
  score: number;
  emoji: string;
}

function DepartmentBadge({ name, score, emoji }: DepartmentBadgeProps) {
  const grade = scoreToGrade(score);
  const color = gradeToColor(grade);

  return (
    <div
      className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-full shadow-sm whitespace-nowrap"
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
    </div>
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

export function CompanyHealthSection() {
  // Demo data - company overall score 82 (B)
  const companyScore = 82;
  const companyGrade = scoreToGrade(companyScore);

  // Sort departments by score (highest first) and take top 6
  const sortedDepartments = [...demoDepartments]
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  // Find best and worst performing departments for the explanation
  const bestDept = sortedDepartments[0];
  const worstDept = sortedDepartments[sortedDepartments.length - 1];

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
          Your company earned a {companyGrade} this week.{' '}
          <span className="font-medium text-gray-900">{bestDept.name}</span> is above industry average but{' '}
          <span className="font-medium text-gray-900">{worstDept.name}</span> needs attention.
        </motion.p>

        {/* Department Grade Badges Row */}
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
                key={dept.name}
                name={dept.name}
                score={dept.score}
                emoji={dept.emoji}
              />
            ))}
          </div>
        </motion.div>
      </div>
    </motion.section>
  );
}
