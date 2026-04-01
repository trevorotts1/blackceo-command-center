'use client';

import { motion } from 'framer-motion';
import { Cloud, ShieldCheck, HardDrive, Server, Database, Wifi } from 'lucide-react';

interface EnvironmentItem {
  id: string;
  name: string;
  icon: 'cloud' | 'shield' | 'storage' | 'server' | 'database' | 'wifi';
  status: 'healthy' | 'active' | 'idle' | 'warning' | 'critical';
}

const ICON_MAP = {
  cloud: Cloud,
  shield: ShieldCheck,
  storage: HardDrive,
  server: Server,
  database: Database,
  wifi: Wifi,
};

const STATUS_CONFIG: Record<string, { label: string; color: string; dotColor: string; bg: string }> = {
  healthy: { label: 'HEALTHY', color: 'text-emerald-600', dotColor: 'bg-emerald-500', bg: 'bg-emerald-50' },
  active: { label: 'ACTIVE', color: 'text-emerald-600', dotColor: 'bg-emerald-500', bg: 'bg-emerald-50' },
  idle: { label: 'IDLE', color: 'text-gray-400', dotColor: 'bg-gray-300', bg: 'bg-gray-50' },
  warning: { label: 'WARNING', color: 'text-amber-600', dotColor: 'bg-amber-500', bg: 'bg-amber-50' },
  critical: { label: 'CRITICAL', color: 'text-rose-600', dotColor: 'bg-rose-500', bg: 'bg-rose-50' },
};

const DEFAULT_ENVIRONMENTS: EnvironmentItem[] = [
  { id: '1', name: 'AWS Production Cluster', icon: 'cloud', status: 'healthy' },
  { id: '2', name: 'Cloudflare Edge Firewall', icon: 'shield', status: 'active' },
  { id: '3', name: 'DR Cold Storage', icon: 'storage', status: 'idle' },
];

export default function EnvironmentStatusSection({
  environments = DEFAULT_ENVIRONMENTS,
}: {
  environments?: EnvironmentItem[];
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
        <div className="w-1 h-6 rounded-full bg-blue-500 flex-shrink-0" />
        <h2 className="text-section text-gray-900">Environment Status</h2>
      </div>
      <div className="p-6">
        <div className="flex flex-col gap-3">
          {environments.map((env, idx) => {
            const IconComponent = ICON_MAP[env.icon];
            const statusCfg = STATUS_CONFIG[env.status];
            const isIdle = env.status === 'idle';

            return (
              <motion.div
                key={env.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: isIdle ? 0.5 : 1, x: 0 }}
                transition={{ delay: idx * 0.08 }}
                className={`flex items-center justify-between p-4 rounded-xl border border-gray-100 hover:border-gray-200 transition-colors ${
                  isIdle ? 'opacity-50' : ''
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${
                    isIdle ? 'bg-gray-100' : 'bg-blue-50'
                  }`}>
                    <IconComponent className={`h-5 w-5 ${isIdle ? 'text-gray-400' : 'text-blue-600'}`} />
                  </div>
                  <span className="font-semibold text-gray-900">{env.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${statusCfg.dotColor} ${
                    env.status === 'healthy' || env.status === 'active' ? 'animate-pulse' : ''
                  }`} />
                  <span className={`text-sm font-bold ${statusCfg.color}`}>{statusCfg.label}</span>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
