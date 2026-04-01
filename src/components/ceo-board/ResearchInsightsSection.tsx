'use client';

import { motion } from 'framer-motion';
import { Target, AlertTriangle, Lightbulb, CheckCircle } from 'lucide-react';

interface FocusArea {
  text: string;
}

interface Constraint {
  text: string;
}

interface Lesson {
  title: string;
  description: string;
}

interface ResearchInsightsSectionProps {
  focusAreas?: FocusArea[];
  constraints?: Constraint[];
  lessons?: Lesson[];
}

const DEFAULT_FOCUS_AREAS: FocusArea[] = [
  { text: 'Black entrepreneurship trends and venture capital accessibility.' },
  { text: 'Next-generation fintech architectures and decentralization.' },
  { text: 'SaaS market dynamics and vertical-specific growth levers.' },
];

const DEFAULT_CONSTRAINTS: Constraint[] = [
  { text: 'All research claims must cite primary sources with verified links.' },
];

const DEFAULT_LESSONS: Lesson[] = [
  {
    title: 'Contract Optimization',
    description: 'Pre-approved contract templates reduced legal review time by 40% across all departmental workflows.',
  },
];

export function ResearchInsightsSection({
  focusAreas = DEFAULT_FOCUS_AREAS,
  constraints = DEFAULT_CONSTRAINTS,
  lessons = DEFAULT_LESSONS,
}: ResearchInsightsSectionProps) {
  return (
    <div className="space-y-6">
      {/* Focus Areas + Constraints side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Focus Areas */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white/80 backdrop-blur-md rounded-2xl p-6 shadow-sm border border-gray-100"
        >
          <h3 className="text-section text-gray-900 flex items-center gap-2 mb-4">
            <div className="h-8 w-8 flex items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <Target className="h-4 w-4" />
            </div>
            Focus Areas
          </h3>
          <ul className="space-y-3">
            {focusAreas.map((area, idx) => (
              <li key={idx} className="flex gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-gray-400 mt-2 flex-shrink-0" />
                <span className="text-sm text-gray-700 leading-relaxed">{area.text}</span>
              </li>
            ))}
          </ul>
        </motion.div>

        {/* Constraints */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="bg-white/80 backdrop-blur-md rounded-2xl p-6 shadow-sm border border-rose-100"
        >
          <h3 className="text-section text-rose-700 flex items-center gap-2 mb-4">
            <div className="h-8 w-8 flex items-center justify-center rounded-lg bg-rose-50 text-rose-600">
              <AlertTriangle className="h-4 w-4" />
            </div>
            Constraints
          </h3>
          <p className="text-sm text-gray-600 leading-relaxed mb-4">
            Compliance is non-negotiable for departmental validity.
          </p>
          <div className="p-4 bg-rose-50/60 rounded-xl border border-rose-100">
            {constraints.map((c, idx) => (
              <p key={idx} className="text-sm text-rose-800 font-medium">
                {c.text}
              </p>
            ))}
          </div>
        </motion.div>
      </div>

      {/* Lessons Learned */}
      {lessons.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-emerald-50/40 backdrop-blur-md rounded-2xl p-6 shadow-sm border border-emerald-100"
        >
          <h3 className="text-section text-emerald-700 flex items-center gap-2 mb-5">
            <div className="h-8 w-8 flex items-center justify-center rounded-lg bg-emerald-100 text-emerald-600">
              <Lightbulb className="h-4 w-4" />
            </div>
            Lessons Learned
          </h3>
          <div className="space-y-4">
            {lessons.map((lesson, idx) => (
              <div key={idx} className="flex gap-4 items-start">
                <div className="p-3 bg-emerald-100 rounded-xl flex-shrink-0">
                  <CheckCircle className="h-5 w-5 text-emerald-700" />
                </div>
                <div>
                  <h4 className="font-semibold text-gray-900">{lesson.title}</h4>
                  <p className="text-sm text-gray-600 mt-1 leading-relaxed">{lesson.description}</p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );
}
