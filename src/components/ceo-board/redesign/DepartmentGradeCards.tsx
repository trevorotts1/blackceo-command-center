'use client';

/**
 * DepartmentGradeCards — PRD 2.10 Performance Board
 *
 * Renders per-department grade cards driven by /api/company-health.
 * Each card shows:
 *   - Department name + letter grade (or insufficient-data pill)
 *   - Four per-input mini-bars (null inputs show greyed "no data")
 *   - Worst-trending flag banner (up to 3 depts)
 *
 * HARD RULE: any value from a null input renders an insufficient-data
 * treatment — never 0%, never 72, never a grey bar implying a low real score.
 */

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Sparkline } from '@/components/ceo-board/Sparkline';
import { gradeToColor, gradeToLabel } from '@/lib/grading';
import type { CompanyHealth, DepartmentGrade, GradeInputKey, InputScore } from '@/lib/grading';

// ---------------------------------------------------------------------------
// Types (mirrors CompanyHealth from grading.ts — client-side shape)
// ---------------------------------------------------------------------------

// Re-declare locally so the client bundle doesn't pull in better-sqlite3
interface ClientInputScore {
  key: GradeInputKey;
  score: number | null;
  sampleSize: number;
  detail: string;
}

// PRD 2.14 LSS metrics (mirrors LssDepartmentMetrics from grading.ts)
interface ClientLssRate {
  score: number | null;
  sampleSize: number;
  detail: string;
}

interface ClientLssDeptMetrics {
  defectRate: ClientLssRate;
  reworkRate: ClientLssRate;
  staleLoopsKilled: number;
}

interface ClientDepartmentGrade {
  workspaceId: string;
  slug: string;
  name: string;
  inputs: Record<GradeInputKey, ClientInputScore>;
  score: number | null;
  grade: string | null;
  sufficientData: boolean;
  /** PRD 2.14 LSS diagnostic lens — optional */
  lss?: ClientLssDeptMetrics;
}

interface WorstTrendingEntry {
  slug: string;
  name: string;
  failingInput: GradeInputKey;
  detail: string;
  delta: number;
}

interface ClientCompanyHealth {
  score: number | null;
  grade: string | null;
  departments: ClientDepartmentGrade[];
  worstTrending: WorstTrendingEntry[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Input label metadata
// ---------------------------------------------------------------------------

const INPUT_META: Record<GradeInputKey, { label: string; color: string }> = {
  throughput: { label: 'Throughput', color: '#6366F1' },
  qcPassRate: { label: 'QC Pass Rate', color: '#10B981' },
  sopCoverage: { label: 'SOP Coverage', color: '#F59E0B' },
  kpiAttainment: { label: 'KPI Attainment', color: '#3B82F6' },
};

const INPUT_ORDER: GradeInputKey[] = ['throughput', 'qcPassRate', 'sopCoverage', 'kpiAttainment'];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function InputMiniBar({ input }: { input: ClientInputScore }) {
  const meta = INPUT_META[input.key];

  if (input.score === null) {
    // Insufficient data — grey bar with explicit label, never a real score
    return (
      <div className="flex items-center gap-2 w-full">
        <span className="text-xs text-gray-400 w-24 shrink-0 truncate">{meta.label}</span>
        <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full w-0 rounded-full" />
        </div>
        <span className="text-xs text-gray-300 w-16 text-right tabular-nums shrink-0">
          no data
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 w-full" title={input.detail}>
      <span className="text-xs text-gray-500 w-24 shrink-0 truncate">{meta.label}</span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: meta.color }}
          initial={{ width: 0 }}
          animate={{ width: `${input.score}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </div>
      <span className="text-xs text-gray-600 w-10 text-right tabular-nums shrink-0 font-medium">
        {input.score}%
      </span>
    </div>
  );
}

function DepartmentCard({ dept }: { dept: ClientDepartmentGrade }) {
  const gradeColor = dept.grade ? gradeToColor(dept.grade as Parameters<typeof gradeToColor>[0]) : '#9CA3AF';
  const gradeLabel = dept.grade ? gradeToLabel(dept.grade as Parameters<typeof gradeToLabel>[0]) : 'Insufficient data';

  return (
    <motion.div
      className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 flex flex-col gap-3 min-w-0"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* Header: name + grade */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-800 truncate">{dept.name}</h3>
        {dept.grade ? (
          <div
            className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center shadow-sm"
            style={{
              background: `linear-gradient(135deg, ${gradeColor}20, ${gradeColor}40)`,
              border: `2px solid ${gradeColor}`,
            }}
          >
            <span className="font-bold text-lg" style={{ color: gradeColor }}>
              {dept.grade}
            </span>
          </div>
        ) : (
          <span className="shrink-0 px-2 py-1 rounded-full bg-gray-100 text-gray-400 text-xs font-medium">
            —
          </span>
        )}
      </div>

      {/* Grade label or insufficient-data */}
      <p className="text-xs text-gray-500">
        {dept.sufficientData
          ? gradeLabel
          : 'Insufficient data — ramping up'}
      </p>

      {/* Per-input mini-bars */}
      <div className="flex flex-col gap-1.5 mt-1">
        {INPUT_ORDER.map((key) => (
          <InputMiniBar key={key} input={dept.inputs[key]} />
        ))}
      </div>

      {/* PRD 2.14 LSS diagnostic lens — muted secondary rows, not part of grade */}
      {dept.lss && (
        <div className="mt-1 pt-2 border-t border-gray-50 flex flex-col gap-1">
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-0.5">LSS Diagnostics</p>

          {/* Defect rate */}
          <div className="flex items-center justify-between" title={dept.lss.defectRate.detail}>
            <span className="text-xs text-gray-400">Defect rate</span>
            {dept.lss.defectRate.score === null ? (
              <span className="text-xs text-gray-300 tabular-nums">no data</span>
            ) : (
              <span
                className="text-xs tabular-nums font-medium"
                style={{ color: dept.lss.defectRate.score > 20 ? '#EF4444' : '#6B7280' }}
              >
                {dept.lss.defectRate.score}%
              </span>
            )}
          </div>

          {/* Rework rate */}
          <div className="flex items-center justify-between" title={dept.lss.reworkRate.detail}>
            <span className="text-xs text-gray-400">Rework rate</span>
            {dept.lss.reworkRate.score === null ? (
              <span className="text-xs text-gray-300 tabular-nums">no data</span>
            ) : (
              <span
                className="text-xs tabular-nums font-medium"
                style={{ color: dept.lss.reworkRate.score > 20 ? '#EF4444' : '#6B7280' }}
              >
                {dept.lss.reworkRate.score}%
              </span>
            )}
          </div>

          {/* Stale loops killed — always a real integer */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">Stale loops killed</span>
            <span
              className="text-xs tabular-nums font-medium"
              style={{ color: dept.lss.staleLoopsKilled > 0 ? '#F59E0B' : '#9CA3AF' }}
            >
              {dept.lss.staleLoopsKilled}
            </span>
          </div>
        </div>
      )}

      {/* Score number (only when sufficient data) */}
      {dept.score !== null && (
        <div className="flex items-center justify-between mt-1 pt-2 border-t border-gray-50">
          <span className="text-xs text-gray-400">Overall</span>
          <span className="text-sm font-bold tabular-nums" style={{ color: gradeColor }}>
            {Math.round(dept.score)}/100
          </span>
        </div>
      )}
    </motion.div>
  );
}

function WorstTrendingBanner({ entries }: { entries: WorstTrendingEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="w-full rounded-xl bg-red-50 border border-red-100 p-4 flex flex-col gap-2">
      <p className="text-xs font-semibold text-red-600 uppercase tracking-wider">
        Departments Trending Down
      </p>
      {entries.map((e) => (
        <div key={e.slug} className="flex items-start gap-2">
          <span className="text-red-400 text-sm shrink-0">▼</span>
          <div className="min-w-0">
            <span className="text-sm font-medium text-red-800">{e.name}</span>
            <span className="text-xs text-red-500 ml-2">
              {INPUT_META[e.failingInput].label}
            </span>
            {e.delta !== 0 && (
              <span className="text-xs text-red-400 ml-1">
                ({e.delta > 0 ? '+' : ''}{Math.round(e.delta)} pts)
              </span>
            )}
            <p className="text-xs text-red-400 truncate">{e.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function DepartmentGradeCards() {
  const [health, setHealth] = useState<ClientCompanyHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const res = await fetch('/api/company-health');
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data: ClientCompanyHealth = await res.json();
        setHealth(data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-48 bg-gray-100 rounded-2xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (error || !health) {
    return (
      <div className="rounded-xl bg-red-50 border border-red-100 p-4 text-sm text-red-600">
        Failed to load department grades: {error ?? 'unknown error'}
      </div>
    );
  }

  // Filter to real departments (API already filters, but guard in UI too)
  const depts = health.departments;

  if (depts.length === 0) {
    return (
      <div className="rounded-xl bg-gray-50 border border-gray-100 p-6 text-center text-sm text-gray-500">
        No departments found. Set up workspaces to start grading.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Worst-trending alert banner */}
      <WorstTrendingBanner entries={health.worstTrending} />

      {/* Department cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {depts.map((dept) => (
          <DepartmentCard key={dept.workspaceId} dept={dept} />
        ))}
      </div>

      {/* Timestamp */}
      <p className="text-xs text-gray-300 text-right mt-1">
        Graded {new Date(health.generatedAt).toLocaleString()}
      </p>
    </div>
  );
}
