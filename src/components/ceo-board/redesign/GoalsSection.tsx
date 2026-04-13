'use client';

import { Flag, AlertTriangle } from 'lucide-react';

interface Goal {
  name: string;
  target: string;
  progress: number; // 0-100
  description: string;
}

interface Constraint {
  text: string;
}

interface GoalsSectionProps {
  goals?: Goal[];
  constraints?: Constraint[];
}

// No synthetic defaults — goals and constraints come from real data or show empty state

export function GoalsSection({ goals, constraints }: GoalsSectionProps) {
  const goalList = goals || [];
  const constraintList = constraints || [];

  return (
    <div
      className="rounded-2xl shadow-sm border border-gray-100 p-6"
      style={{
        backgroundColor: 'rgba(255,255,255,0.95)',
      }}
    >
      <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2 mb-5">
        <Flag className="h-5 w-5 text-amber-500" />
        Goals
      </h3>

      <div className="space-y-5">
        {goalList.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No goals set yet. Configure company goals to track strategic progress.</p>
        ) : (
          goalList.map((goal, idx) => (
            <div key={idx}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-bold text-gray-900">{goal.name}</p>
                <span className="text-xs font-medium text-gray-400">
                  Target: {goal.target}
                </span>
              </div>
              <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-400 rounded-full transition-all duration-500"
                  style={{ width: `${goal.progress}%` }} />
              </div>
              <p className="text-xs text-gray-500 mt-2">{goal.description}</p>
            </div>
          ))
        )}

        {constraintList.length > 0 && (
          <div className="p-4 rounded-xl bg-gray-50/80">
            <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-3">
              Constraints
            </p>
            <ul className="space-y-2">
              {constraintList.map((c, idx) => (
                <li
                  key={idx}
                  className="flex items-start gap-2 text-xs font-medium text-gray-600"
                >
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-500 flex-shrink-0 mt-0.5" />
                  {c.text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
