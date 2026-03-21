'use client';

import { motion } from 'framer-motion';

interface ComparisonBarProps {
  label: string;
  yourValue: number;
  industryValue: number;
  bestValue: number;
  unit?: string;
  format?: 'percentage' | 'number';
}

export function ComparisonBar({
  label,
  yourValue,
  industryValue,
  bestValue,
  unit = '',
  format = 'percentage',
}: ComparisonBarProps) {
  // Calculate delta percentage
  const delta = Math.round(((yourValue - industryValue) / industryValue) * 100);
  const isPositive = delta >= 0;

  // Calculate bar positions (as percentage of the chart width)
  // Use bestValue as the max for scaling
  const yourPercent = Math.min((yourValue / bestValue) * 100, 100);
  const industryPercent = Math.min((industryValue / bestValue) * 100, 100);

  // Format values for display
  const formatValue = (value: number) => {
    if (format === 'percentage') {
      return `${value}%`;
    }
    return `${value}${unit}`;
  };

  return (
    <div className="space-y-3">
      {/* Header with label and delta badge */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-gray-900">{formatValue(yourValue)}</span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
              isPositive
                ? 'bg-emerald-100 text-emerald-700'
                : 'bg-rose-100 text-rose-700'
            }`}
          >
            {isPositive ? '+' : ''}{delta}%
          </span>
        </div>
      </div>

      {/* Animated bar container */}
      <div className="relative h-10 rounded-xl bg-gray-100 overflow-hidden">
        {/* Background grid lines for visual reference */}
        <div className="absolute inset-0 flex">
          <div className="flex-1 border-r border-gray-200/50" />
          <div className="flex-1 border-r border-gray-200/50" />
          <div className="flex-1 border-r border-gray-200/50" />
          <div className="flex-1" />
        </div>

        {/* Your value bar - animated */}
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${yourPercent}%` }}
          transition={{ duration: 1, ease: [0.4, 0, 0.2, 1] as [number, number, number, number], delay: 0.2 }}
          className="absolute top-2 bottom-2 left-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-500 shadow-sm"
        />

        {/* Industry average marker line */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-amber-500 z-10"
          style={{ left: `${industryPercent}%` }}
        >
          {/* Marker tooltip */}
          <div className="absolute -top-1 left-1/2 -translate-x-1/2">
            <div className="w-2 h-2 bg-amber-500 rotate-45 transform" />
          </div>
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full pt-1">
            <span className="text-[10px] font-medium text-amber-600 whitespace-nowrap bg-amber-50 px-1.5 py-0.5 rounded">
              Industry: {formatValue(industryValue)}
            </span>
          </div>
        </div>

        {/* Best practice marker (subtle) */}
        <div className="absolute top-0 bottom-0 right-2 flex items-center">
          <span className="text-[10px] font-medium text-gray-400">
            Best: {formatValue(bestValue)}
          </span>
        </div>
      </div>

      {/* Best practice text */}
      <p className="text-xs text-gray-500">
        Industry best practice: {formatValue(bestValue)}
      </p>
    </div>
  );
}
