'use client';

import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { Target, Lock, Users, Lightbulb } from 'lucide-react';

interface MemoryCard {
  icon: ReactNode;
  title: string;
  description: string;
  borderColor: string;
  iconColor: string;
}

const MARKETING_MEMORIES: MemoryCard[] = [
  {
    icon: <Target className="h-5 w-5" />,
    title: 'Goals',
    description: 'Reduce cost per lead (CPL) to $20 by Q2 2026. Prioritize high-intent channels.',
    borderColor: 'border-amber-200',
    iconColor: 'text-amber-500',
  },
  {
    icon: <Lock className="h-5 w-5" />,
    title: 'Constraints',
    description: 'All campaigns must use BlackCEO brand colors (navy, gold, white).',
    borderColor: 'border-rose-200',
    iconColor: 'text-rose-500',
  },
  {
    icon: <Users className="h-5 w-5" />,
    title: 'Context',
    description: 'Primary audience is Black entrepreneurs aged 30-55 across US metro areas.',
    borderColor: 'border-indigo-200',
    iconColor: 'text-indigo-500',
  },
  {
    icon: <Lightbulb className="h-5 w-5" />,
    title: 'Lessons',
    description: 'Email sequences with personalization outperform generic blasts by 3x on open rates.',
    borderColor: 'border-purple-200',
    iconColor: 'text-purple-500',
  },
];

export default function MarketingMemoryDefaults() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {MARKETING_MEMORIES.map((card, idx) => (
        <motion.div
          key={card.title}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 + idx * 0.05 }}
          className={`bg-white/70 backdrop-blur-sm rounded-xl border ${card.borderColor} p-5 hover:shadow-sm transition-shadow`}
        >
          <div className="flex items-center gap-3 mb-3">
            <span className={card.iconColor}>{card.icon}</span>
            <h4 className="font-bold text-base text-gray-900">{card.title}</h4>
          </div>
          <p className="text-sm text-gray-600 leading-relaxed">
            {card.description}
          </p>
        </motion.div>
      ))}
    </div>
  );
}
