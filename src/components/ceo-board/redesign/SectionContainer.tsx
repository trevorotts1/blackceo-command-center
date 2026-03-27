'use client';

import { motion } from 'framer-motion';

interface SectionContainerProps {
  title: string;
  accentColor: string;
  context?: string;
  badge?: number;
  children: React.ReactNode;
}

export function SectionContainer({ title, accentColor, context, badge, children }: SectionContainerProps) {
  return (
    <div className="rounded-2xl bg-white/90 backdrop-blur-md shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
        <div className={`w-1 h-6 rounded-full ${accentColor} flex-shrink-0`} />
        <h2 className="text-section text-gray-900">{title}</h2>
        {badge !== undefined && badge > 0 && (
          <span className="text-badge font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
            {badge}
          </span>
        )}
        {context && (
          <span className="text-sm text-gray-400 ml-auto">{context}</span>
        )}
      </div>
      <div className="p-6">
        {children}
      </div>
    </div>
  );
}
