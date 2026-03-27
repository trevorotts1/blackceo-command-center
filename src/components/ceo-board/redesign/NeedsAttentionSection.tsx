'use client';

import { useEffect, useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ChevronRight, CheckCircle } from 'lucide-react';
import { scoreToGrade, type Grade } from '@/lib/grading';
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

interface AttentionItem {
  id: string;
  name: string;
  slug: string;
  severity: 'urgent' | 'warning';
  issue: string;
  timeContext: string;
  grade: Grade;
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

  const items: AttentionItem[] = useMemo(() => {
    const result: AttentionItem[] = [];

    for (const dept of departments) {
      const total = dept.taskCounts?.total || 0;
      const done = dept.taskCounts?.done || 0;
      const blocked = dept.taskCounts?.blocked || 0;
      const inProgress = dept.taskCounts?.in_progress || 0;

      if (total === 0) continue;

      const score = Math.round(
        ((done + inProgress * 0.5) / total) * 100
      );
      const grade = scoreToGrade(score);

      if (grade === 'F') {
        result.push({
          id: dept.id,
          name: dept.name,
          slug: dept.slug,
          severity: 'urgent',
          issue: `${dept.name} is at grade F -- immediate attention required`,
          timeContext: '3 days',
          grade,
        });
      } else if (grade === 'D') {
        result.push({
          id: dept.id,
          name: dept.name,
          slug: dept.slug,
          severity: 'urgent',
          issue: `${dept.name} is at grade D -- immediate attention required`,
          timeContext: '2 days',
          grade,
        });
      } else if (blocked > 0) {
        result.push({
          id: dept.id,
          name: dept.name,
          slug: dept.slug,
          severity: 'warning',
          issue: `${dept.name} has ${blocked} blocked task${blocked > 1 ? 's' : ''}`,
          timeContext: '1 day',
          grade,
        });
      }
    }

    result.sort((a, b) => {
      if (a.severity === 'urgent' && b.severity !== 'urgent') return -1;
      if (a.severity !== 'urgent' && b.severity === 'urgent') return 1;
      return 0;
    });

    return result.slice(0, 6);
  }, [departments]);

  if (loading) {
    return (
      <div>
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
      className="rounded-2xl shadow-sm border-0 p-6"
      style={{
        backgroundColor: 'rgba(255,255,255,0.88)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-xl font-bold text-[#1A1A1A]">Needs Attention</h2>
        {items.length > 0 && (
          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
            {items.length}
          </span>
        )}
      </div>

      {/* Items */}
      {items.length === 0 ? (
        <motion.div
          className="flex items-center gap-3 p-4 bg-white rounded-xl"
          style={{ boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <CheckCircle className="h-5 w-5 text-emerald-500 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-700">
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
                <span className="text-sm font-medium text-[#1A1A1A]">
                  {item.issue}
                </span>
              </div>

              {/* Time badge */}
              <span className="text-xs text-gray-400 flex-shrink-0">
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
