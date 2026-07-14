'use client';

/**
 * CeoChatHeader (U60 / JM-U63a/b — re-skinned, `brand-*`/`bcc-*` tokens only)
 *
 * Preserved verbatim (spec (h)): the Beta pill and the gateway status pill.
 * Re-skinned (spec (b)): the crest gradient and Beta pill are now brand-green
 * tokens, not indigo/purple. The ContextMeter (spec (e)) is always visible at
 * rest here — both breakpoints, per acceptance item 6.
 */
import Link from 'next/link';
import { ArrowLeft, Sparkles } from 'lucide-react';
import ContextMeter from './ContextMeter';

interface CeoChatHeaderProps {
  gatewayUp: boolean | null;
  charCount: number;
  contextWindow: number | null;
  onStartFresh: () => void;
}

export default function CeoChatHeader({ gatewayUp, charCount, contextWindow, onStartFresh }: CeoChatHeaderProps) {
  return (
    <header className="h-14 bg-bcc-white border-b border-bcc-border px-4 sm:px-6 flex items-center justify-between gap-3 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <Link href="/" className="text-bcc-text-secondary hover:text-bcc-text shrink-0" aria-label="Back to dashboard">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-white" />
        </div>
        <h1 className="font-semibold text-bcc-text truncate">My AI CEO</h1>
        <span className="text-[10px] font-bold uppercase tracking-wider text-brand-700 bg-brand-50 border border-brand-200 rounded px-1.5 py-0.5 shrink-0">
          Beta
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <ContextMeter charCount={charCount} contextWindow={contextWindow} onStartFresh={onStartFresh} />
        <div
          className={`flex items-center gap-2 px-2.5 py-1 rounded-lg text-caption font-medium ${
            gatewayUp === null
              ? 'bg-bcc-border-light border border-bcc-border text-bcc-text-muted'
              : gatewayUp
                ? 'bg-semantic-successLight border border-emerald-200 text-emerald-700'
                : 'bg-semantic-warningLight border border-amber-200 text-amber-700'
          }`}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              gatewayUp === null ? 'bg-bcc-text-muted' : gatewayUp ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'
            }`}
          />
          {gatewayUp === null ? 'Checking' : gatewayUp ? 'Connected' : 'Restarting'}
        </div>
      </div>
    </header>
  );
}
