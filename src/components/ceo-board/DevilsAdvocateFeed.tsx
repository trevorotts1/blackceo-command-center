'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Shield, AlertTriangle, Clock, CheckCircle2, XCircle } from 'lucide-react';
import { CANONICAL_SLUGS, canonicalDeptSlug } from '@/lib/routing/canonical-slug';

/**
 * U59 [JM/U55] / decision D15 (D-J1): this surface renders the Devil's
 * Advocate's challenge CONTENT — ratified as client-visible — while the AGENT
 * itself stays internal (migration 065 keeps it off client rosters and agent
 * pickers, and never promotes a trio agent to department head; none of that is
 * touched here).
 *
 * Shape follows the reconciled da_challenges table (migration 024). The prior
 * version of this interface named challenge_text / response_text /
 * response_deadline and a status enum of open|responded|escalated — none of
 * which existed in any migration. It matched a phantom shape, which is why the
 * feed's own endpoint 500'd on every canonically-migrated box.
 */
interface DAChallenge {
  id: string;
  department_id: string | null;
  trigger_type: string;
  challenge: string;
  specific_concern: string | null;
  severity: 'low' | 'medium' | 'high' | null;
  /** A department's reply to the challenge, once one exists. */
  outcome: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'escalated';
  created_at: string;
  resolved_at: string | null;
  /** Which persona the DA is operating under for this challenge */
  persona?: string;
}

/**
 * QC defect (DA-CHIPS-FIX): this map used to be keyed to sales-dept /
 * marketing-dept / operations-dept / creative-dept / support-dept --
 * fabricated demo-seed ids that never matched a real workspace id. Real
 * department ids look like `marketing`, `sales`, `billing-finance` (see
 * src/lib/routing/canonical-slug.ts's CANONICAL_SLUGS, imported above as the
 * one authoritative source -- never hand-copied here again). Every real
 * challenge silently degraded to a raw lowercase gray chip instead of a
 * colored, Title-Case one; it never crashed, which is exactly why it
 * survived an otherwise-excellent test suite with nothing rendering this
 * component. `canonicalDeptSlug()` is applied before lookup below so a raw
 * variant (`dept-marketing`, `billing`) still resolves, and
 * devils-advocate-feed-render.test.tsx asserts every id in CANONICAL_SLUGS
 * has an entry here so this map can never again silently drift stale.
 */
const departmentNames: Record<string, string> = {
  'master-orchestrator': 'CEO / COM',
  marketing: 'Marketing',
  sales: 'Sales',
  'billing-finance': 'Billing / Finance',
  'customer-support': 'Customer Support',
  'web-development': 'Web Development',
  funnels: 'Funnels',
  'app-development': 'App Development',
  graphics: 'Graphics',
  video: 'Video Production',
  audio: 'Audio Production',
  research: 'Research',
  communications: 'Communications',
  crm: 'CRM',
  'openclaw-maintenance': 'OpenClaw Maintenance',
  legal: 'Legal / Compliance',
  'social-media': 'Social Media',
  'paid-advertisement': 'Paid Advertisement',
  presentations: 'Presentations',
  'client-coaches': 'Client Coaches',
  'course-creator': 'Course Creator',
  podcast: 'Podcast',
  'community-management': 'Community Management',
  'personal-assistant': 'Personal Assistant',
  'general-task': 'General Task',
  engineering: 'Engineering',
};

/**
 * Badge color classes, assigned by POSITION in CANONICAL_SLUGS rather than a
 * per-id lookup table -- see departmentNames' doc comment above for why a
 * hardcoded map (even one with correct-today values) is exactly the shape of
 * bug this replaces: it can silently go stale the next time a department is
 * added or renamed, quietly falling back to the generic gray chip. Cycling a
 * fixed palette by canonical position means every id in the authoritative
 * set always gets a real color with no map entry to forget.
 */
const DEPARTMENT_COLOR_PALETTE = [
  'bg-purple-100 text-purple-700 border-purple-200',
  'bg-blue-100 text-blue-700 border-blue-200',
  'bg-yellow-100 text-yellow-700 border-yellow-200',
  'bg-teal-100 text-teal-700 border-teal-200',
  'bg-indigo-100 text-indigo-700 border-indigo-200',
  'bg-pink-100 text-pink-700 border-pink-200',
  'bg-cyan-100 text-cyan-700 border-cyan-200',
  'bg-lime-100 text-lime-700 border-lime-200',
  'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200',
  'bg-violet-100 text-violet-700 border-violet-200',
  'bg-orange-100 text-orange-700 border-orange-200',
  'bg-sky-100 text-sky-700 border-sky-200',
];
const CANONICAL_SLUG_LIST = Array.from(CANONICAL_SLUGS);
const departmentColors: Record<string, string> = Object.fromEntries(
  CANONICAL_SLUG_LIST.map((slug, i) => [
    slug,
    DEPARTMENT_COLOR_PALETTE[i % DEPARTMENT_COLOR_PALETTE.length],
  ]),
);

/** The PRD lifecycle, ratified as canonical by D15 (D-J1) sub-part (ii). */
const statusConfig = {
  pending: {
    label: 'Pending',
    className: 'bg-amber-100 text-amber-700 border-amber-200',
    icon: Clock,
  },
  approved: {
    label: 'Approved',
    className: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    icon: CheckCircle2,
  },
  rejected: {
    label: 'Rejected',
    className: 'bg-gray-100 text-gray-700 border-gray-200',
    icon: XCircle,
  },
  escalated: {
    label: 'Escalated',
    className: 'bg-red-100 text-red-700 border-red-200',
    icon: AlertTriangle,
  },
} as const;

const severityConfig: Record<string, { label: string; className: string }> = {
  low: { label: 'Low', className: 'bg-gray-100 text-gray-600 border-gray-200' },
  medium: { label: 'Medium', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  high: { label: 'High', className: 'bg-red-50 text-red-700 border-red-200' },
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

// NOTE: the previous version carried an isOverdue(response_deadline) helper.
// The reconciled table has no response_deadline column and no migration ever
// created one, so a deadline was never persisted and the "Response deadline
// passed" banner could only ever have fired on fabricated demo rows. Removed
// rather than faked — a Service-Level window for challenges belongs in the
// per-department SLA table, not invented in a feed component.

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
    <div className="rounded-2xl shadow-sm border-0 p-6"
      style={{
        backgroundColor: 'rgba(255,255,255,0.88)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-sm">
          <Shield className="h-5 w-5 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">⚔️ Devil&apos;s Advocate</h2>
          <p className="text-base text-gray-500">AI challenges that keep departments honest</p>
        </div>
      </div>

      {/* Challenges List */}
      <div className="space-y-4">
        {challenges.map((challenge, index) => {
          // Fall back to 'pending' rather than crashing on an unrecognised
          // status: a row written by an older box mid-roll must never blank
          // the whole board with an undefined-index throw.
          const status = statusConfig[challenge.status] ? challenge.status : 'pending';
          const StatusIcon = statusConfig[status].icon;
          const isEscalated = status === 'escalated';
          const hasResponse = Boolean(challenge.outcome);
          const severity = challenge.severity ? severityConfig[challenge.severity] : null;
          // QC defect fix: canonicalize BEFORE lookup so a raw alias
          // (dept-marketing, billing) or already-canonical id both resolve;
          // an unrecognized id canonicalizes to itself (canonicalDeptSlug's
          // graceful Step-5 fallback) so lookup below misses cleanly rather
          // than throwing.
          const canonicalDeptId = canonicalDeptSlug(challenge.department_id);

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
              {/* Top Row: Department, Severity & Status */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-medium border ${
                      departmentColors[canonicalDeptId] ||
                      'bg-gray-100 text-gray-700 border-gray-200'
                    }`}
                  >
                    {(challenge.department_id &&
                      (departmentNames[canonicalDeptId] || challenge.department_id)) ||
                      'Unassigned'}
                  </span>
                  {severity && (
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-medium border ${severity.className}`}
                    >
                      {severity.label}
                    </span>
                  )}
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${statusConfig[status].className}`}
                >
                  <StatusIcon className="h-3 w-3" />
                  {statusConfig[status].label}
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
                {challenge.challenge}
              </p>

              {/* Specific Concern */}
              {challenge.specific_concern && (
                <div className="p-3 rounded-lg bg-indigo-50/60 border border-indigo-100 mb-3">
                  <p className="text-xs text-indigo-500 font-medium mb-1">Specific concern:</p>
                  <p className="text-sm text-gray-700">{challenge.specific_concern}</p>
                </div>
              )}

              {/* Escalation Warning */}
              {isEscalated && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-100 border border-red-200 mb-3">
                  <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0" />
                  <p className="text-xs text-red-700 font-medium">
                    ⚠️ Escalated for review
                  </p>
                </div>
              )}

              {/* Response Box */}
              {hasResponse && (
                <div className="p-3 rounded-lg bg-gray-50 border border-gray-200 mb-3">
                  <p className="text-badge text-gray-500 font-medium mb-1">Department Response:</p>
                  <p className="text-base text-gray-700">{challenge.outcome}</p>
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