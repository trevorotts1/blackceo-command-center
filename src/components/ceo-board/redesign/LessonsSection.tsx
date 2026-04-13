'use client';

import { Lightbulb } from 'lucide-react';

interface Lesson {
  title: string;
  text: string;
  color?: string;
}

interface LessonsSectionProps {
  lessons?: Lesson[];
}

// No synthetic defaults — lessons come from real data or show empty state

const COLOR_MAP: Record<string, { bg: string; border: string; text: string }> = {
  emerald: { bg: 'bg-emerald-50', border: 'border-emerald-100', text: 'text-emerald-700' },
  amber: { bg: 'bg-amber-50', border: 'border-amber-100', text: 'text-amber-700' },
  purple: { bg: 'bg-purple-50', border: 'border-purple-100', text: 'text-purple-700' },
  blue: { bg: 'bg-blue-50', border: 'border-blue-100', text: 'text-blue-700' },
};

export function LessonsSection({ lessons }: LessonsSectionProps) {
  const lessonList = lessons || [];

  return (
    <div
      className="rounded-2xl shadow-sm border border-gray-100 p-6"
      style={{
        backgroundColor: 'rgba(255,255,255,0.95)',
      }}
    >
      <h3 className="text-lg font-bold text-gray-900 mb-4">Lessons</h3>

      <div className="space-y-3">
        {lessonList.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No lessons yet. Lessons will appear as your AI workforce learns from tasks.</p>
        ) : (
          lessonList.map((lesson, idx) => {
            const colors = COLOR_MAP[lesson.color || 'emerald'] || COLOR_MAP.emerald;
            return (
              <div
                key={idx}
                className={`p-4 ${colors.bg} ${colors.border} border rounded-xl relative overflow-hidden`}
              >
                <div className="absolute -right-2 -top-2 opacity-10">
                  <Lightbulb className="h-12 w-12" />
                </div>
                <p className={`text-xs font-bold ${colors.text} mb-1`}>
                  {lesson.title}
                </p>
                <p className="text-sm font-medium text-gray-700 leading-relaxed">
                  {lesson.text}
                </p>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
