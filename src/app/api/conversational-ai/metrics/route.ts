import { NextResponse } from 'next/server';
import {
  channelVolume,
  conversationsTimeline,
  sentimentTrend,
  escalationRate,
  topObjections,
  kbHitRate,
  discountRedemptions,
  followUpPerformance,
  botSpamVolume,
  quietHoursImpact,
  pixelFunnel,
} from '@/lib/conversational-ai/metrics';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/conversational-ai/metrics
 *
 * Layer-1 universal metrics — works for EVERY client with no interview. Each
 * metric family is independently gated by source availability so a partial
 * Round-3 rollout still renders the families that ARE present and shows clean
 * empty-states for the rest. Never fabricates a number; an absent source
 * reports `available: false`.
 */
export async function GET() {
  try {
    const channels = channelVolume();
    const timeline = conversationsTimeline(30);
    const sentiment = sentimentTrend(30);
    const escalation = escalationRate();
    const objections = topObjections(8);
    const kb = kbHitRate();
    const discounts = discountRedemptions();
    const followUp = followUpPerformance();
    const botSpam = botSpamVolume();
    const quietHours = quietHoursImpact();
    const funnel = pixelFunnel();

    const anyData = [
      channels, timeline, sentiment, escalation, objections, kb,
      discounts, followUp, botSpam, quietHours, funnel,
    ].some((m) => m.available);

    return NextResponse.json({
      ok: true,
      anyData,
      metrics: {
        channelVolume: channels,
        conversationsTimeline: timeline,
        sentimentTrend: sentiment,
        escalationRate: escalation,
        topObjections: objections,
        kbHitRate: kb,
        discountRedemptions: discounts,
        followUpPerformance: followUp,
        botSpamVolume: botSpam,
        quietHoursImpact: quietHours,
        pixelFunnel: funnel,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/conversational-ai/metrics] failed:', err);
    return NextResponse.json(
      { ok: false, anyData: false, metrics: {}, error: 'Failed to compute conversational-AI metrics' },
      { status: 200 }, // graceful: page renders empty-state, never a crash
    );
  }
}
