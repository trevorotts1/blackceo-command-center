'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useInView } from 'framer-motion';
import { AlertCircle, Users, Clock } from 'lucide-react';

export type DepartmentStatus = 'active' | 'blocked' | 'idle';

export interface DepartmentPerformance {
  id: string;
  name: string;
  icon: string;
  status: DepartmentStatus;
  progress: number;
  stats: {
    inProgress: number;
    done: number;
    backlog: number;
  };
  agentCount: number;
  lastActivity: string;
  blockers?: string[];
}

interface DepartmentCardProps {
  department: DepartmentPerformance;
  index: number;
  onClick?: () => void;
}

const statusConfig = {
  active: {
    dotColor: 'bg-emerald-500',
    pulseColor: 'bg-emerald-400',
    label: 'Active',
    labelColor: 'text-emerald-700',
    bgColor: 'bg-emerald-50',
  },
  blocked: {
    dotColor: 'bg-red-500',
    pulseColor: 'bg-red-400',
    label: 'Blocked',
    labelColor: 'text-red-700',
    bgColor: 'bg-red-50',
  },
  idle: {
    dotColor: 'bg-gray-400',
    pulseColor: 'bg-gray-300',
    label: 'Idle',
    labelColor: 'text-gray-600',
    bgColor: 'bg-gray-100',
  },
};

function formatLastActivity(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays}d ago`;
}

function ProgressBar({ progress, status }: { progress: number; status: DepartmentStatus }) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: '-50px' });

  const progressColor =
    status === 'blocked'
      ? 'bg-red-500'
      : progress >= 80
        ? 'bg-emerald-500'
        : progress >= 50
          ? 'bg-indigo-500'
          : 'bg-amber-500';

  return (
    <div ref={ref} className="h-2 bg-gray-100 rounded-full overflow-hidden">
      <motion.div
        className={`h-full rounded-full ${progressColor}`}
        initial={{ width: 0 }}
        animate={{ width: isInView ? `${progress}%` : 0 }}
        transition={{ duration: 0.8, delay: 0.2, ease: 'easeOut' }}
      />
    </div>
  );
}

export function DepartmentCard({ department, index, onClick }: DepartmentCardProps) {
  const status = statusConfig[department.status];
  const hasBlockers = department.blockers && department.blockers.length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.4,
        delay: index * 0.05,
        ease: [0.25, 0.46, 0.45, 0.94] as [number, number, number, number],
      }}
      whileHover={{
        y: -4,
        transition: { duration: 0.2 },
      }}
      onClick={onClick}
      className={`group relative bg-white rounded-2xl border border-gray-200 p-4 shadow-sm hover:shadow-lg hover:shadow-gray-200/50 hover:border-indigo-200 transition-all duration-300 ${onClick ? 'cursor-pointer' : ''}`}
    >
      {/* Header: Icon + Name + Status */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-br from-gray-50 to-gray-100 text-lg shadow-sm">
            {department.icon}
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 text-sm leading-tight">
              {department.name}
            </h3>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="relative flex h-2 w-2">
                {department.status === 'active' && (
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full ${status.pulseColor} opacity-75`}
                  />
                )}
                <span className={`relative inline-flex rounded-full h-2 w-2 ${status.dotColor}`} />
              </span>
              <span className={`text-xs font-medium ${status.labelColor}`}>
                {status.label}
              </span>
            </div>
          </div>
        </div>

        {/* Blocker Badge */}
        {hasBlockers && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="flex items-center gap-1 px-2 py-1 bg-red-50 border border-red-200 rounded-lg"
            title={department.blockers?.join(', ')}
          >
            <AlertCircle className="h-3.5 w-3.5 text-red-500" />
            <span className="text-xs font-semibold text-red-600">
              {department.blockers?.length}
            </span>
          </motion.div>
        )}
      </div>

      {/* Stats Row */}
      <div className="mb-4 text-xs text-gray-400">
        <span className="font-medium text-indigo-400">{department.stats.inProgress}</span> active · <span className="font-medium text-emerald-400">{department.stats.done}</span> done · <span className="font-medium text-gray-400">{department.stats.backlog}</span> backlog
      </div>

      {/* Progress Bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-gray-500">Completion</span>
          <span className="text-xs font-semibold text-gray-900">
            {department.progress}%
          </span>
        </div>
        <ProgressBar progress={department.progress} status={department.status} />
      </div>

      {/* Footer: Agent Count + Last Activity */}
      <div className="flex items-center justify-between pt-3 border-t border-gray-100">
        <div className="flex items-center gap-1.5 text-gray-500">
          <Users className="h-3.5 w-3.5" />
          <span className="text-xs font-medium">
            {department.agentCount} {department.agentCount === 1 ? 'agent' : 'agents'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-gray-400">
          <Clock className="h-3.5 w-3.5" />
          <span className="text-xs">
            {formatLastActivity(department.lastActivity)}
          </span>
        </div>
      </div>
    </motion.div>
  );
}