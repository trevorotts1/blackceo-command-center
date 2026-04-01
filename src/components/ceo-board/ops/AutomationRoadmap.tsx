'use client';

import { motion } from 'framer-motion';
import { GitBranch, ArrowRight } from 'lucide-react';

interface RoadmapItem {
  title: string;
  description: string;
  status: 'in_progress' | 'queue' | 'completed';
  icon: React.ReactNode;
}

const ROADMAP_ITEMS: RoadmapItem[] = [
  {
    title: 'Centralized Data Pipeline',
    description: 'Consolidating disparate silos into a single source of truth.',
    status: 'in_progress',
    icon: <GitBranch className="h-5 w-5" />,
  },
  {
    title: 'AI Ticket Triage',
    description: 'Predictive analysis for incoming operational requests.',
    status: 'queue',
    icon: <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>,
  },
];

function getStatusBadge(status: RoadmapItem['status']) {
  switch (status) {
    case 'in_progress':
      return (
        <span className="px-3 py-1 bg-emerald-50 text-emerald-700 text-[10px] font-black uppercase rounded-full border border-emerald-100">
          In Progress
        </span>
      );
    case 'queue':
      return (
        <span className="px-3 py-1 bg-gray-100 text-gray-500 text-[10px] font-black uppercase rounded-full border border-gray-200">
          Queue
        </span>
      );
    case 'completed':
      return (
        <span className="px-3 py-1 bg-brand-50 text-brand-700 text-[10px] font-black uppercase rounded-full border border-brand-100">
          Done
        </span>
      );
  }
}

export default function AutomationRoadmap() {
  return (
    <div className="bg-white/80 backdrop-blur-md rounded-2xl border border-gray-100 shadow-sm p-6">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-lg font-bold text-gray-900">Automation Roadmap</h3>
        <button className="text-sm font-semibold text-brand-600 flex items-center gap-1 hover:text-brand-700 transition-colors">
          View Full Matrix <ArrowRight className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-3">
        {ROADMAP_ITEMS.map((item, idx) => (
          <motion.div
            key={item.title}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 + idx * 0.1, duration: 0.4 }}
            className="flex items-center gap-4 p-4 hover:bg-gray-50/80 rounded-xl transition-colors group"
          >
            <div className="w-11 h-11 bg-gray-100 rounded-full flex items-center justify-center text-gray-500 group-hover:bg-brand-50 group-hover:text-brand-600 transition-colors flex-shrink-0">
              {item.icon}
            </div>
            <div className="flex-1 min-w-0">
              <h5 className="font-semibold text-sm text-gray-900">{item.title}</h5>
              <p className="text-xs text-gray-500 mt-0.5">{item.description}</p>
            </div>
            <div className="flex-shrink-0">
              {getStatusBadge(item.status)}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
