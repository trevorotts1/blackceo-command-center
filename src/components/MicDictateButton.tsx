'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';

interface MicDictateButtonProps {
  /** Called with the final (and interim) transcript text. */
  onTranscript: (text: string, isFinal: boolean) => void;
  /** Optional label shown in tooltip / aria-label. Defaults to "Dictate". */
  label?: string;
  /** Additional Tailwind classes for the button wrapper. */
  className?: string;
  /** Whether the button is disabled from the parent (e.g. form is submitting). */
  disabled?: boolean;
}

type RecState = 'idle' | 'listening' | 'processing';

/**
 * MicDictateButton
 *
 * Thin wrapper around the browser Web Speech API (SpeechRecognition /
 * webkitSpeechRecognition). Fires `onTranscript` with interim results as the
 * user speaks and a final result when recognition ends.
 *
 * Graceful degradation: if SpeechRecognition is not available in the current
 * browser (e.g. Firefox without the flag) the button renders in a disabled
 * state with a tooltip explaining the requirement.
 *
 * SSR-safe: the window.SpeechRecognition check is deferred to a useEffect so
 * it never runs during Next.js server rendering.
 */
export function MicDictateButton({
  onTranscript,
  label = 'Dictate',
  className = '',
  disabled = false,
}: MicDictateButtonProps) {
  const [supported, setSupported] = useState<boolean | null>(null); // null = not yet checked
  const [recState, setRecState] = useState<RecState>('idle');
  const recognitionRef = useRef<any>(null);
  const interimTextRef = useRef('');

  // Detect support after mount (avoids SSR window access).
  useEffect(() => {
    const SR =
      typeof window !== 'undefined' &&
      ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);
    setSupported(!!SR);
  }, []);

  const stopRecognition = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    interimTextRef.current = '';
    setRecState('idle');
  }, []);

  const startRecognition = useCallback(() => {
    const SR =
      (window as any).SpeechRecognition ??
      (window as any).webkitSpeechRecognition;

    if (!SR) return;

    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.continuous = false; // single utterance; toggle to restart

    recognition.onstart = () => {
      setRecState('listening');
    };

    recognition.onresult = (event: any) => {
      let interim = '';
      let finalText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      if (interim) {
        interimTextRef.current = interim;
        onTranscript(interim, false);
      }
      if (finalText) {
        interimTextRef.current = '';
        onTranscript(finalText, true);
      }
    };

    recognition.onerror = (event: any) => {
      // 'aborted' fires when we call .stop() ourselves — ignore it.
      if (event.error !== 'aborted') {
        console.warn('[MicDictateButton] SpeechRecognition error:', event.error);
      }
      setRecState('idle');
      recognitionRef.current = null;
      interimTextRef.current = '';
    };

    recognition.onend = () => {
      // If we were still listening (user didn't click stop), transition to idle.
      setRecState((prev) => (prev === 'listening' ? 'idle' : prev));
      recognitionRef.current = null;
      interimTextRef.current = '';
    };

    recognitionRef.current = recognition;
    setRecState('processing'); // brief flash before onstart fires
    recognition.start();
  }, [onTranscript]);

  const handleClick = () => {
    if (recState === 'listening' || recState === 'processing') {
      stopRecognition();
    } else {
      startRecognition();
    }
  };

  // While support check is pending, render nothing to avoid layout shift.
  if (supported === null) return null;

  // Browser doesn't support Web Speech API — show a disabled mic with tooltip.
  if (!supported) {
    return (
      <button
        type="button"
        disabled
        title="Dictation needs Chrome, Edge, or Safari"
        aria-label="Dictation not supported in this browser"
        className={`inline-flex items-center justify-center w-8 h-8 rounded-lg border border-gray-200 bg-gray-50 text-gray-300 cursor-not-allowed ${className}`}
      >
        <MicOff className="w-4 h-4" aria-hidden="true" />
      </button>
    );
  }

  const isRecording = recState === 'listening';
  const isProcessing = recState === 'processing';

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      aria-label={isRecording ? `Stop ${label}` : `Start ${label}`}
      aria-pressed={isRecording}
      title={isRecording ? 'Click to stop recording' : `Click to ${label.toLowerCase()} (Chrome/Edge/Safari)`}
      className={`
        inline-flex items-center justify-center w-8 h-8 rounded-lg border transition-all focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-indigo-500
        ${isRecording
          ? 'border-red-300 bg-red-50 text-red-600 hover:bg-red-100 animate-pulse shadow-sm shadow-red-100'
          : isProcessing
          ? 'border-indigo-200 bg-indigo-50 text-indigo-400 cursor-wait'
          : 'border-gray-200 bg-white text-gray-400 hover:bg-gray-50 hover:text-gray-600 hover:border-gray-300'
        }
        disabled:opacity-40 disabled:cursor-not-allowed
        ${className}
      `}
    >
      {isProcessing ? (
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
      ) : isRecording ? (
        <Mic className="w-4 h-4" aria-hidden="true" />
      ) : (
        <Mic className="w-4 h-4" aria-hidden="true" />
      )}
      <span className="sr-only">
        {isRecording ? 'Recording — click to stop' : `Start ${label}`}
      </span>
    </button>
  );
}
