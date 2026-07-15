'use client';

import { useEffect, useState } from 'react';
import { RefreshCcw, Loader2, CheckCircle2, AlertCircle, AlertTriangle, Clock, KeyRound, X, Server, Puzzle, ShieldCheck, Sparkles, Check, Ban } from 'lucide-react';

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
 *
 * HONESTY NOTE (BUG 5, superseded in part by P2-04): the badge here reads
 * "Key present", not "Configured" or "Verified" — detectKey() only checks
 * whether a non-empty string exists under a candidate env-var name; it never
 * calls the provider on its own. That rule still stands for THIS component's
 * passive data fetch: it never triggers a live provider call on page load.
 *
 * P2-04 (c) step 3 adds a THIRD, narrow exception: an explicit "Prove"
 * action (or the weekly cron) may run ONE real authenticated call and cache
 * the result 24h (`/api/models/provider-status/prove` ->
 * provider-auth-proof.ts). The tile therefore has three honestly-distinct
 * states, never conflated:
 *   1. "Key present" (amber)              — a key exists, nothing proven yet.
 *   2. "Listed, auth UNPROVEN" (amber)     — the weekly refresh's fetchModels()
 *      succeeded (so the catalog listed), but that is NOT proof of auth (the
 *      "/v1/models unauthenticated mirage" — some providers 200 a model list
 *      for a garbage key). This state is NEVER rendered with a green check.
 *   3. "Call PROVEN" (emerald)             — a real authenticated call
 *      (a 5-token chat completion, or verifyKey() as a fallback) actually
 *      succeeded within the last 24h.
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

/** Cache-only auth-proof summary — see the HONESTY NOTE above. */
interface AuthProofSummary {
  proven: boolean;
  stale: boolean;
  method: string | null;
  provenAt: string | null;
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
  authProof: AuthProofSummary | null;
}

/** P2-04 — a pending Deep Scan suggestion (never carries the secret value). */
interface EnvAuditSuggestion {
  id: number;
  run_at: string;
  env_var: string;
  source_label: string;
  suggested_provider: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string | null;
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
  const [keyNoticeOk, setKeyNoticeOk] = useState(true);

  // Live key-detection status from /api/models/provider-status (multi-store).
  const [providerStatus, setProviderStatus] = useState<ProviderStatusResponse | null>(null);

  const fetchProviderStatus = async () => {
    try {
      const res = await fetch('/api/models/provider-status', { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as ProviderStatusResponse;
      setProviderStatus(json);
    } catch {
      /* ignore — status panel degrades gracefully */
    }
  };

  // P2-04 / U49 — "Prove" action: runs (or reuses a cached) real authenticated
  // call for one provider. Never fires automatically; only on this explicit
  // click. Every outcome is surfaced on the tile — pass, fail, and transport
  // error are three DISTINCT visible states, never silently swallowed
  // (fail-closed: anything short of an explicit ok:true reads as "not
  // proven", never as a quiet success).
  const [proving, setProving] = useState<string | null>(null);
  const [proveResult, setProveResult] = useState<{ slug: string; ok: boolean; message: string } | null>(null);
  const handleProve = async (slug: string) => {
    setProving(slug);
    setProveResult(null);
    try {
      const res = await fetch('/api/models/provider-status/prove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // HTTP-level failure (400/404/500) — surface it, never swallow it.
        setProveResult({
          slug,
          ok: false,
          message: json.message || json.error || `Prove failed (HTTP ${res.status})`,
        });
      } else if (json.ok === true) {
        setProveResult({
          slug,
          ok: true,
          message: `Proven via ${json.method === 'chat_completion' ? 'a real chat completion' : 'verifyKey()'}.`,
        });
      } else {
        // The route succeeded but the authenticated call itself failed or
        // was unavailable — still a visible, honest failure, not silence.
        setProveResult({
          slug,
          ok: false,
          message: json.detail || (json.method === 'unavailable' ? 'no authenticated-call method available for this provider' : 'Prove call did not succeed'),
        });
      }
      await fetchProviderStatus();
    } catch (err) {
      // Network-level failure (fetch itself threw) — fail-closed: this is
      // reported as a visible failure, never treated as an implicit success.
      setProveResult({
        slug,
        ok: false,
        message: err instanceof Error ? err.message : 'Prove request failed (network error)',
      });
    } finally {
      setProving(null);
    }
  };

  // P2-04 — the LLM env-auditor ("Deep Scan"): gathers candidate env-var names
  // (values redacted before any LLM sees them), classifies with the box's own
  // cheap model, and surfaces suggestions here. Auto-wiring only on Confirm.
  const [auditSuggestions, setAuditSuggestions] = useState<EnvAuditSuggestion[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [actingOnSuggestion, setActingOnSuggestion] = useState<number | null>(null);

  const fetchAuditSuggestions = async () => {
    try {
      const res = await fetch('/api/models/env-audit', { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as { suggestions: EnvAuditSuggestion[] };
      setAuditSuggestions(json.suggestions ?? []);
    } catch {
      /* ignore — Deep Scan panel simply starts empty */
    }
  };

  const handleDeepScan = async () => {
    setScanning(true);
    setScanNotice(null);
    try {
      const res = await fetch('/api/models/env-audit', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.message || json.error || `Deep Scan failed (${res.status})`);
      }
      setAuditSuggestions(json.suggestions ?? []);
      if (json.skipped_reason) {
        setScanNotice(`Scanned ${json.candidates_found ?? 0} candidate key(s) but could not classify: ${json.skipped_reason}`);
      } else if ((json.suggestions ?? []).length === 0) {
        setScanNotice(`Scanned ${json.candidates_found ?? 0} candidate key(s) — nothing new to suggest.`);
      } else {
        setScanNotice(`Scanned ${json.candidates_found ?? 0} candidate key(s) — ${json.suggestions.length} suggestion(s) found.`);
      }
    } catch (err) {
      setScanNotice(err instanceof Error ? err.message : 'Deep Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const handleConfirmSuggestion = async (id: number) => {
    setActingOnSuggestion(id);
    try {
      const res = await fetch('/api/models/env-audit/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message || json.error || 'Confirm failed');
      setAuditSuggestions((prev) => prev.filter((s) => s.id !== id));
      setKeyNotice(`Wired ${json.env_var ?? 'the key'} — catalog ${json.refreshed ? 'refreshed' : 'save confirmed'}.`);
      setKeyNoticeOk(true);
      await fetchProviderStatus();
    } catch (err) {
      setScanNotice(err instanceof Error ? err.message : 'Confirm failed');
    } finally {
      setActingOnSuggestion(null);
    }
  };

  const handleDismissSuggestion = async (id: number) => {
    setActingOnSuggestion(id);
    try {
      await fetch('/api/models/env-audit/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setAuditSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch {
      /* leave the row; operator can retry */
    } finally {
      setActingOnSuggestion(null);
    }
  };

  useEffect(() => {
    fetchAuditSuggestions();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        // C2 — re-fetch provider status after client resolves so the detection
        // side-effect (which hydrates process.env on first read) is reflected.
        if (!cancelled) {
          await fetchProviderStatus();
        }
      } catch {
        /* ignore — add-key affordance simply won't show */
      }
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Provider status is initially fetched by the client-load effect above
  // (C2 freshness fix). This separate effect is intentionally removed to avoid
  // a stale first-read where process.env has not yet been hydrated.
  // Subsequent refreshes happen in handleRefresh() and handleSaveKey().

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
      const json = await res.json().catch(() => ({})) as {
        env_var?: string;
        refreshed?: boolean;
        refresh_error?: string;
        smokeTest?: { ok: boolean; status?: number; message?: string } | null;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(json.message || json.error || `Save failed (${res.status})`);
      }
      // D — surface smoke-test outcome.
      const st = json.smokeTest;
      let notice: string;
      let noticeOk = true;
      if (st !== null && st !== undefined) {
        if (st.ok) {
          notice = `Key saved and verified (${json.env_var ?? ''}).`;
        } else {
          notice = `Key saved (${json.env_var ?? ''}) but verification failed: ${st.message ?? `HTTP ${st.status}`}.`;
          noticeOk = false;
        }
      } else if (json.refreshed === false && json.refresh_error) {
        notice = `Key saved (${json.env_var ?? ''}). Catalog refresh failed — try "Refresh now".`;
        noticeOk = false;
      } else {
        notice = `Key saved (${json.env_var ?? ''}) and catalog refreshed.`;
      }
      setKeyNotice(notice);
      setKeyNoticeOk(noticeOk);
      setKeyForm(null);
      // C2 — re-fetch provider status so the "Key present" badge reflects the new key.
      await fetchProviderStatus();
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
          onClick={handleDeepScan}
          disabled={scanning}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          title="Read this box's own env with its own low-cost model to find provider keys stored under unconventional names. Values are redacted before the model ever sees them; nothing is wired without your confirmation."
        >
          {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {scanning ? 'Scanning...' : 'Deep Scan'}
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
        <div className={`px-5 py-2 border-b text-xs ${keyNoticeOk ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-amber-50 border-amber-100 text-amber-700'}`}>
          {keyNotice}
        </div>
      )}
      {scanNotice && (
        <div className="px-5 py-2 border-b border-violet-100 bg-violet-50/60 text-xs text-violet-700">
          {scanNotice}
        </div>
      )}

      {/* ── P2-04: Deep Scan suggestions — nothing here is wired until Confirm. ── */}
      {auditSuggestions.length > 0 && (
        <div className="border-b border-gray-100 bg-violet-50/40">
          <div className="px-5 py-2.5 flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-violet-500" />
            <span className="text-xs font-bold text-violet-700 uppercase tracking-wider">
              Deep Scan suggestions
            </span>
          </div>
          <ul className="divide-y divide-violet-100/70">
            {auditSuggestions.map((s) => (
              <li key={s.id} className="px-5 py-3 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-800">
                    Found <code className="font-mono text-[12px] bg-gray-100 px-1 rounded">{s.env_var}</code>{' '}
                    in <span className="italic">{s.source_label}</span> — treat as{' '}
                    <span className="font-semibold">{s.suggested_provider}</span>?
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    Confidence: {s.confidence}
                    {s.reason && <> · {s.reason}</>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleConfirmSuggestion(s.id)}
                  disabled={actingOnSuggestion === s.id}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition-colors disabled:opacity-50"
                >
                  {actingOnSuggestion === s.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => handleDismissSuggestion(s.id)}
                  disabled={actingOnSuggestion === s.id}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 border border-gray-200 transition-colors disabled:opacity-50"
                >
                  <Ban className="w-3 h-3" />
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
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
                    {/* P2-04 — three honestly-distinct states, never conflated
                        (see the HONESTY NOTE at the top of this file):
                          1. no key -> "No key detected" (amber)
                          2. key found, not proven -> "Key present" (amber),
                             plus an explicit "models listed, auth UNPROVEN"
                             callout when the refresh log shows a listed
                             catalog — that listing is NEVER read as proof.
                          3. key found + a fresh cached authenticated call
                             succeeded -> "Call PROVEN" (emerald). */}
                    {status && !isLocalEndpoint && (
                      <div className="text-xs text-gray-400 mt-0.5">
                        {status.configured ? (
                          status.authProof?.proven ? (
                            <span
                              className="text-emerald-600"
                              title={`An authenticated ${status.authProof.method === 'chat_completion' ? '5-token completion' : 'key-verification'} call succeeded${status.authProof.provenAt ? ` at ${status.authProof.provenAt}` : ''}. Cached 24h.`}
                            >
                              <ShieldCheck className="w-3 h-3 inline -mt-0.5 mr-0.5" />
                              Key present · call PROVEN (key:{' '}
                              <code className="font-mono">{status.foundEnvVar}</code>)
                            </span>
                          ) : (
                            <span
                              className="text-amber-600"
                              title="A key was found under this name in an env store. This does NOT mean it has been verified against the provider — presence, not proof. Click Prove to run one real authenticated call."
                            >
                              Key present · auth UNPROVEN (key:{' '}
                              <code className="font-mono">{status.foundEnvVar}</code>
                              {status.foundInStore && status.foundInStore !== 'process.env' && (
                                <> · found in <span className="italic">{sourceLabel(status.foundInStore)}</span></>
                              )}
                              )
                              {entry?.success && (
                                <span className="block text-[10px] text-amber-500 mt-0.5">
                                  Models listed on the last refresh — that is NOT proof of auth.
                                </span>
                              )}
                            </span>
                          )
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

                  {/* E5: missing-key recovery action — only for api_key providers
                      when the key is not already detected (C2 suppresses when configured). */}
                  {failed && client && !isLocalEndpoint && !status?.configured && (
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

                  {/* P2-04 — "Prove" action: only offered when a key is present
                      and not already freshly proven. One real authenticated
                      call, cached 24h. */}
                  {!isLocalEndpoint && status?.configured && !status.authProof?.proven && (
                    <button
                      type="button"
                      onClick={() => handleProve(p)}
                      disabled={proving === p}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 transition-colors disabled:opacity-50"
                      title="Run one real authenticated call to prove this key actually works (cached 24h)"
                    >
                      {proving === p ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
                      Prove
                    </button>
                  )}

                  {/* Status badge. NEVER a green check off fetchModels() alone —
                      "OK" requires a cached PROVEN authProof, not just a listed
                      catalog (the mirage this exists to kill). */}
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
                  ) : entry && status?.authProof?.proven ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                      <CheckCircle2 className="w-3 h-3" />
                      OK · proven
                    </span>
                  ) : entry ? (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-50 text-amber-700 border border-amber-200"
                      title="Models were listed, but that is not proof of auth. Click Prove."
                    >
                      <AlertTriangle className="w-3 h-3" />
                      Listed · unproven
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-gray-50 text-gray-500 border border-gray-200">
                      Pending
                    </span>
                  )}
                </div>

                {/* U49 — visible Prove outcome. Renders once per click, right
                    under the row it belongs to; replaced by the next click or
                    cleared once the tile's own authProof state reflects it
                    (the badge above already turns emerald on success). */}
                {proveResult && proveResult.slug === p && (
                  <div
                    className={`mt-2 text-[11px] rounded-md px-2 py-1.5 border ${
                      proveResult.ok
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                        : 'bg-red-50 border-red-200 text-red-700'
                    }`}
                  >
                    {proveResult.ok ? (
                      <CheckCircle2 className="w-3 h-3 inline -mt-0.5 mr-1" />
                    ) : (
                      <AlertCircle className="w-3 h-3 inline -mt-0.5 mr-1" />
                    )}
                    {proveResult.message}
                  </div>
                )}

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
                        className="w-full sm:flex-1 sm:min-w-[200px] px-3 py-1.5 bg-white border border-amber-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-amber-400 focus:border-transparent focus:outline-none"
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
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"
                      title="A key was found under this name in an env store. This does NOT mean it has been verified against the provider — presence, not proof."
                    >
                      <CheckCircle2 className="w-3 h-3" />
                      Key present
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
