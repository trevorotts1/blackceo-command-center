'use client';

import { motion } from 'framer-motion';
import { ArrowRight, Zap, TrendingUp, Shield } from 'lucide-react';

const PLACEHOLDER_RECOMMENDATIONS = [
  {
    id: '1',
    icon: Zap,
    gradient: 'from-indigo-500 to-violet-600',
    title: 'Boost Agent Velocity',
    body: 'Assign parallel tasks to idle agents to increase throughput by up to 40%.',
  },
  {
    id: '2',
    icon: TrendingUp,
    gradient: 'from-amber-500 to-orange-600',
    title: 'Clear Blocked Tasks',
    body: 'Resolve dependency chains in 3 departments to unblock 5 pending tasks.',
  },
  {
    id: '3',
    icon: Shield,
    gradient: 'from-emerald-500 to-teal-600',
    title: 'Review Compliance',
    body: "Devil's Advocate flagged 2 recommendations that haven't been addressed.",
  },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: [0.4, 0, 0.2, 1] as [number, number, number, number],
    },
  },
};

export function RecommendationsRow() {
  return (
    <motion.div
      className="grid grid-cols-1 md:grid-cols-3 gap-4"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {PLACEHOLDER_RECOMMENDATIONS.map((rec) => {
        const Icon = rec.icon;
        return (
          <motion.div
            key={rec.id}
            variants={cardVariants}
            className="rounded-2xl shadow-sm border-0 p-6 hover:shadow-md transition-shadow"
            style={{
              backgroundColor: 'rgba(255,255,255,0.88)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}
          >
            {/* Icon */}
            <div
              className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${rec.gradient}`}
            >
              <Icon className="h-5 w-5 text-white" />
            </div>

            {/* Title */}
            <h3 className="text-base font-bold text-[#1A1A1A] mt-3">
              {rec.title}
            </h3>

            {/* Body */}
            <p className="text-sm text-[#666666] mt-1 line-clamp-2">{rec.body}</p>

            {/* Action Link */}
            <button className="flex items-center gap-1 mt-3 text-xs font-medium text-emerald-600 hover:text-emerald-700 transition-colors">
              Take action
              <ArrowRight className="h-3 w-3" />
            </button>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
