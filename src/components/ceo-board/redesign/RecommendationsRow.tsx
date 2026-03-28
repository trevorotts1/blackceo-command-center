'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Zap, TrendingUp, Shield, Eye } from 'lucide-react';

interface Recommendation {
  id: string;
  title: string;
  description: string;
  category: string;
  confidence: number;
}

const CATEGORY_CONFIG: Record<string, { icon: typeof Zap; gradient: string }> = {
  'do-more': { icon: Zap, gradient: 'from-indigo-500 to-violet-600' },
  'try': { icon: TrendingUp, gradient: 'from-amber-500 to-orange-600' },
  'stop': { icon: Shield, gradient: 'from-red-500 to-rose-600' },
  'watch': { icon: Eye, gradient: 'from-emerald-500 to-teal-600' },
};

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
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchRecommendations() {
      try {
        const res = await fetch('/api/recommendations?status=pending&limit=3');
        if (res.ok) {
          const data = await res.json();
          setRecommendations(Array.isArray(data) ? data : []);
        }
      } catch {
        // empty state
      } finally {
        setLoading(false);
      }
    }
    fetchRecommendations();
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl shadow-sm p-6 animate-pulse bg-white/88 h-40" />
        ))}
      </div>
    );
  }

  if (recommendations.length === 0) {
    return (
      <div
        className="rounded-2xl shadow-sm border-0 p-8 text-center"
        style={{
          backgroundColor: 'rgba(255,255,255,0.88)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-gray-200 to-gray-300 mx-auto mb-3">
          <Zap className="h-5 w-5 text-gray-500" />
        </div>
        <p className="text-base font-medium text-gray-600">No recommendations yet</p>
        <p className="text-sm text-gray-400 mt-1">Recommendations will appear as your agents analyze performance data</p>
      </div>
    );
  }

  return (
    <motion.div
      className="grid grid-cols-1 md:grid-cols-3 gap-4"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {recommendations.map((rec) => {
        const config = CATEGORY_CONFIG[rec.category] || CATEGORY_CONFIG['watch'];
        const Icon = config.icon;
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
              className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br ${config.gradient}`}
            >
              <Icon className="h-5 w-5 text-white" />
            </div>

            {/* Title */}
            <h3 className="text-lg font-bold text-gray-900 mt-3">
              {rec.title}
            </h3>

            {/* Body */}
            <p className="text-base text-gray-600 mt-1 line-clamp-2">{rec.description}</p>

            {/* Confidence */}
            <div className="flex items-center gap-2 mt-3">
              <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full"
                  style={{ width: `${Math.round(rec.confidence * 100)}%` }}
                />
              </div>
              <span className="text-xs text-gray-500">{Math.round(rec.confidence * 100)}%</span>
            </div>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
