'use client';

import { motion } from 'framer-motion';
import { Users } from 'lucide-react';

interface PipelineRole {
  id: string;
  title: string;
  status: 'active' | 'final' | 'paused';
  statusLabel: string;
  candidates: number;
  inStage: number;
  stageLabel: string;
  progress: number;
  accentColor: string;
  barColor: string;
}

const DEFAULT_ROLES: PipelineRole[] = [
  {
    id: 'sr-product-designer',
    title: 'Senior Product Designer',
    status: 'active',
    statusLabel: 'Active',
    candidates: 12,
    inStage: 3,
    stageLabel: 'Interview',
    progress: 65,
    accentColor: 'border-l-amber-400',
    barColor: 'bg-amber-400',
  },
  {
    id: 'vp-engineering',
    title: 'VP of Engineering',
    status: 'final',
    statusLabel: 'Final Stages',
    candidates: 2,
    inStage: 2,
    stageLabel: 'Final',
    progress: 90,
    accentColor: 'border-l-emerald-500',
    barColor: 'bg-emerald-500',
  },
  {
    id: 'hr-specialist',
    title: 'HR Specialist',
    status: 'paused',
    statusLabel: 'Paused',
    candidates: 0,
    inStage: 0,
    stageLabel: '',
    progress: 0,
    accentColor: 'border-l-gray-300',
    barColor: 'bg-gray-300',
  },
];

export function HRTalentPipeline({ roles }: { roles?: PipelineRole[] }) {
  const pipeline = roles || DEFAULT_ROLES;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xl font-bold text-gray-900">Talent Pipeline</h3>
      </div>
      <div className="space-y-3">
        {pipeline.map((role, idx) => (
          <motion.div
            key={role.id}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: idx * 0.1 }}
            className={`bg-white p-4 rounded-xl shadow-sm border-l-4 ${role.accentColor} hover:shadow-md transition-all cursor-pointer ${role.status === 'paused' ? 'opacity-70' : ''}`}
          >
            <div className="flex justify-between items-start mb-2">
              <h5 className="font-bold text-sm text-gray-900">{role.title}</h5>
              <span className="text-xs font-semibold bg-gray-100 px-2 py-0.5 rounded text-gray-600">
                {role.statusLabel}
              </span>
            </div>
            <div className="flex items-center gap-2 mb-3">
              <Users className="h-3.5 w-3.5 text-gray-400" />
              <span className="text-xs text-gray-500">
                {role.candidates > 0
                  ? `${role.candidates} Candidate${role.candidates !== 1 ? 's' : ''}${role.inStage > 0 ? ` \u2022 ${role.inStage} in ${role.stageLabel}` : ''}`
                  : 'No Candidates'}
              </span>
            </div>
            <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
              {role.progress > 0 && (
                <div
                  className={`h-full ${role.barColor} rounded-full transition-all duration-700`}
                  style={{ width: `${role.progress}%` }}
                />
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
