'use client';

import { motion } from 'framer-motion';
import { Lightbulb } from 'lucide-react';
import { RecommendationCard } from './RecommendationCard';

interface Recommendation {
  id: string;
  priority: 'High' | 'Medium' | 'Low';
  department: 'Marketing' | 'Operations' | 'Sales' | 'Finance' | 'HR' | 'Product';
  description: string;
  impact: string;
}

const RECOMMENDATIONS_DATA: Recommendation[] = [
  {
    id: '1',
    priority: 'High',
    department: 'Marketing',
    description: 'Marketing needs 3 new SOPs to standardize campaign workflows and reduce onboarding time for new agents.',
    impact: '+15% efficiency',
  },
  {
    id: '2',
    priority: 'Medium',
    department: 'Sales',
    description: 'Sales team requires 2 additional AI agents to handle increased lead volume from Q2 campaigns.',
    impact: '+22% lead response rate',
  },
  {
    id: '3',
    priority: 'Medium',
    department: 'Operations',
    description: 'Operations should implement automated task routing to reduce manual assignment overhead.',
    impact: '-30% admin time',
  },
  {
    id: '4',
    priority: 'Low',
    department: 'Finance',
    description: 'Finance can optimize reporting workflows by consolidating weekly reports into a single dashboard.',
    impact: '+8% reporting speed',
  },
];

export function RecommendationsSection() {
  const handleViewDetails = (id: string) => {
    // This can be expanded to open a modal or navigate to details
    console.log('View details for recommendation:', id);
  };

  return (
    <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
      {/* Section Header */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mb-8"
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

      {/* Recommendations Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {RECOMMENDATIONS_DATA.map((recommendation, index) => (
          <RecommendationCard
            key={recommendation.id}
            priority={recommendation.priority}
            department={recommendation.department}
            description={recommendation.description}
            impact={recommendation.impact}
            onViewDetails={() => handleViewDetails(recommendation.id)}
            index={index}
          />
        ))}
      </div>

      {/* View All Link */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.6, duration: 0.4 }}
        className="mt-6 text-center"
      >
        <button className="inline-flex items-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-700 transition-colors">
          View all recommendations
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
        </button>
      </motion.div>
    </section>
  );
}
