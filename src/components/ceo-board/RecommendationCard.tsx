'use client';

import { motion } from 'framer-motion';
import { 
  Megaphone, 
  Settings, 
  Users, 
  DollarSign,
  ArrowRight,
  TrendingUp,
  AlertCircle,
  CheckCircle2
} from 'lucide-react';

type Priority = 'High' | 'Medium' | 'Low';
type Department = 'Marketing' | 'Operations' | 'Sales' | 'Finance' | 'HR' | 'Product';

interface RecommendationCardProps {
  priority: Priority;
  department: Department;
  description: string;
  impact: string;
  onViewDetails?: () => void;
  index?: number;
}

const priorityConfig = {
  High: {
    badge: 'bg-rose-100 text-rose-700 border-rose-200',
    iconColor: 'text-rose-500',
    borderHover: 'hover:border-rose-300',
    shadowHover: 'hover:shadow-rose-100/50',
  },
  Medium: {
    badge: 'bg-amber-100 text-amber-700 border-amber-200',
    iconColor: 'text-amber-500',
    borderHover: 'hover:border-amber-300',
    shadowHover: 'hover:shadow-amber-100/50',
  },
  Low: {
    badge: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    iconColor: 'text-emerald-500',
    borderHover: 'hover:border-emerald-300',
    shadowHover: 'hover:shadow-emerald-100/50',
  },
};

const departmentIcons: Record<Department, React.ReactNode> = {
  Marketing: <Megaphone className="h-5 w-5" />,
  Operations: <Settings className="h-5 w-5" />,
  Sales: <DollarSign className="h-5 w-5" />,
  Finance: <DollarSign className="h-5 w-5" />,
  HR: <Users className="h-5 w-5" />,
  Product: <Settings className="h-5 w-5" />,
};

const departmentColors: Record<Department, string> = {
  Marketing: 'bg-pink-50 text-pink-600',
  Operations: 'bg-blue-50 text-blue-600',
  Sales: 'bg-emerald-50 text-emerald-600',
  Finance: 'bg-violet-50 text-violet-600',
  HR: 'bg-orange-50 text-orange-600',
  Product: 'bg-indigo-50 text-indigo-600',
};

export function RecommendationCard({
  priority,
  department,
  description,
  impact,
  onViewDetails,
  index = 0,
}: RecommendationCardProps) {
  const config = priorityConfig[priority];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ 
        duration: 0.5, 
        delay: index * 0.1,
        ease: [0.4, 0, 0.2, 1] as [number, number, number, number] 
      }}
      whileHover={{ y: -2, transition: { duration: 0.2 } }}
      className={`group rounded-2xl border border-gray-200 bg-white p-5 transition-all hover:shadow-lg ${config.borderHover} ${config.shadowHover}`}
    >
      {/* Header: Priority Badge + Department Icon */}
      <div className="flex items-start justify-between mb-4">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${config.badge}`}
        >
          {priority === 'High' ? (
            <AlertCircle className="h-3 w-3" />
          ) : priority === 'Medium' ? (
            <TrendingUp className="h-3 w-3" />
          ) : (
            <CheckCircle2 className="h-3 w-3" />
          )}
          {priority} Priority
        </span>
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-xl ${departmentColors[department]}`}
        >
          {departmentIcons[department]}
        </div>
      </div>

      {/* Description */}
      <p className="text-sm font-medium text-gray-900 leading-relaxed mb-4">
        {description}
      </p>

      {/* Impact Estimate */}
      <div className="mb-4 rounded-xl bg-gray-50 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-emerald-500" />
          <span className="text-sm font-semibold text-emerald-700">{impact}</span>
        </div>
      </div>

      {/* Action Button */}
      <button
        onClick={onViewDetails}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-gray-50 px-4 py-2.5 text-sm font-medium text-gray-700 transition-all hover:bg-indigo-50 hover:text-indigo-600 group-hover:bg-indigo-50/50"
      >
        View Details
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
      </button>
    </motion.div>
  );
}
