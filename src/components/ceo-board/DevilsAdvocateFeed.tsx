'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Shield, AlertTriangle, Clock, MessageSquare } from 'lucide-react';

interface DAChallenge {
  id: string;
  department_id: string;
  challenge_text: string;
  response_text: string | null;
  status: 'open' | 'responded' | 'escalated';
  created_at: string;
  response_deadline: string | null;
  resolved_at: string | null;
  /** Which persona the DA is operating under for this challenge */
  persona?: string;
}

const departmentColors: Record<string, string> = {
  'sales-dept': 'bg-blue-100 text-blue-700 border-blue-200',
  'marketing-dept': 'bg-purple-100 text-purple-700 border-purple-200',
  'operations-dept': 'bg-orange-100 text-orange-700 border-orange-200',
  'creative-dept': 'bg-pink-100 text-pink-700 border-pink-200',
  'support-dept': 'bg-teal-100 text-teal-700 border-teal-200',
};

const departmentNames: Record<string, string> = {
  'sales-dept': 'Sales',
  'marketing-dept': 'Marketing',
  'operations-dept': 'Operations',
  'creative-dept': 'Creative',
  'support-dept': 'Support',
};

const statusConfig = {
  open: {
    label: 'Open',
    className: 'bg-amber-100 text-amber-700 border-amber-200',
    icon: Clock,
  },
  responded: {
    label: 'Responded',
    className: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    icon: MessageSquare,
  },
  escalated: {
    label: 'Escalated',
    className: 'bg-red-100 text-red-700 border-red-200',
    icon: AlertTriangle,
  },
};

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  
  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  return 'Just now';
}

function isOverdue(deadline: string | null): boolean {
  if (!deadline) return false;
  return new Date(deadline) < new Date();
}

export function DevilsAdvocateFeed() {
  const [challenges, setChallenges] = useState<DAChallenge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchChallenges() {
      try {
        const response = await fetch('/api/da-challenges');
        if (!response.ok) throw new Error('Failed to fetch challenges');
        const data = await response.json();
        setChallenges(data.challenges || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    fetchChallenges();
  }, []);

  if (loading) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600">
            <Shield className="h-5 w-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">⚔️ Devil&apos;s Advocate</h2>
            <p className="text-sm text-gray-500">AI challenges that keep departments honest</p>
          </div>
        </div>
        <div className="flex items-center justify-center py-12">
          <div className="animate-pulse flex space-x-4">
            <div className="h-3 w-3 bg-gray-300 rounded-full"></div>
            <div className="h-3 w-3 bg-gray-300 rounded-full"></div>
            <div className="h-3 w-3 bg-gray-300 rounded-full"></div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600">
            <Shield className="h-5 w-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">⚔️ Devil&apos;s Advocate</h2>
            <p className="text-sm text-gray-500">AI challenges that keep departments honest</p>
          </div>
        </div>
        <div className="text-center py-8 text-red-500">
          <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
          <p className="text-sm">Failed to load challenges</p>
        </div>
      </div>
    );
  }

  if (challenges.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600">
            <Shield className="h-5 w-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">⚔️ Devil&apos;s Advocate</h2>
            <p className="text-sm text-gray-500">AI challenges that keep departments honest</p>
          </div>
        </div>
        <div className="text-center py-12 text-gray-400">
          <Shield className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p className="text-sm">No active challenges</p>
          <p className="text-xs mt-1">The Devil&apos;s Advocate is watching...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-sm">
          <Shield className="h-5 w-5 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">⚔️ Devil&apos;s Advocate</h2>
          <p className="text-sm text-gray-500">AI challenges that keep departments honest</p>
        </div>
      </div>

      {/* Challenges List */}
      <div className="space-y-4">
        {challenges.map((challenge, index) => {
          const StatusIcon = statusConfig[challenge.status].icon;
          const isEscalated = challenge.status === 'escalated';
          const hasResponse = challenge.status === 'responded' && challenge.response_text;
          const overdue = isOverdue(challenge.response_deadline);

          return (
            <motion.div
              key={challenge.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className={`p-4 rounded-xl border ${
                isEscalated
                  ? 'border-red-300 bg-red-50/30'
                  : 'border-gray-200 bg-white'
              }`}
            >
              {/* Top Row: Department & Status */}
              <div className="flex items-center justify-between mb-3">
                <span
                  className={`px-3 py-1 rounded-full text-xs font-medium border ${
                    departmentColors[challenge.department_id] ||
                    'bg-gray-100 text-gray-700 border-gray-200'
                  }`}
                >
                  {departmentNames[challenge.department_id] || challenge.department_id}
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${statusConfig[challenge.status].className}`}
                >
                  <StatusIcon className="h-3 w-3" />
                  {statusConfig[challenge.status].label}
                </span>
              </div>

              {/* Persona Operating Under */}
              {challenge.persona && (
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="text-xs">🧠</span>
                  <span className="text-xs font-medium text-violet-600">
                    Acting as {challenge.persona}
                  </span>
                </div>
              )}

              {/* Challenge Text */}
              <p className="text-sm text-gray-700 leading-relaxed mb-3">
                {challenge.challenge_text}
              </p>

              {/* Escalation Warning */}
              {isEscalated && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-100 border border-red-200 mb-3">
                  <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0" />
                  <p className="text-xs text-red-700 font-medium">
                    ⚠️ No response in 72 hours
                  </p>
                </div>
              )}

              {/* Overdue Warning (for open status) */}
              {challenge.status === 'open' && overdue && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-100 border border-amber-200 mb-3">
                  <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                  <p className="text-xs text-amber-700 font-medium">
                    ⚠️ Response deadline passed
                  </p>
                </div>
              )}

              {/* Response Box */}
              {hasResponse && (
                <div className="p-3 rounded-lg bg-gray-50 border border-gray-200 mb-3">
                  <p className="text-xs text-gray-500 font-medium mb-1">Department Response:</p>
                  <p className="text-sm text-gray-700">{challenge.response_text}</p>
                </div>
              )}

              {/* Timestamp */}
              <div className="flex items-center gap-1.5 text-xs text-gray-400">
                <Clock className="h-3 w-3" />
                <span>{formatTimeAgo(challenge.created_at)}</span>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}