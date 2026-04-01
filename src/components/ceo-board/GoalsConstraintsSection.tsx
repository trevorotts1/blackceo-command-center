'use client';

import { Target, AlertTriangle } from 'lucide-react';

interface GoalItem {
  text: string;
  progress: number; // 0-100
}

interface ConstraintItem {
  text: string;
}

interface GoalsConstraintsSectionProps {
  goals: GoalItem[];
  constraints: ConstraintItem[];
}

export default function GoalsConstraintsSection({ goals, constraints }: GoalsConstraintsSectionProps) {
  if (goals.length === 0 && constraints.length === 0) return null;

  return (
    <div className="bg-gray-50 rounded-2xl p-6 space-y-6">
      {/* Goals */}
      {goals.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Target className="h-5 w-5 text-amber-500" />
            <h4 className="font-bold text-base text-gray-900">Department Goals</h4>
          </div>
          <div className="space-y-3">
            {goals.map((goal, i) => (
              <div key={i} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                <p className="text-sm font-medium text-gray-800">{goal.text}</p>
                <div className="mt-3 w-full bg-gray-100 rounded-full h-2">
                  <div
                    className="bg-amber-400 h-full rounded-full transition-all duration-500"
                    style={{ width: `${goal.progress}%` }}
                  />
                </div>
                <p className="text-xs text-gray-400 mt-1.5 text-right">{goal.progress}% complete</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Constraints */}
      {constraints.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle className="h-5 w-5 text-rose-500" />
            <h4 className="font-bold text-base text-gray-900">Core Constraints</h4>
          </div>
          <div className="space-y-3">
            {constraints.map((constraint, i) => (
              <div
                key={i}
                className="bg-white/80 p-4 rounded-xl border-l-4 border-rose-400"
              >
                <p className="text-sm text-gray-700 leading-relaxed">{constraint.text}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
