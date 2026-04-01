'use client';

import { Brain } from 'lucide-react';

interface MemoryPreviewItem {
  text: string;
  label?: string;
}

interface DepartmentMemoryPreviewCardProps {
  items: MemoryPreviewItem[];
  countLabel?: string;
}

export default function DepartmentMemoryPreviewCard({
  items,
  countLabel,
}: DepartmentMemoryPreviewCardProps) {
  if (items.length === 0) return null;

  return (
    <div className="rounded-2xl shadow-sm border border-gray-100 p-6 bg-white/95">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
          <Brain className="h-5 w-5 text-purple-500" />
          Memory
        </h3>
        {countLabel ? (
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full">
            {countLabel}
          </span>
        ) : null}
      </div>

      <div className="space-y-3">
        {items.map((item, idx) => (
          <div
            key={`${item.text}-${idx}`}
            className={`rounded-xl px-4 py-3 ${idx === 0 ? 'bg-purple-50 border border-purple-100' : 'bg-gray-50 border border-gray-100'}`}
          >
            <p className="text-sm leading-relaxed text-gray-700 italic">“{item.text}”</p>
            {item.label ? (
              <p className={`mt-2 text-[10px] font-bold uppercase tracking-[0.18em] ${idx === 0 ? 'text-purple-700' : 'text-gray-500'}`}>
                {item.label}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
