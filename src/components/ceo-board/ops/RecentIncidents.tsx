'use client';

import { motion } from 'framer-motion';

interface Incident {
  time: string;
  title: string;
  subtitle: string;
  dotColor: string;
  showConnector?: boolean;
}

const INCIDENTS: Incident[] = [
  {
    time: '10:24 AM',
    title: 'Node 4-A Latency Spike',
    subtitle: 'Resolved in 12m',
    dotColor: 'bg-rose-500',
    showConnector: true,
  },
  {
    time: '08:15 AM',
    title: 'Backup Sync Completed',
    subtitle: '100% Data Integrity',
    dotColor: 'bg-emerald-500',
    showConnector: true,
  },
  {
    time: '07:00 AM',
    title: 'New Protocol Deployed',
    subtitle: '',
    dotColor: 'bg-amber-500',
    showConnector: false,
  },
];

export default function RecentIncidents() {
  return (
    <div className="bg-gray-50 rounded-2xl p-6 relative overflow-hidden">
      {/* Decorative background icon */}
      <div className="absolute top-3 right-3 opacity-[0.07]">
        <svg className="w-20 h-20 text-rose-500 rotate-12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
        </svg>
      </div>

      <h3 className="text-lg font-bold text-gray-900 mb-5">Recent Activity</h3>
      <div className="space-y-0 relative">
        {INCIDENTS.map((incident, idx) => (
          <motion.div
            key={idx}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 + idx * 0.1, duration: 0.4 }}
            className="flex gap-4"
          >
            {/* Timeline column */}
            <div className="flex flex-col items-center flex-shrink-0">
              <div className={`w-2.5 h-2.5 rounded-full ${incident.dotColor} mt-1.5`} />
              {incident.showConnector && (
                <div className="w-0.5 flex-1 bg-gray-200 min-h-[48px]" />
              )}
            </div>
            {/* Content */}
            <div className="pb-5">
              <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">{incident.time}</p>
              <p className="text-sm font-medium text-gray-900 mt-0.5">{incident.title}</p>
              {incident.subtitle && (
                <p className={`text-xs font-semibold mt-1 ${
                  incident.dotColor.includes('rose') ? 'text-rose-500' : 'text-emerald-500'
                }`}>
                  {incident.subtitle}
                </p>
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
