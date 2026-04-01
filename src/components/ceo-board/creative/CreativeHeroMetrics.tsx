'use client';

import { motion } from 'framer-motion';
import { TrendingUp, ShieldCheck, Sparkles, FileText } from 'lucide-react';

interface CreativeMetric {
  label: string;
  value: string;
  trend: string;
  progressPercent: number;
  icon: React.ReactNode;
  barColor: string;
  iconBg: string;
}

const METRICS: CreativeMetric[] = [
  {
    label: 'Brand Consistency',
    value: '80.45%',
    trend: '+18%',
    progressPercent: 80.45,
    icon: <ShieldCheck className="h-8 w-8" />,
    barColor: 'bg-amber-400',
    iconBg: 'text-amber-500',
  },
  {
    label: 'Quality Score',
    value: '90.4%',
    trend: '+11%',
    progressPercent: 90.4,
    icon: <Sparkles className="h-8 w-8" />,
    barColor: 'bg-emerald-500',
    iconBg: 'text-emerald-500',
  },
  {
    label: 'Content Output',
    value: '16.4',
    trend: '+7%',
    progressPercent: 65,
    icon: <FileText className="h-8 w-8" />,
    barColor: 'bg-amber-400',
    iconBg: 'text-amber-500',
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1] as const },
  },
};

function ContentOutputBars() {
  const heights = [32, 28, 48, 24, 40];
  const colors = ['bg-gray-200', 'bg-gray-200', 'bg-amber-300', 'bg-gray-200', 'bg-amber-400'];
  return (
    <div className="flex gap-1 mt-4">
      {heights.map((h, i) => (
        <div
          key={i}
          className={`flex-1 rounded-sm ${colors[i]}`}
          style={{ height: h }}
        />
      ))}
    </div>
  );
}

export default function CreativeHeroMetrics() {
  return (
    <motion.div
      className="grid grid-cols-1 md:grid-cols-3 gap-6"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {METRICS.map((metric) => (
        <motion.div
          key={metric.label}
          variants={cardVariants}
          className="relative overflow-hidden rounded-2xl p-8 shadow-sm border-0 group"
          style={{
            backgroundColor: 'rgba(255,255,255,0.88)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
        >
          {/* Decorative icon top-right */}
          <div className="absolute top-4 right-4 opacity-10 group-hover:opacity-20 transition-opacity">
            <span className={metric.iconBg}>{metric.icon}</span>
          </div>

          <p className="text-sm font-medium text-gray-500 mb-4">{metric.label}</p>

          <div className="flex items-baseline gap-2">
            <h3 className="text-4xl font-extrabold text-gray-900 font-sans">
              {metric.value}
            </h3>
            <span className="flex items-center gap-0.5 text-emerald-600 text-sm font-bold">
              <TrendingUp className="h-4 w-4" />
              {metric.trend}
            </span>
          </div>

          {metric.label === 'Content Output' ? (
            <ContentOutputBars />
          ) : (
            <div className="mt-6 w-full bg-gray-100 h-2 rounded-full overflow-hidden">
              <motion.div
                className={`h-full rounded-full ${metric.barColor}`}
                initial={{ width: 0 }}
                animate={{ width: `${metric.progressPercent}%` }}
                transition={{ duration: 0.8, ease: 'easeOut', delay: 0.2 }}
              />
            </div>
          )}
        </motion.div>
      ))}
    </motion.div>
  );
}
