'use client';

import { motion } from 'framer-motion';
import { BarChart3 } from 'lucide-react';
import { ComparisonBar } from './ComparisonBar';

interface BenchmarkMetric {
  label: string;
  yourValue: number;
  industryValue: number;
  bestValue: number;
  unit?: string;
  format: 'percentage' | 'number';
}

const BENCHMARK_DATA: BenchmarkMetric[] = [
  {
    label: 'SOP Coverage',
    yourValue: 78,
    industryValue: 65,
    bestValue: 92,
    format: 'percentage',
  },
  {
    label: 'Agent Activity',
    yourValue: 94,
    industryValue: 71,
    bestValue: 95,
    format: 'percentage',
  },
  {
    label: 'Task Throughput',
    yourValue: 18,
    industryValue: 12,
    bestValue: 28,
    unit: '/week',
    format: 'number',
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.15,
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
      ease: [0.4, 0, 0.2, 1] as [number, number, number, number],
    },
  },
};

export function BenchmarkingSection() {
  return (
    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
      {/* Section Header */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mb-8"
      >
        <div className="flex items-center gap-3 mb-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-50">
            <BarChart3 className="h-5 w-5 text-indigo-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Industry Benchmarking</h2>
          </div>
        </div>
        <p className="text-sm text-gray-500 ml-[52px]">
          Compare your AI workforce performance against industry averages and best practices.
        </p>
      </motion.div>

      {/* Legend */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3, duration: 0.4 }}
        className="mb-6 flex flex-wrap items-center gap-4 rounded-xl bg-gray-50 px-4 py-3"
      >
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded bg-gradient-to-r from-indigo-500 to-violet-500" />
          <span className="text-xs font-medium text-gray-600">Your Score</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-3 w-0.5 bg-amber-500" />
          <span className="text-xs font-medium text-gray-600">Industry Average</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-400">Best: 92%</span>
        </div>
      </motion.div>

      {/* Benchmarking Metrics */}
      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="space-y-8"
      >
        {BENCHMARK_DATA.map((metric) => (
          <motion.div key={metric.label} variants={itemVariants}>
            <ComparisonBar
              label={metric.label}
              yourValue={metric.yourValue}
              industryValue={metric.industryValue}
              bestValue={metric.bestValue}
              unit={metric.unit}
              format={metric.format}
            />
          </motion.div>
        ))}
      </motion.div>

      {/* Footer summary */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.8, duration: 0.4 }}
        className="mt-8 rounded-2xl bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-100 p-4"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600 text-lg">
            ✓
          </div>
          <div>
            <p className="text-sm font-semibold text-emerald-900">
              Performing above industry average
            </p>
            <p className="text-xs text-emerald-700 mt-1">
              Your AI workforce is outperforming industry benchmarks in 2 out of 3 key metrics.
              Focus on SOP Coverage to reach best-in-class performance.
            </p>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
