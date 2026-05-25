'use client';

import { useState } from 'react';
import { RefreshCcw, Loader2, CheckCircle2, AlertCircle, Clock } from 'lucide-react';

/**
 * IntelligenceProviderList - provider freshness panel for the Intelligence
 * Settings page. Renders one row per provider with its last refresh outcome
 * (timestamp + success/failure + model add/update counts) and a manual
 * "Refresh now" button that calls the cron endpoint.
 *
 * Per PRD Section 5.4 the page must surface a "last refreshed" timestamp
 * and a manual refresh trigger. This component owns both.
 */

export interface ProviderRefreshEntry {
  provider: string;
  run_at: string;
  success: boolean;
  models_added: number;
  models_updated: number;
  models_deprecated: number;
  error_message: string | null;
}

interface IntelligenceProviderListProps {
  refreshLog: ProviderRefreshEntry[];
  providers: string[];
  onRefreshComplete?: () => void;
}

function formatRelative(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const diff = Date.now() - parsed;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(parsed).toLocaleDateString();
}

export function IntelligenceProviderList({
  refreshLog,
  providers,
  onRefreshComplete,
}: IntelligenceProviderListProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const logByProvider = new Map<string, ProviderRefreshEntry>();
  for (const entry of refreshLog) {
    if (!logByProvider.has(entry.provider)) {
      logByProvider.set(entry.provider, entry);
    }
  }

  // Show every provider we know about, even if there is no refresh log yet
  // (lets fresh installs see the provider catalog before the first cron run).
  const knownProviders = new Set<string>([
    ...providers,
    ...refreshLog.map((r) => r.provider),
  ]);
  const sortedProviders = Array.from(knownProviders).sort();

  // Aggregate "most recent refresh across any provider" for the header pill.
  const newest = refreshLog.reduce<ProviderRefreshEntry | null>((acc, e) => {
    if (!acc) return e;
    return Date.parse(e.run_at) > Date.parse(acc.run_at) ? e : acc;
  }, null);

  const handleRefresh = async () => {
    setRefreshing(true);
    setLastError(null);
    try {
      const res = await fetch('/api/cron/refresh-models', { method: 'POST' });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(body || `Refresh failed (${res.status})`);
      }
      if (onRefreshComplete) onRefreshComplete();
    } catch (err) {
      setLastError(err instanceof Error ? err.message : 'Failed to refresh');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Provider catalog</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {newest ? (
              <>
                Last refresh: <span className="text-gray-700">{formatRelative(newest.run_at)}</span>
              </>
            ) : (
              <>No refresh has run yet</>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {refreshing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCcw className="w-4 h-4" />
          )}
          {refreshing ? 'Refreshing...' : 'Refresh now'}
        </button>
      </div>

      {lastError && (
        <div className="px-5 py-2 bg-red-50 border-b border-red-100 text-xs text-red-700">
          {lastError}
        </div>
      )}

      {sortedProviders.length === 0 ? (
        <div className="px-5 py-6 text-sm text-gray-500 italic text-center">
          No providers configured yet. Add provider credentials under Settings to start
          syncing model catalogs.
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {sortedProviders.map((p) => {
            const entry = logByProvider.get(p);
            return (
              <li key={p} className="px-5 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-gray-900">{p}</div>
                  {entry ? (
                    <div className="text-xs text-gray-500 mt-0.5">
                      {formatRelative(entry.run_at)}
                      {' · '}
                      <span>+{entry.models_added}</span>{' / '}
                      <span>{entry.models_updated} updated</span>
                      {entry.models_deprecated > 0 && (
                        <>
                          {' / '}
                          <span className="text-amber-700">
                            {entry.models_deprecated} deprecated
                          </span>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Never refreshed
                    </div>
                  )}
                </div>
                {entry?.success === false ? (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-red-50 text-red-700 border border-red-200"
                    title={entry.error_message ?? 'Refresh failed'}
                  >
                    <AlertCircle className="w-3 h-3" />
                    Failed
                  </span>
                ) : entry ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                    <CheckCircle2 className="w-3 h-3" />
                    OK
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-gray-50 text-gray-500 border border-gray-200">
                    Pending
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
