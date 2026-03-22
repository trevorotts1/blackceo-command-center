'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Lightbulb } from 'lucide-react';
import { RecommendationEngineCard } from './RecommendationEngineCard';
import type { Recommendation } from '@/lib/types';

interface EffectivenessStats {
  totalApproved: number;
  tracked: number;
  avgImprovement: number;
  topDepartment: string;
}

export function RecommendationsSection() {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [effectiveness, setEffectiveness] = useState<EffectivenessStats>({
    totalApproved: 0,
    tracked: 0,
    avgImprovement: 0,
    topDepartment: 'N/A',
  });

  useEffect(() => {
    fetchRecommendations();
    fetchEffectiveness();
  }, []);

  const fetchRecommendations = async () => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/recommendations?status=pending&limit=5');
      if (!res.ok) throw new Error('Failed to fetch recommendations');
      const data = await res.json();
      setRecommendations(data);
    } catch (error) {
      console.error('Error fetching recommendations:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchEffectiveness = async () => {
    try {
      const res = await fetch('/api/recommendations/effectiveness');
      if (!res.ok) return;
      const data = await res.json();
      setEffectiveness({
        totalApproved: data.totalApproved ?? 0,
        tracked: data.tracked ?? 0,
        avgImprovement: data.avgImprovement ?? 0,
        topDepartment: data.topDepartment ?? 'N/A',
      });
    } catch (error) {
      console.error('Error fetching effectiveness:', error);
    }
  };

  const handleStatusChange = (id: string, newStatus: string) => {
    // Remove dismissed cards from the list immediately for better UX
    if (newStatus === 'dismissed') {
      setRecommendations((prev) => prev.filter((rec) => rec.id !== id));
    } else {
      // For approved/saved, update the status in the list
      setRecommendations((prev) =>
        prev.map((rec) => (rec.id === id ? { ...rec, status: newStatus as Recommendation['status'] } : rec))
      );
    }
  };

  return (
    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
      {/* Section Header */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mb-6"
      >
        <div className="flex items-center gap-3 mb-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-50">
            <Lightbulb className="h-5 w-5 text-amber-500" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">AI Recommendations</h2>
          </div>
        </div>
        <p className="text-sm text-gray-500 ml-[52px]">
          Actionable insights based on your AI workforce performance and industry benchmarks.
        </p>
      </motion.div>

      {/* Effectiveness Stat Card */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.4 }}
        className="mb-6 pb-6 border-b border-gray-100"
      >
        <div className="flex items-center gap-6 text-xs text-gray-500">
          <div>
            <span className="font-semibold text-gray-700">{effectiveness.tracked}</span> recommendations tracked
          </div>
          <div className="w-px h-4 bg-gray-200" />
          <div>
            <span className="font-semibold text-gray-700">{effectiveness.avgImprovement}%</span> average improvement
          </div>
          <div className="w-px h-4 bg-gray-200" />
          <div>
            Top dept: <span className="font-semibold text-gray-700 capitalize">{effectiveness.topDepartment}</span>
          </div>
        </div>
      </motion.div>

      {/* Recommendations List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
        </div>
      ) : recommendations.length === 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.4 }}
          className="text-center py-12"
        >
          <p className="text-sm text-gray-500">
            No pending recommendations. Check back after agents complete more tasks.
          </p>
        </motion.div>
      ) : (
        <div className="space-y-4">
          {recommendations.map((rec, index) => (
            <motion.div
              key={rec.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1, duration: 0.3 }}
            >
              <RecommendationEngineCard
                id={rec.id}
                category={rec.category}
                title={rec.title}
                description={rec.description}
                supportingData={
                  typeof rec.supporting_data === 'string'
                    ? rec.supporting_data
                    : rec.supporting_data
                    ? JSON.stringify(rec.supporting_data, null, 2)
                    : undefined
                }
                confidence={rec.confidence}
                status={rec.status}
                departmentId={rec.department_id}
                onStatusChange={handleStatusChange}
              />
            </motion.div>
          ))}
        </div>
      )}

      {/* View All Link */}
      {!isLoading && recommendations.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.4 }}
          className="mt-6 text-center"
        >
          <button className="inline-flex items-center gap-2 text-sm font-medium text-[#6366F1] hover:text-indigo-700 transition-colors">
            View all recommendations
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </motion.div>
      )}
    </section>
  );
}
