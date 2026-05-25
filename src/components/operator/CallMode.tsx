'use client';

/**
 * CallMode: full-screen half-duplex voice call UI.
 *
 * Track B8 (SCOPE-ADDITION Section 6).
 *
 * Flow (half-duplex):
 *   1. Open mic, start SpeechRecognition + VAD.
 *   2. Operator speaks. Web Speech API transcribes locally.
 *   3. VAD fires onSilence after 1.5s silence post-speech.
 *   4. We send the transcript to the active agent via /api/operator/bridge/send
 *      (or the parent-provided sender) and stream the response text in.
 *   5. Once the response is complete, TTS plays the audio.
 *   6. Mic auto-reopens for the next turn.
 *   7. Loop until End call.
 *
 * Bridge integration: the actual "send to agent" step lives in Track B2.
 * Until the orchestrator wires CallMode into BridgeChat, the component
 * accepts an `onUserUtterance` prop. The default implementation POSTs to
 * `/api/operator/bridge/call-turn` with `{ message, agent }` and reads a
 * JSON `{ reply }` response. If that endpoint does not exist yet, the call
 * still functions: the operator hears a friendly fallback line and the loop
 * continues. This keeps Track B8 fully self-contained per the parallel-build
 * contract.
 *
 * NO em dashes anywhere in user-facing copy (per build rules).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff, AlertCircle, Volume2 } from 'lucide-react';
import { startVad, type VadHandle } from '@/lib/voice/vad';
import {
  listTtsProviders,
  speak,
  type TtsProviderId,
  type TtsProviderInfo,
} from '@/lib/voice/tts-streaming';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

interface TranscriptEntry {
  id: string;
  role: 'operator' | 'agent';
  text: string;
  at: number;
}

export interface CallModeProps {
  /** Target agent id (e.g. claude-code, codex, openclaw). Optional; UI shows a notice if absent. */
  agentId?: string;
  /** Friendly agent label for the header. */
  agentLabel?: string;
  /** Called when the operator hits End call or hits Escape. */
  onClose: () => void;
  /**
   * Custom agent send function. Receives the latest operator utterance plus
   * the running transcript and returns the assistant reply text. If omitted,
   * CallMode posts to /api/operator/bridge/call-turn.
   */
  onUserUtterance?: (utterance: string, history: TranscriptEntry[]) => Promise<string>;
}

const VOICES_BY_PROVIDER: Record<TtsProviderId, string[]> = {
  openai: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
  elevenlabs: [],
  fish_audio: [],
  xai: [],
  browser: [],
};

const STORAGE_KEY = 'bcc.call.tts.provider';
const STORAGE_VOICE_KEY = 'bcc.call.tts.voice';

export default function CallMode({ agentId, agentLabel, onClose, onUserUtterance }: CallModeProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [partial, setPartial] = useState<string>('');
  const [level, setLevel] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<TtsProviderInfo[]>([]);
  const [provider, setProvider] = useState<TtsProviderId | null>(null);
  const [voice, setVoice] = useState<string>('');
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const vadRef = useRef<VadHandle | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const endedRef = useRef(false);
  const latestPartialRef = useRef<string>('');
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const phaseRef = useRef<Phase>('idle');

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Load provider list and restore operator preference.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await listTtsProviders();
      if (cancelled) return;
      const available = list.filter((p) => p.available);
      setProviders(list);
      const stored = (typeof window !== 'undefined' && window.localStorage.getItem(STORAGE_KEY)) as
        | TtsProviderId
        | null;
      const storedVoice = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_VOICE_KEY) : null;
      const initial =
        stored && available.some((p) => p.id === stored)
          ? stored
          : available[0]?.id ?? 'browser';
      setProvider(initial);
      if (storedVoice) setVoice(storedVoice);
      else if (initial === 'openai') setVoice('alloy');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistProvider = useCallback((id: TtsProviderId) => {
    setProvider(id);
    setFallbackNotice(null);
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, id);
    if (id === 'openai' && !voice) setVoice('alloy');
  }, [voice]);

  const persistVoice = useCallback((v: string) => {
    setVoice(v);
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_VOICE_KEY, v);
  }, []);

  const stopVadAndRecognition = useCallback(() => {
    if (vadRef.current) {
      vadRef.current.stop();
      vadRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onend = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onresult = null;
        recognitionRef.current.stop();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    }
  }, []);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const endCall = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    stopVadAndRecognition();
    stopStream();
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort();
      ttsAbortRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
    onClose();
  }, [onClose, stopStream, stopVadAndRecognition]);

  // Escape closes the call.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') endCall();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [endCall]);

  const sendUtterance = useCallback(
    async (utterance: string): Promise<string> => {
      if (onUserUtterance) return onUserUtterance(utterance, transcriptRef.current);
      try {
        const res = await fetch('/api/operator/bridge/call-turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId, message: utterance, history: transcriptRef.current }),
        });
        if (!res.ok) throw new Error(`bridge call-turn ${res.status}`);
        const data = (await res.json()) as { reply?: string };
        return data.reply || 'I heard you, but I do not have a reply ready yet.';
      } catch {
        return 'The Bridge agent endpoint is not wired in yet. End the call or keep going.';
      }
    },
    [agentId, onUserUtterance],
  );

  const speakReply = useCallback(
    async (text: string) => {
      ttsAbortRef.current?.abort();
      const controller = new AbortController();
      ttsAbortRef.current = controller;
      try {
        const result = await speak(text, {
          provider: provider ?? undefined,
          voice: voice || undefined,
          signal: controller.signal,
        });
        if (provider && result.provider !== provider) {
          setFallbackNotice(`Fell back to ${result.provider}`);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setFallbackNotice('TTS playback failed. Continuing in silent mode.');
        }
      } finally {
        if (ttsAbortRef.current === controller) ttsAbortRef.current = null;
      }
    },
    [provider, voice],
  );

  const startListening = useCallback(async () => {
    if (endedRef.current) return;
    setError(null);
    setPartial('');
    latestPartialRef.current = '';
    setPhase('listening');

    // Acquire mic once per turn so the VAD sees the freshest stream.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setError(`Microphone permission denied: ${(err as Error).message}`);
      setPhase('error');
      return;
    }
    streamRef.current = stream;

    // SpeechRecognition. Webkit-prefixed in most browsers.
    const Ctor: typeof SpeechRecognition | undefined =
      (window as unknown as { SpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;
    if (!Ctor) {
      setError('Web Speech API is not supported in this browser. Try Chrome or Edge.');
      setPhase('error');
      stopStream();
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const txt = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += txt;
        else interim += txt;
      }
      const combined = (finalText + ' ' + interim).trim();
      latestPartialRef.current = combined || latestPartialRef.current;
      setPartial(combined);
    };
    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "no-speech" and "aborted" are normal during VAD silence cuts.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      setError(`Speech recognition error: ${event.error}`);
    };
    try {
      rec.start();
    } catch {
      // Already started by an earlier turn that did not clean up.
    }
    recognitionRef.current = rec;

    const handle = startVad(stream, {
      silenceMs: 1500,
      onLevel: (lv) => setLevel(lv),
      onSilence: () => {
        if (phaseRef.current !== 'listening') return;
        const utterance = latestPartialRef.current.trim();
        // Stop mic and VAD before invoking the agent.
        stopVadAndRecognition();
        stopStream();
        if (!utterance) {
          // Nothing was actually said. Restart listening.
          if (!endedRef.current) void startListening();
          return;
        }
        const userEntry: TranscriptEntry = {
          id: `op-${Date.now()}`,
          role: 'operator',
          text: utterance,
          at: Date.now(),
        };
        setTranscript((prev) => [...prev, userEntry]);
        setPartial('');
        latestPartialRef.current = '';
        setPhase('thinking');
        void (async () => {
          const reply = await sendUtterance(utterance);
          if (endedRef.current) return;
          const agentEntry: TranscriptEntry = {
            id: `ag-${Date.now()}`,
            role: 'agent',
            text: reply,
            at: Date.now(),
          };
          setTranscript((prev) => [...prev, agentEntry]);
          setPhase('speaking');
          await speakReply(reply);
          if (endedRef.current) return;
          void startListening();
        })();
      },
    });
    vadRef.current = handle;
  }, [sendUtterance, speakReply, stopStream, stopVadAndRecognition]);

  // Kick off the first turn once a provider is settled.
  useEffect(() => {
    if (phase === 'idle' && provider !== null) {
      void startListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stopVadAndRecognition();
      stopStream();
      if (ttsAbortRef.current) ttsAbortRef.current.abort();
    };
  }, [stopStream, stopVadAndRecognition]);

  const phaseLabel = useMemo(() => {
    switch (phase) {
      case 'listening':
        return 'Listening';
      case 'thinking':
        return 'Thinking';
      case 'speaking':
        return 'Speaking';
      case 'error':
        return 'Error';
      default:
        return 'Preparing';
    }
  }, [phase]);

  const availableProviders = providers.filter((p) => p.available);
  const voicesForProvider = provider ? VOICES_BY_PROVIDER[provider] ?? [] : [];

  return (
    <div className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-sm flex flex-col text-white">
      <div className="flex items-center justify-between px-8 py-5 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="grid place-items-center w-10 h-10 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">
            <Phone size={18} />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-white/60 font-semibold">
              Call Mode
            </div>
            <div className="text-[15px] font-semibold">
              {agentLabel || agentId || 'No agent selected'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {availableProviders.length > 1 && (
            <div className="flex items-center gap-2">
              <Volume2 size={14} className="text-white/60" />
              <select
                value={provider ?? ''}
                onChange={(e) => persistProvider(e.target.value as TtsProviderId)}
                className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[13px] text-white focus:outline-none focus:border-white/30"
              >
                {availableProviders.map((p) => (
                  <option key={p.id} value={p.id} className="text-black">
                    {p.label}
                  </option>
                ))}
              </select>
              {voicesForProvider.length > 0 && (
                <select
                  value={voice}
                  onChange={(e) => persistVoice(e.target.value)}
                  className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[13px] text-white focus:outline-none focus:border-white/30"
                >
                  {voicesForProvider.map((v) => (
                    <option key={v} value={v} className="text-black">
                      {v}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={endCall}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-red-500 hover:bg-red-600 text-white text-[13px] font-semibold transition-colors"
          >
            <PhoneOff size={16} />
            End call
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-8 gap-10 overflow-hidden">
        <VoiceWaveform phase={phase} level={level} />

        <div className="text-center">
          <div className="text-[12px] uppercase tracking-[0.2em] text-white/50 font-semibold">
            {phaseLabel}
          </div>
          {partial && phase === 'listening' && (
            <div className="mt-3 text-[18px] text-white/90 max-w-xl">{partial}</div>
          )}
          {!partial && phase === 'listening' && (
            <div className="mt-3 text-[15px] text-white/40">Go ahead, I am listening.</div>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 px-4 py-2 rounded-md bg-red-500/15 border border-red-400/30 text-red-100 text-[13px]">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {fallbackNotice && (
          <div className="text-[12px] text-amber-200/80">{fallbackNotice}</div>
        )}
      </div>

      <div className="border-t border-white/10 bg-black/40 max-h-[40vh] overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-6 space-y-4">
          {transcript.length === 0 ? (
            <div className="text-center text-[13px] text-white/40">
              The live transcript appears here as the call goes on.
            </div>
          ) : (
            transcript.map((entry) => (
              <div
                key={entry.id}
                className={`flex ${entry.role === 'operator' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-[14px] leading-relaxed ${
                    entry.role === 'operator'
                      ? 'bg-emerald-500/20 border border-emerald-400/30 text-emerald-50'
                      : 'bg-white/10 border border-white/15 text-white/90'
                  }`}
                >
                  <div className="text-[10px] uppercase tracking-[0.18em] mb-1 opacity-60">
                    {entry.role === 'operator' ? 'You' : agentLabel || 'Agent'}
                  </div>
                  {entry.text}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

interface WaveformProps {
  phase: Phase;
  level: number;
}

function VoiceWaveform({ phase, level }: WaveformProps) {
  // 24 bars. Listening drives bars from live mic level. Speaking and thinking
  // animate via CSS only so the bars keep moving when level is 0.
  const bars = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const active = phase === 'listening' || phase === 'speaking' || phase === 'thinking';
  return (
    <div
      className="flex items-end justify-center gap-1.5 h-32"
      aria-hidden="true"
    >
      {bars.map((i) => {
        const baseDelay = (i % 12) * 0.08;
        let height: string;
        if (phase === 'listening') {
          const wobble = 0.35 + 0.65 * Math.sin((Date.now() / 200) + i);
          const lvl = Math.min(1, Math.max(0.05, level * 8 * wobble));
          height = `${6 + lvl * 100}px`;
        } else if (phase === 'speaking') {
          height = `${10 + 60 * Math.abs(Math.sin(Date.now() / 220 + i * 0.6))}px`;
        } else if (phase === 'thinking') {
          height = `${6 + 30 * Math.abs(Math.sin(Date.now() / 320 + i * 0.4))}px`;
        } else {
          height = '6px';
        }
        return (
          <span
            key={i}
            style={{
              height,
              transition: 'height 80ms ease-out',
              animationDelay: `${baseDelay}s`,
              opacity: active ? 1 : 0.4,
            }}
            className={`w-1.5 rounded-full ${
              phase === 'speaking'
                ? 'bg-emerald-300'
                : phase === 'listening'
                  ? 'bg-cyan-300'
                  : phase === 'thinking'
                    ? 'bg-amber-300'
                    : 'bg-white/40'
            }`}
          />
        );
      })}
    </div>
  );
}

// --- Web Speech API ambient typings ----------------------------------------
//
// Next.js's lib.dom does not include SpeechRecognition by default. Declaring
// the minimal surface area we actually call here keeps the file type-safe
// without pulling in a community @types package.

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  start(): void;
  stop(): void;
}
declare const SpeechRecognition: { prototype: SpeechRecognition; new (): SpeechRecognition };
