'use client';

import { motion } from 'framer-motion';
import { Activity, Gauge, Cog } from 'lucide-react';

interface OpsKPI {
  label: string;
  value: string;
  unit?: string;
  barPercent: number;
  barColor: string;
  icon: React.ReactNode;
}

const OPS_KPIS: OpsKPI[] = [
  {
    label: 'System Downtime',
    value: '5.44',
    unit: 'hrs',
    barPercent: 22,
    barColor: 'bg-rose-400',
    icon: <Activity className="h-4 w-4" />,
  },
  {
    label: 'Task Throughput',
    value: '13.17',
    unit: 'units/h',
    barPercent: 65,
    barColor: 'bg-amber-400',
    icon: <Gauge className="h-4 w-4" />,
  },
  {
    label: 'Process Automation',
    value: '60.57',
    unit: '%',
    barPercent: 60,
    barColor: 'bg-emerald-400',
    icon: <Cog className="h-4 w-4" />,
  },
];

export default function OperationsKPITiles() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {OPS_KPIS.map((kpi, idx) => (
        <motion.div
          key={kpi.label}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 + idx * 0.08, duration: 0.4 }}
          className="bg-white/80 backdrop-blur-sm rounded-xl p-5 border border-gray-100 hover:shadow-sm transition-shadow"
        >
          <div className="flex items-center gap-2 mb-3 text-gray-400">
            {kpi.icon}
            <span className="text-xs font-bold uppercase tracking-wider">{kpi.label}</span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-bold text-gray-900 font-mono">{kpi.value}</span>
            {kpi.unit && (
              <span className="text-sm font-medium text-gray-500">{kpi.unit}</span>
            )}
          </div>
          <div className="mt-3 w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
            <motion.div
              className={`h-full rounded-full ${kpi.barColor}`}
              initial={{ width: 0 }}
              animate={{ width: `${kpi.barPercent}%` }}
              transition={{ delay: 0.3 + idx * 0.1, duration: 0.8, ease: 'easeOut' }}
            />
          </div>
        </motion.div>
      ))}
    </div>
  );
}
