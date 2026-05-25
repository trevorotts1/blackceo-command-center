'use client';

/**
 * VoiceButton
 *
 * Web Speech API microphone toggle, adapted from Agent OS's donor
 * `source/src/components/VoiceButton.tsx`. The wire-up is unchanged but
 * the styling has been ported from the donor's dark theme tokens to the
 * BlackCEO Tailwind v3 token set (`bcc-*`).
 *
 * Browser support: Web Speech is Chrome/Edge/Safari only. Firefox returns
 * `undefined` for `webkitSpeechRecognition`, in which case the button
 * renders disabled with a tooltip.
 *
 * The PRD asks for a voice button on every chat input (Section 4.3). This
 * component is the only consumer of the Web Speech API in the Bridge
 * sub-module. Track B8 (Call Mode) reuses the same recognition stream
 * indirectly via a different button that lives next to this one.
 */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Mic, MicOff } from 'lucide-react';

type SpeechRecResult = {
  transcript: string;
  isFinal?: boolean;
};

type SpeechRecResults = {
  length: number;
  [index: number]: ArrayLike<SpeechRecResult> & { isFinal?: boolean };
};

type SpeechRecInstance = {
  start: () => void;
  stop: () => void;
  abort: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: SpeechRecResults }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecCtor = new () => SpeechRecInstance;

interface Props {
  onTranscript: (text: string, opts: { final: boolean }) => void;
  className?: string;
  size?: number;
}

function getSpeechRec(): SpeechRecCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecCtor;
    webkitSpeechRecognition?: SpeechRecCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition;
}

export default function VoiceButton({
  onTranscript,
  className = '',
  size = 38,
}: Props) {
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecInstance | null>(null);

  useEffect(() => {
    setSupported(Boolean(getSpeechRec()));
  }, []);

  function start() {
    setError(null);
    const Ctor = getSpeechRec();
    if (!Ctor) {
      setError('Voice not supported in this browser. Use Chrome or Safari.');
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    let lastFinal = 0;
    rec.onresult = (e) => {
      let interim = '';
      let finalText = '';
      for (let i = lastFinal; i < e.results.length; i++) {
        const r = e.results[i][0];
        if ((e.results[i] as { isFinal?: boolean }).isFinal) {
          finalText += r.transcript;
          lastFinal = i + 1;
        } else {
          interim += r.transcript;
        }
      }
      if (finalText) onTranscript(finalText.trim(), { final: true });
      else if (interim) onTranscript(interim.trim(), { final: false });
    };
    rec.onerror = (e) => {
      setError(e.error || 'voice error');
      setActive(false);
    };
    rec.onend = () => setActive(false);
    recRef.current = rec;
    try {
      rec.start();
      setActive(true);
    } catch (err) {
      setError(String(err));
    }
  }

  function stop() {
    try {
      recRef.current?.stop();
    } catch {
      // ignore
    }
    setActive(false);
  }

  if (supported === false) {
    return (
      <button
        title="Voice input requires Chrome, Edge, or Safari"
        disabled
        className={`grid place-items-center rounded-lg border border-bcc-border text-bcc-text-muted opacity-50 cursor-not-allowed ${className}`}
        style={{ width: size, height: size }}
        aria-label="Voice input not supported"
      >
        <MicOff size={size * 0.45} />
      </button>
    );
  }

  return (
    <div className="flex items-center">
      <motion.button
        type="button"
        onClick={active ? stop : start}
        whileTap={{ scale: 0.92 }}
        title={active ? 'Stop recording' : 'Speak to type'}
        aria-label={active ? 'Stop voice recording' : 'Start voice recording'}
        className={`relative grid place-items-center rounded-lg border transition ${className}`}
        style={{
          width: size,
          height: size,
          borderColor: active ? 'rgba(239,68,68,0.55)' : '#E5E7EB',
          background: active ? 'rgba(239,68,68,0.10)' : '#FFFFFF',
          color: active ? '#DC2626' : '#6B7280',
        }}
      >
        <Mic size={size * 0.45} />
        {active && (
          <>
            <span
              className="absolute inset-0 rounded-lg pointer-events-none"
              style={{ animation: 'mic-ring 1.4s ease-out infinite' }}
            />
            <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-rose-500 shadow-[0_0_8px_#ef4444]" />
          </>
        )}
        <style jsx>{`
          @keyframes mic-ring {
            0% {
              box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.45);
            }
            70% {
              box-shadow: 0 0 0 12px rgba(239, 68, 68, 0);
            }
            100% {
              box-shadow: 0 0 0 0 rgba(239, 68, 68, 0);
            }
          }
        `}</style>
      </motion.button>
      {error && (
        <span className="text-[11px] text-rose-500 ml-2" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
