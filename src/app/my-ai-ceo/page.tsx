'use client';

/**
 * /my-ai-ceo — the BETA "My AI CEO" surface (U60 / JM-U63 Phase A rebuild).
 *
 * Phase A decomposes the former 437-line monolith into the component set
 * under `src/components/ceo-chat/` (spec (a)), re-skins every surface to
 * `brand-*`/`bcc-*` tokens (spec (b)), rebuilds the side rail into a live
 * Operations Rail (spec (c)), adds the delegate-task control (spec (d)), a
 * context meter (spec (e)), list-only pickers with the sovereignty filter
 * (spec (f)), the full mobile/tablet/desktop tab system (spec (g)), and
 * preserves every existing behavior verbatim (spec (h)/(i)): beta gating,
 * gateway degrade banner, persist-before-forward, the 200MB upload pipeline,
 * and session restore. Zero gateway-contract changes — Phase B (U62/U65) is
 * gated on the U64 gateway spikes and does not block this unit.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';

import CeoChatHeader from '@/components/ceo-chat/CeoChatHeader';
import ControlStrip from '@/components/ceo-chat/ControlStrip';
import DelegateSheet from '@/components/ceo-chat/DelegateSheet';
import Composer from '@/components/ceo-chat/Composer';
import EmptyState from '@/components/ceo-chat/EmptyState';
import MessageBubble from '@/components/ceo-chat/MessageBubble';
import MobileTabs from '@/components/ceo-chat/MobileTabs';
import OperationsRail from '@/components/ceo-chat/OperationsRail';
import { useCeoChatSession } from '@/components/ceo-chat/useCeoChatSession';
import type { AgentOption, MobileTab, ModelOption } from '@/components/ceo-chat/types';

export default function MyAiCeoPage() {
  const router = useRouter();
  const {
    sessionId,
    messages,
    tasks,
    input,
    setInput,
    streaming,
    liveReply,
    gatewayUp,
    enabled,
    uploadNote,
    send,
    uploadFile,
    loadHistory,
    startFreshSession,
  } = useCeoChatSession();

  const [dragOver, setDragOver] = useState(false);
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<MobileTab>('conversation');
  const [agent, setAgent] = useState<AgentOption | null>(null);
  const [model, setModel] = useState<ModelOption | null>(null);
  const [resolvedByMap, setResolvedByMap] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // If the flag is off, leave the surface (BETA: never a broken card) — preserved verbatim.
  useEffect(() => {
    if (enabled === false) router.replace('/');
  }, [enabled, router]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, liveReply]);

  const charCount = useMemo(
    () => messages.reduce((sum, m) => sum + m.content.length, 0) + liveReply.length + input.length,
    [messages, liveReply, input],
  );

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  }

  const jumpToTask = useCallback((taskId: string) => {
    setActiveTab('happening');
    // Two-tick delay lets the tab switch mount the rail before we scroll to it.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.getElementById(`ops-rail-task-${taskId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }, []);

  const gatewayDown = gatewayUp === false;
  const happeningCount = tasks.length;

  return (
    <div className="h-full min-h-dvh bg-bcc-bg flex flex-col">
      <CeoChatHeader
        gatewayUp={gatewayUp}
        charCount={charCount}
        contextWindow={model?.context_window ?? null}
        onStartFresh={startFreshSession}
      />

      <ControlStrip
        onAgentResolved={setAgent}
        onModelResolved={setModel}
        onOpenDelegate={() => setDelegateOpen(true)}
      />

      {gatewayDown && (
        <div className="bg-semantic-warningLight border-b border-amber-200 px-4 sm:px-6 py-2.5 flex items-start gap-2 text-body text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Your AI CEO is restarting. Your messages are saved — <strong>Telegram still works</strong> in the meantime.
          </span>
        </div>
      )}

      <MobileTabs value={activeTab} onChange={setActiveTab} happeningCount={happeningCount} />

      <main className="flex-1 min-h-0 flex flex-col lg:flex-row max-w-7xl w-full mx-auto">
        {/* Chat column — always rendered on lg+; tab-gated below lg. */}
        <section
          className={`flex-1 min-h-0 flex-col relative ${activeTab === 'conversation' ? 'flex' : 'hidden lg:flex'}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {dragOver && (
            <div className="absolute inset-0 z-20 bg-brand-500/10 border-2 border-dashed border-brand-400 flex items-center justify-center pointer-events-none">
              <span className="text-brand-700 font-semibold">Drop to share with your AI CEO</span>
            </div>
          )}

          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-6 space-y-4">
            {messages.length === 0 && !liveReply && (
              <EmptyState agent={agent} model={model} onStarterClick={(text) => setInput(text)} />
            )}

            {messages.map((m) => (
              <MessageBubble key={m.id} m={m} onJumpToTask={jumpToTask} />
            ))}

            {liveReply && (
              <MessageBubble
                m={{
                  id: 'live',
                  role: 'assistant',
                  content: liveReply,
                  kind: 'message',
                  task_id: null,
                  created_at: new Date().toISOString(),
                }}
              />
            )}
            {streaming && !liveReply && (
              <div className="flex items-center gap-2 text-bcc-text-muted text-body">
                <Loader2 className="w-4 h-4 animate-spin" /> Your AI CEO is thinking…
              </div>
            )}
          </div>

          <Composer
            value={input}
            onChange={setInput}
            onSend={send}
            streaming={streaming}
            onUploadFile={uploadFile}
            uploadNote={uploadNote}
          />
        </section>

        {/* Operations Rail — always rendered on lg+; tab-gated below lg. */}
        <aside
          className={`lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-bcc-border bg-bcc-white/60 px-4 sm:px-5 py-4 lg:overflow-y-auto ${
            activeTab === 'happening' ? 'block' : 'hidden lg:block'
          }`}
        >
          <OperationsRail
            tasks={tasks}
            messages={messages}
            onRefresh={loadHistory}
            resolvedByMap={resolvedByMap}
          />
        </aside>
      </main>

      <DelegateSheet
        open={delegateOpen}
        onClose={() => setDelegateOpen(false)}
        sessionId={sessionId}
        onDelegated={(result) => {
          setResolvedByMap((prev) => ({ ...prev, [result.taskId]: result.resolved_by }));
          loadHistory();
          setActiveTab('happening');
        }}
      />
    </div>
  );
}
