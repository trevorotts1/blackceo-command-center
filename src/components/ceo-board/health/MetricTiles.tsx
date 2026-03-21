'use client';

import { motion, useSpring, useTransform } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Building2, CheckCircle2, Users, AlertTriangle } from 'lucide-react';

interface MetricTilesProps {
  metrics: {
    activeDepartments: number;
    totalDepartments: number;
    taskCompletionRate: number;
    agentCoverage: number;
    totalAgents: number;
    activeBlockers: number;
  };
}

interface MetricTileProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  displayValue: string;
  subtitle?: string;
  color: string;
  bgColor: string;
  delay: number;
}

function AnimatedCounter({ value, duration = 1.5 }: { value: number; duration?: number }) {
  const [displayValue, setDisplayValue] = useState(0);
  const spring = useSpring(0, {
    stiffness: 50,
    damping: 20,
    duration,
  });

  useEffect(() => {
    spring.set(value);
  }, [value, spring]);

  useEffect(() => {
    const unsubscribe = spring.on('change', (latest) => {
      setDisplayValue(Math.round(latest));
    });
    return () => unsubscribe();
  }, [spring]);

  return <span>{displayValue}</span>;
}

function MetricTile({ icon, label, value, displayValue, subtitle, color, bgColor, delay }: MetricTileProps) {
  return (
    <motion.div
      className="relative bg-white rounded-xl p-4 border border-gray-100 shadow-sm cursor-pointer group overflow-hidden"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.4,
        delay,
        ease: [0.25, 0.1, 0.25, 1] as [number, number, number, number],
      }}
      whileHover={{
        y: -4,
        boxShadow: '0 10px 25px rgba(0, 0, 0, 0.1)',
        transition: { duration: 0.2 },
      }}
    >
      {/* Hover glow effect */}
      <motion.div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          background: `linear-gradient(135deg, ${bgColor}20 0%, transparent 60%)`,
        }}
      />

      <div className="relative flex items-start gap-3">
        <div
          className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: bgColor }}
        >
          <div style={{ color }}>{icon}</div>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider truncate">
            {label}
          </p>
          <p className="text-2xl font-bold text-gray-900 mt-0.5">
            {displayValue.includes('%') ? (
              <>
                <AnimatedCounter value={value} />%
              </>
            ) : (
              <AnimatedCounter value={value} />
            )}
          </p>
          {subtitle && (
            <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>
          )}
        </div>
      </div>

      {/* Bottom accent line */}
      <motion.div
        className="absolute bottom-0 left-0 h-0.5 rounded-full"
        style={{ backgroundColor: color }}
        initial={{ width: 0 }}
        animate={{ width: '100%' }}
        transition={{ duration: 0.8, delay: delay + 0.3 }}
      />
    </motion.div>
  );
}

export function MetricTiles({ metrics }: MetricTilesProps) {
  const tiles = [
    {
      icon: <Building2 className="w-5 h-5" />,
      label: 'Active Departments',
      value: metrics.activeDepartments,
      displayValue: `${metrics.activeDepartments}`,
      subtitle: `of ${metrics.totalDepartments} total`,
      color: '#4F46E5',
      bgColor: '#EEF2FF',
    },
    {
      icon: <CheckCircle2 className="w-5 h-5" />,
      label: 'Task Completion',
      value: Math.round(metrics.taskCompletionRate * 100),
      displayValue: `${Math.round(metrics.taskCompletionRate * 100)}%`,
      subtitle: 'This week',
      color: '#10B981',
      bgColor: '#ECFDF5',
    },
    {
      icon: <Users className="w-5 h-5" />,
      label: 'Agent Coverage',
      value: metrics.agentCoverage,
      displayValue: `${metrics.agentCoverage}`,
      subtitle: `${metrics.totalAgents} total agents`,
      color: '#8B5CF6',
      bgColor: '#F5F3FF',
    },
    {
      icon: <AlertTriangle className="w-5 h-5" />,
      label: 'Active Blockers',
      value: metrics.activeBlockers,
      displayValue: `${metrics.activeBlockers}`,
      subtitle: metrics.activeBlockers > 0 ? 'Needs attention' : 'All clear',
      color: metrics.activeBlockers > 0 ? '#DC2626' : '#10B981',
      bgColor: metrics.activeBlockers > 0 ? '#FEF2F2' : '#ECFDF5',
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {tiles.map((tile, index) => (
        <MetricTile
          key={tile.label}
          {...tile}
          delay={0.2 + index * 0.05}
        />
      ))}
    </div>
  );
}
