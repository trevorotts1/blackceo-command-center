'use client';

import { motion } from 'framer-motion';
import { Mic, AudioLines } from 'lucide-react';

interface Sprint {
  name: string;
  tag: string;
  progress: number;
  barColor: string;
}

const SPRINTS: Sprint[] = [
  {
    name: 'Luminous Ivory Launch',
    tag: '3D Motion Graphics \u2022 80% Complete',
    progress: 80,
    barColor: 'bg-amber-400',
  },
  {
    name: 'Editorial Refresh',
    tag: 'Brand Strategy \u2022 45% Complete',
    progress: 45,
    barColor: 'bg-emerald-500',
  },
];

export default function CreativeSprints() {
  return (
    <div className="flex flex-col gap-8">
      {/* Active Creative Sprints */}
      <div
        className="rounded-2xl shadow-sm border-0 p-8"
        style={{
          backgroundColor: 'rgba(255,255,255,0.88)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <h3 className="font-bold text-lg mb-6 text-gray-900">Active Creative Sprints</h3>
        <div className="space-y-6">
          {SPRINTS.map((sprint) => (
            <div key={sprint.name} className="flex gap-4">
              <div className="min-w-[48px] h-12 rounded-lg bg-gray-100 overflow-hidden flex items-center justify-center text-lg">
                {sprint.name === 'Luminous Ivory Launch' ? '🎨' : '📰'}
              </div>
              <div className="flex-1 min-w-0">
                <h5 className="text-sm font-bold text-gray-900">{sprint.name}</h5>
                <p className="text-[10px] text-gray-500 mb-2">{sprint.tag}</p>
                <div className="w-full bg-gray-100 h-1.5 rounded-full overflow-hidden">
                  <motion.div
                    className={`h-full rounded-full ${sprint.barColor}`}
                    initial={{ width: 0 }}
                    animate={{ width: `${sprint.progress}%` }}
                    transition={{ duration: 0.7, ease: 'easeOut', delay: 0.3 }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
        <button className="w-full mt-8 py-3 bg-gray-100 font-bold text-sm rounded-full text-gray-700 hover:bg-gray-200 transition-colors">
          View Pipeline
        </button>
      </div>

      {/* Voice Update */}
      <div className="rounded-2xl p-8 relative overflow-hidden bg-gray-900 text-white">
        <div className="relative z-10">
          <AudioLines className="h-6 w-6 text-amber-400 mb-4" />
          <h4 className="font-bold text-lg mb-2">Voice Update</h4>
          <p className="text-gray-400 text-xs leading-relaxed mb-6">
            &ldquo;Record your daily creative blockers and let the Concierge prioritize your task queue.&rdquo;
          </p>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-amber-400 flex items-center justify-center">
              <Mic className="h-5 w-5 text-gray-900" />
            </div>
            <div className="flex gap-1 items-end">
              {[16, 24, 12, 28, 20].map((h, i) => (
                <div
                  key={i}
                  className="w-1 rounded-full bg-gray-600"
                  style={{ height: h }}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-amber-400/10 rounded-full blur-3xl" />
      </div>
    </div>
  );
}
