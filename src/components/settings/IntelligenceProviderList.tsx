'use client';

import { useEffect, useState } from 'react';
import { RefreshCcw, Loader2, CheckCircle2, AlertCircle, Clock, KeyRound, X, Server, Puzzle } from 'lucide-react';

/**
 * IntelligenceProviderList - provider freshness + key status panel for the
 * Intelligence Settings page.
 *
 * Renders two sections:
 *   1. AI Model Providers — one row per provider with:
 *        - last refresh outcome (timestamp + success/failure + model counts)
 *        - live key-detection status sourced from /api/models/provider-status
 *          (scans ALL env stores, not just process.env)
 *        - local-endpoint badge for providers like ollama-local (no key needed)
 *        - inline "Add API key" action on failure (E5)
 *   2. Integrations — non-model services (Notion, etc.) with their key status.
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

interface ProviderStatusEntry {
  slug: string;
  displayName: string;
  authType: string;
  configured: boolean;
  foundEnvVar: string | null;
  foundInStore: 'process.env' | 'env_file' | 'openclaw_json' | null;
  localEndpointUrl?: string;
  envCandidates: string[];
}

interface IntegrationStatusEntry {
  slug: string;
  displayName: string;
  section: string;
  description: string;
  configured: boolean;
  foundEnvVar: string | null;
  foundInStore: 'process.env' | 'env_file' | 'openclaw_json' | null;
  envCandidates: string[];
}

interface ProviderStatusResponse {
  providers: ProviderStatusEntry[];
  integrations: IntegrationStatusEntry[];
  generated_at: string;
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

/** A failure caused by a missing/expired key looks like one of these. */
function looksLikeMissingKey(message: string | null): boolean {
  if (!message) return false;
  return /api key|unauthorized|401|403|not set|missing|invalid.*key|forbidden/i.test(message);
}

/** Human-readable label for a key source. */
function sourceLabel(source: ProviderStatusEntry['foundInStore']): string {
  if (!source) return '';
  if (source === 'process.env') return 'container env';
  if (source === 'env_file') return '.env file';
  if (source === 'openclaw_json') return 'openclaw.json';
  return source;
}

interface SelectedClient {
  id: string;
  name: string;
  is_self: boolean;
}

export function IntelligenceProviderList({
  refreshLog,
  providers,
  onRefreshComplete,
}: IntelligenceProviderListProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // Selected client — needed for the E5 "Add API key" target. Best-effort:
  // if the lookup fails we still render the freshness panel, just without the
  // add-key affordance.
  const [client, setClient] = useState<SelectedClient | null>(null);
  const [keyForm, setKeyForm] = useState<{ provider: string; value: string } | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);

  // Live key-detection status from /api/models/provider-status (multi-store).
  const [providerStatus, setProviderStatus] = useState<ProviderStatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/clients', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { clients: SelectedClient[]; selected_id?: string };
        if (cancelled) return;
        // Target the SAME client the refresh runs against (the selected one),
        // falling back to self, then the first client.
        const selected =
          json.clients.find((c) => c.id === json.selected_id) ??
          json.clients.find((c) => c.is_self) ??
          json.clients[0] ??
          null;
        setClient(selected);
      } catch {
        /* ignore — add-key affordance simply won't show */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/models/provider-status', { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as ProviderStatusResponse;
        if (cancelled) return;
        setProviderStatus(json);
      } catch {
        /* ignore — status panel degrades gracefully */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const logByProvider = new Map<string, ProviderRefreshEntry>();
  for (const entry of refreshLog) {
    if (!logByProvider.has(entry.provider)) {
      logByProvider.set(entry.provider, entry);
    }
  }

  // Build a lookup from the live provider-status API response.
  const statusBySlug = new Map<string, ProviderStatusEntry>();
  if (providerStatus) {
    for (const s of providerStatus.providers) {
      statusBySlug.set(s.slug, s);
    }
  }

  // Show every provider we know about, even if there is no refresh log yet
  // (lets fresh installs see the provider catalog before the first cron run).
  const knownProviders = new Set<string>([
    ...providers,
    ...refreshLog.map((r) => r.provider),
    // Also include providers from the status response (catches local-endpoint
    // providers like ollama-local that never appear in the refresh log).
    ...(providerStatus?.providers.map((p) => p.slug) ?? []),
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
      // Re-fetch provider status after refresh.
      const statusRes = await fetch('/api/models/provider-status', { cache: 'no-store' });
      if (statusRes.ok) {
        const json = (await statusRes.json()) as ProviderStatusResponse;
        setProviderStatus(json);
      }
      if (onRefreshComplete) onRefreshComplete();
    } catch (err) {
      setLastError(err instanceof Error ? err.message : 'Failed to refresh');
    } finally {
      setRefreshing(false);
    }
  };

  const handleSaveKey = async () => {
    if (!keyForm || !client) return;
    setSavingKey(true);
    setKeyError(null);
    setKeyNotice(null);
    try {
      const res = await fetch(`/api/clients/${client.id}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: keyForm.provider, value: keyForm.value, refresh: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.message || json.error || `Save failed (${res.status})`);
      }
      if (json.refreshed === false && json.refresh_error) {
        setKeyNotice(`Key saved (${json.env_var}). Catalog refresh failed — try "Refresh now".`);
      } else {
        setKeyNotice(`Key saved (${json.env_var}) and catalog refreshed.`);
      }
      setKeyForm(null);
      if (onRefreshComplete) onRefreshComplete();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setSavingKey(false);
    }
  };

  const integrations = providerStatus?.integrations ?? [];

  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Provider catalog</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Model list pulled from each provider for{' '}
            <span className="font-medium text-gray-700">{client ? client.name : 'this client'}</span>.{' '}
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
      {keyNotice && (
        <div className="px-5 py-2 bg-emerald-50 border-b border-emerald-100 text-xs text-emerald-700">
          {keyNotice}
        </div>
      )}

      {/* ── AI model providers ── */}
      {sortedProviders.length === 0 ? (
        <div className="px-5 py-6 text-sm text-gray-500 italic text-center">
          No providers configured yet. Add a provider API key below to start syncing model
          catalogs.
        </div>
      ) : (
        <ul className="divide-y divide-gray-100">
          {sortedProviders.map((p) => {
            const entry = logByProvider.get(p);
            const status = statusBySlug.get(p);
            const isLocalEndpoint = status?.authType === 'local_endpoint';
            const failed = entry?.success === false;
            const missingKey = failed && looksLikeMissingKey(entry?.error_message ?? null);
            const formOpen = keyForm?.provider === p;

            return (
              <li key={p} className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900">
                        {status?.displayName ?? p}
                      </span>
                      {isLocalEndpoint && (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200"
                          title={`Local daemon endpoint${status?.localEndpointUrl ? ` — ${status.localEndpointUrl}` : ''}`}
                        >
                          <Server className="w-2.5 h-2.5" />
                          local
                        </span>
                      )}
                    </div>
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
                    {failed && entry?.error_message && (
                      <div className="text-xs text-red-600 mt-0.5 truncate" title={entry.error_message}>
                        {entry.error_message}
                      </div>
                    )}
                    {/* Live key detection status (multi-store) */}
                    {status && !isLocalEndpoint && (
                      <div className="text-xs text-gray-400 mt-0.5">
                        {status.configured ? (
                          <span className="text-emerald-600">
                            Key: <code className="font-mono">{status.foundEnvVar}</code>
                            {status.foundInStore && status.foundInStore !== 'process.env' && (
                              <> · found in <span className="italic">{sourceLabel(status.foundInStore)}</span></>
                            )}
                          </span>
                        ) : (
                          <span className="text-amber-600">
                            No key detected
                            {status.envCandidates.length > 0 && (
                              <> · checked: <code className="font-mono">{status.envCandidates.join(', ')}</code></>
                            )}
                          </span>
                        )}
                      </div>
                    )}
                    {status && isLocalEndpoint && status.localEndpointUrl && (
                      <div className="text-xs text-gray-400 mt-0.5">
                        Endpoint: <code className="font-mono">{status.localEndpointUrl}</code>
                      </div>
                    )}
                  </div>

                  {/* E5: missing-key recovery action — only for api_key providers. */}
                  {failed && client && !isLocalEndpoint && (
                    <button
                      type="button"
                      onClick={() => {
                        setKeyError(null);
                        setKeyForm(formOpen ? null : { provider: p, value: '' });
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 transition-colors"
                      title={missingKey ? 'This provider needs an API key' : 'Add or replace this provider key'}
                    >
                      <KeyRound className="w-3 h-3" />
                      Add API key
                    </button>
                  )}

                  {/* Status badge */}
                  {isLocalEndpoint ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200">
                      <Server className="w-3 h-3" />
                      Local
                    </span>
                  ) : failed ? (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-red-50 text-red-700 border border-red-200"
                      title={entry?.error_message ?? 'Refresh failed'}
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
                </div>

                {/* Inline add-key form. */}
                {formOpen && !isLocalEndpoint && (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-amber-900">
                        Add API key for <span className="font-mono">{p}</span>
                      </p>
                      <button
                        type="button"
                        onClick={() => setKeyForm(null)}
                        className="text-amber-700 hover:text-amber-900"
                        aria-label="Close"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="text-[11px] text-amber-800 mb-2 leading-relaxed">
                      Saved to {client?.is_self ? 'this box' : `${client?.name}`}&rsquo;s OpenClaw
                      config, then the catalog re-syncs. The key is write-only — it is never shown
                      again here.
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder={`${p.toUpperCase().replace(/-/g, '_')}_API_KEY value`}
                        value={keyForm.value}
                        onChange={(e) => setKeyForm({ provider: p, value: e.target.value })}
                        className="flex-1 min-w-[200px] px-3 py-1.5 bg-white border border-amber-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-amber-400 focus:border-transparent focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleSaveKey}
                        disabled={savingKey || !keyForm.value.trim()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {savingKey ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                        {savingKey ? 'Saving...' : 'Save & re-sync'}
                      </button>
                    </div>
                    {keyError && <p className="text-[11px] text-red-600 mt-2">{keyError}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Integrations section (Notion, etc.) ── */}
      {integrations.length > 0 && (
        <>
          <div className="px-5 py-2.5 border-t border-gray-100 bg-gray-50/70">
            <div className="flex items-center gap-2">
              <Puzzle className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                Integrations
              </span>
            </div>
          </div>
          <ul className="divide-y divide-gray-100">
            {integrations.map((integ) => (
              <li key={integ.slug} className="px-5 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-900">{integ.displayName}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{integ.description}</div>
                    {integ.configured ? (
                      <div className="text-xs text-emerald-600 mt-0.5">
                        Key: <code className="font-mono">{integ.foundEnvVar}</code>
                        {integ.foundInStore && integ.foundInStore !== 'process.env' && (
                          <> · found in <span className="italic">{sourceLabel(integ.foundInStore)}</span></>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-amber-600 mt-0.5">
                        No key detected · checked: <code className="font-mono">{integ.envCandidates.join(', ')}</code>
                      </div>
                    )}
                  </div>
                  {integ.configured ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                      <CheckCircle2 className="w-3 h-3" />
                      Configured
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-gray-50 text-gray-500 border border-gray-200">
                      Not set
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
