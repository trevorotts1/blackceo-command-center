/**
 * Pure, framework-free client for `GET /api/company-health` (U55). NO React.
 *
 * This is the ONE place `CompanyHeroCard.tsx` and `NeedsAttentionSection.tsx`
 * fetch headline/attention data from — both components import
 * `loadCompanyHeroData` from here rather than calling `fetch` themselves, so
 * a unit test can prove the "single data source" contract (U55 acceptance
 * (f): the hero renders exclusively from a mocked `/api/company-health`;
 * the test fails if a second endpoint is fetched for headline numbers)
 * without needing a DOM/React render harness — this module has none of that,
 * matching the existing `src/components/anthology/gate-actions.ts` pattern
 * (pure model, framework-free, imported by both the component and its test).
 */

import type { Grade, GradeInputKey, CompanyInputBreakdownEntry } from '../grading';
import type { AttentionItem } from './attention';

export const COMPANY_HEALTH_ENDPOINT = '/api/company-health';

/**
 * Client-side shape of `GET /api/company-health` (mirrors `CompanyHealth` in
 * `src/lib/grading.ts` plus the route's `allTime` / `attentionItems` /
 * `attentionCount` additions — see `src/app/api/company-health/route.ts`).
 */
export interface ClientCompanyHealth {
  score: number | null;
  grade: Grade | null;
  departments: unknown[];
  worstTrending: unknown[];
  generatedAt: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  windowedTaskCounts: { created: number; completed: number };
  windowedCompletionRate: number | null;
  activeAgentCount: number;
  companyInputBreakdown: Record<GradeInputKey, CompanyInputBreakdownEntry>;
  allTime: {
    totalTasks: number;
    completedTasks: number;
    completionRate: number | null;
  };
  attentionItems: AttentionItem[];
  attentionCount: number;
}

/**
 * The single fetch the CEO hero + Needs Attention panel perform. Parameterized
 * with an injectable `fetchImpl` (defaulting to the global `fetch`) so a
 * contract test can pass a fake that throws on any URL other than
 * `COMPANY_HEALTH_ENDPOINT` — proving this function (and therefore every
 * caller that goes through it) never fetches a second source for headline
 * numbers.
 */
export async function loadCompanyHeroData(
  fetchImpl: typeof fetch = fetch,
): Promise<ClientCompanyHealth> {
  const res = await fetchImpl(COMPANY_HEALTH_ENDPOINT);
  if (!res.ok) {
    throw new Error(`GET ${COMPANY_HEALTH_ENDPOINT} failed: ${res.status}`);
  }
  return (await res.json()) as ClientCompanyHealth;
}
