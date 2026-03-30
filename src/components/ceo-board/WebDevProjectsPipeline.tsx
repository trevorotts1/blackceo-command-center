'use client';

import { motion } from 'framer-motion';
import { ExternalLink } from 'lucide-react';

interface Project {
  name: string;
  tag: string;
  progress: number;
  barColor: string;
  emoji: string;
}

const PROJECTS: Project[] = [
  {
    name: 'Website Redesign',
    tag: 'Frontend · 65% Complete',
    progress: 65,
    barColor: 'bg-brand-500',
    emoji: '🌐',
  },
  {
    name: 'API Integration',
    tag: 'Backend · 40% Complete',
    progress: 40,
    barColor: 'bg-blue-500',
    emoji: '🔗',
  },
];

export default function WebDevProjectsPipeline() {
  return (
    <div
      className="rounded-2xl shadow-sm border border-gray-100 p-6"
      style={{
        backgroundColor: 'rgba(255,255,255,0.95)',
      }}
    >
      <h3 className="text-lg font-bold text-gray-900 mb-4">Project Pipeline</h3>
      <div className="space-y-4">
        {PROJECTS.map((project) => (
          <div key={project.name} className="flex gap-4">
            <div className="min-w-[48px] h-12 rounded-lg bg-gray-100 overflow-hidden flex items-center justify-center text-lg">
              {project.emoji}
            </div>
            <div className="flex-1 min-w-0">
              <h5 className="text-sm font-bold text-gray-900">{project.name}</h5>
              <p className="text-xs text-gray-500 mb-2">{project.tag}</p>
              <div className="w-full bg-gray-100 h-1.5 rounded-full overflow-hidden">
                <motion.div
                  className={`h-full rounded-full ${project.barColor}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${project.progress}%` }}
                  transition={{ duration: 0.7, ease: 'easeOut', delay: 0.3 }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <button className="w-full mt-6 py-3 bg-gray-100 font-bold text-sm rounded-full text-gray-700 hover:bg-gray-200 transition-colors flex items-center justify-center gap-2">
        <ExternalLink className="h-4 w-4" />
        View Pipeline
      </button>
    </div>
  );
}
