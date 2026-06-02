'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { MessagesSquare } from 'lucide-react';
import { Breadcrumb } from '@/components/Breadcrumb';
import { SectionContainer } from '@/components/ceo-board/redesign/SectionContainer';
import { ChannelVolumeChart } from '@/components/conversational-ai/ChannelVolumeChart';
import { ConversationsTimeline } from '@/components/conversational-ai/ConversationsTimeline';
import { ConvAiKpiStrip } from '@/components/conversational-ai/ConvAiKpiStrip';
import { SentimentTrend } from '@/components/conversational-ai/SentimentTrend';
import { TopObjections } from '@/components/conversational-ai/TopObjections';
import { PixelFunnel } from '@/components/conversational-ai/PixelFunnel';
import { InterviewBanner } from '@/components/conversational-ai/InterviewBanner';
import { Layer2Section } from '@/components/conversational-ai/Layer2Section';
import { EmptyState } from '@/components/conversational-ai/EmptyState';
import { ConnectionStatusBar } from '@/components/conversational-ai/ConnectionStatusBar';
import type { ClientWiringInfo } from '@/components/conversational-ai/ConnectionStatusBar';
import type { MetricsResponse, StatusResponse, EnrichedResponse } from '@/components/conversational-ai/types';

const STATUS_POLL_MS = 20_000; // poll for interview completion every 20s

const pageVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.1, delayChildren: 0.05 } },
};
const sectionVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

export default function ConversationalAiPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [enriched, setEnriched] = useState<EnrichedResponse | null>(null);
  // E1: selected client for the connection-wiring description
  const [selectedClient, setSelectedClient] = useState<ClientWiringInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const prevComplete = useRef<boolean | null>(null);

  const loadMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/conversational-ai/metrics', { cache: 'no-store' });
      if (res.ok) setMetrics(await res.json());
    } catch {
      /* graceful: keep prior metrics, empty-states render */
    }
  }, []);

  const loadEnriched = useCallback(async () => {
    try {
      const res = await fetch('/api/conversational-ai/enriched', { cache: 'no-store' });
      if (res.ok) setEnriched(await res.json());
    } catch {
      /* graceful */
    }
  }, []);

  // E1: fetch the currently selected client for the connection-wiring description.
  // GET /api/clients/select echoes back whichever client the cookie identifies
  // (server-resolved, defaults to self). This is the only way to get the right
  // label in a client component since the selectedClientId cookie is httpOnly.
  const loadSelectedClient = useCallback(async () => {
    try {
      const res = await fetch('/api/clients/select', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json() as { ok: boolean; selected: ClientWiringInfo | null };
      if (data.selected) setSelectedClient(data.selected);
    } catch {
      /* graceful: no client info shown, connection pill still works */
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/conversational-ai/status', { cache: 'no-store' });
      if (res.ok) {
        const data: StatusResponse = await res.json();
        setStatus(data);
        // Real-time unlock: if the interview JUST completed while the page is
        // open, pull the enriched layer with no reload. Layer-1 stays intact.
        if (data.interview.complete && prevComplete.current === false) {
          loadEnriched();
        }
        // First-load: if already complete, pull enriched immediately.
        if (data.interview.complete && prevComplete.current === null) {
          loadEnriched();
        }
        prevComplete.current = data.interview.complete;
      }
    } catch {
      /* graceful */
    }
  }, [loadEnriched]);

  // Initial load — E1: load selected-client info in parallel with other fetches
  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadStatus(), loadMetrics(), loadSelectedClient()]);
      setLoading(false);
    })();
  }, [loadStatus, loadMetrics, loadSelectedClient]);

  // Poll status so Layer 2 appears in real time when the interview completes.
  useEffect(() => {
    const id = setInterval(() => {
      loadStatus();
    }, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [loadStatus]);

  const m = metrics?.metrics;
  const layer2Unlocked = !!status?.interview.complete && !!enriched && enriched.locked === false;

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        <Breadcrumb items={[{ label: 'Home', href: '/' }, { label: 'Conversational AI' }]} />

        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <span className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-fuchsia-500 via-pink-500 to-rose-500 text-white shrink-0">
            <MessagesSquare className="w-6 h-6" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Conversational AI Analytics</h1>
            <p className="text-base text-gray-500 mt-0.5">
              Live channel volume, conversations, sentiment, objections and funnel performance across every messaging surface.
            </p>
          </div>
        </div>

        {/* E1 — Connection-state indicator. Rendered unconditionally (even while
         *  loading) so the operator always sees which gateway this page talks to
         *  and whether it is connected. Uses `null` status while loading so the
         *  bar shows the "Checking connection…" state. */}
        <div className="mb-6">
          <ConnectionStatusBar status={status} selectedClient={selectedClient} />
        </div>

        {loading ? (
          <div className="space-y-6">
            <div className="h-[120px] rounded-2xl bg-gray-200 animate-pulse" />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="h-[320px] rounded-2xl bg-gray-200 animate-pulse" />
              <div className="h-[320px] rounded-2xl bg-gray-200 animate-pulse" />
            </div>
          </div>
        ) : (
          <motion.div className="space-y-6" variants={pageVariants} initial="hidden" animate="visible">
            {/* Layer-2 gate banner — shown only while interview incomplete AND
             *  the status is KNOWN. E3: when status is unknown (no per-client
             *  flag, no positive signal) the banner defaults to HIDDEN so an
             *  already-onboarded client is never nagged. */}
            {status && !status.interview.complete && status.interview.known !== false && (
              <motion.div variants={sectionVariants}>
                <InterviewBanner />
              </motion.div>
            )}

            {/* Whole-dashboard empty hint when NO source is connected yet */}
            {metrics && !metrics.anyData && (
              <motion.div variants={sectionVariants}>
                <SectionContainer title="Getting Started" accentColor="bg-gray-400">
                  <EmptyState
                    title="No conversational-AI data sources connected yet"
                    hint="As the Round-3 OpenClaw skills come online, each metric below fills in automatically. Nothing here is simulated — empty means awaiting data."
                    minHeight={120}
                  />
                </SectionContainer>
              </motion.div>
            )}

            {/* ── LAYER 1 — universal, works for every client ── */}
            <motion.div variants={sectionVariants}>
              <SectionContainer title="Operational Signals" accentColor="bg-emerald-500">
                <ConvAiKpiStrip metrics={m} />
              </SectionContainer>
            </motion.div>

            <motion.div variants={sectionVariants}>
              <SectionContainer title="Channel Volume" accentColor="bg-blue-500" context="All messaging surfaces">
                <ChannelVolumeChart metric={m?.channelVolume} />
              </SectionContainer>
            </motion.div>

            <motion.div className="grid grid-cols-1 lg:grid-cols-2 gap-6" variants={sectionVariants}>
              <SectionContainer title="Conversations Over Time" accentColor="bg-indigo-500" context="Last 30 days">
                <ConversationsTimeline metric={m?.conversationsTimeline} />
              </SectionContainer>
              <SectionContainer title="Sentiment Trend" accentColor="bg-violet-500" context="Last 30 days">
                <SentimentTrend metric={m?.sentimentTrend} />
              </SectionContainer>
            </motion.div>

            <motion.div className="grid grid-cols-1 lg:grid-cols-2 gap-6" variants={sectionVariants}>
              <SectionContainer title="Top Objections" accentColor="bg-amber-500">
                <TopObjections metric={m?.topObjections} />
              </SectionContainer>
              <SectionContainer title="Pixel Funnel" accentColor="bg-rose-500">
                <PixelFunnel metric={m?.pixelFunnel} />
              </SectionContainer>
            </motion.div>

            {/* ── LAYER 2 — persona-tuned, unlocks on interview completion ── */}
            {layer2Unlocked && enriched && (
              <motion.div variants={sectionVariants}>
                <Layer2Section enriched={enriched} />
              </motion.div>
            )}

            {/* Data freshness footer */}
            {metrics?.generatedAt && (
              <p className="text-sm text-gray-400 text-center pt-2">
                Last updated {new Date(metrics.generatedAt).toLocaleTimeString()} ·{' '}
                {status?.interview.complete ? 'Layer 2 active' : 'Layer 1 (universal)'}
              </p>
            )}
          </motion.div>
        )}
      </main>
    </div>
  );
}
