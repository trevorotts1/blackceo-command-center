'use client';

import { motion } from 'framer-motion';
import { BarChart3 } from 'lucide-react';

interface UtilizationData {
  name: string;
  value: number;
  color: string;
}

interface UtilizationPieChartProps {
  data: UtilizationData[];
}

const SEGMENT_CONFIG: Record<string, { label: string; color: string }> = {
  'Completed': { label: 'Completed', color: '#22C55E' },
  'In Progress': { label: 'In Progress', color: '#3B82F6' },
  'Review': { label: 'Review', color: '#F59E0B' },
  'Backlog': { label: 'Pending', color: '#9CA3AF' },
  'Blocked': { label: 'Blocked', color: '#EF4444' },
};

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number
): string {
  const outerStart = polarToCartesian(cx, cy, outerR, startAngle);
  const outerEnd = polarToCartesian(cx, cy, outerR, endAngle);
  const innerStart = polarToCartesian(cx, cy, innerR, endAngle);
  const innerEnd = polarToCartesian(cx, cy, innerR, startAngle);

  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerEnd.x} ${innerEnd.y}`,
    'Z',
  ].join(' ');
}

export function UtilizationPieChart({ data }: UtilizationPieChartProps) {
  const total = data.reduce((acc, item) => acc + item.value, 0);
  const completedCount = data.find(d => d.name === 'Completed')?.value || 0;
  const completionPct = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  // SVG geometry
  const cx = 150;
  const cy = 155;
  const outerR = 120;
  const innerR = 78;
  const gap = 2; // degrees between segments
  const viewBoxW = 300;
  const viewBoxH = 175;

  // Build segments
  const segments: { path: string; color: string; label: string; count: number; pct: number; midAngle: number }[] = [];
  let currentAngle = 180;

  data.forEach((item) => {
    if (item.value <= 0) return;
    const config = SEGMENT_CONFIG[item.name] || { label: item.name, color: '#6B7280' };
    const pct = (item.value / total) * 100;
    const sweep = (item.value / total) * 180;

    const startAngle = currentAngle + gap / 2;
    const endAngle = currentAngle + sweep - gap / 2;

    if (endAngle <= startAngle) {
      currentAngle += sweep;
      return;
    }

    const midAngle = (startAngle + endAngle) / 2;
    const path = describeArc(cx, cy, outerR, innerR, startAngle, endAngle);

    segments.push({
      path,
      color: config.color,
      label: config.label,
      count: item.value,
      pct: Math.round(pct),
      midAngle,
    });

    currentAngle += sweep;
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-[#6366F1]" />
          <h3 className="text-lg font-semibold text-[#1A1D26]">Task Status</h3>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-[#1A1D26]">{total}</p>
          <p className="text-xs text-[#9CA3AF]">Total Tasks</p>
        </div>
      </div>

      {/* Donut Chart */}
      <div className="flex justify-center">
        <svg
          viewBox={`0 0 ${viewBoxW} ${viewBoxH}`}
          className="w-full max-w-[340px]"
          role="img"
          aria-label="Task status semi-circular donut chart"
        >
          {/* Background arc */}
          <path
            d={describeArc(cx, cy, outerR, innerR, 180, 360)}
            fill="#F3F4F6"
          />

          {/* Colored segments */}
          {segments.map((seg, i) => (
            <motion.path
              key={seg.label}
              d={seg.path}
              fill={seg.color}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: i * 0.12, duration: 0.5 }}
              style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.1))' }}
            />
          ))}

          {/* Center percentage */}
          <text
            x={cx}
            y={cy - 14}
            textAnchor="middle"
            className="fill-[#1A1D26]"
            style={{ fontSize: '28px', fontWeight: 700 }}
          >
            {completionPct}%
          </text>
          <text
            x={cx}
            y={cy + 6}
            textAnchor="middle"
            className="fill-[#9CA3AF]"
            style={{ fontSize: '11px', fontWeight: 500 }}
          >
            Completed
          </text>
        </svg>
      </div>

      {/* Legend */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 pt-1">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-2">
            <div
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: seg.color }}
            />
            <span className="text-sm text-gray-600 truncate">{seg.label}</span>
            <span className="text-sm font-semibold text-gray-900 ml-auto">{seg.count}</span>
            <span className="text-xs text-gray-400">({seg.pct}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}
