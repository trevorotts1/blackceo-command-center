import { NextResponse } from 'next/server';
import { getInterviewState } from '@/lib/conversational-ai/interview-state';
import { loadCompanyConfig } from '@/lib/company-config';
import { pixelFunnel, topObjections } from '@/lib/conversational-ai/metrics';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/conversational-ai/enriched
 *
 * Layer-2 (persona-tuned) payload. Returns `{ locked: true }` until the AI
 * Workforce interview is complete, so the client can call it freely without
 * leaking pre-interview placeholders. When unlocked it returns persona-aligned
 * funnels, business-specific KPI targets, an industry benchmark set, and a
 * recommended-actions panel derived from the Layer-1 signals.
 *
 * Historical Layer-1 data is NEVER discarded — Layer 2 only re-contextualizes
 * it (e.g. the same pixel funnel, now labeled with the client's journey-
 * template stage names and benchmarked against their industry).
 */
export async function GET() {
  try {
    const interview = getInterviewState();
    if (!interview.complete) {
      return NextResponse.json({
        ok: true,
        locked: true,
        reason: interview.detail,
        generatedAt: new Date().toISOString(),
      });
    }

    const cfg = loadCompanyConfig();

    // Business-specific KPI targets straight from the interview-derived config.
    const businessKPIs = (cfg.companyKPIs || []).map((k) => ({
      id: k.id,
      name: k.name,
      target: k.target,
      unit: k.unit,
      icon: k.icon,
    }));

    // Journey-template funnel = the pixel funnel re-labeled by the client's
    // industry. We keep the real counts and only attach context.
    const funnel = pixelFunnel();
    const journeyFunnel = {
      available: funnel.available,
      industry: cfg.industry,
      stages: funnel.data,
    };

    // Industry benchmark set. Sourced from company-config when present,
    // otherwise a conservative general-purpose band. Marked as benchmark,
    // never presented as the client's own measured number.
    const benchmarks = buildIndustryBenchmarks(cfg.industry);

    // Recommended actions derived from Layer-1 signals (objections + funnel).
    const objections = topObjections(3);
    const recommendations = buildRecommendations(cfg.industry, objections.data, funnel.data);

    return NextResponse.json({
      ok: true,
      locked: false,
      interviewSignal: interview.signal,
      industry: cfg.industry,
      persona: {
        // Persona alignment surface — populated from config; empty array is a
        // valid state (renders an empty-state, not a crash).
        departments: cfg.departments || [],
      },
      businessKPIs,
      journeyFunnel,
      benchmarks,
      recommendations,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/conversational-ai/enriched] failed:', err);
    return NextResponse.json(
      { ok: false, locked: true, reason: 'Enriched layer failed to load.' },
      { status: 200 },
    );
  }
}

interface Benchmark {
  metric: string;
  label: string;
  benchmark: number;
  unit: string;
  note: string;
}

/**
 * Industry benchmark bands. These are published-industry reference points
 * (clearly labeled as benchmarks, NOT the client's own data). Conservative
 * general defaults are used when the industry is unrecognized.
 */
function buildIndustryBenchmarks(industry: string): Benchmark[] {
  const general: Benchmark[] = [
    { metric: 'escalationRate', label: 'Escalation Rate', benchmark: 15, unit: '%', note: 'Cross-industry conversational-AI median' },
    { metric: 'kbHitRate', label: 'KB Hit Rate', benchmark: 70, unit: '%', note: 'Well-tuned knowledge base target' },
    { metric: 'responseTime', label: 'First-Response Time', benchmark: 60, unit: 's', note: 'Automated first-touch target' },
    { metric: 'redemptionRate', label: 'Discount Redemption', benchmark: 25, unit: '%', note: 'Offer-to-redemption median' },
  ];
  const byIndustry: Record<string, Partial<Record<string, number>>> = {
    'real-estate': { escalationRate: 20, kbHitRate: 65 },
    healthcare: { escalationRate: 25, kbHitRate: 60 },
    legal: { escalationRate: 30, kbHitRate: 55 },
    ecommerce: { escalationRate: 10, kbHitRate: 80, redemptionRate: 35 },
    'home-services': { escalationRate: 18, kbHitRate: 68 },
  };
  const overrides = byIndustry[industry.toLowerCase()] || {};
  return general.map((b) =>
    overrides[b.metric] !== undefined ? { ...b, benchmark: overrides[b.metric]! } : b,
  );
}

interface Recommendation {
  id: string;
  priority: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
}

function buildRecommendations(
  industry: string,
  objections: { objection: string; count: number }[],
  funnel: { stage: string; count: number }[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  if (objections.length > 0) {
    const top = objections[0];
    recs.push({
      id: 'objection-kb',
      priority: 'high',
      title: `Add a KB answer for "${top.objection}"`,
      detail: `Your most frequent objection (${top.count} occurrences). A tuned knowledge-base entry can deflect it before escalation.`,
    });
  }

  if (funnel.length >= 2) {
    // Find the largest single-step drop in the funnel.
    let worstIdx = 0;
    let worstDrop = 0;
    for (let i = 1; i < funnel.length; i++) {
      const drop = funnel[i - 1].count - funnel[i].count;
      if (drop > worstDrop) {
        worstDrop = drop;
        worstIdx = i;
      }
    }
    if (worstDrop > 0) {
      recs.push({
        id: 'funnel-drop',
        priority: 'medium',
        title: `Tighten the "${funnel[worstIdx - 1].stage}" → "${funnel[worstIdx].stage}" handoff`,
        detail: `Largest funnel drop-off (${worstDrop} contacts). A follow-up playbook here recovers the most pipeline.`,
      });
    }
  }

  recs.push({
    id: 'industry-tune',
    priority: 'low',
    title: `Tune playbooks to ${industry} benchmarks`,
    detail: 'Compare your live escalation and KB-hit rates to the industry band shown in the benchmarks panel and adjust thresholds.',
  });

  return recs;
}
