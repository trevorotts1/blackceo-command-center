'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Clock, Zap, CheckCircle2, AlertCircle, Timer } from 'lucide-react';
import type { ExecutionQueueItem } from '@/lib/types';

interface QueueItemWithDisplay extends ExecutionQueueItem {
  display_status: 'queued' | 'running' | 'completed' | 'failed';
}

const departmentBadgeColors: Record<string, string> = {
  marketing: 'bg-pink-50 text-pink-700',
  sales: 'bg-emerald-50 text-emerald-700',
  finance: 'bg-blue-50 text-blue-700',
  operations: 'bg-amber-50 text-amber-700',
  product: 'bg-violet-50 text-violet-700',
  engineering: 'bg-cyan-50 text-cyan-700',
  hr: 'bg-rose-50 text-rose-700',
  legal: 'bg-slate-50 text-slate-700',
};

function getTimeWindowInfo() {
  const now = new Date();
  const hour = now.getHours();
  const isActive = hour >= 17 || hour < 9;

  if (isActive) {
    const endDate = new Date(now);
    if (hour >= 17) {
      endDate.setDate(endDate.getDate() + 1);
    }
    endDate.setHours(9, 0, 0, 0);
    return {
      isActive: true,
      label: 'Execution window active',
      sublabel: 'Until 9:00 AM',
    };
  } else {
    const startDate = new Date(now);
    startDate.setHours(17, 0, 0, 0);
    return {
      isActive: false,
      label: 'Next execution window',
      sublabel: 'Tonight 5:00 PM',
    };
  }
}

function getStatusPill(displayStatus: QueueItemWithDisplay['display_status']) {
  switch (displayStatus) {
    case 'running':
      return {
        label: 'Running now',
        className: 'bg-emerald-100 text-emerald-700',
        icon: Zap,
      };
    case 'queued':
      return {
        label: 'Queued for tonight',
        className: 'bg-amber-50 text-amber-700',
        icon: Timer,
      };
    case 'completed':
      return {
        label: 'Completed',
        className: 'bg-gray-100 text-gray-600',
        icon: CheckCircle2,
      };
    case 'failed':
      return {
        label: 'Failed',
        className: 'bg-red-50 text-red-700',
        icon: AlertCircle,
      };
  }
}

function formatQueuedTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function ExecutionQueueSection() {
  const [items, setItems] = useState<QueueItemWithDisplay[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [timeWindow, setTimeWindow] = useState(getTimeWindowInfo());

  useEffect(() => {
    let cancelled = false;

    async function loadQueue() {
      try {
        setIsLoading(true);
        const res = await fetch('/api/execution-queue?limit=20');
        if (!res.ok) throw new Error('Failed to fetch');
        const data = await res.json();
        if (!cancelled) setItems(data);
      } catch (error) {
        console.error('Error fetching execution queue:', error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadQueue();

    const interval = setInterval(() => {
      setTimeWindow(getTimeWindowInfo());
    }, 60000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const activeItems = items.filter(
    (i) => i.status !== 'completed' && i.status !== 'failed'
  );
  const completedItems = items.filter(
    (i) => i.status === 'completed' || i.status === 'failed'
  );

  return (
    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
      {/* Section Header */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mb-6"
      >
        <div className="flex items-center gap-3 mb-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-50">
            <Clock className="h-5 w-5 text-indigo-500" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">
              Execution Queue
            </h2>
          </div>
        </div>
        <p className="text-sm text-gray-500 ml-[52px]">
          Approved tasks scheduled for overnight execution.
        </p>
      </motion.div>

      {/* Time Window Indicator */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.15, duration: 0.4 }}
        className={`mb-6 flex items-center gap-3 rounded-xl px-4 py-3 border ${
          timeWindow.isActive
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-gray-50 border-gray-200'
        }`}
      >
        <div
          className={`h-2.5 w-2.5 rounded-full ${
            timeWindow.isActive
              ? 'bg-emerald-500 animate-pulse'
              : 'bg-gray-400'
          }`}
        />
        <div>
          <p
            className={`text-sm font-medium ${
              timeWindow.isActive ? 'text-emerald-700' : 'text-gray-700'
            }`}
          >
            {timeWindow.label}
          </p>
          <p
            className={`text-xs ${
              timeWindow.isActive ? 'text-emerald-600' : 'text-gray-500'
            }`}
          >
            {timeWindow.sublabel}
          </p>
        </div>
      </motion.div>

      {/* Queue List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
        </div>
      ) : items.length === 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2, duration: 0.4 }}
          className="text-center py-12"
        >
          <Clock className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">
            No tasks queued. Approve recommendations to add them to the
            overnight queue.
          </p>
        </motion.div>
      ) : (
        <div className="space-y-3">
          {/* Active items first */}
          {activeItems.map((item, index) => {
            const pill = getStatusPill(item.display_status);
            const PillIcon = pill.icon;
            const badgeClass =
              departmentBadgeColors[item.department?.toLowerCase() || ''] ||
              'bg-gray-50 text-gray-600';

            return (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05, duration: 0.25 }}
                className="flex items-center gap-4 rounded-xl border border-gray-100 bg-white p-4 hover:border-gray-200 transition-colors"
              >
                <div
                  className={`h-2 w-2 rounded-full flex-shrink-0 ${
                    item.display_status === 'running'
                      ? 'bg-emerald-500 animate-pulse'
                      : 'bg-amber-400'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {item.task_name}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Queued {formatQueuedTime(item.queued_at)}
                  </p>
                </div>
                {item.department && (
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${badgeClass}`}
                  >
                    {item.department}
                  </span>
                )}
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium flex-shrink-0 ${pill.className}`}
                >
                  <PillIcon className="h-3 w-3" />
                  {pill.label}
                </span>
              </motion.div>
            );
          })}

          {/* Completed/failed items */}
          {completedItems.length > 0 && (
            <>
              <div className="pt-3 pb-1">
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Recently completed
                </p>
              </div>
              {completedItems.map((item, index) => {
                const pill = getStatusPill(item.display_status);
                const PillIcon = pill.icon;
                const badgeClass =
                  departmentBadgeColors[item.department?.toLowerCase() || ''] ||
                  'bg-gray-50 text-gray-600';

                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      delay: (activeItems.length + index) * 0.05,
                      duration: 0.25,
                    }}
                    className="flex items-center gap-4 rounded-xl border border-gray-50 bg-gray-50/50 p-4 opacity-70"
                  >
                    <div
                      className={`h-2 w-2 rounded-full flex-shrink-0 ${
                        item.status === 'completed'
                          ? 'bg-gray-400'
                          : 'bg-red-400'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-700 truncate">
                        {item.task_name}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {item.completed_at
                          ? `Completed ${formatQueuedTime(item.completed_at)}`
                          : `Queued ${formatQueuedTime(item.queued_at)}`}
                      </p>
                    </div>
                    {item.department && (
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${badgeClass}`}
                      >
                        {item.department}
                      </span>
                    )}
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium flex-shrink-0 ${pill.className}`}
                    >
                      <PillIcon className="h-3 w-3" />
                      {pill.label}
                    </span>
                  </motion.div>
                );
              })}
            </>
          )}
        </div>
      )}
    </section>
  );
}
