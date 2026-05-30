'use client';

/**
 * /operator/research — Research sub-module landing page.
 *
 * Track B7 (SCOPE-ADDITION Section 5). Provider-agnostic as of v4.1.5.
 *
 * Layout: history sidebar on the left, search box at the top of the main
 * panel, and a result preview underneath. Submitting a query renders the
 * fresh result inline and refreshes the sidebar. Selecting a row from the
 * sidebar navigates to /operator/research/[id] for the deeper detail view.
 *
 * On mount the page probes /api/operator/research/availability. When a search
 * provider key exists the module is LIVE and names the selected provider; when
 * none exists it shows an HONEST empty-state ("Add a Perplexity/OpenAI/Ollama/
 * xAI key to enable Research") instead of a dead search box.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import ResearchSearch, {
  type ResearchSearchResult,
} from '@/components/operator/ResearchSearch';
import ResearchHistory from '@/components/operator/ResearchHistory';
import ResearchResult, {
  type ResearchResultData,
} from '@/components/operator/ResearchResult';
import OperatorHelpButton from '@/components/operator/OperatorHelpButton';
import ModuleHealthDot from '@/components/operator/ModuleHealthDot';

interface Availability {
  available: boolean;
  selected: string | null;
  selectedDisplayName: string | null;
  enable_env_vars: string[];
}

export default function ResearchLandingPage() {
  const router = useRouter();
  const [latest, setLatest] = useState<ResearchResultData | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [probing, setProbing] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch('/api/operator/research/availability')
      .then((r) => r.json())
      .then((data: Availability) => {
        if (alive) setAvailability(data);
      })
      .catch(() => {
        if (alive)
          setAvailability({
            available: false,
            selected: null,
            selectedDisplayName: null,
            enable_env_vars: ['PERPLEXITY_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_CLOUD_API_KEY', 'X_AI_API_KEY'],
          });
      })
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  function handleResult(payload: ResearchSearchResult) {
    const data: ResearchResultData = {
      id: payload.search_id,
      query: deriveQuery(payload),
      model: payload.model,
      markdown_result: payload.markdown_result,
      created_at: payload.created_at,
      search_metadata: payload.search_metadata,
    };
    setLatest(data);
    setRefreshKey((k) => k + 1);
    try {
      router.push(`/operator/research/${payload.search_id}`);
    } catch {
      // no-op
    }
  }

  const available = availability?.available ?? false;
  const providerName = availability?.selectedDisplayName ?? null;

  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
              Operator Console
            </div>
            <h1 className="mt-2 text-page-title text-bcc-text flex items-center gap-3">
              Research
              <ModuleHealthDot module="research" showLabel />
            </h1>
          </div>
          <OperatorHelpButton card="research" />
        </div>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[680px]">
          Live, grounded web search. Results cite their sources and are saved to
          your vault so they show up in Memory and the All Searches bucket.
        </p>
        {!probing && available && providerName ? (
          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-bcc-border bg-bcc-white px-3 py-1 text-[12px] text-bcc-text-secondary">
            <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />
            Live via <span className="font-semibold text-bcc-text">{providerName}</span>
          </div>
        ) : null}
      </header>

      {!probing && !available ? (
        <EmptyState envVars={availability?.enable_env_vars ?? []} />
      ) : (
        <div className="flex flex-col md:flex-row gap-6">
          <ResearchHistory refreshKey={refreshKey} />
          <div className="flex-1 min-w-0 space-y-6">
            <ResearchSearch onResult={handleResult} />
            <ResearchResult result={latest} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Honest empty-state shown when no search provider key is configured. We name
 * the exact env vars that would enable the module — never a dead box.
 */
function EmptyState({ envVars }: { envVars: string[] }) {
  const vars = envVars.length > 0 ? envVars : ['PERPLEXITY_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_CLOUD_API_KEY', 'X_AI_API_KEY'];
  return (
    <div className="rounded-xl border border-dashed border-bcc-border bg-bcc-white p-8 text-center max-w-[680px]">
      <div className="mx-auto grid place-items-center w-12 h-12 rounded-full bg-bcc-border-light">
        <Search size={20} className="text-bcc-text-muted" />
      </div>
      <h2 className="mt-4 text-[18px] font-semibold text-bcc-text">Research is not enabled yet</h2>
      <p className="mt-2 text-body text-bcc-text-secondary">
        Add a Perplexity, OpenAI, Ollama, or xAI key to enable Research. The
        module auto-discovers the key and goes live — no further setup. Provider
        preference order:
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {vars.map((v) => (
          <code
            key={v}
            className="rounded-md border border-bcc-border bg-bcc-bg px-2 py-1 text-[12px] font-mono text-bcc-text-secondary"
          >
            {v}
          </code>
        ))}
      </div>
    </div>
  );
}

// The /search response does not echo the query back, so we use a fallback when
// the parent did not capture it.
function deriveQuery(payload: ResearchSearchResult): string {
  if (payload.search_metadata && typeof payload.search_metadata.query === 'string') {
    return payload.search_metadata.query as string;
  }
  const match = payload.markdown_result.match(/\*\*Query:\*\*\s+(.+)/);
  if (match) return match[1].trim();
  return '(query)';
}
