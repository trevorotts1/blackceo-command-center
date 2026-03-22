'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, ChevronDown, Loader2 } from 'lucide-react';

interface RecommendationEngineCardProps {
  id: string;
  category: 'do-more' | 'stop' | 'watch' | 'try';
  title: string;
  description: string;
  supportingData?: string;
  confidence: number; // 0-1
  status: 'pending' | 'approved' | 'dismissed' | 'saved';
  departmentId: string;
  onStatusChange: (id: string, status: string) => void;
}

const categoryConfig = {
  'do-more': {
    label: 'Do More',
    badgeBg: 'bg-emerald-100',
    badgeText: 'text-emerald-700',
    progressColor: 'bg-emerald-500',
  },
  'stop': {
    label: 'Stop',
    badgeBg: 'bg-red-100',
    badgeText: 'text-red-700',
    progressColor: 'bg-red-500',
  },
  'watch': {
    label: 'Watch',
    badgeBg: 'bg-amber-100',
    badgeText: 'text-amber-700',
    progressColor: 'bg-amber-500',
  },
  'try': {
    label: 'Try',
    badgeBg: 'bg-indigo-100',
    badgeText: 'text-indigo-700',
    progressColor: 'bg-indigo-500',
  },
};

export function RecommendationEngineCard({
  id,
  category,
  title,
  description,
  supportingData,
  confidence,
  status: initialStatus,
  departmentId,
  onStatusChange,
}: RecommendationEngineCardProps) {
  const [status, setStatus] = useState(initialStatus);
  const [isWhyOpen, setIsWhyOpen] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  const config = categoryConfig[category];
  const confidencePercent = Math.round(confidence * 100);
  const isPending = status === 'pending';
  const isActioned = status === 'approved' || status === 'dismissed' || status === 'saved';

  const handleApprove = async () => {
    if (loadingAction || !isPending) return;
    setLoadingAction('approve');

    try {
      // Approve the recommendation
      const approveRes = await fetch(`/api/recommendations/${id}/approve`, {
        method: 'POST',
      });

      if (!approveRes.ok) throw new Error('Failed to approve recommendation');

      // Create a task from the recommendation
      const taskRes = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title,
          workspace_id: departmentId,
          status: 'inbox',
          priority: 'high',
          description: description,
        }),
      });

      if (!taskRes.ok) throw new Error('Failed to create task');

      setStatus('approved');
      onStatusChange(id, 'approved');
    } catch (error) {
      console.error('Error approving recommendation:', error);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleDismiss = async () => {
    if (loadingAction || !isPending) return;
    setLoadingAction('dismiss');

    try {
      const res = await fetch(`/api/recommendations/${id}/dismiss`, {
        method: 'POST',
      });

      if (!res.ok) throw new Error('Failed to dismiss recommendation');

      setStatus('dismissed');
      onStatusChange(id, 'dismissed');
    } catch (error) {
      console.error('Error dismissing recommendation:', error);
    } finally {
      setLoadingAction(null);
    }
  };

  const handleSave = async () => {
    if (loadingAction || !isPending) return;
    setLoadingAction('save');

    try {
      const res = await fetch(`/api/recommendations/${id}/save`, {
        method: 'POST',
      });

      if (!res.ok) throw new Error('Failed to save recommendation');

      setStatus('saved');
      onStatusChange(id, 'saved');
    } catch (error) {
      console.error('Error saving recommendation:', error);
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: isActioned ? 0.6 : 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`rounded-2xl border border-gray-200 bg-white p-5 shadow-sm ${
        isActioned ? 'pointer-events-none' : ''
      }`}
    >
      {/* Top row: category badge + confidence */}
      <div className="flex items-center justify-between mb-4">
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${config.badgeBg} ${config.badgeText}`}
        >
          {config.label}
        </span>
        <div className="flex items-center gap-2 flex-1 ml-4">
          <span className="text-xs text-gray-500">{confidencePercent}% confident</span>
          <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full ${config.progressColor} rounded-full transition-all duration-500`}
              style={{ width: `${confidencePercent}%` }}
            />
          </div>
        </div>
      </div>

      {/* Middle: title + description */}
      <h3 className="text-base font-semibold text-gray-900 mb-2">{title}</h3>
      <p className="text-sm text-gray-600 leading-relaxed mb-4">{description}</p>

      {/* Why? accordion */}
      <AnimatePresence>
        {isWhyOpen && supportingData && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="bg-gray-50 rounded-xl p-3 mb-4">
              <p className="text-xs text-gray-600 whitespace-pre-wrap">{supportingData}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom: action buttons */}
      <div className="flex items-center gap-2">
        {isActioned ? (
          <div className="flex items-center gap-2 text-emerald-600">
            <Check className="h-4 w-4" />
            <span className="text-sm font-medium">
              {status === 'approved' && 'Approved'}
              {status === 'dismissed' && 'Dismissed'}
              {status === 'saved' && 'Saved'}
            </span>
          </div>
        ) : (
          <>
            <button
              onClick={handleApprove}
              disabled={loadingAction !== null}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-[#6366F1] hover:bg-indigo-600 rounded-lg transition-colors disabled:opacity-50"
            >
              {loadingAction === 'approve' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                'Approve'
              )}
            </button>
            <button
              onClick={handleDismiss}
              disabled={loadingAction !== null}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
            >
              {loadingAction === 'dismiss' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                'Dismiss'
              )}
            </button>
            <button
              onClick={handleSave}
              disabled={loadingAction !== null}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-amber-700 bg-white border border-amber-300 hover:bg-amber-50 rounded-lg transition-colors disabled:opacity-50"
            >
              {loadingAction === 'save' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                'Save'
              )}
            </button>
            <button
              onClick={() => setIsWhyOpen(!isWhyOpen)}
              className="inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Why?
              <ChevronDown
                className={`h-3 w-3 transition-transform ${isWhyOpen ? 'rotate-180' : ''}`}
              />
            </button>
          </>
        )}
      </div>
    </motion.div>
  );
}
