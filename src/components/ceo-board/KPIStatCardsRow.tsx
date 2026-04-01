'use client';

import { Shield, Bug, Rocket } from 'lucide-react';

interface KPIStatCardProps {
  label: string;
  value: string;
  unit?: string;
  icon: React.ReactNode;
  borderColor: string;
  iconBgColor: string;
}

function KPIStatCard({ label, value, unit, icon, borderColor, iconBgColor }: KPIStatCardProps) {
  return (
    <div className={`bg-white rounded-2xl shadow-sm border border-gray-100 p-5 flex items-center justify-between border-l-4 ${borderColor}`}>
      <div>
        <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">{label}</p>
        <h4 className="text-2xl font-extrabold text-gray-900">
          {value}
          {unit && <span className="text-sm font-medium text-gray-400 ml-1">{unit}</span>}
        </h4>
      </div>
      <div className={`p-3 rounded-full ${iconBgColor}`}>
        {icon}
      </div>
    </div>
  );
}

interface KPIStatCardsRowProps {
  testCoverage?: number;
  avgBugFixTime?: number;
  featuresShipped?: number;
}

export function KPIStatCardsRow({
  testCoverage = 84.36,
  avgBugFixTime = 52.83,
  featuresShipped = 4.38,
}: KPIStatCardsRowProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <KPIStatCard
        label="Test Coverage"
        value={`${testCoverage}%`}
        icon={<Shield className="h-5 w-5 text-emerald-600" />}
        borderColor="border-emerald-500"
        iconBgColor="bg-emerald-50"
      />
      <KPIStatCard
        label="Avg Bug Fix Time"
        value={avgBugFixTime.toString()}
        unit="hrs"
        icon={<Bug className="h-5 w-5 text-amber-600" />}
        borderColor="border-amber-500"
        iconBgColor="bg-amber-50"
      />
      <KPIStatCard
        label="Features Shipped"
        value={featuresShipped.toString()}
        unit="avg/mo"
        icon={<Rocket className="h-5 w-5 text-gray-500" />}
        borderColor="border-gray-300"
        iconBgColor="bg-gray-50"
      />
    </div>
  );
}
