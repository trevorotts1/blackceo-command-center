'use client';

/**
 * MessageInput
 *
 * Composer used by BridgeChat. Owns:
 *   - the textarea
 *   - the VoiceButton mic
 *   - the Send / Stop button (toggles based on `streaming`)
 *
 * Keyboard:
 *   - Cmd+Enter or Ctrl+Enter sends
 *   - Escape while streaming aborts the in-flight turn
 *
 * Voice input strategy (ported from donor `UnifiedChat`):
 *   - Interim transcripts append a `[voice] ...` marker to the textarea
 *     so the user can see what is being heard but can edit before sending.
 *   - When a final transcript arrives, the marker is removed and the final
 *     text appended cleanly.
 *
 * The send action is delegated to the parent (`onSend(text)`) so that the
 * parent can drive the SSE fetch and persist state. The component does
 * not own any chat history.
 *
 * Track B8 (Call Mode) will add a phone button next to the mic in a
 * separate follow-up commit. The layout intentionally keeps space to the
 * right of the mic so that addition is a small visual delta.
 */

import { useEffect, useRef, useState } from 'react';
import { Send, Square } from 'lucide-react';
import VoiceButton from './VoiceButton';

interface Props {
  agentLabel: string;
  accent: string;
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export default function MessageInput({
  agentLabel,
  accent,
  streaming,
  onSend,
  onStop,
}: Props) {
  const [input, setInput] = useState('');
  const interimRef = useRef<string>('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea up to a max so multi-line prompts breathe but the
  // composer never eats half the viewport.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, 220);
    el.style.height = `${next}px`;
  }, [input]);

  function fire() {
    const text = input.replace(/\s*\[voice\][^]*$/, '').trim();
    if (!text || streaming) return;
    setInput('');
    interimRef.current = '';
    onSend(text);
  }

  function handleVoice(t: string, opts: { final: boolean }) {
    if (opts.final) {
      const base = interimRef.current
        ? input.replace(/\s*\[voice\][^]*$/, '')
        : input;
      interimRef.current = '';
      const sep = base.length === 0 || base.endsWith(' ') ? '' : ' ';
      setInput((base + sep + t).trim());
    } else {
      interimRef.current = t;
      const base = input.replace(/\s*\[voice\][^]*$/, '');
      const sep = base.length ? ' ' : '';
      setInput(`${base}${sep}[voice] ${t}`.trim());
    }
  }

  return (
    <div className="border-t border-bcc-border bg-bcc-white p-3">
      <div
        className="flex items-end gap-2 rounded-2xl border bg-bcc-white p-2 focus-within:border-bcc-text-muted transition"
        style={{ borderColor: '#E5E7EB' }}
      >
        <VoiceButton onTranscript={handleVoice} size={38} />
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              fire();
            }
            if (e.key === 'Escape' && streaming) {
              e.preventDefault();
              onStop();
            }
          }}
          rows={2}
          placeholder={`Message ${agentLabel}. Cmd+Enter to send.`}
          aria-label={`Message ${agentLabel}`}
          className="flex-1 bg-transparent outline-none resize-none px-2 py-2 text-[14px] text-bcc-text placeholder:text-bcc-text-muted min-h-[44px] max-h-[220px]"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop streaming"
            className="px-3 h-[38px] rounded-lg bg-rose-50 border border-rose-200 text-rose-600 text-sm flex items-center gap-1.5 hover:bg-rose-100 transition"
          >
            <Square size={14} /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={fire}
            disabled={!input.trim()}
            aria-label={`Send to ${agentLabel}`}
            className="px-3 h-[38px] rounded-lg flex items-center gap-1.5 text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: `${accent}1a`,
              border: `1px solid ${accent}55`,
              color: accent,
            }}
          >
            <Send size={14} /> Send
          </button>
        )}
      </div>
      <div className="mt-1.5 px-1 flex items-center justify-between text-[10px] text-bcc-text-muted uppercase tracking-widest">
        <span>auto-saved to the chat session</span>
        <span>
          <kbd className="px-1 py-0.5 rounded border border-bcc-border-light">Cmd+Enter</kbd> send
          <span className="mx-1.5">.</span>
          <kbd className="px-1 py-0.5 rounded border border-bcc-border-light">Esc</kbd> stop
        </span>
      </div>
    </div>
  );
}
