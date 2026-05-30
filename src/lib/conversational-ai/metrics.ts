/**
 * Feature 52 — Conversational-AI metric aggregation.
 *
 * Pure functions that turn the raw Round-3 source records into the Layer-1
 * metric families the dashboard renders. Every aggregator is defensive: an
 * absent / empty source yields an empty-but-valid shape with `available:
 * false`, never a thrown error and never a fabricated number.
 *
 * The HTTP route (src/app/api/conversational-ai/metrics/route.ts) calls these
 * and assembles the response. Keeping the logic here makes it unit-testable
 * and keeps the route thin.
 */

import {
  readJsonl,
  readJsonlDir,
  readMarkdownLog,
  type JsonlReadResult,
} from './sources';

export interface MetricFamily<T> {
  available: boolean;
  source: string | null;
  data: T;
}

/** Channel volume — counts per messaging channel. */
export type ChannelKey =
  | 'sms'
  | 'email'
  | 'fb_dm'
  | 'fb_comments'
  | 'ig_dm'
  | 'linkedin'
  | 'live_chat'
  | 'all_in_one';

export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  sms: 'SMS',
  email: 'Email',
  fb_dm: 'FB DM',
  fb_comments: 'FB Comments',
  ig_dm: 'IG DM',
  linkedin: 'LinkedIn',
  live_chat: 'Live Chat',
  all_in_one: 'All-in-One',
};

const CHANNEL_KEYS = Object.keys(CHANNEL_LABELS) as ChannelKey[];

/** Normalize a raw channel string from a log line into a known ChannelKey. */
function normalizeChannel(raw: unknown): ChannelKey | null {
  const s = String(raw ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return null;
  if (s === 'sms' || s === 'text') return 'sms';
  if (s === 'email' || s === 'mail') return 'email';
  if (s.includes('facebook') && s.includes('comment')) return 'fb_comments';
  if (s.includes('fb') && s.includes('comment')) return 'fb_comments';
  if (s.includes('facebook') || s === 'fb_dm' || s === 'fb') return 'fb_dm';
  if (s.includes('instagram') || s === 'ig' || s === 'ig_dm') return 'ig_dm';
  if (s.includes('linkedin')) return 'linkedin';
  if (s.includes('live') || s.includes('webchat') || s.includes('web_chat')) return 'live_chat';
  if (s.includes('all') || s.includes('omni')) return 'all_in_one';
  if (CHANNEL_KEYS.includes(s as ChannelKey)) return s as ChannelKey;
  return null;
}

interface ConversationRecord {
  channel?: string;
  ts?: string;
  timestamp?: string;
  date?: string;
  sentiment?: number | string;
  escalated?: boolean;
  kb_hit?: boolean;
  is_bot?: boolean;
  is_spam?: boolean;
  objection?: string;
  discount_redeemed?: boolean;
}

function tsOf(r: ConversationRecord): number {
  const v = r.ts || r.timestamp || r.date;
  if (!v) return 0;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? 0 : t;
}

/** Bucket a unix-ms timestamp into a YYYY-MM-DD day string. */
function dayKey(ms: number): string {
  if (!ms) return 'unknown';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Channel volume from the conversations log. Falls back to the pixel-events
 * dir if a dedicated conversations log is not present.
 */
export function channelVolume(): MetricFamily<{ channel: ChannelKey; label: string; count: number }[]> {
  let res: JsonlReadResult<ConversationRecord> = readJsonl<ConversationRecord>('conversations-log.jsonl');
  if (!res.available) res = readJsonlDir<ConversationRecord>('conversations');
  if (!res.available) res = readJsonlDir<ConversationRecord>('pixel-events');

  const counts: Record<ChannelKey, number> = Object.fromEntries(
    CHANNEL_KEYS.map((k) => [k, 0]),
  ) as Record<ChannelKey, number>;

  for (const r of res.records) {
    const ch = normalizeChannel(r.channel);
    if (ch) counts[ch] += 1;
  }

  return {
    available: res.available,
    source: res.source,
    data: CHANNEL_KEYS.map((k) => ({ channel: k, label: CHANNEL_LABELS[k], count: counts[k] })),
  };
}

/** Conversations per day for a trailing window (default 30 days). */
export function conversationsTimeline(windowDays = 30): MetricFamily<{ day: string; count: number }[]> {
  let res: JsonlReadResult<ConversationRecord> = readJsonl<ConversationRecord>('conversations-log.jsonl');
  if (!res.available) res = readJsonlDir<ConversationRecord>('conversations');

  const cutoff = Date.now() - windowDays * 86400_000;
  const byDay = new Map<string, number>();
  for (const r of res.records) {
    const ms = tsOf(r);
    if (ms && ms < cutoff) continue;
    const k = dayKey(ms);
    byDay.set(k, (byDay.get(k) ?? 0) + 1);
  }
  const data = Array.from(byDay.entries())
    .filter(([d]) => d !== 'unknown')
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  return { available: res.available, source: res.source, data };
}

/** Sentiment trend: average sentiment per day (-1..1 normalized). */
export function sentimentTrend(windowDays = 30): MetricFamily<{ day: string; avg: number; n: number }[]> {
  let res: JsonlReadResult<ConversationRecord> = readJsonl<ConversationRecord>('conversations-log.jsonl');
  if (!res.available) res = readJsonl<ConversationRecord>('sentiment-log.jsonl');

  const cutoff = Date.now() - windowDays * 86400_000;
  const acc = new Map<string, { sum: number; n: number }>();
  for (const r of res.records) {
    if (r.sentiment === undefined || r.sentiment === null) continue;
    const ms = tsOf(r);
    if (ms && ms < cutoff) continue;
    const val = normalizeSentiment(r.sentiment);
    if (val === null) continue;
    const k = dayKey(ms);
    const cur = acc.get(k) ?? { sum: 0, n: 0 };
    cur.sum += val;
    cur.n += 1;
    acc.set(k, cur);
  }
  const data = Array.from(acc.entries())
    .filter(([d]) => d !== 'unknown')
    .map(([day, v]) => ({ day, avg: v.n ? v.sum / v.n : 0, n: v.n }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  return { available: res.available, source: res.source, data };
}

function normalizeSentiment(v: number | string): number | null {
  if (typeof v === 'number') {
    if (v >= -1 && v <= 1) return v;
    if (v >= 0 && v <= 100) return v / 50 - 1; // 0..100 -> -1..1
    return null;
  }
  const s = String(v).toLowerCase();
  if (s.includes('pos')) return 1;
  if (s.includes('neg')) return -1;
  if (s.includes('neu')) return 0;
  const n = Number(s);
  return Number.isNaN(n) ? null : normalizeSentiment(n);
}

/** Escalation rate: escalated conversations / total. */
export function escalationRate(): MetricFamily<{ escalated: number; total: number; rate: number }> {
  const res = readJsonl<ConversationRecord>('conversations-log.jsonl');
  const total = res.records.length;
  const escalated = res.records.filter((r) => r.escalated === true).length;
  return {
    available: res.available,
    source: res.source,
    data: { escalated, total, rate: total ? escalated / total : 0 },
  };
}

/** Top objections, ranked. */
export function topObjections(limit = 8): MetricFamily<{ objection: string; count: number }[]> {
  let res: JsonlReadResult<ConversationRecord> = readJsonl<ConversationRecord>('objections-log.jsonl');
  if (!res.available) res = readJsonl<ConversationRecord>('conversations-log.jsonl');

  const counts = new Map<string, number>();
  for (const r of res.records) {
    const o = (r.objection ?? '').toString().trim();
    if (!o) continue;
    counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  const data = Array.from(counts.entries())
    .map(([objection, count]) => ({ objection, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  return { available: res.available, source: res.source, data };
}

/** KB / FAQ hit rate from faq-detour-log.jsonl. */
export function kbHitRate(): MetricFamily<{ hits: number; total: number; rate: number }> {
  const res = readJsonl<{ kb_hit?: boolean; hit?: boolean; matched?: boolean }>('faq-detour-log.jsonl');
  let hits = 0;
  for (const r of res.records) {
    if (r.kb_hit === true || r.hit === true || r.matched === true) hits += 1;
  }
  const total = res.records.length;
  return { available: res.available, source: res.source, data: { hits, total, rate: total ? hits / total : 0 } };
}

/** Discount redemptions. */
export function discountRedemptions(): MetricFamily<{ redeemed: number; offered: number; rate: number }> {
  let res: JsonlReadResult<{ redeemed?: boolean; offered?: boolean }> = readJsonl('discount-log.jsonl');
  if (!res.available) res = readJsonl('conversations-log.jsonl');
  let redeemed = 0;
  let offered = 0;
  for (const r of res.records) {
    if (r.offered === true) offered += 1;
    if (r.redeemed === true) {
      redeemed += 1;
      if (r.offered === undefined) offered += 1; // a redemption implies an offer
    }
  }
  return {
    available: res.available,
    source: res.source,
    data: { redeemed, offered, rate: offered ? redeemed / offered : 0 },
  };
}

/** Follow-up performance from crm-field-writes-log.jsonl. */
export function followUpPerformance(): MetricFamily<{ writes: number; contacts: number; coverage: number }> {
  const res = readJsonl<{ contact_id?: string; field?: string }>('crm-field-writes-log.jsonl');
  const contacts = new Set<string>();
  for (const r of res.records) {
    if (r.contact_id) contacts.add(String(r.contact_id));
  }
  const writes = res.records.length;
  return {
    available: res.available,
    source: res.source,
    data: { writes, contacts: contacts.size, coverage: contacts.size ? writes / contacts.size : 0 },
  };
}

/** Bot / spam volume — from aggression-detection-log.md (markdown append log). */
export function botSpamVolume(): MetricFamily<{ flaggedLines: number }> {
  const md = readMarkdownLog('aggression-detection-log.md');
  // Each appended line is one flagged interaction. We do not parse content —
  // we only count, which is a faithful, non-fabricated signal.
  return { available: md.available, source: md.source, data: { flaggedLines: md.lineCount } };
}

/** Quiet-hours impact from interrupt-log.jsonl. */
export function quietHoursImpact(): MetricFamily<{ interrupts: number; deferred: number; rate: number }> {
  const res = readJsonl<{ deferred?: boolean; quiet_hours?: boolean; action?: string }>('interrupt-log.jsonl');
  const interrupts = res.records.length;
  let deferred = 0;
  for (const r of res.records) {
    if (r.deferred === true || r.quiet_hours === true || String(r.action ?? '').includes('defer')) {
      deferred += 1;
    }
  }
  return {
    available: res.available,
    source: res.source,
    data: { interrupts, deferred, rate: interrupts ? deferred / interrupts : 0 },
  };
}

/** Pixel funnel from the pixel-events/ directory. */
export function pixelFunnel(): MetricFamily<{ stage: string; count: number }[]> {
  const res = readJsonlDir<{ event?: string; stage?: string; type?: string }>('pixel-events');
  const counts = new Map<string, number>();
  for (const r of res.records) {
    const stage = (r.stage ?? r.event ?? r.type ?? '').toString().trim();
    if (!stage) continue;
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }
  const data = Array.from(counts.entries())
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => b.count - a.count);
  return { available: res.available, source: res.source, data };
}
