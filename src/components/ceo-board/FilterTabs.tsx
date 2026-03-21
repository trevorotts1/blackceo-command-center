'use client';

import { motion } from 'framer-motion';

export type FilterTab = 'all' | 'active' | 'blocked' | 'idle';

interface FilterTabsProps {
  activeFilter: FilterTab;
  onFilterChange: (filter: FilterTab) => void;
  counts?: {
    all: number;
    active: number;
    blocked: number;
    idle: number;
  };
}

const tabs: { id: FilterTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'idle', label: 'Idle' },
];

export function FilterTabs({ activeFilter, onFilterChange, counts }: FilterTabsProps) {
  return (
    <div className="flex items-center gap-2 p-1 bg-gray-100/80 rounded-xl">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onFilterChange(tab.id)}
          className={`relative px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
            activeFilter === tab.id
              ? 'text-gray-900'
              : 'text-gray-500 hover:text-gray-700 hover:bg-gray-200/50'
          }`}
        >
          {activeFilter === tab.id && (
            <motion.div
              layoutId="activeFilter"
              className="absolute inset-0 bg-white rounded-lg shadow-sm"
              transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
            />
          )}
          <span className="relative z-10 flex items-center gap-2">
            {tab.label}
            {counts && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  activeFilter === tab.id
                    ? 'bg-gray-100 text-gray-700'
                    : 'bg-gray-200/50 text-gray-500'
                }`}
              >
                {counts[tab.id]}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
