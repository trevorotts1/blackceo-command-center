/**
 * TTS provider abstraction with streaming.
 *
 * Track B8 (SCOPE-ADDITION Section 6.3, 6.4) + v4.0.1 P0-4 / P0-5.
 *
 * Server-side providers (OpenAI, Fish Audio, xAI, ElevenLabs) are proxied
 * through `/api/operator/tts` so the browser never sees the API key. The
 * browser fallback (`browser`) uses `window.speechSynthesis` directly.
 *
 * Provider priority order when no explicit selection is made:
 *   1. openai     (OPENAI_API_KEY)
 *   2. fish_audio (FISH_AUDIO_API_KEY + FISH_AUDIO_VOICE_ID)
 *   3. xai        (X_AI_API_KEY + X_AI_VOICE)
 *   4. elevenlabs (ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID)
 *   5. browser    (always)
 *
 * Half-duplex use: caller awaits `speak()` before re-opening the mic.
 */

export type TtsProviderId = 'openai' | 'elevenlabs' | 'fish_audio' | 'xai' | 'browser';

export interface TtsProviderInfo {
  id: TtsProviderId;
  label: string;
  /** True if this provider's API key is configured on the server. */
  available: boolean;
  /** The server's configured first choice, even when temporarily unavailable. */
  isDefault?: boolean;
}

/** Keep a chosen client voice selected while blocked; changing voices is explicit. */
export function selectTtsProvider(providers: TtsProviderInfo[], stored: TtsProviderId | null): TtsProviderId {
  if (stored === 'fish_audio') return stored;
  if (!providers.length) throw new Error('Voice provider configuration could not be verified');
  if (stored && providers.some(p => p.id === stored && p.available)) return stored;
  const preferred = providers.find(p => p.isDefault);
  if (preferred && (preferred.id === 'fish_audio' || preferred.available)) return preferred.id;
  const available = providers.find(p => p.available);
  if (!available) throw new Error('No verified voice provider is available');
  return available.id;
}

export interface SpeakOptions {
  /** Provider id. If omitted, server picks based on env priority. */
  provider?: TtsProviderId;
  /** Voice name override for the chosen provider. */
  voice?: string;
  /** Aborts the speech if the operator hits End call. */
  signal?: AbortSignal;
}

export interface SpeakResult {
  /** Provider that actually rendered the audio (may differ on fallback). */
  provider: TtsProviderId;
}

/** GET /api/operator/tts returns the list of providers with `available: true|false`. */
export async function listTtsProviders(): Promise<TtsProviderInfo[]> {
  const res = await fetch('/api/operator/tts', { method: 'GET' });
  if (!res.ok) {
    throw new Error('Voice provider configuration could not be verified');
  }
  const data = (await res.json()) as { providers?: TtsProviderInfo[]; default?: TtsProviderId };
  const known = new Set(['openai', 'elevenlabs', 'fish_audio', 'xai', 'browser']);
  if (!data || !Array.isArray(data.providers) || !data.providers.length ||
      !data.providers.every(p => p && known.has(p.id) && typeof p.available === 'boolean' && typeof p.label === 'string') ||
      new Set(data.providers.map(p => p.id)).size !== data.providers.length ||
      !data.providers.some(p => p.id === data.default)) {
    throw new Error('Voice provider configuration could not be verified');
  }
  return data.providers.map(provider => ({ ...provider, isDefault: provider.id === data.default }));
}

/**
 * Speak the given text. Returns once playback has ended.
 *
 * Server-side providers stream audio bytes back as a single response stream
 * which we feed into an HTMLAudioElement via Blob URL. Streaming the raw
 * stream chunk-by-chunk into MediaSource works in Chrome but breaks on
 * Safari's MSE quirks, so we collect the chunks into a Blob and play that.
 * The TTFB win is small enough that this trade-off is worth it for now.
 */
export async function speak(text: string, options: SpeakOptions = {}): Promise<SpeakResult> {
  const trimmed = text.trim();
  if (!trimmed) return { provider: options.provider ?? 'browser' };

  const provider = options.provider;

  if (provider === 'browser') {
    return speakWithBrowser(trimmed, options);
  }

  const params = new URLSearchParams();
  if (provider) params.set('provider', provider);
  if (options.voice) params.set('voice', options.voice);
  const url = `/api/operator/tts${params.toString() ? `?${params.toString()}` : ''}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: trimmed }),
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    if (!provider || provider === 'fish_audio') {
      throw new Error('The selected client voice is unavailable. Review Fish Audio configuration before retrying.');
    }
    // Network or provider unreachable. Fall back to browser TTS.
    return speakWithBrowser(trimmed, options);
  }

  if (!res.ok || !res.body) {
    if (!provider || provider === 'fish_audio' || res.headers.get('x-tts-fallback') === 'blocked') {
      throw new Error('The selected client voice is unavailable. Review Fish Audio configuration before retrying.');
    }
    // Server-side failure. Fall back to browser TTS so the call keeps moving.
    return speakWithBrowser(trimmed, options);
  }

  const usedProvider = (res.headers.get('x-tts-provider') as TtsProviderId | null) ?? provider ?? 'openai';
  const contentType = res.headers.get('content-type') || 'audio/mpeg';
  const blob = await res.blob();
  const audioBlob = new Blob([blob], { type: contentType });
  const objectUrl = URL.createObjectURL(audioBlob);

  try {
    await playAudioBlobUrl(objectUrl, options.signal);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  return { provider: usedProvider };
}

function playAudioBlobUrl(url: string, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const audio = new Audio(url);
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Audio playback failed'));
    };
    const onAbort = () => {
      try {
        audio.pause();
      } catch {
        /* ignore */
      }
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    function cleanup() {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    if (signal) signal.addEventListener('abort', onAbort);
    void audio.play().catch(onError);
  });
}

function speakWithBrowser(text: string, options: SpeakOptions): Promise<SpeakResult> {
  return new Promise<SpeakResult>((resolve, reject) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      reject(new Error('Browser speech synthesis is not available'));
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    if (options.voice) {
      const match = window.speechSynthesis.getVoices().find((v) => v.name === options.voice);
      if (match) utter.voice = match;
    }
    const onEnd = () => {
      cleanup();
      resolve({ provider: 'browser' });
    };
    const onError = () => {
      cleanup();
      reject(new Error('Browser TTS error'));
    };
    const onAbort = () => {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    function cleanup() {
      utter.removeEventListener('end', onEnd);
      utter.removeEventListener('error', onError);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
    utter.addEventListener('end', onEnd);
    utter.addEventListener('error', onError);
    if (options.signal) options.signal.addEventListener('abort', onAbort);
    window.speechSynthesis.speak(utter);
  });
}
