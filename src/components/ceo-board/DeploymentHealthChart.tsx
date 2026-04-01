'use client';

import { useState } from 'react';
import { SectionContainer } from './redesign/SectionContainer';

interface DeployDay {
  day: string;
  count: number;
}

interface DeploymentHealthChartProps {
  dailyData?: DeployDay[];
  weeklyData?: DeployDay[];
}

const DEFAULT_DAILY: DeployDay[] = [
  { day: 'MON', count: 12 },
  { day: 'TUE', count: 21 },
  { day: 'WED', count: 27 },
  { day: 'THU', count: 32 },
  { day: 'FRI', count: 18 },
  { day: 'SAT', count: 22 },
  { day: 'SUN', count: 14 },
];

const DEFAULT_WEEKLY: DeployDay[] = [
  { day: 'W1', count: 87 },
  { day: 'W2', count: 104 },
  { day: 'W3', count: 95 },
  { day: 'W4', count: 112 },
];

export function DeploymentHealthChart({ dailyData, weeklyData }: DeploymentHealthChartProps) {
  const [view, setView] = useState<'daily' | 'weekly'>('weekly');

  const data = view === 'daily'
    ? (dailyData || DEFAULT_DAILY)
    : (weeklyData || DEFAULT_WEEKLY);

  const maxCount = Math.max(...data.map(d => d.count));
  const peakDay = data.reduce((max, d) => d.count > max.count ? d : max, data[0]);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <h3 className="text-lg font-bold text-gray-900">Deployment Health</h3>
        <div className="flex gap-1.5">
          {(['daily', 'weekly'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                view === v
                  ? 'bg-brand-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="p-6">
        <div className="flex items-end justify-between gap-3 h-48 px-2">
          {data.map((item) => {
            const heightPct = maxCount > 0 ? (item.count / maxCount) * 100 : 0;
            const isPeak = item.day === peakDay.day;

            return (
              <div key={item.day} className="flex-1 flex flex-col items-center gap-2 group relative">
                {/* Tooltip */}
                <div className={`absolute -top-2 left-1/2 -translate-x-1/2 -translate-y-full bg-gray-900 text-white px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-opacity ${
                  isPeak ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}>
                  {item.day}: {item.count} deploys{isPeak ? ' (Peak)' : ''}
                  <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                </div>
                {/* Bar */}
                <div
                  className={`w-full rounded-t-lg transition-colors duration-200 ${
                    isPeak
                      ? 'bg-brand-600'
                      : 'bg-gray-200 hover:bg-brand-300'
                  }`}
                  style={{ height: `${heightPct}%`, minHeight: '8px' }}
                />
              </div>
            );
          })}
        </div>
        <div className="flex justify-between mt-3 px-2">
          {data.map((item) => (
            <div key={item.day} className="flex-1 text-center">
              <span className="text-xs font-bold text-gray-400 uppercase">{item.day}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
