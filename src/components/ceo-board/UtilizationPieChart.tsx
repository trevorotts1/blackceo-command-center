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

const BAR_CONFIG: Record<string, { label: string; barColor: string; bgColor: string }> = {
  'In Progress': { label: 'In Progress', barColor: '#3B82F6', bgColor: '#DBEAFE' },
  'Review': { label: 'Review', barColor: '#F59E0B', bgColor: '#FEF3C7' },
  'Backlog': { label: 'Pending', barColor: '#9CA3AF', bgColor: '#F3F4F6' },
  'Blocked': { label: 'Blocked', barColor: '#EF4444', bgColor: '#FEE2E2' },
};

export function UtilizationPieChart({ data }: UtilizationPieChartProps) {
  const total = data.reduce((acc, item) => acc + item.value, 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-[#6366F1]" />
          <h3 className="text-lg font-semibold text-[#1A1D26]">
            Task Status
          </h3>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-[#1A1D26]">{total}</p>
          <p className="text-xs text-[#9CA3AF]">Total Tasks</p>
        </div>
      </div>

      {/* Progress Bars */}
      <div className="space-y-5 pt-2">
        {data.map((item, index) => {
          const config = BAR_CONFIG[item.name] || { label: item.name, barColor: '#6B7280', bgColor: '#F3F4F6' };
          const percentage = total > 0 ? Math.round((item.value / total) * 100) : 0;

          return (
            <motion.div
              key={item.name}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1, duration: 0.4 }}
            >
              {/* Label Row */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: config.barColor }}
                  />
                  <span className="text-sm font-medium text-gray-700">{config.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-gray-900">{item.value}</span>
                  <span className="text-xs text-gray-400">({percentage}%)</span>
                </div>
              </div>

              {/* Bar */}
              <div
                className="w-full h-3 rounded-full overflow-hidden"
                style={{ backgroundColor: config.bgColor }}
              >
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: config.barColor }}
                  initial={{ width: 0 }}
                  animate={{ width: `${percentage}%` }}
                  transition={{ delay: index * 0.1 + 0.2, duration: 0.8, ease: 'easeOut' }}
                />
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Summary */}
      <div className="pt-4 border-t border-[#F3F4F6]">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#3B82F6]" />
            <span className="text-[#6B7280]">
              <span className="font-medium text-[#1A1D26]">
                {(data.find(d => d.name === 'In Progress')?.value || 0)}
              </span> active
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#9CA3AF]" />
            <span className="text-[#6B7280]">
              <span className="font-medium text-[#1A1D26]">
                {(data.find(d => d.name === 'Backlog')?.value || 0)}
              </span> pending
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#EF4444]" />
            <span className="text-[#6B7280]">
              <span className="font-medium text-[#1A1D26]">
                {(data.find(d => d.name === 'Blocked')?.value || 0)}
              </span> blocked
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
