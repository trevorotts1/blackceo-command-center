'use client';

/**
 * Composer (U60 / JM-U63a — adapted from `operator/MessageInput.tsx`)
 *
 * Adapts MessageInput's interaction language (paperclip + textarea + Send/Stop
 * row, Enter-to-send/Shift+Enter-newline) rather than reusing it byte-for-byte:
 * MessageInput's attachment model is a 10 MiB base64 payload built for
 * BridgeChat's SSE POST body, which is incompatible with My AI CEO's existing
 * 200 MB file-based upload pipeline (`/api/ceo-chat/upload` +
 * `src/lib/ceo-chat/upload.ts`, preserved verbatim per spec (h)) — so this
 * component wires the SAME multipart upload flow the monolith had, in the
 * re-skinned visual shell. The top border is the design's one deliberate
 * exception to the "every value is a token" gate — a 2px hairline, not a
 * `tailwind.config.ts` shadow/radius/color.
 */
import { useRef } from 'react';
import { Paperclip, Send } from 'lucide-react';

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  streaming: boolean;
  onUploadFile: (file: File) => void;
  uploadNote: string | null;
}

export default function Composer({ value, onChange, onSend, streaming, onUploadFile, uploadNote }: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="border-t-2 border-bcc-border bg-bcc-white px-3 sm:px-6 py-3 shrink-0">
      {uploadNote && <div className="text-caption text-bcc-text-muted mb-2">{uploadNote}</div>}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="shrink-0 h-11 w-11 rounded-xl border border-bcc-border text-bcc-text-secondary hover:text-bcc-text hover:border-brand-300 flex items-center justify-center"
          aria-label="Upload a file"
        >
          <Paperclip className="w-5 h-5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUploadFile(f);
            e.target.value = '';
          }}
        />
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          placeholder="Message your AI CEO…"
          className="flex-1 resize-none max-h-40 min-h-[44px] rounded-xl border border-bcc-border px-3 py-2.5 text-body focus:outline-none focus:ring-2 focus:ring-brand-300"
        />
        <button
          type="button"
          onClick={onSend}
          disabled={streaming || !value.trim()}
          className="shrink-0 h-11 px-4 rounded-xl bg-brand-600 text-white font-medium hover:bg-brand-700 disabled:opacity-40 flex items-center gap-2"
        >
          <Send className="w-4 h-4" />
          <span className="hidden sm:inline">Send</span>
        </button>
      </div>
    </div>
  );
}
