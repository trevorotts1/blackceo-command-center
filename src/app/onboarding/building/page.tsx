'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { checkedJson } from '@/lib/checked-json';
import { CheckCircle2, Loader2, Building2 } from 'lucide-react';

interface BuildProgress {
  stage: 'idle' | 'manifest' | 'research' | 'departments' | 'roles' | 'qc' | 'assembly' | 'waiting' | 'failed' | 'validating' | 'complete';
  completion_verified?: boolean;
  build_id?: string;
  company_id?: string;
  message: string;
  documents_total: number;
  documents_complete: number;
  departments: Array<{ name: string; roles_total: number; roles_complete: number; status: string }>;
  eta_minutes: number;
  started_at?: string;
  completed_at?: string;
}

const STAGE_LABELS: Record<BuildProgress['stage'], string> = {
  idle:        'Preparing to build...',
  manifest:    'Writing manifest...',
  research:    'Researching your industry + competitors...',
  departments: 'Building your departments...',
  roles:       'Generating role-level how-to documents...',
  qc:          'Quality reviewing every document...',
  assembly:    'Assembling org chart + persona matrix...',
  waiting:     'Waiting for the next build step',
  failed:      'Your build needs attention',
  validating:  'Verifying your workforce...',
  complete:    'Your AI workforce is ready ✓',
};

/**
 * AI Workforce standard-first (PHASE 6 item 5): the departments-stage label is
 * DRIVEN by the live build-status payload — the count of departments the build
 * is actually working on (legacy full build or standard-first apply-diff), never
 * a hardcoded number (the old "16" was a stale v2.1-era copy that already lied).
 * When the payload has no department list yet, fall back to the generic label.
 */
function stageLabel(progress: BuildProgress): string {
  if (progress.stage === 'departments') {
    const n = progress.departments.length;
    if (n > 0) {
      return `Building ${n} department${n === 1 ? '' : 's'}...`;
    }
  }
  return STAGE_LABELS[progress.stage] || 'Building your workforce...';
}

export default function OnboardingBuildingPage() {
  const router = useRouter();
  const [progress, setProgress] = useState<BuildProgress | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    const interval = setInterval(poll, 4000);
    async function poll() {
      if (polling || controller.signal.aborted) return;
      polling = true;
      try {
        const data = await checkedJson<BuildProgress>('/api/onboarding/build-status', controller.signal);
        if (!data || typeof data.stage !== 'string' || !Array.isArray(data.departments) ||
            typeof data.documents_total !== 'number' || typeof data.documents_complete !== 'number') {
          throw new Error('The build status response was incomplete. Please retry.');
        }
        if (controller.signal.aborted) return;
        if (data.stage === 'complete' && data.completion_verified !== true) {
          data.stage = 'validating';
          data.message = 'Waiting for verified completion evidence.';
        }
        setProgress(data);
        setLoadError(null);
        if (data.stage === 'complete' && data.completion_verified === true) clearInterval(interval);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'Build status is unavailable. Please retry.');
      } finally { polling = false; }
    }
    void poll();
    return () => { controller.abort(); clearInterval(interval); };
  }, [retryGeneration]);

  if (!progress) {
    return (
      <div className="iv-root flex items-center justify-center">
        <div className="text-center">
          {!loadError && <Loader2 className="h-12 w-12 text-brand-500 animate-spin mx-auto mb-4" />}
          <p className="text-gray-600" role={loadError ? 'alert' : undefined}>{loadError || 'Connecting to build status...'}</p>
          {loadError && <button type="button" className="mt-4 underline" onClick={() => setRetryGeneration(n => n + 1)}>Retry build status</button>}
        </div>
      </div>
    );
  }

  const pct = progress.documents_total > 0
    ? Math.round((progress.documents_complete / progress.documents_total) * 100)
    : 0;

  const isComplete = progress.stage === 'complete' && progress.completion_verified === true;

  return (
    <div className="iv-root p-8">
      <div className="max-w-3xl mx-auto">
        {loadError && <div role="alert" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900">
          <p>{loadError} Displayed progress may be stale.</p>
          <button type="button" className="mt-2 underline" onClick={() => setRetryGeneration(n => n + 1)}>Retry build status</button>
        </div>}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-brand-50 mb-4">
            {isComplete
              ? <CheckCircle2 className="h-9 w-9 text-emerald-600" />
              : <Building2 className="h-9 w-9 text-brand-600 animate-pulse" />}
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            {isComplete ? 'Your AI workforce is ready' : 'Building your AI workforce...'}
          </h1>
          <p className="text-gray-600">{stageLabel(progress)}</p>
          {progress.message && <p className="mt-2 text-sm text-gray-600">{progress.message}</p>}
        </div>

        <div className="bg-white rounded-2xl shadow-sm border p-6 mb-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Overall progress</span>
            <span className="text-sm font-semibold text-brand-600">
              {progress.documents_complete} of {progress.documents_total} documents
            </span>
          </div>
          <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-brand-500 to-brand-600 rounded-full transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-3 text-sm text-gray-500">
            <span>{pct}% complete</span>
            {!isComplete && progress.eta_minutes > 0 && (
              <span>About {progress.eta_minutes} minute{progress.eta_minutes !== 1 ? 's' : ''} left</span>
            )}
          </div>
        </div>

        {progress.departments.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border p-6 mb-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4 uppercase tracking-wide">
              Departments
            </h2>
            <div className="space-y-3">
              {progress.departments.map(dept => {
                const deptPct = dept.roles_total > 0
                  ? Math.round((dept.roles_complete / dept.roles_total) * 100)
                  : 0;
                return (
                  <div key={dept.name} className="flex items-center gap-4">
                    <div className="w-40 text-sm text-gray-700 capitalize">{dept.name}</div>
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          dept.status === 'complete' ? 'bg-emerald-500' :
                          dept.status === 'in_progress' ? 'bg-brand-500' :
                          'bg-gray-300'
                        }`}
                        style={{ width: `${deptPct}%` }}
                      />
                    </div>
                    <div className="w-20 text-right text-xs text-gray-500">
                      {dept.roles_complete}/{dept.roles_total} roles
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {isComplete && (
          <div className="text-center">
            <button
              onClick={() => router.push('/ceo-board')}
              className="inline-flex items-center gap-2 px-6 py-3 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors"
            >
              Open Command Center
              <CheckCircle2 className="h-5 w-5" />
            </button>
          </div>
        )}

        {!isComplete && (
          <div className="text-center text-sm text-gray-500">
            <p>You can close this tab and return here to check your build status.</p>
          </div>
        )}
      </div>
    </div>
  );
}
