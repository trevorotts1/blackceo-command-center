'use client';

import { Globe, Zap } from 'lucide-react';

interface TeamContextData {
  location: string;
  locationDetail: string;
  communication: string;
  communicationDetail: string;
}

interface TeamContextSectionProps {
  data?: TeamContextData;
}

const DEFAULT_DATA: TeamContextData = {
  location: '100% Fully Remote',
  locationDetail: '85% US-based operation',
  communication: 'Async-First',
  communicationDetail: 'High communication autonomy',
};

export function TeamContextSection({ data }: TeamContextSectionProps) {
  const ctx = data || DEFAULT_DATA;

  return (
    <div
      className="rounded-2xl shadow-sm border border-gray-100 p-6"
      style={{
        backgroundColor: 'rgba(255,255,255,0.95)',
      }}
    >
      <h3 className="text-lg font-bold text-gray-900 mb-5">Team Context</h3>

      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
            <Globe className="h-5 w-5 text-gray-500" />
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900">{ctx.location}</p>
            <p className="text-xs text-gray-500">{ctx.locationDetail}</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
            <Zap className="h-5 w-5 text-gray-500" />
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900">{ctx.communication}</p>
            <p className="text-xs text-gray-500">{ctx.communicationDetail}</p>
          </div>
        </div>
      </div>

      {/* Map placeholder */}
      <div className="mt-5 h-36 rounded-2xl overflow-hidden relative bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center">
        <div className="text-center">
          <Globe className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
            Global Presence
          </p>
        </div>
      </div>
    </div>
  );
}
