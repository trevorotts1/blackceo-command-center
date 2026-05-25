/**
 * /api/operator/tts
 *
 * Track B8 (SCOPE-ADDITION Section 6.4, 6.5) + v4.0.1 P0-4 / P0-5.
 *
 * GET  → reports which TTS providers are configured on this deployment.
 * POST → proxies a synthesis request to the chosen provider and streams the
 *        audio bytes back to the browser. The client never sees the API key.
 *
 * Provider selection order when no explicit `?provider=` is supplied:
 *   1. DEFAULT_CALL_TTS_PROVIDER env var (if set)
 *   2. openai     (OPENAI_API_KEY)
 *   3. fish_audio (FISH_AUDIO_API_KEY)
 *   4. xai        (X_AI_API_KEY)
 *   5. elevenlabs (ELEVENLABS_API_KEY)
 *
 * On provider error the route falls back to the next configured provider in
 * the priority list and surfaces `x-tts-provider` so the client can display
 * a "fell back to X" toast.
 *
 * xAI voice availability is plan-gated. On 403/404 we mark the provider as
 * unavailable for the remainder of the process lifetime so subsequent
 * requests skip it without an extra round-trip.
 */

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ProviderId = 'openai' | 'elevenlabs' | 'fish_audio' | 'xai' | 'browser';

const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI TTS',
  elevenlabs: 'ElevenLabs',
  fish_audio: 'Fish Audio',
  xai: 'xAI Voice',
  browser: 'Browser (built-in)',
};

// Session-level disable flags. Set when a provider returns a hard "plan does
// not include this feature" response (e.g. xAI voice 403/404). Persists for
// the lifetime of the Node process; the next deploy or restart clears it.
const sessionDisabled: Partial<Record<ProviderId, boolean>> = {};

function isProviderConfigured(id: ProviderId): boolean {
  if (sessionDisabled[id]) return false;
  switch (id) {
    case 'openai':
      return Boolean(process.env.OPENAI_API_KEY);
    case 'elevenlabs':
      return Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
    case 'fish_audio':
      return Boolean(process.env.FISH_AUDIO_API_KEY);
    case 'xai':
      return Boolean(process.env.X_AI_API_KEY);
    case 'browser':
      return true;
  }
}

function priorityOrder(): ProviderId[] {
  const def = (process.env.DEFAULT_CALL_TTS_PROVIDER || '').toLowerCase() as ProviderId;
  const baseline: ProviderId[] = ['openai', 'fish_audio', 'xai', 'elevenlabs', 'browser'];
  if (def && baseline.includes(def)) {
    return [def, ...baseline.filter((p) => p !== def)];
  }
  return baseline;
}

export async function GET() {
  const all: ProviderId[] = ['openai', 'elevenlabs', 'fish_audio', 'xai', 'browser'];
  const providers = all.map((id) => ({
    id,
    label: PROVIDER_LABELS[id],
    available: isProviderConfigured(id),
  }));
  return NextResponse.json({ providers, default: priorityOrder()[0] });
}

interface SynthBody {
  text?: unknown;
}

export async function POST(req: NextRequest) {
  let body: SynthBody;
  try {
    body = (await req.json()) as SynthBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }
  if (text.length > 4000) {
    return NextResponse.json({ error: 'text exceeds 4000 character limit' }, { status: 400 });
  }

  const url = new URL(req.url);
  const requested = (url.searchParams.get('provider') || '').toLowerCase() as ProviderId | '';
  const voiceOverride = url.searchParams.get('voice') || undefined;

  const candidates: ProviderId[] = [];
  if (requested && isProviderConfigured(requested as ProviderId)) {
    candidates.push(requested as ProviderId);
  }
  for (const id of priorityOrder()) {
    if (id === 'browser') continue;
    if (!candidates.includes(id) && isProviderConfigured(id)) candidates.push(id);
  }

  if (candidates.length === 0) {
    return NextResponse.json(
      { error: 'No server-side TTS provider configured. Use the browser fallback.' },
      { status: 503 },
    );
  }

  let lastError: string | null = null;
  for (const providerId of candidates) {
    try {
      const synth = await synthesize(providerId, text, voiceOverride);
      return new NextResponse(synth.body, {
        status: 200,
        headers: {
          'content-type': synth.contentType,
          'x-tts-provider': providerId,
          'cache-control': 'no-store',
        },
      });
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return NextResponse.json(
    { error: `All configured TTS providers failed. Last error: ${lastError}` },
    { status: 502 },
  );
}

interface SynthResult {
  body: ArrayBuffer;
  contentType: string;
}

async function synthesize(provider: ProviderId, text: string, voice: string | undefined): Promise<SynthResult> {
  switch (provider) {
    case 'openai':
      return synthesizeOpenAi(text, voice);
    case 'elevenlabs':
      return synthesizeElevenLabs(text, voice);
    case 'fish_audio':
      return synthesizeFishAudio(text, voice);
    case 'xai':
      return synthesizeXai(text, voice);
    case 'browser':
      throw new Error('Browser TTS is rendered client-side and cannot be synthesized on the server');
    default: {
      const exhaustive: never = provider;
      throw new Error(`Provider ${exhaustive as string} is not implemented in this build`);
    }
  }
}

async function synthesizeOpenAi(text: string, voice: string | undefined): Promise<SynthResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
  const v = voice || process.env.OPENAI_TTS_VOICE || 'alloy';
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice: v,
      input: text,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(`OpenAI TTS ${res.status}: ${detail}`);
  }
  const buf = await res.arrayBuffer();
  return { body: buf, contentType: res.headers.get('content-type') || 'audio/mpeg' };
}

async function synthesizeElevenLabs(text: string, voice: string | undefined): Promise<SynthResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  const voiceId = voice || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID is not set');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      output_format: 'mp3_44100_128',
    }),
  });
  if (!res.ok) {
    const detail = await safeReadText(res);
    throw new Error(`ElevenLabs TTS ${res.status}: ${detail}`);
  }
  const buf = await res.arrayBuffer();
  return { body: buf, contentType: res.headers.get('content-type') || 'audio/mpeg' };
}

async function synthesizeFishAudio(text: string, voice: string | undefined): Promise<SynthResult> {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) throw new Error('FISH_AUDIO_API_KEY is not set');
  const referenceId = voice || process.env.FISH_AUDIO_VOICE_ID;
  if (!referenceId) throw new Error('FISH_AUDIO_VOICE_ID is not set');
  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text,
      reference_id: referenceId,
      format: 'mp3',
      mp3_bitrate: 128,
      chunk_length: 200,
      normalize: true,
      latency: 'normal',
    }),
  });
  if (!res.ok) {
    const detail = await safeReadText(res);
    // 401/403/429/5xx all fall through to the next provider in priority order.
    // Surface the status code so the caller's catch block can log it.
    throw new Error(`Fish Audio TTS ${res.status}: ${detail}`);
  }
  const buf = await res.arrayBuffer();
  return { body: buf, contentType: res.headers.get('content-type') || 'audio/mpeg' };
}

async function synthesizeXai(text: string, voice: string | undefined): Promise<SynthResult> {
  const apiKey = process.env.X_AI_API_KEY;
  if (!apiKey) throw new Error('X_AI_API_KEY is not set');
  const model = process.env.X_AI_VOICE_MODEL || 'grok-2-voice-1212';
  const v = voice || process.env.X_AI_VOICE;
  if (!v) throw new Error('X_AI_VOICE is not set');
  const res = await fetch('https://api.x.ai/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: text,
      voice: v,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) {
    const detail = await safeReadText(res);
    if (res.status === 403 || res.status === 404) {
      // Plan does not include voice. Disable for the rest of the session so
      // subsequent requests skip xAI without an extra round-trip.
      sessionDisabled.xai = true;
    }
    throw new Error(`xAI TTS ${res.status}: ${detail}`);
  }
  const buf = await res.arrayBuffer();
  return { body: buf, contentType: res.headers.get('content-type') || 'audio/mpeg' };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return res.statusText;
  }
}
