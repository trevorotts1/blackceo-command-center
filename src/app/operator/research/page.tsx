'use client';

/**
 * /operator/research — Research sub-module landing page.
 *
 * Track B7 (SCOPE-ADDITION Section 5).
 *
 * Layout: history sidebar on the left, search box at the top of the main
 * panel, and a result preview underneath. Submitting a query renders the
 * fresh result inline and refreshes the sidebar. Selecting a row from the
 * sidebar navigates to /operator/research/[id] for the deeper detail view.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ResearchSearch, {
  type ResearchSearchResult,
} from '@/components/operator/ResearchSearch';
import ResearchHistory from '@/components/operator/ResearchHistory';
import ResearchResult, {
  type ResearchResultData,
} from '@/components/operator/ResearchResult';

export default function ResearchLandingPage() {
  const router = useRouter();
  const [latest, setLatest] = useState<ResearchResultData | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

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
    // Push to detail view so the URL becomes shareable. Stay on this page if
    // the router push is unavailable (test environments without next router).
    try {
      router.push(`/operator/research/${payload.search_id}`);
    } catch {
      // no-op
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="text-[12px] uppercase tracking-[0.22em] text-bcc-text-muted font-semibold">
          Operator Console
        </div>
        <h1 className="mt-2 text-page-title text-bcc-text">Research</h1>
        <p className="mt-2 text-body text-bcc-text-secondary max-w-[680px]">
          Live X/Twitter and web search through xAI Grok. Results are grounded
          in real-time sources and saved to your vault so they show up in
          Memory and the All Searches bucket.
        </p>
      </header>

      <div className="flex flex-col md:flex-row gap-6">
        <ResearchHistory refreshKey={refreshKey} />
        <div className="flex-1 min-w-0 space-y-6">
          <ResearchSearch onResult={handleResult} />
          <ResearchResult result={latest} />
        </div>
      </div>
    </div>
  );
}

// The /search response does not echo the query back, so we use a fallback
// when the parent did not capture it. The component lets us keep the query
// the user typed on the page for nicer re-renders without an extra fetch.
function deriveQuery(payload: ResearchSearchResult): string {
  if (payload.search_metadata && typeof payload.search_metadata.query === 'string') {
    return payload.search_metadata.query as string;
  }
  // Markdown header form is `**Query:** ...` per the route handler.
  const match = payload.markdown_result.match(/\*\*Query:\*\*\s+(.+)/);
  if (match) return match[1].trim();
  return '(query)';
}
