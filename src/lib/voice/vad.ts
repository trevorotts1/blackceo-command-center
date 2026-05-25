/**
 * Voice Activity Detection wrapper.
 *
 * Track B8 (SCOPE-ADDITION Section 6.2).
 *
 * Browser-side VAD using a `MediaStreamAudioSourceNode` plus `AnalyserNode`.
 * Polls RMS energy on a `requestAnimationFrame` loop and fires `onSilence`
 * after the configured silence window (default 1.5s) following any detected
 * speech. Speech detection is signalled separately through `onSpeech` so
 * callers can drive a "listening" indicator.
 *
 * Half-duplex flow:
 *   1. Caller starts VAD when the mic opens.
 *   2. First speech frame fires `onSpeech` once per utterance.
 *   3. After `silenceMs` of continuous silence with at least one prior
 *      speech frame, `onSilence` fires once and VAD auto-stops.
 *   4. Caller restarts VAD when the mic re-opens for the next utterance.
 *
 * No external dependencies. Pure Web Audio API.
 */

export interface VadOptions {
  /** Milliseconds of continuous silence after speech before firing onSilence. Default 1500. */
  silenceMs?: number;
  /** RMS threshold (0-1). Above this counts as speech. Default 0.015. */
  threshold?: number;
  /** Called once on the first speech frame of an utterance. */
  onSpeech?: () => void;
  /** Called once after `silenceMs` of silence following speech. */
  onSilence?: () => void;
  /** Optional callback for live volume display, value 0-1. */
  onLevel?: (level: number) => void;
}

export interface VadHandle {
  /** Tear down audio nodes, RAF loop, and timers. Idempotent. */
  stop: () => void;
  /** True between start and stop. */
  isActive: () => boolean;
}

/**
 * Start a VAD session on an already-acquired MediaStream.
 *
 * The caller owns the MediaStream lifecycle. `stop()` does NOT stop the
 * underlying tracks; the caller's `getUserMedia` consumer should do that.
 */
export function startVad(stream: MediaStream, options: VadOptions = {}): VadHandle {
  const silenceMs = options.silenceMs ?? 1500;
  const threshold = options.threshold ?? 0.015;
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.5;
  source.connect(analyser);

  const buf = new Float32Array(analyser.fftSize);
  let active = true;
  let rafId: number | null = null;
  let hadSpeech = false;
  let speechAnnounced = false;
  let silenceStartedAt: number | null = null;
  let silenceFired = false;

  function tick() {
    if (!active) return;
    analyser.getFloatTimeDomainData(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      sumSq += buf[i] * buf[i];
    }
    const rms = Math.sqrt(sumSq / buf.length);
    if (options.onLevel) options.onLevel(rms);

    const now = performance.now();
    if (rms >= threshold) {
      hadSpeech = true;
      silenceStartedAt = null;
      if (!speechAnnounced) {
        speechAnnounced = true;
        if (options.onSpeech) options.onSpeech();
      }
    } else if (hadSpeech) {
      if (silenceStartedAt === null) silenceStartedAt = now;
      if (!silenceFired && now - silenceStartedAt >= silenceMs) {
        silenceFired = true;
        active = false;
        cleanup();
        if (options.onSilence) options.onSilence();
        return;
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function cleanup() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    void ctx.close().catch(() => {
      /* ignore */
    });
  }

  rafId = requestAnimationFrame(tick);

  return {
    stop() {
      if (!active && rafId === null) return;
      active = false;
      cleanup();
    },
    isActive() {
      return active;
    },
  };
}
