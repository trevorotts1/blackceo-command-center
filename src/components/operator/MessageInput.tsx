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
 *   - Enter sends; Shift+Enter inserts a newline
 *   - Cmd+Enter or Ctrl+Enter also sends (kept for muscle memory)
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
 * The phone button next to the mic links into Call Mode (`/operator/call`,
 * shipped by Track B8). Added in the Wave 1 orchestrator follow-up so the
 * Bridge composer can hand off to hands-free voice without leaving the row.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Send, Square, Phone, Paperclip, X } from 'lucide-react';
import VoiceButton from './VoiceButton';

/** An attachment the operator has picked but not yet sent. */
export interface PendingAttachment {
  /** Original filename (used for the scratch-dir filename and the chip label). */
  filename: string;
  /** MIME type as reported by the browser (best-effort). */
  contentType: string;
  /** Byte size of the decoded payload. */
  size: number;
  /** Base64-encoded file bytes (no data-URL prefix). */
  base64: string;
}

/**
 * Max attachment size accepted by the composer. Kept conservative so a large
 * base64 payload never bloats the SSE POST body or the scratch dir. The send
 * route enforces the same ceiling server-side.
 */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MiB

interface Props {
  agentLabel: string;
  accent: string;
  streaming: boolean;
  onSend: (text: string, attachment: PendingAttachment | null) => void;
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
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const interimRef = useRef<string>('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
    // Allow sending when there is text OR an attachment (an attachment alone is
    // a valid "here is a file, take a look" turn).
    if ((!text && !attachment) || streaming) return;
    setInput('');
    interimRef.current = '';
    const att = attachment;
    setAttachment(null);
    setAttachError(null);
    onSend(text, att);
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input value so picking the same file twice re-fires onChange.
    e.target.value = '';
    if (!file) return;
    setAttachError(null);
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachError(
        `File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Max ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`,
      );
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Chunked base64 so a large file does not blow the call-stack. Build each
      // chunk with apply() (no iterator spread) so this stays downlevel-safe.
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const slice = bytes.subarray(i, i + CHUNK);
        binary += String.fromCharCode.apply(null, Array.from(slice));
      }
      const base64 = btoa(binary);
      setAttachment({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        base64,
      });
    } catch {
      setAttachError('Could not read that file. Try again.');
    }
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
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={handleFilePick}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={streaming}
          aria-label="Attach a file"
          title="Attach a file"
          className="grid place-items-center rounded-lg border bg-bcc-white text-bcc-text-muted hover:text-bcc-text hover:border-bcc-text-muted transition disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            width: 38,
            height: 38,
            borderColor: '#E5E7EB',
          }}
        >
          <Paperclip size={17} />
        </button>
        <Link
          href="/operator/call"
          aria-label="Open Call Mode for hands-free voice conversation"
          title="Open Call Mode"
          className="grid place-items-center rounded-lg border bg-bcc-white text-bcc-text-muted hover:text-bcc-text hover:border-bcc-text-muted transition"
          style={{
            width: 38,
            height: 38,
            borderColor: '#E5E7EB',
          }}
        >
          <Phone size={17} />
        </Link>
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline. Cmd/Ctrl+Enter also
            // sends (kept for existing muscle memory). We let Shift+Enter fall
            // through to the textarea's default newline insertion.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              fire();
            }
            if (e.key === 'Escape' && streaming) {
              e.preventDefault();
              onStop();
            }
          }}
          rows={2}
          placeholder={`Message ${agentLabel}. Enter to send, Shift+Enter for newline.`}
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
            disabled={!input.trim() && !attachment}
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

      {/* Attachment chip — shows the file the operator picked, with a remove (x). */}
      {attachment && (
        <div className="mt-2 px-1 flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 max-w-full rounded-lg border px-2 py-1 text-[12px] text-bcc-text"
            style={{ borderColor: `${accent}55`, background: `${accent}0f` }}
          >
            <Paperclip size={12} className="shrink-0" style={{ color: accent }} />
            <span className="truncate" title={attachment.filename}>
              {attachment.filename}
            </span>
            <span className="text-bcc-text-muted shrink-0">
              {(attachment.size / 1024).toFixed(0)} KB
            </span>
            <button
              type="button"
              onClick={() => setAttachment(null)}
              aria-label={`Remove attachment ${attachment.filename}`}
              title="Remove attachment"
              className="grid place-items-center rounded text-bcc-text-muted hover:text-rose-500 transition shrink-0"
            >
              <X size={13} />
            </button>
          </span>
        </div>
      )}

      {attachError && (
        <div
          role="alert"
          className="mt-2 px-1 text-[12px] text-rose-600"
        >
          {attachError}
        </div>
      )}

      <div className="mt-1.5 px-1 flex items-center justify-between text-[10px] text-bcc-text-muted uppercase tracking-widest">
        <span>auto-saved to the chat session</span>
        <span>
          <kbd className="px-1 py-0.5 rounded border border-bcc-border-light">Enter</kbd> to send
          <span className="mx-1.5">.</span>
          <kbd className="px-1 py-0.5 rounded border border-bcc-border-light">Shift+Enter</kbd> for newline
          <span className="mx-1.5">.</span>
          <kbd className="px-1 py-0.5 rounded border border-bcc-border-light">Esc</kbd> stop
        </span>
      </div>
    </div>
  );
}
