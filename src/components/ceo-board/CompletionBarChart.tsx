'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from 'recharts';
import { Info } from 'lucide-react';

interface CompletionData {
  department: string;
  completionRate: number;
  taskCount: number;
}

interface CompletionBarChartProps {
  data: CompletionData[];
}

const INDUSTRY_AVERAGE = 65;

const departmentColors: Record<string, string> = {
  CEO: '#4F46E5',
  Marketing: '#EC4899',
  Sales: '#10B981',
  Billing: '#F59E0B',
  Support: '#3B82F6',
  Operations: '#8B5CF6',
  Creative: '#F97316',
  HR: '#14B8A6',
  Legal: '#6366F1',
  IT: '#06B6D4',
  'Web Dev': '#84CC16',
  'App Dev': '#A855F7',
  Graphics: '#EAB308',
  Video: '#EF4444',
  Audio: '#22C55E',
  Research: '#0EA5E9',
  Comms: '#F43F5E',
};

function getBarColor(rate: number): string {
  if (rate >= 90) return '#10B981'; // Excellent - Emerald
  if (rate >= 75) return '#4F46E5'; // Good - Indigo
  if (rate >= 60) return '#F59E0B'; // Fair - Amber
  return '#DC2626'; // Poor - Red
}

const CustomTooltip = ({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; payload: CompletionData }>;
  label?: string;
}) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-[#1A1D26] text-white p-3 rounded-lg shadow-xl border border-[#374151]"
      >
        <p className="font-semibold text-sm mb-1">{label}</p>
        <p className="text-2xl font-bold text-[#6366F1]">{data.completionRate}%</p>
        <p className="text-xs text-[#9CA3AF] mt-1">
          {data.taskCount} tasks total
        </p>
        <div className="mt-2 pt-2 border-t border-[#374151]">
          <p className="text-xs">
            {data.completionRate >= INDUSTRY_AVERAGE ? (
              <span className="text-[#10B981]">Above industry avg</span>
            ) : (
              <span className="text-[#F59E0B]">Below industry avg</span>
            )}
          </p>
        </div>
      </motion.div>
    );
  }
  return null;
};

export function CompletionBarChart({ data }: CompletionBarChartProps) {
  const [hoveredBar, setHoveredBar] = useState<string | null>(null);

  const sortedData = [...data].sort((a, b) => b.completionRate - a.completionRate);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold text-[#1A1D26]">
            Completion Rate by Department
          </h3>
          <div className="group relative">
            <Info className="w-4 h-4 text-[#9CA3AF] cursor-help" />
            <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 w-64 p-3 bg-[#1A1D26] text-white text-xs rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
              Percentage of tasks completed vs. total assigned. Industry benchmark is 65%.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-[#10B981]" />
            <span className="text-[#6B7280]">90%+ Excellent</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-[#4F46E5]" />
            <span className="text-[#6B7280]">75-89% Good</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-[#F59E0B]" />
            <span className="text-[#6B7280]">60-74% Fair</span>
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="h-[320px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={sortedData}
            margin={{ top: 20, right: 30, left: 0, bottom: 60 }}
            barSize={24}
          >
            <defs>
              <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366F1" stopOpacity={0.9} />
                <stop offset="100%" stopColor="#4F46E5" stopOpacity={0.7} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="#F3F4F6"
              vertical={false}
            />
            <XAxis
              dataKey="department"
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#6B7280', fontSize: 10 }}
              angle={-45}
              textAnchor="end"
              height={80}
              interval={0}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#6B7280', fontSize: 11 }}
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(value) => `${value}%`}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: '#F9FAFB' }} />
            <ReferenceLine
              y={INDUSTRY_AVERAGE}
              stroke="#9CA3AF"
              strokeDasharray="5 5"
              strokeWidth={2}
            >
              <text
                x="100%"
                y={INDUSTRY_AVERAGE - 5}
                textAnchor="end"
                fill="#9CA3AF"
                fontSize={10}
              >
                Industry Avg (65%)
              </text>
            </ReferenceLine>
            <Bar
              dataKey="completionRate"
              radius={[4, 4, 0, 0]}
              animationDuration={1000}
              animationBegin={300}
              animationEasing="ease-out"
            >
              {sortedData.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={getBarColor(entry.completionRate)}
                  fillOpacity={hoveredBar === entry.department ? 1 : 0.85}
                  onMouseEnter={() => setHoveredBar(entry.department)}
                  onMouseLeave={() => setHoveredBar(null)}
                  style={{ cursor: 'pointer' }}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Stats Footer */}
      <div className="flex items-center justify-between pt-4 border-t border-[#F3F4F6]">
        <div className="flex items-center gap-6">
          <div>
            <p className="text-xs text-[#9CA3AF]">Highest</p>
            <p className="text-sm font-semibold text-[#1A1D26]">
              {sortedData[0]?.department} ({sortedData[0]?.completionRate}%)
            </p>
          </div>
          <div>
            <p className="text-xs text-[#9CA3AF]">Lowest</p>
            <p className="text-sm font-semibold text-[#1A1D26]">
              {sortedData[sortedData.length - 1]?.department} ({sortedData[sortedData.length - 1]?.completionRate}%)
            </p>
          </div>
          <div>
            <p className="text-xs text-[#9CA3AF]">Average</p>
            <p className="text-sm font-semibold text-[#1A1D26]">
              {Math.round(sortedData.reduce((acc, d) => acc + d.completionRate, 0) / sortedData.length)}%
            </p>
          </div>
        </div>
        <div className="text-xs text-[#6B7280]">
          <span className="font-medium text-[#10B981]">
            {sortedData.filter(d => d.completionRate >= INDUSTRY_AVERAGE).length}
          </span>
          {' '}of{' '}
          <span className="font-medium">{sortedData.length}</span>
          {' '}departments above benchmark
        </div>
      </div>
    </div>
  );
}
