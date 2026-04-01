'use client';

import { motion } from 'framer-motion';
import { Layers } from 'lucide-react';

interface ActiveSprintCardProps {
  sprintName?: string;
}

export default function ActiveSprintCard({ sprintName = 'Nexus Phase 4' }: ActiveSprintCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4, duration: 0.4 }}
      className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex items-center justify-between"
    >
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-brand-50 rounded-lg flex items-center justify-center">
          <Layers className="h-4 w-4 text-brand-600" />
        </div>
        <div>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Active Sprint</p>
          <p className="font-bold text-base text-gray-900">{sprintName}</p>
        </div>
      </div>
      <div className="flex -space-x-2">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className={`w-8 h-8 rounded-full border-2 border-white flex items-center justify-center text-[10px] font-bold text-white ${
              i === 1 ? 'bg-gradient-to-br from-amber-400 to-rose-400' :
              i === 2 ? 'bg-gradient-to-br from-blue-400 to-indigo-400' :
              'bg-gray-200 text-gray-600'
            }`}
          >
            {i === 3 ? '+8' : ''}
          </div>
        ))}
      </div>
    </motion.div>
  );
}
