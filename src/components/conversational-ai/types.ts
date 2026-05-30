/** Shared client-side types for the Feature 52 dashboard. */

export interface MetricFamily<T> {
  available: boolean;
  source: string | null;
  data: T;
}

export interface ConvAiMetrics {
  channelVolume: MetricFamily<{ channel: string; label: string; count: number }[]>;
  conversationsTimeline: MetricFamily<{ day: string; count: number }[]>;
  sentimentTrend: MetricFamily<{ day: string; avg: number; n: number }[]>;
  escalationRate: MetricFamily<{ escalated: number; total: number; rate: number }>;
  topObjections: MetricFamily<{ objection: string; count: number }[]>;
  kbHitRate: MetricFamily<{ hits: number; total: number; rate: number }>;
  discountRedemptions: MetricFamily<{ redeemed: number; offered: number; rate: number }>;
  followUpPerformance: MetricFamily<{ writes: number; contacts: number; coverage: number }>;
  botSpamVolume: MetricFamily<{ flaggedLines: number }>;
  quietHoursImpact: MetricFamily<{ interrupts: number; deferred: number; rate: number }>;
  pixelFunnel: MetricFamily<{ stage: string; count: number }[]>;
}

export interface MetricsResponse {
  ok: boolean;
  anyData: boolean;
  metrics: Partial<ConvAiMetrics>;
  generatedAt: string;
}

export interface InterviewState {
  complete: boolean;
  signal: string;
  detail: string;
  checkedAt: string;
}

export interface StatusResponse {
  ok: boolean;
  layer: 1 | 2;
  interview: InterviewState;
  sources: { name: string; metric: string; kind: string; present: boolean }[];
  anySource: boolean;
  generatedAt: string;
}

export interface EnrichedResponse {
  ok: boolean;
  locked: boolean;
  reason?: string;
  industry?: string;
  persona?: { departments: { slug: string; name: string; icon?: string }[] };
  businessKPIs?: { id: string; name: string; target: number; unit: string; icon?: string }[];
  journeyFunnel?: { available: boolean; industry: string; stages: { stage: string; count: number }[] };
  benchmarks?: { metric: string; label: string; benchmark: number; unit: string; note: string }[];
  recommendations?: { id: string; priority: 'high' | 'medium' | 'low'; title: string; detail: string }[];
  generatedAt?: string;
}
