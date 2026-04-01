'use client';

import { Shield } from 'lucide-react';

interface ComplianceContextCardProps {
  frameworks?: string[];
}

const DEFAULT_FRAMEWORKS = ['SOC 2 Type II', 'GDPR', 'CCPA', 'HIPAA'];

export default function ComplianceContextCard({ frameworks }: ComplianceContextCardProps) {
  const tags = frameworks && frameworks.length > 0 ? frameworks : DEFAULT_FRAMEWORKS;

  return (
    <div className="bg-gray-900 text-white p-6 rounded-2xl shadow-lg relative overflow-hidden">
      <div className="relative z-10">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="h-5 w-5 text-emerald-400" />
          <h4 className="font-bold text-base">Compliance Context</h4>
        </div>
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="bg-white/10 px-3 py-1 rounded-full text-xs font-medium backdrop-blur-sm border border-white/5"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
      <div className="absolute -right-8 -bottom-8 opacity-10">
        <Shield className="h-32 w-32" />
      </div>
    </div>
  );
}
